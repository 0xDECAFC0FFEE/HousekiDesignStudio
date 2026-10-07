// ChArUco board detection on the phone: one camera frame in, a BoardDetection out (types.js).
// Since T-0330 the work is done by the Rust vision module (src/vision, compiled to WebAssembly and
// loaded by ./vision_wasm.js); until then it was opencv.js (T-0323), whose version is kept as
// ./board_detect_opencv.js, the reference the tests compare this one against.
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
// What runs where: the wasm module does each frame's work (thresholds, markers, the board-guided
// refinement, the corners and their sub-pixel refinement, sharpness, the blurred corners'
// re-refinement; src/vision/board.rs). This file keeps the state between frames -- the
// marker-size factor m, measured from the markers with some hysteresis, and the fallbacks walked
// when frames find nothing -- and turns the module's numbers into a BoardDetection.
//
// THE BOARD. The module supports the current (non-legacy) ChArUco pattern with DICT_4X4_250
// markers, which is every board the scanner prints (./boards/); its columns, rows and marker ratio
// are parameters (the real-frame test fixtures use an older 22 x 22 board).
//
// INPUT. `source` is an ImageData (canvas getImageData, RGBA), or anything shaped like one:
// { data, width, height } with 4 bytes per pixel (RGBA) or 1 (grey).
//
// OUTPUT COORDINATES are types.js's: full-resolution frame pixels with the origin at the top-left
// CORNER of the top-left pixel. The module works in OpenCV's convention, pixel CENTRES at whole
// numbers, so every point is the module's + 0.5 (then divided by the processing scale). A consumer
// handing these back to OpenCV-style code (solvePnP with cx = width / 2, say) must subtract the 0.5
// again, or use cx = width / 2 - 0.5 ... in OpenCV's convention, the image centre is
// ((width - 1) / 2, (height - 1) / 2).
//
// PROCESSING SCALE. options.processingScale < 1 detects on a copy downscaled by that factor
// (INTER_AREA) and scales the results back: fewer pixels, faster, at some cost in sub-pixel
// accuracy. Every pixel-tuned constant then follows the downscaled copy, as the desktop pipeline's
// do for a smaller video.
//
// MEMORY. The module's detector keeps its buffers between frames; dispose() frees it.

import { cornerCount, cornerPoint } from './board_frame.js';

/** Marker widths (px) the desktop detector's parameters were tuned on (board.py TUNED_MARKER_PX). */
export const TUNED_MARKER_PX = [60, 300];

/** Short side (px) of the frames the desktop pipeline's pixel constants were tuned at (camera.py). */
export const REF_SHORT_SIDE = 1080;

/**
 * The fast path's parts (T-0332), as measured in tests/harness/test_vision_detect.py on synthetic
 * strip-board frames at the phone's 960 x 540 (markers 11-47 px, blur 0-2 px) and the real fixture
 * frames, each against the truth (or the desktop's corners):
 *   localRefine  the missed-marker search scaled to each marker: KEPT. As many corners or more
 *                (2182 vs 2134 synthetic, 76 of 76 real) at the same accuracy; natively 22.6 -> 17.7
 *                ms on a whole-board 960 x 540 view (the refinement read 233-373 rejected candidates
 *                there, now 10-19);
 *   retryClose   OpenCV's second reading of a failed candidate's near-duplicates: KEPT (false would
 *                save ~2 ms but lost corners on blurred views: 33 -> 6 on a far view at 1.2 px blur,
 *                some misread, and 76 -> 71 of the real frames' corners);
 *   windows      fewer adaptive-threshold windows (null: the desktop's 6-7): NOT TAKEN (3 or 4 saved
 *                ~4-6 ms but lost most corners under a 2 px blur: 144 -> 5 or 71 on the whole board).
 */
export const FAST_PATH = Object.freeze({ retryClose: true, localRefine: true, windows: null });

/** Laplacian variance (25 x 25 px, at the reference scale) below which a corner counts as blurred
 *  (calibrate.py MIN_CORNER_SHARPNESS). */
export const MIN_CORNER_SHARPNESS = 50;

/** Corners needed for a pose (calibrate.py MIN_POSE_CORNERS), and so for `recognised`. */
export const MIN_RECOGNISED_CORNERS = 8;

// The marker-size factors tried, in turn, when frames stop finding any marker: the tuned
// parameters, the resolution's guess (s), small markers, large ones. board.py's
// probe_marker_scale tries the same ones when its first pass finds too few markers.
export const FALLBACK_SCALES = [1, null, 0.3, 2.5];
// Consecutive frames without a marker before the next fallback is tried.
export const MISSES_BEFORE_FALLBACK = 2;
// The marker-size factor is re-tuned when the measured one differs from the one in use by more
// than this ratio (re-tuning every frame would make the parameters jitter with the marker size).
export const RETUNE_RATIO = 1.1;

/** s = short side / 1080 (camera.py pixel_scale): 1 at 1080p, 0.667 at 720p. */
export function pixelScale(width, height) {
  return Math.min(width, height) / REF_SHORT_SIDE;
}

/**
 * The detector's marker-size factor for markers `markerPx` wide (board.py marker_scale): 1 inside
 * TUNED_MARKER_PX, else markerPx over the band's nearer edge (continuous at the edges).
 */
export function markerScale(markerPx) {
  if (!(markerPx > 0) || !Number.isFinite(markerPx)) {
    return 1;
  }

  const [lo, hi] = TUNED_MARKER_PX;

  if (markerPx >= lo && markerPx <= hi) {
    return 1;
  }

  return markerPx / (markerPx < lo ? lo : hi);
}

/** Python's round() (half to even), so the scaled windows are exactly board.py's. */
export function pyRound(value) {
  const floor = Math.floor(value);
  const diff = value - floor;

  if (Math.abs(diff - 0.5) < 1e-12) {
    return floor % 2 === 0 ? floor : floor + 1;
  }

  return Math.round(value);
}

/**
 * The ArUco DetectorParameters fields the desktop detector sets, for marker-size factor m
 * (board.py detector_params). Plain numbers, so they can be tested on their own.
 *
 * - adaptive thresholding windows 3..93 px in steps of 15: marker borders are 15-30 px thick in
 *   the reference videos, wider than the default 23 px window (+6% frames with >= 8 corners);
 * - bits read from the middle 40% of each cell (8 px per cell, 30% margin each side): defocus
 *   bleeds white bits into black ones and DICT_4X4 corrects no bit error;
 * - for m != 1 the windows scale with the marker size; for small markers so does the minimum
 *   perimeter (otherwise markers under ~15 px in a 1920 px frame are all lost).
 */
export function detectorParamValues(m = 1, { windows = null } = {}) {
  const exact = m === 1;
  const values = {
    adaptiveThreshWinSizeMin: 3,
    adaptiveThreshWinSizeMax: exact ? 93 : Math.max(23, pyRound(93 * m)),
    adaptiveThreshWinSizeStep: exact ? 15 : Math.max(4, pyRound(15 * m)),
    perspectiveRemovePixelPerCell: 8,
    perspectiveRemoveIgnoredMarginPerCell: 0.3,
  };

  // The phone's fast path (T-0332): `windows` windows spread over the same range (3 .. max)
  // instead of the desktop's 6-7 (ArUco adds windows min + k step while they stay <= max).
  if (windows !== null && windows >= 2) {
    values.adaptiveThreshWinSizeStep = Math.ceil((values.adaptiveThreshWinSizeMax - 3) / (windows - 1));
  }

  if (m < 1) {
    values.minMarkerPerimeterRate = 0.03 * m;
  }

  return values;
}

/**
 * RefineParameters for marker-size factor m (board.py make_detector): a missed marker is looked
 * for within 40 px of where its neighbours put it (OpenCV's default 10 px is too tight for
 * 150-300 px markers under strong perspective: +4-8% frames with >= 8 corners), scaled with m.
 */
export function refineParamValues(m = 1) {
  return { minRepDistance: m === 1 ? 40 : 40 * m, errorCorrectionRate: 3, checkAllOrders: true };
}

/**
 * Whether board points (in squares) span a plane rather than a line (calibrate.py _spans_plane):
 * the second singular value of the centred points over sqrt(n) above half a square.
 *
 * @param {[number, number][]} points
 */
export function spansPlane(points) {
  const n = points.length;

  if (n < 4) {
    return false;
  }

  let mx = 0;
  let my = 0;

  for (const [x, y] of points) {
    mx += x;
    my += y;
  }

  mx /= n;
  my /= n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;

  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }

  // Singular values of the centred n x 2 matrix are the square roots of the eigenvalues of its
  // 2 x 2 scatter matrix; the smaller one is the second singular value.
  const half = (sxx + syy) / 2;
  const root = Math.sqrt(Math.max(0, half * half - (sxx * syy - sxy * sxy)));
  const smaller = Math.max(0, half - root);
  return Math.sqrt(smaller) / Math.sqrt(n) > 0.5;
}

/** The marker side as a fraction of the square, from a board spec. */
export function specMarkerRatio(spec) {
  return spec.marker_mm && spec.square_mm ? spec.marker_mm / spec.square_mm : spec.marker_ratio;
}

/** A frame's pixels: { data, width, height } with 1 or 4 bytes per pixel, checked. */
function framePixels(source) {
  const { data, width, height } = source ?? {};

  if (!data || !(width > 0) || !(height > 0)) {
    throw new Error('a frame must be an ImageData-like { data, width, height }');
  }

  const channels = data.length / (width * height);

  if (channels !== 1 && channels !== 4) {
    throw new Error(`image data must be RGBA or grey, got ${channels} bytes per pixel`);
  }

  return { data, width, height };
}

/**
 * A board detector for one board spec (houseki.board.v1, see ./boards/).
 *
 * @param {any} vision  the vision module, from vision_wasm.js loadVision()
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
 *        re-refined corner by (+0.5, +0.5) px (KB article opencv-js-for-the-phone-scanner-build-
 *        charuco-po)
 * @param {boolean} [options.tryRefineMarkers=true]  look for missed markers where the found ones
 *        predict them (OpenCV's tryRefineMarkers, which the desktop runs)
 * @param {boolean|object} [options.fast=false]  the phone's fast path (T-0332, FAST_PATH), which
 *        gives up exact agreement with opencv.js (and the desktop) for speed; measured no worse
 *        against the truth (tests/harness/test_vision_detect.py). Off by default, so the exact
 *        comparisons keep the exact path. An object { retryClose, localRefine, windows } sets the
 *        parts one by one, for measuring them
 * @param {number} [options.fastWindows]  with fast: true, the window count (FAST_PATH's otherwise)
 * @returns {{ detect(source: any, frameInfo?: object, how?: { roi }): object, dispose(): void,
 *             readonly markerScale: number }}
 *   detect's `roi` ({ x, y, width, height } in the source's pixels): look only there (the fast
 *   path's region around the board, T-0332); the results are still in the whole frame's pixels.
 */
export function createBoardDetector(vision, spec, options = {}) {
  const processingScale = options.processingScale ?? 1;
  const fixedScale = typeof options.markerScale === 'number' ? options.markerScale : null;
  const singleMarkerCorners = options.singleMarkerCorners ?? true;
  const refineBlurred = options.refineBlurred ?? true;
  const halfPixelShift = options.desktopHalfPixelShift ?? false;
  // `fast`: true for the fast path's chosen parts, or { retryClose, localRefine, windows } to set
  // each (for measuring them; a missing part is OpenCV's).
  const parts = options.fast === true
    ? { ...FAST_PATH, windows: options.fastWindows ?? FAST_PATH.windows }
    : options.fast && typeof options.fast === 'object'
      ? { retryClose: true, localRefine: false, windows: null, ...options.fast }
      : null;

  if (!(processingScale > 0 && processingScale <= 1)) {
    throw new Error(`processingScale must be in (0, 1], got ${processingScale}`);
  }

  if (spec.dictionary !== 'DICT_4X4_250') {
    throw new Error(`the phone's detector reads DICT_4X4_250 boards only, not ${spec.dictionary}`);
  }

  if (spec.legacy && spec.squares_y % 2 === 0) {
    throw new Error('the legacy ChArUco pattern (even row count) is not supported');
  }

  const perRow = spec.squares_x - 1;
  const detector = new vision.CharucoDetector(spec.squares_x, spec.squares_y, specMarkerRatio(spec));
  detector.set_removed(Uint32Array.from(spec.removed_marker_ids ?? []));
  detector.set_try_refine(options.tryRefineMarkers ?? true);

  if (parts) {
    detector.set_fast_parts(parts.retryClose, parts.localRefine);
  }

  let scaleInUse = null;

  function configure(m) {
    if (m === scaleInUse) {
      return;
    }

    const values = detectorParamValues(m, { windows: parts?.windows ?? null });
    const refine = refineParamValues(m);
    detector.configure(values.adaptiveThreshWinSizeMax, values.adaptiveThreshWinSizeStep,
      values.minMarkerPerimeterRate ?? 0.03, refine.minRepDistance);
    scaleInUse = m;
  }

  let misses = 0;
  let fallback = 0;
  let measuredScale = 1;
  let disposed = false;

  configure(fixedScale ?? 1);

  function detect(source, frameInfo, { roi = null } = {}) {
    if (disposed) {
      throw new Error('this board detector has been disposed');
    }

    const started = performance.now();
    const { data, width, height } = framePixels(source);
    const frame = {
      width: frameInfo?.width ?? width,
      height: frameInfo?.height ?? height,
      timeMs: frameInfo?.timeMs ?? started,
    };

    // The work image's size, for the resolution's guess among the fallbacks (as the module will
    // make it: Math.round of the scaled size).
    const workW = processingScale < 1 ? Math.max(1, Math.round(width * processingScale)) : width;
    const workH = processingScale < 1 ? Math.max(1, Math.round(height * processingScale)) : height;
    const s = pixelScale(workW, workH);

    if (fixedScale === null) {
      const candidate = FALLBACK_SCALES[fallback] ?? s;
      configure(fallback === 0 ? measuredScale : candidate);
    }

    const m = scaleInUse;
    // The largest blurred-corner window: 40 px at the tuned marker sizes, x m above them (detect.py).
    const maxHalf = m <= 1 ? 40 : pyRound(40 * m);

    // The region, in work pixels (whole pixels, grown outwards); none when it covers everything.
    if (roi) {
      const x0 = Math.max(0, Math.floor(roi.x * (workW / width)));
      const y0 = Math.max(0, Math.floor(roi.y * (workH / height)));
      const x1 = Math.min(workW, Math.ceil((roi.x + roi.width) * (workW / width)));
      const y1 = Math.min(workH, Math.ceil((roi.y + roi.height) * (workH / height)));

      if (x1 > x0 && y1 > y0) {
        detector.set_roi(x0, y0, x1 - x0, y1 - y0);
      }
    }

    const out = detector.detect(data, width, height, processingScale, singleMarkerCorners, refineBlurred, halfPixelShift, maxHalf);

    // [workW, workH, anyMarker, markerPx, markerCount, (id, 8 coords)..., cornerCount,
    //  (id, x, y, markers, sharpness)...] (src/vision/lib.rs CharucoDetector::detect)
    const sx = width / out[0];
    const sy = height / out[1];
    const toOut = (x, y) => [(x + 0.5) * sx, (y + 0.5) * sy];

    if (!out[2]) {
      // A region that missed is not a frame that missed: the caller looks at the whole frame next.
      misses += roi ? 0 : 1;

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
    let k = 4;
    const markerCount = out[k++];

    if (markerCount === 0) {
      // Only markers the sheet does not print were found.
      return emptyDetection(frame, started);
    }

    const markerPx = out[3];
    const markers = [];

    for (let i = 0; i < markerCount; i += 1) {
      const id = out[k];
      const corners = [0, 1, 2, 3].map((j) => toOut(out[k + 1 + 2 * j], out[k + 2 + 2 * j]));
      markers.push({ id, corners });
      k += 9;
    }

    // The marker size in work pixels sets the next frame's parameters (board.py marker_scale,
    // measured per capture there; per frame here, with some hysteresis).
    if (fixedScale === null && markerCount >= 3) {
      const next = markerScale(markerPx);

      if (next === 1 || measuredScale === 1 || Math.max(next / measuredScale, measuredScale / next) > RETUNE_RATIO) {
        measuredScale = next;
      }

      fallback = 0;
    }

    // Only corners board_frame accepts: an id the centre target makes invalid is not a
    // chessboard corner on the print, whatever was interpolated there.
    const cornerTotal = out[k++];
    const corners = [];
    const valid = cornerCount(spec);

    for (let i = 0; i < cornerTotal; i += 1, k += 5) {
      const id = out[k];

      if (id < valid && cornerPoint(spec, id)) {
        const [x, y] = toOut(out[k + 1], out[k + 2]);
        const corner = { id, x, y, markers: out[k + 3] };

        if (!Number.isNaN(out[k + 4])) {
          corner.sharpness = out[k + 4];
        }

        corners.push(corner);
      }
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
      // Whether only a region was searched (T-0332), and the module's candidate counts (lib.rs
      // last_stats: raw, grouped, identification reads, refinement reads), for the diagnostics.
      region: Boolean(roi),
      stats: Array.from(detector.last_stats()),
    };
  }

  function emptyDetection(frame, started) {
    return { frame, markers: [], corners: [], recognised: false, elapsedMs: performance.now() - started, markerPx: null, markerScale: scaleInUse };
  }

  function dispose() {
    if (!disposed) {
      disposed = true;
      detector.free();
    }
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
