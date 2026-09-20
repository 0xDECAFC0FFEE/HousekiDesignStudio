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
