// Resize girdle mode (T-0237, opens on the side profile and moves only the pavilion since T-0241).
// The user (2026-09-23): "lets also add a resize girdle mode. it replaces the render bar with the
// girdle resizer ... similar logic as edit mode - when you're in resize mode can make changes and
// undo locally but only after done the changes are all committed at once."
//
// The third mode (kb/application-modes-current-and-planned.md), and the second whole-design one,
// built on scale height's pattern (scale_height_mode.js), which it follows step for step:
//   * the right-hand column swaps the render settings for its own panel (App.svelte,
//     ResizeGirdlePanel.svelte), and the instructions stay on the left;
//   * Done keeps the change, Cancel and Escape put the design back exactly as it was;
//   * the whole session is ONE entry in the edit history, recorded on Done inside a history frame
//     opened when the mode opens (`beginHistoryFrame`);
//   * while open, Undo and Redo step the gauge's own stack (`setLocalHistory`, session.js), since
//     every setting is computed afresh from the design as it stood when the mode opened
//     (`pristine`) -- the gauge IS the state;
//   * the whole design is held (`setDesignLock`, tier_controller.js): the tier toolbar goes
//     inactive, reorders and descriptions are refused, and no other mode opens while this one is
//     open, nor this one while another is (edit mode and scale height both check `designLocked`,
//     and this checks it and edit mode in turn). The cutting assistant (T-0234) is to do the same.
//
// T-0241, the user, 2026-09-24: "it should change the view to side view, just like scale height
// and the side button on the renderer. sorry - only modify the pavilion facet depths, don't
// modify the crown facet depths." So, like scale height, it opens on the side profile and every
// way out restores the pose the mode opened on -- the same `SIDE_PROFILE`, `currentPose` and
// `showPose` scale height uses (scale_height_mode.js), shared rather than copied. And the gauge
// now moves only PAVILION tier distances (resize_girdle.js's `followsGauge`, the same
// pavilion/crown/girdle rule scale height's `gaugeOf` uses); crown tiers, the table and girdle
// tiers keep theirs.
//
// T-0242, the user, 2026-09-24: the gauge changed from a ratio to a height z, moving the whole
// pavilion by (0, 0, -z) rather than scaling it, so every pavilion meetpoint with the girdle stays
// level. Nothing here changed: the mode still just asks resize_girdle.js for the tiers' values at
// whatever the gauge reads and writes them, the same way it did for a ratio.
//
// The math is resize_girdle.js's.

import { writable, get } from 'svelte/store';
import { editing } from './edit_mode.js';
import {
  getDesign, tierView, beginHistoryFrame, commitHistoryFrame, cancelHistoryFrame, recordEditEntry,
  setTierValues, setDesignLock, syncToolbar, designLocked,
} from './tier_controller.js';
import { setLocalHistory, syncUndoMenu } from './session.js';
import { budgetedTask } from './work_budget.js';
import { createGaugeHistory } from './scale_height.js';
import { SIDE_PROFILE, currentPose, showPose } from './scale_height_mode.js';
import { INITIAL_Z, resizedValues } from './resize_girdle.js';

/** True while resize girdle mode is open. */
export const resizeGirdleOpen = writable(false);

/** The gauge's height z, as the panel shows it (0 = the depths the mode opened on). */
export const girdleZ = writable(INITIAL_Z);

/** Added to every tier toolbar button's tooltip while this mode holds the design. */
const FINISH_RESIZING_TIP = ' Finish resizing the girdle first: Done, or Cancel.';

// The open session, or null: the design it opened on, every tier's angle and distance as they
// stood then (`pristine`, what every setting of the gauge is computed from, and what Cancel puts
// back), the gauge's own undo stack, and the view pose the mode opened on.
let session = null;

setDesignLock(() => session !== null, FINISH_RESIZING_TIP);

// The toolbar follows the mode opening and closing, as it follows the other modes'.
resizeGirdleOpen.subscribe(() => syncToolbar());

/** The local stack as session.js's Undo and Redo see it while the mode is open. */
const localStack = {
  canUndo: () => session?.history.canUndo() ?? false,
  canRedo: () => session?.history.canRedo() ?? false,
  undo: () => showZ(session?.history.undo() ?? null),
  redo: () => showZ(session?.history.redo() ?? null),
};

/**
 * Opens resize girdle mode on the loaded design, the gauge at z = 0. Does nothing, and returns
 * false, with no design loaded, while edit mode is open, or while this or another whole-design
 * mode (scale height) is open.
 */
export function enterResizeGirdleMode() {
  const design = getDesign();

  // `designLocked()` is true while this mode is open too, so it also refuses a second opening.
  if (designLocked() || get(editing) !== null || !design) {
    return false;
  }

  beginHistoryFrame();
  session = {
    design,
    pristine: design.tiers.map(tier => ({ tier, angle: tier.angle, distance: tier.distance })),
    // z is one number, so two states are the same exactly when they are equal.
    history: createGaugeHistory(INITIAL_Z, (a, b) => a === b),
    // The view the mode opened on, which every way out of it puts back (T-0241, as scale height's
    // does).
    pose: currentPose(),
  };
  showPose(SIDE_PROFILE);
  girdleZ.set(INITIAL_Z);
  resizeGirdleOpen.set(true);
  setLocalHistory(localStack);
  window.gemRequestRender?.();
  return true;
}

/** Done: keeps the resized design, as ONE entry in the edit history, and closes the mode. */
export function exitResizeGirdleMode() {
  if (session === null) {
    return;
  }

  // Whatever a drag still had queued is written now, in full.
  writer.cancel();
  writeDesign(false);

  // Every tier whose distance moved, as the same `tierValue` updates edit mode's depth ruler and
  // scale height record, so undo and redo replay them through `applyEdit` with no new kind of op,
  // in one entry and one rebuild. Nothing moved (the gauge back at z = 0) records nothing.
  const ops = [];

  for (const { tier, distance } of session.pristine) {
    if (tier.distance !== distance) {
      ops.push({
        kind: 'update', target: 'tierValue', tier, field: 'distance', before: distance, after: tier.distance,
      });
    }
  }

  recordEditEntry({ label: 'Resize girdle', ops });
  commitHistoryFrame('Resize girdle');
  close();
}

/**
 * Cancel, and Escape: closes the mode and puts every tier back as it stood when the mode opened,
 * recording nothing.
 */
export function cancelResizeGirdleMode() {
  if (session === null) {
    return;
  }

  const { pristine } = session;

  writer.cancel();
  close();
  // Nothing was recorded in the frame (the gauge keeps its own stack), so this only closes it.
  cancelHistoryFrame();
  // Forced: the stone on screen may be a quick, mid-drag one even when the design is already back.
  setTierValues(pristine, { force: true });
}

/** Ends the session, whichever way it ends, and puts the view back as it was when it opened. */
function close() {
  const { pose } = session;

  session = null;
  showPose(pose);
  quickOnScreen = false;
  setLocalHistory(null);
  resizeGirdleOpen.set(false);
  window.gemRequestRender?.();
}

/**
 * The gauge moved (ResizeGirdlePanel's ruler): `value` already snapped and inside the scale,
 * `done` true for a finished change -- a drag's release, a wheel or key step -- which is one step
 * of the mode's own undo.
 */
export function changeZ(value, done) {
  if (session === null) {
    return;
  }

  girdleZ.set(value);

  if (done) {
    writer.cancel();
    writeDesign(false);

    if (session.history.commit(value)) {
      syncUndoMenu();
    }
  } else {
    writer.request();
  }
}

/** Undo or redo inside the mode handed back `z` (null: nothing to step to). */
function showZ(z) {
  if (session === null || z === null) {
    return;
  }

  girdleZ.set(z);
  writer.cancel();
  writeDesign(false);
  syncUndoMenu();
}

// ---- writing the design (streamed during a drag, as scale height's gauges and edit mode's rulers
// are): each write rebuilds the stone, 300 ms to 2 s on a large design (T-0194), so the newest z
// waits for a budgeted turn and the tape follows the pointer meanwhile. The same 0.4 budget.
const WRITE_BUDGET = 0.4;

// True while the stone on screen is a quick, mid-drag rebuild, so the finishing write rebuilds in
// full even when it changes no value.
let quickOnScreen = false;

const writer = budgetedTask({ run: () => writeDesign(true), budget: WRITE_BUDGET });

/** Writes every tier for z as it stands. `quick` mid-drag, as selection.js means it. */
function writeDesign(quick) {
  if (session === null) {
    return;
  }

  setTierValues(resizedValues(session.pristine, get(girdleZ)), { quick, force: !quick && quickOnScreen });
  quickOnScreen = quick;
}

// Another design loaded under the mode (File > Open, a shared link) ends it without putting
// anything back: the tiers it held belong to the design that went, and loading clears the edit
// history, frame and all.
tierView.subscribe(() => {
  if (session !== null && getDesign() !== session.design) {
    writer.cancel();
    close();
  }
});
