// Edit mode's guide (T-0193): the cutting plane drawn over the stone, worked out in the design's
// own frame (optical axis +Z, the design's units; the frame `GemApp::project_file_points` takes).
// No DOM and no GemApp here, so it is tested under Deno; EditOverlay.svelte projects the points
// and draws them.
//
// The picture is a faceting machine's: the stone is held against a flat lap. The user
// (2026-09-19): "render a cutting plane ... The plane should be the same width as the rock".
//
// **The protractor was removed on 2026-09-19**, the same day it was built: the user, "lets remove
// the protractor from the rendering - i dont think it brings very much", and, asked how much of
// the apparatus went, "everything but the cutting plane itself". So the quarter-circle arc, its
// ticks and 0/30/60/90 labels, the reading line down the normal, the foot dot and the written
// angle are all gone; the plane is the whole overlay now. The tier's angle is still on the edit
// bar's own ruler, which is where it is edited, so nothing became unreadable. Do not put them
// back without asking: this was a deliberate call about clutter, not an oversight. (It also cuts
// the per-frame projection from about 78 points to 4; see kb/performance-and-draft-mode.md for
// what that is and is not worth.)
//
// Reads the design helpers from the globals the page's classic scripts publish (GemCadDesign,
// DesignMesh), as tier_controller.js and selection.js do.

/** How far the plane reaches either side of the facet, down and up its slope, per rock width. */
const PLANE_DEPTH = 0.3;

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const normalize = a => scale(a, 1 / Math.hypot(a.x, a.y, a.z));

/**
 * The facet edit mode starts on when it was not a clicked one (the user's triggers 1-3): the
 * tier's lowest index, which is also the starting facet `symmetryFromIndices` reads the tier's
 * teeth from. The first such facet when two share it.
 */
export function startingFacet(tier) {
  return tier.facets.reduce((best, facet) => (best === null || facet.index < best.index ? facet : best), null);
}

/**
 * Where a mesh facet's outward normal (in the design's frame, as `GemApp::facet_normals` gives
 * it) belongs in `design`: `{ tier, facet }` objects, by the same nearest-normal match the
 * facet-to-tier map uses, over the tiers on the stone. Null when the design has none.
 */
export function designFacetForNormal(design, normal) {
  const planes = GemCadDesign.renderedPlanesOf(design);

  if (planes.length === 0) {
    return null;
  }

  const match = GemCadDesign.matchNormalToPlanes(planes, normal);
  const tier = design.tiers[match.tier];

  return { tier, facet: tier.facets[match.facet] };
}

/**
 * The stone the design cuts, as the mesh builder sees it: the expensive part of the guides
 * (about half a second for a 67-facet design, measured 2026-09-19), so edit mode keeps one and
 * hands it back in while a slider is being dragged.
 */
export function rockShape(design) {
  return DesignMesh.buildFaces(design);
}

/**
 * The design's facet objects that show on the stone `built` (a `rockShape`): the ones the mesh
 * builder gave a polygon. A facet with none is not on the stone -- its tier is hidden, its plane
 * repeats an earlier one, or the other planes cut it away entirely.
 */
export function shownFacets(design, built) {
  return new Set(built.faces.map(face => design.tiers[face.tier].facets[face.facet]));
}

/**
 * The facets a cut has removed altogether (the user, 2026-09-19: take the plane of each facet of
 * the tier being edited and split space by it; a facet of the rock that lies completely on the
 * cut-off side is gone, and leaves its tier). That is exactly a facet that showed on the stone
 * when edit mode began and shows no longer, since the edited tier's planes are all that moved.
 *
 * `neverShown` is the facets that had no polygon to begin with (hidden tiers, repeated planes);
 * they were not cut away by anything the user did, so they stay. So do the edited tier's own
 * facets, hidden tiers, and preform tiers, whose facets are kept because their meetpoints are
 * still needed (TierToolbar's Preform). Returns a Set of facet objects.
 */
export function cutAwayFacets(design, edited, shownNow, neverShown) {
  const gone = new Set();

  for (const tier of design.tiers) {
    if (tier === edited || tier.hidden || tier.preform) {
      continue;
    }

    for (const facet of tier.facets) {
      if (!shownNow.has(facet) && !neverShown.has(facet)) {
        gone.add(facet);
      }
    }
  }

  return gone;
}

/**
 * The guide for editing `facet` of `tier` in `design`. `shape` is a `rockShape` to measure the
 * rock by; without one it is built here, which is far too slow to do per pointer move. Every point is in the design's frame.
 *
 *   plane      the cutting plane, four corners in order: a rectangle in the facet's own plane,
 *              exactly as wide as the rock across the facet (the rock's extent along the
 *              plane's level direction) and PLANE_DEPTH rock widths either side of the facet's
 *              centre down its slope.
 *   centre     the facet's centre on the plane: its polygon's centroid on the stone (or the
 *              centroid of the face of an identical plane, for a copy made by New), or, for a
 *              facet the stone does not show (hidden, or cut away), the point of the plane
 *              nearest the rock's centre. Not drawn since the protractor went (see the top of
 *              this file); it is still what the plane is built around, and what proves a fresh
 *              copy's plane lands on the original's face.
 *   normal     the facet's outward normal, and `width` the rock's extent across the facet.
 *
 * Throws when the design's planes do not build a stone (DesignMesh.buildFaces), as a rebuild
 * would; the caller then draws nothing.
 */
export function editGuides(design, tier, facet, shape = null) {
  const normal = GemCadDesign.normalOf(design, tier.angle, facet.index);
  const built = shape ?? rockShape(design);
  const vertices = built.faces.flatMap(face => face.polygon);

  // Level, pointing away from the optical axis at the facet's index: the direction the facet
  // faces, seen from above. The table and a culet face no direction round the stone; their
  // index (0) still names one, which is as good as any to measure the rock across.
  const round = GemCadDesign.normalOf(design, 90, facet.index);
  const outward = normalize({ x: round.x, y: round.y, z: 0 });
  // The plane's level direction (across the facet) and its slope (down it, in the plane).
  const across = normalize(cross(outward, { x: 0, y: 0, z: 1 }));
  const slope = normalize(cross(normal, across));

  const spans = vertices.map(v => dot(v, across));
  const low = Math.min(...spans);
  const high = Math.max(...spans);
  const width = high - low;

  const t = design.tiers.indexOf(tier);
  const f = tier.facets.indexOf(facet);
  // Its own face, or, for a facet whose plane is the same as an earlier one's (a tier New has
  // just copied), the face the mesh builder kept for that plane in its place.
  const samePlane = candidate => {
    const kept = built.planes[candidate.planeIndex];

    return Math.abs(dot(kept.normal, normal) - 1) < 1e-9 && Math.abs(kept.offset - tier.distance) < 1e-9;
  };
  const face = built.faces.find(candidate => candidate.tier === t && candidate.facet === f) ??
    built.faces.find(samePlane);
  let centre;

  if (face) {
    centre = scale(face.polygon.reduce(add, { x: 0, y: 0, z: 0 }), 1 / face.polygon.length);
  } else {
    centre = scale(vertices.reduce(add, { x: 0, y: 0, z: 0 }), 1 / vertices.length);
  }

  // Dropped onto the facet's CURRENT plane. For a facet the stone shows, and a shape built from
  // this very design, that changes nothing (the centroid is already on it). It is what keeps the
  // guides on the facet while a slider is dragged: the shape is then the one from before the
  // drag (rebuilding it per pointer move costs half a second), and its centroid is carried onto
  // the plane the tier now has, so the cutting plane slides with the angle instead of waiting.
  centre = add(centre, scale(normal, tier.distance - dot(normal, centre)));

  // The plane's corners: its level extent is the rock's own, whatever the facet's centre.
  const alongCentre = dot(centre, across);
  const depth = PLANE_DEPTH * width;
  const corner = (side, rise) => add(add(centre, scale(across, side - alongCentre)), scale(slope, rise));
  const plane = [corner(low, -depth), corner(high, -depth), corner(high, depth), corner(low, depth)];

  return { plane, centre, normal, width };
}
