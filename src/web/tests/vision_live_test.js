/*
 * vision_live_test.js -- the phone's vision on live frames, end to end on the CPU (T-0326):
 * src/web/src/lib/vision/live.js, with the real opencv.js the phone page loads for the pose
 * (src/web/vendor/opencv/opencv.js, run under Deno as committed) and the phone's board detector,
 * the Rust vision module as built (build/vision/houseki_vision.js; ignored when not built).
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The frames are drawn by tests/vision_render.js: the strip sheet (the one board the phone
 * supports, T-0335), seen through a known camera, so the true pose is known. The camera's focal
 * length is chosen equal to the phone's first guess (0.85 x the long side, intrinsics.js), so the
 * pose can be checked against the truth from the very first frame, before any live calibration.
 * The rock's outline needs WebGL2, so it is not run here (glCanvas null): it is
 * tests/harness/test_scan_vision.py's, in Chrome, with the rest of the page.
 *
 * What is checked: a frame read at full size and the same frame read at half size (the page reads
 * a downscaled copy) both give the true pose, with every pixel coordinate in the FULL frame; the
 * result carries the board, its fit, the intrinsics and per-stage timings; its message validates;
 * ANOTHER board (the scanner's older 22 x 22 reference board) is refused: no pose, no lens views,
 * the wrong-board flag in the result and the message, held over frames too unclear to judge until
 * the right board is seen again; warmUp() runs; and no OpenCV memory is leaked over many frames.
 */

import { loadOpenCv, wasmHeapInUse } from '../src/lib/vision/opencv.js';
import { BOARD_NAME, BOARD_SPEC } from '../src/lib/vision/board_frame.js';
import { createLiveVision, WRONG_BOARD_HOLD_MS } from '../src/lib/vision/live.js';
import { rotationAngleDeg } from '../src/lib/vision/pose.js';
import { makeVisionMessage, validateVisionMessage } from '../src/lib/scan_vision.js';
import { cameraPose, downscale, renderSheet } from './vision_render.js';
import { loadBuiltVision, VISION_BUILT } from './vision_test_support.js';
import { REFERENCE_22X22 } from './vision_test_boards.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

const OPENCV_JS = new URL('../vendor/opencv/opencv.js', import.meta.url);
const cv = await loadOpenCv({ source: await Deno.readTextFile(OPENCV_JS) });
const vision = await loadBuiltVision();
const CV_TEST = { sanitizeOps: false, sanitizeResources: false, ignore: !VISION_BUILT };

// A 960 x 720 frame, focal length 816 px (0.85 x 960: the phone's guess), 220 mm from the strip
// sheet's target (80, 110 mm) at 55 degrees: squares ~37 px, markers ~26 px.
const WIDTH = 960;
const HEIGHT = 720;
const TARGET = [80, 110, 0];
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

Deno.test('live vision: a full-size frame gives the true pose, and the board fits', CV_TEST, () => {
  // Setup: a fresh live vision; the full 960 x 720 frame at scale 1.
  // Test: process it once.
  // Verifies: the board is recognised with many corners, its markers fit the strip board's layout
  // ('fits', all or nearly all of them agreeing, not wrong), the pose is valid and within 0.3
  // degrees and 2 mm of the truth (the intrinsics are the guess, which equals the true camera
  // here), the result names the strip board and its target, and the timings (the fit's included)
  // are filled in.
  const live = newLive();
  const result = live.processFrame({ image: FULL, scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: 100 } });
  const error = poseError(result.pose);

  console.log(`  full size: ${result.detection.corners.length} corners, ${result.board.markers} markers (${result.board.agreeing} fit), `
    + `rms ${result.pose.rmsPx.toFixed(2)} px, error ${error.rotationDeg.toFixed(3)} deg / ${error.centreMm.toFixed(2)} mm, `
    + `detect ${result.timings.detectMs.toFixed(0)} ms, fit ${result.timings.fitMs.toFixed(2)} ms`);
  assert(result.detection.recognised && result.detection.corners.length > 40, `${result.detection.corners.length} corners`);
  assert(result.board.fit === 'fits' && !result.board.wrong && result.board.share > 0.95, `board ${JSON.stringify(result.board)}`);
  assert(result.pose.valid, `pose invalid: ${result.pose.reason}`);
  assert(error.rotationDeg < 0.3 && error.centreMm < 2, `pose error ${JSON.stringify(error)}`);
  assert(result.sheet.name === BOARD_NAME && result.sheet.targetMm.join() === '80,110', `sheet ${JSON.stringify(result.sheet)}`);
  assert(result.timings.totalMs > 0 && result.timings.fitMs >= 0 && result.timings.outlineMs === null, 'timings');
  live.dispose();
});

Deno.test('live vision: each frame carries the scan guide (T-0331), its angle from the rock and its focus', CV_TEST, () => {
  // Setup: a fresh live vision with no outline finder (no WebGL2 here), so the rock is taken to be at
  // the board's target; the full frame given only as the page's copy (no drawable source under
  // Deno, so the focus window is cut from the copy).
  // Test: process the frame twice, 125 ms apart (a still camera).
  // Verifies: the result's guide says the rock is at the strip board's target (80, 110), from
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

Deno.test('live vision: its message validates, with the strip board named and no wrong-board flag', CV_TEST, () => {
  // Setup: a live vision; one half-size frame of the strip board.
  // Test: make the frame's message as the phone page does (result.board.wrong as wrongBoard), send
  // it through JSON, and validate it as the studio does.
  // Verifies: the message passes validation with the pose, the intrinsics and the board intact: the
  // strip board's name, its 'default' origin (nothing is recognised or chosen since T-0335), its
  // target (80, 110) and size (170 x 230 mm), and no wrongBoard field. The frame is slanted 35
  // degrees, so the lens is already measured from it ('one-view', T-0336: within 3% of the true
  // 816 px), and the message carries that as 'closed-form', the source older studios know.
  const live = newLive();
  const result = live.processFrame({ image: HALF, scale: 0.5, frame: { width: WIDTH, height: HEIGHT, timeMs: 100 } });
  const sent = makeVisionMessage({ ...result, wrongBoard: result.board.wrong });
  const message = validateVisionMessage(JSON.parse(JSON.stringify(sent)));

  assert(result.intrinsics.source === 'one-view' && Math.abs(result.intrinsics.f / 816 - 1) < 0.03, `lens ${JSON.stringify(result.intrinsics)}`);
  assert(message && message.pose.valid && message.intrinsics.source === 'closed-form', 'the message validates');
  assert(message.board.sheet === BOARD_NAME && message.board.sheetFrom === 'default', `board ${JSON.stringify(message.board)}`);
  assert(message.board.targetMm.join() === '80,110' && message.board.sizeMm.join() === '170,230', 'target and size');
  assert(!('wrongBoard' in message.board), 'no wrong-board flag');
  live.dispose();
});

Deno.test('live vision: another ChArUco board is refused, held over unclear frames, and the right one clears it', CV_TEST, () => {
  // Setup: frames of the scanner's OLDER reference board (22 x 22 squares, 0.689 markers, the same
  // DICT_4X4_250 markers; vision_test_boards.js), whose markers the detector reads correctly but
  // which sit in other squares than on the strip board; a strip frame with all but a 180 x 140 px
  // patch painted grey (a handful of markers: too few to judge, verdict 'unsure'); and the full strip
  // frame. A fresh live vision, intrinsics refinement never scheduled.
  // Test: (1) process 12 reference-board frames 400 ms apart (more than the lens seed needs, and
  // spaced past its gap), from three directions; (2) at once after them, the patch frame; (3) the
  // full strip frame; (4) the patch frame again; (5) in a fresh run, one reference-board frame and,
  // once the hold has run out with nothing in view, the patch frame.
  // Verifies: (1) every reference frame finds markers and corners, but is judged 'wrong' (fewer
  // than 60% of its markers fit the strip layout), with no pose, and the lens estimate never moves
  // off its guess (source 'guess', no calibration views): the frames that dragged the phone's
  // focal length to a fraction of the truth are no longer fed to it; the message made from such a
  // frame carries wrongBoard: true through validation, and no pose; (2) the patch frame within the
  // hold is taken for the same wrong board (unsure, wrong); (3) the strip frame fits, clears the
  // hold and has a valid pose; (4) the patch frame is then not wrong; (5) nor once the hold is over.
  const live = newLive();
  const views = [[30, 50, 260], [150, 65, 300], [260, 40, 240]];
  let t = 0;

  for (let k = 0; k < 12; k += 1) {
    const [azimuthDeg, elevationDeg, distanceMm] = views[k % 3];
    const pose = cameraPose([110, 110, 0], { azimuthDeg, elevationDeg, distanceMm, rollDeg: 5, width: WIDTH, height: HEIGHT, f: 0.85 * WIDTH });
    const image = renderSheet(REFERENCE_22X22, pose, { noise: 1.5, seed: k + 1 });
    t += 400;
    const result = live.processFrame({ image, scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: t } });

    if (k < 3) {
      console.log(`  reference board, view ${k}: ${result.board.markers} markers, ${result.board.agreeing} fit (share ${result.board.share?.toFixed(2)}), `
        + `${result.detection.corners.length} corners, verdict ${result.board.fit}`);
    }

    assert(result.board.markers >= 20 && result.detection.corners.length >= 8, `frame ${k}: board seen ${JSON.stringify(result.board)}`);
    assert(result.board.fit === 'wrong' && result.board.wrong && result.board.share < 0.6, `frame ${k}: ${JSON.stringify(result.board)}`);
    assert(result.pose === null, `frame ${k}: a pose from another board`);
    assert(result.intrinsics.source === 'guess' && (result.calibration.views ?? 0) === 0, `frame ${k}: lens ${JSON.stringify(result.intrinsics)}`);

    if (k === 0) {
      const message = validateVisionMessage(JSON.parse(JSON.stringify(makeVisionMessage({ ...result, wrongBoard: result.board.wrong }))));
      assert(message?.board.wrongBoard === true && message.pose === null, `message ${JSON.stringify(message?.board)}`);
    }
  }

  // A patch of the strip board: grey everywhere outside a 180 x 140 px window round its middle.
  const patch = { data: new Uint8ClampedArray(FULL.data), width: WIDTH, height: HEIGHT };

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (Math.abs(x - WIDTH / 2) > 90 || Math.abs(y - HEIGHT / 2) > 70) {
        patch.data.fill(128, 4 * (y * WIDTH + x), 4 * (y * WIDTH + x) + 3);
      }
    }
  }

  const held = live.processFrame({ image: patch, scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: t + 100 } });
  console.log(`  patch during the hold: ${JSON.stringify(held.board)}`);
  assert(held.board.fit === 'unsure' && held.board.markers > 0 && held.board.wrong && held.pose === null, `held ${JSON.stringify(held.board)}`);

  const right = live.processFrame({ image: FULL, scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: t + 200 } });
  assert(right.board.fit === 'fits' && !right.board.wrong && right.pose?.valid, `strip ${JSON.stringify(right.board)} ${right.pose?.reason}`);

  const after = live.processFrame({ image: patch, scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: t + 300 } });
  assert(!after.board.wrong, `patch after the strip: ${JSON.stringify(after.board)}`);
  live.dispose();

  // (5) a fresh run: the wrong board, then the patch only once the hold is over.
  const other = newLive();
  const pose = cameraPose([110, 110, 0], { azimuthDeg: 30, elevationDeg: 50, distanceMm: 260, width: WIDTH, height: HEIGHT, f: 0.85 * WIDTH });
  const first = other.processFrame({ image: renderSheet(REFERENCE_22X22, pose, { noise: 1.5 }), scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: 0 } });
  assert(first.board.wrong, 'the reference board is wrong in a fresh run too');
  const later = other.processFrame({ image: patch, scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: WRONG_BOARD_HOLD_MS + 1 } });
  assert(later.board.fit === 'unsure' && !later.board.wrong, `patch after the hold: ${JSON.stringify(later.board)}`);
  other.dispose();
});

Deno.test('live vision: the harness\'s residual limit fails every pose but keeps the found corners (T-0335)', CV_TEST, () => {
  // Setup: a live vision made with poseMaxRmsPx 0.001 px (the harness's setting,
  // houseki.scannerTestPoseMaxRmsPx: no real pose has residuals that small), and the full strip frame.
  // Test: process it once.
  // Verifies: the board fits and is recognised with many corners, each with its id and pixel (what
  // the phone's overlay draws when there is no pose), while the pose is solved but marked invalid
  // for its residual -- the situation the user saw on the real board ("Board seen, but not
  // clearly"), reproducible for the phone page's harness.
  const live = newLive({ poseMaxRmsPx: 0.001 });
  const result = live.processFrame({ image: FULL, scale: 1, frame: { width: WIDTH, height: HEIGHT, timeMs: 100 } });

  assert(result.board.fit === 'fits' && result.detection.recognised && result.detection.corners.length > 40, 'board found');
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
