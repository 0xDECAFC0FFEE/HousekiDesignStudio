/*
 * gemcad_test.js -- tests for www/js/gemcad.js, the JavaScript port of
 * LibGemcadFileReader.
 *
 * The library under test is derived from the C# "GemCAD File Reader"
 *   Original author: Mathew Parker
 *   Upstream:        https://github.com/mbparker/gemcad-file-reader
 *   Copyright (c)    2023 Mathew Parker
 *   Licensed under the MIT Licence; the full notice is at the top of
 *   www/js/gemcad.js.  These tests are new work, written for this repository,
 *   because upstream ships no unit tests at all (its TestHarness is an
 *   interactive console demo and its TestViewer an ASP.NET+Angular page).
 *
 * HOW TO RUN
 *   deno test --allow-read www/js/tests/
 *   GEMCAD_UPDATE_GOLDEN=1 deno test --allow-read --allow-write --allow-env \
 *       www/js/tests/            # rewrite the golden snapshots
 *
 * Node on this machine is broken (18.6.0, missing libicui18n.70.dylib), so
 * Deno 2.6.2 is the runtime.  There are no third-party dependencies, not even
 * jsr:@std/assert: the assertion helpers below are a dozen lines and keep the
 * suite runnable with no network access, which is the project's standing rule.
 *
 * WHAT CAN AND CANNOT BE VERIFIED HERE
 *   There is no .NET SDK on this machine, so no reference JSON can be produced
 *   from the original C# to diff against.  Nothing below claims to compare
 *   against the reference implementation's output.  Instead the suite leans on
 *   four independent kinds of evidence:
 *     1. cross-format agreement -- every design exists as both .asc and .gem,
 *        and the two are read by almost entirely separate code paths (the ASC
 *        path *reconstructs* the stone by cutting a cube with 265 planes; the
 *        GEM path *reads* stored geometry and back-computes the cut parameters).
 *        Agreeing is strong evidence both are right;
 *     2. known values read straight out of the human-readable .asc text;
 *     3. geometric invariants that must hold of any correct facet;
 *     4. golden snapshots, which catch regressions rather than prove
 *        correctness.
 *   Plus unit tests for the handful of places where C# and JS semantics differ
 *   and the port had to do explicit work to stay faithful.
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

/** Absolute-tolerance float comparison; the tolerance is always stated at the call site. */
function assertClose(actual, expected, tolerance, message) {
    if (!(Math.abs(actual - expected) <= tolerance)) {
        throw new Error("assertion failed: " + (message || "") +
            "\n  actual:   " + actual + "\n  expected: " + expected +
            "\n  |diff|:   " + Math.abs(actual - expected) + " > " + tolerance);
    }
}

// ---------------------------------------------------------------------------
// Loading the library
//
// gemcad.js deliberately has no `export`: make_page.py refuses to inline a
// template containing an ES import, because the finished page has to run from
// a file:// URL.  So the test loads it the way the page does -- as a classic
// script -- by evaluating its text in the global scope, after which
// globalThis.GemCad exists.  `(0, eval)` forces *indirect* eval, which runs in
// global scope rather than this module's scope; a plain `eval(src)` would
// define GemCad on a scope the rest of the file cannot see reliably.
// ---------------------------------------------------------------------------

const LIB_URL = new URL("../gemcad.js", import.meta.url);
const SAMPLES_URL = new URL("../../../reference/gemcad-file-reader/Samples/", import.meta.url);
const GOLDEN_URL = new URL("./golden/", import.meta.url);

const DESIGNS = ["Compear125", "CubeIllusionTri", "SRB", "Turkey"];

// ---------------------------------------------------------------------------
// WHY THE SAMPLE-FILE TESTS BELOW ARE SKIPPED RATHER THAN RUN
//
// reference/ is third-party data -- the vendored GemCad sample files among it --
// several hundred megabytes of it, deliberately gitignored, so a fresh clone of
// this repository has none of it, and the suite still has to be green there.
// Every test that reads one of the eight sample files is therefore marked
// `{ ignore: !SAMPLES_PRESENT }` and reports as ignored when the data is absent,
// instead of erroring on a missing file; with the data present all of them run
// exactly as before.  The golden snapshot test is gated too, even though the
// snapshots themselves are checked in: it compares them against a fresh parse of
// the samples, so it has nothing to compare without them.  The PORT TRAP unit
// tests build their own inputs and are never gated -- except TRAP 7, which reads
// a real header line out of Compear125.
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

(0, eval)(await Deno.readTextFile(LIB_URL));
const GemCad = globalThis.GemCad;

/** Reads one sample file's raw bytes. */
async function sampleBytes(design, extension) {
    return await Deno.readFile(new URL(design + extension, SAMPLES_URL));
}

/**
 * Parses every sample once and caches it.  Parsing all eight files takes a
 * few hundred milliseconds (the ASC path does O(planes x polygons) plane cuts),
 * and a dozen tests want the same results, so paying for it once keeps the
 * suite fast without hiding anything: each test still asserts on the full
 * parsed structure.
 */
const parsedCache = new Map();
async function parsed(design, extension) {
    const key = design + extension;
    if (!parsedCache.has(key)) {
        parsedCache.set(key, GemCad.importBytes(await sampleBytes(design, extension)));
    }
    return parsedCache.get(key);
}

// ---------------------------------------------------------------------------
// Small geometry helpers used by several tests
// ---------------------------------------------------------------------------

function unitVector(v) {
    const length = Math.hypot(v.x, v.y, v.z);
    return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function distance3d(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Collapses points that coincide to within `tolerance`, keeping first occurrences. */
function weldPoints(points, tolerance) {
    const kept = [];
    for (const p of points) {
        if (!kept.some((q) => distance3d(p, q) < tolerance)) {
            kept.push(p);
        }
    }
    return kept;
}

/**
 * GemCad index numbers are positions on a toothed index gear, so they are only
 * defined modulo the gear's tooth count, and a full turn may be written as
 * `gear`, `-gear` or `0`.  SRB.asc writes the table as index 96 on a 96-tooth
 * gear while the .gem back-computes 0; both mean "no rotation".  This maps any
 * spelling onto the range 1..|gear| so the two can be compared.
 */
function normaliseIndex(index, gear) {
    const teeth = Math.abs(gear);
    let value = index % teeth;
    if (value < 0) {
        value += teeth;
    }
    return value === 0 ? teeth : value;
}

/** Every facet in a parsed design, flattened, tagged with its tier position. */
function allFacets(data) {
    const facets = [];
    data.tiers.forEach((tier, tierIndex) => {
        tier.indices.forEach((facet) => facets.push({ tierIndex, tier, facet }));
    });
    return facets;
}

// ===========================================================================
// 1. Loading, and the constraints the page build imposes on this file
// ===========================================================================

Deno.test("the library loads as a classic script and publishes globalThis.GemCad", () => {
    // Setup: gemcad.js was evaluated above with indirect eval, exactly as the
    // inlined page will run it.
    // Check: the documented entry points are present and callable.  If this
    // fails, everything else is meaningless, so it is the first test.
    assert(typeof GemCad === "object", "GemCad global is missing");
    for (const name of ["importBytes", "importAscText", "importGemBytes", "identifyFormat"]) {
        assert(typeof GemCad[name] === "function", "GemCad." + name + " is not a function");
    }
});

Deno.test("the library stays inlinable: no ES module syntax and no forbidden tokens", async () => {
    // Setup: read gemcad.js as text.
    const source = await Deno.readTextFile(LIB_URL);

    // Check: make_page.py refuses a page template that contains the literal
    // "fetch(" anywhere, or a line matching /^\s*import[\s{(]/, or the
    // sequences "</script" and "<!" + "--", because none of them survive being
    // inlined into a single file:// page.  Asserting it here means the library
    // cannot quietly drift out of being usable by the real build.
    assert(!source.includes("fetch" + "("), "gemcad.js contains a forbidden call token");
    assert(!/^\s*import[\s{(]/m.test(source), "gemcad.js contains an ES import statement");
    assert(!/^\s*export[\s{]/m.test(source), "gemcad.js contains an ES export statement");
    assert(!/<\/script/i.test(source), "gemcad.js contains a script end tag");
    assert(!source.includes("<!" + "--"), "gemcad.js contains an HTML comment opener");
});

// ===========================================================================
// 2. Format identification
// ===========================================================================

Deno.test("format identification reads the first 7 bytes", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: all eight sample files, four text and four binary.
    // Check: .asc files begin with the literal "GemCad " and are reported as
    // ascii; .gem files begin with the first double of a facet normal, which
    // is arbitrary binary, and are reported as binary.  This is the whole of
    // GemCadFileFormatIdentifier, and getting it wrong sends a file down the
    // wrong parser.
    for (const design of DESIGNS) {
        assertEquals(GemCad.identifyFormat(await sampleBytes(design, ".asc")), "ascii",
            design + ".asc should be identified as text");
        assertEquals(GemCad.identifyFormat(await sampleBytes(design, ".gem")), "binary",
            design + ".gem should be identified as binary");
    }

    // Check: a file of 7 bytes or fewer cannot be identified at all -- the
    // original requires Length > 7 strictly, and throws otherwise.
    let threw = false;
    try {
        GemCad.identifyFormat(new Uint8Array([71, 101, 109, 67, 97, 100, 32]));
    } catch (_error) {
        threw = true;
    }
    assert(threw, "a 7-byte file should be rejected, not identified");
});

// ===========================================================================
// 3. Known values, read by eye out of the .asc text
// ===========================================================================

Deno.test("SRB.asc parses to exactly what its text declares", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: SRB.asc is the Standard Round Brilliant from the GemCad for
    // Windows User's Guide.  Its complete text is 11 lines:
    //     g 96 0.0        -- a 96-tooth index gear at location angle 0
    //     y 8 y           -- 8-fold symmetry, mirrored
    //     I 1.54          -- refractive index 1.54 (quartz)
    //     H x3            -- three header lines, the last a single space
    //     a ... x7        -- seven tiers
    // The final tier is the table: `a 0.000000 0.36450932 96 n T`.
    const data = await parsed("SRB", ".asc");

    // Check: metadata, verbatim from the g/y/I lines.
    assertEquals(data.metadata.gear, 96, "gear");
    assertEquals(data.metadata.gearLocationAngle, 0.0, "gear location angle");
    assertEquals(data.metadata.symmetryFolds, 8, "symmetry folds");
    assertEquals(data.metadata.symmetryMirror, true, "symmetry mirror flag");
    assertEquals(data.metadata.refractiveIndex, 1.54, "refractive index");

    // Check: TWO headers, not three.  SRB.asc has three H lines, but the third
    // is "H  " (an H and two spaces) and the reader trims each line BEFORE
    // splitting it, so that line becomes "H", splits to a single token, fails
    // the `parts.Length > 1` guard and contributes nothing.  Measured, then
    // traced back to `reader.ReadLine()?.Trim()` in the original; the first
    // version of this test expected three and was wrong, not the parser.
    assertEquals(data.metadata.headers,
        ["Standard Round Brilliant", "GemCad for Windows User's Guide"], "headers");
    assertEquals(data.metadata.footnotes, [], "SRB.asc has no F lines");

    // Check: seven tiers, numbered 1..7 in file order.
    assertEquals(data.tiers.length, 7, "tier count");
    assertEquals(data.tiers.map((t) => t.number), [1, 2, 3, 4, 5, 6, 7], "tier numbers");

    // Check: the angle and distance of every tier, exactly as written.
    assertEquals(data.tiers.map((t) => t.angle),
        [-90, -42.5, -41.5, 34, 28, 16, 0], "tier angles");
    assertEquals(data.tiers.map((t) => t.distance),
        [1.02653281, 0.61819401, 0.61701256, 0.68444470, 0.60896430, 0.50613241, 0.36450932],
        "tier distances");

    // Check: the table tier in full -- `a 0.000000 0.36450932 96 n T` is one
    // facet at index 96 named "T".  The `n <name>` pair names the index that
    // came *before* it, which is the part of the a-line grammar most likely to
    // be got wrong by a port.
    const table = data.tiers[6];
    assertEquals(table.indices.length, 1, "the table is a single facet");
    assertEquals(table.indices[0].index, 96, "table index number");
    assertEquals(table.indices[0].name, "T", "table facet name");
    assertEquals(table.indices[0].tier, 7, "the facet records its own tier number");

    // Check: the first tier, `a -90.000000 1.02653281 93 n G 87 81 ... 3`, has
    // 16 girdle facets, of which only the first carries the name "G".
    const girdle = data.tiers[0];
    assertEquals(girdle.indices.length, 16, "girdle facet count");
    assertEquals(girdle.indices.map((x) => x.index),
        [93, 87, 81, 75, 69, 63, 57, 51, 45, 39, 33, 27, 21, 15, 9, 3], "girdle index numbers");
    assertEquals(girdle.indices.map((x) => x.name),
        ["G", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""], "girdle facet names");

    // Check: the whole design is 73 facets across 7 tiers.
    assertEquals(allFacets(data).length, 73, "total facet count");
});

Deno.test("CubeIllusionTri.asc parses its negative gear, footnotes and mid-line names", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: a second design, chosen because it exercises three things SRB
    // does not: a NEGATIVE gear (`g -96 48.0`, meaning index numbers run the
    // other way round the gear), a non-zero gear location angle, and F
    // footnote lines.  It also has `a ... 94 66 62 34 n 2 30 2`, where the
    // named index sits in the middle of the list rather than at the start.
    const data = await parsed("CubeIllusionTri", ".asc");

    assertEquals(data.metadata.gear, -96, "gear is negative and must not be made positive");
    assertEquals(data.metadata.gearLocationAngle, 48.0, "gear location angle");
    assertEquals(data.metadata.symmetryFolds, 3, "symmetry folds");
    assertEquals(data.metadata.symmetryMirror, true, "symmetry mirror flag");
    assertEquals(data.metadata.refractiveIndex, 1.54, "refractive index");

    // (The file's fourth H line is "H  ", which is trimmed to "H" before
    // splitting and so contributes no header -- see the SRB test above.)
    assertEquals(data.metadata.headers, [
        "13.110 Cube Illusion Triangle",
        "by Robert W. Strickland 11/12/95",
        "TFG Newsletter, Oct 95, p24"
    ], "headers");
    assertEquals(data.metadata.footnotes, [
        "Based on an idea by Wilf Ross in his",
        '"Signet," North York Faceting Guild Newsletter,',
        "October, 1995"
    ], "footnotes");

    assertEquals(data.tiers.length, 10, "tier count");

    // Check: tier 1 is `a -46.000000 0.52522447 -96 64 32 n 1`.  The -96 must
    // survive as -96 (it is a legal index on a negative gear), and the name "1"
    // must attach to 32, the index immediately before the `n`.
    const tier1 = data.tiers[0];
    assertEquals(tier1.angle, -46.0, "tier 1 angle");
    assertEquals(tier1.distance, 0.52522447, "tier 1 distance");
    assertEquals(tier1.indices.map((x) => x.index), [-96, 64, 32], "tier 1 index numbers");
    assertEquals(tier1.indices.map((x) => x.name), ["", "", "1"], "tier 1 facet names");

    // Check: tier 2 is `a -47.000000 0.53087770 94 66 62 34 n 2 30 2`, so the
    // name "2" belongs to 34 and the list continues with 30 and 2 afterwards.
    const tier2 = data.tiers[1];
    assertEquals(tier2.indices.map((x) => x.index), [94, 66, 62, 34, 30, 2], "tier 2 index numbers");
    assertEquals(tier2.indices.map((x) => x.name), ["", "", "", "2", "", ""], "tier 2 facet names");

    assertEquals(allFacets(data).length, 51, "total facet count");
});

Deno.test("the a-line parser splits index numbers from cutting instructions correctly", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: Turkey.asc has the hardest a-lines in the sample set, e.g.
    //     a 8.000000 0.47995699 30 n E G E  (Beak optional)
    //     a 0.000000 0.47054522 -96 n T G Meet E-E-D. Table (optional)
    // After the `n E` pair, the token "G" is not a number, and *that failure to
    // parse* is the only signal that the free-text cutting instructions have
    // begun.  This is PORT TRAP 3: JavaScript's parseFloat("G") returns NaN so
    // it happens to work here, but parseFloat("30abc") returns 30, and .NET's
    // double.TryParse rejects it.  The port uses an anchored regex to match
    // TryParse, and this test pins the resulting split.
    const data = await parsed("Turkey", ".asc");

    assertEquals(data.metadata.gear, -96, "gear");
    assertEquals(data.metadata.refractiveIndex, 1.76, "refractive index");
    assertEquals(data.tiers.length, 11, "tier count");

    // Check: the beak tier keeps exactly one index, 30, named "E" -- the
    // trailing "G E  (Beak optional)" is instructions, not two more facets.
    const beak = data.tiers[9];
    assertEquals(beak.angle, 8.0, "beak tier angle");
    assertEquals(beak.indices.length, 1, "beak tier facet count");
    assertEquals(beak.indices[0].index, 30, "beak index number");
    assertEquals(beak.indices[0].name, "E", "beak facet name");

    // Check: the table tier likewise keeps only -96 named "T".
    const table = data.tiers[10];
    assertEquals(table.indices.length, 1, "table facet count");
    assertEquals(table.indices[0].index, -96, "table index number");
    assertEquals(table.indices[0].name, "T", "table facet name");

    // Check: the 16-facet crown tier, whose instructions are on a CONTINUATION
    // line (" G Fix girdle width.") that the original silently discards,
    // because after trimming its first token is "G", which matches no line
    // type.  Ported as is: the facet list must be exactly the 16 on the a-line.
    assertEquals(data.tiers[5].indices.length, 16, "crown tier facet count");
    assertEquals(data.tiers[5].indices.map((x) => x.index),
        [66, 30, 70, 26, 74, 22, 78, 18, 82, 14, 86, 10, 90, 6, 94, 2], "crown index numbers");

    // Check: the ASC path records cuttingInstructions on every tier, as strings
    // ("" for a tier with none).  The C# original parses them, logs them and drops
    // them (and the " G ..." continuation line above); this port deliberately does
    // not, so that a .asc loses nothing its .gem twin keeps.  Turkey's crown tier
    // (index 5) has its instructions only on the continuation line.
    assert(data.tiers.every((t) => typeof t.cuttingInstructions === "string"),
        "the ASC path should record cuttingInstructions as a string on every tier");
    assertEquals(data.tiers[5].cuttingInstructions, "Fix girdle width.",
        "instructions from a continuation line");
});

Deno.test("ASC and GEM carry the same cutting instructions for every design", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: the four bundled designs exist as both .asc and .gem, written by
    // GemCad from the same design.  The .gem stores each tier's instructions in its
    // binary records; the .asc stores them after a "G" marker on the tier's "a" line
    // or on a following " G ..." line.
    // Test: read both and compare, tier for tier.
    // Verifies: the .asc reader recovers exactly the text the .gem reader does
    // (ignoring only empty vs missing), which is the independent check that
    // the "G" marker and continuation handling is right, not merely self-consistent.
    for (const design of ["Compear125", "CubeIllusionTri", "SRB", "Turkey"]) {
        const asc = await parsed(design, ".asc");
        const gem = await parsed(design, ".gem");

        assertEquals(asc.tiers.map((t) => t.cuttingInstructions || ""),
            gem.tiers.map((t) => t.cuttingInstructions || ""),
            design + ": cutting instructions per tier");
    }
});

Deno.test("the GEM trailer yields the same headers, footnotes and metadata as the ASC text", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: the .gem trailer stores its text as length-prefixed ANSI strings:
    // headers first, then a whitespace-only string acting as a separator, then
    // footnotes.  Reading it requires the one-byte push-back in
    // readAnsiString(reader, false) (PORT TRAP 5); without it the reader
    // desynchronises and the footnote is lost or garbled.
    const gem = await parsed("Compear125", ".gem");
    const asc = await parsed("Compear125", ".asc");

    // Check: the binary trailer's metadata matches the text file's g/y/I lines.
    assertEquals(gem.metadata.gear, 96, "gear from the binary trailer");
    assertEquals(gem.metadata.gearLocationAngle, 0.0, "gear location angle");
    assertEquals(gem.metadata.symmetryFolds, 1, "symmetry folds");
    assertEquals(gem.metadata.symmetryMirror, true, "symmetry mirror flag");
    assertEquals(gem.metadata.refractiveIndex, 1.54, "refractive index");

    // Check: the footnote survives the separator handling intact.
    assertEquals(gem.metadata.footnotes,
        ["Dop so the center of the round end is at the center of the dop."], "footnotes");
    assertEquals(gem.metadata.footnotes, asc.metadata.footnotes,
        "the two formats should carry the same footnote text");

    // Check: the binary packs the first two header lines into one string, so
    // the header lists differ in shape between formats even though the words
    // are the same.  Asserted rather than glossed over, because a future reader
    // of the golden files will otherwise think one of them is wrong.
    assertEquals(gem.metadata.headers, [
        "05.101 Compear 1:1.25",
        "by Robert W. Strickland   4/9/96",
        "TFG Newsletter, Jan/Apr 96, p32"
    ], "headers from the binary trailer");

    // Check: the .gem path DOES record cutting instructions (the .asc path does
    // not), and the binary omits the leading "G" marker the text file carries.
    assertEquals(gem.tiers[0].cuttingInstructions, "Meet center point",
        "tier 1 cutting instructions from the binary");
});

// ===========================================================================
// 4. Cross-format agreement -- the strongest check available without .NET
// ===========================================================================

Deno.test("ASC and GEM agree on every design's metadata", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: parse both encodings of all four designs.  The .asc numbers are
    // read from text; the .gem numbers come out of a 28-byte binary trailer
    // located by a heuristic.  Nothing links the two but the design itself.
    for (const design of DESIGNS) {
        const asc = await parsed(design, ".asc");
        const gem = await parsed(design, ".gem");

        // Check: gear, gear location angle, symmetry and refractive index are
        // bit-identical.  Measured, not tuned: these all compared exactly equal
        // on the first run, so no tolerance is needed or allowed.
        assertEquals(gem.metadata.gear, asc.metadata.gear, design + ": gear");
        assertEquals(gem.metadata.gearLocationAngle, asc.metadata.gearLocationAngle,
            design + ": gear location angle");
        assertEquals(gem.metadata.symmetryFolds, asc.metadata.symmetryFolds,
            design + ": symmetry folds");
        assertEquals(gem.metadata.symmetryMirror, asc.metadata.symmetryMirror,
            design + ": symmetry mirror");
        assertEquals(gem.metadata.refractiveIndex, asc.metadata.refractiveIndex,
            design + ": refractive index");
        assertEquals(gem.tiers.length, asc.tiers.length, design + ": tier count");
        assertEquals(allFacets(gem).length, allFacets(asc).length, design + ": facet count");
    }
});

Deno.test("ASC and GEM agree on every tier's angle and distance", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: the ASC tier angle and distance are literals from the file.  The
    // GEM ones are recovered from the stored facet normal: the angle from
    // AngleBetweenConnectedVectors rounded to 2 dp with banker's rounding, the
    // distance from the deliberately non-standard FindRayPlaneIntersection.
    // Agreement therefore exercises PORT TRAPs 2 and 9 together.
    let worstDistanceError = 0;
    for (const design of DESIGNS) {
        const asc = await parsed(design, ".asc");
        const gem = await parsed(design, ".gem");

        for (let i = 0; i < asc.tiers.length; i++) {
            // Check: angles match EXACTLY.  The .asc values all have at most 2
            // decimals and the .gem back-computation rounds to 2 decimals, so
            // the recovered value lands on the same double.  Measured: the
            // maximum difference over all 50 tiers of all four designs is 0.
            assertEquals(gem.tiers[i].angle, asc.tiers[i].angle,
                design + " tier " + (i + 1) + ": angle");

            // Check: distances match to 1e-8.  They cannot match exactly --
            // the .gem stores vertex coordinates that GemCad itself rounded, so
            // the recovered distance carries ~1e-9 of noise.  Measured worst
            // case across all four designs: 4.91e-9, so 1e-8 is the smallest
            // round tolerance that holds, not a number tuned until it passed.
            assertClose(gem.tiers[i].distance, asc.tiers[i].distance, 1e-8,
                design + " tier " + (i + 1) + ": distance");
            worstDistanceError = Math.max(worstDistanceError,
                Math.abs(gem.tiers[i].distance - asc.tiers[i].distance));
        }
    }
    assert(worstDistanceError < 1e-8,
        "worst tier-distance disagreement was " + worstDistanceError);
});

Deno.test("ASC and GEM agree on facet index numbers, facet by facet", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: the .asc lists index numbers directly; the .gem has none and
    // derives each from the stored facet normal's bearing in the xy plane.
    // Index numbers live modulo the gear tooth count, so 96, -96 and 0 all mean
    // the same tooth on a 96-tooth gear; normaliseIndex folds those together.
    //
    // THIS TEST USED TO ALLOW ONE KNOWN MISMATCH.  It no longer does, and the
    // history is worth keeping because it is a lesson about the test, not just
    // about the code (T-0088).
    //
    //   The binary reader derives index numbers with arithmetic that assumed a
    //   positive gear.  GemCad writes a NEGATIVE gear (`g -96 48.0`) to mean the
    //   wheel runs the other way, and the original then drove negative values
    //   further negative and took an absolute value, reflecting the wheel: tooth
    //   i came back as `teeth - i`.  Turkey.gem was wrong on 71 of its 74
    //   facets and CubeIllusionTri.gem on all 51, by up to 165 degrees.
    //
    //   Only ONE of those showed up here, because this test compared each
    //   tier's SET of index numbers.  These designs are mirror-symmetric, so
    //   reflecting the wheel maps a tier's index set onto itself -- facets
    //   merely swap labels with each other.  Turkey tier 10 is a single facet
    //   with no partner to swap with, which is the only reason anything was
    //   visible at all.
    //
    //   So the set comparison below is kept, but a per-FACET comparison is now
    //   done first.  A set-wise test cannot see a permutation, and a mirrored
    //   index wheel is exactly a permutation.
    const foundMismatches = [];

    for (const design of DESIGNS) {
        const asc = await parsed(design, ".asc");
        const gem = await parsed(design, ".gem");

        for (let i = 0; i < asc.tiers.length; i++) {
            const ascIndices = asc.tiers[i].indices
                .map((x) => normaliseIndex(x.index, asc.metadata.gear)).sort((a, b) => a - b);
            const gemIndices = gem.tiers[i].indices
                .map((x) => normaliseIndex(x.index, gem.metadata.gear)).sort((a, b) => a - b);

            // Check: the facet COUNT per tier always matches, even where the
            // labels do not.  A count mismatch would mean a facet was invented
            // or lost, which is a different and far worse class of bug.
            assertEquals(gemIndices.length, ascIndices.length,
                design + " tier " + (i + 1) + ": facet count");

            // Check (the one that matters): facet j of a tier in the text and
            // facet j of the same tier in the binary are the same tooth.  The
            // two readers fill their tiers in the same order, so this pairing is
            // meaningful -- and unlike the sorted comparison below, it cannot be
            // satisfied by a permutation.
            for (let j = 0; j < asc.tiers[i].indices.length; j++) {
                const fromAsc = normaliseIndex(asc.tiers[i].indices[j].index, asc.metadata.gear);
                const fromGem = normaliseIndex(gem.tiers[i].indices[j].index, gem.metadata.gear);

                assertEquals(fromGem, fromAsc,
                    design + " tier " + (i + 1) + " facet " + j + ": index number");
            }

            if (JSON.stringify(ascIndices) !== JSON.stringify(gemIndices)) {
                foundMismatches.push(design + " tier " + (i + 1));
            }
        }
    }

    // Check: no tier disagrees at all any more.
    assertEquals(foundMismatches.sort(), [],
        "index-number disagreements between the two formats");

    // Check: the facet that used to be the visible symptom.  Turkey's single
    // "E" beak facet read 30 from the text and 66 from the binary; both now
    // read 30.  Its normal was always right -- only the label was wrong -- so
    // the normals are compared too, which is what made the diagnosis possible.
    const turkeyAsc = (await parsed("Turkey", ".asc")).tiers[9].indices[0];
    const turkeyGem = (await parsed("Turkey", ".gem")).tiers[9].indices[0];
    assertEquals(turkeyAsc.index, 30, "Turkey beak index from the text file");
    assertEquals(turkeyGem.index, 30, "Turkey beak index back-computed from the binary");
    assertEquals(turkeyAsc.name, turkeyGem.name, "Turkey beak facet name");
    const a = unitVector(turkeyAsc.facetNormal);
    const g = unitVector(turkeyGem.facetNormal);
    assertClose(a.x, g.x, 1e-6, "Turkey beak normal x");
    assertClose(a.y, g.y, 1e-6, "Turkey beak normal y");
    assertClose(a.z, g.z, 1e-6, "Turkey beak normal z");
});

Deno.test("ASC reconstruction and GEM stored geometry describe the same solid", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: this is the deepest cross-check in the suite.  The ASC path never
    // sees a single coordinate from the file: it starts from a cube of
    // half-size 10 and slices it with one plane per facet, keeping each cut
    // cross-section as a facet.  The GEM path reads GemCad's own vertices.  If
    // the plane generation, the clipping, the point de-duplication and the
    // perimeter ordering were all correct, the two must land on the same solid.
    //
    // Facets are paired within a tier by closest normal direction rather than
    // by index number, so the Turkey labelling defect above does not interfere.
    for (const design of DESIGNS) {
        const asc = await parsed(design, ".asc");
        const gem = await parsed(design, ".gem");
        const ascFacets = allFacets(asc);
        const gemFacets = allFacets(gem);
        const taken = new Set();

        let worstNormalAngle = 0;
        let worstPointDistance = 0;

        for (const a of ascFacets) {
            const na = unitVector(a.facet.facetNormal);
            let bestDot = -2;
            let bestIndex = -1;
            gemFacets.forEach((g, i) => {
                if (taken.has(i) || g.tierIndex !== a.tierIndex) {
                    return;
                }
                const ng = unitVector(g.facet.facetNormal);
                const dot = na.x * ng.x + na.y * ng.y + na.z * ng.z;
                if (dot > bestDot) {
                    bestDot = dot;
                    bestIndex = i;
                }
            });
            assert(bestIndex >= 0, design + ": no GEM facet left to pair with an ASC facet");
            taken.add(bestIndex);
            const g = gemFacets[bestIndex];

            worstNormalAngle = Math.max(worstNormalAngle,
                Math.acos(Math.min(1, bestDot)) * 180 / Math.PI);

            // Check: after welding coincident points, the two facets have the
            // same number of corners.  Welding is needed because the ASC
            // reconstruction emits duplicate vertices -- the upstream
            // de-duplication tolerance is 1e-10 while the cutting arithmetic
            // leaves neighbouring points ~1e-8 apart, so IsSamePoint does not
            // merge them.  Measured: 96 duplicate points on SRB and 20 on
            // Compear125, none at all on CubeIllusionTri or Turkey, and none
            // ever on the GEM side.  This matters downstream: anything
            // rendering the ASC path's polygons has to weld them first.
            const ascWelded = weldPoints(a.facet.points, 1e-6);
            const gemWelded = weldPoints(g.facet.points, 1e-6);
            assertEquals(ascWelded.length, gemWelded.length,
                design + " tier " + (a.tierIndex + 1) + ": corner count after welding");

            // Check: every ASC corner coincides with a GEM corner.
            for (const p of ascWelded) {
                let nearest = Infinity;
                for (const q of gemWelded) {
                    nearest = Math.min(nearest, distance3d(p, q));
                }
                worstPointDistance = Math.max(worstPointDistance, nearest);
            }
        }

        // Check: the paired normals agree to better than 1e-5 degrees and the
        // corner positions to better than 1e-5 model units.  Measured worst
        // cases over all four designs: 1.48e-6 degrees and 1.21e-6 units, both
        // consistent with the ~1e-9 rounding GemCad applied when it wrote the
        // .gem files.  The tolerances are one decade above what was measured,
        // chosen once and not adjusted.
        assert(worstNormalAngle < 1e-5,
            design + ": worst facet-normal disagreement was " + worstNormalAngle + " degrees");
        assert(worstPointDistance < 1e-5,
            design + ": worst corner disagreement was " + worstPointDistance + " units");
    }
});

// ===========================================================================
// 5. Geometric invariants that must hold of any correct facet
// ===========================================================================

Deno.test("every facet is a usable planar polygon in both formats", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: walk every facet of every design in both encodings.
    for (const design of DESIGNS) {
        for (const extension of [".asc", ".gem"]) {
            const data = await parsed(design, extension);
            const label = design + extension;
            let facetCount = 0;

            for (const { tier, facet } of allFacets(data)) {
                facetCount++;

                // Check: at least 3 points, or it is not a polygon at all and
                // ConvertCoplanarPointsToTriangles would emit nothing.
                assert(facet.points.length >= 3,
                    label + ": a facet has only " + facet.points.length + " points");

                // Check: no NaN or Infinity anywhere -- not in the points, not
                // in the facet normal, not in the derived rendering triangles
                // or their per-vertex normals.  A single division by a zero
                // vector length anywhere in the chain would show up here.
                const numbers = [];
                for (const p of facet.points) {
                    numbers.push(p.x, p.y, p.z);
                }
                numbers.push(facet.facetNormal.x, facet.facetNormal.y, facet.facetNormal.z);
                for (const triangle of facet.renderingTriangles) {
                    for (const vertex of triangle.vertices) {
                        numbers.push(vertex.vertex.x, vertex.vertex.y, vertex.vertex.z);
                        numbers.push(vertex.normal.x, vertex.normal.y, vertex.normal.z);
                    }
                    numbers.push(triangle.normal.x, triangle.normal.y, triangle.normal.z);
                }
                for (const n of numbers) {
                    assert(Number.isFinite(n), label + ": non-finite coordinate " + n);
                }

                // Check: the points are coplanar, measured as the spread of
                // their signed distances along the facet's own unit normal.
                // Tolerance 1e-8: the ASC path is exact to ~1e-14 because it
                // computes intersections with that very plane, while the GEM
                // path inherits GemCad's stored rounding and spreads by up to
                // 3.05e-9 (measured, on Compear125).
                const n = unitVector(facet.facetNormal);
                const along = facet.points.map((p) => n.x * p.x + n.y * p.y + n.z * p.z);
                const spread = Math.max(...along) - Math.min(...along);
                assert(spread < 1e-8, label + ": facet points are not coplanar, spread " + spread);

                // Check: the plane the points lie on is the plane the tier
                // declares -- the mean distance along the normal equals the
                // tier's own distance.  This ties the geometry back to the cut
                // parameters, so a facet placed on the right plane but at the
                // wrong depth would be caught.  Tolerance 1e-8 for the same
                // reason as above (worst measured: 4.36e-10, on Compear125.gem).
                const mean = along.reduce((s, v) => s + v, 0) / along.length;
                assertClose(mean, tier.distance, 1e-8,
                    label + ": facet is not on its tier's plane");

                // Check: subdivision produced 4 triangles per source triangle,
                // and a facet of k points fans into k-2 source triangles.
                assertEquals(facet.renderingTriangles.length, (facet.points.length - 2) * 4,
                    label + ": rendering triangle count for a " + facet.points.length +
                    "-point facet");
            }

            assert(facetCount > 0, label + ": no facets were produced at all");
        }
    }
});

// ===========================================================================
// 6. Golden snapshots -- regression cover, not a correctness proof
// ===========================================================================

/**
 * A compact, deterministic summary of a parsed design.  Coordinates are rounded
 * to 6 decimals so the files stay small and are not churned by last-bit
 * floating-point differences.  Rendering triangles are summarised by count
 * only: they are a pure function of the points, and storing 3000 of them per
 * design would make the snapshots useless to read.
 */
function snapshot(data) {
    const round = (v) => Number(v.toFixed(6)) + 0; // "+ 0" turns -0 into 0
    return {
        metadata: {
            gear: data.metadata.gear,
            gearLocationAngle: data.metadata.gearLocationAngle,
            refractiveIndex: data.metadata.refractiveIndex,
            symmetryFolds: data.metadata.symmetryFolds,
            symmetryMirror: data.metadata.symmetryMirror,
            headers: data.metadata.headers,
            footnotes: data.metadata.footnotes
        },
        tiers: data.tiers.map((tier) => ({
            number: tier.number,
            isPreform: tier.isPreform,
            angle: tier.angle,
            distance: round(tier.distance),
            cuttingInstructions: tier.cuttingInstructions,
            indices: tier.indices.map((facet) => ({
                tier: facet.tier,
                name: facet.name,
                index: facet.index,
                facetNormal: [round(facet.facetNormal.x), round(facet.facetNormal.y),
                    round(facet.facetNormal.z)],
                points: facet.points.map((p) => [round(p.x), round(p.y), round(p.z)]),
                renderingTriangleCount: facet.renderingTriangles.length
            }))
        }))
    };
}

/**
 * JSON with one object per line-block but every numeric array inlined, so a
 * facet's point list reads as one line instead of fifteen.  Plain
 * JSON.stringify(x, null, 1) makes the eight snapshots 296 KB; this makes them
 * about a fifth of that and far easier to read a diff of.
 */
function stringifyCompact(value, indent) {
    indent = indent || "";
    const isNumberArray = (v) => Array.isArray(v) && v.every((n) => typeof n === "number");
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return "[]";
        }
        if (isNumberArray(value) || value.every(isNumberArray)) {
            return JSON.stringify(value);
        }
        const inner = indent + " ";
        return "[\n" + value.map((v) => inner + stringifyCompact(v, inner)).join(",\n") +
            "\n" + indent + "]";
    }
    if (value !== null && typeof value === "object") {
        const keys = Object.keys(value);
        if (keys.length === 0) {
            return "{}";
        }
        const inner = indent + " ";
        return "{\n" + keys.map((k) =>
            inner + JSON.stringify(k) + ": " + stringifyCompact(value[k], inner)).join(",\n") +
            "\n" + indent + "}";
    }
    return JSON.stringify(value);
}

Deno.test("parsed output matches the golden snapshots", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: for each of the eight sample files, build the summary above and
    // compare it with the checked-in JSON.  These snapshots were generated from
    // this implementation, so they prove nothing about correctness on their
    // own -- the tests above do that.  What they catch is the thing those tests
    // cannot: a change that quietly moves a coordinate, drops a header or
    // renames a facet while still satisfying every invariant.
    //
    // To regenerate after an intended change:
    //   GEMCAD_UPDATE_GOLDEN=1 deno test --allow-read --allow-write --allow-env \
    //       www/js/tests/
    // and read the diff before committing it.
    let updating = false;
    try {
        updating = Deno.env.get("GEMCAD_UPDATE_GOLDEN") === "1";
    } catch (_error) {
        updating = false; // no --allow-env; just compare
    }

    for (const design of DESIGNS) {
        for (const extension of [".asc", ".gem"]) {
            const actual = snapshot(await parsed(design, extension));
            const path = new URL(design + extension + ".json", GOLDEN_URL);
            const text = stringifyCompact(actual) + "\n";

            if (updating) {
                await Deno.mkdir(GOLDEN_URL, { recursive: true });
                await Deno.writeTextFile(path, text);
                continue;
            }

            const expected = JSON.parse(await Deno.readTextFile(path));
            // Compare piecewise so a failure names the tier rather than dumping
            // the whole design.
            assertEquals(actual.metadata, expected.metadata,
                design + extension + ": metadata");
            assertEquals(actual.tiers.length, expected.tiers.length,
                design + extension + ": tier count");
            for (let i = 0; i < expected.tiers.length; i++) {
                assertEquals(actual.tiers[i], expected.tiers[i],
                    design + extension + ": tier " + (i + 1));
            }
        }
    }
});

// ===========================================================================
// 7. Unit tests for the places where C# and JS semantics differ
//
// These are the spots where a naive transliteration silently changes
// behaviour.  Each one is pinned here so a later "tidy-up" cannot undo it.
// ===========================================================================

Deno.test("PORT TRAP 1: double.Epsilon comparisons mean 'is not zero'", () => {
    // Setup: C#'s double.Epsilon is 4.94e-324, the smallest subnormal, not
    // machine epsilon.  The port exposes the constant it uses.
    // Check: it is Number.MIN_VALUE, not Number.EPSILON.  The two differ by
    // 308 orders of magnitude, so confusing them turns "x != 0" into
    // "|x| > 2.2e-16" and, for example, makes GeometryOperations.rotatePoint
    // skip rotations by tiny angles that the reference performs.
    assertEquals(GemCad.constants.DOUBLE_EPSILON, Number.MIN_VALUE,
        "the port must use the smallest subnormal, not machine epsilon");
    assert(GemCad.constants.DOUBLE_EPSILON !== Number.EPSILON,
        "Number.EPSILON would change behaviour");

    // Check: a rotation by an angle far below machine epsilon is still carried
    // out, i.e. the guard behaves as "is not zero".  The rotation is by such a
    // small angle that the point barely moves, so the observable effect is that
    // the code path runs and returns a finite result rather than short-circuiting.
    const rotated = GemCad.GeometryOperations.rotatePoint(
        new GemCad.Vertex3D(1, 0, 0), 0, 1e-300, 0, new GemCad.Vertex3D());
    assert(Number.isFinite(rotated.x) && Number.isFinite(rotated.y),
        "a 1e-300 degree rotation should still be computed");
});

Deno.test("PORT TRAP 2: rounding is half-to-even, as in C#, not half-up", () => {
    // Setup: C# Math.Round and Convert.ToInt32 use banker's rounding;
    // JS Math.round rounds halves towards +Infinity.
    // Check: the classic midpoint cases, on both sides of zero.
    assertEquals(GemCad.roundHalfToEvenInteger(0.5), 0, "0.5 -> 0 (0 is even)");
    assertEquals(GemCad.roundHalfToEvenInteger(1.5), 2, "1.5 -> 2");
    assertEquals(GemCad.roundHalfToEvenInteger(2.5), 2, "2.5 -> 2, where Math.round gives 3");
    assertEquals(GemCad.roundHalfToEvenInteger(3.5), 4, "3.5 -> 4");
    assertEquals(GemCad.roundHalfToEvenInteger(-2.5), -2, "-2.5 -> -2");
    assertEquals(GemCad.roundHalfToEvenInteger(-3.5), -4, "-3.5 -> -4, where Math.round gives -3");

    // Check: JS really would disagree, so the helper is not redundant.
    assert(Math.round(2.5) !== GemCad.roundHalfToEvenInteger(2.5),
        "Math.round and banker's rounding must differ at 2.5");
    assert(Math.round(-3.5) !== GemCad.roundHalfToEvenInteger(-3.5),
        "Math.round and banker's rounding must differ at -3.5");

    // Check: non-midpoints round normally, in both directions.
    assertEquals(GemCad.roundHalfToEvenInteger(2.4), 2, "2.4 -> 2");
    assertEquals(GemCad.roundHalfToEvenInteger(2.6), 3, "2.6 -> 3");
    assertEquals(GemCad.roundHalfToEvenInteger(-2.6), -3, "-2.6 -> -3");

    // Check: the 2-decimal form used by CalculateTierDefinitions for tier angles.
    assertEquals(GemCad.roundHalfToEven(41.355, 2), 41.36, "41.355 -> 41.36");
    assertEquals(GemCad.roundHalfToEven(-46.0000001, 2), -46, "-46.0000001 -> -46");
    assertEquals(GemCad.roundHalfToEven(0.125, 2), 0.12, "0.125 -> 0.12 (2 is even)");

    // Check: Convert.ToInt32 rejects values that will not fit in an Int32,
    // as the original would throw an OverflowException.
    let threw = false;
    try {
        GemCad.convertToInt32(3e9);
    } catch (_error) {
        threw = true;
    }
    assert(threw, "convertToInt32 should reject a value outside the Int32 range");
});

Deno.test("PORT TRAP 3: number parsing is strict, whole-string, like TryParse", () => {
    // Setup: the .asc a-line parser uses the FAILURE of double.TryParse to
    // detect the start of the cutting instructions.  parseFloat/parseInt are
    // prefix parsers and would never fail on text beginning with a digit.
    // Check: valid forms parse.
    assertEquals(GemCad.tryParseFloat("0.36450932"), 0.36450932, "plain decimal");
    assertEquals(GemCad.tryParseFloat("-96"), -96, "negative integer");
    assertEquals(GemCad.tryParseFloat("  1.5  "), 1.5, "surrounding whitespace is allowed");
    assertEquals(GemCad.tryParseFloat("1e3"), 1000, "exponent form");
    assertEquals(GemCad.tryParseInt("96"), 96, "integer");
    assertEquals(GemCad.tryParseInt("-96"), -96, "negative integer");

    // Check: the forms that must FAIL.  Every one of these returns a number
    // from parseFloat or parseInt, which is exactly how a naive port breaks.
    for (const text of ["30abc", "96 n 1", "G", "", "   ", "n", "1,234", "0x10", "--3", "1.2.3"]) {
        assertEquals(GemCad.tryParseFloat(text), null,
            "tryParseFloat(" + JSON.stringify(text) + ") must fail");
    }
    assert(!Number.isNaN(parseFloat("30abc")),
        "parseFloat really does accept '30abc'; that is why tryParseFloat exists");

    // Check: int parsing rejects decimals, which double parsing accepts.  The
    // `g` line uses int.TryParse for the gear and double.TryParse for the
    // location angle, so the distinction is load-bearing.
    assertEquals(GemCad.tryParseInt("1.5"), null, "int parsing must reject a decimal");
    assertEquals(GemCad.tryParseFloat("1.5"), 1.5, "double parsing accepts it");
    assertEquals(GemCad.tryParseInt("3000000000"), null, "outside Int32 range");
});

Deno.test("PORT TRAP 4: assignment copies values instead of aliasing references", () => {
    // Setup: build a vertex and assign it into a polygon vertex, then mutate
    // the source.  In C# the property setter calls Assign(), which copies the
    // three doubles into the existing instance.
    const source = new GemCad.Vertex3D(1, 2, 3);
    const pv = new GemCad.PolygonVertex(source);
    source.x = 999;

    // Check: the polygon vertex kept the value it was given.  If the port had
    // stored the reference, this would read 999 and the cutting code -- which
    // mutates vertices in place constantly -- would corrupt geometry silently.
    assertEquals(pv.vertex.x, 1, "PolygonVertex must copy, not alias");

    // Check: the same for Polygon.normal and for a Triangle's point setters.
    const triangle = new GemCad.Triangle();
    const normal = new GemCad.Vertex3D(0, 0, 1);
    triangle.normal = normal;
    normal.z = 42;
    assertEquals(triangle.normal.z, 1, "Polygon.normal must copy, not alias");

    const other = new GemCad.PolygonVertex(new GemCad.Vertex3D(7, 8, 9));
    triangle.p1 = other;
    other.vertex.x = 111;
    assertEquals(triangle.p1.vertex.x, 7, "Triangle.p1 must copy, not alias");

    // Check: a Triangle refuses to change its point count, like the C#
    // PointCountImmutable override, while a plain Polygon accepts it -- the
    // rough cube's faces rely on being mutable.
    let threw = false;
    try {
        triangle.add(new GemCad.PolygonVertex(new GemCad.Vertex3D()));
    } catch (_error) {
        threw = true;
    }
    assert(threw, "a Triangle must not accept a fourth point");

    const polygon = new GemCad.Polygon(4);
    polygon.add(new GemCad.PolygonVertex(new GemCad.Vertex3D()));
    assertEquals(polygon.vertices.length, 5, "a plain Polygon may grow");
    polygon.removeAt(0);
    assertEquals(polygon.vertices.length, 4, "a plain Polygon may shrink");
});

Deno.test("PORT TRAP 5: the binary reader is little-endian and can seek backwards", () => {
    // Setup: a buffer holding the little-endian encodings of the int32 1, the
    // double 1.54 and the byte 0x41.  1.54 is the refractive index stored in
    // three of the four sample .gem files, so this is the real encoding.
    const bytes = new Uint8Array([
        0x01, 0x00, 0x00, 0x00,
        0xa4, 0x70, 0x3d, 0x0a, 0xd7, 0xa3, 0xf8, 0x3f,
        0x41
    ]);
    const reader = new GemCad.BinaryReader(bytes);

    // Check: little-endian decoding.  Read big-endian, the int32 would be
    // 16777216 and the double a denormal; the trailer heuristic would never
    // fire and no file would parse.
    assertEquals(reader.readInt32(), 1, "int32 must be little-endian");
    assertEquals(reader.readDouble(), 1.54, "double must be little-endian");

    // Check: the backward seek the parser needs.  ParseBinaryData speculatively
    // reads 16 bytes to test for the trailer and restores the position when the
    // test fails; readAnsiString steps back one byte after peeking.
    const saved = reader.position;
    assertEquals(reader.readByte(), 0x41, "byte read");
    reader.position = saved;
    assertEquals(reader.readByte(), 0x41, "the same byte after seeking back");
    reader.position -= 1;
    assertEquals(reader.readByte(), 0x41, "and again after a one-byte push-back");

    // Check: reading past the end throws, as .NET's BinaryReader does for the
    // fixed-width reads, while readBytes returns a short buffer instead.
    let threw = false;
    try {
        reader.readInt32();
    } catch (_error) {
        threw = true;
    }
    assert(threw, "reading an int32 past the end should throw");
    reader.position = bytes.length - 1;
    assertEquals(reader.readBytes(8).length, 1, "readBytes returns what is left");
});

Deno.test("PORT TRAP 6: ASCII decoding replaces high bytes with '?'", () => {
    // Setup: bytes spanning the ASCII range and above it.
    // Check: .NET's Encoding.ASCII maps every byte >= 0x80 to '?' (0x3F).  A
    // String.fromCharCode loop would produce Latin-1 accented characters and a
    // TextDecoder would produce U+FFFD or multi-byte characters, either of
    // which would change a facet name or header read from a .gem file.
    assertEquals(GemCad.asciiGetString(new Uint8Array([0x48, 0x69])), "Hi", "plain ASCII");
    assertEquals(GemCad.asciiGetString(new Uint8Array([0x80, 0xe9, 0xff])), "???",
        "high bytes become question marks");
    assertEquals(GemCad.asciiGetString(new Uint8Array([0x09, 0x54])), "\tT",
        "control characters pass through; the tab separates name from instructions");
});

Deno.test("PORT TRAP 7: splitting keeps empty entries", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: Compear125.asc has the header line
    //     H by Robert W. Strickland   4/9/96
    // with THREE spaces before the date.  C# splits on ' ' with
    // StringSplitOptions.None, so those become two empty tokens that are then
    // put back by `string.Join(" ", parts.Skip(1))`, preserving the run.
    // JS split(" ") behaves the same -- as long as the port resists the urge to
    // filter the empties out, which would collapse the run to one space.
    const asc = await parsed("Compear125", ".asc");
    assertEquals(asc.metadata.headers[1], "by Robert W. Strickland   4/9/96",
        "the run of three spaces must survive the split-and-rejoin");
    assert(asc.metadata.headers[1].includes("   "),
        "filtering empty split entries would have collapsed this to one space");

    // Check: the .gem file stores that same line as one length-prefixed string,
    // so it is independent evidence of what the spacing should be.  The two
    // agree, which is what makes this a test of the port rather than of itself.
    const gem = await parsed("Compear125", ".gem");
    assertEquals(gem.metadata.headers[1], asc.metadata.headers[1],
        "the binary's copy of the line has the same spacing");

    // Check: empty entries also count towards parts.length, which the `g`, `y`
    // and `I` handlers test against exact values (3, 3 and 2).  "g 96 0.0" is
    // exactly 3 tokens and is accepted; a line with a doubled space would be 4
    // and would be ignored, as in the original.
    assertEquals(asc.metadata.gear, 96, "a well-formed g line was accepted");
    assertEquals("g 96 0.0".split(" ").length, 3, "the g line really is three tokens");
    assertEquals("g  96 0.0".split(" ").length, 4,
        "and a doubled space would make four, which the handler rejects");
});

Deno.test("PORT TRAP 8: the four-point CalculateNormal keeps its upstream bug", () => {
    // Setup: the C# overload CalculateNormal(p1,p2,p3,p4) computes
    //   n1 = CalculateNormal(p1, p2, p4)
    //   n2 = CalculateNormal(p3, p3, p4)   <-- p3 twice; clearly meant p3,p4,?
    // and returns n1 + n2.  Because n2 crosses a zero vector with something, it
    // is always (0,0,0), so the result is just n1.
    // Check: that is what the port returns.  This function is dead code in both
    // import paths; it is kept, bug and all, so the port remains a true mirror.
    // "Fixing" it here would make the port disagree with the reference.
    const p1 = new GemCad.Vertex3D(0, 0, 0);
    const p2 = new GemCad.Vertex3D(1, 0, 0);
    const p3 = new GemCad.Vertex3D(1, 1, 0);
    const p4 = new GemCad.Vertex3D(0, 1, 0);

    const buggy = GemCad.VectorOperations.calculateNormal4(p1, p2, p3, p4);
    const justN1 = GemCad.VectorOperations.calculateNormal(p1, p2, p4);
    assertClose(buggy.x, justN1.x, 0, "the p3,p3,p4 term contributes nothing (x)");
    assertClose(buggy.y, justN1.y, 0, "the p3,p3,p4 term contributes nothing (y)");
    assertClose(buggy.z, justN1.z, 0, "the p3,p3,p4 term contributes nothing (z)");
});

Deno.test("PORT TRAP 9: the non-standard ray-plane intersection is preserved", () => {
    // Setup: a plane through (0,0,2) with normal +z, and a ray from the origin
    // along +z.  A textbook intersection would be (0,0,2).
    const plane = GemCad.GeometryOperations.createTriangleFromPoints(
        new GemCad.Vertex3D(0, 0, 2),
        new GemCad.Vertex3D(1, 0, 2),
        new GemCad.Vertex3D(0, 1, 2),
        true);
    const origin = new GemCad.Vertex3D(0, 0, 0);
    const direction = new GemCad.Vertex3D(0, 0, 1);

    const hit = GemCad.VectorOperations.findRayPlaneIntersection(origin, direction, plane);

    // Check: the upstream formula is `(rayOrigin - rayDirection) * ((rayOrigin -
    // planePoint) . n) / (rayDirection . n)`, which here gives
    // (0,0,-1) * (-2/1) = (0,0,2).  The distance from the origin -- the only
    // thing GemCadGemImport uses it for -- is therefore 2, the right answer,
    // even though the returned point is not what a textbook formula yields in
    // general.  Ported verbatim; the cross-format distance agreement above is
    // the real evidence that it behaves as the reference does.
    assertClose(hit.x, 0, 1e-12, "intersection x");
    assertClose(hit.y, 0, 1e-12, "intersection y");
    assertClose(hit.z, 2, 1e-12, "intersection z");
    assertClose(GemCad.GeometryOperations.length3d(origin, hit), 2, 1e-12,
        "the derived distance is the plane's distance from the origin");
});

Deno.test("PORT TRAP 10: subdivision output is in flatMap order", () => {
    // Setup: three distinct source triangles, tagged by a unique first vertex
    // so their children can be traced.  The C# builds its result by removing
    // each source triangle from the working list and appending that triangle's
    // four children; the port claims that is identical to a flatMap and
    // implements it as one.  This test is the verification of that claim.
    const sources = [0, 10, 20].map((offset) =>
        GemCad.GeometryOperations.createTriangleFromPoints(
            new GemCad.Vertex3D(offset, 0, 0),
            new GemCad.Vertex3D(offset + 1, 0, 0),
            new GemCad.Vertex3D(offset, 1, 0),
            false));

    const result = GemCad.subdivideTriangles(sources, 1);

    // Check: 4 children per source, in source order.
    assertEquals(result.length, 12, "one iteration turns 3 triangles into 12");

    // Check: the first child of each group is the corner triangle at that
    // source's p1, so children 0, 4 and 8 carry x offsets 0, 10 and 20.  If the
    // order were anything else -- children interleaved, or groups reversed --
    // these would not line up.
    assertEquals(result[0].p1.vertex.x, 0, "group 0 starts at the first source triangle");
    assertEquals(result[4].p1.vertex.x, 10, "group 1 starts at the second");
    assertEquals(result[8].p1.vertex.x, 20, "group 2 starts at the third");

    // Check: within a group the fourth child is the middle triangle, whose
    // three corners are all edge midpoints, so none of them equals a source
    // corner.  This pins the child ordering as well as the group ordering.
    const middle = result[3];
    assertEquals(middle.p1.vertex.x, 0.5, "the middle child starts at the p1-p2 midpoint");
    assertEquals(middle.p1.vertex.y, 0, "and that midpoint is on the base edge");

    // Check: two iterations give 16 per source, i.e. the recursion composes.
    assertEquals(GemCad.subdivideTriangles(sources, 2).length, 48, "two iterations");
    assertEquals(GemCad.subdivideTriangles(sources, 0).length, 3, "zero iterations is a no-op");
});

Deno.test("MathUtils.clockN wraps into the basis and snaps tiny values to zero", () => {
    // Setup: clockN is used to fold index angles into the gear's tooth count
    // and to normalise rotation angles into +-360.  It is a while-loop, not a
    // modulo, and it has a hard 1e-8 snap-to-zero at the end.
    // Check: values above the basis wrap down; values below -basis wrap up.
    assertEquals(GemCad.MathUtils.clockN(400, 360), 40, "400 degrees wraps to 40");
    assertEquals(GemCad.MathUtils.clockN(-400, 360), -40, "-400 degrees wraps to -40");

    // Check: the bounds are not inclusive -- exactly the basis is left alone,
    // which is why an index of 96 on a 96-tooth gear stays 96 in the ASC path
    // instead of becoming 0.
    assertEquals(GemCad.MathUtils.clockN(360, 360), 360, "exactly the basis is unchanged");
    assertEquals(GemCad.MathUtils.clockN(96, 96), 96, "and for a gear count too");

    // Check: a negative basis is made positive first.  Both Turkey and
    // CubeIllusionTri have gear -96, and clockN is called with that directly.
    assertEquals(GemCad.MathUtils.clockN(100, -96), 4, "a negative basis is taken as positive");

    // Check: the snap-to-zero, which keeps -0.0000000001 from surviving as a
    // tiny negative rotation.
    assertEquals(GemCad.MathUtils.clockN(1e-9, 360), 0, "values under 1e-8 snap to zero");
    assertEquals(GemCad.MathUtils.filterAngle(-1e-9), 0, "and through filterAngle too");
});

Deno.test("GetAngle2d returns the bearing of a point in the xy plane", () => {
    // Setup: GetAngle2d is how the GEM path turns a facet normal into an index
    // number, so its convention decides every index in every .gem file.  It is
    // written as a chain of law-of-cosines calls rather than an atan2, which
    // makes it easy to port subtly wrong.
    // Check: it agrees with atan2(y, x) in degrees, on all four quadrants and
    // the axes.  Tolerance 1e-9 because the implementation goes through
    // asin/atan rather than atan2.
    const origin = new GemCad.Vertex3D();
    const cases = [
        [1, 0, 0], [1, 1, 45], [0, 1, 90], [-1, 1, 135],
        [-1, 0, 180], [-1, -1, -135], [0, -1, -90], [1, -1, -45]
    ];
    for (const [x, y, expected] of cases) {
        const actual = GemCad.GeometryOperations.getAngle2d(origin, new GemCad.Vertex3D(x, y, 0));
        assertClose(actual, expected, 1e-9, "bearing of (" + x + ", " + y + ")");
    }
});

Deno.test("importBytes dispatches on the identified format", { ignore: !SAMPLES_PRESENT }, async () => {
    // Setup: hand importBytes the raw bytes of both encodings of one design,
    // without telling it which is which -- that is what GemCadFileImport does.
    // Check: both produce the same design, so the dispatch is right.  A wrong
    // dispatch would throw or return an empty design rather than silently
    // mis-parse, but this pins the public entry point either way.
    const viaDispatch = GemCad.importBytes(await sampleBytes("SRB", ".asc"));
    const viaDirect = GemCad.importAscText(
        new TextDecoder().decode(await sampleBytes("SRB", ".asc")));
    assertEquals(viaDispatch.tiers.length, viaDirect.tiers.length, "same tier count");
    assertEquals(viaDispatch.metadata.gear, viaDirect.metadata.gear, "same gear");

    const gemViaDispatch = GemCad.importBytes(await sampleBytes("SRB", ".gem"));
    const gemViaDirect = GemCad.importGemBytes(await sampleBytes("SRB", ".gem"));
    assertEquals(gemViaDispatch.tiers.length, gemViaDirect.tiers.length, "same tier count");
    assertEquals(gemViaDispatch.metadata.refractiveIndex, gemViaDirect.metadata.refractiveIndex,
        "same refractive index");
});

Deno.test("T-0161: a tier index record whose tier number is 0 still reads its points", () => {
    // Setup: a minimal, hand-built binary .gem: one tier index record
    // followed by a minimal trailer, laid out exactly as parseBinaryData
    // (gemcad.js) reads them:
    //   facet normal:  3 little-endian doubles                    (24 bytes)
    //   tier marker:   int32 -- becomes rec.tier                   (4 bytes)
    //   name length:   byte = 0 (empty name)                       (1 byte)
    //   name marker:   int32, read and discarded by                (4 bytes)
    //                  readAnsiString(reader, true)
    //   point 1:       3 doubles + int32 marker = 1 (more follow) (28 bytes)
    //   point 2:       3 doubles + int32 marker = 1 (more follow) (28 bytes)
    //   point 3:       3 doubles + int32 marker = 0 (list ends)   (28 bytes)
    //   trailer probe: unknown1=0, unknown2 (nonzero sum),
    //                  symmetryFolds>0, symmetryMirror in {0,1}   (16 bytes)
    //   gear:          int32, nonzero (a real design's index gear) (4 bytes)
    //   refractiveIndex: double                                    (8 bytes)
    //   unknown3:      4 bytes, ignored by the reader                (4 bytes)
    //   gearLocationAngle: double                                   (8 bytes)
    // 157 bytes total. The trailer carries a real (nonzero) gear only so
    // that calculateTierDefinitions's own division by `data.metadata.gear`
    // has something valid to divide by -- unrelated to the bug under test --
    // and is deliberately sized so the trailer's own text-line loop and the
    // outer record loop both end exactly at the end of the buffer, so the
    // test needs no header/footnote text.
    //
    // The tier marker is set to 0 on purpose. This is not a corrupt value:
    // by hand-decoding the raw bytes (with xxd) of three real designs in
    // reference/gemology-project-designs/ -- Darts.gem, Pandoro.gem,
    // Sierpinski's_Puzzle.gem -- the marker right after each one's first
    // facet normal genuinely is 0, and real, sensible facet-name /
    // cutting-instruction text ("Cut to centerpoint", "Meet at culet.")
    // immediately follows, proving the byte alignment up to that point is
    // correct: 0 is a legitimate tier number GemCad itself writes, not
    // evidence of a truncated or misaligned file.
    //
    // Before T-0161 the point-reading loop was
    //   `while (out.eodMarker > 0) { ...read a point... }`
    // and `out.eodMarker` at that point still held the tier marker (0 here),
    // unchanged by the name read in between. So it read ZERO points for a
    // real facet and every subsequent record was read from the wrong offset
    // -- observed on the three real files as either "Tier index record has
    // fewer than 3 points" a few records later, or a desync that eventually
    // ran off the end of the buffer ("Unable to read beyond the end of the
    // stream"). This test pins the fix directly: all three points below must
    // survive, even though the record they belong to is tier 0.
    function writeDouble(view, offset, value) {
        view.setFloat64(offset, value, true); // true = little-endian
        return offset + 8;
    }
    function writeInt32(view, offset, value) {
        view.setInt32(offset, value, true);
        return offset + 4;
    }

    const buffer = new ArrayBuffer(157);
    const view = new DataView(buffer);
    let pos = 0;

    // Facet normal. The values are arbitrary except for one constraint: their
    // low-order bytes must not accidentally make parseBinaryData's trailer
    // probe (which reinterprets these same first bytes as unknown1/unknown2
    // if a record turns out not to look like a tier index record) misfire.
    // 0.12345 etc. have irregular binary fractions, so this holds.
    pos = writeDouble(view, pos, 0.12345);
    pos = writeDouble(view, pos, -0.23456);
    pos = writeDouble(view, pos, 1.34567);

    pos = writeInt32(view, pos, 0); // tier marker: 0 -- the bug trigger

    view.setUint8(pos, 0); // name length: 0 (empty name)
    pos += 1;
    pos = writeInt32(view, pos, 0); // name's own trailing marker, discarded

    // Three points. Coordinates are arbitrary; only the trailing markers
    // (whether another point follows) are load-bearing for this test.
    pos = writeDouble(view, pos, 1.0);
    pos = writeDouble(view, pos, 2.0);
    pos = writeDouble(view, pos, 3.0);
    pos = writeInt32(view, pos, 1); // more points follow

    pos = writeDouble(view, pos, 4.0);
    pos = writeDouble(view, pos, 5.0);
    pos = writeDouble(view, pos, 6.0);
    pos = writeInt32(view, pos, 1); // more points follow

    pos = writeDouble(view, pos, 7.0);
    pos = writeDouble(view, pos, 8.0);
    pos = writeDouble(view, pos, 9.0);
    pos = writeInt32(view, pos, 0); // point list ends

    // Minimal trailer: just enough for the trailer-detection probe to
    // recognise it and for calculateTierDefinitions to have a real gear to
    // divide by. No header/footnote text lines: the buffer ends exactly
    // where the trailer's own fields end, so that inner loop never runs.
    pos = writeInt32(view, pos, 0);  // unknown1: must be exactly 0
    view.setUint8(pos, 1);           // unknown2: any nonzero-sum 4 bytes
    view.setUint8(pos + 1, 0);
    view.setUint8(pos + 2, 0);
    view.setUint8(pos + 3, 0);
    pos += 4;
    pos = writeInt32(view, pos, 6);  // symmetryFolds: must be > 0
    pos = writeInt32(view, pos, 0);  // symmetryMirror: must be 0 or 1
    pos = writeInt32(view, pos, 96); // gear: nonzero, a plausible index gear
    pos = writeDouble(view, pos, 1.54); // refractiveIndex
    view.setUint8(pos, 0); view.setUint8(pos + 1, 0);
    view.setUint8(pos + 2, 0); view.setUint8(pos + 3, 0);
    pos += 4;                        // unknown3: ignored by the reader
    pos = writeDouble(view, pos, 0.0); // gearLocationAngle

    assertEquals(pos, 157, "the byte layout above must fill the buffer exactly");

    let result;
    try {
        result = GemCad.importGemBytes(new Uint8Array(buffer));
    } catch (error) {
        throw new Error("a tier numbered 0 must not throw, but it did: " + error.message);
    }

    // Check: exactly one tier actually holds our record. (A separate,
    // pre-existing and harmless quirk -- parseBinaryData seeds its first
    // `currentTier.number` to 1, and any real first tier number other than 1
    // rolls that empty placeholder into `tiers` before the real one -- means
    // there may also be a leading tier with zero indices; this test does not
    // care about that quirk, only about the fix.)
    const nonEmptyTiers = result.tiers.filter((tier) => tier.indices.length > 0);
    assertEquals(nonEmptyTiers.length, 1, "exactly one tier should hold the record");
    assertEquals(nonEmptyTiers[0].number, 0, "that tier's number is the one written above: 0");

    const index = nonEmptyTiers[0].indices[0];
    assertEquals(index.points.length, 3, "all three points must have been read, not zero");
    assertEquals([index.points[0].x, index.points[0].y, index.points[0].z], [1, 2, 3],
        "the first point's coordinates must be the ones written above");
    assertEquals([index.points[2].x, index.points[2].y, index.points[2].z], [7, 8, 9],
        "the third (list-terminating) point's coordinates must be the ones written above");
});
