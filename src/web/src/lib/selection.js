// Highlighting a tier on the stone and in the cutting instructions, and regenerating the stone
// from the current design. Plain JS: it talks to GemApp, the facet map and the tier controller,
// and asks for a redraw; nothing here is drawn by Svelte.

import * as tiers from './tier_controller.js';
import { buildFacetTierMap, getFacetTierMap, setFacetTierMap } from './facet_map.js';
import { showStoneStats } from './stone_stats.js';
import { editing } from './edit_mode.js';
import { get } from 'svelte/store';

// While a tier is being edited it is the selection, on the stone and in the instructions, and
// nothing can change that (the user, 2026-09-19): every way of selecting or deselecting lands on
// it instead.
const editedTier = () => get(editing)?.tier ?? null;

/**
 * Regenerates the mesh from the CURRENT design (T-0168) and reloads it into `app` -- the entry
 * point a future edit to a tier's angle, index or depth only has to call, since the mesh and
 * the cutting instructions now share one source of truth
 * ([[building-the-stone-mesh-from-a-design-s-own-face]]). The tier toolbar (T-0175) is its
 * first caller on the page, through the session's `setStoneHooks`, whenever a Delete or a
 * Show/Hide (or the undo or redo of one) changes which tiers cut the stone. It is also a seam
 * for a future angle/tooth/depth editor, and for a round-trip render test to call directly,
 * which is why it is also exposed as `window.gemRebuildStoneFromDesign` once the session
 * starts, the same pattern `window.gemRequestRender` uses.
 *
 * Reads the tier controller's design -- the SAME design object the pane renders and a
 * drag-reorder mutates in place -- rather than taking a design argument, so there is exactly one
 * place a caller can get this wrong (loading a stale design) and it is structurally impossible:
 * there is only one design in play at a time. Returns `true` on success, `false` if there is no
 * design to rebuild from (a plain `.obj`) or the builder failed (already reported with
 * `console.warn`) -- a rebuild failure simply leaves the CURRENTLY LOADED mesh alone rather than
 * clearing the stone.
 *
 * Deliberately NOT called by a reorder or a notes edit (T-0165's `applyReorder`, the tier
 * description editor): neither changes any tier's geometry, only the design's cutting order or
 * its free-text notes, so rebuilding the mesh for either would be pure cost for no visible
 * change -- and would needlessly renumber Rust's own facet ids, invalidating `facetTierMap` for
 * nothing.
 */
export function rebuildStoneFromDesign(app, { quick = false } = {}) {
  const design = tiers.getDesign();

  if (!design) {
    return false;
  }

  let text;

  try {
    text = DesignMesh.toObjText(design, { name: design.name || 'design' });
  } catch (cause) {
    console.warn(`Could not rebuild the stone from the current design: ${cause}`);
    return false;
  }

  try {
    app.load_obj(text);
  } catch (cause) {
    // Not expected of DesignMesh's own output (buildFaces/weldFaces already guarantee a
    // closed, non-degenerate mesh -- see kb/building-the-stone-mesh-from-a-design-s-own-face
    // .md's full-corpus measurement), but load_obj is Rust's own gate and this function's own
    // rule is the same as everywhere else: never leave the app in a worse state than before
    // the call. The currently loaded stone is untouched, since load_obj only swaps it on
    // success.
    console.warn(`Could not rebuild the stone from the current design: ${cause}`);
    return false;
  }

  // `quick` is for a slider being dragged (edit mode, 2026-09-19): the mesh is replaced, which is
  // what the eye is watching, and the two bookkeeping passes that nothing on screen needs
  // mid-drag are skipped -- the facet<->tier map (only a click reads it) and the proportions in
  // the corner. Both were measured at over half the cost of a rebuild. The drag's last write is
  // never quick, so they are always brought up to date when it ends.
  if (!quick) {
    setFacetTierMap(buildFacetTierMap(app, design));
    showStoneStats(app, text);
  } else {
    // A quick rebuild only happens mid-drag (the ruler, the angle or the depth being moved), so
    // the stone is drawn in draft while it lasts: half the bounces, a quarter of the samples and
    // a smaller backing store (2026-09-19, the user's request). Full quality returns by itself
    // shortly after the last change. `window.gemBeginInteraction` for the same reason
    // `gemRequestRender` is reached that way: this module is loaded before the render loop.
    window.gemBeginInteraction?.();
  }

  // The rebuild gave the facets new ids and cleared the stone's highlight; a tier being edited
  // stays lit. A quick rebuild has not rebuilt the facet map, so it finds the tier's facets by
  // their normals instead, which is cheap enough to do on every step of a drag.
  const edited = editedTier();

  if (edited !== null) {
    if (quick) {
      lightEditedFacets(app, design, edited);
    } else {
      highlightDesignTier(app, edited);
    }
  }

  window.gemRequestRender?.();

  return true;
}

/** Lights the mesh facets whose normals are those of `tier`'s facets, without the facet map. */
function lightEditedFacets(app, design, tier) {
  const normals = app.facet_normals();
  const wanted = tier.facets.map(facet => GemCadDesign.normalOf(design, tier.angle, facet.index));
  const ids = [];

  for (let f = 0; f < normals.length / 3; f++) {
    const [x, y, z] = [normals[f * 3], normals[f * 3 + 1], normals[f * 3 + 2]];

    if (wanted.some(n => n.x * x + n.y * y + n.z * z > 1 - 1e-6)) {
      ids.push(f);
    }
  }

  app.set_highlighted_facets(new Uint32Array(ids));
}

/**
 * Highlights every facet of a tier, by the tier OBJECT (T-0165; was its row id), and that
 * row itself (T-0160). Used directly by a row click, and by `highlightFacetAndItsTier` below
 * once it has resolved a clicked facet to a tier -- the two are the SAME action from that
 * point on, which is the point of the user's follow-up request ("same behavior as single
 * clicking on the facet tier").
 */
export function highlightDesignTier(app, tier) {
  tier = editedTier() ?? tier;

  // A tier with no facets on the stone -- a hidden one (T-0178) -- is still
  // selected in the pane (its row can be clicked, and the tier toolbar acts on it); the stone
  // just has nothing of it to highlight. This used to return early without selecting the row.
  const facetTierMap = getFacetTierMap();
  const facets = (facetTierMap && facetTierMap.tierToFacets.get(tier)) || [];

  app.set_highlighted_facets(new Uint32Array(facets));
  tiers.highlightTier(tier);

  // Rendering is on demand, so a highlight nobody redraws is never seen. A click on the stone
  // redraws after calling this, but a click on a row did not, and the row lit up while the
  // stone kept showing the old frame (the user's report, 2026-09-18). Redrawing here covers
  // every caller; requestRender coalesces, so the stone-click path's own redraw costs nothing
  // extra. `window.gemRequestRender` because this module is reached before the render loop
  // exists on some paths -- the same reason the pane resize reaches it that way.
  window.gemRequestRender?.();
}

/**
 * Highlights the design tier a clicked mesh facet belongs to -- every one of its facets on
 * the stone, and its row in the cutting instructions -- or, when there is no design at all (a
 * plain `.obj`, so there is no tier to look up), falls back to exactly the single clicked
 * facet with no row highlighted: today's pre-T-0160 behaviour.
 */
export function highlightFacetAndItsTier(app, facetId) {
  if (editedTier() !== null) {
    highlightDesignTier(app, editedTier());
    return;
  }

  const facetTierMap = getFacetTierMap();

  if (facetTierMap && facetTierMap.facetToTier.has(facetId)) {
    highlightDesignTier(app, facetTierMap.facetToTier.get(facetId));
    return;
  }

  app.set_highlighted_facet(facetId);
  tiers.highlightTier(null);
}

/**
 * Clears both highlights: the stone (`set_highlighted_facet(-1)`, the "nothing selected" id,
 * also the one-argument convenience over `set_highlighted_facets`) and whichever cutting
 * instructions row was lit. Used for a background click; loading another stone clears both
 * too, but by construction rather than by calling this -- `load_obj` already clears Rust's
 * side, and `tiers.render` discards and rebuilds every row from scratch, so neither
 * highlight can survive a load to begin with.
 */
export function clearFacetAndTierHighlight(app) {
  if (editedTier() !== null) {
    highlightDesignTier(app, editedTier());
    return;
  }

  app.set_highlighted_facet(-1);
  tiers.highlightTier(null);
}
