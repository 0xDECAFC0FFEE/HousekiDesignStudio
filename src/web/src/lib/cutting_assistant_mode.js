// The cutting assistant mode (T-0234): Tools > Cutting assistant. The user (2026-09-23):
//
//   "the cutting assistant will not modify the actual faceting instructions. its purpose is to tell
//   users the steps to cut the rock and what the rock will look like at each step.
//   we leave the cutting instructions on the screen without the buttons at the bottom but the
//   rendering instructions are replaced with a cutting assistant bar. ... before we cut any tiers,
//   we only render a cube larger than our rock. at the bottom of the cube, our dop (a medium sized
//   rod rendered in bronze) sticks out. ... once we cut all the cuts in the pavilion, the dop
//   switches from the pavilion to the crown. we can continue cutting from there.
//   we also need a done button at the bottom (like in all tools) and escape also can escape."
//
// The third mode (kb/application-modes-current-and-planned.md), and the first that is a window onto
// the design rather than a change to it. What it shares with scale height, deliberately:
//   * the right-hand column swaps the render settings for its own bar (App.svelte,
//     CuttingAssistantPanel.svelte), and the instructions stay on the left;
//   * it holds the whole design (`setDesignLock`, tier_controller.js), so the tier toolbar goes
//     inactive, and edit mode, scale height, a reorder or a description edit are refused while it
//     is open -- and it refuses to open while either of those modes is;
//   * Undo and Redo are handed to a stack of its own (`setLocalHistory`, session.js).
// What differs, because NOTHING IS CHANGED: there is no history frame and no Cancel. Its stack is
// empty for good, so Undo and Redo are inert while it is open; Done and Escape both close it; and
// closing puts the design's own stone back exactly as it was, byte for byte (`model_obj_text`).
//
// What it draws is not the design's stone at all: a rough cube with the first k cuts of the
// sequence made (cutting_assistant.js has the order, the navigation and the geometry), built by the
// page's own half-space builder from an explicit plane list (DesignMesh.toObjTextFromPlanes) and
// loaded in one pinned frame for the whole session (`load_obj_framed`), so the rock stays put and
// keeps its size as its corners are cut away. The dop is the renderer's (`set_dop`), glued to the
// top of the rough for the pavilion and moved to the culet for the crown, where its end is sunk
// into the pavilion.
//
// The dop is drawn by the deterministic and flat renderers only (T-0239, the user: "get rid of the
// dop from monte carlo and just switch the user to the deterministic renderer if it's currently in
// monte carlo? if the user is in the fast renderer just stay there"). So opening from Monte Carlo
// switches to Deterministic, and closing puts back whichever renderer the user had.

import { writable, get } from 'svelte/store';
import { editing } from './edit_mode.js';
import {
  getDesign, tierView, setDesignLock, setRowClickOverride, setStonePickBlock, syncToolbar, highlightTier,
  designLocked, scrollTierIntoView,
} from './tier_controller.js';
import { setLocalHistory, applyParam, selectRenderer } from './session.js';
import { engine, bumpParams, showError, stoneStatsStore } from './stores.js';
import { showStoneStats } from './stone_stats.js';
import { buildFacetTierMap, setFacetTierMap } from './facet_map.js';
import { syncFrostedFacets } from './selection.js';
import { budgetedTask } from './work_budget.js';
import { setReverseDragSpin } from './viewport.js';
import {
  PAVILION, CROWN, buildCutSequence, clampPosition, tierAt, tierStart, nextCut, prevCut, nextTier, prevTier,
  phaseAt, tierState, boundsOf, roughCube, dopSize, dopPlacement, viewFrame,
} from './cutting_assistant.js';

/**
 * What the bar shows: `{ open, sequence, k }` -- the cut sequence of the design the mode opened on
 * (cutting_assistant.js's `buildCutSequence`), and the position, the number of cuts made. The bar
 * works everything else out from these two with cutting_assistant.js's pure functions.
 */
export const cutting = writable({ open: false, sequence: null, k: 0 });

/**
 * Each tier row's state while the mode is open, a `Map` from the tier OBJECT (the rows' own key)
 * to 'cut', 'current' or 'uncut'; null while it is closed. TierRow greys the uncut rows and
 * highlights the current one. A tier with nothing to cut (a hidden one) has no entry.
 */
export const cuttingRows = writable(null);

/** The pose the view is put in for each phase: the dop pointing down the screen. */
export const PHASE_POSES = {
  // tilt -120: the eye below the girdle, on the pavilion side, and the optical axis turned so the
  // table -- where the dop is glued -- points down the screen. The rough sits on the dop with the
  // pavilion, the surface being cut, facing up at the viewer; a three-quarter view, 30 degrees
  // off the side view, so the girdle outline and the pavilion both show.
  //
  // spin -165 is the crown's 15 plus half a turn (wrapped into the renderer's [-180, 180)): the
  // stone turned 180 degrees about its optical axis, x -> -x and y -> -y (T-0239, the user: "when
  // viewing the pavilion cuts can you reverse the x-y direction?"), so the index directions read
  // as the cutter sees them with the stone upside down on the dop. A turn of the view, not a
  // change to the design; the crown phase is as it was.
  [PAVILION]: { spin: -165, tilt: -120 },
  // tilt 60: the same view of the other half, once the dop is on the culet.
  [CROWN]: { spin: 15, tilt: 60 },
};

/** `params::Renderer::as_u32` for the two renderers the mode cares about. */
const RENDERER_DETERMINISTIC = 0;
const RENDERER_MONTE_CARLO = 1;

// The open session, or null: the design and its sequence, the rough and the dop's two places, the
// frame, every cut's plane, the pose and the stone to put back, the phase the view is posed for,
// and which position the stone on screen shows.
let session = null;

/** True while the mode is open. */
export function cuttingAssistantOpen() {
  return session !== null;
}

// The whole design is held (see the header), and the toolbar says why.
setDesignLock(() => session !== null, ' Close the cutting assistant first: Done, or Escape.');

// The rough on screen is not the design's stone, so a click on it picks nothing.
setStonePickBlock(() => session !== null);

// In the pavilion phase the stone is seen upside down (PHASE_POSES), so a sideways drag spins it
// the other way, to match what the hand sees (viewport.js's setReverseDragSpin).
setReverseDragSpin(() => session !== null && session.phase === PAVILION);

/** Undo and Redo while open: nothing to step, ever -- the mode changes nothing. */
const INERT_HISTORY = {
  canUndo: () => false,
  canRedo: () => false,
  undo: () => {},
  redo: () => {},
};

/**
 * Opens the mode on the loaded design, at k = 0, the uncut rough. Does nothing, and returns false,
 * with no design or no renderer, while edit mode or scale height is open (one mode at a time),
 * while this mode is already open, when the design has nothing to cut, or when its finished stone
 * will not build (there is then no size to make the rough from; the error box says so).
 */
export function enterCuttingAssistant() {
  const design = getDesign();
  const app = engine.app;

  if (session !== null || get(editing) !== null || designLocked() || !design || !app) {
    return false;
  }

  const sequence = buildCutSequence(design);

  if (sequence.total === 0) {
    return false;
  }

  // The finished stone, built once, only to be measured: the rough is sized from it, and so is
  // the dop. The design's planes, as the page's own stone is built from them.
  let bounds;

  try {
    bounds = boundsOf(DesignMesh.buildFaces(design).faces.flatMap(face => face.polygon));
  } catch (cause) {
    showError(`The cutting assistant needs the finished stone, which could not be built: ${cause}`);
    return false;
  }

  const cube = roughCube(bounds);
  const size = dopSize(bounds);
  // Each cut's plane, and its place in the design's own plane order (GemCadDesign.planesOf: tier
  // by tier in design.tiers, facet by facet) -- the order `buildShown` hands them to the builder.
  const cutPlanes = sequence.cuts.map(({ tier, facet }) => ({
    normal: GemCadDesign.normalOf(design, tier.angle, facet.index),
    offset: tier.distance,
    designOrder: design.tiers.indexOf(tier) * 1e6 + tier.facets.indexOf(facet),
  }));
  // The dop's two places, fixed for the session: the top of the rough never moves while the
  // pavilion is cut (every pavilion plane faces down, and the girdle's are vertical), and the culet
  // never moves while the crown is (every crown plane faces up).
  const dop = {
    [PAVILION]: dopPlacement(cube.planes, PAVILION, size),
    [CROWN]: dopPlacement(cube.planes.concat(cutPlanes.slice(0, sequence.transfer)), CROWN, size),
  };

  session = {
    design,
    sequence,
    cube,
    cutPlanes,
    // The builder's tolerances are scaled by the size of the planes it is given, and the cube's
    // would make them the rough's rather than the stone's. Fixed to the design's (see buildShown).
    meshScale: DesignMesh.scaleOf(GemCadDesign.renderedPlanesOf(design)),
    dop,
    frame: viewFrame(cube, size),
    pose: { spin: app.get_param('spin'), tilt: app.get_param('tilt') },
    // The renderer to put back on closing (see the header).
    renderer: app.renderer(),
    stoneText: app.model_obj_text(),
    phase: null,
    k: null,
    shownK: null,
  };

  setLocalHistory(INERT_HISTORY);
  setRowClickOverride(tier => {
    const t = session?.sequence.tiers.findIndex(entry => entry.tier === tier) ?? -1;

    // A row with nothing to cut (a hidden tier) has no place in the walkthrough.
    if (t >= 0) {
      goTo(tierStart(session.sequence, t));
    }
  });
  // The design's selection belongs to the design's stone; the bar's current tier takes its place.
  highlightTier(null);
  // The corner stats describe the design's stone, which is not the one on screen.
  stoneStatsStore.set(null);

  // Monte Carlo does not draw the dop; Deterministic and Flat stay as they are. Not saved as the
  // user's choice, so a reload mid-walkthrough still starts in Monte Carlo.
  if (session.renderer === RENDERER_MONTE_CARLO) {
    selectRenderer(RENDERER_DETERMINISTIC, { remember: false });
  }

  syncToolbar();
  goTo(0);
  return true;
}

/**
 * Done, and Escape: closes the mode and puts back what it found -- the design's own stone, byte
 * for byte, its facet map, frosted facets and stats, the view's pose, and Undo and Redo. Nothing
 * was recorded, so nothing is committed or undone.
 */
export function exitCuttingAssistant() {
  if (session === null) {
    return;
  }

  const app = engine.app;
  const { design, stoneText, pose } = session;

  close();

  try {
    app.load_obj(stoneText);
  } catch (cause) {
    showError(`Could not put the stone back after the cutting assistant: ${cause}`);
  }

  setFacetTierMap(buildFacetTierMap(app, design));
  syncFrostedFacets(app);
  showStoneStats(app, stoneText);
  applyParam('spin', pose.spin);
  applyParam('tilt', pose.tilt);
  bumpParams();
  window.gemRequestRender?.();
}

/**
 * Ends the session, whichever way it ends: the dop goes, the renderer the user had comes back, and
 * so do the page's hooks.
 */
function close() {
  const rendererBefore = session.renderer;

  builder.cancel();
  session = null;
  engine.app?.clear_dop();

  if (engine.app && engine.app.renderer() !== rendererBefore) {
    selectRenderer(rendererBefore, { remember: false });
  }

  setLocalHistory(null);
  setRowClickOverride(null);
  cuttingRows.set(null);
  cutting.set({ open: false, sequence: null, k: 0 });
  syncToolbar();
}

/**
 * Moves to position `k` (clamped to 0..N): the bar and the rows follow at once, the view is
 * re-posed when the phase changes (and only then, so an orbit the user made is kept), and the
 * stone follows as soon as it can be built (`builder`).
 */
export function goTo(k) {
  if (session === null) {
    return;
  }

  const { sequence } = session;
  const position = clampPosition(sequence, k);
  const tierBefore = session.k === null ? null : tierAt(sequence, session.k);

  session.k = position;
  cutting.set({ open: true, sequence, k: position });
  cuttingRows.set(new Map(sequence.tiers.map((entry, t) => [entry.tier, tierState(sequence, t, position)])));

  // The highlighted row follows the work down a long list, as a selected one does: scrolled into
  // view when the current tier changes (not on every cut, which would fight a user's own scroll).
  const tierNow = tierAt(sequence, position);

  if (tierNow !== tierBefore && tierNow < sequence.tiers.length) {
    scrollTierIntoView(sequence.tiers[tierNow].tier);
  }

  const phase = phaseAt(sequence, position);

  if (phase !== session.phase) {
    session.phase = phase;

    const { start, end, radius, capped } = session.dop[phase];

    engine.app.set_dop(start.x, start.y, start.z, end.x, end.y, end.z, radius, capped);
    applyParam('spin', PHASE_POSES[phase].spin);
    applyParam('tilt', PHASE_POSES[phase].tilt);
    bumpParams();
  }

  // The rough changes while the user steps or scrubs, so it is drawn in draft while they do, the
  // way everything else that moves on this page is (the user, 2026-09-19: "when ... anything is
  // moved ... make sure the resolution is dropped and the internal bounces are dropped"); full
  // quality comes back by itself shortly after the last step. Without it, scrubbing a
  // 1001-facet design stalled the page's frames for up to 1.95 s, measured, while the slider
  // and the bar kept up. `window.` for the reason selection.js reaches it that way.
  window.gemBeginInteraction?.();
  builder.request();
}

/** The four buttons, and the keys that stand for them. */
export const step = {
  nextCut: () => session && goTo(nextCut(session.sequence, session.k)),
  prevCut: () => session && goTo(prevCut(session.sequence, session.k)),
  nextTier: () => session && goTo(nextTier(session.sequence, session.k)),
  prevTier: () => session && goTo(prevTier(session.sequence, session.k)),
};

// ---- building the stone for the position
//
// Scrubbing the slider can ask for a new position on every pointer move, and on a design of a
// thousand facets one build takes about 150 ms (DesignMesh's O(planes^2) clip, T-0194) plus the
// load. So builds are never queued one per request: the builder runs on a budgeted turn
// (work_budget.js) and always builds the position asked for LAST, skipping any it was never asked
// to show in between. The bar and the rows, which cost nothing, follow the pointer meanwhile. The
// same 0.4 share of the clock as edit mode's and scale height's writers, for the same reason.
const BUILD_BUDGET = 0.4;

const builder = budgetedTask({ run: buildShown, budget: BUILD_BUDGET });

/**
 * Loads the rough with the first k cuts made, for the position the session is at now.
 *
 * The planes go to the builder in the DESIGN's order, with the cube's after them, and with the
 * design's tolerances (`meshScale`) -- not in cutting order with the cube first. Any order gives
 * the same solid, but not the same floating-point path through the clip, and at k = N this way is
 * the design's own build, byte for byte: the finished rough IS the stone the page shows outside the
 * mode. Built the other way, The_Arkenstone_of_Thrain.gem's finished rough came out 982 facets
 * against the design's 997 once Rust had conditioned its freewheel slivers (measured).
 */
function buildShown() {
  if (session === null || session.shownK === session.k) {
    return;
  }

  const app = engine.app;
  const { cube, cutPlanes, frame, meshScale } = session;
  const k = session.k;
  const made = cutPlanes.slice(0, k).sort((a, b) => a.designOrder - b.designOrder);
  let text;

  try {
    text = DesignMesh.toObjTextFromPlanes(made.concat(cube.planes), { name: 'rough', scale: meshScale });
    app.load_obj_framed(text, frame.center.x, frame.center.y, frame.center.z, frame.radius);
  } catch (cause) {
    // Not expected: the rough is a closed cube before any cut, and every cut only shrinks it.
    console.warn(`Could not build the rough at cut ${k}: ${cause}`);
    return;
  }

  session.shownK = k;
  app.set_highlighted_facets(new Uint32Array(k > 0 ? facetsFacing(app, cutPlanes[k - 1].normal) : []));
  // Drafted like the step that asked for it (see goTo): a build can land well after the step on a
  // large design, and its first frame should not be the one full-quality frame of a scrub.
  window.gemBeginInteraction?.();
  window.gemRequestRender?.();
}

/**
 * The mesh facets whose outward normal is `normal` -- the face the last cut left, which the
 * deterministic renderer tints with the page's own highlight. On a convex solid at most one face
 * faces any one way, and none when the cut took nothing off (a plane an earlier cut already went
 * deeper than).
 */
function facetsFacing(app, normal) {
  const normals = app.facet_normals();
  const ids = [];

  for (let f = 0; f < normals.length / 3; f++) {
    const dot = normals[f * 3] * normal.x + normals[f * 3 + 1] * normal.y + normals[f * 3 + 2] * normal.z;

    if (dot > 1 - 1e-6) {
      ids.push(f);
    }
  }

  return ids;
}

// Another design loaded under the mode (File > Open, a shared link) ends it without putting
// anything back: the stone on screen is already the new design's, and the old one's is gone.
tierView.subscribe(() => {
  if (session !== null && getDesign() !== session.design) {
    close();
  }
});
