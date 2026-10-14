// Tools > Rough scan (T-0314), since T-0337 the studio's way into the scanner that any website can
// open: it calls scanner_sdk.js's openScanner, exactly as a website calls HousekiScan.open from
// /scanner.js, and the scan page (/scanner/embed.html) appears in a modal over the studio. The
// user, 2026-10-12: "lets split our site, can you put the scanner at www.houseki.app/scanner.js and
// embed it into the main site", and, asked how the studio should show it, chose "the same popup
// partners get". Until T-0337 the scanner was this mode itself: its panel in the left pane and the
// QR code over the renderer. That is now the scan page's (scan_session.js, ScanPanel.svelte,
// ScanView.svelte, src/web/embed).
//
// What is left here is the mode's hold on the studio, on record rendering's pattern
// (kb/application-modes-current-and-planned.md): the design held while the scanner is open
// (`setDesignLock`, the toolbar saying why), Undo and Redo inert, the stone neither picked nor drawn
// (it is covered, and the GPU is better left alone while the scan page decodes the phone's video).
// The mode ends when the scanner does: Done (the result, which the studio does not use yet), its
// Close, or Escape, in the scan page or in the studio.
//
// The scan page is the one beside the studio: on its own site when the studio is served over
// http(s) (houseki.app, or a local test server), and in the same build when the studio is opened
// from a file (scanner_protocol.js studioEmbedUrl), so a local build always tries its own. A saved
// copy of the studio is a single file with no scan page beside it: then the published one is
// opened instead (scanner_sdk.js's fallbackUrl).

import { writable, get } from 'svelte/store';
import { editing } from './edit_mode.js';
import { setDesignLock, designLocked, syncToolbar, setStonePickBlock } from './tier_controller.js';
import { setLocalHistory } from './session.js';
import { setRenderHold, releaseRenderHold } from './viewport.js';
import { showError } from './stores.js';
import { openScanner } from './scanner_sdk.js';
import { studioEmbedUrl, PUBLIC_EMBED_URL } from './scanner_protocol.js';

/** Added to every tier toolbar button's tooltip while the mode holds the design. */
export const CLOSE_SCAN_TIP = ' Close the rough scan first: Done, or Escape.';

// The pieces from outside the mode, replaceable by the tests (`setScanBackend`):
//   open      scanner_sdk.js's openScanner: `({ onResult, onCancel, embedUrl, fallbackUrl }) => { close }`
//   embedUrl  the scan page's address, for this page's location
const DEFAULT_BACKEND = {
  open: openScanner,
  embedUrl: () => studioEmbedUrl(globalThis.location),
};

let backend = DEFAULT_BACKEND;

/** For the tests: replaces some of the outside pieces (the rest stay the real ones). */
export function setScanBackend(overrides = {}) {
  backend = { ...DEFAULT_BACKEND, ...overrides };
}

/** `{ open }`: whether the scanner is open over the studio. */
export const scanning = writable({ open: false });

// The open scanner's handle (`{ close }`), or null.
let scanner = null;

/** True while the mode is open. */
export function scanOpen() {
  return scanner !== null;
}

// The whole design is held while the mode is open, and the toolbar says why; the stone is covered,
// so nothing picks it and nothing draws it.
setDesignLock(() => scanner !== null, CLOSE_SCAN_TIP);
setStonePickBlock(() => scanner !== null);
setRenderHold(() => scanner !== null);

/** Undo and Redo while open: nothing to step -- the mode changes nothing in the design. */
const INERT_HISTORY = {
  canUndo: () => false,
  canRedo: () => false,
  undo: () => {},
  redo: () => {},
};

/**
 * Opens the scanner over the studio. Works with any stone or none: the stone plays no part. Does
 * nothing, and returns false, while another mode is open or this one already is, or if the scanner
 * cannot be opened (then says why).
 */
export function enterScan() {
  if (scanner !== null || get(editing) !== null || designLocked()) {
    return false;
  }

  // The handle is set before the scanner can call back, so a callback always finds it.
  let handle = null;
  const ended = () => {
    if (scanner === handle) {
      release();
    }
  };

  try {
    handle = { close: () => {} };
    scanner = handle;
    const embedUrl = backend.embedUrl();
    // Only a scan page beside a file may be missing (a saved copy of the studio).
    const fallbackUrl = embedUrl.startsWith('file:') ? PUBLIC_EMBED_URL : undefined;
    const opened = backend.open({ embedUrl, fallbackUrl, onResult: ended, onCancel: ended });

    if (scanner === handle) {
      handle.close = () => opened.close();
    }
  } catch (cause) {
    scanner = null;
    showError(`The scanner could not be opened: ${cause?.message ?? cause}`);
    return false;
  }

  // Ended already, inside open (a test double may): there is nothing to hold.
  if (scanner !== handle) {
    return false;
  }

  setLocalHistory(INERT_HISTORY);
  scanning.set({ open: true });
  syncToolbar();
  return true;
}

/** Closes the scanner from the studio's side (Escape in the studio), and the mode with it. */
export function exitScan() {
  if (scanner === null) {
    return;
  }

  const handle = scanner;

  release();
  handle.close();
}

/** The scanner has gone: the studio is the studio again. */
function release() {
  scanner = null;
  scanning.set({ open: false });
  setLocalHistory(null);
  syncToolbar();
  // The stone is drawn again, with whatever changed in the render settings meanwhile.
  releaseRenderHold();
  globalThis.window?.gemRequestRender?.();
}
