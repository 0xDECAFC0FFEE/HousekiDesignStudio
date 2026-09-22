//! WebGL2 gemstone renderer.
//!
//! Renders a faceted stone by tracing rays through its interior per pixel, with real
//! Fresnel reflectance, total internal reflection, wavelength-dependent refraction
//! and Beer-Lambert absorption.
//!
//! # Why ray tracing rather than rasterisation
//!
//! A gem's appearance is dominated by what happens *inside* it. Light enters through
//! the crown, reflects off the pavilion facets, often many times, and leaves through
//! the crown again. Rasterising the surface and applying a screen-space refraction
//! approximation produces something that reads as glass, not as a gem, and
//! structurally cannot represent multi-bounce total internal reflection.
//!
//! Ray tracing is also the right base for concave fantasy facets, because intersecting
//! triangles makes no convexity assumption. The renderer as it stands is not ready for them,
//! though:
//! - light leaving the stone is looked up in the lighting directly, not traced against the
//!   stone again;
//! - the leak rules assume a convex stone;
//! - the loader fan-triangulates polygon faces, which is wrong for a concave polygon.
//!
//! See T-0036.
//!
//! # Layering
//!
//! The Rust-side logic lives in modules that run on the host and are unit tested there
//! ([`mesh`], [`accel`], [`camera`], [`env_map`], [`params`], [`loader`]). Only [`gpu`] and
//! this module touch WebGL, and they are kept as thin as possible, because browser-only code
//! cannot be tested in the same loop.
//!
//! The shader's own logic is not covered the same way, and no test compiles `gem.frag`
//! (T-0037):
//! - with tested Rust mirrors: traversal, triangle intersection, the camera rays, the
//!   lighting frame, the observer and the leak test;
//! - with none: Fresnel, refraction, the interior loop and the rest of `arrivingLight`.

pub mod accel;
pub mod camera;
pub mod env_map;
pub mod gpu;
pub mod loader;
pub mod mesh;
pub mod params;

use accel::Accel;
use camera::OrbitCamera;
use mesh::{Mesh, MeshDiagnostics, ModelAxis};
use nalgebra::Vector3;
use params::{DebugMode, LightingModel, RenderParams};

use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{
    HtmlCanvasElement, WebGl2RenderingContext as Gl, WebGlProgram, WebGlTexture,
    WebGlUniformLocation, WebGlVertexArrayObject,
};

const VERTEX_SHADER: &str = include_str!("shaders/gem.vert");

/// The fragment shader: the deterministic path tracer and the ported LuxCore one, compiled
/// as one program and selected at runtime by the `uRenderer` uniform (T-0120).
///
/// **The order is load-bearing and deliberately not order-independent.** Each ported file
/// carries `#ifndef`-guarded stand-ins for helpers a file ahead of it defines for real, so
/// the wrong order produces a duplicate-definition error -- chosen over a silent failure
/// when the port was written (see `lux/glass.glsl`'s COMPILE-ONLY STUBS block). Specifically:
///
/// * `gem.frag` must be first: `#version` is only legal as the very first token, and its
///   `traceScene()` has to be defined before `lux/pathtracer.glsl`'s `Scene_Intersect()`
///   calls it. It also `#define`s `LUX_HAS_GEM_FRAG`, which is how that file knows to
///   compile the real implementation instead of its standalone stub.
/// * `lux/prelude.glsl` bridges OpenCL C to GLSL ES for every file after it.
/// * `lux/host.glsl` declares the `uniform`s and fills in the HOST INTEGRATION POINT macros
///   `lux/lights.glsl` leaves open; a `#define` only affects text that follows it.
/// * `lux/math.glsl` before `lux/glass.glsl`, whose deliberately-wrong `CosTheta` /
///   `SinTheta2` / `WaveLength2RGB` stubs are suppressed by math.glsl's own header guard.
/// * `lux/volume.glsl` after `lux/glass.glsl`, whose guarded block defines the `WHITE` /
///   `BLACK` / `MAKE_FLOAT3` / `Spectrum_IsBlack` / `Spectrum_Filter` the volume maths uses,
///   and before `lux/pathtracer.glsl`, which calls `HomogeneousVolume_Scatter`.
/// * `lux/lights.glsl` after `lux/pathtracer.glsl`, which forward-declares the two
///   functions lights.glsl defines.
/// * `lux/entry.glsl` last: it owns `main()` and calls into everything above it.
///
/// `shader_source_files_are_concatenated_in_the_documented_order` pins this list, and
/// `src/shaders/gem.frag`'s own header gives the `tools/glsl_check.sh` command that
/// compiles the same unit outside the browser.
const FRAGMENT_SHADER: &str = concat!(
    include_str!("shaders/gem.frag"),
    include_str!("shaders/lux/prelude.glsl"),
    include_str!("shaders/lux/host.glsl"),
    include_str!("shaders/lux/math.glsl"),
    include_str!("shaders/lux/glass.glsl"),
    include_str!("shaders/lux/volume.glsl"),
    include_str!("shaders/lux/sampler.glsl"),
    include_str!("shaders/lux/pathtracer.glsl"),
    include_str!("shaders/lux/lights.glsl"),
    include_str!("shaders/lux/entry.glsl"),
);

/// `gem.frag`'s own source, isolated from the ported files it is concatenated with in
/// `FRAGMENT_SHADER`. `include_str!` embeds the file again rather than slicing
/// `FRAGMENT_SHADER` apart, the same duplication the test module's own
/// `SHADER_SOURCE_FILES` already makes for the same reason: a few more KB in the binary
/// buys a piece of the shader that can be inspected on its own. See `lux_ignored_uniforms`.
const GEM_FRAG_SOURCE: &str = include_str!("shaders/gem.frag");

/// Every ported LuxCore file, concatenated in the same order as `FRAGMENT_SHADER`, isolated
/// for the same reason as `GEM_FRAG_SOURCE`.
const LUX_SOURCE: &str = concat!(
    include_str!("shaders/lux/prelude.glsl"),
    include_str!("shaders/lux/host.glsl"),
    include_str!("shaders/lux/math.glsl"),
    include_str!("shaders/lux/glass.glsl"),
    include_str!("shaders/lux/volume.glsl"),
    include_str!("shaders/lux/sampler.glsl"),
    include_str!("shaders/lux/pathtracer.glsl"),
    include_str!("shaders/lux/lights.glsl"),
    include_str!("shaders/lux/entry.glsl"),
);

/// Whether `name` occurs in `source` as a whole identifier, not merely as a substring of a
/// longer one.
///
/// Plain `str::contains` would be wrong here: nothing currently makes one uniform's name a
/// substring of another's, but nothing guarantees it either, and a false match would make
/// `lux_ignored_uniforms` silently under-report. Checking the bytes on both sides of every
/// match is cheap at this size (a few hundred KB of shader source, run once per call) and
/// needs no regex crate.
fn identifier_occurs(source: &str, name: &str) -> bool {
    let bytes = source.as_bytes();

    source.match_indices(name).any(|(start, matched)| {
        let end = start + matched.len();
        let before_is_boundary = start == 0 || !is_ident_byte(bytes[start - 1]);
        let after_is_boundary = end == bytes.len() || !is_ident_byte(bytes[end]);

        before_is_boundary && after_is_boundary
    })
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn is_glsl_identifier(word: &str) -> bool {
    let mut chars = word.chars();

    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Strips `//` line comments from GLSL source.
///
/// Good enough for every file this project ships: none of them put `//` inside a string
/// literal (GLSL ES 3.00 fragment shaders have no use for one here), so a naive per-line
/// split never cuts a real token in half. Without this, a comment like lux/pathtracer.glsl's
/// "the real implementation is expected to be a one-line call to traceScene()" would be
/// mistaken for a real call and pull that function's whole body into what LuxCore is
/// considered to read.
fn strip_glsl_comments(source: &str) -> String {
    source
        .lines()
        .map(|line| line.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Whether `name` is genuinely called -- `name(`, as a whole identifier -- somewhere in
/// already comment-stripped `code`. Doubles as "is this name mentioned as a call" whether
/// `code` is a foreign file (LuxCore calling into `gem.frag`) or a function's own body
/// (one `gem.frag` helper calling another).
fn calls(code: &str, name: &str) -> bool {
    let bytes = code.as_bytes();

    code.match_indices(name).any(|(start, matched)| {
        let before_is_boundary = start == 0 || !is_ident_byte(bytes[start - 1]);
        let after = &code[start + matched.len()..];

        before_is_boundary && after.trim_start().starts_with('(')
    })
}

/// `(name, byte offset of the start of its signature line)` for every GLSL function
/// `source` defines.
///
/// Recognised as `<return type> <name>(` starting a (non-comment) line **in column zero** --
/// the shape every function in this codebase's shaders is written in, including ones whose
/// parameter list spills onto later lines, since only the first line is needed to find the
/// name.
///
/// **The column-zero rule is load-bearing, not tidiness** (T-0127). Without it, an indented
/// `return displayToRadiance(uHeadShadowColor);` inside another function parses as a
/// definition of "displayToRadiance", and `glsl_function_body` then hands back whatever
/// block happens to follow it as that function's body. Every such statement -- `return
/// vec3(...)`, `return dot(...)`, `return texture(...)` -- minted a phantom function whose
/// "body" was an unrelated slice of its enclosing function, and the moment the LuxCore path
/// called any name that collided with one, `lux_reachable_gem_frag_functions` pulled that
/// slice's calls in and the reachable set ran away to the whole of `gem.frag`. Measured
/// while wiring T-0127's environment seam in: seeding `displayToRadiance`, `toLightingFrame`
/// and `sampleEnvironment` made `arrivingLight`, `traceInterior`, `facetColor` and `heatmap`
/// all "reachable", and `lux_ignored_uniforms` returned an empty list -- i.e. the page would
/// have stopped hiding every control it should hide. A real definition is never indented
/// here; a statement always is.
fn glsl_function_signatures(source: &'static str) -> Vec<(&'static str, usize)> {
    let mut signatures = Vec::new();
    let mut offset = 0usize;

    // `split_inclusive` keeps each line's terminator, so `raw_line.len()` is exactly how
    // many bytes the line occupies in `source` -- one more for "\n", two for "\r\n", none
    // at all for a last line with no terminator. `offset` therefore stays a true byte
    // offset into `source` on every platform; see the note where it is advanced.
    for raw_line in source.split_inclusive('\n') {
        let line = raw_line.trim_end_matches('\n').trim_end_matches('\r');
        let is_definition_line = !line.starts_with(char::is_whitespace);

        if is_definition_line && !line.starts_with("//") {
            if let Some(paren) = line.find('(') {
                let before_paren = line[..paren].trim_end();
                let mut words = before_paren.split_whitespace();

                if let (Some(return_type), Some(name), None) =
                    (words.next(), words.next(), words.next())
                {
                    // `return` is a keyword, never a type. Redundant with the column-zero
                    // rule for the shaders as they are written today, and kept because it
                    // is the failure the rule above exists to prevent: two independent
                    // reasons to reject the one shape that caused real damage.
                    if return_type != "return"
                        && is_glsl_identifier(return_type)
                        && is_glsl_identifier(name)
                    {
                        signatures.push((name, offset));
                    }
                }
            }
        }

        // The terminator is still on `raw_line`, so this needs no guess about how long it
        // is. The previous version walked `lines()` and added `line.len() + 1`, which is
        // right only where a line ends in a bare "\n": on a Windows checkout of this
        // repository (`core.autocrlf=true` rewrites every source file to CRLF) it lost one
        // byte per line, so `offset` pointed steadily further back into the file and
        // `glsl_function_body` returned some earlier function's text. That mis-attributed
        // body fed the call-graph walk above it, and `flat_ignored_uniforms` /
        // `lux_ignored_uniforms` then reported the wrong uniforms -- the two assertion
        // failures this fixes, which could only ever appear on Windows.
        offset += raw_line.len();
    }

    signatures
}

/// The full text of the function whose signature starts at byte `signature_offset` in
/// `source`: from that offset through the matching closing brace, found by counting braces
/// rather than assuming any particular indentation style.
fn glsl_function_body(source: &'static str, signature_offset: usize) -> &'static str {
    let bytes = source.as_bytes();
    let mut i = match source[signature_offset..].find('{') {
        Some(relative) => signature_offset + relative,
        None => return &source[signature_offset..],
    };
    let mut depth = 0i32;

    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return &source[signature_offset..=i];
                }
            }
            _ => {}
        }

        i += 1;
    }

    &source[signature_offset..]
}

/// Every function `GEM_FRAG_SOURCE` defines, as `(name, full body text)`.
fn gem_frag_functions() -> Vec<(&'static str, &'static str)> {
    glsl_function_signatures(GEM_FRAG_SOURCE)
        .into_iter()
        .map(|(name, offset)| (name, glsl_function_body(GEM_FRAG_SOURCE, offset)))
        .collect()
}

/// `gem.frag` functions the LuxCore path reaches, directly or transitively, by a real call.
///
/// Starts from every `gem.frag` function LuxCore's own files (`LUX_SOURCE`) call by name --
/// in practice `traceScene` (`Scene_Intersect`'s one-line delegation) and `tonemap` (the
/// resolve pass's display transfer) -- then closes over further `gem.frag`-internal calls
/// those make (`traceScene` calling `hitAabb` / `hitTriangle` / `fetchTriangle` /
/// `fetchTexel`; `fetchTriangle` calling `fetchTexel`), so a uniform read three calls deep
/// still counts as read.
///
/// **`renderHandWritten` and `renderFlat` are excluded on purpose.** `lux/entry.glsl`'s
/// `main()` calls them by name for the *other* branches of the `uRenderer` toggle, so their
/// names are textually present in `LUX_SOURCE` even though nothing in them runs when LuxCore
/// is selected. Treating them as reachable would pull every uniform their bodies read into
/// "read by the ported path", which is exactly backwards -- see `lux_ignored_uniforms`.
fn lux_reachable_gem_frag_functions() -> Vec<(&'static str, &'static str)> {
    let functions: Vec<_> = gem_frag_functions()
        .into_iter()
        .filter(|(name, _)| *name != "renderHandWritten" && *name != "renderFlat")
        .collect();

    let lux_code = strip_glsl_comments(LUX_SOURCE);
    let reachable: Vec<(&'static str, &'static str)> = functions
        .iter()
        .copied()
        .filter(|(name, _)| calls(&lux_code, name))
        .collect();

    close_over_calls(&functions, reachable)
}

/// `reachable`, plus every function of `functions` that something already in it calls,
/// repeated until nothing more is added: the transitive closure over real calls.
fn close_over_calls(
    functions: &[(&'static str, &'static str)],
    mut reachable: Vec<(&'static str, &'static str)>,
) -> Vec<(&'static str, &'static str)> {
    loop {
        let mut added = false;

        for (name, body) in functions {
            if reachable.iter().any(|(n, _)| n == name) {
                continue;
            }

            let called = reachable
                .iter()
                .any(|(_, caller_body)| calls(&strip_glsl_comments(caller_body), name));

            if called {
                reachable.push((name, body));
                added = true;
            }
        }

        if !added {
            break;
        }
    }

    reachable
}

/// Uniform names `gem.frag` declares that the LuxCore path never reads, directly or through
/// a function call.
///
/// Parses `uniform <type> <name>[...];` declarations out of `GEM_FRAG_SOURCE` the same way
/// the test module's `shader_uniforms` does, then keeps only the names that never occur, as
/// a whole identifier, in `LUX_SOURCE` or in the body of any `gem.frag` function the
/// LuxCore path reaches (`lux_reachable_gem_frag_functions`) -- which is what keeps
/// `uExposure`, `uToneMapMode`, `uTriangles`, `uNodes` and `uNodeCount` off this list even
/// though their names never appear in a `lux/*.glsl` file: they are read inside `tonemap`
/// and `traceScene`, both of which the ported path genuinely calls. This is the computed
/// fact the page's per-renderer control visibility is built from (`hidden_controls_for`),
/// rather than a hand-maintained list: `lux_ignored_uniforms_matches_the_known_gcs_only_
/// uniforms` pins today's answer, so adding or wiring up a uniform on either side of the
/// port breaks a test instead of silently drifting from what the page hides.
fn lux_ignored_uniforms() -> Vec<&'static str> {
    let mut corpus = strip_glsl_comments(LUX_SOURCE);

    for (_, body) in lux_reachable_gem_frag_functions() {
        corpus.push('\n');
        corpus.push_str(body);
    }

    declared_uniforms(GEM_FRAG_SOURCE)
        .into_iter()
        .filter(|name| !identifier_occurs(&corpus, name))
        .collect()
}

/// The names of the uniforms `source` declares (`uniform <type> <name>[...];`), in order.
fn declared_uniforms(source: &'static str) -> Vec<&'static str> {
    source
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("uniform "))
        .filter_map(|line| line.trim_end_matches(';').split_whitespace().last())
        .map(|name| name.split('[').next().unwrap_or(name))
        .collect()
}

/// Uniform names the whole shader declares (`gem.frag` and the ported files alike) that the
/// flat renderer never reads: not in `gem.frag`'s `renderFlat` nor in anything it calls,
/// found with the same call-graph walk as `lux_ignored_uniforms`.
///
/// Unlike `lux_ignored_uniforms`, this counts uniforms the ported files declare too, such as
/// `uLuxCauchyA`: the refractive index slider sets it, and the flat renderer reads none of
/// the uniforms that slider sets, so it must be able to count as ignored here.
fn flat_ignored_uniforms() -> Vec<&'static str> {
    let functions = gem_frag_functions();
    let seed: Vec<_> = functions
        .iter()
        .copied()
        .filter(|(name, _)| *name == "renderFlat")
        .collect();

    let corpus: String = close_over_calls(&functions, seed)
        .iter()
        .map(|(_, body)| strip_glsl_comments(body))
        .collect::<Vec<_>>()
        .join("\n");

    declared_uniforms(GEM_FRAG_SOURCE)
        .into_iter()
        .chain(declared_uniforms(LUX_SOURCE))
        .filter(|name| !identifier_occurs(&corpus, name))
        .collect()
}

/// Page control ids and the uniform(s) each one exists to set, for `hidden_controls_for`.
///
/// Each id is the `id` attribute the Svelte page (`web/src/components/SettingsPanel.svelte`)
/// gives the element (or wrapping fieldset) to hide -- see `syncHiddenControls` in
/// `web/src/lib/session.js`.
///
/// **`uAbsorption` is deliberately not listed here**, and since T-0123 it is no longer one
/// of `lux_ignored_uniforms` either: `src/shaders/lux/volume.glsl` ports LuxCore's
/// `homogeneous` interior volume and `lux/host.glsl` feeds `uAbsorption` to it as the
/// volume's `absorption`, so both renderers now apply the same Beer-Lambert attenuation over
/// each interior segment. A uniform both renderers read can never be hidden for either of
/// them, so listing it here would be dead weight; and there is no dedicated absorption
/// control to hide in the first place -- presets set it, and `kb/page-and-controls.md`
/// records that it has no slider. The page's `lux-absorption-notice` ("not supported by this
/// renderer", added by T-0126 while the gap was real) is now wrong and must come off; that
/// is T-0126's own file (the page, then `www/index.template.html`) and is tracked on that ticket rather
/// than changed from here. `absorption_is_applied_by_both_renderers` below is the check that
/// the Rust half of this is still true.
///
/// `wireframe-row` is the facet wireframe checkbox. Only `renderHandWritten` and `renderFlat`
/// read `uWireframe`, so it is the one control that is genuinely hidden under LuxCore.
///
/// The per-slider rows after it were added with the flat renderer (2026-09-18), which reads
/// none of what they set: the refractive index and dispersion (the deterministic renderer's
/// spectral indices and sample count, and the ported path's Cauchy coefficients), the bounce
/// limit and the window colour. (The head shadow rows are listed too, but the flat renderer
/// reads them: the environment it shows behind the stone applies the head shadow.) Every
/// other renderer reads at least one uniform of each, so they hide under the flat renderer
/// only.
const CONTROL_UNIFORMS: &[(&str, &[&str])] = &[
    (
        "fieldset-lighting",
        &[
            "uLightingModel",
            "uHeadShadowCosine",
            "uHeadShadowColor",
            "uUseBackgroundColor",
            "uBackgroundColor",
            "uUseWindowColor",
            "uWindowColor",
        ],
    ),
    ("wireframe-row", &["uWireframe"]),
    ("refractiveIndex-row", &["uSpectralIor", "uLuxCauchyA", "uLuxCauchyB"]),
    ("dispersion-row", &["uSpectralIor", "uSpectralSamples", "uLuxCauchyB"]),
    ("maxBounces-row", &["uMaxBounces"]),
    ("headShadowHalfAngle-row", &["uHeadShadowCosine"]),
    ("headShadowColor-row", &["uHeadShadowColor"]),
    ("windowColor-row", &["uUseWindowColor", "uWindowColor"]),
];

/// Page control ids the given renderer ignores, in the order `CONTROL_UNIFORMS` lists them.
///
/// A control is hidden for a renderer once *every* uniform it sets is one that renderer's
/// shader code never reads. The deterministic renderer never hides anything: it reads every
/// uniform `CONTROL_UNIFORMS` lists.
fn hidden_controls_for(renderer: params::Renderer) -> Vec<&'static str> {
    let ignored = match renderer {
        params::Renderer::Deterministic => return Vec::new(),
        params::Renderer::LuxCore => lux_ignored_uniforms(),
        params::Renderer::Flat => flat_ignored_uniforms(),
    };

    CONTROL_UNIFORMS
        .iter()
        .filter(|(_, uniforms)| uniforms.iter().all(|u| ignored.contains(u)))
        .map(|(id, _)| *id)
        .collect()
}

/// Name of the per-sun direction uniform array, `uLuxSunDir[LUX_ENV_MAX_SUNS]` in
/// `lux/host.glsl`.
///
/// Held as a constant and indexed with `format!` rather than written out five times,
/// because WebGL reports and locates each array element under its own `name[i]` spelling
/// (see `gpu::collect_uniforms`), and because the plain name is what
/// `every_shader_uniform_is_set_and_every_set_uniform_is_declared` looks for in this file.
const SUN_DIRECTION_UNIFORM: &str = "uLuxSunDir";

/// The LuxCore oracle scene's black matte horizon quad: `--horizon-y` and
/// `--horizon-radius` in `tools/luxcore_oracle.py`.
///
/// `constantinfinite` is a uniform *sphere*, so without this quad light would arrive from
/// below the horizon and the background behind the stone would be sky rather than black.
/// Every analytical model in this project is black below the horizon, so the quad is what
/// makes the oracle scene comparable at all. `src/shaders/lux/host.glsl` explains how the
/// ported path applies it.
const LUX_HORIZON_Y: f32 = -1.2;
const LUX_HORIZON_RADIUS: f32 = 5000.0;

/// `path.russianroulette.cap`. Not set by the oracle's `.cfg`, so this is LuxCore's own
/// default (`PathTracer::ParseOptions`).
const LUX_RR_IMPORTANCE_CAP: f32 = 0.5;

/// Vertex welding tolerance, relative to the model's bounding box diagonal.
///
/// Loose enough to close the hairline gaps that faceting exporters leave when they
/// round coordinates, tight enough never to merge two genuinely distinct vertices on
/// a small facet.
const WELD_EPSILON_SCALE: f32 = 1e-5;

/// Environment map resolution. The width is twice the height, the usual
/// equirectangular aspect, so texels stay roughly square near the horizon.
const ENVIRONMENT_WIDTH: u32 = 1024;
const ENVIRONMENT_HEIGHT: u32 = 512;

/// Texture units. Fixed rather than allocated, since there are only five.
const UNIT_TRIANGLES: u32 = 0;
const UNIT_NODES: u32 = 1;
const UNIT_ENVIRONMENT: u32 = 2;
/// The accumulated radiance sum the ported path reads and re-writes (T-0122).
const UNIT_ACCUMULATION: u32 = 3;
/// One texel per facet id, red channel 1.0 selected / 0.0 not (T-0160). A texture, not a
/// fixed-size uniform array, so a selection can be a whole design tier of any size with no
/// cap that could silently drop facets; see `GemApp::upload_highlight_texture`.
const UNIT_HIGHLIGHT: u32 = 4;

/// Values of the `uLuxPass` uniform: what a given draw is for. Must match the
/// `LUX_PASS_*` constants in `src/shaders/lux/host.glsl`, which is where each one is
/// described; `lux_pass_encoding_matches_the_shader_constants` enforces the match.
const LUX_PASS_DIRECT: i32 = 0;
const LUX_PASS_ACCUMULATE: i32 = 1;
const LUX_PASS_RESOLVE: i32 = 2;

/// GPU resources and statistics for one loaded model.
struct ModelResources {
    triangle_texture: WebGlTexture,
    node_texture: WebGlTexture,
    texture_width: u32,
    node_count: u32,
    triangle_count: u32,
    diagnostics: MeshDiagnostics,
    /// The hierarchy the textures were packed from, kept on the CPU so a click can find the
    /// facet under the pointer (`facet_pose_at`) with the same trace the shader runs.
    accel: Accel,
    /// Each facet's outward normal, indexed by facet id, in the model FILE's own frame --
    /// optical axis on +Z, matching `design.js`'s `GemCadDesign.normalOf` convention -- not
    /// the renderer's Y-up world frame. Computed once at load time by
    /// `mesh::Mesh::facet_normals_in_file_frame`, so `GemApp::facet_normals` (T-0160, for
    /// matching a clicked facet against a loaded design's tiers) is a plain flatten with no
    /// rotation math at call time.
    facet_normals: Vec<Vector3<f32>>,
    /// Where the model file's own coordinates land in the world (`FileFrame`), for
    /// `project_file_points`.
    file_frame: FileFrame,
}

/// The renderer, driven from JavaScript.
///
/// JavaScript owns the animation loop and input events and calls in here; this keeps
/// the Rust side free of event-listener closures and their lifetime handling, and
/// makes the render cadence something the page can control (for instance dropping
/// quality while the user drags).
#[wasm_bindgen]
pub struct GemApp {
    gl: Gl,
    canvas: HtmlCanvasElement,
    program: WebGlProgram,
    uniforms: HashMap<String, WebGlUniformLocation>,
    vertex_array: WebGlVertexArrayObject,
    environment_texture: WebGlTexture,
    /// The cube-map image supplied by the page, kept so the image environment can be
    /// regenerated when the user switches back to it from another lighting model.
    environment_image: Option<env_map::CubeCross>,
    model: ModelResources,
    /// Kept so the model can be rebuilt when the optical axis convention changes.
    source_text: String,
    model_axis: ModelAxis,
    model_name: String,
    camera: OrbitCamera,
    render_params: RenderParams,
    draft_mode: bool,
    /// The facets currently tinted by the deterministic renderer (T-0160): every facet of one
    /// design tier the user clicked or picked a row for, or -- for a plain .obj, which has no
    /// design to look a tier up in -- just the one facet clicked. Cleared whenever the stone
    /// is rebuilt, because facet ids belong to one mesh. Kept in a `BTreeSet` purely so
    /// `upload_highlight_texture`'s iteration order is deterministic; membership, not order,
    /// is what matters.
    highlighted_facets: std::collections::BTreeSet<u32>,
    /// One texel per facet id, mirroring `highlighted_facets` for the shader
    /// (`uHighlightTexture`): red channel 1.0 selected, 0.0 not. Sized to the loaded model's
    /// facet count, not to a fixed cap -- see `upload_highlight_texture`.
    highlight_texture: WebGlTexture,

    // ---- progressive accumulation for the ported LuxCore path (T-0122)
    /// The float ping-pong pair the ported path sums radiance into, or `None` when the
    /// browser cannot render to a float texture. `None` is a working renderer, not a
    /// broken one: the ported path falls back to `LUX_PASS_DIRECT`, exactly what it did
    /// before this existed.
    accumulation: Option<gpu::AccumulationTargets>,
    /// One line saying whether accumulation is on and, if not, precisely why. Readable
    /// from JS as `accumulation_status()`, because "the image is noisy" and "the image is
    /// noisy *because this browser has no EXT_color_buffer_float*" are the same picture.
    accumulation_status: String,
    /// The pass counter and the reset rule. See `params::AccumulationState`.
    accumulation_state: params::AccumulationState,
    /// Bumped whenever the geometry textures are replaced. The stone lives in a texture
    /// rather than in `RenderParams`, so nothing else in the accumulation key would
    /// notice a different stone.
    model_generation: u64,
    /// Bumped whenever the environment texture is regenerated -- including when
    /// `set_environment_image` replaces the image behind an unchanged `lighting_model`,
    /// which the model enum alone cannot distinguish.
    environment_generation: u64,

    /// A fence dropped into the command stream after the last frame's draws, so a caller
    /// can ask whether the GPU has actually finished it (`frame_settled`). `None` before
    /// the first frame, and again once a fence has been waited out.
    ///
    /// Why this exists (T-0197): `render` only *queues* work. It returns in well under a
    /// millisecond while the pass it submitted takes hundreds. A loop that chains passes
    /// on the time `render` takes -- which is what the page's render budget did -- submits
    /// hundreds of full-resolution path traces into a queue the GPU is seconds behind on,
    /// until the driver blocks the submitting thread and the tab, and the desktop
    /// compositor behind it, stop responding.
    frame_fence: Option<web_sys::WebGlSync>,
}

#[wasm_bindgen]
impl GemApp {
    /// Creates the renderer against an existing canvas and loads an OBJ from text.
    ///
    /// The OBJ arrives as a string rather than a URL so the Rust side needs no async
    /// fetch machinery. The page passes in the text of the model inlined into it, or of a
    /// file opened with its file picker or dropped onto it.
    #[wasm_bindgen(constructor)]
    pub fn new(canvas_id: &str, obj_text: &str) -> Result<GemApp, JsValue> {
        // Turns a Rust panic into a readable browser console message instead of the
        // bare "unreachable executed" that wasm otherwise produces.
        console_error_panic_hook::set_once();

        let window = web_sys::window().ok_or_else(|| js_error("no window object"))?;
        let document = window
            .document()
            .ok_or_else(|| js_error("no document object"))?;

        let canvas: HtmlCanvasElement = document
            .get_element_by_id(canvas_id)
            .ok_or_else(|| js_error(&format!("no element with id {:?}", canvas_id)))?
            .dyn_into()
            .map_err(|_| js_error(&format!("element {:?} is not a canvas", canvas_id)))?;

        let gl: Gl = canvas
            .get_context("webgl2")
            .map_err(|error| js_error(&format!("could not get a WebGL2 context: {:?}", error)))?
            .ok_or_else(|| {
                js_error(
                    "WebGL2 is not available in this browser, which the renderer \
                     requires for float textures and texelFetch",
                )
            })?
            .dyn_into()
            .map_err(|_| js_error("the returned context is not a WebGL2 context"))?;

        let program =
            gpu::link_program(&gl, VERTEX_SHADER, FRAGMENT_SHADER).map_err(|e| js_error(&e))?;
        let uniforms = gpu::collect_uniforms(&gl, &program);

        // A vertex array must be bound to draw, even though the vertex shader reads no
        // attributes and builds its triangle from gl_VertexID alone.
        let vertex_array = gl
            .create_vertex_array()
            .ok_or_else(|| js_error("could not create a vertex array"))?;

        let environment =
            generate_environment(LightingModel::Studio, None).map_err(|e| js_error(&e))?;
        let environment_texture = gpu::create_environment_texture(
            &gl,
            environment.width,
            environment.height,
            &environment.texels,
        )
        .map_err(|e| js_error(&e))?;

        let model_axis = ModelAxis::PlusZ;
        let (model, model_name) =
            build_model(&gl, obj_text, model_axis).map_err(|e| js_error(&e))?;

        // Sized to the freshly built model's own facet count, all zero (nothing selected yet)
        // -- never a fixed 1x1 placeholder, which would make `texelFetch(uHighlightTexture,
        // ivec2(facet, 0), 0)` read out of bounds for every facet but 0 once the stone has more
        // than one. See `upload_highlight_texture`, which this mirrors.
        let highlight_texture = build_highlight_texture(
            &gl,
            model.diagnostics.facet_count,
            &std::collections::BTreeSet::new(),
        )
        .map_err(|e| js_error(&e))?;

        // No depth or blending: the whole image is one full-screen triangle, and
        // every pixel is fully determined by its own trace. The accumulation pass adds to
        // the previous sum by reading it, not by blending, so this stays true (see
        // `gpu::AccumulationTargets` for why).
        gl.disable(Gl::DEPTH_TEST);
        gl.disable(Gl::BLEND);
        gl.disable(Gl::CULL_FACE);

        // Probed here, once, rather than at the first frame, so the page can report it
        // before anything is drawn -- and so a browser that cannot do this produces a
        // message instead of a black canvas. The 1x1 allocation is a genuine end-to-end
        // check (extension, texture, framebuffer completeness); `render` resizes it to the
        // backing store on the first pass.
        let (accumulation, accumulation_status) = match gpu::AccumulationTargets::new(&gl, 1, 1) {
            Ok(targets) => (
                Some(targets),
                "on: RGBA32F ping-pong accumulation".to_string(),
            ),
            Err(error) => {
                let status = format!(
                    "off: {}. The LuxCore renderer falls back to averaging luxSamples \
                     samples in a single draw, so raise that slider to reduce its noise.",
                    error
                );

                web_sys::console::warn_1(&JsValue::from_str(&format!(
                    "gem renderer: progressive accumulation is {}",
                    status
                )));

                (None, status)
            }
        };

        Ok(GemApp {
            gl,
            canvas,
            program,
            uniforms,
            vertex_array,
            environment_texture,
            environment_image: None,
            model,
            source_text: obj_text.to_string(),
            model_axis,
            model_name,
            camera: OrbitCamera::default(),
            render_params: RenderParams::default(),
            draft_mode: false,
            highlighted_facets: std::collections::BTreeSet::new(),
            highlight_texture,
            accumulation,
            accumulation_status,
            accumulation_state: params::AccumulationState::new(),
            model_generation: 0,
            environment_generation: 0,
            frame_fence: None,
        })
    }

    /// Replaces the loaded model.
    pub fn load_obj(&mut self, obj_text: &str) -> Result<(), JsValue> {
        let (model, model_name) =
            build_model(&self.gl, obj_text, self.model_axis).map_err(|e| js_error(&e))?;

        // Only release the old textures once the new ones exist, so a failed load
        // leaves the previous stone on screen rather than a blank canvas.
        self.release_model_textures();

        self.model = model;
        self.model_name = model_name;
        self.source_text = obj_text.to_string();
        self.model_generation += 1;
        self.set_highlighted_facet(-1);

        Ok(())
    }

    /// Sets which model-space axis is the stone's optical axis, and reloads.
    ///
    /// Faceting software conventionally puts the table-to-culet axis on +Z, which is
    /// the default, but not every exporter agrees.
    pub fn set_model_axis(&mut self, axis: &str) -> Result<(), JsValue> {
        let parsed = match axis.to_ascii_lowercase().as_str() {
            "x" | "+x" => ModelAxis::PlusX,
            "y" | "+y" => ModelAxis::PlusY,
            "z" | "+z" => ModelAxis::PlusZ,
            other => {
                return Err(js_error(&format!(
                    "unknown model axis {:?}, expected x, y or z",
                    other
                )))
            }
        };

        if parsed == self.model_axis {
            return Ok(());
        }

        // Rebuilt from the kept source with the new axis before anything is committed, so a
        // failed rebuild leaves both the stone on screen and the recorded axis as they were.
        // (The axis used to be stored first, so a failure left it describing geometry that
        // was never built, and the next load_obj would silently use it.)
        let (model, model_name) =
            build_model(&self.gl, &self.source_text, parsed).map_err(|e| js_error(&e))?;

        self.release_model_textures();

        self.model = model;
        self.model_name = model_name;
        self.model_axis = parsed;
        self.model_generation += 1;
        self.set_highlighted_facet(-1);

        Ok(())
    }

    /// Renders one frame at the given backing-store resolution.
    ///
    /// The page passes the pixel dimensions it wants, which lets it trade resolution
    /// for latency while the user is interacting. That matters more here than in most
    /// renderers: the per-pixel cost is a full interior path trace, so halving the
    /// resolution is close to a 4x speedup.
    ///
    /// # One frame, or one pass of many (T-0122)
    ///
    /// For the deterministic renderer this is the whole image: one call always produces the
    /// same result, so it converges immediately. For the ported LuxCore path it is one Monte
    /// Carlo **pass**, added
    /// to a running sum that the resolve pass divides by the number of passes so far. So
    /// calling this repeatedly at unchanged settings keeps improving the image, and
    /// changing anything that affects the image starts the sum again -- see
    /// `params::AccumulationKey` for exactly what "anything" is. `accumulated_passes()`
    /// says how far along it is, and `accumulation_complete()` when there is no point
    /// asking for more.
    ///
    /// `&mut self` because of that counter. It is the only state a frame leaves behind.
    ///
    /// # This call does not wait for the picture (T-0197)
    ///
    /// It submits the draws and returns; the GPU finishes them afterwards. Ask
    /// `frame_settled()` whether it has. A caller that chains passes -- the page's
    /// accumulation loop -- **must** wait for that before submitting the next one, or it
    /// will queue work far faster than the GPU retires it.
    pub fn render(&mut self, width: u32, height: u32) {
        self.render_pass(width, height);
        self.place_frame_fence();
    }

    /// Whether the GPU has finished the frame `render()` last submitted.
    ///
    /// True when there is no frame outstanding, so a caller that has never rendered, or
    /// that has already waited this frame out, is never blocked. Polling this costs a
    /// `clientWaitSync` with a zero timeout, which asks and returns rather than waits, so
    /// it never blocks the page thread.
    pub fn frame_settled(&mut self) -> bool {
        let Some(fence) = self.frame_fence.take() else {
            return true;
        };

        let status = self.gl.client_wait_sync_with_u32(&fence, 0, 0);

        // ALREADY_SIGNALED and CONDITION_SATISFIED both mean done. WAIT_FAILED means the
        // fence is no use to anyone -- a lost context, or a driver that will not honour it
        // -- and is treated as done rather than left to stall the loop for ever. Only
        // TIMEOUT_EXPIRED is "not yet", and only then is the fence kept for the next ask.
        if status == Gl::TIMEOUT_EXPIRED {
            self.frame_fence = Some(fence);
            return false;
        }

        self.gl.delete_sync(Some(&fence));

        true
    }

    /// Renders one frame, without fencing it. See `render`.
    fn render_pass(&mut self, width: u32, height: u32) {
        let width = width.max(1);
        let height = height.max(1);

        self.resize_canvas(width, height);

        let effective = self.effective_params();

        if !self.accumulates(&effective) {
            // The deterministic renderer, every debug view, and the fallback when no float
            // render target exists: one draw straight to the canvas, exactly as before
            // T-0122. The state is reset rather than left alone so that switching to the
            // ported path later cannot resume a sum taken under settings that were never
            // recorded against it.
            self.accumulation_state.reset();
            self.draw_to_canvas(width, height, &effective, LUX_PASS_DIRECT, 0, 1);

            return;
        }

        let plan = self.accumulation_state.begin_pass(params::AccumulationKey {
            params: effective.clone(),
            camera: self.camera,
            width,
            height,
            model_generation: self.model_generation,
            environment_generation: self.environment_generation,
        });

        if plan.restarted {
            if let Err(error) = self.restart_accumulation_targets(width, height) {
                // Losing the buffers mid-session is not something to paper over, but it is
                // also not a reason to stop drawing: drop to the single-draw path for this
                // frame and every later one, and say so.
                self.disable_accumulation(&error);
                self.accumulation_state.reset();
                self.draw_to_canvas(width, height, &effective, LUX_PASS_DIRECT, 0, 1);

                return;
            }
        }

        if plan.accumulate {
            // A different seed per pass is what makes the passes independent estimates.
            // Wrapping rather than saturating: an arbitrary 32-bit value is exactly what
            // the shader's hash wants, and a saturating add would hand every pass past the
            // limit the same stream.
            let seed = effective.lux_seed.wrapping_add(plan.index);

            if let Some(targets) = self.accumulation.as_ref() {
                targets.bind_destination(&self.gl);
            }

            self.draw_trace(width, height, &effective, LUX_PASS_ACCUMULATE, seed, plan.total);

            // The pass just drawn is now the sum to read, both by the resolve below and by
            // the next pass.
            if let Some(targets) = self.accumulation.as_mut() {
                targets.advance();
            }
        }

        // Always resolve, even on a pass that added nothing: the canvas is not preserved
        // between frames (`preserveDrawingBuffer` is false), so the image has to be
        // redrawn from the sum every time it is asked for. `draw_to_canvas` is what
        // unbinds the accumulation framebuffer the pass above left bound.
        self.draw_to_canvas(
            width,
            height,
            &effective,
            LUX_PASS_RESOLVE,
            effective.lux_seed,
            plan.total,
        );
    }

    /// Throws the accumulated image away, so the next `render()` starts a new sum.
    ///
    /// Nothing normally needs this -- every change that invalidates the sum is noticed by
    /// `params::AccumulationKey` -- but "reset, then render N times" is a reproducible
    /// unit of work that `tests/harness/gem.py` builds its byte-identical capture on, and
    /// that is worth being able to ask for by name rather than provoke.
    pub fn reset_accumulation(&mut self) {
        self.accumulation_state.reset();
    }

    /// How many passes the image on screen is the average of. 0 before the first frame,
    /// and 1 for the deterministic renderer, which converges in one.
    pub fn accumulated_passes(&self) -> u32 {
        self.accumulation_state.passes()
    }

    /// Changes every time the current accumulation restarts, and only then.
    ///
    /// This is the honest hook for a caller that wants to time how long the current
    /// accumulation has been running: it fires on exactly the condition
    /// `params::AccumulationKey` already uses to decide the sum must be thrown away (any
    /// change to the effective params, the camera, the backing-store size, or the model or
    /// environment generation), so a page timing elapsed seconds can watch this number
    /// instead of re-deriving that rule in JavaScript, which is how such a copy would drift
    /// out of step with this one. Two reads that return the same value are the same run of
    /// samples; any change between them means at least one restart happened.
    pub fn accumulation_generation(&self) -> u32 {
        self.accumulation_state.generation()
    }

    /// True when the current settings accumulate across frames, so the page knows whether
    /// to keep asking for them.
    pub fn accumulating(&self) -> bool {
        self.accumulates(&self.effective_params())
    }

    /// True when no further pass would be added, so a caller driving frames to convergence
    /// can stop.
    pub fn accumulation_complete(&self) -> bool {
        self.accumulation_state.is_complete()
    }

    /// Whether progressive accumulation is available, and if not, exactly why.
    ///
    /// Worth showing on the page: a missing `EXT_color_buffer_float` turns the ported
    /// renderer back into the noisy one-draw estimator it was before T-0122, and nothing
    /// about the picture says which of the two is on screen.
    pub fn accumulation_status(&self) -> String {
        self.accumulation_status.clone()
    }

    /// Rotates the view. Deltas are in radians: `delta_spin` turns the stone about its
    /// optical axis, `delta_tilt` tips that axis (positive as Gem Cut Studio's positive X
    /// Rotation). For absolute angles use the `spin` and `tilt` parameters.
    pub fn orbit(&mut self, delta_spin: f32, delta_tilt: f32) {
        self.camera.orbit(delta_spin, delta_tilt);
    }

    /// The facet under a point of the canvas and the pose that looks squarely at it, as
    /// `[spin, tilt, facet]`: spin and tilt in degrees (the units of the `spin` and `tilt`
    /// parameters), then the facet id for `set_highlighted_facet`. An empty array when the
    /// point misses the stone. Changes nothing: the page animates the camera there itself, so
    /// the turn is visible rather than a jump.
    ///
    /// `ndc_x` and `ndc_y` are normalised device coordinates, (-1, -1) at the bottom left and
    /// (1, 1) at the top right, as the shader's `vNdc`. The aspect is the last frame's backing
    /// store, which is exactly the image the user clicked on.
    pub fn facet_pose_at(&self, ndc_x: f32, ndc_y: f32) -> Vec<f32> {
        let aspect = self.canvas.width().max(1) as f32 / self.canvas.height().max(1) as f32;

        match facet_pose_at(&self.model.accel, &self.camera, aspect, ndc_x, ndc_y) {
            Some(pick) => vec![pick.spin.to_degrees(), pick.tilt.to_degrees(), pick.facet as f32],
            None => Vec::new(),
        }
    }

    /// Tints a SET of facets as selected, by id (from `facet_pose_at`, or the page's own
    /// facet-to-tier map -- see `kb/the-polar-internal-representation.md` and
    /// `buildFacetTierMap` in `web/src/lib/facet_map.js`); replaces whatever was selected
    /// before, and an empty slice clears the selection. Drawn by the deterministic renderer
    /// only, like the wireframe (`lux_ignored_uniforms_matches_the_known_gcs_only_uniforms`
    /// pins `uHighlightTexture` as one of the uniforms no ported file reads), and cleared when
    /// a new stone loads.
    ///
    /// T-0160 replaced the single-facet `set_highlighted_facet` with this: clicking a facet
    /// now highlights every facet of its design tier, which can be far more than one, and a
    /// fixed-size uniform array would silently drop facets past its cap on a large tier. See
    /// `upload_highlight_texture` for how the set is actually drawn.
    pub fn set_highlighted_facets(&mut self, facets: &[u32]) {
        self.highlighted_facets = facets.iter().copied().collect();
        self.upload_highlight_texture();
    }

    /// One-facet convenience wrapper around `set_highlighted_facets`, e.g. for a plain `.obj`
    /// with no design to look a tier up in, where a click still highlights just the one facet
    /// clicked. Any negative id clears the selection.
    pub fn set_highlighted_facet(&mut self, facet: i32) {
        match u32::try_from(facet) {
            Ok(facet) => self.set_highlighted_facets(&[facet]),
            Err(_) => self.set_highlighted_facets(&[]),
        }
    }

    /// The selected facet's id, or -1 when none, or more than one, is selected. A convenience
    /// for a caller that only ever put one facet in with `set_highlighted_facet`; a page that
    /// highlights a whole tier should read `highlighted_facets()` instead.
    pub fn highlighted_facet(&self) -> i32 {
        let mut facets = self.highlighted_facets.iter();

        match (facets.next(), facets.next()) {
            (Some(&only), None) => i32::try_from(only).unwrap_or(-1),
            _ => -1,
        }
    }

    /// Every currently selected facet id, in ascending order.
    pub fn highlighted_facets(&self) -> Vec<u32> {
        self.highlighted_facets.iter().copied().collect()
    }

    /// Rebuilds `uHighlightTexture` from `self.highlighted_facets` and the current model's own
    /// facet count.
    ///
    /// Called on every selection change, not just on load: the texture has to track BOTH the
    /// selection (changes on every click) and the model's facet count (changes on every load),
    /// so this reads both fresh each time rather than caching either.
    fn upload_highlight_texture(&mut self) {
        match build_highlight_texture(
            &self.gl,
            self.model.diagnostics.facet_count,
            &self.highlighted_facets,
        ) {
            Ok(texture) => {
                self.gl.delete_texture(Some(&self.highlight_texture));
                self.highlight_texture = texture;
            }
            Err(error) => {
                // Should not happen -- the same texture class the model's own textures just
                // used moments earlier -- but a highlight that fails to upload must not crash
                // the renderer; log and keep whatever texture was bound before (stale, but
                // harmless: the shader still reads a valid RGBA32F texture, just not this
                // selection's).
                web_sys::console::warn_1(&JsValue::from_str(&format!(
                    "gem renderer: could not upload the highlight texture: {}",
                    error
                )));
            }
        }
    }

    /// Each facet's outward normal, flattened as `[x0, y0, z0, x1, y1, z1, ...]` and indexed
    /// by facet id -- the same id `facet_pose_at` and `set_highlighted_facets` use.
    ///
    /// Given in the model FILE's own frame: optical axis on +Z, matching `design.js`'s
    /// `GemCadDesign.normalOf` convention (`kb/the-polar-internal-representation.md`'s forward
    /// map) -- NOT the renderer's Y-up world frame `mesh::reorient_axis_to_y` turns the mesh
    /// into for viewing. `build_model` undoes that rotation once at load time
    /// (`mesh::Mesh::facet_normals_in_file_frame`), so the page can match a clicked facet's
    /// normal against a loaded design's tiers with no knowledge of `model_axis` at all. See
    /// `mesh::tests::facet_normals_in_file_frame_undoes_reorient_axis_to_y_for_every_model_axis`
    /// for the proof this is exactly the inverse of the forward turn.
    pub fn facet_normals(&self) -> Vec<f32> {
        let mut flat = Vec::with_capacity(self.model.facet_normals.len() * 3);

        for normal in &self.model.facet_normals {
            flat.push(normal.x);
            flat.push(normal.y);
            flat.push(normal.z);
        }

        flat
    }

    /// Where points given in the model FILE's own coordinates (a design's frame, as
    /// `facet_normals` uses) appear on the canvas now, for the page's edit-mode overlay (the
    /// cutting plane drawn over the stone). `points` is flattened
    /// `[x0, y0, z0, x1, ...]`; the result is flattened `[ndc_x0, ndc_y0, depth0, ...]`, in
    /// normalised device coordinates as `facet_pose_at` takes them, with `depth` the distance
    /// in front of the eye (skip a point whose depth is not positive). Uses the last frame's
    /// backing-store aspect, like `facet_pose_at`, so it matches the image on screen.
    pub fn project_file_points(&self, points: &[f32]) -> Vec<f32> {
        let aspect = self.canvas.width().max(1) as f32 / self.canvas.height().max(1) as f32;
        let basis = self.camera.basis(aspect);
        let mut projected = Vec::with_capacity(points.len());

        for point in points.chunks_exact(3) {
            let world = self
                .model
                .file_frame
                .to_world(nalgebra::Point3::new(point[0], point[1], point[2]));
            let (x, y, depth) = basis.project(world);

            projected.extend_from_slice(&[x, y, depth]);
        }

        projected
    }

    /// Scales the orbit distance. Above 1 moves away from the stone.
    pub fn zoom(&mut self, factor: f32) {
        self.camera.zoom(factor);
    }

    /// Enables reduced quality for interaction: halves the internal bounce count.
    ///
    /// Dispersion is deliberately kept, because fire is what rotating a stone is for;
    /// see `RenderParams::draft`. The page is expected to drop canvas resolution at
    /// the same time, which saves more and is much less noticeable on a moving image.
    ///
    /// Applied on top of the user's settings rather than overwriting them, so leaving
    /// draft mode restores exactly what was configured.
    pub fn set_draft_mode(&mut self, enabled: bool) {
        self.draft_mode = enabled;
    }

    /// Whether draft mode is on: half the bounces and a quarter of the samples
    /// (`RenderParams::draft`), which the page turns on while anything is being moved and off
    /// again shortly after. Readable so a test can prove a drag really is drafting.
    pub fn draft_mode(&self) -> bool {
        self.draft_mode
    }

    /// Applies a named material preset, for example "diamond" or "sapphire".
    pub fn set_material(&mut self, name: &str) -> Result<(), JsValue> {
        let material = params::material_by_name(name)
            .ok_or_else(|| js_error(&format!("unknown material {:?}", name)))?;

        self.render_params.apply_material(material);
        self.render_params.clamp();

        Ok(())
    }

    /// Newline-separated list of available material presets, for building a menu.
    pub fn material_names(&self) -> String {
        params::MATERIALS
            .iter()
            .map(|material| material.name)
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Sets a single numeric parameter by name.
    ///
    /// Every value is clamped afterwards, so no input from the page can produce a
    /// black frame or a hung shader loop.
    pub fn set_param(&mut self, name: &str, value: f32) -> Result<(), JsValue> {
        if !value.is_finite() {
            return Err(js_error(&format!(
                "parameter {:?} was given a non-finite value",
                name
            )));
        }

        match name {
            "refractiveIndex" => self.render_params.refractive_index = value,
            "dispersion" => self.render_params.dispersion = value,
            "absorptionScale" => self.render_params.absorption_scale = value,
            "maxBounces" => self.render_params.max_bounces = value.max(0.0) as u32,
            "spectralSamples" => self.render_params.spectral_samples = value.max(0.0) as u32,
            "exposure" => self.render_params.exposure = value,
            "envIntensity" => self.render_params.env_intensity = value,
            "envRotation" => self.render_params.env_rotation = value,
            "exhaustionShade" => self.render_params.exhaustion_shade = value,
            // World units; the stone is normalised to radius 1.
            "observerRadius" => self.render_params.observer_radius = value,
            // Radians. Zero, or anything too narrow to be a useful lens, removes the lens and
            // returns to the projection eyeDistance selects; see camera::MIN_PERSPECTIVE_FOV.
            "fov" => self.camera.set_vertical_fov(value),
            // World units from the target to Gem Cut Studio's perspective eye, 52 by default
            // (camera::GEM_CUT_STUDIO_EYE_DISTANCE). Zero or less selects orthographic.
            "eyeDistance" => self.camera.set_eye_distance(value),
            // Degrees, like the page's X and Y rotation sliders, wrapped into [-180, 180).
            // Tilt is positive as Gem Cut Studio's positive X Rotation.
            "spin" => self
                .camera
                .set_orientation(value.to_radians(), self.camera.tilt),
            "tilt" => self
                .camera
                .set_orientation(self.camera.spin, value.to_radians()),
            // Accepted in degrees rather than radians, because that is the unit the
            // concept is quoted in everywhere it appears -- including Gem Cut Studio,
            // whose values should be transferable to this control without conversion.
            "headShadowHalfAngle" => {
                self.render_params.head_shadow_half_angle = value.to_radians()
            }
            // Only the ported LuxCore path reads these three; see `params::Renderer`.
            "luxSamples" => self.render_params.lux_samples = value.max(0.0) as u32,
            "luxSeed" => self.render_params.lux_seed = value.max(0.0) as u32,
            // 0 lights the ported path with the lighting model the page shows, 1 with
            // LuxCore's own `constantinfinite` sky plus suns -- the rig
            // `tools/compare_luxcore.py` scores the port against. See
            // `params::LuxEnvironment`. A parameter rather than a page control: it selects
            // between "what the user asked for" and a validation rig, and only the harness
            // (or a console call) has any business asking for the second.
            "luxEnvironment" => {
                self.render_params.lux_environment =
                    params::LuxEnvironment::from_u32(value.max(0.0) as u32)
            }
            other => return Err(js_error(&format!("unknown parameter {:?}", other))),
        }

        self.render_params.clamp();

        Ok(())
    }

    /// Reads back a numeric parameter, so the page can populate its controls without
    /// duplicating the defaults.
    pub fn get_param(&self, name: &str) -> Result<f32, JsValue> {
        let value = match name {
            "refractiveIndex" => self.render_params.refractive_index,
            "dispersion" => self.render_params.dispersion,
            "absorptionScale" => self.render_params.absorption_scale,
            "maxBounces" => self.render_params.max_bounces as f32,
            "spectralSamples" => self.render_params.spectral_samples as f32,
            "exposure" => self.render_params.exposure,
            "envIntensity" => self.render_params.env_intensity,
            "envRotation" => self.render_params.env_rotation,
            "exhaustionShade" => self.render_params.exhaustion_shade,
            "observerRadius" => self.render_params.observer_radius,
            "fov" => self.camera.vertical_fov,
            "eyeDistance" => self.camera.eye_distance,
            "spin" => self.camera.spin.to_degrees(),
            "tilt" => self.camera.tilt.to_degrees(),
            "headShadowHalfAngle" => self.render_params.head_shadow_half_angle.to_degrees(),
            "luxSamples" => self.render_params.lux_samples as f32,
            "luxSeed" => self.render_params.lux_seed as f32,
            "luxEnvironment" => self.render_params.lux_environment.as_u32() as f32,
            other => return Err(js_error(&format!("unknown parameter {:?}", other))),
        };

        Ok(value)
    }

    /// Selects which path tracer renders the frame: 0 the deterministic one, 1 the ported
    /// LuxCore one (T-0120).
    ///
    /// Both are compiled into the same program, so this is a uniform change and costs
    /// nothing -- unlike `set_lighting_model`, it can be toggled freely.
    ///
    /// The ported path is a Monte Carlo integrator: it averages `luxSamples` samples per
    /// pixel inside one draw, so it is roughly that many times slower than the deterministic
    /// path and noisier at low sample counts.
    ///
    /// Since T-0127 it lights the stone with **the selected lighting model**, like the
    /// deterministic path: every assessment model, the Studio rig, the skybox image, the
    /// head-shadow cone, the environment rotation and intensity, and the flat background and
    /// window colour for light arriving from below the lighting horizon. What it still does
    /// not implement is the part of this project's Gem Cut Studio matching that needs more
    /// than a direction at the environment seam -- the observer dot and the back-facet half
    /// of the leak rule (T-0134) -- plus the out-of-bounces shade. `luxEnvironment` switches
    /// it back to LuxCore's own `constantinfinite` sky plus suns for the oracle comparison;
    /// see `params::LuxEnvironment` and `src/shaders/lux/entry.glsl`.
    pub fn set_renderer(&mut self, renderer: u32) {
        self.render_params.renderer = params::Renderer::from_u32(renderer);
    }

    pub fn renderer(&self) -> u32 {
        self.render_params.renderer.as_u32()
    }

    /// The renderer names, newline separated, in encoding order, for building a menu.
    pub fn renderer_names(&self) -> String {
        params::Renderer::all()
            .iter()
            .map(|renderer| renderer.name())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Page control ids the given renderer ignores, newline separated, so the page can hide
    /// them and show them again without a reload (T-0126).
    ///
    /// This is a computed fact about the shader, not a hand-maintained list: see
    /// `hidden_controls_for`, `lux_ignored_uniforms` and `flat_ignored_uniforms`. Empty for
    /// the deterministic renderer; for LuxCore it is only the facet wireframe checkbox, which
    /// the ported path does not draw; for the flat renderer, the refractive index,
    /// dispersion, bounce limit and window colour.
    pub fn hidden_controls(&self, renderer: u32) -> String {
        hidden_controls_for(params::Renderer::from_u32(renderer)).join("\n")
    }

    /// Every page control id `hidden_controls` could ever name, for any renderer, newline
    /// separated.
    ///
    /// The page uses this to know which elements to put back to visible when a renderer
    /// stops ignoring them (`syncHiddenControls` in `web/src/lib/session.js`): `hidden_controls`
    /// only ever names what is *currently* hidden, so restoring "everything not currently
    /// hidden" needs the full universe of ids that could be, not a list re-typed on the
    /// page and liable to miss one `CONTROL_UNIFORMS` gains later.
    pub fn hideable_controls(&self) -> String {
        CONTROL_UNIFORMS
            .iter()
            .map(|(id, _)| *id)
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Selects the lighting environment: 0 studio, 1 angle rings, 2 isometric, 3 cosine,
    /// 4 the image supplied with `set_environment_image`.
    ///
    /// Regenerates and re-uploads the environment texture, so this is much more
    /// expensive than a parameter change and should not be driven from a slider.
    pub fn set_lighting_model(&mut self, model: u32) -> Result<(), JsValue> {
        let requested = LightingModel::from_u32(model);

        if requested == self.render_params.lighting_model {
            return Ok(());
        }

        self.upload_environment(requested)
    }

    /// Supplies a cube-map image as the environment, and switches to it.
    ///
    /// `rgba` is `width * height * 4` bytes, as the browser's `getImageData` returns. The
    /// image must be a horizontal cross (4:3, square faces), the usual skybox layout; see
    /// `env_map::CROSS_FACES`. The page decodes the file, so no image codec has to be
    /// compiled into the wasm module.
    pub fn set_environment_image(
        &mut self,
        rgba: &[u8],
        width: u32,
        height: u32,
    ) -> Result<(), JsValue> {
        let image =
            env_map::CubeCross::from_rgba8(rgba, width, height).map_err(|e| js_error(&e))?;

        // Keep the previous image until the new environment is on the GPU, so a failed
        // upload leaves the scene lit the way it was.
        let previous = self.environment_image.replace(image);
        let result = self.upload_environment(LightingModel::Image);

        if result.is_err() {
            self.environment_image = previous;
        }

        result
    }

    /// Whether an environment image has been supplied, so the Image model can be used.
    pub fn has_environment_image(&self) -> bool {
        self.environment_image.is_some()
    }

    /// The lighting model names, newline separated, in encoding order.
    pub fn lighting_model_names(&self) -> String {
        LightingModel::all()
            .iter()
            .map(|model| model.name())
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn lighting_model(&self) -> u32 {
        self.render_params.lighting_model.as_u32()
    }

    /// Sets the flat backdrop colour, and whether to use it instead of the environment.
    ///
    /// When enabled it also colours light arriving from behind the stone while the window
    /// colour is off; see `params::RenderParams::use_background_color`. Channels are in 0..1. Taken as three floats rather than a packed integer or a CSS
    /// string so there is no parsing in the wasm boundary.
    pub fn set_background(&mut self, enabled: bool, red: f32, green: f32, blue: f32) {
        self.render_params.use_background_color = enabled;
        self.render_params.background_color = Vector3::new(red, green, blue);
        self.render_params.clamp();
    }

    /// Sets the colour for light arriving from behind the stone, and whether to use it.
    /// Channels in 0..1. "Behind" means light from below the lighting horizon, or light leaving
    /// through a facet that faces below it; see `params::RenderParams::use_window_color`.
    ///
    /// Gem Cut Studio's "Use Separate Window Color". When disabled, that light shows the
    /// flat background colour if that is enabled, and the environment otherwise.
    pub fn set_window_color(&mut self, enabled: bool, red: f32, green: f32, blue: f32) {
        self.render_params.use_window_color = enabled;
        self.render_params.window_color = Vector3::new(red, green, blue);
        self.render_params.clamp();
    }

    /// Whether leaked light shows the separate window colour.
    pub fn window_color_enabled(&self) -> bool {
        self.render_params.use_window_color
    }

    /// The window colour as `[red, green, blue]`, channels in 0..1.
    pub fn window_color(&self) -> Vec<f32> {
        let color = self.render_params.window_color;

        vec![color.x, color.y, color.z]
    }

    /// Fixes the lighting and head shadow to the viewer (true, the default, as in Gem Cut
    /// Studio) or to the world (false). See `params::RenderParams::lighting_follows_view`.
    pub fn set_lighting_follows_view(&mut self, enabled: bool) {
        self.render_params.lighting_follows_view = enabled;
    }

    pub fn lighting_follows_view(&self) -> bool {
        self.render_params.lighting_follows_view
    }

    /// Whether rays that miss the stone, and leaked light while the window colour is off, show
    /// the flat background colour.
    ///
    /// Exposed, with `background_color`, so the page initialises its controls from the
    /// Rust defaults instead of duplicating them.
    pub fn background_enabled(&self) -> bool {
        self.render_params.use_background_color
    }

    /// The flat background colour as `[red, green, blue]`, channels in 0..1.
    pub fn background_color(&self) -> Vec<f32> {
        let color = self.render_params.background_color;

        vec![color.x, color.y, color.z]
    }

    /// The head shadow colour as `[red, green, blue]`, channels in 0..1, so the page can
    /// initialise its colour picker from the Rust default.
    pub fn head_shadow_color(&self) -> Vec<f32> {
        let color = self.render_params.head_shadow_color;

        vec![color.x, color.y, color.z]
    }

    /// Name of the material preset the renderer starts with, for selecting it in the
    /// page's menu.
    pub fn default_material_name(&self) -> String {
        params::DEFAULT_MATERIAL_NAME.to_string()
    }

    /// Sets the colour the head shadow contributes. Channels in 0..1.
    ///
    /// Black is the physically sensible default, but a saturated colour here is the
    /// quickest way to see *which* parts of a stone depend on light from behind the
    /// observer, as distinct from parts that are dark for any other reason.
    pub fn set_head_shadow_color(&mut self, red: f32, green: f32, blue: f32) {
        self.render_params.head_shadow_color = Vector3::new(red, green, blue);
        self.render_params.clamp();
    }

    /// The stone's colour as `[red, green, blue]`, channels in 0..1: how much of each channel
    /// survives one world unit inside it. White is colourless. See
    /// `params::RenderParams::stone_color`.
    pub fn stone_color(&self) -> Vec<f32> {
        let color = self.render_params.stone_color();

        vec![color.x, color.y, color.z]
    }

    /// Sets the stone's colour, channels in 0..1, by setting the absorption that gives it.
    /// Replaces the preset's absorption and resets the absorption scale to 1.
    pub fn set_stone_color(&mut self, red: f32, green: f32, blue: f32) {
        self.render_params.set_stone_color(Vector3::new(red, green, blue));
        self.render_params.clamp();
    }

    /// The stone's colour at an absorption scale of 1, `[red, green, blue]` in 0..1: what the page's
    /// colour editor shows while its opacity slider is the `absorptionScale` parameter. See
    /// `params::RenderParams::stone_base_color`.
    pub fn stone_base_color(&self) -> Vec<f32> {
        let color = self.render_params.stone_base_color();

        vec![color.x, color.y, color.z]
    }

    /// Sets the stone's colour at an absorption scale of 1 by setting the absorption, and leaves
    /// the absorption scale as it is (`set_stone_color` resets it).
    pub fn set_stone_base_color(&mut self, red: f32, green: f32, blue: f32) {
        self.render_params.set_stone_base_color(Vector3::new(red, green, blue));
        self.render_params.clamp();
    }

    /// Neutralises the material for use with an analytical lighting model.
    ///
    /// See `RenderParams::analytical`: the gem's own colour multiplies the lighting
    /// model, so an Angle Rings reading taken through a coloured, dispersive stone
    /// cannot be interpreted as an angle.
    pub fn neutralise_material(&mut self) {
        self.render_params = self.render_params.analytical();
    }

    /// Outlines every facet the viewer can see (true, the default) or not. Only the
    /// deterministic renderer draws it; see `params::RenderParams::wireframe`.
    pub fn set_wireframe(&mut self, enabled: bool) {
        self.render_params.wireframe = enabled;
    }

    /// Whether the facet wireframe is on, so the page can initialise its checkbox.
    pub fn wireframe_enabled(&self) -> bool {
        self.render_params.wireframe
    }

    /// Selects the display mode: 0 full render, 1 normals, 2 facet ids,
    /// 3 traversal cost, 4 bounce count.
    pub fn set_debug_mode(&mut self, mode: u32) {
        self.render_params.debug_mode = DebugMode::from_u32(mode);
    }

    /// Human-readable report on the loaded model.
    ///
    /// Worth checking whenever a stone renders oddly: a stone that is not watertight renders
    /// with scattered black pixels, and there is no way to guess that cause from the image.
    /// The page no longer shows it, since its stats box was removed at the user's request. Read
    /// it from the browser console with `gemApp.diagnostics_text()`.
    pub fn diagnostics_text(&self) -> String {
        let d = &self.model.diagnostics;

        let mut lines = vec![
            format!("model: {}", self.model_name),
            format!("vertices: {}", d.vertex_count),
            format!("triangles: {}", d.triangle_count),
            format!("facets: {}", d.facet_count),
            format!("BVH nodes: {}", self.model.node_count),
            format!("volume: {:.5}", d.signed_volume),
        ];

        if d.welded_away > 0 {
            lines.push(format!("welded {} duplicate vertices", d.welded_away));
        }

        if d.degenerate_dropped > 0 {
            lines.push(format!(
                "dropped {} zero-area triangles",
                d.degenerate_dropped
            ));
        }

        if d.winding_was_flipped {
            lines.push("winding: flipped to outward (source was inward)".to_string());
        } else {
            lines.push("winding: already outward".to_string());
        }

        if d.is_watertight() {
            lines.push("watertight: yes".to_string());
        } else {
            lines.push(format!(
                "WATERTIGHT: NO - {} open edges, {} non-manifold edges. \
                 Internal rays will leak and show as black speckles.",
                d.boundary_edges, d.non_manifold_edges
            ));
        }

        lines.join("\n")
    }

    /// True when the loaded model is a closed, orientable solid.
    pub fn is_watertight(&self) -> bool {
        self.model.diagnostics.is_watertight()
    }

    pub fn triangle_count(&self) -> u32 {
        self.model.triangle_count
    }

    pub fn facet_count(&self) -> u32 {
        self.model.diagnostics.facet_count
    }
}

impl GemApp {
    /// Drops a fence into the command stream after the frame just submitted, replacing
    /// any fence still outstanding, so `frame_settled` can tell when the GPU has caught
    /// up (T-0197).
    ///
    /// The `flush` is not optional. `clientWaitSync` with no `SYNC_FLUSH_COMMANDS_BIT`
    /// does not push the queue along, and WebGL's own implicit flush happens at the end
    /// of the task -- so without this a poll from a later timer could look at a fence
    /// whose commands were never submitted and would never signal.
    fn place_frame_fence(&mut self) {
        if let Some(previous) = self.frame_fence.take() {
            // Only reached when a caller renders again without waiting. Deleting the old
            // fence rather than keeping it means `frame_settled` always refers to the
            // most recent frame, which is the one a caller actually wants to know about.
            self.gl.delete_sync(Some(&previous));
        }

        self.frame_fence = self.gl.fence_sync(Gl::SYNC_GPU_COMMANDS_COMPLETE, 0);
        self.gl.flush();
    }

    /// Parameters actually sent to the shader, after draft-mode reduction.
    ///
    /// The reduction itself lives in `RenderParams::draft` so it can be unit tested
    /// on the host; nothing about it needs a GL context.
    fn effective_params(&self) -> RenderParams {
        if self.draft_mode {
            self.render_params.draft()
        } else {
            self.render_params.clone()
        }
    }

    /// Whether this frame accumulates across passes rather than standing on its own.
    ///
    /// All three conditions are needed, and each fails differently if forgotten. The
    /// deterministic path always produces the same image for the same inputs, so
    /// accumulating it would average a frame with copies of itself -- harmless but
    /// pointless, and it would put a second draw on the
    /// critical path of the renderer this ticket must not regress. The debug views read a
    /// single deterministic primary hit and are handed to `renderHandWritten` inside the
    /// shader whichever renderer is selected, so accumulating them would write
    /// facet-id colours into a radiance buffer and then divide them by a pass count.
    /// And without the float targets there is nowhere to accumulate into.
    fn accumulates(&self, effective: &RenderParams) -> bool {
        effective.renderer == params::Renderer::LuxCore
            && effective.debug_mode == DebugMode::Full
            && self.accumulation.is_some()
    }

    /// Sizes the accumulation targets to the frame and zeroes them.
    ///
    /// Called only when a pass reports `restarted`, which is also the only moment the size
    /// can have changed -- the backing-store size is part of the accumulation key.
    fn restart_accumulation_targets(&mut self, width: u32, height: u32) -> Result<(), String> {
        // Two disjoint fields, so the borrow checker allows the immutable `gl` alongside
        // the mutable targets.
        let gl = &self.gl;
        let targets = self
            .accumulation
            .as_mut()
            .ok_or_else(|| "the accumulation targets are gone".to_string())?;

        // A reallocation arrives already cleared; only an unchanged size needs zeroing.
        if !targets.resize(gl, width, height)? {
            targets.clear(gl);
        }

        Ok(())
    }

    /// Gives up on accumulation for the rest of the session, loudly.
    fn disable_accumulation(&mut self, reason: &str) {
        if let Some(targets) = self.accumulation.take() {
            targets.delete(&self.gl);
        }

        self.accumulation_status = format!(
            "off: {}. The LuxCore renderer falls back to averaging luxSamples samples in \
             a single draw, so raise that slider to reduce its noise.",
            reason
        );

        web_sys::console::warn_1(&JsValue::from_str(&format!(
            "gem renderer: progressive accumulation is {}",
            self.accumulation_status
        )));
    }

    /// Draws to the canvas rather than to an accumulation target.
    ///
    /// The framebuffer binding is reset here rather than assumed: the accumulate pass
    /// leaves one bound, and a resolve drawn into it would be invisible.
    fn draw_to_canvas(
        &self,
        width: u32,
        height: u32,
        effective: &RenderParams,
        pass: i32,
        seed: u32,
        pass_count: u32,
    ) {
        self.gl.bind_framebuffer(Gl::FRAMEBUFFER, None);
        self.draw_trace(width, height, effective, pass, seed, pass_count);
    }

    /// Traces the stone into whichever framebuffer is bound, one full-screen triangle.
    ///
    /// `pass` selects what the shader does with the result: trace and tone map
    /// (`LUX_PASS_DIRECT`), trace and add to the sum (`LUX_PASS_ACCUMULATE`), or present
    /// the sum without tracing at all (`LUX_PASS_RESOLVE`). See `lux/host.glsl`.
    fn draw_trace(
        &self,
        width: u32,
        height: u32,
        effective: &RenderParams,
        pass: i32,
        seed: u32,
        pass_count: u32,
    ) {
        let gl = &self.gl;

        gl.viewport(0, 0, width as i32, height as i32);
        gl.use_program(Some(&self.program));
        gl.bind_vertex_array(Some(&self.vertex_array));

        gl.active_texture(Gl::TEXTURE0 + UNIT_TRIANGLES);
        gl.bind_texture(Gl::TEXTURE_2D, Some(&self.model.triangle_texture));
        gl.active_texture(Gl::TEXTURE0 + UNIT_NODES);
        gl.bind_texture(Gl::TEXTURE_2D, Some(&self.model.node_texture));
        gl.active_texture(Gl::TEXTURE0 + UNIT_ENVIRONMENT);
        gl.bind_texture(Gl::TEXTURE_2D, Some(&self.environment_texture));
        gl.active_texture(Gl::TEXTURE0 + UNIT_HIGHLIGHT);
        gl.bind_texture(Gl::TEXTURE_2D, Some(&self.highlight_texture));

        // Bound on every draw, not only on an accumulating one: an unbound unit behind a
        // live sampler uniform is the kind of thing a driver is entitled to complain
        // about, and the texture exists whenever the targets do.
        gl.active_texture(Gl::TEXTURE0 + UNIT_ACCUMULATION);
        gl.bind_texture(
            Gl::TEXTURE_2D,
            self.accumulation.as_ref().map(|targets| targets.read_texture()),
        );

        self.set_uniforms(width, height, effective, pass, seed, pass_count);

        gl.draw_arrays(Gl::TRIANGLES, 0, 3);

        gl.bind_vertex_array(None);
    }

    /// Sets the canvas's backing store to this size, if it is not already. Resizing clears the
    /// canvas, so call it only just before drawing the image it is to show.
    fn resize_canvas(&self, width: u32, height: u32) {
        if self.canvas.width() != width {
            self.canvas.set_width(width);
        }

        if self.canvas.height() != height {
            self.canvas.set_height(height);
        }
    }

    fn set_uniforms(
        &self,
        width: u32,
        height: u32,
        effective: &RenderParams,
        pass: i32,
        seed: u32,
        pass_count: u32,
    ) {
        let aspect = width as f32 / height as f32;
        let basis = self.camera.basis(aspect);

        self.uniform3f(
            "uCameraOrigin",
            basis.origin.x,
            basis.origin.y,
            basis.origin.z,
        );
        self.uniform3f(
            "uCameraRight",
            basis.right.x,
            basis.right.y,
            basis.right.z,
        );
        self.uniform3f("uCameraUp", basis.up.x, basis.up.y, basis.up.z);
        self.uniform3f(
            "uCameraForward",
            basis.forward.x,
            basis.forward.y,
            basis.forward.z,
        );
        self.uniform1f("uTanHalfFov", basis.tan_half_fov);
        self.uniform1f("uAspect", basis.aspect);
        self.uniform1f("uOrthographicHalfHeight", basis.orthographic_half_height);

        self.uniform1i("uTriangles", UNIT_TRIANGLES as i32);
        self.uniform1i("uNodes", UNIT_NODES as i32);
        self.uniform1i("uEnvironment", UNIT_ENVIRONMENT as i32);
        // The data texture width is a compile-time constant in the shader, not a
        // uniform, so that the index unwrapping reduces to a mask and a shift. See
        // accel::DATA_TEXTURE_WIDTH.
        self.uniform1i("uNodeCount", self.model.node_count as i32);

        self.uniform1f("uEnvIntensity", effective.env_intensity);
        self.uniform1f("uEnvRotation", effective.env_rotation);

        // Sent as a cosine so the shader's per-lookup test is a compare rather than an
        // acos. Disabled is encoded as 2.0, which no unit dot product can reach, so the
        // shader needs no separate enable flag. cos(0) is 1.0, which a direction pointing
        // exactly at the zenith would satisfy, so zero must be special-cased rather than
        // passed through as its cosine.
        let head_shadow_cosine = if effective.head_shadow_half_angle > 0.0 {
            effective.head_shadow_half_angle.cos()
        } else {
            2.0
        };

        self.uniform1f("uHeadShadowCosine", head_shadow_cosine);
        self.uniform3f(
            "uHeadShadowColor",
            effective.head_shadow_color.x,
            effective.head_shadow_color.y,
            effective.head_shadow_color.z,
        );

        self.uniform1f("uObserverRadius", effective.observer_radius);

        self.uniform1i(
            "uUseBackgroundColor",
            if effective.use_background_color { 1 } else { 0 },
        );
        self.uniform3f(
            "uBackgroundColor",
            effective.background_color.x,
            effective.background_color.y,
            effective.background_color.z,
        );

        self.uniform1i(
            "uUseWindowColor",
            if effective.use_window_color { 1 } else { 0 },
        );
        self.uniform3f(
            "uWindowColor",
            effective.window_color.x,
            effective.window_color.y,
            effective.window_color.z,
        );
        self.uniform1i(
            "uLightingFollowsView",
            if effective.lighting_follows_view { 1 } else { 0 },
        );
        self.uniform1f("uExhaustionShade", effective.exhaustion_shade);

        let spectral = effective.spectral_indices();
        let absorption = effective.effective_absorption();

        self.uniform3f("uSpectralIor", spectral.x, spectral.y, spectral.z);
        self.uniform3f(
            "uAbsorption",
            absorption.x,
            absorption.y,
            absorption.z,
        );
        self.uniform1i("uMaxBounces", effective.max_bounces as i32);
        self.uniform1i("uSpectralSamples", effective.spectral_samples as i32);
        self.uniform1f("uExposure", effective.exposure);
        self.uniform1i("uDebugMode", effective.debug_mode.as_u32() as i32);
        self.uniform1i("uWireframe", if effective.wireframe { 1 } else { 0 });
        self.uniform1f(
            "uWireframePixelScale",
            wireframe_pixel_scale(height, self.canvas.client_height()),
        );
        self.uniform1i("uHighlightTexture", UNIT_HIGHLIGHT as i32);
        self.uniform1i("uToneMapMode", effective.tone_map_mode.as_u32() as i32);
        self.uniform1i("uLightingModel", effective.lighting_model.as_u32() as i32);

        self.set_lux_uniforms(effective, width, height, pass, seed, pass_count);
    }

    /// The uniforms only the ported LuxCore path reads (T-0120).
    ///
    /// All of them are set on every frame regardless of which renderer is selected. They
    /// cost a handful of `uniform*` calls, and the alternative -- setting them only when
    /// the toggle is on -- is exactly the shape of bug `kb/browser-harness.md`'s fifth
    /// load-bearing detail describes: a uniform the renderer never sets stays zero, and
    /// silently.
    fn set_lux_uniforms(
        &self,
        effective: &RenderParams,
        width: u32,
        height: u32,
        pass: i32,
        seed: u32,
        pass_count: u32,
    ) {
        self.uniform1i("uRenderer", effective.renderer.as_u32() as i32);
        self.uniform1i("uLuxSamples", effective.lux_samples as i32);

        // The seed is the pass's, not the parameter's: `render` passes
        // `lux_seed + passIndex` so each pass draws an independent stream, and the
        // parameter itself on a direct or resolve draw. The cast is a reinterpretation,
        // not a conversion -- `uLuxSeed` is an `int` because GLSL ES 3.00 has no unsigned
        // uniform setter in WebGL's `uniform1i`, and entry.glsl casts it straight back to
        // `uint` before hashing it.
        self.uniform1i("uLuxSeed", seed as i32);

        // What this draw is for; see `LUX_PASS_DIRECT` and lux/host.glsl.
        self.uniform1i("uLuxPass", pass);
        self.uniform1i("uLuxPassCount", pass_count.max(1) as i32);
        self.uniform1i("uLuxAccum", UNIT_ACCUMULATION as i32);

        // The ported sampler jitters within the pixel, so it needs the film size to turn
        // `pixelX + rnd` back into normalised device coordinates. This is the same size the
        // canvas backing store was just set to, not the CSS size.
        self.uniform2f("uResolution", width as f32, height as f32);

        // LuxCore's interiorior is Cauchy's A, not an index of refraction; see
        // `params::cauchy_from_gemmological_constants` and
        // `kb/luxcore-as-a-reference-oracle.md`.
        let (cauchy_a, cauchy_b) = effective.cauchy_coefficients();

        self.uniform1f("uLuxCauchyA", cauchy_a);
        self.uniform1f("uLuxCauchyB", cauchy_b);

        // Which environment the ported path lights the stone with (T-0127): this project's
        // own, through `gem.frag`'s `sampleEnvironment`, or LuxCore's native
        // `constantinfinite` sky plus suns. See `params::LuxEnvironment`.
        self.uniform1i(
            "uLuxEnvironment",
            effective.lux_environment.as_u32() as i32,
        );

        // `scene.lights.sky.color = 1 1 1` in both oracle scenes; its gain is
        // `uEnvIntensity`, which the ported lights read directly (see lux/host.glsl).
        self.uniform3f("uLuxSkyColor", 1.0, 1.0, 1.0);

        self.uniform1i("uLuxSunCount", effective.lux_sun_count() as i32);
        self.uniform1f("uLuxSunRelSize", params::lux_sun_relsize());

        for index in 0..params::LUX_STUDIO_SUNS_DEGREES.len() {
            let direction = params::lux_sun_direction(index);

            self.uniform3f(
                &format!("{}[{}]", SUN_DIRECTION_UNIFORM, index),
                direction.x,
                direction.y,
                direction.z,
            );
        }

        // The oracle's horizon occluder, `tools/luxcore_oracle.py`'s `--horizon-y` and
        // `--horizon-radius` defaults. See `lux/host.glsl` for why the ported path needs it
        // and why it is applied where it is.
        self.uniform1f("uLuxHorizonY", LUX_HORIZON_Y);
        self.uniform1f("uLuxHorizonRadius", LUX_HORIZON_RADIUS);

        // `path.russianroulette.cap`, LuxCore's own default. Inert while every material is
        // delta-specular glass; see `kb/luxcore-path-integrator-port-dead-russian-roulet.md`.
        self.uniform1f("uLuxRrImportanceCap", LUX_RR_IMPORTANCE_CAP);
    }

    /// Generates the environment for a lighting model, uploads it, and makes it current.
    fn upload_environment(&mut self, model: LightingModel) -> Result<(), JsValue> {
        let environment = generate_environment(model, self.environment_image.as_ref())
            .map_err(|e| js_error(&e))?;
        let texture = gpu::create_environment_texture(
            &self.gl,
            environment.width,
            environment.height,
            &environment.texels,
        )
        .map_err(|e| js_error(&e))?;

        // Only release the old texture once the new one exists, so a failed upload
        // leaves the previous environment in place rather than an unlit stone.
        self.gl.delete_texture(Some(&self.environment_texture));

        self.environment_texture = texture;
        self.environment_generation += 1;
        self.render_params.lighting_model = model;

        // The display transfer follows the model. An analytical environment read through
        // the filmic curve stops reporting the quantity it exists to report, and an image
        // read through it stops looking like the image, so this is not left to the caller
        // to remember.
        self.render_params.tone_map_mode = model.tone_map_mode();

        Ok(())
    }

    fn uniform1f(&self, name: &str, value: f32) {
        if let Some(location) = self.uniforms.get(name) {
            self.gl.uniform1f(Some(location), value);
        }
    }

    fn uniform1i(&self, name: &str, value: i32) {
        if let Some(location) = self.uniforms.get(name) {
            self.gl.uniform1i(Some(location), value);
        }
    }

    fn uniform2f(&self, name: &str, x: f32, y: f32) {
        if let Some(location) = self.uniforms.get(name) {
            self.gl.uniform2f(Some(location), x, y);
        }
    }

    fn uniform3f(&self, name: &str, x: f32, y: f32, z: f32) {
        if let Some(location) = self.uniforms.get(name) {
            self.gl.uniform3f(Some(location), x, y, z);
        }
    }

    fn release_model_textures(&self) {
        self.gl
            .delete_texture(Some(&self.model.triangle_texture));
        self.gl.delete_texture(Some(&self.model.node_texture));
    }
}

/// Releases the GL objects when the app is dropped.
///
/// Only strictly necessary if a page ever creates more than one `GemApp`, or
/// recreates one after a context loss, but leaking driver objects is the kind of
/// thing that is invisible until it is a problem, and the fix is four lines.
impl Drop for GemApp {
    fn drop(&mut self) {
        self.release_model_textures();
        self.gl.delete_texture(Some(&self.environment_texture));
        self.gl.delete_texture(Some(&self.highlight_texture));

        if let Some(targets) = self.accumulation.as_ref() {
            targets.delete(&self.gl);
        }

        self.gl.delete_vertex_array(Some(&self.vertex_array));
        self.gl.delete_program(Some(&self.program));
    }
}

/// Builds the environment texture data for a lighting model.
///
/// One place that maps the enum onto a generator, so `new` and `set_lighting_model`
/// cannot disagree about what a given model looks like.
///
/// Fails only for the Image model when no image has been supplied yet.
fn generate_environment(
    model: LightingModel,
    image: Option<&env_map::CubeCross>,
) -> Result<env_map::EnvironmentMap, String> {
    let map = match model {
        LightingModel::Image => {
            let cross = image.ok_or_else(|| {
                "no environment image has been loaded yet; supply one with \
                 set_environment_image first"
                    .to_string()
            })?;

            // Resampled into the same equirectangular texture the studio rig uses, so the
            // shader needs no second lookup path. At 1024 x 512 (0.35 degrees a texel) the
            // texture is finer than the embedded skybox, whose 512 x 384 cross has 128-pixel
            // faces (0.7 degrees a pixel), so nothing is lost.
            env_map::generate_with(ENVIRONMENT_WIDTH, ENVIRONMENT_HEIGHT, |direction| {
                cross.radiance(direction)
            })
        }
        LightingModel::Studio => {
            env_map::generate_studio(ENVIRONMENT_WIDTH, ENVIRONMENT_HEIGHT)
        }
        LightingModel::AngleRings => env_map::generate_with(
            ENVIRONMENT_WIDTH,
            ENVIRONMENT_HEIGHT,
            env_map::angle_rings_radiance,
        ),
        LightingModel::Isometric => env_map::generate_with(
            ENVIRONMENT_WIDTH,
            ENVIRONMENT_HEIGHT,
            env_map::isometric_radiance,
        ),
        LightingModel::Cosine => env_map::generate_with(
            ENVIRONMENT_WIDTH,
            ENVIRONMENT_HEIGHT,
            env_map::cosine_radiance,
        ),
    };

    Ok(map)
}

/// Parses an OBJ and conditions it into the stone the renderer traces: welded, wound outward,
/// grouped into facets, centred and scaled to radius 1, with its optical axis turned onto +Y.
///
/// Public so the host-side integration tests in `tests/` build exactly the stone the page
/// uploads. Returns the mesh, its diagnostics and the OBJ's object names.
pub fn conditioned_mesh(
    obj_text: &str,
    model_axis: ModelAxis,
) -> Result<(Mesh, MeshDiagnostics, Vec<String>), String> {
    conditioned_mesh_in_frame(obj_text, model_axis)
        .map(|(mesh, diagnostics, object_names, _)| (mesh, diagnostics, object_names))
}

/// `conditioned_mesh`, also returning where the file's own coordinates went: the `FileFrame`
/// that takes a point of the OBJ onto the stone the renderer traces.
pub fn conditioned_mesh_in_frame(
    obj_text: &str,
    model_axis: ModelAxis,
) -> Result<(Mesh, MeshDiagnostics, Vec<String>, FileFrame), String> {
    let geometry = loader::load_obj_text(obj_text)?;

    let (mut mesh, diagnostics) =
        Mesh::build(&geometry.positions, &geometry.triangles, WELD_EPSILON_SCALE);

    // Normalise first, then rotate. Rotation is about the origin, so centring
    // survives it.
    let (center, scale) = mesh.center_and_scale(1.0);
    mesh.reorient_axis_to_y(model_axis);

    let frame = FileFrame {
        center,
        scale,
        rotation: mesh::axis_to_y_rotation(model_axis),
    };

    Ok((mesh, diagnostics, geometry.object_names, frame))
}

/// How a point in the model FILE's own coordinates (a design's frame: optical axis +Z, the
/// file's units) lands in the renderer's world: centred, scaled to the unit stone, then turned
/// so the optical axis is +Y -- exactly what `conditioned_mesh` does to the mesh.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FileFrame {
    pub center: Vector3<f32>,
    pub scale: f32,
    pub rotation: nalgebra::Rotation3<f32>,
}

impl FileFrame {
    pub fn to_world(&self, point: nalgebra::Point3<f32>) -> nalgebra::Point3<f32> {
        self.rotation * nalgebra::Point3::from((point.coords - self.center) * self.scale)
    }
}

/// Smallest hit distance for the pick ray: `SURFACE_EPSILON` in `gem.frag`, the primary ray's
/// own bound, so a click finds exactly the triangle that pixel shows.
const PICK_T_MIN: f32 = 1e-4;

/// What a click on the stone found: the facet under the pointer, and the pose facing it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FacetPick {
    /// Spin and tilt, in radians, that look squarely at the facet.
    pub spin: f32,
    pub tilt: f32,
    /// The facet's id, as the triangle texture and `uHighlightTexture` carry it.
    pub facet: u32,
}

/// The facet under a point in normalised device coordinates and the pose facing it, or `None`
/// when that point misses the stone.
///
/// Traces the primary ray exactly as `gem.frag` does (`ray_start` and `ray_direction` mirror
/// its set-up, and `Accel::trace` its `traceScene`), so the facet chosen is the one drawn at
/// that pixel, then asks the camera for the pose facing that triangle's outward normal. Every
/// triangle of a facet is coplanar, so any of them gives the facet's normal.
pub fn facet_pose_at(
    accel: &Accel,
    camera: &OrbitCamera,
    aspect: f32,
    ndc_x: f32,
    ndc_y: f32,
) -> Option<FacetPick> {
    if !ndc_x.is_finite() || !ndc_y.is_finite() {
        return None;
    }

    let basis = camera.basis(aspect);
    let hit = accel.trace(
        basis.ray_start(ndc_x, ndc_y),
        basis.ray_direction(ndc_x, ndc_y),
        PICK_T_MIN,
        f32::MAX,
        accel::RaySide::Outside,
    )?;

    let (spin, tilt) = camera.orientation_facing(hit.outward_normal)?;

    Some(FacetPick {
        spin,
        tilt,
        facet: accel.shapes[hit.triangle].facet,
    })
}

/// Runs the whole load pipeline and uploads the result.
///
/// Free function rather than a method so it can be used before `GemApp` exists, in
/// the constructor, as well as for later reloads.
fn build_model(
    gl: &Gl,
    obj_text: &str,
    model_axis: ModelAxis,
) -> Result<(ModelResources, String), String> {
    let (mesh, diagnostics, object_names, file_frame) = conditioned_mesh_in_frame(obj_text, model_axis)?;

    // In the file's own frame (optical axis +Z), not the world frame `conditioned_mesh` just
    // turned the mesh into -- see the doc comment on `ModelResources::facet_normals`.
    let facet_normals = mesh.facet_normals_in_file_frame(model_axis);

    let accel = Accel::build(&mesh)?;
    let packed = accel.to_gpu();

    let triangle_texture = gpu::create_data_texture(
        gl,
        packed.texture_width,
        packed.triangle_texture_height,
        &packed.triangle_texels,
    )?;

    let node_texture = match gpu::create_data_texture(
        gl,
        packed.texture_width,
        packed.node_texture_height,
        &packed.node_texels,
    ) {
        Ok(texture) => texture,
        Err(error) => {
            // The triangle texture already exists and nothing else holds it, so it would
            // leak on every failed load.
            gl.delete_texture(Some(&triangle_texture));

            return Err(error);
        }
    };

    let model_name = if object_names.is_empty() {
        "(unnamed)".to_string()
    } else {
        object_names.join(", ")
    };

    let resources = ModelResources {
        triangle_texture,
        node_texture,
        texture_width: packed.texture_width,
        node_count: packed.node_count as u32,
        triangle_count: packed.triangle_count as u32,
        diagnostics,
        accel,
        facet_normals,
        file_frame,
    };

    Ok((resources, model_name))
}

/// Builds the small per-facet data texture `uHighlightTexture` reads: one texel per facet id,
/// red channel 1.0 for a facet in `highlighted` and 0.0 otherwise.
///
/// `facet_count` is always the CURRENT model's own facet count, never a fixed cap -- a design
/// tier can have any number of facets (T-0160), and a uniform array's size is baked into the
/// shader at compile time, which is exactly the kind of cap that silently drops facets on a
/// large tier. `create_data_texture` needs at least a 1x1 allocation, so a model with (somehow)
/// no facets still gets a valid, harmless texture nothing will ever index into.
///
/// `RGBA32F`, like every other data texture here, even though only the red channel is read:
/// `gpu::create_data_texture` only has that one format, and a bespoke single-channel path for
/// a texture this small is not worth its own upload function.
fn build_highlight_texture(
    gl: &Gl,
    facet_count: u32,
    highlighted: &std::collections::BTreeSet<u32>,
) -> Result<WebGlTexture, String> {
    let width = facet_count.max(1);
    let mut data = vec![0.0f32; width as usize * 4];

    for &facet in highlighted {
        if facet < width {
            data[facet as usize * 4] = 1.0;
        }
    }

    gpu::create_data_texture(gl, width, 1, &data)
}

/// Backing-store pixels per CSS pixel, from the frame's height and the canvas element's CSS
/// height, for the wireframe line width (`uWireframePixelScale` in `gem.frag`).
///
/// The page renders at `clientHeight * devicePixelRatio * scale`, where the scale drops to the
/// dragging resolution while the stone moves, so this ratio is what keeps a line the same size
/// on screen at every resolution. An element with no layout (height 0, as in a detached or
/// hidden canvas) has no CSS size to be relative to, so it falls back to 1.
fn wireframe_pixel_scale(backing_height: u32, css_height: i32) -> f32 {
    if css_height > 0 {
        backing_height as f32 / css_height as f32
    } else {
        1.0
    }
}

fn js_error(message: &str) -> JsValue {
    JsValue::from_str(message)
}

#[cfg(test)]
mod tests {
    use crate::params;

    /// Every file `FRAGMENT_SHADER` concatenates, in that order, with its path.
    ///
    /// The path is carried alongside the text purely so a failing assertion can name the
    /// file rather than a line number in a 2,600-line concatenation. Kept next to the tests
    /// that consume it, and pinned against `FRAGMENT_SHADER` itself by
    /// `shader_source_files_are_concatenated_in_the_documented_order` below, so a file
    /// added to the shader but forgotten here fails loudly instead of quietly escaping the
    /// contract tests.
    const SHADER_SOURCE_FILES: &[(&str, &str)] = &[
        ("src/renderer/shaders/gem.frag", include_str!("shaders/gem.frag")),
        (
            "src/renderer/shaders/lux/prelude.glsl",
            include_str!("shaders/lux/prelude.glsl"),
        ),
        (
            "src/renderer/shaders/lux/host.glsl",
            include_str!("shaders/lux/host.glsl"),
        ),
        (
            "src/renderer/shaders/lux/math.glsl",
            include_str!("shaders/lux/math.glsl"),
        ),
        (
            "src/renderer/shaders/lux/glass.glsl",
            include_str!("shaders/lux/glass.glsl"),
        ),
        (
            "src/renderer/shaders/lux/volume.glsl",
            include_str!("shaders/lux/volume.glsl"),
        ),
        (
            "src/renderer/shaders/lux/sampler.glsl",
            include_str!("shaders/lux/sampler.glsl"),
        ),
        (
            "src/renderer/shaders/lux/pathtracer.glsl",
            include_str!("shaders/lux/pathtracer.glsl"),
        ),
        (
            "src/renderer/shaders/lux/lights.glsl",
            include_str!("shaders/lux/lights.glsl"),
        ),
        (
            "src/renderer/shaders/lux/entry.glsl",
            include_str!("shaders/lux/entry.glsl"),
        ),
    ];

    /// The one file with a given path from `SHADER_SOURCE_FILES`, for tests that check a
    /// property of a specific file rather than of the whole unit.
    fn shader_file(path: &str) -> &'static str {
        SHADER_SOURCE_FILES
            .iter()
            .find(|(name, _)| *name == path)
            .map(|(_, source)| *source)
            .unwrap_or_else(|| panic!("{} is not one of the concatenated shader files", path))
    }

    /// The shader's file list must be exactly what `FRAGMENT_SHADER` compiles, in the same
    /// order.
    ///
    /// Setup: the per-file sources listed above, joined. Test: compare against
    /// `FRAGMENT_SHADER`. Verifies two things at once. First, that the contract tests below
    /// really cover every file the browser compiles -- a new `lux/*.glsl` added to
    /// `FRAGMENT_SHADER` but not to this list would otherwise be exempt from the uniform and
    /// `refract` checks without anything saying so, which is the exact failure mode T-0120's
    /// brief called out. Second, that the *order* has not changed: the concatenation is
    /// deliberately not order-independent (each ported file carries `#ifndef`-guarded
    /// stand-ins for helpers an earlier file defines for real), so reordering it is a real
    /// change and should have to be made in two places on purpose.
    #[test]
    fn shader_source_files_are_concatenated_in_the_documented_order() {
        let joined: String = SHADER_SOURCE_FILES
            .iter()
            .map(|(_, source)| *source)
            .collect();

        assert_eq!(
            joined,
            super::FRAGMENT_SHADER,
            "the shader file list in this test module no longer matches FRAGMENT_SHADER"
        );
    }

    /// Names declared as `uniform <type> <name>;` anywhere in the concatenated shader.
    ///
    /// The trailing `[...]` of an array declaration is stripped, because that is how the
    /// uniform is named in this file: `gpu::collect_uniforms` and `uniform3f` address array
    /// elements as `name[i]`, built with `format!` from the bare name.
    fn shader_uniforms() -> Vec<String> {
        SHADER_SOURCE_FILES
            .iter()
            .flat_map(|(_, source)| source.lines())
            .map(str::trim)
            .filter(|line| line.starts_with("uniform "))
            .filter_map(|line| line.trim_end_matches(';').split_whitespace().last())
            .map(|name| name.split('[').next().unwrap_or(name).to_string())
            .collect()
    }

    /// Every quoted string in this file that looks like a uniform name: `u` then a capital.
    fn uniforms_named_in_rust() -> Vec<String> {
        include_str!("lib.rs")
            .split('"')
            .skip(1)
            .step_by(2)
            .filter(|text| {
                let mut characters = text.chars();

                characters.next() == Some('u')
                    && characters.next().map_or(false, |c| c.is_ascii_uppercase())
                    && text.chars().all(|c| c.is_ascii_alphanumeric())
            })
            .map(str::to_string)
            .collect()
    }

    /// The shader and the renderer must agree on the uniforms, in both directions.
    ///
    /// Setup: the uniform declarations parsed from every file the fragment shader is
    /// assembled from, and the uniform names quoted in this file. Verifies that every
    /// declared uniform is set by name somewhere here, and
    /// that every name set here is declared. Neither failure is loud at runtime: a uniform
    /// the renderer never sets silently stays zero, and setting an undeclared name is
    /// skipped, because `uniform1f` and friends ignore names the driver did not report. So
    /// adding a control and forgetting either half would show up only as a feature that
    /// does nothing.
    ///
    /// This replaces the check the missing `tests/shaders.rs` used to make.
    #[test]
    fn every_shader_uniform_is_set_and_every_set_uniform_is_declared() {
        let declared = shader_uniforms();
        let named = uniforms_named_in_rust();

        assert!(declared.len() > 20, "parsed suspiciously few uniforms: {:?}", declared);

        for uniform in &declared {
            assert!(
                named.contains(uniform),
                "the shader declares {} but lib.rs never sets it",
                uniform
            );
        }

        for uniform in &named {
            assert!(
                declared.contains(uniform),
                "lib.rs sets {} but no shader file declares it",
                uniform
            );
        }
    }

    /// Line numbers (1-based) of every call to GLSL's built-in `refract` in shader source.
    ///
    /// `//` comments are removed first, line by line so the numbering survives, because the
    /// shader's own prose explains why the built-in is avoided and names it. A match must be
    /// the whole identifier `refract` followed, after any spaces, by `(`: that excludes
    /// `refractRay(`, and anything like `myrefract(` whose name merely ends in it.
    fn builtin_refract_call_lines(source: &str) -> Vec<usize> {
        let code: String = source
            .lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");

        code.match_indices("refract")
            .filter(|(start, word)| {
                let before = code[..*start].chars().next_back();
                let after = code[start + word.len()..].trim_start().chars().next();
                let is_whole_word =
                    before.map_or(true, |c| !(c.is_ascii_alphanumeric() || c == '_'));

                is_whole_word && after == Some('(')
            })
            .map(|(start, _)| code[..start].matches('\n').count() + 1)
            .collect()
    }

    /// The call detector below must find a real call and ignore the look-alikes, or the shader
    /// test could pass simply because the detector never matches anything.
    ///
    /// Setup: a synthetic shader with a genuine built-in call on line 2, and on other lines a
    /// `refractRay` call, a function whose name ends in `refract`, and a comment naming the
    /// built-in with parentheses. Test: run the detector. Verifies it reports exactly line 2,
    /// and that a space before the parenthesis still counts as a call.
    #[test]
    fn builtin_refract_detector_finds_calls_and_ignores_look_alikes() {
        let sample = "vec3 a = refractRay(d, n, eta, t);\n\
                      vec3 b = refract(d, n, eta);\n\
                      vec3 c = myrefract(d, n, eta);\n\
                      // never call refract(d, n, eta) here\n";

        assert_eq!(builtin_refract_call_lines(sample), vec![2]);
        assert_eq!(builtin_refract_call_lines("x = refract (d, n, eta);"), vec![1]);
    }

    /// The shader must refract with its own `refractRay`, never GLSL's built-in `refract`.
    ///
    /// The built-in reports total internal reflection by returning a zero vector. That is
    /// indistinguishable from a real direction at the call site, and only surfaces as NaNs
    /// several bounces later, as black or speckled pixels far from the cause. `refractRay`
    /// returns a bool instead, and the interior march relies on it (and on its agreement with
    /// `fresnelReflectance`) to tell refraction from total internal reflection.
    ///
    /// Setup: the text of `gem.frag`. Test: look for built-in calls with the detector above,
    /// and count the uses of `refractRay`. Verifies there are no built-in calls, and that
    /// `refractRay` is still defined and called at both places refraction happens (entering
    /// the stone and leaving it), so the test cannot pass merely because refraction was
    /// deleted.
    ///
    /// This replaces the check the missing `tests/shaders.rs` used to make.
    ///
    /// Checked over **every** file the fragment shader is assembled from, not just
    /// `gem.frag`: the ported LuxCore files do their own refraction
    /// (`GlassMaterial_EvalSpecularTransmission`), and the failure mode the built-in
    /// produces -- a zero vector that only surfaces as NaNs several bounces later -- is
    /// exactly as invisible there as it is here.
    #[test]
    fn shader_uses_its_own_refraction_rather_than_the_builtin() {
        for (path, source) in SHADER_SOURCE_FILES {
            let builtin_calls = builtin_refract_call_lines(source);

            assert!(
                builtin_calls.is_empty(),
                "{} calls the built-in refract on line(s) {:?}; refract reports total \
                 internal reflection as a zero vector, which is indistinguishable from a \
                 real direction at the call site",
                path,
                builtin_calls
            );
        }

        let own_uses = shader_file("src/renderer/shaders/gem.frag")
            .matches("refractRay(")
            .count();

        assert!(
            own_uses >= 3,
            "expected refractRay to be defined and called at entry and exit, found {} uses",
            own_uses
        );
    }

    /// The `Renderer` encoding the page and `set_renderer` use must be the one the shader
    /// branches on.
    ///
    /// Setup: the `RENDERER_*` constants declared in `lux/host.glsl`, read from its text.
    /// Test: compare each against `params::Renderer::as_u32`. Verifies the runtime toggle
    /// actually selects the renderer it claims to. Nothing at runtime would say otherwise:
    /// `uRenderer` is an int, every value is legal, and picking the wrong one just renders
    /// the other tracer -- which, since the two are meant to converge on the same image, is
    /// the kind of wrong that survives a glance at the screen.
    #[test]
    fn renderer_encoding_matches_the_shader_constants() {
        let host = shader_file("src/renderer/shaders/lux/host.glsl");

        for (name, renderer) in [
            ("RENDERER_DETERMINISTIC", params::Renderer::Deterministic),
            ("RENDERER_LUXCORE", params::Renderer::LuxCore),
            ("RENDERER_FLAT", params::Renderer::Flat),
        ] {
            let declaration = format!("const int {} = {};", name, renderer.as_u32());

            assert!(
                host.contains(&declaration),
                "lux/host.glsl should declare `{}` but does not; params::Renderer::{:?} \
                 encodes as {}",
                declaration,
                renderer,
                renderer.as_u32()
            );
        }
    }

    /// The ported lights' environment-source encoding must be the one `params` sends
    /// (T-0127).
    ///
    /// Setup: `src/shaders/lux/lights.glsl`'s text, and both `params::LuxEnvironment`
    /// variants.
    ///
    /// Test: the file must `#define` `LUX_ENVIRONMENT_PROJECT` and
    /// `LUX_ENVIRONMENT_LUXCORE` to exactly the integers `as_u32` produces, and
    /// `src/shaders/lux/host.glsl` must wire the selector to the `uLuxEnvironment` uniform
    /// `set_lux_uniforms` sets.
    ///
    /// Verifies the one thing that cannot fail loudly on its own. These are preprocessor
    /// integers compared against an `int` uniform: every value is legal GLSL, so swapping
    /// the two numbers compiles, links and renders -- it just renders the *other*
    /// environment. The comparison harness would go on scoring the port against the oracle
    /// while the shader lit the stone with the page's lighting model, or the page would show
    /// LuxCore's uniform sky whatever model was picked, and nothing anywhere would say so.
    #[test]
    fn lux_environment_encoding_matches_the_ported_lights_shader() {
        let lights = shader_file("src/renderer/shaders/lux/lights.glsl");

        for (name, environment) in [
            ("LUX_ENVIRONMENT_PROJECT", params::LuxEnvironment::Project),
            (
                "LUX_ENVIRONMENT_LUXCORE",
                params::LuxEnvironment::LuxCoreNative,
            ),
        ] {
            let definition = format!("#define {} {}", name, environment.as_u32());

            assert!(
                lights.contains(&definition),
                "lux/lights.glsl should define `{}` but does not; \
                 params::LuxEnvironment::{:?} encodes as {}",
                definition,
                environment,
                environment.as_u32()
            );
        }

        let host = shader_file("src/renderer/shaders/lux/host.glsl");

        assert!(
            host.contains("#define LUX_ENVIRONMENT_SOURCE uLuxEnvironment"),
            "lux/host.glsl must point lights.glsl's LUX_ENVIRONMENT_SOURCE at the \
             uLuxEnvironment uniform, or the shader keeps that file's standalone default \
             (LuxCore's own lights) and the page's lighting model is discarded again"
        );
    }

    /// The ported path must hand `gem.frag`'s environment the direction light **travels**.
    ///
    /// Setup: `src/shaders/lux/lights.glsl`'s text, sliced from `Env_GetRadiance`'s
    /// signature to the end of its project-environment branch.
    ///
    /// Test: that branch must call `Env_ProjectRadiance(-direction)`, negated.
    ///
    /// Verifies the single sign that the two renderers' environments hinge on, and which
    /// nothing else in this codebase can catch. The two conventions genuinely differ:
    /// `Env_GetRadiance` is called as `Env_GetRadiance(-rayDirection, ...)`, LuxCore's own
    /// `envLight.GetRadiance(scene, bsdf, -ray.d, ...)`, so its parameter points from the
    /// environment back at the stone; every `gem.frag` entry point instead takes the
    /// direction the light travels (`arrivingLight(position, exitDirection, normal)`,
    /// `sampleEnvironment(toLightingFrame(direction))`). Dropping the negation compiles,
    /// renders and looks like a gemstone -- it simply mirrors the environment through the
    /// origin, so the skybox is upside down and back to front and every assessment model
    /// reads its own antipode (Angle Rings' red zenith band would light the facets that
    /// should see nothing at all, below the horizon). A textual test is the only kind
    /// available here: no test in this project compiles or runs GLSL.
    #[test]
    fn the_ported_path_samples_the_project_environment_along_the_direction_light_travels() {
        let lights = shader_file("src/renderer/shaders/lux/lights.glsl");

        let body = lights
            .split("vec3 Env_GetRadiance(vec3 direction, out float directPdfW) {")
            .nth(1)
            .and_then(|rest| rest.split("\n    vec3 radiance = BLACK;").next())
            .expect("lux/lights.glsl should still define Env_GetRadiance with a project branch");

        assert!(
            body.contains("Env_ProjectRadiance(-direction)"),
            "Env_GetRadiance's project-environment branch must negate `direction` before \
             handing it to gem.frag's environment, which takes the direction light travels; \
             `Env_ProjectRadiance(direction)` would mirror the whole environment through the \
             origin. Branch body was:\n{}",
            body
        );
    }

    /// The ported path must show the separate window colour only to light that met the
    /// stone -- never to a camera ray that missed everything.                     T-0137
    ///
    /// Setup: the text of the four files that together carry that one fact --
    /// `lux/host.glsl` (which declares the shader global `gLuxPathHitStone`),
    /// `lux/pathtracer.glsl` (whose `LUX_HAS_GEM_FRAG` bridge arm, this project's own glue
    /// into `gem.frag`'s `traceScene`, sets it), `lux/entry.glsl` (which clears it at the
    /// start of every eye path) and `lux/lights.glsl` (whose `Env_ProjectRadiance` reads
    /// it).
    ///
    /// Test: each of those four pieces is present, and in `Env_ProjectRadiance` the
    /// `!gLuxPathHitStone` branch comes *before* the first mention of `uUseWindowColor`,
    /// i.e. a camera miss returns before the leak cascade can be reached.
    ///
    /// Verifies the bug T-0137 was: `gem.frag` has two different rules for "what light
    /// comes from that direction" -- `renderHandWritten`'s primary-miss branch (flat
    /// background, then the environment, and never the window colour) and `arrivingLight`'s
    /// leak cascade (window colour first) -- and the ported path reaches the environment
    /// through one seam that both kinds of ray arrive at. Applying the cascade to
    /// everything, which is what it did before, painted **every** background pixel with the
    /// window colour, because a camera ray always reads as below the lighting horizon (+Y
    /// of the lighting frame points back at the viewer). Any of the four pieces going
    /// missing brings that back: it is one connected fact spread over four files, which is
    /// exactly the kind of thing that rots silently. The pixels themselves are checked by
    /// `tools/test_luxcore_window_background.py`, which needs a browser and a GPU and so
    /// cannot live here; this is the part that can run in `cargo test`.
    #[test]
    fn the_ported_path_shows_the_window_colour_only_to_light_that_met_the_stone() {
        let host = shader_file("src/renderer/shaders/lux/host.glsl");
        let pathtracer = shader_file("src/renderer/shaders/lux/pathtracer.glsl");
        let entry = shader_file("src/renderer/shaders/lux/entry.glsl");
        let lights = shader_file("src/renderer/shaders/lux/lights.glsl");

        assert!(
            host.contains("bool gLuxPathHitStone = false;"),
            "lux/host.glsl must declare `bool gLuxPathHitStone = false;`, the per-path \
             state that tells a camera miss from light leaving the stone"
        );

        let bridge = pathtracer
            .split("#ifdef LUX_HAS_GEM_FRAG")
            .nth(1)
            .and_then(|rest| rest.split("#else").next())
            .expect("pathtracer.glsl's LUX_HAS_GEM_FRAG block should have an #else arm");

        assert!(
            bridge.contains("gLuxPathHitStone = gLuxPathHitStone || (struck && !occluded);"),
            "Scene_Intersect's wired-in arm must record a real stone hit in \
             gLuxPathHitStone; without it every lookup looks like a camera miss and the \
             window colour is never shown at all. Found:\n{}",
            bridge
        );

        assert!(
            entry.contains("gLuxPathHitStone = false;"),
            "lux/entry.glsl's sample loop must clear gLuxPathHitStone before each eye \
             path, or one sample's stone hit leaks into the next sample's camera miss"
        );

        let project_branch = lights
            .split("vec3 Env_ProjectRadiance(vec3 travelDirection) {")
            .nth(1)
            .and_then(|rest| rest.split("\n#else").next())
            .expect("lux/lights.glsl should still define Env_ProjectRadiance");

        let miss_branch = project_branch.find("if (!gLuxPathHitStone) {").expect(
            "Env_ProjectRadiance must take gem.frag's primary-miss branch for a ray that \
             never met the stone, or the whole background shows the window colour",
        );
        let window_clause = project_branch
            .find("uUseWindowColor")
            .expect("Env_ProjectRadiance should still honour the separate window colour");

        assert!(
            miss_branch < window_clause,
            "Env_ProjectRadiance must return the camera-miss colour BEFORE reaching the \
             window-colour clause; as written the leak cascade is evaluated first. \
             Branch body was:\n{}",
            project_branch
        );
    }

    /// The offsets `glsl_function_signatures` reports must be true byte offsets into the
    /// source whatever line ending that source uses.
    ///
    /// Setup: one tiny two-function GLSL source written twice, identical but for its line
    /// terminators -- once with Unix "\n" and once with Windows "\r\n". Test: for each,
    /// take the signature list and hand the *second* function's reported offset to
    /// `glsl_function_body`, which is exactly the pair of steps `gem_frag_functions` takes.
    /// Verifies that what comes back is `second`'s body in both cases, rather than a slice
    /// that has slid back into `first`.
    ///
    /// This is the shape of the bug it guards. The scanner used to walk `lines()` and
    /// advance by `line.len() + 1`, which is one byte short per line on CRLF, so on a
    /// Windows checkout -- where this repository's `core.autocrlf=true` rewrites every
    /// source file to CRLF -- each offset pointed further and further back into the file
    /// and `glsl_function_body` returned an earlier function's text. `flat_ignored_uniforms`
    /// and `lux_ignored_uniforms` read those mis-attributed bodies and reported the wrong
    /// uniforms, so `the_flat_renderer_hides_the_optics_bounces_and_window_colour` and
    /// `lux_ignored_uniforms_matches_the_known_gcs_only_uniforms` failed on Windows while
    /// passing on macOS. The shaders themselves are checked in with "\n", so nothing in the
    /// suite would have noticed.
    #[test]
    fn function_offsets_survive_windows_line_endings() {
        const UNIX: &str = "float first(float x) {\n    return x;\n}\n\nfloat second(float y) {\n    return y + 1.0;\n}\n";
        const WINDOWS: &str =
            "float first(float x) {\r\n    return x;\r\n}\r\n\r\nfloat second(float y) {\r\n    return y + 1.0;\r\n}\r\n";

        for (ending, source) in [("unix", UNIX), ("windows", WINDOWS)] {
            let signatures = super::glsl_function_signatures(source);
            let names: Vec<&str> = signatures.iter().map(|(name, _)| *name).collect();

            assert_eq!(
                names,
                vec!["first", "second"],
                "{} line endings: both functions should be found",
                ending
            );

            let (_, second_offset) = signatures[1];
            let body = super::glsl_function_body(source, second_offset);

            assert!(
                body.starts_with("float second"),
                "{} line endings: the body at the reported offset should be second's, was:\n{}",
                ending,
                body
            );
            assert!(
                body.contains("y + 1.0") && !body.contains("return x;"),
                "{} line endings: second's body should be whole and should not reach back \
                 into first's, was:\n{}",
                ending,
                body
            );
        }
    }

    /// `lux_ignored_uniforms` -- the computed set the page's control visibility is built
    /// from -- must still be exactly the uniforms `gem.frag` declares that no ported file
    /// reads.
    ///
    /// Setup: none; calls the production function directly, over the real shader sources
    /// `include_str!` embedded. Test: compare the sorted result against a literal list
    /// pinned from T-0126's own analysis (independently checked by reading every
    /// `src/shaders/lux/*.glsl` file for each name before writing this test). Verifies the
    /// "derive, don't hand-maintain" contract T-0126 asked for: if a uniform is added to
    /// `gem.frag`, or a `lux/*.glsl` file starts (or stops) reading one of these, this test
    /// fails immediately instead of the page's hidden-controls list quietly going stale.
    #[test]
    fn lux_ignored_uniforms_matches_the_known_gcs_only_uniforms() {
        let mut got = super::lux_ignored_uniforms();
        got.sort_unstable();

        let mut expected = vec![
            // "uAbsorption" was here until T-0123. lux/volume.glsl ports LuxCore's
            // homogeneous interior volume and lux/host.glsl defines LUX_VOLUME_SIGMA_A as
            // uAbsorption, so the ported path reads it now and it is no longer ignored.
            //
            // The nine environment uniforms that were here until T-0127 -- uLightingModel,
            // uEnvRotation, uHeadShadowCosine, uHeadShadowColor, uLightingFollowsView,
            // uUseBackgroundColor, uBackgroundColor, uUseWindowColor and uWindowColor -- are
            // gone for the same kind of reason: lux/lights.glsl's Env_ProjectRadiance reads
            // the last four directly and reaches the rest through gem.frag's own
            // toLightingFrame / sampleEnvironment, so the ported path now lights the stone
            // with whatever lighting model the page shows. That is why nothing hides the
            // Lighting fieldset any more; see hidden_controls_for_hides_nothing_now_that_
            // both_renderers_light_the_stone_the_same_way below.
            //
            // What is left is exactly the five things the ported path genuinely does not do:
            //
            // The out-of-bounces shade. A path that exhausts its bounce budget is filled
            // with a darker tint of the gem colour by gem.frag; the ported integrator simply
            // stops, contributing nothing.
            "uExhaustionShade",
            // The Gem Cut Studio centre dot. blockedByObserver needs the exit *position* as
            // well as the direction, and the ported path's one environment seam,
            // Env_GetRadiance(direction, out directPdfW), carries only a direction (T-0127;
            // tracked as T-0134, together with the back-facet half of the leak rule, which
            // needs the exit facet's outward normal for the same reason).
            "uObserverRadius",
            // The deterministic path's three fixed wavelengths. The ported glass draws one
            // random wavelength per transmission from Cauchy's A and B instead
            // (uLuxCauchyA / uLuxCauchyB), which is what LuxCore does.
            "uSpectralIor",
            "uSpectralSamples",
            // The facet wireframe, drawn by renderHandWritten over its finished pixel, and its
            // line-width scale. The ported path has no single primary hit to outline.
            "uWireframe",
            "uWireframePixelScale",
            // The selected facets' tint, also drawn by renderHandWritten over its finished
            // pixel, for the same reason. "uHighlightFacet" until T-0160 replaced the single
            // clicked facet with a whole design tier's worth and moved this from a scalar
            // uniform to a per-facet texture; still no page control, so nothing is hidden
            // for it.
            "uHighlightTexture",
        ];
        expected.sort_unstable();

        assert_eq!(
            got, expected,
            "gem.frag's uniforms that no lux/*.glsl file reads changed; update \
             CONTROL_UNIFORMS and the page's hidden-controls handling to match, then update \
             this list to match what is now true"
        );
    }

    /// Every uniform name `CONTROL_UNIFORMS` mentions must be a uniform the shader actually
    /// declares.
    ///
    /// Setup: `shader_uniforms()`, the same declaration scan `every_shader_uniform_is_set_
    /// and_every_set_uniform_is_declared` uses. Test: every name in every
    /// `CONTROL_UNIFORMS` entry must appear in it. Guards against a typo or a renamed
    /// uniform silently making `hidden_controls_for` treat a control as always applicable
    /// (an unmatched name can never be "ignored by lux", so it would never contribute to
    /// hiding anything, and nothing at runtime would say why).
    #[test]
    fn every_control_uniform_is_a_uniform_the_shader_actually_declares() {
        let declared = shader_uniforms();

        for (control, uniforms) in super::CONTROL_UNIFORMS {
            for uniform in *uniforms {
                assert!(
                    declared.iter().any(|d| d == uniform),
                    "control {:?} lists uniform {:?}, which no shader file declares",
                    control,
                    uniform
                );
            }
        }
    }

    /// The deterministic renderer hides nothing, and LuxCore hides only the facet wireframe.
    ///
    /// This replaces `hidden_controls_for_hides_nothing_now_that_both_renderers_light_the_
    /// stone_the_same_way`, which itself replaced T-0126's Lighting-fieldset test once T-0127
    /// made the ported path read every lighting uniform. The Lighting fieldset must still stay
    /// visible under both renderers; what changed is that the wireframe checkbox arrived, and
    /// only `renderHandWritten` draws the wireframe.
    ///
    /// Setup: none. Test: `hidden_controls_for` for both `params::Renderer` variants.
    ///
    /// Verifies the list the page reads (`GemApp::hidden_controls`): nothing for the
    /// deterministic renderer, and exactly `wireframe-row` for LuxCore. The assertion is on
    /// `hidden_controls_for` rather than on `lux_ignored_uniforms`, because what matters to a
    /// person using the page is that no control they can see does nothing, and no control
    /// they need has vanished. A control that becomes inert under one renderer makes this fail,
    /// and the honest fix is to list it in `CONTROL_UNIFORMS`, not to delete this assertion.
    #[test]
    fn only_the_wireframe_control_is_hidden_and_only_under_luxcore() {
        assert_eq!(
            super::hidden_controls_for(params::Renderer::Deterministic),
            Vec::<&str>::new(),
            "the deterministic renderer reads every uniform CONTROL_UNIFORMS lists"
        );
        assert_eq!(
            super::hidden_controls_for(params::Renderer::LuxCore),
            vec!["wireframe-row"],
            "under LuxCore only the wireframe checkbox does nothing; the Lighting fieldset \
             still works through Env_ProjectRadiance"
        );
    }

    /// The flat renderer hides every control it ignores, and keeps the ones it uses.
    ///
    /// Setup: none. Test: `hidden_controls_for(Flat)`, computed by scanning `renderFlat` and
    /// what it calls.
    ///
    /// Verifies the scan's answer is the renderer's real behaviour, in both directions:
    /// - hidden: the refractive index, dispersion, bounce limit and window colour, none of
    ///   which a flat surface uses;
    /// - kept: the Lighting fieldset (its background colour and lighting model are what a
    ///   miss shows), the facet wireframe (drawn over the flat surface, the point of it), and
    ///   the head shadow's half-angle and colour, because a miss without the flat background
    ///   shows the environment through `sampleEnvironment`, which applies the head shadow.
    ///
    /// If `renderFlat` starts or stops reading one of these, this fails and the list here
    /// should change with it: the scan is the truth, this pins today's answer.
    #[test]
    fn the_flat_renderer_hides_the_optics_bounces_and_window_colour() {
        let hidden = super::hidden_controls_for(params::Renderer::Flat);

        assert_eq!(
            hidden,
            vec![
                "refractiveIndex-row",
                "dispersion-row",
                "maxBounces-row",
                "windowColor-row",
            ],
            "the controls the flat surface ignores"
        );
        assert!(
            !hidden.contains(&"headShadowHalfAngle-row") && !hidden.contains(&"headShadowColor-row"),
            "the environment behind the stone applies the head shadow"
        );
        assert!(!hidden.contains(&"fieldset-lighting"), "the background still shows under Flat");
        assert!(!hidden.contains(&"wireframe-row"), "Flat draws the wireframe");
    }

    /// The wireframe's line width must stay the same on screen whatever the backing-store
    /// resolution.
    ///
    /// Setup: a canvas 600 CSS pixels tall, rendered at full resolution on a devicePixelRatio 2
    /// display (1200 backing pixels) and at the page's default 40% dragging resolution (480),
    /// plus a canvas with no layout. Test: `wireframe_pixel_scale` for each, times the shader's
    /// half-width in CSS pixels, read from `gem.frag`.
    ///
    /// Verifies the fix for lines that were 2.5x thicker while dragging than at rest: the
    /// half-width in backing pixels scales with the resolution, so it is the same 0.5 CSS pixels
    /// in both frames. The layout-less canvas must fall back to 1 rather than divide by zero,
    /// which would send an infinite width to the shader and paint the whole stone black.
    #[test]
    fn wireframe_width_is_constant_in_css_pixels_across_resolutions() {
        let gem = shader_file("src/renderer/shaders/gem.frag");
        let half_width_css: f32 = gem
            .split("const float WIREFRAME_HALF_WIDTH_CSS_PIXELS = ")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .and_then(|value| value.trim().parse().ok())
            .expect("gem.frag must declare WIREFRAME_HALF_WIDTH_CSS_PIXELS");

        let at_rest = half_width_css * super::wireframe_pixel_scale(1200, 600);
        let dragging = half_width_css * super::wireframe_pixel_scale(480, 600);

        assert_eq!(at_rest, 2.0 * half_width_css, "full resolution at DPR 2 is 2 backing px per CSS px");
        assert_eq!(dragging, 0.8 * half_width_css, "40% of DPR 2 is 0.8 backing px per CSS px");
        assert_eq!(
            at_rest / 1200.0,
            dragging / 480.0,
            "as a fraction of the frame, the line must be the same width at both resolutions"
        );
        assert_eq!(super::wireframe_pixel_scale(480, 0), 1.0, "no CSS size falls back to 1");
    }

    /// The shader must read the wireframe mask from the texel the packer writes it to, and
    /// test the same bits `Mesh::facet_boundary_masks` sets.
    ///
    /// Setup: the text of `gem.frag`. Test: look for the six bit constants written from the
    /// mask layout (bit 0-2 edges a->b, b->c, c->a; bit 3-5 corners a, b, c), and for
    /// `wireframeCoverage` fetching texel 1 of the triangle's three.
    ///
    /// Verifies the one contract between `accel::Accel::to_gpu` and the shader that no host
    /// test runs: a wrong texel or a shifted bit compiles and draws, it just outlines the
    /// triangulation instead of the facets, or nothing at all.
    #[test]
    fn shader_wireframe_mask_layout_matches_the_packer() {
        let gem = shader_file("src/renderer/shaders/gem.frag");

        for (name, bit) in [
            ("WIREFRAME_EDGE_AB", 0),
            ("WIREFRAME_EDGE_BC", 1),
            ("WIREFRAME_EDGE_CA", 2),
            ("WIREFRAME_CORNER_A", 3),
            ("WIREFRAME_CORNER_B", 4),
            ("WIREFRAME_CORNER_C", 5),
        ] {
            let declaration = format!("const int {} = {};", name, 1 << bit);

            assert!(gem.contains(&declaration), "gem.frag must declare `{}`", declaration);
        }

        assert!(
            gem.contains("fetchTexel(uTriangles, triangleIndex * 3 + 1).w"),
            "wireframeCoverage must read the mask from texel 1's w, where Accel::to_gpu packs it"
        );
    }

    /// Both renderers must apply absorption, and neither may hide its control.
    ///
    /// This is the inversion of T-0126's `absorption_is_ignored_by_lux_but_never_a_hidden_
    /// control`, which T-0123 replaced (that test said, in its own failure message, to remove
    /// it if T-0123 landed). What changed: `src/shaders/lux/volume.glsl` ports LuxCore's
    /// `homogeneous` volume and `lux/host.glsl` feeds `uAbsorption` into it, so the ported
    /// path attenuates each interior segment exactly as `gem.frag`'s `traceInterior` does.
    ///
    /// Setup: none; calls the two production functions directly over the real shader
    /// sources. Test: `uAbsorption` is NOT among `lux_ignored_uniforms`, and no
    /// `CONTROL_UNIFORMS` entry mentions it. Verifies the two things that could silently
    /// undo this ticket. If the first assertion fails, the ported path has stopped reading
    /// `uAbsorption` -- the most likely cause being `lux/host.glsl` losing its
    /// `LUX_VOLUME_SIGMA_A` define, which would leave `volume.glsl`'s own inert `BLACK`
    /// standalone default in place and make every coloured stone colourless again with
    /// nothing at runtime to say why. The second keeps the control visible for both
    /// renderers now that both honour it; a `CONTROL_UNIFORMS` entry would hide it under
    /// LuxCore for a difference that no longer exists.
    #[test]
    fn absorption_is_applied_by_both_renderers() {
        assert!(
            !super::lux_ignored_uniforms().contains(&"uAbsorption"),
            "the ported path no longer reads uAbsorption. lux/host.glsl must define \
             LUX_VOLUME_SIGMA_A as uAbsorption, or lux/volume.glsl silently keeps its inert \
             standalone BLACK and applies no absorption at all (T-0123)"
        );

        assert!(
            super::CONTROL_UNIFORMS
                .iter()
                .all(|(_, uniforms)| !uniforms.contains(&"uAbsorption")),
            "uAbsorption must not be wired into CONTROL_UNIFORMS: since T-0123 both \
             renderers apply absorption, so there is nothing for either of them to hide"
        );
    }

    /// `lux/volume.glsl`'s host integration points must all be supplied by `lux/host.glsl`.
    ///
    /// Setup: the text of `lux/host.glsl` and `lux/volume.glsl`. Test: each
    /// `LUX_VOLUME_*` macro is guarded in volume.glsl and defined in host.glsl. Verifies the
    /// same silent-failure contract `host_shader_supplies_the_light_integration_points_
    /// except_the_one_it_must_not` guards for the lights, and it matters more here because
    /// volume.glsl's standalone defaults are deliberately *inert*: a missing
    /// `LUX_VOLUME_SIGMA_A` leaves absorption at `BLACK` and the renderer draws a
    /// perfectly plausible colourless stone, with no error and nothing on screen to say the
    /// wiring came apart. The guard half is checked too, because a `#define` in host.glsl
    /// with no matching `#ifndef` in volume.glsl is a macro-redefinition error rather than
    /// a working integration point.
    #[test]
    fn volume_glsl_integration_points_are_supplied_by_host_glsl() {
        let host = shader_file("src/renderer/shaders/lux/host.glsl");
        let volume = shader_file("src/renderer/shaders/lux/volume.glsl");

        for macro_name in [
            "LUX_VOLUME_SIGMA_A",
            "LUX_VOLUME_SIGMA_S",
            "LUX_VOLUME_EMISSION",
            "LUX_VOLUME_MULTISCATTERING",
        ] {
            assert!(
                volume.contains(&format!("#ifndef {}", macro_name)),
                "lux/volume.glsl no longer guards {}; host.glsl's define may now collide",
                macro_name
            );
            assert!(
                host.contains(&format!("#define {}", macro_name)),
                "lux/host.glsl must define {} or lux/volume.glsl silently keeps its inert \
                 standalone default and the ported path applies no absorption",
                macro_name
            );
        }

        assert!(
            host.contains("#define LUX_VOLUME_SIGMA_A uAbsorption"),
            "lux/host.glsl must feed gem.frag's existing uAbsorption uniform to the ported \
             volume, so the two renderers cannot be given different absorptions"
        );
    }

    /// The `uLuxPass` encoding this file sends must be the one the shader branches on.
    ///
    /// Setup: the `LUX_PASS_*` constants declared in `lux/host.glsl`, read from its text.
    /// Test: compare each against this file's own constant of the same name. Verifies the
    /// three-way contract behind progressive accumulation (T-0122), which has no loud
    /// failure mode at all: `uLuxPass` is an int, every value is legal, and each wrong
    /// pairing is quietly wrong in its own way. Swapping ACCUMULATE and RESOLVE would
    /// present an untone-mapped sum on the canvas and write tone-mapped colour into the
    /// float buffer; either of them colliding with DIRECT would leave the ported path
    /// drawing a single noisy sample per frame with the accumulation machinery running
    /// underneath it and no effect on screen.
    #[test]
    fn lux_pass_encoding_matches_the_shader_constants() {
        let host = shader_file("src/renderer/shaders/lux/host.glsl");

        for (name, value) in [
            ("LUX_PASS_DIRECT", super::LUX_PASS_DIRECT),
            ("LUX_PASS_ACCUMULATE", super::LUX_PASS_ACCUMULATE),
            ("LUX_PASS_RESOLVE", super::LUX_PASS_RESOLVE),
        ] {
            let declaration = format!("const int {} = {};", name, value);

            assert!(
                host.contains(&declaration),
                "lux/host.glsl should declare `{}` but does not; src/lib.rs sends {} for \
                 that pass",
                declaration,
                value
            );
        }
    }

    /// The accumulate pass must write linear radiance, and only the resolve pass may tone
    /// map.
    ///
    /// Setup: `lux/entry.glsl`'s `main()`, sliced at its pass branches. Test: that the
    /// resolve branch divides by `uLuxPassCount` and tone maps, and that the accumulate
    /// branch does neither but does add the previous sum. Verifies the one property of
    /// this design that cannot be seen by looking at a converged image: tone mapping is
    /// not linear, so averaging tone-mapped passes does not converge to the tone-mapped
    /// average. The error is largest exactly on the specular flashes a gem is judged by,
    /// and a single-pass image -- the only one anyone looks at while developing -- is
    /// identical either way.
    #[test]
    fn the_accumulate_pass_writes_linear_radiance_and_the_resolve_pass_tone_maps() {
        let entry = shader_file("src/renderer/shaders/lux/entry.glsl");

        let resolve = entry
            .split("if (uLuxPass == LUX_PASS_RESOLVE) {")
            .nth(1)
            .and_then(|rest| rest.split('}').next())
            .expect("entry.glsl should still branch on LUX_PASS_RESOLVE in main()");

        assert!(
            resolve.contains("tonemap(") && resolve.contains("uLuxPassCount"),
            "the resolve pass must divide the sum by uLuxPassCount and tone map it; \
             found:\n{}",
            resolve
        );

        let accumulate = entry
            .split("if (uLuxPass == LUX_PASS_ACCUMULATE) {")
            .nth(1)
            .and_then(|rest| rest.split('}').next())
            .expect("entry.glsl should still branch on LUX_PASS_ACCUMULATE in main()");

        assert!(
            accumulate.contains("luxAccumulated() + radiance"),
            "the accumulate pass must add this pass's radiance to the running sum; \
             found:\n{}",
            accumulate
        );
        assert!(
            !accumulate.contains("tonemap"),
            "the accumulate pass must write LINEAR radiance: tone mapping is not linear, \
             so an average of tone-mapped passes is not the tone-mapped average. \
             Found:\n{}",
            accumulate
        );
    }

    /// `Scene_Intersect` must be wired to the real BVH, not left as the port's stub.
    ///
    /// Setup: the text of `gem.frag` and `lux/pathtracer.glsl`. Test: check that `gem.frag`
    /// defines `LUX_HAS_GEM_FRAG`, that `pathtracer.glsl` branches on it, and that the arm
    /// it guards calls `traceScene`. Verifies the one thing that makes the ported path
    /// render anything at all. The stub returns `false` for every ray, so if the guard were
    /// ever to stop matching -- a rename on either side, or the files concatenated in the
    /// wrong order -- the LuxCore renderer would compile and link cleanly and draw an empty
    /// frame, with no error anywhere to explain it.
    #[test]
    fn scene_intersect_calls_the_projects_own_bvh_traversal() {
        let gem = shader_file("src/renderer/shaders/gem.frag");
        let pathtracer = shader_file("src/renderer/shaders/lux/pathtracer.glsl");

        assert!(
            gem.contains("#define LUX_HAS_GEM_FRAG"),
            "gem.frag must define LUX_HAS_GEM_FRAG; it is what selects pathtracer.glsl's \
             real Scene_Intersect over its standalone stub"
        );
        assert!(
            pathtracer.contains("#ifdef LUX_HAS_GEM_FRAG"),
            "pathtracer.glsl no longer branches on LUX_HAS_GEM_FRAG"
        );

        let guarded = pathtracer
            .split("#ifdef LUX_HAS_GEM_FRAG")
            .nth(1)
            .and_then(|rest| rest.split("#else").next())
            .expect("pathtracer.glsl's LUX_HAS_GEM_FRAG block should have an #else arm");

        assert!(
            guarded.contains("traceScene(origin, direction, tMin, tMax, side,"),
            "Scene_Intersect's wired-in arm should call gem.frag's traceScene; found:\n{}",
            guarded
        );
    }

    /// The ported lights must get every host value their file header asks for, and must NOT
    /// get the one that is somebody else's ticket.
    ///
    /// Setup: the text of `lux/host.glsl`, which fills in the `#ifndef`-guarded HOST
    /// INTEGRATION POINT macros `lux/lights.glsl` leaves open. Test: check each macro is
    /// defined there, and that `LUX_ENV_SUN_COLOR` is not. Verifies both halves of a
    /// contract that fails silently in either direction: a macro left undefined quietly
    /// keeps lights.glsl's placeholder constant (the sky would ignore `uEnvIntensity`
    /// entirely, which looks like an exposure bug), and defining `LUX_ENV_SUN_COLOR` here
    /// would replace T-0119's deliberately-inert `vec3(1.0)` -- the placeholder whose whole
    /// point is that a render with it looks obviously wrong rather than plausibly wrong --
    /// with a guessed value, hiding that open ticket instead of closing it.
    #[test]
    fn host_shader_supplies_the_light_integration_points_except_the_one_it_must_not() {
        let host = shader_file("src/renderer/shaders/lux/host.glsl");
        let lights = shader_file("src/renderer/shaders/lux/lights.glsl");

        for macro_name in [
            "LUX_SKY_COLOR",
            "LUX_SKY_GAIN",
            "LUX_ENV_MAX_SUNS",
            "LUX_ENV_SUN_COUNT",
            "LUX_ENV_SUN_RELSIZE",
            "LUX_ENV_SUN_DIR",
        ] {
            assert!(
                lights.contains(&format!("#ifndef {}", macro_name)),
                "lux/lights.glsl no longer guards {}; host.glsl's define may now collide",
                macro_name
            );
            assert!(
                host.contains(&format!("#define {}", macro_name)),
                "lux/host.glsl must define {} or lux/lights.glsl silently keeps its \
                 placeholder",
                macro_name
            );
        }

        assert!(
            !host.contains("#define LUX_ENV_SUN_COLOR"),
            "lux/host.glsl must not define LUX_ENV_SUN_COLOR: the real value is \
             SunLight::Preprocess's atmospheric integral and is T-0119's ticket. \
             lights.glsl's inert vec3(1.0) placeholder stays until that lands."
        );
    }

    /// The five studio suns the host uploads must be the five the ported lights file was
    /// written and hand-verified against.
    ///
    /// Setup: `params::lux_sun_direction` for each sun, and the `LUX_ENV_SUN_DIR` array
    /// literal parsed out of `lux/lights.glsl`. Test: compare component by component.
    /// Verifies that the two independent transcriptions of `tools/luxcore_oracle.py`'s rig
    /// -- one as (polar, azimuth) degrees in Rust, one as unit vectors in GLSL -- still
    /// agree. They can drift without any symptom a test would otherwise catch, because
    /// `host.glsl` `#define`s the GLSL array out of existence in the real build: the
    /// shader's own copy becomes dead text that nothing compiles, and it is also the
    /// documentation for what the uniform is supposed to contain.
    #[test]
    fn lux_sun_directions_match_the_ported_lights_shader() {
        let lights = shader_file("src/renderer/shaders/lux/lights.glsl");

        // The array literal sits between `vec3[LUX_ENV_MAX_SUNS](` and the closing `);`.
        let body = lights
            .split("const vec3 LUX_ENV_SUN_DIR[LUX_ENV_MAX_SUNS] = vec3[LUX_ENV_MAX_SUNS](")
            .nth(1)
            .and_then(|rest| rest.split(");").next())
            .expect("lux/lights.glsl should still declare its LUX_ENV_SUN_DIR array");

        let declared: Vec<Vec<f32>> = body
            .split("vec3(")
            .skip(1)
            .map(|entry| {
                entry
                    .split(')')
                    .next()
                    .unwrap_or("")
                    .split(',')
                    .map(|component| {
                        component
                            .trim()
                            .parse::<f32>()
                            .expect("a vec3 component should parse as a float")
                    })
                    .collect()
            })
            .collect();

        assert_eq!(
            declared.len(),
            params::LUX_STUDIO_SUNS_DEGREES.len(),
            "lux/lights.glsl lists {} sun directions, params.rs has {}",
            declared.len(),
            params::LUX_STUDIO_SUNS_DEGREES.len()
        );

        for (index, components) in declared.iter().enumerate() {
            let computed = params::lux_sun_direction(index);

            for (axis, declared_component) in components.iter().enumerate() {
                assert!(
                    (computed[axis] - declared_component).abs() < 1e-6,
                    "sun {} component {}: params.rs computes {}, lux/lights.glsl declares {}",
                    index,
                    axis,
                    computed[axis],
                    declared_component
                );
            }
        }
    }

    /// Clicking a point of the stone turns the view squarely onto the facet drawn there.
    ///
    /// Setup: the built-in hex cut, conditioned as the page loads it, seen from the default
    /// pose (Gem Cut Studio's perspective, face-up) and from a tilted, spun one, in a
    /// landscape viewport. Test: pick at a grid of points over the image with
    /// `facet_pose_at`; for each point that hits, trace the same ray again to learn which
    /// triangle it struck, then move the camera to the returned pose. Verifies:
    /// - the new view looks straight down that triangle's outward normal, so the clicked
    ///   facet faces the viewer;
    /// - the facet id returned, which the page highlights, is that triangle's facet;
    /// - the centre of the face-up view (the table) keeps the pose face-up;
    /// - a corner of the image, which misses the stone, gives no pose, so a click on the
    ///   background leaves the view alone;
    /// - both poses hit the stone at many points, so the check is not vacuous.
    #[test]
    fn file_frame_takes_the_files_own_points_onto_the_traced_stone() {
        // Setup: `resources/hex_cut_v2.obj` (optical axis +Z, the page's default axis) conditioned
        // as the page conditions it, with the frame it reports, and the same file's raw vertex
        // positions read straight from the OBJ.
        // Test: take every raw vertex through `FileFrame::to_world` and look for the nearest
        // vertex of the conditioned mesh.
        // Verifies: each lands on a mesh vertex to within 1e-5 world units, so the page's
        // edit-mode overlay, drawn from a design's own coordinates through
        // `project_file_points`, sits exactly on the stone the shader draws. Also that the frame
        // is not the identity (the file is off-centre and not radius 1), so the check has teeth.
        let text = include_str!("../resources/hex_cut_v2.obj");
        let (mesh, _, _, frame) = crate::conditioned_mesh_in_frame(text, crate::mesh::ModelAxis::PlusZ)
            .expect("the hex cut must load");
        let raw = crate::loader::load_obj_text(text).expect("the hex cut must parse");

        assert!((frame.scale - 1.0).abs() > 1e-3, "setup: the file must need scaling");

        for position in &raw.positions {
            let world = frame.to_world(*position);
            let nearest = mesh
                .positions
                .iter()
                .map(|vertex| (vertex - world).norm())
                .fold(f32::INFINITY, f32::min);

            assert!(nearest < 1e-5, "file point {:?} lands {} from the stone", position, nearest);
        }
    }

    #[test]
    fn facet_pose_at_faces_the_facet_under_the_pointer() {
        let (mesh, _, _) = crate::conditioned_mesh(
            include_str!("../resources/hex_cut_v2.obj"),
            crate::ModelAxis::PlusZ,
        )
        .expect("the built-in stone must load");
        let accel = crate::Accel::build(&mesh).expect("the built-in stone's BVH must build");
        let aspect = 1.5;

        let tilted = crate::OrbitCamera { spin: 0.7, tilt: 0.9, ..Default::default() };

        for start in [crate::OrbitCamera::default(), tilted] {
            let basis = start.basis(aspect);
            let mut hits = 0;

            for row in 0..21 {
                for column in 0..21 {
                    let ndc_x = -1.0 + column as f32 * 0.1;
                    let ndc_y = -1.0 + row as f32 * 0.1;

                    let Some(pick) = crate::facet_pose_at(&accel, &start, aspect, ndc_x, ndc_y)
                    else {
                        continue;
                    };

                    hits += 1;

                    // The same ray, traced again, to know which facet the click landed on.
                    let hit = accel
                        .trace(
                            basis.ray_start(ndc_x, ndc_y),
                            basis.ray_direction(ndc_x, ndc_y),
                            1e-4,
                            f32::MAX,
                            crate::accel::RaySide::Outside,
                        )
                        .expect("a point that gave a pose must hit the stone");

                    // The facet to highlight is the facet of the triangle drawn at that pixel.
                    assert_eq!(
                        pick.facet,
                        accel.shapes[hit.triangle].facet,
                        "click at ({}, {}) reported the wrong facet",
                        ndc_x,
                        ndc_y
                    );

                    let mut camera = start;
                    camera.set_orientation(pick.spin, pick.tilt);

                    let forward = camera.basis(aspect).forward;

                    assert!(
                        (forward + hit.outward_normal).norm() < 1e-4,
                        "click at ({}, {}): forward {:?} does not face normal {:?}",
                        ndc_x,
                        ndc_y,
                        forward,
                        hit.outward_normal
                    );
                }
            }

            assert!(hits > 50, "only {} of 441 points hit the stone", hits);
        }

        let face_up = crate::OrbitCamera::default();

        let table = crate::facet_pose_at(&accel, &face_up, aspect, 0.0, 0.0)
            .expect("the centre of the face-up view is the table");
        assert!(table.spin.abs() < 1e-6 && table.tilt.abs() < 1e-4, "table pose {:?}", table);

        assert_eq!(crate::facet_pose_at(&accel, &face_up, aspect, 1.0, 1.0), None);
    }
}
