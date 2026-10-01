//! OBJ loading, via the `tobj` crate.
//!
//! `tobj`'s path-based `load_obj` cannot be used in the browser, so JavaScript hands the
//! OBJ text to `load_obj_text` as a string, which is read through `load_obj_buf`. The text is
//! either the model inlined into the page or a file the user opened or dropped.
//!
//! Polygon faces are triangulated here rather than by `tobj` (T-0036). `tobj`'s own
//! triangulation is a fan from each face's first corner, which is only right for a convex
//! polygon: a concave one (an L, a notched end cap) came out as overlapping triangles, some
//! wound backwards. A face with no reflex corner still gets exactly that fan, triangle for
//! triangle, so every convex stone loads as it always did; only a face with a reflex corner is
//! ear-clipped (`triangulate_polygon`).

use nalgebra::{Point3, Vector3};
use std::io::Cursor;
use std::path::Path;
use tobj::{LoadOptions, MTLLoadResult};

/// Geometry extracted from an OBJ file, before any conditioning.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoadedGeometry {
    pub positions: Vec<Point3<f32>>,
    pub triangles: Vec<[u32; 3]>,
    /// Names of the objects that were merged, for display.
    pub object_names: Vec<String>,
}

/// Parses OBJ text into a single triangle soup.
///
/// All objects in the file are merged: a faceted stone is one solid even when the
/// exporter split the crown, girdle and pavilion into separate groups, and the
/// internal ray march has to see it as one closed surface.
pub fn load_obj_text(source: &str) -> Result<LoadedGeometry, String> {
    let options = LoadOptions {
        // Polygon faces are kept whole and triangulated below, by `triangulate_face`: tobj's
        // own triangulation is a plain fan, which is wrong for a concave polygon (T-0036).
        // Faceting software commonly emits quads and n-gons for facets, and the tracer only
        // handles triangles.
        triangulate: false,
        // Collapse position/normal/texcoord index triplets to one index stream,
        // which is what the mesh conditioner expects.
        single_index: true,
        ..Default::default()
    };

    // No material loader: gem appearance comes from physical constants (index of
    // refraction, dispersion, absorption), not from an MTL file. Returning an
    // empty material set keeps a stray `mtllib` statement from failing the load.
    let material_loader = |_: &Path| -> MTLLoadResult { Ok((Vec::new(), Default::default())) };

    let mut reader = Cursor::new(source.as_bytes());

    let (models, _materials) = tobj::load_obj_buf(&mut reader, &options, material_loader)
        .map_err(|error| format!("could not parse OBJ: {}", error))?;

    let mut geometry = LoadedGeometry::default();

    for model in &models {
        let mesh = &model.mesh;

        if mesh.positions.len() % 3 != 0 {
            return Err(format!(
                "object {:?} has {} position floats, which is not a multiple of 3",
                model.name,
                mesh.positions.len()
            ));
        }

        // Indices are local to each object, so shift them by the number of
        // vertices already merged in.
        let vertex_offset = geometry.positions.len() as u32;

        for chunk in mesh.positions.chunks_exact(3) {
            if !chunk.iter().all(|c| c.is_finite()) {
                return Err(format!(
                    "object {:?} contains a non-finite vertex coordinate; NaN or \
                     infinity would poison every ray intersection test",
                    model.name
                ));
            }

            geometry
                .positions
                .push(Point3::new(chunk[0], chunk[1], chunk[2]));
        }

        let local_vertex_count = (mesh.positions.len() / 3) as u32;

        for &index in &mesh.indices {
            if index >= local_vertex_count {
                return Err(format!(
                    "object {:?} references vertex {} but only declares {}",
                    model.name, index, local_vertex_count
                ));
            }
        }

        // tobj leaves `face_arities` empty when every face is a triangle; otherwise it gives
        // each face's corner count, in the order the faces' indices follow one another.
        let arities: Vec<usize> = if mesh.face_arities.is_empty() {
            if mesh.indices.len() % 3 != 0 {
                return Err(format!(
                    "object {:?} has {} indices, which is not a multiple of 3",
                    model.name,
                    mesh.indices.len()
                ));
            }

            vec![3; mesh.indices.len() / 3]
        } else {
            mesh.face_arities.iter().map(|&arity| arity as usize).collect()
        };

        if arities.iter().sum::<usize>() != mesh.indices.len() {
            return Err(format!(
                "object {:?} has {} indices but its faces have {} corners between them",
                model.name,
                mesh.indices.len(),
                arities.iter().sum::<usize>()
            ));
        }

        let local_positions = &geometry.positions[vertex_offset as usize..];
        let mut start = 0;

        for arity in arities {
            let face = &mesh.indices[start..start + arity];

            start += arity;

            for triangle in triangulate_face(face, local_positions) {
                geometry.triangles.push(triangle.map(|index| index + vertex_offset));
            }
        }

        if !model.name.is_empty() {
            geometry.object_names.push(model.name.clone());
        }
    }

    // One combined check, because tobj only reports vertices that a face actually
    // references: a file full of `v` lines with no `f` line yields zero positions,
    // not zero faces. Separate messages would imply a distinction that cannot be
    // observed here.
    if geometry.positions.is_empty() || geometry.triangles.is_empty() {
        return Err(
            "OBJ contains no faces, so there is no surface to trace (note that \
             vertices are only kept when a face references them)"
                .to_string(),
        );
    }

    Ok(geometry)
}

/// How far a polygon corner may turn the wrong way, as the sine of the turn, and still count
/// as convex for `triangulate_face`.
///
/// A corner of a facet written by faceting software is often exactly straight (a point on an
/// edge) or wrong by float noise, and the fan handles those as it always has. A real reflex
/// corner turns the wrong way by a visible angle: the notch of an L turns by a right angle,
/// a sine of 1, so this is ten thousand times smaller than anything that matters.
const REFLEX_TOLERANCE: f64 = 1e-4;

/// The triangles of one OBJ face, `face` being its corners' indices into `positions`.
///
/// - A point or a line becomes the degenerate triangle tobj's triangulation made of it
///   (`[a, a, a]`, `[a, b, b]`), which the mesh conditioner then drops as it always did.
/// - A triangle is kept as it is.
/// - A polygon with no reflex corner is fanned from its first corner, `(0, i, i + 1)`, exactly
///   as tobj fanned every polygon, so a convex facet loads triangle for triangle as before.
/// - A polygon with a reflex corner is ear-clipped (`triangulate_polygon`).
///
/// Each triangle keeps the face's winding, so the mesh conditioner's orientation fix sees the
/// file as it was written.
fn triangulate_face(face: &[u32], positions: &[Point3<f32>]) -> Vec<[u32; 3]> {
    match face.len() {
        0 => Vec::new(),
        1 => vec![[face[0], face[0], face[0]]],
        2 => vec![[face[0], face[1], face[1]]],
        3 => vec![[face[0], face[1], face[2]]],
        _ => triangulate_polygon(face, positions),
    }
}

/// Triangulates a polygon face of four or more corners: the plain fan when no corner is
/// reflex, and ear clipping otherwise.
///
/// The polygon is projected onto the plane of its Newell normal, the normal that least-squares
/// fits a polygon whose corners are not exactly coplanar and that points the way the polygon
/// winds; in that plane the polygon winds anticlockwise. A corner is reflex when the boundary
/// turns clockwise there.
///
/// Ear clipping (Meisters, "Polygons have ears", 1975) repeatedly cuts off a convex corner
/// whose triangle holds no other corner of what remains; a simple polygon always has one. A
/// polygon that is not simple (self-intersecting, or folded badly out of its plane) may run
/// out of ears; what is left of it is then fanned, which is no worse than before.
fn triangulate_polygon(face: &[u32], positions: &[Point3<f32>]) -> Vec<[u32; 3]> {
    let fan = |corners: &[u32]| -> Vec<[u32; 3]> {
        (1..corners.len() - 1)
            .map(|i| [corners[0], corners[i], corners[i + 1]])
            .collect()
    };

    let points: Vec<Vector3<f64>> = face
        .iter()
        .map(|&index| positions[index as usize].coords.cast::<f64>())
        .collect();
    let count = points.len();

    // Newell's normal: twice the polygon's vector area.
    let mut normal = Vector3::<f64>::zeros();

    for i in 0..count {
        normal += points[i].cross(&points[(i + 1) % count]);
    }

    let length = normal.norm();

    if !(length > 0.0) {
        return fan(face);
    }

    // An orthonormal basis (u, v) of the polygon's plane with u x v along the normal, so the
    // polygon winds anticlockwise in (u, v).
    let normal = normal / length;
    let helper = if normal.x.abs() < 0.9 {
        Vector3::x()
    } else {
        Vector3::y()
    };
    let u = helper.cross(&normal).normalize();
    let v = normal.cross(&u);
    let flat: Vec<(f64, f64)> = points.iter().map(|p| (p.dot(&u), p.dot(&v))).collect();

    // How much the boundary turns left at corner `at`, coming from `from` and going to `to`,
    // as the sine of the turn: positive for a convex corner, negative for a reflex one.
    let turn = |from: usize, at: usize, to: usize| -> f64 {
        let (ax, ay) = (flat[at].0 - flat[from].0, flat[at].1 - flat[from].1);
        let (bx, by) = (flat[to].0 - flat[at].0, flat[to].1 - flat[at].1);
        let scale = (ax * ax + ay * ay).sqrt() * (bx * bx + by * by).sqrt();

        if scale > 0.0 {
            (ax * by - ay * bx) / scale
        } else {
            0.0
        }
    };

    let reflex = (0..count).any(|i| turn((i + count - 1) % count, i, (i + 1) % count) < -REFLEX_TOLERANCE);

    if !reflex {
        return fan(face);
    }

    // Whether `point` lies inside or on the triangle (a, b, c), which winds anticlockwise.
    let inside = |point: usize, a: usize, b: usize, c: usize| -> bool {
        let side = |from: usize, to: usize| -> f64 {
            (flat[to].0 - flat[from].0) * (flat[point].1 - flat[from].1)
                - (flat[to].1 - flat[from].1) * (flat[point].0 - flat[from].0)
        };

        side(a, b) >= 0.0 && side(b, c) >= 0.0 && side(c, a) >= 0.0
    };

    let same_place = |i: usize, j: usize| flat[i] == flat[j];

    // Positions in `face`, of the corners not yet cut off.
    let mut remaining: Vec<usize> = (0..count).collect();
    let mut triangles = Vec::with_capacity(count - 2);

    while remaining.len() > 3 {
        let size = remaining.len();
        let ear = (0..size).find(|&k| {
            let (a, b, c) = (remaining[(k + size - 1) % size], remaining[k], remaining[(k + 1) % size]);

            turn(a, b, c) > 0.0
                && remaining.iter().all(|&other| {
                    other == a
                        || other == b
                        || other == c
                        || same_place(other, a)
                        || same_place(other, b)
                        || same_place(other, c)
                        || !inside(other, a, b, c)
                })
        });

        let Some(k) = ear else {
            let rest: Vec<u32> = remaining.iter().map(|&i| face[i]).collect();

            triangles.extend(fan(&rest));

            return triangles;
        };

        let (a, b, c) = (remaining[(k + size - 1) % size], remaining[k], remaining[(k + 1) % size]);

        triangles.push([face[a], face[b], face[c]]);
        remaining.remove(k);
    }

    triangles.push([face[remaining[0]], face[remaining[1]], face[remaining[2]]]);

    triangles
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The minimal case: three vertices and one face. Confirms indices are
    /// converted from OBJ's 1-based numbering to 0-based.
    #[test]
    fn loads_a_single_triangle() {
        let source = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";

        let geometry = load_obj_text(source).expect("valid OBJ should load");

        assert_eq!(geometry.positions.len(), 3);
        assert_eq!(geometry.positions[1], Point3::new(1.0, 0.0, 0.0));
        assert_eq!(geometry.triangles, vec![[0, 1, 2]]);
    }

    /// A quad face must be triangulated into two triangles, since faceting
    /// exporters routinely emit quads for facets and the tracer is triangle-only.
    #[test]
    fn triangulates_quad_faces() {
        let source = "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n";

        let geometry = load_obj_text(source).expect("quad OBJ should load");

        assert_eq!(geometry.triangles.len(), 2, "a quad becomes 2 triangles");
    }

    /// Face references that also carry texture and normal indices must resolve to
    /// the same geometry as the bare form.
    #[test]
    fn handles_face_references_with_texcoord_and_normal_indices() {
        let source = "v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\nf 1/1/1 2/1/1 3/1/1\n";

        let geometry = load_obj_text(source).expect("indexed OBJ should load");

        assert_eq!(geometry.triangles.len(), 1);
        assert_eq!(geometry.positions.len(), 3);
    }

    /// Two objects in one file must merge into a single soup with the second
    /// object's indices shifted past the first object's vertices. Without the
    /// shift, the second group's triangles would silently reference the first
    /// group's vertices.
    #[test]
    fn merges_multiple_objects_and_offsets_indices() {
        let source = "o first\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n\
                      o second\nv 5 0 0\nv 6 0 0\nv 5 1 0\nf 4 5 6\n";

        let geometry = load_obj_text(source).expect("two-object OBJ should load");

        assert_eq!(geometry.positions.len(), 6, "both objects' vertices are kept");
        assert_eq!(geometry.triangles.len(), 2);

        // Every index must be in range for the merged vertex list, and the two
        // triangles must not share vertices.
        let first = geometry.triangles[0];
        let second = geometry.triangles[1];

        for index in first.iter().chain(second.iter()) {
            assert!(
                (*index as usize) < geometry.positions.len(),
                "index {} out of range",
                index
            );
        }

        assert!(
            first.iter().all(|a| !second.contains(a)),
            "separate objects must not share vertices: {:?} vs {:?}",
            first,
            second
        );
    }

    /// Object names are collected for display.
    #[test]
    fn collects_object_names() {
        let source = "o hex_cut_v2\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";

        let geometry = load_obj_text(source).expect("named OBJ should load");

        assert!(
            geometry.object_names.iter().any(|n| n == "hex_cut_v2"),
            "expected the object name, got {:?}",
            geometry.object_names
        );
    }

    /// A `mtllib` reference to a file that cannot be fetched in the browser must
    /// not fail the geometry load, because the renderer ignores materials anyway.
    #[test]
    fn ignores_missing_material_library() {
        let source = "mtllib gem.mtl\nusemtl gem\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";

        let geometry = load_obj_text(source).expect("missing MTL must not fail the load");

        assert_eq!(geometry.triangles.len(), 1);
    }

    /// A file with vertices but no faces has no surface to trace against, so it is
    /// rejected with a clear message rather than producing an empty black render.
    #[test]
    fn rejects_file_with_no_faces() {
        let error = load_obj_text("v 0 0 0\nv 1 0 0\nv 0 1 0\n")
            .expect_err("a file with no faces must be rejected");

        assert!(error.contains("no faces"), "got {:?}", error);
    }

    /// An entirely empty file is rejected too, with the same message.
    #[test]
    fn rejects_empty_file() {
        let error = load_obj_text("").expect_err("empty file must be rejected");

        assert!(error.contains("no faces"), "got {:?}", error);
    }

    /// A NaN coordinate must be caught at load time. Letting it through would
    /// poison the BVH bounds and make every intersection test fail silently, so
    /// the whole stone would disappear with no explanation.
    #[test]
    fn rejects_non_finite_coordinates() {
        let source = "v 0 nan 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";

        let error = load_obj_text(source).expect_err("NaN coordinate must be rejected");

        assert!(error.contains("non-finite"), "got {:?}", error);
    }

    /// Twice the vector area of a triangle of `geometry`: its normal, as long as twice its area.
    fn doubled_area(geometry: &LoadedGeometry, triangle: [u32; 3]) -> Vector3<f64> {
        let [a, b, c] = triangle.map(|index| geometry.positions[index as usize].coords.cast::<f64>());

        (b - a).cross(&(c - a))
    }

    /// What the loader returned before T-0036: tobj's own triangulation (a fan from each face's
    /// first corner), with every object merged the way `load_obj_text` merges them. The
    /// reference the convex cases are held to.
    fn tobj_fan(source: &str) -> LoadedGeometry {
        let options = LoadOptions {
            triangulate: true,
            single_index: true,
            ..Default::default()
        };
        let material_loader = |_: &Path| -> MTLLoadResult { Ok((Vec::new(), Default::default())) };
        let (models, _) =
            tobj::load_obj_buf(&mut Cursor::new(source.as_bytes()), &options, material_loader)
                .expect("reference OBJ parses");
        let mut geometry = LoadedGeometry::default();

        for model in &models {
            let offset = geometry.positions.len() as u32;

            for chunk in model.mesh.positions.chunks_exact(3) {
                geometry.positions.push(Point3::new(chunk[0], chunk[1], chunk[2]));
            }

            for chunk in model.mesh.indices.chunks_exact(3) {
                geometry.triangles.push([chunk[0] + offset, chunk[1] + offset, chunk[2] + offset]);
            }

            if !model.name.is_empty() {
                geometry.object_names.push(model.name.clone());
            }
        }

        geometry
    }

    /// An L-shaped face is cut into triangles that cover exactly the L, where a fan did not.
    ///
    /// Setup: the L from T-0036's review, the square (0,0)-(2,2) less its corner square
    /// (1,1)-(2,2), area 3, wound anticlockwise but starting at (2,0), a corner that cannot see
    /// the whole L. It is laid in a tilted plane (z = 0.3x + 0.2y) so the loader has to find the
    /// plane rather than read x and y. First the test checks the premise: a fan from (2,0) has a
    /// triangle wound backwards, which is how the old loader broke this face.
    ///
    /// Test: load the face.
    ///
    /// Verifies the ear clipping: four triangles (a hexagon always makes n - 2), every one wound
    /// the same way as the face (its normal along the face's), none degenerate, and their areas
    /// adding up to the L's own area -- so they neither overlap nor leave a gap. The fan's
    /// triangles added up to more than the L, because the backwards one overlapped the others.
    #[test]
    fn a_concave_polygon_face_is_ear_clipped_rather_than_fanned() {
        let corners = [(2.0, 0.0), (2.0, 1.0), (1.0, 1.0), (1.0, 2.0), (0.0, 2.0), (0.0, 0.0)];
        let mut source = String::new();

        for (x, y) in corners {
            source += &format!("v {} {} {}\n", x, y, 0.3 * x + 0.2 * y);
        }

        source += "f 1 2 3 4 5 6\n";

        // The face's own normal: the plane z = 0.3x + 0.2y, wound anticlockwise seen from +z.
        let face_normal = Vector3::new(-0.3, -0.2, 1.0).normalize();
        // Areas are measured across the plane, i.e. projected on the face's normal.
        let area = |geometry: &LoadedGeometry, triangle| doubled_area(geometry, triangle).dot(&face_normal) / 2.0;
        // The L's area, measured in its tilted plane: 3 in (x, y), stretched by 1 / cos(tilt).
        let l_area = 3.0 / face_normal.z;

        let fanned = tobj_fan(&source);

        assert!(
            fanned.triangles.iter().any(|&t| area(&fanned, t) < 0.0),
            "premise: the old fan should have a backwards triangle"
        );

        let geometry = load_obj_text(&source).expect("the L loads");

        assert_eq!(geometry.triangles.len(), 4);

        for &triangle in &geometry.triangles {
            assert!(area(&geometry, triangle) > 1e-6, "triangle {:?} is backwards or empty", triangle);
        }

        let total: f64 = geometry.triangles.iter().map(|&t| area(&geometry, t)).sum();

        assert!((total - l_area).abs() < 1e-5, "the triangles cover {} of the L's {}", total, l_area);
    }

    /// A face with several reflex corners -- a comb, the end cap of a grooved bar -- is cut into
    /// n - 2 triangles covering exactly its area.
    ///
    /// Setup: a comb of three teeth in the plane y = 0, wound anticlockwise seen from -y (the
    /// way the near end cap of a bar along +y faces), with its first corner at the bottom
    /// right, which cannot see into the notches: 12 corners, 4 of them reflex. Test: load it.
    /// Verifies what the L test does on a polygon
    /// with more than one reflex corner, where an ear clipper that stopped after the first ear
    /// or mis-tested the containment would leave an overlap.
    #[test]
    fn a_face_with_several_reflex_corners_is_covered_exactly() {
        // (x, z) round the comb: base 0..5, teeth at x 0-1, 2-3, 4-5 rising to z 2 from a
        // back at z 1.
        let outline = [
            (5.0, 0.0), (5.0, 2.0), (4.0, 2.0), (4.0, 1.0), (3.0, 1.0), (3.0, 2.0),
            (2.0, 2.0), (2.0, 1.0), (1.0, 1.0), (1.0, 2.0), (0.0, 2.0), (0.0, 0.0),
        ];
        let mut source = String::new();

        for (x, z) in outline {
            source += &format!("v {} 0 {}\n", x, z);
        }

        source += "f 1 2 3 4 5 6 7 8 9 10 11 12\n";

        // In that order the outline runs up the right side and back along the top, anticlockwise
        // in (x, z), and x cross z is -y: the face points along -y.
        let face_normal = Vector3::new(0.0, -1.0, 0.0);
        // 5 x 1 of base plus three 1 x 1 teeth.
        let comb_area = 8.0;
        let geometry = load_obj_text(&source).expect("the comb loads");

        assert_eq!(geometry.triangles.len(), outline.len() - 2);

        let mut total = 0.0;

        for &triangle in &geometry.triangles {
            let area = doubled_area(&geometry, triangle).dot(&face_normal) / 2.0;

            assert!(area > 1e-6, "triangle {:?} is backwards or empty ({})", triangle, area);
            total += area;
        }

        assert!((total - comb_area).abs() < 1e-5, "covered {} of {}", total, comb_area);
    }

    /// Every face with no reflex corner loads exactly as tobj's fan loaded it: the same
    /// positions, and the same triangles in the same order with the same winding.
    ///
    /// Setup: faces covering every path through `triangulate_face` except ear clipping: both
    /// shipped stones (all triangles), a quad, a regular hexagon, a pentagon with a corner that
    /// is exactly straight (a point on an edge, which faceting programs write), a hexagon whose
    /// corners are off its plane by float noise, a point and a line (which tobj turned into
    /// degenerate triangles), and two objects in one file. Test: load each with `load_obj_text`
    /// and with the old loader (`tobj_fan`).
    ///
    /// Verifies the promise that lets convex stones render bit for bit as before T-0036: a
    /// convex facet's triangles, down to which corner each starts at, are unchanged. A different
    /// but equally valid triangulation would still move pixels, through the wireframe's
    /// diagonals and the BVH's build.
    #[test]
    fn convex_faces_are_fanned_exactly_as_tobj_fanned_them() {
        let mut hexagon = String::new();
        let mut noisy = String::new();

        for k in 0..6 {
            let angle = std::f32::consts::PI / 3.0 * k as f32;

            hexagon += &format!("v {} {} 0\n", angle.cos(), angle.sin());
            noisy += &format!("v {} {} {}\n", angle.cos(), angle.sin(), 1e-7 * (k % 2) as f32);
        }

        hexagon += "f 1 2 3 4 5 6\n";
        noisy += "f 1 2 3 4 5 6\n";

        let sources = [
            include_str!("../resources/hex_cut_v2.obj").to_string(),
            include_str!("../resources/oval_cut.obj").to_string(),
            "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n".to_string(),
            hexagon,
            "v 0 0 0\nv 1 0 0\nv 2 0 0\nv 2 1 0\nv 0 1 0\nf 1 2 3 4 5\n".to_string(),
            noisy,
            "v 0 0 0\nv 1 0 0\nv 0 1 0\np 1\nl 1 2\nf 1 2 3\n".to_string(),
            "o a\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n\
             o b\nv 5 0 0\nv 6 0 0\nv 6 1 0\nv 5 1 0\nv 5 0.5 0\nf 5 6 7 8 9\n"
                .to_string(),
        ];

        for source in &sources {
            let expected = tobj_fan(source);
            let loaded = load_obj_text(source).expect("reference OBJ loads");

            assert_eq!(loaded.positions, expected.positions, "positions of {:.60}", source);
            assert_eq!(loaded.triangles, expected.triangles, "triangles of {:.60}", source);
            assert_eq!(loaded.object_names, expected.object_names);
        }
    }
}
