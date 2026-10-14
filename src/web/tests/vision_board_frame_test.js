/*
 * vision_board_frame_test.js -- the board frame the phone's vision pipeline shares (T-0322).
 *
 * The phone must mean the same thing by "corner 164 is at (80, 110) mm" as the desktop scanner
 * pipeline (HousekiScanner src/houseki/pipeline/board.py, corner_points), or a pose found on the
 * phone would be in a different frame from the desktop's. These tests pin the mapping with
 * hand-worked corners. Since T-0340 the phone ships three boards of one layout; the first test pins
 * what each prints.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 */

import {
  BOARD_FIRST_IDS, BOARD_LIST, BOARD_NAME, BOARD_SPEC, BOARD_SPECS, boardSizeMm, cornerCount, cornerPoint, cornerPoints,
} from '../src/lib/vision/board_frame.js';

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

Deno.test('the three shipped boards share one layout and print their own runs of DICT_4X4_1000 ids', () => {
  // Setup: the shipped specs (board_frame.js): the white/grey, grey/black and white/black boards
  // (T-0340, one per kind of rough).
  // Test: list them; read every spec's layout fields, colours and marker runs.
  // Verifies: the build ships exactly the three, in the detector's order, with the white/black
  // board as BOARD_NAME / BOARD_SPEC (the layout, and the board assumed before one is seen); each
  // has the grid the code is written for -- 23 columns, 17 rows of 10 mm squares, 7 mm markers
  // from DICT_4X4_1000, the current (non-legacy) pattern, 352 inner corners, the stone's place in
  // the middle (85, 115) mm, nothing removed -- and its own 195 marker ids (from 250, 500, 750,
  // as printed under each board), none shared, none of the older boards' (0-249); and the dark
  // and light greys each board prints (measured on the user's PNGs).
  assertEquals(Object.keys(BOARD_SPECS), [
    'charuco_23x17_10mm_white_grey_spiral', 'charuco_23x17_10mm_grey_black_spiral', 'charuco_23x17_10mm_white_black_spiral',
  ], 'shipped boards');
  assertEquals(BOARD_LIST.map((spec) => spec.name), Object.keys(BOARD_SPECS), 'BOARD_LIST order');
  assertEquals(BOARD_NAME, 'charuco_23x17_10mm_white_black_spiral', 'BOARD_NAME');
  assert(BOARD_SPEC === BOARD_SPECS[BOARD_NAME], 'BOARD_SPEC is the white/black spec');
  assertEquals(BOARD_FIRST_IDS, [250, 500, 750], 'first marker ids');
  assertEquals(BOARD_LIST.map((spec) => [spec.colours.dark_srgb, spec.colours.light_srgb]), [[145, 255], [0, 110], [0, 255]], 'colours');

  for (const [name, spec] of Object.entries(BOARD_SPECS)) {
    assertEquals(spec.format, 'houseki.board.v1', `${name} format`);
    assertEquals([spec.squares_x, spec.squares_y, spec.square_mm, spec.marker_mm], [23, 17, 10, 7], `${name} layout`);
    assertEquals(spec.dictionary, 'DICT_4X4_1000', `${name} dictionary`);
    assertEquals(spec.legacy, false, `${name} pattern`);
    assertEquals(cornerCount(spec), 352, `${name} corners`);
    assertEquals(boardSizeMm(spec), [170, 230], `${name} size`);
    assertEquals(spec.target.centre_mm, [85, 115], `${name} centre`);
    assertEquals([spec.removed_marker_ids, spec.invalid_corner_ids], [[], []], `${name} nothing removed`);
    assertEquals(spec.spiral.levels_srgb.flat().length, 16, `${name} spiral cells`);
  }

  for (let b = 1; b < BOARD_FIRST_IDS.length; b += 1) {
    assert(BOARD_FIRST_IDS[b] >= BOARD_FIRST_IDS[b - 1] + 195, 'two boards share marker ids');
  }

  assert(BOARD_FIRST_IDS.every((first) => first >= 250 && first + 195 <= 1000), 'a board prints an older board\'s ids or ids past the dictionary');
});

Deno.test('corner ids map to the scanner pipeline frame: X down the rows, Y along the columns', () => {
  // Setup: the white/black board, which marks no corner invalid.
  // Test: look up hand-worked corners. OpenCV numbers inner corners row-major with 22 per row, at
  // OpenCV (col + 1, row + 1) squares; board.py turns that into (row + 1, col + 1).
  // Verifies: corner 0 is one square in from the top-left on both axes; corner 21 (the end of the
  // first row) is 220 mm to the RIGHT (Y), not down; corner 22 starts the second row 20 mm DOWN (X);
  // the last corner, 351, is at (160, 220); and ids outside 0..351 or not integers are refused.
  const spec = BOARD_SPECS.charuco_23x17_10mm_white_black_spiral;
  assertEquals(cornerPoint(spec, 0), [10, 10, 0]);
  assertEquals(cornerPoint(spec, 21), [10, 220, 0]);
  assertEquals(cornerPoint(spec, 22), [20, 10, 0]);
  assertEquals(cornerPoint(spec, 351), [160, 220, 0]);
  assertEquals(cornerPoint(spec, 352), null);
  assertEquals(cornerPoint(spec, -1), null);
  assertEquals(cornerPoint(spec, 1.5), null);
  assertEquals(cornerPoints(spec).length, 352);
});

Deno.test('a corner a spec lists as invalid is refused', () => {
  // Setup: the white/black spec with two corners listed as invalid (the field a board with a
  // blank patch would use; none of the three shipped boards has one).
  // Test: cornerPoint on them and on their neighbour; cornerPoints' count.
  // Verifies: the listed ids map to null and the rest still map, leaving 350 usable corners.
  const spec = { ...BOARD_SPECS.charuco_23x17_10mm_white_black_spiral, invalid_corner_ids: [164, 165] };
  assertEquals(cornerPoint(spec, 164), null);
  assertEquals(cornerPoint(spec, 165), null);
  assertEquals(cornerPoint(spec, 166), [80, 130, 0]);
  assertEquals(cornerPoints(spec).length, 350);
});
