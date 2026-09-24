// Pointer-based drag-to-reorder of a tier row within its own table (T-0165) -- a Svelte action,
// applied once each to `#pavilion-rows` and `#crown-rows` rather than once per row: the container
// element itself is never replaced (only its row children are, by every render), so wiring it
// here once means a reorder never needs rewiring afterwards.
//
// Pointer events with `setPointerCapture`, not the HTML5 drag-and-drop API: that API has
// poor touch support, and its own ghost image and drop rules fight custom styling (the same
// reason the canvas's own drag, in viewport.js, uses pointer events instead). Native listeners,
// not Svelte's delegated ones, for the same reason as the canvas: pointer capture, and a click
// swallowed in the capture phase.
//
// Because `setPointerCapture` is called on the CONTAINER once a press is recognised as a
// drag, every later pointer event for that pointer id goes to THIS container's own
// listeners regardless of where over the page the pointer physically is -- which is what
// makes "a pavilion row can never be dropped into the crown table" true by construction, not
// just by a check: a drag that started in `#pavilion-rows` can never dispatch so much as a
// pointermove to `#crown-rows`.
//
// The dragged row does not follow the pointer; it just dims (the `dragging` callback drives
// `.tier-row-dragging`) and stays where it was, while a thin accent bar
// (`.tier-row-drop-indicator`) shows where it would land, moved on every pointermove by comparing
// the pointer's Y against each OTHER row's own vertical midpoint. The bar is drawn by the
// component from `dropBefore`, not inserted into the DOM here (the page did that by hand): the
// component owns its children. Dropping calls `onReorder` once with the section's tiers in their
// new top-to-bottom order, and the render that follows rebuilds every row from scratch anyway.
//
//   getTier(row)          the tier a row element represents (`row.__gemTier`, set by the row)
//   dragging(tier|null)   the row being dragged, or null when the drag ends
//   dropBefore(x)         where the bar goes: a tier (before its row), END (after the last), or
//                         null (no bar)
//   onReorder(order)      called once, on drop, with the section's tiers in their new order
//   enabled()             optional: false while no drag may start (a mode holding the design)
//
// **A drag must not also select the row it moved.** Because `setPointerCapture` keeps the
// dragged row as the pointer's target throughout, the browser still fires an ordinary
// 'click' on it right after the drag's pointerup -- exactly the click that would otherwise
// reach the row's own listener and select it. The capturing listener at the bottom swallows
// exactly that one click, and no other: an ordinary press-and-release, which never sets
// `suppressNextClick`, reaches the row unaffected.
//
// The slop constant mirrors the canvas's own drag (CLICK_SLOP_PX in viewport.js) but is kept
// separate.

/** `dropBefore`'s value for "after the last row". */
export const END = Symbol('end');

const CLICK_SLOP_PX = 4;

export function tierRowDragging(container, options) {
  const { getTier } = options;

  let pressRow = null;
  let pressPointerId = null;
  let pressX = 0;
  let pressY = 0;
  let dragging = false;
  let dropBefore = null;
  let suppressNextClick = false;

  function otherRows() {
    return [...container.querySelectorAll('.tier-row')].filter(row => row !== pressRow);
  }

  function positionIndicator(clientY) {
    for (const row of otherRows()) {
      const box = row.getBoundingClientRect();
      if (clientY < box.top + box.height / 2) {
        dropBefore = getTier(row);
        options.dropBefore(dropBefore);
        return;
      }
    }

    dropBefore = END;
    options.dropBefore(END);
  }

  function onpointerdown(event) {
    // Ignore a second finger/button while one press is already being tracked, and any
    // button but the primary one.
    if (event.button !== 0 || pressRow !== null) {
      return;
    }

    // Nor while the rows may not be moved at all (`enabled`, T-0234): the press stays a plain
    // click on the row.
    if (options.enabled && !options.enabled()) {
      return;
    }

    // A press inside an open notes editor never starts a drag: it is ordinary text-field
    // interaction (placing a caret, selecting text), not a row press at all.
    if (event.target.closest('input.value-entry')) {
      return;
    }

    const row = event.target.closest('.tier-row');
    if (!row) {
      return;
    }

    // Deliberately no setPointerCapture and no preventDefault yet -- only once the press
    // exceeds CLICK_SLOP_PX, below, so a plain click leaves the row's own click listener,
    // and the notes span's own click-to-edit listener, completely alone.
    pressRow = row;
    pressPointerId = event.pointerId;
    pressX = event.clientX;
    pressY = event.clientY;
    dragging = false;
  }

  function onpointermove(event) {
    if (pressRow === null || event.pointerId !== pressPointerId) {
      return;
    }

    if (!dragging) {
      if (Math.hypot(event.clientX - pressX, event.clientY - pressY) < CLICK_SLOP_PX) {
        return;
      }

      dragging = true;
      container.setPointerCapture(event.pointerId);
      options.dragging(getTier(pressRow));
    }

    event.preventDefault();
    positionIndicator(event.clientY);
  }

  function endPress(event, commit) {
    if (pressRow === null || event.pointerId !== pressPointerId) {
      return;
    }

    if (dragging) {
      if (container.hasPointerCapture(event.pointerId)) {
        container.releasePointerCapture(event.pointerId);
      }

      const moved = getTier(pressRow);
      // The other rows in their current order, with the dragged one put where the bar was.
      const order = otherRows().map(getTier);
      const at = dropBefore === END || dropBefore === null ? order.length : order.indexOf(dropBefore);

      order.splice(at, 0, moved);

      options.dragging(null);
      options.dropBefore(null);

      if (commit && dropBefore !== null) {
        options.onReorder(order);
      }

      dropBefore = null;
      suppressNextClick = true;
    }

    pressRow = null;
    pressPointerId = null;
    dragging = false;
  }

  const onpointerup = event => endPress(event, true);
  // A cancelled pointer (e.g. the browser takes the gesture over) drops the drag without
  // committing a reorder -- the row stays exactly where it started.
  const onpointercancel = event => endPress(event, false);

  // Capturing (the third argument), so this runs on the way DOWN to the row -- before the
  // row's own click listener ever sees the event -- for exactly the one click a completed
  // drag leaves behind.
  const onclick = event => {
    if (suppressNextClick) {
      suppressNextClick = false;
      event.stopPropagation();
    }
  };

  container.addEventListener('pointerdown', onpointerdown);
  container.addEventListener('pointermove', onpointermove);
  container.addEventListener('pointerup', onpointerup);
  container.addEventListener('pointercancel', onpointercancel);
  container.addEventListener('click', onclick, true);

  return {
    destroy() {
      container.removeEventListener('pointerdown', onpointerdown);
      container.removeEventListener('pointermove', onpointermove);
      container.removeEventListener('pointerup', onpointerup);
      container.removeEventListener('pointercancel', onpointercancel);
      container.removeEventListener('click', onclick, true);
    },
  };
}
