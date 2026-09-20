// Colour conversions and the HSV picker's channel table (ported from the page's script).

/**
 * Red, green and blue in 0..1 (what the Rust color getters return) to `{ h, s, v }`: hue in
 * degrees, 0 to 360, and saturation and value in 0..1. The hue of a grey is 0, and its
 * saturation 0 when it is black; ColorSetting keeps the previous ones instead.
 */
export function rgbToHsv(channels) {
  const [r, g, b] = Array.from(channels, channel => Math.min(Math.max(channel, 0), 1));
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  let h = 0;

  if (chroma > 0) {
    if (max === r) {
      h = ((g - b) / chroma + 6) % 6;
    } else if (max === g) {
      h = (b - r) / chroma + 2;
    } else {
      h = (r - g) / chroma + 4;
    }
  }

  return { h: h * 60, s: max > 0 ? chroma / max : 0, v: max };
}

/** `{ h, s, v }` as rgbToHsv returns it, to `[r, g, b]` in 0..1, what the Rust setters take. */
export function hsvToRgb({ h, s, v }) {
  const channel = n => {
    const k = (n + h / 60) % 6;

    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };

  return [channel(5), channel(3), channel(1)];
}

/** `[r, g, b]` in 0..1 as a CSS color, for swatches and slider tracks. */
export function cssColor(rgb) {
  return `rgb(${rgb.map(channel => Math.round(channel * 255)).join(', ')})`;
}

/** `#rrggbb`, the shape of `EyeDropperResult.sRGBHex`, to `[r, g, b]` in 0..1. */
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);

  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map(channel => channel / 255);
}

/**
 * The three sliders of an HSV picker. HSV because Gem Cut Studio's color sliders are HSV
 * (labelled HSL; see kb/window-and-head-shadow-colours.md), and on the same scales, so its
 * numbers, such as window 288 / 1 / 1, can be typed into the readouts as they are.
 */
export const HSV_CHANNELS = [
  { key: 'h', name: 'Hue', max: 360, step: 1, format: v => `${Math.round(v)}°` },
  { key: 's', name: 'Saturation', max: 1, step: 0.001, format: v => v.toFixed(3) },
  { key: 'v', name: 'Value', max: 1, step: 0.001, format: v => v.toFixed(3) },
];
