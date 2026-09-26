// -----------------------------------------------------------------------------
// Glass BSDF, ported from LuxCoreRender (https://github.com/LuxCoreRender/LuxCore),
// commit e9ced7e ("Fix log format regression", 2026-09-11).
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
// Ported from (see kb/clean-room-and-licensing-constraints.md for why LuxCore, and only
// LuxCore, is fair game to read and port -- it is Apache-2.0, and the user directed this port):
//   reference/LuxCore/include/slg/materials/materialdefs_funcs_glass.cl
//   reference/LuxCore/include/slg/materials/materialdefs_funcs_generic.cl  (FrDiel2,
//       FresnelCauchy_Evaluate)
//   reference/LuxCore/include/slg/bsdf/bsdfevents.h  (the BSDFEvent flag values)
//   reference/LuxCore/include/luxrays/core/color/color_funcs.cl  (Spectrum_IsBlack/Clamp/Filter)
//   reference/LuxCore/include/luxrays/core/color/color_types.cl  (WHITE/BLACK)
//   reference/LuxCore/include/luxrays/devices/ocldevice_funcs.cl  (MAKE_FLOAT3)
// This file calls, but does not itself define, CosTheta and SinTheta2 (upstream:
// luxrays/core/utils_funcs.cl:101-107) and GlassMaterial_WaveLength2RGB (upstream:
// materialdefs_funcs_glass.cl:62-106): the T-0096 ticket named
// reference/LuxCore/include/slg/bsdf/bsdfutils_funcs.cl as the expected source for the first
// two, but that file turned out to hold only BSDF-struct accessors on the eval-stack's
// __global BSDF*, nothing this material's maths needs. All three are ported instead by
// src/shaders/lux/math.glsl (T-0095, landed alongside this file and confirmed by reading it),
// which already owns the whole of utils_funcs.cl plus this one glass-specific function it
// hoists out as a shared spectral helper. See the forward declarations below for the full
// reasoning and exact math.glsl line numbers.
// Cross-read reference/LuxCore/src/slg/materials/glass.cpp throughout: a previous agent
// verified GlassMaterial::Sample there and GlassMaterial_Sample in the .cl have identical
// bodies, comments and all, so the C++ served as a free second opinion whenever the OpenCL
// was hard to read. This file was ported from the .cl, per that same convention.
//
// -----------------------------------------------------------------------------
// STRUCTURAL DEPARTURE FROM UPSTREAM, AUTHORISED BY THE T-0096 TICKET (the only one taken):
//
// The .cl materials are dispatched through an eval-stack virtual machine --
// EvalStack_PopFloat3/PushFloat3, GlassMaterial_EvalOp, __global const Material* parameter
// blocks threaded through every call via the MATERIALS_PARAM_DECL macro chain, and texture
// indices resolved through Texture_GetSpectrumValue/Texture_GetFloatValue. All of that exists
// because OpenCL has no virtual dispatch and LuxCore supports arbitrary user-authored material
// graphs. This project has exactly one hard-coded glass material, so:
//   - every function below takes plain float/vec3 arguments instead of popping an eval stack
//     or indexing through a Material/HitPoint struct;
//   - GlassMaterial_Sample takes kr, kt, nc, nt, cauchyB, localFilmThickness and localFilmIor
//     directly as arguments, standing in for the texture lookups and ExtractExteriorIors /
//     ExtractInteriorIors calls upstream used to resolve them (see the T-0101 cut ticket);
//   - GlassMaterial_Albedo, _GetInteriorVolume, _GetExteriorVolume,
//     _GetPassThroughTransparency, _GetEmittedRadiance and _EvalOp were not ported at all --
//     they are AOV/volume/dispatch plumbing this single opaque, non-emissive gemstone material
//     never exercises (see the T-0102 cut ticket);
//   - GlassMaterial_Sample returns bool (true = a sample was produced) instead of an implicit
//     "push NONE and return" through the eval stack, since there is no stack left to push onto.
// Everything else -- function bodies, local variable names, expression order, comments,
// upstream bugs -- is a literal transliteration. See
// kb/luxcore-glass-bsdf-port-eval-stack-stripping-and.md for the durable version of this note.
// -----------------------------------------------------------------------------
// BEHAVIOURAL DEPARTURE FROM UPSTREAM: ONE WAVELENGTH PER PATH (T-0092, the user, 2026-09-25).
//
// Upstream draws a fresh wavelength from each transmission's own u0, and evaluates reflection
// at the undispersed `nt` (Cauchy's A, below every visible wavelength's index). Two upstream-
// acknowledged bugs follow, and this port used to reproduce both:
//   - a ray refracts into the stone at one wavelength and out at an unrelated one, so entry and
//     exit dispersion no longer add up, and the saturated WaveLength2RGB tints of the two
//     events multiply (LuxCore issue #262, diagnosed by CodeFHD 2020-12-13: "the only
//     solution ... would be to make the wavelength fixed per sample");
//   - between the critical angles of A and of the sampled index, transmission reports total
//     internal reflection while reflection reports R < 1, and the difference is lost. Trapped
//     paths cross that band on every bounce, so they drain to black, blue fastest (A = IOR
//     came in with f8e1f16b, issue #47; neo2068's objection to it there was never answered).
// Measured on Hanabi (index 2.85, dispersion 0.28): 11% of the stone below 25/255 and a brown
// cast before; 0.8% after, at 32 bounces.
//
// So an eye path now carries one wavelength, gLuxPathWaveLength (host.glsl, drawn once per
// camera sample by entry.glsl); GlassMaterial_Sample evaluates BOTH Fresnel terms at that
// wavelength's index, and folds its WaveLength2RGB tint into the throughput once, at the
// path's first transmission (gLuxPathTinted). Reflections before any transmission stay
// untinted: their direction does not depend on the wavelength, only their strength does, and
// tinting them would turn the crown's glare into colour noise for the sake of a correlation
// between R(lambda) and the tint that is a fraction of a percent. See
// kb/luxcore-glass-bsdf-port-eval-stack-stripping-and.md.
// -----------------------------------------------------------------------------

#ifndef LUX_GLASS_GLSL
#define LUX_GLASS_GLSL

// --- shared helpers this file needs that neither the prelude nor (yet) math.glsl provide ----
// Per the T-0096 brief: helpers a ported file needs but the prelude lacks are defined here,
// wrapped in #ifndef, rather than added to prelude.glsl (owned by another file) so two ported
// files can be concatenated without a duplicate-definition error.

#ifndef WHITE
// luxrays/core/color/color_types.cl:23
#define WHITE vec3(1.0, 1.0, 1.0)
#endif
#ifndef BLACK
// luxrays/core/color/color_types.cl:22
#define BLACK vec3(0.0, 0.0, 0.0)
#endif
#ifndef MAKE_FLOAT3
// luxrays/devices/ocldevice_funcs.cl:30
#define MAKE_FLOAT3(x, y, z) vec3(x, y, z)
#endif

#ifndef LUX_SPECTRUM_HELPERS_GLSL
#define LUX_SPECTRUM_HELPERS_GLSL
// Spectrum_IsEqual / Spectrum_IsBlack / Spectrum_Filter / Spectrum_Clamp --
// luxrays/core/color/color_funcs.cl:21-51. Only the four glass.glsl actually calls are ported;
// Spectrum_IsNan/IsInf/Y/Exp/Pow are not needed by a delta glass BSDF.
bool Spectrum_IsEqual(vec3 a, vec3 b) {
    return a == b;
}

bool Spectrum_IsBlack(vec3 a) {
    return Spectrum_IsEqual(a, BLACK);
}

float Spectrum_Filter(vec3 s) {
    return (s.x + s.y + s.z) * 0.33333333;
}

vec3 Spectrum_Clamp(vec3 s) {
    return clamp(s, BLACK, WHITE);
}
#endif // LUX_SPECTRUM_HELPERS_GLSL

#ifndef LUX_BSDFEVENTS_GLSL
#define LUX_BSDFEVENTS_GLSL
// include/slg/bsdf/bsdfevents.h:24-38. Only the flags GlassMaterial_Sample/_Evaluate actually
// use are ported (DIFFUSE, GLOSSY and the ALL_* composites are dropped: a delta glass BSDF is
// never diffuse or glossy, so porting them would just be unused names risking collision with a
// sibling shader file). Named and valued exactly as upstream so `event = SPECULAR | REFLECT;`
// below reads identically to the .cl/.cpp it was copied from. Guarded like a C header so a
// sibling ported file that needs the same flags can reuse this block instead of colliding with
// it, the same trick prelude.glsl's own LUX_PRELUDE_GLSL guard relies on.
#define BSDFEvent int
const int NONE = 0;
const int SPECULAR = 4;
const int REFLECT = 8;
const int TRANSMIT = 16;
#endif // LUX_BSDFEVENTS_GLSL

// Forward declarations for three helpers this file calls but does not define:
//
//   - CosTheta / SinTheta2 (luxrays/core/utils_funcs.cl:101-107) are ported by
//     src/shaders/lux/math.glsl (confirmed by reading it: math.glsl:132-139), which also owns
//     the rest of utils_funcs.cl (SinTheta, CosPhi, SinPhi, ...). This file originally carried
//     its own copies -- utils_funcs.cl is not one of the four files the T-0096 ticket named, so
//     it looked like this file's job -- but math.glsl already defines both, unguarded, so
//     porting them here too would be a straight duplicate-definition error once the two files
//     are concatenated. Declared, not defined, here; math.glsl supplies the bodies.
//   - GlassMaterial_WaveLength2RGB (materialdefs_funcs_glass.cl:62-106) is likewise ported by
//     math.glsl (math.glsl:336), under its full upstream name -- NOT hoisted to a bare
//     `WaveLength2RGB` as the T-0096 brief anticipated; confirmed by reading math.glsl, and
//     called by that real name here instead.
//
// CalcFilmColor is not provided anywhere else; it is permanently stubbed at the bottom of this
// file (see the COMPILE-ONLY STUBS block and the T-0103 cut ticket).
//
// Declaring all three prototypes up front lets the functions below call them ahead of whatever
// order math.glsl and glass.glsl end up concatenated in, the same way a C header would.
// `const` on these three value parameters is not cosmetic: GLSL ES treats a declaration and its
// definition as different overloads if their parameter qualifiers disagree, so these must match
// math.glsl's real signatures (math.glsl:132,137,336, all `const`-qualified) exactly, whichever
// file the concatenation puts first.
float CosTheta(const vec3 v);
float SinTheta2(const vec3 w);
vec3 GlassMaterial_WaveLength2RGB(const float waveLength);
vec3 CalcFilmColor(vec3 localFixedDir, float localFilmThickness, float localFilmIor);

// The eye path's wavelength and whether its tint is in the throughput yet (T-0092): shader
// globals owned by host.glsl, which is concatenated before this file. Stand-ins here only
// when glass.glsl is compiled standalone (tools/glsl_check.sh), where host.glsl is absent.
#ifndef LUX_HOST_GLSL
float gLuxPathWaveLength = 580.0;
bool gLuxPathTinted = false;
#endif

// --- FrDiel2 / FresnelCauchy_Evaluate ---------------------------------------------------------
// materialdefs_funcs_generic.cl:285-337. Full Fresnel dielectric equations, not Schlick's
// approximation -- the same choice this project's own deterministic shader already made
// (kb/optics-and-shader-conventions.md), so this part of the port is a rename, not a rewrite.

// FrDiel2 -- materialdefs_funcs_generic.cl:285-292
float FrDiel2(float cosi, float cost, float eta) {
    float Rparl = eta * cosi;
    Rparl = (cost - Rparl) / (cost + Rparl);
    float Rperp = eta * cost;
    Rperp = (cosi - Rperp) / (cosi + Rperp);

    return (Rparl * Rparl + Rperp * Rperp) * 0.5;
}

// FresnelCauchy_Evaluate -- materialdefs_funcs_generic.cl:323-337
float FresnelCauchy_Evaluate(float eta, float cosi) {
    // Compute indices of refraction for dielectric
    bool entering = (cosi > 0.0);

    // Compute _sint_ using Snell's law
    float eta2 = eta * eta;
    float sint2 = (entering ? 1.0 / eta2 : eta2) *
        fmax(0.0, 1.0 - cosi * cosi);
    // Handle total internal reflection
    if (sint2 >= 1.0)
        return 1.0;
    else
        return FrDiel2(fabs(cosi), sqrt(fmax(0.0, 1.0 - sint2)),
            entering ? eta : 1.0 / eta);
}

// --- GlassMaterial_WaveLength2IOR -------------------------------------------------------------
// materialdefs_funcs_glass.cl:108-126, identical to WaveLength2IOR in glass.cpp:103-121.
//
// interiorior IS CAUCHY'S "A", NOT AN INDEX OF REFRACTION AT ANY WAVELENGTH. LuxCore evaluates
// n(lambda) = A + B / lambda_um^2 and feeds the material's interiorior straight in as A: the
// line that would convert a measured d-line index into A is commented out below, exactly as
// upstream left it commented rather than deleted. A gemmological index has to be converted
// before it reaches this material (cubic zirconia n=2.16, dispersion 0.060 -> A=2.10712553,
// B=0.0183619549). See kb/luxcore-as-a-reference-oracle.md.
float GlassMaterial_WaveLength2IOR(float waveLength, float IOR, float B) {
    // Cauchy's equation for relationship between the refractive index and wavelength
    // note: Cauchy's lambda is expressed in micrometers while waveLength is in nanometers

    // This is the formula suggested by Neo here, with a changed naming convention from B->A and C-> B:
    // https://github.com/LuxCoreRender/BlendLuxCore/commit/d3fed046ab62e18226e410b42a16ca1bccefb530#commitcomment-26617643

    // Compute Cauchy-A assuming the user input IOR at 587.56 nm
    // (Fraunhofer d-line, Helium, used in one definition of the Abbe number)
    //const float A = IOR - B / Sqr(587.56 / 1000.0);

    // Use the user input IOR directly as Cauchy-A. Equivalent to the B used by old LuxRender.
    float A = IOR;

    // Cauchy's equation
    float cauchyEq = A + B / Sqr(waveLength / 1000.0);

    return cauchyEq;
}

// --- GlassMaterial_EvalSpecularReflection -----------------------------------------------------
// materialdefs_funcs_glass.cl:128-146, identical to EvalSpecularReflection in glass.cpp:123-142.
// The `hitPoint` parameter upstream took is dropped: every material's EvalSpecularReflection
// shares that parameter only so the eval-stack dispatcher can call them uniformly, and this
// body never dereferences it.
vec3 GlassMaterial_EvalSpecularReflection(vec3 localFixedDir, vec3 kr,
        float nc, float nt,
        out vec3 sampledDir, float localFilmThickness, float localFilmIor) {
    if (Spectrum_IsBlack(kr))
        return BLACK;

    float costheta = CosTheta(localFixedDir);
    sampledDir = MAKE_FLOAT3(-localFixedDir.x, -localFixedDir.y, localFixedDir.z);

    float ntc = nt / nc;
    vec3 result = kr * FresnelCauchy_Evaluate(ntc, costheta);

    if (localFilmThickness > 0.0) {
        vec3 filmColor = CalcFilmColor(localFixedDir, localFilmThickness, localFilmIor);
        return result * filmColor;
    }
    return result;
}

// --- GlassMaterial_EvalSpecularTransmission ---------------------------------------------------
// materialdefs_funcs_glass.cl:148-194. The .cpp (glass.cpp:144-190) still branches live on
// `hitPoint.fromLight` (light tracing only, never true for an eye-path renderer like this one);
// the .cl already has that branch commented out and always takes the `!fromLight` arm, so this
// is a port of the .cl's already-simplified form -- the dead branch is kept below only as the
// comment upstream left it, and `hitPoint` (needed solely by that dead branch) is dropped.
//
// T-0092 DEPARTURE (see the file header). Upstream took u0 and cauchyB here, drew its own
// wavelength (`mix(380.0, 780.0, u0)`), and tinted `lkt` by it. GlassMaterial_Sample now does
// both once for the whole path, and passes in `lnt`, the index at the path's wavelength (or the
// undispersed index when cauchyB is 0), the same index it hands EvalSpecularReflection. The
// wavelength tint is applied by the caller, so `lkt` is just `kt`. The rest is upstream's body.
vec3 GlassMaterial_EvalSpecularTransmission(vec3 localFixedDir,
        vec3 kt, float nc, float lnt,
        out vec3 sampledDir) {
    if (Spectrum_IsBlack(kt))
        return BLACK;

    // Compute transmitted ray direction
    vec3 lkt = kt;

    float ntc = lnt / nc;
    float costheta = CosTheta(localFixedDir);
    bool entering = (costheta > 0.0);
    float eta = entering ? (nc / lnt) : ntc;
    float eta2 = eta * eta;
    float sini2 = SinTheta2(localFixedDir);
    float sint2 = eta2 * sini2;

    // Handle total internal reflection for transmission
    if (sint2 >= 1.0)
        return BLACK;

    float cost = sqrt(fmax(0.0, 1.0 - sint2)) * (entering ? -1.0 : 1.0);
    sampledDir = MAKE_FLOAT3(-eta * localFixedDir.x, -eta * localFixedDir.y, cost);

    float ce;
//	if (!hitPoint.fromLight)
        ce = (1.0 - FresnelCauchy_Evaluate(ntc, cost)) * eta2;
//	else {
//		const float absCosSampledDir = fabsf(CosTheta(*sampledDir));
//		ce = (1.f - FresnelTexture::CauchyEvaluate(ntc, costheta)) * fabsf(localFixedDir.z / absCosSampledDir);
//	}

    return lkt * ce;
}

// --- GlassMaterial_Evaluate --------------------------------------------------------------------
// materialdefs_funcs_glass.cl:196-205, identical in effect to GlassMaterial::Evaluate in
// glass.cpp:41-45 (`return Spectrum();`). A specular (delta) BSDF has zero probability of any
// given (lightDir, eyeDir) pair actually landing on it, so direct light sampling can never call
// this productively -- see GlassMaterial::Pdf in glass.cpp:259-266, always 0 for both
// directions. There is no GlassMaterial_Pdf in the .cl: the eval-stack dispatcher special-cases
// delta materials generically (BSDF_IsDelta) instead of asking each material, so nothing here
// corresponds to it (see the T-0102 cut ticket). lightDir/eyeDir are accepted, matching the
// upstream signature, and unused, matching the upstream body.
vec3 GlassMaterial_Evaluate(vec3 lightDir, vec3 eyeDir, out BSDFEvent event) {
    event = NONE;
    return BLACK;
}

// --- GlassMaterial_Sample ----------------------------------------------------------------------
// materialdefs_funcs_glass.cl:207-293, identical to GlassMaterial::Sample in glass.cpp:192-257.
//
// Eval-stack stripped (see the file header and the T-0096/T-0101 tickets): the four
// EvalStack_Pop* calls that pulled fixedDir/u0/u1/passThroughEvent off the interpreter stack
// become plain arguments, and the texture lookups that resolved kt/kr/nc/nt/cauchyB/
// localFilmThickness/localFilmIor become plain arguments too.
//
// Upstream signals "no valid sample" (both refl and trans black) by executing
// MATERIAL_SAMPLE_RETURN_BLACK, which pushes event=NONE onto the eval stack and returns from
// the void function; there is no stack left to push onto, so this returns bool instead --
// false exactly where upstream would have pushed NONE, and the caller must check the return
// value (equivalently, event != NONE) before reading the other out-parameters.
//
// T-0092 DEPARTURE (see the file header): the wavelength is the path's, not drawn from u0,
// which is therefore unused here. It stays in the signature because it is the draw upstream
// makes at every vertex, and the sampler's dimension layout (pathtracer.glsl) depends on it
// being made. Reflection and transmission both see `lnt`; the tint joins `trans` only until
// the path's first transmission has taken it.
bool GlassMaterial_Sample(
        vec3 fixedDir, float u0, float u1, float passThroughEvent,
        vec3 kr, vec3 kt, float nc, float nt, float cauchyB,
        float localFilmThickness, float localFilmIor,
        out vec3 sampledDir, out float pdfW, out BSDFEvent event, out vec3 result) {
    float lnt = nt;
    vec3 waveLengthTint = WHITE;
    if (cauchyB > 0.0) {
        lnt = GlassMaterial_WaveLength2IOR(gLuxPathWaveLength, nt, cauchyB);
        if (!gLuxPathTinted)
            waveLengthTint = GlassMaterial_WaveLength2RGB(gLuxPathWaveLength);
    }

    vec3 transLocalSampledDir;
    vec3 trans = waveLengthTint * GlassMaterial_EvalSpecularTransmission(fixedDir,
            kt, nc, lnt, transLocalSampledDir);

    vec3 reflLocalSampledDir;
    vec3 refl = GlassMaterial_EvalSpecularReflection(fixedDir,
            kr, nc, lnt, reflLocalSampledDir, localFilmThickness, localFilmIor);

    // Decide to transmit or reflect
    float threshold;
    if (!Spectrum_IsBlack(refl)) {
        if (!Spectrum_IsBlack(trans)) {
            // Importance sampling
            float reflFilter = Spectrum_Filter(refl);
            float transFilter = Spectrum_Filter(trans);
            threshold = transFilter / (reflFilter + transFilter);

            // A place an upper and lower limit to not under sample
            // reflection or transmission
            threshold = clamp(threshold, 0.25, 0.75);
        } else
            threshold = 0.0;
    } else {
        if (!Spectrum_IsBlack(trans))
            threshold = 1.0;
        else {
            event = NONE;
            return false;
        }
    }

    if (passThroughEvent < threshold) {
        // Transmit

        sampledDir = transLocalSampledDir;

        event = SPECULAR | TRANSMIT;
        pdfW = threshold;

        result = trans;

        // T-0092: `trans` carried the wavelength tint if the path had not taken it yet.
        if (cauchyB > 0.0)
            gLuxPathTinted = true;
    } else {
        // Reflect

        sampledDir = reflLocalSampledDir;

        event = SPECULAR | REFLECT;
        pdfW = 1.0 - threshold;

        result = refl;
    }

    result /= pdfW;
    return true;
}

// -----------------------------------------------------------------------------
// COMPILE-ONLY STUBS -- not ported code, and not to be merged with a real definition.
//
// This block exists solely so glass.glsl can be compile-checked standalone (see the T-0096
// ticket's glslangValidator command / tools/glsl_check.sh). Each stub is guarded so a real
// definition landing alongside it wins instead of colliding:
//   - CosTheta, SinTheta2, GlassMaterial_WaveLength2RGB: guarded by `#ifndef LUX_MATH_GLSL`,
//     confirmed (by reading src/shaders/lux/math.glsl, T-0095, landed alongside this file) to
//     be its real header guard, under which it defines all three for real. REQUIRES
//     math.glsl to be concatenated BEFORE glass.glsl -- see the note below the #ifndef for why
//     this is not made order-independent. Checked both orders (T-0096 ticket log): math-then-
//     glass compiles clean; glass-then-math fails loudly with a duplicate-definition error,
//     which is the correct, documented, integration-owns-this-not-me answer for the wrong order.
//   - CalcFilmColor: no real port is planned under T-0096 (see the T-0103 cut ticket for thin-
//     film coating); guarded by a speculative LUX_THINFILM_GLSL so a future thin-film port can
//     use that same guard name to suppress this stub.
// -----------------------------------------------------------------------------

#ifndef LUX_MATH_GLSL
// Deliberately does NOT `#define LUX_MATH_GLSL` here: doing so would let this stub block
// silently win a "glass.glsl before math.glsl" concatenation by claiming math.glsl's own guard,
// which would then skip math.glsl's ENTIRE real content (Frame_*, CosineSampleHemisphere,
// PowerHeuristic, ...) wherever it is concatenated relative to this stub -- a much worse,
// silent failure than the loud duplicate-definition error this file's REQUIRED integration
// order avoids. This stub only compiles correctly when math.glsl is concatenated BEFORE
// glass.glsl (the natural order: glass.glsl is a material built on math.glsl's primitives, not
// the reverse); checked both orders, see the T-0096 ticket log for the exact commands.
// Stand-ins for math.glsl's CosTheta, SinTheta2 (utils_funcs.cl:101-107) and
// GlassMaterial_WaveLength2RGB (materialdefs_funcs_glass.cl:62-106, a saturated
// visible-spectrum-to-RGB curve). Deliberately wrong (CosTheta/SinTheta2 return 0, WaveLength2RGB
// returns white for every wavelength) -- these must never be mistaken for the real thing.
float CosTheta(const vec3 v) { return 0.0; }
float SinTheta2(const vec3 w) { return 0.0; }
vec3 GlassMaterial_WaveLength2RGB(const float waveLength) { return WHITE; }
#endif

#ifndef LUX_THINFILM_GLSL
// Stand-in for CalcFilmColor (materials/thinfilmcoating.cl, thin-film interference colour).
// Out of scope for T-0096 -- see the T-0103 cut ticket. This material never sets a film
// thickness texture, so GlassMaterial_EvalSpecularReflection's film branch is dead in practice;
// this stub exists only so that branch still compiles. Deliberately wrong (returns white).
vec3 CalcFilmColor(vec3 localFixedDir, float localFilmThickness, float localFilmIor) { return WHITE; }
#endif

#endif // LUX_GLASS_GLSL
