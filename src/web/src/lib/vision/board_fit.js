// Whether the markers found in a frame are laid out as the scanner board prints them (T-0335).
//
// The phone supports one board, charuco_23x17_10mm_strip. Any ChArUco board made with the same
// marker dictionary (DICT_4X4_250) is read by the detector all the same -- each marker's id is
// read correctly -- but on another board the ids sit in other squares: an older 22-column board,
// for one, puts id k one square further along every second row than the 23-column board does.
// Taking such a board for ours, OpenCV's corner interpolation mixes up its corners (several ids on
// one pixel, ids from opposite ends of a row side by side), every pose fails its checks (the
// person was told to "hold the phone steady") and, worse, the lens estimate, which seeds from every
// recognised frame without a pose, was dragged to a focal length several times too short.
//
// THE TEST. Every marker found has a square on our board (its id's place in the layout), so the
// markers' centres, in board squares, and their centres in the picture must be related by one
// plane-to-picture homography, up to lens distortion. A robust fit tells: a homography from four
// markers at a time (deterministic, seeded samples), the one that agrees with the most markers
// refined on those, and a marker agreeing when the homography puts it within FIT_TOLERANCE of a
// square of where it was seen (the square's size measured from that marker's own corners, so near
// and far markers are judged alike). On our board nearly every marker agrees; on another board the
// markers that agree are those of one patch where the two layouts happen to coincide (the 22- and
// 23-column layouts agree, up to a shift, within each pair of rows). The verdict is 'wrong', 'fits'
// or, between them or with too few markers to say, 'unsure' (see WRONG_SHARE and FITS_SHARE).
// A frame of another board that shows only such a patch can look 'unsure', or even fit; live.js
// therefore holds a 'wrong' verdict over the next unclear frames (WRONG_BOARD_HOLD_MS). Measured on
// real footage and synthetic strip views in T-0335 (kb phone-vision-wrong-board-test).
//
// Cost: ~0.1 ms a frame on our board (the first samples explain nearly every marker and stop the
// search), ~1.5 ms on another board (every sample tried), against ~27 ms for the detection.
//
// Pure: plain numbers in, plain numbers out; no OpenCV.

import { specMarkerRatio } from './board_detect.js';

/** Markers needed before the fit is tried at all (fewer: share null, verdict 'unsure'). */
export const MIN_FIT_MARKERS = 6;

/** A marker agrees when the fit puts its centre within this many of its squares of where it was
 *  seen. Another board's misplaced markers are a whole square or more off. */
export const FIT_TOLERANCE = 0.35;

/**
 * The verdicts. 'wrong': at least WRONG_MARKERS markers and fewer than WRONG_SHARE of them agree.
 * 'fits': at least FITS_MARKERS markers and FITS_SHARE or more agree. Anything between is
 * 'unsure' (few markers, markers along a line, or a middling share), which the caller treats as
 * it treated the frames before. Measured (T-0335): our board, rendered views with up to k1 = +-0.2
 * of lens distortion, 180 views, 67-165 markers each, share 0.883-1 (0.86 in the unit test's
 * harshest view, k1 -0.2 at 180 mm and 25 degrees); the older reference board judged against its
 * own layout, 246 real frames, 0.875-1; the reference board judged against ours, 242 real frames,
 * median 0.45, 90% under 0.63, and every frame over 0.63 had 6-14 markers.
 */
export const WRONG_MARKERS = 8;
export const WRONG_SHARE = 0.6;
export const FITS_MARKERS = 15;
export const FITS_SHARE = 0.8;

/** Four-marker samples tried per frame (fewer when one already explains nearly every marker). */
export const FIT_SAMPLES = 120;

const layouts = new WeakMap();

/** Marker id -> its square's centre [column, row] + 0.5, in squares (OpenCV's board frame: x along
 *  the columns, y along the rows), for a non-legacy ChArUco layout: markers on the squares whose
 *  row + column is odd, numbered row by row. */
function markerCentres(spec) {
  if (!layouts.has(spec)) {
    const centres = [];

    for (let row = 0; row < spec.squares_y; row += 1) {
      for (let col = 0; col < spec.squares_x; col += 1) {
        if ((row + col) % 2 === 1) {
          centres.push([col + 0.5, row + 0.5]);
        }
      }
    }

    layouts.set(spec, centres);
  }

  return layouts.get(spec);
}

/** A small seeded generator (mulberry32), so the same frame always gets the same verdict. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The homography (h33 = 1, row-major 9 numbers) taking `src` [x, y] to `dst` [x, y], least squares
 * over all the pairs (exact for four), or null when the points are degenerate. Both sides are
 * shifted and scaled to unit spread first, which keeps the 8 x 8 normal equations well conditioned.
 */
export function fitHomography(src, dst) {
  const n = src.length;

  if (n < 4) {
    return null;
  }

  const norm = (points) => {
    let mx = 0;
    let my = 0;
    points.forEach(([x, y]) => {
      mx += x / n;
      my += y / n;
    });
    let spread = 0;
    points.forEach(([x, y]) => {
      spread += Math.hypot(x - mx, y - my) / n;
    });
    const s = spread > 0 ? Math.SQRT2 / spread : 1;
    return { mx, my, s };
  };

  const a = norm(src);
  const b = norm(dst);
  const N = Array.from({ length: 8 }, () => new Float64Array(9));

  for (let i = 0; i < n; i += 1) {
    const X = (src[i][0] - a.mx) * a.s;
    const Y = (src[i][1] - a.my) * a.s;
    const x = (dst[i][0] - b.mx) * b.s;
    const y = (dst[i][1] - b.my) * b.s;

    for (const [row, rhs] of [[[X, Y, 1, 0, 0, 0, -x * X, -x * Y], x], [[0, 0, 0, X, Y, 1, -y * X, -y * Y], y]]) {
      for (let r = 0; r < 8; r += 1) {
        for (let c = 0; c < 8; c += 1) {
          N[r][c] += row[r] * row[c];
        }

        N[r][8] += row[r] * rhs;
      }
    }
  }

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col += 1) {
    let pivot = col;

    for (let r = col + 1; r < 8; r += 1) {
      if (Math.abs(N[r][col]) > Math.abs(N[pivot][col])) {
        pivot = r;
      }
    }

    if (!(Math.abs(N[pivot][col]) > 1e-12)) {
      return null;
    }

    [N[col], N[pivot]] = [N[pivot], N[col]];

    for (let r = 0; r < 8; r += 1) {
      if (r !== col) {
        const f = N[r][col] / N[col][col];

        for (let c = col; c < 9; c += 1) {
          N[r][c] -= f * N[col][c];
        }
      }
    }
  }

  const h = N.map((row, i) => row[8] / row[i]);
  // Undo the normalisation: H = Tb^-1 * Hn * Ta.
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const Ta = [a.s, 0, -a.s * a.mx, 0, a.s, -a.s * a.my, 0, 0, 1];
  const TbInv = [1 / b.s, 0, b.mx, 0, 1 / b.s, b.my, 0, 0, 1];
  const H = multiply(TbInv, multiply(Hn, Ta));
  return H.every(Number.isFinite) && Math.abs(H[8]) > 1e-12 ? H.map((v) => v / H[8]) : null;
}

function multiply(A, B) {
  const out = new Array(9).fill(0);

  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      for (let k = 0; k < 3; k += 1) {
        out[3 * r + c] += A[3 * r + k] * B[3 * k + c];
      }
    }
  }

  return out;
}

/** H applied to [x, y]; null behind the horizon. */
function apply(H, [x, y]) {
  const w = H[6] * x + H[7] * y + H[8];

  if (!(Math.abs(w) > 1e-12)) {
    return null;
  }

  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Twice the signed area of a triangle. */
const area2 = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);

/**
 * How well the markers of a BoardDetection fit `spec`'s layout.
 *
 * @param {{ markers: { id: number, corners: [number, number][] }[] }} detection  in any pixels
 * @param {object} spec  a houseki.board.v1 spec
 * @param {object} [options]  { tolerance, samples } (the exported defaults)
 * @returns {{ verdict: 'fits'|'wrong'|'unsure', markers: number, agreeing: number, share: number|null }}
 *   markers: those found with a square on the board; agreeing: those the best fit explains;
 *   share: agreeing / markers (null when too few markers to fit)
 */
export function boardFit(detection, spec, options = {}) {
  const tolerance = options.tolerance ?? FIT_TOLERANCE;
  const samples = options.samples ?? FIT_SAMPLES;
  const layout = markerCentres(spec);
  const ratio = specMarkerRatio(spec);
  const board = [];
  const seen = [];
  const limit = [];

  for (const marker of detection?.markers ?? []) {
    const centre = layout[marker.id];

    if (!centre || marker.corners?.length !== 4) {
      continue;
    }

    const c = marker.corners;
    // The marker's side in the picture (the square root of its quadrilateral's area), and so its
    // square's: the unit the agreement is judged in.
    const side = Math.sqrt(Math.abs(area2(c[0], c[1], c[2]) + area2(c[0], c[2], c[3])) / 2);
    board.push(centre);
    seen.push([(c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4]);
    limit.push(tolerance * (side / ratio));
  }

  const n = board.length;

  if (n < MIN_FIT_MARKERS) {
    return { verdict: 'unsure', markers: n, agreeing: 0, share: null };
  }

  const agreeing = (H) => {
    const ins = [];

    for (let i = 0; i < n; i += 1) {
      const p = apply(H, board[i]);

      if (p && Math.hypot(p[0] - seen[i][0], p[1] - seen[i][1]) <= limit[i]) {
        ins.push(i);
      }
    }

    return ins;
  };

  const random = seeded(0x5ca1ab1e ^ n);
  let best = [];

  for (let k = 0; k < samples && best.length < 0.95 * n; k += 1) {
    const pick = new Set();

    while (pick.size < 4) {
      pick.add(Math.floor(random() * n));
    }

    const [i, j, l, m] = [...pick];
    const q = [board[i], board[j], board[l], board[m]];

    // Three of the four in a line (on the board) fix no homography.
    if (Math.min(Math.abs(area2(q[0], q[1], q[2])), Math.abs(area2(q[0], q[1], q[3])),
      Math.abs(area2(q[0], q[2], q[3])), Math.abs(area2(q[1], q[2], q[3]))) < 1) {
      continue;
    }

    const H = fitHomography(q, [seen[i], seen[j], seen[l], seen[m]]);

    if (!H) {
      continue;
    }

    const ins = agreeing(H);

    if (ins.length > best.length) {
      best = ins;
    }
  }

  // The best sample's markers, all of them, refine the fit (a sample of four is noisy).
  if (best.length >= 4) {
    const H = fitHomography(best.map((i) => board[i]), best.map((i) => seen[i]));
    const refined = H ? agreeing(H) : [];

    if (refined.length > best.length) {
      best = refined;
    }
  }

  // No sample fixed a homography: the markers lie along a line (one row of them, say), which says
  // nothing about the layout.
  if (best.length < 4) {
    return { verdict: 'unsure', markers: n, agreeing: 0, share: null };
  }

  const share = best.length / n;
  const verdict = n >= WRONG_MARKERS && share < WRONG_SHARE ? 'wrong'
    : n >= FITS_MARKERS && share >= FITS_SHARE ? 'fits' : 'unsure';
  return { verdict, markers: n, agreeing: best.length, share };
}
