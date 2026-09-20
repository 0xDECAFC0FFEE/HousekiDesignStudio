// Tier ids, the crown/pavilion split and row formatting: pure logic, no DOM (ported from
// the page's script).

/**
 * How far a mast angle may sit from 0 or 90 and still count as the table or the girdle
 * (T-0147). GemCad-authored angles are read straight from the file's own `a` line (several
 * decimal places, e.g. "0.000000" or "-90.000000"), and design.js's own tolerances for the
 * SAME kind of comparison (`INDEX_SNAP_TOLERANCE`) are around 1e-6, so this matches that
 * order of magnitude rather than inventing a separate one.
 */
export const TIER_ANGLE_EPSILON = 1e-6;

/** True for a tier whose mast angle makes its plane vertical -- the girdle. A `.asc`/`.gem`
 * always writes -90 (GemCad's own sign convention); GemCadDesign.mastAngleOf's own comment
 * explains that a Gem Cut Studio `.gcs`'s polar angle can convert to +90 instead, because
 * +90 and -90 describe the same plane. Checking the absolute value first, before the
 * crown/pavilion sign test below, is what keeps a future `.gcs` girdle out of the crown
 * section by accident. */
export function isGirdleTier(tier) {
  return Math.abs(Math.abs(tier.angle) - 90) < TIER_ANGLE_EPSILON;
}

/** True for the table: the topmost crown facet, mast angle exactly 0. */
export function isTableTier(tier) {
  return Math.abs(tier.angle) < TIER_ANGLE_EPSILON;
}

/**
 * True for a flat culet: a single facet on the optical axis pointing straight DOWN, the
 * pavilion's counterpart of the table. design.js stores its mast angle as 180 (T-0170), since
 * GemCad's binary reader writes -90 for it, which is also the girdle's angle, and rebuilt it as
 * a vertical plane 90 degrees off. 180 is positive, so a bare `angle < 0` pavilion test filed
 * it in the crown table as a C tier reading 180.00 degrees; this is what keeps it out.
 */
export function isCuletTier(tier) {
  return Math.abs(tier.angle - 180) < TIER_ANGLE_EPSILON;
}

/**
 * True for every tier the PAVILION table lists: a negative mast angle, the girdle (listed
 * with the pavilion since T-0147) and a flat culet. The one section rule, used by the id
 * generator, the table split and the row-drag section check alike, so the three cannot
 * disagree about which table a tier belongs to.
 */
export function isPavilionTier(tier) {
  return isGirdleTier(tier) || isCuletTier(tier) || tier.angle < 0;
}

/**
 * The id a tier's row shows (T-0152, replacing T-0147's file-read `name`): GENERATED from
 * cutting order -- which is file order -- not read from the file. The user's own rule,
 * verified (by the coordinator, 2026-09-18) to reproduce `resources/hex_cut_v2.gcs`'s own ten
 * tier names exactly (`P1 G1 P2 C1 C2 C3 C4 C5 C6 T`) when applied to that file's tier order:
 *
 *   - a girdle tier (`isGirdleTier`) is `G1`, `G2`, ... -- numbered, because a design can
 *     have several (Compear125 has four);
 *   - the table (`isTableTier`) is `T`, unnumbered -- there is only ever one;
 *   - an ordinary crown tier (mast angle > 0, and not the table) is `C1`, `C2`, ...;
 *   - an ordinary pavilion tier (mast angle < 0, and not the girdle) is `P1`, `P2`, ....
 *
 * `counters` is mutated in file order and shared across a whole design, so a girdle tier cut
 * BETWEEN two pavilion tiers (`hex_cut_v2.gcs`: P1, G1, P2, ...) does not disturb the
 * pavilion numbering -- P2 is still P2, because the girdle has its own counter and never
 * touches `counters.pavilion`.
 */
export function tierId(tier, counters) {
  if (isGirdleTier(tier)) {
    counters.girdle += 1;
    return `G${counters.girdle}`;
  }

  if (isTableTier(tier)) {
    return 'T';
  }

  // A flat culet is numbered as an ordinary pavilion tier: the user's scheme names pavilion
  // tiers P1, P2... and gives only the table and the girdle letters of their own.
  if (isPavilionTier(tier)) {
    counters.pavilion += 1;
    return `P${counters.pavilion}`;
  }

  counters.crown += 1;
  return `C${counters.crown}`;
}

/**
 * An index position for a row: a whole tooth as its plain integer, a fractional one (T-0171:
 * design.js's fractional-teeth option, opt-in, needed for a facet that sits off the tooth
 * grid) to 3 DECIMAL PLACES -- enough to show more precision than the 0.005-tooth snap
 * tolerance ever leaves unresolved (a snapped facet never reaches here fractional at all;
 * anything that does is at least that far off its nearest tooth), without printing the long
 * tail of float noise a raw re-expression ratio (say, 1/3 of a tooth) would otherwise carry.
 * Replaces the earlier half-tooth-only "53½" notation (removed with HALF_TOOTH itself,
 * 2026-09-18: "dont snap to half facets") -- a half-tooth position is just an ordinary
 * fractional index now, and this formats it the same as any other, "53.500".
 */
export function formatTierIndex(index) {
  return Number.isInteger(index) ? String(index) : index.toFixed(3);
}

/**
 * A row's angle, in the terms a cutter sets on the mast. The pavilion is cut with the stone
 * flipped, so its angles are shown positive (the user's request, 2026-09-18: "update the
 * angles in the pavilion to not be negative"). That means the negated mast angle, the girdle
 * as 90, and a flat culet as 0 -- flat on the pavilion side, just as the table is flat on the
 * crown side -- rather than the design's own 180. Display only: the design keeps its signed
 * angles, which the geometry and the crown/pavilion split depend on.
 *
 * Fixed decimal places, so two tiers from the same file do not print identically --
 * Compear125's 33.970000 and 34.040000 collapse to the same "34.0" at 1 decimal -- without
 * printing digits the file does not carry meaningfully (every sample's angle line has 6
 * decimal places, but that is float noise past the second, not measured precision). Two by
 * default; File > Settings changes it (`decimals`, lib/preferences.js).
 */
export function formatTierAngle(tier, decimals = 2) {
  let angle = tier.angle;

  if (isCuletTier(tier)) {
    angle = 0;
  } else if (isPavilionTier(tier)) {
    angle = Math.abs(angle);
  }

  // `+ 0` turns a -0 into 0, so a rounded angle never prints as "-0.00°".
  return `${(angle + 0).toFixed(decimals)}°`;
}

/**
 * Every tier's generated id (`tierId`), in file order -- the one pass over `tiers` that
 * `splitTiersIntoSections` used to run inline, pulled out so `buildFacetTierMap` (T-0160) can
 * get the SAME ids (by tier index) without duplicating the counters loop a second time. Two
 * calls with the same `tiers` array always agree, since `tierId`'s counters are seeded fresh
 * each call and mutated in the same file order both times.
 */
export function tierIdsInFileOrder(tiers) {
  const counters = { crown: 0, pavilion: 0, girdle: 0 };
  return tiers.map(tier => tierId(tier, counters));
}

/**
 * Splits a design's tiers into the crown and pavilion rows the pane shows, alongside each
 * row's id (T-0152). Unlike T-0147, **neither section is reordered**: the table and the
 * girdle both stay exactly where the file cuts them, because the ids are now numbered by
 * cutting order, and moving a row elsewhere would make its own number look wrong -- `G1`
 * belongs between `P1` and `P2` in `hex_cut_v2.gcs` because that is where it is cut, not at
 * the end of the pavilion section.
 *
 * The table (mast angle 0) counts as a crown row; the girdle (`isGirdleTier`, which checks
 * `|angle| === 90` before the sign test -- a `.gcs`'s polar angle can put a girdle on either
 * side of the mast-angle 0 boundary depending on which way the float rounds, as
 * `hex_cut_v2.gcs`'s own `G1` does) counts as a pavilion row, matching design.js's own
 * crown/pavilion convention.
 */
export function splitTiersIntoSections(tiers) {
  const ids = tierIdsInFileOrder(tiers);
  const crown = [];
  const pavilion = [];

  tiers.forEach((tier, t) => {
    const id = ids[t];

    if (isPavilionTier(tier)) {
      pavilion.push({ tier, id });
    } else {
      crown.push({ tier, id });
    }
  });

  return { crown, pavilion };
}

/**
 * Proof, not assertion, that `tierId`/`splitTiersIntoSections` implement the user's rule
 * (T-0152): `resources/hex_cut_v2.gcs` names its own ten tiers, in file order,
 * `P1 G1 P2 C1 C2 C3 C4 C5 C6 T`. Its `angle` attribute is a POLAR angle in Gem Cut
 * Studio's convention, not GemCad's signed mast angle, so this converts each one with
 * `GemCadDesign.mastAngleOf` -- the same function `gcs.js`'s real reader (T-0148) calls
 * for the same reason -- before feeding it through the same code the page runs. A
 * design.js Tier needs `facets` and `cuttingInstructions` to satisfy a tier row;
 * empty/placeholder values are fine here since only the generated ids are being checked.
 *
 * This is independent of, and predates, gcs.js's own reader: the ten angles below were
 * read by hand off the file before T-0148 existed, and are kept here as a second,
 * reader-independent check -- www/js/tests/gcs_test.js checks the SAME file's tier
 * names through the real reader and through this module's `tierId` (it imports it; it used
 * to keep a documented duplicate, before the page had modules), and this function checks
 * them again at startup, in the browser, through the page's own id-generation code.
 *
 * Called once from `boot()`, after `GemCadDesign` exists (this function only NEEDS
 * `GemCadDesign.mastAngleOf`, but is defined up here beside `tierId` rather than inline in
 * `boot()`, which is about wasm/GemCad startup, not this rule). It is NOT a top-level
 * immediately-invoked call: `GemCadDesign` is not defined until `boot()` runs the inlined
 * GemCad scripts, so calling this any earlier throws `ReferenceError: GemCadDesign is not
 * defined` before the page has drawn anything -- caught once, while writing this, by
 * noticing the page went blank with a console error instead of loading.
 *
 * Throws (loudly, into the page's error box via the same path a bad design load would) if it
 * ever disagrees -- cheaper than a full test harness for one hand-built oracle, and it
 * cannot silently bit-rot unnoticed the way a comment-only claim could.
 */
export function selfCheckTierIdsAgainstHexCutV2Gcs() {
  const gcsPolarAngles = [
    143.41952158876754, // P1
    90.000000000001691, // G1
    138.46261326345407, // P2
    55.067690314706212, // C1
    35.177851397757813, // C2
    28.493495654487738, // C3
    24.877384325154125, // C4
    28.244795814968164, // C5
    14.920558437144006, // C6
    0, // T
  ];
  const expectedIds = ['P1', 'G1', 'P2', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'T'];

  const tiers = gcsPolarAngles.map(polarAngle => ({
    angle: GemCadDesign.mastAngleOf(polarAngle),
    distance: 0,
    facets: [],
    cuttingInstructions: '',
  }));

  const counters = { crown: 0, pavilion: 0, girdle: 0 };
  const actualIds = tiers.map(tier => tierId(tier, counters));

  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(
      'tierId self-check against hex_cut_v2.gcs failed: expected ' +
      JSON.stringify(expectedIds) + ' but got ' + JSON.stringify(actualIds)
    );
  }
}
