<script>
  // The index-gear ruler (T-0192): a tape of the gear's teeth that scrolls under a fixed centre
  // and wraps around. Every tooth is a small tick; every `bigTickStep` teeth (the smallest
  // divisor of the tooth count above 4: 6 on a 96 gear, 5 on an 80) is a big one, with its index
  // below it. The tooth under the centre is the facet's index. It, its symmetry copies and their
  // offset copies are all drawn in the accent colour, but only the facet's own tooth and its
  // offset one are numbered above the tape (2026-09-19, the user: "too many numbers is
  // confusing").
  //
  // Drag the tape (or scroll the wheel over it) to move it; on release it snaps to the nearest
  // tooth. The tooth under the centre is recorded as the tape passes it, not only on release, so
  // while a tier is being edited the stone is recut as the ruler is dragged (2026-09-19). With the ruler focused, the arrow keys step one tooth, Page Up/Down one big tick, and
  // Home goes to 0.
  import { onDestroy } from 'svelte';
  import { gearTeeth } from '../lib/gear.js';
  import {
    rulerIndex, rulerSymmetry, rulerOffset, rulerDragging, rulerFine, wrapIndex, bigTickStep, symmetryFits,
    highlightedIndices, labelledIndices, visibleTicks,
  } from '../lib/index_ruler.js';

  // How far apart two teeth are on screen. Twice its old spacing (2026-09-22, the user: "ticks
  // twice as far apart" on the top ruler) -- the wheel handler and `visibleTicks` both divide by
  // this same constant, so widening it alone thins out the ticks without moving anything else.
  const TOOTH_PX = 20;
  // While the Fine toggle is on or Shift is held a drag moves the tape a fifth as far as the pointer, for fine placing.
  const FINE_RATIO = 0.2;
  const fineRatio = event => ($rulerFine || event.shiftKey ? FINE_RATIO : 1);
  // How long the snap to the nearest tooth takes after a release.
  const SNAP_MS = 140;
  // How long after the last wheel event the ruler counts as released.
  const WHEEL_SETTLE_MS = 150;

  // Vertical layout, in px from the top of the ruler: the highlighted indices' baseline, the
  // tick marks' bottom edge and their tops (small, big, highlighted), and the big ticks' labels.
  const HIGHLIGHT_LABEL_Y = 14;
  const TICK_BOTTOM = 38;
  const SMALL_TICK_TOP = 31;
  const BIG_TICK_TOP = 25;
  const HIGHLIGHT_TICK_TOP = 18;
  const BIG_LABEL_Y = 50;

  let width = $state(0);
  // Where the tape is, in teeth: not wrapped, so a drag past tooth 95 keeps going smoothly onto 0.
  // The whole tooth nearest it is the one under the centre.
  let position = $state(0);
  let dragging = null;
  let snapFrame = 0;
  let wheelTimer = 0;

  const teeth = $derived($gearTeeth);
  // A symmetry that no longer fits the gear (the gear dialog changed the tooth count) draws as 1
  // until it is fixed; the field beside the ruler shows it in red meanwhile.
  const symmetry = $derived(symmetryFits($rulerSymmetry, teeth) ? $rulerSymmetry : 1);
  const current = $derived(wrapIndex(Math.round(position), teeth));
  const highlighted = $derived(new Set(highlightedIndices(current, teeth, symmetry, $rulerOffset)));
  // Only the facet's own tooth and its offset one are numbered (the user, 2026-09-19); the
  // symmetry copies are still drawn in the accent colour, without numbers.
  const labelled = $derived(new Set(labelledIndices(current, teeth, $rulerOffset)));
  const ticks = $derived(visibleTicks(position, width / 2 / TOOTH_PX + 1, teeth));
  const step = $derived(bigTickStep(teeth));

  // The store changed from outside (a new stone loaded, the gear changed): move the tape to the
  // copy of that tooth nearest where it is now, so it never spins round the long way.
  const unsubscribe = rulerIndex.subscribe(index => {
    if (dragging || teeth <= 0) {
      return;
    }

    const here = wrapIndex(Math.round(position), teeth);

    if (index !== here) {
      let delta = wrapIndex(index - here, teeth);

      if (delta > teeth / 2) {
        delta -= teeth;
      }

      position = Math.round(position) + delta;
    }
  });

  onDestroy(() => {
    unsubscribe();
    cancelAnimationFrame(snapFrame);
    clearTimeout(wheelTimer);
  });

  // Snaps the tape to the nearest tooth, easing there, and records that tooth as the index.
  function snap() {
    cancelAnimationFrame(snapFrame);

    const from = position;
    const to = Math.round(position);
    const start = performance.now();

    rulerIndex.set(wrapIndex(to, teeth));

    const frame = now => {
      const t = Math.min(1, (now - start) / SNAP_MS);
      position = from + (to - from) * (1 - (1 - t) * (1 - t));

      if (t < 1) {
        snapFrame = requestAnimationFrame(frame);
      }
    };

    snapFrame = requestAnimationFrame(frame);
  }

  function onpointerdown(event) {
    if (event.button !== 0) {
      return;
    }

    cancelAnimationFrame(snapFrame);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging = { pointerId: event.pointerId, x: event.clientX, position, ratio: fineRatio(event) };
    // The whole drag is one edit (see rulerDragging).
    rulerDragging.set(true);
  }

  /**
   * Records the tooth now under the centre, if it is not the one already recorded (2026-09-19,
   * the user: "the render should update as the ruler is dragged... should be fast"). The facet
   * moves round the stone as the tape passes each tooth, exactly as the angle and depth scales
   * cut while they are dragged: the write itself is budgeted and the whole drag settles into one
   * entry in the edit history (edit_mode.js), so this stays cheap however heavy the design is.
   */
  function noteTooth() {
    const tooth = wrapIndex(Math.round(position), teeth);

    if (tooth !== $rulerIndex) {
      rulerIndex.set(tooth);
    }
  }

  function onpointermove(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) {
      return;
    }

    // THE BACKSTOP (2026-09-22, the stuck-drag bug: "if I'm dragging on a slider then move
    // my mouse off the slider, next time my mouse moves to the slider it'll continue
    // dragging even though I let go already"). If the primary button is not down, a release
    // already happened that this ruler never got a `pointerup` or `pointercancel` for --
    // see `endDrag`'s comment below for what that release most likely was. Ending the drag
    // here, on the very next move, is what makes a stuck drag impossible even when the real
    // release is one we could never have seen.
    if ((event.buttons & 1) === 0) {
      endDrag(event);
      return;
    }

    // Dragging the tape left brings higher teeth under the centre, like pulling a tape measure.
    const ratio = fineRatio(event);

    // Pressing or releasing Shift mid-drag carries on from where the tape is.
    if (ratio !== dragging.ratio) {
      dragging = { ...dragging, x: event.clientX, position, ratio };
    }

    position = dragging.position - dragging.ratio * (event.clientX - dragging.x) / TOOTH_PX;
    noteTooth();
  }

  // Ends a drag exactly as a real release should: capture is let go explicitly, the drag
  // highlight (`$rulerDragging`) turns off, and the tape snaps to the nearest tooth -- the
  // same three callers as ValueRuler's own `endDrag` (see its longer comment for what these
  // are and why `setPointerCapture` cannot be trusted to make a real `pointerup` arrive):
  // a real `pointerup` or `pointercancel`, `lostpointercapture` (belt and braces), and
  // `onpointermove`'s own button check above, which is the actual fix for the reported bug.
  function endDrag(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) {
      return;
    }

    // Mirrors viewport.js's canvas drag: release what we asked for, if we still hold it,
    // rather than leaving it to the browser to notice on its own.
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    dragging = null;
    // Cleared before the snap, whose own write is then the one that settles the drag.
    rulerDragging.set(false);
    snap();
  }

  function onwheel(event) {
    event.preventDefault();
    cancelAnimationFrame(snapFrame);

    // A trackpad's sideways swipe moves the tape the way it moves; a mouse wheel's vertical
    // scroll moves it one tooth per notch-ish (100px is a common notch).
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    position += fineRatio(event) * delta / TOOTH_PX / (event.deltaMode === 1 ? 0.1 : 1);
    noteTooth();

    rulerDragging.set(true);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { rulerDragging.set(false); snap(); }, WHEEL_SETTLE_MS);
  }

  function onkeydown(event) {
    const moves = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: step, PageDown: -step };

    if (event.key in moves) {
      event.preventDefault();
      position = Math.round(position) + moves[event.key];
      snap();
    } else if (event.key === 'Home') {
      event.preventDefault();
      position = Math.round(position) - current;
      snap();
    }
  }
</script>

<div id="index-ruler" class:dragging={$rulerDragging} role="slider" tabindex="0" aria-label="Index"
  aria-valuemin="0" aria-valuemax={teeth - 1} aria-valuenow={current} bind:clientWidth={width}
  {onpointerdown} {onpointermove} onpointerup={endDrag} onpointercancel={endDrag}
  onlostpointercapture={endDrag} {onwheel} {onkeydown}>
  <svg width={width} height="57" aria-hidden="true">
    {#each ticks as tick (tick.offset + position)}
      {@const x = Math.round(width / 2 + tick.offset * TOOTH_PX) + 0.5}
      {@const lit = highlighted.has(tick.index)}
      <line class={lit ? 'tick lit' : tick.big ? 'tick big' : 'tick'} x1={x} x2={x} y2={TICK_BOTTOM}
        y1={lit ? HIGHLIGHT_TICK_TOP : tick.big ? BIG_TICK_TOP : SMALL_TICK_TOP} />
      {#if labelled.has(tick.index)}
        <text class={tick.index === current ? 'lit-label current' : 'lit-label'} x={x}
          y={HIGHLIGHT_LABEL_Y}>{tick.index}</text>
      {/if}
      {#if tick.big}
        <text class="big-label" x={x} y={BIG_LABEL_Y}>{tick.index}</text>
      {/if}
    {/each}
  </svg>
</div>

<style>
  #index-ruler {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    height: 57px;
    overflow: hidden;
    cursor: grab;
    touch-action: none;
    user-select: none;
    outline: none;
    /* The tape fades out at both ends rather than being cut off. */
    mask-image: linear-gradient(to right, transparent, black 12%, black 88%, transparent);
  }

  #index-ruler:active { cursor: grabbing; }

  /* A hover highlight, and a stronger one while it is actually being dragged (2026-09-22, the
     user: "sliders highlight on hover, and highlight more while being clicked/dragged" --
     extended to this hand-drawn ruler along with the value rulers below, since the user counts
     it as a slider too). Driven off `$rulerDragging`, not `:active`: this ruler moves the
     pointer with `setPointerCapture`, but Bits UI's own drags do not, and a drag that leaves the
     element while the button is held can drop `:active` in some browsers -- `$rulerDragging` is
     the store the wheel handler and a keyboard step already treat as "a change is in flight", so
     it stays true for exactly as long as the drag or the wheel's settle timer does. Same
     `inset` box-shadow language as the existing `:focus-visible` rule below, just thicker while
     dragging, so hover/focus/drag read as one family of highlight rather than three different
     looks. `.dragging` (two classes) naturally outranks the one-class `:hover`/`:focus-visible`
     rules by specificity, so it wins whichever pseudo-class is also true underneath a drag. */
  #index-ruler:hover { box-shadow: inset 0 0 0 1px var(--accent); }

  #index-ruler:focus-visible { box-shadow: inset 0 0 0 1px var(--accent); }

  #index-ruler.dragging { box-shadow: inset 0 0 0 2px var(--accent); background: var(--hover); }

  svg { display: block; }

  .tick { stroke: var(--panel-edge); stroke-width: 1; }
  .tick.big { stroke: var(--muted); }
  .tick.lit { stroke: var(--accent); stroke-width: 2; }

  text {
    text-anchor: middle;
    font-family: ui-monospace, Menlo, monospace;
  }

  .big-label { fill: var(--muted); font-size: 9px; }

  .lit-label { fill: var(--accent); font-size: 11px; }
  .lit-label.current { font-weight: 700; }
</style>
