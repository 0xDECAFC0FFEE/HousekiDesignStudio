// Camera calibration from board views, for the phone's live intrinsics (T-0324): the desktop scanner
// pipeline's robust calibration (HousekiScanner calibrate.calibrate with dist_terms "k1"), in plain JS.
//
// Model (the desktop's): principal point fixed at the image centre, fx = fy = f, radial k1 only, and
// a pose per view; least squares over every corner's reprojection error. The desktop calls
// cv2.calibrateCameraExtended with CALIB_USE_INTRINSIC_GUESS | CALIB_FIX_ASPECT_RATIO |
// CALIB_FIX_PRINCIPAL_POINT | CALIB_FIX_K2 | CALIB_FIX_K3 | CALIB_ZERO_TANGENT_DIST, then drops
// corners further than max(1.5 px x s, 3 x the view's median error) from their prediction and
// calibrates again, three times.
//
// Why not cv.calibrateCameraExtended: opencv.js 4.x solves its normal equations densely over all
// 6 x views + 2 parameters, so the time grows with the cube of the view count. Measured in Deno on
// an M1 Pro: 1.7 s for one pass over 30 views, ~33 s over 60 (OpenCV 5's rewrite, which the desktop
// uses, does not have this). Here each view's 6 pose parameters are eliminated per iteration (a
// Schur complement onto f and k1), so an iteration costs time proportional to the corner count:
// milliseconds. The tests check it against cv.calibrateCameraExtended on small sets and against
// the desktop's own calibrate() on real views.
//
// It runs as a generator that yields between the pieces of each Levenberg-Marquardt iteration
// (linearising, each damped step tried) and every 8 views' first poses, so a caller can spread a
// calibration over many short ticks (under ~15 ms each on an M1 Pro for 60 views and 6000
// corners) and never hold up a camera frame for long.

import { linearisePoint, matMul3, median, pixelScale, projectPoints, rodrigues, solveLinear } from './camera_model.js';
import { initialPose } from './pose.js';

export const CALIB_PASSES = 3;
export const MAX_ITERATIONS = 100;

/**
 * The robust calibration: `passes` x (bundle-adjust f, k1 and every view's pose; prune each view's
 * corners). A generator yielding after each LM iteration; its return value is the result, or null
 * when fewer than 3 views have 6 corners left. Views whose pruning leaves fewer than 6 corners sit
 * out the next pass (the desktop never meets this case; OpenCV would need 4).
 *
 * @param cv     opencv.js (for each view's first pose: solvePnP IPPE, via pose.initialPose)
 * @param views  [{ points: [[X, Y, Z] mm], pixels: [[x, y]] }]
 * @param size   { width, height }
 * @param start  { f, k1 } the starting intrinsics
 * @returns { f, k1, rmsPx, fStd, k1Std, perViewRms, points, views, viewIndices, poses, masks,
 *            iterations }  rmsPx as OpenCV's: sqrt(sum of squared errors / corners) over the last
 *            pass's corners (before its pruning, as the desktop reports it)
 */
export function* calibrateSteps(cv, views, size, start, options = {}) {
  const s = pixelScale(size);
  const passes = options.passes ?? CALIB_PASSES;
  const intr = { width: size.width, height: size.height, f: start.f, cx: size.width / 2, cy: size.height / 2, k1: start.k1 ?? 0 };
  const masks = views.map((v) => new Array(v.points.length).fill(true));
  const poses = new Array(views.length).fill(null);
  let result = null;
  let iterations = 0;

  for (let pass = 0; pass < passes; pass += 1) {
    const used = [];
    const data = [];

    for (let j = 0; j < views.length; j += 1) {
      const view = views[j];
      const points = [];
      const pixels = [];
      masks[j].forEach((keep, i) => {
        if (keep) {
          points.push(view.points[i]);
          pixels.push(view.pixels[i]);
        }
      });

      if (points.length < 6) {
        continue;
      }

      // each pass starts every view from a fresh pose with the current intrinsics, as each of the
      // desktop's cv2.calibrateCameraExtended calls does; measured on the spinel fixture, a view
      // stuck at 51 px after the first pass is only recovered that way
      poses[j] = initialPose(cv, points, pixels, intr);

      if (j % 8 === 7) {
        yield { pass, initialPoses: j + 1 };
      }

      if (poses[j]) {
        used.push(j);
        data.push({ points, pixels });
      }
    }

    if (used.length < 3) {
      return null;
    }

    const fit = yield* bundleAdjust(data, used.map((j) => poses[j]), intr, options.maxIterations ?? MAX_ITERATIONS);
    iterations += fit.iterations;
    intr.f = fit.f;
    intr.k1 = fit.k1;
    used.forEach((j, k) => {
      poses[j] = fit.poses[k];
    });

    // prune every corner of every used view against its new prediction (all of the view's
    // corners, masked or not, as the desktop)
    for (const j of used) {
      const view = views[j];
      const p = projectPoints(view.points, poses[j].R, poses[j].t, intr);
      const e = view.pixels.map((q, i) => Math.hypot(p[2 * i] - q[0], p[2 * i + 1] - q[1]));
      const limit = Math.max(1.5 * s, 3 * median(e));
      masks[j] = e.map((x) => x < limit);
    }

    result = {
      f: intr.f,
      k1: intr.k1,
      rmsPx: fit.rms,
      fStd: fit.fStd,
      k1Std: fit.k1Std,
      perViewRms: fit.perViewRms,
      points: used.reduce((sum, j) => sum + masks[j].filter(Boolean).length, 0),
      views: used.length,
      viewIndices: used,
      poses: used.map((j) => poses[j]),
      masks,
      iterations,
    };
  }

  return result;
}

/** Run calibrateSteps to the end at once (tests, tools). */
export function calibrate(cv, views, size, start, options = {}) {
  const steps = calibrateSteps(cv, views, size, start, options);
  let step = steps.next();

  while (!step.done) {
    step = steps.next();
  }

  return step.value;
}

/**
 * Levenberg-Marquardt over f, k1 and every view's pose (rotation updated locally, R <- exp([w]x) R,
 * as camera_model.refinePose). Per iteration, each view's 6 x 6 pose block is eliminated onto the
 * 2 x 2 intrinsics block (Schur complement); Marquardt damping lambda x diag. Stops when a step
 * lowers the cost by less than 1e-12 relative, or after maxIterations. A generator yielding inside
 * each iteration (after linearising, and before each retried damping). Returns { f, k1, poses, rms, perViewRms, fStd, k1Std, iterations }, with the
 * standard deviations as OpenCV's stdDeviationsIntrinsics: sqrt(diag(J^T J)^-1 x sigma^2), sigma^2
 * = squared error / (2 x corners - parameters).
 */
export function* bundleAdjust(data, startPoses, startIntr, maxIterations = MAX_ITERATIONS) {
  const { cx, cy } = startIntr;
  let f = startIntr.f;
  let k1 = startIntr.k1;
  let poses = startPoses.map((p) => ({ R: p.R.slice(), t: p.t.slice() }));
  const nPoints = data.reduce((sum, v) => sum + v.points.length, 0);

  const costOf = (fx, kx, ps) => {
    let c = 0;
    const perView = [];

    data.forEach((view, j) => {
      const p = projectPoints(view.points, ps[j].R, ps[j].t, { f: fx, k1: kx, cx, cy });
      let cj = 0;

      for (let i = 0; i < view.points.length; i += 1) {
        cj += (p[2 * i] - view.pixels[i][0]) ** 2 + (p[2 * i + 1] - view.pixels[i][1]) ** 2;
      }

      perView.push(cj);
      c += cj;
    });

    return { c, perView };
  };

  // the normal equations' blocks at the current parameters
  const jx = new Float64Array(6);
  const jy = new Float64Array(6);
  const linearise = () => {
    const blocks = [];
    const V = new Float64Array(4);
    const bi = new Float64Array(2);

    data.forEach((view, j) => {
      const U = new Float64Array(36);
      const W = new Float64Array(12);    // 6 x 2: pose x (f, k1)
      const bp = new Float64Array(6);
      // the intrinsics' columns: d/df = (u d, v d), d/dk1 = f r^2 (u, v)
      const intrinsicsColumns = (px, py, u, v, r2, d, rx, ry) => {
        const xf = u * d;
        const yf = v * d;
        const xk = f * u * r2;
        const yk = f * v * r2;

        for (let a = 0; a < 6; a += 1) {
          W[a * 2] += px[a] * xf + py[a] * yf;
          W[a * 2 + 1] += px[a] * xk + py[a] * yk;
        }

        V[0] += xf * xf + yf * yf;
        V[1] += xf * xk + yf * yk;
        V[3] += xk * xk + yk * yk;
        bi[0] += xf * rx + yf * ry;
        bi[1] += xk * rx + yk * ry;
      };
      linearisePoint(poses[j].R, poses[j].t, f, k1, cx, cy, view.points, view.pixels, U, bp, jx, jy, intrinsicsColumns);
      blocks.push({ U, W, bp });
    });

    V[2] = V[1];
    return { blocks, V, bi };
  };

  // solve the damped system by eliminating the pose blocks; returns { di, dp[] } or null
  const solveDamped = ({ blocks, V, bi }, lambda) => {
    const S = Float64Array.from(V);
    const rhs = [-bi[0], -bi[1]];
    const parts = [];

    S[0] += lambda * Math.max(V[0], 1e-12);
    S[3] += lambda * Math.max(V[3], 1e-12);

    for (const { U, W, bp } of blocks) {
      const A = Float64Array.from(U);

      for (let a = 0; a < 6; a += 1) {
        A[a * 6 + a] += lambda * Math.max(U[a * 6 + a], 1e-12);
      }

      // U^-1 W (two columns) and U^-1 bp
      const w0 = solveLinear(A, [0, 1, 2, 3, 4, 5].map((a) => W[a * 2]), 6);
      const w1 = solveLinear(A, [0, 1, 2, 3, 4, 5].map((a) => W[a * 2 + 1]), 6);
      const ub = solveLinear(A, Array.from(bp), 6);

      if (!w0 || !w1 || !ub) {
        return null;
      }

      // S -= W^T U^-1 W ; rhs -= W^T U^-1 (-bp) -> rhs += W^T U^-1 bp
      for (let a = 0; a < 6; a += 1) {
        S[0] -= W[a * 2] * w0[a];
        S[1] -= W[a * 2] * w1[a];
        S[2] -= W[a * 2 + 1] * w0[a];
        S[3] -= W[a * 2 + 1] * w1[a];
        rhs[0] += W[a * 2] * ub[a];
        rhs[1] += W[a * 2 + 1] * ub[a];
      }

      parts.push({ A, W, bp, w0, w1, ub });
    }

    const di = solveLinear(S, rhs, 2);

    if (!di) {
      return null;
    }

    // back-substitute: dp = U^-1 (-bp - W di) = -ub - (U^-1 W) di
    const dp = parts.map(({ w0, w1, ub }) => ub.map((v, a) => -v - w0[a] * di[0] - w1[a] * di[1]));
    return { di, dp, S };
  };

  let { c: cost } = costOf(f, k1, poses);
  let lambda = 1e-3;
  let iterations = 0;

  for (; iterations < maxIterations; iterations += 1) {
    const system = linearise();
    let improved = false;
    yield { iteration: iterations, linearised: true };

    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (attempt > 0) {
        yield { iteration: iterations, attempt };
      }

      const step = solveDamped(system, lambda);

      if (!step) {
        lambda *= 10;
        continue;
      }

      const f1 = f + step.di[0];
      const k11 = k1 + step.di[1];
      const poses1 = poses.map((p, j) => ({
        R: matMul3(rodrigues(step.dp[j].slice(0, 3)), p.R),
        t: [p.t[0] + step.dp[j][3], p.t[1] + step.dp[j][4], p.t[2] + step.dp[j][5]],
      }));
      const { c: cost1 } = costOf(f1, k11, poses1);

      if (cost1 < cost) {
        improved = (cost - cost1) / Math.max(cost, 1e-300) > 1e-12;
        f = f1;
        k1 = k11;
        poses = poses1;
        cost = cost1;
        lambda = Math.max(lambda / 10, 1e-12);
        break;
      }

      lambda *= 10;
    }

    if (!improved) {
      break;
    }

    yield { iteration: iterations, f, k1, cost };
  }

  // statistics at the solution: the undamped Schur complement is the intrinsics' block of J^T J's
  // inverse, inverted
  const final = costOf(f, k1, poses);
  const parameters = 6 * data.length + 2;
  const sigma2 = final.c / Math.max(1, 2 * nPoints - parameters);
  const S = solveDamped(linearise(), 0)?.S;
  let fStd = NaN;
  let k1Std = NaN;

  if (S) {
    const det = S[0] * S[3] - S[1] * S[2];
    fStd = Math.sqrt((S[3] / det) * sigma2);
    k1Std = Math.sqrt((S[0] / det) * sigma2);
  }

  return {
    f,
    k1,
    poses,
    rms: Math.sqrt(final.c / nPoints),
    perViewRms: final.perView.map((c, j) => Math.sqrt(c / data[j].points.length)),
    fStd,
    k1Std,
    iterations,
  };
}
