//! Small off-screen previews of stones other than the one on screen (T-0273, the manual
//! optimizer).
//!
//! Edit > Manual optimizer shows a grid of the design at many crown and pavilion heights, each
//! cell a picture of that version of the stone, while the stone on screen stays the one the user
//! is looking at. So the grid's stones cannot be loaded with `load_obj`, which replaces the
//! stone on screen (and restarts a Monte Carlo accumulation every time). They are kept here
//! instead, each built once into its own geometry textures under an id the page chooses
//! (`thumbnail_load`), and drawn on request (`thumbnail_begin`) by swapping them into the
//! renderer for the length of one off-screen draw, then swapping the stone on screen back.
//!
//! **Always the deterministic renderer.** A cell is one draw; a Monte Carlo cell would be noise
//! at one sample and cost seconds at many, times up to 49 cells. The page's own render settings
//! (material, lighting, colours, bounces) are used as they are, so the grid looks like the
//! preview drawn deterministically.
//!
//! **The same frame for every cell.** `load_obj` centres and scales each stone so its furthest
//! corner is at radius 1, which would make a tall stone look small rather than tall. The page
//! passes one frame for the whole grid (`thumbnail_load`'s centre and radius, the smallest sphere
//! round the tallest stone of the grid), so a taller crown reads as taller.
//!
//! **Nothing waits for the GPU.** A draw is read back through a pixel-pack buffer behind a fence,
//! as tilt performance's batches are (`gpu::ReadbackTarget`); `thumbnail_poll` asks the fence and
//! `thumbnail_pixels` hands the picture over once it has signalled. One draw is in flight at a
//! time: the page asks for the next when it has the last.

use std::collections::HashMap;

use wasm_bindgen::prelude::*;
use web_sys::{WebGl2RenderingContext as Gl, WebGlSync, WebGlTexture};

use crate::camera::OrbitCamera;
use crate::params::{DebugMode, RenderParams, Renderer, TILT_MEASURE_OFF};
use crate::{
    build_facet_mask_texture, build_model, gpu, js_error, GemApp, ModelResources, ProgramKind,
    ProgramState, LUX_PASS_DIRECT,
};

/// The largest side a preview may be drawn at, in pixels. A grid cell is at most a few hundred
/// CSS pixels across; this keeps a stray request from allocating a canvas-sized target.
pub const THUMBNAIL_MAX_SIZE: u32 = 1024;

/// One stone of the grid: its geometry textures, and a per-facet mask texture of its own size
/// with nothing in it, bound as the highlight while it draws (the stone on screen's highlight
/// names facet ids of a different mesh).
pub(crate) struct ThumbnailModel {
    model: ModelResources,
    blank_mask: WebGlTexture,
}

/// A preview drawn and queued for reading back.
struct ThumbnailJob {
    fence: WebGlSync,
    width: u32,
    height: u32,
}

/// The stones the page has loaded for previews, the target they are drawn into, the draw in
/// flight and the last picture read back.
#[derive(Default)]
pub(crate) struct Thumbnails {
    models: HashMap<u32, ThumbnailModel>,
    target: Option<gpu::ReadbackTarget>,
    job: Option<ThumbnailJob>,
    pixels: Vec<u8>,
}

impl Thumbnails {
    /// Releases every GL object held, for `GemApp`'s drop and `thumbnail_clear`.
    pub(crate) fn release(&mut self, gl: &Gl) {
        for (_, stone) in self.models.drain() {
            release_model(gl, &stone);
        }

        if let Some(job) = self.job.take() {
            gl.delete_sync(Some(&job.fence));
        }

        if let Some(target) = self.target.take() {
            target.delete(gl);
        }

        self.pixels = Vec::new();
    }
}

fn release_model(gl: &Gl, stone: &ThumbnailModel) {
    gl.delete_texture(Some(&stone.model.triangle_texture));
    gl.delete_texture(Some(&stone.model.node_texture));
    gl.delete_texture(Some(&stone.model.facet_plane_texture));
    gl.delete_texture(Some(&stone.model.facet_frame_texture));
    gl.delete_texture(Some(&stone.blank_mask));
}

/// The settings a preview is drawn with: the page's own, as the user set them, with the
/// deterministic renderer and the full image whatever the page has selected, and never tilt
/// performance's measuring. Not the draft reduction either: a preview is a still picture.
pub fn thumbnail_params(base: &RenderParams) -> RenderParams {
    let mut params = base.clone();

    params.renderer = Renderer::Deterministic;
    params.debug_mode = DebugMode::Full;
    params.tilt_measure = TILT_MEASURE_OFF;
    params.clamp();

    params
}

/// Half the height of a preview's view at the target, in world units: the frame's sphere, whose
/// radius is 1 (`thumbnail_load`), with a sliver to spare, so the whole of the tallest stone of the
/// grid fits from any side and the stones fill the cells. The page's own view, 1.309 at its
/// default zoom, left them small in a cell (measured on the startup stone: about half the cell).
pub const THUMBNAIL_VIEW_HALF_HEIGHT: f32 = 1.02;

/// The camera a preview is drawn from: the default one (Gem Cut Studio's perspective), zoomed so
/// the frame's sphere fills the view (`THUMBNAIL_VIEW_HALF_HEIGHT`), and turned to `spin_degrees`
/// and `tilt_degrees`, so every cell is framed alike whatever the page's own zoom.
pub fn thumbnail_camera(spin_degrees: f32, tilt_degrees: f32) -> OrbitCamera {
    let mut camera = OrbitCamera::default();

    camera.distance = THUMBNAIL_VIEW_HALF_HEIGHT / crate::camera::VIEW_HALF_HEIGHT_PER_DISTANCE;
    camera.set_orientation(spin_degrees.to_radians(), tilt_degrees.to_radians());
    camera
}

/// Reorders an RGBA image read back from GL (bottom row first) into the order an HTML
/// `ImageData` wants (top row first). `pixels` holds `width * height * 4` bytes.
pub fn flip_rows(pixels: &[u8], width: usize, height: usize) -> Vec<u8> {
    let row = width * 4;
    let mut flipped = Vec::with_capacity(pixels.len());

    for y in (0..height).rev() {
        flipped.extend_from_slice(&pixels[y * row..(y + 1) * row]);
    }

    flipped
}

/// Whether a preview size can be drawn: at least one pixel and at most THUMBNAIL_MAX_SIZE a side.
pub fn valid_thumbnail_size(width: u32, height: u32) -> bool {
    (1..=THUMBNAIL_MAX_SIZE).contains(&width) && (1..=THUMBNAIL_MAX_SIZE).contains(&height)
}

#[wasm_bindgen]
impl GemApp {
    /// Builds a stone from OBJ text for previews, under `id` (replacing whatever `id` held), in
    /// the frame the caller fixes: the point `(center_x, center_y, center_z)` of the file's own
    /// coordinates goes to the centre of the view, and `radius` of the file's units to the unit
    /// radius the camera frames, as `load_obj_framed` takes them. Every vertex must be within
    /// `radius` of the centre. The stone on screen is not touched.
    #[allow(clippy::too_many_arguments)]
    pub fn thumbnail_load(
        &mut self,
        id: u32,
        obj_text: &str,
        center_x: f32,
        center_y: f32,
        center_z: f32,
        radius: f32,
    ) -> Result<(), JsValue> {
        if !(radius.is_finite() && radius > 0.0)
            || !(center_x.is_finite() && center_y.is_finite() && center_z.is_finite())
        {
            return Err(js_error(&format!(
                "thumbnail_load needs a finite centre and a positive radius, got ({}, {}, {}) and {}",
                center_x, center_y, center_z, radius
            )));
        }

        let pinned = Some((
            nalgebra::Vector3::new(center_x, center_y, center_z),
            1.0 / radius,
        ));
        let (model, _) =
            build_model(&self.gl, obj_text, self.model_axis, pinned).map_err(|e| js_error(&e))?;
        let blank_mask = match build_facet_mask_texture(
            &self.gl,
            model.diagnostics.facet_count,
            &std::collections::BTreeSet::new(),
        ) {
            Ok(texture) => texture,
            Err(error) => {
                self.gl.delete_texture(Some(&model.triangle_texture));
                self.gl.delete_texture(Some(&model.node_texture));
                self.gl.delete_texture(Some(&model.facet_plane_texture));
                self.gl.delete_texture(Some(&model.facet_frame_texture));

                return Err(js_error(&error));
            }
        };

        if let Some(old) = self
            .thumbnails
            .models
            .insert(id, ThumbnailModel { model, blank_mask })
        {
            release_model(&self.gl, &old);
        }

        Ok(())
    }

    /// Whether a stone is loaded under `id`.
    pub fn thumbnail_has(&self, id: u32) -> bool {
        self.thumbnails.models.contains_key(&id)
    }

    /// Forgets the stone under `id`, if there is one.
    pub fn thumbnail_drop(&mut self, id: u32) {
        if let Some(old) = self.thumbnails.models.remove(&id) {
            release_model(&self.gl, &old);
        }
    }

    /// Forgets every preview stone, abandons a draw in flight and frees the target.
    pub fn thumbnail_clear(&mut self) {
        let gl = self.gl.clone();

        self.thumbnails.release(&gl);
    }

    /// Draws the stone under `id` off screen at `width` x `height` pixels, seen from `spin` and
    /// `tilt` (degrees, as the `spin` and `tilt` parameters), with the page's render settings on
    /// the deterministic renderer (`thumbnail_params`), and queues it to be read back. Returns
    /// at once; `thumbnail_poll` says when the picture is ready. Abandons a draw still in flight.
    pub fn thumbnail_begin(
        &mut self,
        id: u32,
        width: u32,
        height: u32,
        spin: f32,
        tilt: f32,
    ) -> Result<(), JsValue> {
        if !valid_thumbnail_size(width, height) {
            return Err(js_error(&format!(
                "a preview is 1 to {} pixels a side, not {} x {}",
                THUMBNAIL_MAX_SIZE, width, height
            )));
        }

        if let Some(job) = self.thumbnails.job.take() {
            self.gl.delete_sync(Some(&job.fence));
        }

        let Some(mut stone) = self.thumbnails.models.remove(&id) else {
            return Err(js_error(&format!("no preview stone is loaded under {}", id)));
        };

        let result = self.draw_thumbnail(&mut stone, width, height, spin, tilt);

        self.thumbnails.models.insert(id, stone);

        let fence = result.map_err(|e| js_error(&e))?;

        self.thumbnails.job = Some(ThumbnailJob {
            fence,
            width,
            height,
        });

        Ok(())
    }

    /// Whether the preview `thumbnail_begin` queued is drawn and read. True once it is, when
    /// `thumbnail_pixels` has it; false while it is not, or when nothing is queued. Never waits.
    pub fn thumbnail_poll(&mut self) -> bool {
        let Some(job) = self.thumbnails.job.take() else {
            return false;
        };

        // TIMEOUT_EXPIRED is "not yet"; anything else, done or a failed fence (a lost context),
        // goes on rather than stalling for ever, as `frame_settled` does.
        if self.gl.client_wait_sync_with_u32(&job.fence, 0, 0) == Gl::TIMEOUT_EXPIRED {
            self.thumbnails.job = Some(job);

            return false;
        }

        self.gl.delete_sync(Some(&job.fence));

        let mut pixels = vec![0u8; (job.width * job.height * 4) as usize];

        if let Some(target) = self.thumbnails.target.as_ref() {
            target.collect(&self.gl, &mut pixels);
        }

        self.thumbnails.pixels = flip_rows(&pixels, job.width as usize, job.height as usize);

        true
    }

    /// The last preview `thumbnail_poll` finished: RGBA, top row first, as an `ImageData` holds
    /// it. Empty before the first.
    pub fn thumbnail_pixels(&self) -> Vec<u8> {
        self.thumbnails.pixels.clone()
    }
}

impl GemApp {
    /// Draws `stone` into the preview target and queues its read-back, with the stone on
    /// screen, its highlight, the dop, the camera and the program swapped out for the length of
    /// the draw and back afterwards, whatever happens. Returns the fence behind the read.
    fn draw_thumbnail(
        &mut self,
        stone: &mut ThumbnailModel,
        width: u32,
        height: u32,
        spin: f32,
        tilt: f32,
    ) -> Result<WebGlSync, String> {
        let reuse = self
            .thumbnails
            .target
            .as_ref()
            .is_some_and(|target| target.size() == (width, height));

        if !reuse {
            if let Some(old) = self.thumbnails.target.take() {
                old.delete(&self.gl);
            }

            self.thumbnails.target = Some(gpu::ReadbackTarget::new(&self.gl, width, height)?);
        }

        // The deterministic program is linked before the app exists, so it is always ready.
        if !matches!(
            self.programs[ProgramKind::Deterministic.index()],
            ProgramState::Ready(_)
        ) {
            return Err("the deterministic program is not ready".to_string());
        }

        let params = thumbnail_params(&self.render_params);
        let mut camera = thumbnail_camera(spin, tilt);
        let saved_drawing = self.drawing;
        let saved_dop = self.dop.take();
        // The frosted facets (T-0270) are the stone on screen's facet ids, which name different
        // facets of a preview's mesh, and its cache holds that stone's values: a preview is drawn
        // with nothing frosted, as it is with nothing selected (`blank_mask`).
        let saved_frosted = std::mem::take(&mut self.frosted_facets);

        self.drawing = ProgramKind::Deterministic;
        std::mem::swap(&mut self.model, &mut stone.model);
        std::mem::swap(&mut self.highlight_texture, &mut stone.blank_mask);
        std::mem::swap(&mut self.camera, &mut camera);
        // The wireframe's line width is in CSS pixels of the canvas; a preview has no canvas, so
        // its lines are drawn as if at one CSS pixel per backing pixel of a 2x screen, about as
        // wide on a grid cell as on the preview.
        self.pixel_scale_override = Some(2.0);

        if let Some(target) = self.thumbnails.target.as_ref() {
            target.bind(&self.gl);
        }

        self.draw_trace_in((width, height), width, height, &params, LUX_PASS_DIRECT, 0, 1);
        self.gl.bind_framebuffer(Gl::FRAMEBUFFER, None);

        self.pixel_scale_override = None;
        std::mem::swap(&mut self.camera, &mut camera);
        std::mem::swap(&mut self.highlight_texture, &mut stone.blank_mask);
        std::mem::swap(&mut self.model, &mut stone.model);
        self.frosted_facets = saved_frosted;
        self.dop = saved_dop;
        self.drawing = saved_drawing;

        let target = self
            .thumbnails
            .target
            .as_ref()
            .ok_or_else(|| "the preview target is gone".to_string())?;

        target.queue_read(&self.gl)?;
        gpu::fence(&self.gl)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{LightingModel, ToneMapMode, TILT_MEASURE_QUANTITIES};
    use nalgebra::Vector3;

    // Setup: the page's settings with every choice a user could make away from the default --
    // the Monte Carlo renderer, a debug view, tilt performance's measuring left on, a colour, the
    // cosine lighting model, the filmic transfer and 12 bounces.
    // Test: thumbnail_params.
    // Verifies: a preview always draws with the deterministic renderer, the full image and no
    // measuring, and keeps everything else the user chose -- the lighting, the colour, the
    // transfer, the bounces -- so the grid looks like the preview.
    #[test]
    fn a_preview_is_the_page_settings_drawn_deterministically() {
        let mut base = RenderParams::default();

        base.renderer = Renderer::LuxCore;
        base.debug_mode = DebugMode::FacetId;
        base.tilt_measure = TILT_MEASURE_QUANTITIES;
        base.absorption = Vector3::new(0.3, 0.1, 0.5);
        base.absorption_scale = 1.0;
        base.lighting_model = LightingModel::Cosine;
        base.tone_map_mode = ToneMapMode::Filmic;
        base.max_bounces = 12;

        let params = thumbnail_params(&base);

        assert_eq!(params.renderer, Renderer::Deterministic);
        assert_eq!(params.debug_mode, DebugMode::Full);
        assert_eq!(params.tilt_measure, TILT_MEASURE_OFF);
        assert_eq!(params.lighting_model, LightingModel::Cosine);
        assert_eq!(params.tone_map_mode, ToneMapMode::Filmic);
        assert_eq!(params.max_bounces, 12);
        assert_eq!(params.effective_absorption(), base.effective_absorption());
    }

    // Setup: a pose given in degrees, as the page's spin and tilt parameters are.
    // Test: thumbnail_camera, compared with a default camera turned the same way by hand, and
    // the half-height of the view its basis describes.
    // Verifies: the preview camera is the default projection at the page's own orientation
    // (converted from degrees to the radians the camera holds), zoomed so the view at the target
    // is THUMBNAIL_VIEW_HALF_HEIGHT high -- just over the frame's unit sphere, so the tallest
    // stone of the grid fits and fills the cell.
    #[test]
    fn a_preview_camera_frames_the_unit_sphere_at_the_pages_pose() {
        let camera = thumbnail_camera(30.0, -45.0);
        let mut expected = OrbitCamera::default();

        expected.set_orientation(30.0f32.to_radians(), (-45.0f32).to_radians());

        assert_eq!(camera.spin, expected.spin);
        assert_eq!(camera.tilt, expected.tilt);
        // Never tipped sideways (T-0288): a preview is built from the default camera, not from
        // the view's, so a sideways drag on the view cannot tip the manual optimizer's face-up
        // previews off face-up.
        assert_eq!(camera.side_tilt, 0.0);
        assert_eq!(camera.eye_distance, expected.eye_distance);
        assert_eq!(camera.vertical_fov, expected.vertical_fov);

        let half_height = camera.distance * crate::camera::VIEW_HALF_HEIGHT_PER_DISTANCE;

        assert!((half_height - THUMBNAIL_VIEW_HALF_HEIGHT).abs() < 1e-5);
        assert!(THUMBNAIL_VIEW_HALF_HEIGHT > 1.0);
    }

    // Setup: a 2 x 3 RGBA image as GL reads it back, bottom row first, each row's bytes
    // numbered by its GL row (0 at the bottom).
    // Test: flip_rows.
    // Verifies: the rows come out top first (GL row 2, then 1, then 0), each row's pixels left
    // to right and untouched, which is the order ImageData expects.
    #[test]
    fn flip_rows_puts_the_top_row_first() {
        let pixels: Vec<u8> = (0..3u8).flat_map(|row| [row; 8]).collect();

        let flipped = flip_rows(&pixels, 2, 3);

        assert_eq!(&flipped[0..8], &[2; 8]);
        assert_eq!(&flipped[8..16], &[1; 8]);
        assert_eq!(&flipped[16..24], &[0; 8]);
    }

    // Setup: sizes at and around both limits.
    // Test: valid_thumbnail_size.
    // Verifies: 1 to THUMBNAIL_MAX_SIZE on each side is accepted, 0 and anything larger is not,
    // on either side, so a zero-sized cell or a runaway size is refused before any allocation.
    #[test]
    fn preview_sizes_are_bounded_on_both_sides() {
        assert!(valid_thumbnail_size(1, 1));
        assert!(valid_thumbnail_size(THUMBNAIL_MAX_SIZE, THUMBNAIL_MAX_SIZE));
        assert!(!valid_thumbnail_size(0, 10));
        assert!(!valid_thumbnail_size(10, 0));
        assert!(!valid_thumbnail_size(THUMBNAIL_MAX_SIZE + 1, 10));
        assert!(!valid_thumbnail_size(10, THUMBNAIL_MAX_SIZE + 1));
    }
}
