// The printed ChArUco boards' coordinate frame, shared by the phone's board detection, pose and
// rock outline (T-0322). Since T-0340 the scanner has three printed boards, one per kind of rough
// (the user, 2026-10-13): grey/black for dark rough, white/grey for light rough and white/black for
// intermediate rough, their spec files in ./boards/ (format houseki.board.v1). They share ONE layout
// -- OpenCV's ChArUco 23 x 17, 10 mm squares, 7 mm DICT_4X4_1000 markers, a grey spiral in every
// square without a marker -- and differ in their colours and in their markers: each prints its own
// run of 195 dictionary ids (`first_marker_id`), so a marker read says which board is in view
// (src/vision board.rs). Two markers are never read (`unreadable_marker_ids`): the white/grey
// board's 187 and 191, DICT_4X4_1000 ids 437 and 441, are codes the spiral in the dark squares
// reads as once the picture is blurred, so reading them would put markers in the dark squares of
// all three boards (T-0340).
// Everything geometric (corners, poses, the lens) is the same for all three,
// and BOARD_SPEC stands for the layout; what depends on the colours (the rock outline's predicted
// board, board_texture.js) takes the spec of the board in view.
//
// The frame is the scanner pipeline's (HousekiScanner src/houseki/pipeline/board.py), so a pose the
// phone finds means the same thing as one the desktop pipeline finds:
//
//   origin at the printed top-left corner of the chessboard (the corner of the dark square left of
//   the first marker); X along increasing row index (down the printed page); Y along increasing
//   column index (right on the page); Z up out of the paper; MILLIMETRES (board.py works in squares).
//
// OpenCV's own ChArUco board frame is x right (columns), y down (rows), z into the paper. The map
// between them is (x, y, z) -> (y, x, -z), a proper rotation (board.py's CV_TO_BOARD), never a
// mirror. OpenCV numbers the inner chessboard corners row-major: corner id k is at column
// k % (squares_x - 1) and row floor(k / (squares_x - 1)), i.e. OpenCV position ((col + 1), (row + 1))
// squares, which is (row + 1, col + 1) squares in this frame.

import whiteGrey from './boards/charuco_23x17_10mm_white_grey_spiral.json' with { type: 'json' };
import greyBlack from './boards/charuco_23x17_10mm_grey_black_spiral.json' with { type: 'json' };
import whiteBlack from './boards/charuco_23x17_10mm_white_black_spiral.json' with { type: 'json' };

/** The boards, in the order the detector is given them (its board index is a position here). */
export const BOARD_LIST = Object.freeze([whiteGrey, greyBlack, whiteBlack]);

/** The board specs by name (each file's name without .json, the vision message's `board.sheet`). */
export const BOARD_SPECS = Object.freeze(Object.fromEntries(BOARD_LIST.map((spec) => [spec.name, spec])));

/** The board assumed before one has been seen: the intermediate (white/black) board. */
export const BOARD_NAME = whiteBlack.name;

/** The layout the three boards share (any of their specs; geometry only). */
export const BOARD_SPEC = whiteBlack;

/** Each board's first dictionary id, in BOARD_LIST's order: the detector's set_boards. */
export const BOARD_FIRST_IDS = Object.freeze(BOARD_LIST.map((spec) => spec.first_marker_id));

/** How many inner chessboard corners (ChArUco corner ids 0 .. n-1) a board has. */
export function cornerCount(spec) {
  return (spec.squares_x - 1) * (spec.squares_y - 1);
}

/**
 * Corner id -> [X, Y, Z] in millimetres in the board frame above (Z is always 0), or null for an
 * id the board does not have, or one its spec lists as invalid (`invalid_corner_ids`: corners
 * inside or on the edge of the centre target, where the printed pattern is not a chessboard).
 */
export function cornerPoint(spec, id) {
  const perRow = spec.squares_x - 1;

  if (!Number.isInteger(id) || id < 0 || id >= cornerCount(spec)) {
    return null;
  }

  if ((spec.invalid_corner_ids ?? []).includes(id)) {
    return null;
  }

  const row = Math.floor(id / perRow);
  const col = id % perRow;
  return [(row + 1) * spec.square_mm, (col + 1) * spec.square_mm, 0];
}

/**
 * Every valid corner as { id, point: [X, Y, Z] mm }, in id order: the object points for pose
 * solving and for drawing the board.
 */
export function cornerPoints(spec) {
  const points = [];

  for (let id = 0; id < cornerCount(spec); id += 1) {
    const point = cornerPoint(spec, id);

    if (point) {
      points.push({ id, point });
    }
  }

  return points;
}

/** The printed chessboard's outline in the board frame, mm: [X rows extent, Y columns extent]. */
export function boardSizeMm(spec) {
  return [spec.squares_y * spec.square_mm, spec.squares_x * spec.square_mm];
}
