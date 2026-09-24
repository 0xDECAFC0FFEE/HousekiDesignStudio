<script>
  // The renderer's pane: the canvas and its drop target. The canvas's own controls (orbit, click,
  // wheel) are wired by viewport.js once GemApp exists; what is here is the drag-and-drop of a
  // design file onto the pane, which shares the file picker's load path (loadModelFile) so the two
  // cannot drift.
  import { loadModelFile, applyParam } from '../lib/session.js';
  import { stoneStatsStore, ready, bumpParams, programLinking } from '../lib/stores.js';
  import { fullscreen } from '../lib/fullscreen.js';
  import ParamSlider from './ParamSlider.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import EditOverlay from './EditOverlay.svelte';
  import IndexDial from './IndexDial.svelte';

  // The stone's stats in the bottom right (2026-09-19, the user's request): a ratio the stone
  // does not have (T/W on a stone with no table) shows a dash. Three decimals, as GemCad prints
  // them.
  const ratio = value => (value === null ? '\u2014' : value.toFixed(3));
  const STATS = [
    { key: 'facets', label: 'Facets', format: value => String(value),
      tip: 'How many facets the stone has, girdle facets included.' },
    { key: 'tw', label: 'T/W', format: ratio,
      tip: "The table's width along the stone's long axis, divided by the girdle's width across its short axis." },
    { key: 'cw', label: 'C/W', format: ratio,
      tip: "The crown's height, from the girdle to the table, divided by the girdle's width across its short axis." },
    { key: 'pw', label: 'P/W', format: ratio,
      tip: "The pavilion's height, from the culet to the girdle, divided by the girdle's width across its short axis." },
  ];

  /** Points the stone straight at the viewer (Top) or side-on (Side): spin 0, tilt 0 or 90. */
  function setView(tilt) {
    if (applyParam('spin', 0) && applyParam('tilt', tilt)) {
      // The sliders read their values back from Rust when this changes.
      bumpParams();
    }
  }

  const VIEW_BUTTON = 'h-6 flex-1 border-[var(--panel-edge)] bg-[var(--raised)] px-2 py-0 text-[12px] font-normal text-[var(--text)] shadow-none hover:border-[var(--accent)] hover:bg-[var(--raised)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:border-[var(--accent)] dark:hover:bg-[var(--raised)]';

  let dragOver = $state(false);

  function ondragover(event) {
    event.preventDefault();
    dragOver = true;
  }

  function ondrop(event) {
    event.preventDefault();
    dragOver = false;

    const file = event.dataTransfer?.files?.[0];

    if (file) {
      loadModelFile(file);
    }
  }
</script>

<div id="viewport" class:drag-over={dragOver} {ondragover} ondragleave={() => { dragOver = false; }}
  {ondrop}>
  <canvas id="canvas"></canvas>
  <!-- The index gear's ticks round the stone, seen face-up or face-down, and edit mode's
       cutting plane (T-0193). Both are SVG over the canvas, not part of the picture. -->
  <IndexDial />
  <EditOverlay />
  <div id="drop-hint">drop an .obj, .asc, .gem or .gcs file to load it</div>
  <!-- A renderer's shader compiles the first time it is selected (viewport.js,
       watchProgramLinks), and the deterministic render stands in for it meanwhile; this says so,
       so the stand-in is not mistaken for the renderer that was picked. -->
  {#if $programLinking}
    <div id="program-linking" role="status">Compiling the shader for this renderer…</div>
  {/if}
  <!-- The stone's pose (2026-09-19, the user: the View sliders moved here from the settings, "add
       a top button that sets x=0, y=0 and side button that sets x=0 y=90 under the sliders"). -->
  <!-- Both cards over the canvas are hidden by the fullscreen toggle too (2026-09-21, the user:
       "please also hide the rotation pane and the facet count pane in the render"), leaving the
       stone and the index dial alone in the renderer. Hidden the same way the top bar and the
       instructions pane are, and for the same reasons -- see fullscreen.js. The sliders keep
       their state while off screen, so the pose is untouched by a trip through fullscreen. -->
  {#if $ready}
    <div id="view-controls" aria-label="View" class={$fullscreen ? 'hidden' : ''}>
      <ParamSlider name="spin" label="X rotation (spin)" tip="Turns the stone about its own axis." />
      <ParamSlider name="tilt" label="Y rotation (tilt)"
        tip="Tilts the stone's axis towards or away from you; 0 is face-up." />
      <div class="view-buttons">
        <Button variant="outline" size="sm" class={VIEW_BUTTON} id="view-top"
          data-tip="Looks straight down on the stone: X rotation 0, Y rotation 0." onclick={() => setView(0)}>Top</Button>
        <Button variant="outline" size="sm" class={VIEW_BUTTON} id="view-side"
          data-tip="Looks at the stone from the side: X rotation 0, Y rotation 90." onclick={() => setView(90)}>Side</Button>
      </div>
    </div>
  {/if}
  {#if $stoneStatsStore}
    <dl id="stone-stats" aria-label="Stone proportions" class={$fullscreen ? 'hidden' : ''}>
      {#each STATS as stat}
        <div class="stone-stat" data-stat={stat.key} data-tip={stat.tip}>
          <dt>{stat.label}</dt>
          <dd>{stat.format($stoneStatsStore[stat.key])}</dd>
        </div>
      {/each}
    </dl>
  {/if}
  <!-- The copyright line every page carries (2026-09-23, the user: "add a '© 2026 Houseki Design
       Studio. All rights reserved.' to all pages, in the design editor, leave it at the bottom of
       the renderer"). Kept in fullscreen too, as the user asked for it to stay; it takes no
       clicks, so orbiting the stone through it still works. -->
  <div id="viewport-copyright">© 2026 Houseki Design Studio. All rights reserved.</div>
</div>
