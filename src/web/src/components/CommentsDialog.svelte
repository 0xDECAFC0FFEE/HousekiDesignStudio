<script>
  // The comments dialog (2026-09-19, the user: "can you add a comments button to the instructions
  // menu that opens up a dialog for header and footer comments? make sure to update these headers
  // and footers when opening files. once the comments are saved, make them undoable"). Header
  // comments are a GemCad file's own `H` lines, footer comments its footnotes; see comments.js for
  // why the loaded design is the only copy of either.
  //
  // A shadcn-svelte Dialog, like GearDialog, and it follows that dialog's decisions rather than
  // inventing its own: the content is mounted only while open (so `#comments-dialog` and the
  // fields inside it exist only then), Escape cancels, Cancel changes nothing, and focus returns
  // to the button that opened it. Three places it deliberately differs, each because these fields
  // are FREE TEXT where the gear dialog's were a number and two checkboxes:
  //
  //   - **Enter does not save.** It inserts a newline, which is the whole point of a textarea
  //     here: one comment per line. Cmd/Ctrl+Enter is the keyboard save instead, the usual
  //     binding for committing a multi-line field.
  //   - **Nothing is validated and Save is never disabled.** Any text at all is a legal comment,
  //     including none; a Save that changed nothing simply records nothing (`setComments`).
  //   - **It is opened from a store, not a `bind:this` handle.** The button that opens it sits in
  //     the tier toolbar, three components down inside the workspace, and threading a callback
  //     down that path (as `onopengear` is threaded for the gear dialog, one level) would put
  //     plumbing in two components that have nothing else to do with comments. `commentsOpen` in
  //     comments.js is that one shared fact instead.
  //
  // T-0154's IME rule applies to both fields, and matters more here than in the gear dialog:
  // these are exactly the free-text boxes that rule was written for. Cmd/Ctrl+Enter and Escape
  // both do nothing mid-composition.
  import { getDesign, setComments } from '../lib/tier_controller.js';
  import {
    commentsOpen, commentsOf, linesToText, textToLines, infoOf, numberOrNull,
  } from '../lib/comments.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { Label } from '$lib/components/ui/label/index.js';

  let headerText = $state('');
  let footerText = $state('');
  let headerField = $state(null);

  // The `<info>` fields a .gcs carries beyond the title, author and date (T-0214): what the
  // design is drawn for. Held as TEXT while the dialog is open, not as numbers, so a half-typed
  // "1." is not snapped to 1 under the person's caret; `numberOrNull` converts on save, and a
  // blank or unparseable box saves as "not stated" rather than as a made-up 0.
  let shape = $state('');
  let sizeMin = $state('');
  let sizeMax = $state('');
  let riMin = $state('');
  let riMax = $state('');

  /** A number from the design for one of the boxes above: `null` shows as an empty box. */
  function numberText(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  // Prefilled on every OPEN, from whatever design is loaded right now -- which is what makes the
  // user's "make sure to update these headers and footers when opening files" hold: opening a file
  // replaces the design object (installLoadedDesign), so the next open of this dialog can only
  // show the new file's own comments, and an undo that put an older block back shows that instead.
  // Tracked with a plain `wasOpen` rather than by reacting to the store's value alone, so the
  // fields are filled once per open and never rewritten under someone mid-edit.
  let wasOpen = false;

  $effect(() => {
    const open = $commentsOpen;

    if (open && !wasOpen) {
      const design = getDesign();
      const comments = commentsOf(design);
      const info = infoOf(design);

      headerText = linesToText(comments.headers);
      footerText = linesToText(comments.footnotes);
      shape = info.shape;
      sizeMin = numberText(info.sizeMin);
      sizeMax = numberText(info.sizeMax);
      riMin = numberText(info.riMin);
      riMax = numberText(info.riMax);
    }

    wasOpen = open;
  });

  /** Saves the comments and the `<info>` fields as one undoable edit, then closes. */
  function save() {
    setComments({
      headers: textToLines(headerText),
      footnotes: textToLines(footerText),
      info: {
        shape: shape.trim(),
        sizeMin: numberOrNull(sizeMin),
        sizeMax: numberOrNull(sizeMax),
        riMin: numberOrNull(riMin),
        riMax: numberOrNull(riMax),
      },
    });
    close();
  }

  function close() {
    commentsOpen.set(false);
  }

  // T-0154's IME rule: a keystroke mid-composition belongs to the input method, not to us.
  let composing = false;

  function onkeydown(event) {
    if (event.isComposing || composing) {
      return;
    }

    // Cmd/Ctrl+Enter saves; a bare Enter is left alone to insert a newline in the textarea.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
  }

  // Bits UI closes on Escape itself; this only vetoes that mid-composition, where Escape is the
  // input method's own way to abandon a composition and must not also throw the dialog away.
  function onEscapeKeydown(event) {
    if (composing) {
      event.preventDefault();
    }
  }

  // Focus returns to the button that opened this, however it closed. Opened from code (a store),
  // so Bits UI has no trigger element of its own to return the focus to unless it is told.
  function onCloseAutoFocus(event) {
    event.preventDefault();
    document.getElementById('tier-tool-comments')?.focus();
  }

  // The header field takes the focus as the dialog opens, with the caret at the end of whatever
  // is already there rather than selecting it all: these are notes to add to, not a value to
  // replace, which is the opposite of the gear dialog's `select()`.
  function onOpenAutoFocus(event) {
    event.preventDefault();
    headerField?.focus();
    headerField?.setSelectionRange(headerText.length, headerText.length);
  }
</script>

<Dialog.Root bind:open={() => $commentsOpen, value => commentsOpen.set(value)}>
  <Dialog.Content id="comments-dialog" showCloseButton={false}
    class="min-w-[320px] gap-0 rounded-md border border-border p-4 sm:max-w-[460px]"
    aria-describedby={undefined} {onkeydown} {onEscapeKeydown} {onCloseAutoFocus} {onOpenAutoFocus}
    oncompositionstart={() => { composing = true; }} oncompositionend={() => { composing = false; }}>
    <Dialog.Title class="mb-3.5 text-sm font-bold" id="comments-dialog-title">Comments</Dialog.Title>

    <!-- One `data-tip` per field, on the element wrapping the whole field, since the tooltip
         takes the OUTERMOST data-tip ancestor; nothing on Dialog.Content itself, which would
         swallow both. -->
    <div class="mb-3 grid gap-1.5"
      data-tip="Notes printed above the cutting instructions, one per line. These are a GemCad file's own header lines, kept as the file had them.">
      <Label for="comments-dialog-headers" class="text-xs font-normal text-muted-foreground">Header comments</Label>
      <Textarea id="comments-dialog-headers" rows={4} spellcheck="false"
        class="min-h-[72px] rounded-sm px-2 py-1.5 text-xs md:text-xs"
        bind:ref={headerField} bind:value={headerText} />
    </div>

    <div class="mb-4 grid gap-1.5"
      data-tip="Notes printed below the cutting instructions, one per line. These are a GemCad file's own footnotes.">
      <Label for="comments-dialog-footers" class="text-xs font-normal text-muted-foreground">Footer comments</Label>
      <Textarea id="comments-dialog-footers" rows={4} spellcheck="false"
        class="min-h-[72px] rounded-sm px-2 py-1.5 text-xs md:text-xs"
        bind:value={footerText} />
    </div>

    <!-- The rest of a .gcs's <info> (T-0214): what the design is drawn for. The title, author
         and date are the cut header's own fields, edited there, so they are not repeated here.
         A GemCad .asc/.gem has no <info> at all, so for a design read from one these start
         empty and are written only if the design is later exported as a .gcs. -->
    <div class="mb-3 grid gap-1.5"
      data-tip="The shape this design is drawn for, as Gem Cut Studio's own <info> records it (Round, Cushion, Triangle...). Saved in a .gcs; a GemCad file has nowhere to put it.">
      <Label for="comments-dialog-shape" class="text-xs font-normal text-muted-foreground">Shape</Label>
      <Input id="comments-dialog-shape" spellcheck="false"
        class="h-7 rounded-sm px-2 py-1 text-xs md:text-xs" bind:value={shape} />
    </div>

    <div class="mb-4 grid grid-cols-2 gap-3">
      <div class="grid gap-1.5"
        data-tip="The stone sizes, in millimetres, the designer drew this for. Leave either box empty to say nothing about it.">
        <Label class="text-xs font-normal text-muted-foreground">Size range (mm)</Label>
        <div class="flex items-center gap-1.5">
          <Input id="comments-dialog-size-min" inputmode="decimal" aria-label="Smallest size"
            class="h-7 rounded-sm px-2 py-1 text-xs md:text-xs" bind:value={sizeMin} />
          <span class="text-xs text-muted-foreground">to</span>
          <Input id="comments-dialog-size-max" inputmode="decimal" aria-label="Largest size"
            class="h-7 rounded-sm px-2 py-1 text-xs md:text-xs" bind:value={sizeMax} />
        </div>
      </div>

      <div class="grid gap-1.5"
        data-tip="The refractive indices this design is meant to be cut in -- 1.54 (quartz) to 2.15 (CZ) is the usual range. This is a note for the cutter; it does not change the material the stone is rendered with.">
        <Label class="text-xs font-normal text-muted-foreground">Refractive index range</Label>
        <div class="flex items-center gap-1.5">
          <Input id="comments-dialog-ri-min" inputmode="decimal" aria-label="Lowest refractive index"
            class="h-7 rounded-sm px-2 py-1 text-xs md:text-xs" bind:value={riMin} />
          <span class="text-xs text-muted-foreground">to</span>
          <Input id="comments-dialog-ri-max" inputmode="decimal" aria-label="Highest refractive index"
            class="h-7 rounded-sm px-2 py-1 text-xs md:text-xs" bind:value={riMax} />
        </div>
      </div>
    </div>

    <div class="flex justify-end gap-2">
      <Button variant="outline" size="sm" id="comments-dialog-cancel" onclick={close}>Cancel</Button>
      <Button size="sm" id="comments-dialog-save" onclick={save}>Save</Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
