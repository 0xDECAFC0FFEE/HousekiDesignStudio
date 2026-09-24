// Scale height mode (T-0231). The user (2026-09-23): "can you delete the scale x-y and scale z and
// only have a scale height? when this is selected, we need to enter the 'scale height mode'. in
// scale height mode, we leave the faceting instructions on the left but on the right we replace
// the render settings with the scale height settings ... at the very bottom, like with edit mode
// (and all modes that edit the gem) we need the done and cancel buttons ... similarly with edit
// mode (and all modes), commit all changes to the undo stack at once at the very end but allow
// undoing in a local undo stack while in scale height mode."
//
// The second mode after edit mode (kb/application-modes-current-and-planned.md), and the first
// whole-design one: it rewrites EVERY tier, where edit mode holds one. What it shares with edit
// mode, deliberately:
//   * the right-hand column swaps the render settings for its own panel (App.svelte,
//     ScaleHeightPanel.svelte), and the instructions stay on the left;
//   * Done keeps the changes, Cancel and Escape put the design back as it was;
//   * the whole session is ONE entry in the edit history, recorded on Done inside a history frame
//     opened when the mode opens (`beginHistoryFrame`), exactly as edit mode's is;
//   * only one mode at a time: this refuses to open while edit mode is open, and edit mode
//     refuses while this is (`designLocked`, tier_controller.js).
// What differs: while it is open, Undo and Redo step the gauges' own stack (`setLocalHistory`,
// session.js) instead of the edit history. Edit mode records each drag in the frame and lets Undo
// step through those; here nothing is recorded until Done, because every setting of the gauges is
// computed afresh from the design as it stood when the mode opened (`pristine`), never from the
// previous setting -- so the gauges ARE the state, and stepping them back is stepping the design
// back.
//
// The math is scale_height.js's.

import { writable, get } from 'svelte/store';
import { editing } from './edit_mode.js';
import {
  getDesign, tierView, beginHistoryFrame, commitHistoryFrame, cancelHistoryFrame, recordEditEntry,
  setTierValues, setDesignLock, syncToolbar, designLocked,
} from './tier_controller.js';
import { setLocalHistory, syncUndoMenu, applyParam } from './session.js';
import { engine, bumpParams } from './stores.js';
import { rockShape } from './edit_geometry.js';
import { budgetedTask } from './work_budget.js';
import {
  INITIAL_GAUGES, moveGauge, setGaugeLock, resetGauges, gaugesAtOne, createGaugeHistory, heightPivots,
  scaledValues,
} from './scale_height.js';

/** True while scale height mode is open. */
export const scaleHeightOpen = writable(false);

/** The two gauges and the lock, `{ pavilion, crown, lock }`, as the panel shows them. */
export const scaleGauges = writable(INITIAL_GAUGES);

// The open session, or null: the design it opened on, every tier's angle and distance as they
// stood then (`pristine`, what every setting of the gauges is computed from, and what Cancel puts
// back), the planes each half is stretched about, and the gauges' own undo stack.
let session = null;

// The whole design is held while the mode is open (tier_controller.js's `setDesignLock`): the tier
// toolbar goes inactive, and a reorder, a description edit, or edit mode itself is refused.
setDesignLock(() => session !== null);

// The toolbar follows the mode opening and closing, as it follows edit mode's.
scaleHeightOpen.subscribe(() => syncToolbar());

// ---- the view (T-0235, the user: "can you rotate the stone to the side profile?")
//
// A height change shows side-on, so the mode opens there: the optical axis upright on screen, the
// crown up and the girdle edge-on. That is exactly the renderer pane's own Side button
// (Viewport.svelte's `setView(90)`: spin 0, tilt 90) -- at tilt 90 camera.rs puts the eye on world
// +Z with screen up along world +Y, the optical axis, towards the crown. The user can still orbit
// while the mode is open; Done, Cancel, Escape, and a design loaded under the mode all put back the
// pose the mode opened on (spin and tilt, the only two things this moves; zoom is untouched).
// Exported (not just module-local) so resize girdle mode (T-0241) can open on the same pose
// through the same save/restore mechanism, rather than a second copy of it.
export const SIDE_PROFILE = Object.freeze({ spin: 0, tilt: 90 });

/** The current pose as `{ spin, tilt }` in degrees, or null with no renderer (Deno's tests). */
export function currentPose() {
  const app = engine.app;

  return app ? { spin: app.get_param('spin'), tilt: app.get_param('tilt') } : null;
}

/**
 * Turns the view to `pose` the way the Side button does -- through `applyParam`, so a facet turn
 * in flight stops and the frame is redrawn -- and has the X/Y rotation sliders read it back.
 */
export function showPose(pose) {
  if (pose === null || !engine.app) {
    return;
  }

  if (applyParam('spin', pose.spin) && applyParam('tilt', pose.tilt)) {
    bumpParams();
  }
}

/** The local stack as session.js's Undo and Redo see it while the mode is open. */
const localStack = {
  canUndo: () => session?.history.canUndo() ?? false,
  canRedo: () => session?.history.canRedo() ?? false,
  undo: () => showGauges(session?.history.undo() ?? null),
  redo: () => showGauges(session?.history.redo() ?? null),
};

/**
 * Opens scale height mode on the loaded design, both gauges at 1x and the lock off. Does nothing,
 * and returns false, with no design loaded, while edit mode is open ("one session at a time", as
 * `enterEditMode` has it), or while this mode is already open.
 */
export function enterScaleHeightMode() {
  const design = getDesign();

  // Nor while another whole-design mode holds the design (T-0234, the cutting assistant): with
  // this mode's own session closed, a held design can only be another mode's.
  if (session !== null || get(editing) !== null || designLocked() || !design) {
    return false;
  }

  // Measured once, on the stone as it stands now (about half a second on a 67-facet design, so
  // never per drag). A design that does not build has no corners to measure; its halves are then
  // stretched about the design's own origin, which is still a stretch, just not one pinned to the
  // girdle.
  let pivots;

  try {
    pivots = heightPivots(design, rockShape(design));
  } catch (cause) {
    pivots = { crown: 0, pavilion: 0, overlap: false };
  }

  beginHistoryFrame();
  session = {
    design,
    pristine: design.tiers.map(tier => ({ tier, angle: tier.angle, distance: tier.distance })),
    pivots,
    history: createGaugeHistory(INITIAL_GAUGES),
    // The view the mode opened on, which every way out of it puts back (T-0235).
    pose: currentPose(),
  };
  showPose(SIDE_PROFILE);
  scaleGauges.set(INITIAL_GAUGES);
  scaleHeightOpen.set(true);
  setLocalHistory(localStack);
  window.gemRequestRender?.();
  return true;
}

/** Done: keeps the stretched design, as ONE entry in the edit history, and closes the mode. */
export function exitScaleHeightMode() {
  if (session === null) {
    return;
  }

  // Whatever a drag still had queued is written now, in full.
  writer.cancel();
  writeDesign(false);

  // Every tier whose angle or distance moved, as the same `tierValue` updates edit mode's rulers
  // record, so undo and redo replay them through `applyEdit` with no new kind of op -- and in one
  // entry, one rebuild. Nothing moved (both gauges back at 1x) records nothing.
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

  recordEditEntry({ label: 'Scale height', ops });
  commitHistoryFrame('Scale height');
  close();
}

/**
 * Cancel, and Escape: closes the mode and puts every tier back as it stood when the mode opened,
 * recording nothing.
 */
export function cancelScaleHeightMode() {
  if (session === null) {
    return;
  }

  const { pristine } = session;

  writer.cancel();
  close();
  // Nothing was recorded in the frame (the gauges keep their own stack), so this only closes it.
  cancelHistoryFrame();
  // The rebuild is forced: the stone on screen may be a quick, mid-drag one even when the design
  // is already back where it started.
  setTierValues(pristine, { force: true });
}

/** Ends the session, whichever way it ends, and puts the view back as it was when it opened. */
function close() {
  const { pose } = session;

  session = null;
  showPose(pose);
  quickOnScreen = false;
  setLocalHistory(null);
  scaleHeightOpen.set(false);
  window.gemRequestRender?.();
}

/**
 * A gauge moved (ScaleHeightPanel's rulers): `which` is 'pavilion' or 'crown', `value` already
 * snapped and inside the scale, `done` true for a finished change -- a drag's release, a typed
 * value, a wheel or key step -- which is one step of the mode's own undo.
 */
export function changeGauge(which, value, done) {
  if (session === null) {
    return;
  }

  const next = moveGauge(get(scaleGauges), which, value);

  scaleGauges.set(next);

  if (done) {
    writer.cancel();
    writeDesign(false);

    if (session.history.commit(next)) {
      syncUndoMenu();
    }
  } else {
    writer.request();
  }
}

/**
 * Reset (T-0235): both gauges back to 1x, the lock as it was, as one step of the mode's own undo.
 * Does nothing when both already read 1x (the button is inert then).
 */
export function resetScaleGauges() {
  if (session === null || gaugesAtOne(get(scaleGauges))) {
    return;
  }

  const next = resetGauges(get(scaleGauges));

  scaleGauges.set(next);
  writer.cancel();
  writeDesign(false);

  if (session.history.commit(next)) {
    syncUndoMenu();
  }
}

/** The lock was switched on or off: one step of the mode's own undo, like a gauge's. */
export function changeLock(on) {
  if (session === null || get(scaleGauges).lock === on) {
    return;
  }

  const next = setGaugeLock(get(scaleGauges), on);

  scaleGauges.set(next);
  writer.cancel();
  writeDesign(false);

  if (session.history.commit(next)) {
    syncUndoMenu();
  }
}

/** Undo or redo inside the mode handed back `state` (null: nothing to step to). */
function showGauges(state) {
  if (session === null || state === null) {
    return;
  }

  scaleGauges.set(state);
  writer.cancel();
  writeDesign(false);
  syncUndoMenu();
}

// ---- writing the design (streamed during a drag, the way edit mode's rulers are)
//
// A drag reports a value per pointer move, and each one rebuilds the stone -- 300 ms to 2 s on a
// large design (T-0194), which cannot be interrupted. So the newest gauges wait for a budgeted turn
// (work_budget.js): the design is written at most WRITE_BUDGET of the wall clock, and the tapes,
// which show the pointer's own value meanwhile (ValueRuler's `dragged`), keep the rest. The same
// 0.4 as EditPanel's, for the same reason.
const WRITE_BUDGET = 0.4;

// True while the stone on screen is a quick, mid-drag rebuild, so the finishing write rebuilds in
// full even when it changes no value.
let quickOnScreen = false;

const writer = budgetedTask({ run: () => writeDesign(true), budget: WRITE_BUDGET });

/** Writes every tier for the gauges as they stand. `quick` mid-drag, as selection.js means it. */
function writeDesign(quick) {
  if (session === null) {
    return;
  }

  setTierValues(scaledValues(session.pristine, get(scaleGauges), session.pivots),
    { quick, force: !quick && quickOnScreen });
  quickOnScreen = quick;
}

// Another design loaded under the mode (File > Open, a shared link) ends it without putting
// anything back: the tiers it held belong to the design that went, and loading clears the edit
// history, frame and all (session.js's `installLoadedDesign`).
tierView.subscribe(() => {
  if (session !== null && getDesign() !== session.design) {
    writer.cancel();
    close();
  }
});
