// The ChArUco board and its chessboard corners: where each marker and corner is on the board, and
// how the detector turns found markers into sub-pixel chessboard corners.
//
// Ported from OpenCV 4.14.0 modules/objdetect/src/aruco/aruco_board.cpp (CharucoBoardImpl::
// createCharucoBoard and calcNearestMarkerCorners, the current -- non-legacy -- pattern only:
// square (0, 0) is black and markers sit on the white squares, numbered row-major) and
// modules/objdetect/src/aruco/charuco_detector.cpp (interpolateCornersCharucoLocalHom: each
// corner through the homographies of its two neighbouring markers, averaged;
// getMaximumSubPixWindowSizes: a refinement window stopping 2 px short of the nearest marker
// corner, at most 21 x 21; selectAndRefineChessboardCorners: corners 2 px inside the image,
// cornerSubPix with a zero zone of 0 and (30 iterations, 0.1 px); filterCornersWithoutMinMarkers).
// The board is in squares (square side 1), as the scanner's board.py makes it, and in single
// precision, as OpenCV stores it.
//
// The specialisation: OpenCV's detectBoard interpolates and refines once per call, and the scanner
// calls it twice per frame on the same markers (minMarkers 2, then 1). The corners and their
// positions are the same both times, so here they are interpolated and refined once, and each
// corner is tagged with how many of its two markers were found.
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

use crate::aruco::Marker;
use crate::gray::Gray;
use crate::linalg::{det3, perspective_from_quads, transform, Pt};
use crate::subpix::{Criteria, SubPix};

/// A ChArUco board in the current pattern, square side 1.
pub struct CharucoBoard {
    pub squares_x: usize,
    pub squares_y: usize,
    /// Marker id -> its corners on the board (clockwise from the marker's top-left).
    pub marker_corners: Vec<[Pt; 4]>,
    /// Chessboard corner id -> its position on the board (row-major inner corners).
    pub chessboard: Vec<Pt>,
    /// Per corner, the markers nearest to it (its two diagonal white squares), and which of
    /// each marker's corners is nearest.
    pub nearest_markers: Vec<Vec<usize>>,
    pub nearest_marker_corners: Vec<Vec<usize>>,
}

impl CharucoBoard {
    /// A `squares_x` x `squares_y` board with markers `marker_length` squares wide.
    pub fn new(squares_x: usize, squares_y: usize, marker_length: f32) -> CharucoBoard {
        let square = 1.0f32;
        let diff = (square - marker_length) / 2.0;
        let mut marker_corners = Vec::new();

        for y in 0..squares_y {
            for x in 0..squares_x {
                if y % 2 == x % 2 {
                    continue; // black square, no marker
                }

                let c0 = Pt::new(x as f32 * square + diff, y as f32 * square + diff);
                marker_corners.push([
                    c0,
                    c0 + Pt::new(marker_length, 0.0),
                    c0 + Pt::new(marker_length, marker_length),
                    c0 + Pt::new(0.0, marker_length),
                ]);
            }
        }

        let mut chessboard = Vec::new();

        for y in 0..squares_y - 1 {
            for x in 0..squares_x - 1 {
                chessboard.push(Pt::new((x + 1) as f32 * square, (y + 1) as f32 * square));
            }
        }

        // calcNearestMarkerCorners.
        let tolerance = (0.01 * square as f64).powi(2);
        let mut nearest_markers = vec![Vec::new(); chessboard.len()];
        let mut nearest_marker_corners = vec![Vec::new(); chessboard.len()];

        for (i, corner) in chessboard.iter().enumerate() {
            let mut min_dist = -1.0f64;

            for (j, m) in marker_corners.iter().enumerate() {
                let mut sx = 0f32;
                let mut sy = 0f32;

                for p in m {
                    sx += p.x;
                    sy += p.y;
                }

                let centre = Pt::new((sx as f64 / 4.0) as f32, (sy as f64 / 4.0) as f32);
                let d = *corner - centre;
                let sq = d.norm_sqr() as f64;

                if j == 0 || (sq - min_dist).abs() < tolerance {
                    nearest_markers[i].push(j);
                    min_dist = sq;
                } else if sq < min_dist {
                    nearest_markers[i].clear();
                    nearest_markers[i].push(j);
                    min_dist = sq;
                }
            }

            for &j in &nearest_markers[i] {
                let mut best = 0;
                let mut best_dist = -1.0f64;

                for (k, p) in marker_corners[j].iter().enumerate() {
                    let sq = (*corner - *p).norm_sqr() as f64;

                    if k == 0 || sq < best_dist {
                        best_dist = sq;
                        best = k;
                    }
                }

                nearest_marker_corners[i].push(best);
            }
        }

        CharucoBoard { squares_x, squares_y, marker_corners, chessboard, nearest_markers, nearest_marker_corners }
    }

    pub fn marker_count(&self) -> usize {
        self.marker_corners.len()
    }
}

/// An interpolated, refined chessboard corner: its id, its position (OpenCV pixel-centre
/// coordinates) and how many of its neighbouring markers were found (1 or 2).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Corner {
    pub id: usize,
    pub pos: Pt,
    pub markers: u8,
}

/// The cornerSubPix windows the ChArUco detector uses, by half-size (1..10), built once.
pub struct CornerRefiner {
    windows: Vec<SubPix>,
}

impl Default for CornerRefiner {
    fn default() -> Self {
        CornerRefiner { windows: (1..=10).map(|w| SubPix::new(w, Some(0))).collect() }
    }
}

/// The detector's cornerRefinementWinSize (OpenCV's default), used when no marker bounds the
/// window -- which cannot happen for a corner that was interpolated.
const DEFAULT_WINDOW: usize = 5;

/// interpolateCornersCharucoLocalHom + selectAndRefineChessboardCorners + the minMarkers count:
/// every chessboard corner next to at least one found marker, refined, in id order.
pub fn interpolate_corners(board: &CharucoBoard, markers: &[Marker], grey: &Gray, refiner: &mut CornerRefiner) -> Vec<Corner> {
    // The detected index of each board marker (the first, if a marker was found twice).
    let mut index = vec![usize::MAX; board.marker_count()];

    for (i, m) in markers.iter().enumerate() {
        if m.id < index.len() && index[m.id] == usize::MAX {
            index[m.id] = i;
        }
    }

    // Each found marker's homography from the board, and whether it is usable (|det| > 1e-6).
    let homographies: Vec<Option<[f64; 9]>> = markers.iter().map(|m| {
        if m.id >= board.marker_count() {
            return None;
        }

        perspective_from_quads(&board.marker_corners[m.id], &m.corners).filter(|h| det3(h).abs() > 1e-6)
    }).collect();

    let inner = |p: Pt| p.x >= 2.0 && p.x < (grey.width - 2) as f32 && p.y >= 2.0 && p.y < (grey.height - 2) as f32;
    let criteria = Criteria { max_iters: 30, eps: 0.1 };
    let mut out = Vec::new();

    for (k, &corner) in board.chessboard.iter().enumerate() {
        let near = &board.nearest_markers[k];
        let mut positions: Vec<Pt> = Vec::with_capacity(2);
        let mut found = 0u8;

        for &j in near {
            let i = index[j];

            if i == usize::MAX {
                continue;
            }

            found += 1;

            if let Some(h) = &homographies[i] {
                positions.push(transform(h, corner));
            }
        }

        if positions.is_empty() {
            continue;
        }

        let pos = if positions.len() > 1 {
            let s = positions[0] + positions[1];
            Pt::new((s.x as f64 / 2.0) as f32, (s.y as f64 / 2.0) as f32)
        } else {
            positions[0]
        };

        if !inner(pos) {
            continue;
        }

        // getMaximumSubPixWindowSizes: 2 px short of the nearest found marker corner, 1..10.
        let mut min_dist = -1.0f64;

        for (n, &j) in near.iter().enumerate() {
            let i = index[j];

            if i == usize::MAX {
                continue;
            }

            let d = markers[i].corners[board.nearest_marker_corners[k][n]] - pos;
            let dist = ((d.x as f64) * (d.x as f64) + (d.y as f64) * (d.y as f64)).sqrt();
            min_dist = if min_dist == -1.0 { dist } else { min_dist.min(dist) };
        }

        let win = if min_dist < 0.0 { DEFAULT_WINDOW } else { ((min_dist - 2.0) as i32).clamp(1, 10) as usize };
        let refined = refiner.windows[win - 1].refine(grey, pos, criteria);
        out.push(Corner { id: k, pos: refined, markers: found });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_strip_board_has_opencvs_marker_and_corner_layout() {
        // Setup: the strip sheet's board, 23 x 17 squares, markers 0.7 of a square.
        // Test: build it.
        // Verifies: 195 markers (the white squares: 391 squares, 196 of them black, since square
        // (0, 0) is black) numbered row-major, marker 0 on square (row 0,
        // column 1) and centred in it; 22 x 16 = 352 inner corners, corner k at column k % 22 + 1,
        // row k / 22 + 1; and every corner's two nearest markers are its diagonal white squares,
        // with the marker corner nearest to it (corner 0, at (1, 1): marker 0's bottom-left and
        // marker 11's top-right).
        let board = CharucoBoard::new(23, 17, 0.7);
        assert_eq!(board.marker_count(), 195);
        assert_eq!(board.chessboard.len(), 352);
        let m0 = board.marker_corners[0];
        assert!((m0[0].x - 1.15).abs() < 1e-6 && (m0[0].y - 0.15).abs() < 1e-6);
        assert_eq!(board.chessboard[23], Pt::new(2.0, 2.0));

        // Corner 0 at (1, 1): white squares (row 0, col 1) = marker 0 and (row 1, col 0) =
        // marker 11 (row 0 has 11 white squares, columns 1, 3, ..., 21).
        assert_eq!(board.nearest_markers[0], vec![0, 11]);
        // Marker 0's nearest corner is its bottom-left (3); marker 11's its top-right (1).
        assert_eq!(board.nearest_marker_corners[0], vec![3, 1]);
        assert!(board.nearest_markers.iter().all(|n| n.len() == 2));
    }

    #[test]
    fn corners_are_interpolated_between_their_markers_and_tagged_by_marker_count() {
        // Setup: the board seen straight on at 30 px per square, offset (15, 10): every board
        // point (u, v) is at pixel (30 u + 15, 30 v + 10). Markers 0 and 11 (both neighbours of
        // corner 0) and marker 1 (one neighbour of corner 1 and corner 2) are "found" exactly
        // there; the image is a plain grey, so cornerSubPix has no gradient and leaves corners
        // where interpolation put them.
        // Test: interpolate_corners.
        // Verifies: corner 0 (board (1, 1), between markers 0 and 11) at (45, 40) with 2 markers;
        // the corners with only one found neighbour -- 1 (markers 0, 12), 2 and 3 (marker 1 with
        // 12 or 13), 22 (marker 11 with 23) -- with 1 marker each (the second pass's corners),
        // corner 1 at (75, 40) and corner 2 at (105, 40); and nothing else.
        let board = CharucoBoard::new(23, 17, 0.7);
        let px = |p: Pt| Pt::new(30.0 * p.x + 15.0, 30.0 * p.y + 10.0);
        let found = |id: usize| Marker { id, corners: board.marker_corners[id].map(px) };
        let markers = vec![found(0), found(11), found(1)];
        let grey = Gray::filled(400, 300, 128);
        let mut refiner = CornerRefiner::default();
        let corners = interpolate_corners(&board, &markers, &grey, &mut refiner);
        let summary: Vec<(usize, u8)> = corners.iter().map(|c| (c.id, c.markers)).collect();
        assert_eq!(summary, vec![(0, 2), (1, 1), (2, 1), (3, 1), (22, 1)]);
        assert!((corners[1].pos - Pt::new(75.0, 40.0)).norm_sqr() < 1e-6);
        assert!((corners[0].pos - Pt::new(45.0, 40.0)).norm_sqr() < 1e-6);
        assert!((corners[2].pos - Pt::new(105.0, 40.0)).norm_sqr() < 1e-6);
    }
}
