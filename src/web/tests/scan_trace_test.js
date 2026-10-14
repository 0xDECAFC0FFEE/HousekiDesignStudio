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
  candidateInfo, createScanLog, createScanTrace, roomTopicPlaintext, serversReady, signalType, STEPS, stepOf,
  stepText, RELAY_SETTLE_MS,
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

Deno.test('the servers are ready when all are subscribed, or half plus one once the rest have had their chance', () => {
  // Setup: lists of 8 relays in different states, at 2 s and at RELAY_SETTLE_MS into the session.
  // Test: serversReady on each.
  // Verifies the user's rule: all 8 subscribed is ready at once; 5 of 8 (half plus one) is ready
  // only when every other relay has been retried, refused, or given RELAY_SETTLE_MS; 4 of 8 is
  // never enough; an empty list is not ready.
  const all = Array.from({ length: 8 }, () => relay(true));
  assert(serversReady(all, 2000), 'all subscribed');
  const five = [...Array.from({ length: 5 }, () => relay(true)), ...Array.from({ length: 3 }, () => relay(false))];
  assert(!serversReady(five, 2000), '5 of 8 while the rest still have their first try');
  assert(serversReady(five, RELAY_SETTLE_MS), '5 of 8 after the settling time');
  const retried = [...five.slice(0, 5), relay(false, { attempts: 2 }), relay(false, { refused: true }), relay(false, { attempts: 3 })];
  assert(serversReady(retried, 2000), '5 of 8, the rest retried or refused');
  const four = [...Array.from({ length: 4 }, () => relay(true)), ...Array.from({ length: 4 }, () => relay(false, { attempts: 2 }))];
  assert(!serversReady(four, RELAY_SETTLE_MS), '4 of 8 is not enough');
  assert(!serversReady([], 0), 'no relays');
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
  // "Waiting for your phone…" on the computer, "Looking for your computer…" on the phone, ...,
  // "Connected"); a failed direct connection says so and that it is trying again.
  assertEquals(stepText('servers', 'computer', { up: 3, total: 8 }), 'Connecting to the servers… (3 of 8)', 'servers');
  assertEquals(stepText('waiting', 'computer', { up: 8, total: 8 }), 'Waiting for your phone… (8 of 8)', 'waiting, computer');
  assertEquals(stepText('waiting', 'phone', { up: 7, total: 8 }), 'Looking for your computer… (7 of 8)', 'waiting, phone');
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
