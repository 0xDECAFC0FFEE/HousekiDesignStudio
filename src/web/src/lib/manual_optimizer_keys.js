// Edit > Manual optimizer's grid from the keyboard (T-0274). The user, 2026-09-28: "also can you
// support enter (to select a cell), shift (to refine the center and ranges) and arrow keys when
// navigating around the table"; and later the same day (T-0285): "lets get rid of enter to update
// the central render, once users click on the manual optimizer table, arrow keys should move you
// around the table and update the central render."
//
// Pure: no DOM, no stores. ManualOptimizerGrid.svelte feeds it the grid's key presses and does
// what it answers; web/tests/manual_optimizer_keys_test.js covers it. The keys:
//
//   - The ARROW KEYS move a keyboard cursor (the focused cell) one cell at a time, stopping at the
//     grid's edges rather than wrapping, and SELECT the cell they land on: the middle shows its
//     heights at once, as a click on it does (since T-0285; until then they only moved the cursor
//     and Enter selected). An arrow pointing out of the grid moves nothing and selects nothing.
//   - ENTER and SPACE do nothing on the grid any more (T-0285). They are still taken (handled), so
//     a focused cell's own button behaviour and the page's Enter shortcut never see them.
//   - SHIFT + ARROWS grow a rectangle from the cell the cursor was on when Shift went down, as a
//     spreadsheet selection does, lit exactly as a rectangle dragged with the mouse is. While Shift
//     is held the middle does not change. Letting go of Shift applies it, as letting go of the
//     mouse does: the grid is re-centred on it and the ranges re-derived from its corners
//     (manual_optimizer.js's `selectRectangle`, the same call). A rectangle back on its first cell
//     is nothing.
//   - ESCAPE while a rectangle is being grown drops it without applying it, and puts the cursor
//     back on the cell it grew from (the cell the middle shows). With no rectangle, Escape is left
//     to the page, where it cancels the mode as before.
//
// Every key it handles is `handled: true`, which the grid turns into preventDefault, so the page's
// own shortcuts (App.svelte's, which skip a key already handled) never see it: a mode locks out
// everything else.

/** The arrow keys and the step each takes, `[rows, columns]`. */
const STEPS = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

/** A cell `{ row, column }` held inside a grid of `n` cells a side. */
export function clampCell({ row, column }, n) {
  const clamp = value => Math.min(n - 1, Math.max(0, Math.round(value)));

  return { row: clamp(row), column: clamp(column) };
}

/** The cell one arrow key away from `cell` in a grid of `n`, stopping at the edges (no wrapping). */
export function stepCell(cell, key, n) {
  const [rows, columns] = STEPS[key];

  return clampCell({ row: cell.row + rows, column: cell.column + columns }, n);
}

/** The keyboard's state before any key: the cursor on `cell` (in a grid of `n`), no rectangle. */
export function initialKeys(cell, n) {
  return { cursor: clampCell(cell, n), anchor: null };
}

const sameCell = (a, b) => a.row === b.row && a.column === b.column;

/**
 * One key going down or up, in a grid of `n` cells a side, with the keyboard in state `keys`
 * (`{ cursor, anchor }`: the cursor's cell, and the corner a Shift rectangle grows from, or null).
 *
 * `event` is `{ type: 'down' | 'up', key, shiftKey, altKey, ctrlKey, metaKey }`, as a KeyboardEvent
 * has them. Returns `{ keys, handled, action }`:
 *
 *   keys      the keyboard's state after the key
 *   handled   whether the key was the grid's (the caller prevents its default and its reaching the
 *             page's own shortcuts)
 *   action    null, or what the mode is to do:
 *               { kind: 'step', row, column }        show that cell in the middle, as a click on it
 *                                                    does (the mode's `stepGridCell`)
 *               { kind: 'rectangle', from, to }      as a rectangle dragged from one cell to another
 *
 * While a rectangle is being grown, `keys.anchor` and `keys.cursor` are its two corners, for the
 * grid to light.
 */
export function gridKey(keys, event, n) {
  const none = { keys, handled: false, action: null };
  const cursor = clampCell(keys.cursor, n);
  const anchor = keys.anchor ? clampCell(keys.anchor, n) : null;

  if (event.type === 'up') {
    // Letting go of Shift applies the rectangle, if it spans more than the one cell.
    if (event.key === 'Shift' && anchor) {
      const action = sameCell(anchor, cursor) ? null : { kind: 'rectangle', from: anchor, to: cursor };

      return { keys: { cursor, anchor: null }, handled: true, action };
    }

    return none;
  }

  // A shortcut with Alt, Ctrl or Cmd is not the grid's (Cmd+Z is the mode's own undo).
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return none;
  }

  if (STEPS[event.key]) {
    const next = stepCell(cursor, event.key, n);

    if (event.shiftKey) {
      // The rectangle's first corner is where the cursor was when Shift started it. Nothing is
      // shown in the middle until Shift is let go.
      return { keys: { cursor: next, anchor: anchor ?? cursor }, handled: true, action: null };
    }

    // The cell the cursor lands on is shown in the middle; an arrow against the edge moves nothing
    // and so asks for nothing.
    const action = sameCell(next, cursor) ? null : { kind: 'step', row: next.row, column: next.column };

    return { keys: { cursor: next, anchor: null }, handled: true, action };
  }

  if (event.key === 'Escape') {
    // Drops a rectangle being grown, the cursor back where it started; with none, Escape is the
    // page's (it cancels the mode).
    return anchor ? { keys: { cursor: anchor, anchor: null }, handled: true, action: null } : none;
  }

  if (event.key === 'Enter' || event.key === ' ') {
    // Nothing (T-0285): the arrows already show the cursor's cell. Taken all the same, so the
    // focused cell's button does not also press itself and the page's own Enter stays out.
    return { keys: { cursor, anchor }, handled: true, action: null };
  }

  return none;
}

/**
 * The rectangle half-grown when the grid loses the keyboard (a click elsewhere, Tab away) is
 * dropped, and the cursor goes back to the cell it grew from, as Escape does.
 */
export function dropRectangle(keys) {
  return keys.anchor ? { cursor: keys.anchor, anchor: null } : keys;
}
