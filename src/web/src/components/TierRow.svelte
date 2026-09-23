<script>
  // One tier's row: id, angle, cutting indices and notes, all on one line -- four elements in a
  // CSS grid row (`.tier-row { display: grid; grid-template-columns: ... }`), not stacked divs,
  // which is what makes the columns line up from row to row.
  //
  // **The notes element always exists, even when a tier has no cutting instruction**, so every
  // row keeps the same four grid columns; an empty 4th cell keeps the id/angle/indices columns
  // aligned under the row above and below it, where simply omitting the cell would shift
  // whatever came after it (nothing does today, but the next column added later would).
  //
  // A row is clickable (`clickable`, T-0160: single-clicking a row highlights its tier on the
  // stone, same as single-clicking one of its own facets), never a turn -- and Enter/Space on
  // the focused row does the same. Alt+ArrowUp / Alt+ArrowDown (T-0165) is the keyboard
  // equivalent of dragging it one place within its own section.
  //
  // `tier.__gemTier` is stashed on the row element by the `tierRowElement` action, so
  // the drag (tier_drag.js) can read off "which tier does this row represent" from a pointer
  // event's target without a second, separate id-keyed lookup that a renumber would
  // invalidate -- the same reason the rows are keyed by the tier object, not its display id.
  import { get } from 'svelte/store';
  import { selectedTier, rowClicked, moveTier, editNotes, registerRow, unregisterRow } from '../lib/tier_controller.js';
  import { formatTierAngle, formatTierIndex } from '../lib/tiers.js';
  import { angleDecimals } from '../lib/preferences.js';
  import { enterEditMode } from '../lib/edit_mode.js';
  import EditableText from './EditableText.svelte';

  let { tier, id, clickable, dragging = false } = $props();

  // The description is kept on the loaded design's own tier (by OBJECT reference, so it survives
  // a reorder too, and lasts until another stone loads); the row shows a copy it updates as the
  // user types.
  let notes = $state(tier.cuttingInstructions || '');

  /** Records the row element against its tier, for scrolling and focus, and for the drag. */
  function tierRowElement(node) {
    node.__gemTier = tier;
    registerRow(tier, node);

    return { destroy: () => unregisterRow(tier, node) };
  }

  // A double click edits the tier (T-0193, edit mode's first trigger). Its first click has
  // already selected the row. Not on the description: a click there on the selected row opens
  // its editor, and the double click is the user typing into it.
  //
  // While a tier is already being edited this does nothing: `enterEditMode` refuses to swap the
  // tier out from under an open session (T-0202), and Alt+Arrow below is refused for the same
  // reason -- a reorder moves tiers that session is not about.
  function ondblclick(event) {
    if (!event.target.closest('.tier-notes')) {
      enterEditMode(tier);
    }
  }

  function onkeydown(event) {
    // Only keys pressed on the row itself: typing into its description's editor must not
    // select the row on Enter or have its spaces swallowed.
    if (event.target !== event.currentTarget) {
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      // Space's default action is scrolling the pane; a row click never scrolls it.
      event.preventDefault();
      rowClicked(tier);
      return;
    }

    // T-0165: the keyboard equivalent of a drag. Alt distinguishes this from the
    // pane's own scrolling (plain ArrowUp/ArrowDown do nothing special on a row; the
    // browser's default focus/scroll behaviour is left alone for those).
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      moveTier(tier, event.key === 'ArrowUp' ? -1 : 1);
    }
  }
</script>

<!-- A hidden tier (T-0178, the tier toolbar's Show/Hide) stays in the list, numbered and
     selectable, but its whole row is greyed out (the user: "grey out the entire tier when
     its hidden"), and a screen reader hears why. A frosted tier (T-0180) has its angle and
     cutting teeth on a darker background (the user, 2026-09-20: darken the text's background,
     not brighten the text); the stone does not show the frosting yet (T-0183). -->
<div class="tier-row" class:tier-row-hidden={tier.hidden} class:tier-row-frosted={tier.frosted}
  class:tier-row-selected={$selectedTier === tier} class:tier-row-dragging={dragging}
  role={clickable ? 'button' : undefined} tabindex={clickable ? 0 : undefined}
  aria-description={tier.hidden ? 'Hidden: not cut into the stone' : undefined}
  use:tierRowElement onclick={clickable ? () => rowClicked(tier) : undefined}
  ondblclick={clickable ? ondblclick : undefined} onkeydown={clickable ? onkeydown : undefined}>
  <span class="tier-label">{id}</span>
  <span class="tier-angle">{formatTierAngle(tier, $angleDecimals)}</span>
  <!-- Teeth separated by dashes, "4-12-20" (the user's request, 2026-09-18). A <wbr> after each
       dash keeps a long list wrapping between teeth: Unicode's line-breaking rules forbid a break
       between a hyphen and the digit after it, so without one the whole list is a single word
       that `overflow-wrap` would break through the middle of a number.

       A preform tier's teeth are wrapped in curly braces, "{4-12-20}" (T-0179, the user: "adds
       curly braces {} around the cutting teeth"). The tier is still cut normally; the braces
       are how a cutter's sheet marks a tier kept for its meetpoints. -->
  <span class="tier-indices">{#if tier.preform}{'{'}{/if}{#each tier.facets as facet, i}{#if i > 0}-<wbr>{/if}{formatTierIndex(facet.index)}{/each}{#if tier.preform}{'}'}{/if}</span>
  <!-- Many tiers carry no cutting instructions at all (every .asc-parsed tier, in fact --
       gemcad.js's own comment: the ASC path never records them, only the GEM path does), so an
       empty cell (not an omitted one) must read correctly.

       Editable like the author field (the user's request, 2026-09-18), but only once its row
       is selected: the first click on a row selects its tier, and a click on the description
       of the selected row then opens the editor. -->
  <EditableText cls="tier-notes" inputClass="tier-notes-entry text-[11px] md:text-[11px]" value={notes} emptyText="description"
    canEdit={() => get(selectedTier) === tier}
    onwrite={value => { editNotes(tier, value); notes = value; }} />
</div>
