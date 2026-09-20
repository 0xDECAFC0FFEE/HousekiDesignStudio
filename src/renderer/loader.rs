//! OBJ loading, via the `tobj` crate.
//!
//! `tobj`'s path-based `load_obj` cannot be used in the browser, so JavaScript hands the
//! OBJ text to `load_obj_text` as a string, which is read through `load_obj_buf`. The text is
//! either the model inlined into the page or a file the user opened or dropped.

use nalgebra::Point3;
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
        // Fan-triangulate any polygon faces. Faceting software commonly emits
        // quads and n-gons for facets, and the tracer only handles triangles. A fan is
        // only correct for convex polygons: a concave polygon face comes out as
        // overlapping triangles (T-0036).
        triangulate: true,
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

        if mesh.indices.len() % 3 != 0 {
            return Err(format!(
                "object {:?} has {} indices after triangulation, which is not a \
                 multiple of 3",
                model.name,
                mesh.indices.len()
            ));
        }

        let local_vertex_count = (mesh.positions.len() / 3) as u32;

        for chunk in mesh.indices.chunks_exact(3) {
            for &index in chunk {
                if index >= local_vertex_count {
                    return Err(format!(
                        "object {:?} references vertex {} but only declares {}",
                        model.name, index, local_vertex_count
                    ));
                }
            }

            geometry.triangles.push([
                chunk[0] + vertex_offset,
                chunk[1] + vertex_offset,
                chunk[2] + vertex_offset,
            ]);
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
}
