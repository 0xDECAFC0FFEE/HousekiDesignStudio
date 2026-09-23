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

  // `tickLabels` and `readout` are two independent props, not one, even though the Depth
  // ruler below passes both false together (2026-09-22, "get rid of the readout above the
  // depth one too" -- a scope change from an earlier brief that had kept it, since the user
  // was told that costs the only way to type an exact depth and asked for it anyway). They
  // are different pieces of UI with different consequences -- one is a passive number beside
  // a tick, the other is the ruler's only text-entry path -- so a future call site that wants
  // one without the other (numbers but no typing, or vice versa) can already ask for that; a
  // single combined flag would have to be split apart again to allow it, and would leave a
  // reader guessing what it silently bundled.
  let {
    label, value, min, max, step, tick, majorEvery, pxPerUnit, decimals, unit = '', flip = false,
    tickLabels = true, readout = true, onchange,
  } = $props();

  /** How far the tape moves per pixel of pointer travel, in fine mode. */
  const FINE_RATIO = 0.2;
  let fine = $state(false);

  /** The tape's movement per pointer pixel for this event: fine when toggled or Shift is down. */
  const ratioFor = event => (fine || event.shiftKey ? FINE_RATIO : 1);

  // The tape's own height; the scale shows about this many units at a time.
  const HEIGHT = 300;

  // The tick gutter's geometry, ANCHORED TO THE TAPE'S RIGHT EDGE and fixed in size whatever the
  // tape is measured at (`tapeWidth` below): a right margin, then a tick's own length (a major
  // tick longer than a minor one), then a small gap before its label. Before 2026-09-22 these
  // were fixed x coordinates on a tape that was always TICK_RIGHT + 6 = 60px wide; the user then
  // asked that "the edit-mode side bar [be] stretched to fill the bar", so the tape's SVG is now
  // as wide as the column gives it (bind:clientWidth below, stretched by `.value-ruler-tape`'s
  // `align-self: stretch` and `.value-ruler`'s `flex: 1 1 0`), and only the BLANK gutter to the
  // left of the ticks, and the centre line spanning it, grow with that -- the ticks and their
  // labels stay exactly the size they always were, just further from the tape's left edge.
  const RIGHT_MARGIN = 6;
  const SMALL_TICK_LEN = 14;
  const MAJOR_TICK_LEN = 24;
  const LABEL_GAP = 4;
  const CENTRE_LEFT_OVERSHOOT = 8;
  const CENTRE_RIGHT_OVERSHOOT = 4;

  // `tickLabels = false` (the depth ruler, 2026-09-22: "take away the numbers on the depth
  // gage? it's not useful to know what the arbitrary number is in particular" -- distance
  // from centre is an internal unit, unlike the angle ruler's degrees, which stay numbered)
  // drops the per-tick `<text>` below, but keeps the readout above the tape (still
  // click-to-type -- the only way to enter an exact depth) and the major ticks themselves,
  // still longer than the minor ones.
  //
  // The strip immediately left of the ticks -- where a number used to sit -- is deliberately
  // left BLANK, not grown into (2026-09-22). An earlier change the same day extended the depth
  // tape's ticks further left to fill it (`NO_LABEL_EXTRA_TICK_LEN`); the user then asked for
  // the two gauges' ticks to be the same length, so that extension is reversed here and both
  // tapes now draw ticks at the shared `SMALL_TICK_LEN`/`MAJOR_TICK_LEN`. Do not re-add a
  // no-label extension as an "obvious" tidy-up for the gutter -- it was tried and undone.

  // The tape's measured width, in CSS pixels: the old fixed 60px (TICK_RIGHT + 6) until
  // `bind:clientWidth` below reports the real, stretched one, so the first frame looks as it
  // always did rather than momentarily collapsed to 0.
  let tapeWidth = $state(60);

  // The ticks grow with the tape (2026-09-23, the user: "make the tick marks on the angle and
  // depth gauges longer if the screen is wider"), superseding "ticks keep their size" above.
  // A major tick is half the tape's width ("make the wide ticks like half the width of the
  // gauge... also scale the thin ticks by the same amount"), and a minor one keeps its old
  // proportion to it (SMALL_TICK_LEN : MAJOR_TICK_LEN). Neither shrinks below those old
  // lengths on a narrow tape. Both tapes share one row at `flex: 1 1 0`, so they are always
  // the same width and their ticks stay the same length, as the user asked earlier.
  const tickScale = $derived(Math.max(1, tapeWidth / 2 / MAJOR_TICK_LEN));

  const tickRight = $derived(tapeWidth - RIGHT_MARGIN);
  const smallTickLeft = $derived(tickRight - Math.round(SMALL_TICK_LEN * tickScale));
  const majorTickLeft = $derived(tickRight - Math.round(MAJOR_TICK_LEN * tickScale));
  const labelRight = $derived(majorTickLeft - LABEL_GAP);

  // The drag session, and whether one is in progress -- `$state` (not a plain `let`) so the
  // template's `class:dragging` below follows it, for the stronger highlight while actually
  // dragging (2026-09-22, the user: "sliders highlight on hover, and highlight more while being
  // clicked/dragged"). Not `:active`: `onpointerdown` below calls `setPointerCapture`, which
  // keeps the drag's OWN pointer events coming even once the pointer leaves the tape, but a
  // browser's native `:active` state is not guaranteed to survive that the same way, so the
  // highlight is driven from this flag instead, exactly as the task asks.
  let dragging = $state(null);
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

  // Ends a drag exactly as a real release should: the last value is reported `done` (one
  // edit-history entry, not one per pixel), capture is let go explicitly, and the dragging
  // highlight turns off. Three callers, all of them a release by another name (2026-09-22,
  // the stuck-drag bug: "if I'm dragging on a slider then move my mouse off the slider,
  // next time my mouse moves to the slider it'll continue dragging even though I let go
  // already"):
  //   - a real `pointerup` or `pointercancel`;
  //   - `lostpointercapture`, fired if capture is ever taken from us without our asking
  //     (an element swap, the browser reassigning it) -- belt and braces, since nothing
  //     found in this app actually does that to the tape today;
  //   - onpointermove's own button check below, which is the ACTUAL fix for the reported
  //     bug. The investigation (see kb/hover-and-drag-highlights-the-app-s-one-conventi.md)
  //     could not catch a real browser dropping the pointerup itself -- `setPointerCapture`
  //     does not even take effect under this project's own CDP test harness (confirmed on
  //     `viewport.js`'s canvas drag too, whose release-handling was already correct, so this
  //     is a harness/headless-Chrome limitation, not evidence either ruler was fine). The
  //     most plausible real-world trigger is a release that happens outside the BROWSER
  //     WINDOW entirely (the user drags past the edge of the window and lets go over the
  //     desktop or another app): no `pointerup`, no `pointercancel`, nothing is ever sent
  //     to this page for that release, so no listener here could ever catch it directly
  //     -- `viewport.js`'s own `window.addEventListener('blur', ...)` guard exists for
  //     exactly this class of miss, for a different flag. The only thing that CAN catch it
  //     is the next event the page does see once the pointer comes back: an ordinary
  //     `pointermove` reporting the button already up.
  function endDrag(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) {
      return;
    }

    // Mirrors viewport.js's canvas drag (`endDrag` there): release what we asked for, if we
    // still hold it, rather than leaving it to the browser to notice on its own.
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    dragging = null;
    report(shown, true);
  }

  function onpointermove(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) {
      return;
    }

    // THE BACKSTOP (2026-09-22): if the primary button is not down, a release already
    // happened that this page never got a `pointerup` or `pointercancel` for -- see
    // `endDrag`'s comment above. Ending the drag here, on the very next move, is what makes
    // a stuck drag impossible even when the real release is one we could never have seen.
    if ((event.buttons & 1) === 0) {
      endDrag(event);
      return;
    }

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
  {#if readout}
    {#if typing}
      <Input type="text" inputmode="decimal" aria-label="{label} value" bind:ref={entry} bind:value={typed}
        class="h-5 w-[72px] rounded-sm border-primary bg-background px-1 py-0 text-center font-mono text-[12px] text-primary md:text-[12px] dark:bg-background"
        onkeydown={onentrykeydown} onblur={() => finishTyping(true)} />
    {:else}
      <button type="button" class="value-ruler-reading" onclick={startTyping}>{reading}{unit}</button>
    {/if}
  {:else}
    <!-- `readout` false (the depth ruler): no click-to-type button, nothing can call
         `startTyping`, so `typing` can never become true for this instance -- the `{#if
         typing}` branch above stays dead code at this call site without needing a separate
         guard. This spacer keeps the SAME box (same class, so the same font, padding and
         border-bottom the real reading has) so the tape below starts at the same height as
         the angle ruler's beside it, whose reading IS shown; without it the two tapes'
         centre lines would not line up (2026-09-22). `visibility: hidden`, not `display:
         none`: it must still take up the layout space, just paint and announce nothing --
         `aria-hidden` on top of that belongs to the accessible-name story, not the layout
         one. The depth value is still announced: `aria-valuetext`/`aria-valuenow` on the
         tape below are unconditional, and are now the only thing that does it. -->
    <span class="value-ruler-reading value-ruler-reading-hidden" aria-hidden="true">&nbsp;</span>
  {/if}
  <div class="value-ruler-tape" class:dragging={dragging !== null} role="slider" tabindex="0"
    aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={shown}
    aria-valuetext="{reading}{unit}" bind:clientWidth={tapeWidth}
    {onpointerdown} {onpointermove} onpointerup={endDrag} onpointercancel={endDrag}
    onlostpointercapture={endDrag} {onwheel} {onkeydown}>
    <svg width={tapeWidth} height={HEIGHT} aria-hidden="true">
      {#each ticks as mark (mark.value)}
        {@const y = Math.round(centre - direction * mark.offset * pxPerUnit) + (mark.major ? 0 : 0.5)}
        <line class={mark.major ? 'tick major' : 'tick'} x1={mark.major ? majorTickLeft : smallTickLeft}
          x2={tickRight} y1={y} y2={y} />
        {#if mark.major && tickLabels}
          <text class="tick-label" x={labelRight} y={y}>{mark.value.toFixed(majorEvery * tick < 1 ? decimals : 0)}</text>
        {/if}
      {/each}
      <!-- The centre line: what the reading above the tape is taken at. Spans the tape's whole
           measured width (2026-09-22), not just the fixed tick gutter, so it reads as one line
           across a stretched column rather than a short dash left over in the middle of one. -->
      <line class="centre" x1={majorTickLeft - CENTRE_LEFT_OVERSHOOT} x2={tickRight + CENTRE_RIGHT_OVERSHOOT}
        y1={centre + 0.5} y2={centre + 0.5} />
    </svg>
  </div>
  <button type="button" class="value-ruler-fine" aria-pressed={fine}
    data-tip="Fine adjustment: the {label.toLowerCase()} moves a fifth as far as the pointer does. Holding Shift does the same while it is held."
    onclick={() => { fine = !fine; }}>Fine</button>
</div>

<style>
  .value-ruler {
    display: flex;
    /* `flex: 1 1 0`, not `none` (2026-09-22, the user: "the two rulers should spread across the
       full available width"): each ValueRuler now takes an equal share of .edit-panel-rulers'
       row, splitting the column's whole width between the two rather than sitting at its own
       content width in the middle of it. `min-width: 0` lets it shrink below its label/reading's
       own width if the column is ever narrower than that -- the label, reading and Fine button
       stay centred over it (`align-items: center` below is unchanged), only the tape itself
       (`.value-ruler-tape`, `align-self: stretch`) fills the extra room. */
    flex: 1 1 0;
    min-width: 0;
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

  /* `readout = false`'s spacer (2026-09-22): same box as the real reading above, so the
     column's height above the tape does not change, just invisible and inert. See the
     template comment where this is used. */
  .value-ruler-reading-hidden {
    visibility: hidden;
    pointer-events: none;
  }

  /* Matches every other click-to-type readout's hover (panel.css's `.setting .value.editable`,
     instructions.css's `.editable`): the dotted underline brightens to the accent colour, the
     one thing here missing a hover state (2026-09-22, "every button highlights on hover"). */
  .value-ruler-reading:hover { border-bottom-color: var(--accent); }

  .value-ruler-tape {
    position: relative;
    /* Fills `.value-ruler`'s width (`align-items: center` there would otherwise size this to its
       own SVG's width, same as every other child) while the label, reading and Fine button stay
       centred at their own content width -- see `.value-ruler`'s comment above. */
    align-self: stretch;
    cursor: grab;
    touch-action: none;
    user-select: none;
    outline: none;
    /* Fades out at both ends rather than being cut off, like the index ruler. */
    mask-image: linear-gradient(to bottom, transparent, black 10%, black 90%, transparent);
  }

  .value-ruler-tape:active { cursor: grabbing; }

  /* A hover highlight, and a stronger one while it is actually being dragged (2026-09-22, the
     user: "sliders highlight on hover, and highlight more while being clicked/dragged"). Driven
     off the `dragging` state above, not `:active`: `onpointerdown` calls `setPointerCapture`, so
     the drag keeps running once the pointer leaves the tape, but there is no guarantee a
     browser's native `:active` state survives that the same way, and the task is explicit that
     it should not be trusted for exactly this reason. Same `inset` box-shadow language as
     `:focus-visible`, just thicker while dragging, so hover/focus/drag read as one family of
     highlight. `.dragging` (two classes) naturally outranks the one-class `:hover`/
     `:focus-visible` rules by specificity, so it wins whichever pseudo-class is also true. */
  /* Drawn on a `::before` layer faded top to bottom on a sine curve, not on the tape itself --
     see IndexRuler.svelte's `#index-ruler::before` for why, and for the `z-index: -1`. */
  .value-ruler-tape::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    mask-image: linear-gradient(to bottom, var(--sine-fade));
  }

  .value-ruler-tape:hover::before { box-shadow: inset 0 0 0 1px var(--accent); }

  .value-ruler-tape:focus-visible::before { box-shadow: inset 0 0 0 1px var(--accent); }

  .value-ruler-tape.dragging::before { box-shadow: inset 0 0 0 2px var(--accent); background: var(--hover); }

  svg { display: block; }

  .tick { stroke: var(--panel-edge); stroke-width: 1; }
  /* Thicker than the minor ticks (2026-09-23, the user: "make the wide ticks ... thicker").
     The template puts a major tick's y on a whole pixel, and a 1px minor one's on a half
     pixel, so each covers whole device pixels and draws crisp. */
  .tick.major { stroke: var(--muted); stroke-width: 2; }

  .centre { stroke: var(--accent); stroke-width: 2; }

  .tick-label {
    fill: var(--muted);
    font: 9px ui-monospace, Menlo, monospace;
    text-anchor: end;
    dominant-baseline: central;
  }
</style>
