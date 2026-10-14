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
//
// Each attempt that fails -- ICE 'failed', or closed by Trystero before it connected -- logs one
// warning (failureReport, T-0345): both devices' addresses, every candidate pair with its checks
// sent and answered, the STUN errors, and a reading of what they suggest. The pairs are read every
// ICE_STATS_POLL_MS while the attempt runs, because a closed connection has no stats left. It was
// added after a transient failure on a home Wi-Fi could not be explained from the log.

import { trysteroTopic } from './scan_trace_hash.js';

/** The connection steps, in order. */
export const STEPS = Object.freeze(['servers', 'waiting', 'introducing', 'direct', 'verifying', 'connected']);

/** How often the relay sockets are looked at for new ones (Trystero replaces them on reconnect). */
export const SOCKET_POLL_MS = 100;

/** Trystero's topic names (its strategy.mjs topicPath and libName). */
export const roomTopicPlaintext = (appId, roomId) => `Trystero@${appId}@${roomId}`;

/**
 * Whether enough relays are ready to wait on: more than half of them subscribed, at once. The
 * user, 2026-10-14: "instead of waiting for at least 1 retry on each of the servers can you just
 * immediately go to 'Waiting for your phone...' ... once we're connected to at least half", "as if
 * both sides are over half there is at least one relay server they're both connected to". Both
 * devices use the same list, so two sets of more than half of it always share a relay; exactly half
 * (4 of 8) need not, so half is not enough. (Until then: every relay had also to have been
 * subscribed, refused, retried, or given 10 s.)
 */
export function serversReady(relays) {
  const list = [...relays];
  const up = list.filter(r => r.subscribed).length;

  return list.length > 0 && up > list.length / 2;
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

  return serversReady(s.relays) ? 'waiting' : 'servers';
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
        : role === 'computer' ? 'Waiting for your phone…' : 'Looking for your computer…';
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

/** How often a direct connection being tried has its candidate pairs read, for the failure report. */
export const ICE_STATS_POLL_MS = 1000;

/**
 * What kind of address an ICE candidate carries: 'mDNS name' (a browser's .local stand-in for its
 * local IP, which the other device must look up by multicast), 'private', 'link-local', 'CGNAT'
 * (100.64.0.0/10: mobile data, or a VPN such as Tailscale), 'public', or 'none' when the stats
 * leave it out.
 */
export function addressKind(address) {
  const a = String(address ?? '').toLowerCase().replace(/^\[|\]$/g, '');

  if (!a) {
    return 'none';
  }

  if (a.endsWith('.local')) {
    return 'mDNS name';
  }

  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);

  if (v4) {
    const [first, second] = [Number(v4[1]), Number(v4[2])];

    if (first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) {
      return 'private';
    }

    if (first === 169 && second === 254) {
      return 'link-local';
    }

    return first === 100 && second >= 64 && second <= 127 ? 'CGNAT' : 'public';
  }

  if (a.startsWith('fe80:')) {
    return 'link-local';
  }

  return a.startsWith('fc') || a.startsWith('fd') || a === '::1' ? 'private' : 'public';
}

/**
 * The ICE side of an RTCStatsReport (getStats), reduced to what explains a failure:
 * `{ local, remote, pairs, selectedPairId }`, where a candidate is `{ id, type, protocol, address,
 * kind, port }` and a pair `{ local, remote, state, nominated, requestsSent, responsesReceived,
 * requestsReceived, responsesSent }` with its two candidates resolved.
 */
export function summariseIceStats(stats) {
  const local = [];
  const remote = [];
  const rawPairs = [];
  const byId = new Map();
  let selectedPairId = null;

  stats?.forEach?.(report => {
    if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
      const address = report.address ?? report.ip ?? '';
      const candidate = {
        id: report.id, type: report.candidateType ?? '?', protocol: report.protocol ?? '?', address,
        kind: addressKind(address), port: report.port ?? null,
      };
      byId.set(report.id, candidate);
      (report.type === 'local-candidate' ? local : remote).push(candidate);
    } else if (report.type === 'candidate-pair') {
      rawPairs.push(report);
    } else if (report.type === 'transport' && report.selectedCandidatePairId) {
      selectedPairId = report.selectedCandidatePairId;
    }
  });

  const pairs = rawPairs.map(p => ({
    id: p.id,
    local: byId.get(p.localCandidateId) ?? null,
    remote: byId.get(p.remoteCandidateId) ?? null,
    state: p.state ?? '?',
    nominated: Boolean(p.nominated),
    requestsSent: p.requestsSent ?? 0,
    responsesReceived: p.responsesReceived ?? 0,
    requestsReceived: p.requestsReceived ?? 0,
    responsesSent: p.responsesSent ?? 0,
  }));

  return { local, remote, pairs, selectedPairId };
}

/**
 * An ICE candidate line ("candidate:<foundation> <component> <protocol> <priority> <address>
 * <port> typ <type> ...", with or without "a=") as a summary candidate, or null.
 */
export function candidateFromLine(line) {
  const m = /candidate:\S+ \d+ (\w+) \d+ (\S+) (\d+) typ (\w+)/i.exec(String(line ?? ''));
  return m ? { type: m[4], protocol: m[1].toLowerCase(), address: m[2], kind: addressKind(m[2]), port: Number(m[3]) } : null;
}

/**
 * The summary with the candidates the trace saw itself (`local`, `remote`: from the descriptions
 * and the trickled candidates) in place of getStats' own. Chrome's stats leave out a local
 * candidate's .local name and list a remote candidate only once it is in a pair, so on their own
 * they cannot tell "nothing arrived" from "nothing could be paired". A pair's candidate the stats
 * left without an address is matched to a seen one by type, protocol and port.
 */
export function withSeenCandidates(summary, local, remote) {
  const fill = (candidate, seen) => {
    if (!candidate || candidate.address) {
      return candidate;
    }

    const match = seen.find(c => c.type === candidate.type && c.protocol === candidate.protocol && c.port === candidate.port);
    return match ? { ...candidate, address: match.address, kind: match.kind } : candidate;
  };

  return {
    ...summary,
    local: local.length ? local : summary.local,
    remote: remote.length ? remote : summary.remote,
    pairs: summary.pairs.map(p => ({ ...p, local: fill(p.local, local), remote: fill(p.remote, remote) })),
  };
}

const describeCandidate = c => (c ? `${c.type} ${c.address || '(no address)'}${c.port ? `:${c.port}` : ''} (${c.kind}, ${c.protocol})` : '?');

/**
 * What a failure's summary suggests, in sentences, most telling first. `role` is this page's
 * ('computer' or 'phone'); `candidateErrors` the STUN failures seen while gathering.
 */
export function failureReading(summary, role, { candidateErrors = [] } = {}) {
  const other = role === 'computer' ? 'phone' : 'computer';
  const { local, remote, pairs } = summary;
  const reading = [];

  if (local.length === 0) {
    reading.push(`This ${role} gathered no addresses of its own.`);
  }

  if (remote.length === 0) {
    reading.push(`No address of the ${other} arrived: its candidates were lost on the way through the servers, or it gathered none.`);
  }

  const remoteHosts = remote.filter(c => c.type === 'host');
  const hostPairs = pairs.filter(p => p.remote?.type === 'host');

  if (remoteHosts.length > 0 && hostPairs.length === 0) {
    reading.push(`The ${other} offered a local address but no check was ever made on it: ${remoteHosts.some(c => c.kind === 'mDNS name') ? 'its .local name could not be looked up (mDNS) this time' : 'it could not be paired with any address here'}.`);
  } else if (hostPairs.length > 0 && hostPairs.every(p => p.responsesReceived === 0)) {
    reading.push(`No check on the ${other}'s local address was answered: on one Wi-Fi network this means the two could not reach each other directly at that moment.`);
  }

  if (pairs.length > 0 && pairs.every(p => p.responsesReceived === 0)) {
    reading.push(`No check on any pair was answered (${pairs.reduce((n, p) => n + p.requestsSent, 0)} sent, ${pairs.reduce((n, p) => n + p.requestsReceived, 0)} received from the ${other}).`);
  } else if (pairs.some(p => p.responsesReceived > 0) && !pairs.some(p => p.state === 'succeeded')) {
    reading.push('Some checks were answered, but no pair completed: the route came and went.');
  }

  if (local.length > 0 && !local.some(c => c.type === 'srflx')) {
    reading.push(`This ${role} learned no public address from the STUN servers${candidateErrors.length ? ` (${candidateErrors.length} STUN error${candidateErrors.length === 1 ? '' : 's'})` : ''}.`);
  }

  if ([...local, ...remote].some(c => c.kind === 'CGNAT')) {
    reading.push('A carrier-grade NAT address (100.64.x.x) is involved: mobile data, or a VPN such as Tailscale.');
  }

  return reading;
}

/**
 * The failure report, as lines: what happened, both devices' addresses, every candidate pair and
 * its checks, the STUN errors, and the reading. `why` names what ended it ('ICE failed', ...);
 * `seconds` how long since the other device's description was set; `stale` that the pairs are
 * from the last reading while it was trying, `statsAgo` seconds earlier.
 */
export function failureReport(summary, { role, why, seconds, ice, connection, gathering, wasUp = false, stale = false, statsAgo = null, candidateErrors = [] }) {
  const other = role === 'computer' ? 'phone' : 'computer';
  const lines = [
    `the direct connection ${wasUp ? 'dropped' : 'failed'}: ${why}, ${seconds.toFixed(1)} s after the ${other}'s description (ICE ${ice}, connection ${connection}, gathering ${gathering})${stale ? `; pairs as last read while it was trying${statsAgo === null ? '' : `, ${statsAgo.toFixed(1)} s earlier`}` : ''}`,
    `this ${role}'s addresses (${summary.local.length}): ${summary.local.map(describeCandidate).join('; ') || 'none'}`,
    `the ${other}'s addresses (${summary.remote.length}): ${summary.remote.map(describeCandidate).join('; ') || 'none'}`,
    `pairs tried (${summary.pairs.length}):`,
    ...summary.pairs.map(p => `  ${describeCandidate(p.local)} ↔ ${describeCandidate(p.remote)}: ${p.state}${p.nominated ? ', nominated' : ''}${p.id === summary.selectedPairId ? ', selected' : ''}; checks sent ${p.requestsSent}, answered ${p.responsesReceived}; received ${p.requestsReceived}, answered ${p.responsesSent}`),
  ];

  if (candidateErrors.length) {
    lines.push(`STUN errors while gathering: ${candidateErrors.map(e => `${e.url} ${e.errorCode} ${e.errorText}`.trim()).join('; ')}`);
  }

  const reading = failureReading(summary, role, { candidateErrors });
  lines.push(...(reading.length ? reading.map(r => `reading: ${r}`) : ['reading: nothing stands out in the pairs']));
  return lines;
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
 * The trace only watches, with one exception: `resender` (scan_resend.js createOfferResender),
 * when given, is told what is sent and heard on the relay sockets, and resends an offer the other
 * device shows it never got.
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
 * @param {object} [options.resender]   scan_resend.js createOfferResender's
 */
export function createScanTrace({
  role, appId, roomId, relayUrls, getSockets, selfId,
  log = createScanLog(role), now = () => Date.now(),
  setInterval: every = (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: stop = id => globalThis.clearInterval(id),
  RTCPeerConnection: Base = globalThis.RTCPeerConnection,
  sha1 = trysteroTopic,
  resender = null,
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
        resender?.sent(relay.url, message[1]);
      }
    }
  }

  function onReceived(relay, data, socket) {
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
          resender?.heard(relay.url, socket, id, 'announcement');
          changed();
        }
      } else if (topic && topic === selfTopic && id && id !== selfId) {
        const type = signalType(content);
        heardPeer(id, `a ${type}`, relay);
        peer.received[type] = (peer.received[type] ?? 0) + 1;
        log(type === 'candidate' ? 'debug' : 'info', `received ${type} from peer ${shortId(id)} through ${relay.url}`);

        if (type === 'nudge') {
          resender?.heard(relay.url, socket, id, 'nudge');
        } else if (type === 'answer') {
          resender?.answered(id);
        }

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

    socket.addEventListener?.('message', event => onReceived(relay, event.data, socket));
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
        // remoteAt: when the other device's description was set; wasUp: the connection has been
        // up; stats, statsAt: the last reading of its pairs and when (getStats fails once it is
        // closed, and Chrome empties the pairs once it has failed);
        // candidateErrors: STUN failures while gathering; reported: the failure has been logged;
        // seenLocal, seenRemote: the candidates seen (candidateFromLine), for the report.
        this.housekiTraced = {
          remote: false, remoteAt: null, wasUp: false, stats: null, statsAt: null, statsTimer: null, candidateErrors: [], reported: false,
          seenLocal: [], seenRemote: [],
        };
        this.addEventListener('icecandidate', event => {
          // Recorded from the start: an offer from Trystero's pool gathered before it was used.
          see(this.housekiTraced.seenLocal, event.candidate?.candidate);

          if (this.housekiTraced.remote && event.candidate) {
            const { type, protocol } = candidateInfo(event.candidate.candidate);
            log('info', `this ${role}'s address candidate: ${type} over ${protocol}`, event.candidate.candidate);
          }
        });
        // A STUN server that did not answer (Chrome reports one per server and address family).
        this.addEventListener('icecandidateerror', event => {
          const error = { url: event.url ?? '', errorCode: event.errorCode ?? '', errorText: event.errorText ?? '' };
          this.housekiTraced.candidateErrors.push(error);

          if (this.housekiTraced.remote) {
            log('debug', `address gathering error: ${error.url} ${error.errorCode} ${error.errorText}`.trim());
          }
        });
        this.addEventListener('icegatheringstatechange', () => {
          if (this.housekiTraced.remote && !closed) {
            log('debug', `address gathering: ${this.iceGatheringState}`);
          }
        });
        this.addEventListener('iceconnectionstatechange', () => onIceState(this));
        this.addEventListener('connectionstatechange', () => onIceState(this));
      }

      async setRemoteDescription(description) {
        const result = await super.setRemoteDescription(description);
        // Candidates inside the description itself (a pooled offer carries those it gathered).
        const carried = String(description?.sdp ?? '').split(/\r?\n/).filter(line => line.startsWith('a=candidate:'));
        carried.forEach(line => see(this.housekiTraced.seenRemote, line));

        if (!this.housekiTraced.remote && !closed) {
          this.housekiTraced.remote = true;
          this.housekiTraced.remoteAt = now();
          direct = { pc: this, state: 'trying' };
          failure = null;
          log('info', `trying a direct connection (received the ${description?.type ?? 'description'}; ICE ${this.iceConnectionState}; ${carried.length} address candidate${carried.length === 1 ? '' : 's'} inside it${carried.length ? `: ${carried.map(line => { const c = candidateFromLine(line); return c ? `${c.type} (${c.kind})` : '?'; }).join(', ')}` : ''})`);
          watchPairs(this);
          changed();
        }

        return result;
      }

      // Trystero closes an attempt that has not connected in time (about 23 s) without any state
      // event, so a close is where that kind of failure is seen.
      close() {
        const traced = this.housekiTraced;

        if (traced?.remote && !traced.wasUp && !traced.reported && !closed && this.connectionState !== 'closed') {
          reportFailure(this, 'closed by Trystero before it connected', traced.stats, true);
        }

        unwatchPairs(this);
        return super.close();
      }

      async addIceCandidate(candidate) {
        see(this.housekiTraced.seenRemote, candidate?.candidate);

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
    const seconds = pc.housekiTraced.remoteAt === null ? '' : ` (${((now() - pc.housekiTraced.remoteAt) / 1000).toFixed(1)} s after the description)`;
    log('info', `direct connection: ICE ${ice}, connection ${connection}${seconds}`);

    if (ice === 'connected' || ice === 'completed' || connection === 'connected') {
      pc.housekiTraced.wasUp = true;
    }

    // Every attempt that fails is reported, the current one or an older one.
    if ((ice === 'failed' || connection === 'failed') && !pc.housekiTraced.reported) {
      reportFailure(pc, ice === 'failed' ? 'ICE failed' : 'the connection failed', null, false);
    }

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

  /** Adds the candidate on `line` to `list` unless it is already there. */
  function see(list, line) {
    const c = candidateFromLine(line);

    if (c && !list.some(o => o.address === c.address && o.port === c.port && o.protocol === c.protocol)) {
      list.push(c);
    }
  }

  // The attempts whose pairs are being read, so close() can stop them all.
  const watched = new Set();

  /** Reads an attempt's pairs every ICE_STATS_POLL_MS until it is up, has failed or is closed. */
  function watchPairs(pc) {
    const read = async () => {
      const traced = pc.housekiTraced;

      if (closed || traced.wasUp || traced.reported || pc.connectionState === 'closed') {
        unwatchPairs(pc);
        return;
      }

      try {
        traced.stats = summariseIceStats(await pc.getStats());
        traced.statsAt = now();
      } catch {
        // Closed in between: the last reading stands.
      }
    };

    pc.housekiTraced.statsTimer = every(read, ICE_STATS_POLL_MS);
    watched.add(pc);
    read();
  }

  function unwatchPairs(pc) {
    if (pc.housekiTraced?.statsTimer != null) {
      stop(pc.housekiTraced.statsTimer);
      pc.housekiTraced.statsTimer = null;
    }

    watched.delete(pc);
  }

  /**
   * Logs why an attempt failed, as one warning: its pairs read now if it is still open, else
   * `lastStats` (the last reading, marked stale).
   */
  async function reportFailure(pc, why, lastStats, isClosing) {
    const traced = pc.housekiTraced;
    traced.reported = true;
    unwatchPairs(pc);
    // The states and timing as they are now, before anything below waits.
    const context = {
      role, why, statsAgo: traced.statsAt === null ? null : (now() - traced.statsAt) / 1000, wasUp: traced.wasUp, candidateErrors: traced.candidateErrors,
      seconds: (now() - (traced.remoteAt ?? now())) / 1000,
      ice: pc.iceConnectionState, connection: pc.connectionState, gathering: pc.iceGatheringState,
    };
    let summary = null;
    let stale = false;

    if (!isClosing) {
      try {
        summary = summariseIceStats(await pc.getStats());
      } catch {
        summary = null;
      }
    }

    // Chrome drops the pairs from its stats once the connection has failed (measured): the last
    // reading while it was trying says more.
    if (summary && summary.pairs.length === 0 && (lastStats ?? traced.stats)?.pairs.length) {
      summary = null;
    }

    if (!summary) {
      summary = lastStats ?? traced.stats ?? summariseIceStats(null);
      stale = true;
    }

    summary = withSeenCandidates(summary, traced.seenLocal, traced.seenRemote);

    if (!closed) {
      log('warn', failureReport(summary, { ...context, stale }).join('\n    '));
    }
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
      resender?.answered(id);
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
      resender?.close();
      stop(timer);
      [...watched].forEach(unwatchPairs);
      listeners.clear();
    },
  };
}
