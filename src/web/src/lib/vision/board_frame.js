// The printed ChArUco board's coordinate frame, shared by the phone's board detection, pose and
// rock outline (T-0322). The board is the HousekiScanner project's printable strip sheet,
// charuco_23x17_10mm_strip, copied with its spec file into ./boards/ (format houseki.board.v1). It
// is the only board the phone supports (the user, 2026-10-07, T-0335: "we don't need to support any
// board other than" it); the three other sheets the scanner project prints, with a blank target in
// the middle, were dropped then with the phone's sheet picker. Every piece of the phone pipeline
// still takes a spec rather than assuming a layout, so the tests can give it others (the older
// boards of the real-frame fixtures, src/web/tests/vision_test_boards.js).
//
// The frame is the scanner pipeline's (HousekiScanner src/houseki/pipeline/board.py), so a pose the
// phone finds means the same thing as one the desktop pipeline finds:
//
//   origin at the printed top-left corner of the chessboard (the corner of the black square left of
//   marker 0); X along increasing row index (down the printed page); Y along increasing column
//   index (right on the page); Z up out of the paper; MILLIMETRES (board.py works in squares).
//
// OpenCV's own ChArUco board frame is x right (columns), y down (rows), z into the paper. The map
// between them is (x, y, z) -> (y, x, -z), a proper rotation (board.py's CV_TO_BOARD), never a
// mirror. OpenCV numbers the inner chessboard corners row-major: corner id k is at column
// k % (squares_x - 1) and row floor(k / (squares_x - 1)), i.e. OpenCV position ((col + 1), (row + 1))
// squares, which is (row + 1, col + 1) squares in this frame.

import strip from './boards/charuco_23x17_10mm_strip.json' with { type: 'json' };

/** The board's name (its file name without .json), as the vision message's `board.sheet` sends it. */
export const BOARD_NAME = 'charuco_23x17_10mm_strip';

/** The board's spec. */
export const BOARD_SPEC = strip;

/** The board specs this build ships, by name: the one board. */
export const BOARD_SPECS = Object.freeze({ [BOARD_NAME]: strip });

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
