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
    WebGl2RenderingContext as Gl, WebGlFramebuffer, WebGlProgram, WebGlShader, WebGlTexture,
    WebGlUniformLocation,
};

/// Compiles one shader stage, returning the driver's log on failure.
///
/// The log is propagated verbatim rather than summarised: a GLSL compile error names
/// the exact line, and anything less makes shader debugging guesswork.
pub fn compile_shader(gl: &Gl, kind: u32, source: &str) -> Result<WebGlShader, String> {
    let shader = gl
        .create_shader(kind)
        .ok_or_else(|| "could not create shader object".to_string())?;

    gl.shader_source(&shader, source);
    gl.compile_shader(&shader);

    let compiled = gl
        .get_shader_parameter(&shader, Gl::COMPILE_STATUS)
        .as_bool()
        .unwrap_or(false);

    if compiled {
        return Ok(shader);
    }

    let log = gl
        .get_shader_info_log(&shader)
        .unwrap_or_else(|| "no compile log available".to_string());

    gl.delete_shader(Some(&shader));

    let stage = if kind == Gl::VERTEX_SHADER {
        "vertex"
    } else {
        "fragment"
    };

    Err(format!("{} shader failed to compile:\n{}", stage, log))
}

/// Compiles and links the two stages into a program.
pub fn link_program(
    gl: &Gl,
    vertex_source: &str,
    fragment_source: &str,
) -> Result<WebGlProgram, String> {
    let vertex = compile_shader(gl, Gl::VERTEX_SHADER, vertex_source)?;
    let fragment = compile_shader(gl, Gl::FRAGMENT_SHADER, fragment_source)?;

    let program = gl
        .create_program()
        .ok_or_else(|| "could not create program object".to_string())?;

    gl.attach_shader(&program, &vertex);
    gl.attach_shader(&program, &fragment);
    gl.link_program(&program);

    // The shader objects are no longer needed once linked; the program holds its own
    // reference until it is deleted.
    gl.delete_shader(Some(&vertex));
    gl.delete_shader(Some(&fragment));

    let linked = gl
        .get_program_parameter(&program, Gl::LINK_STATUS)
        .as_bool()
        .unwrap_or(false);

    if linked {
        return Ok(program);
    }

    let log = gl
        .get_program_info_log(&program)
        .unwrap_or_else(|| "no link log available".to_string());

    gl.delete_program(Some(&program));

    Err(format!("program failed to link:\n{}", log))
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
