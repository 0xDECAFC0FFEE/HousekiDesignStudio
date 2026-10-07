// The camera model shared by the phone's pose and intrinsics code (T-0324): plain-JS pieces of the
// desktop scanner pipeline's calibration (HousekiScanner src/houseki/pipeline/calibrate.py and
// camera.py), ported so the phone means the same thing by a pose, a residual and a focal length.
//
// Model: OpenCV's pinhole with one radial term, principal point at the image centre, square pixels.
// A board point P (mm, board_frame.js's frame) goes to the camera as x = R P + t, then
//   (x/z, y/z) -> (1 + k1 r^2) (x/z, y/z) -> pixel (f u + cx, f v + cy).
// Pixel coordinates follow types.js: origin at the top-left CORNER of the top-left pixel, so the
// image centre is (width / 2, height / 2). (OpenCV's own convention puts pixel centres on integers;
// the desktop's (w - 1) / 2 is the same physical point.)
//
// Nothing here calls OpenCV except homographyFocal, which takes `cv` as a parameter.

/** Short side (px) of the frames the desktop's pixel constants were tuned on (camera.py). */
export const REF_SHORT_SIDE = 1080;

/**
 * The frame's pixel scale s = short side / 1080 (camera.pixel_scale): every residual limit tuned in
 * pixels on the desktop's 1080 x 1920 reference captures is multiplied by s.
 */
export function pixelScale(size) {
  return Math.min(size.width, size.height) / REF_SHORT_SIDE;
}

export function median(values) {
  if (values.length === 0) {
    return NaN;
  }

  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

/** Rotation vector (axis * angle, rad) -> 3x3 rotation, row-major (OpenCV's Rodrigues). */
export function rodrigues(rvec) {
  const [a, b, c] = rvec;
  const theta = Math.hypot(a, b, c);

  if (theta < 1e-15) {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  const x = a / theta;
  const y = b / theta;
  const z = c / theta;
  const co = Math.cos(theta);
  const si = Math.sin(theta);
  const v = 1 - co;
  return [
    co + x * x * v, x * y * v - z * si, x * z * v + y * si,
    y * x * v + z * si, co + y * y * v, y * z * v - x * si,
    z * x * v - y * si, z * y * v + x * si, co + z * z * v,
  ];
}

/** 3x3 rotation (row-major) -> rotation vector; the inverse of rodrigues for angles in [0, pi). */
export function rotationToVector(R) {
  const cosT = Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2));
  const theta = Math.acos(cosT);

  if (theta < 1e-12) {
    return [0, 0, 0];
  }

  if (Math.PI - theta < 1e-6) {
    // Near a half turn the antisymmetric part vanishes: read the axis from the diagonal.
    const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2));
    const y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)) * (R[1] >= 0 ? 1 : -1);
    const z = Math.sqrt(Math.max(0, (R[8] + 1) / 2)) * (R[2] >= 0 ? 1 : -1);
    return [x * theta, y * theta, z * theta];
  }

  const k = theta / (2 * Math.sin(theta));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

/** R (row-major) times a 3-vector. */
export function rotate(R, p) {
  return [
    R[0] * p[0] + R[1] * p[1] + R[2] * p[2],
    R[3] * p[0] + R[4] * p[1] + R[5] * p[2],
    R[6] * p[0] + R[7] * p[1] + R[8] * p[2],
  ];
}

/** The camera centre in the board frame, -R^T t. */
export function cameraCenter(R, t) {
  return [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
}

/**
 * Project board points (mm) through a pose and intrinsics: the k1-only case of cv.projectPoints.
 * Returns a flat [u0, v0, u1, v1, ...] array; points at or behind the camera get NaN.
 */
export function projectPoints(points, R, t, intrinsics) {
  const { f, cx, cy, k1 } = intrinsics;
  const out = new Float64Array(points.length * 2);

  for (let i = 0; i < points.length; i += 1) {
    const [x, y, z] = rotate(R, points[i]);
    const X = x + t[0];
    const Y = y + t[1];
    const Z = z + t[2];

    if (!(Z > 0)) {
      out[2 * i] = NaN;
      out[2 * i + 1] = NaN;
      continue;
    }

    const u = X / Z;
    const v = Y / Z;
    const d = 1 + k1 * (u * u + v * v);
    out[2 * i] = f * u * d + cx;
    out[2 * i + 1] = f * v * d + cy;
  }

  return out;
}

/**
 * Solve the n x n system A x = b (row-major A, Gaussian elimination with partial pivoting);
 * null when A is singular.
 */
export function solveLinear(A, b, n) {
  const M = A.slice();
  const x = b.slice();

  for (let c = 0; c < n; c += 1) {
    let p = c;

    for (let r = c + 1; r < n; r += 1) {
      if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) {
        p = r;
      }
    }

    if (Math.abs(M[p * n + c]) < 1e-300) {
      return null;
    }

    if (p !== c) {
      for (let k = 0; k < n; k += 1) {
        [M[c * n + k], M[p * n + k]] = [M[p * n + k], M[c * n + k]];
      }

      [x[c], x[p]] = [x[p], x[c]];
    }

    for (let r = c + 1; r < n; r += 1) {
      const factor = M[r * n + c] / M[c * n + c];

      for (let k = c; k < n; k += 1) {
        M[r * n + k] -= factor * M[c * n + k];
      }

      x[r] -= factor * x[c];
    }
  }

  for (let c = n - 1; c >= 0; c -= 1) {
    let s = x[c];

    for (let k = c + 1; k < n; k += 1) {
      s -= M[c * n + k] * x[k];
    }

    x[c] = s / M[c * n + c];
  }

  return x;
}

/**
 * Levenberg-Marquardt refinement of a pose (R, t) to minimise the squared reprojection error of
 * board points through intrinsics (k1 model): what cv.solvePnPRefineLM does, written out because
 * opencv.js 4.x's version stalls when the rotation vector is near pi -- a camera looking straight
 * down at the board -- (measured on a real top-down frame: 2.85 px after its default 20 iterations,
 * 1.18 px after 200, against 0.967 px at the minimum, which OpenCV 5's rewritten LM reaches). The
 * rotation is updated locally, R <- exp([w]x) R, which has no singularity there.
 *
 * Analytic Jacobian; Marquardt damping (lambda x diag(J^T J)); stops when a step changes the cost by
 * less than 1e-12 relative or moves less than 1e-12, or after `maxIterations` (default 100).
 * Returns { R, t, cost, iterations }.
 */
export function refinePose(points, pixels, R0, t0, intrinsics, maxIterations = 100) {
  const { f, cx, cy } = intrinsics;
  const k1 = intrinsics.k1 ?? 0;
  const n = points.length;

  const costOf = (R, t) => {
    const p = projectPoints(points, R, t, intrinsics);
    let c = 0;

    for (let i = 0; i < n; i += 1) {
      c += (p[2 * i] - pixels[i][0]) ** 2 + (p[2 * i + 1] - pixels[i][1]) ** 2;
    }

    return c;
  };

  let R = R0.slice();
  let t = t0.slice();
  let cost = costOf(R, t);
  let lambda = 1e-3;
  let iterations = 0;
  // reused buffers: no allocation per corner (garbage-collection pauses showed up as 20-100 ms
  // spikes in a solve whose median is 5 ms)
  const JtJ = new Float64Array(36);
  const Jtr = new Float64Array(6);
  const jx = new Float64Array(6);
  const jy = new Float64Array(6);

  for (; iterations < maxIterations && Number.isFinite(cost); iterations += 1) {
    // normal equations over the 6 parameters (w, t)
    JtJ.fill(0);
    Jtr.fill(0);
    linearisePoint(R, t, f, k1, cx, cy, points, pixels, JtJ, Jtr, jx, jy);

    let improved = false;
    let stepSize = 0;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const A = Float64Array.from(JtJ);

      for (let a = 0; a < 6; a += 1) {
        A[a * 6 + a] += lambda * Math.max(JtJ[a * 6 + a], 1e-12);
      }

      const step = solveLinear(A, Array.from(Jtr, (v) => -v), 6);

      if (!step) {
        lambda *= 10;
        continue;
      }

      const R1 = matMul3(rodrigues([step[0], step[1], step[2]]), R);
      const t1 = [t[0] + step[3], t[1] + step[4], t[2] + step[5]];
      const cost1 = costOf(R1, t1);

      if (cost1 < cost) {
        const relative = (cost - cost1) / Math.max(cost, 1e-300);
        stepSize = Math.hypot(...step);
        R = R1;
        t = t1;
        cost = cost1;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = relative > 1e-12;
        break;
      }

      lambda *= 10;
    }

    if (!improved || stepSize < 1e-12) {
      break;
    }
  }

  return { R, t, cost, iterations };
}

/**
 * The pose Jacobian of every corner's reprojection, accumulated into the normal equations:
 * JtJ (6 x 6, row-major, full) += J^T J and Jtr (6) += J^T r over the corners in front of the
 * camera, for the parameters (w, t) of R <- exp([w]x) R, t <- t + dt. Optional per-corner
 * callback `each(jx, jy, u, v, r2, d, rx, ry)` sees each corner's two Jacobian rows (the bundle
 * adjustment adds the intrinsics' columns there). jx, jy: caller-owned 6-element buffers.
 */
export function linearisePoint(R, t, f, k1, cx, cy, points, pixels, JtJ, Jtr, jx, jy, each = null) {
  for (let i = 0; i < points.length; i += 1) {
    const P = points[i];
    // q = R P
    const q0 = R[0] * P[0] + R[1] * P[1] + R[2] * P[2];
    const q1 = R[3] * P[0] + R[4] * P[1] + R[5] * P[2];
    const q2 = R[6] * P[0] + R[7] * P[1] + R[8] * P[2];
    const X = q0 + t[0];
    const Y = q1 + t[1];
    const Z = q2 + t[2];

    if (!(Z > 0)) {
      continue;
    }

    const iz = 1 / Z;
    const u = X * iz;
    const v = Y * iz;
    const r2 = u * u + v * v;
    const d = 1 + k1 * r2;
    // d(pixel) / d(u, v)
    const a11 = f * (d + 2 * k1 * u * u);
    const a12 = f * 2 * k1 * u * v;
    const a22 = f * (d + 2 * k1 * v * v);
    // d(u, v) / d(w), with d(X, Y, Z) / d(w) = -[q]x, i.e. rows (0, q2, -q1), (-q2, 0, q0), (q1, -q0, 0)
    const izz = iz * iz;
    const du0 = -X * izz * q1;
    const du1 = iz * q2 + X * izz * q0;
    const du2 = -iz * q1;
    const dv0 = -iz * q2 - Y * izz * q1;
    const dv1 = Y * izz * q0;
    const dv2 = iz * q0;
    // d(u, v) / d(t) = (iz, 0, -X izz), (0, iz, -Y izz)
    jx[0] = a11 * du0 + a12 * dv0;
    jx[1] = a11 * du1 + a12 * dv1;
    jx[2] = a11 * du2 + a12 * dv2;
    jx[3] = a11 * iz;
    jx[4] = a12 * iz;
    jx[5] = -(a11 * X + a12 * Y) * izz;
    jy[0] = a12 * du0 + a22 * dv0;
    jy[1] = a12 * du1 + a22 * dv1;
    jy[2] = a12 * du2 + a22 * dv2;
    jy[3] = a12 * iz;
    jy[4] = a22 * iz;
    jy[5] = -(a12 * X + a22 * Y) * izz;
    const rx = f * u * d + cx - pixels[i][0];
    const ry = f * v * d + cy - pixels[i][1];

    for (let a = 0; a < 6; a += 1) {
      Jtr[a] += jx[a] * rx + jy[a] * ry;

      for (let b = 0; b <= a; b += 1) {
        JtJ[a * 6 + b] += jx[a] * jx[b] + jy[a] * jy[b];
      }
    }

    if (each) {
      each(jx, jy, u, v, r2, d, rx, ry);
    }
  }

  for (let a = 0; a < 6; a += 1) {
    for (let b = a + 1; b < 6; b += 1) {
      JtJ[a * 6 + b] = JtJ[b * 6 + a];
    }
  }
}

/** 3x3 row-major product A B. */
export function matMul3(A, B) {
  const C = new Array(9);

  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      C[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
    }
  }

  return C;
}

/**
 * Do the corners span the plane (calibrate._spans_plane)? Not (nearly) on one line: the second
 * singular value of their centred board X/Y, over sqrt(n), above half a square. Needs 4 points.
 */
export function spansPlane(points, squareMm) {
  const n = points.length;

  if (n < 4) {
    return false;
  }

  let mx = 0;
  let my = 0;

  for (const p of points) {
    mx += p[0];
    my += p[1];
  }

  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;

  for (const p of points) {
    const dx = p[0] - mx;
    const dy = p[1] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  // the smaller eigenvalue of the 2x2 scatter matrix is the second singular value squared
  const half = 0.5 * (sxx + syy);
  const disc = Math.sqrt(Math.max(0, 0.25 * (sxx - syy) ** 2 + sxy * sxy));
  const s1 = Math.sqrt(Math.max(0, half - disc));
  return s1 / Math.sqrt(n) > 0.5 * squareMm;
}

/**
 * The two closed-form focal lengths one planar view gives (Zhang's constraints with the principal
 * point at the image centre, square pixels, no distortion), from its homography H (row-major 3x3,
 * board X/Y -> pixel minus the centre). calibrate.homography_focal's inner loop: the orthogonality
 * constraint h1^T W h2 = 0 and the equal-norm constraint h1^T W h1 = h2^T W h2, W = diag(1/f^2,
 * 1/f^2, 1). Each gives f only when its f^2 comes out positive; a fronto-parallel view gives none.
 */
export function focalsFromHomography(H) {
  const h1 = [H[0], H[3], H[6]];
  const h2 = [H[1], H[4], H[7]];
  const fs = [];
  const a = h1[0] * h2[0] + h1[1] * h2[1];

  if (Math.abs(h1[2] * h2[2]) > 1e-12) {
    const f2 = -a / (h1[2] * h2[2]);

    if (f2 > 0) {
      fs.push(Math.sqrt(f2));
    }
  }

  const b = (h1[0] ** 2 + h1[1] ** 2) - (h2[0] ** 2 + h2[1] ** 2);
  const d = h2[2] ** 2 - h1[2] ** 2;

  if (Math.abs(d) > 1e-12) {
    const f2 = b / d;

    if (f2 > 0) {
      fs.push(Math.sqrt(f2));
    }
  }

  return fs;
}

/**
 * One view's closed-form focal lengths: its homography (cv.findHomography, least squares, method 0,
 * as the desktop) from board X/Y (mm) to pixels relative to the image centre, then
 * focalsFromHomography. Views with fewer than 6 corners give none (as the desktop).
 *
 * @param cv      opencv.js
 * @param points  [[X, Y, Z], ...] board mm (Z ignored)
 * @param pixels  [[x, y], ...]
 * @param size    { width, height }
 */
export function viewFocals(cv, points, pixels, size) {
  if (points.length < 6) {
    return [];
  }

  const cx = size.width / 2;
  const cy = size.height / 2;
  const src = new Float64Array(points.length * 2);
  const dst = new Float64Array(points.length * 2);

  for (let i = 0; i < points.length; i += 1) {
    src[2 * i] = points[i][0];
    src[2 * i + 1] = points[i][1];
    dst[2 * i] = pixels[i][0] - cx;
    dst[2 * i + 1] = pixels[i][1] - cy;
  }

  const srcMat = cv.matFromArray(points.length, 1, cv.CV_64FC2, src);
  const dstMat = cv.matFromArray(points.length, 1, cv.CV_64FC2, dst);
  let H = null;

  try {
    H = cv.findHomography(srcMat, dstMat, 0);

    if (!H || H.rows !== 3 || H.cols !== 3) {
      return [];
    }

    return focalsFromHomography(Array.from(H.data64F));
  } finally {
    srcMat.delete();
    dstMat.delete();
    H?.delete();
  }
}

/**
 * Closed-form focal length from planar views (calibrate.homography_focal): the median over views of
 * both constraints' f; NaN when none is usable. views: [{ points, pixels }].
 */
export function homographyFocal(cv, views, size) {
  const fs = [];

  for (const view of views) {
    fs.push(...viewFocals(cv, view.points, view.pixels, size));
  }

  return fs.length ? median(fs) : NaN;
}

/**
 * Farthest-point sampling over viewing direction (unit vectors) and log distance
 * (calibrate.select_spread): n views spread over all the angles and ranges available.
 * Deterministic: starts from the view closest to the mean direction. Returns sorted indices.
 */
export function selectSpread(dirs, dists, n) {
  const count = dirs.length;

  if (count <= n) {
    return [...Array(count).keys()];
  }

  const feat = dirs.map((d, i) => [d[0], d[1], d[2], 0.5 * Math.log(dists[i])]);
  const mean = [0, 0, 0];

  for (const d of dirs) {
    mean[0] += d[0] / count;
    mean[1] += d[1] / count;
    mean[2] += d[2] / count;
  }

  let start = 0;
  let best = -Infinity;

  for (let i = 0; i < count; i += 1) {
    const dot = dirs[i][0] * mean[0] + dirs[i][1] * mean[1] + dirs[i][2] * mean[2];

    if (dot > best) {
      best = dot;
      start = i;
    }
  }

  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
  const chosen = [start];
  const d = feat.map((x) => distance(x, feat[start]));

  while (chosen.length < n) {
    let j = 0;

    for (let i = 1; i < count; i += 1) {
      if (d[i] > d[j]) {
        j = i;
      }
    }

    chosen.push(j);

    for (let i = 0; i < count; i += 1) {
      d[i] = Math.min(d[i], distance(feat[i], feat[j]));
    }
  }

  return chosen.sort((a, b) => a - b);
}

/**
 * The same intrinsics for a frame of another size with the same field of view (a resolution
 * change of the same stream): f and the centre scale with the long side; k1 is in normalised
 * coordinates and does not change. Returns null when the aspect ratio differs by more than 1%
 * (a different crop of the sensor: the field of view is not known).
 */
export function scaleIntrinsics(intrinsics, size) {
  const oldAspect = intrinsics.width / intrinsics.height;
  const newAspect = size.width / size.height;

  if (Math.abs(newAspect / oldAspect - 1) > 0.01) {
    return null;
  }

  const s = Math.max(size.width, size.height) / Math.max(intrinsics.width, intrinsics.height);
  return {
    ...intrinsics,
    width: size.width,
    height: size.height,
    f: intrinsics.f * s,
    cx: intrinsics.cx * (size.width / intrinsics.width),
    cy: intrinsics.cy * (size.height / intrinsics.height),
  };
}
