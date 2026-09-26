//! Tilt performance (T-0261): how much light a stone returns as it is tilted.
//!
//! Gem Cut Studio's Tools > Tilt Performance graph, from its manual (v1.1.0, p. 27): the stone
//! is rendered at each angle of a tilt about the screen's X axis and then about its Y axis, and
//! each curve is "a sum of brightness values across the surface of the stone when rendered at
//! each angle". The curves are ISO and COS brightness (the Isometric and Cosine lighting
//! models), Window (light seen through the stone from behind it) and Head Shadow (light the
//! observer's head blocks); each has a dotted twin counted over the table alone.
//!
//! The renderer measures a pose by drawing it twice off screen, at a fixed size, with the page's
//! own deterministic renderer (`TiltPass`): a mask of which pixels are stone and table, then one
//! trace that scores every ray leaving the stone as all four quantities at once, one per channel
//! (gem.frag's renderTiltMeasure). The pixels are read back and averaged here. This module is
//! the part that needs no GL context: which facets are the table, what each pass sets, and how
//! the pixels become the numbers on the graph.
//!
//! Until 2026-09-26 each quantity was its own render, with the lighting and colours chosen so
//! the image WAS that quantity, and nothing in the shader was special to the tool. The four
//! followed the same rays and differed only in how an escape was scored, so tracing them once
//! does a quarter of the work (the user: "can we speed it up ... gcs gets the data in 1
//! second"). The scoring rules are unchanged; `TiltPass::Quantities` says what each was.

use nalgebra::Vector3;

use crate::params::{LightingModel, RenderParams, ToneMapMode};

/// The size every tilt-performance pose is rendered at, whatever the size of the page.
///
/// The user (2026-09-25): "make sure the rendering isn't a function of the actual user's screen
/// size and is fixed, for now we can use the same screen size as the renderings we use for
/// compare.html". Those were 1168 x 978, Gem Cut Studio's own viewport as measured from its
/// screenshots (kb/gcs-reference-matching.md, "The framing rule"), with the stone about 735 px
/// across. Then (2026-09-25): "when measuring the brightness, can you do with resolution
/// w=200px" -- so 200 px wide, and 167 tall to keep the same aspect (the framing depends only on
/// the aspect), with the stone about 126 px across. Each pose is then about 34 times fewer
/// pixels; kb/tilt-performance.md has what the smaller sizes cost in agreement with GCS.
pub const TILT_RENDER_WIDTH: u32 = 200;
pub const TILT_RENDER_HEIGHT: u32 = 167;

/// How many poses are drawn together, as tiles of one image (`GemApp::tilt_begin`): twelve, four
/// to a row, an 800 x 501 image. Enough that a sweep of 68 poses is six batches, so the per-draw
/// and per-read-back costs that dominated one pose at a time are paid a dozen times instead of
/// hundreds; few enough that no one draw runs long enough to hold up the page's own frames.
pub const TILT_BATCH: usize = 12;
pub const TILT_BATCH_COLUMNS: usize = 4;

/// How many batches the page may have queued on the GPU at once: two, so the GPU always has the
/// next batch to draw while the page collects the last one.
pub const TILT_IN_FLIGHT: usize = 2;

/// Where each pose of a batch is in the batch's image: tiles of `TILT_RENDER_WIDTH` x
/// `TILT_RENDER_HEIGHT`, `columns` to a row, filling rows from the bottom of the image (GL's
/// first row), left to right. Mirrors gem.frag's renderTiltMeasure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileLayout {
    pub columns: usize,
    pub rows: usize,
    pub tile_width: usize,
    pub tile_height: usize,
}

impl TileLayout {
    /// The layout every batch is drawn in, however many poses it holds: an image sized for a
    /// full batch, `TILT_BATCH_COLUMNS` tiles to a row.
    pub fn batch() -> TileLayout {
        TileLayout {
            columns: TILT_BATCH_COLUMNS,
            rows: TILT_BATCH.div_ceil(TILT_BATCH_COLUMNS),
            tile_width: TILT_RENDER_WIDTH as usize,
            tile_height: TILT_RENDER_HEIGHT as usize,
        }
    }

    pub fn width(&self) -> u32 {
        (self.columns * self.tile_width) as u32
    }

    pub fn height(&self) -> u32 {
        (self.rows * self.tile_height) as u32
    }
}

/// How close to the optical axis, as the cosine of the angle between them, a facet's outward
/// normal must be for the facet to count as the table: within half a degree. A table is cut at
/// exactly 0 degrees, so this only has to absorb float noise in the normal (about 1e-6); no
/// crown facet a design would cut sits within half a degree of the table.
pub const TABLE_NORMAL_COSINE: f32 = 0.999_961_9; // cos(0.5 degrees)

/// The facets that form the table: those whose outward normal, in the model file's frame
/// (optical axis +Z, table up, as `GemApp::facet_normals` gives them), points straight up the
/// axis. Empty for a stone with no table, such as one whose crown comes to a point.
pub fn table_facets(facet_normals: &[Vector3<f32>]) -> Vec<u32> {
    facet_normals
        .iter()
        .enumerate()
        .filter(|(_, normal)| {
            let length = normal.norm();

            length > 0.0 && normal.z / length >= TABLE_NORMAL_COSINE
        })
        .map(|(facet, _)| facet as u32)
        .collect()
}

/// The two images a pose is drawn as: the mask, then the four quantities.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TiltPass {
    /// Which pixels are stone and which of those are table: every light source black, the
    /// backdrop white, and the table facets tinted by the selection highlight, so a pixel reads
    /// white (background), black (stone) or the tint (table). See `classify_mask_pixel`.
    Mask,
    /// ISO brightness, COS brightness, window and head shadow in R, G, B and A, each a grey level
    /// between 0 and 1, so its average over the stone is that quantity. They were four renders
    /// until 2026-09-26, and are scored as those were:
    ///
    /// - **ISO**, the stone under the Isometric model: light from the upper hemisphere is 1, the
    ///   head shadow and the window (light from behind the stone) are black -- and a path that
    ///   runs out of bounces counts as fully lit, not at the render's half shade. That is what
    ///   Gem Cut Studio's graph does: its ISO and Window curves add up to 100% at every angle of
    ///   the hex cut's graph (92 + 8 face-up, 74 + 26 at X 33). Measured at 16 bounces, the half
    ///   shade put ISO 1.4-2.6 points under the graph all the way across; a full one puts it
    ///   within about half a point (T-0261). More bounces is not the explanation: at 32, ISO
    ///   fell, since most of the light the fill stood for leaves through the back.
    /// - **COS**, the Cosine model with a true cosine law (see `RenderParams::true_cosine`), and
    ///   paths that run out of bounces counted as dark: with the half shade the curve sat about a
    ///   point over Gem Cut Studio's, face-up and at the ends.
    /// - **Window**: light arriving from behind the stone.
    /// - **Head shadow**: light the head shadow cone blocks. The observer's body, which draws the
    ///   face-up centre dot in the head shadow colour, counts here too.
    Quantities,
}

impl TiltPass {
    pub const ALL: [TiltPass; 2] = [TiltPass::Mask, TiltPass::Quantities];

    /// `base` (the page's own settings) set up for this pass.
    ///
    /// What is kept from the page: the material's refractive index and dispersion, the bounce
    /// limit, the out-of-bounces shade, the observer and the head shadow's angle -- the render
    /// settings the graph is meant to report on. What is not: the stone's colour (Gem Cut
    /// Studio's manual has the material "reset to pure white" for its analytical models, and its
    /// ISO curve of a grey stone still starts at 91%), the renderer (always the deterministic
    /// one: a Monte Carlo pose would be noise), the exposure, and every colour. The quantities
    /// pass scores escapes by its own rules (`TiltPass::Quantities`), whatever the colours.
    pub fn params(self, base: &RenderParams) -> RenderParams {
        let mut params = base.clone();

        params.renderer = crate::params::Renderer::Deterministic;
        params.debug_mode = crate::params::DebugMode::Full;
        params.wireframe = false;
        params.absorption = Vector3::zeros();
        params.absorption_scale = 0.0;
        params.exposure = 1.0;
        params.env_intensity = 1.0;
        params.tone_map_mode = ToneMapMode::Linear;
        params.lighting_follows_view = true;
        params.lighting_model = LightingModel::Isometric;
        params.use_background_color = true;
        params.background_color = Vector3::zeros();
        params.use_window_color = true;
        params.window_color = Vector3::zeros();
        params.head_shadow_color = Vector3::zeros();

        match self {
            // Only the primary hit matters: the shader draws the backdrop white, the stone black
            // and the table tint without tracing into the stone at all (gem.frag's
            // renderTiltMeasure), in the colours `classify_mask_pixel` reads. The rest is set as
            // an ordinary render of it would be, for anything that reads the params.
            TiltPass::Mask => {
                params.tilt_measure = crate::params::TILT_MEASURE_MASK;
                params.env_intensity = 0.0;
                params.exhaustion_shade = 0.0;
                params.background_color = Vector3::new(1.0, 1.0, 1.0);
                params.max_bounces = crate::params::MIN_BOUNCES;
            }
            TiltPass::Quantities => params.tilt_measure = crate::params::TILT_MEASURE_QUANTITIES,
        }

        params.clamp();

        params
    }
}

/// How a pixel's three channels -- with dispersion on, three wavelengths -- are weighed into
/// one brightness: Rec. 601 luminance, not a plain mean. Applied in the shader before each
/// quantity is written (renderTiltMeasure's LUMINANCE, which must match). The two agree to a
/// hundredth of a point on the hex cut (dispersion 0.06), and on the asterisk illusion (dispersion 0.24, where the
/// channels come far apart) luminance tracked Gem Cut Studio's graph a little closer: mean error
/// 2.41 / 2.88 points on Tilt X / Y against 2.60 / 2.98 (T-0261).
pub const CHANNEL_WEIGHTS: [f64; 3] = [0.299, 0.587, 0.114];

/// What one pixel of the mask pass shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaskPixel {
    Background,
    Stone,
    Table,
}

/// Reads one RGBA pixel of the mask pass. The background is white (255), a stone pixel black
/// (0, since every light is off), and a table pixel the selection tint over black -- 75% of
/// nord0, about (35, 39, 48) -- so the thresholds sit far from all three.
pub fn classify_mask_pixel(pixel: &[u8]) -> MaskPixel {
    let brightest = pixel[0].max(pixel[1]).max(pixel[2]);

    if brightest > 160 {
        MaskPixel::Background
    } else if brightest > 12 {
        MaskPixel::Table
    } else {
        MaskPixel::Stone
    }
}

/// One pose's sums, over the whole stone and over the table alone. Each quantity is the sum
/// over the pixels of its grey level in that pixel (0 to 1): the Rec. 601 luminance of the
/// three colour channels, which the shader takes before writing it.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TiltSums {
    /// Pixels that are stone, table included, and pixels that are table.
    pub stone_pixels: f64,
    pub table_pixels: f64,
    /// Indexed like `QUANTITIES`: iso, cos, window, head shadow.
    pub stone: [f64; 4],
    pub table: [f64; 4],
}

impl TiltSums {
    /// Sums the quantities image over the pixels the mask says are stone (and table). Both
    /// images are RGBA, row by row, the same size.
    pub fn from_images(mask: &[u8], quantities: &[u8]) -> TiltSums {
        let mut sums = TiltSums::from_mask(mask);

        sums.add_quantities(mask, quantities);

        sums
    }

    /// Sums tile `index` of a batch's mask and quantities images (`layout` says where it is):
    /// what `from_images` gives for that pose's own images.
    pub fn from_tile(mask: &[u8], quantities: &[u8], layout: &TileLayout, index: usize) -> TiltSums {
        let row_bytes = layout.columns * layout.tile_width * 4;
        let left = (index % layout.columns) * layout.tile_width * 4;
        let bottom = (index / layout.columns) * layout.tile_height;
        let mut sums = TiltSums::default();

        for y in bottom..bottom + layout.tile_height {
            let start = y * row_bytes + left;
            let end = start + layout.tile_width * 4;

            let mut row = TiltSums::from_mask(&mask[start..end]);

            row.add_quantities(&mask[start..end], &quantities[start..end]);
            sums.add(&row);
        }

        sums
    }

    /// Adds `other`'s counts and sums to these.
    fn add(&mut self, other: &TiltSums) {
        self.stone_pixels += other.stone_pixels;
        self.table_pixels += other.table_pixels;

        for quantity in 0..4 {
            self.stone[quantity] += other.stone[quantity];
            self.table[quantity] += other.table[quantity];
        }
    }

    /// The pixel counts of a mask image, with every quantity still zero: the first step of
    /// folding a pose's passes in, as `GemApp::tilt_poll` does.
    pub fn from_mask(mask: &[u8]) -> TiltSums {
        let mut sums = TiltSums::default();

        for pixel in mask.chunks_exact(4) {
            match classify_mask_pixel(pixel) {
                MaskPixel::Background => {}
                MaskPixel::Stone => sums.stone_pixels += 1.0,
                MaskPixel::Table => {
                    sums.stone_pixels += 1.0;
                    sums.table_pixels += 1.0;
                }
            }
        }

        sums
    }

    /// Adds the quantities image (`TiltPass::Quantities`: ISO, COS, window and head shadow in
    /// R, G, B and A) over the pixels `mask` says are stone, and table.
    pub fn add_quantities(&mut self, mask: &[u8], image: &[u8]) {
        for (pixel, value) in mask.chunks_exact(4).zip(image.chunks_exact(4)) {
            let kind = classify_mask_pixel(pixel);

            if kind == MaskPixel::Background {
                continue;
            }

            for quantity in 0..4 {
                let grey = value[quantity] as f64 / 255.0;

                self.stone[quantity] += grey;

                if kind == MaskPixel::Table {
                    self.table[quantity] += grey;
                }
            }
        }
    }

    /// The numbers the graph plots, as fractions: iso, cos, window and head shadow averaged
    /// over the stone, then the same four averaged over the table (0 where there is no table in
    /// view), then the stone's and the table's pixel counts.
    pub fn to_vec(&self) -> Vec<f32> {
        let mut values = Vec::with_capacity(10);

        for quantity in 0..4 {
            values.push(average(self.stone[quantity], self.stone_pixels));
        }

        for quantity in 0..4 {
            values.push(average(self.table[quantity], self.table_pixels));
        }

        values.push(self.stone_pixels as f32);
        values.push(self.table_pixels as f32);

        values
    }
}

fn average(sum: f64, count: f64) -> f32 {
    if count > 0.0 {
        (sum / count) as f32
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Setup: three facet normals in the file frame -- one straight up the axis (a table), one
    // tipped 10 degrees (a crown facet), one pointing down (a pavilion facet), plus a table
    // normal carrying float noise and not unit length.
    // Test: table_facets picks them out.
    // Verifies: only facets facing straight up the axis are the table, noise and scale do not
    // matter, and a steep crown facet is never mistaken for one.
    #[test]
    fn the_table_is_every_facet_facing_straight_up_the_axis() {
        let tipped = 10.0f32.to_radians();
        let normals = [
            Vector3::new(0.0, 0.0, 1.0),
            Vector3::new(tipped.sin(), 0.0, tipped.cos()),
            Vector3::new(0.3, 0.0, -0.95),
            Vector3::new(1e-6, -2e-6, 3.0),
        ];

        assert_eq!(table_facets(&normals), vec![0, 3]);
    }

    // Setup: a stone whose crown comes to a point, so no facet faces straight up.
    // Test: table_facets on its normals.
    // Verifies: no table is an empty list, not an error, so the page can hide the dotted curves.
    #[test]
    fn a_stone_without_a_table_has_no_table_facets() {
        let normals = [Vector3::new(0.2, 0.0, 0.98), Vector3::new(-0.2, 0.0, 0.98)];

        assert!(table_facets(&normals).is_empty());
    }

    // Setup: the three colours the mask pass can produce -- the white backdrop, a black stone
    // pixel, and the selection tint over black (75% of nord0 (46, 52, 64)) -- plus a pixel of
    // each with a level of rounding noise.
    // Test: classify_mask_pixel on each.
    // Verifies: the three are told apart with margin on both sides of each threshold.
    #[test]
    fn mask_pixels_are_background_stone_or_table() {
        let tint = [(46.0f32 * 0.75) as u8, (52.0f32 * 0.75) as u8, (64.0f32 * 0.75) as u8];

        assert_eq!(classify_mask_pixel(&[255, 255, 255, 255]), MaskPixel::Background);
        assert_eq!(classify_mask_pixel(&[254, 255, 253, 255]), MaskPixel::Background);
        assert_eq!(classify_mask_pixel(&[0, 0, 0, 255]), MaskPixel::Stone);
        assert_eq!(classify_mask_pixel(&[1, 0, 1, 255]), MaskPixel::Stone);
        assert_eq!(classify_mask_pixel(&[tint[0], tint[1], tint[2], 255]), MaskPixel::Table);
        assert_eq!(
            classify_mask_pixel(&[tint[0] + 1, tint[1] - 1, tint[2], 255]),
            MaskPixel::Table
        );
    }

    // Setup: a four-pixel image -- background, two stone pixels, one table pixel -- with the
    // quantities image holding known levels of ISO, COS, window and head shadow in its four
    // channels (the background pixel's are non-zero, as a stray value would be).
    // Test: TiltSums::from_images, then to_vec.
    // Verifies: background pixels are ignored; each channel is its own quantity; the
    // whole-stone averages include the table; the table averages use the table pixels alone;
    // and the pixel counts come last.
    #[test]
    fn sums_average_each_quantity_over_the_stone_and_the_table() {
        let mask = [
            255, 255, 255, 255, // background
            0, 0, 0, 255, // stone
            0, 0, 0, 255, // stone
            34, 39, 48, 255, // table
        ];
        let quantities = [
            9, 9, 9, 7, // background: ignored
            255, 51, 0, 0, // stone
            0, 0, 0, 0, // stone
            255, 51, 0, 102, // table
        ];

        let values = TiltSums::from_images(&mask, &quantities).to_vec();

        let expected = [
            (1.0 + 0.0 + 1.0) / 3.0, // iso over the three stone pixels
            (0.2 + 0.0 + 0.2) / 3.0,
            0.0,
            0.4 / 3.0,
            1.0, // iso over the table pixel
            0.2,
            0.0,
            0.4,
            3.0, // stone pixels
            1.0, // table pixels
        ];

        for (got, want) in values.iter().zip(expected.iter()) {
            assert!((*got as f64 - want).abs() < 1e-6, "{:?} vs {:?}", values, expected);
        }
    }

    // Setup: a batch image of three 2 x 1 tiles, two to a row (so the third starts the second
    // row, and the fourth tile's place is empty), each tile holding a different pattern: tile 0
    // two stone pixels at ISO 1, tile 1 a table pixel at COS 0.2 and a background pixel, tile 2 a
    // stone pixel at window 0.4 and a background pixel.
    // Test: TiltSums::from_tile for each tile.
    // Verifies: each tile's sums are exactly its own pixels' -- the rows run from the bottom of
    // the image, tiles fill a row left to right, and a tile never reads its neighbour's pixels.
    #[test]
    fn a_batch_image_sums_each_tile_on_its_own() {
        let layout = TileLayout { columns: 2, rows: 2, tile_width: 2, tile_height: 1 };
        let stone = [0u8, 0, 0, 255];
        let table = [34u8, 39, 48, 255];
        let background = [255u8, 255, 255, 255];
        // Row 0 (the bottom): tile 0, tile 1. Row 1: tile 2, and the empty fourth place.
        let mask: Vec<u8> = [stone, stone, table, background, stone, background, background, background]
            .concat();
        let quantities: Vec<u8> = [
            [255u8, 0, 0, 0],
            [255, 0, 0, 0],
            [0, 51, 0, 0],
            [9, 9, 9, 9],
            [0, 0, 102, 0],
            [9, 9, 9, 9],
            [9, 9, 9, 9],
            [9, 9, 9, 9],
        ]
        .concat();

        let first = TiltSums::from_tile(&mask, &quantities, &layout, 0).to_vec();
        let second = TiltSums::from_tile(&mask, &quantities, &layout, 1).to_vec();
        let third = TiltSums::from_tile(&mask, &quantities, &layout, 2).to_vec();

        assert_eq!(first, vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0]);
        assert_eq!(second, vec![0.0, 0.2, 0.0, 0.0, 0.0, 0.2, 0.0, 0.0, 1.0, 1.0]);
        assert_eq!(third, vec![0.0, 0.0, 0.4, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
    }

    // Setup: a mask with no table pixel in it (the table turned away, or no table at all).
    // Test: the table averages.
    // Verifies: they are 0 rather than NaN, which the page would otherwise plot as a gap or a
    // spike.
    #[test]
    fn no_table_in_view_averages_to_zero_not_nan() {
        let mask = [0, 0, 0, 255];
        let grey = [128, 128, 128, 128];

        let values = TiltSums::from_images(&mask, &grey).to_vec();

        assert!(values[4..8].iter().all(|value| *value == 0.0));
        assert_eq!(values[9], 0.0);
    }

    // Setup: the page's defaults, with a coloured stone, the filmic transfer, the Monte Carlo
    // renderer, a head shadow of 14 degrees and 16 bounces.
    // Test: TiltPass::params for every pass.
    // Verifies: every pass renders deterministically, colourless, linearly, at exposure 1 and
    // with the lighting on the viewer (the quantities are read as grey levels, and the lighting
    // frame decides what is window and head shadow), keeps the head shadow angle, bounces and
    // refractive index it was given; only the quantities pass switches the shader to measuring;
    // and the mask's backdrop is white on black light.
    #[test]
    fn each_pass_measures_and_keeps_the_render_settings() {
        let mut base = RenderParams::default();

        base.renderer = crate::params::Renderer::LuxCore;
        base.absorption = Vector3::new(0.3, 0.1, 0.5);
        base.absorption_scale = 1.0;
        base.tone_map_mode = ToneMapMode::Filmic;
        base.head_shadow_half_angle = 14.0f32.to_radians();
        base.max_bounces = 16;
        base.exhaustion_shade = 0.5;

        for pass in TiltPass::ALL {
            let params = pass.params(&base);

            assert_eq!(params.renderer, crate::params::Renderer::Deterministic);
            assert_eq!(params.effective_absorption(), Vector3::zeros());
            assert_eq!(params.tone_map_mode, ToneMapMode::Linear);
            assert!(params.lighting_follows_view);
            assert!(!params.wireframe);
            assert_eq!(params.head_shadow_half_angle, base.head_shadow_half_angle);
            // The mask only needs the primary hit, so it traces as few bounces as allowed.
            if pass == TiltPass::Mask {
                assert_eq!(params.max_bounces, crate::params::MIN_BOUNCES);
            } else {
                assert_eq!(params.max_bounces, 16);
            }
            assert_eq!(params.refractive_index, base.refractive_index);
            assert!(params.use_window_color);
            assert_eq!(params.exposure, 1.0);
        }

        // Each pass switches the shader to its own measuring mode.
        assert_eq!(
            TiltPass::Quantities.params(&base).tilt_measure,
            crate::params::TILT_MEASURE_QUANTITIES
        );
        assert_eq!(TiltPass::Mask.params(&base).tilt_measure, crate::params::TILT_MEASURE_MASK);
        assert_eq!(base.tilt_measure, crate::params::TILT_MEASURE_OFF);

        let mask = TiltPass::Mask.params(&base);
        assert_eq!(mask.env_intensity, 0.0);
        assert!(mask.use_background_color);
        assert_eq!(mask.background_color, Vector3::new(1.0, 1.0, 1.0));
        assert_eq!(mask.head_shadow_color, Vector3::zeros());
    }
}
