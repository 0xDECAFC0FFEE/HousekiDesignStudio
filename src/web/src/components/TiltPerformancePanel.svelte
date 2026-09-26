<script>
  // Tools > Tilt performance's panel (T-0261): Gem Cut Studio's tilt performance graph, in the
  // LEFT pane while the mode is open, in place of the cutting instructions (Workspace.svelte
  // stacks the two); the render settings stay on the right. The user, 2026-09-25: "tilt
  // performance mode should have the tilt graph with a few buttons and sliders. the graph needs
  // toggles for iso brightness, windowing, cos brightness and headshadow. under those it needs a
  // slider for the start and end angles (currently and by default using 33 degrees) under all the
  // buttons and sliders, it needs a download button that allows users to export the tilt graph."
  //
  // Built from the design language's pieces (kb/the-studio-s-design-language.md): three cards
  // (PanelSection) -- the graph, the curves, the tilt range -- then the Download button, and Done
  // pinned to the pane's foot as the tier toolbar is. The graph is Gem Cut Studio's layout: Tilt X
  // on the left half, from its reach at the left edge in to face-up, and Tilt Y on the right half,
  // out to its reach at the right edge; 0 to 100% up the side. A solid line is the whole stone's
  // average, a dotted one the table's alone. It is drawn once the sweep has measured every pose (a
  // progress bar fills meanwhile), with the view held still; then the pointer over it turns the
  // view to the pose under it, and the values at that pose are read off beside each curve's
  // switch.
  //
  // The graph is drawn by tilt_performance.js's graphSvg, as text, at the card's own width in
  // pixels (not scaled from a fixed viewBox, which would shrink its labels in a narrow pane), and
  // the Download button saves the same drawing (graphImageSvg) as a PNG.
  import { get } from 'svelte/store';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import { Slider } from '$lib/components/ui/slider/index.js';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import PanelSection from './PanelSection.svelte';
  import {
    tiltPerformance, tiltProgress, exitTiltPerformance, pointAtPose, setTiltRange,
  } from '../lib/tilt_performance_mode.js';
  import {
    CURVES, GRAPH_MARGIN, TILT_RANGE_MIN, TILT_RANGE_MAX, graphSvg, graphImageSvg, poseAtGraphX,
    sampleNearest,
  } from '../lib/tilt_performance.js';
  import { engine, cutMeta } from '../lib/stores.js';
  import { saveFileAs } from '../lib/export_file.js';

  // EditPanel's own buttons, verbatim: the modes' ways out look and sit alike.
  const ACTION = 'h-8 flex-1 border-[var(--panel-edge)] bg-[var(--raised)] px-3 text-[13px] text-[var(--text)] shadow-none hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:border-[var(--accent)] dark:hover:bg-[var(--hover)]';

  // What each curve's switch says it measures.
  const TIPS = {
    iso: 'How bright the stone looks with even light from every direction above it. Higher is better.',
    cos: 'How bright the stone looks when the light is strongest from straight behind you and fades towards the horizon. It rewards light returned close to your own line of sight. Higher is better.',
    window: 'How much of the stone you see through instead of seeing light returned: the washed-out, see-through patches. Lower is better.',
    head: 'How much of the light the stone would return is blocked by your own head, within the head shadow half-angle set in the render settings. Lower is better.',
  };

  // The graph's colours: Gem Cut Studio's grey, yellow, orange and pink, taken from the Nord
  // palette (kb/the-nord-palette-and-its-shader-mirror.md) and set on #tilt-panel below; the grid
  // and labels are the cards' own edge and muted colours.
  const SCREEN_PALETTE = {
    iso: 'var(--tilt-iso)',
    cos: 'var(--tilt-cos)',
    window: 'var(--tilt-window)',
    head: 'var(--tilt-head)',
    grid: 'var(--tilt-grid)',
    middle: 'var(--panel-edge)',
    axis: 'var(--muted)',
    cursor: 'var(--accent)',
    surface: 'var(--panel)',
  };

  // Which curves are drawn, and whether the table's dotted twins are. All on, as in Gem Cut
  // Studio's own graphs.
  let shown = $state({ iso: true, cos: true, window: true, head: true });
  let showTable = $state(true);
  let graphWidth = $state(0);
  let saving = $state(false);
  let panel;
  // The slider's two thumbs, [-start, end]: bound, so a thumb pushed past its limit can be put
  // back, and following the mode's reach, which is kept from one opening to the next.
  let rangeValue = $state([-TILT_RANGE_MIN, TILT_RANGE_MIN]);

  const tilt = $derived($tiltPerformance);
  // Follows the mode's reach, but only when it has moved: every update of the store is a new
  // `range` object, and handing the slider a new array each time made it report a change, which
  // set the range, which updated the store -- a loop that ran for as long as the sweep did and cost
  // it several seconds (2026-09-26).
  const rangeX = $derived(tilt.range.x);
  const rangeY = $derived(tilt.range.y);

  $effect(() => {
    if (rangeValue[0] !== -rangeX || rangeValue[1] !== rangeY) {
      rangeValue = [-rangeX, rangeY];
    }
  });

  // The progress bar reads its own store, which moves as each batch finishes; the graph and
  // everything else read `tilt`, which changes once the sweep is done (tilt_performance_mode.js).
  const running = $derived(tilt.open && $tiltProgress.measured < $tiltProgress.total);
  const cursorSample = $derived(tilt.cursor ? sampleNearest(tilt.samples, tilt.cursor, tilt.range) : null);
  const graph = $derived(graphWidth > GRAPH_MARGIN.left + GRAPH_MARGIN.right
    ? graphSvg({
      samples: tilt.samples, range: tilt.range, shown, showTable, cursor: tilt.cursor,
      width: graphWidth, palette: SCREEN_PALETTE, font: 'inherit', mono: 'var(--font-mono)',
    })
    : null);

  function label(key) {
    const curve = CURVES.find(each => each.key === key);

    // As Gem Cut Studio names it: the head shadow curve carries the angle it was measured with.
    return key === 'head' ? `${curve.label} (${Math.round(tilt.headShadow)}°)` : curve.label;
  }

  function percent(value) {
    return value === undefined || value === null ? '—' : `${(value * 100).toFixed(1)}%`;
  }

  /** The pointer over the graph: the view turns to the pose under it, once the sweep is done. */
  function pointed(event) {
    const box = event.currentTarget.getBoundingClientRect();
    const plotWidth = box.width - GRAPH_MARGIN.left - GRAPH_MARGIN.right;
    const fraction = (event.clientX - box.left - GRAPH_MARGIN.left) / plotWidth;

    pointAtPose(poseAtGraphX(fraction, tilt.range));
  }

  /**
   * The slider's two thumbs: the start (Tilt X's reach) on the left of face-up, the end (Tilt Y's)
   * on the right. Each is held on its own side of face-up, at least TILT_RANGE_MIN from it.
   */
  function rangeMoved([start, end]) {
    setTiltRange({ x: -start, y: end });

    // A thumb dragged past its limit (across face-up, or within TILT_RANGE_MIN of it) is put
    // back where the reach stopped.
    const { x, y } = get(tiltPerformance).range;

    if (start !== -x || end !== y) {
      rangeValue = [-x, y];
    }
  }

  /**
   * The colour a CSS custom property of the panel comes to, as `rgb(...)`, for the downloaded
   * picture, which is drawn outside the page and so cannot look up `var(--...)` itself. Read off a
   * probe element rather than the property's own text, which may itself be a `var()` or a mix.
   */
  function colourOf(name) {
    const probe = document.createElement('span');

    probe.style.color = `var(${name})`;
    panel.appendChild(probe);

    const colour = getComputedStyle(probe).color;

    probe.remove();
    return colour;
  }

  /**
   * Download: the graph as a PNG, drawn afresh at twice its size with the colours of the theme
   * the page is in, titled with the design's name and the settings it was measured with, and a
   * legend of the curves shown -- what a reader of the picture needs that the panel says around
   * the graph instead.
   */
  async function download() {
    if (saving) {
      return;
    }

    saving = true;

    try {
      const style = getComputedStyle(panel);
      const app = engine.app;
      const name = (get(cutMeta).name || '').trim();
      const svg = graphImageSvg({
        samples: tilt.samples, range: tilt.range, shown, showTable, headShadow: tilt.headShadow,
        width: 720,
        title: name ? `${name}: tilt performance` : 'Tilt performance',
        subtitle: `Head shadow ${Math.round(tilt.headShadow)}° · RI ${app.get_param('refractiveIndex').toFixed(3)}` +
          ` · Dispersion ${app.get_param('dispersion').toFixed(3)} · Tilt X ${tilt.range.x}° · Tilt Y ${tilt.range.y}°`,
        // SCREEN_PALETTE's `var(--name)`s, each as the colour it is in the page's theme now.
        palette: Object.fromEntries(Object.entries(SCREEN_PALETTE)
          .map(([key, value]) => [key, colourOf(value.slice(4, -1))])),
        font: style.fontFamily,
        mono: style.getPropertyValue('--font-mono').trim() || 'monospace',
        background: colourOf('--panel'),
        text: colourOf('--text'),
      });
      const png = await rasterise(svg, 2);
      const file = `${(name || 'stone').replace(/[\\/:*?"<>|]+/g, '-')} tilt performance.png`;

      await saveFileAs(file, png, { description: 'PNG image', mimeType: 'image/png', extensions: ['.png'] });
    } finally {
      saving = false;
    }
  }

  /** An SVG document as a PNG blob, `scale` times its own size. */
  function rasterise(svg, scale) {
    return new Promise((resolve, reject) => {
      const image = new Image();

      image.onload = () => {
        const canvas = document.createElement('canvas');

        canvas.width = image.width * scale;
        canvas.height = image.height * scale;

        const context = canvas.getContext('2d');

        context.scale(scale, scale);
        context.drawImage(image, 0, 0);
        canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('the graph could not be drawn'))), 'image/png');
      };
      image.onerror = () => reject(new Error('the graph could not be drawn'));
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
  }
</script>

<div id="tilt-panel" bind:this={panel}>
  <PanelSection title="Tilt performance" id="tilt-graph-section">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div id="tilt-graph" role="img" aria-label="Tilt performance graph" bind:clientWidth={graphWidth}
      class:tilt-graph-busy={running}
      style:height="{graph?.height ?? 0}px"
      onpointermove={pointed} onpointerdown={pointed}>
      {#if graph}
        <svg width={graph.width} height={graph.height} aria-hidden="true">{@html graph.markup}</svg>
      {/if}
    </div>

    <div class="tilt-status" id="tilt-status">
      {#if running}
        <span>Measuring {$tiltProgress.measured} of {$tiltProgress.total}…</span>
        <div class="tilt-progress"><div style:width="{($tiltProgress.measured / $tiltProgress.total) * 100}%"></div></div>
      {:else if tilt.cursor && cursorSample}
        <span>Tilt {tilt.cursor.axis.toUpperCase()} <span class="tilt-mono">{cursorSample.angle.toFixed(0)}°</span></span>
      {:else}
        <span>Point at the graph to tilt the stone.</span>
      {/if}
    </div>
  </PanelSection>

  <!-- One switch per curve, each with its value at the cursor: the whole stone, then the table's
       in brackets. -->
  <PanelSection title="Curves" id="tilt-curves-section">
    <div class="tilt-rows">
      {#each CURVES as { key } (key)}
        <label class="tilt-row" data-tip={TIPS[key]}>
          <Switch id="tilt-show-{key}" size="sm" bind:checked={shown[key]} />
          <span class="tilt-swatch" style:border-color="var(--tilt-{key})"></span>
          <span class="tilt-name">{label(key)}</span>
          <!-- The stone's value, and the table's under it, so the names keep the width. -->
          <span class="tilt-value" id="tilt-value-{key}">{percent(cursorSample?.measurement.stone[key])}{#if showTable && cursorSample?.measurement.table}<span class="tilt-table-value">({percent(cursorSample.measurement.table[key])})</span>{/if}</span>
        </label>
      {/each}
      <label class="tilt-row" data-tip="Also draws each curve for the table alone, dotted. The value in brackets is the table's.">
        <Switch id="tilt-show-table" size="sm" bind:checked={showTable} />
        <span class="tilt-swatch tilt-swatch-table"></span>
        <span class="tilt-name">Table alone (dotted)</span>
      </label>
    </div>
  </PanelSection>

  <PanelSection title="Tilt range" id="tilt-range-section">
    <div class="setting" data-tip="How far the stone is tilted: the start is Tilt X, on the left of the graph, and the end Tilt Y, on the right. Drag either end; widening the range measures only the new tilts.">
      <div class="row">
        <span class="name">Start <span class="value" id="tilt-range-start">{tilt.range.x}°</span></span>
        <span class="name">End <span class="value" id="tilt-range-end">{tilt.range.y}°</span></span>
      </div>
      <Slider type="multiple" id="tilt-range" min={-TILT_RANGE_MAX} max={TILT_RANGE_MAX} step={1}
        bind:value={rangeValue} thumbLabel="Tilt range" class="py-1"
        onValueChange={rangeMoved} />
      <div class="tilt-range-scale"><span>{TILT_RANGE_MAX}°</span><span>0°</span><span>{TILT_RANGE_MAX}°</span></div>
    </div>
  </PanelSection>

  <Button variant="outline" size="sm" id="tilt-download" class="{ACTION} flex-none gap-1.5"
    disabled={saving || tilt.measured === 0} onclick={download}
    data-tip="Saves the graph as a PNG picture, with the design's name, the settings it was measured with and a key to the curves shown.">
    <DownloadIcon class="size-3.5" aria-hidden="true" />Download graph
  </Button>

  <div class="tilt-actions">
    <Button variant="outline" size="sm" id="tilt-done" class={ACTION + ' border-[var(--accent)] text-[var(--accent)] dark:border-[var(--accent)]'}
      data-tip="Closes tilt performance and brings back the cutting instructions and your view. Escape does the same."
      onclick={exitTiltPerformance}>Done</Button>
  </div>
</div>

<style>
  /* The curves' colours: Gem Cut Studio's grey, yellow, orange and pink, taken from the Nord
     palette. ISO is the text colour, so it stays visible on the light theme's pale pane. The grid
     is the cards' edge colour, softened so the curves stay in front of it. */
  #tilt-panel {
    --tilt-iso: var(--text);
    --tilt-cos: #ebcb8b;
    --tilt-window: #d08770;
    --tilt-head: #b48ead;
    --tilt-grid: color-mix(in srgb, var(--panel-edge) 55%, transparent);
    width: 100%;
    height: 100%;
    background: var(--panel);
    /* The same hairline, padding and scrolling column as #instructions-pane, whose place it takes. */
    border-right: 1px solid var(--panel-edge);
    padding: var(--pane-pad) var(--pane-pad) 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  :global(:root[data-theme="light"]) #tilt-panel {
    --tilt-cos: #c29a3a;
  }

  #tilt-graph {
    position: relative;
    width: 100%;
    cursor: crosshair;
    touch-action: none;
  }

  /* Pointing turns the stone only once every tilt is measured (tilt_performance_mode.js). */
  #tilt-graph.tilt-graph-busy {
    cursor: progress;
  }

  #tilt-graph svg {
    display: block;
    position: absolute;
    inset: 0;
  }

  .tilt-status {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 16px;
    margin-top: 6px;
    color: var(--muted);
    font-size: 11px;
  }

  .tilt-mono {
    font-family: var(--font-mono);
  }

  .tilt-progress {
    flex: 1;
    height: 2px;
    border-radius: 1px;
    background: var(--panel-edge);
    overflow: hidden;
  }

  .tilt-progress > div {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
  }

  .tilt-rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .tilt-row {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }

  .tilt-swatch {
    flex: none;
    width: 14px;
    height: 0;
    border-top: 2px solid;
    border-radius: 1px;
  }

  .tilt-swatch-table {
    border-top: 2px dotted var(--muted);
  }

  .tilt-name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tilt-value {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 14px;
    white-space: nowrap;
  }

  .tilt-table-value {
    color: var(--muted);
    font-size: 10px;
  }

  .tilt-range-scale {
    display: flex;
    justify-content: space-between;
    margin-top: 2px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  #tilt-range-section :global(.setting) {
    margin-bottom: 0;
  }

  .tilt-actions {
    display: flex;
    gap: 8px;
    /* Pinned to the pane's foot, as the tier toolbar is in the cutting instructions. */
    position: sticky;
    bottom: 0;
    margin: auto calc(-1 * var(--pane-pad)) 0;
    padding: var(--pane-pad);
    background: var(--panel);
  }
</style>
