// The settings panel's fixed tables: which parameters are sliders, how each reads out, what
// each renderer's tooltip says (ported from the page's script).

// Lighting model values whose colors are measurements. Must match
// `LightingModel::is_analytical` in params.rs.
export const ANALYTICAL_LIGHTING_MODELS = ['1', '2', '3'];

/**
 * Sliders that map one-to-one onto a Rust parameter name.
 *
 * The absorption scale, out-of-bounces shade, spectral samples, observer radius, exposure,
 * environment intensity and rotation, and field of view are no longer shown, at the user's
 * request (the absorption itself is, as the stone color; see ColorSetting): they
 * keep their Rust defaults (still settable with `gemApp.set_param` from the console). Spectral
 * samples follow the dispersion instead; see syncSpectralSamples.
 */
export const PARAM_SLIDERS = [
  'refractiveIndex', 'dispersion', 'maxBounces', 'headShadowHalfAngle', 'spin', 'tilt',
  'luxSamples',
];

/**
 * Which of `PARAM_SLIDERS` persist across reloads (T-0156, "update the default saved for
 * the user" on every change to a Tracing or Lighting control): only the three that are
 * actually in those two boxes. Material's `refractiveIndex`/`dispersion` are a material
 * preset's own fields, not a standalone setting (picking a preset already overwrites them),
 * and View's `spin`/`tilt` are the current pose, not a rendering setting -- neither is asked
 * for, so both stay session-only like before. Each is saved under `gems.<name>` and restored
 * through the exact same `applyParam` (hence the same Rust setter and clamp) a slider move
 * uses, per the ticket's own requirement.
 */
export const PERSISTED_PARAM_SETTINGS = ['maxBounces', 'headShadowHalfAngle', 'luxSamples'];

/**
 * What each renderer does for the person using the page, shown as the picker's tooltip.
 * Indexed by the encoding `params::Renderer::as_u32` uses, which `renderer_names()` also
 * lists in.
 *
 * Written for users, not for this project's developers (the user's request, 2026-09-18): what
 * the picture looks like, how fast it arrives, and what each gives up.
 *
 * **Both path tracers now also name the physics they use and what they leave out** (the user's
 * request, 2026-09-19: "go into detail about what first principles physics equations are used
 * (eg tir, snell's law...) along with what it doesn't model"), which softens the 2026-09-18
 * decision to keep all of it out. The LAWS are named; **the equations themselves are not
 * written out, and each tip stays about as long as it was** (the user, 2026-09-19: "don't
 * mention the equations themselves and it should be about the same length as the current
 * deterministic tooltip"). The Gem Cut Studio comparison came out of the first tip at the same
 * time ("we don't need to mention deterministic is based on the gcs renderer").
 *
 * Every claim was checked against the shader source, not against the docs:
 *   - Deterministic: `fresnelReflectance`, `refractRay` and `traceInterior` in
 *     `src/shaders/gem.frag`, and `RenderParams::spectral_indices` in `src/params.rs` for the
 *     three fixed indices (n - d/2, n, n + d/2 into red, green, blue).
 *   - Monte Carlo: `src/shaders/lux/glass.glsl` (Fresnel, Snell, TIR, the Cauchy index),
 *     `lux/volume.glsl` (the RGB Beer-Lambert filter) and `lux/pathtracer.glsl`.
 * The equation forms were checked against outside references too -- the unpolarised Fresnel
 * reflectance as the mean of the two polarisations, and two-term Cauchy over the gemmological
 * B (686.7 nm) to G (430.8 nm) interval -- and both match what the code does. The forms, the
 * references and what each renderer omits are in kb/optics-and-shader-conventions.md.
 *
 * The rest of the implementation comparison -- the shared BVH, LuxCore's R + T != 1 quirk, the
 * measured agreement with the oracle -- is still in kb/architecture.md's "Two renderers" and
 * kb/wiring-the-luxcore-port-in-behind-a-runtime-togg.md.
 */
export const RENDERER_HINTS = [
  'Fast and noise-free: the picture is finished the moment it appears, so it is the one for ' +
    'turning the stone and comparing cuts, and the only one that can outline the facets. ' +
    'Traced from first principles: Snell’s law, the full Fresnel equations, total ' +
    'internal reflection and Beer-Lambert absorption. Not modelled: polish, inclusions, ' +
    'polarization, birefringence, and its fire (the rainbow colors) comes from three fixed ' +
    'colors rather than a spectrum.',
  'More realistic, especially the fire (the rainbow colors), but slower: the picture starts ' +
    'grainy and sharpens while the view is left still, any change restarts it, and it cannot ' +
    'outline the facets. The same first principles — Snell’s law, the full Fresnel ' +
    'equations, total internal reflection, Beer-Lambert absorption — but one wavelength ' +
    'is picked at each refraction, so the fire is spectral, and light leaving the stone is ' +
    'traced back against it. Not modelled: polish, inclusions, polarization, birefringence, or ' +
    'absorption that varies with wavelength.',
  'No rendering at all: the stone is a flat, opaque surface in the stone color, with no ' +
    'light, reflection or fire. Instant, and with the facet wireframe on it is a clean ' +
    'drawing of the facets.',
];

/** Sliders that turn the view, so moving them drops quality like a mouse drag does. */
export const VIEW_SLIDERS = ['spin', 'tilt'];

/** An angle in degrees for a readout, with a decimal only when it has one. */
export function formatDegrees(v) {
  return `${Number(v.toFixed(1))}°`;
}

/** Formatting per parameter, purely for the readout. */
export const FORMAT = {
  spin: formatDegrees,
  tilt: formatDegrees,
  refractiveIndex: v => v.toFixed(3),
  dispersion: v => v.toFixed(3),
  maxBounces: v => String(Math.round(v)),
  // Already in degrees on the Rust side, and quoted as a half angle, so the readout
  // shows both it and the full obscured cone to save the reader doubling it.
  headShadowHalfAngle: v => (v <= 0 ? 'off' : `${v.toFixed(0)}° (${(v * 2).toFixed(0)}° cone)`),
  luxSamples: v => String(Math.round(v)),
};

/**
 * Puts `value` where a slider with `spec` can actually sit: clamped to the range, and rounded to
 * the nearest step counted from the minimum. What assigning to a native `<input type=range>`
 * did for free, and the page's page-only sliders (the resolutions, the sample target) relied on
 * when a typed readout value was applied through the element. The slider is a Bits UI one now,
 * which is not an input, so it is done here. The result is rounded to the step's own number of
 * decimals, so 0.15 + 3 * 0.05 is 0.3 and not 0.30000000000000004.
 */
export function snapToSpec(value, spec) {
  const clamped = Math.min(Math.max(value, spec.min), spec.max);
  const steps = Math.round((clamped - spec.min) / spec.step);
  const decimals = (String(spec.step).split('.')[1] || '').length;
  // The last step may not fit in the range (a range that is not a whole number of steps).
  const snapped = spec.min + steps * spec.step;

  return Number((snapped > spec.max ? snapped - spec.step : snapped).toFixed(decimals));
}

/** Lighting model values not offered in the dropdown: 0, the procedural studio rig. */
export const HIDDEN_LIGHTING_MODELS = ['0'];

/**
 * Every slider's range, one place, for the markup and for the code that validates a stored
 * value against it. The panel's sliders used to carry these as attributes on the elements and
 * the restore code read them back off the DOM; the components take them from here instead.
 */
export const SLIDER_SPECS = {
  refractiveIndex: { min: 1, max: 3, step: 0.001 },
  dispersion: { min: 0, max: 0.3, step: 0.001 },
  // Floor 3, not 1: matches Rust's own MIN_BOUNCES (2026-09-22, the user: "make the minimum
  // max internal bounces 3" -- below 3 a stone barely reads as glass).
  maxBounces: { min: 3, max: 32, step: 1 },
  headShadowHalfAngle: { min: 0, max: 90, step: 1 },
  spin: { min: -180, max: 180, step: 1 },
  tilt: { min: -180, max: 180, step: 1 },
  luxSamples: { min: 1, max: 64, step: 1 },
  // Page-only settings, with no Rust parameter behind them.
  'lux-target': { min: 1, max: 4096, step: 1, value: 512 },
  resolution: { min: 0.15, max: 1, step: 0.05, value: 1 },
  'drag-quality': { min: 0.15, max: 1, step: 0.05, value: 0.4 },
};
