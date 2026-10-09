/*
 * scan_vision_test.js -- the phone vision's message and its trip over the connection (T-0326):
 * src/web/src/lib/scan_vision.js.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * What is tested here, with no browser and no network:
 *   - makeVisionMessage: a phone's results become a small message, rounded, with the outline
 *     simplified to at most 64 points that stay on the original's shape;
 *   - validateVisionMessage: everything the phone can send comes through unchanged, and anything
 *     else -- another version, a request, NaN, Infinity, out-of-range numbers, wrong types, huge
 *     arrays, extra fields -- is refused or stripped, without ever throwing;
 *   - createSendThrottle: at most one send per interval, the latest message always going out;
 *   - phoneVisionChannel / studioVisionChannel on a FAKE Trystero room (an object with the same
 *     makeAction shape, whose sends are recorded and whose deliveries the test makes): the phone
 *     sends nothing until the computer has asked, sends only to the computer that asked, and the
 *     studio passes on only valid messages, at most one per 40 ms.
 * The real Trystero connection between a phone page and the studio is
 * tests/harness/test_scan_vision.py's.
 */

import {
  createSendThrottle,
  makeVisionMessage,
  MAX_RECEIVED_POINTS,
  MAX_SENT_POINTS,
  phoneVisionChannel,
  RECEIVE_INTERVAL_MS,
  simplifyContour,
  studioVisionChannel,
  validateVisionMessage,
  VISION_ACTION,
  VISION_REQUEST,
} from '../src/lib/scan_vision.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

// --- fixtures -------------------------------------------------------------------------------------

/** An ellipse of `n` points, as outline.js traces a rock: a closed polygon, many points. */
function ellipse(n, cx = 640, cy = 360, a = 120, b = 80) {
  return Array.from({ length: n }, (_, k) => {
    const t = (2 * Math.PI * k) / n;
    return [cx + a * Math.cos(t), cy + b * Math.sin(t)];
  });
}

/** The parts of one processed frame, shaped as live.js returns them. */
function frameParts() {
  const contour = ellipse(400);
  return {
    frame: { width: 1280, height: 720, timeMs: 12345.678 },
    detection: { recognised: true, corners: new Array(57).fill({}), markers: new Array(30).fill({}) },
    pose: {
      R: [0.70710678, -0.70710678, 0, -0.5, -0.5, -0.70710678, 0.5, 0.5, -0.70710678],
      t: [12.3456, -7.891, 301.2345],
      center: [85.1234, 115.9876, 212.3456],
      azimuthDeg: 45.12345,
      elevationDeg: 44.98765,
      distanceMm: 300.12345,
      rmsPx: 0.4321,
      valid: true,
      intrinsics: { width: 1280, height: 720, f: 1088.1234, cx: 640, cy: 360, k1: 0.012345, source: 'closed-form' },
    },
    intrinsics: { width: 1280, height: 720, f: 1088.1234, cx: 640, cy: 360, k1: 0.012345, source: 'closed-form' },
    outline: {
      frame: { timeMs: 12300 },
      contour,
      box: { x: 520, y: 280, width: 240, height: 160 },
      confidence: 0.8765,
      flags: ['touches_crop_edge'],
    },
    sheet: { name: 'charuco_23x17_10mm_strip', targetMm: [80, 110], sizeMm: [170, 230] },
  };
}

/** The largest distance from any of `points` to the polygon `polygon`'s edges. */
function maxDistanceToPolygon(points, polygon) {
  const segment = (p, a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
  };
  let worst = 0;

  for (const p of points) {
    let best = Infinity;

    for (let i = 0; i < polygon.length; i += 1) {
      best = Math.min(best, segment(p, polygon[i], polygon[(i + 1) % polygon.length]));
    }

    worst = Math.max(worst, best);
  }

  return worst;
}

// --- making a message -----------------------------------------------------------------------------

Deno.test('makeVisionMessage: one frame becomes a small, rounded, versioned message', () => {
  // Setup: one frame's results as the phone has them, with a 400-point rock outline.
  // Test: make its message and serialise it as Trystero does (JSON).
  // Verifies: the version and every header field; numbers rounded (R to 1e-6, t to 0.01 mm,
  // angles to 0.01 deg); the outline cut to at most 64 points; counts, not positions, for the
  // board; and the whole message under 1.6 kB, so ten a second is ~16 kB/s.
  const message = makeVisionMessage(frameParts());
  const json = JSON.stringify(message);

  assertEqual(message.v, 1, 'version');
  assertEqual(message.frame, { w: 1280, h: 720 }, 'frame size');
  assertEqual(message.timeMs, 12345.7, 'time rounded to 0.1 ms');
  assertEqual(message.board, {
    recognised: true, corners: 57, markers: 30, sheet: 'charuco_23x17_10mm_strip', sheetFrom: 'default',
    targetMm: [80, 110], sizeMm: [170, 230],
  }, 'board summary');
  assertEqual(message.pose.t, [12.35, -7.89, 301.23], 't rounded to 0.01 mm');
  assertEqual(message.pose.R[0], 0.707107, 'R rounded to 1e-6');
  assertEqual(message.pose.azimuthDeg, 45.12, 'azimuth rounded');
  assertEqual(message.intrinsics, { f: 1088.12, cx: 640, cy: 360, k1: 0.01235, source: 'closed-form' }, 'intrinsics');
  assert(message.outline.contour.length <= MAX_SENT_POINTS, `outline has ${message.outline.contour.length} points`);
  assertEqual(message.outline.box, [520, 280, 240, 160], 'outline box');
  assertEqual(message.outline.timeMs, 12300, 'the outline keeps its own frame time');
  assert(json.length < 1600, `message is ${json.length} bytes`);
});

Deno.test('makeVisionMessage: a frame without a board has no pose and no outline', () => {
  // Setup: a frame where nothing was found (no detection, pose, intrinsics, outline or sheet).
  // Verifies: the message is still well formed -- board not recognised, zero counts, nulls for
  // the rest -- and the studio's validation accepts it (an empty frame is news too: "not in view").
  const message = makeVisionMessage({ frame: { width: 640, height: 480, timeMs: 1 } });

  assertEqual(message.board.recognised, false, 'not recognised');
  assertEqual([message.pose, message.intrinsics, message.outline], [null, null, null], 'nothing else');
  assert(validateVisionMessage(JSON.parse(JSON.stringify(message))) !== null, 'it validates');
});

Deno.test('simplifyContour: at most 64 points, within 1.5 px of the original shape', () => {
  // Setup: rock-like outlines of 64, 400 and 2000 points (ellipses, and a lumpy one).
  // Test: simplify each.
  // Verifies: a contour already short enough is returned unchanged; longer ones come back with at
  // most 64 points, every original point within 1.5 px of the simplified polygon, and the
  // simplified points all taken from the original (Douglas-Peucker keeps vertices).
  const short = ellipse(64);
  assertEqual(simplifyContour(short), short, 'a short contour is unchanged');

  const lumpy = Array.from({ length: 2000 }, (_, k) => {
    const t = (2 * Math.PI * k) / 2000;
    const r = 150 + 20 * Math.sin(5 * t) + 6 * Math.sin(17 * t);
    return [500 + r * Math.cos(t), 400 + 0.7 * r * Math.sin(t)];
  });

  for (const contour of [ellipse(400), ellipse(2000, 300, 300, 40, 25), lumpy]) {
    const simple = simplifyContour(contour);
    const keys = new Set(contour.map(([x, y]) => `${x},${y}`));

    assert(simple.length <= MAX_SENT_POINTS && simple.length >= 3, `${simple.length} points`);
    assert(simple.every(([x, y]) => keys.has(`${x},${y}`)), 'every kept point is an original vertex');
    const error = maxDistanceToPolygon(contour, simple);
    assert(error <= 1.5, `max deviation ${error.toFixed(2)} px`);
  }
});

// --- checking a message ---------------------------------------------------------------------------

Deno.test('validateVisionMessage: a phone message comes through as it was sent', () => {
  // Setup: a full message, through JSON as the data channel carries it.
  // Verifies: the validated copy equals what was sent, field for field, and is a new object (the
  // studio never keeps the peer's own objects).
  const sent = JSON.parse(JSON.stringify(makeVisionMessage(frameParts())));
  const checked = validateVisionMessage(sent);

  assertEqual(checked, sent, 'unchanged');
  assert(checked !== sent && checked.pose !== sent.pose && checked.outline.contour !== sent.outline.contour, 'copied');
});

Deno.test('the optional guide (T-0331): sent rounded, read back, a bad one dropped on its own', () => {
  // Setup: the same frame with the scan guide as live.js gives it (the camera seen from the rock,
  // the rock found from views, the coverage masks) and the warning the phone shows ('focus').
  // Test: make the message, pass it through JSON and the validation; then spoil the guide in one way
  // at a time.
  // Verifies: the guide arrives rounded (angles to 0.1 degree), with the four masks and the warning;
  // the message stays version 1 and under 1.8 kB; a frame whose guide has no view (no pose) sends
  // none; a malformed guide (an unknown warning, a fifth mask, a mask over 12 bits, NaN, a string
  // rockFrom) is dropped while the rest of the message is kept; a message with no guide (an older
  // phone) validates as before.
  const guide = {
    view: { azimuthDeg: 123.456, elevationDeg: 34.567, distanceMm: 181.234 }, rockMm: [80.123, 110.456, 4.789],
    rockFrom: 'views', cover: [0, 0b111111, 0b11, 0],
  };
  const sent = JSON.parse(JSON.stringify(makeVisionMessage({ ...frameParts(), guide, warning: 'focus' })));
  assertEqual(sent.guide, {
    azimuthDeg: 123.5, elevationDeg: 34.6, distanceMm: 181.2, rockMm: [80.12, 110.46, 4.79], rockFrom: 'views',
    cover: [0, 63, 3, 0], warning: 'focus',
  }, 'the guide as sent');
  assert(sent.v === 1 && JSON.stringify(sent).length < 1800, 'still version 1, still small');
  assertEqual(validateVisionMessage(sent).guide, sent.guide, 'read back');
  assert(!('guide' in makeVisionMessage({ ...frameParts(), guide: { ...guide, view: null } })), 'no view, no guide');

  for (const bad of [{ warning: 'run' }, { cover: [0, 0, 0, 0, 0] }, { cover: [4096, 0, 0, 0] }, { azimuthDeg: null }, { rockFrom: 'guess' }]) {
    const checked = validateVisionMessage({ ...sent, guide: { ...sent.guide, ...bad } });
    assert(checked && checked.pose && !('guide' in checked), `bad guide ${JSON.stringify(bad)} dropped, message kept`);
  }

  const { guide: _, ...older } = sent;
  assert(validateVisionMessage(older) && !('guide' in validateVisionMessage(older)), 'an older phone: no guide');
});

Deno.test('the optional wrongBoard flag (T-0335), and older phones\' sheets, still validate', () => {
  // Setup: the frame's message made with wrongBoard true (the phone sees another ChArUco board, so
  // it has no pose), and without it; and a message as a phone from before T-0335 sent it: another
  // sheet's name ('charuco_23x17_10mm_centre3x3_dots', recognised 'auto', its 85, 115 target).
  // Test: make, pass through JSON and validate each; then spoil the flag (a string, a number,
  // false).
  // Verifies: the flag is sent only when true and read back as true; a message without it has none
  // (the flag is optional, the message still version 1); a spoiled flag is dropped on its own, the
  // rest of the message kept; and an older phone's message, with its sheet name and origin, is
  // accepted unchanged, so a phone that has not reloaded keeps working with this studio.
  const wrong = JSON.parse(JSON.stringify(makeVisionMessage({ ...frameParts(), pose: null, outline: null, wrongBoard: true })));
  assertEqual(wrong.board.wrongBoard, true, 'sent');
  assert(wrong.v === 1, 'still version 1');
  assertEqual(validateVisionMessage(wrong).board.wrongBoard, true, 'read back');

  const right = JSON.parse(JSON.stringify(makeVisionMessage(frameParts())));
  assert(!('wrongBoard' in right.board) && !('wrongBoard' in validateVisionMessage(right).board), 'no flag on our board');

  for (const bad of ['yes', 1, false]) {
    const checked = validateVisionMessage({ ...wrong, board: { ...wrong.board, wrongBoard: bad } });
    assert(checked && !('wrongBoard' in checked.board) && checked.board.recognised, `flag ${JSON.stringify(bad)} dropped, message kept`);
  }

  const older = { ...right, board: { ...right.board, sheet: 'charuco_23x17_10mm_centre3x3_dots', sheetFrom: 'auto', targetMm: [85, 115] } };
  assertEqual(validateVisionMessage(older), older, 'an older phone\'s sheet');
  assert(validateVisionMessage({ ...older, board: { ...older.board, sheetFrom: 'chosen' } }), 'a sheet chosen on an older phone');
});

Deno.test('the optional speed (T-0332): sent as given, read back, a bad one dropped on its own', () => {
  // Setup: the phone's speed as vision/latency.js speedForMessage makes it (poses a second, the
  // overlay's age at display, the detection's and the whole frame's median ms).
  // Test: make the message with it, pass it through JSON and the validation; then spoil it one way
  // at a time; then add an unknown field.
  // Verifies: the speed arrives unchanged and the message stays version 1 and small; an empty speed
  // sends nothing; a negative, NaN (null in JSON), string or absurd value drops the speed while the
  // rest of the message (the pose) is kept; an unknown field is stripped, not passed on; a message
  // without a speed (an older phone) has none.
  const speed = { posesPerS: 10.4, trackedPerS: 0, resultsPerS: 10.4, ageMs: 100, ageP90Ms: 134, detectMs: 25.7, frameMs: 43.2 };
  const sent = JSON.parse(JSON.stringify(makeVisionMessage({ ...frameParts(), speed })));
  assertEqual(sent.speed, speed, 'the speed as sent');
  assert(sent.v === 1 && JSON.stringify(sent).length < 1800, 'still version 1, still small');
  assertEqual(validateVisionMessage(sent).speed, speed, 'read back');
  assert(!('speed' in makeVisionMessage({ ...frameParts(), speed: {} })), 'an empty speed is not sent');

  for (const bad of [{ ageMs: -1 }, { posesPerS: null }, { detectMs: '25' }, { ageMs: 1e9 }]) {
    const checked = validateVisionMessage({ ...sent, speed: { ...sent.speed, ...bad } });
    assert(checked && checked.pose && !('speed' in checked), `bad speed ${JSON.stringify(bad)} dropped, message kept`);
  }

  assertEqual(validateVisionMessage({ ...sent, speed: { ageMs: 80, secret: 1 } }).speed, { ageMs: 80 }, 'unknown fields stripped');
  const { speed: _, ...older } = sent;
  assert(!('speed' in validateVisionMessage(older)), 'an older phone: no speed');
});

Deno.test('validateVisionMessage: refuses anything malformed, never throws, strips extra fields', () => {
  // Setup: a good message, then one mutation at a time: each a way a buggy or hostile peer could
  // break the studio (NaN or Infinity in the pose, wrong types, huge or short arrays, numbers out
  // of any physical range, another version, the studio's own request echoed back, non-objects,
  // getters that throw).
  // Verifies: every mutation is refused (null) without an exception; and unknown fields on a good
  // message are dropped, not passed on.
  const good = () => JSON.parse(JSON.stringify(makeVisionMessage(frameParts())));
  const mutations = {
    'version 2': (m) => { m.v = 2; },
    'no version': (m) => { delete m.v; },
    'NaN in R': (m) => { m.pose.R[4] = NaN; },
    'Infinity in t': (m) => { m.pose.t[2] = Infinity; },
    'R entry out of range': (m) => { m.pose.R[0] = 3; },
    'R too short': (m) => { m.pose.R = m.pose.R.slice(0, 8); },
    'string distance': (m) => { m.pose.distanceMm = '300'; },
    'elevation over 90': (m) => { m.pose.elevationDeg = 91; },
    'negative distance': (m) => { m.pose.distanceMm = -1; },
    'valid not a boolean': (m) => { m.pose.valid = 1; },
    'frame width zero': (m) => { m.frame.w = 0; },
    'frame width fractional': (m) => { m.frame.w = 1280.5; },
    'frame enormous': (m) => { m.frame.h = 1e9; },
    'unknown intrinsics source': (m) => { m.intrinsics.source = 'magic'; },
    'focal length zero': (m) => { m.intrinsics.f = 0; },
    'too many outline points': (m) => { m.outline.contour = ellipse(MAX_RECEIVED_POINTS + 1); },
    'outline of two points': (m) => { m.outline.contour = m.outline.contour.slice(0, 2); },
    'outline point far outside the frame': (m) => { m.outline.contour[3] = [1e7, 0]; },
    'outline point not a pair': (m) => { m.outline.contour[3] = [1, 2, 3]; },
    'confidence over 1': (m) => { m.outline.confidence = 1.5; },
    'a flag with markup': (m) => { m.outline.flags = ['<img onerror=x>']; },
    'too many flags': (m) => { m.outline.flags = new Array(9).fill('no_rock'); },
    'a sheet name with markup': (m) => { m.board.sheet = '<b>x</b>'; },
    'unknown sheet origin': (m) => { m.board.sheetFrom = 'guessed'; },
    'corner count negative': (m) => { m.board.corners = -1; },
    'target missing': (m) => { delete m.board.targetMm; },
    'board missing': (m) => { delete m.board; },
  };

  for (const [name, mutate] of Object.entries(mutations)) {
    const message = good();
    mutate(message);
    assertEqual(validateVisionMessage(message), null, name);
  }

  for (const junk of [null, undefined, 0, 'vision', [], [1, 2], { ...VISION_REQUEST }, { v: 1 }]) {
    assertEqual(validateVisionMessage(junk), null, `junk ${JSON.stringify(junk)}`);
  }

  const trap = good();
  Object.defineProperty(trap, 'frame', { get() { throw new Error('boom'); } });
  assertEqual(validateVisionMessage(trap), null, 'a throwing getter');

  const extra = good();
  extra.script = 'alert(1)';
  extra.pose.extra = 1;
  const checked = validateVisionMessage(extra);
  assert(checked && !('script' in checked) && !('extra' in checked.pose), 'extra fields dropped');
});

// --- the throttle ---------------------------------------------------------------------------------

/** A fake clock and timer queue, advanced by the test. */
function fakeClock() {
  let time = 0;
  let timers = [];
  let nextId = 1;
  return {
    now: () => time,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.push({ id, at: time + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers = timers.filter((t) => t.id !== id);
    },
    advance(ms) {
      const end = time + ms;

      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];

        if (!due || due.at > end) {
          break;
        }

        timers.shift();
        time = due.at;
        due.fn();
      }

      time = end;
    },
  };
}

Deno.test('createSendThrottle: at most one send per interval, and the latest always goes', () => {
  // Setup: a throttle at 100 ms on a fake clock, recording what it sends.
  // Test: offer messages 1..30, one every 10 ms (a phone processing 100 frames a second), then
  // wait.
  // Verifies: the first goes at once; afterwards one goes per 100 ms, each the newest offered
  // (intermediate ones are dropped, not queued); the last offered is sent after the burst ends;
  // nothing is sent twice.
  const clock = fakeClock();
  const sent = [];
  const throttle = createSendThrottle((m) => sent.push([clock.now(), m]), { intervalMs: 100, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  for (let i = 1; i <= 30; i += 1) {
    throttle.offer(i);
    clock.advance(10);
  }

  clock.advance(500);
  assertEqual(sent.map(([, m]) => m), [1, 10, 20, 30], 'messages sent');
  assertEqual(sent.map(([t]) => t), [0, 100, 200, 300], 'send times');
});

// --- over a (fake) Trystero room ------------------------------------------------------------------

/**
 * A stand-in for a Trystero room: makeAction returns { send, onMessage } as Trystero 0.25 does;
 * `deliver(data, peerId)` plays a message arriving from a peer; `sent` records every send.
 */
function fakeRoom() {
  const actions = new Map();
  const sent = [];
  return {
    sent,
    makeAction(type) {
      const action = actions.get(type) ?? {
        onMessage: null,
        send: (data, options) => {
          sent.push({ type, data, target: options?.target });
          return Promise.resolve();
        },
      };
      actions.set(type, action);
      return action;
    },
    deliver(data, peerId, type = VISION_ACTION) {
      actions.get(type)?.onMessage?.(data, { peerId });
    },
  };
}

Deno.test('phoneVisionChannel: sends only once the computer has asked, only to it, throttled', () => {
  // Setup: a fake room; the phone's channel with the computer (host) 'computer'; a fake clock.
  // Test: send before any request; then a request from a peer that is not the host; then the
  // host's request, and a burst of messages; then the host changes (a reconnect).
  // Verifies: nothing goes out before the host asks (an older studio never asks, and Trystero
  // would hoard unclaimed messages there); a request from another peer does not count; after the
  // host's request messages go to the host only, at most one per 100 ms; after the host changes,
  // sending stops until the new host asks; close() stops everything.
  const room = fakeRoom();
  const clock = fakeClock();
  let host = 'computer';
  const channel = phoneVisionChannel(room, () => host, { intervalMs: 100, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const message = (i) => ({ v: 1, i });

  channel.send(message(1));
  assertEqual(room.sent.length, 0, 'nothing before a request');

  room.deliver(VISION_REQUEST, 'stranger');
  channel.send(message(2));
  assertEqual(room.sent.length, 0, "a stranger's request does not count");

  room.deliver({ v: 1, want: 'something-else' }, 'computer');
  channel.send(message(3));
  assertEqual(room.sent.length, 0, 'a malformed request does not count');

  room.deliver(VISION_REQUEST, 'computer');
  assert(channel.wanted, 'wanted after the host asked');

  for (let i = 4; i < 14; i += 1) {
    channel.send(message(i));
    clock.advance(25);
  }

  clock.advance(200);
  // Offered at 0, 25, 50, ... ms: 4 goes at once; then the newest offered by 100, 200 and 300 ms.
  assertEqual(room.sent.map((s) => s.data.i), [4, 7, 11, 13], 'throttled to 100 ms, latest last');
  assert(room.sent.every((s) => s.target === 'computer' && s.type === VISION_ACTION), 'to the host only');

  host = 'another-computer';
  channel.send(message(20));
  clock.advance(200);
  assertEqual(room.sent.length, 4, 'nothing to a new host that has not asked');

  room.deliver(VISION_REQUEST, 'another-computer');
  channel.send(message(21));
  channel.close();
  channel.send(message(22));
  clock.advance(200);
  assertEqual(room.sent.map((s) => s.data.i).slice(4), [21], 'the new host, until close()');
});

Deno.test('studioVisionChannel: asks the phone, passes on only valid messages, at most one per 40 ms', () => {
  // Setup: a fake room; the studio's channel with a fake clock, recording what it passes on.
  // Test: request('phone'); deliver a valid message, a malformed one, a valid one too soon after
  // the first, and a valid one after the interval.
  // Verifies: the request is VISION_REQUEST sent to that phone only; a malformed message is
  // dropped; a valid one arriving within 40 ms of the last is dropped (a flooding peer cannot
  // flood the studio); valid ones otherwise arrive validated, with the sender's id.
  const room = fakeRoom();
  let time = 1000;
  const received = [];
  const channel = studioVisionChannel(room, (message, peerId) => received.push({ message, peerId }), { now: () => time });

  channel.request('phone');
  assertEqual(room.sent, [{ type: VISION_ACTION, data: VISION_REQUEST, target: 'phone' }], 'the request');

  const good = JSON.parse(JSON.stringify(makeVisionMessage(frameParts())));
  room.deliver(good, 'phone');
  time += 5;
  room.deliver({ ...good, v: 'one' }, 'phone');
  time += 5;
  room.deliver(good, 'phone');
  time += RECEIVE_INTERVAL_MS;
  room.deliver({ ...good, timeMs: 99 }, 'phone');

  assertEqual(received.length, 2, 'two messages passed on');
  assertEqual(received.map((r) => r.peerId), ['phone', 'phone'], 'with the sender');
  assertEqual(received[1].message.timeMs, 99, 'the later one');
});
