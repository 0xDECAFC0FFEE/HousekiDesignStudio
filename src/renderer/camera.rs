//! Orbit camera.
//!
//! The renderer traces rays from a full-screen quad rather than rasterising
//! geometry, so the camera never produces a view or projection matrix. It produces
//! an origin plus an orthonormal basis, and the shader builds a ray per pixel from
//! those directly. That is both cheaper and easier to reason about than inverting a
//! projection matrix.
//!
//! Three projections are supported:
//!
//! - **Gem Cut Studio's camera, the default.** A perspective eye `eye_distance` (52 world
//!   units) from the target, measured from GCS's own outlines (T-0041, T-0044). Its field of
//!   view makes the view at the target exactly as tall as the orthographic one, so the framing
//!   measured from GCS's screenshots holds, and zoom magnifies without moving the eye.
//! - **Orthographic**, with `eye_distance` 0: every ray travels along `forward`, and it is the
//!   ray *origins* that spread across a plane through the eye. It was the default until T-0044,
//!   when GCS was measured to be slightly perspective.
//! - **A lens**, with a positive `vertical_fov`: every ray starts at an eye `distance` from the
//!   target and fans out, and zoom moves the eye. Nothing is matched to it.
//!
//! Matching GCS's images is the point of the defaults (see `reference/` and ticket T-0014).

use nalgebra::{Point3, Vector3};
use std::f32::consts::{PI, TAU};

/// World up. The mesh conditioner reorients each stone's optical axis onto +Y so
/// this stays fixed.
pub const WORLD_UP: Vector3<f32> = Vector3::new(0.0, 1.0, 0.0);

pub const MIN_DISTANCE: f32 = 1.2;
pub const MAX_DISTANCE: f32 = 40.0;

pub const DEFAULT_DISTANCE: f32 = 4.0;

/// Fields of view below this are treated as exactly zero, meaning no lens.
///
/// A perspective lens this narrow is not a useful approximation of orthographic at
/// any orbit distance the camera allows: at `DEFAULT_DISTANCE` it shows a window
/// 0.1 world units tall onto a stone of radius 1. Snapping keeps the smallest fields of
/// view, set with `set_param("fov")` (the page no longer has a slider), from being a band
/// of uselessly magnified views.
pub const MIN_PERSPECTIVE_FOV: f32 = 0.05;
pub const MAX_FOV: f32 = 2.0;

/// Half the height of the view at the target at `DEFAULT_DISTANCE`, in world units, for both
/// the default perspective camera and the orthographic one.
///
/// Measured from `reference/application_images/hex_cut_v2/hex_cut_v2_gcs_front_random.png`. There, the stone is centred at
/// (584, 489) px, which places Gem Cut Studio's viewport at about 1168 x 978 px, and
/// the girdle spans 735 px corner to corner: 0.7515 of the viewport height. The mesh
/// conditioner scales `hex_cut_v2.obj` so its farthest vertex sits at radius 1, which
/// leaves the girdle corners at radius 0.97985, the top of the girdle band 0.19978 nearer the
/// eye than the target. GCS's eye, `GEM_CUT_STUDIO_EYE_DISTANCE` away, magnifies them by
/// 52 / (52 - 0.19978) = 1.00386. So the view is 2 x 0.97985 x 1.00386 / 0.7515 = 2.618 world
/// units tall at the target, and its half-height is 1.309. The same measurement read
/// orthographically gave 1.304, the value until T-0044; kept, it would draw the girdle 3 px too
/// wide.
///
/// It was fitted on the hex cut only. The conditioner scales by the farthest vertex, not the
/// girdle, so a stone whose farthest vertex sits further out than its girdle renders smaller
/// than in GCS: the oval cut by 2.6% (T-0027).
pub const DEFAULT_VIEW_HALF_HEIGHT: f32 = 1.309;

/// How far Gem Cut Studio's eye is from the target, in world units: the default `eye_distance`.
///
/// Measured from outlines alone, so independent of lighting (T-0041). GCS screenshots of the
/// oval cut at X Rotation +60 and -60 gave about 1,600 sub-pixel edge points each, fitted to the
/// silhouette of `resources/oval_cut.obj`. A perspective camera fits them to 0.51 px RMS, against
/// 0.67 px for orthographic. Corrected for the bias GCS's aliased edges give the fit, the eye is
/// about 54 of the oval cut's girdle radii from its centre, and that girdle radius is 0.957 here:
/// 52 world units, give or take about 4. `tests/gcs_camera_outline.rs` checks it against the +60
/// screenshot in Cosine lighting, `reference/application_images/oval_cut/oval_cut_gcs_x60_cosine.png`.
pub const GEM_CUT_STUDIO_EYE_DISTANCE: f32 = 52.0;

/// Largest `eye_distance`. The cap keeps 32-bit ray distances precise: at 1000 units a float
/// step is 6e-5 world units, a fiftieth of a pixel at the default zoom. For no perspective at
/// all, use 0, orthographic.
pub const MAX_EYE_DISTANCE: f32 = 1000.0;

/// Largest sine of the angle between light leaving the stone and the view axis that still
/// counts as heading exactly back at the orthographic camera's observer (see
/// `CameraBasis::observer_blocks`).
///
/// Float noise in a facet normal is around 1e-6, so a face-up table reflection is always
/// inside it. Tilting the stone by 0.003 degrees turns table reflections by 1e-4, so any tilt
/// a person would set moves them outside it and the dot disappears, as it does in Gem Cut
/// Studio. Must match `OBSERVER_ALIGNMENT_TOLERANCE` in `gem.frag`; a test enforces that.
pub const OBSERVER_ALIGNMENT_TOLERANCE: f32 = 1e-4;

/// Radius of the observer's body at a perspective eye, as a multiple of the observer radius (see
/// `CameraBasis::observer_blocks`).
///
/// Face-up, the table reflects light leaving `r` from the view axis so that it crosses the eye's
/// plane `2r` from the axis. A body of twice the radius at the eye therefore blocks exactly the
/// reflections from within the radius, the dot measured in Gem Cut Studio's screenshots. Must
/// match `OBSERVER_EYE_RADIUS_SCALE` in `gem.frag`; a test enforces that.
pub const OBSERVER_EYE_RADIUS_SCALE: f32 = 2.0;

/// How far below the lighting horizon, as a sine, a facet's outward normal must point for light
/// leaving through it to count as coming from behind the stone (see
/// `CameraBasis::light_comes_from_behind`).
///
/// A vertical girdle facet's normal is level only to within float noise, about 1e-6, and without
/// a margin its exits would speckle between the two rules. Must match `BACK_FACET_TOLERANCE` in
/// `gem.frag`; a test enforces that.
pub const BACK_FACET_TOLERANCE: f32 = 1e-4;

/// Distance from the world origin, in world units, at which primary rays start to be traced (see
/// `CameraBasis::ray_start`).
///
/// The mesh conditioner centres every stone on the origin and scales it to radius 1, so the stone
/// lies inside this sphere with a margin far beyond float error. Starting there rather than at Gem
/// Cut Studio's eye, 52 units away, keeps the triangle test's arithmetic near unit size. From the eye,
/// f32 cancellation put primary hits on small triangles up to 2e-3 off the surface, twenty times the
/// shader's surface epsilon, so the interior march could start outside the stone (T-0032). Must
/// match `PRIMARY_RAY_START_RADIUS` in `gem.frag`; a test enforces that.
pub const PRIMARY_RAY_START_RADIUS: f32 = 1.05;

/// View half-height at the target per unit of orbit distance, for the default perspective
/// camera and the orthographic one.
///
/// Neither moves its eye to zoom. Moving an orthographic eye changes nothing by itself, and
/// moving Gem Cut Studio's eye would change its measured perspective. Scaling the view with
/// `distance` instead is what makes the scroll wheel a zoom in both.
pub const VIEW_HALF_HEIGHT_PER_DISTANCE: f32 = DEFAULT_VIEW_HALF_HEIGHT / DEFAULT_DISTANCE;

/// How far off the optical axis, as the sine of the angle, a facet normal may be and still count
/// as lying along it in `OrbitCamera::orientation_facing`, which then keeps the current spin
/// rather than taking one from the normal's direction. A table's normal, computed from float
/// vertices, is off the axis by rounding error, and the direction of that error would otherwise
/// spin the view to an arbitrary angle. 1e-4 is 0.006 degrees, far below any cut facet's angle.
pub const FACING_AXIS_TOLERANCE: f32 = 1e-4;

/// The camera's pose is two angles, both wrapped into `[-PI, PI)`:
///
/// - `spin` turns the stone about its optical axis (world +Y). The page's X rotation slider.
/// - `tilt` tips that axis towards or away from the viewer, about the screen's horizontal
///   axis. Zero looks straight down onto the table. Positive tilt matches Gem Cut Studio's
///   positive "X Rotation" (its 23 degree screenshots are `tilt = 23°`); negative tilts the
///   other way. The page's Y rotation slider.
///
/// The basis is built by rotating a fixed face-up frame rather than by crossing the view
/// direction with world up, so it has no pole: tilt passes straight through face-up and
/// through face-down with the image turning smoothly, and no clamp is needed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OrbitCamera {
    /// Rotation about the optical axis, in radians.
    pub spin: f32,
    /// Tilt of the optical axis away from the view direction, in radians.
    pub tilt: f32,
    /// The zoom. Without a lens it sets the view's height at the target
    /// (`VIEW_HALF_HEIGHT_PER_DISTANCE`); with one, it is how far away the eye is.
    pub distance: f32,
    pub target: Point3<f32>,
    /// Vertical field of view of a lens, in radians. Zero means no lens, and `eye_distance`
    /// selects the projection. Like the other projections it is measured across the viewport's
    /// smaller dimension, so in a portrait viewport it is the horizontal field of view (see
    /// `basis`).
    pub vertical_fov: f32,
    /// Without a lens, how far the eye is from the target, in world units: Gem Cut Studio's
    /// perspective camera by default (`GEM_CUT_STUDIO_EYE_DISTANCE`). Zero means orthographic.
    pub eye_distance: f32,
}

impl Default for OrbitCamera {
    fn default() -> Self {
        OrbitCamera {
            // With spin 0, screen right is world +X. `hex_cut_v2.obj` has girdle corners
            // on its X axis, so they point left and right, as in the Gem Cut Studio
            // front view.
            spin: 0.0,
            // Looking straight down the optical axis at the table. This is the view GCS
            // renders by default and the one its assessment models are defined for.
            tilt: 0.0,
            distance: DEFAULT_DISTANCE,
            target: Point3::origin(),
            // No lens.
            vertical_fov: 0.0,
            // Gem Cut Studio's perspective, measured from its outlines (T-0041).
            eye_distance: GEM_CUT_STUDIO_EYE_DISTANCE,
        }
    }
}

/// Everything the shader needs to build a primary ray.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraBasis {
    pub origin: Point3<f32>,
    pub forward: Vector3<f32>,
    pub right: Vector3<f32>,
    pub up: Vector3<f32>,
    /// Zero in orthographic mode.
    pub tan_half_fov: f32,
    /// Half the height of the view in world units in orthographic mode, zero in
    /// perspective mode. The shader uses the sign to choose the projection.
    pub orthographic_half_height: f32,
    pub aspect: f32,
}

impl OrbitCamera {
    /// Adds to spin and tilt, in radians, wrapping both into a single turn so they cannot
    /// drift without bound during long drags.
    pub fn orbit(&mut self, delta_spin: f32, delta_tilt: f32) {
        if !delta_spin.is_finite() || !delta_tilt.is_finite() {
            return;
        }

        self.set_orientation(self.spin + delta_spin, self.tilt + delta_tilt);
    }

    /// Sets spin and tilt, in radians, wrapped into `[-PI, PI)`. Non-finite input leaves
    /// the pose alone.
    pub fn set_orientation(&mut self, spin: f32, tilt: f32) {
        if !spin.is_finite() || !tilt.is_finite() {
            return;
        }

        self.spin = wrap_angle(spin);
        self.tilt = wrap_angle(tilt);
    }

    /// The pose, as `(spin, tilt)` in radians, that looks squarely at a facet whose outward
    /// normal is `normal`: the eye sits along the normal, so the facet faces the viewer. `None`
    /// for a zero or non-finite normal. Used by the page to turn the stone towards a clicked
    /// facet (`GemApp::facet_pose_at`).
    ///
    /// Screen right is always horizontal (see `basis`), so the pose has no free roll, and every
    /// direction off the optical axis has exactly two such poses, `(spin, tilt)` and
    /// `(spin + PI, -tilt)`: the same view turned half a turn in the image. The one nearer the
    /// current pose is returned, so a click never turns the picture upside down. A normal along
    /// the optical axis (the table, or a culet facet) fixes only the tilt, and the current spin
    /// is kept, so clicking the table of a spun stone does not also unspin it.
    pub fn orientation_facing(&self, normal: Vector3<f32>) -> Option<(f32, f32)> {
        let length = normal.norm();

        if !length.is_finite() || length <= 0.0 {
            return None;
        }

        let normal = normal / length;

        // Inverts `towards_eye`, which is (sin tilt sin spin, cos tilt, sin tilt cos spin).
        let tilt = normal.y.clamp(-1.0, 1.0).acos();
        let horizontal = (normal.x * normal.x + normal.z * normal.z).sqrt();

        if horizontal < FACING_AXIS_TOLERANCE {
            return Some((self.spin, wrap_angle(tilt)));
        }

        let spin = normal.x.atan2(normal.z);

        [(spin, tilt), (spin + PI, -tilt)]
            .into_iter()
            .map(|(spin, tilt)| (wrap_angle(spin), wrap_angle(tilt)))
            .min_by(|a, b| self.turn_to(*a).total_cmp(&self.turn_to(*b)))
    }

    /// How far, in radians of spin plus radians of tilt, the camera would turn to reach `pose`,
    /// each the short way round.
    fn turn_to(&self, pose: (f32, f32)) -> f32 {
        wrap_angle(pose.0 - self.spin).abs() + wrap_angle(pose.1 - self.tilt).abs()
    }

    /// Scales the orbit distance, which zooms. `factor` above 1 zooms out.
    ///
    /// Without a lens this scales the view and leaves the eye where it is; with a lens it moves
    /// the eye. Multiplicative rather than additive so a wheel notch feels the same at every
    /// distance, which is the whole reason zoom is exponential in every viewer.
    pub fn zoom(&mut self, factor: f32) {
        if !factor.is_finite() || factor <= 0.0 {
            return;
        }

        self.distance = (self.distance * factor).clamp(MIN_DISTANCE, MAX_DISTANCE);
    }

    /// Sets the vertical field of view of a lens, in radians. Values below
    /// `MIN_PERSPECTIVE_FOV`, including zero, remove the lens, leaving the projection
    /// `eye_distance` selects.
    pub fn set_vertical_fov(&mut self, radians: f32) {
        if !radians.is_finite() {
            return;
        }

        self.vertical_fov = if radians < MIN_PERSPECTIVE_FOV {
            0.0
        } else {
            radians.min(MAX_FOV)
        };
    }

    /// Sets how far the eye is from the target when there is no lens, in world units. Zero or
    /// less selects orthographic. Other values are clamped to `MIN_DISTANCE`, which keeps the eye
    /// outside the unit-radius stone, up to `MAX_EYE_DISTANCE`. Non-finite input leaves it alone.
    pub fn set_eye_distance(&mut self, distance: f32) {
        if !distance.is_finite() {
            return;
        }

        self.eye_distance = if distance <= 0.0 {
            0.0
        } else {
            distance.clamp(MIN_DISTANCE, MAX_EYE_DISTANCE)
        };
    }

    /// True when every ray is parallel: no lens and no eye distance.
    pub fn is_orthographic(&self) -> bool {
        self.vertical_fov <= 0.0 && self.eye_distance <= 0.0
    }

    /// Half the height of the view at the target, when there is no lens.
    ///
    /// `basis` widens this to a half-*width* in a viewport narrower than it is tall, so that the
    /// framing always fits the smaller dimension.
    fn view_half_height(&self) -> f32 {
        self.distance * VIEW_HALF_HEIGHT_PER_DISTANCE
    }

    /// How far the eye is from the target. For orthographic, that is the plane the rays start
    /// from.
    fn eye_offset(&self) -> f32 {
        if self.vertical_fov <= 0.0 && self.eye_distance > 0.0 {
            self.eye_distance
        } else {
            self.distance
        }
    }

    /// Unit vector from the target to the eye.
    ///
    /// Face-up (tilt 0) this is world up. Tilting swings it about `right` towards world +Z
    /// (at spin 0), and spin turns the whole arrangement about world up.
    fn towards_eye(&self) -> Vector3<f32> {
        let (sin_tilt, cos_tilt) = self.tilt.sin_cos();
        let (sin_spin, cos_spin) = self.spin.sin_cos();

        Vector3::new(sin_tilt * sin_spin, cos_tilt, sin_tilt * cos_spin)
    }

    /// Camera position in world space: the eye of a perspective projection, or the centre of
    /// the plane orthographic rays start from.
    pub fn eye(&self) -> Point3<f32> {
        self.target + self.towards_eye() * self.eye_offset()
    }

    /// Builds the ray basis for a viewport of the given aspect ratio (width over
    /// height).
    ///
    /// The framing fits the viewport's **smaller** dimension: the view is the measured height tall
    /// in a landscape viewport, and the same measurement wide in a portrait one, so the stone is
    /// never cut off by a narrow window (T-0074). Landscape and square viewports are unaffected,
    /// bit for bit.
    pub fn basis(&self, aspect: f32) -> CameraBasis {
        let origin = self.eye();
        let forward = -self.towards_eye();

        // Screen right is world +X turned by the spin. Tilt rotates about this axis, so it
        // never changes it, and it is always perpendicular to `forward`. That is what makes
        // the basis defined at every pose, face-up and face-down included.
        let (sin_spin, cos_spin) = self.spin.sin_cos();
        let right = Vector3::new(cos_spin, 0.0, -sin_spin);
        let up = right.cross(&forward);

        let safe_aspect = if aspect.is_finite() && aspect > 0.0 {
            aspect
        } else {
            1.0
        };

        let (tan_half_fov, orthographic_half_height) = if self.vertical_fov > 0.0 {
            ((self.vertical_fov * 0.5).tan(), 0.0)
        } else if self.eye_distance > 0.0 {
            // Gem Cut Studio's camera: a lens exactly wide enough for the view at the target to
            // be as tall as the orthographic one, so the framing measured from GCS holds.
            (self.view_half_height() / self.eye_distance, 0.0)
        } else {
            (0.0, self.view_half_height())
        };

        // Fit the framing to the viewport's smaller dimension (T-0074). Each half-extent above is
        // a half-*height*, and the horizontal one is `aspect` times it, so a viewport narrower
        // than it is tall shows less across than up and down. At Gem Cut Studio's framing the
        // horizontal half-extent falls below the hex cut's silhouette radius of 0.98 once the
        // aspect drops below 0.751, and the stone is cut off on both sides; the page has no media
        // query, so a 720 x 900 window (aspect 0.49) and a phone (0.12) both reach that. Dividing
        // by the aspect there restores the full half-height across the narrow dimension, which is
        // the same framing turned through a right angle.
        //
        // Landscape and square viewports divide by exactly 1.0 and are therefore bit-identical,
        // Gem Cut Studio's own 1168 x 978 (aspect 1.194) included. Only the two half-extents
        // change; `aspect` itself is passed to the shader untouched, so `gem.frag`, which builds
        // its primary ray from these three uniforms, needs no matching change.
        let fit = safe_aspect.min(1.0);

        CameraBasis {
            origin,
            forward,
            right,
            up,
            // 0.0 / fit is exactly 0.0, so the projection each branch selected is preserved: the
            // sign of `orthographic_half_height` is what tells the shader which one to build.
            tan_half_fov: tan_half_fov / fit,
            orthographic_half_height: orthographic_half_height / fit,
            aspect: safe_aspect,
        }
    }
}

impl CameraBasis {
    pub fn is_orthographic(&self) -> bool {
        self.orthographic_half_height > 0.0
    }

    /// Expresses a world direction in the viewer-locked lighting frame, whose +Y points back
    /// towards the viewer, +X to screen right and +Z to screen down.
    ///
    /// Mirrors `toLightingFrame` in `gem.frag`. Gem Cut Studio holds the viewer and the lights
    /// still and rotates the stone; expressing lighting lookups in this frame gives the same
    /// relationship while the camera moves instead. The rows (right, -forward, -up) form a
    /// proper rotation, because `forward x up = right`, and at the default straight-down
    /// pose they are exactly the identity, which is why front views look the same whether
    /// or not the lighting follows the view.
    pub fn to_lighting_frame(&self, direction: Vector3<f32>) -> Vector3<f32> {
        Vector3::new(
            direction.dot(&self.right),
            -direction.dot(&self.forward),
            -direction.dot(&self.up),
        )
    }

    /// Whether light arriving along world `direction`, leaving the stone through a facet with
    /// world `outward_normal`, counts as coming from behind the stone: a leak, shown in the window
    /// or background colour.
    ///
    /// Mirrors the test in `arrivingLight` in `gem.frag`. It is behind if the direction is below
    /// the lighting horizon, or if the facet it leaves through faces below that horizon by more
    /// than `BACK_FACET_TOLERANCE`. The second rule is Gem Cut Studio's: light leaving a pavilion
    /// facet slightly upwards is still seen through the back of the stone (T-0026). The lighting
    /// frame is viewer-locked when `lighting_follows_view`, otherwise world +Y is the zenith.
    pub fn light_comes_from_behind(
        &self,
        lighting_follows_view: bool,
        direction: Vector3<f32>,
        outward_normal: Vector3<f32>,
    ) -> bool {
        let in_lighting_frame = |vector: Vector3<f32>| {
            if lighting_follows_view {
                self.to_lighting_frame(vector)
            } else {
                vector
            }
        };

        in_lighting_frame(direction).y < 0.0
            || in_lighting_frame(outward_normal).y < -BACK_FACET_TOLERANCE
    }

    /// Whether light leaving the stone at `position` along unit `direction` strikes the
    /// observer, a body centred on the view axis.
    ///
    /// Mirrors `blockedByObserver` in `gem.frag`; see `params::RenderParams::observer_radius`
    /// for why it exists. Only light leaving from within `radius` of the view axis (the line
    /// through `origin` along `forward`) can be blocked. Then:
    ///
    /// - **Orthographic:** the body is infinitely far along the axis, so the light must head
    ///   back along it, to within `OBSERVER_ALIGNMENT_TOLERANCE`. Tilting the stone 0.003
    ///   degrees removes the dot.
    /// - **Perspective,** including Gem Cut Studio's default camera: the body is at the eye,
    ///   `OBSERVER_EYE_RADIUS_SCALE` times `radius` across, and the light's line must pass that
    ///   close to the eye. Face-up the dot keeps exactly the same radius. The dot slides as the
    ///   stone tilts and is gone past 2 x radius / eye distance: 0.058 degrees at the defaults,
    ///   still "a fraction of a degree", as the user saw in GCS. The orthographic test would
    ///   instead shrink the dot tenfold under perspective rays, whose table reflections are up
    ///   to 2 x radius / eye distance (1e-3) off the axis.
    ///
    /// Every test is a cross-product length, which stays accurate for tiny values.
    pub fn observer_blocks(
        &self,
        radius: f32,
        position: Point3<f32>,
        direction: Vector3<f32>,
    ) -> bool {
        if radius <= 0.0 {
            return false;
        }

        let towards_viewer = -self.forward;

        if (position - self.origin).cross(&towards_viewer).norm() >= radius {
            return false;
        }

        if self.is_orthographic() {
            return direction.dot(&towards_viewer) > 0.0
                && direction.cross(&towards_viewer).norm() <= OBSERVER_ALIGNMENT_TOLERANCE;
        }

        let towards_eye = self.origin - position;

        direction.dot(&towards_eye) > 0.0
            && towards_eye.cross(&direction).norm() < OBSERVER_EYE_RADIUS_SCALE * radius
    }

    /// Where a world point appears on screen: `(ndc_x, ndc_y, depth)`, the inverse of
    /// `ray_origin` and `ray_direction`, so the ray through `(ndc_x, ndc_y)` passes through the
    /// point. `depth` is how far the point lies along `forward` from the eye (for orthographic,
    /// from the plane the rays start on); a point at or behind the eye of a perspective camera
    /// has none of these meaningfully, and the caller should skip it when `depth` is not positive.
    ///
    /// For the page's edit-mode overlay (the cutting plane drawn over the stone),
    /// which must land on the same pixels the shader draws the stone at.
    pub fn project(&self, point: Point3<f32>) -> (f32, f32, f32) {
        let offset = point - self.origin;
        let depth = offset.dot(&self.forward);

        let half_height = if self.is_orthographic() {
            self.orthographic_half_height
        } else {
            depth * self.tan_half_fov
        };

        (
            offset.dot(&self.right) / (self.aspect * half_height),
            offset.dot(&self.up) / half_height,
            depth,
        )
    }

    /// Start of the ray through a point in normalised device coordinates, where
    /// (-1, -1) is the bottom left of the viewport and (1, 1) the top right.
    ///
    /// Mirrors the primary ray set-up at the start of `main` in `gem.frag`, which computes it
    /// inline. In orthographic mode the origins tile a plane through the eye perpendicular to
    /// `forward`. That plane is
    /// `distance` from the target, and `MIN_DISTANCE` exceeds the stone's radius of 1,
    /// so no ray can start inside the stone.
    pub fn ray_origin(&self, ndc_x: f32, ndc_y: f32) -> Point3<f32> {
        if !self.is_orthographic() {
            return self.origin;
        }

        let half_height = self.orthographic_half_height;

        self.origin
            + self.right * (ndc_x * self.aspect * half_height)
            + self.up * (ndc_y * half_height)
    }

    /// Direction of the ray through a point in normalised device coordinates.
    ///
    /// Mirrors the primary ray set-up at the start of `main` in `gem.frag`.
    pub fn ray_direction(&self, ndc_x: f32, ndc_y: f32) -> Vector3<f32> {
        if self.is_orthographic() {
            return self.forward;
        }

        (self.forward
            + self.right * (ndc_x * self.aspect * self.tan_half_fov)
            + self.up * (ndc_y * self.tan_half_fov))
            .normalize()
    }

    /// Where the shader starts tracing the primary ray through a point in normalised device
    /// coordinates: `ray_origin`, moved along `ray_direction` to `PRIMARY_RAY_START_RADIUS` from the
    /// world origin, or left where it is if it is no farther along the ray than that already.
    ///
    /// Mirrors the primary ray set-up at the start of `main` in `gem.frag`. The ray itself is
    /// unchanged, and nothing in front of the stone is skipped, because every point passed over is
    /// at least that radius from the origin and the stone lies within it. Only precision changes:
    /// the triangle test then works with numbers near 1 rather than with an eye 52 units away. See
    /// `PRIMARY_RAY_START_RADIUS`.
    pub fn ray_start(&self, ndc_x: f32, ndc_y: f32) -> Point3<f32> {
        let origin = self.ray_origin(ndc_x, ndc_y);
        let direction = self.ray_direction(ndc_x, ndc_y);
        let along = -origin.coords.dot(&direction);

        origin + direction * (along - PRIMARY_RAY_START_RADIUS).max(0.0)
    }
}

/// Wraps an angle into `[-PI, PI)`.
fn wrap_angle(angle: f32) -> f32 {
    let wrapped = (angle + PI).rem_euclid(TAU) - PI;

    // `rem_euclid` can return exactly TAU for tiny negative inputs due to rounding,
    // which would land just outside the intended range.
    if wrapped >= PI {
        wrapped - TAU
    } else {
        wrapped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A lens camera at an oblique pose, for tests about lens geometry.
    fn perspective() -> OrbitCamera {
        OrbitCamera {
            spin: 0.6,
            tilt: 1.15,
            vertical_fov: 0.5,
            ..Default::default()
        }
    }

    /// The orthographic camera: the default with no eye distance.
    fn orthographic() -> OrbitCamera {
        OrbitCamera {
            eye_distance: 0.0,
            ..Default::default()
        }
    }

    /// Clicking a facet turns the camera to look straight at it.
    ///
    /// Setup: 200 facet normals spread over the whole sphere (a golden-angle spiral, which
    /// includes steep crown facets, girdle facets and pavilion facets pointing below the
    /// horizon), each tried from four different current poses, some tilted the other way and
    /// some spun past a half turn. Test: take `orientation_facing(normal)`, set that pose,
    /// and compare the camera's forward direction with the normal. Verifies the view looks
    /// exactly down onto the facet (forward is the reversed normal), whatever pose it
    /// started from, and that the pose is already wrapped into [-PI, PI).
    #[test]
    fn orientation_facing_looks_straight_down_the_facet_normal() {
        let starts = [
            OrbitCamera::default(),
            OrbitCamera { spin: 2.9, tilt: -1.2, ..Default::default() },
            OrbitCamera { spin: -1.0, tilt: 2.5, ..Default::default() },
            perspective(),
        ];

        let count = 200;

        for index in 0..count {
            // Golden-angle spiral: evenly spread heights, turning by the golden angle each step.
            let height = 1.0 - 2.0 * (index as f32 + 0.5) / count as f32;
            let around = index as f32 * 2.399_963;
            let ring = (1.0 - height * height).sqrt();
            let normal = Vector3::new(ring * around.cos(), height, ring * around.sin());

            for start in starts {
                let (spin, tilt) = start.orientation_facing(normal).expect("a unit normal has a pose");

                assert!((-PI..PI).contains(&spin) && (-PI..PI).contains(&tilt), "pose must be wrapped");

                let mut camera = start;
                camera.set_orientation(spin, tilt);

                let forward = camera.basis(1.0).forward;

                assert!(
                    (forward + normal).norm() < 1e-4,
                    "normal {:?} from {:?}: forward {:?} is not the reversed normal",
                    normal,
                    (start.spin, start.tilt),
                    forward
                );
            }
        }
    }

    /// Of the two poses that face a facet, the one nearer the current pose is chosen.
    ///
    /// Setup: a facet normal tilted 40 degrees from the optical axis towards world +Z, which
    /// both (spin 0, tilt 40) and (spin 180, tilt -40) face; the second is the first turned
    /// half a turn in the image. Test: ask for the facing pose from a camera near each of the
    /// two. Verifies each camera gets the pose next to it, so clicking a facet never turns the
    /// picture upside down.
    #[test]
    fn orientation_facing_picks_the_pose_nearer_the_current_one() {
        let angle = 40f32.to_radians();
        let normal = Vector3::new(0.0, angle.cos(), angle.sin());

        let near_first = OrbitCamera { spin: 0.3, tilt: 0.2, ..Default::default() };
        let near_second = OrbitCamera { spin: 3.0, tilt: -0.2, ..Default::default() };

        let (spin, tilt) = near_first.orientation_facing(normal).unwrap();
        assert!(spin.abs() < 1e-5 && (tilt - angle).abs() < 1e-5, "got {:?}", (spin, tilt));

        let (spin, tilt) = near_second.orientation_facing(normal).unwrap();
        assert!(
            wrap_angle(spin - PI).abs() < 1e-5 && (tilt + angle).abs() < 1e-5,
            "got {:?}",
            (spin, tilt)
        );
    }

    /// A facet on the optical axis keeps the current spin.
    ///
    /// Setup: a camera spun 70 degrees and tilted 30. Test: face a table normal that is off
    /// the axis only by float rounding (1e-6 towards +X), then a culet normal straight down.
    /// Verifies the table gives tilt 0 and the culet face-down (tilt PI), both
    /// keeping spin 70 degrees, instead of spinning the view to the arbitrary direction of
    /// the rounding error. A zero normal, as a degenerate triangle would give, has no pose.
    #[test]
    fn orientation_facing_keeps_the_spin_for_the_table_and_culet() {
        let camera = OrbitCamera { spin: 70f32.to_radians(), tilt: 30f32.to_radians(), ..Default::default() };

        let (spin, tilt) = camera.orientation_facing(Vector3::new(1e-6, 1.0, 0.0)).unwrap();
        assert_eq!(spin, camera.spin);
        assert!(tilt.abs() < 1e-5, "table tilt {}", tilt);

        let (spin, tilt) = camera.orientation_facing(Vector3::new(0.0, -1.0, 0.0)).unwrap();
        assert_eq!(spin, camera.spin);
        // acos(-1) rounds to just under PI in f32, so face-down may come back as either end
        // of the wrapped range; both are the same pose.
        assert!(wrap_angle(tilt - PI).abs() < 1e-5, "culet tilt {}", tilt);

        assert_eq!(camera.orientation_facing(Vector3::zeros()), None);
    }

    /// The basis must be orthonormal. A skewed or non-unit basis stretches the
    /// image subtly, which is easy to miss visually but breaks every angle-based
    /// calculation downstream, including Fresnel.
    ///
    /// Checked for the default face-up pose (where the old cross-with-world-up basis was
    /// undefined), an ordinary oblique one, a negative tilt and exactly face-down.
    #[test]
    fn basis_is_orthonormal() {
        let tilted_the_other_way = OrbitCamera { spin: -2.0, tilt: -0.7, ..Default::default() };
        let face_down = OrbitCamera { tilt: -PI, ..Default::default() };

        for camera in [OrbitCamera::default(), orthographic(), perspective(), tilted_the_other_way, face_down] {
            let basis = camera.basis(16.0 / 9.0);

            for (name, vector) in [
                ("forward", basis.forward),
                ("right", basis.right),
                ("up", basis.up),
            ] {
                assert!(
                    (vector.norm() - 1.0).abs() < 1e-5,
                    "{} is not unit length: {}",
                    name,
                    vector.norm()
                );
            }

            assert!(
                basis.forward.dot(&basis.right).abs() < 1e-5,
                "forward and right are not perpendicular"
            );
            assert!(
                basis.forward.dot(&basis.up).abs() < 1e-5,
                "forward and up are not perpendicular"
            );
            assert!(
                basis.right.dot(&basis.up).abs() < 1e-5,
                "right and up are not perpendicular"
            );
        }
    }

    /// The basis must be right handed in the sense the shader assumes: right cross
    /// up points back towards the camera. A flipped handedness mirrors the image.
    #[test]
    fn basis_has_expected_handedness() {
        let camera = perspective();
        let basis = camera.basis(1.0);

        let reconstructed_forward = basis.right.cross(&basis.up);

        // Specifically: up = right x forward, so right x up = -forward.
        assert!(
            (reconstructed_forward + basis.forward).norm() < 1e-5,
            "expected right x up == -forward, got {:?} vs {:?}",
            reconstructed_forward,
            basis.forward
        );
    }

    /// The default view must be Gem Cut Studio's: its perspective camera, looking straight
    /// down the optical axis at the table, with world +X to the right.
    ///
    /// Setup: the default camera. Test: build its basis. Verifies what makes the default render
    /// line up with `reference/application_images/hex_cut_v2/hex_cut_v2_gcs_front_random.png` and with GCS's
    /// measured perspective (T-0041):
    /// - no lens;
    /// - the eye `GEM_CUT_STUDIO_EYE_DISTANCE` straight above the target;
    /// - a field of view exactly wide enough for the measured view height at the target;
    /// - the table facing the viewer;
    /// - girdle corners (on +/-X for `hex_cut_v2.obj`) pointing left and right rather than up
    ///   and down.
    #[test]
    fn default_camera_matches_the_gem_cut_studio_front_view() {
        let camera = OrbitCamera::default();
        let basis = camera.basis(1.2);

        assert!(!camera.is_orthographic(), "the default must be Gem Cut Studio's perspective camera");
        assert!(!basis.is_orthographic());
        assert_eq!(camera.vertical_fov, 0.0, "the default must not use a lens");
        assert_eq!(camera.eye_distance, GEM_CUT_STUDIO_EYE_DISTANCE);
        assert!(
            (basis.origin - Point3::new(0.0, GEM_CUT_STUDIO_EYE_DISTANCE, 0.0)).norm() < 1e-4,
            "the eye must be straight above the stone at GCS's distance, got {:?}",
            basis.origin
        );
        assert!(
            (basis.tan_half_fov - DEFAULT_VIEW_HALF_HEIGHT / GEM_CUT_STUDIO_EYE_DISTANCE).abs() < 1e-7,
            "the view at the target must have the measured height, got tan {}",
            basis.tan_half_fov
        );
        assert!(
            basis.forward.dot(&-WORLD_UP) > 0.999_99,
            "the default must look straight down onto the table, got forward {:?}",
            basis.forward
        );
        assert!(
            basis.right.dot(&Vector3::x()) > 0.999_99,
            "screen right must be world +X so the girdle corners point sideways, got {:?}",
            basis.right
        );
    }

    /// The default camera must draw the hex cut's girdle as wide as Gem Cut Studio does.
    ///
    /// Setup: the default face-up camera on GCS's 1168 x 978 px viewport, and one girdle corner
    /// of `hex_cut_v2.obj` as the mesh conditioner leaves it: radius 0.97985 on +X, at the top
    /// of the girdle band 0.19978 above the target, which is the widest point seen face-up.
    /// Test: project the corner into normalised device coordinates, and check that the ray
    /// through that position passes through the corner. Verifies the corner-to-corner span is
    /// 735 px, as measured in `hex_cut_v2_gcs_front_random.png`, to within half a pixel.
    /// Perspective magnifies the girdle by 0.4%, so the orthographic half-height of 1.304 would
    /// draw it 3 px too wide.
    #[test]
    fn default_camera_draws_the_hex_girdle_at_the_measured_width() {
        let basis = OrbitCamera::default().basis(1168.0 / 978.0);
        let corner = Point3::new(0.97985, 0.19978, 0.0);
        let to_corner = corner - basis.origin;
        let ndc_x = to_corner.dot(&basis.right)
            / to_corner.dot(&basis.forward)
            / (basis.aspect * basis.tan_half_fov);

        let miss = to_corner.cross(&basis.ray_direction(ndc_x, 0.0)).norm();

        assert!(miss < 1e-4, "the ray through the projected corner misses it by {}", miss);

        // Normalised device x runs from -1 to 1 across the 1168 px width.
        let span_px = ndc_x * 1168.0;

        assert!(
            (span_px - 735.0).abs() < 0.5,
            "the girdle spans {} px corner to corner, GCS 735",
            span_px
        );
    }

    /// A viewport narrower than it is tall must still show the whole stone, framed against its
    /// narrow dimension exactly as a landscape viewport is framed against its height.
    ///
    /// Setup: `resources/hex_cut_v2.obj`, conditioned as the page conditions it (centred, farthest
    /// vertex at radius 1, optical axis turned onto +Y), and the default face-up camera at three
    /// portrait aspects the page really produces. The page (`web/src/styles/`) lays itself out with
    /// `display: flex`, a `flex: 0 0 300px` panel and `min-width: 0` on the viewport, and contains
    /// no media query and no `matchMedia`, so the canvas simply keeps whatever width is left:
    /// - 420 / 860 = 0.488, the canvas in a 720 x 900 browser window;
    /// - 0.70, just inside the aspect at which the girdle corner first leaves the frame;
    /// - 90 / 750 = 0.12, a 390 px phone, which touch drag supports (T-0028).
    ///
    /// Both lensless projections are checked: Gem Cut Studio's perspective default and the
    /// orthographic camera.
    ///
    /// Test: project every vertex of the conditioned mesh into normalised device coordinates,
    /// inverting the ray set-up at the start of `main` in `gem.frag`, and project the girdle corner
    /// on +X separately.
    ///
    /// Verifies:
    /// - every vertex lands inside the frame, |ndc| <= 1 on both axes. Fitting the viewport's
    ///   height alone left the horizontal half-extent at `aspect` x 1.309 world units, which falls
    ///   below the stone's silhouette radius of 0.97985 once the aspect drops below 0.751: at
    ///   420 / 860 the girdle corner projected to ndc x 1.54 and the stone was cut off on both
    ///   sides (T-0074);
    /// - the girdle still spans about 0.75 of the *narrow* dimension, which is the fraction of the
    ///   viewport Gem Cut Studio's screenshots put it at across their height: 0.7515 through the
    ///   perspective camera, and 0.7486 orthographically, which lacks the girdle's 1.00386
    ///   magnification. Without this, a "fix" that merely zoomed far out would pass.
    #[test]
    fn portrait_viewport_frames_the_whole_stone() {
        let (mesh, _, _) = crate::conditioned_mesh(
            include_str!("../resources/hex_cut_v2.obj"),
            crate::mesh::ModelAxis::PlusZ,
        )
        .expect("the hex cut must load");

        // The widest point of the face-up stone: the girdle corner on +X, at the top of the girdle
        // band, as `default_camera_draws_the_hex_girdle_at_the_measured_width` uses it.
        let girdle_corner = Point3::new(0.97985, 0.19978, 0.0);

        for aspect in [420.0 / 860.0, 0.70, 90.0 / 750.0] {
            for (name, camera) in [
                ("Gem Cut Studio's perspective", OrbitCamera::default()),
                ("orthographic", orthographic()),
            ] {
                let basis = camera.basis(aspect);

                // Both projections divide the offset across the view by the half-extent on that
                // axis; the perspective one divides by the depth first, which is what magnifies the
                // girdle corner, 0.19978 nearer the eye than the target, by 52 / (52 - 0.19978).
                let ndc = |point: Point3<f32>| {
                    let offset = point - basis.origin;
                    let (half_width, half_height) = if basis.is_orthographic() {
                        (
                            basis.aspect * basis.orthographic_half_height,
                            basis.orthographic_half_height,
                        )
                    } else {
                        let depth = offset.dot(&basis.forward);

                        (
                            depth * basis.aspect * basis.tan_half_fov,
                            depth * basis.tan_half_fov,
                        )
                    };

                    (
                        offset.dot(&basis.right) / half_width,
                        offset.dot(&basis.up) / half_height,
                    )
                };

                let mut worst = 0.0f32;

                for position in &mesh.positions {
                    let (x, y) = ndc(*position);

                    worst = worst.max(x.abs()).max(y.abs());
                }

                assert!(
                    worst <= 1.0,
                    "at aspect {} the {} camera puts a vertex {} of the way across the frame, so the stone is cut off",
                    aspect,
                    name,
                    worst
                );

                // Normalised device x is a fraction of the half-width, so corner to corner the
                // girdle spans this fraction of the whole width.
                let span = ndc(girdle_corner).0;

                assert!(
                    (0.74..=0.76).contains(&span),
                    "at aspect {} the {} camera draws the girdle across {} of the viewport width, expected about 0.75",
                    aspect,
                    name,
                    span
                );
            }
        }
    }

    /// Fitting the framing to the viewport's smaller dimension must change portrait viewports
    /// only, leaving every square and landscape one bit-identical.
    ///
    /// Setup: the default (Gem Cut Studio's perspective), orthographic and lens cameras, at the
    /// default zoom. Test: build each basis at square and landscape aspects, including Gem Cut
    /// Studio's own 1168 / 978 = 1.194 that all 13 comparison renders are captured at, and then at
    /// portrait ones.
    ///
    /// Verifies:
    /// - from aspect 1 upwards every projection field is exactly what the framing constants give on
    ///   their own, compared as raw f32 bits rather than with a tolerance, because a comparison
    ///   render must not move by a single least significant bit;
    /// - below aspect 1 the horizontal half-extent, `aspect` times the half-height, is the full
    ///   half-height instead, so the narrow dimension carries the framing. That half of this test
    ///   is what fails before T-0074.
    #[test]
    fn fitting_the_smaller_dimension_changes_portrait_viewports_only() {
        // At the default orbit distance the view half-height is the measured constant itself.
        let half_height = DEFAULT_DISTANCE * VIEW_HALF_HEIGHT_PER_DISTANCE;
        let lens_tangent = (perspective().vertical_fov * 0.5).tan();

        assert_eq!(
            half_height.to_bits(),
            DEFAULT_VIEW_HALF_HEIGHT.to_bits(),
            "setup: the default zoom must give exactly the measured half-height"
        );

        for aspect in [1.0f32, 1168.0 / 978.0, 4.0 / 3.0, 16.0 / 9.0, 2.0, 4.0] {
            let default = OrbitCamera::default().basis(aspect);
            let flat = orthographic().basis(aspect);
            let lens = perspective().basis(aspect);

            assert_eq!(
                default.tan_half_fov.to_bits(),
                (half_height / GEM_CUT_STUDIO_EYE_DISTANCE).to_bits(),
                "aspect {} moved the default camera's lens tangent to {}",
                aspect,
                default.tan_half_fov
            );
            assert_eq!(
                flat.orthographic_half_height.to_bits(),
                half_height.to_bits(),
                "aspect {} moved the orthographic half-height to {}",
                aspect,
                flat.orthographic_half_height
            );
            assert_eq!(
                lens.tan_half_fov.to_bits(),
                lens_tangent.to_bits(),
                "aspect {} moved the lens tangent to {}",
                aspect,
                lens.tan_half_fov
            );
        }

        for aspect in [0.999f32, 0.7515, 0.70, 420.0 / 860.0, 90.0 / 750.0] {
            let default = OrbitCamera::default().basis(aspect);
            let flat = orthographic().basis(aspect);
            let lens = perspective().basis(aspect);

            for (name, half_width, expected) in [
                (
                    "the default camera",
                    aspect * default.tan_half_fov * GEM_CUT_STUDIO_EYE_DISTANCE,
                    half_height,
                ),
                (
                    "the orthographic camera",
                    aspect * flat.orthographic_half_height,
                    half_height,
                ),
                ("the lens", aspect * lens.tan_half_fov, lens_tangent),
            ] {
                assert!(
                    (half_width - expected).abs() < expected * 1e-6,
                    "at aspect {} {} shows {} across the half-width, expected the full half-height {}",
                    aspect,
                    name,
                    half_width,
                    expected
                );
            }
        }
    }

    /// Projecting a point to the screen is the exact inverse of building the ray there.
    ///
    /// Setup: the default (Gem Cut Studio's perspective), orthographic and lens cameras, at an
    /// oblique pose and at face-up, on a landscape and a portrait viewport, and points spread
    /// through and around the unit stone. Test: `project` each point, then build the ray through
    /// the returned coordinates with `ray_origin` and `ray_direction`. Verifies the ray passes
    /// within 1e-4 world units of the point (so the edit-mode overlay lands on the pixels the
    /// shader draws that point at), and that the depth is the point's distance along `forward`.
    #[test]
    fn project_inverts_the_ray_set_up() {
        let oblique = |camera: OrbitCamera| OrbitCamera { spin: 0.9, tilt: -0.6, ..camera };
        let cameras = [
            OrbitCamera::default(),
            oblique(OrbitCamera::default()),
            orthographic(),
            oblique(orthographic()),
            perspective(),
        ];
        let points = [
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(0.9, 0.2, -0.3),
            Point3::new(-1.4, -0.8, 0.5),
            Point3::new(0.1, 1.6, 1.1),
        ];

        for camera in cameras {
            for aspect in [1.6f32, 0.6] {
                let basis = camera.basis(aspect);

                for point in points {
                    let (x, y, depth) = basis.project(point);
                    let origin = basis.ray_origin(x, y);
                    let direction = basis.ray_direction(x, y);
                    let miss = (point - origin).cross(&direction).norm();

                    assert!(miss < 1e-4, "{:?} at aspect {}: the ray misses {:?} by {}", camera, aspect, point, miss);
                    assert!(((point - basis.origin).dot(&basis.forward) - depth).abs() < 1e-5);
                }
            }
        }
    }

    /// Orthographic rays must all be parallel, with origins spread across the view.
    ///
    /// Setup: the orthographic camera on a 2:1 viewport. Test: build rays at the
    /// centre, the top edge and the right edge. Verifies every direction is exactly
    /// `forward`, and the origins sit exactly half a view height above and half a view
    /// width to the right of the eye -- which is what makes the image a true parallel
    /// projection with square pixels.
    #[test]
    fn orthographic_rays_are_parallel_and_origins_tile_the_view() {
        let basis = orthographic().basis(2.0);
        let half_height = basis.orthographic_half_height;

        for (x, y) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (-1.0, -1.0), (0.3, -0.7)] {
            assert_eq!(
                basis.ray_direction(x, y),
                basis.forward,
                "orthographic ray at ({}, {}) is not parallel to forward",
                x,
                y
            );
        }

        assert_eq!(basis.ray_origin(0.0, 0.0), basis.origin);

        let top = basis.ray_origin(0.0, 1.0) - basis.origin;
        let right = basis.ray_origin(1.0, 0.0) - basis.origin;

        assert!(
            (top - basis.up * half_height).norm() < 1e-5,
            "top-edge origin should be half a view height up, got {:?}",
            top
        );
        assert!(
            (right - basis.right * (2.0 * half_height)).norm() < 1e-5,
            "right-edge origin should be half a view width across, got {:?}",
            right
        );
    }

    /// No orthographic ray may start inside the stone, at any zoom.
    ///
    /// Setup: zoom fully in, to `MIN_DISTANCE`. Test: take the origins at the centre and
    /// all four corners of a wide viewport. Verifies each lies on the plane
    /// `MIN_DISTANCE` in front of the target, which is outside the stone's unit radius.
    /// A ray starting inside the solid would enter in the wrong medium and render the
    /// stone inside out.
    #[test]
    fn orthographic_ray_origins_never_start_inside_the_stone() {
        let mut camera = orthographic();

        for _ in 0..100 {
            camera.zoom(0.5);
        }

        let basis = camera.basis(16.0 / 9.0);

        for (x, y) in [(0.0, 0.0), (-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)] {
            let depth = (camera.target - basis.ray_origin(x, y)).dot(&basis.forward);

            assert!(
                (depth - MIN_DISTANCE).abs() < 1e-4 && depth > 1.0,
                "origin at ({}, {}) is {} in front of the target, expected {} (> radius 1)",
                x,
                y,
                depth,
                MIN_DISTANCE
            );
        }
    }

    /// Zoom must still work in orthographic mode, by scaling the view.
    ///
    /// Verifies that halving the orbit distance halves the visible height. Without this
    /// the scroll wheel would move the eye without any visible effect.
    #[test]
    fn orthographic_zoom_scales_the_view() {
        let mut camera = orthographic();
        let before = camera.basis(1.0).orthographic_half_height;

        camera.zoom(0.5);

        let after = camera.basis(1.0).orthographic_half_height;

        assert!(
            (after - before * 0.5).abs() < 1e-5,
            "expected the view to halve from {}, got {}",
            before,
            after
        );
    }

    /// Zooming the default camera must magnify the image without moving the eye, so Gem Cut
    /// Studio's perspective stays the measured one at every zoom.
    ///
    /// Setup: the default camera. Test: zoom in by half. Verifies the eye has not moved and the
    /// view's half-height at the target (the lens tangent times the fixed eye distance) has
    /// halved.
    #[test]
    fn default_zoom_magnifies_without_moving_the_eye() {
        let mut camera = OrbitCamera::default();
        let before = camera.basis(1.0);

        camera.zoom(0.5);

        let after = camera.basis(1.0);

        assert!(
            (after.origin - before.origin).norm() < 1e-4,
            "zoom moved the eye from {:?} to {:?}",
            before.origin,
            after.origin
        );
        assert!(
            (after.tan_half_fov - before.tan_half_fov * 0.5).abs() < 1e-7,
            "expected the view to halve from tan {}, got {}",
            before.tan_half_fov,
            after.tan_half_fov
        );
    }

    /// The default camera's rays must fan out from the eye and cross the plane through the
    /// target exactly where the orthographic camera's parallel rays do, so the framing measured
    /// orthographically carries over.
    ///
    /// Setup: the default and orthographic cameras at the same oblique pose and zoom, on a 3:2
    /// viewport. Test: for the centre, two edges, a corner and an arbitrary point of the view,
    /// intersect each camera's ray with the plane through the target facing the viewer. Verifies
    /// every default ray starts at the eye, and both cameras' rays reach the same point.
    #[test]
    fn default_rays_fan_from_the_eye_and_frame_the_target_like_orthographic() {
        let pose = OrbitCamera { spin: 0.6, tilt: 1.15, distance: 3.0, ..Default::default() };
        let flat = OrbitCamera { eye_distance: 0.0, ..pose };
        let (fan, parallel) = (pose.basis(1.5), flat.basis(1.5));
        let on_target_plane = |basis: &CameraBasis, x: f32, y: f32| {
            let origin = basis.ray_origin(x, y);
            let direction = basis.ray_direction(x, y);
            let t = (pose.target - origin).dot(&basis.forward) / direction.dot(&basis.forward);

            origin + direction * t
        };

        for (x, y) in [(0.0, 0.0), (1.0, 0.0), (0.0, -1.0), (-1.0, 1.0), (0.3, -0.7)] {
            assert_eq!(fan.ray_origin(x, y), fan.origin, "a perspective ray must start at the eye");

            let (a, b) = (on_target_plane(&fan, x, y), on_target_plane(&parallel, x, y));

            assert!((a - b).norm() < 1e-4, "at ({}, {}) the rays reach {:?} and {:?}", x, y, a, b);
        }
    }

    /// The eye distance must select orthographic at zero or below, keep the eye outside the
    /// stone, cap very far eyes, give way to a lens, and ignore nonsense.
    ///
    /// Setup: the default camera. Test: set a sequence of eye distances, then a lens. Verifies:
    /// - 0 and negatives are orthographic;
    /// - 0.5 is pushed out to `MIN_DISTANCE`, beyond the unit-radius stone;
    /// - a million is capped at `MAX_EYE_DISTANCE`;
    /// - an ordinary value is kept and places the eye;
    /// - NaN changes nothing;
    /// - a lens puts the eye at the orbit distance instead.
    #[test]
    fn set_eye_distance_selects_orthographic_at_zero_clamps_and_gives_way_to_a_lens() {
        let mut camera = OrbitCamera::default();

        camera.set_eye_distance(0.0);
        assert!(
            camera.is_orthographic() && camera.basis(1.0).is_orthographic(),
            "zero must select orthographic"
        );

        camera.set_eye_distance(-3.0);
        assert_eq!(camera.eye_distance, 0.0, "a negative distance must also select orthographic");

        camera.set_eye_distance(0.5);
        assert_eq!(camera.eye_distance, MIN_DISTANCE, "an eye inside the stone must be pushed out");

        camera.set_eye_distance(1e6);
        assert_eq!(camera.eye_distance, MAX_EYE_DISTANCE);

        camera.set_eye_distance(80.0);
        assert_eq!(camera.eye_distance, 80.0);
        assert!(((camera.eye() - camera.target).norm() - 80.0).abs() < 1e-3);

        camera.set_eye_distance(f32::NAN);
        assert_eq!(camera.eye_distance, 80.0, "NaN must leave the eye distance alone");

        camera.set_vertical_fov(0.3);
        assert!(
            ((camera.eye() - camera.target).norm() - camera.distance).abs() < 1e-4,
            "a lens must put the eye at the orbit distance"
        );
    }

    /// Very narrow fields of view snap to zero, which removes the lens, wide ones clamp, and
    /// nonsense is ignored.
    ///
    /// Setup: a lens camera. Test: set a sequence of fields of view. Verifies zero removes the
    /// lens, leaving the default eye distance rather than orthographic; a uselessly narrow lens
    /// snaps to zero; an ordinary one is kept; a huge one clamps to `MAX_FOV`; NaN changes
    /// nothing.
    #[test]
    fn set_vertical_fov_snaps_clamps_and_rejects_non_finite_values() {
        let mut camera = perspective();

        camera.set_vertical_fov(0.0);
        assert_eq!(camera.vertical_fov, 0.0, "zero must remove the lens");
        assert!(
            !camera.is_orthographic()
                && ((camera.eye() - camera.target).norm() - GEM_CUT_STUDIO_EYE_DISTANCE).abs() < 1e-3,
            "without a lens the default eye distance must apply"
        );

        camera.set_vertical_fov(MIN_PERSPECTIVE_FOV * 0.5);
        assert_eq!(camera.vertical_fov, 0.0, "a uselessly narrow lens must snap to zero");

        camera.set_vertical_fov(0.3);
        assert_eq!(camera.vertical_fov, 0.3, "an ordinary lens must be kept as given");
        assert!(!camera.is_orthographic());
        assert_eq!(camera.basis(1.0).orthographic_half_height, 0.0);

        camera.set_vertical_fov(10.0);
        assert_eq!(camera.vertical_fov, MAX_FOV);

        camera.set_vertical_fov(f32::NAN);
        assert_eq!(camera.vertical_fov, MAX_FOV, "NaN must leave the field of view alone");
    }

    /// At the default straight-down pose the viewer-locked lighting frame must equal the
    /// world frame, so turning "lighting follows the view" on or off cannot change the front
    /// render that the Gem Cut Studio framing was verified against.
    ///
    /// Setup: the default camera. Test: map each world axis into the lighting frame.
    /// Verifies each lands on itself to within rounding. (Before the camera could sit exactly
    /// face-up, a pitch clamp kept it a milliradian off, and this tolerance was 2e-3.)
    #[test]
    fn lighting_frame_is_the_world_frame_at_the_default_pose() {
        let basis = OrbitCamera::default().basis(1.0);

        for axis in [Vector3::x(), Vector3::y(), Vector3::z()] {
            let mapped = basis.to_lighting_frame(axis);

            assert!(
                (mapped - axis).norm() < 1e-6,
                "world axis {:?} maps to {:?} at the default pose",
                axis,
                mapped
            );
        }
    }

    /// At any pose, the lighting frame must put the zenith back towards the viewer and be a
    /// proper rotation.
    ///
    /// Setup: 24 poses spread over spin and the whole range of tilt (negative, past 90
    /// degrees, near face-down), including Gem Cut Studio's 23 degree X rotation. Test: map
    /// the direction towards the viewer, and three orthonormal world axes. Verifies the viewer
    /// direction maps to +Y (so head shadow and "behind the stone" are measured from the
    /// viewer), lengths are preserved, and handedness is kept: a reflection here would mirror
    /// the lighting.
    #[test]
    fn lighting_frame_points_its_zenith_at_the_viewer_and_is_a_rotation() {
        let mut camera = OrbitCamera::default();

        camera.orbit(0.0, 23f32.to_radians());

        let mut poses = vec![camera];

        for step in 0..23 {
            let mut pose = OrbitCamera::default();

            pose.set_orientation(step as f32 * 0.29, (step as f32 * 0.37).sin() * 3.1);
            poses.push(pose);
        }

        for pose in poses {
            let basis = pose.basis(1.3);
            let towards_viewer = basis.to_lighting_frame(-basis.forward);

            assert!(
                (towards_viewer - Vector3::y()).norm() < 1e-5,
                "the viewer direction mapped to {:?}, not +Y, at {:?}",
                towards_viewer,
                pose
            );

            let x = basis.to_lighting_frame(Vector3::x());
            let y = basis.to_lighting_frame(Vector3::y());
            let z = basis.to_lighting_frame(Vector3::z());

            for mapped in [x, y, z] {
                assert!((mapped.norm() - 1.0).abs() < 1e-5, "length changed: {:?}", mapped);
            }

            assert!(
                (x.cross(&y) - z).norm() < 1e-4,
                "the lighting frame is not a proper rotation at {:?}",
                pose
            );
        }
    }

    /// The orthographic camera's observer must block exactly the reflections that head back along
    /// the view axis from within its radius of that axis, which is what draws Gem Cut Studio's
    /// face-up centre dot.
    ///
    /// Setup: the face-up orthographic camera, whose view axis is world Y through the
    /// stone centre, and an observer of radius 0.0263. The table is at height 0.563.
    /// Test: light leaving the table at several distances from the axis, straight up (as every
    /// table reflection does face-up), plus straight down, 2 degrees off, 1e-6 off (float
    /// noise in a facet normal), and with the observer disabled. Verifies:
    /// - straight up from inside the radius is blocked and from just outside it is not, so the
    ///   dot has the measured size;
    /// - light heading away from the viewer is never blocked, so the observer cannot cast
    ///   anything onto leaks;
    /// - an off-axis direction is not blocked even from the centre, so the effect is a dot
    ///   rather than a cone of directions like the head shadow, while float noise is tolerated;
    /// - radius 0 disables it.
    #[test]
    fn orthographic_observer_blocks_only_light_heading_back_along_the_axis_within_its_radius() {
        let basis = orthographic().basis(1.0);
        let radius = 0.0263;
        let table = |x: f32, z: f32| Point3::new(x, 0.563, z);
        let up = Vector3::y();

        assert!(basis.observer_blocks(radius, table(0.0, 0.0), up), "the centre is in the dot");
        assert!(basis.observer_blocks(radius, table(0.018, -0.018), up), "radius 0.0255 is inside");
        assert!(!basis.observer_blocks(radius, table(0.02, 0.02), up), "radius 0.0283 is outside");
        assert!(!basis.observer_blocks(radius, table(0.3, 0.0), up), "elsewhere on the table");

        assert!(
            !basis.observer_blocks(radius, table(0.0, 0.0), -up),
            "light heading away from the eye must never be blocked"
        );

        let two_degrees = Vector3::new(2f32.to_radians().sin(), 2f32.to_radians().cos(), 0.0);

        assert!(
            !basis.observer_blocks(radius, table(0.0, 0.0), two_degrees),
            "an exit 2 degrees off the axis must not be blocked"
        );

        let float_noise = Vector3::new(1e-6, 1.0, 0.0).normalize();

        assert!(
            basis.observer_blocks(radius, table(0.0, 0.0), float_noise),
            "float noise in the table normal must not remove the dot"
        );
        assert!(!basis.observer_blocks(0.0, table(0.0, 0.0), up), "radius 0 disables it");
    }

    /// With the orthographic camera, the dot must vanish as soon as the stone is turned even a
    /// hundredth of a degree, as the user observed in Gem Cut Studio.
    ///
    /// Setup: the orthographic camera tilted 0.01 degrees, and separately spun 0.01 degrees and
    /// tilted back to face-up. Test: the table's reflection of each camera's own view ray (the
    /// table normal is world +Y), from the table centre. Verifies the tilted reflection is not
    /// blocked (it is 0.02 degrees, 3.5e-4, off the view axis, beyond the tolerance), while
    /// spin alone, which leaves the table facing the viewer, keeps the dot. The perspective
    /// cameras' body is at their eye, so their dot slides first; see the next two tests.
    #[test]
    fn orthographic_observer_dot_vanishes_when_the_stone_is_tilted_a_hundredth_of_a_degree() {
        let radius = 0.0263;
        let centre = Point3::new(0.0, 0.563, 0.0);
        let table_normal = Vector3::y();
        let reflect = |d: Vector3<f32>| d - table_normal * (2.0 * d.dot(&table_normal));

        let tilted = OrbitCamera { tilt: 0.01f32.to_radians(), ..orthographic() }.basis(1.0);
        let spun = OrbitCamera { spin: 0.01f32.to_radians(), ..orthographic() }.basis(1.0);

        assert!(
            !tilted.observer_blocks(radius, centre, reflect(tilted.forward)),
            "a 0.01 degree tilt must remove the dot"
        );
        assert!(
            spun.observer_blocks(radius, centre, reflect(spun.forward)),
            "spinning about the optical axis leaves the table face-up, so the dot stays"
        );
    }

    /// Under Gem Cut Studio's perspective camera the observer must draw the same face-up dot.
    ///
    /// Setup: the default face-up camera, its eye 52 units above the stone centre, an observer
    /// of radius 0.0263, and the table at height 0.563. At each table point the light is the
    /// table's mirror reflection of the camera's own ray to that point, which is what the shader
    /// traces there. Test: points 0, 0.0255 and 0.0283 from the axis and one far out on the table,
    /// then the reversed direction, a direction 2 degrees off, and float noise. Verifies:
    /// - reflections from inside the radius are blocked and from just outside are not, so the dot
    ///   keeps its measured size. The 0.0255 point's reflection is 5e-4 off the axis, which the
    ///   orthographic tolerance would reject; that is checked too;
    /// - light heading away from the viewer is never blocked;
    /// - a direction 2 degrees off is not blocked, so the effect is a dot, not a cone;
    /// - float noise in the table normal does not remove the dot.
    #[test]
    fn perspective_observer_keeps_the_measured_dot() {
        let basis = OrbitCamera::default().basis(1.0);
        let radius = 0.0263;
        let table_normal = Vector3::y();
        let reflection = |x: f32, z: f32| {
            let point = Point3::new(x, 0.563, z);
            let ray = (point - basis.origin).normalize();

            (point, ray - table_normal * (2.0 * ray.dot(&table_normal)))
        };

        for (x, z, blocked, what) in [
            (0.0, 0.0, true, "the centre"),
            (0.018, -0.018, true, "radius 0.0255"),
            (0.02, 0.02, false, "radius 0.0283"),
            (0.3, 0.0, false, "elsewhere on the table"),
        ] {
            let (point, direction) = reflection(x, z);

            assert_eq!(basis.observer_blocks(radius, point, direction), blocked, "{}", what);
        }

        let (_, inside_edge) = reflection(0.018, -0.018);

        assert!(
            inside_edge.cross(&-basis.forward).norm() > OBSERVER_ALIGNMENT_TOLERANCE,
            "setup: that reflection must be outside the orthographic tolerance"
        );

        let (centre, straight_back) = reflection(0.0, 0.0);

        assert!(
            !basis.observer_blocks(radius, centre, -straight_back),
            "light heading away from the eye must never be blocked"
        );

        let two_degrees = Vector3::new(2f32.to_radians().sin(), 2f32.to_radians().cos(), 0.0);

        assert!(
            !basis.observer_blocks(radius, centre, two_degrees),
            "an exit 2 degrees off the axis must not be blocked"
        );
        assert!(
            basis.observer_blocks(radius, centre, Vector3::new(1e-6, 1.0, 0.0).normalize()),
            "float noise in the table normal must not remove the dot"
        );
    }

    /// Under the perspective camera the dot must still vanish within a fraction of a degree of
    /// tilt, sliding off the axis first.
    ///
    /// Setup: the default camera face-up, spun 0.01 degrees, tilted 0.01 degrees and tilted 0.1
    /// degrees. Test: at 81 table points along the tilt direction, 0.00125 apart and spanning
    /// 0.05 either side of the centre, count those whose reflection of the camera's own ray is
    /// blocked. Verifies:
    /// - face-up there is a dot;
    /// - spin alone leaves it unchanged;
    /// - a 0.01 degree tilt leaves a smaller dot, because the body at the eye slides it off the
    ///   axis;
    /// - at 0.1 degrees it is gone. Past 2 x radius / eye distance, 0.058 degrees, no table
    ///   reflection reaches the body, matching the user's GCS observation that a fraction of a
    ///   degree removes the dot.
    #[test]
    fn perspective_observer_dot_slides_and_vanishes_within_a_tenth_of_a_degree() {
        let radius = 0.0263;
        let table_normal = Vector3::y();
        let blocked_points = |camera: OrbitCamera| {
            let basis = camera.basis(1.0);

            (-40..=40)
                .filter(|step| {
                    let point = Point3::new(0.0, 0.563, *step as f32 * 0.00125);
                    let ray = (point - basis.origin).normalize();
                    let reflected = ray - table_normal * (2.0 * ray.dot(&table_normal));

                    basis.observer_blocks(radius, point, reflected)
                })
                .count()
        };

        let face_up = blocked_points(OrbitCamera::default());
        let spun = blocked_points(OrbitCamera { spin: 0.01f32.to_radians(), ..Default::default() });
        let hundredth = blocked_points(OrbitCamera { tilt: 0.01f32.to_radians(), ..Default::default() });
        let tenth = blocked_points(OrbitCamera { tilt: 0.1f32.to_radians(), ..Default::default() });

        assert!(face_up > 30, "face-up, the dot must cover the points within its radius: {}", face_up);
        assert_eq!(spun, face_up, "spin alone must not change the dot");
        assert!(
            hundredth > 0 && hundredth < face_up,
            "a 0.01 degree tilt must shrink the dot, not remove it: {} of {}",
            hundredth,
            face_up
        );
        assert_eq!(tenth, 0, "a 0.1 degree tilt must remove the dot");
    }

    /// The shader must apply the same observer rules and constants as the Rust mirror, or the
    /// dot would appear or vanish at different poses than the tests describe.
    #[test]
    fn shader_applies_the_observer_rules_used_here() {
        let shader = include_str!("shaders/gem.frag");

        assert!(
            shader.contains("const float OBSERVER_ALIGNMENT_TOLERANCE = 1e-4;"),
            "gem.frag must declare OBSERVER_ALIGNMENT_TOLERANCE = 1e-4"
        );
        assert!(
            shader.contains("const float OBSERVER_EYE_RADIUS_SCALE = 2.0;"),
            "gem.frag must declare OBSERVER_EYE_RADIUS_SCALE = 2.0"
        );
        assert!(
            shader.contains("length(cross(direction, towardsViewer)) <= OBSERVER_ALIGNMENT_TOLERANCE"),
            "blockedByObserver must use the orthographic alignment test"
        );
        assert!(
            shader.contains(
                "length(cross(towardsEye, direction)) < OBSERVER_EYE_RADIUS_SCALE * uObserverRadius"
            ),
            "blockedByObserver must use the body at the eye for perspective"
        );
        assert_eq!(OBSERVER_ALIGNMENT_TOLERANCE, 1e-4);
        assert_eq!(OBSERVER_EYE_RADIUS_SCALE, 2.0);
    }

    /// Light leaving through a facet that faces away from the viewer is a leak even when it
    /// heads upwards, as in Gem Cut Studio (T-0026).
    ///
    /// Setup: the default face-up camera, with lighting following the view (identical to world
    /// lighting at this pose). The facets are the oval cut's, turned into the world frame
    /// (optical axis +Y): one of its pavilion facets, whose outward normal points 46 degrees
    /// below the horizon, and a 41.6-degree crown facet. The exit direction is the one an
    /// independent reference tracer found in the oval cut's face-up end windows: out through
    /// that pavilion facet, 11.34 degrees *above* the horizon.
    ///
    /// Test and what it verifies:
    /// - that exit is from behind, although the old direction-only rule lit it;
    /// - the same direction leaving through the crown facet is lit, so the facet decides;
    /// - through the crown facet, a direction just below the horizon is still from behind, so the
    ///   old rule survives;
    /// - a vertical girdle facet with float noise in its normal is judged by direction alone, so
    ///   `BACK_FACET_TOLERANCE` stops it speckling.
    #[test]
    fn light_leaving_through_a_facet_facing_away_comes_from_behind() {
        let basis = OrbitCamera::default().basis(1.0);
        let pavilion = Vector3::new(0.0, -0.720, 0.694).normalize();
        let crown = Vector3::new(0.0, 0.748, 0.664).normalize();
        let eleven_degrees_up = Vector3::new(0.0, 11.34f32.to_radians().sin(), 11.34f32.to_radians().cos());

        assert!(
            eleven_degrees_up.dot(&pavilion) > 0.0,
            "setup: the direction must actually leave through the pavilion facet"
        );
        assert!(
            basis.light_comes_from_behind(true, eleven_degrees_up, pavilion),
            "an upward exit through a pavilion facet is a leak"
        );
        assert!(
            !basis.light_comes_from_behind(true, eleven_degrees_up, crown),
            "the same direction through a crown facet is lit"
        );

        let just_below = Vector3::new(0.0, -0.01, 1.0).normalize();

        assert!(
            basis.light_comes_from_behind(true, just_below, crown),
            "light from below the horizon is a leak through any facet"
        );

        let girdle_with_noise = Vector3::new(1.0, -1e-6, 0.0).normalize();
        let slightly_up = Vector3::new(1.0, 0.05, 0.0).normalize();

        assert!(
            !basis.light_comes_from_behind(true, slightly_up, girdle_with_noise),
            "float noise in a vertical facet's normal must not make it a back facet"
        );
    }

    /// The facet rule uses the lighting frame, so it follows the view when the lighting does.
    ///
    /// Setup: the camera tilted 23 degrees (GCS's X Rotation 23). A facet whose world normal
    /// points 17.5 degrees above the world horizon, but tipped away from the tilted viewer (its
    /// dot with the direction towards the eye is -0.097), and light leaving it straight up
    /// world +Y, which is above the horizon in both frames. Test: judge it with the lighting
    /// following the view and with it fixed to the world. Verifies it is a leak in the
    /// viewer-locked frame, where the facet faces away, and lit in the world frame, where it
    /// faces up. A rule written in world coordinates would get the tilted GCS views wrong.
    #[test]
    fn back_facet_rule_follows_the_lighting_frame() {
        let basis = OrbitCamera { tilt: 23f32.to_radians(), ..Default::default() }.basis(1.0);
        let facet = Vector3::new(0.0, 0.3, -0.954).normalize();
        let straight_up = Vector3::y();

        assert!(
            facet.dot(&-basis.forward) < 0.0,
            "setup: the facet must face away from the tilted viewer"
        );
        assert!(basis.light_comes_from_behind(true, straight_up, facet), "viewer-locked: a leak");
        assert!(!basis.light_comes_from_behind(false, straight_up, facet), "world-fixed: lit");
    }

    /// The shader must apply the same back-facet rule and tolerance as the Rust mirror, or the
    /// tests above would describe windows the renderer does not draw.
    #[test]
    fn shader_applies_the_back_facet_rule_used_here() {
        let shader = include_str!("shaders/gem.frag");

        assert!(
            shader.contains("const float BACK_FACET_TOLERANCE = 1e-4;"),
            "gem.frag must declare BACK_FACET_TOLERANCE = 1e-4"
        );
        assert!(
            shader.contains(
                "if (direction.y < 0.0 || toLightingFrame(outwardNormal).y < -BACK_FACET_TOLERANCE) {"
            ),
            "arrivingLight must test both the direction and the exit facet"
        );
        assert_eq!(BACK_FACET_TOLERANCE, 1e-4);
    }

    /// Forward must point from the camera at the target, at every orientation.
    #[test]
    fn forward_always_points_at_the_target() {
        let mut camera = OrbitCamera::default();

        for step in 0..24 {
            camera.set_orientation(step as f32 * 0.31, (step as f32 * 0.17).sin() * 3.1);

            let basis = camera.basis(1.5);
            let to_target = (camera.target - basis.origin).normalize();

            assert!(
                (basis.forward - to_target).norm() < 1e-5,
                "step {}: forward {:?} does not point at the target {:?}",
                step,
                basis.forward,
                to_target
            );
        }
    }

    /// The eye must sit where its projection puts it, which is what makes zoom predictable.
    ///
    /// Setup: the default, lens and orthographic cameras at three orbit distances. Test: measure
    /// how far `eye()` and the basis origin are from the target. Verifies the default camera's
    /// eye stays `GEM_CUT_STUDIO_EYE_DISTANCE` away whatever the zoom, while a lens's eye and the
    /// orthographic ray plane sit at the orbit distance.
    #[test]
    fn eye_sits_at_the_distance_its_projection_uses() {
        for distance in [1.5f32, 4.0, 12.0] {
            for (camera, expected) in [
                (OrbitCamera { distance, ..Default::default() }, GEM_CUT_STUDIO_EYE_DISTANCE),
                (OrbitCamera { distance, ..perspective() }, distance),
                (OrbitCamera { distance, ..orthographic() }, distance),
            ] {
                let actual = (camera.eye() - camera.target).norm();
                let origin = (camera.basis(1.0).origin - camera.target).norm();

                assert!(
                    (actual - expected).abs() < 1e-3 && (origin - expected).abs() < 1e-3,
                    "expected {} at distance {}, got eye {} and origin {} for {:?}",
                    expected,
                    distance,
                    actual,
                    origin,
                    camera
                );
            }
        }
    }

    /// Tilting must pass smoothly through face-up and face-down, in both directions.
    ///
    /// Setup: pairs of poses a hundredth of a radian either side of tilt 0 (face-up) and of
    /// tilt +/-PI (face-down, where the wrap happens), at an arbitrary spin. Test: build both
    /// bases. Verifies they are nearly identical: `right` is unchanged and `forward` and `up`
    /// move by about the tilt step. The old yaw/pitch camera built `right` from
    /// `cross(forward, world up)`, which is undefined at the poles and flips across them; it
    /// had to clamp there, so the view could not tilt the other way through face-up. A flip
    /// here would show as the image jumping upside down mid-drag.
    #[test]
    fn tilt_passes_smoothly_through_face_up_and_face_down() {
        for centre in [0.0f32, PI] {
            let before = OrbitCamera { spin: 0.8, tilt: centre - 0.005, ..Default::default() };
            let after = OrbitCamera { spin: 0.8, tilt: centre + 0.005, ..Default::default() };

            let mut wrapped = after;

            wrapped.set_orientation(after.spin, after.tilt);

            for camera in [after, wrapped] {
                let (a, b) = (before.basis(1.0), camera.basis(1.0));

                assert!((a.right - b.right).norm() < 1e-6, "right flipped at tilt {}", centre);
                assert!((a.forward - b.forward).norm() < 0.02, "forward jumped at tilt {}", centre);
                assert!((a.up - b.up).norm() < 0.02, "up jumped at tilt {}", centre);
            }
        }
    }

    /// Positive tilt must be Gem Cut Studio's positive X Rotation, and must reproduce the
    /// exact pose the 23 degree GCS comparisons were verified with.
    ///
    /// Setup: tilt 23 degrees, spin 0; and, as the independent reference, the basis the old
    /// yaw/pitch camera produced for those renders (`orbit(0, -23°)` from its face-up pitch,
    /// giving pitch = 90° - 23°): eye at (0, sin pitch, cos pitch), `right` =
    /// normalize(forward x world up). Test: compare the bases. Verifies they agree, so the
    /// numbers in kb/gcs-reference-matching.md still describe `tilt = 23`.
    #[test]
    fn positive_tilt_is_the_gem_cut_studio_x_rotation_pose() {
        for spin in [0.0f32, 1.1, -2.5] {
            let camera = OrbitCamera { spin, tilt: 23f32.to_radians(), ..Default::default() };
            let basis = camera.basis(1.0);

            let pitch = (90.0f32 - 23.0).to_radians();
            let old_eye = Vector3::new(
                pitch.cos() * spin.sin(),
                pitch.sin(),
                pitch.cos() * spin.cos(),
            );
            let old_forward = -old_eye;
            let old_right = old_forward.cross(&WORLD_UP).normalize();
            let old_up = old_right.cross(&old_forward);

            assert!((basis.forward - old_forward).norm() < 1e-5, "forward differs at spin {}", spin);
            assert!((basis.right - old_right).norm() < 1e-5, "right differs at spin {}", spin);
            assert!((basis.up - old_up).norm() < 1e-5, "up differs at spin {}", spin);
        }
    }

    /// Spin and tilt must wrap rather than accumulate without bound, so a long drag
    /// cannot grow the values until float precision degrades.
    #[test]
    fn spin_and_tilt_wrap_into_a_single_turn() {
        let mut camera = OrbitCamera::default();

        for _ in 0..1000 {
            camera.orbit(0.5, -0.7);
        }

        assert!((-PI..PI).contains(&camera.spin), "spin grew without bound: {}", camera.spin);
        assert!((-PI..PI).contains(&camera.tilt), "tilt grew without bound: {}", camera.tilt);
    }

    /// Wrapping must preserve the actual pose, not just the numeric range: angles one
    /// full turn apart must place and orient the camera identically.
    #[test]
    fn wrapping_preserves_the_pose() {
        let unwrapped = OrbitCamera { spin: 0.3 + TAU, tilt: -0.9 - TAU, ..perspective() };
        let mut wrapped = unwrapped;

        wrapped.set_orientation(unwrapped.spin, unwrapped.tilt);

        assert!(
            (wrapped.eye() - unwrapped.eye()).norm() < 1e-4,
            "wrapping changed where the camera is: {:?} vs {:?}",
            wrapped.eye(),
            unwrapped.eye()
        );
        assert!((wrapped.basis(1.0).up - unwrapped.basis(1.0).up).norm() < 1e-4);
    }

    /// Zoom must be clamped at both ends: too close and the camera enters the
    /// stone, too far and it becomes a subpixel dot.
    #[test]
    fn zoom_is_clamped_at_both_ends() {
        let mut camera = OrbitCamera::default();

        for _ in 0..100 {
            camera.zoom(0.5);
        }

        assert!(
            (camera.distance - MIN_DISTANCE).abs() < 1e-5,
            "expected to clamp at the near limit, got {}",
            camera.distance
        );

        for _ in 0..100 {
            camera.zoom(2.0);
        }

        assert!(
            (camera.distance - MAX_DISTANCE).abs() < 1e-4,
            "expected to clamp at the far limit, got {}",
            camera.distance
        );
    }

    /// The near clamp must keep the camera outside the unit sphere the stone is
    /// normalised into, otherwise the camera ends up inside the solid and the
    /// primary ray starts in the wrong medium.
    #[test]
    fn near_zoom_limit_keeps_the_camera_outside_the_stone() {
        assert!(
            MIN_DISTANCE > 1.0,
            "the stone is normalised to radius 1, so the camera must stay beyond that"
        );
    }

    /// Zoom and rotation must ignore nonsense input rather than corrupting the camera. A NaN
    /// distance would propagate into every ray and blank the frame permanently,
    /// with no way for the user to recover except reloading.
    #[test]
    fn zoom_and_orbit_ignore_non_finite_input() {
        let mut camera = OrbitCamera::default();
        let before = camera;

        camera.zoom(f32::NAN);
        camera.zoom(0.0);
        camera.zoom(-1.0);
        camera.orbit(f32::NAN, 0.0);
        camera.orbit(0.0, f32::INFINITY);
        camera.set_orientation(f32::NAN, 0.3);
        camera.set_orientation(0.3, f32::NEG_INFINITY);
        camera.set_eye_distance(f32::NAN);
        camera.set_eye_distance(f32::INFINITY);

        assert_eq!(camera, before, "invalid input must leave the camera untouched");
    }

    /// The ray through the centre of the viewport must be exactly the forward
    /// direction, in both projections; any deviation means the whole image is
    /// off-centre.
    #[test]
    fn centre_ray_equals_forward() {
        for camera in [OrbitCamera::default(), orthographic(), perspective()] {
            let basis = camera.basis(16.0 / 9.0);
            let centre = basis.ray_direction(0.0, 0.0);

            assert!(
                (centre - basis.forward).norm() < 1e-6,
                "centre ray {:?} should equal forward {:?}",
                centre,
                basis.forward
            );
            assert_eq!(basis.ray_origin(0.0, 0.0), basis.origin);
        }
    }

    /// The vertical angle between the centre ray and the top edge ray must equal
    /// half the field of view. This is the check that the projection is actually
    /// the requested lens rather than an arbitrary scale.
    #[test]
    fn edge_ray_matches_half_the_field_of_view() {
        let camera = perspective();
        let basis = camera.basis(1.0);

        let top = basis.ray_direction(0.0, 1.0);
        let angle = basis.forward.dot(&top).clamp(-1.0, 1.0).acos();

        assert!(
            (angle - camera.vertical_fov * 0.5).abs() < 1e-4,
            "expected half-FOV {}, got {}",
            camera.vertical_fov * 0.5,
            angle
        );
    }

    /// A wider viewport must widen the horizontal field of view while leaving the
    /// vertical one alone. Getting this backwards squashes the stone.
    #[test]
    fn aspect_ratio_widens_horizontally_only() {
        let camera = perspective();
        let square = camera.basis(1.0);
        let wide = camera.basis(2.0);

        let horizontal = |basis: &CameraBasis| {
            basis
                .forward
                .dot(&basis.ray_direction(1.0, 0.0))
                .clamp(-1.0, 1.0)
                .acos()
        };
        let vertical = |basis: &CameraBasis| {
            basis
                .forward
                .dot(&basis.ray_direction(0.0, 1.0))
                .clamp(-1.0, 1.0)
                .acos()
        };

        assert!(
            horizontal(&wide) > horizontal(&square),
            "a wider viewport should widen the horizontal FOV: {} vs {}",
            horizontal(&wide),
            horizontal(&square)
        );
        assert!(
            (vertical(&square) - vertical(&wide)).abs() < 1e-5,
            "the vertical FOV must not depend on aspect: {} vs {}",
            vertical(&square),
            vertical(&wide)
        );
    }

    /// A degenerate aspect ratio (a zero-height canvas during layout, which really
    /// happens) must not produce NaN rays, in either projection.
    #[test]
    fn degenerate_aspect_ratio_falls_back_safely() {
        for camera in [OrbitCamera::default(), orthographic(), perspective()] {
            for aspect in [0.0f32, -1.0, f32::NAN, f32::INFINITY] {
                let basis = camera.basis(aspect);
                let ray = basis.ray_direction(1.0, 1.0);
                let origin = basis.ray_origin(1.0, 1.0);

                assert!(
                    ray.iter().all(|c| c.is_finite()) && origin.iter().all(|c| c.is_finite()),
                    "aspect {} produced a non-finite ray {:?} from {:?}",
                    aspect,
                    ray,
                    origin
                );
                assert!(
                    (ray.norm() - 1.0).abs() < 1e-5,
                    "aspect {} produced a non-unit ray",
                    aspect
                );
            }
        }
    }

    /// Every corner ray must be unit length and point generally forward, which
    /// confirms the field of view is not so wide that the frustum inverts.
    #[test]
    fn all_corner_rays_are_unit_and_forward_facing() {
        let mut camera = perspective();

        camera.set_vertical_fov(MAX_FOV);

        let basis = camera.basis(16.0 / 9.0);

        for (x, y) in [(-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)] {
            let ray = basis.ray_direction(x, y);

            assert!(
                (ray.norm() - 1.0).abs() < 1e-6,
                "corner ({}, {}) is not unit length",
                x,
                y
            );
            assert!(
                ray.dot(&basis.forward) > 0.0,
                "corner ({}, {}) points behind the camera",
                x,
                y
            );
        }
    }

    /// The primary ray must start on its own ray, outside the stone, and close to it.
    ///
    /// Setup: the default camera (Gem Cut Studio's eye, 52 units away), the orthographic camera and
    /// a lens camera, each face-up and at an oblique pose, at the default zoom and zoomed fully in,
    /// on a wide viewport. Rays go through the centre, the four corners, the middle of an edge and an
    /// arbitrary point.
    ///
    /// Test: build each ray's start with `ray_start`, and compare it with `ray_origin` and
    /// `ray_direction`.
    ///
    /// Verifies, for every ray:
    /// - the start lies on the ray, ahead of its origin, so no pixel's ray changes;
    /// - it is at least `PRIMARY_RAY_START_RADIUS` from the world origin, where the conditioner centres
    ///   every stone at radius 1, so nothing in front of the stone is skipped;
    /// - where the ray passes through the stone's unit sphere, the start is within sqrt(1 + radius²),
    ///   about 1.45, of the world origin, so the triangle test works with small numbers. From Gem Cut
    ///   Studio's eye those rays would start 52 away.
    #[test]
    fn ray_start_is_on_the_ray_outside_the_stone_and_close_to_it() {
        let mut cameras = Vec::new();

        for base in [OrbitCamera::default(), orthographic(), perspective()] {
            for (spin, tilt) in [(0.0, 0.0), (0.6, 1.15)] {
                for zoomed_in in [false, true] {
                    let mut camera = OrbitCamera { spin, tilt, ..base };

                    if zoomed_in {
                        camera.distance = MIN_DISTANCE;
                    }

                    cameras.push(camera);
                }
            }
        }

        let near_limit = (1.0 + PRIMARY_RAY_START_RADIUS * PRIMARY_RAY_START_RADIUS).sqrt() + 1e-4;
        let mut passing_through = 0;

        for camera in cameras {
            let basis = camera.basis(16.0 / 9.0);

            for (x, y) in [(0.0, 0.0), (-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.3, -0.7)] {
                let origin = basis.ray_origin(x, y);
                let direction = basis.ray_direction(x, y);
                let start = basis.ray_start(x, y);
                let travelled = start - origin;

                assert!(
                    travelled.cross(&direction).norm() < 1e-4 && travelled.dot(&direction) >= 0.0,
                    "the start {:?} of the ray at ({}, {}) is not ahead of {:?} along {:?}, for {:?}",
                    start,
                    x,
                    y,
                    origin,
                    direction,
                    camera
                );
                assert!(
                    start.coords.norm() >= PRIMARY_RAY_START_RADIUS - 1e-4,
                    "the ray at ({}, {}) starts {} from the world origin, inside the start radius, for {:?}",
                    x,
                    y,
                    start.coords.norm(),
                    camera
                );

                // The ray's closest approach to the world origin, where the stone is.
                if origin.coords.cross(&direction).norm() < 1.0 {
                    passing_through += 1;

                    assert!(
                        start.coords.norm() <= near_limit,
                        "the ray at ({}, {}) passes through the stone but starts {} away, for {:?}",
                        x,
                        y,
                        start.coords.norm(),
                        camera
                    );
                }
            }
        }

        assert!(passing_through > 20, "setup: only {} rays pass through the stone's sphere", passing_through);
    }

    /// Primary hits traced from `ray_start` must land on the stone's surface well within the shader's
    /// surface epsilon, as hits traced from Gem Cut Studio's eye did not (T-0032).
    ///
    /// Setup: the oval cut, conditioned exactly as the page conditions it, and the default camera at
    /// the oval cut's side comparison pose (spin -44.561 and tilt 14.106 degrees, which with an image
    /// roll is GCS's X 10, Y 10) on the 1168 x 978 comparison viewport. Rays go through the centre of
    /// every fifth pixel in each direction and are traced as rays from outside by `Accel::trace`, the
    /// mirror of the shader's traversal. Each hit point is computed as the shader computes it, start +
    /// direction x distance, in f32, and its distance from the hit triangle's plane is then measured
    /// in f64.
    ///
    /// Test: trace every ray twice, once from `ray_origin`, the eye, as the shader did before T-0032,
    /// and once from `ray_start`.
    ///
    /// Verifies:
    /// - both starts hit the stone with the same rays, give or take a few at the silhouette;
    /// - from the eye, at least ten hit points are more than the shader's surface epsilon (1e-4) off the
    ///   surface. An interior march started from such a point, pushed only 1e-4 inwards, began outside
    ///   the stone: those points drew the window-colour lines. So the test catches a return to starting
    ///   at the eye;
    /// - from `ray_start`, every hit point is within half of that epsilon.
    ///
    /// Over the whole viewport (T-0032) it was 1,223 points off by more than the epsilon from the eye,
    /// and none off by more than half of it from the start.
    #[test]
    fn primary_hits_traced_from_the_ray_start_land_on_the_surface() {
        use crate::accel::{Accel, RaySide};

        // gem.frag's SURFACE_EPSILON: how far the shader pushes an entry point into the stone.
        const SURFACE_EPSILON: f64 = 1e-4;
        const WIDTH: usize = 1168;
        const HEIGHT: usize = 978;

        let (mesh, _, _) = crate::conditioned_mesh(
            include_str!("../resources/oval_cut.obj"),
            crate::mesh::ModelAxis::PlusZ,
        )
        .expect("the oval cut must load");
        let accel = Accel::build(&mesh).expect("the oval cut must build a BVH");
        let mut camera = OrbitCamera::default();

        camera.set_orientation((-44.561f32).to_radians(), 14.106f32.to_radians());

        let basis = camera.basis(WIDTH as f32 / HEIGHT as f32);

        // For rays starting where `start` says: (hits, hit points more than the epsilon off the
        // surface, the largest distance of a hit point from the surface).
        let measure = |start: &dyn Fn(f32, f32) -> Point3<f32>| {
            let mut hits = 0i64;
            let mut beyond_epsilon = 0;
            let mut worst = 0.0f64;

            for row in (0..HEIGHT).step_by(5) {
                for column in (0..WIDTH).step_by(5) {
                    let x = (column as f32 + 0.5) / WIDTH as f32 * 2.0 - 1.0;
                    let y = ((HEIGHT - 1 - row) as f32 + 0.5) / HEIGHT as f32 * 2.0 - 1.0;
                    let (origin, direction) = (start(x, y), basis.ray_direction(x, y));

                    if let Some(hit) = accel.trace(origin, direction, 1e-4, 1e9, RaySide::Outside) {
                        let shape = &accel.shapes[hit.triangle];
                        let a = shape.a.coords.cast::<f64>();
                        let normal = (shape.b.coords.cast::<f64>() - a)
                            .cross(&(shape.c.coords.cast::<f64>() - a))
                            .normalize();
                        let point = (origin + direction * hit.distance).coords.cast::<f64>();
                        let off_surface = normal.dot(&(point - a)).abs();

                        hits += 1;
                        worst = worst.max(off_surface);

                        if off_surface > SURFACE_EPSILON {
                            beyond_epsilon += 1;
                        }
                    }
                }
            }

            (hits, beyond_epsilon, worst)
        };

        let from_eye = measure(&|x: f32, y: f32| basis.ray_origin(x, y));
        let from_start = measure(&|x: f32, y: f32| basis.ray_start(x, y));

        eprintln!(
            "(hits, points more than 1e-4 off the surface, worst offset): from the eye {:?}, from the start {:?}",
            from_eye, from_start
        );

        assert!(
            from_eye.0 > 10_000 && (from_start.0 - from_eye.0).abs() <= 5,
            "setup: the two starts must hit the stone with the same rays, got {} and {} hits",
            from_eye.0,
            from_start.0
        );
        assert!(
            from_eye.1 >= 10,
            "setup: from the eye only {} hit points were more than the epsilon off the surface",
            from_eye.1
        );
        assert!(
            from_start.2 < SURFACE_EPSILON / 2.0,
            "from the ray start a hit point is {:e} off the surface",
            from_start.2
        );
    }

    /// The shader must start primary rays where `ray_start` does, or the test above would describe a
    /// start the renderer does not use.
    ///
    /// Setup: the text of `gem.frag`. Test: look for the start radius declared with this module's
    /// value, and for `main` moving the ray's origin along the ray to that radius. Verifies the shader
    /// and the mirror start every primary ray at the same place.
    #[test]
    fn shader_starts_primary_rays_where_the_mirror_does() {
        let shader = include_str!("shaders/gem.frag");
        let radius = format!("const float PRIMARY_RAY_START_RADIUS = {:?};", PRIMARY_RAY_START_RADIUS);

        assert!(shader.contains(&radius), "gem.frag must declare {}", radius);
        assert!(
            shader.contains(
                "origin += direction * max(dot(-origin, direction) - PRIMARY_RAY_START_RADIUS, 0.0);"
            ),
            "main in gem.frag must move the primary ray's origin to the start radius"
        );
    }
}
