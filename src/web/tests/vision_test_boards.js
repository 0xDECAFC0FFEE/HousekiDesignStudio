/*
 * vision_test_boards.js -- board specs for the TESTS only (T-0335). Not a test file itself (no
 * _test suffix), and never imported by the page.
 *
 * The phone supports one board, the strip sheet (src/web/src/lib/vision/board_frame.js BOARD_SPEC).
 * Its code still takes any houseki.board.v1 spec: markers the spec removes, corners it calls
 * invalid, a blank centre target with grey rings and dots (board_detect.js, board_texture.js,
 * outline.js, pose.js, intrinsics.js). The tests that exercise those parts keep using the three
 * sheets the phone recognised until T-0335, now copied to ./fixtures/boards/ (the HousekiScanner
 * project's spec files, unchanged), plus the older 22 x 22 board the scanner's reference videos
 * show, which the phone must now refuse (board_fit.js).
 *
 *   charuco_23x17_10mm_centre1        the strip's chessboard with marker 97 removed (one blank
 *                                     square in the middle)
 *   charuco_23x17_10mm_centre3x3      markers 85, 86, 97, 108, 109 removed, 12 invalid corners, two
 *                                     grey rings around the middle
 *   charuco_23x17_10mm_centre3x3_dots the same with 65 small black dots
 *   REFERENCE_22X22                   the older 22 x 22 board (17 rows printed), 0.689 markers,
 *                                     DICT_4X4_250, non-legacy: the reference videos' board, as
 *                                     tests/fixtures/charuco_real/fixture.json gives it per frame
 */

import { BOARD_SPECS } from '../src/lib/vision/board_frame.js';
import centre1 from './fixtures/boards/charuco_23x17_10mm_centre1.json' with { type: 'json' };
import centre3x3 from './fixtures/boards/charuco_23x17_10mm_centre3x3.json' with { type: 'json' };
import centre3x3Dots from './fixtures/boards/charuco_23x17_10mm_centre3x3_dots.json' with { type: 'json' };

/** The older reference board: 22 x 22 squares, 10 mm, markers 0.689 of a square, no target. */
export const REFERENCE_22X22 = Object.freeze({
  format: 'houseki.board.v1',
  dictionary: 'DICT_4X4_250',
  squares_x: 22,
  squares_y: 22,
  legacy: false,
  square_mm: 10,
  marker_ratio: 0.689,
  removed_marker_ids: [],
  invalid_corner_ids: [],
});

/** The shipped board and the test-only ones, by name. */
export const TEST_BOARD_SPECS = Object.freeze({
  ...BOARD_SPECS,
  charuco_23x17_10mm_centre1: centre1,
  charuco_23x17_10mm_centre3x3: centre3x3,
  charuco_23x17_10mm_centre3x3_dots: centre3x3Dots,
});
