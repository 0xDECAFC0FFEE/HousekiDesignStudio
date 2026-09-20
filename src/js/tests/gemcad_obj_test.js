/*
 * gemcad_obj_test.js -- tests for www/js/gemcad_obj.js, which turns a design
 * parsed by www/js/gemcad.js into the OBJ text that `GemApp.load_obj` eats.
 *
 * HOW TO RUN
 *   deno test --allow-read www/js/tests/
 *
 * Node on this machine is broken (18.6.0, missing libicui18n.70.dylib), so Deno
 * 2.6.2 is the runtime, as for gemcad_test.js. No third-party dependencies: the
 * assertion helpers below are a dozen lines, which keeps the suite runnable with
 * no network access.
 *
 * WHAT THIS SUITE IS FOR
 *   The writer sits between two things that are already tested -- the reader
 *   (gemcad_test.js) and the Rust mesh conditioner (cargo test) -- so what has
 *   to be established here is that the OBJ it emits is a *sound closed solid*,
 *   because that is exactly what neither neighbour can check for it:
 *     - src/loader.rs will happily fan-triangulate a mis-wound polygon into a
 *       bowtie, and
 *     - src/mesh.rs reports a leak in `diagnostics_text()` but cannot repair it,
 *       and a leaking stone renders as scattered black pixels rather than as a
 *       visible hole, so the eye does not catch it either.
 *   So the sample-design tests below re-derive, from the emitted OBJ alone, the
 *   same three properties the Rust side would: every edge shared by exactly two
 *   oppositely wound faces (watertight), positive enclosed volume (outward
 *   winding), and ASC/GEM agreement (two nearly disjoint code paths reaching the
 *   same solid). The unit tests above them pin the three pieces of machinery
 *   that make that true: the welder, Newell's normal and the winding fix.
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
// Loading the two libraries
//
// Neither has an `export`: make_page.py refuses to inline a template containing
// an ES import, so both are classic scripts. They are loaded the way the page
// loads them, by evaluating their text in the global scope. `(0, eval)` forces
// *indirect* eval, which evaluates in global scope rather than this module's.
// Order matters: gemcad_obj.js is written against gemcad.js's data types.
// ---------------------------------------------------------------------------

const READER_URL = new URL("../gemcad.js", import.meta.url);
const WRITER_URL = new URL("../gemcad_obj.js", import.meta.url);
const SAMPLES_URL = new URL("../../../reference/gemcad-file-reader/Samples/", import.meta.url);

const DESIGNS = ["Compear125", "CubeIllusionTri", "SRB", "Turkey"];

// ---------------------------------------------------------------------------
// WHY THE SAMPLE-DESIGN TESTS BELOW ARE SKIPPED RATHER THAN RUN
//
// reference/ is third-party data -- the vendored GemCad sample designs among it
// -- several hundred megabytes of it, deliberately gitignored, so a fresh clone
// of this repository has none of it, and the suite still has to be green there.
// Every test that reads a sample is therefore marked
// `{ ignore: !SAMPLES_PRESENT }` and reports as ignored when the data is absent,
// instead of erroring on a missing file; with the data present all of them run
// exactly as before. The unit tests above them -- the welder, Newell's normal,
// the winding fix, sanitiseName -- build their own inputs and are never gated.
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

const GemCad = globalThis.GemCad;
const GemCadObj = globalThis.GemCadObj;

/** Reads a sample design and parses it, e.g. sample("SRB", "asc"). */
async function sample(design, extension) {
    const bytes = await Deno.readFile(new URL(design + "." + extension, SAMPLES_URL));

    return GemCad.importBytes(bytes);
}

// ---------------------------------------------------------------------------
// A deliberately independent OBJ reader
//
// It parses only what the writer emits (`v` and `f` lines), and it is here so
// the tests below assert on the *text that would reach Rust* rather than on the
// intermediate structures the writer happens to build. A bug that corrupted the
// formatting step would otherwise go unnoticed.
// ---------------------------------------------------------------------------

function parseObj(text) {
    const positions = [];
    const faces = [];
    const objectNames = [];

    for (const line of text.split("\n")) {
        const parts = line.trim().split(/\s+/);

        if (parts[0] === "v") {
            positions.push({ x: Number(parts[1]), y: Number(parts[2]), z: Number(parts[3]) });
        } else if (parts[0] === "f") {
            // OBJ face references are 1-based, and may carry /texture/normal
            // suffixes; the writer emits bare indices, and this accepts both.
            faces.push(parts.slice(1).map(part => Number(part.split("/")[0]) - 1));
        } else if (parts[0] === "o") {
            objectNames.push(parts.slice(1).join(" "));
        }
    }

    return { positions, faces, objectNames };
}

/**
 * Edge bookkeeping over a polygon soup, mirroring `Mesh::edge_statistics`.
 *
 * Counts each undirected edge's uses per direction, so an edge used once each
 * way (the only thing an orientable closed surface may have) is distinguishable
 * both from an edge used once (a hole) and from two faces glued on the same
 * side (a fold).
 */
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

/**
 * Six times the enclosed signed volume of the *fan triangulation* of the faces,
 * which is what `loader.rs` actually builds, by the divergence theorem. Positive
 * means the faces are wound counter-clockwise seen from outside.
 *
 * Fanning rather than using the polygons directly is the point: it makes the
 * number sensitive to a bowtie, where a mis-ordered polygon's fan triangles
 * overlap and cancel instead of tiling the facet.
 */
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

// ---------------------------------------------------------------------------
// The welder
// ---------------------------------------------------------------------------

/*
 * Setup: three points, two of them 1e-8 apart (the scale of the .asc path's
 * duplicate-corner defect) and one a whole unit away.
 * Verifies: the near pair welds onto one index and the far point does not, i.e.
 * the welder collapses the defect without merging real geometry.
 */
Deno.test("VertexWelder collapses coincident points and keeps distinct ones", () => {
    const welder = new GemCadObj.VertexWelder(1e-6);

    const first = welder.add({ x: 1, y: 2, z: 3 });
    const again = welder.add({ x: 1 + 1e-8, y: 2 - 1e-8, z: 3 });
    const elsewhere = welder.add({ x: 1, y: 2, z: 4 });

    assertEquals(first, 0, "the first point takes index 0");
    assertEquals(again, 0, "a point 1e-8 away is the same corner");
    assertEquals(elsewhere, 1, "a point a unit away is a new corner");
    assertEquals(welder.points.length, 2, "only two distinct corners were stored");
});

/*
 * Setup: two points 2e-9 apart that straddle a hash-cell boundary, because one
 * sits just below an exact multiple of the cell size and the other just above.
 * Verifies: they still weld. This is the failure a plain quantise-and-compare
 * has, and the reason the lookup scans all 27 neighbouring cells; without that
 * scan these two land in different cells and are never compared.
 */
Deno.test("VertexWelder welds across a hash cell boundary", () => {
    const tolerance = 1e-6;
    const welder = new GemCadObj.VertexWelder(tolerance);

    // 5 * tolerance is a cell boundary, so these two differ in cell index.
    const below = 5 * tolerance - 1e-9;
    const above = 5 * tolerance + 1e-9;

    assert(
        Math.floor(below / tolerance) !== Math.floor(above / tolerance),
        "the test is pointless unless the two points really are in different cells");

    assertEquals(welder.add({ x: below, y: 0, z: 0 }), 0);
    assertEquals(welder.add({ x: above, y: 0, z: 0 }), 0, "welded despite the cell boundary");
    assertEquals(welder.points.length, 1);
});

// ---------------------------------------------------------------------------
// Newell's normal and the winding fix
// ---------------------------------------------------------------------------

/*
 * Setup: the unit square in the z = 0 plane, listed counter-clockwise seen from
 * +Z, and then the same square reversed.
 * Verifies: Newell's method gives a +Z normal for the first and a -Z normal for
 * the second, with magnitude twice the area (Newell's normal is area-weighted).
 * This is the sign the writer tests against the stored facet normal, so getting
 * it backwards would reverse every face in the file.
 */
Deno.test("polygonNormal follows the right-hand rule and scales with area", () => {
    const square = [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 1, y: 1, z: 0 },
        { x: 0, y: 1, z: 0 }
    ];

    const forward = GemCadObj.polygonNormal(square);
    const reversed = GemCadObj.polygonNormal(square.slice().reverse());

    assertClose(forward.x, 0, 1e-12);
    assertClose(forward.y, 0, 1e-12);
    assertClose(forward.z, 2, 1e-12, "twice the unit square's area, pointing along +Z");
    assertClose(reversed.z, -2, 1e-12, "the same square listed the other way faces -Z");
});

/*
 * Setup: a hand-built one-facet design whose square is listed clockwise seen
 * from +Z, but whose stored facet normal points along +Z. GemCad stores the
 * normal as (3 + distance) times the outward unit normal, so a length of 3.5 is
 * what a real file would hold for a facet 0.5 from the origin; the writer must
 * use its direction only.
 * Verifies: the emitted face is reversed, so its winding agrees with the stored
 * normal. Mixed winding is unrecoverable downstream -- `loader.rs` fans each
 * polygon as given, and `Mesh::force_outward_winding` can only flip the whole
 * mesh -- so this is the writer's only chance to fix it.
 */
Deno.test("toObjText rewinds a polygon that disagrees with its stored facet normal", () => {
    const clockwiseFromAbove = [
        { x: 0, y: 0, z: 0.5 },
        { x: 0, y: 1, z: 0.5 },
        { x: 1, y: 1, z: 0.5 },
        { x: 1, y: 0, z: 0.5 }
    ];

    const design = {
        metadata: {},
        tiers: [{
            indices: [{
                points: clockwiseFromAbove,
                facetNormal: { x: 0, y: 0, z: 3.5 }
            }]
        }]
    };

    const parsed = parseObj(GemCadObj.toObjText(design, { name: "one_facet" }));

    assertEquals(parsed.faces.length, 1, "one facet polygon, one OBJ face");
    assertEquals(parsed.faces[0].length, 4, "and it is still a quad");

    const normal = GemCadObj.polygonNormal(parsed.faces[0].map(i => parsed.positions[i]));

    assert(normal.z > 0, "the emitted face must wind to agree with the stored normal, got " +
        JSON.stringify(normal));
});

/*
 * Setup: the same single facet, but with its points already in agreement with
 * the stored normal.
 * Verifies: the writer leaves the order alone. Together with the test above this
 * pins the fix as conditional rather than an unconditional reverse, which would
 * pass that test while breaking every correctly wound file.
 */
Deno.test("toObjText leaves an already-correct winding alone", () => {
    const counterClockwiseFromAbove = [
        { x: 0, y: 0, z: 0.5 },
        { x: 1, y: 0, z: 0.5 },
        { x: 1, y: 1, z: 0.5 },
        { x: 0, y: 1, z: 0.5 }
    ];

    const design = {
        metadata: {},
        tiers: [{
            indices: [{
                points: counterClockwiseFromAbove,
                facetNormal: { x: 0, y: 0, z: 3.5 }
            }]
        }]
    };

    const parsed = parseObj(GemCadObj.toObjText(design, { name: "one_facet" }));
    const normal = GemCadObj.polygonNormal(parsed.faces[0].map(i => parsed.positions[i]));

    assert(normal.z > 0, "winding already agreed and must not have been reversed");
});

/*
 * Setup: a design whose only facet has two corners, which encloses no area.
 * Verifies: `toObjText` throws rather than emitting an empty or degenerate OBJ.
 * `GemApp::load_obj` swaps the stone only on success, so a thrown error leaves
 * the previous stone on screen and the page shows a message naming the file;
 * silently emitting nothing would blank the canvas with no explanation.
 */
Deno.test("toObjText refuses a design with no usable facet", () => {
    const design = {
        metadata: {},
        tiers: [{ indices: [{ points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] }] }]
    };

    let threw = false;

    try {
        GemCadObj.toObjText(design, { name: "degenerate" });
    } catch (cause) {
        threw = true;
        assert(String(cause).includes("no facet"), "unexpected message: " + cause);
    }

    assert(threw, "a design with no facet polygon must be rejected");
});

/*
 * Setup: file names that OBJ cannot represent verbatim, because `o` takes the
 * rest of the line and has no quoting.
 * Verifies: whitespace becomes underscores, other awkward characters are
 * dropped, and an empty result falls back to a placeholder. The object name ends
 * up in `GemApp::diagnostics_text` as the model name, so it must never be able
 * to turn into a second OBJ token.
 */
Deno.test("sanitiseName produces a single safe OBJ token", () => {
    assertEquals(GemCadObj.sanitiseName("My Design v2.gem"), "My_Design_v2.gem");
    assertEquals(GemCadObj.sanitiseName("a\tb"), "a_b");
    assertEquals(GemCadObj.sanitiseName("!!!"), "gemcad_design");
    assertEquals(GemCadObj.sanitiseName(undefined), "gemcad_design");
});

// ---------------------------------------------------------------------------
// The four sample designs, in both formats
// ---------------------------------------------------------------------------

/*
 * Setup: every sample design in both formats, converted to OBJ and read back
 * with the independent parser above.
 * Verifies: the solid is watertight -- every edge used by exactly two faces in
 * opposite directions, no holes and no folds -- and encloses positive volume,
 * i.e. every face is wound outward. These are the two properties the renderer
 * cannot recover from: a hole leaks interior rays and shows up as scattered
 * black pixels, and an inward-wound facet inverts the refraction and
 * total-internal-reflection tests for the rays that hit it.
 */
for (const design of DESIGNS) {
    for (const extension of ["asc", "gem"]) {
        Deno.test(`${design}.${extension} converts to a watertight, outward-wound OBJ`, { ignore: !SAMPLES_PRESENT }, async () => {
            const parsed = parseObj(GemCadObj.toObjText(await sample(design, extension),
                { name: design + "." + extension }));

            const stats = edgeStatistics(parsed.faces);

            assertEquals(stats.boundary, 0, "open edges mean the stone leaks interior rays");
            assertEquals(stats.nonManifold, 0, "non-manifold edges mean faces overlap or fold");
            assert(stats.manifold > 100, "suspiciously few edges: " + stats.manifold);

            assert(
                signedVolumeTimesSix(parsed.positions, parsed.faces) > 0,
                "the fan triangulation must enclose positive volume, i.e. wind outward");

            // Every face is a polygon, and a fan needs at least a triangle.
            for (const face of parsed.faces) {
                assert(face.length >= 3, "a face with " + face.length + " corners is not a polygon");
            }

            for (const position of parsed.positions) {
                assert(
                    Number.isFinite(position.x) &&
                    Number.isFinite(position.y) &&
                    Number.isFinite(position.z),
                    "a non-finite coordinate would poison every ray intersection test");
            }
        });
    }
}

/*
 * Setup: each design converted from both its .asc and its .gem form.
 * Verifies: the two agree on vertex count, face count and enclosed volume. The
 * two reader paths share almost no code -- .asc reconstructs the stone by
 * cutting a cube with one plane per facet, .gem reads stored point lists -- so
 * agreement is the strongest evidence available that the writer is reading the
 * right field and ordering it correctly. The volume tolerance is 1e-6: the two
 * cannot agree exactly, because GemCad rounded the coordinates it wrote into
 * the .gem (kb/reading-gemcad-asc-and-gem-cut-files.md measures the gap at
 * about 1.2e-6 model units of corner position).
 */
for (const design of DESIGNS) {
    Deno.test(`${design}: the .asc and .gem paths produce the same solid`, { ignore: !SAMPLES_PRESENT }, async () => {
        const fromAsc = parseObj(GemCadObj.toObjText(await sample(design, "asc"), { name: design }));
        const fromGem = parseObj(GemCadObj.toObjText(await sample(design, "gem"), { name: design }));

        assertEquals(fromAsc.positions.length, fromGem.positions.length, "same vertex count");
        assertEquals(fromAsc.faces.length, fromGem.faces.length, "same facet count");

        assertClose(
            signedVolumeTimesSix(fromAsc.positions, fromAsc.faces) / 6,
            signedVolumeTimesSix(fromGem.positions, fromGem.faces) / 6,
            1e-6,
            "the two formats must describe the same stone");
    });
}

/*
 * Setup: the duplicate-corner counts the writer reports while welding, for every
 * sample in both formats.
 * Verifies: exactly the numbers measured in T-0060 -- 96 duplicate corners on
 * SRB.asc, 20 on Compear125.asc, none anywhere else. The .asc path emits them
 * because the reference de-duplicates cut points at 1e-10 while its own clipping
 * arithmetic leaves coincident points about 1e-8 apart. Pinning the counts here
 * means that if a future change to the reader silently stops producing them (or
 * starts producing more), this test says so rather than the stone quietly
 * gaining seams.
 */
Deno.test("the welder absorbs exactly the .asc path's known duplicate corners", { ignore: !SAMPLES_PRESENT }, async () => {
    const expected = {
        "Compear125.asc": 20,
        "Compear125.gem": 0,
        "CubeIllusionTri.asc": 0,
        "CubeIllusionTri.gem": 0,
        "SRB.asc": 96,
        "SRB.gem": 0,
        "Turkey.asc": 0,
        "Turkey.gem": 0
    };

    const measured = {};

    for (const design of DESIGNS) {
        for (const extension of ["asc", "gem"]) {
            const loops = GemCadObj.facetLoops(
                await sample(design, extension), GemCadObj.defaults.weldTolerance);

            measured[design + "." + extension] = loops.duplicateCorners;

            assertEquals(loops.skipped, 0, "no sample design has an empty facet");
        }
    }

    assertEquals(measured, expected);
});

/*
 * Setup: Turkey, whose table is the tier with angle 0, read from both formats.
 * Verifies: the table facet's normal is +Z and every vertex in the design lies
 * at or below the table's plane. That is the empirical form of "GemCad's optical
 * axis is +Z": the stone's table caps it from above, in Z. It matters because
 * the renderer rotates the model-space axis named by `set_model_axis` onto world
 * +Y, and its default is +Z; if this test ever fails, a GemCad design would
 * render lying on its side.
 */
Deno.test("the optical axis is +Z: the table caps the model's Z range", { ignore: !SAMPLES_PRESENT }, async () => {
    const data = await sample("Turkey", "asc");
    const tableTier = data.tiers.find(tier => tier.angle === 0);

    assert(tableTier !== undefined, "Turkey has a tier at angle 0, which is its table");
    assertEquals(tableTier.indices.length, 1, "the table is a single facet");

    const normal = tableTier.indices[0].facetNormal;

    // Stored as (3 + distance) times the outward unit normal, so only the
    // direction is meaningful here.
    const length = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);

    assertClose(normal.x / length, 0, 1e-12, "the table normal has no X component");
    assertClose(normal.y / length, 0, 1e-12, "the table normal has no Y component");
    assertClose(normal.z / length, 1, 1e-12, "the table faces +Z");

    const tableZ = tableTier.indices[0].points[0].z;

    for (const tier of data.tiers) {
        for (const facet of tier.indices) {
            for (const point of facet.points) {
                assert(point.z <= tableZ + 1e-9,
                    "a vertex at z=" + point.z + " sits above the table at z=" + tableZ);
            }
        }
    }
});

/*
 * Setup: SRB read from its .gem, converted, and every emitted coordinate matched
 * back to the corner it came from.
 * Verifies: the text loses less than 1e-8 model units, i.e. less than f32 can
 * represent at this scale, so nothing is thrown away that the renderer could
 * have used. The count matters more than it looks: at six decimals the rounding
 * tilts the normal of a thin fan triangle past `Mesh::rebuild_facets`'s
 * 0.1-degree tolerance and single facets come apart into several, which is
 * invisible in a full render (it shades from the triangle normal) but wrong in
 * the facet-ids view and for the smooth normals fantasy cuts will want.
 */
Deno.test("the emitted coordinates keep more precision than f32 can hold", { ignore: !SAMPLES_PRESENT }, async () => {
    const data = await sample("SRB", "gem");
    const loops = GemCadObj.facetLoops(data, GemCadObj.defaults.weldTolerance);
    const parsed = parseObj(GemCadObj.toObjText(data, { name: "SRB.gem" }));

    assertEquals(parsed.positions.length, loops.positions.length);

    let worst = 0;

    for (let i = 0; i < loops.positions.length; i++) {
        const source = loops.positions[i];
        const written = parsed.positions[i];

        worst = Math.max(worst,
            Math.abs(source.x - written.x),
            Math.abs(source.y - written.y),
            Math.abs(source.z - written.z));
    }

    assert(worst < 1e-8, "the OBJ text lost " + worst + " model units, which f32 could have kept");
    assertEquals(GemCadObj.defaults.decimals, 9, "nine decimals is what buys that");
});

// ---------------------------------------------------------------------------
// The page's inlining constraints
// ---------------------------------------------------------------------------

/*
 * Setup: the writer's source text, and the four rules make_page.py enforces on
 * anything that ends up in the file:// page.
 * Verifies: no ES import/export (the page is a classic script), no `fetch(`
 * (a file:// page has a null origin and every fetch is refused), and nothing
 * that could close or comment out the <script> element it is inlined into.
 * gemcad_test.js makes the same assertion about gemcad.js; the point of
 * repeating it is that a failure here is otherwise only visible as a build
 * error much later, in make_page.py.
 */
Deno.test("gemcad_obj.js satisfies make_page.py's inlining constraints", async () => {
    const source = await Deno.readTextFile(WRITER_URL);

    assert(!/^\s*import[\s{(]/m.test(source), "an ES import cannot load from file://");
    assert(!/^\s*export[\s{]/m.test(source), "an ES export would make this a module");
    assert(!source.includes("fetch("), "a file:// page cannot fetch anything");
    assert(!/<\/script|<!--/i.test(source), "this text has to survive being inlined in a script");
});
