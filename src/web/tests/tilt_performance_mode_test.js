/*
 * tilt_performance_mode_test.js -- tests for Tools > Tilt performance's mode (T-0261),
 * src/web/src/lib/tilt_performance_mode.js, driving the page's real modules (session.js,
 * tier_controller.js, edit_mode.js, the mode itself) against a FAKE GemApp that records what it is
 * asked to measure and answers each pose after a couple of polls, the way the real one answers
 * once its GPU passes are done.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * What the fake cannot show -- the numbers the real renderer measures, the graph, the pointer --
 * is checked against Gem Cut Studio's graphs over CDP (tools/tilt_compare/, kb/tilt-performance.md)
 * and in the built page.
 *
 * Globals the modules expect, set up as tests/cutting_assistant_test.js does:
 * - `window`: the page asks for redraws through `window.gemRequestRender?.()`.
 * - `setTimeout`: replaced by a queue this file runs by hand (`runTimers`), so a test decides when
 *   the mode's polls get their turn.
 * - The GemCad scripts, which the page loads as classic scripts publishing globals.
 */

let timers = [];

globalThis.window = globalThis.window ?? {};
globalThis.window.addEventListener = () => {};
globalThis.setTimeout = fn => { timers.push(fn); return timers.length; };
globalThis.clearTimeout = () => {};

/** Runs every queued timer, and the ones those queue, until none is left (or `rounds` rounds). */
function runTimers(rounds = 1000) {
  for (let round = 0; round < rounds && timers.length > 0; round++) {
    const due = timers;

    timers = [];
    due.forEach(fn => fn());
  }
}

for (const name of ["gemcad.js", "gemcad_obj.js", "design.js", "gcs.js", "design_mesh.js", "edit_history.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${name}`, import.meta.url)));
}

const { get } = await import("svelte/store");
const { objTextFromBytes } = await import("../src/lib/design_load.js");
const { installLoadedDesign, startSession } = await import("../src/lib/session.js");
const { engine, canUndo } = await import("../src/lib/stores.js");
const { attachCanvasControls } = await import("../src/lib/viewport.js");
const tiers = await import("../src/lib/tier_controller.js");
const { enterEditMode, exitEditMode, editing } = await import("../src/lib/edit_mode.js");
const { sweepPoses, Y_SPIN, DEFAULT_RANGE } = await import("../src/lib/tilt_performance.js");
const { applyParam, selectRenderer } = await import("../src/lib/session.js");
const mode = await import("../src/lib/tilt_performance_mode.js");

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

/**
 * A fake GemApp: enough of the real one for the session and the mode. `tilt_begin` records and
 * queues a batch of poses; `tilt_poll` says the oldest batch is done on its second call, and
 * `tilt_result` then answers with numbers made from each of its poses (ISO = 1 - tilt/100, the
 * rest fixed), so a test can tell which sample landed where.
 */
function fakeApp() {
  const app = {
    params: { spin: 0, tilt: 0, headShadowHalfAngle: 14 },
    begun: [],
    polls: 0,
    cancels: 0,
    load_obj() {},
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
    render() {},
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
    // Batches of up to four poses, two batches queued at once, as the real renderer takes them
    // (in larger batches); the oldest batch is done on the second poll after it reaches the
    // front, and each is collected in the order it was queued.
    queued: [],
    last: null,
    tilt_batch_size: () => 4,
    tilt_can_begin: () => app.queued.length < 2,
    tilt_begin(poses) {
      if (!app.tilt_can_begin() || poses.length > 8) {
        throw new Error("the fake renderer cannot take this batch");
      }

      const batch = [];

      for (let i = 0; i < poses.length; i += 2) {
        app.begun.push({ spin: poses[i], tilt: poses[i + 1] });
        batch.push({ spin: poses[i], tilt: poses[i + 1] });
      }

      app.queued.push(batch);
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
      return new Float32Array(app.last.flatMap(({ tilt }) =>
        [1 - tilt / 100, 0.7, 0.1, 0.05, 0.98, 0.8, 0.01, 0.0, 1000, 200]));
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
 * A fresh page on a fresh fake app with the startup stone loaded, as boot does it, and the tilt
 * range back at its default (the mode keeps it from one opening to the next, and so from one
 * test to the next).
 */
async function page() {
  const app = fakeApp();

  mode.setTiltRange(DEFAULT_RANGE);
  const stone = objTextFromBytes("hex_cut_v2.gcs", await Deno.readFile(STARTUP_URL));

  engine.app = app;
  startSession(app);
  attachCanvasControls({ addEventListener() {}, clientWidth: 100, clientHeight: 100, classList: { add() {}, remove() {} } });
  installLoadedDesign(app, { text: stone.text, design: stone.design, gear: stone.gear, title: "test" });
  app.params.spin = 33;
  app.params.tilt = -12;
  runTimers();

  return { app, design: stone.design };
}

Deno.test("opening measures every pose of the sweep in order, then shows face-up", async () => {
  // Setup: the startup stone on a fresh page, viewed at spin 33, tilt -12, with the Monte Carlo
  // renderer selected and a 14-degree head shadow.
  // Test: open the mode, then let its polls run to the end.
  // Verifies: it opens holding the design, with Undo inert, and swaps Monte Carlo for the
  // deterministic renderer; the renderer is asked for exactly the sweep's poses, X then Y, in
  // order; every sample lands on its own half at its own angle (ISO = 1 - tilt/100 identifies
  // it); the head shadow angle the curve is labelled with is the render settings'; and once the
  // sweep ends the view is back at face-up.
  const { app } = await page();

  app.rendererValue = 1;
  assert(mode.enterTiltPerformance(), "the mode opens");

  const opened = get(mode.tiltPerformance);

  assert(opened.open, "open");
  assertEqual(opened.total, sweepPoses().length, "the whole sweep is to be measured");
  assertEqual(opened.headShadow, 14, "the head shadow angle from the render settings");
  assert(tiers.designLocked(), "the design is held");
  assert(!get(canUndo), "Undo is inert");
  assertEqual(app.rendererValue, 0, "Monte Carlo is swapped for Deterministic");

  runTimers();

  const done = get(mode.tiltPerformance);

  assertEqual(app.begun, sweepPoses().map(({ spin, tilt }) => ({ spin, tilt })), "every pose, in order");
  assertEqual(done.measured, done.total, "all measured");
  assertEqual(done.samples.x.length, done.samples.y.length, "both halves complete");
  assertEqual(done.samples.y[10].angle, 10, "Y samples in angle order");
  assert(Math.abs(done.samples.y[10].measurement.stone.iso - 0.9) < 1e-6, "Y 10's own measurement");
  assert(Math.abs(done.samples.x[33].measurement.stone.iso - 0.67) < 1e-6, "X 33's own measurement");
  assertEqual([app.params.spin, app.params.tilt], [0, 0], "the view ends face-up");
  assertEqual(done.cursor, { axis: "x", angle: 0 }, "the graph's cursor is at face-up");
});

Deno.test("pointing at the graph turns the view; Done puts back the pose and the renderer", async () => {
  // Setup: the startup stone viewed at spin 33, tilt -12 with Monte Carlo, the mode open and its
  // sweep finished.
  // Test: show the Y 20 pose (what pointing at the graph does), then close with Done.
  // Verifies: a Y pose is the quarter-turn spin plus the tilt; Done cancels any measuring, puts
  // back the view's pose and the Monte Carlo renderer, releases the design and closes the panel.
  const { app } = await page();

  app.rendererValue = 1;
  mode.enterTiltPerformance();
  runTimers();

  mode.showPose({ axis: "y", angle: 20 });
  assertEqual([app.params.spin, app.params.tilt], [Y_SPIN, 20], "the Y 20 pose");

  mode.exitTiltPerformance();

  assertEqual([app.params.spin, app.params.tilt], [33, -12], "the pose from before");
  assertEqual(app.rendererValue, 1, "Monte Carlo is back");
  assert(app.cancels > 0, "measuring is cancelled");
  assert(!tiers.designLocked(), "the design is released");
  assert(!get(mode.tiltPerformance).open, "closed");
});

Deno.test("one mode at a time: not over edit mode, and edit mode not over it", async () => {
  // Setup: the startup stone on a fresh page.
  // Test: open edit mode on the first tier and try to open tilt performance; then close it, open
  // tilt performance and try edit mode.
  // Verifies: each refuses while the other is open, so the graph can never go stale under an
  // edit, and nothing is measured when it refuses.
  const { app, design } = await page();

  enterEditMode(design.tiers[0]);
  assert(get(editing) !== null, "setup: edit mode is open");
  assert(!mode.enterTiltPerformance(), "tilt performance refuses over edit mode");
  assertEqual(app.begun.length, 0, "nothing measured");
  exitEditMode();

  assert(mode.enterTiltPerformance(), "tilt performance opens");
  enterEditMode(design.tiers[0]);
  assert(get(editing) === null, "edit mode refuses while it is open");
  mode.exitTiltPerformance();
});

Deno.test("widening the range measures only the new tilts; narrowing it measures nothing", async () => {
  // Setup: the startup stone, the mode open and its default 33-degree sweep finished.
  // Test: widen Tilt X to 35 (what dragging the slider's start thumb does), let the polls run;
  // then narrow both halves to 10.
  // Verifies: only X 34 and 35 are measured after widening, since every pose already measured is
  // kept; the store's range and counts follow; and narrowing asks the renderer for nothing, the
  // samples beyond the new reach staying measured for when it widens again.
  const { app } = await page();

  mode.enterTiltPerformance();
  runTimers();

  const before = app.begun.length;

  mode.setTiltRange({ x: 35 });
  runTimers();

  assertEqual(app.begun.slice(before), [{ spin: 0, tilt: 34 }, { spin: 0, tilt: 35 }], "only the new tilts");

  const widened = get(mode.tiltPerformance);

  assertEqual(widened.range, { x: 35, y: 33 }, "the store's range");
  assertEqual([widened.measured, widened.total], [36 + 34, 36 + 34], "all within reach measured");

  const measuredSoFar = app.begun.length;

  mode.setTiltRange({ x: 10, y: 10 });
  runTimers();

  assertEqual(app.begun.length, measuredSoFar, "narrowing measures nothing");
  assertEqual(get(mode.tiltPerformance).total, 22, "11 tilts a half within reach");
  assertEqual(get(mode.tiltPerformance).samples.x.length, 36, "the samples beyond reach are kept");
  mode.exitTiltPerformance();
});

Deno.test("changing the head shadow angle measures the graph again; the exposure does not", async () => {
  // Setup: the startup stone with a 14-degree head shadow, the mode open and its sweep finished.
  // Test: change the exposure through applyParam (a render setting the measurement overrides),
  // then the head shadow half angle, as the render settings' sliders do; let the timers run.
  // Verifies: the exposure measures nothing again; the head shadow re-measures every pose of the
  // sweep, once (the change is left to rest first, so a slider's drag is one re-measure), and the
  // graph's head shadow label follows the new angle.
  const { app } = await page();

  mode.enterTiltPerformance();
  runTimers();

  const swept = app.begun.length;

  applyParam("exposure", 2);
  runTimers();
  assertEqual(app.begun.length, swept, "the exposure measures nothing");

  applyParam("headShadowHalfAngle", 18);
  applyParam("headShadowHalfAngle", 20);
  runTimers();

  const after = get(mode.tiltPerformance);

  assertEqual(app.begun.length, 2 * swept, "the whole sweep once more");
  assertEqual(after.headShadow, 20, "labelled with the new angle");
  assertEqual([after.measured, after.total], [swept, swept], "all measured again");
  mode.exitTiltPerformance();
});

Deno.test("the view holds still while measuring, and the pointer turns it only once done", async () => {
  // Setup: the startup stone viewed at spin 33, tilt -12; the mode just opened and a few polls
  // run, so the sweep is part way through Tilt X.
  // Test: point at Y 20 mid-sweep; let the sweep finish and point at Y 20 again; then widen the
  // range, which starts measuring again, and point once more.
  // Verifies: the user's two rules (2026-09-25) -- the view is turned face-up once on opening and
  // is NOT turned to each pose as it is measured ("the main gem in the center renders the updated
  // direction, then the graph updates" made the sweep slow), and "only enable mousing over the
  // graph once all the graph is generated": the pointer is ignored mid-sweep, turns the view once
  // done, and is ignored again during a re-measure, which leaves the view where it was.
  const { app } = await page();

  mode.enterTiltPerformance();
  runTimers(5);
  assert(mode.sweeping(), "setup: still measuring");
  assert(app.begun.length > 1, "setup: past the first pose");
  assertEqual([app.params.spin, app.params.tilt], [0, 0], "face-up, not the pose being measured");

  mode.pointAtPose({ axis: "y", angle: 20 });
  assertEqual([app.params.spin, app.params.tilt], [0, 0], "the pointer is ignored mid-sweep");

  runTimers();
  assert(!mode.sweeping(), "setup: the sweep is done");
  assertEqual([app.params.spin, app.params.tilt], [0, 0], "still face-up when done");

  mode.pointAtPose({ axis: "y", angle: 20 });
  assertEqual([app.params.spin, app.params.tilt], [Y_SPIN, 20], "the view at Y 20 once done");

  mode.setTiltRange({ x: 36 });
  assert(mode.sweeping(), "setup: measuring the new tilts");
  assertEqual([app.params.spin, app.params.tilt], [Y_SPIN, 20], "a re-measure leaves the view alone");

  mode.pointAtPose({ axis: "y", angle: 5 });
  assertEqual([app.params.spin, app.params.tilt], [Y_SPIN, 20], "ignored again while measuring");
  mode.exitTiltPerformance();
});

Deno.test("a renderer picked while open is kept on closing", async () => {
  // Setup: the startup stone viewed with Monte Carlo; the mode open, which swaps it for the
  // deterministic renderer.
  // Test: pick the flat renderer in the render settings (which stay on screen), then Done.
  // Verifies: Done does not put Monte Carlo back over the user's own choice.
  const { app } = await page();

  app.rendererValue = 1;
  mode.enterTiltPerformance();
  assertEqual(app.rendererValue, 0, "setup: swapped for Deterministic");

  selectRenderer(2);
  mode.exitTiltPerformance();
  assertEqual(app.rendererValue, 2, "the user's renderer is kept");
});
