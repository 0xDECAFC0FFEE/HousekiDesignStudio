<script>
  // Edit > Manual optimizer's grid (T-0273), in the LEFT pane while the mode is open, in place of
  // the cutting instructions (Workspace.svelte stacks the two, as it does tilt performance's
  // panel). The user, 2026-09-28: "the left panel should have a matrix with subdivisions *
  // subdivisions cells, each one with a preview. users can click on a cell to update the center
  // render's crown/pavilion height. users can also highlight some rectangle of cells to update the
  // center cell and the crown/pavilion height range based on the cells' width/heights in the top
  // left cell (representing the tallest gemstone) and the bottom right cell (representing the most
  // squashed gemstone)."
  //
  // Rows are the crown, tallest at the top; columns the pavilion, deepest on the left. Each row's
  // and column's height is written beside it. A cell is a button holding a canvas its picture is
  // painted into (manual_optimizer_mode.js draws them, one at a time, the middle first).
  //
  // The pointer: a press and release on one cell is a click, which shows that cell's heights in
  // the middle. A press on one cell and a release on another selects the rectangle between them
  // (lit while it is dragged out), which re-centres the grid on it.
  //
  // The keyboard (T-0274, manual_optimizer_keys.js): a click on a cell, or Tab, gives the grid the
  // keyboard, on one cell, the cursor. The arrow keys move it, stopping at the edges, and show the
  // cell it lands on in the middle, as a click does (T-0285; the user, 2026-09-28: "lets get rid of
  // enter to update the central render, once users click on the manual optimizer table, arrow keys
  // should move you around the table and update the central render"). Enter and Space do nothing.
  // Shift + arrows grow a rectangle from where the cursor was, lit as a dragged one is, applied when
  // Shift is let go, the middle unchanged until then; Escape drops a rectangle being grown. Every
  // such key stops here, so none reaches the page's own shortcuts. The cursor stays on the cell the
  // middle shows, however it came to be shown: a click, an arrow, a rectangle (its new middle cell),
  // Undo or Redo.
  //
  // Under the grid, the tilt performance graph of the stone in the middle (T-0274; the user,
  // 2026-09-28: "under the grid can you show the face up rocks tilt performance"), Tools > Tilt
  // performance's own graph (TiltGraph.svelte) with every curve and the table's dotted twins, as
  // that tool opens with, and a key giving each curve's face-up value. It is measured once the
  // heights rest (manual_optimizer_mode.js); until the new graph is in, the last one stays, faded.
  // The pointer over it reads the values at the tilt under it, as the tool's does (T-0285; the
  // user: "mousing over the tilt performance graph should show the % at that point"): a line and
  // dots mark the tilt, and the key gives each curve's value there, the table's in brackets. Unlike
  // the tool it does not turn the stone in the middle, which stays as the user left it to judge the
  // heights by, and the key goes back to face up when the pointer leaves.
  import { untrack, tick } from 'svelte';
  import PanelSection from './PanelSection.svelte';
  import TiltGraph from './TiltGraph.svelte';
  import {
    manualOptimizer, optimizerImages, optimizerTilt, optimizerTiltProgress, previewGridCell,
    stepGridCell, selectGridRectangle, setThumbnailSize,
  } from '../lib/manual_optimizer_mode.js';
  import { formatRatio, sameRatios } from '../lib/manual_optimizer.js';
  import { initialKeys, gridKey, clampCell, dropRectangle } from '../lib/manual_optimizer_keys.js';
  import { CURVES, sampleNearest, formatPercent as percent } from '../lib/tilt_performance.js';

  const store = $derived($manualOptimizer);
  const n = $derived(store.state.subdivisions);
  const rows = $derived(Array.from({ length: n }, (_, row) => store.cells[row * n]?.crown ?? 1));
  const columns = $derived(Array.from({ length: n }, (_, column) => store.cells[column]?.pavilion ?? 1));
  const middle = $derived((n - 1) / 2);
  const drawing = $derived(store.open && store.filled < store.total);

  // The grid's own width, and so each cell's: the pictures are drawn at a cell's size in device
  // pixels, so they are sharp and no bigger than they need to be.
  let gridWidth = $state(0);
  const LABEL_WIDTH = 34;
  const GAP = 3;
  const cellCss = $derived(Math.max(8, (gridWidth - LABEL_WIDTH - GAP * (n - 1)) / n));

  $effect(() => {
    if (store.open && gridWidth > 0) {
      setThumbnailSize(cellCss * Math.min(window.devicePixelRatio || 1, 2));
    }
  });

  // The drag in progress: the cell it started on and the one under the pointer, or null.
  let drag = $state(null);
  // The keyboard: the cursor's cell, and the corner a Shift rectangle grows from (or null). It
  // starts on the middle cell, the one the grid is built round.
  let keys = $state(initialKeys({ row: 2, column: 2 }, 5));
  const cursor = $derived(clampCell(keys.cursor, n));
  // A grid of another size (or the mode opening again) puts the cursor back on the middle cell.
  let keysSize = 0;

  $effect(() => {
    if (!store.open) {
      keysSize = 0;
    } else if (n !== keysSize) {
      keysSize = n;
      keys = initialKeys({ row: (n - 1) / 2, column: (n - 1) / 2 }, n);
    }
  });

  let gridElement = $state(null);

  // The cursor follows the cell the middle shows (T-0285), so the next arrow goes on from there:
  // after Undo or Redo, a rectangle (its new middle cell), or a click. Not while a Shift rectangle
  // is being grown, whose far corner the cursor is. If the grid has the keyboard, the focus follows
  // too, so its ring is on the cursor's cell.
  //
  // Driven by the index alone (a derived number, which only wakes this when it changes): the store
  // itself changes with every picture drawn, and snapping the cursor back then would undo an arrow
  // press whose cell is not shown yet (the mode shows it at the next frame).
  const selectedIndex = $derived(store.selected);
  const isOpen = $derived(store.open);

  $effect(() => {
    const selected = selectedIndex;

    if (!isOpen || selected < 0) {
      return;
    }

    untrack(() => {
      const cell = { row: Math.floor(selected / n), column: selected % n };
      const onCursor = store.cells[clampCell(keys.cursor, n).row * n + clampCell(keys.cursor, n).column];

      // Left alone on a cell of the same heights: at a range of 0% every row (or column) is the
      // same, and `selected` is the first of them, not necessarily the one the cursor is on.
      if (keys.anchor || (onCursor && sameRatios(onCursor, store.state.preview))) {
        return;
      }

      keys = { cursor: cell, anchor: null };

      if (gridElement?.contains(document.activeElement)) {
        tick().then(focusCursor);
      }
    });
  });
  // The rectangle being chosen, by the mouse or by Shift + arrows: its two corners.
  const growing = $derived(drag ?? (keys.anchor ? { from: clampCell(keys.anchor, n), to: cursor } : null));

  const selection = $derived(growing && (growing.from.row !== growing.to.row || growing.from.column !== growing.to.column)
    ? {
      top: Math.min(growing.from.row, growing.to.row), bottom: Math.max(growing.from.row, growing.to.row),
      left: Math.min(growing.from.column, growing.to.column), right: Math.max(growing.from.column, growing.to.column),
    }
    : null);

  function inSelection(row, column) {
    return selection !== null && row >= selection.top && row <= selection.bottom &&
      column >= selection.left && column <= selection.right;
  }

  /** The cell under a point of the page, `{ row, column }`, or null. */
  function cellAt(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY)?.closest?.('[data-optimizer-cell]');

    if (!element) {
      return null;
    }

    return { row: Number(element.dataset.row), column: Number(element.dataset.column) };
  }

  function pressed(event, row, column) {
    if (event.button !== 0) {
      return;
    }

    // No text selection or focus ring from a drag across the grid.
    event.preventDefault();
    drag = { from: { row, column }, to: { row, column }, pointer: event.pointerId };
  }

  function moved(event) {
    if (drag === null || event.pointerId !== drag.pointer) {
      return;
    }

    const cell = cellAt(event.clientX, event.clientY);

    if (cell && (cell.row !== drag.to.row || cell.column !== drag.to.column)) {
      drag = { ...drag, to: cell };
    }
  }

  function releasedPointer(event) {
    if (drag === null || event.pointerId !== drag.pointer) {
      return;
    }

    const { from, to } = drag;

    drag = null;

    if (from.row === to.row && from.column === to.column) {
      previewGridCell(from.row, from.column);
      keys = { cursor: from, anchor: null };
    } else {
      selectGridRectangle(from, to);
      keys = { cursor: { row: middle, column: middle }, anchor: null };
    }

    // The grid takes the keyboard, on the cell now shown, so the arrow keys go on from there
    // (T-0285: "once users click on the manual optimizer table, arrow keys should move you around
    // the table"). Focused here, once the pointer is up, not in its pointerdown, whose
    // preventDefault (no text selection or focus while dragging) also keeps the browser from
    // focusing the cell; focusing it there left the ring on a drag's first cell.
    tick().then(focusCursor);
  }

  /**
   * A key down or up on the grid (a cell has the focus): manual_optimizer_keys.js decides, and
   * a key it takes goes no further -- not to the page's own shortcuts (App.svelte's skip a key
   * already handled), not to the browser's scrolling.
   */
  function keyed(event, type) {
    const result = gridKey(keys, {
      type, key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    }, n);

    keys = result.keys;

    if (!result.handled) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (result.action?.kind === 'step') {
      // Shown at the next frame, the last of several arrows by then (the mode's `stepGridCell`).
      stepGridCell(result.action.row, result.action.column);
    } else if (result.action?.kind === 'rectangle') {
      selectGridRectangle(result.action.from, result.action.to);
      // The grid is re-centred on the rectangle: the cursor goes to its new middle, the cell shown.
      keys = { cursor: { row: middle, column: middle }, anchor: null };
    }

    focusCursor();
  }

  /** Gives the cursor's cell the focus, which is what shows it (and where the next key goes). */
  function focusCursor() {
    document.getElementById(`optimizer-cell-${cursor.row}-${cursor.column}`)?.focus();
  }

  /**
   * The focus left the grid (a click on a slider, Tab away): a rectangle half-grown is dropped and
   * the cursor goes back to the cell it grew from.
   */
  function focusLeft(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      keys = dropRectangle({ cursor, anchor: keys.anchor ? clampCell(keys.anchor, n) : null });
    }
  }

  /**
   * An arrow key with nothing focused (the page itself), while the mode is open: it brings the
   * keyboard to the grid, focusing the cursor's cell, so the arrows work without a Tab first. That
   * first arrow only shows the cursor's ring, on the cell the middle shows; it moves and selects
   * nothing (T-0285), so an arrow pressed for some other reason changes no heights. With the mode
   * open nothing else on the page takes a bare arrow key (the cutting instructions' Up and Down
   * are locked out, and a focused slider or text box gets its own keys, not this).
   */
  function documentKey(event) {
    const target = event.target;

    if (!store.open || event.defaultPrevented || !(target === document.body || target === document.documentElement) ||
      !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) ||
      event.altKey || event.ctrlKey || event.metaKey || document.querySelector('[role="dialog"], [role="menu"]')) {
      return;
    }

    event.preventDefault();
    focusCursor();
  }

  /** Paints a cell's picture into its canvas whenever the picture changes. */
  function paint(canvas, image) {
    function draw(next) {
      const context = canvas.getContext('2d');

      if (!next || !next.pixels) {
        context?.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      if (canvas.width !== next.width || canvas.height !== next.height) {
        canvas.width = next.width;
        canvas.height = next.height;
      }

      context.putImageData(new ImageData(next.pixels, next.width, next.height), 0, 0);
    }

    draw(image);

    return { update: draw };
  }

  // ---- the tilt performance graph

  const tilt = $derived($optimizerTilt);
  const SHOWN = { iso: true, cos: true, window: true, head: true };
  // The previous stone's graph while the new one is waited for or measured.
  const tiltStale = $derived(tilt.status === 'waiting' || tilt.status === 'measuring');
  const tiltRunning = $derived(tilt.status === 'measuring' && $optimizerTiltProgress.total > 0);
  // The pose under the pointer, `{ axis, angle }`, or null; only read once the graph shown is the
  // stone's own (a faded graph is the previous stone's).
  let pointer = $state(null);
  const graphCursor = $derived(tilt.status === 'done' ? pointer : null);
  const cursorSample = $derived(graphCursor ? sampleNearest(tilt.samples, graphCursor, tilt.range) : null);
  // The key's values: at the pointer's tilt, else face up (the first sample of the Tilt X half).
  const faceUp = $derived(tilt.samples.x.find(sample => sample.angle === 0)?.measurement ?? null);
  const shownValues = $derived(cursorSample ? cursorSample.measurement : faceUp);

  function curveLabel(key) {
    const curve = CURVES.find(each => each.key === key);

    // As the tool names it: the head shadow curve carries the angle it was measured with.
    return key === 'head' ? `${curve.label} (${Math.round(tilt.headShadow)}°)` : curve.label;
  }

  function cellTip(row, column) {
    const cell = store.cells[row * n + column];

    if (!cell) {
      return '';
    }

    return `Crown ${formatRatio(cell.crown)}, pavilion ${formatRatio(cell.pavilion)}. Click to see it in the middle, then use the arrow keys to move from cell to cell; drag to another cell to zoom the grid in on the cells between.`;
  }
</script>

<svelte:document onpointermove={moved} onpointerup={releasedPointer} onpointercancel={() => { drag = null; }}
  onkeydown={documentKey} />

<div id="optimizer-grid-pane">
  <PanelSection title="Heights" id="optimizer-grid-section">
    {#if store.open}
      <div class="optimizer-axes">
        <span>Crown ↓ flatter</span>
        <span>Pavilion → shallower</span>
      </div>

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div id="optimizer-grid" bind:clientWidth={gridWidth} bind:this={gridElement}
        style:grid-template-columns="{LABEL_WIDTH}px repeat({n}, minmax(0, 1fr))"
        style:gap="{GAP}px" class:optimizer-grid-dragging={drag !== null}
        onkeydown={event => keyed(event, 'down')} onkeyup={event => keyed(event, 'up')}
        onfocusout={focusLeft}>
        <!-- The top-left corner, then each column's pavilion. -->
        <span></span>
        {#each columns as pavilion, column}
          <span class="optimizer-label optimizer-label-column" class:optimizer-label-middle={column === middle}
            id="optimizer-column-{column}">{formatRatio(pavilion)}</span>
        {/each}

        {#each rows as crown, row}
          <span class="optimizer-label optimizer-label-row" class:optimizer-label-middle={row === middle}
            id="optimizer-row-{row}">{formatRatio(crown)}</span>
          {#each columns as _, column}
            {@const index = row * n + column}
            {@const image = $optimizerImages[index]}
            <button type="button" class="optimizer-cell"
              id="optimizer-cell-{row}-{column}" data-optimizer-cell data-row={row} data-column={column}
              class:optimizer-cell-selected={store.selected === index}
              class:optimizer-cell-middle={row === middle && column === middle}
              class:optimizer-cell-in-selection={inSelection(row, column)}
              class:optimizer-cell-stale={image?.stale}
              aria-label="Crown {formatRatio(store.cells[index]?.crown ?? 1)}, pavilion {formatRatio(store.cells[index]?.pavilion ?? 1)}"
              aria-pressed={store.selected === index}
              tabindex={row === cursor.row && column === cursor.column ? 0 : -1}
              data-tip={cellTip(row, column)}
              onpointerdown={event => pressed(event, row, column)}>
              {#if image?.failed}
                <span class="optimizer-cell-failed">Does not build</span>
              {:else}
                <canvas use:paint={image} aria-hidden="true"></canvas>
              {/if}
            </button>
          {/each}
        {/each}
      </div>

      <div class="optimizer-status" id="optimizer-status">
        {#if drawing}
          <span>Drawing {store.filled} of {store.total}…</span>
          <div class="optimizer-progress"><div style:width="{(store.filled / Math.max(1, store.total)) * 100}%"></div></div>
        {:else}
          <span>Click a cell to see it in the middle, then use the arrow keys to move. Drag across cells to zoom in on them.</span>
        {/if}
      </div>
    {/if}
  </PanelSection>

  {#if store.open}
    <div class="tilt-palette">
      <PanelSection title="Tilt performance" id="optimizer-tilt-section">
        <TiltGraph id="optimizer-tilt-graph" label="Tilt performance graph of the stone in the middle"
          samples={tilt.samples} range={tilt.range} shown={SHOWN} showTable={true} cursor={graphCursor}
          busy={tilt.status !== 'done'} stale={tiltStale}
          onpoint={pose => { pointer = pose; }} onleave={() => { pointer = null; }}
          tip="The stone in the middle, tilted 33° each way from face up, as Tools > Tilt performance measures it. A solid line is the whole stone, a dotted one the table alone. Point at it to read the values at that tilt." />

        <div class="optimizer-status" id="optimizer-tilt-status">
          {#if tiltRunning}
            <span>Measuring {$optimizerTiltProgress.measured} of {$optimizerTiltProgress.total}…</span>
            <div class="optimizer-progress"><div style:width="{($optimizerTiltProgress.measured / $optimizerTiltProgress.total) * 100}%"></div></div>
          {:else if tilt.status === 'waiting' || tilt.status === 'measuring'}
            <span>Measuring the stone in the middle…</span>
          {:else if tilt.status === 'failed'}
            <span>The stone could not be measured.</span>
          {:else if tilt.ratios}
            <span>Crown <span class="optimizer-mono">{formatRatio(tilt.ratios.crown)}</span>, pavilion <span class="optimizer-mono">{formatRatio(tilt.ratios.pavilion)}</span>.
              {#if cursorSample}Tilt {graphCursor.axis.toUpperCase()} <span class="optimizer-mono" id="optimizer-tilt-angle">{cursorSample.angle.toFixed(0)}°</span>:{:else}Face up:{/if}</span>
          {/if}
        </div>

        <!-- The key: each curve's colour and its value at the pointer's tilt, or face up, the
             whole stone's then the table's in brackets, as the tool's list shows them. -->
        <div class="optimizer-tilt-key" class:optimizer-tilt-stale={tiltStale}>
          {#each CURVES as { key } (key)}
            <span class="optimizer-tilt-entry" id="optimizer-tilt-{key}">
              <span class="optimizer-tilt-swatch" style:border-color="var(--tilt-{key})"></span>
              <span class="optimizer-tilt-name">{curveLabel(key)}</span>
              <span class="optimizer-tilt-value" id="optimizer-tilt-value-{key}">{percent(shownValues?.stone[key])}</span>
              {#if shownValues?.table}<span class="optimizer-tilt-table-value">({percent(shownValues.table[key])})</span>{/if}
            </span>
          {/each}
        </div>
      </PanelSection>
    </div>
  {/if}
</div>

<style>
  #optimizer-grid-pane {
    width: 100%;
    height: 100%;
    background: var(--panel);
    /* The same hairline, padding and scrolling column as #instructions-pane, whose place it takes. */
    border-right: 1px solid var(--panel-edge);
    padding: var(--pane-pad) var(--pane-pad) 0;
    overflow-y: auto;
  }

  .optimizer-axes {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
    color: var(--muted);
    font-size: 11px;
  }

  #optimizer-grid {
    display: grid;
    align-items: center;
    user-select: none;
    touch-action: none;
  }

  .optimizer-label {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 9px;
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    text-align: center;
  }

  .optimizer-label-column {
    padding-bottom: 3px;
  }

  .optimizer-label-row {
    text-align: right;
    padding-right: 4px;
  }

  .optimizer-label-middle {
    color: var(--text);
  }

  .optimizer-cell {
    position: relative;
    aspect-ratio: 1;
    width: 100%;
    padding: 0;
    border: 1px solid var(--panel-edge);
    border-radius: 4px;
    background: var(--raised);
    overflow: hidden;
    cursor: pointer;
  }

  .optimizer-cell canvas {
    display: block;
    width: 100%;
    height: 100%;
  }

  .optimizer-cell:hover {
    border-color: var(--accent);
  }

  /* The keyboard cursor: a ring in the text colour, so it stands out from the accent border of the
     cell shown and the hover edge, on the light theme's pale pane as on the dark one. It fills the
     gap between two cells exactly (3px). */
  .optimizer-cell:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 1px;
  }

  /* The grid's centre: a dashed edge, the heights the grid is built round. */
  .optimizer-cell-middle {
    border-style: dashed;
    border-color: var(--muted);
  }

  /* The cell the middle shows. */
  .optimizer-cell-selected {
    border: 2px solid var(--accent);
  }

  /* The rectangle being dragged out. */
  .optimizer-cell-in-selection::after {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--hover);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  /* A picture from before the view or a setting changed, until it is redrawn. */
  .optimizer-cell-stale canvas {
    opacity: 0.45;
  }

  .optimizer-cell-failed {
    display: grid;
    place-items: center;
    height: 100%;
    color: var(--muted);
    font-size: 9px;
  }

  .optimizer-grid-dragging .optimizer-cell {
    cursor: crosshair;
  }

  .optimizer-status {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 16px;
    margin-top: 8px;
    color: var(--muted);
    font-size: 11px;
  }

  .optimizer-progress {
    flex: 1;
    height: 2px;
    border-radius: 1px;
    background: var(--panel-edge);
    overflow: hidden;
  }

  .optimizer-progress > div {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
  }

  /* The previous stone's values, until the new ones are measured (the graph fades itself). */
  .optimizer-tilt-stale {
    opacity: 0.4;
  }

  .optimizer-mono {
    font-family: var(--font-mono);
  }

  /* One curve a row, as the tool's own list: two to a row cut the names short in a narrow pane. */
  .optimizer-tilt-key {
    display: grid;
    grid-template-columns: 1fr;
    gap: 4px;
    margin-top: 6px;
    font-size: 11px;
  }

  .optimizer-tilt-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .optimizer-tilt-swatch {
    flex: none;
    width: 12px;
    height: 0;
    border-top: 2px solid;
    border-radius: 1px;
  }

  .optimizer-tilt-name {
    flex: 1;
    min-width: 0;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .optimizer-tilt-value {
    color: var(--accent);
    font-family: var(--font-mono);
    white-space: nowrap;
  }

  /* The table's value, as the tool shows it beside the stone's: in brackets, muted. */
  .optimizer-tilt-table-value {
    min-width: 6ch;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 10px;
    white-space: nowrap;
    text-align: right;
  }
</style>
