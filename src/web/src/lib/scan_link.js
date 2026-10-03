// The phone scanner's connection (T-0313, 2026-10-02): the computer hosts a pairing session, the
// phone joins it from the QR code's link, and the phone's rear camera streams to the computer
// over WebRTC.
//
// Signaling is Trystero (MIT) over its default Nostr strategy, the user's choice: WebRTC needs
// the phone's answer to reach the computer somehow, and Trystero passes the offer and answer
// through public Nostr relays, so there is no server of our own and no sign-in. Which relays is
// pinned in scan_relays.js rather than left to Trystero (T-0316; that file says why). Media then flows
// directly between the two devices. There is no TURN server: phone and computer are assumed to
// be on the same network, and Trystero's default STUN servers are enough there.
//
// The password. Every session gets a fresh random room id and a fresh random password
// (scan_link_hash.js, 128 bits each), and the room is joined with Trystero's `password` option.
// Trystero then encrypts every offer, answer and ICE candidate with AES-GCM under a key derived
// from the password, the app id and the room id, and runs a challenge/response over the data
// channel before it reports a peer. A peer with any other password, or none, reaches the same
// relay topic (the topic is derived from the app id and room id only) but cannot decrypt the
// other side's session description, so the WebRTC connection is never made and neither end
// reports it. tests/harness/test_scan_link.py proves that against a local relay.
//
// Network use. Trystero opens its relay websockets on the first join, and leaving the last room
// does NOT close them: measured, they stay open (and reconnect if dropped) for the life of the
// page. So this module closes them itself when its last session closes, with Trystero's
// reconnection paused, and resumes it before the next session joins (see acquireRelays). The
// desktop therefore talks to the relays only while a session is open.

import {
  getRelaySockets,
  joinRoom,
  pauseRelayReconnection,
  resumeRelayReconnection,
} from 'trystero';
import { decodeScanHash, defaultScannerBaseUrl, newScanSecrets, scanLinkUrl } from './scan_link_hash.js';
import { SCAN_RELAY_URLS } from './scan_relays.js';

export { decodeScanHash, ScanLinkError } from './scan_link_hash.js';
export { SCAN_RELAY_URLS } from './scan_relays.js';

/**
 * Trystero's app id for the scanner. Both ends must agree on it: it is hashed into the relay
 * topics and it salts the password's key, so changing it splits phones and computers running
 * different builds.
 */
export const SCAN_APP_ID = 'houseki-scanner';

/** How long the computer waits for any relay to accept a connection before reporting 'error'. */
const RELAY_GRACE_MS = 15000;

/** How long the phone waits for the computer before saying the link may have expired. */
const PHONE_CONNECT_TIMEOUT_MS = 30000;

/** How long a session waits for relays closed by an earlier session to reconnect. */
const RELAY_REOPEN_MS = 3000;

/** Trystero's join error text for a peer whose password differs (it names the password). */
const isPasswordError = message => /password/i.test(String(message));

/**
 * The Trystero room config for a session. `relayUrls` empty means the pinned public relays,
 * SCAN_RELAY_URLS (scan_relays.js), never Trystero's own pick: two of the five relays Trystero
 * chose for this app id refused its events when measured (T-0316).
 */
export function roomConfig(password, relayUrls) {
  const urls = relayUrls && relayUrls.length ? relayUrls : SCAN_RELAY_URLS;

  return { appId: SCAN_APP_ID, password, relayConfig: { urls: [...urls] } };
}

// --- the relay sockets' lifetime -----------------------------------------------------------

let liveSessions = 0;
let relaysClosed = false;
let relaysReady = Promise.resolve();

const relaySockets = () => Object.values(getRelaySockets()).filter(Boolean);

/**
 * Counts a session in, and resolves once it may join a room. Normally at once; but if an earlier
 * session closed the relay sockets, it resumes Trystero's reconnection and waits (up to
 * RELAY_REOPEN_MS) for them to reopen, and so does every session started meanwhile. Joining
 * before they are open would be worse than late: Trystero reuses the existing relay clients, and
 * its first announcement on a socket that is not open yet backs that relay off for a minute.
 */
function acquireRelays() {
  liveSessions += 1;

  if (relaysClosed) {
    relaysClosed = false;
    resumeRelayReconnection();
    relaysReady = relaysReopened();
  }

  return relaysReady;
}

/** Resolves when every relay socket is open again, or after RELAY_REOPEN_MS. */
function relaysReopened() {
  return new Promise(resolve => {
    const started = Date.now();
    const poll = () => {
      const sockets = relaySockets();

      if (sockets.every(socket => socket.readyState === 1) || Date.now() - started > RELAY_REOPEN_MS) {
        resolve();
      } else {
        setTimeout(poll, 50);
      }
    };

    poll();
  });
}

/** Counts a session out; the last one out closes the relay sockets and keeps them closed. */
function releaseRelays() {
  liveSessions -= 1;

  if (liveSessions > 0) {
    return;
  }

  // Paused first: Trystero reconnects a socket that closes unless reconnection is paused, and
  // then waits for resumeRelayReconnection (acquireRelays) instead.
  pauseRelayReconnection();
  relaysClosed = true;

  for (const socket of relaySockets()) {
    socket.close();
  }
}

/**
 * Joins `roomId` once the relays are ready, then calls `setUp(room)`. Returns `leave()`, which
 * may be called before the join has happened (the join is then skipped).
 */
function openRoom(config, roomId, callbacks, setUp) {
  let room = null;
  let left = false;

  acquireRelays().then(() => {
    if (left) {
      return;
    }

    room = joinRoom(config, roomId, callbacks);
    setUp(room);
  });

  return () => {
    if (left) {
      return;
    }

    left = true;

    if (room) {
      room.leave();
    }

    releaseRelays();
  };
}

/**
 * A list of listeners for one kind of event, which replays the latest value to a listener added
 * after it was emitted (so a status registered late still learns the current one).
 */
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

      for (const listener of [...listeners]) {
        try {
          listener(...args);
        } catch (cause) {
          console.error(cause);
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

/**
 * The computer's side: starts hosting a fresh room with a fresh random password.
 *
 * `scannerBaseUrl` is the phone page's address; by default the page's own origin + '/scanner'
 * when it is served over http(s), else https://houseki.app/scanner (scan_link_hash.js's
 * defaultScannerBaseUrl). `relayUrls` replaces the pinned public relays (SCAN_RELAY_URLS); the link carries
 * it, so the phone uses the same ones. Only tests set it.
 *
 * Returns:
 *   url           the link the QR code shows: scannerBaseUrl + '#' + the hash
 *   onStatus(cb)  cb(status, detail?), with status one of
 *                   'waiting'       no phone yet
 *                   'connecting'    a phone with the password has connected; its camera stream
 *                                   has not arrived yet
 *                   'connected'     the phone's camera is streaming (onStream has fired)
 *                   'disconnected'  the phone that was streaming left (it may come back, e.g.
 *                                   after a reload; the room stays open until close())
 *                   'error'         detail 'signaling-unreachable' (no relay answered) or the
 *                                   reason a connection with a phone failed
 *                 The current status is replayed to a newly added cb. Returns an unsubscribe.
 *   onStream(cb)  cb(MediaStream, peerId) when a phone's camera stream arrives (replayed too).
 *   onRejected(cb)  cb({ error, peerId }) when a peer failed to connect because its password
 *                 differs. Only one side of a failed handshake sees the failure, so this fires
 *                 for some such attempts and not others; it is for diagnostics and tests, not
 *                 security.
 *   close()       leaves the room and stops everything, and once no session is left closes the
 *                 relay connections; no callback fires after it.
 */
export function createScanSession({ scannerBaseUrl, relayUrls = [], location = globalThis.location } = {}) {
  const { roomId, password } = newScanSecrets();
  const base = scannerBaseUrl ?? defaultScannerBaseUrl(location);
  const url = scanLinkUrl(base, { roomId, password, relayUrls });

  const status = channel(['waiting']);
  const streams = channel(null);
  const rejected = channel(null);
  const peers = new Set();
  let current = 'waiting';
  let streamingPeer = null;
  let closed = false;

  const setStatus = (next, detail) => {
    if (closed) {
      return;
    }

    current = next;
    status.emit(next, detail);
  };

  const onJoinError = ({ error, peerId }) => {
    if (closed) {
      return;
    }

    if (isPasswordError(error)) {
      rejected.emit({ error, peerId });
    } else if (current !== 'connected') {
      setStatus('error', error);
    }
  };

  const leave = openRoom(roomConfig(password, relayUrls), roomId, { onJoinError }, room => {
    room.onPeerJoin = peerId => {
      peers.add(peerId);

      if (current !== 'connected') {
        setStatus('connecting', peerId);
      }
    };

    room.onPeerStream = (stream, peerId) => {
      if (closed) {
        return;
      }

      streamingPeer = peerId;
      streams.emit(stream, peerId);
      setStatus('connected', peerId);
    };

    room.onPeerLeave = peerId => {
      peers.delete(peerId);

      if (peerId === streamingPeer) {
        streamingPeer = null;
        setStatus('disconnected', peerId);
      } else if (current === 'connecting' && peers.size === 0) {
        setStatus('waiting');
      }
    };
  });

  // Trystero reports nothing when no relay can be reached (offline, or every relay blocked), so
  // the session would sit at 'waiting' for ever. Watch the relay sockets instead.
  const started = Date.now();
  const relayWatch = setInterval(() => {
    const open = relaySockets().some(socket => socket.readyState === 1);

    if (!open && current === 'waiting' && Date.now() - started > RELAY_GRACE_MS) {
      setStatus('error', 'signaling-unreachable');
    } else if (open && current === 'error') {
      setStatus('waiting');
    }
  }, 1000);

  return {
    url,
    onStatus: listener => status.add(listener),
    onStream: listener => streams.add(listener),
    onRejected: listener => rejected.add(listener),
    close() {
      if (closed) {
        return;
      }

      closed = true;
      clearInterval(relayWatch);
      status.clear();
      streams.clear();
      rejected.clear();
      leave();
    },
  };
}

/**
 * The phone's side: joins the session a link describes and sends `stream` (the camera) to the
 * computer once it connects.
 *
 * `link` is decodeScanHash's result (or `{ roomId, password, relayUrls }`);
 * joinScanSessionFromHash below decodes for you. A link without a password is refused here,
 * before anything is sent.
 *
 * Returns:
 *   onStatus(cb)  cb(status, detail?), with status one of
 *                   'connecting'    looking for the computer
 *                   'connected'     connected; the camera is being sent
 *                   'disconnected'  the computer left (its scan mode was closed)
 *                   'error'         detail 'wrong-password' (the computer refused us: the link
 *                                   is wrong or from an older session), 'timeout' (no computer
 *                                   answered within `connectTimeoutMs`; it keeps trying), or the
 *                                   reason the connection failed
 *                 Replayed to a newly added cb; returns an unsubscribe.
 *   close()       leaves the room. The stream's tracks are the caller's to stop.
 */
export function joinScanSession(link, stream, { connectTimeoutMs = PHONE_CONNECT_TIMEOUT_MS } = {}) {
  const { roomId, password, relayUrls = [] } = link ?? {};

  if (!roomId || !password) {
    throw new Error('joinScanSession needs a room id and a password.');
  }

  const status = channel(['connecting']);
  let current = 'connecting';
  let host = null;
  let everConnected = false;
  let closed = false;

  const setStatus = (next, detail) => {
    if (closed) {
      return;
    }

    current = next;
    status.emit(next, detail);
  };

  const onJoinError = ({ error }) => {
    if (closed || current === 'connected') {
      return;
    }

    setStatus('error', isPasswordError(error) ? 'wrong-password' : error);
  };

  const leave = openRoom(roomConfig(password, relayUrls), roomId, { onJoinError }, room => {
    room.onPeerJoin = peerId => {
      host = peerId;
      everConnected = true;
      room.addStream(stream, { target: peerId });
      setStatus('connected', peerId);
    };

    room.onPeerLeave = peerId => {
      if (peerId === host) {
        host = null;
        setStatus('disconnected', peerId);
      }
    };
  });

  const timeout = setTimeout(() => {
    if (!everConnected && current === 'connecting') {
      setStatus('error', 'timeout');
    }
  }, connectTimeoutMs);

  return {
    onStatus: listener => status.add(listener),
    close() {
      if (closed) {
        return;
      }

      closed = true;
      clearTimeout(timeout);
      status.clear();
      leave();
    },
  };
}

/** joinScanSession for a link's hash (`location.hash`). Throws a ScanLinkError on a bad link. */
export function joinScanSessionFromHash(hash, stream, options) {
  return joinScanSession(decodeScanHash(hash), stream, options);
}
