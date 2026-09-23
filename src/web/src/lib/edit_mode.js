// Edit mode (T-0193): editing one facet tier, with the cutting plane drawn on one of its facets.
// (A protractor was drawn above the plane too, until the user had it removed later the same day;
// see the head of edit_geometry.js.) The user's brief (2026-09-19): edit mode is triggered by
//   1. a double click on a facet tier in the cutting instructions (TierRow.svelte),
//   2. the Edit button with a tier selected (TierToolbar.svelte),
//   3. creating a new tier with New, copied from the selected one (TierToolbar.svelte),
//   4. a double click on a facet of the stone (viewport.js);
// and when it is, the tier's teeth set the sub bar (loadIndices, with the arbitrary-mode
// fallback), the rendering settings bar is hidden (App.svelte), and the cutting plane is drawn
// (EditOverlay.svelte) on the tier's starting facet, or on the clicked one for trigger 4. The
// stone is not turned.
//
// ONE TIER AT A TIME, AND ONLY THAT TIER (T-0202, 2026-09-19, the user: "when im in edit mode, i
// dont want want to be able to change which facet im editing, just lock me in the current facet",
// and, asked which of the several ways in to block: "i want something more systematic - edit mode
// is only applied to one tier of facets and only that tier of facets can be edited while in edit
// mode"). So while a session is open:
//   * none of the four triggers above can swap the tier -- `enterEditMode` refuses outright;
//   * the cutting plane stays on the facet the session opened on (`writeIndices`);
//   * New and Edit are inactive, and a reorder or another tier's description is refused
//     (tier_controller.js, which this hands the open tier to with `setEditedTier`);
//   * the selection cannot leave the tier either, which was already true (selection.js).
// What is still editable is that one tier: its angle, its depth, its teeth, its flags, its
// description, and Delete, which removes it and ends the session with it.
//
// Leaving it, two ways (2026-09-19, the user: "move the done button to the bottom of the edit mode
// menu and add a cancel button too (that does the same thing as hitting escape). make sure all the
// changes done in edit mode are undone after hitting cancel"):
//   Done      keeps what was edited (`exitEditMode`);
//   Cancel    or Escape: undoes everything edited since edit mode began (`cancelEditMode`).
// The tier going away (a Delete, an undo of New, another stone loaded) also leaves it, keeping
// whatever state the design is then in.
//
// Edits also remove facets (2026-09-19, the user: "if you took the faceting plane for each of the
// facets in the tier that are changing and bisected the space with each of those planes, if any of
// the facets in the rock are completely enclosed by that space the facet should be removed from the
// facet tier"; "this should also be undone when i hit escape or cancel"). And bring them back
// (2026-09-22, the user: "I only want these changes temporary until edit mode commits them so if
// I move f1 away from f2, f2 should come back, even while in edit mode") -- so a facet's removal
// lasts only as long as the plane keeps swallowing it, not the whole session. See `cutAwayBy`.

import { writable, get } from 'svelte/store';
import { gearTeeth } from './gear.js';
import {
  loadIndices, rulerIndex, rulerSymmetry, rulerOffset, rulerDragging, indexMode, arbitraryIndices,
  highlightedIndices, symmetryFits,
} from './index_ruler.js';
import {
  tierView, getDesign, setTierIndices, recordTierFacets, tierFacetState, beginHistoryFrame, commitHistoryFrame, cancelHistoryFrame,
  setEditFinisher, applyFacetTarget, setTierValue, selectOnStone, setEditedTier, syncToolbar,
} from './tier_controller.js';
import { startingFacet, rockShape, shownFacets, cutAwayFacets } from './edit_geometry.js';
import { budgetedTask } from './work_budget.js';

/** The tier and facet being edited, `{ tier, facet }` (the design's own objects), or null. */
export const editing = writable(null);

/**
 * True while one of the edit bar's scales is being dragged (2026-09-19). What it is for: the
 * guides then measure the rock from the shape built before the drag rather than rebuilding it
 * from the design on every pointer move, which costs about half a second.
 */
export const editDragging = writable(false);

// How the rest of the page asks "is a tier being edited, and which one" (T-0202): the tier
// controller's `tierBeingEdited`, which every "only that tier" check reads. Registered rather
// than imported, because tier_controller.js cannot import this module -- this one imports it.
setEditedTier(() => get(editing)?.tier ?? null);

// New and Edit are inactive while a session is open, so the toolbar has to be brought up to date
// when one starts and ends -- ending one (Done) does not otherwise redraw the rows. Fires once on
// subscribe with nothing being edited, which is the state the toolbar already starts in.
editing.subscribe(() => syncToolbar());

// What edit mode began with, for Cancel and for the facets an edit cuts away: the tier's own angle
// and depth of cut, and the facets that had no polygon on the stone.
let entry = null;

/**
 * Enters edit mode on `tier`, with the guides on `facet`, or on the tier's starting facet (its
 * lowest index) when none is given. Does nothing, and returns false, for a tier that is not in
 * the loaded design or has no facets -- or while a tier is already being edited.
 */
export function enterEditMode(tier, facet = null) {
  const design = getDesign();

  // ONE TIER, AND IT CANNOT BE SWAPPED (T-0202, 2026-09-19, the user: "when im in edit mode, i
  // dont want want to be able to change which facet im editing, just lock me in the current
  // facet", and "edit mode is only applied to one tier of facets and only that tier of facets
  // can be edited while in edit mode").
  //
  // This used to finish the open session and start another, so a double click on the stone or
  // on another row moved editing to whatever was clicked -- including in the middle of a drag,
  // and carrying the sub bar and the cutting plane with it. Every way in (the two double
  // clicks, the Edit button, New) reaches this function, so refusing here is the whole of the
  // rule; Done, Cancel or Escape ends the session first. Returning false is what makes the
  // stone's double click fall back to doing nothing rather than turning (viewport.js).
  if (get(editing) !== null) {
    return false;
  }

  if (!design || !design.tiers.includes(tier) || tier.facets.length === 0) {
    return false;
  }

  loadIndices(tier.facets.map(each => each.index), get(gearTeeth));
  beginHistoryFrame();
  entry = {
    tier,
    angle: tier.angle,
    distance: tier.distance,
    neverShown: facetsNotShown(design),
    // The design's own tier order and every tier's facets, both as they stood when the
    // session opened: `cutAwayBy` recomputes the cut away set against these each time rather
    // than against whatever a previous settle left the design in, which is what lets a facet
    // come back once the plane no longer swallows it (see `cutAwayBy`).
    pristineOrder: design.tiers.slice(),
    pristineFacets: new Map(design.tiers.map(each => [each, each.facets.slice()])),
  };
  editing.set({ tier, facet: facet && tier.facets.includes(facet) ? facet : startingFacet(tier) });
  // The tier being edited is the selection, and stays so (selection.js).
  selectOnStone(tier);
  // Hiding the settings panel resizes the canvas, which needs a new frame at the new size; the
  // frame also draws the guides.
  window.gemRequestRender?.();
  return true;
}

/** Leaves edit mode, if it is on, keeping the edits (Done): the settings panel comes back. */
export function exitEditMode() {
  if (get(editing) !== null) {
    settlePending();
    // The whole of the edit mode's work becomes one entry in the history.
    commitHistoryFrame('Edit tier');
    editing.set(null);
    entry = null;
    window.gemRequestRender?.();
  }
}

/**
 * Leaves edit mode and undoes everything done in it (Cancel and Escape): the tier's angle and
 * depth, its teeth, and the facets those edits cut away all go back to what they were when edit
 * mode began. Done by unwinding the edit history to where it stood then, in one rebuild, so the
 * undone edits are not left to redo. What the sliders were doing when this was pressed (a drag
 * not yet released is written but not recorded) is put back from the values kept at entry.
 */
export function cancelEditMode() {
  const session = get(editing);
  const began = entry;

  if (session === null) {
    return;
  }

  // Recorded first, so it is undone with the rest rather than left behind.
  settlePending();
  // Off before the undo, whose redraws would otherwise find the tier being edited changed under
  // them and end edit mode themselves.
  editing.set(null);
  entry = null;
  editDragging.set(false);

  if (began !== null) {
    cancelHistoryFrame();

    // A drag that was still under the pointer wrote its value without recording it.
    if (getDesign()?.tiers.includes(began.tier)) {
      setTierValue(began.tier, 'angle', began.angle);
      setTierValue(began.tier, 'distance', began.distance);
    }
  }

  window.gemRequestRender?.();
}

/**
 * Anything the sub bar changed and has not settled yet is written and recorded now. Covers the
 * ruler's tape still being under the pointer too (2026-09-19, a bug report: cancelling then kept
 * a drag that was still in progress, with nothing to undo it): `restartSettle` deliberately leaves
 * `settleTimer` at 0 for as long as `rulerDragging` holds, so a run of unsettled writes can be
 * sitting in `undoFrom`/`queuedIndices` with no timer to catch here. Settling regardless of the
 * timer, whenever there is such a run, writes and records it like any other settle, so Cancel's
 * `cancelHistoryFrame()` has an edit to invert instead of an already-applied write it never sees.
 */
function settlePending() {
  if (settleTimer !== 0) {
    clearTimeout(settleTimer);
    settle();
  } else if (undoFrom !== null) {
    settle();
  }
}

// ---- facets an edit cuts away (2026-09-19)

/** The design's facets that have no polygon on the stone as it is now. */
function facetsNotShown(design) {
  const missing = new Set();

  try {
    const shown = shownFacets(design, rockShape(design));

    for (const tier of design.tiers) {
      for (const facet of tier.facets) {
        if (!shown.has(facet)) {
          missing.add(facet);
        }
      }
    }
  } catch (cause) {
    // A design that does not build has no polygons to lose; nothing is cut away from it.
    for (const tier of design.tiers) {
      tier.facets.forEach(facet => missing.add(facet));
    }
  }

  return missing;
}

/**
 * Called as an edit of the tier being edited is recorded: sets the design's other tiers to
 * exactly the facets a cut this deep and this angled leaves them, and returns the ops that did
 * it, so the same history entry undoes them. A facet counts as cut away when it showed on the
 * stone when edit mode began and shows no longer (see edit_geometry.js's `cutAwayFacets`); a
 * design that will not build changes nothing.
 *
 * Recomputed from `entry.pristineFacets` -- the tiers as they stood when edit mode began -- every
 * time, rather than filtered down from whatever the previous call left behind: a facet only
 * `cutAwayFacets` can see is a facet still in `tier.facets`, so a plane that swallowed one facet
 * and has since moved clear of it needs that facet put back before the check can find it showing
 * again. This is what makes a cut-away facet's removal last no longer than the plane keeps
 * swallowing it -- gone the instant a settle finds it swallowed, back the instant one does not --
 * rather than only as long as the whole session (2026-09-22, the user: "I only want these changes
 * temporary until edit mode commits them so if I move f1 away from f2, f2 should come back, even
 * while in edit mode").
 */
function cutAwayBy(tier) {
  const design = getDesign();

  if (entry === null || entry.tier !== tier || !design) {
    return [];
  }

  const liveOrder = design.tiers.slice();
  const liveFacets = new Map(liveOrder.map(each => [each, each.facets.slice()]));

  // Every other tier back to its pristine facets, so the rock below is built from the design's
  // whole original set -- a facet earlier cut away has to be there to be found showing again.
  design.tiers = entry.pristineOrder.slice();

  for (const each of design.tiers) {
    if (each !== tier) {
      each.facets = entry.pristineFacets.get(each).slice();
    }
  }

  let gone;

  try {
    const shownNow = shownFacets(design, rockShape(design));

    gone = cutAwayFacets(design, tier, shownNow, entry.neverShown);
  } catch (cause) {
    gone = null;
  }

  // Back to how the design stood a moment ago; `applyFacetTarget` below is what actually
  // changes it (and records the change), the same as `removeFacets` used to.
  design.tiers = liveOrder;

  for (const [each, facets] of liveFacets) {
    each.facets = facets;
  }

  if (gone === null) {
    return [];
  }

  const target = new Map();

  for (const each of entry.pristineOrder) {
    if (each !== tier) {
      target.set(each, entry.pristineFacets.get(each).filter(facet => !gone.has(facet)));
    }
  }

  return applyFacetTarget(target, entry.pristineOrder);
}

setEditFinisher(cutAwayBy);

// ---- the sub bar cuts the tier being edited (2026-09-19)
//
// The user: "any changes to the ruler (including the symmetry and offset and the tiers in
// arbitrary mode) should also be reflected in the faceting tiers and the faceting angles of the
// render", and "this should also be undoable".
//
// So while a tier is being edited, whatever the sub bar describes IS that tier's list of teeth:
// the ruler's index with its symmetry copies and their offset copies, or, in arbitrary mode, the
// list typed by hand. Each change writes the tier, redraws its row and recuts the stone, and a
// run of changes that then stops is recorded as ONE edit in the history.
//
// Outside edit mode the sub bar changes nothing: there is no tier the change would belong to,
// and silently cutting whichever row happens to be selected is not what was asked for.

/** How long after the last change a run of them counts as settled: one edit in the history. */
const SETTLE_MS = 250;
/** The share of the clock the writes may take; the rest keeps the sub bar under the pointer. */
const WRITE_BUDGET = 0.4;

// The newest list waiting to be written, the state to undo back to, and the timer that decides
// when a run of changes (dragging the ruler, typing a symmetry) has settled into one edit.
let queuedIndices = null;
let undoFrom = null;
let settleTimer = 0;

const writer = budgetedTask({ run: () => writeIndices(true), budget: WRITE_BUDGET });

/** Writes the queued teeth to the tier. `quick` skips the bookkeeping only a settled edit needs. */
function writeIndices(quick) {
  const session = get(editing);

  if (session === null || queuedIndices === null) {
    return;
  }

  // THE PLANE STAYS ON THE FACET THE SESSION OPENED ON (T-0202). This used to move it to
  // whichever tooth the ruler was on, so dragging the ruler slid the cutting plane from facet to
  // facet round the stone; the user asked to be locked to one facet instead. Nothing has to be
  // done to keep it there: `setTierIndices` keeps the tier's own facet OBJECTS and reindexes
  // them, so the facet being edited survives a change of teeth and the plane follows it to its
  // new tooth. Cutting the tier at FEWER teeth can drop it altogether, and the guard at the foot
  // of this file re-points the plane when that happens.
  setTierIndices(session.tier, queuedIndices, { quick });
}

/** The run of changes has stopped: write it in full and record one edit for all of it. */
function settle() {
  const session = get(editing);

  settleTimer = 0;
  writeIndices(false);

  if (session !== null && undoFrom !== null) {
    recordTierFacets(session.tier, undoFrom, tierFacetState(session.tier));
  }

  queuedIndices = null;
  undoFrom = null;
}

/** What the sub bar currently describes, or null when it describes nothing that is a cut. */
function subBarIndices(teeth) {
  if (get(indexMode) === 'arbitrary') {
    // Null while the box holds a refused list, empty while it is empty. Neither is a cut.
    const typed = get(arbitraryIndices);

    return typed && typed.length > 0 ? [...typed] : null;
  }

  const symmetry = get(rulerSymmetry);

  return highlightedIndices(get(rulerIndex), teeth,
    symmetryFits(symmetry, teeth) ? symmetry : 1, get(rulerOffset));
}

/** A sub bar store changed: cut the tier being edited at whatever it now describes. */
function subBarChanged() {
  const session = get(editing);
  const indices = session === null ? null : subBarIndices(get(gearTeeth));

  if (indices === null) {
    return;
  }

  if (undoFrom === null) {
    undoFrom = tierFacetState(session.tier);
  }

  queuedIndices = indices;
  writer.request();
  restartSettle();
}

/**
 * Starts (or restarts) the wait that turns a run of changes into one edit. Not while the ruler's
 * tape is under the pointer: a rebuild can block for longer than the wait, and the timer would
 * then fire the moment the thread came free, splitting one drag into two undos. The tape's
 * release writes the tooth it landed on, which starts the wait for real.
 */
function restartSettle() {
  clearTimeout(settleTimer);
  settleTimer = get(rulerDragging) ? 0 : setTimeout(settle, SETTLE_MS);
}

// Letting go of the tape settles the drag, even when it landed on the tooth it started from and
// so wrote nothing.
rulerDragging.subscribe(held => {
  if (!held && undoFrom !== null) {
    restartSettle();
  }
});

for (const store of [rulerIndex, rulerSymmetry, rulerOffset, indexMode, arbitraryIndices]) {
  // Each fires once on subscribe, before anything is being edited, which `subBarChanged` ignores.
  store.subscribe(subBarChanged);
}

// A tooth count change re-expresses every facet's index (the gear dialog), so there the sub bar
// is read back FROM the tier rather than written to it: the ruler's own number means a different
// tooth on the new gear.
gearTeeth.subscribe(teeth => {
  const session = get(editing);

  if (session !== null) {
    queuedIndices = null;
    loadIndices(session.tier.facets.map(facet => facet.index), teeth);
  }
});

// Every redraw of the tier rows (an edit, an undo or redo, a new stone) checks that what is being
// edited is still there.
//
// A SESSION IS ABOUT ITS TIER, AND ENDS WITH IT (T-0202). The tier going -- deleted, undone,
// another stone loaded, or cut away to nothing -- is the one thing that ends edit mode from the
// outside. The FACET the cutting plane sits on going is not: cutting the tier at fewer teeth (a
// smaller symmetry, a shorter typed list) drops facets from the end of its list, and if the plane
// happened to be on one of those, edit mode used to close itself in the middle of a ruler drag.
// The plane moves to the tier's starting facet instead and the session carries on.
tierView.subscribe(() => {
  const session = get(editing);
  const design = getDesign();

  if (session === null) {
    return;
  }

  if (!design || !design.tiers.includes(session.tier) || session.tier.facets.length === 0) {
    exitEditMode();
    return;
  }

  if (!session.tier.facets.includes(session.facet)) {
    editing.set({ tier: session.tier, facet: startingFacet(session.tier) });
  }
});
