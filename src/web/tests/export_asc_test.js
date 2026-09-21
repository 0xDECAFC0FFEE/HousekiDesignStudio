/*
 * export_asc_test.js -- tests for web/src/lib/export_asc.js, the GemCad .asc WRITER (T-0206).
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The important property here, per the user's own request, is a ROUND TRIP, not just "the writer
 * produces syntactically valid lines": open one of the four bundled sample designs
 * (reference/gemcad-file-reader/Samples/*.asc), turn it into a design the same way the page does
 * (GemCad.importAscText -> GemCadDesign.fromGemCad), write THAT design back out with
 * designToAscText, re-open the text this writer just produced the very same way, and check that
 * the two designs agree -- same gear, same tier count, and every tier's angle, distance and
 * facet index list line up. "Line up" is the user's own word for this and means semantic
 * agreement of the two designs, not byte-identical text: this writer's line formatting need not
 * (and does not try to) match what GemCad itself would write.
 *
 * gemcad.js and design.js are classic browser scripts (no ES module syntax -- see their own file
 * comments), published as globalThis.GemCad / globalThis.GemCadDesign, so they are loaded here
 * the same way comments_test.js loads edit_history.js: read the file's text and eval it. Order
 * does not matter between the two -- design.js's fromGemCad takes an already-parsed
 * GemCad.importAscText result as a plain argument and never reads globalThis.GemCad itself -- but
 * gemcad.js is loaded first since it is needed to parse anything at all.
 */

import { designToAscText } from "../src/lib/export_asc.js";

(0, eval)(await Deno.readTextFile(new URL("../../js/gemcad.js", import.meta.url)));
(0, eval)(await Deno.readTextFile(new URL("../../js/design.js", import.meta.url)));

const { GemCad, GemCadDesign } = globalThis;

// design.js's own gate for "close enough to the tooth it was recovered from to snap to it",
// read off the library rather than invented here (the ticket's own instruction: do not invent a
// new tolerance). It is measured in TEETH, not degrees -- see design.js's own comment on
// INDEX_SNAP_TOLERANCE for why (a meet-point solver's nudge, or this representation's own
// re-expression arithmetic, both bounded in tooth units, not angular ones).
const INDEX_SNAP_TOLERANCE = GemCadDesign.tolerances.indexSnap;

/**
 * The four bundled sample designs live under reference/gemcad-file-reader/Samples/ (vendored,
 * MIT, see kb/clean-room-and-licensing-constraints.md). The ticket asks for at least 3 of the 4;
 * all four are round-tripped here since the cost of the fourth is the same few lines.
 */
const SAMPLE_NAMES = ["Compear125", "SRB", "Turkey", "CubeIllusionTri"];

function sampleUrl(name) {
  return new URL(`../../../reference/gemcad-file-reader/Samples/${name}.asc`, import.meta.url);
}

/*
 * ...but vendored means gitignored: reference/ is several hundred megabytes of third-party data
 * that is deliberately kept out of the repository, so a fresh clone has none of it, and this
 * suite still has to be green there. The round-trip test below is therefore marked
 * `{ ignore: !SAMPLES_PRESENT }` and reports as ignored when the samples are absent, instead of
 * erroring on a missing file; with them present it runs exactly as before. The two synthetic
 * tests after it build their own designs by hand and are never gated.
 */
const SAMPLES_PRESENT = (() => {
  try {
    Deno.statSync(new URL("../../../reference/gemcad-file-reader/Samples/", import.meta.url));
    return true;
  } catch {
    return false;
  }
})();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Round-trips one sample file through the writer and returns the two designs plus the exported
 * text, so a test can both assert on the designs and print the actual measured disagreement (the
 * numbers the ticket's close note is supposed to report).
 */
function roundTrip(name) {
  const originalText = Deno.readTextFileSync(sampleUrl(name));

  // Step 1-2: the ORIGINAL file, parsed and turned into a design exactly as the page's own load
  // path does (design_load.js's objTextFromBytes, the .asc branch).
  const parsed1 = GemCad.importAscText(originalText, GemCad.nullLogger);
  const design1 = GemCadDesign.fromGemCad(parsed1, { name });

  // Step 3: this ticket's writer, turning that design back into .asc text.
  const written = designToAscText(design1);

  // Step 4-5: the text THIS WRITER JUST PRODUCED, parsed and turned into a design the same way.
  const parsed2 = GemCad.importAscText(written, GemCad.nullLogger);
  const design2 = GemCadDesign.fromGemCad(parsed2, { name });

  return { design1, design2, written };
}

/** The largest absolute difference between two same-length arrays of numbers. */
function worstAbsDiff(a, b) {
  let worst = 0;

  for (let i = 0; i < a.length; i++) {
    worst = Math.max(worst, Math.abs(a[i] - b[i]));
  }

  return worst;
}

Deno.test("designToAscText round-trips all four bundled sample designs (open -> design -> write -> reopen -> design)", { ignore: !SAMPLES_PRESENT }, () => {
  // Setup: each of the four bundled GemCad sample .asc files -- Compear125, SRB, Turkey and
  // CubeIllusionTri -- read, parsed into a design, written back out by this ticket's writer, and
  // re-parsed into a second design (roundTrip, above). None of the four is a fractional design
  // (kb/the-polar-internal-representation.md: "the four sample designs do not exercise the angle
  // rounding"), so this is the writer's ordinary case; a fractional facet's own round trip is
  // covered by the synthetic test below.
  //
  // Test: for every sample, compare design1 (straight from the original file) against design2
  // (from this writer's own output) on exactly what the ticket's acceptance criteria ask for:
  // the gear (teeth, reversed, fractional), the tier count, and, tier by tier, the angle, the
  // distance and the facet index list.
  //
  // Verifies: the writer is a faithful inverse of the reader for real GemCad files, not merely
  // "produces text that parses". The worst disagreement measured across all four samples is
  // printed at the end (Deno.test does not fail on stray console output), which is the number
  // this ticket's close note reports -- and it is expected to be many orders of magnitude under
  // INDEX_SNAP_TOLERANCE and any reasonable angle/distance float tolerance, because this writer
  // never re-derives or rounds a stored number: it prints the design's own doubles with
  // JavaScript's shortest-round-trip Number->String conversion, which `tryParseFloat` parses
  // back to the identical double. Any disagreement that DOES show up is purely from
  // `fromGemCad`'s own re-derivation of angle/index from the rebuilt facet geometry, on BOTH
  // sides of the round trip -- not from anything this writer approximates.
  let worstAngle = 0;
  let worstDistance = 0;
  let worstIndex = 0;

  for (const name of SAMPLE_NAMES) {
    const { design1, design2 } = roundTrip(name);

    // The gear: teeth (magnitude), reversed (the wheel's direction) and fractional (whether any
    // facet needed the fractional-teeth opt-in) all have to agree exactly -- these are discrete
    // facts about the design, not measurements with a tolerance.
    assert(design1.gear.teeth === design2.gear.teeth,
      `${name}: gear teeth ${design1.gear.teeth} vs ${design2.gear.teeth}`);
    assert(design1.gear.reversed === design2.gear.reversed,
      `${name}: gear reversed ${design1.gear.reversed} vs ${design2.gear.reversed}`);
    assert(design1.gear.fractional === design2.gear.fractional,
      `${name}: gear fractional ${design1.gear.fractional} vs ${design2.gear.fractional}`);

    // The tier count: one `a` line per tier, written in the same order they are read, so a
    // faithful writer can never gain or lose a tier.
    assert(design1.tiers.length === design2.tiers.length,
      `${name}: tier count ${design1.tiers.length} vs ${design2.tiers.length}`);

    for (let t = 0; t < design1.tiers.length; t++) {
      const tier1 = design1.tiers[t];
      const tier2 = design2.tiers[t];

      const angleDiff = Math.abs(tier1.angle - tier2.angle);
      const distanceDiff = Math.abs(tier1.distance - tier2.distance);

      worstAngle = Math.max(worstAngle, angleDiff);
      worstDistance = Math.max(worstDistance, distanceDiff);

      // A generous 1e-6 gate (both angle and distance are plain doubles a few units across, so
      // 1e-6 is nowhere near float noise): see the doc comment above for why the writer's own
      // contribution to any disagreement should in practice be unmeasurable, and this is only
      // catching a genuine regression, not chasing float precision.
      assert(angleDiff < 1e-6,
        `${name} tier ${t}: angle ${tier1.angle} vs ${tier2.angle} (off by ${angleDiff})`);
      assert(distanceDiff < 1e-6,
        `${name} tier ${t}: distance ${tier1.distance} vs ${tier2.distance} (off by ${distanceDiff})`);

      // The facet index list: same length, same order (a tier's facets are written and read back
      // in array order, never sorted -- see tierLine's own comment in export_asc.js), and each
      // index within design.js's own INDEX_SNAP_TOLERANCE (measured in teeth) of the original.
      assert(tier1.facets.length === tier2.facets.length,
        `${name} tier ${t}: facet count ${tier1.facets.length} vs ${tier2.facets.length}`);

      const indexDiff = worstAbsDiff(
        tier1.facets.map(f => f.index),
        tier2.facets.map(f => f.index),
      );

      worstIndex = Math.max(worstIndex, indexDiff);

      assert(indexDiff <= INDEX_SNAP_TOLERANCE,
        `${name} tier ${t}: facet indices [${tier1.facets.map(f => f.index)}] vs ` +
        `[${tier2.facets.map(f => f.index)}] (off by ${indexDiff} teeth)`);
    }
  }

  console.log(
    `export_asc round trip, worst across ${SAMPLE_NAMES.join(", ")}: ` +
    `angle ${worstAngle.toExponential(3)} degrees, distance ${worstDistance.toExponential(3)} ` +
    `model units, index ${worstIndex.toExponential(3)} of a tooth ` +
    `(gate ${INDEX_SNAP_TOLERANCE.toExponential(3)}).`
  );
});

Deno.test("designToAscText writes a gear's sign correctly: reversed design.gear becomes a negative file gear, and back", () => {
  // Setup: two minimal one-tier, one-facet designs, identical except for `gear.reversed` -- the
  // exact scenario T-0088/T-0170/T-0171 warn about: design.js stores a magnitude PLUS a
  // `reversed` flag, the OPPOSITE of the file's own convention (a negative gear count IN the
  // file means the wheel runs the other way). Getting the sign translation backwards here would
  // silently turn every reversed design into a forward one on export -- exactly the bug T-0088
  // fixed on the READ side, mirrored onto the WRITE side.
  //
  // Test: designToAscText each design, and check the literal sign of the `g` line's tooth count.
  //
  // Verifies: `signedTeeth` in export_asc.js negates when (and only when) `reversed` is true --
  // and, going all the way round, that GemCad.importAscText + GemCadDesign.fromGemCad reads the
  // exported text back into a design whose OWN `reversed` flag matches what was written, not its
  // logical negation.
  const forward = {
    gear: { teeth: 96, reversed: false, originIndex: 0, fractional: false },
    symmetry: { folds: 1, mirror: false },
    refractiveIndex: 1.54,
    tiers: [{ angle: 0, distance: 0.5, cuttingInstructions: "", facets: [{ index: 0, name: "" }] }],
    headers: [],
    footnotes: [],
  };
  const reversed = { ...forward, gear: { ...forward.gear, reversed: true } };

  const forwardText = designToAscText(forward);
  const reversedText = designToAscText(reversed);

  // The `g` line itself: "g 96 0" for the forward wheel, "g -96 0" for the reversed one.
  const forwardGearLine = forwardText.split("\n").find(line => line.startsWith("g "));
  const reversedGearLine = reversedText.split("\n").find(line => line.startsWith("g "));

  assert(forwardGearLine === "g 96 0", `forward gear line: got "${forwardGearLine}"`);
  assert(reversedGearLine === "g -96 0", `reversed gear line: got "${reversedGearLine}"`);

  // And the full round trip: reading each text back must reproduce the SAME `reversed` flag,
  // not its opposite.
  const forwardBack = GemCadDesign.fromGemCad(
    GemCad.importAscText(forwardText, GemCad.nullLogger), {});
  const reversedBack = GemCadDesign.fromGemCad(
    GemCad.importAscText(reversedText, GemCad.nullLogger), {});

  assert(forwardBack.gear.reversed === false, "forward design stayed forward");
  assert(reversedBack.gear.reversed === true, "reversed design stayed reversed");
});

Deno.test("designToAscText writes a fractional index as a real number, not truncated to an integer", () => {
  // Setup: a design whose one facet sits a genuine 0.25 of a tooth off the grid -- comfortably
  // outside INDEX_SNAP_TOLERANCE (5e-3 of a tooth), so `fractional` is true and the facet's own
  // index (12.25) is not a whole number. This is the shape `fromGemCad` produces for a real
  // off-tooth design (T-0171's fractional-teeth feature); export_asc_test builds it by hand
  // rather than sourcing it from a bundled sample, since none of the four bundled samples has a
  // fractional facet (kb/the-polar-internal-representation.md).
  //
  // Test: designToAscText, then read the `a` line's facet-index token back with
  // GemCad.tryParseFloat (the exact function `processAscLine` itself uses to decide whether a
  // token is a facet index at all).
  //
  // Verifies: a fractional index round-trips as 12.25, not 12 -- i.e. `formatNumber` writes
  // `String(12.25)` ("12.25"), never something that would `parseInt`-truncate on the way back.
  const design = {
    gear: { teeth: 96, reversed: false, originIndex: 0, fractional: true },
    symmetry: { folds: 1, mirror: false },
    refractiveIndex: 1.54,
    tiers: [{
      angle: -42.5, distance: 0.6, cuttingInstructions: "",
      facets: [{ index: 12.25, name: "" }],
    }],
    headers: [],
    footnotes: [],
  };

  const text = designToAscText(design);
  const tierLine = text.split("\n").find(line => line.startsWith("a "));
  const facetToken = tierLine.split(" ")[3]; // "a", angle, distance, <facet index>, ...

  assert(GemCad.tryParseFloat(facetToken) === 12.25,
    `expected the facet-index token to parse back to 12.25, got "${facetToken}"`);

  // And the whole design, round-tripped: fromGemCad must recover the same fractional index and
  // the same `fractional` flag, not silently snap 12.25 to a neighbouring whole tooth.
  const reparsed = GemCadDesign.fromGemCad(GemCad.importAscText(text, GemCad.nullLogger), {});

  assert(reparsed.gear.fractional === true, "the reparsed design stayed marked fractional");
  assert(Math.abs(reparsed.tiers[0].facets[0].index - 12.25) < 1e-6,
    `expected the reparsed facet index to be ~12.25, got ${reparsed.tiers[0].facets[0].index}`);
});

Deno.test("designToAscText writes the G marker, so instructions starting with a number survive", () => {
  // Setup: two tiers with cutting instructions -- one ordinary ("Meet center point"), one that
  // STARTS WITH A NUMBER ("2 mm girdle"). The second is the case the `G` marker exists for:
  // `processAscLine` walks an `a` line's tokens and treats every one that parses as a number as
  // a facet index, stopping only at the first token that does not. Without a marker in front of
  // it, that leading "2" is read as a THIRTEENTH FACET rather than as the start of the text.
  // No file in reference/ has such an instruction, so the corpus round trip cannot catch this
  // (verified: deleting the marker from the writer leaves all 601 files passing) -- hence this
  // test, built by hand.
  //
  // Test: write the design, read it back, and compare instructions and facet counts.
  //
  // Verifies: both tiers' instructions come back exactly, and neither tier gained a facet. The
  // marker itself is not part of the text: the reader strips it (T-0214), as a real GemCad file
  // carries it (`... 3 n 1 G Meet center point`, Compear125.asc) and the .gem form of the same
  // design does not.
  const design = {
    gear: { teeth: 96, reversed: false, originIndex: 0, fractional: false },
    symmetry: { folds: 1, mirror: false },
    refractiveIndex: 1.54,
    tiers: [
      {
        angle: -42.5, distance: 0.6, cuttingInstructions: "Meet center point",
        facets: [{ index: 3, name: "" }, { index: 27, name: "" }],
      },
      {
        angle: -90, distance: 0.7, cuttingInstructions: "2 mm girdle",
        facets: [{ index: 12, name: "" }],
      },
    ],
    headers: [],
    footnotes: [],
  };

  const text = designToAscText(design);

  assert(text.includes(" G Meet center point"), `expected a G marker, got:\n${text}`);

  const reparsed = GemCadDesign.fromGemCad(GemCad.importAscText(text, GemCad.nullLogger), {});

  assert(reparsed.tiers[0].cuttingInstructions === "Meet center point",
    `tier 0 instructions: ${JSON.stringify(reparsed.tiers[0].cuttingInstructions)}`);
  assert(reparsed.tiers[1].cuttingInstructions === "2 mm girdle",
    `tier 1 instructions: ${JSON.stringify(reparsed.tiers[1].cuttingInstructions)}`);
  assert(reparsed.tiers[1].facets.length === 1,
    `the "2" in the instructions must not become a facet: got ${reparsed.tiers[1].facets.length}`);
});
