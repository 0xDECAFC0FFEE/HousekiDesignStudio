// The gear dialog's validation (T-0171): pure logic, no stores and no DOM, so it can be tested
// on its own. It reads the `GemCadDesign` global (design.js).

import { tierIdsInFileOrder } from './tiers.js';

/**
 * Re-validates the gear dialog's fields against the CURRENTLY LOADED design (if any): what
 * re-expressing it onto the entered tooth count would produce, and the error to show if that is
 * not allowed. Run on every keystroke and checkbox change, so the error appears and disappears
 * live rather than only when the user tries to apply.
 *
 *   design      the loaded design, or null for a plain .obj
 *   raw         the count field's text
 *   fractional  the "Fractional teeth" checkbox
 *
 * Returns `{ error, preview }`: `error` is the message, or null when Apply is allowed, and
 * `preview` the re-expressed design (`GemCadDesign.reExpressOnGear`'s pure result) when there is
 * one to apply -- null with no design loaded or an unusable count. Kept together so validation
 * and Apply can never disagree about what "the entered count" currently means.
 */
export function checkGearCount(design, raw, fractional) {
  const text = String(raw).trim();
  const teeth = Number(text);

  if (text === '' || !Number.isInteger(teeth) || teeth <= 0) {
    return { error: 'Enter a whole number of teeth, greater than 0.', preview: null };
  }

  if (!design) {
    // Nothing to re-express (a plain .obj): no design means no facet can ever be
    // fractional, so there is nothing this dialog can object to.
    return { error: null, preview: null };
  }

  const preview = GemCadDesign.reExpressOnGear(design, { teeth, reversed: design.gear.reversed });

  if (fractional) {
    // Fractional teeth are explicitly allowed; whatever the re-expression produces is fine.
    return { error: null, preview };
  }

  const ids = tierIdsInFileOrder(preview.tiers);
  const affectedIds = [];
  let fractionalFacets = 0;

  preview.tiers.forEach((tier, t) => {
    const count = tier.facets.filter(facet => !Number.isInteger(facet.index)).length;

    if (count > 0) {
      fractionalFacets += count;
      affectedIds.push(ids[t]);
    }
  });

  if (fractionalFacets === 0) {
    return { error: null, preview };
  }

  const facetWord = fractionalFacets === 1 ? 'facet' : 'facets';
  const tierWord = affectedIds.length === 1 ? 'tier' : 'tiers';

  return {
    error:
      `At ${teeth} teeth, ${fractionalFacets} ${facetWord} in ${tierWord} ` +
      `${affectedIds.join(', ')} would be fractional. Check "Fractional teeth" to allow it, ` +
      `or choose a different count.`,
    preview,
  };
}
