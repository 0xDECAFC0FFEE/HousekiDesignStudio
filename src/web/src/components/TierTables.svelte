<script>
  // The crown/pavilion tier tables (T-0147, ids and layout corrected T-0152): a Pavilion section
  // and a Crown section, one row per tier. **Pavilion is above crown** (T-0152, reversing
  // T-0147's order at the user's request) -- also the order a stone is actually cut, so the pane
  // reads top to bottom as the work is done. Both sections are filled from the same code path
  // whether or not a design is loaded, so the honest empty state and a real design's rows cannot
  // drift apart.
  import { onMount } from 'svelte';
  import { tierView } from '../lib/tier_controller.js';
  import TierSection from './TierSection.svelte';

  let tables;

  /** Lines of text in an element, from its height and its own line height. */
  function lineCount(element) {
    return Math.round(element.getBoundingClientRect().height /
      parseFloat(getComputedStyle(element).lineHeight));
  }

  /**
   * Moves every row's description below its indices when any tier's indices would wrap past
   * two lines in the one-row layout (the user's request, 2026-09-18), and back when none
   * would (see the `.tier-notes-below` CSS). Measured in the one-row layout itself -- the
   * class is taken off first -- since the notes-below layout gives the indices more room, and
   * measuring in it would never switch back. Run after every render and whenever the pane's
   * width changes (the resize handle, or the window). The class is set directly on the element:
   * the measurement needs the layout NOW, not at the next render.
   */
  function fitRowLayout() {
    tables.classList.remove('tier-notes-below');
    const tooLong = [...tables.querySelectorAll('.tier-indices')].some(cell => lineCount(cell) > 2);
    tables.classList.toggle('tier-notes-below', tooLong);
  }

  // After every render (the rows were just rebuilt).
  $effect(() => {
    void $tierView.key;
    fitRowLayout();
  });

  onMount(() => {
    // Width only: the class changes the rows' heights, never the pane's width, so this cannot
    // feed back into itself.
    let observedWidth = null;
    const observer = new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      if (width !== observedWidth) {
        observedWidth = width;
        fitRowLayout();
      }
    });

    observer.observe(document.getElementById('instructions-pane'));

    return () => observer.disconnect();
  });
</script>

<div id="tier-tables" bind:this={tables}>
  <section class="tier-section">
    <h2>Pavilion</h2>
    <TierSection id="pavilion-rows" section="pavilion" />
  </section>
  <section class="tier-section">
    <h2>Crown</h2>
    <TierSection id="crown-rows" section="crown" />
  </section>
</div>
