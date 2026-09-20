<script>
  // Lets a slider's readout be clicked to type an exact value (the page's old
  // `makeReadoutEditable`).
  //
  // The readout is swapped for a text box holding the current value in the readout's unit.
  // Enter or leaving the box applies it; Escape cancels. Anything that does not start with a
  // number is ignored. The value is not limited to the slider's range: `write` decides what
  // to accept (Rust clamps its parameters), and the readout then shows what was applied.
  //
  //   text      what the readout shows now (the parent formats it)
  //   read()    the current value, in the unit `write` takes
  //   write(v)  applies a value; the parent then updates `text`
  //   toDisplay / fromDisplay convert between that unit and the one the readout shows
  import { Input } from '$lib/components/ui/input/index.js';

  let { id, text, read, write, toDisplay = v => v, fromDisplay = v => v } = $props();

  let editing = $state(false);
  let typed = $state('');

  // No "click to type a value" hint, in the tooltip or a `title`: removed at the user's
  // request (2026-09-18). The text cursor and dotted underline are the only cue.
  function start(event) {
    // The readout sits inside a <label>, whose default click action would move focus to
    // the slider and immediately close the box this opens.
    event.preventDefault();

    // Rounded so float noise (0.30000000000000004) is not what the user sees.
    typed = String(Number(toDisplay(read()).toFixed(4)));
    editing = true;
  }

  function finish(apply) {
    if (!editing) {
      return;
    }

    // parseFloat accepts a trailing unit, so "23°" or "40%" typed back in still works.
    const value = parseFloat(typed);

    editing = false;

    if (apply && Number.isFinite(value)) {
      write(fromDisplay(value));
    }
  }

  function onkeydown(event) {
    if (event.key === 'Enter') {
      finish(true);
    } else if (event.key === 'Escape') {
      // Cancels the typing and nothing else: a colour editor's popover, which closes on Escape,
      // must stay open (its handler is on the document).
      event.stopPropagation();
      finish(false);
    }
  }

  // The box (a shadcn-svelte Input) as it appears: focused and selected. An effect on the bound
  // element rather than an action, since an action cannot be put on a component.
  let entry = $state(null);

  $effect(() => {
    if (entry) {
      entry.focus();
      entry.select();
    }
  });
</script>

<span class="value editable" {id} style:display={editing ? 'none' : ''} onclick={start}>{text}</span>
{#if editing}
  <Input type="text" class="value-entry h-5 w-[84px] rounded-sm border-primary bg-background px-1 py-0 text-right font-mono text-[11px] text-primary md:text-[11px] dark:bg-background"
    inputmode="decimal" bind:ref={entry} bind:value={typed} {onkeydown} onblur={() => finish(true)} />
{/if}
