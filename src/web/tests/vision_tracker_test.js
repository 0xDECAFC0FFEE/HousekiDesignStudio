/*
 * vision_tracker_test.js -- the board's pose between detections from tracked corners (T-0332):
 * src/web/src/lib/vision/tracker.js through live.js's trackFrame, with the Rust vision module as
 * built (build/vision/houseki_vision.js: its FrameTracker, src/vision/flow.rs; ignored when not
 * built) and opencv.js for the detection frame's pose.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * Frames are drawn by tests/vision_render.js (the white/black board through a known camera, a little
 * noise), so every pose's truth is known: a detected frame, then the camera moved as a phone moves
 * in a 30th of a second, and further. The camera's focal length is the phone's first guess (0.85 x
 * the long side), so poses can be judged against the truth before any live calibration.
 */

import { loadOpenCv } from '../src/lib/vision/opencv.js';
import { BOARD_SPECS } from '../src/lib/vision/board_frame.js';
import { createLiveVision } from '../src/lib/vision/live.js';
import { rotationAngleDeg } from '../src/lib/vision/pose.js';
import { createPoseTracker, HISTORY_FRAMES, MAX_TRACKED, spreadPick } from '../src/lib/vision/tracker.js';
import { cameraPose, downscale, renderSheet } from './vision_render.js';
import { loadBuiltVision, VISION_BUILT } from './vision_test_support.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

const OPENCV_JS = new URL('../vendor/opencv/opencv.js', import.meta.url);
const cv = await loadOpenCv({ source: await Deno.readTextFile(OPENCV_JS) });
const vision = await loadBuiltVision();
const CV_TEST = { sanitizeOps: false, sanitizeResources: false, ignore: !VISION_BUILT };

const WIDTH = 800;
const HEIGHT = 600;
const SHEET = 'charuco_23x17_10mm_white_black_spiral';
const SPEC = BOARD_SPECS[SHEET];
const view = (azimuthDeg, elevationDeg = 45, distanceMm = 230) => cameraPose([80, 110, 0], {
  azimuthDeg, elevationDeg, distanceMm, rollDeg: 0, width: WIDTH, height: HEIGHT, f: 0.85 * WIDTH,
});
const frameAt = (timeMs) => ({ width: WIDTH, height: HEIGHT, timeMs });

/** A live vision (on the white/black board), refinement never scheduled; `options` as live.js's. */
const newLive = (options = {}) => createLiveVision(cv, {
  vision, frameSize: { width: WIDTH, height: HEIGHT }, schedule: () => {}, ...options,
});

const error = (pose, truth) => ({
  rotationDeg: rotationAngleDeg(pose.R, truth.R),
  centreMm: Math.hypot(...pose.center.map((c, i) => c - truth.center[i])),
});

Deno.test('spreadPick: keeps everything under the limit, else points spread over the picture', () => {
  // Setup: a 10 x 10 grid of points 10 px apart, ids in row order.
  // Test: pick 4, and pick 200.
  // Verifies: 200 keeps all 100 (in order); 4 picks the first and then the farthest each time: the
  // grid's four corners, returned in the input's order.
  const items = [];

  for (let j = 0; j < 10; j += 1) {
    for (let i = 0; i < 10; i += 1) {
      items.push({ id: 10 * j + i, x: 10 * i, y: 10 * j });
    }
  }

  assert(spreadPick(items, 200).length === 100, 'all kept');
  assert(spreadPick(items, 4).map((c) => c.id).join() === '0,9,90,99', `corners: ${spreadPick(items, 4).map((c) => c.id)}`);
});

Deno.test('trackFrame: the next frame\'s pose from tracked corners, as good as a detection', CV_TEST, () => {
  // Setup: a detected frame (the camera 230 mm away, 45 degrees up), then frames with the camera
  // orbited by 1.3 degrees (a 30th of a second at 40 degrees a second) and by 4 degrees more, each
  // tracked from the frame before, given the true pose as the "prediction" (the page sends the
  // overlay's prediction, which on a steady motion is this close).
  // Test: processFrame on the first, trackFrame on the others.
  // Verifies: the detection seeds tracking (canTrack); each tracked pose is valid, 'tracked', from
  // at least 30 corners, within 0.1 degree and 1 mm of its frame's truth (the detected pose itself
  // is within about that); its timings are reported; and tracking costs much less than detecting.
  const live = newLive();
  const truths = [view(200), view(201.3), view(205.3)];
  const images = truths.map((truth, k) => renderSheet(SPEC, truth, { noise: 1.5, seed: k + 1 }));
  const detected = live.processFrame({ image: images[0], scale: 1, frame: frameAt(0) });
  assert(detected.pose?.valid && live.canTrack, 'the detection seeds tracking');
  const e0 = error(detected.pose, truths[0]);

  for (const k of [1, 2]) {
    const result = live.trackFrame({ image: images[k], scale: 1, frame: frameAt(33 * k), predicted: { R: truths[k].R, t: truths[k].t } });
    assert(result.kind === 'track' && result.pose?.valid && result.pose.start === 'tracked', `frame ${k}: ${result.track.reason}`);
    const e = error(result.pose, truths[k]);
    console.log(`  tracked frame ${k}: ${result.track.kept} of ${result.track.tracked} corners, error ${e.rotationDeg.toFixed(3)} deg / `
      + `${e.centreMm.toFixed(2)} mm (detected ${e0.rotationDeg.toFixed(3)} / ${e0.centreMm.toFixed(2)}); track ${result.timings.trackMs.toFixed(1)} ms, `
      + `pose ${result.timings.poseMs.toFixed(1)} ms (detection ${detected.timings.detectMs.toFixed(0)} ms)`);
    assert(result.track.kept >= 30, `${result.track.kept} corners kept`);
    assert(e.rotationDeg < 0.1 && e.centreMm < 1, `frame ${k} error ${JSON.stringify(e)}`);
    assert(result.timings.totalMs < detected.timings.detectMs, 'cheaper than a detection');
  }

  live.dispose();
});

Deno.test('trackFrame at half the processing size (as the phone tracks): still within 0.15 degree and 1.5 mm', CV_TEST, () => {
  // Setup: as above, but the tracker gets a half-size copy of each frame (the page's TRACK_FACTOR:
  // the detection frame's copy as `trackImage`, the tracked frames at half size only), with the
  // detection itself at full size.
  // Test: processFrame with the half-size copy, then trackFrame on half-size frames.
  // Verifies: tracking works in the smaller frame's pixels and gives full-frame poses: valid, from
  // at least 25 corners, within 0.15 degree and 1.5 mm of the truth.
  const live = newLive();
  const truths = [view(200), view(201.3), view(205.3)];
  const images = truths.map((truth, k) => renderSheet(SPEC, truth, { noise: 1.5, seed: k + 1 }));
  live.processFrame({ image: images[0], scale: 1, frame: frameAt(0), trackImage: downscale(images[0], 2), trackScale: 0.5 });
  assert(live.canTrack, 'seeded');

  for (const k of [1, 2]) {
    const result = live.trackFrame({ image: downscale(images[k], 2), scale: 0.5, frame: frameAt(33 * k), predicted: { R: truths[k].R, t: truths[k].t } });
    assert(result.pose?.valid, `frame ${k}: ${result.track.reason}`);
    const e = error(result.pose, truths[k]);
    console.log(`  half size, tracked frame ${k}: ${result.track.kept} corners, error ${e.rotationDeg.toFixed(3)} deg / ${e.centreMm.toFixed(2)} mm`);
    assert(result.track.kept >= 25 && e.rotationDeg < 0.15 && e.centreMm < 1.5, `frame ${k}: ${JSON.stringify(e)}`);
  }

  live.dispose();
});

Deno.test('trackFrame: a prediction a square off is not followed; the corners are tracked from where they were (T-0350)', CV_TEST, () => {
  // Setup: a detected frame; the next frame with the camera hardly moved, but a "prediction" that
  // puts the board one square (10 mm) along X from where it is: what a filter still carrying an old
  // motion predicts after the phone stopped or turned back, and what a track that slipped onto the
  // neighbouring corners would agree with. Then a frame with the board slid 0.6 of a square (6 mm)
  // between the frames, and a prediction a square past that.
  // Test: trackFrame with that prediction, on each.
  // Verifies: guided by the wrong prediction the corners miss it, so (T-0350) they are tracked again
  // from their places in the previous frame with no guess; the board hardly moved, so that track is
  // taken: the pose is valid and within 0.1 degree and 1 mm of the TRUE camera, never the
  // prediction's (until T-0350 the track was refused, and the overlay coasted on the wrong
  // motion). When the board moved more than MAX_UNGUIDED_MOVE of a square, the unguided track
  // cannot be trusted either (it may have landed on the neighbouring corners): refused ('from the
  // prediction'), and tracking stops until the next detection seeds it.
  const shift = (truth) => ({ R: truth.R, t: truth.t.map((v, i) => v - 10 * truth.R[3 * i]) });
  const live = newLive();
  const a = view(200);
  const b = view(200.3);
  live.processFrame({ image: renderSheet(SPEC, a, { noise: 1.5, seed: 1 }), scale: 1, frame: frameAt(0) });
  const kept = live.trackFrame({ image: renderSheet(SPEC, b, { noise: 1.5, seed: 2 }), scale: 1, frame: frameAt(33), predicted: shift(b) });
  assert(kept.pose?.valid, `taken from the unguided track: ${kept.track.reason}`);
  const e = error(kept.pose, b);
  console.log(`  wrong prediction, small motion: ${kept.track.kept} corners, error ${e.rotationDeg.toFixed(3)} deg / ${e.centreMm.toFixed(2)} mm`);
  assert(e.rotationDeg < 0.1 && e.centreMm < 1, `the true pose: ${JSON.stringify(e)}`);

  const far = newLive();
  // The board slid 6 mm along X in the picture: t' = t - R (6, 0, 0).
  const c = { ...a, t: a.t.map((v, i) => v - 6 * a.R[3 * i]) };
  far.processFrame({ image: renderSheet(SPEC, a, { noise: 1.5, seed: 1 }), scale: 1, frame: frameAt(0) });
  const slipped = far.trackFrame({ image: renderSheet(SPEC, c, { noise: 1.5, seed: 3 }), scale: 1, frame: frameAt(33), predicted: shift(c) });
  assert(slipped.pose === null && /prediction/.test(slipped.track.reason), `refused: ${slipped.track.reason}`);
  assert(!far.canTrack, 'tracking stopped');
  live.dispose();
  far.dispose();
});

Deno.test(`trackFrame: at most ${MAX_TRACKED} frames after a detection`, CV_TEST, () => {
  // Setup: a detected frame, then the same view over and over (a phone held still).
  // Test: track MAX_TRACKED + 1 frames.
  // Verifies: the first MAX_TRACKED give valid poses; the next is refused ('tracked long enough'),
  // so whatever the detection rate, drift cannot build up past that many frames.
  const live = newLive();
  const a = view(150, 60, 200);
  const image = renderSheet(SPEC, a, { noise: 1.5, seed: 1 });
  live.processFrame({ image, scale: 1, frame: frameAt(0) });

  for (let k = 1; k <= MAX_TRACKED; k += 1) {
    const r = live.trackFrame({ image, scale: 1, frame: frameAt(33 * k), predicted: { R: a.R, t: a.t } });
    assert(r.pose?.valid, `frame ${k}: ${r.track.reason}`);
  }

  const last = live.trackFrame({ image, scale: 1, frame: frameAt(33 * (MAX_TRACKED + 1)), predicted: { R: a.R, t: a.t } });
  assert(last.pose === null && last.track.reason === 'tracked long enough', last.track.reason);
  live.dispose();
});

Deno.test('a tracker beside the detection (T-0350): a detection of an older frame seeds tracking from that frame', CV_TEST, () => {
  // Setup: the phone's two Workers in one place: a live vision that only detects (tracking: false,
  // as in vision_worker.js beside a tracker) and a tracker keeping HISTORY_FRAMES frames by time (as
  // track_worker.js keeps them). The camera orbits 1.3 degrees a frame (40 degrees a second), frames
  // at 0, 33, 66, 100 and 133 ms. Every frame is pushed to the tracker as it comes (with nothing to
  // track yet); the detection of frame 0 "finishes" only after frame 100 has been pushed, as a
  // detection that takes 100 ms does while the tracker goes on.
  // Test: seed the tracker with frame 0's detection under frame 0's time; track frame 133 (four
  // frames, 5.2 degrees, from the detected frame), then frame 166 from 133. Then a seed naming a
  // frame never pushed, and, with a tracker keeping only 2 frames, a seed naming a frame dropped and
  // one naming the latest frame (a detection that finished before the next frame came).
  // Verifies: the detection-only live vision has no tracker of its own (canTrack false); the seed is
  // taken (true, active); frame 133's pose is valid, from at least 30 corners, within 0.1 degree and
  // 1 mm of its truth, and frame 166's too (the chain goes on from the tracked frame); a seed whose
  // frame is not kept is refused (false) and leaves the tracker as it was, while one on the latest
  // frame is taken (it is tracked from once the next frame is pushed).
  const live = newLive({ tracking: false });
  const tracker = createPoseTracker(vision, SPEC, { history: HISTORY_FRAMES });
  const truths = [0, 1, 2, 3, 4, 5].map((k) => view(200 + 1.3 * k));
  const images = truths.map((truth, k) => renderSheet(SPEC, truth, { noise: 1.5, seed: k + 1 }));
  let seedPose = null;
  let seedDetection = null;
  const detected = live.processFrame({
    image: images[0], scale: 1, frame: frameAt(0), onPose: (pose, detection) => {
      seedPose = pose;
      seedDetection = detection;
    },
  });
  assert(detected.pose?.valid && !live.canTrack, 'a detection-only live vision does not track');
  assert(seedPose === detected.pose && seedDetection === detected.detection, 'the early pose comes with its detection');

  for (const k of [0, 1, 2, 3]) {
    const r = tracker.track(images[k], 1, frameAt(33.3 * k), seedPose.intrinsics, null);
    assert(r.pose === null && r.reason === 'nothing to track', `frame ${k} before the seed: ${r.reason}`);
  }

  assert(tracker.seed(seedDetection, seedPose, 1, 0) && tracker.active, 'seeded from frame 0');

  for (const k of [4, 5]) {
    const r = tracker.track(images[k], 1, frameAt(33.3 * k), seedPose.intrinsics, { R: truths[k].R, t: truths[k].t });
    assert(r.pose?.valid, `frame ${k}: ${r.reason}`);
    const e = error(r.pose, truths[k]);
    console.log(`  frame ${k} (${k === 4 ? 'from the detected frame 0' : 'from frame 4'}): ${r.kept} of ${r.tracked} corners, `
      + `error ${e.rotationDeg.toFixed(3)} deg / ${e.centreMm.toFixed(2)} mm`);
    assert(r.kept >= 30 && e.rotationDeg < 0.1 && e.centreMm < 1, `frame ${k}: ${JSON.stringify(e)}`);
  }

  assert(!tracker.seed(seedDetection, seedPose, 1, 12345) && tracker.active, 'a frame never pushed: refused, tracking goes on');

  const short = createPoseTracker(vision, SPEC, { history: 2 });

  for (const k of [0, 1, 2]) {
    short.track(images[k], 1, frameAt(33.3 * k), seedPose.intrinsics, null);
  }

  assert(!short.seed(seedDetection, seedPose, 1, 0) && !short.active, 'frame 0 dropped from a 2-frame history: refused');
  assert(short.seed(seedDetection, seedPose, 1, 33.3 * 2) && short.active, 'the latest frame: taken');
  short.dispose();
  tracker.dispose();
  live.dispose();
});
