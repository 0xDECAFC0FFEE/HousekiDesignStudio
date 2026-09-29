/*
 * manual_optimizer_test.js -- tests for Edit > Manual optimizer (T-0273, 2026-09-28): the grid of
 * crown and pavilion heights in web/src/lib/manual_optimizer.js, and the mode around it in
 * manual_optimizer_mode.js.
 *
 * The user's request under test: "vary the crown/pavilion height by configurable amounts ... use
 * the same logic as the tangent ratio height in the other mode ... a subdivisions slider ... only
 * support 3+ odd numbers ... a slider for the crown height range and a slider for the pavilion
 * height range as a percent. if the crown height slider is at 100, the top row rocks should all
 * have height 2x the base rock and the bottom row should all be at 1/2 ... users can click on a
 * cell to update the center render's crown/pavilion height. users can also highlight some
 * rectangle of cells to update the center cell and the crown/pavilion height range based on the
 * cells' width/heights in the top left cell (representing the tallest gemstone) and the bottom
 * right cell (representing the most squashed gemstone)."
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * There is no renderer here (`engine.app` is null): the grid's pictures are drawn by the wasm
 * module's preview stones, so they are checked against the built page over CDP. What IS checked
 * here is everything the pictures are drawn from -- which ratios each cell has, what a click and a
 * rectangle do to them, the frame the cells are drawn in -- and the mode's effect on the design:
 * the stone in the middle, Done, Cancel and the two undo stacks.
 *
 * `window` is stubbed because the mode asks the page for a redraw (`window.gemRequestRender?.()`)
 * and Deno has no such global.
 */

globalThis.window = globalThis.window ?? {};

import { get } from "svelte/store";
import {
  SUBDIVISIONS_MIN, SUBDIVISIONS_MAX, SUBDIVISIONS_DEFAULT, RANGE_MIN, RANGE_MAX, RANGE_DEFAULT,
  snapSubdivisions, clampRange, stepExponent, stepFactor, initialState, sameState, cellRatios,
  gridCells, fillOrder, withSubdivisions, withRange, clickCell, selectRectangle, spannedRange,
  sameRatios, previewCell, gridFrame, builtBounds, builtCorners, stretchedCorner, formatRange,
} from "../src/lib/manual_optimizer.js";
import { RATIO_MIN, RATIO_MAX, heightPivots, scaledValues } from "../src/lib/scale_height.js";
import {
  enterManualOptimizer, exitManualOptimizer, cancelManualOptimizer, setSubdivisions, setRange,
  previewGridCell, selectGridRectangle, manualOptimizer, manualOptimizerOpen,
} from "../src/lib/manual_optimizer_mode.js";
import { enterScaleHeightMode, cancelScaleHeightMode } from "../src/lib/scale_height_mode.js";
import { enterEditMode, cancelEditMode, editing } from "../src/lib/edit_mode.js";
import {
  render, toolbar, highlightTier, setEditRecorder, setHistoryFrames, applyEdit,
} from "../src/lib/tier_controller.js";
import { undo, redo } from "../src/lib/session.js";
import { canUndo, canRedo } from "../src/lib/stores.js";

// The GemCad scripts, loaded as the page loads them (make_page.py's bundle order): `design.js`
// for the planes, `design_mesh.js` to build a stone from them, `gcs.js` to read the startup
// stone, and `edit_history.js` for the history Done records into.
for (const script of ["edit_history.js", "gemcad.js", "gemcad_obj.js", "design.js", "design_mesh.js", "gcs.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${script}`, import.meta.url)));
}

const { GemCadDesign, GemCutStudio, DesignMesh, EditHistory } = globalThis;

/** The startup stone, committed under src/resources, so this is present on a fresh clone. */
const STARTUP_URL = new URL("../../resources/hex_cut_v2.gcs", import.meta.url);

async function startupDesign() {
  const { parsed } = GemCutStudio.importText(await Deno.readTextFile(STARTUP_URL));

  return GemCadDesign.fromGemCad(parsed, { name: "hex_cut_v2.gcs" });
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message}: expected ${expected} within ${tolerance}, got ${actual}`);
  }
}

/** A state with `subdivisions` and both ranges at `range`, centred on 1x and 1x. */
function stateOf(subdivisions, range) {
  return initialState({ subdivisions, crownRange: range, pavilionRange: range });
}

// ---- the height mapping

Deno.test("at 100% the top row is twice the height, the bottom half, the middle unchanged", () => {
  // Setup: grids of every allowed size, 3, 5 and 7 a side, both ranges at 100% -- the user's own
  // example -- centred on the design as it stands (1x and 1x).
  // Test: every cell's ratios (gridCells).
  // Verifies: every cell of the top row has crown ratio exactly 2 and every cell of the bottom row
  // exactly 0.5 ("the top row rocks should all have height 2x the base rock and the bottom row
  // should all be at 1/2"); the middle row is exactly 1, bit for bit, so the middle cell is the
  // unmodified design; and the columns do the same for the pavilion, deepest on the left. A ratio
  // is a true height stretch (scale height's), which the next test checks on the stone itself.
  for (const n of [3, 5, 7]) {
    const cells = gridCells(stateOf(n, 100));
    const middle = (n - 1) / 2;

    for (const cell of cells) {
      if (cell.row === 0) {
        assertEqual(cell.crown, 2, `${n}x${n}: top row crown`);
      }

      if (cell.row === n - 1) {
        assertEqual(cell.crown, 0.5, `${n}x${n}: bottom row crown`);
      }

      if (cell.row === middle) {
        assertEqual(cell.crown, 1, `${n}x${n}: middle row crown`);
      }

      if (cell.column === 0) {
        assertEqual(cell.pavilion, 2, `${n}x${n}: left column pavilion`);
      }

      if (cell.column === n - 1) {
        assertEqual(cell.pavilion, 0.5, `${n}x${n}: right column pavilion`);
      }

      if (cell.column === middle) {
        assertEqual(cell.pavilion, 1, `${n}x${n}: middle column pavilion`);
      }
    }

    assertEqual(cells.length, n * n, `${n}x${n}: one cell per row and column`);
  }
});

Deno.test("the rows between step by the same factor, and a range of 0 is the centre everywhere", () => {
  // Setup: a 5 x 5 grid at 44%, and the same grid at 0%.
  // Test: the crown ratios down the first column, and every cell of the 0% grid.
  // Verifies: the exponent runs +1, +0.5, 0, -0.5, -1 down the rows, so each row is the same
  // factor (sqrt 1.44 = 1.2) taller than the one below it -- geometric steps, symmetric in ratio
  // as the user's 2x and 1/2 are; and at 0% every row and column is the centre.
  const crowns = [0, 1, 2, 3, 4].map(row => cellRatios(stateOf(5, 44), row, 0).crown);

  assertEqual([0, 1, 2, 3, 4].map(row => stepExponent(row, 5)), [1, 0.5, 0, -0.5, -1], "the exponents");

  for (let row = 0; row < 4; row++) {
    assertClose(crowns[row] / crowns[row + 1], 1.2, 1e-12, `row ${row} is 1.2x row ${row + 1}`);
  }

  for (const cell of gridCells(stateOf(5, 0))) {
    assertEqual([cell.crown, cell.pavilion], [1, 1], `0%: cell ${cell.index} is the centre`);
  }

  assertEqual(stepFactor(3, 7, 100), 1, "the middle of a 7-grid is exactly 1x at any range");
});

Deno.test("a cell's ratio is a true height stretch of its half of the stone (scale height's)", async () => {
  // Setup: the startup stone, its girdle pivots as scale height measures them, and the ratios of
  // the top-left and bottom-right cells of a 3 x 3 grid at 100% (2x and 0.5x).
  // Test: build the stone at each cell's ratios through scale height's own `scaledValues`, the
  // path the mode's preview and the grid's stones both take, and measure the crown's height (table
  // above the crown's girdle edge) and the pavilion's depth (the pavilion's girdle edge above the
  // culet).
  // Verifies: the top-left cell's crown is twice as tall and its pavilion twice as deep as the
  // design's, and the bottom-right's half -- the user's "2x the base rock" is the stone's height,
  // not only a number on the grid.
  const design = await startupDesign();
  const built = DesignMesh.buildFaces(design);
  const pivots = heightPivots(design, built);
  const bounds = builtBounds(built);
  const pristine = design.tiers.map(tier => ({ tier, angle: tier.angle, distance: tier.distance }));
  const state = stateOf(3, 100);

  for (const [row, column, factor] of [[0, 0, 2], [2, 2, 0.5]]) {
    const ratios = cellRatios(state, row, column);
    const values = scaledValues(pristine, ratios, pivots);
    const copy = {
      ...design,
      tiers: values.map(({ tier, angle, distance }) => ({ ...tier, angle, distance })),
    };
    const box = builtBounds(DesignMesh.buildFaces(copy));

    assertClose((box.max.z - pivots.crown) / (bounds.max.z - pivots.crown), factor, 1e-6,
      `cell ${row},${column}: crown height`);
    assertClose((pivots.pavilion - box.min.z) / (pivots.pavilion - bounds.min.z), factor, 1e-6,
      `cell ${row},${column}: pavilion depth`);
  }
});

Deno.test("no cell is stretched beyond scale height's own range", () => {
  // Setup: a grid re-centred at 3x (the top of what two re-centrings can reach) with a 100% range.
  // Test: every cell's ratios.
  // Verifies: each is held to scale height's gauge range (0.25x to 4x), so no preview is a stone
  // flattened into its girdle or stretched past what scale height itself would make.
  const state = { ...stateOf(7, 100), centre: { crown: 3, pavilion: 0.3 } };

  for (const cell of gridCells(state)) {
    assertEqual(cell.crown >= RATIO_MIN && cell.crown <= RATIO_MAX, true, `crown ${cell.crown} in range`);
    assertEqual(cell.pavilion >= RATIO_MIN && cell.pavilion <= RATIO_MAX, true, `pavilion ${cell.pavilion} in range`);
  }
});

// ---- the sliders

Deno.test("subdivisions are odd, from 3 to 11", () => {
  // Setup: every whole number from below the range to past it, and a few values a slider or a
  // typed readout could hand over (a fraction, a string, nonsense).
  // Test: snapSubdivisions, and withSubdivisions on a state.
  // Verifies: only 3, 5, 7, 9 and 11 ever come out (the user's "only support 3+ odd numbers", and
  // since T-0281 "can you increase the subdivision count to 11"); an even number goes to the odd
  // one above it (4 -> 5, 10 -> 11); anything below 3 is 3 and anything above 11 is 11; nonsense
  // falls back to the default; and the subdivisions change nothing else in the state.
  assertEqual([SUBDIVISIONS_MIN, SUBDIVISIONS_MAX, SUBDIVISIONS_DEFAULT], [3, 11, 5], "the constants");

  const inputs = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 100];
  const snapped = inputs.map(snapSubdivisions);

  assertEqual(snapped, [3, 3, 3, 3, 3, 5, 5, 7, 7, 9, 9, 11, 11, 11, 11, 11], "snapped whole numbers");
  assertEqual([snapSubdivisions(4.9), snapSubdivisions("5"), snapSubdivisions("x")], [5, 5, 5], "odd inputs");

  for (const value of snapped) {
    assertEqual(value % 2, 1, `${value} is odd`);
  }

  const state = stateOf(3, 20);
  const next = withSubdivisions(state, 6);

  assertEqual(next.subdivisions, 7, "withSubdivisions snaps");
  assertEqual([next.crownRange, next.pavilionRange, next.centre, next.preview],
    [state.crownRange, state.pavilionRange, state.centre, state.preview], "and changes nothing else");
});

Deno.test("9 and 11 are accepted as they are; even values and anything past 11 are not", () => {
  // Setup: the default 5 x 5 state, and the slider's own step of 2 (ManualOptimizerPanel's spec).
  // Test: (a) withSubdivisions with 9 and 11, the two sizes T-0281 adds; (b) every even value from
  // 2 to 12, and 12, 13, 15 and 99 past the cap; (c) the grid a 9 and an 11 state lays out.
  // Verifies: (a) 9 and 11 are kept exactly, not snapped down to 7 as they were before T-0281;
  // (b) an even value is never kept -- it becomes an odd neighbour -- and nothing above 11 is kept,
  // every one becoming 11, so the slider can only land on 3, 5, 7, 9 or 11; (c) 9 lays out 81 cells
  // and 11 lays out 121, each with its middle cell exactly the centre (1x, 1x) and every cell in the
  // fill order once, middle first.
  const state = stateOf(5, 20);

  assertEqual(withSubdivisions(state, 9).subdivisions, 9, "(a) 9 is kept");
  assertEqual(withSubdivisions(state, 11).subdivisions, 11, "(a) 11 is kept");

  for (const even of [2, 4, 6, 8, 10, 12]) {
    const kept = withSubdivisions(state, even).subdivisions;

    assertEqual(kept !== even && kept % 2 === 1, true, `(b) even ${even} is not kept (became ${kept})`);
  }

  for (const above of [12, 13, 15, 99]) {
    assertEqual(withSubdivisions(state, above).subdivisions, 11, `(b) ${above} is held to 11`);
  }

  for (const [n, count] of [[9, 81], [11, 121]]) {
    const big = stateOf(n, 20);
    const cells = gridCells(big);
    const middle = (n * n - 1) / 2;
    const order = fillOrder(n);

    assertEqual(cells.length, count, `(c) ${n} x ${n} is ${count} cells`);
    assertEqual([cells[middle].crown, cells[middle].pavilion], [1, 1], `(c) the ${n}-grid's middle is 1x, 1x`);
    assertEqual(order[0], middle, `(c) the ${n}-grid fills from the middle`);
    assertEqual([...order].sort((a, b) => a - b), cells.map(cell => cell.index), `(c) each ${n}-grid cell once`);
  }
});

Deno.test("the ranges are percents from 0 to 100, each its own", () => {
  // Setup: the default state.
  // Test: set the crown range to 150, the pavilion's to -5, then the crown's to 37.5.
  // Verifies: the range is held to 0-100% (100 being the user's 2x/0.5x example), each slider
  // moves only its own range, a fraction is kept as it is (a rectangle produces them), and the
  // readout shows whole percents plainly and a fraction to one place.
  assertEqual([RANGE_MIN, RANGE_MAX, RANGE_DEFAULT], [0, 100, 20], "the constants");

  let state = initialState();

  state = withRange(state, 'crown', 150);
  assertEqual([state.crownRange, state.pavilionRange], [100, 20], "the crown's is capped at 100");
  state = withRange(state, 'pavilion', -5);
  assertEqual([state.crownRange, state.pavilionRange], [100, 0], "the pavilion's is floored at 0");
  state = withRange(state, 'crown', 37.5);
  assertEqual(state.crownRange, 37.5, "a fraction is kept");
  assertEqual([formatRange(20), formatRange(9.544511501)], ["20%", "9.5%"], "the readouts");
  assertEqual(clampRange("x"), 0, "nonsense is 0");
});

// ---- a click and a rectangle

Deno.test("a click shows that cell's heights and leaves the grid as it was", () => {
  // Setup: a 5 x 5 grid at 30%.
  // Test: click the cell in row 0, column 3.
  // Verifies: the preview takes exactly that cell's ratios (tallest crown, a shallower pavilion);
  // the grid's centre, ranges and subdivisions are untouched, so every cell keeps its ratios (the
  // settled behaviour: a click only changes the stone in the middle); and `previewCell` finds the
  // clicked cell as the one the middle shows.
  const state = stateOf(5, 30);
  const clicked = clickCell(state, 0, 3);

  assertEqual(clicked.preview, cellRatios(state, 0, 3), "the preview is the cell's");
  assertEqual([clicked.centre, clicked.crownRange, clicked.pavilionRange, clicked.subdivisions],
    [state.centre, state.crownRange, state.pavilionRange, state.subdivisions], "the grid is unchanged");
  assertEqual(gridCells(clicked), gridCells(state), "every cell keeps its ratios");
  assertEqual(previewCell(clicked), 3, "the clicked cell is the one shown");
  assertEqual(previewCell(state), 12, "before the click, the middle cell was");
});

Deno.test("a rectangle's corners become the grid's new corners, for every rectangle", () => {
  // Setup: a 5 x 5 grid at 60% crown and 25% pavilion, re-centred off 1x first so the centre is
  // not special.
  // Test: every rectangle that can be dragged on it -- every pair of distinct cells, in both
  // orders -- through selectRectangle.
  // Verifies: the new grid's top-left cell has exactly the ratios the rectangle's top-left had and
  // its bottom-right the rectangle's bottom-right (the user: "the top left cell (representing the
  // tallest gemstone) and the bottom right cell (representing the most squashed gemstone)"), the
  // subdivisions stay, the preview moves to the new centre, and the order the corners were
  // dragged in does not matter.
  const base = {
    ...initialState({ subdivisions: 5, crownRange: 60, pavilionRange: 25 }),
    centre: { crown: 1.1, pavilion: 0.9 },
  };
  const n = base.subdivisions;
  let count = 0;

  for (let a = 0; a < n * n; a++) {
    for (let b = 0; b < n * n; b++) {
      const from = { row: Math.floor(a / n), column: a % n };
      const to = { row: Math.floor(b / n), column: b % n };

      if (a === b) {
        continue;
      }

      const next = selectRectangle(base, from, to);
      const cells = gridCells(next);
      const top = Math.min(from.row, to.row);
      const bottom = Math.max(from.row, to.row);
      const left = Math.min(from.column, to.column);
      const right = Math.max(from.column, to.column);

      assertEqual(sameRatios(cells[0], cellRatios(base, top, left)), true, `top-left of ${a}->${b}`);
      assertEqual(sameRatios(cells[n * n - 1], cellRatios(base, bottom, right)), true, `bottom-right of ${a}->${b}`);
      assertEqual(next.subdivisions, n, "the subdivisions stay");
      assertEqual(next.preview, next.centre, "the preview is the new centre");
      assertEqual(selectRectangle(base, to, from), next, "either corner may be dragged first");
      count++;
    }
  }

  assertEqual(count, 600, "every ordered pair of distinct cells");
});

Deno.test("an odd rectangle centres on its middle cell, an even one between cells", () => {
  // Setup: a 5 x 5 grid at 100% (rows 2, 1.414, 1, 0.707, 0.5), and a 3 x 3 at 100% (2, 1, 0.5).
  // Test: (a) the 3 x 3 rectangle from (0,0) to (2,2) of the 5-grid; (b) the 2 x 2 rectangle from
  // (0,0) to (1,1) of the 3-grid, whose middle falls between cells; (c) a 2-wide, 3-tall one.
  // Verifies:
  //   (a) the new centre is exactly the old middle cell of the rectangle (1.414x), and the new
  //       range (1 + r) is (1 + old)^(2/4) = sqrt 2, so the new rows are 2 .. 1 in the old ratios;
  //   (b) the middle of an even rectangle is the geometric mean of the two cells either side of it
  //       (sqrt(2 x 1) = 1.414x), taken in the same ratio space, and its range still lands the new
  //       corners on 2x and 1x;
  //   (c) crown and pavilion are worked out independently: the odd side centres on a cell, the
  //       even side between two.
  const odd = selectRectangle(stateOf(5, 100), { row: 0, column: 0 }, { row: 2, column: 2 });

  assertClose(odd.centre.crown, Math.SQRT2, 1e-12, "(a) centre crown is the rectangle's middle cell");
  assertClose(odd.crownRange, (Math.SQRT2 - 1) * 100, 1e-9, "(a) the range is sqrt 2 - 1");
  assertClose(spannedRange(100, 2, 5), (Math.SQRT2 - 1) * 100, 1e-9, "(a) spannedRange agrees");

  const even = selectRectangle(stateOf(3, 100), { row: 0, column: 0 }, { row: 1, column: 1 });

  assertClose(even.centre.crown, Math.sqrt(2 * 1), 1e-12, "(b) the centre is between the two rows");
  assertClose(even.centre.pavilion, Math.sqrt(2 * 1), 1e-12, "(b) and between the two columns");
  assertClose(cellRatios(even, 0, 0).crown, 2, 1e-12, "(b) the new top row is the old top row");
  assertClose(cellRatios(even, 2, 2).crown, 1, 1e-12, "(b) the new bottom row is the old middle row");
  assertEqual(previewCell(even), 4, "(b) the middle shows the new centre cell");

  const mixed = selectRectangle(stateOf(5, 100), { row: 1, column: 2 }, { row: 3, column: 3 });

  assertClose(mixed.centre.crown, 1, 1e-12, "(c) three rows: centred on the middle row");
  assertClose(mixed.centre.pavilion, Math.pow(2, -0.25), 1e-12, "(c) two columns: between 1x and 0.707x");
});

Deno.test("a rectangle one cell wide or tall collapses that range", () => {
  // Setup: a 5 x 5 grid at 40%.
  // Test: a rectangle down one column (0,1)-(4,1), and one along one row (2,0)-(2,4).
  // Verifies: taken literally, a rectangle whose top-left and bottom-right share a column share a
  // pavilion, so the pavilion's range becomes 0 and every column is that pavilion; the crown's
  // range is kept whole (the rectangle spans every row). Along a row, the same for the crown.
  const column = selectRectangle(stateOf(5, 40), { row: 0, column: 1 }, { row: 4, column: 1 });

  assertEqual(column.pavilionRange, 0, "one column: no pavilion range");
  assertClose(column.crownRange, 40, 1e-9, "the crown's range is the whole grid's");
  assertClose(column.centre.pavilion, Math.pow(1.4, 0.5), 1e-12, "every column is column 1's pavilion");

  const row = selectRectangle(stateOf(5, 40), { row: 2, column: 0 }, { row: 2, column: 4 });

  assertEqual(row.crownRange, 0, "one row: no crown range");
  assertEqual(row.centre.crown, 1, "every row is the middle row's crown");
});

Deno.test("the grid fills from the middle outwards", () => {
  // Setup: none.
  // Test: fillOrder for 3, 5 and 7.
  // Verifies: every cell appears exactly once; the middle is first; every cell of an inner ring
  // comes before any of an outer one, so the cells nearest the stone being judged draw first.
  for (const n of [3, 5, 7]) {
    const order = fillOrder(n);
    const middle = (n - 1) / 2;
    const ring = index => Math.max(Math.abs(Math.floor(index / n) - middle), Math.abs(index % n - middle));

    assertEqual([...order].sort((a, b) => a - b), [...Array(n * n).keys()], `${n}: every cell once`);
    assertEqual(order[0], middle * n + middle, `${n}: the middle first`);

    for (let i = 1; i < order.length; i++) {
      assertEqual(ring(order[i - 1]) <= ring(order[i]), true, `${n}: ring order at ${i}`);
    }
  }
});

Deno.test("the grid's frame holds every cell's stone, and not loosely", async () => {
  // Setup: the startup stone, its pivots and corners, and a 5 x 5 grid at 60% crown and 35%
  // pavilion.
  // Test: gridFrame for the grid's largest ratios (its top-left cell), then build every cell's
  // stone and measure each corner's distance from the frame's centre.
  // Verifies: every corner of every cell's stone is inside the frame's sphere -- the renderer
  // requires it (primary rays start on that sphere) -- and the sphere is not loose: the tallest
  // stone reaches at least 95% of it, so the previews fill their cells. (A sphere round the
  // stone's bounding box, the first version, reached only 65%: a hexagon's box corners are far
  // from any corner of the stone.)
  const design = await startupDesign();
  const built = DesignMesh.buildFaces(design);
  const pivots = heightPivots(design, built);
  const corners = builtCorners(built);
  const pristine = design.tiers.map(tier => ({ tier, angle: tier.angle, distance: tier.distance }));
  const state = initialState({ subdivisions: 5, crownRange: 60, pavilionRange: 35 });
  const cells = gridCells(state);
  const frame = gridFrame(corners, pivots, cells[0].crown, cells[0].pavilion);
  let furthest = 0;

  for (const cell of cells) {
    const values = scaledValues(pristine, cell, pivots);
    const copy = { ...design, tiers: values.map(({ tier, angle, distance }) => ({ ...tier, angle, distance })) };

    for (const face of DesignMesh.buildFaces(copy).faces) {
      for (const point of face.polygon) {
        const distance = Math.hypot(point.x - frame.center.x, point.y - frame.center.y, point.z - frame.center.z);

        assertEqual(distance <= frame.radius, true, `cell ${cell.index}: a corner at ${distance} of ${frame.radius}`);
        furthest = Math.max(furthest, distance);
      }
    }
  }

  assertEqual(furthest >= 0.95 * frame.radius, true, `the tallest stone fills the frame (${furthest} of ${frame.radius})`);
});

Deno.test("a stretched corner is the stone's corner at the cell's ratios", async () => {
  // Setup: the startup stone, its pivots, and the stone built at crown 1.5x and pavilion 0.75x
  // through scale height's `scaledValues`.
  // Test: stretchedCorner on every corner of the stone the mode opened on.
  // Verifies: each stretched corner is a corner of the rebuilt stone (to 1e-6), so the frame,
  // worked out from stretched corners without building anything, is the frame of the real stone;
  // and a corner of the girdle band, between the pivots, stays where it is.
  const design = await startupDesign();
  const built = DesignMesh.buildFaces(design);
  const pivots = heightPivots(design, built);
  const pristine = design.tiers.map(tier => ({ tier, angle: tier.angle, distance: tier.distance }));
  const values = scaledValues(pristine, { crown: 1.5, pavilion: 0.75 }, pivots);
  const rebuilt = builtCorners(DesignMesh.buildFaces({
    ...design, tiers: values.map(({ tier, angle, distance }) => ({ ...tier, angle, distance })),
  }));

  for (const corner of builtCorners(built)) {
    const moved = stretchedCorner(corner, pivots, 1.5, 0.75);
    const nearest = Math.min(...rebuilt.map(p => Math.hypot(p.x - moved.x, p.y - moved.y, p.z - moved.z)));

    assertEqual(nearest < 1e-6, true, `corner ${JSON.stringify(corner)} lands on the rebuilt stone (${nearest})`);

    if (corner.z < pivots.crown && corner.z > pivots.pavilion) {
      assertEqual(moved, corner, "a girdle-band corner does not move");
    }
  }
});

Deno.test("two states are the same exactly when every field is", () => {
  // Setup: the default state and copies with one field changed.
  // Test: sameState.
  // Verifies: a change to any one field is a different state (so it is a step of the mode's
  // undo), and an equal copy is the same (so a change to nothing records no step).
  const state = initialState();

  assertEqual(sameState(state, initialState()), true, "an equal copy");

  for (const changed of [
    { ...state, subdivisions: 7 }, { ...state, crownRange: 21 }, { ...state, pavilionRange: 21 },
    { ...state, centre: { crown: 1.1, pavilion: 1 } }, { ...state, centre: { crown: 1, pavilion: 1.1 } },
    { ...state, preview: { crown: 1.1, pavilion: 1 } }, { ...state, preview: { crown: 1, pavilion: 1.1 } },
  ]) {
    assertEqual(sameState(state, changed), false, `differs: ${JSON.stringify(changed)}`);
  }
});

// ---- the mode: the stone in the middle, Done, Cancel and undo

/**
 * Loads the startup stone into the tier controller with a real EditHistory behind it, wired the
 * way session.js's `startSession` wires the page's own, and returns `{ design, history }`. There is
 * no GemApp, so no stone is ever built or drawn: the tests read the design, which is what the
 * stone in the middle would be built from.
 */
async function loadWithHistory() {
  const design = await startupDesign();
  const history = EditHistory.create();

  setEditRecorder(entry => history.record(entry));
  setHistoryFrames({
    begin: () => history.beginFrame(),
    commit: label => history.commitFrame(label),
    cancel: () => {
      const ops = history.cancelFrame();

      if (ops) {
        applyEdit(ops);
      }
    },
  });
  render(design, null);
  return { design, history };
}

/** Every tier's angle and distance, to compare a design before and after. */
const snapshot = design => design.tiers.map(tier => [tier.angle, tier.distance]);

/** The design's tiers at `ratios`, computed the way the mode computes them. */
function expectedAt(design, ratios) {
  const pristine = design.tiers.map(tier => ({ tier, angle: tier.angle, distance: tier.distance }));
  const pivots = heightPivots(design, DesignMesh.buildFaces(design));

  return scaledValues(pristine, ratios, pivots).map(({ angle, distance }) => [angle, distance]);
}

Deno.test("opening shows the grid round the design as it stands, and changes nothing", async () => {
  // Setup: the startup stone loaded with a history.
  // Test: open the mode.
  // Verifies: it opens (the menu item's action returns true) at the defaults -- 5 x 5, 20% each
  // way, centred on 1x/1x with the preview there too -- the middle cell is the one shown; the
  // design is untouched bit for bit; and nothing is on either undo stack yet.
  const { design, history } = await loadWithHistory();
  const original = snapshot(design);

  assertEqual(enterManualOptimizer(), true, "the mode opened");
  assertEqual(manualOptimizerOpen(), true, "and says so");

  const store = get(manualOptimizer);

  assertEqual(store.open, true, "the store is open");
  assertEqual(store.state, initialState(), "at the defaults");
  assertEqual(store.cells.length, 25, "25 cells");
  assertEqual(store.selected, 12, "the middle cell is the one shown");
  assertEqual(snapshot(design), original, "the design is untouched");
  assertEqual([get(canUndo), get(canRedo), history.canUndo()], [false, false, false], "nothing to undo");

  cancelManualOptimizer();
  render(null, null);
});

Deno.test("a click writes that cell's heights into the design; the grid stays", async () => {
  // Setup: the startup stone loaded, the mode opened, the crown range set to 100%.
  // Test: click the top row's middle cell (crown 2x, pavilion 1x), then the bottom-left cell.
  // Verifies: the design -- the stone in the middle -- is exactly scale height's stretch at the
  // clicked cell's ratios each time; the grid's centre and ranges do not move; and the cell
  // clicked is the one marked as shown.
  const { design } = await loadWithHistory();
  const original = snapshot(design);

  enterManualOptimizer();
  setRange('crown', 100);
  previewGridCell(0, 2);
  assertEqual(snapshot(design), expectedAtFresh(original, design, { crown: 2, pavilion: 1 }), "top middle: crown 2x");

  const before = get(manualOptimizer).state;

  previewGridCell(4, 0);

  const after = get(manualOptimizer).state;

  assertEqual([after.centre, after.crownRange, after.pavilionRange], [before.centre, before.crownRange, before.pavilionRange],
    "the grid stays");
  assertEqual(after.preview, { crown: 0.5, pavilion: 1.2 }, "the preview is the bottom-left cell's");
  assertEqual(get(manualOptimizer).selected, 20, "which is the one marked");
  assertEqual(snapshot(design), expectedAtFresh(original, design, { crown: 0.5, pavilion: 1.2 }), "and the design follows");

  cancelManualOptimizer();
  render(null, null);
});

/**
 * The design's tiers at `ratios`, from the ORIGINAL values `original` (the design itself has
 * already been rewritten by the mode, so its own values cannot be the starting point).
 */
function expectedAtFresh(original, design, ratios) {
  const copy = {
    ...design,
    tiers: design.tiers.map((tier, i) => ({ ...tier, angle: original[i][0], distance: original[i][1] })),
  };

  return expectedAt(copy, ratios);
}

Deno.test("a rectangle re-centres the grid and shows its new centre", async () => {
  // Setup: the startup stone loaded, the mode opened at 3 x 3 and 100% each way.
  // Test: drag a rectangle from the top-left cell to the middle one (an even, 2 x 2 rectangle).
  // Verifies: the grid's corners become the rectangle's (2x at the top-left, 1x at the
  // bottom-right), the subdivisions stay 3, the middle cell is shown, and the design is the
  // stretch at the new centre (sqrt 2 each way).
  const { design } = await loadWithHistory();
  const original = snapshot(design);

  enterManualOptimizer();
  setSubdivisions(3);
  setRange('crown', 100);
  setRange('pavilion', 100);
  selectGridRectangle({ row: 0, column: 0 }, { row: 1, column: 1 });

  const { state, cells, selected } = get(manualOptimizer);

  assertEqual(state.subdivisions, 3, "still 3 x 3");
  assertClose(cells[0].crown, 2, 1e-12, "top-left crown");
  assertClose(cells[0].pavilion, 2, 1e-12, "top-left pavilion");
  assertClose(cells[8].crown, 1, 1e-12, "bottom-right crown");
  assertClose(cells[8].pavilion, 1, 1e-12, "bottom-right pavilion");
  assertEqual(selected, 4, "the new middle is shown");

  const expected = expectedAtFresh(original, design, state.centre);

  snapshot(design).forEach(([angle, distance], i) => {
    assertClose(angle, expected[i][0], 1e-12, `tier ${i} angle`);
    assertClose(distance, expected[i][1], 1e-12, `tier ${i} distance`);
  });

  cancelManualOptimizer();
  render(null, null);
});

Deno.test("Done is one history entry that a single undo takes back", async () => {
  // Setup: the startup stone loaded with an empty history, the mode opened.
  // Test: change the subdivisions, a range, click a cell and drag a rectangle (four steps of the
  // mode's own undo), press Done, then take one step of the edit history back and one forward.
  // Verifies: Done leaves exactly ONE entry, labelled "Manual optimizer", holding the heights the
  // middle showed; one undo restores every tier exactly, bit for bit; one redo puts the new heights
  // back; the mode is closed.
  const { design, history } = await loadWithHistory();
  const original = snapshot(design);

  enterManualOptimizer();
  setSubdivisions(7);
  setRange('pavilion', 50);
  previewGridCell(1, 5);
  selectGridRectangle({ row: 1, column: 1 }, { row: 3, column: 4 });

  const kept = snapshot(design);

  assertEqual(JSON.stringify(kept) === JSON.stringify(original), false, "the design changed");

  exitManualOptimizer();
  assertEqual(get(manualOptimizer).open, false, "Done closed the mode");
  assertEqual(snapshot(design), kept, "and kept the heights shown");
  assertEqual(history.undoLabel(), 'Manual optimizer', "the entry is labelled");

  applyEdit(history.undo());
  assertEqual(snapshot(design), original, "one undo restores every tier");
  assertEqual(history.canUndo(), false, "and that was the only entry");

  applyEdit(history.redo());
  assertEqual(snapshot(design), kept, "one redo puts the heights back");

  render(null, null);
});

Deno.test("Done with nothing changed records nothing", async () => {
  // Setup: the startup stone loaded, the mode opened.
  // Test: change only the grid (subdivisions and a range, which move no stone), then Done.
  // Verifies: the design is untouched and the edit history has nothing to undo: a session that
  // never changed the stone in the middle is no edit.
  const { design, history } = await loadWithHistory();
  const original = snapshot(design);

  enterManualOptimizer();
  setSubdivisions(3);
  setRange('crown', 70);
  exitManualOptimizer();

  assertEqual(snapshot(design), original, "the design is untouched");
  assertEqual(history.canUndo(), false, "nothing was recorded");

  render(null, null);
});

Deno.test("Cancel puts every tier back exactly and records nothing", async () => {
  // Setup: the startup stone loaded, the mode opened.
  // Test: click two cells and drag a rectangle, then Cancel.
  // Verifies: every tier's angle and distance is back bit for bit; nothing reached the history;
  // the mode is closed and a second Cancel does nothing.
  const { design, history } = await loadWithHistory();
  const original = snapshot(design);

  enterManualOptimizer();
  previewGridCell(0, 0);
  previewGridCell(4, 4);
  selectGridRectangle({ row: 0, column: 0 }, { row: 2, column: 3 });
  cancelManualOptimizer();

  assertEqual(snapshot(design), original, "every tier is back as it was");
  assertEqual([history.canUndo(), history.canRedo()], [false, false], "nothing was recorded");
  assertEqual(get(manualOptimizer).open, false, "Cancel closed the mode");
  cancelManualOptimizer();
  assertEqual(snapshot(design), original, "a second Cancel changed nothing");

  render(null, null);
});

Deno.test("Undo and Redo step the mode's own changes while it is open", async () => {
  // Setup: the startup stone loaded, an unrelated entry already in the edit history, then the mode
  // opened.
  // Test: a range change, a click and a rectangle, then Edit > Undo three times and Redo twice,
  // through session.js's own `undo` and `redo` (where the menu items and Cmd/Ctrl+Z go).
  // Verifies: each undo steps back one change -- the grid and the stone in the middle with it,
  // always recomputed from the design as it opened; the menu's greying follows the mode's stack;
  // and the entry recorded before the mode opened is never touched.
  const { design, history } = await loadWithHistory();

  history.record({ label: 'Earlier edit', ops: [{ kind: 'update', target: 'tierFlag', tier: design.tiers[0], flag: 'frosted', before: false, after: true }] });

  const original = snapshot(design);

  enterManualOptimizer();
  assertEqual([get(canUndo), get(canRedo)], [false, false], "nothing to undo in the mode yet");

  setRange('crown', 60);
  previewGridCell(0, 2);

  const afterClick = snapshot(design);
  const clickedState = get(manualOptimizer).state;

  selectGridRectangle({ row: 0, column: 0 }, { row: 2, column: 2 });
  assertEqual(get(canUndo), true, "the menu's Undo is live");

  undo();
  assertEqual(get(manualOptimizer).state, clickedState, "undo: the rectangle is gone");
  assertEqual(snapshot(design), afterClick, "and the stone is the clicked cell's again");
  undo();
  assertEqual(snapshot(design), original, "undo: the click is gone, the stone as it opened");
  assertEqual(get(manualOptimizer).state.crownRange, 60, "the range change is still there");
  undo();
  assertEqual(get(manualOptimizer).state, initialState(), "undo: back to the defaults");
  assertEqual([get(canUndo), get(canRedo)], [false, true], "nothing more to undo, something to redo");

  redo();
  redo();
  assertEqual(get(manualOptimizer).state, clickedState, "redo twice: the click is back");
  assertEqual(snapshot(design), afterClick, "and the stone with it");

  cancelManualOptimizer();
  assertEqual(snapshot(design), original, "Cancel put every tier back");
  assertEqual(history.undoLabel(), 'Earlier edit', "the edit history below the mode was never touched");

  render(null, null);
});

Deno.test("the manual optimizer holds the design, and refuses and is refused by the other modes", async () => {
  // Setup: the startup stone loaded, a tier selected.
  // Test: open edit mode and try the optimizer; close it; open scale height and try the optimizer;
  // close it; open the optimizer and try edit mode and scale height, and read the tier toolbar.
  // Verifies: one mode at a time, every way round; while the optimizer is open every toolbar
  // button is inactive and says why (another edit then would land inside its one history entry);
  // and opening it twice is refused.
  const { design } = await loadWithHistory();
  const pavilion = design.tiers.filter(tier => tier.angle < 0 && tier.angle > -90);

  highlightTier(pavilion[0]);
  assertEqual(enterEditMode(pavilion[0]), true, "edit mode opened");
  assertEqual(enterManualOptimizer(), false, "the optimizer is refused while editing");
  cancelEditMode();

  assertEqual(enterScaleHeightMode(), true, "scale height opened");
  assertEqual(enterManualOptimizer(), false, "the optimizer is refused while scaling");
  cancelScaleHeightMode();

  assertEqual(enterManualOptimizer(), true, "the optimizer opened");
  assertEqual(enterManualOptimizer(), false, "a second opening is refused");
  assertEqual(enterEditMode(pavilion[0]), false, "edit mode is refused");
  assertEqual(get(editing), null, "and nothing is being edited");
  assertEqual(enterScaleHeightMode(), false, "scale height is refused");

  const buttons = get(toolbar);

  for (const name of ['new', 'edit', 'delete', 'visibility', 'preform', 'frosted', 'comments']) {
    assertEqual(buttons[name].active, false, `${name} is inactive`);
    assertEqual(buttons[name].tip.includes('Finish the manual optimizer first'), true, `${name} says why`);
  }

  cancelManualOptimizer();
  render(null, null);
});

Deno.test("with no design loaded the mode does not open", () => {
  // Setup: no design in the tier controller (the built-in mesh, or a plain .obj).
  // Test: open the mode.
  // Verifies: it refuses, as the menu item is inert then: there are no heights to vary.
  render(null, null);
  assertEqual(enterManualOptimizer(), false, "refused with no design");
  assertEqual(get(manualOptimizer).open, false, "and stays closed");
});
