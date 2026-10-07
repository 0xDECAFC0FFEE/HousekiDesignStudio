// One frame in, the board's markers and chessboard corners out: the per-frame work of
// board_detect.js (src/web/src/lib/vision), which ported HousekiScanner's desktop detector
// (board.py, detect.py, calibrate.py), now done in one call into the wasm module.
//
//   1. optional downscale (processingScale, INTER_AREA);
//   2. ArUco markers, then the board-guided recovery of missed ones (tryRefineMarkers);
//   3. markers the sheet does not print (removed ids) dropped;
//   4. the ChArUco corners next to one or two found markers, refined (charuco.rs; the desktop's
//      two passes, minMarkers 2 then 1, in one);
//   5. each corner's sharpness, and corners below MIN_CORNER_SHARPNESS re-refined in a window of
//      1/8 of the local square (detect.py refine_blurred, without its half-pixel shift unless
//      asked for).
//
// The marker-size factor m and its fallbacks stay in JavaScript (board_detect.js), which passes
// the parameters m gives for each frame (configure).
//
// Copyright 2026 Lucas Tong. Licensed under the Apache License, Version 2.0 (see LICENSE).

use crate::aruco::{ArucoDetector, Marker};
use crate::charuco::{interpolate_corners, CharucoBoard, Corner, CornerRefiner};
use crate::gray::Gray;
use crate::linalg::{fit_homography_ransac, transform_f64, Pt};
use crate::resize::resize_area;
use crate::sharpness::{corner_sharpness, js_round, py_round};
use crate::subpix::{Criteria, SubPix};

/// Laplacian variance below which a corner counts as blurred (calibrate.py MIN_CORNER_SHARPNESS).
pub const MIN_CORNER_SHARPNESS: f64 = 50.0;

/// Short side (px) the desktop's pixel constants were tuned at (camera.py).
pub const REF_SHORT_SIDE: f64 = 1080.0;

/// Per-frame options (board_detect.js's).
#[derive(Clone, Copy, Debug)]
pub struct FrameOptions {
    pub processing_scale: f64,
    pub single_marker_corners: bool,
    pub refine_blurred: bool,
    pub desktop_half_pixel_shift: bool,
    /// The blurred-corner window's largest half-size: 40 px x max(m, 1) (detect.py).
    pub max_half: i64,
    /// Detect only in this region of the work image, (x, y, width, height) in work pixels (T-0332:
    /// the phone's fast path, around where the last pose put the board near the rock). Every
    /// size-relative limit stays relative to the WHOLE work image, and the results are in its
    /// pixels. None: the whole image.
    pub roi: Option<(usize, usize, usize, usize)>,
}

impl Default for FrameOptions {
    fn default() -> Self {
        FrameOptions {
            processing_scale: 1.0, single_marker_corners: true, refine_blurred: true, desktop_half_pixel_shift: false,
            max_half: 40, roi: None,
        }
    }
}

/// A chessboard corner as returned: OpenCV pixel-centre coordinates in the work image, its
/// marker count (1 or 2), and its sharpness (NaN when not measured).
#[derive(Clone, Copy, Debug)]
pub struct OutCorner {
    pub id: usize,
    pub x: f64,
    pub y: f64,
    pub markers: u8,
    pub sharpness: f64,
}

/// One frame's result, in the work image's pixels (OpenCV convention); board_detect.js converts
/// to the types.js convention and full-frame pixels.
#[derive(Clone, Debug, Default)]
pub struct FrameResult {
    pub work_width: usize,
    pub work_height: usize,
    /// Any marker found (before the removed ones were dropped): board_detect.js's miss count.
    pub any_marker: bool,
    pub markers: Vec<Marker>,
    pub corners: Vec<OutCorner>,
    /// Median marker side (work px), NaN when no marker is kept.
    pub marker_px: f64,
}

pub struct BoardDetector {
    pub board: CharucoBoard,
    pub aruco: ArucoDetector,
    removed: Vec<bool>,
    refiner: CornerRefiner,
    /// OpenCV's tryRefineMarkers (on by default, as the desktop runs it).
    pub try_refine: bool,
}

impl BoardDetector {
    pub fn new(squares_x: usize, squares_y: usize, marker_length: f32) -> BoardDetector {
        let board = CharucoBoard::new(squares_x, squares_y, marker_length);
        let aruco = ArucoDetector::new(board.marker_count());
        let removed = vec![false; board.marker_count()];
        BoardDetector { board, aruco, removed, refiner: CornerRefiner::default(), try_refine: true }
    }

    /// Marks markers the sheet does not print; any detection of them is dropped.
    pub fn set_removed(&mut self, ids: &[usize]) {
        self.removed.iter_mut().for_each(|r| *r = false);

        for &id in ids {
            if id < self.removed.len() {
                self.removed[id] = true;
            }
        }
    }

    pub fn detect(&mut self, frame: &Gray, options: &FrameOptions) -> FrameResult {
        let scaled;
        let work: &Gray = if options.processing_scale < 1.0 {
            let w = js_round(frame.width as f64 * options.processing_scale).max(1) as usize;
            let h = js_round(frame.height as f64 * options.processing_scale).max(1) as usize;
            scaled = resize_area(frame, w, h);
            &scaled
        } else {
            frame
        };

        let mut result = FrameResult { work_width: work.width, work_height: work.height, marker_px: f64::NAN, ..Default::default() };
        let whole = (work.width, work.height);
        let s_whole = whole.0.min(whole.1) as f64 / REF_SHORT_SIDE;
        // A region of the work image (T-0332): detected on its own, every size-relative limit
        // still the whole image's (the perimeter limits through reference_size, the pixel scale s
        // below), its results moved back by its offset at the end.
        let region = options.roi.filter(|&(x, y, w, h)| w > 0 && h > 0 && (x > 0 || y > 0 || w < whole.0 || h < whole.1));
        let cropped = region.map(|(x, y, w, h)| work.crop(x, y, w, h));
        let (ox, oy) = region.map(|(x, y, _, _)| (x.min(whole.0 - 1), y.min(whole.1 - 1))).unwrap_or((0, 0));
        let work: &Gray = cropped.as_ref().unwrap_or(work);
        self.aruco.params.reference_size = region.map(|_| whole);
        let (mut markers, mut rejected) = self.aruco.detect_markers(work);
        self.aruco.params.reference_size = None;

        if markers.is_empty() {
            return result;
        }

        if self.try_refine {
            self.aruco.refine_detected_markers(work, &self.board.marker_corners, &mut markers, &mut rejected);
        }

        result.any_marker = true;
        markers.retain(|m| !self.removed[m.id]);

        if markers.is_empty() {
            return result;
        }

        result.marker_px = median_marker_side(&markers);
        let corners: Vec<Corner> = interpolate_corners(&self.board, &markers, work, &mut self.refiner)
            .into_iter()
            .filter(|c| options.single_marker_corners || c.markers >= 2)
            .collect();
        let mut xs: Vec<f64> = corners.iter().map(|c| c.pos.x as f64).collect();
        let mut ys: Vec<f64> = corners.iter().map(|c| c.pos.y as f64).collect();
        let mut sharpness = vec![f64::NAN; corners.len()];

        if options.refine_blurred && !corners.is_empty() {
            // The pixel scale is the whole work image's (a region is not a smaller frame).
            for k in 0..corners.len() {
                sharpness[k] = corner_sharpness(work, xs[k], ys[k], s_whole);
            }

            let blurred: Vec<bool> = sharpness.iter().map(|&v| v < MIN_CORNER_SHARPNESS).collect();
            let ids: Vec<usize> = corners.iter().map(|c| c.id).collect();
            refine_blurred_corners(work, self.board.squares_x - 1, &ids, &mut xs, &mut ys, &blurred, options);
        }

        // Back to the whole work image's pixels.
        let (fx, fy) = (ox as f32, oy as f32);
        result.markers = markers.into_iter().map(|m| Marker { id: m.id, corners: m.corners.map(|p| Pt::new(p.x + fx, p.y + fy)) }).collect();
        result.corners = corners.iter().enumerate().map(|(k, c)| OutCorner {
            id: c.id,
            x: xs[k] + ox as f64,
            y: ys[k] + oy as f64,
            markers: c.markers,
            sharpness: sharpness[k],
        }).collect();
        result
    }
}

/// board_detect.js medianMarkerSide: the median of each marker's mean side.
fn median_marker_side(markers: &[Marker]) -> f64 {
    let mut sides: Vec<f64> = markers.iter().map(|m| {
        let mut sum = 0f64;

        for c in 0..4 {
            let d = (c + 1) % 4;
            let dx = m.corners[d].x as f64 - m.corners[c].x as f64;
            let dy = m.corners[d].y as f64 - m.corners[c].y as f64;
            sum += dx.hypot(dy);
        }

        sum / 4.0
    }).collect();
    sides.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mid = sides.len() / 2;

    if sides.len() % 2 == 1 { sides[mid] } else { (sides[mid - 1] + sides[mid]) / 2.0 }
}

/// detect.py refine_blurred (via board_detect.js): blurred corners re-refined with cornerSubPix
/// in a window of 1/8 of the local square size (3 px .. max_half), the square measured through a
/// RANSAC homography (5 px) from the frame's own corners. Corners whose window would leave the
/// image are skipped. `desktop_half_pixel_shift` reproduces detect.py's -0.5 / +0.5 around the
/// call (a desktop bug: kb opencv-js-for-the-phone-scanner-build-charuco-po).
fn refine_blurred_corners(work: &Gray, per_row: usize, ids: &[usize], xs: &mut [f64], ys: &mut [f64], blurred: &[bool], options: &FrameOptions) {
    let n = ids.len();

    if n < 4 || !blurred.iter().any(|&b| b) {
        return;
    }

    let board_pt = |id: usize| ((id % per_row) as f64 + 1.0, (id / per_row) as f64 + 1.0);
    let src: Vec<(f64, f64)> = ids.iter().map(|&id| board_pt(id)).collect();
    // The image points pass through float32 on their way to OpenCV, as before.
    let dst: Vec<(f64, f64)> = (0..n).map(|k| (xs[k] as f32 as f64, ys[k] as f32 as f64)).collect();
    let Some(h) = fit_homography_ransac(&src, &dst, 5.0) else { return };
    let shift = if options.desktop_half_pixel_shift { 0.5 } else { 0.0 };
    let criteria = Criteria { max_iters: 100, eps: 0.001 };
    let mut windows: Vec<(i64, SubPix)> = Vec::new();

    for k in 0..n {
        if !blurred[k] {
            continue;
        }

        let (bx, by) = board_pt(ids[k]);
        let a = transform_f64(&h, bx, by);
        let b1 = transform_f64(&h, bx + 1.0, by);
        let b2 = transform_f64(&h, bx, by + 1.0);
        let square_px = (b1.0 - a.0).hypot(b1.1 - a.1).min((b2.0 - a.0).hypot(b2.1 - a.1));
        let half = options.max_half.min(py_round(square_px / 8.0).max(3));
        let (x, y) = (xs[k], ys[k]);
        let hf = half as f64;

        if !(x >= hf + 1.0 && x < work.width as f64 - hf - 1.0 && y >= hf + 1.0 && y < work.height as f64 - hf - 1.0) {
            continue;
        }

        if !windows.iter().any(|(w, _)| *w == half) {
            windows.push((half, SubPix::new(half as usize, None)));
        }

        let sub = &mut windows.iter_mut().find(|(w, _)| *w == half).unwrap().1;
        let start = Pt::new((x - shift) as f32, (y - shift) as f32);
        let refined = sub.refine(work, start, criteria);
        xs[k] = refined.x as f64 + shift;
        ys[k] = refined.y as f64 + shift;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_median_marker_side_averages_the_middle_two_of_an_even_count() {
        // Setup: two axis-aligned markers of side 20 and 30 px.
        // Test: median_marker_side.
        // Verifies: board_detect.js's median: the mean of the two middle values for an even
        // count (25), the middle one for odd.
        let m = |s: f32| Marker { id: 0, corners: [Pt::new(0.0, 0.0), Pt::new(s, 0.0), Pt::new(s, s), Pt::new(0.0, s)] };
        assert_eq!(median_marker_side(&[m(20.0), m(30.0)]), 25.0);
        assert_eq!(median_marker_side(&[m(20.0), m(30.0), m(70.0)]), 30.0);
    }

    /// Draws marker `id` (cells of `cell` px, ink 30, paper 220) into `img` at (x0, y0), as
    /// marker.rs's test helper draws one on its own.
    fn draw_into(img: &mut Gray, id: usize, x0: usize, y0: usize, cell: usize) {
        let code = crate::dictionary::DICT_4X4_250[id];

        for cy in 0..6 {
            for cx in 0..6 {
                let border = cx == 0 || cy == 0 || cx == 5 || cy == 5;
                let white = !border && (code >> (15 - ((cy - 1) * 4 + cx - 1))) & 1 == 1;

                for y in 0..cell {
                    for x in 0..cell {
                        img.data[(y0 + cy * cell + y) * img.width + x0 + cx * cell + x] = if white { 220 } else { 30 };
                    }
                }
            }
        }
    }

    #[test]
    fn a_region_finds_what_is_in_it_where_the_whole_frame_finds_it() {
        // Setup: a 400 x 300 paper frame with two board markers, 23 at (40, 60) and 97 at (260,
        // 150), 72 px wide, and the strip-board detector.
        // Test: detect the whole frame; then only the region (20, 40, 140, 120) round marker 23.
        // Verifies (T-0332's region): the region finds marker 23 only, with exactly the corners the
        // whole frame gives it (the region's results are moved back to the whole frame's pixels),
        // and the work size reported is still the whole frame's; the region applies to one detect
        // only (the module clears it) -- here, FrameOptions without one finds both again.
        let mut img = Gray::filled(400, 300, 220);
        draw_into(&mut img, 23, 40, 60, 12);
        draw_into(&mut img, 97, 260, 150, 12);
        let mut det = BoardDetector::new(23, 17, 0.7);
        let whole = det.detect(&img, &FrameOptions::default());
        let mut ids: Vec<usize> = whole.markers.iter().map(|m| m.id).collect();
        ids.sort();
        assert_eq!(ids, vec![23, 97]);

        let region = det.detect(&img, &FrameOptions { roi: Some((20, 40, 140, 120)), ..FrameOptions::default() });
        assert_eq!(region.markers.len(), 1, "{:?}", region.markers);
        let in_whole = whole.markers.iter().find(|m| m.id == 23).unwrap();
        assert_eq!(region.markers[0], *in_whole);
        assert_eq!((region.work_width, region.work_height), (400, 300));
        assert_eq!(det.detect(&img, &FrameOptions::default()).markers.len(), 2);
    }

    #[test]
    fn without_retries_each_candidate_group_is_read_once() {
        // Setup: two markers and a plain black square (a chessboard square: a quadrilateral that
        // reads as no marker, found by several threshold windows) in one frame.
        // Test: detect with OpenCV's retries (the default) and without (retry_close false).
        // Verifies: without retries the identification reads exactly one candidate per group (reads
        // == groups after filterTooCloseCandidates), with them more (the black square's
        // near-duplicates read again); both find the two markers.
        let mut img = Gray::filled(400, 300, 220);
        draw_into(&mut img, 23, 40, 60, 12);
        draw_into(&mut img, 97, 260, 150, 12);

        for y in 200..270 {
            for x in 40..110 {
                img.data[y * 400 + x] = 30;
            }
        }

        let mut det = BoardDetector::new(23, 17, 0.7);
        let exact = det.detect(&img, &FrameOptions::default());
        let exact_stats = det.aruco.stats;
        det.aruco.params.retry_close = false;
        let fast = det.detect(&img, &FrameOptions::default());
        let fast_stats = det.aruco.stats;
        assert_eq!(exact.markers.len(), 2);
        assert_eq!(fast.markers.len(), 2);
        assert_eq!(fast_stats.identify_reads, fast_stats.selected, "{fast_stats:?}");
        assert!(exact_stats.identify_reads > exact_stats.selected, "{exact_stats:?}");
    }

    #[test]
    fn a_frame_without_a_board_returns_nothing() {
        // Setup: a plain table-grey 320 x 240 frame and the strip-board detector.
        // Test: detect with the default options.
        // Verifies: no marker (so board_detect.js counts a miss), no corners, no marker size,
        // and the work size reported -- the empty result, without a panic.
        let mut det = BoardDetector::new(23, 17, 0.7);
        let r = det.detect(&Gray::filled(320, 240, 70), &FrameOptions::default());
        assert!(!r.any_marker && r.markers.is_empty() && r.corners.is_empty() && r.marker_px.is_nan());
        assert_eq!((r.work_width, r.work_height), (320, 240));
    }
}
