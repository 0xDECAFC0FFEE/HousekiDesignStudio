<script>
  // One section's rows -- `#pavilion-rows` or `#crown-rows` -- one row per tier, or a single muted
  // paragraph (reusing `#instructions-pane p`'s own styling -- see the CSS comment above
  // `#tier-tables`) when there is nothing to show. The built-in stone is a mesh, not a faceting
  // design, so both sections start -- and stay, for as long as no faceting design has been opened
  // -- in the same honest empty state T-0142 established for the whole pane; a design with no
  // tiers in one section (never true of the four bundled samples, but not impossible) gets its
  // own, different message, so "nothing loaded" and "loaded, but empty" do not look the same.
  //
  // Every render rebuilds every row from scratch (`{#key}` on the view's `key`), as the page
  // always did: that drops a stale open editor or focus, and is how an in-place edit to a tier
  // reaches the screen.
  import { tierView, applyReorder } from '../lib/tier_controller.js';
  import { tierRowDragging, END } from '../lib/tier_drag.js';
  import TierRow from './TierRow.svelte';

  let { id, section } = $props();

  const NO_DESIGN_MESSAGE =
    'Not shown yet. Load a GemCad design (.asc or .gem) to see its tiers here.';
  const NO_TIERS_MESSAGE = 'This design has no tiers in this section.';

  let rows = $derived($tierView[section]);
  let message = $derived($tierView.hasDesign ? NO_TIERS_MESSAGE : NO_DESIGN_MESSAGE);

  // The drag's visible state (see tier_drag.js): the row being dragged, and the row the
  // insertion bar sits before (or END). `$state.raw`, because these hold the tier OBJECTS the
  // rows are compared against by identity: a plain `$state` would wrap them in a proxy, which is
  // never `===` the object itself.
  let draggedTier = $state.raw(null);
  let dropBefore = $state.raw(null);

  /** Wires the drag on this section's container. */
  function dragAction(node) {
    return tierRowDragging(node, {
      getTier: row => row.__gemTier,
      dragging: tier => { draggedTier = tier; },
      dropBefore: where => { dropBefore = where; },
      onReorder: order => applyReorder(section, order),
    });
  }
</script>

<div class="tier-rows" {id} use:dragAction>
  {#key $tierView.key}
    {#if rows.length === 0}
      <p>{message}</p>
    {:else}
      {#each rows as row (row.tier)}
        {#if dropBefore === row.tier}<div class="tier-row-drop-indicator"></div>{/if}
        <TierRow tier={row.tier} id={row.id} clickable={$tierView.clickable}
          dragging={draggedTier === row.tier} />
      {/each}
      {#if dropBefore === END}<div class="tier-row-drop-indicator"></div>{/if}
    {/if}
  {/key}
</div>
