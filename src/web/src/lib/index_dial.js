// The index dial: a ring of tick marks round the stone, one per tooth of the index gear, shown
// while the stone is being looked at very nearly face-up or face-down (2026-09-19, the user:
// "within about 5 degrees of y=0 deg and y= 180 deg can you add a circle of tick marks around
// the stone with ticks on each index gear index? use the same major tick logic as the ruler.
// Show index values on the major ticks. make the circle radius like 20% larger than the longest
// axis of the girdle").
//
// Why only near face-on: the dial is a flat circle lying in the girdle's plane, and it only
// reads as a dial while it is seen flat. Tilted away it becomes an ellipse edge-on to the eye,
// its ticks bunch up at the sides and its numbers cross the stone, which is noise rather than
// information -- and the index of a facet is only a bearing round the stone, which is exactly
// what a face-on view shows. Face-DOWN (y = 180) counts as well, because the pavilion is cut by
// index just as the crown is.
//
// It does not snap on and off, though (2026-09-19, the user: "can you make the tick marks fade
// in and out when the y rotation's 5 to 10 degrees off from 0 or 180"): full strength out to 5
// degrees, then fading over the next 5 to nothing at 10. See `dialOpacity`.
//
// Worked out in the design's own frame (optical axis +Z, the design's units; the frame
// `GemApp::project_file_points` takes), with no DOM and no GemApp, so it is tested under Deno;
// IndexDial.svelte projects the points and draws them.
//
// The tick spacing is NOT decided here: `bigTickStep` is the sub bar's ruler's own rule,
// imported from index_ruler.js, so the two can never disagree about which teeth are major (the
// user: "use the same major tick logic as the ruler"). 96 teeth gives a major every 6, 80 every
// 5.
//
// Reads the design helpers from the globals the page's classic scripts publish (GemCadDesign),
// as edit_geometry.js and tier_controller.js do.

import { bigTickStep } from './index_ruler.js';

/**
 * How far from face-on (y rotation 0) or face-down (180) the dial is at full strength, in
 * degrees: the user's "within about 5 degrees".
 */
export const FACE_ON_DEGREES = 5;

/** How far out it has faded away to nothing: the far end of the user's "5 to 10 degrees off". */
export const FADE_OUT_DEGREES = 10;

/**
 * The dial's radius as a multiple of the girdle's own (half the stone's longest axis): the
 * user's "like 20% larger than the longest axis of the girdle", so the ring clears the widest
 * part of the stone by a fifth of it whichever way the stone is turned.
 */
export const DIAL_CLEARANCE = 1.2;

// A tick's length, and how far out a major tick's number sits, as fractions of the dial's
// radius -- so the dial keeps its proportions on a stone of any size, at any zoom.
const MINOR_TICK = 0.035;
const MAJOR_TICK = 0.075;
const LABEL_GAP = 0.14;

/**
 * How far a y rotation of `tilt` degrees is from looking straight down on the stone (0) or
 * straight up at it (180), in degrees, 0 to 90. Any real angle, wound or negative, since the
 * stone is orbited freely and nothing wraps `tilt` back into a range.
 */
export function offFaceOn(tilt) {
  const wound = ((tilt % 360) + 360) % 360;

  return Math.min(wound, Math.abs(wound - 180), 360 - wound);
}

/**
 * How strongly the dial is drawn at a y rotation of `tilt` degrees: 1 out to FACE_ON_DEGREES,
 * 0 from FADE_OUT_DEGREES, and a smooth fade between the two, so it comes and goes as the stone
 * is turned instead of blinking (the user, 2026-09-19). Smoothstepped rather than straight-line:
 * the fade then starts and ends gently, which is what stops the last of it snapping off. It is
 * still exactly half way at half way, 7.5 degrees.
 */
export function dialOpacity(tilt) {
  const off = offFaceOn(tilt);

  if (off <= FACE_ON_DEGREES) {
    return 1;
  }

  if (off >= FADE_OUT_DEGREES) {
    return 0;
  }

  const left = (FADE_OUT_DEGREES - off) / (FADE_OUT_DEGREES - FACE_ON_DEGREES);

  return left * left * (3 - 2 * left);
}

/**
 * The dial for `design` on a `teeth`-tooth gear, round a girdle of radius `girdleRadius` at
 * height `girdleZ` (stone_stats.js's `girdleCircle`). Every point is in the design's frame:
 *
 *   radius   the ring's own radius, DIAL_CLEARANCE times the girdle's.
 *   ticks    one per tooth, in index order, each `{ index, big, base, tip }`: `base` on the
 *            ring and `tip` further out, further still for a major tick. The bases are also
 *            the ring itself -- a circle drawn through them is the circle the ticks stand on,
 *            so it costs no extra points to project.
 *   labels   `{ index, at }` for each major tick, `at` being where its number goes, outside
 *            the tick. Only the major ticks are numbered, as on the ruler.
 *
 * Null when there is nothing to draw: no design, no gear, or a stone with no width.
 */
export function indexDial(design, teeth, girdleRadius, girdleZ) {
  if (!design || !(teeth >= 1) || !(girdleRadius > 0)) {
    return null;
  }

  const radius = girdleRadius * DIAL_CLEARANCE;
  const step = bigTickStep(teeth);
  const ticks = [];
  const labels = [];

  for (let index = 0; index < teeth; index++) {
    // Where that tooth points, seen from above: the direction a facet cut at it faces. Taken
    // from the design's own gear (its tooth count, its origin and which way it turns) rather
    // than worked out here, so a tick always lands on the facets that index cuts.
    const facing = GemCadDesign.normalOf(design, 90, index);
    const length = Math.hypot(facing.x, facing.y);

    if (!(length > 0)) {
      continue;
    }

    const x = facing.x / length;
    const y = facing.y / length;
    const big = index % step === 0;
    const at = distance => ({ x: x * distance, y: y * distance, z: girdleZ });

    ticks.push({
      index,
      big,
      base: at(radius),
      tip: at(radius * (1 + (big ? MAJOR_TICK : MINOR_TICK))),
    });

    if (big) {
      labels.push({ index, at: at(radius * (1 + LABEL_GAP)) });
    }
  }

  return ticks.length > 0 ? { radius, ticks, labels } : null;
}
