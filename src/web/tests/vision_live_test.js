/*
 * vision_live_test.js -- the phone's vision on live frames, end to end on the CPU (T-0326):
 * src/web/src/lib/vision/live.js, with the real opencv.js the phone page loads for the pose
 * (src/web/vendor/opencv/opencv.js, run under Deno as committed) and the phone's board detector,
 * the Rust vision module as built (build/vision/houseki_vision.js; ignored when not built).
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The frames are drawn by tests/vision_render.js: the scanner's boards (T-0340; the white/black
 * one unless a test says), seen through a known camera, so the true pose is known. The camera's focal
 * length is chosen equal to the phone's first guess (0.85 x the long side, intrinsics.js), so the
 * pose can be checked against the truth from the very first frame, before any live calibration.
 * The rock's outline needs WebGL2, so it is not run here (glCanvas null): it is
 * tests/harness/test_scan_vision.py's, in Chrome, with the rest of the page.
 *
 * What is checked: a frame read at full size and the same frame read at half size (the page reads
 * a downscaled copy) both give the true pose, with every pixel coordinate in the FULL frame; the
 * result names the board in view, and carries the intrinsics and per-stage timings; its message
 * validates; each of the three boards is read and named, and an older board's markers are not
 * read at all; warmUp() runs; and no OpenCV memory is leaked over many frames.
 */

import { loadOpenCv, wasmHeapInUse } from '../src/lib/vision/opencv.js';
import { BOARD_LIST, BOARD_NAME, BOARD_SPEC } from '../src/lib/vision/board_frame.js';
import { createLiveVision } from '../src/lib/vision/live.js';
import { rotationAngleDeg } from '../src/lib/vision/pose.js';
import { makeVisionMessage, validateVisionMessage } from '../src/lib/scan_vision.js';
import { cameraPose, downscale, renderSheet } from './vision_render.js';
import { loadBuiltVision, VISION_BUILT } from './vision_test_support.js';


function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

const OPENCV_JS = new URL('../vendor/opencv/opencv.js', import.meta.url);
const cv = await loadOpenCv({ source: await Deno.readTextFile(OPENCV_JS) });
const vision = await loadBuiltVision();
const CV_TEST = { sanitizeOps: false, sanitizeResources: false, ignore: !VISION_BUILT };

// A 960 x 720 frame, focal length 816 px (0.85 x 960: the phone's guess), 220 mm from the board's
// middle (85, 115 mm, where the stone goes) at 55 degrees: squares ~37 px, markers ~26 px.
const WIDTH = 960;
const HEIGHT = 720;
const TARGET = [85, 115, 0];
const TRUTH = cameraPose(TARGET, {
  azimuthDeg: 200, elevationDeg: 55, distanceMm: 220, rollDeg: 10, width: WIDTH, height: HEIGHT, f: 0.85 * WIDTH,
});
const FULL = renderSheet(BOARD_SPEC, TRUTH, { noise: 1.5 });
const HALF = downscale(FULL, 2);

/** A live vision for the test frames, with intrinsics refinement never scheduled. */
function newLive(options = {}) {
  return createLiveVision(cv, { vision, frameSize: { width: WIDTH, height: HEIGHT }, glCanvas: null, schedule: () => {}, ...options });
}

/** How far a result's pose is from the truth: rotation (deg) and camera centre (mm). */
function poseError(pose) {
  return {
    rotationDeg: rotationAngleDeg(pose.R, TRUTH.R),
    centreMm: Math.hypot(...pose.center.map((c, i) => c - TRUTH.center[i])),
  };
}

Deno.test('live vision: a full-size frame gives the true pose, and names the board', CV_TEST, () => {
  // Setup: a fresh live vision; the full 960 x 720 frame of the white/black board at scale 1.
  // Test: process it once.
  // Verifies: the board is recognised with many corners, the pose is valid and within 0.3 degrees
  // and 2 mm of the truth (the intrinsics are the guess, which equals the true camera here), the
  // detection and the result name the white/black board with its target (85, 115), and the
  // timings are filled in.
  const live = newLive();
  const result = live.processFrame({ image: FULL, scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: 100 } });
  const error = poseError(result.pose);
  console.log(`  full size: ${result.detection.corners.length} corners, ${result.detection.markers.length} markers, `
    + `rms ${result.pose.rmsPx.toFixed(2)} px, error ${error.rotationDeg.toFixed(3)} deg / ${error.centreMm.toFixed(2)} mm, `
    + `detect ${result.timings.detectMs.toFixed(0)} ms`);
  assert(result.detection.recognised && result.detection.corners.length > 40, `${result.detection.corners.length} corners`);
  assert(result.pose.valid, `pose invalid: ${result.pose.reason}`);
  assert(error.rotationDeg < 0.3 && error.centreMm < 2, `pose error ${JSON.stringify(error)}`);
  assert(result.detection.board === BOARD_NAME, `detection board ${result.detection.board}`);
  assert(result.sheet.name === BOARD_NAME && result.sheet.targetMm.join() === '85,115', `sheet ${JSON.stringify(result.sheet)}`);
  assert(result.timings.totalMs > 0 && result.timings.outlineMs === null, 'timings');
  live.dispose();
});

Deno.test('live vision: each frame carries the scan guide (T-0331), its angle from the rock and its focus', CV_TEST, () => {
  // Setup: a fresh live vision with no outline finder (no WebGL2 here), so the rock is taken to be at
  // the board's target; the full frame given only as the page's copy (no drawable source under
  // Deno, so the focus window is cut from the copy).
  // Test: process the frame twice, 125 ms apart (a still camera).
  // Verifies: the result's guide says the rock is at the board's target (85, 115), from
  // 'target'; its view is the true camera's angle from that point (worked out here from the true
  // camera centre, within 0.5 degree / 2 mm); the second frame has a speed near 0 (still), a focus
  // reading in mm, and no warning condition on this sharp, centred view. In particular no 'glare',
  // although this test sheet's paper is drawn at pure white (255), which the desktop's whole-window
  // glare share counts as clipped: glare is counted only inside the rock's outline, and there is
  // none here (glare null). And the guide's own time is in the timings.
  const live = newLive();
  live.processFrame({ image: FULL, scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: 100 } });
  const result = live.processFrame({ image: FULL, scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: 225 } });
  const { guide } = result;
  console.log(`  guide: view ${JSON.stringify(guide.view)}, speed ${guide.speedMmS?.toFixed(2)} mm/s, blur ${guide.blurMm?.toFixed(3)} mm `
    + `(${guide.blurPx?.toFixed(2)} px), ${result.timings.guideMs.toFixed(1)} ms`);
  const [tx, ty] = result.sheet.targetMm;
  assert(guide.rockFrom === 'target' && guide.rockMm.join() === `${tx},${ty},0`, `rock ${guide.rockMm} vs target ${tx},${ty}`);
  const u = [TRUTH.center[0] - tx, TRUTH.center[1] - ty, TRUTH.center[2]];
  const azimuth = ((Math.atan2(u[1], u[0]) * 180) / Math.PI + 360) % 360;
  const elevation = (Math.atan2(u[2], Math.hypot(u[0], u[1])) * 180) / Math.PI;
  assert(Math.abs(guide.view.azimuthDeg - azimuth) < 0.5 && Math.abs(guide.view.elevationDeg - elevation) < 0.5, `angle vs ${azimuth}, ${elevation}`);
  assert(Math.abs(guide.view.distanceMm - Math.hypot(...u)) < 2, 'distance');
  assert(guide.speedMmS !== null && guide.speedMmS < 1, `still: ${guide.speedMmS}`);
  assert(guide.blurMm !== null && Object.values(guide.conditions).every((on) => !on), JSON.stringify(guide.conditions));
  assert(guide.glare === null, `no outline, no glare count: ${guide.glare}`);
  assert(result.timings.guideMs >= 0, 'guide timing');
  live.dispose();
});

Deno.test('live vision: a half-size copy gives the same pose, in full-frame pixels', CV_TEST, () => {
  // Setup: the same frame reduced to 480 x 360 (block mean), as the page reads a smaller copy.
  // Test: process it with scale 0.5 and the full frame's size.
  // Verifies: corners come back in full-frame pixels (their spread covers the full frame, not a
  // quarter of it), the pose is the full frame's pose (intrinsics for 960 x 720), within 0.6
  // degrees and 4 mm of the truth, and its distance from the target is the true 220 mm to 1%.
  const live = newLive();
  const result = live.processFrame({ image: HALF, scale: 0.5, frame: { width: WIDTH, height: HEIGHT, timeMs: 100 } });
  const error = poseError(result.pose);
  const xs = result.detection.corners.map((c) => c.x);

  console.log(`  half size: ${result.detection.corners.length} corners, error ${error.rotationDeg.toFixed(3)} deg / ${error.centreMm.toFixed(2)} mm`);
  assert(result.pose?.valid, `pose: ${result.pose?.reason}`);
  assert(Math.max(...xs) > 0.6 * WIDTH, 'corners are in full-frame pixels');
  assert(result.pose.intrinsics.width === WIDTH && result.frame.width === WIDTH, 'the full frame');
  assert(error.rotationDeg < 0.6 && error.centreMm < 4, `pose error ${JSON.stringify(error)}`);
  assert(Math.abs(result.pose.distanceMm / 220 - 1) < 0.01, `distance ${result.pose.distanceMm} vs 220`);
  live.dispose();
});

Deno.test('live vision: its message validates, with the board in view named', CV_TEST, () => {
  // Setup: a live vision; one half-size frame of the white/black board.
  // Test: make the frame's message as the phone page does, send it through JSON, and validate it
  // as the studio does.
  // Verifies: the message passes validation with the pose, the intrinsics and the board intact: the
  // board's name, its 'default' origin, its target (85, 115) and size (170 x 230 mm), and no
  // wrongBoard field (an older phone's). The frame is slanted 35
  // degrees, so the lens is already measured from it ('one-view', T-0336: within 3% of the true
  // 816 px), and the message carries that as 'closed-form', the source older studios know.
  const live = newLive();
  const result = live.processFrame({ image: HALF, scale: 0.5, frame: { width: WIDTH, height: HEIGHT, timeMs: 100 } });
  const sent = makeVisionMessage(result);
  const message = validateVisionMessage(JSON.parse(JSON.stringify(sent)));

  assert(result.intrinsics.source === 'one-view' && Math.abs(result.intrinsics.f / 816 - 1) < 0.03, `lens ${JSON.stringify(result.intrinsics)}`);
  assert(message && message.pose.valid && message.intrinsics.source === 'closed-form', 'the message validates');
  assert(message.board.sheet === BOARD_NAME && message.board.sheetFrom === 'default', `board ${JSON.stringify(message.board)}`);
  assert(message.board.targetMm.join() === '85,115' && message.board.sizeMm.join() === '170,230', 'target and size');
  assert(!('wrongBoard' in message.board), 'no wrong-board flag');
  live.dispose();
});

Deno.test('live vision: each of the three boards is read and named, and an older board is not read', CV_TEST, () => {
  // Setup: one live vision; a frame of each board (white/grey, grey/black, white/black: their own
  // colours, spirals and marker ids), from the test's camera; then a frame of the same layout
  // printed with the older boards' markers (DICT_4X4_250 ids 0-194, black and white, no spirals).
  // Test: process the frames in that order, 400 ms apart.
  // Verifies: every board is recognised with a valid pose within 0.3 degrees and 2 mm of the truth,
  // and the detection and the result's sheet name the board in view, so the outline gets the right
  // colours; the older layout gives no marker at all (its codes are in no board's run), so no
  // pose, and the result still names the last board seen.
  const live = newLive();
  let t = 0;

  for (const spec of BOARD_LIST) {
    const image = renderSheet(spec, TRUTH, { noise: 1.5 });
    t += 400;
    const result = live.processFrame({ image, scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: t } });
    const error = poseError(result.pose);
    console.log(`  ${spec.name}: ${result.detection.markers.length} markers, ${result.detection.corners.length} corners, `
      + `error ${error.rotationDeg.toFixed(3)} deg / ${error.centreMm.toFixed(2)} mm`);
    assert(result.pose?.valid && error.rotationDeg < 0.3 && error.centreMm < 2, `${spec.name}: pose ${result.pose?.reason} ${JSON.stringify(error)}`);
    assert(result.detection.board === spec.name && result.sheet.name === spec.name, `${spec.name}: named ${result.detection.board} / ${result.sheet.name}`);
  }

  const older = { ...BOARD_SPEC, dictionary: 'DICT_4X4_250', first_marker_id: 0, colours: undefined, spiral: undefined };
  const result = live.processFrame({ image: renderSheet(older, TRUTH, { noise: 1.5 }), scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: t + 400 } });
  assert(result.detection.markers.length === 0 && result.pose === null, `older board: ${result.detection.markers.length} markers`);
  assert(result.sheet.name === BOARD_LIST.at(-1).name, `sheet ${result.sheet.name}`);
  live.dispose();
});

Deno.test('live vision: the harness\'s residual limit fails every pose but keeps the found corners (T-0335)', CV_TEST, () => {
  // Setup: a live vision made with poseMaxRmsPx 0.001 px (the harness's setting,
  // houseki.scannerTestPoseMaxRmsPx: no real pose has residuals that small), and the full frame.
  // Test: process it once.
  // Verifies: the board is recognised with many corners, each with its id and pixel (what
  // the phone's overlay draws when there is no pose), while the pose is solved but marked invalid
  // for its residual -- the situation the user saw on the real board ("Board seen, but not
  // clearly"), reproducible for the phone page's harness.
  const live = newLive({ poseMaxRmsPx: 0.001 });
  const result = live.processFrame({ image: FULL, scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: 100 } });

  assert(result.detection.recognised && result.detection.corners.length > 40, 'board found');
  assert(result.detection.corners.every((c) => Number.isInteger(c.id) && Number.isFinite(c.x) && Number.isFinite(c.y)), 'ids and pixels');
  assert(result.pose && !result.pose.valid && /residual/.test(result.pose.reason), `pose ${result.pose?.valid} ${result.pose?.reason}`);
  live.dispose();
});

Deno.test('live vision: warmUp runs, and frames leak no OpenCV memory', CV_TEST, async () => {
  // Setup: a live vision.
  // Test: warmUp() (with no WebGL, so no outline), then 20 frames, measuring the wasm heap after
  // the first 5 and after all 20.
  // Verifies: the warm-up completes; and the heap does not grow between frame 5 and 20 (by more
  // than 64 kB of allocator slack): every Mat made per frame is freed.
  const live = newLive();
  await live.warmUp(() => Promise.resolve());
  const frame = { width: WIDTH, height: HEIGHT, timeMs: 0 };
  let before = null;

  for (let k = 0; k < 20; k += 1) {
    live.processFrame({ image: HALF, scale: 0.5, frame: { ...frame, timeMs: 100 * k } });

    if (k === 4) {
      before = wasmHeapInUse(cv);
    }
  }

  const after = wasmHeapInUse(cv);
  console.log(`  heap ${before} -> ${after} bytes`);
  assert(before === null || after - before < 65536, `heap grew by ${after - before} bytes`);
  live.dispose();
});
