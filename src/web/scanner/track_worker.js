// The phone's board TRACKING in a Worker of its own (T-0350), beside the detection's
// (vision_worker.js). The user, 2026-10-14: "can you investigate ways to reduce the charuco board end
// to end latency ... when moving the board can be fairly off from whats actually showing on the
// screen".
//
// WHY A SECOND WORKER. Until T-0350 one Worker took turns: a tracked frame (a few ms), or a full
// detection (25 ms on the M1 Pro, an estimated 75-100 ms on a phone, then the lens and the guidance
// after it). While a detection ran no frame was tracked, so several times a second the overlay's pose
// went that long without a measurement, and the filter carried it forward on its velocity alone:
// right while the phone moved steadily, off whenever it turned or stopped. Here every camera frame
// is tracked, whatever the detection is doing on its core, and each tracked pose goes back to the
// page at once. The detection's job is now to find the board when it is lost, to put the tracked
// corners back on the board (no drift), and to feed the lens and the guidance.
//
// WHAT FLOWS. The page hands this Worker each camera frame as an ImageBitmap (one copy, made by the
// browser). It reads it at the tracker's size, tracks, and answers the page; if the page asked for a
// detection on this frame, the bitmap goes on to the detection's Worker over a MessageChannel
// (transferred, not copied) BEFORE the tracking, so both run at once. The detection's Worker sends
// back over the channel, as soon as its pose is solved, the detection's inlier corners: they become
// the points tracked into the next frame, from the frame they were found on (kept here by its time,
// tracker.js HISTORY_FRAMES), a few frames back by then.
//
// Messages, page -> worker:
//   { type: 'init', visionPayload, port (the channel to the detection's Worker) }
//   { type: 'frame', bitmap, track: { width, height }, frame: { width, height, timeMs },
//     predicted: { R, t } | null, detect: null | { work, outline: false } (forwarded with the bitmap),
//     slowdown }
// worker -> page:
//   { type: 'ready', loadMs, warmMs }   { type: 'failed', message }
//   { type: 'tracked', result (live.js trackFrame's shape), grabMs, canTrack, seeded }
//   { type: 'error', message }
// worker -> detection's Worker (port):
//   { type: 'frame', bitmap, work, track: null, frame, outline, predicted, slowdown }
// detection's Worker -> worker (port):
//   { type: 'seed', frame, corners: [{ id, x, y }], pose (valid, with intrinsics) }

import { loadVision } from '../src/lib/vision/vision_wasm.js';
import { BOARD_SPEC } from '../src/lib/vision/board_frame.js';
import { renderBoardTexture } from '../src/lib/vision/board_texture.js';
import { guessIntrinsics } from '../src/lib/vision/intrinsics.js';
import { createPoseTracker, HISTORY_FRAMES } from '../src/lib/vision/tracker.js';

let tracker = null;
let port = null;
let grab = null;
// The lens of the latest seed (a detection's pose's), which tracked poses are solved with.
let intrinsics = null;
// The tracker's frame size now (processing px per frame px follows from it).
let trackSize = null;
// Seeds taken since the last frame (said in the next answer, for the harness).
let seeded = 0;

async function init({ visionPayload, port: channel }) {
  const loadStarted = performance.now();
  const vision = await loadVision({ payload: visionPayload });
  const loadMs = performance.now() - loadStarted;
  tracker = createPoseTracker(vision, BOARD_SPEC, { history: HISTORY_FRAMES });
  const canvas = new OffscreenCanvas(1, 1);
  grab = { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  port = channel;
  port.onmessage = ({ data }) => {
    if (data.type === 'seed') {
      seed(data);
    }
  };
  const warmStarted = performance.now();
  warmUp(vision);
  return { loadMs, warmMs: performance.now() - warmStarted };
}

/** The tracking path run once on a synthetic view, so the browser compiles it before the first
 *  real frame (live.js warmUp does the same for the detection). */
function warmUp(vision) {
  const texture = renderBoardTexture(BOARD_SPEC, { ppm: 2 });
  const image = { data: texture.data, width: texture.width, height: texture.height };
  const warm = createPoseTracker(vision, BOARD_SPEC, { history: 4 });

  try {
    warm.push(image, 0);
    warm.push(image, 33);
    warm.track(image, 1, { width: image.width, height: image.height, timeMs: 66 }, guessIntrinsics(image), null);
  } finally {
    warm.dispose();
  }
}

/** A detection's inlier corners become the points to track, from the frame they were found on. */
function seed({ frame, corners, pose }) {
  if (!pose?.valid || !trackSize) {
    return;
  }

  intrinsics = pose.intrinsics ?? intrinsics;

  if (tracker.seed({ corners }, pose, trackSize.width / frame.width, frame.timeMs)) {
    seeded += 1;
  }
}

/** The frame's pixels at the tracker's size. */
function grabImage(bitmap, size) {
  const { canvas, context } = grab;

  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width;
    canvas.height = size.height;
  }

  context.drawImage(bitmap, 0, 0, size.width, size.height);
  return context.getImageData(0, 0, size.width, size.height);
}

/** For the harness only: as vision_worker.js's, (slowdown - 1) x the time the frame took here. */
function emulateSlower(started, slowdown) {
  if (slowdown > 1) {
    const until = performance.now() + (slowdown - 1) * (performance.now() - started);

    while (performance.now() < until) {
      // spin
    }
  }
}

function trackFrame({ bitmap, track, frame, predicted = null, detect = null, slowdown = 1 }) {
  const started = performance.now();
  let image;

  try {
    image = grabImage(bitmap, track);
  } finally {
    // The detection gets the frame before the tracking starts, so both run at once.
    if (detect) {
      port.postMessage({ type: 'frame', bitmap, work: detect.work, track: null, frame, outline: false, predicted, slowdown }, [bitmap]);
    } else {
      bitmap.close();
    }
  }

  const grabMs = performance.now() - started;
  trackSize = { width: track.width, height: track.height };
  const t0 = performance.now();
  const out = tracker.track(image, track.width / frame.width, frame, intrinsics, predicted);
  const result = {
    kind: 'track',
    frame: { width: frame.width, height: frame.height, timeMs: frame.timeMs },
    pose: out.pose,
    track: { tracked: out.tracked, kept: out.kept, reason: out.reason },
    timings: { trackMs: out.trackMs, poseMs: out.poseMs, totalMs: performance.now() - t0 },
  };
  emulateSlower(started, slowdown);
  return { result, grabMs };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const timings = await init(data);
      self.postMessage({ type: 'ready', ...timings });
    } else if (data.type === 'frame') {
      const { result, grabMs } = trackFrame(data);
      self.postMessage({ type: 'tracked', result, grabMs, canTrack: tracker.active, seeded });
      seeded = 0;
    }
  } catch (error) {
    data.bitmap?.close?.();
    self.postMessage({ type: data.type === 'init' ? 'failed' : 'error', message: String(error?.stack ?? error) });
  }
};
