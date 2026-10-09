/*
 * vision_board_fit_test.js -- whether the markers found are laid out as the scanner board prints
 * them (T-0335): src/web/src/lib/vision/board_fit.js.
 *
 * The phone supports one board, the strip sheet. Another ChArUco board with the same markers (the
 * scanner's older 22 x 22 reference board, for one) is read just as well, marker by marker, but its
 * markers sit in other squares; board_fit.js tells the two apart from the markers' positions alone.
 * These tests need no OpenCV and no wasm: the detections are made here, by projecting each
 * marker's four corners through a known camera (tests/vision_test_support.js lookAtPose and
 * camera_model.js projectPoints, with lens distortion), and labelling them with the ids of
 * whichever board is "printed". The real-footage margins are measured in the kb article
 * phone-vision-wrong-board-test and in tests/harness (the phone page on the reference clips).
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 */

import { BOARD_SPEC } from '../src/lib/vision/board_frame.js';
import {
  boardFit, fitHomography, FITS_MARKERS, FITS_SHARE, MIN_FIT_MARKERS, WRONG_MARKERS, WRONG_SHARE,
} from '../src/lib/vision/board_fit.js';
import { projectPoints } from '../src/lib/vision/camera_model.js';
import { assert, assertClose, gaussian, lookAtPose, seededRandom } from './vision_test_support.js';
import { REFERENCE_22X22 } from './vision_test_boards.js';

const WIDTH = 1280;
const HEIGHT = 720;

/**
 * A detection of `printed` (a spec) seen from a camera at azimuth / elevation / distance around
 * `target` (board mm), f px and lens k1: every marker whose four corners land inside the frame, its
 * id the printed board's own, its corners projected (OpenCV's order: the marker's top-left, top-right,
 * bottom-right, bottom-left in its board), with `noise` px of Gaussian noise.
 */
function detectionOf(printed, { target, azimuthDeg, elevationDeg, distanceMm, f = 1000, k1 = 0, noise = 0.3, seed = 1 }) {
  const { R, t } = lookAtPose(target, azimuthDeg, elevationDeg, distanceMm, 10);
  const K = { width: WIDTH, height: HEIGHT, f, cx: WIDTH / 2, cy: HEIGHT / 2, k1 };
  const random = seededRandom(seed);
  const square = printed.square_mm;
  const half = ((printed.marker_mm ?? printed.marker_ratio * square) / 2);
  const markers = [];
  let id = 0;

  for (let row = 0; row < printed.squares_y; row += 1) {
    for (let col = 0; col < printed.squares_x; col += 1) {
      if ((row + col) % 2 !== 1) {
        continue;
      }

      // The marker's centre in the board frame: X down the rows, Y along the columns (mm).
      const X = (row + 0.5) * square;
      const Y = (col + 0.5) * square;
      // OpenCV's corner order in its own frame (x along columns, y down rows), mapped to (X, Y).
      const corners = [[-half, -half], [half, -half], [half, half], [-half, half]].map(([dx, dy]) => [X + dy, Y + dx, 0]);
      const p = projectPoints(corners, R, t, K);
      const pixels = [0, 1, 2, 3].map((k) => [p[2 * k] + noise * gaussian(random), p[2 * k + 1] + noise * gaussian(random)]);

      if (pixels.every(([x, y]) => x > 2 && y > 2 && x < WIDTH - 2 && y < HEIGHT - 2)) {
        markers.push({ id, corners: pixels });
      }

      id += 1;
    }
  }

  return { markers };
}

Deno.test('fitHomography: exact through four points, least squares through many, null when degenerate', () => {
  // Setup: a known homography H (a perspective one, h33 = 1) and points on a 5 x 4 grid in board
  // squares, mapped through it.
  // Test: fit from the first four (a quadrilateral), from all twenty, from all twenty with 0.2 px
  // noise, and from four collinear points.
  // Verifies: the four-point and twenty-point fits reproduce H to 1e-6 (element-wise, normalised),
  // the noisy fit maps the points back within 0.5 px, and a line of points gives null instead of
  // a garbage matrix.
  const H = [42, 3, 210, -2, 39, 95, 0.004, -0.002, 1];
  const map = ([x, y]) => {
    const w = H[6] * x + H[7] * y + 1;
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  };
  const grid = [];

  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      grid.push([2 * x + 0.5, 3 * y + 0.5]);
    }
  }

  const quad = [grid[0], grid[4], grid[19], grid[15]];
  const four = fitHomography(quad, quad.map(map));
  const all = fitHomography(grid, grid.map(map));
  four.forEach((v, i) => assertClose(v, H[i], 1e-6 * Math.max(1, Math.abs(H[i])), `four-point H[${i}]`));
  all.forEach((v, i) => assertClose(v, H[i], 1e-6 * Math.max(1, Math.abs(H[i])), `twenty-point H[${i}]`));

  const random = seededRandom(7);
  const noisy = grid.map(map).map(([x, y]) => [x + 0.2 * gaussian(random), y + 0.2 * gaussian(random)]);
  const fitted = fitHomography(grid, noisy);
  grid.forEach((point, i) => {
    const w = fitted[6] * point[0] + fitted[7] * point[1] + fitted[8];
    const back = [(fitted[0] * point[0] + fitted[1] * point[1] + fitted[2]) / w, (fitted[3] * point[0] + fitted[4] * point[1] + fitted[5]) / w];
    assert(Math.hypot(back[0] - noisy[i][0], back[1] - noisy[i][1]) < 0.5, `noisy point ${i} back off by more than 0.5 px`);
  });

  const line = [[0, 0], [1, 1], [2, 2], [3, 3]];
  assert(fitHomography(line, line.map(map)) === null, 'collinear points gave a homography');
});

Deno.test('boardFit: the strip board fits from every view, through strong lens distortion', () => {
  // Setup: detections of the strip board itself from 36 cameras: azimuth every 60 degrees,
  // elevation 25 / 50 / 85 degrees, 180 and 320 mm from its target, with k1 = -0.2 (strong barrel)
  // or +0.15, 0.3 px of corner noise.
  // Test: boardFit against the strip spec.
  // Verifies: every view with enough markers is 'fits' (at least FITS_SHARE of its markers
  // agreeing; the harshest view here, k1 -0.2 close and low, keeps 0.86, and the real-footage
  // floor for a true board was 0.875, T-0335), and none is ever 'wrong'.
  let lowest = 1;
  let judged = 0;

  for (const azimuthDeg of [0, 60, 120, 180, 240, 300]) {
    for (const elevationDeg of [25, 50, 85]) {
      for (const [distanceMm, k1] of [[180, -0.2], [320, 0.15]]) {
        const detection = detectionOf(BOARD_SPEC, { target: [80, 110], azimuthDeg, elevationDeg, distanceMm, k1, seed: azimuthDeg + elevationDeg });
        const fit = boardFit(detection, BOARD_SPEC);
        const view = `azimuth ${azimuthDeg}, elevation ${elevationDeg}, ${distanceMm} mm: ${JSON.stringify(fit)}`;

        assert(fit.verdict !== 'wrong', `the strip board judged wrong at ${view}`);

        if (fit.markers >= FITS_MARKERS) {
          judged += 1;
          lowest = Math.min(lowest, fit.share);
          assert(fit.verdict === 'fits' && fit.share >= FITS_SHARE, `the strip board not clearly fitting at ${view}`);
        }
      }
    }
  }

  console.log(`  ${judged} views judged, lowest share ${lowest.toFixed(3)}`);
  assert(judged >= 30, `only ${judged} views had enough markers`);
});

Deno.test('boardFit: the older 22 x 22 reference board does not fit the strip layout', () => {
  // Setup: detections of the 22 x 22 reference board (0.689 markers; vision_test_boards.js) from
  // 18 cameras around its middle (azimuth every 60 degrees, elevation 30 / 55 / 80, 260 mm), its
  // markers carrying the reference board's own ids, as the detector reads them.
  // Test: boardFit against the STRIP spec, and as a control against the reference board's own.
  // Verifies: against the strip, every view is 'wrong' with under WRONG_SHARE of its markers
  // agreeing; against its own layout every view 'fits' (so the test tells layouts apart, not
  // marker sizes or lens effects).
  for (const azimuthDeg of [0, 60, 120, 180, 240, 300]) {
    for (const elevationDeg of [30, 55, 80]) {
      const detection = detectionOf(REFERENCE_22X22, { target: [110, 110], azimuthDeg, elevationDeg, distanceMm: 260, k1: -0.05, seed: azimuthDeg + elevationDeg });
      const strip = boardFit(detection, BOARD_SPEC);
      const own = boardFit(detection, REFERENCE_22X22);
      const view = `azimuth ${azimuthDeg}, elevation ${elevationDeg}`;

      assert(strip.verdict === 'wrong' && strip.share < WRONG_SHARE, `${view}: against the strip ${JSON.stringify(strip)}`);
      assert(own.verdict === 'fits', `${view}: against its own layout ${JSON.stringify(own)}`);
    }
  }
});

Deno.test('boardFit: too few markers are unsure, a few misread ids do not spoil a fit, and the verdict repeats', () => {
  // Setup: one detection of the strip board (azimuth 30, elevation 50, 250 mm, k1 -0.05).
  // Test: (a) keep only its first MIN_FIT_MARKERS - 1 markers; (b) the first 10 markers by id, one
  // row of the board (on a line); (c) 10 markers from three rows (enough to fit, too few for a clear
  // verdict); (d) the whole detection with 4 markers' ids swapped for ids from the far end of the
  // board (misreads); (e) the same detection twice.
  // Verifies: (a) 'unsure' with share null; (b) 'unsure' with share null -- markers on a line fix
  // no homography, and must never read as 'wrong' (a row of markers along a frame's edge is an
  // everyday view); (c) 'unsure' although every marker agrees (fits needs FITS_MARKERS); (d) still
  // 'fits', the four misread markers the only ones not agreeing; (e) the same verdict and counts
  // both times (the samples are seeded, not random).
  const detection = detectionOf(BOARD_SPEC, { target: [80, 110], azimuthDeg: 30, elevationDeg: 50, distanceMm: 250, k1: -0.05 });
  assert(detection.markers.length > 60, `${detection.markers.length} markers in view`);
  assert(WRONG_MARKERS < FITS_MARKERS && WRONG_SHARE < FITS_SHARE, 'the verdicts leave a middle ground');

  const few = boardFit({ markers: detection.markers.slice(0, MIN_FIT_MARKERS - 1) }, BOARD_SPEC);
  assert(few.verdict === 'unsure' && few.share === null, `few: ${JSON.stringify(few)}`);

  // The strip board's marker rows: 11 markers on even rows, 12 on odd ones (23 columns).
  const rowOf = (id) => 2 * Math.floor(id / 23) + (id % 23 >= 11 ? 1 : 0);
  const byRow = new Map();
  detection.markers.forEach((m) => byRow.set(rowOf(m.id), [...(byRow.get(rowOf(m.id)) ?? []), m]));
  const fullest = [...byRow.values()].sort((a, b) => b.length - a.length)[0];
  assert(fullest.length >= 8, `the fullest row has ${fullest.length} markers`);
  const line = boardFit({ markers: fullest }, BOARD_SPEC);
  assert(line.markers >= WRONG_MARKERS && line.verdict === 'unsure' && line.share === null, `one row: ${JSON.stringify(line)}`);

  const rows = [...byRow.keys()].sort((a, b) => a - b).slice(2, 5).flatMap((r) => byRow.get(r)).filter((_, k) => k % 3 === 0).slice(0, 10);
  const ten = boardFit({ markers: rows }, BOARD_SPEC);
  assert(ten.markers === 10 && ten.verdict === 'unsure' && ten.share === 1, `ten from three rows: ${JSON.stringify(ten)}`);

  const misread = detection.markers.map((m, k) => (k % 15 === 3 && k < 60 ? { ...m, id: 194 - k } : m));
  const swapped = boardFit({ markers: misread }, BOARD_SPEC);
  assert(swapped.verdict === 'fits' && swapped.markers - swapped.agreeing === 4, `misread: ${JSON.stringify(swapped)}`);

  assert(JSON.stringify(boardFit(detection, BOARD_SPEC)) === JSON.stringify(boardFit(detection, BOARD_SPEC)), 'the same verdict twice');
});
