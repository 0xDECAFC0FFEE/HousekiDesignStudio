// One frame in, the board's markers and chessboard corners out: the per-frame work of
// board_detect.js (src/web/src/lib/vision), which ported HousekiScanner's desktop detector
// (board.py, detect.py, calibrate.py), now done in one call into the wasm module.
//
//   1. optional downscale (processingScale, INTER_AREA);
//   2. ArUco markers; with several boards (the scanner's three, T-0340: one layout, each printing its
//      own run of dictionary ids), the board most of them belong to is the one in view, and the
//      others' markers are dropped; then the board-guided recovery of missed ones (tryRefineMarkers);
//   3. markers the sheet does not print (removed ids) dropped; on the phone's fast path, markers
//      that sit where the others say a different marker is (layout_check: the spirals read as
//      markers, T-0340) dropped too, before the refinement and the corners use them;
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
use crate::linalg::{fit_homography, fit_homography_ransac, invert3, mul3, transform_f64, Mat3, Pt};
use crate::marker::square_to_quad;
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
    /// Which of the detector's boards the markers are (an index into its first ids), None when
    /// no marker was found.
    pub board: Option<usize>,
}

pub struct BoardDetector {
    pub board: CharucoBoard,
    pub aruco: ArucoDetector,
    /// Each board's first dictionary id: board b's marker k is dictionary id first_ids[b] + k.
    first_ids: Vec<usize>,
    removed: Vec<bool>,
    refiner: CornerRefiner,
    /// OpenCV's tryRefineMarkers (on by default, as the desktop runs it).
    pub try_refine: bool,
    /// Drop markers inconsistent with the board's layout (T-0340, the phone's fast path; OpenCV
    /// has no such step, so off by default): see drop_misplaced_markers.
    pub layout_check: bool,
    /// Markers the last detect() dropped for sitting in the wrong place.
    pub misplaced: usize,
    /// The board the last frame with markers was read as: it wins a tied vote.
    last_board: usize,
}

impl BoardDetector {
    /// A detector for one board printing dictionary ids from 0.
    pub fn new(squares_x: usize, squares_y: usize, marker_length: f32) -> BoardDetector {
        BoardDetector::for_boards(squares_x, squares_y, marker_length, &[0], &[])
    }

    /// A detector for boards of one layout, board b printing dictionary ids from first_ids[b]
    /// (T-0340), none of the dictionary ids in `unreadable` read. Each frame is read as the board
    /// most of its markers belong to.
    pub fn for_boards(squares_x: usize, squares_y: usize, marker_length: f32, first_ids: &[usize], unreadable: &[usize]) -> BoardDetector {
        let board = CharucoBoard::new(squares_x, squares_y, marker_length);
        let aruco = ArucoDetector::for_boards(first_ids, board.marker_count(), unreadable);
        let removed = vec![false; board.marker_count()];
        BoardDetector {
            board, aruco, first_ids: first_ids.to_vec(), removed, refiner: CornerRefiner::default(), try_refine: true,
            layout_check: false, misplaced: 0, last_board: 0,
        }
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

        // The board in view: the one most DIFFERENT markers belong to (ties: the board of the last
        // frame with markers, so a stray read cannot flip a sparse view). A spiral
        // read as a marker repeats one id in many dark squares (T-0340: id 441 seventeen times in
        // one blurred view of the white/black board), so each id votes once. Markers are table
        // slots (board x count + index) until here, indices on the board after.
        let count = self.board.marker_count();
        let mut votes = vec![0usize; self.first_ids.len()];
        let mut slots: Vec<usize> = markers.iter().map(|m| m.id).collect();
        slots.sort_unstable();
        slots.dedup();

        for slot in slots {
            votes[slot / count] += 1;
        }

        let last = self.last_board.min(votes.len() - 1);
        let chosen = (0..votes.len()).fold(last, |best, b| if votes[b] > votes[best] { b } else { best });
        self.last_board = chosen;
        markers.retain(|m| m.id / count == chosen);
        markers.iter_mut().for_each(|m| m.id %= count);
        result.board = Some(chosen);
        self.aruco.refine_first_id = self.first_ids[chosen];
        self.misplaced = 0;

        if self.layout_check {
            let before = markers.len();
            drop_misplaced_markers(&self.board.marker_corners, &mut markers);
            self.misplaced = before - markers.len();
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

/// How far (a share of the median marker side) a marker may sit from where the others put it.
pub const MISPLACED_SHARE: f64 = 0.5;

/// Drops the markers that sit where the rest of the board says another marker is (T-0340). The
/// boards print a grey spiral in every dark square, and in a blurred or distant view a spiral can
/// read as one of the boards' markers (measured on 360 synthetic views: dictionary ids 437, 441,
/// 821, 379 and a few others, one to sixteen squares from where they are printed). Such a marker
/// pulls the board-guided refinement and the corners around it off. One homography from the
/// markers' places on the board to their centres in the picture -- all of them when they agree,
/// else the largest set agreeing with a 4-marker sample (RANSAC, a fixed seed) -- keeps every
/// marker within MISPLACED_SHARE of the median marker side of where it puts it. With fewer than 5
/// markers nothing is judged but repeated ids (any 4 fit some homography); with fewer than 4 agreeing (copies of
/// one id never agree), every marker is dropped. A phone lens bends straight lines by a few pixels at the edges, far below the half
/// marker (12-35 px at 960 x 540) a misread is out by.
pub fn drop_misplaced_markers(board_corners: &[[Pt; 4]], markers: &mut Vec<Marker>) {
    // An id read twice is at least once a misread; in a view too small to judge, both go.
    if markers.len() < 5 {
        let ids: Vec<usize> = markers.iter().map(|m| m.id).collect();
        markers.retain(|m| ids.iter().filter(|&&id| id == m.id).count() == 1);
        return;
    }

    let n = markers.len();

    let centre = |c: &[Pt; 4]| {
        let (x, y) = c.iter().fold((0.0, 0.0), |(x, y), p| (x + p.x as f64, y + p.y as f64));
        (x / 4.0, y / 4.0)
    };
    let src: Vec<(f64, f64)> = markers.iter().map(|m| centre(&board_corners[m.id])).collect();
    let dst: Vec<(f64, f64)> = markers.iter().map(|m| centre(&m.corners)).collect();
    let limit = MISPLACED_SHARE * median_marker_side(markers);
    let inliers = |h: &Mat3| -> Vec<bool> {
        (0..n).map(|i| {
            let (x, y) = transform_f64(h, src[i].0, src[i].1);
            (x - dst[i].0).hypot(y - dst[i].1) <= limit
        }).collect()
    };

    // Everything first: with no misread marker (the usual case), that is the answer.
    if let Some(h) = fit_homography(&src, &dst) {
        if inliers(&h).iter().all(|&k| k) {
            return;
        }
    }

    // A 4-point homography in closed form: square -> dst quad after (square -> src quad)^-1.
    let four = |pick: &[usize; 4]| -> Option<Mat3> {
        let quad = |pts: &[(f64, f64)]| pick.map(|i| Pt::new(pts[i].0 as f32, pts[i].1 as f32));
        let a = square_to_quad(&quad(&src), 1.0)?;
        let b = square_to_quad(&quad(&dst), 1.0)?;
        Some(mul3(&b, &invert3(&a)?))
    };
    let mut best: Vec<bool> = Vec::new();
    let mut best_count = 0;
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = |m: usize| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % m as u64) as usize
    };

    for _ in 0..200 {
        let mut pick = [0usize; 4];

        for k in 0..4 {
            loop {
                let candidate = next(n);

                if !pick[..k].contains(&candidate) {
                    pick[k] = candidate;
                    break;
                }
            }
        }

        if let Some(h) = four(&pick) {
            let found = inliers(&h);
            let count = found.iter().filter(|&&k| k).count();

            if count > best_count {
                best_count = count;
                best = found;
            }
        }
    }

    if best_count < 4 {
        markers.clear();
        return;
    }

    // Refit on the agreeing markers and judge every marker again against that.
    let keep: Vec<usize> = (0..n).filter(|&i| best[i]).collect();
    let sub_src: Vec<(f64, f64)> = keep.iter().map(|&i| src[i]).collect();
    let sub_dst: Vec<(f64, f64)> = keep.iter().map(|&i| dst[i]).collect();
    let fit = fit_homography(&sub_src, &sub_dst).map(|h| inliers(&h)).filter(|k| k.iter().filter(|&&v| v).count() >= best_count);
    let kept = fit.unwrap_or(best);
    let mut k = 0;
    markers.retain(|_| {
        k += 1;
        kept[k - 1]
    });
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

    /// Draws dictionary marker `id` (cells of `cell` px, ink 30, paper 220) into `img` at (x0, y0), as
    /// marker.rs's test helper draws one on its own.
    fn draw_into(img: &mut Gray, id: usize, x0: usize, y0: usize, cell: usize) {
        let code = crate::dictionary::DICT_4X4_1000[id];

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
    fn a_frame_is_read_as_the_board_most_of_its_markers_belong_to() {
        // Setup: the scanner's three boards (one 23 x 17 layout printing dictionary ids from 250,
        // 500 and 750). One frame shows marker 23 of the white/black board (dictionary id 773) and
        // marker 97 of it (847); another adds marker 40 of the grey/black board (540) to those two;
        // a third shows only the older boards' marker 23 (dictionary id 23).
        // Test: detect each frame.
        // Verifies: the first two are read as board 2 (white/black) with the markers as indices on
        // the board (23, 97), the grey/black stray dropped by the majority; the older boards'
        // marker is no marker at all (no board, nothing found).
        let boards = [250, 500, 750];
        let mut det = BoardDetector::for_boards(23, 17, 0.7, &boards, &[]);
        let mut img = Gray::filled(400, 300, 220);
        draw_into(&mut img, 773, 40, 60, 12);
        draw_into(&mut img, 847, 260, 150, 12);
        let r = det.detect(&img, &FrameOptions::default());
        let mut ids: Vec<usize> = r.markers.iter().map(|m| m.id).collect();
        ids.sort();
        assert_eq!((r.board, ids), (Some(2), vec![23, 97]));

        draw_into(&mut img, 540, 150, 200, 12);
        let r = det.detect(&img, &FrameOptions::default());
        let mut ids: Vec<usize> = r.markers.iter().map(|m| m.id).collect();
        ids.sort();
        assert_eq!((r.board, ids), (Some(2), vec![23, 97]));

        let mut old = Gray::filled(400, 300, 220);
        draw_into(&mut old, 23, 40, 60, 12);
        let r = det.detect(&old, &FrameOptions::default());
        assert!(r.board.is_none() && r.markers.is_empty() && !r.any_marker);
    }

    #[test]
    fn a_marker_read_in_the_wrong_square_is_dropped_and_the_rest_kept() {
        // Setup: the 23 x 17 board's markers 40-59 seen through a perspective homography (each at
        // the place it is printed, ~30 px wide), then the same set with marker 45 moved to where
        // marker 52 is printed (a spiral read as 45, two rows off; 52 itself unseen), and a set of four (too few to
        // judge) with one moved.
        // Test: drop_misplaced_markers on each.
        // Verifies: the consistent set is left whole; in the second, exactly the moved marker 45
        // goes and the other 18 stay; four markers are never judged, so nothing goes, but two
        // copies of one id among four both go; and six copies of one id in six places (a spiral
        // read again and again) agree on nothing: all go.
        let board = CharucoBoard::new(23, 17, 0.7);
        let h = [30.0, 4.0, 80.0, -3.0, 28.0, 60.0, 0.0004, 0.0006, 1.0];
        let place = |id: usize| Marker { id, corners: board.marker_corners[id].map(|p| {
            let (x, y) = transform_f64(&h, p.x as f64, p.y as f64);
            Pt::new(x as f32, y as f32)
        }) };
        let mut good: Vec<Marker> = (40..60).map(place).collect();
        drop_misplaced_markers(&board.marker_corners, &mut good);
        assert_eq!(good.len(), 20);

        let mut misread: Vec<Marker> = (40..60).map(place).collect();
        misread[5] = Marker { id: 45, corners: place(52).corners };
        misread.retain(|m| m.id != 52);
        drop_misplaced_markers(&board.marker_corners, &mut misread);
        assert_eq!(misread.len(), 18);
        assert!(misread.iter().all(|m| m.id != 45), "{:?}", misread.iter().map(|m| m.id).collect::<Vec<_>>());

        let mut few: Vec<Marker> = (40..44).map(place).collect();
        few[0] = Marker { id: 40, corners: place(55).corners };
        drop_misplaced_markers(&board.marker_corners, &mut few);
        assert_eq!(few.len(), 4);
        let mut twice: Vec<Marker> = (40..44).map(place).collect();
        twice[3] = Marker { id: 40, corners: place(55).corners };
        drop_misplaced_markers(&board.marker_corners, &mut twice);
        assert_eq!(twice.iter().map(|m| m.id).collect::<Vec<_>>(), vec![41, 42]);


        let mut copies: Vec<Marker> = (40..46).map(|k| Marker { id: 41, corners: place(k * 2).corners }).collect();
        drop_misplaced_markers(&board.marker_corners, &mut copies);
        assert!(copies.is_empty());
    }

    #[test]
    fn a_marker_read_many_times_casts_one_vote_for_its_board() {
        // Setup: the three boards; one frame showing four different white/black markers (dictionary
        // ids 760-763) and the same white/grey marker (id 441) in five places, as a spiral read
        // again and again looks.
        // Test: detect the frame.
        // Verifies: the frame is read as the white/black board (4 different ids against 1), not the
        // white/grey one (5 markers against 4).
        let mut det = BoardDetector::for_boards(23, 17, 0.7, &[250, 500, 750], &[]);
        let mut img = Gray::filled(640, 300, 220);

        for (k, id) in [760, 761, 762, 763].iter().enumerate() {
            draw_into(&mut img, *id, 20 + 150 * k, 20, 12);
        }

        for k in 0..5 {
            draw_into(&mut img, 441, 20 + 120 * k, 180, 12);
        }

        let r = det.detect(&img, &FrameOptions::default());
        assert_eq!(r.board, Some(2));
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
