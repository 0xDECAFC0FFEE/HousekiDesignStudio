<script>
  // Lets a plain-text field (T-0145's cut name, author and date, in the cutting-instructions
  // pane's header, and a tier's description) be clicked to edit -- the page's old
  // `makeTextFieldEditable`. Matches EditableReadout's contract exactly -- Enter or blur
  // applies, Escape cancels, and a text cursor plus dotted underline are the only affordance,
  // with no tooltip and no `title` (the user had the equivalent hint removed from the slider
  // readouts on 2026-09-18; this does not bring an equivalent one back) -- but there is no unit
  // conversion or numeric parsing here: whatever is typed becomes the value verbatim, including
  // empty, which shows `emptyText` in its place instead of nothing.
  //
  //   value      the current string value (the parent owns it)
  //   onwrite(v) applies a new string value
  //   emptyText  shown, muted and italic (see .editable.empty), when the value is ''
  //   canEdit()  whether a click opens the editor now; a click while it is false does nothing
  //              here, so it can mean something else to an ancestor (a tier row's description
  //              only edits once its row is selected)
  //   tag, cls, id   the element it draws and what it is called
  //   inputClass     extra classes for the editor: it fills its container, in the page's normal
  //                  (non-monospace) font, left-aligned, since these hold names and prose, not
  //                  numbers; a call site narrows or shrinks it
  //
  // `startEdit(selectAll)` is exported so File > Rename / F2 can open the editor without a real
  // click.
  import { Input } from '$lib/components/ui/input/index.js';
  import { cn } from '$lib/utils.js';

  let {
    value, onwrite, emptyText = '', canEdit = () => true, tag = 'span', cls = '', id,
    inputClass = '',
  } = $props();

  let editing = $state(false);
  let typed = $state('');

  let empty = $derived(value === '');

  /** Opens the editor. `selectAll` selects the text, so the next keystroke replaces it. */
  export function startEdit(selectAll) {
    // Ignore a second open (File > Rename while already editing, say) rather than stacking a
    // second input box on top of the first.
    if (editing) {
      return;
    }

    typed = value;
    editing = true;
    // The box does not exist until Svelte draws it; `focusAndSelect` below runs then.
    selectOnOpen = selectAll;
  }

  let selectOnOpen = false;

  function finish(apply) {
    if (!editing) {
      return;
    }

    editing = false;

    if (apply) {
      onwrite(typed);
    }
  }

  function onkeydown(event) {
    if (event.key === 'Enter') {
      finish(true);
    } else if (event.key === 'Escape') {
      finish(false);
    }
  }

  // The box (a shadcn-svelte Input) as it appears: focused, and selected when asked. An effect
  // on the bound element, since an action cannot be put on a component.
  let entry = $state(null);

  $effect(() => {
    if (entry) {
      entry.focus();

      if (selectOnOpen) {
        entry.select();
      }
    }
  });
</script>

<svelte:element this={tag} {id} class="{cls} editable{empty ? ' empty' : ''}"
  style:display={editing ? 'none' : ''}
  onclick={() => { if (canEdit()) startEdit(true); }}>{empty ? emptyText : value}</svelte:element>
{#if editing}
  <Input type="text"
    class={cn('value-entry h-5 w-full min-w-0 rounded-sm border-primary bg-background px-1 py-0 text-left font-sans text-xs text-primary select-text md:text-xs dark:bg-background', inputClass)}
    bind:ref={entry} bind:value={typed} {onkeydown} onblur={() => finish(true)} />
{/if}
