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
  //
  // The point under the pointer (T-0286; the user, 2026-09-28: "when mousing over the tilt
  // performance graph can you show the nearest point's y value"): here, so both graphs have it. Of
  // every point drawn -- each measured tilt of each curve shown, solid or dotted -- the one nearest
  // the pointer on screen is ringed, and its value written beside it in its curve's colour, a
  // dotted curve's in brackets as the readouts write the table's. Only while the pointer is over the
  // graph and the graph is not being measured; it goes when the pointer leaves, even in the tool,
  // whose cursor line stays. On top of what the callers already do with the pointer, not instead.
  import {
    GRAPH_MARGIN, SCREEN_PALETTE, LABEL_FONT_SIZE, graphSvg, poseAtPointer, nearestGraphPoint,
    pointLabel, labelBox,
  } from '../lib/tilt_performance.js';

  let {
    id, samples, range, shown, showTable, cursor = null, busy = false, stale = false,
    label, tip = undefined, onpoint = () => {}, onleave = () => {},
  } = $props();

  let width = $state(0);
  // The pointer's pixel in the graph, `{ x, y }`, while it is over it; else null.
  let hover = $state(null);

  const graph = $derived(width > GRAPH_MARGIN.left + GRAPH_MARGIN.right
    ? graphSvg({
      samples, range, shown, showTable, cursor, width, palette: SCREEN_PALETTE, font: 'inherit',
      mono: 'var(--font-mono)',
    })
    : null);

  // The nearest point, its label's text and its label's box; null when there is nothing to mark.
  const nearest = $derived.by(() => {
    if (!graph || !hover || busy) {
      return null;
    }

    const point = nearestGraphPoint({ samples, range, shown, showTable, width: graph.width }, hover.x, hover.y);

    if (!point) {
      return null;
    }

    const text = pointLabel(point);

    return { point, text, box: labelBox(point, text, graph.width, graph.height), colour: SCREEN_PALETTE[point.key] };
  });

  function pointed(event) {
    if (busy) {
      return;
    }

    const box = event.currentTarget.getBoundingClientRect();

    hover = { x: event.clientX - box.left, y: event.clientY - box.top };
    onpoint(poseAtPointer(event.clientX - box.left, box.width, range));
  }

  function left(event) {
    hover = null;

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
  {#if nearest}
    <!-- The nearest point: a ring on it (hollow for a dotted curve's point, as its line is broken;
         with a dot inside for a solid one's) on a disc of the card's colour that parts it from the
         lines under it, and its value on a card-coloured tag, so it reads over crossing curves. -->
    {@const { point, text, box, colour } = nearest}
    <svg class="tilt-graph-hover" id="{id}-hover" width={graph.width} height={graph.height} aria-hidden="true"
      data-key={point.key} data-table={point.table} data-axis={point.axis} data-angle={point.angle}
      data-x={point.x.toFixed(2)} data-y={point.y.toFixed(2)}>
      <circle cx={point.x} cy={point.y} r="6.5" style:fill={SCREEN_PALETTE.surface} />
      <circle cx={point.x} cy={point.y} r="5" style:fill="none" style:stroke={colour} style:stroke-width="1.5" />
      {#if !point.table}
        <circle cx={point.x} cy={point.y} r="2.5" style:fill={colour} />
      {/if}
      <rect x={box.x + 0.5} y={box.y + 0.5} width={box.width - 1} height={box.height - 1} rx="4"
        style:fill={SCREEN_PALETTE.surface} style:stroke={colour} style:stroke-width="1" />
      <text class="tilt-graph-hover-value" x={box.x + box.width / 2} y={box.y + box.height / 2}
        text-anchor="middle" dominant-baseline="central"
        style:fill={colour} style:font-size="{LABEL_FONT_SIZE}px">{text}</text>
    </svg>
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

  /* Over the graph, and never in the pointer's way. Overflow shown, so the ring on a point at the
     plot's very edge is whole. */
  .tilt-graph .tilt-graph-hover {
    pointer-events: none;
    overflow: visible;
  }

  .tilt-graph-hover-value {
    font-family: var(--font-mono);
  }
</style>
