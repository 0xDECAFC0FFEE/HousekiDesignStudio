// -----------------------------------------------------------------------------
// Host integration for the ported LuxCore path.                            T-0120
//
// This file is NOT ported LuxCore code and carries no LuxCore copyright. It is the
// wiring layer the ported files were written to expect: it declares the `uniform`s the
// host (src/lib.rs) sets, and fills in the `#ifndef`-guarded HOST INTEGRATION POINT
// macros that src/shaders/lux/lights.glsl documents in its own file header ("WHAT THE
// HOST MUST SUPPLY"). It must be concatenated after prelude.glsl and before every other
// lux/*.glsl file, because a `#define` only affects text that follows it.
//
//   Copyright 2026 Lucas Tong
//   Licensed under the Apache License, Version 2.0 (see LICENSE and NOTICE).
// -----------------------------------------------------------------------------

#ifndef LUX_HOST_GLSL
#define LUX_HOST_GLSL

// Values of the uRenderer uniform. Must match `params::Renderer::as_u32`; a test enforces
// that.
const int RENDERER_DETERMINISTIC = 0;
const int RENDERER_LUXCORE = 1;
// No rendering, only an opaque surface in the stone colour: gem.frag's renderFlat().
const int RENDERER_FLAT = 2;

// Which renderer draws this frame. See src/shaders/lux/entry.glsl's main().
uniform int uRenderer;

// Samples per pixel the ported path takes in ONE pass, i.e. in one draw of the
// accumulate pass below.
//
// Since T-0122 the ported path converges across frames rather than inside one draw, so
// this defaults to 1 and a frame costs about what the deterministic renderer's frame
// costs. It is still a control because the accumulation buffer can be unavailable -- a
// browser without EXT_color_buffer_float falls back to LUX_PASS_DIRECT, where this is
// once again the only way to take more than one sample. See entry.glsl and
// params::DEFAULT_LUX_SAMPLES.
uniform int uLuxSamples;

// Mixed into the per-pixel RNG seed, so each pass draws a different stream and a caller
// can ask for an independent noise realisation of the same scene.
//
// src/lib.rs sends `lux_seed + passIndex`, NOT a frame counter: the pass index is a
// property of the accumulation, so "reset, then render N times" always draws the same N
// streams and stays byte-reproducible. That is what lets tests/harness/gem.py keep
// comparing two renders for equality (see its capture()).
uniform int uLuxSeed;

// What this draw is for. Values of uLuxPass; must match `LUX_PASS_*` in src/lib.rs, and a
// test enforces that.
//
//   DIRECT      trace and tone map straight to the canvas, in one draw, exactly as the
//               path did before T-0122. Used for the deterministic renderer, for the debug
//               views, and as the fallback when no float render target is available.
//   ACCUMULATE  trace and add this pass's radiance to the running sum in uLuxAccum,
//               writing LINEAR radiance (no tone map) into a float framebuffer.
//   RESOLVE     no tracing at all: read the sum, divide by uLuxPassCount, tone map, and
//               write that to the canvas.
const int LUX_PASS_DIRECT = 0;
const int LUX_PASS_ACCUMULATE = 1;
const int LUX_PASS_RESOLVE = 2;

uniform int uLuxPass;

// How many passes the sum in uLuxAccum contains: the divisor that turns it back into a
// mean radiance. Only read by the resolve pass.
uniform int uLuxPassCount;

// The accumulated radiance sum, an RGBA32F texture the size of the backing store
// (gpu::AccumulationTargets). Read with texelFetch at the fragment's own integer
// coordinate -- it is a buffer, not an image, and there is nothing to filter.
//
// Ping-ponged host-side: the accumulate pass reads this and draws into the OTHER target,
// because sampling the texture attached to the bound framebuffer is undefined.
uniform sampler2D uLuxAccum;

// uResolution, the backing-store size in pixels, turns the sampler's sub-pixel screen
// samples (RandomSampler_InitNewSample's `pixelX + rnd`) into normalised device
// coordinates. It is declared in gem.frag, which is concatenated ahead of this file,
// because the deterministic renderer's facet wireframe measures in pixels too.

// Cauchy coefficients of the glass, NOT an index of refraction at any wavelength:
// LuxCore feeds `scene.materials.<m>.interiorior` into `n(lambda) = A + B / lambda_um^2`
// as A directly (GlassMaterial_WaveLength2IOR in glass.glsl, and the trap recorded in
// kb/luxcore-as-a-reference-oracle.md). `params::cauchy_from_gemmological_constants`
// does the conversion host-side and is unit tested against
// tools/luxcore_oracle.py's own `cauchy_from_gemmological_constants`.
uniform float uLuxCauchyA;
uniform float uLuxCauchyB;

// Which environment the ported path lights the stone with: this project's own (the
// lighting model the page shows, through gem.frag's sampleEnvironment) or LuxCore's
// native constantinfinite sky plus suns. Encoded by `params::LuxEnvironment::as_u32`;
// lights.glsl declares the two values as LUX_ENVIRONMENT_PROJECT / LUX_ENVIRONMENT_LUXCORE
// and a test enforces the match.                                                  T-0127
//
// The default is the project's own environment. LuxCore's native rig is what
// tools/compare_luxcore.py scores the port against -- the oracle scenes are built from
// exactly that rig -- so it stays reachable; tests/harness/gem.py asks for it whenever
// $GEM_RENDERER selects the ported renderer, next to the lighting model and flat
// background it already forces to match the oracle scene.
uniform int uLuxEnvironment;

// ConstantInfiniteLight's `color`. The oracle scenes set `scene.lights.sky.color =
// 1 1 1`; its `gain` is gem.frag's existing uEnvIntensity (see LUX_SKY_GAIN below).
uniform vec3 uLuxSkyColor;

// How many of uLuxSunDir are live: 0 reproduces the oracle's `isometric` rig (sky only),
// 5 its `studio` rig. Clamped host-side to 0..LUX_ENV_MAX_SUNS.
uniform int uLuxSunCount;
// Every sun in the studio rig shares one relSize (`scene.lights.sun<n>.relsize`).
uniform float uLuxSunRelSize;

// LuxCore's own `relsize 1` is the real sun; see tools/luxcore_oracle.py. The array size
// is fixed at compile time because GLSL has no dynamic allocation; lights.glsl calls the
// same bound LUX_ENV_MAX_SUNS, which this file defines for it below.
#define LUX_ENV_MAX_SUNS 5
uniform vec3 uLuxSunDir[LUX_ENV_MAX_SUNS];

// The oracle's horizon occluder: `scene.objects.horizon`, a black matte quad spanning
// [-r, r] in x and z at y = uLuxHorizonY (tools/luxcore_oracle.py's --horizon-y -1.2 and
// --horizon-radius 5000). See luxHorizonDistance() below for what it is doing here rather
// than in the scene geometry.
uniform float uLuxHorizonY;
uniform float uLuxHorizonRadius;

// `path.russianroulette.cap`, LuxCore's default 0.5. Inert for this scene -- Russian
// roulette provably never fires while every material is delta-specular glass (see
// kb/luxcore-path-integrator-port-dead-russian-roulet.md) -- but passed in rather than
// hard-coded so the ported branch stays honest.
uniform float uLuxRrImportanceCap;

// -----------------------------------------------------------------------------
// THE HORIZON OCCLUDER, AND WHY IT IS ROUTED THROUGH THE SKY COLOUR.
//
// The LuxCore oracle scene (tools/luxcore_oracle.py, environment_rig) is a uniform
// `constantinfinite` sky PLUS a large black `matte` quad under the stone. The quad is
// what makes the background black and what stops light arriving from below the horizon;
// the sky itself is uniform over the whole sphere, and lights.glsl's
// ConstantInfiniteLight_GetRadiance is ported faithfully as exactly that.
//
// So the occluder is scene *geometry* with its own *material*. The ported integrator
// (pathtracer.glsl) has exactly one hard-coded material: `Scene_Intersect` returning a
// hit always leads to GlassMaterial_Sample, and there is no way to say "this hit is a
// black absorber, end the path with nothing" without editing PathTracer_RenderEyePath,
// which T-0120 is explicitly not allowed to do (and should not: it is a faithful port).
//
// What this file does instead is exactly equivalent for an eye-path integrator, because a
// black matte surface contributes nothing and terminates the path:
//
//   * Scene_Intersect (pathtracer.glsl) intersects the quad as well as the stone. If the
//     quad is the nearer hit it reports a MISS and sets gLuxSkyVisibility to 0.
//   * The integrator's miss branch then calls Env_GetRadiance, whose sky term is
//     multiplied by gLuxSkyVisibility and so contributes exactly BLACK, and the path
//     ends -- the same radiance and the same path length as hitting LuxCore's kd=0 matte.
//
// This is a real structural deviation from the port, not a rounding difference, and it is
// ticketed (see T-0120's log): the right long-term fix is a second material in the
// integrator, which is a change to ported code and therefore its own ticket.
//
// One residual difference, stated rather than hidden: the suns are NOT gated by
// gLuxSkyVisibility (LUX_ENV_SUN_COLOR is T-0119's placeholder and this file does not
// touch it). Every sun in the shipped studio rig sits 18-60 degrees off world +Y, so no
// ray that hits a quad 1.2 below the stone can also be inside a sun's 6-degree cone, and
// the isometric rig -- the only one compare_luxcore.py will score -- has no suns at all.
// -----------------------------------------------------------------------------

// 1.0 when the escaping ray reaches the sky, 0.0 when the horizon quad swallowed it.
// Written by Scene_Intersect on every call, read by ConstantInfiniteLight_GetRadiance
// through LUX_SKY_COLOR below. A shader global rather than a threaded parameter because
// the ported call chain in between (Scene_Intersect -> PathTracer_RenderEyePath ->
// PathTracer_DirectHitInfiniteLight -> Env_GetRadiance -> ConstantInfiniteLight_
// GetRadiance) is ported code this ticket may not re-sign.
float gLuxSkyVisibility = 1.0;

// -----------------------------------------------------------------------------
// HAS THIS PATH MET THE STONE YET?                                             T-0137
//
// false from the start of every eye path until Scene_Intersect reports a real hit on the
// stone; read only by lights.glsl's Env_ProjectRadiance, i.e. only when the ported path is
// lit by THIS PROJECT's environment (LUX_ENVIRONMENT_PROJECT). LuxCore has no such concept
// and never reads it, so the LuxCore-native rig the oracle comparison scores is untouched.
//
// Why it has to exist. gem.frag has two different rules for "what light comes from that
// direction", and which one applies depends on something the direction alone cannot say:
//
//   * renderHandWritten()'s primary-miss branch -- a camera ray that never met the stone:
//     the flat background colour if enabled, otherwise the environment. NO window colour.
//   * arrivingLight() -- light leaving (or reflecting off) the stone: the separate window
//     colour first when the ray reads as coming from behind the stone, then the flat
//     background, then the environment.
//
// The ported path reaches the environment through exactly one seam, Env_GetRadiance(
// direction, out directPdfW), which carries a direction and nothing else -- so before
// T-0137 it applied arrivingLight()'s cascade to every lookup, camera misses included.
// A camera ray always reads as "below the lighting horizon" (toLightingFrame's +Y is the
// direction back towards the viewer, so a ray leaving the eye has y < 0 at every pose),
// which made every background pixel the window colour whenever one was enabled. See
// kb/luxcore-port-s-window-colour-floods-the-whole-ba.md.
//
// A shader global for exactly the reason gLuxSkyVisibility above is one: the call chain in
// between (Scene_Intersect -> PathTracer_RenderEyePath -> PathTracer_DirectHitInfiniteLight
// -> Env_GetRadiance) is ported code, and widening its signatures would be a change to the
// port rather than to this project's own Gem Cut Studio glue -- which is all this is.
//
// Written by Scene_Intersect's LUX_HAS_GEM_FRAG arm (pathtracer.glsl -- that arm is this
// project's bridge to gem.frag's traceScene, not ported code) and reset per eye path by
// entry.glsl's sample loop.
// -----------------------------------------------------------------------------
bool gLuxPathHitStone = false;

// -----------------------------------------------------------------------------
// gLuxPathWaveLength / gLuxPathTinted -- the one wavelength an eye path carries through a
// dispersive stone (T-0092, 2026-09-25).
//
// Upstream LuxCore draws a new wavelength at every transmission and evaluates reflection
// at an undispersed index; both are upstream-acknowledged bugs (LuxCore issues #262 and #47)
// that made the stone lose light and blur its fire. The user chose to fix them, so the path
// now keeps one wavelength (nm, uniform over upstream's own 380-780 range), which
// glass.glsl's GlassMaterial_Sample uses for both Fresnel terms at every surface.
// gLuxPathTinted records that the wavelength's WaveLength2RGB tint has been folded into the
// throughput, which happens once, at the path's first transmission. See the header of
// glass.glsl for the full argument and the measurements.
//
// Globals for the same reason gLuxPathHitStone is one: the chain between entry.glsl and
// glass.glsl is ported code whose signatures this project does not widen. Both are set per
// eye path by entry.glsl's sample loop, and only read or written by glass.glsl.
// -----------------------------------------------------------------------------
float gLuxPathWaveLength = 580.0;
bool gLuxPathTinted = false;

// Distance along `direction` at which a ray from `origin` meets the horizon quad, or a
// negative value when it never does.
//
// The quad is finite (radius uLuxHorizonRadius, 5000 by default) and the test is exact
// rather than the cheap "is the direction pointing down" approximation, because being
// exact here costs four instructions and removes a whole class of "why is the horizon
// slightly different" question later. The quad is single-sided in the .scn's winding but
// LuxCore's matte is two-sided and kd = 0 either way, so no facing test is applied.
float luxHorizonDistance(vec3 origin, vec3 direction) {
    // Parallel to the quad's plane: no intersection (and no 0/0).
    if (abs(direction.y) < 1e-12) {
        return -1.0;
    }

    float t = (uLuxHorizonY - origin.y) / direction.y;

    if (t <= 0.0) {
        return -1.0;
    }

    vec3 hit = origin + direction * t;

    if (abs(hit.x) > uLuxHorizonRadius || abs(hit.z) > uLuxHorizonRadius) {
        return -1.0;
    }

    return t;
}

// -----------------------------------------------------------------------------
// The HOST INTEGRATION POINT macros lights.glsl leaves `#ifndef`-guarded for exactly this
// purpose. Defining them here suppresses that file's placeholder constants.
// -----------------------------------------------------------------------------

// `scene.lights.sky.color`, times the horizon occluder's visibility (see above).
#define LUX_SKY_COLOR (uLuxSkyColor * gLuxSkyVisibility)

// `scene.lights.sky.gain`. gem.frag's existing uEnvIntensity IS this quantity: it is the
// multiplier on incident environment radiance, and tools/compare_luxcore.py already sets
// it equal to the LuxCore run's --env-gain for precisely that reason
// (kb/luxcore-vs-ours-comparison-harness.md). Reused rather than duplicated so the two
// renderers cannot be given different sky gains by accident. A float where lights.glsl's
// placeholder was a vec3, which is fine: it only ever appears in `vec3(1.0) *
// LUX_SKY_GAIN * LUX_SKY_COLOR`.
#define LUX_SKY_GAIN uEnvIntensity

// Which environment Env_GetRadiance evaluates (T-0127). lights.glsl's own placeholder is
// LUX_ENVIRONMENT_LUXCORE, so a wrongly assembled unit falls back to the rig that file
// actually implements rather than to a gem.frag it cannot see.
#define LUX_ENVIRONMENT_SOURCE uLuxEnvironment

#define LUX_ENV_SUN_COUNT uLuxSunCount
#define LUX_ENV_SUN_RELSIZE uLuxSunRelSize
#define LUX_ENV_SUN_DIR uLuxSunDir

// LUX_ENV_SUN_COLOR is deliberately NOT defined here. It is T-0119's ticket: the real
// value is SunLight::Preprocess's 91-sample atmospheric-attenuation integral, and
// lights.glsl ships an inert vec3(1.0) placeholder precisely so a render with the wrong
// sun colour looks obviously wrong rather than plausibly wrong. Leaving the placeholder in
// place is the instruction this ticket was given; inventing a number here would hide
// T-0119 rather than close it.

// -----------------------------------------------------------------------------
// THE GEM'S INTERIOR VOLUME.                                                   T-0123
//
// src/shaders/lux/volume.glsl ports LuxCore's `homogeneous` volume, which is how LuxCore
// expresses Beer-Lambert absorption inside a solid:
//
//   scene.volumes.geminterior.type = homogeneous
//   scene.volumes.geminterior.absorption = <sigmaA>
//   scene.volumes.geminterior.scattering = 0 0 0
//   scene.materials.gem.volume.interior = geminterior
//
// `uAbsorption` IS that absorption. It is gem.frag's existing per-channel Beer-Lambert
// coefficient in inverse world units -- exactly the quantity `scene.volumes.<v>.absorption`
// holds, and exactly what gem.frag's own traceInterior puts in `exp(-uAbsorption * t)` --
// so it is reused rather than duplicated, the same reasoning as LUX_SKY_GAIN above. The
// two renderers therefore cannot be given different absorptions by accident, and
// `tools/luxcore_oracle.py --absorption "R G B"` writes the same three numbers into the
// oracle's scene.
//
// Scattering and emission stay at LuxCore's own defaults (0 0 0). This project's material
// model has no scattering coefficient to plumb in and the gem is not emissive; keeping
// sigmaS black is also what makes volume.glsl's single-volume subset sufficient, because a
// scattering event would need the phase-function path vertex that subset does not port
// (see volume.glsl's header and T-0131). They are spelled out here rather than left to
// volume.glsl's standalone defaults so this file states the whole scene in one place.
// -----------------------------------------------------------------------------

#define LUX_VOLUME_SIGMA_A uAbsorption
#define LUX_VOLUME_SIGMA_S BLACK
#define LUX_VOLUME_EMISSION BLACK
#define LUX_VOLUME_MULTISCATTERING false

// -----------------------------------------------------------------------------
// FROSTED FACETS.                                                              T-0183
//
// One texel per facet id, red channel 1.0 where the facet is frosted and 0.0 where it is
// polished: GemApp::set_frosted_facets builds it exactly as set_highlighted_facets builds
// gem.frag's uHighlightTexture (lib.rs's facet_mask_texels), sized to the loaded stone's own
// facet count, with no fixed cap. The page sends the facets of every tier whose Frosted flag
// is on, and re-sends them after every rebuild, because facet ids belong to one mesh.
//
// Read only here, and only by the ported path: a frosted facet is LuxCore's RoughGlassMaterial
// (lux/roughglass.glsl) instead of GlassMaterial, and pathtracer.glsl's BSDF_Init asks through
// the LUX_FACET_IS_FROSTED integration point below. The deterministic renderer (gem.frag) does
// not read it and draws every facet polished; that is the user's scope for T-0183.
//
// The microfacet roughness itself is not a uniform: it is one constant,
// FROSTED_FACET_ROUGHNESS, in lux/entry.glsl.
// -----------------------------------------------------------------------------
uniform highp sampler2D uFrostedTexture;

// texelFetch, as gem.frag reads uHighlightTexture: the texture is exactly one texel per facet,
// so the id IS the texel, with no filtering. `facet` arrives as the float gem.frag's Hit
// carries it in, hence the rounding.
bool luxFacetIsFrosted(float facet) {
    return texelFetch(uFrostedTexture, ivec2(int(facet + 0.5), 0), 0).r > 0.5;
}

#define LUX_FACET_IS_FROSTED(facet) luxFacetIsFrosted(facet)

#endif // LUX_HOST_GLSL
