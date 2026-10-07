// The camera's pose relative to the printed board, on the phone (T-0324): a BoardDetection plus the
// camera's Intrinsics in, a CameraPose (types.js) out.
//
// This is the desktop scanner pipeline's pose, ported exactly (HousekiScanner
// src/houseki/pipeline/calibrate.py solve_pose, and step1.py pose_frames for the validity gates):
//
//   1. at least MIN_POSE_CORNERS (8) corners, not (nearly) on one line (camera_model.spansPlane);
//   2. cv.solvePnP with SOLVEPNP_IPPE (the planar-target solver) on the corners with Z set to 0;
//   3. three rounds of Levenberg-Marquardt on the inliers (the desktop's cv.solvePnPRefineLM; here
//      camera_model.refinePose, because opencv.js 4.x's stalls on top-down views), each followed by
//      re-projecting EVERY corner and keeping those within max(1.5 px x s, 3 x the median error);
//      fewer than 8 inliers left -> no pose;
//   4. the RMS of the inliers' errors;
//   5. valid when the camera is above the board (centre Z > 0), the RMS is within the limit
//      (1.0 px x s for sharp two-marker corners, 1.5 px x s otherwise) and at least 60% of the
//      corners are inliers.
//
// s is the pixel scale (camera_model.pixelScale: short side / 1080), because the desktop's pixel
// limits were tuned on 1080 x 1920 frames. The desktop works in squares and multiplies by the
// square size afterwards; this works in millimetres throughout, which gives the same pose.
//
// The desktop also learns a per-corner 3D offset of the printed board from a whole capture and
// solves poses against that refined board; a live phone has no such capture, so by default this
// solves against the nominal board. `options.objectPoints` takes a refined board when one exists
// (IPPE then starts from its Z = 0 projection, as the desktop does).
//
// One addition the desktop does not have: a pose that fails its gates (or is not found) is tried
// again from a RANSAC homography's inliers (`start: 'ransac'` on the result), because a few misread
// marker ids can throw IPPE's least-squares start far off. Poses the desktop accepts are unchanged.
//
// OpenCV functions used: solvePnP (SOLVEPNP_IPPE), findHomography (RANSAC, the retry only),
// matFromArray, Mat, Mat.zeros. The LM, rotation vectors and re-projection are plain JS
// (camera_model.js), checked against cv.solvePnPRefineLM, cv.Rodrigues and cv.projectPoints in the
// tests.

import { cornerPoint } from './board_frame.js';
import {
  cameraCenter, median, pixelScale, projectPoints, refinePose, rodrigues, scaleIntrinsics, spansPlane,
} from './camera_model.js';

export const MIN_POSE_CORNERS = 8;
export const PRUNE_FLOOR_PX = 1.5;      // outlier floor, px at s = 1 (calibrate.solve_pose)
export const PRUNE_MEDIAN_FACTOR = 3.0;
export const REFINE_ROUNDS = 3;
export const MAX_POSE_RMS_PX = 1.0;     // step1.MAX_POSE_RMS: sharp corners next to two markers
export const FALLBACK_MAX_RMS_PX = 1.5; // step1.FALLBACK_MAX_RMS: any other corners
export const MIN_INLIER_FRACTION = 0.6; // step1.MIN_INLIER_FRACTION

/**
 * A pose solver for one board.
 *
 * @param cv       opencv.js (needs solvePnP with SOLVEPNP_IPPE, and findHomography with RANSAC)
 * @param spec     a houseki.board.v1 spec (board_frame.js); its target.centre_mm is where azimuth,
 *                 elevation and distance are measured from
 * @param options  {
 *   maxRmsPx: the RMS limit at s = 1 (default FALLBACK_MAX_RMS_PX, 1.5: the phone's corners are not
 *             split by sharpness as the desktop's are; pass MAX_POSE_RMS_PX for the strict limit),
 *   minInlierFraction (0.6), minCorners (8),
 *   objectPoints: Map id -> [X, Y, Z] mm overriding the nominal board (a refined board),
 *   ransacRetry (true): retry a failed pose from a RANSAC start; false is the desktop exactly,
 * }
 * @returns {{ solve(detection, intrinsics, overrides?): CameraPose|null, dispose(): void }}
 *   solve returns null when no pose can be found (too few corners, corners on a line, the solver
 *   failed, or fewer than 8 corners survived the pruning), and otherwise a CameraPose whose `valid`
 *   says whether it passed the gates and whose `reason` (null when valid) says why not; also
 *   `corners` (usable corners given), `inlierIds` and `start` ('ippe' or 'ransac').
 *   `overrides` may change maxRmsPx for one call (e.g. the strict limit for sharp corners).
 */
export function createPoseSolver(cv, spec, options = {}) {
  const maxRmsPx = options.maxRmsPx ?? FALLBACK_MAX_RMS_PX;
  const minInlierFraction = options.minInlierFraction ?? MIN_INLIER_FRACTION;
  const minCorners = Math.max(options.minCorners ?? MIN_POSE_CORNERS, 4);
  const objectPoints = options.objectPoints ?? null;
  const ransacRetry = options.ransacRetry ?? true;
  const target = spec.target?.centre_mm ?? [0, 0];
  const targetPoint = [target[0], target[1], target[2] ?? 0];
  const pointFor = (id) => (objectPoints?.get(id) ?? cornerPoint(spec, id));

  // Small Mats reused by every solve; the corner Mats depend on the corner count and are made per call.
  const K = new cv.Mat(3, 3, cv.CV_64F);
  const dist = cv.Mat.zeros(1, 5, cv.CV_64F);
  const rvec = new cv.Mat(3, 1, cv.CV_64F);
  const tvec = new cv.Mat(3, 1, cv.CV_64F);
  let disposed = false;

  function solve(detection, intrinsicsIn, overrides = {}) {
    if (disposed) {
      throw new Error('pose solver used after dispose()');
    }

    const frame = detection.frame;
    let intrinsics = intrinsicsIn;

    if (frame && (frame.width !== intrinsics.width || frame.height !== intrinsics.height)) {
      intrinsics = scaleIntrinsics(intrinsics, frame);

      if (!intrinsics) {
        return null;    // another aspect ratio: these intrinsics do not describe this frame
      }
    }

    const s = pixelScale(intrinsics);

    // the corners the board knows, each id once (a repeated id is a misread marker: keep the first)
    const seen = new Set();
    const ids = [];
    const points = [];
    const pixels = [];

    for (const corner of detection.corners) {
      const point = pointFor(corner.id);

      if (!point || seen.has(corner.id) || !Number.isFinite(corner.x) || !Number.isFinite(corner.y)) {
        continue;
      }

      seen.add(corner.id);
      ids.push(corner.id);
      points.push(point);
      pixels.push([corner.x, corner.y]);
    }

    const n = points.length;

    if (n < minCorners || !spansPlane(points, spec.square_mm)) {
      return null;
    }

    const limit = (overrides.maxRmsPx ?? maxRmsPx) * s;
    let pose = judge(fitPose(points, pixels, intrinsics, s, null), 'ippe');

    // Not in the desktop pipeline: when that fails on residual or agreement (or finds nothing),
    // gross outliers -- misread marker ids put corners tens of mm from where their id says -- can
    // have thrown IPPE's least-squares start off (75 degrees, synthetically, with 3 misreads in
    // 230 corners). Retry from a RANSAC start; keep it only if it does better. A pose the desktop
    // would accept is never touched, so the port stays exact where the desktop succeeds.
    if (ransacRetry && (!pose || (!pose.valid && pose.reason !== 'camera below the board plane'))) {
      const start = ransacInliers(points, pixels, intrinsics, s);
      const retry = start && judge(fitPose(points, pixels, intrinsics, s, start), 'ransac');

      if (retry && (!pose || retry.valid || retry.rmsPx < pose.rmsPx)) {
        pose = retry;
      }
    }

    return pose;

    function judge(fitted, startedFrom) {
      if (!fitted) {
        return null;
      }

      const { R, t, keep, rms } = fitted;
      const inliers = keep.reduce((sum, k) => sum + (k ? 1 : 0), 0);
      const center = cameraCenter(R, t);
      let reason = null;

      // step1.pose_frames' gates, in its order
      if (center[2] <= 0) {
        reason = 'camera below the board plane';
      } else if (rms > limit) {
        reason = `high residual (${rms.toFixed(2)} px > ${limit.toFixed(2)} px)`;
      } else if (inliers / n < minInlierFraction) {
        reason = `corners disagree (${inliers} of ${n} fit)`;
      }

      const u = [center[0] - targetPoint[0], center[1] - targetPoint[1], center[2] - targetPoint[2]];
      const horizontal = Math.hypot(u[0], u[1]);

      return {
        frame,
        intrinsics,
        R,
        t,
        center,
        // selection.view_angles / coverage.analyse: from +X (down the page) towards +Y (right),
        // counter-clockwise seen from above; elevation above the board plane
        azimuthDeg: ((Math.atan2(u[1], u[0]) * 180) / Math.PI + 360) % 360,
        elevationDeg: (Math.atan2(u[2], horizontal) * 180) / Math.PI,
        distanceMm: Math.hypot(u[0], u[1], u[2]),
        rmsPx: rms,
        inliers,
        corners: n,
        inlierIds: ids.filter((_, i) => keep[i]),
        valid: reason === null,
        reason,
        start: startedFrom,
      };
    }
  }

  // The corners a RANSAC homography (board X/Y -> pixels with k1 removed, 4 px x s) agrees with,
  // as a keep mask, or null when fewer than MIN_POSE_CORNERS agree.
  function ransacInliers(points, pixels, intrinsics, s) {
    const n = points.length;
    const src = new Float64Array(n * 2);
    const dst = new Float64Array(n * 2);
    const { f, cx, cy } = intrinsics;
    const k1 = intrinsics.k1 ?? 0;

    for (let i = 0; i < n; i += 1) {
      src[2 * i] = points[i][0];
      src[2 * i + 1] = points[i][1];
      // undistort: solve x_d = x (1 + k1 |x|^2) for x by fixed-point iteration
      const xd = (pixels[i][0] - cx) / f;
      const yd = (pixels[i][1] - cy) / f;
      let x = xd;
      let y = yd;

      for (let k = 0; k < 5; k += 1) {
        const d = 1 + k1 * (x * x + y * y);
        x = xd / d;
        y = yd / d;
      }

      dst[2 * i] = f * x + cx;
      dst[2 * i + 1] = f * y + cy;
    }

    const srcMat = cv.matFromArray(n, 1, cv.CV_64FC2, src);
    const dstMat = cv.matFromArray(n, 1, cv.CV_64FC2, dst);
    const mask = new cv.Mat();
    let H = null;

    try {
      H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 4 * s, mask);

      if (!H || H.empty() || mask.rows !== n) {
        return null;
      }

      const keep = Array.from(mask.data, (v) => v !== 0);
      return keep.filter(Boolean).length >= MIN_POSE_CORNERS ? keep : null;
    } finally {
      srcMat.delete();
      dstMat.delete();
      mask.delete();
      H?.delete();
    }
  }

  // calibrate.solve_pose: IPPE on the flat board, then 3 x (LM on the inliers, prune all corners).
  // `start` (the RANSAC retry only): the corners IPPE and the first LM round use; the desktop uses
  // all of them.
  function fitPose(points, pixels, intrinsics, s, start) {
    const n = points.length;
    K.data64F.set([intrinsics.f, 0, intrinsics.cx, 0, intrinsics.f, intrinsics.cy, 0, 0, 1]);
    dist.data64F.set([intrinsics.k1 ?? 0, 0, 0, 0, 0]);
    let keep = start ? [...start] : new Array(n).fill(true);
    const first = [];

    for (let i = 0; i < n; i += 1) {
      if (keep[i]) {
        first.push(i);
      }
    }

    const flat = new Float64Array(first.length * 3);
    const pix = new Float64Array(first.length * 2);

    first.forEach((i, j) => {
      flat[3 * j] = points[i][0];
      flat[3 * j + 1] = points[i][1];
      pix[2 * j] = pixels[i][0];
      pix[2 * j + 1] = pixels[i][1];
    });

    const flatMat = cv.matFromArray(first.length, 1, cv.CV_64FC3, flat);
    const pixMat = cv.matFromArray(first.length, 1, cv.CV_64FC2, pix);

    try {
      if (!cv.solvePnP(flatMat, pixMat, K, dist, rvec, tvec, false, cv.SOLVEPNP_IPPE)) {
        return null;
      }
    } finally {
      flatMat.delete();
      pixMat.delete();
    }

    let errors = null;
    let R = rodrigues(Array.from(rvec.data64F));
    let t = Array.from(tvec.data64F);

    for (let round = 0; round < REFINE_ROUNDS; round += 1) {
      const inPoints = [];
      const inPixels = [];

      for (let i = 0; i < n; i += 1) {
        if (keep[i]) {
          inPoints.push(points[i]);
          inPixels.push(pixels[i]);
        }
      }

      // the desktop's cv.solvePnPRefineLM (see camera_model.refinePose for why it is plain JS here)
      ({ R, t } = refinePose(inPoints, inPixels, R, t, intrinsics));
      const projected = projectPoints(points, R, t, intrinsics);
      errors = pixels.map((p, i) => Math.hypot(projected[2 * i] - p[0], projected[2 * i + 1] - p[1]));
      const limit = Math.max(PRUNE_FLOOR_PX * s, PRUNE_MEDIAN_FACTOR * median(errors));
      // NaN (a corner behind the camera) compares false: pruned
      keep = errors.map((e) => e < limit);

      if (keep.filter(Boolean).length < MIN_POSE_CORNERS) {
        return null;
      }
    }

    let sum = 0;
    let count = 0;

    for (let i = 0; i < n; i += 1) {
      if (keep[i]) {
        sum += errors[i] * errors[i];
        count += 1;
      }
    }

    return { R, t, keep, rms: Math.sqrt(sum / count) };
  }

  function dispose() {
    if (!disposed) {
      disposed = true;
      K.delete();
      dist.delete();
      rvec.delete();
      tvec.delete();
    }
  }

  return { solve, dispose };
}

/**
 * A view's pose from all its corners, without pruning or gates: IPPE on the Z = 0 board, then
 * Levenberg-Marquardt (refinePose). calibrate.js starts each view's bundle adjustment from it, as
 * cv.calibrateCamera initialises each view's extrinsics. Returns { R, t } or null.
 */
export function initialPose(cv, points, pixels, intrinsics) {
  const n = points.length;

  if (n < 4) {
    return null;
  }

  const flat = new Float64Array(n * 3);
  const pix = new Float64Array(n * 2);

  for (let i = 0; i < n; i += 1) {
    flat[3 * i] = points[i][0];
    flat[3 * i + 1] = points[i][1];
    pix[2 * i] = pixels[i][0];
    pix[2 * i + 1] = pixels[i][1];
  }

  const mats = [
    cv.matFromArray(n, 1, cv.CV_64FC3, flat),
    cv.matFromArray(n, 1, cv.CV_64FC2, pix),
    cv.matFromArray(3, 3, cv.CV_64F, [intrinsics.f, 0, intrinsics.cx, 0, intrinsics.f, intrinsics.cy, 0, 0, 1]),
    cv.matFromArray(1, 5, cv.CV_64F, [intrinsics.k1 ?? 0, 0, 0, 0, 0]),
    new cv.Mat(),
    new cv.Mat(),
  ];

  try {
    const [o, i, K, dist, rvec, tvec] = mats;

    if (!cv.solvePnP(o, i, K, dist, rvec, tvec, false, cv.SOLVEPNP_IPPE)) {
      return null;
    }

    const { R, t } = refinePose(points, pixels, rodrigues(Array.from(rvec.data64F)), Array.from(tvec.data64F), intrinsics);
    return { R, t };
  } finally {
    mats.forEach((m) => m.delete());
  }
}

/**
 * NOT USED BY THE PHONE SINCE T-0332: the overlay is drawn with pose_filter.js, which does not trail
 * a moving phone as this does (measured on the lag video: 12.5 px median misplacement while moving
 * against 0.5 px). Kept as the "before" in tests/harness/vision/replay_lag.js and the filter's tests.
 *
 * Temporal smoothing of a stream of valid poses for display (never used inside solve, whose output
 * is per frame): an exponential moving average of the rotation (quaternion, normalised lerp) and
 * of the translation, with time constant `timeConstantMs`. A gap longer than `maxGapMs`, or a jump
 * of the camera centre by more than `maxJumpMm`, restarts it from the new pose.
 *
 * @returns {{ update(pose): CameraPose, reset(): void }}  update returns a new CameraPose (the
 *   smoothed R, t, centre, azimuth, elevation and distance; every other field from the input).
 */
export function createPoseSmoother(spec, options = {}) {
  const tau = options.timeConstantMs ?? 120;
  const maxGapMs = options.maxGapMs ?? 500;
  const maxJumpMm = options.maxJumpMm ?? 50;
  const target = spec.target?.centre_mm ?? [0, 0];
  let state = null;

  function update(pose) {
    const time = pose.frame?.timeMs ?? 0;
    const q = quaternionFromRotation(pose.R);

    if (!state || time - state.time > maxGapMs || time < state.time
        || Math.hypot(...pose.center.map((c, i) => c - state.center[i])) > maxJumpMm) {
      state = { time, q, t: [...pose.t], center: [...pose.center] };
    } else {
      const a = 1 - Math.exp(-(time - state.time) / tau);
      // q and -q are the same rotation: blend towards the nearer one
      const sign = q.reduce((sum, v, i) => sum + v * state.q[i], 0) < 0 ? -1 : 1;
      const blended = state.q.map((v, i) => v + a * (sign * q[i] - v));
      const norm = Math.hypot(...blended);
      state.q = blended.map((v) => v / norm);
      state.t = state.t.map((v, i) => v + a * (pose.t[i] - v));
      state.time = time;
    }

    const R = rotationFromQuaternion(state.q);
    const center = cameraCenter(R, state.t);
    state.center = center;
    const u = [center[0] - target[0], center[1] - target[1], center[2] - (target[2] ?? 0)];
    return {
      ...pose,
      R,
      t: [...state.t],
      center,
      azimuthDeg: ((Math.atan2(u[1], u[0]) * 180) / Math.PI + 360) % 360,
      elevationDeg: (Math.atan2(u[2], Math.hypot(u[0], u[1])) * 180) / Math.PI,
      distanceMm: Math.hypot(...u),
    };
  }

  return { update, reset: () => { state = null; } };
}

/** Row-major rotation -> unit quaternion [w, x, y, z]. */
export function quaternionFromRotation(R) {
  const trace = R[0] + R[4] + R[8];
  let q;

  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    q = [0.25 * s, (R[7] - R[5]) / s, (R[2] - R[6]) / s, (R[3] - R[1]) / s];
  } else if (R[0] > R[4] && R[0] > R[8]) {
    const s = 2 * Math.sqrt(1 + R[0] - R[4] - R[8]);
    q = [(R[7] - R[5]) / s, 0.25 * s, (R[1] + R[3]) / s, (R[2] + R[6]) / s];
  } else if (R[4] > R[8]) {
    const s = 2 * Math.sqrt(1 + R[4] - R[0] - R[8]);
    q = [(R[2] - R[6]) / s, (R[1] + R[3]) / s, 0.25 * s, (R[5] + R[7]) / s];
  } else {
    const s = 2 * Math.sqrt(1 + R[8] - R[0] - R[4]);
    q = [(R[3] - R[1]) / s, (R[2] + R[6]) / s, (R[5] + R[7]) / s, 0.25 * s];
  }

  const norm = Math.hypot(...q);
  return q.map((v) => v / norm);
}

/** Unit quaternion [w, x, y, z] -> row-major rotation. */
export function rotationFromQuaternion([w, x, y, z]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/** The angle (degrees) between two rotations (row-major): a test and diagnostics helper. */
export function rotationAngleDeg(Ra, Rb) {
  // ||Ra - Rb||_F = 2 sqrt(2) sin(angle / 2): well conditioned near zero, where the usual
  // acos((trace(Ra Rb^T) - 1) / 2) turns a 1e-10 rounding of R into a 1e-3 degree "difference"
  let sum = 0;

  for (let i = 0; i < 9; i += 1) {
    sum += (Ra[i] - Rb[i]) ** 2;
  }

  return (2 * Math.asin(Math.min(1, Math.sqrt(sum) / (2 * Math.SQRT2))) * 180) / Math.PI;
}
