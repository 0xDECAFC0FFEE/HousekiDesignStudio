// Persisted settings, in localStorage (ported from the page's script).

/**
 * Reads a persisted setting, or `null` if it was never saved.
 *
 * **Not `document.cookie`.** The user asked for "persistent cookies", but cookies are a
 * no-op on a `file://` page -- confirmed directly: `document.cookie = 'foo=bar'` followed
 * immediately by reading `document.cookie` back gives `''` in this Chrome, on this page,
 * every time. The project's binding constraint is that the page must keep working from
 * `file://` (see CLAUDE.md / kb/failed-approaches.md), and a persistence mechanism that
 * silently persists nothing fails that a different way than a missing feature would --
 * settings would look saved and never actually survive a reload. `localStorage`, checked the
 * same way, does work from `file://` and is scoped to this exact file path, which is exactly
 * the "this page remembers what you set" the user asked for. Kept under a name that says
 * "setting", not "cookie", so the code does not claim a mechanism it does not use.
 */
export function readSetting(name) {
  try {
    return localStorage.getItem(name);
  } catch (cause) {
    // Private-browsing modes and some embedders throw on storage access rather than just
    // returning null; a missing saved setting is not worth failing the page over.
    return null;
  }
}

/** Writes a persisted setting. See `readSetting` for why this is `localStorage`, not a
 * cookie. */
export function writeSetting(name, value) {
  try {
    localStorage.setItem(name, value);
  } catch (cause) {
    // Same reasoning as readSetting: losing persistence is not worth losing the page over.
  }
}

/**
 * Reads a persisted numeric setting, or `fallback` if it is missing, not a finite number, or
 * outside `[min, max]` (T-0156's own rule: "a missing, corrupt or out-of-range stored value
 * falls back to the Rust default"). An out-of-range value is treated exactly like a missing
 * one -- NOT clamped to the nearest bound -- so a control never ends up showing a value the
 * stored number did not actually say (a slider silently pinned at its max because a corrupt
 * value overshot it, say). `min`/`max` are normally read straight off the control's own
 * slider (its `min`/`max` attributes), which is usually narrower than whatever Rust itself
 * would clamp the same parameter to: `luxSamples`'s slider covers 1-64, but Rust clamps up
 * to 4096 (`MAX_LUX_SAMPLES`, src/params.rs), so validating against the SLIDER's range here
 * is what stops a corrupt stored value in, say, 65-4096 from passing Rust's own clamp and
 * silently sitting past the end of the visible slider.
 */
export function readSettingNumber(name, min, max, fallback) {
  const raw = readSetting(name);

  if (raw === null) {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** Reads a persisted boolean setting ("true"/"false"), or `fallback` if missing or anything
 * else. */
export function readSettingBool(name, fallback) {
  const raw = readSetting(name);

  if (raw === 'true') {
    return true;
  }

  if (raw === 'false') {
    return false;
  }

  return fallback;
}

/** Reads a persisted RGB color ("r,g,b", each 0..1) as a 3-element array, or `fallback` if
 * missing or malformed in any way (wrong number of parts, any part not a finite 0..1 number). */
export function readSettingColor(name, fallback) {
  const raw = readSetting(name);

  if (raw === null) {
    return fallback;
  }

  const parts = raw.split(',').map(Number);
  const valid = parts.length === 3 && parts.every(n => Number.isFinite(n) && n >= 0 && n <= 1);

  return valid ? parts : fallback;
}

/** Writes an RGB color (each channel 0..1) as the "r,g,b" text `readSettingColor` reads back. */
export function writeSettingColor(name, rgb) {
  writeSetting(name, rgb.map(n => n.toFixed(6)).join(','));
}

export const INSTRUCTIONS_WIDTH_SETTING = 'gems.instructionsWidth';
export const INSTRUCTIONS_WIDTH_MIN = 200;
export const INSTRUCTIONS_WIDTH_MAX = 480;
