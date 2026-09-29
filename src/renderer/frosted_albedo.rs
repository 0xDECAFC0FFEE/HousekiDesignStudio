//! The frosted facets' single-scattering albedo table (T-0271): what fraction of the light
//! arriving at a frosted facet the single-scattering GGX rough dielectric of
//! `shaders/lux/roughglass.glsl` sends on, as a function of the angle it is seen from, the
//! stone's refractive index and the side of the facet it is seen from. The shader divides the
//! BSDF by it, which puts back the light that bounces between microfacets before leaving
//! (multiple scattering) and that the single-scattering model drops. See the GLSL file's
//! header for the method (Turquin 2019, eq. 18) and why it was chosen.
//!
//! The numbers are generated, not hand-written: `rough_glass.rs`'s ignored test
//! `regenerate_the_frosted_albedo_table` integrates the float64 mirror of the BSDF at every
//! node and rewrites `frosted_albedo_table.rs`. They are checked in, so the build never
//! computes or reads anything outside `src/` (CLAUDE.md), and
//! `the_frosted_albedo_table_is_the_mirrors_albedo` recomputes a spread of nodes on every
//! `cargo test`, so a change to the BSDF that is not followed by a regeneration fails.
//!
//! # Layout
//!
//! Two tables of `COS_NODES` x `INDEX_NODES` values, one per side of the facet the eye is on:
//!
//! * column `i` is the eye direction's cosine to the facet normal `mu = (i / (COS_NODES -
//!   1))^2`: square-root spacing, because the albedo changes fastest near grazing;
//! * row `j` is the relative refractive index (stone over outside) `n = 1 + (MAX_INDEX - 1)
//!   (j / (INDEX_NODES - 1))^2`, square-root spacing again, because the albedo changes fastest
//!   near n = 1, where the interface vanishes. It spans every index the Material panel and
//!   `params::MAX_REFRACTIVE_INDEX` allow; LuxCore's interior index is Cauchy's A, which is
//!   below the refractive index, so it is always in range too;
//! * rows `0 .. INDEX_NODES` are for an eye outside the stone, rows `INDEX_NODES ..
//!   2 INDEX_NODES` for an eye inside it.
//!
//! Each value is the albedo times 65535, rounded: 1.5e-5 of resolution, far below the
//! bilinear interpolation error (a few 1e-4), in half the space of an `f32` table. The
//! shader reads the table as a `COS_NODES` x `2 INDEX_NODES` RGBA32F data texture
//! (`uFrostedAlbedo`, red channel) and interpolates it bilinearly itself, because WebGL2 does
//! not promise linear filtering of float textures.

/// Columns: nodes of the eye direction's cosine, square-root spaced.
pub const COS_NODES: usize = 64;

/// Rows per side: nodes of the relative refractive index, square-root spaced from 1.
pub const INDEX_NODES: usize = 32;

/// The largest relative index the table covers; larger ones read its last row.
/// `params::MAX_REFRACTIVE_INDEX`, and `frosted_albedo_table_covers_every_index_the_renderer_allows`
/// holds them together.
// Layout facts the tests and the generator read; the renderer itself only needs `texels`.
#[cfg_attr(not(test), allow(dead_code))]
pub const MAX_INDEX: f64 = 4.0;

/// The microfacet roughness (GGX alpha) the table was integrated at: `FROSTED_FACET_ROUGHNESS`
/// in `lux/entry.glsl`. The table is only right at that roughness, and a test holds the two
/// together, so changing the roughness now means regenerating the table as well.
// Layout facts the tests and the generator read; the renderer itself only needs `texels`.
#[cfg_attr(not(test), allow(dead_code))]
pub const ROUGHNESS: f64 = 0.2;

/// The table, `2 * INDEX_NODES` rows of `COS_NODES` values, row-major; see the module docs.
pub const TABLE: [u16; 2 * INDEX_NODES * COS_NODES] = include!("frosted_albedo_table.rs");

/// The cosine of the eye direction at column `i`.
// Layout facts the tests and the generator read; the renderer itself only needs `texels`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn cos_at(i: usize) -> f64 {
    let t = i as f64 / (COS_NODES - 1) as f64;
    t * t
}

/// The relative refractive index at row `j` (of either side's table).
// Layout facts the tests and the generator read; the renderer itself only needs `texels`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn index_at(j: usize) -> f64 {
    let s = j as f64 / (INDEX_NODES - 1) as f64;
    1.0 + (MAX_INDEX - 1.0) * s * s
}

/// The table as the texels of the `COS_NODES` x `2 INDEX_NODES` RGBA32F texture the shader
/// reads: `(width, height, data)`, the albedo in red, the other channels 0. Pure, so the
/// layout the shader relies on is testable without a GL context.
pub fn texels() -> (u32, u32, Vec<f32>) {
    let mut data = vec![0.0f32; TABLE.len() * 4];

    for (texel, &value) in TABLE.iter().enumerate() {
        data[texel * 4] = value as f32 / 65535.0;
    }

    (COS_NODES as u32, (2 * INDEX_NODES) as u32, data)
}
