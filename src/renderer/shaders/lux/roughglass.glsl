// -----------------------------------------------------------------------------
// RoughGlass BSDF, ported from LuxCoreRender (https://github.com/LuxCoreRender/LuxCore),
// reference/LuxCore commit e9ced7e ("Fix log format regression", 2026-09-11).    T-0183
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
// Ported from:
//   reference/LuxCore/include/slg/materials/materialdefs_funcs_roughglass.cl
//       RoughGlassMaterial_Evaluate, RoughGlassMaterial_Sample
//   reference/LuxCore/include/slg/materials/materialdefs_funcs_generic.cl:126-198
//       SchlickDistribution_SchlickZ/_SchlickA/_D/_SchlickG/_G, GetPhi,
//       SchlickDistribution_SampleH, SchlickDistribution_Pdf
//   reference/LuxCore/include/luxrays/core/epsilon_types.cl:31  DEFAULT_COS_EPSILON_STATIC
//   reference/LuxCore/include/slg/materials/roughglass.h:41     GetEventTypes
// Cross-read against reference/LuxCore/src/slg/materials/roughglass.cpp, whose Evaluate and
// Sample bodies match the .cl's `!hitPoint.fromLight` arms line for line (the .cl has the
// fromLight arms commented out, as glass.glsl's own .cl source does). Ported from the .cl, per
// kb/clean-room-and-licensing-constraints.md ("port from the .cl kernels for shader code").
//
// WHAT IT IS. A single-scattering microfacet rough dielectric: a Schlick microfacet
// distribution of normals, reflection and refraction off one sampled microfacet with the
// dielectric Fresnel term, and Schlick's separable shadowing-masking G. No multiple scattering
// between microfacets (energy that a real rough surface would bounce between microfacets is
// simply lost, so a rough interface is a little darker than a polished one at high roughness).
// This is the material T-0183's frosted facets use; the user chose it on 2026-09-23.
//
// -----------------------------------------------------------------------------
// STRUCTURAL DEPARTURE FROM UPSTREAM -- the same one glass.glsl takes (T-0096), and nothing
// else: the eval-stack plumbing is stripped. See kb/luxcore-roughglass-port-and-frosted-facets.md and
// kb/luxcore-glass-bsdf-port-eval-stack-stripping-and.md.
//   - Both functions take plain arguments (the local directions, the BSDF samples, kr, kt, nc,
//     nt, the two roughnesses, the film thickness and index) instead of popping an eval stack
//     and resolving texture indices. `nuVal`/`nvVal` are LuxCore's `uroughness`/`vroughness`
//     texture values, taken here as plain floats.
//   - They return bool (false = black / no sample) instead of MATERIAL_*_RETURN_BLACK, exactly
//     as GlassMaterial_Sample does.
//   - _Albedo, _GetInteriorVolume, _GetExteriorVolume, _GetPassThroughTransparency,
//     _GetEmittedRadiance and _EvalOp are not ported, for glass.glsl's T-0102 reasons: the
//     volume is the integrator's `side` (T-0113) and the gem is neither transparent to shadow
//     rays nor emissive.
//   - `all(isequal(wh, BLACK))` becomes `wh == BLACK`: GLSL's vector `==` is already the
//     all-components comparison OpenCL spells with isequal/all.
// Everything else -- bodies, variable names, expression order -- is a literal port, with TWO
// deliberate exceptions, each argued and measured where it is made. Both exist for the same
// reason: until T-0183 nothing in this port evaluated a BSDF and sampled it for the same
// vertex, and once PathTracer_DirectLightSampling (light sampling, via Evaluate) and BSDF
// sampling (via Sample) are MIS-combined, two upstream inconsistencies between them stop
// being invisible and bias the picture:
//   1. SchlickDistribution_SampleH / _Pdf report the half-vector pdf as D, not D cos(theta_h);
//      fixed here (see SchlickDistribution_Pdf).
//   2. RoughGlassMaterial_Sample's transmitted result lacks the eta^2 factor its own Evaluate
//      and GlassMaterial both carry; fixed here (see RoughGlassMaterial_Sample).
// Each is a one-line revert, described at the site, if a literal port is ever wanted back.
//
// THE ROUGHNESS CONVENTION. LuxCore's roughglass takes `uroughness` and `vroughness`, clamps
// each to [1e-9, 1], and uses their PRODUCT `u * v` as the Schlick distribution's roughness
// parameter (with an anisotropy from their squares). So an isotropic 0.2 on both, which is
// what this project sets (FROSTED_FACET_ROUGHNESS in lux/entry.glsl), is a Schlick roughness of
// 0.04, and anisotropy 0. The number to compare against a LuxCore scene is the 0.2 in its
// `.uroughness`/`.vroughness`, not the 0.04.
//
// NO DISPERSION, AS IN LUXCORE. Unlike GlassMaterial, RoughGlassMaterial has no `cauchyb`: it
// refracts at the single index `nt` (the scene's `interiorior`, this project's Cauchy A) and
// never samples a wavelength. A frosted facet therefore shows no fire of its own; light that
// crosses it and then meets a polished facet disperses there as usual.
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

// roughglass.h:41 (RoughGlassMaterial::GetEventTypes)
BSDFEvent RoughGlassMaterial_GetEventTypes() {
    return GLOSSY | REFLECT | TRANSMIT;
}

// --- Schlick microfacet distribution ----------------------------------------------------------
// materialdefs_funcs_generic.cl:126-198

// generic.cl:126-135
float SchlickDistribution_SchlickZ(const float roughness, float cosNH) {
    if (roughness > 0.0) {
        float cosNH2 = cosNH * cosNH;
        // expanded for increased numerical stability
        float d = cosNH2 * roughness + (1.0 - cosNH2);
        // use double division to avoid overflow in d*d product
        return (roughness / d) / d;
    }
    return 0.0;
}

// generic.cl:137-146
float SchlickDistribution_SchlickA(const vec3 H, const float anisotropy) {
    float h = sqrt(H.x * H.x + H.y * H.y);
    if (h > 0.0) {
        float w = (anisotropy > 0.0 ? H.x : H.y) / h;
        float p = 1.0 - fabs(anisotropy);
        return sqrt(p / (p * p + w * w * (1.0 - p * p)));
    }

    return 1.0;
}

// generic.cl:148-151
float SchlickDistribution_D(const float roughness, const vec3 wh, const float anisotropy) {
    float cosTheta = fabs(wh.z);
    return SchlickDistribution_SchlickZ(roughness, cosTheta) * SchlickDistribution_SchlickA(wh, anisotropy) * M_1_PI_F;
}

// generic.cl:153-155
float SchlickDistribution_SchlickG(const float roughness, const float costheta) {
    return costheta / (costheta * (1.0 - roughness) + roughness);
}

// generic.cl:157-160
float SchlickDistribution_G(const float roughness, const vec3 fixedDir, const vec3 sampledDir) {
    return SchlickDistribution_SchlickG(roughness, fabs(fixedDir.z)) *
            SchlickDistribution_SchlickG(roughness, fabs(sampledDir.z));
}

// generic.cl:162-164
float GetPhi(const float a, const float b) {
    return M_PI_F * 0.5 * sqrt(a * b / (1.0 - a * (1.0 - b)));
}

// generic.cl:166-193. Pointer out-params become GLSL `out`s.
void SchlickDistribution_SampleH(const float roughness, const float anisotropy,
        const float u0, const float u1, out vec3 wh, out float d, out float pdf) {
    float u1x4 = u1 * 4.0;
    float cos2Theta = u0 / (roughness * (1.0 - u0) + u0);
    float cosTheta = sqrt(cos2Theta);
    float sinTheta = sqrt(1.0 - cos2Theta);
    float p = 1.0 - fabs(anisotropy);
    float phi;
    if (u1x4 < 1.0) {
        phi = GetPhi(u1x4 * u1x4, p * p);
    } else if (u1x4 < 2.0) {
        u1x4 = 2.0 - u1x4;
        phi = M_PI_F - GetPhi(u1x4 * u1x4, p * p);
    } else if (u1x4 < 3.0) {
        u1x4 -= 2.0;
        phi = M_PI_F + GetPhi(u1x4 * u1x4, p * p);
    } else {
        u1x4 = 4.0 - u1x4;
        phi = M_PI_F * 2.0 - GetPhi(u1x4 * u1x4, p * p);
    }

    if (anisotropy > 0.0)
        phi += M_PI_F * 0.5;

    wh = MAKE_FLOAT3(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
    d = SchlickDistribution_SchlickZ(roughness, cosTheta) * SchlickDistribution_SchlickA(wh, anisotropy) * M_1_PI_F;
    // `* cosTheta` IS NOT UPSTREAM (upstream: `*pdf = *d;`). See the note above
    // SchlickDistribution_Pdf below.
    pdf = d * cosTheta;
}

// generic.cl:195-198, WITH A DELIBERATE DEPARTURE: the pdf is D(wh) * cos(theta_h), where
// upstream returns D(wh) alone (here and in SampleH above; material.cpp:451-485 is the same).
//
// Why. The half-vector SampleH draws has density D(wh) * cos(theta_h) over the hemisphere, not
// D(wh): inverting its own cos^2(theta) = u0 / (r (1 - u0) + u0) gives the CDF
// F(s = cos^2) = r s / (1 + (r - 1) s), whose density in solid angle is exactly
// Z(cos) * cos / pi -- and it is D * cos, not D, that integrates to 1 (the same normalisation
// the microfacet BRDF D G F / (4 cos_i cos_o) relies on). With upstream's pdf, Sample's weight
// `d / specPdf` is 1 where it should be 1 / cos(theta_h), so every BSDF-sampled glossy bounce
// loses a factor cos(theta_h) of its energy, while PathTracer_DirectLightSampling, which uses
// Evaluate's f with the environment's own pdf, does not. The two estimators then disagree and
// the MIS blend of them is biased by its weights. Measured (T-0183, Isometric, linear
// transfer, 300x300, 2048 passes, all 67 facets frosted; frame means): upstream pdf, MIS 99.93
// vs BSDF-only 97.96; with cos(theta_h), MIS 106.47 vs BSDF-only 106.07 (the rest is clipping
// of the noisier estimator), crown-only 124.82 vs 124.74. So upstream renders a frosted facet
// several percent darker per rough bounce than its own BSDF says. To go back to the literal
// port, drop the two `cos` factors (here and in SampleH).
float SchlickDistribution_Pdf(const float roughness, const vec3 wh,
        const float anisotropy) {
    return SchlickDistribution_D(roughness, wh, anisotropy) * fabs(wh.z);
}

// The five lines every upstream entry point opens with (roughglass.cl Evaluate/Sample, and
// roughglass.cpp's Pdf): clamp the two roughnesses and derive the Schlick roughness and
// anisotropy. Factored out only because GLSL has no way to return two values without a
// function; the expressions are upstream's.
void RoughGlassMaterial_Roughness(float nuVal, float nvVal, out float roughness, out float anisotropy) {
    float u = clamp(nuVal, 1e-9, 1.0);
    float v = clamp(nvVal, 1e-9, 1.0);
    float u2 = u * u;
    float v2 = v * v;
    anisotropy = (u2 < v2) ? (1.0 - u2 / v2) : u2 > 0.0 ? (v2 / u2 - 1.0) : 0.0;
    roughness = u * v;
}

// --- RoughGlassMaterial_Evaluate ----------------------------------------------------------------
// materialdefs_funcs_roughglass.cl (RoughGlassMaterial_Evaluate). `lightDir` and `eyeDir` are
// local-frame directions, both pointing away from the surface, as BSDF::Evaluate hands them to
// Material::Evaluate. The result already includes the cosine of the light direction (LuxCore's
// Material::Evaluate convention), so the integrator multiplies it by radiance and divides by
// the light-sampling pdf, nothing else. `directPdfW` is the pdf RoughGlassMaterial_Sample
// would have sampled `lightDir` with, given `eyeDir` -- what the MIS weight needs.
// Returns false where upstream executes MATERIAL_EVALUATE_RETURN_BLACK.
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

    float ntc = nt / nc;

    float roughness;
    float anisotropy;
    RoughGlassMaterial_Roughness(nuVal, nvVal, roughness, anisotropy);

    float threshold = isKrBlack ? 1.0 : (isKtBlack ? 0.0 : 0.5);
    if (lightDir.z * eyeDir.z < 0.0) {
        // Transmit

        bool entering = (CosTheta(lightDir) > 0.0);
        float eta = entering ? (nc / nt) : ntc;

        vec3 wh = eta * lightDir + eyeDir;
        if (wh.z < 0.0)
            wh = -wh;

        float lengthSquared = dot(wh, wh);
        if (!(lengthSquared > 0.0))
            return false;
        wh /= sqrt(lengthSquared);
        float cosThetaI = fabs(CosTheta(eyeDir));
        float cosThetaIH = fabs(dot(eyeDir, wh));
        float cosThetaOH = dot(lightDir, wh);

        float D = SchlickDistribution_D(roughness, wh, anisotropy);
        float G = SchlickDistribution_G(roughness, lightDir, eyeDir);
        float specPdf = SchlickDistribution_Pdf(roughness, wh, anisotropy);
        float F = FresnelCauchy_Evaluate(ntc, cosThetaOH);

        directPdfW = threshold * specPdf * (fabs(cosThetaOH) * eta * eta) / lengthSquared;

        //if (reversePdfW)
        //	*reversePdfW = threshold * specPdf * cosThetaIH / lengthSquared;

        result = (fabs(cosThetaOH) * cosThetaIH * D *
            G / (cosThetaI * lengthSquared)) *
            kt * (1.0 - F);

        event = GLOSSY | TRANSMIT;
    } else {
        // Reflect
        float cosThetaO = fabs(CosTheta(lightDir));
        float cosThetaI = fabs(CosTheta(eyeDir));
        if (cosThetaO == 0.0 || cosThetaI == 0.0)
            return false;
        vec3 wh = lightDir + eyeDir;
        if (wh == BLACK)
            return false;
        wh = normalize(wh);
        if (wh.z < 0.0)
            wh = -wh;

        float cosThetaH = dot(eyeDir, wh);
        float D = SchlickDistribution_D(roughness, wh, anisotropy);
        float G = SchlickDistribution_G(roughness, lightDir, eyeDir);
        float specPdf = SchlickDistribution_Pdf(roughness, wh, anisotropy);
        float F = FresnelCauchy_Evaluate(ntc, cosThetaH);

        directPdfW = (1.0 - threshold) * specPdf / (4.0 * fabs(dot(lightDir, wh)));

        //if (reversePdfW)
        //	*reversePdfW = (1.f - threshold) * specPdf / (4.f * fabs(dot(lightDir, wh));

        result = (D * G / (4.0 * cosThetaI)) * kr * F;

        if (localFilmThickness > 0.0) {
            result *= CalcFilmColor(eyeDir, localFilmThickness, localFilmIor);
        }

        event = GLOSSY | REFLECT;
    }

    return true;
}

// --- RoughGlassMaterial_Sample ------------------------------------------------------------------
// materialdefs_funcs_roughglass.cl (RoughGlassMaterial_Sample). Same argument order as
// GlassMaterial_Sample (glass.glsl) where the two overlap. `result` is f * |cos| / pdf, as
// upstream: the integrator multiplies it straight into the path throughput.
//
// A DELIBERATE DEPARTURE FROM UPSTREAM: THE TRANSMITTED RESULT IS MULTIPLIED BY eta^2.
// Upstream's Sample returns, for a transmission, (G |wo.h| / |cos wo|) * kt * (1 - F) / threshold
// -- with no eta^2 radiance-compression factor. Its own Evaluate (above) does carry it: divide
// Evaluate's transmitted result by its own directPdfW and you get exactly Sample's value times
// 1/eta_e^2, where eta_e is Evaluate's eta (the light side over the eye side). So upstream's
// RoughGlass disagrees WITH ITSELF by a factor of n^2 (about 4.7 for cubic zirconia) whenever
// light crosses a rough interface, and GlassMaterial (glass.glsl, `ce = ... * eta2`) sides with
// Evaluate. Ported literally this was measured, not guessed (T-0183, kb/luxcore-roughglass-port-and-frosted-facets.md):
//   - with direct light sampling + MIS on, a stone with all 67 facets frosted rendered visibly
//     brighter than the same stone with BSDF sampling only (mean 136.65 vs 131.54 over the
//     whole 300x300 frame at 2048 passes, Studio lighting) -- two estimators of one integral
//     that do not agree, so the MIS blend of them is biased by its own weights;
//   - and a path entering through a polished facet (x 1/n^2) and leaving through a frosted one
//     (x 1) would be n^2 too dark, or the reverse n^2 too bright, which a stone that mixes
//     polished and frosted facets -- the whole point of T-0183 -- does constantly.
// Multiplying by eta2 (eta relative to fixedDir, exactly GlassMaterial's convention) makes
// Sample agree with Evaluate / directPdfW and with GlassMaterial. (The measurement above was
// taken before the cos(theta_h) pdf fix, SchlickDistribution_Pdf's note, which accounts for the
// rest of the gap it showed.) (The Fresnel term needs no such change: Sample's F(ntc, cosThetaIH) and
// Evaluate's F(ntc, cosThetaOH) are both taken at the cosine on the transmitted side, i.e. the
// same number.) To go back to the literal port, delete `* eta2` below.
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

    float roughness;
    float anisotropy;
    RoughGlassMaterial_Roughness(nuVal, nvVal, roughness, anisotropy);

    vec3 wh;
    float d;
    float specPdf;
    SchlickDistribution_SampleH(roughness, anisotropy, u0, u1, wh, d, specPdf);
    if (wh.z < 0.0)
        wh = -wh;
    float cosThetaOH = dot(fixedDir, wh);

    float ntc = nt / nc;

    float coso = fabs(fixedDir.z);

    // Decide to transmit or reflect
    float threshold;
    if (!isKrBlack) {
        if (!isKtBlack)
            threshold = 0.5;
        else
            threshold = 0.0;
    } else {
        if (!isKtBlack)
            threshold = 1.0;
        else
            return false;
    }

    if (passThroughEvent < threshold) {
        // Transmit

        bool entering = (CosTheta(fixedDir) > 0.0);
        float eta = entering ? (nc / nt) : ntc;
        float eta2 = eta * eta;
        float sinThetaIH2 = eta2 * fmax(0.0, 1.0 - cosThetaOH * cosThetaOH);
        if (sinThetaIH2 >= 1.0)
            return false;
        float cosThetaIH = sqrt(1.0 - sinThetaIH2);
        if (entering)
            cosThetaIH = -cosThetaIH;
        float length = eta * cosThetaOH + cosThetaIH;
        sampledDir = length * wh - eta * fixedDir;

        float lengthSquared = length * length;
        pdfW = specPdf * fabs(cosThetaIH) / lengthSquared;
        if (pdfW <= 0.0)
            return false;

        float cosi = fabs(sampledDir.z);

        float G = SchlickDistribution_G(roughness, fixedDir, sampledDir);
        float factor = (d / specPdf) * G * fabs(cosThetaOH) / threshold;

        //if (!hitPoint.fromLight) {
            float F = FresnelCauchy_Evaluate(ntc, cosThetaIH);
            // `* eta2` IS NOT UPSTREAM -- one of this file's two deliberate departures. See
            // the note above this function.
            result = (factor / coso) * kt * (1.0 - F) * eta2;
        //} else {
        //	const Spectrum F = FresnelCauchy_Evaluate(ntc, cosThetaOH);
        //	result = (factor / cosi) * kt * (Spectrum(1.f) - F);
        //}

        pdfW *= threshold;
        event = GLOSSY | TRANSMIT;
    } else {
        // Reflect
        pdfW = specPdf / (4.0 * fabs(cosThetaOH));
        if (pdfW <= 0.0)
            return false;

        sampledDir = 2.0 * cosThetaOH * wh - fixedDir;

        float cosi = fabs(sampledDir.z);
        if ((cosi < DEFAULT_COS_EPSILON_STATIC) || (fixedDir.z * sampledDir.z < 0.0))
            return false;

        float G = SchlickDistribution_G(roughness, fixedDir, sampledDir);
        float factor = (d / specPdf) * G * fabs(cosThetaOH) / (1.0 - threshold);

        float F = FresnelCauchy_Evaluate(ntc, cosThetaOH);
        //factor /= (!hitPoint.fromLight) ? coso : cosi;
        factor /= coso;
        result = factor * F * kr;

        if (localFilmThickness > 0.0) {
            result *= CalcFilmColor(fixedDir, localFilmThickness, localFilmIor);
        }

        pdfW *= (1.0 - threshold);
        event = GLOSSY | REFLECT;
    }

    return true;
}

#endif // LUX_ROUGHGLASS_GLSL
