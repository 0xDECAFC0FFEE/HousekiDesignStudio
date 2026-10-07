/*
 * vision_region_test.js -- where the phone's full detection looks once it knows where the board is
 * (T-0332): src/web/src/lib/vision/region.js.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * Plain geometry: a camera from tests/vision_test_support.js lookAtPose over the strip sheet, the
 * rock at the sheet's target; the region is checked against projectPoints' own projection of the
 * board round the rock. What the region saves and costs on real detections is
 * tests/harness/test_vision_detect.py's (the fast path's study) and test_scan_lag.py's.
 */

import {
  detectionRegion, REGION_MAX_SHARE, REGION_PAD_PX, REGION_PAD_SHARE, REGION_RADIUS_MM,
} from '../src/lib/vision/region.js';
import { projectPoints } from '../src/lib/vision/camera_model.js';
import { lookAtPose } from './vision_test_support.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

const FRAME = { width: 1280, height: 720 };
const LENS = { width: 1280, height: 720, f: 1000, cx: 640, cy: 360, k1: 0.02 };
const ROCK = [80, 110, 0];

/** The projections of the board circle REGION_RADIUS_MM round the rock (and the rock). */
function circlePixels(pose) {
  const points = [ROCK];

  for (let k = 0; k < 24; k += 1) {
    const a = (k / 24) * 2 * Math.PI;
    points.push([ROCK[0] + REGION_RADIUS_MM * Math.cos(a), ROCK[1] + REGION_RADIUS_MM * Math.sin(a), 0]);
  }

  const p = projectPoints(points, pose.R, pose.t, LENS);
  return points.map((_, i) => [p[2 * i], p[2 * i + 1]]);
}

Deno.test('detectionRegion: the board round the rock, padded, inside the frame', () => {
  // Setup: a camera 300 mm from the rock, 45 degrees up (a whole-board view: the 50 mm circle round
  // the rock covers a sixth of the picture).
  // Test: the region for that pose.
  // Verifies: every projected point of the circle (and the rock) lies inside the region, at least
  // the pad (REGION_PAD_SHARE of the circle's extent, or REGION_PAD_PX x s) from its edges where the
  // frame allows; the region lies inside the frame; it is smaller than REGION_MAX_SHARE of it.
  const pose = lookAtPose(ROCK, 30, 45, 300);
  const region = detectionRegion(pose, LENS, ROCK, FRAME);
  assert(region, 'a region');
  const pixels = circlePixels(pose);
  const xs = pixels.map((p) => p[0]);
  const ys = pixels.map((p) => p[1]);
  const padX = Math.max(REGION_PAD_PX * (720 / 1080), REGION_PAD_SHARE * (Math.max(...xs) - Math.min(...xs)));
  const padY = Math.max(REGION_PAD_PX * (720 / 1080), REGION_PAD_SHARE * (Math.max(...ys) - Math.min(...ys)));
  assert(Math.abs(region.x - Math.max(0, Math.min(...xs) - padX)) < 1e-6, `left edge ${region.x}`);
  assert(Math.abs(region.y + region.height - Math.min(720, Math.max(...ys) + padY)) < 1e-6, 'bottom edge');
  assert(pixels.every(([x, y]) => x >= region.x && y >= region.y && x <= region.x + region.width && y <= region.y + region.height), 'contains the circle');
  assert(region.x >= 0 && region.y >= 0 && region.x + region.width <= 1280 && region.y + region.height <= 720, 'inside the frame');
  const share = (region.width * region.height) / (1280 * 720);
  console.log(`  300 mm, 45 degrees: region ${region.width.toFixed(0)} x ${region.height.toFixed(0)} px, ${(100 * share).toFixed(0)}% of the frame`);
  assert(share < REGION_MAX_SHARE, `share ${share}`);
});

Deno.test('detectionRegion: the whole frame when the region would cover most of it, or cannot be drawn', () => {
  // Setup: the camera close over the rock (100 mm, straight down: the circle fills the picture);
  // a camera looking away, with the rock behind it.
  // Test: the region for each.
  // Verifies: null (the whole frame) for both: a region over REGION_MAX_SHARE of the frame saves
  // little, and a circle partly behind the camera gives no sensible box.
  assert(detectionRegion(lookAtPose(ROCK, 0, 89, 100), LENS, ROCK, FRAME) === null, 'close up: whole frame');
  // Camera 400 mm along +X from the rock, looking further along +X (azimuth 180: it stands on the
  // target's -X side): the rock is behind it.
  const away = lookAtPose([ROCK[0] + 500, ROCK[1], 0], 180, 5, 100);
  assert(detectionRegion(away, LENS, ROCK, FRAME) === null, 'rock behind the camera: whole frame');
});

Deno.test('detectionRegion: follows the rock across the picture and is cut at the frame', () => {
  // Setup: the camera aimed 80 mm to the side of the rock, so the rock is near the picture's edge.
  // Test: the region.
  // Verifies: the region sits on the rock's side of the picture (the rock's projection inside it),
  // and stops at the frame's edge (no negative or past-the-edge coordinates).
  const pose = lookAtPose([ROCK[0], ROCK[1] + 80, 0], 30, 45, 300);
  const region = detectionRegion(pose, LENS, ROCK, FRAME);
  const [rock] = circlePixels(pose);
  assert(region && rock[0] >= region.x && rock[0] <= region.x + region.width, `rock ${rock} in ${JSON.stringify(region)}`);
  assert(region.x >= 0 && region.x + region.width <= 1280 + 1e-9 && region.y >= 0 && region.y + region.height <= 720 + 1e-9, 'cut at the frame');
});
