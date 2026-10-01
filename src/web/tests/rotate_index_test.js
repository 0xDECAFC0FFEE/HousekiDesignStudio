/*
 * rotate_index_test.js -- tests for rotate by index mode (T-0287, 2026-09-29): the math in
 * web/src/lib/rotate_index.js, and the mode around it in rotate_index_mode.js.
 *
 * THE RULE UNDER TEST (the user: "can you add support for rotate index mode - it needs a slider to
 * the right along with the cancel/done buttons"; the coordinator's brief: "The mode rotates the
 * whole design about its axis by a whole number of index teeth: every facet's index shifts by the
 * same amount, wrapping round the gear. Only the design's index numbers change; angles and depths
 * stay the same."):
 *   * a turn of k teeth moves every facet's index to (index + k) modulo the gear's tooth count,
 *     kept in [0, teeth), and re-sorts each tier into ascending tooth order, the way every design
 *     is sorted when it loads (design.js's sortTierFacets, T-0240) -- so the cutting instructions
 *     read "15-31-47-...", never "95-15-31-...";
 *   * the table and a flat culet (on the axis, whose index design.js keeps at 0 on purpose) do not
 *     move;
 *   * angles, distances, the gear and the design's symmetry description never change;
 *   * the whole session is one edit-history entry on Done, Cancel and Escape put the design back
 *     bit for bit, Undo/Redo step the slider meanwhile, and the design is held against every other
 *     edit and mode while it is open.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The panel itself -- the slider, its reading, Cancel and Done, the menu item, Escape (App.svelte's
 * key handler, which calls the same `cancelRotateIndexMode` tested here) and the gear button's
 * refusal -- is checked against the built page over CDP with real input, since it needs a
 * browser, the wasm module and a real renderer. Here there is no renderer (`engine.app` is null),
 * so the stone is never rebuilt; the tests read the design, which is what the rebuild is built
 * from, and build planes themselves with GemCadDesign where the geometry matters.
 *
 * `window` is stubbed because the modes ask the page for a redraw (`window.gemRequestRender?.()`)
 * and Deno has no such global. ES modules hoist their imports, so this runs after the modules
 * below are evaluated -- soon enough, since none of them touches `window` at import time.
 */

globalThis.window = globalThis.window ?? {};

import { get } from "svelte/store";
import {
  rotationRange, wrapSteps, rotationDegrees, formatRotation, followsRotation, rotatedFacetState,
  rotatedStates, INITIAL_STEPS, ROTATION_STEP,
} from "../src/lib/rotate_index.js";
import {
  enterRotateIndexMode, exitRotateIndexMode, cancelRotateIndexMode, changeRotation, rotateIndexOpen,
  rotationSteps, rotationTeeth, ROTATE_LABEL,
} from "../src/lib/rotate_index_mode.js";
import { enterScaleHeightMode, cancelScaleHeightMode, scaleHeightOpen } from "../src/lib/scale_height_mode.js";
import { enterResizeGirdleMode, cancelResizeGirdleMode, resizeGirdleOpen } from "../src/lib/resize_girdle_mode.js";
import { enterEditMode, exitEditMode, editing } from "../src/lib/edit_mode.js";
import { formatTierIndex, isTableTier, tierIdsInFileOrder } from "../src/lib/tiers.js";
import {
  render, toolbar, highlightTier, applyReorder, sectionOrder, setEditRecorder, setHistoryFrames,
  applyEdit, editNotes, tierFacetState,
} from "../src/lib/tier_controller.js";
import { undo, redo } from "../src/lib/session.js";
import { canUndo, canRedo } from "../src/lib/stores.js";

// The GemCad scripts, loaded as the page loads them: classic scripts publishing globals, in the
// order make_page.py's bundle runs them. `design.js` holds the design, `gcs.js` reads the startup
// stone, and `edit_history.js` is the history Done records into.
for (const script of ["edit_history.js", "gemcad.js", "gemcad_obj.js", "design.js", "design_mesh.js", "gcs.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${script}`, import.meta.url)));
}

const { GemCadDesign, GemCutStudio, EditHistory } = globalThis;

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

function assertTrue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/** A tier's teeth exactly as the cutting instructions print them (TierRow.svelte). */
const teethText = tier => tier.facets.map(facet => formatTierIndex(facet.index)).join('-');

/**
 * Everything about a design this mode may or may not touch, per tier: the angle, the distance, the
 * facet OBJECTS in order and their indexes. Compared with Object.is-strength equality by
 * `assertSameDesign`, so "bit for bit" means bit for bit, and a facet that came back as a copy
 * rather than the same object counts as a difference.
 */
function fullSnapshot(design) {
  return design.tiers.map(tier => ({
    tier,
    angle: tier.angle,
    distance: tier.distance,
    facets: tier.facets.slice(),
    indexes: tier.facets.map(facet => facet.index),
  }));
}

function assertSameDesign(design, snapshot, message) {
  assertEqual(design.tiers.length, snapshot.length, `${message}: tier count`);
  design.tiers.forEach((tier, t) => {
    const was = snapshot[t];

    assertTrue(tier === was.tier, `${message}: tier ${t} is the same object`);
    assertTrue(Object.is(tier.angle, was.angle), `${message}: tier ${t}'s angle, bit for bit`);
    assertTrue(Object.is(tier.distance, was.distance), `${message}: tier ${t}'s distance, bit for bit`);
    assertEqual(tier.facets.length, was.facets.length, `${message}: tier ${t}'s facet count`);
    tier.facets.forEach((facet, f) => {
      assertTrue(facet === was.facets[f], `${message}: tier ${t} facet ${f} is the same object, in the same place`);
      assertTrue(Object.is(facet.index, was.indexes[f]), `${message}: tier ${t} facet ${f}'s index, bit for bit`);
    });
  });
}

/**
 * Every mirror line of a set of tiers' teeth on a `teeth`-tooth gear, as the tooth it passes
 * through, in half-tooth steps over [0, teeth / 2) (a line through tooth m also passes through
 * m + teeth / 2). A line through m maps tooth i to 2m - i; a tier's teeth are symmetric about it
 * when that maps its set of teeth onto itself. On-axis tiers are left out: their one "tooth" 0 is
 * a stand-in for "every tooth" (design.js canonicalises the pole), not a position that has a
 * mirror image. Computed from the facets themselves, so it does not rely on `design.symmetry`
 * (the startup stone's own file says `mirror: false`, although its facets are mirror images of
 * each other about tooth 0).
 */
function mirrorLines(tiers, teeth) {
  const wrap = value => ((value % teeth) + teeth) % teeth;
  const key = value => wrap(value).toFixed(6);
  const lines = [];

  for (let twice = 0; twice < teeth; twice++) {
    const m = twice / 2;
    const symmetric = tiers.filter(followsRotation).every(tier => {
      const set = new Set(tier.facets.map(facet => key(facet.index)));

      return tier.facets.every(facet => set.has(key(2 * m - facet.index)));
    });

    if (symmetric) {
      lines.push(m);
    }
  }

  return lines;
}

/**
 * Whether every tier's teeth are unchanged by a turn of `period` teeth (rotational symmetry).
 * On-axis tiers are left out, for the reason `mirrorLines` gives.
 */
function repeatsEvery(tiers, teeth, period) {
  const key = value => ((((value + period) % teeth) + teeth) % teeth).toFixed(6);

  return tiers.filter(followsRotation).every(tier => {
    const set = new Set(tier.facets.map(facet => facet.index.toFixed(6)));

    return tier.facets.every(facet => set.has(key(facet.index)));
  });
}

// ---- the slider

Deno.test("the slider spans one whole turn of the gear, centred on 0, with no position twice", () => {
  // Setup: gears of even and odd tooth counts, including the usual 96, 80, the odd 55 and a tiny
  // 3.
  // Test: rotationRange for each, and wrapSteps over every whole number of teeth across three
  // turns in both directions.
  // Verifies: the range holds exactly `teeth` positions and contains 0 (the design as it opened)
  // with at most one more position on the + side; every whole number of teeth, however large or
  // negative, lands on a position inside the range that is the same turn modulo the gear (so a
  // typed 96 is 0, a typed -50 on 96 teeth is +46); and no two positions in the range are the same
  // turn, which is what "one full turn with no duplicate positions" means.
  assertEqual(rotationRange(96), { min: -47, max: 48 }, "96 teeth");
  assertEqual(rotationRange(80), { min: -39, max: 40 }, "80 teeth");
  assertEqual(rotationRange(55), { min: -27, max: 27 }, "55 teeth");

  for (const teeth of [3, 55, 64, 80, 96, 120]) {
    const { min, max } = rotationRange(teeth);

    assertEqual(max - min + 1, teeth, `${teeth}: one position per tooth`);
    assertTrue(min <= 0 && 0 <= max && max - -min <= 1, `${teeth}: centred on 0`);

    const seen = new Set();

    for (let steps = -3 * teeth; steps <= 3 * teeth; steps++) {
      const wrapped = wrapSteps(steps, teeth);

      assertTrue(min <= wrapped && wrapped <= max, `${teeth}: ${steps} wraps into the range, got ${wrapped}`);
      assertEqual(((wrapped - steps) % teeth + teeth) % teeth, 0, `${teeth}: ${steps} and ${wrapped} are the same turn`);
      seen.add(wrapped);
    }

    assertEqual(seen.size, teeth, `${teeth}: every position reached, none twice`);
  }

  assertEqual([wrapSteps(96, 96), wrapSteps(-50, 96), wrapSteps(2.6, 96)], [0, 46, 3],
    "a typed whole turn is 0, a typed -50 is +46, and a typed fraction rounds to a whole tooth");
  assertEqual([INITIAL_STEPS, ROTATION_STEP], [0, 1], "sessions start at 0, and the slider stops on whole teeth");
});

Deno.test("the reading gives the turn in teeth and in degrees of the wheel", () => {
  // Setup: turns of +3, -1, 0 and +48 on 96 teeth, and +1 on 55.
  // Test: formatRotation and rotationDegrees.
  // Verifies: each reading names the teeth (singular for one) and the degrees (360 / teeth each),
  // signed with a real minus sign, as the brief asks ("show the value as teeth and also as
  // degrees"); half a turn of a 96-tooth gear is 180 degrees.
  assertEqual(formatRotation(3, 96), "+3 teeth · +11.25°", "+3 on 96");
  assertEqual(formatRotation(-1, 96), "−1 tooth · −3.75°", "-1 on 96");
  assertEqual(formatRotation(0, 96), "0 teeth · 0.00°", "0");
  assertEqual(formatRotation(48, 96), "+48 teeth · +180.00°", "half a turn");
  assertEqual(formatRotation(1, 55), "+1 tooth · +6.55°", "+1 on 55");
  assertClose(rotationDegrees(-47, 96), -176.25, 1e-12, "degrees are teeth x 360 / teeth");
});

// ---- the rotation itself

Deno.test("a turn of k teeth moves every facet's index by k modulo the gear; angles and depths stay", async () => {
  // Setup: the startup stone (96 teeth: tiers at 4-12-...-92, 0-16-...-80, 3-13-19-...-93,
  // 8-24-...-88, and the table at 0), its pristine facet states, and turns across the whole
  // slider -- both ends, both signs, small and large, and some that wrap past tooth 0.
  // Test: rotatedStates for each turn, compared facet OBJECT by facet object with its pristine
  // index plus k, wrapped into [0, 96).
  // Verifies: every facet of every tier except the table moved by exactly k teeth modulo the gear,
  // as a whole number; every index stays inside [0, 96); the table stays at 0; and the function
  // hands back the SAME facet objects (a facet's name and frosting ride with it) and never touches
  // the tier objects' angle or distance -- it only returns new states, and the design is unchanged
  // afterwards.
  const design = await startupDesign();
  const before = fullSnapshot(design);
  const pristine = design.tiers.map(tier => ({ tier, state: tierFacetState(tier) }));
  const teeth = design.gear.teeth;

  for (const k of [1, -1, 3, 5, -16, 20, 47, 48, -47, 95, -95]) {
    const turned = rotatedStates(pristine, k, teeth);

    turned.forEach(({ tier, state }, t) => {
      const was = pristine[t].state;

      assertEqual(state.facets.length, was.facets.length, `k=${k} tier ${t}: same number of facets`);

      state.facets.forEach((facet, at) => {
        const from = was.indexes[was.facets.indexOf(facet)];
        const expected = isTableTier(tier) ? from : ((from + k) % teeth + teeth) % teeth;

        assertTrue(was.facets.includes(facet), `k=${k} tier ${t}: facet ${at} is one of the tier's own objects`);
        assertEqual(state.indexes[at], expected, `k=${k} tier ${t}: facet ${at} moved by k modulo ${teeth}`);
        assertTrue(Number.isInteger(state.indexes[at]) && state.indexes[at] >= 0 && state.indexes[at] < teeth,
          `k=${k} tier ${t}: a whole tooth inside the gear`);
      });
    });
  }

  assertEqual(teethText(design.tiers.find(isTableTier)), "0", "the table was never moved off tooth 0");
  assertSameDesign(design, before, "computing turns changes nothing on the design itself");
});

Deno.test("a turn of 0, or of a whole number of full turns, gives the original design bit for bit", async () => {
  // Setup: the startup stone's pristine facet states, and a synthetic fractional tier whose
  // indexes are awkward floats (0.1 + 0.2, 1/3, 95.9999) that an addition and a subtraction would
  // not give back exactly.
  // Test: rotatedFacetState at 0, 96, -96 and 192; and turning by k and then by teeth - k (a full
  // turn made of two parts) for whole-toothed tiers.
  // Verifies: 0 and every whole number of turns return the very same state object -- same arrays,
  // same facet objects, same numbers -- so a session that ends where it began records nothing and
  // a fractional index is never nudged by float arithmetic; and two turns that add up to a full turn
  // give back the original indexes and facet order exactly for whole teeth.
  const design = await startupDesign();

  for (const tier of design.tiers) {
    const state = tierFacetState(tier);

    for (const turn of [0, 96, -96, 192]) {
      assertTrue(rotatedFacetState(state, turn, 96) === state, `a turn of ${turn} is the state itself`);
    }

    for (const k of [1, 17, 48, 95]) {
      const back = rotatedFacetState(rotatedFacetState(state, k, 96), 96 - k, 96);

      assertEqual(back.indexes, state.indexes, `+${k} then +${96 - k}: the same indexes`);
      assertTrue(back.facets.every((facet, at) => facet === state.facets[at]), `+${k} then +${96 - k}: the same order`);
    }
  }

  const fractional = { facets: [{ index: 0.1 + 0.2 }, { index: 1 / 3 }, { index: 95.9999 }] };
  const state = tierFacetState(fractional);

  assertTrue(rotatedFacetState(state, 0, 96) === state, "a fractional tier at 0 is untouched");
  assertTrue(rotatedFacetState(state, 96, 96) === state, "and at a full turn");
});

Deno.test("the cutting instructions' tooth lists read naturally after a wrap", async () => {
  // Setup: the startup stone's C1-style tier at 0-16-32-48-64-80, its C2 at 3-13-19-...-93, and a
  // fractional tier at 53.5 on a 55-tooth gear, with each facet given a name so it can be followed.
  // Test: turns that push teeth past the gear's end and back past 0, formatting each tier the way
  // TierRow.svelte prints it.
  // Verifies: each list is ascending, inside [0, teeth), and starts at its lowest tooth -- "15-31-
  // 47-63-79-95", never "95-15-31-..." or "-1-15-..." -- exactly as the same tier would read if a
  // file holding it were opened (design.js sorts every tier on load); a fraction is carried and
  // printed to three places; and each facet's name moved with its own tooth, so sorting reordered
  // the facet objects rather than relabelling numbers.
  const tier = {
    angle: 40,
    facets: [0, 16, 32, 48, 64, 80].map(index => ({ index, name: `f${index}` })),
  };
  const state = tierFacetState(tier);
  const show = s => s.indexes.map(formatTierIndex).join('-');

  assertEqual(show(rotatedFacetState(state, -1, 96)), "15-31-47-63-79-95", "turned back past 0");
  assertEqual(show(rotatedFacetState(state, 20, 96)), "4-20-36-52-68-84", "turned on past 96");
  assertEqual(show(rotatedFacetState(state, 48, 96)), "0-16-32-48-64-80", "half a turn lands on the same teeth");
  assertEqual(rotatedFacetState(state, -1, 96).facets.map(facet => facet.name),
    ["f16", "f32", "f48", "f64", "f80", "f0"], "each name stayed with its facet: f0 is now tooth 95, last");

  const design = await startupDesign();
  const c2 = design.tiers.find(t => teethText(t) === "3-13-19-29-35-45-51-61-67-77-83-93");

  assertTrue(c2 !== undefined, "the startup stone has its C2 at 3-13-19-...");
  assertEqual(show(rotatedFacetState(tierFacetState(c2), -5, 96)), "8-14-24-30-40-46-56-62-72-78-88-94",
    "C2 turned back 5 teeth");

  const half = { angle: 30, facets: [{ index: 1.5 }, { index: 12.5 }, { index: 53.5 }] };

  assertEqual(show(rotatedFacetState(tierFacetState(half), 2, 55)), "0.500-3.500-14.500",
    "a fractional tier keeps its fraction and wraps 53.5 + 2 to 0.5");
});

Deno.test("the stone is the same stone turned: every plane rotates about the axis by k teeth", async () => {
  // Setup: the startup stone, and a copy with the gear reversed and moved off origin 0 (a
  // GemCad `g -96 48.0` gear), so the wheel's direction and origin both reach the arithmetic.
  // Test: for turns of 1, -7 and 30 teeth, write the rotated states into a copy of the design and
  // compare GemCadDesign.planesOf on it against the pristine planes turned about the optical axis
  // by k x the gear's own step angle (360 / signed teeth), matched facet object by facet object.
  // Verifies: every facet's plane is the original plane turned by the same angle, with the same
  // distance -- so the rotation only turns the stone and cannot distort it, whichever way the
  // wheel runs; and a flat table's plane (normal straight up) is unchanged, which is why it does
  // not need to move.
  const designs = [await startupDesign()];
  const reversed = await startupDesign();

  reversed.gear.reversed = true;
  reversed.gear.originIndex = 48;
  designs.push(reversed);

  for (const design of designs) {
    const pristine = design.tiers.map(tier => ({ tier, state: tierFacetState(tier) }));
    const before = new Map();

    for (const plane of GemCadDesign.planesOf(design)) {
      before.set(design.tiers[plane.tier].facets[plane.facet], plane);
    }

    for (const k of [1, -7, 30]) {
      const turn = k * GemCadDesign.stepAngle(design) * Math.PI / 180;

      for (const { tier, state } of rotatedStates(pristine, k, design.gear.teeth)) {
        tier.facets = state.facets.slice();
        tier.facets.forEach((facet, at) => { facet.index = state.indexes[at]; });
      }

      for (const plane of GemCadDesign.planesOf(design)) {
        const was = before.get(design.tiers[plane.tier].facets[plane.facet]);
        const n = was.normal;
        // normalOf measures azimuth from +Y towards +X, so a turn of d adds d to it.
        const expected = {
          x: n.x * Math.cos(turn) + n.y * Math.sin(turn),
          y: n.y * Math.cos(turn) - n.x * Math.sin(turn),
          z: n.z,
        };

        for (const axis of ['x', 'y', 'z']) {
          assertClose(plane.normal[axis], expected[axis], 1e-12, `reversed=${design.gear.reversed} k=${k}: normal ${axis}`);
        }

        assertTrue(Object.is(plane.offset, was.offset), `k=${k}: the plane's distance is untouched`);
      }

      // Back to the pristine states before the next turn, so each k is measured from the start.
      for (const { tier, state } of pristine) {
        tier.facets = state.facets.slice();
        tier.facets.forEach((facet, at) => { facet.index = state.indexes[at]; });
      }
    }
  }
});

Deno.test("a turn keeps the design's symmetry: its repeat is unchanged and its mirror lines turn with it", async () => {
  // Setup: the startup stone (96 teeth, 6-fold; its facets are mirror images of each other about
  // tooth 0 and every 8 teeth from it, although its file does not set the mirror flag), and a
  // synthetic 5-fold mirrored design on a 55-tooth gear, whose repeat of 11 teeth is odd, so some
  // of its mirror lines pass between two teeth.
  // Test: for every turn on the slider, the teeth of every tier after the turn: whether they still
  // repeat every teeth / folds teeth, and where their mirror lines lie (found from the facets, not
  // from `design.symmetry`), against the lines before the turn moved on by k.
  // Verifies: no turn breaks either symmetry -- the design still has `folds` equal copies and
  // exactly as many mirror lines, each moved by exactly k teeth (the stone turned, and its lines
  // with it); a line through tooth 0 is still one only when 2k is a whole number of repeats, so a
  // file reader that expects the mirror line at tooth 0 sees it move (recorded in the KB); and the
  // design's own `symmetry` description is never touched.
  const hex = await startupDesign();
  const odd = {
    gear: { teeth: 55, reversed: false, originIndex: 0, fractional: false },
    symmetry: { folds: 5, mirror: true },
    tiers: [
      { angle: 0, distance: 0.5, facets: [{ index: 0 }] },
      { angle: 30, distance: 0.8, facets: [0, 11, 22, 33, 44].map(index => ({ index })) },
      { angle: -40, distance: 0.7, facets: [3, 8, 14, 19, 25, 30, 36, 41, 47, 52].map(index => ({ index })) },
    ],
  };

  for (const design of [hex, odd]) {
    const teeth = design.gear.teeth;
    const folds = design.symmetry.folds;
    const symmetryBefore = JSON.stringify(design.symmetry);
    const pristine = design.tiers.map(tier => ({ tier, state: tierFacetState(tier) }));
    const linesBefore = mirrorLines(design.tiers, teeth);
    const { min, max } = rotationRange(teeth);

    assertTrue(linesBefore.length === folds, `${teeth} teeth: the design has ${folds} mirror lines to start with`);
    assertTrue(repeatsEvery(design.tiers, teeth, teeth / folds), `${teeth} teeth: and repeats every ${teeth / folds} teeth`);

    for (let k = min; k <= max; k++) {
      const turned = rotatedStates(pristine, k, teeth).map(({ tier, state }) => ({
        angle: tier.angle,
        facets: state.indexes.map(index => ({ index })),
      }));
      const expected = linesBefore.map(m => (((m + k) % (teeth / 2)) + teeth / 2) % (teeth / 2)).sort((a, b) => a - b);

      assertTrue(repeatsEvery(turned, teeth, teeth / folds), `${teeth} teeth, k=${k}: still ${folds}-fold`);
      assertEqual(mirrorLines(turned, teeth), expected, `${teeth} teeth, k=${k}: the mirror lines moved by k`);
      assertEqual(mirrorLines(turned, teeth).includes(0), (2 * k) % (teeth / folds) === 0,
        `${teeth} teeth, k=${k}: a line through tooth 0 exactly when 2k is a whole number of repeats`);
    }

    assertEqual(JSON.stringify(design.symmetry), symmetryBefore, `${teeth} teeth: the symmetry description is untouched`);
  }
});

// ---- the mode itself, driven through its own functions with the edit history wired in

/**
 * Loads the startup stone into the tier controller with a real EditHistory behind it, wired the
 * way session.js's `startSession` wires the page's own (record, and the three frame calls), and
 * returns `{ design, history }`.
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

Deno.test("Done is one history entry that a single undo takes back, and a redo puts back", async () => {
  // Setup: the startup stone loaded, the mode opened.
  // Test: move the slider twice (each a finished change, as a release or a key press is), press
  // Done, then take one step of the edit history back and one forward, replaying the ops through
  // applyEdit as the page's Undo does.
  // Verifies:
  //   * the mode opens at 0, on this design's 96 teeth;
  //   * while open, the design follows the slider from the snapshot: after +5 then -3, every tier
  //     reads as the pristine design turned by -3 (not +2, the sum), angles and distances bit for
  //     bit as they were;
  //   * Done closes the mode and leaves exactly ONE entry, labelled "Rotate by index", holding only
  //     `tierFacets` updates, and none for the table;
  //   * one undo restores every tier bit for bit -- facet objects, their order and their indexes
  //     -- and that was the only entry; one redo turns it again.
  const { design, history } = await loadWithHistory();
  const original = fullSnapshot(design);
  const pristine = design.tiers.map(tier => ({ tier, state: tierFacetState(tier) }));

  assertEqual(enterRotateIndexMode(), true, "the mode opened");
  assertEqual([get(rotateIndexOpen), get(rotationSteps), get(rotationTeeth)], [true, 0, 96], "open, at 0, on 96 teeth");

  changeRotation(5, true);
  changeRotation(-3, true);

  const expected = rotatedStates(pristine, -3, 96);

  design.tiers.forEach((tier, t) => {
    assertEqual(tier.facets.map(facet => facet.index), expected[t].state.indexes, `tier ${t} follows the slider from the snapshot`);
    assertTrue(Object.is(tier.angle, original[t].angle) && Object.is(tier.distance, original[t].distance),
      `tier ${t}'s angle and distance are untouched`);
  });

  const turned = fullSnapshot(design);

  exitRotateIndexMode();
  assertEqual(get(rotateIndexOpen), false, "Done closed the mode");
  assertEqual(history.undoLabel(), ROTATE_LABEL, "the entry is labelled");

  const ops = history.undo();

  assertTrue(ops.length > 0 && ops.every(op => op.target === 'tierFacets'), "only tier facets were recorded");
  assertTrue(ops.every(op => !isTableTier(op.tier)), "and none for the table");
  applyEdit(ops);
  assertSameDesign(design, original, "one undo restores every tier");
  assertEqual(history.canUndo(), false, "and that was the only entry");

  applyEdit(history.redo());
  assertSameDesign(design, turned, "one redo turns it again");

  render(null, null);
});

Deno.test("Done at 0, or at a typed full turn, records nothing and leaves the design bit for bit", async () => {
  // Setup: the startup stone loaded, the mode opened.
  // Test: move the slider away and back to 0, then Done; open again, type a whole turn (96, which
  // wraps onto the slider as 0), then Done.
  // Verifies: the design is bit for bit as it opened both times, and the edit history has nothing
  // to undo -- an empty "Rotate by index" entry would be an Undo that does nothing.
  const { design, history } = await loadWithHistory();
  const original = fullSnapshot(design);

  enterRotateIndexMode();
  changeRotation(-12, true);
  changeRotation(0, true);
  exitRotateIndexMode();
  assertSameDesign(design, original, "back at 0");

  enterRotateIndexMode();
  changeRotation(96, true);
  assertEqual(get(rotationSteps), 0, "a typed 96 is 0 on the slider");
  exitRotateIndexMode();
  assertSameDesign(design, original, "a full turn");
  assertEqual(history.canUndo(), false, "nothing was recorded");

  render(null, null);
});

Deno.test("Cancel (Escape's twin) puts every tier back exactly and records nothing", async () => {
  // Setup: the startup stone loaded, the mode opened.
  // Test: a finished change, then an unfinished drag step (written on a budgeted turn, never
  // recorded) with a wait long enough for that turn to run, then Cancel -- which is also exactly
  // what Escape calls (App.svelte's key handler; checked on the built page).
  // Verifies: every tier's facet objects, their order, indexes, angles and distances are back bit
  // for bit; nothing is in the history; the mode is closed.
  const { design, history } = await loadWithHistory();
  const original = fullSnapshot(design);

  enterRotateIndexMode();
  changeRotation(7, true);
  changeRotation(-30, false);
  await new Promise(resolve => setTimeout(resolve, 40));
  assertEqual(teethText(design.tiers[0]), "6-14-22-30-38-46-54-62-70-78-86-94", "the drag step was written (P1 turned by -30)");
  cancelRotateIndexMode();

  assertSameDesign(design, original, "every tier is back as it was");
  assertEqual([history.canUndo(), history.canRedo()], [false, false], "nothing was recorded");
  assertEqual(get(rotateIndexOpen), false, "Cancel closed the mode");

  render(null, null);
});

Deno.test("Undo and Redo step the slider while the mode is open, not the edit history", async () => {
  // Setup: the startup stone loaded, an unrelated entry already in the edit history (a toolbar
  // flag), then the mode opened.
  // Test: three finished slider changes, then Edit > Undo three times and Redo once, through
  // session.js's own `undo` and `redo` -- where the menu items and Cmd/Ctrl+Z go.
  // Verifies: each undo steps the slider back one change and the design with it (recomputed from
  // the snapshot, so back at 0 it is bit for bit the design the mode opened on); the menu's
  // Undo/Redo greying follows the local stack; and the entry recorded before the mode opened is
  // never touched -- after Cancel it is still there to undo.
  const { design, history } = await loadWithHistory();

  history.record({ label: 'Earlier edit', ops: [{ kind: 'update', target: 'tierFlag', tier: design.tiers[0], flag: 'frosted', before: false, after: true }] });

  const original = fullSnapshot(design);

  enterRotateIndexMode();
  assertEqual([get(canUndo), get(canRedo)], [false, false], "nothing to undo in the mode yet");

  changeRotation(4, true);
  const afterFirst = fullSnapshot(design);

  changeRotation(-10, true);
  changeRotation(33, true);
  assertEqual(get(canUndo), true, "the menu's Undo is live");

  undo();
  assertEqual(get(rotationSteps), -10, "undo: the second change");
  undo();
  assertEqual(get(rotationSteps), 4, "undo: the first change");
  assertSameDesign(design, afterFirst, "and the design is as it was after it");
  undo();
  assertEqual(get(rotationSteps), 0, "undo: back to 0");
  assertSameDesign(design, original, "and to the design the mode opened on");
  assertEqual([get(canUndo), get(canRedo)], [false, true], "nothing more to undo, something to redo");
  redo();
  assertEqual(get(rotationSteps), 4, "redo: the first change again");

  cancelRotateIndexMode();
  assertSameDesign(design, original, "Cancel put it all back");
  assertEqual(history.undoLabel(), 'Earlier edit', "the edit history below the mode was never touched");

  render(null, null);
});

Deno.test("rotate by index and every other editing mode refuse each other, and the design is held", async () => {
  // Setup: the startup stone loaded, a pavilion tier selected.
  // Test: open edit mode, scale height and resize girdle in turn and try this mode under each;
  // then open this mode and try each of them, a second opening, a reorder and a description edit,
  // and read the tier toolbar; then Cancel.
  // Verifies: one mode at a time, every way round ("a mode locks out everything behind it",
  // T-0202); while this mode is open a reorder and a description edit are refused, and every
  // toolbar button is inactive and says to finish rotating -- not another mode's wording; and
  // once it closes the buttons stop saying so. (The gear dialog's refusal and the menu items'
  // greying are components, checked on the built page.)
  const { design } = await loadWithHistory();
  const pavilion = design.tiers.filter(tier => tier.angle < 0 && tier.angle > -90);

  highlightTier(pavilion[0]);
  assertEqual(enterEditMode(pavilion[0]), true, "edit mode opened");
  assertEqual(enterRotateIndexMode(), false, "rotate by index is refused while editing");
  exitEditMode();

  assertEqual(enterScaleHeightMode(), true, "scale height opened");
  assertEqual(enterRotateIndexMode(), false, "rotate by index is refused while scaling the height");
  cancelScaleHeightMode();

  assertEqual(enterResizeGirdleMode(), true, "resize girdle opened");
  assertEqual(enterRotateIndexMode(), false, "rotate by index is refused while resizing the girdle");
  assertEqual(get(rotateIndexOpen), false, "and did not open");
  cancelResizeGirdleMode();

  assertEqual(enterRotateIndexMode(), true, "rotate by index opened");
  assertEqual(enterEditMode(pavilion[0]), false, "edit mode is refused while rotating");
  assertEqual(get(editing), null, "and nothing is being edited");
  assertEqual(enterScaleHeightMode(), false, "scale height is refused while rotating");
  assertEqual(get(scaleHeightOpen), false, "and did not open");
  assertEqual(enterResizeGirdleMode(), false, "resize girdle is refused while rotating");
  assertEqual(get(resizeGirdleOpen), false, "and did not open");
  assertEqual(enterRotateIndexMode(), false, "nor does it open a second time");

  const order = sectionOrder('pavilion');

  applyReorder('pavilion', [...order].reverse());
  assertEqual(sectionOrder('pavilion'), order, "a reorder is refused");

  const notes = pavilion[0].cuttingInstructions;

  editNotes(pavilion[0], 'changed while rotating');
  assertEqual(pavilion[0].cuttingInstructions, notes, "a description edit is refused");

  const buttons = get(toolbar);

  for (const name of ['new', 'edit', 'delete', 'visibility', 'preform', 'frosted', 'comments']) {
    assertEqual(buttons[name].active, false, `${name} is inactive`);
    assertEqual(buttons[name].tip.includes('Finish rotating the design first'), true, `${name} says why`);
    assertEqual(buttons[name].tip.includes('Finish resizing the girdle first'), false, `${name} names the right mode`);
  }

  cancelRotateIndexMode();

  for (const name of ['new', 'edit', 'delete', 'visibility', 'preform', 'frosted', 'comments']) {
    assertEqual(get(toolbar)[name].tip.includes('Finish rotating the design first'), false,
      `${name} no longer says to finish rotating`);
  }

  assertEqual(get(toolbar).comments.active, true, "Comments, which needs no selection, is live again");

  render(null, null);
});

Deno.test("another design loaded under the mode closes it", async () => {
  // Setup: the startup stone loaded, the mode opened and the slider moved.
  // Test: render a second copy of the design, as File > Open or a shared link does.
  // Verifies: the mode closes on its own (its snapshot names the old design's tier objects, which
  // no longer mean anything), and a new session can then be opened on the new design at 0, whose
  // teeth are its own, unturned.
  await loadWithHistory();
  enterRotateIndexMode();
  changeRotation(9, true);

  const fresh = await startupDesign();

  render(fresh, null);
  assertEqual(get(rotateIndexOpen), false, "loading another design closed the mode");
  assertEqual(enterRotateIndexMode(), true, "and it opens again on the new one");
  assertEqual(get(rotationSteps), 0, "at 0");
  assertEqual(teethText(fresh.tiers[0]), "4-12-20-28-36-44-52-60-68-76-84-92", "on the new design's own teeth");
  cancelRotateIndexMode();

  render(null, null);
});

Deno.test("the ids and order of the tiers never change: only their teeth do", async () => {
  // Setup: the startup stone loaded, the mode opened.
  // Test: a turn, then Done; read the tiers' generated ids (P1, G1, ... T) and the design's tier
  // order, and each tier's gear-independent facts.
  // Verifies: a rotation changes no tier's id or place in the cutting order (a tier's id comes
  // from its angle and its place, neither of which moves), and the gear itself is not touched --
  // only indexes change, as the brief asks.
  const { design } = await loadWithHistory();
  const ids = tierIdsInFileOrder(design.tiers);
  const order = design.tiers.slice();
  const gear = JSON.stringify(design.gear);

  enterRotateIndexMode();
  changeRotation(-21, true);
  exitRotateIndexMode();

  assertEqual(tierIdsInFileOrder(design.tiers), ids, "the ids are the same");
  assertTrue(design.tiers.every((tier, t) => tier === order[t]), "the tiers are in the same order");
  assertEqual(JSON.stringify(design.gear), gear, "the gear is untouched");
  assertEqual(teethText(design.tiers[1]), "11-27-43-59-75-91", "G1 turned by -21 reads naturally");

  render(null, null);
});
