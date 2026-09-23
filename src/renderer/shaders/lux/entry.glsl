// -----------------------------------------------------------------------------
// Entry point for the assembled shader: camera wiring, the sample loop, and the runtime
// toggle between the deterministic renderer and the ported LuxCore one.          T-0120
//
// Ported from LuxCoreRender (https://github.com/LuxCoreRender/LuxCore),
// reference/LuxCore commit e9ced7e ("Fix log format regression", 2026-09-11):
//
//   src/slg/engines/pathtracer.cpp   PathTracer::GenerateEyeRay (351-381),
//                                     PathTracer::RenderEyeSample (677-690)
//
//   Copyright 1998-2020 LuxCoreRender authors (see reference/LuxCore/AUTHORS.txt)
//   Copyright 2026 Lucas Tong
//
//   Licensed under the Apache License, Version 2.0 (the "License");
//   you may not use this file except in compliance with the License.
//   You may obtain a copy of the License at
//
//       http://www.apache.org/licenses/LICENSE-2.0
//
//   Unless required by applicable law or agreed to in writing, software
//   distributed under the License is distributed on an "AS IS" BASIS,
//   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//   See the License for the specific language governing permissions and
//   limitations under the License.
//
// -----------------------------------------------------------------------------
// WHAT IS PORTED HERE, AND WHAT IS THIS PROJECT'S OWN.
//
// pathtracer.glsl deliberately stopped at RenderEyePath and left the camera/film wiring
// (GenerateEyeRay) to this ticket, because this project already has a camera -- gem.frag's
// own primary-ray setup, measured against Gem Cut Studio (kb/camera-projection-and-pose.md)
// and reproduced exactly by tools/luxcore_oracle.py in the oracle's .scn files. So:
//
//   * the RNG dimension order of GenerateEyeRay is ported (screen X, screen Y, then the
//     time and depth-of-field draws, in upstream's own order);
//   * the projection itself is gem.frag's, not luxrays::PerspectiveCamera's, because that
//     is the camera the oracle scene was written to match;
//   * RenderEyeSample's shape -- a fresh EyePathInfo and Spectrum(1.f) throughput per
//     sample -- is what PathTracer_RenderEyePath already does internally.
//
// DEPARTURES, stated rather than hidden:
//
//   * PIXEL FILTER. GenerateEyeRay samples a reconstruction filter
//     (`pixelFilterDistribution->SampleContinuous`); the oracle's film uses LuxCore's
//     default BLACKMANHARRIS. This uses the sampler's sub-pixel value directly, which is
//     exactly a BOX filter of one pixel. Porting the filter distribution is a film/AOV
//     concern (T-0111's territory) and would change only how the *same* radiance estimates
//     are spread between neighbouring pixels. It shows up as a slightly crisper silhouette
//     edge here than in the oracle -- kb/luxcore-as-a-reference-oracle.md already measured
//     BLACKMANHARRIS spreading the hex cut's girdle over about 3px.
//   * PROGRESSIVE ACCUMULATION, as upstream (since T-0122). Upstream renders one sample per
//     RenderEyeSample call and the Film accumulates over passes; this now does the same,
//     into an RGBA32F ping-pong pair (gpu::AccumulationTargets) driven by a pass counter in
//     GemApp. uLuxSamples survives as samples per *pass*, defaulting to 1, and the seed is
//     a hash of the pixel coordinate and the pass index -- the pass index, not a frame
//     counter, so "reset then render N times" is still byte-reproducible and the browser
//     harness can still demand two identical captures. See main() below and host.glsl's
//     uLuxPass. Between T-0120 and T-0122 there was no accumulation buffer and the whole
//     sample loop had to fit inside one draw.
//   * BEER-LAMBERT ABSORPTION, as a LuxCore `homogeneous` interior volume (T-0123). Between
//     T-0120 and T-0123 the port applied none at all -- PathVolumeInfo was cut (T-0113) and
//     the oracle's gem sets no interior volume -- so 28 of the 29 material presets rendered
//     colourless. src/shaders/lux/volume.glsl now ports the single-volume subset of
//     HomogeneousVolume and pathtracer.glsl attenuates each interior segment with it. Read
//     that file's header before changing anything about it: the absorption is an RGB filter
//     and this path samples one wavelength per transmission event, and how those two compose
//     is LuxCore's answer, not this project's. Still NOT ported: the nested-media stack
//     (T-0113) and the volume-scatter path vertex (T-0131).
//   * NO GEM CUT STUDIO BEHAVIOURS. The observer dot, the head-shadow cone, the separate
//     window colour, the flat background and the out-of-bounces shade are all this
//     project's own GCS-matching rules (README's decisions 21-27). None exists in LuxCore,
//     so none is applied on this path; with the LuxCore renderer selected the page's
//     corresponding controls do nothing.
// -----------------------------------------------------------------------------

#ifndef LUX_ENTRY_GLSL
#define LUX_ENTRY_GLSL

// Per-pixel RNG seed.
//
// sampler.glsl's own file header (design decision 2) says this derivation belongs to
// whichever ticket wires that file in, because upstream's per-thread incrementing counter
// is meaningless per pixel. Requirements: every pixel needs an independent stream, and the
// result must be a pure function of (pixel, uLuxSeed) so render() stays reproducible.
//
// The mix is one round of a Wang-style integer hash. It does not have to be a good hash --
// Rnd_Init already runs three LCG steps over whatever it is given -- it only has to avoid
// handing neighbouring pixels seeds that differ in one low bit, which a bare
// `x + y * width` does and which shows up as visible structure in the first few samples.
uint luxPixelSeed(uvec2 pixel, uint extra) {
    uint seed = pixel.x * 73856093u ^ pixel.y * 19349663u ^ extra * 83492791u;

    seed ^= seed >> 16;
    seed *= 2246822519u;
    seed ^= seed >> 13;
    seed *= 3266489917u;
    seed ^= seed >> 16;

    // Rnd_Init's ValidSeed rejects nothing, but a zero seed makes LCG(0) = 0 and leaves
    // all three Tausworthe states at their ValidSeed floors, which is a degenerate stream.
    return seed == 0u ? 1u : seed;
}

// THE MICROFACET ROUGHNESS OF A FROSTED FACET -- the one place it is set.            T-0183
//
// LuxCore's roughglass `uroughness` and `vroughness`, used for both (isotropic). The user chose
// 0.2 on 2026-09-23 ("for now use .2 for the roughness of the microfacets ... later we might
// need to revisit the roughness"), so changing it is meant to be this one line. It is in
// LuxCore's own convention: lux/roughglass.glsl multiplies the two, so the Schlick
// distribution sees u * v = 0.04. No page control sets it, on purpose. The Rust test
// `frosted_facet_roughness_is_the_users_0_2_in_one_place` pins the value, so a change here is
// deliberate and updates that test in the same commit.
const float FROSTED_FACET_ROUGHNESS = 0.2;

// The scene's glass, as the oracle's .scn configures it:
//   scene.materials.gem.type = glass
//   scene.materials.gem.kr = 1 1 1 ; kt = 1 1 1
//   scene.materials.gem.exteriorior = 1.0
//   scene.materials.gem.interiorior = <Cauchy A>  ; cauchyb = <Cauchy B>
// No thin-film coating is ever configured, so filmThickness stays 0 and glass.glsl's
// CalcFilmColor stub is never reached (T-0103).
//
// Frosted facets (T-0183) are the same glass as a LuxCore `roughglass` material, which takes the
// same kr, kt, exteriorior and interiorior plus:
//   scene.materials.frosted.uroughness = FROSTED_FACET_ROUGHNESS
//   scene.materials.frosted.vroughness = FROSTED_FACET_ROUGHNESS
// (and no cauchyb: LuxCore's roughglass does not disperse; see lux/roughglass.glsl).
GlassParams luxGlassParams() {
    GlassParams glass;

    glass.kr = WHITE;
    glass.kt = WHITE;
    glass.nc = 1.0;
    glass.nt = uLuxCauchyA;
    glass.cauchyB = uLuxCauchyB;
    glass.filmThickness = 0.0;
    glass.filmIor = 1.0;
    glass.uRoughness = FROSTED_FACET_ROUGHNESS;
    glass.vRoughness = FROSTED_FACET_ROUGHNESS;

    return glass;
}

// gem.frag's primary ray, for a film position in normalised device coordinates. Identical
// arithmetic to renderHandWritten()'s own opening lines, including the advance to
// PRIMARY_RAY_START_RADIUS -- see that function for why tracing starts at the stone's
// bounding sphere rather than at the eye 52 units away (decision 30, T-0032).
void luxEyeRay(vec2 ndc, out vec3 rayOrigin, out vec3 rayDirection) {
    vec3 origin = uCameraOrigin;
    vec3 direction;

    if (uOrthographicHalfHeight > 0.0) {
        origin += uCameraRight * (ndc.x * uAspect * uOrthographicHalfHeight)
                + uCameraUp * (ndc.y * uOrthographicHalfHeight);
        direction = uCameraForward;
    } else {
        direction = normalize(
            uCameraForward
            + uCameraRight * (ndc.x * uAspect * uTanHalfFov)
            + uCameraUp * (ndc.y * uTanHalfFov)
        );
    }

    origin += direction * max(dot(-origin, direction) - PRIMARY_RAY_START_RADIUS, 0.0);

    rayOrigin = origin;
    rayDirection = direction;
}

// PathTracer::RenderEyeSample (pathtracer.cpp:677-690), run uLuxSamples times per pass and
// averaged. One pass is one draw; main() then adds it to the running sum across passes.
// Upstream's `ResetEyeSampleResults` / `sampleResults` vector is T-0111's cut; a single vec3
// of radiance stands in for `sampleResults[0].radiance[0]`.
vec3 luxRenderPixel() {
    vec2 pixel = floor(gl_FragCoord.xy);

    RandomSamplerState sampler;
    Sampler_Init(luxPixelSeed(uvec2(pixel), uint(uLuxSeed)), pixel.x, pixel.y, sampler);

    GlassParams glass = luxGlassParams();

    // `path.pathdepth.total/diffuse/glossy/specular`, all set to --max-depth by
    // tools/luxcore_oracle.py's build_config. uMaxBounces is this project's control for the
    // same quantity, and tools/compare_luxcore.py already sets the two from one number.
    uint maxDepth = uint(max(uMaxBounces, 1));
    PathDepthInfo maxPathDepth = PathDepthInfo(maxDepth, maxDepth, maxDepth, maxDepth);

    // `path.russianroulette.depth`, likewise --max-depth. Inert for a delta-specular
    // material; see pathtracer.glsl's file header.
    uint rrDepth = maxDepth;

    int samples = max(uLuxSamples, 1);
    vec3 total = BLACK;

    for (int sampleIndex = 0; sampleIndex < samples; ++sampleIndex) {
        // RandomSampler_NextSample re-jitters the screen sample and carries the same RNG
        // stream forward, which is exactly what upstream does between samples; Sampler_Init
        // has already produced the first one.
        if (sampleIndex > 0) {
            Sampler_NextSample(sampler, pixel.x, pixel.y);
        }

        // GenerateEyeRay, pathtracer.cpp:353-354 and 371-372: filmX/filmY are dimensions 0
        // and 1, and `filmX - pixelX` is the sub-pixel offset the reconstruction filter is
        // sampled with. With a box filter that offset IS the film position -- see the
        // DEPARTURES note in this file's header.
        float filmX = Sampler_GetSample(sampler, uint(IDX_SCREEN_X));
        float filmY = Sampler_GetSample(sampler, uint(IDX_SCREEN_Y));

        // pathtracer.cpp:375-380 draws dimension 4 for the shutter time and dimensions 2
        // and 3 for the lens sample. This camera has neither motion blur nor a real
        // aperture, so the values are discarded -- but they are still drawn, in upstream's
        // own order, so each vertex's BSDF draws land on the same dimensions of the stream
        // as they do in LuxCore. Same reasoning as the five discarded direct-light draws
        // pathtracer.glsl already keeps (T-0115).
        Sampler_GetSample(sampler, uint(IDX_EYE_TIME));
        Sampler_GetSample(sampler, uint(IDX_DOF_X));
        Sampler_GetSample(sampler, uint(IDX_DOF_Y));

        vec2 ndc = (vec2(filmX, filmY) / uResolution) * 2.0 - 1.0;

        vec3 rayOrigin;
        vec3 rayDirection;
        luxEyeRay(ndc, rayOrigin, rayDirection);

        // One eye path starts here, and it has met nothing yet. host.glsl's
        // gLuxPathHitStone is per-path state (Scene_Intersect sets it, lights.glsl's
        // Env_ProjectRadiance reads it), so it is reset here rather than at the top of the
        // pass: samples share a fragment, and a stone hit in sample 3 must not make
        // sample 4's camera miss look like light leaving the stone.               T-0137
        gLuxPathHitStone = false;

        total += PathTracer_RenderEyePath(rayOrigin, rayDirection, glass,
                maxPathDepth, rrDepth, uLuxRrImportanceCap, sampler);
    }

    return total / float(samples);
}

// The running sum of radiance at this fragment, from the accumulation buffer.
//
// texelFetch rather than texture(): the buffer is exactly the size of the draw, so the
// fragment's own integer coordinate is the texel, with no filtering and no dependence on
// the wrap mode.                                                                  T-0122
vec3 luxAccumulated() {
    return texelFetch(uLuxAccum, ivec2(gl_FragCoord.xy), 0).rgb;
}

void main() {
    // The debug views (facet normals, facet ids, traversal cost, bounce count) are this
    // project's geometry-inspection tools, not a rendering mode, and they read a single
    // deterministic primary hit. They stay on the deterministic path whichever renderer is
    // selected, so "is the geometry right?" is answerable either way.
    if (uRenderer == RENDERER_FLAT && uDebugMode == DEBUG_FULL) {
        renderFlat();
        return;
    }

    if (uRenderer != RENDERER_LUXCORE || uDebugMode != DEBUG_FULL) {
        renderHandWritten();
        return;
    }

    // ---- the resolve pass (T-0122): no tracing, just present what has been accumulated.
    //
    // Same display transfer as the deterministic path, deliberately: tools/compare_luxcore.py
    // decodes our PNG through `display / exposure`, the exact inverse of ToneMapMode::Linear,
    // and decodes LuxCore's through its own. Giving this path a different transfer would
    // silently invalidate that decode. See T-0120's brief. The division by the pass count is
    // what makes accumulation a mean of per-pass estimates rather than a brightening image;
    // it is the same average luxRenderPixel() takes over its own samples, just carried
    // across draws.
    if (uLuxPass == LUX_PASS_RESOLVE) {
        fragColor = vec4(tonemap(luxAccumulated() / float(max(uLuxPassCount, 1))), 1.0);
        return;
    }

    vec3 radiance = luxRenderPixel();

    // ---- the accumulate pass: LINEAR radiance into a float target, never tone mapped.
    //
    // Tone mapping is not a linear operator, so mapping each pass and averaging the
    // results would converge on something that is not the tone-mapped mean -- visibly
    // wrong under the filmic curve, where a bright flash sampled in one pass out of ten
    // would land at tonemap(x)/10 instead of tonemap(x/10).
    if (uLuxPass == LUX_PASS_ACCUMULATE) {
        fragColor = vec4(luxAccumulated() + radiance, 1.0);
        return;
    }

    // ---- LUX_PASS_DIRECT: what this path did before T-0122, kept for the fallback when
    // the browser cannot render to a float texture, where uLuxSamples is again the only
    // way to take more than one sample.
    fragColor = vec4(tonemap(radiance), 1.0);
}

#endif // LUX_ENTRY_GLSL
