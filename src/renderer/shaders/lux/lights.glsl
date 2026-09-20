// -----------------------------------------------------------------------------
// LuxCore environment lights (ConstantInfiniteLight + SunLight), ported to GLSL ES 3.00.
//                                                                                T-0116
//
// Ported from LuxCoreRender (https://github.com/LuxCoreRender/LuxCore),
// reference/LuxCore commit e9ced7e ("Fix log format regression", 2026-09-11):
//
//   src/slg/lights/constantinfinitelight.cpp   ConstantInfiniteLight::GetRadiance (49-79,
//                                               else branch only -- see RESTRUCTURINGS),
//                                               ConstantInfiniteLight::Emit (81-108)
//   include/slg/lights/constantinfinitelight.h ConstantInfiniteLight fields (color)
//   include/slg/lights/light_funcs.cl          ConstantInfiniteLight_GetRadiance (56-79),
//                                               the .cl twin, read to confirm the .cpp and
//                                               .cl bodies agree (they do, module by-now-
//                                               familiar VLOAD3F/pointer plumbing)
//   src/slg/lights/sunlight.cpp                SunLight::SunLight (32-33), SunLight::
//                                               Preprocess (35-54, geometry-only part -- see
//                                               RESTRUCTURINGS), SunLight::Emit (150-176),
//                                               SunLight::GetRadiance (213-232)
//   include/slg/lights/sunlight.h              SunLight fields (color, localSunDir,
//                                               turbidity, relSize, absoluteSunDir, x, y,
//                                               cosThetaMax, sin2ThetaMax)
//   include/slg/lights/light_types.cl          LIGHT_WORLD_RADIUS_SCALE (23),
//                                               SunLightParam (49-56) -- cited as
//                                               corroboration, not transliterated: it is the
//                                               real LuxCore GPU-side struct holding exactly
//                                               absoluteDir/turbidity/relSize/x/y/
//                                               cosThetaMax/sin2ThetaMax/color as plain
//                                               fields uploaded once by the host, never
//                                               recomputed by an OpenCL kernel -- see "WHAT
//                                               THE HOST MUST SUPPLY" below, which follows
//                                               the same split upstream itself already makes
//   include/slg/lights/light.h                 LightSource / NotIntersectableLightSource /
//                                               InfiniteLightSource / EnvLightSource class
//                                               hierarchy (the fields and Preprocess/
//                                               GetEnvRadius behaviour those two light types
//                                               inherit)
//   src/slg/lights/light.cpp                   NotIntersectableLightSource::Preprocess
//                                               (81-83, temperatureScale), InfiniteLightSource
//                                               ::GetEnvRadius (96-98)
//   src/slg/engines/pathtracer.cpp             DirectHitInfiniteLight (320-335, the loop and
//                                               call convention this file's Env_GetRadiance
//                                               replaces -- see RESTRUCTURINGS; the live rest
//                                               of that function, 336-349, already lives in
//                                               src/shaders/lux/pathtracer.glsl as
//                                               PathTracer_DirectHitInfiniteLight)
//   include/luxrays/utils/mc_funcs.cl          UniformSpherePdf (175-177) -- not yet ported
//                                               anywhere else in this project; added here,
//                                               guarded, see "NEW SHARED HELPER" below
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
// THE ONE THING THAT MUST BE EXACTLY RIGHT. src/shaders/lux/pathtracer.glsl's own file
// header (and kb/luxcore-as-a-reference-oracle.md, kb/luxcore-path-integrator-port-dead-
// russian-roulet.md) already establish: GlassMaterial::IsDelta() is unconditionally true, so
// PathTracer_DirectLightSampling's body never runs for this project's one material -- a
// polished gem is never lit by direct light sampling, in real LuxCore or in this port. Every
// photon this renderer's stone shows therefore arrives by a specular bounce chain escaping
// the glass and landing inside GetRadiance's domain. Consequently:
//
//   - SunLight_GetRadiance and ConstantInfiniteLight_GetRadiance (below) are what actually
//     produce the image. They must be exact.
//   - SunLight_Emit / ConstantInfiniteLight_Emit are ported faithfully (full bodies, same
//     names, same expression order, cited line ranges) because the ticket asked for a
//     faithful port of the light, not just of the one function that happens to matter here --
//     but they have NO CALLER anywhere in this project. Upstream calls Emit only from the
//     light-tracing / hybrid-backward-forward path (pathtracer.cpp:673-946), which
//     pathtracer.glsl's own file header already cuts as T-0110 (this project only ever
//     traces eye paths). Treat any bug in *_Emit as cosmetic until T-0110 is ever picked up.
//   - *_Illuminate (SunLight::Illuminate, sunlight.cpp:178-211; ConstantInfiniteLight::
//     Illuminate, constantinfinitelight.cpp:110-164) is NOT ported at all. It is the shadow-
//     ray-sampling entry point for PathTracer_DirectLightSampling, which is exactly the dead
//     branch the paragraph above describes -- pathtracer.glsl already stubs that caller to
//     `return NOT_VISIBLE;` without calling any light's Illuminate. Porting it here would be
//     more dead code with no caller in this file's own call graph either. If a future non-
//     delta material ever revives PathTracer_DirectLightSampling (pathtracer.glsl's file
//     header already flags that branch as "ported live... so a future non-delta material
//     makes it fire again for free"), Illuminate becomes required then, and should be ported
//     at that point, not before.
//   - LightSource::GetPower (constantinfinitelight.cpp:42-47, sunlight.cpp:144-148) is NOT
//     ported. It exists upstream to feed power-based light-picking strategies
//     (LightStrategyPower/LogPower/DLSC, src/slg/lights/strategies/*.cpp) that this file does
//     not implement -- see Env_GetLightPickPdf below and the cut ticket referenced there.
//
// -----------------------------------------------------------------------------
// WHAT THE HOST MUST SUPPLY. This is the list the wiring ticket needs; nothing below is
// wired to a real `uniform` by this ticket (T-0116 is shader-file-only; see CLAUDE.md's
// "one narrow edit elsewhere" scope). Every item is instead a `#ifndef`-guarded placeholder
// constant a few lines down (search "HOST INTEGRATION POINT"), chosen so this file compiles
// standalone via tools/glsl_check.sh and defaults to a safe, documented value (0 suns, the
// isometric rig's exact configuration) until the wiring ticket overrides it.
//
//   1. Sky (ConstantInfiniteLight): `color` and `gain`, each a vec3. Both renders/luxcore/
//      *.scn files this project ships use color = (1,1,1), gain = (0.22,0.22,0.22) --
//      LUX_SKY_COLOR / LUX_SKY_GAIN below default to exactly those. Cheap, not turbidity-
//      dependent, no reason this needs a real uniform rather than a shared constant unless
//      the wiring ticket wants the sky gain to track gem.frag's own existing `uEnvIntensity`
//      uniform (kb/luxcore-vs-ours-comparison-harness.md records that `tools/compare_luxcore.
//      py` already treats `uEnvIntensity` as the analogue of LuxCore's sky gain -- likely the
//      natural thing for the wiring ticket to reuse here instead of adding a new uniform).
//
//   2. Suns (SunLight), for however many the scene configures (studio rig: 5; isometric: 0,
//      per this ticket's brief -- "the isometric rig has only the sky, no suns"):
//        - a count, 0..LUX_ENV_MAX_SUNS (LUX_ENV_SUN_COUNT below)
//        - per sun: a world-space direction (`localSunDir` upstream; this port additionally
//          assumes `lightToWorld` is identity, see RESTRUCTURINGS, so "world-space direction"
//          and "local direction" are the same vector) and `relSize` -- CHEAP, this file
//          computes cosThetaMax/sin2ThetaMax/x/y from them every call via SunLight_Preprocess,
//          faithfully porting sunlight.cpp:38-54, so the host does not need to precompute
//          those (though upstream's own GPU path does -- see the SunLightParam citation
//          above -- so hoisting this file's per-call CoordinateSystem/sqrt work to a host-
//          computed uniform is a legitimate, cheap speed-up; recorded, not taken, see
//          SPEED-UPS below).
//        - per sun: `color`, a vec3 -- the ONE genuinely expensive-to-compute-in-a-fragment-
//          shader quantity. SunLight::Preprocess (sunlight.cpp:56-103) computes this from
//          `turbidity`, `relSize`, `gain` and the sun's own zenith angle (`absoluteTheta`,
//          itself derived from `absoluteSunDir` -- see the direction-convention note below)
//          via a 91-sample loop over Rayleigh/aerosol/ozone/gas/water-vapour atmospheric
//          attenuation curves (`reference/LuxCore/include/slg/lights/data/sunspect.h`'s
//          spectral tables), then integrates the result against the CIE standard observer to
//          XYZ and converts XYZ to RGB via `ColorSystem::DefaultColorSystem.ToRGBConstrained
//          (...).Clamp()`. None of that data (the spectral tables, the CIE matching
//          functions, the RGB primaries matrix) exists anywhere in this shader codebase, and
//          it is exactly the kind of quantity this ticket's brief calls out as needing to
//          become a host-computed uniform rather than a per-pixel GLSL computation: it is
//          CONSTANT for the whole frame (same turbidity/relSize/gain/direction every pixel,
//          every sample), so computing it once on the Rust side and uploading the result is
//          strictly better than recomputing an atmospheric-scattering integral per escaped
//          ray. **This file does not attempt it and does not guess a numeric value** --
//          LUX_ENV_SUN_COLOR below is a deliberately-inert vec3(1.0) per sun, clearly marked,
//          so a render using the placeholder shows the right sun CONE (verified by hand, see
//          the close note) with the wrong sun COLOUR until the host wires the real value in.
//          The straightforward way to compute it correctly: either port sunlight.cpp:56-103
//          verbatim to Rust host code (same rule this ticket followed -- port from the .cpp
//          for host code, kb/clean-room-and-licensing-constraints.md), or call pyluxcore's
//          own SunLight setup as a black-box oracle (already a dependency, see
//          kb/luxcore-as-a-reference-oracle.md) and read `color` back out.
//
//   Direction-convention trap worth flagging for whoever computes `color`: SunLight::
//   Preprocess's atmospheric optical-mass term (`m`, sunlight.cpp:70-71) is a function of
//   `absoluteTheta = SphericalTheta(absoluteSunDir)`, and SphericalTheta (both the .cl
//   version this project already ported into math.glsl and the luxrays::SphericalTheta this
//   ticket read at include/luxrays/core/geometry/vector.h:205-207 to confirm they agree) is
//   `acos(clamp(v.z, -1, 1))` -- it always measures the angle from world +Z, regardless of
//   which axis a given scene actually treats as "up". This project's camera convention
//   (src/camera.rs, renders/luxcore/*.scn) is Y-up (`scene.camera.up = 0 0 -1`, eye at
//   (0, 52, 0)). So the atmospheric attenuation baked into a sun's `color` depends on that
//   sun's Z-component specifically, not its height above this project's own ground plane --
//   an upstream convention, not a bug this port introduced, but one the host-side `color`
//   computation must reproduce exactly (i.e. feed SunLight::Preprocess the same raw
//   `localSunDir` vector this project's .scn files already use, untransformed) rather than
//   "fixing" it to use Y as up.
//
// -----------------------------------------------------------------------------
// RESTRUCTURINGS -- C++ shapes GLSL cannot express, or generality this single-gem, single-
// sky+sun-rig project has no use for, and what replaced them:
//
//   - `lightToWorld` (NotIntersectableLightSource::lightToWorld, light.h:178) is assumed
//     identity. Neither renders/luxcore/*.scn file this project ships sets a
//     `scene.lights.<n>.transformation` property for any light, so LuxCore itself defaults
//     it to identity for every light in these scenes; `SunLight::Preprocess`'s
//     `Normalize(lightToWorld * localSunDir)` (sunlight.cpp:38) becomes plain `normalize
//     (localSunDir)` in SunLight_Preprocess below. If a future scene ever transforms a light,
//     this port would need the matrix threaded in too.
//
//   - `temperatureScale` (NotIntersectableLightSource::Preprocess, light.cpp:81-83:
//     `temperature >= 0.f ? TemperatureToWhitePoint(...) : Spectrum(1.f)`) is hardcoded to
//     `vec3(1.0)` everywhere it appears below. Neither .scn file sets a `.temperature`
//     property for any light, and NotIntersectableLightSource's own constructor
//     (light.h:157) defaults `temperature` to -1.f, so upstream's own ternary always takes
//     the `Spectrum(1.f)` arm for these scenes; porting `TemperatureToWhitePoint` (a
//     blackbody-locus computation with its own CIE data dependency, unrelated to this
//     ticket's two light types) would be dead code. If a scene ever sets `.temperature`,
//     this constant needs to become a real computation.
//
//   - `bsdf` (the `const BSDF *bsdf` parameter both GetRadiance overloads take, used only to
//     decide `directPdfA`'s value and, for ConstantInfiniteLight, to gate a visibility-map
//     cache this project never enables) is dropped from both *_GetRadiance signatures below,
//     matching pathtracer.glsl's own `Env_GetRadiance(vec3 direction, out float directPdfW)`
//     stub interface (T-0109), which was already given no bsdf parameter before this ticket
//     started. `PathTracer_DirectHitInfiniteLight` (pathtracer.glsl:563-582) calls
//     `Env_GetRadiance(-rayDirection, directPdfW)` from the branch reached only after
//     `Scene_Intersect` returns a miss (pathtracer.glsl:685-695) -- i.e. always after at
//     least the eye ray existed, so the *only* upstream call site this project's integrator
//     has (pathtracer.cpp:334, `envLight.GetRadiance(scene, bsdf, -ray.d, &directPdfW)`)
//     passes `bsdf` non-null except on a direct camera-ray miss on the very first vertex
//     (pathtracer.cpp:429-436: `sampleResult.firstPathVertex ? nullptr : &bsdf`). Both
//     *_GetRadiance functions below therefore always take the "`bsdf` truthy" branch of
//     upstream's ternary; a direct camera-ray miss with the placeholder bsdf==null branch
//     would compute the same `directPdfA` value here anyway (`UniformSpherePdf()` for the
//     sky, ConstantInfiniteLight; SunLight's GetRadiance never reads `bsdf` in the first
//     place), so this restructuring changes nothing observable at either call site.
//
//   - Multiple environment lights, collapsed. Upstream's `DirectHitInfiniteLight`
//     (pathtracer.cpp:320-335) loops `scene.GetLightSources().GetEnvLightSources()` --
//     however many env lights a scene has (1 sky + N suns here) -- and for each one calls
//     GetRadiance, and if the result is non-black, its own independent MIS-weight branch
//     and `sampleResult->AddEmission` add its contribution separately. Since
//     `sampleResult->AddEmission` is linear in its radiance argument (`radiance[lightID] +=
//     pathThroughput * weight * emittedRadiance`, sampleresult.cpp:61-62, already ported as
//     the sum pathtracer.glsl's own `PathTracer_DirectHitInfiniteLight` performs) and this
//     project's `weight` is unconditionally 1.0 for every one of these lights (GlassMaterial
//     always sets `event & SPECULAR`, see pathtracer.glsl's file header), summing every env
//     light's GetRadiance result INSIDE Env_GetRadiance before returning to
//     PathTracer_DirectHitInfiniteLight produces an identical `pathThroughput * envRadiance`
//     as upstream's per-light loop would, one call site simplification the T-0109 stub
//     interface already implied by giving Env_GetRadiance exactly one call site instead of a
//     loop. The one place this collapsing loses information: `directPdfW` can no longer be
//     one-value-per-light. Since that value only feeds the same unconditionally-1.0-weight
//     branch (dead for this project's material either way), Env_GetRadiance below just keeps
//     whichever light's directPdfW was computed last among the ones that contributed
//     (sky always first, then any sun whose cone the direction falls in) -- an arbitrary,
//     explicitly-noted choice with no live effect.
//
// -----------------------------------------------------------------------------
// CUTS -- LuxCore light generality this single-gem, sky+sun-rig project has no use for,
// recorded as a ticket, not implemented. Filed by this ticket:
//   - T-0117 (cut, P3): EnvLightVisibilityCache / `useVisibilityMapCache` (image-based
//     importance sampling for ConstantInfiniteLight/InfiniteLight/Sky2Light), the
//     LightStrategy family beyond a trivial single-light-pick (LightStrategyUniform/
//     LogPower/Power/DLSC, src/slg/lights/strategies/*.cpp, all of which need
//     LightSource::GetPower and a full scene light enumeration this project never builds),
//     Sky2Light (a separate, more general physically-based sky model neither .scn file this
//     project ships actually uses -- both use plain `constantinfinite`), and light groups /
//     IES profiles / other LuxCore light types (point/spot/laser/sphere/projection/
//     triangle/distant) entirely absent from this project's two rigs.
//
// SPEED-UPS -- recorded, not implemented (--label luxcore,perf):
//   - T-0118 (P3): SunLight_Preprocess's geometric derivation (CoordinateSystem, two sqrts
//     for cosThetaMax/sin2ThetaMax) is recomputed from scratch on every Env_GetRadiance call
//     for every configured sun, even though none of its inputs (`localSunDir`, `relSize`)
//     change within a frame. Upstream's own GPU path never recomputes this at all -- see the
//     SunLightParam citation above, a plain per-light struct uploaded once. Hoisting this
//     file's per-call recomputation to a host-computed uniform (mirroring how `color` already
//     has to be one) would save a CoordinateSystem call and two sqrts per escaped ray per
//     configured sun; left as ordinary per-call GLSL work here because, unlike `color`, it is
//     cheap enough that doing it live is correct and simple, and this ticket was not asked to
//     optimise.
// -----------------------------------------------------------------------------

#ifndef LUX_LIGHTS_GLSL
#define LUX_LIGHTS_GLSL

// --- NEW SHARED HELPER --------------------------------------------------------
// mc_funcs.cl:175-177. Not ported by any earlier file (math.glsl has UniformConePdf and the
// UniformSample* family but not this one). Guarded by its own token, per this project's "new
// helpers go in your own file, wrapped in #ifndef" rule (prelude.glsl's header), rather than
// added to math.glsl, which this ticket does not own.
#ifndef LUX_UNIFORM_SPHERE_PDF_DEFINED
#define LUX_UNIFORM_SPHERE_PDF_DEFINED
float UniformSpherePdf() {
    return 1.0 / (4.0 * M_PI_F);
}
#endif

// light_types.cl:23. Used only by *_Emit below (dead code, see file header), which needs it
// to convert a scene bounding-sphere radius into an "environment radius" the same way
// InfiniteLightSource::GetEnvRadius (light.cpp:96-98) does.
#ifndef LIGHT_WORLD_RADIUS_SCALE
#define LIGHT_WORLD_RADIUS_SCALE 1.05
#endif

// -----------------------------------------------------------------------------
// HOST INTEGRATION POINT -- placeholder scene data, standing in for the real `uniform`s the
// wiring ticket must add. See the file header's "WHAT THE HOST MUST SUPPLY" for the full
// list and exactly why each one is shaped this way. Every symbol here is `#ifndef`-guarded so
// the wiring ticket can `#define`/redeclare it (or delete this whole block and declare real
// `uniform`s with matching names/shapes) without editing this file. Defaults reproduce the
// isometric rig (sky only, no suns) exactly, which is this ticket's own safe, zero-sun
// default and also the rig kb/luxcore-as-a-reference-oracle.md recommends diffing against
// first, since it has no fitted lighting parameters. Placed here, before the functions that
// read these macros, because GLSL's preprocessor (like C's) expands top-down -- a `#define`
// used above its own definition is an undeclared identifier, not a forward reference.
// -----------------------------------------------------------------------------

// Sky: renders/luxcore/hex_cut_v2-{studio,isometric}.scn both set
// `scene.lights.sky.color = 1.0 1.0 1.0` and `scene.lights.sky.gain = 0.22 0.22 0.22`.
#ifndef LUX_SKY_COLOR
#define LUX_SKY_COLOR vec3(1.0, 1.0, 1.0)
#endif
#ifndef LUX_SKY_GAIN
#define LUX_SKY_GAIN vec3(0.22, 0.22, 0.22)
#endif

// Suns: renders/luxcore/hex_cut_v2-studio.scn configures 5, all sharing
// `relsize = 22.5248295`, `turbidity = 2.2` (baked into LUX_ENV_SUN_COLOR below once the
// host computes it -- see file header), at these 5 directions
// (`scene.lights.sun0..4.dir`). renders/luxcore/hex_cut_v2-isometric.scn configures 0.
#ifndef LUX_ENV_MAX_SUNS
#define LUX_ENV_MAX_SUNS 5
#endif
#ifndef LUX_ENV_SUN_COUNT
#define LUX_ENV_SUN_COUNT 0 // PLACEHOLDER default: isometric rig (sky only). See above.
#endif
#ifndef LUX_ENV_SUN_RELSIZE
#define LUX_ENV_SUN_RELSIZE 22.5248295
#endif
#ifndef LUX_ENV_SUN_DIR
const vec3 LUX_ENV_SUN_DIR[LUX_ENV_MAX_SUNS] = vec3[LUX_ENV_MAX_SUNS](
    vec3(0.397131262, 0.906307787, 0.144543958),
    vec3(-0.46984631, 0.819152044, 0.328989928),
    vec3(-0.198266891, 0.64278761, -0.739942112),
    vec3(0.224143868, 0.5, 0.836516304),
    vec3(0.154508497, 0.951056516, -0.267616567)
);
#endif
// PLACEHOLDER, deliberately not a real value -- see file header "WHAT THE HOST MUST SUPPLY".
// vec3(1.0) makes a render using this default show the right sun CONE (verified by hand,
// see this ticket's close note) with the wrong sun COLOUR, which is the intended, obvious-
// looking-wrong behaviour until the host wires the real per-sun value in.
#ifndef LUX_ENV_SUN_COLOR
const vec3 LUX_ENV_SUN_COLOR[LUX_ENV_MAX_SUNS] = vec3[LUX_ENV_MAX_SUNS](
    vec3(1.0), vec3(1.0), vec3(1.0), vec3(1.0), vec3(1.0)
);
#endif

// -----------------------------------------------------------------------------
// ENVIRONMENT SOURCE SELECTION.                                                    T-0127
//
// Not ported LuxCore code: LuxCore has no such concept. It exists because this project's
// ported path has to be able to render two genuinely different environments, and the
// Env_GetRadiance seam is where they meet.
//
//   LUX_ENVIRONMENT_PROJECT  this project's own environment -- the Gem Cut Studio
//                            assessment models (Angle Rings / Isometric / Cosine), the
//                            Studio rig, the equirectangular skybox image, the head-shadow
//                            cone, the environment rotation and intensity -- read through
//                            gem.frag's existing sampleEnvironment(). The page default: a
//                            person who picks a lighting model means it whichever renderer
//                            is drawing, and before T-0127 selecting the ported renderer
//                            silently discarded that choice.
//
//   LUX_ENVIRONMENT_LUXCORE  the ConstantInfiniteLight + SunLight rig this file ports.
//                            **This is what tools/compare_luxcore.py scores the port
//                            against**: tools/luxcore_oracle.py builds its oracle scenes
//                            from exactly this rig, so it is the port's only acceptance
//                            test and must stay reachable. tests/harness/gem.py selects it
//                            whenever $GEM_RENDERER asks for the ported renderer.
//
// The selector is a macro, not a `uniform` declared here, for the same reason every other
// scene input in this file is (see "HOST INTEGRATION POINT" below): the file must still
// compile on its own under tools/glsl_check.sh. src/shaders/lux/host.glsl defines it as the
// real `uLuxEnvironment` uniform. Standalone, it defaults to LuxCore's own lights, which is
// both what the rest of this file implements and the only thing that can work without
// gem.frag.
//
// params::LuxEnvironment::as_u32 is the host side of these two numbers, and
// `lux_environment_encoding_matches_the_ported_lights_shader` in src/lib.rs enforces the
// match.
// -----------------------------------------------------------------------------

#ifndef LUX_ENVIRONMENT_PROJECT
#define LUX_ENVIRONMENT_PROJECT 0
#endif
#ifndef LUX_ENVIRONMENT_LUXCORE
#define LUX_ENVIRONMENT_LUXCORE 1
#endif
#ifndef LUX_ENVIRONMENT_SOURCE
#define LUX_ENVIRONMENT_SOURCE LUX_ENVIRONMENT_LUXCORE
#endif

// This project's environment, along the direction a ray TRAVELS -- the opposite of the
// convention Env_GetRadiance's own parameter follows. See Env_GetRadiance below, which owns
// the one negation between them; getting that sign wrong mirrors the whole environment,
// which looks plausible and is wrong.
//
// Everything here is gem.frag's, called rather than copied: `sampleEnvironment` already
// evaluates every lighting model exactly (hard band edges, no texture filtering -- see
// kb/assessment-models-and-tone-mapping.md), applies the head-shadow cone and the
// environment rotation, scales by uEnvIntensity, and samples the skybox for the image and
// Studio models. It returns LINEAR radiance under every model, which is what this path's
// accumulation buffer must hold.
//
// Which of gem.frag's two rules applies is decided by `gLuxPathHitStone` (host.glsl,
// T-0137), because gem.frag has two and this seam is reached by both kinds of ray. A camera
// ray that hit nothing takes `renderHandWritten`'s primary-miss branch -- flat background
// if enabled, otherwise the environment, and never the window colour. Light that has met
// the stone takes `arrivingLight`'s leak cascade below. Before T-0137 every lookup took the
// cascade, which painted the whole background with the window colour whenever one was
// enabled (kb/luxcore-port-s-window-colour-floods-the-whole-ba.md).
//
// The one rule reproduced here rather than called is the first half of `arrivingLight`'s
// leak test: light arriving from below the lighting horizon shows the separate window
// colour, or the flat background when that is off. gem.frag's own second half -- "or it
// leaves through a facet facing below the horizon" -- needs the exit facet's outward normal,
// and the Env_GetRadiance seam carries only a direction, so it is NOT applied here. That is
// a stated, bounded gap (T-0134), not an approximation dressed up as the rule: every exit
// this branch calls a leak is one gem.frag also calls a leak, and the exits it misses are
// the back-facet ones. `blockedByObserver` (the Gem Cut Studio centre dot) needs the exit
// position as well and is likewise absent.
//
// Picked colours are decoded through `displayToRadiance`, exactly as gem.frag does, so they
// enter the path as radiance and come back out as the colour that was picked. Feeding a
// display colour in raw would show it through the tone map instead; see
// kb/window-and-head-shadow-colours.md.
//
// UNIFORMS THIS BRANCH READS, including the ones it reaches only through gem.frag's own
// functions. Documentation, not a contract: `lux_ignored_uniforms` in src/lib.rs (which
// decides what the page hides per renderer) strips comments and walks the call graph into
// gem.frag, so it finds these for itself and this list cannot make it wrong either way.
// It is here because the call chain is otherwise invisible from this file.
//   toLightingFrame:     uLightingFollowsView, uCameraRight, uCameraForward, uCameraUp
//   sampleEnvironment:   uEnvRotation, uHeadShadowCosine, uHeadShadowColor, uLightingModel,
//                        uEnvIntensity, uEnvironment
//   displayToRadiance:   uToneMapMode, uExposure
//   here:                uUseWindowColor, uWindowColor, uUseBackgroundColor, uBackgroundColor
#ifdef LUX_HAS_GEM_FRAG
vec3 Env_ProjectRadiance(vec3 travelDirection) {
    vec3 direction = toLightingFrame(travelDirection);

    // A camera ray that met nothing at all: gem.frag's own primary-miss branch
    // (renderHandWritten), which is a flat backdrop or the environment and is NEVER the
    // window colour. The leak rules below are about light that interacted with the stone,
    // and this ray did not.                                                        T-0137
    //
    // Without this, the direction test below fires on every camera ray -- +Y of the
    // lighting frame points back towards the viewer, so a ray leaving the eye is "below the
    // lighting horizon" at every pose -- and every background pixel came out as the window
    // colour (kb/luxcore-port-s-window-colour-floods-the-whole-ba.md). gLuxPathHitStone is
    // host.glsl's; read its comment there for why the seam needs it.
    if (!gLuxPathHitStone) {
        if (uUseBackgroundColor != 0) {
            return displayToRadiance(uBackgroundColor);
        }

        return sampleEnvironment(direction);
    }

    if (direction.y < 0.0) {
        if (uUseWindowColor != 0) {
            return displayToRadiance(uWindowColor);
        }

        if (uUseBackgroundColor != 0) {
            return displayToRadiance(uBackgroundColor);
        }
    }

    return sampleEnvironment(direction);
}
#else
// Standalone (tools/glsl_check.sh on this file alone): gem.frag is not there to call, so
// this returns black rather than something plausible, the same choice pathtracer.glsl's
// Scene_Intersect stub makes for the same reason -- a wrongly assembled unit should look
// obviously broken, not subtly wrong.
vec3 Env_ProjectRadiance(vec3 travelDirection) {
    return BLACK;
}
#endif // LUX_HAS_GEM_FRAG

// -----------------------------------------------------------------------------
// ConstantInfiniteLight.
// -----------------------------------------------------------------------------

// constantinfinitelight.cpp:49-79, restructured (see file header RESTRUCTURINGS): the
// `visibilityMapCache` branch (lines 53-69) is dropped -- neither .scn file this project
// ships sets `.visibilitymapcache.enable`, and ConstantInfiniteLight's constructor
// (constantinfinitelight.cpp:32) default-initialises `visibilityMapCache` to nullptr anyway,
// so `visibilityMapCache && ...` is always false for these scenes; ported only the `else`
// arm (lines 70-78). `scene`/`bsdf` parameters dropped (`bsdf` always taken as truthy, see
// RESTRUCTURINGS; `scene`/`envRadius` unused by this arm in the first place -- envRadius is
// only read by the emissionPdfW branch, itself unused by this project's only real caller,
// Env_GetRadiance below, which never asks for emissionPdfW).
vec3 ConstantInfiniteLight_GetRadiance(vec3 dir, out float directPdfA) {
    // constantinfinitelight.cpp:71-72 (bsdf-truthy arm of `directPdfA ? UniformSpherePdf() :
    // 0.f` -- see RESTRUCTURINGS for why `bsdf` is always truthy here).
    directPdfA = UniformSpherePdf();

    // constantinfinitelight.cpp:78. temperatureScale hardcoded to vec3(1.0), see
    // RESTRUCTURINGS. LUX_SKY_GAIN / LUX_SKY_COLOR are this file's host-integration point,
    // see "HOST INTEGRATION POINT" below.
    return vec3(1.0) * LUX_SKY_GAIN * LUX_SKY_COLOR;
}

// constantinfinitelight.cpp:81-108. Dead code (no caller -- see file header); ported in full
// anyway, faithfully, per the ticket's brief. `scene` is replaced by the `worldCenter`/
// `envRadius` this project has no Scene object to compute (InfiniteLightSource::GetEnvRadius,
// light.cpp:96-98, needs `scene.GetSceneBSphere()`, which does not exist here); left as plain
// parameters for whichever future ticket (T-0110, light tracing) would supply them, exactly
// as upstream's own `scene` parameter is threaded down from the caller rather than looked up
// globally. Pointer out-params become GLSL `out` params, per this project's established
// convention (math.glsl, pathtracer.glsl).
vec3 ConstantInfiniteLight_Emit(vec3 worldCenter, float envRadius,
        float u0, float u1, float u2, float u3,
        out vec3 rayOrig, out vec3 rayDir, out float emissionPdfW,
        out float directPdfA, out float cosThetaAtLight) {
    // Compute InfiniteLight ray weight
    emissionPdfW = UniformSpherePdf() / (M_PI_F * envRadius * envRadius);

    directPdfA = UniformSpherePdf();

    // Choose p1 on scene bounding sphere
    vec3 p1 = worldCenter + envRadius * UniformSampleSphere(u0, u1);

    // Choose p2 on scene bounding sphere
    vec3 p2 = worldCenter + envRadius * UniformSampleSphere(u2, u3);

    // Construct ray between p1 and p2
    rayOrig = p1;
    rayDir = normalize(p2 - p1);

    cosThetaAtLight = dot(normalize(worldCenter - p1), rayDir);

    // return GetRadiance(scene, nullptr, ray.d); -- constantinfinitelight.cpp:107. The
    // nullptr bsdf means upstream's own directPdfA output pointer is null at this call site
    // too (the 3-argument GetRadiance overload never touches it), so reusing this file's
    // always-bsdf-truthy ConstantInfiniteLight_GetRadiance and discarding its directPdfA
    // output is equivalent -- see RESTRUCTURINGS.
    float unusedDirectPdfA;
    return ConstantInfiniteLight_GetRadiance(rayDir, unusedDirectPdfA);
}

// -----------------------------------------------------------------------------
// SunLight.
// -----------------------------------------------------------------------------

// Not an upstream type -- SunLightParam (light_types.cl:49-56) is the closest upstream
// analogue (see file header citation) but is a GPU-upload struct, not a C++ type; this is
// this port's equivalent, bundling exactly the fields SunLight_GetRadiance/_Emit read.
// `color` is NOT computed by SunLight_Preprocess below -- see "HOST INTEGRATION POINT".
struct SunLight {
    vec3 absoluteSunDir;
    vec3 x;
    vec3 y;
    float cosThetaMax;
    float sin2ThetaMax;
    vec3 color;
};

// sunlight.cpp:35-54, geometry-only part (see file header "WHAT THE HOST MUST SUPPLY" for
// why the turbidity-dependent `color` computation, sunlight.cpp:56-103, is not here).
// `EnvLightSource::Preprocess()` (sunlight.cpp:36) resolves to
// NotIntersectableLightSource::Preprocess (light.cpp:81-83, temperatureScale only) --
// dropped, see RESTRUCTURINGS; nothing else in the base class chain has a Preprocess body.
void SunLight_Preprocess(vec3 localSunDir, float relSize, out SunLight light) {
    // absoluteSunDir = Normalize(lightToWorld * localSunDir); -- sunlight.cpp:38.
    // lightToWorld assumed identity, see RESTRUCTURINGS.
    light.absoluteSunDir = normalize(localSunDir);
    // CoordinateSystem(absoluteSunDir, &x, &y); -- sunlight.cpp:39.
    CoordinateSystem(light.absoluteSunDir, light.x, light.y);

    // Values from NASA Solar System Exploration page
    // http://solarsystem.nasa.gov/planets/profile.cfm?Object=Sun&Display=Facts&System=Metric
    // sunlight.cpp:41-54.
    float sunRadius = 695500.0;
    float sunMeanDistance = 149600000.0;

    float sunSize = relSize * sunRadius;
    if (sunSize <= sunMeanDistance) {
        light.sin2ThetaMax = sunSize / sunMeanDistance;
        light.sin2ThetaMax *= light.sin2ThetaMax;
        light.cosThetaMax = sqrt(1.0 - light.sin2ThetaMax);
    } else {
        light.cosThetaMax = 0.0;
        light.sin2ThetaMax = 1.0;
    }
}

// sunlight.cpp:213-232, restructured (see file header RESTRUCTURINGS): `scene`/`bsdf`
// parameters dropped (SunLight::GetRadiance never reads `bsdf` even upstream, and `scene` is
// only used by the `emissionPdfW` branch, which Env_GetRadiance below never requests, exactly
// like ConstantInfiniteLight_GetRadiance above). This is THE function that produces the
// image -- see the file header's "THE ONE THING THAT MUST BE EXACTLY RIGHT".
vec3 SunLight_GetRadiance(SunLight light, vec3 dir, out float directPdfA) {
    float xD = dot(-dir, light.x);
    float yD = dot(-dir, light.y);
    float zD = dot(-dir, light.absoluteSunDir);
    if ((light.cosThetaMax == 1.0) || (zD < 0.0) || ((xD * xD + yD * yD) > light.sin2ThetaMax))
        return BLACK; // Spectrum() -- sunlight.cpp:220, a default-constructed (black) Spectrum.

    float uniformConePdf = UniformConePdf(light.cosThetaMax);
    directPdfA = uniformConePdf;

    return light.color;
}

// sunlight.cpp:150-176. Dead code (no caller -- see file header); ported in full anyway,
// faithfully, per the ticket's brief. `worldCenter`/`envRadius` are plain parameters, exactly
// as ConstantInfiniteLight_Emit above (same reasoning: no Scene object here to look them up
// from, and no caller to supply them either, since T-0110 -- light tracing -- is cut).
vec3 SunLight_Emit(SunLight light, vec3 worldCenter, float envRadius,
        float u0, float u1, float u2, float u3,
        out vec3 rayOrig, out vec3 rayDir, out float emissionPdfW,
        out float directPdfA, out float cosThetaAtLight) {
    // Set ray origin and direction for infinite light ray
    float d1, d2;
    ConcentricSampleDisk(u0, u1, d1, d2);
    rayOrig = worldCenter + envRadius * (light.absoluteSunDir + d1 * light.x + d2 * light.y);
    rayDir = -UniformSampleCone(u2, u3, light.cosThetaMax, light.x, light.y, light.absoluteSunDir);

    float uniformConePdf = UniformConePdf(light.cosThetaMax);
    emissionPdfW = uniformConePdf / (M_PI_F * envRadius * envRadius);

    directPdfA = uniformConePdf;

    cosThetaAtLight = dot(light.absoluteSunDir, -rayDir);

    return light.color;
}

// -----------------------------------------------------------------------------
// Env_GetRadiance / Env_GetLightPickPdf -- the real implementations of
// src/shaders/lux/pathtracer.glsl's two stub interfaces (T-0109). pathtracer.glsl's stub
// bodies are removed by this ticket's one permitted edit to that file; only their forward
// declarations remain there so PathTracer_DirectHitInfiniteLight (defined earlier in that
// file) still compiles against the definitions below (concatenated after it -- see
// tools/glsl_check.sh's fixed file order, math -> glass -> sampler -> pathtracer -> lights;
// GLSL, like C, allows a call before a definition only once a matching prototype has been
// seen, confirmed against glslangValidator for this exact shape before writing this file).
// -----------------------------------------------------------------------------

// pathtracer.cpp:320-335 (DirectHitInfiniteLight's loop over GetEnvLightSources()),
// restructured into a single call -- see file header RESTRUCTURINGS "Multiple environment
// lights, collapsed". `direction` follows the same convention pathtracer.glsl's stub already
// documented: pass `-rayDirection`, matching upstream's `-ray.d`.
vec3 Env_GetRadiance(vec3 direction, out float directPdfW) {
    // T-0127. `direction` is upstream's `-ray.d`: it points from the environment back at the
    // shading point, which is the convention SunLight_GetRadiance below relies on (it tests
    // `-dir` against `absoluteSunDir`, and `scene.lights.<n>.dir` points AT the sun). Every
    // one of gem.frag's own environment entry points takes the opposite convention -- the
    // direction light TRAVELS, which is what `arrivingLight(position, exitDirection, ...)`
    // and `sampleEnvironment(toLightingFrame(rayDirection))` are both handed -- so the
    // negation here is the whole of the impedance match between them. Without it the
    // environment is mirrored through the origin: a skybox upside down and back to front,
    // and every assessment model reading its own antipode, which looks plausible on a
    // faceted stone and is wrong.
    if (LUX_ENVIRONMENT_SOURCE == LUX_ENVIRONMENT_PROJECT) {
        // Honest, and deliberately not load-bearing. The project's environments have no
        // sampling distribution at all -- nothing here ever builds one, because a polished
        // gem is never lit by direct light sampling (GlassMaterial::IsDelta() is
        // unconditionally true; see this file's header), so the only branch that reads this
        // value cannot run. The uniform-sphere pdf is the pdf of the only strategy that
        // could exist for an arbitrary radiance distribution with no importance map, and it
        // is exactly what ConstantInfiniteLight_GetRadiance returns for the same reason.
        directPdfW = UniformSpherePdf();

        return Env_ProjectRadiance(-direction);
    }

    vec3 radiance = BLACK;

    float skyDirectPdfA;
    radiance += ConstantInfiniteLight_GetRadiance(direction, skyDirectPdfA);
    directPdfW = skyDirectPdfA;

    for (int i = 0; i < LUX_ENV_SUN_COUNT; ++i) {
        SunLight sun;
        SunLight_Preprocess(LUX_ENV_SUN_DIR[i], LUX_ENV_SUN_RELSIZE, sun);
        sun.color = LUX_ENV_SUN_COLOR[i];

        float sunDirectPdfA;
        vec3 sunRadiance = SunLight_GetRadiance(sun, direction, sunDirectPdfA);
        if (!Spectrum_IsBlack(sunRadiance)) {
            radiance += sunRadiance;
            // Last-contributor-wins; see file header RESTRUCTURINGS for why this is a safe,
            // arbitrary choice rather than a real semantic decision.
            directPdfW = sunDirectPdfA;
        }
    }

    return radiance;
}

// Stands in for `scene.GetLightSources().GetIlluminateLightStrategy().SampleLightPdf(...)`
// (pathtracer.cpp:338-339). See file header CUTS (T-0117): a real LightStrategy port needs
// LightSource::GetPower (not ported, see file header) and a full scene light enumeration
// this project never builds. 1.0 is exact for the only case that can ever read it live: this
// value is multiplied into `directPdfW * lightPickProb` only inside
// `!(pathInfo.lastBSDFEvent & SPECULAR)` (pathtracer.glsl:573), which pathtracer.glsl's own
// file header already proves is unconditionally false for GlassMaterial (SPECULAR is always
// set, from before the first bounce onward). If a future non-delta material ever makes that
// branch live, this needs a real light-picking probability (1 / (1 + LUX_ENV_SUN_COUNT) for
// a uniform strategy over "sky" plus each configured sun as separate pickable lights would
// be the straightforward faithful next step, matching LightStrategyUniform's shape without
// its power-weighting) -- not before, per this ticket's own "port a bug faithfully, don't
// pre-fix it" instruction applied to dead code instead of a bug.
float Env_GetLightPickPdf() {
    return 1.0;
}

#endif // LUX_LIGHTS_GLSL
