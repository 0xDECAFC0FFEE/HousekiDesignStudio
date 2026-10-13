/*
 * scan_mode_test.js -- tests for the studio's Tools > Rough scan (src/web/src/lib/scan_mode.js,
 * T-0314), which since T-0337 opens the scanner page in a modal through scanner_sdk.js, as any
 * website does with /scanner.js, and holds the design while it is open. The scanner itself (the
 * QR code, the phone, what it sees) is tests/scan_session_test.js's; the website <-> scan page
 * protocol, tests/scanner_protocol_test.js's.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The mode is driven through the page's real modules (session.js, tier_controller.js,
 * edit_mode.js, record_mode.js, the mode itself) on a FAKE GemApp with the startup stone loaded,
 * as boot does it. The scanner is a fake `open` handed to the mode with `setScanBackend`: it
 * records what it was opened with and hands each test the callbacks, so the test plays the
 * scanner's side (Done, Close) itself. A real modal and scan page are
 * tests/harness/test_scan_mode.py's, in headless Chrome.
 *
 * Globals the modules expect, set up as tests/record_mode_test.js does: `window` (the page asks
 * for redraws through `window.gemRequestRender?.()`), and the GemCad scripts, which the page loads
 * as classic scripts publishing globals.
 */

globalThis.window = globalThis.window ?? {};
globalThis.window.addEventListener = globalThis.window.addEventListener ?? (() => {});

for (const name of ["gemcad.js", "gemcad_obj.js", "design.js", "gcs.js", "design_mesh.js", "edit_history.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${name}`, import.meta.url)));
}

const { get } = await import("svelte/store");
const { objTextFromBytes } = await import("../src/lib/design_load.js");
const { installLoadedDesign, startSession } = await import("../src/lib/session.js");
const { engine, canUndo, error } = await import("../src/lib/stores.js");
const { attachCanvasControls } = await import("../src/lib/viewport.js");
const tiers = await import("../src/lib/tier_controller.js");
const { enterEditMode, exitEditMode, editing } = await import("../src/lib/edit_mode.js");
const record = await import("../src/lib/record_mode.js");
const mode = await import("../src/lib/scan_mode.js");

const STARTUP_URL = new URL("../../resources/hex_cut_v2.gcs", import.meta.url);
const EMBED_URL = "http://127.0.0.1:8000/scanner/embed.html";

// Loading the stone asks the page's render loop for a frame (viewport.js requestRender), which
// waits on a timer of its own; a test that awaits nothing after page() can end before it fires,
// and Deno would call that a leak. The timer is the page's, not the mode's, so it is not checked
// (with only sanitizeOps off, Deno 2.6 still reported it now and then, so both are).
const STUDIO_TEST = { sanitizeOps: false, sanitizeResources: false };

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

/** A fake GemApp: enough of the real one for the session to load the startup stone. */
function fakeApp() {
  const app = {
    params: { spin: 10, tilt: -20, sideTilt: 0, headShadowHalfAngle: 14, luxSamples: 1 },
    load_obj() {},
    model_obj_text: () => "",
    facet_count: () => 0,
    facet_normals: () => new Float32Array(0),
    set_highlighted_facets() {},
    set_highlighted_facet() {},
    set_frosted_facets() {},
    get_param: name => app.params[name] ?? 0,
    set_param(name, value) {
      app.params[name] = value;
    },
    set_draft_mode() {},
    render() {},
    renderer: () => 0,
    set_renderer() {},
    renderer_names: () => "Deterministic\nMonte Carlo\nFlat",
    hidden_controls: () => "",
    hideable_controls: () => "",
    accumulation_status: () => "off: a fake app has no GPU",
    accumulating: () => false,
    accumulation_complete: () => true,
    frame_settled: () => true,
  };

  return app;
}

/**
 * A fresh page: a fake app with the startup stone loaded, as boot does it, and the mode given a
 * fake scanner. `scanner.opened` lists what each open was called with (its options, and whether
 * the mode later closed it, `closed`); `scanner.fail` makes the next open throw.
 */
async function page() {
  const app = fakeApp();
  const stone = objTextFromBytes("hex_cut_v2.gcs", await Deno.readFile(STARTUP_URL));
  const scanner = { opened: [], fail: null };

  mode.exitScan();
  record.exitRecording();
  mode.setScanBackend({
    embedUrl: () => EMBED_URL,
    open(options) {
      if (scanner.fail) {
        throw new Error(scanner.fail);
      }

      const opened = { options, closed: false };

      scanner.opened.push(opened);
      return { close: () => { opened.closed = true; } };
    },
  });

  engine.app = app;
  startSession(app);
  attachCanvasControls({ addEventListener() {}, clientWidth: 100, clientHeight: 100, classList: { add() {}, remove() {} } });
  installLoadedDesign(app, { text: stone.text, design: stone.design, gear: stone.gear, title: "test" });

  return { app, scanner, design: stone.design };
}

Deno.test("Rough scan opens the scanner page through the SDK and holds the design while it is open", STUDIO_TEST, async () => {
  // Setup: the startup stone, nothing open.
  // Test: open the mode.
  // Verifies: the scanner is opened exactly once, with the scan page's address and both callbacks
  // (onResult, onCancel) -- what a website passes HousekiScan.open; the mode is open; the design is
  // held (another mode cannot open, the tier toolbar would say why); and Undo has nothing to step.
  const { scanner } = await page();

  assert(mode.enterScan(), "the mode opens");
  assertEqual(scanner.opened.length, 1, "the scanner is opened once");

  const { options } = scanner.opened[0];

  assertEqual(options.embedUrl, EMBED_URL, "at the scan page's address");
  assert(typeof options.onResult === "function" && typeof options.onCancel === "function", "with both callbacks");
  assertEqual(get(mode.scanning).open, true, "the mode is open");
  assert(tiers.designLocked(), "the design is held");
  assertEqual(get(canUndo), false, "nothing to undo while it is open");
  assertEqual(mode.enterScan(), false, "a second open is refused");
  assertEqual(scanner.opened.length, 1, "and opens no second scanner");
  mode.exitScan();
});

Deno.test("the mode ends when the scanner does: Done, Close, or Escape in the studio", STUDIO_TEST, async () => {
  // Setup: the startup stone.
  // Test: open the mode and play the scanner's Done (onResult with a result); open again and play
  // its Close (onCancel); open again and close it from the studio (exitScan, Escape's); then call
  // the first scanner's callbacks late.
  // Verifies: each way out closes the mode and frees the design; the studio's own close also
  // closes the scanner (the modal goes); and a scanner that has already ended cannot end, or
  // disturb, the mode opened after it.
  const { scanner } = await page();

  mode.enterScan();
  scanner.opened[0].options.onResult({ version: 1, phoneConnected: true, board: null, rock: null, coverage: null });
  assertEqual(get(mode.scanning).open, false, "Done closes the mode");
  assert(!tiers.designLocked(), "and frees the design");

  mode.enterScan();
  scanner.opened[1].options.onCancel();
  assertEqual(get(mode.scanning).open, false, "Close closes the mode");
  assert(!tiers.designLocked(), "and frees the design");

  mode.enterScan();
  scanner.opened[0].options.onCancel();
  scanner.opened[1].options.onResult({});
  assertEqual(get(mode.scanning).open, true, "an earlier scanner's late word changes nothing");
  mode.exitScan();
  assertEqual(scanner.opened[2].closed, true, "the studio's own close closes the scanner");
  assertEqual(get(mode.scanning).open, false, "and the mode");
  assert(!tiers.designLocked(), "and frees the design");
});

Deno.test("a scanner that cannot be opened is reported, and holds nothing", STUDIO_TEST, async () => {
  // Setup: the startup stone, and a scanner whose open throws (as HousekiScan.open does while
  // another scanner is open on the page).
  // Test: open the mode.
  // Verifies: the mode reports false and stays closed, the design is not held, and the page's error
  // line says what went wrong.
  const { scanner } = await page();

  scanner.fail = "The Houseki scanner is already open.";
  assertEqual(mode.enterScan(), false, "refused");
  assertEqual(get(mode.scanning).open, false, "the mode stays closed");
  assert(!tiers.designLocked(), "the design is not held");
  assert(get(error).text.includes("already open"), "said on the page");
});

Deno.test("one mode at a time: Rough scan and the other modes refuse each other", STUDIO_TEST, async () => {
  // Setup: the startup stone.
  // Test: open edit mode on the first tier and try Rough scan; close it, open Rough scan, and try
  // edit mode and record rendering.
  // Verifies: Rough scan does not open over edit mode (and opens no scanner), and while it is open
  // neither edit mode nor record rendering opens -- the design lock every mode checks.
  const { scanner, design } = await page();

  enterEditMode(design.tiers[0], null);
  assert(get(editing) !== null, "edit mode is open");
  assertEqual(mode.enterScan(), false, "Rough scan refuses over edit mode");
  assertEqual(scanner.opened.length, 0, "and opens no scanner");
  exitEditMode();

  assert(mode.enterScan(), "Rough scan opens");
  enterEditMode(design.tiers[0], null);
  assertEqual(get(editing), null, "edit mode refuses while it is open");
  assertEqual(record.enterRecording({ canvas: null }), false, "record rendering refuses too");
  mode.exitScan();
});
