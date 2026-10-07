// The opencv.js ChArUco detector (T-0323): one camera frame in, a BoardDetection out (types.js),
// with OpenCV (opencv.js, loaded by ./opencv.js) doing the work. The phone ran it until T-0330,
// when ./board_detect.js moved the work to the Rust vision module (src/vision); it stays as the
// REFERENCE that the new detector's accuracy and speed are measured against
// (src/web/tests/vision_board_detect_test.js, tests/harness/test_vision_detect.py). The phone page
// no longer loads it.
//
// It is a port of the desktop scanner pipeline's detector (HousekiScanner, read-only reference):
// the same tuned parameters, the same two passes and the same re-refinement of blurred corners,
// so a frame the desktop pipeline reads well, the phone reads the same way. Where each choice
// comes from is noted at the place it is made:
//
//   board.py   detector_params, marker_scale, make_detector (the tuned parameters and why)
//   detect.py  detect_all (two passes, minMarkers 2 then 1) and refine_blurred
//   calibrate.py corner_sharpness (Laplacian variance), MIN_CORNER_SHARPNESS, _spans_plane
//   camera.py  pixel_scale (s = short side / 1080)
//
// and, in that project's kb/: charuco-detection-traps-on-blurred-2x-zoom-close (the measurements
// behind each parameter) and pixel-constants-follow-the-frame-s-short-side-4k.
//
// INPUT. `source` is one of (frame_input.js)
//   - an ImageData (canvas getImageData, RGBA), or anything shaped like one: { data, width,
//     height } with 4 bytes per pixel (RGBA) or 1 (grey);
//   - a cv.Mat of type CV_8UC1 (grey, used as it is), CV_8UC4 (RGBA) or CV_8UC3 (RGB).
// The caller keeps ownership of a Mat it passes in. A grey Mat is cheapest: no copy at all.
//
// OUTPUT COORDINATES are types.js's: full-resolution frame pixels with the origin at the top-left
// CORNER of the top-left pixel. OpenCV puts pixel CENTRES at whole numbers, so every point is
// OpenCV's + 0.5 (then divided by the processing scale). A consumer handing these back to OpenCV
// (solvePnP with cx = width / 2, say) must subtract the 0.5 again, or use cx = width / 2 - 0.5 ...
// in OpenCV's convention, the image centre is ((width - 1) / 2, (height - 1) / 2).
//
// PROCESSING SCALE. options.processingScale < 1 detects on a copy downscaled by that factor
// (INTER_AREA) and scales the results back: fewer pixels, faster, at some cost in sub-pixel
// accuracy (the test harness measures both). Every pixel-tuned constant then follows the
// downscaled copy, as the desktop pipeline's do for a smaller video.
//
// MEMORY. opencv.js Mats live in the wasm heap and are only freed by .delete(). The detector
// allocates its working Mats once (again only when the frame size changes) and frees every
// temporary it makes; dispose() frees the rest. The harness checks the heap does not grow over
// hundreds of frames.

import { cornerCount, cornerPoint } from './board_frame.js';
import { createGreyInput } from './frame_input.js';
// The tuned constants and the rules around them are shared with the phone's detector (T-0330).
import {
  detectorParamValues,
  FALLBACK_SCALES,
  markerScale,
  MIN_CORNER_SHARPNESS,
  MIN_RECOGNISED_CORNERS,
  MISSES_BEFORE_FALLBACK,
  pixelScale,
  pyRound,
  refineParamValues,
  RETUNE_RATIO,
  spansPlane,
} from './board_detect.js';

/**
 * A board detector for one board spec (houseki.board.v1, see ./boards/).
 *
 * @param {any} cv  OpenCV, from loadOpenCv()
 * @param {object} spec  the board's spec
 * @param {object} [options]
 * @param {number} [options.processingScale=1]  detect on a copy downscaled by this (0 < s <= 1)
 * @param {number|'auto'} [options.markerScale='auto']  board.py's marker-size factor m: 'auto'
 *        measures it from the markers found (and walks the fallbacks when nothing is found), a
 *        number fixes it
 * @param {boolean} [options.singleMarkerCorners=true]  also return corners next to only one
 *        detected marker (detect.py's second pass), tagged `markers: 1`
 * @param {boolean} [options.refineBlurred=true]  re-refine blurred corners in a window of 1/8
 *        square (detect.py refine_blurred)
 * @param {boolean} [options.desktopHalfPixelShift=false]  reproduce detect.py refine_blurred's
 *        half-pixel shift around cornerSubPix exactly; off by default because it moves every
 *        re-refined corner by (+0.5, +0.5) px: OpenCV's cornerSubPix works in OpenCV's own
 *        pixel convention already (measured against synthetic truth and on real frames; KB
 *        article opencv-js-for-the-phone-scanner-build-charuco-po)
 * @returns {{ detect(source: any, frameInfo?: object): object, dispose(): void,
 *             readonly markerScale: number }}
 */
export function createBoardDetector(cv, spec, options = {}) {
  const processingScale = options.processingScale ?? 1;
  const fixedScale = typeof options.markerScale === 'number' ? options.markerScale : null;
  const singleMarkerCorners = options.singleMarkerCorners ?? true;
  const refineBlurred = options.refineBlurred ?? true;
  const halfPixelShift = options.desktopHalfPixelShift ?? false;

  if (!(processingScale > 0 && processingScale <= 1)) {
    throw new Error(`processingScale must be in (0, 1], got ${processingScale}`);
  }

  const dictionaryId = cv[spec.dictionary];

  if (typeof dictionaryId !== 'number') {
    throw new Error(`this OpenCV has no dictionary ${spec.dictionary}`);
  }

  const perRow = spec.squares_x - 1;
  const removed = new Set(spec.removed_marker_ids ?? []);
  const markerRatio = spec.marker_mm && spec.square_mm ? spec.marker_mm / spec.square_mm : spec.marker_ratio;

  // --- OpenCV objects, made once (board.py make_board / make_detector) ---------------------------
  const dictionary = cv.getPredefinedDictionary(dictionaryId);
  const noIds = new cv.Mat();
  // Square length 1: the detector works in squares, like board.py; only ratios matter here.
  const board = new cv.aruco_CharucoBoard(new cv.Size(spec.squares_x, spec.squares_y), 1, markerRatio, dictionary, noIds);
  board.setLegacyPattern(Boolean(spec.legacy));

  const detectorParams = new cv.aruco_DetectorParameters();
  const charuco2 = new cv.aruco_CharucoParameters();
  const charuco1 = new cv.aruco_CharucoParameters();

  for (const [params, minMarkers] of [[charuco2, 2], [charuco1, 1]]) {
    // tryRefineMarkers: re-find markers the first pass missed, from the board's layout.
    // checkMarkers OFF: OpenCV's board-consistency check drops EVERY corner of a frame when it
    // fails (quartz t = 99 s: 26 good markers, 0 corners; 32 without the check). Wrong markers
    // are left to the pose's outlier pruning. (board.py make_detector)
    params.tryRefineMarkers = options.tryRefineMarkers ?? true;
    params.checkMarkers = false;
    // How many of a corner's two neighbouring markers must be detected: 2 (OpenCV's default) for
    // the first pass, 1 for the second (detect.py: more than doubles the corners per frame, but
    // they are less reliable, so they are tagged).
    params.minMarkers = minMarkers;
  }

  let refineParams = null;
  let detector2 = null;
  let detector1 = null;
  let scaleInUse = null;

  function configure(m) {
    if (m === scaleInUse) {
      return;
    }

    const values = detectorParamValues(m);
    // Back to OpenCV's defaults first, so a field set for one m (minMarkerPerimeterRate) does not
    // stay for the next.
    detectorParams.minMarkerPerimeterRate = 0.03;

    for (const [key, value] of Object.entries(values)) {
      detectorParams[key] = value;
    }

    const refine = refineParamValues(m);
    refineParams?.delete();
    refineParams = new cv.aruco_RefineParameters(refine.minRepDistance, refine.errorCorrectionRate, refine.checkAllOrders);

    detector2?.delete();
    detector1?.delete();
    detector2 = new cv.aruco_CharucoDetector(board, charuco2, detectorParams, refineParams);
    detector1 = new cv.aruco_CharucoDetector(board, charuco1, detectorParams, refineParams);
    scaleInUse = m;
  }

  // --- working Mats, reused across frames ---------------------------------------------------------
  const input = createGreyInput(cv);   // full-resolution grey from whatever the caller passes
  let small = null;         // the downscaled copy (processingScale < 1)
  // (The detector's own outputs are fresh Mats each frame, in detect(): OpenCV's detectBoard
  // leaves its outputs UNTOUCHED when it finds no marker, and treats non-empty marker inputs as
  // markers already found, so reused ones would carry the previous frame over.)
  const resampled = new cv.Mat();
  const laplacian = new cv.Mat();
  const mean = new cv.Mat();
  const stddev = new cv.Mat();
  const criteria = new cv.TermCriteria(cv.TermCriteria_EPS + cv.TermCriteria_MAX_ITER, 100, 0.001);

  let misses = 0;
  let fallback = 0;
  let measuredScale = 1;
  let disposed = false;

  configure(fixedScale ?? 1);

  // Laplacian variance in the 25 x 25 px window around each corner, measured at the reference
  // pixel scale (calibrate.py corner_sharpness): the measure goes roughly as s^-4, so for s != 1
  // the window is resampled to s = 1 first, where MIN_CORNER_SHARPNESS was tuned. The desktop
  // resamples the whole frame; here only a small window around each corner is, which is the same
  // away from the frame's edge and much cheaper.
  function cornerSharpness(work, xs, ys, s) {
    const half = 12;
    const out = new Float64Array(xs.length);
    const pad = Math.ceil((half + 2) * s) + 1;

    for (let k = 0; k < xs.length; k += 1) {
      const cx = Math.round(xs[k]);
      const cy = Math.round(ys[k]);
      const x0 = Math.max(0, cx - pad);
      const y0 = Math.max(0, cy - pad);
      const x1 = Math.min(work.cols, cx + pad + 1);
      const y1 = Math.min(work.rows, cy + pad + 1);
      const roi = work.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
      let rx = cx - x0;
      let ry = cy - y0;
      let source = roi;

      if (s !== 1) {
        const w = Math.max(1, pyRound((x1 - x0) / s));
        const h = Math.max(1, pyRound((y1 - y0) / s));
        cv.resize(roi, resampled, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
        source = resampled;
        rx = Math.round(xs[k] / s) - Math.round(x0 / s);
        ry = Math.round(ys[k] / s) - Math.round(y0 / s);
      }

      cv.Laplacian(source, laplacian, cv.CV_32F);
      const wx0 = Math.max(0, rx - half);
      const wy0 = Math.max(0, ry - half);
      const wx1 = Math.min(laplacian.cols, rx + half + 1);
      const wy1 = Math.min(laplacian.rows, ry + half + 1);

      if (wx1 > wx0 && wy1 > wy0) {
        const window = laplacian.roi(new cv.Rect(wx0, wy0, wx1 - wx0, wy1 - wy0));
        cv.meanStdDev(window, mean, stddev);
        out[k] = stddev.data64F[0] ** 2;
        window.delete();
      }

      roi.delete();
    }

    return out;
  }

  // detect.py refine_blurred: re-refine blurred corners in a window of 1/8 of the local square
  // size (3 px .. maxHalf), measured through a homography from the frame's own corners. OpenCV's
  // ChArUco refinement uses at most 21 x 21 px, which on a defocused 2x-zoom corner sees only a
  // smooth ramp; 1/8 square stays inside the white gap between the corner and the markers.
  // Measured on the reference videos: median error of corners with sharpness 25-50 from 1.25 to
  // 0.87 px (moissanite) and 3.1 to 1.25 px (quartz). Sharp corners keep OpenCV's refinement
  // (the wide window is slightly worse there, 0.35 -> 0.43 px).
  function refineBlurredCorners(work, ids, xs, ys, blurred, maxHalf) {
    const n = ids.length;

    if (!blurred.some(Boolean) || n < 4) {
      return;
    }

    const boardPts = cv.matFromArray(n, 1, cv.CV_32FC2, ids.flatMap((id) => [(id % perRow) + 1, Math.floor(id / perRow) + 1]));
    const imagePts = cv.matFromArray(n, 1, cv.CV_32FC2, Array.from(xs, (x, k) => [x, ys[k]]).flat());
    // RANSAC threshold 5 px, as detect.py (not scaled there either).
    const H = cv.findHomography(boardPts, imagePts, cv.RANSAC, 5.0);
    boardPts.delete();
    imagePts.delete();

    if (H.empty()) {
      H.delete();
      return;
    }

    const h = Array.from(H.data64F);
    H.delete();
    const map = (x, y) => {
      const w = h[6] * x + h[7] * y + h[8];
      return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
    };

    // Window half-widths, grouped so that each distinct window is one cornerSubPix call.
    const groups = new Map();

    for (let k = 0; k < n; k += 1) {
      if (!blurred[k]) {
        continue;
      }

      const bx = (ids[k] % perRow) + 1;
      const by = Math.floor(ids[k] / perRow) + 1;
      const a = map(bx, by);
      const b1 = map(bx + 1, by);
      const b2 = map(bx, by + 1);
      const squarePx = Math.min(Math.hypot(b1[0] - a[0], b1[1] - a[1]), Math.hypot(b2[0] - a[0], b2[1] - a[1]));
      const half = Math.min(maxHalf, Math.max(3, pyRound(squarePx / 8)));
      const x = xs[k];
      const y = ys[k];

      // cornerSubPix raises when its window would leave the image: skip those (detect.py).
      if (!(x >= half + 1 && x < work.cols - half - 1 && y >= half + 1 && y < work.rows - half - 1)) {
        continue;
      }

      if (!groups.has(half)) {
        groups.set(half, []);
      }

      groups.get(half).push(k);
    }

    const shift = halfPixelShift ? 0.5 : 0;

    for (const [half, members] of groups) {
      const pts = cv.matFromArray(members.length, 1, cv.CV_32FC2, members.flatMap((k) => [xs[k] - shift, ys[k] - shift]));
      cv.cornerSubPix(work, pts, new cv.Size(half, half), new cv.Size(-1, -1), criteria);
      const refined = pts.data32F;

      members.forEach((k, j) => {
        xs[k] = refined[2 * j] + shift;
        ys[k] = refined[2 * j + 1] + shift;
      });

      pts.delete();
    }
  }

  function medianMarkerSide(markerCorners) {
    const sides = [];

    for (let i = 0; i < markerCorners.size(); i += 1) {
      const m = markerCorners.get(i);
      const p = m.data32F;
      let sum = 0;

      for (let c = 0; c < 4; c += 1) {
        const d = (c + 1) % 4;
        sum += Math.hypot(p[2 * d] - p[2 * c], p[2 * d + 1] - p[2 * c + 1]);
      }

      sides.push(sum / 4);
      m.delete();
    }

    sides.sort((a, b) => a - b);
    const mid = sides.length >> 1;
    return sides.length % 2 ? sides[mid] : (sides[mid - 1] + sides[mid]) / 2;
  }

  function detect(source, frameInfo) {
    if (disposed) {
      throw new Error('this board detector has been disposed');
    }

    const started = performance.now();
    const full = input.grey(source);
    const width = full.cols;
    const height = full.rows;
    const frame = {
      width: frameInfo?.width ?? width,
      height: frameInfo?.height ?? height,
      timeMs: frameInfo?.timeMs ?? started,
    };

    let work = full;

    if (processingScale < 1) {
      small ??= new cv.Mat();
      const w = Math.max(1, Math.round(width * processingScale));
      const h = Math.max(1, Math.round(height * processingScale));
      cv.resize(full, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
      work = small;
    }

    // Work pixels -> output pixels (types.js: corner origin, full resolution).
    const sx = width / work.cols;
    const sy = height / work.rows;
    const toOut = (x, y) => [(x + 0.5) * sx, (y + 0.5) * sy];
    const s = pixelScale(work.cols, work.rows);

    if (fixedScale === null) {
      const candidate = FALLBACK_SCALES[fallback] ?? s;
      configure(fallback === 0 ? measuredScale : candidate);
    }

    const m = scaleInUse;
    // This frame's Mats, all freed in `finally`.
    const temporaries = [];
    const fresh = (object) => {
      temporaries.push(object);
      return object;
    };
    const markerCorners = fresh(new cv.MatVector());
    const markerIds = fresh(new cv.Mat());
    const corners2 = fresh(new cv.Mat());
    const ids2 = fresh(new cv.Mat());

    try {
      // Pass 1: markers (with OpenCV's board-guided refinement) and the corners next to two of
      // them (detect.py: det.detectBoard).
      detector2.detectBoard(work, corners2, ids2, markerCorners, markerIds);
      let found = markerIds.rows;

      if (found === 0) {
        misses += 1;

        if (fixedScale === null && misses >= MISSES_BEFORE_FALLBACK) {
          misses = 0;
          fallback = (fallback + 1) % FALLBACK_SCALES.length;
          // The resolution's guess duplicates the tuned parameters at s = 1; skip it there.
          if (FALLBACK_SCALES[fallback] === null && s === 1) {
            fallback = (fallback + 1) % FALLBACK_SCALES.length;
          }
        }

        return emptyDetection(frame, started);
      }

      misses = 0;

      // Markers the board does not print (the centre target's: removed_marker_ids) can only be
      // false detections (or OpenCV's refinement "finding" them in the target's pattern). Drop
      // them, and redo the first pass's corners from the rest.
      let ids = Array.from(markerIds.data32S);
      let kept = markerCorners;
      let keptIds = markerIds;

      if (ids.some((id) => removed.has(id))) {
        kept = fresh(new cv.MatVector());
        ids = ids.filter((id, i) => {
          if (removed.has(id)) {
            return false;
          }

          const corners = markerCorners.get(i);
          kept.push_back(corners);
          corners.delete();
          return true;
        });
        found = ids.length;

        if (found === 0) {
          return emptyDetection(frame, started);
        }

        keptIds = fresh(cv.matFromArray(found, 1, cv.CV_32SC1, ids));
        detector2.detectBoard(work, corners2, ids2, kept, keptIds);
      }

      // The marker size in work pixels sets the next frame's parameters (board.py marker_scale,
      // measured per capture there; per frame here, with some hysteresis).
      const markerPx = medianMarkerSide(kept);

      if (fixedScale === null && found >= 3) {
        const next = markerScale(markerPx);

        if (next === 1 || measuredScale === 1 || Math.max(next / measuredScale, measuredScale / next) > RETUNE_RATIO) {
          measuredScale = next;
        }

        fallback = 0;
      }

      // Pass 2: the same markers again, now also keeping corners next to only one detected
      // marker (detect.py: det1.detectBoard(g, markerCorners=mc, markerIds=mi)).
      const twoMarker = new Set(ids2.rows ? Array.from(ids2.data32S) : []);
      let cornerIds;
      let cornerXY;

      if (singleMarkerCorners) {
        const corners1 = fresh(new cv.Mat());
        const ids1 = fresh(new cv.Mat());
        detector1.detectBoard(work, corners1, ids1, kept, keptIds);
        cornerIds = ids1.rows ? Array.from(ids1.data32S) : [];
        cornerXY = ids1.rows ? corners1.data32F : new Float32Array(0);
      } else {
        cornerIds = ids2.rows ? Array.from(ids2.data32S) : [];
        cornerXY = ids2.rows ? corners2.data32F : new Float32Array(0);
      }

      const xs = Float64Array.from(cornerIds, (_, k) => cornerXY[2 * k]);
      const ys = Float64Array.from(cornerIds, (_, k) => cornerXY[2 * k + 1]);
      let sharpness = null;

      if (refineBlurred && cornerIds.length) {
        sharpness = cornerSharpness(work, xs, ys, s);
        const blurred = Array.from(sharpness, (v) => v < MIN_CORNER_SHARPNESS);
        // The largest window: 40 px at the tuned marker sizes, x m above them (detect.py).
        const maxHalf = m <= 1 ? 40 : pyRound(40 * m);
        refineBlurredCorners(work, cornerIds, xs, ys, blurred, maxHalf);
      }

      // Only corners board_frame accepts: an id the centre target makes invalid is not a
      // chessboard corner on the print, whatever OpenCV interpolated there.
      const corners = [];

      cornerIds.forEach((id, k) => {
        if (id < cornerCount(spec) && cornerPoint(spec, id)) {
          const [x, y] = toOut(xs[k], ys[k]);
          const corner = { id, x, y, markers: twoMarker.has(id) ? 2 : 1 };

          if (sharpness) {
            corner.sharpness = sharpness[k];
          }

          corners.push(corner);
        }
      });

      const markers = [];

      for (let i = 0; i < kept.size(); i += 1) {
        const c = kept.get(i);
        const p = c.data32F;
        markers.push({ id: ids[i], corners: [0, 1, 2, 3].map((j) => toOut(p[2 * j], p[2 * j + 1])) });
        c.delete();
      }

      const boardPoints = corners.map(({ id }) => [(id % perRow) + 1, Math.floor(id / perRow) + 1]);

      return {
        frame,
        markers,
        corners,
        recognised: corners.length >= MIN_RECOGNISED_CORNERS && spansPlane(boardPoints),
        elapsedMs: performance.now() - started,
        markerPx: markerPx * (sx + sy) / 2,
        markerScale: m,
      };
    } finally {
      for (const object of temporaries) {
        object.delete();
      }
    }
  }

  function emptyDetection(frame, started) {
    return { frame, markers: [], corners: [], recognised: false, elapsedMs: performance.now() - started, markerPx: null, markerScale: scaleInUse };
  }

  function dispose() {
    if (disposed) {
      return;
    }

    disposed = true;

    for (const object of [
      detector2, detector1, refineParams, detectorParams, charuco2, charuco1, board, noIds,
      dictionary, small, resampled, laplacian, mean, stddev,
    ]) {
      object?.delete();
    }

    input.dispose();
  }

  return {
    detect,
    dispose,
    /** The marker-size factor (board.py's m) the next frame will be detected with. */
    get markerScale() {
      return scaleInUse;
    },
  };
}
