// The website's side of the scanner (T-0337): `openScanner`, which /scanner.js publishes as
// `HousekiScan.open` and the studio's Tools > Rough scan calls directly (scan_mode.js). It lays a
// modal over the page with the scan page in an iframe, does the handshake, and hands what comes
// back to the caller. The protocol is scanner_protocol.js's; read its header first.
//
//   const scanner = HousekiScan.open({
//     onResult(result) { ... },   Done: scan_session.js scanResult(), `result.version` 1
//     onCancel() { ... },         the person closed the scanner (its X, Escape, or the scanner
//                                 page could not be reached and they closed the notice)
//     onStatus(status) { ... },   optional: 'waiting', 'connecting', 'streaming', 'disconnected',
//                                 'error', as the scan goes
//     embedUrl,                   optional: another copy of the scan page (a test server)
//   });
//   scanner.close();              closes it from the site's side; no callback fires
//
// One scanner at a time: `open` throws while one is open. Exactly one of onResult and onCancel is
// called, once, and never after close().
//
// Everything is made with the DOM by hand and styled inline, not with the studio's Svelte and
// Tailwind: this file is the whole of /scanner.js, which lands on other people's pages, so it must
// be small and must not touch anything of theirs but the one element it adds (and the page's
// scrolling, which it holds still while open and gives back after).

import {
  defaultEmbedUrl,
  embedTargetOrigin,
  readScanMessage,
  scanMessage,
  SCAN_PROTOCOL_VERSION,
} from './scanner_protocol.js';

/** How long the scan page has to say 'ready' before the modal says it could not be reached. */
export const READY_TIMEOUT_MS = 20000;

/** The id of the modal's outermost element, one per page. */
export const OVERLAY_ID = 'houseki-scanner';

const OVERLAY_STYLE = [
  'position:fixed', 'inset:0', 'z-index:2147483647', 'display:flex', 'align-items:center',
  'justify-content:center', 'padding:16px', 'box-sizing:border-box', 'background:rgba(15,18,24,0.62)',
].join(';');

// The scan page's own background (its --panel), so the frame is never a white flash while it loads.
const FRAME_STYLE = [
  'position:relative', 'width:min(1120px,100%)', 'height:min(780px,100%)', 'border-radius:12px',
  'overflow:hidden', 'background:#2e3440', 'box-shadow:0 18px 60px rgba(0,0,0,0.45)',
].join(';');

const IFRAME_STYLE = 'display:block;width:100%;height:100%;border:0;';

const NOTICE_STYLE = [
  'position:absolute', 'inset:0', 'display:flex', 'flex-direction:column', 'align-items:center',
  'justify-content:center', 'gap:14px', 'padding:24px', 'color:#eceff4', 'background:#2e3440',
  'font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif', 'text-align:center',
].join(';');

const BUTTON_STYLE = [
  'padding:6px 14px', 'border:1px solid #8fbcbb', 'border-radius:6px', 'background:#3b4252',
  'color:#eceff4', 'font:inherit', 'cursor:pointer',
].join(';');

let active = null;

/**
 * Opens the scanner over the page (see the header). Returns `{ close }`. Throws if one is already
 * open, or if `onResult` is not a function.
 */
export function openScanner({ onResult, onCancel, onStatus, embedUrl, document = globalThis.document } = {}) {
  if (active !== null) {
    throw new Error('The Houseki scanner is already open.');
  }

  if (typeof onResult !== 'function') {
    throw new TypeError('HousekiScan.open needs an onResult function.');
  }

  const url = new URL(embedUrl ?? defaultEmbedUrl(document.defaultView?.location), document.baseURI).href;
  const targetOrigin = embedTargetOrigin(url);
  const view = document.defaultView;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('style', OVERLAY_STYLE);
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Houseki scanner');

  const frame = document.createElement('div');
  frame.setAttribute('style', FRAME_STYLE);

  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.title = 'Houseki scanner';
  // Copy, on the scan page, writes its link to the clipboard; a cross-origin frame must be allowed to.
  iframe.allow = 'clipboard-write';
  iframe.setAttribute('style', IFRAME_STYLE);

  frame.append(iframe);
  overlay.append(frame);

  const returnFocus = document.activeElement;
  const overflow = document.documentElement.style.overflow;
  let port = null;
  let ready = false;
  let done = false;

  const teardown = () => {
    done = true;
    active = null;
    view?.clearTimeout(readyTimer);
    document.removeEventListener('keydown', onKeyDown, true);
    port?.close();
    overlay.remove();
    document.documentElement.style.overflow = overflow;
    returnFocus?.focus?.();
  };

  // Ends the scanner once, calling `callback(...args)` after the modal has gone.
  const finish = (callback, ...args) => {
    if (done) {
      return;
    }

    teardown();

    try {
      callback?.(...args);
    } catch (cause) {
      console.error(cause);
    }
  };

  const cancel = () => {
    port?.postMessage(scanMessage('close'));
    finish(onCancel);
  };

  // Escape while the site's page has the focus (inside the iframe, the scan page handles it).
  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };

  // A new channel on every load: a scan page that reloads has lost the old one.
  iframe.addEventListener('load', () => {
    if (done) {
      return;
    }

    port?.close();

    const channel = new MessageChannel();

    port = channel.port1;
    port.onmessage = event => {
      const message = readScanMessage(event.data, 'scanner');

      if (done || !message) {
        return;
      }

      if (message.type === 'ready') {
        ready = true;
        iframe.focus();
      } else if (message.type === 'status') {
        try {
          onStatus?.(String(message.status));
        } catch (cause) {
          console.error(cause);
        }
      } else if (message.type === 'result') {
        finish(onResult, message.result);
      } else if (message.type === 'cancel') {
        finish(onCancel);
      }
    };

    iframe.contentWindow.postMessage(scanMessage('init', { version: SCAN_PROTOCOL_VERSION }), targetOrigin, [channel.port2]);
  });

  // The scan page could not be reached (offline, blocked by the site's own rules): say so, with a
  // way out, rather than leaving an empty frame.
  const readyTimer = view?.setTimeout(() => {
    if (ready || done) {
      return;
    }

    const notice = document.createElement('div');
    notice.setAttribute('style', NOTICE_STYLE);
    notice.setAttribute('role', 'alert');

    const text = document.createElement('p');
    text.style.margin = '0';
    text.textContent = 'The scanner could not be loaded. Check your internet connection, then try again.';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Close';
    button.setAttribute('style', BUTTON_STYLE);
    button.addEventListener('click', cancel);

    notice.append(text, button);
    frame.append(notice);
    button.focus();
  }, READY_TIMEOUT_MS);

  document.addEventListener('keydown', onKeyDown, true);
  document.documentElement.style.overflow = 'hidden';
  document.body.append(overlay);

  const handle = {
    close() {
      if (done) {
        return;
      }

      port?.postMessage(scanMessage('close'));
      teardown();
    },
  };

  active = handle;
  return handle;
}
