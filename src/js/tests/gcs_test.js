/*
 * gcs_test.js -- tests for www/js/gcs.js, the Gem Cut Studio .gcs reader (T-0148).
 *
 * HOW TO RUN
 *   deno test --allow-read www/js/tests/
 *
 * Node on this machine is broken (18.6.0, missing libicui18n.70.dylib), so Deno is the
 * runtime here as in the sibling suites (gemcad_test.js, gemcad_obj_test.js,
 * design_test.js). No third-party dependencies.
 *
 * WHY DENO CAN RUN THIS AT ALL
 *   gcs.js does not use DOMParser (Deno has none): it hand-writes a small scanner for
 *   this format's own regular subset, run identically in the browser and here. See
 *   gcs.js's own file header comment for why that beats making the parser injectable.
 *
 * WHAT THIS SUITE IS FOR
 *   The reader's whole job is to make resources/hex_cut_v2.gcs -- the user's own real
 *   design, not a hand-built fixture -- land in EXACTLY the shape GemCad.importBytes
 *   produces, so GemCadObj.toObjText and GemCadDesign.fromGemCad need no code of their
 *   own to read a .gcs. This is therefore an ORACLE suite: it reads the real file and
 *   checks the numbers against ones read straight off the file by hand (the ticket
 *   description for T-0148, and the ten polar angles already hardcoded in
 *   web/src/lib/tiers.js's own selfCheckTierIdsAgainstHexCutV2Gcs, which this file's
 *   `GCS_POLAR_ANGLES` constant is copied from so both places break together if either
 *   drifts from the real file).
 */

// ---------------------------------------------------------------------------
// Minimal assertion helpers, identical in shape to the sibling suites'.
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

function assertThrows(fn, fragment, message) {
    let threw = null;
    try {
        fn();
    } catch (error) {
        threw = error;
    }
    assert(threw !== null, (message || "") + ": expected a throw, got none");
    assert(String(threw.message).includes(fragment),
        (message || "") + ": expected message containing " + JSON.stringify(fragment) +
        ", got " + JSON.stringify(String(threw.message)));
}

// ---------------------------------------------------------------------------
// Loading the libraries. design.js first: gcs.js calls into GemCadDesign (mastAngleOf,
// polarOf, tolerances.indexSnap) from inside importText -- a load-order requirement on
// the bundle, documented in gcs.js's own header comment, not a circular dependency.
// ---------------------------------------------------------------------------

const DESIGN_URL = new URL("../design.js", import.meta.url);
const OBJ_URL = new URL("../gemcad_obj.js", import.meta.url);
const GCS_READER_URL = new URL("../gcs.js", import.meta.url);
const MODEL_URL = new URL("../../resources/hex_cut_v2.gcs", import.meta.url);

(0, eval)(await Deno.readTextFile(DESIGN_URL));
(0, eval)(await Deno.readTextFile(OBJ_URL));
(0, eval)(await Deno.readTextFile(GCS_READER_URL));

const GemCadDesign = globalThis.GemCadDesign;
const GemCadObj = globalThis.GemCadObj;
const GemCutStudio = globalThis.GemCutStudio;

/** Reads and parses resources/hex_cut_v2.gcs, once per call (cheap: 461 lines). */
async function readHexCutV2() {
    const text = await Deno.readTextFile(MODEL_URL);
    return GemCutStudio.importText(text);
}

// ---------------------------------------------------------------------------
// The oracle values, read by hand off resources/hex_cut_v2.gcs (T-0148's ticket
// description) and off web/src/lib/tiers.js's own selfCheckTierIdsAgainstHexCutV2Gcs,
// which hardcodes the identical ten angles for the same reason.
// ---------------------------------------------------------------------------

const GCS_POLAR_ANGLES = [
    143.41952158876754, // P1
    90.000000000001691, // G1
    138.46261326345407, // P2
    55.067690314706212, // C1
    35.177851397757813, // C2
    28.493495654487738, // C3
    24.877384325154125, // C4
    28.244795814968164, // C5
    14.920558437144006, // C6
    0,                   // T
];

const GCS_TIER_NAMES = ["P1", "G1", "P2", "C1", "C2", "C3", "C4", "C5", "C6", "T"];

// ---------------------------------------------------------------------------
// Tier-id generation, by the page's OWN function. This suite used to keep a documented
// duplicate of tierId/isGirdleTier/isTableTier (T-0152), because they were plain functions in
// the page's one classic script, with no module boundary to import through. The Svelte port
// made them an ES module (web/src/lib/tiers.js, no imports of its own), so the oracle now
// runs the very code the page runs: it fails the moment the page's rule and hex_cut_v2.gcs's
// own tier names disagree, with no copy to keep in step.
// ---------------------------------------------------------------------------

import { tierId } from "../../web/src/lib/tiers.js";

function tierIdLikeThePage(angle, counters) {
    return tierId({ angle }, counters);
}

// ---------------------------------------------------------------------------
// The oracle itself
// ---------------------------------------------------------------------------

/*
 * The load-bearing test for T-0148's whole acceptance criterion: read the real file,
 * derive mast angles the same way the page does (GemCadDesign.mastAngleOf on the raw
 * polar angle), run them through the page's own id-generation rule, and check the
 * result against the file's own <tier name="..."> attributes.
 *
 * G1's TRAP, worth calling out explicitly: the file's own polar angle for G1 is
 * 90.000000000001691, a hair ABOVE 90 (Gem Cut Studio's own floating-point residue).
 * mastAngleOf's branch is `polarAngle <= 90 ? polarAngle : polarAngle - 180`, so this
 * value takes the ELSE branch and comes back approximately -90, not +90 -- despite the
 * conceptual convention ("polar 90 is the girdle, mast +90") suggesting otherwise. It
 * does not matter: isGirdleTier checks abs(angle) against 90 BEFORE any sign test, so
 * G1 is still classified as the girdle either way. Asserted below, explicitly, so this
 * does not quietly flip into a "G1 is now C7" regression if mastAngleOf's branch is ever
 * "simplified" to `< 90` (which would swap which side of 90.0 exactly lands where, but
 * not fix anything, because both sides are indistinguishable to isGirdleTier anyway).
 */
Deno.test("tier ids generated from the .gcs's own polar angles match its own tier names", () => {
    const mastAngles = GCS_POLAR_ANGLES.map((polar) => GemCadDesign.mastAngleOf(polar));

    assertClose(mastAngles[1], -90, 1e-9,
        "G1's mast angle lands a hair below -90, not +90, because its polar angle is a " +
        "hair above 90 -- see this test's own doc comment");

    const counters = { crown: 0, pavilion: 0, girdle: 0 };
    const actualIds = mastAngles.map((angle) => tierIdLikeThePage(angle, counters));

    assertEquals(actualIds, GCS_TIER_NAMES,
        "tier ids generated from hex_cut_v2.gcs's own polar angles");
});

/*
 * The reader itself, end to end against the real file: gear, tier count, facet count,
 * and that every tier's angle (already converted mast, not the raw polar) matches what
 * GemCadDesign.mastAngleOf computes from the SAME polar angle read by hand above. This
 * is a wiring check -- did the reader read the right attribute, off the right element,
 * in the right order -- not a re-test of mastAngleOf's arithmetic, which design_test.js
 * already covers.
 */
Deno.test("reads gear, tier count, facet count and mast angles off the real file", async () => {
    const { parsed } = await readHexCutV2();

    assertEquals(parsed.metadata.gear, 96, "index gear");
    assertEquals(parsed.metadata.gearLocationAngle, 0, "index base (gear.originIndex)");
    assertEquals(parsed.metadata.symmetryFolds, 6, "index symmetry");
    assertEquals(parsed.metadata.symmetryMirror, false, "index mirror=\"0\"");
    assertEquals(parsed.tiers.length, 10, "tier count");

    const facetCount = parsed.tiers.reduce((total, tier) => total + tier.indices.length, 0);
    assertEquals(facetCount, 67, "facet count");

    for (let t = 0; t < parsed.tiers.length; t++) {
        const expected = GemCadDesign.mastAngleOf(GCS_POLAR_ANGLES[t]);
        assertEquals(parsed.tiers[t].angle, expected,
            `tier ${t} (${GCS_TIER_NAMES[t]}): mast angle`);
    }
});

/*
 * The design GemCadDesign.fromGemCad builds from the .gcs parse, exactly the object
 * shape a .asc/.gem produces (T-0148's acceptance criterion). Exercises the SAME gates
 * gemcad-sourced designs go through: index recovery from geometry, and the normal
 * agreement check. hex_cut_v2 is exactly the design kb/the-polar-internal-representation
 * .md's "meet-point solved facet" trap documents (C3, C4, C6 sit up to 1.29e-5 of a
 * tooth off), so this also proves the CURRENT (loosened) tolerances actually admit it,
 * not just that some tolerance exists.
 */
Deno.test("GemCadDesign.fromGemCad accepts the .gcs parse and recovers the right facet count", async () => {
    const { parsed } = await readHexCutV2();
    const design = GemCadDesign.fromGemCad(parsed, { name: "hex_cut_v2" });

    assertEquals(design.gear.teeth, 96, "gear teeth");
    assertEquals(design.gear.reversed, false, "gear.reversed");
    assertEquals(design.tiers.length, 10, "tier count");
    assertEquals(GemCadDesign.facetCount(design), 67, "facet count");

    // cuttingInstructions survive unchanged: three tiers with distinctive text, read by
    // hand off the file (tiers in file order: P1 G1 P2 C1 C2 C3 C4 C5 C6 T, indices 0-9).
    assertEquals(design.tiers[4].cuttingInstructions, "Meet G1, C1", "C2's instructions");
    assertEquals(design.tiers[5].cuttingInstructions, "Meet G1, C1, C2", "C3's instructions");
    assertEquals(design.tiers[8].cuttingInstructions, "Float to establish hexagons.", "C6's instructions");

    // The worst recovery residues are the ones kb/the-polar-internal-representation.md
    // measured for this exact file (well under the current 1e-3 tooth / 1e-2 degree
    // gates, but well above the old, too-tight ones this design used to be refused by).
    assert(design.provenance.worstIndexSnap > 1e-6,
        "hex_cut_v2 has meet-point solved tiers; a snap this small would mean the fixture " +
        "or the reader stopped exercising them");
    assert(design.provenance.worstIndexSnap < 1e-3, "still within the current gate");
});

/*
 * The mesh: written straight from each facet's own ordered <vertex> corners, via the
 * SAME writer a .asc/.gem design uses (GemCadObj.toObjText), never by intersecting
 * planes. This does not pin exact vertex/triangle counts (T-0149 measures and reports
 * those against resources/hex_cut_v2.obj in its own close note) -- it proves the writer
 * accepts the parse and produces a closed, non-empty mesh at all.
 */
Deno.test("GemCadObj.toObjText writes a mesh straight from the .gcs's own facet corners", async () => {
    const { parsed } = await readHexCutV2();
    const objText = GemCadObj.toObjText(parsed, { name: "hex_cut_v2" });

    const vertexLines = objText.split("\n").filter((line) => line.startsWith("v "));
    const faceLines = objText.split("\n").filter((line) => line.startsWith("f "));

    assert(vertexLines.length > 0, "the OBJ must have vertices");
    assertEquals(faceLines.length, 67, "one OBJ face per .gcs facet (no plane intersection, no re-triangulation)");
});

/*
 * <info>'s three attributes feed the cutting-instructions pane's header (T-0145/T-0148):
 * cut name, author, date. Read by hand off the file's own <info> element.
 */
Deno.test("reads title, author and date from <info>", async () => {
    const { info } = await readHexCutV2();

    assertEquals(info.title, "hex cut v2 (arya)", "info/@title");
    assertEquals(info.author, "0xDECAFC0FFEE", "info/@author");
    assertEquals(info.date, "August 2024", "info/@date");
});

/*
 * <render> must never be read: applying its refractive index, dispersion, colour or
 * lighting model would silently override the material the user has chosen (T-0148's
 * ticket description, and see gcs.js's own header comment). The parsed metadata's
 * refractiveIndex must therefore stay at gemcad.js's own GemCadFileMetadata default (0),
 * never the file's 2.1600001 -- proving this by checking the number rather than just
 * "the reader doesn't mention <render>" catches a regression where someone innocently
 * wires the attribute up later.
 */
Deno.test("never reads <render>, even though the file has one", async () => {
    const text = await Deno.readTextFile(MODEL_URL);
    assert(text.includes("refractive_index=\"2.1600001\""),
        "fixture check: the file really does carry a <render> the reader must ignore");

    const { parsed } = await readHexCutV2();
    assertEquals(parsed.metadata.refractiveIndex, 0,
        "the render block's refractive index must not leak into the parsed design");
});

// ---------------------------------------------------------------------------
// The index_angle cross-check (T-0148's own acceptance criterion)
// ---------------------------------------------------------------------------

/*
 * SETUP. Take the real file's text and rotate one facet's stored normal (nx, ny) about
 * the optical axis by half a tooth (1.875 degrees at gear 96) -- the same "half a tooth
 * off" fixture design_test.js's own rejection test uses, adapted to XML text rather than
 * a parsed object, because gcs.js's cross-check runs during parsing, before there is a
 * parsed object to mutate.
 *
 * WHAT IT VERIFIES. importText refuses the file: the facet's index_angle attribute
 * (untouched) now disagrees with the tooth its rotated normal recovers by half a tooth,
 * comfortably past design.js's INDEX_SNAP_TOLERANCE (1e-3 of a tooth). This is the
 * cross-check T-0148 asks for, working the way it is meant to: an index_angle a real
 * .gcs file could not actually produce (Gem Cut Studio's own solver only ever leaves a
 * facet a few 1e-5 of a tooth off, never half a tooth) is caught here rather than
 * quietly accepted.
 */
Deno.test("a facet whose index_angle disagrees with its own normal is refused", async () => {
    const text = await Deno.readTextFile(MODEL_URL);

    // C1's first facet (tier 4, list order 0), copied verbatim from the file (line 136).
    // `nx`/`ny` are parsed as numbers to compute the rotation, but the ORIGINAL string
    // below is the file's own text, not a re-serialisation of those numbers -- JS's
    // shortest-round-trip Number-to-string does not reproduce the file's own longer
    // decimal spelling (e.g. -0.81982910648694 instead of -0.81982910648693996, the same
    // double, spelled differently), so rebuilding the "original" text from the numbers
    // would not actually match the file and this fixture check would always fail.
    const original = 'nx="-1.3301381911377466e-14" ny="-0.81982910648693996" ' +
        'nz="0.57260827461435226" index_angle="359.99999999999909"';

    assert(text.includes(original), "fixture check: the facet text this test mutates must exist as expected");

    // Rotate (nx, ny) by half a tooth (1.875 degrees) about the optical axis; nz is
    // untouched, so the facet stays off-axis and the cross-check still runs. The mutated
    // attribute text need not match the file's own spelling convention -- it only has to
    // parse back to the rotated value, which Number() does regardless of style.
    const half = 1.875 * Math.PI / 180;
    const nx = -1.3301381911377466e-14;
    const ny = -0.81982910648693996;
    const rotatedNx = nx * Math.cos(half) - ny * Math.sin(half);
    const rotatedNy = nx * Math.sin(half) + ny * Math.cos(half);

    const mutated = `nx="${rotatedNx}" ny="${rotatedNy}" nz="0.57260827461435226" index_angle="359.99999999999909"`;

    const mutatedText = text.replace(original, mutated);

    assertThrows(() => GemCutStudio.importText(mutatedText),
        "disagrees with the tooth",
        "a facet half a tooth off its own index_angle must be refused");
});

/*
 * The other half of the same claim, proven positively rather than by absence of a
 * throw: the real file's own meet-point solved facets (C3, C4, C6; see
 * kb/the-polar-internal-representation.md) sit up to 1.29e-5 of a tooth off and MUST be
 * accepted, because that residue is Gem Cut Studio's own solver, not a corrupt file.
 * Already exercised by every other test that parses the real file without throwing;
 * this one says so explicitly, so a future tightening of the tolerance fails here with
 * a clear name rather than as a mysterious break in an unrelated test.
 */
Deno.test("the real file's meet-point solved facets (C3, C4, C6) parse without throwing", async () => {
    const { parsed } = await readHexCutV2();
    // Reaching this line at all is the assertion: importText's cross-check ran against
    // every one of the 67 facets, including C3/C4/C6's solved ones, while parsing.
    assertEquals(parsed.tiers.length, 10, "the parse completed");
});

/*
 * SETUP. A girdle is conceptually always at polar angle exactly 90, but `toothFromIndexAngle`
 * (gcs.js) used to decide which mirror formula applies with a bare `polarAngle >= 90` --
 * and Gem Cut Studio's own files do not always write a girdle's angle a hair OVER 90 the
 * way `resources/hex_cut_v2.gcs`'s G1 does (90.000000000001691, already covered by the "hair
 * ABOVE 90" test above). Two real files from the wiki corpus
 * (reference/gemology-project-designs/NQR_Round.gcs and Round_Cushion.gcs -- not shipped
 * in this tree, so not usable as a fixture here) write G1 a hair UNDER 90 instead
 * (89.999999999999986 / 89.999999999999929), which used to fail the bare `>= 90` test,
 * misclassify the tier as crown, and throw "disagrees ... by 16.000000 of a tooth" on
 * every off-axis G1 facet with index_angle 30 (measured: 2 * 30 degrees = 60 degrees =
 * 16 teeth at this gear, exactly the observed error). This fixture reproduces that shape
 * from scratch, independent of the corpus, at gear 96 (stepAngle 3.75) with G1 written a
 * hair under 90 (89.99999999, ordinary floating-point noise, not a real 90) and a single
 * off-axis facet at index_angle 30.
 *
 * The facet's normal is chosen to be the tooth the CORRECT (pavilion/girdle) formula
 * predicts: azimuth = 180 + 30 = 210 degrees, i.e. (sin 210, cos 210, 0) = (-0.5,
 * -sqrt(3)/2, 0) in design.js's own (+Y-to-+X, z=cos(polar)=0 at the girdle) convention --
 * so a correct classification finds tooth 56 both ways (agreement, no throw), while the
 * pre-fix crown formula (azimuth = 180 - 30 = 150) recovers tooth 40 instead, an
 * intentional mismatch that would throw were the bug still present.
 *
 * WHAT IT VERIFIES. The tier is classified as pavilion/girdle (not crown) even though its
 * raw polar angle sits a hair under 90, so the facet's index_angle and its own normal
 * agree and the file parses cleanly -- the exact case that used to throw for NQR_Round.gcs
 * and Round_Cushion.gcs.
 */
Deno.test("a girdle tier written a hair under 90 (not over, like hex_cut_v2's) still parses", () => {
    const gcsText = `<GemCutStudio version="1000">
<index gear="96" base="0" symmetry="1" mirror="0"/>
<tier angle="89.99999999" depth="1" name="G1" instructions="Set Size" visible="true" guide="false">
<facet nx="-0.5" ny="-0.8660254037844387" nz="0" index_angle="30">
<vertex x="0" y="0" z="0"/>
<vertex x="1" y="0" z="0"/>
<vertex x="0" y="1" z="0"/>
</facet>
</tier>
</GemCutStudio>`;

    const { parsed } = GemCutStudio.importText(gcsText);

    assertEquals(parsed.tiers.length, 1, "the parse completed instead of throwing");
    assertEquals(parsed.tiers[0].indices.length, 1, "the one facet was read");
});

// ---------------------------------------------------------------------------
// The page's inlining constraints
// ---------------------------------------------------------------------------

/*
 * Setup: gcs.js's own source text, and the four rules make_page.py enforces on anything
 * that ends up in the file:// page. Verifies: no ES import/export (the page is a classic
 * script), no `fetch(` (a file:// page has a null origin and every fetch is refused), and
 * nothing that could close or comment out the <script> element it is inlined into.
 * gemcad_test.js and gemcad_obj_test.js make the same assertion about their own modules;
 * the point of repeating it here is that a failure is otherwise only visible as a build
 * error much later, in make_page.py, once gcs.js is added to GEMCAD_SCRIPTS.
 */
Deno.test("gcs.js satisfies make_page.py's inlining constraints", async () => {
    const source = await Deno.readTextFile(GCS_READER_URL);

    assert(!/^\s*import[\s{(]/m.test(source), "an ES import cannot load from file://");
    assert(!/^\s*export[\s{]/m.test(source), "an ES export would make this a module");
    assert(!source.includes("fetch("), "a file:// page cannot fetch anything");
    assert(!/<\/script|<!--/i.test(source), "this text has to survive being inlined in a script");
});

/*
 * Setup: the same publication contract gemcad_test.js checks for gemcad.js -- a classic
 * script run directly (not imported) publishes exactly one new global.
 * Verifies: after loading gcs.js the way make_page.py's bundle will, `GemCutStudio` (and
 * only it) exists with the shape `importText` above depends on.
 */
Deno.test("the library loads as a classic script and publishes globalThis.GemCutStudio", () => {
    assert(typeof GemCutStudio === "object" && GemCutStudio !== null, "GemCutStudio must exist");
    assert(typeof GemCutStudio.importText === "function", "GemCutStudio.importText must exist");
});
