<script>
  // A vertical tape ruler, the index ruler's twin turned on its side (2026-09-19, the user:
  // "two vertical sliders like the ruler"). The value sits against a fixed centre line, larger
  // values upwards; the tape is dragged with the pointer, the wheel or the arrow keys. Unlike
  // the index ruler it does not wrap: it stops at both ends of its scale.
  //
  // Dragging the tape moves it with the pointer, as a strip of paper would: down is down. With
  // `flip` the scale runs the other way (larger values downwards), for the crown's angle, where 0
  // is at the top and 90 at the bottom (the user, 2026-09-19). A Fine toggle beside the label, or
  // Shift held, makes a drag move the tape a fifth as far as the pointer ("when I drag my mouse 5
  // pixels, the slider only changes by one pixel").
  //
  // It reports every change as it happens (`onchange(value, done)`), so the stone follows the
  // drag, with `done` true on release -- what the caller records in the edit history as one
  // edit, rather than one per pixel.
  import { visibleValueTicks, clampValue, snapValue } from '../lib/facet_edit.js';
  import { Input } from '$lib/components/ui/input/index.js';

  let {
    label, value, min, max, step, tick, majorEvery, pxPerUnit, decimals, unit = '', flip = false,
    onchange,
  } = $props();

  /** How far the tape moves per pixel of pointer travel, in fine mode. */
  const FINE_RATIO = 0.2;
  let fine = $state(false);

  /** The tape's movement per pointer pixel for this event: fine when toggled or Shift is down. */
  const ratioFor = event => (fine || event.shiftKey ? FINE_RATIO : 1);

  // The tape's own height; the scale shows about this many units at a time.
  const HEIGHT = 300;
  // Where the ticks start and end across the tape, and where the labels sit.
  const TICK_RIGHT = 54;
  const SMALL_TICK_LEFT = 40;
  const MAJOR_TICK_LEFT = 30;
  const LABEL_RIGHT = 26;

  let dragging = null;
  // What the tape shows WHILE it is being dragged. The design is written on its own budget (see
  // work_budget.js), so the value coming back in `value` can lag a frame or two behind the
  // pointer; the tape and its reading follow the pointer itself and never stutter with the
  // renderer. Null when not dragging, when the tape simply shows the value it is given.
  let dragged = $state(null);
  const shown = $derived(dragged ?? value);
  const centre = $derived(HEIGHT / 2);
  const ticks = $derived(visibleValueTicks(shown, HEIGHT / 2 / pxPerUnit, tick, majorEvery, min, max));
  // Which way a tick's offset from the centre goes on screen: up for larger values, unless flipped.
  const direction = $derived(flip ? -1 : 1);
  const reading = $derived(shown.toFixed(decimals));

  /** Reports a value, snapped to the step and kept inside the scale. */
  function report(raw, done) {
    const next = snapValue(clampValue(raw, min, max), step);

    // The tape moves now; the caller catches up when it can, and `done` hands it back.
    dragged = done ? null : next;
    onchange(next, done);
  }

  // The reading can be clicked to type an exact value (the user's request, 2026-09-19), the same
  // as the settings panel's slider readouts: Enter or leaving the box applies it, Escape cancels,
  // and anything that does not start with a number is ignored. A value outside the scale is held
  // to it, and one between steps snapped to the step, like a drag. Applied as one finished edit.
  let typing = $state(false);
  let typed = $state('');
  let entry = $state(null);

  function startTyping() {
    // Rounded so float noise is not what the user sees.
    typed = String(Number(shown.toFixed(4)));
    typing = true;
  }

  function finishTyping(apply) {
    if (!typing) {
      return;
    }

    // parseFloat accepts a trailing unit, so "23°" typed back in still works.
    const value = parseFloat(typed);

    typing = false;

    if (apply && Number.isFinite(value)) {
      report(value, true);
    }
  }

  function onentrykeydown(event) {
    if (event.key === 'Enter') {
      finishTyping(true);
    } else if (event.key === 'Escape') {
      // Cancels the typing and nothing else: Escape elsewhere leaves edit mode.
      event.stopPropagation();
      finishTyping(false);
    }
  }

  $effect(() => {
    if (entry) {
      entry.focus();
      entry.select();
    }
  });

  function onpointerdown(event) {
    if (event.button !== 0) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    dragging = { pointerId: event.pointerId, y: event.clientY, value: shown, ratio: ratioFor(event) };
  }

  function onpointermove(event) {
    if (dragging && event.pointerId === dragging.pointerId) {
      const ratio = ratioFor(event);

      // Switching between fine and normal mid-drag carries on from where the tape is, rather
      // than jumping to where the pointer's whole travel would put it at the new ratio.
      if (ratio !== dragging.ratio) {
        dragging = { ...dragging, y: event.clientY, value: shown, ratio };
      }

      // The tape follows the pointer: dragging it down moves the tape down, which brings the
      // values above the centre to it (the smaller ones on a flipped scale).
      report(dragging.value + direction * dragging.ratio * (event.clientY - dragging.y) / pxPerUnit, false);
    }
  }

  function onpointerup(event) {
    if (dragging && event.pointerId === dragging.pointerId) {
      dragging = null;
      report(shown, true);
    }
  }

  function onwheel(event) {
    event.preventDefault();
    report(shown - direction * ratioFor(event) * event.deltaY / pxPerUnit, true);
  }

  function onkeydown(event) {
    // Up moves toward the top of the scale, whichever end of the values that is.
    const moves = {
      ArrowUp: direction * step, ArrowDown: -direction * step,
      PageUp: direction * tick * majorEvery, PageDown: -direction * tick * majorEvery,
      Home: (flip ? min : max) - shown, End: (flip ? max : min) - shown,
    };

    if (event.key in moves) {
      event.preventDefault();
      report(shown + moves[event.key], true);
    }
  }
</script>

<div class="value-ruler">
  <span class="value-ruler-label">{label}</span>
  {#if typing}
    <Input type="text" inputmode="decimal" aria-label="{label} value" bind:ref={entry} bind:value={typed}
      class="h-5 w-[72px] rounded-sm border-primary bg-background px-1 py-0 text-center font-mono text-[12px] text-primary md:text-[12px] dark:bg-background"
      onkeydown={onentrykeydown} onblur={() => finishTyping(true)} />
  {:else}
    <button type="button" class="value-ruler-reading" onclick={startTyping}>{reading}{unit}</button>
  {/if}
  <div class="value-ruler-tape" role="slider" tabindex="0" aria-label={label} aria-valuemin={min}
    aria-valuemax={max} aria-valuenow={shown} aria-valuetext="{reading}{unit}"
    {onpointerdown} {onpointermove} {onpointerup} onpointercancel={onpointerup} {onwheel} {onkeydown}>
    <svg width={TICK_RIGHT + 6} height={HEIGHT} aria-hidden="true">
      {#each ticks as mark (mark.value)}
        {@const y = Math.round(centre - direction * mark.offset * pxPerUnit) + 0.5}
        <line class={mark.major ? 'tick major' : 'tick'} x1={mark.major ? MAJOR_TICK_LEFT : SMALL_TICK_LEFT}
          x2={TICK_RIGHT} y1={y} y2={y} />
        {#if mark.major}
          <text class="tick-label" x={LABEL_RIGHT} y={y}>{mark.value.toFixed(majorEvery * tick < 1 ? decimals : 0)}</text>
        {/if}
      {/each}
      <!-- The centre line: what the reading above the tape is taken at. -->
      <line class="centre" x1={MAJOR_TICK_LEFT - 8} x2={TICK_RIGHT + 4} y1={centre + 0.5} y2={centre + 0.5} />
    </svg>
  </div>
  <button type="button" class="value-ruler-fine" aria-pressed={fine}
    data-tip="Fine adjustment: the {label.toLowerCase()} moves a fifth as far as the pointer does. Holding Shift does the same while it is held."
    onclick={() => { fine = !fine; }}>Fine</button>
</div>

<style>
  .value-ruler {
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .value-ruler-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .value-ruler-fine {
    padding: 0 5px;
    border: 1px solid var(--panel-edge);
    border-radius: 3px;
    background: var(--raised);
    color: var(--muted);
    font-size: 9px;
    line-height: 14px;
    text-transform: uppercase;
    cursor: pointer;
  }

  .value-ruler-fine:hover { border-color: var(--accent); }

  .value-ruler-fine[aria-pressed="true"] {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--on-accent);
  }

  .value-ruler-label {
    color: var(--muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .value-ruler-reading {
    padding: 0;
    border: 0;
    border-bottom: 1px dotted var(--panel-edge);
    background: none;
    cursor: text;
    color: var(--accent);
    font: 700 13px ui-monospace, Menlo, monospace;
  }

  .value-ruler-tape {
    position: relative;
    cursor: grab;
    touch-action: none;
    user-select: none;
    outline: none;
    /* Fades out at both ends rather than being cut off, like the index ruler. */
    mask-image: linear-gradient(to bottom, transparent, black 10%, black 90%, transparent);
  }

  .value-ruler-tape:active { cursor: grabbing; }

  .value-ruler-tape:focus-visible { box-shadow: inset 0 0 0 1px var(--accent); }

  svg { display: block; }

  .tick { stroke: var(--panel-edge); stroke-width: 1; }
  .tick.major { stroke: var(--muted); }

  .centre { stroke: var(--accent); stroke-width: 2; }

  .tick-label {
    fill: var(--muted);
    font: 9px ui-monospace, Menlo, monospace;
    text-anchor: end;
    dominant-baseline: central;
  }
</style>
