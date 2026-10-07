/*
 * vision_test_support.js -- shared by the phone-vision pose and intrinsics tests (T-0324). Not a
 * test file itself (no _test suffix).
 *
 * 1. loadStockOpenCv(): the STOCK prebuilt opencv.js 4.12 (npm @techstark/opencv-js, Apache-2.0, a
 *    copy of docs.opencv.org/4.12.0/opencv.js), a test-only dev dependency. The phone loads its own
 *    custom build (vision/opencv.js, T-0323); the code under test takes `cv` as a parameter, so
 *    either works. opencv.js is an Emscripten UMD script: under Deno it is evaluated as a classic
 *    script with `module` supplied and the Node globals hidden (with `process` visible it takes the
 *    Node path and needs `__dirname`). Its Module object has a `then` that resolves to itself, so
 *    it must NOT be awaited or returned from an async function (the promise never settles); the
 *    loader waits for onRuntimeInitialized (~0.7 s on an M1 Pro) and then deletes that `then`.
 *    Returns null when the package is not installed (the tests then skip).
 * 2. A synthetic camera: look-at poses from azimuth / elevation / distance, and BoardDetections made
 *    by projecting the board's corners through a pose and intrinsics (with k1), with Gaussian
 *    noise, wrong ids and dropped corners, from a seeded random generator (runs are repeatable).
 */

import { cornerPoints } from '../src/lib/vision/board_frame.js';
import { projectPoints } from '../src/lib/vision/camera_model.js';
import { loadVision } from '../src/lib/vision/vision_wasm.js';

/**
 * The phone's vision module (T-0330), from the build: build/vision/houseki_vision.js, the classic
 * script make_page.py writes (./build.sh, or `python3 src/scripts/make_page.py`). It is generated,
 * so a checkout that has not been built has none: then this resolves to null, VISION_BUILT is
 * false, and the tests that need it are ignored (with a warning printed once) rather than failing.
 */
export const VISION_SCRIPT_PATH = new URL('../../../build/vision/houseki_vision.js', import.meta.url);
export const VISION_BUILT = (() => {
  try {
    Deno.statSync(VISION_SCRIPT_PATH);
    return true;
  } catch {
    console.warn(`\n  ${VISION_SCRIPT_PATH.pathname} is missing: run ./build.sh first; the vision wasm tests are ignored.\n`);
    return false;
  }
})();

export async function loadBuiltVision() {
  if (!VISION_BUILT) {
    return null;
  }

  return loadVision({ scriptText: await Deno.readTextFile(VISION_SCRIPT_PATH) });
}

let cvPromise = null;

export function loadStockOpenCv() {
  cvPromise ??= (async () => {
    const url = new URL('../node_modules/@techstark/opencv-js/dist/opencv.js', import.meta.url);
    let source;

    try {
      source = await Deno.readTextFile(url);
    } catch {
      return null;
    }

    const module = { exports: {} };
    // eslint-disable-next-line no-new-func
    const run = new Function('module', 'exports', 'define', 'window', 'importScripts', 'process', 'require', '__dirname', source);
    run.call({}, module, module.exports);
    const cv = module.exports;

    if (!cv.Mat) {
      await new Promise((resolve) => {
        cv.onRuntimeInitialized = resolve;
      });
    }

    // Returning a thenable from an async function adopts it, and this one resolves to itself: the
    // promise would never settle. Its `then` is only Emscripten's ready-callback, so drop it.
    delete cv.then;
    return cv;
  })();
  return cvPromise;
}

/** Deno.test options for a test that needs opencv.js: its wasm runtime keeps timers we do not own. */
export const CV_TEST = { sanitizeOps: false, sanitizeResources: false };

/** mulberry32: a small seeded generator, so synthetic noise is the same on every run. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal sample (Box-Muller) from a uniform generator. */
export function gaussian(random) {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

function normalize(v) {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * A camera looking at `target` (board mm) from azimuth / elevation (pose.js's convention: azimuth
 * from +X towards +Y) and distance, rolled by `rollDeg` about its optical axis. Returns { R, t,
 * center } with R row-major board -> camera (OpenCV camera: x right, y down, z forward).
 */
export function lookAtPose(target, azimuthDeg, elevationDeg, distanceMm, rollDeg = 0) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const center = [
    target[0] + distanceMm * Math.cos(el) * Math.cos(az),
    target[1] + distanceMm * Math.cos(el) * Math.sin(az),
    (target[2] ?? 0) + distanceMm * Math.sin(el),
  ];
  const z = normalize([target[0] - center[0], target[1] - center[1], (target[2] ?? 0) - center[2]]);
  // the image's "up" leans towards the board's -X (top of the page) when possible
  const hint = Math.abs(z[0]) > 0.99 ? [0, 1, 0] : [-1, 0, 0];
  let x = normalize(cross(z, hint));
  let y = cross(z, x);
  const r = (rollDeg * Math.PI) / 180;
  const xr = x.map((v, i) => Math.cos(r) * v + Math.sin(r) * y[i]);
  const yr = y.map((v, i) => -Math.sin(r) * x[i] + Math.cos(r) * v);
  x = xr;
  y = yr;
  const R = [...x, ...y, ...z];
  const t = [0, 1, 2].map((i) => -(R[3 * i] * center[0] + R[3 * i + 1] * center[1] + R[3 * i + 2] * center[2]));
  return { R, t, center };
}

/**
 * A BoardDetection of `spec` seen through { R, t } and `intrinsics`: every valid corner that lands
 * inside the frame (with a `marginPx` border), plus pixel noise of `noisePx` (per axis, Gaussian).
 * options: { noisePx, random, dropFraction (corners removed at random), wrongIds (that many
 * corners get another valid id: a misread marker), marginPx, timeMs }.
 */
export function syntheticDetection(spec, pose, intrinsics, options = {}) {
  const random = options.random ?? seededRandom(1);
  const noise = options.noisePx ?? 0;
  const margin = options.marginPx ?? 2;
  const all = cornerPoints(spec);
  const projected = projectPoints(all.map((c) => c.point), pose.R, pose.t, intrinsics);
  let corners = [];

  all.forEach((c, i) => {
    const x = projected[2 * i];
    const y = projected[2 * i + 1];

    if (Number.isFinite(x) && x >= margin && y >= margin && x <= intrinsics.width - margin && y <= intrinsics.height - margin) {
      corners.push({ id: c.id, x: x + noise * gaussian(random), y: y + noise * gaussian(random) });
    }
  });

  if (options.dropFraction) {
    corners = corners.filter(() => random() >= options.dropFraction);
  }

  if (options.wrongIds) {
    const ids = all.map((c) => c.id);
    const used = new Set(corners.map((c) => c.id));
    const free = ids.filter((id) => !used.has(id));

    const victims = new Set();

    while (victims.size < Math.min(options.wrongIds, corners.length, free.length)) {
      victims.add(Math.floor(random() * corners.length));
    }

    for (const victim of victims) {
      corners[victim] = { ...corners[victim], id: free.splice(Math.floor(random() * free.length), 1)[0] };
    }
  }

  return {
    frame: { width: intrinsics.width, height: intrinsics.height, timeMs: options.timeMs ?? 0 },
    markers: [],
    corners,
    recognised: corners.length >= 8,
    elapsedMs: 0,
  };
}

/**
 * The reference for calibrate.js: one cv.calibrateCameraExtended call with the desktop's flags
 * (centre fixed, fx = fy, k1 only, intrinsic guess), on float32 points as the desktop passes them.
 * Only for small sets: opencv.js 4.x's cost grows with the cube of the view count (1.7 s for 30
 * views on an M1 Pro). Returns { f, k1, rms, fStd }.
 */
export function calibrateWithOpenCv(cv, views, size, start) {
  const objects = new cv.MatVector();
  const images = new cv.MatVector();
  const owned = [];

  for (const view of views) {
    const o = cv.matFromArray(view.points.length, 1, cv.CV_32FC3, view.points.flat());
    const m = cv.matFromArray(view.pixels.length, 1, cv.CV_32FC2, view.pixels.flat());
    objects.push_back(o);
    images.push_back(m);
    owned.push(o, m);
  }

  const K = cv.matFromArray(3, 3, cv.CV_64F, [start.f, 0, size.width / 2, 0, start.f, size.height / 2, 0, 0, 1]);
  const dist = cv.matFromArray(1, 5, cv.CV_64F, [start.k1 ?? 0, 0, 0, 0, 0]);
  const extra = [new cv.MatVector(), new cv.MatVector(), new cv.Mat(), new cv.Mat(), new cv.Mat()];
  const flags = cv.CALIB_USE_INTRINSIC_GUESS | cv.CALIB_FIX_ASPECT_RATIO | cv.CALIB_FIX_PRINCIPAL_POINT
    | cv.CALIB_FIX_K2 | cv.CALIB_FIX_K3 | cv.CALIB_ZERO_TANGENT_DIST;
  const criteria = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 2.220446049250313e-16);

  try {
    const rms = cv.calibrateCameraExtended(objects, images, new cv.Size(size.width, size.height), K, dist,
      extra[0], extra[1], extra[2], extra[3], extra[4], flags, criteria);
    return { f: K.data64F[0], k1: dist.data64F[0], rms, fStd: extra[2].data64F[1] };
  } finally {
    [...owned, objects, images, K, dist, ...extra].forEach((m) => m.delete());
  }
}

/** A real-capture fixture (fixtures/vision_pose/<name>.json, made by make_fixture.py). */
export function loadFixture(name) {
  return JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/vision_pose/${name}.json`, import.meta.url)));
}

/**
 * A fixture frame's corners as a BoardDetection, restricted to a desktop corner set: 'best' (sharp,
 * next to two markers), 'extended' (any corner sharp enough for the fallback), or 'all' (what the
 * phone, which has no per-corner sharpness, gets). Default: the set the desktop posed it with.
 * frame.set marks each corner 2 (best), 1 (extended only) or 0.
 */
export function fixtureDetection(fixture, frame, set = frame.corner_set) {
  const minSet = set === 'best' ? 2 : set === 'extended' ? 1 : 0;
  const corners = [];

  frame.ids.forEach((id, i) => {
    if (frame.set[i] >= minSet) {
      corners.push({ id, x: frame.xy[2 * i], y: frame.xy[2 * i + 1] });
    }
  });

  const [width, height] = fixture.image_size;
  return { frame: { width, height, timeMs: frame.time * 1000 }, markers: [], corners, recognised: corners.length >= 8, elapsedMs: 0 };
}

/** The desktop's calibration of a fixture's capture, as Intrinsics. */
export function fixtureIntrinsics(fixture) {
  const [width, height] = fixture.image_size;
  const d = fixture.desktop_calibration;
  return { width, height, f: d.f, cx: d.cx, cy: d.cy, k1: d.k1, source: 'refined' };
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

export function assertClose(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance,
    `${message || 'not close'}: got ${actual}, expected ${expected} +/- ${tolerance}`);
}
