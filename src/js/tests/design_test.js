/*
 * design_test.js -- tests for www/js/design.js, the polar internal
 * representation of a faceted stone.
 *
 * HOW TO RUN
 *   deno test --allow-read www/js/tests/
 *
 * Node on this machine is broken (18.6.0, missing libicui18n.70.dylib), so Deno
 * is the runtime here as in the sibling suites. No third-party dependencies.
 *
 * WHAT THIS SUITE IS FOR
 *   The representation stores three numbers per facet -- mast angle, index
 *   position, cut depth -- and derives the Cartesian plane from them. Every
 *   claim that matters therefore reduces to one question: does the polar
 *   description rebuild the geometry that was in the file?
 *
 *   That question is worth asking hard, because the failure mode is silent. A
 *   wrong index does not crash and does not produce an obviously broken shape;
 *   it produces a *mirrored* stone, which looks entirely plausible. The tests
 *   below check each facet's polar values against that facet's own stored
 *   normal, which is the only comparison that catches it -- comparing index
 *   *sets* per tier does not, because the usual index lists are symmetric under
 *   i -> teeth - i.
 *
 *   `rebuilds_every_facet_normal_from_polar_values` is the load-bearing test.
 *   `recovers_indices_that_the_binary_reader_gets_wrong` documents the upstream
 *   defect this representation has to route around, and would fail if someone
 *   "simplified" fromGemCad into trusting the parser's index numbers.
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
// Loading the libraries
//
// Neither has an `export`: make_page.py refuses to inline a template containing
// an ES module statement, so both are classic scripts, loaded the way the page
// loads them. `(0, eval)` forces indirect eval, which evaluates in global scope.
// ---------------------------------------------------------------------------

const READER_URL = new URL("../gemcad.js", import.meta.url);
const DESIGN_URL = new URL("../design.js", import.meta.url);
const SAMPLES_URL = new URL("../../../reference/gemcad-file-reader/Samples/", import.meta.url);
const CORPUS_URL = new URL("../../../reference/gemology-project-designs/", import.meta.url);

const DESIGNS = ["Compear125", "CubeIllusionTri", "SRB", "Turkey"];

// ---------------------------------------------------------------------------
// WHY SOME TESTS BELOW ARE SKIPPED RATHER THAN RUN
//
// Everything under reference/ is third-party data -- the vendored GemCad sample
// files, and the gemology-project competition corpus -- several hundred
// megabytes of it, deliberately gitignored, so a fresh clone of this repository
// has none of it. The suite still has to be green there, so every test that
// reads a real file from reference/ is marked `{ ignore: !SAMPLES_PRESENT }`
// (or `!CORPUS_PRESENT`) and reports as ignored when the data is absent instead
// of erroring on a missing file. With the data present nothing changes: all of
// them run exactly as before. The tests built from hand-made designs are never
// gated, because they need nothing that is not checked in.
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
const CORPUS_PRESENT = present(CORPUS_URL);

(0, eval)(await Deno.readTextFile(READER_URL));
(0, eval)(await Deno.readTextFile(DESIGN_URL));

const GemCad = globalThis.GemCad;
const GemCadDesign = globalThis.GemCadDesign;

/** Reads and parses a sample, e.g. sample("SRB", "asc"). */
async function sample(name, extension) {
    const bytes = await Deno.readFile(new URL(name + "." + extension, SAMPLES_URL));

    return GemCad.importBytes(bytes);
}

/** The angle, in degrees, between two directions of any length. */
function angleBetween(a, b) {
    const la = Math.hypot(a.x, a.y, a.z);
    const lb = Math.hypot(b.x, b.y, b.z);
    const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);

    return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}

// ---------------------------------------------------------------------------
// The angle convention
// ---------------------------------------------------------------------------

/*
 * GemCad's signed mast angle folds two facts into one number: the tilt, and
 * whether the facet faces up or down. This checks the mapping onto an ordinary
 * polar angle measured from the optical axis, at the four cases that have
 * names: table, crown, girdle and pavilion.
 */
Deno.test("mast angles map onto polar angles from the optical axis", () => {
    const { polarAngleOf, mastAngleOf } = GemCadDesign;

    assertEquals(polarAngleOf(0), 0, "a table facet points straight up the axis");
    assertEquals(polarAngleOf(41.36), 41.36, "a crown facet tilts from the axis by its mast angle");
    assertEquals(polarAngleOf(90), 90, "a +90 girdle facet is perpendicular to the axis");
    assertEquals(polarAngleOf(-90), 90, "and so is a -90 one: the same plane");
    assertClose(polarAngleOf(-42.5), 137.5, 1e-12, "a pavilion facet tilts past the equator");

    // The inverse picks the crown branch where the two meet, which is why a
    // -90 tier does not survive this round trip. Nothing geometric depends on
    // that sign; the authored value is preserved separately so a design
    // re-exports as it was written.
    assertClose(mastAngleOf(137.5), -42.5, 1e-12, "pavilion branch inverts");
    assertEquals(mastAngleOf(41.36), 41.36, "crown branch inverts");
    assertEquals(mastAngleOf(90), 90, "90 resolves to the crown branch");

    // T-0170: the OTHER pole. Polar angle 180 is straight down the axis (a
    // culet, or an on-axis pavilion facet) -- and the naive formula
    // (polarAngle - 180) would give 0, the SAME value mastAngleOf(0) gives
    // for the table's own pole. -90 cannot be the sentinel here, because it
    // is already the real mast angle of a genuine off-axis girdle facet
    // (measured thousands of times in the real corpus), so mastAngleOf uses
    // 180 itself as the disambiguated, otherwise-unreachable marker.
    assertEquals(mastAngleOf(180), 180, "the pavilion pole must not collide with the table's 0");
    assertEquals(polarAngleOf(180), 180, "and normalOf must round-trip that marker back to +Z's opposite pole");
});

// ---------------------------------------------------------------------------
// The load-bearing test
// ---------------------------------------------------------------------------

/*
 * For every facet of every sample, in both file formats, rebuild the outward
 * normal from the three polar numbers and compare it against the normal the
 * file actually carries.
 *
 * This is the whole representation in one assertion: if polar values cannot
 * reproduce the geometry, nothing built on them is trustworthy.
 *
 * The tolerance is 1e-3 degrees against a measured worst case of 1.2e-6. Do not
 * read that worst case as a real disagreement: acos is ill-conditioned near 1,
 * so a dot product one ulp short of 1.0 reports as 1.207e-6 degrees. It is the
 * floor of this comparison, and tightening the tolerance past it would only
 * test floating-point arithmetic.
 */
Deno.test("rebuilds every facet normal from polar values", { ignore: !SAMPLES_PRESENT }, async () => {
    let checked = 0;
    let worst = 0;
    let worstWhere = "";

    for (const name of DESIGNS) {
        for (const extension of ["asc", "gem"]) {
            const parsed = await sample(name, extension);
            const design = GemCadDesign.fromGemCad(parsed, { name });

            for (let t = 0; t < design.tiers.length; t++) {
                const tier = design.tiers[t];
                const stored = parsed.tiers[t].indices;

                for (let f = 0; f < tier.facets.length; f++) {
                    const normal = GemCadDesign.normalOf(design, tier.angle, tier.facets[f].index);
                    const error = angleBetween(normal, stored[f].facetNormal);

                    checked++;

                    if (error > worst) {
                        worst = error;
                        worstWhere = `${name}.${extension} tier ${t} facet ${f}`;
                    }
                }
            }
        }
    }

    assert(checked >= 500, `expected the whole sample set, checked only ${checked} facets`);
    assert(worst < 1e-3, `worst normal error ${worst.toExponential(3)} deg at ${worstWhere}`);
});

/*
 * A facet's plane must also pass through that facet's corners. The previous
 * test pins the plane's *direction*; this one pins its *position*, using the
 * corner points the reader reconstructed by cutting a cube -- an entirely
 * separate computation from the normal.
 *
 * `planesOf` promises that a point p is on the facet when dot(normal, p) equals
 * offset, so that is asserted directly on real corners.
 */
Deno.test("facet corners lie on the plane the polar values describe", { ignore: !SAMPLES_PRESENT }, async () => {
    let worst = 0;

    for (const name of DESIGNS) {
        for (const extension of ["asc", "gem"]) {
            const parsed = await sample(name, extension);
            const design = GemCadDesign.fromGemCad(parsed, { name });
            const planes = GemCadDesign.planesOf(design);

            let p = 0;

            for (let t = 0; t < parsed.tiers.length; t++) {
                for (let f = 0; f < parsed.tiers[t].indices.length; f++) {
                    const plane = planes[p++];
                    const length = Math.hypot(plane.normal.x, plane.normal.y, plane.normal.z);

                    assertClose(length, 1, 1e-12, "plane normals must be unit vectors");

                    for (const corner of parsed.tiers[t].indices[f].points) {
                        const distance = plane.normal.x * corner.x +
                            plane.normal.y * corner.y +
                            plane.normal.z * corner.z;

                        worst = Math.max(worst, Math.abs(distance - plane.offset));
                    }
                }
            }
        }
    }

    // Measured worst across the sample set is about 4e-10; GemCad's own stored
    // rounding in the .gem files is the floor here.
    assert(worst < 1e-6, `a corner sat ${worst.toExponential(3)} off its own facet plane`);
});

// ---------------------------------------------------------------------------
// The upstream defect this representation routes around
// ---------------------------------------------------------------------------

/*
 * `fromGemCad` recovers each index from that facet's stored normal rather than
 * copying the number the reader produced. Those are two independent routes to
 * the same answer, so this test is a genuine cross-check on the reader's index
 * arithmetic -- which is worth having, because that arithmetic was wrong until
 * T-0088.
 *
 * The history: the binary reader assumed a positive gear, so on a negative one
 * (`g -96`, meaning the wheel runs backwards) it reflected the index wheel and
 * reported tooth i as `teeth - i`. Turkey.gem was wrong on 71 of 74 facets and
 * CubeIllusionTri.gem on all 51, by up to 165 degrees. The reader has since
 * been fixed, deliberately diverging from the C# it was ported from.
 *
 * Both routes are checked here against the geometry, so this fails whether a
 * regression lands in the reader or in this module.
 */
Deno.test("reader and geometry agree on every index, on reversed gears too", { ignore: !SAMPLES_PRESENT }, async () => {
    for (const name of ["Turkey", "CubeIllusionTri"]) {
        const parsed = await sample(name, "gem");
        const design = GemCadDesign.fromGemCad(parsed, { name });

        assert(parsed.metadata.gear < 0, `${name}.gem should have a negative gear`);

        let readerWrong = 0;
        let recoveredWrong = 0;
        let total = 0;

        for (let t = 0; t < design.tiers.length; t++) {
            const tier = design.tiers[t];

            for (let f = 0; f < tier.facets.length; f++) {
                const stored = parsed.tiers[t].indices[f];

                // Each route's index turned back into a normal, and compared
                // with the normal the file actually carries.
                const fromReader = GemCadDesign.normalOf(design, tier.angle, stored.index);
                const fromDesign = GemCadDesign.normalOf(design, tier.angle, tier.facets[f].index);

                if (angleBetween(fromReader, stored.facetNormal) > 1e-3) {
                    readerWrong++;
                }
                if (angleBetween(fromDesign, stored.facetNormal) > 1e-3) {
                    recoveredWrong++;
                }

                total++;
            }
        }

        assertEquals(readerWrong, 0,
            `${name}.gem: every index the reader reports must reproduce its own facet normal ` +
            `(${readerWrong} of ${total} did not)`);
        assertEquals(recoveredWrong, 0,
            `${name}.gem: every recovered index must reproduce its own facet normal`);
    }
});

/*
 * Because indices are recovered from geometry rather than copied, the two file
 * formats of one design now produce the same representation. Before this, the
 * negative-gear designs disagreed per facet.
 *
 * Headers, facet names and cutting instructions are deliberately excluded: the
 * binary format packs and abbreviates its text differently, which is a property
 * of the container, not of the stone.
 */
Deno.test("the two file formats of a design produce the same representation", { ignore: !SAMPLES_PRESENT }, async () => {
    for (const name of DESIGNS) {
        const fromAsc = GemCadDesign.fromGemCad(await sample(name, "asc"), { name });
        const fromGem = GemCadDesign.fromGemCad(await sample(name, "gem"), { name });

        assertEquals(fromAsc.gear, fromGem.gear, `${name}: gear`);
        assertEquals(fromAsc.symmetry, fromGem.symmetry, `${name}: symmetry`);
        assertClose(fromAsc.refractiveIndex, fromGem.refractiveIndex, 1e-12, `${name}: RI`);
        assertEquals(fromAsc.tiers.length, fromGem.tiers.length, `${name}: tier count`);

        for (let t = 0; t < fromAsc.tiers.length; t++) {
            const a = fromAsc.tiers[t];
            const g = fromGem.tiers[t];

            assertClose(a.angle, g.angle, 1e-12, `${name} tier ${t}: mast angle`);
            // The binary format stores geometry and back-computes the depth, so
            // it lands a few parts in 1e9 away from the text's stated value.
            assertClose(a.distance, g.distance, 1e-7, `${name} tier ${t}: cut depth`);
            assertEquals(a.facets.map((f) => f.index), g.facets.map((f) => f.index),
                `${name} tier ${t}: index positions`);
        }
    }
});

// ---------------------------------------------------------------------------
// Degeneracies
// ---------------------------------------------------------------------------

/*
 * A facet on the optical axis -- a table, or a culet -- has no azimuth: every
 * index position describes the same plane. This is the same degeneracy that
 * makes the derivative of the normal with respect to index vanish there, and
 * the reason a constraint solver needs a separate chart at the pole.
 *
 * SRB's last tier is its table: `a 0.000000 0.36450932 96 n T`.
 */
Deno.test("a facet on the optical axis reports no meaningful index", { ignore: !SAMPLES_PRESENT }, async () => {
    const parsed = await sample("SRB", "asc");
    const design = GemCadDesign.fromGemCad(parsed, { name: "SRB" });
    const table = design.tiers[design.tiers.length - 1];

    assertEquals(table.angle, 0, "SRB's last tier is the table");
    assertEquals(table.facets.length, 1, "a table is one facet");

    // Straight up the axis, whatever index it is nominally cut at.
    const normal = GemCadDesign.normalOf(design, table.angle, table.facets[0].index);

    assertClose(normal.x, 0, 1e-12, "no x component");
    assertClose(normal.y, 0, 1e-12, "no y component");
    assertClose(normal.z, 1, 1e-12, "points along +Z");

    // And the inverse says so, rather than inventing an azimuth from noise.
    const polar = GemCadDesign.polarOf(design, { x: 0, y: 0, z: 1 });

    assertEquals(polar.onAxis, true, "the pole must be reported as degenerate");
    assertEquals(polar.index, 0, "index 0 is the canonical choice at the pole");
});

/*
 * T-0170: THE OTHER ON-AXIS POLE COLLIDES WITH A REAL GIRDLE ANGLE.
 *
 * SETUP. gemcad.js's binary reader (`calculateTierDefinitions`, a faithful
 * port of GemCad's own convention) writes mast angle -90 for a facet that
 * points straight down the optical axis (a large or flat culet, or any other
 * on-axis pavilion facet) -- not because that facet is tilted 90 degrees
 * from anything, but as an on-axis sentinel, exactly the way index 0 is a
 * sentinel there rather than a real azimuth. The trouble: -90 is ALSO the
 * real mast angle of a genuine OFF-axis girdle facet (measured 4904 times
 * across reference/gemology-project-designs while diagnosing this), and
 * `normalOf`'s general formula only knows that second meaning, so it rebuilds
 * a horizontal girdle plane from a stored normal that actually points
 * straight down -- 90 degrees away from the geometry in the file. Built here
 * as a minimal synthetic single-facet tier, mirroring exactly the shape
 * gemcad.js hands `fromGemCad` for the real files that hit this (Witt96.gem,
 * Kyle's_Tablet.gem, Hanabi.gem, Star_of_david_43-45-47.gem,
 * Thank_you_Bernd.gem and Fiorino_80.gem, each with one such facet), rather
 * than copying one of those files into the repo as a fixture.
 *
 * THE TEST. Build a `parsed` design by hand whose sole facet's stored normal
 * is exactly (0, 0, -1) (straight down) and whose tier angle is written -90,
 * the same value calculateTierDefinitions uses for this case, then derive a
 * design from it.
 *
 * WHAT IT VERIFIES. Before the fix this threw "rebuilds a normal 90.000000
 * degrees away from the geometry in the file". After it: the design is
 * accepted; the tier's stored angle is corrected to 180 (this
 * representation's own disambiguated marker, not GemCad's -90, and not the
 * table's 0 either -- see mastAngleOf); and normalOf, fed that corrected
 * angle back, reproduces the original straight-down normal.
 */
Deno.test("an on-axis facet pointing straight down is not mistaken for a girdle facet", () => {
    const design = { gear: { teeth: 96, reversed: false, originIndex: 0 } };

    const parsed = {
        metadata: {
            gear: 96, gearLocationAngle: 0, refractiveIndex: 0,
            symmetryFolds: 1, symmetryMirror: false, headers: [], footnotes: [],
        },
        tiers: [{
            isPreform: false, number: 0, angle: -90, distance: 0.5,
            cuttingInstructions: "", indices: [{
                tier: 0, name: "culet", index: 0,
                // Straight down the axis, scaled the way the reader's own
                // facetNormal is (plane point plus three units along the
                // outward normal) -- only the direction matters.
                facetNormal: { x: 0, y: 0, z: -3 },
                points: [], renderingTriangles: [],
            }],
        }],
    };

    const built = GemCadDesign.fromGemCad(parsed, { name: "on-axis-down" });

    assertEquals(built.tiers.length, 1, "one tier in, one tier out");
    assertEquals(built.tiers[0].facets[0].index, 0, "on-axis facets canonicalise to index 0");
    assertEquals(built.tiers[0].angle, 180,
        "the tier's angle must be corrected from GemCad's -90 sentinel, not kept as-is");

    const rebuilt = GemCadDesign.normalOf(design, built.tiers[0].angle, built.tiers[0].facets[0].index);

    assertClose(rebuilt.x, 0, 1e-12, "no x component");
    assertClose(rebuilt.y, 0, 1e-12, "no y component");
    assertClose(rebuilt.z, -1, 1e-12, "points along -Z, matching the file's own geometry");
});

/*
 * T-0170, confirmed against a real design rather than only the synthetic case
 * above. Kyle's_Tablet.gem is a flat tablet cut: a crown table ("T(C)", mast
 * angle 0) and a pavilion table ("T(P)", mast angle -90 in the file, but
 * geometrically the same plane shape as the crown table, just facing -Z) at
 * the same distance from the centre. Before the fix, opening this file threw
 * at "T(P)" and the page showed no cutting instructions at all despite
 * rendering the stone fine from its stored corners (the fallback).
 */
Deno.test("Kyle's_Tablet.gem: the pavilion table no longer fails the normal-agreement gate", { ignore: !CORPUS_PRESENT }, async () => {
    const url = new URL("../../../reference/gemology-project-designs/Kyle's_Tablet.gem",
        import.meta.url);
    const parsed = GemCad.importBytes(await Deno.readFile(url));
    const design = GemCadDesign.fromGemCad(parsed, { name: "Kyle's_Tablet" });

    assertEquals(design.gear.teeth, 96);

    // Every facet, including both on-axis tables, rebuilds the geometry the
    // file actually stores -- the load-bearing check, run over a real file.
    for (const [t, tier] of design.tiers.entries()) {
        for (const [f, facet] of tier.facets.entries()) {
            const stored = parsed.tiers[t].indices[f].facetNormal;
            const rebuilt = GemCadDesign.normalOf(design, tier.angle, facet.index);

            assert(angleBetween(rebuilt, stored) < GemCadDesign.tolerances.normalAgreement,
                `tier ${t} facet ${f} (${parsed.tiers[t].indices[f].name || "unnamed"}) rebuilds its normal`);
        }
    }

    const pavilionTable = design.tiers.find((tier, t) =>
        parsed.tiers[t].indices[0] && parsed.tiers[t].indices[0].name === "T(P)");

    assert(pavilionTable !== undefined, "expected to find the pavilion table tier by name");
    assertEquals(pavilionTable.angle, 180,
        "the pavilion table's angle is corrected from the file's -90 sentinel");
});

/*
 * A negative gear means the wheel runs the other way. Storing a magnitude plus
 * a flag keeps that explicit; this checks the sign really does reach the
 * arithmetic, rather than being recorded and then ignored.
 */
Deno.test("a reversed gear reverses the direction of the index wheel", { ignore: !SAMPLES_PRESENT }, async () => {
    const forward = GemCadDesign.fromGemCad(await sample("SRB", "asc"), { name: "SRB" });
    const reversed = GemCadDesign.fromGemCad(await sample("Turkey", "asc"), { name: "Turkey" });

    assertEquals(forward.gear.reversed, false, "SRB declares g 96");
    assertEquals(reversed.gear.reversed, true, "Turkey declares g -96");
    assertEquals(forward.gear.teeth, 96, "the tooth count is stored as a magnitude");
    assertEquals(reversed.gear.teeth, 96, "even when the file wrote it negative");

    assertClose(GemCadDesign.stepAngle(forward), 3.75, 1e-12, "forward wheel steps +3.75");
    assertClose(GemCadDesign.stepAngle(reversed), -3.75, 1e-12, "reversed wheel steps -3.75");
});

/*
 * FRACTIONAL TEETH (T-0171): THE 0.005-TOOTH SNAP BOUNDARY.
 *
 * The user's rule (2026-09-18, "when reading a file if the fraction is <
 * .005 can you snap them"): a facet recovered within 0.005 of a TOOTH (not a
 * degree) snaps to it -- genuine noise, from a meet-point solver's nudge or
 * from this representation's own re-expression arithmetic (see
 * reExpressOnGear, below). Anything further off is kept exactly as a
 * fractional index, and the design's fractional-teeth option
 * (`design.gear.fractional`) is turned on to describe it. Unlike before
 * T-0171, an off-tooth facet is never refused: it used to be (a quarter tooth
 * was this suite's own rejection case), and the user's explicit instruction
 * was that it should become fractional instead.
 *
 * These two tests replace that old rejection test, one on each side of the
 * boundary, both derived from the SAME setup (SRB, 96 teeth, 3.75 degrees a
 * tooth, one facet's normal turned about the axis by a small fraction of a
 * tooth) so the only variable between them is which side of 0.005 the
 * injected offset falls on.
 */
Deno.test("a facet 0.004 of a tooth off snaps to the tooth it is closest to", { ignore: !SAMPLES_PRESENT }, async () => {
    const parsed = await sample("SRB", "asc");
    const reference = GemCadDesign.fromGemCad(await sample("SRB", "asc"), { name: "SRB" });

    const FRACTION = 0.004; // inside the 0.005 snap tolerance
    const turn = FRACTION * 3.75 * Math.PI / 180;
    const facet = parsed.tiers[1].indices[0];
    const { x, y } = facet.facetNormal;

    facet.facetNormal = {
        x: x * Math.cos(turn) - y * Math.sin(turn),
        y: x * Math.sin(turn) + y * Math.cos(turn),
        z: facet.facetNormal.z
    };

    const design = GemCadDesign.fromGemCad(parsed, { name: "SRB" });
    const index = design.tiers[1].facets[0].index;

    assert(Number.isInteger(index), `expected a snapped, whole-tooth index, got ${index}`);
    assertEquals(index, reference.tiers[1].facets[0].index,
        "0.004 of a tooth is inside the snap tolerance, so the facet stays on its original tooth");
    assertEquals(design.gear.fractional, false,
        "nothing in this design needed a fractional index");
    assertClose(design.provenance.worstIndexSnap, FRACTION, 1e-8,
        "the reported snap is the injected offset, so the gate was genuinely exercised");
});

Deno.test("a facet 0.006 of a tooth off is kept fractional, not snapped or refused", { ignore: !SAMPLES_PRESENT }, async () => {
    const parsed = await sample("SRB", "asc");
    const reference = GemCadDesign.fromGemCad(await sample("SRB", "asc"), { name: "SRB" });

    const FRACTION = 0.006; // outside the 0.005 snap tolerance
    const turn = FRACTION * 3.75 * Math.PI / 180;
    const facet = parsed.tiers[1].indices[0];
    const { x, y } = facet.facetNormal;

    facet.facetNormal = {
        x: x * Math.cos(turn) - y * Math.sin(turn),
        y: x * Math.sin(turn) + y * Math.cos(turn),
        z: facet.facetNormal.z
    };

    const design = GemCadDesign.fromGemCad(parsed, { name: "SRB" });
    const index = design.tiers[1].facets[0].index;
    const teeth = design.gear.teeth;
    const moved = Math.abs(index - reference.tiers[1].facets[0].index);

    assert(!Number.isInteger(index), `expected a fractional index, got ${index}`);
    assertClose(Math.min(moved, teeth - moved), FRACTION, 1e-8,
        "the index sits the injected fraction away from its nearest tooth, not snapped to it");
    assertEquals(design.gear.fractional, true,
        "a design with a fractional facet must turn its own opt-in flag on");

    // Kept, not refused, because it still describes the geometry: the fractional index
    // reproduces the turned normal exactly as well as a whole-tooth one would.
    const rebuilt = GemCadDesign.normalOf(design, design.tiers[1].angle, index);

    assert(angleBetween(rebuilt, facet.facetNormal) < GemCadDesign.tolerances.normalAgreement,
        "the fractional index rebuilds the turned normal");
});

/*
 * A facet exactly halfway between two teeth is a fractional index like any
 * other now -- there is no special half-tooth snapping any more (HALF_TOOTH
 * removed 2026-09-18, the user's explicit instruction: "dont snap to half
 * facets"). This is the same setup the half-tooth mechanism used to be tested
 * with; only the assertions changed, from "snapped to a half-tooth position"
 * to "kept fractional, needing the opt-in".
 *
 * SETUP. SRB with one facet's normal turned about the axis by exactly half a
 * tooth, 1.875 degrees, which moves it from its tooth to the position halfway
 * to the next (or previous: the wheel direction decides which).
 *
 * WHAT IT VERIFIES. The design is accepted; the facet's index is half a tooth
 * from the reference design's, kept exactly as recovered rather than forced
 * onto a special 0.5 value; `design.gear.fractional` is on; and the rebuilt
 * normal matches the turned one.
 */
Deno.test("a facet halfway between two teeth is a fractional index, not refused or snapped", { ignore: !SAMPLES_PRESENT }, async () => {
    const parsed = await sample("SRB", "asc");
    const reference = GemCadDesign.fromGemCad(await sample("SRB", "asc"), { name: "SRB" });

    const facet = parsed.tiers[1].indices[0];
    const half = 1.875 * Math.PI / 180;
    const { x, y } = facet.facetNormal;

    facet.facetNormal = {
        x: x * Math.cos(half) - y * Math.sin(half),
        y: x * Math.sin(half) + y * Math.cos(half),
        z: facet.facetNormal.z
    };

    const design = GemCadDesign.fromGemCad(parsed, { name: "SRB" });
    const index = design.tiers[1].facets[0].index;
    const teeth = design.gear.teeth;
    const moved = Math.abs(index - reference.tiers[1].facets[0].index);

    assert(!Number.isInteger(index), `expected a fractional index, got ${index}`);
    assertClose(index % 1, 0.5, 1e-9, `the fractional part is a half tooth, got ${index}`);
    assertClose(Math.min(moved, teeth - moved), 0.5, 1e-9, "half a tooth from the reference tooth");
    assertEquals(design.gear.fractional, true, "a half-tooth facet needs the fractional-teeth option");

    const rebuilt = GemCadDesign.normalOf(design, design.tiers[1].angle, index);

    assert(angleBetween(rebuilt, facet.facetNormal) < GemCadDesign.tolerances.normalAgreement,
        "the fractional index rebuilds the turned normal");
});

/*
 * The real design that used to need half-tooth snapping: 2013_Minimalist_4.gem,
 * from the gemology-project competition set. It is one of the 18 designs
 * T-0169's round-trip run found refused as "a fraction of a tooth off"; T-0171
 * turns that refusal into a fractional design instead.
 *
 * SETUP. The file as it is: gear 55, 5-fold mirror symmetry, six tiers.
 *
 * WHAT IT VERIFIES. It is accepted; `design.gear.fractional` is on; P1, G1 and
 * C1 (tiers 0, 1 and 3) are entirely fractional (half teeth) and the other
 * tiers entirely on whole teeth, as its geometry says; P1's facets sit at the
 * ten half-tooth positions measured from the file (close, not exact -- these
 * are recovered from geometry now, never rounded to a special 0.5); and every
 * facet's normal is rebuilt from its polar values, the load-bearing check of
 * this suite.
 */
Deno.test("2013_Minimalist_4.gem is described with fractional indices, not refused", { ignore: !CORPUS_PRESENT }, async () => {
    const url = new URL("../../../reference/gemology-project-designs/2013_Minimalist_4.gem",
        import.meta.url);
    const parsed = GemCad.importBytes(await Deno.readFile(url));
    const design = GemCadDesign.fromGemCad(parsed, { name: "2013_Minimalist_4" });

    assertEquals(design.gear.teeth, 55);
    assertEquals(design.gear.fractional, true,
        "three of this design's tiers sit on half teeth, so it needs the fractional-teeth option");

    const fractionalTiers = design.tiers
        .map((tier, t) => tier.facets.every(facet => !Number.isInteger(facet.index)) ? t : null)
        .filter(t => t !== null);

    assertEquals(fractionalTiers, [0, 1, 3], "P1, G1 and C1 sit on half teeth");

    for (const [t, tier] of design.tiers.entries()) {
        if (!fractionalTiers.includes(t)) {
            assert(tier.facets.every(facet => Number.isInteger(facet.index)),
                `tier ${t} is on whole teeth`);
        }
    }

    const p1Indices = design.tiers[0].facets.map(facet => facet.index).sort((a, b) => a - b);
    const expected = [1.5, 9.5, 12.5, 20.5, 23.5, 31.5, 34.5, 42.5, 45.5, 53.5];

    assertEquals(p1Indices.length, expected.length, "P1 keeps all ten of its facets");
    p1Indices.forEach((index, i) =>
        assertClose(index, expected[i], 1e-6, `P1 facet ${i} is the expected half-tooth position`));

    for (const [t, tier] of design.tiers.entries()) {
        for (const [f, facet] of tier.facets.entries()) {
            const stored = parsed.tiers[t].indices[f].facetNormal;
            const rebuilt = GemCadDesign.normalOf(design, tier.angle, facet.index);

            assert(angleBetween(rebuilt, stored) < GemCadDesign.tolerances.normalAgreement,
                `tier ${t} facet ${f} rebuilds its normal`);
        }
    }
});

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/*
 * Designs travel in URL hashes, so they outlive the code that wrote them. The
 * round trip has to be exact -- not close -- or a shared link degrades every
 * time someone opens and re-saves it.
 */
Deno.test("a design survives a JSON round trip exactly", { ignore: !SAMPLES_PRESENT }, async () => {
    for (const name of DESIGNS) {
        const design = GemCadDesign.fromGemCad(await sample(name, "asc"), { name });
        const text = JSON.stringify(GemCadDesign.toJSON(design));
        const restored = GemCadDesign.fromJSON(JSON.parse(text));

        assertEquals(GemCadDesign.toJSON(restored), GemCadDesign.toJSON(design),
            `${name}: round trip must be exact`);

        // And the restored design must still rebuild the same geometry.
        const before = GemCadDesign.planesOf(design);
        const after = GemCadDesign.planesOf(restored);

        assertEquals(after.length, before.length, `${name}: facet count`);

        // Compared component by component rather than through angleBetween.
        // The round trip should leave the normals *bit-identical*, and an
        // acos(dot) comparison cannot express that: one ulp of error in the dot
        // product reads as 1.2e-6 degrees, so acos has no resolution below that
        // however exact the inputs are.
        for (let i = 0; i < before.length; i++) {
            for (const axis of ["x", "y", "z"]) {
                assertEquals(after[i].normal[axis], before[i].normal[axis],
                    `${name}: plane ${i} component ${axis} moved across the round trip`);
            }

            assertEquals(after[i].offset, before[i].offset,
                `${name}: plane ${i} depth moved across the round trip`);
        }
    }
});

/*
 * `provenance` records how well the *import* went, not what the stone is. It
 * must not travel in a shared URL, where it would be meaningless.
 */
Deno.test("import diagnostics are not serialised", { ignore: !SAMPLES_PRESENT }, async () => {
    const design = GemCadDesign.fromGemCad(await sample("Turkey", "gem"), { name: "Turkey" });

    assert(design.provenance !== undefined, "the import should report how it went");
    assertEquals(GemCadDesign.toJSON(design).provenance, undefined,
        "but that report is not part of the document");
});

/*
 * A document from a future version must be refused, not guessed at. Loading it
 * as if it were version 1 would produce a plausible but wrong stone, which is
 * the worst available outcome.
 */
Deno.test("an unsupported schema version is refused", () => {
    assertThrows(() => GemCadDesign.fromJSON({ v: 99, gear: { teeth: 96 }, tiers: [] }),
        "not supported",
        "a future document must be refused");

    assertThrows(() => GemCadDesign.fromJSON({ gear: { teeth: 96 }, tiers: [] }),
        "not supported",
        "a document with no version is not a version-1 document");

    assertThrows(() => GemCadDesign.fromJSON(null), "not a design document", "null");
});

/*
 * The size budget that motivated storing generators rather than geometry: a
 * design has to fit in a URL that survives being pasted into a chat window.
 *
 * Browsers accept far more than this, but messengers and mail clients truncate
 * long URLs, so the target is "a few hundred characters", not "under the
 * browser's limit". Measured: 410-648 bytes gzipped for the four samples.
 */
Deno.test("a serialised design fits comfortably in a URL hash", { ignore: !SAMPLES_PRESENT }, async () => {
    for (const name of DESIGNS) {
        const design = GemCadDesign.fromGemCad(await sample(name, "asc"), { name });
        const text = JSON.stringify(GemCadDesign.toJSON(design));

        // Gzip through the same stream API the page already uses to inflate its
        // inlined wasm, so this measures what a real share would cost.
        const stream = new CompressionStream("gzip");
        const writer = stream.writable.getWriter();
        writer.write(new TextEncoder().encode(text));
        writer.close();

        const compressed = await new Response(stream.readable).arrayBuffer();
        const base64Length = Math.ceil(compressed.byteLength / 3) * 4;

        assert(base64Length < 4096,
            `${name}: ${base64Length} base64 characters is too long to share comfortably`);
    }
});

/*
 * Facet counts are the number a cutter counts, and a cheap guard that
 * fromGemCad is not dropping or duplicating facets. These are read off the
 * sample files' own `a` lines.
 */
Deno.test("facet counts match the designs as authored", { ignore: !SAMPLES_PRESENT }, async () => {
    const expected = { SRB: 73, Compear125: 67, Turkey: 74, CubeIllusionTri: 51 };

    for (const name of DESIGNS) {
        const design = GemCadDesign.fromGemCad(await sample(name, "asc"), { name });

        assertEquals(GemCadDesign.facetCount(design), expected[name], `${name}: facet count`);
    }
});

/*
 * THE TOLERANCE THAT REFUSED A REAL DESIGN.
 *
 * SETUP. A GemCad file writes each tier's mast angle rounded to two decimal
 * places, while its facet normals carry the true angle in full precision. So
 * rebuilding a normal from the written angle disagrees with the stored one by
 * up to half a step of 0.01 degrees -- 5e-3 -- and fromGemCad's
 * NORMAL_AGREEMENT_TOLERANCE has to allow that.
 *
 * It did not. It was 1e-3, calibrated on the four bundled samples, every one of
 * whose angles happens to be exact at two decimals (-42.5, -41.5, 34, 28, 16,
 * 0, -90). Those files never exercise the rounding, so the whole suite passed
 * at 1.2e-6 while the bound was four times too tight for any design with an
 * angle like -47.04. The first real-world file tried, Fiorello_80.gem, was
 * refused outright at 3.99e-3 -- and because the page derived the design on
 * the load path, that refusal stopped the stone being opened at all.
 *
 * THE TEST. Build a one-tier design by hand whose stored normal is at the TRUE
 * angle while the tier's written angle is that angle rounded to two decimals,
 * exactly as a real file does. The facet is put on an exact index tooth, so the
 * only disagreement is the rounding.
 *
 * WHAT IT VERIFIES. fromGemCad accepts it, and reports a worst-case normal
 * error in the 1e-3..1e-2 band -- proving both that the rounding really does
 * produce a disagreement of that size (so the test is not vacuous) and that the
 * gate tolerates it. Tightening NORMAL_AGREEMENT_TOLERANCE back below 5e-3
 * fails this test instead of silently rejecting users' designs.
 */
Deno.test("a mast angle rounded to two decimals, as every file writes it, is accepted", () => {
    const TRUE_ANGLE = -47.036010;                       // what the geometry says
    const WRITTEN_ANGLE = Math.round(TRUE_ANGLE * 100) / 100;   // -47.04, what the file holds
    const TEETH = 80;
    const TOOTH = 78;

    assert(WRITTEN_ANGLE !== TRUE_ANGLE, "the setup must actually round the angle");

    // The normal the file would store: built from the TRUE angle, so it is the
    // written angle that is the approximation, which is the real situation.
    const design = { gear: { teeth: TEETH, reversed: false, originIndex: 0 } };
    const normal = GemCadDesign.normalOf(design, TRUE_ANGLE, TOOTH);

    const parsed = {
        metadata: {
            gear: TEETH, gearLocationAngle: 0, refractiveIndex: 0,
            symmetryFolds: 1, symmetryMirror: false, headers: [], footnotes: [],
        },
        tiers: [{
            isPreform: false, number: 1, angle: WRITTEN_ANGLE, distance: 0.5,
            cuttingInstructions: "", indices: [{
                tier: 1, name: "", index: TOOTH,
                // The reader stores a point three units along the outward normal, not a
                // unit vector; only the direction is read, so any positive scale will do.
                facetNormal: { x: normal.x * 3, y: normal.y * 3, z: normal.z * 3 },
                points: [], renderingTriangles: [],
            }],
        }],
    };

    // The assertion: this does not throw. Before the fix it threw
    // "rebuilds a normal 0.003990 degrees away from the geometry in the file".
    const built = GemCadDesign.fromGemCad(parsed, { name: "rounded-angle" });

    assertEquals(built.tiers.length, 1, "one tier in, one tier out");
    assertEquals(built.tiers[0].facets[0].index, TOOTH,
        "the index is recovered exactly despite the rounded angle");
    assertClose(built.tiers[0].angle, WRITTEN_ANGLE, 0, "the tier keeps the authored angle");

    // Not vacuous: the rounding must really cost more than the old 1e-3 gate allowed,
    // or this test would pass even with the bound put back.
    const worst = built.provenance.worstNormalError;

    assert(worst > 1e-3,
        `the rounding should disagree by more than the old 1e-3 gate, got ${worst}`);
    assert(worst <= GemCadDesign.tolerances.normalAgreement,
        `and within the current gate ${GemCadDesign.tolerances.normalAgreement}, got ${worst}`);
});

/*
 * A MEET-POINT SOLVED FACET SITS A HAIR OFF ITS TOOTH, AND MUST STILL BE ACCEPTED.
 *
 * SETUP. Gem Cut Studio places "Meet ..." tiers with a solver that nudges each
 * facet so its corners land exactly on the meet, and stores the nudged normal.
 * On the user's hex_cut_v2 the worst such facet is 1.29e-5 of a tooth off,
 * measured in both GCS's own .gcs and its .gem export. The index gate was 1e-6,
 * calibrated on four samples with no solved tiers, so it refused the design.
 *
 * THE TEST. Take SRB, rotate one facet's normal about the axis by exactly the
 * measured residue (1.29e-5 of a 3.75-degree tooth), and derive the design.
 *
 * WHAT IT VERIFIES. It is accepted, the facet is recorded on its original
 * tooth (snapped, not shifted to a neighbour), and the reported snap distance
 * is the residue that was injected -- so the test genuinely exercises the gate
 * rather than passing because nothing moved. The quarter-tooth rejection test
 * above still holds alongside it, which is the other half of the claim: the
 * gate separates solver residue from a deliberately off-index facet.
 */
Deno.test("a facet a meet-point solver left a hair off its tooth is accepted", { ignore: !SAMPLES_PRESENT }, async () => {
    const parsed = await sample("SRB", "asc");
    const reference = GemCadDesign.fromGemCad(await sample("SRB", "asc"), { name: "SRB" });

    const RESIDUE_TEETH = 1.29e-5;
    const turn = RESIDUE_TEETH * 3.75 * Math.PI / 180;
    const facet = parsed.tiers[1].indices[0];
    const { x, y } = facet.facetNormal;

    facet.facetNormal = {
        x: x * Math.cos(turn) - y * Math.sin(turn),
        y: x * Math.sin(turn) + y * Math.cos(turn),
        z: facet.facetNormal.z
    };

    const design = GemCadDesign.fromGemCad(parsed, { name: "SRB" });

    assertEquals(design.tiers[1].facets[0].index, reference.tiers[1].facets[0].index,
        "the facet snaps back to the tooth it was on, not a neighbour");
    assertClose(design.provenance.worstIndexSnap, RESIDUE_TEETH, 1e-8,
        "the reported snap is the injected residue, so the gate was really exercised");
});

// ---------------------------------------------------------------------------
// T-0160: matching a mesh facet's normal back to its design tier
// ---------------------------------------------------------------------------

/*
 * T-0160 (clicking a facet highlights its whole tier, in the page and its cutting
 * instructions) needs the reverse of normalOf: given a facet's own outward normal, which
 * TIER was it cut as part of? matchNormalToPlanes answers that by nearest direction over
 * planesOf(design).
 *
 * THIS TEST exercises the matching algorithm itself, not Rust's mesh normals -- that half
 * needs a browser and a loaded stone, and is covered by scratchpad/check_tier_mapping.py
 * against the real page for hex_cut_v2.gcs, Fiorello_80.gem and SRB.asc (see T-0160's ticket
 * log for that run). But every plane's own stored `facetNormal` IS a mesh facet's outward
 * normal by construction -- gemcad_obj.js writes each triangle wound to agree with exactly
 * that vector -- so matching each plane's own normal back against planesOf(design) exercises
 * the identical nearest-normal search a clicked mesh facet's normal would go through, across
 * four real, varied designs (61 to 74 facets each) in both file formats.
 *
 * WHAT IT VERIFIES: every one of 530 facets matches its OWN tier (not merely "a" tier), and
 * reports the worst self-match error (should be at the acos floor, ~1e-6 degrees, since a
 * plane matching itself is a dot product of 1 minus float noise) and the smallest margin
 * between the best and second-best tier anywhere in the whole sample set -- the number that
 * would catch two tiers whose facets are too close together in direction to tell apart
 * reliably. A design where any facet's second-best match were also correct-tier would still
 * pass (matching by TIER, not by exact facet-within-tier, since that is all the page needs),
 * but the margin is still measured over PLANES, which is the stricter, more informative
 * number.
 */
Deno.test("matchNormalToPlanes recovers every facet's own tier, with a clear margin, across all four samples", { ignore: !SAMPLES_PRESENT }, async () => {
    let checked = 0;
    let worstError = 0;
    let worstErrorWhere = "";
    let smallestMargin = Infinity;
    let smallestMarginWhere = "";

    for (const name of DESIGNS) {
        for (const extension of ["asc", "gem"]) {
            const parsed = await sample(name, extension);
            const design = GemCadDesign.fromGemCad(parsed, { name });
            const planes = GemCadDesign.planesOf(design);

            for (const plane of planes) {
                const match = GemCadDesign.matchNormalToPlanes(planes, plane.normal);
                const where = `${name}.${extension} tier ${plane.tier} facet ${plane.facet}`;

                assertEquals(match.tier, plane.tier,
                    `${where}: a facet's own normal must match its own tier, got tier ${match.tier}`);

                checked++;

                if (match.errorDegrees > worstError) {
                    worstError = match.errorDegrees;
                    worstErrorWhere = where;
                }

                if (match.marginDegrees < smallestMargin) {
                    smallestMargin = match.marginDegrees;
                    smallestMarginWhere = where;
                }
            }
        }
    }

    assert(checked > 200, `expected to check several hundred facets, only checked ${checked}`);

    // A plane matching itself is a dot product of 1 minus float noise, so this should sit at
    // the acos floor (~1.2e-6 degrees, see the trap documented on NORMAL_AGREEMENT_TOLERANCE
    // above) -- 1e-3 leaves three orders of magnitude of headroom without being so loose it
    // would miss a real regression in the search.
    assert(worstError < 1e-3,
        `a plane must match itself almost exactly; worst self-match error ${worstError} at ${worstErrorWhere}`);

    // The smallest gap, anywhere in 530 facets across four different real designs, between the
    // tier a facet actually belongs to and the next-nearest wrong answer. Reported rather than
    // merely asserted loosely, so a future design that narrows this is visible in the test
    // output rather than only in a bare pass/fail.
    assert(smallestMargin > 0.01,
        `smallest margin between best and second-best tier match was only ${smallestMargin} ` +
        `degrees, at ${smallestMarginWhere}`);

    console.log(
        `matchNormalToPlanes: checked ${checked} facets across 4 designs x 2 formats, worst ` +
        `self-match error ${worstError.toFixed(6)}° (at ${worstErrorWhere}), smallest ` +
        `margin ${smallestMargin.toFixed(6)}° (at ${smallestMarginWhere})`
    );
});

// ---------------------------------------------------------------------------
// T-0171: re-expressing a design on a different gear
// ---------------------------------------------------------------------------

/*
 * A minimal synthetic design -- just enough for reExpressOnGear and normalOf
 * to operate on -- from a flat list of index positions, all in one tier
 * (reExpressOnGear treats every tier identically, so one tier exercises the
 * same code path several would). Used instead of the four bundled samples
 * where a test needs a SPECIFIC index (like hex_cut_v2's 3 and 13, which are
 * not in any sample design) rather than whatever a real file happens to have.
 */
function makeSyntheticDesign(teeth, indices, { reversed = false, originIndex = 0, angle = -20 } = {}) {
    return {
        v: 1,
        name: "synthetic",
        gear: { teeth, reversed, originIndex, fractional: false },
        symmetry: { folds: 1, mirror: false },
        refractiveIndex: 0,
        tiers: [{
            angle, distance: 0.5, preform: false, cuttingInstructions: "",
            facets: indices.map(index => ({ index, name: "" })),
        }],
        headers: [], footnotes: [],
    };
}

/*
 * THE INVARIANT reExpressOnGear exists to preserve: changing the index gear
 * must not move any facet's physical azimuth, only its DESCRIPTION. 96 -> 48
 * is the clean case -- every even index on a 96-tooth wheel names the exact
 * same direction as half its value on a 48-tooth wheel -- so nothing should
 * need to go fractional, and every rebuilt normal should agree with the
 * pre-change one, checked directly with normalOf rather than assumed from
 * the arithmetic.
 *
 * The angleBetween checks below (here and in the two tests after it) use
 * 1e-4 degrees, not something tighter: acos is ill-conditioned near a dot
 * product of 1 (see NORMAL_AGREEMENT_TOLERANCE's own comment in design.js),
 * so a genuinely one-ULP difference in the underlying sin/cos calls -- which
 * DOES happen here, since the old and new gear compute the same azimuth via
 * different intermediate step angles -- reads back as approximately 1e-6
 * degrees despite the directions being identical to float precision. 1e-4
 * is comfortably above that floor without being so loose it would miss a
 * real azimuth shift.
 */
Deno.test("reExpressOnGear: 96 -> 48 is exact and whole-toothed for an all-even design", () => {
    const oldIndices = [0, 4, 16, 32, 48, 64, 80, 92];
    const design = makeSyntheticDesign(96, oldIndices);

    const result = GemCadDesign.reExpressOnGear(design, { teeth: 48 });

    assertEquals(result.gear.teeth, 48);
    assertEquals(result.gear.fractional, false,
        "every even index over 96 teeth halves onto a whole tooth of 48");

    const newIndices = result.tiers[0].facets.map(facet => facet.index);

    assertEquals(newIndices, oldIndices.map(index => index / 2), "each index exactly halves");

    // The load-bearing check: the SAME physical direction, on both gears.
    for (let f = 0; f < oldIndices.length; f++) {
        const before = GemCadDesign.normalOf(design, design.tiers[0].angle, oldIndices[f]);
        const after = GemCadDesign.normalOf(result, result.tiers[0].angle, newIndices[f]);

        assert(angleBetween(before, after) < 1e-4,
            `facet ${f}: re-expressing to 48 teeth must not move its physical azimuth`);
    }
});

/*
 * 96 -> 80 is the case that MUST go fractional: hex_cut_v2's own indices (3,
 * 13, ...) do not divide cleanly by 96/80 = 6/5. This suite has no .gcs
 * reader loaded (see gcs_test.js for the real file), so a synthetic design
 * carrying the same failing indices exercises the identical arithmetic.
 */
Deno.test("reExpressOnGear: 96 -> 80 fractionalises an index that does not divide evenly", () => {
    const design = makeSyntheticDesign(96, [3, 13]);

    const result = GemCadDesign.reExpressOnGear(design, { teeth: 80 });

    assertEquals(result.gear.fractional, true, "3 and 13 over 96 teeth do not land on a tooth of 80");

    const [three, thirteen] = result.tiers[0].facets.map(facet => facet.index);

    assertClose(three, 3 * 80 / 96, 1e-9, "3/96 becomes 2.5/80");
    assertClose(thirteen, 13 * 80 / 96, 1e-9, "13/96 becomes 10.8333.../80");
    assert(!Number.isInteger(three), "3/96 is fractional at 80 teeth");
    assert(!Number.isInteger(thirteen), "13/96 is fractional at 80 teeth");

    // Still the same physical direction, fractional description or not.
    for (const [oldIndex, newIndex] of [[3, three], [13, thirteen]]) {
        const before = GemCadDesign.normalOf(design, design.tiers[0].angle, oldIndex);
        const after = GemCadDesign.normalOf(result, result.tiers[0].angle, newIndex);

        assert(angleBetween(before, after) < 1e-4,
            "a fractional re-expression still reproduces the original azimuth");
    }
});

/*
 * A round trip through an intermediate gear must return to the ORIGINAL
 * indices. 96 -> 64 fractionalises most of these (96/64 = 3/2, so only an
 * index divisible by 2 lands on a whole tooth of 64); 64 -> 96 must bring
 * every one of them back to exactly where it started -- snapped back to a
 * whole tooth, not left drifting by the float noise two chained ratios (a
 * number, then its reciprocal) actually do introduce, which is precisely
 * what INDEX_SNAP_TOLERANCE exists to absorb.
 */
Deno.test("reExpressOnGear: a round trip through 64 teeth returns to the original 96-tooth indices", () => {
    const oldIndices = [0, 1, 4, 7, 50, 95];
    const design = makeSyntheticDesign(96, oldIndices);

    const via64 = GemCadDesign.reExpressOnGear(design, { teeth: 64 });
    const back = GemCadDesign.reExpressOnGear(via64, { teeth: 96 });

    const roundTripped = back.tiers[0].facets.map(facet => facet.index);

    assertEquals(back.gear.teeth, 96);
    roundTripped.forEach((index, f) =>
        assertClose(index, oldIndices[f], 1e-6, `facet ${f} must return to its original index`));

    // Not merely close to whole -- genuinely whole again, the way a real machine setting has
    // to be, despite the round trip's own arithmetic being exactly the source of the noise
    // the snap tolerance exists to absorb.
    roundTripped.forEach((index, f) =>
        assert(Number.isInteger(index),
            `facet ${f} (originally ${oldIndices[f]}) should be whole-tooth again, got ${index}`));
});

/*
 * THE MESH DOES NOT MOVE. A tooth-count change only re-describes a facet; it
 * never repositions its plane -- so the page never needs to rebuild the
 * stone (window.gemRebuildStoneFromDesign) for one. Checked directly against
 * a real design's full plane list (planesOf's whole output, normal AND
 * offset), not only normalOf for a couple of hand-picked facets.
 *
 * 96 -> 192 (SRB's own gear, doubled) is deliberately a clean multiplication:
 * every existing whole-tooth index doubles onto another whole tooth, so this
 * isolates the re-expression arithmetic's OWN precision from the separate,
 * already-tested question of what happens once snapping has to choose
 * between "snap" and "fractional" (the tests above).
 */
Deno.test("reExpressOnGear: planesOf is unchanged by a tooth-count change", { ignore: !SAMPLES_PRESENT }, async () => {
    const design = GemCadDesign.fromGemCad(await sample("SRB", "asc"), { name: "SRB" });
    const result = GemCadDesign.reExpressOnGear(design, { teeth: design.gear.teeth * 2 });

    assertEquals(result.gear.fractional, false, "doubling the gear keeps every index whole-toothed");

    const before = GemCadDesign.planesOf(design);
    const after = GemCadDesign.planesOf(result);

    assertEquals(after.length, before.length, "the facet count must not change");

    for (let i = 0; i < before.length; i++) {
        assertClose(after[i].normal.x, before[i].normal.x, 1e-9, `plane ${i}: normal.x moved`);
        assertClose(after[i].normal.y, before[i].normal.y, 1e-9, `plane ${i}: normal.y moved`);
        assertClose(after[i].normal.z, before[i].normal.z, 1e-9, `plane ${i}: normal.z moved`);
        assertEquals(after[i].offset, before[i].offset,
            `plane ${i}: offset moved (cut depth never depends on the gear)`);
    }
});

/*
 * "Taking a reversed gear into account" (T-0171's own brief): if the new gear
 * runs the OPPOSITE direction from the old one, the signed-teeth ratio used
 * internally goes negative, which mirrors every index as well as rescaling
 * it. This is what makes the same physical facet still describable on a
 * wheel that now turns the other way.
 */
Deno.test("reExpressOnGear: a reversed new gear still reproduces the original azimuth", () => {
    const design = makeSyntheticDesign(96, [0, 12, 24, 48], { reversed: false });

    const result = GemCadDesign.reExpressOnGear(design, { teeth: 96, reversed: true });

    assertEquals(result.gear.reversed, true);

    for (let f = 0; f < design.tiers[0].facets.length; f++) {
        const oldIndex = design.tiers[0].facets[f].index;
        const newIndex = result.tiers[0].facets[f].index;
        const before = GemCadDesign.normalOf(design, design.tiers[0].angle, oldIndex);
        const after = GemCadDesign.normalOf(result, result.tiers[0].angle, newIndex);

        assert(angleBetween(before, after) < 1e-4,
            `facet ${f}: reversing the gear must still land on the same physical direction`);
    }
});

/*
 * A TABLE A HAIR OFF THE AXIS IS STILL A TABLE, AND NEVER MAKES A DESIGN FRACTIONAL.
 *
 * SETUP. Chunkoid.gem's table normal leans 1.7e-8 degrees off the optical
 * axis: rounding noise. polarOf used to count a facet as on-axis only when its
 * sideways components were under 1e-12, so it computed an azimuth for this
 * table from the noise, got tooth 89.18, and switched the whole design to
 * fractional teeth -- when the user's rule is that "fractional tables don't
 * matter": a flat facet has no azimuth, so no index to be fractional.
 *
 * THE TEST. Derive Chunkoid.gem, read by path from the reference corpus.
 *
 * WHAT IT VERIFIES. Its table tier is angle exactly 0 with index 0, and the
 * design is NOT fractional -- the table was its only off-tooth facet. The
 * exact 0 matters as much as the index: the page files a tier as the table by
 * testing for angle 0, so a table carrying its lean into the angle would be
 * listed as a crown tier.
 */
// ---------------------------------------------------------------------------
// T-0175: the tier toolbar's flags, and which tiers cut the stone
// ---------------------------------------------------------------------------

/*
 * WHICH TIERS CUT THE STONE (T-0178 hidden, T-0179 preform, T-0180 frosted).
 *
 * SETUP. SRB.asc (73 facets over 7 tiers), with one tier hidden, another
 * marked preform, and a third frosted.
 *
 * THE TEST. isRenderedTier on each flag, and renderedPlanesOf on the design.
 *
 * WHAT IT VERIFIES. Only the hidden tier is left out. A preform tier is cut
 * normally (the user, 2026-09-18: "the teeth need to have the {} and cut it
 * normally"), and a frosted one too (frosting is a surface finish the
 * renderer is told about separately, T-0183, not a change to which planes
 * cut the stone). renderedPlanesOf drops exactly the hidden tier's facets and nothing
 * else, and each surviving plane's `tier` still indexes into the FULL
 * design.tiers (the page turns it back into a tier object with
 * design.tiers[plane.tier]).
 */
Deno.test("isRenderedTier and renderedPlanesOf leave out hidden tiers only, not preform or frosted ones", { ignore: !SAMPLES_PRESENT }, async () => {
    const design = GemCadDesign.fromGemCad(await sample("SRB", "asc"), { name: "SRB" });
    const all = GemCadDesign.planesOf(design);

    design.tiers[1].hidden = true;
    design.tiers[2].preform = true;
    design.tiers[4].frosted = true;

    assertEquals(GemCadDesign.isRenderedTier(design.tiers[0]), true, "a plain tier is rendered");
    assertEquals(GemCadDesign.isRenderedTier(design.tiers[1]), false, "a hidden tier is not");
    assertEquals(GemCadDesign.isRenderedTier(design.tiers[2]), true, "a preform tier is cut normally");
    assertEquals(GemCadDesign.isRenderedTier(design.tiers[4]), true, "a frosted tier still is");

    const rendered = GemCadDesign.renderedPlanesOf(design);

    assertEquals(rendered.length, all.length - design.tiers[1].facets.length,
        "exactly the hidden tier's facets are dropped");
    assert(rendered.every(p => p.tier !== 1), "no plane of the hidden tier survives");
    assert(rendered.some(p => p.tier === 2), "the preform tier's planes remain");
    assert(rendered.some(p => p.tier === 4), "the frosted tier's planes remain");
    assert(rendered.every(p => design.tiers[p.tier].facets[p.facet] !== undefined),
        "every plane still points at its own tier and facet in the full design");
});

/*
 * The flags travel with a serialised design. SETUP: SRB with one tier hidden
 * and one frosted. TEST: a JSON round trip. VERIFIES: both flags come back,
 * and every other tier comes back with them off -- including a document that
 * predates the flags entirely (no keys at all), which must read as all off.
 */
Deno.test("hidden and frosted survive a JSON round trip and default to off", { ignore: !SAMPLES_PRESENT }, async () => {
    const design = GemCadDesign.fromGemCad(await sample("SRB", "asc"), { name: "SRB" });

    design.tiers[0].hidden = true;
    design.tiers[5].frosted = true;

    const restored = GemCadDesign.fromJSON(JSON.parse(JSON.stringify(GemCadDesign.toJSON(design))));

    assertEquals(restored.tiers.map(t => t.hidden), design.tiers.map((t, i) => i === 0), "hidden round-trips");
    assertEquals(restored.tiers.map(t => t.frosted), design.tiers.map((t, i) => i === 5), "frosted round-trips");

    const old = GemCadDesign.toJSON(design);
    old.tiers.forEach(t => { delete t.hidden; delete t.frosted; });
    const fromOld = GemCadDesign.fromJSON(old);

    assert(fromOld.tiers.every(t => t.hidden === false && t.frosted === false),
        "a document written before the flags existed reads with both off");
});

Deno.test("a table a hair off the axis is a table at index 0 and is never fractional", { ignore: !CORPUS_PRESENT }, () => {
    const bytes = Deno.readFileSync(new URL(
        "../../../reference/gemology-project-designs/Chunkoid.gem", import.meta.url));
    const design = GemCadDesign.fromGemCad(GemCad.importBytes(bytes), { name: "Chunkoid" });
    const tables = design.tiers.filter(tier => tier.angle === 0);

    assertEquals(tables.length, 1, "exactly one tier is the table, at angle exactly 0");
    assertEquals(tables[0].facets.map(facet => facet.index), [0], "a flat facet's index is 0");
    assertEquals(design.gear.fractional, false,
        "the table's meaningless azimuth no longer makes the design fractional");
});
