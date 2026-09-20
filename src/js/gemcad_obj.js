/*
 * gemcad_obj.js -- turns a parsed GemCad design (see gemcad.js) into OBJ text.
 *
 * Why OBJ rather than a direct geometry hand-off: the renderer already has one
 * well-tested load path, `GemApp.load_obj`, and everything downstream of it --
 * vertex welding, outward winding, coplanar facet grouping, the BVH build and
 * the shader -- is written against the mesh that path produces. Emitting OBJ
 * text means a GemCad design becomes just another stone, with no second code
 * path to keep in step and no new Rust parser.
 *
 * Three things this has to get right, all of them learned the hard way and
 * recorded in kb/reading-gemcad-asc-and-gem-cut-files.md:
 *
 *   1. Use `index.points`, the facet polygon's own corners. `renderingTriangles`
 *      is a one-level subdivision, four times the triangles, which exists so the
 *      upstream viewer can carry smooth vertex normals. This renderer groups
 *      coplanar triangles into facets itself and shades them flat, so the
 *      subdivision would be pure cost, and it would also break facet grouping's
 *      assumption that a facet is a connected patch of *distinct* triangles.
 *   2. Weld the corners. The .asc path reconstructs geometry by cutting a cube
 *      with one plane per facet, and its de-duplication tolerance (1e-10) is
 *      tighter than the error its own clipping arithmetic leaves behind (~1e-8),
 *      so coincident corners survive as separate points: 96 of them on SRB, 20
 *      on Compear125. Unwelded seams leak interior rays and render as black
 *      speckle, so they are welded here at 1e-6 model units. (`src/mesh.rs`
 *      welds again, at 1e-5 of the bounding-box diagonal, so this is belt and
 *      braces -- but it also makes the emitted OBJ share corners between
 *      adjacent facets, which is what an OBJ is supposed to look like.)
 *   3. Orient every polygon the same way round. `loader.rs` fan-triangulates an
 *      n-gon face, and `Mesh::force_outward_winding` can only flip the whole
 *      mesh at once; it cannot repair a file whose faces disagree with each
 *      other. So each polygon is emitted wound to agree with its own stored
 *      facet normal, which points out of the stone.
 *
 * `facetNormal` is not a unit vector: `GenerateCutPlanes` builds it as the plane
 * point plus three units along the outward normal, which for a plane at distance
 * d from the origin makes it exactly (3 + d) times the outward unit normal.
 * Since the designs are small (|d| well under 3) the scale is positive, so its
 * *direction* is the outward normal and a sign test against it is all this needs.
 *
 * GemCad's optical axis is +Z -- the table facet (tier angle 0) has facet normal
 * (0, 0, 3 + d) and sits at the top of the model's Z range -- which is the same
 * convention as resources/hex_cut_v2.obj, so the coordinates are written through
 * unchanged and the renderer's default `ModelAxis::PlusZ` is correct.
 *
 * A classic browser script, like gemcad.js: no ES import or export, nothing
 * loaded over the network, and the public surface is published as
 * globalThis.GemCadObj, so make_page.py can inline it into the file:// page.
 * (It must not even contain the literal text make_page.py greps for, which is
 * why that rule is described here rather than quoted.)
 */

(function () {
    "use strict";

    // Corners closer together than this, in model units, are the same corner.
    // The designs arrive cut from a cube of half-size 10, so this is about 1e-7
    // of the model, far below any real feature and far above the ~1e-8 of
    // clipping noise it exists to absorb.
    var DEFAULT_WELD_TOLERANCE = 1e-6;

    // Decimal places in the emitted coordinates. The designs come out about one
    // unit across, where f32's resolution is about 6e-8, so nine places is just
    // past what the renderer can represent and more would only lengthen the text.
    //
    // Six places, which is also below the weld tolerance, looked like enough and
    // is not: the rounding tilts the normal of a thin fan triangle by more than
    // `Mesh::rebuild_facets`'s 0.1-degree tolerance, so single facets come apart
    // into several. Measured on the four samples, six places against nine:
    // Compear125 100 facets -> 72, CubeIllusionTri 102 -> 58, Turkey 134 -> 74,
    // and the .asc and .gem of a design stop disagreeing about the count. It
    // changes no pixel of a full render, which shades from the triangle normal,
    // but it is wrong in the facet-ids view and would be wrong for the smooth
    // normals that curved fantasy facets will need.
    var DEFAULT_DECIMALS = 9;

    /**
     * Collapses coincident points onto shared vertex indices.
     *
     * A spatial hash with cells the size of the tolerance. Two points within the
     * tolerance can still land in different cells when they straddle a cell
     * boundary, so a lookup checks all 27 cells around the query point -- the
     * same reason `Mesh::weld_vertices` does it that way, and the reason a plain
     * quantise-and-compare is not good enough.
     */
    function VertexWelder(tolerance) {
        this.tolerance = tolerance;
        this.toleranceSquared = tolerance * tolerance;
        this.cells = new Map();
        this.points = [];
    }

    VertexWelder.prototype.cellKey = function (ix, iy, iz) {
        return ix + "," + iy + "," + iz;
    };

    /** Returns the index of the welded vertex for `point`, adding it if new. */
    VertexWelder.prototype.add = function (point) {
        var ix = Math.floor(point.x / this.tolerance);
        var iy = Math.floor(point.y / this.tolerance);
        var iz = Math.floor(point.z / this.tolerance);

        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
                for (var dz = -1; dz <= 1; dz++) {
                    var bucket = this.cells.get(this.cellKey(ix + dx, iy + dy, iz + dz));

                    if (!bucket) {
                        continue;
                    }

                    for (var i = 0; i < bucket.length; i++) {
                        var other = this.points[bucket[i]];
                        var ex = other.x - point.x;
                        var ey = other.y - point.y;
                        var ez = other.z - point.z;

                        if (ex * ex + ey * ey + ez * ez <= this.toleranceSquared) {
                            return bucket[i];
                        }
                    }
                }
            }
        }

        var index = this.points.length;

        this.points.push({ x: point.x, y: point.y, z: point.z });

        var key = this.cellKey(ix, iy, iz);
        var home = this.cells.get(key);

        if (home) {
            home.push(index);
        } else {
            this.cells.set(key, [index]);
        }

        return index;
    };

    /**
     * Newell's method: the area-weighted normal of a polygon, correct for any
     * planar polygon and stable for one whose first three corners are nearly
     * collinear (which a cut facet's often are).
     */
    function polygonNormal(points) {
        var nx = 0;
        var ny = 0;
        var nz = 0;

        for (var i = 0; i < points.length; i++) {
            var current = points[i];
            var next = points[(i + 1) % points.length];

            nx += (current.y - next.y) * (current.z + next.z);
            ny += (current.z - next.z) * (current.x + next.x);
            nz += (current.x - next.x) * (current.y + next.y);
        }

        return { x: nx, y: ny, z: nz };
    }

    /**
     * The facet polygons of a design, as welded vertex-index loops.
     *
     * Returns `{ positions, faces, skipped, duplicateCorners }`:
     * `positions` are the welded corners, `faces` the index loops (already wound
     * to agree with each facet's stored normal), `skipped` the facets that had
     * fewer than three distinct corners and so enclose no area, and
     * `duplicateCorners` how many stored corners the weld collapsed onto a
     * corner the same facet already had -- the .asc path's duplicate-vertex
     * defect, counted so a caller can report it.
     */
    function facetLoops(data, weldTolerance) {
        var welder = new VertexWelder(weldTolerance);
        var faces = [];
        var skipped = 0;
        var duplicateCorners = 0;

        for (var t = 0; t < data.tiers.length; t++) {
            var tier = data.tiers[t];

            for (var i = 0; i < tier.indices.length; i++) {
                var facet = tier.indices[i];
                var points = facet.points || [];
                var loop = [];

                // Weld as we go, and drop a corner that repeats one this facet
                // already has. A repeat is either the .asc duplicate-vertex
                // defect or a corner the polygon closes back onto; either way a
                // repeated index would fan-triangulate into a zero-area sliver.
                for (var p = 0; p < points.length; p++) {
                    var vertex = welder.add(points[p]);

                    if (loop.indexOf(vertex) === -1) {
                        loop.push(vertex);
                    } else {
                        duplicateCorners++;
                    }
                }

                if (loop.length < 3) {
                    skipped++;
                    continue;
                }

                // Wind the loop to agree with the stored facet normal, so every
                // face in the file points the same way (outward). `loader.rs`
                // fans the polygon from its first corner and `mesh.rs` can only
                // flip the whole mesh, not individual faces, so a file with
                // mixed winding is not recoverable downstream.
                var stored = facet.facetNormal;
                var computed = polygonNormal(loop.map(function (index) {
                    return welder.points[index];
                }));

                if (stored) {
                    var agreement = computed.x * stored.x +
                        computed.y * stored.y +
                        computed.z * stored.z;

                    if (agreement < 0) {
                        loop.reverse();
                    }
                }

                faces.push(loop);
            }
        }

        return {
            positions: welder.points,
            faces: faces,
            skipped: skipped,
            duplicateCorners: duplicateCorners
        };
    }

    /** `value` with `decimals` places and no "-0". */
    function formatCoordinate(value, decimals) {
        var text = value.toFixed(decimals);

        return text === "-" + (0).toFixed(decimals) ? (0).toFixed(decimals) : text;
    }

    /** An OBJ object name: OBJ has no quoting, so whitespace has to go. */
    function sanitiseName(name) {
        var cleaned = String(name === undefined || name === null ? "" : name)
            .replace(/\s+/g, "_")
            .replace(/[^A-Za-z0-9._+-]/g, "");

        return cleaned === "" ? "gemcad_design" : cleaned;
    }

    /**
     * OBJ text for a design parsed by `GemCad.importBytes` and friends.
     *
     * `options.name` names the object (the page passes the file name, which is
     * what `GemApp::diagnostics_text` then reports as the model). Throws if the
     * design yields no usable facet, rather than handing the renderer an empty
     * mesh that would render as nothing with no explanation.
     */
    function toObjText(data, options) {
        options = options || {};

        var weldTolerance = options.weldTolerance || DEFAULT_WELD_TOLERANCE;
        var decimals = options.decimals === undefined ? DEFAULT_DECIMALS : options.decimals;
        var name = sanitiseName(options.name);

        if (!data || !data.tiers) {
            throw new Error("not a parsed GemCad design: no tiers");
        }

        var loops = facetLoops(data, weldTolerance);

        if (loops.faces.length === 0) {
            throw new Error("the design has no facet polygons to render");
        }

        var metadata = data.metadata || {};
        var lines = [
            "# Generated from a GemCad design by www/js/gemcad_obj.js.",
            "# One face per facet polygon; coordinates are GemCad model units, optical axis +Z.",
            "# facets: " + loops.faces.length +
                ", vertices: " + loops.positions.length +
                ", tiers: " + data.tiers.length,
            "# gear: " + metadata.gear +
                ", index angle: " + metadata.gearLocationAngle +
                ", symmetry: " + metadata.symmetryFolds +
                (metadata.symmetryMirror ? " fold + mirror" : " fold") +
                ", refractive index: " + metadata.refractiveIndex,
            "o " + name
        ];

        for (var v = 0; v < loops.positions.length; v++) {
            var point = loops.positions[v];

            lines.push("v " +
                formatCoordinate(point.x, decimals) + " " +
                formatCoordinate(point.y, decimals) + " " +
                formatCoordinate(point.z, decimals));
        }

        for (var f = 0; f < loops.faces.length; f++) {
            // OBJ vertex references are 1-based.
            var references = loops.faces[f].map(function (index) {
                return index + 1;
            });

            lines.push("f " + references.join(" "));
        }

        return lines.join("\n") + "\n";
    }

    globalThis.GemCadObj = {
        toObjText: toObjText,
        facetLoops: facetLoops,
        polygonNormal: polygonNormal,
        VertexWelder: VertexWelder,
        sanitiseName: sanitiseName,
        defaults: {
            weldTolerance: DEFAULT_WELD_TOLERANCE,
            decimals: DEFAULT_DECIMALS
        }
    };
}());
