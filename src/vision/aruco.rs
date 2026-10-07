// ArUco marker detection for one dictionary (DICT_4X4_250) and one board: the candidate search,
// the grouping of near-duplicate candidates, identification, and the board-guided recovery of
// missed markers (refineDetectedMarkers), as the ChArUco detector runs them.
//
// Ported from OpenCV 4.14.0 modules/objdetect/src/aruco/aruco_detector.cpp: _detectInitialCandidates
// and _findMarkerContours (here over thresholds.rs's fused thresholds and contours.rs's tracer),
// _reorderCandidatesCorners, filterTooCloseCandidates (sort by perimeter, grouping, the
// closeContours kept for a second try, the containment hierarchy), identifyCandidates (by depth,
// parents of found markers counted as visited), correctCornerPosition, and
// refineDetectedMarkers with _projectUndetectedMarkers' global homography. Only what the
// desktop's parameters reach is kept: no ArUco3 pyramid, no inverted markers, no AprilTag or
// contour corner refinement, corner refinement off (CORNER_REFINE_NONE, OpenCV's default, which
// the scanner keeps: its ChArUco corners are refined instead).
//
// Two speed-ups that change no result: the O(n^2) search for near-duplicate candidates only
// compares candidates whose centres are close enough to possibly qualify (the mean corner
// distance can never be smaller than the distance between the centres), and the containment test
// checks bounding boxes before the point-in-polygon tests.
//
// Copyright (C) 2000-2022, Intel Corporation, all rights reserved.
// Copyright (C) 2015-2023, OpenCV Foundation, all rights reserved.
// (and the other OpenCV copyright holders listed in NOTICE)
// Copyright 2026 Lucas Tong (the Rust port)
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or agreed to in
// writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
// specific language governing permissions and limitations under the License.

use crate::contours::trace_contours;
use crate::dictionary::{distance_to_id, identify, MarkerTable, MARKER_SIZE, MAX_CORRECTION_BITS};
use crate::gray::Gray;
use crate::linalg::{fit_homography, transform, Pt};
use crate::marker::{border_errors, cell_ratios, inner_cells, CellParams};
use crate::polygon::{approx_poly_dp_closed, is_contour_convex, point_polygon_test};
use crate::threshold::{adaptive_thresholds, window_sizes, Integral};

/// The DetectorParameters the scanner sets or relies on (OpenCV's defaults otherwise).
#[derive(Clone, Debug)]
pub struct DetectorParams {
    pub win_min: i32,
    pub win_max: i32,
    pub win_step: i32,
    pub thresh_constant: f64,
    pub min_perimeter_rate: f64,
    pub max_perimeter_rate: f64,
    pub polygonal_approx_accuracy_rate: f64,
    pub min_corner_distance_rate: f64,
    pub min_distance_to_border: i32,
    pub min_marker_distance_rate: f64,
    pub min_group_distance: f32,
    pub cells: CellParams,
    pub max_erroneous_bits_in_border_rate: f64,
    pub error_correction_rate: f64,
    pub valid_bit_threshold: f32,
    /// OpenCV's behaviour (true): a group whose largest contour reads as no marker has its other
    /// contours read too. False: the phone's fast path (T-0332), not opencv.js's results.
    pub retry_close: bool,
    /// The refinement's search radius from each projected marker's own size (LOCAL_RADIUS x its
    /// side, at most OpenCV's) instead of OpenCV's fixed one (false). T-0332's fast path.
    pub local_refine: bool,
    /// The frame size the perimeter limits are relative to, when detecting in a region of it
    /// (T-0332); None: the image's own size, as OpenCV.
    pub reference_size: Option<(usize, usize)>,
}

impl Default for DetectorParams {
    /// The desktop's tuned parameters at marker-size factor 1 (board.py detector_params) on top
    /// of OpenCV 4.14's defaults.
    fn default() -> Self {
        DetectorParams {
            win_min: 3,
            win_max: 93,
            win_step: 15,
            thresh_constant: 7.0,
            min_perimeter_rate: 0.03,
            max_perimeter_rate: 4.0,
            polygonal_approx_accuracy_rate: 0.03,
            min_corner_distance_rate: 0.05,
            min_distance_to_border: 3,
            min_marker_distance_rate: 0.125,
            min_group_distance: 0.21,
            cells: CellParams { pixel_per_cell: 8, margin_rate: 0.3, min_otsu_std: 5.0 },
            max_erroneous_bits_in_border_rate: 0.35,
            error_correction_rate: 0.6,
            valid_bit_threshold: 0.49,
            retry_close: true,
            local_refine: false,
            reference_size: None,
        }
    }
}

/// The fast path's refinement search radius, as a share of the projected marker's side (T-0332).
pub const LOCAL_RADIUS: f32 = 0.4;
/// ... used only when at least this many markers were found (their homography places the others).
pub const LOCAL_MIN_MARKERS: usize = 20;

/// RefineParameters (the scanner's: 40 px, 3, all orders).
#[derive(Clone, Debug)]
pub struct RefineParams {
    pub min_rep_distance: f32,
    pub error_correction_rate: f32,
    pub check_all_orders: bool,
}

impl Default for RefineParams {
    fn default() -> Self {
        RefineParams { min_rep_distance: 40.0, error_correction_rate: 3.0, check_all_orders: true }
    }
}

/// A detected marker: its id and its corners (OpenCV pixel-centre coordinates), clockwise from
/// the marker's top-left as printed.
#[derive(Clone, Debug, PartialEq)]
pub struct Marker {
    pub id: usize,
    pub corners: [Pt; 4],
}

#[derive(Clone, Debug)]
struct Candidate {
    corners: [Pt; 4],
    perimeter: f32,
    parent: i32,
    depth: i32,
    close: Vec<[Pt; 4]>,
}

fn perimeter(c: &[Pt; 4]) -> f32 {
    let mut p = 0f32;

    for i in 0..4 {
        p += (c[i] - c[(i + 1) % 4]).norm_sqr().sqrt();
    }

    p
}

/// getAverageDistance: the smallest, over the four ways of pairing the corners, root-mean-square
/// corner distance.
fn average_distance(a: &[Pt; 4], b: &[Pt; 4]) -> f32 {
    let mut min_sq = f32::MAX;

    for fc in 0..4 {
        let mut d = 0f32;

        for c in 0..4 {
            d += (a[(c + fc) % 4] - b[c]).norm_sqr();
        }

        d /= 4.0;
        min_sq = min_sq.min(d);
    }

    min_sq.sqrt()
}

/// getAverageModuleSize: the mean side over the cells per side (4 bits + 2 border).
fn average_module_size(c: &[Pt; 4]) -> f32 {
    let mut s = 0f32;

    for i in 0..4 {
        s += (c[i] - c[(i + 1) % 4]).norm_sqr().sqrt();
    }

    s / (4.0 * (MARKER_SIZE + 2) as f32)
}

fn centre(c: &[Pt; 4]) -> Pt {
    Pt::new((c[0].x + c[1].x + c[2].x + c[3].x) * 0.25, (c[0].y + c[1].y + c[2].y + c[3].y) * 0.25)
}

fn bbox(c: &[Pt; 4]) -> (f32, f32, f32, f32) {
    let mut b = (c[0].x, c[0].y, c[0].x, c[0].y);

    for p in &c[1..] {
        b.0 = b.0.min(p.x);
        b.1 = b.1.min(p.y);
        b.2 = b.2.max(p.x);
        b.3 = b.3.max(p.y);
    }

    b
}

/// checkMarker1InMarker2: every corner of `inner` inside or on `outer`.
fn inside(inner: &[Pt; 4], outer: &[Pt; 4]) -> bool {
    inner.iter().all(|&p| point_polygon_test(outer, p) >= 0)
}

/// filterTooCloseCandidates' pairing test, for candidates sorted by decreasing perimeter: for
/// each i, the j > i (ascending) whose average corner distance to i is under perimeter_j x rate.
/// OpenCV compares every pair; this sweeps the centres along x instead, because the average
/// corner distance is never less than the distance between the centres, so a pair whose centres
/// are further apart than perimeter_j x rate (<= perimeter_i x rate) cannot qualify. A pixel of
/// slack covers float rounding; every pair that might qualify is then tested exactly as OpenCV
/// tests it, so the pairs are the same.
fn close_pairs(corners: &[[Pt; 4]], perimeters: &[f32], rate: f32) -> Vec<Vec<usize>> {
    let n = corners.len();
    let centres: Vec<Pt> = corners.iter().map(centre).collect();
    let mut by_x: Vec<usize> = (0..n).collect();
    by_x.sort_by(|&a, &b| centres[a].x.partial_cmp(&centres[b].x).unwrap_or(std::cmp::Ordering::Equal));
    let mut rank = vec![0usize; n];

    for (r, &i) in by_x.iter().enumerate() {
        rank[i] = r;
    }

    let mut pairs: Vec<Vec<usize>> = vec![Vec::new(); n];

    for i in 0..n {
        let reach = perimeters[i] * rate + 1.0;
        let cx = centres[i].x;

        for dir in [-1i64, 1] {
            let mut r = rank[i] as i64 + dir;

            while r >= 0 && (r as usize) < n {
                let j = by_x[r as usize];

                if (centres[j].x - cx).abs() > reach {
                    break;
                }

                if j > i
                    && (centres[j] - centres[i]).norm_sqr() <= reach * reach
                    && average_distance(&corners[i], &corners[j]) < perimeters[j] * rate
                {
                    pairs[i].push(j);
                }

                r += dir;
            }
        }

        pairs[i].sort_unstable();
    }

    pairs
}

/// What the last detect_markers did, for profiling (examples/profile_frames.rs): raw candidates,
/// candidates left after filterTooCloseCandidates, cell readings for identification, and
/// rejected candidates the board-guided refinement read.
#[derive(Clone, Copy, Debug, Default)]
pub struct DetectStats {
    pub raw: usize,
    pub selected: usize,
    pub identify_reads: usize,
    pub refine_reads: usize,
}

/// The detector for one board's markers. Its buffers (the integral image, the thresholded
/// images, the warp scratch) are kept between frames.
pub struct ArucoDetector {
    pub params: DetectorParams,
    pub refine: RefineParams,
    pub stats: DetectStats,
    table: MarkerTable,
    integral: Integral,
    binaries: Vec<Vec<u8>>,
    scratch: Vec<u8>,
}

impl ArucoDetector {
    /// A detector for markers 0 .. marker_count - 1 (a ChArUco board's).
    pub fn new(marker_count: usize) -> ArucoDetector {
        ArucoDetector {
            params: DetectorParams::default(),
            refine: RefineParams::default(),
            stats: DetectStats::default(),
            table: MarkerTable::for_ids(marker_count),
            integral: Integral::default(),
            binaries: Vec::new(),
            scratch: Vec::new(),
        }
    }

    // _detectInitialCandidates + _reorderCandidatesCorners: every convex quadrilateral contour
    // of every threshold, in OpenCV's order.
    // Public (hidden) for examples/profile_frames.rs, which times the stages.
    #[doc(hidden)]
    pub fn initial_candidates(&mut self, grey: &Gray) -> Vec<[Pt; 4]> {
        let p = &self.params;
        let windows = window_sizes(p.win_min, p.win_max, p.win_step);
        adaptive_thresholds(grey, &windows, p.thresh_constant, &mut self.integral, &mut self.binaries);
        let (w, h) = (grey.width, grey.height);
        let (rw, rh) = p.reference_size.unwrap_or((w, h));
        let longest = rw.max(rh) as f64;
        let min_perimeter = (p.min_perimeter_rate * longest) as u32 as usize;
        let max_perimeter = (p.max_perimeter_rate * longest) as u32 as usize;
        let accuracy = p.polygonal_approx_accuracy_rate;
        let corner_rate = p.min_corner_distance_rate;
        let mut candidates = Vec::new();

        for binary in self.binaries.iter_mut() {
            let mut found: Vec<[Pt; 4]> = Vec::new();

            trace_contours(binary, w + 2, h + 2, |contour| {
                let n = contour.len();

                if n < min_perimeter || n > max_perimeter {
                    return;
                }

                let approx = approx_poly_dp_closed(contour, n as f64 * accuracy);

                if approx.len() != 4 || !is_contour_convex(&approx) {
                    return;
                }

                let mut min_dist_sq = longest * longest;

                for j in 0..4 {
                    let a = approx[j];
                    let b = approx[(j + 1) % 4];
                    let d = (a.0 - b.0) as f64 * (a.0 - b.0) as f64 + (a.1 - b.1) as f64 * (a.1 - b.1) as f64;
                    min_dist_sq = min_dist_sq.min(d);
                }

                let min_corner = n as f64 * corner_rate;

                if min_dist_sq < min_corner * min_corner {
                    return;
                }

                let mut c = [Pt::default(); 4];

                for (k, q) in approx.iter().enumerate() {
                    c[k] = Pt::new(q.0 as f32, q.1 as f32);
                }

                found.push(c);
            });

            // findContours returns the tracer's contours in reverse.
            found.reverse();
            candidates.extend(found);
        }

        for c in candidates.iter_mut() {
            let dx1 = (c[1].x - c[0].x) as f64;
            let dy1 = (c[1].y - c[0].y) as f64;
            let dx2 = (c[2].x - c[0].x) as f64;
            let dy2 = (c[2].y - c[0].y) as f64;

            if dx1 * dy2 - dy1 * dx2 < 0.0 {
                c.swap(1, 3);
            }
        }

        candidates
    }

    // filterTooCloseCandidates.
    #[doc(hidden)]
    pub fn filter_too_close_count(&self, w: usize, h: usize, raw: Vec<[Pt; 4]>) -> usize {
        self.filter_too_close(w, h, raw).len()
    }

    fn filter_too_close(&self, w: usize, h: usize, raw: Vec<[Pt; 4]>) -> Vec<Candidate> {
        let p = &self.params;
        let mut tree: Vec<Candidate> = raw.into_iter().map(|corners| Candidate {
            perimeter: perimeter(&corners),
            corners,
            parent: -1,
            depth: 0,
            close: Vec::new(),
        }).collect();
        // Largest first; stable, so equal perimeters keep their order.
        tree.sort_by(|a, b| b.perimeter.partial_cmp(&a.perimeter).unwrap_or(std::cmp::Ordering::Equal));
        let n = tree.len();
        let corners: Vec<[Pt; 4]> = tree.iter().map(|c| c.corners).collect();
        let perimeters: Vec<f32> = tree.iter().map(|c| c.perimeter).collect();
        let close_pairs = close_pairs(&corners, &perimeters, p.min_marker_distance_rate as f32);
        let mut group_id = vec![-1i64; n];
        let mut groups: Vec<Vec<usize>> = Vec::new();
        let mut selected = vec![true; n];

        for i in 0..n {
            for &j in &close_pairs[i] {
                selected[i] = false;
                selected[j] = false;

                if group_id[i] < 0 && group_id[j] < 0 {
                    group_id[i] = groups.len() as i64;
                    group_id[j] = groups.len() as i64;
                    groups.push(vec![i, j]);
                } else if group_id[i] > -1 && group_id[j] == -1 {
                    group_id[j] = group_id[i];
                    groups[group_id[i] as usize].push(j);
                } else if group_id[j] > -1 && group_id[i] == -1 {
                    group_id[i] = group_id[j];
                    groups[group_id[j] as usize].push(i);
                }
            }

            if selected[i] {
                selected[i] = false;
                group_id[i] = groups.len() as i64;
                groups.push(vec![i]);
            }
        }

        let border = p.min_distance_to_border as f32;

        for grouped in groups.iter_mut() {
            // detectInvertedMarker off: the largest contour of a group (the lowest index) first.
            grouped.sort();
            let first = grouped[0];
            let mut curr = first;
            let near_border = tree[curr].corners.iter().any(|c| {
                c.x < border || c.y < border || c.x > w as f32 - 1.0 - border || c.y > h as f32 - 1.0 - border
            });

            if near_border {
                continue;
            }

            selected[curr] = true;

            for &id in &grouped[1..] {
                let dist = average_distance(&tree[id].corners, &tree[curr].corners);
                let module = average_module_size(&tree[id].corners);

                if dist > p.min_group_distance * module {
                    curr = id;
                    let corners = tree[id].corners;
                    tree[first].close.push(corners);
                }
            }
        }

        let mut out: Vec<Candidate> = tree.into_iter().zip(selected).filter(|(_, s)| *s).map(|(c, _)| c).collect();

        // The containment hierarchy, smallest candidates first.
        let boxes: Vec<_> = out.iter().map(|c| bbox(&c.corners)).collect();

        for i in (0..out.len()).rev() {
            for j in (0..i).rev() {
                let (a, b) = (boxes[i], boxes[j]);

                if a.0 < b.0 || a.1 < b.1 || a.2 > b.2 || a.3 > b.3 {
                    continue;
                }

                if inside(&out[i].corners, &out[j].corners) {
                    out[i].parent = j as i32;
                    out[j].depth = out[j].depth.max(out[i].depth + 1);
                    break;
                }
            }
        }

        out
    }

    // _identifyOneCandidate: Some((id, rotation)) for a board marker.
    fn identify_one(&mut self, grey: &Gray, corners: &[Pt; 4]) -> Option<(usize, usize)> {
        self.stats.identify_reads += 1;
        let p = &self.params;
        let ratios = cell_ratios(grey, corners, &p.cells, &mut self.scratch)?;
        let max_border_errors = ((MARKER_SIZE * MARKER_SIZE) as f64 * p.max_erroneous_bits_in_border_rate) as i32;

        if border_errors(&ratios, p.valid_bit_threshold) > max_border_errors {
            return None;
        }

        // With errorCorrectionRate x maxCorrectionBits < 1 no bit error is allowed, and the
        // look-up table is exact; more would need a nearest-code search, which no scanner
        // parameter asks for.
        debug_assert!(((MAX_CORRECTION_BITS as f64) * p.error_correction_rate) < 1.0);
        identify(&inner_cells(&ratios), p.valid_bit_threshold, &self.table)
    }

    /// detectMarkers: the board markers found in `grey` (in OpenCV's order), and the rejected
    /// candidates (for refine_detected_markers).
    pub fn detect_markers(&mut self, grey: &Gray) -> (Vec<Marker>, Vec<[Pt; 4]>) {
        let raw = self.initial_candidates(grey);
        self.stats = DetectStats { raw: raw.len(), ..DetectStats::default() };
        let mut selected = self.filter_too_close(grey.width, grey.height, raw);
        let n = selected.len();
        self.stats.selected = n;
        let mut result: Vec<Option<(usize, usize)>> = vec![None; n];
        let mut was = vec![false; n];
        let max_depth = selected.iter().map(|c| c.depth).max().unwrap_or(0) as usize;
        let mut depths: Vec<Vec<usize>> = vec![Vec::new(); max_depth + 1];

        for (i, c) in selected.iter().enumerate() {
            depths[c.depth as usize].push(i);
        }

        let mut depth = 0;
        let mut counter = 0;

        while counter < n {
            for &v in &depths[depth] {
                was[v] = true;
                let corners = selected[v].corners;
                result[v] = self.identify_one(grey, &corners);

                // OpenCV tries the group's other contours (the same quad found by other threshold
                // windows, kept when they differ by over 0.21 of a cell) when the largest fails. The
                // phone's fast path does not (T-0332): on whole-board views most failing groups are
                // the black chessboard squares, each read again for every window that found it.
                if result[v].is_none() && self.params.retry_close {
                    for k in 0..selected[v].close.len() {
                        let close = selected[v].close[k];

                        if let Some(found) = self.identify_one(grey, &close) {
                            result[v] = Some(found);
                            selected[v].corners = close;
                            break;
                        }
                    }
                }
            }

            // Parents of found markers count as visited.
            for &v in &depths[depth] {
                if result[v].is_some() {
                    let mut parent = selected[v].parent;

                    while parent != -1 {
                        if !was[parent as usize] {
                            was[parent as usize] = true;
                            counter += 1;
                        }

                        parent = selected[parent as usize].parent;
                    }
                }

                counter += 1;
            }

            depth += 1;

            if depth >= depths.len() {
                break;
            }
        }

        let mut accepted = Vec::new();
        let mut rejected = Vec::new();

        for (c, r) in selected.into_iter().zip(result) {
            match r {
                Some((id, rotation)) => {
                    // correctCornerPosition: std::rotate by 4 - rotation.
                    let k = (4 - rotation) % 4;
                    let mut corners = c.corners;
                    corners.rotate_left(k);
                    accepted.push(Marker { id, corners });
                }
                None => rejected.push(c.corners),
            }
        }

        (accepted, rejected)
    }

    /// refineDetectedMarkers with a global homography (no camera matrix): looks for each board
    /// marker not yet found among the rejected candidates near where the found markers put it.
    /// `board_corners[id]` are marker `id`'s corners on the board (any planar unit). Appends what
    /// it recovers to `markers` (and removes it from `rejected`).
    pub fn refine_detected_markers(&mut self, grey: &Gray, board_corners: &[[Pt; 4]], markers: &mut Vec<Marker>, rejected: &mut Vec<[Pt; 4]>) {
        if markers.is_empty() || rejected.is_empty() {
            return;
        }

        // _projectUndetectedMarkers: one homography from all found markers' corners.
        let mut obj = Vec::new();
        let mut img = Vec::new();
        let mut undetected = Vec::new();

        for (id, corners) in board_corners.iter().enumerate() {
            match markers.iter().find(|m| m.id == id) {
                Some(m) => {
                    for c in 0..4 {
                        obj.push((corners[c].x as f64, corners[c].y as f64));
                        img.push((m.corners[c].x as f64, m.corners[c].y as f64));
                    }
                }
                None => undetected.push(id),
            }
        }

        let Some(h) = fit_homography(&obj, &img) else { return };
        let projected: Vec<[Pt; 4]> = undetected.iter().map(|&id| {
            let mut p = [Pt::default(); 4];

            for c in 0..4 {
                p[c] = transform(&h, board_corners[id][c]);
            }

            p
        }).collect();

        let refine = self.refine.clone();
        let max_correction = (MAX_CORRECTION_BITS as f64 * refine.error_correction_rate as f64) as i32;
        let mut identified = vec![false; rejected.len()];
        let threshold = self.params.valid_bit_threshold;
        let cells = self.params.cells;
        // A speed-up that changes no result (T-0332): whatever the pairing of the corners, the
        // largest corner distance is at least the distance between the two quads' centres, so a
        // candidate whose centre is further than the search radius cannot qualify, and its four
        // pairings need not be tried. (With slack for float rounding; anything near is tested as
        // OpenCV tests it.)
        let rejected_centres: Vec<Pt> = rejected.iter().map(centre).collect();
        let local = self.params.local_refine && markers.len() >= LOCAL_MIN_MARKERS;

        for (u, &id) in undetected.iter().enumerate() {
            let mut closest_idx: i64 = -1;
            // local_refine (T-0332): search only within LOCAL_RADIUS of the projected marker's own
            // side. OpenCV's fixed radius (40 px x m) takes in the neighbouring squares of the
            // small, packed markers far off on a whole-board view, each read for nothing. Only with
            // LOCAL_MIN_MARKERS found: from fewer (a blurred view), the homography that places the
            // missed markers is too rough for the tighter radius (measured: a blurred region of a
            // whole-board view kept 4 corners instead of 103).
            let radius = if local {
                refine.min_rep_distance.min(LOCAL_RADIUS * perimeter(&projected[u]) / 4.0)
            } else {
                refine.min_rep_distance
            };
            let mut closest_dist = (radius * radius) as f64 + 1.0;
            let mut closest_rotated = [Pt::default(); 4];
            let projected_centre = centre(&projected[u]);

            for (j, rej) in rejected.iter().enumerate() {
                if identified[j] {
                    continue;
                }

                if ((rejected_centres[j] - projected_centre).norm_sqr() as f64) > closest_dist * (1.0 + 1e-4) + 1e-3 {
                    continue;
                }

                let mut min_distance = closest_dist + 1.0;
                let mut valid = false;
                let mut valid_rot = 0;

                for c in 0..4 {
                    let mut current_max = 0f64;

                    for k in 0..4 {
                        let d = projected[u][k] - rej[(c + k) % 4];
                        current_max = current_max.max(d.norm_sqr() as f64);
                    }

                    if current_max < closest_dist {
                        valid = true;
                        valid_rot = c;
                        min_distance = current_max;
                    }

                    if !refine.check_all_orders {
                        break;
                    }
                }

                if !valid {
                    continue;
                }

                let mut rotated = *rej;

                if refine.check_all_orders {
                    for c in 0..4 {
                        rotated[c] = rej[(c + 4 + valid_rot) % 4];
                    }
                }

                let mut code_distance = 0;

                if refine.error_correction_rate >= 0.0 {
                    self.stats.refine_reads += 1;
                    let Some(ratios) = cell_ratios(grey, &rotated, &cells, &mut self.scratch) else { continue };
                    code_distance = distance_to_id(&inner_cells(&ratios), id, threshold);
                }

                if refine.error_correction_rate < 0.0 || code_distance < max_correction {
                    closest_idx = j as i64;
                    closest_dist = min_distance;
                    closest_rotated = rotated;
                }
            }

            if closest_idx >= 0 {
                identified[closest_idx as usize] = true;
                markers.push(Marker { id, corners: closest_rotated });
            }
        }

        let mut k = 0;
        rejected.retain(|_| {
            k += 1;
            !identified[k - 1]
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quad(x: f32, y: f32, s: f32) -> [Pt; 4] {
        [Pt::new(x, y), Pt::new(x + s, y), Pt::new(x + s, y + s), Pt::new(x, y + s)]
    }

    // OpenCV's filterTooCloseCandidates pairing loop, every pair compared: the reference the
    // sweep is checked against.
    fn brute_force_pairs(tree: &[[Pt; 4]], rate: f32) -> Vec<(usize, usize)> {
        let mut pairs = Vec::new();

        for i in 0..tree.len() {
            for j in i + 1..tree.len() {
                if average_distance(&tree[i], &tree[j]) < perimeter(&tree[j]) * rate {
                    pairs.push((i, j));
                }
            }
        }

        pairs
    }

    #[test]
    fn near_duplicate_candidates_are_grouped_and_the_largest_kept() {
        // Setup: three candidates for one marker as different thresholds find it (sizes 40, 39
        // and 38 px, concentric), a separate marker elsewhere, and one candidate touching the
        // image border.
        // Test: filter_too_close on a 200 x 200 frame.
        // Verifies: the three near-duplicates become one group, represented by the largest (the
        // other two kept as its close contours only when they differ by more than 0.21 of a
        // module, here the 38 px one); the separate marker stays; the border one is dropped
        // (minDistanceToBorder 3 px).
        let det = ArucoDetector::new(195);
        let raw = vec![quad(50.5, 50.5, 39.0), quad(50.0, 50.0, 40.0), quad(51.0, 51.0, 38.0), quad(120.0, 120.0, 30.0), quad(1.0, 100.0, 30.0)];
        let out = det.filter_too_close(200, 200, raw);
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(out[0].corners, quad(50.0, 50.0, 40.0));
        assert_eq!(out[0].close.len(), 1);
        assert_eq!(out[1].corners, quad(120.0, 120.0, 30.0));
    }

    #[test]
    fn the_centre_sweep_finds_exactly_the_pairs_opencvs_loop_finds() {
        // Setup: 400 pseudo-random quadrilaterals (sizes 10-80 px, slightly skewed) packed into a
        // 400 x 400 area so that many overlap, sorted by perimeter as the detector sorts them.
        // Test: close_pairs (the sweep filter_too_close uses) against OpenCV's all-pairs loop,
        // re-implemented directly.
        // Verifies: the speed-up changes nothing: the same (i, j) pairs, in the same order.
        let mut state = 7u32;
        let mut rnd = || {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            (state >> 8) as f32 / 16_777_216.0
        };
        let mut tree: Vec<[Pt; 4]> = (0..400).map(|_| {
            let (x, y, s) = (rnd() * 400.0, rnd() * 400.0, 10.0 + rnd() * 70.0);
            let mut q = quad(x, y, s);
            q[2].x += rnd() * 4.0 - 2.0;
            q[3].y += rnd() * 4.0 - 2.0;
            q
        }).collect();
        tree.sort_by(|a, b| perimeter(b).partial_cmp(&perimeter(a)).unwrap());
        let expected = brute_force_pairs(&tree, 0.125);
        assert!(expected.len() > 20, "too few overlapping pairs ({}) to test anything", expected.len());

        let perimeters: Vec<f32> = tree.iter().map(perimeter).collect();
        let found: Vec<(usize, usize)> = close_pairs(&tree, &perimeters, 0.125).into_iter().enumerate()
            .flat_map(|(i, js)| js.into_iter().map(move |j| (i, j))).collect();
        assert_eq!(found, expected);
    }

    #[test]
    fn a_drawn_board_marker_is_detected_with_its_corners_turned_to_its_printed_top_left() {
        // Setup: marker 23 drawn with 12 px cells on paper in a 160 x 140 frame, and a strip-board
        // detector (195 markers).
        // Test: detect_markers.
        // Verifies: one marker, id 23, whose first corner is the marker's printed top-left and
        // whose corners go clockwise, on the black border's outer pixels (OpenCV's integer
        // contour corners: the drawn square spans pixels 40..111 and 30..101).
        let img = crate::marker::tests::draw_marker(160, 140, 23, 40, 30, 12);
        let mut det = ArucoDetector::new(195);
        let (markers, _) = det.detect_markers(&img);
        assert_eq!(markers.len(), 1, "{markers:?}");
        assert_eq!(markers[0].id, 23);
        assert_eq!(markers[0].corners, [Pt::new(40.0, 30.0), Pt::new(111.0, 30.0), Pt::new(111.0, 101.0), Pt::new(40.0, 101.0)]);
    }
}
