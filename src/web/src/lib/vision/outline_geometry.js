// Camera geometry for the rock outline (T-0325): projecting board points through a CameraPose,
// the coarse rock bound live frames use, and the crop the outline is found in.
//
// Conventions are types.js's: image pixels have their origin at the top-left CORNER of the
// top-left pixel (so pixel (i, j)'s centre is (i + 0.5, j + 0.5)), x right, y down; the lens model
// is a pinhole plus one radial term, x_d = x (1 + k1 r^2) in normalised coordinates; the pose maps
// a board point P (mm) to camera coordinates R P + t, OpenCV's camera (x right, y down, z forward).
//
// The desktop pipeline (HousekiScanner) knows a carved 3D bound of the stone before it segments
// (bound.py). Live there is none, so the bound here is a cylinder standing on the board around the
// centre target, radius and height being options: the same fixed cylinder bound.py falls back to
// when its carve does not close (15 mm radius, 20 mm high).

/** Distorted normalised coordinates of undistorted ones: x (1 + k1 r^2). */
export function distort(x, y, k1) {
  const s = 1 + k1 * (x * x + y * y);
  return [x * s, y * s];
}

/**
 * Undistorted normalised coordinates of distorted ones, by fixed-point iteration of
 * x = x_d / (1 + k1 r^2) (converges for the small k1 phones have: |k1 r^2| << 1).
 */
export function undistort(xd, yd, k1, iterations = 6) {
  let x = xd;
  let y = yd;

  for (let i = 0; i < iterations; i += 1) {
    const s = 1 + k1 * (x * x + y * y);
    x = xd / s;
    y = yd / s;
  }

  return [x, y];
}

/** R P + t for a row-major 3 x 3 R. */
export function toCamera(pose, P) {
  const R = pose.R;
  const t = pose.t;
  return [
    R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t[0],
    R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t[1],
    R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t[2],
  ];
}

/** The camera's centre in the board frame, -R^T t. */
export function cameraCentre(pose) {
  const R = pose.R;
  const t = pose.t;
  return [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
}

/**
 * A board point (mm) projected into the image: [x, y] pixels and the camera depth z (mm). Points
 * behind the camera give z <= 0 (and meaningless pixels).
 */
export function projectPoint(pose, P) {
  const { f, cx, cy, k1 } = pose.intrinsics;
  const c = toCamera(pose, P);
  const [xd, yd] = distort(c[0] / c[2], c[1] / c[2], k1);
  return { x: f * xd + cx, y: f * yd + cy, z: c[2] };
}

/**
 * The board-plane point (z = 0) an image point looks at: { X, Y, depth } (depth = camera z, mm),
 * or null when its ray misses the board (parallel to it, or pointing away).
 */
export function pixelToBoard(pose, x, y) {
  const { f, cx, cy, k1 } = pose.intrinsics;
  const [xn, yn] = undistort((x - cx) / f, (y - cy) / f, k1);
  const R = pose.R;
  // Ray direction in the board frame: R^T (xn, yn, 1).
  const d = [
    R[0] * xn + R[3] * yn + R[6],
    R[1] * xn + R[4] * yn + R[7],
    R[2] * xn + R[5] * yn + R[8],
  ];
  const C = cameraCentre(pose);

  if (Math.abs(d[2]) < 1e-12) {
    return null;
  }

  const s = -C[2] / d[2];

  if (!(s > 0)) {
    return null;
  }

  return { X: C[0] + s * d[0], Y: C[1] + s * d[1], depth: s };
}

/**
 * Points on the rims of a vertical cylinder standing on the board: `n` around the base (z = 0)
 * and `n` around the top (z = height), centred on centre = [X, Y] mm.
 */
export function cylinderPoints(centre, radius, height, n = 48) {
  const points = [];

  for (const z of [0, height]) {
    for (let k = 0; k < n; k += 1) {
      const a = (2 * Math.PI * k) / n;
      points.push([centre[0] + radius * Math.cos(a), centre[1] + radius * Math.sin(a), z]);
    }
  }

  return points;
}

/**
 * The convex hull of 2D points, counter-clockwise in a y-up sense (clockwise on screen in image
 * coordinates, y down), without repeated or collinear points (Andrew's monotone chain).
 */
export function convexHull(points) {
  const pts = points
    .map((p) => [p[0], p[1]])
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));

  if (pts.length < 3) {
    return pts;
  }

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];

  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }

    lower.push(p);
  }

  const upper = [];

  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];

    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }

    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Board points projected into the image, as their convex hull in pixels, or null when any of them
 * is behind the camera (or too close to its plane to project sensibly).
 */
export function projectHull(pose, points) {
  const px = [];

  for (const P of points) {
    const q = projectPoint(pose, P);

    if (!(q.z > 1)) {
      return null;
    }

    px.push([q.x, q.y]);
  }

  return convexHull(px);
}

/**
 * The square crop the outline is found in: the box of `hull` (pixels) grown by `marginPx` on every
 * side and made square around its centre. Returns { x, y, side } in pixels (the crop's top-left
 * corner and side; it may reach beyond the image, whose outside is then simply not used).
 */
export function cropAround(hull, marginPx) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;

  for (const [x, y] of hull) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }

  const side = Math.max(x1 - x0, y1 - y0) + 2 * marginPx;
  return { x: (x0 + x1) / 2 - side / 2, y: (y0 + y1) / 2 - side / 2, side };
}

/**
 * Pixel-centre raster of a convex polygon into a size x size mask (1 inside or on it). The
 * polygon is in mask pixels (pixel (i, j) covers [i, i + 1] x [j, j + 1]). out: an optional
 * Uint8Array to fill (it is cleared first).
 */
export function rasterConvex(polygon, size, out = new Uint8Array(size * size)) {
  out.fill(0);
  const n = polygon.length;

  if (n < 3) {
    return out;
  }

  for (let j = 0; j < size; j += 1) {
    const yc = j + 0.5;
    let lo = Infinity;
    let hi = -Infinity;

    for (let k = 0; k < n; k += 1) {
      const [ax, ay] = polygon[k];
      const [bx, by] = polygon[(k + 1) % n];

      if ((ay <= yc && by >= yc) || (by <= yc && ay >= yc)) {
        if (ay === by) {
          lo = Math.min(lo, ax, bx);
          hi = Math.max(hi, ax, bx);
        } else {
          const x = ax + ((yc - ay) / (by - ay)) * (bx - ax);
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
      }
    }

    if (hi < lo) {
      continue;
    }

    const i0 = Math.max(0, Math.ceil(lo - 0.5));
    const i1 = Math.min(size - 1, Math.floor(hi - 0.5));

    for (let i = i0; i <= i1; i += 1) {
      out[j * size + i] = 1;
    }
  }

  return out;
}

/**
 * A convex polygon's edges as line equations [a, b, c] with a x + b y + c >= 0 inside, whatever
 * the polygon's winding (for the GPU's inside test).
 */
export function convexEdges(polygon) {
  const n = polygon.length;
  let area2 = 0;

  for (let k = 0; k < n; k += 1) {
    const [ax, ay] = polygon[k];
    const [bx, by] = polygon[(k + 1) % n];
    area2 += ax * by - bx * ay;
  }

  const sign = area2 >= 0 ? 1 : -1;
  const edges = [];

  for (let k = 0; k < n; k += 1) {
    const [ax, ay] = polygon[k];
    const [bx, by] = polygon[(k + 1) % n];
    // Left of a -> b for a positive (y-up counter-clockwise) polygon: cross(b - a, p - a) >= 0.
    const a = -(by - ay) * sign;
    const b = (bx - ax) * sign;
    edges.push([a, b, -(a * ax + b * ay)]);
  }

  return edges;
}
