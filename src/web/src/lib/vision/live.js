// The phone's vision on live frames (T-0326, the integration step of T-0322): one frame in, the
// board, the camera's pose and the camera's intrinsics out.
//
// It joins the pieces built separately, through types.js's hand-offs:
//
//   frame --board_detect.js--> BoardDetection --pose.js--> CameraPose
//                                    |                         |
//                                    +--intrinsics.js (live K)-+
//
// and holds what they need between frames: the live intrinsics, the tracker's corners. The rock's
// outline (outline.js) was taken out of the phone on 2026-10-14 (T-0350; the user: "we can remove
// the gemstone detection itself"): ~15 ms every few frames that delayed the poses behind it. The
// pose drawn over the picture is filtered and carried forward by the page itself (vision/
// pose_filter.js, T-0332), at the time of each frame it shows. It has no DOM and no clock of its own:
// the phone page
// (src/web/scanner/vision.js) decides which frames to run and passes them in, so the same code
// runs in a Worker unchanged (everything here takes plain image data).
//
// FRAMES. `image` is an RGBA copy of the camera frame at `scale` x its size (the page draws the
// video into a canvas at the processing size: cheaper to read back than the whole frame). Board
// detection runs on it at scale 1 and its corners are scaled back to the frame's own pixels, so
// everything after detection -- poses, intrinsics, messages -- is in full-frame pixels (types.js's
// convention), whatever the processing size. The guidance's focus measure reads the frame itself
// from `source` (the <video> or the frame's bitmap), at full resolution.
//
// THE BOARDS (T-0340). The scanner has three printed boards, one per kind of rough, of one layout
// (board_frame.js). The detector reads all three and names the one in view; the geometry (pose,
// lens, tracking, guidance) is the same for each. The board named last is the result's
// `sheet.name`.
// Markers from the older boards (DICT_4X4_250 ids 0-249) are not read at all.

import { BOARD_LIST, BOARD_NAME, BOARD_SPEC, BOARD_SPECS, boardSizeMm } from './board_frame.js';
import { createBoardDetector } from './board_detect.js';
import { renderBoardTexture } from './board_texture.js';
import { createIntrinsicsEstimator, guessIntrinsics } from './intrinsics.js';
import { createPoseSolver } from './pose.js';
import { createPoseTracker } from './tracker.js';
import { detectionRegion, REGION_FULL_EVERY_MS, REGION_POSE_MAX_AGE_MS } from './region.js';
import { scaleIntrinsics } from './camera_model.js';
import { createScanGuide } from './guidance.js';
import { createFocusMeter } from './focus.js';

/**
 * @param {any} cv  OpenCV (vision/opencv.js loadOpenCv), for the pose and the intrinsics
 * @param {object} options
 * @param {any} options.vision  the vision module (vision/vision_wasm.js loadVision), which finds
 *        the board (T-0330)
 * @param {{ width: number, height: number }} options.frameSize  the camera frame's size
 * @param {object} [options.camera]  intrinsics.describeCamera(track)
 * @param {object} [options.device]  intrinsics.describeDevice()
 * @param {boolean} [options.tracking]  false: no tracker here (T-0350: the tracker has a Worker of
 *        its own, scanner/track_worker.js)
 * @param {(fn: Function) => void} [options.schedule]  intrinsics refinement's scheduler
 */
export function createLiveVision(cv, options) {
  const spec = BOARD_SPEC;
  // The phone's fast detection path (T-0332; board_detect.js FAST_PATH) and a region round the rock
  // (region.js), unless asked for the exact one (`fastDetection: false`).
  const fastDetection = options.fastDetection ?? true;
  const detector = createBoardDetector(options.vision, spec, { processingScale: 1, fast: fastDetection, boards: BOARD_LIST });
  const intrinsics = createIntrinsicsEstimator(cv, spec, options.frameSize, {
    camera: options.camera ?? null,
    device: options.device ?? null,
    ...(options.schedule ? { schedule: options.schedule } : {}),
  });
  // `poseMaxRmsPx`: for the harness only (T-0335 follow-up), a residual limit tighter than any pose
  // meets, so it can see what the phone shows of a board whose every pose fails.
  const solver = createPoseSolver(cv, spec, options.poseMaxRmsPx ? { maxRmsPx: options.poseMaxRmsPx } : {});
  // The board in view: the name the last detection with markers gave (BOARD_NAME before any).
  let boardName = BOARD_NAME;
  // The board's pose between detections, from tracked corners (T-0332, tracker.js); every processed
  // frame is pushed to it. Off (null) when the vision module has no tracker (an older build).
  const canTrack = typeof options.vision?.FrameTracker === 'function' && options.tracking !== false;
  const tracker = canTrack ? createPoseTracker(options.vision, spec) : null;
  // The region searched (T-0332, region.js): the latest valid pose (detected or tracked), when the
  // whole frame was last searched, and whether the last search found a valid pose.
  let latestPose = null;
  let lastFullAt = -Infinity;
  let lastFound = false;
  let disposed = false;
  // The scan guidance (T-0331, guidance.js): the rock's position, the camera's angle around it,
  // coverage, and the per-frame conditions behind the phone's warnings, with the focus at the rock
  // read from the full-resolution frame (focus.js). Without the outline (T-0350) the rock is taken
  // to be at the board's target. Its result is the frame's `guide`.
  const targetMm = (spec.target?.centre_mm ?? [0, 0]).slice(0, 2);
  const scanGuide = createScanGuide({ targetMm, sizeMm: boardSizeMm(spec) });
  const focusMeter = createFocusMeter();

  /**
   * The region of this frame to search (region.js), or null for the whole frame: whole when it is
   * due (REGION_FULL_EVERY_MS), when the last search found no valid pose, or when no pose for this
   * frame is known (`predicted`, the page's, else the latest within REGION_POSE_MAX_AGE_MS).
   */
  function regionFor(frame, predicted) {
    if (!lastFound || frame.timeMs - lastFullAt >= REGION_FULL_EVERY_MS) {
      return null;
    }

    const pose = predicted ?? (latestPose && frame.timeMs - latestPose.frame.timeMs <= REGION_POSE_MAX_AGE_MS ? latestPose : null);
    let K = intrinsics.current();

    if (!pose || !K) {
      return null;
    }

    if (K.width !== frame.width || K.height !== frame.height) {
      K = scaleIntrinsics(K, frame);

      if (!K) {
        return null;
      }
    }

    const rock = scanGuide.rock?.point ?? [...targetMm, 0];
    return detectionRegion(pose, K, rock, frame);
  }

  /** The board as the message and the overlay describe it (the vision message's `board.sheet`,
   *  `targetMm` and `sizeMm`), for the board in view. */
  const sheets = Object.fromEntries(BOARD_LIST.map((board) => [board.name, Object.freeze({ name: board.name, targetMm, sizeMm: boardSizeMm(board) })]));
  const sheetNow = () => sheets[boardName] ?? sheets[BOARD_NAME];

  /**
   * Runs one frame.
   *
   * @param {object} input
   * @param {{ data, width, height }} input.image  RGBA at `scale` x the frame
   * @param {number} input.scale  image pixels per frame pixel (<= 1)
   * @param {{ width: number, height: number, timeMs: number }} input.frame
   * @param {TexImageSource|null} [input.source]  the full frame, for the focus measure at the rock
   * @param {{ data, width, height }|null} [input.trackImage]  the frame at the tracker's (smaller)
   *        size, `trackScale` x the frame (T-0332); without it the tracker uses `image`
   * @param {{ R, t }|null} [input.predicted]  the overlay's predicted pose for this frame (T-0332):
   *        where the board's region is looked for
   * @param {(pose: object, detection: object) => void} [input.onPose]  called with the frame's pose
   *        (a CameraPose, valid or not) and its detection (full-frame px) as soon as the pose is
   *        solved, before the lens and the guidance (T-0340): the overlay and the tracker need only
   *        these, so they can use them that much sooner
   * @returns {object} { frame, detection, pose, intrinsics, calibration, sheet (the board in view),
   *          guide (guidance.js createScanGuide's observe), region (frame px, or null: the whole
   *          frame), timings }
   */
  function processFrame({ image, scale, frame, source = null, trackImage = null, trackScale = null, predicted = null, onPose = null }) {
    if (disposed) {
      throw new Error('live vision used after dispose()');
    }

    const t0 = performance.now();
    // The region to search (T-0332, region.js), from the pose expected for this frame: the page's
    // prediction, else the latest pose if recent. The whole frame when one is due, when the last
    // search found no pose, or when no region helps.
    const region = fastDetection ? regionFor(frame, predicted) : null;
    const roi = region ? { x: region.x * scale, y: region.y * scale, width: region.width * scale, height: region.height * scale } : null;
    const raw = detector.detect(image, { width: image.width, height: image.height, timeMs: frame.timeMs }, { roi });
    // The tracker keeps every processed frame (the next tracked frame starts from this one), at its
    // own size: `trackImage`, or the processing image itself.
    const tp = performance.now();
    const trackIn = trackImage ?? image;
    const trackK = trackImage ? trackScale : scale;
    tracker?.push(trackIn);
    const pushMs = performance.now() - tp;
    const k = 1 / scale;
    const detection = {
      ...raw,
      frame: { width: frame.width, height: frame.height, timeMs: frame.timeMs },
      corners: raw.corners.map((c) => ({ ...c, x: c.x * k, y: c.y * k })),
      markers: raw.markers.map((m) => ({ id: m.id, corners: m.corners.map(([x, y]) => [x * k, y * k]) })),
      markerPx: raw.markerPx === null ? null : raw.markerPx * k,
    };
    const t1 = performance.now();

    // The board in view (T-0340), kept over frames that find no marker.
    if (detection.board && BOARD_SPECS[detection.board]) {
      boardName = detection.board;
    }

    const tf = performance.now();
    const K = intrinsics.current();
    const pose = detection.recognised ? solver.solve(detection, K) : null;
    const t2 = performance.now();

    if (pose && onPose) {
      onPose(pose, detection);
    }

    const tp2 = performance.now();

    // Every detection feeds the lens's calibration, a region's too: with detections spaced out
    // while tracking and most of them regions, whole frames alone gathered its views several times
    // slower (an end-to-end run read "1 of 30 views" after 30 s). The whole frame each second still
    // brings corners from the picture's edges, where the distortion shows.
    intrinsics.addDetection(detection, pose?.valid ? pose : null);

    if (!region) {
      lastFullAt = frame.timeMs;
    }

    lastFound = Boolean(pose?.valid);

    if (pose?.valid) {
      latestPose = pose;
    }

    const t3 = performance.now();

    // This frame's inlier corners are the ones to track into the next (none without a valid pose).
    tracker?.seed(detection, pose?.valid ? pose : null, trackK);

    const t5 = performance.now();
    const guide = scanGuide.observe({
      frame: detection.frame,
      pose: pose?.valid ? pose : null,
      targetMm,
      measure: (box, rockContour) => focusMeter.measure(source, image, scale, box, detection.frame, rockContour),
    });
    const t6 = performance.now();

    return {
      frame: detection.frame,
      detection,
      pose,
      intrinsics: intrinsics.current(),
      calibration: intrinsics.status(),
      sheet: sheetNow(),
      guide,
      kind: 'detect',
      // The region searched (frame px), or null for the whole frame (T-0332).
      region,
      timings: {
        detectMs: t1 - t0 - pushMs,
        pushMs,
        fitMs: tf - t1,
        poseMs: t2 - tf,
        intrinsicsMs: t3 - tp2,
        seedMs: t5 - t3,
        guideMs: t6 - t5,
        totalMs: t6 - t0,
      },
    };
  }

  /**
   * A frame between detections (T-0332): the last pose's corners tracked into it, and the pose
   * re-solved from them (tracker.js). No detection or guidance: only the pose, for the
   * overlay.
   *
   * @param {object} input  as processFrame's, plus `predicted`: the overlay's predicted pose for
   *        this frame ({ R, t }), which guides the tracking and checks it
   * @returns {object} { kind: 'track', frame, pose (a CameraPose with start 'tracked', or null),
   *          sheet, track: { tracked, kept, reason }, timings: { trackMs, poseMs, totalMs } }
   */
  function trackFrame({ image, scale, frame, predicted = null }) {
    if (disposed) {
      throw new Error('live vision used after dispose()');
    }

    const t0 = performance.now();
    const out = tracker
      ? tracker.track(image, scale, frame, intrinsics.current(), predicted)
      : { pose: null, reason: 'no tracker', tracked: 0, kept: 0, trackMs: 0, poseMs: 0 };

    if (out.pose?.valid) {
      latestPose = out.pose;
    }
    return {
      kind: 'track',
      frame: { width: frame.width, height: frame.height, timeMs: frame.timeMs },
      pose: out.pose,
      sheet: sheetNow(),
      track: { tracked: out.tracked, kept: out.kept, reason: out.reason },
      timings: { trackMs: out.trackMs, poseMs: out.poseMs, totalMs: performance.now() - t0 },
    };
  }

  /**
   * Runs every code path once on a synthetic, flat view of the board, so the browser compiles
   * them before the first real frame: the first runs of each path
   * stall for 0.1-3 s (kb phone-camera-pose-and-live-intrinsics). `pause()` is awaited between the
   * steps, so the page stays responsive. Nothing here touches the live state.
   */
  async function warmUp(pause = () => new Promise((resolve) => setTimeout(resolve, 0))) {
    const texture = renderBoardTexture(spec, { ppm: 3 });
    const rgba = new Uint8ClampedArray(texture.width * texture.height * 4);

    for (let i = 0; i < texture.data.length; i += 1) {
      rgba[4 * i] = texture.data[i];
      rgba[4 * i + 1] = texture.data[i];
      rgba[4 * i + 2] = texture.data[i];
      rgba[4 * i + 3] = 255;
    }

    const image = { data: rgba, width: texture.width, height: texture.height };
    const size = { width: texture.width, height: texture.height };
    const warmDetector = createBoardDetector(options.vision, spec, { processingScale: 1 });
    const warmSolver = createPoseSolver(cv, spec);
    const warmIntrinsics = createIntrinsicsEstimator(cv, spec, size, { schedule: () => {} });
    const K = guessIntrinsics(size);

    try {
      for (let round = 0; round < 3; round += 1) {
        const detection = warmDetector.detect(image, { ...size, timeMs: round * 300 });
        await pause();
        const pose = detection.recognised ? warmSolver.solve(detection, K) : null;
        warmIntrinsics.addDetection(detection, null);
        await pause();

        // The tracking path too (T-0332): the same view tracked into itself.
        if (pose?.valid && canTrack && round === 2) {
          const warmTracker = createPoseTracker(options.vision, spec);

          try {
            warmTracker.push(image);
            warmTracker.seed(detection, pose, 1);
            warmTracker.track(image, 1, { ...size, timeMs: 900 }, K, pose);
          } finally {
            warmTracker.dispose();
          }

          await pause();
        }
      }
    } finally {
      warmDetector.dispose();
      warmSolver.dispose();
      warmIntrinsics.dispose();
    }
  }

  return {
    processFrame,
    trackFrame,
    /** Whether a frame could be tracked now (a recent valid pose's corners are held). */
    get canTrack() {
      return Boolean(tracker?.active);
    },
    warmUp,
    get sheet() {
      return sheetNow();
    },
    /** A change of camera (zoom, lens, resolution): intrinsics.setCamera. */
    setCamera(camera, device) {
      intrinsics.setCamera(camera, device);
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      detector.dispose();
      intrinsics.dispose();
      solver.dispose();
      tracker?.dispose();
    },
  };
}
