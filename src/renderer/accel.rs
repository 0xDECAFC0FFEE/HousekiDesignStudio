//! Ray-tracing acceleration structure and its GPU representation.
//!
//! The BVH itself is built by the `bvh` crate with a surface-area heuristic, then
//! flattened with `Bvh::flatten()`. That flattening is the reason this crate was
//! chosen: it emits *skip-pointer* nodes (`entry_index` / `exit_index`) rather
//! than a child-pointer tree, which a fragment shader can walk iteratively with
//! no stack array and no recursion. GLSL ES 3.00 has neither, so a stack-based
//! traversal would need a fixed-size local array and a depth cap.
//!
//! This module also contains a CPU tracer that mirrors the GLSL traversal and
//! intersection math line for line. It exists so the algorithm the shader runs
//! can be unit tested against brute force on the host, where a wrong answer is a
//! failing assertion instead of a subtly wrong pixel.

use crate::mesh::Mesh;
use bvh::aabb::{Aabb, Bounded};
use bvh::bounding_hierarchy::BHShape;
use bvh::bvh::Bvh;
use bvh::flat_bvh::FlatNode;
use nalgebra::{Point3, Vector3};

/// Floats per texel in the RGBA32F data textures.
const FLOATS_PER_TEXEL: usize = 4;

/// Texels per triangle: one per vertex.
const TEXELS_PER_TRIANGLE: usize = 3;

/// Texels per BVH node: bounds minimum plus link, bounds maximum plus link.
const TEXELS_PER_NODE: usize = 2;

/// Width of the data textures.
///
/// **Must be a power of two, and must match `DATA_TEXTURE_WIDTH_MASK` and
/// `DATA_TEXTURE_WIDTH_SHIFT` in `gem.frag`** (1023 and 10 for a width of 1024). The
/// shader unwraps a linear index into texture coordinates a few thousand times per
/// pixel, and a power of two lets it use a mask and a shift instead of an integer
/// modulo and division, which GPUs have no native instruction for.
///
/// 1024 columns also allows far more triangles than any single stone needs.
pub const DATA_TEXTURE_WIDTH: usize = 1024;

/// One mesh triangle, wrapped so the `bvh` crate can build a hierarchy over it.
#[derive(Debug, Clone, PartialEq)]
pub struct TriangleShape {
    pub a: Point3<f32>,
    pub b: Point3<f32>,
    pub c: Point3<f32>,
    /// Facet this triangle belongs to. Coplanar triangles of one facet share a
    /// value, which lets the shader shade or debug-colour per facet.
    pub facet: u32,
    /// Which edges and corners lie on the facet's outline, for the wireframe overlay. See
    /// `Mesh::facet_boundary_masks` for the bit layout; zero draws nothing.
    pub facet_edges: u8,
    /// Scratch field required by the `bvh` crate's `BHShape` contract.
    node_index: usize,
}

impl TriangleShape {
    pub fn new(a: Point3<f32>, b: Point3<f32>, c: Point3<f32>, facet: u32) -> Self {
        TriangleShape {
            a,
            b,
            c,
            facet,
            facet_edges: 0,
            node_index: 0,
        }
    }

    /// Outward geometric normal, given outward winding.
    pub fn normal(&self) -> Vector3<f32> {
        (self.b - self.a).cross(&(self.c - self.a)).normalize()
    }
}

impl Bounded<f32, 3> for TriangleShape {
    fn aabb(&self) -> Aabb<f32, 3> {
        let mut bounds = Aabb::empty();

        bounds.grow_mut(&self.a);
        bounds.grow_mut(&self.b);
        bounds.grow_mut(&self.c);

        bounds
    }
}

impl BHShape<f32, 3> for TriangleShape {
    fn set_bh_node_index(&mut self, index: usize) {
        self.node_index = index;
    }

    fn bh_node_index(&self) -> usize {
        self.node_index
    }
}

/// A built hierarchy together with the triangles in the order the flattened nodes
/// refer to them.
pub struct Accel {
    /// Triangles in BVH shape order. `FlatNode::shape_index` indexes this list.
    pub shapes: Vec<TriangleShape>,
    pub nodes: Vec<FlatNode<f32, 3>>,
    /// Padding applied to every leaf bound, in world units.
    pub bounds_padding: f32,
}

/// A ray hit against the acceleration structure.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hit {
    pub distance: f32,
    pub triangle: usize,
    /// Outward geometric normal of the hit triangle, independent of which side
    /// the ray arrived from.
    pub outward_normal: Vector3<f32>,
}

impl Accel {
    /// Builds the hierarchy for a conditioned mesh.
    pub fn build(mesh: &Mesh) -> Result<Accel, String> {
        if mesh.triangles.is_empty() {
            return Err("cannot build an acceleration structure with no triangles".to_string());
        }

        // Computed before the BVH build permutes the shapes, while triangle `index` is still
        // the mesh's own triangle `index`; each mask then travels with its shape.
        let facet_edges = mesh.facet_boundary_masks();

        let mut shapes: Vec<TriangleShape> = (0..mesh.triangles.len())
            .map(|index| {
                let [a, b, c] = mesh.triangle_positions(index);
                let facet = mesh
                    .facet_of_triangle
                    .get(index)
                    .copied()
                    .unwrap_or(index as u32);

                let mut shape = TriangleShape::new(a, b, c, facet);
                shape.facet_edges = facet_edges[index];

                shape
            })
            .collect();

        // The padding on every node bound does two separate jobs, and must be big
        // enough for both.
        //
        // First, `diagonal * 1e-5`: a facet lying in an axis-aligned plane produces
        // a zero-thickness bounding box. A ray travelling parallel to such a slab
        // computes `0 * infinity` in the slab test, which is NaN, and a NaN
        // comparison silently reports a miss. Padding every bound by a hair removes
        // the degenerate case entirely, at the cost of a few extra triangle tests.
        // Test: `aabb_test_survives_zero_thickness_box_with_padding`.
        //
        // Second, and far larger, the padding **must cover how far outside a
        // triangle the triangle test itself still accepts a hit**, or the walk is no
        // longer a superset of brute force: an inner node can cull a subtree whose
        // triangle `intersect_triangle` would have taken, and the hit is lost.
        // That is exactly what T-0069 was. `intersect_triangle` accepts
        // `u >= -TRIANGLE_EDGE_TOLERANCE`, `v >= -TRIANGLE_EDGE_TOLERANCE` and
        // `u + v <= 1 + TRIANGLE_EDGE_TOLERANCE`, so with `t` for the tolerance the
        // accepted region reaches the barycentric corners `(-t, -t)`, `(1 + t, -t)`
        // and `(-t, 1 + 2t)`. In world coordinates those sit
        // `-t * (ab + ac)`, `t * (ab - ac)` and `t * (2 * ac - ab)` away from the
        // nearest vertex, so an accepted hit point can lie up to
        // `3 * t * (longest triangle edge)` outside the triangle, and hence outside
        // any node box built from it. Padding by that much makes the box test
        // provably no stricter than the triangle test.
        //
        // Deriving it from `TRIANGLE_EDGE_TOLERANCE` is the point: the two were
        // independent magic numbers, and the padding was 16x too small. Whoever
        // changes the tolerance now gets the matching padding for free. Enlarging
        // the padding is always safe: a node box only culls, and never decides which
        // triangle is accepted.
        //
        // Measured on the shipped stones (T-0069, over 10M random casts): the
        // worst hit point actually accepted lay 4.45e-4 world units outside its own
        // triangle's box on hex_cut_v2 and 3.79e-4 on oval_cut, against an old
        // padding of 2.82e-5 and 2.61e-5 and a new one of 1.84e-3 and 1.87e-3. The
        // bound is a worst case over the barycentric corners and the worst hit seen
        // used only a quarter of it; that slack is the margin that absorbs the float
        // error in `u` and `v`, which grows as the triangle test's determinant
        // shrinks. The whole thing costs 1.2% more nodes visited and 2.3% more
        // triangle tests per cast on hex_cut_v2 (1.4% and 2.7% on oval_cut).
        let diagonal = mesh.bounds().size().norm();
        let longest_edge = shapes
            .iter()
            .flat_map(|shape| [shape.b - shape.a, shape.c - shape.b, shape.a - shape.c])
            .map(|edge| edge.norm())
            .fold(0.0f32, f32::max);
        let bounds_padding = if diagonal > 0.0 {
            diagonal * 1e-5 + 3.0 * TRIANGLE_EDGE_TOLERANCE * longest_edge
        } else {
            1e-6
        };

        // `Bvh::build` may permute `shapes`, so everything downstream, including
        // the GPU triangle texture, must use the post-build order.
        let bvh = Bvh::build(&mut shapes);
        let nodes = bvh.flatten();

        if nodes.is_empty() {
            return Err("BVH flattening produced no nodes".to_string());
        }

        Ok(Accel {
            shapes,
            nodes,
            bounds_padding,
        })
    }

    /// Packs the hierarchy into flat `RGBA32F` texture data for the shader.
    pub fn to_gpu(&self) -> GpuAccel {
        let triangle_count = self.shapes.len();
        let node_count = self.nodes.len();

        let triangle_texel_count = triangle_count * TEXELS_PER_TRIANGLE;
        let node_texel_count = node_count * TEXELS_PER_NODE;

        let triangle_rows = rows_for(triangle_texel_count);
        let node_rows = rows_for(node_texel_count);

        let mut triangle_texels = vec![0.0f32; triangle_rows * DATA_TEXTURE_WIDTH * FLOATS_PER_TEXEL];
        let mut node_texels = vec![0.0f32; node_rows * DATA_TEXTURE_WIDTH * FLOATS_PER_TEXEL];

        for (index, shape) in self.shapes.iter().enumerate() {
            let base = index * TEXELS_PER_TRIANGLE * FLOATS_PER_TEXEL;

            // Texel 0 carries vertex A plus the facet id, texel 1 vertex B plus the
            // wireframe's facet-edge mask, and texel 2 vertex C. The last w stays zero. The
            // mask is at most 63, which a float holds exactly.
            write_vec3(&mut triangle_texels[base..], shape.a.coords);
            triangle_texels[base + 3] = shape.facet as f32;

            write_vec3(&mut triangle_texels[base + 4..], shape.b.coords);
            triangle_texels[base + 7] = f32::from(shape.facet_edges);

            write_vec3(&mut triangle_texels[base + 8..], shape.c.coords);
        }

        for (index, node) in self.nodes.iter().enumerate() {
            let base = index * TEXELS_PER_NODE * FLOATS_PER_TEXEL;

            // The `bvh` crate documents a leaf's `aabb` as *undefined*, so it is
            // deliberately not copied: it can hold the empty-box sentinel of
            // (+inf, -inf), and writing infinities into a float texture that the
            // shader might one day read is a trap worth not setting. The shader
            // checks the link sign first and tests the triangle directly for a
            // leaf, so these bounds are never consulted.
            if !node.is_leaf() {
                let padding = Vector3::repeat(self.bounds_padding);

                write_vec3(&mut node_texels[base..], node.aabb.min.coords - padding);
                write_vec3(&mut node_texels[base + 4..], node.aabb.max.coords + padding);
            }

            node_texels[base + 3] = encode_node_link(node);
            node_texels[base + 7] = node.exit_index as f32;
        }

        GpuAccel {
            triangle_texels,
            node_texels,
            triangle_count,
            node_count,
            texture_width: DATA_TEXTURE_WIDTH as u32,
            triangle_texture_height: triangle_rows as u32,
            node_texture_height: node_rows as u32,
        }
    }

    /// Nearest hit along a ray, walking the skip-pointer nodes exactly as the
    /// fragment shader's `traceScene` does.
    ///
    /// Only triangles the ray crosses the way `side` allows can be hit; see `RaySide`.
    ///
    /// Kept in lockstep with `gem.frag`: this is the reference implementation the
    /// shader mirrors, and the unit tests validate it against brute force.
    pub fn trace(
        &self,
        origin: Point3<f32>,
        direction: Vector3<f32>,
        t_min: f32,
        t_max: f32,
        side: RaySide,
    ) -> Option<Hit> {
        let inverse_direction = Vector3::new(
            1.0 / direction.x,
            1.0 / direction.y,
            1.0 / direction.z,
        );

        let mut best: Option<Hit> = None;
        let mut best_distance = t_max;

        let mut index = 0usize;

        // Iteration cap mirroring the one in `gem.frag`'s `traceScene`. Defensive
        // only: with packer-produced data every link points forward in depth-first
        // order, so `index` increases strictly and the walk terminates on its own.
        // Kept here so the mirror really is a mirror.
        let step_limit = self.nodes.len().saturating_mul(4);

        for _ in 0..step_limit {
            if index >= self.nodes.len() {
                break;
            }

            let node = &self.nodes[index];
            let padding = Vector3::repeat(self.bounds_padding);

            if node.is_leaf() {
                let shape = &self.shapes[node.shape_index as usize];

                if let Some(distance) = intersect_triangle(
                    origin,
                    direction,
                    shape.a,
                    shape.b,
                    shape.c,
                    t_min,
                    best_distance,
                    side,
                ) {
                    best_distance = distance;
                    best = Some(Hit {
                        distance,
                        triangle: node.shape_index as usize,
                        outward_normal: shape.normal(),
                    });
                }

                index = node.exit_index as usize;
            } else if intersect_aabb(
                origin,
                inverse_direction,
                Point3::from(node.aabb.min.coords - padding),
                Point3::from(node.aabb.max.coords + padding),
                t_min,
                best_distance,
            ) {
                index = node.entry_index as usize;
            } else {
                index = node.exit_index as usize;
            }
        }

        best
    }

    /// Nearest hit found by testing every triangle, with the same side rule. Only used as the
    /// test oracle.
    pub fn trace_brute_force(
        &self,
        origin: Point3<f32>,
        direction: Vector3<f32>,
        t_min: f32,
        t_max: f32,
        side: RaySide,
    ) -> Option<Hit> {
        let mut best: Option<Hit> = None;
        let mut best_distance = t_max;

        for (index, shape) in self.shapes.iter().enumerate() {
            if let Some(distance) = intersect_triangle(
                origin,
                direction,
                shape.a,
                shape.b,
                shape.c,
                t_min,
                best_distance,
                side,
            ) {
                best_distance = distance;
                best = Some(Hit {
                    distance,
                    triangle: index,
                    outward_normal: shape.normal(),
                });
            }
        }

        best
    }
}

/// Flat texture data ready for `texImage2D`.
pub struct GpuAccel {
    /// `RGBA32F` texels, three per triangle.
    pub triangle_texels: Vec<f32>,
    /// `RGBA32F` texels, two per node.
    pub node_texels: Vec<f32>,
    pub triangle_count: usize,
    pub node_count: usize,
    pub texture_width: u32,
    pub triangle_texture_height: u32,
    pub node_texture_height: u32,
}

/// Encodes a flattened node's link into a single float.
///
/// Inner nodes store `entry_index`, the node to jump to when the ray hits the
/// box. Leaves have no entry index (the crate marks them with `u32::MAX`) but do
/// need a shape index, so a leaf is encoded as `-(shape_index + 1)`. The sign
/// therefore tells the shader which kind of node it is, and both indices fit in
/// two texels' worth of `w` components instead of three.
///
/// The `+ 1` matters: shape index 0 would otherwise encode as `-0.0`, which
/// compares equal to `0.0` and would be read back as an inner node.
///
/// `f32` represents integers exactly up to 2^24, so this holds for any mesh up to
/// ~16 million triangles, far beyond what a single stone needs.
fn encode_node_link(node: &FlatNode<f32, 3>) -> f32 {
    if node.is_leaf() {
        -((node.shape_index as f32) + 1.0)
    } else {
        node.entry_index as f32
    }
}

fn write_vec3(destination: &mut [f32], value: Vector3<f32>) {
    destination[0] = value.x;
    destination[1] = value.y;
    destination[2] = value.z;
}

fn rows_for(texel_count: usize) -> usize {
    // At least one row, so an empty structure still produces a valid texture.
    (texel_count + DATA_TEXTURE_WIDTH - 1) / DATA_TEXTURE_WIDTH
}

/// Slab test against an axis-aligned box, mirroring `hitAabb` in `gem.frag`.
///
/// Uses the precomputed reciprocal direction, and orders each slab pair with
/// min/max rather than branching on the sign of the direction.
pub fn intersect_aabb(
    origin: Point3<f32>,
    inverse_direction: Vector3<f32>,
    minimum: Point3<f32>,
    maximum: Point3<f32>,
    t_min: f32,
    t_max: f32,
) -> bool {
    let first = (minimum - origin).component_mul(&inverse_direction);
    let second = (maximum - origin).component_mul(&inverse_direction);

    let near = first.inf(&second);
    let far = first.sup(&second);

    let enter = near.x.max(near.y).max(near.z).max(t_min);
    let exit = far.x.min(far.y).min(far.z).min(t_max);

    enter <= exit
}

/// How far outside a triangle, in barycentric units, a ray may pass and still count as a hit.
///
/// A ray through an edge shared by two triangles, or a vertex shared by several, lies on all of
/// them, but float rounding can put it just outside each one in its own test. With exact bounds
/// every one rejects it and the ray escapes through a crack in a watertight stone: 443 of 4,980
/// rays aimed at the hex cut's edges and vertices did (`rays_through_shared_edges_and_vertices_never_slip_through`).
///
/// The value is measured, not tuned. The rounding in `u` and `v` grows as the determinant shrinks,
/// that is for grazing rays and for sliver triangles. Over all 10,080 edge and vertex targets on
/// both shipped stones, the tolerance each needed was:
/// - at most 4.6e-6 for every ordinary triangle (area above 1e-3);
/// - more only on slivers: 1.1e-5 on the hex cut (area 3e-4, determinant 4e-4), and 1.27e-4 on
///   the oval cut, whose exporter fan-triangulated a girdle facet with nearly collinear vertices
///   into triangles of area 3e-5 and determinant 6e-5.
///
/// 1e-5 and 1e-4 each still lost a ray. 5e-4 covers the worst sliver with a fourfold margin. Its
/// cost is an overreach of 5e-4 of a triangle's size: about 2.5e-4 world units on the largest
/// facets of a unit-radius stone, a tenth of a pixel at the default view.
///
/// A tolerance scaled by each triangle's conditioning would avoid that overreach, but costs
/// square roots in the shader's hottest loop. Must match `TRIANGLE_EDGE_TOLERANCE` in `gem.frag`;
/// a test enforces that.
pub const TRIANGLE_EDGE_TOLERANCE: f32 = 5e-4;

/// Which side of the stone's surface a ray starts on, and so which triangles it can hit.
///
/// A closed, outward-wound surface is crossed alternately inwards and outwards. A ray that starts
/// outside the stone, such as a primary ray, first meets the surface where it enters: at a triangle
/// whose outward normal faces the ray. A ray inside the stone first meets it where it leaves: at a
/// triangle whose outward normal faces away from the ray. That holds for concave stones as well as
/// convex ones, so every trace can ignore triangles crossed the other way.
///
/// Ignoring them is what stops float error from becoming a false exit (T-0032). When both crossings
/// were accepted, a primary hit computed slightly outside the surface started the interior march
/// outside the stone, and the march met the entry facet again from outside. It took that for an
/// exit through a facet facing into the stone, which the back-facet leak rule showed as the window
/// colour: thin lines along facet edges.
///
/// Mirrors the `side` argument of `hitTriangle` and `traceScene` in `gem.frag`, which is `sign()`. A
/// test enforces that.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RaySide {
    /// A ray from outside the stone, which can only enter it.
    Outside,
    /// A ray inside the stone, which can only leave it.
    Inside,
}

impl RaySide {
    /// +1 for `Outside` and -1 for `Inside`: `RAY_FROM_OUTSIDE` and `RAY_FROM_INSIDE` in `gem.frag`.
    pub fn sign(self) -> f32 {
        match self {
            RaySide::Outside => 1.0,
            RaySide::Inside => -1.0,
        }
    }
}

/// Ray/triangle intersection, mirroring `hitTriangle` in `gem.frag`.
///
/// A triangle is hit only when the ray crosses it the way `side` allows: inwards, against its
/// outward normal, for `RaySide::Outside`, and outwards for `RaySide::Inside`. Every internal bounce
/// meets a facet from behind, so that crossing must stay accepted for rays inside the stone, or light
/// would leak straight out. Returns the hit distance if it lies in `(t_min, t_max)`.
#[allow(clippy::too_many_arguments)]
pub fn intersect_triangle(
    origin: Point3<f32>,
    direction: Vector3<f32>,
    a: Point3<f32>,
    b: Point3<f32>,
    c: Point3<f32>,
    t_min: f32,
    t_max: f32,
    side: RaySide,
) -> Option<f32> {
    let edge_ab = b - a;
    let edge_ac = c - a;

    let perpendicular = direction.cross(&edge_ac);
    let determinant = edge_ab.dot(&perpendicular);

    // The determinant is -dot(direction, (b - a) x (c - a)), and (b - a) x (c - a) is the outward
    // normal of an outward-wound triangle. So it is positive when the ray crosses the triangle
    // inwards and negative when it crosses outwards, and multiplied by the side's sign it is positive
    // exactly when this ray can make the crossing.
    //
    // Near zero means the ray runs parallel to the triangle's plane. The bound is held at 1e-8 to
    // match `hitTriangle` in gem.frag, where it is set by GLSL ES 3.00's guaranteed `highp float`
    // precision of 2^-16 relative. Keeping the two identical is what makes this function a faithful
    // predictor of the shader; a genuine non-parallel hit on a unit-radius model produces a
    // determinant orders of magnitude larger, so nothing real is rejected.
    if determinant * side.sign() < 1e-8 {
        return None;
    }

    let inverse_determinant = 1.0 / determinant;
    let a_to_origin = origin - a;

    let u = a_to_origin.dot(&perpendicular) * inverse_determinant;

    if u < -TRIANGLE_EDGE_TOLERANCE || u > 1.0 + TRIANGLE_EDGE_TOLERANCE {
        return None;
    }

    let q = a_to_origin.cross(&edge_ab);
    let v = direction.dot(&q) * inverse_determinant;

    if v < -TRIANGLE_EDGE_TOLERANCE || u + v > 1.0 + TRIANGLE_EDGE_TOLERANCE {
        return None;
    }

    let distance = edge_ac.dot(&q) * inverse_determinant;

    if distance <= t_min || distance >= t_max {
        return None;
    }

    Some(distance)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::Mesh;
    use bvh::ray::Ray;

    fn p(x: f32, y: f32, z: f32) -> Point3<f32> {
        Point3::new(x, y, z)
    }

    fn v(x: f32, y: f32, z: f32) -> Vector3<f32> {
        Vector3::new(x, y, z)
    }

    /// A unit cube centred on the origin, outward wound: 12 triangles, 6 facets.
    fn cube_mesh() -> Mesh {
        let positions = vec![
            p(-0.5, -0.5, -0.5),
            p(0.5, -0.5, -0.5),
            p(0.5, 0.5, -0.5),
            p(-0.5, 0.5, -0.5),
            p(-0.5, -0.5, 0.5),
            p(0.5, -0.5, 0.5),
            p(0.5, 0.5, 0.5),
            p(-0.5, 0.5, 0.5),
        ];
        let triangles = vec![
            [0, 3, 2],
            [0, 2, 1],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [3, 7, 6],
            [3, 6, 2],
            [0, 4, 7],
            [0, 7, 3],
            [1, 2, 6],
            [1, 6, 5],
        ];

        Mesh::build(&positions, &triangles, 1e-5).0
    }

    /// A deterministic pseudo-random generator, so the randomised traversal
    /// comparison is reproducible without pulling in an RNG dependency.
    /// This is a standard xorshift64* mixer.
    struct Rng(u64);

    impl Rng {
        fn next_f32(&mut self) -> f32 {
            let mut x = self.0;

            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;

            let scaled = x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 40;

            scaled as f32 / (1u32 << 24) as f32
        }

        /// Uniform in [-1, 1).
        fn next_signed(&mut self) -> f32 {
            self.next_f32() * 2.0 - 1.0
        }
    }

    /// My intersector must agree with the `bvh` crate's own `intersects_triangle` on
    /// a ray entering a triangle. Using the library as an oracle cross-checks the
    /// hand-written math that the GLSL mirrors.
    ///
    /// The ray must approach from the front, because the crate's intersector
    /// back-face culls: it returns an infinite distance for a ray arriving from
    /// behind. That is the crossing a ray from outside makes; the next test covers
    /// the other one, which the crate's intersector cannot report.
    #[test]
    fn triangle_intersection_agrees_with_bvh_crate_oracle() {
        let a = p(0.0, 0.0, 0.0);
        let b = p(1.0, 0.0, 0.0);
        let c = p(0.0, 1.0, 0.0);

        // Winding a -> b -> c gives an outward normal of +Z, so a front-facing ray
        // travels along -Z.
        let origin = p(0.25, 0.25, 2.0);
        let direction = v(0.0, 0.0, -1.0);

        let mine = intersect_triangle(origin, direction, a, b, c, 1e-6, f32::INFINITY, RaySide::Outside)
            .expect("ray aimed at the triangle must hit");

        let oracle = Ray::new(origin, direction).intersects_triangle(&a, &b, &c);

        assert!(
            (mine - oracle.distance).abs() < 1e-5,
            "my distance {} disagrees with the bvh crate's {}",
            mine,
            oracle.distance
        );
        assert!((mine - 2.0).abs() < 1e-5, "expected distance 2, got {}", mine);
    }

    /// A triangle must be hit only when the ray crosses it the way the ray's side allows.
    ///
    /// Setup: one triangle whose outward normal is +Z, and two rays through its interior. One
    /// travels along -Z and crosses it inwards; the other travels along +Z and crosses it outwards,
    /// as every internal bounce meets a facet. Test: intersect each ray as a ray from outside and as
    /// a ray from inside, and ask the `bvh` crate's intersector about the outward crossing.
    ///
    /// Verifies:
    /// - the inward crossing is a hit for a ray from outside, and not for a ray from inside;
    /// - the outward crossing is a hit, at the right distance, for a ray from inside, and not for a
    ///   ray from outside. Culling it for rays inside the stone would let every internal reflection
    ///   leak out;
    /// - the crate's intersector ignores the outward crossing, which is why this module does not
    ///   simply delegate to it.
    #[test]
    fn triangle_intersection_accepts_only_the_crossing_the_rays_side_allows() {
        let a = p(0.0, 0.0, 0.0);
        let b = p(1.0, 0.0, 0.0);
        let c = p(0.0, 1.0, 0.0);

        let inward = (p(0.25, 0.25, 2.0), v(0.0, 0.0, -1.0));
        let outward = (p(0.25, 0.25, -2.0), v(0.0, 0.0, 1.0));
        let hit = |(origin, direction): (Point3<f32>, Vector3<f32>), side: RaySide| {
            intersect_triangle(origin, direction, a, b, c, 1e-6, f32::INFINITY, side)
        };

        assert!(hit(inward, RaySide::Outside).is_some(), "a ray from outside must hit a triangle it enters");
        assert!(hit(inward, RaySide::Inside).is_none(), "a ray from inside must not hit a triangle it would enter");

        let leaving = hit(outward, RaySide::Inside).expect("a ray from inside must hit a triangle it leaves through");

        assert!((leaving - 2.0).abs() < 1e-5, "expected distance 2, got {}", leaving);
        assert!(hit(outward, RaySide::Outside).is_none(), "a ray from outside must not hit a triangle it would leave through");

        // The `bvh` crate's own intersector culls the outward crossing.
        let oracle = Ray::new(outward.0, outward.1).intersects_triangle(&a, &b, &c);

        assert!(
            !oracle.distance.is_finite(),
            "expected the library oracle to cull the outward crossing, got {}",
            oracle.distance
        );
    }

    /// A ray that starts just outside a facet must pass through that facet when traced as a ray from
    /// inside, and find the facet it really leaves through (T-0032).
    ///
    /// Setup: the unit cube, and a ray starting 3e-4 outside its +X face, heading into the cube and a
    /// little sideways. That is where float error left the interior march: a primary hit computed 3e-4
    /// outside the surface, then pushed only 1e-4 inwards by the shader's surface epsilon. Test: trace
    /// the ray with the shader's minimum distance, 1e-4, through the BVH and by brute force, as a ray
    /// from inside (as the interior march traces) and as a ray from outside.
    ///
    /// Verifies:
    /// - from inside, both find the -X face about 1.0006 away, the real exit, with an outward normal
    ///   the ray leaves through;
    /// - from outside, both find the +X face 3e-4 away. Before T-0032 the interior march accepted that
    ///   hit too. It oriented the normal along the ray, as if leaving through a facet facing into the
    ///   stone, and the back-facet leak rule showed the pixel in the window colour.
    #[test]
    fn a_ray_starting_just_outside_a_facet_passes_through_it_when_traced_from_inside() {
        let accel = Accel::build(&cube_mesh()).expect("cube BVH should build");
        let origin = p(0.5 + 3e-4, 0.05, -0.02);
        let direction = v(-1.0, 0.02, 0.01).normalize();

        for side in [RaySide::Inside, RaySide::Outside] {
            for (name, hit) in [
                ("BVH", accel.trace(origin, direction, 1e-4, f32::INFINITY, side)),
                ("brute force", accel.trace_brute_force(origin, direction, 1e-4, f32::INFINITY, side)),
            ] {
                let hit = hit.unwrap_or_else(|| panic!("{} from {:?}: the ray must hit the cube", name, side));

                if side == RaySide::Inside {
                    assert!(
                        (hit.distance - 1.0006).abs() < 1e-3,
                        "{} from inside: expected the far wall about 1.0006 away, got {}",
                        name,
                        hit.distance
                    );
                    assert!(
                        hit.outward_normal.x < -0.99 && hit.outward_normal.dot(&direction) > 0.0,
                        "{} from inside: expected the -X face, which the ray leaves through, got normal {:?}",
                        name,
                        hit.outward_normal
                    );
                } else {
                    assert!(
                        (hit.distance - 3e-4).abs() < 1e-5,
                        "{} from outside: expected the +X face 3e-4 away, got {}",
                        name,
                        hit.distance
                    );
                    assert!(
                        hit.outward_normal.x > 0.99,
                        "{} from outside: expected the +X face, got normal {:?}",
                        name,
                        hit.outward_normal
                    );
                }
            }
        }
    }

    /// A ray that passes outside the triangle's edges must miss, and a ray
    /// parallel to its plane must miss rather than dividing by zero, from either side.
    #[test]
    fn triangle_intersection_rejects_misses_and_parallel_rays() {
        let a = p(0.0, 0.0, 0.0);
        let b = p(1.0, 0.0, 0.0);
        let c = p(0.0, 1.0, 0.0);

        for side in [RaySide::Outside, RaySide::Inside] {
            // Aimed well outside the triangle in the u/v sense.
            assert!(
                intersect_triangle(p(5.0, 5.0, -2.0), v(0.0, 0.0, 1.0), a, b, c, 1e-6, f32::INFINITY, side)
                    .is_none(),
                "a ray outside the triangle must miss, from {:?}",
                side
            );

            // Travelling in the plane of the triangle.
            assert!(
                intersect_triangle(p(0.25, 0.25, 0.0), v(1.0, 0.0, 0.0), a, b, c, 1e-6, f32::INFINITY, side)
                    .is_none(),
                "a ray parallel to the plane must miss without dividing by zero, from {:?}",
                side
            );
        }
    }

    /// Hits nearer than `t_min` or farther than `t_max` must be rejected. The gem
    /// tracer relies on `t_min` to avoid immediately re-hitting the facet it just
    /// bounced off.
    #[test]
    fn triangle_intersection_respects_distance_bounds() {
        let a = p(0.0, 0.0, 0.0);
        let b = p(1.0, 0.0, 0.0);
        let c = p(0.0, 1.0, 0.0);
        let origin = p(0.25, 0.25, -2.0);
        let direction = v(0.0, 0.0, 1.0);

        // The true hit is at t = 2. The ray travels along the outward normal, +Z, so it
        // crosses the triangle outwards, as a ray inside a stone does.
        assert!(
            intersect_triangle(origin, direction, a, b, c, 1e-6, f32::INFINITY, RaySide::Inside).is_some(),
            "setup: within the bounds the ray must hit"
        );
        assert!(
            intersect_triangle(origin, direction, a, b, c, 3.0, f32::INFINITY, RaySide::Inside).is_none(),
            "a hit closer than t_min must be rejected"
        );
        assert!(
            intersect_triangle(origin, direction, a, b, c, 1e-6, 1.0, RaySide::Inside).is_none(),
            "a hit beyond t_max must be rejected"
        );
    }

    /// The slab test must accept a ray aimed through a box and reject one aimed
    /// away from it.
    #[test]
    fn aabb_test_accepts_hits_and_rejects_misses() {
        let minimum = p(-1.0, -1.0, -1.0);
        let maximum = p(1.0, 1.0, 1.0);

        assert!(
            intersect_aabb(
                p(0.0, 0.0, -5.0),
                v(f32::INFINITY, f32::INFINITY, 1.0),
                minimum,
                maximum,
                0.0,
                f32::INFINITY
            ),
            "a ray through the box must hit"
        );

        assert!(
            !intersect_aabb(
                p(5.0, 5.0, -5.0),
                v(f32::INFINITY, f32::INFINITY, 1.0),
                minimum,
                maximum,
                0.0,
                f32::INFINITY
            ),
            "a ray beside the box must miss"
        );
    }

    /// A ray travelling exactly parallel to a zero-thickness slab is the
    /// degenerate case that produces `0 * infinity == NaN` in the slab test. The
    /// padding applied to leaf bounds is what avoids it, so this test pins that
    /// the padded box still registers a hit.
    #[test]
    fn aabb_test_survives_zero_thickness_box_with_padding() {
        let padding = 1e-5;
        // A box flat in Y, as an axis-aligned facet's bounds would be.
        let minimum = p(-1.0, -padding, -1.0);
        let maximum = p(1.0, padding, 1.0);

        // Travelling along X, exactly in the plane of the flat box.
        let hit = intersect_aabb(
            p(-5.0, 0.0, 0.0),
            v(1.0, f32::INFINITY, f32::INFINITY),
            minimum,
            maximum,
            0.0,
            f32::INFINITY,
        );

        assert!(hit, "a padded flat box must still be hit by a parallel ray");
    }

    /// Every triangle must appear as a leaf exactly once. A triangle referenced
    /// twice would be tested twice, and one missing would be invisible.
    #[test]
    fn every_triangle_is_referenced_by_exactly_one_leaf() {
        let mesh = cube_mesh();
        let accel = Accel::build(&mesh).expect("cube BVH should build");

        let mut leaf_count = vec![0usize; accel.shapes.len()];

        for node in &accel.nodes {
            if node.is_leaf() {
                leaf_count[node.shape_index as usize] += 1;
            }
        }

        for (index, count) in leaf_count.iter().enumerate() {
            assert_eq!(
                *count, 1,
                "triangle {} appears in {} leaves, expected exactly 1",
                index, count
            );
        }
    }

    /// The flattened traversal must find exactly the same nearest hit as testing
    /// every triangle, for a large batch of randomised rays, from either side.
    ///
    /// This is the load-bearing test for the whole renderer: it validates the
    /// skip-pointer walk, the leaf/inner-node encoding, the slab test and the
    /// triangle test together, which is precisely the algorithm `gem.frag` runs
    /// per pixel per bounce. Rays are fired from around the cube, some from inside
    /// it, towards a scattered target so both hits and misses are covered. Each is
    /// traced both as a ray from outside and as a ray from inside, because the side
    /// rule changes which triangles the walk may stop at, and so which subtrees it
    /// may skip.
    #[test]
    fn flattened_traversal_matches_brute_force_for_random_rays() {
        let mesh = cube_mesh();
        let accel = Accel::build(&mesh).expect("cube BVH should build");

        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let mut hit_count = 0usize;
        let mut miss_count = 0usize;

        for iteration in 0..4000 {
            let origin = p(
                rng.next_signed() * 3.0,
                rng.next_signed() * 3.0,
                rng.next_signed() * 3.0,
            );
            // Aim at a point in a region larger than the cube, so roughly half the
            // rays miss.
            let target = p(
                rng.next_signed() * 1.2,
                rng.next_signed() * 1.2,
                rng.next_signed() * 1.2,
            );
            let direction = (target - origin).normalize();

            if !direction.norm().is_finite() || direction.norm() < 0.5 {
                continue;
            }

            for side in [RaySide::Outside, RaySide::Inside] {
                let fast = accel.trace(origin, direction, 1e-5, f32::INFINITY, side);
                let slow = accel.trace_brute_force(origin, direction, 1e-5, f32::INFINITY, side);

                match (fast, slow) {
                    (None, None) => miss_count += 1,
                    (Some(fast_hit), Some(slow_hit)) => {
                        hit_count += 1;

                        assert!(
                            (fast_hit.distance - slow_hit.distance).abs() < 1e-4,
                            "iteration {} from {:?}: BVH distance {} != brute force {} \
                             (origin {:?}, direction {:?})",
                            iteration,
                            side,
                            fast_hit.distance,
                            slow_hit.distance,
                            origin,
                            direction
                        );
                    }
                    (fast_result, slow_result) => panic!(
                        "iteration {} from {:?}: BVH and brute force disagree on whether there \
                         is a hit at all: {:?} vs {:?} (origin {:?}, direction {:?})",
                        iteration, side, fast_result, slow_result, origin, direction
                    ),
                }
            }
        }

        // Guard against the test silently degenerating into all-misses or
        // all-hits, which would make the comparison meaningless.
        assert!(hit_count > 200, "expected many hits, got {}", hit_count);
        assert!(miss_count > 200, "expected many misses, got {}", miss_count);
    }

    /// Rays fired from *inside* the solid must also be traced correctly, since
    /// that is what every internal bounce does. A ray starting at the centre, traced
    /// as a ray from inside, must always hit exactly one wall, and never miss.
    #[test]
    fn traversal_matches_brute_force_for_rays_starting_inside() {
        let mesh = cube_mesh();
        let accel = Accel::build(&mesh).expect("cube BVH should build");

        let mut rng = Rng(0xDEAD_BEEF_1234_5678);

        for iteration in 0..2000 {
            let direction = v(rng.next_signed(), rng.next_signed(), rng.next_signed());

            if direction.norm() < 1e-3 {
                continue;
            }

            let direction = direction.normalize();
            let origin = p(0.0, 0.0, 0.0);

            let fast = accel.trace(origin, direction, 1e-5, f32::INFINITY, RaySide::Inside);
            let slow = accel.trace_brute_force(origin, direction, 1e-5, f32::INFINITY, RaySide::Inside);

            let fast_hit = fast.unwrap_or_else(|| {
                panic!(
                    "iteration {}: a ray from the centre must always hit a wall \
                     (direction {:?})",
                    iteration, direction
                )
            });
            let slow_hit = slow.expect("brute force must also hit");

            assert!(
                (fast_hit.distance - slow_hit.distance).abs() < 1e-4,
                "iteration {}: inside-out BVH distance {} != brute force {}",
                iteration,
                fast_hit.distance,
                slow_hit.distance
            );
        }
    }

    /// Rays aimed exactly at a stone's own edges and vertices must hit it, not slip through a
    /// crack between the triangles that share them.
    ///
    /// Setup: both shipped stones, `hex_cut_v2.obj` and `oval_cut.obj`, conditioned exactly as
    /// the page does it (load, weld, centre and scale to radius 1, optical axis +Z onto +Y).
    /// Both are convex and centred on their bounding boxes, so the origin is inside each, and
    /// every ray from it must leave through the surface.
    ///
    /// Test: from the origin, fire a ray at every triangle vertex and at nine evenly spaced
    /// points along every triangle edge, as rays from inside, the way the interior march traces,
    /// through both the BVH walk and brute force, and count the rays that report no hit.
    ///
    /// Verifies there are none. Each such target lies on two triangles (a vertex on several),
    /// and float rounding can put the ray just outside every one of them in its own barycentric
    /// test. With no tolerance on those tests, all of them reject it and the ray escapes: the
    /// code review of 2026-09-15 measured 4,269 of 49,800 edge rays missing on the hex cut.
    /// Brute force is checked too, so a failure here is the triangle test, not the hierarchy.
    #[test]
    fn rays_through_shared_edges_and_vertices_never_slip_through() {
        let stones = [
            ("hex_cut_v2", include_str!("../resources/hex_cut_v2.obj")),
            ("oval_cut", include_str!("../resources/oval_cut.obj")),
        ];

        for (name, text) in stones {
            let geometry = crate::loader::load_obj_text(text).expect("shipped stone must load");
            let (mut mesh, _) = Mesh::build(&geometry.positions, &geometry.triangles, 1e-5);

            mesh.center_and_scale(1.0);
            mesh.reorient_axis_to_y(crate::mesh::ModelAxis::PlusZ);

            let accel = Accel::build(&mesh).expect("shipped stone BVH should build");
            let origin = p(0.0, 0.0, 0.0);

            let mut targets = Vec::new();

            for shape in &accel.shapes {
                for (start, end) in [(shape.a, shape.b), (shape.b, shape.c), (shape.c, shape.a)] {
                    targets.push(start);

                    for step in 1..10 {
                        targets.push(start + (end - start) * (step as f32 / 10.0));
                    }
                }
            }

            let mut bvh_misses = 0usize;
            let mut brute_force_misses = 0usize;

            for target in &targets {
                let direction = (target - origin).normalize();

                if accel.trace(origin, direction, 1e-5, f32::INFINITY, RaySide::Inside).is_none() {
                    bvh_misses += 1;
                }

                if accel
                    .trace_brute_force(origin, direction, 1e-5, f32::INFINITY, RaySide::Inside)
                    .is_none()
                {
                    brute_force_misses += 1;
                }
            }

            assert!(targets.len() > 1000, "{}: only {} targets", name, targets.len());
            assert_eq!(
                (bvh_misses, brute_force_misses),
                (0, 0),
                "{}: of {} rays aimed at edges and vertices, {} missed through the BVH and {} \
                 by brute force",
                name,
                targets.len(),
                bvh_misses,
                brute_force_misses
            );
        }
    }

    /// Loads a shipped stone and conditions it exactly as the page does: weld, centre and scale
    /// to radius 1, then turn the model's optical axis (+Z in both OBJ files) onto +Y.
    fn conditioned_stone(text: &str) -> Mesh {
        let geometry = crate::loader::load_obj_text(text).expect("shipped stone must load");
        let (mut mesh, _) = Mesh::build(&geometry.positions, &geometry.triangles, 1e-5);

        mesh.center_and_scale(1.0);
        mesh.reorient_axis_to_y(crate::mesh::ModelAxis::PlusZ);

        mesh
    }

    /// The two stones the page ships, by the names their files carry.
    const SHIPPED_STONES: [(&str, &str); 2] = [
        ("hex_cut_v2", include_str!("../resources/hex_cut_v2.obj")),
        ("oval_cut", include_str!("../resources/oval_cut.obj")),
    ];

    /// The flattened traversal must find the same nearest hit as brute force **on the stones the
    /// renderer actually draws**, not only on a cube.
    ///
    /// Why this exists (T-0069 / T-0070): the sibling test above runs on `cube_mesh()`, twelve
    /// large, well-conditioned triangles whose bounding boxes have plenty of slack. The real
    /// stones do not: 166 and 170 triangles, some of them slivers, packed into a deep hierarchy
    /// whose node boxes hug individual facets. The node padding was `diagonal * 1e-5` while
    /// `intersect_triangle` accepted hits up to `3 * TRIANGLE_EDGE_TOLERANCE * longest_edge`
    /// outside a triangle, sixty times further, so an inner node could cull a subtree whose
    /// triangle the leaf test would have accepted. The cube never showed it and this test does.
    ///
    /// Setup: both stones, conditioned as the page conditions them, and two families of rays
    /// per stone, each traced from both sides because the side rule changes which triangles the
    /// walk may stop at and so which subtrees it may skip.
    /// - *Scattered*: random origins in a box around the stone aimed at a scattered target, so
    ///   roughly half miss. This is the cube test's distribution, for breadth.
    /// - *Grazing near a facet edge*: a random point within 3e-4 world units of a random
    ///   triangle's edge, approached along a direction whose angle to that triangle's plane has
    ///   |cos| between 0.05 and 1. This is where the padding decides the answer: an oblique hit
    ///   near an edge is exactly the one the edge tolerance accepts and a too-tight box culls.
    ///   The lower bound on |cos| is deliberate: a ray nearly *in* a facet's plane makes the
    ///   triangle test's determinant vanish, `u` and `v` become numerically meaningless and both
    ///   tracers report nonsense, which says nothing about the hierarchy.
    ///
    /// Test: trace each ray through the BVH and by brute force and require them to agree.
    ///
    /// Verifies the walk visits a superset of brute force's candidates, which is the whole
    /// reason `trace_brute_force` is a valid oracle. Distances are compared exactly, and that is
    /// not over-strict: both tracers keep the minimum distance over the triangles they accept,
    /// computed by the same arithmetic, so a difference of any size at all means the walk skipped
    /// the winning triangle. The triangle *index* is deliberately not compared: at a shared edge
    /// the tolerance band lets both triangles accept the ray at the very same distance, and the
    /// two tracers break that tie in their own visit order, which is not a cull.
    ///
    /// Teeth, measured 2026-09-16 with the old `diagonal * 1e-5` padding restored: this test
    /// reported 65 disagreements out of 12,000 casts on hex_cut_v2 and 98 on oval_cut, a mixture
    /// of hits lost outright and hits taken on the wrong, farther facet. With the padding derived
    /// from the tolerance it reports none, as it does over 2,000,000 casts per stone off-line.
    #[test]
    fn flattened_traversal_matches_brute_force_on_the_shipped_stones() {
        // Each ray below is traced from both sides, so these are half the casts.
        const SCATTERED_RAYS: usize = 2_000;
        const GRAZING_RAYS: usize = 4_000;
        // How close to a triangle's edge the grazing family aims, in world units. Comfortably
        // wider than the tolerance's world reach, so the band straddles the edge.
        const EDGE_BAND: f32 = 3e-4;

        for (name, text) in SHIPPED_STONES {
            let accel = Accel::build(&conditioned_stone(text)).expect("shipped stone BVH builds");
            let mut rng = Rng(0x243F_6A88_85A3_08D3);
            let mut rays: Vec<(Point3<f32>, Vector3<f32>)> = Vec::new();

            // Family one: scattered rays, half of which miss the stone entirely.
            while rays.len() < SCATTERED_RAYS {
                let origin = p(
                    rng.next_signed() * 3.0,
                    rng.next_signed() * 3.0,
                    rng.next_signed() * 3.0,
                );
                let target = p(
                    rng.next_signed() * 1.2,
                    rng.next_signed() * 1.2,
                    rng.next_signed() * 1.2,
                );
                let offset = target - origin;

                if offset.norm() < 0.5 {
                    continue;
                }

                rays.push((origin, offset.normalize()));
            }

            // Family two: oblique rays passing within EDGE_BAND of a triangle's edge.
            while rays.len() < SCATTERED_RAYS + GRAZING_RAYS {
                let shape = &accel.shapes[(rng.next_f32() * accel.shapes.len() as f32) as usize
                    % accel.shapes.len()];
                let (start, end, opposite) = match (rng.next_f32() * 3.0) as usize {
                    0 => (shape.a, shape.b, shape.c),
                    1 => (shape.b, shape.c, shape.a),
                    _ => (shape.c, shape.a, shape.b),
                };

                // A point on the edge, nudged towards or away from the opposite vertex, so the
                // target lands just inside or just outside the triangle.
                let on_edge = start + (end - start) * rng.next_f32();
                let inward = opposite - on_edge;

                if inward.norm() < 1e-6 {
                    continue;
                }

                let target = on_edge + inward.normalize() * (rng.next_signed() * EDGE_BAND);

                // A direction whose angle to this triangle's plane has |cos| in [0.05, 1]: take a
                // vector in the plane and add a bounded amount of the normal back.
                let normal = shape.normal();
                let sample = v(rng.next_signed(), rng.next_signed(), rng.next_signed());
                let tangent = sample - normal * sample.dot(&normal);

                if tangent.norm() < 1e-3 {
                    continue;
                }

                let cosine = 0.05 + 0.95 * rng.next_f32();
                let signed = if rng.next_f32() < 0.5 { -cosine } else { cosine };
                let direction = (tangent.normalize() + normal * signed).normalize();

                // Start well outside the stone, on the ray through the target.
                rays.push((target - direction * 1.5, direction));
            }

            let mut hit_count = 0usize;
            let mut miss_count = 0usize;
            let mut disagreement_count = 0usize;
            // Only the first few are kept for the message; all of them are counted, so the
            // failure says how bad it is and not merely that it is bad.
            let mut reported = Vec::new();

            for (index, (origin, direction)) in rays.iter().enumerate() {
                for side in [RaySide::Outside, RaySide::Inside] {
                    let fast = accel.trace(*origin, *direction, 1e-4, f32::INFINITY, side);
                    let slow = accel.trace_brute_force(*origin, *direction, 1e-4, f32::INFINITY, side);

                    match (fast, slow) {
                        (None, None) => miss_count += 1,
                        (Some(fast_hit), Some(slow_hit))
                            if fast_hit.distance == slow_hit.distance =>
                        {
                            hit_count += 1;
                        }
                        _ => {
                            disagreement_count += 1;

                            if reported.len() < 5 {
                                reported.push(format!(
                                    "  ray {} from {:?}: BVH {:?}, brute force {:?} \
                                     (origin {:?}, direction {:?})",
                                    index,
                                    side,
                                    fast.map(|hit| (hit.distance, hit.triangle)),
                                    slow.map(|hit| (hit.distance, hit.triangle)),
                                    origin,
                                    direction
                                ));
                            }
                        }
                    }
                }
            }

            let total = rays.len() * 2;

            assert_eq!(
                disagreement_count,
                0,
                "{}: {} of {} casts disagreed between the BVH walk and brute force; first few:\n{}",
                name,
                disagreement_count,
                total,
                reported.join("\n")
            );

            // Guard against the families degenerating into all-hits or all-misses, which would
            // make the comparison meaningless.
            assert!(hit_count > total / 4, "{}: only {} hits of {}", name, hit_count, total);
            assert!(miss_count > total / 20, "{}: only {} misses of {}", name, miss_count, total);
        }
    }

    /// The exact ray T-0069 was found and confirmed with must return the same hit from the walk
    /// and from brute force.
    ///
    /// Setup: hex_cut_v2, conditioned as the page conditions it, and one named ray inside the
    /// stone. Test: trace it both ways as a ray from inside, the way `traceInterior` traces.
    ///
    /// Verifies the fix at the point it broke. At t = 0.2355 this ray leaves through triangle 13
    /// with a barycentric `v` of -3.8e-4, which is inside `TRIANGLE_EDGE_TOLERANCE` so
    /// `intersect_triangle` accepts it, but that puts the hit point 4.5e-4 world units outside
    /// triangle 13's own bounding box. The old padding of `diagonal * 1e-5` = 2.8e-5 was far too
    /// small to cover it, an inner node culled the subtree, and `Accel::trace` returned None while
    /// `trace_brute_force` returned the hit. In the shader that is a stray dark pixel near a facet
    /// edge: `gem.frag`'s `traceInterior` treats a missed `traceScene` as an unfinished path and
    /// discards the remaining throughput. Pinned by name so the failure cannot come back silently
    /// if the padding is ever detached from the tolerance again.
    #[test]
    fn the_named_ray_that_the_old_node_padding_culled_is_found_again() {
        let (name, text) = SHIPPED_STONES[0];
        assert_eq!(name, "hex_cut_v2", "this reproducer was measured on the hex cut");

        let accel = Accel::build(&conditioned_stone(text)).expect("shipped stone BVH builds");
        let origin = p(-0.6701925, 0.16837478, 0.69963264);
        let direction = v(0.7637874, 0.1296043, 0.6323224);

        let fast = accel.trace(origin, direction, 1e-4, f32::INFINITY, RaySide::Inside);
        let slow = accel.trace_brute_force(origin, direction, 1e-4, f32::INFINITY, RaySide::Inside);

        let fast_hit = fast.expect("the BVH walk must not cull the facet this ray leaves through");
        let slow_hit = slow.expect("setup: brute force must find that facet");

        assert_eq!(
            (fast_hit.distance, fast_hit.triangle),
            (slow_hit.distance, slow_hit.triangle),
            "the walk and brute force must agree on the named T-0069 ray"
        );
        assert!(
            (fast_hit.distance - 0.23553361).abs() < 1e-6,
            "setup: expected the hit 0.23553361 away, got {}",
            fast_hit.distance
        );
    }

    /// A ray that has just bounced off a facet must never hit that facet again, even when the
    /// trace is given no minimum distance at all. This is what lets `gem.frag` trace the interior
    /// march from `INTERIOR_T_MIN` (1e-6) rather than from the surface nudge (T-0082).
    ///
    /// Why it holds, in one line: the bounce leaves with `direction = reflect(direction,
    /// outwardNormal)`, so `dot(direction, outwardNormal) <= 0`, and `intersect_triangle`'s
    /// determinant is `-dot(direction, (b - a) x (c - a))`, which is therefore `>= 0` for that
    /// facet -- and for every other triangle lying in its plane. Times `RaySide::Inside`'s -1 that
    /// is `<= 0`, so the `< 1e-8` test rejects it *before* the distance test is ever reached. The
    /// side rule, not the minimum distance, is the self-hit guard.
    ///
    /// Setup: both shipped stones, conditioned as the page conditions them, and synthetic bounces
    /// that stress the claim where it is weakest. Each picks a triangle, lands within `band` of
    /// one of its edges (so the next facet is a hair away), and arrives along a direction whose
    /// normal component is scaled by `grazing`: 1.0 is an ordinary arrival, and 1e-7 is a ray
    /// almost exactly in the facet's plane, where the determinant approaches its 1e-8 floor and
    /// the normal and the determinant can disagree in sign -- the case for which `traceInterior`
    /// carries its normal flip. The bounce is then taken exactly as the shader takes it: flip the
    /// normal if it disagrees, reflect, nudge in by the surface epsilon, trace from inside.
    ///
    /// Verifies two things:
    /// - no trace comes back on the triangle just left, nor on any other triangle in its plane,
    ///   with `t_min` set to exactly 0. The larger sweep behind this test (T-0082) found none in
    ///   7.6M synthetic bounces and 457M interior segments from full camera marches;
    /// - some of these bounces really do exit inside the old dead zone, nearer than the nudge, and
    ///   brute force finds the same exit. Those were the hits the old `t_min` threw away, and
    ///   `traceInterior` discards a path's whole remaining throughput when a trace misses, so each
    ///   one was a dark pixel. Without this half the test could pass on a stone where the dead
    ///   zone happened to be empty, which would prove nothing.
    #[test]
    fn a_bounce_never_re_hits_the_facet_it_just_left_even_with_no_minimum_distance() {
        /// Bounces per configuration per stone.
        const BOUNCES: usize = 4_000;
        /// Distance from a facet edge to land within, and how much of the arriving direction is
        /// along the normal (small means grazing).
        const CONFIGURATIONS: [(f32, f32); 5] = [
            (1e-2, 1.0),
            (1e-3, 1.0),
            (1e-4, 1.0),
            (1e-4, 1e-3),
            (1e-4, 1e-7),
        ];
        /// `SURFACE_EPSILON` in `gem.frag`: the nudge, and the minimum distance the interior march
        /// used before T-0082.
        const SURFACE_EPSILON: f32 = 1e-4;

        for (name, text) in SHIPPED_STONES {
            let accel = Accel::build(&conditioned_stone(text)).expect("shipped stone BVH builds");
            let mut rng = Rng(0x243F_6A88_85A3_08D3);

            let mut self_hits = Vec::new();
            let mut short_exits = 0usize;
            let mut short_exits_brute_force_agreed = 0usize;

            for (band, grazing) in CONFIGURATIONS {
                for _ in 0..BOUNCES {
                    let index =
                        (rng.next_f32() * accel.shapes.len() as f32) as usize % accel.shapes.len();
                    let shape = &accel.shapes[index];
                    let normal = shape.normal();

                    // A point on one of the triangle's edges, pulled a little way towards the
                    // opposite vertex so it is inside the triangle but within `band` of the edge.
                    let (start, end, opposite) = match (rng.next_f32() * 3.0) as usize {
                        0 => (shape.a, shape.b, shape.c),
                        1 => (shape.b, shape.c, shape.a),
                        _ => (shape.c, shape.a, shape.b),
                    };
                    let on_edge = start + (end - start) * rng.next_f32();
                    let inward = opposite - on_edge;

                    if inward.norm() < 1e-6 {
                        continue;
                    }

                    let surface_point = on_edge + inward.normalize() * (rng.next_f32() * band);

                    // An arrival from inside the stone: a direction in the facet's plane plus a
                    // `grazing`-scaled component along the outward normal.
                    let sample = v(rng.next_signed(), rng.next_signed(), rng.next_signed());
                    let tangent = sample - normal * sample.dot(&normal);

                    if tangent.norm() < 1e-3 {
                        continue;
                    }

                    let arriving =
                        (tangent.normalize() + normal * (grazing * rng.next_f32())).normalize();

                    // From here on this is `traceInterior` in `gem.frag`, line for line.
                    let mut outward = normal;

                    if arriving.dot(&outward) < 0.0 {
                        outward = -outward;
                    }

                    let direction = arriving - outward * (2.0 * outward.dot(&arriving));
                    let origin = surface_point - outward * SURFACE_EPSILON;

                    let hit = match accel.trace(origin, direction, 0.0, f32::INFINITY, RaySide::Inside)
                    {
                        Some(hit) => hit,
                        // A miss says nothing about self-hits, and near-parallel arrivals do miss;
                        // see the residual recorded in kb/bvh-traversal-and-packing.md.
                        None => continue,
                    };

                    let hit_shape = &accel.shapes[hit.triangle];
                    let same_plane = (hit_shape.normal() - normal).norm() < 1e-4
                        && (hit_shape.a - surface_point).dot(&normal).abs() < 1e-5;

                    if hit.triangle == index || same_plane {
                        self_hits.push(format!(
                            "  left triangle {} and hit {} at t {:e} (band {:e}, grazing {:e}, \
                             origin {:?}, direction {:?})",
                            index, hit.triangle, hit.distance, band, grazing, origin, direction
                        ));
                    }

                    if hit.distance > 0.0 && hit.distance <= SURFACE_EPSILON {
                        short_exits += 1;

                        let slow = accel.trace_brute_force(
                            origin,
                            direction,
                            0.0,
                            f32::INFINITY,
                            RaySide::Inside,
                        );

                        if slow.map(|other| other.distance) == Some(hit.distance) {
                            short_exits_brute_force_agreed += 1;
                        }
                    }
                }
            }

            assert!(
                self_hits.is_empty(),
                "{}: {} bounces came back on the facet they had just left, which the side rule \
                 must make impossible; first few:\n{}",
                name,
                self_hits.len(),
                self_hits.iter().take(5).cloned().collect::<Vec<_>>().join("\n")
            );
            assert!(
                short_exits > 10,
                "{}: only {} of these bounces exited nearer than {:e}, so this test would not \
                 notice the dead zone coming back",
                name,
                short_exits,
                SURFACE_EPSILON
            );
            assert_eq!(
                short_exits_brute_force_agreed, short_exits,
                "{}: brute force disagreed with the walk on {} of the {} exits inside the old \
                 dead zone, so they are not all genuine",
                name,
                short_exits - short_exits_brute_force_agreed,
                short_exits
            );
        }
    }

    /// A single-triangle mesh is the smallest possible hierarchy and a common
    /// off-by-one trap in flattening. It must still build and trace.
    #[test]
    fn builds_and_traces_a_single_triangle_hierarchy() {
        let positions = vec![p(0.0, 0.0, 0.0), p(1.0, 0.0, 0.0), p(0.0, 1.0, 0.0)];
        let triangles = vec![[0, 1, 2]];
        let mesh = Mesh::build(&positions, &triangles, 1e-5).0;

        let accel = Accel::build(&mesh).expect("single triangle BVH should build");

        // The triangle's outward normal is +Z, so a ray travelling along +Z leaves through it.
        let hit = accel.trace(p(0.25, 0.25, -1.0), v(0.0, 0.0, 1.0), 1e-5, f32::INFINITY, RaySide::Inside);

        assert!(hit.is_some(), "the single triangle must be hit");
        assert!((hit.unwrap().distance - 1.0).abs() < 1e-5);
    }

    /// The shader must apply the ray side rule exactly as `intersect_triangle` does, with the signs
    /// `RaySide::sign` gives, and trace each ray from the side it starts on.
    ///
    /// Setup: the text of `gem.frag`. Test: look for the two side constants written from
    /// `RaySide::sign`, the determinant test in `hitTriangle`, and the two `traceScene` calls: the
    /// primary ray in `main`, as a ray from outside, and the interior march in `traceInterior`, as a
    /// ray from inside.
    ///
    /// Verifies the tests of the mirror above speak for the shader. A shader that went back to a
    /// double-sided test would bring back T-0032's window-colour lines, and one that traced the
    /// interior march from outside would lose every internal reflection, with no host test failing.
    #[test]
    fn shader_applies_the_ray_side_rule_used_here() {
        let shader = include_str!("shaders/gem.frag");

        for (name, side) in [("RAY_FROM_OUTSIDE", RaySide::Outside), ("RAY_FROM_INSIDE", RaySide::Inside)] {
            let expected = format!("const float {} = {:?};", name, side.sign());

            assert!(shader.contains(&expected), "gem.frag must declare {}", expected);
        }

        assert!(
            shader.contains("if (determinant * side < 1e-8) {") && !shader.contains("abs(determinant)"),
            "hitTriangle in gem.frag must accept only the crossing the ray's side allows"
        );
        assert!(
            shader.contains(
                "traceScene(origin, direction, SURFACE_EPSILON, FAR_DISTANCE, RAY_FROM_OUTSIDE, entry)"
            ),
            "main in gem.frag must trace the primary ray as a ray from outside"
        );
        assert!(
            shader.contains(
                "traceScene(origin, direction, INTERIOR_T_MIN, FAR_DISTANCE, RAY_FROM_INSIDE, interior)"
            ),
            "traceInterior in gem.frag must trace as a ray from inside"
        );
    }

    /// The interior march's minimum hit distance must stay far below the nudge that starts the ray
    /// inside the surface, because it is not what keeps the march off the facet it just left.
    ///
    /// Setup: the text of `gem.frag`, and its two constants read back out of it. Test: require
    /// `INTERIOR_T_MIN` to be declared, to be at most a hundredth of `SURFACE_EPSILON`, and to be
    /// the bound the interior `traceScene` call passes while the primary ray keeps
    /// `SURFACE_EPSILON`.
    ///
    /// Verifies the fix for T-0082 cannot quietly regress. The two were equal, which made the
    /// distance test a dead zone: the side rule in `hitTriangle` had already rejected the facet
    /// just left (its determinant times `RAY_FROM_INSIDE` is not positive once the direction has
    /// been reflected), so the only hits the bound could still reject were genuine exits nearer
    /// than the nudge. Those exist -- a bounce landing within the nudge of a facet edge leaves the
    /// origin barely inside the neighbouring facet -- and `traceInterior` treats a missed
    /// `traceScene` as an unfinished path and throws the remaining throughput away, which is a
    /// dark pixel. Nothing on the host runs the shader, so a text check is the only guard, and it
    /// is a cheap one: the reasoning is recorded beside the constant.
    #[test]
    fn the_interior_march_accepts_hits_far_nearer_than_the_surface_nudge() {
        let shader = include_str!("shaders/gem.frag");

        // Pulls `const float NAME = VALUE;` out of the shader text. Parsing it rather than
        // hard-coding the number here keeps this test about the *relationship* between the two
        // constants, which is what matters, instead of about one chosen value.
        let constant = |name: &str| -> f32 {
            let prefix = format!("const float {} = ", name);
            let start = shader
                .find(&prefix)
                .unwrap_or_else(|| panic!("gem.frag must declare {}", name))
                + prefix.len();
            let text = &shader[start..];
            let end = text.find(';').expect("a constant declaration must end in a semicolon");

            text[..end]
                .trim()
                .parse()
                .unwrap_or_else(|error| panic!("{} is not a float: {}", name, error))
        };

        let interior_t_min = constant("INTERIOR_T_MIN");
        let surface_epsilon = constant("SURFACE_EPSILON");

        assert!(
            interior_t_min > 0.0 && interior_t_min <= surface_epsilon * 1e-2,
            "INTERIOR_T_MIN is {:e}, which is not safely below SURFACE_EPSILON {:e}: an exit \
             nearer than the nudge would be discarded as a miss",
            interior_t_min,
            surface_epsilon
        );
        assert!(
            shader.contains(
                "traceScene(origin, direction, INTERIOR_T_MIN, FAR_DISTANCE, RAY_FROM_INSIDE, interior)"
            ),
            "the interior march in gem.frag must trace from INTERIOR_T_MIN"
        );
        assert!(
            shader.contains(
                "traceScene(origin, direction, SURFACE_EPSILON, FAR_DISTANCE, RAY_FROM_OUTSIDE, entry)"
            ),
            "the primary ray in gem.frag keeps SURFACE_EPSILON, where no hit can be that near"
        );
    }

    /// Building over an empty mesh is a caller error and must be reported, not
    /// produce an empty hierarchy that silently renders nothing.
    #[test]
    fn rejects_empty_mesh() {
        // Matched rather than unwrapped because `FlatNode` has no `Debug`, so the
        // success type of the result cannot be unwrapped by the usual helpers.
        let error = match Accel::build(&Mesh::default()) {
            Ok(_) => panic!("empty mesh must be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("no triangles"), "got {:?}", error);
    }

    /// The packed texture data must have the right shape: three texels per
    /// triangle, two per node, four floats per texel, padded to whole rows.
    #[test]
    fn gpu_packing_has_expected_dimensions() {
        let mesh = cube_mesh();
        let accel = Accel::build(&mesh).expect("cube BVH should build");
        let gpu = accel.to_gpu();

        assert_eq!(gpu.triangle_count, 12);
        assert_eq!(gpu.node_count, accel.nodes.len());

        assert_eq!(
            gpu.triangle_texels.len(),
            gpu.triangle_texture_height as usize * gpu.texture_width as usize * FLOATS_PER_TEXEL,
            "triangle texel buffer must exactly fill its texture"
        );
        assert_eq!(
            gpu.node_texels.len(),
            gpu.node_texture_height as usize * gpu.texture_width as usize * FLOATS_PER_TEXEL,
            "node texel buffer must exactly fill its texture"
        );
    }

    /// Vertices and the facet id must land in the exact texel slots the shader
    /// reads them from, or the stone renders as garbage.
    #[test]
    fn gpu_packing_writes_vertices_and_facet_id_in_expected_slots() {
        let mesh = cube_mesh();
        let accel = Accel::build(&mesh).expect("cube BVH should build");
        let gpu = accel.to_gpu();

        // Check the first triangle in BVH order against the packed data.
        let shape = &accel.shapes[0];

        assert_eq!(gpu.triangle_texels[0], shape.a.x);
        assert_eq!(gpu.triangle_texels[1], shape.a.y);
        assert_eq!(gpu.triangle_texels[2], shape.a.z);
        assert_eq!(
            gpu.triangle_texels[3], shape.facet as f32,
            "facet id belongs in the w component of the first texel"
        );

        assert_eq!(gpu.triangle_texels[4], shape.b.x);
        assert_eq!(gpu.triangle_texels[8], shape.c.x);
    }

    /// Each triangle's wireframe mask must reach the shader in texel 1's w, attached to the
    /// right triangle even after the BVH build has reordered them.
    ///
    /// Setup: the cube mesh, its masks from `Mesh::facet_boundary_masks` (in mesh order), and
    /// the packed texture. `Bvh::build` permutes the shapes, so shape `i` in the texture is
    /// generally not mesh triangle `i`.
    ///
    /// Test: for every packed triangle, find the mesh triangle with the same three vertices in
    /// the same order, and compare its mask with the float in texel 1's w.
    ///
    /// Verifies the mask is carried with its own triangle rather than indexed by position after
    /// the permutation. Getting that wrong would not fail loudly: the overlay would simply
    /// outline the wrong edges -- face diagonals drawn, facet edges missing -- on every stone.
    #[test]
    fn gpu_packing_writes_each_triangles_facet_edge_mask_beside_vertex_b() {
        let mesh = cube_mesh();
        let masks = mesh.facet_boundary_masks();
        let accel = Accel::build(&mesh).expect("cube BVH should build");
        let gpu = accel.to_gpu();

        for (index, shape) in accel.shapes.iter().enumerate() {
            let source = (0..mesh.triangles.len())
                .find(|&t| mesh.triangle_positions(t) == [shape.a, shape.b, shape.c])
                .expect("every packed triangle comes from a mesh triangle");
            let packed = gpu.triangle_texels[index * TEXELS_PER_TRIANGLE * FLOATS_PER_TEXEL + 7];

            assert_eq!(
                packed,
                f32::from(masks[source]),
                "packed triangle {} (mesh triangle {}) carries the wrong wireframe mask",
                index,
                source
            );
            assert_ne!(packed, 0.0, "setup: every cube triangle has facet edges to draw");
        }
    }

    /// Leaves must encode as a negative link and inner nodes as a non-negative
    /// one, since the shader uses the sign to tell them apart. In particular a
    /// leaf pointing at shape 0 must not encode as `-0.0`, which would read back
    /// as inner node 0 and send the traversal into an infinite loop.
    #[test]
    fn node_link_encoding_separates_leaves_from_inner_nodes_including_shape_zero() {
        let mesh = cube_mesh();
        let accel = Accel::build(&mesh).expect("cube BVH should build");
        let gpu = accel.to_gpu();

        let mut saw_leaf = false;
        let mut saw_inner = false;
        let mut saw_shape_zero_leaf = false;

        for (index, node) in accel.nodes.iter().enumerate() {
            let link = gpu.node_texels[index * TEXELS_PER_NODE * FLOATS_PER_TEXEL + 3];

            if node.is_leaf() {
                saw_leaf = true;

                assert!(
                    link < 0.0,
                    "leaf {} encoded as {}, which is not negative",
                    index,
                    link
                );

                // Decode exactly as the shader does and confirm the round trip.
                let decoded = (-link) as u32 - 1;

                assert_eq!(
                    decoded, node.shape_index,
                    "leaf {} shape index did not survive the round trip",
                    index
                );

                if node.shape_index == 0 {
                    saw_shape_zero_leaf = true;
                }
            } else {
                saw_inner = true;

                assert!(
                    link >= 0.0,
                    "inner node {} encoded as {}, which is negative",
                    index,
                    link
                );
                assert_eq!(link as u32, node.entry_index);
            }
        }

        assert!(saw_leaf && saw_inner, "cube BVH should have both node kinds");
        assert!(
            saw_shape_zero_leaf,
            "expected a leaf for shape 0, which is the -0.0 trap case"
        );
    }

    /// Packed node bounds must be padded outward, never inward: shrinking a bound
    /// would cut off triangles that genuinely lie inside it.
    ///
    /// Only inner nodes are checked, because the `bvh` crate documents a leaf's
    /// bounding box as undefined and the packer intentionally leaves it zeroed.
    #[test]
    fn gpu_node_bounds_are_padded_outward() {
        let mesh = cube_mesh();
        let accel = Accel::build(&mesh).expect("cube BVH should build");
        let gpu = accel.to_gpu();

        assert!(accel.bounds_padding > 0.0, "padding must be positive");

        for (index, node) in accel.nodes.iter().enumerate() {
            if node.is_leaf() {
                continue;
            }

            let base = index * TEXELS_PER_NODE * FLOATS_PER_TEXEL;

            for component in 0..3 {
                let packed_min = gpu.node_texels[base + component];
                let packed_max = gpu.node_texels[base + 4 + component];

                assert!(
                    packed_min <= node.aabb.min[component],
                    "node {} min component {} was not padded outward",
                    index,
                    component
                );
                assert!(
                    packed_max >= node.aabb.max[component],
                    "node {} max component {} was not padded outward",
                    index,
                    component
                );
            }
        }
    }

    /// The shader's triangle test must use the same edge tolerance as this module's mirror.
    ///
    /// Setup: `TRIANGLE_EDGE_TOLERANCE` from this module, and the text of `gem.frag`. Test: look
    /// for the constant declared with this value, and for `hitTriangle`'s two bounds checks
    /// written with it. Verifies the shader and the mirror accept exactly the same hits, so
    /// `rays_through_shared_edges_and_vertices_never_slip_through` (which runs the mirror)
    /// speaks for the shader. If only one side had the tolerance, the GPU would show edge
    /// cracks that no host test could see.
    #[test]
    fn shader_triangle_edge_tolerance_matches_the_mirror() {
        let shader = include_str!("shaders/gem.frag");

        assert!(
            shader.contains(&format!(
                "const float TRIANGLE_EDGE_TOLERANCE = {:e};",
                TRIANGLE_EDGE_TOLERANCE
            )),
            "gem.frag must declare TRIANGLE_EDGE_TOLERANCE = {:e}",
            TRIANGLE_EDGE_TOLERANCE
        );
        assert!(
            shader.contains("if (u < -TRIANGLE_EDGE_TOLERANCE || u > 1.0 + TRIANGLE_EDGE_TOLERANCE) {")
                && shader.contains(
                    "if (v < -TRIANGLE_EDGE_TOLERANCE || u + v > 1.0 + TRIANGLE_EDGE_TOLERANCE) {"
                ),
            "hitTriangle in gem.frag must bound u and u + v with the edge tolerance"
        );
    }

    /// The shader must unwrap texel indices with the same texture width the packer uses.
    ///
    /// Setup: `DATA_TEXTURE_WIDTH` from this module, and the text of `gem.frag`. The shader's
    /// `fetchTexel` turns a linear texel index into a column and a row with a bitwise AND and
    /// a right shift by two compile-time constants, rather than a modulo and a division by a
    /// width uniform, because it runs thousands of times per pixel and GPUs have no native
    /// integer division.
    ///
    /// Test: require the width to be a power of two (a mask and a shift only work then), then
    /// look for the two constants written from it, and for `fetchTexel` actually using them.
    ///
    /// Verifies the mask is `width - 1` and the shift is `log2(width)`. A mismatch would not
    /// fail loudly: the packer would lay texels out in rows of one width while the shader read
    /// rows of another, so every fetch beyond the first row would return the wrong texel,
    /// giving garbage geometry or a traversal that never ends (which WebGL cannot interrupt).
    /// Worse, the bundled stone would hide it completely, because its 166 triangles (498
    /// texels) and 496 BVH nodes (992 texels) each fit in the first row of 1024.
    ///
    /// This replaces the check the missing `tests/shaders.rs` used to make.
    #[test]
    fn shader_data_texture_width_matches_the_packer() {
        let shader = include_str!("shaders/gem.frag");

        assert!(
            DATA_TEXTURE_WIDTH.is_power_of_two(),
            "DATA_TEXTURE_WIDTH is {}, but the shader's mask and shift need a power of two",
            DATA_TEXTURE_WIDTH
        );

        let mask = format!(
            "const int DATA_TEXTURE_WIDTH_MASK = {};",
            DATA_TEXTURE_WIDTH - 1
        );
        let shift = format!(
            "const int DATA_TEXTURE_WIDTH_SHIFT = {};",
            DATA_TEXTURE_WIDTH.trailing_zeros()
        );

        assert!(shader.contains(&mask), "gem.frag must declare {}", mask);
        assert!(shader.contains(&shift), "gem.frag must declare {}", shift);

        // The constants are only half the contract; the lookup must be built from them.
        assert!(
            shader.contains("index & DATA_TEXTURE_WIDTH_MASK")
                && shader.contains("index >> DATA_TEXTURE_WIDTH_SHIFT"),
            "fetchTexel in gem.frag must unwrap its index with the width mask and shift"
        );
    }
}
