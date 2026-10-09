// The phone's vision in a Worker (T-0326): src/web/src/lib/vision/live.js run off the page's main
// thread, so the page (its overlay, its controls, the connection's signalling) never waits for a
// frame's 50-300 ms of board detection, and the detection can use a core of its own.
//
// vision.js builds this file into the phone page inline (Vite's `?worker&inline`: the code travels
// inside the page and the worker starts from a blob: URL), so the page stays one file. The board
// detector, the Rust vision module (T-0330), arrives in the init message as its glue text and wasm
// bytes (vision_wasm.js visionPayload: the page has loaded and inflated houseki_vision.js), so it
// needs no file of its own. OpenCV, still used for the pose, is loaded here with importScripts from
// the absolute URL the page passes (a blob: worker has no base URL of its own). Where that fails --
// a page opened from file://, whose workers may not read files -- the worker says so and the page
// runs the same live.js itself (vision.js, "main thread").
//
// Messages, page -> worker:
//   { type: 'init', opencvUrl, visionPayload, frameSize, camera, device, poseMaxRmsPx? (harness) }
//   { type: 'frame', bitmap (ImageBitmap of the full frame, transferred), work: { width, height },
//     track: { width, height } | null (the tracker's size, T-0332), frame: { width, height, timeMs },
//     outline: boolean, predicted: { R, t } | null (the overlay's predicted pose: the region the
//     detection searches, T-0332) }
//   { type: 'track', bitmap, track, frame, predicted: { R, t } | null }   (T-0332: a frame between
//     detections, read at the tracker's size only; live.trackFrame)
//   { type: 'camera', camera, device }
// worker -> page:
//   { type: 'ready', loadMs, warmMs }        { type: 'failed', message }  (init failed: fall back)
//   { type: 'result', result, grabMs, canTrack }   { type: 'error', message }   (one frame failed)
//   canTrack: whether the next frame could be tracked (a valid pose's corners are held)
//
// Results are live.js's, which are plain data (structured-cloneable) by design.

import { loadOpenCv } from '../src/lib/vision/opencv.js';
import { loadVision } from '../src/lib/vision/vision_wasm.js';
import { createLiveVision } from '../src/lib/vision/live.js';

let live = null;
let grabs = null;

async function init({ opencvUrl, visionPayload, frameSize, camera, device, poseMaxRmsPx = null }) {
  const loadStarted = performance.now();
  const [cv, vision] = await Promise.all([loadOpenCv({ url: opencvUrl }), loadVision({ payload: visionPayload })]);
  const loadMs = performance.now() - loadStarted;
  let glCanvas = null;

  try {
    // The outline's WebGL2 lives on a canvas of its own (Safari has WebGL in an OffscreenCanvas
    // from 17; without it the board and pose still work).
    glCanvas = new OffscreenCanvas(1, 1);
  } catch {
    glCanvas = null;
  }

  live = createLiveVision(cv, { vision, frameSize, camera, device, glCanvas, poseMaxRmsPx });
  grabs = [0, 1].map(() => {
    const canvas = new OffscreenCanvas(1, 1);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  });
  const warmStarted = performance.now();
  await live.warmUp();
  return { loadMs, warmMs: performance.now() - warmStarted };
}

/** The frame's pixels at `size`, drawn into `canvas` (canvases: 0 processing size, 1 tracking). */
function grabImage(bitmap, size, which = 0) {
  const { canvas, context } = grabs[which];

  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width;
    canvas.height = size.height;
  }

  context.drawImage(bitmap, 0, 0, size.width, size.height);
  return context.getImageData(0, 0, size.width, size.height);
}

function processFrame({ bitmap, work, track, frame, outline, predicted = null }) {
  const started = performance.now();

  try {
    const image = grabImage(bitmap, work, 0);
    // The tracker's copy, smaller (T-0332), drawn the same way as a tracked frame's.
    const trackImage = track ? grabImage(bitmap, track, 1) : null;
    const grabMs = performance.now() - started;
    const result = live.processFrame({
      image, scale: work.width / frame.width, frame, source: bitmap, outline,
      trackImage, trackScale: track ? track.width / frame.width : null, predicted,
    });
    return { result, grabMs };
  } finally {
    bitmap.close();
  }
}

/** A frame between detections (T-0332): live.trackFrame, on the tracking size only. */
function trackFrame({ bitmap, track, frame, predicted }) {
  const started = performance.now();

  try {
    const image = grabImage(bitmap, track, 1);
    const grabMs = performance.now() - started;
    const result = live.trackFrame({ image, scale: track.width / frame.width, frame, predicted });
    return { result, grabMs };
  } finally {
    bitmap.close();
  }
}

/**
 * For the harness only (T-0332): emulates a slower phone by spinning for (slowdown - 1) x the time
 * the frame took here, so the page sees results as late as a phone's would come. 1 (no wait) unless
 * the harness sets housekiScanVision.state.slowdown.
 */
function emulateSlower(started, slowdown) {
  if (slowdown > 1) {
    const until = performance.now() + (slowdown - 1) * (performance.now() - started);

    while (performance.now() < until) {
      // spin
    }
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const timings = await init(data);
      self.postMessage({ type: 'ready', ...timings });
    } else if (data.type === 'frame') {
      const started = performance.now();
      const { result, grabMs } = processFrame(data);
      emulateSlower(started, data.slowdown ?? 1);
      self.postMessage({ type: 'result', result, grabMs, canTrack: live.canTrack });
    } else if (data.type === 'track') {
      const started = performance.now();
      const { result, grabMs } = trackFrame(data);
      emulateSlower(started, data.slowdown ?? 1);
      self.postMessage({ type: 'result', result, grabMs, canTrack: live.canTrack });
    } else if (data.type === 'camera') {
      live?.setCamera(data.camera, data.device);
    }
  } catch (error) {
    data.bitmap?.close?.();
    self.postMessage({ type: data.type === 'init' ? 'failed' : 'error', message: String(error?.stack ?? error) });
  }
};
