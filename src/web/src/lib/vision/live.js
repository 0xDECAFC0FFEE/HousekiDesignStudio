// The phone's vision on live frames (T-0326, the integration step of T-0322): one frame in, the
// board, the camera's pose, the camera's intrinsics and (every few frames) the rock's outline out.
//
// It joins the three pieces built separately, through types.js's hand-offs:
//
//   frame --board_detect.js--> BoardDetection --pose.js--> CameraPose --outline.js--> RockOutline
//                                    |                         |
//                                    +--intrinsics.js (live K)-+   board_pick.js (which sheet)
//
// and holds what they need between frames: the live intrinsics, the sheet picker, the last outline
// (with the pose of the frame it was found on, so the page can carry it along with the board). The
// pose drawn over the picture is filtered and carried forward by the page itself (vision/
// pose_filter.js, T-0332), at the time of each frame it shows. It has no DOM and no clock of its own:
// the phone page
// (src/web/scanner/vision.js) decides which frames to run and passes them in, so the same code
// can later run in a Worker unchanged (everything here takes plain image data, and the outline a
// WebGL2 context on any canvas, OffscreenCanvas included).
//
// FRAMES. `image` is an RGBA copy of the camera frame at `scale` x its size (the page draws the
// video into a canvas at the processing size: cheaper to read back than the whole frame). Board
// detection runs on it at scale 1 and its corners are scaled back to the frame's own pixels, so
// everything after detection -- poses, intrinsics, outlines, messages -- is in full-frame pixels
// (types.js's convention), whatever the processing size. The outline reads the frame itself from
// `source` (the <video>), at full resolution, on the GPU.
//
// THE SHEET. Detection uses a spec that removes nothing (board_pick.detectionSpec), so the markers
// only some sheets print are seen; each frame is then cut down to what the current sheet prints
// (filterDetection) before its pose. Until the picker decides, the current sheet is
// board_pick.DEFAULT_SHEET; a change of sheet restarts the outline finder (whose predicted board is
// drawn from the sheet).

import { BOARD_SPECS, boardSizeMm } from './board_frame.js';
import { createBoardDetector } from './board_detect.js';
import { createBoardPicker, DEFAULT_SHEET, detectionSpec, filterDetection } from './board_pick.js';
import { renderBoardTexture } from './board_texture.js';
import { createIntrinsicsEstimator, guessIntrinsics } from './intrinsics.js';
import { createOutlineFinder } from './outline.js';
import { createPoseSolver } from './pose.js';
import { createPoseTracker } from './tracker.js';
import { detectionRegion, REGION_FULL_EVERY_MS, REGION_POSE_MAX_AGE_MS } from './region.js';
import { scaleIntrinsics } from './camera_model.js';
import { createScanGuide } from './guidance.js';
import { createFocusMeter } from './focus.js';

/** An outline older than this (ms of frame time) is not drawn or sent. */
export const OUTLINE_MAX_AGE_MS = 1000;

/**
 * @param {any} cv  OpenCV (vision/opencv.js loadOpenCv), for the pose and the intrinsics
 * @param {object} options
 * @param {any} options.vision  the vision module (vision/vision_wasm.js loadVision), which finds
 *        the board (T-0330)
 * @param {{ width: number, height: number }} options.frameSize  the camera frame's size
 * @param {object} [options.camera]  intrinsics.describeCamera(track)
 * @param {object} [options.device]  intrinsics.describeDevice()
 * @param {string|null} [options.sheet]  a sheet the person chose (BOARD_SPECS name), or null
 * @param {HTMLCanvasElement|OffscreenCanvas|null} [options.glCanvas]  where the outline's WebGL2
 *        context lives (it is not drawn to); null: no outline
 * @param {object} [options.outline]  outline.js options (e.g. { cropSize: 256 })
 * @param {(fn: Function) => void} [options.schedule]  intrinsics refinement's scheduler
 */
export function createLiveVision(cv, options) {
  const generic = detectionSpec(BOARD_SPECS[DEFAULT_SHEET]);
  // The phone's fast detection path (T-0332; board_detect.js FAST_PATH) and a region round the rock
  // (region.js), unless asked for the exact one (`fastDetection: false`).
  const fastDetection = options.fastDetection ?? true;
  const detector = createBoardDetector(options.vision, generic, { processingScale: 1, fast: fastDetection });
  const picker = createBoardPicker({ chosen: options.sheet ?? null });
  const intrinsics = createIntrinsicsEstimator(cv, generic, options.frameSize, {
    camera: options.camera ?? null,
    device: options.device ?? null,
    ...(options.schedule ? { schedule: options.schedule } : {}),
  });
  const solvers = new Map();
  let sheet = picker.current();
  let finder = null;
  let finderSheet = null;
  let finderFailed = null;
  let lastOutline = null;
  // The pose of the frame the last outline was found on: { R, t, intrinsics }.
  let lastOutlinePose = null;
  // The board's pose between detections, from tracked corners (T-0332, tracker.js); every processed
  // frame is pushed to it. Off (null) when the vision module has no tracker (an older build).
  const canTrack = typeof options.vision?.FrameTracker === 'function' && options.tracking !== false;
  let tracker = canTrack ? createPoseTracker(options.vision, sheet.spec) : null;
  // The region searched (T-0332, region.js): the latest valid pose (detected or tracked), when the
  // whole frame was last searched, and whether the last search found a valid pose.
  let latestPose = null;
  let lastFullAt = -Infinity;
  let lastFound = false;
  let outlineSearched = false;
  let disposed = false;
  // The scan guidance (T-0331, guidance.js): the rock's position, the camera's angle around it,
  // coverage, and the per-frame conditions behind the phone's warnings, with the focus and glare at
  // the rock read from the full-resolution frame (focus.js). Its result is the frame's `guide`.
  const scanGuide = createScanGuide({ targetMm: (sheet.spec.target?.centre_mm ?? [0, 0]).slice(0, 2), sizeMm: boardSizeMm(sheet.spec) });
  const focusMeter = createFocusMeter();

  const solverFor = (name) => {
    if (!solvers.has(name)) {
      solvers.set(name, createPoseSolver(cv, BOARD_SPECS[name]));
    }

    return solvers.get(name);
  };

  function sheetChanged(next) {
    if (next.name === sheet.name) {
      sheet = next;
      return;
    }

    sheet = next;
    lastOutline = null;
    lastOutlinePose = null;
    outlineSearched = false;

    if (tracker) {
      tracker.dispose();
      tracker = createPoseTracker(options.vision, sheet.spec);
    }
  }

  function outlineFinder() {
    if (!options.glCanvas || finderFailed) {
      return null;
    }

    if (finder && finderSheet === sheet.name) {
      return finder;
    }

    finder?.dispose();
    finder = null;

    try {
      finder = createOutlineFinder(options.glCanvas, sheet.spec, options.outline ?? {});
      finderSheet = sheet.name;
    } catch (error) {
      // No WebGL2 or no half-float targets: the board and pose still work.
      finderFailed = String(error?.message ?? error);
    }

    return finder;
  }

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

    const rock = scanGuide.rock?.point ?? [...(sheet.spec.target?.centre_mm ?? [0, 0]).slice(0, 2), 0];
    return detectionRegion(pose, K, rock, frame);
  }

  /** The sheet as the message and the overlay describe it. */
  const sheetInfo = () => ({
    name: sheet.name,
    from: sheet.from,
    label: sheet.name,
    targetMm: (sheet.spec.target?.centre_mm ?? [0, 0]).slice(0, 2),
    sizeMm: boardSizeMm(sheet.spec),
  });

  /**
   * Runs one frame.
   *
   * @param {object} input
   * @param {{ data, width, height }} input.image  RGBA at `scale` x the frame
   * @param {number} input.scale  image pixels per frame pixel (<= 1)
   * @param {{ width: number, height: number, timeMs: number }} input.frame
   * @param {TexImageSource|null} [input.source]  the full frame, for the outline (and the focus
   *        measure at the rock)
   * @param {boolean} [input.outline]  look for the rock's outline in this frame
   * @param {{ data, width, height }|null} [input.trackImage]  the frame at the tracker's (smaller)
   *        size, `trackScale` x the frame (T-0332); without it the tracker uses `image`
   * @param {{ R, t }|null} [input.predicted]  the overlay's predicted pose for this frame (T-0332):
   *        where the board's region is looked for
   * @returns {object} { frame, detection, pose, intrinsics, calibration, outline, outlinePose (the
   *          pose of the outline's own frame: { R, t, intrinsics }), outlineFresh, sheet, guide
   *          (guidance.js createScanGuide's observe), region (frame px, or null: the whole frame),
   *          timings }
   */
  function processFrame({ image, scale, frame, source = null, outline: wantOutline = false, trackImage = null, trackScale = null, predicted = null }) {
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
    const all = {
      ...raw,
      frame: { width: frame.width, height: frame.height, timeMs: frame.timeMs },
      corners: raw.corners.map((c) => ({ ...c, x: c.x * k, y: c.y * k })),
      markers: raw.markers.map((m) => ({ id: m.id, corners: m.corners.map(([x, y]) => [x * k, y * k]) })),
      markerPx: raw.markerPx === null ? null : raw.markerPx * k,
    };
    const t1 = performance.now();

    const detection = filterDetection(all, sheet.spec);
    const K = intrinsics.current();
    const pose = detection.recognised ? solverFor(sheet.name).solve(detection, K) : null;
    const t2 = performance.now();

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

    let outlineFresh = false;

    if (wantOutline && pose?.valid && source) {
      const found = outlineFinder();

      if (found) {
        lastOutline = found.find(source, pose);
        lastOutlinePose = { R: pose.R, t: pose.t, intrinsics: pose.intrinsics };
        outlineSearched = true;
        outlineFresh = true;
      }
    }

    const t4 = performance.now();

    const next = picker.observe({
      detection: all,
      pose: pose?.valid ? pose : null,
      image,
      scale,
      rock: lastOutline?.contour?.length ? lastOutline.contour : null,
      rockKnown: outlineSearched,
    });
    const trackerBefore = tracker;
    sheetChanged(next);

    // This frame's inlier corners are the ones to track into the next (not after a change of
    // sheet: the new tracker has no frame yet).
    if (tracker && tracker === trackerBefore) {
      tracker.seed(detection, pose?.valid ? pose : null, trackK);
    }

    const t5 = performance.now();
    const outlineAge = lastOutline ? frame.timeMs - lastOutline.frame.timeMs : Infinity;
    const info = sheetInfo();
    const guide = scanGuide.observe({
      frame: all.frame,
      pose: pose?.valid ? pose : null,
      outline: outlineFresh ? lastOutline : null,
      sheet: info.name,
      targetMm: info.targetMm,
      measure: (box, rockContour) => focusMeter.measure(source, image, scale, box, all.frame, rockContour),
    });
    const t6 = performance.now();

    const outlineShown = outlineAge <= OUTLINE_MAX_AGE_MS ? lastOutline : null;
    return {
      frame: all.frame,
      detection,
      pose,
      intrinsics: intrinsics.current(),
      calibration: intrinsics.status(),
      outline: outlineShown,
      outlinePose: outlineShown ? lastOutlinePose : null,
      outlineFresh,
      outlineError: finderFailed,
      sheet: info,
      guide,
      kind: 'detect',
      // The region searched (frame px), or null for the whole frame (T-0332).
      region,
      timings: {
        detectMs: t1 - t0 - pushMs,
        pushMs,
        poseMs: t2 - t1,
        intrinsicsMs: t3 - t2,
        outlineMs: outlineFresh ? t4 - t3 : null,
        pickMs: t5 - t4,
        guideMs: t6 - t5,
        totalMs: t6 - t0,
      },
    };
  }

  /**
   * A frame between detections (T-0332): the last pose's corners tracked into it, and the pose
   * re-solved from them (tracker.js). No detection, outline, sheet picking or guidance: only the
   * pose, for the overlay.
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
      sheet: sheetInfo(),
      track: { tracked: out.tracked, kept: out.kept, reason: out.reason },
      timings: { trackMs: out.trackMs, poseMs: out.poseMs, totalMs: performance.now() - t0 },
    };
  }

  /**
   * Runs every code path once on a synthetic, flat view of the board, so the browser compiles
   * them (and the outline's shaders) before the first real frame: the first runs of each path
   * stall for 0.1-3 s (kb phone-camera-pose-and-live-intrinsics). `pause()` is awaited between the
   * steps, so the page stays responsive. Nothing here touches the live state.
   */
  async function warmUp(pause = () => new Promise((resolve) => setTimeout(resolve, 0))) {
    const texture = renderBoardTexture(generic, { ppm: 3 });
    const rgba = new Uint8ClampedArray(texture.width * texture.height * 4);

    for (let i = 0; i < texture.data.length; i += 1) {
      rgba[4 * i] = texture.data[i];
      rgba[4 * i + 1] = texture.data[i];
      rgba[4 * i + 2] = texture.data[i];
      rgba[4 * i + 3] = 255;
    }

    const image = { data: rgba, width: texture.width, height: texture.height };
    const size = { width: texture.width, height: texture.height };
    const warmDetector = createBoardDetector(options.vision, generic, { processingScale: 1 });
    const warmSolver = createPoseSolver(cv, sheet.spec);
    const warmIntrinsics = createIntrinsicsEstimator(cv, generic, size, { schedule: () => {} });
    const K = guessIntrinsics(size);

    try {
      for (let round = 0; round < 3; round += 1) {
        const detection = filterDetection(warmDetector.detect(image, { ...size, timeMs: round * 300 }), sheet.spec);
        await pause();
        const pose = detection.recognised ? warmSolver.solve(detection, K) : null;
        warmIntrinsics.addDetection(detection, null);
        await pause();

        if (pose && round === 0) {
          const found = outlineFinder();

          if (found) {
            found.find(image, { ...pose, valid: true });
            await pause();
          }
        }

        // The tracking path too (T-0332): the same view tracked into itself.
        if (pose?.valid && canTrack && round === 2) {
          const warmTracker = createPoseTracker(options.vision, sheet.spec);

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
    /** The person's choice of sheet (a BOARD_SPECS name), or null to recognise it. */
    chooseSheet(name) {
      sheetChanged(picker.choose(name));
      return sheetInfo();
    },
    get sheet() {
      return sheetInfo();
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
      solvers.forEach((solver) => solver.dispose());
      finder?.dispose();
      tracker?.dispose();
    },
  };
}
