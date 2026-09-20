// What edit mode's two sliders set (2026-09-19, the user: "two vertical sliders like the ruler --
// one for the facet angle and one for the facet depth. When you're dragging the angle slider, the
// angle of the facet should change. when you're dragging the depth slider, the depth of the facet
// cut should change"), and the ticks a vertical tape ruler draws. Pure: no DOM, no design objects
// beyond the plain tier, so it is tested under Deno (web/tests/facet_edit_test.js).
//
// A tier's angle is stored as GemCad writes it: positive for the crown, negative for the
// pavilion, 180 for a flat culet (see design.js's `mastAngleOf`). The slider shows the angle the
// cutting instructions show -- always positive, 0 to 90 -- and puts the tier's own side back.
// Its depth is the tier's `distance`: how far the facet's plane sits from the stone's centre, so
// a smaller depth cuts deeper.

/** Degrees the angle slider steps by: what a GemCad file writes, two decimals. */
export const ANGLE_STEP = 0.01;
/** Ticks on the angle slider stand every this many degrees, and are labelled every 10. */
export const ANGLE_TICK = 1;
/** The depth slider's step and tick spacing, in the design's own units. */
export const DEPTH_STEP = 0.001;
export const DEPTH_TICK = 0.01;

/** True for a tier cut on the pavilion side, including a girdle at -90 and a flat culet. */
export function isPavilionSide(tier) {
  return tier.angle < 0 || tier.angle >= 180;
}

/** The angle the slider shows for a tier: positive degrees from the table, 0 to 90. */
export function angleValue(tier) {
  return tier.angle >= 180 ? 0 : Math.abs(tier.angle);
}

/**
 * The angle to store for a slider reading, keeping the tier on its own side of the girdle: a
 * crown tier stays positive, a pavilion tier negative, and a pavilion tier at 0 is the flat
 * culet GemCad writes as 180 (a plain -0 is not a thing a file can carry; see `mastAngleOf`).
 */
export function angleFor(tier, value) {
  if (!isPavilionSide(tier)) {
    return value;
  }

  return value === 0 ? 180 : -value;
}

/**
 * How far the depth slider reaches for a design: from 0 (the stone's centre) up to half again
 * the deepest facet it already has, and never less than 1.5, so there is room to cut a facet
 * shallower than any in the design. Rounded up to a tenth so the scale's labels are round.
 */
export function depthRange(design) {
  const deepest = design.tiers.reduce((most, tier) => Math.max(most, Math.abs(tier.distance)), 0);

  return { min: 0, max: Math.max(1.5, Math.ceil(deepest * 15) / 10) };
}

/** `value` held inside [min, max]. */
export function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * `value` snapped to the nearest multiple of `step` and cleaned of float dust, so an angle comes
 * out as 42.5 rather than 42.500000000000004 and is written back to the design as such.
 */
export function snapValue(value, step) {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));

  return Number((Math.round(value / step) * step).toFixed(decimals));
}

/**
 * The ticks a tape ruler draws around `position`: every multiple of `step` within `halfSpan`
 * of it and inside [min, max]. Each is `{ value, offset, major }` -- `offset` is how far it is
 * from the centre in the value's own units (so its pixel position is centre - offset * pixels
 * per unit on a tape that counts upwards), and `major` marks the ticks that carry a label,
 * every `majorEvery` steps from 0.
 */
export function visibleValueTicks(position, halfSpan, step, majorEvery, min, max) {
  const first = Math.max(Math.ceil((position - halfSpan) / step), Math.ceil(min / step));
  const last = Math.min(Math.floor((position + halfSpan) / step), Math.floor(max / step));
  const ticks = [];

  for (let at = first; at <= last; at++) {
    const value = snapValue(at * step, step);

    ticks.push({ value, offset: value - position, major: at % majorEvery === 0 });
  }

  return ticks;
}
