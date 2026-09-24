// The crown/pavilion tier tables' logic (T-0147, ids and layout corrected T-0152, row clicks and
// highlighting added T-0160, drag/keyboard reordering added T-0165, the tier toolbar T-0175):
// what the page's old `wireUpTierTables` did, minus the DOM. Independent of GemApp until a
// design is loaded, like the rest of the instructions pane's shell.
//
// The components (TierTables, TierSection, TierToolbar) draw from the stores below and call the
// functions below from their handlers. What is left DOM-shaped here is the row registry, which
// `highlightTier` and the focus request need to scroll and focus a row.
//
// **Pavilion is rendered above crown** (T-0152, reversing T-0147's order at the user's
// request) -- also the order a stone is actually cut, so the pane reads top to bottom as the
// work is done.
//
// **Rows are keyed by the tier OBJECT, not its generated display id** (T-0165's own
// decision -- the ticket allowed either "key by identity" or "rebuild the id-keyed map after
// every reorder", and identity is the simpler of the two). A reorder renumbers every id in
// its section (moving C3 above C1 makes it C1), so an id-keyed map would need rebuilding on
// every single reorder just to keep row clicks landing on the right tier; a tier's own
// object identity never changes, no matter where it sits in `design.tiers` or what its
// current display id is. The SAME reasoning applies to `facetTierMap` (facet_map.js): it is
// also keyed by tier object, which is exactly what lets a reorder skip re-running the
// geometric facet<->tier matching entirely -- the geometry did not change, only the array
// order did.

import { writable, get } from 'svelte/store';
import { flushSync } from 'svelte';
import { isPavilionTier, splitTiersIntoSections } from './tiers.js';
import { applyGearSnapshot } from './gear.js';
import { commentsOf, sameComments, infoOf, sameInfo } from './comments.js';

/**
 * What the tier tables draw: `hasDesign` (false for the built-in mesh or a plain .obj, which
 * carry none), the two sections' rows as `{ tier, id }`, and `key`, bumped by every `render` so
 * the components rebuild every row from scratch -- as the page always did -- which is what drops
 * a stale open editor or focus, and is how in-place edits to a tier (a flag, a description, its
 * index after a gear change) reach the screen.
 */
export const tierView = writable({ key: 0, hasDesign: false, clickable: false, pavilion: [], crown: [] });

/** The currently selected tier OBJECT, or null. */
export const selectedTier = writable(null);

/**
 * Each toolbar button's state, brought up to date by `syncToolbar` on every selection change.
 * `tip` already carries the "Select a tier first." suffix while the button is inactive. Buttons
 * are `aria-disabled`, not `disabled`, so their tooltips still show (a disabled button gets no
 * mouse events in Chrome); each click handler checks `active` itself.
 */
export const toolbar = writable(null);

/** Which rendered row element belongs to which tier, so `highlightTier` can scroll one. */
const rowsByTier = new Map();

/** Records (or forgets) a tier's row element. Called by the row's action. */
export function registerRow(tier, element) {
  rowsByTier.set(tier, element);
}

export function unregisterRow(tier, element) {
  // Only if it is still this row's own registration: a re-render creates the new row before or
  // after the old one is torn down, and must not lose the new one.
  if (rowsByTier.get(tier) === element) {
    rowsByTier.delete(tier);
  }
}

let currentDesign = null;
let currentOnRowClick = null;

// Where edits are recorded (the session, once GemApp exists), or null before then.
let recordEdit = null;

// How the pane reaches the stone, set by the session once GemApp exists (null before then, when
// there is no stone to reach): `rebuild()` regenerates the mesh from the current design
// (rebuildStoneFromDesign) and `select(tier)` highlights a tier on the stone and in the pane,
// or clears both for null, and `frosted()` re-sends which facets the renderer draws frosted
// (selection.js's syncFrostedFacets, T-0183; a rebuild re-sends them by itself).
let stoneHooks = null;

/** Which of T-0165's two reorder groups a tier belongs to -- the SAME girdle/angle rule
 * `splitTiersIntoSections` uses, so a tier's section here always agrees with which table
 * it is actually drawn in, and a drag can never disagree with that table split. */
export function sectionOf(tier) {
  return isPavilionTier(tier) ? 'pavilion' : 'crown';
}

/**
 * Draws a design (or, for `null`, the honest empty state). Called by the loading code for a
 * fresh design load (dropping any selection, per the existing behaviour), with the design
 * `objTextFromBytes` parsed (or `null` for a plain `.obj`, which carries none) and a callback
 * for a row click -- given the clicked tier object, not its display id -- or `null` to build rows
 * with no click handler at all.
 *
 * The options (`{ preserveSelection, focusTier }`) are for this module's OWN re-renders after a
 * drag or Alt+Arrow move: `preserveSelection` keeps whichever tier was selected before the
 * reorder selected afterwards, under its (possibly new) id, and `focusTier` moves keyboard focus
 * onto a specific tier's row once it exists again, for the Alt+Arrow path.
 */
export function render(design, onRowClick, { preserveSelection = false, focusTier = null } = {}) {
  currentDesign = design;
  currentOnRowClick = onRowClick;

  if (!preserveSelection) {
    selectedTier.set(null);
  }

  if (!design) {
    tierView.update(view => ({
      key: view.key + 1, hasDesign: false, clickable: !!onRowClick, pavilion: [], crown: [],
    }));
    // The rows are drawn now, not at the next microtask: what follows reads them.
    flushSync();
    selectedTier.set(null);
    syncToolbar();
    return;
  }

  const { crown, pavilion } = splitTiersIntoSections(design.tiers);

  tierView.update(view => ({
    key: view.key + 1, hasDesign: true, clickable: !!onRowClick, pavilion, crown,
  }));
  flushSync();

  // A selected tier that is no longer in the design (the redo of a Delete, say) is no longer
  // selected: the toolbar must not act on a tier that has no row.
  if (get(selectedTier) !== null && !rowsByTier.has(get(selectedTier))) {
    selectedTier.set(null);
  }

  syncToolbar();

  const selected = get(selectedTier);

  if (selected !== null && rowsByTier.has(selected)) {
    // A reorder's own re-render: reapply the selection to the tier's NEW row (a fresh
    // element -- the re-render just threw the old one away) without moving the stone's
    // highlighted facets, which have not changed at all -- see the header comment on why
    // facetTierMap does not need rebuilding either. Never auto-scrolls here: the row the user
    // was just dragging (or Alt+Arrow-ing) is already the one on screen.
    highlightTier(selected, { scroll: false });
  }

  if (focusTier !== null && rowsByTier.has(focusTier)) {
    rowsByTier.get(focusTier).focus();
  }
}

/**
 * Sets exactly one row's selected styling, or clears every row when given `null`. The toolbar
 * acts on the selected tier, so its buttons follow every selection change.
 */
export function highlightTier(tier, { scroll = true } = {}) {
  selectedTier.set(tier);

  if (tier !== null && scroll && rowsByTier.has(tier)) {
    // 'nearest': only scrolls if the row is actually out of view, never re-centres a row
    // that is already visible (the user's pane, the user's scroll position).
    rowsByTier.get(tier).scrollIntoView({ block: 'nearest' });
  }

  syncToolbar();
}

/**
 * Scrolls `tier`'s row into view, if it is out of it, without selecting it (T-0234: the cutting
 * assistant's current tier, which is highlighted but is not the selection). 'nearest', as
 * `highlightTier` scrolls: a row already on screen stays where it is.
 */
export function scrollTierIntoView(tier) {
  rowsByTier.get(tier)?.scrollIntoView({ block: 'nearest' });
}

/** The design on show, for the gear dialog and the stone rebuild. */
export function getDesign() {
  return currentDesign;
}

/**
 * Re-renders with whatever design and onRowClick are ALREADY in effect -- the same thing
 * `applyReorder` does for itself -- so a caller that mutated the current design's own tier/facet
 * objects IN PLACE (a tooth-count change: the gear dialog's "apply" step) can redraw the rows
 * without knowing, or needing to re-supply, the onRowClick callback the loading code originally
 * wired up. Mutating in place rather than swapping in a new design object is what keeps every
 * tier/facet OBJECT the same one `facetTierMap` and `rowsByTier` are keyed by -- a gear change
 * never needs either map rebuilt.
 */
export function refresh(options) {
  render(currentDesign, currentOnRowClick, options);
}

/** A row was clicked or activated from the keyboard. */
export function rowClicked(tier) {
  if (rowClickOverride) {
    rowClickOverride(tier);
    return;
  }

  currentOnRowClick?.(tier);
}

export function setEditRecorder(record) {
  recordEdit = record;
}

// ---- the one tier edit mode holds (T-0202)
//
// While a tier is being edited it is the only thing on the page that can be changed (2026-09-19,
// the user: "edit mode is only applied to one tier of facets and only that tier of facets can be
// edited while in edit mode"). That rule is enforced here, at the one place every change to a
// design goes through, rather than at each of the buttons and double clicks that could reach one:
// New and Edit go inactive (`toolbarState`), a reorder and a description edit are refused, and
// edit_mode.js's own `enterEditMode` refuses to swap the tier out from under an open session.
//
// edit_mode.js hands the tier in rather than being imported, because it imports THIS module --
// the same reason the history frames, the stone hooks and the edit finisher are handed in.
let editedTier = () => null;

export function setEditedTier(reader) {
  editedTier = reader;
}

/** The tier edit mode is holding, or null when edit mode is off. */
export function tierBeingEdited() {
  return editedTier();
}

// ---- the whole design held by a mode that rewrites every tier (T-0231, scale height)
//
// Scale height mode recomputes EVERY tier from a snapshot taken when it opened, and its session
// is one entry in the history, recorded on Done. Another edit made while it is open (a Delete, a
// reorder, a description) would land inside that entry, out of reach of the mode's own undo, and
// a tier added or removed under it would be missing from its snapshot. So while it is open the
// whole design is held, the way edit mode holds its one tier: every toolbar button goes inactive
// and says why, and a reorder or a description edit is refused. Registered by
// scale_height_mode.js rather than imported, for the reason `setEditedTier` gives above.
//
// The cutting assistant (T-0234) holds the design too, for a different reason: it walks through a
// cut sequence built from the design as it stood when the mode opened, and never changes it. So
// there can be more than one lock, each a reader and the words added to every toolbar tip while it
// holds (`tip`, which defaults to scale height's). Resize girdle (T-0237) registers a third. Every
// one of these modes, and edit mode, refuses to open while `designLocked()`, which is what keeps
// them one at a time.
const designLocks = [];

export function setDesignLock(reader, tip = undefined) {
  designLocks.push({ reader, tip });
}

/** True while a whole-design mode (scale height, the cutting assistant) holds the design. */
export function designLocked() {
  return designLocks.some(lock => lock.reader());
}

/** What the toolbar's tips add while the design is held: the holding mode's own words. */
function designLockTip() {
  const lock = designLocks.find(each => each.reader());

  return lock?.tip ?? FINISH_SCALING_TIP;
}

// A mode that takes the rows' clicks over (T-0234: in the cutting assistant a click on a tier row
// scrubs to that tier's first facet instead of selecting it), or null. Handed in like the lock.
let rowClickOverride = null;

/** Routes row clicks to `handler(tier)` instead of the loading code's, or back for null. */
export function setRowClickOverride(handler) {
  rowClickOverride = handler;
}

// Whether a click on the stone may pick a facet (T-0234). Not while the cutting assistant shows a
// rough of its own: its facets are not the design's, and the facet <-> tier map belongs to the
// design's stone, so a pick would light facets that are not there. viewport.js asks; the mode
// registers the reader, as with the lock.
let stonePickBlock = () => false;

export function setStonePickBlock(reader) {
  stonePickBlock = reader;
}

/** True while clicks on the stone must not select anything. */
export function stonePickBlocked() {
  return stonePickBlock();
}

export function setStoneHooks(hooks) {
  stoneHooks = hooks;
}

/** Selects `tier` in the instructions and on the stone (edit mode lights the tier it edits). */
export function selectOnStone(tier) {
  if (stoneHooks) {
    stoneHooks.select(tier);
  } else {
    highlightTier(tier);
  }
}

// The edit history's stack frames, given by the session (it owns the history), so edit mode can
// group and cancel what it records without importing the session.
let historyFrames = null;

export function setHistoryFrames(frames) {
  historyFrames = frames;
}

/** Starts a frame: edits recorded from now on are held apart, and Undo cannot reach past it. */
export function beginHistoryFrame() {
  historyFrames?.begin();
}

/** Ends the frame, keeping its edits as ONE entry in the history below. */
export function commitHistoryFrame(label) {
  historyFrames?.commit(label);
}

/** Ends the frame and undoes everything in it, in one rebuild, leaving nothing to redo. */
export function cancelHistoryFrame() {
  historyFrames?.cancel();
}

// Edit mode's hook (edit_mode.js): called as a tier edit is about to be recorded, it removes the
// facets that edit cut away altogether and returns the ops that did it, which join the edit's own
// entry so one undo puts both back.
let editFinisher = null;

export function setEditFinisher(finisher) {
  editFinisher = finisher;
}

/** Whether two facet-object lists hold exactly the same facets, in the same order. */
function sameFacetList(a, b) {
  return a.length === b.length && a.every((facet, at) => facet === b[at]);
}

/**
 * Sets each tier of `target` (a `Map<tier, facets>`, in `pristineOrder`'s relative order) to
 * exactly the facets list it is given there -- dropping a tier left with none from the design,
 * same as before, but now also bringing one back that regains some, which is what lets a cut-away
 * facet return once the plane that swallowed it moves clear of it again (2026-09-22, the user:
 * "I only want these changes temporary until edit mode commits them so if I move f1 away from f2,
 * f2 should come back, even while in edit mode"). Redraws the rows and rebuilds the stone when
 * anything changed. Returns the ops that did it, in the order applied, for the edit history
 * (`applyEdit` replays and inverts them: each is a `tierFacets` update, and a tier whose presence
 * on the design changed is also a Delete- or New-style op).
 *
 * `pristineOrder` is the design's own tier order from before any of this session's edits: since
 * nothing but this function can add or remove a tier while one is being edited (T-0202 locks the
 * selection, and so every other tier op, to the tier being edited), every tier this function has
 * ever seen stays a subsequence of it in the same relative order, which is what lets a returning
 * tier's place be found by counting how many of its `pristineOrder` predecessors are on the
 * design right now, rather than by searching for a nearest neighbour.
 */
export function applyFacetTarget(target, pristineOrder) {
  const ops = [];

  for (const [tier, facets] of target) {
    if (sameFacetList(tier.facets, facets)) {
      continue;
    }

    const before = tierFacetState(tier);

    tier.facets = facets.slice();
    ops.push({ kind: 'update', target: 'tierFacets', tier, before, after: tierFacetState(tier) });
  }

  for (const [tier, facets] of target) {
    const present = currentDesign.tiers.includes(tier);

    if (present && facets.length === 0) {
      const section = sectionOf(tier);
      const op = {
        kind: 'delete',
        target: 'tiers',
        section,
        index: sectionOrder(section).indexOf(tier),
        arrayIndex: currentDesign.tiers.indexOf(tier),
        value: tier,
      };

      applyTierListOp(op);
      ops.push(op);
    } else if (!present && facets.length > 0) {
      const section = sectionOf(tier);
      const before = pristineOrder.slice(0, pristineOrder.indexOf(tier));
      const op = {
        kind: 'insert',
        target: 'tiers',
        section,
        index: before.filter(other => sectionOf(other) === section && currentDesign.tiers.includes(other)).length,
        arrayIndex: before.filter(other => currentDesign.tiers.includes(other)).length,
        value: tier,
      };

      applyTierListOp(op);
      ops.push(op);
    }
  }

  if (ops.length > 0) {
    render(currentDesign, currentOnRowClick, { preserveSelection: true });
    stoneHooks?.rebuild();
  }

  return ops;
}

/** For the gear dialog, whose Apply is recorded in the same history as the tier edits. */
export function recordEditEntry(entry) {
  recordEdit?.(entry);
}

/**
 * Rebuilds `design.tiers` after a drag or Alt+Arrow has decided a new top-to-bottom order
 * for one section's own tiers (T-0165). **The interleaving rule** (the ticket asked for
 * some fixed, stated rule, since the two sections' relative order in the underlying array
 * is otherwise arbitrary): every array slot keeps whichever section it belonged to before
 * the move (`sectionOf`, above); only the slots that belonged to the MOVED tier's own
 * section are refilled, in array order, with `newSectionOrder`. The other section's tiers
 * therefore keep their exact old array slots and relative order untouched -- a pavilion
 * drag can only ever permute pavilion tiers among positions that were already pavilion
 * positions.
 */
export function applyReorder(section, newSectionOrder, focusTier = null) {
  // Not while a tier is being edited (T-0202): a reorder moves tiers the open session is not
  // about, and edit mode is applied to one tier alone. Nor while scale height holds the whole
  // design (T-0231).
  if (!currentDesign || tierBeingEdited() !== null || designLocked()) {
    return;
  }

  // Recorded as the section's own delete and insert (the user's rule, 2026-09-18), not as
  // a diff of the whole array: the interleaving above can shift the other section's tiers
  // relative to this one, so one drag is not always one move of design.tiers, but it is
  // always one move of its own section. Undo replays the ops on the section and writes it
  // back through the same interleaving, which restores the array exactly, since the slots
  // never change section.
  const ops = recordEdit
    ? EditHistory.moveOps(sectionOrder(section), newSectionOrder, { target: 'tiers', section })
    : [];

  writeSectionOrder(section, newSectionOrder);
  render(currentDesign, currentOnRowClick, { preserveSelection: true, focusTier });
  recordEdit?.({ label: 'Move tier', ops });
}

/** The current top-to-bottom order of one section's tiers. */
export function sectionOrder(section) {
  return currentDesign.tiers.filter(tier => sectionOf(tier) === section);
}

// ---- Up/Down: move the selection through the pane's own order (T-0257)
//
// Not a reorder (that is Alt+Arrow, moveTier above, which moves a TIER within its section):
// this only moves which row is selected, the same as clicking a different row, through every
// tier the pane shows, pavilion above crown, in one list. Pure functions, so the picking rule
// is unit-tested without a design, a store or a DOM row in sight; the keyboard handler
// (App.svelte) does nothing but read `tierView`/`selectedTier` and hand them here.

/**
 * Every tier in the pane's own top-to-bottom order -- pavilion above crown, exactly as
 * `tierView` renders the two sections. A hidden tier is still in this list: it stays in the
 * pane, greyed out but selectable, exactly as a click on it still selects it.
 */
export function flatTierOrder(view) {
  return [...view.pavilion, ...view.crown].map(row => row.tier);
}

/**
 * The tier Up/Down should select next, `direction` 1 for Down (the next tier) or -1 for Up
 * (the previous one), within `order` (flatTierOrder's own list, or any list of tier objects in
 * display order). Clamped at each end, like moveTier's reorder: Down on the pane's last tier, or
 * Up on its first, leaves the selection exactly where it was, rather than wrapping to the other
 * end.
 *
 * With nothing selected (or a stale selection no longer in the list -- render() already clears
 * one that leaves the design, so this is a belt-and-braces case, not an expected one), there is
 * no tier to move from: Down starts at the first tier and Up at the last, the same place
 * scanning from that key's own end of the list would first land, like Home/End.
 */
export function adjacentTierSelection(order, selected, direction) {
  if (order.length === 0) {
    return null;
  }

  const at = selected === null ? -1 : order.indexOf(selected);

  if (at === -1) {
    return direction > 0 ? order[0] : order[order.length - 1];
  }

  const next = at + direction;

  return next >= 0 && next < order.length ? order[next] : selected;
}

/** Refills `section`'s slots of design.tiers with `order`, by the interleaving rule above. */
function writeSectionOrder(section, order) {
  let cursor = 0;
  currentDesign.tiers = currentDesign.tiers.map(tier =>
    (sectionOf(tier) === section ? order[cursor++] : tier)
  );
}

/** Stores a tier's edited description, recording the change as an update. */
export function editNotes(tier, value) {
  const edited = tierBeingEdited();

  // Another tier's description is not editable while this one is open (T-0202). A row's editor
  // already only opens on the selected row, and the selection is pinned to the tier being edited
  // (selection.js), so nothing on the page reaches this today; the rule is kept here all the
  // same, where every other "only that tier" check lives.
  if ((edited !== null && edited !== tier) || designLocked()) {
    return;
  }

  const before = tier.cuttingInstructions || '';

  tier.cuttingInstructions = value;

  if (value !== before) {
    recordEdit?.({
      label: 'Edit description',
      ops: [{ kind: 'update', target: 'tierNotes', tier, before, after: value }],
    });
  }
}

/**
 * Saves the design's header and footer comments (the comments dialog's Save), recorded as one
 * undoable update -- the user's own requirement, "once the comments are saved, make them
 * undoable". Nothing is recorded, and nothing written, when the comments come back unchanged,
 * exactly as an unchanged description edit records nothing.
 *
 * The arrays are replaced on the design IN PLACE, keeping the same design object, for the reason
 * the gear dialog's own header states: every map on the page is keyed by the objects inside that
 * design, and swapping in a new one would invalidate them for no reason. The whole `before` and
 * `after` are held on the op rather than a per-line diff -- a comment block is a handful of short
 * lines the person just typed, and `EditHistory.invertOp` swaps `before` and `after` for free, so
 * there is nothing to gain by being cleverer here.
 *
 * Neither the stone nor the tier rows change: a comment is not geometry and is not shown in the
 * tables, so this deliberately rebuilds nothing and re-renders nothing (the same reasoning
 * GearDialog records for a tooth-count change, which also only re-describes the design).
 */
export function setComments(comments) {
  if (!currentDesign) {
    return;
  }

  // The dialog's `<info>` fields (shape, size and RI bounds, T-0214) ride along in the same op
  // rather than in one of their own: they are saved by the same button press, so one Save is one
  // undo step. A caller that passes no `info` leaves the design's own alone.
  const before = { ...commentsOf(currentDesign), info: infoOf(currentDesign) };
  const after = {
    headers: comments.headers.slice(),
    footnotes: comments.footnotes.slice(),
    info: comments.info ? { ...comments.info } : before.info,
  };

  if (sameComments(before, after) && sameInfo(before.info, after.info)) {
    return;
  }

  writeComments(after);
  recordEdit?.({
    label: 'Edit comments',
    ops: [{ kind: 'update', target: 'comments', before, after }],
  });
}

/** Puts a `{ headers, footnotes, info }` onto the loaded design, in place. */
function writeComments(comments) {
  currentDesign.headers = comments.headers.slice();
  currentDesign.footnotes = comments.footnotes.slice();

  if (comments.info) {
    // Merged, not replaced: `design.info` also holds the title, author and date the cut header
    // owns (design.js's `copyInfo`), which this dialog does not edit and must not clear.
    currentDesign.info = { ...(currentDesign.info || {}), ...comments.info };
  }
}

/**
 * Applies recorded tier ops, for undo and redo: a section's deletes and inserts are replayed
 * on that section's order and written back once, a description update sets the text, and a
 * gear update puts back the tooth count and every facet's index (applyGearSnapshot). The
 * selection is kept, as after a drag.
 *
 * The tier toolbar's ops (T-0175) are applied here too, and then finished the way the
 * button itself finishes them (`afterToolbarEdit`): the stone is rebuilt when the set of
 * tiers on it changed, and the tier the op is about is selected. A Delete (and its undo) is
 * a delete (or insert) that carries `arrayIndex` (where the tier sits in design.tiers), which
 * a drag's ops never do; a flag is an update with `target: 'tierFlag'`.
 */
export function applyEdit(ops) {
  const orders = new Map();
  const renderedBefore = renderedTiers();
  // The tier to select once a toolbar op is applied; `undefined` while no op is one.
  let toolbarSelection;
  // True once an op has moved a facet's plane, which needs the stone rebuilt regardless.
  let rebuildAnyway = false;

  for (const op of ops) {
    if (op.target === 'gear') {
      // Also for a plain .obj, where only the sub bar's reading changes.
      applyGearSnapshot(currentDesign, op.after);
    } else if (!currentDesign) {
      continue;
    } else if (op.target === 'tiers' && op.arrayIndex !== undefined) {
      // An inserted tier (the undo of a Delete) is selected; a deleted one (its redo) hands
      // the selection to its neighbour, as the Delete button does.
      toolbarSelection = op.kind === 'insert' ? op.value : selectionAfterDeleting(op.value);
      applyTierListOp(op);
    } else if (op.target === 'tiers') {
      const order = orders.get(op.section) || sectionOrder(op.section);
      orders.set(op.section, EditHistory.applyListOp(order, op));
    } else if (op.target === 'tierNotes') {
      op.tier.cuttingInstructions = op.after;
    } else if (op.target === 'comments') {
      // The design's header/footer comments (2026-09-19). Undo and redo both land here, since
      // `EditHistory.invertOp` only swaps `before` and `after` on an update: either way the
      // design ends up holding whichever block of comments that direction asked for.
      writeComments(op.after);
    } else if (op.target === 'tierFlag') {
      op.tier[op.flag] = op.after;
      toolbarSelection = op.tier;
    } else if (op.target === 'tierFacets') {
      // The sub bar's ruler, symmetry, offset or typed list: the tier is cut at other teeth.
      applyTierFacetState(op.tier, op.after);
      toolbarSelection = get(selectedTier);
      rebuildAnyway = true;
    } else if (op.target === 'tierValue') {
      // An edit-mode slider: the facet's plane moved, so the stone always has to be rebuilt,
      // whether or not the set of tiers on it changed.
      op.tier[op.field] = op.after;
      toolbarSelection = get(selectedTier);
      rebuildAnyway = true;
    }
  }

  for (const [section, order] of orders) {
    writeSectionOrder(section, order);
  }

  if (!currentDesign) {
    return;
  }

  if (toolbarSelection !== undefined) {
    afterToolbarEdit(renderedBefore, toolbarSelection, rebuildAnyway);
  } else {
    render(currentDesign, currentOnRowClick, { preserveSelection: true });
  }
}

// ---- The tier toolbar (T-0175): New, Edit, Delete, Show/Hide, Preform, Frosted.
//
// Every button acts on the selected tier and records its change in the edit history, and
// `applyEdit` above replays the same ops for undo and redo, so a button and its undo/redo
// cannot drift apart: both end in `afterToolbarEdit`.
//
// New and Edit also enter edit mode (T-0193); that is TierToolbar.svelte's doing, with the tier
// these return, so this module need not know about edit mode.

/**
 * Each button's tooltip, shown by the Tooltip component from its own `data-tip` (never from the
 * bar or the pane, since the tooltip takes the OUTERMOST data-tip ancestor). Written for the
 * person using the page, like RENDERER_HINTS: what the button does to their design.
 */
const TOOL_TIPS = {
  // T-0181, with edit mode (the user, 2026-09-19: "new tiers are by default, just copied from
  // the tier that it was created from").
  new: 'Adds a copy of the selected tier right after it and starts editing the copy. Undo ' +
    'removes it.',
  // T-0257: Enter, alongside the existing double-click.
  edit: 'Edits the selected tier: the index gear shows its teeth, and the stone shows the ' +
    'cutting plane on one of its facets. Double-clicking a tier or a facet, or pressing Enter, ' +
    'does the same. Done keeps the changes; Cancel or Escape undoes them.',
  // T-0257: Backspace and Delete are both bound to this, matching "Escape does the same"'s
  // phrasing on the mode panels' Cancel buttons -- both keys, since keyboards differ on which
  // one they have (a laptop's Delete is often fn+Backspace, or missing outright).
  delete: 'Deletes the selected tier from the cutting instructions, and its facets from the ' +
    'stone. Undo brings it back. Backspace or Delete does the same.',
  // Show/Hide's tip follows its label: one for each.
  hide: 'Hides the selected tier: it stays in the list, greyed out, but its facets are left ' +
    'off the stone.',
  show: 'Shows the selected tier again: its facets are cut back into the stone.',
  preform: 'Marks the selected tier as a preform, used to set up meetpoints: its teeth are ' +
    'shown in braces {}. It is still cut into the stone as usual. Click again to unmark it.',
  // T-0183 (the user, 2026-09-23: the tip must say the facets are modelled as a rough dielectric
  // surface with single scattering).
  frosted: 'Marks the selected tier as frosted: its angle and teeth get a darker background in ' +
    'the list, and in the Monte Carlo renderer its facets are modelled as a rough dielectric ' +
    'surface with single scattering (a microfacet model), so they look frosted. Click again to ' +
    'unmark it.',
  // The only button here that is about the DESIGN rather than the selected tier (2026-09-19,
  // the user: "a comments button to the instructions menu that opens up a dialog for header and
  // footer comments"), so it needs no selection and never carries SELECT_FIRST_TIP.
  comments: 'Edits the notes printed above and below the cutting instructions -- a GemCad ' +
    'file\'s own header lines and footnotes. Saving them can be undone.',
};

/** Added to Comments' tooltip while no design is loaded, which is why the button is inactive. */
const NO_DESIGN_TIP = ' There is no design loaded to comment on.';

/** Added to a tooltip while no tier is selected, which is why the button is inactive. */
const SELECT_FIRST_TIP = ' Select a tier first.';

/**
 * Added to New's and Edit's tooltips while a tier is being edited, which is why those two are
 * inactive (T-0202). New would move editing onto a fresh copy, which is exactly the swap edit
 * mode no longer allows (the user, asked what New should do while editing: "do nothing while
 * editing"). Edit could only mean the tier already open, since the selection is pinned to it.
 */
const FINISH_EDITING_TIP = ' Finish editing this tier first: Done, or Cancel.';

/**
 * Added to every button's tooltip while scale height holds the whole design, which is why they
 * are all inactive (T-0231; see `setDesignLock`, which takes each mode's own suffix: resize
 * girdle's is in resize_girdle_mode.js).
 */
const FINISH_SCALING_TIP = ' Finish scaling the height first: Done, or Cancel.';

/**
 * Delete's tooltip while the selected tier is the last one of its section, which is why the
 * button is inactive (2026-09-19, the user's request: disable Delete "if theres only one tier
 * left in either the pavilion or the [crown]"). A section is what `sectionOf` says, so a girdle
 * tier counts as a pavilion one, as in the tables.
 */
const LAST_IN_SECTION_TIP = {
  pavilion: ' The pavilion\'s last tier cannot be deleted.',
  crown: ' The crown\'s last tier cannot be deleted.',
};

/** One button's state: active or not, with the tooltip to match. */
function tool(active, tip, extra = {}) {
  return { active, tip: active ? tip : tip + SELECT_FIRST_TIP, ...extra };
}

/** Every button's state for the selected `tier` (null: none selected, all inactive). */
function toolbarState(tier) {
  // "Show" when the selected tier is hidden, "Hide" when it is shown (the user's request,
  // 2026-09-18), and "Hide" while nothing is selected. Runs on every selection change, on
  // the toggle itself and on its undo and redo, since all of them end in highlightTier or
  // render.
  const showing = tier !== null && Boolean(tier.hidden);
  // Hidden tiers count: a hidden tier is still in the list, so deleting the other one leaves a
  // tier to show again.
  const section = tier === null ? null : sectionOf(tier);
  const lastInSection = section !== null && sectionOrder(section).length <= 1;
  // The two buttons that start editing a tier are off while one is already being edited
  // (T-0202). The rest act on the selected tier, which IS the tier being edited, so they stay
  // as they are: Delete, Show/Hide, Preform and Frosted are changes to that one tier, and
  // Comments is about the design's own header and footer rather than any tier.
  const editing = tierBeingEdited() !== null;

  // Scale height holds the whole design (T-0231), and so does the cutting assistant (T-0234): every
  // button off, each saying why, with the labels and pressed states still those of the selected
  // tier so nothing on the bar jumps.
  if (designLocked()) {
    const why = designLockTip();
    const held = tip => ({ active: false, tip: tip + why });

    return {
      new: held(TOOL_TIPS.new),
      edit: held(TOOL_TIPS.edit),
      delete: held(TOOL_TIPS.delete),
      visibility: {
        ...held(showing ? TOOL_TIPS.show : TOOL_TIPS.hide),
        label: showing ? 'Show' : 'Hide',
        ariaLabel: showing ? 'Show the selected tier' : 'Hide the selected tier',
      },
      preform: { ...held(TOOL_TIPS.preform), pressed: tier !== null && Boolean(tier.preform) },
      frosted: { ...held(TOOL_TIPS.frosted), pressed: tier !== null && Boolean(tier.frosted) },
      comments: held(TOOL_TIPS.comments),
    };
  }

  return {
    new: editing
      ? { active: false, tip: TOOL_TIPS.new + FINISH_EDITING_TIP }
      : tool(tier !== null, TOOL_TIPS.new),
    edit: editing
      ? { active: false, tip: TOOL_TIPS.edit + FINISH_EDITING_TIP }
      : tool(tier !== null, TOOL_TIPS.edit),
    delete: lastInSection
      ? { active: false, tip: TOOL_TIPS.delete + LAST_IN_SECTION_TIP[section] }
      : tool(tier !== null, TOOL_TIPS.delete),
    visibility: tool(tier !== null, showing ? TOOL_TIPS.show : TOOL_TIPS.hide, {
      label: showing ? 'Show' : 'Hide',
      ariaLabel: showing ? 'Show the selected tier' : 'Hide the selected tier',
    }),
    // A toggle: pressed while the selected tier is a preform.
    preform: tool(tier !== null, TOOL_TIPS.preform, { pressed: tier !== null && Boolean(tier.preform) }),
    frosted: tool(tier !== null, TOOL_TIPS.frosted, { pressed: tier !== null && Boolean(tier.frosted) }),
    // Comments acts on the DESIGN, not the selected tier, so it reads `currentDesign` directly
    // rather than taking its state from `tier`: every other button here is inactive precisely
    // because nothing is selected, and this one is active the whole time a design is loaded.
    comments: currentDesign
      ? { active: true, tip: TOOL_TIPS.comments }
      : { active: false, tip: TOOL_TIPS.comments + NO_DESIGN_TIP },
  };
}

/**
 * Brings every button up to date with the selected tier, or makes them inactive. Exported for
 * edit_mode.js, which calls it as a session starts and ends: New and Edit depend on whether one
 * is open, and ending one need not re-render the rows (T-0202).
 */
export function syncToolbar() {
  toolbar.set(toolbarState(currentDesign ? get(selectedTier) : null));
}

/** The tiers whose planes cut the stone (GemCadDesign.isRenderedTier), as a set. */
function renderedTiers() {
  return new Set(currentDesign ? currentDesign.tiers.filter(tier => GemCadDesign.isRenderedTier(tier)) : []);
}

/**
 * Finishes a toolbar edit, or its undo or redo: redraws the rows, rebuilds the stone only
 * when the set of tiers on it changed since `renderedBefore` (a Delete or a Show/Hide of a
 * shown tier; not a Delete of a hidden tier, a Preform or a Frosted), re-sends the frosted
 * facets when it did not (a rebuild re-sends them itself), and selects `tier` -- on the stone
 * too, which a rebuild has just cleared, since `load_obj` gives the facets new ids -- or clears
 * the selection for null.
 *
 * The frosted facets are re-sent after EVERY toolbar edit that does not rebuild, not only a
 * Frosted toggle: it is one small upload, and it means no op (nor a future one) can leave the
 * render's mask disagreeing with the flags in the list.
 */
function afterToolbarEdit(renderedBefore, tier, rebuildAnyway = false) {
  selectedTier.set(tier);
  render(currentDesign, currentOnRowClick, { preserveSelection: true });

  const after = renderedTiers();
  const stoneChanged = after.size !== renderedBefore.size ||
    [...after].some(t => !renderedBefore.has(t));

  if (stoneChanged || rebuildAnyway) {
    stoneHooks?.rebuild();
  } else {
    stoneHooks?.frosted?.();
  }

  if (stoneHooks) {
    stoneHooks.select(get(selectedTier));
  } else {
    highlightTier(get(selectedTier));
  }
}

/**
 * Applies a Delete's delete, or its undo's insert, to the design. `op.index` is the tier's place
 * in its SECTION's order, which is what the edit history reasons about (a drag records the
 * same kind of op); `op.arrayIndex` is its place in design.tiers, kept so an undone Delete
 * puts the tier back exactly where it was in the cutting order, not merely next to its
 * section neighbour (the two differ when the other section's tiers are interleaved). The
 * section check runs first and throws on a mismatch, rather than editing the wrong tier.
 */
function applyTierListOp(op) {
  EditHistory.applyListOp(sectionOrder(op.section), op);

  const tiers = currentDesign.tiers.slice();

  if (op.kind === 'insert') {
    tiers.splice(op.arrayIndex, 0, op.value);
  } else {
    if (tiers[op.arrayIndex] !== op.value) {
      throw new Error(`tier toolbar: delete at ${op.arrayIndex} does not match the design`);
    }

    tiers.splice(op.arrayIndex, 1);
  }

  currentDesign.tiers = tiers;
}

/**
 * The tier to select once `tier` is deleted: the selection stays where it was unless it was
 * `tier`, which hands it to the PREVIOUS row of its section, or the next one when it was the
 * first, or to nothing once the section is empty.
 */
function selectionAfterDeleting(tier) {
  const selected = get(selectedTier);

  if (tier !== selected) {
    return selected;
  }

  const order = sectionOrder(sectionOf(tier));
  const at = order.indexOf(tier);

  return order[at - 1] || order[at + 1] || null;
}

/**
 * Delete (T-0177): removes the selected tier from design.tiers, and the stone loses its
 * facets (afterToolbarEdit rebuilds the mesh when the tier was on it). Recorded as a delete
 * on the section's order holding the tier OBJECT, so an undo reinserts the very same object
 * -- its description, flags and facets intact -- at its old place in design.tiers, rebuilds
 * the mesh again and selects it. The selection moves to the previous row of the section, or
 * the next, or clears (selectionAfterDeleting).
 */
function deleteTier() {
  const tier = currentDesign ? get(selectedTier) : null;

  if (tier === null) {
    return;
  }

  const section = sectionOf(tier);
  const op = {
    kind: 'delete',
    target: 'tiers',
    section,
    index: sectionOrder(section).indexOf(tier),
    arrayIndex: currentDesign.tiers.indexOf(tier),
    value: tier,
  };
  const renderedBefore = renderedTiers();
  const next = selectionAfterDeleting(tier);

  applyTierListOp(op);
  afterToolbarEdit(renderedBefore, next);
  recordEdit?.({ label: 'Delete tier', ops: [op] });
}

/**
 * Sets the tier being edited's angle or distance (edit mode's two sliders, 2026-09-19) and shows
 * the result at once: the rows redraw with the new angle, and the stone is rebuilt from the
 * design, since the facet's plane has moved. Called on every step of a drag, so the stone
 * follows the slider; the edit history is told once, on release (`recordTierValue`).
 */
export function setTierValue(tier, field, value, { quick = false } = {}) {
  if (!currentDesign || tier[field] === value) {
    return;
  }

  tier[field] = value;
  render(currentDesign, currentOnRowClick, { preserveSelection: true });
  stoneHooks?.rebuild({ quick });
}

/**
 * Sets many tiers' angles and distances at once (scale height, T-0231: both gauges rewrite every
 * tier of their half), `values` being `[{ tier, angle, distance }]`, then redraws the rows and
 * rebuilds the stone ONCE -- a rebuild per tier would multiply a 300 ms-2 s rebuild (T-0194) by
 * the number of tiers. `quick` as for `setTierValue`. Does nothing, not even a rebuild, when no
 * value actually changed -- unless `force`: a drag's release that lands on the value its last
 * quick write already set still needs the full rebuild a quick one skipped (the facet map and
 * the proportions in the corner).
 */
export function setTierValues(values, { quick = false, force = false } = {}) {
  if (!currentDesign) {
    return;
  }

  let changed = false;

  for (const { tier, angle, distance } of values) {
    if (tier.angle !== angle || tier.distance !== distance) {
      tier.angle = angle;
      tier.distance = distance;
      changed = true;
    }
  }

  if (changed || force) {
    render(currentDesign, currentOnRowClick, { preserveSelection: true });
    stoneHooks?.rebuild({ quick });
  }
}

/** Records a finished slider drag as one update, for undo and redo. */
export function recordTierValue(tier, field, before, after, label) {
  if (before !== after) {
    const cutAway = editFinisher?.(tier) ?? [];

    recordEdit?.({
      label,
      ops: [{ kind: 'update', target: 'tierValue', tier, field, before, after }, ...cutAway],
    });
  }
}

/** A tier's facets and the index each one is cut at, for recording an edit or undoing it. */
export function tierFacetState(tier) {
  return { facets: tier.facets.slice(), indexes: tier.facets.map(facet => facet.index) };
}

/** Puts a tier's facets and their indexes back to a `tierFacetState`. */
function applyTierFacetState(tier, state) {
  tier.facets = state.facets.slice();
  tier.facets.forEach((facet, at) => { facet.index = state.indexes[at]; });
}

/**
 * Cuts the tier being edited at `indices` instead of the teeth it had (the sub bar's ruler,
 * symmetry, offset and typed list, 2026-09-19: "any changes to the ruler ... should also be
 * reflected in the faceting tiers and the faceting angles of the render"). The rows show the new
 * teeth and the stone is recut from them.
 *
 * The tier keeps its own facet OBJECTS, reindexed in order, rather than being given new ones:
 * their names survive, and so does the identity edit mode's guides follow, so moving the ruler
 * slides the cutting plane round the stone instead of dropping it. Facets are added or dropped
 * only when the count changes (a different symmetry, or a longer typed list).
 *
 * Returns true when something changed.
 */
export function setTierIndices(tier, indices, { quick = false } = {}) {
  if (!currentDesign || sameIndexes(tier.facets, indices)) {
    return false;
  }

  tier.facets = indices.map((index, at) => {
    const existing = tier.facets[at];

    if (existing) {
      existing.index = index;
      return existing;
    }

    return { index, name: '' };
  });

  render(currentDesign, currentOnRowClick, { preserveSelection: true });
  stoneHooks?.rebuild({ quick });
  return true;
}

/** Records a settled change of a tier's teeth as one update, for undo and redo. */
export function recordTierFacets(tier, before, after, label = 'Edit indexes') {
  if (String(before.indexes) !== String(after.indexes)) {
    const cutAway = editFinisher?.(tier) ?? [];

    recordEdit?.({
      label,
      ops: [{ kind: 'update', target: 'tierFacets', tier, before, after }, ...cutAway],
    });
  }
}

/**
 * Whether a tier is already cut at exactly `indices`, whatever ORDER either is in.
 *
 * Order, not just membership, would make merely opening edit mode rewrite the tier: the sub bar
 * describes a tier's teeth as a sorted list, while a file writes them in its own cutting order
 * (hex_cut_v2's C1 is "48-32-16-0-80-64"). That rewrite was recorded as an edit, so the first
 * undo after opening a tier undid a change the user never made.
 */
function sameIndexes(facets, indices) {
  if (facets.length !== indices.length) {
    return false;
  }

  const mine = facets.map(facet => facet.index).sort((a, b) => a - b);
  const theirs = [...indices].sort((a, b) => a - b);

  return mine.every((index, at) => index === theirs[at]);
}

/**
 * A copy of `tier` for New: its angle, distance, flags, description and facets (their indexes
 * and names), as new objects, so editing the copy never touches the original.
 */
function copyTier(tier) {
  return { ...tier, facets: tier.facets.map(facet => ({ ...facet })) };
}

/**
 * New (T-0181): inserts a copy of the selected tier right after it, in its section and in
 * design.tiers, and selects it. Recorded as an insert on the section's order holding the new
 * tier OBJECT, the same op a Delete's undo replays, so undo removes it and redo puts the very
 * same object back. The stone looks the same (the copy's planes coincide with the original's,
 * and the mesh builder keeps one of each), but it is rebuilt all the same, since the set of
 * tiers on it changed. Returns the new tier, or null when nothing is selected.
 */
function newTier() {
  const source = currentDesign ? get(selectedTier) : null;

  if (source === null) {
    return null;
  }

  const tier = copyTier(source);
  const section = sectionOf(tier);
  const op = {
    kind: 'insert',
    target: 'tiers',
    section,
    index: sectionOrder(section).indexOf(source) + 1,
    arrayIndex: currentDesign.tiers.indexOf(source) + 1,
    value: tier,
  };
  const renderedBefore = renderedTiers();

  applyTierListOp(op);
  afterToolbarEdit(renderedBefore, tier);
  recordEdit?.({ label: 'New tier', ops: [op] });
  return tier;
}

/**
 * Flips one of the selected tier's flags (`hidden`, `preform` or `frosted`) and records it
 * as an update of that flag on that tier OBJECT, which `applyEdit` replays for undo and
 * redo. afterToolbarEdit then rebuilds the stone if the flag changed which tiers are on it
 * (only `hidden` can) and keeps the tier selected.
 */
function toggleTierFlag(flag, label) {
  const tier = currentDesign ? get(selectedTier) : null;

  if (tier === null) {
    return;
  }

  const before = Boolean(tier[flag]);
  const renderedBefore = renderedTiers();

  tier[flag] = !before;
  afterToolbarEdit(renderedBefore, tier);
  recordEdit?.({
    label,
    ops: [{ kind: 'update', target: 'tierFlag', tier, flag, before, after: !before }],
  });
}

/**
 * What each toolbar button does when clicked, unless it is inactive (the check the page's
 * `toolbarAction` made on the button's `aria-disabled`).
 */
export const toolbarActions = {
  // Returns the new tier (for edit mode), or null when inactive.
  new() {
    return get(toolbar).new.active ? newTier() : null;
  },

  // Returns the tier to edit, or null when inactive. Changes nothing itself.
  edit() {
    return get(toolbar).edit.active ? get(selectedTier) : null;
  },

  delete() {
    if (get(toolbar).delete.active) {
      deleteTier();
    }
  },

  // Show/Hide (T-0178): a hidden tier stays in the list, greyed out, and is left off the stone.
  visibility() {
    if (get(toolbar).visibility.active) {
      const tier = get(selectedTier);

      toggleTierFlag('hidden', tier.hidden ? 'Show tier' : 'Hide tier');
    }
  },

  // Preform (T-0179): the tier's teeth are shown in braces, {4-12-20}, and it is CUT NORMALLY
  // (the user, 2026-09-18: "the teeth need to have the {} and cut it normally"), so toggling
  // it never rebuilds the stone. What the flag is for comes later, in edit mode: a tier that a
  // deeper facet cuts away completely is normally removed from the list, but a preform tier
  // is kept, because its meetpoints are still needed.
  preform() {
    if (get(toolbar).preform.active) {
      toggleTierFlag('preform', get(selectedTier).preform ? 'Unmark preform' : 'Mark preform');
    }
  },

  // Frosted (T-0180): the tier's angle and teeth get a darker background in the list, and (T-0183)
  // the Monte Carlo renderer draws its facets as rough glass. Frosting is a surface finish, not a
  // change to which planes cut the stone, so the flag is not one isRenderedTier reads and toggling
  // it never rebuilds: afterToolbarEdit re-sends the frosted facets to the renderer instead.
  frosted() {
    if (get(toolbar).frosted.active) {
      toggleTierFlag('frosted', get(selectedTier).frosted ? 'Unmark frosted' : 'Mark frosted');
    }
  },
};

/** The keyboard equivalent of a drag (T-0165): moves `tier` one place within its own
 * section, clamped at the ends (no wraparound), and keeps keyboard focus on its row. */
export function moveTier(tier, direction) {
  // The keyboard's half of the reorder, refused for the same reasons (T-0202, T-0231).
  if (!currentDesign || tierBeingEdited() !== null || designLocked()) {
    return;
  }

  const section = sectionOf(tier);
  const order = sectionOrder(section);
  const from = order.indexOf(tier);
  const to = from + direction;

  if (to < 0 || to >= order.length) {
    return;
  }

  order.splice(from, 1);
  order.splice(to, 0, tier);
  applyReorder(section, order, tier);
}

// The initial state is the honest empty state (nothing loaded yet), as the page always started:
// `tierView` above already holds it, and every toolbar button starts inactive. Set here, at the
// end, because `toolbarState` reads TOOL_TIPS, which is declared partway down the module.
toolbar.set(toolbarState(null));
