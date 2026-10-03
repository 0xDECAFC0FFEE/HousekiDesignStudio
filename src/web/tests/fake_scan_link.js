/*
 * fake_scan_link.js -- a TEST DOUBLE for src/web/src/lib/scan_link.js's createScanSession (T-0313),
 * the phone link Tools > Rough scan (scan_mode.js, T-0314) holds. Used only by
 * tests/scan_mode_test.js, which hands it to the mode with `setScanBackend`; nothing in src/
 * imports it. The real module is exercised end to end, with a real phone page, a local relay and a
 * fake camera, by tests/harness/test_scan_mode.py.
 *
 * Why a double here at all: the real session joins a Trystero room over Nostr relays as soon as it
 * is made, and these tests run under `deno test` with no browser and no network. What the mode
 * depends on is only the session's interface, which the double keeps exactly:
 *
 *   createScanSession({ scannerBaseUrl, relayUrls } = {})
 *     -> { url, onStatus(cb), onStream(cb), onRejected(cb), close() }
 *   onStatus: cb(status, detail), status 'waiting' | 'connecting' | 'connected' | 'disconnected' |
 *             'error'; the latest value is replayed to a callback added late; returns an
 *             unsubscribe. onStream: cb(stream, peerId), replayed the same way.
 *   close():  no callback fires after it.
 *
 * The link is made by the real scan_link_hash.js (fresh random room id and password, the relays in
 * `s=`), with the real default page: `<origin>/scanner` over http(s), the public page otherwise.
 *
 * What it adds for the tests, on each session: `emitStatus(status, detail)` and
 * `emitStream(stream)` play the phone's side, `closed` says whether close() was called, and
 * `options` is what the session was made with. `fakeScanLink()` returns a factory that keeps
 * every session it made in `sessions`.
 */

import { defaultScannerBaseUrl, newScanSecrets, scanLinkUrl } from '../src/lib/scan_link_hash.js';

export { defaultScannerBaseUrl };

/** A listener list that replays its latest value to a late listener, as scan_link.js's does. */
function channel(initial) {
  const listeners = new Set();
  let latest = initial;

  return {
    add(listener) {
      listeners.add(listener);

      if (latest) {
        listener(...latest);
      }

      return () => listeners.delete(listener);
    },
    emit(...args) {
      latest = args;
      [...listeners].forEach(listener => listener(...args));
    },
    clear() {
      listeners.clear();
    },
  };
}

/** One fake session, as createScanSession would return. */
export function createFakeScanSession(options = {}) {
  const { scannerBaseUrl, relayUrls = [], location = globalThis.location } = options;
  const status = channel(['waiting']);
  const streams = channel(null);
  const rejected = channel(null);
  const session = {
    url: scanLinkUrl(scannerBaseUrl ?? defaultScannerBaseUrl(location), { ...newScanSecrets(), relayUrls }),
    options,
    closed: false,
    onStatus: listener => status.add(listener),
    onStream: listener => streams.add(listener),
    onRejected: listener => rejected.add(listener),
    close() {
      session.closed = true;
      status.clear();
      streams.clear();
      rejected.clear();
    },
    // The phone's side, for the tests.
    emitStatus(next, detail) {
      status.emit(next, detail);
    },
    emitStream(stream) {
      streams.emit(stream, 'phone-peer');
    },
  };

  return session;
}

/** A factory that keeps every session it makes, newest last. */
export function fakeScanLink() {
  const sessions = [];
  const factory = options => {
    const session = createFakeScanSession(options);

    sessions.push(session);
    return session;
  };

  factory.sessions = sessions;
  return factory;
}
