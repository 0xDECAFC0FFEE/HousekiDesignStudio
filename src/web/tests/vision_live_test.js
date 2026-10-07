/*
 * vision_live_test.js -- the phone's vision on live frames, end to end on the CPU (T-0326):
 * src/web/src/lib/vision/live.js, with the real opencv.js the phone page loads for the pose
 * (src/web/vendor/opencv/opencv.js, run under Deno as committed) and the phone's board detector,
 * the Rust vision module as built (build/vision/houseki_vision.js; ignored when not built).
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The frames are drawn by tests/vision_render.js: the large target with dots, seen through a known
 * camera, so the true pose is known. The camera's focal length is chosen equal to the phone's
 * first guess (0.85 x the long side, intrinsics.js), so the pose can be checked against the truth
 * from the very first frame, before any live calibration. The rock's outline needs WebGL2, so it
 * is not run here (glCanvas null): it is tests/harness/test_scan_vision.py's, in Chrome, with the
 * rest of the page.
 *
 * What is checked: a frame read at full size and the same frame read at half size (the page reads
 * a downscaled copy) both give the true pose, with every pixel coordinate in the FULL frame; the
 * result carries the sheet, the intrinsics and per-stage timings; its message validates; the
 * person's choice of sheet changes the target the pose is measured from; warmUp() runs; and no
 * OpenCV memory is leaked over many frames.
 */

import { loadOpenCv, wasmHeapInUse } from '../src/lib/vision/opencv.js';
import { BOARD_SPECS } from '../src/lib/vision/board_frame.js';
import { DEFAULT_SHEET } from '../src/lib/vision/board_pick.js';
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

// A 960 x 720 frame, focal length 816 px (0.85 x 960: the phone's guess), 220 mm from the target at
// 55 degrees: squares ~37 px, markers ~26 px.
const WIDTH = 960;
const HEIGHT = 720;
const SHEET = 'charuco_23x17_10mm_centre3x3_dots';
const TRUTH = cameraPose([85, 115, 0], {
  azimuthDeg: 200, elevationDeg: 55, distanceMm: 220, rollDeg: 10, width: WIDTH, height: HEIGHT, f: 0.85 * WIDTH,
});
const FULL = renderSheet(BOARD_SPECS[SHEET], TRUTH, { noise: 1.5 });
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

Deno.test('live vision: a full-size frame gives the true pose', CV_TEST, () => {
  // Setup: a fresh live vision; the full 960 x 720 frame at scale 1.
  // Test: process it once.
  // Verifies: the board is recognised with many corners, the pose is valid and within 0.3 degrees
  // and 2 mm of the truth (the intrinsics are the guess, which equals the true camera here), the
  // sheet is the default one, the strip (no evidence yet: the rendered sheet's dots and blank
  // target need several frames to show), and the timings are filled in.
  const live = newLive();
  const result = live.processFrame({ image: FULL, scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: 100 } });
  const error = poseError(result.pose);

  console.log(`  full size: ${result.detection.corners.length} corners, rms ${result.pose.rmsPx.toFixed(2)} px, `
    + `error ${error.rotationDeg.toFixed(3)} deg / ${error.centreMm.toFixed(2)} mm, detect ${result.timings.detectMs.toFixed(0)} ms`);
  assert(result.detection.recognised && result.detection.corners.length > 40, `${result.detection.corners.length} corners`);
  assert(result.pose.valid, `pose invalid: ${result.pose.reason}`);
  assert(error.rotationDeg < 0.3 && error.centreMm < 2, `pose error ${JSON.stringify(error)}`);
  assert(result.sheet.name === DEFAULT_SHEET && result.sheet.from === 'default', `sheet ${JSON.stringify(result.sheet)}`);
  assert(result.timings.totalMs > 0 && result.timings.outlineMs === null, 'timings');
  live.dispose();
});

Deno.test('live vision: each frame carries the scan guide (T-0331), its angle from the rock and its focus', CV_TEST, () => {
  // Setup: a fresh live vision with no outline finder (no WebGL2 here), so the rock is taken to be at
  // the sheet's target; the full frame given only as the page's copy (no drawable source under
  // Deno, so the focus window is cut from the copy).
  // Test: process the frame twice, 125 ms apart (a still camera).
  // Verifies: the result's guide says the rock is at the CURRENT sheet's target (from 'target': the
  // phone has not recognised this frame's sheet yet, so it is the default sheet's target, the strip
  // sheet's (80, 110) since T-0330 made it the default); its view is the true camera's angle from
  // that point (worked out here from the true camera centre, within 0.5 degree / 2 mm); the second
  // frame has a speed near 0 (still), a focus reading in mm, and no
  // warning condition on this sharp, centred view. In particular no 'glare', although this test
  // sheet's paper is drawn at pure white (255), which the desktop's whole-window glare share counts as
  // clipped: glare is counted only inside the rock's outline, and there is none here (glare null).
  // And the guide's own time is in the timings.
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
  // degrees and 4 mm of the truth, and it agrees with the full-size result's distance to 1%.
  const live = newLive();
  const result = live.processFrame({ image: HALF, scale: 0.5, frame: { width: WIDTH, height: HEIGHT, timeMs: 100 } });
  const error = poseError(result.pose);
  const xs = result.detection.corners.map((c) => c.x);

  console.log(`  half size: ${result.detection.corners.length} corners, error ${error.rotationDeg.toFixed(3)} deg / ${error.centreMm.toFixed(2)} mm`);
  assert(result.pose?.valid, `pose: ${result.pose?.reason}`);
  assert(Math.max(...xs) > 0.6 * WIDTH, 'corners are in full-frame pixels');
  assert(result.pose.intrinsics.width === WIDTH && result.frame.width === WIDTH, 'the full frame');
  assert(error.rotationDeg < 0.6 && error.centreMm < 4, `pose error ${JSON.stringify(error)}`);
  // The distance is measured from the current sheet's target: the default strip's (80, 110 mm),
  // 216.4 mm from the camera, which is 220 mm from the rendered sheet's (85, 115 mm).
  const target = BOARD_SPECS[DEFAULT_SHEET].target.centre_mm;
  const trueDistance = Math.hypot(TRUTH.center[0] - target[0], TRUTH.center[1] - target[1], TRUTH.center[2]);
  assert(Math.abs(result.pose.distanceMm / trueDistance - 1) < 0.01, `distance ${result.pose.distanceMm} vs ${trueDistance}`);
  live.dispose();
});

Deno.test('live vision: its message validates, and a chosen sheet moves the target', CV_TEST, () => {
  // Setup: a live vision; one frame.
  // Test: make the frame's message and validate it as the studio does; then choose the dotted
  // sheet (whose target is the 85, 115 mm middle, not the strip sheet's corner at 80, 110 mm) and
  // process the frame again.
  // Verifies: the message passes validation with the pose, the intrinsics and the sheet (the
  // default strip) intact; the choice is reported as 'chosen'; and the distance is now measured
  // from the dotted sheet's target (~7 mm from the strip's, so the distance changes).
  const live = newLive();
  const frame = { width: WIDTH, height: HEIGHT, timeMs: 100 };
  const first = live.processFrame({ image: HALF, scale: 0.5, frame });
  const message = validateVisionMessage(JSON.parse(JSON.stringify(makeVisionMessage(first))));

  assert(message && message.pose.valid && message.intrinsics.source === 'guess', 'the message validates');
  assert(message.board.sheet === DEFAULT_SHEET && message.board.targetMm.join() === '80,110', 'the sheet and its target');

  const chosen = live.chooseSheet(SHEET);
  assert(chosen.from === 'chosen' && chosen.targetMm.join() === '85,115', `chosen ${JSON.stringify(chosen)}`);
  const second = live.processFrame({ image: HALF, scale: 0.5, frame: { ...frame, timeMs: 200 } });
  assert(second.sheet.from === 'chosen', 'still chosen');
  assert(Math.abs(second.pose.distanceMm - first.pose.distanceMm) > 2, 'distance measured from the other target');
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
