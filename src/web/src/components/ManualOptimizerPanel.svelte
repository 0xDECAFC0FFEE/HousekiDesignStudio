<script>
  // Edit > Manual optimizer's settings (T-0273), in the right-hand column while the mode is open,
  // in place of the render settings. The user, 2026-09-28: "its right panel should be the manual
  // optimizer settings. at the top it needs a subdivisions slider for the square root of the number
  // of images to show on the left panel ... only support 3+ odd numbers. under it should be a
  // slider for the crown height range and a slider for the pavilion height range as a percent ...
  // we also need to copy in the lighting settings from the rendering panel. at the bottom should be
  // the standard done/cancel buttons."
  //
  // In the other modes' language (ScaleHeightPanel): the hint, a card with the mode's controls, the
  // error box, and Cancel and Done at the foot. The lighting is the render settings' own Lighting
  // section (LightingSettings.svelte), in a card of the same name: the same settings, so a change
  // here is a change to the render settings too, and it redraws both the stone and the grid.
  //
  // Each slider changes the grid when it is let go (or a value is typed), not on every step of the
  // drag: every change rebuilds up to 121 stones, and each release is one step of the mode's undo.
  // The readout follows the thumb meanwhile.
  import { Button } from '$lib/components/ui/button/index.js';
  import { error } from '../lib/stores.js';
  import {
    manualOptimizer, setSubdivisions, setRange, exitManualOptimizer, cancelManualOptimizer,
  } from '../lib/manual_optimizer_mode.js';
  import {
    SUBDIVISIONS_MIN, SUBDIVISIONS_MAX, RANGE_MIN, RANGE_MAX, RANGE_STEP, formatRange, formatRatio,
    snapSubdivisions, clampRange,
  } from '../lib/manual_optimizer.js';
  import Slider from './Slider.svelte';
  import PanelSection from './PanelSection.svelte';
  import LightingSettings from './LightingSettings.svelte';

  // The modes' two buttons, verbatim (ScaleHeightPanel): their ways out look and sit alike.
  const ACTION = 'h-8 flex-1 border-[var(--panel-edge)] bg-[var(--raised)] px-3 text-[13px] text-[var(--text)] shadow-none hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:border-[var(--accent)] dark:hover:bg-[var(--hover)]';

  const SUBDIVISIONS_SPEC = { min: SUBDIVISIONS_MIN, max: SUBDIVISIONS_MAX, step: 2 };
  const RANGE_SPEC = { min: RANGE_MIN, max: RANGE_MAX, step: RANGE_STEP };

  const state = $derived($manualOptimizer.state);

  // A thumb being dragged, before it is let go: `{ subdivisions?, crown?, pavilion? }`. What the
  // slider and its readout show meanwhile; the grid changes on the release.
  let dragged = $state({});

  const subdivisions = $derived(dragged.subdivisions ?? state.subdivisions);
  const crownRange = $derived(dragged.crown ?? state.crownRange);
  const pavilionRange = $derived(dragged.pavilion ?? state.pavilionRange);

  function released(key, apply) {
    if (dragged[key] !== undefined) {
      apply(dragged[key]);
    }

    dragged = { ...dragged, [key]: undefined };
  }
</script>

<div id="manual-optimizer-panel">
  <p class="optimizer-panel-hint">The grid on the left shows the stone with taller and flatter crowns
    (rows) and pavilions (columns). Click a cell to see it here in the middle; drag across cells to
    zoom the grid in on them. Done keeps the heights shown in the middle; Cancel or Escape undoes
    them.</p>

  <!-- Mounted afresh each time the mode opens, so nothing half-dragged or half-typed survives. -->
  {#if $manualOptimizer.open}
    <div class="optimizer-panel-card">
      <Slider id="optimizer-subdivisions" label="Subdivisions"
        tip="How many previews the grid has on each side: 3, 5, 7, 9 or 11. The middle one is the heights the grid is centred on."
        spec={SUBDIVISIONS_SPEC} value={subdivisions} text={`${subdivisions} × ${subdivisions}`}
        oninput={v => { dragged = { ...dragged, subdivisions: snapSubdivisions(v) }; }}
        onchange={() => released('subdivisions', setSubdivisions)}
        readoutRead={() => state.subdivisions}
        readoutWrite={value => setSubdivisions(value)} />

      <Slider id="optimizer-crown-range" label="Crown height range"
        tip="How much taller the crown is in the top row, and flatter in the bottom row, than in the middle row, in percent. At 100% the top row's crowns are twice the middle's height and the bottom row's half."
        spec={RANGE_SPEC} value={crownRange} text={formatRange(crownRange)}
        oninput={v => { dragged = { ...dragged, crown: clampRange(v) }; }}
        onchange={() => released('crown', value => setRange('crown', value))}
        readoutRead={() => state.crownRange}
        readoutWrite={value => setRange('crown', value)} />

      <Slider id="optimizer-pavilion-range" label="Pavilion height range"
        tip="How much deeper the pavilion is in the left column, and shallower in the right column, than in the middle column, in percent. At 100% the left column's pavilions are twice the middle's depth and the right column's half."
        spec={RANGE_SPEC} value={pavilionRange} text={formatRange(pavilionRange)}
        oninput={v => { dragged = { ...dragged, pavilion: clampRange(v) }; }}
        onchange={() => released('pavilion', value => setRange('pavilion', value))}
        readoutRead={() => state.pavilionRange}
        readoutWrite={value => setRange('pavilion', value)} />

      <!-- The heights the middle shows, as scale height's ratios of the stone the mode opened on. -->
      <div class="optimizer-panel-shown" id="optimizer-shown"
        data-tip="The heights of the stone in the middle, as multiples of the heights it had when the manual optimizer opened. Done keeps these.">
        <span>Shown</span>
        <span class="optimizer-panel-ratios">Crown <b>{formatRatio(state.preview.crown)}</b>
          · Pavilion <b>{formatRatio(state.preview.pavilion)}</b></span>
      </div>
    </div>

    <!-- The render settings' own Lighting controls: the same settings, drawn a second time. -->
    <PanelSection id="optimizer-lighting" title="Lighting">
      <LightingSettings idPrefix="optimizer-" />
    </PanelSection>
  {/if}

  <!-- The render settings' error box is hidden with them, so the same message is shown here: a
       rebuild that fails must say so. -->
  <pre id="optimizer-error" style:display={$error.visible ? 'block' : 'none'}>{$error.text}</pre>

  <!-- Both ways out, at the bottom, as in the other modes. Cancel is Escape's twin. -->
  <div class="optimizer-panel-actions">
    <Button variant="outline" size="sm" id="optimizer-cancel" class={ACTION}
      data-tip="Closes the manual optimizer and puts every facet back as it was. Escape does the same."
      onclick={cancelManualOptimizer}>Cancel</Button>
    <Button variant="outline" size="sm" id="optimizer-done" class={ACTION + ' border-[var(--accent)] text-[var(--accent)] dark:border-[var(--accent)]'}
      data-tip="Closes the manual optimizer and keeps the heights shown in the middle, as one step Undo can take back."
      onclick={exitManualOptimizer}>Done</Button>
  </div>
</div>

<style>
  #manual-optimizer-panel {
    width: 100%;
    min-width: 0;
    background: var(--panel);
    border-left: 1px solid var(--panel-edge);
    padding: var(--pane-pad);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .optimizer-panel-hint {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  /* ScaleHeightPanel's card. */
  .optimizer-panel-card {
    margin-bottom: 12px;
    padding: 10px 12px;
    border: 1px solid var(--panel-edge);
    border-radius: var(--radius-card);
  }

  .optimizer-panel-shown {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    padding-top: 10px;
    border-top: 1px solid var(--panel-edge);
    font-size: 12px;
  }

  .optimizer-panel-ratios {
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
  }

  .optimizer-panel-ratios b {
    color: var(--accent);
    font-family: var(--font-mono);
    font-weight: 400;
  }

  .optimizer-panel-actions {
    display: flex;
    gap: 8px;
    margin-top: auto;
    padding-top: 16px;
  }

  #optimizer-error {
    margin: 12px 0 0;
    color: var(--error);
    font-size: 11px;
    white-space: pre-wrap;
  }
</style>
