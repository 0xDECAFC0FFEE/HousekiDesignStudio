// The phone camera's intrinsics, live (T-0324): a focal length and k1 for pose.js, from the board
// views the phone sees, without the whole-capture calibration the desktop runs on a finished video.
//
// The camera model is the desktop scanner pipeline's (HousekiScanner calibrate.py; its kb article
// calibration-model-for-2x-zoom-phone-video-fixed): principal point fixed at the image centre,
// fx = fy, radial k1 only. Where K comes from, best last:
//
//   'guess'        a typical phone main camera at 1x: f = GUESS_F_OVER_LONG_SIDE (0.85) x the long
//                  side, i.e. a 61 degree field across the long side, k1 = 0. Measured references:
//                  a 26 mm-equivalent lens on a 4:3 frame is 0.75; the scanner's Pixel 7a 1x
//                  1080p video (spinel) 0.93; its 2x zoom (moissanite, quartz) 1.81-1.84.
//   'table'        a per-device table (DEVICE_TABLE, empty for now), matched on what the browser
//                  says about the camera (describeCamera, describeDevice);
//   'closed-form'  once SEED_VIEWS (12) well-spread board views are in hand: the median of every
//                  view's closed-form focal lengths (Zhang's constraints with the centre fixed,
//                  calibrate.homography_focal), k1 = 0 (a table's k1 is kept);
//   'refined'      once REFINE_MIN_VIEWS (30) views spread over viewing directions are in hand: a
//                  calibration with the centre fixed, fx = fy and only k1 free, calibrated, pruned
//                  and recalibrated three times (calibrate.js: the desktop's calibrate.calibrate,
//                  in plain JS because opencv.js's calibrateCameraExtended takes ~33 s for 60
//                  views), on a subset spread by farthest-point sampling over viewing direction and
//                  log distance (calibrate.select_spread), as the desktop's calibrate_video steps
//                  1-2. Run again at REFINE_MAX_VIEWS (60) views, then K is kept fixed
//                  (freezeAfterRefine).
//
// Views: once K is better than the guess, every frame with >= 12 corners spanning the plane whose
// pose (with the current K) passes the gates becomes a candidate; only its pose's inlier corners
// are kept, and a view too close in direction and distance to one already held is skipped. The
// desktop calibrates on sharp corners only (variance of the Laplacian >= 100 in 25 x 25 px at the
// 1080p reference scale, next to two detected markers). A BoardDetection carries no sharpness, so
// by default the pose's pruning is all that removes blurred corners; when a detector adds the
// optional `sharpness` and `markers` per corner, the desktop's filter is applied. Measured on the
// three reference captures, blurred corners move the refined focal length by up to ~0.9% (see
// the kb article phone-camera-pose-and-live-intrinsics-an-exact-p).
//
// The refinement never blocks a frame: it is a job of small steps (one LM iteration, or a handful
// of poses: ~1-5 ms each on an M1 Pro), each run from `options.schedule` (default setTimeout 0), so
// a frame's work and a step alternate. It does not refine the printed board per corner as the
// desktop does (that needs the whole capture); the desktop measured that refinement at about half
// of the residual (0.81 -> 0.38 px), so this K is the desktop's "nominal board" calibration.
//
// Changes of camera:
//   - a frame of another size: same aspect ratio -> K scaled with the long side (and the views kept,
//     rescaled); another aspect ratio -> a new crop of the sensor, start again (a browser's
//     resizeMode 'crop-and-scale' may crop even at the same aspect ratio: the focal-jump watch
//     below catches that);
//   - a zoom or lens switch: setCamera() with new settings starts again at once; without it, a
//     focal jump is caught from the frames themselves: the median of the last LENS_WINDOW frames'
//     closed-form focal lengths more than LENS_JUMP (30%) away from K resets to that median.
//
// OpenCV functions used: findHomography (least squares, via camera_model.viewFocals), solvePnP
// (IPPE) and findHomography (RANSAC) via pose.js and calibrate.js, Mat, matFromArray.

import { cornerPoint } from './board_frame.js';
import { calibrateSteps } from './calibrate.js';
import { median, pixelScale, scaleIntrinsics, selectSpread, spansPlane, viewFocals } from './camera_model.js';
import { createPoseSolver } from './pose.js';

export const GUESS_F_OVER_LONG_SIDE = 0.85;
export const MIN_CALIB_CORNERS = 12;     // calibrate.MIN_CALIB_CORNERS
export const CALIB_SHARPNESS = 100;      // step1.CALIB_SHARPNESS, for detectors that measure it
export const SEED_VIEWS = 12;
export const SEED_GAP_MS = 250;          // seed frames at least this far apart
export const REFINE_MIN_VIEWS = 30;
export const REFINE_MAX_VIEWS = 60;      // step1.N_CALIB_VIEWS
export const POOL_MAX = 150;
export const LENS_WINDOW = 9;
export const LENS_JUMP = 0.3;
export const MAX_REFINED_RMS_PX = 3.0;   // x s: a refinement worse than this is not adopted
export const ADMIT_RMS_SEED_PX = 6.0;    // x s: a view's pose residual limit while K is a seed
export const ADMIT_RMS_REFINED_PX = 2.0; // x s: ... once K is refined

/**
 * Per-device intrinsics, matched in order; the first match wins. Each entry:
 *   { model?: string (navigator.userAgentData model, e.g. 'Pixel 7a'),
 *     label?: string (a substring of the track's label, e.g. 'Back Camera'),
 *     aspect: number (width / height of the stream, long over short),
 *     zoom?: number (the track's zoom setting, where the browser exposes one),
 *     fOverLongSide: number, k1: number, note?: string }
 * Empty until phones are measured (a refined K from this module, divided by the long side).
 */
export const DEVICE_TABLE = Object.freeze([]);

/**
 * What the browser says about a camera track, as plain data (for the table, and for setCamera to
 * notice a change). Every field may be undefined: browsers differ. Measured on desktop Chrome 154:
 * width, height, aspectRatio, frameRate, deviceId, groupId, resizeMode, focusDistance; `zoom` is
 * a supported constraint, reported where the camera has it (Android Chrome; iOS Safari not
 * verified). No browser reports a focal length or field of view. `track` is a MediaStreamTrack.
 */
export function describeCamera(track) {
  const settings = track?.getSettings?.() ?? {};
  let capabilities = {};

  try {
    capabilities = track?.getCapabilities?.() ?? {};
  } catch {
    // Firefox before 132 has no getCapabilities
  }

  return {
    label: track?.label,
    deviceId: settings.deviceId,
    groupId: settings.groupId,
    facingMode: settings.facingMode,
    width: settings.width,
    height: settings.height,
    aspectRatio: settings.aspectRatio,
    frameRate: settings.frameRate,
    resizeMode: settings.resizeMode,
    zoom: settings.zoom,
    zoomRange: capabilities.zoom ? [capabilities.zoom.min, capabilities.zoom.max] : undefined,
    focusDistance: settings.focusDistance,
  };
}

/**
 * The phone's model, where the browser tells (Chromium's User-Agent Client Hints: Android Chrome
 * gives e.g. 'Pixel 7a'; Safari has no userAgentData and its user agent says only 'iPhone').
 */
export async function describeDevice(nav = globalThis.navigator) {
  let model;

  try {
    model = (await nav?.userAgentData?.getHighEntropyValues?.(['model']))?.model || undefined;
  } catch {
    model = undefined;
  }

  return { model, userAgent: nav?.userAgent };
}

/** The table entry for this camera and frame size, or null. */
export function lookupDeviceTable(table, camera, device, size) {
  const aspect = Math.max(size.width, size.height) / Math.min(size.width, size.height);

  for (const entry of table) {
    if (entry.model && entry.model !== device?.model) {
      continue;
    }

    if (entry.label && !(camera?.label ?? '').includes(entry.label)) {
      continue;
    }

    if (Math.abs(entry.aspect / aspect - 1) > 0.02) {
      continue;
    }

    if (entry.zoom !== undefined && Math.abs((camera?.zoom ?? 1) / entry.zoom - 1) > 0.05) {
      continue;
    }

    return entry;
  }

  return null;
}

/** The 'guess' intrinsics for a frame size. */
export function guessIntrinsics(size) {
  return {
    width: size.width,
    height: size.height,
    f: GUESS_F_OVER_LONG_SIDE * Math.max(size.width, size.height),
    cx: size.width / 2,
    cy: size.height / 2,
    k1: 0,
    source: 'guess',
  };
}

/** n indices spread evenly over 0..total-1 (step1._uniform). */
function uniformIndices(total, n) {
  const out = new Set();
  const count = Math.min(n, total);

  for (let i = 0; i < count; i += 1) {
    out.add(count === 1 ? 0 : Math.floor((i * (total - 1)) / (count - 1)));
  }

  return [...out].sort((a, b) => a - b);
}

/**
 * The live estimator.
 *
 * @param cv         opencv.js
 * @param spec       the board spec (board_frame.js)
 * @param frameSize  { width, height } of the frames detections will come from
 * @param options    {
 *   camera, device: describeCamera() / describeDevice() results, for the table;
 *   table: DEVICE_TABLE by default;
 *   seedViews (12), refineMinViews (30), refineMaxViews (60), poolMax (150),
 *   freezeAfterRefine (true): stop collecting once the REFINE_MAX_VIEWS refinement is adopted;
 *   minSeparation (0.035): views closer than this in (direction, 0.5 log distance) are duplicates;
 *   lensWindow (9), lensJump (0.3);
 *   schedule (fn => setTimeout(fn, 0)): how refinement steps are queued;
 *   now (performance.now): a clock, for the timings in status();
 * }
 * @returns {{
 *   addDetection(detection, pose?): boolean   feed a frame (pose: its CameraPose solved with
 *       current(), if the caller has one, saving a solve); true when it was added as a view
 *   current(): Intrinsics                      the best intrinsics now
 *   onChange(cb): () => void                   cb(intrinsics) on every change; returns unsubscribe
 *   setCamera(camera, device?): void           new track settings; a lens/zoom/size change resets
 *   reset(): void
 *   status(): object                           views, phase, the last refinement's numbers
 *   dispose(): void
 * }}
 */
export function createIntrinsicsEstimator(cv, spec, frameSize, options = {}) {
  const table = options.table ?? DEVICE_TABLE;
  const seedViews = options.seedViews ?? SEED_VIEWS;
  const seedGapMs = options.seedGapMs ?? SEED_GAP_MS;
  const refineMinViews = options.refineMinViews ?? REFINE_MIN_VIEWS;
  const refineMaxViews = options.refineMaxViews ?? REFINE_MAX_VIEWS;
  const poolMax = options.poolMax ?? POOL_MAX;
  const freezeAfterRefine = options.freezeAfterRefine ?? true;
  const minSeparation = options.minSeparation ?? 0.035;
  const lensWindow = options.lensWindow ?? LENS_WINDOW;
  const lensJump = options.lensJump ?? LENS_JUMP;
  const schedule = options.schedule ?? ((fn) => setTimeout(fn, 0));
  const now = options.now ?? (() => performance.now());
  const listeners = new Set();
  // the views' poses: pose.js's gates, the residual limit set per call (ADMIT_RMS_*)
  const solver = createPoseSolver(cv, spec);

  let camera = options.camera ?? null;
  let device = options.device ?? null;
  let size = { width: frameSize.width, height: frameSize.height };
  let intrinsics;
  let pool;            // calibration views: [{ ids, points, pixels, feature, timeMs }]
  let seedFocals;      // every seed frame's closed-form focal lengths
  let seedFrames;
  let lastSeedMs;
  let lensRing;        // the last frames' closed-form focal lengths
  let refineRuns;
  let retryAt;         // after a rejected refinement: the pool size to try again at
  let job;            // { generation } of the running refinement, or null
  let generation = 0;
  let frozen;
  let lastRefine;
  let lensResets = 0;
  let disposed = false;

  function seedIntrinsics() {
    const entry = lookupDeviceTable(table, camera, device, size);

    if (entry) {
      return { ...guessIntrinsics(size), f: entry.fOverLongSide * Math.max(size.width, size.height), k1: entry.k1 ?? 0, source: 'table' };
    }

    return guessIntrinsics(size);
  }

  function restart() {
    generation += 1;
    job = null;
    pool = [];
    seedFocals = [];
    seedFrames = 0;
    lastSeedMs = -Infinity;
    lensRing = [];
    refineRuns = 0;
    retryAt = 0;
    frozen = false;
    set(seedIntrinsics());
  }

  function set(next) {
    intrinsics = Object.freeze({ ...next });

    for (const cb of listeners) {
      cb(intrinsics);
    }
  }

  // the corners of a detection the board knows, each id once; `calib` marks the ones sharp enough
  // for calibration when the detector measured sharpness (otherwise all of them)
  function cornersOf(detection) {
    const seen = new Set();
    const ids = [];
    const points = [];
    const pixels = [];
    const calib = [];

    for (const c of detection.corners) {
      const point = cornerPoint(spec, c.id);

      if (point && !seen.has(c.id) && Number.isFinite(c.x) && Number.isFinite(c.y)) {
        seen.add(c.id);
        ids.push(c.id);
        points.push(point);
        pixels.push([c.x, c.y]);
        calib.push(c.sharpness === undefined || (c.sharpness >= CALIB_SHARPNESS && (c.markers ?? 2) >= 2));
      }
    }

    return { ids, points, pixels, calib };
  }

  function featureOf(pose) {
    const target = spec.target?.centre_mm ?? [0, 0];
    const u = [pose.center[0] - target[0], pose.center[1] - target[1], pose.center[2]];
    const d = Math.hypot(...u);
    return [u[0] / d, u[1] / d, u[2] / d, 0.5 * Math.log(d)];
  }

  const featureDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);

  function resize(newSize) {
    const scaled = scaleIntrinsics(intrinsics, newSize);

    if (!scaled) {
      size = { width: newSize.width, height: newSize.height };
      restart();
      return;
    }

    const k = Math.max(newSize.width, newSize.height) / Math.max(size.width, size.height);
    generation += 1;   // a running refinement saw the old pixels
    job = null;
    size = { width: newSize.width, height: newSize.height };

    for (const view of pool) {
      view.pixels = view.pixels.map(([x, y]) => [x * k, y * k]);
    }

    seedFocals = seedFocals.map((f) => f * k);
    lensRing = lensRing.map((f) => f * k);
    set(scaled);
  }

  function addDetection(detection, givenPose = null) {
    if (disposed) {
      throw new Error('intrinsics estimator used after dispose()');
    }

    const frame = detection.frame;

    if (frame && (frame.width !== size.width || frame.height !== size.height)) {
      resize(frame);
    }

    const { ids, points, pixels, calib } = cornersOf(detection);

    if (points.length < 8 || !spansPlane(points, spec.square_mm)) {
      return false;
    }

    // every recognised frame: its closed-form focal lengths, for the seed and the lens-change watch
    const focals = viewFocals(cv, points, pixels, size);
    const timeMs = frame?.timeMs ?? now();

    // the seed: frames at least seedGapMs apart (the phone moves between them), until refined.
    // It needs no pose, so it works however wrong the guess is (the 2x reference captures are at
    // 1.81 x the long side against the guess's 0.85, too far off for any pose gate).
    if (focals.length && points.length >= MIN_CALIB_CORNERS && intrinsics.source !== 'refined'
        && intrinsics.source !== 'table' && !(timeMs - lastSeedMs < seedGapMs)) {
      lastSeedMs = timeMs;
      seedFrames += 1;
      seedFocals.push(...focals);

      if (seedFrames >= seedViews) {
        const f = median(seedFocals);
        const long = Math.max(size.width, size.height);

        if (Number.isFinite(f) && f > 0.2 * long && f < 6 * long
            && (intrinsics.source === 'guess' || Math.abs(f / intrinsics.f - 1) > 0.001)) {
          set({ ...intrinsics, f, k1: 0, source: 'closed-form', seedViews: seedFrames });
        }
      }
    }

    if (focals.length && intrinsics.source !== 'guess') {
      lensRing.push(median(focals));

      if (lensRing.length > lensWindow) {
        lensRing.shift();
      }

      if (lensRing.length === lensWindow) {
        const m = median(lensRing);

        if (Math.abs(m / intrinsics.f - 1) > lensJump) {
          lensResets += 1;
          const ring = lensRing;
          restart();
          lensRing = ring;
          set({ ...guessIntrinsics(size), f: m, source: 'closed-form', seedViews: ring.length });
          // the frame that showed the jump starts the new pool below
        }
      }
    }

    // calibration views: only once K is better than a guess (their poses need it)
    if (frozen || points.length < MIN_CALIB_CORNERS || intrinsics.source === 'guess') {
      return false;
    }

    // its pose with the current K: the viewing direction (only the spread of views depends on K),
    // and which corners agree with the rest (misread or badly blurred ones do not). The pose must
    // pass pose.js's gates, with a looser residual limit while K is not refined (a wrong focal
    // length leaves a few px of residual). Without the residual gate a frame whose misread corners
    // threw the solver off (measured: 315 px RMS, every corner an "inlier" of the 3 x median rule)
    // got in and wrecked a calibration.
    const limit = intrinsics.source === 'refined' ? ADMIT_RMS_REFINED_PX : ADMIT_RMS_SEED_PX;
    const pose = givenPose?.valid && givenPose.rmsPx <= limit * pixelScale(size)
      ? givenPose
      : solver.solve(detection, intrinsics, { maxRmsPx: limit });

    if (!pose?.valid || pose.inliers < MIN_CALIB_CORNERS) {
      return false;
    }

    const inlier = new Set(pose.inlierIds);
    const keep = ids.map((id, i) => inlier.has(id) && calib[i]);

    if (keep.filter(Boolean).length < MIN_CALIB_CORNERS) {
      return false;
    }

    const view = {
      ids: ids.filter((_, i) => keep[i]),
      points: points.filter((_, i) => keep[i]),
      pixels: pixels.filter((_, i) => keep[i]),
      feature: featureOf(pose),
      timeMs,
    };
    let nearest = Infinity;

    for (const other of pool) {
      nearest = Math.min(nearest, featureDistance(view.feature, other.feature));
    }

    if (nearest < minSeparation) {
      return false;
    }

    if (pool.length >= poolMax) {
      // full: replace one of the closest pair, if the new view is further from the rest than that
      let closest = Infinity;
      let victim = -1;

      for (let i = 0; i < pool.length; i += 1) {
        for (let j = i + 1; j < pool.length; j += 1) {
          const d = featureDistance(pool[i].feature, pool[j].feature);

          if (d < closest) {
            closest = d;
            victim = j;
          }
        }
      }

      if (nearest <= closest) {
        return false;
      }

      pool.splice(victim, 1);
    }

    pool.push(view);
    afterAdd();
    return true;
  }

  function afterAdd() {
    const wanted = Math.max(refineRuns === 0 ? refineMinViews : refineMaxViews, retryAt);

    if (!job && refineRuns < 2 && pool.length >= wanted) {
      startRefinement();
    }
  }

  // calibrate_video steps 1-2: calibrate on views uniform in time, pose every view with that K,
  // pick a subset spread over viewing directions, recalibrate on it. One step per scheduled tick.
  function* refinement(views, start) {
    const t0 = now();
    let busy = 0;
    const timed = function* (steps) {
      let step;

      do {
        const a = now();
        step = steps.next();
        busy += now() - a;

        if (!step.done) {
          yield;
        }
      } while (!step.done);

      return step.value;
    };
    const first = uniformIndices(views.length, refineMaxViews);
    const c0 = yield* timed(calibrateSteps(cv, first.map((i) => views[i]), size, start));

    if (!c0) {
      return { rejected: 'calibration failed', views: views.length };
    }

    const k0 = { ...intrinsics, f: c0.f, k1: c0.k1 };
    const dirs = [];
    const dists = [];

    for (let i = 0; i < views.length; i += 1) {
      const a = now();
      const v = views[i];
      const pose = solver.solve({ corners: v.ids.map((id, k) => ({ id, x: v.pixels[k][0], y: v.pixels[k][1] })) }, k0);
      const f = pose ? featureOf(pose) : [0, 0, 1, 0];
      dirs.push(f.slice(0, 3));
      dists.push(Math.exp(2 * f[3]));
      busy += now() - a;

      if (i % 8 === 7) {
        yield;
      }
    }

    const spread = selectSpread(dirs, dists, refineMaxViews);
    let c = c0;

    if (spread.join() !== first.join()) {
      c = (yield* timed(calibrateSteps(cv, spread.map((i) => views[i]), size, c0))) ?? c0;
    }

    return { ...c, busyMs: busy, wallMs: now() - t0, poolViews: views.length };
  }

  function startRefinement() {
    const myGeneration = generation;
    const start = { f: intrinsics.f, k1: intrinsics.k1 };
    const steps = refinement(pool.slice(), start);
    job = { generation: myGeneration };

    const tick = () => {
      if (disposed || generation !== myGeneration) {
        return;   // cancelled: a reset or resize came in between
      }

      const step = steps.next();

      if (!step.done) {
        schedule(tick);
        return;
      }

      job = null;
      refineRuns += 1;
      const r = step.value;
      const s = pixelScale(size);
      const long = Math.max(size.width, size.height);
      let rejected = r.rejected ?? null;

      if (!rejected && !(Number.isFinite(r.f) && r.f > 0.2 * long && r.f < 6 * long && Math.abs(r.k1) < 1)) {
        rejected = 'implausible focal length or k1';
      } else if (!rejected && !(r.rmsPx <= MAX_REFINED_RMS_PX * s)) {
        rejected = `calibration RMS ${r.rmsPx?.toFixed(2)} px over ${(MAX_REFINED_RMS_PX * s).toFixed(2)} px`;
      } else if (!rejected && Math.abs(r.f / start.f - 1) > 0.5 && intrinsics.source !== 'guess') {
        rejected = `focal length ${r.f.toFixed(0)} px is over 50% from the seed ${start.f.toFixed(0)} px`;
      }

      lastRefine = {
        f: r.f, k1: r.k1, rmsPx: r.rmsPx, fStd: r.fStd, k1Std: r.k1Std, views: r.views, points: r.points,
        poolViews: r.poolViews, busyMs: r.busyMs, wallMs: r.wallMs, rejected,
      };

      if (rejected) {
        refineRuns -= 1;   // try again once 10 more views are in
        retryAt = pool.length + 10;
        return;
      }

      set({ ...intrinsics, f: r.f, k1: r.k1, source: 'refined', rmsPx: r.rmsPx, views: r.views });

      if (refineRuns >= 2 && freezeAfterRefine) {
        frozen = true;
      }
    };

    schedule(tick);
  }

  function setCamera(newCamera, newDevice = device) {
    const changed = !camera || newCamera?.deviceId !== camera.deviceId
      || (newCamera?.zoom ?? 1) !== (camera.zoom ?? 1) || newDevice?.model !== device?.model;
    camera = newCamera;
    device = newDevice;

    if (newCamera?.width && newCamera?.height && (newCamera.width !== size.width || newCamera.height !== size.height)) {
      if (changed) {
        size = { width: newCamera.width, height: newCamera.height };
      } else {
        resize({ width: newCamera.width, height: newCamera.height });
        return;
      }
    }

    if (changed) {
      restart();
    }
  }

  restart();

  return {
    addDetection,
    current: () => intrinsics,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setCamera,
    reset: restart,
    status: () => ({
      source: intrinsics.source,
      views: pool.length,
      seedFrames,
      refining: job !== null,
      refineRuns,
      frozen,
      lensResets,
      lastRefine: lastRefine ?? null,
    }),
    dispose() {
      disposed = true;
      generation += 1;
      solver.dispose();
      listeners.clear();
    },
  };
}
