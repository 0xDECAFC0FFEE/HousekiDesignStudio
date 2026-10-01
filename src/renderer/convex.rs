//! The stone as the intersection of its facet planes: a fast exit test for the interior march.
//!
//! A ray inside a convex stone leaves it through the nearest of the facet planes it is heading
//! out of. Finding that plane is one dot-product pair per facet, with no hierarchy, no triangle
//! test and no texture fetch that differs between neighbouring pixels. The deterministic
//! renderer's interior march used to walk the BVH at every bounce of every channel, which was
//! nearly all of a frame (measured 2026-09-27 on an M1 Pro at 1400x1400, 15 bounces, 3
//! channels: 125.7 ms a frame, of which one camera ray per pixel was 1.8 ms).
//!
//! The BVH stays, for three reasons. Camera rays still use it, because the wireframe needs the
//! triangle a pixel struck. The ported LuxCore path uses it. And it is the fallback whenever
//! the stone is not convex: `FacetPlanes::from_mesh` returns `None` then, the shader is told
//! there are no planes, and every trace goes through the BVH as before. Concave fantasy facets
//! (T-0036) therefore lose nothing, and convexity is checked rather than assumed.
//!
//! `FacetPlanes::exit` is the reference implementation `exitConvex` in `gem.frag` mirrors, and
//! the tests check it against the BVH's own trace on the shipped stones.

use crate::mesh::Mesh;
use nalgebra::{Point3, Vector3, Vector4};

/// How far, in world units (the stone is scaled to unit radius), a vertex may lie outside
/// another facet's plane, or off its own, and the stone still count as convex.
///
/// Well above the float noise of a welded, conditioned mesh (around 1e-6), and well below
/// anything a real concave facet produces: a concave cut dips its facets by a visible fraction
/// of the stone, thousands of times this. Matches `SURFACE_EPSILON` in `gem.frag`, the nudge that
/// starts every bounce inside the surface, so a stone accepted here can never have a vertex
/// further outside a plane than the march already steps.
pub const CONVEXITY_TOLERANCE: f32 = 1e-4;

/// Most planes the shader's exit loop can walk. Must match `MAX_FACET_PLANES` in `gem.frag`;
/// a test enforces that. A stone with more facets than this uses the BVH. GemCad designs run to
/// a few hundred facets at most.
pub const MAX_FACET_PLANES: usize = 1024;

/// The plane of every facet, indexed by facet id: `(n.x, n.y, n.z, d)` with `n` the unit
/// outward normal and `d` its offset, so a point `p` is inside the plane when `n . p <= d`.
#[derive(Debug, Clone, PartialEq)]
pub struct FacetPlanes {
    pub planes: Vec<Vector4<f32>>,
}

/// Where a ray from inside leaves the stone: the distance along it and the facet it crosses.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Exit {
    pub distance: f32,
    pub facet: u32,
    pub outward_normal: Vector3<f32>,
}

impl FacetPlanes {
    /// The planes of a conditioned mesh, or `None` when the stone is not convex (or has more
    /// facets than the shader walks), so the renderer falls back to the BVH.
    ///
    /// Each facet's normal is `Mesh::facet_normals`' average over its triangles, and its offset
    /// the mean of `n . v` over its triangles' vertices. The stone is convex when every vertex
    /// is inside every plane to within `CONVEXITY_TOLERANCE`, and each facet flat when its own
    /// vertices are on its plane to within the same.
    pub fn from_mesh(mesh: &Mesh) -> Option<FacetPlanes> {
        let facet_count = mesh.facet_count as usize;

        if facet_count == 0 || facet_count > MAX_FACET_PLANES {
            return None;
        }

        let normals = mesh.facet_normals();
        let mut offset_sums = vec![0.0f64; facet_count];
        let mut offset_counts = vec![0usize; facet_count];

        for (index, triangle) in mesh.triangles.iter().enumerate() {
            let facet = mesh.facet_of_triangle[index] as usize;

            for &vertex in triangle {
                offset_sums[facet] += normals[facet].dot(&mesh.positions[vertex as usize].coords) as f64;
                offset_counts[facet] += 1;
            }
        }

        let planes: Vec<Vector4<f32>> = (0..facet_count)
            .map(|facet| {
                let n = normals[facet];
                let d = (offset_sums[facet] / offset_counts[facet].max(1) as f64) as f32;

                Vector4::new(n.x, n.y, n.z, d)
            })
            .collect();

        // Flatness: each facet's own vertices lie on its plane.
        for (index, triangle) in mesh.triangles.iter().enumerate() {
            let plane = planes[mesh.facet_of_triangle[index] as usize];

            for &vertex in triangle {
                if signed_distance(plane, mesh.positions[vertex as usize]).abs() > CONVEXITY_TOLERANCE {
                    return None;
                }
            }
        }

        // Convexity: every vertex lies inside every plane.
        for plane in &planes {
            if plane.xyz().norm() < 0.5 {
                return None;
            }

            for position in &mesh.positions {
                if signed_distance(*plane, *position) > CONVEXITY_TOLERANCE {
                    return None;
                }
            }
        }

        Some(FacetPlanes { planes })
    }

    /// Where a ray starting inside the stone leaves it, mirroring `exitConvex` in `gem.frag`.
    ///
    /// The ray leaves through the nearest plane it is heading out of (`n . direction > 0`).
    /// Planes it is heading into cannot be its exit, which is the same side rule the BVH's
    /// triangle test applies to a ray from inside: the facet a bounce just left faces against the
    /// reflected ray, so it is never re-hit. Hits at or below `t_min` are skipped like the BVH's,
    /// so a march that float error has put a hair outside one plane leaves through the next.
    pub fn exit(&self, origin: Point3<f32>, direction: Vector3<f32>, t_min: f32) -> Option<Exit> {
        let mut best: Option<Exit> = None;
        let mut best_distance = f32::INFINITY;

        for (facet, plane) in self.planes.iter().enumerate() {
            let normal = plane.xyz();
            let along = normal.dot(&direction);

            if along > 0.0 {
                let distance = (plane.w - normal.dot(&origin.coords)) / along;

                if distance > t_min && distance < best_distance {
                    best_distance = distance;
                    best = Some(Exit {
                        distance,
                        facet: facet as u32,
                        outward_normal: normal,
                    });
                }
            }
        }

        best
    }

    /// The planes as the RGBA32F texels of a `len() x 1` data texture, one texel per facet id.
    pub fn texels(&self) -> Vec<f32> {
        self.planes
            .iter()
            .flat_map(|plane| [plane.x, plane.y, plane.z, plane.w])
            .collect()
    }

    pub fn len(&self) -> usize {
        self.planes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.planes.is_empty()
    }
}

/// How far `point` lies outside `plane`: positive outside, negative inside.
fn signed_distance(plane: Vector4<f32>, point: Point3<f32>) -> f32 {
    plane.xyz().dot(&point.coords) - plane.w
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accel::{Accel, RaySide};

    /// The stones the page ships, conditioned as the page conditions them. Mirrors the helper in
    /// accel.rs's tests.
    fn conditioned_stone(text: &str) -> Mesh {
        let geometry = crate::loader::load_obj_text(text).expect("shipped stone must load");
        let (mut mesh, _) = Mesh::build(&geometry.positions, &geometry.triangles, 1e-5);

        mesh.center_and_scale(1.0);
        mesh.reorient_axis_to_y(crate::mesh::ModelAxis::PlusZ);

        mesh
    }

    const SHIPPED_STONES: [(&str, &str); 2] = [
        ("hex_cut_v2", include_str!("../resources/hex_cut_v2.obj")),
        ("oval_cut", include_str!("../resources/oval_cut.obj")),
    ];

    /// xorshift64*, as in accel.rs's tests: reproducible without an RNG dependency.
    struct Rng(u64);

    impl Rng {
        fn next_f32(&mut self) -> f32 {
            let mut x = self.0;

            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;

            ((x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 40) as f32) / (1u32 << 24) as f32
        }

        fn next_signed(&mut self) -> f32 {
            self.next_f32() * 2.0 - 1.0
        }

        fn unit_vector(&mut self) -> Vector3<f32> {
            loop {
                let candidate = Vector3::new(self.next_signed(), self.next_signed(), self.next_signed());
                let length = candidate.norm();

                if length > 0.1 && length <= 1.0 {
                    return candidate / length;
                }
            }
        }
    }

    /// Both shipped stones are convex, so both get planes, one per facet.
    ///
    /// Setup: each shipped stone, conditioned as the page conditions it. Test: build its planes.
    /// Verifies the fast path is actually taken for the stones people see first; if the
    /// tolerance were too tight the page would silently keep the slow BVH march.
    #[test]
    fn the_shipped_stones_are_convex_and_get_one_plane_per_facet() {
        for (name, text) in SHIPPED_STONES {
            let mesh = conditioned_stone(text);
            let planes = FacetPlanes::from_mesh(&mesh)
                .unwrap_or_else(|| panic!("{} should be accepted as convex", name));

            assert_eq!(planes.len(), mesh.facet_count as usize, "{}", name);
        }
    }

    /// A stone with a dent is refused, so it falls back to the BVH.
    ///
    /// Setup: the hex cut, with one vertex pushed towards the centre by 5% of the stone's
    /// radius, which makes the facets around it concave (and no longer flat). Test: build its
    /// planes. Verifies convexity is checked rather than assumed: the plane march would draw a
    /// concave stone as its convex hull.
    #[test]
    fn a_dented_stone_is_refused() {
        let mut mesh = conditioned_stone(SHIPPED_STONES[0].1);
        let dented = mesh.positions[0].coords * 0.95;

        mesh.positions[0] = Point3::from(dented);

        assert!(FacetPlanes::from_mesh(&mesh).is_none());
    }

    /// The concave test stones load closed, keep their volume, and are refused as convex.
    ///
    /// Setup: the two meshes `tests/fixtures/make_concave_fixtures.py` writes, a bar with two V
    /// grooves along its top (whose end caps are 12-corner concave polygons, one `f` line each)
    /// and a ring torus, both in millimetres and both wound outward as written.
    ///
    /// Test: load and condition each as the page does, and build its planes.
    ///
    /// Verifies the fixtures the concave renderer is tested on are what they claim to be. Each
    /// is watertight after welding, so the renderers see one closed surface; the bar's volume,
    /// read before normalisation, is exactly its 36 mm^2 profile times its 6 mm length, which a
    /// fan triangulation of its caps would still get right (signed areas cancel) but only
    /// because the overlapping triangles cancel -- so its caps are also checked to be covered by
    /// triangles all facing the same way; neither was wound inward, so the conditioner flipped
    /// nothing. And `from_mesh` refuses both, so the renderer draws them with the concave
    /// program, never the convex plane march.
    #[test]
    fn the_concave_test_stones_load_closed_and_are_not_convex() {
        let stones = [
            ("concave_grooved_bar", include_str!("../../tests/fixtures/concave_grooved_bar.obj"), Some(216.0)),
            ("concave_torus", include_str!("../../tests/fixtures/concave_torus.obj"), None),
        ];

        for (name, text, volume) in stones {
            let geometry = crate::loader::load_obj_text(text).expect("fixture loads");
            let (mut mesh, diagnostics) = Mesh::build(&geometry.positions, &geometry.triangles, 1e-5);

            assert!(diagnostics.is_watertight(), "{}: {:?}", name, diagnostics);
            assert!(!diagnostics.winding_was_flipped, "{} was written wound outward", name);
            assert_eq!(diagnostics.degenerate_dropped, 0, "{}", name);

            if let Some(volume) = volume {
                assert!(
                    (diagnostics.signed_volume - volume).abs() < 1e-3,
                    "{}: volume {} mm^3, expected {}",
                    name,
                    diagnostics.signed_volume,
                    volume
                );
            }

            // Every triangle of the grooved bar's end caps (the faces normal to y) faces the
            // same way as its cap: a fanned cap would have backwards triangles over the grooves.
            for triangle in mesh.triangles.iter().filter(|_| name == "concave_grooved_bar") {
                let [a, b, c] = triangle.map(|v| mesh.positions[v as usize].coords);
                let normal = (b - a).cross(&(c - a));

                if normal.x.abs() < 1e-6 && normal.z.abs() < 1e-6 && normal.y.abs() > 0.0 {
                    let outward = if a.y > 3.0 { 1.0 } else { -1.0 };

                    assert!(normal.y * outward > 0.0, "{}: a cap triangle faces inward", name);
                }
            }

            mesh.center_and_scale(1.0);
            mesh.reorient_axis_to_y(crate::mesh::ModelAxis::PlusZ);

            assert!(FacetPlanes::from_mesh(&mesh).is_none(), "{} was accepted as convex", name);
        }
    }

    /// From inside a shipped stone, the plane exit agrees with the BVH's trace.
    ///
    /// Setup: each shipped stone; 20,000 rays from random points well inside it (at most 0.8
    /// of the way from the centre to the surface along a random direction) in random
    /// directions. Test: trace each as a ray from inside with the BVH (`Accel::trace`, what the
    /// shader's `traceScene` mirrors) and with `FacetPlanes::exit`. Verifies the BVH's exit point
    /// lies within 1e-4 world units of the plane the fast exit chose.
    ///
    /// Measured off the plane rather than along the ray. At an edge both facets are hit at the
    /// same point and each tracer breaks the tie its own way (6 of 20,000 rays on the hex cut),
    /// and on a grazing ray a facet flat only to within float noise puts the two exits a few
    /// 1e-4 apart along the ray while they sit within 1e-5 of the same surface (2 on the oval).
    #[test]
    fn plane_exit_agrees_with_the_bvh_from_inside_the_shipped_stones() {
        const RAYS: usize = 20_000;

        for (name, text) in SHIPPED_STONES {
            let mesh = conditioned_stone(text);
            let accel = Accel::build(&mesh).expect("shipped stone BVH builds");
            let planes = FacetPlanes::from_mesh(&mesh).expect("shipped stone is convex");
            let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
            let mut disagreements = Vec::new();

            for _ in 0..RAYS {
                // A point inside: walk from the centre towards the surface and stop short of it.
                let towards = rng.unit_vector();
                let surface = accel
                    .trace(Point3::origin(), towards, 0.0, f32::INFINITY, RaySide::Inside)
                    .expect("a ray from the centre always leaves a closed stone")
                    .distance;
                let origin = Point3::from(towards * surface * 0.8 * rng.next_f32());
                let direction = rng.unit_vector();

                let bvh = accel.trace(origin, direction, 1e-6, f32::INFINITY, RaySide::Inside);
                let fast = planes.exit(origin, direction, 1e-6);

                match (bvh, fast) {
                    // The BVH's exit point lies on the plane the fast exit chose: the same
                    // facet, or a tie at an edge where either facet is a correct exit.
                    (Some(slow), Some(fast))
                        if signed_distance(
                            planes.planes[fast.facet as usize],
                            origin + direction * slow.distance,
                        )
                        .abs()
                            < 1e-4 => {}
                    _ => disagreements.push((origin, direction, bvh.map(|h| h.distance), fast.map(|h| h.distance))),
                }
            }

            assert!(
                disagreements.is_empty(),
                "{}: {} of {} rays disagreed; first: {:?}",
                name,
                disagreements.len(),
                RAYS,
                disagreements.first()
            );
        }
    }

    /// A reflected ray never exits through the facet it just reflected off, with no minimum
    /// distance at all.
    ///
    /// Setup: each shipped stone; for every facet, a ray from the centre to a point on it,
    /// reflected there about the facet's normal and nudged back inside by the shader's
    /// `SURFACE_EPSILON`, as `traceInterior` does. Test: exit it with `t_min` 0. Verifies the
    /// side rule alone (only planes the ray heads out of count) keeps the facet just left out,
    /// the property the BVH march relies on too.
    #[test]
    fn a_bounce_never_exits_through_the_facet_it_just_left() {
        for (name, text) in SHIPPED_STONES {
            let mesh = conditioned_stone(text);
            let planes = FacetPlanes::from_mesh(&mesh).expect("shipped stone is convex");

            for (index, triangle) in mesh.triangles.iter().enumerate() {
                let facet = mesh.facet_of_triangle[index];
                let normal = planes.planes[facet as usize].xyz();
                let [a, b, c] = triangle.map(|v| mesh.positions[v as usize].coords);
                let on_facet = (a + b + c) / 3.0;
                let incoming = on_facet.normalize();
                let reflected = incoming - normal * 2.0 * incoming.dot(&normal);
                let origin = Point3::from(on_facet - normal * 1e-4);

                let exit = planes.exit(origin, reflected, 0.0).expect("every bounce leaves");

                assert_ne!(exit.facet, facet, "{}: triangle {} re-hit its own facet", name, index);
            }
        }
    }

    /// The loop bound in the shader is this module's.
    ///
    /// Setup: the text of `gem.frag`. Test: look for the constant's declaration. Verifies the
    /// two cannot drift: a larger bound here than in the shader would let the shader silently
    /// ignore the last planes of a large stone, drawing holes where those facets are.
    #[test]
    fn shader_plane_bound_matches_this_module() {
        let shader = include_str!("shaders/gem.frag");

        assert!(shader.contains(&format!("const int MAX_FACET_PLANES = {};", MAX_FACET_PLANES)));
    }
}
