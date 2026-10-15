// The scanner's session: the QR code, the phone's camera and what the phone sees, for the scan page
// (src/web/embed, served at /scanner/embed.html) that a website opens in a popup through
// /scanner.js (T-0337). Until T-0337 this was Tools > Rough scan's mode, scan_mode.js, inside the
// studio; the studio now opens the scan page through the same /scanner.js as any other site, and
// its scan_mode.js is only the lock it holds on the design meanwhile. The user, 2026-10-12: "lets
// split our site, can you put the scanner at www.houseki.app/scanner.js and embed it into the main
// site". The rest of this header is the mode's, and still describes the session.
//
// Tools > Rough scan (T-0314): the first step towards scanning a piece of rough with a phone's
// camera. The user, 2026-10-02:
//
//   "the rough scanning mode first shows a qr code on the screen. the qr code embeds a url with a
//   hash in it. the hash encodes everything required for a webrtc session to be established
//   between the phone and the computer ... once the qr code is scanned by the phone, we start
//   streaming the phone's camera output to the phone screen and the website. for now, can we also
//   just stream the camera stream on the website, future updates will come later"
//
// and, later the same day: "in addition to the qr code can you also have a copyable url under the
// qr code so users can send it instead of using the qr code".
//
// The connection itself -- the room, the one-time password in the link's hash, the phone's page --
// is scan_link.js's (T-0313). This file is the session around it: `startScan` makes one, `stopScan`
// ends it. On the scan page the steps and status are on the left (ScanPanel.svelte) and the QR code,
// then the phone's camera once it streams, on the right (ScanView.svelte).
//
// One session per opening (decided with the user, 2026-10-02): closing the scanner closes the
// session, so the phone's link stops working, and opening it again makes a new code with a new
// password. New code does the same without closing the scanner.
//
// What the panel and the view draw is `scanning`, and the phone's camera is `scanStream`:
//
//   status  'waiting'      the code is up, no phone yet
//           'connecting'   a phone with the password has connected; its camera has not arrived
//           'connected'    the phone's camera is streaming (`scanStream`)
//           'disconnected' the phone that was streaming left (closed its page, lost the network).
//                          The session stays open, so the same code or link connects it again.
//           'error'        the session could not be made or failed; `error` says why
//           -- the statuses scan_link.js reports, passed on as they come.
//
// The phone's vision (T-0326): a phone page that finds the printed board, the camera's pose and
// the rock's outline sends a summary of each frame (scan_vision.js); the latest is `scanVision`,
// `{ message, receivedAt }` (receivedAt on performance.now()'s clock), or null while there is
// none. ScanView draws it over the phone's video and ScanPanel reads it out (scanVisionText). It is
// cleared whenever the picture goes (the phone left, New code, Done), and a phone page that sends
// nothing (an older one) leaves it null: the mode then works exactly as before.
//
// The relays. In use the session passes scan_link.js no options at all: the pinned public Nostr
// relays, and the phone page beside the scan page (both are under /scanner/). The one exception is
// for the browser tests (tests/harness/test_scan_mode.py), which have no internet and run their own
// relay: a JSON list of relay URLs saved under SCAN_RELAYS_SETTING in the scan page's own storage
// is passed on as `relayUrls`. Nothing writes it but a script running on the scan page's own
// origin; a site embedding the scanner cannot, since the scan page's storage is its own (and,
// inside another site, partitioned by the browser to that site as well).

import { writable, get } from 'svelte/store';
import { qrCode } from './scan_qr.js';
import { createScanSession } from './scan_link.js';
import { readSetting } from './settings.js';
import { angleText, coverageAdvice, coverageSummary, WARNINGS } from './vision/guidance.js';

/** How long the Copy button says "Copied", in ms. */
export const COPIED_MS = 2000;

/** The tests' own relays, a JSON list of ws:// URLs (see "The relays" above). */
export const SCAN_RELAYS_SETTING = 'gems.scanRelayUrls';

/** What the page says when this build has no way to make a session at all. */
export const NO_LINK_MESSAGE = 'Scanning with a phone is not available in this copy of the scanner.';

// The pieces from outside the session, replaceable by the tests (`setScanBackend`):
//   createSession  scan_link.js's createScanSession: `(options) => { url, onStatus, onStream,
//                  close }`. Called with no options (see "The relays" above), so the phone's page
//                  is the one beside the scan page wherever it is served from, and the public one
//                  when it is opened as a file (scan_link.js's own default).
//   writeText      the clipboard, for Copy.
//   setTimeout     the clock that takes "Copied" down again.
//   now            the clock vision messages are stamped with on arrival (performance.now()).
const DEFAULT_BACKEND = {
  createSession: createScanSession,
  writeText: text => globalThis.navigator.clipboard.writeText(text),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  now: () => globalThis.performance.now(),
};

let backend = DEFAULT_BACKEND;

/** For the tests: replaces some of the outside pieces (the rest stay the real ones). */
export function setScanBackend(overrides = {}) {
  backend = { ...DEFAULT_BACKEND, ...overrides };
}

function closedState() {
  return { open: false, status: 'waiting', url: '', qr: null, error: '', copy: null };
}

/**
 * What the panel and the view draw: `{ open, status, url, qr, error, copy }`. `qr` is scan_qr.js's
 * `qrCode(url)`; `copy` is what became of the last Copy -- 'copied', 'manual' (the clipboard
 * refused, so the link is selected for the user to copy by hand) or null.
 */
export const scanning = writable(closedState());

/** The phone's camera, a MediaStream, while it streams; null otherwise. */
export const scanStream = writable(null);

/**
 * How the connection is going (T-0342): the session's latest scan_trace.js snapshot (`step`,
 * `text`, the relays, the counts, a failure), or null without a session (or one, such as a test
 * double, that reports none). The panel's connection picture and its words follow it.
 */
export const scanTrace = writable(null);

/**
 * The phone's latest vision message, `{ message, receivedAt }`, while its camera streams; null
 * otherwise, and while it has sent none (see the header).
 */
export const scanVision = writable(null);

/** A vision message older than this is drawn faded: the phone has stopped seeing, or lags. */
export const VISION_STALE_MS = 500;

/** ... and older than this, not drawn at all. */
export const VISION_GONE_MS = 3000;

// For the browser harness (tests/harness/test_scan_vision.py), as the app publishes gemApp: the
// latest vision value, read-only. Nothing in the scan page's UI uses it.
if (globalThis.window) {
  globalThis.window.gemScanVision = () => get(scanVision);
}

/** The picture went: so did what was seen in it. */
function dropPicture() {
  scanStream.set(null);
  scanVision.set(null);
}

// The open scanner, or null: `{ link }`, the session it holds (null between one and the next), and
// `copyTimer`, the copy readout's. Named `mode` from when this was the studio's mode.
let mode = null;

/** True while the scanner is open. */
export function scanOpen() {
  return mode !== null;
}

function setState(changes) {
  scanning.update(state => ({ ...state, ...changes }));
}

/**
 * Opens the scanner and starts a session. Does nothing, and returns false, while it is already
 * open.
 */
export function startScan() {
  if (mode !== null) {
    return false;
  }

  mode = { link: null, copyTimer: null };
  scanning.set({ ...closedState(), open: true });
  dropPicture();
  startSession();
  return true;
}

/** Done, Close and Escape: closes the session (the phone's link stops working) and the scanner. */
export function stopScan() {
  if (mode === null) {
    return;
  }

  closeSession();
  mode = null;
  scanning.set(closedState());
  scanTrace.set(null);
  dropPicture();
}

/**
 * New code: closes the session (a phone on it is cut off and its link stops working) and starts
 * another, with a new code and a new password. For a phone that went away, or a link sent to the
 * wrong place.
 */
export function newScanCode() {
  if (mode === null) {
    return;
  }

  closeSession();
  dropPicture();
  startSession();
}

/** Makes a session, and shows its code. A session that cannot be made is an 'error'. */
function startSession() {
  setState({ status: 'waiting', url: '', qr: null, error: '', copy: null });
  scanTrace.set(null);

  if (typeof backend.createSession !== 'function') {
    setState({ status: 'error', error: NO_LINK_MESSAGE });
    return;
  }

  let link;

  try {
    link = backend.createSession(sessionOptions());
    mode.link = link;
    setState({ url: link.url, qr: qrCode(link.url) });
  } catch (cause) {
    mode.link = null;

    try {
      link?.close();
    } catch {
      // Already failed; there is nothing more to close.
    }

    setState({ status: 'error', url: '', qr: null, error: `The session could not be started: ${cause?.message ?? cause}` });
    return;
  }

  // Each session reports only while it is the one the scanner holds: one closed by New code or
  // Done may still have a late word on its way.
  const current = () => mode !== null && mode.link === link;

  link.onStatus((status, detail) => {
    if (!current()) {
      return;
    }

    setState({ status, error: status === 'error' ? errorText(detail) : '' });

    // The phone has gone: its last picture is not left frozen on the screen.
    if (status === 'disconnected' || status === 'error') {
      dropPicture();
    }
  });

  link.onTrace?.(snapshot => {
    if (current()) {
      scanTrace.set(snapshot);
    }
  });
  link.onStream(stream => {
    if (current()) {
      scanStream.set(stream ?? null);

      if (stream) {
        mode.streamed = true;
      }
    }
  });

  // What the phone sees, while its picture is up (scan_link.js validated it). A session made by
  // an older scan_link.js, or a test double, may have no onVision. The latest is also kept past
  // the picture, for the result (scanResult): a phone that left a moment before Done still scanned.
  link.onVision?.(message => {
    if (current() && get(scanStream) !== null) {
      scanVision.set({ message, receivedAt: backend.now() });
      mode.lastVision = message;
    }
  });
}

/** The result format scanResult writes (T-0337); the website reads it as `result.version`. */
export const SCAN_RESULT_VERSION = 1;

/**
 * What the scanner hands back to the website that opened it when the person clicks Done
 * (T-0337), or null while it is closed. Plain data, safe to post to another page:
 *
 *   { version: 1,
 *     phoneConnected,   a phone streamed its camera at some point while the scanner was open
 *     board: null | { found, sizeMm: [X, Y], targetMm: [X, Y] },   the printed board, as last seen
 *     rock: null | { outlined, positionMm: [X, Y, Z] | null },     the rock on it, as last seen
 *     coverage: null | { low, middle, top, masks: [4 numbers] } }  where it was filmed from
 *
 * all from the phone's last vision message (scan_vision.js), null where it sent none. There is no
 * 3D model of the rock yet: when there is, it is added as a new field, and `version` goes up only
 * if a field here changes meaning.
 */
export function scanResult() {
  if (mode === null) {
    return null;
  }

  const message = mode.lastVision ?? null;
  const guide = message?.pose?.valid ? message.guide ?? null : null;

  return {
    version: SCAN_RESULT_VERSION,
    phoneConnected: Boolean(mode.streamed),
    board: message
      ? {
          found: Boolean(message.board.recognised) && message.board.wrongBoard !== true,
          sizeMm: [...message.board.sizeMm],
          targetMm: [...message.board.targetMm],
        }
      : null,
    rock: message
      ? {
          outlined: Boolean(message.pose?.valid && message.outline),
          positionMm: guide?.rockFrom === 'views' ? [...guide.rockMm] : null,
        }
      : null,
    coverage: guide
      ? (({ low, middle, top }) => ({ low, middle, top, masks: [...guide.cover] }))(coverageSummary(guide.cover))
      : null,
  };
}

/**
 * The options the session is made with: none, unless the tests' relays are saved in the page's
 * storage (see "The relays" at the top). A list that does not read as one is ignored.
 */
function sessionOptions() {
  let relayUrls;

  try {
    relayUrls = JSON.parse(readSetting(SCAN_RELAYS_SETTING) ?? 'null');
  } catch {
    relayUrls = null;
  }

  return Array.isArray(relayUrls) && relayUrls.length > 0 && relayUrls.every(url => typeof url === 'string')
    ? { relayUrls }
    : undefined;
}

/** What an 'error' from the session means, in a sentence. */
export function errorText(detail) {
  if (detail === 'signaling-unreachable') {
    return 'The scanner cannot reach the internet service that introduces your phone to this computer. ' +
      'Check this computer\'s internet connection; the code comes back as soon as it is reached.';
  }

  return `The connection to the phone failed${detail ? ` (${detail})` : ''}. Click New code to try again.`;
}

/** Closes the session the scanner holds, if it holds one. */
function closeSession() {
  const link = mode.link;

  mode.link = null;

  try {
    link?.close();
  } catch {
    // A session that fails to close is closed as far as the scanner is concerned: it hears nothing
    // more from it (`current` in startSession).
  }
}

/**
 * Copy: puts the session's link on the clipboard, and says "Copied" for a moment. Where the
 * clipboard refuses (a page opened from a file, an older browser), `copy` is 'manual' and the view
 * selects the link's text for the user to copy with the keyboard. Resolves to the outcome.
 */
export async function copyScanLink() {
  if (mode === null || !get(scanning).url) {
    return null;
  }

  const mine = mode;
  const { url } = get(scanning);
  let outcome;

  try {
    await backend.writeText(url);
    outcome = 'copied';
  } catch {
    outcome = 'manual';
  }

  // The scanner closed, or a new code was made, while the clipboard was busy.
  if (mode !== mine || get(scanning).url !== url) {
    return outcome;
  }

  setState({ copy: outcome });

  if (outcome === 'copied') {
    const timer = backend.setTimeout(() => {
      if (mode === mine && mode.copyTimer === timer && get(scanning).copy === 'copied') {
        setState({ copy: null });
      }
    }, COPIED_MS);

    mode.copyTimer = timer;
  }

  return outcome;
}

/** What each connection step means, under its title (T-0342; the titles are scan_trace.js's). */
export const STEP_DETAILS = Object.freeze({
  servers: 'Connecting to the servers that introduce your phone to this computer.',
  waiting: 'Scan the code with your phone\'s camera, or send it the link.',
  introducing: 'Your phone has opened the link. The two are exchanging connection details through the servers, encrypted with this session\'s password.',
  direct: 'Trying to reach the phone directly over your network.',
  verifying: 'Checking that the phone has this session\'s password.',
  connected: 'Your phone has connected. Waiting for its camera: allow it on the phone if it asks.',
});

/** Under a step whose direct connection failed last time (scan_trace.js `failure`). */
export const DIRECT_FAILED_DETAIL = 'The direct connection to the phone failed. This usually means a VPN on either device, a Wi-Fi network that keeps devices apart (guest, office, school or hotel Wi-Fi), or the phone on mobile data. Trying again; connecting both to the same home Wi-Fi, or this computer to the phone\'s hotspot, usually fixes it.';

/**
 * Whether, after the phone left ('disconnected'), another phone (or the same one, reloaded) is
 * already on its way in: the trace has heard it. The words and the picture then follow its steps,
 * instead of saying "Phone disconnected" until its camera arrives (the user, 2026-10-13: "after the
 * phone disconnects, the computer isn't able to reconnect to a new phone with the same code" --
 * measured, it reconnected in 7-10 s, while every word on the screen said it had not).
 */
export function scanReconnecting(state, trace) {
  return state.status === 'disconnected' && Boolean(trace) && ['introducing', 'direct', 'verifying', 'connected'].includes(trace.step);
}

/**
 * The status in words, for the panel and under the code: `{ title, detail }`. `streaming` is
 * whether the phone's camera has arrived; `trace` the connection's latest step (scanTrace), which
 * names the step while the session is waiting or connecting.
 */
export function scanStatusText(state, streaming, trace = null) {
  if (state.status === 'error') {
    return {
      title: 'Something went wrong',
      detail: state.error || 'The connection to the phone failed. Click New code to try again.',
    };
  }

  if (streaming) {
    return { title: 'Streaming', detail: 'The phone\'s camera is showing. Done finishes the scan and ends the session.' };
  }

  if (trace && (state.status === 'waiting' || state.status === 'connecting' || scanReconnecting(state, trace))) {
    return { title: trace.text, detail: trace.failure ? DIRECT_FAILED_DETAIL : STEP_DETAILS[trace.step] ?? '' };
  }

  switch (state.status) {
    case 'connecting':
    case 'connected':
      return { title: 'Connecting…', detail: 'Your phone has connected. Waiting for its camera: allow it on the phone if it asks.' };
    case 'disconnected':
      return { title: 'Phone disconnected', detail: 'The phone closed the page or lost the network. Scan the code or open the link again to reconnect.' };
    default:
      return { title: 'Waiting for your phone', detail: 'Scan the code with your phone\'s camera, or send it the link.' };
  }
}

/** How old a vision value is, in ms (Infinity for none). */
export function visionAge(vision, nowMs) {
  return vision ? nowMs - vision.receivedAt : Infinity;
}

/**
 * The "Speed" row (T-0332): how fast the phone's vision runs, from the message's optional `speed`,
 * in words a person can compare between phones: "9.6 poses a second · position 120 ms old when
 * drawn (90% within 180 ms) · finding the board takes 27 ms" (the position's age: how old the
 * camera position the phone's drawing starts from is, when a picture is shown). Null without a speed.
 */
export function speedText(speed) {
  if (!speed) {
    return null;
  }

  const parts = [];

  if (speed.posesPerS !== undefined) {
    const tracked = speed.trackedPerS ? ` (${speed.trackedPerS.toFixed(1)} tracked)` : '';
    parts.push(`${speed.posesPerS.toFixed(1)} poses a second${tracked}`);
  }

  if (speed.ageMs !== undefined) {
    const p90 = speed.ageP90Ms !== undefined ? ` (90% within ${Math.round(speed.ageP90Ms)} ms)` : '';
    parts.push(`position ${Math.round(speed.ageMs)} ms old when drawn${p90}`);
  }

  if (speed.detectMs !== undefined) {
    parts.push(`finding the board takes ${Math.round(speed.detectMs)} ms`);
  }

  return parts.length ? parts.join(' · ') : null;
}

/**
 * Which of the scanner's boards a sheet name is, in words (T-0340): 'white/black' for
 * charuco_23x17_10mm_white_black_spiral; null for any other name (an older phone's board).
 */
export function boardColours(sheet) {
  const match = /^charuco_23x17_10mm_(white|grey)_(grey|black)_spiral$/.exec(sheet ?? '');
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * The panel's readout of what the phone sees, as rows of plain words: `{ rows: [{ label, value }],
 * note }`, or null while the phone has sent nothing. `nowMs` is on the receivedAt clock.
 */
export function scanVisionText(vision, nowMs) {
  if (!vision) {
    return null;
  }

  const { board, pose, intrinsics, outline } = vision.message;
  const stale = visionAge(vision, nowMs) > VISION_GONE_MS;
  const posed = Boolean(pose?.valid);
  // Another printed board than the scanner's (T-0335): an older phone says so and finds no position.
  const wrongBoard = board.wrongBoard === true;
  const rows = [];
  const colours = boardColours(board.sheet);

  rows.push({
    label: 'Board',
    value: wrongBoard ? 'Not the scanner board' : board.recognised ? (colours ? `Found (${colours})` : 'Found') : 'Not in view',
  });

  const guide = posed ? vision.message.guide ?? null : null;

  if (guide) {
    // The scan guidance (T-0331): the camera seen from the rock, as the phone shows it.
    const cm = guide.distanceMm / 10;
    rows.push({
      label: 'Camera',
      value: `${cm < 10 ? cm.toFixed(1) : Math.round(cm)} cm from the rock, ${angleText(guide)}`,
    });
  } else if (posed) {
    const cm = pose.distanceMm / 10;
    rows.push({
      label: 'Camera',
      value: `${cm < 10 ? cm.toFixed(1) : Math.round(cm)} cm from the target, ${Math.round(pose.elevationDeg)}° above the board`,
    });
  } else {
    rows.push({ label: 'Camera', value: board.recognised && !wrongBoard ? 'Hold the phone steady' : '–' });
  }

  const lens = intrinsics?.source;
  rows.push({
    label: 'Lens',
    value: lens === 'refined' ? 'Measured' : lens === 'closed-form' || lens === 'table' || lens === 'one-view' ? 'First estimate, still measuring' : 'Estimating',
  });

  // The phone no longer outlines the rock (T-0350): the row only for a phone that still sends one.
  if (posed && outline) {
    rows.push({ label: 'Rock', value: 'Outlined' });
  }

  if (guide) {
    const summary = coverageSummary(guide.cover);
    rows.push({ label: 'Filmed', value: summary.text });
    rows.push({ label: 'Next', value: coverageAdvice(guide.cover, guide).text });
    const warning = WARNINGS.find((w) => w.id === guide.warning);

    if (warning) {
      rows.push({ label: 'Warning', value: `${warning.title}. ${warning.text}` });
    }
  }

  const speed = speedText(vision.message.speed);

  if (speed) {
    rows.push({ label: 'Speed', value: speed });
  }

  return {
    rows,
    note: stale ? 'The phone has not sent anything for a few seconds.' : '',
    // For the coverage map: the rings filmed and where the camera is (null without a guide).
    guide,
  };
}
