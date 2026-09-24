/*
 * cutting_assistant_test.js -- tests for the cutting assistant (T-0234): the pure sequence,
 * navigation and geometry in src/web/src/lib/cutting_assistant.js, and the mode around them in
 * cutting_assistant_mode.js.
 *
 * The user (2026-09-23): "the cutting assistant will not modify the actual faceting instructions.
 * its purpose is to tell users the steps to cut the rock and what the rock will look like at each
 * step. ... each time the user clicks next cut, it applies one more cut from the cutting
 * instructions to the rendered rock. similarly, when the user clicks next tier (or prev tier) it
 * skips all cuts in the current tier. once each tier is complete, clicking next cut automatically
 * advances to the first cut of the next tier. ... clicking on a tier scrubs to the first facet in
 * that tier. once we cut all the cuts in the pavilion, the dop switches from the pavilion to the
 * crown."
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * Two halves, grouped that way below:
 *
 *   1. The pure module, on the startup stone (src/resources/hex_cut_v2.gcs, checked in, so this
 *      runs on a fresh clone) and on small hand-made designs where the answer can be written down:
 *      the order of the cuts, every navigation rule of the ticket, the tier and tooth states the
 *      pane and the bar show, the rough, the dop and the framing -- and, through the page's own
 *      half-space builder, that every step's rough is a closed solid that only ever shrinks and
 *      ends as exactly the finished stone.
 *
 *   2. The mode, driving the page's real modules (session.js, tier_controller.js, the mode itself)
 *      against a FAKE GemApp that records what it is asked to do: what opening it holds and hands
 *      over, what each step loads and where the dop and the view go, that a burst of slider moves
 *      builds once, and that Done puts back exactly what was there. What the fake cannot show --
 *      the pixels, the bar, the keys -- is checked in the built page over CDP (tests/harness).
 *
 * Globals the modules expect:
 * - `window`: the page asks for redraws through `window.gemRequestRender?.()`.
 * - `setTimeout`: replaced by a queue this file runs by hand (`runTimers`), so a test decides when
 *   the mode's budgeted builder -- and the render loop, drawn into a stub canvas -- get their turn.
 *   That is what lets a test ask for five positions in a row and then see how many builds ran.
 * - The GemCad scripts, which the page loads as classic scripts publishing globals: evaluated here
 *   in the page's own order.
 */

let timers = [];

globalThis.window = globalThis.window ?? {};
globalThis.window.addEventListener = () => {};
globalThis.setTimeout = fn => { timers.push(fn); return timers.length; };
globalThis.clearTimeout = () => {};

/** Runs every queued timer, and the ones those queue, until none is left (or 100 rounds). */
function runTimers() {
  for (let round = 0; round < 100 && timers.length > 0; round++) {
    const due = timers;

    timers = [];
    due.forEach(fn => fn());
  }
}

for (const name of ["gemcad.js", "gemcad_obj.js", "design.js", "gcs.js", "design_mesh.js", "edit_history.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${name}`, import.meta.url)));
}

const { GemCadDesign, DesignMesh } = globalThis;

const { get } = await import("svelte/store");
const ca = await import("../src/lib/cutting_assistant.js");
const { objTextFromBytes } = await import("../src/lib/design_load.js");
const { installLoadedDesign, startSession, undo } = await import("../src/lib/session.js");
const { engine, canUndo, canRedo } = await import("../src/lib/stores.js");
const { attachCanvasControls } = await import("../src/lib/viewport.js");
const tiers = await import("../src/lib/tier_controller.js");
const { enterEditMode, exitEditMode, editing } = await import("../src/lib/edit_mode.js");
const { enterScaleHeightMode, cancelScaleHeightMode } = await import("../src/lib/scale_height_mode.js");
const mode = await import("../src/lib/cutting_assistant_mode.js");

const STARTUP_URL = new URL("../../resources/hex_cut_v2.gcs", import.meta.url);

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message}: expected ${expected} within ${tolerance}, got ${actual}`);
  }
}

/** Reads the startup stone as the page does: `{ text, design, gear, ... }`. */
async function startupStone() {
  return objTextFromBytes("hex_cut_v2.gcs", await Deno.readFile(STARTUP_URL));
}

/**
 * A small hand-made design on a 4-tooth gear, for rules whose answer should be written down rather
 * than read off a real stone: pavilion P1 (2 facets), girdle G1 (4), a HIDDEN pavilion tier (1),
 * crown C1 (2), an EMPTY crown tier, and the table T (1) -- listed in that file order.
 */
function toyDesign() {
  const tier = (angle, indices, extra = {}) => ({
    angle, distance: 1, preform: false, hidden: false, frosted: false, cuttingInstructions: "",
    facets: indices.map(index => ({ index, name: "" })), ...extra,
  });

  return {
    gear: { teeth: 4, reversed: false, originIndex: 0 },
    tiers: [
      tier(-45, [0, 2]),
      tier(-90, [0, 1, 2, 3]),
      tier(-30, [1], { hidden: true }),
      tier(40, [1, 3]),
      tier(20, []),
      tier(0, [0]),
    ],
  };
}

// ===========================================================================
// 1. The pure module
// ===========================================================================

Deno.test("the sequence is the pavilion section then the crown section, each in pane order, tooth by tooth", () => {
  // Setup: the toy design above, whose file order interleaves nothing but does hold a hidden tier
  // and an empty one.
  // Test: buildCutSequence.
  // Verifies the ticket's order exactly: the pavilion phase is P1 then G1 (the girdle is cut with
  // the pavilion, before the transfer); the hidden pavilion tier is skipped (it is not on the
  // stone); the crown phase is C1 then T (the empty crown tier has nothing to cut and is left
  // out); each tier's facets come in the order its teeth are listed; `transfer` is the index of
  // the first crown cut; and each tier entry covers exactly its own run of cuts. The ids are the
  // pane's own labels, so the bar names a tier the way its row does.
  const design = toyDesign();
  const sequence = ca.buildCutSequence(design);

  assertEqual(sequence.tiers.map(entry => [entry.id, entry.phase, entry.start, entry.end]),
    [["P1", "pavilion", 0, 2], ["G1", "pavilion", 2, 6], ["C1", "crown", 6, 8], ["T", "crown", 8, 9]],
    "tiers, phases and ranges");
  assertEqual(sequence.cuts.map(cut => cut.facet.index), [0, 2, 0, 1, 2, 3, 1, 3, 0], "teeth in listed order");
  assertEqual([sequence.transfer, sequence.total], [6, 9], "transfer and total");
  assert(sequence.cuts[0].tier === design.tiers[0] && sequence.cuts[0].facet === design.tiers[0].facets[0],
    "cuts hold the design's own tier and facet objects, not copies");
  assert(sequence.cuts.every(cut => sequence.tiers[cut.tierAt].tier === cut.tier), "tierAt points at each cut's own tier");
});

Deno.test("the startup stone's sequence is every rendered facet, pavilion first, in the pane's order", async () => {
  // Setup: hex_cut_v2.gcs, whose ten tiers are P1 G1 P2 C1 C2 C3 C4 C5 C6 T in file order.
  // Test: buildCutSequence.
  // Verifies on a real design: the tiers come P1 G1 P2 (the pavilion section, girdle between
  // them where the file cuts it) then C1..C6 and T; every facet of the stone is a cut, once; and
  // the transfer falls between the last pavilion facet and C1's first.
  const { design } = await startupStone();
  const sequence = ca.buildCutSequence(design);

  assertEqual(sequence.tiers.map(entry => entry.id), ["P1", "G1", "P2", "C1", "C2", "C3", "C4", "C5", "C6", "T"],
    "the pane's own order, pavilion section first");
  assertEqual(sequence.total, GemCadDesign.facetCount(design), "every facet is one cut");

  const pavilionFacets = design.tiers.filter(tier => tier.angle < 0 || Math.abs(Math.abs(tier.angle) - 90) < 1e-6)
    .reduce((sum, tier) => sum + tier.facets.length, 0);

  assertEqual(sequence.transfer, pavilionFacets, "the transfer is after the last pavilion (and girdle) facet");
  assertEqual(sequence.tiers[3].start, sequence.transfer, "C1's first facet is the first crown cut");
});

Deno.test("> and < move one cut and stop at the ends; finishing a tier's last facet moves on to the next tier", () => {
  // Setup: the toy sequence (9 cuts; tiers at 0-2, 2-6, 6-8, 8-9).
  // Test: nextCut and prevCut from several positions, including both ends.
  // Verifies: > is k + 1 clamped at N, < is k - 1 clamped at 0; and cutting P1's last facet (k 1
  // to 2) makes G1's first facet the current cut, i.e. the current tier becomes G1 with no extra
  // step -- the user's "once each tier is complete, clicking next cut automatically advances to
  // the first cut of the next tier".
  const sequence = ca.buildCutSequence(toyDesign());

  assertEqual([0, 4, 8, 9].map(k => ca.nextCut(sequence, k)), [1, 5, 9, 9], "next cut, clamped at N");
  assertEqual([0, 1, 5, 9].map(k => ca.prevCut(sequence, k)), [0, 0, 4, 8], "previous cut, clamped at 0");
  assertEqual(ca.tierAt(sequence, 1), 0, "at k 1 the current cut is P1's second facet");
  assertEqual(ca.tierAt(sequence, ca.nextCut(sequence, 1)), 1, "one more cut and G1 is current");
  assertEqual(ca.tierAt(sequence, 9), sequence.tiers.length, "at N there is no current tier");
});

Deno.test(">> cuts the rest of the current tier; at the last tier it finishes the stone", () => {
  // Setup: the toy sequence.
  // Test: nextTier from the start of a tier, the middle of one, the last tier, and N.
  // Verifies the ticket's rule: k becomes the start of the next tier (so everything left of the
  // current tier is cut), whether the current tier had been started or not; from inside the
  // last tier (T, at k 8) it is N; and at N it stays N.
  const sequence = ca.buildCutSequence(toyDesign());

  assertEqual(ca.nextTier(sequence, 0), 2, "from P1's start to G1's start");
  assertEqual(ca.nextTier(sequence, 3), 6, "from inside G1 to C1's start");
  assertEqual(ca.nextTier(sequence, 8), 9, "from the last tier to the finished stone");
  assertEqual(ca.nextTier(sequence, 9), 9, "at N it stays");
});

Deno.test("<< goes back to the start of the current tier, and from there to the start of the one before", () => {
  // Setup: the toy sequence.
  // Test: prevTier from inside a tier, from a tier's own start, from 0, and from N.
  // Verifies the ticket's rule: "if k is past the start of the current tier, k = start of current
  // tier; otherwise start of the previous tier". Inside G1 (k 4) it is G1's start (2); at G1's
  // start it is P1's start (0); at 0 it stays 0; and at N, where no tier is current, the tier
  // before is the last one, so it is T's start (8).
  const sequence = ca.buildCutSequence(toyDesign());

  assertEqual(ca.prevTier(sequence, 4), 2, "inside G1: back to G1's start");
  assertEqual(ca.prevTier(sequence, 2), 0, "at G1's start: back to P1's start");
  assertEqual(ca.prevTier(sequence, 0), 0, "at 0 it stays");
  assertEqual(ca.prevTier(sequence, 9), 8, "at N: back to the last tier's start");
});

Deno.test("a tier row's click goes to its first facet, and positions are clamped whole numbers", () => {
  // Setup: the toy sequence.
  // Test: tierStart for each tier, and clampPosition on out-of-range, fractional and bad input.
  // Verifies: clicking a row (tierStart) lands on that tier's first facet with none of it cut; and
  // the slider's value, however it arrives, becomes a whole position inside 0..N.
  const sequence = ca.buildCutSequence(toyDesign());

  assertEqual(sequence.tiers.map((_, t) => ca.tierStart(sequence, t)), [0, 2, 6, 8], "each tier's first facet");
  assertEqual([-3, 2.6, 40, NaN].map(k => ca.clampPosition(sequence, k)), [0, 3, 9, 0], "clamped and rounded");
});

Deno.test("the phase turns to the crown exactly when the last pavilion facet is cut", () => {
  // Setup: the toy sequence, transfer at 6.
  // Test: phaseAt either side of the transfer, and at both ends.
  // Verifies: k 5 (G1's last facet still to cut) is the pavilion; k 6 (every pavilion and girdle
  // facet cut, C1's first current) is the crown -- the moment the user said the dop switches; and
  // the finished stone is in the crown phase too.
  const sequence = ca.buildCutSequence(toyDesign());

  assertEqual([0, 5, 6, 9].map(k => ca.phaseAt(sequence, k)), ["pavilion", "pavilion", "crown", "crown"], "phases");
});

Deno.test("rows are cut, current or uncut, and so is every tooth", () => {
  // Setup: the toy sequence at k 3 (P1 cut, G1's second facet current).
  // Test: tierState for every tier, and cutState for G1's four cuts.
  // Verifies what the pane and the bar draw: P1 cut (shown normally), G1 current (highlighted),
  // C1 and T uncut (greyed); G1's first tooth cut, its second current, the other two to cut. At a
  // tier's own start, before any of it is cut, it is already the current tier.
  const sequence = ca.buildCutSequence(toyDesign());

  assertEqual(sequence.tiers.map((_, t) => ca.tierState(sequence, t, 3)), ["cut", "current", "uncut", "uncut"], "rows");
  assertEqual([2, 3, 4, 5].map(c => ca.cutState(c, 3)), ["cut", "current", "uncut", "uncut"], "G1's teeth");
  assertEqual(ca.tierState(sequence, 2, 6), "current", "C1 at its own start");
});

Deno.test("the slider's marks are every tier start inside the range, and the transfer", () => {
  // Setup: the toy sequence, and a design with only a pavilion (no crown to transfer to).
  // Test: sliderMarks.
  // Verifies: a tick at 2, 6 and 8 (not at 0, which is the slider's own end); the transfer mark
  // at 6; and no transfer mark when it would sit on an end of the slider.
  const sequence = ca.buildCutSequence(toyDesign());

  assertEqual(ca.sliderMarks(sequence), { ticks: [2, 6, 8], transfer: 6 }, "toy marks");

  const pavilionOnly = toyDesign();

  pavilionOnly.tiers = pavilionOnly.tiers.slice(0, 2);
  assertEqual(ca.sliderMarks(ca.buildCutSequence(pavilionOnly)).transfer, null, "no crown, no transfer mark");
});

Deno.test("the rough is a cube around the finished stone, 1.15 times its largest half-extent", () => {
  // Setup: a made-up bounding box, off the origin and longest in y.
  // Test: roughCube.
  // Verifies: centred on the box's centre; half-size 1.15 x the largest half-extent (y's 3); and
  // six planes in the half-space form whose offsets put each face exactly half-size from the
  // centre along its own normal -- checked by the centre being 3.45 inside every one, and the
  // box's own corners all inside.
  const bounds = { min: { x: -1, y: -2, z: 0 }, max: { x: 1, y: 4, z: 1 } };
  const cube = ca.roughCube(bounds);

  assertEqual(cube.center, { x: 0, y: 1, z: 0.5 }, "centre");
  assertClose(cube.half, 3.45, 1e-12, "half-size");
  assertEqual(cube.planes.length, 6, "six faces");

  for (const { normal, offset } of cube.planes) {
    const inside = offset - (normal.x * cube.center.x + normal.y * cube.center.y + normal.z * cube.center.z);

    assertClose(inside, 3.45, 1e-12, "each face is half-size from the centre");

    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          assert(normal.x * x + normal.y * y + normal.z * z < offset, "the box's corners are inside the rough");
        }
      }
    }
  }
});

Deno.test("the dop is glued on the table side for the pavilion and at the culet for the crown", async () => {
  // Setup: the startup stone: its finished bounds, the rough around it, and its cut planes.
  // Test: dopSize, and dopPlacement for the pavilion (cube only) and the crown (cube plus every
  // pavilion and girdle cut).
  // Verifies the ticket's dop: 35% of the girdle width across and 1.5x the stone's height long;
  // on the optical axis; for the pavilion, glued to the rough's top face and sticking UP, away
  // from the stone, so every pavilion facet faces away from it; for the crown, glued at the culet
  // -- the lowest point of the cut pavilion on the axis, which for this pointed pavilion is the
  // finished stone's own lowest point -- and sticking DOWN.
  const { design } = await startupStone();
  const bounds = ca.boundsOf(DesignMesh.buildFaces(design).faces.flatMap(face => face.polygon));
  const cube = ca.roughCube(bounds);
  const size = ca.dopSize(bounds);
  const sequence = ca.buildCutSequence(design);
  const planes = sequence.cuts.map(({ tier, facet }) => ({
    normal: GemCadDesign.normalOf(design, tier.angle, facet.index), offset: tier.distance,
  }));
  const width = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y);

  assertClose(size.radius, 0.35 * width / 2, 1e-12, "radius: 35% of the girdle width, halved");
  assertClose(size.length, 1.5 * (bounds.max.z - bounds.min.z), 1e-12, "length: 1.5x the height");

  const pavilion = ca.dopPlacement(cube.planes, ca.PAVILION, size);

  assertClose(pavilion.start.z, cube.center.z + cube.half, 1e-9, "pavilion dop glued to the rough's top face");
  assertClose(pavilion.end.z - pavilion.start.z, size.length, 1e-9, "and sticking up, away from the stone");
  assertEqual([pavilion.start.x, pavilion.start.y, pavilion.end.x, pavilion.end.y], [0, 0, 0, 0], "on the axis");

  assertEqual(pavilion.capped, true, "the pavilion dop's glued end is drawn, a flat disk on the rough's top");

  const crown = ca.dopPlacement(cube.planes.concat(planes.slice(0, sequence.transfer)), ca.CROWN, size);

  // The crown dop's far end is where the old, flat-ended dop's was: size.length below the culet.
  assertClose(crown.end.z, bounds.min.z - size.length, 1e-6, "crown dop sticking down from the culet");
  // Its rock end is sunk INTO the pavilion (T-0239), above the culet, and not drawn.
  assert(crown.start.z > bounds.min.z, "the crown dop's end is inside the stone, above the culet");
  assertEqual(crown.capped, false, "the crown dop's buried end is not drawn");
});

Deno.test("the crown dop's buried end has its whole rim inside the pavilion, and no deeper than it needs", async () => {
  // Setup: the startup stone's rough at the transfer (the cube and every pavilion and girdle cut)
  // and its crown dop, and the pavilion planes alone -- the ones leaning down (normal z < 0).
  // Test: sample 64 points round the rod's rim at the height dopPlacement put its end, and measure
  // each against every plane of the rough, as n.p - offset (negative is inside). Then do the same
  // with the rim lowered by DOP_SINK_MARGIN of the radius, where sunkDopEnd says the rim first
  // touches the pavilion.
  // Verifies the geometry T-0239 relies on for "the part of the rod inside the stone must not be
  // visible": the renderer never lets a ray outside the stone reach the rod inside it only if the
  // open end's whole rim is inside the stone -- were a piece of the rim outside, a camera ray could
  // pass through the open end and see the inside of the tube. So every rim point is strictly inside
  // every plane, by a real margin; and the lowered rim just touches the pavilion (its worst point
  // is on a plane to float precision), so the end is sunk exactly as far as needed plus the margin,
  // not arbitrarily deep.
  const { design } = await startupStone();
  const bounds = ca.boundsOf(DesignMesh.buildFaces(design).faces.flatMap(face => face.polygon));
  const cube = ca.roughCube(bounds);
  const size = ca.dopSize(bounds);
  const sequence = ca.buildCutSequence(design);
  const rough = cube.planes.concat(sequence.cuts.slice(0, sequence.transfer).map(({ tier, facet }) => ({
    normal: GemCadDesign.normalOf(design, tier.angle, facet.index), offset: tier.distance,
  })));
  const crown = ca.dopPlacement(rough, ca.CROWN, size);

  /** The largest n.p - offset over every plane and every sampled rim point at height `z`. */
  function worstRim(z) {
    let worst = -Infinity;

    for (let i = 0; i < 64; i++) {
      const angle = (2 * Math.PI * i) / 64;
      const p = { x: size.radius * Math.cos(angle), y: size.radius * Math.sin(angle), z };

      for (const { normal, offset } of rough) {
        worst = Math.max(worst, normal.x * p.x + normal.y * p.y + normal.z * p.z - offset);
      }
    }

    return worst;
  }

  assert(worstRim(crown.start.z) < -1e-3 * size.radius, `the rim is inside the rough (worst ${worstRim(crown.start.z)})`);
  assertClose(worstRim(crown.start.z - ca.DOP_SINK_MARGIN * size.radius), 0, 1e-3 * size.radius,
    "without the margin the rim just touches the pavilion");
  assert(crown.start.z < cube.center.z, "and the end stays in the lower half, well below the crown");
});

Deno.test("the pavilion phase shows the stone turned half a turn about its axis from the crown phase", () => {
  // Setup: none; the mode's own pose table.
  // Test: compare the two phases' spins and tilts.
  // Verifies T-0239's "reverse the x-y direction" while cutting the pavilion, done as a turn of the
  // VIEW (the camera's spin, which turns about the optical axis) rather than a change to the
  // design: the pavilion spin is the crown's plus 180 degrees, and inside the renderer's
  // [-180, 180) range so reading the parameter back gives the same number; the tilts, which put
  // the dop down the screen in each phase, are the ones T-0234 chose.
  const { pavilion, crown } = mode.PHASE_POSES;

  assertEqual(((pavilion.spin - crown.spin) % 360 + 360) % 360, 180, "half a turn apart");
  assert(pavilion.spin >= -180 && pavilion.spin < 180, "a spin the renderer stores as it is given");
  assertEqual([pavilion.tilt, crown.tilt], [-120, 60], "the tilts are unchanged");
});

Deno.test("the frame holds the whole rough, and the dop within DOP_VIEW_REACH of it", async () => {
  // Setup: the startup stone's rough and dop, as above.
  // Test: viewFrame, then the rough's eight corners and both dop placements' far ends measured
  // from the frame's centre in units of its radius.
  // Verifies the framing the renderer is given: the rough's corners at radius 1 or inside it
  // (the unit sphere primary rays start outside of), and the dop's far end, with its radius, no
  // further than DOP_VIEW_REACH -- in either phase.
  const { design } = await startupStone();
  const bounds = ca.boundsOf(DesignMesh.buildFaces(design).faces.flatMap(face => face.polygon));
  const cube = ca.roughCube(bounds);
  const size = ca.dopSize(bounds);
  const frame = ca.viewFrame(cube, size);
  const from = p => Math.hypot(p.x - frame.center.x, p.y - frame.center.y, p.z - frame.center.z) / frame.radius;

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const corner = {
          x: cube.center.x + sx * cube.half, y: cube.center.y + sy * cube.half, z: cube.center.z + sz * cube.half,
        };

        assert(from(corner) <= 1 + 1e-9, "every corner of the rough is inside the unit sphere");
      }
    }
  }

  const sequence = ca.buildCutSequence(design);
  const planes = sequence.cuts.map(({ tier, facet }) => ({
    normal: GemCadDesign.normalOf(design, tier.angle, facet.index), offset: tier.distance,
  }));

  for (const dop of [ca.dopPlacement(cube.planes, ca.PAVILION, size),
    ca.dopPlacement(cube.planes.concat(planes.slice(0, sequence.transfer)), ca.CROWN, size)]) {
    assert(from(dop.end) + dop.radius / frame.radius <= ca.DOP_VIEW_REACH + 1e-9, "the dop's far end is within reach");
  }
});

Deno.test("every step's rough is a closed solid, never grows, and the last is the finished stone", async () => {
  // Setup: the startup stone's rough (six cube planes) and its 67 cuts.
  // Test: build the rough at every position k = 0..N with the page's own half-space builder
  // (buildFacesFromPlanes: the cube's planes, then the first k cuts), exactly as the mode does.
  // Verifies, at every step: it builds (a closed solid, or the builder throws); its volume never
  // goes up (a cut only takes material away); k = 0 is the cube and nothing else (six faces, no
  // tier); and at k = N no face of the cube is left and the solid has the finished stone's faces
  // and volume -- so walking the whole sequence really does end on the design's own stone.
  const { design } = await startupStone();
  const bounds = ca.boundsOf(DesignMesh.buildFaces(design).faces.flatMap(face => face.polygon));
  const cube = ca.roughCube(bounds);
  const sequence = ca.buildCutSequence(design);
  const planes = sequence.cuts.map(({ tier, facet }, at) => ({
    normal: GemCadDesign.normalOf(design, tier.angle, facet.index), offset: tier.distance, tier: at,
  }));

  /** The volume of built faces, by the divergence theorem over fanned triangles. */
  function volume(faces) {
    let six = 0;

    for (const { polygon } of faces) {
      for (let i = 1; i + 1 < polygon.length; i++) {
        const [a, b, c] = [polygon[0], polygon[i], polygon[i + 1]];

        six += a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x);
      }
    }

    return six / 6;
  }

  let previous = Infinity;

  for (let k = 0; k <= sequence.total; k++) {
    const built = DesignMesh.buildFacesFromPlanes(cube.planes.concat(planes.slice(0, k)));
    const now = volume(built.faces);

    assert(now <= previous + 1e-9, `the rough never grows (k ${k}: ${now} after ${previous})`);
    previous = now;

    if (k === 0) {
      assertEqual(built.faces.length, 6, "k 0 is the cube alone");
      assertClose(now, (2 * cube.half) ** 3, 1e-9, "k 0 has the cube's volume");
    }

    if (k === sequence.total) {
      const finished = DesignMesh.buildFaces(design);

      assert(built.faces.every(face => face.tier !== undefined), "no face of the cube is left at the end");
      assertEqual(built.faces.length, finished.faces.length, "the finished stone's faces");
      assertClose(now, volume(finished.faces), 1e-9, "the finished stone's volume");
    }
  }
});

// ===========================================================================
// 2. The mode, against a fake GemApp
// ===========================================================================

/** One outward unit normal per face of OBJ text, by Newell's method over the face's corners. */
function faceNormals(text) {
  const vertices = [];
  const normals = [];

  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);

    if (parts[0] === "v") {
      vertices.push(parts.slice(1, 4).map(Number));
    } else if (parts[0] === "f") {
      const corners = parts.slice(1).map(part => vertices[parseInt(part.split("/")[0], 10) - 1]);
      let [x, y, z] = [0, 0, 0];

      corners.forEach((a, at) => {
        const b = corners[(at + 1) % corners.length];

        x += (a[1] - b[1]) * (a[2] + b[2]);
        y += (a[2] - b[2]) * (a[0] + b[0]);
        z += (a[0] - b[0]) * (a[1] + b[1]);
      });

      const length = Math.hypot(x, y, z);

      normals.push(x / length, y / length, z / length);
    }
  }

  return new Float32Array(normals);
}

/**
 * A stand-in for GemApp with what the mode, the load tail and the render loop call. It keeps the
 * OBJ text it was last given (`model_obj_text`, as Rust does), one normal per face, the dop, the
 * highlight, the parameters, and a log of every load: `{ kind: 'load' | 'framed', text, frame }`.
 */
function fakeApp() {
  const app = {
    text: "",
    normals: new Float32Array(0),
    loads: [],
    dop: null,
    highlighted: [],
    params: { spin: 0, tilt: 0 },
    load_obj(text) {
      app.text = text;
      app.normals = faceNormals(text);
      app.highlighted = [];
      app.loads.push({ kind: "load", text });
    },
    load_obj_framed(text, cx, cy, cz, radius) {
      app.text = text;
      app.normals = faceNormals(text);
      app.highlighted = [];
      app.loads.push({ kind: "framed", text, frame: [cx, cy, cz, radius] });
    },
    model_obj_text: () => app.text,
    set_dop(...values) {
      app.dop = values;
    },
    clear_dop() {
      app.dop = null;
    },
    facet_count: () => app.normals.length / 3,
    facet_normals: () => app.normals,
    set_highlighted_facets(ids) {
      app.highlighted = Array.from(ids);
    },
    set_highlighted_facet(id) {
      app.highlighted = id < 0 ? [] : [id];
    },
    set_frosted_facets() {},
    get_param: name => app.params[name] ?? 0,
    set_param(name, value) {
      app.params[name] = value;
    },
    set_draft_mode() {},
    render() {},
    // The selected renderer (params::Renderer::as_u32: 0 Deterministic, 1 Monte Carlo, 2 Flat),
    // and every switch made, so a test can see the mode's (T-0239). No control is hidden under
    // any of them here, so session.js's syncHiddenControls touches no document.
    rendererValue: 0,
    rendererSwitches: [],
    renderer: () => app.rendererValue,
    set_renderer(value) {
      app.rendererValue = value;
      app.rendererSwitches.push(value);
    },
    hidden_controls: () => "",
    hideable_controls: () => "",
    accumulation_status: () => "off: a fake app has no GPU",
    accumulating: () => false,
    accumulation_complete: () => true,
    frame_settled: () => true,
  };

  return app;
}

/**
 * A fresh page on a fresh fake app with the startup stone loaded, the way boot does it: the
 * session (history, stone hooks), a stub canvas for the render loop, the stone into the app, and
 * session.js's load tail. `engine.app` is the fake, as it is the real app on the page.
 */
async function page() {
  const app = fakeApp();
  const stone = await startupStone();

  engine.app = app;
  startSession(app);
  attachCanvasControls({ addEventListener() {}, clientWidth: 100, clientHeight: 100, classList: { add() {}, remove() {} } });
  app.load_obj(stone.text);
  installLoadedDesign(app, { text: stone.text, design: stone.design, gear: stone.gear, title: "test" });
  app.params = { spin: 33, tilt: -12 };
  runTimers();

  return { app, design: stone.design, text: stone.text };
}

Deno.test("opening shows the uncut rough on the dop, holds the design, and makes Undo inert", async () => {
  // Setup: the startup stone on a fresh page, with one real edit already in the history (a tier
  // hidden and shown again with the toolbar), so Undo has something to undo before the mode opens.
  // Test: open the mode, and let its builder run.
  // Verifies what opening does: the bar is open at k 0; the stone loaded is the rough with no cut
  // -- the cube's six faces, in the pinned frame -- and nothing is highlighted; the dop is on the
  // table side, from the rough's top up; the view is posed for the pavilion (the dop down the
  // screen); the whole design is held, so every tier toolbar button is inactive and says to close
  // the assistant first; Undo and Redo are inert although the history is not empty; and the
  // design is exactly as it was.
  const { app, design } = await page();
  const before = JSON.stringify(GemCadDesign.toJSON(design));

  tiers.highlightTier(design.tiers[0]);
  tiers.toolbarActions.visibility();
  tiers.highlightTier(design.tiers[0]);
  tiers.toolbarActions.visibility();
  runTimers();
  assert(get(canUndo), "setup: there is something to undo before the mode opens");

  assert(mode.enterCuttingAssistant(), "the mode opens");
  runTimers();

  assertEqual([get(mode.cutting).open, get(mode.cutting).k], [true, 0], "open at k 0");

  const last = app.loads[app.loads.length - 1];

  assertEqual(last.kind, "framed", "the rough is loaded in the pinned frame");
  assertEqual(app.normals.length / 3, 6, "the uncut rough is the cube's six faces");
  assertEqual(app.highlighted, [], "nothing is cut yet, so nothing is highlighted");
  assert(app.dop !== null && app.dop[5] > app.dop[2], "the dop is out, pointing up from the table side");
  assertEqual([app.params.spin, app.params.tilt],
    [mode.PHASE_POSES.pavilion.spin, mode.PHASE_POSES.pavilion.tilt], "posed for the pavilion");
  assert(tiers.designLocked(), "the design is held");
  assert(!get(tiers.toolbar).delete.active && get(tiers.toolbar).delete.tip.includes("cutting assistant"),
    "the toolbar is inactive and says why");
  assertEqual([get(canUndo), get(canRedo)], [false, false], "Undo and Redo are inert");

  undo();
  assertEqual(JSON.stringify(GemCadDesign.toJSON(design)), before, "an Undo while open changes nothing");

  mode.exitCuttingAssistant();
  runTimers();
});

Deno.test("each step loads one more cut, lights it, and moves the dop and the view at the transfer", async () => {
  // Setup: the startup stone, the mode open at k 0.
  // Test: step.nextCut, then goTo the transfer, then goTo back before it.
  // Verifies the walkthrough on the stone: one more cut is one more face on the loaded rough, in
  // the same pinned frame, and the new face -- the one facing along the first cut's plane -- is
  // highlighted; at the transfer (every pavilion and girdle facet cut) the dop moves to the culet,
  // sticking down, and the view is re-posed for the crown; and stepping back before the transfer
  // puts the dop and the pose back on the pavilion side.
  const { app, design } = await page();

  mode.enterCuttingAssistant();
  runTimers();

  const frame = app.loads[app.loads.length - 1].frame;
  const sequence = get(mode.cutting).sequence;

  mode.step.nextCut();
  runTimers();

  assertEqual(get(mode.cutting).k, 1, "one cut made");
  assertEqual(app.normals.length / 3, 7, "the rough has the cube's six faces and the first cut");
  assertEqual(app.loads[app.loads.length - 1].frame, frame, "in the same frame as before");

  const first = sequence.cuts[0];
  const normal = GemCadDesign.normalOf(design, first.tier.angle, first.facet.index);
  const lit = app.highlighted.map(f => [app.normals[f * 3], app.normals[f * 3 + 1], app.normals[f * 3 + 2]]);

  assertEqual(lit.length, 1, "one face is lit");
  assertClose(lit[0][0] * normal.x + lit[0][1] * normal.y + lit[0][2] * normal.z, 1, 1e-6, "the face the cut made");

  const pavilionDop = app.dop;

  assertEqual(pavilionDop[7], true, "the pavilion dop's glued end is drawn");

  mode.goTo(sequence.transfer);
  runTimers();
  assert(app.dop[5] < app.dop[2], "at the transfer the dop points down from the culet");
  assert(app.dop[2] < pavilionDop[2], "and is glued below where it was");
  assertEqual(app.dop[7], false, "with its end buried in the pavilion, not drawn");
  assertEqual([app.params.spin, app.params.tilt], [mode.PHASE_POSES.crown.spin, mode.PHASE_POSES.crown.tilt],
    "the view is re-posed for the crown");

  mode.goTo(sequence.transfer - 1);
  runTimers();
  assertEqual(app.dop, pavilionDop, "one cut before the transfer, the dop is back on the table side");

  mode.exitCuttingAssistant();
  runTimers();
});

Deno.test("the finished rough is the design's own stone, byte for byte", async () => {
  // Setup: the startup stone, the mode open.
  // Test: go to k = N and let the builder run; compare the OBJ text loaded with the design's own
  // (DesignMesh.toObjText, what the page loads outside the mode), ignoring the comment lines and
  // the object name, which say where each came from.
  // Verifies the claim buildShown's comment makes: handing the builder the cuts in the design's
  // own order with the cube after them, at the design's tolerances, makes the last step of the
  // walkthrough exactly the stone the page shows, vertex for vertex -- not merely a stone of the
  // same shape, whose float noise Rust could condition into a different facet count.
  const { app, design } = await page();

  mode.enterCuttingAssistant();
  runTimers();
  mode.goTo(get(mode.cutting).sequence.total);
  runTimers();

  const body = text => text.split("\n").filter(line => !line.startsWith("#") && !line.startsWith("o ")).join("\n");

  assertEqual(body(app.model_obj_text()) === body(DesignMesh.toObjText(design, { name: "x" })), true,
    "the finished rough's vertices and faces are the design's own");

  mode.exitCuttingAssistant();
  runTimers();
});

Deno.test("a burst of slider moves builds once, for the last position", async () => {
  // Setup: the startup stone, the mode open, its first build done.
  // Test: five goTo calls in a row with no turn for the builder in between -- what a fast slider
  // drag does -- then let the builder run.
  // Verifies the ticket's performance rule: the bar follows every move at once, but the stone is
  // built ONCE, for the position asked for last, never once per move.
  const { app } = await page();

  mode.enterCuttingAssistant();
  runTimers();

  const loadsBefore = app.loads.length;

  for (const k of [5, 12, 30, 41, 50]) {
    mode.goTo(k);
    assertEqual(get(mode.cutting).k, k, "the bar follows at once");
  }

  runTimers();
  assertEqual(app.loads.length - loadsBefore, 1, "one build for the whole burst");
  assertEqual(app.normals.length / 3 > 6, true, "of a cut rough");

  mode.exitCuttingAssistant();
  runTimers();
});

Deno.test("a row click scrubs to its tier's first facet, and rows show cut, current and uncut", async () => {
  // Setup: the startup stone, the mode open.
  // Test: click the C3 row (through the tier controller, as the row's own handler does).
  // Verifies: the position becomes C3's first facet, with none of C3 cut; the row states the pane
  // draws follow -- everything before C3 cut, C3 current, everything after uncut; and the click did
  // NOT select the tier (the design's selection belongs to its own stone, which is not on screen).
  const { design } = await page();

  mode.enterCuttingAssistant();
  runTimers();

  const sequence = get(mode.cutting).sequence;
  const c3 = sequence.tiers.findIndex(entry => entry.id === "C3");

  tiers.rowClicked(sequence.tiers[c3].tier);

  assertEqual(get(mode.cutting).k, sequence.tiers[c3].start, "at C3's first facet");

  const rows = get(mode.cuttingRows);

  assertEqual(sequence.tiers.map(entry => rows.get(entry.tier)),
    sequence.tiers.map((_, t) => (t < c3 ? "cut" : t === c3 ? "current" : "uncut")), "row states");
  assertEqual(get(tiers.selectedTier), null, "nothing selected");
  assert(design.tiers.includes(sequence.tiers[c3].tier), "setup: the rows are the design's own tiers");

  mode.exitCuttingAssistant();
  runTimers();
});

Deno.test("Done puts back the stone, the pose, Undo and the hooks, and the design never changed", async () => {
  // Setup: the startup stone on a fresh page, the view at spin 33, tilt -12, an edit in the history.
  // Test: open the mode, walk to the middle of the crown, and press Done.
  // Verifies the ticket's "the design and undo history are unchanged afterwards": the last load is
  // the design's own OBJ text, byte for byte (what diagnostics_text() is computed from); the dop is
  // gone; the pose is the one the user had; the bar is closed and the rows have no state; the design
  // is not held, Undo is live again with the same entry to undo; row clicks go back to selecting;
  // and the design is exactly what it was.
  const { app, design, text } = await page();
  const before = JSON.stringify(GemCadDesign.toJSON(design));

  tiers.highlightTier(design.tiers[0]);
  tiers.toolbarActions.visibility();
  tiers.highlightTier(design.tiers[0]);
  tiers.toolbarActions.visibility();
  runTimers();

  const shownText = app.model_obj_text();

  assertEqual(shownText, text, "setup: the design's own stone is on screen");

  mode.enterCuttingAssistant();
  runTimers();
  mode.goTo(get(mode.cutting).sequence.transfer + 5);
  runTimers();
  mode.exitCuttingAssistant();
  runTimers();

  assertEqual(app.model_obj_text(), shownText, "the design's stone is back, byte for byte");
  assertEqual(app.loads[app.loads.length - 1].kind, "load", "loaded the ordinary way, in its own frame");
  assertEqual(app.dop, null, "the dop is gone");
  assertEqual([app.params.spin, app.params.tilt], [33, -12], "the view is back where the user had it");
  assertEqual([get(mode.cutting).open, get(mode.cuttingRows)], [false, null], "the bar is closed");
  assert(!tiers.designLocked(), "the design is free again");
  assert(get(canUndo), "Undo is live again, with the edit made before the mode");
  assertEqual(JSON.stringify(GemCadDesign.toJSON(design)), before, "the design never changed");

  tiers.rowClicked(design.tiers[3]);
  assertEqual(get(tiers.selectedTier), design.tiers[3], "a row click selects again");
});

Deno.test("opening from Monte Carlo switches to Deterministic and closing puts it back; Flat and Deterministic stay", async () => {
  // Setup: the startup stone on a fresh page, with the fake app's renderer set to each of the
  // three in turn, and the page's saved-settings store replaced by a recorder, so a test can see
  // what would be written to it.
  // Test: open the mode, walk into the crown, and press Done -- once from each renderer; then
  // once from Monte Carlo ended the other way, by another design being loaded under the mode.
  // Verifies T-0239 ("get rid of the dop from monte carlo and just switch the user to the
  // deterministic renderer if it's currently in monte carlo? if the user is in the fast renderer
  // just stay there"): from Monte Carlo (1) the mode runs in Deterministic (0) and Done restores
  // Monte Carlo; from Flat (2) or Deterministic nothing switches at all; either way of ending
  // restores; and the temporary switch is never saved as the user's renderer setting.
  const written = [];
  const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { setItem: (name, value) => written.push([name, value]), getItem: () => null },
  });

  try {
    for (const [before, during] of [[1, 0], [2, 2], [0, 0]]) {
      const { app } = await page();

      app.rendererValue = before;
      assert(mode.enterCuttingAssistant(), "the mode opens");
      runTimers();
      assertEqual(app.renderer(), during, `from renderer ${before}, the mode runs in ${during}`);
      mode.goTo(get(mode.cutting).sequence.transfer + 1);
      runTimers();
      assertEqual(app.renderer(), during, "and stays there into the crown");
      mode.exitCuttingAssistant();
      runTimers();
      assertEqual(app.renderer(), before, "Done puts back the renderer the user had");
      assertEqual(app.rendererSwitches, before === 1 ? [0, 1] : [], "switched only from Monte Carlo");
    }

    const { app } = await page();
    const fresh = await startupStone();

    app.rendererValue = 1;
    mode.enterCuttingAssistant();
    runTimers();
    app.load_obj(fresh.text);
    installLoadedDesign(app, { text: fresh.text, design: fresh.design, gear: fresh.gear, title: "again" });
    runTimers();
    assertEqual(app.renderer(), 1, "a design loaded under the mode also puts Monte Carlo back");
  } finally {
    if (realStorage) {
      Object.defineProperty(globalThis, "localStorage", realStorage);
    } else {
      delete globalThis.localStorage;
    }
  }

  assertEqual(written.filter(([name]) => name === "gems.renderer"), [], "the switch is never saved");
});

Deno.test("one mode at a time: it will not open over edit mode or scale height, nor they over it", async () => {
  // Setup: the startup stone on a fresh page.
  // Test: open edit mode and try the assistant; open scale height and try the assistant; open the
  // assistant and try edit mode and scale height.
  // Verifies the ticket's "it refuses to open ... while edit mode or scale height mode is open;
  // those two refuse to open while this is open", each way round, and that a refusal changes
  // nothing (no dop, the bar closed).
  const { app, design } = await page();

  assert(enterEditMode(design.tiers[3]), "setup: edit mode opens");
  assert(!mode.enterCuttingAssistant(), "the assistant refuses over edit mode");
  exitEditMode();

  assert(enterScaleHeightMode(), "setup: scale height opens");
  assert(!mode.enterCuttingAssistant(), "the assistant refuses over scale height");
  cancelScaleHeightMode();
  runTimers();
  assertEqual([app.dop, get(mode.cutting).open], [null, false], "the refusals changed nothing");

  assert(mode.enterCuttingAssistant(), "the assistant opens on its own");
  assert(!enterEditMode(design.tiers[3]), "edit mode refuses while it is open");
  assertEqual(get(editing), null, "and is not open");
  assert(!enterScaleHeightMode(), "scale height refuses while it is open");
  assert(!mode.enterCuttingAssistant(), "and it does not open twice");

  mode.exitCuttingAssistant();
  runTimers();
});

Deno.test("another design loaded under the mode closes it, leaving the new stone alone", async () => {
  // Setup: the startup stone, the mode open.
  // Test: load another design over it the way File > Open does (the stone into the app, then the
  // load tail) -- here the same file again, read afresh, which is a different design object.
  // Verifies: the mode closes itself (the bar, the rows, the dop), and does NOT put its saved stone
  // back over the new one: the last load is the new design's.
  const { app } = await page();

  mode.enterCuttingAssistant();
  runTimers();

  const fresh = await startupStone();

  app.load_obj(fresh.text);
  installLoadedDesign(app, { text: fresh.text, design: fresh.design, gear: fresh.gear, title: "again" });
  runTimers();

  assertEqual([get(mode.cutting).open, get(mode.cuttingRows), app.dop], [false, null, null], "closed");
  assertEqual(app.loads[app.loads.length - 1].kind, "load", "the new stone stays on screen");
  assert(!tiers.designLocked(), "the new design is not held");
});
