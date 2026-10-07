// The printed board's appearance, drawn from its spec (T-0325): what the camera would see of the
// bare sheet, as an albedo texture the rock outline (outline.js) predicts each frame from.
//
// It is the phone's port of the HousekiScanner project's board texture (src/houseki/pipeline/
// boardtex.py) and of its board maker (houseki.tools.make_board), drawn without OpenCV:
//
// - the chessboard in OpenCV's current ChArUco pattern (`legacy: false`): square (row 0, col 0) is
//   black, so a square is black when row + col is even, and the white squares carry the markers,
//   numbered 0, 1, 2 ... row-major over the white squares;
// - each marker is DICT_4X4_250's 4 x 4 bit pattern (aruco_4x4_250.json, extracted from OpenCV)
//   with a one-cell black border: 6 x 6 cells over `marker_mm`, centred in its square. Marker image
//   rows run along the board's X (down the page), its columns along Y, as OpenCV draws the board
//   with image x along the columns;
// - the centre target (`target`): blanked cells (paper, so their markers are gone: the spec's
//   `removed_marker_ids`), grey guide rings with four inward side ticks, and black dots.
//
// Geometry is exact in millimetres and every texel holds its exact area coverage (an
// anti-aliased, box-filtered rendering), so the texture can be drawn at any density. OpenCV's own
// rendering at the print's 23.6 px/mm rounds marker edges to whole print pixels, so a print differs
// from this by at most one print pixel (0.04 mm) along marker edges; the harness test compares the
// two pixel by pixel (tests/harness/test_vision_outline.py).
//
// Texture convention (boardtex.py's): grey, 0 = black ink, 255 = paper; `ppm` texels per mm; texel
// (u, v) (column, row) covers the board point (X, Y) = (x0 + (v + 0.5) / ppm, y0 + (u + 0.5) / ppm)
// in board_frame.js's frame (X down the page, Y right, mm), where (x0, y0) = originMm. The texture
// covers the chessboard plus a margin of plain paper `padMm` wide; beyond it (the sheet's edge, the
// patch strips, the table) the board is not modelled.

import dictionary from './aruco_4x4_250.json' with { type: 'json' };

/** Paper modelled around the chessboard, mm (boardtex.PAD_MM; the sheets' margins are 25-37 mm). */
export const PAD_MM = 5.0;

/** Ring and tick line width when the spec has no print density: make_board's 0.2 mm. */
const RING_WIDTH_MM = 0.2;

/** make_board's side ticks run this fraction of the target's side inwards. */
const TICK_FRACTION = 0.07;

/** Sub-samples per texel side for the round shapes (rings, ticks, dots). */
const ROUND_SUPERSAMPLE = 6;

/**
 * The 4 x 4 inner bits of DICT_4X4_250 marker `id`, as a 4 x 4 array of rows (1 = white).
 */
export function markerBits(id) {
  const hex = dictionary.markers[id];

  if (hex === undefined) {
    throw new Error(`DICT_4X4_250 has no marker ${id}`);
  }

  const value = parseInt(hex, 16);
  const rows = [];

  for (let r = 0; r < 4; r += 1) {
    const row = [];

    for (let c = 0; c < 4; c += 1) {
      row.push((value >> (15 - (r * 4 + c))) & 1);
    }

    rows.push(row);
  }

  return rows;
}

/**
 * The marker squares of a board, in id order: [{ id, row, col }]. White squares (row + col odd in
 * the current pattern) are numbered row-major, as OpenCV's CharucoBoard numbers them.
 */
export function markerSquares(spec) {
  checkSpec(spec);
  const out = [];
  let id = 0;

  for (let row = 0; row < spec.squares_y; row += 1) {
    for (let col = 0; col < spec.squares_x; col += 1) {
      if ((row + col) % 2 === 1) {
        out.push({ id, row, col });
        id += 1;
      }
    }
  }

  return out;
}

function checkSpec(spec) {
  if (spec.dictionary && spec.dictionary !== 'DICT_4X4_250') {
    throw new Error(`board_texture draws DICT_4X4_250 boards only, not ${spec.dictionary}`);
  }

  // The legacy pattern only differs from the current one on boards with an even number of rows.
  if (spec.legacy && spec.squares_y % 2 === 0) {
    throw new Error('the legacy ChArUco pattern with an even number of rows is not supported');
  }
}

/** The marker side in mm: `marker_mm`, or `marker_ratio` x the square (the scanner's capture specs). */
function markerMm(spec) {
  if (spec.marker_mm) {
    return spec.marker_mm;
  }

  return spec.marker_ratio * spec.square_mm;
}

/**
 * Draws the board's albedo texture.
 *
 * @param {object} spec  a houseki.board.v1 spec (board_frame.js's BOARD_SPECS), or the same fields
 *                       for an older board (squares_x, squares_y, square_mm, marker_mm or
 *                       marker_ratio; `target` optional)
 * @param {{ ppm?: number, padMm?: number, linear?: boolean }} [options]  ppm: texels per mm
 *        (default 10). linear: store reflectance instead of the print's grey levels: 0 ink .. 255
 *        paper, linear in reflected light, so a grey printed at sRGB level v (the rings) holds
 *        255 x linear(v / 255), what a colour-managed print aims at (make_board's nominal model,
 *        ink + (1 - ink) x linear(intent), with the ink taken as 0 here). The edges' coverage is
 *        linear in reflected light either way. A camera's blur mixes reflected light, so the
 *        outline blurs this texture and applies a tone curve afterwards.
 * @returns {{ data: Uint8Array, width: number, height: number, ppm: number,
 *             originMm: [number, number], sizeMm: [number, number], linear: boolean }}
 *          data: width x height grey texels, row-major from row 0 (smallest X); originMm: the board
 *          point of texel (0, 0)'s corner; sizeMm: the chessboard's extent [rows, columns] in mm.
 */
export function renderBoardTexture(spec, options = {}) {
  checkSpec(spec);
  const ppm = options.ppm ?? 10;
  const padMm = options.padMm ?? PAD_MM;
  const linear = options.linear ?? false;
  const sq = spec.square_mm;
  const rowsMm = spec.squares_y * sq;
  const colsMm = spec.squares_x * sq;
  const width = Math.round((colsMm + 2 * padMm) * ppm);
  const height = Math.round((rowsMm + 2 * padMm) * ppm);
  const x0 = -padMm;
  const y0 = -padMm;

  // Ink coverage per texel (0 = paper .. 1 = black ink); the drawn shapes never overlap, so each
  // adds its own exact area.
  const ink = new Float32Array(width * height);

  // Texel space: column u along Y, row v along X.
  const toU = (y) => (y - y0) * ppm;
  const toV = (x) => (x - x0) * ppm;

  // Adds `amount` x the area coverage of the board rectangle [xa, xb] x [ya, yb] (mm).
  function addRect(xa, xb, ya, yb, amount) {
    const u0 = toU(ya);
    const u1 = toU(yb);
    const v0 = toV(xa);
    const v1 = toV(xb);
    const ua = Math.max(0, Math.floor(u0));
    const ub = Math.min(width - 1, Math.ceil(u1) - 1);
    const va = Math.max(0, Math.floor(v0));
    const vb = Math.min(height - 1, Math.ceil(v1) - 1);

    for (let v = va; v <= vb; v += 1) {
      const cy = Math.min(v + 1, v1) - Math.max(v, v0);

      if (cy <= 0) {
        continue;
      }

      const base = v * width;

      for (let u = ua; u <= ub; u += 1) {
        const cx = Math.min(u + 1, u1) - Math.max(u, u0);

        if (cx > 0) {
          ink[base + u] += amount * cx * cy;
        }
      }
    }
  }

  // Adds `amount` x the coverage of a round shape, by supersampling every texel of its bounding
  // box (mm). inside(X, Y) says whether a board point is in the shape.
  function addRound(box, inside, amount) {
    const ua = Math.max(0, Math.floor(toU(box.ya)));
    const ub = Math.min(width - 1, Math.ceil(toU(box.yb)));
    const va = Math.max(0, Math.floor(toV(box.xa)));
    const vb = Math.min(height - 1, Math.ceil(toV(box.xb)));
    const n = ROUND_SUPERSAMPLE;

    for (let v = va; v <= vb; v += 1) {
      for (let u = ua; u <= ub; u += 1) {
        let hits = 0;

        for (let j = 0; j < n; j += 1) {
          const X = x0 + (v + (j + 0.5) / n) / ppm;

          for (let i = 0; i < n; i += 1) {
            const Y = y0 + (u + (i + 0.5) / n) / ppm;

            if (inside(X, Y)) {
              hits += 1;
            }
          }
        }

        if (hits) {
          ink[v * width + u] += (amount * hits) / (n * n);
        }
      }
    }
  }

  const target = spec.target ?? {};
  const blank = new Set((target.cells_row_col ?? []).map(([r, c]) => `${r},${c}`));

  // Black squares.
  for (let row = 0; row < spec.squares_y; row += 1) {
    for (let col = 0; col < spec.squares_x; col += 1) {
      if ((row + col) % 2 === 0 && !blank.has(`${row},${col}`)) {
        addRect(row * sq, (row + 1) * sq, col * sq, (col + 1) * sq, 1);
      }
    }
  }

  // Markers: the black cells of the 6 x 6 grid (border and 0 bits), centred in the white square.
  const m = markerMm(spec);
  const off = (sq - m) / 2;
  const cell = m / 6;

  for (const { id, row, col } of markerSquares(spec)) {
    if (blank.has(`${row},${col}`) || id >= dictionary.markers.length) {
      continue;
    }

    const bits = markerBits(id);

    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 6; j += 1) {
        const border = i === 0 || j === 0 || i === 5 || j === 5;

        if (border || bits[i - 1][j - 1] === 0) {
          const xa = row * sq + off + i * cell;
          const ya = col * sq + off + j * cell;
          addRect(xa, xa + cell, ya, ya + cell, 1);
        }
      }
    }
  }

  // The centre target's rings and ticks (grey `ring_grey` on paper) and dots (black).
  const printPpm = spec.print?.px_per_mm;
  const lineMm = printPpm ? Math.max(1, Math.round(RING_WIDTH_MM * printPpm)) / printPpm : RING_WIDTH_MM;
  const ringLevel = (target.ring_grey ?? 150) / 255;
  const greyInk = 1 - (linear ? srgbToLinear(ringLevel) : ringLevel);
  const rings = target.rings_diameter_mm ?? [];

  if (rings.length) {
    const [cx, cy] = target.centre_mm;

    for (const d of rings) {
      const r = d / 2;
      const half = lineMm / 2;
      const reach = r + half;
      addRound(
        { xa: cx - reach, xb: cx + reach, ya: cy - reach, yb: cy + reach },
        (X, Y) => Math.abs(Math.hypot(X - cx, Y - cy) - r) <= half,
        greyInk,
      );
    }

    // Ticks: make_board's four short lines at the middle of each side, pointing inwards, drawn
    // with OpenCV's round line ends (a capsule of the line width).
    const [xa, xb] = target.x_range_mm;
    const [ya] = target.y_range_mm;
    const size = xb - xa;
    const ticks = [
      [[0, 0.5], [TICK_FRACTION, 0.5]],
      [[1, 0.5], [1 - TICK_FRACTION, 0.5]],
      [[0.5, 0], [0.5, TICK_FRACTION]],
      [[0.5, 1], [0.5, 1 - TICK_FRACTION]],
    ];

    for (const [a, b] of ticks) {
      const p = [xa + a[0] * size, ya + a[1] * size];
      const q = [xa + b[0] * size, ya + b[1] * size];
      const half = lineMm / 2;
      addRound(
        {
          xa: Math.min(p[0], q[0]) - half,
          xb: Math.max(p[0], q[0]) + half,
          ya: Math.min(p[1], q[1]) - half,
          yb: Math.max(p[1], q[1]) + half,
        },
        (X, Y) => segmentDistance(X, Y, p, q) <= half,
        greyInk,
      );
    }
  }

  const dots = target.dots_mm ?? [];

  if (dots.length) {
    // make_board rounds the radius to 1/16 of a print pixel (cv2.circle's fixed point).
    let r = target.dot_diameter_mm / 2;

    if (printPpm) {
      r = Math.round(r * printPpm * 16) / 16 / printPpm;
    }

    for (const [cx, cy] of dots) {
      addRound(
        { xa: cx - r, xb: cx + r, ya: cy - r, yb: cy + r },
        (X, Y) => (X - cx) ** 2 + (Y - cy) ** 2 <= r * r,
        1,
      );
    }
  }

  const data = new Uint8Array(width * height);

  for (let k = 0; k < data.length; k += 1) {
    data[k] = Math.round(255 * (1 - Math.min(1, Math.max(0, ink[k]))));
  }

  return { data, width, height, ppm, originMm: [x0, y0], sizeMm: [rowsMm, colsMm], linear };
}

/** The sRGB transfer function's inverse: code value (0..1) to linear light. */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function segmentDistance(X, Y, p, q) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len2 = dx * dx + dy * dy;
  let s = len2 > 0 ? ((X - p[0]) * dx + (Y - p[1]) * dy) / len2 : 0;
  s = Math.min(1, Math.max(0, s));
  return Math.hypot(X - (p[0] + s * dx), Y - (p[1] + s * dy));
}

/**
 * The albedo (0 ink .. 1 paper) at a board point, bilinear, from a texture renderBoardTexture
 * drew; 1 (paper) outside it. For tests and CPU checks; the GPU samples the texture itself.
 */
export function sampleBoardTexture(tex, X, Y) {
  const u = (Y - tex.originMm[1]) * tex.ppm - 0.5;
  const v = (X - tex.originMm[0]) * tex.ppm - 0.5;
  const u0 = Math.floor(u);
  const v0 = Math.floor(v);
  const fu = u - u0;
  const fv = v - v0;
  const at = (uu, vv) =>
    uu < 0 || vv < 0 || uu >= tex.width || vv >= tex.height ? 255 : tex.data[vv * tex.width + uu];
  const top = at(u0, v0) * (1 - fu) + at(u0 + 1, v0) * fu;
  const bottom = at(u0, v0 + 1) * (1 - fu) + at(u0 + 1, v0 + 1) * fu;
  return (top * (1 - fv) + bottom * fv) / 255;
}
