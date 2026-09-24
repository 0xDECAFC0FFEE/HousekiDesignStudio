// Resize girdle (T-0237). The user (2026-09-23): "lets also add a resize girdle mode. it replaces
// the render bar with the girdle resizer. the girdle resizing bar just has a depth gauge with no
// numbers. it evenly increases or decreases the depth of all faceting tiers by the ratio unless the
// tier is a girdle tier where it doesn't affect the [girdle]. similar logic as edit mode - when
// you're in resize mode can make changes and undo locally but only after done the changes are all
// committed at once." (The message was cut off after "doesn't affect the"; read as "the girdle".)
//
// T-0241, the user, 2026-09-24: "only modify the pavilion facet depths, don't modify the crown
// facet depths." So the rule narrows: only a PAVILION tier follows the gauge now; a crown tier
// (the table included) keeps its distance, exactly as a girdle tier already did.
//
// T-0242, the user, 2026-09-24: "when stretching up and down the girdle, instead of changing the
// depth uniformly [change it] such that all the meetpoints on the girdle line up." A ratio moves a
// steep facet and a shallow one by different heights (each facet's distance is its own plane's
// perpendicular offset, not a height), so a whole-pavilion ratio leaves the girdle uneven whenever
// two pavilion tiers meet at different mast angles. The fix: the gauge is now a HEIGHT z, and every
// pavilion facet's plane is moved by the SAME vector (0, 0, -z) along the stone's optical axis --
// a rigid translation of the whole pavilion, not a scale -- so every meetpoint between two pavilion
// facets (or a pavilion facet and the girdle) still meets, just z higher or lower.
//
// The math and the gauge's constants, pure: no DOM, no stores, no GemApp, so it is tested under
// Deno (web/tests/resize_girdle_test.js). resize_girdle_mode.js is the mode around it.
//
// THE RULE. Every PAVILION tier's `distance` (its depth of cut, from the design's centre) becomes
// the distance it had when the mode opened, PLUS z times that facet's own cos(cutting angle); a
// crown tier or a girdle tier keeps its distance. Angles and indices never change.
//
// THE SIGN, DERIVED FROM THE PLANE, NOT GUESSED. A facet is `{ normal, offset }` with
// `dot(normal, p) = offset` (GemCadDesign.planesOf, src/js/design.js) -- offset is exactly the
// tier's `distance`. Translating every point of a plane by a vector t moves its offset by
// `dot(normal, t)`: `normal.(p + t) = offset + normal.t`. Moving the whole pavilion by t = (0, 0,
// -z) -- z > 0 lowers it, per the ticket -- therefore moves every pavilion tier's distance by
// `-z * normal.z`:
//
//     new distance = old distance - z * normal.z
//
// `normal.z` is `cos(polarAngle)` (GemCadDesign.normalOf), and `polarAngle` is
// `GemCadDesign.polarAngleOf(tier.angle)` -- reused here rather than re-derived, so this shares the
// SAME -90/180 sentinel handling `planesOf` itself relies on (see
// kb/the-polar-internal-representation.md): an ordinary pavilion tier's polar angle is
// `180 + angle`, so `normal.z = cos(180 + angle) = -cos(angle)` and the formula above becomes
// `distance + z * cos(angle)` -- the ticket's own "depth + z cos(a)", since `cos` is even and the
// tier's stored `angle` is already `-a`. A FLAT CULET (tier.angle === 180, design.js's on-axis
// sentinel, "points straight down" -- not a real mast angle) is the one case that shortcut would
// get backwards if applied literally (`cos(180deg) = -1`, not the `+1` a flat, downward-facing
// normal actually has): `polarAngleOf(180)` returns 180 unchanged rather than folding it through
// `180 + angle`, so going through `polarAngleOf` (as `normalZOf` below does) gets both cases right
// from the one general rule, exactly as `planesOf` does.
//
// Every pavilion facet moving by the identical vector is what keeps the girdle level: two pavilion
// tiers that used to meet the girdle at the same height still do, because "the same height" is a
// property of a RIGID SHIFT, not of a per-facet ratio.
//
// WHAT IT DOES GEOMETRICALLY. z > 0 moves the pavilion DOWN the optical axis (away from the crown):
// the girdle's planes are unmoved, so the pavilion now reaches deeper past them -- the girdle band
// gets taller, and the stone gets taller too, by exactly z (the culet is on-axis, normal (0, 0,
// -1), so its own distance moves by exactly z, the plainest case of the rule above). z < 0 moves it
// UP, shrinking the band, until the girdle's plane is outside the (now shorter) pavilion and cuts
// nothing there (the tier stays in the design, with no faces, and comes back as z rises). The crown
// never moves, so the table keeps its size and every crown facet its exact plane.
//
// WHICH TIERS ARE PAVILION TIERS. The same classification scale height uses for its own two
// gauges (scale_height.js's `gaugeOf`, built on tiers.js's `isGirdleTier` and `isPavilionTier`):
// null for a girdle tier, `'pavilion'` for a negative mast angle, the girdle (already excluded)
// or a flat culet, `'crown'` for everything else (an ordinary crown tier or the table). Not a
// second classification.

import { gaugeOf } from './scale_height.js';

const DEGREES = Math.PI / 180;

/**
 * The z-component of a pavilion facet's outward unit normal -- `cos(polarAngle)`, following
 * `GemCadDesign.normalOf` (src/js/design.js) exactly, through `GemCadDesign.polarAngleOf` rather
 * than a direct `cos(angle)`, so the on-axis flat-culet sentinel (angle 180) resolves the same way
 * `planesOf` itself resolves it. `GemCadDesign` is one of the classic scripts `boot.js` runs before
 * any mode can open (see edit_geometry.js, export_gcs.js and others for the same global reference).
 */
function normalZOf(angle) {
  return Math.cos(globalThis.GemCadDesign.polarAngleOf(angle) * DEGREES);
}

// ---- the gauge
//
// One ValueRuler, drawn with no numbers at all (no tick labels, no reading above the tape; the
// user: "just has a depth gauge with no numbers"). Ticks 10px apart, like the angle ruler and scale
// height's gauges, so every gauge on the page feels alike under the pointer.
//
// THE GAUGE IS A HEIGHT NOW, NOT A RATIO, so it is not scale-free the way a ratio was: these two
// constants are in the SAME units as a tier's own `distance` (the startup stone's own units,
// unrelated to screen pixels), chosen by measuring the startup stone, and are not automatically
// right for a design of a very different size (T-0241's own note on its old, ratio-based range
// still applies: "a design with a thick girdle may want a wider range; it is one constant").
//
// RE-MEASURED for T-0242 (DesignMesh.buildFaces at each z, on hex_cut_v2, pavilion tiers moved by
// the rule above), the girdle band's height and the stone's own height H = 1.12599 (its top, the
// table, is fixed at every z; only the bottom, the culet, moves, by exactly -z):
//
//   z        -0.17  -0.15  -0.10  -0.05  -0.046  -0.044   0     0.05   0.10   0.15   0.20   0.25   0.28
//   z / H    -.151  -.133  -.089  -.044  -.041   -.039    0    .044   .089   .133   .178   .222   .249
//   band %    gone   gone   gone   gone   gone    0.54%  4.44%  8.88% 13.33% 17.77% 22.21% 26.65% 29.31%
//   faces      61     61     61     67     67      67     67     67    67     67     67     67     67
//
// (Below z = -0.046 the girdle's own plane sits entirely outside the now-shorter pavilion and cuts
// nothing, so its tier keeps 0 of its own 6 faces while the other 61 are unaffected -- the drop
// from 67 to 61 IS those 6 facets vanishing, not a second tier lost; that only happens much further
// out, past z = -0.25, well below RESIZE_MIN.)
//
// z = 0 is the centre mark, same as the old gauge's 1x -- no change at all. Below it the effect
// saturates at "gone" quickly (the girdle is a thin band; -0.046 is where it empties), while above
// it the band keeps growing with no nearby stopping point (facet count is still 67 all the way to
// 0.28 and well beyond), so the range is NOT the same distance either way from 0 -- the same
// asymmetry T-0241's ratio range had, for the same reason:
//   * RESIZE_MIN -0.17 sits comfortably past the vanishing point (-0.046), so "the girdle is gone"
//     is a real stretch of the tape, not a hair's width at the very bottom, and stops short of
//     -0.25 where a second tier's worth of facets would also go (67 -> 61 -> 49);
//   * RESIZE_MAX 0.28 gives a band just over a quarter of the stone's own height (29.3%), a clearly
//     visible change, without spending tape where nothing new happens structurally (facet count
//     does not move again for a long way past it).
// At 2000px per 1 unit (RESIZE_TICK * RESIZE_PX_PER_UNIT = 10px, the same on-screen tick spacing
// every other gauge on the page uses); the whole range is 900px of drag.

/** See above for why -0.17/0.28, not the same distance either way from 0. */
export const RESIZE_MIN = -0.17;
export const RESIZE_MAX = 0.28;
/** What a drag, a key or a wheel step snaps to. */
export const RESIZE_STEP = 0.0005;
/** Ticks every 0.005, every fifth one longer (..., -0.01, -0.005, 0, 0.005, 0.01, ...). */
export const RESIZE_TICK = 0.005;
export const RESIZE_MAJOR_EVERY = 5;
/** Screen pixels per 1 unit: with RESIZE_TICK, a tick every 10px; the whole range is 900px of drag. */
export const RESIZE_PX_PER_UNIT = 2000;
/** Only for the tape's accessible value text; nothing is drawn with it. */
export const RESIZE_DECIMALS = 3;
/**
 * Where the tape carries its one special mark, since it has no numbers to say where z = 0 is: a
 * longer, brighter tick (ValueRuler's `mark`).
 */
export const RESIZE_MARK = 0;
/** The gauge as every session starts: no shift at all. */
export const INITIAL_Z = 0;

// ---- the resize

/** Whether a tier follows the gauge: a pavilion tier only (see the head of this file). */
export function followsGauge(tier) {
  return gaugeOf(tier) === 'pavilion';
}

/**
 * A tier's angle and distance after the pavilion is moved by height `z`: the distance minus
 * `z * normalZOf(angle)` (see the head of this file for why), the angle as it was. A girdle tier, a
 * crown tier, and any tier at z exactly 0, comes back unchanged -- the same object's values, bit
 * for bit -- so opening the mode and pressing Done without moving the gauge records nothing.
 */
export function resizedTier({ angle, distance }, z) {
  if (z === 0 || !followsGauge({ angle })) {
    return { angle, distance };
  }

  return { angle, distance: distance - z * normalZOf(angle) };
}

/**
 * Every tier's angle and distance at height `z`, computed afresh from `pristine` -- the design as
 * it stood when the mode opened, `[{ tier, angle, distance }]` -- never from what an earlier
 * setting left behind, so no amount of dragging back and forth can drift. Returns `[{ tier, angle,
 * distance }]` in the same order, as tier_controller.js's `setTierValues` takes it.
 */
export function resizedValues(pristine, z) {
  return pristine.map(({ tier, angle, distance }) => ({ tier, ...resizedTier({ angle, distance }, z) }));
}
