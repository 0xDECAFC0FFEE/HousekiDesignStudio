// The phone page's vision (T-0326): once the camera streams, it starts the vision pipeline
// (src/web/src/lib/vision/live.js) in a Worker, or in the page where a Worker cannot run it, feeds
// it camera frames, draws what it finds over the camera picture, says in plain words what it sees,
// and hands each result to `send` (the session's sendVision, which passes them to the computer once
// it asks).
//
// NEVER IN THE STREAM'S WAY. Nothing starts until the video plays; OpenCV (a 6.4 MB script) is
// fetched only then; WebRTC encodes and sends the camera off the main thread whatever the vision
// does. Measured in the harness (kb/phone-vision-on-live-frames-*): the studio's received video
// stayed at the camera's 30 frames a second with the vision running.
//
// LOADED WHILE CONNECTING, RUN ONCE CONNECTED. The page calls this as soon as the camera streams,
// with `connected`, a promise of the session's first 'connected'. The Worker loads OpenCV and warms
// up meanwhile, off the main thread, so the board finder is usually ready by the time the phone has
// connected; no frame is read and nothing is shown before then (T-0329: board detection running
// while the connection was set up slowed pairing about four times over). The in-page fallback,
// which would load and compile OpenCV on the main thread, still waits for `connected` before it
// loads. Once connected, the status line shows "Getting the board finder ready..." while it is
// still loading, or why it could not load.
//
// WHERE IT RUNS. In two Workers (inlined into the page) when the browser can (T-0350): the page
// then only copies each frame to an ImageBitmap (createImageBitmap(video), done by the browser) and
// draws the overlay. The TRACKER's Worker (track_worker.js) gets every camera frame and tracks the
// board's corners into it (a few ms); the DETECTION's Worker (vision_worker.js) finds the board
// itself, works out the lens and the guidance -- 15-50 ms a frame on an M1 Pro, an estimated 2-4x
// that on a phone -- on a core of its own, on the frames the tracker passes on to it, and hands its
// corners back to the tracker. Neither waits for the other, so a pose comes with every camera frame
// even while a detection runs (until T-0350 one Worker took turns, and the overlay went without a
// pose for a whole detection several times a second: the user, 2026-10-14, "when moving the board
// can be fairly off from whats actually showing on the screen"). Should the tracker's Worker fail
// to start, the detection's Worker takes turns as before. Where a Worker cannot run the detection
// (no OffscreenCanvas or createImageBitmap; or OpenCV cannot be loaded inside it, as from a page
// opened from file://) the same live.js runs in the page, kept to a DUTY share of the main thread.
//
// WHICH FRAMES. requestVideoFrameCallback (a callback per new camera frame; Chrome, Edge, Safari
// 15.4+) where there is one, else requestAnimationFrame. One frame is in work at a time, at most
// MAX_HZ a second; in the page, after a frame that took t ms the next waits t / DUTY ms (in the
// Worker, t / WORKER_DUTY, leaving the phone's other cores and its battery some room). The
// processing size starts at a short side of TARGET_SHORT_SIDE pixels (a 720p camera is read at
// 0.75x) and steps down while even MIN_HZ cannot be kept, never below MIN_SHORT_SIDE, and back up
// when there is plenty of room. With the two Workers, every frame goes to the tracker while it is
// free, and one to the detection whenever the detection is free and due. Nothing runs while the
// page is hidden.
//
// OVERLAY. A canvas laid over the <video> (object-fit: cover), redrawn for every camera frame: the
// board's whole grid in blue, its edge in white, and a red point on each corner found (T-0350, the
// user: "can you also use the marker ids and known board size to draw the entire grid on the
// screen?"; overlay.js style.grid 'full'). The X/Y/Z arrows at the board's centre are off for now
// (SHOW_AXES, the user, 2026-10-13), and the rock's outline is gone (T-0350, the user: "we can
// remove the gemstone detection itself"). Since T-0332 (the user: "the overlay is lagging") the
// pose they are drawn with is not the latest result's: every valid pose feeds a filter
// (vision/pose_filter.js) that averages it when the phone is still and tracks its velocity when it
// moves, and each frame is drawn with that pose CARRIED FORWARD to the frame's own time, so the grid
// sits on the board in the picture shown, not where the board was a processing time ago. The pose is
// drawn for POSE_HOLD_MS after its last measurement, faded once older than the prediction reaches;
// with none, the grid is drawn through the latest detection's markers (a homography), and results
// older than HIDE_MS take the guidance away too.
//
// ONE PICTURE (T-0340, the user: "the charuco board detection overlay is still somewhat laggy. Can
// you use double buffering"). The <video> and a canvas over it are two layers the browser puts on
// screen on its own schedules: the video's new frame often shows a display refresh or more before
// the overlay drawn for it, so even an overlay exactly right for its frame was seen over the next
// one, trailing the picture whenever the phone moved. So the canvas now shows the camera frame
// too: in each video-frame callback the frame itself (drawImage of the <video> there is the frame
// the callback is for) is drawn into the canvas, then the overlay for that frame's time over it,
// and the canvas, picture and overlay together, is what reaches the screen. A 2D canvas is
// presented only once the callback has finished drawing it -- it is the back buffer, the screen's
// copy the front one -- so the person never sees a frame without its overlay, or an overlay over
// another frame (COMPOSITED; the <video> under it shows only until the first frame is drawn).
//
// DIAGNOSTICS (T-0332). A long press on the status lines at the bottom shows (or hides again) a
// line of numbers: poses a second, how far behind the picture the overlay's measurement is (median,
// 90%), and each stage's milliseconds (vision/latency.js). The same numbers go to the computer in
// the message's optional `speed`, which the studio shows as its Speed row.
//
// SCAN GUIDANCE (T-0331; vision/guidance.js, computed per frame in live.js as the result's `guide`).
// Top right, the next thing to do; with SHOW_MAP (off for now, the user, 2026-10-13), above it a
// small map of where the rock has been filmed from (the sheet seen from above, its top edge up;
// rings from low at the rim to straight down in the middle; a cell fills once a sharp, steady view
// from there has been seen; a yellow dot for the camera now) and the camera's angle around the
// rock ("35° above the board, from 2 o'clock"). In the middle of the
// screen, one warning at a time ("Moving too fast", "Rock at the edge", "Rock not in focus",
// "Glare on the rock"), on once its condition has held WARNING_ON_MS and off once clear for
// WARNING_OFF_MS (guidance.createWarningFilter), so it does not flicker. The coverage starts afresh
// with the page: a new session is a new page (main.js reloads on a new link), and a reload is taken
// as a fresh start too, since the rock may have been moved or changed meanwhile.
//
// For the harness, `globalThis.housekiScanVision` exposes the state and the timings; nothing in
// the page's UI uses it.

import { loadOpenCv } from '../src/lib/vision/opencv.js';
import { loadVision, visionPayload } from '../src/lib/vision/vision_wasm.js';
import { createLiveVision } from '../src/lib/vision/live.js';
import { describeCamera, describeDevice, REFINE_MIN_VIEWS } from '../src/lib/vision/intrinsics.js';
import { drawVisionOverlay, fitTransform, prepareCanvas } from '../src/lib/vision/overlay.js';
import { createPoseFilter, MAX_PREDICT_MS } from '../src/lib/vision/pose_filter.js';
import { makeVisionMessage } from '../src/lib/scan_vision.js';
import {
  angleText, coverageAdvice, coverageMapCells, createWarningFilter, mapPoint, viewAngles,
} from '../src/lib/vision/guidance.js';
import {
  createLatencyStats, diagnosticsText, frameTime, speedForMessage,
} from '../src/lib/vision/latency.js';
import VisionWorker from './vision_worker.js?worker&inline';
import TrackWorker from './track_worker.js?worker&inline';

export const MAX_HZ = 12;
export const MIN_HZ = 4;
export const DUTY = 0.4;
export const WORKER_DUTY = 0.8;
export const TARGET_SHORT_SIDE = 540;
export const MIN_SHORT_SIDE = 360;
export const STALE_MS = 500;
export const HIDE_MS = 2000;
/** The overlay's pose is drawn for this long after its last measurement (then the board is lost). */
export const POSE_HOLD_MS = 500;
/** Track the board between detections (T-0332). */
export const TRACKING = true;
/** While tracking works, a full detection at least this far apart (ms): the tracked frames between
 *  carry the overlay, the detections reset any drift and bring the guidance and the
 *  lens. */
export const TRACKED_DETECT_INTERVAL_MS = 250;
/** With the tracker in a Worker of its own (T-0350), detections at least this far apart while it
 *  tracks (ms): the detection no longer holds the tracking up, so it can come more often than
 *  TRACKED_DETECT_INTERVAL_MS (each puts the tracked corners back on the board, and feeds the lens
 *  and the guidance), but not back to back, for the phone's battery. */
export const PARALLEL_DETECT_INTERVAL_MS = 150;
/** A detection not back after this long (ms) is given up on, so a lost message cannot stop them. */
export const DETECT_TIMEOUT_MS = 5000;
/** The tracker reads frames at this share of the processing size: a quarter of the pixels to move
 *  and read back per tracked frame (measured on the M1 Pro: the 960 x 540 read was 4 of a tracked
 *  frame's 10.5 ms). */
export const TRACK_FACTOR = 0.5;

/** The tracker's frame size for a processing size. */
const trackSize = (work) => ({ width: Math.max(1, Math.round(work.width * TRACK_FACTOR)), height: Math.max(1, Math.round(work.height * TRACK_FACTOR)) });

/** Draw the camera frame into the overlay's canvas with the overlay (T-0340): one buffer, so the
 *  picture and what is drawn over it reach the screen together. */
export const COMPOSITED = true;

/** The X/Y/Z arrows at the board's centre (off for now: the user, 2026-10-13). */
export const SHOW_AXES = false;

/** The coverage map and the camera's angle in the guide (off for now: the user, 2026-10-13); the
 *  next step's advice stays. */
export const SHOW_MAP = false;

/** How long the Worker may take to load OpenCV and warm up before the page gives up on it. */
export const WORKER_START_MS = 60000;

/** Whether the speed diagnostics line is shown (T-0332), kept on the phone. */
export const DIAGNOSTICS_SETTING = 'houseki.scannerDiagnostics';

/** The harness's residual limit for every pose (T-0335 follow-up; see startPhoneVision). */
export const TEST_POSE_MAX_RMS_SETTING = 'houseki.scannerTestPoseMaxRmsPx';

/** How long a press on the status lines toggles the diagnostics line, ms. */
export const LONG_PRESS_MS = 600;

/** How often the diagnostics line is rewritten, ms. */
export const DIAGNOSTICS_EVERY_MS = 500;

const now = () => performance.now();

/** An exponential moving average that starts at its first value. */
function average(weight) {
  let value = null;
  return {
    add(sample) {
      value = value === null ? sample : value + weight * (sample - value);
      return value;
    },
    get value() {
      return value;
    },
  };
}

/** Per-stage timing statistics for the harness: count, median and 90th percentile of the last 200. */
function stats() {
  const samples = new Map();
  return {
    add(name, value) {
      if (value === null || value === undefined) {
        return;
      }

      const list = samples.get(name) ?? [];
      list.push(value);

      if (list.length > 200) {
        list.shift();
      }

      samples.set(name, list);
    },
    summary() {
      const out = {};

      for (const [name, list] of samples) {
        const sorted = [...list].sort((a, b) => a - b);
        out[name] = {
          n: sorted.length,
          median: sorted[sorted.length >> 1],
          p90: sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))],
        };
      }

      return out;
    },
  };
}

/**
 * The status line's words for a result: { state, text }. `state` is the status line's
 * `data-state` (for the harness): 'searching', 'partial', 'unsteady' or 'pose'.
 */
export function visionStatusText(result) {
  const lines = [];
  let state;

  if (!result.detection.recognised) {
    state = result.detection.markers.length ? 'partial' : 'searching';
    lines.push(result.detection.markers.length
      ? 'Part of the board is in view. Move back a little so more of it shows.'
      : 'Point the camera at the printed board.');
  } else if (!result.pose?.valid) {
    state = 'unsteady';
    lines.push('Board seen, but not clearly. Hold the phone steady.');
  } else {
    state = 'pose';
    // From the rock when the scan guide has a view (its angle is shown beside the map), else as
    // before from the target.
    const fromRock = result.guide?.view;
    const cm = (fromRock ? fromRock.distanceMm : result.pose.distanceMm) / 10;
    lines.push(fromRock
      ? `Board found. The camera is ${cm < 10 ? cm.toFixed(1) : Math.round(cm)} cm from the rock.`
      : `Board found. The camera is ${cm < 10 ? cm.toFixed(1) : Math.round(cm)} cm from the target, `
        + `${Math.round(result.pose.elevationDeg)}° above the board.`);
  }

  const source = result.intrinsics?.source;
  const views = result.calibration?.views ?? 0;

  if (source === 'refined') {
    lines.push('Camera measured.');
  } else if (source === 'closed-form' || source === 'table' || source === 'one-view') {
    // 'one-view' (T-0336): a first estimate from a slanted view is in; the slant is no longer needed.
    lines.push(`Measuring the camera: move around the board slowly (${Math.min(views, REFINE_MIN_VIEWS)} of ${REFINE_MIN_VIEWS} views).`);
  } else {
    lines.push('Measuring the camera: show it the board from a slant.');
  }

  return { state, text: lines.join(' ') };
}

// --- the scan guidance's display (T-0331) ------------------------------------------------------

/** The page's guidance elements, found by id (absent ones are skipped). */
function guideElements(doc = globalThis.document) {
  const byId = (id) => doc?.getElementById?.(id) ?? null;
  return {
    warning: byId('scanner-warning'),
    warningTitle: byId('scanner-warning-title'),
    warningText: byId('scanner-warning-text'),
    guide: byId('scanner-guide'),
    map: byId('scanner-map'),
    angle: byId('scanner-angle'),
    advice: byId('scanner-advice'),
  };
}

/** Fills the map's SVG once: 48 cells and the camera's dot. Returns { cells, here } or null. */
function buildMap(svg) {
  if (!svg) {
    return null;
  }

  const NS = 'http://www.w3.org/2000/svg';
  const cells = coverageMapCells().map((cell) => {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', cell.d);
    svg.append(path);
    return { ...cell, path };
  });
  const here = document.createElementNS(NS, 'circle');
  here.setAttribute('r', '0.1');
  here.setAttribute('class', 'here');
  svg.append(here);
  return { cells, here };
}

const setText = (element, text) => {
  if (element && element.textContent !== text) {
    element.textContent = text;
  }
};

// Through the attribute, which every element has: an SVG element (the map) has no `hidden`
// property, so setting it there did nothing (T-0340).
const setHidden = (element, hidden) => {
  if (element && element.hasAttribute('hidden') !== hidden) {
    element.toggleAttribute('hidden', hidden);
  }
};

/**
 * Shows one result's guidance: the warning (or none), the map, the angle and the advice. The angle
 * and the map's dot use the overlay filter's pose at the result's frame (`filtered`, steady on
 * screen, not carried forward); the coverage, the speed and the warnings are the guide's, from the
 * raw per-frame poses. Returns what is shown, for the harness.
 */
function showGuide(ui, map, result, warning, filtered = null) {
  const guide = result?.guide ?? null;
  const posed = Boolean(result?.pose?.valid && guide?.view);
  setHidden(ui.warning, !warning);

  if (ui.warning) {
    ui.warning.dataset.warning = warning?.id ?? '';
  }

  if (warning) {
    setText(ui.warningTitle, warning.title);
    setText(ui.warningText, warning.text);
  }

  if (!guide) {
    setHidden(ui.guide, true);
    return { warning: warning?.id ?? null, angle: null, advice: null };
  }

  const view = posed && filtered ? viewAngles(filtered.center, guide.rockMm) : guide.view;
  const advice = coverageAdvice(guide.cover, view);
  setHidden(ui.guide, false);
  setHidden(ui.map, !SHOW_MAP);
  setHidden(ui.angle, !SHOW_MAP);
  setText(ui.advice, advice.text);

  if (SHOW_MAP) {
    setText(ui.angle, view ? angleText(view) : 'Point the camera at the board.');
  }

  if (ui.guide) {
    ui.guide.dataset.advice = advice.id;
  }

  if (map && SHOW_MAP) {
    for (const cell of map.cells) {
      const filled = Boolean((guide.cover[cell.band] >> cell.sector) & 1);

      if (cell.filled !== filled) {
        cell.filled = filled;
        cell.path.setAttribute('class', filled ? 'filled' : '');
      }
    }

    if (view) {
      const [x, y] = mapPoint(view.azimuthDeg, view.elevationDeg);
      map.here.setAttribute('cx', x.toFixed(3));
      map.here.setAttribute('cy', y.toFixed(3));
    }

    map.here.style.display = view ? '' : 'none';
  }

  return { warning: warning?.id ?? null, angle: view, advice: advice.id };
}

// --- the speed diagnostics (T-0332) -------------------------------------------------------------

/**
 * The diagnostics line's toggle: a long press (LONG_PRESS_MS, the finger kept still) on any of
 * `targets` (the status lines at the bottom) shows or hides `line`, and the choice is kept on the
 * phone. A long press, not a button, because the line is for reading a phone's numbers when asked
 * to, not for everyday use. Returns { get shown }.
 */
function setUpDiagnostics(line, targets, storage) {
  let shown = false;

  try {
    shown = storage?.getItem(DIAGNOSTICS_SETTING) === '1';
  } catch {
    shown = false;
  }

  const apply = () => {
    if (line) {
      line.hidden = !shown;
    }
  };

  apply();
  let timer = null;
  let start = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  for (const target of targets.filter(Boolean)) {
    target.addEventListener('pointerdown', (event) => {
      start = [event.clientX, event.clientY];
      cancel();
      timer = setTimeout(() => {
        timer = null;
        shown = !shown;
        apply();

        try {
          storage?.setItem(DIAGNOSTICS_SETTING, shown ? '1' : '0');
        } catch {
          // A private window may refuse storage; the line still toggles for this visit.
        }
      }, LONG_PRESS_MS);
    });
    target.addEventListener('pointermove', (event) => {
      if (timer && start && Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 10) {
        cancel();
      }
    });

    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      target.addEventListener(type, cancel);
    }

    // The phone's own long-press menu would cover the screen.
    target.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  return {
    get shown() {
      return shown;
    },
  };
}

// --- where the pipeline runs -------------------------------------------------------------------

/**
 * The pipeline in a Worker. Resolves to a processor, or rejects (the caller then runs it in the
 * page) when the browser has no way to hand frames to a Worker or the Worker cannot start it.
 */
/** Starts a Worker with its 'init' message; resolves to its 'ready' message, or rejects (the Worker
 *  terminated) if it fails or does not start within WORKER_START_MS. */
function initWorker(worker, message, transfer = [], name = 'vision') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the ${name} worker did not start in time`)), WORKER_START_MS);
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`the ${name} worker failed: ${event.message ?? event}`));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        clearTimeout(timer);
        resolve(data);
      } else if (data.type === 'failed') {
        clearTimeout(timer);
        reject(new Error(data.message));
      }
    };
    worker.postMessage(message, transfer);
  }).catch((error) => {
    worker.terminate();
    throw error;
  });
}

const workersPossible = () => typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function';

/**
 * The tracker and the detection in two Workers (T-0350): see the header, WHERE IT RUNS. Resolves to
 * a processor whose frame() hands one camera frame to the tracker (and, with `detect`, on to the
 * detection), or, should the tracker's Worker not start, to the one-Worker processor (startWorker).
 * Rejects (the caller then runs it in the page) when the detection's Worker cannot start.
 */
async function startWorkers(setup, { slowdown = () => 1 } = {}) {
  if (!workersPossible() || typeof MessageChannel !== 'function') {
    throw new Error('no Worker with OffscreenCanvas, createImageBitmap and MessageChannel here');
  }

  const channel = new MessageChannel();
  const trackWorker = new TrackWorker();
  let trackReady;

  try {
    trackReady = await initWorker(trackWorker, { type: 'init', visionPayload: setup.visionPayload, port: channel.port1 }, [channel.port1], 'tracking');
  } catch (error) {
    console.warn('[houseki scan phone] the tracker could not start in a worker of its own; one worker takes turns:', error);
    return startWorker(setup, { slowdown });
  }

  const detectWorker = new VisionWorker();
  let ready;

  try {
    ready = await initWorker(detectWorker, { type: 'init', ...setup, port: channel.port2 }, [channel.port2]);
  } catch (error) {
    trackWorker.terminate();
    throw error;
  }

  // One frame in each Worker at a time: the page waits for each answer before sending the next.
  let tracking = null;
  let detecting = null;
  trackWorker.onmessage = ({ data }) => {
    const job = tracking;
    tracking = null;

    if (!job) {
      return;
    }

    if (data.type === 'tracked') {
      job.resolve({ result: data.result, grabMs: data.grabMs, canTrack: Boolean(data.canTrack), seeded: data.seeded ?? 0, bitmapMs: job.bitmapMs });
    } else {
      job.reject(new Error(data.message));
    }
  };
  detectWorker.onmessage = ({ data }) => {
    const job = detecting;

    if (!job) {
      return;
    }

    if (data.type === 'pose') {
      job.onPose?.(data.pose);
      return;
    }

    detecting = null;

    if (data.type === 'result') {
      job.resolve({ result: data.result, grabMs: data.grabMs, bitmapMs: job.bitmapMs });
    } else {
      job.reject(new Error(data.message));
    }
  };

  return {
    kind: 'worker',
    parallel: true,
    duty: WORKER_DUTY,
    loadMs: ready.loadMs,
    warmMs: ready.warmMs,
    trackLoadMs: trackReady.loadMs,
    /**
     * One camera frame: to the tracker, and with `detect` (the detection free and due) on to the
     * detection. Returns { tracked: Promise, detected: Promise | null }.
     */
    frame({ video, work, track, frame, predicted, detect = false, onPose = null }) {
      const started = now();
      const trackJob = {};
      const tracked = new Promise((resolve, reject) => Object.assign(trackJob, { resolve, reject }));
      let detectJob = null;
      let detected = null;

      if (detect) {
        detectJob = { onPose };
        detected = new Promise((resolve, reject) => Object.assign(detectJob, { resolve, reject }));
      }

      tracking = trackJob;
      detecting = detectJob ?? detecting;
      // An ImageBitmap, not a VideoFrame (T-0350, measured): `new VideoFrame(video)` saved the page
      // little, and drawing it in the Worker (its YUV turned to RGB there) took 7.1 ms against
      // 2.3 for the bitmap, on the tracker's critical path.
      createImageBitmap(video).then((bitmap) => {
        trackJob.bitmapMs = now() - started;

        if (detectJob) {
          detectJob.bitmapMs = trackJob.bitmapMs;
        }

        trackWorker.postMessage({
          type: 'frame', bitmap, track, frame, predicted, detect: detect ? { work } : null, slowdown: slowdown(),
        }, [bitmap]);
      }).catch((error) => {
        tracking = tracking === trackJob ? null : tracking;
        detecting = detecting === detectJob ? null : detecting;
        trackJob.reject(error);
        detectJob?.reject(error);
      });
      return { tracked, detected };
    },
    /** A detection given up on (DETECT_TIMEOUT_MS): its answer, should it come, is ignored. */
    abandonDetection() {
      const job = detecting;
      detecting = null;
      job?.reject(new Error('the detection did not answer in time'));
    },
    setCamera(camera, device) {
      detectWorker.postMessage({ type: 'camera', camera, device });
    },
  };
}

/**
 * The pipeline in one Worker, detection and tracking taking turns (before T-0350; now only when the
 * tracker's Worker cannot start). Resolves to a processor, or rejects (the caller then runs it in
 * the page) when the Worker cannot start it.
 */
async function startWorker(setup, { slowdown = () => 1 } = {}) {
  if (!workersPossible()) {
    throw new Error('no Worker with OffscreenCanvas and createImageBitmap here');
  }

  const worker = new VisionWorker();
  let pending = null;
  const ready = await initWorker(worker, { type: 'init', ...setup });

  worker.onmessage = ({ data }) => {
    if (!pending) {
      return;
    }

    // A detected frame's pose ahead of its result (T-0340): straight to the overlay.
    if (data.type === 'pose') {
      pending.onPose?.(data.pose);
      return;
    }

    const { resolve, reject } = pending;
    pending = null;

    if (data.type === 'result') {
      resolve({ result: data.result, grabMs: data.grabMs, canTrack: Boolean(data.canTrack) });
    } else {
      reject(new Error(data.message));
    }
  };

  return {
    kind: 'worker',
    duty: WORKER_DUTY,
    loadMs: ready.loadMs,
    warmMs: ready.warmMs,
    async process({ video, work, track, frame, predicted, onPose = null }) {
      const started = now();
      const bitmap = await createImageBitmap(video);
      const bitmapMs = now() - started;
      return new Promise((resolve, reject) => {
        pending = { resolve: (value) => resolve({ ...value, bitmapMs }), reject, onPose };
        worker.postMessage({ type: 'frame', bitmap, work, track, frame, predicted, slowdown: slowdown() }, [bitmap]);
      });
    },
    async track({ video, track, frame, predicted }) {
      const started = now();
      const bitmap = await createImageBitmap(video);
      const bitmapMs = now() - started;
      return new Promise((resolve, reject) => {
        pending = { resolve: (value) => resolve({ ...value, bitmapMs }), reject };
        worker.postMessage({ type: 'track', bitmap, track, frame, predicted, slowdown: slowdown() }, [bitmap]);
      });
    },
    setCamera(camera, device) {
      worker.postMessage({ type: 'camera', camera, device });
    },
  };
}

/** The pipeline in the page itself: the fallback. */
async function startInPage(setup) {
  const loadStarted = now();
  const [cv, vision] = await Promise.all([loadOpenCv(), loadVision()]);
  const loadMs = now() - loadStarted;
  const live = createLiveVision(cv, { ...setup, vision });
  const warmStarted = now();

  try {
    await live.warmUp();
  } catch {
    // A failed warm-up only means the first real frames are slower.
  }

  const warmMs = now() - warmStarted;
  const grab = document.createElement('canvas');
  const grabContext = grab.getContext('2d', { willReadFrequently: true });

  return {
    kind: 'main-thread',
    duty: DUTY,
    loadMs,
    warmMs,
    live,
    async process({ video, work, frame, predicted, onPose = null }) {
      const started = now();

      if (grab.width !== work.width || grab.height !== work.height) {
        grab.width = work.width;
        grab.height = work.height;
      }

      grabContext.drawImage(video, 0, 0, work.width, work.height);
      const image = grabContext.getImageData(0, 0, work.width, work.height);
      const grabMs = now() - started;
      const result = live.processFrame({ image, scale: work.width / frame.width, frame, source: video, predicted, onPose });
      return { result, grabMs, canTrack: live.canTrack };
    },
    // Not called (the page tracks only in a Worker), but kept equivalent: a tracked frame here
    // would read the processing size, as this processor's detections give the tracker.
    async track({ video, work, frame, predicted }) {
      const started = now();

      if (grab.width !== work.width || grab.height !== work.height) {
        grab.width = work.width;
        grab.height = work.height;
      }

      grabContext.drawImage(video, 0, 0, work.width, work.height);
      const image = grabContext.getImageData(0, 0, work.width, work.height);
      const grabMs = now() - started;
      const result = live.trackFrame({ image, scale: work.width / frame.width, frame, predicted });
      return { result, grabMs, canTrack: live.canTrack };
    },
    setCamera(camera, device) {
      live.setCamera(camera, device);
    },
  };
}

/**
 * Starts the phone's vision. Resolves once it is running (or has given up: OpenCV could not load,
 * which the status line says; the camera keeps streaming either way).
 *
 * @param {object} parts
 * @param {HTMLVideoElement} parts.video    the camera, shown full screen (object-fit: cover)
 * @param {MediaStream} parts.stream
 * @param {HTMLCanvasElement} parts.overlay  laid over the video
 * @param {HTMLElement} parts.status         the vision status line
 * @param {(message: object) => void} parts.send   where messages go
 * @param {Promise} [parts.connected]        resolves on the session's first 'connected': the
 *   Worker loads before it, but no frame is read and the status line stays hidden until then
 * @param {Storage} [parts.storage]          where the diagnostics line's toggle is kept
 * @param {boolean} [parts.useWorker=true]
 */
export async function startPhoneVision({
  video, stream, overlay, status, send, connected = Promise.resolve(), storage = globalThis.localStorage, useWorker = true,
}) {
  const timing = stats();
  const state = {
    phase: 'loading',
    // The corner ids the latest valid pose (detected or tracked) was solved from: the red points
    // and blue lines on the overlay (T-0333).
    foundIds: null,
    thread: null,
    workerError: null,
    scale: 1,
    frames: 0,
    processed: 0,
    poses: 0,
    // Frames drawn into the canvas with their overlay (COMPOSITED, T-0340), and detected poses that
    // reached the overlay ahead of their frame's result.
    composited: 0,
    earlyPoses: 0,
    // Tracking between detections (T-0332): on (the harness may turn it off to compare), frames
    // tracked, valid poses from them, why not.
    tracking: TRACKING,
    // For the harness only: the Worker emulates a phone this many times slower (vision_worker.js).
    slowdown: 1,
    canTrack: false,
    tracks: 0,
    trackedPoses: 0,
    trackFailures: {},
    // Detections that searched only a region round the rock (T-0332).
    regionDetections: 0,
    lastTracked: null,
    // Detections whose corners the tracker took on from their own frame (T-0350).
    seeds: 0,
    messages: 0,
    error: null,
    last: null,
    lastAt: -Infinity,
    loadMs: null,
    warmMs: null,
    // For the harness (performance.now() ms; null until then): when the board finder started
    // loading, when the session first connected, when the board finder was ready (before
    // connected is the usual case) and when its first frame was read (never before connected).
    loadStartedAt: null,
    connectedAt: null,
    readyAt: null,
    firstFrameAt: null,
    warning: null,
    shown: null,
    drawn: null,
  };
  // How far the overlay trails the picture, and the stages' costs (T-0332, vision/latency.js).
  const latency = createLatencyStats();
  const debug = {
    state,
    timings: () => timing.summary(),
    /** The latest result, as plain numbers, for the harness. */
    latest: () => summarise(state.last),
    /** The diagnostics line's numbers (latency.js summary). */
    latency: () => latency.summary(now()),
    /** Set by the harness: called after each overlay is drawn, in the same video-frame callback,
     *  with { nowMs, frameTimeMs, presentedFrames, mediaTime, drawn }. */
    onDraw: null,
  };
  globalThis.housekiScanVision = debug;
  const diagLine = globalThis.document?.getElementById?.('scanner-diag') ?? null;
  const diagnostics = setUpDiagnostics(diagLine, [status, globalThis.document?.getElementById?.('scanner-status')], storage);
  let diagnosticsAt = -Infinity;
  // The scan guidance's display (T-0331): the warning filter, the map's cells.
  const ui = guideElements();
  const map = buildMap(ui.map);
  const warnings = createWarningFilter();

  // The status line shows only once the phone has connected: while it connects, the connection's
  // own line is the one that matters. (A failure to load is known only after that: the in-page
  // fallback waits for it.)
  let isConnected = false;
  const say = (phase, text) => {
    state.phase = phase;

    if (status.dataset.state !== phase) {
      status.dataset.state = phase;
    }

    if (status.textContent !== text) {
      status.textContent = text;
    }

    status.hidden = !isConnected;
  };
  const whenConnected = connected.then(() => {
    isConnected = true;
    state.connectedAt = now();
    status.hidden = false;
  });

  say('loading', 'Getting the board finder ready...');

  // The video must be playing with a size before anything else happens.
  if (!(video.videoWidth > 0)) {
    await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
  }

  const track = stream.getVideoTracks()[0];
  let camera = describeCamera(track);
  const device = await describeDevice();
  const setup = {
    frameSize: { width: video.videoWidth, height: video.videoHeight },
    camera,
    device,
  };

  // For the harness only (T-0335 follow-up): a residual limit no pose meets, saved in the phone's
  // storage before the page opens, to see the board drawn with every pose failing. Nothing in the
  // page writes it.
  try {
    const limit = Number(storage?.getItem(TEST_POSE_MAX_RMS_SETTING));

    if (limit > 0) {
      setup.poseMaxRmsPx = limit;
    }
  } catch {
    // No storage: the usual limit.
  }
  let processor = null;
  state.loadStartedAt = now();

  if (useWorker) {
    try {
      // The board detector's wasm is loaded and inflated here, once, and handed to the Worker
      // (which may not load files itself from file://); the in-page fallback reuses it.
      processor = await startWorkers({
        ...setup,
        opencvUrl: new URL('opencv.js', document.baseURI).href,
        visionPayload: await visionPayload(),
      }, { slowdown: () => state.slowdown });
    } catch (error) {
      state.workerError = String(error?.message ?? error);
      console.warn('[houseki scan phone] the board finder could not start in a worker, trying the page:', error);
    }
  }

  if (!processor) {
    // In the page, OpenCV loads and compiles on the main thread: only once connected (T-0329).
    await whenConnected;

    try {
      processor = await startInPage(setup);
    } catch (error) {
      state.error = String(error?.message ?? error);
      console.error('[houseki scan phone] the board finder could not load:', error, state.workerError ? `(in a worker: ${state.workerError})` : '');
      say('error', 'The board finder could not load. Your camera still streams to your computer.');
      // Why, under it, in the diagnostics line's small print: what a person can read off their own
      // phone and send us (the user, 2026-10-14, on a Pixel, could not see the console).
      if (diagLine) {
        diagLine.textContent = [state.workerError && `worker: ${state.workerError}`, `page: ${state.error}`].filter(Boolean).join(' · ');
        diagLine.hidden = false;
      }
      return debug;
    }
  }

  state.thread = processor.kind;
  state.loadMs = processor.loadMs;
  state.warmMs = processor.warmMs;
  state.readyAt = now();
  // Ready before the phone has connected (the Worker loads meanwhile): no frame until then.
  await whenConnected;
  say('searching', 'Point the camera at the printed board.');

  const costAverage = average(0.2);
  let nextAt = 0;
  let nextTrackedAt = 0;
  let busy = false;
  // With the two Workers (T-0350): a frame in the tracker's, a frame in the detection's (and since
  // when), each at most one at a time.
  let trackBusy = false;
  let detectBusy = false;
  let detectSentAt = 0;
  let cameraCheckAt = 0;
  // The pose the overlay is drawn with (T-0332): filtered and carried forward to each frame shown.
  const overlayFilter = createPoseFilter();

  const shortSide = () => Math.min(video.videoWidth, video.videoHeight);
  state.scale = Math.min(1, TARGET_SHORT_SIDE / Math.max(1, shortSide()));

  function adapt(cost) {
    const smooth = costAverage.add(cost);
    const interval = Math.max(1000 / MAX_HZ, smooth / processor.duty);

    // Too slow to keep MIN_HZ within the duty: read smaller frames. Plenty of room: larger.
    if (smooth / processor.duty > 1000 / MIN_HZ && shortSide() * state.scale * 0.8 >= MIN_SHORT_SIDE) {
      state.scale *= 0.8;
    } else if (smooth / processor.duty < 0.4 * (1000 / MAX_HZ) && state.scale < Math.min(1, TARGET_SHORT_SIDE / shortSide())) {
      state.scale = Math.min(1, state.scale * 1.25);
    }

    return interval;
  }

  /**
   * A valid pose into the overlay's filter, unless the filter already has a newer one (T-0350: with
   * the tracker in its own Worker, a detection's pose belongs to a frame that tracked poses have
   * already gone past; the tracker takes the detection's corners on from there instead). Returns
   * whether it was taken.
   */
  function feedFilter(pose) {
    if (!pose?.valid) {
      return false;
    }

    const filtered = overlayFilter.state;

    if (filtered && pose.frame.timeMs <= filtered.time) {
      return false;
    }

    overlayFilter.update(pose);
    return true;
  }

  /** A change of camera (a zoom, a lens, a resolution) restarts the intrinsics' view of it. */
  function checkCamera(timeMs) {
    if (timeMs > cameraCheckAt) {
      cameraCheckAt = timeMs + 2000;
      const next = describeCamera(track);

      if (next.deviceId !== camera.deviceId || (next.zoom ?? 1) !== (camera.zoom ?? 1)
          || next.width !== camera.width || next.height !== camera.height) {
        camera = next;
        processor.setCamera(camera, device);
      }
    }
  }

  const workSize = () => ({
    width: Math.max(1, Math.round(video.videoWidth * state.scale)),
    height: Math.max(1, Math.round(video.videoHeight * state.scale)),
  });

  /** The early pose of a detection (T-0340): the overlay's filter takes it then, not after the
   *  frame's lens and guidance. */
  function earlyPose(pose) {
    if (pose?.valid) {
      state.foundIds = pose.inlierIds ?? null;

      if (feedFilter(pose)) {
        state.earlyPoses += 1;
      }
    }
  }

  /**
   * A detection's result (either processor): the timings, the status line, the guidance and the
   * message to the computer; and when the next detection is due. `started`: when the frame went
   * out (performance.now()), `done`: when the result came back.
   */
  function detected({ result, grabMs, bitmapMs, canTrack }, timeMs, started, done) {
    if (canTrack !== undefined) {
      state.canTrack = Boolean(canTrack);
    }

    if (result.pose?.valid) {
      state.poses += 1;
    }

    timing.add('bitmapMs', bitmapMs);
    timing.add('grabMs', grabMs);
    timing.add('detectMs', result.timings.detectMs);
    timing.add('poseMs', result.timings.poseMs);
    timing.add('intrinsicsMs', result.timings.intrinsicsMs);
    timing.add('fitMs', result.timings.fitMs);
    timing.add('guideMs', result.timings.guideMs);
    timing.add('frameMs', done - started);
    // The region searched (T-0332): how often, and what share of the frame.
    timing.add(result.region ? 'regionDetectMs' : 'fullDetectMs', result.timings.detectMs);
    timing.add('regionShare', result.region ? (result.region.width * result.region.height) / (result.frame.width * result.frame.height) : 1);
    state.regionDetections += result.region ? 1 : 0;
    latency.addResult(done, { kind: 'detect', posed: Boolean(result.pose?.valid), timings: { ...result.timings, frameMs: done - started } });

    // The overlay's filter (T-0332): every valid pose feeds it, once (the early pose usually has).
    if (result.pose?.valid) {
      state.foundIds = result.pose.inlierIds ?? null;
      feedFilter(result.pose);
    }

    state.processed += 1;
    state.last = result;
    state.lastAt = timeMs;
    // The next frame waits for this one's cost: the whole frame as this page saw it (the bitmap,
    // the trip to the Worker and back included; before T-0332 only the Worker's own stages
    // counted).
    const interval = adapt(done - started);
    nextAt = timeMs + (processor.parallel && state.canTrack ? Math.max(interval, PARALLEL_DETECT_INTERVAL_MS) : interval);
    // One Worker taking turns: while the board can be tracked, detections are spaced further apart
    // and the frames between are tracked (T-0332): a tracked pose is a few ms old when drawn, a
    // detected one a whole detection old. Should tracking fail, the usual cadence applies again.
    nextTrackedAt = timeMs + Math.max(interval, TRACKED_DETECT_INTERVAL_MS);

    const words = visionStatusText(result);
    say(words.state, words.text);
    const warning = warnings.update(timeMs, result.guide?.conditions ?? {});
    state.warning = warning?.id ?? null;
    state.shown = showGuide(ui, map, result, warning, result.pose?.valid ? overlayFilter.current() : null);

    const message = makeVisionMessage({
      frame: result.frame,
      detection: result.detection,
      pose: result.pose,
      intrinsics: result.intrinsics,
      sheet: result.sheet,
      guide: result.pose?.valid ? result.guide : null,
      warning: state.warning,
      speed: speedForMessage(latency.summary(done)),
    });
    state.messages += 1;
    send(message);
  }

  /**
   * A tracked frame's result (T-0332; either processor): a valid pose feeds the overlay's filter
   * like a detected one, and goes to the computer in a message whose other parts (counts, lens,
   * guidance) are the last detection's. Nothing else (guidance, the board check) comes from a
   * tracked frame.
   */
  function tracked({ result, canTrack, grabMs, bitmapMs, seeded = 0 }, started, done) {
    state.canTrack = Boolean(canTrack);
    state.tracks += 1;
    state.seeds = (state.seeds ?? 0) + seeded;
    state.lastTracked = result;
    timing.add('trackMs', result.timings.totalMs);
    timing.add('trackBitmapMs', bitmapMs);
    timing.add('trackGrabMs', grabMs);
    timing.add('trackFrameMs', done - started);

    if (!state.tracking) {
      return;
    }

    latency.addResult(done, { kind: 'track', posed: Boolean(result.pose?.valid), timings: { trackMs: done - started } });

    if (result.pose?.valid) {
      state.trackedPoses += 1;
      feedFilter(result.pose);
      // state.foundIds keeps the last DETECTION's corners: a tracked pose follows only a sparse
      // spread of them (48), so the red points would thin out and flicker on every tracked frame.
      // Tracking moves them with the pose all the same.
      const last = state.last;

      if (last) {
        state.messages += 1;
        send(makeVisionMessage({
          frame: result.frame,
          detection: last.detection,
          pose: result.pose,
          intrinsics: result.pose.intrinsics,
          sheet: last.sheet,
          guide: last.pose?.valid ? last.guide : null,
          warning: state.warning,
          speed: speedForMessage(latency.summary(done)),
        }));
      }
    } else {
      const reason = result.track?.reason ?? 'no pose';
      state.trackFailures[reason] = (state.trackFailures[reason] ?? 0) + 1;
    }
  }

  /** One Worker or the page (before T-0350): a frame detected, the processor waited for. */
  async function processFrame(timeMs) {
    if (!(video.videoWidth > 0 && video.videoHeight > 0)) {
      return;
    }

    checkCamera(timeMs);
    const started = now();
    state.firstFrameAt ??= started;
    const W = video.videoWidth;
    const H = video.videoHeight;
    const work = workSize();
    const expected = overlayFilter.predict(timeMs);
    const out = await processor.process({
      onPose: earlyPose,
      video,
      work,
      track: trackSize(work),
      // Where the board is expected in this frame: the detection searches a region round it.
      predicted: expected && timeMs - expected.measuredAtMs <= MAX_PREDICT_MS ? { R: expected.R, t: expected.t } : null,
      frame: { width: W, height: H, timeMs },
    });
    detected(out, timeMs, started, now());
  }

  /** One Worker (before T-0350): a frame between detections tracked, the processor waited for. */
  async function trackFrame(timeMs) {
    if (!(video.videoWidth > 0 && video.videoHeight > 0)) {
      return;
    }

    const started = now();
    const work = workSize();
    const predicted = overlayFilter.predict(timeMs);
    const out = await processor.track({
      video,
      work,
      track: trackSize(work),
      frame: { width: video.videoWidth, height: video.videoHeight, timeMs },
      predicted: predicted ? { R: predicted.R, t: predicted.t } : null,
    });
    tracked(out, started, now());
  }

  /**
   * The two Workers (T-0350): this camera frame to the tracker, and on to the detection when it is
   * free and due. Neither is waited for: their answers are handled as they come.
   */
  function sendFrame(timeMs) {
    if (!(video.videoWidth > 0 && video.videoHeight > 0)) {
      return;
    }

    checkCamera(timeMs);
    const started = now();
    state.firstFrameAt ??= started;
    const work = workSize();
    const expected = overlayFilter.predict(timeMs);
    const predicted = expected && timeMs - expected.measuredAtMs <= MAX_PREDICT_MS ? { R: expected.R, t: expected.t } : null;
    const detect = !detectBusy && timeMs >= nextAt;
    const jobs = processor.frame({
      video,
      work,
      track: trackSize(work),
      frame: { width: video.videoWidth, height: video.videoHeight, timeMs },
      predicted,
      detect,
      onPose: earlyPose,
    });
    trackBusy = true;
    jobs.tracked.then((out) => tracked(out, started, now())).catch((error) => {
      state.error = String(error?.stack ?? error);
    }).finally(() => {
      trackBusy = false;
    });

    if (jobs.detected) {
      detectBusy = true;
      detectSentAt = started;
      jobs.detected.then((out) => detected(out, timeMs, started, now())).catch((error) => {
        state.error = String(error?.stack ?? error);
        nextAt = now() + 1000;
      }).finally(() => {
        detectBusy = false;
      });
    }
  }

  function draw(timeMs, nowMs) {
    const { ctx, width, height } = prepareCanvas(overlay);
    const result = state.last;
    const age = timeMs - state.lastAt;

    // The camera frame first, into the same canvas (COMPOSITED): in a video-frame callback this is
    // the frame the callback is for, the one the overlay below is predicted to.
    if (COMPOSITED && video.videoWidth > 0) {
      const fit = fitTransform(video.videoWidth, video.videoHeight, width, height, 'cover');
      ctx.drawImage(video, fit.dx, fit.dy, fit.scale * video.videoWidth, fit.scale * video.videoHeight);
      state.composited += 1;
    }

    if (!result || age > HIDE_MS) {
      // Nothing recent: no warning or guidance about a picture the phone no longer sees.
      if (state.shown) {
        setHidden(ui.warning, true);
        setHidden(ui.guide, true);
        state.shown = null;
        state.warning = null;
        warnings.reset();
      }

      state.drawn = null;
      return;
    }

    const transform = fitTransform(result.frame.width, result.frame.height, width, height, 'cover');
    // The filtered pose carried forward to THIS frame's time (pose_filter.js, T-0332), for as long
    // as its last measurement is recent; faded once it is older than the prediction reaches.
    const measuredAt = overlayFilter.state?.time ?? -Infinity;
    const shown = timeMs - measuredAt <= POSE_HOLD_MS ? overlayFilter.predict(timeMs) : null;
    // The board's whole grid through the drawn pose, with red points on the corners the pose was
    // solved from, placed through the pose too (T-0350: the user asked for the entire grid; T-0333's
    // red points stay). Raw detected corners trail the picture, so they are drawn only when there is
    // no pose to place the points through (T-0335 follow-up: a board found whose pose fails its
    // checks must still show as found): then the whole grid through the latest detection's markers
    // (a homography; overlay.markerGridLines), or with too few markers its corners where they were
    // found, joined in blue, faded once older than STALE_MS.
    const detection = !shown && result.detection?.markers?.length ? result.detection : null;
    const detectedCorners = !shown && result.detection?.corners?.length ? result.detection.corners : null;
    const alpha = shown ? (timeMs - measuredAt > MAX_PREDICT_MS ? 0.4 : 1) : (age > STALE_MS ? 0.4 : 1);
    state.drawn = drawVisionOverlay(ctx, {
      pose: shown,
      intrinsics: shown?.intrinsics ?? null,
      targetMm: result.sheet.targetMm,
      sizeMm: result.sheet.sizeMm,
      corners: null,
      foundCornerIds: state.foundIds,
      detectedCorners,
      detection,
    }, transform, { alpha, grid: 'full', axes: SHOW_AXES });
    // For the harness: the overlay's CSS size, to map its drawn points back to frame pixels.
    state.drawn.transform = transform;
    // How far the drawn pose's measurement trails the picture it is drawn on (latency.js), and how
    // far it was carried forward to meet it.
    state.drawn.poseAgeMs = shown ? timeMs - shown.frame.timeMs : null;
    state.drawn.predictedMs = shown?.predictedMs ?? null;
    // The pose and lens drawn with, for the harness to project any board point as drawn.
    state.drawn.pose = shown && shown.intrinsics ? {
      R: shown.R, t: shown.t, f: shown.intrinsics.f, cx: shown.intrinsics.cx, cy: shown.intrinsics.cy, k1: shown.intrinsics.k1 ?? 0,
    } : null;
    latency.addDraw(nowMs, state.drawn.poseAgeMs);
  }

  /** The diagnostics line, while it is shown, every DIAGNOSTICS_EVERY_MS. */
  function showDiagnostics(nowMs) {
    if (!diagLine || !diagnostics.shown || nowMs - diagnosticsAt < DIAGNOSTICS_EVERY_MS) {
      return;
    }

    diagnosticsAt = nowMs;
    const W = video.videoWidth;
    const H = video.videoHeight;
    const text = diagnosticsText(latency.summary(nowMs), {
      work: W > 0 ? `${Math.round(W * state.scale)}×${Math.round(H * state.scale)}` : null,
      thread: state.thread === 'worker' ? 'worker' : 'page',
    });
    setText(diagLine, text);
  }

  function tick(nowMs, metadata = null) {
    state.frames += 1;
    // The frame's own time (its capture time where the browser gives one), so a pose's age is
    // measured between frames, not between callbacks (latency.js frameTime).
    const { timeMs, from } = frameTime(nowMs, metadata);
    state.frameTimeFrom = from;

    if (processor.parallel) {
      // The two Workers (T-0350): every frame to the tracker while it is free.
      if (detectBusy && now() - detectSentAt > DETECT_TIMEOUT_MS) {
        processor.abandonDetection();
      }

      if (!trackBusy && !document.hidden) {
        sendFrame(timeMs);
      }

      draw(timeMs, nowMs);
      showDiagnostics(nowMs);

      if (typeof debug.onDraw === 'function') {
        debug.onDraw({ nowMs, frameTimeMs: timeMs, presentedFrames: metadata?.presentedFrames ?? null, mediaTime: metadata?.mediaTime ?? null, drawn: state.drawn });
      }

      return;
    }

    const tracking = state.canTrack && state.tracking && processor.kind === 'worker' && Boolean(processor.track);

    if (!busy && !document.hidden && timeMs >= (tracking ? nextTrackedAt : nextAt)) {
      busy = true;
      processFrame(timeMs).catch((error) => {
        state.error = String(error?.stack ?? error);
        nextAt = now() + 1000;
        nextTrackedAt = nextAt;
      }).finally(() => {
        busy = false;
      });
    } else if (!busy && !document.hidden && tracking) {
      // Between detections, every new camera frame is tracked (T-0332). Only in the Worker: in
      // the page, where the vision is kept to a share of the main thread, it is not worth it.
      busy = true;
      trackFrame(timeMs).catch((error) => {
        state.error = String(error?.stack ?? error);
        state.canTrack = false;
      }).finally(() => {
        busy = false;
      });
    }

    draw(timeMs, nowMs);
    showDiagnostics(nowMs);

    if (typeof debug.onDraw === 'function') {
      debug.onDraw({ nowMs, frameTimeMs: timeMs, presentedFrames: metadata?.presentedFrames ?? null, mediaTime: metadata?.mediaTime ?? null, drawn: state.drawn });
    }
  }

  const useVideoFrames = typeof video.requestVideoFrameCallback === 'function';
  const loop = useVideoFrames
    ? () => video.requestVideoFrameCallback((callbackNow, metadata) => {
      loop();
      tick(now(), metadata);
    })
    : () => requestAnimationFrame(() => {
      loop();
      tick(now());
    });
  state.frameSource = useVideoFrames ? 'requestVideoFrameCallback' : 'requestAnimationFrame';
  loop();
  return debug;
}

/** The latest result reduced to plain numbers, for the harness. */
function summarise(result) {
  if (!result) {
    return null;
  }

  return {
    frame: result.frame,
    recognised: result.detection.recognised,
    corners: result.detection.corners.length,
    markers: result.detection.markers.length,
    board: result.detection.board ?? null,
    pose: result.pose ? {
      valid: result.pose.valid,
      R: result.pose.R,
      t: result.pose.t,
      center: result.pose.center,
      azimuthDeg: result.pose.azimuthDeg,
      elevationDeg: result.pose.elevationDeg,
      distanceMm: result.pose.distanceMm,
      rmsPx: result.pose.rmsPx,
    } : null,
    intrinsics: result.intrinsics,
    calibration: { ...result.calibration, lastRefine: undefined },
    sheet: result.sheet,
    guide: result.guide ? { ...result.guide } : null,
    timings: result.timings,
  };
}
