/*
 * vision_board_detect_test.js -- the phone's ChArUco board detector since T-0330:
 * src/web/src/lib/vision/board_detect.js over the Rust vision module (src/vision, as built:
 * build/vision/houseki_vision.js; the tests are ignored when it has not been built), checked
 * against the synthetic truth AND against the opencv.js detector it replaced
 * (board_detect_opencv.js, whose own tests are vision_board_detect_opencv_test.js).
 *
 * HOW TO RUN (from src/web/, after ./build.sh): deno test --allow-read --allow-env tests/
 *
 * WHAT THE FRAMES ARE. Synthetic camera frames from tests/vision_synth.js: the board rendered by
 * OpenCV's own CharucoBoard.generateImage (opencv.js is still loaded here, to draw), warped by a
 * known homography into a frame, with optional blur and noise. The homography gives every corner's
 * TRUE position. Real phone frames are tests/harness/test_vision_detect.py's, in Chrome.
 *
 * WHAT THE NUMBERS MEAN. "2-marker" corners are the ones OpenCV returns by default (both
 * neighbouring markers seen); "1-marker" corners come from the desktop pipeline's second pass and
 * are less reliable, so accuracy bounds are set on 2-marker corners and only sanity bounds on the
 * rest. Against opencv.js the port is meant to be EXACT: same markers, same corner ids, same
 * positions (it reproduces OpenCV's arithmetic), so those tests ask for agreement to 0.001 px.
 */

import { loadOpenCv } from '../src/lib/vision/opencv.js';
import { createBoardDetector, MIN_CORNER_SHARPNESS } from '../src/lib/vision/board_detect.js';
import { createBoardDetector as createOpenCvDetector } from '../src/lib/vision/board_detect_opencv.js';
import { BOARD_SPECS, cornerPoint } from '../src/lib/vision/board_frame.js';
import { boardImage, cornerErrors, makeFrame, visibleIds } from './vision_synth.js';
import { loadBuiltVision, VISION_BUILT } from './vision_test_support.js';

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
const cv = await loadOpenCv({ source: await Deno.readTextFile(OPENCV_JS) });
const vision = await loadBuiltVision();
const TEST = { sanitizeOps: false, sanitizeResources: false, ignore: !VISION_BUILT };

const OVERVIEW = [[230, 110], [1060, 80], [1180, 650], [150, 610]];
const CLOSE_UP = [[-420, -330], [1580, -380], [1760, 1120], [-560, 1060]];
const WIDTH = 1280;
const HEIGHT = 720;
const STRIP = BOARD_SPECS.charuco_23x17_10mm_strip;

/** A grey cv.Mat as the ImageData-like { data, width, height } the phone's detector takes. */
function greyImage(mat) {
  return { data: new Uint8Array(mat.data), width: mat.cols, height: mat.rows };
}

/** Splits a detection's corner errors (against the truth) by marker count. */
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

/** How two detections of one frame compare: ids both have, either alone, and position gaps. */
function compare(rust, opencv) {
  const a = new Map(rust.corners.map((c) => [c.id, c]));
  const b = new Map(opencv.corners.map((c) => [c.id, c]));
  const both = [...a.keys()].filter((id) => b.has(id));
  const gaps = both.map((id) => Math.hypot(a.get(id).x - b.get(id).x, a.get(id).y - b.get(id).y)).sort((p, q) => p - q);
  const pick = (q) => gaps[Math.min(gaps.length - 1, Math.floor(q * (gaps.length - 1) + 0.5))] ?? 0;
  const markersA = rust.markers.map((m) => m.id).sort((p, q) => p - q);
  const markersB = opencv.markers.map((m) => m.id).sort((p, q) => p - q);
  return {
    matched: both.length,
    missing: [...b.keys()].filter((id) => !a.has(id)),
    extra: [...a.keys()].filter((id) => !b.has(id)),
    median: pick(0.5),
    p95: pick(0.95),
    max: gaps.at(-1) ?? 0,
    sameMarkers: JSON.stringify(markersA) === JSON.stringify(markersB),
    sameMarkerCounts: both.every((id) => a.get(id).markers === b.get(id).markers),
    sharpnessGap: Math.max(0, ...both.map((id) => Math.abs((a.get(id).sharpness ?? 0) - (b.get(id).sharpness ?? 0)))),
  };
}

Deno.test('every shipped board is found in a perspective view, to a tenth of a pixel, without its invalid corners', TEST, () => {
  // Setup: for each of the four printable boards, one sharp perspective frame of the whole board
  // (markers about 25-30 px) with mild sensor noise (sigma 2 grey levels), as grey pixels.
  // Test: detect once with the Rust detector.
  // Verifies: (1) at least 95% of the board's valid corners well inside the frame are found;
  // (2) the 2-marker corners are within 0.15 px median and 0.5 px worst of the truth, the
  // 1-marker ones within 1 px -- which also pins the + 0.5 px between OpenCV's pixel centres and
  // types.js's convention; (3) no returned id is one board_frame refuses, and no marker one the
  // spec removed; (4) the frame is `recognised`; (5) the frame info defaults to the frame's size.
  for (const [name, spec] of Object.entries(BOARD_SPECS)) {
    const printed = boardImage(cv, spec, { pps: 48 });
    const { frame, truth } = makeFrame(cv, spec, printed, { width: WIDTH, height: HEIGHT, quad: OVERVIEW, noise: 2, seed: 3 });
    const detector = createBoardDetector(vision, spec);
    const detection = detector.detect(greyImage(frame));
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

Deno.test('a blurred close-up keeps its corners, and blurred corners are re-refined without a half-pixel bias', TEST, () => {
  // Setup: the 3 x 3-target board seen close (markers ~50-65 px, running off every edge) and
  // defocused (Gaussian sigma 2.5 px) with noise, as the phone's 2x zoom does.
  // Test: detect three frames (the first tunes the marker-size factor), then once more with and
  // without desktopHalfPixelShift (detect.py refine_blurred's -0.5 / +0.5, reproduced).
  // Verifies: (1) recognised with dozens of 2-marker corners within 0.35 px median; (2) some corners
  // are blurred (sharpness < MIN_CORNER_SHARPNESS), so the re-refinement ran; (3) with the
  // desktop's shift every re-refined corner moves by about (+0.5, +0.5) px and their error grows by
  // more than 0.3 px -- the measurement behind leaving the shift out.
  const spec = BOARD_SPECS.charuco_23x17_10mm_centre3x3;
  const printed = boardImage(cv, spec, { pps: 48 });
  const { frame, truth } = makeFrame(cv, spec, printed, { width: WIDTH, height: HEIGHT, quad: CLOSE_UP, blur: 2.5, noise: 2, seed: 5 });
  const image = greyImage(frame);
  const detector = createBoardDetector(vision, spec);
  let detection;

  for (let k = 0; k < 3; k += 1) {
    detection = detector.detect(image);
  }

  const { two } = byMarkers(detection, truth);
  assert(detection.recognised && two.n >= 30 && two.median < 0.35, `blurred close-up: ${JSON.stringify(two)}`);
  const blurred = detection.corners.filter((c) => c.sharpness < MIN_CORNER_SHARPNESS);
  assert(blurred.length >= 5, `only ${blurred.length} blurred corners: the blur is too light to test re-refinement`);

  const shifted = createBoardDetector(vision, spec, { markerScale: detection.markerScale, desktopHalfPixelShift: true });
  const fixed = createBoardDetector(vision, spec, { markerScale: detection.markerScale });
  const a = fixed.detect(image);
  const b = shifted.detect(image);
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

Deno.test('a partial view returns only corners inside the frame, and too few corners or none are not recognised', TEST, () => {
  // Setup: the strip board (a) so close that only part of it is in the frame, sharp; (b) seen in
  // one corner of the frame with only a handful of its corners visible; (c) a plain table.
  // Test: detect each with one detector (m fixed at 1).
  // Verifies: (a) every corner inside the frame, 2-marker median < 0.15 px, recognised; (b) a few
  // corners but fewer than 8: not recognised; (c) nothing, not recognised, empty lists, the
  // frame time passed through, and no exception.
  const printed = boardImage(cv, STRIP, { pps: 48 });
  const close = makeFrame(cv, STRIP, printed, { width: WIDTH, height: HEIGHT, quad: CLOSE_UP, noise: 2 });
  const detector = createBoardDetector(vision, STRIP, { markerScale: 1 });
  const a = detector.detect(greyImage(close.frame));
  assert(a.corners.every((c) => c.x >= 0 && c.y >= 0 && c.x <= WIDTH && c.y <= HEIGHT), 'a corner outside the frame');
  assert(a.recognised && byMarkers(a, close.truth).two.median < 0.15, `close-up: ${JSON.stringify(byMarkers(a, close.truth))}`);

  const corner = makeFrame(cv, STRIP, printed, { width: WIDTH, height: HEIGHT, quad: [[1030, 590], [2410, 590], [2410, 1610], [1030, 1610]], noise: 2 });
  const b = detector.detect(greyImage(corner.frame));
  assert(b.corners.length > 0 && b.corners.length < 8, `expected a few corners, got ${b.corners.length}`);
  assert(!b.recognised, 'a handful of corners was recognised');

  const table = { data: new Uint8Array(WIDTH * HEIGHT).fill(70), width: WIDTH, height: HEIGHT };
  const c = detector.detect(table, { width: WIDTH, height: HEIGHT, timeMs: 1234 });
  assertEquals([c.corners, c.markers, c.recognised, c.frame.timeMs, c.markerPx], [[], [], false, 1234, null], 'empty frame');

  detector.dispose();
  for (const mat of [close.frame, corner.frame, printed.image]) {
    mat.delete();
  }
});

Deno.test('a processing scale of 0.5 reports full-resolution coordinates, and RGBA input matches grey input', TEST, () => {
  // Setup: the centre1 board close up, as grey pixels and as an RGBA ImageData-like copy (what a
  // canvas getImageData gives the phone page).
  // Test: detect at processing scale 0.5 (a 640 x 360 copy), and at 1 from grey and from RGBA.
  // Verifies: at scale 0.5 the corners come back in FULL-frame pixels, within 0.35 px median (no
  // half-pixel or scale slip, which would show as >= 0.5 px everywhere); the RGBA path gives the
  // same corners as the grey one exactly (OpenCV's grey conversion of grey RGB is lossless).
  const spec = BOARD_SPECS.charuco_23x17_10mm_centre1;
  const printed = boardImage(cv, spec, { pps: 48 });
  const close = makeFrame(cv, spec, printed, { width: WIDTH, height: HEIGHT, quad: CLOSE_UP, noise: 2 });
  const grey = greyImage(close.frame);
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);

  grey.data.forEach((v, i) => {
    rgba[4 * i] = v;
    rgba[4 * i + 1] = v;
    rgba[4 * i + 2] = v;
    rgba[4 * i + 3] = 255;
  });

  const halfScale = createBoardDetector(vision, spec, { processingScale: 0.5 });
  halfScale.detect(grey);
  const half = halfScale.detect(grey);
  const stats = byMarkers(half, close.truth);
  assert(half.recognised && stats.two.n > 50 && stats.two.median < 0.35, `scale 0.5: ${JSON.stringify(stats)}`);
  assertEquals([half.frame.width, half.frame.height], [WIDTH, HEIGHT], 'scale 0.5 frame size');

  const fromGrey = createBoardDetector(vision, spec, { markerScale: 1 });
  const fromRgba = createBoardDetector(vision, spec, { markerScale: 1 });
  const p = fromGrey.detect(grey);
  const q = fromRgba.detect({ data: rgba, width: WIDTH, height: HEIGHT });
  assertEquals(q.corners, p.corners, 'RGBA and grey');

  for (const object of [halfScale, fromGrey, fromRgba]) {
    object.dispose();
  }
  close.frame.delete();
  printed.image.delete();
});

Deno.test('boards the module cannot read are refused, and a disposed detector says so', TEST, () => {
  // Setup: the strip spec with another dictionary, the legacy pattern on an even row count, and a
  // frame with three bytes per pixel.
  // Test: create detectors and detect.
  // Verifies: each is refused with an error naming the problem, instead of a detector that would
  // silently find nothing; and detect() after dispose() throws rather than touching freed memory.
  let message = '';

  try {
    createBoardDetector(vision, { ...STRIP, dictionary: 'DICT_5X5_100' });
  } catch (error) {
    message = String(error.message);
  }

  assert(message.includes('DICT_4X4_250'), `other dictionary: ${message}`);
  assert((() => {
    try {
      createBoardDetector(vision, { ...STRIP, legacy: true, squares_y: 16 });
      return false;
    } catch {
      return true;
    }
  })(), 'legacy pattern accepted');
  const detector = createBoardDetector(vision, STRIP);
  assert((() => {
    try {
      detector.detect({ data: new Uint8Array(30), width: 5, height: 2 });
      return false;
    } catch {
      return true;
    }
  })(), 'RGB accepted');
  detector.dispose();
  assert((() => {
    try {
      detector.detect({ data: new Uint8Array(4), width: 2, height: 2 });
      return false;
    } catch (error) {
      return /disposed/.test(error.message);
    }
  })(), 'detect after dispose');
});

Deno.test('the Rust detector reproduces the opencv.js detector on synthetic frames from 480p to 1080p', TEST, () => {
  // Setup: the strip board (and, as the real-frame fixtures use it, the older 22 x 22 board with
  // 0.689 markers) rendered at 64 px per square; for 480p, 720p and 1080p, the whole board in
  // perspective and a close-up running off the frame, each sharp and blurred (1.5 px; the close-up
  // 2.5 px), with noise; at 720p also a partial view; and the 720p cases again at processing
  // scale 0.5.
  // Test: detect each frame twice (the first tunes m) with the Rust detector and with the opencv.js
  // one, each on its own detector.
  // Verifies: the port is exact -- the same markers, the same corner ids with the same marker
  // counts, positions within 0.001 px of opencv.js's, the same sharpness to 0.01 -- and so exactly
  // as accurate against the truth. Prints, per case, the corners matched, missing and extra, the
  // gaps to opencv.js (median / 95th / max px) and both detectors' median error to the truth.
  const old = { ...STRIP, squares_x: 22, squares_y: 22, marker_mm: 6.89, marker_ratio: 0.689 };
  const rows = [];

  for (const [boardName, spec] of [['strip', STRIP], ['22x22', old]]) {
    const printed = boardImage(cv, spec, { pps: 64 });
    const cases = [];

    for (const [label, width, height] of [['480p', 854, 480], ['720p', 1280, 720], ['1080p', 1920, 1080]]) {
      const k = width / 1280;
      const scaled = (quad) => quad.map(([x, y]) => [x * k, y * k]);
      cases.push([`${label} overview`, width, height, scaled(OVERVIEW), 0, 1]);
      cases.push([`${label} overview blur 1.5`, width, height, scaled(OVERVIEW), 1.5, 1]);
      cases.push([`${label} close-up`, width, height, scaled(CLOSE_UP), 0, 1]);
      cases.push([`${label} close-up blur 2.5`, width, height, scaled(CLOSE_UP), 2.5 * k, 1]);
    }

    cases.push(['720p partial', 1280, 720, [[600, 300], [2200, 280], [2300, 1400], [560, 1380]], 1, 1]);
    cases.push(['720p overview, scale 0.5', 1280, 720, OVERVIEW, 0, 0.5]);
    cases.push(['720p close-up blur 2.5, scale 0.5', 1280, 720, CLOSE_UP, 2.5, 0.5]);

    for (const [label, width, height, quad, blur, scale] of cases) {
      const { frame, truth } = makeFrame(cv, spec, printed, { width, height, quad, blur, noise: 2, seed: 7 });
      const image = greyImage(frame);
      const rust = createBoardDetector(vision, spec, { processingScale: scale });
      const opencv = createOpenCvDetector(cv, spec, { processingScale: scale });
      rust.detect(image);
      opencv.detect(frame);
      const r = rust.detect(image);
      const o = opencv.detect(frame);
      const c = compare(r, o);
      rows.push({ board: boardName, label, scale, ...c, truthRust: cornerErrors(r, truth).median, truthOpenCv: cornerErrors(o, truth).median, n: r.corners.length });
      rust.dispose();
      opencv.dispose();
      frame.delete();
    }

    printed.image.delete();
  }

  console.log('\n  case                                    corners matched missing extra   gap to opencv.js (median/p95/max px)   truth median rust / opencv.js');

  for (const row of rows) {
    console.log(`  ${row.board.padEnd(6)} ${row.label.padEnd(34)} ${String(row.n).padStart(4)} ${String(row.matched).padStart(5)} `
      + `${String(row.missing.length).padStart(5)} ${String(row.extra.length).padStart(5)}   `
      + `${row.median.toFixed(4)} / ${row.p95.toFixed(4)} / ${row.max.toFixed(4)}                ${row.truthRust.toFixed(3)} / ${row.truthOpenCv.toFixed(3)}`);
  }

  for (const row of rows) {
    const what = `${row.board} ${row.label} scale ${row.scale}`;
    assert(row.sameMarkers, `${what}: different markers`);
    assertEquals([row.missing, row.extra], [[], []], `${what}: corner ids`);
    assert(row.sameMarkerCounts, `${what}: marker counts differ`);
    assert(row.max < 0.001, `${what}: corners differ by up to ${row.max} px`);
    assert(row.sharpnessGap < 0.01, `${what}: sharpness differs by ${row.sharpnessGap}`);
  }
});
