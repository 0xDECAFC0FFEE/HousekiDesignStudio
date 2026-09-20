//! Mesh conditioning for gem ray tracing.
//!
//! A gem's appearance is produced almost entirely by light bouncing *inside* the
//! solid, so the internal ray march is far less forgiving than ordinary surface
//! shading:
//!
//! * Vertices must be welded, otherwise hairline cracks between facets let
//!   internal rays escape and the stone renders with black speckles.
//! * Winding must be consistently outward, because the refraction direction and
//!   the total-internal-reflection test both depend on the sign of the normal.
//! * Facets must be identified as groups of coplanar triangles, so that curved
//!   and concave fantasy facets can later carry smooth normals within a facet
//!   without smoothing across a facet boundary.
//!
//! The geometric primitives come from `nalgebra` and the `bvh` crate's `Aabb`;
//! what lives here is only the gem-specific conditioning those crates do not
//! provide. None of it touches WebGL, so all of it is unit tested on the host.

use bvh::aabb::Aabb;
use nalgebra::{Point3, Rotation3, Vector3};
use std::collections::HashMap;
use std::f32::consts::FRAC_PI_2;

pub type Bounds = Aabb<f32, 3>;

/// A triangle soup with welded, shared vertices.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mesh {
    pub positions: Vec<Point3<f32>>,
    pub triangles: Vec<[u32; 3]>,
    /// Facet index per triangle, parallel to `triangles`. Coplanar triangles that
    /// are connected across a shared edge belong to the same facet.
    pub facet_of_triangle: Vec<u32>,
    pub facet_count: u32,
}

/// Diagnostics about how well formed the mesh is.
///
/// Reported by `GemApp::diagnostics_text` (read it from the browser console as
/// `gemApp.diagnostics_text()`; the page's stats box was removed), because a gem model that
/// fails these checks renders with visible artifacts whose cause is almost impossible to guess
/// from the image alone: a hole in the surface shows up as scattered black pixels, not as a
/// hole.
#[derive(Debug, Clone, PartialEq)]
pub struct MeshDiagnostics {
    pub vertex_count: usize,
    pub triangle_count: usize,
    pub facet_count: u32,
    /// Vertices removed by welding.
    pub welded_away: usize,
    /// Triangles dropped for having zero area.
    pub degenerate_dropped: usize,
    /// Volume after orientation was fixed, so positive for a well-formed solid.
    pub signed_volume: f32,
    /// True if the winding had to be reversed, meaning the source file's normals
    /// pointed inward.
    pub winding_was_flipped: bool,
    /// Edges used by exactly two triangles in opposite directions, as an
    /// orientable closed surface requires.
    pub manifold_edges: usize,
    /// Edges used by exactly one triangle. Non-zero means the surface has holes.
    pub boundary_edges: usize,
    /// Edges used by three or more triangles, or twice in the same direction.
    pub non_manifold_edges: usize,
}

impl MeshDiagnostics {
    /// A mesh is watertight when every edge is shared by exactly two oppositely
    /// wound triangles. Only watertight meshes trace reliably.
    pub fn is_watertight(&self) -> bool {
        self.boundary_edges == 0 && self.non_manifold_edges == 0
    }
}

/// Which model-space axis is the stone's optical axis (table-to-culet).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelAxis {
    PlusX,
    PlusY,
    PlusZ,
}

/// The rotation `Mesh::reorient_axis_to_y` applies for a given optical axis: takes that axis
/// to world +Y.
///
/// Pulled out as its own function, rather than left inline in `reorient_axis_to_y`, so
/// `Mesh::facet_normals_in_file_frame` can invert it -- `Rotation3` is a proper rotation by
/// construction, so the inverse is well defined and exactly undoes the forward turn.
pub fn axis_to_y_rotation(model_axis: ModelAxis) -> Rotation3<f32> {
    match model_axis {
        ModelAxis::PlusY => Rotation3::identity(),
        // -90 degrees about X sends +Z to +Y.
        ModelAxis::PlusZ => Rotation3::from_axis_angle(&Vector3::x_axis(), -FRAC_PI_2),
        // +90 degrees about Z sends +X to +Y.
        ModelAxis::PlusX => Rotation3::from_axis_angle(&Vector3::z_axis(), FRAC_PI_2),
    }
}

impl Mesh {
    /// Builds a render-ready mesh from raw triangle soup.
    ///
    /// Runs the full conditioning pipeline: weld, drop degenerates, force outward
    /// winding, then group coplanar triangles into facets.
    ///
    /// `weld_epsilon_scale` is relative to the model's bounding box diagonal, so
    /// the tolerance adapts to models authored at any scale.
    pub fn build(
        positions: &[Point3<f32>],
        triangles: &[[u32; 3]],
        weld_epsilon_scale: f32,
    ) -> (Mesh, MeshDiagnostics) {
        let original_vertex_count = positions.len();

        let mut bounds = Bounds::empty();

        for p in positions {
            bounds.grow_mut(p);
        }

        // Absolute weld tolerance derived from model size, with a fallback for a
        // degenerate (zero-size) input so we never scale by zero.
        let diagonal = if positions.is_empty() {
            0.0
        } else {
            bounds.size().norm()
        };
        let epsilon = if diagonal > 0.0 {
            diagonal * weld_epsilon_scale
        } else {
            weld_epsilon_scale
        };

        let (welded_positions, remap) = weld_vertices(positions, epsilon);

        // Re-index triangles onto the welded vertices, dropping any triangle that
        // collapsed to a line or a point in the process.
        let mut kept_triangles = Vec::with_capacity(triangles.len());
        let mut degenerate_dropped = 0usize;

        for triangle in triangles {
            let remapped = [
                remap[triangle[0] as usize],
                remap[triangle[1] as usize],
                remap[triangle[2] as usize],
            ];

            let collapsed = remapped[0] == remapped[1]
                || remapped[1] == remapped[2]
                || remapped[2] == remapped[0];

            let zero_area = !collapsed
                && double_area(
                    welded_positions[remapped[0] as usize],
                    welded_positions[remapped[1] as usize],
                    welded_positions[remapped[2] as usize],
                ) <= 0.0;

            if collapsed || zero_area {
                degenerate_dropped += 1;
                continue;
            }

            kept_triangles.push(remapped);
        }

        let mut mesh = Mesh {
            positions: welded_positions,
            triangles: kept_triangles,
            facet_of_triangle: Vec::new(),
            facet_count: 0,
        };

        // Orient outward before grouping facets so facet normals come out outward.
        let winding_was_flipped = mesh.force_outward_winding();
        let signed_volume = mesh.signed_volume();
        let edge_stats = mesh.edge_statistics();

        mesh.rebuild_facets();

        let diagnostics = MeshDiagnostics {
            vertex_count: mesh.positions.len(),
            triangle_count: mesh.triangles.len(),
            facet_count: mesh.facet_count,
            welded_away: original_vertex_count - mesh.positions.len(),
            degenerate_dropped,
            signed_volume,
            winding_was_flipped,
            manifold_edges: edge_stats.manifold,
            boundary_edges: edge_stats.boundary,
            non_manifold_edges: edge_stats.non_manifold,
        };

        (mesh, diagnostics)
    }

    pub fn triangle_positions(&self, index: usize) -> [Point3<f32>; 3] {
        let t = self.triangles[index];

        [
            self.positions[t[0] as usize],
            self.positions[t[1] as usize],
            self.positions[t[2] as usize],
        ]
    }

    /// Outward geometric normal of a triangle, given outward winding.
    pub fn triangle_normal(&self, index: usize) -> Vector3<f32> {
        let [a, b, c] = self.triangle_positions(index);

        (b - a).cross(&(c - a)).normalize()
    }

    pub fn bounds(&self) -> Bounds {
        let mut bounds = Bounds::empty();

        for p in &self.positions {
            bounds.grow_mut(p);
        }

        bounds
    }

    /// Six times the signed volume enclosed by the surface, by the divergence
    /// theorem. Positive when triangles are wound counter-clockwise as seen from
    /// outside.
    ///
    /// This is the orientation test of choice because it is exact for *any*
    /// closed surface, convex or concave. The cheaper "does each normal point
    /// away from the centroid?" test happens to work for this hexagonal cut but
    /// would silently mis-orient the concave facets of a fantasy cut.
    pub fn signed_volume_times_six(&self) -> f32 {
        let mut total = 0.0f64;

        for index in 0..self.triangles.len() {
            let [a, b, c] = self.triangle_positions(index);

            // Accumulate in f64: for a thin shell the per-triangle terms largely
            // cancel, and f32 summation loses significant precision.
            total += f64::from(a.coords.dot(&b.coords.cross(&c.coords)));
        }

        total as f32
    }

    pub fn signed_volume(&self) -> f32 {
        self.signed_volume_times_six() / 6.0
    }

    /// Reverses every triangle's winding if the surface encloses negative volume.
    /// Returns whether a flip happened.
    pub fn force_outward_winding(&mut self) -> bool {
        if self.signed_volume_times_six() >= 0.0 {
            return false;
        }

        for triangle in &mut self.triangles {
            triangle.swap(1, 2);
        }

        true
    }

    /// Assigns a facet id to every triangle by flood filling across shared edges,
    /// crossing an edge only when both triangles lie in the same plane.
    ///
    /// Requiring adjacency, rather than grouping by plane alone, matters for
    /// fantasy cuts where two distinct facets can happen to be coplanar; those
    /// must stay separate facets.
    pub fn rebuild_facets(&mut self) {
        let triangle_count = self.triangles.len();

        self.facet_of_triangle = vec![u32::MAX; triangle_count];

        let normals: Vec<Vector3<f32>> =
            (0..triangle_count).map(|i| self.triangle_normal(i)).collect();
        let neighbors = self.build_edge_neighbors();

        // Roughly 0.1 degrees of normal deviation, plus a plane-offset tolerance
        // relative to model size.
        const NORMAL_COS_TOLERANCE: f32 = 0.999_998;
        let plane_tolerance = (self.bounds().size().norm() * 1e-5).max(1e-6);

        let mut next_facet = 0u32;
        let mut stack: Vec<usize> = Vec::new();

        for seed in 0..triangle_count {
            if self.facet_of_triangle[seed] != u32::MAX {
                continue;
            }

            let facet_id = next_facet;
            next_facet += 1;

            self.facet_of_triangle[seed] = facet_id;
            stack.push(seed);

            while let Some(current) = stack.pop() {
                let current_normal = normals[current];
                let current_point = self.triangle_positions(current)[0];

                for &neighbor in &neighbors[current] {
                    if self.facet_of_triangle[neighbor] != u32::MAX {
                        continue;
                    }

                    if current_normal.dot(&normals[neighbor]) < NORMAL_COS_TOLERANCE {
                        continue;
                    }

                    // Matching direction is not enough: the neighbour must lie in
                    // the same plane, not a parallel one.
                    let neighbor_point = self.triangle_positions(neighbor)[0];
                    let offset = (neighbor_point - current_point).dot(&current_normal).abs();

                    if offset > plane_tolerance {
                        continue;
                    }

                    self.facet_of_triangle[neighbor] = facet_id;
                    stack.push(neighbor);
                }
            }
        }

        self.facet_count = next_facet;
    }

    /// Translates the mesh so its bounding box is centred on the origin, then
    /// scales it so the farthest vertex sits at `target_radius`.
    ///
    /// The ray tracer's surface-offset epsilons and absorption distances are all
    /// in world units, so normalising keeps those constants meaningful whatever
    /// scale the source file used.
    ///
    /// Returns what it did, `(center, scale)`: each position `p` became `(p - center) * scale`.
    /// The page needs that to draw over the stone in the model file's own coordinates
    /// (`FileFrame` in lib.rs).
    pub fn center_and_scale(&mut self, target_radius: f32) -> (Vector3<f32>, f32) {
        let center = self.bounds().center();

        for p in &mut self.positions {
            *p -= center.coords;
        }

        let max_radius = self
            .positions
            .iter()
            .fold(0.0f32, |acc, p| acc.max(p.coords.norm()));

        if max_radius > 0.0 {
            let scale = target_radius / max_radius;

            for p in &mut self.positions {
                *p = Point3::from(p.coords * scale);
            }

            return (center.coords, scale);
        }

        (center.coords, 1.0)
    }

    /// Rotates the mesh so the given model-space axis points along world +Y.
    ///
    /// Faceting software conventionally puts a stone's optical axis along +Z
    /// (table at the top of the Z range, culet at the bottom), while the renderer
    /// works in a Y-up world so the orbit camera and the environment map's
    /// horizon behave naturally. `hex_cut_v2.obj` follows the +Z convention.
    ///
    /// Uses `Rotation3`, which is a proper rotation by construction, so winding
    /// and outward normals survive: a reflection here would silently turn the
    /// stone inside out.
    pub fn reorient_axis_to_y(&mut self, model_axis: ModelAxis) {
        let rotation = axis_to_y_rotation(model_axis);

        for p in &mut self.positions {
            *p = rotation * *p;
        }
    }

    /// The outward normal of every facet, indexed by facet id (0..facet_count), at this
    /// mesh's current orientation.
    ///
    /// A facet can have several triangles, and `rebuild_facets` only ever groups triangles
    /// whose normals already agree to within its own `NORMAL_COS_TOLERANCE`, so in principle
    /// any one of them would do. Averaging the unit normals of every triangle in the facet and
    /// renormalising, rather than trusting whichever triangle happens to be first, keeps the
    /// reported normal insensitive to triangle order and slightly more robust to the float
    /// noise a fan-triangulated facet's individual triangles can carry.
    pub fn facet_normals(&self) -> Vec<Vector3<f32>> {
        let mut sums = vec![Vector3::zeros(); self.facet_count as usize];

        for index in 0..self.triangles.len() {
            let facet = self.facet_of_triangle[index] as usize;
            sums[facet] += self.triangle_normal(index);
        }

        sums.into_iter()
            .map(|sum| {
                let length = sum.norm();

                if length > 0.0 {
                    sum / length
                } else {
                    // Only reachable for a facet with no triangles, which rebuild_facets never
                    // produces (every facet id comes from a seed triangle it actually visited).
                    // Kept as a safe fallback rather than a panic or a NaN that would silently
                    // poison whatever compares against it.
                    Vector3::zeros()
                }
            })
            .collect()
    }

    /// `facet_normals()`, rotated back into the FILE's own frame -- undoing
    /// `reorient_axis_to_y(model_axis)` -- regardless of what frame `self` is currently in.
    ///
    /// `reorient_axis_to_y` turns the model's own optical axis onto the renderer's world +Y
    /// for viewing, which means a normal read off the mesh afterwards is no longer in the
    /// convention a faceting file (and `design.js`'s `GemCadDesign.normalOf`) uses: optical
    /// axis on +Z, azimuth from +Y towards +X. `axis_to_y_rotation` is a proper rotation, so
    /// its inverse undoes that exactly, with no separate un-rotated copy of the mesh kept
    /// around. `GemApp::build_model` calls this once at load time so the page can match a
    /// clicked facet's normal against a loaded design's tiers with no knowledge of
    /// `model_axis` at all.
    pub fn facet_normals_in_file_frame(&self, model_axis: ModelAxis) -> Vec<Vector3<f32>> {
        let inverse = axis_to_y_rotation(model_axis).inverse();

        self.facet_normals().iter().map(|n| inverse * n).collect()
    }

    /// For each triangle, which of its edges and corners lie on the boundary of its facet, as
    /// a bitmask for the shader's wireframe overlay.
    ///
    /// Bits 0, 1 and 2 are the edges a->b, b->c and c->a, in the triangle's own vertex order.
    /// An edge is on the boundary when a triangle of a *different* facet shares it, or when no
    /// other triangle shares it at all (an open edge of a mesh with a hole). An edge shared
    /// only with triangles of the same facet is a triangulation diagonal inside the facet, and
    /// is not drawn.
    ///
    /// Bits 3, 4 and 5 are the corners a, b and c: set when that vertex is an endpoint of any
    /// boundary edge anywhere in the mesh. The shader draws a small disc there too, because a
    /// fan-triangulated facet can have a sliver triangle touching a facet corner whose own
    /// edges are all diagonals; without the corner bit, the line along the neighbouring
    /// boundary edge would stop short at that sliver, leaving a notch in every such corner.
    pub fn facet_boundary_masks(&self) -> Vec<u8> {
        let mut edge_users: HashMap<(u32, u32), Vec<usize>> = HashMap::new();

        for (index, triangle) in self.triangles.iter().enumerate() {
            for corner in 0..3 {
                let key = undirected_edge(triangle[corner], triangle[(corner + 1) % 3]);

                edge_users.entry(key).or_default().push(index);
            }
        }

        let facet_of = |index: usize| self.facet_of_triangle.get(index).copied();
        let mut boundary_vertices = vec![false; self.positions.len()];
        let mut masks = vec![0u8; self.triangles.len()];

        for (index, triangle) in self.triangles.iter().enumerate() {
            for corner in 0..3 {
                let from = triangle[corner];
                let to = triangle[(corner + 1) % 3];
                let users = &edge_users[&undirected_edge(from, to)];
                let others: Vec<usize> = users.iter().copied().filter(|&u| u != index).collect();
                let on_boundary =
                    others.is_empty() || others.iter().any(|&other| facet_of(other) != facet_of(index));

                if on_boundary {
                    masks[index] |= 1 << corner;
                    boundary_vertices[from as usize] = true;
                    boundary_vertices[to as usize] = true;
                }
            }
        }

        for (index, triangle) in self.triangles.iter().enumerate() {
            for corner in 0..3 {
                if boundary_vertices[triangle[corner] as usize] {
                    masks[index] |= 1 << (3 + corner);
                }
            }
        }

        masks
    }

    /// For each triangle, the indices of triangles sharing one of its edges.
    fn build_edge_neighbors(&self) -> Vec<Vec<usize>> {
        let mut edge_users: HashMap<(u32, u32), Vec<usize>> = HashMap::new();

        for (index, triangle) in self.triangles.iter().enumerate() {
            for corner in 0..3 {
                let key = undirected_edge(triangle[corner], triangle[(corner + 1) % 3]);

                edge_users.entry(key).or_default().push(index);
            }
        }

        let mut neighbors = vec![Vec::new(); self.triangles.len()];

        for users in edge_users.values() {
            for &a in users {
                for &b in users {
                    if a != b && !neighbors[a].contains(&b) {
                        neighbors[a].push(b);
                    }
                }
            }
        }

        neighbors
    }

    fn edge_statistics(&self) -> EdgeStatistics {
        // Count directed uses of each undirected edge, so a properly shared edge
        // (one use per direction) is distinguishable from two identically wound
        // triangles glued together (two uses in the same direction).
        let mut uses: HashMap<(u32, u32), (usize, usize)> = HashMap::new();

        for triangle in &self.triangles {
            for corner in 0..3 {
                let from = triangle[corner];
                let to = triangle[(corner + 1) % 3];
                let entry = uses.entry(undirected_edge(from, to)).or_insert((0, 0));

                if from < to {
                    entry.0 += 1;
                } else {
                    entry.1 += 1;
                }
            }
        }

        let mut stats = EdgeStatistics::default();

        for (forward, backward) in uses.values() {
            match (forward, backward) {
                (1, 1) => stats.manifold += 1,
                (1, 0) | (0, 1) => stats.boundary += 1,
                _ => stats.non_manifold += 1,
            }
        }

        stats
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct EdgeStatistics {
    manifold: usize,
    boundary: usize,
    non_manifold: usize,
}

fn undirected_edge(a: u32, b: u32) -> (u32, u32) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Twice the area of a triangle. Used only as a degeneracy test, so the factor of
/// two is irrelevant.
fn double_area(a: Point3<f32>, b: Point3<f32>, c: Point3<f32>) -> f32 {
    (b - a).cross(&(c - a)).norm()
}

/// Merges vertices closer together than `epsilon`, returning the deduplicated
/// positions and a map from each original index to its index in the new list.
///
/// Uses a spatial hash with cell size `epsilon`, checking the 27 cells around
/// each query point. Searching neighbouring cells (rather than only the vertex's
/// own cell) is what makes this correct: two vertices within `epsilon` can still
/// land in different cells when they straddle a cell boundary, which a plain
/// quantise-and-hash approach would miss.
fn weld_vertices(positions: &[Point3<f32>], epsilon: f32) -> (Vec<Point3<f32>>, Vec<u32>) {
    let mut unique: Vec<Point3<f32>> = Vec::with_capacity(positions.len());
    let mut remap: Vec<u32> = Vec::with_capacity(positions.len());
    let mut cells: HashMap<(i64, i64, i64), Vec<u32>> = HashMap::new();

    // A zero or non-finite epsilon would make cell indices meaningless, so fall
    // back to effectively exact-match welding.
    let cell_size = if epsilon > 0.0 && epsilon.is_finite() {
        epsilon
    } else {
        f32::MIN_POSITIVE
    };
    let epsilon_squared = epsilon * epsilon;

    let cell_of = |p: &Point3<f32>| -> (i64, i64, i64) {
        (
            (p.x / cell_size).floor() as i64,
            (p.y / cell_size).floor() as i64,
            (p.z / cell_size).floor() as i64,
        )
    };

    for position in positions {
        let (cx, cy, cz) = cell_of(position);
        let mut found: Option<u32> = None;

        'search: for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(candidates) = cells.get(&(cx + dx, cy + dy, cz + dz)) {
                        for &candidate in candidates {
                            let delta = unique[candidate as usize] - position;

                            if delta.norm_squared() <= epsilon_squared {
                                found = Some(candidate);
                                break 'search;
                            }
                        }
                    }
                }
            }
        }

        match found {
            Some(existing) => remap.push(existing),
            None => {
                let new_index = unique.len() as u32;

                unique.push(*position);
                cells.entry((cx, cy, cz)).or_default().push(new_index);
                remap.push(new_index);
            }
        }
    }

    (unique, remap)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f32, y: f32, z: f32) -> Point3<f32> {
        Point3::new(x, y, z)
    }

    /// A unit tetrahedron with all four faces wound counter-clockwise as seen
    /// from outside, so its signed volume is +1/6.
    fn outward_tetrahedron() -> (Vec<Point3<f32>>, Vec<[u32; 3]>) {
        let positions = vec![
            p(0.0, 0.0, 0.0),
            p(1.0, 0.0, 0.0),
            p(0.0, 1.0, 0.0),
            p(0.0, 0.0, 1.0),
        ];
        let triangles = vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];

        (positions, triangles)
    }

    /// An axis-aligned unit cube centred on the origin, wound outward: two
    /// triangles per side, so twelve triangles and volume 1.
    fn outward_cube() -> (Vec<Point3<f32>>, Vec<[u32; 3]>) {
        let positions = vec![
            p(-0.5, -0.5, -0.5), // 0
            p(0.5, -0.5, -0.5),  // 1
            p(0.5, 0.5, -0.5),   // 2
            p(-0.5, 0.5, -0.5),  // 3
            p(-0.5, -0.5, 0.5),  // 4
            p(0.5, -0.5, 0.5),   // 5
            p(0.5, 0.5, 0.5),    // 6
            p(-0.5, 0.5, 0.5),   // 7
        ];
        let triangles = vec![
            [0, 3, 2],
            [0, 2, 1], // -Z
            [4, 5, 6],
            [4, 6, 7], // +Z
            [0, 1, 5],
            [0, 5, 4], // -Y
            [3, 7, 6],
            [3, 6, 2], // +Y
            [0, 4, 7],
            [0, 7, 3], // -X
            [1, 2, 6],
            [1, 6, 5], // +X
        ];

        (positions, triangles)
    }

    /// The signed volume of a correctly wound unit tetrahedron must be +1/6.
    /// This pins the sign convention every other orientation test relies on.
    #[test]
    fn signed_volume_of_outward_tetrahedron_is_positive_one_sixth() {
        let (positions, triangles) = outward_tetrahedron();

        let (mesh, _) = Mesh::build(&positions, &triangles, 1e-5);

        assert!(
            (mesh.signed_volume() - 1.0 / 6.0).abs() < 1e-6,
            "expected +1/6, got {}",
            mesh.signed_volume()
        );
    }

    /// The unit cube's volume must be exactly 1, confirming the volume sum works
    /// across many triangles rather than only for a tetrahedron.
    #[test]
    fn signed_volume_of_outward_cube_is_one() {
        let (positions, triangles) = outward_cube();

        let (mesh, diagnostics) = Mesh::build(&positions, &triangles, 1e-5);

        assert!(
            (mesh.signed_volume() - 1.0).abs() < 1e-6,
            "expected 1.0, got {}",
            mesh.signed_volume()
        );
        assert!(!diagnostics.winding_was_flipped, "cube was already outward");
    }

    /// An inward-wound mesh (every triangle reversed) must be detected and
    /// corrected, leaving positive volume and the flip flag set. This is exactly
    /// the situation `hex_cut_v2.obj` presents.
    #[test]
    fn inward_winding_is_detected_and_flipped() {
        let (positions, mut triangles) = outward_tetrahedron();

        for triangle in &mut triangles {
            triangle.swap(1, 2);
        }

        let (mesh, diagnostics) = Mesh::build(&positions, &triangles, 1e-5);

        assert!(diagnostics.winding_was_flipped, "flip should be reported");
        assert!(
            mesh.signed_volume() > 0.0,
            "volume must be positive after fixing, got {}",
            mesh.signed_volume()
        );
    }

    /// After orientation is fixed, every face normal of a convex solid centred on
    /// the origin must point away from the centre. Checked on the cube, where the
    /// expected normals are known exactly.
    #[test]
    fn face_normals_point_outward_after_fixing_winding() {
        let (positions, mut triangles) = outward_cube();

        for triangle in &mut triangles {
            triangle.swap(1, 2);
        }

        let (mesh, _) = Mesh::build(&positions, &triangles, 1e-5);

        for index in 0..mesh.triangles.len() {
            let normal = mesh.triangle_normal(index);
            let [a, b, c] = mesh.triangle_positions(index);
            let centroid = (a.coords + b.coords + c.coords) / 3.0;

            assert!(
                normal.dot(&centroid) > 0.0,
                "triangle {} normal {:?} points inward from centroid {:?}",
                index,
                normal,
                centroid
            );
        }
    }

    /// Duplicated vertices at the same location must collapse to one, with the
    /// faces that referenced them re-indexed onto the survivor. Without this,
    /// facet edges are not truly shared and internal rays leak out of the stone.
    #[test]
    fn welds_coincident_vertices_and_reindexes_faces() {
        // The same tetrahedron, but vertex 0 is listed again as vertex 4 and two
        // faces reference the duplicate instead.
        let positions = vec![
            p(0.0, 0.0, 0.0),
            p(1.0, 0.0, 0.0),
            p(0.0, 1.0, 0.0),
            p(0.0, 0.0, 1.0),
            p(0.0, 0.0, 0.0),
        ];
        let triangles = vec![[0, 2, 1], [4, 1, 3], [4, 3, 2], [1, 2, 3]];

        let (mesh, diagnostics) = Mesh::build(&positions, &triangles, 1e-5);

        assert_eq!(mesh.positions.len(), 4, "duplicate vertex should be removed");
        assert_eq!(diagnostics.welded_away, 1);
        assert!(
            diagnostics.is_watertight(),
            "welded tetrahedron must be watertight: {:?}",
            diagnostics
        );
    }

    /// Vertices closer than the tolerance weld together; vertices clearly beyond
    /// it stay distinct. Guards the tolerance logic in both directions.
    #[test]
    fn weld_respects_epsilon_in_both_directions() {
        let (merged, _) = weld_vertices(&[p(0.0, 0.0, 0.0), p(1e-7, 0.0, 0.0)], 1e-5);

        assert_eq!(merged.len(), 1, "vertices within epsilon must merge");

        let (kept, _) = weld_vertices(&[p(0.0, 0.0, 0.0), p(1e-2, 0.0, 0.0)], 1e-5);

        assert_eq!(kept.len(), 2, "vertices beyond epsilon must stay separate");
    }

    /// Two vertices within epsilon but on opposite sides of a hash cell boundary
    /// must still weld. A quantise-only implementation fails this, which is the
    /// reason for the 27-cell neighbourhood search.
    #[test]
    fn weld_merges_vertices_straddling_a_hash_cell_boundary() {
        // Cell size equals epsilon, so with epsilon = 1.0 the boundary sits at
        // x = 1.0. These points land in cells 1 and 0 (both divisions are exact
        // in binary floating point, so the test cannot silently become vacuous)
        // yet are only 0.5 apart, well inside epsilon.
        let (merged, remap) = weld_vertices(&[p(1.0, 0.0, 0.0), p(0.5, 0.0, 0.0)], 1.0);

        assert_eq!(merged.len(), 1, "cell-straddling vertices must merge");
        assert_eq!(remap, vec![0, 0]);
    }

    /// A triangle with three collinear points has zero area and no defined
    /// normal, so it must be dropped rather than poisoning the BVH with a NaN.
    #[test]
    fn drops_zero_area_triangles() {
        let (mut positions, mut triangles) = outward_tetrahedron();

        positions.push(p(2.0, 0.0, 0.0));
        // Collinear with vertices 0 and 1, which both lie on the X axis.
        triangles.push([0, 1, 4]);

        let (mesh, diagnostics) = Mesh::build(&positions, &triangles, 1e-5);

        assert_eq!(diagnostics.degenerate_dropped, 1);
        assert_eq!(mesh.triangles.len(), 4);
    }

    /// A triangle that references the same vertex twice is degenerate by index
    /// and must also be dropped.
    #[test]
    fn drops_triangles_with_repeated_vertices() {
        let (positions, mut triangles) = outward_tetrahedron();

        triangles.push([1, 1, 2]);

        let (mesh, diagnostics) = Mesh::build(&positions, &triangles, 1e-5);

        assert_eq!(diagnostics.degenerate_dropped, 1);
        assert_eq!(mesh.triangles.len(), 4);
    }

    /// A closed solid reports every edge as manifold with no boundary edges. A
    /// triangulated cube has 18 undirected edges: 12 box edges plus 6 face
    /// diagonals.
    #[test]
    fn closed_mesh_is_reported_watertight() {
        let (positions, triangles) = outward_cube();

        let (_, diagnostics) = Mesh::build(&positions, &triangles, 1e-5);

        assert!(diagnostics.is_watertight(), "cube must be watertight");
        assert_eq!(diagnostics.boundary_edges, 0);
        assert_eq!(diagnostics.non_manifold_edges, 0);
        assert_eq!(diagnostics.manifold_edges, 18);
    }

    /// Removing a face opens a hole, which must be reported as boundary edges so
    /// the UI can warn that internal rays will leak.
    #[test]
    fn open_mesh_reports_boundary_edges() {
        let (positions, mut triangles) = outward_tetrahedron();

        triangles.pop();

        let (_, diagnostics) = Mesh::build(&positions, &triangles, 1e-5);

        assert!(!diagnostics.is_watertight(), "open mesh is not watertight");
        assert_eq!(diagnostics.boundary_edges, 3, "removing a face opens 3 edges");
    }

    /// The cube's twelve triangles must collapse into exactly six facets, one per
    /// side, since each coplanar pair shares an edge.
    #[test]
    fn coplanar_adjacent_triangles_group_into_one_facet() {
        let (positions, triangles) = outward_cube();

        let (mesh, diagnostics) = Mesh::build(&positions, &triangles, 1e-5);

        assert_eq!(diagnostics.facet_count, 6, "a cube has 6 facets");
        assert_eq!(mesh.facet_of_triangle.len(), 12);

        // Entries 0 and 1 are the two triangles of the -Z side and must match.
        assert_eq!(mesh.facet_of_triangle[0], mesh.facet_of_triangle[1]);
        // A triangle on a different side must not.
        assert_ne!(mesh.facet_of_triangle[0], mesh.facet_of_triangle[2]);
    }

    /// `facet_normals` must report each cube facet's exact axis-aligned normal.
    ///
    /// Setup: the same outward cube fixture as the facet-grouping test above -- six square
    /// facets, each two triangles, in the known order `outward_cube`'s own comment gives:
    /// triangles 0-1 are the -Z side, 2-3 +Z, 4-5 -Y, 6-7 +Y, 8-9 -X, 10-11 +X.
    ///
    /// Test: call `facet_normals()` once and compare each of the six entries to its known axis
    /// direction.
    ///
    /// Verifies both that averaging two triangles of one facet reproduces the shared normal
    /// they already agree on (rather than, say, silently only reading the first triangle) and
    /// that facet ids line up with `rebuild_facets`'s own assignment order, which this test
    /// would also catch drifting.
    #[test]
    fn facet_normals_reports_each_cube_side_axis_aligned() {
        let (positions, triangles) = outward_cube();
        let (mesh, _) = Mesh::build(&positions, &triangles, 1e-5);

        let normals = mesh.facet_normals();
        assert_eq!(normals.len(), 6, "a cube has six facets");

        let expected = [
            Vector3::new(0.0, 0.0, -1.0), // facet 0: triangles 0-1, -Z
            Vector3::new(0.0, 0.0, 1.0),  // facet 1: triangles 2-3, +Z
            Vector3::new(0.0, -1.0, 0.0), // facet 2: triangles 4-5, -Y
            Vector3::new(0.0, 1.0, 0.0),  // facet 3: triangles 6-7, +Y
            Vector3::new(-1.0, 0.0, 0.0), // facet 4: triangles 8-9, -X
            Vector3::new(1.0, 0.0, 0.0),  // facet 5: triangles 10-11, +X
        ];

        for (index, want) in expected.iter().enumerate() {
            let got = normals[index];
            assert!(
                (got - want).norm() < 1e-6,
                "facet {} normal {:?}, expected {:?}",
                index,
                got,
                want
            );
        }
    }

    /// `facet_normals_in_file_frame` must exactly undo `reorient_axis_to_y`: `build_model`
    /// relies on this to hand the page facet normals in the FILE's own convention (optical
    /// axis +Z, matching `design.js`'s `normalOf`) regardless of which axis the stone happens
    /// to be VIEWED with.
    ///
    /// Setup: the outward cube fixture, with its six facet normals recorded before any
    /// reorientation at all -- by definition "the file's own frame", since nothing has rotated
    /// it yet -- then reoriented as if the file's own optical axis were each of the three
    /// `ModelAxis` choices in turn (not only `PlusZ`, the common case every bundled sample
    /// uses, so a user picking a different axis for an odd `.obj` is covered too).
    ///
    /// Test: call `facet_normals_in_file_frame(axis)` on the REORIENTED mesh.
    ///
    /// Verifies every one of the six recovered normals matches its pre-reorientation original
    /// to float noise, for all three axes.
    #[test]
    fn facet_normals_in_file_frame_undoes_reorient_axis_to_y_for_every_model_axis() {
        for axis in [ModelAxis::PlusX, ModelAxis::PlusY, ModelAxis::PlusZ] {
            let (positions, triangles) = outward_cube();
            let (mut mesh, _) = Mesh::build(&positions, &triangles, 1e-5);

            let before = mesh.facet_normals();

            mesh.reorient_axis_to_y(axis);
            let recovered = mesh.facet_normals_in_file_frame(axis);

            assert_eq!(before.len(), recovered.len());

            for (index, (want, got)) in before.iter().zip(recovered.iter()).enumerate() {
                assert!(
                    (want - got).norm() < 1e-6,
                    "axis {:?} facet {}: expected {:?}, recovered {:?}",
                    axis,
                    index,
                    want,
                    got
                );
            }
        }
    }

    /// The wireframe mask must mark a cube's box edges and leave its face diagonals out.
    ///
    /// Setup: the outward cube, twelve triangles grouped into six square facets, so each
    /// triangle has two edges on its square's outline and one diagonal across the square.
    ///
    /// Test: read `facet_boundary_masks`, and for every triangle compare each edge bit with
    /// whether that edge is axis-aligned (a box edge changes one coordinate; a diagonal changes
    /// two).
    ///
    /// Verifies that the overlay would outline the six faces without drawing the triangulation:
    /// exactly the axis-aligned edges carry a bit, every triangle has exactly two, and every
    /// corner bit is set, because all eight cube vertices are corners of some face.
    #[test]
    fn facet_boundary_masks_mark_box_edges_but_not_face_diagonals() {
        let (positions, triangles) = outward_cube();
        let (mesh, _) = Mesh::build(&positions, &triangles, 1e-5);

        let masks = mesh.facet_boundary_masks();

        assert_eq!(masks.len(), 12);

        for (index, mask) in masks.iter().enumerate() {
            let [a, b, c] = mesh.triangle_positions(index);

            for (bit, (from, to)) in [(a, b), (b, c), (c, a)].into_iter().enumerate() {
                let delta = to - from;
                let changed_axes = [delta.x, delta.y, delta.z]
                    .iter()
                    .filter(|component| component.abs() > 1e-6)
                    .count();
                let is_box_edge = changed_axes == 1;

                assert_eq!(
                    mask & (1 << bit) != 0,
                    is_box_edge,
                    "triangle {} edge {}: a box edge must be marked and a face diagonal must not \
                     (mask {:#08b})",
                    index,
                    bit,
                    mask
                );
            }

            assert_eq!((mask & 0b111).count_ones(), 2, "triangle {}: expected two box edges", index);
            assert_eq!(mask >> 3, 0b111, "triangle {}: every cube vertex is a facet corner", index);
        }
    }

    /// A vertex in the middle of a facet must not be marked as a corner, and an open edge must
    /// count as a boundary.
    ///
    /// Setup: a flat unit square in z = 0 fanned into four triangles around a centre vertex.
    /// It is one facet, and the mesh is open, so its four outer edges have no neighbour at all.
    ///
    /// Test: read `facet_boundary_masks` and check each triangle's bits.
    ///
    /// Verifies the two cases the cube cannot reach. The outer edges, shared by nothing, are
    /// outlined (a hole's rim is still a facet boundary). The four spokes, each shared by two
    /// triangles of the same facet, are not. The centre vertex, an endpoint only of spokes, gets
    /// no corner bit, so the shader would not draw a dot in the middle of the facet.
    #[test]
    fn facet_boundary_masks_skip_interior_vertices_and_keep_open_edges() {
        let positions = vec![
            p(0.0, 0.0, 0.0),
            p(1.0, 0.0, 0.0),
            p(1.0, 1.0, 0.0),
            p(0.0, 1.0, 0.0),
            p(0.5, 0.5, 0.0), // 4: the centre of the fan
        ];
        // Each triangle is (outer corner, next outer corner, centre), so edge a->b is the
        // outer edge and b->c, c->a are spokes.
        let triangles = vec![[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]];

        let (mesh, _) = Mesh::build(&positions, &triangles, 1e-5);

        assert_eq!(mesh.facet_count, 1, "setup: the flat fan must be a single facet");

        for (index, mask) in mesh.facet_boundary_masks().iter().enumerate() {
            let centre_corner = mesh.triangles[index]
                .iter()
                .position(|&vertex| mesh.positions[vertex as usize] == p(0.5, 0.5, 0.0))
                .expect("every fan triangle touches the centre");

            // Welding and winding may reorder the corners, so find the outer edge by position:
            // it is the one edge that does not touch the centre vertex.
            let outer_edge = (centre_corner + 1) % 3;

            assert_eq!(
                mask & 0b111,
                1 << outer_edge,
                "triangle {}: only the outer (open) edge is a boundary, got {:#08b}",
                index,
                mask
            );
            assert_eq!(
                mask & (1 << (3 + centre_corner)),
                0,
                "triangle {}: the centre vertex is inside the facet and must not be a corner",
                index
            );
            assert_eq!(
                (mask >> 3).count_ones(),
                2,
                "triangle {}: its two outer vertices are facet corners",
                index
            );
        }
    }

    /// Two coplanar but *disconnected* facets must stay separate. This is the
    /// case that a group-by-plane implementation gets wrong, and it shows up in
    /// fantasy cuts where distinct facets can share a plane.
    #[test]
    fn coplanar_but_disconnected_triangles_get_separate_facets() {
        // Two triangles in the z = 0 plane that share no edge, plus the rest of a
        // tetrahedron so the mesh is not empty. Facet grouping only needs the
        // triangle list, so watertightness is irrelevant here.
        let positions = vec![
            p(0.0, 0.0, 0.0),
            p(1.0, 0.0, 0.0),
            p(0.0, 1.0, 0.0),
            p(5.0, 5.0, 0.0),
            p(6.0, 5.0, 0.0),
            p(5.0, 6.0, 0.0),
        ];
        let triangles = vec![[0, 1, 2], [3, 4, 5]];

        let (mut mesh, _) = Mesh::build(&positions, &triangles, 1e-5);

        mesh.rebuild_facets();

        assert_eq!(
            mesh.facet_count, 2,
            "coplanar but disconnected triangles must not merge"
        );
    }

    /// The tetrahedron's four triangles lie in four different planes, so each is
    /// its own facet.
    #[test]
    fn non_coplanar_triangles_get_separate_facets() {
        let (positions, triangles) = outward_tetrahedron();

        let (_, diagnostics) = Mesh::build(&positions, &triangles, 1e-5);

        assert_eq!(diagnostics.facet_count, 4);
    }

    /// Centering and scaling must put the bounding box on the origin and the
    /// farthest vertex at exactly the requested radius, so the ray tracer's
    /// world-space constants stay meaningful for any input scale.
    #[test]
    fn center_and_scale_normalizes_bounds() {
        let (positions, triangles) = outward_cube();
        // Blow the cube up and push it off-origin so both steps must do work.
        let shifted: Vec<Point3<f32>> = positions
            .iter()
            .map(|q| Point3::new(q.x * 100.0 + 7.0, q.y * 100.0 - 3.0, q.z * 100.0 + 42.0))
            .collect();

        let (mut mesh, _) = Mesh::build(&shifted, &triangles, 1e-5);

        mesh.center_and_scale(1.0);

        let center = mesh.bounds().center();

        assert!(
            center.coords.norm() < 1e-5,
            "should be centred, got {:?}",
            center
        );

        let max_radius = mesh
            .positions
            .iter()
            .fold(0.0f32, |acc, q| acc.max(q.coords.norm()));

        assert!(
            (max_radius - 1.0).abs() < 1e-5,
            "farthest vertex should sit at radius 1, got {}",
            max_radius
        );
    }

    /// Reorienting a +Z-axis model must send +Z to +Y. This is the transform
    /// applied to `hex_cut_v2.obj` so its table faces up in a Y-up world.
    #[test]
    fn reorient_plus_z_maps_z_axis_to_y_axis() {
        let (positions, triangles) = outward_tetrahedron();
        let (mut mesh, _) = Mesh::build(&positions, &triangles, 1e-5);

        // Vertex (0, 0, 1) of the tetrahedron lies purely on the +Z axis.
        let z_vertex = mesh
            .positions
            .iter()
            .position(|q| (*q - p(0.0, 0.0, 1.0)).norm() < 1e-6)
            .expect("tetrahedron has a +Z vertex");

        mesh.reorient_axis_to_y(ModelAxis::PlusZ);

        let moved = mesh.positions[z_vertex];

        assert!(
            (moved - p(0.0, 1.0, 0.0)).norm() < 1e-6,
            "+Z vertex should land on +Y, got {:?}",
            moved
        );
    }

    /// Reorienting must be a rotation, not a reflection: a reflection would
    /// invert the winding and turn every outward normal inward. A true rotation
    /// preserves the signed volume, sign included.
    #[test]
    fn reorient_preserves_volume_and_orientation() {
        let (positions, triangles) = outward_cube();
        let (mut mesh, _) = Mesh::build(&positions, &triangles, 1e-5);

        let before = mesh.signed_volume();

        mesh.reorient_axis_to_y(ModelAxis::PlusZ);

        let after = mesh.signed_volume();

        assert!(
            (before - after).abs() < 1e-6,
            "rotation must preserve signed volume: {} vs {}",
            before,
            after
        );
        assert!(after > 0.0, "orientation must stay outward");
    }

    /// PlusY is the identity, since the model axis already matches world up.
    #[test]
    fn reorient_plus_y_is_identity() {
        let (positions, triangles) = outward_cube();
        let (mut mesh, _) = Mesh::build(&positions, &triangles, 1e-5);

        let before = mesh.positions.clone();

        mesh.reorient_axis_to_y(ModelAxis::PlusY);

        assert_eq!(mesh.positions, before);
    }

    /// Reorienting from +X must also be a rotation, sending +X to +Y.
    #[test]
    fn reorient_plus_x_maps_x_axis_to_y_axis() {
        let (positions, triangles) = outward_tetrahedron();
        let (mut mesh, _) = Mesh::build(&positions, &triangles, 1e-5);

        let x_vertex = mesh
            .positions
            .iter()
            .position(|q| (*q - p(1.0, 0.0, 0.0)).norm() < 1e-6)
            .expect("tetrahedron has a +X vertex");
        let before = mesh.signed_volume();

        mesh.reorient_axis_to_y(ModelAxis::PlusX);

        assert!(
            (mesh.positions[x_vertex] - p(0.0, 1.0, 0.0)).norm() < 1e-6,
            "+X vertex should land on +Y, got {:?}",
            mesh.positions[x_vertex]
        );
        assert!(
            (mesh.signed_volume() - before).abs() < 1e-6,
            "must be a rotation, not a reflection"
        );
    }
}
