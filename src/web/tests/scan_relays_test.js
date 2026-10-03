/*
 * scan_relays_test.js -- which Nostr relays a phone-scanner session signals through (T-0316).
 *
 * Until T-0316 a session with no relays named left the choice to Trystero, which picked a fixed 5
 * of its 28 public relays for our app id; two of those five refused Trystero's own events when
 * measured. Both ends now use one pinned list, SCAN_RELAY_URLS (src/lib/scan_relays.js), unless
 * the link names relays (the tests' local relay). These tests pin that choice down offline: the
 * config handed to Trystero's joinRoom, for both the computer's and the phone's side, since both
 * build it with the same roomConfig. Whether the pinned relays WORK is a network question,
 * answered by tests/harness/nostr_relay_probe.js and the opt-in
 * tests/harness/test_scan_public_relays.py.
 *
 * Importing scan_link.js (and so Trystero) is safe here: nothing connects until a room is joined.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 */

import { roomConfig, SCAN_APP_ID, SCAN_RELAY_URLS } from '../src/lib/scan_link.js';
import { SCAN_RELAY_URLS as FROM_MODULE } from '../src/lib/scan_relays.js';

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

Deno.test('the pinned list is several distinct secure websocket relays', () => {
  // Setup: none; the list as shipped.
  // Test: read SCAN_RELAY_URLS, as scan_link.js re-exports it and as scan_relays.js defines it.
  // Verifies: they are the same list; it holds at least four relays (redundancy: any one working
  // on both ends is enough, and public relays come and go); every entry is a wss:// URL (a page
  // served over https may not open ws://, and the phone page is); no relay is listed twice; and
  // the list is frozen, so no code can change it for one end and not the other at run time.
  assertEquals(SCAN_RELAY_URLS, FROM_MODULE, 'scan_link.js re-exports the same list');
  assert(SCAN_RELAY_URLS.length >= 4, `only ${SCAN_RELAY_URLS.length} relays pinned`);

  for (const url of SCAN_RELAY_URLS) {
    assertEquals(new URL(url).protocol, 'wss:', `${url} is not wss://`);
  }

  assertEquals(new Set(SCAN_RELAY_URLS).size, SCAN_RELAY_URLS.length, 'a relay is listed twice');
  assert(Object.isFrozen(SCAN_RELAY_URLS), 'the list can be changed at run time');
});

Deno.test('a session with no relays named uses the pinned list, never Trystero\'s own pick', () => {
  // Setup: a password, and no relays (what the studio passes in use, and what the phone reads
  // from a link with no s=), given both as an empty list and as undefined.
  // Test: build the Trystero config with roomConfig.
  // Verifies: the config names the pinned relays explicitly in relayConfig.urls. Trystero only
  // falls back to its own app-id-seeded pick of its defaults when relayConfig.urls is missing, so
  // an explicit list here is what keeps a session off the relays that refuse its events. Also
  // that the app id and the password reach Trystero unchanged (the password's enforcement depends
  // on it), and that the config holds a copy, not the frozen list itself.
  for (const none of [[], undefined]) {
    const config = roomConfig('the-password', none);

    assertEquals(config.appId, SCAN_APP_ID, 'app id');
    assertEquals(config.password, 'the-password', 'password');
    assertEquals(config.relayConfig.urls, [...SCAN_RELAY_URLS], 'relays');
    assert(config.relayConfig.urls !== SCAN_RELAY_URLS, 'the config shares the frozen list');
  }
});

Deno.test('relays named in the link replace the pinned list on both ends', () => {
  // Setup: a link naming one local relay, as the browser tests' links do (s=ws://127.0.0.1:...).
  // Test: build the config with that relay list.
  // Verifies: only the named relay is used, none of the pinned public ones, so the offline tests
  // stay offline; the password still reaches Trystero.
  const config = roomConfig('the-password', ['ws://127.0.0.1:4321']);

  assertEquals(config.relayConfig.urls, ['ws://127.0.0.1:4321'], 'relays');
  assertEquals(config.password, 'the-password', 'password');
});
