/*
 * vision_test_boards.js -- board specs for the TESTS only. Not a test file itself (no _test
 * suffix), and never imported by the page.
 *
 * Since T-0340 the phone reads the scanner's three printed boards (board_frame.js BOARD_SPECS),
 * which the tests draw and detect like any others. One older board stays here, for the tests only:
 *
 *   REFERENCE_22X22   22 x 22 squares (17 rows printed), 0.689 markers, DICT_4X4_250, non-legacy:
 *                     the board of the desktop scanner's captures behind the pose and lens
 *                     fixtures (fixtures/vision_pose/), which pin the pose and the live lens to the
 *                     desktop's numbers. Only its layout matters there: those tests never detect.
 */

import { BOARD_SPECS } from '../src/lib/vision/board_frame.js';

/** The desktop captures' board: 22 x 22 squares, 10 mm, markers 0.689 of a square. */
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

/** The boards the tests draw and detect: the three the phone reads. */
export const TEST_BOARD_SPECS = BOARD_SPECS;
