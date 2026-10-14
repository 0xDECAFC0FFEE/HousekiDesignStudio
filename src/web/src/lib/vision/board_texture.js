// The printed board's appearance, drawn from its spec (T-0325): what the camera would see of the
// bare sheet, as an albedo texture the rock outline (outline.js) predicts each frame from.
//
// It is the phone's port of the HousekiScanner project's board texture (src/houseki/pipeline/
// boardtex.py), drawn without OpenCV, for the scanner's three boards (T-0340, board_frame.js):
//
// - the chessboard in OpenCV's current ChArUco pattern (`legacy: false`): square (row 0, col 0) is
//   dark, so a square is dark when row + col is even, and the light squares carry the markers,
//   numbered row-major over the light squares; marker k prints DICT_4X4_1000 id first_marker_id + k;
// - each marker is its 4 x 4 bit pattern (aruco_4x4_1000.json, extracted from OpenCV) with a
//   one-cell border, in the dark colour on the light one: 6 x 6 cells over `marker_mm`, centred in
//   its square. Marker image rows run along the board's X (down the page), its columns along Y, as
//   OpenCV draws the board with image x along the columns;
// - the colours (`colours`): the dark squares and the markers' ink are `dark_srgb`, the marker
//   squares `light_srgb`, printed grey levels (0 black .. 255 the paper's white);
// - the grey spiral in every dark square (`spiral`): a 4 x 4 grid of `cell_mm` cells from
//   `origin_mm` in, each its own grey level.
//
// Geometry is exact in millimetres and every texel holds its exact area coverage (an
// anti-aliased, box-filtered rendering), so the texture can be drawn at any density. A print at
// 23.6 px/mm rounds edges to whole print pixels, so it differs from this by at most one print pixel
// (0.04 mm) along edges.
//
// Texture convention (boardtex.py's): grey, 0 = black ink, 255 = paper; `ppm` texels per mm; texel
// (u, v) (column, row) covers the board point (X, Y) = (x0 + (v + 0.5) / ppm, y0 + (u + 0.5) / ppm)
// in board_frame.js's frame (X down the page, Y right, mm), where (x0, y0) = originMm. The texture
// covers the chessboard plus a margin of plain paper `padMm` wide; beyond it (the sheet's edge, the
// rulers, the table) the board is not modelled.

import dictionary from './aruco_4x4_1000.json' with { type: 'json' };

/** Paper modelled around the chessboard, mm (boardtex.PAD_MM). */
export const PAD_MM = 5.0;

/**
 * The 4 x 4 inner bits of DICT_4X4_1000 marker `id`, as a 4 x 4 array of rows (1 = white).
 */
export function markerBits(id) {
  const hex = dictionary.markers[id];

  if (hex === undefined) {
    throw new Error(`DICT_4X4_1000 has no marker ${id}`);
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
 * The marker squares of a board, in board order: [{ id, row, col }], `id` the index on the board
 * (its dictionary id is first_marker_id + id). Light squares (row + col odd in the current
 * pattern) are numbered row-major, as OpenCV's CharucoBoard numbers them.
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
  // DICT_4X4_250 is the first 250 of DICT_4X4_1000.
  if (spec.dictionary && spec.dictionary !== 'DICT_4X4_1000' && spec.dictionary !== 'DICT_4X4_250') {
    throw new Error(`board_texture draws DICT_4X4_1000 boards only, not ${spec.dictionary}`);
  }

  // The legacy pattern only differs from the current one on boards with an even number of rows.
  if (spec.legacy && spec.squares_y % 2 === 0) {
    throw new Error('the legacy ChArUco pattern with an even number of rows is not supported');
  }
}

/** The marker side in mm: `marker_mm`, or `marker_ratio` x the square. */
function markerMm(spec) {
  if (spec.marker_mm) {
    return spec.marker_mm;
  }

  return spec.marker_ratio * spec.square_mm;
}

/**
 * Draws the board's albedo texture.
 *
 * @param {object} spec  a houseki.board.v1 spec (board_frame.js's BOARD_SPECS), or the same layout
 *                       fields alone (squares_x, squares_y, square_mm, marker_mm or marker_ratio;
 *                       `colours` and `spiral` optional: black and white, no spiral)
 * @param {{ ppm?: number, padMm?: number, linear?: boolean }} [options]  ppm: texels per mm
 *        (default 10). linear: store reflectance instead of the print's grey levels: 0 ink .. 255
 *        paper, linear in reflected light, so a grey printed at sRGB level v holds
 *        255 x linear(v / 255), what a colour-managed print aims at (make_board's nominal model,
 *        ink + (1 - ink) x linear(intent), with the ink taken as 0 here: the outline's tone curve
 *        adds it). The edges' coverage is linear in reflected light either way. A camera's blur
 *        mixes reflected light, so the outline blurs this texture and applies a tone curve
 *        afterwards.
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
  // A printed grey level (0..255) as this texture stores it (0..1).
  const level = (srgb) => (linear ? srgbToLinear(srgb / 255) : srgb / 255);
  const dark = level(spec.colours?.dark_srgb ?? 0);
  const light = level(spec.colours?.light_srgb ?? 255);

  // The albedo per texel (0 = black .. 1 = paper), starting as paper. Each shape lies wholly
  // inside the one drawn before it (the board, its dark squares, their spirals; the markers in
  // the light squares), so drawing one adds its exact coverage x (its level - the level under it).
  const albedo = new Float32Array(width * height).fill(1);

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
          albedo[base + u] += amount * cx * cy;
        }
      }
    }
  }

  // The board in the light colour, then the dark squares and their spirals.
  addRect(0, rowsMm, 0, colsMm, light - 1);
  const spiral = spec.spiral ?? null;

  for (let row = 0; row < spec.squares_y; row += 1) {
    for (let col = 0; col < spec.squares_x; col += 1) {
      if ((row + col) % 2 !== 0) {
        continue;
      }

      addRect(row * sq, (row + 1) * sq, col * sq, (col + 1) * sq, dark - light);

      if (spiral) {
        const c = spiral.cell_mm;

        spiral.levels_srgb.forEach((cells, i) => cells.forEach((grey, j) => {
          const xa = row * sq + spiral.origin_mm + i * c;
          const ya = col * sq + spiral.origin_mm + j * c;
          addRect(xa, xa + c, ya, ya + c, level(grey) - dark);
        }));
      }
    }
  }

  // Markers: the dark cells of the 6 x 6 grid (border and 0 bits), centred in the light square.
  const m = markerMm(spec);
  const off = (sq - m) / 2;
  const cell = m / 6;
  const first = spec.first_marker_id ?? 0;
  const removed = new Set(spec.removed_marker_ids ?? []);

  for (const { id, row, col } of markerSquares(spec)) {
    if (removed.has(id) || first + id >= dictionary.markers.length) {
      continue;
    }

    const bits = markerBits(first + id);

    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 6; j += 1) {
        const border = i === 0 || j === 0 || i === 5 || j === 5;

        if (border || bits[i - 1][j - 1] === 0) {
          const xa = row * sq + off + i * cell;
          const ya = col * sq + off + j * cell;
          addRect(xa, xa + cell, ya, ya + cell, dark - light);
        }
      }
    }
  }

  const data = new Uint8Array(width * height);

  for (let k = 0; k < data.length; k += 1) {
    data[k] = Math.round(255 * Math.min(1, Math.max(0, albedo[k])));
  }

  return { data, width, height, ppm, originMm: [x0, y0], sizeMm: [rowsMm, colsMm], linear };
}

/** The sRGB transfer function's inverse: code value (0..1) to linear light. */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
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
