<script>
  // The cutting assistant's bar (T-0234, 2026-09-23, the user: "the rendering instructions are
  // replaced with a cutting assistant bar. the cutting assistant bar at the right only has: 4
  // buttons: prev tier, prev cut, next cut, next tier ([<<] [<] [>] [>>]); a slider for scrubbing
  // through the tiers; in very big text the current angle and tooth index; then under those it
  // shows the teeth indices of the tier. ... we also need a done button at the bottom (like in all
  // tools) and escape also can escape").
  //
  // Drawn in the studio's design language (T-0226, kb/the-studio-s-design-language.md): the modes'
  // title and hint, cards with the hairline border, numbers in the mono face, and Done where every
  // mode has it, at the bottom. App.svelte stacks it with the render settings and the other modes'
  // bars in one grid cell. It draws the `cutting` store and hands every press to
  // cutting_assistant_mode.js; what a position means (the current cut, its tier, the phase) is
  // worked out here with cutting_assistant.js's pure functions.
  import { Button } from '$lib/components/ui/button/index.js';
  import { Slider } from '$lib/components/ui/slider/index.js';
  import ChevronsLeftIcon from '@lucide/svelte/icons/chevrons-left';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import ChevronsRightIcon from '@lucide/svelte/icons/chevrons-right';
  import { angleDecimals } from '../lib/preferences.js';
  import { formatTierAngle, formatTierIndex } from '../lib/tiers.js';
  import { cutting, goTo, step, exitCuttingAssistant } from '../lib/cutting_assistant_mode.js';
  import { PAVILION, tierAt, phaseAt, cutState, sliderMarks } from '../lib/cutting_assistant.js';

  // EditPanel's own buttons, verbatim: the modes' ways out look and sit alike.
  const ACTION = 'h-8 flex-1 border-[var(--panel-edge)] bg-[var(--raised)] px-3 text-[13px] text-[var(--text)] shadow-none hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:border-[var(--accent)] dark:hover:bg-[var(--hover)]';
  // The four steps: the same look, square, and faded while they have nowhere to go -- aria-disabled
  // (not `disabled`) so the tooltip still says what they do, the page's one "cannot be used" look
  // (kb/greyed-out-placeholders-in-the-menus-and-settings.md).
  const STEP = ACTION + ' px-0 aria-disabled:cursor-default aria-disabled:opacity-45 aria-disabled:hover:border-[var(--panel-edge)] aria-disabled:hover:bg-[var(--raised)]';

  const sequence = $derived($cutting.sequence);
  const k = $derived($cutting.k);
  const total = $derived(sequence?.total ?? 0);
  const finished = $derived(sequence !== null && k >= total);
  // The current cut (cut k + 1), its tier's entry, and where in that tier it is.
  const cut = $derived(sequence && !finished ? sequence.cuts[k] : null);
  const entry = $derived(cut ? sequence.tiers[tierAt(sequence, k)] : null);
  const phase = $derived(sequence ? phaseAt(sequence, k) : PAVILION);
  const marks = $derived(sequence ? sliderMarks(sequence) : { ticks: [], transfer: null });
  // The current tier's cuts, as indices into `sequence.cuts`.
  const teeth = $derived(entry ? Array.from({ length: entry.end - entry.start }, (_, i) => entry.start + i) : []);

  const atStart = $derived(k <= 0);
  const atEnd = $derived(finished);

  /** Where along the slider position `at` sits, as a CSS percentage. */
  function along(at) {
    return `${total > 0 ? (at / total) * 100 : 0}%`;
  }

  /** A step button was pressed: nothing at an end, where it is inert. */
  function press(inert, action) {
    if (!inert) {
      action();
    }
  }
</script>

<div id="cutting-panel">
  <h2 class="cutting-panel-title">Cutting assistant</h2>
  <p class="cutting-panel-hint">Steps through the cutting instructions one facet at a time, from a
    rough cube on the dop. Nothing in the design changes. Done or Escape closes it.</p>

  {#if sequence}
    <div class="cutting-panel-card">
      <!-- The four steps, in the user's order. -->
      <div class="cutting-panel-steps" role="group" aria-label="Step through the cuts">
        <Button variant="outline" size="sm" id="cutting-prev-tier" class={STEP}
          aria-disabled={String(atStart)} aria-label="Previous tier"
          data-tip="Previous tier: back to the first facet of this tier, or of the tier before once none of this one is cut."
          onclick={() => press(atStart, step.prevTier)}><ChevronsLeftIcon /></Button>
        <Button variant="outline" size="sm" id="cutting-prev-cut" class={STEP}
          aria-disabled={String(atStart)} aria-label="Previous cut"
          data-tip="Previous cut: puts the last facet cut back on the rough."
          onclick={() => press(atStart, step.prevCut)}><ChevronLeftIcon /></Button>
        <Button variant="outline" size="sm" id="cutting-next-cut" class={STEP}
          aria-disabled={String(atEnd)} aria-label="Next cut"
          data-tip="Next cut: cuts the facet shown below into the rough. After a tier's last facet it moves on to the next tier."
          onclick={() => press(atEnd, step.nextCut)}><ChevronRightIcon /></Button>
        <Button variant="outline" size="sm" id="cutting-next-tier" class={STEP}
          aria-disabled={String(atEnd)} aria-label="Next tier"
          data-tip="Next tier: cuts the rest of this tier, so the next tier's first facet is next."
          onclick={() => press(atEnd, step.nextTier)}><ChevronsRightIcon /></Button>
      </div>

      <!-- The slider: one step per cut, so a single cut is one notch, with a tick where each tier
           starts and a stronger mark at the transfer. The user asked for "a slider for scrubbing
           through the tiers"; snapping it to tier starts instead would be a one-line change to
           `onValueChange` (T-0234's log). -->
      <div class="cutting-panel-slider" data-tip="Scrub through the cuts. The ticks are where each tier starts; the taller mark is where the dop is moved from the table to the culet.">
        <Slider type="single" id="cutting-slider" min={0} max={total} step={1} value={k}
          thumbLabel="Cuts made" class="py-1"
          onValueChange={v => { if (v !== k) goTo(v); }} />
        <div class="cutting-panel-marks" aria-hidden="true">
          {#each marks.ticks as tick (tick)}
            <span class="cutting-panel-tick" style:left={along(tick)}></span>
          {/each}
          {#if marks.transfer !== null}
            <span class="cutting-panel-transfer" style:left={along(marks.transfer)}></span>
          {/if}
        </div>
        <div class="cutting-panel-count"><span>{k} of {total} cut</span>
          <span>{phase === PAVILION ? 'Pavilion' : 'Crown — transferred'}</span></div>
      </div>
    </div>

    <!-- The cut to make now, in very big text: the angle as the instructions show it (pavilion
         angles positive, the girdle 90) and the tooth on the index gear. -->
    <div class="cutting-panel-card cutting-panel-now" id="cutting-now">
      {#if finished}
        <div class="cutting-panel-finished" id="cutting-finished">Finished</div>
        <p class="cutting-panel-small">All {total} cuts are made. The stone is on the dop at the culet.</p>
      {:else}
        <div class="cutting-panel-big">
          <div>
            <div class="cutting-panel-label">Angle</div>
            <div class="cutting-panel-value" id="cutting-angle">{formatTierAngle(cut.tier, $angleDecimals)}</div>
          </div>
          <div>
            <div class="cutting-panel-label">Index</div>
            <div class="cutting-panel-value" id="cutting-index">{formatTierIndex(cut.facet.index)}</div>
          </div>
        </div>
        <p class="cutting-panel-small" id="cutting-where">Tier {entry.id}, cut {k - entry.start + 1} of
          {entry.end - entry.start}</p>

        <!-- The tier's teeth, each one cut, being cut, or still to cut. -->
        <div class="cutting-panel-teeth" id="cutting-teeth">
          {#each teeth as at (at)}
            <span class="cutting-panel-tooth cutting-panel-tooth-{cutState(at, k)}"
              aria-label="Tooth {formatTierIndex(sequence.cuts[at].facet.index)}, {cutState(at, k) === 'cut' ? 'cut' : cutState(at, k) === 'current' ? 'being cut' : 'to cut'}"
              >{formatTierIndex(sequence.cuts[at].facet.index)}</span>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- The one way out, at the bottom, like every mode's; Escape does the same. There is no Cancel:
       nothing is ever changed, so there is nothing to cancel. -->
  <div class="cutting-panel-actions">
    <Button variant="outline" size="sm" id="cutting-done" class={ACTION + ' border-[var(--accent)] text-[var(--accent)] dark:border-[var(--accent)]'}
      data-tip="Closes the cutting assistant and brings back the finished stone and the render settings. Escape does the same."
      onclick={exitCuttingAssistant}>Done</Button>
  </div>
</div>

<style>
  .cutting-panel-title {
    margin: 2px 0 4px;
    color: var(--text);
    font-size: 14px;
    font-weight: 600;
  }

  .cutting-panel-hint {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  /* A card of the design language (base.css), like the other modes' ruler cards. */
  .cutting-panel-card {
    margin-bottom: 12px;
    padding: 10px 12px;
    border: 1px solid var(--panel-edge);
    border-radius: var(--radius-card);
  }

  .cutting-panel-steps {
    display: flex;
    gap: 6px;
  }

  .cutting-panel-slider {
    position: relative;
    margin-top: 12px;
  }

  /* The marks sit just under the track. The thumb's centre travels the track's full width, so a
     position's percentage along it is where its mark goes. */
  .cutting-panel-marks {
    position: relative;
    height: 8px;
  }

  .cutting-panel-tick, .cutting-panel-transfer {
    position: absolute;
    top: 0;
    width: 1px;
    height: 5px;
    background: var(--muted);
    transform: translateX(-0.5px);
  }

  .cutting-panel-transfer {
    width: 2px;
    height: 8px;
    background: var(--accent);
    transform: translateX(-1px);
  }

  .cutting-panel-count {
    display: flex;
    justify-content: space-between;
    margin-top: 2px;
    color: var(--muted);
    font-size: 11px;
  }

  /* The card is the container the big numbers are sized against, so they grow and shrink with
     the pane (240 to 480px wide, draggable) instead of breaking a number across two lines -- at
     a fixed 40px, "36.58°" wrapped in the pane's default width. A long angle (more decimal places,
     File > Settings) puts the index on a line of its own instead. */
  .cutting-panel-now {
    container-type: inline-size;
  }

  .cutting-panel-big {
    display: flex;
    flex-wrap: wrap;
    column-gap: 16px;
    row-gap: 6px;
  }

  .cutting-panel-label {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }

  /* "In very big text" (the user). The two numbers a cutter sets on the machine. */
  .cutting-panel-value, .cutting-panel-finished {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: clamp(24px, 14cqi, 44px);
    font-weight: 600;
    line-height: 1.1;
    white-space: nowrap;
  }

  .cutting-panel-finished {
    color: var(--accent);
    font-family: inherit;
  }

  .cutting-panel-small {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  .cutting-panel-teeth {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 10px;
  }

  .cutting-panel-tooth {
    min-width: 28px;
    padding: 1px 5px;
    border: 1px solid var(--panel-edge);
    border-radius: var(--radius-control);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12px;
    text-align: center;
  }

  /* Cut: done with, so it fades back like the page's other finished things. */
  .cutting-panel-tooth-cut {
    color: var(--muted);
    opacity: 0.6;
    text-decoration: line-through;
  }

  /* Being cut: the accent, as a selected row is marked. */
  .cutting-panel-tooth-current {
    border-color: var(--accent);
    background: var(--hover);
    color: var(--accent);
    font-weight: 600;
  }

  .cutting-panel-actions {
    display: flex;
    gap: 8px;
    margin-top: auto;
    padding-top: 16px;
  }
</style>
