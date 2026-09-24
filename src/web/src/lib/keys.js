// Keyboard-event helpers shared by every global shortcut (Cmd/Ctrl+O, F2, Undo/Redo).

/**
 * True while a keyboard event's target is already a place that consumes typing: a slider's
 * editable readout, the cut-header fields (T-0145), or any ordinary form control. Shared by
 * every global keydown shortcut (Cmd/Ctrl+O, F2) so none of them fights a field the user is
 * already typing into, and so native copy/paste keeps working inside one untouched.
 */
export function eventTargetIsEditable(event) {
  return !!event.target.closest?.('input, select, textarea, [contenteditable="true"], [contenteditable=""]');
}

/**
 * True on a Mac, where shortcuts use Cmd rather than Ctrl. `userAgentData.platform` is the
 * modern, spec-favoured source, but is Chromium-only, so fall back to the older (and
 * deprecated, but universally supported) `navigator.platform` on Firefox and Safari.
 */
export function isMacPlatform() {
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? '';

  return /^mac/i.test(platform);
}

/**
 * True while a keyboard event's target takes typed text: a text box (a readout or field being
 * edited), a textarea or editable content. Narrower than eventTargetIsEditable on purpose, for
 * Undo/Redo: inside a text box Cmd/Ctrl+Z must stay the box's own text undo, but a focused
 * slider, checkbox or dropdown holds no text, so there it means the page's Undo.
 */
export function eventTargetTakesText(event) {
  const target = event.target;

  if (target.closest?.('textarea, [contenteditable="true"], [contenteditable=""]')) {
    return true;
  }

  return target instanceof HTMLInputElement &&
    !['range', 'checkbox', 'radio', 'button', 'color', 'file'].includes(target.type);
}

/**
 * True while the event's target is a control that already treats Enter as "activate me" -- a
 * button, a link, a menu item -- so a global Enter shortcut (T-0257's tier-edit one, App.svelte)
 * must leave it alone. This is NOT the same question `event.defaultPrevented` answers: a plain
 * `<button>`'s own Enter-activates-it behaviour is the BROWSER's native default action, which is
 * only decided (and so only reflected in `defaultPrevented`) once the whole dispatch -- capture,
 * target, bubble, every listener including a document-level one -- has finished, so a bubble-
 * phase listener can never see it coming by checking that flag first. The tier toolbar's own
 * Delete, Preform, Comments and so on are exactly such buttons: focus one of them and Enter must
 * keep meaning "activate this button", not "edit the selected tier", the same as anywhere else on
 * the page a real `<button>` or link has the keyboard's attention.
 */
export function eventTargetActivatesOnEnter(event) {
  return !!event.target.closest?.('button, a[href], summary, [role="menuitem"], [type="submit"]');
}
