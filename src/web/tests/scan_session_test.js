/*
 * scan_session_test.js -- tests for the scanner's session (src/web/src/lib/scan_session.js; until
 * T-0337 Tools > Rough scan's mode, scan_mode.js, T-0314) and src/web/src/lib/scan_qr.js, the QR
 * code it shows. The studio's side of Rough scan, the hold on the design while the scanner is open,
 * is tests/scan_mode_test.js's; the protocol between a website and the scan page,
 * tests/scanner_protocol_test.js's.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The phone link is tests/fake_scan_link.js, a test double with scan_link.js's shape
 * (`createScanSession() -> { url, onStatus, onStream, close }`), handed to the session with
 * `setScanBackend`, so each test plays the phone's side itself: a status, a stream, a hang-up. The
 * clipboard and the clock that takes "Copied" down are fakes too.
 *
 * The QR code is checked by DECODING it, with jsQR (Apache-2.0; a dev dependency, used only by the
 * tests), from pixels drawn the way the page draws it: what a phone reads, not what the encoder
 * was asked for.
 *
 * What these cannot show -- the scan page's layout, a real phone page joining the session and a
 * real camera playing in the <video> -- is tests/harness/test_scan_mode.py's, in headless Chrome.
 */

const { get } = await import("svelte/store");
const { default: jsQR } = await import("jsqr");
const mode = await import("../src/lib/scan_session.js");
const { qrCode, QR_QUIET_ZONE } = await import("../src/lib/scan_qr.js");
const { fakeScanLink } = await import("./fake_scan_link.js");

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

/**
 * A fresh page: the session closed, and given a fake phone link, a fake clipboard (`clipboard.fail`
 * makes it refuse) and a fake clock whose timers a test runs by hand (`timers`).
 */
async function page() {
  const link = fakeScanLink();
  const clipboard = { written: [], fail: false };
  const timers = [];

  mode.stopScan();
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

  return { link, clipboard, timers };
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
  // Setup: the fake link; the page's storage with no relay list, then with
  // the tests' list under SCAN_RELAYS_SETTING, then with something that is not a list of URLs.
  // Test: open the mode each way and look at what the session was made with.
  // Verifies the one test-only path: in use the mode passes scan_link.js no options at all (its
  // own defaults: the public relays, the phone page beside the scan page); a saved list of relays
  // is passed on as `relayUrls`, and so reaches the link the phone opens (`s=`); and a corrupt
  // value is ignored rather than breaking the session.
  const { link } = await page();
  const relay = "ws://127.0.0.1:7777";

  localStorage.removeItem(mode.SCAN_RELAYS_SETTING);
  mode.startScan();
  assertEqual(link.sessions[0].options, {}, "no options in use");
  mode.stopScan();

  localStorage.setItem(mode.SCAN_RELAYS_SETTING, JSON.stringify([relay]));
  mode.startScan();
  assertEqual(link.sessions[1].options, { relayUrls: [relay] }, "the saved relays");
  assert(get(mode.scanning).url.includes("&s="), "carried in the link");
  mode.stopScan();

  localStorage.setItem(mode.SCAN_RELAYS_SETTING, "not json");
  mode.startScan();
  assertEqual(link.sessions[2].options, {}, "a corrupt value is ignored");
  mode.stopScan();
  localStorage.removeItem(mode.SCAN_RELAYS_SETTING);
});

Deno.test("opening the mode starts a session and shows its link as a code that decodes to it", async () => {
  // Setup: nothing open.
  // Test: open the mode.
  // Verifies: exactly one session is made; the mode shows it waiting, with its URL, and a QR code
  // that decodes to that same URL; and no camera yet.
  const { link } = await page();

  assert(mode.startScan(), "the mode opens");
  assertEqual(link.sessions.length, 1, "one session");

  const state = get(mode.scanning);

  assertEqual([state.open, state.status], [true, "waiting"], "open and waiting");
  assertEqual(state.url, link.sessions[0].url, "the session's URL");
  assertEqual(decode(state.qr), link.sessions[0].url, "the code decodes to the session's URL");
  assertEqual(get(mode.scanStream), null, "no camera yet");
  mode.stopScan();
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

  mode.startScan();

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
  mode.stopScan();
});

Deno.test("a session's error says what went wrong in words, and clears when it recovers", async () => {
  // Setup: the mode open on a fake session.
  // Test: report 'error' with scan_link.js's 'signaling-unreachable' (no relay answered for 15 s),
  // then 'waiting' again (a relay answered), then an 'error' with another reason.
  // Verifies: the unreachable case gets its own sentence about this computer's internet
  // connection, never the bare code; the error clears when the session goes back to waiting;
  // and any other failure is reported with its reason and the way out (New code).
  const { link } = await page();

  mode.startScan();

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
  mode.stopScan();
});

Deno.test("Done closes the session, and reopening makes a new one with a new link", async () => {
  // Setup: the mode open, a phone connected and streaming.
  // Test: Done (stopScan, which Close and Escape also call), then a late word from the closed
  // session, then open the scanner again.
  // Verifies: the session is closed (so its link stops working), the camera dropped and the
  // scanner closed; nothing the closed session says afterwards reaches the page; and opening again
  // makes a second session, with a link that is not the first's (a new password).
  const { link } = await page();

  mode.startScan();

  const first = link.sessions[0];

  first.emitStream({ id: "camera" });
  first.emitStatus("connected");
  mode.stopScan();

  assert(first.closed, "the session is closed");
  assertEqual(get(mode.scanning).open, false, "the mode is closed");
  assertEqual(get(mode.scanStream), null, "the camera is dropped");

  first.emitStream({ id: "late" });
  first.emitStatus("connected");
  assertEqual(get(mode.scanStream), null, "a closed session's stream is ignored");
  assertEqual(get(mode.scanning).open, false, "and its status too");

  mode.startScan();
  assertEqual(link.sessions.length, 2, "a second session");
  assert(link.sessions[1].url !== first.url, "with a new link");
  assertEqual(get(mode.scanning).url, link.sessions[1].url, "shown");
  mode.stopScan();
  assert(link.sessions[1].closed, "closed in turn");
});

Deno.test("New code ends the session and starts another without leaving the mode", async () => {
  // Setup: the mode open, a phone streaming on the first session.
  // Test: New code, then a late stream from the first session.
  // Verifies: the first session is closed and its camera dropped; a second is made and shown,
  // waiting, with its own code; the mode stays open; and the first session can no longer put
  // anything on the screen.
  const { link } = await page();

  mode.startScan();
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
  mode.stopScan();
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

  mode.startScan();

  assertEqual(await mode.copyScanLink(), "copied", "copied");
  assertEqual(clipboard.written, [link.sessions[0].url], "the session's URL, exactly");
  assertEqual(get(mode.scanning).copy, "copied", "the button says so");
  assertEqual(timers.map(timer => timer.ms), [mode.COPIED_MS], "for a moment");

  timers[0].fn();
  assertEqual(get(mode.scanning).copy, null, "and then not");

  clipboard.fail = true;
  assertEqual(await mode.copyScanLink(), "manual", "the clipboard refused");
  assertEqual(get(mode.scanning).copy, "manual", "the view selects the link instead");
  mode.stopScan();
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
  assert(mode.startScan(), "opens without a link");
  assertEqual([get(mode.scanning).status, get(mode.scanning).qr], ["error", null], "an error, no code");
  assertEqual(get(mode.scanning).error, mode.NO_LINK_MESSAGE, "said plainly");
  mode.stopScan();

  mode.setScanBackend({ createSession: () => { throw new Error("no network"); } });
  assert(mode.startScan(), "opens when the link throws");
  assertEqual(get(mode.scanning).status, "error", "an error");
  assert(get(mode.scanning).error.includes("no network"), "with the reason");

  const link = fakeScanLink();

  mode.setScanBackend({ createSession: link });
  mode.newScanCode();
  assertEqual(get(mode.scanning).status, "waiting", "New code tries again");
  assertEqual(decode(get(mode.scanning).qr), link.sessions[0].url, "with a working code");
  mode.stopScan();
});

// --- what the phone sees (T-0326) -----------------------------------------------------------------

/** A validated vision message, as scan_link.js hands one over: a posed frame with a rock outline. */
function visionMessage(overrides = {}) {
  return {
    v: 1,
    timeMs: 1000,
    frame: { w: 1280, h: 720 },
    board: {
      recognised: true, corners: 120, markers: 60, sheet: "charuco_23x17_10mm_strip", sheetFrom: "default",
      targetMm: [80, 110], sizeMm: [170, 230],
    },
    pose: {
      R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [-85, 115, 300], center: [85, 115, 300],
      azimuthDeg: 0, elevationDeg: 62.4, distanceMm: 312.6, rmsPx: 0.4, valid: true,
    },
    intrinsics: { f: 1088, cx: 640, cy: 360, k1: 0, source: "closed-form" },
    outline: { timeMs: 990, contour: [[600, 300], [700, 300], [650, 400]], box: [600, 300, 100, 100], confidence: 0.9, flags: [] },
    ...overrides,
  };
}

Deno.test("the phone's vision messages reach the view while it streams, and go with its picture", async () => {
  // Setup: the mode open on a fake session that has onVision, with a fake arrival clock.
  // Test: a vision message before the camera has arrived; then the camera, and a message; then the
  // phone hangs up; then New code, and Done, each after a message.
  // Verifies: a message before the picture is ignored (there is nothing to draw it over); with
  // the picture up, the latest message is the store's, stamped with its arrival time; when the
  // phone leaves, New code is made or the mode closes, the message goes with the picture (no stale
  // outline left over a new session or the next phone).
  const { link } = await page();
  let clock = 5000;

  mode.setScanBackend({ createSession: link, now: () => clock });
  mode.startScan();

  const session = link.sessions[0];
  session.emitVision(visionMessage());
  assertEqual(get(mode.scanVision), null, "ignored before the picture");

  session.emitStream({ id: "camera" });
  session.emitStatus("connected", "phone-peer");
  session.emitVision(visionMessage({ timeMs: 2000 }));
  assertEqual(get(mode.scanVision).message.timeMs, 2000, "the latest message");
  assertEqual(get(mode.scanVision).receivedAt, 5000, "stamped on arrival");

  clock = 5100;
  session.emitVision(visionMessage({ timeMs: 2100 }));
  assertEqual([get(mode.scanVision).message.timeMs, get(mode.scanVision).receivedAt], [2100, 5100], "replaced by the next");

  session.emitStatus("disconnected", "phone-peer");
  assertEqual(get(mode.scanVision), null, "gone with the phone");

  session.emitStream({ id: "camera" });
  session.emitVision(visionMessage());
  mode.newScanCode();
  assertEqual(get(mode.scanVision), null, "gone with New code");

  const second = link.sessions[1];
  second.emitStream({ id: "camera" });
  second.emitVision(visionMessage());
  assert(get(mode.scanVision) !== null, "the new session's phone is heard");
  session.emitVision(visionMessage({ timeMs: 9 }));
  assert(get(mode.scanVision).message.timeMs !== 9, "the old session is not");

  mode.stopScan();
  assertEqual(get(mode.scanVision), null, "gone with Done");
});

Deno.test("a session or phone without vision leaves the mode as it was", async () => {
  // Setup: the mode on a fake session WITHOUT onVision (a scan_link.js from before T-0326), and
  // separately one with it whose phone never sends (an older phone page).
  // Test: open the mode, stream, hang up, close.
  // Verifies: nothing throws, the picture comes and goes as before, the vision store stays null
  // throughout, and the panel's readout (scanVisionText) has nothing to say (null): the scanner
  // shows exactly what it showed before vision existed.
  const { link } = await page();

  for (const factory of [fakeScanLink({ withVision: false }), link]) {
    mode.setScanBackend({ createSession: factory });
    assert(mode.startScan(), "opens");
    const session = factory.sessions.at(-1);
    session.emitStream({ id: "camera" });
    session.emitStatus("connected", "phone-peer");
    assertEqual(get(mode.scanStream)?.id, "camera", "the picture as before");
    assertEqual(get(mode.scanVision), null, "no vision");
    assertEqual(mode.scanVisionText(get(mode.scanVision), 0), null, "nothing to read out");
    session.emitStatus("disconnected", "phone-peer");
    assertEqual(get(mode.scanStream), null, "the picture goes as before");
    mode.stopScan();
  }
});

Deno.test("scanVisionText reads out the board, the camera, the lens and the rock in words", () => {
  // Setup: vision values as the store holds them, received at t = 1000 ms.
  // Test: read each out, now and later.
  // Verifies: a posed frame reads "Found", the camera's distance in cm and its height in degrees,
  // the lens's state and "Outlined"; a frame without a board reads "Not in view" and dashes; an
  // older phone's message naming the sheet it recognised still reads plain "Found" (the studio
  // names no sheet since T-0335); a frame of another printed board (wrongBoard, T-0335) reads "Not
  // the scanner board" with no camera advice; each intrinsics source reads as its own words; and a
  // value more than VISION_GONE_MS old adds a note that the phone has gone quiet.
  const posed = mode.scanVisionText({ message: visionMessage(), receivedAt: 1000 }, 1200);
  assertEqual(posed.rows, [
    { label: "Board", value: "Found" },
    { label: "Camera", value: "31 cm from the target, 62° above the board" },
    { label: "Lens", value: "First estimate, still measuring" },
    { label: "Rock", value: "Outlined" },
  ], "a posed frame");
  assertEqual(posed.note, "", "no note while fresh");

  const empty = mode.scanVisionText({
    message: visionMessage({
      board: { ...visionMessage().board, recognised: false, sheetFrom: "default" },
      pose: null, outline: null, intrinsics: { f: 1088, cx: 640, cy: 360, k1: 0, source: "guess" },
    }),
    receivedAt: 1000,
  }, 1000 + mode.VISION_GONE_MS + 1);
  assertEqual(empty.rows.map(row => row.value), ["Not in view", "–", "Estimating", "–"], "nothing seen");
  assert(empty.note.includes("has not sent anything"), "the quiet phone is noted");

  const refined = mode.scanVisionText({ message: visionMessage({ outline: null, intrinsics: { f: 1088, cx: 640, cy: 360, k1: 0.01, source: "refined" } }), receivedAt: 0 }, 0);
  assertEqual(refined.rows.map(row => row.value).slice(2), ["Measured", "None found on the target"], "measured lens, no rock");

  const older = mode.scanVisionText({
    message: visionMessage({ board: { ...visionMessage().board, sheet: "charuco_23x17_10mm_centre3x3_dots", sheetFrom: "auto" } }),
    receivedAt: 0,
  }, 0);
  assertEqual(older.rows[0].value, "Found", "an older phone's recognised sheet is not named");
  assertEqual(posed.guide, null, "no guide from a phone that sends none");

  const wrong = mode.scanVisionText({
    message: visionMessage({ board: { ...visionMessage().board, wrongBoard: true }, pose: null, outline: null }),
    receivedAt: 0,
  }, 0);
  assertEqual(wrong.rows.map(row => row.value).slice(0, 2), ["Not the scanner board", "–"], "another printed board");
  assertEqual(wrong.rows[3].value, "–", "no rock from another board");
});

Deno.test("scanVisionText adds a Speed row when the phone sends its speed (T-0332)", () => {
  // Setup: a posed message with the optional speed: 9.6 poses a second, 4.1 of them tracked, the
  // overlay 118.4 ms behind the picture (90% within 181 ms), detection 26.6 ms. Then speeds with
  // only some fields, and none.
  // Test: read each out.
  // Verifies: the last row is "Speed", in words with whole milliseconds and one decimal for the
  // rates; the tracked share shows only when there is one; missing fields are left out of the
  // sentence rather than shown as blanks; no speed (an older phone), no row; speedText of nothing
  // is null.
  const speed = { posesPerS: 9.6, trackedPerS: 4.1, ageMs: 118.4, ageP90Ms: 181, detectMs: 26.6 };
  const read = mode.scanVisionText({ message: { ...visionMessage(), speed }, receivedAt: 0 }, 0);
  assertEqual(read.rows.at(-1), {
    label: "Speed",
    value: "9.6 poses a second (4.1 tracked) · position 118 ms old when drawn (90% within 181 ms) · finding the board takes 27 ms",
  }, "the speed row");
  assertEqual(mode.speedText({ posesPerS: 3, trackedPerS: 0, ageMs: 300 }), "3.0 poses a second · position 300 ms old when drawn", "some fields");
  assertEqual(mode.speedText({ detectMs: 140 }), "finding the board takes 140 ms", "one field");
  assert(!mode.scanVisionText({ message: visionMessage(), receivedAt: 0 }, 0).rows.some(row => row.label === "Speed"), "no speed, no row");
  assertEqual(mode.speedText(null), null, "nothing");
});

Deno.test("scanVisionText reads out the phone's scan guidance when it sends one (T-0331)", () => {
  // Setup: a posed message with the optional guide: the camera 18.2 cm from the rock, 35 degrees
  // up, at azimuth 120 (2 o'clock); the 45-degree circle filmed from 0 to 180 degrees, nothing low;
  // the phone showing the focus warning. Then the same without the warning, and without a pose.
  // Verifies: the Camera row is measured from the rock and told as the phone tells it; "Filmed"
  // counts each circle's sides; "Next" is the phone's own advice for this coverage (finish the 45°
  // circle the camera is on, naming the nearest unfilmed stretch); "Warning" reads the warning's
  // title and what to do, and is absent without one; the guide is handed on for the map; without a
  // pose the guide is not read out at all.
  const guide = { azimuthDeg: 120, elevationDeg: 35.2, distanceMm: 182, rockMm: [80, 110, 5], rockFrom: "views", cover: [0, 0b111111, 0, 0], warning: "focus" };
  const read = mode.scanVisionText({ message: { ...visionMessage(), guide }, receivedAt: 0 }, 0);
  const rows = Object.fromEntries(read.rows.map(row => [row.label, row.value]));
  assertEqual(rows.Camera, "18 cm from the rock, 35° above the board, from 2 o'clock", "camera from the rock");
  assertEqual(rows.Filmed, "Low circle 0 of 12 sides · 45° circle 6 of 12 · from above: not yet", "filmed");
  assertEqual(rows.Next, "Circle at 45°: film the 6 to 12 o'clock side.", "next step");
  assertEqual(rows.Warning, "Rock not in focus. Hold the phone still for a moment so it can focus, or move it a little further back.", "warning");
  assertEqual(read.guide.cover, guide.cover, "the guide for the map");

  const calm = mode.scanVisionText({ message: { ...visionMessage(), guide: { ...guide, warning: null } }, receivedAt: 0 }, 0);
  assert(!calm.rows.some(row => row.label === "Warning"), "no warning row without a warning");
  const lost = mode.scanVisionText({ message: { ...visionMessage({ pose: null, outline: null }), guide }, receivedAt: 0 }, 0);
  assert(!lost.rows.some(row => row.label === "Filmed") && lost.guide === null, "no pose: no guidance read out");
});

// --- what the scanner hands back (T-0337) ----------------------------------------------------------

Deno.test("scanResult is null while closed, and says plainly when no phone ever connected", async () => {
  // Setup: the scanner closed, then open on a fake session that no phone joins.
  // Test: ask for the result each way.
  // Verifies: there is no result while the scanner is closed (nothing to hand back); and a scan
  // finished with no phone at all hands back version 1 with phoneConnected false and every
  // measured part null -- never a made-up board or rock.
  await page();
  assertEqual(mode.scanResult(), null, "closed: no result");

  mode.startScan();
  assertEqual(mode.scanResult(), {
    version: mode.SCAN_RESULT_VERSION,
    phoneConnected: false,
    board: null,
    rock: null,
    coverage: null,
  }, "no phone: nothing measured");
  assertEqual(mode.SCAN_RESULT_VERSION, 1, "the first version");
  mode.stopScan();
});

Deno.test("scanResult reads the phone's last vision message, and keeps it after the phone leaves", async () => {
  // Setup: the scanner open; the phone streams and sends a posed message with an outline and the
  // scan guidance (the rock located from outlined views, the 45-degree circle filmed on 6 sides).
  // Test: ask for the result; then the phone hangs up and the result is asked for again; then a
  // message of another printed board (wrongBoard) and one without a pose.
  // Verifies: the result says a phone connected, the board was found with its size and target, the
  // rock was outlined at the position the phone estimated, and the coverage counts (and the raw
  // masks) are the phone's; the result outlives the picture, since a phone that left a moment
  // before Done still did the scanning; and a wrong board is not "found", a frame without a pose
  // outlines no rock and gives no coverage.
  const { link } = await page();

  mode.startScan();

  const session = link.sessions[0];
  const guide = { azimuthDeg: 120, elevationDeg: 35.2, distanceMm: 182, rockMm: [80, 110, 5], rockFrom: "views", cover: [0, 0b111111, 0, 0], warning: null };

  session.emitStream({ id: "camera" });
  session.emitStatus("connected", "phone-peer");
  session.emitVision({ ...visionMessage(), guide });

  const expected = {
    version: 1,
    phoneConnected: true,
    board: { found: true, sizeMm: [170, 230], targetMm: [80, 110] },
    rock: { outlined: true, positionMm: [80, 110, 5] },
    coverage: { low: 0, middle: 6, top: false, masks: [0, 0b111111, 0, 0] },
  };

  assertEqual(mode.scanResult(), expected, "what the phone measured");

  session.emitStatus("disconnected", "phone-peer");
  assertEqual(mode.scanResult(), expected, "kept after the phone left");

  session.emitStream({ id: "camera" });
  session.emitVision(visionMessage({ board: { ...visionMessage().board, wrongBoard: true } }));
  assertEqual(mode.scanResult().board.found, false, "another printed board is not found");

  session.emitVision({ ...visionMessage({ pose: null }), guide });
  assertEqual([mode.scanResult().rock, mode.scanResult().coverage], [{ outlined: false, positionMm: null }, null],
    "no pose: no rock, no coverage");
  mode.stopScan();
});
