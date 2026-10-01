/*
 * ctrl_tilt_test.js -- tests for the drag gestures that turn the stone: the sideways tilt (T-0288)
 * and which modifier key gives which drag (T-0296).
 *
 * History, because the file's name comes from the first of these:
 * - T-0288 (the user, 2026-09-29: "when i press ctrl can you make the renderer be able to tilt the
 *   z axis left and right"): holding Ctrl while dragging sideways tipped the stone's optical axis
 *   (the one pointing at you when the stone is face-up) to the left or right, about the screen's
 *   vertical axis. A plain drag spun the stone about its axis.
 * - T-0295 (the same day, "clicking ctrl shouldn't lock up/down"): with Ctrl held, up and down
 *   still tilted the stone exactly as a plain drag did.
 * - T-0296 (the same day, "can you make ctrl mode default (holding ctrl doesn't do anything) and
 *   change shift to the old default mode (left right spins, up/down same)"): a PLAIN drag is now
 *   what the Ctrl + drag was (sideways tips the axis, up and down tilt), Ctrl changes nothing, and a
 *   SHIFT + drag is the old plain drag (sideways spins, up and down tilt).
 *
 * Rust holds the sideways angle (camera.rs's `side_tilt`, the `sideTilt` parameter) and its maths
 * is tested there: a sideways tilt of 0 is the old pose bit for bit, positive tips the axis to
 * screen right, and every step is a turn about the screen's vertical from any pose. This file tests
 * the page's half:
 *
 *   1. the gesture (viewport.js): which pointer moves turn the stone which way. Each of the three
 *      drags is compared, bit for bit, with a line-for-line copy of the gesture code as it was just
 *      before T-0296 (`dragTurnBeforeT0296` below): the plain drag with the old Ctrl + drag, the
 *      Shift + drag with the old plain drag, and the Ctrl + drag with the plain drag. Also Shift
 *      pressed or let go of mid-drag, the Mac's Ctrl + click context menu being kept out of the way,
 *      and the gesture being the only way to set the sideways angle (T-0288's Sideways tilt slider
 *      was removed at the user's request, T-0294);
 *   2. what depends on the pose: the index dial's face-up fade (index_dial.js), the pose the modes
 *      save and restore (session.js's readPose / applyPose, scale height's side profile), and the
 *      double-click turn towards a facet bringing the stone back upright.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * What a fake canvas cannot show -- real key and mouse events in a browser, the pixels, that no
 * context menu appears -- is checked in headless Chrome over CDP (the ticket's close note).
 *
 * Globals the modules expect, set up as tests/cutting_assistant_test.js does:
 * - `window`: the page asks for redraws through `window.gemRequestRender?.()`.
 * - `setTimeout`, `requestAnimationFrame`: replaced by queues this file runs by hand, so a test
 *   decides when the render loop, the sliders' follow and the facet turn's frames get their turn.
 * - The GemCad scripts, which the page loads as classic scripts publishing globals.
 */

let timers = [];
let frames = [];

globalThis.window = globalThis.window ?? {};
globalThis.window.addEventListener = () => {};
globalThis.setTimeout = fn => { timers.push(fn); return timers.length; };
globalThis.clearTimeout = () => {};
// Frames carry an id, so a cancelled one really is taken off the queue, as the browser does: the
// Top-button test below checks that a facet turn in flight is stopped by `cancelAnimationFrame`.
let nextFrameId = 1;

globalThis.requestAnimationFrame = fn => {
  const id = nextFrameId++;

  frames.push({ id, fn });
  return id;
};
globalThis.cancelAnimationFrame = id => { frames = frames.filter(frame => frame.id !== id); };

/** Runs every queued timer, and the ones those queue, until none is left (or 100 rounds). */
function runTimers() {
  for (let round = 0; round < 100 && timers.length > 0; round++) {
    const due = timers;

    timers = [];
    due.forEach(fn => fn());
  }
}

/** Runs every queued animation frame at time `now`, and the ones those queue (up to 100 rounds). */
function runFrames(now) {
  for (let round = 0; round < 100 && frames.length > 0; round++) {
    const due = frames;

    frames = [];
    due.forEach(frame => frame.fn(now));
  }
}

for (const name of ["gemcad.js", "gemcad_obj.js", "design.js", "gcs.js", "design_mesh.js", "edit_history.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${name}`, import.meta.url)));
}

const { engine } = await import("../src/lib/stores.js");
const { attachCanvasControls, dragTurn, blocksContextMenu } = await import("../src/lib/viewport.js");
const { startSession, readPose, applyPose } = await import("../src/lib/session.js");
const { offFaceOn, dialOpacity } = await import("../src/lib/index_dial.js");
const { SIDE_PROFILE, currentPose, showPose } = await import("../src/lib/scale_height_mode.js");
const { VIEW_SLIDERS, PARAM_SLIDERS, FORMAT, SLIDER_SPECS } = await import("../src/lib/panel_config.js");

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

/**
 * A stand-in for GemApp with what the canvas, the render loop and the pose helpers call. It keeps
 * the parameters it is given (`params`) and logs every turn the drag asks for (`turns`):
 * `['orbit', spin, tilt]` or `['sideways', angle]`, in radians, exactly as passed. A click that
 * lands on the stone finds facet 4, facing spin 30, tilt 40 (`facet_pose_at`'s shape).
 */
function fakeApp() {
  const app = {
    params: { spin: 0, tilt: 0, sideTilt: 0 },
    turns: [],
    highlighted: [],
    orbit(spin, tilt) {
      app.turns.push(["orbit", spin, tilt]);
    },
    orbit_sideways(angle) {
      app.turns.push(["sideways", angle]);
    },
    get_param: name => app.params[name] ?? 0,
    set_param(name, value) {
      app.params[name] = value;
    },
    facet_pose_at: () => [30, 40, 4],
    facet_count: () => 0,
    facet_normals: () => new Float32Array(0),
    set_highlighted_facets(ids) {
      app.highlighted = Array.from(ids);
    },
    set_highlighted_facet(id) {
      app.highlighted = id < 0 ? [] : [id];
    },
    set_frosted_facets() {},
    set_draft_mode() {},
    render() {},
    renderer: () => 0,
    set_renderer() {},
    hidden_controls: () => "",
    hideable_controls: () => "",
    accumulation_status: () => "off: a fake app has no GPU",
    accumulating: () => false,
    accumulation_complete: () => true,
    frame_settled: () => true,
    zoom() {},
  };

  return app;
}

/**
 * A stand-in for the canvas element: it keeps the listeners attachCanvasControls adds, by event
 * type, and `fire(type, event)` calls them the way the browser would. 800 x 500 CSS pixels, at the
 * page's origin.
 */
function fakeCanvas() {
  const listeners = {};

  return {
    listeners,
    clientWidth: 800,
    clientHeight: 500,
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    setPointerCapture() {},
    hasPointerCapture: () => false,
    releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 500 }),
    fire(type, event) {
      for (const fn of listeners[type] ?? []) {
        fn(event);
      }
    },
  };
}

/**
 * A pointer event as the canvas's listeners read it: the left button, pointer 1, with the modifier
 * keys in `keys` (`{ ctrlKey, shiftKey }`, each false when left out), as a browser sets them on
 * every pointer event from the keys held at that moment.
 */
function pointer(clientX, clientY, keys = {}) {
  return { pointerId: 1, button: 0, clientX, clientY, ctrlKey: false, shiftKey: false, ...keys };
}

// Modifier sets for `drag` below, so a path reads as what is held at each move.
const PLAIN = {};
const CTRL = { ctrlKey: true };
const SHIFT = { shiftKey: true };
const CTRL_SHIFT = { ctrlKey: true, shiftKey: true };

/**
 * The gesture as it was just before T-0296, copied line for line from viewport.js at commit d82d657
 * (T-0295): with Ctrl held the horizontal part tipped the axis sideways, without it the horizontal
 * part spun the stone. The tests below hold the new gesture to this, bit for bit, so the only change
 * T-0296 makes is which keys give which of the two drags.
 */
function dragTurnBeforeT0296(deltaX, deltaY, { height, ctrlKey = false, reverseSpin = false }) {
  const scale = 2.5 / height;

  if (ctrlKey) {
    return { spin: -0, tilt: -deltaY * scale, sideways: deltaX * scale };
  }

  const spinSign = reverseSpin ? 1 : -1;

  return { spin: spinSign * deltaX * scale, tilt: -deltaY * scale };
}

/**
 * True when two turns are the same to the last bit: the same keys, in the same order, and each value
 * the same by Object.is, which tells -0 from +0 (JSON and === do not).
 */
function sameTurn(a, b) {
  const keys = Object.keys(a);

  return JSON.stringify(keys) === JSON.stringify(Object.keys(b)) && keys.every(key => Object.is(a[key], b[key]));
}

/** The same, for two logs of `app.turns` (`['orbit', spin, tilt]` / `['sideways', angle]`). */
function sameTurns(a, b) {
  return a.length === b.length && a.every((turn, at) =>
    turn.length === b[at].length && turn.every((value, i) => Object.is(value, b[at][i])));
}

/** Every move size used by the grid tests: -80 to 80 CSS px in steps that hit 0 and odd sizes. */
const DELTAS = [-80, -73, -41, -10, -3, -1, 0, 1, 3, 10, 41, 73, 80];

/** A fresh page: a fake app as `engine.app`, its session, and the canvas wired to it. */
function page() {
  const app = fakeApp();
  const canvas = fakeCanvas();

  engine.app = app;
  startSession(app);
  attachCanvasControls(canvas);
  runTimers();

  return { app, canvas };
}

/**
 * Drags from (x0, y0) through each of `moves` -- `[x, y, keys]`, `keys` one of PLAIN, CTRL, SHIFT,
 * CTRL_SHIFT (plain when left out) -- and lets go at the last one. The press carries the first
 * move's keys, as it would if they were held from the start. A move within 4 CSS px of the press is
 * inside the click slop and turns nothing; the first one past it is when a press becomes a drag.
 */
function drag(canvas, x0, y0, moves) {
  canvas.fire("pointerdown", pointer(x0, y0, moves[0][2]));

  for (const [x, y, keys] of moves) {
    canvas.fire("pointermove", pointer(x, y, keys));
  }

  const [x, y, keys] = moves[moves.length - 1];

  canvas.fire("pointerup", pointer(x, y, keys));
  runTimers();
}

/** The turns a fresh page's app is asked for by one drag along `moves` from (x0, y0). */
function turnsOf(x0, y0, moves) {
  const { app, canvas } = page();

  drag(canvas, x0, y0, moves);
  return app.turns;
}

// ===========================================================================
// 1. The gesture
// ===========================================================================

Deno.test("a plain drag is bit for bit what a Ctrl + drag was before T-0296", () => {
  // The user (2026-09-29, T-0296): "can you make ctrl mode default".
  // Setup: moves of every size and sign up to 80 CSS px either way (DELTAS, both axes, so level,
  // upright and diagonal moves all occur), on canvases 100 to 2000 px tall, with and without the
  // cutting assistant's reversed spin; then a real drag on the fake canvas.
  // Test: `dragTurn` with no key held, against the pre-T-0296 gesture WITH Ctrl held
  // (`dragTurnBeforeT0296(..., { ctrlKey: true })`), compared key for key with Object.is so -0 and
  // +0 are told apart; then the calls a real plain drag makes into the app.
  // Verifies the done-when "a plain drag equals today's Ctrl-drag, bit for bit": the same three
  // numbers -- spin exactly -0 (spin untouched), tilt -deltaY x 2.5 / height, sideways +deltaX x
  // 2.5 / height -- in the same order, for every move; and on the canvas each move past the click
  // slop asks for `orbit(-0, tilt)` then `orbit_sideways(angle)`, the old Ctrl + drag's calls.
  for (const height of [100, 500, 937, 2000]) {
    for (const reverseSpin of [false, true]) {
      for (const deltaX of DELTAS) {
        for (const deltaY of DELTAS) {
          const now = dragTurn(deltaX, deltaY, { height, reverseSpin });
          const before = dragTurnBeforeT0296(deltaX, deltaY, { height, ctrlKey: true, reverseSpin });

          assert(sameTurn(now, before),
            `plain (${deltaX}, ${deltaY}) on ${height}: ${JSON.stringify(now)} vs old Ctrl ${JSON.stringify(before)}`);
        }
      }
    }
  }

  const { app, canvas } = page();
  const scale = 2.5 / canvas.clientHeight;

  drag(canvas, 100, 100, [[102, 101], [130, 90], [170, 120]]);

  // The move to (102, 101) is inside the slop and turns nothing, so the first turn is the whole way
  // from the press: 30 right and 10 up; the second is the 40 right and 30 down after it.
  assert(sameTurns(app.turns, [
    ["orbit", -0, -(-10) * scale], ["sideways", 30 * scale],
    ["orbit", -0, -30 * scale], ["sideways", 40 * scale],
  ]), `a plain drag on the canvas asks for the old Ctrl + drag's calls: ${JSON.stringify(app.turns)}`);
});

Deno.test("a Shift + drag is bit for bit what a plain drag was before T-0296", () => {
  // The user (2026-09-29, T-0296): "change shift to the old default mode (left right spins,
  // up/down same)".
  // Setup: the same grid of moves, heights and reversed spin as the test above; then a real drag
  // with Shift held on the fake canvas, made of three moves.
  // Test: `dragTurn` with Shift held against the pre-T-0296 gesture with NO key held; then the
  // calls into the app.
  // Verifies the done-when "a Shift-drag equals today's plain drag, bit for bit": spin
  // (spinSign x deltaX x 2.5 / height, the cutting assistant's reversed spin included) and tilt are
  // identical to the last bit, there is no sideways turn, and on the canvas the drag only ever calls
  // `orbit` with those numbers, never `orbit_sideways`; the first 4 px of a press are still the
  // click slop that turns nothing.
  for (const height of [100, 500, 937, 2000]) {
    for (const reverseSpin of [false, true]) {
      for (const deltaX of DELTAS) {
        for (const deltaY of DELTAS) {
          const now = dragTurn(deltaX, deltaY, { height, shiftKey: true, reverseSpin });
          const before = dragTurnBeforeT0296(deltaX, deltaY, { height, reverseSpin });

          assert(sameTurn(now, before),
            `Shift (${deltaX}, ${deltaY}) on ${height}: ${JSON.stringify(now)} vs old plain ${JSON.stringify(before)}`);
          assertEqual(Object.keys(now), ["spin", "tilt"], "a Shift + drag spins and tilts, and tips nothing");
        }
      }
    }
  }

  const { app, canvas } = page();
  const scale = 2.5 / canvas.clientHeight;

  drag(canvas, 100, 100, [[102, 101, SHIFT], [130, 90, SHIFT], [170, 120, SHIFT]]);

  assert(sameTurns(app.turns, [
    ["orbit", -1 * 30 * scale, -(-10) * scale],
    ["orbit", -1 * 40 * scale, -30 * scale],
  ]), `two turns past the slop, each the move since the last, as orbit(spin, tilt): ${JSON.stringify(app.turns)}`);
});

Deno.test("Ctrl changes nothing: a Ctrl + drag is a plain drag, and Ctrl + Shift a Shift + drag", () => {
  // The user (2026-09-29, T-0296): "holding ctrl doesn't do anything".
  // Setup: one path on the fake canvas with level, upright and diagonal moves in it (right, up,
  // diagonal down-left, down), dragged four times on fresh pages: with no key, with Ctrl, with
  // Shift, and with Ctrl and Shift.
  // Test: the turns each drag asks the app for, compared call for call and bit for bit.
  // Verifies the done-when "a Ctrl-drag equals a plain drag": holding Ctrl leaves every call
  // exactly as it is without it, whether or not Shift is held too, so Ctrl neither picks a gesture
  // nor combines with Shift into a third one. The plain and Shift drags themselves differ (the
  // setup check), so the comparison is not vacuous.
  const path = [[140, 100], [140, 60], [110, 90], [110, 130]];
  const along = keys => path.map(([x, y]) => [x, y, keys]);

  const plain = turnsOf(100, 100, along(PLAIN));
  const ctrl = turnsOf(100, 100, along(CTRL));
  const shift = turnsOf(100, 100, along(SHIFT));
  const ctrlShift = turnsOf(100, 100, along(CTRL_SHIFT));

  assert(plain.length === 8 && shift.length === 4 && !sameTurns(plain, shift),
    "setup: the plain drag tips and tilts (8 calls), the Shift drag spins and tilts (4 calls)");
  assert(sameTurns(ctrl, plain), `Ctrl + drag is the plain drag: ${JSON.stringify(ctrl)}`);
  assert(sameTurns(ctrlShift, shift), `Ctrl + Shift + drag is the Shift drag: ${JSON.stringify(ctrlShift)}`);
});

Deno.test("a plain drag right tips the axis right, left tips it left, and a level move changes nothing else", () => {
  // Background: T-0288 wrote this test for the Ctrl + drag (with "up or down does nothing", which
  // T-0295 reversed). Since T-0296 it is the plain drag, and the Ctrl + drag is the same thing.
  // Setup: purely horizontal moves with no key held, pure `dragTurn` first, then a real drag on the
  // fake canvas: 5 px right (past the click slop), 60 px right, then 30 px left, all level; and the
  // same drag with Ctrl held.
  // Test: what each move asks the app for.
  // Verifies:
  // - a move to the right gives a POSITIVE sideways angle, which camera.rs's
  //   `positive_side_tilt_tips_the_stones_axis_towards_screen_right` shows tips the axis to screen
  //   right -- the tip follows the pointer; a move to the left the same angle negated; at the
  //   drag's rate, 2.5 radians per canvas height; and the cutting assistant's reversed spin does
  //   not reverse it;
  // - a level move changes ONLY the sideways tilt: the `orbit` it also asks for is (-0, -0), which
  //   adds nothing to either spin or tilt, bit for bit (x + -0 is x for every x, -0 and +0
  //   included), so neither moves. Compared with Object.is, so a +0 (which could turn a -0 angle
  //   into +0) would fail.
  for (const reverseSpin of [false, true]) {
    const right = dragTurn(60, 0, { height: 500, reverseSpin });
    const left = dragTurn(-60, 0, { height: 500, reverseSpin });

    assertEqual(Object.keys(right), ["spin", "tilt", "sideways"], "a spin, a tilt and a sideways turn");
    assert(Object.is(right.sideways, 60 * (2.5 / 500)), "right: +60 px at 2.5 rad per height");
    assert(Object.is(left.sideways, -right.sideways), "left: the same turn the other way");
    assert(right.sideways > 0, "a drag to the right tips the axis right");

    for (const turn of [right, left]) {
      assert(Object.is(turn.spin, -0) && Object.is(turn.tilt, -0), "level: spin and tilt get exactly -0");
    }
  }

  const scale = 2.5 / 500;

  for (const keys of [PLAIN, CTRL]) {
    const turns = turnsOf(200, 200, [[205, 200, keys], [265, 200, keys], [235, 200, keys]]);

    assert(sameTurns(turns, [
      ["orbit", -0, -0], ["sideways", 5 * scale],
      ["orbit", -0, -0], ["sideways", 60 * scale],
      ["orbit", -0, -0], ["sideways", -30 * scale],
    ]), `${JSON.stringify(keys)}: every level move is a sideways turn by its own horizontal distance, and nothing else`);
  }
});

Deno.test("up and down tilt the stone identically in a plain, a Ctrl and a Shift + drag", () => {
  // Background: T-0295 made the Ctrl + drag's up and down tilt exactly as the plain drag's did (the
  // user: "clicking ctrl shouldn't lock up/down"); T-0296 keeps it for all three ("up/down same").
  // Setup: purely vertical moves, every size and sign up to 80 CSS px, on canvases 100 to 2000 px
  // tall, with and without the cutting assistant's reversed spin; then real drags on fresh fake
  // canvases along the same path -- 10, 40 and 25 px, up and down -- with no key, Ctrl and Shift.
  // Test: `dragTurn` with and without Shift, compared with Object.is (so -0 and +0 are told apart);
  // then the `orbit` calls the three real drags make.
  // Verifies:
  // - the tilt is the same to the last bit whichever key is held: same rate (2.5 rad per canvas
  //   height) and same direction (dragging up tilts positively), whatever the canvas height;
  // - the spin a straight up-and-down move passes is -0 in both (with Shift and the spin not
  //   reversed, -1 x 0 x scale is -0 too), so `orbit` receives identical arguments and the stone
  //   ends in the identical pose; with the reversed spin, Shift's is +1 x 0 = +0, as before T-0296;
  // - a straight up-and-down plain move does not tip the axis: its sideways turn is exactly 0;
  // - on the canvas, the three drags' `orbit` calls are the same, call for call.
  for (const height of [100, 500, 937, 2000]) {
    for (const reverseSpin of [false, true]) {
      for (let deltaY = -80; deltaY <= 80; deltaY += 3) {
        const plain = dragTurn(0, deltaY, { height, reverseSpin });
        const shift = dragTurn(0, deltaY, { height, shiftKey: true, reverseSpin });

        assert(Object.is(plain.tilt, shift.tilt), `tilt for ${deltaY} px on ${height}: ${plain.tilt} vs ${shift.tilt}`);
        assert(Object.is(plain.tilt, -deltaY * (2.5 / height)), `the drag's own expression for ${deltaY}`);
        assert(Object.is(plain.spin, dragTurn(0, deltaY, { height, shiftKey: true }).spin), "the same -0 spin as Shift's");
        assert(Object.is(plain.sideways, 0), "straight up or down: no sideways turn");
      }
    }
  }

  assert(dragTurn(0, -40, { height: 500 }).tilt > 0, "dragging up tilts positively");

  const path = [[100, 110], [100, 150], [100, 125]];
  const orbits = keys => turnsOf(100, 100, path.map(([x, y]) => [x, y, keys])).filter(turn => turn[0] === "orbit");
  const plain = orbits(PLAIN);

  assertEqual(plain.length, 3, "setup: three moves past the slop");

  for (const keys of [CTRL, SHIFT]) {
    assert(sameTurns(orbits(keys), plain), `${JSON.stringify(keys)}: the plain drag's orbit calls`);
  }
});

Deno.test("a diagonal plain drag tips the axis sideways and tilts the stone at once", () => {
  // Setup: a real drag with no key held on the fake canvas (800 x 500): 30 px right and 40 px up,
  // then 20 px left and 10 px down, then 50 px right and 50 px down.
  // Test: the turns the app is asked for, in order.
  // Verifies the two halves together: each move asks for BOTH an `orbit` whose tilt is
  // -deltaY x 2.5 / height (so up is positive) and whose spin is -0 (no spin), and a sideways turn
  // of +deltaX x 2.5 / height (right is positive); each by that move's own distance only, so the two
  // angles follow the pointer's two directions independently.
  const { app, canvas } = page();
  const scale = 2.5 / canvas.clientHeight;

  drag(canvas, 300, 300, [[330, 260], [310, 270], [360, 320]]);

  assert(sameTurns(app.turns, [
    ["orbit", -0, 40 * scale], ["sideways", 30 * scale],
    ["orbit", -0, -10 * scale], ["sideways", -20 * scale],
    ["orbit", -0, -50 * scale], ["sideways", 50 * scale],
  ]), `each diagonal move: its vertical to the tilt, its horizontal to the sideways tilt: ${JSON.stringify(app.turns)}`);
});

Deno.test("pressing or letting go of Shift in the middle of a drag switches from the next move on, with no jump", () => {
  // Setup: one unbroken diagonal drag on the fake canvas, 20 px right and 10 px up per move: two
  // moves without Shift, two with it (Shift pressed mid-drag), two without (let go mid-drag). Then
  // the same path with Ctrl pressed and let go instead of Shift.
  // Test: the turns the app is asked for, in order.
  // Verifies the done-when "toggling Shift mid-drag gives no jump": the gesture is decided move by
  // move from each move's own `shiftKey`, not once at the press; the switch happens on the very
  // next move in each direction; and nothing jumps -- each move turns the stone by only that move's
  // 20 px and 10 px, because both gestures measure from the last position. Only the horizontal part
  // changes meaning (a sideways tip without Shift, a spin with it): the vertical part is the same
  // tilt on every one of the six moves, so the tilt runs on through both switches at an unbroken
  // rate. Ctrl toggled the same way changes nothing at all: all six moves are the plain drag's.
  const scale = 2.5 / 500;
  const step = 20 * scale;
  const up = -(-10) * scale;
  const toggled = keys => turnsOf(100, 300, [
    [120, 290, PLAIN], [140, 280, PLAIN],
    [160, 270, keys], [180, 260, keys],
    [200, 250, PLAIN], [220, 240, PLAIN],
  ]);

  const turns = toggled(SHIFT);

  assert(sameTurns(turns, [
    ["orbit", -0, up], ["sideways", step],
    ["orbit", -0, up], ["sideways", step],
    ["orbit", -step, up],
    ["orbit", -step, up],
    ["orbit", -0, up], ["sideways", step],
    ["orbit", -0, up], ["sideways", step],
  ]), `plain, Shift, plain: each move's own 20 px across and 10 px up, as the key was at that move: ${JSON.stringify(turns)}`);

  const tilts = turns.filter(turn => turn[0] === "orbit").map(turn => turn[2]);

  assert(tilts.length === 6 && tilts.every(tilt => Object.is(tilt, up)), "the tilt is identical on all six moves");

  const plain = turnsOf(100, 300, [120, 140, 160, 180, 200, 220].map((x, at) => [x, 290 - 10 * at, PLAIN]));

  assert(sameTurns(toggled(CTRL), plain), "Ctrl pressed and let go mid-drag: the plain drag throughout");
});

Deno.test("a Ctrl + press keeps the context menu away; a plain right click keeps it", () => {
  // Background: on a Mac, Ctrl + click is the system's right click, so a press with Ctrl held fires
  // `contextmenu`, whose menu would take the pointer and end the drag before it began. Ctrl no
  // longer changes the drag (T-0296), but users who learned the T-0288 Ctrl + drag will still hold
  // it, so the canvas still keeps the menu away.
  // Setup: the fake canvas wired as the page wires it, and contextmenu events that record whether
  // their default was prevented, with and without Ctrl (and with Shift, which must not matter).
  // Test: fire each at the canvas.
  // Verifies the done-when "the context menu is still suppressed on a Ctrl+press": the canvas
  // prevents it, so no menu opens and the drag goes on; a right click without Ctrl, Shift held or
  // not, is left alone, so the browser's own menu on the canvas is unchanged. `blocksContextMenu`
  // is the rule, tested directly as well.
  const { canvas } = page();
  const menu = (ctrlKey, shiftKey = false) => {
    const event = { ctrlKey, shiftKey, prevented: false, preventDefault() { event.prevented = true; } };

    canvas.fire("contextmenu", event);
    return event.prevented;
  };

  assert(menu(true), "Ctrl + press: the context menu is prevented");
  assert(menu(true, true), "Ctrl + Shift + press: prevented too");
  assert(!menu(false), "plain right click: the menu is left alone");
  assert(!menu(false, true), "Shift + right click: the menu is left alone");
  assert(blocksContextMenu({ ctrlKey: true }) && !blocksContextMenu({ ctrlKey: false }), "the rule itself");
});

Deno.test("the sideways tilt has no slider: a drag is the only way to set it", () => {
  // Background: T-0288 added a "Sideways tilt" slider to the view card beside X and Y; the user
  // asked for it to go (2026-09-29, "get rid of the Sideways tilt slider", T-0294), keeping the
  // gesture (a plain drag since T-0296, a Ctrl + drag before). The view card draws one ParamSlider
  // per slider it names, and ParamSlider needs a FORMAT readout and a SLIDER_SPECS range for its
  // parameter, so those tables are what a slider for `sideTilt` would have to be listed in.
  // Setup: none; the page's slider tables.
  // Test: that `sideTilt` is in none of them, and that the view sliders are X and Y alone.
  // Verifies: nothing is left over from the slider -- no parameter slider, view slider, readout
  // format or range for `sideTilt` -- while spin and tilt keep theirs; the gesture itself, and
  // everything that reads the angle, is tested by the rest of this file, unchanged.
  assert(!PARAM_SLIDERS.includes("sideTilt"), "not a parameter slider");
  assertEqual(VIEW_SLIDERS, ["spin", "tilt"], "the view sliders are X and Y only");
  assert(!("sideTilt" in FORMAT) && !("sideTilt" in SLIDER_SPECS), "no readout format or range");
  assert(PARAM_SLIDERS.includes("spin") && PARAM_SLIDERS.includes("tilt"), "X and Y are still sliders");
});

Deno.test("with no slider, a drag still leaves the sideways tilt for Top to straighten", () => {
  // Setup: a fresh page (fake app and canvas), a facet turn under way from a double click, and the
  // view tipped 15 degrees sideways as a sideways drag (a plain one since T-0296) leaves it.
  // Test: applyPose({ spin: 0, tilt: 0, sideTilt: 0 }), what the Top button calls, after the turn
  // has started; then run the turn's remaining frames.
  // Verifies: taking `sideTilt` out of VIEW_SLIDERS did not change what a fixed pose does. The
  // pose lands exactly face-up and upright, and the facet turn in flight is stopped (by `spin`,
  // which applyPose always sets first), so its later frames do not drag the stone back towards
  // the facet or tip it sideways again.
  const { app, canvas } = page();

  app.params = { spin: 0, tilt: 0, sideTilt: 15 };

  for (let click = 0; click < 2; click++) {
    canvas.fire("pointerdown", pointer(400, 250));
    canvas.fire("pointerup", pointer(400, 250));
  }

  const start = performance.now();

  runFrames(start + 50);
  assert(app.params.spin > 0, `the turn has begun: spin ${app.params.spin}`);
  assert(applyPose({ spin: 0, tilt: 0, sideTilt: 0 }), "Top's pose applies");
  runFrames(start + 1000);
  assertEqual(app.params, { spin: 0, tilt: 0, sideTilt: 0 }, "face-up, upright, and the turn stopped");
  runTimers();
});

// ===========================================================================
// 2. What depends on the pose
// ===========================================================================

Deno.test("the index dial fades by how far the axis is from the view, sideways tilt included", () => {
  // Setup: y rotations (tilts) from -400 to 400 degrees, and sideways tilts of a few degrees.
  // Test: offFaceOn and dialOpacity with and without a sideways tilt.
  // Verifies:
  // - with no sideways tilt both give exactly what they gave before T-0288, to the last bit, so
  //   the dial is unchanged for every pose the page could reach before;
  // - a face-up stone tipped 7 degrees sideways is 7 degrees off face-on, like one tilted 7
  //   degrees, and the fade is half way at 7.5 and gone by 12, as the tilt's is;
  // - face-DOWN counts too: tilt 180 tipped 3 sideways is 3 off, at full strength;
  // - tilt and sideways tilt combine as the angle between the axis and the view, acos(cos t cos s)
  //   (camera.rs's `the_axis_is_acos_cos_tilt_cos_side_from_the_view`): 4 and 4 is 5.655 degrees,
  //   so each alone would show the dial at full strength but together it has started to fade;
  // - 3 and 3 (4.24 degrees) is still full strength.
  const offBefore = tilt => {
    const wound = ((tilt % 360) + 360) % 360;

    return Math.min(wound, Math.abs(wound - 180), 360 - wound);
  };

  for (let tilt = -400; tilt <= 400; tilt += 2.5) {
    assert(Object.is(offFaceOn(tilt), offBefore(tilt)), `tilt ${tilt} alone, as before`);
    assert(Object.is(offFaceOn(tilt, 0), offBefore(tilt)), `tilt ${tilt} with no sideways tilt, as before`);
    assert(Object.is(dialOpacity(tilt, 0), dialOpacity(tilt)), `the fade at tilt ${tilt}`);
  }

  assertClose(offFaceOn(0, 7), 7, 1e-12, "tipped 7 sideways is 7 off");
  assertClose(offFaceOn(0, -7), 7, 1e-12, "either way");
  assertClose(dialOpacity(0, 7.5), 0.5, 1e-12, "half faded at 7.5 sideways");
  assertEqual(dialOpacity(0, 12), 0, "gone at 12 sideways");
  assertClose(offFaceOn(180, 3), 3, 1e-9, "face-down tipped 3 is 3 off");
  assertEqual(dialOpacity(180, 3), 1, "and at full strength");

  const both = (Math.acos(Math.cos((4 * Math.PI) / 180) ** 2) * 180) / Math.PI;

  assertClose(offFaceOn(4, 4), both, 1e-9, "4 and 4 together");
  assertClose(both, 5.655, 1e-3, "which is 5.655 degrees");
  assert(dialOpacity(4, 0) === 1 && dialOpacity(0, 4) === 1, "4 alone either way: full strength");
  assert(dialOpacity(4, 4) < 1 && dialOpacity(4, 4) > 0.9, "4 and 4: the fade has begun");
  assertEqual(dialOpacity(3, 3), 1, "3 and 3: still full strength");
});

Deno.test("a saved pose carries the sideways tilt, and a fixed pose straightens it", () => {
  // Setup: a fresh page with the view at spin 33, tilt -12, tipped 9 degrees sideways.
  // Test: readPose; applyPose with a pose that leaves the sideways tilt out (as every fixed pose
  // does -- Top, Side, the modes'); applyPose with the saved pose; and scale height's side profile
  // (which resize girdle shares), through its own currentPose / showPose.
  // Verifies: the pose a mode saves on opening includes the sideways tilt, so closing puts the
  // stone back as the user had it; a pose worked out without one (face-up, the side profile)
  // really is upright, not tipped by whatever a sideways drag left behind; and the side profile the
  // modes open on says so explicitly.
  const { app } = page();

  app.params = { spin: 33, tilt: -12, sideTilt: 9 };

  const saved = readPose();

  assertEqual(saved, { spin: 33, tilt: -12, sideTilt: 9 }, "the whole pose is read");
  assert(applyPose({ spin: 0, tilt: 0 }), "a fixed pose applies");
  assertEqual(app.params, { spin: 0, tilt: 0, sideTilt: 0 }, "face-up and upright");
  assert(applyPose(saved), "the saved pose applies");
  assertEqual(app.params, { spin: 33, tilt: -12, sideTilt: 9 }, "back as it was, tipped");

  assertEqual(SIDE_PROFILE, { spin: 0, tilt: 90, sideTilt: 0 }, "the side profile is upright");

  const opened = currentPose();

  showPose(SIDE_PROFILE);
  assertEqual(app.params, { spin: 0, tilt: 90, sideTilt: 0 }, "scale height opens side-on, upright");
  showPose(opened);
  assertEqual(app.params, { spin: 33, tilt: -12, sideTilt: 9 }, "and closes back where the user was");
  runTimers();
});

Deno.test("a double click turning the stone to face a facet also brings it back upright", () => {
  // Setup: a fresh page with no design (a plain .obj, where a double click turns the stone -- with
  // a design it opens edit mode instead and leaves the stone alone), the view at spin 0, tilt 0,
  // tipped 20 degrees sideways; the fake app says the facet under the pointer is faced from spin 30,
  // tilt 40 (`facet_pose_at`, whose pose is for a stone with no sideways tilt).
  // Test: two clicks at the same point, then run the turn's animation frames, first half way and
  // then past its 200 ms.
  // Verifies: the turn animates the sideways tilt with spin and tilt -- part way at half way -- and
  // ends at exactly 0 alongside spin 30, tilt 40, so the stone really faces the facet (Rust's
  // `facet_pose_at_faces_the_facet_under_the_pointer` checks that pose with the tilt set back to 0).
  const { app, canvas } = page();

  app.params = { spin: 0, tilt: 0, sideTilt: 20 };

  for (let click = 0; click < 2; click++) {
    canvas.fire("pointerdown", pointer(400, 250));
    canvas.fire("pointerup", pointer(400, 250));
  }

  assertEqual(app.highlighted, [4], "the facet under the pointer is lit");

  const start = performance.now();

  runFrames(start + 100);
  assert(app.params.sideTilt > 0 && app.params.sideTilt < 20, `half way, part way upright: ${app.params.sideTilt}`);

  runFrames(start + 1000);
  assertEqual(app.params, { spin: 30, tilt: 40, sideTilt: 0 }, "facing the facet, upright");
  runTimers();
});
