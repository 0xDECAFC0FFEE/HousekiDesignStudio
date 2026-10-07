/*
 * vision_board_detect_opencv_test.js -- the opencv.js ChArUco board detector (T-0323):
 * src/web/src/lib/vision/board_detect_opencv.js, with the opencv.js the phone page loaded until
 * T-0330 (src/web/vendor/opencv/opencv.js, run here under Deno exactly as committed). Since T-0330
 * the phone detects with the Rust vision module (board_detect.js, tested by
 * vision_board_detect_test.js against this one); this detector stays as that reference, so its
 * tests stay too. The tuned constants are board_detect.js's, shared by both.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * WHAT THE FRAMES ARE. Synthetic camera frames from tests/vision_synth.js: the board rendered by
 * OpenCV's own CharucoBoard.generateImage (with the spec's removed markers blanked and its centre
 * target drawn), warped by a known homography into a 1280 x 720 frame (the phone's 720p), with
 * optional blur and noise. The homography also gives every corner's TRUE position, so each test
 * measures sub-pixel error, not just "found something". Real phone frames, compared against the
 * desktop scanner pipeline's own detections, are tests/harness/test_vision_detect.py's (a browser
 * is needed to decode their JPEGs), as are the timings in Chrome.
 *
 * WHAT THE NUMBERS MEAN. "2-marker" corners are the ones OpenCV returns by default (both
 * neighbouring markers seen); "1-marker" corners come from the desktop pipeline's second pass and
 * are known to be less reliable (its KB: median 1.05-1.5 px against 0.5-0.7 px on real video), so
 * accuracy bounds are set on 2-marker corners and only sanity bounds on the rest.
 *
 * The first block needs no OpenCV: it pins the tuned constants to the desktop pipeline's values.
 */

import { loadOpenCv, wasmHeapInUse } from '../src/lib/vision/opencv.js';
import { createBoardDetector } from '../src/lib/vision/board_detect_opencv.js';
import {
  detectorParamValues,
  markerScale,
  MIN_CORNER_SHARPNESS,
  pixelScale,
  refineParamValues,
  spansPlane,
} from '../src/lib/vision/board_detect.js';
import { BOARD_SPECS, cornerPoint } from '../src/lib/vision/board_frame.js';
import { boardImage, cornerErrors, makeFrame, visibleIds } from './vision_synth.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

function assertEquals(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${message || 'not equal'}: got ${a}, expected ${e}`);
}

const OPENCV_JS = new URL('../vendor/opencv/opencv.js', import.meta.url);

// One perspective view of the whole board in a 720p frame (markers ~25-30 px), and one close-up
// (markers ~50-65 px, the board running off every edge), both tilted as a hand-held phone is.
const OVERVIEW = [[230, 110], [1060, 80], [1180, 650], [150, 610]];
const CLOSE_UP = [[-420, -330], [1580, -380], [1760, 1120], [-560, 1060]];
const WIDTH = 1280;
const HEIGHT = 720;

/** Splits a detection's corners by how many neighbouring markers each had. */
function byMarkers(detection, truth) {
  const errors = cornerErrors(detection, truth).errors;
  const two = [];
  const one = [];
  detection.corners.forEach((corner, k) => (corner.markers === 2 ? two : one).push(errors[k]));
  const stats = (list) => {
    const sorted = [...list].sort((a, b) => a - b);
    return { n: sorted.length, median: sorted[sorted.length >> 1] ?? NaN, max: sorted.at(-1) ?? NaN };
  };
  return { two: stats(two), one: stats(one) };
}

// --------------------------------------------------------------------------------------------------
// The tuned constants (no OpenCV)
// --------------------------------------------------------------------------------------------------

Deno.test('the marker-size factor is 1 inside the tuned 60-300 px band and continuous outside it', () => {
  // Setup: none; markerScale is board.py's marker_scale.
  // Test: marker widths inside, at the edges of, and outside the band, and nonsense widths.
  // Verifies: the tuned parameters are used unchanged for 60-300 px markers; outside, the factor is
  // the width over the NEARER edge (30 px -> 0.5, 600 px -> 2), so it meets 1 at both edges; a
  // missing or non-finite width falls back to 1 rather than producing NaN parameters.
  assertEquals([markerScale(60), markerScale(145), markerScale(300)], [1, 1, 1], 'inside the band');
  assertEquals([markerScale(30), markerScale(600)], [0.5, 2], 'outside the band');
  assertEquals([markerScale(0), markerScale(NaN), markerScale(undefined)], [1, 1, 1], 'no width');
});

Deno.test('the detector parameters are board.py\'s: windows 3-93 step 15, 8 px per cell, 30% margin', () => {
  // Setup: none. Test: the parameter values at m = 1 (the tuned band), 0.5 and 2.
  // Verifies: at m = 1 they are exactly the reference's tuned values, with OpenCV's default
  // minimum perimeter left alone; small markers shrink the windows (never below 23 / 4) and the
  // minimum perimeter (0.03 m); large markers widen the windows; and the refinement distance is
  // 40 px x m, with error-correction rate 3 and all orders checked (RefineParameters(40, 3, true)).
  assertEquals(detectorParamValues(1), {
    adaptiveThreshWinSizeMin: 3,
    adaptiveThreshWinSizeMax: 93,
    adaptiveThreshWinSizeStep: 15,
    perspectiveRemovePixelPerCell: 8,
    perspectiveRemoveIgnoredMarginPerCell: 0.3,
  }, 'm = 1');
  const half = detectorParamValues(0.5);
  assertEquals([half.adaptiveThreshWinSizeMax, half.adaptiveThreshWinSizeStep, half.minMarkerPerimeterRate], [46, 8, 0.015], 'm = 0.5');
  const tiny = detectorParamValues(0.1);
  assertEquals([tiny.adaptiveThreshWinSizeMax, tiny.adaptiveThreshWinSizeStep], [23, 4], 'm = 0.1 floors');
  const big = detectorParamValues(2);
  assertEquals([big.adaptiveThreshWinSizeMax, big.adaptiveThreshWinSizeStep, big.minMarkerPerimeterRate], [186, 30, undefined], 'm = 2');
  assertEquals(refineParamValues(1), { minRepDistance: 40, errorCorrectionRate: 3, checkAllOrders: true }, 'refine m = 1');
  assertEquals(refineParamValues(0.5).minRepDistance, 20, 'refine m = 0.5');
});

Deno.test('the pixel scale is the short side over 1080, and collinear corners do not span a plane', () => {
  // Setup: none. Test: pixelScale on common frame sizes; spansPlane on a line of corners, an
  // L of corners, a 2 x 4 block, and on too few points.
  // Verifies: camera.py's s (1 at 1080p in either orientation, 2/3 at 720p); and calibrate.py's
  // _spans_plane rule behind `recognised`: points on one line (any number) never count, a block two
  // squares deep does, and fewer than 4 points never do.
  assertEquals([pixelScale(1920, 1080), pixelScale(1080, 1920), pixelScale(1280, 720)], [1, 1, 720 / 1080]);
  const line = Array.from({ length: 20 }, (_, k) => [k, 3]);
  assert(!spansPlane(line), 'a row of corners spans a plane');
  const diagonal = Array.from({ length: 20 }, (_, k) => [k, k]);
  assert(!spansPlane(diagonal), 'a diagonal of corners spans a plane');
  const block = [];
  for (let x = 0; x < 4; x += 1) {
    block.push([x, 0], [x, 2]);
  }
  assert(spansPlane(block), 'a 4 x 2 block does not span a plane');
  assert(!spansPlane([[0, 0], [5, 0], [0, 5]]), 'three points span a plane');
});

// --------------------------------------------------------------------------------------------------
// Detection on synthetic frames (OpenCV)
// --------------------------------------------------------------------------------------------------

const cv = await loadOpenCv({ source: await Deno.readTextFile(OPENCV_JS) });

Deno.test('every shipped board is found in a perspective view, to a tenth of a pixel, without its invalid corners', () => {
  // Setup: for each of the four printable boards, one sharp perspective frame of the whole board
  // (markers about 25-30 px) with mild sensor noise (sigma 2 grey levels).
  // Test: detect once.
  // Verifies: (1) at least 95% of the board's valid corners that lie well inside the frame are
  // found; (2) the default (2-marker) corners are within 0.15 px median and 0.5 px worst of the
  // truth, and the 1-marker ones within 1 px worst -- sub-pixel accuracy in types.js's convention,
  // which also pins the + 0.5 px between OpenCV's pixel centres and that convention; (3) no
  // returned id is one board_frame refuses (the centre target's corners), and no returned marker
  // is one the spec removed; (4) the frame is `recognised`; (5) the frame info defaults to the
  // frame's own size.
  for (const [name, spec] of Object.entries(BOARD_SPECS)) {
    const printed = boardImage(cv, spec, { pps: 48 });
    const { frame, truth } = makeFrame(cv, spec, printed, { width: WIDTH, height: HEIGHT, quad: OVERVIEW, noise: 2, seed: 3 });
    const detector = createBoardDetector(cv, spec);
    const detection = detector.detect(frame);
    const expected = visibleIds(spec, truth, WIDTH, HEIGHT, 40).filter((id) => cornerPoint(spec, id));
    const found = new Set(detection.corners.map((c) => c.id));
    const missing = expected.filter((id) => !found.has(id));
    const { two, one } = byMarkers(detection, truth);

    assert(missing.length <= 0.05 * expected.length, `${name}: missed ${missing.length} of ${expected.length}: ${missing}`);
    assert(two.n > 250 && two.median < 0.15 && two.max < 0.5, `${name}: 2-marker corners ${JSON.stringify(two)}`);
    assert(!(one.max > 1), `${name}: 1-marker corners ${JSON.stringify(one)}`);
    assert(detection.corners.every((c) => cornerPoint(spec, c.id)), `${name}: an invalid corner was returned`);
    assert(detection.markers.every((m) => !(spec.removed_marker_ids ?? []).includes(m.id)), `${name}: a removed marker was returned`);
    assert(detection.recognised, `${name}: not recognised`);
    assertEquals([detection.frame.width, detection.frame.height], [WIDTH, HEIGHT], `${name}: frame size`);

    detector.dispose();
    frame.delete();
    printed.image.delete();
  }
});

Deno.test('a blurred close-up keeps its corners, and blurred corners are re-refined without a half-pixel bias', () => {
  // Setup: the 3 x 3-target board seen close (markers ~50-65 px, the board running off every edge)
  // and defocused (Gaussian sigma 2.5 px) with noise, as the phone's 2x zoom does to the board.
  // Test: detect three frames with the default detector (the first frame tunes the marker-size
  // factor for the next), and once with desktopHalfPixelShift (detect.py refine_blurred's
  // -0.5 / +0.5 around cornerSubPix, reproduced exactly).
  // Verifies: (1) the frame is recognised with dozens of 2-marker corners within 0.35 px median;
  // (2) some corners are blurred (sharpness < MIN_CORNER_SHARPNESS), so the re-refinement really
  // ran; (3) with the desktop's shift, every re-refined corner moves by about (+0.5, +0.5) px and
  // their error grows -- the measurement behind leaving the shift out (see the KB article
  // opencv-js-for-the-phone-scanner-build-charuco-po).
  const spec = BOARD_SPECS.charuco_23x17_10mm_centre3x3;
  const printed = boardImage(cv, spec, { pps: 48 });
  const { frame, truth } = makeFrame(cv, spec, printed, { width: WIDTH, height: HEIGHT, quad: CLOSE_UP, blur: 2.5, noise: 2, seed: 5 });
  const detector = createBoardDetector(cv, spec);
  let detection;

  for (let k = 0; k < 3; k += 1) {
    detection = detector.detect(frame);
  }

  const { two } = byMarkers(detection, truth);
  assert(detection.recognised && two.n >= 30 && two.median < 0.35, `blurred close-up: ${JSON.stringify(two)}`);
  const blurred = detection.corners.filter((c) => c.sharpness < MIN_CORNER_SHARPNESS);
  assert(blurred.length >= 5, `only ${blurred.length} blurred corners: the blur is too light to test re-refinement`);

  const shifted = createBoardDetector(cv, spec, { markerScale: detection.markerScale, desktopHalfPixelShift: true });
  const fixed = createBoardDetector(cv, spec, { markerScale: detection.markerScale });
  const a = fixed.detect(frame);
  const b = shifted.detect(frame);
  const at = new Map(a.corners.map((c) => [c.id, c]));
  const moves = b.corners.filter((c) => c.sharpness < MIN_CORNER_SHARPNESS && at.has(c.id)).map((c) => [c.x - at.get(c.id).x, c.y - at.get(c.id).y]);
  const meanDx = moves.reduce((s, [dx]) => s + dx, 0) / moves.length;
  const meanDy = moves.reduce((s, [, dy]) => s + dy, 0) / moves.length;
  assert(moves.length >= 5 && Math.abs(meanDx - 0.5) < 0.15 && Math.abs(meanDy - 0.5) < 0.15, `shift moved re-refined corners by (${meanDx}, ${meanDy}) over ${moves.length}`);
  const errorOf = (d, ids) => {
    const list = d.corners.filter((c) => ids.has(c.id)).map(({ id, x, y }) => Math.hypot(x - truth(id)[0], y - truth(id)[1])).sort((p, q) => p - q);
    return list[list.length >> 1];
  };
  const blurredIds = new Set(b.corners.filter((c) => c.sharpness < MIN_CORNER_SHARPNESS).map((c) => c.id));
  assert(errorOf(b, blurredIds) > errorOf(a, blurredIds) + 0.3, `shifted ${errorOf(b, blurredIds)} vs unshifted ${errorOf(a, blurredIds)}`);

  for (const object of [detector, shifted, fixed]) {
    object.dispose();
  }
  frame.delete();
  printed.image.delete();
});

Deno.test('a partial view returns only corners inside the frame, and too few corners are not recognised', () => {
  // Setup: the strip board (no target) (a) seen so close that only part of it is in the frame
  // (CLOSE_UP), sharp; (b) seen very small in one corner of the frame, a few squares of it
  // cropped away by the frame edge, so only a handful of corners are visible; (c) a frame of
  // plain table.
  // Test: detect each with its own detector.
  // Verifies: (a) every returned corner lies inside the frame and is accurate (2-marker median
  // < 0.15 px), and the view is recognised; (b) fewer than 8 corners means not recognised, even
  // though corners were found; (c) nothing found, not recognised, empty lists, and no exception.
  const spec = BOARD_SPECS.charuco_23x17_10mm_strip;
  const printed = boardImage(cv, spec, { pps: 48 });

  const close = makeFrame(cv, spec, printed, { width: WIDTH, height: HEIGHT, quad: CLOSE_UP, noise: 2 });
  const detector = createBoardDetector(cv, spec, { markerScale: 1 });
  const a = detector.detect(close.frame);
  assert(a.corners.every((c) => c.x >= 0 && c.y >= 0 && c.x <= WIDTH && c.y <= HEIGHT), 'a corner outside the frame');
  assert(a.recognised && byMarkers(a, close.truth).two.median < 0.15, `close-up: ${JSON.stringify(byMarkers(a, close.truth))}`);

  // The board's top-left corner region only: the board is 23 x 17 squares of ~60 px, placed so
  // just its first two rows and four columns (or so) are inside the frame.
  const corner = makeFrame(cv, spec, printed, { width: WIDTH, height: HEIGHT, quad: [[1030, 590], [2410, 590], [2410, 1610], [1030, 1610]], noise: 2 });
  const b = detector.detect(corner.frame);
  assert(b.corners.length > 0 && b.corners.length < 8, `expected a few corners, got ${b.corners.length}`);
  assert(!b.recognised, 'a handful of corners was recognised');

  const table = new cv.Mat(HEIGHT, WIDTH, cv.CV_8UC1, new cv.Scalar(70));
  const c = detector.detect(table, { width: WIDTH, height: HEIGHT, timeMs: 1234 });
  assertEquals([c.corners, c.markers, c.recognised, c.frame.timeMs], [[], [], false, 1234], 'empty frame');

  detector.dispose();
  for (const mat of [close.frame, corner.frame, table, printed.image]) {
    mat.delete();
  }
});

Deno.test('a processing scale of 0.5 reports full-resolution coordinates, and ImageData input matches Mat input', () => {
  // Setup: the centre1 board in the overview frame, plus the same frame as an RGBA ImageData-like
  // object (what a canvas getImageData gives the phone page).
  // Test: detect at processing scale 0.5 (on a 640 x 360 copy) and at 1 from the ImageData.
  // Verifies: at scale 0.5 the corners still come back in the FULL frame's pixels, accurate to
  // 0.35 px median on 2-marker corners (twice the pixel size costs some accuracy, but no
  // half-pixel or scale slip, which would show as >= 0.5 px everywhere); the RGBA path gives the
  // same corners as the grey Mat path to within 0.01 px.
  const spec = BOARD_SPECS.charuco_23x17_10mm_centre1;
  const printed = boardImage(cv, spec, { pps: 48 });
  const close = makeFrame(cv, spec, printed, { width: WIDTH, height: HEIGHT, quad: CLOSE_UP, noise: 2 });

  const halfScale = createBoardDetector(cv, spec, { processingScale: 0.5 });
  halfScale.detect(close.frame);
  const half = halfScale.detect(close.frame);
  const stats = byMarkers(half, close.truth);
  assert(half.recognised && stats.two.n > 50 && stats.two.median < 0.35, `scale 0.5: ${JSON.stringify(stats)}`);
  assertEquals([half.frame.width, half.frame.height], [WIDTH, HEIGHT], 'scale 0.5 frame size');

  const rgba = new cv.Mat();
  cv.cvtColor(close.frame, rgba, cv.COLOR_GRAY2RGBA);
  const imageData = { data: new Uint8ClampedArray(rgba.data), width: WIDTH, height: HEIGHT };
  const fromMat = createBoardDetector(cv, spec, { markerScale: 1 });
  const fromImage = createBoardDetector(cv, spec, { markerScale: 1 });
  const p = fromMat.detect(close.frame);
  const q = fromImage.detect(imageData);
  assertEquals(q.corners.map((c) => c.id), p.corners.map((c) => c.id), 'ImageData ids');
  assert(q.corners.every((c, k) => Math.hypot(c.x - p.corners[k].x, c.y - p.corners[k].y) < 0.01), 'ImageData positions');

  for (const object of [halfScale, fromMat, fromImage]) {
    object.dispose();
  }
  for (const mat of [rgba, close.frame, printed.image]) {
    mat.delete();
  }
});

Deno.test('detecting frame after frame leaks no memory, and dispose frees the detector', () => {
  // Setup: the wasm heap's bytes in use (dlmalloc mallinfo, via wasmHeapInUse) before a detector
  // exists; a detector; two frames, one with the board and one without (both code paths), and an
  // RGBA ImageData of the first (the staging path).
  // Test: detect each kind twice to reach a steady state, read the heap, then detect 8 more rounds
  // and read it again; then dispose the detector and read it a third time.
  // Verifies: the heap in use is EXACTLY the same after the extra rounds (any Mat not deleted per
  // frame -- a MatVector, an output Mat, an roi view -- would add at least its header); and
  // after dispose() it is back within a few KB of where it started (OpenCV keeps some
  // process-wide caches, so not to the byte).
  const spec = BOARD_SPECS.charuco_23x17_10mm_centre3x3_dots;
  const printed = boardImage(cv, spec, { pps: 32 });
  const view = makeFrame(cv, spec, printed, { width: 960, height: 540, quad: [[170, 80], [800, 60], [880, 490], [110, 460]], blur: 1.5, noise: 2 });
  const empty = new cv.Mat(540, 960, cv.CV_8UC1, new cv.Scalar(70));
  const rgba = new cv.Mat();
  cv.cvtColor(view.frame, rgba, cv.COLOR_GRAY2RGBA);
  const imageData = { data: new Uint8ClampedArray(rgba.data), width: 960, height: 540 };

  const before = wasmHeapInUse(cv);
  const detector = createBoardDetector(cv, spec);
  const round = () => {
    detector.detect(view.frame);
    detector.detect(empty);
    detector.detect(imageData);
  };
  round();
  round();
  const steady = wasmHeapInUse(cv);

  for (let k = 0; k < 8; k += 1) {
    round();
  }

  const after = wasmHeapInUse(cv);
  detector.dispose();
  const disposed = wasmHeapInUse(cv);

  assert(before !== null, 'this opencv.js has no _mallinfo');
  assertEquals(after, steady, `heap in use grew over 24 frames (${steady} -> ${after} bytes)`);
  assert(Math.abs(disposed - before) < 16384, `dispose left ${disposed - before} bytes (before ${before}, after ${disposed})`);

  for (const mat of [view.frame, empty, rgba, printed.image]) {
    mat.delete();
  }
});
