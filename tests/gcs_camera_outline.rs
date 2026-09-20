//! Gem Cut Studio's camera, checked against GCS's own screenshot of the oval cut (T-0041, T-0044).
//!
//! `reference/application_images/oval_cut/oval_cut_gcs_x60_cosine.png` is a Gem Cut Studio 1.1.0
//! screenshot
//! of `resources/oval_cut.obj`, taken by the user on 2026-09-15. It is at X Rotation 60, which is this
//! renderer's tilt 60, and Y Rotation 0. The rest of the scene: Cosine lighting, 10 bounces,
//! refractive index 1.61 with no dispersion, GCS's grey background and a green window colour. Cosine
//! is one of the models this renderer reproduces, so the same screenshot also serves as a render
//! comparison (`renders/compare.html`). GCS rendered it at 536 px and showed it about 2.2 times
//! larger.
//!
//! A stone's outline depends only on the camera and the geometry, not on lighting, material or band
//! edges, so the outline alone measures GCS's projection. Tilted 60 degrees the stone is deep along
//! the view, so a perspective eye draws its near side measurably larger than its far side. Face-up,
//! the outline could not tell perspective from orthographic.
//!
//! The tests share one measurement, built once by `measurement()`:
//! 1. **Edge points.** About 1,600 sub-pixel points on the stone's edge in the screenshot, each
//!    found along the outward normal of a first guess at the outline, where the stone's contrast
//!    with the background rises most steeply. The same method T-0041 used (its `fit.py`).
//! 2. **Model outline.** The oval cut, conditioned exactly as the page conditions it
//!    (`conditioned_mesh`), projected by a camera. The stone is convex, so its silhouette is the
//!    convex hull of its projected vertices; a separate test checks that against traced rays.
//! 3. **Registration.** GCS's window size sets its zoom, so each camera's outline is fitted to the
//!    points by least squares in scale and position only, never in shape. The RMS distance of the
//!    points from that fitted outline is how well the camera's projection matches GCS's.
//!
//! GCS's edges are aliased, which leaves about half a pixel RMS even for the right camera. The
//! measurement is deterministic, so the numbers quoted in each test only change if this file, the
//! camera or the model does.

use std::fs::File;
use std::io::BufReader;
use std::ops::Range;
use std::sync::OnceLock;

use gem_renderer::accel::{Accel, RaySide};
use gem_renderer::camera::{CameraBasis, OrbitCamera, GEM_CUT_STUDIO_EYE_DISTANCE};
use gem_renderer::conditioned_mesh;
use gem_renderer::mesh::{Mesh, ModelAxis};
use nalgebra::{Matrix3, Point3, Vector3};

const SCREENSHOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/reference/application_images/oval_cut/oval_cut_gcs_x60_cosine.png"
);
const OVAL_CUT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/resources/oval_cut.obj");

/// Whether the Gem Cut Studio screenshot every test here measures is actually present.
///
/// `reference/` holds several hundred megabytes of third-party captures, sample designs and the
/// LuxCore checkout, and is deliberately left uncommitted (see `.gitignore`), so a fresh clone
/// has no screenshot. `src/resources/` is committed, so only the screenshot can be missing.
///
/// Rust's test harness has no way to report a skip from inside a test, so each test below
/// returns early instead, after printing why. The point is that `./build.sh`, which runs
/// `cargo test` before it builds anything, must succeed on a clone that has no `reference/`;
/// when the data *is* there, every assertion still runs and a camera regression still fails.
fn screenshot_is_available() -> bool {
    if std::path::Path::new(SCREENSHOT).is_file() {
        return true;
    }

    eprintln!("skipping: {} is absent (reference/ is not committed)", SCREENSHOT);

    false
}

/// GCS's X Rotation in the screenshot, which is this renderer's tilt, in degrees.
const TILT_DEGREES: f32 = 60.0;

/// GCS's flat background, HSL (0, 0, 0.35), as the screenshot stores it in every channel.
const BACKGROUND: f32 = 88.0;

/// The screenshot's render panel, in pixels: left of GCS's controls, below its "Render" title and
/// above its buttons. It holds only the stone and the background.
const PANEL_COLUMNS: Range<usize> = 0..1150;
const PANEL_ROWS: Range<usize> = 60..1100;

/// A position in the plane: normalised device coordinates (x right, y up) or pixels (y down).
type Point2 = [f64; 2];

/// The screenshot, reduced to how much each pixel differs from GCS's background.
struct Screenshot {
    width: usize,
    height: usize,
    /// |R - 88| + |G - 88| + |B - 88| per pixel, row by row: 0 on the background, tens to
    /// hundreds on the stone, and in between on the one or two pixels an edge blends across.
    stoneness: Vec<f32>,
}

impl Screenshot {
    fn load() -> Screenshot {
        let file = File::open(SCREENSHOT)
            .unwrap_or_else(|error| panic!("cannot open {}: {}", SCREENSHOT, error));
        let mut decoder = png::Decoder::new(BufReader::new(file));

        decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);

        let mut reader = decoder.read_info().expect("the screenshot must be a PNG");
        let mut buffer =
            vec![0u8; reader.output_buffer_size().expect("the screenshot must fit in memory")];
        let info = reader.next_frame(&mut buffer).expect("the screenshot must decode");

        let channels = match info.color_type {
            png::ColorType::Rgb => 3,
            png::ColorType::Rgba => 4,
            other => panic!("expected an RGB or RGBA screenshot, got {:?}", other),
        };
        let (width, height) = (info.width as usize, info.height as usize);

        let stoneness = buffer[..width * height * channels]
            .chunks_exact(channels)
            .map(|pixel| pixel[..3].iter().map(|&value| (value as f32 - BACKGROUND).abs()).sum())
            .collect();

        Screenshot { width, height, stoneness }
    }

    fn at(&self, column: usize, row: usize) -> f64 {
        self.stoneness[row * self.width + column] as f64
    }

    /// Stoneness at a position in pixels, where pixel (column, row) covers [column, column + 1) x
    /// [row, row + 1): bilinear between pixel centres, held constant past the image border.
    fn sample(&self, x: f64, y: f64) -> f64 {
        let fx = (x - 0.5).clamp(0.0, (self.width - 1) as f64);
        let fy = (y - 0.5).clamp(0.0, (self.height - 1) as f64);
        let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.width - 1), (y0 + 1).min(self.height - 1));
        let (tx, ty) = (fx - x0 as f64, fy - y0 as f64);

        let top = self.at(x0, y0) * (1.0 - tx) + self.at(x1, y0) * tx;
        let bottom = self.at(x0, y1) * (1.0 - tx) + self.at(x1, y1) * tx;

        top * (1.0 - ty) + bottom * ty
    }

    /// The stone's bounding box in the render panel, as pixel edges: [left, top, right, bottom].
    fn stone_bounds(&self) -> [f64; 4] {
        let mut bounds = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];

        for row in PANEL_ROWS {
            for column in PANEL_COLUMNS {
                if self.at(column, row) > 0.0 {
                    bounds[0] = bounds[0].min(column as f64);
                    bounds[1] = bounds[1].min(row as f64);
                    bounds[2] = bounds[2].max(column as f64 + 1.0);
                    bounds[3] = bounds[3].max(row as f64 + 1.0);
                }
            }
        }

        bounds
    }
}

/// The oval cut, conditioned exactly as the page conditions an opened OBJ.
fn oval_cut() -> Mesh {
    let text = std::fs::read_to_string(OVAL_CUT).expect("resources/oval_cut.obj must be readable");
    let (mesh, diagnostics, _) =
        conditioned_mesh(&text, ModelAxis::PlusZ).expect("the oval cut must load");

    assert!(diagnostics.is_watertight(), "the oval cut must be a closed solid");

    mesh
}

/// A camera at the screenshot's pose, GCS's X Rotation 60 and Y Rotation 0, with the given eye
/// distance (0 is orthographic).
fn camera_at_the_screenshot_pose(eye_distance: f32) -> OrbitCamera {
    let mut camera = OrbitCamera::default();

    camera.set_orientation(0.0, TILT_DEGREES.to_radians());
    camera.set_eye_distance(eye_distance);

    camera
}

/// Where a world point lands in normalised device coordinates on a square viewport: x right,
/// y up, and the view's half-height is 1. The same projection the camera's rays make (checked by
/// `projected_outline_is_what_the_traced_rays_see`), computed in f64.
fn project(basis: &CameraBasis, point: &Point3<f32>) -> Point2 {
    let offset = point.coords.cast::<f64>() - basis.origin.coords.cast::<f64>();
    let x = offset.dot(&basis.right.cast::<f64>());
    let y = offset.dot(&basis.up.cast::<f64>());

    if basis.is_orthographic() {
        let half_height = basis.orthographic_half_height as f64;

        [x / half_height, y / half_height]
    } else {
        let scale = offset.dot(&basis.forward.cast::<f64>()) * basis.tan_half_fov as f64;

        [x / scale, y / scale]
    }
}

/// Convex hull, counter-clockwise, by Andrew's monotone chain.
fn convex_hull(mut points: Vec<Point2>) -> Vec<Point2> {
    points.sort_by(|a, b| a.partial_cmp(b).expect("projected points must be finite"));
    points.dedup();

    let turn = |o: Point2, a: Point2, b: Point2| {
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    };
    let mut lower: Vec<Point2> = Vec::new();
    let mut upper: Vec<Point2> = Vec::new();

    for &point in &points {
        while lower.len() >= 2 && turn(lower[lower.len() - 2], lower[lower.len() - 1], point) <= 0.0 {
            lower.pop();
        }

        lower.push(point);
    }

    for &point in points.iter().rev() {
        while upper.len() >= 2 && turn(upper[upper.len() - 2], upper[upper.len() - 1], point) <= 0.0 {
            upper.pop();
        }

        upper.push(point);
    }

    lower.pop();
    upper.pop();
    lower.extend(upper);

    lower
}

/// The stone's outline for a camera, in normalised device coordinates.
fn outline(mesh: &Mesh, camera: &OrbitCamera) -> Vec<Point2> {
    let basis = camera.basis(1.0);

    convex_hull(mesh.positions.iter().map(|point| project(&basis, point)).collect())
}

/// An outline placed in the screenshot by a registration [scale in px per unit, x, y].
fn to_pixels(outline: &[Point2], registration: &[f64; 3]) -> Vec<Point2> {
    let [scale, x, y] = *registration;

    outline.iter().map(|point| [x + scale * point[0], y - scale * point[1]]).collect()
}

/// Distance from a point to a convex polygon's boundary, positive outside and negative inside.
fn signed_distance(point: Point2, polygon: &[Point2]) -> f64 {
    let count = polygon.len();
    let doubled_area: f64 = (0..count)
        .map(|i| {
            let (a, b) = (polygon[i], polygon[(i + 1) % count]);

            a[0] * b[1] - b[0] * a[1]
        })
        .sum();

    let mut nearest = f64::INFINITY;
    let mut inside = true;

    for i in 0..count {
        let (a, b) = (polygon[i], polygon[(i + 1) % count]);
        let edge = [b[0] - a[0], b[1] - a[1]];
        let to_point = [point[0] - a[0], point[1] - a[1]];
        let along = ((to_point[0] * edge[0] + to_point[1] * edge[1])
            / (edge[0] * edge[0] + edge[1] * edge[1]))
            .clamp(0.0, 1.0);

        nearest = nearest
            .min((to_point[0] - along * edge[0]).hypot(to_point[1] - along * edge[1]));

        if (edge[0] * to_point[1] - edge[1] * to_point[0]) * doubled_area.signum() < 0.0 {
            inside = false;
        }
    }

    if inside {
        -nearest
    } else {
        nearest
    }
}

/// Sub-pixel edge points of the stone, searched along the outward normals of a guessed outline
/// in pixels.
///
/// Points go every pixel along each outline edge, except within 8 px of a corner turning by more
/// than 25 degrees, where a render's pixels cannot place the edge, and 1.5 px of gentler ones.
/// Along each normal, stoneness is sampled every quarter pixel from 8 px inside to 8 px outside.
/// The edge is the outermost place, within 5 px of the guess, where stoneness rises most steeply
/// going inwards: a peak in that gradient of at least 25 per pixel, refined with a parabola. Unlike
/// a threshold, that does not depend on how bright the stone is behind the edge. A point is kept
/// only when the background beyond it is clean (stoneness at most 12, from 2.5 px outside) and the
/// stone inside it is clearly stone (a median of at least 60, 2.5 to 4.5 px inside), so a rim that
/// happens to match the background grey cannot pull the edge inwards.
fn edge_points(shot: &Screenshot, guess: &[Point2]) -> Vec<Point2> {
    let count = guess.len();
    let centre = guess.iter().fold([0.0, 0.0], |sum, p| [sum[0] + p[0], sum[1] + p[1]]);
    let centre = [centre[0] / count as f64, centre[1] / count as f64];

    let turn_degrees = |i: usize| {
        let (before, at, after) = (guess[(i + count - 1) % count], guess[i], guess[(i + 1) % count]);
        let u = [at[0] - before[0], at[1] - before[1]];
        let v = [after[0] - at[0], after[1] - at[1]];
        let cosine = (u[0] * v[0] + u[1] * v[1]) / (u[0].hypot(u[1]) * v[0].hypot(v[1]));

        cosine.clamp(-1.0, 1.0).acos().to_degrees()
    };
    let gap = |i: usize| if turn_degrees(i) > 25.0 { 8.0 } else { 1.5 };

    const STEP: f64 = 0.25;
    let offsets: Vec<f64> = (0..=64).map(|k| -8.0 + k as f64 * STEP).collect();
    let mut points = Vec::new();

    for i in 0..count {
        let (a, b) = (guess[i], guess[(i + 1) % count]);
        let length = (b[0] - a[0]).hypot(b[1] - a[1]);
        let (gap_a, gap_b) = (gap(i), gap((i + 1) % count));

        if length < gap_a + gap_b + 1.0 {
            continue;
        }

        let along = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
        let mut normal = [along[1], -along[0]];
        let middle = [(a[0] + b[0]) / 2.0 - centre[0], (a[1] + b[1]) / 2.0 - centre[1]];

        if middle[0] * normal[0] + middle[1] * normal[1] < 0.0 {
            normal = [-normal[0], -normal[1]];
        }

        let mut distance = gap_a;

        while distance < length - gap_b {
            let base = [a[0] + along[0] * distance, a[1] + along[1] * distance];
            let profile: Vec<f64> = offsets
                .iter()
                .map(|offset| shot.sample(base[0] + normal[0] * offset, base[1] + normal[1] * offset))
                .collect();
            // Rise in stoneness moving inwards, at offsets[1..64].
            let gradient: Vec<f64> =
                (1..64).map(|k| -(profile[k + 1] - profile[k - 1]) / (2.0 * STEP)).collect();

            let peak = (1..gradient.len() - 1).rev().find(|&j| {
                gradient[j] >= gradient[j - 1]
                    && gradient[j] > gradient[j + 1]
                    && gradient[j] >= 25.0
                    && offsets[j + 1].abs() <= 5.0
            });

            if let Some(j) = peak {
                let (g0, g1, g2) = (gradient[j - 1], gradient[j], gradient[j + 1]);
                let curvature = g0 - 2.0 * g1 + g2;
                let refine = if curvature != 0.0 { 0.5 * (g0 - g2) / curvature } else { 0.0 };
                let edge = offsets[j + 1] + refine * STEP;

                let outside_clean = offsets
                    .iter()
                    .zip(&profile)
                    .filter(|(offset, _)| **offset >= edge + 2.5)
                    .all(|(_, value)| *value <= 12.0);
                let mut inside: Vec<f64> = offsets
                    .iter()
                    .zip(&profile)
                    .filter(|(offset, _)| **offset <= edge - 2.5 && **offset >= edge - 4.5)
                    .map(|(_, value)| *value)
                    .collect();

                inside.sort_by(|x, y| x.partial_cmp(y).expect("stoneness is finite"));

                if outside_clean && !inside.is_empty() && inside[inside.len() / 2] >= 60.0 {
                    points.push([base[0] + normal[0] * edge, base[1] + normal[1] * edge]);
                }
            }

            distance += 1.0;
        }
    }

    points
}

/// Fits an outline's scale and position to the edge points by least squares (Gauss-Newton with
/// central-difference derivatives), from `start`. Returns the registration and the RMS distance
/// of the points from the registered outline, in pixels.
fn register(outline: &[Point2], points: &[Point2], start: [f64; 3]) -> ([f64; 3], f64) {
    let residuals = |registration: &[f64; 3]| {
        let polygon = to_pixels(outline, registration);

        points.iter().map(|&point| signed_distance(point, &polygon)).collect::<Vec<f64>>()
    };
    let mut current = start;

    for _ in 0..50 {
        let base = residuals(&current);
        let mut normal_matrix = Matrix3::<f64>::zeros();
        let mut gradient = Vector3::<f64>::zeros();
        let mut columns = Vec::with_capacity(3);

        for k in 0..3 {
            let (mut plus, mut minus) = (current, current);

            plus[k] += 1e-3;
            minus[k] -= 1e-3;

            let (above, below) = (residuals(&plus), residuals(&minus));

            columns.push(above.iter().zip(&below).map(|(p, m)| (p - m) / 2e-3).collect::<Vec<f64>>());
        }

        for i in 0..points.len() {
            for a in 0..3 {
                gradient[a] += columns[a][i] * base[i];

                for b in 0..3 {
                    normal_matrix[(a, b)] += columns[a][i] * columns[b][i];
                }
            }
        }

        let delta = normal_matrix
            .lu()
            .solve(&-gradient)
            .expect("the registration must be well conditioned");

        for k in 0..3 {
            current[k] += delta[k];
        }

        if delta.norm() < 1e-9 {
            break;
        }
    }

    let final_residuals = residuals(&current);
    let rms = (final_residuals.iter().map(|r| r * r).sum::<f64>() / final_residuals.len() as f64).sqrt();

    (current, rms)
}

/// Everything the tests share: the model, the edge points and the default camera's fit.
struct Measurement {
    mesh: Mesh,
    points: Vec<Point2>,
    default_registration: [f64; 3],
    default_rms: f64,
    /// Signed distances of the points from the default camera's fitted outline, in pixels.
    default_residuals: Vec<f64>,
}

/// Measures the screenshot once for all the tests.
///
/// The first guess at the outline is the default camera's, scaled and placed to fill the stone's
/// bounding box. Points are found along it, the outline is fitted to them, and the points are found
/// again along the fitted outline, as in T-0041. Every camera is then scored on those same points.
fn measurement() -> &'static Measurement {
    static MEASUREMENT: OnceLock<Measurement> = OnceLock::new();

    MEASUREMENT.get_or_init(|| {
        let shot = Screenshot::load();
        let mesh = oval_cut();
        let default_outline = outline(&mesh, &camera_at_the_screenshot_pose(GEM_CUT_STUDIO_EYE_DISTANCE));

        let [left, top, right, bottom] = shot.stone_bounds();
        let (min_x, max_x) = default_outline
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(p[0]), hi.max(p[0])));
        let (min_y, max_y) = default_outline
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(p[1]), hi.max(p[1])));
        let scale = (right - left) / (max_x - min_x);
        let start = [
            scale,
            (left + right) / 2.0 - scale * (min_x + max_x) / 2.0,
            (top + bottom) / 2.0 + scale * (min_y + max_y) / 2.0,
        ];

        let first_points = edge_points(&shot, &to_pixels(&default_outline, &start));
        let (first_fit, _) = register(&default_outline, &first_points, start);
        let points = edge_points(&shot, &to_pixels(&default_outline, &first_fit));
        let (default_registration, default_rms) = register(&default_outline, &points, first_fit);

        let polygon = to_pixels(&default_outline, &default_registration);
        let default_residuals = points.iter().map(|&p| signed_distance(p, &polygon)).collect();

        Measurement { mesh, points, default_registration, default_rms, default_residuals }
    })
}

/// RMS distance, in pixels, of the edge points from a camera's fitted outline.
fn outline_rms(eye_distance: f32) -> f64 {
    let m = measurement();
    let camera_outline = outline(&m.mesh, &camera_at_the_screenshot_pose(eye_distance));

    register(&camera_outline, &m.points, m.default_registration).1
}

/// The screenshot must still be the oval cut on GCS's grey, cleanly measurable, and shaped like the
/// model at all. A replaced screenshot, a changed model or a broken edge search should fail here,
/// rather than as a puzzling camera result in the other tests.
///
/// Setup: the shared measurement. Test: count the edge points, and find the largest distance of any
/// of them from the default camera's fitted outline. Verifies there are enough points to measure
/// the whole outline, and that none is further off than GCS's aliasing explains. Measured
/// 2026-09-15: 1,566 points, the worst 1.74 px off, at a scale of 501.4 px per view half-height.
/// The same view in GCS's Random lighting gave 1,630 points and 1.52 px, so the lighting barely
/// matters.
#[test]
fn screenshot_outline_is_measured_cleanly() {
    if !screenshot_is_available() {
        return;
    }

    let m = measurement();
    let worst = m.default_residuals.iter().fold(0.0f64, |worst, r| worst.max(r.abs()));

    eprintln!(
        "edge points {}, registration {:?}, worst residual {:.3} px",
        m.points.len(),
        m.default_registration,
        worst
    );

    assert!(m.points.len() >= 1500, "only {} edge points were found", m.points.len());
    assert!(worst < 2.5, "an edge point is {:.2} px from the fitted outline", worst);
}

/// The default camera must reproduce Gem Cut Studio's outline, and clearly better than the
/// orthographic camera this renderer used until T-0044.
///
/// Setup: the shared edge points. Test: fit the default camera's outline (the eye
/// `GEM_CUT_STUDIO_EYE_DISTANCE` away) and the orthographic camera's, each in scale and position
/// only. Verifies the default fits to about GCS's aliasing, and that orthographic is worse by a
/// clear margin. The pose, model and projection are otherwise identical, so the difference is the
/// perspective alone. Measured 2026-09-15: 0.529 px RMS for the default, 0.681 px orthographic
/// (0.522 and 0.674 on the Random screenshot of the same view).
/// T-0041's synthetic silhouettes, aliased like GCS's, fitted to 0.517 px at the right distance.
#[test]
fn default_camera_fits_gem_cut_studios_outline_and_orthographic_does_not() {
    if !screenshot_is_available() {
        return;
    }

    let default = measurement().default_rms;
    let orthographic = outline_rms(0.0);

    eprintln!("outline RMS: default {:.4} px, orthographic {:.4} px", default, orthographic);

    assert!(default < 0.55, "the default camera fits GCS's outline to only {:.3} px RMS", default);
    assert!(
        orthographic > default + 0.1,
        "orthographic ({:.3} px) must fit clearly worse than the default ({:.3} px)",
        orthographic,
        default
    );
}

/// Gem Cut Studio's measured eye distance must fit the outline as well as any nearer or farther eye.
///
/// Setup: the shared edge points. Test: fit outlines with the eye at a quarter, a half and three
/// quarters of `GEM_CUT_STUDIO_EYE_DISTANCE`, at it, and at 1.5, 2 and 4 times it, plus orthographic.
/// Verifies the default is within 0.01 px RMS of the best of them, and that the extremes, a quarter
/// of the distance and orthographic, are clearly worse. The fit is shallow near its best, and GCS's
/// aliasing biases it slightly towards farther eyes (T-0041 calibrated that), so this checks the
/// constant is consistent with the screenshot rather than pinning an exact optimum. Measured
/// 2026-09-15, px RMS by eye distance: 13, 1.636; 26, 0.761; 39, 0.570; 52, 0.529 (the best);
/// 78, 0.537; 104, 0.559; 208, 0.611; orthographic, 0.681.
#[test]
fn gem_cut_studio_eye_distance_fits_as_well_as_nearer_and_farther_eyes() {
    if !screenshot_is_available() {
        return;
    }

    let default = measurement().default_rms;
    let scan: Vec<(f32, f64)> = [0.25f32, 0.5, 0.75, 1.0, 1.5, 2.0, 4.0]
        .iter()
        .map(|factor| factor * GEM_CUT_STUDIO_EYE_DISTANCE)
        .chain([0.0])
        .map(|eye| (eye, outline_rms(eye)))
        .collect();
    let best = scan.iter().fold(f64::INFINITY, |best, (_, rms)| best.min(*rms));

    eprintln!("outline RMS by eye distance (0 is orthographic): {:?}", scan);

    assert!(
        default <= best + 0.01,
        "the default eye fits to {:.4} px, but the best of {:?} is {:.4}",
        default,
        scan,
        best
    );
    assert!(scan[0].1 > best + 0.1, "an eye at a quarter of the distance must fit clearly worse");
    assert!(scan[scan.len() - 1].1 > best + 0.1, "orthographic must fit clearly worse");
}

/// The projected outline the other tests fit must be the outline the renderer's rays actually see.
///
/// Setup: the oval cut and the default camera at the screenshot's pose on a square viewport, and its
/// acceleration structure, whose traversal and triangle test mirror the shader's. Rays are traced as
/// the shader traces primary rays: from `ray_start`, as rays from outside. Test: for every
/// vertex, cast the ray through its projected position; for every outline edge, cast rays through
/// points 0.002 (about 1 px) inside and outside its midpoint. Verifies every vertex ray passes within
/// 1e-4 of its vertex, so `project` is the rays' own projection; and every inside ray hits the stone
/// while every outside ray misses it, so the convex hull is the silhouette the renderer draws.
#[test]
fn projected_outline_is_what_the_traced_rays_see() {
    let mesh = oval_cut();
    let camera = camera_at_the_screenshot_pose(GEM_CUT_STUDIO_EYE_DISTANCE);
    let basis = camera.basis(1.0);
    let accel = Accel::build(&mesh).expect("the oval cut must build a BVH");

    for vertex in &mesh.positions {
        let [x, y] = project(&basis, vertex);
        let (origin, direction) = (basis.ray_origin(x as f32, y as f32), basis.ray_direction(x as f32, y as f32));
        let miss = (vertex - origin).cross(&direction).norm();

        assert!(miss < 1e-4, "the ray through vertex {:?}'s projection misses it by {}", vertex, miss);
    }

    let hull = outline(&mesh, &camera);
    let count = hull.len();

    assert!(count >= 8, "the outline has only {} corners", count);

    for i in 0..count {
        let (a, b) = (hull[i], hull[(i + 1) % count]);
        let length = (b[0] - a[0]).hypot(b[1] - a[1]);
        // Counter-clockwise, so the outward normal is the edge turned clockwise.
        let outward = [(b[1] - a[1]) / length, -(b[0] - a[0]) / length];
        let middle = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];

        for (side, expect_hit) in [(-0.002, true), (0.002, false)] {
            let x = (middle[0] + outward[0] * side) as f32;
            let y = (middle[1] + outward[1] * side) as f32;
            let hit = accel.trace(basis.ray_start(x, y), basis.ray_direction(x, y), 1e-4, 1e6, RaySide::Outside);

            assert_eq!(
                hit.is_some(),
                expect_hit,
                "the ray {} outline edge {} should {}",
                if expect_hit { "just inside" } else { "just outside" },
                i,
                if expect_hit { "hit the stone" } else { "miss it" }
            );
        }
    }
}
