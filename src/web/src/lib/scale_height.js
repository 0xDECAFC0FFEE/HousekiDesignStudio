// Scale height (T-0231): tangent-ratio scaling of the crown and the pavilion. The user
// (2026-09-23): "i want to implement tangent ratio scaling ... this has two gauges that start at
// 1x, and scale up or down. the left gauge is the pavilion ratio and the right is the crown ...
// if our crown tangent ratio given by the gauge is tr, all crown facet angles should be updated
// to InvTan(Tan(OldAngle) * tr). same thing with pavilion."
//
// The math and the gauges' own bookkeeping, pure: no DOM, no stores, no GemApp, so it is tested
// under Deno (web/tests/scale_height_test.js). scale_height_mode.js is the mode around it.
//
// WHY THE DISTANCES MOVE TOO, NOT ONLY THE ANGLES. atan(tan(a) * s) is exactly what stretching
// space along the optical axis by s does to a plane's tilt: under z -> s z the normal (sin a, 0,
// cos a) becomes (sin a, 0, cos a / s), whose tangent from the axis is s tan a. Moving each
// facet's plane with that same stretch -- its distance as well as its tilt -- makes the whole
// crown (or pavilion) the same stone stretched taller or squashed flatter: every meet stays a
// meet, the table keeps its size, and the girdle's outline does not move. Changing the angles
// alone would pull every facet off its meets. GemCad's own tangent ratio is used for exactly
// this reason: it changes a design's height without re-meeting it.
//
// WHAT THE STRETCH IS PINNED TO. Not z = 0. The design's origin is "the stone's centre" as
// whatever wrote the file chose it, and that is not the girdle: measured 2026-09-23 over the 564
// designs in reference/gemology-project-designs that build, the girdle straddles z = 0 in only
// 53 of them, and z = 0 falls between the crown and the pavilion in only 39. A stretch about z = 0
// would therefore slide the girdle up or down and change its thickness. So each half is stretched
// about its OWN girdle edge (`heightPivots`): the crown about its lowest corner, the pavilion
// about its highest, both read once from the stone as it stood when the mode opened. Only the
// girdle's vertical facets lie between the two, and a vertical plane is untouched by any stretch
// along the axis, so the girdle keeps its outline AND its thickness. 547 of the 564 have that gap
// (the crown's lowest corner at or above the pavilion's highest); the other 17 are designs whose
// two halves overlap in height (tilted or knife-edge girdles, BeginnerTetra, Illusion_Eye), where
// no single stretch per half can be exact, and both halves are pinned to the middle of the
// overlap instead -- the angles still follow the user's formula exactly; only the meets near the
// overlap can drift.

import { isGirdleTier, isTableTier, isCuletTier, isPavilionTier } from './tiers.js';

const DEGREES = Math.PI / 180;

// ---- the gauges

/**
 * The gauges' range: a quarter to four times the height, the same factor either way from 1x.
 * The tape itself is linear (ValueRuler), so 1x sits nearer the bottom of it. A ratio of 0 would
 * flatten a half into its girdle, which is no stone.
 */
export const RATIO_MIN = 0.25;
export const RATIO_MAX = 4;
/** What a drag, a key or a typed value snaps to: a hundredth of the height. */
export const RATIO_STEP = 0.01;
/**
 * Ticks every 0.05, labelled every fifth one (0.25, 0.5, 0.75, 1, ...), so both ends of the
 * range and 1x all land on a labelled tick.
 */
export const RATIO_TICK = 0.05;
export const RATIO_MAJOR_EVERY = 5;
/**
 * Screen pixels per 1x. With RATIO_TICK that puts a tick every 10px, the angle gauge's own
 * spacing (EditPanel's angle ruler: 1 degree at 10px per degree), since the user has asked for
 * the gauges' tick densities to match before (T-0224, "so it looks pretty"); labels come every
 * 50px. It is also the drag rate: the whole 0.25-4 range is 750px of drag, near the angle
 * ruler's 900px for 0-90 degrees.
 */
export const RATIO_PX_PER_UNIT = 200;
export const RATIO_DECIMALS = 2;

/** The gauges as every session starts: both at 1x, the lock off. */
export const INITIAL_GAUGES = Object.freeze({ pavilion: 1, crown: 1, lock: false });

/**
 * The gauges after `which` ('pavilion' or 'crown') is moved to `value`. While the lock is on, the
 * two move as one (the user: "add a toggle at the bottom that locks the crown to the pavilion
 * ratio"), whichever of them was the one moved.
 */
export function moveGauge(gauges, which, value) {
  if (gauges.lock) {
    return { ...gauges, pavilion: value, crown: value };
  }

  return { ...gauges, [which]: value };
}

/** The gauges with the lock turned on or off. Turning it on brings the crown to the pavilion. */
export function setGaugeLock(gauges, on) {
  return on ? { ...gauges, lock: true, crown: gauges.pavilion } : { ...gauges, lock: false };
}

/** Whether two gauge states are the same. */
export function sameGauges(a, b) {
  return a.pavilion === b.pavilion && a.crown === b.crown && a.lock === b.lock;
}

/**
 * The mode's own undo and redo (the user: "allow undoing in a local undo stack while in scale
 * height mode"). Holds whole gauge states rather than diffs: a state is three numbers, and the
 * design is always recomputed from the snapshot taken when the mode opened, never stepped, so
 * putting the gauges back IS putting the design back.
 *
 * `commit(state)` records a finished change (a drag's release, a typed value, a wheel or key
 * step, a lock toggle) and clears the redo side; a state equal to the current one is not a
 * change and records nothing. `undo()` and `redo()` return the state to show, or null when there
 * is none.
 */
export function createGaugeHistory(initial) {
  const states = [initial];
  let at = 0;

  return {
    current: () => states[at],

    commit(state) {
      if (sameGauges(state, states[at])) {
        return false;
      }

      states.length = at + 1;
      states.push(state);
      at += 1;
      return true;
    },

    undo() {
      if (at === 0) {
        return null;
      }

      at -= 1;
      return states[at];
    },

    redo() {
      if (at === states.length - 1) {
        return null;
      }

      at += 1;
      return states[at];
    },

    canUndo: () => at > 0,
    canRedo: () => at < states.length - 1,
  };
}

// ---- the stretch

/**
 * Which gauge a tier follows: 'crown' (the table included), 'pavilion' (a flat culet included),
 * or null for a girdle, which neither moves. The same crown/pavilion rule the cutting
 * instructions split their tables by (tiers.js), except that the girdle, filed with the pavilion
 * there, belongs to neither half here.
 */
export function gaugeOf(tier) {
  if (isGirdleTier(tier)) {
    return null;
  }

  return isPavilionTier(tier) ? 'pavilion' : 'crown';
}

/**
 * A tier's angle and distance once its half is stretched by `ratio` along the optical axis about
 * the plane z = `pivot`: z -> pivot + ratio (z - pivot).
 *
 * The angle is the user's formula, atan(tan(angle) * ratio), on the angle the cutting
 * instructions show (a pavilion tier keeps its negative sign, GemCad's convention). The plane
 * n . p = d goes to (nx, ny, nz / ratio) . p' = d - nz pivot (1 - 1 / ratio), which divided by the
 * length of that normal, sqrt(sin^2 a + cos^2 a / ratio^2), is the new unit normal and distance.
 *
 * Special cases, each for a reason:
 *   ratio 1      returned unchanged, bit for bit: the formulas would round-trip through tan and
 *                atan and could come back an ulp off, which would read as an edit.
 *   the girdle   unchanged. tan(90) is not finite, and in floating point cos(90 degrees) is 6e-17
 *                rather than 0, so the general formula would tip a -90 girdle over to +89.99...
 *                A vertical plane is untouched by a stretch along the axis anyway.
 *   the table    keeps its angle exactly (0), and rises or falls with the crown: z = d goes to
 *                z = pivot + ratio (d - pivot). That is what keeps its size the same.
 *   a flat culet keeps its angle exactly (180, pointing straight down: -z = d), and its
 *                distance follows the same stretch: d -> ratio d + (ratio - 1) pivot.
 */
export function scaledTier({ angle, distance }, ratio, pivot) {
  if (ratio === 1 || isGirdleTier({ angle })) {
    return { angle, distance };
  }

  if (isTableTier({ angle })) {
    return { angle, distance: pivot + ratio * (distance - pivot) };
  }

  if (isCuletTier({ angle })) {
    return { angle, distance: ratio * distance + (ratio - 1) * pivot };
  }

  // The tilt from the table (crown) or from the culet (pavilion), 0 to 90 either way.
  const tilt = Math.abs(angle) * DEGREES;
  const sign = angle < 0 ? -1 : 1;
  // The normal's component along the optical axis: up for the crown, down for the pavilion.
  const nz = sign * Math.cos(tilt);
  const length = Math.hypot(Math.sin(tilt), Math.cos(tilt) / ratio);

  return {
    angle: sign * Math.atan(Math.tan(tilt) * ratio) / DEGREES,
    distance: (distance - nz * pivot * (1 - 1 / ratio)) / length,
  };
}

/**
 * The planes each half is stretched about, from a stone the design builds (`built`, as
 * DesignMesh.buildFaces returns it): `{ crown, pavilion, overlap }`.
 *
 * The crown's is its lowest corner and the pavilion's its highest -- each half's own girdle edge
 * -- so only the girdle's vertical facets lie between them (see the head of this file). When the
 * two halves overlap in height (`overlap` true: the crown reaches below the pavilion's top), both
 * are the middle of the overlap. A half with no corners on the stone at all (every one of its
 * tiers hidden, say) takes the other's.
 */
export function heightPivots(design, built) {
  let crownLow = Infinity;
  let pavilionHigh = -Infinity;

  for (const face of built.faces) {
    const which = gaugeOf(design.tiers[face.tier]);

    for (const point of face.polygon) {
      if (which === 'crown') {
        crownLow = Math.min(crownLow, point.z);
      } else if (which === 'pavilion') {
        pavilionHigh = Math.max(pavilionHigh, point.z);
      }
    }
  }

  if (crownLow === Infinity && pavilionHigh === -Infinity) {
    return { crown: 0, pavilion: 0, overlap: false };
  }

  if (crownLow === Infinity) {
    crownLow = pavilionHigh;
  }

  if (pavilionHigh === -Infinity) {
    pavilionHigh = crownLow;
  }

  if (pavilionHigh > crownLow) {
    const middle = (pavilionHigh + crownLow) / 2;

    return { crown: middle, pavilion: middle, overlap: true };
  }

  return { crown: crownLow, pavilion: pavilionHigh, overlap: false };
}

/**
 * Every tier's angle and distance for a pair of ratios, computed afresh from `pristine` -- the
 * design as it stood when the mode opened, `[{ tier, angle, distance }]` -- never from what an
 * earlier setting of the gauges left behind, so no amount of dragging back and forth can drift.
 * Returns `[{ tier, angle, distance }]` in the same order; a girdle comes back as it was.
 */
export function scaledValues(pristine, { pavilion, crown }, pivots) {
  return pristine.map(({ tier, angle, distance }) => {
    const which = gaugeOf({ angle });

    if (which === null) {
      return { tier, angle, distance };
    }

    const ratio = which === 'crown' ? crown : pavilion;

    return { tier, ...scaledTier({ angle, distance }, ratio, pivots[which]) };
  });
}
