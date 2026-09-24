// The cutting assistant (T-0234), the pure half: the order the cuts are made in, where the user is
// in it, and the rough, the dop and the framing around the stone. The user (2026-09-23):
//
//   "the cutting assistant will not modify the actual faceting instructions. its purpose is to tell
//   users the steps to cut the rock and what the rock will look like at each step. ... before we
//   cut any tiers, we only render a cube larger than our rock. at the bottom of the cube, our dop (a
//   medium sized rod rendered in bronze) sticks out. we start cutting the pavilion facets facing out
//   from the dop. each time the user clicks next cut, it applies one more cut from the cutting
//   instructions to the rendered rock. similarly, when the user clicks next tier (or prev tier) it
//   skips all cuts in the current tier. once each tier is complete, clicking next cut automatically
//   advances to the first cut of the next tier. ... once we cut all the cuts in the pavilion, the
//   dop switches from the pavilion to the crown. we can continue cutting from there."
//
// No DOM, no stores, no GemApp: everything here is a function of a design and a position, so it is
// tested under Deno (web/tests/cutting_assistant_test.js). cutting_assistant_mode.js is the mode
// around it, and the only place the design is read from or the stone is drawn.
//
// THE MODEL. A cut SEQUENCE, built once from the design, and a POSITION k in 0..N: the number of
// cuts made. k = 0 is the uncut rough; the "current cut" the bar shows is cut k + 1, the next one to
// make, which is `sequence.cuts[k]`; at k = N the stone is finished. Navigation only ever moves k.
//
// THE ORDER. Every facet of every tier the stone is built from (`GemCadDesign.isRenderedTier`: a
// hidden tier is skipped, a preform one is cut like any other), in two phases:
//   1. the pavilion phase: the pavilion section of the cutting instructions -- its pavilion tiers,
//      and the girdle and a flat culet, which tiers.js files with the pavilion, because a cutter
//      cuts the girdle before the transfer;
//   2. the crown phase: the crown section -- its crown tiers and the table.
// Each section in the order the pane lists it (`splitTiersIntoSections`, the pane's own split, so
// the bar and the rows cannot disagree about which tier comes next), and within a tier, the facets
// in the order its teeth are listed. A tier with no facets has nothing to cut and is left out.

import { isPavilionTier, splitTiersIntoSections } from './tiers.js';

/** Which phase a cut belongs to: the pavilion with the dop on the table side, or the crown. */
export const PAVILION = 'pavilion';
export const CROWN = 'crown';

/**
 * The cut sequence of `design`: `{ cuts, tiers, transfer, total }`.
 *
 *   cuts      one entry per facet, in cutting order: `{ tier, facet, tierAt }`, the design's own
 *             tier and facet OBJECTS (never copies, so the pane's rows, keyed by tier object, can
 *             be matched against them), and `tierAt`, the entry of `tiers` it belongs to.
 *   tiers     one entry per tier with something to cut, in cutting order: `{ tier, id, phase,
 *             start, end }` -- `id` the row's own label (P1, G1, C3, T), and `start`/`end` the
 *             range of `cuts` it covers, end exclusive, so a tier is fully cut once k >= end.
 *   transfer  the index of the first crown cut: the pavilion phase is k < transfer. N when the
 *             design has no crown to cut, 0 when it has no pavilion.
 *   total     N, the number of cuts.
 */
export function buildCutSequence(design) {
  const { pavilion, crown } = splitTiersIntoSections(design.tiers);
  const cuts = [];
  const tiers = [];
  let transfer = null;

  for (const [phase, rows] of [[PAVILION, pavilion], [CROWN, crown]]) {
    if (phase === CROWN) {
      transfer = cuts.length;
    }

    for (const { tier, id } of rows) {
      // A hidden tier stays in the pane but is not on the stone (T-0178), so it is not a cut; a
      // tier emptied of facets (edit mode can cut one away) has nothing to cut.
      if (tier.hidden || tier.facets.length === 0) {
        continue;
      }

      const tierAt = tiers.length;
      const start = cuts.length;

      for (const facet of tier.facets) {
        cuts.push({ tier, facet, tierAt });
      }

      tiers.push({ tier, id, phase, start, end: cuts.length });
    }
  }

  return { cuts, tiers, transfer, total: cuts.length };
}

/** `k` clamped into the sequence's range, 0..N, and made a whole number. */
export function clampPosition(sequence, k) {
  return Math.min(sequence.total, Math.max(0, Math.round(Number.isFinite(k) ? k : 0)));
}

/**
 * The entry of `sequence.tiers` the CURRENT cut (cut k + 1) belongs to -- the tier being worked
 * on -- or `sequence.tiers.length` at k = N, when there is none left.
 */
export function tierAt(sequence, k) {
  return k >= sequence.total ? sequence.tiers.length : sequence.cuts[k].tierAt;
}

/** The first cut of tier `t` (an index into `sequence.tiers`): where a click on its row goes. */
export function tierStart(sequence, t) {
  return sequence.tiers[t].start;
}

/** `>`: one more cut, clamped at N. Finishing a tier's last facet moves on to the next tier. */
export function nextCut(sequence, k) {
  return Math.min(sequence.total, k + 1);
}

/** `<`: one cut back, clamped at 0. */
export function prevCut(sequence, k) {
  return Math.max(0, k - 1);
}

/**
 * `>>`: the rest of the current tier cut, so the next tier's first facet is current. At the last
 * tier that is the finished stone, N, and at N it stays there.
 */
export function nextTier(sequence, k) {
  const t = tierAt(sequence, k);

  return t < sequence.tiers.length ? sequence.tiers[t].end : sequence.total;
}

/**
 * `<<`: back to the start of the current tier when some of it has been cut, and otherwise to the
 * start of the tier before it -- so pressing it twice from the middle of a tier goes back a whole
 * tier, the way a media player's "previous" first restarts the track. At N (no current tier) the
 * last tier is the one before, and at 0 it stays at 0.
 */
export function prevTier(sequence, k) {
  const t = tierAt(sequence, k);

  if (t < sequence.tiers.length && k > sequence.tiers[t].start) {
    return sequence.tiers[t].start;
  }

  return t > 0 ? sequence.tiers[t - 1].start : 0;
}

/**
 * Which phase position k is in: the pavilion while any pavilion cut is still to be made
 * (k < transfer), the crown from the moment the last one is made -- that is when the dop is
 * transferred (the user: "once we cut all the cuts in the pavilion, the dop switches from the
 * pavilion to the crown").
 */
export function phaseAt(sequence, k) {
  return k < sequence.transfer ? PAVILION : CROWN;
}

/**
 * A tier row's state at position k: 'cut' once all of it is cut, 'current' while its facets are
 * being cut (its first facet current included), 'uncut' before that. The pane greys the uncut
 * ones and highlights the current one.
 */
export function tierState(sequence, t, k) {
  const { start, end } = sequence.tiers[t];

  if (k >= end) {
    return 'cut';
  }

  return k >= start ? 'current' : 'uncut';
}

/**
 * The state of cut `c` (an index into `sequence.cuts`) at position k: 'cut' for the k already
 * made, 'current' for the next one, 'uncut' after it. The bar shows each tooth of the current tier
 * this way.
 */
export function cutState(c, k) {
  if (c < k) {
    return 'cut';
  }

  return c === k ? 'current' : 'uncut';
}

/**
 * Where the slider's marks go, as positions k: a tick at the start of every tier after the first
 * (k = 0 is the slider's own end), and the transfer, when it falls strictly inside the range.
 */
export function sliderMarks(sequence) {
  const ticks = sequence.tiers.map(entry => entry.start).filter(k => k > 0 && k < sequence.total);
  const transfer = sequence.transfer > 0 && sequence.transfer < sequence.total ? sequence.transfer : null;

  return { ticks, transfer };
}

// ---- the rough, the dop and the framing
//
// All in the design's own frame: optical axis +Z, the table up, the model units the design's
// distances are in. A plane is `{ normal, offset }`, the inside being `dot(normal, p) <= offset`,
// exactly GemCadDesign.planesOf's form, so the cube's six planes can simply be put in front of the
// design's own ones and the whole list handed to the same half-space builder the page uses.

/** How much larger than the finished stone the rough is: the ticket's 1.15x. */
export const ROUGH_SCALE = 1.15;

/** The dop's diameter, as a share of the finished stone's girdle width ("medium sized"). */
export const DOP_DIAMETER_SHARE = 0.35;

/** The dop's length, as a multiple of the finished stone's height. */
export const DOP_LENGTH_SHARE = 1.5;

/**
 * How far out, as a share of the view's radius, the far end of the dop may reach. The page
 * frames everything it draws by scaling the loaded stone so its furthest corner sits at radius 1
 * (`mesh::Mesh::center_and_scale`); the rough's corners are held at radius 1 or inside it, and the
 * dop is allowed to reach a little past that, so the rough is not shrunk into a corner of the view
 * to make room for a rod. gem.frag starts primary rays far enough out to meet it (its
 * `primaryStartRadius`).
 */
export const DOP_VIEW_REACH = 1.25;

/** The axis-aligned box around a list of points `{ x, y, z }`: `{ min, max }`. */
export function boundsOf(points) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };

  for (const point of points) {
    for (const axis of ['x', 'y', 'z']) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }

  return { min, max };
}

/**
 * The rough: the axis-aligned cube centred on the finished stone's bounding box, `ROUGH_SCALE`
 * times the largest half-extent of that box across. Returns `{ center, half, planes }`, `planes`
 * its six faces in the half-space form above (each offset is that face's distance along its own
 * normal, so a cube off the origin is still exact).
 */
export function roughCube(bounds) {
  const center = {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
  const half = ROUGH_SCALE * Math.max(
    (bounds.max.x - bounds.min.x) / 2,
    (bounds.max.y - bounds.min.y) / 2,
    (bounds.max.z - bounds.min.z) / 2,
  );
  const planes = [];

  for (const axis of ['x', 'y', 'z']) {
    for (const sign of [1, -1]) {
      const normal = { x: 0, y: 0, z: 0 };

      normal[axis] = sign;
      planes.push({ normal, offset: sign * center[axis] + half });
    }
  }

  return { center, half, planes };
}

/**
 * How far the rough cut by `planes` reaches along the optical axis (x = y = 0): `{ top, bottom }`,
 * the highest and lowest z of the solid on that line. A plane whose normal leans up bounds it from
 * above (n.z z <= d, so z <= d / n.z), one leaning down from below; a vertical one does not bound
 * it at all. Exact for any convex solid, and `bottom` is the culet -- the lowest point of the cut
 * pavilion on the axis -- whether that is a point, a keel or a flat culet.
 */
export function axisExtent(planes) {
  let top = Infinity;
  let bottom = -Infinity;

  for (const { normal, offset } of planes) {
    if (normal.z > 1e-9) {
      top = Math.min(top, offset / normal.z);
    } else if (normal.z < -1e-9) {
      bottom = Math.max(bottom, offset / normal.z);
    }
  }

  return { top, bottom };
}

/**
 * The dop's size, from the finished stone's bounds: `{ radius, length }`. Its diameter is
 * DOP_DIAMETER_SHARE of the girdle width (the wider of the stone's two horizontal extents) and its
 * length DOP_LENGTH_SHARE times the stone's height.
 */
export function dopSize(bounds) {
  const width = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y);
  const height = bounds.max.z - bounds.min.z;

  return { radius: (DOP_DIAMETER_SHARE * width) / 2, length: DOP_LENGTH_SHARE * height };
}

/**
 * How much further than strictly needed, as a share of the dop's radius, the crown phase's rod end
 * is sunk into the pavilion (see dopPlacement), so its rim is clearly inside the stone rather than
 * on its surface, where float noise could let a sliver of the open end show.
 */
export const DOP_SINK_MARGIN = 0.1;

/**
 * Where the dop is at a given phase, as the two ends of its axis: `{ start, end, radius, capped }`,
 * `start` the end at the rock and `end` the far end, both on the optical axis, and `capped` whether
 * the renderer draws the rock end as a flat disk. `planes` is the rough as it stands (the cube and
 * every cut made so far):
 *
 *   pavilion  on the table side, glued flat to the top of the rough -- the cube's face, since
 *             nothing above it has been cut -- and sticking up, away from the stone, so every
 *             pavilion facet faces away from it. Capped.
 *   crown     transferred to the pavilion side and sticking down from the culet. Its end goes INTO
 *             the rock (T-0239, the user: "can you make the top circle of the dop intersect the
 *             rock? don't render the top circle of the dop, just the bottom"): deep enough that its
 *             whole rim is inside the cut pavilion (`sunkDopEnd`), and not capped. The renderer
 *             never shows the part of a rod inside the stone, so the rod simply runs into the
 *             pavilion with no gap and no disk. The far end stays where it was, `size.length`
 *             below the culet.
 */
export function dopPlacement(planes, phase, size) {
  const { top, bottom } = axisExtent(planes);

  if (phase === PAVILION) {
    return {
      start: { x: 0, y: 0, z: top },
      end: { x: 0, y: 0, z: top + size.length },
      radius: size.radius,
      capped: true,
    };
  }

  return {
    start: { x: 0, y: 0, z: sunkDopEnd(planes, size.radius) },
    end: { x: 0, y: 0, z: bottom - size.length },
    radius: size.radius,
    capped: false,
  };
}

/**
 * The lowest height at which a circle of `radius` round the optical axis lies wholly inside the
 * solid below it that `planes` bound from beneath, plus DOP_SINK_MARGIN of the radius: where the
 * crown phase's rod end goes.
 *
 * A point of the circle is (r cos t, r sin t, z). It is inside a plane's half-space when
 * n.p <= offset, and the largest n.p round the circle is r |n_xy| + n_z z. For a plane leaning down
 * (n_z < 0, a pavilion facet) that asks z >= (offset - r |n_xy|) / n_z; the largest of those over
 * every such plane is the answer. Level and upward planes do not bound the circle from below.
 */
export function sunkDopEnd(planes, radius) {
  let z = -Infinity;

  for (const { normal, offset } of planes) {
    if (normal.z < -1e-9) {
      z = Math.max(z, (offset - radius * Math.hypot(normal.x, normal.y)) / normal.z);
    }
  }

  return z + DOP_SINK_MARGIN * radius;
}

/**
 * The frame the page draws the whole walkthrough in: `{ center, radius }`, a point and a length
 * in the design's frame that the renderer maps to its origin and to radius 1. Pinned for the whole
 * session, so the rough stays put and keeps its size as cuts are made -- left to itself the
 * renderer would re-centre and re-scale every stone it loads, and the rock would grow and wander as
 * its corners were cut away.
 *
 * Centred on the rough. The radius is the larger of the rough's corner (so the whole cube fits, as
 * a loaded stone always does) and the dop's reach from that centre over DOP_VIEW_REACH (so the rod
 * fits too, at either end of the rough); the reach covers both phases, since the rod never sticks
 * out further than the rough's own face plus its length.
 */
export function viewFrame(cube, size) {
  const corner = Math.sqrt(3) * cube.half;
  const along = cube.half + size.length;
  const reach = Math.sqrt(cube.center.x ** 2 + cube.center.y ** 2 + along ** 2) + size.radius;

  return { center: cube.center, radius: Math.max(corner, reach / DOP_VIEW_REACH) };
}
