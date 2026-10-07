/*
 * vision_synth.js -- synthetic camera frames of a ChArUco board with known corner positions, for
 * the board detector's tests (T-0323). Used by the Deno tests (vision_board_detect_test.js) and by
 * the browser harness (tests/harness/test_vision_detect.py loads it into a page).
 *
 * HOW A FRAME IS MADE
 *   1. boardImage(): the board as printed, from OpenCV's own CharucoBoard.generateImage, with a
 *      white paper margin, the spec's removed markers blanked and its centre target drawn (the
 *      target's cells painted white, its grey rings and its dots), at `pps` pixels per square.
 *   2. makeFrame(): that image warped by a homography into a camera frame (a perspective view of
 *      the board, given as where the chessboard's four outer corners land), rendered at twice the
 *      size and reduced with INTER_AREA so edges are anti-aliased, on a dark "table". Optional
 *      Gaussian blur (defocus) and seeded Gaussian noise (sensor noise).
 *   3. The truth: the same homography maps every chessboard corner id to the frame, in types.js's
 *      pixel convention (origin at the top-left CORNER of the top-left pixel).
 *
 * COORDINATES. "Squares" coordinates put the chessboard's top-left outer corner at (0, 0), u along
 * the columns (OpenCV x, the board frame's Y) and v down the rows (OpenCV y, the board frame's X);
 * inner corner id k sits at (k % (squares_x - 1) + 1, floor(k / (squares_x - 1)) + 1). Frame
 * coordinates are "edge" coordinates (types.js); OpenCV's warpPerspective works in pixel-centre
 * coordinates, so its matrix is T(-0.5) H T(+0.5).
 */

/** A seeded PRNG (mulberry32), so a "random" frame is the same frame on every run. */
export function seededRandom(seed) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function matMul(a, b) {
  const out = new Array(9).fill(0);

  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      for (let k = 0; k < 3; k += 1) {
        out[3 * r + c] += a[3 * r + k] * b[3 * k + c];
      }
    }
  }

  return out;
}

export function applyH(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/** The homography taking the unit square's corners (0,0),(1,0),(1,1),(0,1) to `quad`, via OpenCV. */
function homographyFrom(cv, from, to) {
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, from.flat());
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, to.flat());
  const h = cv.getPerspectiveTransform(src, dst);
  const values = Array.from(h.data64F);
  src.delete();
  dst.delete();
  h.delete();
  return values;
}

/** Marker id -> its square [row, col], for the current (non-legacy) pattern: markers sit on the
 *  white squares, (row + col) odd, numbered row-major. */
export function markerSquares(spec) {
  const squares = [];

  for (let row = 0; row < spec.squares_y; row += 1) {
    for (let col = 0; col < spec.squares_x; col += 1) {
      const black = spec.legacy && spec.squares_y % 2 === 0 ? (row + col) % 2 === 1 : (row + col) % 2 === 0;

      if (!black) {
        squares.push([row, col]);
      }
    }
  }

  return squares;
}

/**
 * The printed board as a grey image: { image (CV_8UC1, caller deletes), pps, margin } with `margin`
 * squares of white paper round the chessboard. Ink 25, paper 235.
 */
export function boardImage(cv, spec, { pps = 40, margin = 1 } = {}) {
  const ratio = spec.marker_mm && spec.square_mm ? spec.marker_mm / spec.square_mm : spec.marker_ratio;
  const dictionary = cv.getPredefinedDictionary(cv[spec.dictionary]);
  const noIds = new cv.Mat();
  const board = new cv.aruco_CharucoBoard(new cv.Size(spec.squares_x, spec.squares_y), 1, ratio, dictionary, noIds);
  board.setLegacyPattern(Boolean(spec.legacy));
  const chess = new cv.Mat();
  board.generateImage(new cv.Size(spec.squares_x * pps, spec.squares_y * pps), chess, 0, 1);
  board.delete();
  dictionary.delete();
  noIds.delete();

  const white = new cv.Scalar(255);
  const black = new cv.Scalar(0);
  const squares = markerSquares(spec);

  // Removed markers: their white square stays, the marker is not printed.
  for (const id of spec.removed_marker_ids ?? []) {
    const [row, col] = squares[id];
    cv.rectangle(chess, new cv.Point(col * pps, row * pps), new cv.Point((col + 1) * pps - 1, (row + 1) * pps - 1), white, -1);
  }

  // The centre target, as board.py's sheet maker describes it in the spec (mm, X down, Y right).
  const target = spec.target;
  const mm = pps / spec.square_mm;

  if (target && target.cells_row_col?.length) {
    const [x0, x1] = target.x_range_mm;
    const [y0, y1] = target.y_range_mm;
    cv.rectangle(chess, new cv.Point(Math.round(y0 * mm), Math.round(x0 * mm)), new cv.Point(Math.round(y1 * mm) - 1, Math.round(x1 * mm) - 1), white, -1);
    const [cxMm, cyMm] = target.centre_mm;
    const centre = new cv.Point(Math.round(cyMm * mm), Math.round(cxMm * mm));

    for (const diameter of target.rings_diameter_mm ?? []) {
      cv.circle(chess, centre, Math.round((diameter / 2) * mm), new cv.Scalar(target.ring_grey ?? 150), Math.max(1, Math.round(0.6 * mm)));
    }

    for (const [x, y] of target.dots_mm ?? []) {
      cv.circle(chess, new cv.Point(Math.round(y * mm), Math.round(x * mm)), Math.max(1, Math.round(((target.dot_diameter_mm ?? 0.6) / 2) * mm)), black, -1);
    }
  }

  const image = new cv.Mat();
  const border = margin * pps;
  cv.copyMakeBorder(chess, image, border, border, border, border, cv.BORDER_CONSTANT, white);
  chess.delete();
  // Ink and paper as a camera sees them, not pure black and white.
  image.convertTo(image, -1, (235 - 25) / 255, 25);
  return { image, pps, margin };
}

/**
 * A camera frame of `printed` (boardImage's result): { frame (CV_8UC1, caller deletes), H, truth }.
 *
 * @param {object} options
 * @param {number} options.width
 * @param {number} options.height
 * @param {[number, number][]} options.quad  where the chessboard's outer corners land in the frame
 *        (edge coordinates): top-left, top-right, bottom-right, bottom-left of the printed board
 * @param {number} [options.blur=0]  Gaussian sigma, px
 * @param {number} [options.noise=0]  Gaussian noise sigma, grey levels
 * @param {number} [options.seed=1]
 * @param {number} [options.background=70]  the table's grey
 */
export function makeFrame(cv, spec, printed, options) {
  const { width, height, quad, blur = 0, noise = 0, seed = 1, background = 70 } = options;
  const { image, pps, margin } = printed;
  const sx = spec.squares_x;
  const sy = spec.squares_y;
  // squares -> frame edge coordinates
  const H = homographyFrom(cv, [[0, 0], [sx, 0], [sx, sy], [0, sy]], quad);
  // board image edge coordinates -> squares
  const A = [1 / pps, 0, -margin, 0, 1 / pps, -margin, 0, 0, 1];
  // ... -> the double-size frame's edge coordinates, then OpenCV's pixel-centre convention
  const twice = [2, 0, 0, 0, 2, 0, 0, 0, 1];
  const toCentre = [1, 0, -0.5, 0, 1, -0.5, 0, 0, 1];
  const fromCentre = [1, 0, 0.5, 0, 1, 0.5, 0, 0, 1];
  const M = matMul(toCentre, matMul(twice, matMul(H, matMul(A, fromCentre))));
  const Mmat = cv.matFromArray(3, 3, cv.CV_64F, M);
  const big = new cv.Mat();
  cv.warpPerspective(image, big, Mmat, new cv.Size(2 * width, 2 * height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(background));
  Mmat.delete();
  const frame = new cv.Mat();
  cv.resize(big, frame, new cv.Size(width, height), 0, 0, cv.INTER_AREA);
  big.delete();

  if (blur > 0) {
    cv.GaussianBlur(frame, frame, new cv.Size(0, 0), blur, blur, cv.BORDER_REPLICATE);
  }

  if (noise > 0) {
    const random = seededRandom(seed);
    const data = frame.data;

    for (let i = 0; i < data.length; i += 1) {
      // Box-Muller
      const g = Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
      data[i] = Math.min(255, Math.max(0, Math.round(data[i] + noise * g)));
    }
  }

  const perRow = sx - 1;
  const truth = (id) => applyH(H, (id % perRow) + 1, Math.floor(id / perRow) + 1);
  return { frame, H, truth };
}

/** Errors (px) of detected corners against the truth: { ids, errors, median, p95, max }. */
export function cornerErrors(detection, truth) {
  const errors = detection.corners.map(({ id, x, y }) => {
    const [tx, ty] = truth(id);
    return Math.hypot(x - tx, y - ty);
  });
  const sorted = [...errors].sort((a, b) => a - b);
  const at = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))] : NaN);
  return { ids: detection.corners.map((c) => c.id), errors, median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? NaN };
}

/** The corner ids of `spec` whose true position lies inside the frame by at least `inset` px. */
export function visibleIds(spec, truth, width, height, inset) {
  const ids = [];
  const n = (spec.squares_x - 1) * (spec.squares_y - 1);

  for (let id = 0; id < n; id += 1) {
    const [x, y] = truth(id);

    if (x >= inset && y >= inset && x <= width - inset && y <= height - inset) {
      ids.push(id);
    }
  }

  return ids;
}
