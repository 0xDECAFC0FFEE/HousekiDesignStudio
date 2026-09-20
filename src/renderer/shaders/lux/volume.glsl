// -----------------------------------------------------------------------------
// HomogeneousVolume, ported to GLSL ES 3.00 -- the single-volume subset.          T-0123
//
// Ported from LuxCoreRender (https://github.com/LuxCoreRender/LuxCore),
// reference/LuxCore commit e9ced7e ("Fix log format regression", 2026-09-11):
//
//   include/luxrays/core/color/color_funcs.cl     Spectrum_Exp (53-55)
//   include/slg/volumes/volume_funcs.cl           HomogeneousVolume_SegmentScatter (46-98),
//                                                  HomogeneousVolume_SigmaA (166-172),
//                                                  HomogeneousVolume_SigmaS (174-180),
//                                                  HomogeneousVolume_Scatter (182-216)
//
// Cross-read as a second opinion on the .cl, per this project's convention, but not itself
// the basis of any body below (the bodies are identical apart from the prologue):
//   src/slg/volumes/homogenous.cpp                HomogeneousVolume::Scatter (47-99, 109-139),
//                                                  SigmaA/SigmaS (101-107)
//   include/slg/volumes/volume.h                  Volume::SigmaT (78-80),
//                                                  Volume::Emission (81-83)
//   src/slg/scene/parsevolumes.cpp                CreateVolume (121-180), for the SDL
//                                                  property names and LuxCore's own defaults
//
// REQUIRED CONCATENATION ORDER: after src/shaders/lux/prelude.glsl (INFINITY) and
// src/shaders/lux/glass.glsl (WHITE, BLACK, MAKE_FLOAT3, Spectrum_IsBlack, Spectrum_Filter),
// and before src/shaders/lux/pathtracer.glsl, which calls HomogeneousVolume_Scatter. That is
// what src/lib.rs's FRAGMENT_SHADER does; to check this file outside the browser, run
//   tools/glsl_check.sh src/shaders/lux/{math,glass,volume}.glsl
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
// WHY THIS FILE EXISTS.
//
// `src/shaders/lux/pathtracer.glsl` cut PathVolumeInfo (T-0113) and with it every trace of
// LuxCore's participating-media machinery, so the ported path applied no Beer-Lambert
// absorption at all: 28 of the 29 material presets in `src/params.rs` rendered colourless.
// The deterministic renderer has always applied `exp(-uAbsorption * t)` over each interior
// segment (gem.frag's `traceInterior`), and LuxCore's own way of expressing exactly that is
// a `homogeneous` volume bound to the glass material as its interior volume (the SDL
// property is `scene.materials.<m>.volume.interior`, parsematerials.cpp:778-779):
//
//   scene.volumes.geminterior.type = homogeneous
//   scene.volumes.geminterior.absorption = <sigmaA>
//   scene.volumes.geminterior.scattering = 0.0 0.0 0.0
//   scene.materials.gem.volume.interior = geminterior
//
// This file is that volume. `tools/luxcore_oracle.py --absorption "R G B"` writes exactly
// those four lines into the oracle scene, so the two can be compared directly.
//
// -----------------------------------------------------------------------------
// WHAT IS PORTED, AND WHAT IS NOT.
//
// PORTED (the single-volume subset): everything needed to attenuate a ray travelling inside
// one closed solid filled with one homogeneous volume -- SigmaA, SigmaS, SegmentScatter and
// Scatter, with their expression order, local names, comments and upstream bugs intact.
//
// NOT PORTED, and deliberately left open:
//
//   * PathVolumeInfo -- the stack of nested/overlapping media, its priority system,
//     ContinueToTrace and SetHitPointVolumes (src/slg/utils/pathvolumeinfo.cpp,
//     include/slg/utils/pathvolumeinfo.h). Still T-0113, still cut, and the reasoning it
//     recorded still holds: one watertight solid, no participating media, no
//     stone-inside-a-liquid, so the "which medium is this ray in?" question has a one-bit
//     answer -- pathtracer.glsl's existing `side` local. Nothing here needs a stack.
//   * ClearVolume and HeterogeneousVolume (volume_funcs.cl:104-160, 222-313) and the
//     `Volume_Scatter` type dispatch (volume_funcs.cl:319-344). A dispatcher over a table of
//     one, exactly as T-0096 judged the material eval-stack: the one call site calls
//     HomogeneousVolume_Scatter by name.
//   * The volume-scatter path vertex. `HomogeneousVolume_SegmentScatter` can return a
//     scatter distance, and upstream's Scene::Intersect (scene.cpp:768-791) then builds a
//     BSDF at that point from the volume's SchlickScatter phase function (volume.cpp:68-173)
//     and continues the path from it. That is a second material in the integrator and a whole
//     phase-function BSDF, and it is unreachable here: this project's one volume has
//     `scattering = 0 0 0` (LUX_VOLUME_SIGMA_S below), and `SegmentScatter`'s scatter branch
//     is gated on `sigmaSValue > 0.0`, so `scatterDistance` is always -1.0. The branch is
//     ported live anyway -- see pathtracer.glsl's call site, which asserts the impossibility
//     rather than assuming it -- and T-0131 tracks finishing it if scattering is ever
//     plumbed in.
//   * `Volume_Emission` (volume_funcs.cl:21-30) and `Volume::Emission` (volume.h:81-83): a
//     texture lookup with no texture to look up, feeding a light group this project does not
//     have (T-0111's AOV cut). `emission` survives as a plain argument, is hard-wired BLACK
//     by LUX_VOLUME_EMISSION, and the expressions that consume it are ported unchanged.
//   * `Volume_InitializeTmpHitPoint` (volume_funcs.cl:32-44): builds the HitPoint that the
//     sigmaA/sigmaS/emission *texture* lookups are evaluated at. With constant coefficients
//     there is nothing to evaluate them at. Same cut, same reason, as T-0101's.
//   * `Volume::GetIOR` / `ExtractInteriorIors` (material.cpp:380-388): a volume can supply
//     the glass's interior index when the material does not set `interiorior`. Ours always
//     does (entry.glsl's `luxGlassParams`, and the oracle's `.scn`), so upstream takes the
//     `if (interiorIor)` arm and never asks the volume. Checked, not assumed.
//
// -----------------------------------------------------------------------------
// HOW ABSORPTION COMPOSES WITH THIS RENDERER'S SINGLE-WAVELENGTH DISPERSION. Read this
// before changing anything here; it is the one subtle thing about this port.
//
// `GlassMaterial_EvalSpecularTransmission` (glass.glsl) samples ONE random wavelength per
// transmission event and folds its saturated RGB tint into the throughput
// (`lkt = kt * GlassMaterial_WaveLength2RGB(waveLength)`). It is natural to expect a volume
// to then evaluate its absorption AT that wavelength. **LuxCore does not, and cannot.**
//
//   * `sigmaA` is a `Spectrum` -- three RGB numbers -- everywhere: in the SDL property, in
//     `HomogeneousVolume::sigmaA`, and in `Spectrum_Exp(-tau)`, which is three independent
//     `exp()`s (color_funcs.cl:53-55). There is no spectral representation to sample from.
//   * No wavelength is carried anywhere a volume could read it. `HitPoint`
//     (include/slg/bsdf/hitpoint.h, hitpoint_types.cl) has no wavelength field -- checked by
//     grep over the whole of include/slg/bsdf and src/slg/bsdf -- and neither
//     `Volume::Scatter` nor `HomogeneousVolume_Scatter` takes one. The sampled wavelength is
//     a local variable inside `GlassMaterial_EvalSpecularTransmission` and dies there; only
//     its RGB tint escapes, multiplied into the throughput.
//
// So LuxCore's answer is: **apply the RGB absorption filter component-wise to the RGB path
// throughput, independently of the sampled wavelength.** That is what this file does, and it
// is not an invention of this port -- upstream already composes an RGB filter with the
// wavelength sample in exactly this way one line earlier, in `lkt = kt * WaveLength2RGB(...)`:
// `kt`, the glass's own transmission colour, is an RGB filter multiplied onto a
// single-wavelength tint. The volume's filter is the same operation at a different place.
//
// What that means, stated plainly rather than hidden:
//
//   * With dispersion off (cauchyB == 0, which is every comparison run and every render of a
//     material whose `dispersion` is 0), `WaveLength2RGB` is never called, the throughput is
//     three independent channels, and `exp(-sigmaA * t)` per channel is EXACTLY the
//     three-channel Beer-Lambert `gem.frag`'s `traceInterior` applies. The two renderers must
//     agree on body colour here, and they do -- see T-0123's close note for the measurement.
//   * With dispersion on, LuxCore's model is an approximation: a path that sampled 450 nm
//     still gets absorbed by all three of sigmaA's components rather than by sigma_a(450 nm).
//     A true spectral renderer would evaluate one absorption coefficient at the sampled
//     wavelength. LuxCore does not, this port does not, and inventing one here would be a
//     change to the model, not a port of it. If that is ever wanted it is a new decision, not
//     a bug fix: T-0132.
// -----------------------------------------------------------------------------

#ifndef LUX_VOLUME_GLSL
#define LUX_VOLUME_GLSL

// -----------------------------------------------------------------------------
// HOST INTEGRATION POINTS. Same pattern (and same reasoning) as the ones
// src/shaders/lux/lights.glsl leaves open for src/shaders/lux/host.glsl to fill in: this is
// ported code and must not name a `uniform` of this project's own, so the scene's actual
// coefficients arrive through `#ifndef`-guarded macros that host.glsl defines ahead of this
// file. `volume_glsl_integration_points_are_supplied_by_host_glsl` in src/lib.rs fails if
// host.glsl ever stops defining them.
//
// The standalone values below are the pre-T-0123 behaviour -- no volume at all -- so a file
// checked on its own (tools/glsl_check.sh) compiles and is inert, rather than carrying an
// invented absorption that would look plausible.
// -----------------------------------------------------------------------------

#ifndef LUX_VOLUME_SIGMA_A
// `scene.volumes.<v>.absorption`.
#define LUX_VOLUME_SIGMA_A BLACK
#endif

#ifndef LUX_VOLUME_SIGMA_S
// `scene.volumes.<v>.scattering`. See "NOT PORTED" above: while this is BLACK the scatter
// branch of HomogeneousVolume_SegmentScatter cannot fire, which is what makes the
// single-volume subset sufficient.
#define LUX_VOLUME_SIGMA_S BLACK
#endif

#ifndef LUX_VOLUME_EMISSION
// `scene.volumes.<v>.emission`, via Volume_Emission (volume_funcs.cl:21-30, not ported).
#define LUX_VOLUME_EMISSION BLACK
#endif

#ifndef LUX_VOLUME_MULTISCATTERING
// `scene.volumes.<v>.multiscattering` (volume_funcs.cl:197). LuxCore's own default is false
// (parsevolumes.cpp:157).
#define LUX_VOLUME_MULTISCATTERING false
#endif

// -----------------------------------------------------------------------------
// Spectrum_Exp -- luxrays/core/color/color_funcs.cl:53-55.
//
// glass.glsl's LUX_SPECTRUM_HELPERS_GLSL block ported only the four helpers a delta glass
// BSDF calls and said so ("Spectrum_IsNan/IsInf/Y/Exp/Pow are not needed by a delta glass
// BSDF"). Beer-Lambert needs Exp. Defined here under its own guard rather than added to
// glass.glsl's block, per this project's "a define needed by one ported file belongs in that
// file, wrapped in #ifndef" rule (prelude.glsl's header).
// -----------------------------------------------------------------------------
#ifndef LUX_SPECTRUM_EXP_GLSL
#define LUX_SPECTRUM_EXP_GLSL
vec3 Spectrum_Exp(const vec3 s) {
    return MAKE_FLOAT3(exp(s.x), exp(s.y), exp(s.z));
}
#endif // LUX_SPECTRUM_EXP_GLSL

// -----------------------------------------------------------------------------
// HomogeneousVolume_SigmaA / _SigmaS -- volume_funcs.cl:166-172 and 174-180.
//
// Restructured exactly as glass.glsl restructured its own parameter access under T-0096: the
// `Texture_GetSpectrumValue(vol->volume.homogenous.sigmaATexIndex, hitPoint TEXTURES_PARAM)`
// lookup becomes a plain vec3 argument, because there is no texture and no eval stack. The
// `clamp(..., 0.f, INFINITY)` upstream applies to the looked-up value is kept: it is part of
// the function, not part of the lookup, and it is what guarantees `tau >= 0` below whatever
// the host sends. (`params::RenderParams::clamp_to_valid_ranges` already floors absorption at
// 0 host-side; this is upstream's own belt-and-braces, ported, not relied upon.)
// -----------------------------------------------------------------------------
vec3 HomogeneousVolume_SigmaA(const vec3 sigmaATex) {
    vec3 sigmaA = sigmaATex;

    return clamp(sigmaA, 0.0, INFINITY);
}

vec3 HomogeneousVolume_SigmaS(const vec3 sigmaSTex) {
    vec3 sigmaS = sigmaSTex;

    return clamp(sigmaS, 0.0, INFINITY);
}

// -----------------------------------------------------------------------------
// HomogeneousVolume_SegmentScatter -- volume_funcs.cl:46-98. Identical in body to the static
// HomogeneousVolume::Scatter overload in homogenous.cpp:47-99 (cross-read).
//
// Restructurings, all forced by the language rather than chosen:
//   * `const float3 *sigmaA` etc. (read-only pointers, an OpenCL calling convention) become
//     plain `const vec3` parameters; `float3 *segmentTransmittance` / `*segmentEmission`
//     (genuine out-params) become GLSL `out` parameters. Reading an `out` parameter after
//     writing it is well defined in GLSL, so upstream's "assign, then `*=`" shape survives
//     unchanged.
//   * `const float3 tau = ...` and friends drop the local `const`: GLSL ES 3.00 requires a
//     constant *initializer* on a const-qualified local and rejects these outright. See
//     kb/porting-opencl-c-to-glsl-es-3-00-what-actually-d.md, gap 2.
//   * Float literals are written bare (`1.0`, not `1.f`), per prelude.glsl's standing rule.
//
// The `isinf(scatterDistance)` arm is ported live and cannot fire here: `segmentLength` is
// `hitT - rayMint` with a finite `hitT` (pathtracer.glsl's LUX_MAX_DISTANCE is 1e9, and
// prelude.glsl's INFINITY is a finite 3.4e38 because GLSL ES 3.00 has no infinity literal).
// A ray that somehow ran the full 1e9 would get `exp(-huge) == 0` from the normal arm, which
// is the same BLACK the isinf arm sets -- so the two agree even at the limit.
// -----------------------------------------------------------------------------
float HomogeneousVolume_SegmentScatter(const float u,
        const bool scatterAllowed, const float segmentLength,
        const vec3 sigmaA, const vec3 sigmaS, const vec3 emission,
        out vec3 segmentTransmittance, out vec3 segmentEmission) {
    // This code must work also with segmentLength = INFINITY

    bool scatter = false;
    segmentTransmittance = WHITE;
    segmentEmission = BLACK;

    //--------------------------------------------------------------------------
    // Check if there is a scattering event
    //--------------------------------------------------------------------------

    float scatterDistance = segmentLength;
    float sigmaSValue = Spectrum_Filter(sigmaS);
    if (scatterAllowed && (sigmaSValue > 0.0)) {
        // Determine scattering distance
        float proposedScatterDistance = -log(1.0 - u) / sigmaSValue;

        scatter = (proposedScatterDistance < segmentLength);
        scatterDistance = scatter ? proposedScatterDistance : segmentLength;

        // Note: scatterDistance can not be infinity because otherwise there would
        // have been a scatter event before.
        float tau = scatterDistance * sigmaSValue;
        float pdf = exp(-tau) * (scatter ? sigmaSValue : 1.0);
        segmentTransmittance *= 1.0 / pdf;
    }

    //--------------------------------------------------------------------------
    // Volume transmittance
    //--------------------------------------------------------------------------

    vec3 sigmaT = sigmaA + sigmaS;
    if (!Spectrum_IsBlack(sigmaT)) {
        if (isinf(scatterDistance)) {
            // This avoid NaN in case scatterDistance is inf
            segmentTransmittance = BLACK;
        } else {
            vec3 tau = scatterDistance * sigmaT;
            segmentTransmittance *= Spectrum_Exp(-tau) * (scatter ? sigmaT : WHITE);
        }
    }

    //--------------------------------------------------------------------------
    // Volume emission
    //--------------------------------------------------------------------------

    segmentEmission += segmentTransmittance * scatterDistance * emission;

    return scatter ? scatterDistance : -1.0;
}

// -----------------------------------------------------------------------------
// HomogeneousVolume_Scatter -- volume_funcs.cl:182-216. Identical in body to the virtual
// HomogeneousVolume::Scatter in homogenous.cpp:109-139 (cross-read).
//
// Restructurings:
//   * `__global Ray *ray` becomes the two scalars this body actually reads from it,
//     `rayMint` and (with `hitT`) nothing else. `rayOrig`/`rayDir` are loaded upstream solely
//     to build the temporary HitPoint the texture lookups need -- see the
//     Volume_InitializeTmpHitPoint cut in the file header -- so they are gone with it.
//   * `__global const Volume *vol` becomes the plain sigmaA/sigmaS/emission/multiScattering
//     arguments its five field reads resolved to, the same stripping T-0096 authorised for
//     the materials.
//   * `float3 *connectionThroughput` / `*connectionEmission` become `inout`: unlike
//     SegmentScatter's two out-params, these genuinely accumulate across calls -- upstream's
//     Scene::Intersect initialises connectionThroughput to WHITE once (scene.cpp:691) and
//     every volume segment along the ray multiplies into it.
//
// UPSTREAM BUG, PORTED FAITHFULLY (T-0133): `segmentEmission` is computed by the call below
// and then never read; the line after it adds `*connectionThroughput * emission` -- the raw
// per-unit-length emission, with neither the segment length nor the segment transmittance
// that SegmentScatter carefully folded into `segmentEmission`. Both the .cl (volume_funcs.cl:
// 206-213) and the .cpp (homogenous.cpp:129-136) do this, identically. It is invisible in
// this project (LUX_VOLUME_EMISSION is BLACK, so both the right answer and the wrong one are
// BLACK) and it is not this port's place to fix it.
// -----------------------------------------------------------------------------
float HomogeneousVolume_Scatter(const float rayMint, const float hitT,
        const float passThroughEvent,
        const bool scatteredStart, const bool multiScattering,
        const vec3 sigmaATex, const vec3 sigmaSTex, const vec3 emission,
        inout vec3 connectionThroughput, inout vec3 connectionEmission) {
    // Initialize tmpHitPoint -- not ported, see the file header.

    float segmentLength = hitT - rayMint;

    // Check if I have to support multi-scattering
    bool scatterAllowed = (!scatteredStart || multiScattering);

    vec3 sigmaA = HomogeneousVolume_SigmaA(sigmaATex);
    vec3 sigmaS = HomogeneousVolume_SigmaS(sigmaSTex);

    vec3 segmentTransmittance, segmentEmission;
    float scatterDistance = HomogeneousVolume_SegmentScatter(passThroughEvent, scatterAllowed,
            segmentLength, sigmaA, sigmaS, emission,
            segmentTransmittance, segmentEmission);

    // I need to update first connectionEmission and than connectionThroughput
    connectionEmission += connectionThroughput * emission;
    connectionThroughput *= segmentTransmittance;

    return (scatterDistance == -1.0) ? -1.0 : (rayMint + scatterDistance);
}

#endif // LUX_VOLUME_GLSL
