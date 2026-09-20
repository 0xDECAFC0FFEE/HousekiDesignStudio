<script>
  // The cutting-instructions pane's header (T-0145, restyled T-0151): the cut name, author and
  // date, each click to edit (EditableText). Cut name, author and date -- "At the top of the
  // cutting instructions can you have the name of the cut as a title, then below have author,
  // date (autofilled)? All three are text boxes that people can click to edit" (the user,
  // 2026-09-18). The name doubles as File > Rename's target -- "editing the title should do the
  // same thing as renaming it" -- and is where a loaded design's own name lands, since T-0144 took
  // the file name off the top bar.
  //
  // No separate label spans (T-0151): the user asked for the word IN the box instead ("beneath
  // should just have 'author' as the default in the text box"). Author and date share one row,
  // #cut-byline (a later amendment on the same ticket, "Show the author on the same row as the
  // date"), with a plain middle-dot separator that is part of neither field's click target -- it
  // is what keeps two adjacent click-to-edit fields from reading, or being clicked, as one
  // continuous strip.
  //
  // Independent of GemApp, like the top and sub bars, so the fields are editable even if the wasm
  // module fails to load. The fields' values live in the `cutMeta` store: a design load calls
  // `applyDesignMetadata` (stores.js) to fill in whatever it knows, leaving the rest at their
  // current values.
  import { get } from 'svelte/store';
  import { cutMeta, currentDate, renameRequest } from '../lib/stores.js';
  import { eventTargetIsEditable } from '../lib/keys.js';
  import EditableText from './EditableText.svelte';

  let nameField;

  // File > Rename IS the name field now -- the user's request, "editing the title should do the
  // same thing as renaming it" -- so choosing it opens the same editor a click would, with the
  // text selected so the next keystroke replaces it. T-0140 left this item aria-disabled; this
  // is what makes it live. (The menu bumps a counter; only a change since mount opens it.)
  let seenRenames = get(renameRequest);

  $effect(() => {
    const requests = $renameRequest;

    if (requests !== seenRenames) {
      seenRenames = requests;
      nameField.startEdit(true);
    }
  });

  // F2, the shortcut shown next to Rename. Guarded the same way Cmd/Ctrl+O is in the top bar
  // (eventTargetIsEditable), so pressing F2 while a field -- this one included -- is already
  // focused does not fight the editor it just opened.
  function onkeydown(event) {
    if (eventTargetIsEditable(event)) {
      return;
    }

    if (event.key === 'F2') {
      event.preventDefault();
      nameField.startEdit(true);
    }
  }
</script>

<svelte:document {onkeydown} />

<div id="cut-header">
  <EditableText bind:this={nameField} tag="div" cls="cut-name" id="cut-name" value={$cutMeta.name}
    emptyText="title"
    onwrite={value => cutMeta.update(meta => ({ ...meta, name: value }))} />
  <div class="cut-byline">
    <EditableText cls="cut-meta-value" id="cut-author" inputClass="w-[min(140px,45%)]"
      value={$cutMeta.author} emptyText="author"
      onwrite={value => cutMeta.update(meta => ({ ...meta, author: value }))} />
    <span class="cut-byline-sep" aria-hidden="true">&middot;</span>
    <EditableText cls="cut-meta-value" id="cut-date" inputClass="w-[min(140px,45%)]"
      value={$cutMeta.date}
      onwrite={value => cutMeta.update(meta => ({ ...meta, date: value.trim() || currentDate() }))} />
  </div>
</div>
