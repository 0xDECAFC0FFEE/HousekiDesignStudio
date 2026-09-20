/*
 * message_box_test.js -- tests for the two places a failure is reported (web/src/lib/stores.js).
 *
 * The user asked for both, a few minutes apart (2026-09-19): first "when you load a file or open
 * the program, if the file can't be read or the checksum doesn't pass, can you show a warning with
 * the failed to parse error", then "instead of a small yellow warning box can you make it a big
 * warning box in red" / "overlay over the whole page just like the settings menu and the gear
 * menu". So:
 *
 *   - `loadAlert` is a one-off failure of something just asked for (a file, a shared link), shown
 *     as a big red dialog over the whole page (LoadAlertDialog.svelte);
 *   - `error` is the settings panel's `#error` box, for a persistent or minor condition (the tiers
 *     no longer close a solid, an eyedropper pick failed).
 *
 * What is worth testing without a browser is each store's contract, since several callers depend
 * on details that are easy to break silently.
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 */

import { get } from "svelte/store";
import {
  error, showError, hideError, clearErrorIf,
  loadAlert, showLoadAlert, dismissLoadAlert,
} from "../src/lib/stores.js";

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

Deno.test("both start silent, and the error box carries no inline style yet", () => {
  // Setup: the stores as the module initialises them (this test runs first and touches nothing).
  // Test: read both.
  // Verifies `visible === null`, which the panel turns into NO inline display style at all, so the
  // stylesheet's own `display: none` is what hides the box on first paint -- `false` would look
  // identical on screen but is a different thing, and the page always started at "never shown".
  // And `loadAlert === null`, which is what keeps the dialog shut: opening the program normally
  // must say nothing at all.
  assertEqual(get(error), { text: "", visible: null }, "the error box's initial state");
  assertEqual(get(loadAlert), null, "no load alert");
});

Deno.test("a load alert carries the title and the parse error verbatim, and closes cleanly", () => {
  // Setup: nothing.
  // Test: raise an alert, read it, dismiss it.
  // Verifies the shape LoadAlertDialog renders and the round trip its Close button relies on. The
  // detail is the underlying error UNCHANGED -- the user asked for "the failed to parse error"
  // itself, not a summary of it -- so this asserts the exact string, newlines and all.
  const detail = "Loaded SRB.asc, but could not derive its cutting instructions: " +
    "Error: normal disagreement 0.41 degrees\n\nsecond warning about the same load";

  showLoadAlert("Could not read this design", detail);
  assertEqual(
    get(loadAlert),
    { title: "Could not read this design", detail },
    "the alert holds exactly what it was given"
  );

  dismissLoadAlert();
  assertEqual(get(loadAlert), null, "dismissing closes it");
});

Deno.test("the last load alert wins, rather than queueing behind an older one", () => {
  // Setup: one alert already up.
  // Test: raise a second.
  // Verifies the documented no-queue rule, and so why every caller that can produce more than one
  // message about a single load (a file can fail both its design gate and its mesh builder) joins
  // them into one detail first: a second call would otherwise hide the first outright.
  showLoadAlert("first", "one");
  showLoadAlert("second", "two");

  assertEqual(get(loadAlert), { title: "second", detail: "two" }, "the newer alert replaces it");
  dismissLoadAlert();
});

Deno.test("the two channels are independent: an alert does not disturb the error box", () => {
  // Setup: a condition showing in the panel's error box.
  // Test: raise and dismiss a load alert around it.
  // Verifies they do not share state. This matters for a real sequence: the stone cannot be
  // rebuilt (REBUILD_ERROR sits in the box) and the user then opens a file that will not parse --
  // the dialog must not silently clear a condition that is still true of the page.
  showError("the tiers left on the stone do not close a solid");
  showLoadAlert("Could not load broken.asc", "RangeError: Unable to read beyond the end");
  assertEqual(
    get(error),
    { text: "the tiers left on the stone do not close a solid", visible: true },
    "the box is untouched while the dialog is up"
  );

  dismissLoadAlert();
  assertEqual(
    get(error),
    { text: "the tiers left on the stone do not close a solid", visible: true },
    "and untouched after it closes"
  );
});

Deno.test("hiding the error box leaves its text, and clearErrorIf only clears its own message", () => {
  // Setup: a message in the box.
  // Test: hide it; then clearErrorIf with the wrong message, then with the right one.
  // Verifies the two behaviours other code leans on. `hideError` keeps the text because a
  // successful load hides the box without clearing it (the page always did, and the browser
  // harness asserts on the text of a hidden box). `clearErrorIf` is how session.js takes its own
  // rebuild message down without stepping on whatever has since been shown -- so a non-matching
  // call must be a complete no-op, text and visibility both.
  showError("a message worth keeping");
  hideError();
  assertEqual(get(error), { text: "a message worth keeping", visible: false }, "hidden, text intact");

  showError("mine");
  clearErrorIf("someone else's");
  assertEqual(get(error), { text: "mine", visible: true }, "a non-matching clear does nothing");

  clearErrorIf("mine");
  assertEqual(get(error), { text: "", visible: false }, "a matching clear empties the box");
});
