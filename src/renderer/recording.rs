//! Tools > Record rendering (T-0290): the frames of a recorded drag, drawn off screen at the
//! video's own size with the renderer the user chose for the final video.
//!
//! The user, 2026-09-29: "once the user clicks record and the user then clicks on the rock, the
//! app should start recording the x, y and z rotations, rendering the rock with the preview
//! tracing. Once the user releases, the app should start replaying those rotations but each frame
//! is rendered with the tracer set."
//!
//! The page records the poses; this module draws them. Each frame is drawn into an image of its
//! own (`gpu::ReadbackTarget`), never the canvas, so the video is the size the user asked for
//! whatever the size of the window, and the stone on screen is left alone. The frame is read back
//! behind a fence, as tilt performance's batches and the manual optimizer's previews are, so the
//! page never waits for the GPU.
//!
//! **Settings are taken once, when the final render starts** (`record_start`): the render
//! settings, the renderer the user chose for the video, and the camera's zoom and lens. Every frame
//! is that camera turned to its recorded pose, so a setting moved while the video renders cannot
//! change it half way through.
//!
//! **A Monte Carlo frame is many passes.** The live view accumulates passes into the canvas's
//! float targets until it has the "Samples to accumulate" the render settings ask for; a frame of
//! the video does the same into a pair of float targets of the video's size, one pass per
//! `record_advance`, one pass on the GPU at a time (T-0197: the machine must never be handed more
//! Monte Carlo work than it can retire), and the last pass is resolved into the frame. The seed of
//! pass `i` is the same in every frame, so the grain that is left holds still rather than
//! flickering from frame to frame. Without float render targets (no `EXT_color_buffer_float`) a
//! frame is one draw that takes all its samples at once, as the live view's fallback does.

use wasm_bindgen::prelude::*;
use web_sys::{WebGl2RenderingContext as Gl, WebGlSync, WebGlTexture};

use crate::camera::OrbitCamera;
use crate::params::{DebugMode, RenderParams, Renderer, MAX_ACCUMULATED_PASSES, MAX_LUX_SAMPLES, TILT_MEASURE_OFF};
use crate::{
    build_facet_mask_texture, frost, gpu, js_error, GemApp, ProgramKind, ProgramState,
    LUX_PASS_ACCUMULATE, LUX_PASS_DIRECT, LUX_PASS_RESOLVE,
};

/// The largest side of a video frame, in pixels: 4K UHD's width with room to spare, and well
/// inside the 8192 or more every WebGL2 GPU supports as a texture's side.
pub const RECORD_MAX_SIDE: u32 = 4096;

/// What `record_advance` says.
///
/// - `RECORD_WORKING`: nothing new was drawn. The GPU is still drawing the last pass, or the
///   renderer's program is still compiling; ask again soon.
/// - `RECORD_SUBMITTED`: a pass was drawn and is on the GPU.
/// - `RECORD_DONE`: the frame is finished and read back; `record_pixels` has it.
/// - `RECORD_IDLE`: no frame has been begun (`record_frame`), or the last one was collected.
pub const RECORD_WORKING: u32 = 0;
pub const RECORD_SUBMITTED: u32 = 1;
pub const RECORD_DONE: u32 = 2;
pub const RECORD_IDLE: u32 = 3;

/// The height at which the facet wireframe is drawn as it is on a 2x screen showing the stone
/// 540 CSS pixels tall. The wireframe's width is set in CSS pixels of the canvas, and a frame of
/// the video has no canvas, so its width follows the frame's height instead: the lines take the
/// same share of a 1080-line video as of the preview on a typical screen, and of a 720-line video
/// too, whatever the window is.
pub const RECORD_WIRE_REFERENCE_HEIGHT: f32 = 540.0;

/// Whether a frame size can be drawn: at least one pixel and at most `RECORD_MAX_SIDE` a side.
pub fn valid_record_size(width: u32, height: u32) -> bool {
    (1..=RECORD_MAX_SIDE).contains(&width) && (1..=RECORD_MAX_SIDE).contains(&height)
}

/// The settings a frame is drawn with: the page's own, as the user set them, on `renderer`,
/// with the full image and never tilt performance's measuring, and never the draft reduction a
/// drag brings (a frame of the video is a still picture).
pub fn record_params(base: &RenderParams, renderer: Renderer) -> RenderParams {
    let mut params = base.clone();

    params.renderer = renderer;
    params.debug_mode = DebugMode::Full;
    params.tilt_measure = TILT_MEASURE_OFF;
    params.clamp();

    params
}

/// The camera a frame is drawn from: `base` (the page's camera when the final render started:
/// its zoom, its lens) turned to the recorded pose, in degrees as the `spin`, `tilt` and
/// `sideTilt` parameters take them -- the X, Y and Z rotations the user asked to record, the last
/// the sideways tilt a plain sideways drag gives (T-0288, T-0296).
pub fn record_camera(
    base: &OrbitCamera,
    spin_degrees: f32,
    tilt_degrees: f32,
    side_tilt_degrees: f32,
) -> OrbitCamera {
    let mut camera = *base;

    camera.set_orientation(spin_degrees.to_radians(), tilt_degrees.to_radians());
    camera.set_side_tilt(side_tilt_degrees.to_radians());

    camera
}

/// Backing pixels per CSS pixel for the wireframe on a frame `height` pixels tall; see
/// `RECORD_WIRE_REFERENCE_HEIGHT`. Never below 1, so a small video's lines stay a pixel wide.
pub fn record_wire_scale(height: u32) -> f32 {
    (height as f32 / RECORD_WIRE_REFERENCE_HEIGHT).max(1.0)
}

/// How a frame is drawn, fixed when the final render starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramePlan {
    /// One draw straight into the frame: the deterministic and flat renderers, and Monte Carlo
    /// where the browser cannot render into a float image (its samples all in that one draw).
    Direct,
    /// Monte Carlo: `passes` draws summed into float targets, the last one resolved into the
    /// frame.
    Accumulate { passes: u32 },
}

/// One draw of a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameDraw {
    /// The whole frame, into the image, then read back.
    Direct,
    /// Pass `index` added to the sum; `last` resolves the sum into the image and reads it back.
    Accumulate { index: u32, last: bool },
}

impl FramePlan {
    /// The plan for `renderer` at `passes` passes a frame, where float targets are
    /// (`accumulation`) or are not available. Only Monte Carlo accumulates, and a pass count
    /// outside 1..=MAX_ACCUMULATED_PASSES is held to it.
    pub fn new(renderer: Renderer, passes: u32, accumulation: bool) -> FramePlan {
        match (renderer, accumulation) {
            (Renderer::LuxCore, true) => FramePlan::Accumulate {
                passes: passes.clamp(1, MAX_ACCUMULATED_PASSES),
            },
            _ => FramePlan::Direct,
        }
    }

    /// How many draws a frame takes.
    pub fn draws(self) -> u32 {
        match self {
            FramePlan::Direct => 1,
            FramePlan::Accumulate { passes } => passes,
        }
    }

    /// The draw that follows `done` draws of a frame, or `None` once the frame is drawn.
    pub fn next(self, done: u32) -> Option<FrameDraw> {
        if done >= self.draws() {
            return None;
        }

        Some(match self {
            FramePlan::Direct => FrameDraw::Direct,
            FramePlan::Accumulate { passes } => FrameDraw::Accumulate {
                index: done,
                last: done + 1 == passes,
            },
        })
    }
}

/// The Monte Carlo samples a direct (non-accumulating) frame takes in its one draw: every pass's
/// samples at once, as many as the renderer allows in one draw.
pub fn direct_lux_samples(renderer: Renderer, lux_samples: u32, passes: u32) -> u32 {
    match renderer {
        Renderer::LuxCore => lux_samples.max(1).saturating_mul(passes.max(1)).min(MAX_LUX_SAMPLES),
        _ => lux_samples,
    }
}

/// What the final render was started with.
struct RecordSession {
    width: u32,
    height: u32,
    params: RenderParams,
    camera: OrbitCamera,
    plan: FramePlan,
}

/// The frame being drawn: its camera, how many draws are done, the fence behind the last one,
/// and whether that fence is the read-back's (the frame is then finished once it signals).
struct RecordJob {
    camera: OrbitCamera,
    done: u32,
    fence: Option<WebGlSync>,
    reading: bool,
}

/// The final render's session, its images, the frame in flight and the last frame read back.
#[derive(Default)]
pub(crate) struct Recorder {
    session: Option<RecordSession>,
    target: Option<gpu::ReadbackTarget>,
    accumulation: Option<gpu::AccumulationTargets>,
    /// A per-facet mask with nothing in it, bound as the highlight while a frame draws (a tier the
    /// user selected is tinted on screen, not in the video), and the model generation it was made
    /// for.
    blank_mask: Option<(u64, WebGlTexture)>,
    job: Option<RecordJob>,
    pixels: Vec<u8>,
}

impl Recorder {
    /// Releases every GL object held, for `record_stop` and `GemApp`'s drop.
    pub(crate) fn release(&mut self, gl: &Gl) {
        if let Some(job) = self.job.take() {
            if let Some(fence) = job.fence {
                gl.delete_sync(Some(&fence));
            }
        }

        if let Some(target) = self.target.take() {
            target.delete(gl);
        }

        if let Some(targets) = self.accumulation.take() {
            targets.delete(gl);
        }

        if let Some((_, texture)) = self.blank_mask.take() {
            gl.delete_texture(Some(&texture));
        }

        self.session = None;
        self.pixels = Vec::new();
    }
}

#[wasm_bindgen]
impl GemApp {
    /// Starts the final render of a recording: every later frame (`record_frame`) is drawn
    /// `width` x `height` pixels with `renderer` (0 deterministic, 1 Monte Carlo, 2 flat) and the
    /// render settings and camera as they are now. A Monte Carlo frame takes `passes` passes
    /// (the render settings' samples to accumulate over their samples per frame). Replaces any
    /// final render already started, abandoning its frame.
    pub fn record_start(
        &mut self,
        width: u32,
        height: u32,
        renderer: u32,
        passes: u32,
    ) -> Result<(), JsValue> {
        if !valid_record_size(width, height) {
            return Err(js_error(&format!(
                "a video frame is 1 to {} pixels a side, not {} x {}",
                RECORD_MAX_SIDE, width, height
            )));
        }

        let gl = self.gl.clone();

        self.recorder.release(&gl);

        let renderer = Renderer::from_u32(renderer);
        let mut plan = FramePlan::new(renderer, passes, self.accumulation.is_some());

        if let FramePlan::Accumulate { .. } = plan {
            match gpu::AccumulationTargets::new(&gl, width, height) {
                Ok(targets) => self.recorder.accumulation = Some(targets),
                // Float targets at this size failed where the canvas's worked: take the samples
                // in one draw instead, as a browser without them does.
                Err(_) => plan = FramePlan::Direct,
            }
        }

        let mut params = record_params(&self.render_params, renderer);

        if plan == FramePlan::Direct {
            params.lux_samples = direct_lux_samples(renderer, params.lux_samples, passes);
        }

        self.recorder.target =
            Some(gpu::ReadbackTarget::new(&gl, width, height).map_err(|e| js_error(&e))?);
        self.recorder.session = Some(RecordSession {
            width,
            height,
            params,
            camera: self.camera,
            plan,
        });

        Ok(())
    }

    /// Begins a frame of the final render, the camera turned to `spin`, `tilt` and `side_tilt`
    /// (degrees, as the parameters of the same names). Draws nothing yet: `record_advance` does.
    /// Abandons a frame still being drawn.
    pub fn record_frame(&mut self, spin: f32, tilt: f32, side_tilt: f32) -> Result<(), JsValue> {
        let Some(session) = self.recorder.session.as_ref() else {
            return Err(js_error("record_frame before record_start"));
        };

        if !(spin.is_finite() && tilt.is_finite() && side_tilt.is_finite()) {
            return Err(js_error("a recorded pose needs finite angles"));
        }

        let camera = record_camera(&session.camera, spin, tilt, side_tilt);

        if let Some(job) = self.recorder.job.take() {
            if let Some(fence) = job.fence {
                self.gl.delete_sync(Some(&fence));
            }
        }

        self.recorder.job = Some(RecordJob {
            camera,
            done: 0,
            fence: None,
            reading: false,
        });

        Ok(())
    }

    /// Moves the frame along by at most one draw, never waiting: see `RECORD_WORKING` and the
    /// others for what it says. Call it again after `record_settled` says the GPU has caught up.
    pub fn record_advance(&mut self) -> Result<u32, JsValue> {
        let Some(job) = self.recorder.job.as_mut() else {
            return Ok(RECORD_IDLE);
        };

        if let Some(fence) = job.fence.as_ref() {
            // TIMEOUT_EXPIRED is "not yet"; anything else -- done, or a fence that failed, as
            // after a lost context -- goes on, as `frame_settled` does, rather than stalling.
            if self.gl.client_wait_sync_with_u32(fence, 0, 0) == Gl::TIMEOUT_EXPIRED {
                return Ok(RECORD_WORKING);
            }

            if let Some(fence) = job.fence.take() {
                self.gl.delete_sync(Some(&fence));
            }

            if job.reading {
                return self.collect_record_frame().map(|_| RECORD_DONE).map_err(|e| js_error(&e));
            }
        }

        let done = job.done;
        let Some((plan, renderer)) = self
            .recorder
            .session
            .as_ref()
            .map(|session| (session.plan, session.params.renderer))
        else {
            return Err(js_error("record_advance before record_start"));
        };
        let Some(draw) = plan.next(done) else {
            return Err(js_error("the frame is drawn but was never read back"));
        };
        let kind = self.record_program(renderer);

        if !self.prepare_program(kind, false) {
            if let ProgramState::Failed(error) = &self.programs[kind.index()] {
                return Err(js_error(error));
            }

            // Still compiling: the frame waits for it rather than being drawn by a stand-in.
            return Ok(RECORD_WORKING);
        }

        let fence = self.draw_record_pass(kind, draw).map_err(|e| js_error(&e))?;

        if let Some(job) = self.recorder.job.as_mut() {
            job.done += 1;
            job.fence = Some(fence);
            job.reading = matches!(draw, FrameDraw::Direct | FrameDraw::Accumulate { last: true, .. });
        }

        Ok(RECORD_SUBMITTED)
    }

    /// Whether the GPU has finished what the frame last submitted (true when nothing is
    /// outstanding). Only asks; `record_advance` is what moves on.
    pub fn record_settled(&self) -> bool {
        match self.recorder.job.as_ref().and_then(|job| job.fence.as_ref()) {
            Some(fence) => self.gl.client_wait_sync_with_u32(fence, 0, 0) != Gl::TIMEOUT_EXPIRED,
            None => true,
        }
    }

    /// How many of the frame's draws have been submitted, and how many it takes.
    pub fn record_passes_done(&self) -> u32 {
        self.recorder.job.as_ref().map_or(0, |job| job.done)
    }

    pub fn record_passes_total(&self) -> u32 {
        self.recorder.session.as_ref().map_or(0, |session| session.plan.draws())
    }

    /// The last finished frame, RGBA with the top row first, as `ImageData` and WebCodecs'
    /// `VideoFrame` take it. Empty before the first.
    pub fn record_pixels(&self) -> Vec<u8> {
        self.recorder.pixels.clone()
    }

    /// Ends the final render: abandons the frame in flight and frees the images.
    pub fn record_stop(&mut self) {
        let gl = self.gl.clone();

        self.recorder.release(&gl);
    }
}

impl GemApp {
    /// The program a frame of `renderer` is drawn with: its own, or the frosted deterministic
    /// one when the stone has frosted facets, or the concave one when it is not convex, as the
    /// live view picks (`wanted_program`).
    fn record_program(&self, renderer: Renderer) -> ProgramKind {
        let frosted =
            frost::frosted_facet_count(self.model.diagnostics.facet_count, &self.frosted_facets) > 0;

        ProgramKind::for_params(renderer, DebugMode::Full)
            .with_frosted(frosted)
            .with_concave(self.model.concave())
    }

    /// Draws one draw of the frame in flight with `kind`'s (ready) program, with the camera,
    /// the highlight, the dop and the accumulation targets swapped for the frame's own and back
    /// again whatever happens, and returns the fence behind it (and behind the read-back, on the
    /// frame's last draw).
    fn draw_record_pass(&mut self, kind: ProgramKind, draw: FrameDraw) -> Result<WebGlSync, String> {
        let (width, height, params) = {
            let session = self.recorder.session.as_ref().ok_or("no final render started")?;

            (session.width, session.height, session.params.clone())
        };
        let mut camera = self
            .recorder
            .job
            .as_ref()
            .ok_or("no frame begun")?
            .camera;

        self.ensure_record_blank_mask()?;

        let saved_drawing = self.drawing;
        let saved_dop = self.dop.take();
        let saved_frost_ready = self.frost_cache_ready;
        let accumulating = matches!(draw, FrameDraw::Accumulate { .. });

        self.drawing = kind;
        std::mem::swap(&mut self.camera, &mut camera);

        if let Some((_, mask)) = self.recorder.blank_mask.as_mut() {
            std::mem::swap(&mut self.highlight_texture, mask);
        }

        if accumulating {
            std::mem::swap(&mut self.accumulation, &mut self.recorder.accumulation);
        }

        self.pixel_scale_override = Some(record_wire_scale(height));

        let reads = match draw {
            FrameDraw::Direct => {
                // The frosted facets' per-facet values, drawn before the frame that reads them,
                // exactly as `render_pass` does for the view.
                self.frost_cache_ready = kind == ProgramKind::DeterministicFrosted
                    && self.draw_frost_cache(width, height, &params);

                if let Some(target) = self.recorder.target.as_ref() {
                    target.bind(&self.gl);
                }

                self.draw_trace(width, height, &params, LUX_PASS_DIRECT, 0, 1);
                true
            }
            FrameDraw::Accumulate { index, last } => {
                if let Some(targets) = self.accumulation.as_ref() {
                    if index == 0 {
                        targets.clear(&self.gl);
                    }

                    targets.bind_destination(&self.gl);
                }

                let seed = params.lux_seed.wrapping_add(index);

                self.draw_trace(width, height, &params, LUX_PASS_ACCUMULATE, seed, index + 1);

                if let Some(targets) = self.accumulation.as_mut() {
                    targets.advance();
                }

                if last {
                    if let Some(target) = self.recorder.target.as_ref() {
                        target.bind(&self.gl);
                    }

                    self.draw_trace(width, height, &params, LUX_PASS_RESOLVE, params.lux_seed, index + 1);
                }

                last
            }
        };

        self.gl.bind_framebuffer(Gl::FRAMEBUFFER, None);

        self.pixel_scale_override = None;

        if accumulating {
            std::mem::swap(&mut self.accumulation, &mut self.recorder.accumulation);
        }

        if let Some((_, mask)) = self.recorder.blank_mask.as_mut() {
            std::mem::swap(&mut self.highlight_texture, mask);
        }

        std::mem::swap(&mut self.camera, &mut camera);
        self.frost_cache_ready = saved_frost_ready;
        self.dop = saved_dop;
        self.drawing = saved_drawing;

        if reads {
            self.recorder
                .target
                .as_ref()
                .ok_or("the frame's image is gone")?
                .queue_read(&self.gl)?;
        }

        gpu::fence(&self.gl)
    }

    /// Makes the empty highlight mask for the stone loaded now, once per stone.
    fn ensure_record_blank_mask(&mut self) -> Result<(), String> {
        if self.recorder.blank_mask.as_ref().map(|(generation, _)| *generation)
            == Some(self.model_generation)
        {
            return Ok(());
        }

        let texture = build_facet_mask_texture(
            &self.gl,
            self.model.diagnostics.facet_count,
            &std::collections::BTreeSet::new(),
        )?;

        if let Some((_, old)) = self.recorder.blank_mask.replace((self.model_generation, texture)) {
            self.gl.delete_texture(Some(&old));
        }

        Ok(())
    }

    /// Copies the frame read back out of its pixel buffer, top row first, and ends the job.
    fn collect_record_frame(&mut self) -> Result<(), String> {
        let (width, height) = self
            .recorder
            .session
            .as_ref()
            .map(|session| (session.width, session.height))
            .ok_or("no final render started")?;
        let mut pixels = vec![0u8; (width * height * 4) as usize];

        self.recorder
            .target
            .as_ref()
            .ok_or("the frame's image is gone")?
            .collect(&self.gl, &mut pixels);

        self.recorder.pixels =
            crate::thumbnails::flip_rows(&pixels, width as usize, height as usize);
        self.recorder.job = None;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{LightingModel, ToneMapMode, TILT_MEASURE_QUANTITIES};
    use nalgebra::Vector3;

    // Setup: the page's settings with every choice a user could make away from the default --
    // a debug view, tilt performance's measuring left on, a colour, the cosine lighting model,
    // the filmic transfer, 12 bounces, 4 Monte Carlo samples per pass -- on the deterministic
    // renderer.
    // Test: record_params for each of the three renderers.
    // Verifies: a frame of the video is always drawn with the renderer chosen for the video (not
    // the one on screen), the full image and no measuring, and keeps everything else the user
    // chose -- lighting, colour, transfer, bounces, samples -- so the video looks like the render
    // settings say.
    #[test]
    fn a_frame_is_the_page_settings_on_the_chosen_renderer() {
        let mut base = RenderParams::default();

        base.debug_mode = DebugMode::FacetId;
        base.tilt_measure = TILT_MEASURE_QUANTITIES;
        base.absorption = Vector3::new(0.3, 0.1, 0.5);
        base.absorption_scale = 1.0;
        base.lighting_model = LightingModel::Cosine;
        base.tone_map_mode = ToneMapMode::Filmic;
        base.max_bounces = 12;
        base.lux_samples = 4;

        for renderer in [Renderer::Deterministic, Renderer::LuxCore, Renderer::Flat] {
            let params = record_params(&base, renderer);

            assert_eq!(params.renderer, renderer);
            assert_eq!(params.debug_mode, DebugMode::Full);
            assert_eq!(params.tilt_measure, TILT_MEASURE_OFF);
            assert_eq!(params.lighting_model, LightingModel::Cosine);
            assert_eq!(params.tone_map_mode, ToneMapMode::Filmic);
            assert_eq!(params.max_bounces, 12);
            assert_eq!(params.lux_samples, 4);
            assert_eq!(params.effective_absorption(), base.effective_absorption());
        }
    }

    // Setup: a camera zoomed in, on a lens and away from the default pose -- tipped sideways too --
    // standing for the page's camera when the final render starts.
    // Test: record_camera at a recorded pose given in degrees, with a sideways tilt (Z) and
    // without one.
    // Verifies: the frame's camera keeps the page's zoom, lens and eye distance (the framing the
    // user saw) and takes all three recorded angles -- spin (X), tilt (Y) and the sideways tilt
    // (Z) -- converted to the radians the camera holds; a pose recorded upright is drawn upright,
    // whatever sideways tilt the page's camera had when the render started, since every frame's
    // Z is its own.
    #[test]
    fn a_frame_camera_is_the_page_camera_at_the_recorded_pose() {
        let mut base = OrbitCamera::default();

        base.zoom(0.7);
        base.set_vertical_fov(0.6);
        base.set_orientation(1.0, -0.4);
        base.set_side_tilt(0.3);

        let camera = record_camera(&base, 30.0, -45.0, 12.0);
        let mut expected = base;

        expected.set_orientation(30.0f32.to_radians(), (-45.0f32).to_radians());
        expected.set_side_tilt(12.0f32.to_radians());

        assert_eq!(camera, expected);
        assert_eq!(camera.distance, base.distance);
        assert_eq!(camera.vertical_fov, base.vertical_fov);
        assert_eq!(camera.eye_distance, base.eye_distance);
        assert!((camera.side_tilt - 12.0f32.to_radians()).abs() < 1e-7);

        assert_eq!(record_camera(&base, 30.0, -45.0, 0.0).side_tilt, 0.0);
    }

    // Setup: the default camera at one spin and tilt, with sideways tilts of 0 and 20 degrees.
    // Test: the ray basis of each frame's camera.
    // Verifies: the sideways tilt really turns the picture -- the two frames look along different
    // directions -- so a Ctrl + drag recorded as Z comes out in the video, not only X and Y.
    #[test]
    fn the_sideways_tilt_turns_the_frame() {
        let upright = record_camera(&OrbitCamera::default(), 15.0, 25.0, 0.0).basis(16.0 / 9.0);
        let tipped = record_camera(&OrbitCamera::default(), 15.0, 25.0, 20.0).basis(16.0 / 9.0);

        assert!((upright.forward - tipped.forward).norm() > 0.1);
    }

    // Setup: one camera at one recorded pose, and two frame sizes of the same aspect (1280 x 720
    // and 1920 x 1080) and one of another (1080 x 1080).
    // Test: the ray basis a frame is drawn with, which set_uniforms builds from the frame's own
    // width and height -- never the canvas's.
    // Verifies: the framing depends on the frame's aspect alone: equal aspects give the identical
    // basis whatever the pixel count, so the stone fills the same share of a 720p and a 1080p
    // video; a square frame keeps the same eye and direction and differs only in its aspect.
    // Together with record_start taking its size from the page's settings, the video never
    // depends on the size of the window.
    #[test]
    fn a_frame_is_framed_by_its_own_size_not_the_window() {
        let camera = record_camera(&OrbitCamera::default(), 12.0, 20.0, 0.0);
        let hd = camera.basis(1280.0 / 720.0);
        let full_hd = camera.basis(1920.0 / 1080.0);
        let square = camera.basis(1.0);

        assert_eq!(hd, full_hd);
        assert_eq!(hd.origin, square.origin);
        assert_eq!(hd.forward, square.forward);
        assert_ne!(hd.aspect, square.aspect);
    }

    // Setup: the three renderers, with float targets available and not, at 64 passes a frame.
    // Test: FramePlan::new, draws() and next() walked from the first draw to the end.
    // Verifies: only Monte Carlo with float targets accumulates -- 64 draws, pass indices 0 to 63
    // in order, only the last one resolving and reading the frame back, and nothing after it; the
    // deterministic and flat renderers, and Monte Carlo without float targets, are one direct draw
    // that reads the frame back.
    #[test]
    fn a_frame_is_one_draw_or_every_monte_carlo_pass_then_its_resolve() {
        let plan = FramePlan::new(Renderer::LuxCore, 64, true);

        assert_eq!(plan, FramePlan::Accumulate { passes: 64 });
        assert_eq!(plan.draws(), 64);

        for done in 0..64 {
            assert_eq!(
                plan.next(done),
                Some(FrameDraw::Accumulate { index: done, last: done == 63 })
            );
        }

        assert_eq!(plan.next(64), None);

        for (renderer, float_targets) in [
            (Renderer::Deterministic, true),
            (Renderer::Flat, true),
            (Renderer::LuxCore, false),
        ] {
            let plan = FramePlan::new(renderer, 64, float_targets);

            assert_eq!(plan, FramePlan::Direct);
            assert_eq!(plan.draws(), 1);
            assert_eq!(plan.next(0), Some(FrameDraw::Direct));
            assert_eq!(plan.next(1), None);
        }
    }

    // Setup: Monte Carlo pass counts at and beyond both ends.
    // Test: FramePlan::new.
    // Verifies: a frame always takes at least one pass and never more than the renderer will ever
    // accumulate, so a zero or runaway setting can neither skip the frame nor never finish it.
    #[test]
    fn a_monte_carlo_frame_takes_one_to_the_most_passes() {
        assert_eq!(FramePlan::new(Renderer::LuxCore, 0, true).draws(), 1);
        assert_eq!(
            FramePlan::new(Renderer::LuxCore, u32::MAX, true).draws(),
            MAX_ACCUMULATED_PASSES
        );
    }

    // Setup: Monte Carlo at 2 samples per pass and 512 passes; the same with an absurd count;
    // the deterministic renderer.
    // Test: direct_lux_samples, the samples a frame takes in its one draw where it cannot
    // accumulate.
    // Verifies: the frame still gathers every pass's samples, capped at what one draw may take,
    // and a renderer that does not sample is left as it was.
    #[test]
    fn a_direct_monte_carlo_frame_takes_every_pass_samples_at_once() {
        assert_eq!(direct_lux_samples(Renderer::LuxCore, 2, 512), 1024);
        assert_eq!(direct_lux_samples(Renderer::LuxCore, 64, 4096), MAX_LUX_SAMPLES);
        assert_eq!(direct_lux_samples(Renderer::Deterministic, 3, 512), 3);
    }

    // Setup: sizes at and around both limits, and the common video sizes.
    // Test: valid_record_size.
    // Verifies: 1 to RECORD_MAX_SIDE on each side is accepted (720p, 1080p and 4K UHD included);
    // 0 and anything larger is refused on either side before any allocation.
    #[test]
    fn frame_sizes_are_bounded_on_both_sides() {
        assert!(valid_record_size(1, 1));
        assert!(valid_record_size(1280, 720));
        assert!(valid_record_size(1920, 1080));
        assert!(valid_record_size(3840, 2160));
        assert!(valid_record_size(RECORD_MAX_SIDE, RECORD_MAX_SIDE));
        assert!(!valid_record_size(0, 10));
        assert!(!valid_record_size(10, 0));
        assert!(!valid_record_size(RECORD_MAX_SIDE + 1, 10));
        assert!(!valid_record_size(10, RECORD_MAX_SIDE + 1));
    }

    // Setup: frame heights of 360, 540, 720, 1080 and 2160 lines.
    // Test: record_wire_scale.
    // Verifies: the wireframe scales with the frame's height (2 at 1080, as a 2x screen), so it
    // takes the same share of the picture at every size, and never drops below one pixel.
    #[test]
    fn the_wireframe_follows_the_frame_height() {
        assert_eq!(record_wire_scale(360), 1.0);
        assert_eq!(record_wire_scale(540), 1.0);
        assert!((record_wire_scale(720) - 720.0 / 540.0).abs() < 1e-6);
        assert_eq!(record_wire_scale(1080), 2.0);
        assert_eq!(record_wire_scale(2160), 4.0);
    }
}
