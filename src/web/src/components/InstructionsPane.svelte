<script>
  // Left pane (T-0142, header added T-0145): the cutting instructions for the stone -- what a
  // cutter reads and types into the machine. The cut header, then the pavilion and crown tier
  // tables (T-0147, order and ids corrected T-0152), then the tier toolbar (T-0175) pinned to
  // the pane's bottom edge. See the CSS comment above #instructions-pane for how wide the pane is
  // and why it carries no data-tip.
  import { onMount } from 'svelte';
  import CutHeader from './CutHeader.svelte';
  import TierTables from './TierTables.svelte';
  import TierToolbar from './TierToolbar.svelte';

  let pane;

  onMount(() => {
    // The toolbar is sticky over the bottom of the scrolling pane, so a row scrolled into view
    // with `block: 'nearest'` (highlightTier, when a tier is picked on the stone) would stop
    // right underneath it, hidden. A bottom scroll padding the height of the bar makes the
    // browser treat that strip as out of view. Kept equal to the bar's real height, which
    // grows when its buttons wrap in a narrow pane.
    const toolbar = document.getElementById('tier-toolbar');
    const observer = new ResizeObserver(() => {
      pane.style.scrollPaddingBottom = `${toolbar.offsetHeight}px`;
    });

    observer.observe(toolbar);

    return () => observer.disconnect();
  });
</script>

<div id="instructions-pane" bind:this={pane}>
  <CutHeader />
  <TierTables />
  <TierToolbar />
</div>
