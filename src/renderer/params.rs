//! Physical and rendering parameters for the stone.
//!
//! Gem appearance is driven by material physics rather than by artistic surface
//! properties, so these are real optical constants: refractive index, dispersion,
//! and absorption. There is no albedo or roughness, because a polished gem has
//! neither in any meaningful sense.

use nalgebra::Vector3;

/// How the renderer should display the stone. The debug modes exist because when
/// a fantasy cut renders wrongly, the useful question is almost always "is the
/// geometry right?" rather than "is the lighting right?", and the full physical
/// render is the worst possible view for answering that.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebugMode {
    /// Full spectral path trace through the stone.
    Full,
    /// Flat-shade each facet by its outward normal.
    Normals,
    /// Colour each facet distinctly, to verify facet grouping.
    FacetId,
    /// Heat map of BVH nodes visited, to spot pathological hierarchies.
    TraversalCost,
    /// Number of internal bounces before the ray left the stone.
    BounceCount,
}

impl DebugMode {
    /// Stable integer encoding for the shader uniform.
    pub fn as_u32(self) -> u32 {
        match self {
            DebugMode::Full => 0,
            DebugMode::Normals => 1,
            DebugMode::FacetId => 2,
            DebugMode::TraversalCost => 3,
            DebugMode::BounceCount => 4,
        }
    }

    pub fn from_u32(value: u32) -> DebugMode {
        match value {
            1 => DebugMode::Normals,
            2 => DebugMode::FacetId,
            3 => DebugMode::TraversalCost,
            4 => DebugMode::BounceCount,
            _ => DebugMode::Full,
        }
    }
}

/// How radiance is mapped to displayable colour.
///
/// Must match the `TONEMAP_*` constants in `gem.frag`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToneMapMode {
    /// Reinhard compression plus a gamma encode. For the studio rig, whose small sources
    /// peak in the hundreds and would otherwise clip every bright facet to flat white.
    Filmic,
    /// Straight clamp into 0..1. For the analytical models, which define unit radiance to
    /// *be* white and whose output is meant to be read as a measurement rather than
    /// looked at -- a compressive curve turns a fully returning facet grey and washes the
    /// Angle Rings hues out.
    Linear,
    /// Clamp into 0..1, then encode with `env_map::DISPLAY_GAMMA`. For image environments,
    /// which were decoded from display values with that gamma: this is the exact inverse, so
    /// the surroundings keep the brightness and colour they had in the image. The filmic
    /// curve would dim a white wall to 73% grey.
    Gamma,
}

impl ToneMapMode {
    pub fn as_u32(self) -> u32 {
        match self {
            ToneMapMode::Filmic => 0,
            ToneMapMode::Linear => 1,
            ToneMapMode::Gamma => 2,
        }
    }

    pub fn from_u32(value: u32) -> ToneMapMode {
        match value {
            1 => ToneMapMode::Linear,
            2 => ToneMapMode::Gamma,
            _ => ToneMapMode::Filmic,
        }
    }

    /// Maps one channel of radiance to a display value in 0..1. Mirrors `tonemap` in
    /// gem.frag, and exists so `decode` can be tested against it on the host.
    pub fn encode(self, radiance: f32, exposure: f32) -> f32 {
        let exposed = (radiance * exposure).max(0.0);

        match self {
            ToneMapMode::Linear => exposed.min(1.0),
            ToneMapMode::Gamma => exposed.min(1.0).powf(1.0 / DISPLAY_GAMMA),
            ToneMapMode::Filmic => (exposed / (1.0 + exposed)).powf(1.0 / DISPLAY_GAMMA),
        }
    }

    /// The radiance that displays as `display` (0..1) through this transfer. Mirrors
    /// `displayToRadiance` in gem.frag.
    ///
    /// Used for colours picked in the page, the head shadow and window colours, which have
    /// to mix with real light inside the stone but should still look like the colour that
    /// was picked. The filmic curve only approaches 1.0, so its inverse is capped at
    /// `FILMIC_DECODE_CEILING`; a pure white pick displays one part in two thousand dim.
    pub fn decode(self, display: f32, exposure: f32) -> f32 {
        let value = display.clamp(0.0, 1.0);

        let radiance = match self {
            ToneMapMode::Linear => value,
            ToneMapMode::Gamma => value.powf(DISPLAY_GAMMA),
            ToneMapMode::Filmic => {
                let compressed = value.powf(DISPLAY_GAMMA).min(FILMIC_DECODE_CEILING);

                compressed / (1.0 - compressed)
            }
        };

        radiance / exposure
    }
}

/// Largest filmic-compressed value `ToneMapMode::decode` inverts. Reinhard's inverse
/// diverges at 1.0. Must match `FILMIC_DECODE_CEILING` in gem.frag.
pub const FILMIC_DECODE_CEILING: f32 = 0.999;

use crate::env_map::DISPLAY_GAMMA;

/// Which lighting environment to place the stone in.
///
/// `Studio` is this renderer's own rig. The other three are the analytical assessment
/// environments Gem Cut Studio provides, reimplemented from its published descriptions and
/// measurements of GCS itself so renders can be compared against it; see the comment block above
/// `env_map::ANGLE_RING_RADII_TEXELS`. They are diagnostic rather than pretty: all
/// three are black below the horizon, which is what makes a stone look so different
/// under them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LightingModel {
    /// The procedural HDR studio rig: sky gradient plus six area lights.
    Studio,
    /// Four flat colour bands by angle of incidence, for reading where light comes from.
    AngleRings,
    /// Uniform over the upper hemisphere, for reading total light return.
    Isometric,
    /// Brightest about the vertical, for judging head-shadow vulnerability. Named for Gem Cut
    /// Studio's model, which falls off as `1 - sin(tilt)` rather than a cosine; see
    /// `env_map::cosine_radiance`.
    Cosine,
    /// A cube-map image supplied by the page, such as `src/resources/backrooms_skybox_cross.png`.
    /// See `env_map::CubeCross`.
    Image,
}

impl LightingModel {
    /// Stable integer encoding, used by the page and by `set_lighting_model`.
    pub fn as_u32(self) -> u32 {
        match self {
            LightingModel::Studio => 0,
            LightingModel::AngleRings => 1,
            LightingModel::Isometric => 2,
            LightingModel::Cosine => 3,
            LightingModel::Image => 4,
        }
    }

    pub fn from_u32(value: u32) -> LightingModel {
        match value {
            1 => LightingModel::AngleRings,
            2 => LightingModel::Isometric,
            3 => LightingModel::Cosine,
            4 => LightingModel::Image,
            _ => LightingModel::Studio,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            LightingModel::Studio => "Studio",
            LightingModel::AngleRings => "Angle rings",
            LightingModel::Isometric => "Isometric",
            LightingModel::Cosine => "Cosine",
            LightingModel::Image => "Skybox image",
        }
    }

    /// Every model, in encoding order, for building a menu.
    pub fn all() -> [LightingModel; 5] {
        [
            LightingModel::Studio,
            LightingModel::AngleRings,
            LightingModel::Isometric,
            LightingModel::Cosine,
            LightingModel::Image,
        ]
    }

    /// Whether this model is a diagnostic one whose colours carry meaning.
    ///
    /// Gem Cut Studio's manual notes that the gem's own colour multiplies the lighting
    /// model, and advises resetting the material to pure white for the analytical
    /// models -- otherwise a red ring seen through a green stone is neither red nor
    /// green and means nothing. Used to warn on the page rather than to force anything,
    /// since the user may deliberately want to see the interaction.
    pub fn is_analytical(self) -> bool {
        !matches!(self, LightingModel::Studio | LightingModel::Image)
    }

    /// The display transfer this model should be read through.
    ///
    /// Paired here rather than left to the caller because the pairing is not a matter of
    /// taste: an analytical model viewed through a compressive curve no longer reports the
    /// quantity it exists to report, and an image environment viewed through one no longer
    /// looks like its image.
    pub fn tone_map_mode(self) -> ToneMapMode {
        match self {
            LightingModel::Studio => ToneMapMode::Filmic,
            LightingModel::Image => ToneMapMode::Gamma,
            LightingModel::AngleRings | LightingModel::Isometric | LightingModel::Cosine => {
                ToneMapMode::Linear
            }
        }
    }
}

/// Which of the two path tracers in the shader renders the frame (T-0120).
///
/// The renderer is being replaced by a faithful port of LuxCore. Rather than swap the
/// shader outright, both live in one program and this selects between them at runtime, so
/// `tools/compare_render.sh` can score each against the LuxCore oracle and the eventual
/// swap is a measured decision. Flipping the default is a separate, deliberate step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Renderer {
    /// `gem.frag`'s own `renderHandWritten()`: the clean-room tracer this project was built
    /// on, with all of its Gem Cut Studio matching behaviour. Named for what actually sets
    /// it apart from the port -- it traces a small fixed set of wavelengths per pixel and
    /// is done in a single draw, rather than converging over many like a Monte Carlo
    /// estimator -- not for how it was written; the port is also hand-written.
    Deterministic,
    /// The ported LuxCore path integrator in `src/shaders/lux/`. A Monte Carlo estimator,
    /// so it needs `lux_samples` samples per pixel to converge, and it implements none of
    /// the Gem Cut Studio behaviours (no observer dot, head shadow, window colour or
    /// out-of-bounces shade). It does apply this material's Beer-Lambert `absorption`,
    /// through LuxCore's own `homogeneous` interior volume (T-0123,
    /// `src/shaders/lux/volume.glsl`), so a coloured preset renders with its body colour
    /// under either renderer. See `src/shaders/lux/entry.glsl`.
    LuxCore,
    /// No rendering at all (the user's request, 2026-09-18): `gem.frag`'s `renderFlat()`
    /// traces only the primary ray and shows the stone as an opaque surface in the stone
    /// colour, with the same background, facet highlight and wireframe as the deterministic
    /// renderer. Done in one draw, like the deterministic renderer, so it never accumulates.
    Flat,
}

impl Renderer {
    /// Stable integer encoding. Must match `RENDERER_DETERMINISTIC` / `RENDERER_LUXCORE` /
    /// `RENDERER_FLAT` in `src/shaders/lux/host.glsl`; a test enforces that.
    pub fn as_u32(self) -> u32 {
        match self {
            Renderer::Deterministic => 0,
            Renderer::LuxCore => 1,
            Renderer::Flat => 2,
        }
    }

    pub fn from_u32(value: u32) -> Renderer {
        match value {
            1 => Renderer::LuxCore,
            2 => Renderer::Flat,
            _ => Renderer::Deterministic,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Renderer::Deterministic => "Deterministic",
            Renderer::LuxCore => "Monte Carlo",
            Renderer::Flat => "Flat",
        }
    }

    /// Every renderer, in encoding order, for building a menu.
    pub fn all() -> [Renderer; 3] {
        [Renderer::Deterministic, Renderer::LuxCore, Renderer::Flat]
    }
}

/// Which environment the ported LuxCore path lights the stone with (T-0127).
///
/// The ported path reaches its environment through exactly one seam,
/// `Env_GetRadiance(direction, out directPdfW)` in `src/shaders/lux/pathtracer.glsl`, and
/// there are two genuinely different things that seam can be wired to. This is a *source*
/// selection rather than a replacement because both are needed and neither can stand in for
/// the other:
///
/// * `Project` is this project's own environment story -- the Gem Cut Studio assessment
///   models, the head-shadow cone, the equirectangular skybox image, the environment
///   rotation and intensity -- read through `gem.frag`'s existing `sampleEnvironment`. It is
///   the default, because a person who picks a lighting model means it whichever renderer is
///   drawing.
/// * `LuxCoreNative` is LuxCore's own `constantinfinite` sky plus `sun` lights, ported in
///   `src/shaders/lux/lights.glsl`. **This is what `tools/compare_luxcore.py` scores the port
///   against**, because the oracle scenes `tools/luxcore_oracle.py` writes are built from
///   exactly that rig. Losing it would destroy the only measurement that says the port is
///   faithful, so it stays reachable: `tests/harness/gem.py` selects it whenever
///   `$GEM_RENDERER` asks for the ported renderer, alongside the lighting model and flat
///   background it already forces to match the oracle scene.
///
/// The deterministic renderer ignores this entirely; it has only ever had the project's own
/// environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LuxEnvironment {
    /// `gem.frag`'s `sampleEnvironment`, i.e. whatever `lighting_model` selects.
    Project,
    /// LuxCore's own `ConstantInfiniteLight` + `SunLight`, the oracle comparison's rig.
    LuxCoreNative,
}

impl LuxEnvironment {
    /// Stable integer encoding, sent as the `uLuxEnvironment` uniform. Must match
    /// `LUX_ENVIRONMENT_PROJECT` / `LUX_ENVIRONMENT_LUXCORE` in
    /// `src/shaders/lux/lights.glsl`; a test enforces that.
    pub fn as_u32(self) -> u32 {
        match self {
            LuxEnvironment::Project => 0,
            LuxEnvironment::LuxCoreNative => 1,
        }
    }

    /// Anything unrecognised falls back to the project's own environment, for the same
    /// reason `Renderer::from_u32` falls back to the deterministic tracer: a stale page or a
    /// typed console call should land on what the user asked the page for, not on a
    /// validation rig.
    pub fn from_u32(value: u32) -> LuxEnvironment {
        match value {
            1 => LuxEnvironment::LuxCoreNative,
            _ => LuxEnvironment::Project,
        }
    }
}

/// Samples per pixel the ported LuxCore path takes in one **pass**, i.e. in one `render()`.
///
/// One, because since T-0122 the passes accumulate: the image converges over frames rather
/// than inside a single draw, so the right amount of work for one frame is the smallest
/// amount that still makes progress. That is what keeps the view interactive -- a pass
/// costs about what the deterministic renderer's whole frame costs -- while the image keeps
/// improving for as long as the view is left alone.
///
/// It was 16 between T-0120 and T-0122, when every sample had to be taken inside one
/// uninterruptible draw because there was no accumulation buffer. Raising it now buys
/// nothing that leaving the stone still does not buy more cheaply; it exists as a control
/// only because the accumulation buffer can be unavailable (see
/// `gpu::FLOAT_RENDER_TARGET_EXTENSION`), and in that fallback it is again the only way to
/// get more than one sample.
pub const DEFAULT_LUX_SAMPLES: u32 = 1;

/// Upper bound on `lux_samples`.
///
/// A fragment shader cannot be interrupted, so an absurd sample count is a hung tab rather
/// than a slow frame -- the same reason `MAX_BOUNCES` exists. 4096 at 640x640 is already
/// far beyond what is practical here; the cap is a guard, not a recommendation.
pub const MAX_LUX_SAMPLES: u32 = 4096;

/// How many passes `AccumulationState` will accumulate before it stops adding to the sum.
///
/// Two reasons for a bound rather than an open-ended counter. The estimator divides the
/// accumulated radiance by the pass count, so the count must never wrap; and a page left
/// open overnight should stop asking for frames it can no longer visibly improve, because
/// Monte Carlo error falls as 1/sqrt(n) and pass 65,536 moves a pixel by about 0.2% of
/// what pass 16 moved it.
///
/// 65,536 rather than a round 1,000 because the sum is kept in a 32-bit float
/// (`gpu::AccumulationTargets`), which carries it exactly enough that the last pass still
/// registers, and because the cap is a guard rather than a recommendation -- as with
/// `MAX_LUX_SAMPLES`.
pub const MAX_ACCUMULATED_PASSES: u32 = 65_536;

/// The gemmological wavelengths this project quotes dispersion between, and the reference
/// line its refractive index is quoted at, in nanometres.
///
/// Repeated here from `tools/luxcore_oracle.py`'s constants of the same names, because the
/// Cauchy conversion below has to produce the same numbers the oracle's `.scn` files carry
/// or the two renderers are not tracing the same glass. A test compares the two sources.
pub const SODIUM_D_LINE_NM: f32 = 589.3;
pub const GEMMOLOGY_G_LINE_NM: f32 = 430.8;
pub const GEMMOLOGY_B_LINE_NM: f32 = 686.7;

/// The wavelengths the red, green and blue channels refract at, in nanometres.
///
/// **These are fitted, not derived, and that is deliberate.** They are the three points on
/// Cauchy's curve that best reproduce Gem Cut Studio's fire; they are not a claim about what
/// wavelength a red pixel "is". Three such claims have been made and all three were wrong:
///
/// | | red | green | blue | traced spread | 23-view score |
/// |---|---|---|---|---|---|
/// | the Fraunhofer B, D and G lines | 686.7 | 589.3 | 430.8 | 100% of dispersion | 7.8772 |
/// | LuxCore's response-weighted effective lambda | 602.5 | 533.4 | 442.8 | 71.8% | 7.4179 |
/// | the sRGB primaries' dominant lambda | 611.4 | 549.1 | 464.2 | 60.2% | not rendered |
/// | **fitted against Gem Cut Studio** | **675** | **520** | **474** | **69.0%** | **6.6280** |
///
/// The B, D and G lines above are where dispersion is *defined* (`n_B - n_G`), which is why
/// they were the first guess and why `cauchy_from_gemmological_constants` still solves the
/// curve from them. They are not where to sample it.
///
/// **How they were obtained** (T-0219): the three were made a runtime parameter on the
/// `spectral-lines/index-probe` branch and swept against GCS. They fit *independently* --
/// exactly, not approximately -- because under Angle Rings the output's channel `c` is
/// component `c` of the ring colour along channel `c`'s refracted direction, and that
/// direction depends only on channel `c`'s index. Every minimum is sharp, and red and blue
/// land on the same value when the fit is repeated on a different stone at a 4.7x smaller
/// dispersion (the hex cut, n_d 2.16 / 0.060, against Hanabi's 2.85 / 0.280); green agrees to
/// about 10 nm on a visibly flatter curve.
///
/// **What this inherits.** Being fitted to GCS, these reproduce whatever GCS does, including
/// anything GCS gets wrong. If the goal ever changes from "match Gem Cut Studio" to "be
/// physically right", this is the first constant to revisit -- and re-deriving it from theory
/// is not the way, because that has now failed three times. Re-fit it, on at least two stones
/// at different dispersions, and check the minimum is sharp.
///
/// **Expressed convention-free**, as offsets from the d-line index in units of the quoted
/// dispersion `D` (material-independent, since Cauchy's B is linear in `D`), these are
/// `n_d - 0.210 D`, `n_d + 0.251 D` and `n_d + 0.481 D`. That form survives a change to
/// `cauchy_from_gemmological_constants`; the wavelengths do not.
///
/// See `spectral_indices` and `kb/spectral-sampling-wavelengths.md`.
pub const CHANNEL_RED_NM: f32 = 675.0;
pub const CHANNEL_GREEN_NM: f32 = 520.0;
pub const CHANNEL_BLUE_NM: f32 = 474.0;

/// Converts (index at the sodium D line, B-G dispersion) into LuxCore's Cauchy A and B.
///
/// **`scene.materials.<m>.interiorior` is Cauchy's A, not an index of refraction at any
/// wavelength.** LuxCore evaluates `n(lambda) = A + B / lambda_um^2` and feeds the material
/// parameter straight in as A -- the line that would convert a measured d-line index is
/// commented out upstream, and is ported as a comment in
/// `src/shaders/lux/glass.glsl`'s `GlassMaterial_WaveLength2IOR`. A gemmological index
/// handed over unconverted is wrong at every wavelength. See
/// `kb/luxcore-as-a-reference-oracle.md`.
///
/// This is the host-side half of that: the ported shader gets A and B as uniforms, exactly
/// as `tools/luxcore_oracle.py` writes them into the oracle's scene file.
pub fn cauchy_from_gemmological_constants(index_at_d_line: f32, dispersion: f32) -> (f32, f32) {
    let inv_um2 = |nm: f32| (1000.0 / nm) * (1000.0 / nm);

    let b = dispersion / (inv_um2(GEMMOLOGY_G_LINE_NM) - inv_um2(GEMMOLOGY_B_LINE_NM));
    let a = index_at_d_line - b * inv_um2(SODIUM_D_LINE_NM);

    (a, b)
}

/// The studio rig's five bright sources, as (polar angle from world +Y, azimuth) in
/// degrees, and how wide they are.
///
/// Mirrors `DEFAULT_SUNS`, `--sun-radius-degrees` and `SUN_RELSIZE_PER_DEGREE_RADIUS` in
/// `tools/luxcore_oracle.py`, which is what wrote the `.scn` files the ported
/// `src/shaders/lux/lights.glsl` was checked against. Its own `LUX_ENV_SUN_DIR` constants
/// are these same five directions; `lux_sun_directions_match_the_ported_lights_shader`
/// compares the two so they cannot drift.
pub const LUX_STUDIO_SUNS_DEGREES: [(f32, f32); 5] = [
    (25.0, 20.0),
    (35.0, 145.0),
    (50.0, 255.0),
    (60.0, 75.0),
    (18.0, 300.0),
];

/// Angular *radius* the oracle widens each sun to. Gem Cut Studio's sources are about 3
/// degrees across, but a specular chain almost never lands on one that small; 6 degrees of
/// radius is the compromise that converges. See `tools/luxcore_oracle.py`.
pub const LUX_SUN_RADIUS_DEGREES: f32 = 6.0;

/// `relsize 1` is the real sun, angular radius `asin(695500 / 149600000)`, so `relsize` is
/// the wanted angular radius in degrees times this.
pub fn lux_sun_relsize() -> f32 {
    LUX_SUN_RADIUS_DEGREES / (695500.0f32 / 149_600_000.0).asin().to_degrees()
}

/// World-space direction of studio sun `index`, pointing *at* the sun.
///
/// World +Y is the stone's optical axis and points back at the camera, so the polar angle
/// is the "tilt" the assessment models are measured against. Matches
/// `tools/luxcore_oracle.py`'s `environment_rig`.
pub fn lux_sun_direction(index: usize) -> Vector3<f32> {
    let (theta_degrees, phi_degrees) = LUX_STUDIO_SUNS_DEGREES[index];
    let theta = theta_degrees.to_radians();
    let phi = phi_degrees.to_radians();

    Vector3::new(
        theta.sin() * phi.cos(),
        theta.cos(),
        theta.sin() * phi.sin(),
    )
}

/// A named material with measured optical constants.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GemMaterial {
    pub name: &'static str,
    /// Refractive index at the middle of the visible band (the sodium D line).
    pub refractive_index: f32,
    /// Dispersion, quoted the way gemmology quotes it: the difference between the
    /// refractive index at the violet G line (430.8 nm) and the red B line (686.7 nm).
    /// This is what produces "fire", the coloured flashes from a stone. (Diamond's 0.044
    /// is the B–G figure; between the F and C lines it would be about 0.025.)
    pub dispersion: f32,
    /// Per-channel Beer-Lambert absorption coefficient, in inverse world units.
    /// Higher values in a channel remove that channel over distance, so the body
    /// colour of the stone is the *complement* of these numbers.
    pub absorption: Vector3<f32>,
}

/// Measured constants for common gem materials, in order of refractive index, which is
/// the order the page's menu lists them in.
///
/// Refractive index and dispersion are standard published gemmological values.
/// Doubly refracting stones have a range of indices; this renderer traces one, so they take
/// roughly the middle of the range. Two figures are less certain than the rest:
/// - opal is amorphous and gem tables quote no dispersion, so it takes silica glass's;
/// - rutile's birefringence (about 0.29) dwarfs its dispersion, and a single index cannot show it.
///
/// The absorption vectors are chosen to give a plausible body colour rather than
/// measured, since real absorption spectra vary by specimen. Where a species comes in many
/// colours, one typical colour was picked: pink tourmaline, imperial topaz, red spinel, and
/// colourless quartz, zircon and YAG.
pub const MATERIALS: &[GemMaterial] = &[
    GemMaterial {
        name: "Fluorite",
        refractive_index: 1.434,
        dispersion: 0.007,
        // Pale purple.
        absorption: Vector3::new(0.2, 0.4, 0.1),
    },
    GemMaterial {
        name: "Opal",
        refractive_index: 1.45,
        dispersion: 0.010,
        // Nearly colourless with a faint warmth. Play of colour and milkiness come from
        // internal structure and scattering, which this renderer does not model.
        absorption: Vector3::new(0.02, 0.03, 0.06),
    },
    GemMaterial {
        name: "Glass",
        refractive_index: 1.52,
        dispersion: 0.008,
        absorption: Vector3::new(0.04, 0.03, 0.03),
    },
    GemMaterial {
        name: "Quartz",
        refractive_index: 1.544,
        dispersion: 0.013,
        // Rock crystal: colourless.
        absorption: Vector3::new(0.02, 0.02, 0.02),
    },
    GemMaterial {
        name: "Amethyst",
        refractive_index: 1.544,
        dispersion: 0.013,
        absorption: Vector3::new(0.35, 0.8, 0.2),
    },
    GemMaterial {
        name: "Citrine",
        refractive_index: 1.544,
        dispersion: 0.013,
        // Yellow-orange.
        absorption: Vector3::new(0.05, 0.25, 0.9),
    },
    GemMaterial {
        name: "Smoky quartz",
        refractive_index: 1.544,
        dispersion: 0.013,
        // Greyish brown.
        absorption: Vector3::new(0.35, 0.45, 0.6),
    },
    GemMaterial {
        name: "Emerald",
        refractive_index: 1.58,
        dispersion: 0.014,
        absorption: Vector3::new(0.9, 0.12, 0.6),
    },
    GemMaterial {
        name: "Aquamarine",
        refractive_index: 1.58,
        dispersion: 0.014,
        // Pale blue-green.
        absorption: Vector3::new(0.45, 0.1, 0.05),
    },
    GemMaterial {
        name: "Topaz",
        refractive_index: 1.62,
        dispersion: 0.014,
        // Imperial: golden orange.
        absorption: Vector3::new(0.04, 0.4, 0.9),
    },
    GemMaterial {
        name: "Tourmaline",
        refractive_index: 1.63,
        dispersion: 0.017,
        // Pink.
        absorption: Vector3::new(0.05, 0.6, 0.25),
    },
    GemMaterial {
        name: "Dioptase",
        refractive_index: 1.67,
        dispersion: 0.036,
        // Intense, dark green.
        absorption: Vector3::new(1.6, 0.25, 0.9),
    },
    GemMaterial {
        name: "Peridot",
        refractive_index: 1.67,
        dispersion: 0.020,
        // Yellowish green.
        absorption: Vector3::new(0.5, 0.1, 0.8),
    },
    GemMaterial {
        name: "Tanzanite",
        refractive_index: 1.695,
        dispersion: 0.019,
        // Violet-blue.
        absorption: Vector3::new(0.6, 0.9, 0.1),
    },
    GemMaterial {
        name: "Spinel",
        refractive_index: 1.718,
        dispersion: 0.020,
        // Pinkish red.
        absorption: Vector3::new(0.05, 0.8, 0.4),
    },
    GemMaterial {
        name: "Pyrope",
        refractive_index: 1.74,
        dispersion: 0.022,
        // Deep red.
        absorption: Vector3::new(0.1, 1.6, 1.3),
    },
    GemMaterial {
        name: "Tsavorite",
        refractive_index: 1.74,
        dispersion: 0.028,
        // Vivid green.
        absorption: Vector3::new(1.0, 0.1, 0.8),
    },
    GemMaterial {
        name: "Hessonite",
        refractive_index: 1.745,
        dispersion: 0.028,
        // Cinnamon orange-brown.
        absorption: Vector3::new(0.1, 0.55, 1.1),
    },
    GemMaterial {
        name: "Rhodolite",
        refractive_index: 1.76,
        dispersion: 0.026,
        // Purplish red.
        absorption: Vector3::new(0.1, 1.0, 0.45),
    },
    GemMaterial {
        name: "Sapphire",
        refractive_index: 1.77,
        dispersion: 0.018,
        absorption: Vector3::new(0.9, 0.55, 0.15),
    },
    GemMaterial {
        name: "Ruby",
        refractive_index: 1.77,
        dispersion: 0.018,
        absorption: Vector3::new(0.08, 1.1, 0.9),
    },
    GemMaterial {
        name: "Spessartine",
        refractive_index: 1.80,
        dispersion: 0.027,
        // Orange.
        absorption: Vector3::new(0.03, 0.45, 1.2),
    },
    GemMaterial {
        name: "YAG",
        refractive_index: 1.833,
        dispersion: 0.028,
        absorption: Vector3::new(0.02, 0.02, 0.02),
    },
    GemMaterial {
        name: "Demantoid",
        refractive_index: 1.885,
        dispersion: 0.057,
        // Yellowish green.
        absorption: Vector3::new(0.55, 0.08, 0.7),
    },
    GemMaterial {
        name: "Zircon",
        refractive_index: 1.95,
        dispersion: 0.039,
        absorption: Vector3::new(0.02, 0.02, 0.03),
    },
    GemMaterial {
        name: "Cubic zirconia",
        refractive_index: 2.16,
        dispersion: 0.060,
        absorption: Vector3::new(0.03, 0.03, 0.03),
    },
    GemMaterial {
        name: "Diamond",
        refractive_index: 2.417,
        dispersion: 0.044,
        absorption: Vector3::new(0.02, 0.02, 0.02),
    },
    GemMaterial {
        name: "Moissanite",
        refractive_index: 2.65,
        dispersion: 0.104,
        absorption: Vector3::new(0.05, 0.04, 0.08),
    },
    GemMaterial {
        name: "Rutile",
        refractive_index: 2.76,
        dispersion: 0.280,
        // Synthetic rutile's pale yellow.
        absorption: Vector3::new(0.03, 0.08, 0.3),
    },
];

/// The preset whose optical constants the renderer starts with.
///
/// Cubic zirconia, because the Gem Cut Studio reference renders in `reference/` use
/// refractive index 2.16 and dispersion 0.060, which are its published constants.
pub const DEFAULT_MATERIAL_NAME: &str = "Cubic zirconia";

/// Grey level of the default flat background, in 0..1 display units.
///
/// The Gem Cut Studio references set the background to HSL (0, 0.00, 0.35). With zero
/// saturation every channel equals the lightness, so it is 0.35 grey, and the
/// screenshots measure sRGB 88 = 0.345. The background is written to the frame without
/// tone mapping (see `use_background_color`), so this is the value that appears.
pub const DEFAULT_BACKGROUND_LEVEL: f32 = 0.35;

/// Radius of the observer, an opaque body on the view axis infinitely far away, in world units
/// (the stone is normalised to radius 1). See `RenderParams::observer_radius`.
///
/// Measured from the dot at the table centre of the Gem Cut Studio face-up screenshots. Its
/// edge sits at 0.0268 of the girdle half-width in both `hex_cut_v2_gcs_front_iso_window.png`
/// and `hex_cut_v2_gcs_front_cosine.png` (interpolated from ring-averaged luminance), and the
/// girdle corners are at radius 0.97985 here, so 0.0268 x 0.97985 = 0.0263.
pub const DEFAULT_OBSERVER_RADIUS: f32 = 0.0263;

/// Largest observer radius accepted: a quarter of the stone, far beyond anything that
/// resembles an eye, but still bounded.
pub const MAX_OBSERVER_RADIUS: f32 = 0.25;

/// The default window (leak) colour, RGB (202, 0, 253) in 0..1 display units.
pub const DEFAULT_WINDOW_COLOR: Vector3<f32> =
    Vector3::new(202.0 / 255.0, 0.0, 253.0 / 255.0);

/// Looks up a material by name, case-insensitively.
pub fn material_by_name(name: &str) -> Option<&'static GemMaterial> {
    MATERIALS
        .iter()
        .find(|m| m.name.eq_ignore_ascii_case(name))
}

/// The complete parameter set the renderer sends to the shader.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderParams {
    pub refractive_index: f32,
    pub dispersion: f32,
    pub absorption: Vector3<f32>,
    /// Multiplier on `absorption`, exposed separately so the body colour can be
    /// deepened or lightened without re-picking a hue.
    pub absorption_scale: f32,
    /// Maximum internal bounces. Light still inside the stone when they run out is not
    /// discarded: it is filled with `exhaustion_shade` of the stone colour, as Gem Cut Studio
    /// does.
    pub max_bounces: u32,
    /// Wavelength samples per pixel: 1 disables dispersion, 3 traces the stone
    /// once per colour channel.
    pub spectral_samples: u32,
    pub exposure: f32,
    pub env_intensity: f32,
    /// Rotation of the environment about the vertical axis, in radians.
    pub env_rotation: f32,
    pub debug_mode: DebugMode,
    /// Which lighting environment the stone sits in.
    pub lighting_model: LightingModel,
    /// How radiance is mapped to display colour. Set from the lighting model.
    pub tone_map_mode: ToneMapMode,
    /// Half-angle of the observer's head shadow, in radians.
    ///
    /// A real observer's head blocks a cone of the incoming environment centred on the
    /// viewing direction, and a cut that depends on light from directly behind the
    /// viewer goes dark exactly when that light is blocked. Quoted as a *half* angle
    /// because that is the convention Gem Cut Studio uses, so the two can be set to the
    /// same number: to obscure a 20 degree cone, the value is 10 degrees.
    ///
    /// Zero disables it. Applied as a post-process on the environment lookup rather
    /// than baked into the map, which is both what GCS does and what lets it be
    /// adjusted without regenerating the texture.
    pub head_shadow_half_angle: f32,
    /// Colour the head shadow contributes. Black by default; a bright colour makes the
    /// distribution of head-shadow reflections visible against genuinely dark regions.
    pub head_shadow_color: Vector3<f32>,
    /// Radius, in world units, of an opaque body on the view axis that blocks light leaving the
    /// stone back towards the viewer from within this radius of the axis. Blocked light shows
    /// `head_shadow_color`. Zero disables it.
    ///
    /// The head shadow cone above removes *directions*, so facing the table it darkens every
    /// table reflection at once. This is positional instead: only reflections leaving within
    /// the radius of the view axis are blocked, which draws a small dot at the table centre.
    /// Gem Cut Studio's face-up screenshots all have that dot, with the head shadow at 0
    /// degrees, and inside it Isometric drops from 254 to 216-220 and Cosine from 109 to 66-73:
    /// in both, the table's reflection of the zenith light (R = 0.135) removed. In GCS the dot
    /// vanishes when the stone turns even a fraction of a degree. So for the orthographic camera
    /// the body is infinitely far away and the dot goes at 0.003 degrees. For the default
    /// perspective camera the body sits at the eye and the dot goes at 0.058 degrees. See
    /// `camera::CameraBasis::observer_blocks`.
    pub observer_radius: f32,
    /// When true, rays that miss the stone show `background_color` instead of the
    /// environment. So does light arriving from behind the stone (see `use_window_color`)
    /// while the window colour is off, as in Gem Cut Studio. That is why turning this on also
    /// changes the stone itself, under the skybox and studio lighting as well (T-0038).
    ///
    /// The environment is the physically honest backdrop, and is the default. But it
    /// makes the silhouette hard to judge and impossible to composite, and every
    /// assessment tool in this field puts the stone on a flat field instead, so this is
    /// an explicit override rather than a hack.
    pub use_background_color: bool,
    pub background_color: Vector3<f32>,
    /// When true, light arriving from behind the stone (a "window" or leak) shows
    /// `window_color`. That is light, at any bounce, arriving from below the lighting horizon
    /// or leaving through a facet that faces below it (README decision 27; mirrored by
    /// `camera::CameraBasis::light_comes_from_behind`).
    ///
    /// Gem Cut Studio's "Use Separate Window Color". When it is off, such light shows the
    /// flat background colour if that is enabled, as in GCS, and the environment
    /// otherwise. A bright colour makes leakage obvious.
    pub use_window_color: bool,
    /// Picked colour for leaked light, in 0..1 display units.
    pub window_color: Vector3<f32>,
    /// When true, the lighting environment and head shadow are fixed to the viewer, not the
    /// world.
    ///
    /// Gem Cut Studio keeps the observer and lights still and rotates the stone, so its tilted
    /// views only match with this on. It is identical to the world-fixed lighting at the
    /// default straight-down view. Off, orbiting moves the viewer around a stone sitting in
    /// fixed lights. See `CameraBasis::to_lighting_frame`.
    pub lighting_follows_view: bool,
    /// Shade, in 0..1 display units of the stone's own colour, given to light still inside the
    /// stone when `max_bounces` runs out.
    ///
    /// Gem Cut Studio: "the area will be colored in a slightly darker tint of the gem color, as
    /// an approximation of the actual result". Its screenshots put that at half. The corner
    /// triangles of the face-up Isometric screenshot measure 144/255, which is exactly
    /// 0.5 × 0.865 (the light admitted through the crown) plus 0.135 reflected off it. Zero
    /// truncates such paths to black, which was this renderer's original behaviour; it
    /// underestimates, because total internal reflection keeps nearly all the light.
    pub exhaustion_shade: f32,

    /// When true, the deterministic renderer outlines every facet the viewer can see.
    ///
    /// Drawn over the finished pixel, after tone mapping, so it changes nothing the stone
    /// itself renders. Only the facet the primary ray hits is outlined, which is what hides
    /// the edges behind the stone: a hidden edge is never the nearest surface of any pixel.
    /// Ignored by the ported LuxCore path, whose page control is hidden for that reason.
    pub wireframe: bool,

    /// Which path tracer in the shader draws the frame (T-0120). See `Renderer`.
    pub renderer: Renderer,

    /// Samples per pixel for `Renderer::LuxCore`. Ignored by the deterministic path, which
    /// takes exactly one primary ray per pixel.
    pub lux_samples: u32,

    /// Mixed into the ported sampler's per-pixel seed, so a caller can ask for an
    /// independent noise realisation of the same scene. At a fixed value a render is a pure
    /// function of the parameters, which the browser harness relies on.
    pub lux_seed: u32,

    /// Which environment `Renderer::LuxCore` lights the stone with (T-0127). See
    /// `LuxEnvironment`. Ignored by the deterministic path, which has only the project's own.
    pub lux_environment: LuxEnvironment,
}

/// The defaults reproduce the settings visible in the Gem Cut Studio reference
/// screenshots in `reference/`, so a fresh page load can be compared against them
/// directly. See `defaults_match_the_gem_cut_studio_reference`.
impl Default for RenderParams {
    fn default() -> Self {
        let material =
            material_by_name(DEFAULT_MATERIAL_NAME).expect("the default material must be a preset");

        RenderParams {
            refractive_index: material.refractive_index,
            dispersion: material.dispersion,
            // No body colour. The references use stone colour HSL (0, 0.00, 1.00) at
            // 100% clarity, which is a perfectly colourless stone. Picking a preset from
            // the menu still applies that preset's absorption.
            absorption: Vector3::zeros(),
            absorption_scale: 1.0,
            // Chosen by the user (2026-09-14). The GCS screenshots differ (10 for Random, 16
            // for the analytical models), so set the slider to match whichever screenshot is
            // being compared. The image has not converged here either: it still changes by
            // about 1.3% RMS per four extra bounces at 32 (kb/browser-harness.md).
            max_bounces: 14,
            spectral_samples: 3,
            exposure: 1.0,
            env_intensity: 1.0,
            env_rotation: 0.0,
            debug_mode: DebugMode::Full,
            lighting_model: LightingModel::Studio,
            tone_map_mode: ToneMapMode::Filmic,
            head_shadow_half_angle: 0.0,
            head_shadow_color: Vector3::zeros(),
            // Measured from the GCS centre dot; see the constant.
            observer_radius: DEFAULT_OBSERVER_RADIUS,
            // A flat grey field, as in the references, rather than the environment.
            use_background_color: true,
            background_color: Vector3::repeat(DEFAULT_BACKGROUND_LEVEL),
            // Off, as in GCS. A violet-magenta, RGB (202, 0, 253), chosen by the user
            // (2026-09-14), for when it is turned on: a colour no lighting environment here
            // produces, so any of it on screen is a leak.
            use_window_color: false,
            window_color: DEFAULT_WINDOW_COLOR,
            // As in GCS, so tilted views are comparable with its screenshots.
            lighting_follows_view: true,
            // GCS's measured half tint; see the field's documentation.
            exhaustion_shade: 0.5,
            // On, at the user's request (2026-09-18).
            wireframe: true,
            // The deterministic renderer stays the default. T-0120 wired the LuxCore port in
            // behind this toggle precisely so the swap can be a measured decision later
            // rather than a leap now.
            renderer: Renderer::Deterministic,
            lux_samples: DEFAULT_LUX_SAMPLES,
            lux_seed: 0,
            // The user's own environment, not LuxCore's validation rig: whoever picks a
            // lighting model means it whichever renderer is drawing. The oracle comparison
            // asks for the other one explicitly; see `LuxEnvironment`.
            lux_environment: LuxEnvironment::Project,
        }
    }
}

/// Hard limits, applied on every mutation so a bad value from the UI can never
/// reach the shader and produce a black or hung frame.
pub const MIN_REFRACTIVE_INDEX: f32 = 1.0;
pub const MAX_REFRACTIVE_INDEX: f32 = 4.0;
pub const MAX_DISPERSION: f32 = 0.5;
/// 2026-09-22, the user: "make the minimum max internal bounces 3" -- below 3 a stone
/// barely reads as glass (see `RenderParams::draft`'s own floor at 3 while dragging, added
/// the same day, which this makes the slider's own minimum rather than only draft mode's).
pub const MIN_BOUNCES: u32 = 3;
/// Must match `MAX_BOUNCE_LIMIT` in `gem.frag`, which needs a compile-time bound.
pub const MAX_BOUNCES: u32 = 32;
/// A head shadow is a cone about the viewing axis, so half of it can at most reach the
/// horizon. Beyond 90 degrees it would obscure the entire visible hemisphere.
pub const MAX_HEAD_SHADOW_HALF_ANGLE: f32 = std::f32::consts::FRAC_PI_2;
/// The darkest stone colour channel `set_stone_color` accepts: an absorption of about 6.9 per
/// world unit, so a channel picked as black is black through any real path, without the
/// infinity a transmittance of 0 would need.
pub const MIN_STONE_TRANSMITTANCE: f32 = 1e-3;

impl RenderParams {
    pub fn from_material(material: &GemMaterial) -> Self {
        RenderParams {
            refractive_index: material.refractive_index,
            dispersion: material.dispersion,
            absorption: material.absorption,
            ..Default::default()
        }
    }

    /// Applies a named material's optical constants, leaving the rendering
    /// settings (exposure, bounce count, debug mode) untouched.
    pub fn apply_material(&mut self, material: &GemMaterial) {
        self.refractive_index = material.refractive_index;
        self.dispersion = material.dispersion;
        self.absorption = material.absorption;
    }

    /// Refractive indices for the red, green and blue samples.
    ///
    /// Evaluated on the same Cauchy curve (`n(lambda) = A + B / lambda_um^2`) the ported
    /// LuxCore path traces, at `CHANNEL_RED_NM` / `CHANNEL_GREEN_NM` / `CHANNEL_BLUE_NM` --
    /// wavelengths *fitted* against Gem Cut Studio, for the reasons that constant's own doc
    /// comment gives.
    ///
    /// **This has been wrong three times, in three different ways.**
    ///
    /// 1. It was a plain symmetric split (`n_d -/+ dispersion / 2`), wrong by a fixed ~27% of
    ///    the dispersion at *every* index, because Cauchy's `1/lambda^2` term is convex: the
    ///    index at the G line rises faster above `n_d` than the index at the B line falls
    ///    below it, and no symmetric split can reproduce that skew. T-0174.
    /// 2. It then sampled the B, D and G lines themselves -- the interval dispersion is
    ///    *defined* over, not the wavelengths to trace. That put green at exactly `n_d` and
    ///    spread red to blue over the full quoted dispersion, both too wide and mis-centred.
    /// 3. It then sampled the response-weighted effective wavelengths of LuxCore's own
    ///    `WaveLength2RGB` curve (602.5 / 533.4 / 442.8). That got the *spread* nearly right
    ///    (71.8% of the quoted dispersion against a fitted 69.0%) and green nearly right, but
    ///    moved red the wrong way -- 686.7 was within 0.022 D of the fitted value and 602.5 is
    ///    0.172 D away, eight times worse. T-0212.
    ///
    /// Every one of those was a derivation from what red, green and blue "are". The fourth
    /// answer, the one below, was measured instead. T-0219.
    ///
    /// **Two invariants people reach for are false here.** `n_blue - n_red` is *not* the
    /// quoted dispersion (it is 0.690 of it, a constant of the four wavelengths alone and so
    /// the same for every material), and `spectral_indices().y` is *not* `refractive_index`
    /// (520 nm refracts harder than the 589.3 nm D line). The slider still *means* the d-line
    /// index; it is simply not an index any channel traces.
    ///
    /// **`cauchy_from_gemmological_constants` is deliberately untouched by all of this.** The
    /// curve is still solved from the B, D and G lines, because that is what the dispersion
    /// number means and what `tools/luxcore_oracle.py` writes into the oracle's `.scn` files.
    /// Only the three points sampled on it have moved. Anything that changes the conversion
    /// changes what glass the two renderers are comparing, which is a different and much
    /// larger claim.
    ///
    /// At **dispersion 0** Cauchy's B is 0, every wavelength gives the same index, and the
    /// choice is exactly a no-op. All 8 zero-dispersion comparison views re-render
    /// byte-identically across all four choices above; that is the cheapest regression test
    /// this constant has.
    ///
    /// See kb/spectral-sampling-wavelengths.md.
    pub fn spectral_indices(&self) -> Vector3<f32> {
        if self.spectral_samples <= 1 {
            return Vector3::repeat(self.refractive_index);
        }

        let (cauchy_a, cauchy_b) =
            cauchy_from_gemmological_constants(self.refractive_index, self.effective_dispersion());
        let n_at = |nm: f32| cauchy_a + cauchy_b * (1000.0 / nm) * (1000.0 / nm);

        Vector3::new(
            n_at(CHANNEL_RED_NM),
            n_at(CHANNEL_GREEN_NM),
            n_at(CHANNEL_BLUE_NM),
        )
    }

    /// The dispersion actually traced: the stored value, limited so the red index
    /// (`refractive_index - dispersion / 2`) never falls below `MIN_REFRACTIVE_INDEX`.
    ///
    /// The limit is applied here, where the indices are derived, rather than to the stored
    /// value in `clamp`. It depends on the refractive index, and clamping the stored value
    /// destroyed it for good: dragging the index to 1.0 set the dispersion to 0, and it stayed
    /// 0 when the index rose again, while the page still showed the old value.
    pub fn effective_dispersion(&self) -> f32 {
        let max_safe = (2.0 * (self.refractive_index - MIN_REFRACTIVE_INDEX)).max(0.0);

        self.dispersion.min(max_safe)
    }

    /// Effective absorption coefficients after scaling.
    pub fn effective_absorption(&self) -> Vector3<f32> {
        self.absorption * self.absorption_scale.max(0.0)
    }

    /// The stone's colour: the fraction of each channel that survives one world unit of
    /// travel through it (about the stone's radius, since the mesh is conditioned to unit
    /// size), `exp(-effective_absorption)`, channels in 0..1. White is colourless, which is
    /// how Gem Cut Studio's "pure white" stone and `analytical` agree.
    ///
    /// Linear, not a display value: it multiplies radiance, as `exp(-uAbsorption)` does in
    /// the out-of-bounces fill (see kb/out-of-bounces-shade.md).
    pub fn stone_color(&self) -> Vector3<f32> {
        self.effective_absorption().map(|absorption| (-absorption).exp())
    }

    /// Sets the absorption so that `stone_color` returns `color`, and the absorption scale to
    /// 1, so the colour picked is the colour rendered even after `analytical` zeroed the
    /// scale. Each channel is floored at `MIN_STONE_TRANSMITTANCE`, because a channel of 0
    /// would need infinite absorption.
    pub fn set_stone_color(&mut self, color: Vector3<f32>) {
        self.set_stone_base_color(color);
        self.absorption_scale = 1.0;
    }

    /// The stone's colour at an absorption scale of 1, `exp(-absorption)`: what
    /// `stone_color` returns when the scale is 1, whatever the scale is now. The page's colour
    /// editor shows this and its opacity slider is the scale, so the two are independent.
    pub fn stone_base_color(&self) -> Vector3<f32> {
        self.absorption.map(|absorption| (-absorption).exp())
    }

    /// Sets the absorption so that `stone_base_color` returns `color`, leaving the absorption
    /// scale alone (`set_stone_color` is this plus resetting the scale). Each channel is
    /// floored at `MIN_STONE_TRANSMITTANCE`, as there.
    pub fn set_stone_base_color(&mut self, color: Vector3<f32>) {
        self.absorption = color.map(|channel| {
            -channel.clamp(MIN_STONE_TRANSMITTANCE, 1.0).ln()
        });
    }

    /// A reduced-quality variant of these parameters, for use while the user is
    /// interacting with the view. `quality` is the page's "drag quality"
    /// setting (0 to 1, clamped here): 1 leaves the bounce count untouched, and lower
    /// values scale it down by the same fraction, linearly, so it moves in lock step
    /// with the page's own canvas-resolution cut (`viewport.js`'s `draftResolutionScale`
    /// was replaced by this single knob for exactly that reason -- the two used to be
    /// set independently, which meant the bounce count and the resolution could disagree
    /// about how "cheap" a drag should be).
    ///
    /// **Dispersion is deliberately preserved.** Dropping to a single spectral sample
    /// would be the largest single saving available here (a 3x cut), and an earlier
    /// version did exactly that, but it is the wrong thing to sacrifice: fire is the
    /// effect a person rotates a stone in order to see. Making it vanish during the
    /// very motion that reveals it is the most jarring possible degradation, and it
    /// also misrepresents the material being previewed.
    ///
    /// Resolution is the other axis given up, and it is handled by the page rather
    /// than here (it is a property of the canvas, not of the material): the page
    /// multiplies its resolution scale by the same `quality` this multiplies the
    /// bounce count by, so at `quality = 1` a drag looks exactly like a still frame,
    /// and at `quality = 0.5` both are halved together.
    ///
    /// Guaranteed never to be more expensive than the original: `quality` is clamped
    /// to at most 1 before it multiplies, so the result can only ever be less than or
    /// equal to `self.max_bounces`. See `draft_is_never_more_expensive_than_full_quality`.
    ///
    /// Floored at 3 (`MIN_BOUNCES`, since 2026-09-22 -- also the slider's own minimum, for
    /// the same reason: below 3 there is barely any glass left to see, so someone wanting
    /// that little may as well use the Flat renderer). A drag at a low quality on a stone
    /// set to 20 bounces would otherwise round well under that; the explicit `max(3)` here
    /// is what stops it, since `quality` can make `self.max_bounces * quality` arbitrarily
    /// small on its own. Still capped by `self.max_bounces` immediately after, which
    /// matters only for a `self` that was never clamped (this function does not clamp its
    /// receiver): a genuinely configured stone can never be below `MIN_BOUNCES` itself, so
    /// the cap and the floor cannot conflict for any value the panel could actually produce.
    ///
    /// (T-0120) For the ported LuxCore path the sample count is the axis to give up, for the
    /// same reason resolution is: it is the one knob that is purely an amount of noise, not a
    /// change in what is being simulated. A quarter of the samples is a 4x saving and doubles
    /// the noise, which on a moving image reads as grain rather than as a different stone.
    /// Capped by the configured value so, like the bounce count above, it can never make a
    /// drag more expensive than the still frame. Left as a fixed quarter rather than also
    /// following `quality`: it changes how many frames accumulation takes to converge, not
    /// what the converged image looks like, so it isn't part of the "drag quality"
    /// the user is choosing.
    pub fn draft(&self, quality: f32) -> RenderParams {
        let mut draft = self.clone();
        let quality = quality.clamp(0.0, 1.0);

        let scaled_bounces = (self.max_bounces as f32 * quality).round() as u32;

        draft.max_bounces = scaled_bounces.max(3).min(self.max_bounces);
        draft.lux_samples = (self.lux_samples / 4).max(1).min(self.lux_samples);

        draft.clamp();

        draft
    }

    /// A proxy for per-pixel cost: how many interior surface interactions the shader
    /// evaluates in the worst case. Used to compare quality settings in tests.
    pub fn worst_case_interior_events(&self) -> u32 {
        self.spectral_samples.max(1) * self.max_bounces
    }

    /// Clamps every field into a range the shader can handle.
    ///
    /// Refractive index is clamped at or above 1.0 because a value below 1 would
    /// make the stone optically thinner than air, inverting refraction and
    /// removing total internal reflection entirely. Bounce count is clamped
    /// because the shader's loop bound is a compile-time constant.
    pub fn clamp(&mut self) {
        self.refractive_index = self
            .refractive_index
            .clamp(MIN_REFRACTIVE_INDEX, MAX_REFRACTIVE_INDEX);

        // Only the fixed range here. The limit that keeps the red index at or above 1.0 depends
        // on the refractive index, so it is applied when the indices are derived; see
        // `effective_dispersion` for why the stored value must not be cut.
        self.dispersion = self.dispersion.clamp(0.0, MAX_DISPERSION);

        self.absorption = Vector3::new(
            self.absorption.x.max(0.0),
            self.absorption.y.max(0.0),
            self.absorption.z.max(0.0),
        );
        self.absorption_scale = self.absorption_scale.clamp(0.0, 100.0);
        self.max_bounces = self.max_bounces.clamp(MIN_BOUNCES, MAX_BOUNCES);
        self.spectral_samples = if self.spectral_samples <= 1 { 1 } else { 3 };
        self.exposure = self.exposure.clamp(0.01, 100.0);
        self.env_intensity = self.env_intensity.clamp(0.0, 100.0);
        self.head_shadow_half_angle = self
            .head_shadow_half_angle
            .clamp(0.0, MAX_HEAD_SHADOW_HALF_ANGLE);

        self.observer_radius = self.observer_radius.clamp(0.0, MAX_OBSERVER_RADIUS);
        self.head_shadow_color = clamp_color(self.head_shadow_color);
        self.background_color = clamp_color(self.background_color);
        self.window_color = clamp_color(self.window_color);
        self.exhaustion_shade = self.exhaustion_shade.clamp(0.0, 1.0);
        // At least one sample, or the ported path divides by zero and shows NaNs; capped
        // because a fragment shader cannot be interrupted (see MAX_LUX_SAMPLES).
        self.lux_samples = self.lux_samples.clamp(1, MAX_LUX_SAMPLES);
    }

    /// LuxCore's Cauchy A and B for this material, for the ported shader's uniforms.
    ///
    /// Uses `effective_dispersion` rather than the stored value, so the two renderers agree
    /// about the dispersion actually being traced -- `spectral_indices` uses the same
    /// limited value for the deterministic path.
    pub fn cauchy_coefficients(&self) -> (f32, f32) {
        cauchy_from_gemmological_constants(self.refractive_index, self.effective_dispersion())
    }

    /// How many of the ported studio rig's suns are lit.
    ///
    /// The oracle's two rigs differ only in this (`tools/luxcore_oracle.py`'s
    /// `environment_rig` takes the sun list as its one argument): `isometric` is the sky
    /// alone, `studio` is the sky plus five suns.
    ///
    /// Only read while `lux_environment` is `LuxEnvironment::LuxCoreNative`, i.e. while the
    /// ported path is lit by LuxCore's own rig rather than by this project's environment
    /// (T-0127). Under `LuxEnvironment::Project` the lighting model selects one of the
    /// assessment environments instead and no sun is evaluated at all.
    pub fn lux_sun_count(&self) -> u32 {
        match self.lighting_model {
            LightingModel::Studio => LUX_STUDIO_SUNS_DEGREES.len() as u32,
            _ => 0,
        }
    }

    /// These parameters with the material neutralised, for use with an analytical model.
    ///
    /// Gem Cut Studio's manual warns that the gem's colour multiplies the lighting model
    /// and that the material should be "reset to pure white if the intention is to use
    /// any of the more analytical models". Absorption is what gives this renderer its
    /// body colour, so pure white means zero absorption. Dispersion is dropped too: a
    /// ring boundary smeared into a rainbow cannot be read as an angle, which is the
    /// entire purpose of the Angle Rings model.
    pub fn analytical(&self) -> RenderParams {
        let mut neutral = self.clone();

        neutral.absorption = Vector3::zeros();
        neutral.absorption_scale = 0.0;
        neutral.dispersion = 0.0;
        neutral.spectral_samples = 1;

        neutral.clamp();

        neutral
    }
}

// --------------------------------------------------------------------------------------
// Progressive accumulation for the ported LuxCore path                              T-0122
// --------------------------------------------------------------------------------------

/// Everything the ported path's image is a function of.
///
/// Two frames whose keys are equal are estimates of the *same* integral, so their radiance
/// may be summed; anything else has to start a new sum. This is deliberately a value
/// compared for equality rather than a set of hand-written "did the camera move?" hooks,
/// because the failure mode of the hooks -- one mutator that forgets to invalidate --
/// shows up as a stale or smeared image with nothing to point at, and every new parameter
/// is another chance to forget. Here a new field of `RenderParams` is covered the day it
/// is added, and `accumulation_restarts_for_every_render_parameter` fails if some future
/// field is somehow exempt.
///
/// What each member stands for:
///
/// * `params` -- the **effective** parameters, after draft-mode reduction, so entering and
///   leaving a drag both restart. It carries the renderer choice, the sample count, the
///   seed, the material, the bounce limit, the exposure and the tone map, so all of those
///   are covered without being named here.
/// * `camera` -- `OrbitCamera` is the whole pose: spin, tilt, field of view and eye
///   distance. `orbit`, `zoom` and the `spin`/`tilt`/`fov`/`eyeDistance` parameters all
///   land in it.
/// * `width`/`height` -- the backing-store size. A resize also reallocates the buffers, so
///   there is nothing to carry over even in principle.
/// * `model_generation` -- bumped by a model load or an optical-axis change. The geometry
///   is in a texture, not in these parameters, so nothing else here would notice.
/// * `environment_generation` -- bumped whenever the environment texture is regenerated,
///   including `set_environment_image` replacing the image behind an unchanged
///   `lighting_model`.
/// * `frosted_facets` -- the facet ids drawn as rough glass (T-0183), ascending. Like the
///   geometry they live in a texture, so nothing else here would notice them change. Held as
///   the set itself rather than a generation counter because the page re-sends the same set
///   after every rebuild and design load: comparing contents means a resend that changes
///   nothing does not throw a converged image away.
#[derive(Debug, Clone, PartialEq)]
pub struct AccumulationKey {
    pub params: RenderParams,
    pub camera: crate::camera::OrbitCamera,
    pub width: u32,
    pub height: u32,
    pub model_generation: u64,
    pub environment_generation: u64,
    pub frosted_facets: Vec<u32>,
}

/// What one `render()` call should do, decided by [`AccumulationState::begin_pass`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PassPlan {
    /// Zero-based index of this pass within the current accumulation. Mixed into the
    /// shader's seed, so it -- and not a wall-clock frame counter -- is what makes each
    /// pass draw different random numbers. That is what keeps a fixed number of passes
    /// byte-reproducible: the same key rendered N times always draws the same N streams.
    pub index: u32,
    /// True when this pass started a fresh accumulation, so the caller must zero the
    /// buffers first.
    pub restarted: bool,
    /// False once `MAX_ACCUMULATED_PASSES` has been reached: the caller should skip the
    /// accumulate pass and only re-resolve what it already has.
    pub accumulate: bool,
    /// How many passes the sum contains once this one has been drawn -- the divisor the
    /// resolve pass needs.
    pub total: u32,
}

/// The pass counter behind progressive accumulation, and the rule for when to throw the
/// accumulated image away.
///
/// Pure host-side logic, kept out of `gpu.rs` and `lib.rs` so it can be unit tested: the
/// GL objects cannot be, and the reset rule is the part of this design that is easy to get
/// wrong and hard to see going wrong.
#[derive(Debug, Clone, Default)]
pub struct AccumulationState {
    /// The key every pass so far was drawn with. `None` before the first pass.
    key: Option<AccumulationKey>,
    passes: u32,
    /// Bumped every time `begin_pass` restarts the sum. This is the one honest signal for
    /// "a new accumulation just began": it fires on exactly the same condition that zeroes
    /// `passes` and clears the buffers (`AccumulationKey` inequality), so a caller timing
    /// how long the current accumulation has been running can watch this number instead of
    /// re-deriving the reset rule -- which is how a page-side copy of it would drift out of
    /// step with this one. Wraps rather than saturates: a caller only ever compares it for
    /// inequality against a previously observed value, never for ordering, so wrapping is
    /// invisible to that comparison and it never needs to stop counting.
    generation: u32,
}

impl AccumulationState {
    pub fn new() -> AccumulationState {
        AccumulationState {
            key: None,
            passes: 0,
            generation: 0,
        }
    }

    /// How many passes are in the current sum.
    pub fn passes(&self) -> u32 {
        self.passes
    }

    /// Identifies which accumulation "run" is current. Two reads that return the same
    /// value came from the same sum; a different value means a restart happened somewhere
    /// in between, even if the caller was not watching every frame.
    pub fn generation(&self) -> u32 {
        self.generation
    }

    /// True once no further pass will be added, so a caller driving frames to converge can
    /// stop asking for them.
    pub fn is_complete(&self) -> bool {
        self.passes >= MAX_ACCUMULATED_PASSES
    }

    /// Throws the accumulated image away unconditionally.
    ///
    /// Used when the ported path is not the one drawing -- so that switching to it later
    /// cannot resume a sum taken under settings nobody recorded -- and by the page and the
    /// test harness, which need a reset they can ask for by name rather than provoke.
    pub fn reset(&mut self) {
        self.key = None;
        self.passes = 0;
    }

    /// Registers the frame about to be drawn and says what to do with it.
    ///
    /// Restarts the accumulation when `key` differs from the one the sum was built with.
    pub fn begin_pass(&mut self, key: AccumulationKey) -> PassPlan {
        let restarted = self.key.as_ref() != Some(&key);

        if restarted {
            self.key = Some(key);
            self.passes = 0;
            self.generation = self.generation.wrapping_add(1);
        }

        if self.passes >= MAX_ACCUMULATED_PASSES {
            // Converged as far as this design goes. Re-resolving the existing sum is
            // cheap and keeps the canvas showing the image even though the canvas itself
            // is not preserved between frames.
            return PassPlan {
                index: self.passes,
                restarted,
                accumulate: false,
                total: self.passes,
            };
        }

        let index = self.passes;
        self.passes += 1;

        PassPlan {
            index,
            restarted,
            accumulate: true,
            total: self.passes,
        }
    }
}

/// Clamps a colour into the unit cube. Colours here are picked in a UI, so unlike
/// radiance they have no business exceeding 1.0.
fn clamp_color(color: Vector3<f32>) -> Vector3<f32> {
    Vector3::new(
        color.x.clamp(0.0, 1.0),
        color.y.clamp(0.0, 1.0),
        color.z.clamp(0.0, 1.0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What fraction of the quoted dispersion the three traced wavelengths actually span.
    ///
    /// Derived from the constants rather than written down, so a test that uses it cannot
    /// drift from the sampling it is meant to be checking. The quoted dispersion is
    /// `B * (inv(G) - inv(B_line))` by construction of `cauchy_from_gemmological_constants`,
    /// and the traced spread is `B * (inv(blue) - inv(red))`, so Cauchy's B cancels and the
    /// ratio depends on the four wavelengths alone -- the same for every material.
    fn traced_spread_fraction() -> f32 {
        let inv_um2 = |nm: f32| (1000.0 / nm) * (1000.0 / nm);

        (inv_um2(CHANNEL_BLUE_NM) - inv_um2(CHANNEL_RED_NM))
            / (inv_um2(GEMMOLOGY_G_LINE_NM) - inv_um2(GEMMOLOGY_B_LINE_NM))
    }

    /// Blue must bend more than green, and green more than red. This ordering is
    /// what creates fire; reversing it would tint the stone's flashes backwards.
    #[test]
    fn spectral_indices_increase_from_red_to_blue() {
        let params = RenderParams::default();
        let indices = params.spectral_indices();

        assert!(
            indices.x < indices.y && indices.y < indices.z,
            "expected red < green < blue, got {:?}",
            indices
        );
    }

    /// The traced spread is a fixed *fraction* of the quoted dispersion, and green does not
    /// sit at the nominal index.
    ///
    /// Setup: a stone at index 2.0 and dispersion 0.06, read through `spectral_indices`.
    ///
    /// Test: `n_blue - n_red` is 0.690430 of the quoted dispersion, and `n_green` is above
    /// `refractive_index` rather than equal to it.
    ///
    /// Verifies the two invariants this project kept reaching for and which the fitted
    /// sampling makes false. **Both used to be exact equalities** -- when red and blue sat on
    /// the B and G lines, `n_blue - n_red` *was* the dispersion, because that difference is
    /// literally how Cauchy's B is solved for; and green sat on the D line, which Cauchy's A
    /// is solved to reproduce exactly. Sampling anywhere else breaks both, and a reader who
    /// assumes either one will be quietly wrong. The fraction is a constant of the four
    /// wavelengths alone -- the same for every material and every dispersion, as the second
    /// half of this test checks -- so pinning it also pins the three constants against a
    /// silent edit.
    #[test]
    fn traced_spread_is_a_fixed_fraction_of_the_quoted_dispersion() {
        let mut params = RenderParams::default();

        params.refractive_index = 2.0;
        params.dispersion = 0.06;

        let indices = params.spectral_indices();

        assert!(
            ((indices.z - indices.x) / 0.06 - 0.690430).abs() < 1e-4,
            "traced spread should be 0.690430 of the quoted dispersion, got {}",
            (indices.z - indices.x) / 0.06
        );
        assert!(
            indices.y > 2.0 + 1e-4,
            "green traces 520 nm, which refracts harder than the 589.3 nm D line the index is \
             quoted at, so it must sit above the nominal index; got {}",
            indices.y
        );

        // The fraction is a property of the wavelengths, not of the material: a stone with
        // four times the dispersion and a different index must give the same ratio.
        params.refractive_index = 2.85;
        params.dispersion = 0.28;

        let hanabi = params.spectral_indices();

        assert!(
            ((hanabi.z - hanabi.x) / 0.28 - 0.690430).abs() < 1e-4,
            "the fraction must not depend on the material, got {}",
            (hanabi.z - hanabi.x) / 0.28
        );
    }

    /// The three indices are not evenly spaced, and a regression to a symmetric
    /// `n_d +/- dispersion / 2` split must not pass unnoticed.
    ///
    /// Setup: Hanabi's material, n_d 2.85 and dispersion 0.28, where the skew is largest.
    ///
    /// Test: the ratio of the blue-to-green gap to the green-to-red gap is far from 1.
    ///
    /// **This is a ratio, and deliberately direction-agnostic, because both facts an earlier
    /// version asserted have since flipped.** That version checked `blue_to_green >
    /// green_to_red` and `|blue_to_green - 0.14| > 0.05`, reading the skew off absolute
    /// numbers while red and blue sat on the B and G lines. Sampling 675 / 520 / 474 nm puts
    /// green *nearer blue than red* -- the gap ratio is 0.5006, the reverse of the old
    /// ordering -- and would have put `blue_to_green` at 0.0645, passing the second check for
    /// the wrong reason. Neither assertion was wrong when written; both were phrased about a
    /// particular sampling rather than about the property being defended. A symmetric split
    /// gives a ratio of exactly 1.0 by construction, whatever the wavelengths, so this form
    /// cannot be invalidated by re-sampling.
    #[test]
    fn spectral_indices_are_not_symmetric_about_green() {
        let mut params = RenderParams::default();

        params.refractive_index = 2.85;
        params.dispersion = 0.28;

        let indices = params.spectral_indices();
        let green_to_red = indices.y - indices.x;
        let blue_to_green = indices.z - indices.y;
        let skew = blue_to_green / green_to_red;

        assert!(
            (skew - 1.0).abs() > 0.25,
            "the gaps either side of green are too close to equal (green_to_red {}, \
             blue_to_green {}, ratio {}); a symmetric n_d +/- dispersion / 2 split gives \
             exactly 1.0",
            green_to_red,
            blue_to_green,
            skew
        );
    }

    /// With a single spectral sample, dispersion must be disabled entirely, so all
    /// three channels share one index and the stone shows no fire.
    #[test]
    fn single_spectral_sample_disables_dispersion() {
        let mut params = RenderParams::default();

        params.spectral_samples = 1;
        params.dispersion = 0.1;

        let indices = params.spectral_indices();

        assert_eq!(indices.x, indices.y);
        assert_eq!(indices.y, indices.z);
        assert_eq!(indices.x, params.refractive_index);
    }

    /// Clamping must pull an out-of-range refractive index back into the valid
    /// band. A value below 1.0 would make the stone thinner than air and destroy
    /// total internal reflection, which is the entire source of a gem's brilliance.
    #[test]
    fn clamp_forces_refractive_index_to_at_least_one() {
        let mut params = RenderParams::default();

        params.refractive_index = 0.3;
        params.clamp();

        assert!(
            params.refractive_index >= MIN_REFRACTIVE_INDEX,
            "got {}",
            params.refractive_index
        );

        params.refractive_index = 99.0;
        params.clamp();

        assert!(
            params.refractive_index <= MAX_REFRACTIVE_INDEX,
            "got {}",
            params.refractive_index
        );
    }

    /// Dispersion must never be wide enough to drive the red index below 1.0.
    /// With the index sitting at exactly 1.0, no spread at all is permissible,
    /// because any spread would push red under 1.0. The limit applies to the traced
    /// indices (`spectral_indices`), not to the stored dispersion; the next test covers that.
    #[test]
    fn red_index_stays_physical_at_low_refractive_index() {
        let mut params = RenderParams::default();

        params.refractive_index = 1.0;
        params.dispersion = 0.4;
        params.clamp();

        let indices = params.spectral_indices();

        assert!(
            indices.x >= MIN_REFRACTIVE_INDEX - 1e-6,
            "red index fell below 1.0: {:?}",
            indices
        );

        // A moderate index leaves room for a real spread.
        params.refractive_index = 1.5;
        params.dispersion = 0.4;
        params.clamp();

        assert!(
            params.dispersion > 0.0,
            "a mid-range index should still allow dispersion"
        );
        assert!(
            params.spectral_indices().x >= MIN_REFRACTIVE_INDEX - 1e-6,
            "red index fell below 1.0 at index 1.5"
        );
    }

    /// Dragging the refractive index to its minimum and back must not lose the dispersion.
    ///
    /// Setup: the default parameters (cubic zirconia, index 2.16, dispersion 0.060). Test:
    /// set the index to 1.0 and clamp, as the page's slider does, then check the traced
    /// indices; set it back to 2.16 and clamp, then check again. A second pass goes via 1.02.
    ///
    /// Verifies that at 1.0 all three traced indices are 1.0 (no spread can keep red at or
    /// above 1.0), while the stored dispersion is still 0.060, and that back at 2.16 the
    /// traced spread is 0.060 again. Before the fix, `clamp` overwrote the stored value with
    /// the limit, so the round trip via 1.0 came back with dispersion 0 and via 1.02 with
    /// 0.04, for good, while the page kept showing 0.060.
    #[test]
    fn dispersion_survives_dragging_the_refractive_index_to_its_minimum_and_back() {
        for low in [1.0f32, 1.02] {
            let mut params = RenderParams::default();

            params.refractive_index = low;
            params.clamp();

            let at_low = params.spectral_indices();

            assert!(
                at_low.x >= MIN_REFRACTIVE_INDEX - 1e-6,
                "via {}: red index fell below 1.0: {:?}",
                low,
                at_low
            );
            assert!(
                (at_low.z - at_low.x - traced_spread_fraction() * 2.0 * (low - 1.0)).abs() < 1e-5,
                "via {}: the traced spread should be that fraction of the limit 2(n - 1) the \
                 sampling wavelengths span, got {:?}",
                low,
                at_low
            );
            assert!(
                (params.dispersion - 0.060).abs() < 1e-6,
                "via {}: the stored dispersion must be kept, got {}",
                low,
                params.dispersion
            );

            params.refractive_index = 2.16;
            params.clamp();

            let restored = params.spectral_indices();

            assert!(
                (restored.z - restored.x - traced_spread_fraction() * 0.060).abs() < 1e-5,
                "via {}: back at 2.16 the traced spread should match the stored 0.060 again, \
                 got {:?}",
                low,
                restored
            );
        }
    }

    /// Bounce count must be clamped to the shader's compile-time loop bound; a
    /// larger value would be silently ignored by the shader and quietly disagree
    /// with what the UI reports.
    #[test]
    fn clamp_bounds_bounce_count_to_shader_limit() {
        let mut params = RenderParams::default();

        params.max_bounces = 9999;
        params.clamp();

        assert_eq!(params.max_bounces, MAX_BOUNCES);

        params.max_bounces = 0;
        params.clamp();

        assert_eq!(params.max_bounces, MIN_BOUNCES);
    }

    /// Spectral samples must snap to exactly 1 or 3, the only two values the
    /// shader implements.
    #[test]
    fn clamp_snaps_spectral_samples_to_one_or_three() {
        let mut params = RenderParams::default();

        for requested in [0u32, 1, 2, 5, 100] {
            params.spectral_samples = requested;
            params.clamp();

            assert!(
                params.spectral_samples == 1 || params.spectral_samples == 3,
                "requested {} became {}",
                requested,
                params.spectral_samples
            );
        }
    }

    /// Negative absorption would *amplify* light along a path instead of removing
    /// it, so it must be clamped to zero.
    #[test]
    fn clamp_rejects_negative_absorption() {
        let mut params = RenderParams::default();

        params.absorption = Vector3::new(-1.0, -2.0, 0.5);
        params.absorption_scale = -3.0;
        params.clamp();

        let effective = params.effective_absorption();

        assert!(
            effective.x >= 0.0 && effective.y >= 0.0 && effective.z >= 0.0,
            "absorption must be non-negative, got {:?}",
            effective
        );
    }

    /// A picked stone colour comes back out as the same colour, for every preset's colour
    /// and for a spread of picks.
    ///
    /// Setup: the colours the page's stone colour picker could hand over -- every preset's
    /// own `stone_color` (so choosing a preset and then nudging nothing is a no-op), plus a
    /// grid of channel values from nearly black to white. Test: `set_stone_color` each on
    /// fresh parameters, then read `stone_color` back. Verifies the round trip holds to 1e-5
    /// per channel, so the picker never drifts the colour a little each time it re-reads it.
    #[test]
    fn a_picked_stone_colour_round_trips() {
        let mut colors: Vec<Vector3<f32>> = MATERIALS
            .iter()
            .map(|material| RenderParams::from_material(material).stone_color())
            .collect();

        for red in [0.01, 0.25, 0.5, 0.9, 1.0] {
            for green in [0.01, 0.5, 1.0] {
                colors.push(Vector3::new(red, green, 0.7));
            }
        }

        for color in colors {
            let mut params = RenderParams::default();

            params.set_stone_color(color);

            let back = params.stone_color();

            assert!(
                (back - color).amax() < 1e-5,
                "picked {:?}, read back {:?}",
                color,
                back
            );
        }
    }

    /// White is colourless, black is floored rather than infinite, and a pick undoes a
    /// neutralised absorption scale.
    ///
    /// Setup: parameters with amethyst's absorption, neutralised by `analytical` (scale 0),
    /// as the page's Neutralise button leaves them. Test: read the stone colour, pick white,
    /// then pick black, then a colour. Verifies:
    /// - a neutralised stone reads as white, so the picker shows it colourless;
    /// - white sets zero absorption, the same as neutralising;
    /// - black sets `-ln(MIN_STONE_TRANSMITTANCE)` per channel, a finite number;
    /// - a pick after neutralising takes effect, because it resets the scale to 1.
    #[test]
    fn stone_colour_white_is_colourless_and_black_is_finite() {
        let amethyst = material_by_name("amethyst").expect("amethyst is a preset");
        let mut params = RenderParams::from_material(amethyst).analytical();

        assert_eq!(params.stone_color(), Vector3::repeat(1.0), "neutralised reads white");

        params.set_stone_color(Vector3::repeat(1.0));
        assert_eq!(params.effective_absorption(), Vector3::zeros(), "white absorbs nothing");

        params.set_stone_color(Vector3::zeros());
        let black = params.effective_absorption();
        let expected = -MIN_STONE_TRANSMITTANCE.ln();

        assert!(black.iter().all(|channel| channel.is_finite()));
        assert!((black - Vector3::repeat(expected)).amax() < 1e-5, "black {:?}", black);

        params.set_stone_color(Vector3::new(0.5, 0.25, 1.0));
        assert!(
            (params.stone_color() - Vector3::new(0.5, 0.25, 1.0)).amax() < 1e-6,
            "a pick after neutralising must be rendered"
        );
    }

    /// The base colour and the absorption scale are independent: the scale is the stone's
    /// opacity in the page's colour editor, and moving it must not move the colour shown there.
    ///
    /// Setup: parameters given a picked colour with `set_stone_color`, then the scale halved
    /// and zeroed, as the editor's opacity slider does. Test: read `stone_base_color` and
    /// `stone_color` at each scale, then set a new base colour at scale 0. Verifies:
    /// - the base colour is the picked colour at every scale, even 0, where `stone_color`
    ///   is white and could not be turned back into it;
    /// - `stone_color` is the base colour raised to the scale, `exp(-scale * absorption)`;
    /// - `set_stone_base_color` leaves the scale alone, unlike `set_stone_color`, which resets it.
    #[test]
    fn stone_base_colour_is_independent_of_the_absorption_scale() {
        let picked = Vector3::new(0.8, 0.3, 0.55);
        let mut params = RenderParams::default();

        params.set_stone_color(picked);

        for scale in [1.0_f32, 0.5, 0.0] {
            params.absorption_scale = scale;

            assert!(
                (params.stone_base_color() - picked).amax() < 1e-5,
                "base colour moved at scale {scale}: {:?}",
                params.stone_base_color()
            );

            let expected = picked.map(|channel| channel.powf(scale));

            assert!(
                (params.stone_color() - expected).amax() < 1e-5,
                "stone colour at scale {scale}: {:?}, expected {:?}",
                params.stone_color(),
                expected
            );
        }

        let other = Vector3::new(0.2, 0.9, 0.4);

        params.set_stone_base_color(other);
        assert_eq!(params.absorption_scale, 0.0, "setting the base colour keeps the scale");
        assert!((params.stone_base_color() - other).amax() < 1e-5);

        params.set_stone_color(other);
        assert_eq!(params.absorption_scale, 1.0, "set_stone_color still resets the scale");
    }

    /// Every shipped material must have physically sensible constants, so a typo
    /// in the table cannot produce an unrenderable preset.
    #[test]
    fn all_materials_have_physical_constants() {
        assert!(!MATERIALS.is_empty());

        for material in MATERIALS {
            assert!(
                material.refractive_index >= MIN_REFRACTIVE_INDEX
                    && material.refractive_index <= MAX_REFRACTIVE_INDEX,
                "{} has an out-of-range refractive index {}",
                material.name,
                material.refractive_index
            );
            assert!(
                material.dispersion >= 0.0 && material.dispersion <= MAX_DISPERSION,
                "{} has an out-of-range dispersion {}",
                material.name,
                material.dispersion
            );
            assert!(
                material.absorption.iter().all(|c| *c >= 0.0),
                "{} has negative absorption {:?}",
                material.name,
                material.absorption
            );

            // Applying the preset then clamping must not change it, which proves
            // the preset was already inside the valid range.
            let mut params = RenderParams::from_material(material);
            let before = params.clone();

            params.clamp();

            assert_eq!(
                before, params,
                "{} is altered by clamping, so it is not a valid preset",
                material.name
            );
        }
    }

    /// The defaults must reproduce the settings in the Gem Cut Studio reference
    /// screenshots, so a fresh page load is directly comparable with them.
    ///
    /// Setup: `RenderParams::default()`. Verifies the settings visible in
    /// `reference/application_images/hex_cut_v2/hex_cut_v2_gcs_front_random.png`: refractive index 2.16,
    /// dispersion 0.060, a colourless stone, no head shadow, and a 0.35 grey flat background.
    ///
    /// The other values checked come from elsewhere, so here they are only pinned, not
    /// re-derived:
    /// - the bounce count (14) and the window colour are the user's choices;
    /// - the observer radius was measured from the face-up Isometric-with-window and Cosine
    ///   screenshots;
    /// - the out-of-bounces shade was measured from the Isometric-with-window corners.
    ///
    /// Also verifies clamping leaves the defaults alone, so they are valid as well as matching.
    #[test]
    fn defaults_match_the_gem_cut_studio_reference() {
        let default = RenderParams::default();

        assert!((default.refractive_index - 2.16).abs() < 1e-6);
        assert!((default.dispersion - 0.060).abs() < 1e-6);
        assert_eq!(
            default.effective_absorption(),
            Vector3::zeros(),
            "GCS stone colour is white at 100% clarity, so there is no absorption"
        );
        assert_eq!(default.max_bounces, 14, "the user's chosen default bounce count");
        assert_eq!(default.spectral_samples, 3, "GCS renders with dispersion on");
        assert_eq!(default.head_shadow_half_angle, 0.0);
        assert_eq!(
            default.observer_radius, 0.0263,
            "the observer is on by default, sized from the GCS face-up centre dot"
        );
        assert!(default.use_background_color, "GCS draws a flat background");
        assert!(!default.use_window_color, "GCS leaves the separate window colour off");

        // The page shows the window colour as 8-bit channels (its colour picker is
        // '#rrggbb'), so the user's chosen default must come back as exactly those bytes.
        let window_bytes = default.window_color.map(|channel| (channel * 255.0).round() as u8);

        assert_eq!(
            (window_bytes.x, window_bytes.y, window_bytes.z),
            (202, 0, 253),
            "the user's chosen default window colour"
        );
        assert!(default.lighting_follows_view, "GCS rotates the stone under fixed lights");
        assert_eq!(
            default.exhaustion_shade, 0.5,
            "GCS fills paths that run out of bounces with a half tint of the stone colour"
        );
        assert_eq!(default.background_color, Vector3::repeat(0.35));

        let mut clamped = default.clone();

        clamped.clamp();

        assert_eq!(clamped, default, "the defaults must already be in range");
    }

    /// Diamond must disperse noticeably more than glass; that contrast is the point of
    /// the preset list.
    #[test]
    fn diamond_disperses_more_than_glass() {
        let diamond = material_by_name("diamond").expect("diamond must be a preset");
        let glass = material_by_name("glass").expect("glass must be a preset");

        assert!(
            diamond.dispersion > glass.dispersion * 3.0,
            "diamond ({}) should disperse far more than glass ({})",
            diamond.dispersion,
            glass.dispersion
        );
    }

    /// The preset table must list every material the user asked for, once each, in order of
    /// refractive index.
    ///
    /// Setup: the names requested on 2026-09-15 (T-0042), plus glass, which was already a
    /// preset. Test: look each one up, compare every pair of names case-insensitively, and
    /// walk the table checking the index never decreases.
    ///
    /// Verifies no requested material is missing or misspelt, `material_by_name` cannot be
    /// ambiguous (it returns the first match, so a duplicate would hide the second entry),
    /// and the page's menu, which lists the table as it stands, runs from the least to the
    /// most refractive stone.
    #[test]
    fn material_table_is_complete_unique_and_ordered_by_refractive_index() {
        let requested = [
            "Fluorite", "Opal", "Glass", "Quartz", "Amethyst", "Citrine", "Smoky quartz",
            "Emerald", "Aquamarine", "Topaz", "Tourmaline", "Dioptase", "Peridot", "Tanzanite",
            "Spinel", "Pyrope", "Tsavorite", "Hessonite", "Rhodolite", "Spessartine", "Demantoid",
            "Sapphire", "Ruby", "Zircon", "Cubic zirconia", "Diamond", "Moissanite", "Rutile",
            "YAG",
        ];

        for name in requested {
            assert!(material_by_name(name).is_some(), "{} must be a preset", name);
        }

        assert_eq!(MATERIALS.len(), requested.len(), "no presets beyond the requested ones");

        for (i, first) in MATERIALS.iter().enumerate() {
            for second in &MATERIALS[i + 1..] {
                assert!(
                    !first.name.eq_ignore_ascii_case(second.name),
                    "{} is listed twice",
                    first.name
                );
            }
        }

        for pair in MATERIALS.windows(2) {
            assert!(
                pair[0].refractive_index <= pair[1].refractive_index,
                "{} ({}) is listed before the less refractive {} ({})",
                pair[0].name,
                pair[0].refractive_index,
                pair[1].name,
                pair[1].refractive_index
            );
        }
    }

    /// The page's sliders must be able to show every preset without pinning at an end.
    ///
    /// Setup: the `min`/`max` of the `refractiveIndex` and `dispersion` sliders, read from the
    /// source text of the page's slider table (`SLIDER_SPECS` in
    /// `web/src/lib/panel_config.js`, which the Svelte components draw every range input from).
    /// Test: check every preset's index and dispersion lies inside them.
    ///
    /// Verifies that picking, say, rutile (dispersion 0.280) moves the dispersion slider to
    /// its value rather than leaving it stuck at the end while the readout shows something
    /// else. That table is the only place these ranges are written down.
    #[test]
    fn page_sliders_cover_every_preset() {
        let page = include_str!("../web/src/lib/panel_config.js");
        let table = &page[page
            .find("export const SLIDER_SPECS")
            .expect("panel_config.js has no SLIDER_SPECS")..];

        // Returns the named field of the slider with this id, as a number: the `min` of
        // `  dispersion: { min: 0, max: 0.3, step: 0.001 },`.
        let attribute = |id: &str, name: &str| -> f32 {
            let start = table
                .find(&format!("\n  {}: {{", id))
                .unwrap_or_else(|| panic!("SLIDER_SPECS has no {}", id));
            let entry = &table[start..start + table[start..].find('}').unwrap()];
            let value_start = entry
                .find(&format!("{}: ", name))
                .unwrap_or_else(|| panic!("{} has no {} in SLIDER_SPECS", id, name))
                + name.len()
                + 2;
            let value_end = entry[value_start..]
                .find(|c| c == ',' || c == ' ')
                .map_or(entry.len(), |end| value_start + end);

            entry[value_start..value_end].parse().unwrap()
        };

        for material in MATERIALS {
            for (id, value) in [
                ("refractiveIndex", material.refractive_index),
                ("dispersion", material.dispersion),
            ] {
                assert!(
                    value >= attribute(id, "min") && value <= attribute(id, "max"),
                    "{}'s {} of {} is outside the page slider's range",
                    material.name,
                    id,
                    value
                );
            }
        }
    }

    /// Material lookup must be case-insensitive and must reject unknown names
    /// rather than silently returning a default.
    #[test]
    fn material_lookup_is_case_insensitive_and_rejects_unknown_names() {
        assert!(material_by_name("DIAMOND").is_some());
        assert!(material_by_name("diamond").is_some());
        assert!(material_by_name("Cubic Zirconia").is_some());
        assert!(material_by_name("unobtainium").is_none());
    }

    /// Applying a material must replace the optical constants but preserve the
    /// rendering settings, so switching stones does not reset the user's camera
    /// exposure or debug view.
    #[test]
    fn applying_a_material_preserves_render_settings() {
        let mut params = RenderParams::default();

        params.exposure = 4.0;
        params.max_bounces = 20;
        params.debug_mode = DebugMode::FacetId;

        let sapphire = material_by_name("sapphire").expect("sapphire must be a preset");

        params.apply_material(sapphire);

        assert!((params.refractive_index - sapphire.refractive_index).abs() < 1e-6);
        assert_eq!(params.exposure, 4.0, "exposure must be preserved");
        assert_eq!(params.max_bounces, 20, "bounce count must be preserved");
        assert_eq!(params.debug_mode, DebugMode::FacetId);
    }

    /// Draft mode must never cost more than full quality, at *any* bounce setting or
    /// *any* quality-while-dragging fraction.
    ///
    /// This is a regression test for a real bug: the reduction used to be a fixed
    /// `(max_bounces / 2).max(4)`, which raises the bounce count whenever the user
    /// has set it below 8. At `max_bounces = 1`, full quality costs 1 bounce x 3
    /// spectral samples = 3 interior events, while the draft cost 4 bounces x 1
    /// sample = 4. Dragging the view then got *slower* and perturbed the image more
    /// than necessary, which is the exact opposite of the intent. The quality
    /// argument replaced the fixed halving, so this now sweeps quality too: a linear
    /// multiply by a fraction clamped to at most 1 cannot reproduce that bug, but the
    /// test is kept exhaustive over quality anyway since it is cheap to run.
    #[test]
    fn draft_is_never_more_expensive_than_full_quality() {
        for bounces in MIN_BOUNCES..=MAX_BOUNCES {
            for samples in [1u32, 3] {
                // 1.5 is out of range on purpose: `draft` clamps it to 1, so it must behave
                // exactly like 1.0 rather than ever raising the bounce count above the
                // configured value.
                for quality in [0.0, 0.15, 0.4, 0.5, 0.99, 1.0, 1.5] {
                    let mut full = RenderParams::default();

                    full.max_bounces = bounces;
                    full.spectral_samples = samples;
                    full.clamp();

                    let draft = full.draft(quality);

                    assert!(
                        draft.worst_case_interior_events() <= full.worst_case_interior_events(),
                        "draft is more expensive than full quality at {} bounces / {} \
                         samples / {} quality: draft costs {} interior events ({} bounces x \
                         {} samples), full costs {}",
                        bounces,
                        samples,
                        quality,
                        draft.worst_case_interior_events(),
                        draft.max_bounces,
                        draft.spectral_samples,
                        full.worst_case_interior_events()
                    );
                }
            }
        }
    }

    /// Draft mode must **preserve** dispersion.
    ///
    /// Regression test for a design mistake: draft mode used to set
    /// `spectral_samples = 1`, so fire vanished the instant the user started rotating
    /// the stone. That is the one effect a person moves a gem in order to see, so it
    /// is the one thing that must survive the motion. Resolution is given up instead,
    /// which saves more and is far less noticeable while moving.
    #[test]
    fn draft_preserves_dispersion() {
        let mut params = RenderParams::default();

        params.spectral_samples = 3;
        params.clamp();

        // The quality argument only touches the bounce count; any value proves the point here.
        let draft = params.draft(0.5);

        assert_eq!(
            draft.spectral_samples, 3,
            "draft mode must keep dispersion; fire is what rotating a stone reveals"
        );
    }

    /// Draft mode scales the bounce count by the "drag quality" fraction,
    /// linearly, floors it at 3 so a low-quality drag still looks like glass rather
    /// than a flat shade, and must never exceed the configured value even so.
    ///
    /// Setup: a stone set to 20 bounces. Test: draft it at a handful of quality
    /// fractions, including the two ends of the range and a value above and below it
    /// (the slider itself is clamped to 0.15-1, but `draft` must not trust that -- a
    /// stray console call or a future slider range change should not be able to raise
    /// the bounce count above what the user configured). Verifies the multiply is
    /// exact where it divides evenly and lands at or above the floor (quality 1, 0.5,
    /// 0.25), rounds sensibly where it does not (0.4 of 20 is 8), is clamped to the
    /// configured value at quality > 1, and floors at 3 at quality 0. Then, the
    /// remaining edge of the floor: at exactly 3 configured bounces (`MIN_BOUNCES`,
    /// since 2026-09-22 -- the floor `draft` applies while dragging is now also the
    /// slider's own minimum, so 3 is the lowest configured value that can actually
    /// reach this function), the floor and the configured value coincide at every
    /// quality, never exceeding 3.
    #[test]
    fn draft_scales_bounce_count_linearly_with_quality() {
        let mut params = RenderParams::default();

        params.max_bounces = 20;
        params.clamp();

        assert_eq!(params.draft(1.0).max_bounces, 20, "100% quality must not reduce bounces");
        assert_eq!(params.draft(0.5).max_bounces, 10, "50% quality should halve 20 to 10");
        assert_eq!(params.draft(0.25).max_bounces, 5, "25% quality should quarter 20 to 5");
        assert_eq!(params.draft(0.4).max_bounces, 8, "40% of 20 is 8");
        assert_eq!(
            params.draft(1.5).max_bounces, 20,
            "a quality above 1 must clamp to 1, not raise bounces past the configured value"
        );
        assert_eq!(
            params.draft(0.15).max_bounces, 3,
            "15% of 20 is 3, exactly the floor -- must not go any lower"
        );
        assert_eq!(
            params.draft(0.0).max_bounces, 3,
            "0% quality must floor at 3 rather than reach 0"
        );

        // At MIN_BOUNCES itself (3), the floor and the configured value are the same
        // number, at every quality fraction (which can only shrink the multiply further,
        // being clamped to at most 1 before it is applied) -- so this must never move.
        params.max_bounces = MIN_BOUNCES;
        assert_eq!(MIN_BOUNCES, 3, "this test's premise: the floor is also the slider's min");

        for tenth in 0..=15 {
            let quality = tenth as f32 / 10.0;

            assert_eq!(
                params.draft(quality).max_bounces, MIN_BOUNCES,
                "quality {} moved bounces away from the floor at the lowest configured value",
                quality
            );
        }
    }

    /// Draft mode must leave the user's own settings untouched, so leaving draft mode
    /// restores exactly what was configured.
    #[test]
    fn draft_does_not_mutate_the_original_parameters() {
        let mut params = RenderParams::default();

        params.max_bounces = 24;
        params.spectral_samples = 3;
        params.exposure = 2.5;

        let before = params.clone();
        let _ = params.draft(0.5);

        assert_eq!(params, before, "draft() must not modify its receiver");
    }

    /// The lighting model and tone map encodings must round-trip, since both cross into
    /// the page and the shader as bare integers, and each model must be paired with the
    /// display transfer that keeps its output meaningful.
    ///
    /// Verifies every model and mode survives encoding, unknown values fall back to the
    /// studio rig and the filmic curve, the image environment is neither analytical nor
    /// filmic, and the analytical models keep their linear transfer.
    #[test]
    fn lighting_model_and_tone_map_encodings_round_trip_and_pair_correctly() {
        for model in LightingModel::all() {
            assert_eq!(LightingModel::from_u32(model.as_u32()), model);
        }

        for mode in [ToneMapMode::Filmic, ToneMapMode::Linear, ToneMapMode::Gamma] {
            assert_eq!(ToneMapMode::from_u32(mode.as_u32()), mode);
        }

        assert_eq!(LightingModel::from_u32(999), LightingModel::Studio);
        assert_eq!(ToneMapMode::from_u32(999), ToneMapMode::Filmic);

        assert!(!LightingModel::Image.is_analytical());
        assert_eq!(LightingModel::Image.tone_map_mode(), ToneMapMode::Gamma);
        assert_eq!(LightingModel::Studio.tone_map_mode(), ToneMapMode::Filmic);

        for model in [LightingModel::AngleRings, LightingModel::Isometric, LightingModel::Cosine] {
            assert!(model.is_analytical());
            assert_eq!(model.tone_map_mode(), ToneMapMode::Linear);
        }
    }

    /// Decoding a picked colour and then tone mapping it must display the colour that
    /// was picked, for every transfer and exposure.
    ///
    /// Setup: every 8-bit display value, three exposures, all three transfers. Test:
    /// `encode(decode(value))`. Verifies the round trip within 1/1000. The worst case is
    /// pure white through the filmic curve, which is capped just below 1. This is what
    /// makes the head shadow and window colours appear as picked, rather than dimmed to 73%
    /// by the filmic curve or brightened by the gamma transfer.
    #[test]
    fn decoding_a_picked_colour_then_tone_mapping_it_returns_the_same_colour() {
        for mode in [ToneMapMode::Filmic, ToneMapMode::Linear, ToneMapMode::Gamma] {
            for exposure in [0.5f32, 1.0, 2.5] {
                for byte in 0..=255u8 {
                    let display = byte as f32 / 255.0;
                    let round_trip = mode.encode(mode.decode(display, exposure), exposure);

                    assert!(
                        (round_trip - display).abs() < 1e-3,
                        "{:?} at exposure {}: {} came back as {}",
                        mode,
                        exposure,
                        display,
                        round_trip
                    );
                }
            }

            assert_eq!(mode.decode(0.0, 1.0), 0.0, "black must decode to no light at all");
        }
    }

    /// The shader's copies of the display transfers must agree with the Rust ones on the
    /// constants the round trip depends on.
    ///
    /// Checked against the shader source text, because nothing else connects the two
    /// languages and a mismatch would only show as picked colours rendering slightly off.
    #[test]
    fn shader_declares_the_filmic_decode_ceiling_used_here() {
        let shader = include_str!("shaders/gem.frag");

        assert!(
            shader.contains(&format!(
                "const float FILMIC_DECODE_CEILING = {};",
                FILMIC_DECODE_CEILING
            )),
            "gem.frag must declare FILMIC_DECODE_CEILING = {}",
            FILMIC_DECODE_CEILING
        );
        assert!(shader.contains("vec3 displayToRadiance(vec3 display)"));
    }

    /// The shader's unpolarised Fresnel reflectance, for an interface with index ratio `eta`
    /// (from the medium the ray is in to the one it is entering) at incidence cosine
    /// `cos_incident`.
    ///
    /// A line-for-line copy of `fresnelReflectance` in `gem.frag`. It exists only so the two
    /// tests below can do arithmetic on the same function the shader uses; nothing in the
    /// renderer calls it, because the reflectance is only ever needed on the GPU.
    /// `shader_evaluates_the_entry_reflectance_per_channel` checks the shader still spells the
    /// expressions exactly this way, which is what stops this copy drifting away from it.
    fn fresnel_reflectance(cos_incident: f32, eta: f32) -> f32 {
        let sin_transmitted_squared = eta * eta * (1.0 - cos_incident * cos_incident);

        // Past the critical angle there is no transmitted ray: everything reflects.
        if sin_transmitted_squared >= 1.0 {
            return 1.0;
        }

        let cos_transmitted = (1.0 - sin_transmitted_squared).sqrt();

        let perpendicular =
            (eta * cos_incident - cos_transmitted) / (eta * cos_incident + cos_transmitted);
        let parallel =
            (cos_incident - eta * cos_transmitted) / (cos_incident + eta * cos_transmitted);

        0.5 * (perpendicular * perpendicular + parallel * parallel)
    }

    /// At the entry surface, what reflects plus what is admitted must be exactly 1 in every
    /// channel, for a dispersive material as well as a non-dispersive one.
    ///
    /// Setup: the two halves of the split that `gem.frag`'s `main` makes at the entry facet.
    /// - reflected: the surface highlight, `fresnelReflectance(cosEntry, 1.0 / n_channel)`,
    ///   which since T-0071 is evaluated once per channel from that channel's own index;
    /// - transmitted: what `traceInterior` admits, `1.0 - fresnelReflectance(cosEntry,
    ///   1.0 / refractiveIndex)`, with `refractiveIndex` the index of the pass that carries the
    ///   channel.
    ///
    /// Both are computed here from `spectral_indices()`, the vector that becomes `uSpectralIor`,
    /// at incidence angles from normal out to grazing.
    ///
    /// Test and what it verifies:
    /// - **dispersive** (rutile, the widest spread in the table, and the default cubic zirconia):
    ///   each channel's own index is used on both sides, so every channel sums to 1;
    /// - **the bug this replaces**: the same sum with one shared reflectance taken at the green
    ///   index, as the shader used to compute it, is checked to be *wrong* by more than 1.8% in
    ///   red and blue for rutile and 0.4% for cubic zirconia. Without this the test would pass
    ///   just as happily against the broken code, since `1 - R` sums to 1 for any `R` at all;
    /// - **mono** (`spectral_samples = 1`): `spectral_indices` returns three equal indices, so
    ///   the highlight's three channels and the single all-channel interior pass, which the
    ///   shader dispatches at the mid-band index, agree and again sum to 1. The two modes have
    ///   to be consistent with each other, or toggling dispersion would move the surface
    ///   highlight for a reason that has nothing to do with dispersion.
    #[test]
    fn entry_reflectance_and_transmittance_sum_to_one_per_channel() {
        // Normal incidence out to near-grazing. The error the fix removes is near-constant from
        // 0 to 60 degrees and only dies off past about 80, so the shallow angles are where it
        // matters and the steep ones only confirm nothing new breaks there.
        let angles = [0.0f32, 10.0, 20.0, 30.0, 45.0, 60.0, 75.0, 85.0];

        for name in ["Rutile", "Cubic zirconia"] {
            let material = material_by_name(name).expect("must be a preset");
            let mut params = RenderParams::from_material(material);

            params.spectral_samples = 3;
            params.clamp();

            let indices = params.spectral_indices();

            assert!(
                indices.z - indices.x > 0.0,
                "setup: {} must actually disperse, got {:?}",
                name,
                indices
            );

            let mut worst_shared_error = 0.0f32;

            for degrees in angles {
                let cos_entry = degrees.to_radians().cos();

                // What the old code applied to all three channels.
                let shared = fresnel_reflectance(cos_entry, 1.0 / indices.y);

                for (channel, index) in ["red", "green", "blue"].iter().zip(indices.iter()) {
                    let reflected = fresnel_reflectance(cos_entry, 1.0 / index);
                    let transmitted = 1.0 - fresnel_reflectance(cos_entry, 1.0 / index);

                    // Exact in real arithmetic, since both come from the same evaluation; the
                    // tolerance is one f32 ulp at 1.0 (2^-23), which the subtraction can cost.
                    assert!(
                        (reflected + transmitted - 1.0).abs() <= f32::EPSILON,
                        "{} at {} degrees, {}: reflected {} plus transmitted {} is not 1",
                        name,
                        degrees,
                        channel,
                        reflected,
                        transmitted
                    );

                    worst_shared_error =
                        worst_shared_error.max((shared + transmitted - 1.0).abs());
                }
            }

            // The margin the fix recovers, and proof the assertion above is not vacuous.
            //
            // These bounds are sized against the *traced* spread, not the quoted dispersion,
            // so they move whenever the sampling wavelengths do. They were 0.018 / 0.004 when
            // red and blue sat on the B and G lines and the spread was the full dispersion;
            // the fitted sampling narrows it to 0.690 of that, which takes Rutile's worst case
            // to 0.0170 and cubic zirconia's to about 0.0041. Lowered to keep a margin without
            // making the check vacuous -- if a future sampling narrows the spread much
            // further, this test stops discriminating and needs rethinking, not re-lowering.
            let expected = if name == "Rutile" { 0.012 } else { 0.003 };

            assert!(
                worst_shared_error > expected,
                "{}: a single green-index reflectance should break the sum by more than {}, \
                 but the worst error found was only {}; if this is now small the test can no \
                 longer tell the fix from the bug",
                name,
                expected,
                worst_shared_error
            );
        }

        // Mono: one interior pass at the mid-band index carries all three channels, so the
        // highlight must use that same index in all three.
        let mut mono = RenderParams::from_material(
            material_by_name("Rutile").expect("must be a preset"),
        );

        mono.spectral_samples = 1;
        mono.clamp();

        let mono_indices = mono.spectral_indices();

        assert_eq!(
            (mono_indices.x, mono_indices.z),
            (mono_indices.y, mono_indices.y),
            "with one spectral sample every channel must trace the mid-band index"
        );

        for degrees in angles {
            let cos_entry = degrees.to_radians().cos();
            let transmitted = 1.0 - fresnel_reflectance(cos_entry, 1.0 / mono_indices.y);

            for index in mono_indices.iter() {
                let reflected = fresnel_reflectance(cos_entry, 1.0 / index);

                assert!(
                    (reflected + transmitted - 1.0).abs() <= f32::EPSILON,
                    "mono at {} degrees: reflected {} plus transmitted {} is not 1",
                    degrees,
                    reflected,
                    transmitted
                );
            }
        }
    }

    /// The shader must evaluate the entry surface highlight per channel, from the same indices
    /// the interior passes use.
    ///
    /// Checked against the shader source text, because nothing else connects the two languages:
    /// no test compiles or runs `gem.frag`, so the arithmetic above is only about this renderer
    /// if the shader still spells it this way.
    ///
    /// Verifies:
    /// - `fresnelReflectance` is still the function the mirror above copies, expression by
    ///   expression, so the sums in that test are the shader's sums;
    /// - the highlight is a `vec3` built from all three of the traced indices, not one scalar,
    ///   and no eta in `main` is taken straight from `uSpectralIor`;
    /// - the traced indices come from `uSpectralSamples`, collapsing to the mid-band index when
    ///   dispersion is off, which is the pass structure the mono half of that test assumes;
    /// - `traceInterior` still admits `channelMask * (1.0 - entryReflectance)` from
    ///   `1.0 / refractiveIndex`, the other half of the identity;
    /// - the comment that claimed the shared evaluation "saves two of the three interior
    ///   traces' worth of work" is gone. It saved two Fresnel evaluations, not two traces: the
    ///   three traces below it were always dispatched, and the highlight is outside them.
    #[test]
    fn shader_evaluates_the_entry_reflectance_per_channel() {
        let shader = include_str!("shaders/gem.frag");

        for expression in [
            "float sinTransmittedSquared = eta * eta * (1.0 - cosIncident * cosIncident);",
            "(eta * cosIncident - cosTransmitted) / (eta * cosIncident + cosTransmitted);",
            "(cosIncident - eta * cosTransmitted) / (cosIncident + eta * cosTransmitted);",
            "return 0.5 * (perpendicular * perpendicular + parallel * parallel);",
        ] {
            assert!(
                shader.contains(expression),
                "fresnelReflectance in gem.frag must still compute `{}`, or the Rust mirror in \
                 this module no longer describes it",
                expression
            );
        }

        assert!(
            shader.contains("vec3 entryIndices = uSpectralSamples <= 1 ? vec3(uSpectralIor.y) : uSpectralIor;"),
            "main must derive the traced indices once, collapsing to the mid-band index when \
             dispersion is off"
        );

        for component in ["x", "y", "z"] {
            assert!(
                shader.contains(&format!(
                    "fresnelReflectance(cosEntry, 1.0 / entryIndices.{})",
                    component
                )),
                "the surface highlight must be evaluated at entryIndices.{}",
                component
            );
        }

        assert!(
            shader.contains("vec3 surfaceReflectance = vec3("),
            "the surface highlight must be a vec3, one reflectance per channel"
        );
        assert!(
            !shader.contains("float surfaceReflectance"),
            "the surface highlight must not be a single scalar shared by all three channels"
        );
        assert!(
            !shader.contains("1.0 / uSpectralIor."),
            "main must build its etas from entryIndices, not from uSpectralIor directly"
        );

        for (component, mask) in [
            ("x", "vec3(1.0, 0.0, 0.0)"),
            ("y", "vec3(0.0, 1.0, 0.0)"),
            ("z", "vec3(0.0, 0.0, 1.0)"),
        ] {
            assert!(
                shader.contains(&format!("entryIndices.{}, {}", component, mask)),
                "the {} interior pass must trace entryIndices.{}, the index its highlight used",
                mask,
                component
            );
        }

        assert!(
            shader.contains("entryIndices.y, vec3(1.0), bounces"),
            "the no-dispersion pass must trace entryIndices.y for all three channels"
        );

        assert!(
            shader.contains("float entryReflectance = fresnelReflectance(cosEntry, etaEntering);")
                && shader.contains("float etaEntering = 1.0 / refractiveIndex;")
                && shader.contains("vec3 throughput = channelMask * (1.0 - entryReflectance);"),
            "traceInterior must still admit 1 - fresnelReflectance(cosEntry, 1 / n) per channel"
        );

        assert!(
            !shader.contains("interior traces' worth of work"),
            "the comment claiming a shared reflectance saves two interior traces is wrong: it \
             saved two Fresnel evaluations"
        );
    }

    /// The out-of-bounces fill is a **decoded display shade** multiplied by a **linear**
    /// transmittance, and that distinction has to survive every display transfer.
    ///
    /// Setup: the fill `traceInterior` adds when a path runs out of bounces, written both ways,
    /// per channel, at unit remaining throughput:
    /// - `fixed`, what the shader now computes:
    ///   `displayToRadiance(vec3(uExhaustionShade)) * exp(-uAbsorption)`;
    /// - `decoded_product`, what it computed before T-0072:
    ///   `displayToRadiance(uExhaustionShade * exp(-uAbsorption))`.
    ///
    /// The material is amethyst, absorption (0.35, 0.80, 0.20), at the default half shade. It is
    /// a shipped preset, so this is a case a user reaches by picking a stone from the menu.
    ///
    /// Test and what it verifies:
    /// - **the tint is the stone's own transmittance, under all three transfers.** The shade is
    ///   a scalar, so the fill's colour must be exactly the ratio of `exp(-absorption)` between
    ///   channels -- `exp(0.45) = 1.568` red over green and `exp(0.60) = 1.822` blue over green
    ///   -- whatever transfer is loaded and whatever the shade and exposure are. That is the
    ///   whole content of "a tint of the gem colour": deeply trapped light must not read as a
    ///   different hue from the stone's own body colour;
    /// - **the bug this replaces.** Decoding the product instead gamma-raises the transmittance,
    ///   so its tint is `exp(-absorption)^2.2` under the gamma transfer and worse still under
    ///   the filmic one. The old form is checked to be *wrong*: 2.881 : 1 : 4.191 under filmic
    ///   (nearly double the saturation) and 2.691 : 1 : 3.743 under gamma. Without this the
    ///   first check would pass against the broken code under TONEMAP_LINEAR alone;
    /// - **why it survived.** Under `Linear` decode is itself linear, so `decode(s * T)` and
    ///   `decode(s) * T` are the same expression. The analytical models -- the only ones the
    ///   GCS comparison views use -- are paired with exactly that transfer;
    /// - **the colourless stone is bit-identical.** With zero absorption `exp(-0.0)` is exactly
    ///   1.0, so the two forms agree bit for bit at every transfer and exposure. This is the
    ///   load-bearing case: the GCS-validated Isometric corner value, `0.5 * 0.8652 + 0.1348 =
    ///   0.5674` or 144.7/255 (kb/out-of-bounces-shade.md), is reproduced here from both forms
    ///   and must come out identical.
    #[test]
    fn the_out_of_bounces_fill_tints_a_decoded_shade_with_a_linear_transmittance() {
        let amethyst = material_by_name("Amethyst").expect("amethyst must be a preset");
        let absorption = amethyst.absorption;

        assert_eq!(
            (absorption.x, absorption.y, absorption.z),
            (0.35, 0.8, 0.2),
            "setup: this test's expected numbers are for amethyst's absorption"
        );

        let shade = RenderParams::default().exhaustion_shade;

        assert_eq!(shade, 0.5, "setup: the fill is GCS's measured half tint");

        // The stone's transmittance over a unit distance: a linear multiplier on radiance,
        // exactly like the exp(-absorption * t) the march applies at every segment.
        let transmittance = absorption.map(|a| (-a).exp());

        // The two forms of the fill, per channel, at unit remaining throughput.
        let fixed = |mode: ToneMapMode, exposure: f32| {
            transmittance.map(|t| mode.decode(shade, exposure) * t)
        };
        let decoded_product =
            |mode: ToneMapMode, exposure: f32| transmittance.map(|t| mode.decode(shade * t, exposure));

        // The tint the stone actually has: exp(0.80 - 0.35) and exp(0.80 - 0.20).
        let expected_red_over_green = (absorption.y - absorption.x).exp();
        let expected_blue_over_green = (absorption.y - absorption.z).exp();

        assert!(
            (expected_red_over_green - 1.5683).abs() < 1e-3
                && (expected_blue_over_green - 1.8221).abs() < 1e-3,
            "setup: amethyst's unit-distance tint should be 1.568 : 1 : 1.822, got {} : 1 : {}",
            expected_red_over_green,
            expected_blue_over_green
        );

        for mode in [ToneMapMode::Filmic, ToneMapMode::Linear, ToneMapMode::Gamma] {
            for exposure in [0.5f32, 1.0, 2.5] {
                let fill = fixed(mode, exposure);

                assert!(
                    (fill.x / fill.y - expected_red_over_green).abs() < 1e-3
                        && (fill.z / fill.y - expected_blue_over_green).abs() < 1e-3,
                    "{:?} at exposure {}: the fill's tint must be the stone's own \
                     transmittance ratio {} : 1 : {}, got {} : 1 : {}",
                    mode,
                    exposure,
                    expected_red_over_green,
                    expected_blue_over_green,
                    fill.x / fill.y,
                    fill.z / fill.y
                );
            }
        }

        // The old form, channel by channel, against the numbers reported in T-0072. Under the
        // two gamma-bearing transfers it is a different colour, not merely a different
        // brightness; under the linear one it is the same expression, which is why no
        // analytical render could ever have caught this.
        for (mode, red_over_green, blue_over_green) in [
            (ToneMapMode::Filmic, 2.881f32, 4.191f32),
            (ToneMapMode::Gamma, 2.691, 3.743),
            (ToneMapMode::Linear, expected_red_over_green, expected_blue_over_green),
        ] {
            let old = decoded_product(mode, 1.0);

            assert!(
                (old.x / old.y - red_over_green).abs() < 1e-3
                    && (old.z / old.y - blue_over_green).abs() < 1e-3,
                "{:?}: decoding the product should give {} : 1 : {}, got {} : 1 : {}",
                mode,
                red_over_green,
                blue_over_green,
                old.x / old.y,
                old.z / old.y
            );

            if mode == ToneMapMode::Linear {
                // Identical expressions here, to the last bit.
                assert_eq!(
                    fixed(mode, 1.0),
                    old,
                    "under a linear transfer the two forms must be the same expression"
                );
            } else {
                // The margin the fix recovers, and proof the tint check above is not vacuous:
                // the old form's saturation is out by at least 1.1 in red and 1.9 in blue.
                assert!(
                    old.x / old.y - expected_red_over_green > 1.1
                        && old.z / old.y - expected_blue_over_green > 1.9,
                    "{:?}: the old form should be visibly over-saturated, but its tint {} : 1 : \
                     {} is close to the correct {} : 1 : {}; if this is now small the test can \
                     no longer tell the fix from the bug",
                    mode,
                    old.x / old.y,
                    old.z / old.y,
                    expected_red_over_green,
                    expected_blue_over_green
                );

                // And it is visibly darker as well, once displayed: 12 to 37 levels of 255
                // (filmic 22.3 / 36.6 / 14.2 red, green, blue; gamma 18.9 / 31.3 / 12.0).
                for (channel, new_value, old_value) in [
                    ("red", fixed(mode, 1.0).x, old.x),
                    ("green", fixed(mode, 1.0).y, old.y),
                    ("blue", fixed(mode, 1.0).z, old.z),
                ] {
                    let levels = (mode.encode(new_value, 1.0) - mode.encode(old_value, 1.0)) * 255.0;

                    assert!(
                        levels > 11.0,
                        "{:?}, {}: the fix should brighten the fill by more than 11 levels of \
                         255, got {}",
                        mode,
                        channel,
                        levels
                    );
                }
            }
        }

        // A colourless stone -- the GCS reference material, and every comparison view -- must be
        // untouched, bit for bit, by the change.
        let colourless = Vector3::<f32>::zeros().map(|a| (-a).exp());

        assert_eq!(
            (colourless.x, colourless.y, colourless.z),
            (1.0, 1.0, 1.0),
            "exp(-0) must be exactly 1.0, or the fix would move the validated case"
        );

        for mode in [ToneMapMode::Filmic, ToneMapMode::Linear, ToneMapMode::Gamma] {
            for exposure in [0.5f32, 1.0, 2.5] {
                for shade in [0.0f32, 0.25, 0.5, 1.0] {
                    let fill = mode.decode(shade, exposure) * 1.0;
                    let old = mode.decode(shade * 1.0, exposure);

                    assert_eq!(
                        fill.to_bits(),
                        old.to_bits(),
                        "{:?} at exposure {}, shade {}: a colourless stone must fill identically \
                         either way",
                        mode,
                        exposure,
                        shade
                    );
                }
            }
        }

        // The measured GCS corner: a fully trapped path filled at half, admitted through the
        // crown, plus the crown's own normal-incidence reflection. Reproduced from both forms.
        let reflectance = ((2.16f32 - 1.0) / (2.16 + 1.0)).powi(2);
        let mode = LightingModel::Isometric.tone_map_mode();

        assert_eq!(mode, ToneMapMode::Linear, "the GCS corner was measured under Isometric");

        for fill in [mode.decode(0.5, 1.0) * 1.0, mode.decode(0.5 * 1.0, 1.0)] {
            let corner = mode.encode(fill * (1.0 - reflectance) + reflectance, 1.0);

            assert!(
                (corner * 255.0 - 144.68).abs() < 0.01,
                "the GCS-validated corner must still be 144.7/255, got {}",
                corner * 255.0
            );
        }
    }

    /// The shader must apply the out-of-bounces fill the way the arithmetic above describes.
    ///
    /// Checked against the shader source text, because nothing else connects the two languages:
    /// no test compiles or runs `gem.frag`, so the test above is only about this renderer if the
    /// shader still spells the fill this way.
    ///
    /// Verifies the shade alone is decoded and the transmittance multiplies the result, and that
    /// no expression decodes the shade combined with anything else -- which is the shape of the
    /// bug T-0072 fixed, and the shape any re-introduction of it would take.
    #[test]
    fn shader_fills_exhausted_paths_with_a_decoded_shade_times_the_transmittance() {
        let shader = include_str!("shaders/gem.frag");

        assert!(
            shader.contains("vec3 stoneColor = exp(-uAbsorption);"),
            "the stone colour must still be the unit-distance Beer-Lambert transmittance"
        );
        assert!(
            shader.contains(
                "gathered += throughput * displayToRadiance(vec3(uExhaustionShade)) * stoneColor;"
            ),
            "the fill must decode the shade on its own and multiply by the linear transmittance"
        );

        // `displayToRadiance(vec3(uExhaustionShade))` does not match this, because of the
        // `vec3(`. Anything that does is decoding the shade together with another factor.
        assert!(
            !shader.contains("displayToRadiance(uExhaustionShade"),
            "uExhaustionShade must not be decoded in a product: displayToRadiance is the inverse \
             of the display transfer, so a linear factor inside it is raised to DISPLAY_GAMMA"
        );
    }

    /// The debug mode encoding must round-trip, since it crosses into the shader
    /// as a bare integer uniform.
    #[test]
    fn debug_mode_encoding_round_trips() {
        let modes = [
            DebugMode::Full,
            DebugMode::Normals,
            DebugMode::FacetId,
            DebugMode::TraversalCost,
            DebugMode::BounceCount,
        ];

        for mode in modes {
            assert_eq!(DebugMode::from_u32(mode.as_u32()), mode);
        }

        // Unknown values must fall back to the full render rather than panicking.
        assert_eq!(DebugMode::from_u32(999), DebugMode::Full);
    }

    /// The Rust clamp on the bounce count must equal the shader's compile-time loop bound.
    ///
    /// Setup: `MAX_BOUNCES` from this module, and the text of `gem.frag`. GLSL ES 3.00 loops
    /// need a constant bound, so `traceInterior` loops up to `MAX_BOUNCE_LIMIT` and breaks
    /// early at the `uMaxBounces` uniform, which `RenderParams::clamp` limits to `MAX_BOUNCES`.
    ///
    /// Test: look for the shader constant declared with this module's value, and for the
    /// interior loop being bounded by it.
    ///
    /// Verifies the two limits are equal. If the shader's bound were lower, a bounce count
    /// between the two would silently render fewer bounces than the slider reports. If it
    /// were higher, nothing would look wrong yet, but the page could never reach it. Concave
    /// fantasy cuts trap light longer and are the likeliest reason to raise the limit, and
    /// this test is what makes raising only one of the two fail.
    ///
    /// This replaces the check the missing `tests/shaders.rs` used to make.
    #[test]
    fn shader_bounce_limit_matches_the_rust_clamp() {
        let shader = include_str!("shaders/gem.frag");
        let expected = format!("const int MAX_BOUNCE_LIMIT = {};", MAX_BOUNCES);

        assert!(shader.contains(&expected), "gem.frag must declare {}", expected);
        assert!(
            shader.contains("bounce < MAX_BOUNCE_LIMIT"),
            "the interior loop in gem.frag must be bounded by MAX_BOUNCE_LIMIT"
        );
    }

    // ----------------------------------------------------------------- T-0120: the
    // LuxCore port's own parameters. See `Renderer`, `cauchy_from_gemmological_constants`
    // and `lux_sun_direction`.

    /// The renderer encoding must survive a round trip, and anything unrecognised must
    /// fall back to the renderer this project shipped with.
    ///
    /// Setup: every variant and a value no variant uses. Test: encode and decode each.
    /// Verifies that `set_renderer(n)` from the page or the console can never leave the
    /// renderer in an undefined state, and -- the reason the fallback direction matters --
    /// that a stale page calling `set_renderer(7)` gets the deterministic tracer rather than
    /// an unknown one. The same shape as `LightingModel::from_u32`'s own fallback.
    #[test]
    fn renderer_encoding_round_trips_and_rejects_unknown_values() {
        for renderer in Renderer::all() {
            assert_eq!(Renderer::from_u32(renderer.as_u32()), renderer);
        }

        assert_eq!(Renderer::from_u32(0), Renderer::Deterministic);
        assert_eq!(Renderer::from_u32(1), Renderer::LuxCore);
        assert_eq!(Renderer::from_u32(2), Renderer::Flat);
        assert_eq!(Renderer::from_u32(7), Renderer::Deterministic);
    }

    /// The facet wireframe must start on, and draft mode must leave it alone.
    ///
    /// Setup: a default `RenderParams`, and its draft variant. Test: read `wireframe` from
    /// both. Verifies the user's request that the overlay be on by default (2026-09-18), and
    /// that dragging the stone does not make the outlines flicker off and back on: the
    /// overlay costs a few texel reads per pixel, nothing like the bounce count draft mode
    /// exists to cut.
    #[test]
    fn wireframe_is_on_by_default_and_survives_draft_mode() {
        let params = RenderParams::default();

        assert!(params.wireframe, "the facet wireframe must default to on");
        assert!(params.draft(0.5).wireframe, "draft mode must not turn the wireframe off");
    }

    /// The ported path's environment source must round trip, must fall back to the
    /// project's own environment, and must *start* there (T-0127).
    ///
    /// Setup: both variants, a value no variant uses, and a default `RenderParams`.
    ///
    /// Test: encode and decode each variant, decode the unknown value, and read the
    /// default.
    ///
    /// Verifies the three things that would each break a different person's day. The round
    /// trip is what makes `uLuxEnvironment` a faithful copy of the host's choice rather
    /// than an independent second source of truth. The fallback direction is chosen the
    /// opposite way round to `Renderer::from_u32`'s *intent* but for the same reason: an
    /// unrecognised value should land on what a person asked the page for -- their own
    /// lighting model -- not on LuxCore's validation rig, which would silently discard it
    /// and look exactly like the bug this ticket removed. And the default matters most of
    /// all: if it were `LuxCoreNative`, selecting the ported renderer would go on throwing
    /// the chosen environment away, which is the whole complaint T-0127 exists to answer.
    #[test]
    fn lux_environment_encoding_round_trips_and_defaults_to_the_projects_own() {
        for environment in [LuxEnvironment::Project, LuxEnvironment::LuxCoreNative] {
            assert_eq!(
                LuxEnvironment::from_u32(environment.as_u32()),
                environment,
                "the {:?} encoding must survive a round trip through the uniform",
                environment
            );
        }

        assert_eq!(LuxEnvironment::from_u32(0), LuxEnvironment::Project);
        assert_eq!(LuxEnvironment::from_u32(1), LuxEnvironment::LuxCoreNative);
        assert_eq!(
            LuxEnvironment::from_u32(9),
            LuxEnvironment::Project,
            "an unrecognised value must fall back to the user's own environment, never to \
             the oracle comparison's rig"
        );

        assert_eq!(
            RenderParams::default().lux_environment,
            LuxEnvironment::Project,
            "a fresh page must light the ported renderer with the lighting model the page \
             shows, not with LuxCore's constantinfinite sky"
        );
    }

    /// The Cauchy conversion must produce the numbers the LuxCore oracle's scene files
    /// carry, or the two renderers are not tracing the same glass.
    ///
    /// Setup: the shipped default material, cubic zirconia -- index 2.16 at the sodium D
    /// line, B-G dispersion 0.060. Test: convert, and compare against the A and B that
    /// `tools/luxcore_oracle.py` computes for exactly those inputs and writes into
    /// `scene.materials.gem.interiorior` / `.cauchyb`, recorded independently in
    /// `kb/luxcore-as-a-reference-oracle.md` as A = 2.10712553, B = 0.0183619549.
    ///
    /// Verifies the trap that article calls out: LuxCore uses `interiorior` *as Cauchy's A*,
    /// not as an index at any wavelength. Handing it 2.16 unconverted is wrong at every
    /// wavelength -- by 0.053 at the D line here, which is more than the whole dispersion
    /// being modelled -- and nothing about the resulting render looks broken enough to
    /// notice. The second case pins the boundary the oracle's own `.scn` writer relies on:
    /// with dispersion 0, B is 0 and A is the index itself, so the dispersion-free
    /// comparison really is a plain achromatic n = 2.16 glass on both sides.
    #[test]
    fn cauchy_conversion_matches_the_luxcore_oracle() {
        let (a, b) = cauchy_from_gemmological_constants(2.16, 0.060);

        assert!(
            (a - 2.10712553).abs() < 1e-6,
            "Cauchy A was {}, expected 2.10712553",
            a
        );
        // 1e-7, not tighter: these are f32 here and f64 in the Python oracle, and B is
        // about 0.018, so a single-precision ulp at that magnitude is already ~2e-9. The
        // tolerance is about representation, not about the formula.
        assert!(
            (b - 0.0183619549).abs() < 1e-7,
            "Cauchy B was {}, expected 0.0183619549",
            b
        );

        let (achromatic_a, achromatic_b) = cauchy_from_gemmological_constants(2.16, 0.0);

        assert_eq!(achromatic_b, 0.0);
        assert!((achromatic_a - 2.16).abs() < 1e-6);
    }

    /// `cauchy_coefficients` must follow the dispersion actually traced, not the stored one.
    ///
    /// Setup: a material whose stored dispersion exceeds what its index allows -- index 1.02
    /// with dispersion 0.3, where `effective_dispersion` limits the spread to 0.04 so the red
    /// index cannot fall below 1.0. Test: compare the coefficients against a direct
    /// conversion at the limited dispersion. Verifies that the ported path and the
    /// deterministic path are given the same glass: `spectral_indices` already uses
    /// `effective_dispersion`, and using the raw value here would have the LuxCore renderer
    /// disperse a stone the deterministic one does not, at exactly the settings where the
    /// difference is hardest to attribute.
    #[test]
    fn cauchy_coefficients_use_the_dispersion_that_is_actually_traced() {
        let mut params = RenderParams::default();
        params.refractive_index = 1.02;
        params.dispersion = 0.3;
        params.clamp();

        let limited = params.effective_dispersion();
        assert!(limited < params.dispersion, "the setup should be limited");

        let expected = cauchy_from_gemmological_constants(params.refractive_index, limited);

        assert_eq!(params.cauchy_coefficients(), expected);
    }

    /// The sample count must stay inside a range the shader can survive.
    ///
    /// Setup: parameters with a zero sample count, and with an absurd one. Test: clamp.
    /// Verifies both ends. Zero would make `entry.glsl` divide the accumulated radiance by
    /// zero and paint the stone with NaNs; an unbounded count is not merely slow but a hung
    /// tab, because WebGL cannot interrupt a fragment shader once it has been dispatched --
    /// the same reason `MAX_BOUNCES` exists.
    #[test]
    fn lux_sample_count_is_clamped_at_both_ends() {
        let mut params = RenderParams::default();

        params.lux_samples = 0;
        params.clamp();
        assert_eq!(params.lux_samples, 1);

        params.lux_samples = u32::MAX;
        params.clamp();
        assert_eq!(params.lux_samples, MAX_LUX_SAMPLES);
    }

    /// Only the studio rig has suns, and it has exactly five.
    ///
    /// Setup: parameters in each lighting model. Test: read `lux_sun_count`. Verifies the
    /// one thing the lighting model still controls on the ported path. It matters for the
    /// comparison harness: `tools/compare_luxcore.py` will only score the `isometric` rig,
    /// which is the sky alone, and a stray sun there would add radiance the oracle's scene
    /// does not contain -- with a placeholder colour (T-0119) at that.
    #[test]
    fn only_the_studio_lighting_model_lights_the_ported_suns() {
        let mut params = RenderParams::default();

        params.lighting_model = LightingModel::Studio;
        assert_eq!(params.lux_sun_count(), 5);

        for model in [
            LightingModel::AngleRings,
            LightingModel::Isometric,
            LightingModel::Cosine,
            LightingModel::Image,
        ] {
            params.lighting_model = model;
            assert_eq!(params.lux_sun_count(), 0, "{:?} should have no suns", model);
        }
    }

    /// The studio suns must be unit vectors at the polar angles the oracle places them at.
    ///
    /// Setup: each of the five (polar, azimuth) pairs. Test: build the direction and check
    /// its length and its Y component. Verifies the convention the whole rig rests on: world
    /// +Y is the stone's optical axis and points back at the camera, so the polar angle is
    /// the "tilt" the assessment models are measured against, and `cos(theta)` is the Y
    /// component. Getting the spherical convention wrong (swapping Y and Z, say) would still
    /// produce five plausible unit vectors pointing somewhere entirely different.
    #[test]
    fn studio_sun_directions_are_unit_vectors_at_the_configured_polar_angles() {
        for (index, (theta_degrees, _)) in LUX_STUDIO_SUNS_DEGREES.iter().enumerate() {
            let direction = lux_sun_direction(index);

            assert!(
                (direction.norm() - 1.0).abs() < 1e-6,
                "sun {} is not a unit vector: {}",
                index,
                direction.norm()
            );
            assert!(
                (direction.y - theta_degrees.to_radians().cos()).abs() < 1e-6,
                "sun {} should sit {} degrees off world +Y",
                index,
                theta_degrees
            );
            // Every source is in the observer's hemisphere, as Gem Cut Studio's lighting is
            // and as tools/luxcore_oracle.py's comment states.
            assert!(direction.y > 0.0, "sun {} is below the horizon", index);
        }
    }

    /// `relsize` must describe the 6-degree angular radius the oracle rig ships with.
    ///
    /// Setup: `lux_sun_relsize`. Test: compare against the value
    /// `kb/luxcore-environment-lights-port-getradiance-is-t.md` records from the oracle's own
    /// scene file (22.5248295), and re-derive the half angle from it the way
    /// `SunLight_Preprocess` does. Verifies the one sun parameter this ticket supplies as a
    /// uniform. LuxCore divides a sun's radiance by `relsize^2` to hold its power fixed, so a
    /// wrong `relsize` changes both how wide the sun is and how bright it is.
    #[test]
    fn sun_relsize_matches_the_oracle_scene_files() {
        let relsize = lux_sun_relsize();

        assert!(
            (relsize - 22.5248295).abs() < 1e-4,
            "relsize was {}, the oracle's .scn files carry 22.5248295",
            relsize
        );

        // SunLight_Preprocess, sunlight.cpp:41-54: sin(thetaMax) = relSize * sunRadius /
        // sunMeanDistance. The cone this produces is 6.011 degrees, not exactly 6: the
        // oracle's relsize-per-degree factor divides by asin(R/D) while LuxCore multiplies
        // by R/D, which is a small-angle approximation either side of the same number.
        // 6.010998960 is the figure a previous agent measured by hand from the shipped
        // scene file and recorded in
        // kb/luxcore-environment-lights-port-getradiance-is-t.md, so this asserts that,
        // not the nominal 6 -- the point is to match the oracle, approximation included.
        let sin_theta_max = relsize * 695500.0 / 149_600_000.0;
        let half_angle_degrees = sin_theta_max.asin().to_degrees();

        assert!(
            (half_angle_degrees - 6.010999).abs() < 1e-4,
            "the cone half angle came out {} degrees, not the oracle's 6.010999",
            half_angle_degrees
        );
    }

    /// Draft mode must cut the ported path's sample count, and must never raise it.
    ///
    /// Setup: a configuration at 16 samples (T-0120's old default, and still what someone
    /// running without an accumulation buffer would set), and one already down at 2. Test:
    /// take the draft variant of each. Verifies the saving is real where there is one to
    /// make -- 4 samples, a 4x cut; the ported path is a Monte Carlo estimator, so samples
    /// are the one setting that is purely an amount of noise and therefore the right thing
    /// to drop while the user is turning the stone -- and that the `max(1)` floor cannot
    /// *raise* the count for someone already below 4, which is exactly the trap
    /// `draft_is_never_more_expensive_than_full_quality` pins for the bounce count.
    ///
    /// Since T-0122 the default is 1 sample per pass, where there is nothing left to cut:
    /// a drag is cheap because it is one pass, not because the pass is cheaper. The
    /// reduction is checked at 16 rather than at the default so it keeps being tested.
    ///
    /// Also checked at two very different quality-while-dragging fractions (0 and 1),
    /// since this quarter is fixed rather than following `quality` (unlike the bounce
    /// count): the sample count must come out the same either way, or the "quality"
    /// slider would silently be doing something to convergence speed it does not
    /// document.
    #[test]
    fn draft_mode_cuts_the_lux_sample_count_and_never_raises_it() {
        for quality in [0.0, 1.0] {
            let mut params = RenderParams::default();
            params.lux_samples = 16;
            assert_eq!(params.draft(quality).lux_samples, 4, "at quality {}", quality);

            // The default is already at the floor, so drafting is a no-op rather than a rise.
            assert_eq!(RenderParams::default().lux_samples, DEFAULT_LUX_SAMPLES);
            assert_eq!(RenderParams::default().draft(quality).lux_samples, 1, "at quality {}", quality);

            // 2 / 4 rounds to 0, so the floor lifts it to 1 -- still a cut, not a rise.
            let mut cheap = RenderParams::default();
            cheap.lux_samples = 2;
            assert_eq!(cheap.draft(quality).lux_samples, 1, "at quality {}", quality);

            // Already at the floor: the `min(self)` is what stops it going back up to 1 from
            // below, and the `max(1)` is what stops it reaching 0 and dividing by zero in the
            // shader. Neither can move it here.
            let mut one = RenderParams::default();
            one.lux_samples = 1;
            assert_eq!(one.draft(quality).lux_samples, 1, "at quality {}", quality);

            // The general property both bounds exist to guarantee, over the whole range.
            for samples in 1..=64 {
                let mut params = RenderParams::default();
                params.lux_samples = samples;

                let drafted = params.draft(quality).lux_samples;

                assert!(drafted >= 1, "{} samples drafted to 0 at quality {}", samples, quality);
                assert!(
                    drafted <= samples,
                    "{} samples drafted up to {} at quality {}",
                    samples,
                    drafted,
                    quality
                );
            }
        }
    }

    // ----------------------------------------------------------------------------------
    // Progressive accumulation (T-0122)
    // ----------------------------------------------------------------------------------

    /// A key describing a plain default frame at 64x64, the baseline every accumulation
    /// test below mutates one thing away from.
    fn accumulation_key() -> AccumulationKey {
        AccumulationKey {
            params: RenderParams::default(),
            camera: crate::camera::OrbitCamera::default(),
            width: 64,
            height: 64,
            model_generation: 0,
            environment_generation: 0,
            frosted_facets: Vec::new(),
        }
    }

    /// Nothing changing must let the sum grow, one pass per `render()`.
    ///
    /// Setup: a fresh state and the same key three times over. Test: the plan returned for
    /// each pass. Verifies the whole point of the design -- that repeated frames at
    /// unchanged settings are estimates of one integral, so pass 0 restarts and zeroes the
    /// buffers, passes 1 and 2 do not, the index rises by one each time (it is what seeds
    /// the shader, so a repeated index would re-draw the same random numbers and converge
    /// to nothing), and `total` tracks the divisor the resolve pass must use.
    #[test]
    fn accumulation_continues_while_nothing_changes() {
        let mut state = AccumulationState::new();

        let first = state.begin_pass(accumulation_key());
        assert!(first.restarted, "the very first pass must start a new sum");
        assert_eq!(first.index, 0);
        assert_eq!(first.total, 1);
        assert!(first.accumulate);

        let second = state.begin_pass(accumulation_key());
        assert!(!second.restarted, "an unchanged key must not throw the sum away");
        assert_eq!(second.index, 1);
        assert_eq!(second.total, 2);

        let third = state.begin_pass(accumulation_key());
        assert_eq!(third.index, 2);
        assert_eq!(third.total, 3);
        assert_eq!(state.passes(), 3);
    }

    /// Moving the camera must throw the accumulated image away.
    ///
    /// Setup: two passes at the default pose, then a key whose camera has been spun.
    /// Test: the third pass's plan. Verifies the most visible reset condition of all --
    /// without it the stone would smear across its old position, because the sum would
    /// hold radiance from two different views of the same pixel. The pose is checked
    /// through the whole `OrbitCamera` rather than through spin alone, so zoom, tilt and
    /// the field of view are covered by the same equality.
    #[test]
    fn accumulation_restarts_when_the_camera_moves() {
        let mut state = AccumulationState::new();

        state.begin_pass(accumulation_key());
        state.begin_pass(accumulation_key());
        assert_eq!(state.passes(), 2);

        let mut moved = accumulation_key();
        moved.camera.orbit(0.1, 0.0);

        let after = state.begin_pass(moved);

        assert!(after.restarted, "a camera move must restart the accumulation");
        assert_eq!(after.index, 0, "the seed must go back to the first stream");
        assert_eq!(after.total, 1, "the resolve divisor must go back to one pass");
    }

    /// Every other input the image depends on must restart it too.
    ///
    /// Setup: the baseline key, and a list of one-field mutations covering the size, the
    /// model, the environment and *every* field of `RenderParams` -- including the ones
    /// the ported path ignores today, because "this parameter does not affect that
    /// renderer" is a claim that ages badly and restarting costs one frame.
    ///
    /// Test: for each mutation, accumulate two passes at the baseline and then present the
    /// mutated key. Verifies that each one is seen as a different integral. The
    /// destructuring below is the load-bearing part: it names every field without a `..`
    /// rest pattern, so adding a field to `RenderParams` stops this test **compiling**
    /// until someone decides whether it invalidates the sum. Catching that at runtime is
    /// impossible -- a forgotten field shows up only as an image that will not update.
    #[test]
    fn accumulation_restarts_for_every_render_parameter() {
        // Compile-time exhaustiveness guard; the bindings themselves are unused.
        let RenderParams {
            refractive_index: _,
            dispersion: _,
            absorption: _,
            absorption_scale: _,
            max_bounces: _,
            spectral_samples: _,
            exposure: _,
            env_intensity: _,
            env_rotation: _,
            debug_mode: _,
            lighting_model: _,
            tone_map_mode: _,
            head_shadow_half_angle: _,
            head_shadow_color: _,
            observer_radius: _,
            use_background_color: _,
            background_color: _,
            use_window_color: _,
            window_color: _,
            lighting_follows_view: _,
            exhaustion_shade: _,
            wireframe: _,
            renderer: _,
            lux_samples: _,
            lux_seed: _,
            lux_environment: _,
        } = RenderParams::default();

        let mutations: Vec<(&str, fn(&mut AccumulationKey))> = vec![
            ("width (a resize)", |key| key.width += 1),
            ("height (a resize)", |key| key.height += 1),
            ("model load", |key| key.model_generation += 1),
            ("environment upload", |key| key.environment_generation += 1),
            // T-0183: marking (or unmarking) a facet as frosted changes its material.
            ("frosted facets", |key| key.frosted_facets.push(3)),
            ("refractiveIndex", |key| key.params.refractive_index = 1.5),
            ("dispersion", |key| key.params.dispersion = 0.02),
            ("absorption", |key| key.params.absorption = Vector3::repeat(0.5)),
            ("absorptionScale", |key| key.params.absorption_scale = 2.0),
            ("maxBounces", |key| key.params.max_bounces = 7),
            ("spectralSamples", |key| key.params.spectral_samples = 1),
            ("exposure", |key| key.params.exposure = 2.0),
            ("envIntensity", |key| key.params.env_intensity = 2.0),
            ("envRotation", |key| key.params.env_rotation = 0.5),
            ("debug mode", |key| key.params.debug_mode = DebugMode::Normals),
            ("lighting model", |key| {
                key.params.lighting_model = LightingModel::Isometric
            }),
            ("tone map mode", |key| {
                key.params.tone_map_mode = ToneMapMode::Linear
            }),
            ("headShadowHalfAngle", |key| {
                key.params.head_shadow_half_angle = 0.2
            }),
            ("head shadow colour", |key| {
                key.params.head_shadow_color = Vector3::new(1.0, 0.0, 0.0)
            }),
            ("observerRadius", |key| key.params.observer_radius = 0.02),
            ("background enabled", |key| {
                key.params.use_background_color = !key.params.use_background_color
            }),
            ("background colour", |key| {
                key.params.background_color = Vector3::new(0.1, 0.2, 0.3)
            }),
            ("window colour enabled", |key| {
                key.params.use_window_color = !key.params.use_window_color
            }),
            ("window colour", |key| {
                key.params.window_color = Vector3::new(0.3, 0.2, 0.1)
            }),
            ("lighting follows view", |key| {
                key.params.lighting_follows_view = !key.params.lighting_follows_view
            }),
            ("exhaustionShade", |key| key.params.exhaustion_shade = 0.25),
            ("wireframe", |key| key.params.wireframe = !key.params.wireframe),
            ("renderer", |key| key.params.renderer = Renderer::LuxCore),
            ("luxSamples", |key| key.params.lux_samples = 4),
            ("luxSeed", |key| key.params.lux_seed = 9),
            ("luxEnvironment", |key| {
                key.params.lux_environment = LuxEnvironment::LuxCoreNative
            }),
        ];

        for (name, mutate) in mutations {
            let mut state = AccumulationState::new();
            state.begin_pass(accumulation_key());
            state.begin_pass(accumulation_key());

            let mut changed = accumulation_key();
            mutate(&mut changed);

            assert_ne!(
                changed,
                accumulation_key(),
                "the {} mutation did not actually change the key, so this case proves \
                 nothing",
                name
            );

            let plan = state.begin_pass(changed);

            assert!(
                plan.restarted,
                "changing {} left the accumulation running, so the image would keep \
                 averaging in frames taken under the old setting",
                name
            );
            assert_eq!(plan.index, 0, "changing {} must restart at pass 0", name);
        }
    }

    /// Re-sending the same frosted facets must NOT restart the accumulation; sending a
    /// different set must.                                                          T-0183
    ///
    /// Setup: a key with facets 2 and 5 frosted, accumulated for two passes. The page re-sends
    /// its frosted set after every rebuild and design load, often unchanged, which is why the
    /// key holds the set's contents rather than a counter bumped on every call.
    ///
    /// Test: a third pass with an identical set, then a fourth with facet 5 unfrosted.
    ///
    /// Verifies both halves of that choice: the identical set continues the sum (pass index 2,
    /// no restart), so a no-op resend does not throw a converged image away; and removing a
    /// facet restarts it at pass 0, because that facet's material -- and so the image -- has
    /// changed, and averaging in passes taken with it frosted would smear the two looks.
    #[test]
    fn accumulation_follows_the_frosted_set_not_the_number_of_times_it_was_sent() {
        let mut state = AccumulationState::new();

        let mut frosted = accumulation_key();
        frosted.frosted_facets = vec![2, 5];

        state.begin_pass(frosted.clone());
        state.begin_pass(frosted.clone());

        let resent = state.begin_pass(frosted.clone());
        assert!(!resent.restarted, "an unchanged frosted set must not restart the sum");
        assert_eq!(resent.index, 2, "the sum must carry on from where it was");

        let mut unfrosted = frosted.clone();
        unfrosted.frosted_facets = vec![2];

        let changed = state.begin_pass(unfrosted);
        assert!(changed.restarted, "unfrosting a facet changes the image and must restart");
        assert_eq!(changed.index, 0);
    }

    /// Draft mode must restart the accumulation in both directions.
    ///
    /// Setup: default parameters and their draft reduction, which is what `render()`
    /// actually sends to the shader. Test: accumulate under one and then present the
    /// other, then go back. Verifies the case a key built from the *stored* parameters
    /// would miss entirely: `set_draft_mode` changes no field of `RenderParams`, yet it
    /// scales the bounce count by `drag_quality` and quarters the sample count, so frames
    /// taken either side of it estimate different integrals. Averaging a drag's cheap
    /// frames into the still image is exactly the "smeared" failure this ticket warns
    /// about.
    #[test]
    fn accumulation_restarts_when_draft_mode_is_entered_and_left() {
        let mut state = AccumulationState::new();

        let mut drafted = accumulation_key();
        // 0.4 matches the page's own default "drag quality" setting
        // (`SLIDER_SPECS['drag-quality']` in panel_config.js).
        drafted.params = drafted.params.draft(0.4);

        assert_ne!(
            drafted.params,
            RenderParams::default(),
            "draft mode must change the effective parameters or this test proves nothing"
        );

        state.begin_pass(accumulation_key());
        assert!(state.begin_pass(drafted.clone()).restarted, "entering draft");
        assert!(!state.begin_pass(drafted).restarted, "staying in draft");
        assert!(
            state.begin_pass(accumulation_key()).restarted,
            "leaving draft must restart too: the full-quality frames cannot be averaged \
             with the reduced ones"
        );
    }

    /// An explicit reset must behave exactly like a settings change.
    ///
    /// Setup: two accumulated passes, then `reset`. Test: the pass count, and the plan for
    /// the next pass at the *same* key. Verifies that the harness and the page can demand
    /// a fresh sum by name -- `tests/harness/gem.py` relies on it to make "reset, then N
    /// passes" a reproducible unit -- and that the key is forgotten rather than merely the
    /// counter zeroed, so the next pass reports `restarted` and the caller knows to clear
    /// the buffers.
    #[test]
    fn accumulation_reset_starts_a_fresh_sum() {
        let mut state = AccumulationState::new();

        state.begin_pass(accumulation_key());
        state.begin_pass(accumulation_key());
        assert_eq!(state.passes(), 2);

        state.reset();
        assert_eq!(state.passes(), 0, "reset must zero the pass count");

        let plan = state.begin_pass(accumulation_key());

        assert!(plan.restarted, "after a reset the buffers must be cleared again");
        assert_eq!(plan.index, 0);
        assert_eq!(plan.total, 1);
    }

    /// The generation counter must change exactly when `restarted` does, and stay put the
    /// rest of the time -- that is the whole contract a caller outside this module (the
    /// page, timing how long the current accumulation has run) relies on.
    ///
    /// Setup: a fresh state, driven through a normal run, a camera move, and an explicit
    /// `reset`. Test: `generation()` after each step. Verifies three things a page-side
    /// timer needs to be honest: it does not change while passes accumulate normally, it
    /// changes on the same restart a camera move causes, and a `reset` (which clears the
    /// key without knowing the next key) still gets picked up as a restart on the very next
    /// pass, rather than only the frame that eventually accumulates.
    #[test]
    fn generation_changes_exactly_when_the_accumulation_restarts() {
        let mut state = AccumulationState::new();

        state.begin_pass(accumulation_key());
        let after_first_pass = state.generation();

        state.begin_pass(accumulation_key());
        state.begin_pass(accumulation_key());
        assert_eq!(
            state.generation(),
            after_first_pass,
            "three passes of the same key are one run; the generation must not move"
        );

        let mut moved = accumulation_key();
        moved.camera.orbit(0.1, 0.0);
        state.begin_pass(moved);
        assert_ne!(
            state.generation(),
            after_first_pass,
            "a camera move restarts the sum, so it must also start a new generation"
        );
        let after_move = state.generation();

        state.reset();
        assert_eq!(
            state.generation(),
            after_move,
            "reset alone does not yet know whether the next key differs, so it must not \
             claim a new generation until begin_pass actually sees one"
        );

        state.begin_pass(accumulation_key());
        assert_ne!(
            state.generation(),
            after_move,
            "the first pass after a reset is always a restart (the key was forgotten), so \
             the generation must move even though this key matches an earlier run"
        );
    }

    /// The sum must stop growing at the cap rather than wrap or keep counting.
    ///
    /// Setup: a state driven straight to `MAX_ACCUMULATED_PASSES` (cheap -- `begin_pass`
    /// is pure arithmetic). Test: the plan for the pass after the cap. Verifies that
    /// `accumulate` goes false while `total` stays at the cap, which is what keeps the
    /// resolve divisor equal to the number of samples actually in the buffer. Without the
    /// bound the counter would eventually wrap to zero and the image would jump to
    /// 65,536x its brightness; with a bound but no matching `accumulate` flag the sum
    /// would keep growing against a frozen divisor and the image would slowly brighten
    /// forever.
    #[test]
    fn accumulation_stops_adding_passes_at_the_cap() {
        let mut state = AccumulationState::new();

        for _ in 0..MAX_ACCUMULATED_PASSES {
            state.begin_pass(accumulation_key());
        }

        assert_eq!(state.passes(), MAX_ACCUMULATED_PASSES);
        assert!(state.is_complete(), "the cap must report itself as complete");

        let beyond = state.begin_pass(accumulation_key());

        assert!(!beyond.accumulate, "no further sample may be added past the cap");
        assert!(!beyond.restarted);
        assert_eq!(
            beyond.total, MAX_ACCUMULATED_PASSES,
            "the divisor must stay equal to the samples actually in the buffer"
        );
        assert_eq!(state.passes(), MAX_ACCUMULATED_PASSES);
    }

    /// The default sample count is per *pass* now, and one pass must be cheap.
    ///
    /// Setup: the default parameters. Test: `lux_samples`. Verifies the change T-0122 made
    /// to T-0120's default: with an accumulation buffer, a frame should take the smallest
    /// step that still converges, because the image improves across frames instead of
    /// inside one draw. At the old default of 16 the ported path cost roughly sixteen
    /// frames' work per frame and still looked noisy, which is the complaint this ticket
    /// exists to fix.
    #[test]
    fn the_default_sample_count_is_one_per_pass() {
        assert_eq!(RenderParams::default().lux_samples, 1);
        assert_eq!(DEFAULT_LUX_SAMPLES, 1);
    }
}
