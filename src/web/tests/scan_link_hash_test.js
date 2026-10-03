/*
 * scan_link_hash_test.js -- tests for src/lib/scan_link_hash.js, the phone scanner's pairing link
 * (T-0313): the hash in the QR code that carries the session's room id and password to the phone.
 *
 * The module is pure (no window, location or network), so it is tested here with no browser.
 * Whether the password is actually ENFORCED is a different question, answered in headless Chrome
 * against a local relay by tests/harness/test_scan_link.py.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 */

import {
  decodeScanHash,
  defaultScannerBaseUrl,
  encodeScanHash,
  newScanSecrets,
  PUBLIC_SCANNER_URL,
  SCAN_LINK_VERSION,
  ScanLinkError,
  scanLinkUrl,
  SECRET_BYTES,
} from '../src/lib/scan_link_hash.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

function assertEquals(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${message || 'not equal'}: got ${a}, expected ${e}`);
}

/** Runs `run`, which must throw a ScanLinkError with `code`; returns the error. */
function assertRejects(run, code, message) {
  try {
    run();
  } catch (error) {
    assert(error instanceof ScanLinkError, `${message}: threw ${error} rather than a ScanLinkError`);
    assertEquals(error.code, code, `${message}: error code`);
    return error;
  }

  throw new Error(`${message}: did not throw`);
}

/** A valid link's fields, from fixed bytes so the test is reproducible. */
function sampleLink() {
  let fill = 0;
  const counting = bytes => bytes.map(() => fill++);
  return newScanSecrets(counting);
}

Deno.test('a link round-trips through the hash exactly, with and without relays', () => {
  // Setup: a room id and password from newScanSecrets (fed counting bytes, so they are fixed and
  // different from each other), once with no relays and once with two.
  // Test: encode each to a hash and decode it straight back.
  // Verifies: the version, room id, password and relay list all survive unchanged, the relays in
  // their order; the hash starts with the version, readable without decoding anything; and a hash
  // passed with or without its leading '#' (as location.hash gives it, or as split from a URL)
  // reads the same.
  const link = sampleLink();

  for (const relayUrls of [[], ['ws://127.0.0.1:7000', 'wss://relay.example/v2?x=1&y=2']]) {
    const hash = encodeScanHash({ ...link, relayUrls });
    assert(hash.startsWith(`#v=${SCAN_LINK_VERSION}&`), `hash starts with its version: ${hash}`);

    const expected = { version: SCAN_LINK_VERSION, roomId: link.roomId, password: link.password, relayUrls };
    assertEquals(decodeScanHash(hash), expected, 'decoded with #');
    assertEquals(decodeScanHash(hash.slice(1)), expected, 'decoded without #');
  }
});

Deno.test('the QR text is the base URL plus the hash, and the hash parts survive a real URL parse', () => {
  // Setup: a link and the public base URL. Test: build the QR text with scanLinkUrl, parse it
  // with the URL class as a browser would on the phone, and decode its hash.
  // Verifies: the text is exactly base + '#' + hash, and nothing in the hash is mangled by URL
  // parsing (base64url uses only - and _, which URLs leave alone).
  const link = sampleLink();
  const text = scanLinkUrl(PUBLIC_SCANNER_URL, link);

  assertEquals(text, PUBLIC_SCANNER_URL + encodeScanHash(link), 'QR text');

  const parsed = new URL(text);
  assertEquals(parsed.pathname, '/scanner', 'path');
  assertEquals(decodeScanHash(parsed.hash).password, link.password, 'password after a URL parse');
});

Deno.test('fresh secrets are 16 random bytes each, from getRandomValues, and differ every time', () => {
  // Setup: newScanSecrets with the real crypto.getRandomValues, twice, and once with a spy.
  // Test: decode-check the lengths, compare the two sessions, and count what the spy was asked for.
  // Verifies: each value is 22 base64url characters (16 bytes, 128 bits), that the room id and
  // password are separate draws, that two sessions share neither, and that every byte comes from
  // getRandomValues (two calls of SECRET_BYTES bytes each).
  const first = newScanSecrets();
  const second = newScanSecrets();

  for (const value of [first.roomId, first.password, second.roomId, second.password]) {
    assert(/^[A-Za-z0-9_-]{22}$/.test(value), `22 base64url characters: ${value}`);
  }

  assert(first.roomId !== first.password, 'room id and password are separate draws');
  assert(first.roomId !== second.roomId, 'room ids differ between sessions');
  assert(first.password !== second.password, 'passwords differ between sessions');

  const requested = [];
  newScanSecrets(bytes => {
    requested.push(bytes.length);
    return crypto.getRandomValues(bytes);
  });
  assertEquals(requested, [SECRET_BYTES, SECRET_BYTES], 'bytes asked of getRandomValues');
});

Deno.test('a malformed hash is refused with a ScanLinkError, never half-read', () => {
  // Setup: a valid link's room id and password, then a series of hashes each broken one way.
  // Test: decode each.
  // Verifies: every one throws a ScanLinkError with code 'malformed' rather than returning a link
  // the phone would try to join: empty, no version, a version that is not a whole number, no
  // password (the phone page must call that link invalid, not join without one), no room id,
  // either one repeated, the wrong length, characters outside base64url, and a relay that is not a
  // websocket URL. Also that encodeScanHash refuses to write any of these in the first place.
  const { roomId, password } = sampleLink();
  const short = roomId.slice(0, 21);
  const cases = {
    'empty': '',
    'just a #': '#',
    'no version': `#r=${roomId}&p=${password}`,
    'version not a number': `#v=one&r=${roomId}&p=${password}`,
    'version not whole': `#v=1.5&r=${roomId}&p=${password}`,
    'two versions': `#v=1&v=1&r=${roomId}&p=${password}`,
    'no password': `#v=1&r=${roomId}`,
    'empty password': `#v=1&r=${roomId}&p=`,
    'no room id': `#v=1&p=${password}`,
    'two passwords': `#v=1&r=${roomId}&p=${password}&p=${password}`,
    'short room id': `#v=1&r=${short}&p=${password}`,
    'long password': `#v=1&r=${roomId}&p=${password}AA`,
    'not base64url': `#v=1&r=${roomId}&p=${password.slice(0, 21)}+`,
    'http relay': `#v=1&r=${roomId}&p=${password}&s=${encodeURIComponent('https://relay.example')}`,
    'relay not a URL': `#v=1&r=${roomId}&p=${password}&s=relay`,
    'garbage': '#%%%&&&==',
  };

  for (const [name, hash] of Object.entries(cases)) {
    assertRejects(() => decodeScanHash(hash), 'malformed', name);
  }

  assertRejects(() => encodeScanHash({ roomId, password: undefined }), 'malformed', 'encode without a password');
  assertRejects(() => encodeScanHash({ roomId: short, password }), 'malformed', 'encode a short room id');
  assertRejects(() => encodeScanHash({ roomId, password, relayUrls: ['https://x'] }), 'malformed', 'encode an http relay');
});

Deno.test('an unknown version is refused as unsupported, whatever else the link holds', () => {
  // Setup: links identical to a valid one except for their version: 0, 2 and a large number.
  // Test: decode each.
  // Verifies: each throws a ScanLinkError with code 'unsupported-version' (not 'malformed'), so
  // the page can tell a link from a newer or older build from a broken one, and that its message
  // names both versions. A reader must never guess at fields of a format it does not know.
  const { roomId, password } = sampleLink();

  for (const version of [0, 2, 99]) {
    const error = assertRejects(
      () => decodeScanHash(`#v=${version}&r=${roomId}&p=${password}`),
      'unsupported-version',
      `version ${version}`,
    );
    assert(error.message.includes(String(version)) && error.message.includes(String(SCAN_LINK_VERSION)),
      `message names both versions: ${error.message}`);
  }
});

Deno.test('fields a reader does not know are ignored, so optional ones can be added later', () => {
  // Setup: a valid hash with two extra parameters, as a later build might add for ChArUco board
  // settings. Test: decode it. Verifies: the link reads exactly as without them.
  const link = sampleLink();
  const hash = encodeScanHash(link) + '&board=5x7&marker=0.02';

  assertEquals(decodeScanHash(hash), { version: SCAN_LINK_VERSION, ...link, relayUrls: [] }, 'decoded');
});

Deno.test('the default phone page is the host page\'s own origin, or the public site from file://', () => {
  // Setup: three location-like objects for the page hosting a session: the app served locally
  // over http, the app on the public site over https, and the app opened from file:// (whose
  // origin Chrome gives as 'file://', measured on the built app, and the spec as 'null'; both
  // are tried). Plus a missing location, as in a worker or a test.
  // Test: ask each for the default base URL.
  // Verifies: over http(s) it is that origin + '/scanner', whatever path the app itself is at,
  // so a local server and houseki.app both work with no setting; from file://, which no phone
  // can reach, and with no location at all, it is https://houseki.app/scanner.
  assertEquals(
    defaultScannerBaseUrl({ protocol: 'http:', origin: 'http://localhost:8000', href: 'http://localhost:8000/studio.html' }),
    'http://localhost:8000/scanner', 'served locally over http');
  assertEquals(
    defaultScannerBaseUrl({ protocol: 'https:', origin: 'https://houseki.app', href: 'https://houseki.app/studio.html' }),
    'https://houseki.app/scanner', 'served over https');
  for (const origin of ['file://', 'null']) {
    assertEquals(
      defaultScannerBaseUrl({ protocol: 'file:', origin, href: 'file:///Users/someone/studio.html' }),
      PUBLIC_SCANNER_URL, `opened from file:// (origin ${origin})`);
  }
  assertEquals(defaultScannerBaseUrl(undefined), PUBLIC_SCANNER_URL, 'no location');
  assertEquals(PUBLIC_SCANNER_URL, 'https://houseki.app/scanner', 'the public phone page');
});
