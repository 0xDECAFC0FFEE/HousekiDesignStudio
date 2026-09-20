<script>
  // The load alert (2026-09-19): a big red dialog over the whole page when something the user just
  // asked for could not be read -- a file, or a shared link whose checksum did not pass. The
  // user's own words, across two requests: "if the file can't be read or the checksum doesn't
  // pass, can you show a warning with the failed to parse error", then "instead of a small yellow
  // warning box can you make it a big warning box in red", "overlay over the whole page just like
  // the settings menu and the gear menu".
  //
  // What this replaced: the same messages in the settings panel's `#error` box, drawn yellow. They
  // were easy to miss, which is the whole reason they are a dialog now -- a file that failed to
  // parse is exactly the thing a person must not carry on past without noticing.
  //
  // A shadcn-svelte Dialog, like GearDialog and CommentsDialog (Bits UI: dims the page, traps
  // focus, closes on Escape), so this is the same kind of overlay the gear and settings dialogs
  // already are, as asked. Three points where it differs from those two, all because it reports
  // rather than asks:
  //
  //   - **There is nothing to cancel and nothing to apply.** One Close button, which is also what
  //     Escape and a click outside do. Nothing about the page changes either way -- by the time
  //     this opens, the load has already finished or already failed.
  //   - **It is driven entirely by the `loadAlert` store**, not by a handle its opener holds: the
  //     things that raise it (the file reader, the startup path, the hash restore) are plain
  //     modules with no component to call, and several of them run before any component exists.
  //   - **No IME guard.** T-0154's rule is about text being composed in a field; there is no field
  //     here, and Escape has nothing to abandon but the dialog itself.
  //
  // The detail is the underlying parse error verbatim, in the monospace the error box used, and
  // scrolls rather than growing without limit -- a reader error can be several lines, and a dialog
  // taller than the window would put its own Close button off screen.
  import { loadAlert, dismissLoadAlert } from '../lib/stores.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
</script>

<Dialog.Root bind:open={() => $loadAlert !== null, open => { if (!open) { dismissLoadAlert(); } }}>
  <Dialog.Content id="load-alert" showCloseButton={false}
    class="gap-0 rounded-md border-2 border-[var(--error)] bg-[var(--panel)] p-6 sm:max-w-[560px]">
    <Dialog.Title id="load-alert-title"
      class="mb-3 flex items-center gap-2.5 text-[17px] font-bold text-[var(--error)]">
      <!-- currentColor, so the glyph is the title's own red and never needs a rule of its own --
           the same trick the gear dialog's error symbol uses. -->
      <svg class="size-[22px] shrink-0" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.3 L15 14 H1 Z" fill="none" stroke="currentColor" stroke-width="1.3"
          stroke-linejoin="round" />
        <rect x="7.25" y="5.5" width="1.5" height="4.5" rx="0.75" fill="currentColor" />
        <rect x="7.25" y="11" width="1.5" height="1.5" rx="0.75" fill="currentColor" />
      </svg>
      {$loadAlert?.title ?? ''}
    </Dialog.Title>

    <Dialog.Description id="load-alert-detail"
      class="max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-sm border border-[var(--panel-edge)] bg-[var(--raised)] p-3 font-mono text-[12px] leading-relaxed text-[var(--text)]">{$loadAlert?.detail ?? ''}</Dialog.Description>

    <div class="mt-5 flex justify-end">
      <Button size="sm" id="load-alert-close" onclick={dismissLoadAlert}>Close</Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
