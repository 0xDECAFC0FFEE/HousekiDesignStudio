// -----------------------------------------------------------------------------
// Rough glass BSDF for frosted facets: a GGX rough dielectric sampled from the distribution
// of visible normals, in the slot of LuxCoreRender's RoughGlass material
// (https://github.com/LuxCoreRender/LuxCore, reference/LuxCore commit e9ced7e).   T-0183, T-0269
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
// HISTORY. T-0183 (2026-09-23) ported LuxCore's RoughGlassMaterial_Evaluate/_Sample and its
// Schlick microfacet helpers into this file from
//   reference/LuxCore/include/slg/materials/materialdefs_funcs_roughglass.cl
//   reference/LuxCore/include/slg/materials/materialdefs_funcs_generic.cl:126-198
//   reference/LuxCore/include/luxrays/core/epsilon_types.cl:31  DEFAULT_COS_EPSILON_STATIC
//   reference/LuxCore/include/slg/materials/roughglass.h:41     GetEventTypes
// T-0269 (2026-09-28, the user: "lets use ggx for luxcore frosted facets") REPLACED THE
// MICROFACET MODEL AND ITS SAMPLING. This is a deliberate divergence from the LuxCore port.
// Still LuxCore's: the entry points' names, arguments and return conventions (so
// pathtracer.glsl's BSDF_* dispatch is unchanged), the event types, the kr/kt/nc/nt/film
// parameters, the uroughness/vroughness inputs and their clamp, the DEFAULT_COS_EPSILON_STATIC
// guard, the Fresnel term (glass.glsl's FresnelCauchy_Evaluate), and the eye-path
// (!fromLight) convention that Sample's `result` is f * |cos| / pdf. New, and written from the
// papers below and from nothing else (no other renderer's source was read;
// kb/clean-room-and-licensing-constraints.md):
//   [W07]  B. Walter, S. R. Marschner, H. Li, K. E. Torrance, "Microfacet Models for Refraction
//          through Rough Surfaces", EGSR 2007: the GGX distribution D (eq. 33), Smith's
//          separable shadowing-masking G = G1(i) G1(o) with the GGX G1 (eqs. 23, 34), the
//          rough-dielectric BRDF and BTDF (eqs. 20, 21), the half vectors (eqs. 13, 16) and the
//          Jacobians of the half-vector-to-direction maps (eqs. 14, 17).
//   [HD14] E. Heitz, E. d'Eon, "Importance Sampling Microfacet-Based BSDFs using the
//          Distribution of Visible Normals", EGSR 2014: draw the microfacet normal m from the
//          normals VISIBLE from the fixed direction wo, D_wo(m) = G1(wo, m) <wo, m> D(m) / cos(wo)
//          (their eq. 2), so that the sample weight f |cos| / pdf reduces to Fresnel and the
//          shadowing of the sampled direction alone, which is at most 1.
//   [H18]  E. Heitz, "Sampling the GGX Distribution of Visible Normals", JCGT 7(4), 2018: an
//          exact closed-form sampler of [HD14]'s D_wo for GGX (stretch, sample a projected
//          disk, unstretch). Used instead of [HD14]'s own appendix sampler, whose second slope
//          is a fitted rational approximation: an approximate sampler would make Sample's pdf
//          and Evaluate's pdf differ slightly, and the MIS blend of light sampling and BSDF
//          sampling relies on them being equal.
//
// WHY (kb/luxcore-roughglass-port-and-frosted-facets.md). The Schlick port sampled m in
// proportion to D(m) cos(theta_m), blind to the direction the surface is seen from. Its sample
// weight was G |wo.m| / (|cos wo| cos(theta_m)), up to about 1/r = 25 near grazing, times 2 for
// the 50/50 reflect/transmit choice and eta^2 on the way out, and a frosted stone stayed
// visibly grainy at 2048 passes. Here m is drawn from the visible normals and reflection is
// chosen with probability F, so the weight is G1(wi, m) for a reflection and
// eta^2 G1(wi, m) for a transmission: at most 1, or eta^2 where radiance crosses from the
// denser medium into the thinner one (the same factor GlassMaterial's polished transmission
// carries).
//
// WHAT IT IS, AND WHAT THE USER'S DECISIONS SAY (kb/user-decisions-and-preferences.md, the
// Frosted rows of 2026-09-23 and 2026-09-28): a rough dielectric surface. Reflection and
// refraction happen off one microfacet (Walter's model has no multiple scattering), and since
// T-0271 the energy that a real rough surface would bounce between microfacets before
// leaving, and that single scattering loses, is put back by the compensation below. Only the
// Monte Carlo renderer draws it.
//
// MULTIPLE-SCATTERING ENERGY COMPENSATION (T-0271, 2026-09-28; the user: "add T-0271"). A
// second deliberate divergence from LuxCore, whose roughglass has none. With every facet of a
// stone frosted, single scattering read 0.339 (CZ) and 0.328 (diamond, tilted) in a white
// furnace instead of 0.5: GGX's steep microfacets reflect or refract 1-16% of the light into
// the surface itself at each interaction, the model drops it, and a stone traps light for many
// interactions. Written from these papers only (no other renderer's source was read):
//   [T19]  E. Turquin, "Practical multiple scattering compensation for microfacet models",
//          Industrial Light & Magic technical report, 2019, section 3.2, eq. 18: divide the
//          whole single-scattering dielectric BSDF, reflection and transmission together, by
//          its directional albedo E_ss(wo) = E_R(wo) + E_T(wo), tabulated per kind of
//          interface (outside in, inside out) with the index as an extra dimension.
//   [KC17] C. Kulla, A. Conty, "Revisiting Physically Based Shading at Imageworks", SIGGRAPH
//          2017 course notes: the albedo tables per interface, and the reciprocal alternative
//          not taken here.
// Why [T19] and not [KC17]: [KC17] adds a separate, diffuse-looking lobe, which is reciprocal
// but changes the shape of the frost (Heitz et al. 2016 found the multiply scattered light to
// look like the single-scattering lobe, which [T19] keeps) and cannot be sampled exactly
// (its mixture's pdf would have to be carried through Sample and Evaluate). [T19] scales the
// lobe by a factor of the eye direction alone, so Sample draws exactly as before, its pdf is
// unchanged, Sample and Evaluate still agree term for term, and the weight only grows by that
// factor (at most 1 / 0.84 on CZ): no new noise. It handles transmission as well as reflection
// because E_ss counts both, with transmission counted as energy (Fresnel is inside the table,
// hence the index dimension). What it gives up is formal reciprocity: f(wo, wi) and f(wi, wo)
// differ by E_ss(wi) / E_ss(wo), at most 1.15 on CZ. This path tracer only traces from the eye
// and combines light sampling with BSDF sampling for a fixed eye direction, which needs
// Sample and Evaluate to agree for that direction, not reciprocity.
// The table: src/renderer/frosted_albedo.rs (generated from the float64 mirror in
// src/renderer/rough_glass.rs, checked in; uploaded as uFrostedAlbedo, lux/host.glsl). The
// compensation is 1 / clamp(E_ss + FROSTED_ALBEDO_MARGIN, FROSTED_ALBEDO_FLOOR, 1): the
// margin keeps interpolation error from ever turning into an energy gain, the floor keeps it
// at most 2x (reached only near grazing at indices below about 1.1, which no gem has), and the
// upper clamp keeps it from ever falling below 1.
//
// THE ROUGHNESS CONVENTION, AND WHY THE SURFACE IS THE SAME ONE. LuxCore's roughglass took
// `uroughness` u and `vroughness` v and gave its Schlick distribution the parameter r = u * v.
// Schlick's isotropic distribution, Z(t) / pi = r / (pi (1 + (r - 1) t^2)^2) with t = cos(theta_m),
// is IDENTICAL to Walter's GGX D with alpha^2 = r:
//     D = alpha^2 / (pi (alpha^2 cos^2 + sin^2)^2) = alpha^2 / (pi (1 + (alpha^2 - 1) cos^2)^2).
// So the GGX widths here are alpha_x = u, alpha_y = v, whose product alpha_x alpha_y = u v = r is
// exactly the old parameter, and at the project's isotropic 0.2 (FROSTED_FACET_ROUGHNESS in
// lux/entry.glsl) alpha = 0.2 and the distribution of microfacet normals is the one the port
// had. What changed is the shadowing-masking term (Smith's GGX G1, exact for this D, in place
// of Schlick's approximation of it) and how the normals are sampled. (For u != v this is
// standard anisotropic GGX, not LuxCore's Schlick anisotropy; this project never sets u != v.)
//
// NO DISPERSION, AS BEFORE. Like LuxCore's roughglass, this material refracts at the single
// index `nt` (Cauchy A) and ignores the path's wavelength; a frosted facet has no fire of its
// own, and light crossing it disperses at the next polished facet as usual.
//
// CONVENTIONS. Local frame, z = the facet's outward normal. `fixedDir`/`eyeDir` and
// `sampledDir`/`lightDir` all point away from the surface; either may be below it (the eye
// inside the stone). The maths runs in a frame flipped so the eye side is +z (every vector
// multiplied by `side`, a point reflection; D and Lambda depend only on squares of the
// components, so they are unchanged by it), and the sampled direction is flipped back at the
// end. In the flipped frame the microfacet normal m has m.z > 0; read in the ORIGINAL frame the
// same numbers are the outward microfacet normal when side = +1 and the inward one when
// side = -1. So the cosine handed to FresnelCauchy_Evaluate, whose sign means "the eye is
// outside", is side * dot(wo, m).
// -----------------------------------------------------------------------------

#ifndef LUX_ROUGHGLASS_GLSL
#define LUX_ROUGHGLASS_GLSL

// include/luxrays/core/epsilon_types.cl:31. Guarded because a future port may need it too.
#ifndef DEFAULT_COS_EPSILON_STATIC
#define DEFAULT_COS_EPSILON_STATIC 1e-4
#endif

// bsdfevents.h:24-33 -- DIFFUSE and GLOSSY. glass.glsl ports only the flags a delta BSDF can
// produce; this BSDF produces GLOSSY. pathtracer.glsl has always carried these two under this
// same guard (it needed them for its then-dead DIFFUSE/GLOSSY branches), so sharing the guard
// name means whichever of the two files comes first in the concatenation defines both, and the
// other skips its copy instead of colliding.
#ifndef LUX_PATHTRACER_BSDFEVENTS_GLSL
#define LUX_PATHTRACER_BSDFEVENTS_GLSL
const int DIFFUSE = 1;
const int GLOSSY = 2;
#endif // LUX_PATHTRACER_BSDFEVENTS_GLSL

// roughglass.h:41 (RoughGlassMaterial::GetEventTypes). Unchanged by T-0269: glossy, never
// delta, reflects and transmits.
BSDFEvent RoughGlassMaterial_GetEventTypes() {
    return GLOSSY | REFLECT | TRANSMIT;
}

// --- GGX microfacet distribution [W07], [HD14], [H18] ---------------------------------------

// The GGX widths from LuxCore's uroughness/vroughness: alpha_x = u, alpha_y = v, each clamped as
// LuxCore clamped them. See the file header for why this is the port's own distribution.
vec2 RoughGlassMaterial_Alpha(float nuVal, float nvVal) {
    return vec2(clamp(nuVal, 1e-9, 1.0), clamp(nvVal, 1e-9, 1.0));
}

// [W07] eq. 33, anisotropic form: the density of microfacet normals m per unit solid angle of
// m, normalised so that D(m) cos(theta_m) integrates to 1 over the hemisphere. Zero below the
// macro surface.
float GGX_D(vec3 m, vec2 alpha) {
    if (m.z <= 0.0)
        return 0.0;
    float x = m.x / alpha.x;
    float y = m.y / alpha.y;
    float t = x * x + y * y + m.z * m.z;
    return 1.0 / (M_PI_F * alpha.x * alpha.y * t * t);
}

// Smith's Lambda for GGX, so that G1 = 1 / (1 + Lambda): [W07] eq. 34,
// 2 / (1 + sqrt(1 + a^2 tan^2 theta_v)), rewritten, with a^2 the roughness projected on v's
// azimuth. The caller guarantees v.z != 0.
float GGX_Lambda(vec3 v, vec2 alpha) {
    float z2 = v.z * v.z;
    float a2t2 = (alpha.x * alpha.x * v.x * v.x + alpha.y * alpha.y * v.y * v.y) / z2;
    return 0.5 * (sqrt(1.0 + a2t2) - 1.0);
}

// [W07] eqs. 23 and 34: the fraction of microfacets with normal m that direction v sees
// unmasked. The chi+ factor is zero when v sees the back of the microfacet, i.e. when v.m and
// v.n (= v.z) have opposite signs; a transmitted direction (v.z < 0 and v.m < 0) passes it.
float GGX_G1(vec3 v, vec3 m, vec2 alpha) {
    if (dot(v, m) * v.z <= 0.0)
        return 0.0;
    return 1.0 / (1.0 + GGX_Lambda(v, alpha));
}

// [H18] (the exact sampler of [HD14]'s visible normals for GGX). `wo` must be in the upper
// hemisphere. Stretches wo into the configuration where the roughness is 1, where the visible
// normals are uniform over the hemisphere's projection seen from wo; draws a point of that
// projection (a disk whose far half is squashed by the view's cosine); lifts it back onto the
// hemisphere; and unstretches the normal. The result has m.z > 0 and density
// GGX_VisibleNormalPdf.
vec3 GGX_SampleVisibleNormal(vec3 wo, vec2 alpha, float u0, float u1) {
    // Stretch the view direction.
    vec3 vh = normalize(vec3(alpha.x * wo.x, alpha.y * wo.y, wo.z));
    // An orthonormal basis (t1, t2, vh). At normal incidence any t1 will do.
    float lensq = vh.x * vh.x + vh.y * vh.y;
    vec3 t1 = (lensq > 0.0) ? vec3(-vh.y, vh.x, 0.0) * inversesqrt(lensq) : vec3(1.0, 0.0, 0.0);
    vec3 t2 = cross(vh, t1);
    // A uniform point on the unit disk...
    float r = sqrt(u0);
    float phi = 2.0 * M_PI_F * u1;
    float p1 = r * cos(phi);
    float p2 = r * sin(phi);
    // ...with the half facing away from the view squashed onto the visible part.
    float s = 0.5 * (1.0 + vh.z);
    p2 = (1.0 - s) * sqrt(max(0.0, 1.0 - p1 * p1)) + s * p2;
    // Lift it onto the hemisphere around vh.
    vec3 nh = p1 * t1 + p2 * t2 + sqrt(max(0.0, 1.0 - p1 * p1 - p2 * p2)) * vh;
    // Unstretch. The max keeps m strictly above the surface in float32.
    return normalize(vec3(alpha.x * nh.x, alpha.y * nh.y, max(1e-6, nh.z)));
}

// [HD14] eq. 2: the density, per unit solid angle of m, with which GGX_SampleVisibleNormal
// draws m, for `wo` in the upper hemisphere.
float GGX_VisibleNormalPdf(vec3 wo, vec3 m, vec2 alpha) {
    return GGX_G1(wo, m, alpha) * max(0.0, dot(wo, m)) * GGX_D(m, alpha) / wo.z;
}

// --- Multiple-scattering energy compensation [T19] (T-0271) ------------------------------------
// The table's layout (src/renderer/frosted_albedo.rs): column i is the eye cosine
// (i / 63)^2, row j the relative index 1 + 3 (j / 31)^2, rows 32-63 the same for an eye inside.
// `frosted_albedo_table_covers_every_index_the_renderer_allows` and the mirror's text test hold
// these numbers to the Rust constants.
const int FROSTED_ALBEDO_COS_NODES = 64;
const int FROSTED_ALBEDO_INDEX_NODES = 32;
const float FROSTED_ALBEDO_MAX_INDEX = 4.0;
// Added to the table before dividing: the table is built so that interpolation never reads
// below the true albedo at 9 points per cell, and this covers what lies between them (at most
// 4.5e-4, scanned) and the quadrature's own error.
const float FROSTED_ALBEDO_MARGIN = 1e-3;
// The smallest albedo divided by: at most a 2x compensation.
const float FROSTED_ALBEDO_FLOOR = 0.5;

// E_ss: the fraction of the energy arriving from the eye direction (cosine `cosEye` to the
// facet normal, on the outside when `eyeOutside`) that the single-scattering BSDF above sends
// on, for a stone of relative index `n` = nt / nc. Bilinear in the table's own coordinates
// (square roots of the cosine and of the index's excess over 1), exactly as rough_glass.rs's
// albedo_lookup mirrors it.
float RoughGlassMaterial_SingleScatteringAlbedo(float cosEye, float n, bool eyeOutside) {
    float x = sqrt(clamp(cosEye, 0.0, 1.0)) * float(FROSTED_ALBEDO_COS_NODES - 1);
    float y = sqrt(clamp((n - 1.0) / (FROSTED_ALBEDO_MAX_INDEX - 1.0), 0.0, 1.0)) * float(FROSTED_ALBEDO_INDEX_NODES - 1);
    int i = min(int(x), FROSTED_ALBEDO_COS_NODES - 2);
    int j = min(int(y), FROSTED_ALBEDO_INDEX_NODES - 2);
    float fx = x - float(i);
    float fy = y - float(j);
    int row = eyeOutside ? j : j + FROSTED_ALBEDO_INDEX_NODES;
    float e00 = texelFetch(uFrostedAlbedo, ivec2(i, row), 0).r;
    float e10 = texelFetch(uFrostedAlbedo, ivec2(i + 1, row), 0).r;
    float e01 = texelFetch(uFrostedAlbedo, ivec2(i, row + 1), 0).r;
    float e11 = texelFetch(uFrostedAlbedo, ivec2(i + 1, row + 1), 0).r;
    return mix(mix(e00, e10, fx), mix(e01, e11, fx), fy);
}

// [T19] eq. 18's 1 / E_ss(wo), with the margin, the floor and the upper clamp described in the
// file header. The table assumes kr and kt both white (luxGlassParams always sets them so), so
// the callers apply it only when neither is black.
float RoughGlassMaterial_EnergyCompensation(float cosEye, float n, bool eyeOutside) {
    return 1.0 / clamp(RoughGlassMaterial_SingleScatteringAlbedo(cosEye, n, eyeOutside) + FROSTED_ALBEDO_MARGIN, FROSTED_ALBEDO_FLOOR, 1.0);
}

// The probability of choosing reflection at a microfacet whose Fresnel reflectance is F. With
// both kr and kt present it is F itself ([W07] section 5.3), which cancels F out of the weight;
// a black kr or kt forces the other event, as LuxCore's `threshold` did.
float RoughGlassMaterial_ReflectProbability(bool isKrBlack, bool isKtBlack, float F) {
    if (isKtBlack)
        return 1.0;
    if (isKrBlack)
        return 0.0;
    return F;
}

// --- RoughGlassMaterial_Evaluate ----------------------------------------------------------------
// [W07]'s GGX rough dielectric (eqs. 20-21) in LuxCore's Material::Evaluate convention:
// `lightDir` and `eyeDir` are local-frame directions pointing away from the surface, and the
// result INCLUDES the cosine of the light direction, so the integrator multiplies it by radiance
// and divides by the light-sampling pdf, nothing else. `directPdfW` is the solid-angle pdf with
// which RoughGlassMaterial_Sample would draw `lightDir` given `eyeDir` -- what the MIS weight
// needs -- built from the same expressions Sample uses, so the two agree by construction (the
// T-0183 lesson: two estimators of one integral that disagree bias the MIS blend).
//
// Transmission, with eta = n_eye / n_light and m the generalised half vector ([W07] eq. 16):
//     f |cos_light| = eta^2 (1 - F) D G |wo.m| |wi.m| / (|cos_eye| (eta wo.m + wi.m)^2),
// [W07] eq. 21 times |cos_light|, its eta_o^2 over the squared denominator divided by n_light^2
// above and below. The eta^2 is the radiance compression (radiance / n^2 is what is
// conserved) that GlassMaterial's polished transmission carries as `* eta2`, so polished and
// frosted facets agree about it.
// Reflection, with m = normalize(wo + wi) ([W07] eq. 13):
//     f |cos_light| = F D G / (4 |cos_eye|).
// Returns false where the BSDF is zero.
bool RoughGlassMaterial_Evaluate(vec3 lightDir, vec3 eyeDir,
        vec3 krVal, vec3 ktVal, float nc, float nt, float nuVal, float nvVal,
        float localFilmThickness, float localFilmIor,
        out vec3 result, out BSDFEvent event, out float directPdfW) {
    result = BLACK;
    event = NONE;
    directPdfW = 0.0;

    vec3 kt = Spectrum_Clamp(ktVal);
    vec3 kr = Spectrum_Clamp(krVal);

    bool isKtBlack = Spectrum_IsBlack(kt);
    bool isKrBlack = Spectrum_IsBlack(kr);
    if (isKtBlack && isKrBlack)
        return false;

    if (eyeDir.z == 0.0 || lightDir.z == 0.0)
        return false;

    float ntc = nt / nc;
    vec2 alpha = RoughGlassMaterial_Alpha(nuVal, nvVal);

    // The flipped frame (file header, CONVENTIONS): the eye side is +z.
    float side = (eyeDir.z > 0.0) ? 1.0 : -1.0;
    vec3 wo = side * eyeDir;
    vec3 wi = side * lightDir;

    if (wi.z < 0.0) {
        // Transmit. eta is the eye side's index over the light side's.
        float eta = (eyeDir.z > 0.0) ? (nc / nt) : ntc;

        // [W07] eq. 16 (divided through by n_light), turned to face the eye side.
        vec3 m = eta * wo + wi;
        if (m.z < 0.0)
            m = -m;
        float lengthSquared = dot(m, m);
        if (!(lengthSquared > 0.0))
            return false;
        m /= sqrt(lengthSquared);

        float cosOM = dot(wo, m);
        float cosIM = dot(wi, m);
        // A refraction pair only if the eye sees the front of m and the light its back
        // ([W07]'s chi+ factors); otherwise no microfacet connects the two directions.
        if (!(cosOM > 0.0) || !(cosIM < 0.0))
            return false;

        float F = FresnelCauchy_Evaluate(ntc, side * cosOM);
        float pT = 1.0 - RoughGlassMaterial_ReflectProbability(isKrBlack, isKtBlack, F);
        if (!(pT > 0.0))
            return false;

        float D = GGX_D(m, alpha);
        float G = GGX_G1(wo, m, alpha) * GGX_G1(wi, m, alpha);
        // (eta wo.m + wi.m)^2: [W07] eq. 17's denominator over n_light^2.
        float denom = eta * cosOM + cosIM;
        denom *= denom;
        if (!(denom > 0.0))
            return false;

        // [HD14] eq. 2 times [W07] eq. 17, times the choice probability.
        directPdfW = pT * GGX_VisibleNormalPdf(wo, m, alpha) * fabs(cosIM) / denom;

        result = (eta * eta * D * G * cosOM * fabs(cosIM) / (wo.z * denom)) * kt * (1.0 - F);

        event = GLOSSY | TRANSMIT;
    } else {
        // Reflect.
        vec3 m = wo + wi;
        if (m == BLACK)
            return false;
        m = normalize(m);

        float cosOM = dot(wo, m);
        float F = FresnelCauchy_Evaluate(ntc, side * cosOM);
        float pR = RoughGlassMaterial_ReflectProbability(isKrBlack, isKtBlack, F);
        if (!(pR > 0.0))
            return false;

        float D = GGX_D(m, alpha);
        float G = GGX_G1(wo, m, alpha) * GGX_G1(wi, m, alpha);

        // [HD14] eq. 2 times [W07] eq. 14 (1 / (4 |wo.m|)), times the choice probability.
        directPdfW = pR * GGX_VisibleNormalPdf(wo, m, alpha) / (4.0 * cosOM);

        result = (D * G / (4.0 * wo.z)) * kr * F;

        if (localFilmThickness > 0.0) {
            result *= CalcFilmColor(eyeDir, localFilmThickness, localFilmIor);
        }

        event = GLOSSY | REFLECT;
    }

    // [T19]: the eye direction's compensation, the same factor Sample applies, so the MIS
    // blend still sees one BSDF. directPdfW is unchanged: the lobe keeps its shape.
    if (!isKrBlack && !isKtBlack)
        result *= RoughGlassMaterial_EnergyCompensation(fabs(eyeDir.z), ntc, eyeDir.z > 0.0);

    return true;
}

// --- RoughGlassMaterial_Sample ------------------------------------------------------------------
// Same arguments and conventions as LuxCore's RoughGlassMaterial_Sample and GlassMaterial_Sample
// (glass.glsl): u0, u1 pick the microfacet normal, passThroughEvent picks reflect or transmit,
// `result` is f |cos| / pdf and goes straight into the path throughput, and `pdfW` is the
// solid-angle pdf of `sampledDir` -- equal to Evaluate's `directPdfW` for the same pair.
//
// With m drawn from the visible normals [HD14] and reflection chosen with probability F:
//     reflection:    result = kr G1(wi, m)
//     transmission:  result = kt G1(wi, m) eta^2,   eta = n_fixed / n_sampled
// Both are Evaluate's f |cos| over this pdf: D, G1(wo, m), |wo.m|, cos(wo), F and the Jacobian
// cancel, which is the point of visible-normal sampling. A direction that lands on the wrong
// side of the macro surface (the microfacet faces the eye, but what reflects or refracts off it
// need not clear the surface) is returned as no sample; that is the energy single scattering
// loses, and Evaluate reports zero for the same directions. Since T-0271 both weights are then
// multiplied by RoughGlassMaterial_EnergyCompensation of the fixed direction, which returns that
// energy on average: the directional albedo becomes 1 (less the margin) instead of E_ss.
bool RoughGlassMaterial_Sample(
        vec3 fixedDir, float u0, float u1, float passThroughEvent,
        vec3 krVal, vec3 ktVal, float nc, float nt, float nuVal, float nvVal,
        float localFilmThickness, float localFilmIor,
        out vec3 sampledDir, out float pdfW, out BSDFEvent event, out vec3 result) {
    sampledDir = vec3(0.0, 0.0, 1.0);
    pdfW = 0.0;
    event = NONE;
    result = BLACK;

    if (fabs(fixedDir.z) < DEFAULT_COS_EPSILON_STATIC)
        return false;

    vec3 kt = Spectrum_Clamp(ktVal);
    vec3 kr = Spectrum_Clamp(krVal);

    bool isKtBlack = Spectrum_IsBlack(kt);
    bool isKrBlack = Spectrum_IsBlack(kr);
    if (isKtBlack && isKrBlack)
        return false;

    float ntc = nt / nc;
    vec2 alpha = RoughGlassMaterial_Alpha(nuVal, nvVal);

    // The flipped frame (file header, CONVENTIONS): the eye side is +z.
    float side = (fixedDir.z > 0.0) ? 1.0 : -1.0;
    vec3 wo = side * fixedDir;

    vec3 m = GGX_SampleVisibleNormal(wo, alpha, u0, u1);
    float cosOM = dot(wo, m);
    if (!(cosOM > 0.0))
        return false;
    float pm = GGX_VisibleNormalPdf(wo, m, alpha);
    if (!(pm > 0.0))
        return false;

    float F = FresnelCauchy_Evaluate(ntc, side * cosOM);
    float pR = RoughGlassMaterial_ReflectProbability(isKrBlack, isKtBlack, F);

    vec3 wi;
    if (passThroughEvent >= pR) {
        // Transmit. eta is the fixed side's index over the sampled side's; Snell's law off m.
        float eta = (fixedDir.z > 0.0) ? (nc / nt) : ntc;
        float eta2 = eta * eta;
        float sinThetaTM2 = eta2 * fmax(0.0, 1.0 - cosOM * cosOM);
        // Total internal reflection off this microfacet. F is then 1, so pR is 1 and this arm
        // is reached only if kr is black.
        if (sinThetaTM2 >= 1.0)
            return false;
        float cosThetaTM = sqrt(1.0 - sinThetaTM2);
        wi = (eta * cosOM - cosThetaTM) * m - eta * wo;
        if (wi.z > -DEFAULT_COS_EPSILON_STATIC)
            return false;

        float pT = 1.0 - pR;
        // [W07] eq. 17 over n_sampled^2: |wi.m| / (eta wo.m + wi.m)^2, with wi.m = -cosThetaTM.
        float denom = eta * cosOM - cosThetaTM;
        denom *= denom;
        if (!(denom > 0.0))
            return false;
        pdfW = pT * pm * cosThetaTM / denom;
        if (!(pdfW > 0.0))
            return false;

        result = kt * (GGX_G1(wi, m, alpha) * eta2);
        event = GLOSSY | TRANSMIT;
    } else {
        // Reflect off m.
        wi = 2.0 * cosOM * m - wo;
        if (wi.z < DEFAULT_COS_EPSILON_STATIC)
            return false;

        pdfW = pR * pm / (4.0 * cosOM);
        if (!(pdfW > 0.0))
            return false;

        result = kr * GGX_G1(wi, m, alpha);

        if (localFilmThickness > 0.0) {
            result *= CalcFilmColor(fixedDir, localFilmThickness, localFilmIor);
        }

        event = GLOSSY | REFLECT;
    }

    // [T19]: 1 / E_ss of the fixed (eye) direction, as in Evaluate; pdfW is unchanged.
    if (!isKrBlack && !isKtBlack)
        result *= RoughGlassMaterial_EnergyCompensation(fabs(fixedDir.z), ntc, fixedDir.z > 0.0);

    if (Spectrum_IsBlack(result))
        return false;

    sampledDir = side * wi;
    return true;
}

#endif // LUX_ROUGHGLASS_GLSL
