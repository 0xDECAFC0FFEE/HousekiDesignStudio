<script>
  // Edit mode's panel (2026-09-19, the user: "instead of hiding the rendering settings bar, can
  // you change it into an edit mode bar?"). It takes the render settings' place on the right
  // while a tier is being edited, and holds two vertical tape rulers: the facet's angle and its
  // depth. Dragging either changes the design's tier there and then -- the stone is rebuilt from
  // it, the cutting instructions show the new value, and the cutting plane moves with it --
  // and the edit history is told once per drag, on release.
  //
  // Both panels stay mounted side by side in App.svelte's grid, so the column is as wide as the
  // wider of the two (the user's rule) and neither loses its state while the other shows.
  import { angleDecimals } from '../lib/preferences.js';
  import { editing, editDragging, exitEditMode, cancelEditMode } from '../lib/edit_mode.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import {
    tierView, selectedTier, setTierValue, recordTierValue, getDesign,
  } from '../lib/tier_controller.js';
  import { error } from '../lib/stores.js';
  import {
    angleValue, angleFor, isPavilionSide, depthRange, ANGLE_STEP, ANGLE_TICK, DEPTH_STEP, DEPTH_TICK,
  } from '../lib/facet_edit.js';
  import { budgetedTask } from '../lib/work_budget.js';
  import ValueRuler from './ValueRuler.svelte';

  const ACTION = 'h-8 flex-1 border-[var(--panel-edge)] bg-[var(--raised)] px-3 text-[13px] text-[var(--text)] shadow-none hover:bg-[var(--raised)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:bg-[var(--raised)]';

  const tier = $derived($editing?.tier ?? null);

  // Leaving edit mode mid-drag (Cancel, Escape) drops what the drag had queued: the tier it was
  // for is no longer being edited, and a stale start value would poison the next edit's undo.
  $effect(() => {
    if (tier === null) {
      writer.cancel();
      queued = null;
      before = { angle: null, distance: null };
      editDragging.set(false);
    }
  });

  // The tier's own row id (C1, P2, T...), so the panel names what is being edited the way the
  // cutting instructions do.
  const id = $derived([...$tierView.pavilion, ...$tierView.crown]
    .find(row => row.tier === tier)?.id ?? '');

  // Read through the view's key, so an undo, a redo or a gear change moves the sliders too.
  const angle = $derived(($tierView.key, tier ? angleValue(tier) : 0));
  const depth = $derived(($tierView.key, tier ? tier.distance : 0));
  const depths = $derived(getDesign() ? depthRange(getDesign()) : { min: 0, max: 1.5 });

  // The value each slider held when its drag began, so one drag is one entry in the edit
  // history rather than one per pointer move. Null while that slider is not being dragged.
  let before = { angle: null, distance: null };

  // A drag reports a value per pointer move, and each one recuts the stone -- far more work than
  // a pointer move's worth. The newest value therefore waits for a budgeted turn (work_budget.js,
  // 2026-09-19): the design is written at most WRITE_BUDGET of the wall clock, so the tape, the
  // guides and the rest of the page keep the rest and the drag stays smooth however heavy the
  // design is. The scales show the pointer's own value meanwhile (ValueRuler's `dragged`), so
  // nothing on screen waits for the stone.
  // 0.4, not more: one rebuild of a 67-facet design measures 300 ms to 2 s (T-0194), and that
  // call cannot be interrupted, so the page's own share has to be the larger one.
  const WRITE_BUDGET = 0.4;

  let queued = null;

  function flush() {
    if (queued === null || tier === null) {
      return;
    }

    const { field, value, done, label } = queued;

    queued = null;
    // Mid-drag writes skip the bookkeeping the eye cannot see (selection.js's `quick`).
    setTierValue(tier, field, value, { quick: !done });

    if (done) {
      recordTierValue(tier, field, before[field], tier[field], label);
      before[field] = null;
    }
  }

  const writer = budgetedTask({ run: flush, budget: WRITE_BUDGET });

  /** A slider moved: `value` is already snapped and inside the scale. */
  function change(field, value, done, label) {
    if (tier === null) {
      return;
    }

    if (before[field] === null) {
      before[field] = tier[field];
    }

    queued = { field, value, done, label };
    editDragging.set(!done);

    if (done) {
      // The release applies at once, so the stone and the history never lag behind the pointer.
      writer.cancel();
      flush();
    } else {
      writer.request();
    }
  }
</script>

<div id="edit-panel">
  <h2 class="edit-panel-title">Editing {id}</h2>
  <p class="edit-panel-hint">Drag a scale to cut the facet. Done keeps the changes; Cancel or Escape undoes them.</p>

  {#if tier}
    <div class="edit-panel-rulers">
      <!-- The crown's scale runs 0 at the top to 90 at the bottom, the pavilion's the other way. The angle the cutting instructions show: always positive, the tier's own side of the
           girdle kept (facet_edit.js). -->
      <ValueRuler label="Angle" value={angle} min={0} max={90} step={ANGLE_STEP} tick={ANGLE_TICK}
        majorEvery={10} pxPerUnit={6} decimals={$angleDecimals} unit="&deg;" flip={!isPavilionSide(tier)}
        onchange={(value, done) => change('angle', angleFor(tier, value), done, 'Edit angle')} />
      <!-- The facet's distance from the centre of the stone: smaller cuts deeper. -->
      <ValueRuler label="Depth" value={depth} min={depths.min} max={depths.max} step={DEPTH_STEP}
        tick={DEPTH_TICK} majorEvery={10} pxPerUnit={520} decimals={3}
        onchange={(value, done) => change('distance', value, done, 'Edit depth')} />
    </div>

    <p class="edit-panel-teeth">{tier.facets.length} facet{tier.facets.length === 1 ? '' : 's'}
      at {tier.facets.map(facet => facet.index).join('-')}</p>
  {/if}

  <!-- The render settings' error box is hidden with them while editing, so the same message is
       shown here: a rebuild that fails (an angle that no longer closes the stone) must say so. -->
  <pre id="edit-error" style:display={$error.visible ? 'block' : 'none'}>{$error.text}</pre>

  <!-- Both ways out, at the bottom of the panel (the user, 2026-09-19). Cancel is Escape's twin. -->
  <div class="edit-panel-actions">
    <Button variant="outline" size="sm" id="edit-cancel" class={ACTION}
      data-tip="Stops editing and undoes every change made since editing began. Escape does the same."
      onclick={cancelEditMode}>Cancel</Button>
    <Button variant="outline" size="sm" id="edit-done" class={ACTION + ' border-[var(--accent)] text-[var(--accent)] dark:border-[var(--accent)]'}
      data-tip="Stops editing and keeps the changes, and brings the render settings back."
      onclick={exitEditMode}>Done</Button>
  </div>
</div>

<style>
  .edit-panel-title {
    margin: 0 0 4px;
    color: var(--text);
    font-size: 13px;
    font-weight: 700;
  }

  .edit-panel-hint, .edit-panel-teeth {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  .edit-panel-rulers {
    display: flex;
    justify-content: center;
    gap: 18px;
    margin-bottom: 12px;
  }

  .edit-panel-teeth {
    margin: 0;
    font-family: ui-monospace, Menlo, monospace;
    overflow-wrap: anywhere;
  }

  .edit-panel-actions {
    display: flex;
    gap: 8px;
    margin-top: auto;
    padding-top: 16px;
  }

  #edit-error {
    margin: 12px 0 0;
    color: var(--error);
    font-size: 11px;
    white-space: pre-wrap;
  }
</style>
