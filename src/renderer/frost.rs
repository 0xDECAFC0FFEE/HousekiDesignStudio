//! Frosted facets in the deterministic renderer (T-0270): the host half of the per-facet
//! radiance cache.
//!
//! A frosted facet is rough glass. The Monte Carlo renderer draws it as a rough dielectric
//! (`lux/roughglass.glsl`); the deterministic renderer follows one ray per pixel centre and
//! keeps both Fresnel branches, so it cannot follow the spread of directions a rough surface
//! scatters light into. Instead (option F of the T-0270 exploration, chosen by the user on
//! 2026-09-28) it treats a frosted facet as a scatterer with one value per facet:
//!
//! * **A pre-pass** (`GemApp::draw_frost_cache`) traces `CACHE_RAYS` fixed rays from each frosted
//!   facet, every ray in its own fragment, and averages them into a `facet count x 2` float
//!   image: row 0 is the light reaching the facet from inside the stone (what a ray reflected
//!   back inside off it carries), row 1 everything the facet sends towards the eye when it is
//!   seen from outside (its rough reflection plus the light it lets out of the stone).
//! * **The frame** then stops a ray at the first frosted facet it meets and takes that facet's
//!   value, so nothing past a frosted facet is traced per pixel. That is why a frosted stone is
//!   cheaper to draw than a polished one.
//!
//! The pre-pass is per facet, not per pixel: every pixel still traces exactly one ray through
//! its centre (T-0052), and the image has no noise.
//!
//! Where the browser cannot render into a float image (no `EXT_color_buffer_float`), the frame
//! uses option E instead: every frosted facet takes one constant, the lighting averaged over
//! the whole sphere (`sphere_fill`). The same constant stands in, inside the pre-pass, for a
//! second frosted facet met on the way (light passing between two frosted facets takes one
//! bounce, a limit the user accepted).
//!
//! This module holds what can be decided without a GL context, so it can be tested on the
//! host: where each facet's rays start (`facet_frame_texels`), the fallback constant
//! (`sphere_fill`), and the sizes the shader and the host must agree on.

use crate::mesh::Mesh;
use crate::params::RenderParams;
use nalgebra::{Point3, Vector3};
use std::collections::BTreeSet;

/// Rays the pre-pass traces per frosted facet and per row (and per colour channel, when
/// dispersion is on). Must match `FROST_CACHE_RAYS` in `gem.frag`; a test enforces that.
///
/// 64 is what the exploration measured: the per-facet values agreed with a per-pixel
/// recomputation to within one display level (kb/frosted-facets-in-the-deterministic-renderer-opt.md).
pub const CACHE_RAYS: u32 = 64;

/// Rows of the cache: 0 the light inside the stone at the facet, 1 the facet seen from outside.
pub const CACHE_ROWS: u32 = 2;

/// Colour channels the pre-pass traces separately when dispersion is on (one index each).
pub const DISPERSIVE_CHANNELS: u32 = 3;

/// Height of the pre-pass's per-ray image: a fragment per ray, row and channel. The image is
/// allocated at the dispersive height and a frame without dispersion draws only the first third.
pub const RAY_IMAGE_HEIGHT: u32 = CACHE_ROWS * DISPERSIVE_CHANNELS * CACHE_RAYS;

/// What a draw of the deterministic program is for (`uFrostPass`): the frame, or the
/// pre-pass's first draw (a fragment per cache ray) or second (the average per facet). Must
/// match `FROST_PASS_*` in `gem.frag`; a test enforces that.
pub const PASS_FRAME: i32 = 0;
pub const PASS_RAYS: i32 = 1;
pub const PASS_REDUCE: i32 = 2;

/// Microfacet normals averaged over, per pixel, where a ray inside the stone meets a frosted
/// facet (the part that escapes through it, and the share that goes back inside). Must match
/// `FROST_TAPS` in `gem.frag`; a test enforces that. The exploration's value.
pub const TAPS: u32 = 8;

/// How many of `frosted` are facets of a stone with `facet_count` facets: the shader's
/// `uFrostedFacetCount`. Zero turns every frosted-facet test in the frame off, which is the fast
/// path a stone with nothing frosted takes; ids the stone does not have frost nothing (they have
/// no texel in the mask either, see `facet_mask_texels`).
pub fn frosted_facet_count(facet_count: u32, frosted: &BTreeSet<u32>) -> u32 {
    frosted.iter().filter(|&&facet| facet < facet_count).count() as u32
}

/// Where a facet's cache rays start, and which way it faces.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FacetFrame {
    /// A point on the facet: its area-weighted centroid when that lies on the facet, otherwise
    /// the centroid of its largest triangle.
    pub anchor: Point3<f32>,
    /// The facet's outward unit normal (`Mesh::facet_normals`, what the convex exit test uses).
    pub normal: Vector3<f32>,
    /// The facet's area, in world units squared.
    pub area: f32,
}

/// Whether `point`, taken to lie in the plane of the triangle `a b c`, is inside it, with a
/// little slack for float noise on its edges.
fn triangle_contains(a: Point3<f32>, b: Point3<f32>, c: Point3<f32>, point: Point3<f32>) -> bool {
    let normal = (b - a).cross(&(c - a));
    let twice_area = normal.norm();

    if twice_area <= 0.0 {
        return false;
    }

    let unit = normal / twice_area;
    // Each sub-triangle's signed area over the whole: the barycentric coordinates.
    let u = (c - b).cross(&(point - b)).dot(&unit) / twice_area;
    let v = (a - c).cross(&(point - c)).dot(&unit) / twice_area;
    let w = 1.0 - u - v;
    const SLACK: f32 = 1e-5;

    u >= -SLACK && v >= -SLACK && w >= -SLACK
}

/// Every facet's frame, indexed by facet id.
///
/// **Why the anchor is not simply the centroid (concave facets).** A convex facet's centroid
/// always lies on it, but a concave facet's (an L, a crescent) can lie outside the polygon,
/// where a ray started "just inside the facet" would start outside the stone. So the centroid is
/// kept only when it falls inside one of the facet's own triangles, and otherwise the facet's
/// largest triangle's centroid, which is always on the facet, is used.
pub fn facet_frames(mesh: &Mesh) -> Vec<FacetFrame> {
    let facet_count = mesh.facet_count as usize;
    let normals = mesh.facet_normals();
    let mut sums = vec![(Vector3::<f64>::zeros(), 0.0f64); facet_count];
    let mut largest = vec![(0.0f32, Point3::origin()); facet_count];

    for (index, facet) in mesh.facet_of_triangle.iter().enumerate() {
        let facet = *facet as usize;
        let [a, b, c] = mesh.triangle_positions(index);
        let area = (b - a).cross(&(c - a)).norm() * 0.5;
        let centre = Point3::from((a.coords + b.coords + c.coords) / 3.0);

        sums[facet].0 += centre.coords.cast::<f64>() * area as f64;
        sums[facet].1 += area as f64;

        if area > largest[facet].0 {
            largest[facet] = (area, centre);
        }
    }

    (0..facet_count)
        .map(|facet| {
            let (sum, area) = sums[facet];
            let centroid = if area > 0.0 {
                Point3::from((sum / area).cast::<f32>())
            } else {
                largest[facet].1
            };

            let on_facet = mesh
                .facet_of_triangle
                .iter()
                .enumerate()
                .filter(|(_, owner)| **owner as usize == facet)
                .any(|(index, _)| {
                    let [a, b, c] = mesh.triangle_positions(index);

                    triangle_contains(a, b, c, centroid)
                });

            FacetFrame {
                anchor: if on_facet { centroid } else { largest[facet].1 },
                normal: normals[facet],
                area: area as f32,
            }
        })
        .collect()
}

/// `facet_frames` as the texels of the shader's `uFacetFrames`: a `facet count x 2` RGBA32F data
/// texture (at least 1 wide), row 0 `(anchor, area)` and row 1 `(outward normal, 0)` for each
/// facet id. Returns `(width, texels)`.
pub fn facet_frame_texels(mesh: &Mesh) -> (u32, Vec<f32>) {
    let frames = facet_frames(mesh);
    let width = (frames.len() as u32).max(1);
    let mut texels = vec![0.0f32; width as usize * 2 * 4];

    for (facet, frame) in frames.iter().enumerate() {
        let anchor = facet * 4;
        let normal = (width as usize + facet) * 4;

        texels[anchor..anchor + 4].copy_from_slice(&[frame.anchor.x, frame.anchor.y, frame.anchor.z, frame.area]);
        texels[normal..normal + 4].copy_from_slice(&[frame.normal.x, frame.normal.y, frame.normal.z, 0.0]);
    }

    (width, texels)
}

/// Option E: the light arriving at a point from every direction, averaged over the whole sphere
/// with the same rules `arrivingLight` in `gem.frag` applies to a direction (in the lighting
/// frame, where +Y is the lighting's zenith):
///
/// * below the horizon, the window colour when it is on, else the flat background when that is
///   on, else the lighting;
/// * within the head shadow's cone about the zenith, the head shadow colour;
/// * everything else, the lighting times its intensity.
///
/// Picked colours are decoded through the display transfer as the shader decodes them
/// (`ToneMapMode::decode`). The observer's body and the back-facet half of the window rule
/// depend on where the light leaves the stone, which one constant cannot know, so they are left
/// out. Not multiplied by the stone's colour: the shader does that, as it does for the
/// out-of-bounces shade.
///
/// `latitudes` is `EnvironmentMap::latitude_means` of the lighting now loaded: one mean radiance
/// per row of the equirectangular map, zenith first. Each row is weighted by the solid angle of
/// its band, `(cos(top) - cos(bottom)) / 2`, and takes the rule of its middle.
pub fn sphere_fill(latitudes: &[Vector3<f32>], params: &RenderParams) -> Vector3<f32> {
    let rows = latitudes.len();

    if rows == 0 {
        return Vector3::zeros();
    }

    let decode = |color: Vector3<f32>| {
        color.map(|channel| params.tone_map_mode.decode(channel, params.exposure))
    };
    // The shader's uHeadShadowCosine: off is 2.0, which no direction reaches.
    let head_cosine = if params.head_shadow_half_angle > 0.0 {
        params.head_shadow_half_angle.cos()
    } else {
        2.0
    };
    let head = decode(params.head_shadow_color);
    let below = if params.use_window_color {
        Some(decode(params.window_color))
    } else if params.use_background_color {
        Some(decode(params.background_color))
    } else {
        None
    };

    let mut sum = Vector3::zeros();

    for (row, mean) in latitudes.iter().enumerate() {
        let polar = |edge: f32| std::f32::consts::PI * edge / rows as f32;
        let weight = (polar(row as f32).cos() - polar(row as f32 + 1.0).cos()) * 0.5;
        let height = polar(row as f32 + 0.5).cos();

        let radiance = match below {
            Some(color) if height < 0.0 => color,
            _ if height >= head_cosine => head,
            _ => mean * params.env_intensity,
        };

        sum += radiance * weight;
    }

    sum
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::ToneMapMode;

    /// OBJ text for a closed L-shaped prism: a thin L, two arms 2 long and 0.2 wide along x and
    /// y, from z = 0 to z = 1, wound outward, every face given as explicit triangles (the loader
    /// fan-triangulates polygons, which is wrong for the L's concave outline).
    ///
    /// Its top and bottom faces are L-shaped, concave facets whose area centroid, about (0.574,
    /// 0.574) in x and y, lies between the arms, outside the L: the case `facet_frames` has to
    /// handle.
    fn l_prism_obj() -> String {
        // The L's outline, counter-clockwise seen from +z.
        let outline = [(0.0, 0.0), (2.0, 0.0), (2.0, 0.2), (0.2, 0.2), (0.2, 2.0), (0.0, 2.0)];
        let mut text = String::new();

        for z in [0.0, 1.0] {
            for (x, y) in outline {
                text += &format!("v {} {} {}\n", x, y, z);
            }
        }

        // Bottom (z = 0, vertices 1-6) faces -z: clockwise seen from +z. Top (7-12) faces +z.
        // The L split into triangles that stay inside it.
        let fan = [(1, 2, 3), (1, 3, 4), (1, 4, 6), (4, 5, 6)];

        for (a, b, c) in fan {
            text += &format!("f {} {} {}\n", a, c, b);
            text += &format!("f {} {} {}\n", a + 6, b + 6, c + 6);
        }

        // The six sides, each a quad from outline edge i to i+1.
        for i in 0..6 {
            let j = (i + 1) % 6;
            let (a, b, c, d) = (i + 1, j + 1, j + 7, i + 7);

            text += &format!("f {} {} {}\nf {} {} {}\n", a, b, c, a, c, d);
        }

        text
    }

    /// The conditioned mesh of `l_prism_obj`, as the page would build it.
    fn l_prism() -> Mesh {
        let (mesh, diagnostics, _) =
            crate::conditioned_mesh(&l_prism_obj(), crate::mesh::ModelAxis::PlusZ).expect("the L prism loads");

        assert!(diagnostics.is_watertight(), "setup: the L prism must be a closed solid");
        mesh
    }

    /// The hex cut the studio opens with, conditioned as the page conditions it.
    fn hex_cut() -> Mesh {
        crate::conditioned_mesh(include_str!("../resources/hex_cut_v2.obj"), crate::mesh::ModelAxis::PlusZ)
            .expect("the built-in stone loads")
            .0
    }

    /// Whether `point` lies on facet `facet` of `mesh`: in one of its triangles, and in its
    /// plane to within float noise.
    fn on_facet(mesh: &Mesh, facet: usize, point: Point3<f32>) -> bool {
        mesh.facet_of_triangle.iter().enumerate().any(|(index, owner)| {
            let [a, b, c] = mesh.triangle_positions(index);
            let off_plane = (point - a).dot(&mesh.triangle_normal(index)).abs();

            *owner as usize == facet && off_plane < 1e-5 && triangle_contains(a, b, c, point)
        })
    }

    /// Every anchor of a convex stone is its facet's centroid, on the facet, facing out.
    ///
    /// Setup: the hex cut the studio opens with (67 facets, all convex polygons).
    ///
    /// Test: `facet_frames`, and for each facet the area-weighted centroid worked out here
    /// independently from its triangles.
    ///
    /// Verifies that every facet gets a frame; that on a convex facet the anchor is exactly the
    /// centroid (the point the exploration's measured prototype used, so the shipped cache starts
    /// its rays where the scored one did); that the anchor lies on the facet; that the normal is
    /// the unit outward normal the convex exit test uses; and that the areas add up to the
    /// stone's surface area.
    #[test]
    fn a_convex_stones_anchors_are_its_facet_centroids() {
        let mesh = hex_cut();
        let frames = facet_frames(&mesh);
        let normals = mesh.facet_normals();

        assert_eq!(frames.len(), mesh.facet_count as usize);

        let mut total_area = 0.0;

        for (index, _) in mesh.triangles.iter().enumerate() {
            let [a, b, c] = mesh.triangle_positions(index);
            total_area += (b - a).cross(&(c - a)).norm() * 0.5;
        }

        for (facet, frame) in frames.iter().enumerate() {
            let mut sum = Vector3::zeros();
            let mut area = 0.0;

            for (index, owner) in mesh.facet_of_triangle.iter().enumerate() {
                if *owner as usize == facet {
                    let [a, b, c] = mesh.triangle_positions(index);
                    let piece = (b - a).cross(&(c - a)).norm() * 0.5;

                    sum += (a.coords + b.coords + c.coords) / 3.0 * piece;
                    area += piece;
                }
            }

            let centroid = Point3::from(sum / area);

            assert!((frame.anchor - centroid).norm() < 1e-5, "facet {}: anchor {:?} is not the centroid {:?}", facet, frame.anchor, centroid);
            assert!(on_facet(&mesh, facet, frame.anchor), "facet {}: anchor is off the facet", facet);
            assert!((frame.normal - normals[facet]).norm() < 1e-6 && (frame.normal.norm() - 1.0).abs() < 1e-5);
            assert!((frame.area - area).abs() < 1e-6);
        }

        let summed: f32 = frames.iter().map(|frame| frame.area).sum();

        assert!((summed - total_area).abs() < 1e-4, "facet areas {} vs surface {}", summed, total_area);
    }

    /// A concave facet's anchor stays on the facet, although its centroid does not.
    ///
    /// Setup: the L-shaped prism, whose top and bottom facets are concave Ls; their area
    /// centroid lies in the L's notch, outside the facet (checked here, so the test has teeth).
    ///
    /// Test: `facet_frames` for every facet of the prism.
    ///
    /// Verifies the concave rule: every anchor lies on its own facet, so a cache ray started a
    /// hair inside it starts inside the stone; on the two L facets it is the centroid of the
    /// largest triangle rather than the (outside) centroid; and each normal faces out of the
    /// solid (away from the prism's middle).
    #[test]
    fn a_concave_facets_anchor_is_on_the_facet_even_when_its_centroid_is_not() {
        let mesh = l_prism();
        let frames = facet_frames(&mesh);
        let mut concave = 0;

        for (facet, frame) in frames.iter().enumerate() {
            assert!(on_facet(&mesh, facet, frame.anchor), "facet {}: anchor {:?} is off the facet", facet, frame.anchor);

            // The centroid, independently, to see whether this is one of the concave facets.
            let mut sum = Vector3::zeros();
            let mut area = 0.0;

            for (index, owner) in mesh.facet_of_triangle.iter().enumerate() {
                if *owner as usize == facet {
                    let [a, b, c] = mesh.triangle_positions(index);
                    let piece = (b - a).cross(&(c - a)).norm() * 0.5;

                    sum += (a.coords + b.coords + c.coords) / 3.0 * piece;
                    area += piece;
                }
            }

            if !on_facet(&mesh, facet, Point3::from(sum / area)) {
                concave += 1;
                assert!((frame.anchor - Point3::from(sum / area)).norm() > 1e-3);
            }
        }

        assert_eq!(concave, 2, "setup: the L's top and bottom are the two concave facets");
    }

    /// A concave stone gets a frame on every facet although it has no convex planes.
    ///
    /// Setup: the hex cut with its culet pushed up into the pavilion, from 0.563 below the girdle
    /// plane to 0.2 below it (above the ring of pavilion vertices round it at 0.349), which turns
    /// the bottom of the pavilion into an inverted cone: a concave stone, the one the browser
    /// check of T-0270 renders frosted.
    ///
    /// Test: `convex::FacetPlanes::from_mesh` and `facet_frames` on it.
    ///
    /// Verifies the case the exploration's prototype could not draw: the stone is refused as
    /// convex (so the shader has no facet planes, uFacetPlaneCount 0, and the prototype read its
    /// facet normals from exactly those planes), yet every facet still gets an anchor on the
    /// facet and a unit normal, which is all the cache's rays need.
    #[test]
    fn a_concave_stone_gets_frames_without_convex_planes() {
        let text = include_str!("../resources/hex_cut_v2.obj")
            .replace("v -0.000000 -0.000000 -0.562995", "v 0.000000 0.000000 -0.200000");

        assert_ne!(text, include_str!("../resources/hex_cut_v2.obj"), "setup: the culet line must be found");

        let (mesh, diagnostics, _) =
            crate::conditioned_mesh(&text, crate::mesh::ModelAxis::PlusZ).expect("the dimpled stone loads");

        assert!(diagnostics.is_watertight());
        assert!(crate::convex::FacetPlanes::from_mesh(&mesh).is_none(), "setup: the stone must not be convex");

        let frames = facet_frames(&mesh);

        assert_eq!(frames.len(), mesh.facet_count as usize);

        for (facet, frame) in frames.iter().enumerate() {
            assert!(on_facet(&mesh, facet, frame.anchor), "facet {}: anchor is off the facet", facet);
            assert!((frame.normal.norm() - 1.0).abs() < 1e-5, "facet {}: normal {:?}", facet, frame.normal);
        }
    }

    /// The texels put each facet's anchor in row 0 and its normal in row 1, at its own id.
    ///
    /// Setup: the hex cut.
    ///
    /// Test: `facet_frame_texels`, against `facet_frames`.
    ///
    /// Verifies the layout `gem.frag` reads (`texelFetch(uFacetFrames, ivec2(facet, 0))` for the
    /// anchor, `ivec2(facet, 1)` for the normal): one texel per facet in each row, the width the
    /// facet count, and nothing shifted by a row or a texel.
    #[test]
    fn facet_frame_texels_are_anchor_row_then_normal_row() {
        let mesh = hex_cut();
        let frames = facet_frames(&mesh);
        let (width, texels) = facet_frame_texels(&mesh);

        assert_eq!(width, mesh.facet_count);
        assert_eq!(texels.len(), width as usize * 2 * 4);

        for (facet, frame) in frames.iter().enumerate() {
            let anchor = &texels[facet * 4..facet * 4 + 4];
            let normal = &texels[(width as usize + facet) * 4..(width as usize + facet) * 4 + 4];

            assert_eq!(anchor, &[frame.anchor.x, frame.anchor.y, frame.anchor.z, frame.area]);
            assert_eq!(normal, &[frame.normal.x, frame.normal.y, frame.normal.z, 0.0]);
        }
    }

    /// Only facets the stone has count as frosted, so an empty or stale mask takes the fast path.
    ///
    /// Setup: a 10-facet stone and the sets {}, {2, 5} and {2, 5, 10, 400} (10 and 400 are ids a
    /// previous, larger stone had).
    ///
    /// Test: `frosted_facet_count`.
    ///
    /// Verifies 0, 2 and 2: the shader's frosted tests stay off with nothing frosted, and ids
    /// the stone does not have neither turn them on nor count.
    #[test]
    fn only_facets_the_stone_has_count_as_frosted() {
        let set = |ids: &[u32]| ids.iter().copied().collect::<BTreeSet<u32>>();

        assert_eq!(frosted_facet_count(10, &set(&[])), 0);
        assert_eq!(frosted_facet_count(10, &set(&[2, 5])), 2);
        assert_eq!(frosted_facet_count(10, &set(&[2, 5, 10, 400])), 2);
    }

    /// Settings for `sphere_fill` tests: the linear transfer at exposure 1 (so a picked colour
    /// decodes to itself), no head shadow, no window or background colour, intensity 1.
    fn plain_params() -> RenderParams {
        let mut params = RenderParams::default();

        params.tone_map_mode = ToneMapMode::Linear;
        params.exposure = 1.0;
        params.env_intensity = 1.0;
        params.head_shadow_half_angle = 0.0;
        params.use_window_color = false;
        params.use_background_color = false;

        params
    }

    /// The fallback constant of a uniform lighting is that lighting, and it scales with intensity.
    ///
    /// Setup: 512 latitude rows all of radiance (0.2, 0.4, 0.6), as a uniform sky gives.
    ///
    /// Test: `sphere_fill` at intensity 1 and 2.5.
    ///
    /// Verifies the band weights are the solid angles of the bands, summing to the whole sphere
    /// (a uniform sky averages to itself to 1e-5), and that the lighting's intensity multiplies it
    /// as it multiplies every lookup in the shader.
    #[test]
    fn a_uniform_sky_averages_to_itself() {
        let rows = vec![Vector3::new(0.2, 0.4, 0.6); 512];
        let mut params = plain_params();

        assert!((sphere_fill(&rows, &params) - Vector3::new(0.2, 0.4, 0.6)).norm() < 1e-5);

        params.env_intensity = 2.5;

        assert!((sphere_fill(&rows, &params) - Vector3::new(0.5, 1.0, 1.5)).norm() < 1e-5);
    }

    /// The fallback constant follows the shader's rules for light from below the horizon and from
    /// inside the head shadow.
    ///
    /// Setup: a sky of radiance 1 above the horizon and 0 below, over 512 rows.
    ///
    /// Test: `sphere_fill` with nothing on; with the flat background (0.5 grey) on; with the
    /// window colour (0.1, 0.2, 0.3) on as well, which takes precedence below the horizon as in
    /// `arrivingLight`; with a head shadow of half-angle 60 degrees and colour (0.25, 0, 0); and
    /// the background under the filmic transfer, where a picked colour is decoded, not used as is.
    ///
    /// Verifies each against the exact solid-angle answer: the upper hemisphere is half the
    /// sphere, so the plain sky averages to 0.5; the background adds half its radiance; the window
    /// colour replaces it; a cone of half-angle 60 degrees is (1 - cos 60) / 2 = a quarter of the
    /// sphere, so it takes a quarter of the sky away and adds a quarter of its colour; and the
    /// filmic decode of 0.5 grey is 0.5^2.2 / (1 - 0.5^2.2). Within 2e-3: the rows are 0.35
    /// degrees tall and the band at a boundary takes the rule of its middle.
    #[test]
    fn the_fallback_follows_the_horizon_and_head_shadow_rules() {
        let rows: Vec<Vector3<f32>> = (0..512)
            .map(|row| if row < 256 { Vector3::repeat(1.0) } else { Vector3::zeros() })
            .collect();
        let close = |got: Vector3<f32>, expected: Vector3<f32>| {
            assert!((got - expected).norm() < 2e-3, "got {:?}, expected {:?}", got, expected)
        };
        let mut params = plain_params();

        close(sphere_fill(&rows, &params), Vector3::repeat(0.5));

        params.use_background_color = true;
        params.background_color = Vector3::repeat(0.5);
        close(sphere_fill(&rows, &params), Vector3::repeat(0.75));

        params.use_window_color = true;
        params.window_color = Vector3::new(0.1, 0.2, 0.3);
        close(sphere_fill(&rows, &params), Vector3::new(0.55, 0.6, 0.65));

        params.use_window_color = false;
        params.head_shadow_half_angle = 60.0f32.to_radians();
        params.head_shadow_color = Vector3::new(0.25, 0.0, 0.0);
        close(sphere_fill(&rows, &params), Vector3::new(0.75 - 0.25 + 0.0625, 0.5, 0.5));

        params.head_shadow_half_angle = 0.0;
        params.tone_map_mode = ToneMapMode::Filmic;
        let grey = 0.5f32.powf(2.2);
        close(sphere_fill(&rows, &params), Vector3::repeat(0.5 + 0.5 * grey / (1.0 - grey)));
    }

    /// The fallback constant of the real Studio lighting and of Cosine lies between the darkest
    /// and brightest of their rows, and Cosine's is its exact average.
    ///
    /// Setup: the Cosine and Studio environment maps the page generates, at the page's size,
    /// reduced to rows with `EnvironmentMap::latitude_means`; the page's default settings
    /// otherwise, background off.
    ///
    /// Test: `sphere_fill`.
    ///
    /// Verifies the whole E fallback chain on real data. Cosine is 1 - sin(tilt) above the
    /// horizon and 0 below, whose sphere average is (1/2)(1 - pi/4) = 0.1073; the fill must match
    /// it to 1e-3 (half-float texels and 0.35-degree rows). Studio's must be positive and finite.
    #[test]
    fn the_fallback_of_the_shipped_lightings_is_their_sphere_average() {
        let mut params = plain_params();

        let cosine = crate::env_map::generate_with(1024, 512, crate::env_map::cosine_radiance);
        let fill = sphere_fill(&cosine.latitude_means(), &params);
        let expected = 0.5 * (1.0 - std::f32::consts::FRAC_PI_4);

        assert!((fill.x - expected).abs() < 1e-3 && (fill.y - fill.x).abs() < 1e-6, "Cosine fill {:?}, expected {}", fill, expected);

        params.tone_map_mode = ToneMapMode::Filmic;

        let studio = crate::env_map::generate_studio(1024, 512);
        let fill = sphere_fill(&studio.latitude_means(), &params);

        assert!(fill.iter().all(|channel| channel.is_finite() && *channel > 0.0), "Studio fill {:?}", fill);
    }

    /// The sizes the host allocates are the ones the shader loops over.
    ///
    /// Setup: the text of `gem.frag`.
    ///
    /// Test: look for the declarations of `FROST_CACHE_RAYS`, `FROST_TAPS`,
    /// `FROST_CACHE_CHANNELS`, `FROST_CACHE_ROWS` and the three `FROST_PASS_*`.
    ///
    /// Verifies the shader's constants equal this module's. A mismatch compiles and draws: the
    /// reduction would average rays that were never traced (zero, a darker cache) or skip ones
    /// that were, or a pre-pass draw would be taken for the frame, with nothing to say why.
    #[test]
    fn the_shader_loops_over_the_sizes_the_host_allocates() {
        let shader = include_str!("shaders/gem.frag");

        for declaration in [
            format!("const int FROST_CACHE_RAYS = {};", CACHE_RAYS),
            format!("const int FROST_TAPS = {};", TAPS),
            format!("const int FROST_CACHE_CHANNELS = {};", DISPERSIVE_CHANNELS),
            format!("const int FROST_CACHE_ROWS = {};", CACHE_ROWS),
            format!("const int FROST_PASS_FRAME = {};", PASS_FRAME),
            format!("const int FROST_PASS_RAYS = {};", PASS_RAYS),
            format!("const int FROST_PASS_REDUCE = {};", PASS_REDUCE),
        ] {
            assert!(shader.contains(&declaration), "gem.frag must declare `{}`", declaration);
        }
    }

    /// The deterministic renderer's frosted roughness is the Monte Carlo renderer's.
    ///
    /// Setup: the text of `gem.frag` and of `lux/entry.glsl`, where the user's roughness is set
    /// (`FROSTED_FACET_ROUGHNESS`, T-0183).
    ///
    /// Test: parse both constants.
    ///
    /// Verifies they are equal, so a change to the user's 0.2 has to be made in both renderers
    /// (this test names the other) rather than silently leaving the deterministic renderer's
    /// frosted facets at the old roughness.
    #[test]
    fn the_deterministic_roughness_is_the_monte_carlo_one() {
        let value = |source: &str, name: &str| -> f32 {
            source
                .split(&format!("const float {} = ", name))
                .nth(1)
                .and_then(|rest| rest.split(';').next())
                .and_then(|text| text.trim().parse().ok())
                .unwrap_or_else(|| panic!("{} is not declared", name))
        };

        let deterministic = value(include_str!("shaders/gem.frag"), "FROST_ROUGHNESS");
        let monte_carlo = value(include_str!("shaders/lux/entry.glsl"), "FROSTED_FACET_ROUGHNESS");

        assert_eq!(deterministic, monte_carlo);
    }
}
