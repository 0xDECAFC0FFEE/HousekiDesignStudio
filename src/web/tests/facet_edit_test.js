/*
 * facet_edit_test.js -- tests for web/src/lib/facet_edit.js, what edit mode's angle and depth
 * sliders read and write (2026-09-19) and the ticks their tape ruler draws.
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The sliders themselves (dragging one and watching the stone change) are exercised against the
 * built page over CDP, since they need a browser and the wasm module.
 */

import {
  isPavilionSide, angleValue, angleFor, depthRange, clampValue, snapValue, visibleValueTicks,
  ANGLE_STEP, DEPTH_STEP,
} from "../src/lib/facet_edit.js";

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

Deno.test("the angle slider shows a positive angle and writes the tier's own side back", () => {
  // Setup: one tier of each kind the design can hold -- a crown tier, the table, a pavilion
  // tier, a girdle at either sign, and a flat culet (stored as 180).
  // Test: angleValue for what the slider shows, then angleFor to store a reading back.
  // Verifies: the slider always shows the positive angle the cutting instructions show (a culet
  // reads 0); storing keeps the tier on its own side, so dragging a pavilion tier writes a
  // negative angle and never flips it into the crown; and a pavilion tier dragged to 0 becomes
  // the flat culet GemCad writes as 180, not -0, which no file can carry.
  assertEqual(angleValue({ angle: 34 }), 34, "a crown tier");
  assertEqual(angleValue({ angle: 0 }), 0, "the table");
  assertEqual(angleValue({ angle: -42.5 }), 42.5, "a pavilion tier");
  assertEqual(angleValue({ angle: -90 }), 90, "a girdle");
  assertEqual(angleValue({ angle: 180 }), 0, "a culet");

  assertEqual(angleFor({ angle: 34 }, 41.25), 41.25, "a crown tier stays positive");
  assertEqual(angleFor({ angle: 0 }, 12), 12, "the table moves into the crown");
  assertEqual(angleFor({ angle: -42.5 }, 41.25), -41.25, "a pavilion tier stays negative");
  assertEqual(angleFor({ angle: -42.5 }, 0), 180, "a pavilion tier flattened to a culet");
  assertEqual(angleFor({ angle: 180 }, 30), -30, "a culet opened out into a pavilion tier");

  assertEqual([isPavilionSide({ angle: -1 }), isPavilionSide({ angle: 180 }),
    isPavilionSide({ angle: 1 }), isPavilionSide({ angle: 0 })], [true, true, false, false], "sides");
});

Deno.test("the depth slider reaches past the design's deepest facet", () => {
  // Setup: a design whose deepest tier sits at 1.02, and a shallow one whose facets are all well
  // inside 1.
  // Test: depthRange.
  // Verifies: the scale starts at the stone's centre and runs half again past the deepest facet
  // (1.02 -> 1.6, rounded up to a tenth so the labels are round), with a floor of 1.5 so even a
  // small stone leaves room to cut a facet shallower than any it has.
  assertEqual(depthRange({ tiers: [{ distance: 0.5 }, { distance: 1.02 }] }), { min: 0, max: 1.6 }, "deepest 1.02");
  assertEqual(depthRange({ tiers: [{ distance: 0.4 }] }), { min: 0, max: 1.5 }, "a shallow design");
});

Deno.test("values are clamped to the scale and snapped to the step", () => {
  // Setup: the angle scale (0 to 90, hundredths of a degree) and the depth step (thousandths).
  // Test: clampValue and snapValue.
  // Verifies: a drag past either end stops at it; a reading is snapped to the step and comes
  // back clean, so 42.500000000000004 is stored as 42.5 -- the two decimals a GemCad file
  // carries -- rather than as float dust that would show in the cutting instructions.
  assertEqual(clampValue(-3, 0, 90), 0, "below the scale");
  assertEqual(clampValue(112, 0, 90), 90, "above it");
  assertEqual(snapValue(42.500000000000004, ANGLE_STEP), 42.5, "float dust");
  assertEqual(snapValue(42.4973, ANGLE_STEP), 42.5, "to the nearest hundredth");
  assertEqual(snapValue(0.8123456, DEPTH_STEP), 0.812, "a depth to the nearest thousandth");
});

Deno.test("the tape draws every tick in view, inside the scale, and marks the labelled ones", () => {
  // Setup: an angle tape at 41.25 degrees showing 2.5 degrees either side, ticks every degree
  // and a label every 10; then the same tape at the very bottom of the scale.
  // Test: visibleValueTicks.
  // Verifies: it gives 39, 40, 41, 42 and 43, each with its distance from the centre in degrees
  // (what the drawing turns into pixels), and marks 40 as the labelled one; and that at 0.8 of a
  // degree it stops at 0 rather than drawing ticks off the end of the scale.
  assertEqual(
    visibleValueTicks(41.25, 2.5, 1, 10, 0, 90).map(t => [t.value, Number(t.offset.toFixed(2)), t.major]),
    [[39, -2.25, false], [40, -1.25, true], [41, -0.25, false], [42, 0.75, false], [43, 1.75, false]],
    "mid scale",
  );
  assertEqual(
    visibleValueTicks(0.8, 2.5, 1, 10, 0, 90).map(t => t.value),
    [0, 1, 2, 3],
    "at the bottom of the scale",
  );
});
