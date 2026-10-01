// Rotate by index mode (T-0287). The user, 2026-09-29: "can you add support for rotate index mode -
// it needs a slider to the right along with the cancel/done buttons".
//
// One of Edit's whole-design transforms (kb/application-modes-current-and-planned.md), and, as the
// user directed on 2026-09-22 for every greyed-out Edit and Tools item, its own mode. It follows
// resize girdle's pattern (resize_girdle_mode.js) step for step:
//   * the right-hand column swaps the render settings for its own panel (App.svelte,
//     RotateIndexPanel.svelte): one slider, then Cancel and Done; the instructions stay on the left
//     and follow the slider, so the cutter sees the teeth change;
//   * Done keeps the turn, Cancel and Escape put the design back exactly as it was;
//   * the whole session is ONE entry in the edit history, recorded on Done inside a history frame
//     opened when the mode opens (`beginHistoryFrame`);
//   * while open, Undo and Redo step the slider's own stack (`setLocalHistory`, session.js): every
//     position is computed afresh from the design as it stood when the mode opened (`pristine`),
//     so the slider IS the state;
//   * the whole design is held (`setDesignLock`, tier_controller.js): the tier toolbar goes
//     inactive, reorders and descriptions are refused, and no other mode opens while this one is
//     open, nor this one while another is (every mode checks `designLocked()`, and this checks it
//     and edit mode in turn). The gear dialog cannot be reached meanwhile: its button is on the sub
//     bar, which is shown only in edit mode (Workspace.svelte), so the tooth count this mode turns
//     on cannot change under it.
//
// Unlike scale height and resize girdle, the view is NOT turned: the stone and the camera stay
// where they are, so the facets are seen to turn. (The index dial round the stone, drawn when it is
// looked at face-up, stays put too, so the teeth can be read off against it.)
//
// The math is rotate_index.js's.

import { writable, get } from 'svelte/store';
import { editing } from './edit_mode.js';
import {
  getDesign, tierView, beginHistoryFrame, commitHistoryFrame, cancelHistoryFrame, recordEditEntry,
  setTierFacetStates, tierFacetState, setDesignLock, syncToolbar, designLocked,
} from './tier_controller.js';
import { setLocalHistory, syncUndoMenu } from './session.js';
import { budgetedTask } from './work_budget.js';
import { createGaugeHistory } from './scale_height.js';
import { INITIAL_STEPS, rotatedStates, wrapSteps } from './rotate_index.js';

/** True while rotate by index mode is open. */
export const rotateIndexOpen = writable(false);

/** The slider's turn in whole teeth, as the panel shows it (0 = the design the mode opened on). */
export const rotationSteps = writable(INITIAL_STEPS);

/** The gear's tooth count the open session turns on (the slider's range comes from it), or null. */
export const rotationTeeth = writable(null);

/** Added to every tier toolbar button's tooltip while this mode holds the design. */
export const FINISH_ROTATING_TIP = ' Finish rotating the design first: Done, or Cancel.';

/** The label of the one history entry Done records. */
export const ROTATE_LABEL = 'Rotate by index';

// The open session, or null: the design it opened on, its gear's tooth count, every tier's facets
// and indexes as they stood then (`pristine`, what every slider position is computed from and what
// Cancel puts back), and the slider's own undo stack.
let session = null;

setDesignLock(() => session !== null, FINISH_ROTATING_TIP);

// The toolbar follows the mode opening and closing, as it follows the other modes'.
rotateIndexOpen.subscribe(() => syncToolbar());

/** The local stack as session.js's Undo and Redo see it while the mode is open. */
const localStack = {
  canUndo: () => session?.history.canUndo() ?? false,
  canRedo: () => session?.history.canRedo() ?? false,
  undo: () => showSteps(session?.history.undo() ?? null),
  redo: () => showSteps(session?.history.redo() ?? null),
};

/**
 * Opens rotate by index mode on the loaded design, the slider at 0. Does nothing, and returns
 * false, with no design loaded, while edit mode is open, or while this or another whole-design
 * mode is open.
 */
export function enterRotateIndexMode() {
  const design = getDesign();

  // `designLocked()` is true while this mode is open too, so it also refuses a second opening.
  if (designLocked() || get(editing) !== null || !design) {
    return false;
  }

  beginHistoryFrame();
  session = {
    design,
    teeth: design.gear.teeth,
    pristine: design.tiers.map(tier => ({ tier, state: tierFacetState(tier) })),
    // A turn is one whole number, so two states are the same exactly when they are equal.
    history: createGaugeHistory(INITIAL_STEPS, (a, b) => a === b),
  };
  rotationSteps.set(INITIAL_STEPS);
  rotationTeeth.set(session.teeth);
  rotateIndexOpen.set(true);
  setLocalHistory(localStack);
  window.gemRequestRender?.();
  return true;
}

/** Done: keeps the turned design, as ONE entry in the edit history, and closes the mode. */
export function exitRotateIndexMode() {
  if (session === null) {
    return;
  }

  // Whatever a drag still had queued is written now, in full.
  writer.cancel();
  writeDesign(false);

  // Every tier whose teeth moved, as the same `tierFacets` update the sub bar's ruler records in
  // edit mode, so undo and redo replay them through `applyEdit` with no new kind of op, in one
  // entry and one rebuild. Nothing moved (the slider back at 0, or a whole turn) records nothing.
  const ops = [];

  for (const { tier, state } of session.pristine) {
    const now = tierFacetState(tier);

    if (String(now.indexes) !== String(state.indexes) || now.facets.some((facet, at) => facet !== state.facets[at])) {
      ops.push({ kind: 'update', target: 'tierFacets', tier, before: state, after: now });
    }
  }

  recordEditEntry({ label: ROTATE_LABEL, ops });
  commitHistoryFrame(ROTATE_LABEL);
  close();
}

/**
 * Cancel, and Escape: closes the mode and puts every tier back as it stood when the mode opened,
 * recording nothing.
 */
export function cancelRotateIndexMode() {
  if (session === null) {
    return;
  }

  const { pristine } = session;

  writer.cancel();
  close();
  // Nothing was recorded in the frame (the slider keeps its own stack), so this only closes it.
  cancelHistoryFrame();
  // Forced: the stone on screen may be a quick, mid-drag one even when the design is already back.
  setTierFacetStates(pristine, { force: true });
}

/** Ends the session, whichever way it ends. */
function close() {
  session = null;
  quickOnScreen = false;
  setLocalHistory(null);
  rotateIndexOpen.set(false);
  rotationTeeth.set(null);
  window.gemRequestRender?.();
}

/**
 * The slider moved (RotateIndexPanel): `value` any whole number of teeth (a typed value may be
 * outside the slider, and is wrapped onto it: 96 on a 96-tooth gear is 0), `done` true for a
 * finished change -- a drag's release, a key press, a typed value -- which is one step of the
 * mode's own undo.
 */
export function changeRotation(value, done) {
  if (session === null) {
    return;
  }

  rotationSteps.set(wrapSteps(value, session.teeth));

  if (done) {
    writer.cancel();
    writeDesign(false);

    if (session.history.commit(get(rotationSteps))) {
      syncUndoMenu();
    }
  } else {
    writer.request();
  }
}

/** Undo or redo inside the mode handed back `steps` (null: nothing to step to). */
function showSteps(steps) {
  if (session === null || steps === null) {
    return;
  }

  rotationSteps.set(steps);
  writer.cancel();
  writeDesign(false);
  syncUndoMenu();
}

// ---- writing the design (streamed during a drag, as resize girdle's gauge and edit mode's rulers
// are): each write rebuilds the stone, 300 ms to 2 s on a large design (T-0194), so the newest turn
// waits for a budgeted turn of its own and the slider follows the pointer meanwhile. The same 0.4
// budget.
const WRITE_BUDGET = 0.4;

// True while the stone on screen is a quick, mid-drag rebuild, so the finishing write rebuilds in
// full even when it changes no tier.
let quickOnScreen = false;

const writer = budgetedTask({ run: () => writeDesign(true), budget: WRITE_BUDGET });

/** Writes every tier for the slider's turn as it stands. `quick` mid-drag, as selection.js means it. */
function writeDesign(quick) {
  if (session === null) {
    return;
  }

  setTierFacetStates(rotatedStates(session.pristine, get(rotationSteps), session.teeth),
    { quick, force: !quick && quickOnScreen });
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
