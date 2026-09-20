// Helpers that attach NATIVE (non-delegated) listeners to a form control.
//
//   <input type="checkbox" use:listen={{ change: handler }}>
//   <NativeSelect {@attach listeners({ change: handler })}>
//
// Why not just `onchange={handler}`: Svelte 5 delegates `change` and `input` (among others) to
// one listener on the document, which only sees events that BUBBLE. The page's controls used to
// have their own listeners, and the tools that drive the page dispatch synthetic events straight
// at a control -- `select.dispatchEvent(new Event('change'))` in tools/gcs_compare/gcs_views.py is
// not a bubbling event -- so a delegated handler would silently never run for them. A listener on
// the element itself keeps that contract.

/**
 * Adds each `type: handler` pair as a listener on `node`, and removes them all when the
 * element goes away. The handlers are read once; they are closures over the component's state,
 * so they always see the latest of it. A Svelte action (`use:listen`), for plain elements.
 */
export function listen(node, handlers) {
  for (const [type, handler] of Object.entries(handlers)) {
    node.addEventListener(type, handler);
  }

  return {
    destroy() {
      for (const [type, handler] of Object.entries(handlers)) {
        node.removeEventListener(type, handler);
      }
    },
  };
}

/**
 * The same, as an attachment (`{@attach listeners({ ... })}`): an action cannot be put on a
 * component, but an attachment is passed on to the element the component spreads its props on,
 * which is how a shadcn-svelte wrapper (NativeSelect, Input) gets its element listened to.
 */
export function listeners(handlers) {
  return node => {
    const action = listen(node, handlers);

    return () => action.destroy();
  };
}

/**
 * Sets `aria-disabled` on an element to what `disabled()` returns, and again whenever what it
 * reads changes (`{@attach ariaDisabled(() => !$canUndo)}`). Bits UI's menu item writes its own
 * `aria-disabled="false"` over a prop, and its `disabled` prop makes the item unclickable, but a
 * menu's inert items (File > Save, or Undo with nothing to undo) have always been focusable and
 * clickable, and closing the menu when clicked, so the attribute is set from outside.
 */
export function ariaDisabled(disabled) {
  return node => {
    node.setAttribute('aria-disabled', String(Boolean(disabled())));
  };
}

/**
 * Makes a Bits UI switch or checkbox (a <button role=switch|checkbox>, which has no `checked`)
 * answer to the tools that drive the page's checkboxes as if they were `<input type=checkbox>`:
 * `box.checked = true; box.dispatchEvent(new Event('change'))` (tools/gcs_compare/gcs_views.py,
 * for #useWindowColor). Reading `.checked` gives the control's state, assigning it sets the
 * state (without calling `onchange`, as assigning to an input does not fire an event), and a
 * native `change` event calls `onchange(checked)`, as the input's own handler ran.
 *
 * Use as `{@attach nativeChecked({ get, set, onchange })}`, or call it with the element from an
 * effect on a bound `ref`. Returns a cleanup that removes it all.
 */
export function nativeChecked({ get, set, onchange }) {
  return node => {
    Object.defineProperty(node, 'checked', {
      configurable: true,
      get,
      set,
    });

    const handler = () => onchange(get());

    node.addEventListener('change', handler);

    return () => {
      node.removeEventListener('change', handler);
      delete node.checked;
    };
  };
}
