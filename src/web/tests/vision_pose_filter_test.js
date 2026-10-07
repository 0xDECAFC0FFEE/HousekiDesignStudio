/*
 * vision_pose_filter_test.js -- the pose the phone's overlay is drawn with (T-0332):
 * src/web/src/lib/vision/pose_filter.js, and overlay.js transferContour.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * Poses here are made, not detected: a camera orbiting, panning, sliding, standing still or stopping,
 * each measured every 100 ms (the phone's detection rate on an M1 Pro; a phone is slower), with or
 * without noise. The filter's prediction for the moment a frame is SHOWN is compared with the true
 * pose at that moment, through the misplacement of board points on screen, as the harness measures
 * it (tests/harness/test_scan_lag.py on a real run; tests/harness/vision/replay_lag.js offline).
 */

import {
  between, compose, createPoseFilter, gainFor, MAX_PREDICT_MS, screenDistancePx, se3Exp, se3Log,
} from '../src/lib/vision/pose_filter.js';
import { createPoseSmoother, rotationAngleDeg } from '../src/lib/vision/pose.js';
import { cameraCenter, projectPoints } from '../src/lib/vision/camera_model.js';
import { transferContour } from '../src/lib/vision/overlay.js';
import { gaussian, lookAtPose, seededRandom } from './vision_test_support.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}

const LENS = { width: 1280, height: 720, f: 1000, cx: 640, cy: 360, k1: 0.02 };
const TARGET = [80, 110, 0];
// Board points every 20 mm, as the harness measures the grid.
const GRID = [];

for (let x = 5; x < 170; x += 20) {
  for (let y = 5; y < 230; y += 20) {
    GRID.push([x, y, 0]);
  }
}

/** A measurement as live.js hands it on: a valid CameraPose at frame time `timeMs`. */
const measured = (pose, timeMs) => ({ ...pose, frame: { width: 1280, height: 720, timeMs }, intrinsics: LENS, valid: true });

/** The median misplacement (px) of the on-screen grid points between a drawn pose and the truth. */
const misplacement = (drawn, truth) => screenDistancePx(truth, drawn, LENS, GRID);

/**
 * A camera orbiting the target: the pose `start` turned about the vertical through the target by
 * `degPerS` x ms / 1000 (the camera keeps its roll to the horizon, as a phone carried round does,
 * and as the lag video's synthetic camera does). x_cam = R0 (Rz(-a) (x - T) + T) + t0.
 */
function orbit(start, degPerS) {
  return (ms) => {
    const a = (-degPerS * ms / 1000) * Math.PI / 180;
    const Rz = [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
    const motion = { R: Rz, t: TARGET.map((v, i) => v - (Rz[3 * i] * TARGET[0] + Rz[3 * i + 1] * TARGET[1] + Rz[3 * i + 2] * TARGET[2])) };
    return compose(start, motion);
  };
}

/** A pose with noise: turned by `rotDeg` and moved by `mm` per axis (s.d.), seeded. */
function noisy(pose, normal, rotDeg, mm) {
  const k = (rotDeg * Math.PI) / 180;
  const motion = se3Exp([k * normal(), k * normal(), k * normal(), 0, 0, 0]);
  const turned = compose(motion, pose);
  const centre = [0, 1, 2].map((i) => -(turned.R[i] * turned.t[0] + turned.R[3 + i] * turned.t[1] + turned.R[6 + i] * turned.t[2]) + mm * normal());
  const t = [0, 1, 2].map((i) => -(turned.R[3 * i] * centre[0] + turned.R[3 * i + 1] * centre[1] + turned.R[3 * i + 2] * centre[2]));
  return { R: turned.R, t, center: centre };
}

/** The RMS spread of points about their mean (px). */
const spread = (points) => {
  const mx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const my = points.reduce((s, p) => s + p[1], 0) / points.length;
  return Math.sqrt(points.reduce((s, p) => s + (p[0] - mx) ** 2 + (p[1] - my) ** 2, 0) / points.length);
};

Deno.test('se3Exp and se3Log: inverse to each other; compose and between undo each other', () => {
  // Setup: twists from tiny (below the series' switch-over) to a large turn, and two poses.
  // Test: exp then log; compose a motion with a pose and take `between` back.
  // Verifies: log(exp(xi)) = xi to 1e-9 at every size (the series and the closed forms agree);
  // between(compose(m, a), a) = m; a pure translation twist moves by exactly nu; a pure rotation
  // twist is rodrigues' rotation with no translation.
  for (const xi of [[1e-7, -2e-7, 3e-7, 0.5, -1, 2], [0.1, -0.2, 0.3, 10, -5, 2], [1.2, 0.4, -0.9, -30, 80, 15]]) {
    const back = se3Log(se3Exp(xi));
    xi.forEach((v, i) => assertClose(back[i], v, 1e-9, `log(exp(xi))[${i}] for |w| ${Math.hypot(xi[0], xi[1], xi[2])}`));
  }

  const a = lookAtPose(TARGET, 30, 40, 180);
  const m = se3Exp([0.05, -0.02, 0.1, 3, -2, 1]);
  const back = between(compose(m, a), a);
  back.R.forEach((v, i) => assertClose(v, m.R[i], 1e-12, `between R[${i}]`));
  back.t.forEach((v, i) => assertClose(v, m.t[i], 1e-9, `between t[${i}]`));
  const slide = se3Exp([0, 0, 0, 4, 5, 6]);
  assert(slide.t.join() === '4,5,6' && slide.R.join() === '1,0,0,0,1,0,0,0,1', 'a pure translation');
  assert(se3Exp([0, 0, 0.3, 0, 0, 0]).t.every((v) => v === 0), 'a pure rotation does not translate');
});

Deno.test('the gain: ALPHA_MIN within the noise, 1 for a clear miss, smooth in between', () => {
  // Setup: thresholds 0.5 and 2.7 px (the fixed ones at a 720p frame's s = 2/3).
  // Verifies: misses at or under the low threshold get the minimum gain, at or over the high one 1,
  // half way between them the average of the two (smoothstep is symmetric), and the gain never
  // falls as the miss grows.
  const opts = { alphaMin: 0.4, lowPx: 0.5, highPx: 2.7 };
  assertClose(gainFor(0, opts), 0.4, 1e-12, 'no miss');
  assertClose(gainFor(0.5, opts), 0.4, 1e-12, 'at the low threshold');
  assertClose(gainFor(1.6, opts), 0.7, 1e-12, 'half way');
  assertClose(gainFor(10, opts), 1, 1e-12, 'a clear miss');
  let last = 0;

  for (let r = 0; r < 4; r += 0.05) {
    assert(gainFor(r, opts) >= last, `monotonic at ${r}`);
    last = gainFor(r, opts);
  }
});

Deno.test('an orbit at 40 degrees/s: the prediction for the frame on screen is on the board; the old smoother trails it', () => {
  // Setup: a camera orbiting the target at 40 degrees a second, 35 degrees up, 180 mm away (the lag
  // video's swing), measured every 100 ms, each measurement's pose exact.
  // Test: after 1 s of measurements, draw frames 0, 33, 67, 100 and 150 ms after the last
  // measurement (the frame on screen is that much newer than the pose's frame), with the filter's
  // prediction; and with the exponential smoother used before T-0332 (time constant 120 ms) and
  // the raw last pose.
  // Verifies: an orbit is a constant twist, so the filter's prediction matches the true pose of the
  // frame on screen to under 0.05 px on the grid at every age; the raw pose misses by the motion over
  // its age (tens of px at 150 ms) and the old smoother by more.
  const filter = createPoseFilter();
  const smoother = createPoseSmoother({ target: { centre_mm: TARGET } });
  const turning = orbit(lookAtPose(TARGET, 20, 35, 180), 40);
  // The smoother needs the camera's centre (it restarts on a jump of it).
  const pose = (ms) => ({ ...turning(ms), center: cameraCenter(turning(ms).R, turning(ms).t) });
  let lastSmoothed = null;

  for (let ms = 0; ms <= 1000; ms += 100) {
    filter.update(measured(pose(ms), ms));
    lastSmoothed = smoother.update(measured(pose(ms), ms));
  }

  for (const ahead of [0, 33, 67, 100, 150]) {
    const truth = pose(1000 + ahead);
    const predicted = misplacement(filter.predict(1000 + ahead), truth);
    const raw = misplacement(pose(1000), truth);
    const smoothed = misplacement(lastSmoothed, truth);
    assert(predicted < 0.05, `prediction ${ahead} ms ahead misses by ${predicted} px`);
    assert(ahead === 0 || (raw > 5 * ahead / 100 && smoothed > raw), `${ahead} ms: raw ${raw} px, smoothed ${smoothed} px`);
  }

  const raw150 = misplacement(pose(1000), pose(1150));
  console.log(`  orbit 40 deg/s, frame 150 ms newer: raw pose ${raw150.toFixed(1)} px, predicted ${misplacement(filter.predict(1150), pose(1150)).toFixed(3)} px`);
});

Deno.test('a slide and a pan on the spot are followed and predicted as well', () => {
  // Setup: (a) the camera sliding sideways at 20 mm/s (its aim moving across the board), and (b)
  // turning on the spot at 15 degrees a second (a pan), each measured every 100 ms for 1 s.
  // Test: predict 120 ms past the last measurement.
  // Verifies: both are constant twists: the prediction is within 0.05 px of the truth on the grid.
  const slide = (ms) => lookAtPose([TARGET[0], TARGET[1] + (20 * ms) / 1000, 0], 30, 40, 180);
  const pan = (ms) => compose(se3Exp([0, ((15 * Math.PI) / 180) * (ms / 1000), 0, 0, 0, 0]), lookAtPose(TARGET, 30, 40, 180));

  for (const [name, pose] of [['slide', slide], ['pan', pan]]) {
    const filter = createPoseFilter();

    for (let ms = 0; ms <= 1000; ms += 100) {
      filter.update(measured(pose(ms), ms));
    }

    const miss = misplacement(filter.predict(1120), pose(1120));
    assert(miss < 0.05, `${name}: prediction misses by ${miss} px`);
  }
});

Deno.test('still with noisy poses: the drawn overlay shimmers less than the raw poses', () => {
  // Setup: a camera held still, 180 mm away, measured every 100 ms for 6 s with pose noise of
  // 0.03 degree and 0.15 mm per axis (raw on-screen shimmer about 1.5 px: noisier than the
  // synthetic video's poses, as a real phone's may be). Frames are drawn every 33 ms, each 100 ms
  // newer than the last measurement that has arrived.
  // Test: the spread of a grid point near the middle of the picture, drawn raw and drawn with the
  // filter's prediction, over the last 4 s (after the noise estimate has settled).
  // Verifies: the filter's drawn point moves less than the raw one (at most 75% of it): the noise
  // is averaged and the velocity it leaves is not carried forward (the deadband).
  const random = seededRandom(7);
  const normal = () => gaussian(random);
  const truth = lookAtPose(TARGET, 30, 40, 180);
  const filter = createPoseFilter();
  const raw = [];
  const drawn = [];
  let latest = null;
  const point = [[80, 110, 0]];

  for (let ms = 0; ms <= 6000; ms += 33) {
    if (ms % 99 === 0) {
      latest = noisy(truth, normal, 0.03, 0.15);
      filter.update(measured(latest, ms));
    }

    if (ms > 2000) {
      const r = projectPoints(point, latest.R, latest.t, LENS);
      const p = filter.predict(ms + 100);
      const d = projectPoints(point, p.R, p.t, LENS);
      raw.push([r[0], r[1]]);
      drawn.push([d[0], d[1]]);
    }
  }

  console.log(`  still, noisy poses: raw shimmer ${spread(raw).toFixed(2)} px, drawn ${spread(drawn).toFixed(2)} px`);
  assert(spread(drawn) < 0.75 * spread(raw), `drawn ${spread(drawn)} px vs raw ${spread(raw)} px`);
});

Deno.test('a sudden stop: the overlay settles on the board within half a second', () => {
  // Setup: an orbit at 40 degrees a second for 1 s, then the camera stopped dead; measured every
  // 100 ms throughout.
  // Test: the misplacement of the frame on screen (100 ms newer than the measurement) after the
  // stop.
  // Verifies: the first frames after the stop overshoot (the filter cannot know it stopped until a
  // measurement says so: about one motion's worth, tens of px); 500 ms after the stop the drawn grid
  // is back within 1 px of the board, and at 1 s within 0.3 px.
  const filter = createPoseFilter();
  const turning = orbit(lookAtPose(TARGET, 20, 35, 180), 40);
  const pose = (ms) => turning(Math.min(ms, 1000));
  const misses = [];

  for (let ms = 0; ms <= 2000; ms += 100) {
    filter.update(measured(pose(ms), ms));
    misses.push(misplacement(filter.predict(ms + 100), pose(ms + 100)));
  }

  console.log(`  sudden stop: misses after it ${misses.slice(10).map((m) => m.toFixed(2)).join(' ')} px`);
  assert(misses[10] > 5, `the first frame after the stop overshoots (${misses[10]} px)`);
  assert(misses[15] < 1, `500 ms after the stop: ${misses[15]} px`);
  assert(misses[20] < 0.3, `1 s after the stop: ${misses[20]} px`);
});

Deno.test('restarts and limits: a gap, a frame from the past, a jump; prediction stops at MAX_PREDICT_MS', () => {
  // Setup: a filter following an orbit, then: a measurement 600 ms after the last (a gap), one from
  // before the last, one 200 px away on screen (a jump), and a prediction 1 s ahead.
  // Verifies: each of the three restarts the filter from the measurement as it is (the drawn pose
  // is the measurement exactly, with no velocity); the prediction far ahead is the one at
  // MAX_PREDICT_MS (a stale pose stops rather than flying off); predict and current give nothing
  // before the first measurement.
  const filter = createPoseFilter();
  assert(filter.predict(0) === null && filter.current() === null, 'nothing yet');
  const pose = orbit(lookAtPose(TARGET, 20, 35, 180), 40);

  for (let ms = 0; ms <= 500; ms += 100) {
    filter.update(measured(pose(ms), ms));
  }

  const far = filter.predict(1500);
  const capped = filter.predict(500 + MAX_PREDICT_MS);
  assertClose(rotationAngleDeg(far.R, capped.R), 0, 1e-9, 'held at the cap');
  assert(far.predictedMs === MAX_PREDICT_MS, 'predictedMs at the cap');

  for (const [why, pose2, time] of [
    ['gap', pose(1100), 1100],
    ['from the past', pose(1300), 1050],
    ['jump', lookAtPose(TARGET, 200, 35, 180), 1150],
  ]) {
    const out = filter.update(measured(pose2, time));
    assert(out.restarted, `${why} restarts`);
    assertClose(rotationAngleDeg(filter.predict(time + 100).R, pose2.R), 0, 1e-9, `${why}: no velocity after a restart`);
  }
});

Deno.test('transferContour: an outline moves with the board from its frame to the pose drawn', () => {
  // Setup: a ring of points on the plane Z = 4.5 mm round the target (the rock's middle height),
  // projected with pose A (the frame the outline was found on); pose B, 10 degrees round.
  // Test: transfer A's pixels to B through the plane Z = 4.5; and through the same pose.
  // Verifies: the transferred points are B's own projections of the ring (to 1e-6 px: the lens's k1
  // is undone exactly enough); transferring to the same pose gives the points back; a contour
  // whose rays cannot meet the plane (the plane behind the camera) gives null.
  const ring = Array.from({ length: 24 }, (_, k) => [TARGET[0] + 9 * Math.cos(k / 3.82), TARGET[1] + 7 * Math.sin(k / 3.82), 4.5]);
  const a = lookAtPose(TARGET, 30, 40, 180);
  const b = lookAtPose(TARGET, 40, 38, 175);
  const pa = projectPoints(ring, a.R, a.t, LENS);
  const pb = projectPoints(ring, b.R, b.t, LENS);
  const contour = ring.map((_, i) => [pa[2 * i], pa[2 * i + 1]]);
  const moved = transferContour(contour, a, LENS, b, LENS, 4.5);
  moved.forEach(([x, y], i) => {
    assertClose(x, pb[2 * i], 1e-6, `x of point ${i}`);
    assertClose(y, pb[2 * i + 1], 1e-6, `y of point ${i}`);
  });
  const same = transferContour(contour, a, LENS, a, LENS, 4.5);
  same.forEach(([x, y], i) => assertClose(Math.hypot(x - contour[i][0], y - contour[i][1]), 0, 1e-6, `same pose, point ${i}`));
  assert(transferContour(contour, a, LENS, b, LENS, 1000) === null, 'a plane above the camera');
});
