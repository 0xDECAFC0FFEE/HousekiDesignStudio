// Tools > Tilt performance (T-0261). The user (2026-09-25):
//
//   "the purpose of the tool is to send light at the rock from multiple directions and multiple
//   light sources to check how much light reflects back at the user to check brilliance. the head
//   shadow is based on the head shadow set in the render settings. windowing is the amount of light
//   that windows ... ISO brightness is how bright the rock under the iso skybox and same thing
//   with cosine. the rock tilts x by 30 deg, recording the amount of light that is sent back
//   through each method, then returns the rock to face up and tilts y by 30 deg ... make sure the
//   rendering isn't a function of the actual user's screen size and is fixed"
//
// and then: "the tilt performance goes 33 degrees vertical, then 33 degrees horizontal".
//
// A window onto the design, like the cutting assistant (kb/application-modes-current-and-planned.md),
// but laid out differently (the user, later the same day: "tilt performance mode should leave the
// render details on the right side of the screen but the faceting instructions on the left side
// of the screen should have tilt performance mode"): the LEFT pane swaps the cutting instructions
// for the tool's panel (TiltPerformancePanel.svelte, stacked by Workspace.svelte), and the render
// settings stay where they are and stay live. The design is held (`setDesignLock`) so the graph
// cannot go stale under an edit, Undo and Redo are inert, and Done or Escape close it and put the
// view's pose back. Nothing in the design changes, so there is no Cancel.
//
// The measuring is the renderer's (`GemApp::tilt_begin` / `tilt_poll`, src/renderer/tilt.rs):
// each pose is drawn off screen at a fixed 200 x 167, many poses at a time as tiles of one image,
// and read back without the page waiting for the GPU. This module hands the sweep to it in
// batches and collects them as they finish.
//
// The view holds still while the sweep measures. It used to turn to each pose as it was measured
// (Gem Cut Studio's animated preview), but every turn was a full render of the page's canvas
// competing with the measurement for the GPU, and the user found it "very slow to do the graph
// then, the main gem in the center renders the updated direction, then the graph updates"
// (2026-09-25). Opening turns the view face-up once; after that only the pointer moves it.
//
// Three things keep the graph in step with the page around it:
//
//   - **The reach of each half** (`setTiltRange`, the panel's slider; "a slider for the start and
//     end angles"). Every pose measured is kept, one per degree, so widening the reach measures
//     only the new degrees and narrowing it measures nothing.
//   - **The render settings it is measured with** (tilt_performance.js's MEASURED_PARAMS: the
//     head shadow angle above all -- "updating the headshadow angle on the render settings should
//     regenerate the tilt performance graph"). A change to any of them, from a slider, a material
//     preset or an undo, throws every pose away and measures again, once the change has rested
//     for a moment so a slider's drag is one re-measure rather than one per step.
//   - **The pointer** ("mousing over the tilt performance graph should rotate the stone to that
//     angle"): over the graph, it turns the view to the pose under it -- only once the sweep has
//     measured every pose (the user, 2026-09-25: "only enable mousing over the graph once all
//     the graph is generated"). While any sweep runs, first or a re-measure (a new setting, a
//     wider range), the pointer is ignored and the view stays where it is.

import { writable, get } from 'svelte/store';
import { editing } from './edit_mode.js';
import { getDesign, tierView, setDesignLock, designLocked, syncToolbar } from './tier_controller.js';
import { setLocalHistory, applyParam, selectRenderer, onParamApplied } from './session.js';
import { engine, bumpParams, showError, paramRevision } from './stores.js';
import { setRenderHold, releaseRenderHold } from './viewport.js';
import {
  DEFAULT_RANGE, sweepPoses, readMeasurement, viewPose, clampRange, measurementKey,
} from './tilt_performance.js';

// Each half's reach. Kept from one opening to the next while the page is open, as a slider's
// setting is; a reload starts again at Gem Cut Studio's 33 degrees.
let range = { ...DEFAULT_RANGE };

/**
 * What the panel draws: `{ open, samples: { x, y }, range, measured, total, headShadow, cursor }`.
 * `samples.x` and `samples.y` are `[{ angle, measurement }]`, every pose measured so far on each
 * half (a measurement is tilt_performance.js's `readMeasurement`), including any beyond the
 * reach, which the graph leaves out; `range` is each half's reach, `{ x, y }` in degrees;
 * `measured` of the `total` poses within reach are done; `headShadow` is the head shadow half
 * angle, in degrees, the samples were measured with (the curve's label names it, as Gem Cut
 * Studio's does); `cursor` is the pose the view shows, `{ axis, angle }`, or null.
 */
export const tiltPerformance = writable(closedState());

function closedState() {
  return {
    open: false, samples: { x: [], y: [] }, range: { ...range }, measured: 0, total: 0,
    headShadow: 0, cursor: null,
  };
}

/** `params::Renderer::as_u32` for the two renderers the mode cares about. */
const RENDERER_DETERMINISTIC = 0;
const RENDERER_MONTE_CARLO = 1;

/**
 * How long a change to a measured setting must rest before the graph is measured again, in
 * milliseconds: long enough that dragging the head shadow slider re-measures once, at the end,
 * short enough to feel like a response to letting go.
 */
const REMEASURE_DELAY_MS = 350;

// The open session, or null:
//   design     the design the mode opened on (a new one loaded under it ends it)
//   pose       the view's spin and tilt before, put back on closing
//   swapped    whether Monte Carlo was swapped for Deterministic on opening
//   measured   Map of 'x:12' -> measurement, every pose measured with the current settings
//   key        tilt_performance.js's measurementKey of the settings they were measured with
//   inFlight   the batches of poses queued on the renderer, oldest first (they finish in that
//              order)
//   timer      the next poll; remeasureTimer, a pending re-measure
//   stop       what undoes the settings listeners
let session = null;

/** True while the mode is open. */
export function tiltPerformanceOpen() {
  return session !== null;
}

// The whole design is held while the graph is up, and the toolbar says why.
setDesignLock(() => session !== null, ' Close tilt performance first: Done, or Escape.');

// The view is not drawn while the sweep measures: a frame of it takes the GPU for longer than the
// whole sweep does, and held off it the sweep takes about a second instead of six (2026-09-26).
// It is drawn the moment the sweep is done (`releaseRenderHold` in `poll`), turned face-up if the
// mode has just opened.
setRenderHold(() => sweeping());

/** Undo and Redo while open: nothing to step -- the mode changes nothing. */
const INERT_HISTORY = {
  canUndo: () => false,
  canRedo: () => false,
  undo: () => {},
  redo: () => {},
};

const poseKey = ({ axis, angle }) => `${axis}:${angle}`;
const readParam = name => engine.app.get_param(name);

/**
 * Opens the mode and starts the sweep. Works for any stone, a plain .obj as well as a design.
 * Does nothing, and returns false, with no renderer, while another mode is open, or while this one
 * already is.
 */
export function enterTiltPerformance() {
  const app = engine.app;

  if (session !== null || get(editing) !== null || designLocked() || !app) {
    return false;
  }

  session = {
    design: getDesign(),
    pose: { spin: app.get_param('spin'), tilt: app.get_param('tilt') },
    // Monte Carlo is swapped for Deterministic while the tool is open, as the cutting assistant
    // does: the view turns to a new pose every second or so, and a path tracer restarting at each
    // would only fight the measurement for the GPU and never converge. The measurement itself is
    // always deterministic. The render settings stay on screen, so the user may pick Monte Carlo
    // again; that choice is then theirs, and is kept on closing.
    swapped: app.renderer() === RENDERER_MONTE_CARLO,
    measured: new Map(),
    key: measurementKey(readParam),
    inFlight: [],
    timer: null,
    remeasureTimer: null,
    stop: null,
  };

  if (session.swapped) {
    selectRenderer(RENDERER_DETERMINISTIC, { remember: false });
  }

  // A setting moved with a slider comes through applyParam; a material preset, an undo of one
  // and a restored link through a bump of paramRevision. Either may change what is measured.
  const stopApplied = onParamApplied(settingsChanged);
  const stopRevision = paramRevision.subscribe(settingsChanged);

  session.stop = () => {
    stopApplied();
    stopRevision();
  };

  setLocalHistory(INERT_HISTORY);
  tiltPerformance.set({ ...closedState(), open: true, headShadow: app.get_param('headShadowHalfAngle') });
  publish();
  syncToolbar();
  // Face-up once, the middle of the graph; the view then holds still until the sweep is done.
  showPose({ axis: 'x', angle: 0 });
  measureNext();
  return true;
}

/** Done, and Escape: stops any measuring and puts the view's pose back. */
export function exitTiltPerformance() {
  if (session === null) {
    return;
  }

  const { pose } = session;

  close();
  applyParam('spin', pose.spin);
  applyParam('tilt', pose.tilt);
  bumpParams();
  window.gemRequestRender?.();
}

function close() {
  const { swapped } = session;

  clearTimeout(session.timer);
  clearTimeout(session.remeasureTimer);
  session.stop?.();
  engine.app?.tilt_cancel();
  session = null;
  releaseRenderHold();

  // Monte Carlo back, unless the user picked a renderer of their own while the tool was open.
  if (swapped && engine.app && engine.app.renderer() === RENDERER_DETERMINISTIC) {
    selectRenderer(RENDERER_MONTE_CARLO, { remember: false });
  }

  setLocalHistory(null);
  tiltPerformance.set(closedState());
  tiltProgress.set({ measured: 0, total: 0 });
  syncToolbar();
}

/**
 * Sets how far each half of the sweep reaches, `{ x, y }` in degrees (either may be left out),
 * clamped to TILT_RANGE_MIN..TILT_RANGE_MAX. Poses already measured are kept; the sweep goes on
 * to measure whichever new ones the wider reach needs.
 */
export function setTiltRange(next) {
  const x = clampRange(next.x ?? range.x);
  const y = clampRange(next.y ?? range.y);

  // Nothing to do for the reach it already has: a slider reports its value on more than a drag.
  if (x === range.x && y === range.y) {
    return;
  }

  range = { x, y };

  if (session === null) {
    tiltPerformance.update(state => ({ ...state, range: { ...range } }));
    return;
  }

  publish();
  measureNext();
}

/** How many of the poses within reach are measured, into `tiltProgress`. */
function progress() {
  const poses = sweepPoses(range);

  tiltProgress.set({
    measured: poses.filter(pose => session.measured.has(poseKey(pose))).length,
    total: poses.length,
  });
}

/** Every pose measured, and how far through the reach the sweep is, into the store. */
function publish() {
  const samples = { x: [], y: [] };

  for (const [key, measurement] of session.measured) {
    const [axis, angle] = key.split(':');

    samples[axis].push({ angle: Number(angle), measurement });
  }

  const poses = sweepPoses(range);

  progress();
  tiltPerformance.update(state => ({
    ...state,
    samples,
    range: { ...range },
    measured: poses.filter(pose => session.measured.has(poseKey(pose))).length,
    total: poses.length,
  }));
}

// How often the batches in flight are asked whether they are done: as often as a timer runs.
// Asking is cheap (a fence test), and waiting a whole frame between asks left the GPU idle.
const POLL_MS = 4;

/**
 * How far the sweep is while it runs, `{ measured, total }`: the panel's progress bar. Kept apart
 * from `tiltPerformance` so a batch finishing moves the bar without redrawing the graph and every
 * other part of the page that reads the mode's state; that redraw cost the page more than
 * measuring did (2026-09-26). The graph itself is drawn once the sweep is done (`publish`).
 */
export const tiltProgress = writable({ measured: 0, total: 0 });

/**
 * Queues the next poses within reach not yet measured, in batches (`tilt_batch_size` poses, drawn
 * together as one image by the renderer), as many batches as it will take at once
 * (`tilt_can_begin`), so the GPU always has the next batch to draw; finishes the sweep when there
 * are none left and none in flight.
 */
function measureNext() {
  if (session === null) {
    return;
  }

  const queued = new Set(session.inFlight.flat().map(poseKey));
  const waiting = sweepPoses(range)
    .filter(pose => !session.measured.has(poseKey(pose)) && !queued.has(poseKey(pose)));
  const size = engine.app.tilt_batch_size();

  while (waiting.length > 0 && engine.app.tilt_can_begin()) {
    const batch = waiting.splice(0, size);

    try {
      engine.app.tilt_begin(new Float32Array(batch.flatMap(({ spin, tilt }) => [spin, tilt])));
    } catch (cause) {
      stopMeasuring();
      showError(`Tilt performance could not measure the stone: ${cause}`);
      return;
    }

    session.inFlight.push(batch);
  }

  // Nothing queued: the sweep is done, and the pointer may turn the view from here on.
  if (session.inFlight.length > 0) {
    clearTimeout(session.timer);
    session.timer = setTimeout(poll, POLL_MS);
  }
}

/** Collects every queued batch that is measured, oldest first, files its poses, and queues more. */
function poll() {
  if (session === null || session.inFlight.length === 0) {
    return;
  }

  try {
    while (session.inFlight.length > 0 && engine.app.tilt_poll()) {
      const batch = session.inFlight.shift();
      const values = Array.from(engine.app.tilt_result());

      batch.forEach((pose, i) => {
        session.measured.set(poseKey(pose), readMeasurement(values.slice(i * 10, i * 10 + 10)));
      });
    }
  } catch (cause) {
    stopMeasuring();
    showError(`Tilt performance could not measure the stone: ${cause}`);
    return;
  }

  measureNext();

  if (sweeping()) {
    progress();
  } else {
    publish();
  }

  // Done: the view may be drawn again, and whatever was asked of it meanwhile is.
  if (!sweeping()) {
    releaseRenderHold();
  }
}

/** Abandons every pose queued. */
function stopMeasuring() {
  clearTimeout(session.timer);
  engine.app.tilt_cancel();
  session.inFlight = [];
}

/**
 * A render setting may have changed: if one the graph is measured with did, measure it all again
 * once the change has rested (REMEASURE_DELAY_MS).
 */
function settingsChanged() {
  if (session === null || measurementKey(readParam) === session.key) {
    return;
  }

  clearTimeout(session.remeasureTimer);
  session.remeasureTimer = setTimeout(remeasure, REMEASURE_DELAY_MS);
}

/** Throws every pose away and measures the sweep again with the render settings as they are now. */
function remeasure() {
  if (session === null) {
    return;
  }

  const key = measurementKey(readParam);

  if (key === session.key) {
    return;
  }

  stopMeasuring();
  session.key = key;
  session.measured.clear();
  tiltPerformance.update(state => ({ ...state, headShadow: engine.app.get_param('headShadowHalfAngle') }));
  publish();
  measureNext();
}

/**
 * The pointer over the graph, at a pose `{ axis, angle }`: the view turns to it. Ignored while
 * the sweep is still measuring, so the page's own renders leave the GPU to the measurement.
 */
export function pointAtPose(cursor) {
  if (session === null || sweeping()) {
    return;
  }

  showPose(cursor);
}

/**
 * Turns the view to a pose of the graph, `{ axis, angle }`, and marks it on the graph: opening
 * does this for face-up, and the pointer for the pose under it.
 */
export function showPose(cursor) {
  if (session === null) {
    return;
  }

  const { spin, tilt } = viewPose(cursor);

  applyParam('spin', spin);
  applyParam('tilt', tilt);
  bumpParams();
  tiltPerformance.update(state => ({ ...state, cursor }));
  window.gemRequestRender?.();
}

/** Whether the sweep is still measuring. */
export function sweeping() {
  return session !== null && session.inFlight.length > 0;
}

// Another design loaded under the mode (File > Open, a shared link) ends it: the graph is of the
// stone that was there. The view is left where the new design put it.
tierView.subscribe(() => {
  if (session !== null && getDesign() !== session.design) {
    close();
  }
});
