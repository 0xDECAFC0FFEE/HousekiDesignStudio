// The pose the phone's overlay is drawn with (T-0332): steady while the phone is still, close behind
// it while it moves, and carried forward to the moment the frame on screen was taken.
//
// The user, 2026-10-06: "the overlay is lagging". The overlay had been drawn from an exponential
// average of the poses (pose.js createPoseSmoother, time constant 120 ms), so it trailed a moving
// phone by that much on top of the processing time (kb phone-vision-*: ~100 ms on an M1 Pro, an
// estimated 200-350 ms on a phone). An average must lag a moving value; a filter that also tracks
// how fast the pose CHANGES need not. This is an alpha-beta filter with velocity, on the pose as a
// rigid motion, adaptive:
//
//   state: the pose T = (R, t) (board -> camera) and its velocity as a TWIST xi = (w, nu) (rad/s,
//   mm/s): T(t + dt) = exp(dt xi) T, the motion applied on the camera's side. A constant twist is a
//   screw motion: it is exact for an orbit round the rock at a steady rate (the camera turning as it
//   goes round), for a steady pan on the spot and for a straight slide alike. (A constant velocity
//   of the camera's centre is not: measured on the lag video's 40 degree/s swing, its prediction
//   missed by 2-3 px at every measurement, which the filter then took for motion and noise.)
//
//   a measurement T_z at time T_z: carry the state to T_z (T_p), take the residual
//   delta = log(T_z T_p^-1) (a twist), and update
//       T = exp(a delta) T_p,   xi += (b / dt) delta,
//   with b = a^2 / (2 - a) (Benedict-Bordner: no overshoot). An alpha-beta filter follows a
//   constant-velocity motion with no lag at all; only changes of speed show, briefly.
//
//   a, per measurement, from how far the prediction missed on screen: the median pixel distance,
//   over sample board points in the picture, between the measured pose's projection and the
//   predicted one. Within the noise a = ALPHA_MIN: still or steady, so the noise is averaged and
//   the overlay does not shimmer; well beyond it (the phone started, stopped or turned) a = 1: the
//   measurement is taken as it is, and b = 1 resets the velocity from it at once. In between,
//   smoothly. "The noise" is RESIDUAL_LOW_PX x s (s = the frame's short side / 1080) or, for a phone
//   whose poses turn out noisier, a multiple of the misses' own spread, learnt as it goes.
//
// Why one gain for the whole pose: a board point's camera coordinates change to first order linearly
// in the residual twist (dx = w x x + nu), so this is the same linear filter applied to every board
// point's position in the camera: errors the pose solver trades between tilt and position (which
// cancel on screen) stay cancelled.
//
// PREDICTION (predict(timeMs)): the filtered pose carried forward by its twist from the time of the
// frame it was measured on to the time of the frame on screen (latency.js frameTime), so the overlay
// is drawn where the board is in THAT frame, not where it was. Never further ahead than
// MAX_PREDICT_MS: a pose older than that is held there (and the page fades it), rather than flying
// off along an old velocity.
//
// A gap longer than MAX_GAP_MS, a frame older than the last, or a jump of more than MAX_JUMP_PX x s
// on screen starts the filter afresh from the new measurement (velocity zero).
//
// Plain JS on numbers (camera_model.js's rotations and projection): no DOM, no clock; times are
// the frames' own, in ms.

import { cameraCenter, matMul3, projectPoints, rodrigues, rotate, rotationToVector } from './camera_model.js';

/**
 * The gain while the prediction is within the noise (still or steady motion). Tuned by replaying
 * a logged run of the lag video (tests/harness/vision/replay_lag.js) with and without pose noise
 * added: 0.25 averages noise best but works off a leftover velocity after a sudden stop slowly
 * (the overlay creeps for over a second); 0.5 settles fast but lets more noise through.
 */
export const ALPHA_MIN = 0.4;
/** Below this miss (px x s, median over the sample points) the gain is ALPHA_MIN ... */
export const RESIDUAL_LOW_PX = 0.75;
/** ... above this it is 1 (the measurement as it is). */
export const RESIDUAL_HIGH_PX = 4;
/** The furthest a pose is carried forward, ms. */
export const MAX_PREDICT_MS = 200;
/** A gap between measurements longer than this restarts the filter, ms. */
export const MAX_GAP_MS = 500;
/** A miss larger than this (px x s) restarts the filter: a jump, not a motion. */
export const MAX_JUMP_PX = 120;
/** The learnt miss noise sigma widens the thresholds: low >= this x sigma ... */
export const NOISE_LOW_FACTOR = 2.5;
/** ... and high >= low + this x sigma. */
export const NOISE_HIGH_FACTOR = 4;
/** How fast the noise estimate follows (per measurement). */
export const NOISE_RATE = 0.05;
/** The learnt thresholds stay within this multiple of the fixed ones. */
export const NOISE_MAX_SCALE = 4;
/** The velocity gain b is this x Benedict-Bordner's a^2 / (2 - a). */
export const BETA_SCALE = 1;
/** The prediction's deadband: the velocity's displacement over DEADBAND_MS against the noise. */
export const DEADBAND_MS = 100;
export const DEADBAND_LOW = 0.5;
export const DEADBAND_HIGH = 2;
/** The share of the velocity let go per measurement whose miss is within the noise. */
export const STILL_DECAY = 0;
/** Velocities are kept below these (a pose that moved this fast is a misreading). */
export const MAX_ANGULAR_RAD_S = 6;
export const MAX_SPEED_MM_S = 3000;

const transpose3 = (R) => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
const scale3 = (v, k) => [v[0] * k, v[1] * k, v[2] * k];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm3 = (v) => Math.hypot(v[0], v[1], v[2]);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clampNorm = (v, max) => {
  const n = norm3(v);
  return n > max ? scale3(v, max / n) : v;
};

/** t = -R c. */
export function translationFrom(R, c) {
  return scale3(rotate(R, c), -1);
}

/**
 * The coefficients of SE(3)'s exponential for a rotation of angle theta: A = sin(theta) / theta,
 * B = (1 - cos theta) / theta^2, C = (theta - sin theta) / theta^3, by their series near 0.
 */
function seCoefficients(theta) {
  const t2 = theta * theta;

  if (theta < 1e-4) {
    return { A: 1 - t2 / 6, B: 0.5 - t2 / 24, C: 1 / 6 - t2 / 120 };
  }

  return { A: Math.sin(theta) / theta, B: (1 - Math.cos(theta)) / t2, C: (theta - Math.sin(theta)) / (t2 * theta) };
}

/** exp of a twist [wx, wy, wz, nx, ny, nz]: the rigid motion { R, t } (x -> R x + t). */
export function se3Exp(xi) {
  const w = [xi[0], xi[1], xi[2]];
  const nu = [xi[3], xi[4], xi[5]];
  const { B, C } = seCoefficients(norm3(w));
  // t = V nu, V = I + B [w]x + C [w]x^2
  const wn = cross3(w, nu);
  const wwn = cross3(w, wn);
  return { R: rodrigues(w), t: add3(nu, add3(scale3(wn, B), scale3(wwn, C))) };
}

/** log of a rigid motion { R, t }: its twist [w, nu] (rotation angle below pi). */
export function se3Log({ R, t }) {
  const w = rotationToVector(R);
  const theta = norm3(w);
  // nu = V^-1 t, V^-1 = I - [w]x / 2 + D [w]x^2, D = (1 - A / (2 B)) / theta^2
  let D;

  if (theta < 1e-4) {
    D = 1 / 12 + (theta * theta) / 720;
  } else {
    const { A, B } = seCoefficients(theta);
    D = (1 - A / (2 * B)) / (theta * theta);
  }

  const wt = cross3(w, t);
  const wwt = cross3(w, wt);
  return [...w, ...add3(t, add3(scale3(wt, -0.5), scale3(wwt, D)))];
}

/** a then b, as motions applied on the camera's side: b(a(x)) = { R_b R_a, R_b t_a + t_b }. */
export function compose(b, a) {
  return { R: matMul3(b.R, a.R), t: add3(rotate(b.R, a.t), b.t) };
}

/** The motion taking pose a to pose b: b a^-1. */
export function between(b, a) {
  const R = matMul3(b.R, transpose3(a.R));
  return { R, t: sub3(b.t, rotate(R, a.t)) };
}

/** Board points every `stepMm` over a board `sizeMm` ([X, Y]) wide: the filter's sample points. */
export function boardSamplePoints(sizeMm, stepMm = 30) {
  const points = [];

  for (let x = stepMm / 2; x < sizeMm[0]; x += stepMm) {
    for (let y = stepMm / 2; y < sizeMm[1]; y += stepMm) {
      points.push([x, y, 0]);
    }
  }

  return points;
}

/**
 * The median distance (px) between two poses' projections of `points`, over the points the first
 * pose puts inside its frame (all finite ones when none is); null when no point projects.
 */
export function screenDistancePx(a, b, intrinsics, points) {
  const pa = projectPoints(points, a.R, a.t, intrinsics);
  const pb = projectPoints(points, b.R, b.t, intrinsics);
  const width = intrinsics.width ?? 2 * intrinsics.cx;
  const height = intrinsics.height ?? 2 * intrinsics.cy;
  const inside = [];
  const all = [];

  for (let i = 0; i < points.length; i += 1) {
    const d = Math.hypot(pa[2 * i] - pb[2 * i], pa[2 * i + 1] - pb[2 * i + 1]);

    if (!Number.isFinite(d)) {
      continue;
    }

    all.push(d);

    if (pa[2 * i] >= 0 && pa[2 * i] <= width && pa[2 * i + 1] >= 0 && pa[2 * i + 1] <= height) {
      inside.push(d);
    }
  }

  const use = inside.length ? inside : all;

  if (!use.length) {
    return null;
  }

  use.sort((x, y) => x - y);
  return use[use.length >> 1];
}

/** The gain a for a miss of `residualPx` between thresholds lowPx and highPx (see the header). */
export function gainFor(residualPx, { alphaMin = ALPHA_MIN, lowPx = RESIDUAL_LOW_PX, highPx = RESIDUAL_HIGH_PX } = {}) {
  const x = (residualPx - lowPx) / (highPx - lowPx);
  const k = Math.max(0, Math.min(1, x));
  // smoothstep: no kink where the gain starts to rise
  return alphaMin + (1 - alphaMin) * k * k * (3 - 2 * k);
}

/**
 * The overlay's pose filter.
 *
 * @param {object} [options]
 * @param {number[][]} [options.points]  board points (mm) the screen misses are measured at
 *        (default boardSamplePoints of options.sizeMm, or of a 170 x 230 mm board)
 * @param {number} [options.alphaMin], [options.lowPx], [options.highPx], [options.maxPredictMs],
 *        [options.maxGapMs], [options.maxJumpPx], [options.stillDecay], [options.learnNoise]
 *        (true): the constants above
 * @returns {{ update(pose): object, predict(timeMs): object|null, current(): object|null,
 *             reset(): void, readonly state: object|null }}
 *   update takes a VALID CameraPose (types.js: R, t, frame.timeMs, intrinsics) and returns
 *   { residualPx, alpha, restarted }; predict returns a pose to draw: the last measurement's other
 *   fields with the filtered R, t and centre carried to timeMs, plus `predictedMs` (how far it was
 *   carried) and `measuredAtMs` (the last measurement's frame time); current() is predict at the
 *   last measurement's time (the filtered pose, not carried forward).
 */
export function createPoseFilter(options = {}) {
  const points = options.points ?? boardSamplePoints(options.sizeMm ?? [170, 230]);
  const gains = { alphaMin: options.alphaMin ?? ALPHA_MIN, lowPx: options.lowPx ?? RESIDUAL_LOW_PX, highPx: options.highPx ?? RESIDUAL_HIGH_PX };
  const maxPredictMs = options.maxPredictMs ?? MAX_PREDICT_MS;
  const maxGapMs = options.maxGapMs ?? MAX_GAP_MS;
  const maxJumpPx = options.maxJumpPx ?? MAX_JUMP_PX;
  const stillDecay = options.stillDecay ?? STILL_DECAY;
  const learnNoise = options.learnNoise ?? true;
  const betaScale = options.betaScale ?? BETA_SCALE;
  const deadband = options.deadband ?? true;
  let state = null;

  /** The miss thresholds now, px: the fixed ones at scale s, widened by the learnt noise. */
  function thresholds(s) {
    const sigma = learnNoise && state ? Math.sqrt(state.noise2) : 0;
    const lowPx = Math.min(NOISE_MAX_SCALE * gains.lowPx * s, Math.max(gains.lowPx * s, NOISE_LOW_FACTOR * sigma));
    const highPx = Math.min(NOISE_MAX_SCALE * gains.highPx * s, Math.max(gains.highPx * s, lowPx + NOISE_HIGH_FACTOR * sigma));
    return { lowPx, highPx };
  }

  function start(pose, time) {
    // The noise estimate survives a restart (it is the phone's, not the motion's).
    const noise2 = state?.noise2 ?? 0;
    state = { noise2, time, T: { R: pose.R.slice(), t: pose.t.slice() }, xi: [0, 0, 0, 0, 0, 0], pose };
  }

  /** The state's pose carried forward by dt seconds. */
  function carried(dt) {
    return compose(se3Exp(state.xi.map((v) => v * dt)), state.T);
  }

  function update(pose) {
    const time = pose.frame?.timeMs ?? 0;

    if (!state || time - state.time > maxGapMs || time < state.time) {
      start(pose, time);
      return { residualPx: null, alpha: 1, restarted: true };
    }

    const dt = (time - state.time) / 1000;

    if (dt <= 0) {
      // The same frame again: take the newer measurement as it is, keep the velocity.
      state = { ...state, T: { R: pose.R.slice(), t: pose.t.slice() }, pose };
      return { residualPx: 0, alpha: 1, restarted: false };
    }

    const intrinsics = pose.intrinsics;
    const s = intrinsics ? Math.min(intrinsics.width ?? 2 * intrinsics.cx, intrinsics.height ?? 2 * intrinsics.cy) / 1080 : 1;
    const predicted = carried(dt);
    const residualPx = intrinsics ? screenDistancePx(pose, predicted, intrinsics, points) : null;

    if (residualPx === null || residualPx > maxJumpPx * s) {
      start(pose, time);
      return { residualPx, alpha: 1, restarted: true };
    }

    // The misses' own noise, learnt: a slow average of the squared misses that are not motions
    // (below the high threshold as it stands). Its spread widens both thresholds, so a phone whose
    // poses are noisier than the defaults assume is still averaged when still, rather than
    // followed (and extrapolated) noise and all.
    // Bounded: only misses below the FIXED high threshold teach it (a learnt threshold must not
    // widen itself: on the lag video the starts and stops then read as noise, and the filter
    // stopped following them), and the learnt thresholds stay within NOISE_MAX_SCALE x the fixed
    // ones.
    const { lowPx, highPx } = thresholds(s);
    let noise2 = state.noise2;

    if (residualPx < gains.highPx * s) {
      noise2 += NOISE_RATE * (residualPx * residualPx - noise2);
    }

    const alpha = gainFor(residualPx, { alphaMin: gains.alphaMin, lowPx, highPx });
    const beta = (betaScale * alpha * alpha) / (2 - alpha);
    const delta = se3Log(between(pose, predicted));
    // Optionally, within the noise, the velocity is also let down towards zero (stillDecay per
    // measurement), so a leftover velocity after the phone stops is not worked off only at the low
    // gain's pace. Off by default: measured on the lag video, it cost more while moving than it
    // saved when still.
    const decay = residualPx <= lowPx ? 1 - stillDecay : 1;
    const xi = state.xi.map((v, i) => (v + (beta / dt) * delta[i]) * decay);
    state = {
      noise2,
      time,
      T: compose(se3Exp(delta.map((v) => v * alpha)), predicted),
      xi: [...clampNorm(xi.slice(0, 3), MAX_ANGULAR_RAD_S), ...clampNorm(xi.slice(3), MAX_SPEED_MM_S)],
      pose,
    };
    // How far the velocity would carry the picture in DEADBAND_MS, against the noise: the share of
    // the velocity that prediction uses (the deadband, below).
    state.motionPx = screenDistancePx(carried(DEADBAND_MS / 1000), state.T, intrinsics, points) ?? 0;
    state.lowPx = lowPx;
    return { residualPx, alpha, restarted: false };
  }

  /**
   * The share (0..1) of the velocity that prediction carries forward. A velocity that would move the
   * picture by less than DEADBAND_LOW x the noise threshold in DEADBAND_MS is taken as the noise's
   * own (carrying it forward would only make a still overlay shimmer more: measured with pose noise
   * added to the lag video's poses); one that moves it by DEADBAND_HIGH x or more is carried whole.
   */
  function predictShare() {
    if (!deadband || !state.lowPx) {
      return 1;
    }

    const k = Math.max(0, Math.min(1, (state.motionPx - DEADBAND_LOW * state.lowPx) / ((DEADBAND_HIGH - DEADBAND_LOW) * state.lowPx)));
    return k * k * (3 - 2 * k);
  }

  function predict(timeMs) {
    if (!state) {
      return null;
    }

    const ahead = Math.max(0, Math.min(maxPredictMs, timeMs - state.time));
    const { R, t } = carried((ahead / 1000) * predictShare());
    return {
      ...state.pose,
      R,
      t,
      center: cameraCenter(R, t),
      predictedMs: ahead,
      measuredAtMs: state.time,
    };
  }

  return {
    update,
    predict,
    current: () => (state ? predict(state.time) : null),
    reset() {
      state = null;
    },
    get state() {
      return state;
    },
  };
}
