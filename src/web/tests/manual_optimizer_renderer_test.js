/*
 * manual_optimizer_renderer_test.js -- tests for the renderer switch in Edit > Manual optimizer
 * (T-0281, 2026-09-28), in src/web/src/lib/manual_optimizer_mode.js. The user:
 *
 *   "can you increase the subdivision count to 11 and automatically change the renderer to
 *   deterministic in manual optimizer mode"
 *
 * (The subdivisions half is tested in manual_optimizer_test.js.) What is under test here:
 *   * opening the mode switches the renderer to Deterministic, from Monte Carlo and from Flat, so
 *     the stone in the middle is drawn the way the grid's previews are;
 *   * closing it -- Done, Cancel (Escape's handler, App.svelte), or another design loaded under it
 *     -- puts back the renderer the user had;
 *   * the switch is a view setting, not a design edit: it adds no step to the mode's own undo or to
 *     the edit history, and it never overwrites the renderer saved as the user's choice
 *     (`gems.renderer` in localStorage, which the page calls its cookie), so a reload while the mode
 *     is open still starts in the renderer the user picked.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The page's real modules (session.js, viewport.js, tier_controller.js, the mode) run against a
 * FAKE GemApp, the same kind as manual_optimizer_tilt_test.js's, which here also counts every
 * `set_renderer` call. localStorage is an in-memory fake that counts every write to each key.
 * Time is virtual, as in that file, so no real timer outlives a test. Real events on the built page
 * (the menu, Escape, the picker behind the panel) are checked in headless Chrome
 * (kb/manual-optimizer-mode-a-grid-of-crown-and-pavili.md).
 */

// ---- the virtual clock, installed before any module that schedules is loaded

let clock = 0;
let timers = [];
let nextTimer = 1;

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
    next.fn();
  }

  throw new Error("the clock ran away: a timer keeps rescheduling itself at once");
}

// ---- localStorage, in memory, counting writes per key

const stored = new Map();
const writes = new Map();

// Defined rather than assigned: Deno has a localStorage of its own (persisted on disk), which an
// assignment would leave in place (theme_test.js does the same).
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    getItem: key => (stored.has(key) ? stored.get(key) : null),
    setItem(key, value) {
      stored.set(key, String(value));
      writes.set(key, (writes.get(key) ?? 0) + 1);
    },
    removeItem: key => stored.delete(key),
  },
});

for (const name of ["gemcad.js", "gemcad_obj.js", "design.js", "gcs.js", "design_mesh.js", "edit_history.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${name}`, import.meta.url)));
}

const { get } = await import("svelte/store");
const { objTextFromBytes } = await import("../src/lib/design_load.js");
const {
  installLoadedDesign, startSession, selectRenderer, RENDERER_SETTING, undo,
} = await import("../src/lib/session.js");
const { engine, renderer, canUndo, canRedo } = await import("../src/lib/stores.js");
const { attachCanvasControls } = await import("../src/lib/viewport.js");
const mode = await import("../src/lib/manual_optimizer_mode.js");

const STARTUP_URL = new URL("../../resources/hex_cut_v2.gcs", import.meta.url);

/** The renderers, as `params::Renderer::as_u32` numbers them. */
const DETERMINISTIC = 0;
const MONTE_CARLO = 1;
const FLAT = 2;

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
 * A fake GemApp with what the session, the view, the renderer picker and the mode call. The
 * previews are ready on the first poll and the tilt batches on the second, as in
 * manual_optimizer_tilt_test.js; `rendererCalls` lists every `set_renderer` value in order.
 */
function fakeApp(startRenderer) {
  const app = {
    params: {
      spin: 0, tilt: 0, headShadowHalfAngle: 15, refractiveIndex: 1.54, dispersion: 0.024,
      maxBounces: 14, observerRadius: 0.1, exposure: 1,
    },
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
    // The renderer, and every change made to it.
    rendererValue: startRenderer,
    rendererCalls: [],
    renderer: () => app.rendererValue,
    set_renderer(value) {
      app.rendererValue = value;
      app.rendererCalls.push(value);
    },
    hidden_controls: () => "",
    hideable_controls: () => "",
    accumulation_status: () => "off: a fake app has no GPU",
    accumulating: () => false,
    accumulation_complete: () => true,
    frame_settled: () => true,
    lighting_model: () => 0,
    has_environment_image: () => false,
    background_enabled: () => false,
    background_color: () => [0, 0, 0],
    window_color_enabled: () => false,
    window_color: () => [0, 0, 0],
    head_shadow_color: () => [0, 0, 0],
    stone_color: () => [1, 1, 1],
    wireframe_enabled: () => false,
    // The previews.
    drawing: null,
    thumbnail_load() {},
    thumbnail_clear() {
      app.drawing = null;
    },
    thumbnail_begin(id, width, height) {
      app.drawing = { width, height };
    },
    thumbnail_poll: () => app.drawing !== null,
    thumbnail_pixels() {
      const { width, height } = app.drawing;

      app.drawing = null;
      return new Uint8Array(width * height * 4);
    },
    // The tilt graph: batches of four poses, two queued at once, each done on its second poll.
    queued: [],
    polls: 0,
    last: null,
    tilt_batch_size: () => 4,
    tilt_can_begin: () => app.queued.length < 2,
    tilt_begin(poses) {
      const batch = [];

      for (let i = 0; i < poses.length; i += 2) {
        batch.push(poses[i + 1]);
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
      return new Float32Array(app.last.flatMap(() => [0.5, 0.7, 0.1, 0.05, 0.98, 0.8, 0.01, 0.0, 1000, 200]));
    },
    tilt_cancel() {
      app.queued = [];
      app.polls = 0;
    },
  };

  return app;
}

/**
 * A fresh page whose user had chosen `startRenderer`, saved as their choice the way the renderer
 * picker saves it (`gems.renderer`), with the startup stone loaded, as boot does it. The optimizer
 * is NOT opened. Returns `{ app, design }`, with the fake app's renderer calls and localStorage's
 * write counts cleared, so a test sees only what happens after this.
 */
async function pageWithRenderer(startRenderer) {
  const app = fakeApp(startRenderer);
  const stone = objTextFromBytes("hex_cut_v2.gcs", await Deno.readFile(STARTUP_URL));

  engine.app = app;
  startSession(app);
  attachCanvasControls({ addEventListener() {}, clientWidth: 100, clientHeight: 100, classList: { add() {}, remove() {} } });
  installLoadedDesign(app, { text: stone.text, design: stone.design, gear: stone.gear, title: "test" });
  // The user's choice, as the picker makes it: the renderer set, the store and the saved value.
  selectRenderer(startRenderer);
  advance(1000);

  app.rendererCalls = [];
  writes.clear();
  return { app, design: stone.design };
}

/** Lets the grid fill and the graph measure (virtual time is free). */
function settle() {
  advance(60000);
}

/** What the renderer is, three ways: in Rust, in the picker's store, and saved as the user's choice. */
function rendererState(app) {
  return { rust: app.renderer(), picker: get(renderer), saved: localStorage.getItem(RENDERER_SETTING) };
}

// ---- opening switches to Deterministic; every way out puts the user's renderer back

// Each test below runs twice: once for a user who had chosen Monte Carlo, once for Flat -- the two
// renderers that are not Deterministic, and so the two the mode switches away from.
for (const [name, start] of [["Monte Carlo", MONTE_CARLO], ["Flat", FLAT]]) {
  Deno.test(`from ${name}: Deterministic while open, and ${name} again after Done`, async () => {
    // Setup: a page whose user chose the starting renderer (saved as their choice), the startup
    // stone loaded.
    // Test: open the manual optimizer, let the grid fill and the graph measure, click a cell (a real
    // design change, so Done has something to keep), then Done.
    // Verifies: while open the renderer is Deterministic in Rust AND in the store the render
    // settings' picker shows, and it stays so through the fill and the click; the saved choice
    // still names the starting renderer and was never written to; after Done the starting renderer
    // is back everywhere; and set_renderer was called exactly twice, once each way.
    const { app } = await pageWithRenderer(start);

    assertEqual(mode.enterManualOptimizer(), true, "the optimizer opens");
    assertEqual(rendererState(app), { rust: DETERMINISTIC, picker: DETERMINISTIC, saved: String(start) },
      "open: Deterministic, the saved choice untouched");

    settle();
    mode.previewGridCell(0, 0);
    settle();
    assertEqual(rendererState(app).rust, DETERMINISTIC, "still Deterministic after the fill and a click");

    mode.exitManualOptimizer();
    assertEqual(rendererState(app), { rust: start, picker: start, saved: String(start) }, `Done: ${name} again`);
    assertEqual(app.rendererCalls, [DETERMINISTIC, start], "one switch each way");
    assertEqual(writes.get(RENDERER_SETTING) ?? 0, 0, "the saved renderer was never written");
  });

  Deno.test(`from ${name}: ${name} again after Cancel (Escape's handler)`, async () => {
    // Setup: a page whose user chose the starting renderer, the startup stone loaded.
    // Test: open the optimizer, click a cell, then Cancel -- the function App.svelte's Escape
    // handler calls too; the real Escape key is checked in headless Chrome.
    // Verifies: Deterministic while open; after Cancel the starting renderer is back in Rust, in
    // the picker's store and in the saved choice, which was never written.
    const { app } = await pageWithRenderer(start);

    mode.enterManualOptimizer();
    assertEqual(rendererState(app).rust, DETERMINISTIC, "open: Deterministic");
    mode.previewGridCell(2, 2);
    settle();

    mode.cancelManualOptimizer();
    assertEqual(rendererState(app), { rust: start, picker: start, saved: String(start) }, `Cancel: ${name} again`);
    assertEqual(app.rendererCalls, [DETERMINISTIC, start], "one switch each way");
    assertEqual(writes.get(RENDERER_SETTING) ?? 0, 0, "the saved renderer was never written");
  });
}

Deno.test("from Deterministic nothing is switched, either way", async () => {
  // Setup: a page whose user chose Deterministic.
  // Test: open the optimizer, let it fill, and Done; open it again and Cancel.
  // Verifies: the renderer is Deterministic throughout, and set_renderer is never called: a user
  // already in Deterministic sees no switch (no shader wait, no redraw), and nothing is saved.
  const { app } = await pageWithRenderer(DETERMINISTIC);

  mode.enterManualOptimizer();
  settle();
  mode.exitManualOptimizer();
  mode.enterManualOptimizer();
  mode.cancelManualOptimizer();

  assertEqual(rendererState(app), { rust: DETERMINISTIC, picker: DETERMINISTIC, saved: String(DETERMINISTIC) },
    "Deterministic throughout");
  assertEqual(app.rendererCalls, [], "set_renderer never called");
  assertEqual(writes.get(RENDERER_SETTING) ?? 0, 0, "nothing saved");
});

Deno.test("another design loaded under the mode also puts the user's renderer back", async () => {
  // Setup: a page whose user chose Monte Carlo, the optimizer open (so Deterministic).
  // Test: load another design (the startup stone again, as a new design object), as File > Open or
  // a shared link does, which ends the mode without Done or Cancel.
  // Verifies: the mode is closed and the renderer is Monte Carlo again, saved choice untouched --
  // no way out of the mode leaves the user in a renderer they did not pick.
  const { app } = await pageWithRenderer(MONTE_CARLO);

  mode.enterManualOptimizer();
  assertEqual(rendererState(app).rust, DETERMINISTIC, "open: Deterministic");

  const other = objTextFromBytes("hex_cut_v2.gcs", await Deno.readFile(STARTUP_URL));

  installLoadedDesign(app, { text: other.text, design: other.design, gear: other.gear, title: "other" });
  assertEqual(mode.manualOptimizerOpen(), false, "the mode closed");
  assertEqual(rendererState(app), { rust: MONTE_CARLO, picker: MONTE_CARLO, saved: String(MONTE_CARLO) },
    "Monte Carlo again");
  assertEqual(writes.get(RENDERER_SETTING) ?? 0, 0, "the saved renderer was never written");
  settle();
});

// ---- the switch is not an edit

Deno.test("the switch adds no undo step, in the mode or in the edit history", async () => {
  // Setup: a page whose user chose Monte Carlo, the startup stone loaded, nothing in the history.
  // Test: (a) open the optimizer and read Edit > Undo/Redo's state (the mode's own stack while
  // open); (b) Done without changing the heights, and read them again (the edit history); (c) open
  // it again, click a cell, Done, then take that one Done entry back with Edit > Undo.
  // Verifies: (a) opening -- and with it the switch to Deterministic -- leaves nothing to undo or
  // redo; (b) closing, and the switch back, leaves the edit history empty too; (c) the only entry a
  // real change leaves is the design's, and undoing it restores the design without touching the
  // renderer, which stays Monte Carlo: the renderer was never part of any history entry.
  const { app } = await pageWithRenderer(MONTE_CARLO);

  mode.enterManualOptimizer();
  assertEqual([get(canUndo), get(canRedo)], [false, false], "(a) nothing to undo in the mode");
  settle();
  assertEqual([get(canUndo), get(canRedo)], [false, false], "(a) nor after the fill");

  mode.exitManualOptimizer();
  assertEqual([get(canUndo), get(canRedo)], [false, false], "(b) nothing in the edit history");
  assertEqual(app.renderer(), MONTE_CARLO, "(b) Monte Carlo again");

  mode.enterManualOptimizer();
  mode.previewGridCell(0, 4);
  mode.exitManualOptimizer();
  assertEqual(get(canUndo), true, "(c) Done left one entry");

  const calls = app.rendererCalls.length;

  undo();
  assertEqual(get(canUndo), false, "(c) and it was the only one");
  assertEqual(app.renderer(), MONTE_CARLO, "(c) undoing it leaves the renderer alone");
  assertEqual(app.rendererCalls.length, calls, "(c) no set_renderer from the undo");
  assertEqual(writes.get(RENDERER_SETTING) ?? 0, 0, "the saved renderer was never written");
  settle();
});
