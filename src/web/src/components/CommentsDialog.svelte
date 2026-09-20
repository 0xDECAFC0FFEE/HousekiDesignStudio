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
    commentsOpen, commentsOf, linesToText, textToLines,
  } from '../lib/comments.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { Label } from '$lib/components/ui/label/index.js';

  let headerText = $state('');
  let footerText = $state('');
  let headerField = $state(null);

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
      const comments = commentsOf(getDesign());

      headerText = linesToText(comments.headers);
      footerText = linesToText(comments.footnotes);
    }

    wasOpen = open;
  });

  /** Saves both blocks as one undoable edit (setComments), then closes. */
  function save() {
    setComments({ headers: textToLines(headerText), footnotes: textToLines(footerText) });
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

    <div class="flex justify-end gap-2">
      <Button variant="outline" size="sm" id="comments-dialog-cancel" onclick={close}>Cancel</Button>
      <Button size="sm" id="comments-dialog-save" onclick={save}>Save</Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
