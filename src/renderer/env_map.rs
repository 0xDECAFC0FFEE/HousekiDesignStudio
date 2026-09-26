//! Procedural high-dynamic-range environment map.
//!
//! A gem is essentially a lens that samples its surroundings hundreds of times per
//! pixel, so what it reflects *is* the image. Two properties matter far more than
//! realism:
//!
//! * **High dynamic range.** Values must go well above 1.0. Clamped lighting makes
//!   a stone look like grey plastic, because the flashes that survive a dozen
//!   internal bounces started out many times brighter than white.
//! * **Small, sharp sources.** Scintillation is individual facets catching a
//!   compact light and releasing it as a point flash. A smooth gradient sky, however
//!   pretty, produces a dull stone.
//!
//! Stored as an equirectangular `RGBA16F` texture. Half precision is deliberate:
//! WebGL2 can filter `RGBA16F` linearly as a core feature, whereas `RGBA32F`
//! requires the optional `OES_texture_float_linear` extension.

use half::f16;
use nalgebra::Vector3;
use std::f32::consts::{PI, TAU};

/// Channels per texel. Alpha is unused but keeps the upload on a four-channel
/// format, which every WebGL2 implementation handles without alignment surprises.
const CHANNELS: usize = 4;

/// An equirectangular HDR environment, ready for upload.
pub struct EnvironmentMap {
    pub width: u32,
    pub height: u32,
    /// `RGBA16F` bit patterns, row major from the zenith down.
    pub texels: Vec<u16>,
}

/// A soft circular light, described the way a studio light actually is: a direction
/// and an angular size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AreaLight {
    /// Direction *towards* the light, normalised on construction.
    pub direction: Vector3<f32>,
    /// Angular radius of the fully lit core, in radians.
    pub angular_radius: f32,
    /// Angular width of the falloff outside the core, in radians.
    pub softness: f32,
    pub color: Vector3<f32>,
    pub intensity: f32,
}

impl AreaLight {
    pub fn new(
        direction: Vector3<f32>,
        angular_radius: f32,
        softness: f32,
        color: Vector3<f32>,
        intensity: f32,
    ) -> Self {
        AreaLight {
            direction: direction.normalize(),
            angular_radius,
            softness,
            color,
            intensity,
        }
    }

    /// Radiance this light contributes in a given direction.
    fn radiance(&self, direction: Vector3<f32>) -> Vector3<f32> {
        // Compare cosines rather than angles: it avoids an `acos` per light per
        // texel, and the ordering is the same because cosine is monotonic over
        // [0, PI].
        let cosine = direction.dot(&self.direction).clamp(-1.0, 1.0);
        let cos_core = self.angular_radius.cos();
        let cos_edge = (self.angular_radius + self.softness).min(PI).cos();

        // cos_edge <= cos_core, so this ramps from 0 at the outer edge to 1 in the
        // core.
        let falloff = smoothstep(cos_edge, cos_core, cosine);

        self.color * (self.intensity * falloff)
    }
}

/// The default studio rig.
///
/// Three broad sources establish the form, and two very small very bright ones
/// create scintillation. The small sources are the important ones: they are what a
/// facet can catch and flash, and removing them makes the stone look dead even
/// though the average brightness is unchanged.
pub fn studio_lights() -> Vec<AreaLight> {
    vec![
        // Key: a large soft box above and in front, the standard jewellery setup.
        AreaLight::new(
            Vector3::new(0.35, 0.90, 0.35),
            0.42,
            0.20,
            Vector3::new(1.00, 0.98, 0.94),
            14.0,
        ),
        // Fill: broad, dim, cool, from the opposite side to open up the shadows.
        AreaLight::new(
            Vector3::new(-0.75, 0.35, 0.45),
            0.55,
            0.28,
            Vector3::new(0.82, 0.88, 1.00),
            3.5,
        ),
        // Rim: behind the stone, so light entering the pavilion can return to the
        // viewer through the crown. This is what lights up the inside.
        AreaLight::new(
            Vector3::new(0.15, 0.25, -0.95),
            0.35,
            0.16,
            Vector3::new(1.00, 0.95, 0.90),
            6.0,
        ),
        // Two compact, very bright sparkle sources.
        AreaLight::new(
            Vector3::new(0.85, 0.45, -0.20),
            0.055,
            0.030,
            Vector3::new(1.00, 1.00, 1.00),
            90.0,
        ),
        AreaLight::new(
            Vector3::new(-0.50, 0.70, -0.45),
            0.045,
            0.025,
            Vector3::new(1.00, 0.97, 0.92),
            120.0,
        ),
        // A dim bounce from below, standing in for the surface the stone rests on.
        AreaLight::new(
            Vector3::new(0.05, -0.85, 0.50),
            0.50,
            0.30,
            Vector3::new(0.90, 0.85, 0.80),
            1.2,
        ),
    ]
}

/// Sky and ground gradient, excluding the lights.
fn ambient(direction: Vector3<f32>) -> Vector3<f32> {
    let zenith = Vector3::new(0.28, 0.38, 0.55);
    let horizon = Vector3::new(0.50, 0.52, 0.56);
    let ground = Vector3::new(0.09, 0.085, 0.08);

    let height = direction.y;

    if height >= 0.0 {
        // Squared blend keeps the bright band close to the horizon, as in a real
        // sky, instead of washing the whole upper hemisphere out.
        let t = height.clamp(0.0, 1.0).powf(0.65);

        horizon * (1.0 - t) + zenith * t
    } else {
        let t = (-height).clamp(0.0, 1.0).powf(0.5);

        horizon * (1.0 - t) + ground * t
    }
}

/// Total radiance arriving from a direction.
pub fn radiance_in_direction(direction: Vector3<f32>, lights: &[AreaLight]) -> Vector3<f32> {
    let direction = direction.normalize();
    let mut total = ambient(direction);

    for light in lights {
        total += light.radiance(direction);
    }

    total
}

// ------------------------------------------------- analytical assessment models
//
// The three models below are the analytical lighting environments Gem Cut Studio
// offers alongside its default "Random" rig, reimplemented from the descriptions in
// its user manual (v1.1.0, pages 18-19) so that renders from the two programs can be
// compared on the same footing. They describe *what the environment is*, which is a
// specification rather than an implementation, so nothing is derived from GCS code.
// Two details were measured from GCS's output and data rather than taken from the text: the
// Cosine fall-off (fitted to its screenshots) and the Angle Rings lookup (the ring radii of its
// own lighting map, a data file the manual documents for users to author, plus the radius scale,
// half-texel offset and antialiasing of how GCS reads it). See `cosine_radiance` and
// `ANGLE_RING_RADII_TEXELS` and the three constants after it.
//
// Two conventions from that manual are load bearing:
//
// * **"Tilt" is the polar angle from the vertical viewing axis.** Zero degrees is
//   straight down the optical axis towards the observer; 90 degrees is the horizon.
//   That is exactly the `polar` angle of our equirectangular parameterisation, so a
//   model that depends only on tilt depends only on `v`.
// * **No light arrives from below the horizon.** The manual is explicit that "No light
//   is assumed to come in from an angle greater than 90 degrees from the vertical
//   viewing angle (i.e.: nothing lower than the horizon)". So all three models are
//   black in the lower hemisphere, which is a large departure from `studio_lights`
//   and is the main reason a stone looks so different under them.
//
// A third convention governs scale: GCS stores its models as 8-bit PNGs in which
// "a value of 128 (mid gray) is considered pure white", with values above 128
// reserved for high dynamic range sources. Our environment is already floating point,
// so that maps to a unit channel value, and `RING_LEVEL` below is 1.0 rather than
// anything scaled.
//
// Note that GCS multiplies the lighting model by the gem's own colour, so its manual
// advises setting the material to pure white when using an analytical model. The
// equivalent here is an absorption of zero -- see `RenderParams::analytical` in
// params.rs.

/// Radii of the three Angle Rings boundaries in Gem Cut Studio's own lighting map, in texels.
///
/// GCS does not draw the bands from the manual's 15 / 30 / 50 degrees. It reads them from
/// `LightingModels/Angle Rings.png`, a 256 x 256 map whose hard, antialiased circles sit at these
/// radii from the centre. Red lies inside 35, cyan out to 64, yellow out to 96, and magenta fills
/// the rest. Measured in T-0030; the map is GCS's data, is not read at run time and is not part of
/// this project.
pub const ANGLE_RING_RADII_TEXELS: [f32; 3] = [35.0, 64.0, 96.0];

/// Texel radius the lookup point sits at for light arriving along the viewing axis's horizon.
///
/// GCS's lookup is orthographic -- the point at texel radius `r` holds the light arriving at the
/// tilt whose sine is `r / 128` -- which is also why its Cosine model falls off as `1 - sin(tilt)`
/// (T-0004). A disc of radius 128 in a 256-texel map is the geometric answer, but the fit prefers
/// **127.0**: a texture coordinate scaled by `size - 1` rather than `size`. See
/// `ANGLE_RING_LOOKUP_OFFSET_TEXELS` for the rest of that mechanism.
///
/// Fitted in T-0030 on the four comparison views at the shipped camera, and flat from 126.75 to
/// 127.25; 127.5 (what `size - 1` predicts exactly) costs 0.35 of mean group MAE and 128 costs
/// 1.04. The basin is shallow and this constant trades against `ANGLE_RING_BLEND_TEXELS`, so
/// **refit the two together or not at all**.
pub const ANGLE_RING_LOOKUP_RADIUS_TEXELS: f32 = 127.0;

/// Half-texel offset of the lookup point, in texels, as (x, z) in the lighting frame.
///
/// **This is what makes the rings eccentric rather than concentric**, and therefore what makes an
/// Angle Rings render depend on azimuth at all. It is a texel-corner sample through a bottom-left
/// texture origin: half a texel on each axis, opposite in sign because only one axis is flipped.
///
/// Verified in T-0030 rather than merely fitted: the optimum is an interior minimum sitting
/// exactly on (-0.50, +0.50) over a 9 x 9 grid; the mirrored (+0.50, -0.50) scores worse than no
/// offset at all on all four views; and the offset explains 76-83% of the copy-to-copy colour
/// differences between symmetric facets in GCS's face-up renders -- a signature the fit was never
/// tuned on, and one a model without the offset cannot reproduce at all.
pub const ANGLE_RING_LOOKUP_OFFSET_TEXELS: [f32; 2] = [-0.5, 0.5];

/// Width of the linear blend across each ring boundary, in texels.
///
/// GCS's circles are antialiased over exactly one texel -- measured on the map, the r = 64 and
/// r = 96 bins are 4% and 1% pure band colour while r = 63/65 and 95/97 are about 90% pure -- and
/// bilinear filtering doubles that to two. One texel is 0.47 degrees of tilt at the first
/// boundary, 0.52 at the second and 0.68 at the third.
///
/// **So no choice of hard edge can match GCS at a boundary**: within that window GCS returns a
/// mixture and a hard edge returns one side or the other. That is why T-0033's edges, though they
/// are GCS's own radii, still left the near-edge error this constant removes.
pub const ANGLE_RING_BLEND_TEXELS: f32 = 2.0;

/// Radiance of a lit ring. Unit valued because GCS treats mid grey as pure white.
pub const RING_LEVEL: f32 = 1.0;

/// The four Angle Rings colours, in order from the vertical axis outwards.
///
/// Red, cyan, yellow, magenta. Note these are not equally bright: cyan, yellow and
/// magenta each light two channels and so carry roughly twice the luminance of red.
/// That is inherent to the model as specified, not an error here.
pub const ANGLE_RING_COLORS: [Vector3<f32>; 4] = [
    Vector3::new(RING_LEVEL, 0.0, 0.0),
    Vector3::new(0.0, RING_LEVEL, RING_LEVEL),
    Vector3::new(RING_LEVEL, RING_LEVEL, 0.0),
    Vector3::new(RING_LEVEL, 0.0, RING_LEVEL),
];

/// Where a direction lands in Gem Cut Studio's Angle Rings map, as a radius in texels.
///
/// The lookup is orthographic, so a unit direction's horizontal component is already
/// `sin(tilt)`: scaling it by `ANGLE_RING_LOOKUP_RADIUS_TEXELS` and shifting by the half-texel
/// offset gives the point GCS reads. Compare the result against `ANGLE_RING_RADII_TEXELS`.
///
/// Note this is **not** a function of tilt alone. The offset moves the rings off the viewing
/// axis, so two directions at the same tilt and different azimuths read different radii, by up to
/// `hypot(0.5, 0.5)` = 0.707 texels either way. That eccentricity is the point; see
/// `ANGLE_RING_LOOKUP_OFFSET_TEXELS`.
pub fn angle_ring_texel_radius(direction: Vector3<f32>) -> f32 {
    let unit = direction.normalize();

    let x = ANGLE_RING_LOOKUP_RADIUS_TEXELS * unit.x + ANGLE_RING_LOOKUP_OFFSET_TEXELS[0];
    let z = ANGLE_RING_LOOKUP_RADIUS_TEXELS * unit.z + ANGLE_RING_LOOKUP_OFFSET_TEXELS[1];

    x.hypot(z)
}

/// How far across a ring boundary a lookup radius has travelled: 0 fully inside, 1 fully outside.
///
/// The window is centred on the boundary and `ANGLE_RING_BLEND_TEXELS` wide, so a radius more
/// than half a window either side of a boundary is unaffected by it. The three boundaries are at
/// least 29 texels apart and the window is 2, so no radius is ever inside two windows at once --
/// which is what lets `angle_rings_radiance` sum the boundaries independently.
fn ring_boundary_blend(texel_radius: f32, boundary: f32) -> f32 {
    let half_window = ANGLE_RING_BLEND_TEXELS * 0.5;

    ((texel_radius - (boundary - half_window)) / ANGLE_RING_BLEND_TEXELS).clamp(0.0, 1.0)
}

/// Gem Cut Studio's **Angle Rings** model: four colour bands, read through GCS's own lookup.
///
/// Not a real lighting environment. Its purpose is diagnostic: because each band is a
/// distinct hue, the colour a facet shows tells you the angular range the light it
/// returns came from. A crown that reads mostly red is returning light from close to
/// the observer; magenta means it is scraping light off the horizon.
///
/// **The boundaries are soft and slightly eccentric** (T-0056, the user's choice, 2026-09-18),
/// because GCS's are: its map is antialiased and it reads that map half a texel off centre. So a
/// reading taken *at* a boundary is a mixture of two bands and is no longer an exact angle; a
/// reading taken inside a band still is. The band a colour names remains the answer to "what
/// angle did this light come from", which is the whole purpose of the model.
///
/// Starting from red and adding each boundary's step is the same thing as picking a band when the
/// blends are hard, and it needs no branches when they are not.
pub fn angle_rings_radiance(direction: Vector3<f32>) -> Vector3<f32> {
    // Below the horizon: no light at all. This edge stays hard, unlike the three ring
    // boundaries. It is not a circle in GCS's map -- the map is magenta out to its corners --
    // but the manual's rule that nothing arrives from below the horizon, which is exact.
    if direction.normalize().y < 0.0 {
        return Vector3::zeros();
    }

    let texel_radius = angle_ring_texel_radius(direction);

    let mut radiance = ANGLE_RING_COLORS[0];

    for (index, boundary) in ANGLE_RING_RADII_TEXELS.iter().enumerate() {
        let step = ANGLE_RING_COLORS[index + 1] - ANGLE_RING_COLORS[index];

        radiance += step * ring_boundary_blend(texel_radius, *boundary);
    }

    radiance
}

/// Gem Cut Studio's **Isometric** model: uniform light over the upper hemisphere.
///
/// Every direction from 0 to 90 degrees of tilt contributes equally, so any facet
/// returning light from above appears white and the image becomes a direct read-out of
/// light return. This is the model to use for judging how much light a cut gives back,
/// as opposed to where it comes from.
pub fn isometric_radiance(direction: Vector3<f32>) -> Vector3<f32> {
    if direction.normalize().y >= 0.0 {
        Vector3::repeat(RING_LEVEL)
    } else {
        Vector3::zeros()
    }
}

/// Gem Cut Studio's **Cosine** model: full brightness overhead, fading to black at
/// the horizon.
///
/// Concentrating the light behind the observer is what makes this the model for judging
/// vulnerability to head shadow: a cut that depends on light from directly behind the viewer
/// is exactly the cut that a head blocking that light will darken.
///
/// **The fall-off is `1 - sin(tilt)`, not the cosine the name suggests.** The manual only says
/// "full brightness" behind the observer "fading to black at the horizon". A true cosine
/// rendered the hex cut about 70 levels brighter than GCS's screenshots, with the same facet
/// pattern (T-0004). Fitting the light level at every 5 degrees of tilt to those screenshots,
/// with an independent reference tracer and no assumed shape, gave 0.82 at 10 degrees, 0.66 at
/// 20, 0.49 at 30 and 0.11 at 60, which is `1 - sin` (0.83, 0.66, 0.50, 0.13) and far from the
/// cosine (0.98, 0.94, 0.87, 0.50). It is what a linear radial ramp across an orthographic
/// sphere map gives, where the radius is `sin(tilt)`. See
/// kb/assessment-models-and-tone-mapping.md.
pub fn cosine_radiance(direction: Vector3<f32>) -> Vector3<f32> {
    let height = direction.normalize().y;

    if height >= 0.0 {
        let sine = (1.0 - height * height).max(0.0).sqrt();

        Vector3::repeat(RING_LEVEL * (1.0 - sine))
    } else {
        Vector3::zeros()
    }
}

// ------------------------------------------------------------ image environments
//
// A photographed or rendered surrounding, supplied as an ordinary 8-bit image such as
// `src/resources/backrooms_skybox_cross.png`. Such images are display referred: a byte value is a brightness as
// shown on screen, not a radiance. They are decoded to linear radiance with
// `DISPLAY_GAMMA`, so reflection and refraction mix light linearly as they should, and the
// shader's gamma display transfer re-encodes with the inverse, so a pixel seen directly
// through the stone keeps the colour it had in the image.
//
// There is no high dynamic range in an 8-bit image: the brightest possible value is 1.0.
// A stone lit this way cannot flash above white the way it does under the studio rig.

/// Exponent relating 8-bit display values to linear radiance.
///
/// Must match `DISPLAY_GAMMA` in `gem.frag`, which applies the inverse. The studio rig's
/// filmic transfer already used 2.2, so the value is shared rather than using the
/// piecewise sRGB curve, whose round trip against a pure power would not be exact.
pub const DISPLAY_GAMMA: f32 = 2.2;

/// Decodes one 8-bit display value to linear radiance in 0..1.
pub fn display_to_linear(value: u8) -> f32 {
    (value as f32 / 255.0).powf(DISPLAY_GAMMA)
}

/// Where one cube face sits in a horizontal-cross image, and which way it faces.
///
/// `forward` is the world direction through the centre of the face, `right` and `up` the
/// world directions of increasing image x and decreasing image y, all as seen by a viewer
/// at the centre of the cube looking out.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CubeFace {
    pub column: usize,
    pub row: usize,
    pub forward: Vector3<f32>,
    pub right: Vector3<f32>,
    pub up: Vector3<f32>,
}

/// Columns and rows of face-sized cells in a horizontal cross.
pub const CROSS_COLUMNS: usize = 4;
pub const CROSS_ROWS: usize = 3;

/// The six faces of a horizontal cross:
///
/// ```text
///         [ +Y ]
/// [ -X ]  [ -Z ]  [ +X ]  [ +Z ]
///         [ -Y ]
/// ```
///
/// The middle row is a panorama that turns right as it runs left to right, and the top and
/// bottom faces hinge on the front face (column 1). Which world axis is "front" only rotates
/// the surroundings about the vertical, which `envRotation` adjusts anyway; what matters is
/// that no face is mirrored and every shared edge in the picture is a shared edge on the
/// cube. Both are enforced by tests.
pub const CROSS_FACES: [CubeFace; 6] = [
    CubeFace {
        column: 1,
        row: 1,
        forward: Vector3::new(0.0, 0.0, -1.0),
        right: Vector3::new(1.0, 0.0, 0.0),
        up: Vector3::new(0.0, 1.0, 0.0),
    },
    CubeFace {
        column: 2,
        row: 1,
        forward: Vector3::new(1.0, 0.0, 0.0),
        right: Vector3::new(0.0, 0.0, 1.0),
        up: Vector3::new(0.0, 1.0, 0.0),
    },
    CubeFace {
        column: 3,
        row: 1,
        forward: Vector3::new(0.0, 0.0, 1.0),
        right: Vector3::new(-1.0, 0.0, 0.0),
        up: Vector3::new(0.0, 1.0, 0.0),
    },
    CubeFace {
        column: 0,
        row: 1,
        forward: Vector3::new(-1.0, 0.0, 0.0),
        right: Vector3::new(0.0, 0.0, -1.0),
        up: Vector3::new(0.0, 1.0, 0.0),
    },
    CubeFace {
        column: 1,
        row: 0,
        forward: Vector3::new(0.0, 1.0, 0.0),
        right: Vector3::new(1.0, 0.0, 0.0),
        up: Vector3::new(0.0, 0.0, 1.0),
    },
    CubeFace {
        column: 1,
        row: 2,
        forward: Vector3::new(0.0, -1.0, 0.0),
        right: Vector3::new(1.0, 0.0, 0.0),
        up: Vector3::new(0.0, 0.0, -1.0),
    },
];

/// A cube-map environment decoded from a horizontal-cross image, in linear radiance.
#[derive(Debug, Clone, PartialEq)]
pub struct CubeCross {
    pub face_size: usize,
    width: usize,
    height: usize,
    /// Linear radiance per pixel, row major from the top of the image.
    texels: Vec<Vector3<f32>>,
}

impl CubeCross {
    /// Builds the environment from 8-bit RGBA pixels, as the browser's `getImageData`
    /// returns them. Alpha is ignored.
    pub fn from_rgba8(rgba: &[u8], width: u32, height: u32) -> Result<CubeCross, String> {
        let (width, height) = (width as usize, height as usize);

        if width == 0 || height == 0 {
            return Err("the environment image is empty".to_string());
        }

        if width % CROSS_COLUMNS != 0
            || height % CROSS_ROWS != 0
            || width / CROSS_COLUMNS != height / CROSS_ROWS
        {
            return Err(format!(
                "a {}x{} environment image is not a horizontal cross: expected {} square \
                 faces across and {} down, as in a 4:3 skybox",
                width, height, CROSS_COLUMNS, CROSS_ROWS
            ));
        }

        if rgba.len() != width * height * 4 {
            return Err(format!(
                "a {}x{} RGBA image needs {} bytes but {} were supplied",
                width,
                height,
                width * height * 4,
                rgba.len()
            ));
        }

        let texels = rgba
            .chunks_exact(4)
            .map(|pixel| {
                Vector3::new(
                    display_to_linear(pixel[0]),
                    display_to_linear(pixel[1]),
                    display_to_linear(pixel[2]),
                )
            })
            .collect();

        Ok(CubeCross {
            face_size: width / CROSS_COLUMNS,
            width,
            height,
            texels,
        })
    }

    /// The face a direction looks into: the one whose axis is closest to it.
    pub fn face_for(direction: Vector3<f32>) -> &'static CubeFace {
        let direction = direction.normalize();

        CROSS_FACES
            .iter()
            .max_by(|a, b| {
                direction
                    .dot(&a.forward)
                    .partial_cmp(&direction.dot(&b.forward))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .expect("there are six faces")
    }

    /// Image coordinates, in pixels with pixel centres at half-integers, that a direction
    /// samples.
    ///
    /// Kept half a pixel inside the face on every side. Bilinear sampling then never
    /// reaches into a neighbouring cell, which in a cross is usually unused filler: a dark
    /// filler colour bleeding in would draw a dark seam along every cube edge.
    pub fn pixel_coordinates(&self, direction: Vector3<f32>) -> (f32, f32) {
        let direction = direction.normalize();
        let face = Self::face_for(direction);

        // Project onto the face plane at unit distance. The depth is at least 1/sqrt(3),
        // because the nearest axis is never more than ~54.7 degrees away.
        let depth = direction.dot(&face.forward);
        let across = (direction.dot(&face.right) / depth).clamp(-1.0, 1.0);
        let upward = (direction.dot(&face.up) / depth).clamp(-1.0, 1.0);

        let size = self.face_size as f32;
        let local_x = 0.5 + (across + 1.0) * 0.5 * (size - 1.0);
        let local_y = 0.5 + (1.0 - upward) * 0.5 * (size - 1.0);

        (
            face.column as f32 * size + local_x,
            face.row as f32 * size + local_y,
        )
    }

    /// Linear radiance arriving from a direction, bilinearly filtered.
    pub fn radiance(&self, direction: Vector3<f32>) -> Vector3<f32> {
        let (x, y) = self.pixel_coordinates(direction);

        // Shift to texel-corner space for the filter weights.
        let (x, y) = (x - 0.5, y - 0.5);
        let (x0, y0) = (x.floor().max(0.0), y.floor().max(0.0));
        let (tx, ty) = (x - x0, y - y0);

        let column0 = (x0 as usize).min(self.width - 1);
        let row0 = (y0 as usize).min(self.height - 1);
        let column1 = (column0 + 1).min(self.width - 1);
        let row1 = (row0 + 1).min(self.height - 1);

        let at = |column: usize, row: usize| self.texels[row * self.width + column];

        let top = at(column0, row0) * (1.0 - tx) + at(column1, row0) * tx;
        let bottom = at(column0, row1) * (1.0 - tx) + at(column1, row1) * tx;

        top * (1.0 - ty) + bottom * ty
    }
}

/// Generates the studio environment at the given resolution.
///
/// `width` should be twice `height`, the usual equirectangular aspect, so texels
/// are roughly square near the horizon.
pub fn generate_studio(width: u32, height: u32) -> EnvironmentMap {
    generate(width, height, &studio_lights())
}

/// Generates an environment map from an arbitrary light rig.
pub fn generate(width: u32, height: u32, lights: &[AreaLight]) -> EnvironmentMap {
    generate_with(width, height, |direction| {
        radiance_in_direction(direction, lights)
    })
}

/// Generates an environment map by evaluating `radiance` per texel.
///
/// Shared by the light-rig path and the analytical models so there is one definition
/// of the texel-centre sampling and the half-float packing.
pub fn generate_with<F>(width: u32, height: u32, radiance: F) -> EnvironmentMap
where
    F: Fn(Vector3<f32>) -> Vector3<f32>,
{
    let width = width.max(1);
    let height = height.max(1);

    let mut texels = vec![0u16; width as usize * height as usize * CHANNELS];

    for row in 0..height {
        // Sample at texel centres, not corners: sampling at v = 0 would evaluate
        // exactly at the pole, where the direction is degenerate.
        let v = (row as f32 + 0.5) / height as f32;

        for column in 0..width {
            let u = (column as f32 + 0.5) / width as f32;

            let direction = equirect_uv_to_direction(u, v);
            let value = radiance(direction);

            let base = (row as usize * width as usize + column as usize) * CHANNELS;

            texels[base] = f16::from_f32(value.x).to_bits();
            texels[base + 1] = f16::from_f32(value.y).to_bits();
            texels[base + 2] = f16::from_f32(value.z).to_bits();
            texels[base + 3] = f16::from_f32(1.0).to_bits();
        }
    }

    EnvironmentMap {
        width,
        height,
        texels,
    }
}

impl EnvironmentMap {
    /// Nearest-neighbour lookup, decoding back to `f32`.
    ///
    /// Provided so the generated map can be inspected in tests. The shader samples the
    /// texture with hardware filtering instead, and only for the studio and image models: it
    /// computes the analytical models directly (README decision 26).
    pub fn sample_nearest(&self, direction: Vector3<f32>) -> Vector3<f32> {
        let (u, v) = direction_to_equirect_uv(direction);

        let column = ((u * self.width as f32).floor() as i64)
            .rem_euclid(self.width as i64) as usize;
        let row = ((v * self.height as f32).floor() as i64).clamp(0, self.height as i64 - 1)
            as usize;

        let base = (row * self.width as usize + column) * CHANNELS;

        Vector3::new(
            f16::from_bits(self.texels[base]).to_f32(),
            f16::from_bits(self.texels[base + 1]).to_f32(),
            f16::from_bits(self.texels[base + 2]).to_f32(),
        )
    }
}

/// Maps a direction to equirectangular texture coordinates.
///
/// `u` runs around the vertical axis from `atan2(z, x)`, and `v` runs from 0 at the
/// zenith (+Y) to 1 at the nadir. Mirrors `sampleEnvironment` in `gem.frag`. No test checks
/// that the two agree: the round-trip test compares this function with
/// `equirect_uv_to_direction`, and both are Rust (T-0037).
pub fn direction_to_equirect_uv(direction: Vector3<f32>) -> (f32, f32) {
    let direction = direction.normalize();

    let u = direction.z.atan2(direction.x) / TAU + 0.5;
    let v = direction.y.clamp(-1.0, 1.0).acos() / PI;

    (u, v)
}

/// Inverse of [`direction_to_equirect_uv`].
pub fn equirect_uv_to_direction(u: f32, v: f32) -> Vector3<f32> {
    let polar = v * PI;
    let azimuth = (u - 0.5) * TAU;

    let y = polar.cos();
    let radius = polar.sin();

    Vector3::new(radius * azimuth.cos(), y, radius * azimuth.sin())
}

/// Builds a direction at a given tilt from vertical, at an arbitrary azimuth.
///
/// Test helper. Tilt is measured from +Y, matching the manual's "degrees from the
/// vertical viewing angle".
#[cfg(test)]
fn direction_at_tilt(tilt_degrees: f32, azimuth_degrees: f32) -> Vector3<f32> {
    let polar = tilt_degrees.to_radians();
    let azimuth = azimuth_degrees.to_radians();

    Vector3::new(
        polar.sin() * azimuth.cos(),
        polar.cos(),
        polar.sin() * azimuth.sin(),
    )
}

/// Smooth Hermite ramp from 0 at `edge0` to 1 at `edge1`.
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    if (edge1 - edge0).abs() < f32::EPSILON {
        return if x >= edge1 { 1.0 } else { 0.0 };
    }

    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);

    t * t * (3.0 - 2.0 * t)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The buffer must be exactly width * height * 4 half floats, or the upload
    /// will read past the end of the data or leave part of the texture undefined.
    #[test]
    fn generated_map_has_expected_dimensions() {
        let map = generate_studio(64, 32);

        assert_eq!(map.width, 64);
        assert_eq!(map.height, 32);
        assert_eq!(map.texels.len(), 64 * 32 * CHANNELS);
    }

    /// A zero dimension must be corrected rather than producing an empty texture
    /// that WebGL will reject at upload time.
    #[test]
    fn zero_dimensions_are_clamped_to_one() {
        let map = generate_studio(0, 0);

        assert_eq!(map.width, 1);
        assert_eq!(map.height, 1);
        assert_eq!(map.texels.len(), CHANNELS);
    }

    /// Every value must be finite and non-negative. A NaN here would propagate
    /// through the whole path trace and blacken pixels unpredictably.
    #[test]
    fn all_radiance_values_are_finite_and_non_negative() {
        let map = generate_studio(128, 64);

        for (index, bits) in map.texels.iter().enumerate() {
            let value = f16::from_bits(*bits).to_f32();

            assert!(
                value.is_finite(),
                "texel component {} is not finite: {}",
                index,
                value
            );
            assert!(
                value >= 0.0,
                "texel component {} is negative: {}",
                index,
                value
            );
        }
    }

    /// The map must be genuinely high dynamic range. If the brightest value were
    /// near 1.0, the stone would render as grey plastic: the flashes that survive a
    /// dozen internal bounces only stay visible because they started far above white.
    #[test]
    fn map_is_high_dynamic_range() {
        let map = generate_studio(512, 256);

        let brightest = map
            .texels
            .iter()
            .map(|bits| f16::from_bits(*bits).to_f32())
            .fold(0.0f32, f32::max);

        assert!(
            brightest > 20.0,
            "expected a bright source well above 1.0, got {}",
            brightest
        );

        // And half precision must not have overflowed to infinity.
        assert!(brightest.is_finite());
    }

    /// Direction and texture coordinates must round-trip. This keeps the generator
    /// (`equirect_uv_to_direction`) consistent with the Rust copy of the shader's lookup
    /// (`direction_to_equirect_uv`): if they disagreed, the lights would be generated in one
    /// place and read from another. It does not check the GLSL itself (T-0037).
    #[test]
    fn direction_and_uv_round_trip() {
        // A golden-angle spiral covers the sphere evenly, including both poles'
        // neighbourhoods and the wrap seam.
        let samples = 500;

        for i in 0..samples {
            let t = (i as f32 + 0.5) / samples as f32;
            let y = 1.0 - 2.0 * t;
            let radius = (1.0 - y * y).max(0.0).sqrt();
            let theta = 2.399_963_2 * i as f32;

            let original =
                Vector3::new(radius * theta.cos(), y, radius * theta.sin()).normalize();

            let (u, v) = direction_to_equirect_uv(original);
            let recovered = equirect_uv_to_direction(u, v);

            assert!(
                (0.0..=1.0).contains(&u),
                "u out of range for {:?}: {}",
                original,
                u
            );
            assert!(
                (0.0..=1.0).contains(&v),
                "v out of range for {:?}: {}",
                original,
                v
            );
            assert!(
                (original - recovered).norm() < 1e-4,
                "round trip failed: {:?} -> (u {}, v {}) -> {:?}",
                original,
                u,
                v,
                recovered
            );
        }
    }

    /// The poles must map to the extremes of v, and the zenith specifically to
    /// v = 0. Getting this inverted would render the environment upside down.
    #[test]
    fn poles_map_to_v_extremes() {
        let (_, zenith_v) = direction_to_equirect_uv(Vector3::new(0.0, 1.0, 0.0));
        let (_, nadir_v) = direction_to_equirect_uv(Vector3::new(0.0, -1.0, 0.0));

        assert!(zenith_v.abs() < 1e-6, "zenith should be v = 0, got {}", zenith_v);
        assert!(
            (nadir_v - 1.0).abs() < 1e-6,
            "nadir should be v = 1, got {}",
            nadir_v
        );
    }

    /// The horizontal wrap must be seamless: u just above 0 and just below 1 must
    /// describe almost the same direction, or a visible seam appears in every
    /// reflection.
    #[test]
    fn horizontal_wrap_is_seamless() {
        let just_after = equirect_uv_to_direction(0.0005, 0.5);
        let just_before = equirect_uv_to_direction(0.9995, 0.5);

        assert!(
            (just_after - just_before).norm() < 0.02,
            "the wrap seam is discontinuous: {:?} vs {:?}",
            just_after,
            just_before
        );
    }

    /// Each light must contribute its full intensity at its own centre, on top of
    /// the ambient sky.
    ///
    /// The comparison is against the ambient term in that same direction rather
    /// than against some other "dark" direction, because the broad bounce light
    /// spans 46 degrees and overlaps most of the lower hemisphere: any fixed
    /// reference direction risks sitting inside a light and making the test
    /// meaningless.
    #[test]
    fn each_light_contributes_its_full_intensity_at_its_centre() {
        let lights = studio_lights();

        for light in &lights {
            let with_lights = radiance_in_direction(light.direction, &lights);
            let ambient_only = ambient(light.direction);
            let gained = (with_lights - ambient_only).norm();
            let expected = light.color.norm() * light.intensity;

            assert!(
                gained >= expected * 0.95,
                "light towards {:?} added only {} of an expected {}",
                light.direction,
                gained,
                expected
            );
        }
    }

    /// The compact sparkle sources must dominate the map: they have to be far
    /// brighter than the typical direction, because that contrast is what survives a
    /// dozen internal bounces and reads as a flash.
    #[test]
    fn compact_lights_are_far_brighter_than_the_typical_direction() {
        let lights = studio_lights();
        let map = generate(512, 256, &lights);

        // Median luminance over the whole sphere, as a robust "typical" value that
        // no single broad light can skew.
        let mut luminances: Vec<f32> = Vec::with_capacity(map.texels.len() / CHANNELS);

        for texel in map.texels.chunks_exact(CHANNELS) {
            luminances.push(
                (0..3)
                    .map(|c| f16::from_bits(texel[c]).to_f32())
                    .sum::<f32>(),
            );
        }

        luminances.sort_by(|a, b| a.partial_cmp(b).unwrap());

        let median = luminances[luminances.len() / 2];

        let compact: Vec<&AreaLight> = lights
            .iter()
            .filter(|light| light.angular_radius < 0.1)
            .collect();

        assert!(
            compact.len() >= 2,
            "the rig should include at least two compact sparkle sources"
        );

        for light in compact {
            let lit = map.sample_nearest(light.direction);
            let luminance = lit.x + lit.y + lit.z;

            assert!(
                luminance > median * 20.0,
                "compact light towards {:?} is only {} against a median of {}",
                light.direction,
                luminance,
                median
            );
        }
    }

    /// The single brightest texel must lie close to one of the compact sparkle
    /// sources, confirming the small sources really are the peaks of the map rather
    /// than being washed out by the broad ones.
    #[test]
    fn brightest_texel_coincides_with_a_compact_light() {
        let lights = studio_lights();
        let map = generate(1024, 512, &lights);

        let mut best_luminance = -1.0f32;
        let mut best_direction = Vector3::zeros();

        for row in 0..map.height {
            let v = (row as f32 + 0.5) / map.height as f32;

            for column in 0..map.width {
                let u = (column as f32 + 0.5) / map.width as f32;
                let base = (row as usize * map.width as usize + column as usize) * CHANNELS;

                let luminance = (0..3)
                    .map(|c| f16::from_bits(map.texels[base + c]).to_f32())
                    .sum::<f32>();

                if luminance > best_luminance {
                    best_luminance = luminance;
                    best_direction = equirect_uv_to_direction(u, v);
                }
            }
        }

        // Find the light whose direction is nearest the brightest texel.
        let nearest = lights
            .iter()
            .max_by(|a, b| {
                let da = a.direction.dot(&best_direction);
                let db = b.direction.dot(&best_direction);

                da.partial_cmp(&db).unwrap()
            })
            .expect("the rig has lights");

        let angle = nearest
            .direction
            .dot(&best_direction)
            .clamp(-1.0, 1.0)
            .acos();

        assert!(
            angle < nearest.angular_radius + nearest.softness + 0.02,
            "the brightest texel is {} rad from the nearest light, outside its {} rad extent",
            angle,
            nearest.angular_radius + nearest.softness
        );
        assert!(
            nearest.angular_radius < 0.1,
            "the brightest source should be one of the compact sparkle lights, but it \
             has an angular radius of {}",
            nearest.angular_radius
        );
    }

    /// A light's radiance must peak at its centre, fall off through the soft edge,
    /// and reach exactly zero outside it, so lights stay local instead of leaking a
    /// faint glow across the whole sphere.
    #[test]
    fn light_falloff_reaches_zero_outside_its_angular_extent() {
        let light = AreaLight::new(
            Vector3::new(0.0, 1.0, 0.0),
            0.2,
            0.1,
            Vector3::new(1.0, 1.0, 1.0),
            10.0,
        );

        let centre = light.radiance(Vector3::new(0.0, 1.0, 0.0));

        assert!(
            (centre.x - 10.0).abs() < 1e-4,
            "the core should be at full intensity, got {}",
            centre.x
        );

        // Just inside the core: still full intensity.
        let inside = light.radiance(equirect_uv_to_direction(0.25, 0.19 / PI));

        assert!(inside.x > 9.0, "just inside the core should be bright");

        // Well outside the core plus softness: no contribution at all.
        let outside = light.radiance(Vector3::new(1.0, 0.0, 0.0));

        assert!(
            outside.norm() < 1e-6,
            "a direction 90 degrees away should get nothing, got {:?}",
            outside
        );
    }

    /// Ambient sky must be brighter above the horizon than below it. An inverted
    /// gradient makes the stone look lit from the floor.
    #[test]
    fn sky_is_brighter_than_ground() {
        let up = ambient(Vector3::new(0.0, 1.0, 0.0));
        let down = ambient(Vector3::new(0.0, -1.0, 0.0));

        assert!(
            up.norm() > down.norm() * 2.0,
            "sky {:?} should be clearly brighter than ground {:?}",
            up,
            down
        );
    }

    /// Half-precision storage must preserve values closely enough that the lighting
    /// is unaffected: better than a tenth of a percent across the whole range in use.
    #[test]
    fn half_precision_round_trip_is_accurate_enough() {
        for value in [0.0f32, 0.001, 0.5, 1.0, 14.0, 90.0, 120.0, 1000.0] {
            let recovered = f16::from_f32(value).to_f32();
            let error = (recovered - value).abs();
            let tolerance = (value * 1e-3).max(1e-6);

            assert!(
                error <= tolerance,
                "half precision lost too much on {}: got {} (error {})",
                value,
                recovered,
                error
            );
        }
    }

    /// Smoothstep must be clamped at both ends and monotonic in between, since the
    /// light falloff depends on it behaving exactly that way.
    #[test]
    fn smoothstep_is_clamped_and_monotonic() {
        assert_eq!(smoothstep(0.0, 1.0, -5.0), 0.0);
        assert_eq!(smoothstep(0.0, 1.0, 5.0), 1.0);
        assert!((smoothstep(0.0, 1.0, 0.5) - 0.5).abs() < 1e-6);

        let mut previous = -1.0;

        for step in 0..=20 {
            let x = step as f32 / 20.0;
            let value = smoothstep(0.0, 1.0, x);

            assert!(value >= previous, "smoothstep decreased at x = {}", x);
            previous = value;
        }
    }

    /// A degenerate smoothstep, where both edges coincide, must behave as a step
    /// rather than dividing by zero. This happens if a light is configured with zero
    /// softness.
    #[test]
    fn smoothstep_handles_coincident_edges() {
        assert_eq!(smoothstep(0.5, 0.5, 0.4), 0.0);
        assert_eq!(smoothstep(0.5, 0.5, 0.6), 1.0);

        let hard_light = AreaLight::new(
            Vector3::new(0.0, 1.0, 0.0),
            0.1,
            0.0,
            Vector3::new(1.0, 1.0, 1.0),
            5.0,
        );

        let value = hard_light.radiance(Vector3::new(0.0, 1.0, 0.0));

        assert!(
            value.x.is_finite(),
            "a zero-softness light must not produce NaN, got {}",
            value.x
        );
    }

    // ------------------------------------------- Gem Cut Studio assessment models

    /// Inside a band, Angle Rings must return that band's colour exactly.
    ///
    /// The bands are the whole model: the colour a facet shows *is* the answer to "what angle did
    /// this light come from", so a band in the wrong place makes every reading wrong while still
    /// producing a plausible, pretty image.
    ///
    /// Setup: tilts that sit at least 1.71 texels clear of every ring boundary. That margin is the
    /// blend's half window (1.0 texel) plus the most the half-texel lookup offset can move a
    /// radius (hypot(0.5, 0.5) = 0.71), so inside it no azimuth can reach a blend and the colour
    /// must come out exact. Each tilt is checked at six azimuths to prove that.
    ///
    /// The tilts include the two places where the manual and Gem Cut Studio disagree, and where
    /// this model follows GCS: 15 degrees is cyan by the manual's 15 / 30 / 50 edges but red here,
    /// and 52 degrees is magenta here but yellow by the manual.
    ///
    /// Test: `angle_rings_radiance` returns the band colour with no blend mixed into it. The
    /// comparison is exact because in the unblended case the sum of the boundary steps is a sum of
    /// zeros and ones, which f32 carries exactly.
    ///
    /// Verifies band placement away from boundaries. A revert to the manual's edges fails on 15.0
    /// and 52.0. Note this test deliberately cannot see the radius scale or the blend width -- a
    /// build with R = 128 and hard edges still passes it -- which is what the two tests below are
    /// for.
    #[test]
    fn angle_rings_are_exact_inside_each_band() {
        let cases = [
            (0.0, 0, "red"),
            (7.5, 0, "red"),
            (14.0, 0, "red"),
            (15.0, 0, "red"),
            (18.0, 1, "cyan"),
            (22.5, 1, "cyan"),
            (28.0, 1, "cyan"),
            (32.0, 2, "yellow"),
            (40.0, 2, "yellow"),
            (46.0, 2, "yellow"),
            (52.0, 3, "magenta"),
            (70.0, 3, "magenta"),
            (89.9, 3, "magenta"),
        ];

        for (tilt, expected_band, name) in cases {
            for azimuth in [0.0f32, 37.0, 135.0, 210.0, 315.0, 359.0] {
                let direction = direction_at_tilt(tilt, azimuth);
                let radiance = angle_rings_radiance(direction);

                // Guard the setup itself: if a tilt were mistakenly chosen inside a blend window,
                // the assertion below would fail for an uninteresting reason.
                let texel_radius = angle_ring_texel_radius(direction);
                let clearance = ANGLE_RING_RADII_TEXELS
                    .iter()
                    .map(|boundary| (texel_radius - boundary).abs())
                    .fold(f32::INFINITY, f32::min);

                assert!(
                    clearance > ANGLE_RING_BLEND_TEXELS * 0.5,
                    "{} degrees of tilt sits {} texels from a boundary, inside the blend window",
                    tilt,
                    clearance
                );

                assert_eq!(
                    radiance, ANGLE_RING_COLORS[expected_band],
                    "{} degrees of tilt at azimuth {} should be {}, got {:?}",
                    tilt, azimuth, name, radiance
                );
            }
        }
    }

    /// Each ring boundary must blend linearly over exactly two texels, centred on the boundary.
    ///
    /// GCS's map is antialiased over one texel, and reading it with bilinear filtering doubles
    /// that (T-0030). Within that window GCS returns a mixture of two bands, so **no choice of
    /// hard edge can match it there** -- which is why T-0033's edges, though they are GCS's own
    /// ring radii, still left the near-edge error this blend removes.
    ///
    /// Setup: azimuth 315 degrees. There the horizontal direction is (0.71, -0.71), exactly
    /// antiparallel to the lookup offset (-0.5, +0.5), so the offset subtracts its whole length
    /// and the texel radius collapses to `R sin(tilt) - hypot(0.5, 0.5)`. That identity inverts, so
    /// a wanted texel radius can be turned into a tilt and the test can stand exactly on a
    /// boundary rather than near one.
    ///
    /// Test: for each boundary, five points across the window -- the two rims, the quarter points
    /// and the centre -- must give the two band colours mixed in the proportions 0, 1/4, 1/2, 3/4
    /// and 1.
    ///
    /// Verifies the blend's width, its centring and its linearity together. A hard edge fails at
    /// the centre; a window of another width fails at the rims; a window pushed to one side of the
    /// boundary fails a rim and the centre at once.
    #[test]
    fn ring_boundaries_blend_linearly_over_two_texels() {
        // The azimuth at which the offset is antiparallel to the direction, so it subtracts
        // exactly its own length from the texel radius.
        const AZIMUTH_DEGREES: f32 = 315.0;

        let offset_length = ANGLE_RING_LOOKUP_OFFSET_TEXELS[0].hypot(ANGLE_RING_LOOKUP_OFFSET_TEXELS[1]);

        // Inverse of angle_ring_texel_radius along that azimuth.
        let tilt_for_texel_radius = |texel_radius: f32| {
            ((texel_radius + offset_length) / ANGLE_RING_LOOKUP_RADIUS_TEXELS)
                .asin()
                .to_degrees()
        };

        for (index, boundary) in ANGLE_RING_RADII_TEXELS.iter().enumerate() {
            let inner = ANGLE_RING_COLORS[index];
            let outer = ANGLE_RING_COLORS[index + 1];

            // Written as literal texel offsets rather than fractions of
            // ANGLE_RING_BLEND_TEXELS, so that this test pins the window's absolute width. Derived
            // from the constant it would only check that the blend is linear and centred, and a
            // build with any other width would still pass.
            for (offset_texels, expected_fraction) in [
                (-1.0f32, 0.0f32),
                (-0.5, 0.25),
                (0.0, 0.5),
                (0.5, 0.75),
                (1.0, 1.0),
            ] {
                let wanted_radius = boundary + offset_texels;
                let tilt = tilt_for_texel_radius(wanted_radius);
                let direction = direction_at_tilt(tilt, AZIMUTH_DEGREES);

                // The round trip through asin and sin is not exact, so confirm the point really
                // landed where it was aimed before reading a colour off it.
                let actual_radius = angle_ring_texel_radius(direction);
                assert!(
                    (actual_radius - wanted_radius).abs() < 1e-3,
                    "aimed at texel radius {} but landed at {}",
                    wanted_radius,
                    actual_radius
                );

                let expected = inner + (outer - inner) * expected_fraction;
                let radiance = angle_rings_radiance(direction);

                assert!(
                    (radiance - expected).norm() < 1e-3,
                    "at texel radius {} (boundary {} {:+}) expected {:?}, got {:?}",
                    wanted_radius,
                    boundary,
                    offset_texels,
                    expected,
                    radiance
                );
            }
        }
    }

    /// The lookup constants must be the ones T-0030 measured and T-0056 adopted, and the boundary
    /// tilts and blend widths they imply must be the documented ones.
    ///
    /// These four numbers are the entire model, and three of them are small corrections whose
    /// effect is easy to mistake for noise if one is mistyped. Pinning the constants alone would
    /// not catch a wrong one being *used* correctly somewhere else, so this also derives what they
    /// mean in degrees and checks that.
    ///
    /// Setup: the constants, plus for each ring boundary the nominal tilt `asin(r / R)` and the
    /// width of one texel in degrees there, `1 / (R cos(tilt))` in radians.
    ///
    /// Test:
    /// - the constants are exactly GCS's measured radii, the fitted radius scale, the half-texel
    ///   offset and the doubled antialiasing width;
    /// - the nominal boundaries fall at 15.997, 30.261 and 49.105 degrees;
    /// - those sit 0.128, 0.262 and 0.516 degrees outside T-0033's hard edges, which used a
    ///   radius scale of 128, so the shift the radius scale is responsible for is accounted for;
    /// - one texel spans 0.47, 0.52 and 0.69 degrees of tilt at the three boundaries, matching
    ///   what T-0030 measured on GCS's own map.
    ///
    /// Verifies a mistyped digit in any of the four, and any change of lookup law: reading the
    /// radius as a linear angle, `r / R x 90`, would put the boundaries at 24.8 / 45.4 / 68.0.
    #[test]
    fn angle_ring_lookup_constants_are_the_measured_ones() {
        assert_eq!(
            ANGLE_RING_RADII_TEXELS,
            [35.0, 64.0, 96.0],
            "the ring radii measured in GCS's Angle Rings.png"
        );
        assert_eq!(
            ANGLE_RING_LOOKUP_RADIUS_TEXELS, 127.0,
            "the fitted radius scale, not the geometric 128"
        );
        assert_eq!(
            ANGLE_RING_LOOKUP_OFFSET_TEXELS,
            [-0.5, 0.5],
            "half a texel on each axis, opposite in sign"
        );
        assert_eq!(
            ANGLE_RING_BLEND_TEXELS, 2.0,
            "one texel of antialiasing, doubled by bilinear filtering"
        );

        // T-0033's hard edges, asin(r / 128), which this model replaced.
        const PREVIOUS_EDGES_DEGREES: [f64; 3] = [15.868921, 30.0, 48.590378];
        const NOMINAL_TILTS_DEGREES: [f64; 3] = [15.997, 30.261, 49.105];
        const TEXEL_IN_DEGREES: [f64; 3] = [0.47, 0.52, 0.69];
        const SHIFT_DEGREES: [f64; 3] = [0.128, 0.262, 0.516];

        let scale = ANGLE_RING_LOOKUP_RADIUS_TEXELS as f64;

        for (index, boundary) in ANGLE_RING_RADII_TEXELS.iter().enumerate() {
            let tilt = (*boundary as f64 / scale).asin();
            let degrees = tilt.to_degrees();

            assert!(
                (degrees - NOMINAL_TILTS_DEGREES[index]).abs() < 0.01,
                "boundary {} should sit at {} degrees, got {}",
                boundary,
                NOMINAL_TILTS_DEGREES[index],
                degrees
            );

            let shift = degrees - PREVIOUS_EDGES_DEGREES[index];
            assert!(
                (shift - SHIFT_DEGREES[index]).abs() < 0.01,
                "boundary {} should sit {} degrees outside T-0033's edge, got {}",
                boundary,
                SHIFT_DEGREES[index],
                shift
            );

            // How much tilt one texel of map covers here: ds = R cos(tilt) dtheta.
            let texel_degrees = (1.0 / (scale * tilt.cos())).to_degrees();
            assert!(
                (texel_degrees - TEXEL_IN_DEGREES[index]).abs() < 0.01,
                "one texel at boundary {} should span {} degrees, got {}",
                boundary,
                TEXEL_IN_DEGREES[index],
                texel_degrees
            );
        }
    }

    /// The rings must be eccentric by exactly the half-texel lookup offset, and by no more.
    ///
    /// **This test asserts the opposite of the one it replaces.** Until T-0056 the model depended
    /// only on tilt, and a test here pinned that: azimuth leaking in would have meant a mistake in
    /// the equirectangular mapping, turning the rings into spirals. Since T-0056 the rings are
    /// deliberately off-centre, because GCS's are -- it reads its map half a texel off centre --
    /// and that eccentricity is what reproduces 76-83% of the colour differences GCS shows between
    /// symmetric copies of the same facet in a face-up render, which a tilt-only model cannot
    /// produce at all.
    ///
    /// So azimuth dependence is now intended, and what needs pinning is its size and direction:
    /// too large and the rings become visible spirals, too small and the asymmetry the offset was
    /// adopted for disappears.
    ///
    /// Setup: a full turn of azimuth in 1-degree steps, at four tilts. The offset has length
    /// hypot(0.5, 0.5) = 0.7071 texels and points along azimuth 135 degrees.
    ///
    /// Test: over a turn the texel radius must swing by exactly twice the offset's length, and its
    /// maximum must fall at azimuth 135 with its minimum opposite at 315. The swing is
    /// independent of tilt, because adding a fixed vector to a rotating one of any length moves
    /// the result's magnitude between `length - |offset|` and `length + |offset|`.
    ///
    /// Verifies the offset's magnitude and its direction. Dropping the offset collapses the swing
    /// to zero; the mirrored (+0.5, -0.5), which T-0030 measured as worse than no offset at all,
    /// swaps the two extreme azimuths.
    #[test]
    fn angle_rings_are_eccentric_by_exactly_the_half_texel_offset() {
        let offset_length =
            ANGLE_RING_LOOKUP_OFFSET_TEXELS[0].hypot(ANGLE_RING_LOOKUP_OFFSET_TEXELS[1]);

        for tilt in [5.0f32, 20.0, 40.0, 70.0] {
            let mut smallest = (f32::INFINITY, 0.0f32);
            let mut largest = (f32::NEG_INFINITY, 0.0f32);

            for step in 0..360 {
                let azimuth = step as f32;
                let radius = angle_ring_texel_radius(direction_at_tilt(tilt, azimuth));

                if radius < smallest.0 {
                    smallest = (radius, azimuth);
                }

                if radius > largest.0 {
                    largest = (radius, azimuth);
                }
            }

            let swing = largest.0 - smallest.0;

            assert!(
                (swing - 2.0 * offset_length).abs() < 1e-3,
                "at {} degrees tilt the texel radius swings {} over a turn, expected {}",
                tilt,
                swing,
                2.0 * offset_length
            );
            assert_eq!(
                largest.1, 135.0,
                "at {} degrees tilt the rings should be widest along the offset, azimuth 135",
                tilt
            );
            assert_eq!(
                smallest.1, 315.0,
                "at {} degrees tilt the rings should be tightest opposite the offset, azimuth 315",
                tilt
            );
        }
    }

    /// Every analytical model must be perfectly black below the horizon.
    ///
    /// The manual is explicit that no light arrives from below the horizon in any of
    /// these environments. It is also the single biggest difference from the studio rig,
    /// which has a bounce light underneath, and therefore the main reason a stone changes
    /// appearance so much when the model is switched.
    #[test]
    fn analytical_models_are_black_below_the_horizon() {
        let models: [(&str, fn(Vector3<f32>) -> Vector3<f32>); 3] = [
            ("angle rings", angle_rings_radiance),
            ("isometric", isometric_radiance),
            ("cosine", cosine_radiance),
        ];

        for (name, radiance) in models {
            for tilt in [90.1f32, 100.0, 135.0, 179.9] {
                for azimuth in [0.0f32, 120.0, 240.0] {
                    let value = radiance(direction_at_tilt(tilt, azimuth));

                    assert_eq!(
                        value,
                        Vector3::zeros(),
                        "the {} model emits {:?} at {} degrees tilt, below the horizon",
                        name,
                        value,
                        tilt
                    );
                }
            }
        }
    }

    /// Isometric must be uniform over the whole upper hemisphere.
    ///
    /// Its purpose is to measure light return, which only works if every direction
    /// contributes equally -- any variation would be read as a property of the cut.
    #[test]
    fn isometric_is_uniform_above_the_horizon() {
        let expected = Vector3::repeat(RING_LEVEL);

        for tilt in [0.0f32, 15.0, 45.0, 75.0, 89.9] {
            for azimuth in [0.0f32, 77.0, 200.0] {
                assert_eq!(
                    isometric_radiance(direction_at_tilt(tilt, azimuth)),
                    expected,
                    "isometric varied at {} degrees tilt",
                    tilt
                );
            }
        }
    }

    /// Cosine must be brightest overhead and reach zero at the horizon.
    ///
    /// Concentrating the light about the vertical is what makes this model a probe for head
    /// shadow vulnerability, so the direction of the gradient is the point. An inverted
    /// gradient would report exactly the wrong stones as vulnerable. The exact law,
    /// `1 - sin(tilt)` rather than a cosine, is pinned by the next test.
    #[test]
    fn cosine_falls_from_the_zenith_to_zero_at_the_horizon() {
        let zenith = cosine_radiance(direction_at_tilt(0.0, 0.0)).x;
        let horizon = cosine_radiance(direction_at_tilt(90.0, 0.0)).x;

        assert!(
            (zenith - RING_LEVEL).abs() < 1e-6,
            "cosine should be full brightness overhead, got {}",
            zenith
        );
        assert!(
            horizon.abs() < 1e-6,
            "cosine should vanish at the horizon, got {}",
            horizon
        );

        // Strictly decreasing in tilt.
        let mut previous = f32::INFINITY;

        for tilt in [0.0f32, 10.0, 30.0, 45.0, 60.0, 80.0, 89.0] {
            let value = cosine_radiance(direction_at_tilt(tilt, 15.0)).x;

            assert!(
                value < previous,
                "cosine did not decrease from {} to {} degrees of tilt",
                previous,
                tilt
            );

            previous = value;
        }
    }

    /// Cosine must fall off as `1 - sin(tilt)`, the law fitted to Gem Cut Studio's screenshots,
    /// and not as the cosine its name suggests (T-0004).
    ///
    /// Setup: directions at tilts whose sines are exact or well known: 0 (the zenith), 30
    /// (sine 0.5), 45, 60 and 90 degrees (the horizon), each at a few azimuths, since the model
    /// must not depend on azimuth. Test: evaluate `cosine_radiance` at each, and compare every
    /// channel with `RING_LEVEL * (1 - sin(tilt))`, and also with the true cosine at 30 and 60
    /// degrees. Verifies:
    /// - the zenith is full brightness and the horizon is black;
    /// - 30 degrees gives exactly half brightness (a cosine would give 0.866), which is the value
    ///   that tells the two laws apart most plainly, and 60 degrees gives 0.134 (a cosine, 0.5);
    /// - the value is grey (all three channels equal) and the same at every azimuth.
    ///
    /// A regression to the cosine would make Cosine renders about 70 levels too bright against
    /// GCS with the facet pattern unchanged, which is easy to mistake for a display transfer
    /// problem; this pins the law itself.
    #[test]
    fn cosine_model_falls_off_as_one_minus_the_sine_of_the_tilt() {
        for (tilt, expected) in [
            (0.0f32, 1.0f32),
            (30.0, 0.5),
            (45.0, 1.0 - std::f32::consts::FRAC_1_SQRT_2),
            (60.0, 1.0 - 3.0f32.sqrt() / 2.0),
            (90.0, 0.0),
        ] {
            for azimuth in [0.0f32, 90.0, 233.0] {
                let value = cosine_radiance(direction_at_tilt(tilt, azimuth));

                // Grey: every channel carries the same level.
                assert_eq!(value.x, value.y, "cosine is not grey at {} degrees", tilt);
                assert_eq!(value.y, value.z, "cosine is not grey at {} degrees", tilt);

                assert!(
                    (value.x - RING_LEVEL * expected).abs() < 1e-4,
                    "cosine at {} degrees tilt, azimuth {}, gave {} but 1 - sin(tilt) is {}",
                    tilt,
                    azimuth,
                    value.x,
                    expected
                );
            }
        }

        // The two tilts where a true cosine would be far off, stated directly.
        for tilt in [30.0f32, 60.0] {
            let value = cosine_radiance(direction_at_tilt(tilt, 0.0)).x;
            let true_cosine = tilt.to_radians().cos();

            assert!(
                (value - true_cosine).abs() > 0.3,
                "cosine at {} degrees gave {}, too close to the true cosine {}",
                tilt,
                value,
                true_cosine
            );
        }
    }

    /// A generated Angle Rings map must survive the round trip through half-float packing.
    ///
    /// This checks the band a direction lands in after packing, catching an off-by-one row or
    /// a v-axis flip in `generate_with`, which every environment shares.
    ///
    /// The shader no longer reads the Angle Rings texture: it evaluates the analytical models
    /// exactly (README decision 26). So this guards the generator, and the studio and image
    /// maps that still go through it, not what an Angle Rings render shows (T-0037).
    #[test]
    fn generated_angle_rings_map_reads_back_the_right_bands() {
        let map = generate_with(256, 128, angle_rings_radiance);

        // Avoiding tilts within one texel row of a boundary: a 128-row map is 1.40625
        // degrees per row, so a sample near an edge can legitimately land either side.
        for tilt in [4.0f32, 10.0, 20.0, 26.0, 35.0, 45.0, 60.0, 80.0] {
            let direction = direction_at_tilt(tilt, 63.0);
            let expected = angle_rings_radiance(direction);
            let actual = map.sample_nearest(direction);

            assert_eq!(
                actual, expected,
                "at {} degrees tilt the stored map holds {:?} but the model says {:?}",
                tilt, actual, expected
            );
        }

        // And below the horizon it must still be black after packing.
        let below = map.sample_nearest(direction_at_tilt(120.0, 10.0));

        assert_eq!(below, Vector3::zeros(), "map is not black below the horizon");
    }

    // ------------------------------------------------------------ image environments

    /// Filler colour for the unused cells of a synthetic cross. Magenta, which no face uses,
    /// so sampling it is detectable.
    const FILLER: [u8; 3] = [255, 0, 255];

    /// A distinct flat colour for each entry of `CROSS_FACES`.
    const FACE_COLORS: [[u8; 3]; 6] = [
        [200, 40, 40],
        [40, 200, 40],
        [40, 40, 200],
        [200, 200, 40],
        [40, 200, 200],
        [120, 120, 120],
    ];

    /// Builds an RGBA horizontal cross with each face filled by its `FACE_COLORS` entry and
    /// the six unused cells filled with `FILLER`.
    fn synthetic_cross(face_size: usize) -> (Vec<u8>, u32, u32) {
        let width = face_size * CROSS_COLUMNS;
        let height = face_size * CROSS_ROWS;
        let mut rgba = vec![0u8; width * height * 4];

        for y in 0..height {
            for x in 0..width {
                let cell = (x / face_size, y / face_size);
                let color = CROSS_FACES
                    .iter()
                    .position(|face| (face.column, face.row) == cell)
                    .map_or(FILLER, |index| FACE_COLORS[index]);

                let base = (y * width + x) * 4;

                rgba[base..base + 3].copy_from_slice(&color);
                rgba[base + 3] = 255;
            }
        }

        (rgba, width as u32, height as u32)
    }

    fn linear(color: [u8; 3]) -> Vector3<f32> {
        Vector3::new(
            display_to_linear(color[0]),
            display_to_linear(color[1]),
            display_to_linear(color[2]),
        )
    }

    /// Images that are not a horizontal cross, or whose buffer does not match their size,
    /// must be rejected with a message rather than sampled out of bounds.
    ///
    /// A square or 2:1 image is the likeliest mistake (a sphere map or an equirectangular
    /// panorama), and would otherwise be carved into nonsense faces.
    #[test]
    fn cross_rejects_images_that_are_not_a_horizontal_cross() {
        let (rgba, width, height) = synthetic_cross(8);

        assert!(CubeCross::from_rgba8(&rgba, width, height).is_ok());

        let square = CubeCross::from_rgba8(&vec![0; 64 * 64 * 4], 64, 64).unwrap_err();
        assert!(square.contains("horizontal cross"), "got {:?}", square);

        let panorama = CubeCross::from_rgba8(&vec![0; 64 * 32 * 4], 64, 32).unwrap_err();
        assert!(panorama.contains("horizontal cross"), "got {:?}", panorama);

        let short = CubeCross::from_rgba8(&rgba[4..], width, height).unwrap_err();
        assert!(short.contains("bytes"), "got {:?}", short);

        assert!(CubeCross::from_rgba8(&[], 0, 0).is_err());
    }

    /// Looking straight along each face's axis must land on the centre of that face.
    ///
    /// Setup: a synthetic cross with a distinct colour per face. Test: sample each face's
    /// `forward` direction. Verifies both the image coordinates (the exact cell centre) and
    /// the colour, so a face table that put a face in the wrong cell cannot pass.
    #[test]
    fn each_axis_samples_the_centre_of_its_own_face() {
        let face_size = 16;
        let (rgba, width, height) = synthetic_cross(face_size);
        let cross = CubeCross::from_rgba8(&rgba, width, height).unwrap();

        for (index, face) in CROSS_FACES.iter().enumerate() {
            let (x, y) = cross.pixel_coordinates(face.forward);
            let centre_x = (face.column as f32 + 0.5) * face_size as f32;
            let centre_y = (face.row as f32 + 0.5) * face_size as f32;

            assert!(
                (x - centre_x).abs() < 1e-4 && (y - centre_y).abs() < 1e-4,
                "face {} axis {:?} sampled ({}, {}), expected the cell centre ({}, {})",
                index,
                face.forward,
                x,
                y,
                centre_x,
                centre_y
            );

            let sampled = cross.radiance(face.forward);

            assert!(
                (sampled - linear(FACE_COLORS[index])).norm() < 1e-5,
                "face {} returned {:?}, expected its own colour",
                index,
                sampled
            );
        }
    }

    /// No face may be mirrored.
    ///
    /// For a viewer inside the cube looking along `forward`, `right x up` must point back
    /// at the viewer. A mirrored face would reverse text and turn a panorama the wrong way,
    /// which reads as a subtly wrong room rather than an obvious fault.
    #[test]
    fn no_cube_face_is_mirrored() {
        for face in CROSS_FACES {
            let back = face.right.cross(&face.up);

            assert!(
                (back + face.forward).norm() < 1e-6,
                "face at column {} row {} is mirrored: right x up = {:?}, forward = {:?}",
                face.column,
                face.row,
                back,
                face.forward
            );
        }
    }

    /// Every edge that two faces share in the picture must be the same edge on the cube.
    ///
    /// Setup: for each pair of faces in adjacent cells, directions just either side of
    /// their shared cube edge, at several points along it. Test: map both to image
    /// coordinates. Verifies they land within a pixel and a half of each other, which is
    /// what a seamless environment requires. A face rotated by 90 or 180 degrees still
    /// samples its own colour at its centre, so only a test at the edges catches it.
    #[test]
    fn faces_adjacent_in_the_image_meet_seamlessly_on_the_cube() {
        let face_size = 64;
        let (rgba, width, height) = synthetic_cross(face_size);
        let cross = CubeCross::from_rgba8(&rgba, width, height).unwrap();

        let mut pairs_checked = 0;

        for a in &CROSS_FACES {
            for b in &CROSS_FACES {
                let adjacent = (a.row == b.row && a.column + 1 == b.column)
                    || (a.column == b.column && a.row + 1 == b.row);

                if !adjacent {
                    continue;
                }

                pairs_checked += 1;

                let along = a.forward.cross(&b.forward).normalize();

                for t in [-0.8f32, -0.4, 0.0, 0.4, 0.8] {
                    let edge = a.forward + b.forward + along * t;
                    let nudge = (a.forward - b.forward) * 1e-3;

                    let (ax, ay) = cross.pixel_coordinates(edge + nudge);
                    let (bx, by) = cross.pixel_coordinates(edge - nudge);

                    assert!(
                        CubeCross::face_for(edge + nudge) == a
                            && CubeCross::face_for(edge - nudge) == b,
                        "the nudged directions did not straddle the edge"
                    );
                    assert!(
                        (ax - bx).hypot(ay - by) < 1.5,
                        "seam between {:?} and {:?} at t = {} is torn: ({}, {}) vs ({}, {})",
                        a.forward,
                        b.forward,
                        t,
                        ax,
                        ay,
                        bx,
                        by
                    );
                }
            }
        }

        // Three seams along the middle row plus the top and bottom faces' hinges.
        assert_eq!(pairs_checked, 5, "expected five adjacent pairs in a horizontal cross");
    }

    /// The panorama must wrap: the right edge of the last column and the left edge of the
    /// first are the same cube edge, even though they are far apart in the image.
    #[test]
    fn middle_row_panorama_wraps_around() {
        let last = CROSS_FACES.iter().find(|f| f.row == 1 && f.column == 3).unwrap();
        let first = CROSS_FACES.iter().find(|f| f.row == 1 && f.column == 0).unwrap();

        assert_eq!(last.right, first.forward, "turning right from the last face must reach the first");
        assert_eq!(last.up, first.up);
    }

    /// No direction may ever sample the unused filler cells.
    ///
    /// Setup: a synthetic cross with magenta filler. Test: sample 4000 directions spread
    /// evenly over the sphere, including the regions near cube corners where three faces
    /// meet. Verifies each lands inside a face cell, at least half a pixel from its border,
    /// and never picks up filler colour through the bilinear filter.
    #[test]
    fn sampling_never_reaches_the_filler_cells() {
        let face_size = 8;
        let (rgba, width, height) = synthetic_cross(face_size);
        let cross = CubeCross::from_rgba8(&rgba, width, height).unwrap();
        let filler = linear(FILLER);
        let size = face_size as f32;

        let samples = 4000;

        for i in 0..samples {
            let t = (i as f32 + 0.5) / samples as f32;
            let y = 1.0 - 2.0 * t;
            let radius = (1.0 - y * y).max(0.0).sqrt();
            let theta = 2.399_963_2 * i as f32;
            let direction = Vector3::new(radius * theta.cos(), y, radius * theta.sin());

            let (x, image_y) = cross.pixel_coordinates(direction);
            let cell = ((x / size).floor() as usize, (image_y / size).floor() as usize);
            let local = (x - cell.0 as f32 * size, image_y - cell.1 as f32 * size);

            assert!(
                CROSS_FACES.iter().any(|f| (f.column, f.row) == cell),
                "direction {:?} sampled unused cell {:?}",
                direction,
                cell
            );
            assert!(
                local.0 >= 0.5 - 1e-4
                    && local.0 <= size - 0.5 + 1e-4
                    && local.1 >= 0.5 - 1e-4
                    && local.1 <= size - 0.5 + 1e-4,
                "direction {:?} sampled ({}, {}), within half a pixel of its cell border",
                direction,
                x,
                image_y
            );

            let sampled = cross.radiance(direction);

            // Every face colour has a green channel of at least 40; filler has none. Any
            // blend towards filler lowers green below the smallest face value.
            assert!(
                sampled.y >= display_to_linear(40) - 1e-5,
                "direction {:?} picked up filler colour: {:?} (filler {:?})",
                direction,
                sampled,
                filler
            );
        }
    }

    /// The shader evaluates the analytical models itself (T-0023: reading them from the
    /// environment texture smeared every ring edge by about 0.18 degrees), so its definitions
    /// must be this module's.
    ///
    /// Setup: the shader source text, and the Rust constants that define the models. Test: look
    /// for each shader constant written from the Rust values. Verifies:
    /// - the four Angle Rings lookup constants: ring radii, radius scale, half-texel offset and
    ///   blend width (T-0056);
    /// - that the shader no longer carries the hard tilt edges those replaced, so a half-applied
    ///   revert cannot leave the two languages describing different models;
    /// - the four ring colours, in order, and the ring level;
    /// - the Cosine model's `1 - sin(tilt)` expression, as `cosine_radiance` evaluates it
    ///   (T-0004: GCS's Cosine is not a true cosine, so a shader reverting to one must fail);
    /// - the lighting model numbering the shader branches on.
    ///
    /// Nothing else connects the two languages, and a drift would not fail loudly: a band would
    /// simply sit at a slightly different angle, or a model would fall back to the texture.
    #[test]
    fn shader_analytical_lighting_matches_the_rust_models() {
        use crate::params::LightingModel;

        let shader = include_str!("shaders/gem.frag");

        let expected_radii = format!(
            "const vec3 ANGLE_RING_RADII_TEXELS = vec3({:?}, {:?}, {:?});",
            ANGLE_RING_RADII_TEXELS[0], ANGLE_RING_RADII_TEXELS[1], ANGLE_RING_RADII_TEXELS[2]
        );
        assert!(shader.contains(&expected_radii), "gem.frag must declare {}", expected_radii);

        let expected_scale = format!(
            "const float ANGLE_RING_LOOKUP_RADIUS_TEXELS = {:?};",
            ANGLE_RING_LOOKUP_RADIUS_TEXELS
        );
        assert!(shader.contains(&expected_scale), "gem.frag must declare {}", expected_scale);

        let expected_offset = format!(
            "const vec2 ANGLE_RING_LOOKUP_OFFSET_TEXELS = vec2({:?}, {:?});",
            ANGLE_RING_LOOKUP_OFFSET_TEXELS[0], ANGLE_RING_LOOKUP_OFFSET_TEXELS[1]
        );
        assert!(shader.contains(&expected_offset), "gem.frag must declare {}", expected_offset);

        let expected_blend = format!(
            "const float ANGLE_RING_BLEND_TEXELS = {:?};",
            ANGLE_RING_BLEND_TEXELS
        );
        assert!(shader.contains(&expected_blend), "gem.frag must declare {}", expected_blend);

        // The model T-0056 replaced. Leaving either of these behind would mean the shader is still
        // stepping between hard bands, whatever the new constants say.
        assert!(
            !shader.contains("ANGLE_RING_EDGES_DEGREES"),
            "gem.frag still carries the hard tilt edges T-0056 replaced"
        );
        assert!(
            !shader.contains("if (tilt < 90.0)"),
            "gem.frag still branches on tilt for the horizon; analyticalRadiance returns earlier"
        );

        for (name, color) in ["RING_RED", "RING_CYAN", "RING_YELLOW", "RING_MAGENTA"]
            .iter()
            .zip(ANGLE_RING_COLORS.iter())
        {
            let expected = format!(
                "const vec3 {} = vec3({:?}, {:?}, {:?});",
                name,
                color.x / RING_LEVEL,
                color.y / RING_LEVEL,
                color.z / RING_LEVEL
            );
            assert!(shader.contains(&expected), "gem.frag must declare {}", expected);
        }

        let level = format!("const float RING_LEVEL = {:?};", RING_LEVEL);
        assert!(shader.contains(&level), "gem.frag must declare {}", level);

        // The Cosine law. The Rust side is checked numerically by
        // cosine_model_falls_off_as_one_minus_the_sine_of_the_tilt; here the shader must spell
        // the same law, and must return the plain height only behind tilt performance's switch
        // (T-0261, RenderParams::true_cosine): the one true cosine in the file is the guarded one.
        let cosine_law = "return vec3(RING_LEVEL * (1.0 - sqrt(max(1.0 - height * height, 0.0))));";
        assert!(shader.contains(cosine_law), "gem.frag's Cosine model must be {}", cosine_law);
        let true_cosine = "return vec3(RING_LEVEL * height);";
        assert_eq!(
            shader.matches(true_cosine).count(),
            1,
            "gem.frag's Cosine model returns the true cosine outside tilt performance's switch"
        );
        assert!(
            shader.contains(&format!("if (uTrueCosine != 0) {{\n            {}", true_cosine)),
            "gem.frag's true cosine must sit behind uTrueCosine"
        );

        for (name, model) in [
            ("LIGHTING_ANGLE_RINGS", LightingModel::AngleRings),
            ("LIGHTING_ISOMETRIC", LightingModel::Isometric),
            ("LIGHTING_COSINE", LightingModel::Cosine),
        ] {
            let expected = format!("const int {} = {};", name, model.as_u32());
            assert!(shader.contains(&expected), "gem.frag must declare {}", expected);
        }
    }

    /// The shader must encode with the same gamma this module decodes with, and must
    /// number its gamma display transfer as `ToneMapMode::Gamma` does.
    ///
    /// Checked against the shader source text, because the two live in different languages
    /// and nothing else connects them. A mismatch would not fail loudly: image environments
    /// would render slightly too dark or too bright.
    #[test]
    fn shader_display_gamma_and_tone_map_numbering_match_the_rust_side() {
        let shader = include_str!("shaders/gem.frag");

        assert!(
            shader.contains(&format!("const float DISPLAY_GAMMA = {:.1};", DISPLAY_GAMMA)),
            "gem.frag must declare DISPLAY_GAMMA = {}",
            DISPLAY_GAMMA
        );
        assert!(
            shader.contains(&format!(
                "const int TONEMAP_GAMMA = {};",
                crate::params::ToneMapMode::Gamma.as_u32()
            )),
            "gem.frag's TONEMAP_GAMMA must equal ToneMapMode::Gamma"
        );
    }

    /// Decoding with `DISPLAY_GAMMA` and re-encoding with its inverse, as the shader does,
    /// must return every 8-bit value unchanged, so an image environment seen straight
    /// through a refraction-free path keeps its own colours.
    #[test]
    fn display_gamma_round_trips_every_byte() {
        for value in 0..=255u8 {
            let encoded = display_to_linear(value).powf(1.0 / DISPLAY_GAMMA) * 255.0;

            assert_eq!(
                encoded.round() as u8,
                value,
                "byte {} came back as {}",
                value,
                encoded
            );
        }
    }
}
