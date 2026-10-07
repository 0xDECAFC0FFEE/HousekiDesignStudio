/*
 * vision_pose_test.js -- the phone's camera pose relative to the board (T-0324, pose.js and
 * camera_model.js).
 *
 * pose.js is a port of the desktop scanner pipeline's pose (HousekiScanner calibrate.solve_pose and
 * step1.pose_frames' gates). These tests check it three ways:
 *   1. its plain-JS camera math against OpenCV's own (cv.Rodrigues, cv.projectPoints);
 *   2. synthetic views: board corners projected through known poses and intrinsics (with k1), with
 *      pixel noise, misread ids and dropped corners, then solved; the recovered pose is compared with
 *      the truth, and each validity gate is provoked on purpose;
 *   3. real views from the desktop pipeline (fixtures/vision_pose/*.json, made by make_fixture.py
 *      from two scanner captures): given the desktop's K and its corners, the phone's pose must equal
 *      the desktop solver's on the same (nominal) board, and stay close to the desktop's published
 *      pose, which used a per-corner refined board.
 *
 * opencv.js is the stock 4.12 build (test-only dev dependency); every test that needs it is skipped
 * when it is not installed.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 */

import { BOARD_SPECS, cornerPoint } from '../src/lib/vision/board_frame.js';
import {
  matMul3, projectPoints, refinePose, rodrigues, rotationToVector, scaleIntrinsics, spansPlane,
} from '../src/lib/vision/camera_model.js';
import {
  createPoseSmoother, createPoseSolver, MAX_POSE_RMS_PX, FALLBACK_MAX_RMS_PX, rotationAngleDeg,
} from '../src/lib/vision/pose.js';
import {
  assert, assertClose, CV_TEST, fixtureDetection, fixtureIntrinsics, gaussian, loadFixture, loadStockOpenCv, lookAtPose,
  seededRandom, syntheticDetection,
} from './vision_test_support.js';

const cv = await loadStockOpenCv();
const ignore = cv === null;
const spec = BOARD_SPECS.charuco_23x17_10mm_centre1;
const TARGET = spec.target.centre_mm;      // (85, 115) mm: the middle of the sheet

// A portrait 1080 x 1920 phone frame, f = 1.4 x the long side (a 2x-zoom-like field), barrel k1.
const K = Object.freeze({ width: 1080, height: 1920, f: 2700, cx: 540, cy: 960, k1: 0.05, source: 'guess' });

const distance3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

Deno.test({ name: 'the JS Rodrigues and projection agree with OpenCV\'s', ignore, ...CV_TEST, fn() {
  // Setup: 20 random rotation vectors and translations in front of the camera, 30 random board
  // points each, the test intrinsics with k1 = 0.05.
  // Test: rotate with rodrigues() and cv.Rodrigues; project with projectPoints() and
  // cv.projectPoints (dist = [k1, 0, 0, 0, 0]); invert with rotationToVector.
  // Verifies: pose.js's plain-JS camera model is OpenCV's model exactly (1e-9 on the matrix,
  // 1e-6 px on the pixels), so pruning and residuals mean what the desktop's mean.
  const random = seededRandom(11);
  const Kmat = cv.matFromArray(3, 3, cv.CV_64F, [K.f, 0, K.cx, 0, K.f, K.cy, 0, 0, 1]);
  const dist = cv.matFromArray(1, 5, cv.CV_64F, [K.k1, 0, 0, 0, 0]);

  for (let trial = 0; trial < 20; trial += 1) {
    const rv = [random() - 0.5, random() - 0.5, random() - 0.5].map((v) => v * 4);
    const t = [random() * 40 - 20, random() * 40 - 20, 200 + random() * 200];
    const rvMat = cv.matFromArray(3, 1, cv.CV_64F, rv);
    const tvMat = cv.matFromArray(3, 1, cv.CV_64F, t);
    const Rcv = new cv.Mat();
    cv.Rodrigues(rvMat, Rcv);
    const R = rodrigues(rv);
    Array.from(Rcv.data64F).forEach((v, i) => assertClose(R[i], v, 1e-9, `R[${i}]`));

    if (Math.hypot(...rv) < Math.PI - 0.01) {
      // below a half turn the rotation vector is unique: the inverse must give it back
      rotationToVector(R).forEach((v, i) => assertClose(v, rv[i], 1e-9, 'rvec'));
    }

    // points kept within ~25 degrees of the axis, where both models are well defined
    const points = [...Array(30)].map(() => [random() * 60 - 30, random() * 60 - 30, random() * 10]);
    const camPoints = points.map((p) => {
      const q = [0, 1, 2].map((i) => R[3 * i] * p[0] + R[3 * i + 1] * p[1] + R[3 * i + 2] * p[2] + t[i]);
      return q;
    });
    const objMat = cv.matFromArray(30, 1, cv.CV_64FC3, points.flat());
    const out = new cv.Mat();
    cv.projectPoints(objMat, rvMat, tvMat, Kmat, dist, out);
    const mine = projectPoints(points, R, t, K);
    camPoints.forEach((q, i) => {
      if (q[2] > 0) {
        assertClose(mine[2 * i], out.data64F[2 * i], 1e-6, 'u');
        assertClose(mine[2 * i + 1], out.data64F[2 * i + 1], 1e-6, 'v');
      }
    });
    [rvMat, tvMat, Rcv, objMat, out].forEach((m) => m.delete());
  }

  Kmat.delete();
  dist.delete();
} });

Deno.test({ name: 'the JS LM reaches cv.solvePnPRefineLM\'s minimum, and does not stall on a top-down view', ignore, ...CV_TEST, fn() {
  // Setup: (a) 12 synthetic oblique views with 0.5 px noise, each started from its true pose turned
  // by ~2 degrees and moved ~5 mm; (b) the real moissanite frame 1495: a near top-down 2x-zoom view
  // with 10 corners, whose IPPE start (rotation vector length ~3.06, near pi) the desktop's
  // OpenCV 5.0 LM refines to 0.9667 px.
  // Test: refine with camera_model.refinePose and with cv.solvePnPRefineLM (20 iterations, run
  // three times as the desktop's three rounds would).
  // Verifies: (a) on ordinary views both land on the same minimum (cost within 1e-6 relative, pose
  // within 1e-4 degree); (b) on the top-down view opencv.js 4.12 is still at 2.85 px after
  // 3 x 20 iterations while refinePose reaches the desktop's 0.9667 px -- why pose.js does not use
  // opencv.js's LM.
  const random = seededRandom(31);
  const Kmat = cv.matFromArray(3, 3, cv.CV_64F, [K.f, 0, K.cx, 0, K.f, K.cy, 0, 0, 1]);
  const dist = cv.matFromArray(1, 5, cv.CV_64F, [K.k1, 0, 0, 0, 0]);
  const cvRefine = (points, pixels, R0, t0) => {
    const O = cv.matFromArray(points.length, 1, cv.CV_64FC3, points.flat());
    const I = cv.matFromArray(points.length, 1, cv.CV_64FC2, pixels.flat());
    const rv = cv.matFromArray(3, 1, cv.CV_64F, rotationToVector(R0));
    const tv = cv.matFromArray(3, 1, cv.CV_64F, t0);

    for (let round = 0; round < 3; round += 1) {
      cv.solvePnPRefineLM(O, I, Kmat, dist, rv, tv);
    }

    const out = { R: rodrigues(Array.from(rv.data64F)), t: Array.from(tv.data64F) };
    [O, I, rv, tv].forEach((m) => m.delete());
    return out;
  };
  const rmsOf = (points, pixels, R, t, intr = K) => {
    const p = projectPoints(points, R, t, intr);
    return Math.sqrt(pixels.reduce((s, q, i) => s + (p[2 * i] - q[0]) ** 2 + (p[2 * i + 1] - q[1]) ** 2, 0) / pixels.length);
  };

  for (let v = 0; v < 12; v += 1) {
    const truth = lookAtPose(TARGET, 30 * v, 30 + 3 * v, 250, 10);
    const det = syntheticDetection(spec, truth, K, { noisePx: 0.5, random });
    const points = det.corners.map((c) => cornerPoint(spec, c.id));
    const pixels = det.corners.map((c) => [c.x, c.y]);
    // a turn of ~2 degrees about a random-ish axis, applied to the true rotation
    const Rstart = matMul3(rodrigues([0.02, -0.02, 0.02].map((x) => x * (random() + 0.5))), truth.R);
    const tStart = truth.t.map((x) => x + 3 * (random() - 0.5));
    const mine = refinePose(points, pixels, Rstart, tStart, K);
    const theirs = cvRefine(points, pixels, Rstart, tStart);
    const a = rmsOf(points, pixels, mine.R, mine.t);
    const b = rmsOf(points, pixels, theirs.R, theirs.t);
    assert(Math.abs(a - b) <= 1e-6 * b, `view ${v}: rms ${a} vs ${b}`);
    assert(rotationAngleDeg(mine.R, theirs.R) < 1e-4, `view ${v}: rotation differs`);
  }

  const fixture = loadFixture('moissanite');
  const frame = fixture.frames.find((f) => f.index === 1495);
  const intr = fixtureIntrinsics(fixture);
  const det = fixtureDetection(fixture, frame);
  const points = det.corners.map((c) => cornerPoint(fixture.spec, c.id));
  const pixels = det.corners.map((c) => [c.x, c.y]);
  // the IPPE start both OpenCV versions agree on (measured): rotation vector and translation
  const Rstart = rodrigues([-3.062780009479377, -0.09352987573995637, -0.12458936932189832]);
  const tStart = [-90.34397117217264, 120.26494807162058, 149.1268317676029];
  Kmat.data64F.set([intr.f, 0, intr.cx, 0, intr.f, intr.cy, 0, 0, 1]);
  dist.data64F.set([intr.k1, 0, 0, 0, 0]);
  const stalled = cvRefine(points, pixels, Rstart, tStart);
  const mine = refinePose(points, pixels, Rstart, tStart, intr);
  const stalledRms = rmsOf(points, pixels, stalled.R, stalled.t, intr);
  const mineRms = rmsOf(points, pixels, mine.R, mine.t, intr);
  console.log(`  top-down frame 1495: opencv.js LM ${stalledRms.toFixed(4)} px, refinePose ${mineRms.toFixed(4)} px `
    + `(desktop ${frame.plain.rms_px} px) in ${mine.iterations} iterations`);
  assert(stalledRms > 1.5, 'opencv.js LM no longer stalls: refinePose may not be needed');
  assertClose(mineRms, frame.plain.rms_px, 1e-4, 'refinePose did not reach the desktop minimum');
  Kmat.delete();
  dist.delete();
} });

Deno.test('spansPlane refuses corners on one line and accepts a patch', () => {
  // Setup: board points in mm (10 mm squares): one row of 10 corners; the same row with one corner
  // a square off the line; a 3 x 4 patch.
  // Test: spansPlane (calibrate._spans_plane: second singular value / sqrt(n) > half a square).
  // Verifies: a single row (all ids along one printed row: a degenerate pose) is refused, a row
  // with one stray corner is still refused (s1 / sqrt(n) is ~0.3 squares), a real patch passes,
  // and fewer than 4 points never pass.
  const row = [...Array(10)].map((_, i) => [10, 10 + 10 * i, 0]);
  assert(!spansPlane(row, 10), 'a row spans the plane');
  assert(!spansPlane([...row.slice(0, 9), [20, 50, 0]], 10), 'a row with one stray corner spans the plane');
  const patch = [];

  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      patch.push([10 * (r + 1), 10 * (c + 1), 0]);
    }
  }

  assert(spansPlane(patch, 10), 'a 3 x 4 patch does not span the plane');
  assert(!spansPlane(patch.slice(0, 3), 10), 'three points span the plane');
});

Deno.test({ name: 'synthetic views: the pose is recovered to hundredths of a degree and tenths of a mm', ignore, ...CV_TEST, fn() {
  // Setup: 72 cameras around the sheet's centre (azimuth every 30 degrees, elevation 25/50/75
  // degrees, distance 220 and 350 mm, a roll of up to +/-20 degrees), each seeing the board through
  // K (k1 = 0.05) with 0.4 px Gaussian pixel noise per axis, 15% of the corners dropped and 3
  // corners given another board corner's id (a misread marker).
  // Test: solve each view.
  // Verifies: every view gives a valid pose; the rotation error stays under 0.1 degree (median
  // under 0.03), the camera centre under 1.5 mm (median under 0.5), azimuth / elevation / distance
  // match the camera that made the view; and the 3 misread corners are pruned (the inliers are at
  // most the corner count minus 3) -- the 3 x median rule at work.
  const solver = createPoseSolver(cv, spec);
  const random = seededRandom(5);
  const rotErr = [];
  const centreErr = [];
  let views = 0;
  const t0 = performance.now();

  for (const elevation of [25, 50, 75]) {
    for (let azimuth = 0; azimuth < 360; azimuth += 30) {
      for (const distance of [220, 350]) {
        const truth = lookAtPose(TARGET, azimuth, elevation, distance, 40 * random() - 20);
        const det = syntheticDetection(spec, truth, K, { noisePx: 0.4, random, dropFraction: 0.15, wrongIds: 3 });
        const pose = solver.solve(det, K);
        views += 1;
        assert(pose && pose.valid, `az ${azimuth} el ${elevation} d ${distance}: ${pose?.reason ?? 'no pose'}`);
        rotErr.push(rotationAngleDeg(pose.R, truth.R));
        centreErr.push(distance3(pose.center, truth.center));
        assertClose(pose.elevationDeg, elevation, 0.3, 'elevation');
        assertClose(pose.distanceMm, distance, 1.5, 'distance');
        const dAz = ((pose.azimuthDeg - azimuth + 540) % 360) - 180;
        assertClose(dAz, 0, elevation > 70 ? 1 : 0.3, 'azimuth');
        assert(pose.inliers <= det.corners.length - 3, 'a misread corner was kept');
      }
    }
  }

  const ms = (performance.now() - t0) / views;
  rotErr.sort((a, b) => a - b);
  centreErr.sort((a, b) => a - b);
  const med = (a) => a[a.length >> 1];
  console.log(`  ${views} views: rotation error median ${med(rotErr).toFixed(4)} max ${rotErr.at(-1).toFixed(4)} deg; `
    + `centre error median ${med(centreErr).toFixed(3)} max ${centreErr.at(-1).toFixed(3)} mm; ${ms.toFixed(2)} ms per solve (incl. synthesis)`);
  assert(med(rotErr) < 0.03 && rotErr.at(-1) < 0.1, 'rotation error');
  assert(med(centreErr) < 0.5 && centreErr.at(-1) < 1.5, 'centre error');
  solver.dispose();
} });

Deno.test({ name: 'misread corner ids are pruned as outliers', ignore, ...CV_TEST, fn() {
  // Setup: one oblique view (azimuth 40, elevation 45, 260 mm) with 0.3 px noise; then the same
  // corners with 4 of them relabelled to ids two squares away (as a misread marker gives).
  // Test: solve both.
  // Verifies: the relabelled corners are exactly the ones left out of inlierIds, the pose barely
  // moves (< 0.02 degree, < 0.2 mm) and stays valid: the prune at max(1.5 px, 3 x median) after
  // each LM round removes them, as on the desktop.
  const solver = createPoseSolver(cv, spec);
  const truth = lookAtPose(TARGET, 40, 45, 260, 5);
  const det = syntheticDetection(spec, truth, K, { noisePx: 0.3, random: seededRandom(2) });
  const clean = solver.solve(det, K);
  const victims = [det.corners[10], det.corners[40], det.corners[80], det.corners[120]];
  const used = new Set(det.corners.map((c) => c.id));
  const relabelled = det.corners.map((c) => {
    if (!victims.includes(c)) {
      return c;
    }

    let id = c.id + 2;

    while (used.has(id)) {
      id += 1;
    }

    used.add(id);
    return { ...c, id };
  });
  const wrongIds = relabelled.filter((c, i) => c.id !== det.corners[i].id).map((c) => c.id);
  const pose = solver.solve({ ...det, corners: relabelled }, K);
  assert(pose.valid, pose.reason);
  wrongIds.forEach((id) => assert(!pose.inlierIds.includes(id), `misread id ${id} kept`));
  assert(pose.inliers === relabelled.length - 4, `inliers ${pose.inliers} of ${relabelled.length}`);
  assert(rotationAngleDeg(pose.R, clean.R) < 0.02, 'rotation moved');
  assert(distance3(pose.center, clean.center) < 0.2, 'centre moved');
  solver.dispose();
} });

Deno.test({ name: 'the gates: too few, collinear, below the board, high residual, disagreeing corners', ignore, ...CV_TEST, fn() {
  // Setup: one good oblique view, then variants of it.
  // Test / verifies, one gate each (step1.pose_frames' order and wording):
  //   - 7 corners -> null (MIN_POSE_CORNERS is 8);
  //   - 12 corners all on one printed row -> null (no plane to fit);
  //   - a camera UNDER the board (elevation -40) -> a pose, valid false, "camera below the board
  //     plane" (the math is fine; the paper is opaque, so it is a wrong solution);
  //   - 2.5 px noise -> valid false, "high residual", against the 1.5 px default and the 1.0 px
  //     strict limit (MAX_POSE_RMS_PX) passed per call;
  //   - 45% of the corners shifted 40 px in one direction -> they are pruned, the other 55% fit
  //     well, but fewer than 60% fit: "corners disagree" (also after the RANSAC retry).
  const solver = createPoseSolver(cv, spec);
  const truth = lookAtPose(TARGET, 120, 40, 240, 0);
  const det = syntheticDetection(spec, truth, K, { noisePx: 0.2, random: seededRandom(9) });
  assert(solver.solve(det, K).valid, 'the base view is not valid');

  assert(solver.solve({ ...det, corners: det.corners.slice(0, 7) }, K) === null, '7 corners gave a pose');

  const row = det.corners.filter((c) => Math.floor(c.id / 22) === 8).slice(0, 12);
  assert(row.length === 12, `row has ${row.length} corners`);
  assert(solver.solve({ ...det, corners: row }, K) === null, 'one row of corners gave a pose');

  const below = lookAtPose(TARGET, 120, -40, 240, 0);
  const belowPose = solver.solve(syntheticDetection(spec, below, K, { noisePx: 0.2 }), K);
  assert(belowPose && !belowPose.valid && belowPose.reason === 'camera below the board plane', `below: ${belowPose?.reason}`);

  const noisy = syntheticDetection(spec, truth, K, { noisePx: 2.5, random: seededRandom(4) });
  const noisyPose = solver.solve(noisy, K);
  assert(noisyPose && !noisyPose.valid && noisyPose.reason.startsWith('high residual'), `noisy: ${noisyPose?.reason}`);
  // 0.9 px noise per axis (~1.25 px RMS) passes the 1.5 px default but not the strict 1.0 px limit
  const mid = syntheticDetection(spec, truth, K, { noisePx: 0.9, random: seededRandom(4) });
  assert(solver.solve(mid, K).valid, `0.9 px noise refused at ${FALLBACK_MAX_RMS_PX} px`);
  const strict = solver.solve(mid, K, { maxRmsPx: MAX_POSE_RMS_PX });
  assert(!strict.valid && strict.reason.startsWith('high residual'), `strict: ${strict.reason}`);

  const shifted = det.corners.map((c, i) => (i % 20 < 9 ? { ...c, x: c.x + 40 } : c));
  const shiftedPose = solver.solve({ ...det, corners: shifted }, K);
  assert(shiftedPose && !shiftedPose.valid && shiftedPose.reason.startsWith('corners disagree'), `shifted: ${shiftedPose?.reason}`);
  solver.dispose();
} });

Deno.test({ name: 'azimuth, elevation and distance follow the desktop convention', ignore, ...CV_TEST, fn() {
  // Setup: noiseless cameras straight "below" the target on the page (+X), to its right (+Y), and
  // above it on the page (-X), all at 35 degrees elevation and 300 mm.
  // Test: solve each.
  // Verifies: azimuth is measured from +X (down the page) towards +Y (right), counter-clockwise
  // seen from above, as HousekiScanner selection.view_angles / coverage.analyse: 0, 90 and 180
  // degrees; elevation and distance are from spec.target.centre_mm.
  const solver = createPoseSolver(cv, spec);

  for (const [azimuth, expected] of [[0, 0], [90, 90], [180, 180], [270, 270]]) {
    const truth = lookAtPose(TARGET, azimuth, 35, 300, 0);
    const pose = solver.solve(syntheticDetection(spec, truth, K), K);
    assert(pose?.valid, `azimuth ${azimuth}: ${pose?.reason}`);
    assertClose(((pose.azimuthDeg - expected + 540) % 360) - 180, 0, 0.01, `azimuth ${azimuth}`);
    assertClose(pose.elevationDeg, 35, 0.01, 'elevation');
    assertClose(pose.distanceMm, 300, 0.05, 'distance');
    // the camera at azimuth 0 is at larger X than the target: further down the printed page
    if (azimuth === 0) {
      assert(pose.center[0] > TARGET[0] + 200, `centre ${pose.center}`);
    }
  }

  solver.dispose();
} });

Deno.test({ name: 'a smaller frame scales the intrinsics and the pixel gates', ignore, ...CV_TEST, fn() {
  // Setup: one view made at 540 x 960 (half the size of K) with 0.2 px noise.
  // Test: solve it with the full-size K.
  // Verifies: solve rescales K to the frame (f 1350, centre 270, 480) and gets the same pose as
  // with K rescaled by hand; a frame of another aspect ratio returns null rather than a wrong pose.
  const solver = createPoseSolver(cv, spec);
  const half = scaleIntrinsics(K, { width: 540, height: 960 });
  assertClose(half.f, 1350, 1e-9, 'scaled f');
  const truth = lookAtPose(TARGET, 200, 55, 280, 0);
  const det = syntheticDetection(spec, truth, half, { noisePx: 0.2, random: seededRandom(3) });
  const pose = solver.solve(det, K);
  const direct = solver.solve(det, half);
  assert(pose.valid && pose.intrinsics.f === 1350, 'not rescaled');
  assert(pose.R.every((v, i) => v === direct.R[i]) && pose.t.every((v, i) => v === direct.t[i]), 'differs from the hand-scaled K');
  const square = { ...det, frame: { width: 960, height: 960, timeMs: 0 } };
  assert(solver.solve(square, K) === null, 'another aspect ratio gave a pose');
  solver.dispose();
} });

Deno.test({ name: 'a refined board (objectPoints) is used by the LM rounds', ignore, ...CV_TEST, fn() {
  // Setup: a "refined" board: every corner moved by up to +/-0.15 mm in X/Y and +/-0.3 mm in Z (paper
  // waviness, as the desktop learns per corner); a view made from that board with 0.1 px noise.
  // Test: solve with the nominal board and with objectPoints = the refined board.
  // Verifies: with the refined board the residual drops to the noise (< 0.2 px) and the pose is
  // closer to the truth than with the nominal board -- the IPPE-on-Z=0 then LM-on-refined split of
  // calibrate.solve_pose works (IPPE alone refuses non-planar points).
  const random = seededRandom(21);
  const refined = new Map();

  for (let id = 0; id < 352; id += 1) {
    const r = Math.floor(id / 22);
    const c = id % 22;
    refined.set(id, [(r + 1) * 10 + 0.3 * (random() - 0.5), (c + 1) * 10 + 0.3 * (random() - 0.5), 0.6 * (random() - 0.5)]);
  }

  const refinedSpec = { ...spec };
  const truth = lookAtPose(TARGET, 300, 30, 230, 0);
  // project the refined corners by hand (syntheticDetection uses the nominal board)
  const ids = [...refined.keys()];
  const projected = projectPoints(ids.map((id) => refined.get(id)), truth.R, truth.t, K);
  const corners = [];
  ids.forEach((id, i) => {
    const x = projected[2 * i] + 0.1 * gaussian(random);
    const y = projected[2 * i + 1] + 0.1 * gaussian(random);

    if (x > 0 && y > 0 && x < K.width && y < K.height) {
      corners.push({ id, x, y });
    }
  });
  const det = { frame: { width: K.width, height: K.height, timeMs: 0 }, markers: [], corners, recognised: true, elapsedMs: 0 };
  const nominal = createPoseSolver(cv, refinedSpec).solve(det, K);
  const withRefined = createPoseSolver(cv, refinedSpec, { objectPoints: refined }).solve(det, K);
  console.log(`  refined board: rms ${withRefined.rmsPx.toFixed(3)} px vs nominal ${nominal.rmsPx.toFixed(3)} px; centre error `
    + `${distance3(withRefined.center, truth.center).toFixed(3)} vs ${distance3(nominal.center, truth.center).toFixed(3)} mm`);
  assert(withRefined.rmsPx < 0.2, `refined rms ${withRefined.rmsPx}`);
  assert(withRefined.rmsPx < nominal.rmsPx, 'refined board did not lower the residual');
  assert(distance3(withRefined.center, truth.center) < distance3(nominal.center, truth.center), 'refined board not closer');
} });

Deno.test('the smoother averages jitter, follows a still pose exactly and restarts after a gap', () => {
  // Setup: a still camera (from lookAtPose) whose centre jitters +/-1 mm and rotation +/-0.3 degree
  // frame to frame, 30 frames 33 ms apart; then a frame 2 s later at another place.
  // Test: feed the frames through createPoseSmoother (120 ms time constant).
  // Verifies: the smoothed centre's jitter is under half the raw jitter; a pose repeated exactly
  // comes out exactly; after a gap over maxGapMs the output is the new pose, not a blend.
  const random = seededRandom(8);
  const smoother = createPoseSmoother(spec);
  const base = lookAtPose(TARGET, 60, 45, 250, 0);
  const raw = [];
  const smooth = [];

  for (let i = 0; i < 30; i += 1) {
    const rv = rotationToVector(base.R).map((v) => v + 0.005 * (random() - 0.5));
    const R = rodrigues(rv);
    const center = base.center.map((v) => v + 2 * (random() - 0.5));
    const t = [0, 1, 2].map((k) => -(R[3 * k] * center[0] + R[3 * k + 1] * center[1] + R[3 * k + 2] * center[2]));
    const out = smoother.update({ frame: { timeMs: 33 * i }, R, t, center, valid: true });
    raw.push(distance3(center, base.center));
    smooth.push(distance3(out.center, base.center));
  }

  const rms = (a) => Math.sqrt(a.slice(10).reduce((s, v) => s + v * v, 0) / (a.length - 10));
  console.log(`  smoother: centre jitter ${rms(raw).toFixed(3)} mm raw -> ${rms(smooth).toFixed(3)} mm smoothed`);
  assert(rms(smooth) < 0.5 * rms(raw), 'smoothing did not halve the jitter');

  const still = smoother.update({ frame: { timeMs: 3000 }, ...base, valid: true });
  assert(distance3(still.center, base.center) < 1e-9, 'restart after a gap blended');
  const again = smoother.update({ frame: { timeMs: 3033 }, ...base, valid: true });
  assert(distance3(again.center, base.center) < 1e-9 && rotationAngleDeg(again.R, base.R) < 1e-6, 'a still pose moved');
});

for (const name of ['moissanite', 'spinel']) {
  Deno.test({ name: `real views (${name}): the desktop's own solver on the same corners, to 1e-4 degree`, ignore, ...CV_TEST, fn() {
    // Setup: the fixture's frames from the desktop capture, with the desktop's K (f, centre, k1) and,
    // per frame, the corner set the desktop posed it with ("best": sharp, two markers; "extended").
    // The fixture also holds the pose the desktop's calibrate.solve_pose returned on the NOMINAL
    // board for those corners (make_fixture.py ran it), and the desktop's published pose (on its
    // refined board).
    // Test: solve every frame on the phone with the same K, corners and RMS limit (1.0 px best,
    // 1.5 px extended), with the RANSAC retry off (the desktop exactly) and on (the phone's default).
    // Verifies: the port is exact -- every frame the desktop could pose is posed, with the same
    // inlier count, rotation within 1e-4 degree, centre within 1e-3 mm and RMS within 1e-4 px of
    // the desktop solver's; against the desktop's published (refined-board) pose the difference
    // stays small (median under 0.15 degree and 1 mm, reported); and the retry never changes a
    // pose the desktop accepts (it only acts on frames that fail the gates).
    const fixture = loadFixture(name);
    const fixtureSpec = fixture.spec;
    const intr = fixtureIntrinsics(fixture);
    const solver = createPoseSolver(cv, fixtureSpec, { ransacRetry: false });
    const phone = createPoseSolver(cv, fixtureSpec);
    let rescued = 0;
    const vsPlainRot = [];
    const vsPlainCentre = [];
    const vsDesktopRot = [];
    const vsDesktopCentre = [];
    let agreeValid = 0;
    let compared = 0;
    let solveMs = 0;

    for (const frame of fixture.frames) {
      const det = fixtureDetection(fixture, frame);
      const limit = frame.corner_set === 'best' ? MAX_POSE_RMS_PX : FALLBACK_MAX_RMS_PX;
      const t0 = performance.now();
      const pose = solver.solve(det, intr, { maxRmsPx: limit });
      solveMs += performance.now() - t0;
      const phonePose = phone.solve(det, intr, { maxRmsPx: limit });

      if (pose?.valid) {
        assert(phonePose.start === 'ippe' && phonePose.R.every((v, i) => v === pose.R[i]), `frame ${frame.index}: retry changed a valid pose`);
      } else if (phonePose?.valid) {
        rescued += 1;
      }

      if (!frame.plain) {
        assert(pose === null, `frame ${frame.index}: posed, the desktop could not`);
        continue;
      }

      assert(pose, `frame ${frame.index}: no pose, the desktop had one`);
      assert(pose.inliers === frame.plain.inliers, `frame ${frame.index}: inliers ${pose.inliers} vs ${frame.plain.inliers}`);
      vsPlainRot.push(rotationAngleDeg(pose.R, frame.plain.R));
      vsPlainCentre.push(distance3(pose.center, frame.plain.center));
      assertClose(pose.rmsPx, frame.plain.rms_px, 1e-4, `frame ${frame.index} rms`);

      if (frame.desktop.R) {
        compared += 1;
        vsDesktopRot.push(rotationAngleDeg(pose.R, frame.desktop.R.flat()));
        vsDesktopCentre.push(distance3(pose.center, frame.desktop.center));
        agreeValid += pose.valid === frame.desktop.valid ? 1 : 0;
      }
    }

    const sorted = (a) => [...a].sort((x, y) => x - y);
    const med = (a) => sorted(a)[a.length >> 1];
    const max = (a) => sorted(a).at(-1);
    console.log(`  ${name}: ${vsPlainRot.length} frames vs the desktop solver (nominal board): rotation max `
      + `${max(vsPlainRot).toExponential(2)} deg, centre max ${max(vsPlainCentre).toExponential(2)} mm; `
      + `vs the desktop's refined-board poses (${compared}): rotation median ${med(vsDesktopRot).toFixed(3)} max `
      + `${max(vsDesktopRot).toFixed(3)} deg, centre median ${med(vsDesktopCentre).toFixed(2)} max ${max(vsDesktopCentre).toFixed(2)} mm, `
      + `same validity ${agreeValid}/${compared}; the RANSAC retry made ${rescued} more frame(s) valid; `
      + `${(solveMs / fixture.frames.length).toFixed(2)} ms per solve`);
    assert(max(vsPlainRot) < 1e-4, 'rotation differs from the desktop solver');
    assert(max(vsPlainCentre) < 1e-3, 'centre differs from the desktop solver');
    assert(med(vsDesktopRot) < 0.15 && med(vsDesktopCentre) < 1, 'far from the desktop\'s published poses');
    solver.dispose();
    phone.dispose();
  } });
}

Deno.test({ name: 'real views with the refined board reproduce the desktop\'s published poses', ignore, ...CV_TEST, fn() {
  // Setup: the moissanite fixture plus the desktop's refined corner positions
  // (calibration.json board_corners_refined_mm; every other corner nominal).
  // Test: solve every frame with objectPoints = that refined board.
  // Verifies: the published poses (poses.json) come back to 0.01 degree / 0.02 mm, and every
  // validity verdict and inlier count is the desktop's: the phone, given the desktop's board, IS the
  // desktop's pose stage. (Not to 1e-5 as against the desktop's solver above: the published poses
  // were solved from the unrounded corners, and the fixture rounds corners to 0.01 px and the
  // refined board to 1e-4 mm; at 2x zoom, with 10-30 corners, that moves a pose by up to ~0.004
  // degree.)
  const fixture = loadFixture('moissanite');
  const refined = new Map(fixture.refined_corners_mm.map(([id, x, y, z]) => [id, [x, y, z]]));
  const solver = createPoseSolver(cv, fixture.spec, { objectPoints: refined, ransacRetry: false });
  const intr = fixtureIntrinsics(fixture);
  let worstRot = 0;
  let worstCentre = 0;
  let n = 0;

  for (const frame of fixture.frames.filter((f) => f.desktop.R)) {
    const limit = frame.corner_set === 'best' ? MAX_POSE_RMS_PX : FALLBACK_MAX_RMS_PX;
    const pose = solver.solve(fixtureDetection(fixture, frame), intr, { maxRmsPx: limit });
    worstRot = Math.max(worstRot, rotationAngleDeg(pose.R, frame.desktop.R.flat()));
    worstCentre = Math.max(worstCentre, distance3(pose.center, frame.desktop.center));
    assert(pose.valid === frame.desktop.valid, `frame ${frame.index}: valid ${pose.valid} (${pose.reason}) vs ${frame.desktop.valid} (${frame.desktop.reason})`);
    assert(pose.inliers === frame.desktop.corners_used, `frame ${frame.index}: inliers`);
    n += 1;
  }

  console.log(`  moissanite, refined board: ${n} frames, rotation max ${worstRot.toExponential(2)} deg, centre max ${worstCentre.toExponential(2)} mm`);
  assert(worstRot < 0.01 && worstCentre < 0.02, 'not the desktop\'s pose');
  solver.dispose();
} });
