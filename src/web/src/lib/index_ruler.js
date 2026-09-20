// The index-gear ruler in the sub bar (T-0192): which ticks are big, which are highlighted, and
// the ruler's own state. No DOM here; IndexRuler.svelte draws it.
//
// The ruler is a tape of the index gear's teeth, 0 to teeth - 1, that wraps around: the tooth
// after the last is 0 again. The index it is set to sits under a fixed centre marker. Around the
// gear, `symmetry` copies of that facet sit equally spaced, and a non-zero `offset` adds another
// copy `offset` teeth from each of them (the user's example: symmetry on index 0 with offset 2
// also cuts index 2).

import { writable, get } from 'svelte/store';

/** The index the ruler is set to: a whole tooth, 0 to teeth - 1. */
export const rulerIndex = writable(0);

/** How many copies of the facet go equally spaced around the stone. Divides the tooth count. */
export const rulerSymmetry = writable(1);

/** How many teeth from each symmetry copy a second copy goes; 0 for none. */
export const rulerOffset = writable(0);

/**
 * Puts the ruler back to its starting state for a newly loaded stone: index 0, no offset, and
 * the design's own symmetry (a .gcs or GemCad file records its folds) when it fits the gear,
 * else 1. `design` is null for a plain .obj, which has none.
 */
export function resetRuler(design, teeth) {
  const folds = design && design.symmetry ? Number(design.symmetry.folds) : 1;

  rulerIndex.set(0);
  rulerSymmetry.set(symmetryFits(folds, teeth) ? folds : 1);
  rulerOffset.set(0);
  // Arbitrary mode's typed list starts over too, from the ruler's fresh setting.
  arbitraryIndices.set(rulerHighlights(teeth));
  rulerResets.update(count => count + 1);
}

/** Counts resetRuler calls, so the sub bar can refill the arbitrary-mode text it keeps itself. */
export const rulerResets = writable(0);

/**
 * True while the ruler's tape is being dragged or scrolled (2026-09-19). The tier being edited
 * follows every tooth the tape passes, so the stone is recut as the ruler moves; this says when
 * that run of changes is over, so the whole drag is ONE entry in the edit history. Without it a
 * rebuild long enough to outlast the settle timer split a drag into two undos.
 */
export const rulerDragging = writable(false);

/** The sub bar's Fine toggle: the tape moves a fifth as far as the pointer (Shift does it briefly). */
export const rulerFine = writable(false);

/** The teeth the ruler has highlighted now, on a `teeth`-tooth gear (a bad symmetry counts as 1). */
function rulerHighlights(teeth) {
  const symmetry = get(rulerSymmetry);

  return highlightedIndices(get(rulerIndex), teeth, symmetryFits(symmetry, teeth) ? symmetry : 1,
    get(rulerOffset));
}

/** What the gear dialog refuses when an arbitrary list has no symmetric form (the user's words). */
export const CANNOT_CONVERT = 'Cannot convert supplied list of arbitrary indexes into symmetrical indexes.';

/**
 * Switches the sub bar to arbitrary mode, starting its list from the teeth the ruler has
 * highlighted (the user's request, 2026-09-19: "update the indexes of arbitrary mode to the
 * currently selected symmetrical ones").
 */
export function enterArbitraryMode(teeth) {
  arbitraryIndices.set(rulerHighlights(teeth));
  indexMode.set('arbitrary');
}

/**
 * Switches the sub bar to symmetric mode, setting the ruler from the arbitrary list
 * (symmetryFromIndices). Returns null when it did, or CANNOT_CONVERT, changing nothing, when the
 * list has no symmetric form; the gear dialog checks this first and refuses to apply.
 */
export function enterSymmetricMode(teeth) {
  const found = symmetryFromIndices(get(arbitraryIndices), teeth);

  if (found === null) {
    return CANNOT_CONVERT;
  }

  rulerIndex.set(found.index);
  rulerSymmetry.set(found.symmetry);
  rulerOffset.set(found.offset);
  indexMode.set('symmetric');
  return null;
}

/**
 * Sets the sub bar from a facet tier's own teeth, for edit mode (T-0193, the user: "use the
 * shared logic for parsing these arbitrary facets into a starting facet, symmetry and offset. if
 * it's not possible to convert, fall back to arbitrary mode"). Returns the mode it chose.
 */
export function loadIndices(indices, teeth) {
  const found = symmetryFromIndices(indices, teeth);

  if (found === null) {
    arbitraryIndices.set([...indices]);
    indexMode.set('arbitrary');
  } else {
    rulerIndex.set(found.index);
    rulerSymmetry.set(found.symmetry);
    rulerOffset.set(found.offset);
    arbitraryIndices.set(highlightedIndices(found.index, teeth, found.symmetry, found.offset));
    indexMode.set('symmetric');
  }

  // The sub bar refills its arbitrary-mode text from the list, even if it was already showing it.
  rulerResets.update(count => count + 1);
  return get(indexMode);
}

// Two gaps count as the same when they differ by less than this: fractional teeth are real
// numbers, and 96 / 5 teeth summed five times need not come back to exactly 96.
const SAME_GAP = 1e-9;

/**
 * Reads a list of arbitrary indexes as a starting index, a symmetry and an offset, the user's
 * rules (2026-09-19), on a `teeth`-tooth gear:
 *
 *   1. The smallest index is the starting facet.
 *   2. One index alone is symmetry 1, offset 0.
 *   3. If every gap between neighbouring indexes is the same, counting the one that spans tooth 0
 *      (from the largest round to the smallest), it is symmetry (number of indexes), offset 0.
 *   4. Otherwise, with an even number of indexes, if the 1st, 3rd, 5th, ... are equally spaced
 *      round the gear (again counting the gap across 0) and each 2nd, 4th, 6th, ... is the same
 *      distance on from the one before it, it is symmetry (number of indexes / 2), offset that
 *      distance -- the second index minus the first, the user's "teeth between the first tooth
 *      and second tooth + 1" (4 and 6 have one tooth between them and are 2 apart).
 *
 * Returns `{ index, symmetry, offset }`, or null when none of the rules fits, the list is empty,
 * or the result is not something the ruler can show: its index and offset are whole teeth and its
 * symmetry divides the gear (symmetryFits). Repeats count once; the order typed does not matter.
 */
export function symmetryFromIndices(indices, teeth) {
  const sorted = [...new Set(indices ?? [])].sort((a, b) => a - b);
  const count = sorted.length;

  if (count === 0) {
    return null;
  }

  const first = sorted[0];
  const usable = found => Number.isInteger(found.index) && Number.isInteger(found.offset)
    && symmetryFits(found.symmetry, teeth) ? found : null;

  if (count === 1) {
    return usable({ index: first, symmetry: 1, offset: 0 });
  }

  // The gaps from each index to the next, the last one wrapping across tooth 0 to the first.
  const gapsRound = list => list.map((value, i) => wrapIndex(list[(i + 1) % list.length] - value, teeth)
    || teeth);
  const allSame = gaps => gaps.every(gap => Math.abs(gap - gaps[0]) < SAME_GAP);

  if (allSame(gapsRound(sorted))) {
    return usable({ index: first, symmetry: count, offset: 0 });
  }

  if (count % 2 !== 0) {
    return null;
  }

  const bases = sorted.filter((_, i) => i % 2 === 0);
  const offsets = bases.map((base, k) => sorted[2 * k + 1] - base);

  if (allSame(gapsRound(bases)) && allSame(offsets)) {
    return usable({ index: first, symmetry: bases.length, offset: offsets[0] });
  }

  return null;
}

/**
 * How the sub bar sets a facet's indexes (the user's request, 2026-09-19): 'symmetric', the
 * ruler with its symmetry and offset, or 'arbitrary', a text box of indexes typed by hand, with
 * no ruler, symmetry or offset. Chosen in the gear dialog.
 */
export const indexMode = writable('symmetric');

/** The indexes typed in arbitrary mode, parsed (parseIndexList), in the order typed. */
export const arbitraryIndices = writable([]);

/**
 * Parses the arbitrary-mode text box: indexes separated by dashes, as the cutting instructions
 * print them ("4-12-20"), or by commas or spaces. Returns `{ indices, error }`: `error` is null
 * when every entry is an index on a `teeth`-tooth gear, 0 to teeth - 1, a whole tooth unless
 * `fractional` (the design's fractional-teeth opt-in) is on. An empty box is no indexes and no
 * error. A repeated index is kept once.
 */
export function parseIndexList(text, teeth, fractional) {
  const entries = text.split(/[\s,\-]+/).filter(entry => entry !== '');
  const indices = [];

  for (const entry of entries) {
    const value = Number(entry);

    if (!/^\d+(\.\d+)?$/.test(entry) || !Number.isFinite(value)) {
      return { indices: [], error: `"${entry}" is not an index.` };
    }

    if (value >= teeth) {
      return { indices: [], error: `${entry} is past the last tooth of the ${teeth}-tooth gear (${teeth - 1}).` };
    }

    if (!fractional && !Number.isInteger(value)) {
      return { indices: [], error: `${entry} is between teeth. Turn on fractional teeth in the gear dialog to allow it.` };
    }

    if (!indices.includes(value)) {
      indices.push(value);
    }
  }

  return { indices, error: null };
}

/** `value` wrapped onto a gear of `teeth` teeth, 0 to teeth - 1, for any real `value`. */
export function wrapIndex(value, teeth) {
  return ((value % teeth) + teeth) % teeth;
}

/**
 * How many teeth apart the ruler's big ticks are: the smallest divisor of `teeth` greater than
 * 4, the user's rule ("so 80 will be 5 and 96 will be 6"). A gear with no divisor between 5 and
 * itself (a prime count, or 4 or fewer teeth) gets `teeth`, so only index 0 is big.
 */
export function bigTickStep(teeth) {
  for (let divisor = 5; divisor < teeth; divisor++) {
    if (teeth % divisor === 0) {
      return divisor;
    }
  }

  return teeth;
}

/** Whether `symmetry` puts every copy on a whole tooth of a `teeth`-tooth gear. */
export function symmetryFits(symmetry, teeth) {
  return Number.isInteger(symmetry) && symmetry >= 1 && symmetry <= teeth && teeth % symmetry === 0;
}

/**
 * Every tooth the facet is cut at, highlighted on the ruler: `symmetry` copies of `index`
 * spread equally around the gear, and, when `offset` is not 0, a copy `offset` teeth from each.
 * Sorted and without repeats (an offset of a whole symmetry step lands on another copy).
 * `symmetry` must fit the gear (`symmetryFits`).
 */
export function highlightedIndices(index, teeth, symmetry, offset) {
  const step = teeth / symmetry;
  const found = new Set();

  for (let copy = 0; copy < symmetry; copy++) {
    const base = wrapIndex(index + copy * step, teeth);
    found.add(base);

    if (offset !== 0) {
      found.add(wrapIndex(base + offset, teeth));
    }
  }

  return [...found].sort((a, b) => a - b);
}

/**
 * The teeth the ruler writes a number over (2026-09-19, the user: "only show the indices of the
 * starting facet/the clicked facet's tooth + the starting facet's/the clicked facet's offset
 * tooth (if any)... too many numbers is confusing"): the facet's own tooth, and the one `offset`
 * teeth from it when there is an offset. Its symmetry copies are still drawn highlighted by
 * `highlightedIndices`, just without numbers. Sorted, and without a repeat when an offset of a
 * whole turn lands back on the tooth itself.
 */
export function labelledIndices(index, teeth, offset) {
  const own = wrapIndex(index, teeth);
  const copy = wrapIndex(index + offset, teeth);

  return copy === own ? [own] : [own, copy].sort((a, b) => a - b);
}

/**
 * The ticks to draw for a ruler scrolled to `position` (a real number of teeth; the whole tooth
 * nearest it is under the centre marker) and `halfWidth` teeth either side of the centre. Each is
 * `{ offset, index, big }`: `offset` teeth from the centre (so its x is centre + offset * pixels
 * per tooth), `index` the tooth it marks, wrapped, and `big` whether it is a big tick.
 */
export function visibleTicks(position, halfWidth, teeth) {
  const step = bigTickStep(teeth);
  const first = Math.ceil(position - halfWidth);
  const last = Math.floor(position + halfWidth);
  const ticks = [];

  for (let tooth = first; tooth <= last; tooth++) {
    const index = wrapIndex(tooth, teeth);
    ticks.push({ offset: tooth - position, index, big: index % step === 0 });
  }

  return ticks;
}
