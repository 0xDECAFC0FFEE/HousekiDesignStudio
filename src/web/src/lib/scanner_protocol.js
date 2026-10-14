// How a website and the scanner it opens talk to each other (T-0337). The user, 2026-10-12: "i
// want to serve the scanner as a website that can integrate against other people's websites ...
// the scanner pop up will pop up, connect to your phone, do some scanning then 'return' the
// scanned data back to the initial parent website", then "lets split our site, can you put the
// scanner at www.houseki.app/scanner.js and embed it into the main site".
//
// THE PIECES
//   /scanner.js            the script a website includes (src/web/sdk/scanner.js, built by
//                          vite.sdk.config.js). It defines `HousekiScan.open(options)`, which lays
//                          a modal over the website with the scan page in an iframe
//                          (scanner_sdk.js).
//   /scanner/embed.html    the scan page (src/web/embed, built by vite.embed.config.js): the QR
//                          code, the phone's camera and what it sees (scan_session.js), and Done.
//                          Its side of this protocol is scanner_host.js.
//   /scanner/              the phone's page, unchanged (src/web/scanner).
// The studio's Tools > Rough scan opens the scan page through scanner_sdk.js too, exactly as a
// website does (decided with the user, 2026-10-12), so the studio is the protocol's first user.
//
// THE HANDSHAKE (version 1)
//   0. The scan page, as soon as it listens for the handshake, posts { protocol, type: 'hello' }
//      to the window that framed it (to '*': it carries nothing, and the scan page cannot know the
//      site's origin yet). Since 2026-10-13: the iframe's `load` alone came seconds late, or not
//      at all, for a studio opened from a file and busy drawing (measured in headless Chrome), and
//      the modal said "could not be loaded" with the scan page sitting there ready.
//   1. The website's page (the "site") makes the iframe and, on its 'hello' (and on its `load`
//      until a hello has come, for a scan page older than 'hello'), a MessageChannel. It posts
//      { protocol: 'houseki-scan', type: 'init', version: 1 } to the iframe's window, addressed to
//      the scan page's origin (so nobody else can receive it), with one end of the channel
//      transferred alongside. The `load` can come before the hello, so a page may be sent two
//      inits: it takes the first, and the site keeps every channel open until the page answers
//      ('ready') on one, then closes the others.
//   2. The scan page accepts the first such message that comes from its parent window. The
//      browser stamps the message with the site's origin, which the site cannot fake: the scan
//      page names it to the person ("Scanning for shop.example"), the way an OAuth consent screen
//      names the app asking. Any site may open the scanner for now (the user's choice, 2026-10-12);
//      an allowlist would be checked here, against that origin.
//   3. From then on everything goes over the channel, which only the two of them hold, as
//      { protocol, type, ... } messages:
//        scan page -> site   'ready'                      the handshake is accepted; the session
//                                                     is starting, its code comes up next
//                            'status' { status }          SITE_STATUSES, as it changes
//                            'result' { result }          Done: scan_session.js scanResult()
//                            'cancel'                     the person closed the scanner
//        site -> scan page   'close'                      the site closed it (HousekiScan's close())
//      After 'result' or 'cancel' the site removes the iframe, which ends the session there.
//   Nothing is posted with targetOrigin '*' except to a scan page opened from file:// (an origin
//   of 'null', which no targetOrigin can name); that only happens in a local copy.
//
// This file is the vocabulary both sides import; it touches no DOM, so the Deno tests can load it.

/** Every message carries this, so neither side mistakes another script's messages for its own. */
export const SCAN_PROTOCOL = 'houseki-scan';

/** The handshake's version. A scan page refuses a site speaking a newer one it does not know. */
export const SCAN_PROTOCOL_VERSION = 1;

/** Where the published scan page is: what a site gets unless it says otherwise. */
export const PUBLIC_EMBED_URL = 'https://houseki.app/scanner/embed.html';

/** The scan page's path, beside the phone's page under /scanner/. */
export const EMBED_PATH = '/scanner/embed.html';

/** What the site hears in 'status' messages, from the scan page's own statuses. */
export const SITE_STATUSES = Object.freeze(['waiting', 'connecting', 'streaming', 'disconnected', 'error']);

/** The message types each side sends. */
const FROM_SCANNER = new Set(['hello', 'ready', 'status', 'result', 'cancel']);
const FROM_SITE = new Set(['init', 'close']);

/**
 * The scan page's address for a page at `location`: the one on its own site when it is served over
 * http(s) (the studio at houseki.app, or a local test server), else the published one (the studio
 * opened from file://). As scan_link_hash.js's defaultScannerBaseUrl picks the phone's page.
 */
export function defaultEmbedUrl(location) {
  const protocol = location?.protocol;

  if ((protocol === 'http:' || protocol === 'https:') && location.origin && location.origin !== 'null') {
    return `${location.origin}${EMBED_PATH}`;
  }

  return PUBLIC_EMBED_URL;
}

/**
 * The scan page the studio opens, for the studio at `location`: as defaultEmbedUrl over http(s),
 * but from a file the scan page in the same build, beside the studio (scanner/embed.html), not the
 * published one. The user, 2026-10-13, with the studio opened from build/www: "don't think the
 * animation is in the computer side - only see the connection status" -- the published scan page
 * was older than the build being tried. A website using /scanner.js keeps defaultEmbedUrl: a file
 * of its own has no scan page beside it.
 */
export function studioEmbedUrl(location) {
  if (location?.protocol === 'file:' && typeof location.href === 'string') {
    return new URL(EMBED_PATH.slice(1), location.href).href;
  }

  return defaultEmbedUrl(location);
}

/**
 * The origin to post the handshake to, for a scan page at `embedUrl`: its own origin, or '*' for a
 * page opened from a file, whose origin is 'null' and cannot be named (see the header). Chrome's
 * URL gives a file:// address the origin "file://", not "null" (Deno's gives "null"), and a
 * handshake addressed to "file://" is dropped without a word, so a file is told by its protocol.
 */
export function embedTargetOrigin(embedUrl) {
  const url = new URL(embedUrl);

  return url.protocol === 'file:' || url.origin === 'null' ? '*' : url.origin;
}

/** A protocol message of `type`, with `fields`. */
export function scanMessage(type, fields = {}) {
  return { ...fields, protocol: SCAN_PROTOCOL, type };
}

/**
 * `data` as a message from the scan page (`from` 'scanner') or the site ('site'), or null when it
 * is not one: another script's message, an unknown type, or a type the other side never sends.
 */
export function readScanMessage(data, from) {
  if (!data || typeof data !== 'object' || data.protocol !== SCAN_PROTOCOL || typeof data.type !== 'string') {
    return null;
  }

  return (from === 'scanner' ? FROM_SCANNER : FROM_SITE).has(data.type) ? data : null;
}

/**
 * What the scan page tells the person about the site that opened it, from the origin the browser
 * stamped on the handshake: its host ("shop.example", "localhost:8000"), or null for a page with no
 * origin to name (one opened from a file, a sandboxed frame).
 */
export function siteName(origin) {
  if (typeof origin !== 'string' || origin === 'null') {
    return null;
  }

  try {
    const url = new URL(origin);

    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * The status the site hears for the scan page's state: scan_session.js's `scanning.status` and
 * whether the phone's camera is showing. 'connected' without a stream is still 'connecting', as the
 * scan page itself words it.
 */
export function siteStatus(status, streaming) {
  if (status === 'error') {
    return 'error';
  }

  if (streaming) {
    return 'streaming';
  }

  return status === 'connected' ? 'connecting' : SITE_STATUSES.includes(status) ? status : 'waiting';
}
