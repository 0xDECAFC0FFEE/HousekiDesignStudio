// The board's pose on the frames BETWEEN two full detections (T-0332), from the last pose's corners
// tracked into the new frame with sparse optical flow.
//
// The user, 2026-10-06: "the overlay is lagging". A full detection of a whole-board view takes ~25 ms
// in the phone's Worker on an M1 Pro (an estimated 2-4x that on a phone), so the board's pose came at
// ~10 a second and each was a processing time old when it was drawn. Tracking a few dozen corners
// from one frame to the next costs a few milliseconds, so poses can come with (nearly) every camera
// frame, each only a few milliseconds old.
//
// HOW. After every detection with a valid pose, up to MAX_POINTS of the pose's inlier corners
// (spread over the view) are kept with their positions in that frame. On a following frame the
// Worker hands this module the frame; the wasm FrameTracker (src/vision/flow.rs: pyramidal
// Lucas-Kanade, forward and back) tracks the corners from the last processed frame into it, each
// starting from where the overlay's predicted pose (pose_filter.js, sent by the page) puts it -- a
// chessboard repeats every square, and without that guess a motion of more than half a square would
// land on a neighbouring corner. Then:
//
//   * corners lost, or coming back more than MAX_FB_PX from where they started, are dropped;
//   * the pose is refined from the last one on the tracked corners (camera_model.refinePose, the
//     same Levenberg-Marquardt pose.js uses), the corners further than max(1.5 px x s, 3 x median)
//     from it dropped, and refined again;
//   * it is kept only if it passes pose.js's gates (at least MIN_POINTS corners spanning the board,
//     residual RMS <= 1.5 px x s, camera above the board) AND agrees with the predicted pose: a
//     whole set of corners that slid onto their neighbours would fit just as well, one square off,
//     so the tracked corners may sit no further than MAX_FROM_PREDICTION (a share of a square) from
//     their predicted places;
//   * failing any of it, tracking stops until the next detection; it also stops after MAX_TRACKED
//     frames, so drift cannot build up whatever the detection rate.
//
// Every frame the Worker processes is pushed to the FrameTracker (push), detected or tracked, so
// the "previous frame" is always the last one whose corners are known. Coordinates: the tracker
// works in the processing image's pixels with OpenCV's convention (pixel centres on integers);
// poses and corners outside it are in full-frame pixels with types.js's (+ 0.5, / scale).

import { cornerPoint } from './board_frame.js';
import { cameraCenter, median, pixelScale, projectPoints, refinePose, scaleIntrinsics, spansPlane } from './camera_model.js';

/** Corners tracked at most (spread over the view). */
export const MAX_POINTS = 48;
/** Corners a tracked pose needs (pose.js MIN_POSE_CORNERS). */
export const MIN_POINTS = 8;
/** Forward-backward error (processing px) above which a corner is dropped. */
export const MAX_FB_PX = 0.5;
/** A tracked pose's residual limit, px x s (pose.js FALLBACK_MAX_RMS_PX). */
export const MAX_RMS_PX = 1.5;
/** The pruning floor, px x s, and the median factor (pose.js). */
export const PRUNE_FLOOR_PX = 1.5;
export const PRUNE_MEDIAN_FACTOR = 3;
/** The tracked corners' median distance from their predicted places, as a share of a square's
 *  size on screen, above which the track is taken to have slipped onto other corners. */
export const MAX_FROM_PREDICTION = 0.35;
/** Frames tracked at most after a detection. */
export const MAX_TRACKED = 15;

/**
 * Up to `max` of `items` spread over the picture: a greedy farthest-point pick from the first,
 * by image position. Returns a new array.
 */
export function spreadPick(items, max, position = (item) => [item.x, item.y]) {
  if (items.length <= max) {
    return items.slice();
  }

  const pos = items.map(position);
  const chosen = [0];
  const nearest = pos.map((p) => Math.hypot(p[0] - pos[0][0], p[1] - pos[0][1]));

  while (chosen.length < max) {
    let best = 0;

    for (let i = 1; i < items.length; i += 1) {
      if (nearest[i] > nearest[best]) {
        best = i;
      }
    }

    chosen.push(best);

    for (let i = 0; i < items.length; i += 1) {
      nearest[i] = Math.min(nearest[i], Math.hypot(pos[i][0] - pos[best][0], pos[i][1] - pos[best][1]));
    }
  }

  return chosen.sort((a, b) => a - b).map((i) => items[i]);
}

/**
 * The tracker for one board spec.
 *
 * @param {any} vision  the vision module (vision_wasm.js loadVision): its FrameTracker
 * @param {object} spec  the board's spec (houseki.board.v1): its corners' positions
 * @returns {{ push(image), seed(detection, pose, scale), track(image, scale, frame, intrinsics,
 *             predicted?): object, reset(), dispose(), readonly active: boolean }}
 */
export function createPoseTracker(vision, spec, options = {}) {
  const maxPoints = options.maxPoints ?? MAX_POINTS;
  const maxTracked = options.maxTracked ?? MAX_TRACKED;
  const flow = new vision.FrameTracker();
  const target = spec.target?.centre_mm ?? [0, 0];
  let size = null;
  // { ids, points (processing px), pose: { R, t }, tracked (frames since the detection) } or null
  let state = null;

  /** Pushes a processing image (RGBA or grey); a change of size forgets everything. */
  function push(image) {
    if (!size || size.width !== image.width || size.height !== image.height) {
      flow.clear();
      state = null;
      size = { width: image.width, height: image.height };
    }

    flow.push(image.data, image.width, image.height);
  }

  /**
   * After a detection on the image just pushed: its valid pose's inlier corners become the points
   * to track. `scale`: processing px per frame px.
   */
  function seed(detection, pose, scale) {
    if (!pose?.valid) {
      state = null;
      return;
    }

    const inlier = new Set(pose.inlierIds);
    const corners = detection.corners.filter((c) => inlier.has(c.id) && cornerPoint(spec, c.id));
    const picked = spreadPick(corners, maxPoints);
    state = {
      ids: picked.map((c) => c.id),
      points: picked.map((c) => [c.x * scale - 0.5, c.y * scale - 0.5]),
      pose: { R: pose.R, t: pose.t },
      tracked: 0,
    };
  }

  /**
   * Tracks into the image (already pushed? no: this pushes it) and solves the pose.
   *
   * @param {{ data, width, height }} image  the new frame at the processing size
   * @param {number} scale  processing px per frame px
   * @param {{ width, height, timeMs }} frame
   * @param {object} intrinsics  the current intrinsics (for any frame size: scaled to `frame`)
   * @param {{ R, t }|null} [predicted]  the overlay's predicted pose for this frame
   * @returns {{ pose: object|null, reason: string|null, tracked: number, kept: number, trackMs, poseMs }}
   */
  function track(image, scale, frame, intrinsicsIn, predicted = null) {
    const started = performance.now();
    const had = state;
    push(image);

    if (!had || state !== had || !flow.ready()) {
      state = null;
      return { pose: null, reason: 'nothing to track', tracked: 0, kept: 0, trackMs: performance.now() - started, poseMs: 0 };
    }

    if (had.tracked >= maxTracked) {
      state = null;
      return { pose: null, reason: 'tracked long enough', tracked: 0, kept: 0, trackMs: performance.now() - started, poseMs: 0 };
    }

    let intrinsics = intrinsicsIn;

    if (frame.width !== intrinsics.width || frame.height !== intrinsics.height) {
      intrinsics = scaleIntrinsics(intrinsics, frame);
    }

    const points3d = had.ids.map((id) => cornerPoint(spec, id));
    // Where the prediction puts each corner (processing px), for the guesses and the slip check.
    let expected = null;

    if (predicted && intrinsics) {
      const p = projectPoints(points3d, predicted.R, predicted.t, intrinsics);
      expected = had.ids.map((_, i) => [p[2 * i] * scale - 0.5, p[2 * i + 1] * scale - 0.5]);
    }

    const flat = new Float32Array(had.points.length * 2);
    const guesses = new Float32Array(expected ? had.points.length * 2 : 0);
    had.points.forEach(([x, y], i) => {
      flat[2 * i] = x;
      flat[2 * i + 1] = y;

      if (expected && Number.isFinite(expected[i][0]) && Number.isFinite(expected[i][1])) {
        guesses[2 * i] = expected[i][0] - x;
        guesses[2 * i + 1] = expected[i][1] - y;
      }
    });
    const out = flow.track(flat, guesses);
    const trackMs = performance.now() - started;
    const poseStarted = performance.now();
    const keep = [];

    for (let i = 0; i < had.ids.length; i += 1) {
      if (out[4 * i + 2] === 1 && out[4 * i + 3] <= MAX_FB_PX) {
        keep.push(i);
      }
    }

    const fail = (reason) => {
      state = null;
      return { pose: null, reason, tracked: had.ids.length, kept: keep.length, trackMs, poseMs: performance.now() - poseStarted };
    };

    if (keep.length < MIN_POINTS || !intrinsics) {
      return fail(`${keep.length} corners tracked`);
    }

    // The slip check: a whole set that slid onto neighbouring corners fits the board as well.
    if (expected) {
      const square = squareOnScreenPx(had.pose, intrinsics, points3d, spec.square_mm) * scale;
      const off = median(keep.map((i) => Math.hypot(out[4 * i] - expected[i][0], out[4 * i + 1] - expected[i][1])));

      if (off > MAX_FROM_PREDICTION * square) {
        return fail(`${off.toFixed(1)} px from the prediction (a square is ${square.toFixed(1)} px)`);
      }
    }

    const s = pixelScale(intrinsics);
    let ids = keep;
    let pixels = keep.map((i) => [(out[4 * i] + 0.5) / scale, (out[4 * i + 1] + 0.5) / scale]);
    let objects = keep.map((i) => points3d[i]);
    let fit = refinePose(objects, pixels, had.pose.R, had.pose.t, intrinsics, 20);

    // Prune as pose.js does, then refine once more on what is left.
    const errorsOf = (R, t, pts, pix) => {
      const p = projectPoints(pts, R, t, intrinsics);
      return pix.map((q, i) => Math.hypot(p[2 * i] - q[0], p[2 * i + 1] - q[1]));
    };
    let errors = errorsOf(fit.R, fit.t, objects, pixels);
    const limit = Math.max(PRUNE_FLOOR_PX * s, PRUNE_MEDIAN_FACTOR * median(errors));
    const inside = errors.map((e) => e < limit);

    if (inside.filter(Boolean).length < MIN_POINTS) {
      return fail('corners disagree');
    }

    ids = ids.filter((_, k) => inside[k]);
    pixels = pixels.filter((_, k) => inside[k]);
    objects = objects.filter((_, k) => inside[k]);
    fit = refinePose(objects, pixels, fit.R, fit.t, intrinsics, 20);
    errors = errorsOf(fit.R, fit.t, objects, pixels);
    const rms = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length);
    const center = cameraCenter(fit.R, fit.t);

    if (!(center[2] > 0)) {
      return fail('camera below the board plane');
    }

    if (!(rms <= MAX_RMS_PX * s)) {
      return fail(`high residual (${rms.toFixed(2)} px)`);
    }

    if (!spansPlane(objects, spec.square_mm)) {
      return fail('corners on a line');
    }

    const u = [center[0] - target[0], center[1] - target[1], center[2] - (target[2] ?? 0)];
    const pose = {
      frame: { width: frame.width, height: frame.height, timeMs: frame.timeMs },
      intrinsics,
      R: fit.R,
      t: fit.t,
      center,
      azimuthDeg: ((Math.atan2(u[1], u[0]) * 180) / Math.PI + 360) % 360,
      elevationDeg: (Math.atan2(u[2], Math.hypot(u[0], u[1])) * 180) / Math.PI,
      distanceMm: Math.hypot(...u),
      rmsPx: rms,
      inliers: ids.length,
      corners: had.ids.length,
      inlierIds: ids.map((k) => had.ids[k]),
      valid: true,
      reason: null,
      start: 'tracked',
    };
    // The kept corners, where they are now, are the next frame's points.
    state = {
      ids: ids.map((k) => had.ids[k]),
      points: ids.map((k) => [out[4 * k], out[4 * k + 1]]),
      pose: { R: fit.R, t: fit.t },
      tracked: had.tracked + 1,
    };
    return { pose, reason: null, tracked: had.ids.length, kept: ids.length, trackMs, poseMs: performance.now() - poseStarted };
  }

  return {
    push,
    seed,
    track,
    reset() {
      state = null;
    },
    dispose() {
      flow.free();
    },
    get active() {
      return state !== null;
    },
  };
}

/** The median side of a printed square (`step` mm) on screen (px) around the tracked corners. */
function squareOnScreenPx(pose, intrinsics, points3d, step) {
  const sides = [];
  const pts = [];

  for (const P of points3d.slice(0, 12)) {
    pts.push(P, [P[0] + step, P[1], 0]);
  }

  const p = projectPoints(pts, pose.R, pose.t, intrinsics);

  for (let i = 0; i < pts.length; i += 2) {
    sides.push(Math.hypot(p[2 * i + 2] - p[2 * i], p[2 * i + 3] - p[2 * i + 1]));
  }

  return median(sides.filter(Number.isFinite));
}
