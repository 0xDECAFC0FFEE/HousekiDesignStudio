<script>
  // Sub bar (T-0141): a thinner row below the menu bar for the tools a cutter reaches for
  // constantly. Starts with the index-gear button, which reads the loaded design's real
  // tooth count -- 96 (DEFAULT_GEAR_TEETH) for the built-in stone, and whatever a loaded
  // GemCad design's own gear says otherwise. A plain .obj carries no faceting design at all,
  // so opening one resets the reading to 96 too. Clicking it opens the gear dialog (T-0171,
  // replacing T-0141's deliberate no-op placeholder); `onopen` is how App reaches the dialog.
  //
  // Independent of GemApp, like the top bar, so it works even if the wasm module fails to
  // load. No data-tip here -- see the CSS comment above #subbar.
  //
  // The button is shadcn-svelte's ghost Button.
  //
  // T-0192: the bar holds the index-gear tooth of a facet. Left to right: the gear button, the
  // scrolling ruler (IndexRuler.svelte), and on the right the symmetry and offset numbers. The
  // symmetry must divide the tooth count, so every copy lands on a whole tooth; a value that
  // does not is shown in red and not applied. The offset is any whole number of teeth, 0 for none.
  import { untrack } from 'svelte';
  import { gearTeeth } from '../lib/gear.js';
  import {
    rulerSymmetry, rulerOffset, symmetryFits, indexMode, arbitraryIndices, parseIndexList,
    rulerResets, rulerFine,
  } from '../lib/index_ruler.js';
  import { getDesign } from '../lib/tier_controller.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import IndexRuler from './IndexRuler.svelte';

  let { onopen } = $props();

  // What is typed in each field, kept apart from the stores so a half-typed or refused value
  // stays on screen while the ruler goes on showing the last good one.
  let symmetryText = $state(String($rulerSymmetry));
  let offsetText = $state(String($rulerOffset));

  // A load resets the stores (resetRuler); the fields follow.
  $effect(() => { symmetryText = String($rulerSymmetry); });
  $effect(() => { offsetText = String($rulerOffset); });

  const symmetryValue = $derived(Number(symmetryText));
  const symmetryBad = $derived(!symmetryFits(symmetryValue, $gearTeeth));
  const offsetBad = $derived(!/^\s*-?\d+\s*$/.test(offsetText));

  function onsymmetryinput(event) {
    symmetryText = event.currentTarget.value;

    if (symmetryFits(Number(symmetryText), $gearTeeth)) {
      rulerSymmetry.set(Number(symmetryText));
    }
  }

  function onoffsetinput(event) {
    offsetText = event.currentTarget.value;

    if (/^\s*-?\d+\s*$/.test(offsetText)) {
      rulerOffset.set(Number(offsetText));
    }
  }

  // Arbitrary mode (2026-09-19, chosen in the gear dialog): no ruler, symmetry or offset, only a
  // box of indexes typed by hand, separated by dashes as the cutting instructions print them
  // (commas and spaces work too). A list with an entry that is not on the gear is shown in red,
  // with the reason in its tooltip, and not applied.
  let indexText = $state('');

  // The box shows the list the mode switch or a new stone set (enterArbitraryMode, resetRuler:
  // the teeth the ruler had highlighted); from then on it is the user's typing. Only the mode and
  // the reset count are dependencies, so typing (which sets the store) never rewrites the box.
  $effect(() => {
    $rulerResets;
    if ($indexMode === 'arbitrary') {
      indexText = (untrack(() => $arbitraryIndices) ?? []).join('-');
    }
  });

  const indexParse = $derived(parseIndexList(indexText, $gearTeeth, Boolean(getDesign()?.gear.fractional)));

  function onindexinput(event) {
    indexText = event.currentTarget.value;

    const parsed = parseIndexList(indexText, $gearTeeth, Boolean(getDesign()?.gear.fractional));

    // A refused list is no list: switching back to symmetric mode then refuses too, rather than
    // quietly converting the last good one.
    arbitraryIndices.set(parsed.error === null ? parsed.indices : null);
  }

  // Leaving a field with a refused value in it puts back the value in use.
  function onsymmetryblur() {
    if (symmetryBad && symmetryFits($rulerSymmetry, $gearTeeth)) {
      symmetryText = String($rulerSymmetry);
    }
  }

  function onoffsetblur() {
    if (offsetBad) {
      offsetText = String($rulerOffset);
    }
  }
</script>

<div id="subbar">
  <!-- A plain raised button, bordered like the panel's buttons, so it reads as something to
       click (the user's request, 2026-09-19: "make the gear wheel more clearly a button with a
       small drawn gear wheel left of the 96"). The gear is an 8-tooth outline with a hole, drawn
       here rather than a font glyph. -->
  <Button variant="outline" size="sm"
    class="toolbar-button h-8 gap-1.5 border-[var(--panel-edge)] bg-[var(--raised)] px-2.5 py-0 text-[13px] font-normal text-[var(--text)] shadow-none hover:border-[var(--accent)] hover:bg-[var(--raised)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:border-[var(--accent)] dark:hover:bg-[var(--raised)]"
    id="gear-button" aria-label="Index gear" onclick={onopen}
    data-tip="The index gear the stone is cut on, and how many teeth it has. Click to change the tooth count, allow fractional teeth, or switch between setting indexes from the ruler and typing them by hand.">
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" fill-rule="evenodd" d="M10.40 3.96 L10.71 1.08 L13.29 1.08 L13.60 3.96 L16.56 5.18 L18.81 3.36 L20.64 5.19 L18.82 7.44 L20.04 10.40 L22.92 10.71 L22.92 13.29 L20.04 13.60 L18.82 16.56 L20.64 18.81 L18.81 20.64 L16.56 18.82 L13.60 20.04 L13.29 22.92 L10.71 22.92 L10.40 20.04 L7.44 18.82 L5.19 20.64 L3.36 18.81 L5.18 16.56 L3.96 13.60 L1.08 13.29 L1.08 10.71 L3.96 10.40 L5.18 7.44 L3.36 5.19 L5.19 3.36 L7.44 5.18ZM15.2 12a3.2 3.2 0 1 0-6.4 0a3.2 3.2 0 1 0 6.4 0Z"/>
    </svg>
    <span id="gear-teeth">{$gearTeeth}</span>
  </Button>

  {#if $indexMode === 'arbitrary'}
  <label class="index-list-field" data-tip={indexParse.error ??
    'The facet\'s indexes, typed by hand: separate them with dashes, commas or spaces.'}>
    <span>Indexes</span>
    <input id="index-list" type="text" inputmode="numeric" spellcheck="false" autocomplete="off"
      placeholder="e.g. 4-12-20" value={indexText} aria-invalid={indexParse.error !== null}
      oninput={onindexinput} />
  </label>
  {:else}
  <IndexRuler />

  <button type="button" id="ruler-fine" class="fine-toggle" aria-pressed={$rulerFine}
    data-tip="Fine adjustment: the ruler moves a fifth as far as the pointer does. Holding Shift does the same while it is held."
    onclick={() => rulerFine.update(on => !on)}>Fine</button>

  <label class="ruler-field" data-tip={symmetryBad
    ? `Symmetry must divide the ${$gearTeeth}-tooth gear, so every copy lands on a tooth.`
    : 'How many copies of the facet go equally spaced around the stone.'}>
    <span>Symmetry</span>
    <input id="ruler-symmetry" type="number" min="1" max={$gearTeeth} step="1" inputmode="numeric"
      value={symmetryText} aria-invalid={symmetryBad} oninput={onsymmetryinput} onblur={onsymmetryblur} />
  </label>

  <!-- The offset's wording is the user's own (2026-09-19): "offset for an additional facet after
       each symmetrical copy. 0 for none". -->
  <label class="ruler-field"
    data-tip="Offset for an additional facet after each symmetrical copy, in teeth. 0 for none.">
    <span>Offset</span>
    <input id="ruler-offset" type="number" step="1" inputmode="numeric" value={offsetText}
      aria-invalid={offsetBad} oninput={onoffsetinput} onblur={onoffsetblur} />
  </label>
  {/if}
</div>
