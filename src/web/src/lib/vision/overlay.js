// Drawing the phone's vision over a camera picture (T-0326, T-0331): the board's chessboard grid,
// X/Y/Z arrows at the board's centre and the rock's outline, on a 2D canvas laid over a <video>.
// Used by the phone page over its own camera and by the studio over the phone's video
// (ScanView.svelte), so both show the same thing. Plain JS: it imports only camera_model.js's
// projection, never OpenCV.
//
// Coordinates: everything arrives in the phone's camera-frame pixels (types.js: origin at the
// top-left CORNER of the top-left pixel). fitTransform maps them onto the element as CSS
// object-fit does ('cover' on the phone, which fills its screen; 'contain' in the studio, which
// letterboxes). A browser shows a phone's frame already upright (the camera's rotation is applied
// before the page sees the frame), so there is no rotation to undo: only scale and offset.
//
// THE GRID (T-0331). The user, 2026-10-06: "i want the phone screen to show the charuco boards
// checkerboard lines overlay along with xyz arrows off of the center of the board". Every square
// edge of the printed chessboard is drawn: on the 23 x 17 board, 24 lines across the columns and 18
// across the rows, the outermost ones being the board's edge. Each line is CLIPPED IN 3D before it
// is projected: to the half-space in front of the camera and to the camera's field of view grown by
// a margin (clipSegmentToView). Projecting the whole line instead goes wrong in two ways: a point
// behind the camera projects to the wrong side of the picture (or NaN), and the lens model
// (x_d = x (1 + k1 r^2)) is only a model inside the picture: far outside it, at low elevations
// towards the horizon, a barrel lens's (k1 < 0) polynomial folds back on itself and throws points
// back into the frame. Inside the clipped stretch the line is cut into short pieces before projecting,
// because the lens bends straight lines. The grid is drawn thin and translucent so the camera's
// picture reads through it; where it sits on the printed squares, the pose is right.
//
// THE FOUND CORNERS (T-0333). The user, 2026-10-06: "can you overlay red points on the
// checkerboard's corners in the charuco board on the phone and add blue lines between them?", and,
// asked which corners: only the ones found, with the faint full-board grid dropped. So the phone
// draws a red point on every chessboard corner its latest pose was solved from (the pose's inlier
// ids: found by the detector or tracked, and agreeing with the pose) and a blue line between each
// two of them that are neighbours on the board. Each point is that corner's board position projected
// through the pose being DRAWN (the filtered pose carried to the frame on screen, T-0332), not the
// pixel it was found at: found pixels are a whole detection old by the time they are drawn, and
// would trail the picture as the old corner dots did; projected, they move with the grid and arrows.
// Which points there are still says what the phone found: a corner it lost has no point. The studio
// keeps the full grid (it gets no corner ids). drawVisionOverlay still draws raw detected corners as
// small dots when given `corners`.
//
// WITHOUT A POSE (T-0335 follow-up) the same red points and blue lines are drawn from the latest
// detection's corners at the pixels they were found at (`detectedCorners`), so a board that is found
// but whose pose fails its checks (a lens estimate still far off, say) still shows as found.

import { projectPoints } from './camera_model.js';

/** The overlay's colours: the board axes as the usual X red, Y green, Z blue (Nord's), the rock
 *  in yellow, the board's edge in white, its grid a translucent light blue. */
export const OVERLAY_COLOURS = Object.freeze({
  x: '#bf616a',
  y: '#a3be8c',
  z: '#81a1c1',
  rock: '#ebcb8b',
  rockFill: 'rgba(235, 203, 139, 0.18)',
  board: 'rgba(236, 239, 244, 0.85)',
  // Nord's frost, translucent: the lines sit exactly on the black/white square edges, where a
  // white or black line disappears (measured on the docs' screenshots: a faint white grid could
  // not be seen at all)
  grid: 'rgba(136, 192, 208, 0.75)',
  corner: '#88c0d0',
  // The found corners (T-0333): plain red points and blue lines, as the user asked, brighter than
  // Nord's muted red and blue so they read over both black and white squares (each over a dark halo).
  foundCorner: '#ff3b30',
  foundLine: '#2f7df6',
  shadow: 'rgba(0, 0, 0, 0.55)',
});

/** The axes' length on the board, mm: four squares, long enough to read at a glance and short
 *  enough to stay on the board from any side. */
export const AXIS_MM = 40;

/** The printed squares' side, mm, when a view does not say (every Houseki sheet has 10 mm). */
export const DEFAULT_SQUARE_MM = 10;

/** How far beyond the picture (a share of its size on each side) lines are kept before projecting. */
export const VIEW_MARGIN = 0.25;

/** Lines are kept at least this far in front of the camera, mm. */
export const NEAR_MM = 5;

/** A clipped line is cut into pieces no longer than this on the board before projecting, mm. */
export const GRID_STEP_MM = 5;

/**
 * How a frame of frameW x frameH pixels lands in a box of boxW x boxH (CSS pixels) under CSS
 * object-fit 'cover' or 'contain', centred: frame pixel (x, y) -> (dx + scale x, dy + scale y).
 */
export function fitTransform(frameW, frameH, boxW, boxH, fit = 'contain') {
  if (!(frameW > 0 && frameH > 0 && boxW > 0 && boxH > 0)) {
    return { scale: 0, dx: 0, dy: 0 };
  }

  const scale = fit === 'cover' ? Math.max(boxW / frameW, boxH / frameH) : Math.min(boxW / frameW, boxH / frameH);
  return { scale, dx: (boxW - frameW * scale) / 2, dy: (boxH - frameH * scale) / 2 };
}

/** The chessboard's centre in the board frame, mm: [X, Y] (85, 115 on the 23 x 17 board). */
export function boardCentreMm(sizeMm) {
  return [sizeMm[0] / 2, sizeMm[1] / 2];
}

/**
 * The camera's field of view grown by `margin` (a share of the frame on each side), as bounds on
 * the UNDISTORTED normalised coordinates x / z, y / z: { xmin, xmax, ymin, ymax }. The frame's
 * edges are undistorted through the k1 model; for a barrel lens (k1 < 0) the bounds are also kept
 * inside the radius where the model folds back (r^2 = 1 / (3 |k1|), where d(r (1 + k1 r^2)) / dr = 0),
 * less 10%, so every point inside them projects where it should.
 */
export function viewBounds(intrinsics, margin = VIEW_MARGIN) {
  const { f, cx, cy } = intrinsics;
  const k1 = intrinsics.k1 ?? 0;
  const width = intrinsics.width ?? 2 * cx;
  const height = intrinsics.height ?? 2 * cy;
  const undistort = (xd, yd) => {
    let x = xd;
    let y = yd;

    for (let k = 0; k < 20; k += 1) {
      const d = 1 + k1 * (x * x + y * y);
      x = xd / d;
      y = yd / d;
    }

    return [x, y];
  };
  const left = (-margin * width - cx) / f;
  const right = ((1 + margin) * width - cx) / f;
  const top = (-margin * height - cy) / f;
  const bottom = ((1 + margin) * height - cy) / f;
  // The frame's edges bend under the lens: take the widest of each edge's ends and middle.
  const xs = [[left, top], [left, 0], [left, bottom]].map(([x, y]) => undistort(x, y)[0]);
  const xe = [[right, top], [right, 0], [right, bottom]].map(([x, y]) => undistort(x, y)[0]);
  const ys = [[left, top], [0, top], [right, top]].map(([x, y]) => undistort(x, y)[1]);
  const ye = [[left, bottom], [0, bottom], [right, bottom]].map(([x, y]) => undistort(x, y)[1]);
  let bounds = { xmin: Math.min(...xs), xmax: Math.max(...xe), ymin: Math.min(...ys), ymax: Math.max(...ye) };

  if (k1 < 0) {
    // Inside the fold: |x|, |y| <= 0.9 r_fold / sqrt(2) keeps the whole box within the radius.
    const limit = (0.9 / Math.sqrt(3 * -k1)) / Math.SQRT2;
    bounds = {
      xmin: Math.max(bounds.xmin, -limit), xmax: Math.min(bounds.xmax, limit),
      ymin: Math.max(bounds.ymin, -limit), ymax: Math.min(bounds.ymax, limit),
    };
  }

  if (![bounds.xmin, bounds.xmax, bounds.ymin, bounds.ymax].every(Number.isFinite)) {
    return { xmin: -2, xmax: 2, ymin: -2, ymax: 2 };
  }

  return bounds;
}

/** R P + t: a board point (mm) in camera coordinates. */
function toCamera(R, t, P) {
  return [
    R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t[0],
    R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t[1],
    R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t[2],
  ];
}

/**
 * The part of the board segment P0 -> P1 (mm) that is in front of the camera (z >= nearMm) and
 * inside the view `bounds` (viewBounds'), as the parameter range [s0, s1] of P0 + s (P1 - P0),
 * or null when none of it is. Every bound is a half-space in camera coordinates (x >= xmin z, ...)
 * and the camera coordinates are linear in s, so this is Liang-Barsky clipping against five planes.
 */
export function clipSegmentToView(P0, P1, R, t, bounds, nearMm = NEAR_MM) {
  const a = toCamera(R, t, P0);
  const b = toCamera(R, t, P1);
  // Each plane as g(Q) >= 0, linear in the camera point Q.
  const planes = [
    (q) => q[2] - nearMm,
    (q) => q[0] - bounds.xmin * q[2],
    (q) => bounds.xmax * q[2] - q[0],
    (q) => q[1] - bounds.ymin * q[2],
    (q) => bounds.ymax * q[2] - q[1],
  ];
  let s0 = 0;
  let s1 = 1;

  for (const g of planes) {
    const ga = g(a);
    const gb = g(b);

    if (ga < 0 && gb < 0) {
      return null;
    }

    if (ga < 0) {
      s0 = Math.max(s0, ga / (ga - gb));
    } else if (gb < 0) {
      s1 = Math.min(s1, ga / (ga - gb));
    }

    if (s0 > s1) {
      return null;
    }
  }

  return [s0, s1];
}

/**
 * A board segment P0 -> P1 (mm) clipped to the view (clipSegmentToView) and projected, cut into
 * pieces of at most `stepMm` on the board: [[x, y], ...] frame pixels, or null when no part of it
 * is in view. `bounds` defaults to viewBounds(intrinsics).
 */
export function projectClippedSegment(P0, P1, pose, intrinsics, { bounds = null, stepMm = GRID_STEP_MM, nearMm = NEAR_MM } = {}) {
  const view = bounds ?? viewBounds(intrinsics);
  const range = clipSegmentToView(P0, P1, pose.R, pose.t, view, nearMm);

  if (!range) {
    return null;
  }

  const [s0, s1] = range;
  const length = Math.hypot(P1[0] - P0[0], P1[1] - P0[1], (P1[2] ?? 0) - (P0[2] ?? 0)) * (s1 - s0);
  const pieces = Math.max(1, Math.min(200, Math.ceil(length / stepMm)));
  const points = [];

  for (let k = 0; k <= pieces; k += 1) {
    const s = s0 + ((s1 - s0) * k) / pieces;
    points.push([
      P0[0] + s * (P1[0] - P0[0]),
      P0[1] + s * (P1[1] - P0[1]),
      (P0[2] ?? 0) + s * ((P1[2] ?? 0) - (P0[2] ?? 0)),
    ]);
  }

  const p = projectPoints(points, pose.R, pose.t, intrinsics);
  const out = [];

  for (let i = 0; i < points.length; i += 1) {
    if (Number.isFinite(p[2 * i]) && Number.isFinite(p[2 * i + 1])) {
      out.push([p[2 * i], p[2 * i + 1]]);
    }
  }

  return out.length >= 2 ? out : null;
}

/**
 * The chessboard's grid as drawn: every square edge of a board `sizeMm` ([X, Y] extent) of
 * `squareMm` squares, each clipped in 3D and projected (projectClippedSegment). Lines of constant Y
 * (running down the page, along X) come first, then lines of constant X. Returns
 * [{ along: 'x'|'y', mm (the constant coordinate), edge (an outer line), points }] for the lines
 * with some part in view.
 */
export function boardGridLines(pose, intrinsics, sizeMm, squareMm = DEFAULT_SQUARE_MM, options = {}) {
  const [sx, sy] = sizeMm;
  const bounds = options.bounds ?? viewBounds(intrinsics, options.margin ?? VIEW_MARGIN);
  const lines = [];
  const columns = Math.round(sy / squareMm);
  const rows = Math.round(sx / squareMm);

  for (let j = 0; j <= columns; j += 1) {
    const y = j * squareMm;
    const points = projectClippedSegment([0, y, 0], [sx, y, 0], pose, intrinsics, { ...options, bounds });

    if (points) {
      lines.push({ along: 'x', mm: y, edge: j === 0 || j === columns, points });
    }
  }

  for (let i = 0; i <= rows; i += 1) {
    const x = i * squareMm;
    const points = projectClippedSegment([x, 0, 0], [x, sy, 0], pose, intrinsics, { ...options, bounds });

    if (points) {
      lines.push({ along: 'y', mm: x, edge: i === 0 || i === rows, points });
    }
  }

  return lines;
}

/**
 * The found corners as a graph on the board (T-0333): each id's board point and the pairs of found
 * corners that are neighbours (one square apart along a row or a column). Corner ids are OpenCV's,
 * row-major with (squares_x - 1) per row, at ((row + 1), (col + 1)) squares in this file's frame (X
 * down the rows, Y along the columns; board_frame.js). The board's size in squares comes from
 * `sizeMm` ([X, Y] extent) and `squareMm`. Ids outside the board, and repeats, are left out.
 *
 * @returns {{ points: Map<number, [number, number, number]>, edges: [number, number][] }}
 */
export function foundCornerGraph(ids, sizeMm, squareMm = DEFAULT_SQUARE_MM) {
  const perRow = Math.round(sizeMm[1] / squareMm) - 1;
  const rows = Math.round(sizeMm[0] / squareMm) - 1;
  const points = new Map();

  for (const id of ids ?? []) {
    if (!Number.isInteger(id) || id < 0 || id >= perRow * rows || points.has(id)) {
      continue;
    }

    const row = Math.floor(id / perRow);
    const col = id % perRow;
    points.set(id, [(row + 1) * squareMm, (col + 1) * squareMm, 0]);
  }

  const edges = [];

  for (const id of points.keys()) {
    // the next corner along the row (not wrapping onto the next row), and the one a row down
    if (id % perRow < perRow - 1 && points.has(id + 1)) {
      edges.push([id, id + 1]);
    }

    if (points.has(id + perRow)) {
      edges.push([id, id + perRow]);
    }
  }

  return { points, edges };
}

/**
 * The chessboard's edge (0..sizeMm[0] along X, 0..sizeMm[1] along Y) projected into the frame, as
 * one closed polyline with each side cut into `steps` pieces (the lens's distortion bends it).
 * Points behind the camera are left out. Returns [[x, y], ...].
 */
export function boardOutlinePoints(pose, intrinsics, sizeMm, steps = 16) {
  const [sx, sy] = sizeMm;
  const corners = [[0, 0], [sx, 0], [sx, sy], [0, sy]];
  const points = [];

  for (let side = 0; side < 4; side += 1) {
    const [ax, ay] = corners[side];
    const [bx, by] = corners[(side + 1) % 4];

    for (let k = 0; k < steps; k += 1) {
      const t = k / steps;
      points.push([ax + t * (bx - ax), ay + t * (by - ay), 0]);
    }
  }

  const p = projectPoints(points, pose.R, pose.t, intrinsics);
  const out = [];

  for (let i = 0; i < points.length; i += 1) {
    if (Number.isFinite(p[2 * i]) && Number.isFinite(p[2 * i + 1])) {
      out.push([p[2 * i], p[2 * i + 1]]);
    }
  }

  return out;
}

/**
 * The board's axes at `originMm` ([X, Y] on the board), `lengthMm` long, in frame pixels:
 * { origin, x, y, z } each [x, y], or null when the origin is not in view (behind the camera, or
 * outside the picture's margin). An axis that leaves the view is clipped in 3D where it does
 * (projectClippedSegment), so its drawn end is the last point of it in view.
 */
export function axesPoints(pose, intrinsics, originMm, lengthMm = AXIS_MM) {
  const [X, Y] = originMm;
  const origin = [X, Y, 0];
  const bounds = viewBounds(intrinsics);
  const ends = { x: [X + lengthMm, Y, 0], y: [X, Y + lengthMm, 0], z: [X, Y, lengthMm] };
  const out = {};

  for (const [axis, end] of Object.entries(ends)) {
    const range = clipSegmentToView(origin, end, pose.R, pose.t, bounds);

    if (!range || range[0] > 0) {
      return null;    // the origin itself is out of view
    }

    const s = range[1];
    const p = projectPoints([origin, [X + s * (end[0] - X), Y + s * (end[1] - Y), s * end[2]]], pose.R, pose.t, intrinsics);

    if (![0, 1, 2, 3].every((i) => Number.isFinite(p[i]))) {
      return null;
    }

    out.origin = [p[0], p[1]];
    out[axis] = [p[2], p[3]];
  }

  return out;
}

/**
 * An outline found on one frame, moved to where it would be seen with another pose (T-0332): each
 * point's ray from the first camera (pose `from`, lens `fromLens`; k1 undone) is met with the plane
 * Z = planeMm (the rock's middle height), and that board point projected with pose `to` and lens
 * `toLens`. The rock is not flat, so this is exact only on that plane, but over the small motion
 * between the outline's frame and the frame on screen (a fraction of a second) its silhouette
 * moves with the board around it, which is what this gets right. Points whose ray misses the plane
 * (pointing up, or the plane behind the camera) are left out; null when fewer than 3 remain.
 *
 * @param {[number, number][]} contour  frame pixels of the outline's frame
 * @returns {[number, number][]|null}
 */
export function transferContour(contour, from, fromLens, to, toLens, planeMm = 0) {
  const { R, t } = from;
  // the first camera's centre in the board frame, -R^T t
  const c = [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
  const k1 = fromLens.k1 ?? 0;
  const points = [];

  for (const [u, v] of contour) {
    const xd = (u - fromLens.cx) / fromLens.f;
    const yd = (v - fromLens.cy) / fromLens.f;
    let x = xd;
    let y = yd;

    for (let k = 0; k < 8; k += 1) {
      const d = 1 + k1 * (x * x + y * y);
      x = xd / d;
      y = yd / d;
    }

    // the ray's direction in the board frame, R^T (x, y, 1)
    const dir = [R[0] * x + R[3] * y + R[6], R[1] * x + R[4] * y + R[7], R[2] * x + R[5] * y + R[8]];

    if (Math.abs(dir[2]) < 1e-9) {
      continue;
    }

    const s = (planeMm - c[2]) / dir[2];

    if (s > 0) {
      points.push([c[0] + s * dir[0], c[1] + s * dir[1], planeMm]);
    }
  }

  const p = projectPoints(points, to.R, to.t, toLens);
  const out = [];

  for (let i = 0; i < points.length; i += 1) {
    if (Number.isFinite(p[2 * i]) && Number.isFinite(p[2 * i + 1])) {
      out.push([p[2 * i], p[2 * i + 1]]);
    }
  }

  return out.length >= 3 ? out : null;
}

/**
 * Draws one view of the vision over a canvas (whose 2D context is already scaled to CSS pixels).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view
 *   pose        { R, t } board -> camera (or null)
 *   intrinsics  { f, cx, cy, k1 } for the frame (needed with pose)
 *   sizeMm      [X, Y] the chessboard's extent
 *   squareMm    the squares' side (default DEFAULT_SQUARE_MM)
 *   axesMm      [X, Y] where the axes stand (default: the board's centre, boardCentreMm)
 *   targetMm    [X, Y] the sheet's target (no longer where the axes stand; kept for callers)
 *   contour     the rock's outline, [[x, y], ...] frame pixels (or null)
 *   corners     detected corners [{ x, y }] (or null): drawn as dots
 *   foundCornerIds  ids of the corners the pose was solved from (or null): with a pose, a red point
 *               on each and a blue line between neighbours, placed through the pose (T-0333)
 *   detectedCorners  the latest detection's corners [{ id, x, y }] frame pixels (or null): WITHOUT
 *               a pose, drawn the same way at the pixels they were found at (T-0335 follow-up);
 *               ignored when there is a pose
 * `drawn.cornersFrom` says which drew the red points: 'pose', 'detection' or null.
 * @param {{ scale: number, dx: number, dy: number }} transform  fitTransform's
 * @param {{ alpha?: number, frame?: [number, number], grid?: boolean }} [style]  alpha fades the
 *        whole overlay (stale data); frame, the camera frame's [width, height] in pixels, clips the
 *        drawing to where the picture is shown (not over a letterbox's bars); grid false draws only
 *        the board's edge
 * @returns {{ gridLines: number, edgeLines: number, foundCorners: number, foundLines: number,
 *          axes: object|null, rock: boolean }} what was drawn, in CSS pixels (axes: { origin, x, y,
 *          z } each [x, y]), for the harness
 */
export function drawVisionOverlay(ctx, view, transform, style = {}) {
  const { scale, dx, dy } = transform;
  const map = ([x, y]) => [dx + scale * x, dy + scale * y];
  const drawn = { gridLines: 0, edgeLines: 0, foundCorners: 0, foundLines: 0, cornersFrom: null, axes: null, rock: false };
  ctx.save();
  ctx.globalAlpha = style.alpha ?? 1;

  if (style.frame && ctx.rect && ctx.clip) {
    ctx.beginPath();
    ctx.rect(dx, dy, scale * style.frame[0], scale * style.frame[1]);
    ctx.clip();
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const path = (points, close) => {
    ctx.beginPath();
    points.forEach((point, i) => {
      const [x, y] = map(point);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    if (close) {
      ctx.closePath();
    }
  };

  // A dark halo under each line keeps it readable over white paper and black squares alike.
  const stroke = (colour, width) => {
    ctx.strokeStyle = OVERLAY_COLOURS.shadow;
    ctx.lineWidth = width + 2;
    ctx.stroke();
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.stroke();
  };

  if (view.corners?.length) {
    ctx.fillStyle = OVERLAY_COLOURS.corner;

    for (const corner of view.corners) {
      const [x, y] = map([corner.x, corner.y]);
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  const posed = Boolean(view.pose && view.intrinsics && view.sizeMm);

  if (posed) {
    const lines = boardGridLines(view.pose, view.intrinsics, view.sizeMm, view.squareMm ?? DEFAULT_SQUARE_MM);

    // The inner lines thin and faint, with no halo, so the picture reads through them; the
    // board's edge as before, white over a dark halo.
    if (style.grid !== false) {
      ctx.strokeStyle = OVERLAY_COLOURS.grid;
      ctx.lineWidth = 1;

      for (const line of lines) {
        if (!line.edge) {
          path(line.points, false);
          ctx.stroke();
          drawn.gridLines += 1;
        }
      }
    }

    for (const line of lines) {
      if (line.edge) {
        path(line.points, false);
        stroke(OVERLAY_COLOURS.board, 1.5);
        drawn.edgeLines += 1;
      }
    }
  }

  // The found corners WITHOUT a pose (T-0335 follow-up): the user, on the real board with the pose
  // failing its checks, "still not showing the board - the old slower opencv version would show the
  // dots without any problems". So when there is no pose to place them through, the latest
  // detection's corners are drawn where they were found in the picture, in the same red and blue:
  // a blue line between each two found corners that are neighbours on the board (by id, as
  // foundCornerGraph pairs them), then a red point on each. They trail a moving picture by a
  // detection's time, which the posed path avoids, but they show that the board is found.
  if (!posed && view.detectedCorners?.length && view.sizeMm) {
    const squareMm = view.squareMm ?? DEFAULT_SQUARE_MM;
    const at = new Map();

    for (const corner of view.detectedCorners) {
      if (Number.isInteger(corner.id) && Number.isFinite(corner.x) && Number.isFinite(corner.y) && !at.has(corner.id)) {
        at.set(corner.id, [corner.x, corner.y]);
      }
    }

    const graph = foundCornerGraph([...at.keys()], view.sizeMm, squareMm);

    for (const [a, b] of graph.edges) {
      path([at.get(a), at.get(b)], false);
      stroke(OVERLAY_COLOURS.foundLine, 1.5);
      drawn.foundLines += 1;
    }

    for (const id of graph.points.keys()) {
      const [x, y] = map(at.get(id));
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, 2 * Math.PI);
      ctx.fillStyle = OVERLAY_COLOURS.foundCorner;
      ctx.fill();
      ctx.strokeStyle = OVERLAY_COLOURS.shadow;
      ctx.lineWidth = 1;
      ctx.stroke();
      drawn.foundCorners += 1;
    }

    drawn.cornersFrom = drawn.foundCorners ? 'detection' : null;
  }

  // The found corners (T-0333): blue lines between neighbours first, then red points over them.
  // Lines are clipped in 3D like the grid's; a point is drawn only if it is in front of the camera
  // and inside the view's margin (the same bounds), so nothing behind the camera lands on screen.
  if (posed && view.foundCornerIds?.length) {
    drawn.cornersFrom = 'pose';
    const squareMm = view.squareMm ?? DEFAULT_SQUARE_MM;
    const graph = foundCornerGraph(view.foundCornerIds, view.sizeMm, squareMm);
    const bounds = viewBounds(view.intrinsics);

    for (const [a, b] of graph.edges) {
      const points = projectClippedSegment(graph.points.get(a), graph.points.get(b), view.pose, view.intrinsics, { bounds });

      if (points) {
        path(points, false);
        stroke(OVERLAY_COLOURS.foundLine, 1.5);
        drawn.foundLines += 1;
      }
    }

    const visible = [...graph.points.values()].filter((P) => {
      const q = toCamera(view.pose.R, view.pose.t, P);
      return q[2] >= NEAR_MM && q[0] >= bounds.xmin * q[2] && q[0] <= bounds.xmax * q[2]
        && q[1] >= bounds.ymin * q[2] && q[1] <= bounds.ymax * q[2];
    });
    const p = projectPoints(visible, view.pose.R, view.pose.t, view.intrinsics);

    for (let i = 0; i < visible.length; i += 1) {
      if (!(Number.isFinite(p[2 * i]) && Number.isFinite(p[2 * i + 1]))) {
        continue;
      }

      const [x, y] = map([p[2 * i], p[2 * i + 1]]);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, 2 * Math.PI);
      ctx.fillStyle = OVERLAY_COLOURS.foundCorner;
      ctx.fill();
      ctx.strokeStyle = OVERLAY_COLOURS.shadow;
      ctx.lineWidth = 1;
      ctx.stroke();
      drawn.foundCorners += 1;
    }
  }

  if (view.contour && view.contour.length >= 3) {
    path(view.contour, true);
    ctx.fillStyle = OVERLAY_COLOURS.rockFill;
    ctx.fill();
    stroke(OVERLAY_COLOURS.rock, 2.5);
    drawn.rock = true;
  }

  if (posed) {
    const axes = axesPoints(view.pose, view.intrinsics, view.axesMm ?? boardCentreMm(view.sizeMm));

    if (axes) {
      ctx.font = '600 13px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      drawn.axes = { origin: map(axes.origin) };

      for (const axis of ['x', 'y', 'z']) {
        const [ox, oy] = map(axes.origin);
        const [ex, ey] = map(axes[axis]);
        const length = Math.hypot(ex - ox, ey - oy);
        drawn.axes[axis] = [ex, ey];
        path([axes.origin, axes[axis]], false);
        stroke(OVERLAY_COLOURS[axis], 3);

        if (length < 4) {
          continue;     // pointing (nearly) at the camera: no direction to show
        }

        const ux = (ex - ox) / length;
        const uy = (ey - oy) / length;
        // The arrowhead: a small filled triangle at the end, over a dark halo.
        const head = Math.min(10, 0.4 * length);
        const tip = [ex, ey];
        const left = [ex - head * ux + 0.5 * head * uy, ey - head * uy - 0.5 * head * ux];
        const right = [ex - head * ux - 0.5 * head * uy, ey - head * uy + 0.5 * head * ux];
        ctx.beginPath();
        ctx.moveTo(...tip);
        ctx.lineTo(...left);
        ctx.lineTo(...right);
        ctx.closePath();
        ctx.strokeStyle = OVERLAY_COLOURS.shadow;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = OVERLAY_COLOURS[axis];
        ctx.fill();
        // The label a little beyond the axis's end.
        const lx = ex + ux * 11;
        const ly = ey + uy * 11;
        ctx.fillStyle = OVERLAY_COLOURS.shadow;
        ctx.fillText(axis.toUpperCase(), lx + 1, ly + 1);
        ctx.fillStyle = OVERLAY_COLOURS[axis];
        ctx.fillText(axis.toUpperCase(), lx, ly);
      }
    }
  }

  ctx.restore();
  return drawn;
}

/**
 * Sizes a canvas's backing store to its CSS box at the device's pixel ratio, and returns its 2D
 * context scaled so drawing is in CSS pixels, cleared; with the box's size.
 */
export function prepareCanvas(canvas, ratio = globalThis.devicePixelRatio || 1) {
  const box = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(box.width * ratio));
  const height = Math.max(1, Math.round(box.height * ratio));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);
  return { ctx, width: box.width, height: box.height };
}
