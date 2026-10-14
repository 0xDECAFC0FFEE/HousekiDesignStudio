/*
 * scan_resend_test.js -- resending an offer the other device never got (src/web/src/lib/scan_resend.js),
 * T-0349, and its wiring into the trace's relay sockets (scan_trace.js).
 *
 * The user's logs (2026-10-14) showed the computer's offer lost on the way to the phone, and the
 * phone then nudging and announcing for up to a minute while Trystero ignored it. The resender
 * remembers each offer this page sends (and the candidates sent after it for the same offer id),
 * and when the device it went to nudges or announces again through a relay, publishes them again
 * through that relay as fresh events. These tests pin when it does that and when it must not.
 *
 * Nothing here talks to a relay: the "relay socket" is a fake that records what is sent, and
 * Trystero's createEvent is replaced by a fake that wraps the content in a recognisable message,
 * so a resend can be told apart from Trystero's own send.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 */

import { createOfferResender, RESEND_GAP_MS, RESEND_WINDOW_MS } from '../src/lib/scan_resend.js';
import { createScanLog, createScanTrace, roomTopicPlaintext } from '../src/lib/scan_trace.js';
import { trysteroTopic } from '../src/lib/scan_trace_hash.js';

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

// The phone's own topic, as a stand-in for the SHA-1 Trystero would make of it.
const PHONE_TOPIC = 'topic-of-phone1';

/** A relay socket that is open and records what is sent through it. */
function fakeSocket() {
  const sent = [];
  return { readyState: 1, sent, send: data => sent.push(data) };
}

/**
 * A resender for the computer (peer id 'me') on a clock the test moves by hand. Its createEvent
 * makes ["EVENT", { resent: true, tags: [["x", topic]], content }], so a test can read back what
 * was resent and to which topic.
 */
function setUp() {
  let time = 1000;
  const lines = [];
  const resender = createOfferResender({
    selfId: 'me',
    peerTopic: async id => (id === 'phone1' ? PHONE_TOPIC : `topic-of-${id}`),
    createEvent: async (topic, content) => JSON.stringify(['EVENT', { resent: true, tags: [['x', topic]], content }]),
    log: (level, message) => lines.push(message),
    now: () => time,
  });
  return { resender, lines, advance: ms => (time += ms) };
}

/** The event Trystero publishes for a signal from 'me' to the phone's topic. */
const signal = fields => ({ kind: 20002, tags: [['x', PHONE_TOPIC]], content: JSON.stringify({ peerId: 'me', ...fields }) });

/** The contents of what a fake socket was sent by the resender, in order. */
const resent = socket => socket.sent.map(data => JSON.parse(data)[1]).filter(e => e.resent).map(e => JSON.parse(e.content));

Deno.test('a nudge from a device still waiting for our offer resends it, with its candidates, through that relay', async () => {
  // Setup: the computer has sent the phone an offer (offer id O1) and two address candidates for
  // it through relay A, then 3 s pass (more than RESEND_GAP_MS since that send).
  // Test: the phone nudges through relay A.
  // Verifies: the offer and both candidates go out again through relay A's socket, in the order
  // they were first sent, each as a new event (from createEvent) on the phone's topic with the
  // content unchanged; and one log line says why, naming the relay and the candidate count.
  const { resender, lines, advance } = setUp();
  const socket = fakeSocket();
  resender.sent('wss://a', signal({ offerId: 'O1', offer: 'sdp-1' }));
  resender.sent('wss://a', signal({ offerId: 'O1', candidate: 'cand-1' }));
  resender.sent('wss://a', signal({ offerId: 'O1', candidate: 'cand-2' }));
  advance(3000);
  await resender.heard('wss://a', socket, 'phone1', 'nudge');
  assertEquals(resent(socket), [
    { peerId: 'me', offerId: 'O1', offer: 'sdp-1' },
    { peerId: 'me', offerId: 'O1', candidate: 'cand-1' },
    { peerId: 'me', offerId: 'O1', candidate: 'cand-2' },
  ], 'the offer and its candidates, in order');
  assert(socket.sent.every(data => JSON.parse(data)[1].tags[0][1] === PHONE_TOPIC), 'to the phone\'s own topic');
  assertEquals(lines.length, 1, 'one log line');
  assert(/resending the offer to peer phone1 through wss:\/\/a: .*its nudge.*2 address candidates/.test(lines[0]), `the log line: ${lines[0]}`);
});

Deno.test('the same offer is not resent through a relay more often than every RESEND_GAP_MS', async () => {
  // Setup: the computer sent its offer through relay A just now (Trystero's own send).
  // Test: the phone nudges through A at once; then, RESEND_GAP_MS later, twice in a row; then through relay B.
  // Verifies: nothing goes out right after Trystero's own send (it may simply not have arrived
  // yet); the first nudge past the gap resends and the one right after it does not; relay B,
  // where nothing was sent yet, resends at once -- the gap is per relay.
  const { resender, advance } = setUp();
  const a = fakeSocket();
  const b = fakeSocket();
  resender.sent('wss://a', signal({ offerId: 'O1', offer: 'sdp-1' }));
  await resender.heard('wss://a', a, 'phone1', 'nudge');
  assertEquals(resent(a).length, 0, 'not right after Trystero sent it');
  advance(RESEND_GAP_MS);
  await resender.heard('wss://a', a, 'phone1', 'nudge');
  await resender.heard('wss://a', a, 'phone1', 'announcement');
  assertEquals(resent(a).length, 1, 'once past the gap, then not again at once');
  await resender.heard('wss://b', b, 'phone1', 'nudge');
  assertEquals(resent(b).length, 1, 'another relay has its own gap');
});

Deno.test('an answered offer, an offer past RESEND_WINDOW_MS, or a closed socket is never resent', async () => {
  // Setup: three resenders, each with an offer sent to the phone.
  // Test: (1) the phone answers, then nudges; (2) RESEND_WINDOW_MS and a bit pass, then the phone
  // nudges; (3) the phone nudges through a socket that is not open.
  // Verifies: nothing is sent in any case. An answered offer needs nothing; one past the window
  // may already be dropped by Trystero, and the phone would answer a dead offer and then wait on
  // that answer; a socket that is not open cannot carry it.
  const answered = setUp();
  const s1 = fakeSocket();
  answered.resender.sent('wss://a', signal({ offerId: 'O1', offer: 'sdp-1' }));
  answered.advance(3000);
  await answered.resender.answered('phone1');
  await answered.resender.heard('wss://a', s1, 'phone1', 'nudge');
  assertEquals(s1.sent.length, 0, 'answered');

  const expired = setUp();
  const s2 = fakeSocket();
  expired.resender.sent('wss://a', signal({ offerId: 'O1', offer: 'sdp-1' }));
  expired.advance(RESEND_WINDOW_MS + 1);
  await expired.resender.heard('wss://a', s2, 'phone1', 'nudge');
  assertEquals(s2.sent.length, 0, 'past the window');

  const closedSocket = setUp();
  const s3 = { ...fakeSocket(), readyState: 3 };
  closedSocket.resender.sent('wss://a', signal({ offerId: 'O1', offer: 'sdp-1' }));
  closedSocket.advance(3000);
  await closedSocket.resender.heard('wss://a', s3, 'phone1', 'nudge');
  assertEquals(s3.sent.length, 0, 'socket not open');
});

Deno.test('a new offer replaces the old one, and only our own offers to that device are resent', async () => {
  // Setup: the computer sends offer O1 with a candidate, then a new offer O2 (Trystero made a new
  // one); a late candidate for O1 is also sent, and a candidate for O2. Then signals that are not
  // the computer's own offers: the computer's answer to someone else, an offer from another peer
  // id, and a candidate for an offer never seen.
  // Test: 3 s later the phone nudges; another device ('phone2'), to which no offer went, nudges too.
  // Verifies: only O2 and its own candidate are resent (O1's are dropped with it); nothing goes to
  // phone2, which was never offered anything.
  const { resender, advance } = setUp();
  const socket = fakeSocket();
  resender.sent('wss://a', signal({ offerId: 'O1', offer: 'sdp-1' }));
  resender.sent('wss://a', signal({ offerId: 'O1', candidate: 'cand-1' }));
  resender.sent('wss://a', signal({ offerId: 'O2', offer: 'sdp-2' }));
  resender.sent('wss://a', signal({ offerId: 'O1', candidate: 'late-1' }));
  resender.sent('wss://a', signal({ offerId: 'O2', candidate: 'cand-2' }));
  resender.sent('wss://a', { tags: [['x', 'topic-of-phone2']], content: JSON.stringify({ peerId: 'me', offerId: 'X', answer: 'ans' }) });
  resender.sent('wss://a', { tags: [['x', PHONE_TOPIC]], content: JSON.stringify({ peerId: 'other', offerId: 'O3', offer: 'theirs' }) });
  resender.sent('wss://a', signal({ offerId: 'O9', candidate: 'orphan' }));
  advance(3000);
  await resender.heard('wss://a', socket, 'phone1', 'nudge');
  await resender.heard('wss://a', socket, 'phone2', 'nudge');
  assertEquals(resent(socket), [
    { peerId: 'me', offerId: 'O2', offer: 'sdp-2' },
    { peerId: 'me', offerId: 'O2', candidate: 'cand-2' },
  ], 'only the newest offer and its candidate, only to phone1');
});

Deno.test('the trace hands the resender what its relay sockets send and hear', async () => {
  // Setup: a computer trace on one fake relay socket (the trace wraps its send and listens to its
  // messages), with a real resender whose createEvent is faked as in setUp and whose clock the
  // test moves. The topics are the real ones (trysteroTopic of the room and of the phone).
  // Test: Trystero (through the wrapped send) publishes an offer to the phone; 3 s later the
  // phone's nudge arrives on the computer's own topic; then the phone's answer arrives, 3 s pass,
  // and it nudges again.
  // Verifies, end to end through the trace: the first nudge makes the offer go out again through
  // the same socket, and the trace logs that resend like any send ("sent offer"); after the answer
  // a nudge resends nothing.
  let time = 0;
  const lines = [];
  const sink = { info: (...a) => lines.push(a.join(' ')), warn: () => {}, debug: () => {} };
  const log = createScanLog('computer', { sink, now: () => time });
  const plaintext = roomTopicPlaintext('houseki-scanner', 'room1');
  const phoneTopic = await trysteroTopic(`${plaintext}@phone1`);
  const selfTopic = await trysteroTopic(`${plaintext}@me`);
  const listeners = [];
  const sent = [];
  const socket = {
    readyState: 1,
    send: data => sent.push(data),
    addEventListener: (type, fn) => type === 'message' && listeners.push(fn),
  };
  const resender = createOfferResender({
    selfId: 'me',
    peerTopic: id => trysteroTopic(`${plaintext}@${id}`),
    createEvent: async (topic, content) => JSON.stringify(['EVENT', { resent: true, tags: [['x', topic]], content }]),
    log,
    now: () => time,
  });
  let tick = null;
  const trace = createScanTrace({
    role: 'computer', appId: 'houseki-scanner', roomId: 'room1', relayUrls: ['wss://a'],
    getSockets: () => ({ 'wss://a': socket }), selfId: 'me', log, now: () => time,
    setInterval: fn => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {},
    RTCPeerConnection: null,
    resender,
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  tick();
  const fromPhone = fields => listeners.forEach(fn => fn({
    data: JSON.stringify(['EVENT', 'sub', { tags: [['x', selfTopic]], content: JSON.stringify({ peerId: 'phone1', ...fields }) }]),
  }));
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  socket.send(JSON.stringify(['EVENT', { tags: [['x', phoneTopic]], content: JSON.stringify({ peerId: 'me', offerId: 'O1', offer: 'sdp-1' }) }]));
  time += 3000;
  fromPhone({});
  await settle();
  const resends = sent.filter(data => JSON.parse(data)[1].resent);
  assertEquals(resends.length, 1, 'the offer went out again through the same socket');
  assertEquals(JSON.parse(JSON.parse(resends[0])[1].content).offer, 'sdp-1', 'the same offer');
  assertEquals(lines.filter(l => l.includes('sent offer through wss://a')).length, 2, 'the trace logged both sends');

  fromPhone({ offerId: 'O1', answer: 'ans' });
  await settle();
  time += 3000;
  fromPhone({});
  await settle();
  assertEquals(sent.filter(data => JSON.parse(data)[1].resent).length, 1, 'nothing more after the answer');
  trace.close();
});
