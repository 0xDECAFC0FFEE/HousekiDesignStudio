/*
 * vision_intrinsics_test.js -- the phone camera's live intrinsics (T-0324: intrinsics.js,
 * calibrate.js and the closed-form focal length in camera_model.js).
 *
 * The phone needs K (focal length f, radial k1; principal point at the centre) before it can pose
 * the camera. intrinsics.js gets it in stages -- a guess, a per-device table, the closed-form focal
 * length of a dozen board views, then a calibration over 30-60 views spread over viewing
 * directions -- all ports of the desktop scanner pipeline (HousekiScanner calibrate.py, step1.py).
 * These tests check:
 *   1. the ports against the desktop's own numbers on the same real corners (fixtures made by
 *      make_fixture.py), and calibrate.js against cv.calibrateCameraExtended;
 *   2. on a synthetic capture with a known f and k1: how close the seed and the refinement get,
 *      and after how many views;
 *   3. the estimator's behaviour: sources in order, the table, a resolution change, a zoom
 *      change, and that the refinement runs in small scheduled steps;
 *   4. the whole reference captures, when the scanner project is on this machine (skipped
 *      otherwise): seed and refined focal length against the desktop's calibration.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 */

import { cornerPoint } from '../src/lib/vision/board_frame.js';
import { TEST_BOARD_SPECS } from './vision_test_boards.js';
import { calibrate } from '../src/lib/vision/calibrate.js';
import { homographyFocal, oneViewFocal, viewHomography } from '../src/lib/vision/camera_model.js';
import {
  createIntrinsicsEstimator, describeCamera, GUESS_F_OVER_LONG_SIDE, guessIntrinsics, lookupDeviceTable,
  ONE_VIEW_MIN_TILT_DEG, ONE_VIEW_WINDOW,
} from '../src/lib/vision/intrinsics.js';
import {
  assert, assertClose, calibrateWithOpenCv, CV_TEST, fixtureDetection, loadFixture, loadStockOpenCv, lookAtPose,
  seededRandom, syntheticDetection,
} from './vision_test_support.js';

const cv = await loadStockOpenCv();
const ignore = cv === null;
// The single-square-target sheet (test-only since T-0335; vision_test_boards.js): the strip's
// chessboard less marker 97, its target in the middle of the sheet.
const spec = TEST_BOARD_SPECS.charuco_23x17_10mm_centre1;
const TARGET = spec.target.centre_mm;

// The synthetic phone: portrait 1080 x 1920 at 1x zoom, f = 1500 px (0.78 x the long side, a 65
// degree field across it), mild barrel distortion.
const TRUE_K = Object.freeze({ width: 1080, height: 1920, f: 1500, cx: 540, cy: 960, k1: -0.05 });

/**
 * A synthetic capture: `count` frames 100 ms apart from a phone circling the board (azimuth two
 * full turns), rising and falling between 20 and 75 degrees elevation, 200-380 mm away, rolled
 * +/-15 degrees, aimed within +/-25 mm of the target; 0.5 px corner noise, 5% of corners
 * dropped and, on every 7th frame, 2 misread ids.
 */
function syntheticCapture(intr, count, seed = 1) {
  const random = seededRandom(seed);
  const frames = [];

  for (let i = 0; i < count; i += 1) {
    const phase = i / count;
    const azimuth = 720 * phase;
    const elevation = 47.5 + 27.5 * Math.sin(2 * Math.PI * 3 * phase);
    const distance = 290 + 90 * Math.sin(2 * Math.PI * 5 * phase + 1);
    const aim = [TARGET[0] + 50 * (random() - 0.5), TARGET[1] + 50 * (random() - 0.5), 0];
    const truth = lookAtPose(aim, azimuth, elevation, distance, 30 * (random() - 0.5));
    frames.push(syntheticDetection(spec, truth, intr, {
      noisePx: 0.5, random, dropFraction: 0.05, wrongIds: i % 7 === 3 ? 2 : 0, timeMs: 100 * i,
    }));
  }

  return frames;
}

/** A scheduler the test drains by hand: refinement steps run between frames, as on the phone. */
function manualScheduler() {
  const queue = [];
  let ticks = 0;
  let maxTickMs = 0;
  return {
    schedule: (fn) => queue.push(fn),
    drain() {
      while (queue.length) {
        const t0 = performance.now();
        queue.shift()();
        maxTickMs = Math.max(maxTickMs, performance.now() - t0);
        ticks += 1;
      }
    },
    stats: () => ({ ticks, maxTickMs }),
  };
}

/** The views make_fixture.py gave the desktop for its port check: sharp two-marker corners. */
function fixtureCalibrationViews(fixture) {
  const views = [];

  for (const frame of fixture.frames) {
    const det = fixtureDetection(fixture, frame, 'best');
    const points = det.corners.map((c) => cornerPoint(fixture.spec, c.id));

    if (points.length >= 12 && spans(points, fixture.spec.square_mm)) {
      views.push({ points, pixels: det.corners.map((c) => [c.x, c.y]) });
    }
  }

  return views;
}

// calibrate._spans_plane, written out here so the test does not lean on the code under test
function spans(points, square) {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  let a = 0;
  let b = 0;
  let c = 0;

  for (const p of points) {
    a += (p[0] - mx) ** 2;
    b += (p[0] - mx) * (p[1] - my);
    c += (p[1] - my) ** 2;
  }

  const small = 0.5 * (a + c) - Math.sqrt(0.25 * (a - c) ** 2 + b * b);
  return Math.sqrt(Math.max(small, 0)) / Math.sqrt(n) > 0.5 * square;
}

const pct = (a, b) => 100 * (a / b - 1);

for (const name of ['moissanite', 'spinel']) {
  Deno.test({ name: `real views (${name}): the closed-form focal and the calibration equal the desktop's`, ignore, ...CV_TEST, fn() {
    // Setup: the fixture's frames with >= 12 sharp two-marker corners spanning the plane -- the views
    // make_fixture.py handed to the desktop's own homography_focal and calibrate(dist_terms="k1",
    // starting from that closed-form f), whose answers the fixture stores.
    // Test: camera_model.homographyFocal and calibrate.calibrate on the same views and start.
    // Verifies: the ports give the desktop's numbers: the closed-form focal to 1e-6 relative, and
    // the calibrated f to 0.05%, k1 to 0.002, the RMS to 0.01 px and the kept-corner count to
    // within 1% -- the desktop's OpenCV 5 and this JS solver reach the same minimum. (Not exactly:
    // the desktop calibrates on float32 corners.)
    const fixture = loadFixture(name);
    const size = { width: fixture.image_size[0], height: fixture.image_size[1] };
    const views = fixtureCalibrationViews(fixture);
    const expected = fixture.port_check;
    assert(views.length === expected.views, `${views.length} views, the desktop had ${expected.views}`);

    const fClosed = homographyFocal(cv, views, size);
    assertClose(fClosed / expected.homography_focal, 1, 1e-6, 'closed-form focal');

    const t0 = performance.now();
    const c = calibrate(cv, views, size, { f: fClosed, k1: 0 });
    const ms = performance.now() - t0;
    const d = expected.calibrate_k1;
    console.log(`  ${name}: ${views.length} views; closed-form ${fClosed.toFixed(2)} px (desktop ${expected.homography_focal.toFixed(2)}); `
      + `calibration f ${c.f.toFixed(2)} k1 ${c.k1.toFixed(4)} rms ${c.rmsPx.toFixed(3)} px, ${c.points} corners `
      + `(desktop f ${d.f.toFixed(2)} k1 ${d.k1.toFixed(4)} rms ${d.rms_px.toFixed(3)}, ${d.points}); ${ms.toFixed(0)} ms, ${c.iterations} LM iterations`);
    assert(Math.abs(pct(c.f, d.f)) < 0.05, `f ${c.f} vs ${d.f}`);
    assertClose(c.k1, d.k1, 0.002, 'k1');
    assertClose(c.rmsPx, d.rms_px, 0.01, 'rms');
    assert(Math.abs(c.points - d.points) <= 0.01 * d.points, `points ${c.points} vs ${d.points}`);
  } });
}

Deno.test({ name: 'calibrate.js finds cv.calibrateCameraExtended\'s minimum, at a fraction of the time', ignore, ...CV_TEST, fn() {
  // Setup: 8, 16 and 24 views from the synthetic capture (0.5 px noise, misread ids removed so a
  // single call without pruning is comparable), started from f 10% low and k1 = 0.
  // Test: one pass of calibrate.js (passes: 1) and one cv.calibrateCameraExtended call with the
  // desktop's flags.
  // Verifies: the same f (to 1e-5 relative) and k1 (to 1e-5), and reports both times: OpenCV.js's
  // dense solver grows with the cube of the views, calibrate.js about linearly.
  const all = syntheticCapture(TRUE_K, 240, 3).filter((_, i) => i % 7 !== 3);

  for (const count of [8, 16, 24]) {
    const views = all.filter((_, i) => i % Math.floor(all.length / count) === 0).slice(0, count).map((det) => ({
      points: det.corners.map((c) => cornerPoint(spec, c.id)),
      pixels: det.corners.map((c) => [c.x, c.y]),
    }));
    const start = { f: 0.9 * TRUE_K.f, k1: 0 };
    let t0 = performance.now();
    const mine = calibrate(cv, views, TRUE_K, start, { passes: 1 });
    const myMs = performance.now() - t0;
    t0 = performance.now();
    const ref = calibrateWithOpenCv(cv, views, TRUE_K, start);
    const refMs = performance.now() - t0;
    console.log(`  ${count} views: calibrate.js f ${mine.f.toFixed(3)} k1 ${mine.k1.toFixed(5)} in ${myMs.toFixed(0)} ms; `
      + `cv.calibrateCameraExtended f ${ref.f.toFixed(3)} k1 ${ref.k1.toFixed(5)} in ${refMs.toFixed(0)} ms`);
    assertClose(mine.f / ref.f, 1, 1e-5, `${count} views f`);
    assertClose(mine.k1, ref.k1, 1e-5, `${count} views k1`);
    assertClose(mine.rmsPx, ref.rms, 1e-4, `${count} views rms`);
    assertClose(mine.fStd / ref.fStd, 1, 0.02, `${count} views f std`);
  }
} });

Deno.test({ name: 'synthetic capture: how many views the seed and the refinement need', ignore, ...CV_TEST, fn() {
  // Setup: the synthetic capture (true f 1500 px, k1 -0.05), its frames' corners as calibration
  // views (misread ids pruned by each frame's pose, as the estimator does).
  // Test: the closed-form focal over the first 4 / 8 / 12 / 20 / 40 frames 250 ms apart, and the
  // calibration over 10 / 20 / 30 / 60 views spread over the capture.
  // Verifies, and reports the curve: 12 frames put the closed-form focal within 3% (it has no
  // distortion term, so k1 biases it); a 30-view calibration is within 0.3% on f and 0.005 on k1,
  // 60 views within 0.2% and 0.003.
  const frames = syntheticCapture(TRUE_K, 600, 5).filter((_, i) => i % 7 !== 3);
  const views = frames.map((det) => ({
    points: det.corners.map((c) => cornerPoint(spec, c.id)),
    pixels: det.corners.map((c) => [c.x, c.y]),
  }));
  const seedRows = [];

  for (const n of [4, 8, 12, 20, 40]) {
    const f = homographyFocal(cv, views.filter((_, i) => i % 3 === 0).slice(0, n), TRUE_K);
    seedRows.push(`${n}: ${pct(f, TRUE_K.f).toFixed(2)}%`);

    if (n === 12) {
      assert(Math.abs(pct(f, TRUE_K.f)) < 3, `closed-form after 12 frames ${f}`);
    }
  }

  const refineRows = [];

  for (const n of [10, 20, 30, 60]) {
    const step = Math.floor(views.length / n);
    const subset = views.filter((_, i) => i % step === 0).slice(0, n);
    const c = calibrate(cv, subset, TRUE_K, { f: 1450, k1: 0 });
    refineRows.push(`${n}: f ${pct(c.f, TRUE_K.f).toFixed(3)}% k1 ${c.k1.toFixed(4)} (+/-${c.k1Std.toFixed(4)})`);

    if (n === 30) {
      assert(Math.abs(pct(c.f, TRUE_K.f)) < 0.3 && Math.abs(c.k1 - TRUE_K.k1) < 0.005, `30 views: ${c.f} ${c.k1}`);
    }

    if (n === 60) {
      assert(Math.abs(pct(c.f, TRUE_K.f)) < 0.2 && Math.abs(c.k1 - TRUE_K.k1) < 0.003, `60 views: ${c.f} ${c.k1}`);
    }
  }

  console.log(`  closed-form focal error by frames: ${seedRows.join(', ')}`);
  console.log(`  calibration error by views: ${refineRows.join('; ')}`);
} });

Deno.test({ name: 'the estimator goes guess -> closed-form -> refined on a live stream, in small steps', ignore, ...CV_TEST, fn() {
  // Setup: an estimator for 1080 x 1920 with no table entry, fed the synthetic capture frame by
  // frame (100 ms apart); refinement steps queued on a scheduler drained between frames.
  // Test: watch onChange and status().
  // Verifies: it starts as 'guess' (f = 0.85 x 1920 = 1632); turns 'closed-form' after 12 seed
  // frames (within 3% of the truth); turns 'refined' once 30 views are in (within 0.5% on f,
  // 0.01 on k1) and again at 60 (within 0.3%), then freezes; the refinement ran over many ticks,
  // none long (reported); and onChange saw every change.
  const scheduler = manualScheduler();
  const estimator = createIntrinsicsEstimator(cv, spec, TRUE_K, { schedule: scheduler.schedule });
  const changes = [];
  estimator.onChange((k) => changes.push({ ...k }));
  assert(estimator.current().source === 'guess', 'not a guess at first');
  assertClose(estimator.current().f, GUESS_F_OVER_LONG_SIDE * 1920, 1e-9, 'guess f');
  let frame = 0;

  for (const det of syntheticCapture(TRUE_K, 900, 7)) {
    estimator.addDetection(det);
    scheduler.drain();
    frame += 1;

    if (estimator.status().frozen) {
      break;
    }
  }

  const sources = changes.map((k) => k.source);
  const firstClosed = changes.find((k) => k.source === 'closed-form');
  const refined = changes.filter((k) => k.source === 'refined');
  const status = estimator.status();
  console.log(`  closed-form first at ${pct(firstClosed.f, TRUE_K.f).toFixed(2)}% after ${firstClosed.seedViews} seed frames; `
    + refined.map((k) => `refined (${k.views} views) f ${pct(k.f, TRUE_K.f).toFixed(3)}% k1 ${k.k1.toFixed(4)} rms ${k.rmsPx.toFixed(3)} px`).join('; ')
    + `; frozen after ${frame} frames; refinement ${scheduler.stats().ticks} ticks, longest ${scheduler.stats().maxTickMs.toFixed(1)} ms, `
    + `last run busy ${status.lastRefine.busyMs.toFixed(0)} ms`);
  assert(sources.indexOf('closed-form') < sources.indexOf('refined'), `order ${sources}`);
  assert(firstClosed.seedViews === 12 && Math.abs(pct(firstClosed.f, TRUE_K.f)) < 3, 'closed-form seed');
  assert(refined.length === 2 && refined[0].views === 30 && refined[1].views === 60, `refinements ${refined.map((k) => k.views)}`);
  assert(Math.abs(pct(refined[0].f, TRUE_K.f)) < 0.5 && Math.abs(refined[0].k1 - TRUE_K.k1) < 0.01, 'first refinement');
  assert(Math.abs(pct(refined[1].f, TRUE_K.f)) < 0.3 && Math.abs(refined[1].k1 - TRUE_K.k1) < 0.01, 'second refinement');
  assert(status.frozen && status.lensResets === 0, `status ${JSON.stringify(status)}`);
  assert(scheduler.stats().ticks > 20, 'the refinement was not split into steps');
  assert(estimator.addDetection(syntheticCapture(TRUE_K, 3, 9)[1]) === false, 'a frozen estimator took a view');
  estimator.dispose();
} });

Deno.test({ name: 'a resolution change rescales K; another aspect ratio starts again', ignore, ...CV_TEST, fn() {
  // Setup: an estimator refined on the synthetic capture at 1080 x 1920.
  // Test: feed one frame at 540 x 960 (the same stream at half size), then one at 1080 x 1080.
  // Verifies: half size -> f and the centre halve, k1 and the source ('refined') stay; a square
  // frame (another crop of the sensor: the field of view is unknown) -> started again for
  // 1080 x 1080: the guess, or (T-0336) a 'one-view' estimate from that one square frame alone if
  // it is slanted enough, with no calibration views held.
  const scheduler = manualScheduler();
  const estimator = createIntrinsicsEstimator(cv, spec, TRUE_K, { schedule: scheduler.schedule });

  for (const det of syntheticCapture(TRUE_K, 500, 11)) {
    estimator.addDetection(det);
    scheduler.drain();
  }

  const before = estimator.current();
  assert(before.source === 'refined', `source ${before.source}`);
  const half = { ...TRUE_K, width: 540, height: 960, f: 750, cx: 270, cy: 480 };
  estimator.addDetection(syntheticCapture(half, 3, 12)[1]);
  const after = estimator.current();
  assert(after.source === 'refined' && after.width === 540, `after ${JSON.stringify(after)}`);
  assertClose(after.f, before.f / 2, 1e-9, 'f halved');
  assertClose(after.cx, 270, 1e-9, 'cx');
  assertClose(after.k1, before.k1, 1e-12, 'k1');

  const square = { ...TRUE_K, width: 1080, height: 1080, cx: 540, cy: 540 };
  estimator.addDetection(syntheticCapture(square, 3, 13)[1]);
  const reset = estimator.current();
  assert(reset.width === 1080 && reset.height === 1080, `reset ${JSON.stringify(reset)}`);
  assert(reset.source === 'guess' ? Math.abs(reset.f - GUESS_F_OVER_LONG_SIDE * 1080) < 1e-9
    : reset.source === 'one-view' && reset.oneViews === 1, `restarted: ${JSON.stringify(reset)}`);
  // (with a 'one-view' estimate the square frame itself may already be held as a view: at most 1)
  assert(estimator.status().views <= 1, `no views kept from the old crop: ${estimator.status().views}`);
  estimator.dispose();
} });

Deno.test({ name: 'a zoom change is caught from the frames, or from setCamera', ignore, ...CV_TEST, fn() {
  // Setup: an estimator refined on the 1x synthetic capture (f 1500), then frames from the same
  // phone at 2x zoom (f 3000, k1 0), 100 ms apart.
  // Test: (a) feed the 2x frames with no notice; (b) on a fresh estimator, call setCamera with a
  // new zoom.
  // Verifies: (a) within LENS_WINDOW (9) frames the estimator notices the focal jump, resets and
  // seeds f from the new frames' closed-form median (within 5% of 3000), counting one lens
  // reset, and none during the steady 1x part; (b) a changed zoom setting restarts at once.
  const scheduler = manualScheduler();
  const estimator = createIntrinsicsEstimator(cv, spec, TRUE_K, { schedule: scheduler.schedule, camera: { deviceId: 'a', zoom: 1 } });

  for (const det of syntheticCapture(TRUE_K, 500, 21)) {
    estimator.addDetection(det);
    scheduler.drain();
  }

  assert(estimator.status().lensResets === 0, 'a lens reset during a steady capture');
  const zoomed = { ...TRUE_K, f: 3000, k1: 0 };
  let caughtAfter = null;
  syntheticCapture(zoomed, 40, 22).forEach((det, i) => {
    estimator.addDetection({ ...det, frame: { ...det.frame, timeMs: 60000 + 100 * i } });
    scheduler.drain();

    if (caughtAfter === null && estimator.status().lensResets === 1) {
      caughtAfter = i + 1;
    }
  });
  const k = estimator.current();
  console.log(`  zoom 1x -> 2x caught after ${caughtAfter} frames; f now ${k.f.toFixed(0)} (${k.source})`);
  assert(caughtAfter !== null && caughtAfter <= 9, `caught after ${caughtAfter}`);
  assert(Math.abs(pct(k.f, 3000)) < 5, `f after the zoom ${k.f}`);

  const other = createIntrinsicsEstimator(cv, spec, TRUE_K, { schedule: scheduler.schedule, camera: { deviceId: 'a', zoom: 1 } });
  const seen = [];
  other.onChange((x) => seen.push(x.source));
  other.setCamera({ deviceId: 'a', zoom: 1 });
  assert(seen.length === 0, 'the same settings restarted');
  other.setCamera({ deviceId: 'a', zoom: 2 });
  assert(seen.length === 1 && seen[0] === 'guess', `zoom change: ${seen}`);
  estimator.dispose();
  other.dispose();
} });

// --- the lens from one slanted view ('one-view', T-0336) ------------------------------------------

/** A laptop-webcam-like camera: 1280 x 720, f 700 px (an 85 degree field across), no distortion,
 *  far from the phone guess (0.85 x 1280 = 1088): the case where every pose failed until the seed. */
const WEBCAM = Object.freeze({ width: 1280, height: 720, f: 700, cx: 640, cy: 360, k1: 0 });

/** One synthetic detection of the board from the webcam, `elevationDeg` above the board (90: looking
 *  straight down, the board facing the camera), 0.5 px of corner noise, at `timeMs`. */
function webcamView(elevationDeg, azimuthDeg, timeMs, seed = 1) {
  const pose = lookAtPose(TARGET, azimuthDeg, elevationDeg, 260, 0);
  const det = syntheticDetection(spec, pose, WEBCAM, { noisePx: 0.5, random: seededRandom(seed), timeMs });
  return { ...det, frame: { width: WEBCAM.width, height: WEBCAM.height, timeMs } };
}

Deno.test({ name: 'oneViewFocal: f and the board\'s tilt from one view\'s homography', ignore, ...CV_TEST, fn() {
  // Setup: noise-free webcam views of the board (true f 700) at elevations 30, 50 and 70 degrees,
  // so the board is tilted 60, 40 and 20 degrees from facing the camera; and one from straight
  // above (tilt ~0).
  // Test: the view's least-squares homography (viewHomography), then oneViewFocal.
  // Verifies: on the slanted views both constraints give f within 0.5% of 700, they agree (spread
  // under 1%), and the tilt is 90 - elevation within 1 degree; straight above, the constraints are
  // ill-posed: either no f at all (null) or a tilt under ONE_VIEW_MIN_TILT_DEG, so the estimator
  // would not take it.
  for (const elevation of [30, 50, 70]) {
    const det = syntheticDetection(spec, lookAtPose(TARGET, 40, elevation, 260, 0), WEBCAM, { noisePx: 0 });
    const H = viewHomography(cv, det.corners.map((c) => cornerPoint(spec, c.id)), det.corners.map((c) => [c.x, c.y]), WEBCAM);
    const one = oneViewFocal(H);
    assert(one && Math.abs(one.f / 700 - 1) < 0.005 && one.spread < 0.01, `elevation ${elevation}: ${JSON.stringify(one)}`);
    assertClose(one.tiltDeg, 90 - elevation, 1, `tilt at elevation ${elevation}`);
  }

  const top = syntheticDetection(spec, lookAtPose(TARGET, 40, 89.9, 260, 0), WEBCAM, { noisePx: 0 });
  const flat = oneViewFocal(viewHomography(cv, top.corners.map((c) => cornerPoint(spec, c.id)), top.corners.map((c) => [c.x, c.y]), WEBCAM));
  assert(flat === null || flat.tiltDeg < ONE_VIEW_MIN_TILT_DEG, `straight above: ${JSON.stringify(flat)}`);
} });

Deno.test({ name: 'the estimator takes f from the first slanted view, keeps the guess on square-on ones, and the seed takes over', ignore, ...CV_TEST, fn() {
  // Setup: a fresh estimator for 1280 x 720 (guess f 1088) fed webcam views (true f 700, 0.5 px
  // noise), 300 ms apart (past the seed's 250 ms gap): first three from straight above (the board
  // facing the camera), then views 50-65 degrees up from all round.
  // Test: watch current() after each frame.
  // Verifies: the square-on frames leave the guess in place (they fix no f); the FIRST slanted frame
  // switches to 'one-view' with f within 3% of 700 (the user's ask: the lens from the board's own
  // perspective, at once); while on 'one-view', f is the median of at most ONE_VIEW_WINDOW views
  // (oneViews says how many) and stays within 3%; and once the seed has its 12 frames the source is
  // 'closed-form' (within 3%), with no lens reset on the way.
  const estimator = createIntrinsicsEstimator(cv, spec, WEBCAM, { schedule: () => {} });
  let t = 0;

  for (let k = 0; k < 3; k += 1) {
    estimator.addDetection(webcamView(89.9, 30 * k, (t += 300), k + 1));
    assert(estimator.current().source === 'guess', `square-on frame ${k}: ${JSON.stringify(estimator.current())}`);
  }

  estimator.addDetection(webcamView(55, 20, (t += 300), 10));
  const first = estimator.current();
  console.log(`  first slanted view: ${first.source} f ${first.f.toFixed(1)} (${pct(first.f, 700).toFixed(2)}%)`);
  assert(first.source === 'one-view' && first.oneViews === 1 && Math.abs(pct(first.f, 700)) < 3, `first: ${JSON.stringify(first)}`);

  let sawClosed = null;

  for (let k = 0; k < 14; k += 1) {
    estimator.addDetection(webcamView(50 + (k % 4) * 5, 30 + 25 * k, (t += 300), 20 + k));
    const now = estimator.current();

    if (now.source === 'one-view') {
      assert(now.oneViews <= ONE_VIEW_WINDOW && Math.abs(pct(now.f, 700)) < 3, `one-view ${JSON.stringify(now)}`);
    }

    if (now.source === 'closed-form' && sawClosed === null) {
      sawClosed = now;
    }
  }

  assert(sawClosed && Math.abs(pct(sawClosed.f, 700)) < 3, `closed-form: ${JSON.stringify(sawClosed)}`);
  assert(estimator.status().lensResets === 0, 'a lens reset');
  estimator.dispose();
} });

Deno.test('the per-device table: lookup rules and describeCamera', () => {
  // Setup: a two-entry table (a model-specific 2x entry and a label-only entry) and a fake
  // MediaStreamTrack whose getSettings / getCapabilities return what Android Chrome reports.
  // Test: lookupDeviceTable for several cameras and frame sizes; describeCamera on the fake track.
  // Verifies: entries match on model, label substring, aspect ratio (2% tolerance, long over short
  // so portrait and landscape agree) and zoom (5%); no match -> null; the shipped table is empty;
  // describeCamera copies the fields the table and setCamera use, and survives a track without
  // getCapabilities (Firefox before 132).
  const table = [
    { model: 'Pixel 7a', aspect: 16 / 9, zoom: 2, fOverLongSide: 1.81, k1: 0.055 },
    { label: 'Back Camera', aspect: 4 / 3, fOverLongSide: 0.76, k1: 0 },
  ];
  const portrait = { width: 1080, height: 1920 };
  assert(lookupDeviceTable(table, { zoom: 2 }, { model: 'Pixel 7a' }, portrait) === table[0], 'model + zoom');
  assert(lookupDeviceTable(table, { zoom: 1 }, { model: 'Pixel 7a' }, portrait) === null, 'zoom 1 matched a 2x entry');
  assert(lookupDeviceTable(table, { label: 'Back Camera' }, {}, { width: 1440, height: 1080 }) === table[1], 'label, landscape 4:3');
  assert(lookupDeviceTable(table, { label: 'Back Ultra Wide Camera' }, {}, { width: 1080, height: 1440 }) === null, 'substring of another label');
  assert(lookupDeviceTable(table, { label: 'Back Camera' }, {}, portrait) === null, '16:9 matched a 4:3 entry');
  assert(guessIntrinsics(portrait).source === 'guess', 'guess source');

  const track = {
    label: 'camera2 0, facing back',
    getSettings: () => ({ deviceId: 'x', groupId: 'g', facingMode: 'environment', width: 1920, height: 1080, aspectRatio: 1.777, frameRate: 30, zoom: 1, resizeMode: 'none' }),
    getCapabilities: () => ({ zoom: { min: 1, max: 8, step: 0.1 } }),
  };
  const info = describeCamera(track);
  assert(info.label === 'camera2 0, facing back' && info.zoom === 1 && info.zoomRange[1] === 8 && info.width === 1920, JSON.stringify(info));
  const bare = describeCamera({ label: 'Back Camera', getSettings: () => ({ width: 1280, height: 720 }) });
  assert(bare.label === 'Back Camera' && bare.zoom === undefined && bare.zoomRange === undefined, JSON.stringify(bare));
});

Deno.test({ name: 'sharpness, when a detector supplies it, keeps blurred corners out of the calibration', ignore, ...CV_TEST, fn() {
  // Setup: the synthetic capture where a third of each frame's corners are "blurred": moved by
  // 1.2 px in one direction (a bias, as defocus gives) and marked sharpness 30; the rest sharpness
  // 300. Two estimators: one fed the corners with their sharpness, one without it.
  // Test: run both to their first refinement.
  // Verifies: with sharpness the desktop's filter (>= 100, two markers) keeps the biased corners out
  // and the refined f is closer to the truth than without it -- the reason the detector should
  // report sharpness (reported).
  const results = {};

  for (const withSharpness of [true, false]) {
    const scheduler = manualScheduler();
    const estimator = createIntrinsicsEstimator(cv, spec, TRUE_K, { schedule: scheduler.schedule });

    for (const det of syntheticCapture(TRUE_K, 400, 31)) {
      const corners = det.corners.map((c, i) => {
        const blurred = i % 3 === 0;
        const moved = blurred ? { ...c, x: c.x + 1.2 } : c;
        return withSharpness ? { ...moved, sharpness: blurred ? 30 : 300, markers: 2 } : moved;
      });
      estimator.addDetection({ ...det, corners });
      scheduler.drain();

      if (estimator.current().source === 'refined') {
        break;
      }
    }

    results[withSharpness] = estimator.current();
    estimator.dispose();
  }

  console.log(`  biased third of the corners: refined f ${pct(results.true.f, TRUE_K.f).toFixed(3)}% with sharpness, `
    + `${pct(results.false.f, TRUE_K.f).toFixed(3)}% without`);
  assert(results.true.source === 'refined' && results.false.source === 'refined', 'not refined');
  assert(Math.abs(pct(results.true.f, TRUE_K.f)) < Math.abs(pct(results.false.f, TRUE_K.f)), 'sharpness did not help');
} });

for (const name of ['moissanite', 'spinel']) {
  Deno.test({ name: `real views (${name}): the live estimator's seed against the desktop's calibration`, ignore, ...CV_TEST, fn() {
    // Setup: the fixture's frames in capture order, ALL their corners (the phone measures no
    // sharpness), into a fresh estimator. The desktop's calibration of the whole capture is the
    // reference: for moissanite (2x zoom) its k1 model; for spinel the desktop chose a free
    // principal point, so the reference is its fixed-centre k1 candidate, the phone's model.
    // Test: read the estimator after the fixture's frames.
    // Verifies: the estimate lands within 2% of the reference (reported). Until T-0336 the
    // fixture's few dozen frames reached only the closed-form seed; since the 'one-view' lens lets
    // calibration views in from the first slanted frames, moissanite's 40 frames now reach a
    // refinement (0.45% off), so either is accepted.
    const fixture = loadFixture(name);
    const size = { width: fixture.image_size[0], height: fixture.image_size[1] };
    const d = fixture.desktop_calibration;
    const reference = d.fixed_centre_k1_candidate?.f ?? d.f;
    const scheduler = manualScheduler();
    const estimator = createIntrinsicsEstimator(cv, fixture.spec, size, { schedule: scheduler.schedule });

    for (const frame of fixture.frames) {
      estimator.addDetection(fixtureDetection(fixture, frame, 'all'));
      scheduler.drain();
    }

    const k = estimator.current();
    console.log(`  ${name}: after ${fixture.frames.length} frames: ${k.source} f ${k.f.toFixed(1)} (${pct(k.f, reference).toFixed(2)}% vs the `
      + `desktop's ${reference.toFixed(1)}; desktop final ${d.f.toFixed(1)}, ${d.model}); ${estimator.status().views} views held`);
    assert(k.source === 'closed-form' || k.source === 'refined', `source ${k.source}`);
    assert(Math.abs(pct(k.f, reference)) < 2, `seed ${k.f} vs ${reference}`);
    estimator.dispose();
  } });
}

// The whole reference captures: on this machine only (the scanner project is not in the repo).
const SCANNER = Deno.env.get('HOUSEKI_SCANNER') ?? '/Users/LucasTong/Documents/HousekiScanner';
let haveScanner = false;

try {
  haveScanner = Deno.statSync(`${SCANNER}/work/captures/moissanite/detections.json`).isFile;
} catch {
  haveScanner = false;
}

Deno.test({ name: 'full reference captures (scanner project only): seed and refined focal length vs the desktop', ignore: ignore || !haveScanner, ...CV_TEST, fn() {
  // Setup: every frame of the three scanner captures (moissanite and quartz: Pixel 7a at 2x zoom;
  // spinel: about 1x), in order, 200 ms apart as sampled, all corners or only the desktop's sharp
  // ones (sharpness >= 100 next to two markers, passed as `sharpness`/`markers`).
  // Test: the estimator's closed-form seed and refined K at the end.
  // Verifies (and reports, for the hand-back): with every corner the estimator refines, and the
  // refined f lands within 1% of the desktop's fixed-centre k1 calibration of the whole capture;
  // with only the sharp corners it lands within 0.5% where it gets 30 distinct views (moissanite
  // has only 30 frames with 12 sharp corners in all -- the desktop calibrated on exactly those --
  // so the phone, which also skips near-duplicate views, stays at the closed-form seed there);
  // no lens reset fires on any steady capture.
  for (const name of ['moissanite', 'spinel', 'quartz']) {
    const root = `${SCANNER}/work/captures/${name}`;
    const det = JSON.parse(Deno.readTextFileSync(`${root}/detections.json`));
    const cal = JSON.parse(Deno.readTextFileSync(`${root}/calibration.json`));
    const cov = JSON.parse(Deno.readTextFileSync(`${root}/coverage.json`));
    const reference = cal.lens_model?.candidates?.find((c) => c.name === 'k1')?.f ?? cal.K[0][0];
    const [width, height] = det.size;
    const fixtureSpec = { squares_x: det.board.squares_x, squares_y: det.board.squares_y, square_mm: 10, invalid_corner_ids: [], target: { centre_mm: cov.stone_point } };

    for (const sharp of [false, true]) {
      const scheduler = manualScheduler();
      const estimator = createIntrinsicsEstimator(cv, fixtureSpec, { width, height }, { schedule: scheduler.schedule });
      const history = [];
      estimator.onChange((k) => history.push({ ...k }));
      det.frames.forEach((f) => {
        const corners = f.ids.map((id, i) => ({
          id, x: f.corners[i][0] + 0.5, y: f.corners[i][1] + 0.5,
          ...(sharp ? { sharpness: f.corner_sharpness[i], markers: f.corner_markers[i] } : {}),
        }));
        estimator.addDetection({ frame: { width, height, timeMs: f.time * 1000 }, corners, markers: [], recognised: true, elapsedMs: 0 });
        scheduler.drain();
      });
      const seed = history.find((k) => k.source === 'closed-form');
      const refined = history.filter((k) => k.source === 'refined');
      const last = estimator.current();
      const s = estimator.status();
      console.log(`  ${name} (${sharp ? 'sharp' : 'all'} corners; desktop fixed-centre k1 f ${reference.toFixed(1)}): `
        + `seed ${seed ? `${pct(seed.f, reference).toFixed(2)}%` : 'none'}; `
        + refined.map((k) => `${k.views} views ${pct(k.f, reference).toFixed(2)}% k1 ${k.k1.toFixed(4)} rms ${k.rmsPx.toFixed(2)}`).join(', ')
        + (s.lastRefine ? `; refinement busy ${s.lastRefine.busyMs.toFixed(0)} ms in ${scheduler.stats().ticks} ticks `
          + `(longest ${scheduler.stats().maxTickMs.toFixed(1)} ms)` : `; not refined: ${s.views} distinct views held`));

      if (sharp && last.source !== 'refined') {
        assert(s.views < 30, `${name}: ${s.views} views but no refinement`);
      } else {
        assert(last.source === 'refined', `${name}: ${last.source}`);
        assert(Math.abs(pct(last.f, reference)) < (sharp ? 0.5 : 1), `${name} f ${last.f}`);
      }

      assert(s.lensResets === 0, `${name}: a lens reset`);
      estimator.dispose();
    }
  }
} });
