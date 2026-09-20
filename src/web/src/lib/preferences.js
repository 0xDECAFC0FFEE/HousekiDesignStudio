// The user's display preferences, set in File > Settings (SettingsDialog.svelte) and kept in the
// browser's localStorage so they survive a reload. Like the theme's own saved choice, a store
// that cannot be read or written (private modes, blocked site data) only costs the saved value:
// the preference then lasts until the page is closed.

import { writable } from 'svelte/store';

const ANGLE_DECIMALS_KEY = 'houseki.angleDecimals';

/** The fewest and most decimal places a tier's angle may show. */
export const MIN_ANGLE_DECIMALS = 0;
export const MAX_ANGLE_DECIMALS = 6;
export const DEFAULT_ANGLE_DECIMALS = 2;

/**
 * `value` as a whole number of decimal places within the allowed range; the default for
 * anything that is not a number.
 */
export function clampAngleDecimals(value) {
  const places = Math.round(Number(value));

  if (!Number.isFinite(places)) {
    return DEFAULT_ANGLE_DECIMALS;
  }

  return Math.min(MAX_ANGLE_DECIMALS, Math.max(MIN_ANGLE_DECIMALS, places));
}

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch (cause) {
    return null;
  }
}

function readAngleDecimals() {
  try {
    const saved = storage()?.getItem(ANGLE_DECIMALS_KEY);

    return saved === null || saved === undefined ? DEFAULT_ANGLE_DECIMALS : clampAngleDecimals(saved);
  } catch (cause) {
    return DEFAULT_ANGLE_DECIMALS;
  }
}

const angleDecimalsStore = writable(readAngleDecimals());

/**
 * How many decimal places an angle shows: in the instructions, and on edit mode's angle ruler. A store whose `set` clamps
 * the value and saves it.
 */
export const angleDecimals = {
  subscribe: angleDecimalsStore.subscribe,
  set(value) {
    const places = clampAngleDecimals(value);

    angleDecimalsStore.set(places);

    try {
      storage()?.setItem(ANGLE_DECIMALS_KEY, String(places));
    } catch (cause) {
      // Losing the saved value is not worth breaking the dialog over.
    }
  },
};
