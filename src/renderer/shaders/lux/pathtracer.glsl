// -----------------------------------------------------------------------------
// LuxCore path integrator (PathTracer::RenderEyePath), ported to GLSL ES 3.00.  T-0109
//
// Ported from LuxCoreRender (https://github.com/LuxCoreRender/LuxCore),
// reference/LuxCore commit e9ced7e ("Fix log format regression", 2026-09-11):
//
//   src/slg/engines/pathtracer.cpp                      RenderEyePath (387-671),
//                                                        DirectHitInfiniteLight (320-349),
//                                                        CheckDirectHitVisibilityFlags (262-275),
//                                                        DirectLightSampling (137-260, stubbed)
//   include/slg/engines/pathtracer.h                    PathTracer::DirectLightResult enum
//   include/slg/engines/renderengine.h                  RenderEngine::RussianRouletteProb (159-161)
//   include/slg/utils/pathdepthinfo.h,
//   src/slg/utils/pathdepthinfo.cpp                     PathDepthInfo (34-45, 30-56)
//   include/slg/utils/pathinfo.h,
//   src/slg/utils/pathinfo.cpp                          PathInfo::UseRR (34-36),
//                                                        EyePathInfo::AddVertex (58-106, reduced)
//   src/slg/bsdf/bsdf.cpp                                BSDF::Init (29-72), BSDF::Sample (363-397)
//   include/slg/bsdf/bsdf.h                              BSDF::GetRayOrigin (166-174)
//   src/slg/bsdf/hitpoint.cpp                            HitPoint::Init (33-73)
//   include/slg/bsdf/bsdfevents.h                        DIFFUSE/GLOSSY values (24-33; SPECULAR/
//                                                        REFLECT/TRANSMIT/NONE already ported by
//                                                        src/shaders/lux/glass.glsl)
//   include/luxrays/core/epsilon.h,
//   src/luxrays/core/epsilon.cpp                          MachineEpsilon (40-103, 23-24)
//   src/slg/film/sampleresult.cpp                        core of SampleResult::AddEmission (59-65)
//   src/slg/scene/scene.cpp                              the volume segment of
//                                                        Scene::Intersect (691, 733-792; T-0123,
//                                                        single-volume subset only)
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
// SCOPE. T-0109 said: take the integrator from the .cpp, not the .cl -- LuxCore's OpenCL
// integrator is a ten-kernel wavefront state machine over persistent global buffers
// (AdvancePaths_MK_RT_NEXT_VERTEX, MK_HIT_OBJECT, MK_DL_ILLUMINATE, ... in
// pathoclbase_kernels_micro.cl); RenderEyePath is a single for(;;) loop over path vertices,
// the shape a fragment shader wants. Everything below is ported from pathtracer.cpp and the
// small set of BSDF/PathInfo/PathDepthInfo helpers it calls that are genuinely part of the
// integrator (throughput update, Russian roulette, depth-limit handling).
//
// This project has exactly one hard-coded material (GlassMaterial, ported by glass.glsl) and
// exactly one light (a single environment, procedural or image-based, in gem.frag). LuxCore's
// RenderEyePath is written for an arbitrary scene graph: many materials (diffuse, glossy,
// mixed, volumes, shadow catchers, baked lightmaps), many lights (area, sun, sky, portals),
// AOV/Film accumulation across dozens of channels, a photon-GI cache, and an optional
// hybrid-backward/forward mode that interleaves light tracing. None of that exists here. Every
// one of those branches is either:
//   (a) a genuine LuxCore generality this single-gemstone renderer has no use for -- cut,
//       recorded in a ticket, not implemented (see "CUTS" below), or
//   (b) a C++ shape (a polymorphic Material/Light, a mutable PathVolumeInfo stack, an
//       eval-stack-free but still generic BSDF class) that had to be restructured to compile
//       as GLSL against one hard-coded material -- restructured and documented at the site
//       (see "RESTRUCTURINGS" below), continuing the precedent glass.glsl set under T-0096.
//
// TWO STUB INTERFACES, BOTH PRIMARY DELIVERABLES OF THIS TICKET.
//
// 1. Scene_Intersect / LuxHit -- intersection. This project already has working BVH traversal
//    in src/shaders/gem.frag (traceScene, fed by src/accel.rs); porting embree or luxrays'
//    acceleration structures is explicitly out of scope (T-0109's hard boundary #1). LuxHit's
//    fields were chosen by reading gem.frag's own `Hit` struct and `traceScene` signature:
//    hit distance, hit point, the facet's outward geometric normal, and a facet id, against a
//    (origin, direction, tMin, tMax, side) query -- exactly what gem.frag's BVH walk can
//    supply and no more. Named LuxHit / Scene_Intersect (not gem.frag's own Hit / traceScene)
//    so this file has no name collision when the wiring ticket eventually concatenates it with
//    gem.frag; the real implementation is expected to be a one-line call to traceScene()
//    translating between the two struct shapes. `side` uses this file's own
//    LUX_RAY_FROM_OUTSIDE / LUX_RAY_FROM_INSIDE macros, deliberately not gem.frag's
//    RAY_FROM_OUTSIDE / RAY_FROM_INSIDE consts (same values, `1.0` / `-1.0`) -- again to avoid a
//    duplicate-definition error once concatenated, since gem.frag is not touched by this ticket
//    and cannot be made to share a guard with a file it doesn't `#include`.
//
// 2. Env_GetRadiance / Env_GetLightPickPdf -- the environment/infinite light. Not named as a
//    hard boundary in the ticket, but the same reasoning applies: gem.frag already has a
//    working environment lookup (sampleEnvironment/arrivingLight, covering the analytic
//    lighting models and the equirectangular image map alike), and RenderEyePath's escaped-ray
//    branch needs *some* light source to query without pulling that machinery in. Stubbed the
//    same way, for the same reason, so the wiring ticket has one place to look for both.
//
// SINCE T-0183 THERE ARE TWO MATERIALS, AND THE SECOND ONE IS NOT DELTA. A facet the page has
// marked frosted (GemApp::set_frosted_facets -> uFrostedTexture -> LUX_FACET_IS_FROSTED, see
// lux/host.glsl) is LuxCore's RoughGlassMaterial (lux/roughglass.glsl), a glossy microfacet
// dielectric; every other facet is still GlassMaterial. LuxBSDF carries which one it is
// (`frosted`), set by BSDF_Init from the hit's facet id, and BSDF_GetEventTypes / BSDF_IsDelta /
// BSDF_Sample / BSDF_Evaluate dispatch on it -- the same "material pointer" upstream's BSDF
// holds, reduced to one bit. What that revives, exactly as upstream would:
//   - PathTracer_DirectLightSampling now has its real body (pathtracer.cpp:137-260) and runs
//     at every frosted vertex: the environment is sampled as a light, a shadow ray is traced,
//     and the result is MIS-weighted (power heuristic) against BSDF sampling. See that
//     function for the one restructuring it needed (the environment as a single light).
//   - PathTracer_DirectHitInfiniteLight's MIS-weight branch is live after a GLOSSY event, and
//     reads the lastBSDFPdfW RoughGlassMaterial_Sample produced.
//   - Russian roulette is live in principle (a GLOSSY event clears the SPECULAR bit), but with
//     rrDepth = the maximum depth (lux/entry.glsl) GetRRDepth() >= rrDepth can only hold on a
//     path that has already reached the depth limit, so it still never fires in practice.
// The paragraph below is the pre-T-0183 account and remains exactly true for a stone with no
// frosted facets.
//
// RUSSIAN ROULETTE AND DIRECT LIGHT SAMPLING ARE BOTH DEAD CODE FOR THIS MATERIAL, AND FOR A
// DIFFERENT REASON EACH. Both are ported faithfully (bodies present, called from the same
// places upstream calls them) precisely so that stays true structurally instead of by
// omission, and so a future non-delta material makes them live again for free.
//
//   - PathTracer_DirectLightSampling (pathtracer.cpp:137-260) is gated, in full, on
//     `!bsdf.IsDelta()`. GlassMaterial::IsDelta() is `true` unconditionally (glass.h:43), so
//     this is dead in upstream LuxCore too, not just in this port -- the earlier glass.glsl /
//     kb/luxcore-as-a-reference-oracle.md finding that "GlassMaterial::Pdf returns 0" is the
//     same fact from the other direction. It was stubbed to `return NOT_VISIBLE;` until T-0183
//     gave it a non-delta material to run for and ported its body.
//
//   - Russian roulette (PathInfo::UseRR, pathinfo.cpp:34-36) requires
//     `!(lastBSDFEvent & SPECULAR)`. GlassMaterial_Sample (glass.glsl) always sets
//     `event = SPECULAR | TRANSMIT` or `SPECULAR | REFLECT` -- the SPECULAR bit is never clear
//     -- and EyePathInfo's default `lastBSDFEvent` (PathInfo::PathInfo(), pathinfo.cpp:30) is
//     *also* SPECULAR, so this holds from before the first bounce too. So for this project's
//     one material, at any depth, `PathInfo_UseRR` always returns false: Russian roulette never
//     fires, and path length is governed entirely by PathDepthInfo_IsLastPathVertex (the
//     configured max depth) or by the path escaping/being absorbed to black. Checked by hand:
//     `renders/luxcore/hex_cut_v2-studio.cfg` sets `path.russianroulette.depth = 24` alongside
//     `path.pathdepth.total = 24`, but the RR depth number is moot here -- rrDepth is compared
//     against `PathDepthInfo_GetRRDepth() = diffuseDepth + glossyDepth`, and both stay 0
//     forever for a pure-glass path, so `0 >= rrDepth` is false for every legal rrDepth (>= 1
//     per PathTracer::ParseOptions' `Max(1, ...)`), and the `!(lastBSDFEvent & SPECULAR)`
//     half of the `&&` is separately, always false regardless. This is worth a speed-up ticket
//     (see CUTS/SPEED-UPS) but is ported as a live branch here, not special-cased away, because
//     a future non-delta material (T-0092's own open question could eventually motivate one)
//     would make it fire again.
//
// T-0092 (dispersion model) -- WHAT THIS FILE ASSUMES. This integrator threads stochastic
// single-wavelength dispersion, not the three-fixed-channel model gem.frag's traceInterior()
// uses. Since 2026-09-25 the wavelength is the eye path's own (host.glsl's
// gLuxPathWaveLength, drawn once per sample by entry.glsl), not upstream's fresh draw at every
// transmission, and reflection and transmission share its index: a deliberate departure that
// fixes two upstream-acknowledged bugs (see glass.glsl's header). The wavelength's RGB tint
// (`GlassMaterial_WaveLength2RGB`) is baked into `bsdfSample` once, at the first transmission,
// and this integrator's `pathThroughput *= bsdfSample` (in the same place and order as
// pathtracer.cpp:645) carries it through every later bounce, so nothing in this file changed.
// A single frame is still noisy, as any sampled-spectrum renderer is; frames accumulate.
//
// CUTS -- LuxCore generality this single-faceted-gemstone renderer has no use for, recorded as
// tickets, not implemented. Filed by this ticket:
//   - T-0110: RenderLightSample / ConnectToEye and the whole light-tracing / hybrid
//     backward-forward path (pathtracer.cpp:673-946, 952-970) -- this project only ever
//     traces eye paths.
//   - T-0111: SampleResult/Film AOV accumulation (radiance-channel splitting by DIFFUSE/
//     GLOSSY/SPECULAR x REFLECT/TRANSMIT, albedo, position, geometry/shading normal,
//     material/object id, UV, depth, alpha, holdout, irradiance, ray count, shadow masks,
//     bake maps, shadow-catcher materials) -- this integrator returns one vec3 of radiance,
//     matching only the arithmetic core of SampleResult::AddEmission
//     (`radiance[lightID] += pathThroughput * incomingRadiance`, sampleresult.cpp:61-62).
//   - T-0112: PhotonGI cache and hybrid-backward/forward path tracing (the two `if` guards
//     RenderEyePath consults at almost every step) -- both are permanently off in this
//     project (no cache, no light tracing), so every branch gated on them collapses to its
//     "disabled" arm at the source, not just at runtime.
//   - T-0113: PathVolumeInfo / nested participating media (pathinfo.h's `PathVolumeInfo
//     volume` member, updated by `volume.Update(event, bsdf)` in AddVertex and read by
//     Scene::Intersect for pass-through/volume attenuation) -- see RESTRUCTURINGS below for
//     what replaced it. STILL OPEN, and still the right cut: T-0123 added the *volume*
//     (src/shaders/lux/volume.glsl, the single-volume subset of HomogeneousVolume) without
//     adding the volume *stack*. What T-0113 covers is the general case -- priorities,
//     nested and overlapping media, ContinueToTrace, SetHitPointVolumes -- which this
//     scene's one watertight solid structurally cannot need.
//   - T-0131 (filed by T-0123): the volume-scatter path vertex, scene.cpp:768-791 -- the
//     SchlickScatter phase-function BSDF a scattering event would continue the path from.
//     Unreachable while the gem's volume has `scattering = 0 0 0`; see the call site below.
//   - T-0114 (speed-up, P3): the Russian-roulette branch above is provably dead while every
//     material in the scene stays delta-specular; worth special-casing out (skip the sampler
//     draw and the branch entirely) once the material set is known to stay glass-only.
//   - T-0115 (speed-up, P3): PathTracer_DirectLightSampling's 5 sampler draws
//     (sampleOffset+1..+5) are unconditionally taken every vertex purely to keep the RNG
//     stream's per-vertex layout identical to upstream's 9-dimension VERTEX_SAMPLE_SIZE
//     budget, even though the values are discarded at every polished (delta) vertex (see the
//     dead-code note above). Since T-0183 a frosted vertex genuinely uses them.
//     Dropping them would shrink each vertex's sampler footprint from 9 draws to 4, at the
//     cost of the RNG stream no longer lining up dimension-for-dimension with LuxCore's.
//
// RESTRUCTURINGS -- C++ shapes GLSL cannot express, and what replaced them:
//   - PathVolumeInfo (LuxCore's general stack of nested participating media, entered/exited as
//     a ray crosses interfaces) is replaced by a single `float side` local in
//     PathTracer_RenderEyePath, flipped between LUX_RAY_FROM_OUTSIDE and LUX_RAY_FROM_INSIDE
//     on every TRANSMIT event and left alone on REFLECT. This is exactly gem.frag's own
//     existing invariant for a single closed, non-volumetric dielectric solid (see
//     traceScene's `side` parameter and hitTriangle's comment on it) -- a stack is needed only
//     for scenes with nested or overlapping media, which this project's accel model (one
//     watertight mesh, one glass, no fog/participating media) structurally cannot have. See
//     the T-0113 cut ticket.
//     Since T-0123 that same `side` also answers Scene::Intersect's "which volume is this ray
//     travelling through?" (scene.cpp:715-750): inside means the gem's homogeneous interior
//     volume, outside means no volume. The one-bit answer is the whole of what a
//     single-solid scene needs a volume stack for; see the volume block in the loop below.
//   - The polymorphic `Material`/`BSDF` class hierarchy (virtual Sample/Evaluate/GetEventTypes/
//     IsDelta dispatched through a Material* set by Scene::Intersect) is replaced by
//     GlassParams (this file's own struct, not upstream) plus thin BSDF_* wrapper functions
//     that call straight through to glass.glsl's GlassMaterial_* functions -- continuing
//     glass.glsl's own T-0096 precedent of stripping dispatch machinery for a scene with
//     exactly one material. Since T-0183 there are two (GlassMaterial and, on frosted
//     facets, RoughGlassMaterial), so the "material pointer" survives as one bit,
//     LuxBSDF.frosted, and the BSDF_* wrappers branch on it. Both materials share
//     GlassParams: upstream's roughglass takes the same kr/kt/exteriorior/interiorior plus
//     uroughness/vroughness, which GlassParams now carries too.
//   - SIDE AFTER A GLOSSY TRANSMISSION (T-0183). `side` used to flip on every TRANSMIT event.
//     That is exact for a delta refraction, which always crosses the surface, but a microfacet
//     "transmission" sampled near grazing can leave on the SAME side of the macro surface it
//     arrived from (RoughGlassMaterial_Sample checks this only for reflection). Upstream's
//     PathVolumeInfo would then believe the ray is inside the gem's volume while it travels
//     outside; here it would be worse, because gem.frag's traceScene enforces the side rule,
//     so a ray labelled "inside" while outside could only ever find back faces. `side` is
//     therefore read off the geometry instead: whichever side of the facet the new ray
//     actually leaves on, the same test BSDF_GetRayOrigin already uses to pick its nudge. For
//     GlassMaterial the two rules agree on every event, so nothing changes for polished facets.
//   - GLSL has no unbounded `for(;;)`; a fragment shader that hangs cannot be interrupted (see
//     gem.frag's own comment on traceScene's hard iteration cap for the same reason). The
//     `for(;;)` loop becomes `for (int step = 0; step < LUX_MAX_PATH_VERTICES; ++step)`, a
//     defensive compile-time cap well above any max path depth this project configures (see
//     LUX_MAX_PATH_VERTICES below); the *configured* limit is still PathDepthInfo_
//     IsLastPathVertex, exactly as upstream, so this cap should never actually bind.
//   - GLSL's `&&`/`||` require `bool` operands; C/C++ implicitly treats `event & FLAG` (an int)
//     as true when non-zero. Every such upstream expression becomes `(event & FLAG) != 0`
//     here -- a syntax bridge, not a behaviour change, in the same spirit as prelude.glsl's
//     other OpenCL-C-vs-GLSL-ES notes.
//   - Pointer out-params (`Vector *sampledDir`, `float *pdfW`, ...) become GLSL `out`
//     parameters, and the `Spectrum::Black()` early-return idiom becomes a `bool` return
//     (matching glass.glsl's own `GlassMaterial_Sample` convention, reused here for
//     `BSDF_Sample`/`Scene_Intersect` alike).
// -----------------------------------------------------------------------------

#ifndef LUX_PATHTRACER_GLSL
#define LUX_PATHTRACER_GLSL

// -----------------------------------------------------------------------------
// bsdfevents.h:24-33 -- DIFFUSE and GLOSSY. glass.glsl's own LUX_BSDFEVENTS_GLSL guard already
// defines NONE/SPECULAR/REFLECT/TRANSMIT (the only flags a delta glass BSDF ever produces) and
// deliberately left these two out as "unused names risking collision". This integrator's
// (dead, see file header) DIFFUSE/GLOSSY branches in PathDepthInfo_IsLastPathVertex and
// PathTracer_CheckDirectHitVisibilityFlags need them to exist and hold the right bit values
// even though they can never be set by anything in this scene. Own guard, not glass.glsl's --
// re-opening LUX_BSDFEVENTS_GLSL here would silently skip this block whenever glass.glsl has
// already been concatenated (which tools/glsl_check.sh's required file order guarantees).
// Since T-0183 lux/roughglass.glsl, which does produce GLOSSY, opens the same guard with the
// same two constants; it is concatenated first, so in the assembled shader this block is the
// one skipped, and it still defines both when this file is checked on its own.
// -----------------------------------------------------------------------------
#ifndef LUX_PATHTRACER_BSDFEVENTS_GLSL
#define LUX_PATHTRACER_BSDFEVENTS_GLSL
const int DIFFUSE = 1;
const int GLOSSY = 2;
#endif // LUX_PATHTRACER_BSDFEVENTS_GLSL

// -----------------------------------------------------------------------------
// PathDepthInfo. pathdepthinfo.h:34-45 (fields), pathdepthinfo.cpp:30-56 (methods).
// Fields are `uint` here, matching upstream's `u_int`. A literal transliteration: no upstream
// C++ shape needed restructuring for this one.
// -----------------------------------------------------------------------------
struct PathDepthInfo {
    uint depth;
    uint diffuseDepth;
    uint glossyDepth;
    uint specularDepth;
};

// pathdepthinfo.cpp:37-45
void PathDepthInfo_IncDepths(inout PathDepthInfo info, BSDFEvent event) {
    info.depth += 1u;
    if ((event & DIFFUSE) != 0)
        info.diffuseDepth += 1u;
    if ((event & GLOSSY) != 0)
        info.glossyDepth += 1u;
    if ((event & SPECULAR) != 0)
        info.specularDepth += 1u;
}

// pathdepthinfo.cpp:47-52. `(event & FLAG) != 0` stands in for C's implicit int->bool
// (see file header, RESTRUCTURINGS); the DIFFUSE/GLOSSY arms are dead for this project's
// GlassMaterial (see the file header) but kept so the expression's shape survives a diff.
bool PathDepthInfo_IsLastPathVertex(PathDepthInfo info, PathDepthInfo maxPathDepth, BSDFEvent possibleEvents) {
    return (info.depth + 1u >= maxPathDepth.depth) ||
        (((possibleEvents & DIFFUSE) != 0) && (info.diffuseDepth + 1u >= maxPathDepth.diffuseDepth)) ||
        (((possibleEvents & GLOSSY) != 0) && (info.glossyDepth + 1u >= maxPathDepth.glossyDepth)) ||
        (((possibleEvents & SPECULAR) != 0) && (info.specularDepth + 1u >= maxPathDepth.specularDepth));
}

// pathdepthinfo.cpp:54-56
uint PathDepthInfo_GetRRDepth(PathDepthInfo info) {
    return info.diffuseDepth + info.glossyDepth;
}

// -----------------------------------------------------------------------------
// EyePathInfo, reduced. Upstream (pathinfo.h:39-93) also carries: isNearlyS/SD/SDS/
// isNearlyCaustic (feed only IsCausticPath(), consulted solely by the hybridBackForward and
// photonGI branches this project hard-disables -- T-0112), isPassThroughPath (feeds only
// forceBlackBackground, also disabled), lastShadeN/lastFromVolume/lastGlossiness (feed only
// the dead DirectLightSampling body and the disabled photonGI cache), isTransmittedPath (feeds
// only the miss-branch alpha AOV -- T-0111), and a `PathVolumeInfo volume` member (T-0113,
// replaced by PathTracer_RenderEyePath's own local `side`, see file header). What is left --
// `depth`, `lastBSDFEvent`, `lastBSDFPdfW` -- is exactly what PathInfo::UseRR,
// PathDepthInfo_IsLastPathVertex and PathTracer_DirectHitInfiniteLight's MIS-weight branch
// actually read.
// -----------------------------------------------------------------------------
struct EyePathInfo {
    PathDepthInfo depth;
    BSDFEvent lastBSDFEvent;
    float lastBSDFPdfW;
};

// pathinfo.cpp:34-36 (PathInfo::UseRR). See the file header for why this always returns false
// while every material in the scene is GlassMaterial.
bool PathInfo_UseRR(EyePathInfo info, uint rrDepth) {
    return ((info.lastBSDFEvent & SPECULAR) == 0) && (PathDepthInfo_GetRRDepth(info.depth) >= rrDepth);
}

// pathinfo.cpp:58-106 (EyePathInfo::AddVertex), reduced to the three fields this port kept --
// see the struct comment above for what was cut and why. `volume.Update(event, bsdf)` is
// T-0113 (PathVolumeInfo cut); the isNearlyS/SD/SDS/isNearlyCaustic bookkeeping and
// lastShadeN/lastFromVolume/lastGlossiness/isTransmittedPath updates are T-0111/T-0112.
void EyePathInfo_AddVertex(inout EyePathInfo info, BSDFEvent event, float pdfW) {
    PathDepthInfo_IncDepths(info.depth, event);
    info.lastBSDFEvent = event;
    info.lastBSDFPdfW = pdfW;
}

// -----------------------------------------------------------------------------
// RenderEngine::RussianRouletteProb. renderengine.h:159-161.
// `color.Filter()` (color.h:288/327, average of the three channels) is already ported as
// glass.glsl's Spectrum_Filter -- reused rather than redefined, per this project's own
// no-duplicate-helper convention.
// -----------------------------------------------------------------------------
float RenderEngine_RussianRouletteProb(vec3 color, float cap) {
    return clamp(Spectrum_Filter(color), cap, 1.0);
}

// -----------------------------------------------------------------------------
// MachineEpsilon. epsilon.h:40-103 (class), epsilon.cpp:23-24 (default min/max, already
// ported as prelude.glsl's DEFAULT_EPSILON_MIN/DEFAULT_EPSILON_MAX -- reused directly below).
//
// RESOLVED 2026-09-17: prelude.glsl's DEFAULT_EPSILON_MIN read 1e-9 when this file was written,
// against upstream's 1e-5f (epsilon_types.cl:21, luxrays::epsilon.cpp:23). That was an invented
// value, not a ported one, and it reached MachineEpsilon_E below, which sets the ray-offset
// nudge -- four orders of magnitude too small is self-intersection acne. The prelude now carries
// 1e-5, so the clamp below is upstream's. Found by this ticket's port (T-0109).
//
// NextFloat's bit-increment trick (epsilon.h:77-84) doesn't handle NaN/INFINITY, by upstream's
// own comment, and is not exactly monotonic across the positive/negative boundary at zero --
// ported as-is, bugs included, per this project's faithful-port instruction. `floatBitsToUint`/
// `uintBitsToFloat` stand in for C's `union { float f; uint i; }` reinterpretation, the same
// technique sampler.glsl's Rnd_InitFloat already uses in the other direction.
// -----------------------------------------------------------------------------
#ifndef LUX_EPSILON_DISTANCE_FROM_VALUE
#define LUX_EPSILON_DISTANCE_FROM_VALUE 0x80u
#endif

// epsilon.h:77-84 (MachineEpsilon::NextFloat)
float NextFloatUp(float value) {
    uint bits = floatBitsToUint(value);
    bits += LUX_EPSILON_DISTANCE_FROM_VALUE;
    return uintBitsToFloat(bits);
}

// epsilon.h:50-54 (MachineEpsilon::E(float))
float MachineEpsilon_E(float value) {
    float epsilon = fabs(NextFloatUp(value) - value);
    return clamp(epsilon, DEFAULT_EPSILON_MIN, DEFAULT_EPSILON_MAX);
}

// epsilon.h:62-64 (MachineEpsilon::E(const Point &)). "Point" is just a vec3 here (prelude has
// no separate Point/Vector/Normal distinction, unlike luxrays -- see prelude.glsl's own
// float3-for-everything convention).
float MachineEpsilon_E_Point(vec3 p) {
    return fmax(MachineEpsilon_E(p.x), fmax(MachineEpsilon_E(p.y), MachineEpsilon_E(p.z)));
}

// -----------------------------------------------------------------------------
// STUB INTERFACE 1 of 2 -- intersection. See the file header's "TWO STUB INTERFACES" section.
// Read (not modified) to match: src/shaders/gem.frag's `struct Hit` and `traceScene()`.
// -----------------------------------------------------------------------------

// This file's own side-of-surface constants, matching gem.frag's RAY_FROM_OUTSIDE/
// RAY_FROM_INSIDE in value and meaning (a ray from outside the stone can only enter; a ray
// already inside it can only leave) but deliberately not named the same or defined from the
// same guard -- see the file header for why.
#ifndef LUX_RAY_FROM_OUTSIDE
#define LUX_RAY_FROM_OUTSIDE 1.0
#endif
#ifndef LUX_RAY_FROM_INSIDE
#define LUX_RAY_FROM_INSIDE (-1.0)
#endif

// Not an upstream type. Fields are exactly what gem.frag's `Hit` struct and `traceScene()` can
// supply (hit distance, hit point, the facet's outward geometric normal, a facet id) and
// nothing else -- no UV, no per-vertex interpolated shading normal (this project's mesh is
// flat-shaded: every triangle carries one normal, so LuxCore's HitPoint::Init distinction
// between `geometryN` and the interpolated `shadeN`/`interpolatedN` collapses to a single
// value here, which is also exactly what BSDF_Init below assumes).
struct LuxHit {
    float t;
    vec3 hitPoint;
    vec3 geometricNormal;
    float facet;
};

// IMPLEMENTED (T-0120), and still stubbed when this file is compiled on its own.
//
// Hard boundary #1 (T-0109) said: do not port BVH/embree traversal here, call gem.frag's
// existing `traceScene(origin, direction, tMin, tMax, side, out Hit)` and translate between
// `Hit` and `LuxHit` (same fields, different names -- see above), passing `side` straight
// through (LUX_RAY_FROM_OUTSIDE/INSIDE equal RAY_FROM_OUTSIDE/INSIDE in value). That is exactly
// what the LUX_HAS_GEM_FRAG arm below does, and it is the only change T-0120 made to this file.
//
// `LUX_HAS_GEM_FRAG` is defined by src/shaders/gem.frag, which src/lib.rs concatenates ahead of
// this file. Without it -- `tools/glsl_check.sh` checking this file on its own -- the original
// stub is compiled instead, so the file still builds standalone, and a caller that assembles the
// unit in the wrong order gets an obviously broken (everything-misses) render rather than a
// plausible-looking wrong one.
#ifdef LUX_HAS_GEM_FRAG
bool Scene_Intersect(vec3 origin, vec3 direction, float tMin, float tMax, float side, out LuxHit hit) {
    // The oracle scene's black matte horizon quad, which this port cannot represent as a
    // second material. src/shaders/lux/host.glsl's own header explains in full what is
    // happening here and why; in short, the quad occluding the sky is reported as a MISS with
    // gLuxSkyVisibility cleared, which makes Env_GetRadiance return BLACK and ends the path --
    // the same contribution and the same path length as hitting a kd=0 matte.
    float horizonT = luxHorizonDistance(origin, direction);

    Hit gemHit;
    bool struck = traceScene(origin, direction, tMin, tMax, side, gemHit);

    bool occluded = (horizonT > tMin) && (horizonT < tMax) && (!struck || horizonT < gemHit.t);

    gLuxSkyVisibility = occluded ? 0.0 : 1.0;

    // Whether this eye path has met the stone at all -- host.glsl's own state, recorded
    // here for the same reason gLuxSkyVisibility is: this bridge arm is the one place that
    // knows, and everything between it and the environment lookup is ported code. It is
    // what lets lights.glsl tell a camera ray that missed everything (gem.frag's flat
    // background, never the window colour) from light leaving the stone (gem.frag's
    // arrivingLight cascade). A quad-occluded hit is a miss for this purpose as well as for
    // the sky, exactly as it is for LuxCore's black matte.                          T-0137
    gLuxPathHitStone = gLuxPathHitStone || (struck && !occluded);

    // `out` parameters are undefined until written, and the caller reads `hit` only when this
    // returns true; write every field on both paths anyway, as the stub did.
    if (!struck || occluded) {
        hit.t = tMax;
        hit.hitPoint = origin;
        hit.geometricNormal = vec3(0.0, 1.0, 0.0);
        hit.facet = 0.0;
        return false;
    }

    hit.t = gemHit.t;
    hit.hitPoint = origin + direction * gemHit.t;
    // gem.frag's Hit.outwardNormal is derived from the triangle winding and is the unflipped
    // outward geometric normal -- exactly luxrays' `Triangle::GetGeometryNormal`, and exactly
    // what BSDF_Init wants (it must NOT be turned to face the ray; glass.glsl reads
    // entering-vs-leaving off the sign of CosTheta(localFixedDir)).
    hit.geometricNormal = gemHit.outwardNormal;
    hit.facet = gemHit.facet;
    return true;
}
#else
bool Scene_Intersect(vec3 origin, vec3 direction, float tMin, float tMax, float side, out LuxHit hit) {
    hit.t = tMax;
    hit.hitPoint = origin;
    hit.geometricNormal = vec3(0.0, 1.0, 0.0);
    hit.facet = 0.0;
    return false;
}
#endif // LUX_HAS_GEM_FRAG

// -----------------------------------------------------------------------------
// STUB INTERFACE 2 of 2 -- the environment/infinite light. See the file header.
//
// IMPLEMENTED (T-0116): src/shaders/lux/lights.glsl, concatenated after this file (see
// tools/glsl_check.sh's fixed order), defines the real bodies -- ConstantInfiniteLight and
// SunLight, ported from constantinfinitelight.cpp/sunlight.cpp. Only the forward
// declarations remain here, so PathTracer_DirectHitInfiniteLight below (which calls both)
// still compiles against definitions that appear later in the same translation unit; GLSL,
// like C, requires a prototype before a call that precedes the matching definition. Read
// lights.glsl's own file header for the full account: what each function does, why
// GetRadiance (not Emit) is the one that actually produces this project's image, every
// restructuring, and exactly what the (separate, not-yet-written) wiring ticket must supply
// as real `uniform`s in place of lights.glsl's placeholder constants.
//
// `direction` follows LuxCore's own convention for ConstantInfiniteLight::GetRadiance/
// InfiniteLight-family lights: pointing from the shading point back toward where the ray
// came from, i.e. call this with `-rayDirection`, matching
// `envLight.GetRadiance(scene, bsdf, -ray.d, &directPdfW)` (constantinfinitelight.cpp:49-50,
// called from pathtracer.cpp:334). `directPdfW` is an area-measure light-sampling pdf, needed
// only by the (dead, see file header) MIS-weight branch below.
// -----------------------------------------------------------------------------
vec3 Env_GetRadiance(vec3 direction, out float directPdfW);

// Stands in for `scene.GetLightSources().GetIlluminateLightStrategy().SampleLightPdf(...)`
// (pathtracer.cpp:338-339) -- the probability of having picked this light among all lights in
// the scene, for the same dead MIS-weight branch. See lights.glsl's own comment on this
// function for why 1.0 is exact for every case that can actually read it.
float Env_GetLightPickPdf();

// The direction-sampling half of the environment light's Illuminate, for
// PathTracer_DirectLightSampling (T-0183): a direction from the shading point towards the
// environment, and the solid-angle pdf it was drawn with. Defined in lights.glsl, which owns
// the environment; see its comment for why this is ConstantInfiniteLight::Illuminate's
// uniform-sphere sampling applied to the whole collapsed environment.
vec3 Env_SampleDirection(float u0, float u1, out float directPdfW);

// -----------------------------------------------------------------------------
// FROSTED FACETS -- HOST INTEGRATION POINT (T-0183).
//
// Whether the facet with this id is frosted, i.e. uses RoughGlassMaterial rather than
// GlassMaterial. lux/host.glsl defines it as a lookup in uFrostedTexture, the per-facet mask
// GemApp::set_frosted_facets uploads. Standalone (tools/glsl_check.sh on this file) nothing is
// frosted, which is what the page shows until a tier is marked.
// -----------------------------------------------------------------------------
#ifndef LUX_FACET_IS_FROSTED
#define LUX_FACET_IS_FROSTED(facet) false
#endif

// -----------------------------------------------------------------------------
// GlassParams. Not an upstream type -- see the file header's RESTRUCTURINGS note. Bundles the
// arguments glass.glsl's GlassMaterial_Sample takes in place of upstream's texture/eval-stack
// resolution (glass.glsl:52-57), so BSDF_Sample below has one material-parameters argument
// instead of seven.
//
// `uRoughness`/`vRoughness` are RoughGlassMaterial's `uroughness`/`vroughness` (T-0183), read
// only on frosted facets; every other field means the same thing to both materials, as it does
// upstream (roughglass.cpp's constructor takes the same Kr, Kt, exteriorIor and interiorIor as
// glass.cpp's). `cauchyB` is GlassMaterial's alone: LuxCore's roughglass has no dispersion.
// -----------------------------------------------------------------------------
struct GlassParams {
    vec3 kr;
    vec3 kt;
    float nc;
    float nt;
    float cauchyB;
    float filmThickness;
    float filmIor;
    float uRoughness;
    float vRoughness;
};

// -----------------------------------------------------------------------------
// LuxBSDF. Not an upstream type -- stands in for the polymorphic `BSDF` class (bsdf.h) with its
// `material` pointer removed (there is only ever one material -- GlassParams is passed
// alongside instead, at each call site, exactly like glass.glsl's own material functions).
// Carries only the HitPoint/Frame fields BSDF_Sample and BSDF_GetRayOrigin actually read:
// `p` (hitPoint.p), `geometryN` (hitPoint.geometryN -- also hitPoint.shadeN/interpolatedN here,
// see LuxHit's comment on flat shading), `fixedDir` (hitPoint.fixedDir), and `frame`
// (BSDF::frame, math.glsl's Frame struct).
//
// `frosted` (T-0183) stands in for the `material` pointer: false is GlassMaterial, true is
// RoughGlassMaterial. See the file header.
// -----------------------------------------------------------------------------
struct LuxBSDF {
    vec3 p;
    vec3 geometryN;
    vec3 fixedDir;
    Frame frame;
    bool frosted;
};

// bsdf.cpp:29-72 (BSDF::Init, the "hit a surface" overload) + hitpoint.cpp:33-73
// (HitPoint::Init), fused and restructured: no Scene/SceneObject/mesh/material-index lookups
// (one hard-coded material), no bump/normal mapping (no textures), no interior/exterior volume
// bookkeeping (T-0113), no triangle-light lookup (no area lights in this scene -- T-0111/
// T-0112's cut also covers `bsdf.IsLightSource()`, always false here). `hitPoint.fixedDir =
// -ray.d` (hitpoint.cpp:43, `dir` there is `-ray.d` from bsdf.cpp:42) and `hitPoint.geometryN`
// (hitpoint.cpp:56, mesh->GetGeometryNormal -- exactly gem.frag's Hit.outwardNormal, unflipped)
// are ported directly; `hitPoint.shadeN = hitPoint.interpolatedN = hitPoint.geometryN` always
// holds for this flat-shaded mesh (see LuxHit's comment), so there is only one normal to carry.
// `frame = hitPoint.GetFrame()` (bsdf.cpp:71) is `Frame_SetFromZ(shadeN)`
// (hitpoint.h/frame.h's GetFrame), built from the *unflipped* outward normal -- deliberately
// not oriented to face the incoming ray the way gem.frag's own `main()` does for its display
// convenience, because GlassMaterial_Sample/glass.glsl's local-frame maths already reads
// entering-vs-leaving off the sign of CosTheta(localFixedDir) (see glass.glsl's
// FresnelCauchy_Evaluate `entering = (cosi > 0.0)`), exactly as upstream relies on.
void BSDF_Init(vec3 rayDirection, LuxHit hit, out LuxBSDF bsdf) {
    bsdf.p = hit.hitPoint;
    bsdf.geometryN = hit.geometricNormal;
    bsdf.fixedDir = -rayDirection;
    Frame_SetFromZ(bsdf.frame, bsdf.geometryN);
    // `material = &sceneObject->GetMaterial();` -- bsdf.cpp:47, reduced to which of the two
    // materials this facet has (T-0183). The facet id is per facet, not per triangle, so every
    // triangle of a frosted facet is frosted.
    bsdf.frosted = LUX_FACET_IS_FROSTED(hit.facet);
}

// BSDF::GetEventTypes -> material->GetEventTypes(): glass.h:41 (GlassMaterial) or
// roughglass.h:41 (RoughGlassMaterial, T-0183).
BSDFEvent BSDF_GetEventTypes(LuxBSDF bsdf) {
    if (bsdf.frosted)
        return RoughGlassMaterial_GetEventTypes();
    return SPECULAR | REFLECT | TRANSMIT;
}

// BSDF::IsDelta -> material->IsDelta(): GlassMaterial's is `true` (glass.h:43);
// RoughGlassMaterial inherits Material::IsDelta(), `false` (material.h:126).
bool BSDF_IsDelta(LuxBSDF bsdf) {
    return !bsdf.frosted;
}

// bsdf.cpp:363-397 (BSDF::Sample), restructured: `material->Sample(...)` becomes a direct call
// to GlassMaterial_Sample (glass.glsl) via GlassParams instead of a virtual dispatch; the
// shadow-terminator correction (bsdf.cpp:379-387) is dropped -- it only ever applies to
// `DIFFUSE | GLOSSY` events with a smooth-shading normal that differs from the geometric one,
// and this project's material is always SPECULAR and its mesh is flat-shaded (shadeN ==
// interpolatedN always, see LuxHit's comment), so `hitPoint.shadeN != hitPoint.interpolatedN`
// is always false here; the adjoint-BSDF correction (bsdf.cpp:389-394) is dropped because
// `hitPoint.fromLight` is always false for an eye-path integrator (this file never ports
// RenderLightSample -- T-0110). `*absCosSampledDir` (bsdf.cpp:376) is not computed: nothing in
// RenderEyePath's own body ever reads the local `cosSampledDir` it's assigned to (only AOV/
// light-tracing code downstream of this ticket's scope would). Returns `false` where upstream's
// `if (result.Black()) return result;` would hand back a black Spectrum, matching
// GlassMaterial_Sample's own bool-return convention (glass.glsl, T-0096).
//
// T-0183: `material->Sample` dispatches on LuxBSDF.frosted. The shadow-terminator correction
// stays dropped for RoughGlassMaterial's GLOSSY | REFLECT events too: it needs
// `shadeN != interpolatedN`, which a flat-shaded mesh never has.
bool BSDF_Sample(LuxBSDF bsdf, GlassParams glass, float u0, float u1, float passThroughEvent,
        out vec3 sampledDir, out float pdfW, out BSDFEvent event, out vec3 result) {
    vec3 localFixedDir = Frame_ToLocal(bsdf.frame, bsdf.fixedDir);
    vec3 localSampledDir;

    bool sampled;
    if (bsdf.frosted) {
        sampled = RoughGlassMaterial_Sample(localFixedDir, u0, u1, passThroughEvent,
                glass.kr, glass.kt, glass.nc, glass.nt, glass.uRoughness, glass.vRoughness,
                glass.filmThickness, glass.filmIor,
                localSampledDir, pdfW, event, result);
    } else {
        sampled = GlassMaterial_Sample(localFixedDir, u0, u1, passThroughEvent,
                glass.kr, glass.kt, glass.nc, glass.nt, glass.cauchyB,
                glass.filmThickness, glass.filmIor,
                localSampledDir, pdfW, event, result);
    }
    if (!sampled)
        return false;

    sampledDir = Frame_ToWorld(bsdf.frame, localSampledDir);
    return true;
}

// bsdf.cpp:288-339 (BSDF::Evaluate), T-0183. Only ever called by
// PathTracer_DirectLightSampling, i.e. only for a non-delta BSDF, so in practice only at a
// frosted facet; the GlassMaterial arm is kept so the dispatch is total, and returns black
// exactly as GlassMaterial::Evaluate does (glass.glsl). Dropped, each for a reason that holds
// for every hit in this scene:
//   - the eye/light swap on `hitPoint.fromLight` and the adjoint-BSDF factor at the end: this
//     is an eye-path integrator, fromLight is always false (T-0110), so eyeDir = fixedDir;
//   - the `IsVolume()` guards: this BSDF is never a volume scatter point (T-0113/T-0131);
//   - the interpolated-normal side test (bsdf.cpp:312-316) and the shadow-terminator factor:
//     the mesh is flat-shaded, interpolatedN == shadeN == geometryN (see LuxHit), so the
//     first repeats the geometric-normal test verbatim and the second never applies.
// Returns false where upstream returns a black Spectrum.
bool BSDF_Evaluate(LuxBSDF bsdf, GlassParams glass, vec3 generatedDir,
        out BSDFEvent event, out float directPdfW, out vec3 result) {
    event = NONE;
    directPdfW = 0.0;
    result = BLACK;

    vec3 eyeDir = bsdf.fixedDir;
    vec3 lightDir = generatedDir;

    float dotLightDirNG = dot(lightDir, bsdf.geometryN);
    float absDotLightDirNG = fabs(dotLightDirNG);
    float dotEyeDirNG = dot(eyeDir, bsdf.geometryN);
    float absDotEyeDirNG = fabs(dotEyeDirNG);

    // Avoid glancing angles
    if ((absDotLightDirNG < DEFAULT_COS_EPSILON_STATIC) ||
            (absDotEyeDirNG < DEFAULT_COS_EPSILON_STATIC))
        return false;

    // Check geometry normal and light direction side
    float sideTestNG = dotEyeDirNG * dotLightDirNG;
    BSDFEvent matEvents = BSDF_GetEventTypes(bsdf);
    if (((sideTestNG > 0.0) && ((matEvents & REFLECT) == 0)) ||
            ((sideTestNG < 0.0) && ((matEvents & TRANSMIT) == 0)))
        return false;

    vec3 localLightDir = Frame_ToLocal(bsdf.frame, lightDir);
    vec3 localEyeDir = Frame_ToLocal(bsdf.frame, eyeDir);

    if (!bsdf.frosted) {
        result = GlassMaterial_Evaluate(localLightDir, localEyeDir, event);
        return false;
    }

    bool evaluated = RoughGlassMaterial_Evaluate(localLightDir, localEyeDir,
            glass.kr, glass.kt, glass.nc, glass.nt, glass.uRoughness, glass.vRoughness,
            glass.filmThickness, glass.filmIor,
            result, event, directPdfW);

    // if (result.Black()) return result; -- bsdf.cpp:323-324
    return evaluated && !Spectrum_IsBlack(result);
}

// bsdf.h:166-174 (BSDF::GetRayOrigin). The `IsVolume()` branch (bsdf.h:168, `return
// hitPoint.p;` unmodified) is dropped: this BSDF is never a volume-scatter point (T-0113), so
// only the "rise along the geometry normal" arm ever runs.
vec3 BSDF_GetRayOrigin(LuxBSDF bsdf, vec3 sampleDir) {
    float riseDirection = (dot(sampleDir, bsdf.geometryN) > 0.0) ? 1.0 : -1.0;
    return bsdf.p + riseDirection * (bsdf.geometryN * MachineEpsilon_E_Point(bsdf.p));
}

// -----------------------------------------------------------------------------
// PathTracer::DirectLightResult (pathtracer.h, nested enum). `#define` rather than a GLSL
// `enum` (GLSL ES 3.00 has none) -- the same pattern glass.glsl uses for `#define BSDFEvent int`.
// -----------------------------------------------------------------------------
#define DirectLightResult int
const int ILLUMINATED = 0;
const int SHADOWED = 1;
const int NOT_VISIBLE = 2;

// pathtracer.cpp:262-275 (CheckDirectHitVisibilityFlags), restructured: upstream asks the hit
// *light source* whether it opts into being visible after a diffuse/glossy/specular indirect
// bounce (`light->IsVisibleIndirectDiffuse()` etc., light.h) -- a per-light authoring flag this
// project's one hard-coded environment light has no equivalent of (and LuxCore's own default
// for all three is `true`, per light.h). Those three calls are replaced by that same default,
// inlined, rather than invented as a fourth stub interface.
bool PathTracer_CheckDirectHitVisibilityFlags(PathDepthInfo depthInfo, BSDFEvent lastBSDFEvent) {
    if (depthInfo.depth == 0u)
        return true;

    if ((lastBSDFEvent & DIFFUSE) != 0)
        return true; // light->IsVisibleIndirectDiffuse(), default true
    if ((lastBSDFEvent & GLOSSY) != 0)
        return true; // light->IsVisibleIndirectGlossy(), default true
    if ((lastBSDFEvent & SPECULAR) != 0)
        return true; // light->IsVisibleIndirectSpecular(), default true

    return false;
}

// This port's own shadow-ray / next-ray bounds; see the comment where they are used first,
// in PathTracer_RenderEyePath below. Defined here because PathTracer_DirectLightSampling
// (T-0183) traces a shadow ray with the same bounds and GLSL, like C, needs a macro defined
// before its first use.
#ifndef LUX_SELF_HIT_EPSILON
#define LUX_SELF_HIT_EPSILON 1e-6
#endif
#ifndef LUX_MAX_DISTANCE
#define LUX_MAX_DISTANCE 1e9
#endif

// pathtracer.cpp:137-260 (PathTracer::DirectLightSampling). The whole body is gated on
// `!bsdf.IsDelta()`, which until T-0183 was never true (GlassMaterial is delta, see the file
// header), so this was a `return NOT_VISIBLE;` stub. RoughGlassMaterial is not delta, and on a
// frosted facet this is now the real function. Its contribution is added to `radiance`
// (standing in for `sampleResult->AddDirectLight`, whose arithmetic core is
// `radiance[lightID] += pathThroughput * incomingRadiance`, sampleresult.cpp:84-87; the AOV
// bucketing after it is T-0111's cut).
//
// RESTRUCTURINGS, each forced by something this port already is:
//   - THE ENVIRONMENT IS ONE LIGHT. Upstream asks the illuminate light strategy to pick one of
//     the scene's lights (`lightStrategy.SampleLights(..., u0, ...)`) and calls that light's
//     Illuminate. This port has only ever exposed the environment as ONE light:
//     Env_GetRadiance (lights.glsl) already sums the sky and every sun into one radiance, and
//     Env_GetLightPickPdf is 1. So there is nothing to pick (u0 is drawn and unused, as
//     upstream's own single-light strategies leave it), and Illuminate is
//     ConstantInfiniteLight::Illuminate's own direction sampling (constantinfinitelight.cpp:
//     135-137, the no-visibility-map arm: a uniform direction on the sphere, pdf
//     1/(4 pi), from u1 and u2) applied to that whole environment -- see Env_SampleDirection.
//     That is a valid estimator for ANY environment radiance, the project's image-based and
//     analytical ones included, which have no importance map of their own. Its one cost is
//     variance on LuxCore's small suns, which BSDF sampling picks up through the MIS weight.
//     `u3` is Illuminate's passThroughEvent, read upstream only by the visibility-map cache
//     this project never enables (T-0117), so it is drawn and unused too.
//   - RADIANCE IS LOOKED UP AFTER THE SHADOW RAY, not before it. Upstream's Illuminate returns
//     the light's radiance and the shadow ray then says whether anything blocks it. Here the
//     environment's radiance is not a pure function of direction: Env_GetRadiance reads
//     host.glsl's gLuxSkyVisibility (the LuxCore rig's horizon quad) and gLuxPathHitStone,
//     both written by Scene_Intersect. Tracing first and then calling Env_GetRadiance with
//     exactly the arguments PathTracer_DirectHitInfiniteLight would use for the same ray
//     makes this estimate and the BSDF-sampled one evaluate the SAME function -- which is
//     what MIS needs to be unbiased -- and gives the horizon quad upstream's own effect (a
//     black matte in the way contributes nothing). Only a hit on the STONE is SHADOWED: glass
//     has no pass-through transparency, so, as upstream, a shadow ray never sees light through
//     the gem; that light arrives by BSDF sampling instead.
//   - `Illuminate`'s `cosAtLight < DEFAULT_COS_EPSILON_STATIC` test against the scene's
//     bounding sphere (constantinfinitelight.cpp:143-157) is dropped: a shading point on a
//     stone of radius 1 is always deep inside LuxCore's environment sphere, where that cosine
//     is 1 to within float precision. `shadowRayDistance` becomes LUX_MAX_DISTANCE likewise.
//   - `light->GetAvgPassThroughTransparency()` is 1 for an environment light (light.h's
//     default), and `shadowBsdf.hitPoint.throughShadowTransparency` is always false (the gem
//     has no shadow transparency), so both are omitted from the arithmetic.
//   - The hybridBackForward / IsCausticPath arm, the shadow-catcher arm and the irradiance AOV
//     are cut (T-0112, T-0111), as everywhere else in this file.
DirectLightResult PathTracer_DirectLightSampling(float u0, float u1, float u2, float u3, float u4,
        EyePathInfo pathInfo, vec3 pathThroughput, LuxBSDF bsdf, GlassParams glass,
        bool lastPathVertex, uint rrDepth, float rrImportanceCap, inout vec3 radiance) {
    if (!BSDF_IsDelta(bsdf)) {
        // Pick a light source to sample -- the environment, the only one; see above.
        float lightPickPdf = Env_GetLightPickPdf();

        // light->Illuminate(scene, bsdf, time, u1, u2, u3, shadowRay, directPdfW)
        float directPdfW;
        vec3 shadowRayDir = Env_SampleDirection(u1, u2, directPdfW);
        vec3 shadowRayOrig = BSDF_GetRayOrigin(bsdf, shadowRayDir);

        BSDFEvent event;
        float bsdfPdfW;
        vec3 bsdfEval;
        if (!BSDF_Evaluate(bsdf, glass, shadowRayDir, event, bsdfPdfW, bsdfEval))
            return NOT_VISIBLE;

        // Create a new PathDepthInfo for the path to the light source
        PathDepthInfo directLightDepthInfo = pathInfo.depth;
        PathDepthInfo_IncDepths(directLightDepthInfo, event);

        // Check if the light source is visible. The side follows the direction the shadow
        // ray actually leaves the facet in -- see the file header's note on `side`.
        float shadowSide = (dot(shadowRayDir, bsdf.geometryN) > 0.0) ? LUX_RAY_FROM_OUTSIDE : LUX_RAY_FROM_INSIDE;
        LuxHit shadowHit;
        if (Scene_Intersect(shadowRayOrig, shadowRayDir, LUX_SELF_HIT_EPSILON, LUX_MAX_DISTANCE, shadowSide, shadowHit))
            return SHADOWED;

        // `connectionThroughput` from the shadow ray's Scene::Intersect: the interior volume's
        // transmittance when the ray runs inside the gem. A shadow ray that starts inside a
        // watertight stone always hits it and is SHADOWED above, so this is the numerical-
        // escape case only, handled as the eye path's own volume block handles it.
        vec3 connectionThroughput = WHITE;
        if (shadowSide == LUX_RAY_FROM_INSIDE) {
            vec3 connectionEmission = BLACK;
            HomogeneousVolume_Scatter(LUX_SELF_HIT_EPSILON, shadowHit.t,
                    u4, false, LUX_VOLUME_MULTISCATTERING,
                    LUX_VOLUME_SIGMA_A, LUX_VOLUME_SIGMA_S, LUX_VOLUME_EMISSION,
                    connectionThroughput, connectionEmission);
        }

        // The light's radiance along the shadow ray, looked up the way an escaping eye ray's
        // is (PathTracer_DirectHitInfiniteLight): `-shadowRayDir` is upstream's `-ray.d`.
        float unusedDirectPdfW;
        vec3 lightRadiance = Env_GetRadiance(-shadowRayDir, unusedDirectPdfW);
        if (Spectrum_IsBlack(lightRadiance))
            return NOT_VISIBLE;

        // I'm ignoring volume emission because it is not sampled in
        // direct light step.
        float directLightSamplingPdfW = directPdfW * lightPickPdf;
        float factor = 1.0 / directLightSamplingPdfW;

        if (PathDepthInfo_GetRRDepth(directLightDepthInfo) >= rrDepth) {
            // Russian Roulette
            bsdfPdfW *= RenderEngine_RussianRouletteProb(bsdfEval, rrImportanceCap);
        }

        // MIS between direct light sampling and BSDF sampling
        //
        // Note: I have to avoid MIS on the last path vertex
        bool misEnabled = !lastPathVertex &&
            PathTracer_CheckDirectHitVisibilityFlags(directLightDepthInfo, event);

        float weight = misEnabled ? PowerHeuristic(directLightSamplingPdfW, bsdfPdfW) : 1.0;
        vec3 incomingRadiance = bsdfEval * (weight * factor) * connectionThroughput * lightRadiance;

        radiance += pathThroughput * incomingRadiance;

        return ILLUMINATED;
    }

    return NOT_VISIBLE;
}

// pathtracer.cpp:320-349 (DirectHitInfiniteLight), restructured: upstream loops
// `scene.GetLightSources().GetEnvLightSources()` (any number of constantinfinite/sky/sun
// lights) and asks each in turn; this project has exactly one environment (Env_GetRadiance,
// see STUB INTERFACE 2 above), so the loop becomes a single call. The
// `bsdf->hitPoint.throughShadowTransparency` early return (pathtracer.cpp:325-326) is dropped:
// GlassMaterial has no pass-through/shadow-transparency (T-0111/T-0112's cuts cover the
// generality this would need), so it is always false. The MIS-weight branch
// (pathtracer.cpp:337-342) is ported live. It was dead while every material was GlassMaterial
// -- `pathInfo.lastBSDFEvent` always had SPECULAR set (both its EyePathInfo default and every
// value GlassMaterial_Sample ever produces), so `weight = 1.f` unconditionally -- and since
// T-0183 it runs whenever the last bounce was off a frosted facet (GLOSSY): the ray that
// escaped here is weighted against PathTracer_DirectLightSampling having found the same
// direction. `directPdfW` must then be the pdf that function samples with, which is why
// Env_GetRadiance reports UniformSpherePdf() for every environment (see lights.glsl).
// Matches only the arithmetic core of `sampleResult->AddEmission` (sampleresult.cpp:59-65):
// `radiance[lightID] += pathThroughput * incomingRadiance` -- the AOV channel-bucketing the
// rest of that function does is T-0111.
vec3 PathTracer_DirectHitInfiniteLight(EyePathInfo pathInfo, vec3 pathThroughput, vec3 rayDirection) {
    if (!PathTracer_CheckDirectHitVisibilityFlags(pathInfo.depth, pathInfo.lastBSDFEvent))
        return BLACK;

    float directPdfW;
    vec3 envRadiance = Env_GetRadiance(-rayDirection, directPdfW);
    if (Spectrum_IsBlack(envRadiance))
        return BLACK;

    float weight;
    if ((pathInfo.lastBSDFEvent & SPECULAR) == 0) {
        // Live after a frosted (GLOSSY) bounce only -- see the comment above the function.
        float lightPickProb = Env_GetLightPickPdf();
        weight = PowerHeuristic(pathInfo.lastBSDFPdfW, directPdfW * lightPickProb);
    } else {
        weight = 1.0;
    }

    return pathThroughput * (weight * envRadiance);
}

// Defensive GLSL-side compile-time cap on path.cpp's `for(;;)` -- see the file header's
// RESTRUCTURINGS note. Not an upstream value; chosen generously above any max depth this
// project is expected to configure (renders/luxcore/*.cfg's oracle renders use 24). The
// *configured* limit is PathDepthInfo_IsLastPathVertex below, exactly as upstream; this cap
// should never actually bind, and exists only so a misconfigured maxPathDepth cannot hang a
// GPU that cannot be interrupted mid-frame (the same reasoning as gem.frag's own
// MAX_BOUNCE_LIMIT / traceScene iteration cap).
const int LUX_MAX_PATH_VERTICES = 64;

// This port's own tuning constants for Scene_Intersect's tMin/tMax, standing in for LuxCore's
// considerably more general Ray/MachineEpsilon-based mint/maxt handling (luxrays::Ray,
// UpdateMinMaxWithEpsilon) -- not needed in as much generality here because BSDF_GetRayOrigin
// already nudges every subsequent ray's origin off the surface by MachineEpsilon_E_Point before
// the next Scene_Intersect call, the same way gem.frag's own SURFACE_EPSILON nudge does for its
// interior march. Chosen at the same order of magnitude as gem.frag's own INTERIOR_T_MIN
// (1e-6) and FAR_DISTANCE (1e9); the wiring ticket may replace these with gem.frag's actual
// named constants instead, once this file is concatenated alongside it.
#ifndef LUX_SELF_HIT_EPSILON
#define LUX_SELF_HIT_EPSILON 1e-6
#endif
#ifndef LUX_MAX_DISTANCE
#define LUX_MAX_DISTANCE 1e9
#endif

// -----------------------------------------------------------------------------
// PathTracer::RenderEyePath. pathtracer.cpp:387-671. The primary port. See the file header for
// the full account of every cut and restructuring; inline comments below mark only the ones
// specific to a single line.
//
// Signature, vs. upstream's `RenderEyePath(device, scene, sampler, pathInfo&, eyeRay&,
// eyeThroughput, sampleResults&)`: `device`/`scene` are dropped (no ray-count AOV, no
// Scene object -- Scene_Intersect above is the whole scene interface this file needs);
// `pathInfo` is constructed fresh inside rather than threaded in by reference, since this port
// has no equivalent of RenderEyeSample/PathTracerThreadState persisting it across samples --
// every call renders exactly one whole eye path End to end and returns its radiance,
// matching `RenderEyeSample`'s own usage (pathtracer.cpp:677-690): a fresh `EyePathInfo
// pathInfo;` and `RenderEyePath(..., Spectrum(1.f), ...)` every time. `eyeOrigin`/
// `eyeDirection` replace `eyeRay` (this port has no camera/pixel-jitter machinery --
// GenerateEyeRay, pathtracer.cpp:351-381, is camera/film wiring, not integrator logic, and is
// left to the wiring ticket, which already has gem.frag's own primary-ray setup).
// `sampleResults` (the whole Film/AOV machinery) is replaced by this function's own vec3
// return value, matching only `sampleResult.radiance[0]` (this project has exactly one
// radiance group -- see T-0111).
// -----------------------------------------------------------------------------
vec3 PathTracer_RenderEyePath(vec3 eyeOrigin, vec3 eyeDirection, GlassParams glass,
        PathDepthInfo maxPathDepth, uint rrDepth, float rrImportanceCap,
        inout RandomSamplerState sampler) {
    // EyePathInfo pathInfo; -- PathInfo::PathInfo() (pathinfo.cpp:30) default-initialises
    // lastBSDFEvent to SPECULAR ("SPECULAR is required to avoid MIS", upstream's own comment);
    // EyePathInfo::EyePathInfo() (pathinfo.cpp:53-56) default-initialises lastBSDFPdfW to 1.f.
    EyePathInfo pathInfo;
    pathInfo.depth = PathDepthInfo(0u, 0u, 0u, 0u);
    pathInfo.lastBSDFEvent = SPECULAR;
    pathInfo.lastBSDFPdfW = 1.0;

    // Spectrum pathThroughput(eyeTroughput); -- eyeTroughput is always Spectrum(1.f), see the
    // signature comment above.
    vec3 pathThroughput = WHITE;
    // sampleResult.radiance[0] accumulator -- see the signature comment (T-0111 cut).
    vec3 radiance = BLACK;

    vec3 rayOrigin = eyeOrigin;
    vec3 rayDirection = eyeDirection;
    // T-0113 restructuring: replaces `pathInfo.volume` (PathVolumeInfo). The eye ray always
    // starts outside the (single, closed, watertight) stone -- see the file header.
    float side = LUX_RAY_FROM_OUTSIDE;

    // for (;;) -- see the file header's RESTRUCTURINGS note on LUX_MAX_PATH_VERTICES.
    for (int step = 0; step < LUX_MAX_PATH_VERTICES; ++step) {
        // sampleResult.firstPathVertex = (pathInfo.depth.depth == 0); -- pathtracer.cpp:407
        bool firstPathVertex = (pathInfo.depth.depth == 0u);
        // const u_int sampleOffset = eyeSampleBootSize + pathInfo.depth.depth *
        // eyeSampleStepSize; -- pathtracer.cpp:408. eyeSampleBootSize (5) and eyeSampleStepSize
        // (9) are exactly sampler.glsl's IDX_BSDF_OFFSET and VERTEX_SAMPLE_SIZE (see that
        // file's own comment: "load-bearing for whatever ports LuxCore's path integrator on top
        // of this sampler" -- this is that ticket).
        uint sampleOffset = uint(IDX_BSDF_OFFSET) + pathInfo.depth.depth * uint(VERTEX_SAMPLE_SIZE);

        // const float passThrough = sampler.GetSample(sampleOffset); -- pathtracer.cpp:412.
        // Upstream hands this one draw to Scene::Intersect, which spends it on three things:
        // the pass-through-material test (elided -- GlassMaterial's pass-through transparency
        // is always black), the volume's scattering-distance draw (kept, see the volume block
        // below), and `hitPoint.passThroughEvent`, which BSDF::Sample reads back out
        // (bsdf.cpp:371) -- so the same value reaches BSDF_Sample's passThroughEvent argument
        // here too, exactly as upstream reuses it.
        float passThrough = Sampler_GetSample(sampler, sampleOffset);

        // const bool hit = scene.Intersect(..., &pathInfo.volume, passThrough, &eyeRay,
        // &eyeRayHit, &bsdf, &connectionThroughput, ...); pathThroughput *=
        // connectionThroughput; -- pathtracer.cpp:413-419.
        LuxHit hit;
        bool didHit = Scene_Intersect(rayOrigin, rayDirection, LUX_SELF_HIT_EPSILON, LUX_MAX_DISTANCE, side, hit);

        //------------------------------------------------------------------
        // The volume segment of Scene::Intersect (scene.cpp:691, 733-792), inlined.  T-0123
        //
        // `connectionThroughput` is upstream's accumulator for everything that attenuates a
        // ray *between* two path vertices: pass-through materials and volume transmittance.
        // Until T-0123 this port had neither, so the multiply at pathtracer.cpp:419 was
        // dropped as a provable no-op. It is no longer one: the gem has an interior volume
        // (src/shaders/lux/volume.glsl), and Beer-Lambert attenuation over each interior
        // segment is what gives a coloured stone its body colour.
        //
        // Inlined here rather than pushed into Scene_Intersect because that function is this
        // port's own intersection stub interface (see the file header), not a port of
        // Scene::Intersect -- which is a C++ member with a PathVolumeInfo*, a BSDF*, a
        // SampleResult* and a pass-through retry loop, none of which exist here. The three
        // upstream statements that survive are reproduced in upstream's own order.
        //
        // WHICH VOLUME. Upstream asks `volInfo->GetCurrentVolume()` (scene.cpp:715-718),
        // falling back to `bsdf->hitPoint.exteriorVolume`/`interiorVolume` and then to
        // `defaultWorldVolume`. T-0113 reduced that whole question to this loop's `side`
        // local, and the answer for this scene is a one-bit one: inside the stone the current
        // volume is the gem's homogeneous interior volume; outside it there is no volume at
        // all (the oracle scene sets no `scene.world.volume.default`, so
        // `defaultWorldVolume` is null and upstream skips the block entirely -- which is
        // exactly what the `else` of this `if` does).
        //
        // WHY THE MISS CASE IS HANDLED TOO, and not special-cased away: upstream runs this
        // block whether or not the ray hit anything, over `ray->mint .. ray->maxt`.
        // Scene_Intersect sets `hit.t = tMax` on a miss, so `hit.t` is `ray->maxt` there and
        // the arithmetic is upstream's unchanged. A watertight solid cannot let an interior
        // ray escape, so this cannot actually fire; if numerical error ever made it, the
        // attenuation over 1e9 units is exp(-huge) == 0, which is upstream's own answer for
        // an infinite segment (volume.glsl's isinf arm).
        vec3 connectionThroughput = WHITE;      // scene.cpp:691
        vec3 connectionEmission = BLACK;        // `Spectrum emis;` -- scene.cpp:758
        if (side == LUX_RAY_FROM_INSIDE) {      // `if (rayVolume)` -- scene.cpp:753
            // `rayVolume->Scatter(*ray, passThrough, volInfo->IsScatteredStart(),
            // connectionThroughput, &emis)` -- scene.cpp:759-760, dispatching to
            // HomogeneousVolume::Scatter. Two arguments deserve a word:
            //
            //   * `passThrough` is upstream's own choice of random number here, and upstream
            //     comments on it ("by using passThrough here, I introduce subtle correlation
            //     between scattering events and pass-through events", scene.cpp:756-757).
            //     One divergence, stated: upstream draws it from a Tausworthe generator
            //     re-seeded from the sampler's value (scene.cpp:695-697) rather than passing
            //     the sampler value straight down, and this passes it straight down. The
            //     value is read only by SegmentScatter's scattering-distance draw, which is
            //     unreachable while sigmaS is BLACK, so nothing observable depends on it;
            //     re-seeding a whole RNG per intersection to feed a dead draw is not worth
            //     the shader.
            //   * `volInfo->IsScatteredStart()` is set only by the volume-scatter path vertex
            //     (scene.cpp:788) that this port does not build, so it is false here by
            //     construction, not by assumption.
            float volumeScatterT = HomogeneousVolume_Scatter(LUX_SELF_HIT_EPSILON, hit.t,
                    passThrough, false, LUX_VOLUME_MULTISCATTERING,
                    LUX_VOLUME_SIGMA_A, LUX_VOLUME_SIGMA_S, LUX_VOLUME_EMISSION,
                    connectionThroughput, connectionEmission);

            // if (!emis.Black()) sampleResult->AddEmission(rayVolume->GetVolumeLightID(),
            // *pathThroughput, emis); -- scene.cpp:762-766. The gem's volume is not emissive
            // (LUX_VOLUME_EMISSION is BLACK, so `connectionEmission` is BLACK), and the light
            // group it would be added to is T-0111's AOV cut.
            //
            // if (t > 0.f) { ... } -- scene.cpp:768-791. NOT PORTED (T-0131): a volume scatter
            // event makes the scatter point a path vertex whose BSDF is the volume's
            // SchlickScatter phase function, which is a second material in this integrator.
            // `volumeScatterT` is always -1.0 here: the only thing that can return a scatter
            // distance is SegmentScatter's `scatterAllowed && (sigmaSValue > 0.0)` branch, and
            // LUX_VOLUME_SIGMA_S is BLACK (host.glsl). If a scattering coefficient is ever
            // plumbed in, this branch must be ported before it is believed -- see T-0131 and
            // volume.glsl's "NOT PORTED" list.
        }

        // pathThroughput *= connectionThroughput; -- pathtracer.cpp:419
        pathThroughput *= connectionThroughput;

        // const bool checkDirectLightHit = (!hybridBackForwardEnable ||
        // !pathInfo.IsCausticPath()) && (!photonGICache || ...); -- pathtracer.cpp:422-427.
        // hybridBackForwardEnable and photonGICache are both permanently off in this project
        // (T-0112), so both disjuncts of the `&&` are unconditionally true at the source.
        bool checkDirectLightHit = true;

        if (!didHit) {
            // if ((!(forceBlackBackground && pathInfo.isPassThroughPath) ||
            // !pathInfo.isPassThroughPath) && checkDirectLightHit) -- pathtracer.cpp:431-432.
            // forceBlackBackground is off by default and not exposed by anything this project
            // configures (T-0112's cut covers it), so that half of the `&&` is always true too.
            if (checkDirectLightHit) {
                radiance += PathTracer_DirectHitInfiniteLight(pathInfo, pathThroughput, rayDirection);
            }
            // sampleResult.alpha/depth/position/geometryNormal/shadingNormal/materialID/
            // objectID/uv AOV bookkeeping (pathtracer.cpp:438-454) -- T-0111.
            break;
        }

        // Something was hit.
        LuxBSDF bsdf;
        BSDF_Init(rayDirection, hit, bsdf);

        // albedoToDo/sampleResult.albedo AOV (pathtracer.cpp:460-464), firstPathVertex AOV
        // bookkeeping (alpha/depth/position/geometryNormal/materialID/objectID/uv/isHoldout,
        // pathtracer.cpp:466-476) -- T-0111.

        // sampleResult.lastPathVertex = pathInfo.depth.IsLastPathVertex(maxPathDepth,
        // bsdf.GetEventTypes()); -- pathtracer.cpp:477
        bool lastPathVertex = PathDepthInfo_IsLastPathVertex(pathInfo.depth, maxPathDepth, BSDF_GetEventTypes(bsdf));

        // Baked-material check (pathtracer.cpp:483-489) -- no baked/lightmap materials in this
        // scene (T-0111/T-0112).
        //
        // if (bsdf.IsLightSource() && checkDirectLightHit) DirectHitFiniteLight(...); --
        // pathtracer.cpp:495-498. GlassMaterial::IsLightSource() is always false (glass is
        // never emissive) and this scene has no area lights at all, only the one environment
        // (see STUB INTERFACE 2) -- DirectHitFiniteLight itself is not ported (T-0111).
        //
        // PhotonGI cache block (pathtracer.cpp:504-565) -- permanently disabled, T-0112.

        //------------------------------------------------------------------
        // Direct light sampling. pathtracer.cpp:567-590.
        //------------------------------------------------------------------
        if (lastPathVertex && !firstPathVertex)
            break;

        // const DirectLightResult directLightResult = DirectLightSampling(..., sampler.
        // GetSample(sampleOffset+1)...+5, pathInfo, pathThroughput, bsdf, &sampleResult); --
        // pathtracer.cpp:578-587. Returns at once for a polished (delta) facet, and the five
        // draws are still taken, in the same order, to preserve the per-vertex
        // sampler-dimension layout (see the T-0115 cut); on a frosted facet (T-0183) it
        // samples the environment and adds the MIS-weighted result to `radiance`.
        DirectLightResult directLightResult = PathTracer_DirectLightSampling(
                Sampler_GetSample(sampler, sampleOffset + 1u),
                Sampler_GetSample(sampler, sampleOffset + 2u),
                Sampler_GetSample(sampler, sampleOffset + 3u),
                Sampler_GetSample(sampler, sampleOffset + 4u),
                Sampler_GetSample(sampler, sampleOffset + 5u),
                pathInfo, pathThroughput, bsdf, glass,
                lastPathVertex, rrDepth, rrImportanceCap, radiance);
        // directLightResult is never read again in this project (it exists upstream only to
        // gate the shadow-catcher branch immediately below, which this scene has no material
        // for -- see next comment); kept as a named local anyway, matching upstream's shape.

        if (lastPathVertex)
            break;

        //------------------------------------------------------------------
        // Build the next vertex path ray. pathtracer.cpp:592-658.
        //------------------------------------------------------------------

        // if (bsdf.IsShadowCatcher() && (directLightResult != SHADOWED)) { ... } else { ... } --
        // pathtracer.cpp:601-623. No shadow-catcher material in this scene (T-0111/T-0112), so
        // only the final `else` arm (a plain bsdf.Sample() call) is ever reachable; the
        // shadow-transparency arm inside that same `else` (pathtracer.cpp:609-615) is also
        // unreachable, since GlassMaterial's pass-through shadow transparency is always black
        // (opaque) -- both branches are dropped, leaving only:
        vec3 sampledDir;
        float bsdfPdfW;
        BSDFEvent bsdfEvent;
        vec3 bsdfSample;
        bool sampled = BSDF_Sample(bsdf, glass,
                Sampler_GetSample(sampler, sampleOffset + 6u),
                Sampler_GetSample(sampler, sampleOffset + 7u),
                passThrough,
                sampledDir, bsdfPdfW, bsdfEvent, bsdfSample);
        // pathInfo.isPassThroughPath = false; -- pathtracer.cpp:621. Field cut (T-0111/T-0112:
        // unused once forceBlackBackground/hybridBackForward are gone).

        // verify (!bsdfSample.IsNaN() && ...); -- pathtracer.cpp:625. Debug-only assertion
        // macro; no GLSL/fragment-shader equivalent, dropped (gem.frag carries none either).
        // if (bsdfSample.Black()) break; -- pathtracer.cpp:626-627
        if (!sampled)
            break;

        // if (sampleResult.firstPathVertex) sampleResult.firstPathVertexEvent = bsdfEvent; --
        // pathtracer.cpp:629-630. AOV only (T-0111).

        // pathInfo.AddVertex(bsdf, bsdfEvent, bsdfPdfW, hybridBackForwardGlossinessThreshold);
        // -- pathtracer.cpp:632. Depth increments HERE, before Russian roulette below reads
        // PathDepthInfo_GetRRDepth() -- same order as upstream.
        EyePathInfo_AddVertex(pathInfo, bsdfEvent, bsdfPdfW);

        // Russian Roulette. pathtracer.cpp:634-643. See the file header: inert for GlassMaterial,
        // and in practice for RoughGlassMaterial too at this project's rrDepth; ported live.
        float rrProb = 1.0;
        if (PathInfo_UseRR(pathInfo, rrDepth)) {
            rrProb = RenderEngine_RussianRouletteProb(bsdfSample, rrImportanceCap);
            if (rrProb < Sampler_GetSample(sampler, sampleOffset + 8u))
                break;

            bsdfSample /= rrProb;
        }

        // pathThroughput *= bsdfSample; -- pathtracer.cpp:645. See the T-0092 note in the file
        // header: this is what threads a transmission event's sampled-wavelength tint through
        // every subsequent bounce.
        pathThroughput *= bsdfSample;

        // irradiance AOV (pathtracer.cpp:648-656) -- T-0111.

        // T-0113 restructuring: PathVolumeInfo's job (tracking which side of the interface the
        // next ray starts on) reduced to one `side`, matching gem.frag's own single-closed-solid
        // invariant (see the file header). It used to flip on every TRANSMIT event; since
        // T-0183 it is read off the side of the facet the new ray actually leaves on, because a
        // glossy transmission need not cross the macro surface. For GlassMaterial the two rules
        // agree on every event -- see the file header's "SIDE AFTER A GLOSSY TRANSMISSION".
        side = (dot(sampledDir, bsdf.geometryN) > 0.0) ? LUX_RAY_FROM_OUTSIDE : LUX_RAY_FROM_INSIDE;

        // eyeRay.Update(bsdf.GetRayOrigin(sampledDir), sampledDir); -- pathtracer.cpp:658
        rayOrigin = BSDF_GetRayOrigin(bsdf, sampledDir);
        rayDirection = sampledDir;
    }

    // sampleResult.rayCount += ...; if (sampleResult.isHoldout) { ... }; PhotonGI debug-mode
    // fallback -- pathtracer.cpp:661-670. AOV/debug-mode only (T-0111/T-0112); no holdout
    // material in this scene.
    return radiance;
}

#endif // LUX_PATHTRACER_GLSL
