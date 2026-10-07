// Which printed sheet the phone is looking at (T-0326, part of T-0322).
//
// Four board sheets ship (./boards/, board_frame.js BOARD_SPECS). They are the same 23 x 17
// ChArUco board with 10 mm squares and differ only around the middle, where the rock goes:
//
//   charuco_23x17_10mm_centre3x3_dots  a blank 3 x 3-square target (markers 85, 86, 97, 108, 109
//                                      removed) with two grey rings and 65 small black dots
//   charuco_23x17_10mm_centre3x3       the same target without the dots
//   charuco_23x17_10mm_centre1         one blank square (marker 97 removed); the squares around
//                                      it are the chessboard's: black, or white with a marker
//   charuco_23x17_10mm_strip           no target (nothing removed), and grey and colour patches
//                                      in the margins left and right of the chessboard
//
// For the camera's pose the difference hardly matters: the phone detects with a spec that removes
// nothing (detectionSpec) and keeps only what the chosen sheet really prints (filterDetection).
// For the rock's outline it matters a lot: the outline predicts the bare sheet around the rock and
// calls rock whatever the prediction does not explain, so a wrong sheet reads printed squares or
// dots as rock. So the sheet is recognised from the frames, from evidence that only one sheet can
// give, gathered over many frames (the rock hides some of it in every view):
//
//   - marker 97 read in a frame          only the strip sheet prints it
//   - marker 85, 86, 108 or 109 read      the small-target and strip sheets print them
//   - the eight squares around the centre (rows 7-9, columns 10-12 less the middle): black
//     squares and markers on the small-target and strip sheets, plain paper on the two
//     large-target sheets (read as the mean grey over the square's middle, which a thin ring or
//     a few dots hardly move: a black square reads ~1 x the ink level, a marker ~2.2, paper ~3.3);
//   - the dots: dark against the paper 1.2 mm around them on the dotted sheet only;
//   - the margin patches: red, green and blue on the strip sheet, paper on the others.
//
// The appearance tests sample the frame at board points projected through the frame's pose, and
// compare with the sheet's own black squares around the target (a ratio, so exposure does not
// matter). A point is not used when it is outside the frame, too small to resolve, or under the
// rock: inside the last rock outline (grown by 15%); until the first outline has been looked for,
// none of the target's points are used. Each test votes once per frame, and the decision is
// re-made from all the votes after every frame (pickSheet), so later, stronger evidence can
// overturn an early guess.
//
// Until the evidence decides, the sheet is DEFAULT_SHEET ('default'); the person can also choose
// one on the phone ('chosen'), which overrides the evidence.

import { BOARD_SPECS, cornerPoint } from './board_frame.js';
import { spansPlane } from './board_detect.js';
import { projectPoints } from './camera_model.js';

/** The sheet assumed until the frames say otherwise: the strip sheet, the one the scanner prints
 *  (the user, 2026-10-06, T-0330). It was the large target with dots until then. */
export const DEFAULT_SHEET = 'charuco_23x17_10mm_strip';

/** The sheet assumed when the frames show a blank target but not yet whether it has dots. */
const BLANK_TARGET_SHEET = 'charuco_23x17_10mm_centre3x3_dots';

/** The sheets' names as the phone and the studio show them. */
export { SHEET_LABELS } from '../scan_vision.js';

/** Markers only some sheets print. */
const MARKER_STRIP_ONLY = 97;
const MARKERS_DIAGONAL = [85, 86, 108, 109];

/** Squares (row, col) around the target's middle that are printed on centre1 and strip -- black
 *  beside it, a marker at its corners -- and plain paper on the large-target sheets; with the
 *  ratio to the ink level under which a square reads printed, and over which it reads paper. A
 *  black square's middle reads ~1; a marker's, about half ink, ~2.2; paper ~3.3 (code values,
 *  ink at 7% of paper's reflectance, through a 2.2 tone curve). */
const PRINTED_CELLS = [
  ...[[7, 11], [8, 10], [8, 12], [9, 11]].map((cell) => ({ cell, printed: 1.8, paper: 2.6 })),
  ...[[7, 10], [7, 12], [9, 10], [9, 12]].map((cell) => ({ cell, printed: 2.5, paper: 2.9 })),
];

/** Black squares around the target on every sheet: the frame's local ink level. */
const BLACK_CELLS = [[6, 10], [6, 12], [10, 10], [10, 12], [7, 9], [9, 9], [7, 13], [9, 13], [8, 8], [8, 14]];

/** Votes a test needs before it decides, and how far it must lead the other way. */
const MIN_VOTES = 3;
const LEAD = 2;

/** A spec that removes no marker and no corner: what the phone detects with, whatever the sheet. */
export function detectionSpec(spec) {
  return { ...spec, removed_marker_ids: [], invalid_corner_ids: [] };
}

/**
 * A BoardDetection made with detectionSpec, cut down to what `spec` prints: markers it removes
 * and corners it calls invalid are dropped, and `recognised` is recomputed (board_detect.js's
 * rule: at least 8 corners spanning the plane).
 */
export function filterDetection(detection, spec) {
  const removed = new Set(spec.removed_marker_ids ?? []);
  const corners = detection.corners.filter((c) => cornerPoint(spec, c.id));
  const perRow = spec.squares_x - 1;
  const squares = corners.map(({ id }) => [(id % perRow) + 1, Math.floor(id / perRow) + 1]);

  return {
    ...detection,
    markers: detection.markers.filter((m) => !removed.has(m.id)),
    corners,
    recognised: corners.length >= 8 && spansPlane(squares),
  };
}

/**
 * The decision from the votes so far. Pure, so the rules can be tested on their own.
 *
 * @param {object} votes  counts of frames: marker97, markerDiagonal, sideBlack, sidePaper,
 *                        patches, noPatches, dots, noDots
 * @returns {{ name: string, from: 'auto'|'default', why: string }}
 */
export function pickSheet(votes) {
  const v = { marker97: 0, markerDiagonal: 0, sideBlack: 0, sidePaper: 0, patches: 0, noPatches: 0, dots: 0, noDots: 0, ...votes };
  const wins = (a, b) => a >= MIN_VOTES && a >= LEAD * b;

  // Only the strip sheet prints marker 97 and colour patches.
  if (v.marker97 >= 2 || wins(v.patches, v.noPatches)) {
    return { name: 'charuco_23x17_10mm_strip', from: 'auto', why: v.marker97 >= 2 ? 'marker 97 seen' : 'colour patches seen' };
  }

  // Black squares (or the diagonal markers) beside the centre: the small target, or the strip
  // sheet with its marker 97 hidden under the rock; the strip's margins tell them apart.
  if ((v.markerDiagonal >= 2 && v.sidePaper < MIN_VOTES) || wins(v.sideBlack, v.sidePaper)) {
    if (wins(v.noPatches, v.patches)) {
      return { name: 'charuco_23x17_10mm_centre1', from: 'auto', why: 'black squares beside the centre, plain margins' };
    }

    return { name: 'charuco_23x17_10mm_centre1', from: 'auto', why: 'black squares beside the centre' };
  }

  if (wins(v.sidePaper, v.sideBlack) && v.markerDiagonal < 2) {
    if (wins(v.dots, v.noDots)) {
      return { name: 'charuco_23x17_10mm_centre3x3_dots', from: 'auto', why: 'blank target with dots' };
    }

    if (wins(v.noDots, v.dots)) {
      return { name: 'charuco_23x17_10mm_centre3x3', from: 'auto', why: 'blank target without dots' };
    }

    return { name: BLANK_TARGET_SHEET, from: 'default', why: 'blank target; dots not decided yet' };
  }

  return { name: DEFAULT_SHEET, from: 'default', why: 'not enough seen yet' };
}

/** Point in polygon (even-odd), for a closed polygon of [x, y]. */
function insidePolygon(polygon, x, y) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * A sampler of one frame through its pose: grey level (0..255) or RGB at board points, with
 * visibility (in the frame, in front of the camera, resolved, not under the rock).
 *
 * @param {{ data: Uint8ClampedArray|Uint8Array, width: number, height: number }} image  RGBA, at
 *        `scale` x the pose's frame size (the phone samples a downscaled copy)
 * @param {number} scale  image pixels per frame pixel
 * @param {object} pose   types.js CameraPose in frame pixels
 * @param {[number, number][]|null} rock  the rock's outline in frame pixels, or null for none
 */
export function frameSampler(image, scale, pose, rock) {
  const { data, width, height } = image;
  const W = pose.intrinsics.width;
  const H = pose.intrinsics.height;
  let grown = null;

  if (rock && rock.length >= 3) {
    let cx = 0;
    let cy = 0;
    rock.forEach(([x, y]) => {
      cx += x / rock.length;
      cy += y / rock.length;
    });
    grown = rock.map(([x, y]) => [cx + 1.15 * (x - cx), cy + 1.15 * (y - cy)]);
  }

  // Bilinear RGB at frame pixel (x, y) (corner-origin): image pixel centres sit at i + 0.5.
  function rgb(x, y) {
    const u = Math.min(width - 1.001, Math.max(0, x * scale - 0.5));
    const v = Math.min(height - 1.001, Math.max(0, y * scale - 0.5));
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const out = [0, 0, 0];

    for (const [di, dj, w] of [[0, 0, (1 - fu) * (1 - fv)], [1, 0, fu * (1 - fv)], [0, 1, (1 - fu) * fv], [1, 1, fu * fv]]) {
      const k = 4 * ((j + dj) * width + i + di);
      out[0] += w * data[k];
      out[1] += w * data[k + 1];
      out[2] += w * data[k + 2];
    }

    return out;
  }

  const grey = (x, y) => {
    const [r, g, b] = rgb(x, y);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };

  /** Board points (mm) -> frame pixels, NaN behind the camera. */
  const project = (points) => projectPoints(points, pose.R, pose.t, pose.intrinsics);

  /** Whether a projected pixel can be read: in the frame (3 px in) and not under the rock. */
  const visible = (x, y) => Number.isFinite(x) && Number.isFinite(y) && x > 3 && y > 3 && x < W - 3 && y < H - 3
    && !(grown && insidePolygon(grown, x, y));

  /** Frame pixels per mm at a board point (from a 1 mm step along X and along Y). */
  function pxPerMm([X, Y]) {
    const p = project([[X, Y, 0], [X + 1, Y, 0], [X, Y + 1, 0]]);
    return Math.min(Math.hypot(p[2] - p[0], p[3] - p[1]), Math.hypot(p[4] - p[0], p[5] - p[1]));
  }

  /**
   * The mean grey of an n x n grid of board points within +-half mm of a centre, or null when any
   * of them is not visible.
   */
  function patchGrey([X, Y], half, n = 3) {
    const points = [];

    for (let a = 0; a < n; a += 1) {
      for (let b = 0; b < n; b += 1) {
        points.push([X + half * ((2 * a) / (n - 1) - 1), Y + half * ((2 * b) / (n - 1) - 1), 0]);
      }
    }

    const p = project(points);
    let sum = 0;

    for (let k = 0; k < points.length; k += 1) {
      if (!visible(p[2 * k], p[2 * k + 1])) {
        return null;
      }

      sum += grey(p[2 * k], p[2 * k + 1]);
    }

    return sum / points.length;
  }

  /**
   * The mean grey of an n x n grid of board points within +-half mm of a centre, over the points
   * that are visible, or null when fewer than `minShare` of them are.
   */
  function patchVisibleGrey([X, Y], half, n = 7, minShare = 0.6) {
    const points = [];

    for (let a = 0; a < n; a += 1) {
      for (let b = 0; b < n; b += 1) {
        points.push([X + half * ((2 * a) / (n - 1) - 1), Y + half * ((2 * b) / (n - 1) - 1), 0]);
      }
    }

    const p = project(points);
    const values = [];

    for (let k = 0; k < points.length; k += 1) {
      if (visible(p[2 * k], p[2 * k + 1])) {
        values.push(grey(p[2 * k], p[2 * k + 1]));
      }
    }

    if (values.length < minShare * points.length) {
      return null;
    }

    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /** The mean RGB of the same grid, or null. */
  function patchRgb([X, Y], half, n = 3) {
    const points = [];

    for (let a = 0; a < n; a += 1) {
      for (let b = 0; b < n; b += 1) {
        points.push([X + half * ((2 * a) / (n - 1) - 1), Y + half * ((2 * b) / (n - 1) - 1), 0]);
      }
    }

    const p = project(points);
    const sum = [0, 0, 0];

    for (let k = 0; k < points.length; k += 1) {
      if (!visible(p[2 * k], p[2 * k + 1])) {
        return null;
      }

      const c = rgb(p[2 * k], p[2 * k + 1]);
      sum[0] += c[0] / points.length;
      sum[1] += c[1] / points.length;
      sum[2] += c[2] / points.length;
    }

    return sum;
  }

  return { grey, rgb, project, visible, pxPerMm, patchGrey, patchVisibleGrey, patchRgb };
}

const cellCentre = (spec, [row, col]) => [(row + 0.5) * spec.square_mm, (col + 0.5) * spec.square_mm];

/**
 * One frame's votes from its appearance (see the header). Returns an object with any of
 * sideBlack, sidePaper, patches, noPatches, dots, noDots set to 1.
 *
 * @param {ReturnType<typeof frameSampler>} sampler
 * @param {{ rockKnown: boolean }} options  rockKnown: the outline has been looked for (so the
 *        target's points are known not to be under the rock)
 */
export function appearanceVotes(sampler, { rockKnown }) {
  const votes = {};
  const dotsSpec = BOARD_SPECS.charuco_23x17_10mm_centre3x3_dots;
  const stripSpec = BOARD_SPECS.charuco_23x17_10mm_strip;
  const spec = dotsSpec;   // the four sheets share the chessboard's geometry

  // The ink level: the black squares around the target, sampled well inside (+-2.5 mm).
  const blacks = BLACK_CELLS.map((cell) => sampler.patchGrey(cellCentre(spec, cell), 2.5)).filter((v) => v !== null);

  if (blacks.length < 2) {
    return votes;
  }

  blacks.sort((a, b) => a - b);
  const ink = Math.max(4, blacks[blacks.length >> 1]);

  // The squares around the centre, each read over its middle +-2.5 mm, as much of it as is
  // visible; the frame votes when at least two read clearly and all of those agree.
  if (rockKnown) {
    let printed = 0;
    let paper = 0;

    for (const { cell, printed: under, paper: over } of PRINTED_CELLS) {
      const value = sampler.patchVisibleGrey(cellCentre(spec, cell), 2.5);

      if (value !== null) {
        printed += value / ink < under ? 1 : 0;
        paper += value / ink > over ? 1 : 0;
      }
    }

    if (printed >= 2 && paper === 0) {
      votes.sideBlack = 1;
    } else if (paper >= 2 && printed === 0) {
      votes.sidePaper = 1;
    }
  }

  // The dots, where the frame resolves them (a 0.6 mm dot at least ~1.8 px): each against the
  // paper 1.2 mm around it (the median of 8 points), the median over the visible dots.
  if (rockKnown && sampler.pxPerMm(dotsSpec.target.centre_mm) >= 3) {
    const ratios = [];

    for (const [X, Y] of dotsSpec.target.dots_mm) {
      const centre = sampler.project([[X, Y, 0]]);

      if (!sampler.visible(centre[0], centre[1])) {
        continue;
      }

      const ring = [];

      for (let k = 0; k < 8; k += 1) {
        const a = (k * Math.PI) / 4;
        const p = sampler.project([[X + 1.2 * Math.cos(a), Y + 1.2 * Math.sin(a), 0]]);

        if (sampler.visible(p[0], p[1])) {
          ring.push(sampler.grey(p[0], p[1]));
        }
      }

      if (ring.length >= 6) {
        ring.sort((a, b) => a - b);
        const paper = ring[ring.length >> 1];

        if (paper > 2 * ink) {
          ratios.push(sampler.grey(centre[0], centre[1]) / paper);
        }
      }
    }

    if (ratios.length >= 8) {
      ratios.sort((a, b) => a - b);
      const median = ratios[ratios.length >> 1];

      if (median < 0.88) {
        votes.dots = 1;
      } else if (median > 0.95) {
        votes.noDots = 1;
      }
    }
  }

  // The strip sheet's colour patches (red, green, blue: one strongest channel each, in RGB order
  // 0, 1, 2), in its margins; on the other sheets the same places are plain paper. The margins
  // are far from the rock, so they need no outline.
  let coloured = 0;
  let plain = 0;

  for (const patch of stripSpec.strip.patches) {
    const channel = { red: 0, green: 1, blue: 2 }[patch.id];

    if (channel === undefined) {
      continue;
    }

    const c = sampler.patchRgb(patch.centre_mm, 3);

    if (!c) {
      continue;
    }

    const others = [0, 1, 2].filter((k) => k !== channel).map((k) => c[k]);
    const brightest = Math.max(...c);
    const spread = brightest - Math.min(...c);

    if (c[channel] === brightest && c[channel] - Math.max(...others) > 20) {
      coloured += 1;
    } else if (spread < 15 && brightest > 2 * ink) {
      plain += 1;
    }
  }

  if (coloured >= 2) {
    votes.patches = 1;
  } else if (plain >= 2 && coloured === 0) {
    votes.noPatches = 1;
  }

  return votes;
}

/**
 * The live picker.
 *
 * @param {{ chosen?: string|null }} [options]  a sheet the person chose (a BOARD_SPECS name)
 */
export function createBoardPicker(options = {}) {
  const votes = { marker97: 0, markerDiagonal: 0, sideBlack: 0, sidePaper: 0, patches: 0, noPatches: 0, dots: 0, noDots: 0 };
  let chosen = options.chosen && BOARD_SPECS[options.chosen] ? options.chosen : null;
  let frames = 0;

  function current() {
    if (chosen) {
      return { name: chosen, spec: BOARD_SPECS[chosen], from: 'chosen', why: 'chosen on the phone', votes: { ...votes } };
    }

    const pick = pickSheet(votes);
    return { ...pick, spec: BOARD_SPECS[pick.name], votes: { ...votes } };
  }

  return {
    current,

    /**
     * Adds one frame's evidence. `detection` is the frame's detection with detectionSpec (every
     * marker kept), in frame pixels; `pose` its valid pose (or null); `image`/`scale` the RGBA
     * copy the frame was detected on; `rock` the last outline's contour (null: none found) and
     * `rockKnown` whether the outline has been looked for at all.
     */
    observe({ detection, pose = null, image = null, scale = 1, rock = null, rockKnown = false }) {
      frames += 1;
      const ids = new Set(detection.markers.map((m) => m.id));

      if (ids.has(MARKER_STRIP_ONLY)) {
        votes.marker97 += 1;
      }

      if (MARKERS_DIAGONAL.some((id) => ids.has(id))) {
        votes.markerDiagonal += 1;
      }

      if (pose?.valid && image) {
        const frameVotes = appearanceVotes(frameSampler(image, scale, pose, rock), { rockKnown });

        for (const [key, value] of Object.entries(frameVotes)) {
          votes[key] += value;
        }
      }

      return current();
    },

    /** The person's choice (a BOARD_SPECS name), or null to go back to recognising it. */
    choose(name) {
      chosen = name && BOARD_SPECS[name] ? name : null;
      return current();
    },

    reset() {
      Object.keys(votes).forEach((key) => {
        votes[key] = 0;
      });
      frames = 0;
    },

    get frames() {
      return frames;
    },
  };
}
