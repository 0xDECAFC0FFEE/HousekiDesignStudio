/*
 * scan_trace_test.js -- the connection steps and log (src/web/src/lib/scan_trace.js) and the
 * connection picture's view (src/web/src/lib/connection_diagram.js diagramView), T-0342.
 *
 * The real flow -- two pages pairing through a relay, every step logged on both -- is
 * tests/harness/test_scan_link.py's test_both_ends_go_through_each_connection_step_and_log_it. Here
 * the rules are pinned on their own: when the servers count as ready, which step a state is at,
 * the words for each, what a relay's messages mean, and what the picture shows at each step.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 */

import {
  addressKind, candidateFromLine, candidateInfo, createScanLog, createScanTrace, failureReading, failureReport, roomTopicPlaintext,
  serversReady, signalType, STEPS, stepOf, stepText, summariseIceStats, withSeenCandidates,
} from '../src/lib/scan_trace.js';
import { trysteroTopic } from '../src/lib/scan_trace_hash.js';
import { diagramView, lanesFor } from '../src/lib/connection_diagram.js';

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

const relay = (subscribed, extra = {}) => ({ subscribed, refused: false, attempts: 1, ...extra });

Deno.test('the servers are ready as soon as more than half are subscribed', () => {
  // Setup: lists of 8 relays in different states (the rest still on their first try), one of 7
  // (an odd count), and an empty one.
  // Test: serversReady on each.
  // Verifies the user's rule (2026-10-14): more than half subscribed is ready at once, without
  // waiting for the others to be retried or refused -- 5 of 8 is, all 8 is; exactly half (4 of 8),
  // which two devices could hold with no relay in common, is not; 4 of 7 is; nothing is not.
  const list = (up, total) => [...Array.from({ length: up }, () => relay(true)), ...Array.from({ length: total - up }, () => relay(false))];
  assert(serversReady(list(8, 8)), 'all subscribed');
  assert(serversReady(list(5, 8)), '5 of 8, the rest still on their first try');
  assert(!serversReady(list(4, 8)), '4 of 8 is only half');
  assert(serversReady(list(4, 7)), '4 of 7 is more than half');
  assert(!serversReady(list(3, 7)), '3 of 7 is not');
  assert(!serversReady([]), 'no relays');
});

Deno.test('the step follows the furthest condition reached', () => {
  // Setup: snapshots from an empty session to a joined one.
  // Test: stepOf each.
  // Verifies the order in STEPS: servers until enough relays are subscribed, then waiting; the
  // other device heard is introducing; a direct connection being tried is direct, up is
  // verifying; joined is connected -- each overriding the earlier ones.
  const ready = Array.from({ length: 2 }, () => relay(true));
  const base = { relays: [relay(false)], elapsedMs: 0, peer: null, direct: null, joined: false };
  assertEquals(STEPS, ['servers', 'waiting', 'introducing', 'direct', 'verifying', 'connected'], 'the steps');
  assertEquals(stepOf(base), 'servers', 'nothing yet');
  assertEquals(stepOf({ ...base, relays: ready }), 'waiting', 'servers ready');
  assertEquals(stepOf({ ...base, relays: ready, peer: { heard: true } }), 'introducing', 'heard');
  assertEquals(stepOf({ ...base, relays: ready, peer: { heard: true }, direct: { state: 'trying' } }), 'direct', 'trying');
  assertEquals(stepOf({ ...base, relays: ready, peer: { heard: true }, direct: { state: 'up' } }), 'verifying', 'up');
  assertEquals(stepOf({ ...base, joined: true }), 'connected', 'joined');
});

Deno.test('each step has its words, for the computer and the phone', () => {
  // Setup: every step for both roles, the server counts, and a failed direct connection.
  // Verifies: the step line reads as the user asked ("Connecting to the servers… (3 of 8)",
  // "Waiting for your phone…" on the computer, "Looking for your computer…" on the phone -- with no
  // count once enough servers are up (the user, 2026-10-14) -- ..., "Connected"); a failed direct
  // connection says so and that it is trying again.
  assertEquals(stepText('servers', 'computer', { up: 3, total: 8 }), 'Connecting to the servers… (3 of 8)', 'servers');
  assertEquals(stepText('waiting', 'computer', { up: 8, total: 8 }), 'Waiting for your phone…', 'waiting, computer');
  assertEquals(stepText('waiting', 'phone', { up: 5, total: 8 }), 'Looking for your computer…', 'waiting, phone');
  assertEquals(stepText('introducing', 'phone'), 'Exchanging connection details with your computer…', 'introducing');
  assertEquals(stepText('direct', 'computer'), 'Setting up a direct connection to your phone…', 'direct');
  assertEquals(stepText('verifying', 'phone'), 'Checking the password…', 'verifying');
  assertEquals(stepText('connected', 'phone'), 'Connected', 'connected');
  assertEquals(stepText('introducing', 'computer', { failure: 'direct-failed' }), 'The direct connection to your phone failed. Trying again…', 'failure');
});

Deno.test('signals and address candidates are told apart as Trystero writes them', () => {
  // Setup: the four kinds of signal content Trystero sends to a device's own topic, and two ICE
  // candidate lines.
  // Verifies: offer, answer and candidate by their field, a bare peer id is a 'nudge' (the
  // device that should not make the offer asks the other to); a candidate's type and protocol.
  assertEquals(['offer', 'answer', 'candidate', 'nudge'],
    [{ offer: 'x' }, { answer: 'x' }, { candidate: 'x' }, { peerId: 'p' }].map(signalType), 'signal types');
  assertEquals(candidateInfo('candidate:3335817039 1 udp 2122194687 192.168.0.22 51362 typ host generation 0'), { type: 'host', protocol: 'udp' }, 'host');
  assertEquals(candidateInfo('candidate:842163049 1 udp 1677729535 81.2.3.4 51723 typ srflx raddr 0.0.0.0 rport 0'), { type: 'srflx', protocol: 'udp' }, 'srflx');
});

Deno.test('a topic is named as Trystero names it: SHA-1, each byte in base 36', async () => {
  // Setup: the room topic's text for app 'houseki-scanner' and room 'abc'.
  // Test: trysteroTopic.
  // Verifies: the same string Trystero's crypto.mjs makes (bytes in base 36, unpadded, joined),
  // worked out independently here from Web Crypto's SHA-1.
  const text = roomTopicPlaintext('houseki-scanner', 'abc');
  assertEquals(text, 'Trystero@houseki-scanner@abc', 'the topic text');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)));
  assertEquals(await trysteroTopic(text), Array.from(digest, b => b.toString(36)).join(''), 'the topic');
});

/** A stand-in relay socket: records listeners, sends, and lets the test play the relay. */
function fakeSocket() {
  const listeners = {};
  const sent = [];
  return {
    readyState: 0,
    sent,
    send(data) {
      sent.push(data);
    },
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    fire(type, event = {}) {
      for (const fn of listeners[type] ?? []) {
        fn(event);
      }
    },
  };
}

Deno.test('a session is followed from the relay sockets: subscribed, the other device heard, a refusal logged', async () => {
  // Setup: a trace for the computer on two relays, with fake sockets, a log written to an array,
  // and no timer (the test polls by hand through the fake setInterval).
  // Test: open both sockets; this page subscribes (REQ, through the wrapped send); one relay
  // confirms with EOSE; the second confirms too; the phone's announcement arrives on the room
  // topic; then the second relay refuses an event (OK false).
  // Verifies: the step goes servers -> waiting (both subscribed) -> introducing (the phone
  // heard); the counts follow; the refusal marks the relay refused with its reason and logs a
  // warning naming it; every line starts with "[houseki scan computer".
  const lines = [];
  const sink = { info: (...a) => lines.push(['info', a.join(' ')]), warn: (...a) => lines.push(['warn', a.join(' ')]), debug: () => {} };
  const sockets = { 'wss://a': fakeSocket(), 'wss://b': fakeSocket() };
  let tick = null;
  const trace = createScanTrace({
    role: 'computer', appId: 'houseki-scanner', roomId: 'room1', relayUrls: Object.keys(sockets),
    getSockets: () => sockets, selfId: 'me',
    log: createScanLog('computer', { sink }),
    setInterval: fn => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {},
    RTCPeerConnection: null,
  });
  const steps = [];
  trace.onChange(s => steps.at(-1) !== s.step && steps.push(s.step));
  const roomTopic = await trysteroTopic(roomTopicPlaintext('houseki-scanner', 'room1'));
  await new Promise(resolve => setTimeout(resolve, 0));
  tick();

  for (const [url, socket] of Object.entries(sockets)) {
    socket.readyState = 1;
    socket.fire('open');
    socket.send(JSON.stringify(['REQ', `sub-${url}`, { '#x': [roomTopic] }]));
    socket.fire('message', { data: JSON.stringify(['EOSE', `sub-${url}`]) });
  }

  assertEquals(trace.snapshot().up, 2, 'both subscribed');
  const announcement = { kind: 20001, tags: [['x', roomTopic]], content: JSON.stringify({ peerId: 'phone1' }) };
  sockets['wss://a'].fire('message', { data: JSON.stringify(['EVENT', 'sub-wss://a', announcement]) });
  sockets['wss://b'].fire('message', { data: JSON.stringify(['OK', 'event1', false, 'blocked: ASN 16509 not allowed']) });

  assertEquals(steps, ['servers', 'waiting', 'introducing'], 'the steps');
  const snapshot = trace.snapshot();
  assertEquals(snapshot.relays.find(r => r.url === 'wss://b'), {
    url: 'wss://b', state: 'refused', subscribed: true, refused: true, attempts: 1, reason: 'blocked: ASN 16509 not allowed',
  }, 'the refusing relay');
  assert(lines.some(([level, text]) => level === 'warn' && text.includes('wss://b refused: blocked: ASN 16509 not allowed')), 'the refusal is logged');
  assert(lines.some(([, text]) => text.includes('heard the phone (peer phone1)')), 'the phone is logged');
  assert(lines.every(([, text]) => text.startsWith('[houseki scan computer +')), 'every line is prefixed');
  trace.close();
});

Deno.test('the picture shows what the user described at each step', () => {
  // Setup: diagramView for every step, as the computer and as the phone.
  // Verifies, step by step (the user's description, with the 2026-10-13 feedback): connecting to
  // the servers -- grey arrows from this device to the server only, the server and the other
  // device greyed; over half the servers ready ('waiting') -- the same lane, arrows bold, the
  // server white; the other device heard -- not greyed, arrows through the server both ways (four
  // lanes); the direct connection -- the server gone, arrows straight across both ways; connected
  // -- the same, arrows still bold white (no green). On the phone the first lane runs from the
  // phone (right) to the server. An error clears the lanes and marks the picture failed.
  const lanes = (view) => [...view.lanes].sort();
  const servers = diagramView('servers', 'computer');
  assertEquals([lanes(servers), servers.arrows, servers.otherGreyed, servers.serverGreyed, servers.serverShown],
    [['leftToServer'], 'grey', true, true, true], 'servers');
  const waiting = diagramView('waiting', 'computer');
  assertEquals([lanes(waiting), waiting.arrows, waiting.otherGreyed, waiting.serverGreyed], [['leftToServer'], 'bold', true, false], 'waiting');
  const introducing = diagramView('introducing', 'computer');
  assertEquals([lanes(introducing), introducing.otherGreyed], [['leftToServer', 'rightToServer', 'serverToLeft', 'serverToRight'], false], 'introducing');
  const direct = diagramView('direct', 'computer');
  assertEquals([lanes(direct), direct.serverShown], [['leftToRight', 'rightToLeft'], false], 'direct');
  assertEquals(diagramView('connected', 'computer').arrows, 'bold', 'connected: white, not green');
  assertEquals(lanes(diagramView('servers', 'phone')), ['rightToServer'], 'the phone sends from the right');
  const failed = diagramView('waiting', 'phone', { error: true });
  assertEquals([lanes(failed), failed.failed], [[], true], 'an error');
});

Deno.test('the top row carries what leaves this device: rightwards on the computer, leftwards on the phone', () => {
  // Setup: the lanes for each page.
  // Verifies the user's request: on the computer the top row (the smaller y) runs from the
  // computer rightwards, the bottom row back; on the phone the top row runs from the phone
  // leftwards towards the computer, the bottom row back.
  const computer = lanesFor('computer');
  const phone = lanesFor('phone');
  assert(computer.leftToRight[1] < computer.rightToLeft[1], 'computer: rightward lane on top');
  assert(phone.rightToLeft[1] < phone.leftToRight[1], 'phone: leftward lane on top');
  assertEquals(computer.leftToRight[1], phone.rightToLeft[1], 'the same top row');
});

// --- the failure report (T-0345) ---------------------------------------------------------------

/**
 * A stand-in RTCStatsReport for a failed attempt on one Wi-Fi network, the shape Chrome gives:
 * this computer has an mDNS host candidate and a srflx one; the phone offered an mDNS host and a
 * srflx; `hostPair` says whether the phone's .local name was looked up (a host<->host pair exists);
 * every check went unanswered.
 */
function failedStats({ hostPair = true } = {}) {
  const reports = [
    { id: 'L1', type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: 'a1b2.local', port: 50000 },
    { id: 'L2', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp', address: '81.2.3.4', port: 50001 },
    { id: 'R1', type: 'remote-candidate', candidateType: 'host', protocol: 'udp', address: hostPair ? '192.168.1.20' : 'c3d4.local', port: 60000 },
    { id: 'R2', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp', address: '81.2.3.4', port: 60001 },
    { id: 'P2', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R2', state: 'failed', requestsSent: 9, responsesReceived: 0, requestsReceived: 0, responsesSent: 0 },
  ];

  if (hostPair) {
    reports.push({ id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', state: 'failed', requestsSent: 12, responsesReceived: 0, requestsReceived: 3, responsesSent: 3 });
  }

  return new Map(reports.map(r => [r.id, r]));
}

Deno.test('an address is told by its kind: mDNS name, private, link-local, CGNAT or public', () => {
  // Setup: one address of each kind, IPv4 and IPv6.
  // Test: addressKind on each.
  // Verifies: the reading can say whether the other device hid its local address behind a .local
  // name, sat on the same private network, or came over mobile data or a VPN (100.64.0.0/10).
  assertEquals(
    ['a1b2-c3.local', '192.168.1.20', '10.0.0.5', '172.20.1.1', '172.32.1.1', '169.254.3.4', '100.88.1.2', '81.2.3.4', 'fe80::1', 'fd00::5', '2a00:1450::1', ''].map(addressKind),
    ['mDNS name', 'private', 'private', 'private', 'public', 'link-local', 'CGNAT', 'public', 'link-local', 'private', 'public', 'none'],
    'the kinds');
});

Deno.test('the stats are reduced to the candidates and the pairs with their checks', () => {
  // Setup: the failed attempt's stats, with the host pair.
  // Test: summariseIceStats.
  // Verifies: two candidates each side with their type and address kind; both pairs, each with
  // its candidates resolved and its check counts (12 sent, none answered, 3 received from the
  // phone and answered). A missing report (null) gives an empty summary rather than throwing.
  const summary = summariseIceStats(failedStats());
  assertEquals(summary.local.map(c => [c.type, c.kind]), [['host', 'mDNS name'], ['srflx', 'public']], 'local');
  assertEquals(summary.remote.map(c => [c.type, c.kind]), [['host', 'private'], ['srflx', 'public']], 'remote');
  const host = summary.pairs.find(p => p.id === 'P1');
  assertEquals([host.local.type, host.remote.type, host.state, host.requestsSent, host.responsesReceived, host.requestsReceived],
    ['host', 'host', 'failed', 12, 0, 3], 'the host pair');
  assertEquals(summariseIceStats(null), { local: [], remote: [], pairs: [], selectedPairId: null }, 'no stats');
});

Deno.test('the candidates the trace saw replace what Chrome\'s stats leave out', () => {
  // Setup: a summary as Chrome gives it for an attempt that never paired: this computer's host
  // candidate without its address (Chrome hides the .local name in stats), and no remote
  // candidate at all (Chrome lists one only once it is in a pair). The trace saw, from the
  // description and the trickled candidates, the computer's .local host and the phone's host.
  // Test: candidateFromLine on those lines, then withSeenCandidates.
  // Verifies: a line is read with or without "a=" into type, protocol, address, kind and port;
  // the merged summary lists both devices' addresses; the pair's local candidate gets its .local
  // address back by type, protocol and port; the reading no longer claims nothing arrived but
  // says the phone's local address was never checked.
  const mine = candidateFromLine('candidate:911 1 udp 2113937151 c49b.local 61969 typ host generation 0 ufrag 5U5p');
  const theirs = candidateFromLine('a=candidate:1 1 UDP 2122260223 d7e8.local 50000 typ host');
  assertEquals(mine, { type: 'host', protocol: 'udp', address: 'c49b.local', kind: 'mDNS name', port: 61969 }, 'mine');
  assertEquals([theirs.protocol, theirs.kind, theirs.port], ['udp', 'mDNS name', 50000], 'theirs');
  assertEquals(candidateFromLine('not a candidate'), null, 'not a line');
  const stats = {
    local: [{ id: 'L', type: 'host', protocol: 'udp', address: '', kind: 'none', port: 61969 }],
    remote: [],
    pairs: [],
    selectedPairId: null,
  };
  assert(failureReading(stats, 'computer').some(r => r.startsWith('No address of the phone arrived')), 'stats alone mislead');
  const merged = withSeenCandidates({ ...stats, pairs: [{ local: stats.local[0], remote: null, state: 'waiting' }] }, [mine], [theirs]);
  assertEquals(merged.remote, [theirs], 'the phone\'s address');
  assertEquals(merged.pairs[0].local.address, 'c49b.local', 'the pair\'s address filled in');
  const reading = failureReading(merged, 'computer');
  assert(!reading.some(r => r.startsWith('No address of the phone arrived')), `no false claim: ${reading}`);
  assert(reading.some(r => r.includes('its .local name could not be looked up (mDNS)')), `the host never checked: ${reading}`);
});

Deno.test('the reading names the likely cause from the pairs', () => {
  // Setup: three failures -- the phone's .local name never looked up (no host pair); a host pair
  // tried with nothing answered; and nothing arriving from the phone at all.
  // Test: failureReading as the computer.
  // Verifies: the first says the .local name could not be looked up (mDNS); the second that the
  // local address was not answered and that no pair was answered, with the check counts; the
  // third that no address of the phone arrived.
  const noLookup = failureReading(summariseIceStats(failedStats({ hostPair: false })), 'computer');
  assert(noLookup.some(r => r.includes('.local name could not be looked up (mDNS)')), `no lookup: ${noLookup}`);
  const unanswered = failureReading(summariseIceStats(failedStats()), 'computer');
  assert(unanswered.some(r => r.startsWith('No check on the phone\'s local address was answered')), `unanswered host: ${unanswered}`);
  assert(unanswered.some(r => r.includes('No check on any pair was answered (21 sent, 3 received from the phone)')), `unanswered all: ${unanswered}`);
  const nothing = failureReading({ local: [], remote: [], pairs: [] }, 'computer');
  assert(nothing.some(r => r.startsWith('No address of the phone arrived')), `nothing: ${nothing}`);
});

Deno.test('the report lists what happened, both devices\' addresses, every pair and the STUN errors', () => {
  // Setup: the failed attempt with the host pair, 12.34 s after the phone's offer, one STUN error.
  // Test: failureReport as the computer.
  // Verifies: the first line says it failed, why, when and the states; then this computer's
  // addresses, the phone's, one line per pair with its checks, the STUN error, and at least one
  // "reading:" line.
  const lines = failureReport(summariseIceStats(failedStats()), {
    role: 'computer', why: 'ICE failed', seconds: 12.34, ice: 'failed', connection: 'failed', gathering: 'complete',
    candidateErrors: [{ url: 'stun:stun.l.google.com:19302', errorCode: 701, errorText: 'STUN host lookup received error.' }],
  });
  assertEquals(lines[0], 'the direct connection failed: ICE failed, 12.3 s after the phone\'s description (ICE failed, connection failed, gathering complete)', 'the head');
  assert(lines[1].startsWith('this computer\'s addresses (2): host a1b2.local:50000 (mDNS name, udp)'), lines[1]);
  assert(lines[2].startsWith('the phone\'s addresses (2): host 192.168.1.20:60000 (private, udp)'), lines[2]);
  assertEquals(lines[3], 'pairs tried (2):', 'the pairs head');
  assert(lines.some(l => l.includes('↔ host 192.168.1.20:60000 (private, udp): failed; checks sent 12, answered 0; received 3, answered 3')), 'the host pair line');
  assert(lines.some(l => l === 'STUN errors while gathering: stun:stun.l.google.com:19302 701 STUN host lookup received error.'), 'the STUN error');
  assert(lines.some(l => l.startsWith('reading: ')), 'a reading');
});

/** A stand-in RTCPeerConnection: states set by the test, events dispatched, stats from `stats`. */
function fakePeerConnectionClass(stats) {
  return class extends EventTarget {
    iceConnectionState = 'new';
    connectionState = 'new';
    iceGatheringState = 'complete';
    async setRemoteDescription() {}
    async addIceCandidate() {}
    async getStats() {
      if (this.connectionState === 'closed') {
        throw new Error('InvalidStateError');
      }

      return stats;
    }
    close() {
      this.connectionState = 'closed';
      this.iceConnectionState = 'closed';
    }
    // The test's way to move the connection on, as the browser would.
    go(ice, connection) {
      this.iceConnectionState = ice;
      this.connectionState = connection;
      this.dispatchEvent(new Event('iceconnectionstatechange'));
    }
  };
}

Deno.test('a failure whose stats have lost their pairs reports the last reading taken while it was trying', async () => {
  // Setup: a fake connection whose stats have the failed attempt's pairs while it is checking,
  // and none once it has failed (what Chrome does, measured in headless Chrome on 2026-10-14).
  // Test: set the description (the pairs are read then), move it to checking, then to failed.
  // Verifies: the report lists the pairs from the earlier reading, says so, and does not say
  // "pairs tried (0)".
  const stats = failedStats();
  const Base = class extends fakePeerConnectionClass(stats) {
    async getStats() {
      return this.connectionState === 'failed' ? new Map([...stats].filter(([, r]) => r.type !== 'candidate-pair')) : stats;
    }
  };
  const { trace, warnings } = traceWith(Base);
  const pc = new trace.rtcPolyfill({});
  await pc.setRemoteDescription({ type: 'answer', sdp: '' });
  await settle();
  pc.go('checking', 'connecting');
  pc.go('failed', 'failed');
  await settle();
  const report = warnings.find(w => w.includes('the direct connection failed: ICE failed'));
  assert(report && report.includes('pairs as last read while it was trying') && report.includes('pairs tried (2)'), `the report: ${report}`);
  trace.close();
});

/** A trace on one fake relay whose WebRTC class is `Base`; its warnings collected in `warnings`. */
function traceWith(Base) {
  const warnings = [];
  const sink = { info: () => {}, debug: () => {}, warn: (...a) => warnings.push(a.join(' ')) };
  const trace = createScanTrace({
    role: 'computer', appId: 'houseki-scanner', roomId: 'room1', relayUrls: ['wss://a'],
    getSockets: () => ({}), selfId: 'me', log: createScanLog('computer', { sink }),
    setInterval: () => 1, clearInterval: () => {}, RTCPeerConnection: Base,
  });
  return { trace, warnings };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

Deno.test('an attempt whose ICE fails logs the report with its pairs read at that moment', async () => {
  // Setup: a trace whose WebRTC class is the fake, returning the failed attempt's stats.
  // Test: make a connection (as Trystero would), set the phone's description, move it to
  // checking, then to failed.
  // Verifies: one warning carries the report -- "ICE failed", the phone's addresses and the host
  // pair's checks -- not marked stale (read while the connection was still open); the step falls
  // back with the failure set; closing the connection afterwards adds no second report.
  const { trace, warnings } = traceWith(fakePeerConnectionClass(failedStats()));
  const pc = new trace.rtcPolyfill({});
  await pc.setRemoteDescription({ type: 'offer', sdp: '' });
  pc.go('checking', 'connecting');
  pc.go('failed', 'failed');
  await settle();
  const reports = warnings.filter(w => w.includes('the direct connection failed: ICE failed'));
  assertEquals(reports.length, 1, 'one report');
  assert(reports[0].includes('the phone\'s addresses (2)'), 'the addresses');
  assert(reports[0].includes('checks sent 12, answered 0'), 'the pair');
  assert(!reports[0].includes('pairs as last read'), 'read fresh');
  assertEquals(trace.snapshot().failure, 'direct-failed', 'the failure is shown');
  pc.close();
  await settle();
  assertEquals(warnings.filter(w => w.includes('the direct connection failed')).length, 2, 'only the old warning and the one report');
  trace.close();
});

Deno.test('an attempt closed before it connected logs the report from its last reading', async () => {
  // Setup: as above.
  // Test: set the phone's description (the first reading of the pairs happens then), leave it
  // checking, and close it the way Trystero does when its ~23 s run out (no state event).
  // Verifies: the close is reported as "closed by Trystero before it connected", with the pairs
  // from the last reading, marked as such (getStats fails once closed). An attempt that came up
  // and later closes reports nothing.
  const { trace, warnings } = traceWith(fakePeerConnectionClass(failedStats()));
  const pc = new trace.rtcPolyfill({});
  await pc.setRemoteDescription({ type: 'offer', sdp: '' });
  await settle();
  pc.go('checking', 'connecting');
  pc.close();
  await settle();
  const report = warnings.find(w => w.includes('closed by Trystero before it connected'));
  assert(report, `the report: ${warnings}`);
  assert(report.includes('pairs as last read while it was trying') && report.includes('checks sent 12'), 'the last reading');

  const up = new trace.rtcPolyfill({});
  await up.setRemoteDescription({ type: 'answer', sdp: '' });
  up.go('connected', 'connected');
  const before = warnings.length;
  up.close();
  await settle();
  assertEquals(warnings.length, before, 'a connection that was up reports nothing on close');
  trace.close();
});
