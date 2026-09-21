/*
 * fullscreen_test.js -- tests for web/src/lib/fullscreen.js, the render settings' fullscreen
 * toggle (2026-09-20, the user: "can you add a fullscreen toggle button in the render settings.
 * clicking it hides everything else on the screen except the render settings. clicking on it
 * again brings you back").
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * What is testable here is the STATE the button drives: one store that the top bar and the
 * instructions pane read to hide themselves. What that state does to the page -- which elements
 * actually leave the screen, and the canvas being redrawn at its new size -- is a browser fact,
 * checked over CDP against the built page (kb/browser-harness.md), not here.
 *
 * Importing this module also pulls in viewport.js, which is why the suite needs --allow-env (it
 * imports Svelte; see lib_test.js). Nothing in it touches a document at import time, and
 * `renderRegionChanged` is a no-op with no canvas wired, so the toggle is safe to call here.
 */

import { fullscreen, toggleFullscreen, exitFullscreen } from "../src/lib/fullscreen.js";
import { get } from "svelte/store";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// Every test starts from the page's own starting state rather than from whatever the test before
// it left behind, since the store is module-level and shared across them all.
function reset() {
  fullscreen.set(false);
}

Deno.test("the page does not start in fullscreen", () => {
  // Setup: the store as the module defines it.
  // Test: read it.
  // Verifies: a freshly loaded page shows the top bar and the cutting instructions. This is also
  // the "not persisted" decision in one line -- nothing reads a saved setting to seed this, so
  // there is no way for a reload to come back with the page's chrome missing.
  reset();
  assertEqual(get(fullscreen), false, "the starting state");
});

Deno.test("the button toggles: in, then out again", () => {
  // Setup: not in fullscreen.
  // Test: toggle twice, reading the store after each.
  // Verifies: the user's whole brief for the button -- "clicking it hides everything else on the
  // screen except the render settings. clicking on it again brings you back". One button, no
  // separate enter and leave, and no state that can get stuck on.
  reset();

  toggleFullscreen();
  assertEqual(get(fullscreen), true, "after the first click");

  toggleFullscreen();
  assertEqual(get(fullscreen), false, "after the second click");
});

Deno.test("Escape leaves fullscreen, and does nothing at all when the page is not in it", () => {
  // Setup: in fullscreen, then out of it.
  // Test: exitFullscreen in both states.
  // Verifies: Escape's half of the toggle (App.svelte) only ever leaves, never enters -- an
  // Escape pressed on an ordinary page must not throw the top bar and the instructions away. It
  // matters because Escape is shared: App.svelte gives the press to edit mode first and only
  // calls this when there is no edit session to cancel, so this is reached on presses that were
  // never about fullscreen at all.
  reset();

  toggleFullscreen();
  exitFullscreen();
  assertEqual(get(fullscreen), false, "Escape in fullscreen leaves it");

  exitFullscreen();
  assertEqual(get(fullscreen), false, "Escape outside fullscreen changes nothing");
});

Deno.test("the store is what the page reads, so subscribers see every change", () => {
  // Setup: a subscriber recording what it is told, attached before anything is toggled.
  // Test: toggle in, toggle out, and unsubscribe.
  // Verifies: the toggle goes through the STORE rather than through any private variable -- which
  // is what makes TopBar's `class={$fullscreen ? 'hidden' : ''}` and the instructions pane's own
  // copy of it react at all. A first value on subscribe, then one per change, in order.
  reset();

  const seen = [];
  const stop = fullscreen.subscribe(value => seen.push(value));

  toggleFullscreen();
  toggleFullscreen();
  stop();

  assertEqual(JSON.stringify(seen), JSON.stringify([false, true, false]), "what a subscriber saw");
});
