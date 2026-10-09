/*
 * vision_render.js -- a small pinhole renderer of the printed sheets, in plain JS, for the phone
 * vision's integration tests (T-0326: vision_live_test.js, vision_tracker_test.js). Not a test
 * file itself (no _test suffix).
 *
 * Each pixel's ray (2 x 2 rays per pixel, averaged, so edges are anti-aliased) is cut with the
 * board plane through the pose (outline_geometry.pixelToBoard) and given the sheet's reflectance
 * there (board_texture.js's texture, which draws the chessboard, the markers, the centre target's
 * rings and dots exactly; plus, for the strip sheet, its colour and grey patches in the margins,
 * which the texture leaves out). Paper beyond the texture; a dark table beyond the sheet's
 * margins. An optional "rock" is a disc on the board (a flat stand-in: what matters to these tests
 * is which board points it hides) in a brown that is neither ink nor paper.
 *
 * Code value = 255 x (ink + (1 - ink) x albedo)^(1 / 2.2), ink 0.07: the camera's tone curve over
 * the print, as the outline's model has it. No noise or blur unless asked for.
 */

import { renderBoardTexture, sampleBoardTexture } from '../src/lib/vision/board_texture.js';
import { pixelToBoard } from '../src/lib/vision/outline_geometry.js';
import { seededRandom, gaussian, lookAtPose } from './vision_test_support.js';

const INK = 0.07;
const ROCK_RGB = [120, 82, 60];
const TABLE_RGB = [40, 40, 44];

const code = (albedo) => 255 * (INK + (1 - INK) * albedo) ** (1 / 2.2);

/**
 * A camera pose (types.js CameraPose fields R, t, center, intrinsics) looking at `target` (board
 * mm) from an azimuth / elevation / distance, for a frame of `width` x `height` with focal length
 * `f` px and distortion `k1`.
 */
export function cameraPose(target, { azimuthDeg, elevationDeg, distanceMm, rollDeg = 0, width, height, f, k1 = 0 }) {
  const { R, t } = lookAtPose(target, azimuthDeg, elevationDeg, distanceMm, rollDeg);
  const center = [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
  return { R, t, center, intrinsics: { width, height, f, cx: width / 2, cy: height / 2, k1, source: 'guess' } };
}

const textures = new Map();

function textureFor(spec) {
  if (!textures.has(spec)) {
    textures.set(spec, renderBoardTexture(spec, { ppm: 8, padMm: 40 }));
  }

  return textures.get(spec);
}

/**
 * RGBA pixels of `spec` seen through `pose`: { data: Uint8ClampedArray, width, height }.
 *
 * @param {object} spec  a houseki.board.v1 spec (BOARD_SPECS)
 * @param {object} pose  cameraPose()'s
 * @param {object} [options]
 *   rock: { centreMm: [X, Y], radiusMm } a disc hiding the board there
 *   noise: Gaussian noise sigma, code values (default 0); seed
 *   sheetMarginMm: paper beyond the chessboard before the table (default 30)
 */
export function renderSheet(spec, pose, options = {}) {
  const { width, height } = pose.intrinsics;
  const texture = textureFor(spec);
  const data = new Uint8ClampedArray(width * height * 4);
  const random = seededRandom(options.seed ?? 1);
  const margin = options.sheetMarginMm ?? 30;
  const sizeX = spec.squares_y * spec.square_mm;
  const sizeY = spec.squares_x * spec.square_mm;
  const patches = spec.strip?.patches ?? [];
  const rock = options.rock ?? null;

  const colourAt = (X, Y) => {
    if (rock && Math.hypot(X - rock.centreMm[0], Y - rock.centreMm[1]) <= rock.radiusMm) {
      return ROCK_RGB;
    }

    if (X < -margin || Y < -margin || X > sizeX + margin || Y > sizeY + margin) {
      return TABLE_RGB;
    }

    for (const patch of patches) {
      const [xa, xb] = patch.x_range_mm;
      const [ya, yb] = patch.y_range_mm;

      if (X >= xa && X <= xb && Y >= ya && Y <= yb) {
        // The patch as printed: ink plus the sRGB intent, through the same tone curve.
        return patch.srgb.map((c) => code(((c / 255) ** 2.2)));
      }
    }

    const albedo = sampleBoardTexture(texture, X, Y);
    const grey = code(albedo);
    return [grey, grey, grey];
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sum = [0, 0, 0];

      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const hit = pixelToBoard(pose, x + ox, y + oy);
        const c = hit ? colourAt(hit.X, hit.Y) : TABLE_RGB;
        sum[0] += c[0] / 4;
        sum[1] += c[1] / 4;
        sum[2] += c[2] / 4;
      }

      const k = 4 * (y * width + x);
      const n = options.noise ? options.noise * gaussian(random) : 0;
      data[k] = sum[0] + n;
      data[k + 1] = sum[1] + n;
      data[k + 2] = sum[2] + n;
      data[k + 3] = 255;
    }
  }

  return { data, width, height };
}

/** `image` (RGBA) reduced by an integer factor, each output pixel the mean of a block. */
export function downscale(image, factor) {
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let sum = 0;

        for (let j = 0; j < factor; j += 1) {
          for (let i = 0; i < factor; i += 1) {
            sum += image.data[4 * ((y * factor + j) * image.width + x * factor + i) + c];
          }
        }

        data[4 * (y * width + x) + c] = sum / (factor * factor);
      }
    }
  }

  return { data, width, height };
}

/** The rock disc's outline as a polygon in frame pixels (for the picker's "under the rock"). */
export function rockContour(pose, rock, n = 48) {
  const out = [];
  const { R, t } = pose;
  const { f, cx, cy } = pose.intrinsics;

  for (let k = 0; k < n; k += 1) {
    const a = (2 * Math.PI * k) / n;
    const P = [rock.centreMm[0] + rock.radiusMm * Math.cos(a), rock.centreMm[1] + rock.radiusMm * Math.sin(a), 0];
    const X = R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t[0];
    const Y = R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t[1];
    const Z = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t[2];
    out.push([f * (X / Z) + cx, f * (Y / Z) + cy]);
  }

  return out;
}
