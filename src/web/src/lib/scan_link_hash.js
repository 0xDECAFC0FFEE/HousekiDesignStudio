// The phone scanner's pairing link (T-0313, 2026-10-02): what the computer's QR code says, and
// how the phone page at /scanner reads it back.
//
// The user's request: a rough scanning mode shows "a qr code [that] embeds a url with a hash in
// it. the hash encodes everything required for a webrtc session to be established between the
// phone and the computer", and "make sure to embed a randomly generated password in the qr code
// hash that the computer requires the phone present in order to connect".
//
// The link is  <scanner page>#v=1&r=<room id>&p=<password>[&s=<signaling relay>...]
//
//   v  the link format's version. A reader refuses a version it does not know, rather than
//      guessing at fields it cannot read. Adding an OPTIONAL field that an older reader can
//      ignore (ChArUco board settings, capture commands) is not a new version; changing what an
//      existing field means, or adding one a reader must understand to connect safely, is.
//   r  the Trystero room id: 16 random bytes, base64url (22 characters).
//   p  the room password: 16 more random bytes, base64url. Trystero encrypts the session
//      descriptions with a key derived from it, so a peer without it cannot complete the
//      WebRTC handshake (see scan_link.js).
//   s  optional, repeatable: the Nostr relay URLs both ends signal through. Absent, both ends
//      use the pinned public relays (scan_relays.js, T-0316). Present only when the computer was told to use
//      other relays, which today means the integration tests' local relay.
//
// Both secrets come from crypto.getRandomValues, fresh for every session: 128 bits each, so
// neither can be guessed. The room id is not secret in the same way (it is hashed into the relay
// topic both ends subscribe to, so a relay operator sees that hash), which is exactly why the
// password is a separate value that never leaves the link.
//
// This module is PURE: no window, document, location or network, so
// tests/scan_link_hash_test.js runs it under `deno test` with no browser. scan_link.js owns the
// Trystero side.

/** The link format this build writes, and the only one it reads. */
export const SCAN_LINK_VERSION = 1;

/** Where the phone page lives when the app cannot say (opened from file://). */
export const PUBLIC_SCANNER_URL = 'https://houseki.app/scanner';

/** Bytes of randomness in the room id and in the password: 128 bits each. */
export const SECRET_BYTES = 16;

/** A malformed or unsupported link. `code` is 'malformed' or 'unsupported-version'. */
export class ScanLinkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScanLinkError';
    this.code = code;
  }
}

/**
 * A fresh room id and password, each SECRET_BYTES random bytes as base64url. `getRandomValues`
 * is a parameter only so a test can see what it is called with; callers leave it alone.
 */
export function newScanSecrets(getRandomValues = bytes => crypto.getRandomValues(bytes)) {
  const token = () => toBase64Url(getRandomValues(new Uint8Array(SECRET_BYTES)));

  return { roomId: token(), password: token() };
}

/**
 * The hash (with its leading '#') for `{ roomId, password, relayUrls }`. Checks what it writes
 * as strictly as decodeScanHash checks what it reads, so a link this writes always reads back.
 */
export function encodeScanHash({ roomId, password, relayUrls = [] }) {
  checkSecret(roomId, 'room id');
  checkSecret(password, 'password');
  relayUrls.forEach(url => checkRelayUrl(url));

  const params = new URLSearchParams();
  params.set('v', String(SCAN_LINK_VERSION));
  params.set('r', roomId);
  params.set('p', password);

  for (const url of relayUrls) {
    params.append('s', url);
  }

  return `#${params}`;
}

/**
 * `{ version, roomId, password, relayUrls }` from a hash (with or without its '#', so
 * `location.hash` can be passed straight in). Throws a ScanLinkError on anything else: no
 * version, a version that is not a whole number, a version this build does not know, a missing,
 * repeated or wrong-length room id or password, or a relay that is not a ws:// or wss:// URL.
 * Parameters it does not know are ignored (see the header on versions).
 */
export function decodeScanHash(hash) {
  const text = String(hash ?? '').replace(/^#/, '');

  if (!text) {
    throw new ScanLinkError('malformed', 'The link has no session details in it.');
  }

  const params = new URLSearchParams(text);
  const versions = params.getAll('v');

  if (versions.length !== 1 || !/^[0-9]+$/.test(versions[0])) {
    throw new ScanLinkError('malformed', 'The link has no valid version.');
  }

  const version = Number(versions[0]);

  if (version !== SCAN_LINK_VERSION) {
    throw new ScanLinkError(
      'unsupported-version',
      `The link is version ${version}; this page reads version ${SCAN_LINK_VERSION}.`,
    );
  }

  const one = (name, description) => {
    const values = params.getAll(name);

    if (values.length !== 1) {
      throw new ScanLinkError('malformed', `The link has ${values.length ? 'more than one' : 'no'} ${description}.`);
    }

    checkSecret(values[0], description, 'malformed');
    return values[0];
  };

  const roomId = one('r', 'room id');
  const password = one('p', 'password');
  const relayUrls = params.getAll('s');

  for (const url of relayUrls) {
    checkRelayUrl(url, 'malformed');
  }

  return { version, roomId, password, relayUrls };
}

/** `base` (the phone page's URL, with no hash) with the session's hash on it: the QR's text. */
export function scanLinkUrl(base, link) {
  return String(base).replace(/#.*$/, '') + encodeScanHash(link);
}

/**
 * Where the phone page is, seen from the page hosting the session (`location`, or anything with
 * `protocol` and `origin`). Served over http(s), it is that origin's /scanner, so a local server
 * and houseki.app both work with no setting; from file://, which has no origin a phone could
 * reach, it is the public site's.
 */
export function defaultScannerBaseUrl(location) {
  const protocol = location?.protocol;

  if ((protocol === 'http:' || protocol === 'https:') && location.origin && location.origin !== 'null') {
    return `${location.origin}/scanner`;
  }

  return PUBLIC_SCANNER_URL;
}

function checkSecret(value, description, code = 'malformed') {
  let bytes = null;

  if (typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)) {
    try {
      bytes = fromBase64Url(value);
    } catch {
      bytes = null;
    }
  }

  if (!bytes || bytes.length !== SECRET_BYTES) {
    throw new ScanLinkError(code, `The link's ${description} is not ${SECRET_BYTES} bytes of base64url.`);
  }
}

function checkRelayUrl(value, code = 'malformed') {
  let url = null;

  try {
    url = new URL(value);
  } catch {
    url = null;
  }

  if (!url || (url.protocol !== 'ws:' && url.protocol !== 'wss:')) {
    throw new ScanLinkError(code, `The link's relay ${JSON.stringify(String(value))} is not a ws:// or wss:// URL.`);
  }
}

function toBase64Url(bytes) {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));

  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
