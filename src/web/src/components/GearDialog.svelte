<script>
  // The gear dialog (T-0171): set the index wheel's tooth count from `#gear-button`, and opt
  // into fractional teeth. The user's own brief, verbatim: "when you click on the gear
  // button, can you bring up a dialog that allows you to set the number of gear teeth and has a
  // check box for fractional teeth... if fractional teeth is unchecked and the user enters in a
  // number that would cause fractional teeth, show a red error symbol next to the count and an
  // error... update all the cutting instructions once the dialog is closed."
  //
  // A shadcn-svelte Dialog (Bits UI: a modal that traps focus, dims the page and closes on
  // Escape), which replaced the native <dialog> this was written with. Starts empty of any error
  // state; `open()` fills in the count and checkbox every time, from whatever design (if any) is
  // loaded. The content is mounted only while the dialog is open, so `#gear-dialog` and the
  // fields inside it exist only then.
  //
  // DECISIONS THIS TICKET MADE, recorded here rather than guessed at silently:
  //
  //   - **Apply is DISABLED while the fields are invalid**, rather than the error merely
  //     blocking a click that still fires. Enter is wired to the SAME `apply()` this button
  //     calls, gated on the SAME check, so neither route can apply an invalid change; Cancel
  //     and Escape never call `apply()` at all, invalid or not.
  //   - **A tooth-count change mutates the loaded design's gear and facet indices IN PLACE**
  //     (`design.gear.*`, and each existing facet object's `.index`) rather than swapping in the
  //     new design `GemCadDesign.reExpressOnGear` returns. This is what keeps every tier and
  //     facet OBJECT the same one `facetTierMap` and the tier rows are keyed by -- see the
  //     header of tier_controller.js and "Drag tier rows to reorder" in
  //     kb/page-and-controls.md for why identity-keying matters here -- so a tooth-count change
  //     needs neither map rebuilt, and the currently selected/highlighted row survives it
  //     (`refresh({ preserveSelection: true })`).
  //   - **The mesh is never rebuilt and the stone is never re-rendered.** A facet's PLANE does
  //     not move when its description does (`reExpressOnGear`'s whole point, proved against
  //     `planesOf` in design_test.js); `apply()` below calls neither rebuildStoneFromDesign nor
  //     `requestRender`, so the canvas is provably untouched by this dialog, not merely
  //     unaffected by coincidence.
  //   - **No design loaded (a plain .obj) is handled honestly, not silently.** `apply()` still
  //     calls `setGearTeeth` (the sub bar's own reading changes, since the user did set a
  //     number), but skips the whole re-expression step -- there is no design to re-express, and
  //     no fractional-teeth question makes sense for one either, so the live validation always
  //     reports no error in this case regardless of what the checkbox is set to.
  //   - **The IME rule from T-0154 applies**, even though neither field here is free text:
  //     Enter and Escape both do nothing while `event.isComposing` (tracked here with
  //     `compositionstart`/`compositionend` too, since the dialog's own native Escape handling
  //     fires a `cancel` event, not a `keydown`, once the browser has already decided to act on
  //     it).
  //   - **Escape and Enter are handled by hand, not via `<form method=dialog>`'s automatic
  //     submit/cancel.** A `<form>` would apply or close before this component's own IME guard,
  //     or the disabled-Apply gate, ever saw the keystroke. Bits UI closes on Escape itself;
  //     `onEscapeKeydown` only vetoes that mid-composition.
  import { get } from 'svelte/store';
  import {
    gearTeeth, setGearTeeth, DEFAULT_GEAR_TEETH, gearSnapshot, sameGearSnapshot,
  } from '../lib/gear.js';
  import { checkGearCount } from '../lib/gear_check.js';
  import {
    indexMode, arbitraryIndices, symmetryFromIndices, enterArbitraryMode, enterSymmetricMode,
    CANNOT_CONVERT,
  } from '../lib/index_ruler.js';
  import { getDesign, refresh, recordEditEntry } from '../lib/tier_controller.js';
  import { listeners } from '../lib/native.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { Label } from '$lib/components/ui/label/index.js';

  let isOpen = $state(false);
  let countInput = $state(null);

  let countText = $state('');
  let fractional = $state(false);
  // Arbitrary mode (2026-09-19): the sub bar takes a facet's indexes typed by hand instead of from
  // the ruler with its symmetry and offset. Applied, like the rest of the dialog, only on Apply.
  let arbitrary = $state(false);
  // The error message, or null while Apply is allowed.
  let error = $state(null);

  // What re-expressing the CURRENTLY LOADED design onto the entered tooth count would produce,
  // recomputed by validate() on every keystroke/checkbox change and read again by apply() --
  // kept rather than recomputed twice so the two can never disagree about what "the entered
  // count" currently means. null whenever there is nothing to preview: no design loaded, or
  // the entered count is not a usable positive whole number.
  let preview = null;

  /**
   * Re-validates the dialog against the CURRENTLY LOADED design (if any) every time the count
   * or the checkbox changes, so the error appears and disappears live as the user types rather
   * than only when they try to apply.
   */
  function validate() {
    const result = checkGearCount(getDesign(), countText, fractional);

    preview = result.preview;
    error = result.error;

    // Leaving arbitrary mode needs the typed list to have a symmetric form on the entered gear
    // (the user's request, 2026-09-19: "error out and refuse to apply").
    if (error === null && get(indexMode) === 'arbitrary' && !arbitrary
      && symmetryFromIndices(get(arbitraryIndices), Number(countText)) === null) {
      error = CANNOT_CONVERT;
    }
  }

  /**
   * Applies the currently-valid preview (a no-op past the disabled check when there is not
   * one), then closes. Mutates the loaded design's gear and each existing facet object's
   * index IN PLACE -- see the header above for why object identity has to survive this -- and
   * refreshes every place teeth are shown: the tier tables and the sub bar's own reading.
   */
  function apply() {
    if (error !== null) {
      // Defensive only: both callers (the Apply button and Enter, below) already gate on
      // this themselves before reaching here.
      return;
    }

    const teeth = Number(countText);
    const design = getDesign();
    const before = gearSnapshot(design);

    if (design && preview) {
      design.gear.teeth = preview.gear.teeth;
      design.gear.reversed = preview.gear.reversed;
      design.gear.originIndex = preview.gear.originIndex;
      design.gear.fractional = preview.gear.fractional;

      design.tiers.forEach((tier, t) => {
        tier.facets.forEach((facet, f) => {
          facet.index = preview.tiers[t].facets[f].index;
        });
      });

      // No mesh rebuild, no re-render: the facet planes did not move (see the header), only
      // their description did.
      refresh({ preserveSelection: true });
    }

    setGearTeeth(teeth);

    // Switching modes carries the facet's indexes across: the ruler's highlighted teeth become
    // the arbitrary list, or the list (already checked by validate) sets the ruler.
    const wasArbitrary = get(indexMode) === 'arbitrary';

    if (arbitrary && !wasArbitrary) {
      enterArbitraryMode(teeth);
    } else if (!arbitrary && wasArbitrary) {
      enterSymmetricMode(teeth);
    }

    // Recorded in the edit history as one update (the user's request, 2026-09-18), undone
    // and redone alongside the tier moves and description edits; nothing if Apply changed
    // nothing.
    const after = gearSnapshot(design);

    if (!sameGearSnapshot(before, after)) {
      recordEditEntry({
        label: 'Change gear',
        ops: [{ kind: 'update', target: 'gear', before, after }],
      });
    }

    close();
  }

  function close() {
    isOpen = false;
  }

  // T-0154's IME rule (see the header for why it applies here too).
  let composing = false;

  function onkeydown(event) {
    if (event.isComposing || composing) {
      return;
    }

    if (event.key === 'Enter') {
      // Neither field here is a multi-line control and there is no <form> to submit, so Enter
      // has no native behaviour of its own to override -- this IS the "Enter applies" binding.
      event.preventDefault();
      apply();
    }
  }

  // Bits UI closes on Escape by itself -- intercepted only to skip it mid-composition; otherwise
  // the default (close, no apply) is exactly "Escape cancels".
  function onEscapeKeydown(event) {
    if (composing) {
      event.preventDefault();
    }
  }

  // Accessibility: focus returns to the gear button however the dialog closed (Cancel, Apply
  // and Escape all end here). The dialog is opened from code, not from a trigger of its own, so
  // Bits UI has no element to return the focus to unless it is told.
  function onCloseAutoFocus(event) {
    event.preventDefault();
    document.getElementById('gear-button')?.focus();
  }

  // The count field takes the focus, its text selected, as the dialog opens.
  function onOpenAutoFocus(event) {
    event.preventDefault();
    countInput?.focus();
    countInput?.select();
  }

  /** Opens the dialog, prefilled from the loaded design (or the sub bar's reading). */
  export function open() {
    const design = getDesign();

    countText = String(design ? design.gear.teeth : (Number(get(gearTeeth)) || DEFAULT_GEAR_TEETH));
    fractional = design ? Boolean(design.gear.fractional) : false;
    arbitrary = get(indexMode) === 'arbitrary';
    validate();
    isOpen = true;
  }
</script>


<Dialog.Root bind:open={isOpen}>
  <Dialog.Content id="gear-dialog" showCloseButton={false}
    class="min-w-[280px] gap-0 rounded-md border border-border p-4 sm:max-w-[320px]"
    aria-describedby={undefined} {onkeydown} {onEscapeKeydown} {onCloseAutoFocus} {onOpenAutoFocus}
    oncompositionstart={() => { composing = true; }} oncompositionend={() => { composing = false; }}>
    <Dialog.Title class="gear-dialog-title mb-3.5 text-sm font-bold" id="gear-dialog-title">Index gear</Dialog.Title>

    <!-- Tooltips (the user's request, 2026-09-19). One `data-tip` per field, on the element that
         wraps the whole field, since tooltipSettingAt takes the outermost one; nothing on
         Dialog.Content itself, which would swallow all three. -->
    <div class="gear-dialog-field-row">
      <div class="gear-dialog-field"
        data-tip="How many teeth the index wheel has, so one turn of the stone is this many index positions. 96 is the usual wheel. Changing it re-describes every facet on the new gear; no facet moves, and the stone is not re-rendered.">
        <Label for="gear-dialog-count" class="text-xs font-normal text-muted-foreground">Number of teeth</Label>
        <Input type="number" id="gear-dialog-count" min="1" step="1" inputmode="numeric"
          class="h-7 w-[100px] rounded-sm px-2 text-xs md:text-xs"
          aria-describedby="gear-dialog-error-text" bind:ref={countInput}
          aria-invalid={error !== null && error !== CANNOT_CONVERT ? 'true' : undefined} value={countText}
          {@attach listeners({ input: event => { countText = event.currentTarget.value; validate(); } })} />
      </div>
    </div>

    <!-- The red error symbol sits beside the message, not beside the count (the user's request,
         2026-09-19), and lives INSIDE this <p> so hiding the <p> hides it. It used to be a
         sibling <svg> with its own `hidden` attribute, which never hid it: `[hidden]` is an
         HTML rule and does nothing to an SVG element, so the symbol showed at all times.
         currentColor + --error so it never needs a colour rule of its own. -->
    <p id="gear-dialog-error" class="gear-dialog-error-text" role="alert" hidden={error === null}>
      <svg class="gear-dialog-error-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.3 L15 14 H1 Z" fill="none" stroke="currentColor" stroke-width="1.3"
          stroke-linejoin="round"/>
        <rect x="7.25" y="5.5" width="1.5" height="4.5" rx="0.75" fill="currentColor"/>
        <rect x="7.25" y="11" width="1.5" height="1.5" rx="0.75" fill="currentColor"/>
      </svg>
      <span id="gear-dialog-error-text">{error ?? ''}</span>
    </p>

    <div class="gear-dialog-checkbox"
      data-tip="Allows indexes that fall between two teeth, such as 4.5. Off, a tooth count that cannot place every facet of this design on a whole tooth is refused.">
      <Checkbox id="gear-dialog-fractional"
        bind:checked={() => fractional, v => { fractional = v; validate(); }} />
      <Label for="gear-dialog-fractional" class="text-xs font-normal">Fractional teeth</Label>
    </div>

    <div class="gear-dialog-checkbox"
      data-tip="Types a facet's indexes by hand in the bar, separated by dashes, instead of setting them from the ruler with a symmetry and an offset. Turning it on carries the ruler's teeth across. Turning it off needs the typed list to be equally spaced, with at most one extra facet after each copy; otherwise it is refused.">
      <Checkbox id="gear-dialog-arbitrary"
        bind:checked={() => arbitrary, v => { arbitrary = v; validate(); }} />
      <Label for="gear-dialog-arbitrary" class="text-xs font-normal">Arbitrary mode</Label>
    </div>

    <div class="gear-dialog-actions">
      <Button variant="outline" size="sm" id="gear-dialog-cancel" onclick={close}>Cancel</Button>
      <Button size="sm" id="gear-dialog-apply" disabled={error !== null} onclick={apply}>Apply</Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
