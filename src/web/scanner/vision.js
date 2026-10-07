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
// WHERE IT RUNS. In a Worker (vision_worker.js, inlined into the page) when the browser can: the
// page then only copies each frame to an ImageBitmap (createImageBitmap(video), done by the
// browser) and draws the overlay, and board detection -- 50-90 ms a frame on an M1 Pro for a view
// of the whole board, an estimated 2-4x that on a phone -- runs on a core of its own instead of
// freezing the page that long. Where a Worker cannot run it (no OffscreenCanvas or
// createImageBitmap; or OpenCV cannot be loaded inside it, as from a page opened from file://)
// the same live.js runs in the page, kept to a DUTY share of the main thread.
//
// WHICH FRAMES. requestVideoFrameCallback (a callback per new camera frame; Chrome, Edge, Safari
// 15.4+) where there is one, else requestAnimationFrame. One frame is in work at a time, at most
// MAX_HZ a second; in the page, after a frame that took t ms the next waits t / DUTY ms (in the
// Worker, t / WORKER_DUTY, leaving the phone's other cores and its battery some room). The
// processing size starts at a short side of TARGET_SHORT_SIDE pixels (a 720p camera is read at
// 0.75x) and steps down while even MIN_HZ cannot be kept, never below MIN_SHORT_SIDE, and back up
// when there is plenty of room. The rock's outline runs every `outlineEvery` posed frames (2 to 6),
// chosen so it takes at most OUTLINE_DUTY of the time on top. Nothing runs while the page is
// hidden.
//
// OVERLAY. A canvas laid over the <video> (object-fit: cover), redrawn for every camera frame: the
// board's chessboard grid and the X/Y/Z arrows at its centre, the rock's outline. Since T-0332 (the
// user: "the overlay is lagging") the pose they are drawn with is not the latest result's: every
// valid pose feeds a filter (vision/pose_filter.js) that averages it when the phone is still and
// tracks its velocity when it moves, and each frame is drawn with that pose CARRIED FORWARD to the
// frame's own time, so the grid sits on the board in the picture shown, not where the board was a
// processing time ago. The rock's outline, found every few frames, is carried along with it
// (overlay.transferContour). The pose is drawn for POSE_HOLD_MS after its last measurement, faded
// once older than the prediction reaches; results older than HIDE_MS take the guidance away too.
//
// DIAGNOSTICS (T-0332). A long press on the status lines at the bottom shows (or hides again) a
// line of numbers: poses a second, how far behind the picture the overlay's measurement is (median,
// 90%), and each stage's milliseconds (vision/latency.js). The same numbers go to the computer in
// the message's optional `speed`, which the studio shows as its Speed row.
//
// SCAN GUIDANCE (T-0331; vision/guidance.js, computed per frame in live.js as the result's `guide`).
// Top right, a small map of where the rock has been filmed from (the sheet seen from above, its top
// edge up; rings from low at the rim to straight down in the middle; a cell fills once a sharp,
// steady view from there has been seen; a yellow dot for the camera now), the camera's angle around
// the rock ("35° above the board, from 2 o'clock") and the next thing to do. In the middle of the
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
import { drawVisionOverlay, fitTransform, prepareCanvas, transferContour } from '../src/lib/vision/overlay.js';
import { createPoseFilter, MAX_PREDICT_MS } from '../src/lib/vision/pose_filter.js';
import { SHEET_LABELS } from '../src/lib/vision/board_pick.js';
import { BOARD_SPECS } from '../src/lib/vision/board_frame.js';
import { makeVisionMessage } from '../src/lib/scan_vision.js';
import {
  angleText, coverageAdvice, coverageMapCells, createWarningFilter, mapPoint, viewAngles,
} from '../src/lib/vision/guidance.js';
import {
  createLatencyStats, diagnosticsText, frameTime, speedForMessage,
} from '../src/lib/vision/latency.js';
import VisionWorker from './vision_worker.js?worker&inline';

export const MAX_HZ = 12;
export const MIN_HZ = 4;
export const DUTY = 0.4;
export const WORKER_DUTY = 0.8;
export const OUTLINE_DUTY = 0.2;
export const TARGET_SHORT_SIDE = 540;
export const MIN_SHORT_SIDE = 360;
export const STALE_MS = 500;
export const HIDE_MS = 2000;
/** The overlay's pose is drawn for this long after its last measurement (then the board is lost). */
export const POSE_HOLD_MS = 500;
/** Track the board between detections (T-0332). */
export const TRACKING = true;
/** While tracking works, a full detection at least this far apart (ms): the tracked frames between
 *  carry the overlay, the detections reset any drift and bring the outline, the guidance, the sheet
 *  and the lens. */
export const TRACKED_DETECT_INTERVAL_MS = 250;
/** The tracker reads frames at this share of the processing size: a quarter of the pixels to move
 *  and read back per tracked frame (measured on the M1 Pro: the 960 x 540 read was 4 of a tracked
 *  frame's 10.5 ms). */
export const TRACK_FACTOR = 0.5;

/** The tracker's frame size for a processing size. */
const trackSize = (work) => ({ width: Math.max(1, Math.round(work.width * TRACK_FACTOR)), height: Math.max(1, Math.round(work.height * TRACK_FACTOR)) });

/** How long the Worker may take to load OpenCV and warm up before the page gives up on it. */
export const WORKER_START_MS = 60000;

/** Where the person's choice of sheet is kept on the phone. */
export const SHEET_SETTING = 'houseki.scannerSheet';

/** Whether the speed diagnostics line is shown (T-0332), kept on the phone. */
export const DIAGNOSTICS_SETTING = 'houseki.scannerDiagnostics';

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

/** The status line's words for a result: { state, text }. */
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
  } else if (source === 'closed-form' || source === 'table') {
    lines.push(`Measuring the camera: move around the board slowly (${Math.min(views, REFINE_MIN_VIEWS)} of ${REFINE_MIN_VIEWS} views).`);
  } else {
    lines.push('Measuring the camera: show it the board from a slant.');
  }

  if (state === 'pose') {
    const outline = result.outline;

    if (outline?.contour?.length) {
      lines.push('Rock outlined.');
    } else if (outline) {
      lines.push('No rock found on the target.');
    }
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

const setHidden = (element, hidden) => {
  if (element && element.hidden !== hidden) {
    element.hidden = hidden;
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
  setText(ui.angle, view ? angleText(view) : 'Point the camera at the board.');
  setText(ui.advice, advice.text);

  if (ui.guide) {
    ui.guide.dataset.advice = advice.id;
  }

  if (map) {
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
async function startWorker(setup, { slowdown = () => 1 } = {}) {
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    throw new Error('no Worker with OffscreenCanvas and createImageBitmap here');
  }

  const worker = new VisionWorker();
  let pending = null;

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the vision worker did not start in time')), WORKER_START_MS);
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`the vision worker failed: ${event.message ?? event}`));
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
    worker.postMessage({ type: 'init', ...setup });
  }).catch((error) => {
    worker.terminate();
    throw error;
  });

  worker.onmessage = ({ data }) => {
    if (!pending) {
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
    async process({ video, work, track, frame, outline, predicted }) {
      const started = now();
      const bitmap = await createImageBitmap(video);
      const bitmapMs = now() - started;
      return new Promise((resolve, reject) => {
        pending = { resolve: (value) => resolve({ ...value, bitmapMs }), reject };
        worker.postMessage({ type: 'frame', bitmap, work, track, frame, outline, predicted, slowdown: slowdown() }, [bitmap]);
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
    chooseSheet(name) {
      worker.postMessage({ type: 'sheet', name });
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
  const glCanvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
  const live = createLiveVision(cv, { ...setup, vision, glCanvas });
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
    async process({ video, work, frame, outline, predicted }) {
      const started = now();

      if (grab.width !== work.width || grab.height !== work.height) {
        grab.width = work.width;
        grab.height = work.height;
      }

      grabContext.drawImage(video, 0, 0, work.width, work.height);
      const image = grabContext.getImageData(0, 0, work.width, work.height);
      const grabMs = now() - started;
      const result = live.processFrame({ image, scale: work.width / frame.width, frame, source: video, outline, predicted });
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
    chooseSheet(name) {
      live.chooseSheet(name);
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
 * @param {HTMLSelectElement} [parts.sheetSelect]  the sheet chooser
 * @param {(message: object) => void} parts.send   where messages go
 * @param {Storage} [parts.storage]
 * @param {boolean} [parts.useWorker=true]
 */
export async function startPhoneVision({ video, stream, overlay, status, sheetSelect, send, storage = globalThis.localStorage, useWorker = true }) {
  const timing = stats();
  const state = {
    phase: 'loading',
    // The corner ids the latest valid pose (detected or tracked) was solved from: the red points
    // and blue lines on the overlay (T-0333).
    foundIds: null,
    thread: null,
    workerError: null,
    scale: 1,
    outlineEvery: 3,
    frames: 0,
    processed: 0,
    poses: 0,
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
    outlines: 0,
    messages: 0,
    error: null,
    last: null,
    lastAt: -Infinity,
    loadMs: null,
    warmMs: null,
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

  const say = (phase, text) => {
    state.phase = phase;

    if (status.dataset.state !== phase) {
      status.dataset.state = phase;
    }

    if (status.textContent !== text) {
      status.textContent = text;
    }

    status.hidden = false;
  };

  say('loading', 'Getting the board finder ready...');

  // The video must be playing with a size before anything else happens.
  if (!(video.videoWidth > 0)) {
    await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
  }

  const track = stream.getVideoTracks()[0];
  let camera = describeCamera(track);
  const device = await describeDevice();
  let saved = null;

  try {
    saved = storage?.getItem(SHEET_SETTING) ?? null;
  } catch {
    saved = null;
  }

  const setup = {
    frameSize: { width: video.videoWidth, height: video.videoHeight },
    camera,
    device,
    sheet: saved && BOARD_SPECS[saved] ? saved : null,
  };
  let processor = null;

  if (useWorker) {
    try {
      // The board detector's wasm is loaded and inflated here, once, and handed to the Worker
      // (which may not load files itself from file://); the in-page fallback reuses it.
      processor = await startWorker({
        ...setup,
        opencvUrl: new URL('opencv.js', document.baseURI).href,
        visionPayload: await visionPayload(),
      }, { slowdown: () => state.slowdown });
    } catch (error) {
      state.workerError = String(error?.message ?? error);
    }
  }

  if (!processor) {
    try {
      processor = await startInPage(setup);
    } catch (error) {
      state.error = String(error?.message ?? error);
      say('error', 'The board finder could not load. Your camera still streams to your computer.');
      return debug;
    }
  }

  state.thread = processor.kind;
  state.loadMs = processor.loadMs;
  state.warmMs = processor.warmMs;
  setUpSheetSelect(sheetSelect, processor, storage, saved);
  say('searching', 'Point the camera at the printed board.');

  const costAverage = average(0.2);
  const outlineAverage = average(0.3);
  let nextAt = 0;
  let nextTrackedAt = 0;
  let busy = false;
  let posesSinceOutline = Infinity;
  let cameraCheckAt = 0;
  // The pose the overlay is drawn with (T-0332): filtered and carried forward to each frame shown.
  const overlayFilter = createPoseFilter();
  let filterSheet = null;

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

    if (outlineAverage.value !== null) {
      // The outline's cost spread over `outlineEvery` frames stays within OUTLINE_DUTY.
      state.outlineEvery = Math.max(2, Math.min(6, Math.ceil(outlineAverage.value / (OUTLINE_DUTY * interval))));
    }

    return interval;
  }

  async function processFrame(timeMs) {
    const W = video.videoWidth;
    const H = video.videoHeight;

    if (!(W > 0 && H > 0)) {
      return;
    }

    // A change of camera (a zoom, a lens, a resolution) restarts the intrinsics' view of it.
    if (timeMs > cameraCheckAt) {
      cameraCheckAt = timeMs + 2000;
      const next = describeCamera(track);

      if (next.deviceId !== camera.deviceId || (next.zoom ?? 1) !== (camera.zoom ?? 1)
          || next.width !== camera.width || next.height !== camera.height) {
        camera = next;
        processor.setCamera(camera, device);
      }
    }

    const started = now();
    const work = { width: Math.max(1, Math.round(W * state.scale)), height: Math.max(1, Math.round(H * state.scale)) };
    const expected = overlayFilter.predict(timeMs);
    const { result, grabMs, bitmapMs, canTrack } = await processor.process({
      video,
      work,
      track: trackSize(work),
      // Where the board is expected in this frame: the detection searches a region round it.
      predicted: expected && timeMs - expected.measuredAtMs <= MAX_PREDICT_MS ? { R: expected.R, t: expected.t } : null,
      frame: { width: W, height: H, timeMs },
      outline: posesSinceOutline >= state.outlineEvery,
    });
    const done = now();
    state.canTrack = Boolean(canTrack);

    if (result.pose?.valid) {
      state.poses += 1;
      posesSinceOutline = result.outlineFresh ? 0 : posesSinceOutline + 1;
    }

    if (result.outlineFresh) {
      state.outlines += 1;
      outlineAverage.add(result.timings.outlineMs);
    }

    timing.add('bitmapMs', bitmapMs);
    timing.add('grabMs', grabMs);
    timing.add('detectMs', result.timings.detectMs);
    timing.add('poseMs', result.timings.poseMs);
    timing.add('intrinsicsMs', result.timings.intrinsicsMs);
    timing.add('outlineMs', result.timings.outlineMs);
    timing.add('pickMs', result.timings.pickMs);
    timing.add('guideMs', result.timings.guideMs);
    timing.add('frameMs', done - started);
    // The region searched (T-0332): how often, and what share of the frame.
    timing.add(result.region ? 'regionDetectMs' : 'fullDetectMs', result.timings.detectMs);
    timing.add('regionShare', result.region ? (result.region.width * result.region.height) / (W * H) : 1);
    state.regionDetections += result.region ? 1 : 0;
    latency.addResult(done, { kind: 'detect', posed: Boolean(result.pose?.valid), timings: { ...result.timings, frameMs: done - started } });

    // The overlay's filter (T-0332): a new sheet starts it afresh; every valid pose feeds it.
    if (result.sheet.name !== filterSheet) {
      filterSheet = result.sheet.name;
      overlayFilter.reset();
    }

    if (result.pose?.valid) {
      overlayFilter.update(result.pose);
      state.foundIds = result.pose.inlierIds ?? null;
    }

    state.processed += 1;
    state.last = result;
    state.lastAt = timeMs;
    // The next frame waits for this one's cost (less the outline's, which has its own budget).
    // The whole frame as this page saw it (the bitmap, the trip to the Worker and back included;
    // before T-0332 only the Worker's own stages counted), less the outline's own budget.
    const interval = adapt(done - started - (result.timings.outlineMs ?? 0));
    nextAt = timeMs + interval;
    // While the board can be tracked, detections are spaced further apart and the frames between
    // are tracked (T-0332): a tracked pose is a few ms old when drawn, a detected one a whole
    // detection old. Should tracking fail, the usual cadence applies again (tick).
    nextTrackedAt = timeMs + Math.max(interval, TRACKED_DETECT_INTERVAL_MS);

    const words = visionStatusText(result);
    say(words.state, words.text);
    updateSheetSelect(sheetSelect, result.sheet);
    const warning = warnings.update(timeMs, result.guide?.conditions ?? {});
    state.warning = warning?.id ?? null;
    state.shown = showGuide(ui, map, result, warning, result.pose?.valid ? overlayFilter.current() : null);

    const message = makeVisionMessage({
      frame: result.frame,
      detection: result.detection,
      pose: result.pose,
      intrinsics: result.intrinsics,
      outline: result.outline,
      sheet: result.sheet,
      guide: result.pose?.valid ? result.guide : null,
      warning: state.warning,
      speed: speedForMessage(latency.summary(done)),
    });
    state.messages += 1;
    send(message);
  }

  /**
   * A frame between detections (T-0332): the Worker tracks the last pose's corners into it and
   * re-solves the pose (vision/tracker.js), guided by the overlay's prediction for this frame; a
   * valid pose feeds the overlay's filter like a detected one, and goes to the computer in a
   * message whose other parts (counts, lens, outline, guidance) are the last detection's. Nothing
   * else (outline, guidance, sheet) comes from a tracked frame.
   */
  async function trackFrame(timeMs) {
    const W = video.videoWidth;
    const H = video.videoHeight;

    if (!(W > 0 && H > 0)) {
      return;
    }

    const started = now();
    const work = { width: Math.max(1, Math.round(W * state.scale)), height: Math.max(1, Math.round(H * state.scale)) };
    const predicted = overlayFilter.predict(timeMs);
    const { result, canTrack, grabMs, bitmapMs } = await processor.track({
      video,
      work,
      track: trackSize(work),
      frame: { width: W, height: H, timeMs },
      predicted: predicted ? { R: predicted.R, t: predicted.t } : null,
    });
    const done = now();
    state.canTrack = Boolean(canTrack);
    state.tracks += 1;
    state.lastTracked = result;
    timing.add('trackMs', result.timings.totalMs);
    timing.add('trackBitmapMs', bitmapMs);
    timing.add('trackGrabMs', grabMs);
    timing.add('trackFrameMs', done - started);
    latency.addResult(done, { kind: 'track', posed: Boolean(result.pose?.valid), timings: { trackMs: done - started } });

    if (result.pose?.valid && result.sheet.name === filterSheet) {
      state.trackedPoses += 1;
      overlayFilter.update(result.pose);
      // state.foundIds keeps the last DETECTION's corners: a tracked pose follows only a sparse
      // spread of them (48), which are rarely neighbours, so the points and lines would thin out
      // and flicker on every tracked frame. Tracking moves them with the pose all the same.
      const last = state.last;

      if (last) {
        state.messages += 1;
        send(makeVisionMessage({
          frame: result.frame,
          detection: last.detection,
          pose: result.pose,
          intrinsics: result.pose.intrinsics,
          outline: last.outline,
          sheet: result.sheet,
          guide: last.pose?.valid ? last.guide : null,
          warning: state.warning,
          speed: speedForMessage(latency.summary(done)),
        }));
      }
    } else {
      state.trackFailures[result.track?.reason ?? 'no pose'] = (state.trackFailures[result.track?.reason ?? 'no pose'] ?? 0) + 1;
    }
  }

  function draw(timeMs, nowMs) {
    const { ctx, width, height } = prepareCanvas(overlay);
    const result = state.last;
    const age = timeMs - state.lastAt;

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
    // The rock's outline moves with the board: from the pose of the frame it was found on to the
    // pose drawn, through the plane at the rock's middle height (overlay.transferContour).
    const outline = shown && result.outline?.contour?.length >= 3 ? result.outline : null;
    const contour = outline && result.outlinePose
      ? transferContour(outline.contour, result.outlinePose, result.outlinePose.intrinsics, shown, shown.intrinsics, result.guide?.rockMm?.[2] ?? 0)
      : outline?.contour ?? null;
    // The corners the pose was solved from as red points with blue lines between neighbours, placed
    // through the drawn pose, instead of the faint full-board grid (T-0333: the user's choice; the
    // board's edge stays). Raw detected corners are not drawn: they trail the picture.
    state.drawn = drawVisionOverlay(ctx, {
      pose: shown,
      intrinsics: shown?.intrinsics ?? null,
      targetMm: result.sheet.targetMm,
      sizeMm: result.sheet.sizeMm,
      contour,
      corners: null,
      foundCornerIds: state.foundIds,
    }, transform, { alpha: timeMs - measuredAt > MAX_PREDICT_MS ? 0.4 : 1, grid: false });
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
    outline: result.outline ? { points: result.outline.contour.length, confidence: result.outline.confidence, flags: result.outline.flags } : null,
    outlineError: result.outlineError,
    sheet: result.sheet,
    guide: result.guide ? { ...result.guide } : null,
    timings: result.timings,
  };
}

/** The sheet chooser: "Find the board" (the picker decides) or one of the four sheets. */
function setUpSheetSelect(select, processor, storage, saved) {
  if (!select) {
    return;
  }

  select.replaceChildren();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Board: find it for me';
  select.append(auto);

  for (const [name, label] of Object.entries(SHEET_LABELS)) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = `Board: ${label}`;
    select.append(option);
  }

  select.value = saved && BOARD_SPECS[saved] ? saved : '';
  select.hidden = false;
  select.addEventListener('change', () => {
    const name = select.value || null;
    processor.chooseSheet(name);

    try {
      if (name) {
        storage?.setItem(SHEET_SETTING, name);
      } else {
        storage?.removeItem(SHEET_SETTING);
      }
    } catch {
      // A private window may refuse storage; the choice still holds for this visit.
    }
  });
}

/** Says, on the "find it for me" choice, which sheet was found. */
function updateSheetSelect(select, sheet) {
  if (!select || select.value !== '') {
    return;
  }

  const option = select.options[0];
  const text = sheet.from === 'auto'
    ? `Board: ${SHEET_LABELS[sheet.name] ?? sheet.name} (found)`
    : 'Board: find it for me';

  if (option.textContent !== text) {
    option.textContent = text;
  }

  select.dataset.sheet = sheet.name;
  select.dataset.from = sheet.from;
}
