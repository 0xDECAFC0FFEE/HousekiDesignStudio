/*
 * index_dial_test.js -- tests for web/src/lib/index_dial.js, the ring of index-gear ticks drawn
 * round the stone when it is seen face-up or face-down (2026-09-19, the user's request).
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * WHAT IS AND IS NOT COVERED HERE
 *   The dial's geometry is worked out in the design's own frame, with no DOM and no wasm, so all
 *   of it is checked here against a real design (SRB.asc, a standard round brilliant on a
 *   96-tooth gear). Projecting it onto the canvas -- turning those points into pixels through
 *   GemApp::project_file_points, and hiding the dial once the stone is tilted away -- needs the
 *   wasm module, and is checked against the built page over CDP instead.
 */

import {
  indexDial, dialOpacity, offFaceOn, FACE_ON_DEGREES, FADE_OUT_DEGREES, DIAL_CLEARANCE,
} from "../src/lib/index_dial.js";
import { bigTickStep } from "../src/lib/index_ruler.js";

// The GemCad scripts, loaded as the page loads them: classic scripts publishing globals.
const SCRIPTS = new URL("../../js/", import.meta.url);
const SAMPLES = new URL("../../../reference/gemcad-file-reader/Samples/", import.meta.url);

for (const name of ["gemcad.js", "gemcad_obj.js", "design.js", "design_mesh.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(name, SCRIPTS)));
}

const { GemCad, GemCadDesign } = globalThis;

/*
 * reference/ is third-party data -- the vendored GemCad sample designs among it -- several hundred
 * megabytes of it, deliberately gitignored, so a fresh clone of this repository has none of it and
 * the suite still has to be green there. The three tests below that read SRB.asc are marked
 * `{ ignore: !SAMPLES_PRESENT }`, so they report as ignored on a clean checkout rather than
 * erroring on a missing file; with the data present they run exactly as before. The three that
 * build a bare gear object by hand need no files at all and are never gated.
 */
const SAMPLES_PRESENT = (() => {
  try {
    Deno.statSync(SAMPLES);
    return true;
  } catch {
    return false;
  }
})();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

function assertClose(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} +/- ${tolerance}, got ${actual}`);
}

/** SRB.asc, a standard round brilliant: a 96-tooth gear, like most GemCad designs. */
async function srb() {
  const bytes = await Deno.readFile(new URL("SRB.asc", SAMPLES));
  return GemCadDesign.fromGemCad(GemCad.importBytes(bytes), { name: "SRB.asc" });
}

/** How far a point is from the optical axis, which is what the dial's radius measures. */
const radiusOf = point => Math.hypot(point.x, point.y);

Deno.test("a tick on every tooth of the gear, numbered like the ruler's major ticks", { ignore: !SAMPLES_PRESENT }, async () => {
  // Setup: SRB.asc on its own 96-tooth gear, round a girdle of radius 1 at height 0. (The
  // girdle's real size does not matter to this test -- 1 makes the distances below readable.)
  const design = await srb();
  const teeth = design.gear.teeth;

  // Test: the whole dial.
  const dial = indexDial(design, teeth, 1, 0);

  // Verifies: one tick per tooth, in index order and covering every index 0..teeth-1 exactly
  // once; and the numbered ones are the ruler's own major ticks -- `bigTickStep(96)` is 6, so
  // 0, 6, 12 ... 90, sixteen of them, and NOT a number on all 96, which is what the user asked
  // for ("Show index values on the major ticks"). The step comes from index_ruler.js itself, so
  // this also pins that the two cannot drift apart.
  assert(teeth === 96, `SRB.asc's gear is ${teeth} teeth, not the 96 this test assumes`);
  assert(dial.ticks.length === 96, `${dial.ticks.length} ticks`);
  assert(dial.ticks.every((tick, i) => tick.index === i), "the ticks are the teeth in order");

  const step = bigTickStep(teeth);
  const numbered = dial.labels.map(label => label.index);

  assert(step === 6, `the ruler's major step for 96 teeth is ${step}`);
  assert(numbered.length === 16, `${numbered.length} numbers`);
  assert(numbered.every((index, i) => index === i * step), `numbered ${numbered}`);
  assert(dial.ticks.filter(tick => tick.big).length === 16, "sixteen major ticks");
  assert(dial.ticks.every(tick => tick.big === (tick.index % step === 0)),
    "every major tick is a multiple of the step, and no other tick is");
});

Deno.test("the ring clears the girdle by a fifth, and lies in the girdle's plane", { ignore: !SAMPLES_PRESENT }, async () => {
  // Setup: SRB.asc round a girdle of radius 4 at height 0.7 -- an off-zero height, so a dial
  // left flat at z = 0 would be caught.
  const design = await srb();
  const dial = indexDial(design, design.gear.teeth, 4, 0.7);

  // Test: where the ring, the tick tips and the numbers sit.
  // Verifies the user's sizing, "make the circle radius like 20% larger than the longest axis of
  // the girdle": the tick bases all stand on one circle of 4 * 1.2 = 4.8 (the girdle radius is
  // HALF the longest axis, since a design is cut about the optical axis, so this is a fifth of
  // clearance all the way round). Ticks point outwards from there, a major tick further than a
  // minor one, and a number sits outside its own tick. Everything is at the girdle's height, so
  // the dial lies in the girdle's plane rather than through the middle of the stone.
  assertClose(dial.radius, 4.8, 1e-12, "the ring's radius");

  for (const tick of dial.ticks) {
    assertClose(radiusOf(tick.base), 4.8, 1e-12, `tick ${tick.index} stands on the ring`);
    assert(radiusOf(tick.tip) > radiusOf(tick.base), `tick ${tick.index} points outwards`);
    assertClose(tick.base.z, 0.7, 1e-12, `tick ${tick.index} is at the girdle's height`);
    assertClose(tick.tip.z, 0.7, 1e-12, `tick ${tick.index}'s tip is level with its base`);
  }

  const major = dial.ticks.find(tick => tick.big);
  const minor = dial.ticks.find(tick => !tick.big);

  assert(radiusOf(major.tip) > radiusOf(minor.tip), "a major tick is the longer one");

  for (const label of dial.labels) {
    const tick = dial.ticks[label.index];

    assert(radiusOf(label.at) > radiusOf(tick.tip), `the number on ${label.index} clears its tick`);
    assertClose(label.at.z, 0.7, 1e-12, `the number on ${label.index} is at the girdle's height`);
  }
});

Deno.test("each tick points the way its own index does", { ignore: !SAMPLES_PRESENT }, async () => {
  // Setup: SRB.asc again. The point of the dial is that a tick marks a bearing round the stone,
  // so a facet cut at index i must come out under tick i -- including the design's own gear
  // origin and which way its wheel turns, neither of which is 0/forwards for every design.
  const design = await srb();
  const dial = indexDial(design, design.gear.teeth, 1, 0);

  // Test: compare each tick's direction against the direction a girdle facet (mast angle 90, so
  // a level normal) cut at that index faces -- the very call the stone's own planes are built
  // from, GemCadDesign.normalOf.
  for (const tick of dial.ticks) {
    const facing = GemCadDesign.normalOf(design, 90, tick.index);
    const unit = { x: tick.base.x / radiusOf(tick.base), y: tick.base.y / radiusOf(tick.base) };

    // Verifies: the two unit directions agree. Their dot product is 1 only when they point the
    // same way, and the cross product catches a tick that is a mirror image of the right one
    // (which a dot product alone would pass at 0 and 180).
    assertClose(unit.x * facing.x + unit.y * facing.y, 1, 1e-12, `tick ${tick.index} faces its index`);
    assertClose(unit.x * facing.y - unit.y * facing.x, 0, 1e-12, `tick ${tick.index} is not mirrored`);
  }

  // And, as a sanity check a reader can follow: consecutive ticks are one tooth apart, 360/96 =
  // 3.75 degrees, all the way round.
  const bearing = tick => Math.atan2(tick.base.y, tick.base.x);
  const turn = (a, b) => Math.abs(((bearing(b) - bearing(a)) * 180 / Math.PI + 540) % 360 - 180);

  for (let i = 1; i < dial.ticks.length; i++) {
    assertClose(turn(dial.ticks[i - 1], dial.ticks[i]), 360 / 96, 1e-9, `the gap before tick ${i}`);
  }
});

Deno.test("a gear of another size gets the ruler's own major step", () => {
  // Setup: the smallest design normalOf needs -- just a gear -- on 80 teeth, where the ruler's
  // rule gives a major every 5 rather than 96's 6 (the user, on the ruler: "so 80 will be 5 and
  // 96 will be 6"), and on 77, whose only divisors above 4 are 7 and 11.
  const gear = teeth => ({ gear: { teeth, reversed: false, originIndex: 0 } });

  // Test: the dials for both.
  const eighty = indexDial(gear(80), 80, 1, 0);
  const seventySeven = indexDial(gear(77), 77, 1, 0);

  // Verifies: 80 teeth are numbered every 5 (0, 5, 10 ... 75), and 77 every 7, both straight
  // from bigTickStep -- the dial never decides this for itself.
  assert(eighty.ticks.length === 80 && seventySeven.ticks.length === 77, "a tick per tooth");
  assert(eighty.labels.length === 16, `${eighty.labels.length} numbers on 80 teeth`);
  assert(eighty.labels.every((label, i) => label.index === i * 5), "80 is numbered every 5");
  assert(seventySeven.labels.every((label, i) => label.index === i * 7), "77 is numbered every 7");
});

Deno.test("full strength within 5 degrees of face-up or face-down, gone by 10", () => {
  // Setup and test: `dialOpacity` over the y rotations the stone can be at. The user asked for
  // the dial "within about 5 degrees of y=0 deg and y= 180 deg", fading "when the y rotation's
  // 5 to 10 degrees off from 0 or 180". The angle itself is whatever the orbit left in the
  // `tilt` parameter, which is never wound into a range, so negative and past-360 readings have
  // to work too -- 365 is face-up, -90 is side-on.
  const full = [0, 5, -5, 4.9, 175, 180, 185, 360, 365, -180, -355, 720];
  const gone = [10, -10, 10.1, 45, 90, 169.9, 190.1, 270, 300, -90];

  // Verifies the two ends first: full strength out to the boundary either side of face-up and
  // face-down, and nothing at all from 10 degrees out.
  assert(FACE_ON_DEGREES === 5 && FADE_OUT_DEGREES === 10,
    `the fade runs ${FACE_ON_DEGREES} to ${FADE_OUT_DEGREES} degrees`);

  for (const tilt of full) {
    assertClose(dialOpacity(tilt), 1, 0, `y = ${tilt} should be at full strength`);
  }

  for (const tilt of gone) {
    assertClose(dialOpacity(tilt), 0, 0, `y = ${tilt} should draw nothing`);
  }

  // And the fade itself: half way across at half way (7.5 degrees, either side of either pole),
  // and never anything but a fall as the stone turns away.
  for (const tilt of [7.5, -7.5, 172.5, 187.5]) {
    assertClose(dialOpacity(tilt), 0.5, 1e-12, `y = ${tilt} should be half faded`);
  }

  // Counted in tenths of a degree rather than added up in floating point, which lands a hair
  // either side of the 10-degree end and makes the last step of the walk meaningless.
  for (let tenths = FACE_ON_DEGREES * 10; tenths < FADE_OUT_DEGREES * 10 - 1; tenths++) {
    const off = tenths / 10;
    const here = dialOpacity(off);
    const next = dialOpacity((tenths + 1) / 10);

    assert(here > next, `the fade should keep falling, but ${off} gives ${here} and the next ${next}`);
    assert(here > 0 && here <= 1, `an opacity outside 0..1 at ${off}: ${here}`);
    // Measured from either pole, and from either side of it: the same angle off is the same fade.
    assertClose(dialOpacity(-off), here, 1e-12, `y = ${-off}`);
    assertClose(dialOpacity(180 + off), here, 1e-12, `y = ${180 + off}`);
    assertClose(offFaceOn(180 - off), off, 1e-12, `how far ${180 - off} is off face-on`);
  }
});

Deno.test("nothing is drawn without a design, a gear or a stone with width", () => {
  // Setup: the ways there is no dial to draw. A plain .obj has no faceting design at all (no
  // gear, so no indexes); a stone the mesh measurements could not size gives a null radius.
  const gear = { gear: { teeth: 96, reversed: false, originIndex: 0 } };

  // Test and verifies: each returns null rather than an empty dial or a throw, so the overlay
  // simply draws nothing. The clearance is checked here too, as the one number a reader of this
  // file is most likely to want to change.
  assert(indexDial(null, 96, 1, 0) === null, "no design");
  assert(indexDial(gear, 0, 1, 0) === null, "no teeth");
  assert(indexDial(gear, 96, null, 0) === null, "no measured girdle");
  assert(indexDial(gear, 96, 0, 0) === null, "a stone with no width");
  assertClose(DIAL_CLEARANCE, 1.2, 1e-12, "the ring is a fifth wider than the girdle");
});
