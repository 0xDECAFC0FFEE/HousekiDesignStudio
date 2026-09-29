/*
 * manual_optimizer_tilt_test.js -- tests for two changes to Edit > Manual optimizer (T-0274,
 * 2026-09-28), in src/web/src/lib/manual_optimizer_mode.js. The user:
 *
 *   "for the manual optimizer don't rotate the previews when the main render is rotated - just
 *   only show the rocks face up and don't refresh on rotation. also, under the grid can you show
 *   the face up rocks tilt performance"
 *
 * So: (1) every preview in the grid is drawn face up, and turning the view in the middle redraws
 * nothing; (2) under the grid is Tools > Tilt performance's graph of the stone in the middle,
 * measured once the chosen heights rest, with a stale sweep cancelled.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The page's real modules (session.js, viewport.js, tier_controller.js, the mode, tilt_sweep.js)
 * run against a FAKE GemApp, which records every preview it is asked to draw and every batch of
 * tilt poses it is asked to measure. Its measurements are made up, but made up so a test can tell
 * which stone they were taken of: every `load_obj` (a rebuild of the stone in the middle) gives the
 * stone a new number, and a pose's ISO value is that number / 100 + its tilt / 1000.
 *
 * TIME IS VIRTUAL. `setTimeout` and `clearTimeout` are replaced by a clock this file moves by hand
 * (`advance`), so a test decides exactly how long the heights rest and when a sweep's polls run.
 * The mode waits TILT_SETTLE_MS before measuring and cancels timers when a change makes them stale,
 * so unlike tilt_performance_mode_test.js's queue this clock honours delays and `clearTimeout`.
 *
 * What the fake cannot show -- the real pictures, the real numbers, the pointer on the canvas -- is
 * checked on the built page in headless Chrome (kb/manual-optimizer-mode-a-grid-of-crown-and-pavili.md).
 */

// ---- the virtual clock, installed before any module that schedules is loaded

let clock = 0;
let timers = [];
let nextTimer = 1;
// How many timers have fired: every step the page takes runs in a timer of its own, so events
// that share this number happened in one step.
let fired = 0;

globalThis.window = globalThis.window ?? {};
globalThis.window.addEventListener = () => {};
globalThis.setTimeout = (fn, ms = 0) => {
  const id = nextTimer++;

  timers.push({ id, due: clock + Math.max(0, Number(ms) || 0), fn });
  return id;
};
globalThis.clearTimeout = id => {
  timers = timers.filter(timer => timer.id !== id);
};

/** Moves the clock on by `ms`, running every timer that falls due on the way, in order. */
function advance(ms) {
  const end = clock + ms;

  for (let guard = 0; guard < 200000; guard++) {
    timers.sort((a, b) => a.due - b.due || a.id - b.id);

    const next = timers[0];

    if (!next || next.due > end) {
      clock = end;
      return;
    }

    timers.shift();
    clock = next.due;
    fired += 1;
    next.fn();
  }

  throw new Error("the clock ran away: a timer keeps rescheduling itself at once");
}

for (const name of ["gemcad.js", "gemcad_obj.js", "design.js", "gcs.js", "design_mesh.js", "edit_history.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${name}`, import.meta.url)));
}

const { get } = await import("svelte/store");
const { objTextFromBytes } = await import("../src/lib/design_load.js");
const { installLoadedDesign, startSession, applyParam, undo } = await import("../src/lib/session.js");
const { engine } = await import("../src/lib/stores.js");
const { attachCanvasControls } = await import("../src/lib/viewport.js");
const {
  sweepPoses, DEFAULT_RANGE, GRAPH_MARGIN, graphX, poseAtPointer, sampleNearest, formatPercent,
} = await import("../src/lib/tilt_performance.js");
const tiltMode = await import("../src/lib/tilt_performance_mode.js");
const mode = await import("../src/lib/manual_optimizer_mode.js");

const STARTUP_URL = new URL("../../resources/hex_cut_v2.gcs", import.meta.url);

// Every preview stone built (DesignMesh.toObjText named 'preview', as the mode names them) goes into
// the fake app's event log too, with the step it happened in.
{
  const toObjText = globalThis.DesignMesh.toObjText;

  globalThis.DesignMesh.toObjText = (design, options) => {
    if (options?.name === "preview") {
      engine.app?.events?.push({ kind: "build", step: fired });
    }

    return toObjText(design, options);
  };
}

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

/**
 * A fake GemApp: what the session, the view and the mode call. Records:
 *   previews   every `thumbnail_begin`: `{ id, width, height, spin, tilt }`
 *   batches    every `tilt_begin`: `{ stone, poses: [{ spin, tilt }] }`, `stone` the number of the
 *              stone on screen when it was queued
 *   cancels    how many times `tilt_cancel` was called
 *   renders    how many frames of the view were drawn (`render`)
 * A preview is ready on the first poll; a tilt batch on the second poll after it reaches the
 * front, as the real renderer's fences signal a little later than they are asked.
 */
function fakeApp() {
  const app = {
    params: {
      spin: 0, tilt: 0, headShadowHalfAngle: 15, refractiveIndex: 1.54, dispersion: 0.024,
      maxBounces: 14, observerRadius: 0.1, exposure: 1,
    },
    stone: 0,
    previews: [],
    batches: [],
    cancels: 0,
    renders: 0,
    load_obj() {
      app.stone += 1;
    },
    model_obj_text: () => "",
    facet_count: () => 0,
    facet_normals: () => new Float32Array(0),
    set_highlighted_facets() {},
    set_highlighted_facet() {},
    set_frosted_facets() {},
    get_param: name => app.params[name] ?? 0,
    set_param(name, value) {
      app.params[name] = value;
    },
    set_draft_mode() {},
    render() {
      app.renders += 1;
    },
    rendererValue: 0,
    renderer: () => app.rendererValue,
    set_renderer(value) {
      app.rendererValue = value;
    },
    hidden_controls: () => "",
    hideable_controls: () => "",
    accumulation_status: () => "off: a fake app has no GPU",
    accumulating: () => false,
    accumulation_complete: () => true,
    frame_settled: () => true,
    // What the grid's key of the render settings reads.
    lighting_model: () => 0,
    has_environment_image: () => false,
    background_enabled: () => false,
    background_color: () => [0, 0, 0],
    window_color_enabled: () => false,
    window_color: () => [0, 0, 0],
    head_shadow_color: () => [0, 0, 0],
    stone_color: () => [1, 1, 1],
    wireframe_enabled: () => false,
    // The previews: loaded under ids, drawn one at a time. A draw is done on the `drawPolls`th
    // poll after it began (1: at once), as a real one is once the GPU has drawn it. `events` logs
    // each load, draw and finished draw with the timer it happened in (`fired`).
    loaded: new Set(),
    drawing: null,
    drawPolls: 1,
    events: [],
    thumbnail_load(id) {
      app.loaded.add(id);
      app.events.push({ kind: "load", id, step: fired });
    },
    thumbnail_clear() {
      app.loaded.clear();
      app.drawing = null;
    },
    thumbnail_begin(id, width, height, spin, tilt) {
      app.previews.push({ id, width, height, spin, tilt });
      app.drawing = { width, height, id, polls: 0 };
      app.events.push({ kind: "begin", id, step: fired });
    },
    thumbnail_poll() {
      if (app.drawing === null) {
        return false;
      }

      app.drawing.polls += 1;

      if (app.drawing.polls < app.drawPolls) {
        return false;
      }

      if (!app.drawing.done) {
        app.drawing.done = true;
        app.events.push({ kind: "done", id: app.drawing.id, step: fired });
      }

      return true;
    },
    thumbnail_pixels() {
      const { width, height } = app.drawing;

      app.drawing = null;
      return new Uint8Array(width * height * 4);
    },
    // Tilt performance: batches of up to four poses, two queued at once.
    queued: [],
    polls: 0,
    last: null,
    tilt_batch_size: () => 4,
    tilt_can_begin: () => app.queued.length < 2,
    tilt_begin(poses) {
      if (!app.tilt_can_begin() || poses.length > 8) {
        throw new Error("the fake renderer cannot take this batch");
      }

      const batch = { stone: app.stone, poses: [] };

      for (let i = 0; i < poses.length; i += 2) {
        batch.poses.push({ spin: poses[i], tilt: poses[i + 1] });
      }

      app.batches.push(batch);
      app.queued.push(batch);
      app.events.push({ kind: "tilt", step: fired });
    },
    tilt_poll() {
      if (app.queued.length === 0) {
        return false;
      }

      app.polls += 1;

      if (app.polls < 2) {
        return false;
      }

      app.polls = 0;
      app.last = app.queued.shift();
      return true;
    },
    tilt_result() {
      return new Float32Array(app.last.poses.flatMap(({ tilt }) =>
        [app.last.stone / 100 + tilt / 1000, 0.7, 0.1, 0.05, 0.98, 0.8, 0.01, 0.0, 1000, 200]));
    },
    tilt_cancel() {
      app.cancels += 1;
      app.queued = [];
      app.polls = 0;
    },
  };

  return app;
}

/**
 * A fresh page on a fresh fake app with the startup stone loaded, as boot does it, and the
 * optimizer opened on it at 3 x 3 (nine previews: a stone is built for real for each, which takes
 * a moment, so the tests keep the grid small). Returns `{ app, design }`.
 */
async function openOptimizer() {
  const app = fakeApp();
  const stone = objTextFromBytes("hex_cut_v2.gcs", await Deno.readFile(STARTUP_URL));

  engine.app = app;
  startSession(app);
  attachCanvasControls({ addEventListener() {}, clientWidth: 100, clientHeight: 100, classList: { add() {}, remove() {} } });
  installLoadedDesign(app, { text: stone.text, design: stone.design, gear: stone.gear, title: "test" });
  advance(1000);

  assert(mode.enterManualOptimizer(), "the optimizer opens");
  mode.setSubdivisions(3);
  return { app, design: stone.design };
}

/** Lets everything run until the grid and the graph are both done (virtual time is free). */
function settle() {
  advance(60000);
}

/** The first batch of each sweep: a sweep starts with face-up on Tilt X. */
function sweepsStarted(app) {
  return app.batches.filter(batch => batch.poses[0].spin === 0 && batch.poses[0].tilt === 0);
}

/** The ISO value the fake reports for face-up on stone number `stone`. */
const faceUpIso = stone => stone / 100;

// ---- (1) the previews are face up and do not follow the view

Deno.test("every preview is drawn face up, whatever pose the view in the middle has", async () => {
  // Setup: the optimizer open at 3 x 3 on the startup stone, with the view in the middle turned
  // away from face up (spin 40, tilt -25) BEFORE the grid is drawn.
  // Test: let the grid fill.
  // Verifies: all nine cells are drawn and not stale, and every preview the renderer was asked
  // for was drawn from spin 0, tilt 0 (FACE_UP) -- not from the view's pose, which is what the
  // grid did before 2026-09-28.
  const { app } = await openOptimizer();

  applyParam("spin", 40);
  applyParam("tilt", -25);
  settle();

  const images = get(mode.optimizerImages);

  assertEqual(images.length, 9, "nine cells");
  assert(images.every(image => image && image.pixels && !image.stale), "every cell is drawn and current");
  assert(app.previews.length >= 9, "at least one preview per cell was drawn");
  assert(app.previews.every(({ spin, tilt }) => spin === mode.FACE_UP.spin && tilt === mode.FACE_UP.tilt),
    `every preview is face up: ${JSON.stringify(app.previews.map(({ spin, tilt }) => [spin, tilt]))}`);
  assertEqual(mode.FACE_UP, { spin: 0, tilt: 0 }, "face up is spin 0, tilt 0");

  mode.cancelManualOptimizer();
});

Deno.test("turning the view redraws nothing in the grid; a lighting change still does", async () => {
  // Setup: the optimizer open at 3 x 3, the grid filled and the graph measured.
  // Test: (a) turn the view as an orbit drag does, a step at a time -- spin and tilt through
  // twenty poses, each step asking for a redraw -- then let a long time pass; (b) change the
  // exposure, a lighting setting the pictures depend on, and let it rest.
  // Verifies: (a) no preview is drawn at all, every picture is the very same object as before
  // (none replaced, none marked stale), and the grid still counts as filled: rotation neither
  // changes nor refreshes the grid; nor does it re-measure the graph (the stone and its settings
  // are the same). (b) the exposure change redraws every cell, face up again -- the redraw
  // mechanism still works for the settings that change what a face-up stone looks like.
  const { app } = await openOptimizer();

  settle();

  const before = get(mode.optimizerImages);
  const drawn = app.previews.length;
  const sweeps = sweepsStarted(app).length;

  for (let step = 1; step <= 20; step++) {
    applyParam("spin", step * 9);
    applyParam("tilt", -step * 2);
    advance(16);
  }

  settle();

  const after = get(mode.optimizerImages);

  assertEqual(app.previews.length, drawn, "(a) no preview was drawn after turning the view");
  assert(after.every((image, i) => image === before[i]), "(a) every picture is the same object");
  assert(after.every(image => !image.stale), "(a) none is marked stale");
  assertEqual(get(mode.manualOptimizer).filled, 9, "(a) the grid is still filled");
  assertEqual(sweepsStarted(app).length, sweeps, "(a) and the graph was not measured again");

  applyParam("exposure", 2);
  settle();

  const redrawn = app.previews.slice(drawn);

  assertEqual(redrawn.length, 9, "(b) the exposure change redrew every cell");
  assert(redrawn.every(({ spin, tilt }) => spin === 0 && tilt === 0), "(b) face up again");

  mode.cancelManualOptimizer();
});

Deno.test("rotation is not part of the key a picture is redrawn by", () => {
  // Setup: none.
  // Test: the list of render settings the grid's pictures are keyed on.
  // Verifies: spin and tilt, the view's pose, are not in it (they were until 2026-09-28), while
  // the lighting settings the user can change from the optimizer's own panel are.
  assert(!mode.DRAWN_PARAMS.includes("spin"), "spin is not drawn");
  assert(!mode.DRAWN_PARAMS.includes("tilt"), "tilt is not drawn");

  for (const name of ["headShadowHalfAngle", "exposure", "envIntensity", "envRotation"]) {
    assert(mode.DRAWN_PARAMS.includes(name), `${name} still redraws the grid`);
  }
});

// ---- (2) the graph under the grid

Deno.test("opening measures the stone in the middle over tilt performance's own sweep", async () => {
  // Setup: the optimizer just opened at 3 x 3 on the startup stone.
  // Test: read the graph's state at once, then let time pass.
  // Verifies: at first the graph is waiting, not measuring (the heights have not rested yet);
  // after the rest, the renderer is asked for exactly Tools > Tilt performance's default sweep
  // -- 0 to 33 degrees on Tilt X at spin 0, then on Tilt Y at spin -90, one pose per degree --
  // every batch of it queued with the stone in the middle on screen; the graph ends up done,
  // with 34 samples on each half, of the heights shown (1x, 1x), labelled with the render
  // settings' head shadow angle; and face-up's value is that stone's.
  const { app } = await openOptimizer();

  assertEqual(get(mode.optimizerTilt).status, "waiting", "waiting for the heights to rest");
  assertEqual(app.batches.length, 0, "nothing measured yet");

  settle();

  const expected = sweepPoses(DEFAULT_RANGE).map(({ spin, tilt }) => ({ spin, tilt }));
  const asked = app.batches.flatMap(batch => batch.poses);
  const graph = get(mode.optimizerTilt);

  assertEqual(asked, expected, "the default sweep, in order");
  assert(app.batches.every(batch => batch.stone === app.stone), "measured on the stone on screen");
  assertEqual(graph.status, "done", "the graph is done");
  assertEqual([graph.samples.x.length, graph.samples.y.length], [34, 34], "34 samples a half");
  assertEqual(graph.ratios, { crown: 1, pavilion: 1 }, "of the heights shown");
  assertEqual(graph.headShadow, 15, "labelled with the head shadow angle");
  assertEqual(graph.range, DEFAULT_RANGE, "33 degrees each way");

  const faceUp = graph.samples.x.find(sample => sample.angle === 0);

  assert(Math.abs(faceUp.measurement.stone.iso - faceUpIso(app.stone)) < 1e-6, "face up is this stone's");

  mode.cancelManualOptimizer();
});

Deno.test("a click measures the new stone once the heights rest; clicks in a row measure only the last", async () => {
  // Setup: the optimizer open at 3 x 3, graph measured for 1x/1x.
  // Test: click the top-left cell, and 100 ms later the bottom-right one; then let time pass.
  // Verifies: right after the clicks the graph is waiting and the old graph is still there (the
  // panel shows it faded); no sweep starts before TILT_SETTLE_MS of rest after the LAST click;
  // exactly one new sweep runs, of the bottom-right cell's stone (the one on screen by then), and
  // the graph ends up labelled with that cell's heights -- the top-left cell, passed over, is never
  // measured.
  const { app } = await openOptimizer();

  settle();

  const sweeps = sweepsStarted(app).length;
  const oldGraph = get(mode.optimizerTilt);

  mode.previewGridCell(0, 0);
  advance(100);
  mode.previewGridCell(2, 2);

  const waiting = get(mode.optimizerTilt);

  assertEqual(waiting.status, "waiting", "waiting after the clicks");
  assertEqual(waiting.samples, oldGraph.samples, "the previous graph is kept meanwhile");

  advance(mode.TILT_SETTLE_MS - 1);
  assertEqual(sweepsStarted(app).length, sweeps, "nothing measured before the heights have rested");

  settle();

  const cells = get(mode.manualOptimizer).cells;
  const graph = get(mode.optimizerTilt);

  assertEqual(sweepsStarted(app).length, sweeps + 1, "one new sweep");
  assertEqual(graph.status, "done", "and it finished");
  assertEqual(graph.ratios, { crown: cells[8].crown, pavilion: cells[8].pavilion }, "of the bottom-right cell");
  assert(Math.abs(graph.samples.x[0].measurement.stone.iso - faceUpIso(app.stone)) < 1e-6,
    "measured on the stone on screen, the last one clicked");

  mode.cancelManualOptimizer();
});

Deno.test("a change during a sweep cancels it, and its numbers never reach the graph", async () => {
  // Setup: the optimizer open at 3 x 3, graph measured for 1x/1x; then a click on the top-middle
  // cell, and just enough time for its sweep to start and have batches on the renderer.
  // Test: while that sweep is under way, click the left-middle cell; then let time pass.
  // Verifies: the sweep under way is cancelled on the renderer (tilt_cancel) the moment the
  // click makes it stale; while measuring, the view in the middle is held and the grid waits;
  // the graph that ends up shown is the left-middle cell's, all 68 samples from that stone --
  // none of the cancelled stone's numbers is mixed in.
  const { app } = await openOptimizer();

  settle();

  mode.previewGridCell(0, 1);
  advance(mode.TILT_SETTLE_MS + 1);

  assert(mode.tiltMeasuring(), "the top-middle cell's sweep is under way");

  const staleStone = app.stone;
  const cancels = app.cancels;
  const renders = app.renders;
  const previews = app.previews.length;

  advance(4);
  assertEqual(app.renders, renders, "the view is not drawn while measuring");
  assertEqual(app.previews.length, previews, "nor is the grid");

  mode.previewGridCell(1, 0);
  assert(app.cancels > cancels, "the stale sweep was cancelled at once");
  assert(!mode.tiltMeasuring(), "and nothing is being measured until the heights rest");

  settle();

  const graph = get(mode.optimizerTilt);
  const cells = get(mode.manualOptimizer).cells;
  const all = [...graph.samples.x, ...graph.samples.y];

  assertEqual(graph.ratios, { crown: cells[3].crown, pavilion: cells[3].pavilion }, "the left-middle cell's graph");
  assertEqual(all.length, 68, "a whole sweep");
  assert(app.stone !== staleStone, "a new stone is on screen");
  assert(all.every(({ angle, measurement }) => Math.abs(measurement.stone.iso - (app.stone / 100 + angle / 1000)) < 1e-6),
    "every sample is of the stone on screen, none of the cancelled one");

  mode.cancelManualOptimizer();
});

Deno.test("a rectangle measures its new centre", async () => {
  // Setup: the optimizer open at 3 x 3, graph measured for 1x/1x.
  // Test: drag a rectangle from the top-left cell to the middle one, then let time pass.
  // Verifies: the graph is re-measured and labelled with the grid's new centre, which is what the
  // middle shows after a rectangle.
  const { app } = await openOptimizer();

  settle();

  const sweeps = sweepsStarted(app).length;

  mode.selectGridRectangle({ row: 0, column: 0 }, { row: 1, column: 1 });
  settle();

  const { state } = get(mode.manualOptimizer);

  assertEqual(sweepsStarted(app).length, sweeps + 1, "one new sweep");
  assertEqual(get(mode.optimizerTilt).ratios, state.centre, "of the new centre");

  mode.cancelManualOptimizer();
});

Deno.test("going back to a stone already measured shows its graph at once", async () => {
  // Setup: the optimizer open at 3 x 3; the 1x/1x graph measured, then a click on a corner cell
  // and its graph measured.
  // Test: Edit > Undo (the mode's own undo), which puts the middle back to 1x/1x.
  // Verifies: the graph is done straight away, with no wait and no new sweep, and it is the very
  // graph measured first -- a graph is kept per stone and settings.
  const { app } = await openOptimizer();

  settle();

  const first = get(mode.optimizerTilt);

  mode.previewGridCell(0, 2);
  settle();

  const sweeps = sweepsStarted(app).length;

  undo();

  const graph = get(mode.optimizerTilt);

  assertEqual(graph.status, "done", "done at once");
  assertEqual(graph.ratios, { crown: 1, pavilion: 1 }, "of 1x/1x");
  assertEqual(graph.samples, first.samples, "the graph measured first");
  settle();
  assertEqual(sweepsStarted(app).length, sweeps, "nothing measured again");

  mode.cancelManualOptimizer();
});

Deno.test("the head shadow angle re-measures the graph; the exposure does not", async () => {
  // Setup: the optimizer open at 3 x 3, graph measured.
  // Test: change the exposure and let it rest; then change the head shadow half angle (the
  // optimizer's lighting settings show it) and let it rest.
  // Verifies: the exposure, which tilt performance does not measure with, starts no sweep; the
  // head shadow angle, which it does, starts one, and the graph is labelled with the new angle.
  const { app } = await openOptimizer();

  settle();

  const sweeps = sweepsStarted(app).length;

  applyParam("exposure", 1.5);
  settle();
  assertEqual(sweepsStarted(app).length, sweeps, "the exposure measures nothing");

  applyParam("headShadowHalfAngle", 20);
  settle();
  assertEqual(sweepsStarted(app).length, sweeps + 1, "the head shadow angle measures again");
  assertEqual(get(mode.optimizerTilt).headShadow, 20, "labelled with the new angle");

  mode.cancelManualOptimizer();
});

Deno.test("closing cancels a sweep, and the graph is the tilt tool's for the same stone", async () => {
  // Setup: the optimizer open at 3 x 3; a click on the bottom-middle cell, its graph measured.
  // Test: (a) click another cell, let its sweep start, and Cancel the mode mid-sweep; (b) open the
  // optimizer again, click the bottom-middle cell, let it measure, press Done, and open Tools >
  // Tilt performance on the stone Done kept.
  // Verifies: (a) Cancel stops the renderer's sweep and closes the graph; (b) the tilt tool,
  // measuring the same stone with the same settings, asks the renderer for the same poses and
  // comes to exactly the optimizer's samples -- the two share the measuring loop and the sweep,
  // so the graph under the grid is the tool's graph.
  const { app } = await openOptimizer();

  settle();
  mode.previewGridCell(0, 1);
  advance(mode.TILT_SETTLE_MS + 1);
  assert(mode.tiltMeasuring(), "a sweep is under way");

  const cancels = app.cancels;

  mode.cancelManualOptimizer();
  assert(app.cancels > cancels, "(a) Cancel stopped it");
  assertEqual(get(mode.optimizerTilt).status, "closed", "(a) and closed the graph");
  settle();

  assert(mode.enterManualOptimizer(), "(b) opens again");
  mode.setSubdivisions(3);
  mode.previewGridCell(2, 1);
  settle();

  const optimizerGraph = get(mode.optimizerTilt);
  const optimizerPoses = app.batches.slice(-Math.ceil(68 / 4)).flatMap(batch => batch.poses);

  mode.exitManualOptimizer();
  settle();

  assert(tiltMode.enterTiltPerformance(), "(b) the tilt tool opens");
  settle();

  const toolGraph = get(tiltMode.tiltPerformance);
  const toolPoses = app.batches.slice(-Math.ceil(68 / 4)).flatMap(batch => batch.poses);
  const byAngle = samples => [...samples].sort((a, b) => a.angle - b.angle);

  assertEqual(toolPoses, optimizerPoses, "(b) the same poses");
  assertEqual(byAngle(toolGraph.samples.x), byAngle(optimizerGraph.samples.x), "(b) the same Tilt X samples");
  assertEqual(byAngle(toolGraph.samples.y), byAngle(optimizerGraph.samples.y), "(b) the same Tilt Y samples");

  tiltMode.exitTiltPerformance();
});

Deno.test("pointing at the optimizer's graph reads the same values as the tool's graph at the same tilts", async () => {
  // Setup: the optimizer open at 3 x 3; the middle-row, left cell (1, 0) clicked and its graph
  // measured. Then Done, and Tools > Tilt performance opened on the stone Done kept, measured too.
  // Both graphs are drawn by the shared TiltGraph.svelte, which turns the pointer's position into a
  // pose with `poseAtPointer` and hands it on; the optimizer reads the values with `sampleNearest`,
  // the tool turns the view with `pointAtPose` and reads its own cursor the same way (T-0285; the
  // user, 2026-09-28: "mousing over the tilt performance graph should show the % at that point").
  // Test: for a graph 320 px wide, the pointer at the pixel of Tilt X 20, face up, Tilt Y 10 and
  // Tilt X 33 (the far left end), and one in the left margin, past the plot: work out the pose each
  // graph reads there, and the value each would show beside its curves.
  // Verifies: (a) the pose under the pointer is the tilt at that pixel (the margin reads the plot's
  // end, X 33); (b) the optimizer's readout is the fake renderer's value for that stone at that
  // tilt -- ISO = stone number / 100 + tilt / 1000 -- so it is the right sample, not a neighbour's;
  // (c) the tool, pointed at the same pixel, puts its cursor on the same pose and reads exactly the
  // same numbers, every curve of the stone and of the table; and (d) both print it the same way.
  const { app } = await openOptimizer();

  settle();
  mode.previewGridCell(1, 0);
  settle();

  const optimizerGraph = get(mode.optimizerTilt);
  const stone = app.stone;

  mode.exitManualOptimizer();
  settle();
  assert(tiltMode.enterTiltPerformance(), "the tilt tool opens");
  settle();

  const width = 320;
  const plot = width - GRAPH_MARGIN.left - GRAPH_MARGIN.right;
  const pixel = (axis, angle) => GRAPH_MARGIN.left + graphX(axis, angle, DEFAULT_RANGE) * plot;
  const points = [
    { at: pixel("x", 20), pose: { axis: "x", angle: 20 } },
    // Face up is the one pixel both halves share; it reads as the start of Tilt Y, 0 degrees.
    { at: pixel("x", 0), pose: { axis: "y", angle: 0 } },
    { at: pixel("y", 10), pose: { axis: "y", angle: 10 } },
    { at: pixel("x", 33), pose: { axis: "x", angle: 33 } },
    { at: 4, pose: { axis: "x", angle: 33 } },
  ];

  for (const { at, pose } of points) {
    const read = poseAtPointer(at, width, optimizerGraph.range);

    assertEqual([read.axis, Math.round(read.angle * 1e6) / 1e6], [pose.axis, pose.angle], `(a) pixel ${at.toFixed(1)} is ${pose.axis} ${pose.angle}`);

    const ours = sampleNearest(optimizerGraph.samples, read, optimizerGraph.range);

    assertEqual(ours.angle, pose.angle, `(b) the optimizer reads the sample at ${pose.axis} ${pose.angle}`);
    assert(Math.abs(ours.measurement.stone.iso - (stone / 100 + pose.angle / 1000)) < 1e-6,
      `(b) ISO at ${pose.axis} ${pose.angle} is this stone's`);

    tiltMode.pointAtPose(poseAtPointer(at, width, get(tiltMode.tiltPerformance).range));

    const tool = get(tiltMode.tiltPerformance);
    const theirs = sampleNearest(tool.samples, tool.cursor, tool.range);

    assertEqual(tool.cursor, read, `(c) the tool's cursor at ${pose.axis} ${pose.angle}`);
    assertEqual(theirs.measurement, ours.measurement, `(c) the same numbers at ${pose.axis} ${pose.angle}`);
    assertEqual(formatPercent(theirs.measurement.stone.iso), formatPercent(ours.measurement.stone.iso), "(d) printed alike");
  }

  assertEqual(formatPercent(0.834), "83.4%", "(d) a value prints as a percentage to a tenth");
  assertEqual(formatPercent(null), "—", "(d) and a missing one as a dash");

  tiltMode.exitTiltPerformance();
});

// ---- (3) the fill: one stage a step, the next stones prepared while the GPU draws (T-0274)

Deno.test("each step of the fill does one stage, and later stones are prepared while a picture is on the GPU", async () => {
  // Setup: the optimizer open at 3 x 3, with a fake GPU that takes four polls to finish a draw.
  // Test: let the grid fill, logging every stone built, stone loaded, draw begun and draw finished
  // with the timer (step) it happened in.
  // Verifies: (a) no step builds, loads or begins more than one thing -- a step never holds the
  // page for more than one stage of one cell, which is what keeps the page responsive while a big
  // grid fills; (b) while a draw is on the GPU (between its begin and its finish) the page builds
  // or loads another cell's stone instead of waiting; (c) only one draw is ever on the GPU at a
  // time (the renderer takes one); (d) all nine cells end up drawn, face up.
  const { app } = await openOptimizer();

  app.drawPolls = 4;
  settle();

  const steps = new Map();

  for (const event of app.events) {
    if (event.kind !== "done" && event.kind !== "tilt") {
      steps.set(event.step, (steps.get(event.step) ?? 0) + 1);
    }
  }

  assert([...steps.values()].every(count => count === 1),
    `(a) one stage a step: ${JSON.stringify([...steps.entries()].filter(([, count]) => count > 1))}`);

  let drawing = null;
  let preparedWhileDrawing = 0;

  for (const event of app.events) {
    if (event.kind === "begin") {
      assertEqual(drawing, null, "(c) one draw at a time");
      drawing = event.id;
    } else if (event.kind === "done") {
      drawing = null;
    } else if (drawing !== null && event.kind !== "tilt") {
      preparedWhileDrawing += 1;
    }
  }

  assert(preparedWhileDrawing >= 4, `(b) stones prepared while the GPU drew: ${preparedWhileDrawing}`);

  const images = get(mode.optimizerImages);

  assert(images.length === 9 && images.every(image => image?.pixels && !image.stale), "(d) every cell drawn");
  assert(app.previews.every(({ spin, tilt }) => spin === 0 && tilt === 0), "(d) face up");

  mode.cancelManualOptimizer();
});

Deno.test("when the grid is refilling, it is drawn first and the graph measured after it", async () => {
  // Setup: the optimizer open at 3 x 3 with a GPU that takes four polls a draw (so the fill takes
  // longer than the graph's settle wait), and, once all is done, a rectangle, which refills the grid
  // AND changes the stone in the middle.
  // Test: let everything run, on opening and again after the rectangle.
  // Verifies: each time, the graph's first batch is queued only after the grid's last picture is
  // in -- the grid is what the user watches fill, and measuring first held its first pictures back
  // by the sweep's 1-2 s (measured 2026-09-28) -- and the graph is still measured, of the new
  // stone.
  const { app } = await openOptimizer();

  app.drawPolls = 4;
  settle();

  const lastDone = () => app.events.map(event => event.kind).lastIndexOf("done");
  const firstTiltAfter = start => app.events.findIndex((event, i) => i > start && event.kind === "tilt");

  assert(firstTiltAfter(-1) > lastDone(), "on opening: the graph after the grid");

  const mark = app.events.length - 1;

  mode.selectGridRectangle({ row: 0, column: 0 }, { row: 1, column: 1 });
  settle();

  assert(firstTiltAfter(mark) > lastDone(), "after a rectangle: the graph after the grid");
  assertEqual(get(mode.optimizerTilt).ratios, get(mode.manualOptimizer).state.centre, "and it is of the new centre");

  mode.cancelManualOptimizer();
});

Deno.test("finished pictures reach the grid a few at a time, and the last one at once", async () => {
  // Setup: the optimizer open at 3 x 3, counting every update of the grid's pictures.
  // Test: let the grid fill a step at a time, stopping the moment the ninth draw is finished.
  // Verifies: the grid's pictures were updated fewer times than there are cells -- pictures that
  // finish close together are handed over together (each hand-over redraws the grid's markup) --
  // and at the moment the last draw finishes, with no publishing wait, every cell already shows
  // its picture: the grid does not sit one wait short of done.
  const { app } = await openOptimizer();
  let updates = 0;
  const stop = mode.optimizerImages.subscribe(() => {
    updates += 1;
  });

  updates = 0;

  for (let guard = 0; guard < 100000 && app.events.filter(event => event.kind === "done").length < 9; guard++) {
    advance(1);
  }

  const images = get(mode.optimizerImages);

  assert(images.every(image => image?.pixels && !image.stale), "every cell shows its picture at once");
  assert(updates < 9, `fewer updates than cells: ${updates}`);

  stop();
  mode.cancelManualOptimizer();
});
