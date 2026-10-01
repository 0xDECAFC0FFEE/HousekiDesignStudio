// Rotate by index (T-0287). The user, 2026-09-29: "can you add support for rotate index mode - it
// needs a slider to the right along with the cancel/done buttons".
//
// The math and the slider's constants, pure: no DOM, no stores, no GemApp, so it is tested under
// Deno (web/tests/rotate_index_test.js). rotate_index_mode.js is the mode around it.
//
// THE RULE. The whole design turns about its own axis by a whole number of index teeth, `steps`:
// every facet's index becomes (index + steps) modulo the gear's tooth count. Angles and distances
// never change, and neither does the gear itself (tooth count, direction, origin). A facet's
// physical azimuth is `(index - originIndex) * 360 / signedTeeth` (GemCadDesign.normalOf), so
// adding the same whole number to every index turns every plane by the same angle about the
// optical axis: the stone is the same stone, turned. That also means it keeps every symmetry it
// had -- a rotation commutes with the design's own rotational symmetry, and a mirror line turns
// with the stone -- see "SYMMETRY" below for the one thing that does move.
//
// NORMALISED THE WAY THE DESIGN ALREADY NORMALISES TEETH, so the cutting instructions read as they
// would for a design opened from a file:
//   * an index is kept in [0, teeth) -- design.js's `polarOf` and `snapIndexToTooth` wrap every
//     index they produce into that range, so a rotated tooth that passes the gear's end starts
//     again at 0 rather than reading 97 or -1;
//   * each tier's facets are then sorted into ascending tooth order -- design.js's
//     `sortTierFacets` (T-0240, the user: "when loading a file can you sort all the facet
//     indices"), which every load runs. Sorting moves the facet OBJECTS, not bare numbers, so a
//     facet's name and frosting travel with it. A tier at 0-16-32-48-64-80 turned by -1 therefore
//     reads 15-31-47-63-79-95, not 95-15-31-47-63-79.
//
// ON-AXIS TIERS DO NOT MOVE. A table (angle 0) or a flat culet (angle 180) lies across the axis:
// every index describes the same plane, and design.js stores its index as 0 on purpose
// ("canonicalise the pole", kb/the-polar-internal-representation.md). Turning it would change a
// number that means nothing and nothing on the stone, so such a tier keeps index 0.
//
// SYMMETRY. `design.symmetry` (folds, and whether it is mirrored) is only a description a file
// carries; nothing stores where a mirror line lies. A rotation keeps both properties of the STONE
// exactly: its facets are still in `folds` equal copies round the axis, and still mirror images
// of each other about a line -- the line has turned with the stone, to k/2 teeth further on. What
// can change is WHERE a mirror line lies: a line through tooth m moves to tooth m + k, so one that
// passed through tooth 0 still does only when 2k is a whole number of the design's repeat,
// teeth / folds. The design's symmetry fields are left as they are (both are still true of the
// stone); kb/rotate-by-index-mode.md has the reasoning, and what it may mean for a file's reader.
//
// FRACTIONAL TEETH. A design with fractional teeth on (T-0171) still turns by WHOLE teeth: the
// fraction is carried unchanged, since the slider has whole-tooth stops, the same as the gear.

import { isTableTier, isCuletTier } from './tiers.js';

// ---- the slider

/**
 * The slider's two ends for a `teeth`-tooth gear: one full turn with no position repeated, centred
 * on 0 (the design as it opened) so a small turn either way is a short drag from the middle.
 * 96 teeth give -47 to +48, 80 give -39 to +40, and an odd gear such as 55 gives -27 to +27 --
 * `teeth` positions in each case, since +48 and -48 on a 96-tooth gear are the same tooth.
 */
export function rotationRange(teeth) {
  return { min: -Math.floor((teeth - 1) / 2), max: Math.floor(teeth / 2) };
}

/** What every session starts at: no turn at all. */
export const INITIAL_STEPS = 0;

/** One whole tooth a stop: the slider, its arrow keys and a typed value all land on whole teeth. */
export const ROTATION_STEP = 1;

/**
 * Any whole number of teeth as the slider's own position for the same turn: 96 is 0 again, -50 on
 * a 96-tooth gear is +46. Used for a typed value, which may be any whole number, and so that no
 * two slider positions ever name the same turn.
 */
export function wrapSteps(steps, teeth) {
  const { max } = rotationRange(teeth);
  const turn = ((Math.round(steps) % teeth) + teeth) % teeth;

  return turn > max ? turn - teeth : turn;
}

/** The turn in degrees of the index wheel: `steps` teeth of 360 / teeth each. */
export function rotationDegrees(steps, teeth) {
  return steps * 360 / teeth;
}

/**
 * The slider's reading: the turn in teeth, then in degrees, signed so the direction reads at a
 * glance -- "+3 teeth · 11.25°", "−1 tooth · −3.75°", "0 teeth · 0.00°". A real minus sign, not a
 * hyphen, which is how the rest of the page prints a negative reading.
 */
export function formatRotation(steps, teeth) {
  const sign = value => (value > 0 ? '+' : value < 0 ? '−' : '');
  const count = Math.abs(steps);
  const degrees = rotationDegrees(steps, teeth);

  return `${sign(steps)}${count} ${count === 1 ? 'tooth' : 'teeth'} · ` +
    `${sign(steps)}${Math.abs(degrees).toFixed(2)}°`;
}

// ---- the rotation

/** Whether a tier turns with the design: everything except the table and a flat culet (above). */
export function followsRotation(tier) {
  return !isTableTier(tier) && !isCuletTier(tier);
}

/**
 * One index turned by `turn` teeth, `turn` already in [0, teeth): the result stays in [0, teeth).
 * A whole index stays whole and exact; a fractional one keeps its fraction to float precision.
 */
function turnedIndex(index, turn, teeth) {
  const turned = index + turn;

  return turned >= teeth ? turned - teeth : turned;
}

/**
 * A tier's facets and their indexes (tier_controller.js's `tierFacetState`, `{ facets, indexes }`)
 * turned by `steps` teeth on a `teeth`-tooth gear, re-sorted into ascending tooth order with each
 * facet object keeping its own index. A turn of a whole number of full turns (0, teeth, -teeth...)
 * returns `state` itself -- the very same object, arrays and numbers -- so a session that ends
 * where it began changes nothing, bit for bit, and records nothing.
 */
export function rotatedFacetState(state, steps, teeth) {
  const turn = ((Math.round(steps) % teeth) + teeth) % teeth;

  if (turn === 0) {
    return state;
  }

  const pairs = state.facets.map((facet, at) => ({ facet, index: turnedIndex(state.indexes[at], turn, teeth) }));

  // Array.prototype.sort is stable, so two facets on one tooth (a copy made by New) keep their
  // order, as sortTierFacets keeps it.
  pairs.sort((a, b) => a.index - b.index);

  return { facets: pairs.map(pair => pair.facet), indexes: pairs.map(pair => pair.index) };
}

/**
 * Every tier's facet state for a turn of `steps` teeth, computed afresh from `pristine` -- the
 * design as it stood when the mode opened, `[{ tier, state }]` -- never from what an earlier
 * position left behind, so no amount of dragging back and forth can drift. A table or a flat culet
 * keeps its pristine state (`followsRotation`). Returns `[{ tier, state }]` in the same order.
 */
export function rotatedStates(pristine, steps, teeth) {
  return pristine.map(({ tier, state }) => ({
    tier,
    state: followsRotation(tier) ? rotatedFacetState(state, steps, teeth) : state,
  }));
}
