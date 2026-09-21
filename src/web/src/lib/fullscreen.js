// Fullscreen: the renderer and its settings, and nothing else (2026-09-20, the user: "can you add
// a fullscreen toggle button in the render settings. clicking it hides everything else on the
// screen except the render settings. clicking on it again brings you back").
//
// What "everything else" is, precisely: the top bar (TopBar.svelte), the cutting-instructions
// pane with the handle that drags it (Workspace.svelte), and the two cards laid over the canvas --
// the X/Y rotation sliders with their Top/Side buttons, and the facet count and proportions
// (Viewport.svelte; 2026-09-21, the user: "please also hide the rotation pane and the facet count
// pane in the render"). The RENDERER itself stays -- it is what the render settings are settings
// for, and a fullscreen that hid the stone would leave nothing to look at -- and with it the index
// dial, which is drawn round the stone rather than over it, and edit mode's bar and overlay, which
// belong to a session the toggle has no business ending.
//
// Both are hidden with Tailwind's `hidden` utility (`display: none`) rather than taken out of the
// document, for two separate reasons:
//
//   - **TopBar owns the page's keyboard shortcuts.** Cmd/Ctrl+O, undo and redo are listeners on
//     `svelte:document` inside that component, so unmounting it while fullscreen would silently
//     take Open and Undo away with the bar itself.
//   - **The instructions pane is a PaneForge pane.** Its group would have to re-lay itself out if
//     the pane came and went, and the pane's dragged width (Workspace's `widthPx`, restored into
//     `defaultSize`) is exactly the kind of state that does not survive a remount cleanly. Hidden,
//     PaneForge's bookkeeping never learns anything happened, and the renderer's pane -- then the
//     only flex item left in the group -- simply takes the whole width.
//
// `display: none` also takes both out of the tab order, which is what a control nobody can see
// should do. Tailwind's utilities sit in a cascade layer ABOVE the page's own stylesheets, so
// `.hidden` beats `#topbar { display: flex }` without !important and without touching topbar.css
// (see kb/shadcn-svelte-ui-layer.md).
//
// NOT PERSISTED. This is a way to look at the stone for a moment, not a setting: a reload that
// came back with no top bar and no cutting instructions would read as a broken page, not as a
// remembered preference. Every other control in the panel persists, so this is the deliberate
// exception.

import { writable, get } from 'svelte/store';
import { tick } from 'svelte';
import { renderRegionChanged } from './viewport.js';

/** True while the page is showing the renderer and its settings alone. */
export const fullscreen = writable(false);

/** The button in the settings panel: in if out, out if in. */
export function toggleFullscreen() {
  setFullscreen(!get(fullscreen));
}

/**
 * Leaves fullscreen, or does nothing if the page is not in it. This is Escape's half of the
 * toggle (App.svelte), and it is not just a convenience: entering EDIT MODE swaps the render
 * settings for edit mode's own bar (`#panel-stack`), which takes the button that got us here off
 * the screen with them -- and edit mode can be entered from fullscreen, by double-clicking a
 * facet on the stone.
 */
export function exitFullscreen() {
  if (get(fullscreen)) {
    setFullscreen(false);
  }
}

function setFullscreen(on) {
  fullscreen.set(on);
  // The canvas fills whatever region is left of the page by CSS, but its BACKING STORE is sized
  // at render time from the element's measured width (viewport.js's renderNow), and nothing else
  // is going to ask for that render: hiding an element fires no `resize` on the window, which is
  // what the canvas otherwise redraws on. `tick()` first, so the measurement happens after Svelte
  // has applied the change rather than against the layout we are leaving.
  tick().then(renderRegionChanged);
}
