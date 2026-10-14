// What the phone scanner's connection is doing, step by step (T-0342): the console log and the
// connection picture on both ends. The user, 2026-10-13: "can you output what the phone or the
// computer are doing in the console ... instead of just showing a status bar at the bottom, i want
// a visualization of what its doing", with a step line under it ("connecting to servers... waiting
// for phone... ... connected").
//
// Trystero reports a peer only once everything has worked, so the steps are watched from outside
// it, without changing it:
//
//   - its relay WebSockets (getRelaySockets): each socket's open and close, what this page sends
//     (REQ: a subscription; EVENT: an announcement or a signal) and what the relay answers (EOSE:
//     the subscription is live; EVENT: another device's announcement or signal; OK false, CLOSED,
//     NOTICE: a refusal and its reason). A relay socket is replaced when Trystero reconnects, so
//     the sockets are looked at again every SOCKET_POLL_MS. Announcements go to the room topic,
//     SHA-1 of "Trystero@<app id>@<room id>"; signals to a device's own topic, SHA-1 of that plus
//     "@<its peer id>", each byte in base 36 (Trystero's strategy.mjs and crypto.mjs), so both are recognised here. Their fields (peerId,
//     offer, answer, candidate) are plain; the descriptions inside are encrypted with the password.
//   - its WebRTC connections, through Trystero's `rtcPolyfill` option: an RTCPeerConnection that
//     reports its states. Trystero makes some connections ahead of time (its offer pool); one
//     counts once a description from the other device has been set on it.
//   - the session's own events (scan_link.js): the other device joined (its password check over
//     the direct connection passed), the camera arrived, the other device left, a failure.
//
// The steps (STEPS), in order; each is shown once its condition holds and every earlier one has:
//
//   servers      connecting to the relays and subscribing
//   waiting      enough relays are subscribed (see serversReady) and nothing from the other device
//   introducing  the other device was heard: announcements, then the encrypted offer, answer and
//                address candidates through the relays
//   direct       a WebRTC connection has the other device's description: the direct connection
//                is being tried (ICE)
//   verifying    the direct connection is up; Trystero checks the password over it
//   connected    the other device joined (the computer: and its camera arrives)
//
// A direct connection that fails drops back to 'introducing' (Trystero tries again at the next
// announcement); the other device leaving drops back to 'waiting'.

import { trysteroTopic } from './scan_trace_hash.js';

/** The connection steps, in order. */
export const STEPS = Object.freeze(['servers', 'waiting', 'introducing', 'direct', 'verifying', 'connected']);

/** How often the relay sockets are looked at for new ones (Trystero replaces them on reconnect). */
export const SOCKET_POLL_MS = 100;

/**
 * A relay still connecting this long after the session started counts as settled for
 * serversReady: a socket that cannot connect can take minutes to fail.
 */
export const RELAY_SETTLE_MS = 10000;

/** Trystero's topic names (its strategy.mjs topicPath and libName). */
export const roomTopicPlaintext = (appId, roomId) => `Trystero@${appId}@${roomId}`;

/**
 * Whether enough relays are ready to wait on (the user's rule): every relay subscribed; or at least
 * half of them plus one subscribed, and every one either subscribed, refused, retried at least
 * once, or still trying after RELAY_SETTLE_MS.
 */
export function serversReady(relays, elapsedMs) {
  const list = [...relays];
  const up = list.filter(r => r.subscribed).length;

  if (list.length === 0) {
    return false;
  }

  if (up === list.length) {
    return true;
  }

  const settled = list.every(r => r.subscribed || r.refused || r.attempts >= 2 || elapsedMs >= RELAY_SETTLE_MS);
  return up >= Math.floor(list.length / 2) + 1 && settled;
}

/**
 * The step a snapshot is at: one of STEPS.
 *
 * @param {object} s  { relays: [{ subscribed, refused, attempts }], elapsedMs, peer: { heard } | null,
 *                      direct: null | { state: 'trying'|'up'|'failed' }, joined: boolean }
 */
export function stepOf(s) {
  if (s.joined) {
    return 'connected';
  }

  if (s.direct?.state === 'up') {
    return 'verifying';
  }

  if (s.direct?.state === 'trying') {
    return 'direct';
  }

  if (s.peer?.heard) {
    return 'introducing';
  }

  return serversReady(s.relays, s.elapsedMs) ? 'waiting' : 'servers';
}

/**
 * The step line under the picture, for `role` ('computer' or 'phone'): { step, text }.
 * `extra` is the snapshot's counts ({ up, total }) and its last failure, if any.
 */
export function stepText(step, role, { up = 0, total = 0, failure = null } = {}) {
  const other = role === 'computer' ? 'phone' : 'computer';
  const servers = total ? ` (${up} of ${total})` : '';

  switch (step) {
    case 'servers':
      return `Connecting to the servers…${servers}`;
    case 'waiting':
      return failure
        ? `The direct connection to your ${other} failed. Trying again…`
        : role === 'computer' ? `Waiting for your phone…${servers}` : `Looking for your computer…${servers}`;
    case 'introducing':
      return failure
        ? `The direct connection to your ${other} failed. Trying again…`
        : `Exchanging connection details with your ${other}…`;
    case 'direct':
      return `Setting up a direct connection to your ${other}…`;
    case 'verifying':
      return 'Checking the password…';
    default:
      return 'Connected';
  }
}

/** A short form of a peer id for the log. */
const shortId = id => (id ? String(id).slice(0, 6) : '?');

/** The type of a signal's content: 'offer', 'answer', 'candidate' or 'nudge' (a bare peer id). */
export function signalType(content) {
  if (content?.offer) {
    return 'offer';
  }

  if (content?.answer) {
    return 'answer';
  }

  if (content?.candidate) {
    return 'candidate';
  }

  return 'nudge';
}

/** The candidate type ('host', 'srflx', 'prflx', 'relay') and protocol of an ICE candidate line. */
export function candidateInfo(line) {
  const text = String(line ?? '');
  const type = /\btyp (\w+)/.exec(text)?.[1] ?? '?';
  const protocol = /candidate:\S+ \d+ (\w+)/i.exec(text)?.[1]?.toLowerCase() ?? '?';
  return { type, protocol };
}

const parse = data => {
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
};

const topicOf = event => (Array.isArray(event?.tags) ? event.tags.find(t => t[0] === 'x')?.[1] ?? null : null);

/**
 * A console logger: `log(level, message, data?)`, each line prefixed "[houseki scan <role> +s]".
 * `sink` is the console (or a test double).
 */
export function createScanLog(role, { sink = globalThis.console, now = () => Date.now() } = {}) {
  const started = now();

  return (level, message, data) => {
    const t = ((now() - started) / 1000).toFixed(2);
    const write = sink?.[level] ?? sink?.log;

    if (!write) {
      return;
    }

    const head = `[houseki scan ${role} +${t}s] ${message}`;

    if (data === undefined) {
      write.call(sink, head);
    } else {
      write.call(sink, head, data);
    }
  };
}

/**
 * Watches one session's connection. Returns:
 *   rtcPolyfill        an RTCPeerConnection class for Trystero's `rtcPolyfill` option (null when
 *                      the environment has none)
 *   noteStatus(s, d)   the session's own status changes (scan_link.js), for the log
 *   noteJoined(id)     the other device joined (Trystero's onPeerJoin)
 *   noteLeft(id)       it left
 *   onChange(cb)       cb(snapshot) whenever the step, the counts or a failure change; replayed
 *                      to a new cb; returns an unsubscribe
 *   snapshot()         { role, step, text, up, total, relays: [{ url, state, subscribed, refused,
 *                      attempts, reason }], peer, direct, joined, failure }
 *   close()            stops watching (sockets are left to Trystero)
 *
 * @param {object} options
 * @param {'computer'|'phone'} options.role
 * @param {string} options.appId
 * @param {string} options.roomId
 * @param {string[]} options.relayUrls   the relays the session uses
 * @param {() => Object<string, WebSocket>} options.getSockets   Trystero's getRelaySockets
 * @param {string} options.selfId        Trystero's selfId (this page's peer id)
 * @param {Function} [options.log]       createScanLog's logger
 * @param {Function} [options.now]
 * @param {Function} [options.setInterval] / [options.clearInterval]
 * @param {Function} [options.RTCPeerConnection]  the class to extend
 * @param {(text: string) => Promise<string>} [options.sha1]
 */
export function createScanTrace({
  role, appId, roomId, relayUrls, getSockets, selfId,
  log = createScanLog(role), now = () => Date.now(),
  setInterval: every = (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: stop = id => globalThis.clearInterval(id),
  RTCPeerConnection: Base = globalThis.RTCPeerConnection,
  sha1 = trysteroTopic,
}) {
  const started = now();
  const relays = new Map(relayUrls.map(url => [url, {
    url, state: 'connecting', subscribed: false, refused: false, attempts: 0, reason: '', subIds: new Set(),
    announcesSent: 0, sockets: new WeakSet(),
  }]));
  const plaintext = roomTopicPlaintext(appId, roomId);
  let roomTopic = null;
  let selfTopic = null;
  const topics = Promise.all([sha1(plaintext), sha1(`${plaintext}@${selfId}`)]).then(([room, self]) => {
    roomTopic = room;
    selfTopic = self;
  });
  // The other device: its peer id once heard, and what went each way.
  let peer = null;
  // The direct connection being tried, if any: { pc, state: 'trying'|'up'|'failed' }.
  let direct = null;
  let joined = false;
  let failure = null;
  let closed = false;
  const listeners = new Set();
  let last = '';

  log('info', `session started: room ${shortId(roomId)}…, this ${role} is peer ${shortId(selfId)}, ${relayUrls.length} servers`, relayUrls);

  const relayFor = url => relays.get(url) ?? null;

  function snapshot() {
    const list = [...relays.values()];
    const elapsedMs = now() - started;
    const base = {
      relays: list.map(r => ({ url: r.url, state: r.state, subscribed: r.subscribed, refused: r.refused, attempts: r.attempts, reason: r.reason })),
      elapsedMs,
      peer: peer ? { id: peer.id, heard: true, sent: { ...peer.sent }, received: { ...peer.received } } : null,
      direct: direct ? { state: direct.state, path: direct.path ?? null } : null,
      joined,
    };
    const step = stepOf(base);
    const up = list.filter(r => r.subscribed).length;
    return { role, ...base, step, up, total: list.length, failure, text: stepText(step, role, { up, total: list.length, failure }) };
  }

  function changed() {
    if (closed) {
      return;
    }

    const s = snapshot();
    const key = `${s.step}|${s.up}|${s.failure ?? ''}|${s.relays.map(r => r.state).join(',')}`;

    if (key === last) {
      return;
    }

    const stepChanged = last.split('|')[0] !== s.step;
    last = key;

    if (stepChanged) {
      log('info', `step: ${s.step} — ${s.text}`);
    }

    for (const listener of [...listeners]) {
      try {
        listener(s);
      } catch (cause) {
        console.error(cause);
      }
    }
  }

  // --- the relay sockets ---------------------------------------------------------------------

  function heardPeer(id, how, relay) {
    if (!peer || peer.id !== id) {
      peer = { id, sent: { offer: 0, answer: 0, candidate: 0, nudge: 0 }, received: { offer: 0, answer: 0, candidate: 0, nudge: 0, announce: 0 } };
      log('info', `heard the ${role === 'computer' ? 'phone' : 'computer'} (peer ${shortId(id)}) by ${how} through ${relay.url}`);
    }
  }

  // The relay sockets outlive a session (New code reuses them), so a closed trace's hooks on them
  // stay silent.
  function onSent(relay, data) {
    if (closed) {
      return;
    }

    const message = parse(data);

    if (!Array.isArray(message)) {
      return;
    }

    if (message[0] === 'REQ') {
      relay.subIds.add(message[1]);
      log('info', `subscribing on ${relay.url}`);
    } else if (message[0] === 'CLOSE') {
      log('info', `unsubscribing on ${relay.url}`);
    } else if (message[0] === 'EVENT') {
      const topic = topicOf(message[1]);

      if (topic && topic === roomTopic) {
        relay.announcesSent += 1;
        log(relay.announcesSent <= 1 ? 'info' : 'debug', `announcing on ${relay.url} (#${relay.announcesSent})`);
      } else {
        const content = parse(message[1]?.content);
        const type = signalType(content);

        if (peer) {
          peer.sent[type] = (peer.sent[type] ?? 0) + 1;
        }

        log(type === 'candidate' ? 'debug' : 'info', `sent ${type} through ${relay.url}`);
      }
    }
  }

  function onReceived(relay, data) {
    if (closed) {
      return;
    }

    const message = parse(data);

    if (!Array.isArray(message)) {
      return;
    }

    const [kind] = message;

    if (kind === 'EOSE') {
      if (relay.subIds.has(message[1]) && !relay.subscribed) {
        relay.subscribed = true;
        relay.state = 'subscribed';
        log('info', `subscription live on ${relay.url}`);
        changed();
      }
    } else if (kind === 'EVENT') {
      const event = message[2];
      const topic = topicOf(event);
      const content = parse(event?.content);
      const id = content?.peerId;

      if (topic && topic === roomTopic) {
        if (id && id !== selfId) {
          heardPeer(id, 'its announcement', relay);
          peer.received.announce += 1;
          log('debug', `announcement from peer ${shortId(id)} through ${relay.url}`);
          changed();
        }
      } else if (topic && topic === selfTopic && id && id !== selfId) {
        const type = signalType(content);
        heardPeer(id, `a ${type}`, relay);
        peer.received[type] = (peer.received[type] ?? 0) + 1;
        log(type === 'candidate' ? 'debug' : 'info', `received ${type} from peer ${shortId(id)} through ${relay.url}`);
        changed();
      }
    } else if (kind === 'OK' && message[2] === false) {
      const reason = String(message[3] ?? '');

      if (reason.startsWith('duplicate:')) {
        log('debug', `${relay.url} already had that event (${reason})`);
      } else if (reason.startsWith('rate-limited:')) {
        log('warn', `${relay.url} is slowing us down: ${reason}`);
      } else {
        relay.refused = true;
        relay.state = 'refused';
        relay.reason = reason || 'refused an event, no reason given';
        log('warn', `${relay.url} refused: ${relay.reason} (this server is no longer used for this session)`);
        changed();
      }
    } else if (kind === 'CLOSED') {
      relay.refused = true;
      relay.state = 'refused';
      relay.reason = String(message[2] ?? 'closed the subscription');
      log('warn', `${relay.url} closed the subscription: ${relay.reason}`);
      changed();
    } else if (kind === 'NOTICE') {
      log('warn', `${relay.url} says: ${message[1]}`);
    }
  }

  function watch(url, socket) {
    const relay = relayFor(url);

    if (!relay || !socket || relay.sockets.has(socket)) {
      return;
    }

    relay.sockets.add(socket);
    relay.attempts += 1;

    if (relay.attempts > 1) {
      log('info', `reconnecting to ${url} (attempt ${relay.attempts})`);
    } else {
      log('info', `connecting to ${url}`);
    }

    const onOpen = () => {
      if (closed) {
        return;
      }

      if (!relay.refused) {
        relay.state = relay.subscribed ? 'subscribed' : 'open';
      }

      log('info', `connected to ${url}`);
      changed();
    };

    if (socket.readyState === 1) {
      onOpen();
    } else {
      socket.addEventListener?.('open', onOpen, { once: true });
    }

    socket.addEventListener?.('message', event => onReceived(relay, event.data));
    socket.addEventListener?.('close', event => {
      if (closed) {
        return;
      }

      if (!relay.refused) {
        relay.state = 'closed';
        relay.subscribed = false;
      }

      log(closed ? 'debug' : 'info', `disconnected from ${url}${event?.code ? ` (code ${event.code}${event.reason ? `: ${event.reason}` : ''})` : ''}`);
      changed();
    });
    socket.addEventListener?.('error', () => !closed && log('warn', `connection error with ${url}`));

    // What this page sends: the socket's own send, wrapped (a new socket is wrapped again).
    const send = socket.send;

    if (typeof send === 'function') {
      socket.send = function tracedSend(data) {
        try {
          onSent(relay, data);
        } catch {
          // Tracing never stops a message.
        }

        return send.call(this, data);
      };
    }
  }

  function poll() {
    if (closed) {
      return;
    }

    let sockets = {};

    try {
      sockets = getSockets() ?? {};
    } catch {
      sockets = {};
    }

    for (const [url, socket] of Object.entries(sockets)) {
      watch(url, socket);
    }

    // A relay waiting past RELAY_SETTLE_MS can change whether the servers count as ready.
    changed();
  }

  const timer = every(poll, SOCKET_POLL_MS);
  topics.then(poll);

  // --- the direct (WebRTC) connections ---------------------------------------------------------

  let rtcPolyfill = null;

  if (typeof Base === 'function') {
    rtcPolyfill = class TracedPeerConnection extends Base {
      constructor(...args) {
        super(...args);
        this.housekiTraced = { remote: false };
        this.addEventListener('icecandidate', event => {
          if (this.housekiTraced.remote && event.candidate) {
            const { type, protocol } = candidateInfo(event.candidate.candidate);
            log('info', `this ${role}'s address candidate: ${type} over ${protocol}`, event.candidate.candidate);
          }
        });
        this.addEventListener('iceconnectionstatechange', () => onIceState(this));
        this.addEventListener('connectionstatechange', () => onIceState(this));
      }

      async setRemoteDescription(description) {
        const result = await super.setRemoteDescription(description);

        if (!this.housekiTraced.remote && !closed) {
          this.housekiTraced.remote = true;
          direct = { pc: this, state: 'trying' };
          failure = null;
          log('info', `trying a direct connection (received the ${description?.type ?? 'description'}; ICE ${this.iceConnectionState})`);
          changed();
        }

        return result;
      }

      async addIceCandidate(candidate) {
        if (this.housekiTraced.remote && candidate?.candidate) {
          const { type, protocol } = candidateInfo(candidate.candidate);
          log('info', `the other device's address candidate: ${type} over ${protocol}`, candidate.candidate);
        }

        return super.addIceCandidate(candidate);
      }
    };
  }

  function onIceState(pc) {
    if (!pc.housekiTraced?.remote || closed) {
      return;
    }

    const ice = pc.iceConnectionState;
    const connection = pc.connectionState;
    log('info', `direct connection: ICE ${ice}, connection ${connection}`);

    if (direct?.pc !== pc) {
      return;
    }

    if (ice === 'connected' || ice === 'completed' || connection === 'connected') {
      direct.state = 'up';

      // Which addresses it uses, once the browser has picked them (Chrome may not have at the
      // first 'connected': asked again at each state change until known).
      if (!direct.path) {
        describePath(pc);
      }
    } else if (ice === 'failed' || connection === 'failed') {
      direct = null;
      failure = 'direct-failed';
      log('warn', 'the direct connection failed: the devices could not reach each other. Common causes: a VPN on either device, a Wi-Fi network that keeps devices apart (guest, office, school, hotel), or the phone on mobile data. Trystero tries again at the next announcement (up to a minute).');
    }

    changed();
  }

  /** Which kinds of addresses the direct connection uses (getStats' selected candidate pair). */
  async function describePath(pc) {
    try {
      const stats = await pc.getStats();
      const byId = new Map();
      let selectedId = null;
      let fallback = null;

      stats.forEach(report => {
        byId.set(report.id, report);

        // Chrome names the pair in use on its transport; Firefox marks the pair `selected`.
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedId = report.selectedCandidatePairId;
        }

        if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.selected || report.nominated)) {
          fallback ??= report;
        }
      });

      const pair = (selectedId && byId.get(selectedId)) || fallback;

      if (direct?.pc === pc && direct.path) {
        return;
      }

      if (pair) {
        const local = byId.get(pair.localCandidateId);
        const remote = byId.get(pair.remoteCandidateId);
        const path = `${local?.candidateType ?? '?'} ↔ ${remote?.candidateType ?? '?'} over ${local?.protocol ?? '?'}`;

        if (direct?.pc === pc) {
          direct.path = path;
        }

        log('info', `direct connection up: ${path}${local?.candidateType === 'host' && remote?.candidateType === 'host' ? ' (same network)' : ''}, round trip ${pair.currentRoundTripTime !== undefined ? `${Math.round(pair.currentRoundTripTime * 1000)} ms` : 'unknown'}`);
      }
    } catch {
      // The path is only for the log.
    }
  }

  // --- the session's own events ------------------------------------------------------------------

  return {
    rtcPolyfill,
    noteStatus(status, detail) {
      log(status === 'error' ? 'warn' : 'info', `session status: ${status}${detail ? ` (${detail})` : ''}`);

      if (status === 'disconnected') {
        peer = null;
        direct = null;
        joined = false;
      }

      changed();
    },
    noteJoined(id) {
      joined = true;
      failure = null;
      log('info', `the password check passed: peer ${shortId(id)} joined`);
      changed();
    },
    noteLeft(id) {
      log('info', `peer ${shortId(id)} left`);
      peer = null;
      direct = null;
      joined = false;
      changed();
    },
    onChange(listener) {
      listeners.add(listener);

      try {
        listener(snapshot());
      } catch (cause) {
        console.error(cause);
      }

      return () => listeners.delete(listener);
    },
    snapshot,
    close() {
      if (closed) {
        return;
      }

      log('info', 'session closed');
      closed = true;
      stop(timer);
      listeners.clear();
    },
  };
}
