//! WebGL2 plumbing: shader compilation, the float textures the tracer reads, and the
//! float render targets the ported path accumulates into.
//!
//! Kept deliberately thin. Everything with interesting logic lives in the modules
//! that can be unit tested on the host, because none of this can be: it needs a live
//! browser context. The accumulation *state machine* is therefore in
//! [`crate::params::AccumulationState`], which is pure and tested; what lives here is
//! only the GL object handling it drives.

use js_sys::{Float32Array, Uint16Array};
use std::collections::HashMap;
use web_sys::{
    WebGl2RenderingContext as Gl, WebGlBuffer, WebGlFramebuffer, WebGlProgram, WebGlShader, WebGlTexture,
    WebGlUniformLocation,
};

/// `COMPLETION_STATUS_KHR`, from `KHR_parallel_shader_compile`. web-sys has no binding for
/// the extension's one constant, so it is spelled out here.
const COMPLETION_STATUS_KHR: u32 = 0x91B1;

/// A program whose compile and link have been *issued* but not yet asked about.
///
/// Why the link is split in two (measured 2026-09-23, Chrome 153 and Edge 153 on Windows, an
/// RTX 2080, fresh profiles, the real ~320 KB gem shader): the first `COMPILE_STATUS` or
/// `LINK_STATUS` query blocks until Direct3D's shader compiler has finished, which takes 13-16 s
/// there. In Chromium that query ties up the GPU process, which is also the compositor, so the
/// WHOLE BROWSER stops drawing for the duration -- 0 animation frames in 13.9 s. Issuing the
/// same compile and link and then only polling `COMPLETION_STATUS_KHR` once a frame until it
/// says done gave 863 frames over 14.4 s, never more than 17.5 ms apart (Edge: 948, 22 ms).
///
/// So nothing here may query a status before `is_complete` says so: one early
/// `get_shader_parameter` puts the freeze straight back. Firefox 156 does not offer the
/// extension; there `parallel` is false, `is_complete` is always true, and `finish` blocks
/// exactly as the old single-call link did.
pub struct PendingProgram {
    program: WebGlProgram,
    vertex: WebGlShader,
    fragment: WebGlShader,
    parallel: bool,
}

/// Issues the compile of both stages and the link, without waiting for any of it.
pub fn start_link(
    gl: &Gl,
    vertex_source: &str,
    fragment_source: &str,
) -> Result<PendingProgram, String> {
    // Enabling the extension is what makes `COMPLETION_STATUS_KHR` a legal query; the compile
    // itself is asynchronous in ANGLE either way, it is only ever the status query that waits.
    let parallel = matches!(gl.get_extension("KHR_parallel_shader_compile"), Ok(Some(_)));

    let vertex = issue_compile(gl, Gl::VERTEX_SHADER, vertex_source)?;
    let fragment = issue_compile(gl, Gl::FRAGMENT_SHADER, fragment_source)?;

    let program = gl
        .create_program()
        .ok_or_else(|| "could not create program object".to_string())?;

    gl.attach_shader(&program, &vertex);
    gl.attach_shader(&program, &fragment);
    gl.link_program(&program);

    Ok(PendingProgram {
        program,
        vertex,
        fragment,
        parallel,
    })
}

impl PendingProgram {
    /// Whether the driver can report progress, i.e. whether polling `is_complete` keeps the
    /// browser responsive. False means `finish` will block for the whole compile.
    pub fn parallel(&self) -> bool {
        self.parallel
    }

    /// Whether `finish` can now run without blocking. Always true without the extension,
    /// since then there is nothing to ask and nothing to gain by waiting.
    pub fn is_complete(&self, gl: &Gl) -> bool {
        if !self.parallel {
            return true;
        }

        gl.get_program_parameter(&self.program, COMPLETION_STATUS_KHR)
            .as_bool()
            .unwrap_or(true)
    }

    /// Deletes everything without waiting for, or asking about, the link.
    pub fn discard(self, gl: &Gl) {
        gl.delete_shader(Some(&self.vertex));
        gl.delete_shader(Some(&self.fragment));
        gl.delete_program(Some(&self.program));
    }

    /// Reads the outcome and hands back the linked program, or the driver's log on failure.
    ///
    /// Logs are propagated verbatim rather than summarised: a GLSL compile error names the
    /// exact line, and anything less makes shader debugging guesswork. A stage that failed to
    /// compile is reported as such rather than as the link failure it also causes, which is
    /// what the old compile-then-check-then-link sequence reported too.
    pub fn finish(self, gl: &Gl) -> Result<WebGlProgram, String> {
        let PendingProgram {
            program,
            vertex,
            fragment,
            ..
        } = self;

        let linked = gl
            .get_program_parameter(&program, Gl::LINK_STATUS)
            .as_bool()
            .unwrap_or(false);

        let failure = if linked {
            None
        } else {
            Some(
                compile_failure(gl, &vertex, "vertex")
                    .or_else(|| compile_failure(gl, &fragment, "fragment"))
                    .unwrap_or_else(|| {
                        let log = gl
                            .get_program_info_log(&program)
                            .unwrap_or_else(|| "no link log available".to_string());

                        format!("program failed to link:\n{}", log)
                    }),
            )
        };

        // The shader objects are no longer needed once linked; the program holds its own
        // reference until it is deleted.
        gl.delete_shader(Some(&vertex));
        gl.delete_shader(Some(&fragment));

        match failure {
            None => Ok(program),
            Some(message) => {
                gl.delete_program(Some(&program));
                Err(message)
            }
        }
    }
}

/// Creates a shader object and issues its compile, without asking how it went.
fn issue_compile(gl: &Gl, kind: u32, source: &str) -> Result<WebGlShader, String> {
    let shader = gl
        .create_shader(kind)
        .ok_or_else(|| "could not create shader object".to_string())?;

    gl.shader_source(&shader, source);
    gl.compile_shader(&shader);

    Ok(shader)
}

/// The error message for a stage that failed to compile, or `None` if it compiled.
fn compile_failure(gl: &Gl, shader: &WebGlShader, stage: &str) -> Option<String> {
    let compiled = gl
        .get_shader_parameter(shader, Gl::COMPILE_STATUS)
        .as_bool()
        .unwrap_or(false);

    if compiled {
        return None;
    }

    let log = gl
        .get_shader_info_log(shader)
        .unwrap_or_else(|| "no compile log available".to_string());

    Some(format!("{} shader failed to compile:\n{}", stage, log))
}

/// Compiles and links the two stages into a program, blocking until it is done.
pub fn link_program(
    gl: &Gl,
    vertex_source: &str,
    fragment_source: &str,
) -> Result<WebGlProgram, String> {
    start_link(gl, vertex_source, fragment_source)?.finish(gl)
}

/// Collects every active uniform's location once, so the render loop never queries
/// them by name against the driver.
pub fn collect_uniforms(gl: &Gl, program: &WebGlProgram) -> HashMap<String, WebGlUniformLocation> {
    let mut locations = HashMap::new();

    let count = gl
        .get_program_parameter(program, Gl::ACTIVE_UNIFORMS)
        .as_f64()
        .unwrap_or(0.0) as u32;

    for index in 0..count {
        if let Some(info) = gl.get_active_uniform(program, index) {
            let name = info.name();

            // An array uniform is reported once, under the name of its first element
            // ("uLuxSunDir[0]"), with `size` giving the element count. Only that one name
            // has a location the driver will hand back for the whole array, so every other
            // element has to be asked for by its own indexed name or it can never be set.
            // Learned wiring `uLuxSunDir` in T-0120: without this the loop registered
            // element 0 and silently left elements 1..4 at zero.
            if let Some(base) = name.strip_suffix("[0]") {
                for element in 0..info.size().max(1) {
                    let element_name = format!("{}[{}]", base, element);

                    if let Some(location) = gl.get_uniform_location(program, &element_name) {
                        locations.insert(element_name, location);
                    }
                }

                continue;
            }

            if let Some(location) = gl.get_uniform_location(program, &name) {
                locations.insert(name, location);
            }
        }
    }

    locations
}

/// Uploads flat `f32` data as an `RGBA32F` texture with no filtering.
///
/// Nearest filtering is both what the tracer wants (these are data lookups, not
/// images) and what WebGL2 supports without an extension: linear filtering of 32-bit
/// float textures needs the optional `OES_texture_float_linear`.
pub fn create_data_texture(
    gl: &Gl,
    width: u32,
    height: u32,
    data: &[f32],
) -> Result<WebGlTexture, String> {
    let expected = width as usize * height as usize * 4;

    if data.len() != expected {
        return Err(format!(
            "data texture size mismatch: {}x{} needs {} floats but got {}",
            width,
            height,
            expected,
            data.len()
        ));
    }

    let texture = gl
        .create_texture()
        .ok_or_else(|| "could not create data texture".to_string())?;

    gl.bind_texture(Gl::TEXTURE_2D, Some(&texture));

    // SAFETY: `Float32Array::view` aliases wasm linear memory rather than copying.
    // The view is handed straight to `tex_image_2d` and dropped immediately, with no
    // allocation in between that could grow and move the heap underneath it.
    let upload_result = unsafe {
        let view = Float32Array::view(data);

        gl.tex_image_2d_with_i32_and_i32_and_i32_and_format_and_type_and_opt_array_buffer_view(
            Gl::TEXTURE_2D,
            0,
            Gl::RGBA32F as i32,
            width as i32,
            height as i32,
            0,
            Gl::RGBA,
            Gl::FLOAT,
            Some(&view),
        )
    };

    // On failure the texture object exists but nothing will ever hold it, so delete it here
    // rather than leak it.
    if let Err(error) = upload_result {
        gl.bind_texture(Gl::TEXTURE_2D, None);
        gl.delete_texture(Some(&texture));

        return Err(format!("could not upload data texture: {:?}", error));
    }

    gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MIN_FILTER, Gl::NEAREST as i32);
    gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MAG_FILTER, Gl::NEAREST as i32);
    gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_S, Gl::CLAMP_TO_EDGE as i32);
    gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_T, Gl::CLAMP_TO_EDGE as i32);

    gl.bind_texture(Gl::TEXTURE_2D, None);

    Ok(texture)
}

/// Uploads half-float data as an `RGBA16F` equirectangular environment texture.
///
/// Wrapping repeats horizontally so the seam where longitude wraps is continuous, and
/// clamps vertically so sampling at the poles cannot bleed across to the opposite
/// side of the sky.
pub fn create_environment_texture(
    gl: &Gl,
    width: u32,
    height: u32,
    half_float_data: &[u16],
) -> Result<WebGlTexture, String> {
    let expected = width as usize * height as usize * 4;

    if half_float_data.len() != expected {
        return Err(format!(
            "environment texture size mismatch: {}x{} needs {} halves but got {}",
            width,
            height,
            expected,
            half_float_data.len()
        ));
    }

    let texture = gl
        .create_texture()
        .ok_or_else(|| "could not create environment texture".to_string())?;

    gl.bind_texture(Gl::TEXTURE_2D, Some(&texture));

    // SAFETY: as in `create_data_texture`, the view aliases wasm memory and is
    // consumed immediately with no intervening allocation.
    let upload_result = unsafe {
        let view = Uint16Array::view(half_float_data);

        gl.tex_image_2d_with_i32_and_i32_and_i32_and_format_and_type_and_opt_array_buffer_view(
            Gl::TEXTURE_2D,
            0,
            Gl::RGBA16F as i32,
            width as i32,
            height as i32,
            0,
            Gl::RGBA,
            Gl::HALF_FLOAT,
            Some(&view),
        )
    };

    // As in `create_data_texture`: delete the orphaned texture object on failure.
    if let Err(error) = upload_result {
        gl.bind_texture(Gl::TEXTURE_2D, None);
        gl.delete_texture(Some(&texture));

        return Err(format!("could not upload environment texture: {:?}", error));
    }

    gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MIN_FILTER, Gl::LINEAR as i32);
    gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MAG_FILTER, Gl::LINEAR as i32);
    gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_S, Gl::REPEAT as i32);
    gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_T, Gl::CLAMP_TO_EDGE as i32);

    gl.bind_texture(Gl::TEXTURE_2D, None);

    Ok(texture)
}

/// The WebGL2 extension that makes a float texture colour-renderable.
///
/// Named as a constant because it appears in both the probe and the message a failed
/// probe hands the page, and the two must not drift: "accumulation is off" is only
/// actionable if it says exactly what was missing.
pub const FLOAT_RENDER_TARGET_EXTENSION: &str = "EXT_color_buffer_float";

/// A ping-pong pair of `RGBA32F` render targets, for summing radiance across frames.
///
/// # Why a pair rather than one buffer
///
/// The accumulate pass computes `previous + thisPass`, so it reads the sum while writing
/// it. Sampling a texture that is attached to the bound framebuffer is undefined in
/// WebGL2 (a feedback loop), so the pass reads [`read_texture`] and draws into
/// [`bind_destination`]'s target, and [`advance`] then swaps them. The alternative --
/// one buffer with additive blending -- needs `EXT_float_blend` on top of
/// [`FLOAT_RENDER_TARGET_EXTENSION`], so it trades a texture fetch per pixel for a second
/// extension dependency.
///
/// # Why 32-bit and not 16-bit float
///
/// What is stored is a *sum*, not an average, so it grows without bound as passes
/// accumulate: a specular flash of radiance 100 exceeds `RGBA16F`'s 65504 maximum after
/// 655 passes and becomes `Inf`, and long before that the 11-bit mantissa stops resolving
/// the newest sample against the running total. `RGBA32F` holds the sum exactly enough
/// that pass 65536 still moves the result.
pub struct AccumulationTargets {
    textures: [WebGlTexture; 2],
    framebuffers: [WebGlFramebuffer; 2],
    width: u32,
    height: u32,
    /// Index of the texture holding the current sum, i.e. the one to read from. The
    /// other is where the next pass is drawn.
    front: usize,
}

impl AccumulationTargets {
    /// Allocates both targets at this size, zeroed.
    ///
    /// Fails, rather than rendering black, when the browser cannot render to a float
    /// texture. Both halves are checked: the extension has to be *enabled* (asking for it
    /// is what turns the format on, not merely a query), and the resulting framebuffer has
    /// to report itself complete. A driver that lists the extension and then refuses the
    /// attachment is exactly the silent failure `kb/browser-harness.md`'s fifth
    /// load-bearing detail is about, so the completeness check is not optional.
    pub fn new(gl: &Gl, width: u32, height: u32) -> Result<AccumulationTargets, String> {
        if gl
            .get_extension(FLOAT_RENDER_TARGET_EXTENSION)
            .ok()
            .flatten()
            .is_none()
        {
            return Err(format!(
                "this browser does not support {}, so RGBA32F cannot be rendered to",
                FLOAT_RENDER_TARGET_EXTENSION
            ));
        }

        let first = create_float_target(gl, width, height)?;
        let second = match create_float_target(gl, width, height) {
            Ok(target) => target,
            Err(error) => {
                // The first pair exists and nothing else holds it yet.
                delete_float_target(gl, &first);

                return Err(error);
            }
        };

        let targets = AccumulationTargets {
            textures: [first.0, second.0],
            framebuffers: [first.1, second.1],
            width,
            height,
            front: 0,
        };

        targets.clear(gl);

        Ok(targets)
    }

    /// The texture holding the sum so far, to be read by the next accumulate pass and by
    /// the resolve pass.
    pub fn read_texture(&self) -> &WebGlTexture {
        &self.textures[self.front]
    }

    /// Binds the framebuffer the next accumulate pass draws into, and sets the viewport to
    /// match it.
    pub fn bind_destination(&self, gl: &Gl) {
        gl.bind_framebuffer(Gl::FRAMEBUFFER, Some(&self.framebuffers[1 - self.front]));
        gl.viewport(0, 0, self.width as i32, self.height as i32);
    }

    /// Makes the just-written target the one to read. Call once per completed accumulate
    /// pass, never for a resolve.
    pub fn advance(&mut self) {
        self.front = 1 - self.front;
    }

    /// Zeroes both targets, which is what starting a new accumulation means.
    ///
    /// Both, not just the one to be read: after the first pass the roles swap, and a stale
    /// sum in the other buffer would reappear as a ghost of the previous image.
    pub fn clear(&self, gl: &Gl) {
        for framebuffer in &self.framebuffers {
            gl.bind_framebuffer(Gl::FRAMEBUFFER, Some(framebuffer));
            gl.clear_color(0.0, 0.0, 0.0, 0.0);
            gl.clear(Gl::COLOR_BUFFER_BIT);
        }

        gl.bind_framebuffer(Gl::FRAMEBUFFER, None);
    }

    /// Reallocates at a new size if needed, leaving the contents undefined (the caller is
    /// restarting the accumulation, which is the only reason the size can change).
    ///
    /// Returns whether anything was reallocated, so a caller can tell a resize from a
    /// no-op without comparing sizes itself.
    pub fn resize(&mut self, gl: &Gl, width: u32, height: u32) -> Result<bool, String> {
        if self.width == width && self.height == height {
            return Ok(false);
        }

        // Build the replacement before releasing the old one, so a failed allocation
        // leaves a usable buffer rather than a half-destroyed one.
        let replacement = AccumulationTargets::new(gl, width, height)?;

        self.delete(gl);
        *self = replacement;

        Ok(true)
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Releases both textures and both framebuffers.
    pub fn delete(&self, gl: &Gl) {
        for texture in &self.textures {
            gl.delete_texture(Some(texture));
        }

        for framebuffer in &self.framebuffers {
            gl.delete_framebuffer(Some(framebuffer));
        }
    }
}

/// One `RGBA32F` texture with a framebuffer pointing at it, checked complete.
fn create_float_target(
    gl: &Gl,
    width: u32,
    height: u32,
) -> Result<(WebGlTexture, WebGlFramebuffer), String> {
    let texture = gl
        .create_texture()
        .ok_or_else(|| "could not create an accumulation texture".to_string())?;

    gl.bind_texture(Gl::TEXTURE_2D, Some(&texture));

    // No initial data: the contents come from `clear`. Nearest filtering and clamped
    // wrapping because every read is a `texelFetch` at the fragment's own coordinate --
    // this is a buffer, not an image.
    let allocated = gl
        .tex_image_2d_with_i32_and_i32_and_i32_and_format_and_type_and_opt_array_buffer_view(
            Gl::TEXTURE_2D,
            0,
            Gl::RGBA32F as i32,
            width.max(1) as i32,
            height.max(1) as i32,
            0,
            Gl::RGBA,
            Gl::FLOAT,
            None,
        );

    if let Err(error) = allocated {
        gl.bind_texture(Gl::TEXTURE_2D, None);
        gl.delete_texture(Some(&texture));

        return Err(format!(
            "could not allocate a {}x{} RGBA32F accumulation texture: {:?}",
            width, height, error
        ));
    }

    gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MIN_FILTER, Gl::NEAREST as i32);
    gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MAG_FILTER, Gl::NEAREST as i32);
    gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_S, Gl::CLAMP_TO_EDGE as i32);
    gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_T, Gl::CLAMP_TO_EDGE as i32);
    gl.bind_texture(Gl::TEXTURE_2D, None);

    let framebuffer = match gl.create_framebuffer() {
        Some(framebuffer) => framebuffer,
        None => {
            gl.delete_texture(Some(&texture));

            return Err("could not create an accumulation framebuffer".to_string());
        }
    };

    gl.bind_framebuffer(Gl::FRAMEBUFFER, Some(&framebuffer));
    gl.framebuffer_texture_2d(
        Gl::FRAMEBUFFER,
        Gl::COLOR_ATTACHMENT0,
        Gl::TEXTURE_2D,
        Some(&texture),
        0,
    );

    let status = gl.check_framebuffer_status(Gl::FRAMEBUFFER);

    gl.bind_framebuffer(Gl::FRAMEBUFFER, None);

    if status != Gl::FRAMEBUFFER_COMPLETE {
        gl.delete_framebuffer(Some(&framebuffer));
        gl.delete_texture(Some(&texture));

        return Err(format!(
            "an RGBA32F framebuffer is not complete on this browser (status 0x{:x}), \
             even though {} is available",
            status,
            FLOAT_RENDER_TARGET_EXTENSION
        ));
    }

    Ok((texture, framebuffer))
}

fn delete_float_target(gl: &Gl, target: &(WebGlTexture, WebGlFramebuffer)) {
    gl.delete_texture(Some(&target.0));
    gl.delete_framebuffer(Some(&target.1));
}

/// An off-screen 8-bit RGBA image the renderer can draw into and read back (T-0261, tilt
/// performance), so a measurement is made at a fixed size of its own instead of at whatever
/// size the page's canvas happens to be.
///
/// 8 bits per channel rather than a float target, so it works in every WebGL2 browser: the
/// graph averages each quantity over the half million or so pixels of a stone, where rounding
/// each one to 1/255 moves the average by far less than a line's width.
///
/// It also carries a pixel-pack buffer, so an image can be read back without waiting for it:
/// `queue_read` queues the copy into the buffer, a `fence` says when the GPU has done it (one
/// fence for both passes of a pose), and `collect` then copies it out at once. The page's
/// sweep uses that, so that it is never held up waiting for the GPU; `read` is the waiting
/// version, for the harness.
pub struct ReadbackTarget {
    texture: WebGlTexture,
    framebuffer: WebGlFramebuffer,
    pack_buffer: WebGlBuffer,
    width: u32,
    height: u32,
}

/// A fence that signals once the GPU has done everything queued so far, such as the copies
/// `ReadbackTarget::queue_read` queued. Flushed, as `GemApp::place_frame_fence` explains a fence
/// nobody flushed may never signal.
pub fn fence(gl: &Gl) -> Result<web_sys::WebGlSync, String> {
    let fence = gl
        .fence_sync(Gl::SYNC_GPU_COMMANDS_COMPLETE, 0)
        .ok_or_else(|| "could not create a fence for the tilt images".to_string())?;

    gl.flush();

    Ok(fence)
}

impl ReadbackTarget {
    /// Allocates the target at this size, checked complete.
    pub fn new(gl: &Gl, width: u32, height: u32) -> Result<ReadbackTarget, String> {
        let texture = gl
            .create_texture()
            .ok_or_else(|| "could not create a readback texture".to_string())?;

        gl.bind_texture(Gl::TEXTURE_2D, Some(&texture));

        let allocated = gl
            .tex_image_2d_with_i32_and_i32_and_i32_and_format_and_type_and_opt_array_buffer_view(
                Gl::TEXTURE_2D,
                0,
                Gl::RGBA8 as i32,
                width.max(1) as i32,
                height.max(1) as i32,
                0,
                Gl::RGBA,
                Gl::UNSIGNED_BYTE,
                None,
            );

        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MIN_FILTER, Gl::NEAREST as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MAG_FILTER, Gl::NEAREST as i32);
        gl.bind_texture(Gl::TEXTURE_2D, None);

        if let Err(error) = allocated {
            gl.delete_texture(Some(&texture));

            return Err(format!(
                "could not allocate a {}x{} readback texture: {:?}",
                width, height, error
            ));
        }

        let Some(framebuffer) = gl.create_framebuffer() else {
            gl.delete_texture(Some(&texture));

            return Err("could not create a readback framebuffer".to_string());
        };

        gl.bind_framebuffer(Gl::FRAMEBUFFER, Some(&framebuffer));
        gl.framebuffer_texture_2d(
            Gl::FRAMEBUFFER,
            Gl::COLOR_ATTACHMENT0,
            Gl::TEXTURE_2D,
            Some(&texture),
            0,
        );

        let status = gl.check_framebuffer_status(Gl::FRAMEBUFFER);

        gl.bind_framebuffer(Gl::FRAMEBUFFER, None);

        if status != Gl::FRAMEBUFFER_COMPLETE {
            gl.delete_framebuffer(Some(&framebuffer));
            gl.delete_texture(Some(&texture));

            return Err(format!(
                "an RGBA8 readback framebuffer is not complete (status 0x{:x})",
                status
            ));
        }

        let Some(pack_buffer) = gl.create_buffer() else {
            gl.delete_framebuffer(Some(&framebuffer));
            gl.delete_texture(Some(&texture));

            return Err("could not create a readback pixel buffer".to_string());
        };

        gl.bind_buffer(Gl::PIXEL_PACK_BUFFER, Some(&pack_buffer));
        gl.buffer_data_with_i32(
            Gl::PIXEL_PACK_BUFFER,
            (width.max(1) * height.max(1) * 4) as i32,
            Gl::STREAM_READ,
        );
        gl.bind_buffer(Gl::PIXEL_PACK_BUFFER, None);

        Ok(ReadbackTarget {
            texture,
            framebuffer,
            pack_buffer,
            width,
            height,
        })
    }

    /// Binds the target for drawing, with the viewport set to cover it.
    pub fn bind(&self, gl: &Gl) {
        gl.bind_framebuffer(Gl::FRAMEBUFFER, Some(&self.framebuffer));
        gl.viewport(0, 0, self.width as i32, self.height as i32);
    }

    /// Reads the whole image back into `pixels` (RGBA, bottom row first, as GL stores it),
    /// which must hold `width * height * 4` bytes. Waits for the GPU to finish drawing it.
    pub fn read(&self, gl: &Gl, pixels: &mut [u8]) -> Result<(), String> {
        gl.bind_framebuffer(Gl::FRAMEBUFFER, Some(&self.framebuffer));

        let result = gl.read_pixels_with_opt_u8_array(
            0,
            0,
            self.width as i32,
            self.height as i32,
            Gl::RGBA,
            Gl::UNSIGNED_BYTE,
            Some(pixels),
        );

        gl.bind_framebuffer(Gl::FRAMEBUFFER, None);

        result.map_err(|error| format!("could not read the tilt image back: {:?}", error))
    }

    /// Queues a copy of the whole image into the pixel-pack buffer, with no fence of its own, so
    /// several targets can be read together behind one `fence` (tilt performance's passes of a
    /// pose). Nothing waits here.
    pub fn queue_read(&self, gl: &Gl) -> Result<(), String> {
        gl.bind_framebuffer(Gl::FRAMEBUFFER, Some(&self.framebuffer));
        gl.bind_buffer(Gl::PIXEL_PACK_BUFFER, Some(&self.pack_buffer));

        let result = gl.read_pixels_with_i32(
            0,
            0,
            self.width as i32,
            self.height as i32,
            Gl::RGBA,
            Gl::UNSIGNED_BYTE,
            0,
        );

        gl.bind_buffer(Gl::PIXEL_PACK_BUFFER, None);
        gl.bind_framebuffer(Gl::FRAMEBUFFER, None);
        result.map_err(|error| format!("could not queue the tilt image read: {:?}", error))
    }

    /// Copies what `queue_read` queued into `pixels` (`width * height * 4` bytes). Only after
    /// its fence has signalled, or this waits for the GPU after all.
    pub fn collect(&self, gl: &Gl, pixels: &mut [u8]) {
        gl.bind_buffer(Gl::PIXEL_PACK_BUFFER, Some(&self.pack_buffer));
        gl.get_buffer_sub_data_with_i32_and_u8_array(Gl::PIXEL_PACK_BUFFER, 0, pixels);
        gl.bind_buffer(Gl::PIXEL_PACK_BUFFER, None);
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Releases the texture, the framebuffer and the pixel buffer.
    pub fn delete(&self, gl: &Gl) {
        gl.delete_texture(Some(&self.texture));
        gl.delete_framebuffer(Some(&self.framebuffer));
        gl.delete_buffer(Some(&self.pack_buffer));
    }
}
