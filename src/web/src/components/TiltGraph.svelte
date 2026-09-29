<script>
  // The tilt performance graph as it is drawn on screen, with the pointer read over it (T-0285):
  // one component for both places that show it, Tools > Tilt performance's panel
  // (TiltPerformancePanel.svelte) and the manual optimizer's grid pane (ManualOptimizerGrid.svelte),
  // so the two graphs look and behave alike. The user, 2026-09-28: "mousing over the tilt
  // performance graph should show the % at that point".
  //
  // It draws tilt_performance.js's `graphSvg` at the element's own width in pixels (a fixed viewBox
  // scaled down in a narrow pane would shrink its labels), with a line and a dot on each curve at
  // `cursor`. The pointer over it -- moved, or pressed, which is how a touch screen points -- is
  // turned into the pose under it (`poseAtPointer`) and handed to `onpoint`; leaving the graph calls
  // `onleave`. What a pose means is the caller's: the tool turns the stone in the middle to it and
  // keeps it after the pointer leaves; the optimizer only reads the values off and drops the cursor
  // on leaving. While `busy` (the graph is still being measured) the pointer is ignored, as the tool
  // has always done: a cursor on a graph about to be replaced would read the wrong stone.
  //
  // The readouts (each curve's value at the cursor) stay with the callers, whose layouts differ;
  // both use `sampleNearest` and `formatPercent`.
  import { GRAPH_MARGIN, SCREEN_PALETTE, graphSvg, poseAtPointer } from '../lib/tilt_performance.js';

  let {
    id, samples, range, shown, showTable, cursor = null, busy = false, stale = false,
    label, tip = undefined, onpoint = () => {}, onleave = () => {},
  } = $props();

  let width = $state(0);

  const graph = $derived(width > GRAPH_MARGIN.left + GRAPH_MARGIN.right
    ? graphSvg({
      samples, range, shown, showTable, cursor, width, palette: SCREEN_PALETTE, font: 'inherit',
      mono: 'var(--font-mono)',
    })
    : null);

  function pointed(event) {
    if (busy) {
      return;
    }

    const box = event.currentTarget.getBoundingClientRect();

    onpoint(poseAtPointer(event.clientX - box.left, box.width, range));
  }

  function left(event) {
    // A touch lifted ends as a leave too; the pointer that pressed is the one that left.
    if (!busy) {
      onleave(event);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div {id} class="tilt-graph" role="img" aria-label={label} bind:clientWidth={width}
  class:tilt-graph-busy={busy} class:tilt-graph-stale={stale}
  style:height="{graph?.height ?? 0}px" data-tip={tip}
  onpointermove={pointed} onpointerdown={pointed} onpointerleave={left}>
  {#if graph}
    <svg width={graph.width} height={graph.height} aria-hidden="true">{@html graph.markup}</svg>
  {/if}
</div>

<style>
  .tilt-graph {
    position: relative;
    width: 100%;
    cursor: crosshair;
    touch-action: none;
  }

  /* Pointing reads the graph only once every tilt is measured. */
  .tilt-graph.tilt-graph-busy {
    cursor: progress;
  }

  /* A previous stone's graph, shown until the new one is measured (the manual optimizer's). */
  .tilt-graph.tilt-graph-stale {
    opacity: 0.4;
  }

  .tilt-graph svg {
    display: block;
    position: absolute;
    inset: 0;
  }
</style>
