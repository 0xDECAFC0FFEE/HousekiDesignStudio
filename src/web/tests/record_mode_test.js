/*
 * record_mode_test.js -- tests for Tools > Record rendering's mode (T-0290),
 * src/web/src/lib/record_mode.js, driving the page's real modules (session.js, tier_controller.js,
 * edit_mode.js, tilt_performance_mode.js, the mode itself) against a FAKE GemApp whose record_*
 * calls behave as the renderer's do (src/renderer/recording.rs: a frame is begun, advanced one draw
 * at a time, then read back), a FAKE canvas the tests press and drag on, a fake clock, and a fake
 * MP4 encoder and Save As dialog in place of the browser's.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * What the fakes cannot show -- real frames drawn off screen, a real H.264 encoder and an MP4
 * that plays -- is checked in headless Chrome with real mouse events (the ticket's close note and
 * kb/record-rendering-mode.md).
 *
 * Globals the modules expect, set up as tests/tilt_performance_mode_test.js does:
 * - `window`: the page asks for redraws through `window.gemRequestRender?.()`.
 * - `setTimeout`: replaced by a queue this file runs by hand (`runTimers`), so a test decides when
 *   the final render's loop gets its turns.
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

/** Lets the promises the mode awaits (the support check, the encoder's finish, the save) settle. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

for (const name of ["gemcad.js", "gemcad_obj.js", "design.js", "gcs.js", "design_mesh.js", "edit_history.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${name}`, import.meta.url)));
}

const { get } = await import("svelte/store");
const { objTextFromBytes } = await import("../src/lib/design_load.js");
const { installLoadedDesign, startSession, selectRenderer } = await import("../src/lib/session.js");
const { engine, canUndo, accumulationTarget, renderer } = await import("../src/lib/stores.js");
const { attachCanvasControls } = await import("../src/lib/viewport.js");
const tiers = await import("../src/lib/tier_controller.js");
const { enterEditMode, exitEditMode, editing } = await import("../src/lib/edit_mode.js");
const tilt = await import("../src/lib/tilt_performance_mode.js");
const mode = await import("../src/lib/record_mode.js");
const { progressBars } = await import("../src/lib/recording.js");

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
 * A fake GemApp: enough of the real one for the session and the mode, plus the renderer's record_*
 * calls. `record_start` keeps the size, renderer and passes it was given; `record_frame` records
 * each pose; `record_advance` submits one draw per call (a frame takes `passes` draws for Monte
 * Carlo, one otherwise -- and one for Monte Carlo too when a test sets `directOnly`, as the real
 * renderer does where the browser cannot accumulate) and on the call after the last draw reports
 * the frame done, whose pixels are the frame's number repeated over width x height x 4 bytes.
 * `record_settled` is always true (the GPU is instant here).
 */
function fakeApp() {
  const draws = () => (app.started?.renderer === 1 && !app.directOnly ? app.started.passes : 1);
  const app = {
    params: { spin: 10, tilt: -20, sideTilt: 5, headShadowHalfAngle: 14, luxSamples: 1 },
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
    renderer_names: () => "Deterministic\nMonte Carlo\nFlat",
    hidden_controls: () => "",
    hideable_controls: () => "",
    accumulation_status: () => "off: a fake app has no GPU",
    accumulating: () => false,
    accumulation_complete: () => true,
    frame_settled: () => true,
    // Tilt performance's measuring, only so the lockout test can open that mode: it never answers.
    tilt_batch_size: () => 4,
    tilt_can_begin: () => true,
    tilt_begin() {},
    tilt_poll: () => false,
    tilt_result: () => new Float32Array(0),
    tilt_cancel() {},
    // ---- the final render
    started: null,
    frames: [],
    stops: 0,
    job: null,
    record_start(width, height, rendererValue, passes) {
      app.started = { width, height, renderer: rendererValue, passes };
    },
    record_frame(spin, tilt, sideTilt) {
      app.frames.push({ spin, tilt, sideTilt });
      app.job = { done: 0 };
    },
    directOnly: false,
    record_advance() {
      if (!app.job) {
        return 3;
      }

      if (app.job.done < draws()) {
        app.job.done += 1;
        return 1;
      }

      app.job = null;
      return 2;
    },
    record_settled: () => true,
    record_passes_done: () => app.job?.done ?? 0,
    record_passes_total: () => draws(),
    record_pixels: () => new Uint8Array(app.started.width * app.started.height * 4).fill(app.frames.length - 1),
    record_stop() {
      app.stops += 1;
      app.job = null;
    },
  };

  return app;
}

/** A fake canvas: keeps the listeners the mode adds, so a test can press and drag on it. */
function fakeCanvas() {
  const listeners = {};

  return {
    listeners,
    clientWidth: 333,
    clientHeight: 777,
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] ?? []).filter(each => each !== fn);
    },
    fire(type, event) {
      (listeners[type] ?? []).forEach(fn => fn({ pointerId: 1, button: 0, ...event }));
    },
  };
}

/** A fake MP4 encoder that keeps the frames it is given, and the browser's Save As dialog. */
function fakeBackend(clock) {
  const made = { encoders: [], saves: [], downloads: [] };

  mode.setRecordBackend({
    hasEncoder: () => true,
    isConfigSupported: config => Promise.resolve({ supported: config.codec.startsWith("avc1.64") }),
    createEncoder(options) {
      const encoder = {
        options, frames: [], closed: false, finished: false,
        add(pixels, index) { encoder.frames.push({ index, first: pixels[0], length: pixels.length }); },
        queueSize: () => 0,
        async finish() {
          encoder.finished = true;
          return new Blob([new Uint8Array(1000)], { type: "video/mp4" });
        },
        close() { encoder.closed = true; },
      };

      made.encoders.push(encoder);
      return encoder;
    },
    picker: () => made.picker ?? null,
    download: (...args) => made.downloads.push(args),
    now: () => clock.t,
  });

  return made;
}

/**
 * A fresh page on a fresh fake app with the startup stone loaded, as boot does it, a fake canvas,
 * a fake clock and backend, the recording settings back at 1280 x 720 at 30 fps with the
 * Deterministic renderer for both, and the render settings' Monte Carlo target at 8 samples.
 */
async function page() {
  const app = fakeApp();
  const canvas = fakeCanvas();
  const clock = { t: 5000 };
  const made = fakeBackend(clock);
  const stone = objTextFromBytes("hex_cut_v2.gcs", await Deno.readFile(STARTUP_URL));

  for (const [key, value] of [["gems.recordPreview", "0"], ["gems.recordFinal", "0"], ["gems.recordFps", "30"],
    ["gems.recordWidth", "1280"], ["gems.recordHeight", "720"]]) {
    try {
      localStorage.setItem(key, value);
    } catch (cause) {
      // No storage in this Deno: the defaults are the same values.
    }
  }

  engine.app = app;
  startSession(app);
  attachCanvasControls({ addEventListener() {}, clientWidth: 100, clientHeight: 100, classList: { add() {}, remove() {} } });
  installLoadedDesign(app, { text: stone.text, design: stone.design, gear: stone.gear, title: "test" });
  accumulationTarget.set(8);
  runTimers();

  return { app, canvas, clock, made, design: stone.design };
}

/** Opens the mode on `canvas` and lets its encoder check answer. */
async function open(canvas) {
  const opened = mode.enterRecording({ canvas });

  await settle();
  return opened;
}

/**
 * Records a take: arms the recorder, presses on the stone at the clock's time, then for each
 * `[ms, spin, tilt, sideTilt]` moves the clock and the stone and fires a pointer move, and lets go
 * at the last one.
 */
function take({ app, canvas, clock }, steps) {
  mode.toggleRecord();
  canvas.fire("pointerdown", {});

  const start = clock.t;

  steps.forEach(([ms, spin, tiltValue, side], at) => {
    clock.t = start + ms;
    app.params.spin = spin;
    app.params.tilt = tiltValue;
    app.params.sideTilt = side;
    canvas.fire(at === steps.length - 1 ? "pointerup" : "pointermove", {});
  });
}

Deno.test("a take is rendered frame by frame in order, one every 1/fps seconds, then saved", async () => {
  // Setup: the startup stone, the mode open at 30 fps and 1280 x 720, and a take of 100 ms: the
  // press at spin 10 / tilt -20 / side 5, a move at 40 ms to (20, -10, 6), and the release at
  // 100 ms at (30, 0, 7). The fake Save As dialog writes the file.
  // Test: record the take, then let the final render's loop run to the end.
  // Verifies the frame count and order on replay: the renderer is started once, at the size set,
  // with the Final renderer; it is given 4 frames (0, 33, 67 and 100 ms) in order, each the pose on
  // screen at that time -- the X, Y and Z rotations all three: the press's still at 33 ms, the
  // move's at 67 -- the first the press and the last the release; the encoder gets the 4 frames' pixels in the same order, numbered 0 to 3; the
  // renderer is stopped when they are done; and the finished video is offered to the Save As
  // dialog under the design's name and saved, the panel reporting 4 frames and 4/30 s.
  const context = await page();
  const { app, canvas, made } = context;
  const written = {};

  made.picker = async options => {
    written.name = options.suggestedName;
    return { createWritable: async () => ({ write: async blob => { written.blob = blob; }, close: async () => {} }) };
  };

  assert(await open(canvas), "the mode opens");
  assertEqual(get(mode.recording).support.state, "ok", "this browser can make the video");

  take(context, [[40, 20, -10, 6], [100, 30, 0, 7]]);
  assertEqual(get(mode.recording).phase, "rendering", "rendering once let go");

  runTimers();
  await settle();

  assertEqual(app.started, { width: 1280, height: 720, renderer: 0, passes: 1 }, "started once, at the size set");
  assertEqual(app.frames, [
    { spin: 10, tilt: -20, sideTilt: 5 },
    { spin: 10, tilt: -20, sideTilt: 5 },
    { spin: 20, tilt: -10, sideTilt: 6 },
    { spin: 30, tilt: 0, sideTilt: 7 },
  ], "every frame's pose, in order");
  assertEqual(made.encoders[0].frames.map(frame => [frame.index, frame.first]), [[0, 0], [1, 1], [2, 2], [3, 3]], "encoded in order");
  assert(app.stops >= 1, "the renderer is stopped when done");

  const state = get(mode.recording);

  assertEqual(state.phase, "done", "done");
  assertEqual([state.result.frames, state.result.width, state.result.height], [4, 1280, 720], "4 frames at 1280 x 720");
  assert(Math.abs(state.result.seconds - 4 / 30) < 1e-9, "4/30 s long");
  assertEqual(state.save, "saved", "saved through the dialog");
  assertEqual(written.name, "test recording.mp4", "under the design's name");
  assert(written.blob instanceof Blob, "the video is what is written");
  mode.exitRecording();
});

Deno.test("the video is the size set, whatever the window, and always even", async () => {
  // Setup: the startup stone, a canvas 333 x 777 CSS pixels (a size no video would have), the mode
  // open.
  // Test: type an odd 1921 x 1081 (what the panel's fields pass on), then record a short take.
  // Verifies: the size is fitted to 1920 x 1080 (even, as H.264 needs) and remembered; the
  // renderer draws every frame at exactly that size, the encoder is made for it, and each frame's
  // pixels are that size -- nothing is taken from the canvas or the window.
  const context = await page();
  const { app, canvas, made } = context;

  await open(canvas);
  mode.setRecordSetting("width", 1921);
  mode.setRecordSetting("height", 1081);
  await settle();

  assertEqual([get(mode.recording).settings.width, get(mode.recording).settings.height], [1920, 1080], "fitted to even");

  take(context, [[50, 40, -20, 5]]);
  runTimers();
  await settle();

  assertEqual([app.started.width, app.started.height], [1920, 1080], "the renderer draws at the size set");
  assertEqual([made.encoders[0].options.width, made.encoders[0].options.height], [1920, 1080], "the encoder too");
  assert(made.encoders[0].frames.every(frame => frame.length === 1920 * 1080 * 4), "every frame that size");
  mode.exitRecording();
});

Deno.test("the view draws with the Preview renderer, frames with the Final one, and the user's comes back", async () => {
  // Setup: the startup stone with the user rendering in Flat (2); the recording settings Preview
  // Deterministic and Final Deterministic; the render settings asking for 8 samples at 2 a pass.
  // Test: open the mode; change Preview to Monte Carlo, then back; pick Flat in the render settings'
  // own picker (which stays on screen); set Final to Monte Carlo and record a take; close.
  // Verifies: opening switches the view to the Preview renderer without saving it as the user's
  // choice; a new Preview renderer draws the view at once; the render settings' picker, while the
  // mode is open, IS the Preview renderer; the frames are drawn with the Final renderer (Monte
  // Carlo, 4 passes a frame: the view's own 8 samples to accumulate over 2 a pass), whatever the
  // view draws with; and closing puts back the renderer the user had before the mode.
  const context = await page();
  const { app, canvas } = context;

  app.rendererValue = 2;
  app.params.luxSamples = 2;
  await open(canvas);
  assertEqual(app.rendererValue, 0, "the view draws with the Preview renderer");

  mode.setRecordSetting("preview", 1);
  assertEqual(app.rendererValue, 1, "a new Preview renderer at once");
  mode.setRecordSetting("preview", 0);
  assertEqual(app.rendererValue, 0, "and back");

  selectRenderer(2);
  assertEqual(get(mode.recording).settings.preview, 2, "the render settings' picker is the Preview renderer");
  mode.setRecordSetting("preview", 0);

  mode.setRecordSetting("final", 1);
  take(context, [[50, 40, -20, 5]]);
  assertEqual(app.rendererValue, 0, "the view still draws with the Preview renderer");
  runTimers();
  await settle();

  assertEqual([app.started.renderer, app.started.passes], [1, 4], "frames with Monte Carlo, 4 passes each");

  mode.exitRecording();
  assertEqual(app.rendererValue, 2, "the user's own renderer is back");
  assertEqual(get(renderer), 2, "and the render settings show it");
  assertEqual([app.params.spin, app.params.tilt, app.params.sideTilt], [10, -20, 5], "and the view's pose from before the take");
});

Deno.test("a level plain drag, which only tips the stone sideways, is a take and replays its Z", async () => {
  // Setup: the startup stone viewed at spin 10, tilt -20, sideways tilt 5; the mode open.
  // Test: a take in which only the sideways tilt moves (what a level plain drag does since T-0296,
  // and a level Ctrl + drag did from T-0288: spin and tilt stay put; a drag with any up or down in
  // it also tilts, which the next test drives), 5 -> 15 at 40 ms -> 25 at the release at 70 ms.
  // Verifies: the take counts (a change of Z alone is movement), and the frames carry the
  // sideways tilt exactly as it was on screen at each frame's time -- 5, 5, 15 and 25 -- with spin
  // and tilt unchanged, so the video reproduces all three angles.
  const context = await page();
  const { app, canvas } = context;

  await open(canvas);
  take(context, [[40, 10, -20, 15], [70, 10, -20, 25]]);
  runTimers();
  await settle();

  assertEqual(get(mode.recording).phase, "done", "rendered");
  assertEqual(app.frames.map(frame => frame.sideTilt), [5, 5, 15, 25], "Z at each frame's time");
  assert(app.frames.every(frame => frame.spin === 10 && frame.tilt === -20), "X and Y unchanged");
  mode.exitRecording();
});

/**
 * Records one diagonal take through the page's OWN drag handler, holding `keys` (`{ ctrlKey,
 * shiftKey }`) on every pointer event, and returns the frames the final render was given.
 *
 * Unlike the tests above, which set the pose by hand, the fake canvas here is wired by viewport.js's
 * real `attachCanvasControls` BEFORE the mode adds its own listeners, as boot does on the page, so
 * each pointer move turns the stone through the real `dragTurn` first and the recorder reads the pose
 * it moved to. The fake app's `orbit` and `orbit_sideways` add their radians to the angles, in
 * degrees, as GemApp's do (a 500 px tall canvas: 2.5 rad per 500 px, so 1 px is 0.005 rad). The
 * stone starts at spin 10, tilt -20, sideways tilt 5. The take: arm, press at (100, 100), move to
 * (140, 70) at 40 ms (40 right, 30 up), then move to (180, 40) at 70 ms (another 40 right, 30 up)
 * and let go there.
 */
async function diagonalTakeThroughTheDragHandler(keys) {
  const context = await page();
  const { app, clock } = context;
  const canvas = fakeCanvas();

  Object.assign(canvas, {
    clientWidth: 800,
    clientHeight: 500,
    setPointerCapture() {},
    hasPointerCapture: () => false,
    releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 500 }),
  });
  app.orbit = (spin, tiltBy) => {
    app.params.spin += spin * (180 / Math.PI);
    app.params.tilt += tiltBy * (180 / Math.PI);
  };
  app.orbit_sideways = side => {
    app.params.sideTilt += side * (180 / Math.PI);
  };
  app.zoom = () => {};
  attachCanvasControls(canvas);
  await open(canvas);

  mode.toggleRecord();

  const start = clock.t;

  canvas.fire("pointerdown", { clientX: 100, clientY: 100, ...keys });
  clock.t = start + 40;
  canvas.fire("pointermove", { clientX: 140, clientY: 70, ...keys });
  clock.t = start + 70;
  canvas.fire("pointermove", { clientX: 180, clientY: 40, ...keys });
  canvas.fire("pointerup", { clientX: 180, clientY: 40, ...keys });
  runTimers();
  await settle();

  assertEqual(get(mode.recording).phase, "done", `${JSON.stringify(keys)}: rendered`);

  const frames = app.frames;

  mode.exitRecording();
  return frames;
}

/** Checks each frame's spin, tilt and sideways tilt against `expected`, to 1e-9 degrees. */
function assertFrames(frames, expected, label) {
  assertEqual(frames.length, expected.length, `${label}: four frames`);
  frames.forEach((frame, at) => {
    const [spin, tiltValue, side] = expected[at];

    assert(Math.abs(frame.spin - spin) < 1e-9, `${label} frame ${at}: spin ${frame.spin}, expected ${spin}`);
    assert(Math.abs(frame.tilt - tiltValue) < 1e-9, `${label} frame ${at}: tilt ${frame.tilt}, expected ${tiltValue}`);
    assert(Math.abs(frame.sideTilt - side) < 1e-9, `${label} frame ${at}: sideways ${frame.sideTilt}, expected ${side}`);
  });
}

Deno.test("a diagonal plain, Ctrl or Shift + drag, through the page's own drag handler, records and replays what it moved", async () => {
  // Background: T-0295 made a Ctrl + drag move two angles at once (the tilt and the sideways tilt);
  // T-0296 made that the PLAIN drag, made Ctrl change nothing, and gave the old plain drag (spin
  // and tilt) to Shift. All three gestures must record and replay.
  // Setup: `diagonalTakeThroughTheDragHandler` (above) three times, on fresh pages: with no key,
  // with Ctrl, with Shift, each the same diagonal take of 40 px right and 30 px up twice.
  // Test: the frames each take gives the final render.
  // Verifies: every take counts, and every frame carries all three angles as they were on screen
  // at its time (30 fps over 70 ms: frames at 0, 33 and 67 ms, and the release held to 70 ms):
  // - plain: spin never moves, the tilt rises by 30 px' worth at each move (dragging up tilts
  //   positively) and the sideways tilt by 40 px' worth -- a replay reproduces both Y and Z;
  // - Ctrl: exactly the plain drag's frames (Ctrl does nothing);
  // - Shift: the sideways tilt never moves, the spin falls by 40 px' worth at each move (a drag to
  //   the right spins the stone the way the old plain drag did) and the tilt rises as before -- a
  //   replay reproduces X and Y.
  const degreesPerPx = (2.5 / 500) * (180 / Math.PI);

  const plain = await diagonalTakeThroughTheDragHandler({});
  const ctrl = await diagonalTakeThroughTheDragHandler({ ctrlKey: true });
  const shift = await diagonalTakeThroughTheDragHandler({ shiftKey: true });

  assertFrames(plain, [
    [10, -20, 5],
    [10, -20, 5],
    [10, -20 + 30 * degreesPerPx, 5 + 40 * degreesPerPx],
    [10, -20 + 60 * degreesPerPx, 5 + 80 * degreesPerPx],
  ], "plain");
  assert(plain[3].tilt > plain[0].tilt && plain[3].sideTilt > plain[0].sideTilt, "plain: both Y and Z moved over the take");

  assertEqual(ctrl, plain, "Ctrl: the plain drag's frames exactly");

  assertFrames(shift, [
    [10, -20, 5],
    [10, -20, 5],
    [10 - 40 * degreesPerPx, -20 + 30 * degreesPerPx, 5],
    [10 - 80 * degreesPerPx, -20 + 60 * degreesPerPx, 5],
  ], "Shift");
  assert(shift[3].spin < shift[0].spin && shift[3].tilt > shift[0].tilt, "Shift: both X and Y moved over the take");
});

/**
 * Renders one take of 4 frames (a 100 ms drag at 30 fps) with `final` as the Final renderer, the
 * render settings at 8 samples to accumulate and `luxSamples` samples a pass, and returns every
 * value the progress store (the panel's two bars) took during the render, in order, with how many
 * times each record_* call was made and the mode's state at the end. `directOnly` makes the fake
 * renderer draw a Monte Carlo frame in one step, as the real one does without float targets.
 */
async function renderWatchingTheBars(final, { luxSamples = 2, directOnly = false } = {}) {
  const context = await page();
  const { app, canvas } = context;
  const calls = {};

  app.params.luxSamples = luxSamples;
  app.directOnly = directOnly;

  for (const name of ["record_advance", "record_settled", "record_passes_done", "record_passes_total", "record_pixels"]) {
    const real = app[name];

    calls[name] = 0;
    app[name] = (...args) => {
      calls[name] += 1;
      return real(...args);
    };
  }

  await open(canvas);
  mode.setRecordSetting("final", final);

  const seen = [];
  const stop = mode.recordProgress.subscribe(progress => {
    // Only the render's own values: arming the recorder empties the store first.
    if (progress.total > 0) {
      seen.push(progress);
    }
  });

  take(context, [[40, 20, -10, 6], [100, 30, 0, 7]]);
  runTimers();
  await settle();
  stop();

  const state = get(mode.recording);
  const last = get(mode.recordProgress);

  mode.exitRecording();
  return { seen, calls, state, last, made: context.made };
}

Deno.test("the two bars: a Monte Carlo frame's bar fills pass by pass and restarts, the video's tracks it", async () => {
  // Background (T-0309): the user asked for "two loading bars - one for each frame's rendering and
  // one for the overall render". One bar that moved only when a frame finished stood still for
  // the ~8 s of a 720p Monte Carlo frame, and the render looked stuck.
  // Setup: `renderWatchingTheBars` with Monte Carlo as the Final renderer: 8 samples to accumulate
  // at 2 a pass is 4 passes a frame, 4 frames. The fake renderer submits one pass a call, as the
  // real one does behind its fence.
  // Test: the mode's own render loop runs to the end; every value of the progress store is kept.
  // Verifies:
  // - the frame bar, frame by frame: empty at the start, then a quarter, a half, three quarters and
  //   full as the 4 passes are given (2, 4, 6 and 8 of 8 samples), then empty again for the next
  //   frame as the finished-frame count goes up -- for all 4 frames, in order;
  // - the whole-video bar is always the finished frames plus the frame bar's share of one frame,
  //   never goes backwards, and ends full;
  // - the bars cost the render nothing: the draws a frame takes are asked once for the whole render
  //   (not at every pass), and the loop's own calls are what they were -- one record_advance and one
  //   settle check a turn, 5 turns a frame (4 passes and the read-back), one read-back per frame --
  //   with only the renderer's count of passes given read at each turn, which is a number it keeps,
  //   not a GPU query;
  // - the video is still made and offered for saving (the bars do not touch the frames).
  const { seen, calls, state, last, made } = await renderWatchingTheBars(1);

  const expected = [[0, 0, 0]];

  for (let frame = 0; frame < 4; frame++) {
    expected.push([frame, 0.25, 2], [frame, 0.5, 4], [frame, 0.75, 6], [frame, 1, 8], [frame + 1, 0, 0]);
  }

  assertEqual(seen.map(p => [p.done, p.frame.fraction, p.frame.samples]), expected, "the frame bar fills pass by pass and restarts every frame");
  assert(seen.every(p => p.frame.stepped && p.frame.samplesTotal === 8 && p.total === 4), "a Monte Carlo frame is measured, out of 8 samples");

  seen.forEach((p, at) => {
    assert(Math.abs(p.fraction - (p.done + p.frame.fraction) / p.total) < 1e-12, `value ${at}: the video bar is the frames done plus the frame's share`);
    assert(at === 0 || p.fraction >= seen[at - 1].fraction, `value ${at}: the video bar never goes back`);
  });
  assertEqual(last.fraction, 1, "the video bar ends full");

  assertEqual(calls.record_passes_total, 1, "the draws a frame takes: asked once");
  assertEqual([calls.record_advance, calls.record_settled, calls.record_pixels], [20, 20, 4], "one advance and one settle check a turn, one read-back a frame");
  assert(calls.record_passes_done <= calls.record_advance, "the pass count read at most once a turn");
  assertEqual([state.phase, made.encoders[0].frames.length], ["done", 4], "the video is still made");
});

Deno.test("the two bars: a frame drawn in one step is shown busy, and the video counts finished frames", async () => {
  // Setup: `renderWatchingTheBars` three times: Deterministic and Flat as the Final renderer (one
  // draw a frame), and Monte Carlo on a renderer that cannot accumulate (`directOnly`: the real one
  // then takes all of a frame's samples in one draw).
  // Test: the mode's render loop to the end, keeping every progress value, then what the panel's
  // bars show for each (recording.js's progressBars), while rendering and once done.
  // Verifies:
  // - no frame is measured part way (`stepped` false throughout) -- including the Monte Carlo
  //   frame drawn in one step, which the mode learns from the renderer rather than assuming from
  //   the renderer's name -- so while rendering the frame bar has no fraction and no value (busy)
  //   and reads "drawn in one step";
  // - the whole-video bar moves only when a frame is finished: 0, 0, 1/4, 1/4, 2/4 ... 4/4, two
  //   turns a frame (the draw, then its read-back), never counting a draw merely given;
  // - once done, both bars are full and the video was made, 4 frames.
  for (const [final, directOnly, label] of [[0, false, "Deterministic"], [2, false, "Flat"], [1, true, "Monte Carlo in one step"]]) {
    const { seen, calls, state, last, made } = await renderWatchingTheBars(final, { directOnly });

    assert(seen.every(p => !p.frame.stepped), `${label}: never measured part way`);
    assertEqual(seen.map(p => p.fraction), [0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1], `${label}: the video bar counts finished frames`);
    assert(seen.every(p => {
      const bars = progressBars(p, "rendering");

      return bars.frame.fraction === null && bars.frame.percent === null && bars.frame.text === "drawn in one step";
    }), `${label}: the frame bar is busy while rendering`);

    const done = progressBars(last, state.phase);

    assertEqual([state.phase, done.frame.fraction, done.video.fraction, done.video.text], ["done", 1, 1, "100%"], `${label}: both full when done`);
    assertEqual([calls.record_passes_total, made.encoders[0].frames.length], [1, 4], `${label}: asked once; 4 frames made`);
  }
});

Deno.test("Cancel stops the final render part way: nothing more is drawn, encoded or saved", async () => {
  // Setup: the startup stone, the mode open with Monte Carlo as the Final renderer (8 passes a
  // frame, so a frame takes several turns), and a take of 300 ms (10 frames at 30 fps).
  // Test: let the final render run a few turns, then Cancel (what the panel's button and Escape
  // do), then let every timer run.
  // Verifies: the renderer is stopped and the encoder closed, no frame is begun after the cancel,
  // nothing is saved or downloaded, the progress bar is emptied, and the mode stays open, idle,
  // with the Preview renderer still drawing the view -- ready for another take.
  const context = await page();
  const { app, canvas, made } = context;

  await open(canvas);
  mode.setRecordSetting("final", 1);
  take(context, [[150, 20, -10, 5], [300, 40, 0, 5]]);
  runTimers(12);

  const begun = app.frames.length;

  assert(begun > 0 && begun < 10, `setup: part way (${begun} of 10 frames begun)`);

  mode.cancelRender();
  runTimers();
  await settle();

  assertEqual(app.frames.length, begun, "no frame begun after the cancel");
  assert(app.stops >= 1, "the renderer is stopped");
  assert(made.encoders[0].closed && !made.encoders[0].finished, "the encoder closed, not finished");
  assertEqual(made.downloads.length, 0, "nothing downloaded");

  const state = get(mode.recording);

  assertEqual([state.open, state.phase, state.save], [true, "idle", null], "open and idle, nothing saved");
  assertEqual(get(mode.recordProgress).fraction, 0, "the video bar is emptied");
  assertEqual(get(mode.recordProgress).frame.fraction, 0, "and the frame bar");
  assertEqual(app.rendererValue, 0, "the Preview renderer still draws the view");
  mode.exitRecording();
});

Deno.test("saving falls back: a Save button when the dialog needs a click, a download without one", async () => {
  // Setup: the startup stone, the mode open; a browser whose Save As dialog refuses to open
  // without a click (Chrome once a render has outlived the click on Record).
  // Test: record a take and let it render; then press Save video (a click, so the dialog opens);
  // then record again in a browser with no Save As dialog at all.
  // Verifies: the finished video is not saved behind the user's back -- the panel says it needs a
  // click and nothing is downloaded -- and Save video then saves it through the dialog; with no
  // dialog the video goes to the browser's downloads, as an MP4 under the design's name.
  const context = await page();
  const { canvas, made } = context;
  let clicked = false;

  made.picker = async () => {
    if (!clicked) {
      const refused = new Error("Must be handling a user gesture to show a file picker.");

      refused.name = "SecurityError";
      throw refused;
    }

    return { createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
  };

  await open(canvas);
  take(context, [[50, 40, -20, 5]]);
  runTimers();
  await settle();

  assertEqual(get(mode.recording).save, "needs-click", "the panel asks for a click");
  assertEqual(made.downloads.length, 0, "nothing saved behind the user's back");

  clicked = true;
  await mode.saveVideo();
  assertEqual(get(mode.recording).save, "saved", "saved once clicked");

  made.picker = null;
  take(context, [[50, 10, -20, 5]]);
  runTimers();
  await settle();

  assertEqual(get(mode.recording).save, "downloaded", "no dialog: downloaded");
  assertEqual([made.downloads[0][0], made.downloads[0][2]], ["test recording.mp4", "video/mp4"], "an MP4 under the design's name");
  mode.exitRecording();
});

Deno.test("the panel is told what became of every save: the file's name, a cancel, a failure", async () => {
  // T-0297 (the user: "saving the mp4 doesn't actually save anything to my hard drive"): the
  // panel said "Saved." with no name, nothing at all after a cancel, and asked for another click
  // when the file could not be written. This drives the mode's own saveVideo through each case.
  // Setup: the startup stone, the mode open, and a Save As dialog the test controls: it opens
  // only when the test lets it (a promise the test resolves, as a user takes their time in the
  // dialog), and then either returns a file the user named "my take.mp4", or is cancelled, or
  // returns a file whose writing fails with a NotAllowedError (the browser refusing the write).
  // Test: record a take and let it render (the automatic save opens the dialog); while it is open,
  // press Save video again; then answer the dialog; then save again, cancelling; then again, with
  // the write failing.
  // Verifies:
  // - while the dialog is open the save is 'saving' and a second Save video opens no second dialog;
  // - once written the save is 'saved' with the name the user gave the file (`saveName`), which
  //   the panel shows;
  // - a cancel is 'cancelled', and nothing is downloaded instead;
  // - a write that fails is 'failed' with the browser's reason in `saveError` -- not 'needs-click',
  //   which would ask the user to click again as if no dialog had opened (the old behaviour), and
  //   not a download somewhere they did not choose.
  const context = await page();
  const { canvas, made } = context;
  let answer = null;
  let opened = 0;
  const written = {};

  made.picker = () => {
    opened += 1;
    return new Promise((resolve, reject) => { answer = { resolve, reject }; });
  };

  await open(canvas);
  take(context, [[50, 40, -20, 5]]);
  runTimers();
  await settle();

  assertEqual([get(mode.recording).phase, get(mode.recording).save], ["done", "saving"], "the dialog is open: saving");

  await mode.saveVideo();
  assertEqual(opened, 1, "a second Save video while the dialog is open opens no second dialog");

  answer.resolve({
    name: "my take.mp4",
    createWritable: async () => ({ write: async blob => { written.blob = blob; }, close: async () => { written.closed = true; } }),
  });
  await settle();

  let state = get(mode.recording);

  assertEqual([state.save, state.saveName, state.saveError], ["saved", "my take.mp4", ""], "saved, under the user's name");
  assert(written.blob instanceof Blob && written.closed, "the video written and the file closed");

  const cancelled = mode.saveVideo();
  const cancel = new Error("The user aborted a request.");

  cancel.name = "AbortError";
  answer.reject(cancel);
  await cancelled;
  assertEqual(get(mode.recording).save, "cancelled", "a cancel is said to be one");
  assertEqual(made.downloads.length, 0, "and nothing is downloaded instead");

  const failing = mode.saveVideo();
  const refused = new Error("The request is not allowed by the user agent or the platform in the current context.");

  refused.name = "NotAllowedError";
  answer.resolve({
    name: "my take.mp4",
    createWritable: async () => ({ write: async () => { throw refused; }, close: async () => {}, abort: async () => {} }),
  });
  await failing;
  state = get(mode.recording);

  assertEqual(state.save, "failed", "a write that fails is a failure, not a request for a click");
  assertEqual(state.saveError, refused.message, "with the browser's reason");
  assertEqual(made.downloads.length, 0, "nothing downloaded somewhere the user did not choose");
  mode.exitRecording();
});

Deno.test("the mode locks out everything behind it, and is locked out by the other modes", async () => {
  // Setup: the startup stone on a fresh page.
  // Test: open edit mode and try to open the recorder; close it, open the recorder, and try edit
  // mode, tilt performance and a second recorder; press on the stone with the recorder idle; close.
  // Verifies: one mode at a time -- the recorder refuses over edit mode, and edit mode, tilt
  // performance and a second opening refuse while it is open; while open the design is held (the
  // tier toolbar's lock), Undo is inert, and a click on the stone picks nothing (it belongs to the
  // recorder); a press with the recorder idle records nothing; and closing releases all of it.
  const context = await page();
  const { app, canvas, design } = context;

  enterEditMode(design.tiers[0]);
  assert(get(editing) !== null, "setup: edit mode is open");
  assert(!(await open(canvas)), "the recorder refuses over edit mode");
  exitEditMode();

  assert(await open(canvas), "the recorder opens");
  assert(tiers.designLocked(), "the design is held");
  assert(!get(canUndo), "Undo is inert");
  assert(tiers.stonePickBlocked(), "a click on the stone picks nothing");

  enterEditMode(design.tiers[0]);
  assert(get(editing) === null, "edit mode refuses while it is open");
  assert(!tilt.enterTiltPerformance(), "tilt performance refuses while it is open");
  assert(!mode.enterRecording({ canvas }), "a second opening refuses");

  canvas.fire("pointerdown", {});
  canvas.fire("pointerup", {});
  assertEqual([get(mode.recording).phase, app.frames.length], ["idle", 0], "an idle press records nothing");

  mode.exitRecording();
  assert(!tiers.designLocked(), "the design is released");
  assert(!tiers.stonePickBlocked(), "the stone can be picked again");
  assert(tilt.enterTiltPerformance(), "tilt performance opens again");
  tilt.exitTiltPerformance();
});

Deno.test("a click that never moves the stone is not a take; Escape steps back one thing at a time", async () => {
  // Setup: the startup stone, the mode open and armed.
  // Test: press and let go without moving; then press, move and press Escape mid-take; then Escape
  // again, and again.
  // Verifies: a still press renders nothing and leaves the recorder armed with a note; Escape mid
  // take drops it (still armed, nothing rendered); the next Escape disarms; the last closes the
  // mode, with the user's renderer back.
  const context = await page();
  const { app, canvas } = context;

  await open(canvas);
  mode.toggleRecord();
  canvas.fire("pointerdown", {});
  canvas.fire("pointerup", {});

  assertEqual(get(mode.recording).phase, "armed", "still armed");
  assert(get(mode.recording).message.length > 0, "with a note");
  assertEqual(app.started, null, "nothing rendered");

  canvas.fire("pointerdown", {});
  app.params.spin = 45;
  canvas.fire("pointermove", {});
  mode.escapeRecording();
  assertEqual(get(mode.recording).phase, "armed", "Escape drops the take");
  canvas.fire("pointerup", {});
  assertEqual(app.started, null, "and it is not rendered");

  mode.escapeRecording();
  assertEqual(get(mode.recording).phase, "idle", "the next Escape disarms");
  mode.escapeRecording();
  assert(!get(mode.recording).open, "the last closes the mode");
});

Deno.test("a browser that cannot encode MP4 says so, and the recorder cannot be armed", async () => {
  // Setup: the startup stone, and a browser with no WebCodecs video encoder.
  // Test: open the mode and press Record.
  // Verifies: the panel's support state is 'unsupported' with a reason naming what is missing and
  // which browsers can, and Record does nothing -- rather than failing silently at the end of a
  // long render.
  const context = await page();

  mode.setRecordBackend({ hasEncoder: () => false, now: () => context.clock.t });
  await open(context.canvas);

  const state = get(mode.recording);

  assertEqual(state.support.state, "unsupported", "unsupported");
  assert(/WebCodecs/.test(state.support.reason) && /Chrome/.test(state.support.reason), "says why and where it works");

  mode.toggleRecord();
  assertEqual(get(mode.recording).phase, "idle", "Record does nothing");
  mode.exitRecording();
});
