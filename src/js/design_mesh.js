/*
 * design_mesh.js -- builds the rendered stone directly from a design (see
 * design.js), by intersecting the half-spaces of its facet planes, rather
 * than from a parsed file's own corner points (gemcad_obj.js).
 *
 * T-0168: "can you have rust pull from currentDesign instead". Until this
 * file existed, the mesh Rust rendered came from GemCadObj.toObjText, which
 * writes out each facet's *stored* corner points from the parsed file. The
 * cutting-instructions pane, meanwhile, read a completely different
 * representation -- design.js's polar tiers, GemCadDesign.planesOf's derived
 * half-spaces -- that never touched the mesh at all. This file is the bridge:
 * it turns a design's planes into the SAME OBJ text shape GemCadObj.toObjText
 * produces, so the two panes share one source of truth and a future edit to
 * a tier's angle, index or depth only has to rebuild the mesh, not re-parse
 * a file.
 *
 * THE ALGORITHM: intersect half-spaces by clipping one big polygon per plane.
 *
 * A stone cut entirely by planes is always convex (the intersection of
 * half-spaces is convex by definition), so this is the whole job: for each
 * surviving plane, its face on the polytope is exactly that plane's own
 * points that also satisfy every OTHER plane's half-space -- a theorem of
 * polyhedral computation, not a heuristic. Concretely, for plane i:
 *
 *   1. Build a large square lying IN plane i (centred at the plane's own
 *      foot of the perpendicular from the origin, spanned by two orthonormal
 *      tangent vectors), big enough to exceed the design's real extent.
 *   2. Clip that square by every OTHER plane j, in turn, with the ordinary
 *      Sutherland-Hodgman polygon-plane clip (`clipPolygonByPlane`). Each
 *      clip can only shrink a convex polygon, never disconnect it, so no
 *      loop-stitching or edge bookkeeping is needed -- unlike the "clip the
 *      whole polytope, and re-assemble the new face from the boundary
 *      fragments every other face's clip left behind" formulation the
 *      ticket's alternative phrasing ("start from a large box") suggests.
 *      Both compute the same polytope; this one only ever manipulates ONE
 *      polygon at a time, which is what makes it simple to get right.
 *   3. What survives, if anything, is plane i's face. If it is empty (the
 *      plane is redundant -- some other combination of planes already
 *      excludes everything on it) or degenerate (see below), plane i
 *      contributes no face.
 *
 * LIBRARY VS HAND-ROLLED (CLAUDE.md prefers a permissive library).
 *
 * Checked first, as instructed: half-space intersection is the polar dual of
 * a convex hull (build the hull of the points normal_i/offset_i, and its
 * faces are this polytope's vertices), so a 3D convex hull library could do
 * it. Two were fetched and inspected (2026-09-18, npm registry, network
 * available from this machine):
 *
 *   - `quickhull3d` (MIT): ships only as ES modules (`import`/`export` in
 *     dist/index.js) and depends on a second package, `get-plane-normal`.
 *     make_page.py refuses a template containing an ES import, by design (no
 *     bundler, no fetch, works from file://), and there is no UMD/classic
 *     build in the published package -- it cannot be inlined without adding a
 *     bundling step this project deliberately does not have.
 *   - `convex-hull` (mikolalysenko, MIT): CommonJS (`require`/
 *     `module.exports`) across four packages (itself plus `affine-hull`,
 *     `incremental-convex-hull`, `monotone-convex-hull-2d`), none a single
 *     inlinable file either, and would need all four vendored with their own
 *     licence notices for one feature.
 *   - The one dependency-free classic script found under the name
 *     "quickhull" (Clay Gulick, MIT, single file) turned out to be the
 *     *2D* Quickhull -- useless here.
 *
 * No candidate is a classic script that could be pasted into www/js/ and
 * inlined by make_page.py the way gemcad.js and gemcad_obj.js are, so this
 * hand-rolls the clip instead, per CLAUDE.md's own fallback. A second reason
 * favours hand-rolling even if a suitable library existed: the duality
 * approach loses the plane a hull face came from unless the hull code is
 * modified to carry it through, where the direct clip has it for free (each
 * face IS the result of clipping ITS OWN plane), and this project already
 * wants that correspondence for facet<->tier mapping (see the doc comment on
 * `buildFaces`'s return value).
 *
 * NUMERICAL ROBUSTNESS.
 *
 * Two things can go wrong that a plain clip will not detect by itself:
 *
 *   - The initial square can be too small, so a face's true boundary runs off
 *     its edge and the clip returns a polygon bounded in part by the SQUARE,
 *     not by a real design plane -- a wrong but perfectly convex-looking
 *     face. `buildFaces` checks this directly: every edge of every surviving
 *     face must lie on some OTHER plane (both endpoints within
 *     BOUNDARY_TOLERANCE of it), or the whole build is rejected. The square
 *     is sized generously (SQUARE_SCALE times the largest facet offset) so
 *     this is not expected to fire in practice; it exists as a check, not a
 *     tuning knob.
 *   - Near-coincident meet points (see kb/the-polar-internal-representation.md:
 *     a Gem Cut Studio meet-point solved facet can sit up to 1.3e-5 of a
 *     tooth off its nominal tooth) mean two faces that share a real vertex
 *     can each compute it via a slightly different sequence of clips and
 *     land a float epsilon apart. `weldFaces` collapses these with the same
 *     spatial-hash welder gemcad_obj.js already uses and already ships
 *     (`GemCadObj.VertexWelder`), reused rather than duplicated.
 *
 * See kb/design-mesh-builder.md for the measured tolerances and how they were
 * derived, and `meshPlanes` below for which tiers are left out (hidden ones;
 * preform tiers are cut normally since 2026-09-19).
 *
 * A classic browser script, like design.js: no ES import/export, nothing
 * loaded over the network, public surface published as globalThis.DesignMesh
 * so make_page.py can inline it. Depends on GemCadDesign (design.js) and
 * GemCadObj (gemcad_obj.js), both already loaded earlier in the same bundle.
 */

(function () {
    "use strict";

    /* How much bigger than the design's own scale the initial per-plane
     * square is. Too small and a face's boundary can run off the square's
     * own edge (caught by the boundary check below, not silently accepted);
     * too large and float precision in the clip's intermediate points is
     * wasted on magnitude the final, much smaller, polygon never uses.
     * 200x the largest facet offset leaves three more orders of magnitude
     * of headroom than any real design in this project's corpus needs (see
     * kb/design-mesh-builder.md for the measured worst case), while keeping
     * intermediate coordinates in the hundreds to low thousands of model
     * units for designs that are themselves a few units across -- nowhere
     * near where f64 rounding of a subtraction against an O(1) offset would
     * start to matter (relative error ~1e-16 * magnitude). */
    var SQUARE_SCALE = 200;

    /* A point counts as "inside" a half-space up to this much past its
     * boundary, scaled by (1 + the design's largest offset). Exists so a
     * vertex that is ANALYTICALLY exactly on a plane (every real polytope
     * vertex is exactly on at least three) is not thrown to the wrong side
     * of a `<=` comparison by float noise from the clip that produced it.
     * See kb/design-mesh-builder.md for the measurement this is set from. */
    var PLANE_EPSILON_SCALE = 1e-9;

    /* Consecutive polygon points closer together than this, scaled the same
     * way, are collapsed to one point DURING clipping, so a near-zero-length
     * edge introduced by one clip does not compound through the next 50-200
     * clips into something worse. Deliberately tighter than the final global
     * weld below -- this is cleanup of the algorithm's own intermediate
     * output, not a tolerance on the design's real geometry. */
    var DEDUPE_TOLERANCE_SCALE = 1e-9;

    /* How far, scaled the same way, a face edge's endpoints may sit from
     * some OTHER plane and still count as lying on it -- the check that
     * catches an undersized initial square (see the doc comment above).
     * Measured, not guessed: see kb/design-mesh-builder.md. */
    var BOUNDARY_TOLERANCE_SCALE = 1e-6;

    /* A face's Newell normal magnitude (twice its area) below this, scaled
     * by the square of (1 + the largest offset), is treated as no face at
     * all -- a sliver left by two facet planes that are nearly, but not
     * exactly, coincident. Measured: see kb/design-mesh-builder.md. */
    var AREA_TOLERANCE_SCALE = 1e-9;

    /* The final cross-face vertex weld, in the SAME model units as
     * gemcad_obj.js's own DEFAULT_WELD_TOLERANCE (1e-6): designs in this
     * project are consistently about one unit across (GemCad's own cube of
     * half-size 10 for .asc reconstruction), so the two tolerances describe
     * the same physical slack and are kept numerically equal on purpose. */
    var DEFAULT_WELD_TOLERANCE = 1e-6;

    var DEFAULT_DECIMALS = 9;

    /* How many times to double the initial square before giving up and
     * reporting an unresolved boundary. Generous headroom (SQUARE_SCALE)
     * means this is not expected to ever iterate past 0, but a design this
     * project has not seen yet is exactly the case worth not hard-failing
     * on the first try. */
    var MAX_BOUNDARY_RETRIES = 4;

    /* ---------------------------------------------------------------- *
     * Small vector helpers
     * ---------------------------------------------------------------- */

    function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
    function cross(a, b) {
        return {
            x: a.y * b.z - a.z * b.y,
            y: a.z * b.x - a.x * b.z,
            z: a.x * b.y - a.y * b.x
        };
    }
    function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
    /* Math.hypot is overflow/underflow-safe at a cost of several times the
     * work of a plain sqrt; this file's own coordinate-scale comments (see
     * SQUARE_SCALE above) already establish that every point here is within
     * a few thousand model units of the origin, nowhere near where that
     * safety would matter, and this is on the hottest path in the file
     * (called once per kept point in every polygon clip -- see T-0194). */
    function length(a) { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
    function normalize(a) {
        var len = length(a);
        return { x: a.x / len, y: a.y / len, z: a.z / len };
    }

    /**
     * Two unit vectors orthogonal to `normal` and to each other, chosen so
     * `cross(t1, t2)` agrees with `normal`'s own direction (not load-bearing
     * for correctness -- `buildFaces` fixes a face's winding against its
     * plane's normal afterwards regardless -- but keeps the un-clipped
     * square already wound the right way in the common case).
     *
     * The seed vector is +X unless `normal` is close to +X, in which case
     * +Y is used instead, so the cross product is never taken between two
     * near-parallel vectors.
     */
    function orthonormalTangents(normal) {
        var seed = Math.abs(normal.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
        var t1 = normalize(cross(seed, normal));
        var t2 = cross(normal, t1);

        return [t1, t2];
    }

    /* ---------------------------------------------------------------- *
     * The clip
     * ---------------------------------------------------------------- */

    /**
     * Sutherland-Hodgman: `polygon` (a planar loop of 3D points, either
     * winding direction) clipped to the half-space `dot(normal, p) <= offset
     * + eps`. Correct for any convex polygon; the design's planes are only
     * ever used to clip a face that is itself the intersection of
     * half-spaces, which is convex by construction, so convexity is
     * maintained throughout -- this never has to handle a clip that would
     * split a polygon into two pieces.
     */
    function clipPolygonByPlane(polygon, normal, offset, eps) {
        if (polygon.length === 0) {
            return polygon;
        }

        var output = [];
        var n = polygon.length;

        for (var i = 0; i < n; i++) {
            var current = polygon[i];
            var next = polygon[(i + 1) % n];
            var da = dot(normal, current) - offset;
            var db = dot(normal, next) - offset;
            var currentIn = da <= eps;
            var nextIn = db <= eps;

            if (currentIn) {
                output.push(current);
            }

            if (currentIn !== nextIn) {
                // da and db have (numerically) opposite signs relative to
                // the plane, so this division is never by ~0 unless the
                // whole edge is degenerate, which dedupeConsecutive removes
                // before it would ever reach here.
                var t = da / (da - db);

                output.push({
                    x: current.x + (next.x - current.x) * t,
                    y: current.y + (next.y - current.y) * t,
                    z: current.z + (next.z - current.z) * t
                });
            }
        }

        return output;
    }

    /** True when every point of `polygon` already satisfies the half-space
     * `dot(normal, p) <= offset + eps`, i.e. clipping by it would leave the
     * polygon unchanged. Checking this first is one allocation-free pass
     * over the (small, already-shrunk) polygon, against `clipPolygonByPlane`
     * + `dedupeConsecutive`'s two fresh arrays -- and it is true for MOST
     * planes once a design has more than a handful of facets, since a
     * facet's final face only ever borders a few neighbours, not every
     * other plane in the design. That turns `polygonForPlane`'s O(planes)
     * clips, each allocating, into O(planes) cheap scans plus only the few
     * clips that actually shrink the polygon -- see T-0194. */
    function allInsideHalfSpace(polygon, normal, offset, eps) {
        for (var i = 0; i < polygon.length; i++) {
            if (dot(normal, polygon[i]) - offset > eps) {
                return false;
            }
        }

        return true;
    }

    /** Collapses consecutive points (including the wrap-around edge) closer
     * than `tol`, so a near-zero-length edge from one clip does not survive
     * into the next. */
    function dedupeConsecutive(polygon, tol) {
        if (polygon.length < 2) {
            return polygon;
        }

        var output = [];

        for (var i = 0; i < polygon.length; i++) {
            var point = polygon[i];
            var previous = output.length > 0 ? output[output.length - 1] : null;

            if (!previous || length(sub(point, previous)) > tol) {
                output.push(point);
            }
        }

        // The wrap-around edge, last point back to first, needs the same check.
        while (output.length > 1 &&
            length(sub(output[output.length - 1], output[0])) <= tol) {
            output.pop();
        }

        return output;
    }

    /** Squared distance between two points -- `length(sub(a, b))` without
     * `sub`'s intermediate object allocation or the sqrt, for callers that
     * only ever compare it to another squared distance. */
    function squaredDistance(a, b) {
        var dx = a.x - b.x;
        var dy = a.y - b.y;
        var dz = a.z - b.z;

        return dx * dx + dy * dy + dz * dz;
    }

    /**
     * `clipPolygonByPlane` followed by `dedupeConsecutive`, fused into one
     * pass so a clip that survives (most of them, in a densely-faceted
     * design -- see `allInsideHalfSpace`'s comment) allocates one output
     * array instead of two, walks the points once instead of twice, and
     * dedupes by squared distance so neither path allocates a `sub()`
     * intermediate or calls `sqrt` (`tol` is always >= 0, being one of the
     * *_TOLERANCE_SCALE constants above, so `dist > tol` iff `distSq >
     * tol*tol`). Deduplicates against the last KEPT point exactly as the
     * two-step `dedupeConsecutive(clipPolygonByPlane(...))` pipeline does
     * (including the wrap-around check), so this is not an approximation --
     * same points, same order, far less allocation. The push-if-far-enough
     * check is duplicated at its two call sites rather than factored into a
     * closure, because this runs hundreds of thousands of times per rebuild
     * on a design like Darts.gem or The_Arkenstone_of_Thrain.gem (T-0194),
     * and a closure defined inside this function would itself be a fresh
     * allocation on every call. `polygonForPlane`'s hot loop uses this;
     * `clipPolygonByPlane` and `dedupeConsecutive` stay separate and
     * exported since design_mesh_test.js exercises each primitive in
     * isolation.
     */
    function clipAndDedupe(polygon, normal, offset, eps, tol) {
        if (polygon.length === 0) {
            return polygon;
        }

        var output = [];
        var n = polygon.length;
        var tolSq = tol * tol;

        for (var i = 0; i < n; i++) {
            var current = polygon[i];
            var next = polygon[(i + 1) % n];
            var da = dot(normal, current) - offset;
            var db = dot(normal, next) - offset;
            var currentIn = da <= eps;
            var nextIn = db <= eps;

            if (currentIn) {
                var lastKept = output.length > 0 ? output[output.length - 1] : null;

                if (!lastKept || squaredDistance(current, lastKept) > tolSq) {
                    output.push(current);
                }
            }

            if (currentIn !== nextIn) {
                var t = da / (da - db);
                var meet = {
                    x: current.x + (next.x - current.x) * t,
                    y: current.y + (next.y - current.y) * t,
                    z: current.z + (next.z - current.z) * t
                };
                var lastKept2 = output.length > 0 ? output[output.length - 1] : null;

                if (!lastKept2 || squaredDistance(meet, lastKept2) > tolSq) {
                    output.push(meet);
                }
            }
        }

        while (output.length > 1 && squaredDistance(output[output.length - 1], output[0]) <= tolSq) {
            output.pop();
        }

        return output;
    }

    /**
     * The polygon plane `planeIndex` (in `planes`) contributes to the
     * polytope: a large square in that plane, clipped down by every OTHER
     * plane's half-space. May return a polygon with fewer than 3 points
     * (including none), meaning the plane contributes no face at all --
     * either it is entirely redundant (some other planes already exclude
     * everything on it), or (rare; see `buildFaces`) the initial square was
     * too small for this design's scale.
     */
    function polygonForPlane(planeIndex, planes, halfSize, planeEps, dedupeTol) {
        var plane = planes[planeIndex];
        var tangents = orthonormalTangents(plane.normal);
        var t1 = tangents[0];
        var t2 = tangents[1];
        var center = {
            x: plane.normal.x * plane.offset,
            y: plane.normal.y * plane.offset,
            z: plane.normal.z * plane.offset
        };

        function corner(s1, s2) {
            return {
                x: center.x + t1.x * s1 + t2.x * s2,
                y: center.y + t1.y * s1 + t2.y * s2,
                z: center.z + t1.z * s1 + t2.z * s2
            };
        }

        var polygon = [
            corner(halfSize, halfSize),
            corner(-halfSize, halfSize),
            corner(-halfSize, -halfSize),
            corner(halfSize, -halfSize)
        ];

        for (var j = 0; j < planes.length && polygon.length > 0; j++) {
            if (j === planeIndex) {
                continue;
            }

            if (allInsideHalfSpace(polygon, planes[j].normal, planes[j].offset, planeEps)) {
                continue;
            }

            polygon = clipAndDedupe(polygon, planes[j].normal, planes[j].offset, planeEps, dedupeTol);
        }

        return polygon;
    }

    /** True when both `a` and `b` sit within `tol` of plane `planes[m]`,
     * i.e. the edge `a`-`b` could plausibly lie ON that plane. */
    function edgeLiesOnPlane(a, b, plane, tol) {
        return Math.abs(dot(plane.normal, a) - plane.offset) < tol &&
            Math.abs(dot(plane.normal, b) - plane.offset) < tol;
    }

    /** True when edge `a`-`b` of face `skipIndex` lies on some plane other
     * than its own -- see `buildFaces`'s doc comment on the boundary check. */
    function edgeResolves(a, b, planes, skipIndex, tol) {
        for (var m = 0; m < planes.length; m++) {
            if (m === skipIndex) {
                continue;
            }

            if (edgeLiesOnPlane(a, b, planes[m], tol)) {
                return true;
            }
        }

        return false;
    }

    /**
     * A design's planes (see `GemCadDesign.planesOf`), excluding any tier the
     * user HID with the tier toolbar (T-0178): it stays in the design and the
     * cutting instructions but is left out of the stone. The rule lives in
     * `GemCadDesign.isRenderedTier`, which the page's facet<->tier map uses
     * too, so the two can never disagree about which tiers are on the stone.
     *
     * PREFORM TIERS ARE CUT NORMALLY, since 2026-09-19 (the user: "the teeth
     * need to have the {} and cut it normally"). A `.gem` file can mark a run
     * of tiers, following a literal "PREFORM" line in its trailer text, as
     * `isPreform`, and the MIT-licensed reference viewer this project's
     * GemCad reader is ported from (`buildPolygonMesh` in its TestViewer)
     * skips their triangles. This builder did the same until the user's
     * ruling; now a preform tier's planes cut the stone like any other, and
     * the flag only changes how its teeth are written ({3, 19, 35}) and, in
     * the future edit mode, keeps the tier in the list even when a deeper
     * facet cuts it away completely, because its meetpoints are still needed.
     * A preform tier that later facets do cut away is a redundant plane here,
     * dropped as `droppedDegenerate`, so it changes nothing on the stone.
     */
    function meshPlanes(design) {
        return GemCadDesign.renderedPlanesOf(design);
    }

    /**
     * `planes` without any plane that coincides with an EARLIER one (normal
     * components within `normalTol`, offset within `offsetTol`), and how many
     * were dropped. The earlier plane is kept, so its face keeps its own tier,
     * which is also the tier the page's nearest-normal match
     * (`matchNormalToPlanes`, first best wins) files a tied facet under.
     *
     * WHY. Two coincident half-spaces are one half-space, but the clip keeps
     * both planes' faces (each lies within `planeEps` of the other), so the
     * mesh gets two overlapping copies of that face -- non-manifold. This
     * never arose while preform tiers were left out, and did as soon as they
     * were cut normally (2026-09-19): a GemCad PREFORM section commonly
     * repeats the design's girdle tiers exactly. Measured on the 26 corpus
     * designs with a PREFORM section: 19 built non-manifold meshes (10 to 180
     * bad edges each, e.g. Isotangle.gem's G6..G10 repeating G1..G5) before
     * this, none after.
     */
    function dropCoincidentPlanes(planes, normalTol, offsetTol) {
        var kept = [];

        planes.forEach(function (plane) {
            var duplicate = kept.some(function (other) {
                return Math.abs(plane.normal.x - other.normal.x) < normalTol &&
                    Math.abs(plane.normal.y - other.normal.y) < normalTol &&
                    Math.abs(plane.normal.z - other.normal.z) < normalTol &&
                    Math.abs(plane.offset - other.offset) < offsetTol;
            });

            if (!duplicate) {
                kept.push(plane);
            }
        });

        return { planes: kept, dropped: planes.length - kept.length };
    }

    /**
     * Intersects a design's facet half-spaces into a convex polytope's
     * faces. Returns `{ faces, planes, droppedDegenerate, halfSize }`:
     *
     *   `faces`: one entry per surviving plane, `{ polygon, planeIndex,
     *   tier, facet }` -- `polygon` a closed loop of 3D points already
     *   wound outward, `tier`/`facet` indices into `design.tiers[tier]
     *   .facets[facet]`, the SAME plane that produced it. This is the exact
     *   plane<->face correspondence design.js's own `matchNormalToPlanes`
     *   has to recover approximately, by nearest normal, for a mesh that
     *   came from somewhere else (T-0160). A caller building THIS mesh
     *   could therefore build an exact facet<->tier map for free, by
     *   assigning face polygons to OBJ faces in the same order this
     *   returns them and reading `tier`/`facet` back off the index -- NOT
     *   done here, since `buildFacetTierMap`'s existing normal-match
     *   already works (see kb/design-mesh-builder.md for the measured
     *   agreement) and this ticket was told not to restructure it if so.
     *
     *   `planes`: the plane list actually used (hidden tiers excluded, see
     *   `meshPlanes`; a plane coinciding with an earlier one dropped, see
     *   `dropCoincidentPlanes`).
     *   `droppedDegenerate`: how many candidate planes contributed no face
     *   (redundant, or too small an area to keep -- see AREA_TOLERANCE_SCALE).
     *   `droppedCoincident`: how many planes were dropped as coincident.
     *
     * Throws if the design has no rendered planes, if every plane
     * contributed no face, or if a face's boundary could not be resolved
     * against the OTHER planes even after growing the initial square
     * `MAX_BOUNDARY_RETRIES` times (see the doc comment at the top of this
     * file). The caller (`toObjText`, and ultimately `objTextFromBytes` in
     * the page) is expected to catch this and fall back to the file's own
     * corners, per T-0168's rule that a builder failure must never block a
     * load.
     */
    function buildFaces(design, options) {
        options = options || {};

        var planes = meshPlanes(design);

        if (planes.length === 0) {
            throw new Error("design has no rendered (non-hidden) facet planes to build a mesh from");
        }

        var maxOffset = planes.reduce(function (m, p) {
            return Math.max(m, Math.abs(p.offset));
        }, 0) || 1;

        var scale = 1 + maxOffset;
        var planeEps = options.planeEpsilon !== undefined
            ? options.planeEpsilon : PLANE_EPSILON_SCALE * scale;
        var dedupeTol = options.dedupeTolerance !== undefined
            ? options.dedupeTolerance : DEDUPE_TOLERANCE_SCALE * scale;
        var boundaryTol = options.boundaryTolerance !== undefined
            ? options.boundaryTolerance : BOUNDARY_TOLERANCE_SCALE * scale;
        var areaTolerance = options.areaTolerance !== undefined
            ? options.areaTolerance : AREA_TOLERANCE_SCALE * scale * scale;
        var halfSize = options.halfSize !== undefined
            ? options.halfSize : SQUARE_SCALE * scale;

        // Normals are unit vectors, so an absolute 1e-9 per component; offsets
        // use the same scaled tolerance as the boundary check.
        var coincident = dropCoincidentPlanes(planes, 1e-9, boundaryTol);

        planes = coincident.planes;

        var attempt = 0;
        var faces;
        var droppedDegenerate;
        var unresolved;

        for (;;) {
            faces = [];
            droppedDegenerate = 0;
            unresolved = [];

            for (var i = 0; i < planes.length; i++) {
                var polygon = polygonForPlane(i, planes, halfSize, planeEps, dedupeTol);

                polygon = dedupeConsecutive(polygon, dedupeTol);

                if (polygon.length < 3) {
                    droppedDegenerate++;
                    continue;
                }

                var normal = GemCadObj.polygonNormal(polygon);
                var normalLength = length(normal);

                if (normalLength < areaTolerance) {
                    droppedDegenerate++;
                    continue;
                }

                if (dot(normal, planes[i].normal) < 0) {
                    polygon.reverse();
                }

                for (var e = 0; e < polygon.length; e++) {
                    var a = polygon[e];
                    var b = polygon[(e + 1) % polygon.length];

                    if (!edgeResolves(a, b, planes, i, boundaryTol)) {
                        unresolved.push({ plane: i, edge: e });
                    }
                }

                faces.push({
                    polygon: polygon,
                    planeIndex: i,
                    tier: planes[i].tier,
                    facet: planes[i].facet
                });
            }

            if (unresolved.length === 0 || attempt >= MAX_BOUNDARY_RETRIES) {
                break;
            }

            attempt++;
            halfSize *= 2;
        }

        if (unresolved.length > 0) {
            throw new Error(
                "design mesh builder: " + unresolved.length + " face edge(s) did not " +
                "resolve against another facet plane after " + (attempt + 1) +
                " attempt(s) growing the bounding square -- the design may not be closed"
            );
        }

        if (faces.length === 0) {
            throw new Error("design produced no facet polygons");
        }

        return {
            faces: faces,
            planes: planes,
            droppedDegenerate: droppedDegenerate,
            droppedCoincident: coincident.dropped,
            halfSize: halfSize
        };
    }

    /**
     * Welds `built.faces`'s polygons (see `buildFaces`) into shared vertex
     * indices, via the SAME spatial-hash welder `gemcad_obj.js` already
     * uses for the file-corner path (`GemCadObj.VertexWelder`), reused
     * rather than reimplemented. Returns `{ positions, loops }`, `loops`
     * carrying each face's `planeIndex`/`tier`/`facet` through alongside its
     * welded index loop.
     */
    function weldFaces(built, weldTolerance) {
        var welder = new GemCadObj.VertexWelder(weldTolerance);
        var loops = [];

        for (var f = 0; f < built.faces.length; f++) {
            var face = built.faces[f];
            var loop = [];

            for (var p = 0; p < face.polygon.length; p++) {
                var vertex = welder.add(face.polygon[p]);

                if (loop.indexOf(vertex) === -1) {
                    loop.push(vertex);
                }
            }

            if (loop.length >= 3) {
                loops.push({ indices: loop, planeIndex: face.planeIndex, tier: face.tier, facet: face.facet });
            }
        }

        return { positions: welder.points, loops: loops };
    }

    /** `value` with `decimals` places and no "-0" -- identical in behaviour to
     * gemcad_obj.js's own `formatCoordinate`, duplicated rather than
     * imported because neither file depends on the other and this is four
     * lines. */
    function formatCoordinate(value, decimals) {
        var text = value.toFixed(decimals);

        return text === "-" + (0).toFixed(decimals) ? (0).toFixed(decimals) : text;
    }

    /**
     * OBJ text for a design (see design.js), built by intersecting its own
     * facet planes rather than reading a parsed file's stored corners --
     * see this file's own header comment for the algorithm and why it is
     * hand-rolled. Throws under the same conditions `buildFaces` and
     * `weldFaces` do (no usable faces); the caller is expected to catch
     * this and fall back to `GemCadObj.toObjText` off the same parse, per
     * T-0168.
     */
    function toObjText(design, options) {
        options = options || {};

        var weldTolerance = options.weldTolerance !== undefined
            ? options.weldTolerance : DEFAULT_WELD_TOLERANCE;
        var decimals = options.decimals === undefined ? DEFAULT_DECIMALS : options.decimals;
        var name = GemCadObj.sanitiseName(options.name);

        var built = buildFaces(design, options);
        var welded = weldFaces(built, weldTolerance);

        if (welded.loops.length === 0) {
            throw new Error("design mesh has no facet polygons after welding");
        }

        var lines = [
            "# Generated from a design's own facet planes by www/js/design_mesh.js.",
            "# One face per surviving plane; coordinates are the design's model units, optical axis +Z.",
            "# facets: " + welded.loops.length +
                ", vertices: " + welded.positions.length +
                ", tiers: " + design.tiers.length +
                ", candidate planes: " + built.planes.length +
                ", dropped: " + built.droppedDegenerate,
            "o " + name
        ];

        for (var v = 0; v < welded.positions.length; v++) {
            var point = welded.positions[v];

            lines.push("v " +
                formatCoordinate(point.x, decimals) + " " +
                formatCoordinate(point.y, decimals) + " " +
                formatCoordinate(point.z, decimals));
        }

        for (var f = 0; f < welded.loops.length; f++) {
            var references = welded.loops[f].indices.map(function (index) {
                return index + 1;
            });

            lines.push("f " + references.join(" "));
        }

        return lines.join("\n") + "\n";
    }

    globalThis.DesignMesh = {
        toObjText: toObjText,
        buildFaces: buildFaces,
        weldFaces: weldFaces,
        meshPlanes: meshPlanes,
        dropCoincidentPlanes: dropCoincidentPlanes,
        clipPolygonByPlane: clipPolygonByPlane,
        allInsideHalfSpace: allInsideHalfSpace,
        clipAndDedupe: clipAndDedupe,
        dedupeConsecutive: dedupeConsecutive,
        polygonForPlane: polygonForPlane,
        orthonormalTangents: orthonormalTangents,
        defaults: {
            weldTolerance: DEFAULT_WELD_TOLERANCE,
            decimals: DEFAULT_DECIMALS,
            squareScale: SQUARE_SCALE,
            planeEpsilonScale: PLANE_EPSILON_SCALE,
            dedupeToleranceScale: DEDUPE_TOLERANCE_SCALE,
            boundaryToleranceScale: BOUNDARY_TOLERANCE_SCALE,
            areaToleranceScale: AREA_TOLERANCE_SCALE
        }
    };
}());
