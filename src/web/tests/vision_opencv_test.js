/*
 * vision_opencv_test.js -- the phone's OpenCV build and loader, and its QR code reader (T-0323):
 * src/web/vendor/opencv/opencv.js (OpenCV 4.14.0 compiled for the phone page),
 * src/web/src/lib/vision/opencv.js (loadOpenCv) and src/web/src/lib/vision/qr_detect_opencv.js
 * (since T-0330 the reference for the phone's Rust QR reader, qr_detect.js: vision_qr_test.js).
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * Under Deno the loader has no document to add a <script> to, so it is handed the file's text;
 * the <script src> path the phone page uses (over http and from file://) is
 * tests/harness/test_vision_detect.py's. The QR codes are made by the same encoder the studio
 * uses for its pairing code (scan_qr.js, over uqr), drawn into a Mat, and read back.
 */

import { loadOpenCv, openCvReady, wasmHeapInUse } from '../src/lib/vision/opencv.js';
import { createQrDetector } from '../src/lib/vision/qr_detect_opencv.js';
import { qrCode } from '../src/lib/scan_qr.js';

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

// Everything the three phone vision pieces call, by the agent that calls it (T-0322's briefs). A
// name missing here means the whitelist (vendor/opencv/opencv_js.config.py) lost it.
const NEEDED = {
  'board detection (T-0323)': [
    'aruco_CharucoBoard', 'aruco_CharucoDetector', 'aruco_DetectorParameters', 'aruco_RefineParameters',
    'aruco_CharucoParameters', 'aruco_ArucoDetector', 'aruco_Dictionary', 'getPredefinedDictionary',
    'DICT_4X4_250', 'cornerSubPix', 'findHomography', 'Laplacian', 'meanStdDev', 'resize', 'cvtColor',
    'QRCodeDetector', 'QRCodeDetectorAruco', 'StringVector',
  ],
  'camera pose (T-0324)': [
    'solvePnP', 'solvePnPGeneric', 'solvePnPRansac', 'solvePnPRefineLM', 'Rodrigues', 'projectPoints',
    'findHomography', 'calibrateCameraExtended', 'undistortPointsIter', 'undistortImagePoints',
    'initUndistortRectifyMap', 'SOLVEPNP_IPPE', 'SOLVEPNP_ITERATIVE', 'CALIB_FIX_K2', 'CALIB_FIX_PRINCIPAL_POINT',
  ],
  'rock outline (T-0325)': [
    'cvtColor', 'resize', 'GaussianBlur', 'Laplacian', 'threshold', 'adaptiveThreshold', 'erode', 'dilate',
    'morphologyEx', 'getStructuringElement', 'findContours', 'contourArea', 'convexHull', 'approxPolyDP',
    'connectedComponentsWithStats', 'distanceTransform', 'remap', 'warpPerspective', 'boundingRect', 'moments',
    'grabCut', 'Canny',
  ],
  core: ['Mat', 'MatVector', 'matFromArray', 'matFromImageData', 'Size', 'Point', 'Scalar', 'TermCriteria', 'CV_8UC1', 'CV_32FC2', 'CV_64F'],
};

Deno.test('loadOpenCv runs opencv.js once and resolves to a ready cv every time', async () => {
  // Setup: the committed opencv.js's text; nothing loaded yet in this test file.
  // Test: call loadOpenCv twice at once, then once more after it resolved.
  // Verifies: the two concurrent calls share ONE load (the same promise), every call resolves to
  // the same `cv`, its runtime is ready (a Mat can be made and read), and openCvReady() says so.
  const source = await Deno.readTextFile(OPENCV_JS);
  const first = loadOpenCv({ source });
  const second = loadOpenCv({ source });
  assert(first === second, 'two concurrent loads did not share one promise');
  const cv = await first;
  assert((await loadOpenCv()) === cv, 'a later call resolved to another cv');
  assert(openCvReady(), 'openCvReady() is false after loading');
  const mat = cv.matFromArray(2, 2, cv.CV_8UC1, [1, 2, 3, 4]);
  assertEquals(Array.from(mat.data), [1, 2, 3, 4], 'Mat data');
  mat.delete();
});

Deno.test('the build exports everything the board, pose and outline code calls, and nothing it dropped', async () => {
  // Setup: the loaded cv.
  // Test: look up every name in NEEDED, and a few names the whitelist deliberately leaves out.
  // Verifies: each piece of the phone's vision finds its OpenCV functions, classes and constants
  // (so the pose and outline agents can rely on them); DetectorParameters fields are writable
  // from JavaScript (the tuned parameters depend on that); `undistortPoints` itself is absent
  // (OpenCV's JS generator always skips it) while its two equivalents are present; and the
  // modules the phone does not need (dnn, video, photo, features2d bindings) are not in the build.
  const cv = await loadOpenCv();
  const missing = Object.entries(NEEDED).flatMap(([who, names]) => names.filter((name) => cv[name] === undefined).map((name) => `${who}: ${name}`));
  assertEquals(missing, [], 'missing from opencv.js');

  const params = new cv.aruco_DetectorParameters();
  params.adaptiveThreshWinSizeMax = 93;
  params.perspectiveRemoveIgnoredMarginPerCell = 0.3;
  assertEquals([params.adaptiveThreshWinSizeMax, Math.round(params.perspectiveRemoveIgnoredMarginPerCell * 100)], [93, 30], 'DetectorParameters fields');
  params.delete();

  assertEquals(cv.undistortPoints, undefined, 'undistortPoints');
  const dropped = ['readNetFromONNX', 'calcOpticalFlowPyrLK', 'createMergeMertens', 'ORB', 'CascadeClassifier'].filter((name) => cv[name] !== undefined);
  assertEquals(dropped, [], 'names that should have been left out');
  assert(wasmHeapInUse(cv) > 0, 'wasmHeapInUse unavailable');
});

Deno.test('getPerspectiveTransform returns c22 = 1 on a real phone marker (the patched OpenCV)', async () => {
  // Setup: one marker as the detector found it on a real 1080 x 1920 phone frame (the moissanite
  // fixture; marker 72 of the 22-column reference board, ~140 px wide), and its corners on the
  // board in squares (centre (13.5, 6.5), side 0.689), as OpenCV's ChArUco interpolation builds
  // them.
  // Test: cv.getPerspectiveTransform(board corners -> image corners), then map the chessboard
  // corner (14, 7) through it.
  // Verifies: the matrix comes back with c22 = 1 and |det| well above the ChArUco detector's
  // 1e-6 validity threshold (unpatched OpenCV 4.14 in wasm returned the unit-norm SVD solution,
  // |det| = 3.1e-7, and the detector dropped every corner of that frame: patches/0001), and the
  // mapped corner is where Python's native OpenCV 5.0 puts it (134.496, 852.806).
  const cv = await loadOpenCv();
  const h = 0.689 / 2;
  const board = cv.matFromArray(4, 1, cv.CV_32FC2, [13.5 - h, 6.5 - h, 13.5 + h, 6.5 - h, 13.5 + h, 6.5 + h, 13.5 - h, 6.5 + h]);
  const image = cv.matFromArray(4, 1, cv.CV_32FC2, [196, 1196, 84, 1103, 146, 917, 253, 1015]);
  const H = cv.getPerspectiveTransform(board, image);
  const c22 = H.data64F[8];
  const det = cv.determinant(H);
  const corner = cv.matFromArray(1, 1, cv.CV_32FC2, [14, 7]);
  const mapped = new cv.Mat();
  cv.perspectiveTransform(corner, mapped, H);
  const [x, y] = mapped.data32F;

  assert(Math.abs(c22 - 1) < 1e-12, `c22 = ${c22}`);
  assert(Math.abs(det) > 1000, `|det| = ${Math.abs(det)}`);
  assert(Math.hypot(x - 134.49559, y - 852.80597) < 1e-3, `(14, 7) -> (${x}, ${y})`);

  for (const mat of [board, image, H, corner, mapped]) {
    mat.delete();
  }
});

/**
 * A QR code as a grey Mat: `text` encoded by scan_qr.js (ECC M, 4-module quiet zone), `module` px
 * per module, pasted at (x, y) on a mid-grey background of width x height. Returns the Mat and the
 * code's outer corners (edge coordinates) WITHOUT the quiet zone, where OpenCV's corners should be.
 */
function qrFrame(cv, codes, width, height) {
  const frame = new cv.Mat(height, width, cv.CV_8UC1, new cv.Scalar(120));
  const truths = [];

  for (const { text, x, y, module } of codes) {
    const { size, modules } = qrCode(text);

    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const value = modules[row][col] ? 20 : 240;
        cv.rectangle(frame, new cv.Point(x + col * module, y + row * module), new cv.Point(x + (col + 1) * module - 1, y + (row + 1) * module - 1), new cv.Scalar(value), -1);
      }
    }

    const q = 4 * module;
    const side = (size - 8) * module;
    truths.push([[x + q, y + q], [x + q + side, y + q], [x + q + side, y + q + side], [x + q, y + q + side]]);
  }

  return { frame, truths };
}

Deno.test('a QR code is read with its text and its four corners', async () => {
  // Setup: one code holding a scan link like the studio's (~70 characters), 6 px per module, in a
  // 640 x 480 frame; then the same frame with a slight blur, as a phone sees a screen.
  // Test: createQrDetector(cv).detect on each.
  // Also: the single-code reader (multi: false) at processing scale 0.5, on the sharp frame.
  // Verifies: exactly one code, its text byte for byte, and its corners in OpenCV's order
  // (top-left, top-right, bottom-right, bottom-left) within 2 px of the code's true outer corners
  // in types.js's pixel convention (OpenCV locates QR corners to about a pixel, not sub-pixel:
  // measured 0.7-1.6 px with the blur); the half-scale single reader reads the same text and puts
  // its corners back in full-frame pixels (within 2.5 px).
  const cv = await loadOpenCv();
  const text = 'https://houseki.app/scanner/#v=1&r=0123456789abcdef0123456789abcdef&p=fedcba9876543210';
  const { frame, truths } = qrFrame(cv, [{ text, x: 150, y: 60, module: 6 }], 640, 480);
  const reader = createQrDetector(cv);
  const single = createQrDetector(cv, { multi: false, processingScale: 0.5 });
  const cornerErrors = (found) => found[0].corners.map(([x, y], k) => Math.hypot(x - truths[0][k][0], y - truths[0][k][1]));

  const half = single.detect(frame);
  assertEquals(half.map((f) => f.text), [text], 'half scale, single: texts');
  assert(Math.max(...cornerErrors(half)) < 2.5, `half scale, single: corner errors ${cornerErrors(half)}`);

  for (const blur of [0, 1]) {
    if (blur) {
      cv.GaussianBlur(frame, frame, new cv.Size(0, 0), blur);
    }

    const found = reader.detect(frame);
    assertEquals(found.map((f) => f.text), [text], `blur ${blur}: texts`);
    assert(Math.max(...cornerErrors(found)) < 2, `blur ${blur}: corner errors ${cornerErrors(found)}`);
  }

  reader.dispose();
  single.dispose();
  frame.delete();
});

Deno.test('several QR codes in one frame are all read, and a frame without one gives none', async () => {
  // Setup: two codes with different texts side by side in one 900 x 400 frame; a plain frame;
  // an RGBA ImageData of the two-code frame.
  // Test: detect each with the default (multi) reader, then repeat many frames.
  // Verifies: both texts are found (in any order) from the Mat and from the ImageData, each with
  // corners on its own code (within 2 px); an empty frame gives an empty list rather than an
  // error or an empty-text entry; and the reader leaks nothing over repeated frames (heap in use
  // unchanged).
  const cv = await loadOpenCv();
  const { frame, truths } = qrFrame(cv, [
    { text: 'first code', x: 60, y: 80, module: 8 },
    { text: 'second code, a little longer', x: 520, y: 60, module: 8 },
  ], 900, 400);
  const empty = new cv.Mat(400, 900, cv.CV_8UC1, new cv.Scalar(120));
  const rgba = new cv.Mat();
  cv.cvtColor(frame, rgba, cv.COLOR_GRAY2RGBA);
  const imageData = { data: new Uint8ClampedArray(rgba.data), width: 900, height: 400 };

  const reader = createQrDetector(cv);
  const found = reader.detect(frame);
  assertEquals(found.map((f) => f.text).sort(), ['first code', 'second code, a little longer'], 'two codes');
  for (const { text, corners } of found) {
    const truth = truths[text === 'first code' ? 0 : 1];
    const errors = corners.map(([x, y], k) => Math.hypot(x - truth[k][0], y - truth[k][1]));
    assert(Math.max(...errors) < 2, `${text}: corners off by ${errors}`);
  }
  assertEquals(reader.detect(imageData).map((f) => f.text).sort(), ['first code', 'second code, a little longer'], 'two codes, ImageData');
  assertEquals(reader.detect(empty), [], 'no code');

  const steady = wasmHeapInUse(cv);
  for (let k = 0; k < 5; k += 1) {
    reader.detect(frame);
    reader.detect(empty);
    reader.detect(imageData);
  }
  assertEquals(wasmHeapInUse(cv), steady, 'heap in use after 15 more frames');

  reader.dispose();
  for (const mat of [frame, empty, rgba]) {
    mat.delete();
  }
});
