// The facet <-> tier maps for the loaded design (ported from the page's script).

/**
 * The clicked-facet <-> tier maps for the currently loaded design (T-0160, scope widened the
 * same day by the user's follow-up: a row click now does what a facet click does, so the
 * lookup runs both directions; T-0165 rekeyed both by the tier OBJECT rather than its
 * generated display id -- see the header of tier_controller.js for why): `facetToTier` from
 * a Rust mesh facet id to its tier object, and `tierToFacets` the reverse, as a plain array
 * of facet ids ready for `app.set_highlighted_facets`. `null` when the loaded stone has no
 * design at all (a plain `.obj`) -- both canvas clicks and row clicks read this, and both
 * must fall back to single-facet / no-op behaviour when it is null. Rebuilt once per stone
 * load, in `boot()` and `loadModelFile` -- **never rebuilt by a reorder**, since
 * reordering `design.tiers` does not change any tier's geometry, only its array position and
 * (therefore) its display id; a tier object stays the same object throughout.
 *
 * Module state rather than a store: nothing on the page is drawn from it, it only answers the
 * click handlers (`getFacetTierMap`), so it needs no reactivity.
 */
let facetTierMap = null;

/** The current maps, or `null` (see above). */
export function getFacetTierMap() {
  return facetTierMap;
}

/** Replaces the current maps with what `buildFacetTierMap` returned for the design just loaded. */
export function setFacetTierMap(maps) {
  facetTierMap = maps;
}

/**
 * Builds `facetTierMap` for a freshly loaded design, by matching each of Rust's own mesh
 * facet normals against the design's planes -- GEOMETRICALLY, as the ticket asked, rather
 * than by any stored label.
 *
 * `app.facet_normals()` returns each mesh facet's outward normal already in the model FILE's
 * own frame (see the doc comment on `GemApp::facet_normals` in src/lib.rs) -- the SAME frame
 * `GemCadDesign.normalOf`/`planesOf` use, so nothing here has to know about `model_axis` or
 * rotate anything. `GemCadDesign.matchNormalToPlanes` (design.js) does the actual
 * nearest-normal search; this drives it once per mesh facet and reshapes the result into the
 * two maps the click handlers want.
 *
 * `match.tier` is an index into `design.tiers` **as it stood at this moment** (the plane
 * list came from the same array, in the same order, one line up); `design.tiers[match.tier]`
 * turns that into the tier OBJECT itself, which is what makes the resulting maps immune to
 * every later reorder (T-0165) -- the object reference never changes, only where it sits in
 * the array.
 *
 * The worst match error and smallest margin across the whole stone are stashed on
 * `window.gemFacetTierDiagnostics`, read only by the CDP verification scripts under
 * scratchpad/ (never by the page itself), so "every facet maps to its tier with a clear
 * margin" is something a script can assert against the BUILT page, not just a claim about the
 * source.
 */
export function buildFacetTierMap(app, design) {
  if (!design) {
    window.gemFacetTierDiagnostics = null;
    return null;
  }

  // Only the tiers actually on the stone (T-0178): a hidden tier has no facets on the mesh, so
  // it must not be a candidate either, or a mesh facet whose direction happens to be nearer a
  // hidden tier's plane would be filed under a tier that is not on the stone. A hidden tier
  // therefore has no entry in tierToFacets, and selecting it highlights nothing on the stone
  // (highlightDesignTier). Preform tiers are cut normally, so they are candidates as usual.
  const planes = GemCadDesign.renderedPlanesOf(design);

  if (planes.length === 0) {
    window.gemFacetTierDiagnostics = null;
    return null;
  }

  const facetCount = app.facet_count();
  const normals = app.facet_normals();

  const facetToTier = new Map();
  const tierToFacets = new Map();
  let worstErrorDegrees = 0;
  let smallestMarginDegrees = Infinity;

  for (let f = 0; f < facetCount; f++) {
    const normal = {
      x: normals[f * 3],
      y: normals[f * 3 + 1],
      z: normals[f * 3 + 2],
    };
    const match = GemCadDesign.matchNormalToPlanes(planes, normal);
    const tier = design.tiers[match.tier];

    facetToTier.set(f, tier);

    if (!tierToFacets.has(tier)) {
      tierToFacets.set(tier, []);
    }
    tierToFacets.get(tier).push(f);

    worstErrorDegrees = Math.max(worstErrorDegrees, match.errorDegrees);
    smallestMarginDegrees = Math.min(smallestMarginDegrees, match.marginDegrees);
  }

  window.gemFacetTierDiagnostics = {
    facetCount,
    tierCount: design.tiers.length,
    worstErrorDegrees,
    smallestMarginDegrees,
  };

  return { facetToTier, tierToFacets };
}
