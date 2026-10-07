/*
 * vision_guidance_test.js -- the phone's scan guidance (T-0331): src/web/src/lib/vision/guidance.js.
 * Where the rock is, where the camera is around it, which sides and heights have been filmed, what
 * to do next, how fast the board moves, and the warnings' on/off timing.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * Poses come from vision_test_support.lookAtPose (azimuth measured as pose.js and the desktop
 * measure it: the camera's direction from the target, from +X towards +Y), so every expected angle is
 * known exactly. Nothing here needs OpenCV or pixels.
 */

import {
  angleText, bandOf, boardSpeed, clockHour, coverageAdvice, coverageMapCells, coverageSummary, createCoverage,
  createRockLocator, createScanGuide, createWarningFilter, emptyRuns, FULL_RING, mapPoint, MAX_SPEED_MM_S,
  pixelRay, polygonCentroid, raysConvergence, runText, sectorOf, SPEED_HOLD_MS, symmetricEigenvalues, viewAngles,
  WARNING_OFF_MS, WARNING_ON_MS,
} from '../src/lib/vision/guidance.js';
import { projectPoints } from '../src/lib/vision/camera_model.js';
import { assert, assertClose, gaussian, lookAtPose, seededRandom } from './vision_test_support.js';

const INTRINSICS = { width: 1280, height: 720, f: 1000, cx: 640, cy: 360, k1: 0.02 };
const FRAME = { width: 1280, height: 720 };
/** The strip sheet's target (a chessboard corner) and a rock standing on it, its middle 5 mm up. */
const TARGET = [80, 110];
const ROCK = [80, 110, 5];

/** A valid CameraPose looking at `at` from (azimuth, elevation, distance). */
function pose(at, azimuthDeg, elevationDeg, distanceMm, rollDeg = 0) {
  return { ...lookAtPose(at, azimuthDeg, elevationDeg, distanceMm, rollDeg), intrinsics: INTRINSICS, valid: true };
}

/** The outline a camera would see of a rock: a 24-point circle of radius `r` mm around ROCK, projected. */
function rockOutline(p, r = 9, timeMs = 0) {
  const ring = [];

  for (let k = 0; k < 24; k += 1) {
    const a = (k / 24) * 2 * Math.PI;
    ring.push([ROCK[0] + r * Math.cos(a), ROCK[1] + r * Math.sin(a), ROCK[2]]);
  }

  const uv = projectPoints(ring, p.R, p.t, INTRINSICS);
  const contour = ring.map((_, i) => [uv[2 * i], uv[2 * i + 1]]);
  const xs = contour.map((c) => c[0]);
  const ys = contour.map((c) => c[1]);
  return {
    frame: { ...FRAME, timeMs },
    contour,
    box: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
    confidence: 0.9,
    flags: [],
  };
}

Deno.test('viewAngles, clockHour and angleText: the desktop convention, told as a clock seen from above', () => {
  // Setup: cameras at known azimuths and elevations around the rock (lookAtPose's centre).
  // Verifies: viewAngles gives back the azimuth (from +X towards +Y), elevation and distance;
  // clockHour puts +X (down the page) at 6 o'clock, +Y (right) at 3, -X (the top edge) at 12 and -Y
  // at 9, as advice.clock_hour; angleText says "35° above the board, from 2 o'clock" (2 o'clock is
  // azimuth 120: up and to the right of the sheet), with the distance when asked.
  for (const [az, el, d] of [[0, 30, 200], [120, 35, 180], [250, 70, 150], [359, 5, 220]]) {
    const view = viewAngles(lookAtPose(ROCK, az, el, d).center, ROCK);
    assertClose(view.azimuthDeg, az, 1e-9, 'azimuth');
    assertClose(view.elevationDeg, el, 1e-9, 'elevation');
    assertClose(view.distanceMm, d, 1e-9, 'distance');
  }

  assert(clockHour(0) === 6 && clockHour(90) === 3 && clockHour(180) === 12 && clockHour(270) === 9, 'clock');
  assert(angleText({ azimuthDeg: 120, elevationDeg: 35.2, distanceMm: 183 }) === "35° above the board, from 2 o'clock", 'angle text');
  assert(angleText({ azimuthDeg: 0, elevationDeg: 10, distanceMm: 95 }, { distance: true }) === "10° above the board, from 6 o'clock, 9.5 cm away", 'with distance');
});

Deno.test('bands, sectors, empty runs and their clock words', () => {
  // Setup: ring masks with known filmed sectors (bit k = azimuth 30k..30k+30).
  // Verifies: the four bands split at 20, 40 and 60 degrees; sectors are 30 degrees from +X;
  // emptyRuns finds separate runs ([30, 90) and [330, 360)) and merges a run through 0 degrees
  // (sectors 11 and 0 -> [330, 390)); runText names a run as clock positions -- [30, 90) is "the 3 to
  // 5 o'clock side" (advice.gap_text's hours) and the run through 0, around +X (the bottom of the
  // sheet), "the 5 to 7 o'clock side"; an empty ring is one run all the way round, a full one none.
  assert([5, 19.9, 20, 39, 40, 59, 60, 89].map(bandOf).join() === '0,0,1,1,2,2,3,3', 'bands');
  assert([0, 29.9, 30, 359, 360, -10].map(sectorOf).join() === '0,0,1,11,0,11', 'sectors');
  const runs = emptyRuns(FULL_RING & ~((1 << 1) | (1 << 2) | (1 << 11)));
  assert(JSON.stringify(runs) === JSON.stringify([[30, 90], [330, 360]]), `runs ${JSON.stringify(runs)}`);
  const wrap = emptyRuns(FULL_RING & ~((1 << 11) | (1 << 0)));
  assert(JSON.stringify(wrap) === JSON.stringify([[330, 390]]), `wrapped run ${JSON.stringify(wrap)}`);
  assert(runText([30, 90]) === "the 3 to 5 o'clock side", runText([30, 90]));
  assert(runText([330, 390]) === "the 5 to 7 o'clock side", runText([330, 390]));
  assert(JSON.stringify(emptyRuns(0)) === '[[0,360]]' && emptyRuns(FULL_RING).length === 0, 'empty and full');
  assert(runText([0, 360]) === 'all the way round', 'all round');
});

Deno.test('raysConvergence and symmetricEigenvalues: the point nearest to rays, and how well they pin it', () => {
  // Setup: three rays through (80, 110, 5) from cameras 90 degrees apart, and a 3 x 3 symmetric
  // matrix with known eigenvalues (diag(1, 2, 3) rotated).
  // Verifies: the rays meet at the point (1e-9 mm) with zero residuals; the eigenvalues come back
  // sorted (1e-9); two parallel rays give a near-zero smallest eigenvalue (they do not pin depth).
  const rays = [0, 90, 180].map((az) => {
    const c = lookAtPose(ROCK, az, 40, 180).center;
    const d = ROCK.map((v, i) => v - c[i]);
    return { origin: c, dir: d.map((v) => v / Math.hypot(...d)) };
  });
  const fit = raysConvergence(rays);
  fit.point.forEach((v, i) => assertClose(v, ROCK[i], 1e-9, `point ${i}`));
  fit.residuals.forEach((r) => assertClose(r, 0, 1e-9, 'residual'));

  const c = Math.cos(0.3);
  const s = Math.sin(0.3);
  // R diag(1, 2, 3) R^T with R a rotation about Z
  const A = [c * c * 1 + s * s * 2, c * s * (1 - 2), 0, c * s * (1 - 2), s * s * 1 + c * c * 2, 0, 0, 0, 3];
  symmetricEigenvalues(A).forEach((v, i) => assertClose(v, i + 1, 1e-9, `eigenvalue ${i}`));

  const parallel = raysConvergence([rays[0], { origin: rays[0].origin.map((v) => v + 1), dir: rays[0].dir }]);
  assert(parallel === null || parallel.minEigen < 1e-6, 'parallel rays do not pin the point');
});

Deno.test('pixelRay and polygonCentroid: the ray through a pixel passes through the board point seen there', () => {
  // Setup: a posed camera (with the lens's k1) and a board point projected into it; a square and a
  // triangle as polygons.
  // Verifies: the ray from the camera centre through the point's pixel (undistorted) passes within
  // 1e-6 mm of the point; the centroid of a square is its middle, of a triangle the vertex mean
  // (both are area centroids).
  const p = pose(TARGET, 210, 45, 180);
  const uv = projectPoints([ROCK], p.R, p.t, INTRINSICS);
  const ray = pixelRay(p, INTRINSICS, [uv[0], uv[1]]);
  const w = ROCK.map((v, i) => v - ray.origin[i]);
  const along = w.reduce((sum, v, i) => sum + v * ray.dir[i], 0);
  assertClose(Math.hypot(...w.map((v, i) => v - along * ray.dir[i])), 0, 1e-6, 'the ray passes through the point');
  const square = polygonCentroid([[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert(square[0] === 5 && square[1] === 5, 'square centroid');
  const triangle = polygonCentroid([[0, 0], [9, 0], [0, 6]]);
  assertClose(triangle[0], 3, 1e-12, 'triangle x');
  assertClose(triangle[1], 2, 1e-12, 'triangle y');
});

Deno.test('createRockLocator: falls back to the target, then finds the rock from spread outlined views', () => {
  // Setup: rays through the rock's middle (80, 110, 5) from views around it, with 1 px of noise on
  // the outline's centroid; then one ray from a bad outline (aimed 15 mm off).
  // Test: the estimate after each view.
  // Verifies: with fewer than 3 rays, or with rays bunched within a few degrees, the rock is said to
  // be at the target (80, 110, 0) with from 'target'; with 3+ views spread around it is found
  // ('views') within 1 mm; the bad ray is dropped (the estimate stays within 1 mm); and an estimate
  // far from the target (rays meeting 60 mm away) is not believed.
  const random = seededRandom(7);
  const locator = createRockLocator(TARGET);
  const rayFrom = (az, el, d = 180) => {
    const p = pose(TARGET, az, el, d);
    const uv = projectPoints([ROCK], p.R, p.t, INTRINSICS);
    return pixelRay(p, INTRINSICS, [uv[0] + gaussian(random), uv[1] + gaussian(random)]);
  };

  locator.add(rayFrom(10, 40));
  locator.add(rayFrom(14, 41));
  let estimate = locator.estimate();
  assert(estimate.from === 'target' && estimate.point.join() === '80,110,0', 'two rays: the target');
  locator.add(rayFrom(18, 42));
  estimate = locator.estimate();
  assert(estimate.from === 'target' && estimate.spreadDeg < 20, `bunched: target (spread ${estimate.spreadDeg})`);

  for (const az of [60, 120, 200, 280]) {
    locator.add(rayFrom(az, 35));
  }

  estimate = locator.estimate();
  assert(estimate.from === 'views', 'found from the views');
  assert(Math.hypot(...estimate.point.map((v, i) => v - ROCK[i])) < 1, `within 1 mm: ${estimate.point}`);

  const bad = pose(TARGET, 330, 30, 180);
  const off = projectPoints([[ROCK[0] + 15, ROCK[1], ROCK[2]]], bad.R, bad.t, INTRINSICS);
  locator.add(pixelRay(bad, INTRINSICS, [off[0], off[1]]));
  estimate = locator.estimate();
  assert(Math.hypot(...estimate.point.map((v, i) => v - ROCK[i])) < 1, `the bad ray is dropped: ${estimate.point}`);

  const far = createRockLocator(TARGET);
  for (const az of [0, 120, 240]) {
    const c = lookAtPose([140, 110, 5], az, 40, 180).center;
    const d = [140 - c[0], 110 - c[1], 5 - c[2]];
    far.add({ origin: c, dir: d });
  }
  assert(far.estimate().from === 'target', 'a rock 60 mm from the target is not believed');
});

Deno.test('createCoverage: cells by band and sector, worked out again when the rock moves', () => {
  // Setup: usable cameras on a circle at 30 degrees around the rock, from azimuth 0 to 150 every 10.
  // Verifies: only band 1 (20-40 degrees) fills, sectors 0..5 (0-180 degrees); moving the rock's
  // estimate 0.3 mm changes nothing, but moving it far below the cameras (z = -200, so every camera is
  // high above it) puts all the views into band 3; count is the views kept.
  const coverage = createCoverage();
  coverage.setRock(ROCK);

  for (let az = 0; az <= 150; az += 10) {
    coverage.add(lookAtPose(ROCK, az, 30, 180).center);
  }

  assert(coverage.masks().join() === `0,${0b111111},0,0`, `masks ${coverage.masks()}`);
  assert(coverage.setRock([80.3, 110, 5]) === false, 'a small move does not recompute');
  coverage.setRock([80, 110, -200]);
  assert(coverage.masks()[3] === 0b111111 && coverage.masks()[1] === 0, 'recomputed from the new point');
  assert(coverage.count === 16, `${coverage.count} views`);
});

Deno.test('coverageAdvice and coverageSummary: the next step in plain words', () => {
  // Setup: coverage states along a scan: nothing; part of the middle circle with the camera on it;
  // the middle circle done but no low views; part of the low circle with the camera low; both
  // circles done; everything.
  // Verifies: the advice goes 'start' -> 'middle-gap' naming the nearest unfilmed stretch as clock
  // positions (or, for a stretch over half the circle, "keep going all the way round") -> 'low-ring'
  // ("Add a low circle...") -> 'low-gap' -> 'top' -> 'done', and the summary
  // counts the sides of each circle.
  assert(coverageAdvice([0, 0, 0, 0]).id === 'start', 'start');

  // middle circle filmed from 0 to 180 degrees; camera at 200 degrees, 35 up: the nearest gap is
  // 180-360 degrees, from 6 o'clock (360) round to 12 (180) through 9: "the 6 to 12 o'clock side"
  const half = 0b111111;
  const middle = coverageAdvice([0, half, 0, 0], { azimuthDeg: 200, elevationDeg: 35, distanceMm: 180 });
  assert(middle.id === 'middle-gap' && middle.text === "Circle at 45°: film the 6 to 12 o'clock side.", middle.text);

  const low = coverageAdvice([0, FULL_RING, 0, 0], { azimuthDeg: 200, elevationDeg: 35, distanceMm: 180 });
  assert(low.id === 'low-ring' && low.text.startsWith('Add a low circle'), low.text);

  // low circle filmed except 30-90 degrees; camera low at 100 degrees: "the 3 to 5 o'clock side"
  const lowMask = FULL_RING & ~0b110;
  const lowGap = coverageAdvice([lowMask, FULL_RING, 0, 0], { azimuthDeg: 100, elevationDeg: 12, distanceMm: 180 });
  assert(lowGap.id === 'low-gap' && lowGap.text === "Low circle: film the 3 to 5 o'clock side.", lowGap.text);

  // only 3 sectors of the middle circle filmed (0-90 degrees): the unfilmed stretch is 270 degrees,
  // eight hours of clock, so the tip says it plainly instead of "the 9 to 5 o'clock side"
  const long = coverageAdvice([0, 0b111, 0, 0], { azimuthDeg: 60, elevationDeg: 35, distanceMm: 180 });
  assert(long.id === 'middle-gap' && long.text === 'Circle at 45°: keep going all the way round.', long.text);

  assert(coverageAdvice([FULL_RING, 0, FULL_RING, 0]).id === 'top', 'top');
  assert(coverageAdvice([FULL_RING, FULL_RING, 0, 1]).id === 'done', 'done');
  const summary = coverageSummary([lowMask, half, 0b1, 0]);
  assert(summary.low === 10 && summary.middle === 6 && summary.top === false, JSON.stringify(summary));
  assert(summary.text === 'Low circle 10 of 12 sides · 45° circle 6 of 12 · from above: not yet', summary.text);
});

Deno.test('coverageMapCells and mapPoint: the sheet seen from above, its top edge up', () => {
  // Verifies: 48 cells (12 sectors x 4 bands), each a closed SVG path; the top band's cells are
  // wedges to the centre; azimuth 0 (+X, down the page) at the bottom of the map, 90 (+Y, right) at
  // the right, 180 at the top; straight down at the centre.
  const cells = coverageMapCells();
  assert(cells.length === 48 && cells.every((c) => c.d.endsWith('Z')), '48 closed cells');
  assert(cells.filter((c) => c.band === 3).every((c) => c.d.includes('L0 0Z')), 'top band: wedges');
  const close = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9;
  assert(close(mapPoint(0, 0), [0, 1]) && close(mapPoint(90, 0), [1, 0]) && close(mapPoint(180, 0), [0, -1]), 'directions');
  assert(close(mapPoint(45, 90), [0, 0]), 'straight down: the centre');
});

Deno.test('boardSpeed: an orbit and a slide, in mm per second on the board', () => {
  // Setup: (1) the camera orbiting the rock at 12 degrees a second (the desktop's "30 seconds a
  // circle"), two poses 125 ms apart; (2) the camera sliding sideways 40 mm/s, parallel to the board,
  // looking straight down from 180 mm.
  // Verifies: the orbit keeps the rock still in the picture (its own speed under 1 mm/s) but moves
  // the board around it: the median board point moves at omega x its distance from the rock's axis,
  // between 5 and 30 mm/s, under MAX_SPEED_MM_S; the slide moves every board point at the slide's
  // speed (40 mm/s within 5%), over the limit.
  const a = pose(TARGET, 100, 30, 180);
  const b = pose(TARGET, 101.5, 30, 180);
  const samples = [];

  for (let x = 10; x < 170; x += 20) {
    for (let y = 10; y < 230; y += 20) {
      samples.push([x, y, 0]);
    }
  }

  const orbit = boardSpeed(a, b, INTRINSICS, 125, [80, 110, 0], samples, FRAME);
  assert(orbit.rockMmS < 1, `rock still: ${orbit.rockMmS}`);
  assert(orbit.boardMmS > 5 && orbit.boardMmS < 30 && orbit.speedMmS < MAX_SPEED_MM_S, `orbit ${JSON.stringify(orbit)}`);

  const top = pose(TARGET, 0, 89.99, 180);
  const moved = { ...top, t: [top.t[0], top.t[1], top.t[2]] };
  // moving the camera by +5 mm in board Y: t' = t - R * (0, 5, 0)
  moved.t = top.t.map((v, i) => v - top.R[3 * i + 1] * 5);
  const slide = boardSpeed(top, moved, INTRINSICS, 125, [80, 110, 0], samples, FRAME);
  assertClose(slide.boardMmS, 40, 2, 'slide speed');
  assert(slide.speedMmS > MAX_SPEED_MM_S, 'over the limit');
});

Deno.test('createScanGuide: a scan around the rock -- the rock found, coverage filled, conditions raised', () => {
  // Setup: a session of frames 125 ms apart: a slow orbit at 30 degrees (8 degrees a second) with an
  // outline on every other frame; then a fast swing (60 degrees a second); then the board lost for
  // 1 s; then a still frame whose focus measure reads soft; then the rock pushed to the picture's
  // edge. The focus measure is a stand-in returning a sharp reading (0.5 px) unless told otherwise.
  // Verifies: the rock is the target until the views spread, then found from them within 1 mm; the
  // views of the slow orbit are usable and fill band 1's sectors along the way; the angle is the
  // camera's from the rock (within 0.5 degree); the fast swing raises 'fast' and is not usable; with
  // the board lost 'fast' is held for SPEED_HOLD_MS and then dropped; a soft reading (3 px, about
  // 0.5 mm here) raises 'focus'; a 20% glare reading raises 'glare' only when it was measured inside
  // a recent outline (the measure is handed the outline's polygon), not more than CONTOUR_MAX_AGE_MS
  // after the last one; a rock at the edge raises 'edge'.
  const guide = createScanGuide({ targetMm: TARGET, sizeMm: [170, 230] });
  let blur = 0.5;
  let glare = 0;
  let seenPolygon = null;
  const measure = (box, polygon) => {
    seenPolygon = polygon;
    return { blurPx: blur, blurWindowPx: blur, glare };
  };
  let time = 0;
  let az = 150;
  let last = null;
  const step = (p, outline = null) => {
    time += 125;
    last = guide.observe({ frame: { ...FRAME, timeMs: time }, pose: p, outline, sheet: 'strip', measure });
    return last;
  };

  const first = step(pose(ROCK, az, 30, 180));
  assert(first.rockFrom === 'target', 'the target to start with');
  const filled = [];

  for (let k = 0; k < 60; k += 1) {
    az += 1;    // 8 degrees a second
    const p = pose(ROCK, az, 30, 180);
    const g = step(p, k % 2 ? rockOutline(p, 9, time + 125) : null);
    assert(g.usable && !g.conditions.fast, `slow orbit usable at ${az}: ${g.reasons}`);
    filled.push(g.cover[1]);
  }

  assert(last.rockFrom === 'views', 'found from the views');
  assert(Math.hypot(...last.rockMm.map((v, i) => v - ROCK[i])) < 1, `rock ${last.rockMm}`);
  assertClose(last.view.azimuthDeg, az, 0.5, 'azimuth from the rock');
  assertClose(last.view.elevationDeg, 30, 0.5, 'elevation from the rock');
  assert(filled[0] !== filled[filled.length - 1] && (last.cover[1] & 0b11100000) === 0b11100000, `coverage grew: ${filled[0]} -> ${last.cover[1]}`);

  for (let k = 0; k < 4; k += 1) {
    az += 7.5;   // 60 degrees a second
    const g = step(pose(ROCK, az, 30, 180));

    if (k > 0) {
      assert(g.conditions.fast && !g.usable, `fast at ${az}: ${g.speedMmS}`);
    }
  }

  const lost = step(null);
  assert(lost.conditions.fast, 'fast held while the board is lost');
  time += SPEED_HOLD_MS;
  assert(!step(null).conditions.fast, 'dropped after the hold');

  blur = 3;
  step(pose(ROCK, az, 30, 180));
  const soft = step(pose(ROCK, az, 30, 180));
  assert(soft.conditions.focus && !soft.conditions.fast && !soft.usable, `soft: ${soft.blurMm} mm`);
  blur = 0.5;

  // glare: counted only with a recent outline of the rock (the stand-in reads 20% clipped)
  glare = 0.2;
  const noOutline = step(pose(ROCK, az, 30, 180));
  assert(noOutline.glare === null && !noOutline.conditions.glare, 'no recent outline: no glare count');
  const lit = pose(ROCK, az, 30, 180);
  const withOutline = step(lit, rockOutline(lit, 9, time + 125));
  assert(withOutline.conditions.glare && seenPolygon?.length === 24, 'glare on the rock, measured inside its outline');
  glare = 0;

  // aim the camera 85 mm past the rock: the rock lands at the picture's edge
  const edge = step(pose([ROCK[0] + 60, ROCK[1] + 60, 0], az, 30, 180));
  assert(edge.conditions.edge, `edge: margin ${edge.marginPx}`);
});

Deno.test('createWarningFilter: on after 300 ms, off after 500 ms clear, one at a time by priority', () => {
  // Setup: conditions fed at 100 ms steps (about the phone's frame rate).
  // Test and verifies, in order: 'focus' true for 200 ms shows nothing; at 300 ms it shows; a 200 ms
  // gap in it keeps it shown (no flicker); 500 ms clear takes it down. With 'focus' and 'fast' both
  // on, 'fast' shows (it comes first); when 'fast' clears for 500 ms, 'focus' (still on) shows again.
  assert(WARNING_ON_MS === 300 && WARNING_OFF_MS === 500, 'the times');
  const filter = createWarningFilter();
  const run = (from, to, conditions) => {
    let shown = null;

    for (let t = from; t <= to; t += 100) {
      shown = filter.update(t, conditions);
    }

    return shown;
  };

  assert(run(0, 200, { focus: true }) === null, 'not yet at 200 ms');
  assert(run(300, 300, { focus: true })?.id === 'focus', 'on at 300 ms');
  assert(run(400, 500, { focus: false })?.id === 'focus', 'a short gap keeps it');
  assert(run(600, 600, { focus: true })?.id === 'focus', 'still on');
  assert(run(700, 1100, { focus: false })?.id === 'focus', 'clear for 400 ms: still on');
  assert(run(1200, 1200, { focus: false }) === null, 'clear for 500 ms: off');

  run(2000, 2300, { focus: true, fast: true });
  assert(filter.update(2400, { focus: true, fast: true }).id === 'fast', 'fast comes first');
  assert(run(2500, 2800, { focus: true, fast: false }).id === 'fast', 'fast holds while clearing');
  assert(run(2900, 3000, { focus: true, fast: false }).id === 'focus', 'then focus again');
});
