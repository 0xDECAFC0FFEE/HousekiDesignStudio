// Edit > Manual optimizer (T-0273). The user (2026-09-28): "its purpose is to vary the
// crown/pavilion height by configurable amounts and to render previews of the gemstone at each
// crown/pavilion height to inspect how it'll look ... its right panel should be the manual
// optimizer settings ... the middle should be a preview of the rendering ... the left panel should
// have a matrix with subdivisions * subdivisions cells, each one with a preview."
//
// A whole-design mode on scale height's pattern (scale_height_mode.js), whose math it uses:
//   * the right-hand column swaps the render settings for its own panel
//     (ManualOptimizerPanel.svelte), and the LEFT pane swaps the cutting instructions for the grid
//     (ManualOptimizerGrid.svelte, stacked by Workspace.svelte as tilt performance's panel is);
//   * the stone in the middle is the design itself, at the ratios the user last picked
//     (`state.preview`), written through `setTierValues` exactly as scale height's gauges write it;
//   * Done keeps the preview's heights as ONE entry in the edit history, recorded inside a history
//     frame opened when the mode opens; Cancel and Escape put every tier back as it was;
//   * while open, Undo and Redo step the mode's own stack of states (`setLocalHistory`): every
//     click, rectangle and slider release is one step, as is a run of arrow keys on the grid
//     (`stepGridCell`, T-0285), and every stone is computed afresh from the
//     design as it stood when the mode opened (`pristine`), so the state IS the design;
//   * the whole design is held (`setDesignLock`), and it refuses to open while another mode is open.
//
// The grid is drawn by the renderer's preview stones (src/renderer/thumbnails.rs): each cell's
// stone is built from the design at that cell's ratios, loaded under an id of its own without
// touching the stone on screen, and drawn off screen with the deterministic renderer and the page's
// own render settings (a Monte Carlo cell would be noise, or seconds each); since T-0281 the middle
// is switched to the same renderer while the mode is open (below). Building a stone is the costly part (up to a couple of seconds on a large design,
// T-0194), so:
//   * cells are filled one at a time, the middle first and outwards, each in its own budgeted task
//     (work_budget.js), so the page stays responsive and the grid appears progressively;
//   * a stone's OBJ text is kept by its ratios for the whole session, and its GPU copy for as long
//     as the grid's frame is the same, so changing the subdivisions reuses both;
//   * every preview is drawn FACE UP, whatever the view in the middle shows, and turning the view
//     redraws nothing (the user, 2026-09-28: "don't rotate the previews when the main render is
//     rotated - just only show the rocks face up and don't refresh on rotation"; until then the
//     grid followed the middle stone's pose). Changing a render setting only redraws the stones,
//     which is cheap, once the change has rested for a moment.
//
// Under the grid is the tilt performance graph of the stone in the middle (T-0274, `optimizerTilt`),
// measured with Tools > Tilt performance's own loop (tilt_sweep.js) once the heights have rested;
// a newer change cancels a sweep it makes stale, and a stone measured before comes from a cache.
//
// The stone in the middle is drawn with the Deterministic renderer while the mode is open, like the
// grid (T-0281; the user, 2026-09-28: "automatically change the renderer to deterministic in manual
// optimizer mode"), so the middle and the cells look alike. Opening switches to it from Monte Carlo
// or Flat, and closing -- Done, Cancel, Escape, or another design loaded -- puts back the renderer the
// user had. The switch is the cutting assistant's (`selectRenderer(..., { remember: false })`): it
// is a view setting, so it is no step of any undo, and it is not saved as the user's choice, so a
// reload with the mode open still starts in the renderer the user picked. The render settings' own
// renderer picker, hidden behind this mode's panel, follows the `renderer` store and so reads
// Deterministic meanwhile.

import { writable, get } from 'svelte/store';
import { editing } from './edit_mode.js';
import {
  getDesign, tierView, beginHistoryFrame, commitHistoryFrame, cancelHistoryFrame, recordEditEntry,
  setTierValues, setDesignLock, syncToolbar, designLocked,
} from './tier_controller.js';
import { setLocalHistory, syncUndoMenu, selectRenderer } from './session.js';
import { engine, bumpParams, showError } from './stores.js';
import { onRenderRequest, setRenderHold, releaseRenderHold } from './viewport.js';
import { DEFAULT_RANGE, sweepPoses, measurementKey } from './tilt_performance.js';
import { createTiltSweep, poseKey } from './tilt_sweep.js';
import { rockShape } from './edit_geometry.js';
import { budgetedTask } from './work_budget.js';
import { createGaugeHistory, heightPivots, scaledValues } from './scale_height.js';
import {
  initialState, sameState, gridCells, fillOrder, withSubdivisions, withRange, clickCell,
  selectRectangle, gridFrame, builtCorners, previewCell,
} from './manual_optimizer.js';

/** Added to every tier toolbar button's tooltip while this mode holds the design. */
const FINISH_OPTIMIZING_TIP = ' Finish the manual optimizer first: Done, or Cancel.';

/** `params::Renderer::as_u32` of the renderer the mode draws the middle with: Deterministic. */
export const RENDERER_DETERMINISTIC = 0;

/**
 * What the panel and the grid draw: `{ open, state, cells, selected, filled, total }`. `state` is
 * manual_optimizer.js's (subdivisions, ranges, centre, preview); `cells` its `gridCells`; `selected`
 * the index of the cell the middle shows, or -1; `filled` of the `total` cells are drawn for the
 * view as it is now.
 */
export const manualOptimizer = writable(closedStore());

/**
 * The cells' pictures, by cell index: `{ pixels, width, height, stale }` (RGBA, top row first) or
 * null for none yet, `failed: true` for a stone that could not be built. `stale` marks a picture of
 * the right stone from before the view or the settings last changed, shown until it is redrawn.
 * Kept apart from `manualOptimizer` so a cell finishing redraws only the cells.
 */
export const optimizerImages = writable([]);

function closedStore() {
  return { open: false, state: initialState(), cells: [], selected: -1, filled: 0, total: 0 };
}

/**
 * The tilt performance graph under the grid (T-0274; the user, 2026-09-28: "under the grid can you
 * show the face up rocks tilt performance"): the stone in the middle -- the heights last picked --
 * measured exactly as Tools > Tilt performance measures a stone (tilt_sweep.js, the same loop),
 * over Gem Cut Studio's default sweep, 33 degrees each way (`DEFAULT_RANGE`).
 *
 *   status      'closed'; 'waiting', the heights or a measured setting just changed and the graph
 *               is measured once they have rested; 'measuring'; 'done'; or 'failed'
 *   samples     `{ x, y }` as tilt_performance_mode.js's: the graph's samples. While waiting and
 *               measuring these are the previous stone's, shown faded until the new ones are in.
 *   range       each half's reach, `DEFAULT_RANGE`
 *   headShadow  the head shadow half angle the samples were measured with, in degrees
 *   ratios      `{ crown, pavilion }`: the heights the samples are of, or null before the first
 */
export const optimizerTilt = writable(closedTilt());

/** How far the sweep in progress is, `{ measured, total }`: kept apart so a batch moves only the bar. */
export const optimizerTiltProgress = writable({ measured: 0, total: 0 });

function closedTilt() {
  return {
    status: 'closed', samples: { x: [], y: [] }, range: { ...DEFAULT_RANGE }, headShadow: 0, ratios: null,
  };
}

/**
 * How long the heights (or a measured setting) must rest before the stone in the middle is
 * measured, in ms. A sweep takes one to two seconds; clicking along a row, each click would
 * otherwise start one only to throw it away at the next.
 */
export const TILT_SETTLE_MS = 400;
/** How many measured graphs are kept, by stone and settings, for going back to one (undo, a click back). */
const TILT_CACHE_LIMIT = 64;

/** How long a change of view or render setting must rest before the grid is redrawn, in ms. */
const REDRAW_DELAY_MS = 250;
/**
 * The share of the wall clock the grid's work may take (work_budget.js); the rest is the page's.
 * 0.5 until T-0274, when each run still built, loaded AND drew a stone and waited for the GPU as
 * part of its cost, so every cell cost twice what it did. A run is now one stage of one cell (a few
 * tens of ms at most once warm), so the page gets a turn between every two of them however high
 * this is.
 */
const GRID_BUDGET = 0.85;
/**
 * How many stones are built and loaded ahead of the one being drawn: while a picture is on the GPU
 * (a fixed 25-35 ms per draw, whatever its size, measured 2026-09-28), the next stones are prepared
 * on the page's thread instead of it waiting.
 */
const LOOKAHEAD = 2;
/**
 * How often, at most, finished pictures are handed to the grid, in ms. Each hand-over redraws the
 * grid's markup; once per picture that was a large part of the fill (T-0274's profile: 2.4 s of
 * Svelte updates in a 16 s fill).
 */
const PUBLISH_MS = 100;
/** How many OBJ texts of stones are kept, for going back to an earlier grid. */
const TEXT_CACHE_LIMIT = 400;
/** How many pictures are kept, for the same. */
const IMAGE_CACHE_LIMIT = 200;
/**
 * The render settings a cell's picture depends on, besides the colours and the lighting model.
 * Not the view's `spin` and `tilt`: every preview is face up (`FACE_UP`), so turning the view
 * changes no picture and must not redraw the grid.
 */
export const DRAWN_PARAMS = [
  'refractiveIndex', 'dispersion', 'maxBounces', 'headShadowHalfAngle', 'absorptionScale',
  'exposure', 'envIntensity', 'envRotation', 'exhaustionShade', 'observerRadius',
];
/** The pose every preview is drawn from: face up, spin 0 and tilt 0 in degrees, as tilt performance's middle. */
export const FACE_UP = Object.freeze({ spin: 0, tilt: 0 });

// The open session, or null:
//   design, pristine, pivots   as scale height's: the design, every tier as it stood when the mode
//                              opened, and the planes each half is stretched about
//   renderer                   the renderer the user had when the mode opened, put back on closing
//                              (null with no GemApp)
//   corners                    the opened stone's corners, for the grid's frame
//   history                    the mode's own undo stack of states
//   step                       the arrow keys' steps (`stepGridCell`): `pending`, the cell to show
//                              at the next frame or null; `scheduled`, whether that frame is asked
//                              for; `running`, whether the top of `history` is a run of arrow steps
//                              the next one carries on
//   texts                      Map of ratios key -> OBJ text (null: the stone does not build)
//   stones                     Map of ratios key -> the id its GPU copy is loaded under
//   frame, frameKey            the frame every cell is drawn in (`gridFrame`), and a key of it
//   images                     Map of draw key -> picture; latest: Map of ratios key -> picture
//   inFlight                   the cell being drawn, `{ index, draw, key, size }`, or null
//   publishTimer               the wait before pictures that came in are shown (PUBLISH_MS)
//   viewKey                    the render settings the pictures are drawn for
//   size                       the side of a picture, in pixels
//   tilt                       the graph under the grid: `sweep` (tilt_sweep.js), `key` (the
//                              stone and settings being or last measured, `tiltKey`), `measured`
//                              (Map of pose key -> measurement, this sweep's), `cache` (Map of key
//                              -> a finished graph), `timer` (the settle wait)
let session = null;

setDesignLock(() => session !== null, FINISH_OPTIMIZING_TIP);

// The view in the middle is not drawn while the stone in it is measured: the measurement shares the
// GPU with it, and above all with a Monte Carlo view's passes (tilt performance's own finding,
// 2026-09-26: 1 s held, 6 s not). It is drawn the moment the sweep is done.
setRenderHold(() => tiltMeasuring());

/** Whether the graph under the grid is being measured. */
export function tiltMeasuring() {
  return session !== null && session.tilt.sweep.busy();
}

/** True while the mode is open. */
export function manualOptimizerOpen() {
  return session !== null;
}

/** The local stack as session.js's Undo and Redo see it while the mode is open. */
const localStack = {
  canUndo: () => session?.history.canUndo() ?? false,
  canRedo: () => session?.history.canRedo() ?? false,
  undo: () => stepHistory('undo'),
  redo: () => stepHistory('redo'),
};

/**
 * Opens the mode on the loaded design: the grid at its defaults round the design as it stands,
 * which is also what the middle shows. Does nothing, and returns false, with no design loaded,
 * while edit mode or another whole-design mode is open, or while this one already is.
 */
export function enterManualOptimizer() {
  const design = getDesign();

  if (session !== null || designLocked() || get(editing) !== null || !design) {
    return false;
  }

  // Measured once, on the stone as it stands (scale height does the same): the planes each half is
  // stretched about, and the box the grid's frame is worked out from.
  let pivots = { crown: 0, pavilion: 0, overlap: false };
  let corners = null;

  try {
    const built = rockShape(design);

    pivots = heightPivots(design, built);
    corners = builtCorners(built);
  } catch (cause) {
    // A design that does not build has nothing to preview; its cells will say so.
  }

  const state = initialState();

  beginHistoryFrame();
  session = {
    design,
    pristine: design.tiers.map(tier => ({ tier, angle: tier.angle, distance: tier.distance })),
    pivots,
    corners,
    renderer: engine.app ? engine.app.renderer() : null,
    history: createGaugeHistory(state, sameState),
    texts: new Map(),
    stones: new Map(),
    nextId: 1,
    frame: null,
    frameKey: '',
    images: new Map(),
    latest: new Map(),
    inFlight: null,
    viewKey: viewKey(),
    size: 96,
    redrawTimer: null,
    publishTimer: null,
    stop: null,
    tilt: { sweep: null, key: '', measured: new Map(), cache: new Map(), timer: null, pending: false },
    step: { pending: null, scheduled: false, running: false },
  };
  session.tilt.sweep = createTiltSweep({
    app: () => engine.app,
    onMeasured: (pose, measurement) => session?.tilt.measured.set(poseKey(pose), measurement),
    onProgress: tiltSwept,
    onError: tiltFailed,
  });
  session.stop = onRenderRequest(renderRequested);

  // The middle drawn as the grid is (see the header): not remembered, not an undo step.
  if (session.renderer !== null && session.renderer !== RENDERER_DETERMINISTIC) {
    selectRenderer(RENDERER_DETERMINISTIC, { remember: false });
  }

  setLocalHistory(localStack);
  syncToolbar();
  publish(state);
  return true;
}

/** Done: keeps the heights the middle shows, as ONE entry in the edit history, and closes. */
export function exitManualOptimizer() {
  if (session === null) {
    return;
  }

  // An arrow step not yet shown is the user's last choice: kept too.
  flushGridStep();

  // The design already holds the preview's values (`writePreview`); these are the changes.
  const ops = [];

  for (const { tier, angle, distance } of session.pristine) {
    if (tier.angle !== angle) {
      ops.push({ kind: 'update', target: 'tierValue', tier, field: 'angle', before: angle, after: tier.angle });
    }

    if (tier.distance !== distance) {
      ops.push({
        kind: 'update', target: 'tierValue', tier, field: 'distance', before: distance, after: tier.distance,
      });
    }
  }

  recordEditEntry({ label: 'Manual optimizer', ops });
  commitHistoryFrame('Manual optimizer');
  close();
}

/** Cancel, and Escape: closes the mode and puts every tier back as it was, recording nothing. */
export function cancelManualOptimizer() {
  if (session === null) {
    return;
  }

  const { pristine } = session;

  close();
  // Nothing was recorded in the frame (the mode keeps its own stack), so this only closes it.
  cancelHistoryFrame();
  // Forced, so the stone on screen is rebuilt from the design as it was even if it already is.
  setTierValues(pristine, { force: true });
}

function close() {
  const rendererBefore = session.renderer;

  worker.cancel();
  clearTimeout(session.redrawTimer);
  clearTimeout(session.publishTimer);
  clearTimeout(session.tilt.timer);
  session.tilt.sweep.cancel();
  session.stop?.();
  engine.app?.thumbnail_clear();
  session = null;
  // The view was held only while the graph measured; whatever was asked of it meanwhile is drawn.
  releaseRenderHold();

  // The renderer the user had comes back, again without saving it: it already is their saved one.
  if (engine.app && rendererBefore !== null && engine.app.renderer() !== rendererBefore) {
    selectRenderer(rendererBefore, { remember: false });
  }

  setLocalHistory(null);
  manualOptimizer.set(closedStore());
  optimizerImages.set([]);
  optimizerTilt.set(closedTilt());
  optimizerTiltProgress.set({ measured: 0, total: 0 });
  syncToolbar();
  // The render settings panel comes back: its controls read Rust again, since the lighting may
  // have been changed from this mode's copy of them.
  bumpParams();
  window.gemRequestRender?.();
}

// ---- the user's changes: each one step of the mode's own undo

/** The subdivisions slider (snapped to an odd 3 to 11). */
export function setSubdivisions(subdivisions) {
  commit(state => withSubdivisions(state, subdivisions));
}

/** A range slider's release, or a typed range: `which` 'crown' or 'pavilion', in percent. */
export function setRange(which, percent) {
  commit(state => withRange(state, which, percent));
}

/** A click on a cell: the middle shows that cell's heights; the grid stays. */
export function previewGridCell(row, column) {
  commit(state => clickCell(state, row, column));
}

/**
 * An arrow key on the grid (T-0285; the user, 2026-09-28: "once users click on the manual
 * optimizer table, arrow keys should move you around the table and update the central render"):
 * the middle shows cell (`row`, `column`), exactly as a click on it does, with two differences.
 *
 *   - It is applied at the next frame, not at once, and only the LAST cell asked for by then is.
 *     Showing a cell rebuilds the stone in the middle from the design, which takes longer than the
 *     keyboard's repeat; an arrow held down would otherwise queue one rebuild per repeat and the
 *     page would go on rebuilding stones long after the key was let go. This way it rebuilds at
 *     most once a frame, and ends on the cell the cursor stopped on. The graph under the grid waits
 *     for the heights to rest as it does for clicks, so a held arrow measures only the last cell.
 *   - A run of arrow steps is ONE step of the mode's undo, not one per cell: the arrows are a way
 *     of looking along the grid, as dragging a slider is, and Undo after them goes back to the cell
 *     the run started from. The run ends at anything else that is a step (a click, a rectangle, a
 *     slider, a typed value) and at Undo or Redo. A run that comes back to where it started is no
 *     step at all.
 */
export function stepGridCell(row, column) {
  if (session === null) {
    return;
  }

  session.step.pending = { row, column };

  if (!session.step.scheduled) {
    session.step.scheduled = true;
    nextFrame(flushGridStep);
  }
}

/** Runs `fn` before the next frame is drawn (a timer where there are no frames: the tests). */
function nextFrame(fn) {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(() => fn());
  } else {
    setTimeout(fn, 0);
  }
}

/**
 * Shows the cell the arrow keys last asked for (`stepGridCell`), if one is waiting. Called at the
 * next frame, and before anything else changes the mode's state, so the steps keep their order.
 */
export function flushGridStep() {
  if (session === null) {
    return;
  }

  const step = session.step;

  step.scheduled = false;

  if (step.pending === null) {
    return;
  }

  const { row, column } = step.pending;
  const next = clickCell(get(manualOptimizer).state, row, column);
  let changed = false;

  step.pending = null;

  if (step.running) {
    const result = session.history.amend(next);

    changed = result !== null;
    // Back on the cell the run started from: the run is nothing, and the next arrow starts anew.
    step.running = result === 'amended';
  } else {
    changed = session.history.commit(next);
    step.running = changed;
  }

  if (changed) {
    syncUndoMenu();
    publish(next);
  }
}

/** A rectangle dragged over the grid, from one cell to another: re-centres the grid on it. */
export function selectGridRectangle(from, to) {
  commit(state => selectRectangle(state, from, to));
}

/** Applies `change` to the state, as one step of the mode's own undo. */
function commit(change) {
  if (session === null) {
    return;
  }

  // An arrow step still waiting came first; and a run of them ends here.
  flushGridStep();
  session.step.running = false;

  const next = change(get(manualOptimizer).state);

  if (session.history.commit(next)) {
    syncUndoMenu();
    publish(next);
  }
}

/** Undo or redo inside the mode: an arrow step waiting is applied first, and ends its run. */
function stepHistory(which) {
  if (session === null) {
    return;
  }

  flushGridStep();
  session.step.running = false;
  showState(session.history[which]());
}

/** Undo or redo inside the mode handed back `state` (null: nothing to step to). */
function showState(state) {
  if (session === null || state === null) {
    return;
  }

  publish(state);
  syncUndoMenu();
}

/**
 * Shows `state`: the stone in the middle at its preview heights, and the grid round its centre,
 * filled with whatever pictures are already drawn and the rest queued.
 */
function publish(state) {
  const previous = get(manualOptimizer).state;

  if (!get(manualOptimizer).open || previous.preview.crown !== state.preview.crown ||
    previous.preview.pavilion !== state.preview.pavilion) {
    writePreview(state.preview);
  }

  const cells = gridCells(state);

  session.cells = cells;
  session.order = fillOrder(state.subdivisions);
  placeFrame(cells);
  manualOptimizer.set({
    open: true, state, cells, selected: previewCell(state), filled: 0, total: cells.length,
  });
  showImages();
  worker.request();
  scheduleTilt();
}

/** Writes the design at `ratios` (scale height's own stretch), rebuilding the stone on screen. */
function writePreview(ratios) {
  setTierValues(scaledValues(session.pristine, ratios, session.pivots));
}

// ---- the grid's pictures

/** The key a stone is known by: its two ratios. */
function stoneKey({ crown, pavilion }) {
  return `${crown.toPrecision(12)}:${pavilion.toPrecision(12)}`;
}

/** The key a picture is known by: its stone, the frame, the view and settings, and its size. */
function drawKey(cell) {
  return `${stoneKey(cell)}|${session.frameKey}|${session.viewKey}|${session.size}`;
}

/**
 * Works out the frame for the grid's tallest stone. A new frame means every stone's GPU copy is
 * in the old one, so they are all let go (their OBJ texts are kept: rebuilding those is the costly
 * part).
 */
function placeFrame(cells) {
  if (session.corners === null) {
    return;
  }

  const crownMax = Math.max(...cells.map(cell => cell.crown));
  const pavilionMax = Math.max(...cells.map(cell => cell.pavilion));
  const frame = gridFrame(session.corners, session.pivots, crownMax, pavilionMax);
  const key = [frame.center.x, frame.center.y, frame.center.z, frame.radius]
    .map(value => value.toPrecision(9)).join(',');

  if (key !== session.frameKey) {
    session.frame = frame;
    session.frameKey = key;
    session.stones.clear();
    session.inFlight = null;
    engine.app?.thumbnail_clear();
  }
}

/**
 * Every render setting a picture depends on, as one comparable string. Not the view's pose: the
 * pictures are all face up (`FACE_UP`).
 */
function viewKey() {
  const app = engine.app;

  if (!app) {
    return '';
  }

  const values = DRAWN_PARAMS.map(name => {
    try {
      return app.get_param(name);
    } catch (cause) {
      return '';
    }
  });

  return [
    ...values, app.lighting_model(), app.has_environment_image(), app.background_enabled(),
    ...app.background_color(), app.window_color_enabled(), ...app.window_color(),
    ...app.head_shadow_color(), ...app.stone_color(), app.wireframe_enabled(),
  ].join('|');
}

/**
 * Every redraw the page asks for passes through here (viewport.js's `onRenderRequest`): if a
 * render setting a picture depends on has changed, the grid is redrawn once the change has rested.
 * Turning the view asks for redraws too, and changes nothing here: the pictures are face up. The
 * Monte Carlo loop asks for a frame per pass, which changes nothing and costs one string
 * comparison. A change to a setting the graph under the grid is measured with (the head shadow
 * angle, in this mode's lighting settings) measures it again, as in Tools > Tilt performance.
 */
function renderRequested() {
  if (session === null) {
    return;
  }

  scheduleTilt();

  const key = viewKey();

  if (key === session.viewKey) {
    return;
  }

  clearTimeout(session.redrawTimer);
  session.redrawTimer = setTimeout(() => {
    if (session === null) {
      return;
    }

    session.viewKey = viewKey();
    showImages();
    worker.request();
  }, REDRAW_DELAY_MS);
}

/**
 * The side, in pixels, a cell's picture is drawn at: the grid's cells measured on screen, times
 * the screen's pixel ratio. A new size redraws the pictures (the stones are kept).
 */
export function setThumbnailSize(pixels) {
  const size = Math.max(16, Math.min(512, Math.round(pixels)));

  if (session === null || size === session.size) {
    return;
  }

  session.size = size;
  showImages();
  worker.request();
}

/**
 * Shows each cell's picture for the grid as it stands: the one drawn for the current view if
 * there is one, else the latest of the same stone (marked stale) until it is redrawn, else none.
 *
 * At once when the grid itself changes (`now`); for a picture coming in, at most every PUBLISH_MS,
 * so several pictures finished close together reach the grid in one update.
 */
function showImages({ now = true } = {}) {
  if (!now) {
    session.publishTimer ??= setTimeout(() => {
      if (session !== null) {
        session.publishTimer = null;
        showImages();
      }
    }, PUBLISH_MS);
    return;
  }

  clearTimeout(session.publishTimer);
  session.publishTimer = null;

  const images = session.cells.map(cell => {
    const current = session.images.get(drawKey(cell));

    if (current) {
      return current;
    }

    const latest = session.latest.get(stoneKey(cell));

    return latest ? { ...latest, stale: true } : null;
  });

  optimizerImages.set(images);
  manualOptimizer.update(store => ({
    ...store, filled: images.filter(image => image && !image.stale).length,
  }));
}

/**
 * The cells whose pictures are not drawn for the settings as they stand, in fill order, leaving
 * out the one being drawn: at most `limit` of them.
 */
function cellsToDraw(limit) {
  const waiting = [];

  for (const index of session.order) {
    const cell = session.cells[index];

    if (session.inFlight?.index !== index && !session.images.has(drawKey(cell))) {
      waiting.push(index);

      if (waiting.length >= limit) {
        break;
      }
    }
  }

  return waiting;
}

/** The OBJ text of a cell's stone, built once per session and kept (null if it does not build). */
function stoneText(cell) {
  const key = stoneKey(cell);

  if (session.texts.has(key)) {
    return session.texts.get(key);
  }

  // A copy of the design at the cell's ratios; the design itself is the preview's, untouched.
  const values = scaledValues(session.pristine, cell, session.pivots);
  const design = {
    ...session.design,
    tiers: values.map(({ tier, angle, distance }) => ({ ...tier, angle, distance })),
  };
  let text = null;

  try {
    text = DesignMesh.toObjText(design, { name: 'preview' });
  } catch (cause) {
    text = null;
  }

  if (session.texts.size >= TEXT_CACHE_LIMIT) {
    session.texts.delete(session.texts.keys().next().value);
  }

  session.texts.set(key, text);
  return text;
}

/** Keeps a picture, forgetting the oldest once there are too many. */
function keepImage(key, stone, image) {
  if (session.images.size >= IMAGE_CACHE_LIMIT) {
    session.images.delete(session.images.keys().next().value);
  }

  session.images.set(key, image);
  session.latest.set(stone, image);
}

/**
 * One step of filling the grid, and only one, so no step holds the page for long (T-0274): the
 * picture on the GPU collected if it is in, then ONE of
 *
 *   - with no picture on the GPU, the next cell's draw begun if its stone is loaded, or else the
 *     next stage of getting it there (its stone built, or loaded);
 *   - with a picture on the GPU, the next stage of a cell after it (up to LOOKAHEAD ahead), so the
 *     page prepares the next stones while the GPU draws instead of waiting for it.
 *
 * It asks for itself again while anything is left, and the budget spaces the steps out. Until
 * T-0274 a step built, loaded and drew one cell and then waited for its picture, all counted as the
 * step's cost, and the budget gave the page as long again after it.
 */
function fillStep() {
  const app = engine.app;

  if (session === null || !app || session.frame === null) {
    return;
  }

  // The graph under the grid goes first: a stone built here holds the page, and the sweep's batches
  // would wait behind it. The grid carries on when it is done (`tiltSwept`).
  if (tiltMeasuring()) {
    return;
  }

  collect(app);

  const waiting = cellsToDraw(LOOKAHEAD + 1);

  if (session.inFlight === null && waiting.length > 0) {
    const index = waiting[0];
    const id = session.stones.get(stoneKey(session.cells[index]));

    if (id !== undefined) {
      beginDraw(app, index, id);
    } else {
      prepare(app, index);
    }
  } else {
    // A picture is on the GPU: get a later cell's stone ready meanwhile, if one is not.
    const next = waiting.find(index => !session.stones.has(stoneKey(session.cells[index])));

    if (next !== undefined) {
      prepare(app, next);
    }
  }

  if (session.inFlight !== null || cellsToDraw(1).length > 0) {
    // Asked from inside the work, so it runs after the budget's gap.
    worker.request();
  } else {
    // The last picture is in: the grid shows it now rather than after the publishing wait, and a
    // graph that waited for the grid is measured.
    showImages();

    if (session.tilt.pending) {
      startTilt();
    }
  }
}

/** Whether the grid still has pictures to draw (or one on the GPU). */
function gridFilling() {
  return session.frame !== null && engine.app !== null &&
    (session.inFlight !== null || cellsToDraw(1).length > 0);
}

/**
 * The next stage of getting cell `index`'s stone onto the GPU: built (its OBJ text, once a
 * session) if it never was, else loaded. A stone that does not build or load is marked failed.
 */
function prepare(app, index) {
  const cell = session.cells[index];
  const key = stoneKey(cell);

  if (!session.texts.has(key)) {
    if (stoneText(cell) === null) {
      keepImage(drawKey(cell), key, { failed: true });
      showImages({ now: false });
    }

    return;
  }

  const text = session.texts.get(key);

  if (text === null) {
    keepImage(drawKey(cell), key, { failed: true });
    showImages({ now: false });
    return;
  }

  const id = session.nextId++;

  try {
    const { center, radius } = session.frame;

    app.thumbnail_load(id, text, center.x, center.y, center.z, radius);
    session.stones.set(key, id);
  } catch (cause) {
    keepImage(drawKey(cell), key, { failed: true });
    showImages({ now: false });
  }
}

/** Queues cell `index`'s picture on the GPU, face up, from its loaded stone `id`. */
function beginDraw(app, index, id) {
  const cell = session.cells[index];

  try {
    app.thumbnail_begin(id, session.size, session.size, FACE_UP.spin, FACE_UP.tilt);
  } catch (cause) {
    // Marked failed, so the next step goes on to the other cells rather than trying this one again.
    keepImage(drawKey(cell), stoneKey(cell), { failed: true });
    showImages({ now: false });
    showError(`The manual optimizer could not draw a preview: ${cause}`);
    return;
  }

  session.inFlight = { index, draw: drawKey(cell), key: stoneKey(cell), size: session.size };
}

/** Collects the picture on the GPU if it is in. */
function collect(app) {
  if (session.inFlight === null || !app.thumbnail_poll()) {
    return;
  }

  const { draw, key, size } = session.inFlight;
  const pixels = new Uint8ClampedArray(app.thumbnail_pixels());

  session.inFlight = null;

  if (pixels.length === size * size * 4) {
    keepImage(draw, key, { pixels, width: size, height: size, stale: false });
    showImages({ now: false });
  }
}

const worker = budgetedTask({ run: fillStep, budget: GRID_BUDGET });

// ---- the graph under the grid

/**
 * What the graph is of: the heights the middle shows and the render settings a measurement depends
 * on (tilt_performance.js's `measurementKey`), as one string.
 */
function tiltKey(app) {
  return `${stoneKey(get(manualOptimizer).state.preview)}|${measurementKey(name => app.get_param(name))}`;
}

/**
 * The heights or a measured setting may have changed: if the graph is not already of the stone in
 * the middle with the settings as they are, any sweep under way is stale and is cancelled, and the
 * new stone is measured once it has rested (TILT_SETTLE_MS) -- or at once from the cache, when it
 * was measured before (an undo, a click back on a cell).
 */
function scheduleTilt() {
  const app = engine.app;

  if (session === null || !app) {
    return;
  }

  const tilt = session.tilt;
  const key = tiltKey(app);

  if (key === tilt.key) {
    return;
  }

  tilt.key = key;
  clearTimeout(tilt.timer);
  tilt.timer = null;
  tilt.pending = false;
  tilt.sweep.cancel();
  tilt.measured.clear();
  // A sweep cancelled here was holding the view and the grid; both go on.
  releaseRenderHold();
  worker.request();

  const cached = tilt.cache.get(key);

  if (cached) {
    optimizerTiltProgress.set({ measured: 0, total: 0 });
    optimizerTilt.set({ ...cached, status: 'done' });
    return;
  }

  optimizerTilt.update(graph => ({ ...graph, status: 'waiting' }));
  tilt.timer = setTimeout(startTilt, TILT_SETTLE_MS);
}

/** The heights have rested: measures the stone in the middle over the default sweep. */
function startTilt() {
  const app = engine.app;

  if (session === null || !app) {
    return;
  }

  const tilt = session.tilt;

  tilt.timer = null;

  // The grid first: while it is still filling (on opening, after a rectangle or a new range), the
  // sweep waits for its last picture (`fillStep` starts it then). Measured 2026-09-28: sweeping
  // first held the grid's first pictures back by the sweep's 1-2 s.
  if (gridFilling()) {
    tilt.pending = true;
    return;
  }

  tilt.pending = false;

  const poses = sweepPoses(DEFAULT_RANGE);

  optimizerTiltProgress.set({ measured: 0, total: poses.length });
  optimizerTilt.update(graph => ({ ...graph, status: 'measuring' }));
  tilt.sweep.measure(poses);
}

/** A batch came in, or the sweep is done: the bar moves, and at the end the graph is drawn. */
function tiltSwept() {
  if (session === null) {
    return;
  }

  const tilt = session.tilt;

  if (tilt.sweep.busy()) {
    optimizerTiltProgress.set({ measured: tilt.measured.size, total: sweepPoses(DEFAULT_RANGE).length });
    return;
  }

  const samples = { x: [], y: [] };

  for (const [key, measurement] of tilt.measured) {
    const [axis, angle] = key.split(':');

    samples[axis].push({ angle: Number(angle), measurement });
  }

  const graph = {
    samples,
    range: { ...DEFAULT_RANGE },
    headShadow: engine.app.get_param('headShadowHalfAngle'),
    ratios: { ...get(manualOptimizer).state.preview },
  };

  if (tilt.cache.size >= TILT_CACHE_LIMIT) {
    tilt.cache.delete(tilt.cache.keys().next().value);
  }

  tilt.cache.set(tilt.key, graph);
  optimizerTiltProgress.set({ measured: 0, total: 0 });
  optimizerTilt.set({ ...graph, status: 'done' });
  // The view and the grid waited for the sweep; they go on now.
  releaseRenderHold();
  worker.request();
}

/** The renderer refused or failed a batch: the graph says so, and the grid and the view go on. */
function tiltFailed(cause) {
  if (session === null) {
    return;
  }

  optimizerTiltProgress.set({ measured: 0, total: 0 });
  optimizerTilt.update(graph => ({ ...graph, status: 'failed' }));
  releaseRenderHold();
  worker.request();
  showError(`The manual optimizer could not measure the stone's tilt performance: ${cause}`);
}

// Another design loaded under the mode (File > Open, a shared link) ends it without putting
// anything back: the tiers it held belong to the design that went, and loading clears the edit
// history, frame and all.
tierView.subscribe(() => {
  if (session !== null && getDesign() !== session.design) {
    close();
  }
});
