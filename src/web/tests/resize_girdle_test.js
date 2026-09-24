/*
 * resize_girdle_test.js -- tests for resize girdle mode (T-0237, 2026-09-23; narrowed by T-0241,
 * 2026-09-24; changed from a ratio to a height z by T-0242, 2026-09-24): the math in
 * web/src/lib/resize_girdle.js, and the mode around it in resize_girdle_mode.js.
 *
 * THE RULE UNDER TEST, as T-0242 left it (the user: "when stretching up and down the girdle,
 * instead of changing the depth uniformly [change it] such that all the meetpoints on the girdle
 * line up"). Only a PAVILION tier follows the gauge (T-0241's rule, unchanged); a crown tier, the
 * table and a girdle tier all keep their distance. But the gauge is now a HEIGHT z, not a ratio:
 * the whole pavilion moves by the vector (0, 0, -z) along the stone's optical axis, so every
 * pavilion tier's distance moves by `-z * normal.z` (`GemCadDesign.planesOf`'s own plane form,
 * `dot(normal, p) = offset`, translated by t moves offset by `dot(normal, t)`) -- NOT by a ratio,
 * and NOT by a per-angle formula invented independently of that plane. For an ordinary pavilion
 * tier this comes out to the ticket's own "distance + z cos(angle)" (cos even, `normal.z =
 * -cos(angle)`), but the flat-culet sentinel (angle 180, design.js's on-axis marker) needs
 * `GemCadDesign.polarAngleOf` to resolve the same way `planesOf` itself does -- see resize_girdle.js's
 * own header comment, and the "flat-culet sentinel" test below, for why a bare `cos(angle)` would
 * get that one case backwards.
 *
 * "when you're in resize mode can make changes and undo locally but only after done the changes
 * are all committed at once" (T-0237) still holds, unaffected by the ratio -> z change: z = 0 is
 * bit for bit the design, angles and indices never move, and the whole session is one edit-history
 * entry on Done while Undo/Redo step the gauge meanwhile.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The panel itself -- the gauge with no numbers, its z = 0 mark, Done and Cancel, and the menu
 * item -- and the side-profile pose T-0241 added are checked against the built page over CDP,
 * since they need a browser, the wasm module and a real renderer (`engine.app` is null here, so
 * the modes leave the view alone, the same as scale_height_test.js). Here there is no renderer, so
 * the stone is never rebuilt; the tests read the design, which is what the rebuild would be built
 * from, and build the mesh themselves with DesignMesh where the geometry matters.
 *
 * `window` is stubbed because the modes ask the page for a redraw (`window.gemRequestRender?.()`)
 * and Deno has no such global. ES modules hoist their imports, so this runs after the modules
 * below are evaluated -- soon enough, since none of them touches `window` at import time.
 */

globalThis.window = globalThis.window ?? {};

import { get } from "svelte/store";
import {
  RESIZE_MIN, RESIZE_MAX, RESIZE_STEP, RESIZE_TICK, RESIZE_MAJOR_EVERY, RESIZE_PX_PER_UNIT, RESIZE_MARK,
  INITIAL_Z, followsGauge, resizedTier, resizedValues,
} from "../src/lib/resize_girdle.js";
import { gaugeOf } from "../src/lib/scale_height.js";
import { visibleValueTicks } from "../src/lib/facet_edit.js";
import { tierIdsInFileOrder, isGirdleTier } from "../src/lib/tiers.js";
import {
  enterResizeGirdleMode, exitResizeGirdleMode, cancelResizeGirdleMode, changeZ, resizeGirdleOpen,
  girdleZ,
} from "../src/lib/resize_girdle_mode.js";
import {
  enterScaleHeightMode, cancelScaleHeightMode, scaleHeightOpen,
} from "../src/lib/scale_height_mode.js";
import { enterEditMode, exitEditMode, editing } from "../src/lib/edit_mode.js";
import {
  render, toolbar, highlightTier, applyReorder, sectionOrder, setEditRecorder, setHistoryFrames,
  applyEdit, editNotes,
} from "../src/lib/tier_controller.js";
import { undo, redo } from "../src/lib/session.js";
import { canUndo, canRedo } from "../src/lib/stores.js";

// The GemCad scripts, loaded as the page loads them: classic scripts publishing globals, in the
// order make_page.py's bundle runs them. `design.js` holds the design, `design_mesh.js` builds a
// stone from it, `gcs.js` reads the startup stone, and `edit_history.js` is the history Done
// records into.
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

/**
 * The z-component of a pavilion facet's outward unit normal, computed independently of
 * resize_girdle.js's own `normalZOf` (not exported, so this is a second, from-scratch expression
 * of the same quantity) straight from `GemCadDesign.polarAngleOf` -- the same function
 * `GemCadDesign.normalOf` itself uses -- so a test that compares against it is checking the
 * production code against the design representation's OWN convention, not against a copy of the
 * production code.
 */
function normalZOf(angle) {
  return Math.cos(GemCadDesign.polarAngleOf(angle) * Math.PI / 180);
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

// ---- which tiers follow the gauge

Deno.test("only a pavilion tier follows the gauge, by the same rule scale height uses", () => {
  // Setup: angles of every kind a tier can have -- crown tiers, the table (0), pavilion tiers
  // (negative, GemCad's convention), a flat culet (180, design.js's marker for "straight down"),
  // a girdle written either sign (GemCad writes -90; a .gcs can convert to +90), and angles a hair
  // either side of 90, one inside tiers.js's TIER_ANGLE_EPSILON and one outside it.
  // Test: followsGauge on each, against scale height's gaugeOf (T-0241: this mode follows the
  // gauge exactly where gaugeOf says 'pavilion', not merely "not a girdle"). T-0242 changed what
  // the gauge DOES to a tier, not which tiers follow it, so this test is unchanged from T-0241.
  // Verifies: the two agree on every angle, i.e. this mode did not invent a second classification
  // of "pavilion tier" (the ticket: "classify with the same pavilion/crown/girdle rule the rest of
  // the app uses"); a girdle and every crown tier (including the table) do not follow the gauge;
  // an ordinary pavilion tier and a flat culet do.
  const angles = [0, 14.92, 35, 55.07, 89.9, -90 + 1e-7, -90, 90, 90 - 1e-7, -89.9, -41.5, -36.54, 180];

  for (const angle of angles) {
    assertEqual(followsGauge({ angle }), gaugeOf({ angle }) === 'pavilion', `angle ${angle}: same as scale height`);
  }

  assertEqual([-90, 90, -90 + 1e-7].map(angle => followsGauge({ angle })), [false, false, false],
    "a girdle, either sign, does not follow the gauge");
  assertEqual([0, 14.92, 35, 55.07, 89.9].map(angle => followsGauge({ angle })), [false, false, false, false, false],
    "an ordinary crown tier, and the table, do not follow the gauge");
  assertEqual([-89.9, -41.5, -36.54, 180].map(angle => followsGauge({ angle })), [true, true, true, true],
    "an ordinary pavilion tier, and a flat culet (180), do");
});

// ---- the resize itself

Deno.test("only a pavilion distance moves; it moves by -z times its plane's own normal.z, not a ratio", () => {
  // Setup: one tier of each kind, each with an arbitrary distance, and z values spanning the
  // gauge's whole range, both signs, its two ends included.
  // Test: resizedTier at each z, compared against `distance - z * normalZOf(angle)` -- the plane-
  // translation formula derived in resize_girdle.js's header, computed here from scratch (see
  // `normalZOf` above) rather than by re-running resize_girdle.js's own arithmetic back at itself.
  // Verifies: a pavilion tier and a flat culet move by exactly that amount; a crown tier and the
  // table keep their distance untouched (T-0241, unaffected by T-0242's change); every angle comes
  // back exactly as given; a girdle, either sign, keeps its distance too.
  for (const z of [RESIZE_MIN, -0.1, -0.001, 0.001, 0.1, RESIZE_MAX]) {
    for (const angle of [-41.5, 180]) {
      const expected = 0.7129 - z * normalZOf(angle);
      const result = resizedTier({ angle, distance: 0.7129 }, z);

      assertClose(result.distance, expected, 1e-12, `pavilion angle ${angle} at z=${z}`);
      assertEqual(result.angle, angle, `angle ${angle} at z=${z}: untouched`);
    }

    for (const angle of [35, 0]) {
      assertEqual(resizedTier({ angle, distance: 0.7129 }, z), { angle, distance: 0.7129 },
        `crown angle ${angle} at z=${z}: untouched`);
    }

    assertEqual(resizedTier({ angle: -90, distance: 1.07 }, z), { angle: -90, distance: 1.07 },
      `girdle -90 at z=${z}`);
    assertEqual(resizedTier({ angle: 90, distance: 1.07 }, z), { angle: 90, distance: 1.07 },
      `girdle +90 at z=${z}`);
  }
});

Deno.test("for an ordinary pavilion tier, the shift equals the ticket's own 'distance + z cos(angle)'", () => {
  // Setup: pavilion tiers with genuine negative mast angles (not the flat-culet sentinel below).
  // Test: resizedTier's shift against `distance + z * Math.cos(angle in radians)` computed
  // directly from the tier's OWN stored (negative) angle, exactly as the ticket states the rule.
  // Verifies: for every ordinary pavilion angle this is the same number as the plane-translation
  // formula above, i.e. the two ways of stating the rule agree wherever the stored angle is a
  // genuine mast angle -- see the next test for the one case where they do not.
  const z = 0.15;

  for (const angle of [-1, -14.92, -41.5, -55.07, -89.9]) {
    const distance = 0.9;
    const viaPlane = resizedTier({ angle, distance }, z).distance;
    const viaTicket = distance + z * Math.cos(angle * Math.PI / 180);

    assertClose(viaPlane, viaTicket, 1e-12, `angle ${angle}: plane translation matches distance + z cos(angle)`);
  }
});

Deno.test("the flat-culet sentinel (angle 180) is the on-axis pole, not 'z cos(180 degrees)'", () => {
  // Setup: a flat culet tier -- angle 180, design.js's own marker for a facet that points straight
  // down the optical axis (kb/the-polar-internal-representation.md: mast angle -90 is ALSO used
  // for a genuine off-axis girdle facet, so 180 is the representation's separate, unambiguous
  // marker for the on-axis case). It is not a real mast angle a cutter would dial.
  // Test: resizedTier's shift for it, against two things: the correct value (the flat, downward
  // facing normal is exactly (0, 0, -1), so normal.z = -1 and the shift is -z * -1 = +z), and the
  // WRONG value a reader would get by plugging 180 straight into the ticket's "z cos(angle)"
  // shorthand as if it were an ordinary angle (cos(180 degrees) = -1, giving a shift of -z).
  // Verifies: resizedTier gives the CORRECT +z shift (it goes through GemCadDesign.polarAngleOf,
  // which special-cases 180 exactly as planesOf/normalOf do -- see resize_girdle.js's header), and
  // that this is measurably different from the wrong shortcut, so a future refactor that swaps in
  // a bare `Math.cos(angle * DEGREES)` would be caught here.
  const z = 0.1;
  const distance = 0.4;
  const result = resizedTier({ angle: 180, distance }, z);
  const wrongShortcut = distance + z * Math.cos(180 * Math.PI / 180); // = distance - z

  assertClose(result.distance, distance + z, 1e-12, "the flat culet moves by +z: its normal is (0,0,-1), the plainest case");
  assertTrue(Math.abs(result.distance - wrongShortcut) > 1e-6,
    "and that is NOT the same number a bare cos(180 degrees) shortcut would give");
});

Deno.test("z = 0 changes nothing, bit for bit", () => {
  // Setup: tiers of every kind, with distances that are not exact binary fractions (0.1 + 0.2 is
  // the classic one that is not 0.3).
  // Test: resizedTier at z = 0.
  // Verifies: the very values given come back. The gauge starts at z = 0 each time the mode opens,
  // and a design that came back an ulp off would read as an edit on Done.
  for (const angle of [0, 33.333333, -41.123456789, -90, 90, 180]) {
    for (const distance of [0.1 + 0.2, 0.123456789, 1 / 3]) {
      const tier = { angle, distance };

      assertEqual(resizedTier(tier, 0), tier, `angle ${angle}, distance ${distance}`);
      assertTrue(Object.is(resizedTier(tier, 0).distance, distance), "the very same number");
    }
  }
});

Deno.test("every setting is computed from the snapshot, never from the last one", () => {
  // Setup: a pristine snapshot of three tiers: a crown tier, a girdle and a pavilion tier.
  // Test: compute a far-off setting (the top of the range), then 0.1 -- once directly and once
  // after the far-off one, as a drag that went there and came back would -- and then 0.
  // Verifies: the two 0.1 results agree exactly (stepping from the previous result would compound
  // the shift rather than recompute it, and drift); 0 gives the snapshot back; the crown and the
  // girdle never move (T-0241, only the pavilion does); and the tiers come back in order, as
  // setTierValues takes them.
  const pristine = [
    { tier: 'c', angle: 36, distance: 0.9 },
    { tier: 'g', angle: -90, distance: 1 },
    { tier: 'p', angle: -42, distance: 0.95 },
  ];

  resizedValues(pristine, RESIZE_MAX);

  const direct = resizedValues(pristine, 0.1);
  const again = resizedValues(pristine, 0.1);

  assertEqual(again, direct, "the same z gives the same values whatever came before");
  assertClose(direct.find(v => v.tier === 'p').distance, 0.95 - 0.1 * normalZOf(-42), 1e-12,
    "the pavilion tier moved by -z * normalZOf(angle)");
  assertEqual(direct.map(value => value.distance)[0], 0.9, "crown kept");
  assertEqual(direct.map(value => value.distance)[1], 1, "girdle kept");
  assertEqual(resizedValues(pristine, 0), pristine, "z = 0 is the snapshot");
  assertEqual(direct.map(value => value.tier), ['c', 'g', 'p'], "tiers come back in order");
});

Deno.test("on the startup stone, the pavilion moves as a rigid body: every corner shifts by exactly (0, 0, -z)", async () => {
  // Setup: src/resources/hex_cut_v2.gcs, the page's startup stone, and the stone DesignMesh builds
  // from it at z = 0 and at a handful of test z values chosen to stay inside the region where no
  // tier's facet count changes (see resize_girdle.js's own measured table): the girdle would
  // otherwise lose its faces below about z = -0.046, which would let a pavilion facet's polygon
  // gain a new corner where the girdle used to cut it, breaking the corner-for-corner comparison
  // this test relies on.
  // Test: for each pavilion facet's polygon corner in the shifted mesh, find the SAME corner (by
  // its x, y -- untouched by a pure z translation, so an exact match) in the z = 0 mesh, and
  // compare z.
  // Verifies: this is the acceptance criterion itself -- "every pavilion mesh corner equals an old
  // one shifted by exactly (0,0,-z) to 1e-9" -- checked corner by corner rather than only through
  // aggregate measurements (top/bottom/band) the way the following test does.
  const design = await startupDesign();

  function buildAt(z) {
    const copy = GemCadDesign.fromJSON(GemCadDesign.toJSON(design));
    const pristine = copy.tiers.map(tier => ({ tier, angle: tier.angle, distance: tier.distance }));

    for (const { tier, angle, distance } of resizedValues(pristine, z)) {
      tier.angle = angle;
      tier.distance = distance;
    }

    return { faces: DesignMesh.buildFaces(copy).faces, tiers: copy.tiers };
  }

  // A point's own x or y can land a few ulps either side of exactly 0 (the on-axis culet: x and y
  // should both be 0, but the plane intersection arithmetic leaves noise like -5.68e-14) --
  // `toFixed` keeps the sign of a tiny NEGATIVE value even once it rounds to all zero digits
  // ("-0.000000000"), which would silently split one point into two different map keys. Clamping
  // anything under the tolerance to plain 0 first avoids that.
  function xyKey(x, y) {
    const nx = Math.abs(x) < 1e-9 ? 0 : x;
    const ny = Math.abs(y) < 1e-9 ? 0 : y;

    return `${nx.toFixed(9)},${ny.toFixed(9)}`;
  }

  const base = buildAt(0);
  // Keyed by rounded (x, y): a pure z-translation leaves x and y bit-identical (up to the noise
  // above), so this is an exact lookup, not a nearest-neighbour match.
  const baseByXY = new Map();

  for (const face of base.faces) {
    if (!followsGauge({ angle: base.tiers[face.tier].angle })) {
      continue;
    }

    for (const corner of face.polygon) {
      baseByXY.set(xyKey(corner.x, corner.y), corner.z);
    }
  }

  for (const z of [-0.03, -0.01, 0.05, 0.1, 0.2, RESIZE_MAX]) {
    const at = buildAt(z);
    let checked = 0;

    for (const face of at.faces) {
      if (!followsGauge({ angle: at.tiers[face.tier].angle })) {
        continue;
      }

      for (const corner of face.polygon) {
        const key = xyKey(corner.x, corner.y);
        const baseZ = baseByXY.get(key);

        assertTrue(baseZ !== undefined, `z=${z}: pavilion corner (${corner.x}, ${corner.y}) has no match at z=0`);
        assertClose(corner.z, baseZ - z, 1e-9, `z=${z}: corner (${corner.x}, ${corner.y}) shifted by exactly -z`);
        checked++;
      }
    }

    assertTrue(checked > 0, `z=${z}: at least one pavilion corner was actually checked`);
  }
});

Deno.test("on the startup stone, every pavilion-girdle meetpoint lies at one height: the girdle stays level", async () => {
  // Setup: the startup stone, and the stone DesignMesh builds from it at several z, both signs.
  // Test: for each z, the girdle tier's (G1) own polygon corners.
  // Verifies what T-0242 exists for: the girdle band has exactly TWO distinct heights among its
  // corners (its top ring, where it meets the unmoved crown, and its bottom ring, where it meets
  // the pavilion that just moved as one rigid body) -- never a THIRD, in-between height, which is
  // what an uneven girdle (T-0237/T-0241's ratio scheme) would have produced whenever two pavilion
  // tiers of different mast angles both met the girdle. Also re-checks the table's height is
  // unchanged and the culet is exactly z deeper (the plainest case of the rule, since the culet's
  // normal is (0,0,-1) and it sits alone on the optical axis), the same aggregate measurements the
  // old (T-0241) version of this test made, now against the new rule.
  const design = await startupDesign();
  const ids = tierIdsInFileOrder(design.tiers);
  const girdleTierIndex = ids.indexOf('G1');

  function measure(z) {
    const copy = GemCadDesign.fromJSON(GemCadDesign.toJSON(design));
    const pristine = copy.tiers.map(tier => ({ tier, angle: tier.angle, distance: tier.distance }));

    for (const { tier, angle, distance } of resizedValues(pristine, z)) {
      tier.angle = angle;
      tier.distance = distance;
    }

    const faces = DesignMesh.buildFaces(copy).faces;
    const zs = faces.flatMap(face => face.polygon).map(p => p.z);
    const girdle = faces.filter(face => face.tier === girdleTierIndex).flatMap(face => face.polygon).map(p => p.z);

    return {
      top: Math.max(...zs),
      bottom: Math.min(...zs),
      girdleZs: girdle,
      band: girdle.length > 0 ? Math.max(...girdle) - Math.min(...girdle) : 0,
    };
  }

  const one = measure(0);
  let previousBand = -Infinity;

  for (const z of [-0.15, -0.1, -0.05, -0.044, 0, 0.05, 0.1, 0.15, 0.2, 0.25, RESIZE_MAX]) {
    const m = measure(z);

    assertClose(m.top, one.top, 1e-9, `the table's height is unchanged at z=${z} (the crown never moves)`);
    assertClose(m.bottom, one.bottom - z, 1e-9, `the culet is exactly z=${z} deeper (it is on-axis, normal (0,0,-1))`);
    assertTrue(m.band >= previousBand - 1e-9, `the girdle band grows with z (at z=${z}: ${m.band})`);
    previousBand = m.band;

    if (m.girdleZs.length > 0) {
      const girdleTop = Math.max(...m.girdleZs);
      const girdleBottom = Math.min(...m.girdleZs);

      for (const gz of m.girdleZs) {
        assertTrue(Math.abs(gz - girdleTop) < 1e-9 || Math.abs(gz - girdleBottom) < 1e-9,
          `z=${z}: girdle corner at ${gz} is not on the level top or bottom ring (top=${girdleTop}, bottom=${girdleBottom})`);
      }
    }
  }

  assertEqual(measure(-0.1).band, 0, "at z=-0.1 the girdle cuts nothing, and the stone still builds");
});

// ---- the gauge's constants

Deno.test("the gauge's range, step and ticks fit together, with z = 0 on a tick", () => {
  // Setup: the constants ResizeGirdlePanel passes its ValueRuler.
  // Test: the ticks ValueRuler would draw around z = 0 and at both ends (visibleValueTicks, what
  // it calls), and the screen spacing tick x pxPerUnit.
  // Verifies: the gauge starts at z = 0, inside the range, and the z = 0 mark falls on a major tick
  // (so it overdraws a long tick rather than floating between ticks -- visibleValueTicks marks a
  // tick major purely by `(value / tick) % majorEvery === 0`, which 0 always satisfies regardless
  // of where the range starts); the ends are ticks, so the tape does not stop between two; ticks
  // are 10px apart like every other gauge on the page; and the step divides the tick, so a snapped
  // value can sit exactly on a tick. T-0242: RESIZE_MIN and RESIZE_MAX are NOT the same distance
  // either way from 0 -- below 0 the band saturates at "gone" while above 0 it keeps growing with
  // no natural stopping point, the same asymmetry T-0241's ratio range had for the same reason --
  // resize_girdle.js's own comment has how the two ends were picked.
  assertEqual([INITIAL_Z, RESIZE_MARK], [0, 0], "the gauge starts at, and marks, z = 0");
  assertTrue(RESIZE_MIN < 0 && 0 < RESIZE_MAX, "z = 0 is inside the range");

  const halfSpan = 150 / RESIZE_PX_PER_UNIT;
  const aroundZero = visibleValueTicks(0, halfSpan, RESIZE_TICK, RESIZE_MAJOR_EVERY, RESIZE_MIN, RESIZE_MAX);

  assertEqual(aroundZero.find(tick => tick.value === 0)?.major, true, "z = 0 is a major tick");
  assertEqual(visibleValueTicks(RESIZE_MIN, halfSpan, RESIZE_TICK, RESIZE_MAJOR_EVERY, RESIZE_MIN, RESIZE_MAX)[0].value,
    RESIZE_MIN, "the bottom end is a tick");
  assertEqual(visibleValueTicks(RESIZE_MAX, halfSpan, RESIZE_TICK, RESIZE_MAJOR_EVERY, RESIZE_MIN, RESIZE_MAX).at(-1).value,
    RESIZE_MAX, "the top end is a tick");
  assertClose(RESIZE_TICK * RESIZE_PX_PER_UNIT, 10, 1e-9, "ticks 10px apart");
  assertClose(RESIZE_TICK / RESIZE_STEP, Math.round(RESIZE_TICK / RESIZE_STEP), 1e-9, "a tick is a whole number of steps");
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

/** Every tier's angle and distance, and its facets' indices, to compare a design before and after. */
const snapshot = design => design.tiers.map(tier => [tier.angle, tier.distance, tier.facets.map(f => f.index)]);

/** The girdle tiers of a design (the shared rule, NOT "every tier this mode leaves alone" -- since
 * T-0241 that is also true of the crown, so a girdle check needs its own, separate function). */
const girdles = design => design.tiers.filter(isGirdleTier);

Deno.test("Done is one history entry that a single undo takes back", async () => {
  // Setup: the startup stone loaded, the mode opened.
  // Test: move the gauge twice (each a finished change, as a drag's release is), press Done, then
  // take one step of the edit history back and one forward.
  // Verifies:
  //   * while open, the design follows the gauge: every PAVILION distance is the pristine one
  //     minus the LAST z times its own normalZOf(angle) (not the sum of both moves), and the
  //     crown, the table, the girdle, every angle and every index are exactly as they were;
  //   * Done closes the mode and leaves exactly ONE entry, labelled "Resize girdle", holding only
  //     distance updates, and none for a crown, table or girdle tier;
  //   * one undo restores every tier exactly, and that was the only entry; one redo resizes again.
  const { design, history } = await loadWithHistory();
  const original = snapshot(design);
  const pristine = design.tiers.map(tier => tier.distance);

  assertEqual(enterResizeGirdleMode(), true, "the mode opened");
  assertEqual([get(resizeGirdleOpen), get(girdleZ)], [true, 0], "open, at z = 0");

  changeZ(0.2, true);
  changeZ(0.1, true);

  design.tiers.forEach((tier, t) => {
    const expected = followsGauge(tier) ? pristine[t] - 0.1 * normalZOf(tier.angle) : pristine[t];

    assertClose(tier.distance, expected, 1e-12, `tier ${t}'s distance follows the gauge from the snapshot`);
    assertEqual([tier.angle, tier.facets.map(f => f.index)], [original[t][0], original[t][2]],
      `tier ${t}'s angle and indices are untouched`);
  });
  assertTrue(girdles(design).length > 0, "the startup stone has a girdle to leave alone");
  assertTrue(design.tiers.some(tier => !isGirdleTier(tier) && !followsGauge(tier)), "and a crown tier too");

  const resized = snapshot(design);

  exitResizeGirdleMode();
  assertEqual(get(resizeGirdleOpen), false, "Done closed the mode");
  assertEqual(history.undoLabel(), 'Resize girdle', "the entry is labelled");

  const ops = history.undo();

  assertTrue(ops.every(op => op.target === 'tierValue' && op.field === 'distance'), "only distances were recorded");
  assertTrue(ops.every(op => followsGauge(op.tier)), "and none for a crown, table or girdle tier");
  applyEdit(ops);
  assertEqual(snapshot(design), original, "one undo restores every tier");
  assertEqual(history.canUndo(), false, "and that was the only entry");

  applyEdit(history.redo());
  assertEqual(snapshot(design), resized, "one redo resizes it again");

  render(null, null);
});

Deno.test("Done at z = 0 records nothing", async () => {
  // Setup: the startup stone loaded, the mode opened.
  // Test: move the gauge away and back to z = 0 (two finished changes), then Done.
  // Verifies: the design is bit for bit as it opened, and the edit history has nothing to undo --
  // an empty "Resize girdle" entry would be an Undo that does nothing.
  const { design, history } = await loadWithHistory();
  const original = snapshot(design);

  enterResizeGirdleMode();
  changeZ(-0.1, true);
  changeZ(0, true);
  exitResizeGirdleMode();

  assertEqual(snapshot(design), original, "the design is as it opened");
  assertEqual(history.canUndo(), false, "nothing was recorded");

  render(null, null);
});

Deno.test("Cancel puts every tier back exactly and records nothing", async () => {
  // Setup: the startup stone loaded, the mode opened.
  // Test: a finished change, then an unfinished drag step (written on a budgeted turn, never
  // recorded) with a wait long enough for that turn to run, then Cancel.
  // Verifies: every tier's angle, distance and indices are back, bit for bit; nothing is in the
  // history; the mode is closed and the gauge's store no longer matters.
  const { design, history } = await loadWithHistory();
  const original = snapshot(design);

  enterResizeGirdleMode();
  changeZ(0.15, true);
  changeZ(-0.1, false);
  await new Promise(resolve => setTimeout(resolve, 40));
  cancelResizeGirdleMode();

  assertEqual(snapshot(design), original, "every tier is back as it was");
  assertEqual([history.canUndo(), history.canRedo()], [false, false], "nothing was recorded");
  assertEqual(get(resizeGirdleOpen), false, "Cancel closed the mode");

  render(null, null);
});

Deno.test("Undo and Redo step the gauge while the mode is open, not the edit history", async () => {
  // Setup: the startup stone loaded, an unrelated entry already in the edit history (a toolbar
  // flag), then the mode opened.
  // Test: three finished gauge changes, then Edit > Undo three times and Redo once, through
  // session.js's own `undo` and `redo` -- where the menu items and Cmd/Ctrl+Z go.
  // Verifies: each undo steps the gauge back one change and the design with it (recomputed from
  // the snapshot, so back at z = 0 it is bit for bit the design the mode opened on); the menu's
  // Undo/Redo greying follows the local stack; and the entry recorded before the mode opened is
  // never touched -- after Cancel it is still there to undo.
  const { design, history } = await loadWithHistory();

  history.record({ label: 'Earlier edit', ops: [{ kind: 'update', target: 'tierFlag', tier: design.tiers[0], flag: 'frosted', before: false, after: true }] });

  const original = snapshot(design);

  enterResizeGirdleMode();
  assertEqual([get(canUndo), get(canRedo)], [false, false], "nothing to undo in the mode yet");

  changeZ(0.1, true);
  const afterFirst = snapshot(design);

  changeZ(0.2, true);
  changeZ(-0.05, true);
  assertEqual(get(canUndo), true, "the menu's Undo is live");

  undo();
  assertEqual(get(girdleZ), 0.2, "undo: the second change");
  undo();
  assertEqual(get(girdleZ), 0.1, "undo: the first change");
  assertEqual(snapshot(design), afterFirst, "and the design is as it was after it");
  undo();
  assertEqual(get(girdleZ), 0, "undo: back to z = 0");
  assertEqual(snapshot(design), original, "and to the design the mode opened on");
  assertEqual([get(canUndo), get(canRedo)], [false, true], "nothing more to undo, something to redo");
  redo();
  assertEqual(get(girdleZ), 0.1, "redo: the first change again");

  cancelResizeGirdleMode();
  assertEqual(snapshot(design), original, "Cancel put it all back");
  assertEqual(history.undoLabel(), 'Earlier edit', "the edit history below the mode was never touched");

  render(null, null);
});

Deno.test("resize girdle, scale height and edit mode refuse each other, and the design is held", async () => {
  // Setup: the startup stone loaded, a pavilion tier selected.
  // Test: open each of the other two modes and try this one; then open this one and try each of
  // them, a reorder and a description edit, and read the tier toolbar; then Cancel.
  // Verifies: one mode at a time, every way round (the ticket: "it refuses to open while edit
  // mode, scale height ... is open, and they refuse while it is"); while this mode is open a
  // reorder and a description edit are refused, and every toolbar button is inactive and says to
  // finish resizing the girdle -- not scale height's wording; and once it closes the buttons stop
  // saying so.
  const { design } = await loadWithHistory();
  const pavilion = design.tiers.filter(tier => tier.angle < 0 && tier.angle > -90);

  highlightTier(pavilion[0]);
  assertEqual(enterEditMode(pavilion[0]), true, "edit mode opened");
  assertEqual(enterResizeGirdleMode(), false, "resize girdle is refused while editing");
  exitEditMode();

  assertEqual(enterScaleHeightMode(), true, "scale height opened");
  assertEqual(enterResizeGirdleMode(), false, "resize girdle is refused while scaling the height");
  assertEqual(get(resizeGirdleOpen), false, "and did not open");
  cancelScaleHeightMode();

  assertEqual(enterResizeGirdleMode(), true, "resize girdle opened");
  assertEqual(enterEditMode(pavilion[0]), false, "edit mode is refused while resizing");
  assertEqual(get(editing), null, "and nothing is being edited");
  assertEqual(enterScaleHeightMode(), false, "scale height is refused while resizing");
  assertEqual(get(scaleHeightOpen), false, "and did not open");
  assertEqual(enterResizeGirdleMode(), false, "nor does it open a second time");

  const order = sectionOrder('pavilion');

  applyReorder('pavilion', [...order].reverse());
  assertEqual(sectionOrder('pavilion'), order, "a reorder is refused");

  const notes = pavilion[0].cuttingInstructions;

  editNotes(pavilion[0], 'changed while resizing');
  assertEqual(pavilion[0].cuttingInstructions, notes, "a description edit is refused");

  const buttons = get(toolbar);

  for (const name of ['new', 'edit', 'delete', 'visibility', 'preform', 'frosted', 'comments']) {
    assertEqual(buttons[name].active, false, `${name} is inactive`);
    assertEqual(buttons[name].tip.includes('Finish resizing the girdle first'), true, `${name} says why`);
    assertEqual(buttons[name].tip.includes('Finish scaling the height first'), false, `${name} names the right mode`);
  }

  cancelResizeGirdleMode();

  for (const name of ['new', 'edit', 'delete', 'visibility', 'preform', 'frosted', 'comments']) {
    assertEqual(get(toolbar)[name].tip.includes('Finish resizing the girdle first'), false,
      `${name} no longer says to finish resizing`);
  }

  assertEqual(get(toolbar).comments.active, true, "Comments, which needs no selection, is live again");

  render(null, null);
});

Deno.test("another design loaded under the mode closes it", async () => {
  // Setup: the startup stone loaded, the mode opened and the gauge moved.
  // Test: render a second copy of the design, as File > Open or a shared link does.
  // Verifies: the mode closes on its own (its snapshot names the old design's tier objects, which
  // no longer mean anything), and a new session can then be opened on the new design at z = 0.
  await loadWithHistory();
  enterResizeGirdleMode();
  changeZ(0.1, true);

  render(await startupDesign(), null);
  assertEqual(get(resizeGirdleOpen), false, "loading another design closed the mode");
  assertEqual(enterResizeGirdleMode(), true, "and it opens again on the new one");
  assertEqual(get(girdleZ), 0, "at z = 0");
  cancelResizeGirdleMode();

  render(null, null);
});
