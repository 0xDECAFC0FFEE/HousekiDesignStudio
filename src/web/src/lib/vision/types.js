// The hand-offs between the phone's three vision pieces (T-0322), written down once so the pieces
// can be built separately and joined by the phone page:
//
//   camera frame --board_detect.js--> BoardDetection --pose.js--> CameraPose --outline.js--> RockOutline
//
// Nothing here runs; it is JSDoc only. Coordinates: image pixels have their origin at the top-left
// corner of the top-left pixel, x right, y down, in the FULL-resolution frame the detection ran on
// (a piece that works on a downscaled copy scales its results back). Board coordinates are
// board_frame.js's (millimetres, X down the page, Y right, Z up).

/**
 * @typedef {object} FrameInfo
 * @property {number} width   pixels
 * @property {number} height  pixels
 * @property {number} timeMs  the frame's capture time (performance.now() or the video frame's
 *                            mediaTime in ms), used to pair a detection with the frame it came from
 */

/**
 * board_detect.js's output for one frame.
 *
 * @typedef {object} BoardDetection
 * @property {FrameInfo} frame
 * @property {{ id: number, corners: [number, number][] }[]} markers  decoded ArUco markers, each
 *           with its 4 image corners in OpenCV's order (clockwise from the marker's top-left)
 * @property {{ id: number, x: number, y: number, markers?: 1|2, sharpness?: number }[]} corners
 *           ChArUco chessboard corners (ids as in board_frame.js), sub-pixel refined; only ids
 *           board_frame.cornerPoint accepts. OpenCV returns corners with pixel CENTRES on
 *           integers; board_detect.js adds 0.5 to x and y for this file's convention.
 *           Optional, added by board_detect.js (T-0323) and used by intrinsics.js (T-0324) when
 *           present: `markers`, how many of the corner's two neighbouring markers were detected
 *           (2 is OpenCV's default; 1-marker corners are the desktop pipeline's second pass, less
 *           reliable: use them only when there are too few 2-marker ones), and `sharpness`, the
 *           variance of the Laplacian in the 25 x 25 px window around the corner on the frame
 *           resampled to a 1080 px short side (HousekiScanner calibrate.corner_sharpness; < 50 =
 *           blurred, re-refined). With both, the live calibration keeps to the desktop's sharp
 *           corners (>= 100, two markers)
 * @property {boolean} recognised  enough of the board seen to solve a pose (at least 8 corners
 *           that are not all on one line)
 * @property {number} elapsedMs  time the detection took
 * @property {number|null} [markerPx]  median detected marker width, full-res px (board_detect.js)
 * @property {number} [markerScale]  the desktop detector's marker-size factor m used (board_detect.js)
 */

/**
 * The camera's intrinsics for the frame size a pose was solved at. Pinhole plus one radial term,
 * as the desktop pipeline's calibration (principal point fixed at the image centre, fx = fy,
 * only k1 free). x_d = x (1 + k1 r^2) in normalised coordinates.
 *
 * @typedef {object} Intrinsics
 * @property {number} width
 * @property {number} height
 * @property {number} f    focal length in pixels (fx = fy)
 * @property {number} cx   principal point, pixels: width / 2, height / 2, the image centre in this
 *                         file's pixel convention (the desktop's (w - 1) / 2 is the same point in
 *                         OpenCV's, whose pixel centres are on integers); refinement keeps it fixed
 * @property {number} cy
 * @property {number} k1
 * @property {'table'|'one-view'|'closed-form'|'refined'|'guess'} source  where f came from ('one-view':
 *                         single slanted views before the seed, T-0336)
 * @property {number} [oneViews]   'one-view' only: good single views the median is over
 * @property {number} [rmsPx]      'refined' only: the calibration's reprojection RMS
 * @property {number} [views]      'refined' only: views the calibration used
 * @property {number} [seedViews]  'closed-form' only: frames the seed's median is over
 */

/**
 * pose.js's output: the camera relative to the board. The board-to-camera transform maps a board
 * point P (mm) to camera coordinates as R P + t (OpenCV camera: x right, y down, z forward).
 *
 * @typedef {object} CameraPose
 * @property {FrameInfo} frame
 * @property {Intrinsics} intrinsics
 * @property {number[]} R        3x3 rotation, row-major (9 numbers), board -> camera
 * @property {number[]} t        translation, mm (3 numbers), board -> camera
 * @property {number[]} center   the camera's position in the board frame, mm (= -R^T t)
 * @property {number} azimuthDeg    direction of the camera from the board's centre target, around
 *                                  Z, 0..360: 0 = toward +X (the BOTTOM of the page), 90 = toward
 *                                  +Y (right), i.e. counter-clockwise seen from above -- the
 *                                  desktop pipeline's convention (HousekiScanner
 *                                  selection.view_angles and coverage.analyse: atan2(Y, X))
 * @property {number} elevationDeg  angle of the camera above the board plane, from the target
 * @property {number} distanceMm    camera to target centre
 * @property {number} rmsPx      reprojection RMS of the inlier corners
 * @property {number} inliers    corners kept after outlier pruning
 * @property {boolean} valid     the pose passes the desktop pipeline's gates (scaled for resolution)
 * @property {string|null} reason  why not valid, in the desktop's words ('camera below the board
 *                                 plane', 'high residual (...)', 'corners disagree (...)'); null
 *                                 when valid
 * @property {number} corners    usable corners given (known ids, each once)
 * @property {number[]} inlierIds  the inlier corners' ids
 * @property {'ippe'|'ransac'} start  how the solve started: the desktop's IPPE on every corner, or
 *                                 (only after that failed the gates) a RANSAC homography's inliers
 */

/**
 * outline.js's output: where the rock is in the frame.
 *
 * @typedef {object} RockOutline
 * @property {FrameInfo} frame
 * @property {[number, number][]} contour  the rock's outer outline, image pixels (full-res frame),
 *           one closed polygon, clockwise; empty when no rock was found
 * @property {{ x: number, y: number, width: number, height: number }} box  its bounding box
 * @property {number} areaPx
 * @property {number} confidence   0..1, how sure the outline is (share of the outline with strong
 *           evidence); a guide for the overlay, not a calibrated probability
 * @property {number} elapsedMs
 * @property {string[]} [flags]  why an outline is empty or doubtful: 'no_rock' (nothing over the
 *           minimum area touches the target), 'touches_crop_edge' (the rock may be larger than the
 *           bound), 'core_not_in_crop', 'bound_not_in_front', 'bound_outside_frame' (T-0325)
 * @property {{ x: number, y: number, side: number }} [crop]  the square of the frame (pixels) the
 *           outline was searched in (T-0325)
 */

export {};
