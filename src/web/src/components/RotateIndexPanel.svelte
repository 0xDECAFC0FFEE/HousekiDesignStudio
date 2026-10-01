<script>
  // Rotate by index mode's panel (T-0287, 2026-09-29, the user: "can you add support for rotate
  // index mode - it needs a slider to the right along with the cancel/done buttons").
  //
  // ResizeGirdlePanel's twin, in the same language: the same hint, the same card, the same error
  // box and the same Cancel and Done in the same place. The one control is a slider -- the render
  // settings' own labelled slider row (Slider.svelte: a Bits UI slider under a name and a reading
  // that can be clicked to type an exact value), since the user asked for a slider and a turn is a
  // plain number with a start and an end, not an open-ended tape. Its reading gives the turn in
  // teeth and in degrees of the wheel. App.svelte stacks it with the other right-hand panels in one
  // grid cell. Everything it does goes through rotate_index_mode.js.
  import { Button } from '$lib/components/ui/button/index.js';
  import { error } from '../lib/stores.js';
  import {
    rotateIndexOpen, rotationSteps, rotationTeeth, changeRotation, exitRotateIndexMode,
    cancelRotateIndexMode,
  } from '../lib/rotate_index_mode.js';
  import { rotationRange, formatRotation, ROTATION_STEP } from '../lib/rotate_index.js';
  import Slider from './Slider.svelte';

  // EditPanel's, ScaleHeightPanel's and ResizeGirdlePanel's two buttons, verbatim: the modes' ways
  // out look and sit alike.
  const ACTION = 'h-8 flex-1 border-[var(--panel-edge)] bg-[var(--raised)] px-3 text-[13px] text-[var(--text)] shadow-none hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:border-[var(--accent)] dark:hover:bg-[var(--hover)]';

  const teeth = $derived($rotationTeeth ?? 96);
  const range = $derived(rotationRange(teeth));
  const spec = $derived({ min: range.min, max: range.max, step: ROTATION_STEP });
  const text = $derived(formatRotation($rotationSteps, teeth));
  const tip = $derived(`How far to turn the whole design round the index gear, in teeth. Every facet's tooth moves by the same number, wrapping round the ${teeth}-tooth gear; angles and depths stay as they are. Drag it, or press the arrow keys once it has the focus. Click the reading to type a number of teeth.`);
</script>

<div id="rotate-index-panel">
  <!-- The mode's name is in the top bar's mode status (TopBar.svelte's `modeStatus`), as for the
       other modes, not in a title of its own. -->
  <p class="rotate-panel-hint">Drag the slider to turn the whole design round the index gear. Every
    facet's tooth moves by the same number of teeth, wrapping round the gear, and the stone turns
    with it; angles and depths stay as they are. Done keeps the change; Cancel or Escape undoes it.</p>

  <!-- Mounted afresh each time the mode opens, as the other mode panels' `{#if}` blocks are. -->
  {#if $rotateIndexOpen}
    <div class="rotate-panel-card">
      <Slider id="rotate-index-slider" label="Rotation" {tip} {spec} value={$rotationSteps} {text}
        oninput={value => changeRotation(value, false)}
        onchange={() => changeRotation($rotationSteps, true)}
        readoutRead={() => $rotationSteps} readoutWrite={value => changeRotation(value, true)} />
      <!-- The slider's two ends, so its span reads without a hover: one whole turn of the gear. -->
      <div class="rotate-panel-ends" aria-hidden="true">
        <span>{range.min < 0 ? '−' : ''}{Math.abs(range.min)}</span><span>0</span><span>+{range.max}</span>
      </div>
    </div>
  {/if}

  <!-- The render settings' error box is hidden with them, so the same message is shown here: a
       rebuild that fails must say so. -->
  <pre id="rotate-error" style:display={$error.visible ? 'block' : 'none'}>{$error.text}</pre>

  <!-- Both ways out, at the bottom, as in the other modes. Cancel is Escape's twin. -->
  <div class="rotate-panel-actions">
    <Button variant="outline" size="sm" id="rotate-cancel" class={ACTION}
      data-tip="Stops rotating and puts every facet back on the tooth it was on. Escape does the same."
      onclick={cancelRotateIndexMode}>Cancel</Button>
    <Button variant="outline" size="sm" id="rotate-done" class={ACTION + ' border-[var(--accent)] text-[var(--accent)] dark:border-[var(--accent)]'}
      data-tip="Stops rotating and keeps the change as one step Undo can take back, and brings the render settings back."
      onclick={exitRotateIndexMode}>Done</Button>
  </div>
</div>

<style>
  .rotate-panel-hint {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  /* ResizeGirdlePanel's card. */
  .rotate-panel-card {
    margin-bottom: 12px;
    padding: 10px 12px;
    border: 1px solid var(--panel-edge);
    border-radius: var(--radius-card);
  }

  /* The slider row carries panel.css's `.setting` for its look; its bottom margin is for a stack
     of settings, and the ends line sits right under it. */
  .rotate-panel-card :global(.setting) { margin-bottom: 0; }

  .rotate-panel-ends {
    display: flex;
    justify-content: space-between;
    margin-top: 2px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .rotate-panel-actions {
    display: flex;
    gap: 8px;
    margin-top: auto;
    padding-top: 16px;
  }

  #rotate-error {
    margin: 12px 0 0;
    color: var(--error);
    font-size: 11px;
    white-space: pre-wrap;
  }
</style>
