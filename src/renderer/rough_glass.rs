//! A float64 mirror of the frosted-facet BSDF in `shaders/lux/roughglass.glsl` (T-0269), and the
//! tests that pin it. Test-only: nothing in the renderer calls it.
//!
//! The shader cannot be run from `cargo test` (T-0037), so, as `accel.rs` does for the BVH
//! traversal, this module restates the GLSL's maths line for line in Rust and checks the
//! properties the shader depends on: that Sample and Evaluate describe the same BSDF (the MIS
//! blend of light sampling and BSDF sampling is only unbiased if they do), that the material
//! never creates energy, that Sample's weights are bounded (the point of the change), and that
//! the GGX distribution is the same surface LuxCore's Schlick distribution described at the
//! user's roughness. `the_mirror_matches_the_shader_text` ties the mirror to the shader: it
//! checks that the GLSL still contains the lines mirrored here, so an edit to one without the
//! other fails.
//!
//! The model: a GGX rough dielectric (Walter, Marschner, Li, Torrance, "Microfacet Models for
//! Refraction through Rough Surfaces", EGSR 2007) whose microfacet normals are drawn from the
//! distribution of visible normals (Heitz and d'Eon, EGSR 2014) with Heitz's exact GGX sampler
//! (JCGT 7(4), 2018). See the GLSL file's header for the derivations.
//!
//! Since T-0271 (2026-09-28) the BSDF is divided by its own single-scattering directional
//! albedo E_ss(eye), read from the checked-in table in `frosted_albedo.rs`, so that the
//! energy single scattering drops comes back (Turquin, "Practical multiple scattering
//! compensation for microfacet models", ILM technical report 2019, section 3.2, eq. 18). This
//! module also integrates E_ss (`single_scattering_albedo`), regenerates the table from it
//! (`regenerate_the_frosted_albedo_table`, ignored), and checks the table against it.

/// A local-frame vector: z is the facet's outward normal.
type V3 = [f64; 3];

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn scale(s: f64, a: V3) -> V3 {
    [s * a[0], s * a[1], s * a[2]]
}

fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn normalize(a: V3) -> V3 {
    scale(1.0 / dot(a, a).sqrt(), a)
}

/// `DEFAULT_COS_EPSILON_STATIC` in the GLSL (LuxCore's epsilon_types.cl).
const COS_EPSILON: f64 = 1e-4;

/// glass.glsl's `FresnelCauchy_Evaluate` (LuxCore's, unchanged by T-0269): unpolarised dielectric
/// Fresnel reflectance; `cosi > 0` means the incident direction is outside (index 1 side).
fn fresnel(eta: f64, cosi: f64) -> f64 {
    let entering = cosi > 0.0;
    let eta2 = eta * eta;
    let sint2 = if entering { 1.0 / eta2 } else { eta2 } * (1.0 - cosi * cosi).max(0.0);
    if sint2 >= 1.0 {
        return 1.0;
    }
    let cost = (1.0 - sint2).max(0.0).sqrt();
    let e = if entering { eta } else { 1.0 / eta };
    let ci = cosi.abs();
    let rparl = (cost - e * ci) / (cost + e * ci);
    let rperp = (ci - e * cost) / (ci + e * cost);
    (rparl * rparl + rperp * rperp) * 0.5
}

/// `GGX_D`.
fn ggx_d(m: V3, alpha: [f64; 2]) -> f64 {
    if m[2] <= 0.0 {
        return 0.0;
    }
    let x = m[0] / alpha[0];
    let y = m[1] / alpha[1];
    let t = x * x + y * y + m[2] * m[2];
    1.0 / (std::f64::consts::PI * alpha[0] * alpha[1] * t * t)
}

/// `GGX_G1` (with `GGX_Lambda` inlined).
fn ggx_g1(v: V3, m: V3, alpha: [f64; 2]) -> f64 {
    if dot(v, m) * v[2] <= 0.0 {
        return 0.0;
    }
    let a2t2 = (alpha[0] * alpha[0] * v[0] * v[0] + alpha[1] * alpha[1] * v[1] * v[1]) / (v[2] * v[2]);
    1.0 / (1.0 + 0.5 * ((1.0 + a2t2).sqrt() - 1.0))
}

/// `GGX_SampleVisibleNormal`.
fn ggx_sample_visible_normal(wo: V3, alpha: [f64; 2], u0: f64, u1: f64) -> V3 {
    let vh = normalize([alpha[0] * wo[0], alpha[1] * wo[1], wo[2]]);
    let lensq = vh[0] * vh[0] + vh[1] * vh[1];
    let t1 = if lensq > 0.0 { scale(1.0 / lensq.sqrt(), [-vh[1], vh[0], 0.0]) } else { [1.0, 0.0, 0.0] };
    let t2 = cross(vh, t1);
    let r = u0.sqrt();
    let phi = 2.0 * std::f64::consts::PI * u1;
    let p1 = r * phi.cos();
    let mut p2 = r * phi.sin();
    let s = 0.5 * (1.0 + vh[2]);
    p2 = (1.0 - s) * (1.0 - p1 * p1).max(0.0).sqrt() + s * p2;
    let nh = add(add(scale(p1, t1), scale(p2, t2)), scale((1.0 - p1 * p1 - p2 * p2).max(0.0).sqrt(), vh));
    normalize([alpha[0] * nh[0], alpha[1] * nh[1], nh[2].max(1e-6)])
}

/// `GGX_VisibleNormalPdf`.
fn ggx_visible_normal_pdf(wo: V3, m: V3, alpha: [f64; 2]) -> f64 {
    ggx_g1(wo, m, alpha) * dot(wo, m).max(0.0) * ggx_d(m, alpha) / wo[2]
}

/// `FROSTED_ALBEDO_MARGIN` in the GLSL: added to the interpolated albedo before dividing by it,
/// so that the table's interpolation error (at most about 5e-4, measured) can only
/// under-compensate, never create energy.
const ALBEDO_MARGIN: f64 = 1e-3;

/// `FROSTED_ALBEDO_FLOOR` in the GLSL: the smallest albedo divided by, so the compensation is
/// at most 2x. Reached only near grazing at relative indices below about 1.1, which no gem
/// has; there the model is under-compensated rather than given noisy weights.
const ALBEDO_FLOOR: f64 = 0.5;

/// `RoughGlassMaterial_SingleScatteringAlbedo`: the table of `frosted_albedo.rs`, read and
/// interpolated bilinearly exactly as the shader reads its texture. `cos_eye` is |eye.z|,
/// `n` the relative index nt / nc, `eye_outside` which table.
fn albedo_lookup(cos_eye: f64, n: f64, eye_outside: bool) -> f64 {
    use crate::frosted_albedo::{COS_NODES, INDEX_NODES, MAX_INDEX, TABLE};
    let x = cos_eye.clamp(0.0, 1.0).sqrt() * (COS_NODES - 1) as f64;
    let y = ((n - 1.0) / (MAX_INDEX - 1.0)).clamp(0.0, 1.0).sqrt() * (INDEX_NODES - 1) as f64;
    let i = (x as usize).min(COS_NODES - 2);
    let j = (y as usize).min(INDEX_NODES - 2);
    let fx = x - i as f64;
    let fy = y - j as f64;
    let row = if eye_outside { j } else { j + INDEX_NODES };
    // The texture holds value / 65535 as a float32; so does this, to the same rounding.
    let e = |di: usize, dj: usize| (TABLE[(row + dj) * COS_NODES + i + di] as f32 / 65535.0) as f64;
    let lower = e(0, 0) * (1.0 - fx) + e(1, 0) * fx;
    let upper = e(0, 1) * (1.0 - fx) + e(1, 1) * fx;
    lower * (1.0 - fy) + upper * fy
}

/// `RoughGlassMaterial_EnergyCompensation`: 1 / E_ss(eye), with the margin and the floor, and
/// never below 1 (where the table reads 1, at normal incidence near n = 1, the margin must not
/// turn the compensation into a loss).
fn compensation(cos_eye: f64, n: f64, eye_outside: bool) -> f64 {
    1.0 / (albedo_lookup(cos_eye, n, eye_outside) + ALBEDO_MARGIN).clamp(ALBEDO_FLOOR, 1.0)
}

/// The material as `luxGlassParams` sets it up: kr = kt = white, no thin film, exterior index 1.
/// With kr and kt both present, `RoughGlassMaterial_ReflectProbability` is F. `compensated`
/// false is the single-scattering BSDF of T-0269, kept so the tests can measure what the
/// compensation adds.
struct RoughGlass {
    nc: f64,
    nt: f64,
    alpha: [f64; 2],
    compensated: bool,
}

/// What `RoughGlassMaterial_Sample` returns: direction, pdf, weight (f |cos| / pdf, one channel
/// because kr and kt are white), and whether it transmitted.
struct Sampled {
    dir: V3,
    pdf: f64,
    weight: f64,
    transmitted: bool,
}

impl RoughGlass {
    /// `RoughGlassMaterial_Sample`, eye-path convention; None where the GLSL returns false.
    fn sample(&self, fixed: V3, u0: f64, u1: f64, pass_through: f64) -> Option<Sampled> {
        if fixed[2].abs() < COS_EPSILON {
            return None;
        }
        let ntc = self.nt / self.nc;
        let side = if fixed[2] > 0.0 { 1.0 } else { -1.0 };
        let wo = scale(side, fixed);
        let m = ggx_sample_visible_normal(wo, self.alpha, u0, u1);
        let cos_om = dot(wo, m);
        if !(cos_om > 0.0) {
            return None;
        }
        let pm = ggx_visible_normal_pdf(wo, m, self.alpha);
        if !(pm > 0.0) {
            return None;
        }
        let f = fresnel(ntc, side * cos_om);
        let p_r = f;

        let (wi, pdf, weight, transmitted);
        if pass_through >= p_r {
            let eta = if fixed[2] > 0.0 { self.nc / self.nt } else { ntc };
            let eta2 = eta * eta;
            let sin2 = eta2 * (1.0 - cos_om * cos_om).max(0.0);
            if sin2 >= 1.0 {
                return None;
            }
            let cos_t = (1.0 - sin2).sqrt();
            wi = add(scale(eta * cos_om - cos_t, m), scale(-eta, wo));
            if wi[2] > -COS_EPSILON {
                return None;
            }
            let denom = (eta * cos_om - cos_t).powi(2);
            pdf = (1.0 - p_r) * pm * cos_t / denom;
            weight = ggx_g1(wi, m, self.alpha) * eta2;
            transmitted = true;
        } else {
            wi = add(scale(2.0 * cos_om, m), scale(-1.0, wo));
            if wi[2] < COS_EPSILON {
                return None;
            }
            pdf = p_r * pm / (4.0 * cos_om);
            weight = ggx_g1(wi, m, self.alpha);
            transmitted = false;
        }
        if !(pdf > 0.0) || weight == 0.0 {
            return None;
        }
        let weight = weight * self.compensation_for(fixed);
        Some(Sampled { dir: scale(side, wi), pdf, weight, transmitted })
    }

    /// The factor Sample and Evaluate multiply by for this fixed (eye) direction: 1 without
    /// compensation.
    fn compensation_for(&self, eye: V3) -> f64 {
        if self.compensated {
            compensation(eye[2].abs(), self.nt / self.nc, eye[2] > 0.0)
        } else {
            1.0
        }
    }

    /// `RoughGlassMaterial_Evaluate`: (f |cos_light|, directPdfW), or None where the GLSL
    /// returns false.
    fn evaluate(&self, light: V3, eye: V3) -> Option<(f64, f64)> {
        if eye[2] == 0.0 || light[2] == 0.0 {
            return None;
        }
        let ntc = self.nt / self.nc;
        let side = if eye[2] > 0.0 { 1.0 } else { -1.0 };
        let wo = scale(side, eye);
        let wi = scale(side, light);
        if wi[2] < 0.0 {
            let eta = if eye[2] > 0.0 { self.nc / self.nt } else { ntc };
            let mut m = add(scale(eta, wo), wi);
            if m[2] < 0.0 {
                m = scale(-1.0, m);
            }
            let len2 = dot(m, m);
            if !(len2 > 0.0) {
                return None;
            }
            m = scale(1.0 / len2.sqrt(), m);
            let cos_om = dot(wo, m);
            let cos_im = dot(wi, m);
            if !(cos_om > 0.0) || !(cos_im < 0.0) {
                return None;
            }
            let f = fresnel(ntc, side * cos_om);
            let p_t = 1.0 - f;
            if !(p_t > 0.0) {
                return None;
            }
            let d = ggx_d(m, self.alpha);
            let g = ggx_g1(wo, m, self.alpha) * ggx_g1(wi, m, self.alpha);
            let denom = (eta * cos_om + cos_im).powi(2);
            let pdf = p_t * ggx_visible_normal_pdf(wo, m, self.alpha) * cos_im.abs() / denom;
            let value = eta * eta * d * g * cos_om * cos_im.abs() / (wo[2] * denom) * (1.0 - f);
            Some((value * self.compensation_for(eye), pdf))
        } else {
            let m = normalize(add(wo, wi));
            let cos_om = dot(wo, m);
            let f = fresnel(ntc, side * cos_om);
            if !(f > 0.0) {
                return None;
            }
            let d = ggx_d(m, self.alpha);
            let g = ggx_g1(wo, m, self.alpha) * ggx_g1(wi, m, self.alpha);
            let pdf = f * ggx_visible_normal_pdf(wo, m, self.alpha) / (4.0 * cos_om);
            Some((d * g / (4.0 * wo[2]) * f * self.compensation_for(eye), pdf))
        }
    }
}

/// The project's frosted facet on cubic zirconia, the startup stone's material: exterior index
/// 1, Cauchy A 2.10712553 (kb/luxcore-as-a-reference-oracle.md), FROSTED_FACET_ROUGHNESS 0.2 on
/// both axes.
fn frosted_cz() -> RoughGlass {
    frosted(2.10712553)
}

/// The project's frosted facet, compensated as the shader is, on a stone of index `nt`.
fn frosted(nt: f64) -> RoughGlass {
    RoughGlass { nc: 1.0, nt, alpha: [0.2, 0.2], compensated: true }
}

/// The same material without the T-0271 compensation: T-0269's single-scattering BSDF.
fn single_scattering(nt: f64) -> RoughGlass {
    RoughGlass { compensated: false, ..frosted(nt) }
}

/// The single-scattering directional albedo E_ss that the table holds: the fraction of the
/// energy arriving from the eye direction at cosine `mu` (on the outside when `eye_outside`,
/// else inside a stone of relative index `n`) that the uncompensated Sample sends on, with a
/// transmission counted as energy (its radiance weight over eta^2, i.e. just G1).
///
/// Integrated exactly as Sample draws it, but deterministically: the two numbers that pick
/// the microfacet normal run over a `k` x `k` midpoint grid, and the reflect-or-transmit choice
/// is summed in closed form (F times the reflection's G1 plus (1 - F) times the transmission's)
/// instead of drawn. A direction Sample would reject (below or at the surface, total internal
/// reflection on the transmit arm) contributes nothing, as in Sample. The eye direction's
/// azimuth does not matter (the roughness is isotropic), so it is taken in the xz plane.
fn single_scattering_albedo(n: f64, mu: f64, eye_outside: bool, k: usize) -> f64 {
    let alpha = [crate::frosted_albedo::ROUGHNESS; 2];
    let mu = mu.clamp(COS_EPSILON, 1.0);
    // The flipped frame of the GLSL: the eye side is +z whichever side of the facet it is on.
    let wo = [(1.0 - mu * mu).max(0.0).sqrt(), 0.0, mu];
    let side = if eye_outside { 1.0 } else { -1.0 };
    let eta = if eye_outside { 1.0 / n } else { n };
    let mut sum = 0.0;
    for a in 0..k {
        for b in 0..k {
            let u0 = (a as f64 + 0.5) / k as f64;
            let u1 = (b as f64 + 0.5) / k as f64;
            let m = ggx_sample_visible_normal(wo, alpha, u0, u1);
            let cos_om = dot(wo, m);
            if !(cos_om > 0.0) {
                continue;
            }
            let f = fresnel(n, side * cos_om);
            let wr = add(scale(2.0 * cos_om, m), scale(-1.0, wo));
            if wr[2] >= COS_EPSILON {
                sum += f * ggx_g1(wr, m, alpha);
            }
            let sin2 = eta * eta * (1.0 - cos_om * cos_om).max(0.0);
            if sin2 < 1.0 {
                let cos_t = (1.0 - sin2).sqrt();
                let wt = add(scale(eta * cos_om - cos_t, m), scale(-eta, wo));
                if wt[2] <= -COS_EPSILON {
                    sum += (1.0 - f) * ggx_g1(wt, m, alpha);
                }
            }
        }
    }
    sum / (k * k) as f64
}

/// The quadrature the table is generated with: 512 x 512 microfacet normals per node, which
/// agrees with 768 x 768 to about 1e-5 (measured on the numpy prototype of 2026-09-28: 128 x 128
/// was already within 2e-4).
const TABLE_QUADRATURE: usize = 512;

/// The single-scattering albedo at table node (i, j) itself, before the generator raises it.
fn table_node_albedo(i: usize, j: usize, eye_outside: bool) -> f64 {
    use crate::frosted_albedo::{cos_at, index_at};
    single_scattering_albedo(index_at(j), cos_at(i), eye_outside, TABLE_QUADRATURE)
}

/// The check points inside every table cell, as fractions of the cell on each axis.
const CELL_CHECKS: [f64; 3] = [0.25, 0.5, 0.75];

/// The quadrature at the check points: coarser than the nodes', which is enough to find a
/// shortfall of interpolation (they are at most 1.4e-2, below n = 1.1) and keeps the
/// generator near a minute.
const CHECK_QUADRATURE: usize = 192;

/// One side's table, `INDEX_NODES` rows of `COS_NODES` albedos, made conservative for bilinear
/// interpolation, and then stored as u16.
///
/// 1. Every node is the single-scattering albedo there (`table_node_albedo`).
/// 2. In every cell, the true albedo at 3 x 3 interior points is compared with the bilinear
///    interpolation of the cell's corners; each corner is raised by the largest shortfall of
///    any cell it belongs to. The four bilinear weights sum to 1, so raising all four corners
///    of a cell by d raises every point of it by at least d: at the check points the table then
///    never reads below the truth, and raising a node can only raise its other cells.
/// 3. Stored rounded UP to the next 1 / 65535, so quantisation cannot undo step 2.
///
/// Why: the albedo is not bilinear. For gem indices the plain table interpolates to within
/// 5.3e-4 (scanned 2026-09-28 on 121 x 91 off-node points per side), inside the shader's 1e-3
/// margin, but below n = 1.1, from inside the stone, the critical angle sweeps in from grazing
/// so fast that plain interpolation read up to 1.4e-2 low, which the compensation would have
/// turned into an energy gain. Raising the nodes costs only a slight under-compensation.
fn conservative_side(eye_outside: bool) -> Vec<u16> {
    use crate::frosted_albedo::{COS_NODES, INDEX_NODES, MAX_INDEX};
    let nodes: Vec<Vec<f64>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..INDEX_NODES)
            .map(|j| scope.spawn(move || (0..COS_NODES).map(|i| table_node_albedo(i, j, eye_outside)).collect()))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    // The largest shortfall of each cell (i, j), the cell whose lower corner is node (i, j).
    let shortfalls: Vec<Vec<f64>> = std::thread::scope(|scope| {
        let nodes = &nodes;
        let handles: Vec<_> = (0..INDEX_NODES - 1)
            .map(|j| {
                scope.spawn(move || {
                    (0..COS_NODES - 1)
                        .map(|i| {
                            let mut worst: f64 = 0.0;
                            for fx in CELL_CHECKS {
                                for fy in CELL_CHECKS {
                                    let t = (i as f64 + fx) / (COS_NODES - 1) as f64;
                                    let s = (j as f64 + fy) / (INDEX_NODES - 1) as f64;
                                    let truth = single_scattering_albedo(
                                        1.0 + (MAX_INDEX - 1.0) * s * s,
                                        t * t,
                                        eye_outside,
                                        CHECK_QUADRATURE,
                                    );
                                    let lower = nodes[j][i] * (1.0 - fx) + nodes[j][i + 1] * fx;
                                    let upper = nodes[j + 1][i] * (1.0 - fx) + nodes[j + 1][i + 1] * fx;
                                    worst = worst.max(truth - (lower * (1.0 - fy) + upper * fy));
                                }
                            }
                            worst
                        })
                        .collect::<Vec<f64>>()
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut values = Vec::with_capacity(INDEX_NODES * COS_NODES);
    for j in 0..INDEX_NODES {
        for i in 0..COS_NODES {
            let mut raise: f64 = 0.0;
            for (cj, ci) in [(j.wrapping_sub(1), i.wrapping_sub(1)), (j.wrapping_sub(1), i), (j, i.wrapping_sub(1)), (j, i)] {
                if cj < INDEX_NODES - 1 && ci < COS_NODES - 1 {
                    raise = raise.max(shortfalls[cj][ci]);
                }
            }
            values.push(((nodes[j][i] + raise).clamp(0.0, 1.0) * 65535.0).ceil() as u16);
        }
    }
    values
}

/// Rewrites `frosted_albedo_table.rs` from the mirror. Not a test; run it by hand after any
/// change to the BSDF's maths or to `FROSTED_FACET_ROUGHNESS`, in release (about two minutes):
///
/// ```text
/// cargo test --release --lib rough_glass::regenerate_the_frosted_albedo_table -- --ignored
/// ```
///
/// then `cargo test`, which checks the new table against the mirror.
#[test]
#[ignore]
fn regenerate_the_frosted_albedo_table() {
    use crate::frosted_albedo::{COS_NODES, INDEX_NODES};
    let rows: Vec<(usize, bool)> = (0..INDEX_NODES)
        .map(|j| (j, true))
        .chain((0..INDEX_NODES).map(|j| (j, false)))
        .collect();
    let outside = conservative_side(true);
    let inside = conservative_side(false);
    let values: Vec<&[u16]> = outside.chunks(COS_NODES).chain(inside.chunks(COS_NODES)).collect();
    let mut text = String::new();
    text.push_str(
        "// GENERATED by rough_glass.rs's `regenerate_the_frosted_albedo_table` (ignored test); do\n\
         // not edit by hand. The single-scattering albedo of the frosted facets' GGX rough\n\
         // dielectric at roughness 0.2, times 65535, raised where needed so that bilinear\n\
         // interpolation never reads below it (see `conservative_side`); layout in\n\
         // frosted_albedo.rs. Rows 0-31: eye outside the stone; rows 32-63: eye inside. One row\n\
         // per relative index, one column per eye cosine.\n[\n",
    );
    for (row, (j, outside)) in values.iter().zip(rows.iter()) {
        text.push_str(&format!(
            "    // row {}: {}, n = {:.6}\n",
            if *outside { *j } else { j + INDEX_NODES },
            if *outside { "eye outside" } else { "eye inside" },
            crate::frosted_albedo::index_at(*j)
        ));
        for chunk in row.chunks(16) {
            let line: Vec<String> = chunk.iter().map(|v| v.to_string()).collect();
            text.push_str(&format!("    {},\n", line.join(", ")));
        }
    }
    text.push_str("]\n");
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/renderer/frosted_albedo_table.rs");
    std::fs::write(path, text).unwrap();
}

/// A fixed direction at `degrees` from the normal, on the outside (`side` = 1) or inside (-1).
fn direction(degrees: f64, side: f64) -> V3 {
    let t = degrees.to_radians();
    [t.sin(), 0.0, side * t.cos()]
}

/// A deterministic, well-spread sequence in [0, 1)^3 (the R3 additive recurrence), so the tests
/// need no random-number crate and give the same answer every run.
fn r3(i: usize) -> [f64; 3] {
    const G: f64 = 1.220_744_084_605_759_5; // the real root of x^4 = x + 1
    let a = [1.0 / G, 1.0 / (G * G), 1.0 / (G * G * G)];
    let k = i as f64 + 0.5;
    [(k * a[0]).fract(), (k * a[1]).fract(), (k * a[2]).fract()]
}

/// The incidence angles every test sweeps, both sides: normal, moderate, and down to 1 degree
/// off grazing, where the old Schlick port's weights and energy went wrong.
const ANGLES: [f64; 7] = [0.0, 20.0, 45.0, 60.0, 75.0, 85.0, 89.0];

/// Sample and Evaluate must describe the same BSDF, sample by sample.
///
/// Setup: CZ's frosted facet; for each incidence angle in ANGLES, from outside and from inside
/// the stone, 20,000 samples from the deterministic R3 sequence.
///
/// Test: every direction Sample returns is handed back to Evaluate with the same eye
/// direction. Evaluate's f |cos| over its own pdf must equal Sample's weight, and its pdf must
/// equal Sample's pdf, both to 1e-9 relative.
///
/// Verifies the property T-0183 found the hard way: PathTracer_DirectLightSampling weighs
/// Evaluate against BSDF sampling with the power heuristic, and when the two are estimators of
/// different integrals the blend is biased by its own weights (the Schlick port was measured
/// 4% and n^2 off before its two fixes). Here the two are computed from different expressions
/// (Evaluate rebuilds the microfacet normal from the pair of directions), so agreement is a
/// real check of the half vectors, the Jacobians and the choice probabilities.
///
/// Since T-0271 it runs on four materials: the compensated BSDF the shader ships, on CZ and
/// on diamond (2.417), and the single-scattering one on the same two. Compensation multiplies
/// Sample's weight and Evaluate's value by the same factor of the eye direction and leaves
/// both pdfs alone (Turquin's point: the lobe keeps its shape, so its sampling stays exact),
/// so this still has to hold to 1e-9; a factor applied in one and not the other, or taken from
/// the sampled direction instead of the eye's, fails here.
#[test]
fn sample_and_evaluate_are_the_same_bsdf() {
    for glass in [frosted_cz(), frosted(2.417), single_scattering(2.10712553), single_scattering(2.417)] {
    for side in [1.0, -1.0] {
        for angle in ANGLES {
            let eye = direction(angle, side);
            let mut checked = 0;
            for i in 0..20_000 {
                let u = r3(i);
                let Some(s) = glass.sample(eye, u[0], u[1], u[2]) else { continue };
                let (value, pdf) = glass
                    .evaluate(s.dir, eye)
                    .unwrap_or_else(|| panic!("Evaluate refused a sampled direction at {} deg", angle));
                assert!(
                    ((value / pdf) - s.weight).abs() <= 1e-9 * s.weight,
                    "{} deg, side {}: f|cos|/pdf {} but Sample's weight {}",
                    angle, side, value / pdf, s.weight
                );
                assert!(
                    (pdf - s.pdf).abs() <= 1e-9 * s.pdf,
                    "{} deg, side {}: Evaluate's pdf {} but Sample's {}",
                    angle, side, pdf, s.pdf
                );
                checked += 1;
            }
            assert!(checked > 15_000, "only {} of 20000 samples succeeded at {} deg", checked, angle);
        }
    }
    }
}

/// Sample's weight must be bounded: at most 1 for a reflection, at most eta^2 for a
/// transmission, eta the fixed side's index over the sampled side's -- each times the energy
/// compensation of the eye direction (T-0271), which is itself at most 1 / ALBEDO_FLOOR = 2.
///
/// Setup: as above, on the compensated BSDF the shader ships.
///
/// Test: every weight is positive and within that bound, and the compensation factor is
/// within [1, 2] (on CZ it is at most 1 / 0.84, about 1.19: the worst single-scattering albedo,
/// inside the stone near grazing).
///
/// Verifies the reason for T-0269. The Schlick port drew microfacet normals blind to the
/// direction they are seen from, so its weight grew like 1 / cos near grazing (about 25 x 2 x
/// eta^2, and far more in the tail; the float64 mirror in the ticket saw weights over 5,000 at
/// 89 degrees inside the stone) and a frosted stone stayed grainy at 2048 passes. With
/// visible-normal sampling and a Fresnel-proportional reflect/transmit choice, the weight is the
/// shadowing of the sampled direction, G1 <= 1, times the radiance factor eta^2 that polished
/// glass carries too. A regression to D-proportional sampling or a fixed 50/50 choice fails here.
/// The compensation scales every weight from one eye direction by the same bounded factor, so
/// it cannot bring back the Schlick port's fireflies; the look should not get grainier.
#[test]
fn sample_weights_are_bounded() {
    let glass = frosted_cz();
    for side in [1.0, -1.0] {
        let eta2 = if side > 0.0 { (glass.nc / glass.nt).powi(2) } else { (glass.nt / glass.nc).powi(2) };
        for angle in ANGLES {
            let eye = direction(angle, side);
            let c = glass.compensation_for(eye);
            assert!((1.0..=1.0 / 0.84).contains(&c), "{} deg, side {}: compensation {}", angle, side, c);
            for i in 0..20_000 {
                let u = r3(i);
                let Some(s) = glass.sample(eye, u[0], u[1], u[2]) else { continue };
                let bound = c * if s.transmitted { eta2 } else { 1.0 };
                assert!(
                    s.weight > 0.0 && s.weight <= bound * (1.0 + 1e-12),
                    "{} deg, side {}: weight {} exceeds {}",
                    angle, side, s.weight, bound
                );
            }
        }
    }
}

/// The single-scattering BSDF (T-0269's, which the compensation divides by its own albedo)
/// must never create energy, and must lose only what single scattering loses.
///
/// Setup: as above but without the compensation (`single_scattering`), 200,000 samples per
/// direction.
///
/// Test: the directional albedo -- the mean of Sample's weight, with each transmission divided
/// by its eta^2 so that it counts energy rather than radiance -- is at most 1 everywhere, and
/// at least the floor the float64 study of 2026-09-28 measured for single-scattering GGX at
/// alpha 0.2 on CZ, less a margin: 0.97 from outside below 50 degrees (measured 0.981-0.990)
/// and 0.89 above (0.906-0.968); 0.90 from inside below 50 degrees (0.913-0.949) and 0.82
/// above (0.842-0.887).
///
/// Verifies the brief's energy criterion at the level of one interface. Every bit of the loss is
/// the model's: rays that reflect or refract off a microfacet into the surface itself, which a
/// real rough surface would bounce onward (multiple scattering) and Walter's model drops. From
/// inside it is larger because the steep microfacets GGX's long tail allows totally reflect
/// back into the surface. A gain would mean the shadowing term or a pdf is wrong: the Schlick
/// port's approximate G let it reach an albedo of about 1.5 at 85 degrees and 2.8 at 89.
#[test]
fn albedo_never_exceeds_one_and_loses_only_single_scattering_energy() {
    let glass = single_scattering(2.10712553);
    for side in [1.0, -1.0] {
        for angle in ANGLES {
            let eye = direction(angle, side);
            let n = 200_000;
            let mut sum = 0.0;
            for i in 0..n {
                let u = r3(i);
                if let Some(s) = glass.sample(eye, u[0], u[1], u[2]) {
                    let eta = if (s.dir[2] > 0.0) == (eye[2] > 0.0) {
                        1.0
                    } else if side > 0.0 {
                        glass.nc / glass.nt
                    } else {
                        glass.nt / glass.nc
                    };
                    sum += s.weight / (eta * eta);
                }
            }
            let albedo = sum / n as f64;
            let floor = match (side > 0.0, angle < 50.0) {
                (true, true) => 0.97,
                (true, false) => 0.89,
                (false, true) => 0.90,
                (false, false) => 0.82,
            };
            assert!(albedo <= 1.0, "{} deg, side {}: albedo {} gains energy", angle, side, albedo);
            assert!(albedo >= floor, "{} deg, side {}: albedo {} below {}", angle, side, albedo, floor);
        }
    }
}

/// The energy albedo Sample reports for `eye`, estimated from `n` samples of the R3 sequence:
/// the mean weight, a transmission divided by its eta^2 so that it counts energy.
fn sampled_albedo(glass: &RoughGlass, eye: V3, n: usize) -> f64 {
    let mut sum = 0.0;
    for i in 0..n {
        let u = r3(i);
        if let Some(s) = glass.sample(eye, u[0], u[1], u[2]) {
            let eta = if (s.dir[2] > 0.0) == (eye[2] > 0.0) {
                1.0
            } else if eye[2] > 0.0 {
                glass.nc / glass.nt
            } else {
                glass.nt / glass.nc
            };
            sum += s.weight / (eta * eta);
        }
    }
    sum / n as f64
}

/// The checked-in table must be what the mirror integrates.
///
/// Setup: a spread of 48 of the table's 4,096 nodes (6 eye cosines, including grazing and
/// normal incidence, times 4 indices, including n = 1 and the last row, on both sides),
/// each integrated afresh with `table_node_albedo`, the generator's own function and
/// quadrature.
///
/// Test: the stored value is never below the recomputed albedo (less 1 / 65535, for a
/// platform whose sin or cos differs in the last bit), because the generator only ever
/// raises nodes. For gem indices (n >= 1.3) it is also at most 1e-3 above it: the raise that
/// makes interpolation conservative is small where the albedo is smooth. Below that it may
/// be raised by up to 2e-2 (the steep corner near n = 1).
///
/// Verifies that the table is not stale: a change to the BSDF's maths, to its roughness or to
/// the table's layout that is not followed by `regenerate_the_frosted_albedo_table` fails
/// here (the T-0269 to T-0271 change of any line of Sample moves these nodes by far more than
/// 1e-3), and so does a table edited by hand.
#[test]
fn the_frosted_albedo_table_is_the_mirrors_albedo() {
    use crate::frosted_albedo::{index_at, COS_NODES, INDEX_NODES, TABLE};
    for outside in [true, false] {
        for i in [0, 9, 20, 31, 50, COS_NODES - 1] {
            for j in [0, 7, 19, INDEX_NODES - 1] {
                let row = if outside { j } else { j + INDEX_NODES };
                let stored = TABLE[row * COS_NODES + i] as f64 / 65535.0;
                let computed = table_node_albedo(i, j, outside);
                let allowed = if index_at(j) >= 1.3 { 1e-3 } else { 2e-2 };
                let place = format!("node ({}, {}), eye {}", i, j, if outside { "outside" } else { "inside" });
                assert!(stored >= computed - 1.0 / 65535.0, "{}: table {} below the albedo {}; regenerate it", place, stored, computed);
                assert!(stored <= computed + allowed, "{}: table {} far above the albedo {}; regenerate it", place, stored, computed);
            }
        }
    }
}

/// With compensation, the material must never create energy anywhere, must never lose more
/// than single scattering did, and must keep nearly all of it for every gem.
///
/// Setup: relative indices from 1 (no interface at all) through every gem's range to 4 (the
/// renderer's maximum), deliberately between the table's rows; eye angles from normal
/// incidence to 0.1 degree off grazing, deliberately between its columns; both sides. The
/// true single-scattering albedo E_ss of each is integrated with `single_scattering_albedo`
/// (192 x 192 microfacet normals, a different quadrature from the table's 512 x 512, so the
/// table is being checked against an independent estimate) and multiplied by the
/// compensation the shader would apply, which reads the table.
///
/// Test: E_ss <= compensated albedo <= 1 everywhere. For the gem indices 1.3 to 3.0 and every
/// angle up to 89 degrees, the compensated albedo is at least 0.997 (it would be 1 but for
/// the margin that keeps the interpolation from ever overshooting).
///
/// Verifies the brief's energy criterion, including at grazing angles: the compensation puts
/// back the 1-16% per interaction that single scattering drops, and the margin and floor keep
/// the table's interpolation error and the steep corner near n = 1 from ever turning into a
/// gain. Near n = 1 at grazing (E_ss down to 0.05) the floor limits the compensation to 2x, so
/// the albedo there stays below 1 on purpose; no gem has such an index.
#[test]
fn compensated_albedo_stays_between_single_scattering_and_one() {
    let indices = [1.0, 1.01, 1.05, 1.1, 1.2, 1.3, 1.434, 1.544, 1.76, 2.10712553, 2.417, 2.65, 2.76, 3.0, 3.5, 4.0];
    let angles = [0.0, 10.0, 25.0, 40.0, 55.0, 65.0, 72.0, 78.0, 83.0, 86.0, 88.0, 89.0, 89.5, 89.9];
    let mut lowest_gem: f64 = 1.0;
    for n in indices {
        for outside in [true, false] {
            for angle in angles {
                let mu = f64::to_radians(angle).cos();
                let e = single_scattering_albedo(n, mu, outside, 192);
                let compensated = e * compensation(mu, n, outside);
                let place = format!("n {} {} deg eye {}", n, angle, if outside { "outside" } else { "inside" });
                assert!(compensated <= 1.0, "{}: compensated albedo {} gains energy", place, compensated);
                assert!(compensated >= e, "{}: compensated {} below single scattering {}", place, compensated, e);
                if (1.3..=3.0).contains(&n) && angle <= 89.0 {
                    lowest_gem = lowest_gem.min(compensated);
                    assert!(compensated >= 0.997, "{}: compensated albedo only {} (E_ss {})", place, compensated, e);
                }
            }
        }
    }
    println!("lowest compensated albedo over gem indices up to 89 degrees: {}", lowest_gem);
}

/// Sample itself, not just the table arithmetic, must deliver the compensated albedo.
///
/// Setup: the compensated BSDF on CZ and on diamond, every angle of ANGLES on both sides,
/// 200,000 samples each (the R3 sequence), and the same material's single-scattering albedo
/// from the quadrature.
///
/// Test: Sample's mean energy weight equals E_ss times the compensation to within 2e-3 (the
/// sequence's own error near grazing), and is at most 1 + 2e-3 and at least 0.99.
///
/// Verifies that the albedo the table was integrated from is the albedo of the Sample the
/// shader runs (same rejections, same eta^2 bookkeeping), so that dividing by it really does
/// bring each frosted interaction to 1: the white furnace's 0.5 depends on exactly that.
#[test]
fn compensated_sample_keeps_all_the_energy() {
    for nt in [2.10712553, 2.417] {
        let glass = frosted(nt);
        for side in [1.0, -1.0] {
            for angle in ANGLES {
                let eye = direction(angle, side);
                let sampled = sampled_albedo(&glass, eye, 200_000);
                let mu = eye[2].abs();
                let expected = single_scattering_albedo(nt, mu, side > 0.0, 256) * glass.compensation_for(eye);
                let place = format!("n {} {} deg side {}", nt, angle, side);
                assert!((sampled - expected).abs() <= 2e-3, "{}: Sample {} vs quadrature {}", place, sampled, expected);
                assert!(sampled <= 1.002 && sampled >= 0.99, "{}: compensated albedo {}", place, sampled);
            }
        }
    }
}

/// The compensation breaks reciprocity by exactly the ratio of the two directions'
/// compensation factors, and no more.
///
/// Setup: CZ, eye at every angle of ANGLES on both sides, 2,000 sampled light directions each.
/// For each pair (eye, light) the BSDF value without the cosine, f = Evaluate / |cos light|,
/// is computed both ways round, single-scattering and compensated.
///
/// Test: single scattering is reciprocal in the form a dielectric's BSDF must be:
/// f(eye, light) = f(light, eye) for a reflection, and f(eye, light) = eta^2 f(light, eye)
/// for a transmission (eta = n_eye / n_light: radiance changes by n^2 across the interface),
/// to 1e-9. The compensated ratio differs from that by c(eye) / c(light) to 1e-9, and on CZ that
/// ratio stays within 1 / 0.84 either way.
///
/// Verifies what the method gives up, and bounds it. Turquin's compensation depends on the
/// eye direction only (report section 4 says so: "not reciprocal"). The renderer traces
/// paths from the eye only and weighs light sampling against BSDF sampling for a fixed eye
/// direction, which `sample_and_evaluate_are_the_same_bsdf` shows is exact, so no estimator
/// depends on reciprocity; the loss is a modelling error of at most the energy the
/// single-scattering model was dropping (about 16% at worst, inside the stone near grazing).
#[test]
fn compensation_breaks_reciprocity_only_by_the_ratio_of_the_two_factors() {
    let (ss, comp) = (single_scattering(2.10712553), frosted_cz());
    let mut worst: f64 = 1.0;
    for side in [1.0, -1.0] {
        for angle in ANGLES {
            let eye = direction(angle, side);
            for i in 0..2_000 {
                let u = r3(i);
                let Some(s) = ss.sample(eye, u[0], u[1], u[2]) else { continue };
                let light = s.dir;
                if light[2].abs() < 1e-3 {
                    continue;
                }
                let f = |g: &RoughGlass, a: V3, b: V3| g.evaluate(b, a).map(|(v, _)| v / b[2].abs());
                let (Some(forward), Some(backward)) = (f(&ss, eye, light), f(&ss, light, eye)) else { continue };
                let eta2 = if s.transmitted {
                    if side > 0.0 { (ss.nc / ss.nt).powi(2) } else { (ss.nt / ss.nc).powi(2) }
                } else {
                    1.0
                };
                assert!((forward - eta2 * backward).abs() <= 1e-9 * forward, "single scattering not reciprocal");
                let (cf, cb) = (f(&comp, eye, light).unwrap(), f(&comp, light, eye).unwrap());
                let ratio = cf / (eta2 * cb);
                let expected = comp.compensation_for(eye) / comp.compensation_for(light);
                assert!((ratio - expected).abs() <= 1e-9 * expected, "ratio {} but factors give {}", ratio, expected);
                worst = worst.max(ratio).max(1.0 / ratio);
            }
        }
    }
    assert!(worst <= 1.0 / 0.84, "reciprocity off by {}", worst);
    println!("largest reciprocity ratio on CZ: {}", worst);
}

/// The table's texture, constants and range must be what the shader and the renderer assume.
///
/// Setup: `frosted_albedo::texels()`, the constants of `frosted_albedo.rs`, `lux/entry.glsl`'s
/// text and `params::MAX_REFRACTIVE_INDEX`.
///
/// Test: the texture is COS_NODES wide and 2 INDEX_NODES high, holds the table in red (value /
/// 65535) and nothing in the other channels; the table's roughness is entry.glsl's
/// `FROSTED_FACET_ROUGHNESS`; its last row reaches the largest index the renderer allows; its
/// node formulas are the ones `albedo_lookup` inverts (node i and j read back exactly).
///
/// Verifies the ties no numeric test sees: a roughness changed in entry.glsl without
/// regenerating the table, a texture laid out differently from what the shader fetches, or an
/// index limit raised past the table's last row would all make the compensation silently wrong.
#[test]
fn frosted_albedo_table_covers_every_index_the_renderer_allows() {
    use crate::frosted_albedo::{cos_at, index_at, texels, COS_NODES, INDEX_NODES, MAX_INDEX, ROUGHNESS, TABLE};
    let (width, height, data) = texels();
    assert_eq!((width as usize, height as usize), (COS_NODES, 2 * INDEX_NODES));
    for (k, &v) in TABLE.iter().enumerate() {
        assert_eq!(data[k * 4], v as f32 / 65535.0);
        assert_eq!(&data[k * 4 + 1..k * 4 + 4], &[0.0, 0.0, 0.0]);
    }
    let entry = include_str!("shaders/lux/entry.glsl");
    assert!(entry.contains(&format!("const float FROSTED_FACET_ROUGHNESS = {:?};", ROUGHNESS)));
    assert!(MAX_INDEX >= crate::params::MAX_REFRACTIVE_INDEX as f64);
    assert_eq!(index_at(INDEX_NODES - 1), MAX_INDEX);
    // Reading exactly at a node returns that node's value, on both sides.
    for (i, j) in [(0, 0), (17, 5), (COS_NODES - 1, INDEX_NODES - 1), (40, 30)] {
        for outside in [true, false] {
            let row = if outside { j } else { j + INDEX_NODES };
            let stored = TABLE[row * COS_NODES + i] as f32 as f64 / 65535.0;
            let read = albedo_lookup(cos_at(i), index_at(j), outside);
            assert!((read - stored).abs() < 1e-6, "node ({}, {}): read {} stored {}", i, j, read, stored);
        }
    }
}

/// Sample must draw directions with the density Evaluate reports.
///
/// Setup: CZ's frosted facet, eye at 0, 45 and 80 degrees on each side; the sphere cut into
/// 2000 x 400 cells uniform in theta and phi, so the cells are finest at the poles, where the
/// lobes at normal incidence are narrowest (a grid uniform in cos(theta) has 4-degree rows
/// there and misses a fifth of the transmitted lobe).
///
/// Test: the integral of Evaluate's pdf over the sphere (midpoint rule, cell area
/// sin(theta) dtheta dphi) equals the fraction of Sample calls that return a direction, to
/// within 1% absolute.
///
/// Verifies what the first test cannot: agreeing pdfs could both be wrong in the same way, and
/// then BSDF-sampled paths would be weighted by a density they were not drawn from. The sampler
/// is Heitz's exact visible-normal construction; this checks it (and the Jacobians) against
/// the formula it is supposed to sample, D_wo(m) = G1(wo, m) <wo, m> D(m) / cos(wo).
#[test]
fn sample_draws_from_the_density_evaluate_reports() {
    let glass = frosted_cz();
    let (rows, cols) = (2000usize, 400usize);
    let pi = std::f64::consts::PI;
    for side in [1.0, -1.0] {
        for angle in [0.0, 45.0, 80.0] {
            let eye = direction(angle, side);
            let mut integral = 0.0;
            for r in 0..rows {
                let theta = pi * (r as f64 + 0.5) / rows as f64;
                let (s, z) = (theta.sin(), theta.cos());
                if z.abs() < COS_EPSILON {
                    continue;
                }
                let cell = s * (pi / rows as f64) * (2.0 * pi / cols as f64);
                for c in 0..cols {
                    let phi = 2.0 * std::f64::consts::PI * (c as f64 + 0.5) / cols as f64;
                    if let Some((_, pdf)) = glass.evaluate([s * phi.cos(), s * phi.sin(), z], eye) {
                        integral += pdf * cell;
                    }
                }
            }
            let n = 100_000;
            let succeeded = (0..n).filter(|&i| {
                let u = r3(i);
                glass.sample(eye, u[0], u[1], u[2]).is_some()
            }).count() as f64 / n as f64;
            assert!(
                (integral - succeeded).abs() < 0.01,
                "{} deg, side {}: pdf integrates to {} but Sample succeeds {} of the time",
                angle, side, integral, succeeded
            );
        }
    }
}

/// GGX at alpha = u = v is the same distribution of microfacet normals LuxCore's Schlick
/// distribution had at r = u * v.
///
/// Setup: LuxCore's Schlick Z (materialdefs_funcs_generic.cl:126-135, as the T-0183 port had
/// it) at r = 0.2 * 0.2, and `ggx_d` at alpha = 0.2, over microfacet normals from 0 to 89
/// degrees.
///
/// Test: Z / pi equals GGX's D to 1e-12 relative.
///
/// Verifies the roughness mapping the file header states and the user's decision rests on:
/// "roughness 0.2" still means the same spread of microfacets after T-0269, so the change is the
/// shadowing and the sampling, not the look of the frost. If someone maps alpha = roughness^2
/// (another common convention) this fails.
#[test]
fn ggx_at_the_users_roughness_is_luxcores_schlick_distribution() {
    let roughness: f64 = 0.2;
    let r = roughness * roughness;
    let alpha = [roughness, roughness];
    for tenth_degrees in 0..890 {
        let t = (tenth_degrees as f64 / 10.0).to_radians();
        let m = [t.sin(), 0.0, t.cos()];
        let c2 = t.cos() * t.cos();
        let d = c2 * r + (1.0 - c2);
        let schlick = (r / d) / d / std::f64::consts::PI;
        let ggx = ggx_d(m, alpha);
        assert!((schlick - ggx).abs() <= 1e-12 * ggx, "at {} deg: Schlick {} vs GGX {}", t.to_degrees(), schlick, ggx);
    }
}

/// The mirror above must still be a mirror of the shader.
///
/// Setup: the text of `lux/roughglass.glsl`, comments stripped (lib.rs's own stripper).
///
/// Test: the load-bearing lines the tests above exercise are present verbatim: the alpha
/// mapping, D, Lambda, the chi+ test in G1, the visible-normal pdf, the Fresnel-proportional
/// choice, both pdfs and both weights in Sample, both results and pdfs in Evaluate. And none of
/// the Schlick port's functions remain. Since T-0271 also the energy compensation: the table
/// layout constants (built from `frosted_albedo.rs`'s, so the two cannot drift), the margin and
/// floor (built from this file's), the lookup's coordinates, row choice and bilinear blend, and
/// the compensation applied to Evaluate's result and Sample's weight from the eye direction.
///
/// Verifies that the numeric tests are testing the shipped BSDF. An edit to the GLSL that is
/// not carried into this file (or the reverse) fails here, and the message names the line.
#[test]
fn the_mirror_matches_the_shader_text() {
    use crate::frosted_albedo::{COS_NODES, INDEX_NODES, MAX_INDEX};
    let source = crate::strip_glsl_comments(include_str!("shaders/lux/roughglass.glsl"));
    for line in [
        format!("const int FROSTED_ALBEDO_COS_NODES = {};", COS_NODES),
        format!("const int FROSTED_ALBEDO_INDEX_NODES = {};", INDEX_NODES),
        format!("const float FROSTED_ALBEDO_MAX_INDEX = {:?};", MAX_INDEX),
        format!("const float FROSTED_ALBEDO_MARGIN = {:e};", ALBEDO_MARGIN),
        format!("const float FROSTED_ALBEDO_FLOOR = {:?};", ALBEDO_FLOOR),
    ] {
        assert!(source.contains(&line), "lux/roughglass.glsl no longer contains `{}`", line);
    }
    for line in [
        "float x = sqrt(clamp(cosEye, 0.0, 1.0)) * float(FROSTED_ALBEDO_COS_NODES - 1);",
        "float y = sqrt(clamp((n - 1.0) / (FROSTED_ALBEDO_MAX_INDEX - 1.0), 0.0, 1.0)) * float(FROSTED_ALBEDO_INDEX_NODES - 1);",
        "int i = min(int(x), FROSTED_ALBEDO_COS_NODES - 2);",
        "int j = min(int(y), FROSTED_ALBEDO_INDEX_NODES - 2);",
        "int row = eyeOutside ? j : j + FROSTED_ALBEDO_INDEX_NODES;",
        "float e11 = texelFetch(uFrostedAlbedo, ivec2(i + 1, row + 1), 0).r;",
        "return mix(mix(e00, e10, fx), mix(e01, e11, fx), fy);",
        "return 1.0 / clamp(RoughGlassMaterial_SingleScatteringAlbedo(cosEye, n, eyeOutside) + FROSTED_ALBEDO_MARGIN, FROSTED_ALBEDO_FLOOR, 1.0);",
        "result *= RoughGlassMaterial_EnergyCompensation(fabs(eyeDir.z), ntc, eyeDir.z > 0.0);",
        "result *= RoughGlassMaterial_EnergyCompensation(fabs(fixedDir.z), ntc, fixedDir.z > 0.0);",
    ] {
        assert!(source.contains(line), "lux/roughglass.glsl no longer contains `{}`", line);
    }
    for line in [
        "return vec2(clamp(nuVal, 1e-9, 1.0), clamp(nvVal, 1e-9, 1.0));",
        "return 1.0 / (M_PI_F * alpha.x * alpha.y * t * t);",
        "return 0.5 * (sqrt(1.0 + a2t2) - 1.0);",
        "if (dot(v, m) * v.z <= 0.0)",
        "return GGX_G1(wo, m, alpha) * max(0.0, dot(wo, m)) * GGX_D(m, alpha) / wo.z;",
        "p2 = (1.0 - s) * sqrt(max(0.0, 1.0 - p1 * p1)) + s * p2;",
        "return normalize(vec3(alpha.x * nh.x, alpha.y * nh.y, max(1e-6, nh.z)));",
        "return F;",
        "float F = FresnelCauchy_Evaluate(ntc, side * cosOM);",
        "wi = (eta * cosOM - cosThetaTM) * m - eta * wo;",
        "pdfW = pT * pm * cosThetaTM / denom;",
        "result = kt * (GGX_G1(wi, m, alpha) * eta2);",
        "wi = 2.0 * cosOM * m - wo;",
        "pdfW = pR * pm / (4.0 * cosOM);",
        "result = kr * GGX_G1(wi, m, alpha);",
        "directPdfW = pT * GGX_VisibleNormalPdf(wo, m, alpha) * fabs(cosIM) / denom;",
        "result = (eta * eta * D * G * cosOM * fabs(cosIM) / (wo.z * denom)) * kt * (1.0 - F);",
        "directPdfW = pR * GGX_VisibleNormalPdf(wo, m, alpha) / (4.0 * cosOM);",
        "result = (D * G / (4.0 * wo.z)) * kr * F;",
    ] {
        assert!(source.contains(line), "lux/roughglass.glsl no longer contains `{}`", line);
    }
    for gone in ["SchlickDistribution_", "threshold"] {
        assert!(!source.contains(gone), "lux/roughglass.glsl still uses the Schlick port's `{}`", gone);
    }
}
