/*
 * export_gem_test.js -- tests for web/src/lib/export_gem.js, the GemCad BINARY .gem WRITER
 * (T-0207).
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The important property, per the user's own request (the same discipline export_asc_test.js's
 * own header comment describes for the sibling .asc ticket, T-0206), is a ROUND TRIP, not just
 * "the writer produces bytes that parse": open one of the four bundled sample designs
 * (reference/gemcad-file-reader/Samples/*.gem), turn it into a design the same way the page does
 * (GemCad.importGemBytes -> GemCadDesign.fromGemCad), write THAT design back out with
 * designToGemBytes, re-open the bytes this writer just produced the very same way, and check
 * that the two designs agree -- same gear, same tier count, and every tier's angle, distance and
 * facet index list line up, within design.js's OWN tolerance constants (INDEX_SNAP_TOLERANCE),
 * not an invented one. "Line up" does not mean byte-identical to what real GemCad software would
 * write -- not achievable without the real application to compare against on this machine (see
 * kb/gemcad-gem-binary-writer-t-0207.md) -- it means the two DESIGNS this project's own reader
 * recovers from each set of bytes agree.
 *
 * gemcad.js, design.js and design_mesh.js are classic browser scripts (no ES module syntax --
 * see their own file comments), published as globalThis.GemCad / globalThis.GemCadDesign /
 * globalThis.DesignMesh, so they are loaded here the same way comments_test.js loads
 * edit_history.js and export_asc_test.js loads gemcad.js/design.js: read each file's text and
 * eval it. design_mesh.js also needs gemcad_obj.js (globalThis.GemCadObj) loaded first --
 * design_mesh.js's own file comment says as much ("Depends on GemCadDesign (design.js) and
 * GemCadObj (gemcad_obj.js), both already loaded earlier in the same bundle") -- so the load
 * order here is gemcad.js, gemcad_obj.js, design.js, design_mesh.js: every dependency loaded
 * before anything that reads it off `globalThis`.
 */

import { designToGemBytes } from "../src/lib/export_gem.js";

(0, eval)(await Deno.readTextFile(new URL("../../js/gemcad.js", import.meta.url)));
(0, eval)(await Deno.readTextFile(new URL("../../js/gemcad_obj.js", import.meta.url)));
(0, eval)(await Deno.readTextFile(new URL("../../js/design.js", import.meta.url)));
(0, eval)(await Deno.readTextFile(new URL("../../js/design_mesh.js", import.meta.url)));

const { GemCad, GemCadDesign } = globalThis;

// design.js's own gate for "close enough to the tooth it was recovered from to snap to it", read
// off the library rather than invented here (the ticket's own instruction: do not invent a new
// tolerance). Measured in TEETH, not degrees -- see design.js's own comment on
// INDEX_SNAP_TOLERANCE for why (a meet-point solver's nudge, or this representation's own
// re-expression arithmetic, both bounded in tooth units, not angular ones).
const INDEX_SNAP_TOLERANCE = GemCadDesign.tolerances.indexSnap;

/**
 * The four bundled sample designs live under reference/gemcad-file-reader/Samples/ (vendored,
 * MIT, see kb/clean-room-and-licensing-constraints.md). The ticket asks for at least 2 of the 4;
 * all four are round-tripped here since the cost of the extra two is the same few lines, and
 * more coverage is strictly better evidence for a from-scratch binary writer.
 */
const SAMPLE_NAMES = ["Compear125", "SRB", "Turkey", "CubeIllusionTri"];

function sampleUrl(name) {
  return new URL(`../../../reference/gemcad-file-reader/Samples/${name}.gem`, import.meta.url);
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
 * Round-trips one sample file through the writer and returns both designs (plus the exported
 * bytes), so a test can both assert on the designs and print the actual measured disagreement --
 * the numbers this ticket's close note is supposed to report.
 */
function roundTrip(name) {
  const originalBytes = Deno.readFileSync(sampleUrl(name));

  // Step 1-2: the ORIGINAL file, parsed and turned into a design exactly as the page's own load
  // path does (design_load.js's objTextFromBytes, the .gem branch).
  const parsed1 = GemCad.importGemBytes(originalBytes, GemCad.nullLogger);
  const design1 = GemCadDesign.fromGemCad(parsed1, { name });

  // Step 3: this ticket's writer, turning that design back into .gem bytes -- the geometry
  // (each facet's own normal and corner points) computed fresh from the design's own planes via
  // DesignMesh.buildFaces, exactly as the rendered stone is (kb/building-the-stone-mesh-from-a-
  // design-s-own-face.md), not copied from the original file's bytes.
  const written = designToGemBytes(design1, { title: name });

  // Step 4-5: the bytes THIS WRITER JUST PRODUCED, parsed and turned into a design the same way.
  const parsed2 = GemCad.importGemBytes(written, GemCad.nullLogger);
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

Deno.test("designToGemBytes round-trips all four bundled sample designs (open -> design -> write -> reopen -> design)", { ignore: !SAMPLES_PRESENT }, () => {
  // Setup: each of the four bundled GemCad sample .gem files -- Compear125, SRB, Turkey and
  // CubeIllusionTri -- read, parsed into a design, written back out by this ticket's writer as
  // binary bytes, and re-parsed into a second design (roundTrip, above). None of the four is a
  // fractional design and every tier angle is exact at 2 decimals
  // (kb/the-polar-internal-representation.md: "the four sample designs do not exercise the angle
  // rounding"), so this is the writer's ordinary case.
  //
  // Test: for every sample, compare design1 (straight from the original file) against design2
  // (from this writer's own output) on exactly what the ticket's acceptance criteria ask for:
  // the gear (teeth, reversed, fractional), the tier count, and, tier by tier, the angle, the
  // distance and the facet index list.
  //
  // Verifies: the writer is a faithful inverse of the reader for real GemCad files, not merely
  // "produces bytes that parse". The worst disagreement measured across all four samples is
  // printed at the end (Deno.test does not fail on stray console output), which is the number
  // this ticket's close note reports.
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

    // The tier count: one tier-number group per design tier, written and read back in the same
    // order -- see export_gem.js's own comment on why file tier numbers start at 1, not 0.
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
      // 1e-6 is nowhere near float noise). Unlike export_asc.js's own writer (a direct field
      // transcription), this writer computes geometry from scratch via plane intersection and
      // the READER then re-derives angle/distance from THAT geometry, so a little numerical
      // noise beyond pure double round-trip is expected -- but still many orders of magnitude
      // under NORMAL_AGREEMENT_TOLERANCE (1e-2 degrees), which is the gate that would actually
      // matter if this writer were producing wrong geometry rather than merely re-deriving it
      // through one extra plane-intersection step.
      assert(angleDiff < 1e-6,
        `${name} tier ${t}: angle ${tier1.angle} vs ${tier2.angle} (off by ${angleDiff})`);
      assert(distanceDiff < 1e-6,
        `${name} tier ${t}: distance ${tier1.distance} vs ${tier2.distance} (off by ${distanceDiff})`);

      // The facet index list: same length, same order (a tier's facets are grouped and written
      // in design.tiers[].facets' own order -- see facesByTier's own comment in export_gem.js),
      // and each index within design.js's own INDEX_SNAP_TOLERANCE (measured in teeth) of the
      // original.
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
    `export_gem round trip, worst across ${SAMPLE_NAMES.join(", ")}: ` +
    `angle ${worstAngle.toExponential(3)} degrees, distance ${worstDistance.toExponential(3)} ` +
    `model units, index ${worstIndex.toExponential(3)} of a tooth ` +
    `(gate ${INDEX_SNAP_TOLERANCE.toExponential(3)}).`
  );
});

Deno.test("designToGemBytes writes a gear's sign correctly: reversed design.gear becomes a negative file gear, and back", () => {
  // Setup: two minimal CLOSED designs (a flat table, a 4-facet girdle ring, and a flat culet --
  // the smallest shape whose facet planes actually bound a finite solid; a single lone facet
  // plane does not, since DesignMesh.buildFaces's own boundary-resolution check requires every
  // face edge to lie on some OTHER plane, which a one-plane design has none of -- confirmed
  // directly: it throws "design may not be closed" rather than building anything), identical
  // except for `gear.reversed` -- the exact scenario T-0088/T-0170/T-0171 warn about: design.js
  // stores a magnitude PLUS a `reversed` flag, the OPPOSITE of the file's own convention (a
  // negative gear count IN the file means the wheel runs the other way). Getting the sign
  // translation backwards here would silently turn every reversed design into a forward one on
  // export -- exactly the bug T-0088 fixed on the READ side, mirrored onto the WRITE side.
  //
  // Test: designToGemBytes each design, then GemCad.importGemBytes + GemCadDesign.fromGemCad the
  // bytes back and check the reopened design's OWN `gear.reversed` flag.
  //
  // Verifies: export_gem.js's gear-sign translation (`design.gear.reversed ? -teeth : teeth`)
  // matches export_asc.js's own `signedTeeth`, and going all the way round confirms the reader
  // recovers the SAME flag that was written, not its logical negation.
  const forward = {
    gear: { teeth: 96, reversed: false, originIndex: 0, fractional: false },
    symmetry: { folds: 1, mirror: false },
    refractiveIndex: 1.54,
    tiers: [
      { angle: 0, distance: 1.0, cuttingInstructions: "", facets: [{ index: 0, name: "T" }] },
      {
        angle: -45, distance: 1.3, cuttingInstructions: "",
        facets: [
          { index: 0, name: "G1" }, { index: 24, name: "G2" },
          { index: 48, name: "G3" }, { index: 72, name: "G4" },
        ],
      },
      { angle: 180, distance: 1.0, cuttingInstructions: "", facets: [{ index: 0, name: "C" }] },
    ],
    headers: [],
    footnotes: [],
  };
  const reversed = { ...forward, gear: { ...forward.gear, reversed: true } };

  const forwardBytes = designToGemBytes(forward);
  const reversedBytes = designToGemBytes(reversed);

  const forwardBack = GemCadDesign.fromGemCad(
    GemCad.importGemBytes(forwardBytes, GemCad.nullLogger), {});
  const reversedBack = GemCadDesign.fromGemCad(
    GemCad.importGemBytes(reversedBytes, GemCad.nullLogger), {});

  assert(forwardBack.gear.reversed === false, "forward design stayed forward");
  assert(reversedBack.gear.reversed === true, "reversed design stayed reversed");
  assert(forwardBack.gear.teeth === 96 && reversedBack.gear.teeth === 96,
    "the tooth count itself (a magnitude, never signed) survived both ways");
});

Deno.test("designToGemBytes: a multi-tier design with a fractional facet round-trips its fractional index", () => {
  // Setup: a small synthetic design shaped like a real cut -- a flat table, a girdle ring of
  // four facets, and a flat culet (pavilion pole) -- so DesignMesh.buildFaces has enough
  // mutually-closing planes to build a genuine closed polytope (unlike the single-plane designs
  // above, which only work because a lone plane's clip never removes anything). One girdle facet
  // sits a genuine 0.25 of a tooth off the grid -- comfortably outside INDEX_SNAP_TOLERANCE (5e-3
  // of a tooth), so `fromGemCad` marks it fractional (T-0171's fractional-teeth feature) rather
  // than snapping it to a neighbour. None of the four bundled samples has a fractional facet
  // (kb/the-polar-internal-representation.md), so this is built by hand rather than sourced from
  // one, matching export_asc_test.js's own equivalent synthetic test.
  //
  // Test: designToGemBytes, then GemCad.importGemBytes + GemCadDesign.fromGemCad the bytes back.
  //
  // Verifies: a fractional index survives the ADDITIONAL indirection this format's writer goes
  // through that export_asc.js's does not -- the index is recovered from GEOMETRY
  // (GemCadDesign.polarOf on the facet's own stored normal), not read back as a literal decimal
  // token the way a `.asc` `a` line's index is -- so this is the sharper test of the two formats'
  // writers for this particular property. The on-axis table and culet facets (index 0 by
  // convention, see design.js's own `polarOf`) are also checked, since a `.gem`'s on-axis
  // sentinel handling (T-0170) is exercised by this design's shape.
  const design = {
    gear: { teeth: 96, reversed: false, originIndex: 0, fractional: true },
    symmetry: { folds: 1, mirror: false },
    refractiveIndex: 1.54,
    tiers: [
      { angle: 0, distance: 1.0, cuttingInstructions: "", facets: [{ index: 0, name: "T" }] },
      {
        angle: -45, distance: 1.3, cuttingInstructions: "",
        facets: [
          { index: 0, name: "G1" },
          { index: 24.25, name: "G2" }, // 0.25 of a tooth off the grid, deliberately.
          { index: 48, name: "G3" },
          { index: 72, name: "G4" },
        ],
      },
      { angle: 180, distance: 1.0, cuttingInstructions: "", facets: [{ index: 0, name: "C" }] },
    ],
    headers: ["Synthetic fractional test design"],
    footnotes: ["A footnote, to exercise the header/footnote boundary too."],
  };

  const bytes = designToGemBytes(design, { title: "Fractional Test" });
  const reopened = GemCadDesign.fromGemCad(
    GemCad.importGemBytes(bytes, GemCad.nullLogger), { name: "Fractional Test" });

  assert(reopened.gear.fractional === true,
    "the reopened design stayed marked fractional");
  assert(reopened.tiers.length === 3,
    `expected 3 tiers, got ${reopened.tiers.length}`);
  assert(reopened.tiers[0].facets.length === 1 && reopened.tiers[0].facets[0].index === 0,
    "the table facet stayed at index 0");
  assert(reopened.tiers[2].facets.length === 1 && reopened.tiers[2].facets[0].index === 0,
    "the culet facet stayed at index 0 (canonicalised, not a mirrored sentinel)");

  const girdle = reopened.tiers[1];

  assert(girdle.facets.length === 4,
    `expected 4 girdle facets, got ${girdle.facets.length}`);

  const fractionalFacet = girdle.facets.find(f => Math.abs(f.index - 24.25) < 1);

  assert(fractionalFacet !== undefined,
    `no girdle facet landed near index 24.25; got [${girdle.facets.map(f => f.index)}]`);
  assert(Math.abs(fractionalFacet.index - 24.25) < 1e-6,
    `expected the fractional facet's index to be ~24.25, got ${fractionalFacet.index}`);

  // The angle also has to survive: an off-axis tier's angle round-trips through
  // calculateTierDefinitions' own 2-decimal rounding (see export_gem.js's header comment on
  // NORMAL_AGREEMENT_TOLERANCE), which is a no-op here since -45 is already exact at 2 decimals.
  assert(Math.abs(girdle.angle - (-45)) < 1e-6,
    `expected the girdle tier's angle to stay -45, got ${girdle.angle}`);
});
