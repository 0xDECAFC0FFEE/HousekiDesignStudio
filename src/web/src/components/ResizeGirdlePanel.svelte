<script>
  // Resize girdle mode's panel (T-0237, 2026-09-23, the user: "it replaces the render bar with the
  // girdle resizer. the girdle resizing bar just has a depth gauge with no numbers"). T-0241,
  // 2026-09-24, narrowed the gauge to the pavilion only ("only modify the pavilion facet depths,
  // don't modify the crown facet depths") -- the hint below says so -- and gave the mode its own
  // side-on pose, opened and restored by resize_girdle_mode.js itself. T-0242, 2026-09-24, changed
  // the gauge from a ratio to a height z that moves the whole pavilion along the axis instead of
  // scaling it (the hint below says so too), so every pavilion meetpoint on the girdle stays level.
  //
  // ScaleHeightPanel's twin, in the same language: the same title and hint, the same card round the
  // tape ruler, the same error box and the same Done and Cancel in the same place. The one gauge is
  // a ValueRuler with no numbers anywhere -- no tick labels (`tickLabels={false}`), no reading or
  // typing box above the tape (`readout={false}`, which keeps a blank spacer of the reading's size)
  // -- and a longer, brighter tick at z = 0 (`mark`), the depths the mode opened on. App.svelte
  // stacks it with the other right-hand panels in one grid cell. Everything it does goes through
  // resize_girdle_mode.js.
  import { Button } from '$lib/components/ui/button/index.js';
  import { error } from '../lib/stores.js';
  import {
    resizeGirdleOpen, girdleZ, changeZ, exitResizeGirdleMode, cancelResizeGirdleMode,
  } from '../lib/resize_girdle_mode.js';
  import {
    RESIZE_MIN, RESIZE_MAX, RESIZE_STEP, RESIZE_TICK, RESIZE_MAJOR_EVERY, RESIZE_PX_PER_UNIT,
    RESIZE_DECIMALS, RESIZE_MARK,
  } from '../lib/resize_girdle.js';
  import ValueRuler from './ValueRuler.svelte';

  // EditPanel's and ScaleHeightPanel's two buttons, verbatim: the modes' ways out look and sit alike.
  const ACTION = 'h-8 flex-1 border-[var(--panel-edge)] bg-[var(--raised)] px-3 text-[13px] text-[var(--text)] shadow-none hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:border-[var(--accent)] dark:hover:bg-[var(--hover)]';
</script>

<div id="resize-girdle-panel">
  <h2 class="girdle-panel-title">Resizing girdle</h2>
  <p class="girdle-panel-hint">Drag the gauge to move the whole pavilion up or down the stone's
    axis, while the crown and the girdle stay where they are: every pavilion meetpoint on the
    girdle moves together, so the girdle stays level. Up makes the girdle band taller, down
    thinner. The long mark is where you started. Done keeps the change; Cancel or Escape undoes
    it.</p>

  <!-- Mounted afresh each time the mode opens, so the gauge starts as a new one would (Fine off),
       as ScaleHeightPanel's `{#if}` does for its gauges. -->
  {#if $resizeGirdleOpen}
    <div class="girdle-panel-card">
      <!-- Larger z upwards (deeper cuts), the way "increase" reads. The constants, and why the
           range is not the same distance either way from 0, are at the top of resize_girdle.js. -->
      <div class="girdle-panel-rulers">
        <ValueRuler label="Depth" value={$girdleZ} min={RESIZE_MIN} max={RESIZE_MAX}
          step={RESIZE_STEP} tick={RESIZE_TICK} majorEvery={RESIZE_MAJOR_EVERY}
          pxPerUnit={RESIZE_PX_PER_UNIT} decimals={RESIZE_DECIMALS}
          tickLabels={false} readout={false} mark={RESIZE_MARK}
          onchange={(value, done) => changeZ(value, done)} />
      </div>
    </div>
  {/if}

  <!-- The render settings' error box is hidden with them, so the same message is shown here: a
       rebuild that fails must say so. -->
  <pre id="girdle-error" style:display={$error.visible ? 'block' : 'none'}>{$error.text}</pre>

  <!-- Both ways out, at the bottom, as in the other modes. Cancel is Escape's twin. -->
  <div class="girdle-panel-actions">
    <Button variant="outline" size="sm" id="girdle-cancel" class={ACTION}
      data-tip="Stops resizing and puts every facet back as it was. Escape does the same."
      onclick={cancelResizeGirdleMode}>Cancel</Button>
    <Button variant="outline" size="sm" id="girdle-done" class={ACTION + ' border-[var(--accent)] text-[var(--accent)] dark:border-[var(--accent)]'}
      data-tip="Stops resizing and keeps the change as one step Undo can take back, and brings the render settings back."
      onclick={exitResizeGirdleMode}>Done</Button>
  </div>
</div>

<style>
  .girdle-panel-title {
    margin: 2px 0 4px;
    color: var(--text);
    font-size: 14px;
    font-weight: 600;
  }

  .girdle-panel-hint {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  /* ScaleHeightPanel's card. */
  .girdle-panel-card {
    margin-bottom: 12px;
    padding: 10px 12px;
    border: 1px solid var(--panel-edge);
    border-radius: var(--radius-card);
  }

  .girdle-panel-rulers {
    display: flex;
  }

  .girdle-panel-actions {
    display: flex;
    gap: 8px;
    margin-top: auto;
    padding-top: 16px;
  }

  #girdle-error {
    margin: 12px 0 0;
    color: var(--error);
    font-size: 11px;
    white-space: pre-wrap;
  }
</style>
