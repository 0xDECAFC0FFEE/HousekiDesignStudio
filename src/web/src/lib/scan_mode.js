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
// is scan_link.js's (T-0313). This file is the mode around it, on record rendering's pattern
// (kb/application-modes-current-and-planned.md): opened from the Tools menu, the design held while
// it is open (`setDesignLock`), Undo and Redo inert, Done or Escape close it. Its panel takes the
// LEFT pane (ScanPanel.svelte, stacked over the cutting instructions by Workspace.svelte), the
// render settings stay on the right, and the renderer's place in the middle shows the QR code, then
// the phone's camera once it streams (ScanView.svelte). The stone is not drawn meanwhile: it is
// covered, and the GPU is better left alone while a video is decoded.
//
// One session per opening (decided with the user, 2026-10-02): closing the mode closes the session,
// so the phone's link stops working, and opening it again makes a new code with a new password.
// New code does the same without leaving the mode.
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
// The relays. In use the mode passes scan_link.js no options at all: Trystero's public Nostr
// relays, and the phone page beside the studio. The one exception is for the browser tests
// (tests/harness/test_scan_mode.py), which have no internet and run their own relay: a JSON list
// of relay URLs saved under SCAN_RELAYS_SETTING in this page's own storage is passed on as
// `relayUrls`. Nothing in the studio writes it; only a script running in the page can.

import { writable, get } from 'svelte/store';
import { editing } from './edit_mode.js';
import { setDesignLock, designLocked, syncToolbar, setStonePickBlock } from './tier_controller.js';
import { setLocalHistory } from './session.js';
import { setRenderHold, releaseRenderHold } from './viewport.js';
import { qrCode } from './scan_qr.js';
import { createScanSession } from './scan_link.js';
import { readSetting } from './settings.js';

/** Added to every tier toolbar button's tooltip while the mode holds the design. */
export const CLOSE_SCAN_TIP = ' Close the rough scan first: Done, or Escape.';

/** How long the Copy button says "Copied", in ms. */
export const COPIED_MS = 2000;

/** The tests' own relays, a JSON list of ws:// URLs (see "The relays" above). */
export const SCAN_RELAYS_SETTING = 'gems.scanRelayUrls';

/** What the page says when this build has no way to make a session at all. */
export const NO_LINK_MESSAGE = 'Scanning with a phone is not available in this copy of the studio.';

// The pieces from outside the mode, replaceable by the tests (`setScanBackend`):
//   createSession  scan_link.js's createScanSession: `(options) => { url, onStatus, onStream,
//                  close }`. Called with no options (see "The relays" above), so the phone's page
//                  is the one beside the studio wherever it is served from, and the public one
//                  when it is opened as a file (scan_link.js's own default).
//   writeText      the clipboard, for Copy.
//   setTimeout     the clock that takes "Copied" down again.
const DEFAULT_BACKEND = {
  createSession: createScanSession,
  writeText: text => globalThis.navigator.clipboard.writeText(text),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
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

// The open mode, or null: `{ link }`, the session it holds (null between one and the next), and
// `copyTimer`, the copy readout's.
let mode = null;

/** True while the mode is open. */
export function scanOpen() {
  return mode !== null;
}

// The whole design is held while the mode is open, and the toolbar says why; the stone is covered,
// so nothing picks it and nothing draws it.
setDesignLock(() => mode !== null, CLOSE_SCAN_TIP);
setStonePickBlock(() => mode !== null);
setRenderHold(() => mode !== null);

/** Undo and Redo while open: nothing to step -- the mode changes nothing in the design. */
const INERT_HISTORY = {
  canUndo: () => false,
  canRedo: () => false,
  undo: () => {},
  redo: () => {},
};

function setState(changes) {
  scanning.update(state => ({ ...state, ...changes }));
}

/**
 * Opens the mode and starts a session. Works with any stone or none: the stone plays no part.
 * Does nothing, and returns false, while another mode is open or this one already is.
 */
export function enterScan() {
  if (mode !== null || get(editing) !== null || designLocked()) {
    return false;
  }

  mode = { link: null, copyTimer: null };
  setLocalHistory(INERT_HISTORY);
  scanning.set({ ...closedState(), open: true });
  scanStream.set(null);
  syncToolbar();
  startSession();
  return true;
}

/** Done, and Escape: closes the session (the phone's link stops working) and the mode. */
export function exitScan() {
  if (mode === null) {
    return;
  }

  closeSession();
  mode = null;
  scanning.set(closedState());
  scanStream.set(null);
  setLocalHistory(null);
  syncToolbar();
  // The stone is drawn again, with whatever changed in the render settings meanwhile.
  releaseRenderHold();
  globalThis.window?.gemRequestRender?.();
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
  scanStream.set(null);
  startSession();
}

/** Makes a session, and shows its code. A session that cannot be made is an 'error'. */
function startSession() {
  setState({ status: 'waiting', url: '', qr: null, error: '', copy: null });

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

  // Each session reports to the mode only while it is the one the mode holds: one closed by New
  // code or Done may still have a late word on its way.
  const current = () => mode !== null && mode.link === link;

  link.onStatus((status, detail) => {
    if (!current()) {
      return;
    }

    setState({ status, error: status === 'error' ? errorText(detail) : '' });

    // The phone has gone: its last picture is not left frozen on the screen.
    if (status === 'disconnected' || status === 'error') {
      scanStream.set(null);
    }
  });

  link.onStream(stream => {
    if (current()) {
      scanStream.set(stream ?? null);
    }
  });
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
    return 'The studio cannot reach the internet service that introduces your phone to this computer. ' +
      'Check this computer\'s internet connection; the code comes back as soon as it is reached.';
  }

  return `The connection to the phone failed${detail ? ` (${detail})` : ''}. Click New code to try again.`;
}

/** Closes the session the mode holds, if it holds one. */
function closeSession() {
  const link = mode.link;

  mode.link = null;

  try {
    link?.close();
  } catch {
    // A session that fails to close is closed as far as the mode is concerned: it hears nothing
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

  // The mode closed, or a new code was made, while the clipboard was busy.
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

/**
 * The status in words, for the panel and under the code: `{ title, detail }`. `streaming` is
 * whether the phone's camera has arrived.
 */
export function scanStatusText(state, streaming) {
  if (state.status === 'error') {
    return {
      title: 'Something went wrong',
      detail: state.error || 'The connection to the phone failed. Click New code to try again.',
    };
  }

  if (streaming) {
    return { title: 'Streaming', detail: 'The phone\'s camera is showing. Done ends the session.' };
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
