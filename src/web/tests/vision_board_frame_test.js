/*
 * vision_board_frame_test.js -- the board frame the phone's vision pipeline shares (T-0322).
 *
 * The phone must mean the same thing by "corner 164 is at (80, 110) mm" as the desktop scanner
 * pipeline (HousekiScanner src/houseki/pipeline/board.py, corner_points), or a pose found on the
 * phone would be in a different frame from the desktop's. These tests pin the mapping with
 * hand-worked corners and with the centre target's own invalid-corner list, which the scanner
 * project wrote independently.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 */

import {
  BOARD_NAME, BOARD_SPEC, BOARD_SPECS, boardSizeMm, cornerCount, cornerPoint, cornerPoints,
} from '../src/lib/vision/board_frame.js';
import { TEST_BOARD_SPECS } from './vision_test_boards.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

function assertEquals(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${message || 'not equal'}: got ${a}, expected ${e}`);
}

Deno.test('the one shipped board is the strip sheet: 23 x 17, 10 mm, DICT_4X4_250', () => {
  // Setup: the shipped specs (board_frame.js), and the tests' own copies of the three other sheets
  // the scanner project prints (vision_test_boards.js).
  // Test: list the shipped boards; read every 23 x 17 spec's layout fields.
  // Verifies: the build ships exactly one board, the strip sheet (T-0335: the only board the phone
  // supports), named and exported as BOARD_NAME / BOARD_SPEC, printing every marker and corner; and
  // every 23 x 17 sheet, shipped or test-only, has the grid the code is written for -- 23 columns,
  // 17 rows of 10 mm squares, 7 mm markers from DICT_4X4_250, the current (non-legacy) pattern, and
  // 22 x 16 = 352 inner corners -- so the test-only sheets exercise the same layout.
  assertEquals(Object.keys(BOARD_SPECS), ['charuco_23x17_10mm_strip'], 'shipped boards');
  assertEquals(BOARD_NAME, 'charuco_23x17_10mm_strip', 'BOARD_NAME');
  assert(BOARD_SPEC === BOARD_SPECS[BOARD_NAME], 'BOARD_SPEC is the shipped spec');
  assertEquals([BOARD_SPEC.removed_marker_ids, BOARD_SPEC.invalid_corner_ids], [[], []], 'nothing removed');

  for (const [name, spec] of Object.entries(TEST_BOARD_SPECS)) {
    assertEquals(spec.format, 'houseki.board.v1', `${name} format`);
    assertEquals([spec.squares_x, spec.squares_y, spec.square_mm, spec.marker_mm], [23, 17, 10, 7], `${name} layout`);
    assertEquals(spec.dictionary, 'DICT_4X4_250', `${name} dictionary`);
    assertEquals(spec.legacy, false, `${name} pattern`);
    assertEquals(cornerCount(spec), 352, `${name} corners`);
    assertEquals(boardSizeMm(spec), [170, 230], `${name} size`);
  }
});

Deno.test('corner ids map to the scanner pipeline frame: X down the rows, Y along the columns', () => {
  // Setup: the strip board, which marks no corner invalid.
  // Test: look up hand-worked corners. OpenCV numbers inner corners row-major with 22 per row, at
  // OpenCV (col + 1, row + 1) squares; board.py turns that into (row + 1, col + 1).
  // Verifies: corner 0 is one square in from the top-left on both axes; corner 21 (the end of the
  // first row) is 220 mm to the RIGHT (Y), not down; corner 22 starts the second row 20 mm DOWN (X);
  // the last corner, 351, is at (160, 220); and ids outside 0..351 or not integers are refused.
  const spec = BOARD_SPECS.charuco_23x17_10mm_strip;

  assertEquals(cornerPoint(spec, 0), [10, 10, 0]);
  assertEquals(cornerPoint(spec, 21), [10, 220, 0]);
  assertEquals(cornerPoint(spec, 22), [20, 10, 0]);
  assertEquals(cornerPoint(spec, 351), [160, 220, 0]);
  assertEquals(cornerPoint(spec, 352), null);
  assertEquals(cornerPoint(spec, -1), null);
  assertEquals(cornerPoint(spec, 1.5), null);
  assertEquals(cornerPoints(spec).length, 352);
});

Deno.test('the centre target\'s invalid corners are the ones this mapping puts on the target', () => {
  // Setup: the 3 x 3 centre-target board (a test-only spec since T-0335). Its spec lists the target as cells rows 7-9, columns
  // 10-12 (x 70-100 mm, y 100-130 mm) and, separately, 12 invalid corner ids, both written by the
  // scanner project's board maker.
  // Test: map every listed invalid id with the same formula as cornerPoint (bypassing its refusal).
  // Verifies: each invalid corner lies inside or on the edge of the target's x/y ranges -- an
  // independent check that this module's id-to-position mapping is the scanner project's; and
  // cornerPoint refuses them, leaving 340 usable corners.
  const spec = TEST_BOARD_SPECS.charuco_23x17_10mm_centre3x3;
  const [x0, x1] = spec.target.x_range_mm;
  const [y0, y1] = spec.target.y_range_mm;

  for (const id of spec.invalid_corner_ids) {
    const x = (Math.floor(id / 22) + 1) * 10;
    const y = ((id % 22) + 1) * 10;
    assert(x >= x0 && x <= x1 && y >= y0 && y <= y1, `invalid corner ${id} at (${x}, ${y}) is off the target`);
    assertEquals(cornerPoint(spec, id), null, `invalid corner ${id} accepted`);
  }

  assertEquals(cornerPoints(spec).length, 352 - 12);
});
