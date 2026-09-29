// Edit > Manual optimizer (T-0273): the grid of crown and pavilion heights, pure. The user
// (2026-09-28):
//
//   "its purpose is to vary the crown/pavilion height by configurable amounts and to render
//   previews of the gemstone at each crown/pavilion height to inspect how it'll look. use the same
//   logic as the tangent ratio height in the other mode. ... at the top it needs a subdivisions
//   slider for the square root of the number of images to show on the left panel ... only support
//   3+ odd numbers. under it should be a slider for the crown height range and a slider for the
//   pavilion height range as a percent. if the crown height slider is at 100, the top row rocks
//   should all have height 2x the base rock and the bottom row should all be at 1/2 ... users can
//   click on a cell to update the center render's crown/pavilion height. users can also highlight
//   some rectangle of cells to update the center cell and the crown/pavilion height range based on
//   the cells' width/heights in the top left cell (representing the tallest gemstone) and the
//   bottom right cell (representing the most squashed gemstone)."
//
// No DOM, no stores, no GemApp: tested under Deno (web/tests/manual_optimizer_test.js).
// manual_optimizer_mode.js is the mode around it.
//
// THE HEIGHTS ARE SCALE HEIGHT'S RATIOS. A cell is a pair of ratios, `{ crown, pavilion }`, each
// a stretch of its half of the stone along the optical axis about that half's own girdle edge --
// exactly scale height mode's tangent ratio (scale_height.js's `scaledValues`, imported by the mode,
// not copied), which makes a crown of ratio 2 exactly twice as tall with every meet kept.
//
// THE AXES. Rows vary the crown, columns the pavilion. The top row has the tallest crown and the
// left column the deepest pavilion, so the top-left cell is the tallest stone and the bottom-right
// the flattest, as the user describes them, and the middle cell is the grid's centre.
//
// THE MAPPING. A range of r percent makes the top row (1 + r/100) times the centre's crown ratio and
// the bottom row 1 / (1 + r/100) times it: r = 100 gives 2x and 1/2, the user's own example. The
// rows between step evenly in the exponent, t from +1 at the top to -1 at the bottom, so each row
// is the same factor from the next (geometric steps, symmetric in ratio as the user's 2x and 1/2
// are). At r = 0 every row is the centre. The columns do the same for the pavilion.
//
// THE CENTRE. It starts at 1x and 1x, the design as it stood when the mode opened. A rectangle
// dragged over the grid moves it: the rectangle's middle becomes the new centre and its top-left and
// bottom-right cells the new extremes (`selectRectangle`), in the same ratio space, so a rectangle of
// even width or height, whose middle falls between cells, is handled by the same formula.

import { RATIO_MIN, RATIO_MAX } from './scale_height.js';

/** The fewest cells a side: the user's "only support 3+ odd numbers". */
export const SUBDIVISIONS_MIN = 3;
/**
 * The most cells a side: 11, 121 previews (T-0281; the user, 2026-09-28: "can you increase the
 * subdivision count to 11"). It was 7 until then, for cell size: 11 a side in a pane about 300 px
 * wide is cells of about 25 px, so a big grid wants the pane dragged wider. Each cell is a stone
 * built from the design and drawn, one stage of one cell a step (T-0274), so the page stays live
 * while all 121 fill; they just take longer.
 */
export const SUBDIVISIONS_MAX = 11;
/** What the mode opens with: a 5 x 5 grid. */
export const SUBDIVISIONS_DEFAULT = 5;

/** The two range sliders, in percent. 100 is the user's example: 2x at the top, 1/2 at the bottom. */
export const RANGE_MIN = 0;
export const RANGE_MAX = 100;
export const RANGE_STEP = 1;
/** What the mode opens with: each row or column a few percent taller than the next. */
export const RANGE_DEFAULT = 20;

/** The nearest allowed subdivision count to `value`: an odd whole number from 3 to 11. */
export function snapSubdivisions(value) {
  const odd = Math.round((Number(value) - 1) / 2) * 2 + 1;

  if (!Number.isFinite(odd)) {
    return SUBDIVISIONS_DEFAULT;
  }

  return Math.min(SUBDIVISIONS_MAX, Math.max(SUBDIVISIONS_MIN, odd));
}

/** `value` held to the range sliders' scale, 0 to 100 percent. */
export function clampRange(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return RANGE_MIN;
  }

  return Math.min(RANGE_MAX, Math.max(RANGE_MIN, number));
}

/**
 * The exponent of row (or column) `index` of `subdivisions`: +1 at the first (top, or left), -1
 * at the last, 0 exactly at the middle, evenly between.
 */
export function stepExponent(index, subdivisions) {
  return 1 - (2 * index) / (subdivisions - 1);
}

/**
 * How many times the centre's ratio row (or column) `index` is, for a range of `percent`:
 * (1 + percent/100) raised to the row's exponent. Exactly 1 at the middle, whatever the range.
 */
export function stepFactor(index, subdivisions, percent) {
  return Math.pow(1 + percent / 100, stepExponent(index, subdivisions));
}

/** `ratio` held to scale height's own gauge range, so no cell is flattened into its girdle. */
export function clampRatio(ratio) {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio));
}

/**
 * The state the mode opens with: `subdivisions` cells a side, both ranges `RANGE_DEFAULT`, the
 * centre and the preview both at 1x and 1x (the design as it stands).
 *
 *   subdivisions    cells a side, odd, 3 to 11
 *   crownRange      percent, the rows' spread; pavilionRange, the columns'
 *   centre          { crown, pavilion }: the middle cell's ratios
 *   preview         { crown, pavilion }: the ratios the stone in the middle of the page shows,
 *                   and what Done keeps
 */
export function initialState({
  subdivisions = SUBDIVISIONS_DEFAULT, crownRange = RANGE_DEFAULT, pavilionRange = RANGE_DEFAULT,
} = {}) {
  return {
    subdivisions: snapSubdivisions(subdivisions),
    crownRange: clampRange(crownRange),
    pavilionRange: clampRange(pavilionRange),
    centre: { crown: 1, pavilion: 1 },
    preview: { crown: 1, pavilion: 1 },
  };
}

/** Whether two states are the same, for the mode's own undo (a change to nothing is no step). */
export function sameState(a, b) {
  return a.subdivisions === b.subdivisions && a.crownRange === b.crownRange &&
    a.pavilionRange === b.pavilionRange && a.centre.crown === b.centre.crown &&
    a.centre.pavilion === b.centre.pavilion && a.preview.crown === b.preview.crown &&
    a.preview.pavilion === b.preview.pavilion;
}

/**
 * The ratios of the cell at `row` (0 at the top: the crown) and `column` (0 at the left: the
 * pavilion), `{ crown, pavilion }`, each held to scale height's range.
 */
export function cellRatios(state, row, column) {
  const n = state.subdivisions;

  return {
    crown: clampRatio(state.centre.crown * stepFactor(row, n, state.crownRange)),
    pavilion: clampRatio(state.centre.pavilion * stepFactor(column, n, state.pavilionRange)),
  };
}

/** Every cell, row by row from the top left: `[{ row, column, index, crown, pavilion }]`. */
export function gridCells(state) {
  const cells = [];
  const n = state.subdivisions;

  for (let row = 0; row < n; row++) {
    for (let column = 0; column < n; column++) {
      cells.push({ row, column, index: row * n + column, ...cellRatios(state, row, column) });
    }
  }

  return cells;
}

/**
 * The order to draw the cells in: the middle first, then outwards ring by ring, so the cells
 * nearest the stone the user is judging fill first. Returns the cells' indices.
 */
export function fillOrder(subdivisions) {
  const middle = (subdivisions - 1) / 2;
  const order = [];

  for (let row = 0; row < subdivisions; row++) {
    for (let column = 0; column < subdivisions; column++) {
      order.push({
        index: row * subdivisions + column,
        ring: Math.max(Math.abs(row - middle), Math.abs(column - middle)),
        distance: Math.hypot(row - middle, column - middle),
      });
    }
  }

  order.sort((a, b) => a.ring - b.ring || a.distance - b.distance || a.index - b.index);
  return order.map(cell => cell.index);
}

/** The state with `subdivisions` cells a side (snapped to an odd 3 to 11); nothing else moves. */
export function withSubdivisions(state, subdivisions) {
  return { ...state, subdivisions: snapSubdivisions(subdivisions) };
}

/** The state with the crown's (`which` 'crown') or pavilion's range at `percent`. */
export function withRange(state, which, percent) {
  return { ...state, [which === 'crown' ? 'crownRange' : 'pavilionRange']: clampRange(percent) };
}

/**
 * A click on a cell: the preview takes that cell's ratios. The grid stays as it is (settled with
 * the user: a click only changes the stone in the middle).
 */
export function clickCell(state, row, column) {
  return { ...state, preview: cellRatios(state, row, column) };
}

/**
 * The range, in percent, that makes a rectangle `span` rows (or columns) apart -- its first and
 * last row `span` apart -- the new top and bottom of a grid of `subdivisions`. The rows' exponent
 * steps 2/(n - 1) a row, so rows a and b are 2(b - a)/(n - 1) apart in exponent, and that must
 * become the whole grid's 2: the new factor is the old one raised to (b - a)/(n - 1).
 */
export function spannedRange(percent, span, subdivisions) {
  return (Math.pow(1 + percent / 100, span / (subdivisions - 1)) - 1) * 100;
}

/**
 * A rectangle dragged from cell `from` to cell `to` (`{ row, column }` each, either corner first):
 * the grid is re-centred on the rectangle's middle and its ranges set so the rectangle's top-left
 * cell becomes the new top-left (the tallest stone) and its bottom-right the new bottom-right (the
 * flattest), with the same subdivisions. The preview moves to the new centre, the stone the grid
 * now surrounds.
 *
 * The middle of a rectangle an even number of cells wide or tall falls between two cells; it is
 * taken in the same ratio space (the exponent of the half-way row), so it is the geometric mean of
 * the two cells either side of it, and the new extremes still land exactly on the rectangle's
 * corners. A rectangle one cell wide collapses the pavilion's range to 0 (every column that cell's
 * pavilion) -- the corners' own pavilions are the same -- and one cell tall the crown's likewise.
 */
export function selectRectangle(state, from, to) {
  const n = state.subdivisions;
  const top = Math.min(from.row, to.row);
  const bottom = Math.max(from.row, to.row);
  const left = Math.min(from.column, to.column);
  const right = Math.max(from.column, to.column);

  // The exponent of the rectangle's middle row and column: the mean of its two ends', which is a
  // half-way row when the rectangle's height is even.
  const rowExponent = (stepExponent(top, n) + stepExponent(bottom, n)) / 2;
  const columnExponent = (stepExponent(left, n) + stepExponent(right, n)) / 2;
  const centre = {
    crown: clampRatio(state.centre.crown * Math.pow(1 + state.crownRange / 100, rowExponent)),
    pavilion: clampRatio(state.centre.pavilion * Math.pow(1 + state.pavilionRange / 100, columnExponent)),
  };

  return {
    ...state,
    crownRange: clampRange(spannedRange(state.crownRange, bottom - top, n)),
    pavilionRange: clampRange(spannedRange(state.pavilionRange, right - left, n)),
    centre,
    preview: { ...centre },
  };
}

/** Whether ratios `a` and `b` are the same pair, to a part in 1e9 (they come from powers). */
export function sameRatios(a, b) {
  const close = (x, y) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));

  return close(a.crown, b.crown) && close(a.pavilion, b.pavilion);
}

/** The index of the cell the preview shows, or -1 when it is none of them. */
export function previewCell(state) {
  return gridCells(state).findIndex(cell => sameRatios(cell, state.preview));
}

/**
 * A corner of the stone the mode opened on, `point`, once the crown is stretched by `crown` and the
 * pavilion by `pavilion` about their pivots (scale height's stretch, z -> pivot + ratio (z - pivot),
 * x and y untouched). A corner between the two pivots -- the girdle band -- does not move.
 */
export function stretchedCorner(point, pivots, crown, pavilion) {
  if (point.z >= pivots.crown) {
    return { x: point.x, y: point.y, z: pivots.crown + crown * (point.z - pivots.crown) };
  }

  if (point.z <= pivots.pavilion) {
    return { x: point.x, y: point.y, z: pivots.pavilion + pavilion * (point.z - pivots.pavilion) };
  }

  return point;
}

/**
 * The frame every cell of the grid is drawn in: `{ center: { x, y, z }, radius }`, in the design's
 * own units, a sphere holding the tallest stone of the grid (every cell's stone fits in it, so they
 * are all drawn at the same scale and a taller crown reads as taller).
 *
 * `corners` are the corners of the design's stone as it stood when the mode opened
 * (`builtCorners`), and `pivots` scale height's (`heightPivots`). A cell's stone is that stone with
 * each half stretched along the axis, so the grid's tallest stone -- the largest crown and pavilion
 * ratios in it, `crownMax` and `pavilionMax` -- is the one to fit, and its corners are known without
 * building it (`stretchedCorner`). The sphere is centred on their box and just reaches the furthest
 * of them, plus 2% for designs whose halves overlap in height, where the stretch is not exact.
 */
export function gridFrame(corners, pivots, crownMax, pavilionMax) {
  const stretched = corners.map(point => stretchedCorner(point, pivots, crownMax, pavilionMax));
  const { min, max } = boundsOf(stretched);
  const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  const furthest = stretched.reduce((far, point) =>
    Math.max(far, Math.hypot(point.x - center.x, point.y - center.y, point.z - center.z)), 0);

  return { center, radius: Math.max(furthest * 1.02, 1e-6) };
}

/** Every corner of a built stone (`DesignMesh.buildFaces`' result), each face's in turn. */
export function builtCorners(built) {
  return built.faces.flatMap(face => face.polygon.map(({ x, y, z }) => ({ x, y, z })));
}

/** The box round `points`: `{ min, max }`. */
function boundsOf(points) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };

  for (const point of points) {
    for (const axis of ['x', 'y', 'z']) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }

  return { min, max };
}

/** The bounds of a built stone (`DesignMesh.buildFaces`' result): `{ min, max }` of its corners. */
export function builtBounds(built) {
  return boundsOf(builtCorners(built));
}

/** A label for a ratio as the panel and the cells' tooltips show it: "1.20×". */
export function formatRatio(ratio) {
  return `${ratio.toFixed(2)}×`;
}

/** A range as the sliders' readouts show it: whole percents, one decimal once it is not whole. */
export function formatRange(percent) {
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}
