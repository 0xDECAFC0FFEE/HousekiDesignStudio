/*
 * design_mesh_test.js -- tests for www/js/design_mesh.js, which builds the
 * OBJ text `GemApp` renders directly from a design's own facet planes
 * (design.js's GemCadDesign.planesOf), by intersecting their half-spaces --
 * as opposed to gemcad_obj.js's GemCadObj.toObjText, which writes out a
 * parsed FILE's own stored corner points.
 *
 * HOW TO RUN
 *   deno test --allow-read www/js/tests/
 *
 * Node on this machine is broken; Deno is the runtime, as for every sibling
 * suite. No third-party dependencies.
 *
 * WHAT THIS SUITE IS FOR
 *   Two different things need proving, and the tests are grouped that way:
 *
 *   1. The clip primitives themselves (Sutherland-Hodgman polygon-plane
 *      clipping, the tangent-basis construction, the near-duplicate-point
 *      collapse) are correct in isolation, on small hand-checkable inputs
 *      where the expected answer can be written down directly.
 *
 *   2. The whole pipeline -- planes in, watertight outward-wound OBJ text
 *      out -- is correct on real designs, checked the SAME way
 *      gemcad_obj_test.js checks the file-corner writer (an independent OBJ
 *      re-parser, edge-use statistics for watertightness, the
 *      divergence-theorem volume for winding), so a bug in either writer
 *      would be caught the same way. The oracle here is a HAND-MADE CUBE
 *      (an exact answer, not just "looks plausible") plus two real designs
 *      (SRB.asc, no rounding traps at all -- every tier's angle is exact
 *      at 2 decimals -- and resources/hex_cut_v2.gcs, the startup stone, whose
 *      C3/C4/C6 tiers ARE meet-point solved and so exercise the one
 *      documented source of expected disagreement with the file-corner
 *      mesh; see kb/building-the-stone-mesh-from-a-design-s-own-face.md).
 */

// ---------------------------------------------------------------------------
// Minimal assertion helpers (no dependencies; a thrown Error fails a Deno test)
// ---------------------------------------------------------------------------

function assert(condition, message) {
    if (!condition) {
        throw new Error("assertion failed: " + (message || ""));
    }
}

function assertEquals(actual, expected, message) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        throw new Error(
            "assertion failed: " + (message || "") + "\n  actual:   " + a + "\n  expected: " + e);
    }
}

function assertClose(actual, expected, tolerance, message) {
    if (!(Math.abs(actual - expected) <= tolerance)) {
        throw new Error("assertion failed: " + (message || "") +
            "\n  actual:   " + actual + "\n  expected: " + expected +
            "\n  |diff|:   " + Math.abs(actual - expected) + " > " + tolerance);
    }
}

// ---------------------------------------------------------------------------
// Loading the libraries under test, and the ones they depend on, exactly the
// way the page loads them: classic scripts, evaluated in the global scope
// with indirect eval. Order matters -- design_mesh.js is written against
// GemCadDesign (design.js) and GemCadObj (gemcad_obj.js), which must exist
// first; gemcad.js and gcs.js are only needed by THIS TEST FILE, to build
// real designs to feed the builder, not by design_mesh.js itself.
// ---------------------------------------------------------------------------

const READER_URL = new URL("../gemcad.js", import.meta.url);
const WRITER_URL = new URL("../gemcad_obj.js", import.meta.url);
const DESIGN_URL = new URL("../design.js", import.meta.url);
const GCS_READER_URL = new URL("../gcs.js", import.meta.url);
const MESH_URL = new URL("../design_mesh.js", import.meta.url);
const SAMPLES_URL = new URL("../../../reference/gemcad-file-reader/Samples/", import.meta.url);
const HEX_CUT_V2_GCS_URL = new URL("../../resources/hex_cut_v2.gcs", import.meta.url);

// ---------------------------------------------------------------------------
// WHY ONE TEST BELOW IS SKIPPED RATHER THAN RUN
//
// reference/ is third-party data -- the vendored GemCad sample files among it --
// several hundred megabytes of it, deliberately gitignored, so a fresh clone of
// this repository has none of it, and the suite still has to be green there. The
// one test that reads a sample (SRB.asc) is therefore marked
// `{ ignore: !SAMPLES_PRESENT }` and reports as ignored when the data is absent,
// instead of erroring on a missing file; with the data present it runs exactly
// as before. Nothing else here is gated: the clip primitives and the hand-made
// cube need no files at all, and resources/hex_cut_v2.gcs is checked in.
// ---------------------------------------------------------------------------

/** True when `url` is on disk; false when it is not, whatever the reason. */
function present(url) {
    try {
        Deno.statSync(url);

        return true;
    } catch {
        return false;
    }
}

const SAMPLES_PRESENT = present(SAMPLES_URL);

(0, eval)(await Deno.readTextFile(READER_URL));
(0, eval)(await Deno.readTextFile(WRITER_URL));
(0, eval)(await Deno.readTextFile(DESIGN_URL));
(0, eval)(await Deno.readTextFile(GCS_READER_URL));
(0, eval)(await Deno.readTextFile(MESH_URL));

const GemCad = globalThis.GemCad;
const GemCadObj = globalThis.GemCadObj;
const GemCadDesign = globalThis.GemCadDesign;
const GemCutStudio = globalThis.GemCutStudio;
const DesignMesh = globalThis.DesignMesh;

// ---------------------------------------------------------------------------
// Shared geometry helpers, deliberately duplicated from gemcad_obj_test.js
// rather than imported (that file is a test file too, with no public
// surface, and both suites want to keep working if either is deleted). See
// that file's own comment for why these particular three checks (an
// independent OBJ parser, edge-use statistics, the fan-triangulated
// divergence-theorem volume) are what actually catch a mis-built mesh.
// ---------------------------------------------------------------------------

function parseObj(text) {
    const positions = [];
    const faces = [];

    for (const line of text.split("\n")) {
        const parts = line.trim().split(/\s+/);

        if (parts[0] === "v") {
            positions.push({ x: Number(parts[1]), y: Number(parts[2]), z: Number(parts[3]) });
        } else if (parts[0] === "f") {
            faces.push(parts.slice(1).map(part => Number(part.split("/")[0]) - 1));
        }
    }

    return { positions, faces };
}

function edgeStatistics(faces) {
    const uses = new Map();

    for (const face of faces) {
        for (let i = 0; i < face.length; i++) {
            const from = face[i];
            const to = face[(i + 1) % face.length];
            const key = from < to ? from + ":" + to : to + ":" + from;
            const entry = uses.get(key) || { forward: 0, backward: 0 };

            if (from < to) {
                entry.forward++;
            } else {
                entry.backward++;
            }

            uses.set(key, entry);
        }
    }

    const stats = { manifold: 0, boundary: 0, nonManifold: 0 };

    for (const { forward, backward } of uses.values()) {
        if (forward === 1 && backward === 1) {
            stats.manifold++;
        } else if (forward + backward === 1) {
            stats.boundary++;
        } else {
            stats.nonManifold++;
        }
    }

    return stats;
}

function signedVolumeTimesSix(positions, faces) {
    let total = 0;

    for (const face of faces) {
        for (let i = 1; i + 1 < face.length; i++) {
            const a = positions[face[0]];
            const b = positions[face[i]];
            const c = positions[face[i + 1]];

            total += a.x * (b.y * c.z - b.z * c.y) +
                a.y * (b.z * c.x - b.x * c.z) +
                a.z * (b.x * c.y - b.y * c.x);
        }
    }

    return total;
}

/** Reads a sample design and parses it, e.g. sample("SRB", "asc"). */
async function sample(design, extension) {
    const bytes = await Deno.readFile(new URL(design + "." + extension, SAMPLES_URL));

    return GemCad.importBytes(bytes);
}

// ---------------------------------------------------------------------------
// A hand-made design: a cube of half-size 1, centred on the origin.
//
// Six planes, chosen by hand from design.js's own normalOf formula (a design
// object is data, not something design.js constructs for you, so this is
// worked out on paper, the way a real design file's tiers were, and checked
// against the exact answer -- 8 vertices, 6 faces, volume 8 -- rather than
// against anything design_mesh.js itself produces):
//
//   +Z / -Z (the "table" and its opposite): mast angle 0 and 180. Both are
//   ON the optical axis (normalOf's sin(polar) term is 0 there), so the
//   facet's index number is irrelevant to its normal -- 0 is used for both,
//   arbitrarily, exactly as a real on-axis facet's index is (see design.js's
//   own polarOf comment on this degeneracy).
//
//   +-X / +-Y (the four sides): mast angle 90 (a "girdle" angle -- nothing
//   here depends on index.template.html's UI labelling, only on the plane
//   geometry, so this is fine for a bare design object) on a 4-tooth gear
//   with originIndex 0, so step = 360/4 = 90 degrees per tooth and azimuth
//   = index * 90: index 0 -> +Y, 1 -> +X, 2 -> -Y, 3 -> -X (normalOf's
//   azimuth convention is measured from +Y towards +X, GemCad's wheel
//   zero -- see design.js's own header comment).
//
// Every plane's offset is 1, putting each face 1 unit from the origin along
// its own normal -- a cube from -1 to 1 on every axis.
// ---------------------------------------------------------------------------

function makeCubeDesign() {
    return {
        v: GemCadDesign.SCHEMA_VERSION,
        name: "unit cube",
        gear: { teeth: 4, reversed: false, originIndex: 0 },
        symmetry: { folds: 1, mirror: false },
        refractiveIndex: 0,
        tiers: [
            { angle: 0, distance: 1, preform: false, cuttingInstructions: "", facets: [{ index: 0, name: "top" }] },
            { angle: 180, distance: 1, preform: false, cuttingInstructions: "", facets: [{ index: 0, name: "bottom" }] },
            {
                angle: 90, distance: 1, preform: false, cuttingInstructions: "",
                facets: [
                    { index: 0, name: "+y" },
                    { index: 1, name: "+x" },
                    { index: 2, name: "-y" },
                    { index: 3, name: "-x" }
                ]
            }
        ],
        headers: [],
        footnotes: []
    };
}

// ===========================================================================
// 1. Clip primitives, on small hand-checkable inputs
// ===========================================================================

/*
 * Setup: a unit square in the z=0 plane (four corners at +-1 in x and y),
 * clipped by the half-space x <= 0.
 * Verifies: the clip keeps exactly the left half of the square -- two
 * original corners (both with x <= 0) plus two new points on the clip
 * plane's own line (x = 0), and drops the two corners with x > 0. This is
 * the textbook Sutherland-Hodgman case and the base every other clip test
 * builds on.
 */
Deno.test("clipPolygonByPlane keeps the inside half of a square clipped by a bisecting plane", () => {
    const square = [
        { x: 1, y: 1, z: 0 },
        { x: -1, y: 1, z: 0 },
        { x: -1, y: -1, z: 0 },
        { x: 1, y: -1, z: 0 }
    ];

    const clipped = DesignMesh.clipPolygonByPlane(square, { x: 1, y: 0, z: 0 }, 0, 1e-9);

    assertEquals(clipped.length, 4, "two original corners survive, two new ones are inserted");

    for (const point of clipped) {
        assert(point.x <= 1e-9, "every surviving point has x <= 0 (the kept half-space)");
    }

    // The two original left-hand corners must still be present, unmoved.
    const hasCorner = (x, y) => clipped.some(p => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);
    assert(hasCorner(-1, 1), "the original (-1, 1) corner survives");
    assert(hasCorner(-1, -1), "the original (-1, -1) corner survives");
});

/*
 * Setup: the same unit square, clipped by a half-space it lies entirely
 * inside (x <= 10) and one it lies entirely outside (x <= -10).
 * Verifies: clipping by a plane that does not touch the polygon at all
 * returns it completely unchanged (inside) or completely empty (outside) --
 * the two degenerate cases every "does the clip loop ever touch anything"
 * bug would get wrong first.
 */
Deno.test("clipPolygonByPlane leaves a fully-inside polygon unchanged and empties a fully-outside one", () => {
    const square = [
        { x: 1, y: 1, z: 0 },
        { x: -1, y: 1, z: 0 },
        { x: -1, y: -1, z: 0 },
        { x: 1, y: -1, z: 0 }
    ];

    const insideResult = DesignMesh.clipPolygonByPlane(square, { x: 1, y: 0, z: 0 }, 10, 1e-9);
    assertEquals(insideResult.length, 4, "fully inside: every corner survives unchanged");
    for (let i = 0; i < 4; i++) {
        assertClose(insideResult[i].x, square[i].x, 1e-12, "x unchanged");
        assertClose(insideResult[i].y, square[i].y, 1e-12, "y unchanged");
    }

    const outsideResult = DesignMesh.clipPolygonByPlane(square, { x: 1, y: 0, z: 0 }, -10, 1e-9);
    assertEquals(outsideResult.length, 0, "fully outside: nothing survives");
});

/*
 * Setup: two points 1e-12 apart (float noise) and a third a full unit away,
 * fed through dedupeConsecutive with tolerance 1e-9.
 * Verifies: the near-duplicate pair collapses to one point (the near-zero-
 * length edge a clip step can introduce right at a plane crossing does not
 * survive into the next clip), while the genuinely distant point is kept --
 * the same "collapse noise, keep geometry" contract VertexWelder has, at
 * the polygon-building stage rather than the final weld.
 */
Deno.test("dedupeConsecutive collapses a near-duplicate point but keeps a distinct one", () => {
    const polygon = [
        { x: 0, y: 0, z: 0 },
        { x: 1e-12, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 }
    ];

    const result = DesignMesh.dedupeConsecutive(polygon, 1e-9);

    assertEquals(result.length, 2, "the near-duplicate first pair collapses to one point");
    assertClose(result[1].x, 1, 1e-12, "the distant point survives unchanged");
});

/*
 * Setup: orthonormalTangents on a handful of normals, including axis-
 * aligned ones (where the "pick +X unless normal is close to +X" seed
 * switch actually matters) and an arbitrary oblique direction.
 * Verifies: for every normal, t1 and t2 are unit length, mutually
 * orthogonal, both orthogonal to the normal, and t1 x t2 equals the normal
 * -- i.e. (normal, t1, t2) is a genuine right-handed orthonormal basis, not
 * merely "two vectors perpendicular to normal" (which would still let a
 * clipped square come out with the wrong handedness).
 */
Deno.test("orthonormalTangents builds a right-handed orthonormal basis for any normal", () => {
    // An arbitrary oblique direction, normalised here (rather than as a
    // hand-typed literal) so this test's own input is trustworthy -- a
    // slightly-off hand-computed "unit" vector would make every assertion
    // below fail for a reason that has nothing to do with orthonormalTangents.
    const obliqueRaw = { x: 3, y: 3, z: 4 };
    const obliqueLength = Math.hypot(obliqueRaw.x, obliqueRaw.y, obliqueRaw.z);
    const oblique = { x: obliqueRaw.x / obliqueLength, y: obliqueRaw.y / obliqueLength, z: obliqueRaw.z / obliqueLength };

    const normals = [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 1 },
        { x: -1, y: 0, z: 0 },
        oblique
    ];

    for (const normal of normals) {
        const [t1, t2] = DesignMesh.orthonormalTangents(normal);

        const len = v => Math.hypot(v.x, v.y, v.z);
        const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
        const cross = (a, b) => ({
            x: a.y * b.z - a.z * b.y,
            y: a.z * b.x - a.x * b.z,
            z: a.x * b.y - a.y * b.x
        });

        assertClose(len(t1), 1, 1e-9, "t1 is unit length");
        assertClose(len(t2), 1, 1e-9, "t2 is unit length");
        assertClose(dot(t1, t2), 0, 1e-9, "t1 and t2 are orthogonal to each other");
        assertClose(dot(t1, normal), 0, 1e-9, "t1 is orthogonal to normal");
        assertClose(dot(t2, normal), 0, 1e-9, "t2 is orthogonal to normal");

        const t1xt2 = cross(t1, t2);
        assertClose(t1xt2.x, normal.x, 1e-9, "t1 x t2 agrees with normal (x)");
        assertClose(t1xt2.y, normal.y, 1e-9, "t1 x t2 agrees with normal (y)");
        assertClose(t1xt2.z, normal.z, 1e-9, "t1 x t2 agrees with normal (z)");
    }
});

// ===========================================================================
// 2. The whole pipeline: the hand-made cube
// ===========================================================================

/*
 * Setup: the hand-made unit cube design above (6 planes, exact answer known
 * on paper: 8 vertices, 6 faces, volume 8, already outward by construction
 * since every plane's own outward normal points away from the origin).
 * Verifies: buildFaces produces exactly 6 faces (one per plane, none
 * redundant, none dropped) and weldFaces collapses the 6 quads' 24 corner
 * references down to the cube's true 8 shared vertices.
 */
Deno.test("buildFaces on a hand-made cube produces exactly 6 faces and 8 welded vertices", () => {
    const design = makeCubeDesign();
    const built = DesignMesh.buildFaces(design);

    assertEquals(built.planes.length, 6, "all 6 cube planes are candidates (no preform)");
    assertEquals(built.droppedDegenerate, 0, "none of the 6 planes is redundant or degenerate");
    assertEquals(built.faces.length, 6, "every plane contributes exactly one face");

    for (const face of built.faces) {
        assertEquals(face.polygon.length, 4, "a cube face is a quad");
    }

    const welded = DesignMesh.weldFaces(built, DesignMesh.defaults.weldTolerance);
    assertEquals(welded.positions.length, 8, "the 6 quads' 24 corners weld down to the cube's 8 true vertices");
    assertEquals(welded.loops.length, 6, "all 6 faces survive welding");
});

/*
 * Setup: the same cube, through toObjText -- the actual function
 * objTextFromBytes calls -- then re-parsed by this suite's OWN independent
 * OBJ reader (not any part of design_mesh.js), exactly as
 * gemcad_obj_test.js checks its writer.
 * Verifies: the emitted text is a closed (every edge used exactly once each
 * way), outward-wound (positive signed volume) solid whose volume is
 * EXACTLY 8 (a cube from -1 to 1 on every axis) to float precision -- the
 * one case in this whole suite where the expected number is exact, not
 * merely "close to the file's own mesh".
 */
Deno.test("toObjText on a hand-made cube is closed, outward-wound and has volume exactly 8", () => {
    const design = makeCubeDesign();
    const text = DesignMesh.toObjText(design, { name: "cube" });
    const parsed = parseObj(text);

    assertEquals(parsed.positions.length, 8, "8 distinct vertices");
    assertEquals(parsed.faces.length, 6, "6 faces");

    const stats = edgeStatistics(parsed.faces);
    assertEquals(stats.boundary, 0, "no boundary (unshared) edges: the cube is closed");
    assertEquals(stats.nonManifold, 0, "no edge is shared by other than exactly two faces");
    assertEquals(stats.manifold, 12, "a cube has 12 edges, each used once each way");

    const volume = signedVolumeTimesSix(parsed.positions, parsed.faces) / 6;
    assertClose(volume, 8, 1e-9, "a cube from -1 to 1 on every axis has volume 8");
});

/*
 * A PREFORM TIER IS CUT NORMALLY (the user, 2026-09-18: "the teeth need to
 * have the {} and cut it normally"), reversing this builder's earlier rule,
 * which left a file's preform tiers out of the mesh.
 *
 * Setup: the hand-made cube with its "top" tier (the +Z face) marked
 * `preform: true`.
 * Test: meshPlanes, and the whole toObjText pipeline.
 * Verifies: all 6 planes are candidates, the preform one included, and the
 * stone is the same closed cube of volume 8 it is with the flag off -- the
 * flag changes nothing about the geometry.
 */
Deno.test("a preform tier's plane cuts the stone like any other", () => {
    const design = makeCubeDesign();

    design.tiers[0].preform = true;

    const planes = DesignMesh.meshPlanes(design);
    assertEquals(planes.length, 6, "the preform tier's plane is still a candidate");
    assert(planes.some(p => p.tier === 0), "the preform tier's plane is among them");

    const parsed = parseObj(DesignMesh.toObjText(design, { name: "cube" }));
    assertEquals(parsed.faces.length, 6, "still six faces");
    assertClose(signedVolumeTimesSix(parsed.positions, parsed.faces) / 6, 8, 1e-9,
        "still the closed cube of volume 8");
});

/*
 * A TIER THAT REPEATS ANOTHER TIER'S PLANES EXACTLY BUILDS ONE FACE, NOT TWO.
 *
 * Why this matters now: preform tiers are cut normally since 2026-09-19, and
 * a GemCad PREFORM section commonly repeats the design's girdle tiers exactly
 * (Isotangle.gem's G6..G10 are G1..G5 again). Two coincident half-spaces are
 * one half-space, but the clip used to keep both planes' faces, putting two
 * overlapping copies of each side into the mesh -- non-manifold.
 *
 * Setup: the hand-made cube plus a fourth tier that is an exact copy of its
 * four-sided "girdle" tier, marked preform as in a real file.
 * Test: build the mesh.
 * Verifies: the four copied planes are dropped as coincident (not clipped
 * into duplicate faces); every kept face belongs to the ORIGINAL tier (the
 * earlier one, which is also the tier the page's nearest-normal match picks
 * for a tie); and the OBJ text is the plain cube's, byte for byte apart from
 * the comment line counting the design's tiers -- closed, 6 faces, 12 edges.
 */
Deno.test("a tier repeating another tier's planes exactly adds no duplicate faces", () => {
    const plain = makeCubeDesign();
    const withCopy = makeCubeDesign();
    const girdle = withCopy.tiers[2];

    withCopy.tiers.push({
        angle: girdle.angle, distance: girdle.distance, preform: true, cuttingInstructions: "",
        facets: girdle.facets.map(f => ({ index: f.index, name: "" }))
    });

    const built = DesignMesh.buildFaces(withCopy);
    assertEquals(built.droppedCoincident, 4, "the copy's four planes coincide with the girdle's and are dropped");
    assertEquals(built.faces.length, 6, "six faces, one per distinct plane");
    assert(built.faces.every(f => f.tier !== 3), "every kept face belongs to the earlier, original tier");

    const stripCounts = text => text.split("\n").filter(line => !line.startsWith("# facets:")).join("\n");
    const text = DesignMesh.toObjText(withCopy, { name: "cube" });

    assertEquals(stripCounts(text), stripCounts(DesignMesh.toObjText(plain, { name: "cube" })),
        "the stone is the plain cube, byte for byte");

    const stats = edgeStatistics(parseObj(text).faces);
    assertEquals([stats.manifold, stats.boundary, stats.nonManifold], [12, 0, 0], "closed and manifold");
});

/*
 * A HIDDEN TIER IS LEFT OUT OF THE STONE (T-0178: "disables the facet tier in
 * the list of facets so it doesn't get rendered but it still shows up").
 *
 * Setup: the hand-made cube plus a seventh tier that slices one corner off
 * (one plane, pointing along (1, 1, 1), 1.5 from the centre, so it cuts the
 * corner at (1, 1, 1), which is sqrt(3) = 1.73 away). With that tier shown
 * the stone has 7 faces; hidden, it must be the plain cube again.
 * Test: build the mesh with the corner tier shown, then with it hidden.
 * Verifies: shown, it cuts (7 faces, volume under 8); hidden, meshPlanes
 * leaves its plane out and the OBJ text is identical to the plain cube's
 * apart from the comment line that counts the design's tiers -- the same
 * vertices and faces, byte for byte.
 */
Deno.test("a hidden tier's planes are left out of the mesh, and showing it cuts again", () => {
    const plain = makeCubeDesign();
    const withCorner = makeCubeDesign();

    // Mast angle of (1, 1, 1): polar angle acos(1/sqrt(3)) from +Z; on the 4-tooth gear an
    // index of 0.5 is azimuth 45 degrees from +Y towards +X, i.e. the (1, 1) diagonal.
    const polar = Math.acos(1 / Math.sqrt(3)) * 180 / Math.PI;
    withCorner.tiers.push({
        angle: polar, distance: 1.5, preform: false, hidden: false, cuttingInstructions: "",
        facets: [{ index: 0.5, name: "corner" }]
    });

    const shown = parseObj(DesignMesh.toObjText(withCorner, { name: "cube" }));
    assertEquals(shown.faces.length, 7, "shown, the corner tier adds a seventh face");
    assert(signedVolumeTimesSix(shown.positions, shown.faces) / 6 < 8, "and cuts some volume away");

    withCorner.tiers[3].hidden = true;
    assertEquals(DesignMesh.meshPlanes(withCorner).length, 6, "hidden, its plane is left out");

    const stripCounts = text => text.split("\n").filter(line => !line.startsWith("# facets:")).join("\n");

    assertEquals(stripCounts(DesignMesh.toObjText(withCorner, { name: "cube" })),
        stripCounts(DesignMesh.toObjText(plain, { name: "cube" })),
        "hidden, the stone is the plain cube again, byte for byte");
});

/*
 * Setup: a design with only ONE plane (the cube's own +Z table plane,
 * alone) -- geometrically an unbounded half-space, not a closed solid.
 * Verifies: buildFaces throws rather than silently returning an open shape.
 * A single plane's own "face" would be bounded only by the initial square,
 * which the boundary-resolution check (every face edge must lie on some
 * OTHER plane) is specifically there to catch -- this is that check firing
 * on a real, if extreme, case, not a hand-triggered code path.
 */
Deno.test("buildFaces throws for a design whose planes do not bound a closed solid", () => {
    const design = makeCubeDesign();
    design.tiers = [design.tiers[0]]; // keep only the +Z table plane

    let threw = false;
    try {
        DesignMesh.buildFaces(design);
    } catch (error) {
        threw = true;
        assert(String(error).length > 0, "the error says something");
    }

    assert(threw, "a single unbounded half-space must not silently produce a mesh");
});

// ===========================================================================
// 3. The whole pipeline: real designs
// ===========================================================================

/*
 * Setup: SRB.asc (Standard Round Brilliant, one of the four bundled
 * samples), parsed and turned into a design the ordinary way (fromGemCad),
 * then built by design_mesh.js and separately by gemcad_obj.js off the SAME
 * parse.
 * Verifies: the design-derived mesh is closed and outward-wound; its face
 * count equals the number of planes the design actually has (73, the same
 * count the file-corner mesh reports facets for -- see
 * gemcad_obj_test.js/gemcad_test.js); and its volume agrees with the
 * file-corner mesh's own volume to 1e-6 -- SRB is one of the four bundled
 * samples whose every tier's mast angle is already exact at 2 decimals
 * (kb/the-polar-internal-representation.md), so there is no expected
 * angle-rounding disagreement here at all, unlike a real-world file such as
 * Fiorello_80.gem (see kb/building-the-stone-mesh-from-a-design-s-own-face.md).
 */
Deno.test("SRB.asc: the design mesh matches the file-corner mesh closely (no angle rounding in this file)", { ignore: !SAMPLES_PRESENT }, async () => {
    const parsed = await sample("SRB", "asc");
    const design = GemCadDesign.fromGemCad(parsed, { name: "SRB" });

    const designText = DesignMesh.toObjText(design, { name: "SRB" });
    const designParsed = parseObj(designText);
    const designStats = edgeStatistics(designParsed.faces);

    assertEquals(designStats.boundary, 0, "the design mesh is closed");
    assertEquals(designStats.nonManifold, 0, "the design mesh is manifold");

    const planeCount = GemCadDesign.planesOf(design).length;
    assertEquals(designParsed.faces.length, planeCount, "one face per surviving plane (none is preform or redundant in SRB)");

    const designVolume = signedVolumeTimesSix(designParsed.positions, designParsed.faces) / 6;
    assert(designVolume > 0, "outward winding: positive signed volume");

    const fileText = GemCadObj.toObjText(parsed, { name: "SRB" });
    const fileParsed = parseObj(fileText);
    const fileVolume = signedVolumeTimesSix(fileParsed.positions, fileParsed.faces) / 6;

    assertEquals(fileParsed.faces.length, planeCount, "the file-corner mesh also has one face per plane for SRB");
    assertClose(designVolume, fileVolume, 1e-6,
        "SRB has no rounded-angle tiers, so the two meshes' volumes should agree to float precision");
});

/*
 * Setup: resources/hex_cut_v2.gcs, the page's own startup stone, read and
 * parsed through GemCutStudio.importText exactly as the page does, then
 * built both ways as above.
 * Verifies: the same closedness/winding/face-count checks as SRB, plus a
 * volume comparison against a LOOSER tolerance than SRB's -- this file has
 * three meet-point solved tiers (C3, C4, C6; see
 * kb/the-polar-internal-representation.md), so a small, already-measured
 * and understood disagreement (order 1e-5) is expected here, not a defect.
 * The tolerance (1e-3) is two orders of magnitude above the measured
 * 1.04e-5 worst case (kb/building-the-stone-mesh-from-a-design-s-own-face.md),
 * generous on purpose so this test is not re-tuned every time float
 * rounding shifts the ~13th digit somewhere in the pipeline.
 */
Deno.test("hex_cut_v2.gcs: the design mesh matches the file-corner mesh, within the meet-point tiers' own residue", async () => {
    const text = await Deno.readTextFile(HEX_CUT_V2_GCS_URL);
    const { parsed } = GemCutStudio.importText(text);
    const design = GemCadDesign.fromGemCad(parsed, { name: "hex_cut_v2" });

    assertEquals(design.tiers.filter(t => t.preform).length, 0, "hex_cut_v2.gcs marks no tier as a preform stage");

    const designText = DesignMesh.toObjText(design, { name: "hex_cut_v2" });
    const designParsed = parseObj(designText);
    const designStats = edgeStatistics(designParsed.faces);

    assertEquals(designStats.boundary, 0, "the design mesh is closed");
    assertEquals(designStats.nonManifold, 0, "the design mesh is manifold");

    const planeCount = GemCadDesign.planesOf(design).length;
    assertEquals(planeCount, 67, "hex_cut_v2 has 67 facets (kb/reading-gem-cut-studio-gcs-design-files.md)");
    assertEquals(designParsed.faces.length, planeCount, "one face per surviving plane");

    const designVolume = signedVolumeTimesSix(designParsed.positions, designParsed.faces) / 6;
    assert(designVolume > 0, "outward winding: positive signed volume");

    const fileText = GemCadObj.toObjText(parsed, { name: "hex_cut_v2" });
    const fileParsed = parseObj(fileText);
    const fileVolume = signedVolumeTimesSix(fileParsed.positions, fileParsed.faces) / 6;

    assertClose(designVolume, fileVolume, 1e-3,
        "volumes agree within the meet-point solved tiers' own residue, not to float precision");
});
