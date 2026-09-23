<script>
  // The crown/pavilion tier tables (T-0147, ids and layout corrected T-0152): a Pavilion section
  // and a Crown section, one row per tier. **Pavilion is above crown** (T-0152, reversing
  // T-0147's order at the user's request) -- also the order a stone is actually cut, so the pane
  // reads top to bottom as the work is done. Both sections are filled from the same code path
  // whether or not a design is loaded, so the honest empty state and a real design's rows cannot
  // drift apart.
  //
  // Each section is a PanelSection (2026-09-22, the user: "can you use the same ui element for
  // the pavilion/crown and the material/tracing/lighting sections", then "i want to be able to
  // fold the pavilion and crown"): the render settings' own foldable group, `flush` so the rows
  // run edge to edge of it.
  import { onMount, tick, untrack } from 'svelte';
  import { tierView, selectedTier } from '../lib/tier_controller.js';
  import TierSection from './TierSection.svelte';
  import PanelSection from './PanelSection.svelte';

  let tables;
  let pavilionOpen = $state(true);
  let crownOpen = $state(true);

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

  // After every render (the rows were just rebuilt), and when a section is unfolded: a folded
  // section's rows measure as no lines at all, so the layout is measured again once they show.
  $effect(() => {
    void $tierView.key;
    void pavilionOpen;
    void crownOpen;
    tick().then(fitRowLayout);
  });

  // A tier picked while its section is folded -- a click on the stone, or an undo -- unfolds that
  // section and scrolls to the row, which highlightTier (tier_controller.js) could not do while
  // the row was hidden. Only on a CHANGE of selection: folding the section the selected tier is
  // in must stay folded, and so must a re-render of the rows under it.
  let lastSelected = null;

  $effect(() => {
    const tier = $selectedTier;

    if (tier === lastSelected) {
      return;
    }

    lastSelected = tier;

    if (tier === null) {
      return;
    }

    untrack(() => {
      const inPavilion = $tierView.pavilion.some(row => row.tier === tier);
      const inCrown = $tierView.crown.some(row => row.tier === tier);

      if ((inPavilion && !pavilionOpen) || (inCrown && !crownOpen)) {
        pavilionOpen ||= inPavilion;
        crownOpen ||= inCrown;
        tick().then(() => {
          [...tables.querySelectorAll('.tier-row')].find(row => row.__gemTier === tier)
            ?.scrollIntoView({ block: 'nearest' });
        });
      }
    });
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
  <PanelSection title="Pavilion" flush bind:open={pavilionOpen}>
    <TierSection id="pavilion-rows" section="pavilion" />
  </PanelSection>
  <PanelSection title="Crown" flush bind:open={crownOpen}>
    <TierSection id="crown-rows" section="crown" />
  </PanelSection>
</div>
