/*
 * scan_mode_test.js -- tests for Tools > Rough scan (T-0314): src/web/src/lib/scan_mode.js, the
 * mode, and src/web/src/lib/scan_qr.js, the QR code it shows.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The mode is driven through the page's real modules (session.js, tier_controller.js,
 * edit_mode.js, record_mode.js, the mode itself) on a FAKE GemApp with the startup stone loaded,
 * as boot does it. The phone link is tests/fake_scan_link.js, a test double with scan_link.js's
 * shape (`createScanSession() -> { url, onStatus, onStream, close }`), handed to the mode with
 * `setScanBackend`, so each test plays the phone's side itself: a status, a stream, a hang-up.
 * The clipboard and the clock that takes "Copied" down are fakes too.
 *
 * The QR code is checked by DECODING it, with jsQR (Apache-2.0; a dev dependency, used only by the
 * tests), from pixels drawn the way the page draws it: what a phone reads, not what the encoder
 * was asked for.
 *
 * What these cannot show -- the menu, the layout, a real phone page joining the session and a real
 * camera playing in the <video> -- is tests/harness/test_scan_mode.py's, in headless Chrome.
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
const { default: jsQR } = await import("jsqr");
const { objTextFromBytes } = await import("../src/lib/design_load.js");
const { installLoadedDesign, startSession } = await import("../src/lib/session.js");
const { engine, canUndo } = await import("../src/lib/stores.js");
const { attachCanvasControls } = await import("../src/lib/viewport.js");
const tiers = await import("../src/lib/tier_controller.js");
const { enterEditMode, exitEditMode, editing } = await import("../src/lib/edit_mode.js");
const record = await import("../src/lib/record_mode.js");
const mode = await import("../src/lib/scan_mode.js");
const { qrCode, QR_QUIET_ZONE } = await import("../src/lib/scan_qr.js");
const { fakeScanLink } = await import("./fake_scan_link.js");

const STARTUP_URL = new URL("../../resources/hex_cut_v2.gcs", import.meta.url);

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

/**
 * Decodes a QR code the way a phone would: draws it as pixels -- dark modules black, light ones
 * white, `scale` pixels a module, exactly what the page's SVG draws -- and hands them to jsQR.
 * Returns the text it holds, or null when it cannot be read.
 */
function decode(qr, scale = 4) {
  const width = qr.size * scale;
  const pixels = new Uint8ClampedArray(width * width * 4);

  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const dark = qr.modules[Math.floor(y / scale)][Math.floor(x / scale)];
      const at = (y * width + x) * 4;

      pixels.fill(dark ? 0 : 255, at, at + 3);
      pixels[at + 3] = 255;
    }
  }

  return jsQR(pixels, width, width)?.data ?? null;
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
 * fake phone link, a fake clipboard (`clipboard.fail` makes it refuse) and a fake clock whose
 * timers a test runs by hand (`timers`).
 */
async function page() {
  const app = fakeApp();
  const stone = objTextFromBytes("hex_cut_v2.gcs", await Deno.readFile(STARTUP_URL));
  const link = fakeScanLink();
  const clipboard = { written: [], fail: false };
  const timers = [];

  mode.exitScan();
  record.exitRecording();
  mode.setScanBackend({
    createSession: link,
    writeText: async text => {
      if (clipboard.fail) {
        throw new Error("Write permission denied.");
      }

      clipboard.written.push(text);
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
  });

  engine.app = app;
  startSession(app);
  attachCanvasControls({ addEventListener() {}, clientWidth: 100, clientHeight: 100, classList: { add() {}, remove() {} } });
  installLoadedDesign(app, { text: stone.text, design: stone.design, gear: stone.gear, title: "test" });

  return { app, link, clipboard, timers, design: stone.design };
}

Deno.test("the QR code decodes to the link it was made from, with its quiet zone clear", () => {
  // Setup: a link of the length the scanner's will be -- the phone page, then a room id and a
  // 32-character password in the hash -- and a short one.
  // Test: make each code with scan_qr.js's qrCode, draw it as the page does, and decode it.
  // Verifies: what a QR reader gets back is exactly the link, character for character, hash
  // included (a code that dropped or mangled the password would let nobody in); the code is
  // square; and the outer four modules on every side are all light -- the quiet zone a phone
  // needs to find the code against a busy page.
  const links = [
    "https://houseki.app/scanner#r=0f1e2d3c4b5a6978&p=00112233445566778899aabbccddeeff",
    "http://localhost:8123/scanner#r=ab&p=cd",
  ];

  for (const link of links) {
    const qr = qrCode(link);

    assertEqual(decode(qr), link, "the code decodes to the link");
    assertEqual(qr.modules.length, qr.size, "as many rows as the size");
    assert(qr.modules.every(row => row.length === qr.size), "every row as long as the size");

    for (let i = 0; i < qr.size; i++) {
      for (let edge = 0; edge < QR_QUIET_ZONE; edge++) {
        const far = qr.size - 1 - edge;

        assert(!qr.modules[edge][i] && !qr.modules[far][i] && !qr.modules[i][edge] && !qr.modules[i][far],
          `the quiet zone is light at ring ${edge}, module ${i}`);
      }
    }
  }
});

Deno.test("the code's SVG path covers exactly its dark modules", () => {
  // Setup: the code for a scanner-like link.
  // Test: read every rectangle back out of the path (`M x y h w v1 h -w z`, one per run of dark
  // modules in a row) and paint them onto an empty grid.
  // Verifies: the painted grid is the code's own, module for module -- the page draws exactly the
  // code that was encoded, with no run cut short, run on or shifted a row.
  const qr = qrCode("https://houseki.app/scanner#r=1234&p=5678");
  const painted = Array.from({ length: qr.size }, () => new Array(qr.size).fill(false));

  for (const [, x, y, w] of qr.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(w); i++) {
      painted[Number(y)][Number(x) + i] = true;
    }
  }

  assertEqual(painted, qr.modules, "the path paints the dark modules and nothing else");
});

Deno.test("the mode makes its session with no options, unless the tests' relays are saved", async () => {
  // Setup: the startup stone and the fake link; the page's storage with no relay list, then with
  // the tests' list under SCAN_RELAYS_SETTING, then with something that is not a list of URLs.
  // Test: open the mode each way and look at what the session was made with.
  // Verifies the one test-only path: in use the mode passes scan_link.js no options at all (its
  // own defaults: the public relays, the phone page beside the studio); a saved list of relay URLs
  // is passed on as `relayUrls`, and so reaches the link the phone opens (`s=`); and a corrupt
  // value is ignored rather than breaking the session.
  const { link } = await page();
  const relay = "ws://127.0.0.1:7777";

  localStorage.removeItem(mode.SCAN_RELAYS_SETTING);
  mode.enterScan();
  assertEqual(link.sessions[0].options, {}, "no options in use");
  mode.exitScan();

  localStorage.setItem(mode.SCAN_RELAYS_SETTING, JSON.stringify([relay]));
  mode.enterScan();
  assertEqual(link.sessions[1].options, { relayUrls: [relay] }, "the saved relays");
  assert(get(mode.scanning).url.includes("&s="), "carried in the link");
  mode.exitScan();

  localStorage.setItem(mode.SCAN_RELAYS_SETTING, "not json");
  mode.enterScan();
  assertEqual(link.sessions[2].options, {}, "a corrupt value is ignored");
  mode.exitScan();
  localStorage.removeItem(mode.SCAN_RELAYS_SETTING);
});

Deno.test("opening the mode starts a session and shows its link as a code that decodes to it", async () => {
  // Setup: the startup stone, nothing open.
  // Test: open the mode.
  // Verifies: exactly one session is made; the mode shows it waiting, with its URL, and a QR code
  // that decodes to that same URL; no camera yet; the design is held (another mode cannot open,
  // the tier toolbar would say why) and Undo has nothing to step while the mode is open.
  const { link } = await page();

  assert(mode.enterScan(), "the mode opens");
  assertEqual(link.sessions.length, 1, "one session");

  const state = get(mode.scanning);

  assertEqual([state.open, state.status], [true, "waiting"], "open and waiting");
  assertEqual(state.url, link.sessions[0].url, "the session's URL");
  assertEqual(decode(state.qr), link.sessions[0].url, "the code decodes to the session's URL");
  assertEqual(get(mode.scanStream), null, "no camera yet");
  assert(tiers.designLocked(), "the design is held");
  assertEqual(get(canUndo), false, "nothing to undo while it is open");
  mode.exitScan();
});

Deno.test("the phone's statuses and its camera reach the view, and a hang-up clears the picture", async () => {
  // Setup: the mode open on a fake session.
  // Test: play the phone's side in the order scan_link.js reports it: 'connecting' (the password
  // handshake passed), then the camera stream with 'connected', then 'disconnected' (the phone
  // left; the session stays open), then the phone back with its stream again.
  // Verifies: each status is shown as it comes, in words (scanStatusText); the stream is handed to
  // the view the moment it arrives, and the status reads "Streaming"; when the phone goes away the
  // stream is dropped, so its last picture is not left frozen on screen, the status says it
  // disconnected, and the same code is still there to scan (the session is still open); and the
  // phone coming back on the same session shows its camera again.
  const { link } = await page();

  mode.enterScan();

  const session = link.sessions[0];
  const camera = { id: "the phone's camera" };

  session.emitStatus("connecting", "phone-peer");
  assertEqual(get(mode.scanning).status, "connecting", "connecting");
  assertEqual(mode.scanStatusText(get(mode.scanning), false).title, "Connecting…", "said as connecting");

  session.emitStream(camera);
  session.emitStatus("connected", "phone-peer");
  assertEqual(get(mode.scanning).status, "connected", "connected");
  assertEqual(get(mode.scanStream), camera, "the camera reaches the view");
  assertEqual(mode.scanStatusText(get(mode.scanning), true).title, "Streaming", "said as streaming");

  session.emitStatus("disconnected", "phone-peer");
  assertEqual(get(mode.scanStream), null, "the picture is dropped");
  assertEqual(mode.scanStatusText(get(mode.scanning), false).title, "Phone disconnected", "said as disconnected");
  assertEqual(decode(get(mode.scanning).qr), session.url, "the same code is still there to scan");
  assert(!session.closed, "the session stays open");

  session.emitStream(camera);
  session.emitStatus("connected", "phone-peer");
  assertEqual(get(mode.scanStream), camera, "the phone is back");
  mode.exitScan();
});

Deno.test("a session's error says what went wrong in words, and clears when it recovers", async () => {
  // Setup: the mode open on a fake session.
  // Test: report 'error' with scan_link.js's 'signaling-unreachable' (no relay answered for 15 s),
  // then 'waiting' again (a relay answered), then an 'error' with another reason.
  // Verifies: the unreachable case gets its own sentence about this computer's internet
  // connection, never the bare code; the error clears when the session goes back to waiting;
  // and any other failure is reported with its reason and the way out (New code).
  const { link } = await page();

  mode.enterScan();

  const session = link.sessions[0];

  session.emitStatus("error", "signaling-unreachable");
  assertEqual(get(mode.scanning).status, "error", "an error");
  assert(get(mode.scanning).error.includes("internet connection"), "said in words");
  assert(!get(mode.scanning).error.includes("signaling-unreachable"), "not as a code");

  session.emitStatus("waiting");
  assertEqual([get(mode.scanning).status, get(mode.scanning).error], ["waiting", ""], "recovered");

  session.emitStatus("error", "ICE failed");
  assert(get(mode.scanning).error.includes("ICE failed") && get(mode.scanning).error.includes("New code"),
    "another failure, with its reason and the way out");
  mode.exitScan();
});

Deno.test("Done closes the session, and reopening makes a new one with a new link", async () => {
  // Setup: the mode open, a phone connected and streaming.
  // Test: Done (exitScan, which Escape also calls), then a late word from the closed session,
  // then open the mode again.
  // Verifies: the session is closed (so its link stops working) and the camera dropped; the page
  // is back as it was -- the mode closed, the design no longer held, Undo the edit history's
  // again; nothing the closed session says afterwards reaches the page; and opening again makes a
  // second session, with a link that is not the first's (a new password).
  const { link } = await page();

  mode.enterScan();

  const first = link.sessions[0];

  first.emitStream({ id: "camera" });
  first.emitStatus("connected");
  mode.exitScan();

  assert(first.closed, "the session is closed");
  assertEqual(get(mode.scanning).open, false, "the mode is closed");
  assertEqual(get(mode.scanStream), null, "the camera is dropped");
  assert(!tiers.designLocked(), "the design is free again");

  first.emitStream({ id: "late" });
  first.emitStatus("connected");
  assertEqual(get(mode.scanStream), null, "a closed session's stream is ignored");
  assertEqual(get(mode.scanning).open, false, "and its status too");

  mode.enterScan();
  assertEqual(link.sessions.length, 2, "a second session");
  assert(link.sessions[1].url !== first.url, "with a new link");
  assertEqual(get(mode.scanning).url, link.sessions[1].url, "shown");
  mode.exitScan();
  assert(link.sessions[1].closed, "closed in turn");
});

Deno.test("New code ends the session and starts another without leaving the mode", async () => {
  // Setup: the mode open, a phone streaming on the first session.
  // Test: New code, then a late stream from the first session.
  // Verifies: the first session is closed and its camera dropped; a second is made and shown,
  // waiting, with its own code; the mode stays open; and the first session can no longer put
  // anything on the screen.
  const { link } = await page();

  mode.enterScan();
  link.sessions[0].emitStatus("connected");
  link.sessions[0].emitStream({ id: "camera" });

  mode.newScanCode();

  assert(link.sessions[0].closed, "the first session is closed");
  assertEqual(link.sessions.length, 2, "a second session");

  const state = get(mode.scanning);

  assertEqual([state.open, state.status], [true, "waiting"], "still open, waiting again");
  assertEqual(decode(state.qr), link.sessions[1].url, "the new code holds the new link");
  assertEqual(get(mode.scanStream), null, "no camera");

  link.sessions[0].emitStream({ id: "late" });
  assertEqual(get(mode.scanStream), null, "the old session is not heard");
  mode.exitScan();
});

Deno.test("Copy puts the link on the clipboard, says so for a moment, and falls back to selecting it", async () => {
  // Setup: the mode open; a fake clipboard, and a fake clock for "Copied".
  // Test: Copy; run the clock's timer; then make the clipboard refuse (as it can from a page
  // opened as a file) and Copy again.
  // Verifies: what reaches the clipboard is exactly the session's URL; the button says "Copied"
  // (`copy` 'copied') until the timer, two seconds later, takes it down; and a refusal is not
  // lost or thrown -- `copy` is 'manual', which has the view select the link's text for the user
  // to copy by hand.
  const { link, clipboard, timers } = await page();

  mode.enterScan();

  assertEqual(await mode.copyScanLink(), "copied", "copied");
  assertEqual(clipboard.written, [link.sessions[0].url], "the session's URL, exactly");
  assertEqual(get(mode.scanning).copy, "copied", "the button says so");
  assertEqual(timers.map(timer => timer.ms), [mode.COPIED_MS], "for a moment");

  timers[0].fn();
  assertEqual(get(mode.scanning).copy, null, "and then not");

  clipboard.fail = true;
  assertEqual(await mode.copyScanLink(), "manual", "the clipboard refused");
  assertEqual(get(mode.scanning).copy, "manual", "the view selects the link instead");
  mode.exitScan();
});

Deno.test("one mode at a time: Rough scan and the other modes refuse each other", async () => {
  // Setup: the startup stone.
  // Test: open edit mode on the first tier and try Rough scan; close it, open Rough scan, and try
  // edit mode and record rendering.
  // Verifies: Rough scan does not open over edit mode (and makes no session), and while it is open
  // neither edit mode nor record rendering opens -- the design lock every mode checks.
  const { link, design } = await page();

  enterEditMode(design.tiers[0], null);
  assert(get(editing) !== null, "edit mode is open");
  assertEqual(mode.enterScan(), false, "Rough scan refuses over edit mode");
  assertEqual(link.sessions.length, 0, "and makes no session");
  exitEditMode();

  assert(mode.enterScan(), "Rough scan opens");
  enterEditMode(design.tiers[0], null);
  assertEqual(get(editing), null, "edit mode refuses while it is open");
  assertEqual(record.enterRecording({ canvas: null }), false, "record rendering refuses too");
  mode.exitScan();
});

Deno.test("a session that cannot be made is reported, not thrown", async () => {
  // Setup: the mode with no phone link at all (as a build without one would have), then with one
  // that throws as it is made.
  // Test: open the mode each way.
  // Verifies: the mode still opens -- so Done and Escape still work -- with an 'error' status, no
  // code, and a sentence that says what went wrong; and New code tries again, with a working link
  // making a working code.
  await page();

  mode.setScanBackend({ createSession: null });
  assert(mode.enterScan(), "opens without a link");
  assertEqual([get(mode.scanning).status, get(mode.scanning).qr], ["error", null], "an error, no code");
  assertEqual(get(mode.scanning).error, mode.NO_LINK_MESSAGE, "said plainly");
  mode.exitScan();

  mode.setScanBackend({ createSession: () => { throw new Error("no network"); } });
  assert(mode.enterScan(), "opens when the link throws");
  assertEqual(get(mode.scanning).status, "error", "an error");
  assert(get(mode.scanning).error.includes("no network"), "with the reason");

  const link = fakeScanLink();

  mode.setScanBackend({ createSession: link });
  mode.newScanCode();
  assertEqual(get(mode.scanning).status, "waiting", "New code tries again");
  assertEqual(decode(get(mode.scanning).qr), link.sessions[0].url, "with a working code");
  mode.exitScan();
});
