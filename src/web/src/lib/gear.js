// The index gear: the sub bar's tooth count and the edit history's snapshots of it. No DOM here;
// GearDialog.svelte and SubBar.svelte draw it. (The dialog's validation is gear_check.js.)

import { writable, get } from 'svelte/store';

/**
 * The index gear's tooth count when nothing loaded says otherwise: the built-in stone's
 * gear, and what opening a plain .obj (which carries no faceting design at all, so it has
 * no gear of its own) resets the sub bar's reading to.
 */
export const DEFAULT_GEAR_TEETH = 96;

/** The tooth count the sub bar shows (`#gear-teeth`). */
export const gearTeeth = writable(DEFAULT_GEAR_TEETH);

/**
 * Sets the sub bar's index-gear reading (T-0141): a loaded GemCad design's own tooth count
 * when one is known, DEFAULT_GEAR_TEETH otherwise, so the button never lies about which
 * wheel is in use. Callers pass an already-non-negative count -- GemCad writes a negative
 * gear only to mean the index wheel runs the other way, not a different tooth count -- see
 * loadModelFile's Math.abs.
 */
export function setGearTeeth(teeth) {
  gearTeeth.set(Number(teeth));
}

/**
 * Everything a gear dialog Apply changes, for the edit history: the sub bar's reading, the
 * design's gear, and every facet's index. Facets are held by OBJECT, like the tier ops, so a
 * snapshot still applies after the tiers have been reordered. `design` null (a plain .obj)
 * leaves only the reading.
 */
export function gearSnapshot(design) {
  return {
    teeth: get(gearTeeth),
    gear: design ? { ...design.gear } : null,
    facets: design ? design.tiers.flatMap(tier => tier.facets.map(facet => [facet, facet.index])) : [],
  };
}

export function sameGearSnapshot(a, b) {
  return a.teeth === b.teeth &&
    JSON.stringify(a.gear) === JSON.stringify(b.gear) &&
    a.facets.every(([facet, index], i) => b.facets[i][0] === facet && b.facets[i][1] === index);
}

/** Puts a gearSnapshot back: the reading, the gear's fields and each facet's index. */
export function applyGearSnapshot(design, snapshot) {
  setGearTeeth(snapshot.teeth);

  if (design && snapshot.gear) {
    Object.assign(design.gear, snapshot.gear);
  }

  for (const [facet, index] of snapshot.facets) {
    facet.index = index;
  }
}
