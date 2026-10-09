// What the phone's vision sends the studio, and how it travels (T-0326, part of T-0322).
//
// The phone page (src/web/scanner) finds the printed board in its camera frames, the camera's
// pose over it and the rock's outline (src/web/src/lib/vision/), draws them over its own view, and
// sends a compact summary to the computer over the session's existing WebRTC connection, as a
// Trystero data-channel message (room.makeAction, action 'vision'). The studio draws the outline
// and the board's axes over the phone's video and shows a readout. Both ends import this file;
// it needs no OpenCV, so the studio's bundle grows only by it.
//
// THE MESSAGE, version 1 (`VISION_VERSION`), about 1-1.5 kB as JSON:
//
//   { v: 1,
//     timeMs,                 the phone's clock (performance.now()) when the frame was taken
//     frame: { w, h },        the phone's camera frame, pixels; every pixel coordinate below is in
//                             it (types.js's convention: origin at the top-left CORNER of the
//                             top-left pixel), whatever size the video reaches the studio at
//     board: { recognised,    enough of the board seen for a pose (types.js BoardDetection)
//              corners,       how many chessboard corners were found (a count, not positions)
//              markers,       how many square codes were read
//              sheet,         the printed board's name: 'charuco_23x17_10mm_strip' since T-0335
//                             (the one board the phone supports); before, one of four sheets the
//                             phone recognised or was told, which an older phone still sends
//              sheetFrom,     'default' since T-0335; before, also 'auto' (recognised from the
//                             frames) or 'chosen' (picked on the phone)
//              targetMm,      [X, Y] the sheet's target centre (where the axes stand), mm
//              sizeMm,        [X, Y] the chessboard's extent, mm (board_frame.boardSizeMm)
//              wrongBoard? }  OPTIONAL (T-0335): true when the markers in view are not laid out as
//                             the scanner's board prints them (another ChArUco board; there is no
//                             pose then). An older phone sends none; anything but true is dropped
//     pose: null | { R, t,    board -> camera, row-major 3x3 and mm (types.js CameraPose)
//                    center,  the camera in the board frame, mm
//                    azimuthDeg, elevationDeg, distanceMm,   from the sheet's target centre
//                    rmsPx, valid },
//     intrinsics: null | { f, cx, cy, k1, source, views? },   types.js Intrinsics, for `frame`
//     outline: null | { contour: [[x, y], ...] (at most MAX_SENT_POINTS, simplified),
//                       box: [x, y, width, height], confidence, flags },
//     guide?: { azimuthDeg, elevationDeg, distanceMm,   OPTIONAL (T-0331), the scan guidance
//               rockMm: [X, Y, Z],    (vision/guidance.js): the camera seen from the rock, the rock's
//               rockFrom,             estimated position ('views': from outlined views; 'target':
//               cover: [4 x 0..4095], not yet, the sheet's target), the coverage (one 12-bit mask
//               warning } }           of 30-degree sectors per elevation band: < 20, 20-40, 40-60,
//                                     > 60 degrees) and the warning the phone shows (null, 'fast',
//                                     'edge', 'focus' or 'glare'). An older phone sends none; a
//                                     malformed one is dropped on its own, the rest of the message kept.
//     speed?: { posesPerS,    OPTIONAL (T-0332), how fast the phone's vision runs over its last
//               trackedPerS,  few seconds (vision/latency.js): poses a second (and how many of them
//               resultsPerS,  came from tracking between detections), frames processed a second,
//               ageMs,        how old the position the phone's overlay is drawn from is when drawn
//               ageP90Ms,     (median and 90th percentile, ms), and the median ms of a board detection, a
//               detectMs,     tracked frame and a whole processed frame. Every field is optional;
//               trackMs,      the studio shows them in a "Speed" row. Dropped on its own when
//               frameMs }     malformed.
//
// The pose is the one solved for the frame `timeMs` names (not smoothed), so the studio sees the
// same numbers the phone measured: from a full detection, or (T-0332) from the board tracked from
// the frame before, between detections, the other parts then the last detection's. The outline
// comes from an earlier frame than the pose when the
// phone finds it only every few frames (its own `timeMs` is `outline.timeMs`).
//
// ASKING FIRST. The phone sends nothing until the studio asks: on receiving the phone's camera,
// the studio sends `{ v: 1, want: 'vision' }` on the same action. A studio built before this
// file never asks, and that matters: Trystero keeps every message for an action nobody has
// registered (actions.mjs: `pendingActionPayloads`), so a phone sending to it regardless would
// grow its memory by ~15 kB a second for as long as the session lasted.
//
// TRUST. The studio never uses what arrives as it is: validateVisionMessage copies the known
// fields into a new object, checks every number is finite and within bounds and every array is
// short, and drops the message otherwise. The phone is the user's own, but the link is a key that
// could have been sent anywhere, and a buggy or older page must not break the studio.

/** The message format this build writes and reads. */
export const VISION_VERSION = 1;

/** Trystero's action name for the messages (at most 32 bytes in Trystero 0.25). */
export const VISION_ACTION = 'vision';

/** What the studio sends to ask a phone for its vision messages. */
export const VISION_REQUEST = Object.freeze({ v: VISION_VERSION, want: 'vision' });

/** The phone sends at most one message per this many ms (about 10 a second). */
export const SEND_INTERVAL_MS = 100;

/** The studio takes at most one message per this many ms; faster ones are dropped. */
export const RECEIVE_INTERVAL_MS = 40;

/** The outline's points as sent: the phone simplifies it to at most this many. */
export const MAX_SENT_POINTS = 64;

/** The most outline points the studio accepts (more than the phone sends, so a later phone can
 *  send a little more without being refused). */
export const MAX_RECEIVED_POINTS = 256;

/** Intrinsics sources (types.js Intrinsics.source). 'one-view' is accepted, though this build sends
 *  it as 'closed-form' (makeVisionMessage), so a later phone may send it as it is. */
const SOURCES = new Set(['guess', 'table', 'one-view', 'closed-form', 'refined']);

/** Where the phone's idea of the sheet came from ('auto' and 'chosen' from phones before T-0335). */
const SHEET_FROM = new Set(['auto', 'chosen', 'default']);

/** Outline flags a phone may send (types.js RockOutline.flags). */
const FLAG_PATTERN = /^[a-z_]{1,32}$/;

/** The guide's warnings (guidance.js WARNINGS ids) and where its rock came from. */
const GUIDE_WARNINGS = new Set(['fast', 'edge', 'focus', 'glare']);
const ROCK_FROM = new Set(['views', 'target']);

/** The speed's fields (T-0332) and their bounds. */
const SPEED_FIELDS = Object.freeze({
  posesPerS: 1000, trackedPerS: 1000, resultsPerS: 1000, ageMs: 60000, ageP90Ms: 60000,
  detectMs: 60000, trackMs: 60000, frameMs: 60000,
});

const round = (value, digits) => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

// --- the phone's side: making a message ------------------------------------------------------

/**
 * The squared distance from p to the segment a-b.
 */
function segmentDistance2(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  let t = length2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

/** Ramer-Douglas-Peucker on an open polyline, tolerance `epsilon` px; keeps both ends. */
function simplifyOpen(points, epsilon) {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const e2 = epsilon * epsilon;

  while (stack.length) {
    const [first, last] = stack.pop();
    let worst = -1;
    let index = -1;

    for (let i = first + 1; i < last; i += 1) {
      const d = segmentDistance2(points[i], points[first], points[last]);

      if (d > worst) {
        worst = d;
        index = i;
      }
    }

    if (index > 0 && worst > e2) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/**
 * A closed polygon simplified to at most `maxPoints` points (Ramer-Douglas-Peucker, the tolerance
 * raised by 20% steps from 0.25 px until it fits), keeping its shape to within that tolerance. The polygon is
 * split at its two points furthest apart, so neither half degenerates.
 *
 * @param {[number, number][]} contour  closed (the last point is not a repeat of the first)
 * @param {number} [maxPoints]
 * @returns {[number, number][]}
 */
export function simplifyContour(contour, maxPoints = MAX_SENT_POINTS) {
  const n = contour.length;

  if (n <= maxPoints) {
    return contour.map(([x, y]) => [x, y]);
  }

  // The point furthest from the first one, then split there: two open halves.
  let far = 0;
  let best = -1;

  for (let i = 1; i < n; i += 1) {
    const d = (contour[i][0] - contour[0][0]) ** 2 + (contour[i][1] - contour[0][1]) ** 2;

    if (d > best) {
      best = d;
      far = i;
    }
  }

  const first = contour.slice(0, far + 1);
  const second = contour.slice(far).concat([contour[0]]);

  for (let epsilon = 0.25; epsilon < 1e6; epsilon *= 1.2) {
    const a = simplifyOpen(first, epsilon);
    const b = simplifyOpen(second, epsilon);
    // b ends with contour[0] (a's first point) and starts with contour[far] (a's last point).
    const polygon = a.concat(b.slice(1, -1));

    if (polygon.length <= maxPoints) {
      return polygon.map(([x, y]) => [x, y]);
    }
  }

  // Unreachable for finite input: at a huge tolerance only the two split points remain.
  return [contour[0], contour[far]].map(([x, y]) => [x, y]);
}

/**
 * The message for one processed frame (see the header). Any part may be missing: a frame with no
 * board has no pose, and the outline is found only every few frames.
 *
 * @param {object} parts
 * @param {{ width: number, height: number, timeMs: number }} parts.frame
 * @param {object|null} [parts.detection]   types.js BoardDetection (only counts are sent)
 * @param {object|null} [parts.pose]        types.js CameraPose
 * @param {object|null} [parts.intrinsics]  types.js Intrinsics
 * @param {object|null} [parts.outline]     types.js RockOutline
 * @param {{ name: string, targetMm?: number[], sizeMm?: number[] }} [parts.sheet]
 * @param {boolean} [parts.wrongBoard]  the markers in view are not our board's (T-0335)
 * @param {{ view: object|null, rockMm, rockFrom, cover }|null} [parts.guide]  the frame's scan guide
 *        (guidance.js observe), sent only when it has a view
 * @param {string|null} [parts.warning]  the warning the phone shows now
 * @param {object|null} [parts.speed]  the phone's speed (vision/latency.js speedForMessage)
 */
export function makeVisionMessage({ frame, detection = null, pose = null, intrinsics = null, outline = null, sheet = null, wrongBoard = false, guide = null, warning = null, speed = null }) {
  const message = {
    v: VISION_VERSION,
    timeMs: round(frame.timeMs ?? 0, 1),
    frame: { w: Math.round(frame.width), h: Math.round(frame.height) },
    board: {
      recognised: Boolean(detection?.recognised),
      corners: detection?.corners?.length ?? 0,
      markers: detection?.markers?.length ?? 0,
      sheet: sheet?.name ?? '',
      sheetFrom: sheet?.from ?? 'default',
      targetMm: (sheet?.targetMm ?? [0, 0]).slice(0, 2).map((v) => round(v, 3)),
      sizeMm: (sheet?.sizeMm ?? [0, 0]).slice(0, 2).map((v) => round(v, 3)),
    },
    pose: null,
    intrinsics: null,
    outline: null,
  };

  if (wrongBoard) {
    message.board.wrongBoard = true;
  }

  if (pose) {
    message.pose = {
      R: pose.R.map((v) => round(v, 6)),
      t: pose.t.map((v) => round(v, 2)),
      center: pose.center.map((v) => round(v, 2)),
      azimuthDeg: round(pose.azimuthDeg, 2),
      elevationDeg: round(pose.elevationDeg, 2),
      distanceMm: round(pose.distanceMm, 2),
      rmsPx: round(pose.rmsPx, 3),
      valid: Boolean(pose.valid),
    };
  }

  const lens = intrinsics ?? pose?.intrinsics ?? null;

  if (lens) {
    message.intrinsics = {
      f: round(lens.f, 2),
      cx: round(lens.cx, 2),
      cy: round(lens.cy, 2),
      k1: round(lens.k1 ?? 0, 5),
      // 'one-view' (T-0336) travels as 'closed-form': a studio built before it refuses a source it
      // does not know, and would drop the whole message; both are a first estimate to the studio.
      source: lens.source === 'one-view' ? 'closed-form' : lens.source,
    };

    if (Number.isInteger(lens.views)) {
      message.intrinsics.views = lens.views;
    }
  }

  if (outline && outline.contour?.length >= 3) {
    const contour = simplifyContour(outline.contour);
    message.outline = {
      timeMs: round(outline.frame?.timeMs ?? frame.timeMs ?? 0, 1),
      contour: contour.map(([x, y]) => [round(x, 1), round(y, 1)]),
      box: [outline.box.x, outline.box.y, outline.box.width, outline.box.height].map((v) => round(v, 1)),
      confidence: round(Math.max(0, Math.min(1, outline.confidence ?? 0)), 3),
      flags: (outline.flags ?? []).filter((f) => FLAG_PATTERN.test(f)).slice(0, 8),
    };
  }

  if (guide?.view) {
    message.guide = {
      azimuthDeg: round(guide.view.azimuthDeg, 1),
      elevationDeg: round(guide.view.elevationDeg, 1),
      distanceMm: round(guide.view.distanceMm, 1),
      rockMm: guide.rockMm.map((v) => round(v, 2)),
      rockFrom: guide.rockFrom,
      cover: guide.cover.map((m) => m & 0xfff),
      warning: GUIDE_WARNINGS.has(warning) ? warning : null,
    };
  }

  const checkedSpeed = validateSpeed(speed);

  if (checkedSpeed) {
    message.speed = checkedSpeed;
  }

  return message;
}

/**
 * A message's speed (T-0332) checked and copied: only the known fields, each a finite number in
 * [0, its bound]; null when it is missing, not an object, has a bad field or has no field at all.
 */
export function validateSpeed(speed) {
  if (!speed || typeof speed !== 'object' || Array.isArray(speed)) {
    return null;
  }

  const out = {};

  for (const [key, bound] of Object.entries(SPEED_FIELDS)) {
    const value = speed[key];

    if (value === undefined) {
      continue;
    }

    if (!within(value, 0, bound)) {
      return null;
    }

    out[key] = value;
  }

  return Object.keys(out).length ? out : null;
}

/** A message's guide checked and copied, or null when it is missing or malformed. */
function validateGuide(guide) {
  if (!guide || typeof guide !== 'object') {
    return null;
  }

  if (!within(guide.azimuthDeg, 0, 360) || !within(guide.elevationDeg, -90, 90) || !within(guide.distanceMm, 0, 1e5)
      || !numbers(guide.rockMm, 3, -1e4, 1e4) || !ROCK_FROM.has(guide.rockFrom)
      || !Array.isArray(guide.cover) || guide.cover.length !== 4 || !guide.cover.every((m) => Number.isInteger(m) && m >= 0 && m <= 0xfff)
      || !(guide.warning === null || GUIDE_WARNINGS.has(guide.warning))) {
    return null;
  }

  return {
    azimuthDeg: guide.azimuthDeg, elevationDeg: guide.elevationDeg, distanceMm: guide.distanceMm,
    rockMm: [...guide.rockMm], rockFrom: guide.rockFrom, cover: [...guide.cover], warning: guide.warning,
  };
}

// --- the studio's side: checking a message ---------------------------------------------------

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const within = (v, lo, hi) => finite(v) && v >= lo && v <= hi;
const numbers = (array, count, lo, hi) => Array.isArray(array) && array.length === count && array.every((v) => within(v, lo, hi));

/**
 * A message from a phone, checked and copied, or null when it is not a version-1 vision message
 * this studio can use (a request, another version, anything malformed). Only the fields in the
 * header are copied; every number must be finite and within generous physical bounds, every
 * array short. Never throws.
 *
 * @param {unknown} raw  whatever Trystero delivered
 * @returns {object|null}
 */
export function validateVisionMessage(raw) {
  try {
    return validate(raw);
  } catch {
    return null;
  }
}

function validate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== VISION_VERSION) {
    return null;
  }

  const { frame, board } = raw;

  if (!within(raw.timeMs, -1e12, 1e12) || !frame || !Number.isInteger(frame.w) || !Number.isInteger(frame.h)
      || !within(frame.w, 16, 16384) || !within(frame.h, 16, 16384)) {
    return null;
  }

  if (!board || typeof board.recognised !== 'boolean' || !Number.isInteger(board.corners) || !within(board.corners, 0, 100000)
      || !Number.isInteger(board.markers) || !within(board.markers, 0, 100000)
      || typeof board.sheet !== 'string' || !/^[a-z0-9_]{0,64}$/.test(board.sheet) || !SHEET_FROM.has(board.sheetFrom)
      || !numbers(board.targetMm, 2, -1e4, 1e4) || !numbers(board.sizeMm, 2, 0, 1e4)) {
    return null;
  }

  const w = frame.w;
  const h = frame.h;
  const message = {
    v: VISION_VERSION,
    timeMs: raw.timeMs,
    frame: { w, h },
    board: {
      recognised: board.recognised, corners: board.corners, markers: board.markers, sheet: board.sheet,
      sheetFrom: board.sheetFrom, targetMm: [...board.targetMm], sizeMm: [...board.sizeMm],
    },
    pose: null,
    intrinsics: null,
    outline: null,
  };

  // Optional (T-0335): kept only as true; anything else is dropped on its own.
  if (board.wrongBoard === true) {
    message.board.wrongBoard = true;
  }

  const { pose } = raw;

  if (pose !== null && pose !== undefined) {
    if (!numbers(pose.R, 9, -1.01, 1.01) || !numbers(pose.t, 3, -1e6, 1e6) || !numbers(pose.center, 3, -1e6, 1e6)
        || !within(pose.azimuthDeg, 0, 360) || !within(pose.elevationDeg, -90, 90) || !within(pose.distanceMm, 0, 1e6)
        || !within(pose.rmsPx, 0, 1e6) || typeof pose.valid !== 'boolean') {
      return null;
    }

    message.pose = {
      R: [...pose.R], t: [...pose.t], center: [...pose.center],
      azimuthDeg: pose.azimuthDeg, elevationDeg: pose.elevationDeg, distanceMm: pose.distanceMm,
      rmsPx: pose.rmsPx, valid: pose.valid,
    };
  }

  const lens = raw.intrinsics;

  if (lens !== null && lens !== undefined) {
    if (!within(lens.f, 1, 1e6) || !within(lens.cx, -w, 2 * w) || !within(lens.cy, -h, 2 * h)
        || !within(lens.k1, -10, 10) || !SOURCES.has(lens.source)
        || (lens.views !== undefined && !(Number.isInteger(lens.views) && within(lens.views, 0, 100000)))) {
      return null;
    }

    message.intrinsics = { f: lens.f, cx: lens.cx, cy: lens.cy, k1: lens.k1, source: lens.source };

    if (lens.views !== undefined) {
      message.intrinsics.views = lens.views;
    }
  }

  const { outline } = raw;

  if (outline !== null && outline !== undefined) {
    const inFrame = (p) => Array.isArray(p) && p.length === 2 && within(p[0], -w, 2 * w) && within(p[1], -h, 2 * h);

    if (!Array.isArray(outline.contour) || outline.contour.length < 3 || outline.contour.length > MAX_RECEIVED_POINTS
        || !outline.contour.every(inFrame) || !numbers(outline.box, 4, -2 * Math.max(w, h), 4 * Math.max(w, h))
        || !within(outline.confidence, 0, 1) || !within(outline.timeMs, -1e12, 1e12)
        || !Array.isArray(outline.flags) || outline.flags.length > 8 || !outline.flags.every((f) => typeof f === 'string' && FLAG_PATTERN.test(f))) {
      return null;
    }

    message.outline = {
      timeMs: outline.timeMs,
      contour: outline.contour.map(([x, y]) => [x, y]),
      box: [...outline.box],
      confidence: outline.confidence,
      flags: [...outline.flags],
    };
  }

  // Optional (T-0331): kept only when well formed; a bad guide does not cost the rest.
  const guide = validateGuide(raw.guide);

  if (guide) {
    message.guide = guide;
  }

  // Optional (T-0332), as the guide.
  const speed = validateSpeed(raw.speed);

  if (speed) {
    message.speed = speed;
  }

  return message;
}

// --- over the connection -----------------------------------------------------------------------

/**
 * Calls `send(message)` at most once per `intervalMs`: a message offered sooner is held, and
 * replaced by any newer one, until the interval is up (so the latest always goes, and none piles
 * up). Returns { offer(message), cancel() }.
 */
export function createSendThrottle(send, { intervalMs = SEND_INTERVAL_MS, now = () => performance.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id) } = {}) {
  let last = -Infinity;
  let pending = null;
  let timer = null;

  const flush = () => {
    timer = null;

    if (pending) {
      const message = pending;
      pending = null;
      last = now();
      send(message);
    }
  };

  return {
    offer(message) {
      pending = message;
      const wait = last + intervalMs - now();

      if (wait <= 0) {
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }

        flush();
      } else if (timer === null) {
        timer = setTimer(flush, wait);
      }
    },
    cancel() {
      pending = null;

      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}

/**
 * The phone's end, on a joined Trystero room: sends vision messages to the computer once the
 * computer has asked for them (see "Asking first"), throttled to one per SEND_INTERVAL_MS.
 *
 * @param {object} room  a Trystero room
 * @param {() => string|null} host  the computer's peer id now, or null
 * @returns {{ send(message): void, close(): void, readonly wanted: boolean }}
 */
export function phoneVisionChannel(room, host, options = {}) {
  const action = room.makeAction(VISION_ACTION);
  let wantedBy = null;
  let closed = false;

  action.onMessage = (data, context) => {
    if (!closed && data && data.v === VISION_VERSION && data.want === 'vision' && context?.peerId) {
      wantedBy = context.peerId;
    }
  };

  const throttle = createSendThrottle((message) => {
    const target = host();

    if (!closed && target && target === wantedBy) {
      action.send(message, { target }).catch(() => {});
    }
  }, options);

  return {
    send(message) {
      if (!closed && wantedBy && wantedBy === host()) {
        throttle.offer(message);
      }
    },
    close() {
      closed = true;
      throttle.cancel();
    },
    get wanted() {
      return Boolean(wantedBy) && wantedBy === host();
    },
  };
}

/**
 * The computer's end, on a joined Trystero room: `request(peerId)` asks that phone for vision
 * messages; each valid one that arrives (at most one per RECEIVE_INTERVAL_MS) is passed to
 * `onMessage(message, peerId)`. Anything that does not validate is dropped silently.
 */
export function studioVisionChannel(room, onMessage, { now = () => performance.now() } = {}) {
  const action = room.makeAction(VISION_ACTION);
  let last = -Infinity;

  action.onMessage = (data, context) => {
    const time = now();

    if (time - last < RECEIVE_INTERVAL_MS) {
      return;
    }

    const message = validateVisionMessage(data);

    if (message) {
      last = time;
      onMessage(message, context?.peerId ?? null);
    }
  };

  return {
    request(peerId) {
      action.send(VISION_REQUEST, { target: peerId }).catch(() => {});
    },
  };
}
