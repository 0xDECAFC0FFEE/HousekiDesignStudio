/*
 * tier_shortcuts_test.js -- tests for the tier toolbar's keyboard shortcuts and reordering
 * (T-0257, 2026-09-24): Backspace/Delete deletes the selected tier, Enter edits it, and Up/Down
 * move the selection through the pane's own order (pavilion above crown, as shown). The user's
 * request: New, Delete, Edit, Hide, Preform, Frosted, Comments on one row when the pane is wide
 * enough, else New/Delete/Edit/Hide on one line and Preform/Frosted/Comments on the next, never
 * any other split; and the three shortcuts above, doing exactly what their buttons do (including
 * a button's own refusals and disabled state), never while typing, and never conflicting with an
 * existing key.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * What is tested where:
 * - `adjacentTierSelection` (Up/Down's whole decision) is pure and needs no design at all, so it
 *   is tested directly against hand-built lists of tokens, the same way facet_edit_test.js tests
 *   ruler arithmetic without a ruler.
 * - `flatTierOrder` (the list Up/Down walks) is tested against tier_controller.js's own `render`,
 *   the same entry point a real design load uses, with a hand-built design in place of a loaded
 *   file -- edit_mode_test.js's own pattern.
 * - `editSelectedTier` (what the Enter shortcut, and a tier row's own Enter once selected, both
 *   call) is tested the same way: it must do exactly what clicking Edit does, including doing
 *   nothing when Edit is inactive, since App.svelte's keyboard handler carries no logic of its
 *   own beyond calling it.
 * - The keyboard's OWN guards (never while typing, in a select, or in a dialog; never fighting a
 *   focused button's native Enter) are DOM/event logic with nothing to unit-test headlessly in
 *   Deno; they are checked against the built page over CDP instead (see the ticket's close note).
 * - The CSS breakpoint that turns two rows (4 + 3) into one (7) is a container query with no
 *   JavaScript decision to test; it is checked against the built page over CDP too.
 *
 * `window` is stubbed the same way edit_mode_test.js stubs it: edit mode asks the page for a
 * redraw (`window.gemRequestRender?.()`), and Deno has no such global. Written above the imports
 * to read as a prologue, though ES modules hoist their imports, so it actually runs first anyway
 * because nothing at import time touches `window`, only the functions the tests call.
 */

globalThis.window = globalThis.window ?? {};

import { get } from "svelte/store";
import {
  render, toolbar, highlightTier, flatTierOrder, adjacentTierSelection, tierView,
} from "../src/lib/tier_controller.js";
import { editSelectedTier, editing, exitEditMode } from "../src/lib/edit_mode.js";

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

/**
 * A design of two pavilion tiers and one crown tier, each with one facet (enough for edit mode
 * to accept it -- it refuses a tier with none). Pavilion tiers first in FILE order too, so a test
 * that only reads `design.tiers` directly could not mistake it for `flatTierOrder`'s own
 * pavilion-then-crown reordering by coincidence; the girdle tier is thrown in between the two
 * pavilion tiers, as `hex_cut_v2.gcs` really does, so the pavilion section's own two entries are
 * not adjacent in `design.tiers` either.
 *
 * Fresh objects per test: the stores these modules keep are module-level singletons, so a test
 * that left a tier of its own behind would be seen by the next one.
 */
function threeTierDesign() {
  return {
    tiers: [
      { angle: -41, distance: 0.55, facets: [{ index: 0, name: '' }] }, // P1
      { angle: -90, distance: 0.80, facets: [{ index: 0, name: '' }] }, // G1 (pavilion section)
      { angle: 35, distance: 0.30, facets: [{ index: 0, name: '' }] }, // C1
    ],
  };
}

/** Loads `design` into the tier controller and leaves nothing selected, as a fresh load does. */
function load(design) {
  render(design, null);
  return design;
}

/** Ends any open session and empties the controller, so the next test starts clean. */
function clear() {
  exitEditMode();
  render(null, null);
}

// ---------------------------------------------------------------------------
// adjacentTierSelection: pure, no design needed.

Deno.test("adjacentTierSelection: nothing selected starts at the list's own end for the key pressed", () => {
  // Setup: a plain three-item list -- adjacentTierSelection only ever compares by identity, so
  // these need not be real tiers.
  // Test: ask for Down (direction 1) and Up (direction -1) with nothing selected.
  // Verifies: Down (the ticket's own example) lands on the first item, and Up -- there being no
  // "previous" item to move from any more than there is a "next" one -- lands on the last, the
  // same place scanning from that key's own end of the list would first stop, like Home and End.
  const [a, b, c] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const order = [a, b, c];

  assertEqual(adjacentTierSelection(order, null, 1) === a, true, "Down selects the first tier");
  assertEqual(adjacentTierSelection(order, null, -1) === c, true, "Up selects the last tier");
});

Deno.test("adjacentTierSelection moves one at a time and clamps at both ends, never wrapping", () => {
  // Setup: the same three-item list, selection starting on the middle one.
  // Test: Down, then Down again (now on the last item); Up from the middle, then Up again (now
  // on the first item).
  // Verifies: one step per press; pressing the key that would run off either end of the list
  // leaves the selection exactly where it was, the same clamped-not-wrapped rule moveTier's own
  // Alt+Arrow reorder already uses, rather than cycling back to the other end.
  const [a, b, c] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const order = [a, b, c];

  assertEqual(adjacentTierSelection(order, b, 1) === c, true, "Down from the middle selects the last");
  assertEqual(adjacentTierSelection(order, c, 1) === c, true, "Down on the last tier stays there");

  assertEqual(adjacentTierSelection(order, b, -1) === a, true, "Up from the middle selects the first");
  assertEqual(adjacentTierSelection(order, a, -1) === a, true, "Up on the first tier stays there");
});

Deno.test("adjacentTierSelection on an empty or single-tier list, and a selection not in the list", () => {
  // Setup: an empty list, a one-tier list, and a token that is not in either.
  // Test: every combination of direction and selection.
  // Verifies: an empty list has nothing to select (null, not a thrown error); a single tier
  // clamps to itself either way, same as a two-item list's own ends do; and a selection the list
  // does not contain (defensive -- render() already drops a selection that leaves the design, so
  // this should not arise in practice) is treated the same as no selection at all, rather than
  // throwing on indexOf's -1.
  const lone = { name: 'only' };
  const stray = { name: 'not in the list' };

  assertEqual(adjacentTierSelection([], null, 1), null, "an empty list selects nothing");
  assertEqual(adjacentTierSelection([lone], null, 1) === lone, true, "Down on one tier selects it");
  assertEqual(adjacentTierSelection([lone], lone, 1) === lone, true, "Down on the only tier stays there");
  assertEqual(adjacentTierSelection([lone], lone, -1) === lone, true, "Up on the only tier stays there");
  assertEqual(adjacentTierSelection([lone], stray, 1) === lone, true,
    "a selection not in the list falls back like none selected (Down)");
  assertEqual(adjacentTierSelection([lone], stray, -1) === lone, true,
    "a selection not in the list falls back like none selected (Up)");
});

// ---------------------------------------------------------------------------
// flatTierOrder: pavilion above crown, exactly as tierView renders the two sections.

Deno.test("flatTierOrder lists every tier pavilion-then-crown, not the design's own file order", () => {
  // Setup: threeTierDesign, whose FILE order interleaves a girdle tier between the pavilion's two
  // (P1, G1, C1) -- the same shape hex_cut_v2.gcs has, so this cannot pass by the pavilion and
  // crown tiers already happening to be contiguous in design.tiers.
  // Test: load it and read flatTierOrder off the rendered tierView.
  // Verifies: the flattened order is exactly the pane's own reading order (pavilion section, top
  // to bottom, then the crown section) -- P1, G1, C1 here, all three of design.tiers, none
  // dropped or duplicated -- which is what Down should walk top to bottom through the pane.
  const design = load(threeTierDesign());
  const [p1, g1, c1] = design.tiers;

  const order = flatTierOrder(get(tierView));

  assertEqual(order.length, 3, "every tier is listed once");
  assertEqual(order[0] === p1, true, "the pavilion's own first tier comes first");
  assertEqual(order[1] === g1, true, "the girdle, still part of the pavilion section, comes next");
  assertEqual(order[2] === c1, true, "the crown tier comes last");

  clear();
});

Deno.test("flatTierOrder still lists a hidden tier: it stays in the pane, only greyed", () => {
  // Setup: threeTierDesign with its girdle tier hidden (the tier toolbar's Show/Hide flag).
  // Test: read flatTierOrder again.
  // Verifies: the hidden tier is still in the list, in its usual place -- Show/Hide greys a row
  // out but does not remove it, and a click on it still selects it (kb/page-and-controls.md), so
  // Up/Down must still be able to land on it the same way.
  const design = load(threeTierDesign());
  const [p1, g1, c1] = design.tiers;

  g1.hidden = true;
  render(design, null, { preserveSelection: true });

  const order = flatTierOrder(get(tierView));

  assertEqual(order[0] === p1 && order[1] === g1 && order[2] === c1, true,
    "the hidden tier is still listed, in the same place");
});

// ---------------------------------------------------------------------------
// editSelectedTier: what the Enter shortcut, and a tier row's own Enter once selected, both call.

Deno.test("editSelectedTier does what the Edit button does, and nothing when it is inactive", () => {
  // Setup: threeTierDesign, nothing selected.
  // Test: call editSelectedTier with no selection, then with one, then again while that session
  // is still open.
  // Verifies: with nothing selected -- Edit's own inactive state -- it opens nothing, exactly as
  // clicking a disabled Edit button does nothing; with a tier selected it enters edit mode on
  // that tier, exactly as Edit's own click handler does (toolbarActions.edit() then
  // enterEditMode); and calling it again while that tier is already being edited -- Edit is
  // inactive then too (T-0202) -- leaves the same session open rather than restarting it.
  const design = load(threeTierDesign());
  const [p1] = design.tiers;

  editSelectedTier();
  assertEqual(get(editing), null, "nothing selected: Edit is inactive, so nothing opened");

  highlightTier(p1);
  editSelectedTier();
  assertEqual(get(editing)?.tier === p1, true, "a tier selected: Edit opened it, as its button would");

  editSelectedTier();
  assertEqual(get(editing)?.tier === p1, true, "still editing the same tier: the second call did nothing new");

  clear();
});

// ---------------------------------------------------------------------------
// The tooltips: T-0257 added the shortcut to the two buttons it gave one, matching the mode
// panels' own "Escape does the same" phrasing (EditPanel.svelte's Cancel, for one).

Deno.test("the Delete and Edit tooltips say their keyboard shortcuts, the rest unchanged", () => {
  // Setup: threeTierDesign, a tier selected so both buttons are active (an inactive button's tip
  // carries a DIFFERENT suffix, "Select a tier first.", checked elsewhere; this is about the
  // shortcut sentence itself, which the ticket asked kept regardless of state).
  // Test: read both tooltips off the toolbar store.
  // Verifies: Delete's tip mentions both keys it is bound to; Edit's mentions Enter, alongside
  // the double-click it already documented; and neither tip lost what it already said about
  // undo or what double-clicking does.
  const design = load(threeTierDesign());

  highlightTier(design.tiers[0]);

  const deleteTip = get(toolbar).delete.tip;
  const editTip = get(toolbar).edit.tip;

  assertEqual(deleteTip.includes('Backspace or Delete'), true, `Delete's tip mentions the keys: ${deleteTip}`);
  assertEqual(deleteTip.includes('Undo brings it back'), true, "Delete's tip still explains undo");
  assertEqual(editTip.includes('Enter'), true, `Edit's tip mentions Enter: ${editTip}`);
  assertEqual(editTip.includes('Double-clicking'), true, "Edit's tip still explains the double click");

  clear();
});
