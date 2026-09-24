/*
 * scale_height_test.js -- tests for scale height mode (T-0231, 2026-09-23): the tangent-ratio
 * math in web/src/lib/scale_height.js, and the mode around it in scale_height_mode.js.
 *
 * The user's rule under test: "if our crown tangent ratio given by the gauge is tr, all crown
 * facet angles should be updated to InvTan(Tan(OldAngle) * tr). same thing with pavilion." Beyond
 * the angles, each facet's DISTANCE is moved with the same stretch along the optical axis, so the
 * result is the same stone made taller or flatter with every meet kept (see the head of
 * scale_height.js for why, and for why each half is pinned to its own girdle edge rather than to
 * z = 0). The geometric tests below check that claim directly: take points of the old stone, apply
 * the stretch, and they must be points of the new one.
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The panel itself -- the two gauges, Reset (T-0235), the lock switch, Done and Cancel, and Undo and
 * Redo acting on the mode's own stack -- is checked against the built page over CDP, since it needs
 * a browser and the wasm module. So is the turn to the side profile on opening and back on closing:
 * here there is no renderer (`engine.app` is null), and the mode leaves the view alone.
 *
 * `window` is stubbed because the mode asks the page for a redraw (`window.gemRequestRender?.()`)
 * and Deno has no such global. ES modules hoist their imports, so this actually runs after the
 * modules below are evaluated -- which is soon enough, since none of them touches `window` at
 * import time.
 */

globalThis.window = globalThis.window ?? {};

import { get } from "svelte/store";
import {
  RATIO_MIN, RATIO_MAX, RATIO_STEP, RATIO_TICK, RATIO_MAJOR_EVERY, RATIO_PX_PER_UNIT, INITIAL_GAUGES,
  moveGauge, setGaugeLock, sameGauges, createGaugeHistory, gaugeOf, scaledTier, heightPivots,
  scaledValues, resetGauges, gaugesAtOne,
} from "../src/lib/scale_height.js";
import { visibleValueTicks } from "../src/lib/facet_edit.js";
import {
  enterScaleHeightMode, exitScaleHeightMode, cancelScaleHeightMode, changeGauge, changeLock,
  resetScaleGauges, scaleHeightOpen, scaleGauges,
} from "../src/lib/scale_height_mode.js";
import { enterEditMode, exitEditMode, editing } from "../src/lib/edit_mode.js";
import {
  render, toolbar, highlightTier, applyReorder, sectionOrder, setEditRecorder, setHistoryFrames,
  applyEdit,
} from "../src/lib/tier_controller.js";
import { undo, redo } from "../src/lib/session.js";
import { canUndo, canRedo } from "../src/lib/stores.js";

// The GemCad scripts, loaded as the page loads them: classic scripts publishing globals, in the
// order make_page.py's bundle runs them. `design.js` gives the planes (GemCadDesign.normalOf),
// `design_mesh.js` builds a stone from them, `gcs.js` reads the startup stone, and
// `edit_history.js` is the history Done records into.
for (const script of ["edit_history.js", "gemcad.js", "gemcad_obj.js", "design.js", "design_mesh.js", "gcs.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${script}`, import.meta.url)));
}

const { GemCadDesign, GemCutStudio, DesignMesh, EditHistory } = globalThis;

/** The startup stone, committed under src/resources, so this is present on a fresh clone. */
const STARTUP_URL = new URL("../../resources/hex_cut_v2.gcs", import.meta.url);

async function startupDesign() {
  const { parsed } = GemCutStudio.importText(await Deno.readTextFile(STARTUP_URL));

  return GemCadDesign.fromGemCad(parsed, { name: "hex_cut_v2.gcs" });
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message}: expected ${expected} within ${tolerance}, got ${actual}`);
  }
}

const DEGREES = Math.PI / 180;

/** The user's formula, written out as plainly as they wrote it, in degrees. */
function userFormula(angle, ratio) {
  return Math.atan(Math.tan(angle * DEGREES) * ratio) / DEGREES;
}

/** A design shell `GemCadDesign.normalOf` can read: a 96-tooth gear, origin at tooth 0. */
function gearOnly() {
  return { gear: { teeth: 96, reversed: false, originIndex: 0 } };
}

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

// ---- the angle formula

Deno.test("crown and pavilion angles follow atan(tan(angle) x ratio)", () => {
  // Setup: crown tiers from shallow to steep, and pavilion tiers stored as GemCad stores them
  // (negative), each with an arbitrary distance and pivot.
  // Test: scaledTier at ratios either side of 1, the two ends of the gauges included.
  // Verifies: the new angle is exactly the user's formula on the angle the cutting instructions
  // show -- the crown's as stored, the pavilion's as its positive tilt -- and a pavilion tier stays
  // negative, so it never jumps into the crown's table. The distance is not checked here; the
  // geometric tests below do that.
  for (const ratio of [RATIO_MIN, 0.5, 0.8, 1.2, 2, RATIO_MAX]) {
    for (const angle of [5, 23.5, 34, 41.25, 60, 85]) {
      const crown = scaledTier({ angle, distance: 0.9 }, ratio, 0.1);
      const pavilion = scaledTier({ angle: -angle, distance: 0.9 }, ratio, -0.05);

      assertClose(crown.angle, userFormula(angle, ratio), 1e-12, `crown ${angle} at ${ratio}`);
      assertClose(pavilion.angle, -userFormula(angle, ratio), 1e-12, `pavilion ${-angle} at ${ratio}`);
    }
  }

  // A worked example a cutter could check on a calculator: a 40-degree pavilion main made 1.2x
  // deeper comes out at atan(tan 40 x 1.2) = 45.20 degrees; a 35-degree crown main made 0.8x as
  // tall at atan(tan 35 x 0.8) = 29.26 degrees.
  assertClose(scaledTier({ angle: -40, distance: 1 }, 1.2, 0).angle, -45.1975, 1e-4, "pavilion 40 x 1.2");
  assertClose(scaledTier({ angle: 35, distance: 1 }, 0.8, 0).angle, 29.2561, 1e-4, "crown 35 x 0.8");
});

Deno.test("the girdle, the table and a flat culet keep their angles exactly", () => {
  // Setup: the four tiers whose angle the formula cannot (or must not) move: a girdle written
  // either sign (GemCad writes -90; a .gcs can convert to +90), the table (0), and a flat culet
  // (stored as 180, design.js's marker for "points straight down").
  // Test: scaledTier at a ratio well away from 1.
  // Verifies: all four angles come back bit for bit. For the girdle this is the tan(90) guard:
  // tan(90 degrees) is not finite, and cos(90 degrees) in floating point is 6e-17 rather than 0, so
  // the general formula would tip a -90 girdle over to about +89.99999 -- into the crown. The
  // girdle's distance is kept too, since a vertical plane is untouched by a stretch along the axis.
  assertEqual(scaledTier({ angle: -90, distance: 1 }, 2.5, 0.3), { angle: -90, distance: 1 }, "girdle -90");
  assertEqual(scaledTier({ angle: 90, distance: 1 }, 0.4, 0.3), { angle: 90, distance: 1 }, "girdle +90");
  assertEqual(scaledTier({ angle: 0, distance: 0.7 }, 1.5, 0.2).angle, 0, "table");
  assertEqual(scaledTier({ angle: 180, distance: 0.7 }, 1.5, -0.2).angle, 180, "culet");
});

Deno.test("a ratio of 1 changes nothing, bit for bit", () => {
  // Setup: tiers of every kind, with angles and distances that do not survive a tan/atan round
  // trip exactly.
  // Test: scaledTier at ratio 1, with a non-zero pivot.
  // Verifies: the very values given come back. Both gauges start at 1x each time the mode opens,
  // and a design that came back an ulp off would read as an edit on Done.
  for (const angle of [0, 33.333333, -41.123456789, -90, 90, 180, 72.5]) {
    const tier = { angle, distance: 0.123456789 };

    assertEqual(scaledTier(tier, 1, 0.37), tier, `angle ${angle}`);
  }
});

// ---- the distances: a true stretch along the axis

Deno.test("every point of an old facet lands on the new facet after the stretch", () => {
  // Setup: one tier of each kind that moves -- a crown tier, the table, a pavilion tier, a flat
  // culet -- each at two index positions, with a pivot away from z = 0 for each half, as real
  // designs have (the girdle is rarely at z = 0; see the head of scale_height.js).
  // Test: for each facet, take points on its old plane, apply the stretch about the half's pivot
  // (z -> pivot + ratio (z - pivot)), and measure them against the NEW plane that scaledTier gave.
  // Verifies: they lie on it (to float precision). That is what "a true height scale" means: the
  // new plane is the old plane stretched, not merely a plane at the new angle, so every meet
  // point of the old stone is a meet point of the new one.
  const design = gearOnly();
  const cases = [
    { angle: 38.5, distance: 0.8, ratio: 0.8, pivot: 0.12 },
    { angle: 0, distance: 0.55, ratio: 1.7, pivot: 0.12 },
    { angle: -41, distance: 0.95, ratio: 1.2, pivot: 0.05 },
    { angle: 180, distance: 0.9, ratio: 0.6, pivot: 0.05 },
  ];

  for (const { angle, distance, ratio, pivot } of cases) {
    const scaled = scaledTier({ angle, distance }, ratio, pivot);

    for (const index of [0, 37]) {
      const oldNormal = GemCadDesign.normalOf(design, angle, index);
      const newNormal = GemCadDesign.normalOf(design, scaled.angle, index);
      // Two directions within the old plane, so the points are spread over it.
      const helper = Math.abs(oldNormal.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
      const u = {
        x: oldNormal.y * helper.z - oldNormal.z * helper.y,
        y: oldNormal.z * helper.x - oldNormal.x * helper.z,
        z: oldNormal.x * helper.y - oldNormal.y * helper.x,
      };

      for (const [s, t] of [[0, 0], [0.3, 0], [-0.4, 0.2], [0.1, -0.5]]) {
        const onOld = {
          x: oldNormal.x * distance + u.x * s + helper.x * t - oldNormal.x * dot(oldNormal, helper) * t,
          y: oldNormal.y * distance + u.y * s + helper.y * t - oldNormal.y * dot(oldNormal, helper) * t,
          z: oldNormal.z * distance + u.z * s + helper.z * t - oldNormal.z * dot(oldNormal, helper) * t,
        };
        const stretched = { x: onOld.x, y: onOld.y, z: pivot + ratio * (onOld.z - pivot) };

        assertClose(dot(oldNormal, onOld), distance, 1e-12, `point on the old plane (${angle})`);
        assertClose(dot(newNormal, stretched), scaled.distance, 1e-12,
          `stretched point on the new plane (angle ${angle}, index ${index}, ratio ${ratio})`);
      }
    }
  }
});

Deno.test("the startup stone stretched keeps its girdle and every meet", async () => {
  // Setup: src/resources/hex_cut_v2.gcs, the page's own startup stone (ten tiers: two pavilion,
  // one girdle, six crown, the table), and the stone DesignMesh builds from it.
  // Test: heightPivots on it; then scaledValues with the pavilion at 1.2 and the crown at 0.8,
  // written onto a copy of the design, and the stone built again.
  // Verifies:
  //   * the crown's pivot is at or above the pavilion's (this stone's two halves do not overlap),
  //     and both lie within the girdle band;
  //   * every corner of the new stone is a corner of the old one stretched -- crown corners about
  //     the crown's pivot by 0.8, pavilion corners about the pavilion's by 1.2, girdle-band corners
  //     between the two not moved at all -- so the girdle's outline and thickness are exactly as
  //     they were and the table is the same size;
  //   * the stone got flatter above and deeper below by exactly those ratios.
  const design = await startupDesign();
  const before = DesignMesh.buildFaces(design);
  const pivots = heightPivots(design, before);

  assertEqual(pivots.overlap, false, "the startup stone's halves do not overlap in height");

  if (!(pivots.crown >= pivots.pavilion)) {
    throw new Error(`crown pivot ${pivots.crown} is below the pavilion's ${pivots.pavilion}`);
  }

  const pristine = design.tiers.map(tier => ({ tier, angle: tier.angle, distance: tier.distance }));
  const ratios = { pavilion: 1.2, crown: 0.8 };
  const values = scaledValues(pristine, ratios, pivots);
  const scaled = GemCadDesign.fromJSON(GemCadDesign.toJSON(design));

  values.forEach(({ angle, distance }, t) => {
    scaled.tiers[t].angle = angle;
    scaled.tiers[t].distance = distance;
  });

  const after = DesignMesh.buildFaces(scaled);
  const stretch = z => (z > pivots.crown ? pivots.crown + ratios.crown * (z - pivots.crown)
    : z < pivots.pavilion ? pivots.pavilion + ratios.pavilion * (z - pivots.pavilion) : z);
  const oldCorners = before.faces.flatMap(face => face.polygon).map(p => ({ ...p, z: stretch(p.z) }));
  const newCorners = after.faces.flatMap(face => face.polygon);

  for (const corner of newCorners) {
    const nearest = Math.min(...oldCorners.map(p => Math.hypot(p.x - corner.x, p.y - corner.y, p.z - corner.z)));

    assertClose(nearest, 0, 1e-6, `new corner ${JSON.stringify(corner)} is an old corner stretched`);
  }

  const heights = faces => {
    const zs = faces.flatMap(face => face.polygon).map(p => p.z);

    return { top: Math.max(...zs), bottom: Math.min(...zs) };
  };

  assertClose(heights(after.faces).top - pivots.crown, 0.8 * (heights(before.faces).top - pivots.crown), 1e-9,
    "the crown is 0.8x as tall above its girdle edge");
  assertClose(pivots.pavilion - heights(after.faces).bottom, 1.2 * (pivots.pavilion - heights(before.faces).bottom), 1e-9,
    "the pavilion is 1.2x as deep below its girdle edge");

  // The girdle and the table, the two tiers the brief says stay put: their angles are untouched
  // (the table's distance does move -- it rides up or down with the crown, which is what keeps
  // its size; checked just above as the crown's top).
  values.forEach(({ tier, angle, distance }) => {
    if (gaugeOf(tier) === null) {
      assertEqual([angle, distance], [tier.angle, tier.distance], "the girdle is untouched");
    } else if (tier.angle === 0) {
      assertEqual(angle, 0, "the table stays flat");
    }
  });
});

Deno.test("each half is pinned to its own girdle edge, or to the middle of an overlap", () => {
  // Setup: hand-made "stones" as DesignMesh.buildFaces returns them (faces naming their tier, each
  // with a polygon), over a design of one crown tier, one girdle and one pavilion tier.
  // Test: heightPivots on a stone whose crown starts above its pavilion's top, on one where they
  // overlap in height, and on one with the crown's faces missing altogether.
  // Verifies: normally the crown is pinned to its LOWEST corner and the pavilion to its HIGHEST
  // (the girdle's corners in between are ignored: a vertical plane does not care); when the two
  // overlap, both are pinned to the middle of the overlap; and a half with no corners takes the
  // other's, rather than leaving an Infinity to reach the formula.
  const design = { tiers: [{ angle: 35 }, { angle: -90 }, { angle: -41 }] };
  const face = (tier, zs) => ({ tier, polygon: zs.map(z => ({ x: 0, y: 0, z })) });

  assertEqual(heightPivots(design, { faces: [face(0, [0.3, 0.5]), face(1, [0.1, 0.3, 0.2]), face(2, [0.1, -0.6])] }),
    { crown: 0.3, pavilion: 0.1, overlap: false }, "a girdle between the halves");
  const overlapping = heightPivots(design, { faces: [face(0, [0.2, 0.5]), face(2, [0.4, -0.6])] });

  assertEqual(overlapping.overlap, true, "overlapping halves are reported");
  assertClose(overlapping.crown, 0.3, 1e-12, "the crown pinned to the middle of the overlap");
  assertClose(overlapping.pavilion, 0.3, 1e-12, "and the pavilion to the same plane");
  assertEqual(heightPivots(design, { faces: [face(2, [0.1, -0.6])] }),
    { crown: 0.1, pavilion: 0.1, overlap: false }, "no crown corners at all");
});

Deno.test("every setting is computed from the snapshot, never from the last one", () => {
  // Setup: a pristine snapshot of three tiers and pivots.
  // Test: compute a far-off setting (4x, 0.25x), then compute 1.2x/0.8x -- once directly, and once
  // after the far-off one, as a drag that went there and came back would.
  // Verifies: the two agree exactly, and 1x/1x gives the snapshot back, girdle included. Stepping
  // from the previous result instead would compound (1.2 of 4x of the original) and drift.
  const pristine = [
    { tier: 'c', angle: 36, distance: 0.9 },
    { tier: 'g', angle: -90, distance: 1 },
    { tier: 'p', angle: -42, distance: 0.95 },
  ];
  const pivots = { crown: 0.1, pavilion: 0.05 };

  scaledValues(pristine, { pavilion: 4, crown: 0.25 }, pivots);

  const direct = scaledValues(pristine, { pavilion: 1.2, crown: 0.8 }, pivots);
  const again = scaledValues(pristine, { pavilion: 1.2, crown: 0.8 }, pivots);

  assertEqual(again, direct, "the same ratios give the same values whatever came before");
  assertEqual(scaledValues(pristine, { pavilion: 1, crown: 1 }, pivots), pristine, "1x/1x is the snapshot");
  assertEqual(direct.map(value => value.tier), ['c', 'g', 'p'], "tiers come back in order");
});

// ---- the gauges, the lock and the local undo stack

Deno.test("the gauges' constants put 1x on a labelled tick about 10px from its neighbours", () => {
  // Setup: the constants ScaleHeightPanel passes each ValueRuler.
  // Test: the ticks ValueRuler would draw around 1x (visibleValueTicks, what it calls), and the
  // screen spacing tick x pxPerUnit.
  // Verifies: 1x, and both ends of the range, are major (labelled) ticks; the ticks are 10px apart,
  // the angle gauge's own spacing (1 degree at 10px per degree), which the user has asked for
  // gauges to match before; and the step divides the tick, so ticks sit on values the tape snaps to.
  const ticks = visibleValueTicks(1, 150 / RATIO_PX_PER_UNIT, RATIO_TICK, RATIO_MAJOR_EVERY, RATIO_MIN, RATIO_MAX);
  const major = ticks.filter(tick => tick.major).map(tick => tick.value);

  assertEqual(major.includes(1), true, `1x is labelled (${major})`);
  assertEqual([RATIO_MIN / RATIO_TICK % RATIO_MAJOR_EVERY, RATIO_MAX / RATIO_TICK % RATIO_MAJOR_EVERY], [0, 0],
    "both ends are labelled");
  assertClose(RATIO_TICK * RATIO_PX_PER_UNIT, 10, 1e-9, "ticks 10px apart");
  assertClose(RATIO_TICK / RATIO_STEP, Math.round(RATIO_TICK / RATIO_STEP), 1e-9, "a tick is a whole number of steps");
});

Deno.test("moving a gauge moves only that one, unless the lock is on", () => {
  // Setup: the gauges as a session starts (1x, 1x, unlocked).
  // Test: move each gauge unlocked; turn the lock on; move each gauge locked; turn it off.
  // Verifies: unlocked, a gauge moves alone; turning the lock ON brings the crown to the
  // pavilion's ratio (the pavilion is the one the crown is locked TO); locked, moving EITHER gauge
  // moves both; turning it off leaves both where they are.
  let gauges = INITIAL_GAUGES;

  gauges = moveGauge(gauges, 'pavilion', 1.3);
  assertEqual(gauges, { pavilion: 1.3, crown: 1, lock: false }, "the pavilion alone");
  gauges = moveGauge(gauges, 'crown', 0.7);
  assertEqual(gauges, { pavilion: 1.3, crown: 0.7, lock: false }, "the crown alone");

  gauges = setGaugeLock(gauges, true);
  assertEqual(gauges, { pavilion: 1.3, crown: 1.3, lock: true }, "locking brings the crown to the pavilion");

  gauges = moveGauge(gauges, 'crown', 0.9);
  assertEqual(gauges, { pavilion: 0.9, crown: 0.9, lock: true }, "locked, the crown drags the pavilion");
  gauges = moveGauge(gauges, 'pavilion', 2);
  assertEqual(gauges, { pavilion: 2, crown: 2, lock: true }, "locked, the pavilion drags the crown");

  gauges = setGaugeLock(gauges, false);
  assertEqual(gauges, { pavilion: 2, crown: 2, lock: false }, "unlocking leaves both where they are");
  assertEqual(INITIAL_GAUGES, { pavilion: 1, crown: 1, lock: false }, "the starting gauges were not mutated");
});

Deno.test("Reset puts both gauges at 1x and leaves the lock alone", () => {
  // Setup: gauge states Reset can be pressed on (T-0235, the user: "add a reset button below them
  // that snaps them to 1x"): both moved and unlocked, both moved together with the lock on, only
  // one moved, and the untouched 1x/1x a session starts with.
  // Test: resetGauges on each, and gaugesAtOne (what greys the button out) before and after.
  // Verifies: Reset always lands on pavilion 1, crown 1; it keeps the lock exactly as it was (the
  // lock is its own switch, and Reset is about the ratios -- with it on, 1x/1x is a state the lock
  // allows, since the two are equal); it never mutates the state it was given, so the undo stack's
  // earlier entries stay intact; and gaugesAtOne is true only when BOTH read 1x, so the button is
  // live whenever either gauge has moved and inert only when pressing it would change nothing.
  const unlocked = { pavilion: 1.3, crown: 0.7, lock: false };
  const locked = { pavilion: 2.5, crown: 2.5, lock: true };
  const oneMoved = { pavilion: 1, crown: 0.9, lock: false };

  assertEqual(resetGauges(unlocked), { pavilion: 1, crown: 1, lock: false }, "unlocked: both to 1x");
  assertEqual(resetGauges(locked), { pavilion: 1, crown: 1, lock: true }, "locked: both to 1x, still locked");
  assertEqual(resetGauges(oneMoved), { pavilion: 1, crown: 1, lock: false }, "one moved: back to 1x");
  assertEqual(unlocked, { pavilion: 1.3, crown: 0.7, lock: false }, "the state given was not mutated");

  assertEqual([gaugesAtOne(unlocked), gaugesAtOne(locked), gaugesAtOne(oneMoved)], [false, false, false],
    "Reset is live whenever either gauge has moved");
  assertEqual(gaugesAtOne(INITIAL_GAUGES), true, "and inert on the gauges a session starts with");
  assertEqual(gaugesAtOne(resetGauges(unlocked)), true, "and inert once it has been pressed");
});

Deno.test("the local undo stack steps back and forward through finished changes", () => {
  // Setup: a stack starting at 1x/1x.
  // Test: commit three changes (a pavilion drag, a crown drag, the lock), undo twice, redo once,
  // then commit something new; and commit a state equal to the current one.
  // Verifies: undo and redo hand back the states in order and stop at either end (null there);
  // a new change after an undo drops what could have been redone, as the edit history does; and
  // committing an unchanged state (a drag released where it started) records nothing, so one
  // Undo never has to be pressed twice for one change.
  const history = createGaugeHistory(INITIAL_GAUGES);
  const a = { pavilion: 1.2, crown: 1, lock: false };
  const b = { pavilion: 1.2, crown: 0.8, lock: false };
  const c = { pavilion: 1.2, crown: 1.2, lock: true };

  assertEqual([history.canUndo(), history.canRedo()], [false, false], "nothing to step at first");
  assertEqual(history.undo(), null, "undo at the start gives nothing");

  history.commit(a);
  history.commit(b);
  history.commit(c);
  assertEqual(history.commit({ ...c }), false, "an unchanged state is not recorded");

  assertEqual(history.undo(), b, "first undo: back to before the lock");
  assertEqual(history.undo(), a, "second undo: back to before the crown drag");
  assertEqual(history.redo(), b, "redo: the crown drag again");
  assertEqual(history.canRedo(), true, "the lock can still be redone");

  const d = { pavilion: 2, crown: 0.8, lock: false };

  history.commit(d);
  assertEqual(history.canRedo(), false, "a new change drops the redo side");
  assertEqual(history.redo(), null, "redo at the end gives nothing");
  assertEqual([history.undo(), history.undo(), history.undo(), history.undo()], [b, a, INITIAL_GAUGES, null],
    "undo walks all the way back to the start and stops");
  assertEqual(sameGauges(history.current(), INITIAL_GAUGES), true, "current is the start again");
});

// ---- the mode itself, driven through its own functions with the edit history wired in

/**
 * Loads the startup stone into the tier controller with a real EditHistory behind it, wired the
 * way session.js's `startSession` wires the page's own (record, and the three frame calls), and
 * returns `{ design, history }`. There is no GemApp, so the stone is never rebuilt -- the tests
 * read the design, which is what the rebuild would be built from.
 */
async function loadWithHistory() {
  const design = await startupDesign();
  const history = EditHistory.create();

  setEditRecorder(entry => history.record(entry));
  setHistoryFrames({
    begin: () => history.beginFrame(),
    commit: label => history.commitFrame(label),
    cancel: () => {
      const ops = history.cancelFrame();

      if (ops) {
        applyEdit(ops);
      }
    },
  });
  render(design, null);
  return { design, history };
}

/** Every tier's angle and distance, to compare a design before and after. */
const snapshot = design => design.tiers.map(tier => [tier.angle, tier.distance]);

Deno.test("Done is one history entry that a single undo takes back", async () => {
  // Setup: the startup stone loaded, the mode opened.
  // Test: move the pavilion to 1.2 and the crown to 0.8 (each a finished change), press Done, then
  // take one step of the edit history back and one forward.
  // Verifies: while open, the design follows the gauges (a crown tier's angle is the user's
  // formula); Done leaves exactly ONE entry, labelled "Scale height"; one undo restores every tier
  // exactly; one redo puts the scaled design back.
  const { design, history } = await loadWithHistory();
  const original = snapshot(design);
  const crownTier = design.tiers.find(tier => tier.angle > 0 && tier.angle < 90);
  const crownAngle = crownTier.angle;

  assertEqual(enterScaleHeightMode(), true, "the mode opened");
  assertEqual(get(scaleGauges), INITIAL_GAUGES, "both gauges start at 1x, unlocked");

  changeGauge('pavilion', 1.2, true);
  changeGauge('crown', 0.8, true);
  assertClose(crownTier.angle, userFormula(crownAngle, 0.8), 1e-12, "the crown tier follows the gauge");

  const scaled = snapshot(design);

  exitScaleHeightMode();
  assertEqual(get(scaleHeightOpen), false, "Done closed the mode");
  assertEqual(history.undoLabel(), 'Scale height', "the entry is labelled");

  applyEdit(history.undo());
  assertEqual(snapshot(design), original, "one undo restores every tier");
  assertEqual(history.canUndo(), false, "and that was the only entry");

  applyEdit(history.redo());
  assertEqual(snapshot(design), scaled, "one redo scales it again");

  render(null, null);
});

Deno.test("Cancel puts every tier back and records nothing", async () => {
  // Setup: the startup stone loaded, the mode opened.
  // Test: move both gauges (one as an unfinished drag, which is written on a budgeted turn and
  // never recorded), then Cancel.
  // Verifies: every tier's angle and distance is back exactly, bit for bit; nothing is left in
  // the history; the mode is closed.
  const { design, history } = await loadWithHistory();
  const original = snapshot(design);

  enterScaleHeightMode();
  changeGauge('crown', 1.5, true);
  changeGauge('pavilion', 0.6, false);
  await new Promise(resolve => setTimeout(resolve, 40));
  cancelScaleHeightMode();

  assertEqual(snapshot(design), original, "every tier is back as it was");
  assertEqual([history.canUndo(), history.canRedo()], [false, false], "nothing was recorded");
  assertEqual(get(scaleHeightOpen), false, "Cancel closed the mode");

  render(null, null);
});

Deno.test("Undo and Redo step the gauges while the mode is open, not the edit history", async () => {
  // Setup: the startup stone loaded, an unrelated entry already in the edit history (a toolbar
  // flag), then the mode opened.
  // Test: two gauge changes and the lock, then Edit > Undo three times and Redo once -- through
  // session.js's own `undo` and `redo`, which is where the menu items and Cmd/Ctrl+Z go.
  // Verifies: each undo steps the gauges back one finished change, and the design with them
  // (always recomputed from the snapshot); the menu's Undo/Redo greying follows the local stack;
  // and the entry recorded before the mode opened is never touched -- after Cancel it is still
  // there to undo.
  const { design, history } = await loadWithHistory();

  history.record({ label: 'Earlier edit', ops: [{ kind: 'update', target: 'tierFlag', tier: design.tiers[0], flag: 'frosted', before: false, after: true }] });

  const original = snapshot(design);

  enterScaleHeightMode();
  assertEqual([get(canUndo), get(canRedo)], [false, false], "nothing to undo in the mode yet");

  changeGauge('pavilion', 1.2, true);
  const afterPavilion = snapshot(design);

  changeGauge('crown', 0.8, true);
  changeLock(true);
  assertEqual(get(scaleGauges), { pavilion: 1.2, crown: 1.2, lock: true }, "the lock brought the crown up");
  assertEqual(get(canUndo), true, "the menu's Undo is live");

  undo();
  assertEqual(get(scaleGauges), { pavilion: 1.2, crown: 0.8, lock: false }, "undo: the lock is off again");
  undo();
  assertEqual(get(scaleGauges), { pavilion: 1.2, crown: 1, lock: false }, "undo: the crown is back at 1x");
  assertEqual(snapshot(design), afterPavilion, "and the design is as it was after the pavilion drag");
  undo();
  assertEqual(snapshot(design), original, "undo: back to the design the mode opened on");
  assertEqual([get(canUndo), get(canRedo)], [false, true], "nothing more to undo, something to redo");
  redo();
  assertEqual(get(scaleGauges).pavilion, 1.2, "redo: the pavilion drag again");

  cancelScaleHeightMode();
  assertEqual(history.undoLabel(), 'Earlier edit', "the edit history below the mode was never touched");

  render(null, null);
});

Deno.test("Reset in the mode is one step of the local undo, and does nothing at 1x", async () => {
  // Setup: the startup stone loaded, the mode opened (both gauges at 1x, nothing to undo).
  // Test: press Reset straight away; move the pavilion to 1.4 and the crown to 0.6 and turn the
  // lock on (three finished changes); press Reset; then Edit > Undo once and Redo once, through
  // session.js's own `undo`/`redo` (where the menu and Cmd/Ctrl+Z go); finally Cancel.
  // Verifies:
  //   * at 1x Reset records nothing -- the menu's Undo stays greyed -- matching the button being
  //     inert there, so a stray click can never leave an empty step to undo;
  //   * Reset puts both gauges at 1x with the lock still on, and the DESIGN back exactly as it
  //     opened (every angle and distance, bit for bit: 1x is the snapshot itself);
  //   * one Undo brings back the gauges as they were before Reset (1.4/1.4 locked -- the lock had
  //     brought the crown to the pavilion) and the scaled design with them; one Redo resets again;
  //   * a second Reset at 1x after that adds no step (Redo side untouched, nothing to redo);
  //   * Cancel still puts everything back and leaves the edit history empty.
  const { design, history } = await loadWithHistory();
  const original = snapshot(design);

  enterScaleHeightMode();
  resetScaleGauges();
  assertEqual(get(canUndo), false, "Reset at 1x records nothing");

  changeGauge('pavilion', 1.4, true);
  changeGauge('crown', 0.6, true);
  changeLock(true);

  const beforeReset = get(scaleGauges);
  const scaledDesign = snapshot(design);

  assertEqual(beforeReset, { pavilion: 1.4, crown: 1.4, lock: true }, "the gauges before Reset");

  resetScaleGauges();
  assertEqual(get(scaleGauges), { pavilion: 1, crown: 1, lock: true }, "Reset: both at 1x, still locked");
  assertEqual(snapshot(design), original, "and the design is exactly as the mode opened on it");

  undo();
  assertEqual(get(scaleGauges), beforeReset, "Undo: the gauges as they were before Reset");
  assertEqual(snapshot(design), scaledDesign, "and the scaled design with them");

  redo();
  assertEqual(get(scaleGauges), { pavilion: 1, crown: 1, lock: true }, "Redo: reset again");
  assertEqual(get(canRedo), false, "nothing further to redo");

  resetScaleGauges();
  assertEqual(get(canRedo), false, "a second Reset at 1x changed nothing");
  undo();
  assertEqual(get(scaleGauges), beforeReset, "and one Undo still steps back over the one Reset");

  cancelScaleHeightMode();
  assertEqual(snapshot(design), original, "Cancel put every tier back");
  assertEqual([history.canUndo(), history.canRedo()], [false, false], "nothing reached the edit history");

  render(null, null);
});

Deno.test("scale height and edit mode refuse each other, and the design is held", async () => {
  // Setup: the startup stone loaded, a tier selected.
  // Test: open edit mode and try scale height; close it; open scale height and try edit mode, a
  // reorder, and read the tier toolbar.
  // Verifies: one mode at a time, both ways round ("one session at a time", as enterEditMode has
  // it); while scale height is open a reorder is refused and every toolbar button is inactive and
  // says why -- another edit made then would land inside the mode's one history entry, out of
  // reach of its own undo.
  const { design } = await loadWithHistory();
  const pavilion = design.tiers.filter(tier => tier.angle < 0 && tier.angle > -90);

  highlightTier(pavilion[0]);
  assertEqual(enterEditMode(pavilion[0]), true, "edit mode opened");
  assertEqual(enterScaleHeightMode(), false, "scale height is refused while editing");
  exitEditMode();

  assertEqual(enterScaleHeightMode(), true, "scale height opened");
  assertEqual(enterEditMode(pavilion[0]), false, "edit mode is refused while scaling");
  assertEqual(get(editing), null, "and nothing is being edited");

  const order = sectionOrder('pavilion');

  applyReorder('pavilion', [...order].reverse());
  assertEqual(sectionOrder('pavilion'), order, "a reorder is refused");

  const buttons = get(toolbar);

  for (const name of ['new', 'edit', 'delete', 'visibility', 'preform', 'frosted', 'comments']) {
    assertEqual(buttons[name].active, false, `${name} is inactive`);
    assertEqual(buttons[name].tip.includes('Finish scaling the height first'), true, `${name} says why`);
  }

  // Once the mode closes the buttons are back to their usual rules. Checked by their tooltips
  // rather than `active`: with no rows drawn (there is no DOM here) every redraw drops the
  // selection, and most buttons are then inactive for the ordinary reason, "Select a tier first".
  cancelScaleHeightMode();

  for (const name of ['new', 'edit', 'delete', 'visibility', 'preform', 'frosted', 'comments']) {
    assertEqual(get(toolbar)[name].tip.includes('Finish scaling the height first'), false,
      `${name} no longer says to finish scaling`);
  }

  assertEqual(get(toolbar).comments.active, true, "Comments, which needs no selection, is live again");

  render(null, null);
});
