// The scan page's side of the scanner protocol (T-0337): waits for the handshake from the website
// that opened it, then talks to that website over the channel it was given. The protocol is
// scanner_protocol.js's; read its header first. The page itself is src/web/embed.

import { readScanMessage, scanMessage, SCAN_PROTOCOL_VERSION } from './scanner_protocol.js';

/**
 * Listens on `window` for the website's handshake, and calls `onInit(site)` for the first valid
 * one, with `site` = `{ origin, post(type, fields), onMessage(cb), close() }`:
 *   origin       the website's origin as the browser stamped it ('null' for a page opened from a
 *                file); scanner_protocol.js siteName() words it
 *   post         sends the website a message ('ready', 'status', 'result', 'cancel')
 *   onMessage    cb(message) for each message from the website ('close')
 *   close        closes the channel; nothing is sent or heard after it
 * Only a message from the window that framed this page counts: never one from this page itself, a
 * frame inside it, or a page it opened. A handshake of a newer version than this page's is refused
 * (`onRefused(reason)`), as is a second handshake.
 *
 * Returns `{ framed, stop }`: `framed` false when this page is not in a frame at all (opened on its
 * own), so no handshake can come; `stop()` stops listening.
 */
export function waitForSite({ window = globalThis.window, onInit, onRefused = () => {} }) {
  const parent = window.parent;
  const framed = Boolean(parent) && parent !== window;
  let accepted = false;

  const onMessage = event => {
    if (!framed || accepted || event.source !== parent) {
      return;
    }

    const message = readScanMessage(event.data, 'site');

    if (!message || message.type !== 'init') {
      return;
    }

    const port = event.ports?.[0];

    if (!port) {
      onRefused('no-channel');
      return;
    }

    if (!(Number.isInteger(message.version) && message.version >= 1 && message.version <= SCAN_PROTOCOL_VERSION)) {
      port.postMessage(scanMessage('cancel', { reason: 'unsupported-version' }));
      port.close();
      onRefused('unsupported-version');
      return;
    }

    accepted = true;
    window.removeEventListener('message', onMessage);
    onInit(siteLink(event.origin, port));
  };

  if (framed) {
    window.addEventListener('message', onMessage);
  }

  return {
    framed,
    stop: () => window.removeEventListener('message', onMessage),
  };
}

/** The website, at `origin`, over `port`: see waitForSite. */
function siteLink(origin, port) {
  const listeners = new Set();
  let closed = false;

  port.onmessage = event => {
    const message = readScanMessage(event.data, 'site');

    if (!closed && message) {
      listeners.forEach(listener => listener(message));
    }
  };

  return {
    origin,
    post(type, fields) {
      if (!closed) {
        port.postMessage(scanMessage(type, fields));
      }
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      listeners.clear();
      port.close();
    },
  };
}
