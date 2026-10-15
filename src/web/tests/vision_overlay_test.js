/*
 * vision_overlay_test.js -- drawing the phone's vision over a camera picture (T-0326):
 * src/web/src/lib/vision/overlay.js, shared by the phone page and the studio's ScanView.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * No canvas exists under Deno, so the drawing is checked on a recording stand-in for a 2D context
 * (every path point and style it is given); the geometry is checked against projectPoints and
 * against what CSS object-fit does. That the overlay lands on the right pixels of a real <video> is
 * tests/harness/test_scan_vision.py's.
 */

import {
  applyHomography, axesPoints, boardCentreMm, boardGridLines, boardOutlinePoints, clipSegmentToView, drawVisionOverlay,
  fitHomography, fitTransform, foundCornerGraph, markerCornersMm, markerGridLines, OVERLAY_COLOURS, viewBounds,
} from '../src/lib/vision/overlay.js';
import { projectPoints } from '../src/lib/vision/camera_model.js';
import { lookAtPose } from './vision_test_support.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}

const INTRINSICS = { width: 1280, height: 720, f: 1088, cx: 640, cy: 360, k1: 0.02 };
const POSE = lookAtPose([85, 115, 0], 30, 50, 300);

Deno.test('fitTransform: places a frame as CSS object-fit cover and contain do', () => {
  // Setup: a 1280 x 720 frame in a portrait 390 x 844 box (a phone held upright) and in a wide
  // 1000 x 400 box (the studio's middle).
  // Verifies: 'cover' scales by the LARGER ratio and centres the overflow (the phone's full-screen
  // video is cropped left and right); 'contain' by the smaller and centres the bars (the studio
  // letterboxes); the frame's centre always lands on the box's centre; nonsense sizes give a
  // zero transform rather than NaN.
  const cover = fitTransform(1280, 720, 390, 844, 'cover');
  assertClose(cover.scale, 844 / 720, 1e-12, 'cover scale');
  assertClose(cover.dx + cover.scale * 640, 195, 1e-9, 'cover centre x');
  assertClose(cover.dy, 0, 1e-9, 'cover fills the height');

  const contain = fitTransform(1280, 720, 1000, 400, 'contain');
  assertClose(contain.scale, 400 / 720, 1e-12, 'contain scale');
  assertClose(contain.dx, (1000 - 1280 * contain.scale) / 2, 1e-9, 'contain bars left and right');
  assertClose(contain.dy + contain.scale * 360, 200, 1e-9, 'contain centre y');

  const none = fitTransform(0, 720, 100, 100);
  assert(none.scale === 0 && none.dx === 0 && none.dy === 0, 'zero for a zero-sized frame');
});

Deno.test('axesPoints and boardOutlinePoints: the board projected as projectPoints projects it', () => {
  // Setup: a camera 300 mm from the target, 50 degrees up, with some barrel distortion.
  // Verifies: the axes' origin and ends are projectPoints' of the target and of points 25 mm
  // along X, Y and Z (every end is in view, so nothing is clipped); the board's outline has
  // 4 x 16 points, its first one the board's corner at (0, 0); a camera that cannot see the origin
  // (the board behind it) gives no axes.
  const axes = axesPoints(POSE, INTRINSICS, [85, 115], 25);
  const expected = projectPoints([[85, 115, 0], [110, 115, 0], [85, 140, 0], [85, 115, 25]], POSE.R, POSE.t, INTRINSICS);
  [axes.origin, axes.x, axes.y, axes.z].forEach(([x, y], i) => {
    assertClose(x, expected[2 * i], 1e-9, `point ${i} x`);
    assertClose(y, expected[2 * i + 1], 1e-9, `point ${i} y`);
  });

  const outline = boardOutlinePoints(POSE, INTRINSICS, [170, 230]);
  const corner = projectPoints([[0, 0, 0]], POSE.R, POSE.t, INTRINSICS);
  assert(outline.length === 64, `${outline.length} points`);
  assertClose(outline[0][0], corner[0], 1e-9, 'starts at the board corner');

  const behind = { R: POSE.R.map((v, i) => (i >= 6 ? -v : v)), t: [POSE.t[0], POSE.t[1], -POSE.t[2]] };
  assert(axesPoints(behind, INTRINSICS, [85, 115]) === null, 'no axes behind the camera');
});

/** A stand-in 2D context that records the points of every path and the styles in force. */
function recordingContext() {
  const strokes = [];
  let path = [];
  const ctx = {
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    save() {},
    restore() {},
    beginPath() {
      path = [];
    },
    moveTo(x, y) {
      path.push([x, y]);
    },
    lineTo(x, y) {
      path.push([x, y]);
    },
    closePath() {},
    arc(x, y) {
      path.push([x, y]);
    },
    stroke() {
      strokes.push({ colour: ctx.strokeStyle, alpha: ctx.globalAlpha, points: [...path] });
    },
    fill() {},
    fillText() {},
  };
  return { ctx, strokes };
}

Deno.test('drawVisionOverlay: draws the board, the rock and (when asked) the axes where the transform puts them', () => {
  // Setup: a posed view with a triangular rock outline, drawn through a contain transform into an
  // 800 x 450 box, at the faded alpha, with the axes asked for (style.axes; off by default since
  // T-0340); then the same view with the default style.
  // Verifies: the board's outline, the rock's outline and the three axes are stroked in their
  // colours (each over a dark halo); the rock's points are its frame points through the
  // transform; the alpha is applied; by default no axis is drawn (none of the X, Y, Z colours,
  // `axes` null in the summary); and a view with no pose draws only the rock.
  const transform = fitTransform(1280, 720, 800, 450, 'contain');
  const contour = [[600, 300], [700, 300], [650, 400]];
  const { ctx, strokes } = recordingContext();
  drawVisionOverlay(ctx, { pose: POSE, intrinsics: INTRINSICS, targetMm: [85, 115], sizeMm: [170, 230], contour }, transform, { alpha: 0.35, axes: true });

  const colours = strokes.map((s) => s.colour);
  for (const colour of [OVERLAY_COLOURS.board, OVERLAY_COLOURS.rock, OVERLAY_COLOURS.x, OVERLAY_COLOURS.y, OVERLAY_COLOURS.z]) {
    assert(colours.includes(colour), `stroked in ${colour}`);
  }

  assert(strokes.every((s) => s.alpha === 0.35), 'faded');
  const rock = strokes.find((s) => s.colour === OVERLAY_COLOURS.rock);
  rock.points.forEach(([x, y], i) => {
    assertClose(x, transform.dx + transform.scale * contour[i][0], 1e-9, `rock point ${i} x`);
    assertClose(y, transform.dy + transform.scale * contour[i][1], 1e-9, `rock point ${i} y`);
  });

  const plain = recordingContext();
  const drawnPlain = drawVisionOverlay(plain.ctx, { pose: POSE, intrinsics: INTRINSICS, targetMm: [85, 115], sizeMm: [170, 230], contour }, transform);
  assert(drawnPlain.axes === null, 'no axes by default');
  assert(!plain.strokes.some((s) => [OVERLAY_COLOURS.x, OVERLAY_COLOURS.y, OVERLAY_COLOURS.z].includes(s.colour)), 'no axis colours by default');

  const bare = recordingContext();
  drawVisionOverlay(bare.ctx, { pose: null, intrinsics: null, targetMm: [85, 115], sizeMm: [170, 230], contour }, transform);
  assert(bare.strokes.every((s) => s.colour === OVERLAY_COLOURS.rock || s.colour === OVERLAY_COLOURS.shadow), 'only the rock without a pose');
});

// --- the chessboard grid and the axes at the board's centre (T-0331) ----------------------------

/** True when every point of a polyline is a finite pair of numbers. */
const finitePoints = (points) => points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));

Deno.test('boardGridLines: every square edge of the 23 x 17 board, each line on the projected board', () => {
  // Setup: the whole board in view -- a camera 450 mm above the board's centre at 70 degrees, no
  // lens distortion (k1 = 0), so each projected line must be straight.
  // Test: the grid of the 170 x 230 mm board of 10 mm squares.
  // Verifies: there are 24 lines along X (Y = 0, 10, ..., 230) and 18 along Y (X = 0, ..., 170),
  // the four outermost flagged as the board's edge; nothing is clipped, so each line's ends are
  // projectPoints' of the line's ends on the board; and its inner points lie on the straight
  // line between them (to 1e-6 px), i.e. the line was cut into pieces only to follow the lens.
  const intrinsics = { ...INTRINSICS, k1: 0 };
  const pose = lookAtPose([85, 115, 0], 210, 70, 450);
  const lines = boardGridLines(pose, intrinsics, [170, 230], 10);
  const alongX = lines.filter((l) => l.along === 'x');
  const alongY = lines.filter((l) => l.along === 'y');
  assert(alongX.length === 24 && alongY.length === 18, `${alongX.length} + ${alongY.length} lines`);
  assert(lines.filter((l) => l.edge).map((l) => `${l.along}${l.mm}`).join() === 'x0,x230,y0,y170', 'the edges');

  for (const line of lines) {
    const [P0, P1] = line.along === 'x' ? [[0, line.mm, 0], [170, line.mm, 0]] : [[line.mm, 0, 0], [line.mm, 230, 0]];
    const ends = projectPoints([P0, P1], pose.R, pose.t, intrinsics);
    const first = line.points[0];
    const last = line.points[line.points.length - 1];
    assertClose(first[0], ends[0], 1e-6, `${line.along}${line.mm} start x`);
    assertClose(first[1], ends[1], 1e-6, `${line.along}${line.mm} start y`);
    assertClose(last[0], ends[2], 1e-6, `${line.along}${line.mm} end x`);
    assertClose(last[1], ends[3], 1e-6, `${line.along}${line.mm} end y`);

    for (const [x, y] of line.points) {
      // distance of the point from the straight line through the ends
      const cross = (last[0] - first[0]) * (y - first[1]) - (last[1] - first[1]) * (x - first[0]);
      assertClose(cross / Math.hypot(last[0] - first[0], last[1] - first[1]), 0, 1e-6, 'on the straight line');
    }
  }
});

Deno.test('clipSegmentToView: keeps the part in front of the camera and inside the view, in 3D', () => {
  // Setup: a camera at the origin looking along +Z (R = identity, t = 0) with a 90-degree view
  // (bounds +-1 in x / z and y / z), and segments given directly in camera coordinates (with
  // R = I, board and camera coordinates are the same).
  // Verifies: a segment wholly in view is kept whole ([0, 1]); one that runs from behind the camera
  // (z = -100) to in front (z = 100) is cut where it crosses z = near (5 mm) -- s = 0.525; one that
  // leaves the view sideways is cut where x = z; one wholly behind is dropped (null).
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const bounds = { xmin: -1, xmax: 1, ymin: -1, ymax: 1 };
  const whole = clipSegmentToView([0, 0, 50], [10, 10, 80], I, [0, 0, 0], bounds, 5);
  assert(whole[0] === 0 && whole[1] === 1, `kept whole: ${whole}`);
  const behind = clipSegmentToView([0, 0, -100], [0, 0, 100], I, [0, 0, 0], bounds, 5);
  assertClose(behind[0], 0.525, 1e-12, 'cut at the near plane');
  assertClose(behind[1], 1, 1e-12, 'to the far end');
  // from (0, 0, 100) to (300, 0, 100): x = z at x = 100, s = 1/3
  const side = clipSegmentToView([0, 0, 100], [300, 0, 100], I, [0, 0, 0], bounds, 5);
  assertClose(side[1], 1 / 3, 1e-12, 'cut at the edge of the view');
  assert(clipSegmentToView([0, 0, -10], [5, 5, -50], I, [0, 0, 0], bounds, 5) === null, 'wholly behind: dropped');
});

Deno.test('boardGridLines: a strong barrel lens does not fold far lines back into the picture', () => {
  // Setup: a lens with strong barrel distortion, k1 = -0.25: its model x_d = x (1 + k1 r^2) peaks at
  // r = 1 / sqrt(3 |k1|) = 1.15 and comes back to 0 at r = 2, so a board point 2 normalised units off
  // the axis "projects" onto the middle of the picture. The camera stands low (12 degrees) and close
  // (90 mm) by the board's top edge, looking along the board, so most of each line across the board
  // runs far outside the view.
  // Test: the grid's lines, and the naive projection of one far point.
  // Verifies: the naive projection of a point at normalised (2, 0) does land in the middle of the
  // frame (the trap); every drawn point is finite and within the view's margin (25% of the frame
  // beyond each edge, plus a pixel); and along every drawn line the projected points move
  // monotonically (no fold-back), i.e. each line is clipped before the lens model breaks down.
  const intrinsics = { ...INTRINSICS, k1: -0.25 };
  const trap = projectPoints([[2 * 100, 0, 100]], [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0], intrinsics);
  assertClose(trap[0], intrinsics.cx, 1e-9, 'the naive projection folds back to the middle');

  const pose = lookAtPose([40, 115, 0], 180, 12, 90);
  const lines = boardGridLines(pose, intrinsics, [170, 230], 10);
  assert(lines.length > 5, `${lines.length} lines in view`);
  const m = 0.25;

  for (const line of lines) {
    assert(finitePoints(line.points), 'finite');

    for (const [x, y] of line.points) {
      assert(x >= -m * 1280 - 1 && x <= (1 + m) * 1280 + 1 && y >= -m * 720 - 1 && y <= (1 + m) * 720 + 1, `inside the margin: ${x}, ${y}`);
    }

    // monotonic along the line's main direction on screen
    const dxs = line.points.slice(1).map((p, i) => p[0] - line.points[i][0]);
    const dys = line.points.slice(1).map((p, i) => p[1] - line.points[i][1]);
    const main = Math.abs(dxs.reduce((a, b) => a + b, 0)) >= Math.abs(dys.reduce((a, b) => a + b, 0)) ? dxs : dys;
    const sign = Math.sign(main.reduce((a, b) => a + b, 0));
    assert(main.every((d) => d * sign >= -1e-9), `${line.along}${line.mm} folds back`);
  }
});

Deno.test('boardGridLines: at a low elevation the lines towards the horizon stop at the view, never behind the camera', () => {
  // Setup: a camera only 4 degrees above the board, 120 mm from its centre, looking across it: the
  // far lines crowd towards the horizon and the board's near edge runs past the camera's sides.
  // A second camera stands over the board's corner area looking at it from 110 mm, so the far
  // corner of the board is behind it.
  // Verifies: every line drawn is finite at the low elevation; the second camera still gets its
  // lines in front (some), and none of their points is NaN (a naive projection of the board's far
  // corner gives NaN: it is behind the camera).
  const low = lookAtPose([85, 115, 0], 0, 4, 120);
  const bounds = viewBounds(INTRINSICS);
  const lines = boardGridLines(low, INTRINSICS, [170, 230], 10);
  assert(lines.length > 10, `${lines.length} lines`);
  lines.forEach((line) => assert(finitePoints(line.points), 'finite at a low elevation'));
  assert(Number.isFinite(bounds.xmin) && bounds.xmin < 0 && bounds.xmax > 0, 'bounds');

  const above = lookAtPose([0, 0, 0], 45, 30, 110);
  const naive = projectPoints([[170, 230, 0]], above.R, above.t, INTRINSICS);
  assert(Number.isNaN(naive[0]), 'the far corner is behind the second camera');
  const seen = boardGridLines(above, INTRINSICS, [170, 230], 10);
  assert(seen.length > 0 && seen.every((line) => finitePoints(line.points)), 'lines in front, all finite');
});

Deno.test('axesPoints: at the board centre, 40 mm long; an axis leaving the view is clipped where it leaves', () => {
  // Setup: the default axes at the 23 x 17 board's centre, (85, 115), seen from a usual view; then a camera 30 mm
  // straight above the centre, so the Z axis's end (40 mm up) is behind it.
  // Verifies: boardCentreMm gives (85, 115); the axes' ends are projectPoints' of points 40 mm along
  // X, Y and Z from it; for the close camera the axes are still drawn, all finite (the Z axis cut
  // short at the near plane), while a naive projection of the Z axis's end gives NaN.
  const centre = boardCentreMm([170, 230]);
  assert(centre[0] === 85 && centre[1] === 115, `centre ${centre}`);
  const axes = axesPoints(POSE, INTRINSICS, centre);
  const ends = projectPoints([[85, 115, 0], [125, 115, 0], [85, 155, 0], [85, 115, 40]], POSE.R, POSE.t, INTRINSICS);
  [axes.origin, axes.x, axes.y, axes.z].forEach(([x, y], i) => {
    assertClose(x, ends[2 * i], 1e-9, `point ${i} x`);
    assertClose(y, ends[2 * i + 1], 1e-9, `point ${i} y`);
  });

  const close = lookAtPose([85, 115, 0], 0, 89.9, 30);
  const clipped = axesPoints(close, INTRINSICS, centre);
  assert(clipped && finitePoints([clipped.origin, clipped.x, clipped.y, clipped.z]), 'finite');
  const fullZ = projectPoints([[85, 115, 40]], close.R, close.t, INTRINSICS);
  assert(Number.isNaN(fullZ[0]), 'the whole Z axis would not project');
});

Deno.test('drawVisionOverlay: draws the grid faint, the edge strong, and reports the axes at the centre', () => {
  // Setup: a posed view with the whole board in view, drawn through a contain transform, axes asked for.
  // Verifies: the summary says 38 inner grid lines (22 + 16) and 4 edge lines were drawn, and where
  // the axes' origin landed -- the board's centre (85, 115) through the pose and the transform;
  // the inner lines are stroked in the faint grid colour, the edge in the board's colour; and with
  // style.grid false only the edge is drawn.
  const transform = fitTransform(1280, 720, 800, 450, 'contain');
  const { ctx, strokes } = recordingContext();
  const view = { pose: lookAtPose([85, 115, 0], 210, 70, 450), intrinsics: INTRINSICS, sizeMm: [170, 230], contour: null };
  const drawn = drawVisionOverlay(ctx, view, transform, { axes: true });
  assert(drawn.gridLines === 38 && drawn.edgeLines === 4, `${drawn.gridLines} grid, ${drawn.edgeLines} edge`);
  const centre = projectPoints([[85, 115, 0]], view.pose.R, view.pose.t, INTRINSICS);
  assertClose(drawn.axes.origin[0], transform.dx + transform.scale * centre[0], 1e-9, 'axes origin x');
  assertClose(drawn.axes.origin[1], transform.dy + transform.scale * centre[1], 1e-9, 'axes origin y');
  assert(strokes.filter((s) => s.colour === OVERLAY_COLOURS.grid).length === 38, 'inner lines in the grid colour');
  assert(strokes.filter((s) => s.colour === OVERLAY_COLOURS.board).length === 4, 'edges in the board colour');

  const edgeOnly = recordingContext();
  const plain = drawVisionOverlay(edgeOnly.ctx, view, transform, { grid: false });
  assert(plain.gridLines === 0 && plain.edgeLines === 4, 'grid off: the edge only');
});

Deno.test('foundCornerGraph: corner ids to board points, and the neighbours among them', () => {
  // Setup: the 23 x 17 board of 10 mm squares (22 corners per row, 16 rows), and a set of found
  // ids: a 2 x 2 block (0, 1, 22, 23), the last corner of the first row (21) and the first of the
  // second row (22) -- adjacent ids that are NOT neighbours on the board -- plus a repeat, an id past
  // the board's last corner (352) and a non-integer.
  // Test: build the graph.
  // Verifies: each id sits where board_frame.js puts it ((row + 1), (col + 1)) squares, X down the
  // rows, Y along the columns (0 at (10, 10), 21 at (10, 220), 22 at (20, 10)); exactly the four
  // block edges join neighbours (0-1, 0-22, 1-23, 22-23), never 21-22, which wraps across a row end;
  // and the repeat and the ids off the board are dropped.
  const graph = foundCornerGraph([0, 1, 22, 23, 21, 1, 352, 2.5], [170, 230], 10);
  assert(graph.points.size === 5, `${graph.points.size} points`);
  assert(JSON.stringify(graph.points.get(0)) === '[10,10,0]', 'corner 0');
  assert(JSON.stringify(graph.points.get(21)) === '[10,220,0]', 'corner 21, end of the first row');
  assert(JSON.stringify(graph.points.get(22)) === '[20,10,0]', 'corner 22, start of the second row');
  const edges = graph.edges.map(([a, b]) => `${a}-${b}`).sort();
  assert(JSON.stringify(edges) === JSON.stringify(['0-1', '0-22', '1-23', '22-23']), `edges ${edges}`);
});

Deno.test('drawVisionOverlay: red points on the found corners, blue lines between neighbours, placed through the pose', () => {
  // Setup: a posed view of the whole board, drawn through a contain transform, with found corners
  // forming a 3 x 3 block around the board's middle (rows 7-9, columns 9-11: 9 corners, 12
  // neighbour pairs), as the phone draws them (grid off).
  // Test: draw, recording every path.
  // Verifies: 9 red points and 12 blue lines are reported; the blue lines are stroked in the found-
  // line colour, each between two of the corners' projected positions; the first point drawn is
  // corner (row 7, col 9)'s board point (80, 100) projected through the pose and the transform,
  // i.e. the points follow the pose, not any detected pixel; and without ids nothing extra is drawn.
  const transform = fitTransform(1280, 720, 800, 450, 'contain');
  const pose = lookAtPose([85, 115, 0], 210, 70, 450);
  const ids = [];

  for (let row = 7; row <= 9; row += 1) {
    for (let col = 9; col <= 11; col += 1) {
      ids.push(row * 22 + col);
    }
  }

  const { ctx, strokes } = recordingContext();
  const arcs = [];
  ctx.arc = (x, y) => arcs.push([x, y]);
  const view = { pose, intrinsics: INTRINSICS, sizeMm: [170, 230], contour: null, foundCornerIds: ids };
  const drawn = drawVisionOverlay(ctx, view, transform, { grid: false });
  assert(drawn.foundCorners === 9 && drawn.foundLines === 12, `${drawn.foundCorners} points, ${drawn.foundLines} lines`);
  assert(strokes.filter((s) => s.colour === OVERLAY_COLOURS.foundLine).length === 12, 'lines in the found-line colour');

  const first = projectPoints([[80, 100, 0]], pose.R, pose.t, INTRINSICS);
  assertClose(arcs[0][0], transform.dx + transform.scale * first[0], 1e-9, 'first point x');
  assertClose(arcs[0][1], transform.dy + transform.scale * first[1], 1e-9, 'first point y');

  const none = drawVisionOverlay(recordingContext().ctx, { ...view, foundCornerIds: null }, transform, { grid: false });
  assert(none.foundCorners === 0 && none.foundLines === 0, 'no ids, no points');
  assert(drawn.cornersFrom === 'pose' && none.cornersFrom === null, 'which path drew the points');
});

Deno.test('drawVisionOverlay: without a pose, the detected corners are drawn where they were found (T-0335)', () => {
  // Setup: NO pose (the board found, but its pose failed its checks: the case the user hit on the
  // real board, "still not showing the board"). The latest detection's corners, as the detector
  // gives them ({ id, x, y } in frame pixels): a 3 x 3 block of corners (rows 7-9, columns 9-11 of
  // the 23 x 17 board: 9 corners, 12 neighbour pairs) at made-up pixels 40 px apart, plus a repeat
  // of one id at another pixel (kept once), an id beyond the board (dropped) and a corner with a
  // NaN position (dropped). The phone's cover transform of a 1280 x 720 frame on a 844 x 390 screen.
  // Test: draw with detectedCorners, recording every path and every point; then draw the same
  // detection WITH a pose (and no foundCornerIds), and without the board's size.
  // Verifies: 9 red points and 12 blue lines, reported as from the 'detection'; each point at its
  // corner's detected pixel through the transform (no pose involved); each blue line stroked in the
  // found-line colour between two neighbours' pixels (a row neighbour 40 px to the right, a column
  // neighbour 40 px down); with a pose the detected pixels are ignored (the posed path places the
  // points, here none since no ids are given), so the two paths never draw twice; and without the
  // board's size (no way to tell neighbours) nothing is drawn.
  const transform = fitTransform(1280, 720, 844, 390, 'cover');
  const corners = [];

  for (let row = 7; row <= 9; row += 1) {
    for (let col = 9; col <= 11; col += 1) {
      corners.push({ id: row * 22 + col, x: 500 + 40 * (col - 9), y: 300 + 40 * (row - 7) });
    }
  }

  const detected = [...corners, { id: corners[0].id, x: 5, y: 5 }, { id: 22 * 16 + 3, x: 10, y: 10 }, { id: 3, x: NaN, y: 4 }];
  const { ctx, strokes } = recordingContext();
  const arcs = [];
  ctx.arc = (x, y) => arcs.push([x, y]);
  const view = { pose: null, intrinsics: null, sizeMm: [170, 230], contour: null, foundCornerIds: null, detectedCorners: detected };
  const drawn = drawVisionOverlay(ctx, view, transform, { grid: false });

  assert(drawn.foundCorners === 9 && drawn.foundLines === 12, `${drawn.foundCorners} points, ${drawn.foundLines} lines`);
  assert(drawn.cornersFrom === 'detection', `from ${drawn.cornersFrom}`);
  const at = (corner) => [transform.dx + transform.scale * corner.x, transform.dy + transform.scale * corner.y];
  corners.forEach((corner, i) => {
    assertClose(arcs[i][0], at(corner)[0], 1e-9, `point ${i} x`);
    assertClose(arcs[i][1], at(corner)[1], 1e-9, `point ${i} y`);
  });

  const lines = strokes.filter((s) => s.colour === OVERLAY_COLOURS.foundLine);
  assert(lines.length === 12, `${lines.length} blue lines`);
  const step = 40 * transform.scale;
  assert(lines.every(({ points: [[ax, ay], [bx, by]] }) => Math.abs(Math.hypot(bx - ax, by - ay) - step) < 1e-9),
    'every line joins two neighbours one square (40 px) apart');

  const posed = drawVisionOverlay(recordingContext().ctx, { ...view, pose: lookAtPose([85, 115, 0], 210, 70, 450), intrinsics: INTRINSICS },
    transform, { grid: false });
  assert(posed.foundCorners === 0 && posed.cornersFrom === null, 'with a pose the detected pixels are not drawn');

  const sizeless = drawVisionOverlay(recordingContext().ctx, { ...view, sizeMm: null }, transform, { grid: false });
  assert(sizeless.foundCorners === 0, 'no board size, nothing drawn');
});

Deno.test('markerCornersMm: each marker in its light square, numbered row by row, as OpenCV lays the board out', () => {
  // Setup: the scanners' layout: 23 columns x 17 rows of 10 mm squares (sizeMm [170, 230]: X down
  // the rows, Y along the columns), 7 mm markers.
  // Test: the corners of marker 0, 10 (the last in row 0), 11 (the first in row 1), 194 (the last)
  // and 195 (beyond the board), and every marker's centre.
  // Verifies: square (0, 0) is dark, so row 0's first marker is in column 1 and row 1's in column 0
  // (charuco.rs CharucoBoard::new: markers where row + column is odd); each marker is 7 mm, inset
  // 1.5 mm in its square, its corners in the detector's order (+column, then +row, then -column);
  // rows alternate 11 and 12 markers, 195 in all, so id 195 is null; and no two markers share a
  // square.
  const size = [170, 230];
  const m0 = markerCornersMm(0, size, 10, 7);
  assert(JSON.stringify(m0) === JSON.stringify([[1.5, 11.5, 0], [1.5, 18.5, 0], [8.5, 18.5, 0], [8.5, 11.5, 0]]), `marker 0 ${JSON.stringify(m0)}`);
  assert(markerCornersMm(10, size, 10, 7)[0].join() === '1.5,211.5,0', 'marker 10: row 0, column 21');
  assert(markerCornersMm(11, size, 10, 7)[0].join() === '11.5,1.5,0', 'marker 11: row 1, column 0');
  assert(markerCornersMm(194, size, 10, 7)[0].join() === '161.5,211.5,0', 'marker 194: row 16, column 21');
  assert(markerCornersMm(195, size, 10, 7) === null && markerCornersMm(-1, size) === null, 'beyond the board');

  const squares = new Set();

  for (let id = 0; id < 195; id += 1) {
    const [a, , c] = markerCornersMm(id, size, 10, 7);
    const row = Math.floor((a[0] + c[0]) / 20);
    const column = Math.floor((a[1] + c[1]) / 20);
    assert((row + column) % 2 === 1, `marker ${id} on a light square`);
    squares.add(`${row},${column}`);
  }

  assert(squares.size === 195, 'one marker per square');
});

Deno.test('fitHomography: recovers a plane-to-picture map from four or more points; null for a line', () => {
  // Setup: a known homography H (a tilted board seen in perspective), and board points on a 5 x 4
  // grid (mm) mapped through it; then four points on one line.
  // Test: fit from all 20 points, and from just the four corners of the grid.
  // Verifies: both fits map every grid point to within 1e-6 px of H's image of it (the fit is
  // exact on exact data, h33 normalised to 1); applyHomography returns null beyond the horizon
  // (w <= 0); points on a line give null (no plane to fit).
  const H = [1.2, 0.15, 300, -0.1, 0.9, 200, 0.0006, -0.0004, 1];
  const board = [];

  for (let i = 0; i < 5; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      board.push([40 * i, 50 * j]);
    }
  }

  const pixels = board.map((P) => applyHomography(H, P));

  for (const from of [board, [board[0], board[3], board[16], board[19]]]) {
    const to = from.map((P) => applyHomography(H, P));
    const fit = fitHomography(from, to);
    assert(fit, 'a fit');
    board.forEach((P, k) => {
      const q = applyHomography(fit, P);
      assertClose(q[0], pixels[k][0], 1e-6, `x of ${P}`);
      assertClose(q[1], pixels[k][1], 1e-6, `y of ${P}`);
    });
  }

  assert(applyHomography([1, 0, 0, 0, 1, 0, -1, 0, 1], [2, 0]) === null, 'beyond the horizon');
  const line = [[0, 0], [10, 10], [20, 20], [30, 30]];
  assert(fitHomography(line, line.map(([x, y]) => [2 * x, 3 * y])) === null, 'points on a line');
});

Deno.test('markerGridLines: the whole board through the markers found, where the pose would put it', () => {
  // Setup: a camera (no lens distortion: a homography models exactly that) looking at the board's
  // middle from 400 mm, 60 degrees up; markers 80 and 81 (two neighbours in the board's middle)
  // and chessboard corner 200 "found" where that camera sees them.
  // Test: markerGridLines from that detection; then from marker 80 alone.
  // Verifies: two markers give a grid: 24 lines along X (one per column edge) and 18 along Y (one
  // per row edge): the 23 x 17 board's every square edge, the outermost flagged as the edge; its homography puts every corner of the whole
  // board within 0.01 px of where the camera projects it (so the grid drawn from two markers in
  // the middle lands on the printed squares out to the edges); one marker alone is not enough
  // (null: GRID_MIN_MARKERS).
  const lens = { ...INTRINSICS, k1: 0 };
  const pose = lookAtPose([85, 115, 0], 30, 60, 400);
  const size = [170, 230];
  const project = (P) => {
    const p = projectPoints([P], pose.R, pose.t, lens);
    return [p[0], p[1]];
  };
  const markers = [80, 81].map((id) => ({ id, corners: markerCornersMm(id, size, 10, 7).map(project) }));
  const graph = foundCornerGraph([200], size);
  const corners = [{ id: 200, ...Object.fromEntries(['x', 'y'].map((k, i) => [k, project(graph.points.get(200))[i]])) }];
  const out = markerGridLines({ markers, corners }, size, 10, 7);
  assert(out, 'a grid from two markers');
  assert(out.lines.filter((l) => l.along === 'x').length === 24 && out.lines.filter((l) => l.along === 'y').length === 18, `${out.lines.length} lines`);
  assert(out.lines.filter((l) => l.edge).length === 4, 'four edges');

  for (let X = 0; X <= 170; X += 10) {
    for (let Y = 0; Y <= 230; Y += 10) {
      const q = applyHomography(out.H, [X, Y]);
      const p = project([X, Y, 0]);
      assert(Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.01, `board point (${X}, ${Y}): ${q} vs ${p}`);
    }
  }

  assert(markerGridLines({ markers: markers.slice(0, 1), corners: [] }, size, 10, 7) === null, 'one marker: no grid');
});

Deno.test('drawVisionOverlay with the whole grid (T-0350): every square edge in blue, red found corners, with or without a pose', () => {
  // Setup: the whole board in view (a camera 450 mm from its middle, 70 degrees up), drawn through
  // a contain transform with style.grid 'full' (the phone's), and found corners forming a 3 x 3
  // block; then the same board with NO pose but a detection of two markers and those corners at
  // the pixels a lens-free camera sees them; then that detection with one marker only.
  // Test: draw each, recording every path.
  // Verifies: with a pose, all 38 inner lines are stroked in the found-line blue and the 4 edge
  // lines in the board's white, from the pose ('pose'), with 9 red points and no separate lines
  // between found corners (the grid has them); without a pose, the same 38 + 4 lines from the
  // markers ('markers') and a red point on each detected corner; with one marker, no grid, and the
  // detected corners drawn as before (T-0335's red points and blue lines).
  const transform = fitTransform(1280, 720, 800, 450, 'contain');
  const lens = { ...INTRINSICS, k1: 0 };
  const pose = lookAtPose([85, 115, 0], 210, 70, 450);
  const size = [170, 230];
  const ids = [];

  for (let row = 7; row <= 9; row += 1) {
    for (let col = 9; col <= 11; col += 1) {
      ids.push(row * 22 + col);
    }
  }

  const posed = recordingContext();
  const drawn = drawVisionOverlay(posed.ctx, { pose, intrinsics: lens, sizeMm: size, foundCornerIds: ids }, transform, { grid: 'full' });
  assert(drawn.gridFrom === 'pose' && drawn.gridLines === 38 && drawn.edgeLines === 4, `posed: ${JSON.stringify(drawn)}`);
  assert(drawn.foundCorners === 9 && drawn.foundLines === 0 && drawn.cornersFrom === 'pose', `posed points: ${JSON.stringify(drawn)}`);
  assert(posed.strokes.filter((s) => s.colour === OVERLAY_COLOURS.foundLine).length === 38, 'inner lines in blue');
  assert(posed.strokes.filter((s) => s.colour === OVERLAY_COLOURS.board).length === 4, 'edges in white');

  const project = (P) => {
    const p = projectPoints([P], pose.R, pose.t, lens);
    return [p[0], p[1]];
  };
  const graph = foundCornerGraph(ids, size);
  const detection = {
    markers: [80, 81].map((id) => ({ id, corners: markerCornersMm(id, size, 10, 7).map(project) })),
    corners: ids.map((id) => {
      const [x, y] = project(graph.points.get(id));
      return { id, x, y };
    }),
  };
  const bare = recordingContext();
  const fromMarkers = drawVisionOverlay(bare.ctx, { pose: null, intrinsics: null, sizeMm: size, detection, detectedCorners: detection.corners },
    transform, { grid: 'full' });
  assert(fromMarkers.gridFrom === 'markers' && fromMarkers.gridLines === 38 && fromMarkers.edgeLines === 4, `markers: ${JSON.stringify(fromMarkers)}`);
  assert(fromMarkers.foundCorners === 9 && fromMarkers.cornersFrom === 'detection', `markers' points: ${JSON.stringify(fromMarkers)}`);

  const one = { ...detection, markers: detection.markers.slice(0, 1) };
  const fallback = drawVisionOverlay(recordingContext().ctx, { pose: null, intrinsics: null, sizeMm: size, detection: one, detectedCorners: one.corners },
    transform, { grid: 'full' });
  assert(fallback.gridFrom === null && fallback.foundCorners === 9 && fallback.foundLines === 12, `one marker: ${JSON.stringify(fallback)}`);
});
