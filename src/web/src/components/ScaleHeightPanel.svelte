<script>
  // Scale height mode's panel (T-0231, 2026-09-23, the user: "in scale height mode, we leave the
  // faceting instructions on the left but on the right we replace the render settings with the
  // scale height settings. this has two gauges that start at 1x, and scale up or down. the left
  // gauge is the pavilion ratio and the right is the crown. we also need the fine toggles as per
  // standard gauges and the manual input. add a toggle at the bottom that locks the crown to the
  // pavilion ratio. at the very bottom, like with edit mode ... we need the done and cancel
  // buttons").
  //
  // Modelled on EditPanel, and drawn in its language on purpose: the same title and hint, the same
  // card round the pair of tape rulers (ValueRuler, unchanged -- its Fine toggle and click-to-type
  // reading are the "fine toggles ... and the manual input"), the same error box and the same two
  // buttons in the same place. App.svelte stacks it with the render settings and edit mode's bar in
  // one grid cell and shows whichever mode is open. Everything it does goes through
  // scale_height_mode.js; this file only draws the gauges and hands their changes on.
  import { Button } from '$lib/components/ui/button/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { error } from '../lib/stores.js';
  import {
    scaleHeightOpen, scaleGauges, changeGauge, changeLock, resetScaleGauges, exitScaleHeightMode,
    cancelScaleHeightMode,
  } from '../lib/scale_height_mode.js';
  import {
    RATIO_MIN, RATIO_MAX, RATIO_STEP, RATIO_TICK, RATIO_MAJOR_EVERY, RATIO_PX_PER_UNIT, RATIO_DECIMALS,
    gaugesAtOne,
  } from '../lib/scale_height.js';
  import ValueRuler from './ValueRuler.svelte';

  // EditPanel's own two buttons, verbatim: the modes' ways out look and sit alike.
  const ACTION = 'h-8 flex-1 border-[var(--panel-edge)] bg-[var(--raised)] px-3 text-[13px] text-[var(--text)] shadow-none hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:border-[var(--accent)] dark:hover:bg-[var(--hover)]';

  // Reset (T-0235): the same control as the two actions, one size down (the view pane's Top/Side
  // buttons' height and type), full width under the gauges. Inert at 1x the way the tier toolbar's
  // buttons are: aria-disabled rather than `disabled`, so its tooltip still says what it would do,
  // faded, and with no hover (the `!` wins over the Button's own dark-mode hover; see
  // TierToolbar.svelte for the measurement behind it).
  const RESET = 'h-7 w-full border-[var(--panel-edge)] bg-[var(--raised)] px-3 text-[12px] font-normal text-[var(--text)] shadow-none hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:border-[var(--accent)] dark:hover:bg-[var(--hover)] aria-disabled:cursor-default aria-disabled:opacity-45 aria-disabled:hover:border-[var(--panel-edge)]! aria-disabled:hover:bg-[var(--raised)]!';

  const atOne = $derived(gaugesAtOne($scaleGauges));
</script>

<div id="scale-height-panel">
  <!-- The panel's own "Scaling height" title moved to the top bar's mode status 2026-09-24 --
       see TopBar.svelte's `modeStatus` and kb/mode-status-in-the-top-bar.md. -->
  <p class="scale-panel-hint">Drag a gauge to make that half of the stone taller or flatter. Every
    facet turns so its angle's tangent is multiplied by the ratio, and moves so its meets still
    meet. Done keeps the changes; Cancel or Escape undoes them.</p>

  <!-- Mounted afresh each time the mode opens, so each gauge starts as a new one would (Fine off,
       nothing half-typed), the way EditPanel's `{#if tier}` does for its rulers. -->
  {#if $scaleHeightOpen}
    <div class="scale-panel-card">
      <!-- Pavilion on the left, crown on the right (the user's order). Larger ratios upwards on
           both, the way "scale up" reads; neither is flipped the way the crown's angle ruler is,
           since a ratio has no top or bottom of the stone to follow. The constants, and why the
           ticks land 10px apart like the angle ruler's, are at the top of scale_height.js. -->
      <div class="scale-panel-rulers">
        <ValueRuler label="Pavilion" value={$scaleGauges.pavilion} min={RATIO_MIN} max={RATIO_MAX}
          step={RATIO_STEP} tick={RATIO_TICK} majorEvery={RATIO_MAJOR_EVERY}
          pxPerUnit={RATIO_PX_PER_UNIT} decimals={RATIO_DECIMALS} unit="×"
          onchange={(value, done) => changeGauge('pavilion', value, done)} />
        <ValueRuler label="Crown" value={$scaleGauges.crown} min={RATIO_MIN} max={RATIO_MAX}
          step={RATIO_STEP} tick={RATIO_TICK} majorEvery={RATIO_MAJOR_EVERY}
          pxPerUnit={RATIO_PX_PER_UNIT} decimals={RATIO_DECIMALS} unit="×"
          onchange={(value, done) => changeGauge('crown', value, done)} />
      </div>

      <!-- Reset (T-0235, the user: "below the scale height gauges ... add a reset button below
           them that snaps them to 1x"). Both gauges, not the lock; one step Undo can take back. -->
      <div class="scale-panel-reset">
        <Button variant="outline" size="sm" id="scale-reset" class={RESET}
          aria-disabled={String(atOne)}
          data-tip={atOne ? 'Both gauges are already at 1×.'
            : 'Puts both gauges back to 1×, the stone as it was. Undo brings the gauges back.'}
          onclick={resetScaleGauges}>Reset to 1×</Button>
      </div>

      <!-- The lock (the user: "add a toggle at the bottom that locks the crown to the pavilion
           ratio"): the render settings' own switch row (SettingsPanel's facet wireframe), but a
           controlled Switch rather than SettingSwitch, which keeps its own state after the first
           draw -- this one has to follow Undo and Redo, which can turn it back on or off. -->
      <div class="scale-panel-lock">
        <Label class="setting gap-2 text-xs font-normal"
          data-tip="Moves the crown and the pavilion together, by the same ratio. Turning it on brings the crown to the pavilion's ratio.">
          <Switch id="scale-lock" size="sm"
            bind:checked={() => $scaleGauges.lock, on => changeLock(on)} />
          <span class="name">Lock crown to pavilion</span>
        </Label>
      </div>
    </div>
  {/if}

  <!-- The render settings' error box is hidden with them, so the same message is shown here: a
       rebuild that fails must say so. -->
  <pre id="scale-error" style:display={$error.visible ? 'block' : 'none'}>{$error.text}</pre>

  <!-- Both ways out, at the bottom, as in edit mode. Cancel is Escape's twin. -->
  <div class="scale-panel-actions">
    <Button variant="outline" size="sm" id="scale-cancel" class={ACTION}
      data-tip="Stops scaling and puts every facet back as it was. Escape does the same."
      onclick={cancelScaleHeightMode}>Cancel</Button>
    <Button variant="outline" size="sm" id="scale-done" class={ACTION + ' border-[var(--accent)] text-[var(--accent)] dark:border-[var(--accent)]'}
      data-tip="Stops scaling and keeps the changes as one step Undo can take back, and brings the render settings back."
      onclick={exitScaleHeightMode}>Done</Button>
  </div>
</div>

<style>
  .scale-panel-hint {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  /* EditPanel's `.edit-panel-rulers` card, with the lock inside it under the two gauges. */
  .scale-panel-card {
    margin-bottom: 12px;
    padding: 10px 12px;
    border: 1px solid var(--panel-edge);
    border-radius: var(--radius-card);
  }

  .scale-panel-rulers {
    display: flex;
    gap: 18px;
  }

  .scale-panel-reset {
    margin-top: 10px;
  }

  .scale-panel-lock {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--panel-edge);
  }

  /* The switch row carries panel.css's `.setting` for its look; its bottom margin is for a stack
     of settings, and this is the last thing in the card. */
  .scale-panel-lock :global(.setting) { margin-bottom: 0; }

  .scale-panel-actions {
    display: flex;
    gap: 8px;
    margin-top: auto;
    padding-top: 16px;
  }

  #scale-error {
    margin: 12px 0 0;
    color: var(--error);
    font-size: 11px;
    white-space: pre-wrap;
  }
</style>
