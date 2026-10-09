// Where to look for the board in the next frame (T-0332): the phone's full detection searches only a
// region of the picture once it knows where the board is.
//
// A whole-board view costs the detector its whole picture: every adaptive-threshold window traced
// over every pixel, every dark quadrilateral read (src/vision; measured natively on a 960 x 540
// whole-board view: 22.6 ms, of which tracing and reading are most). The rock sits on the board and
// the person keeps it in the middle of the picture, so the part of the board that matters -- for the
// pose near the rock, the outline and the guidance -- is the board around the rock. So, once a pose
// is known: the board within REGION_RADIUS_MM of the rock is projected with the pose expected for
// the new frame (the overlay's prediction, which the page sends), its bounding box grown by a share
// of its size and a few pixels, and only that is searched (measured natively: half the frame's area
// halves the time).
//
// The whole frame is still searched regularly, and whenever the region was not enough (live.js:
// at least every REGION_FULL_EVERY_MS, after a frame whose region found no pose, when no recent pose
// is known): the edges of the board feed the lens's calibration, and a board that moved away is
// found again.
//
// Plain functions on numbers (camera_model.js's projection).

import { projectPoints } from './camera_model.js';

/**
 * The board round the rock that the region covers, mm: ten squares across, dozens of corners
 * round the rock. (70 mm, measured on the lag video at 180 mm, covered more of the picture than
 * REGION_MAX_SHARE, so the region was never used at scanning distances.)
 */
export const REGION_RADIUS_MM = 50;
/** The region grows by this share of its size on each side ... */
export const REGION_PAD_SHARE = 0.15;
/** ... and at least this many pixels (x s, the frame's short side / 1080). */
export const REGION_PAD_PX = 24;
/** A region over this share of the frame is not worth it: the whole frame is searched. */
export const REGION_MAX_SHARE = 0.75;
/** The whole frame at least this often, ms. */
export const REGION_FULL_EVERY_MS = 1000;
/** A pose older than this (ms, frame time) does not give a region. */
export const REGION_POSE_MAX_AGE_MS = 400;

/**
 * The region of a frame to search for the board, in its pixels: { x, y, width, height }, or null for
 * the whole frame (the rock's surroundings do not project into the picture, or would cover most of
 * it).
 *
 * @param {{ R, t }} pose  board -> camera, for the frame to be searched
 * @param {{ f, cx, cy, k1 }} intrinsics  for that frame
 * @param {number[]} rockMm  the rock's point on the board ([X, Y] or [X, Y, Z])
 * @param {{ width, height }} frame
 * @param {object} [options]  radiusMm, padShare, padPx, maxShare: the constants above
 */
export function detectionRegion(pose, intrinsics, rockMm, frame, options = {}) {
  const radius = options.radiusMm ?? REGION_RADIUS_MM;
  const padShare = options.padShare ?? REGION_PAD_SHARE;
  const padPx = (options.padPx ?? REGION_PAD_PX) * (Math.min(frame.width, frame.height) / 1080);
  const maxShare = options.maxShare ?? REGION_MAX_SHARE;
  const points = [[rockMm[0], rockMm[1], 0]];

  for (let k = 0; k < 24; k += 1) {
    const a = (k / 24) * 2 * Math.PI;
    points.push([rockMm[0] + radius * Math.cos(a), rockMm[1] + radius * Math.sin(a), 0]);
  }

  const p = projectPoints(points, pose.R, pose.t, intrinsics);
  const xs = [];
  const ys = [];

  for (let i = 0; i < points.length; i += 1) {
    if (Number.isFinite(p[2 * i]) && Number.isFinite(p[2 * i + 1])) {
      xs.push(p[2 * i]);
      ys.push(p[2 * i + 1]);
    }
  }

  // Every point must project: a circle partly behind the camera gives no sensible box.
  if (xs.length < points.length) {
    return null;
  }

  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const grow = (size) => Math.max(padPx, padShare * size);
  const x0 = Math.max(0, Math.min(...xs) - grow(w));
  const y0 = Math.max(0, Math.min(...ys) - grow(h));
  const x1 = Math.min(frame.width, Math.max(...xs) + grow(w));
  const y1 = Math.min(frame.height, Math.max(...ys) + grow(h));

  if (!(x1 > x0 && y1 > y0)) {
    return null;    // all of it outside the picture
  }

  if ((x1 - x0) * (y1 - y0) > maxShare * frame.width * frame.height) {
    return null;
  }

  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
