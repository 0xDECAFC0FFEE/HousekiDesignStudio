// Reading a marker candidate's bits: aruco_detector.cpp _extractCellPixelRatio and the threshold
// it uses.
//
// The candidate quadrilateral is warped to a square of (4 + 2) x pixelsPerCell pixels with
// nearest-neighbour sampling, binarised with Otsu's threshold (unless it is nearly uniform), and
// each cell's white ratio is counted over the cell less a margin. Ported from OpenCV 4.14.0
// modules/objdetect/src/aruco/aruco_detector.cpp (_extractCellPixelRatio, _getBorderErrors),
// modules/imgproc/src/imgwarp.cpp (warpPerspective with INTER_NEAREST: the inverse map, the
// per-row block origin and the round-to-even of hal::warpPerspectiveBlocklineNN's scalar path,
// which opencv.js runs because WebAssembly has no CV_SIMD128_64F) and
// modules/imgproc/src/thresh.cpp (getThreshVal_Otsu), so the ratios are opencv.js's.
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

use crate::gray::Gray;
use crate::linalg::{invert3, perspective_from_quads, Pt};

/// Cells per side, the 4 x 4 bits plus a one-cell border.
pub const CELLS: usize = 6;

/// How a candidate's cells are read (DetectorParameters fields).
#[derive(Clone, Copy, Debug)]
pub struct CellParams {
    /// perspectiveRemovePixelPerCell (8 for the desktop's tuning).
    pub pixel_per_cell: usize,
    /// perspectiveRemoveIgnoredMarginPerCell (0.3).
    pub margin_rate: f64,
    /// minOtsuStdDev (5.0).
    pub min_otsu_std: f64,
}

/// warpPerspective(grey, dst, M, (size, size), INTER_NEAREST, BORDER_CONSTANT 0) where M maps the
/// candidate's corners to the square's: every square pixel looks up the frame pixel M⁻¹ puts it
/// on.
fn warp_nearest(grey: &Gray, corners: &[Pt; 4], size: usize, out: &mut Vec<u8>) -> bool {
    let last = (size - 1) as f32;
    let square = [Pt::new(0.0, 0.0), Pt::new(last, 0.0), Pt::new(last, last), Pt::new(0.0, last)];
    let Some(m) = perspective_from_quads(corners, &square) else { return false };
    let Some(m) = invert3(&m) else { return false };
    out.clear();
    out.resize(size * size, 0);
    let (w, h) = (grey.width as i64, grey.height as i64);

    // Per row: the samples' coordinates in one pure floating-point loop (it vectorises: f64x2 on
    // wasm), then rounding and range checks, then the reads. OpenCV clamps to int, rounds to even
    // and saturates to short; a sample outside the frame reads BORDER_CONSTANT 0, so all that
    // matters is which in-frame pixel, if any, it rounds to.
    let xs: [f64; 64] = std::array::from_fn(|x| x as f64);
    let mut fx = [0f64; 64];
    let mut fy = [0f64; 64];

    for y in 0..size {
        // WarpPerspectiveInvoker's block origin x is 0 for a square this small.
        let yf = y as f64;
        let x0 = m[0] * 0.0 + m[1] * yf + m[2];
        let y0 = m[3] * 0.0 + m[4] * yf + m[5];
        let w0 = m[6] * 0.0 + m[7] * yf + m[8];

        for x1 in 0..size {
            let xf = xs[x1];
            let ww = w0 + m[6] * xf;
            let ww = if ww != 0.0 { 1.0 / ww } else { 0.0 };
            fx[x1] = (x0 + m[0] * xf) * ww;
            fy[x1] = (y0 + m[3] * xf) * ww;
        }

        for x1 in 0..size {
            let sx = (fx[x1].clamp(i32::MIN as f64, i32::MAX as f64).round_ties_even() as i64).clamp(i16::MIN as i64, i16::MAX as i64);
            let sy = (fy[x1].clamp(i32::MIN as f64, i32::MAX as f64).round_ties_even() as i64).clamp(i16::MIN as i64, i16::MAX as i64);

            if sx >= 0 && sx < w && sy >= 0 && sy < h {
                out[y * size + x1] = grey.data[(sy * w + sx) as usize];
            }
        }
    }

    true
}

/// getThreshVal_Otsu for 8-bit pixels (OpenCV's floating-point sweep, its skips included).
pub fn otsu_threshold(pixels: &[u8]) -> f64 {
    let mut hist = [0i32; 256];

    for &p in pixels {
        hist[p as usize] += 1;
    }

    let scale = 1.0 / pixels.len() as f64;
    let mut mu = 0.0;

    for (i, &count) in hist.iter().enumerate() {
        mu += i as f64 * count as f64;
    }

    mu *= scale;
    let (mut mu1, mut q1) = (0.0f64, 0.0f64);
    let (mut max_sigma, mut max_val) = (0.0f64, 0.0f64);
    // Only the bins from the first to the last non-empty one can change anything: before the
    // first, q1 stays 0 (OpenCV's guard skips them, mu1 stays 0); after the last, q2 is 0 to
    // rounding (skipped again). So the sweep is OpenCV's, bit for bit, on fewer bins.
    let first = hist.iter().position(|&c| c != 0).unwrap_or(0);
    let last = hist.iter().rposition(|&c| c != 0).unwrap_or(0);

    for (i, &count) in hist.iter().enumerate().take(last + 1).skip(first) {
        let p_i = count as f64 * scale;
        mu1 *= q1;
        q1 += p_i;
        let q2 = 1.0 - q1;

        if q1.min(q2) < f32::EPSILON as f64 || q1.max(q2) > 1.0 - f32::EPSILON as f64 {
            continue;
        }

        mu1 = (mu1 + i as f64 * p_i) / q1;
        let mu2 = (mu - q1 * mu1) / q2;
        let sigma = q1 * q2 * (mu1 - mu2) * (mu1 - mu2);

        if sigma > max_sigma {
            max_sigma = sigma;
            max_val = i as f64;
        }
    }

    max_val
}

/// _extractCellPixelRatio: the white ratio (0..1) of each of the 6 x 6 cells of the candidate,
/// row-major, or None when its perspective cannot be computed. `scratch` is reused across calls.
pub fn cell_ratios(grey: &Gray, corners: &[Pt; 4], params: &CellParams, scratch: &mut Vec<u8>) -> Option<[f32; CELLS * CELLS]> {
    let cell = params.pixel_per_cell;
    let size = CELLS * cell;

    if !warp_nearest(grey, corners, size, scratch) {
        return None;
    }

    let mut ratios = [0f32; CELLS * CELLS];

    // meanStdDev over the square less half a cell all round (perspective noise at the edge).
    let lo = cell / 2;
    let hi = size - cell / 2;
    let (mut sum, mut sqsum) = (0f64, 0f64);

    for y in lo..hi {
        for &v in &scratch[y * size + lo..y * size + hi] {
            sum += v as f64;
            sqsum += (v as f64) * (v as f64);
        }
    }

    let n = ((hi - lo) * (hi - lo)) as f64;
    let mean = sum / n;
    let std = (sqsum / n - mean * mean).max(0.0).sqrt();

    if std < params.min_otsu_std {
        // All one colour: black or white by the mean.
        let value = if mean > 127.0 { 1.0 } else { 0.0 };
        ratios.iter_mut().for_each(|r| *r = value);
        return Some(ratios);
    }

    // threshold(THRESH_BINARY | THRESH_OTSU): white where the pixel exceeds floor(Otsu).
    let t = otsu_threshold(scratch).floor() as i32;
    let margin = (params.margin_rate * cell as f64) as usize;
    let inner = cell - 2 * margin;
    let total = (inner * inner) as f32;

    for cy in 0..CELLS {
        for cx in 0..CELLS {
            let mut nz = 0usize;

            for y in cy * cell + margin..cy * cell + margin + inner {
                let row = &scratch[y * size..];

                for &v in &row[cx * cell + margin..cx * cell + margin + inner] {
                    nz += (v as i32 > t) as usize;
                }
            }

            ratios[cy * CELLS + cx] = nz as f32 / total;
        }
    }

    Some(ratios)
}

/// _getBorderErrors with detectInvertedMarker off: border cells that read white (ratio above
/// the bit threshold) when they should be black.
pub fn border_errors(ratios: &[f32; CELLS * CELLS], threshold: f32) -> i32 {
    let mut errors = 0;

    for y in 0..CELLS {
        for x in 0..CELLS {
            let border = x == 0 || y == 0 || x == CELLS - 1 || y == CELLS - 1;

            if border && ratios[y * CELLS + x] > threshold {
                errors += 1;
            }
        }
    }

    errors
}

/// The 4 x 4 inner cells of a 6 x 6 ratio grid, row-major.
pub fn inner_cells(ratios: &[f32; CELLS * CELLS]) -> [f32; 16] {
    let mut out = [0f32; 16];

    for y in 0..4 {
        for x in 0..4 {
            out[y * 4 + x] = ratios[(y + 1) * CELLS + x + 1];
        }
    }

    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::dictionary::{identify, MarkerTable, DICT_4X4_250};

    // A marker drawn axis-aligned: `cell` px per cell, ink 30, paper 220, at (x0, y0), on paper.
    pub(crate) fn draw_marker(width: usize, height: usize, id: usize, x0: usize, y0: usize, cell: usize) -> Gray {
        let mut img = Gray::filled(width, height, 220);
        let code = DICT_4X4_250[id];

        for cy in 0..6 {
            for cx in 0..6 {
                let border = cx == 0 || cy == 0 || cx == 5 || cy == 5;
                let white = !border && (code >> (15 - ((cy - 1) * 4 + cx - 1))) & 1 == 1;

                for y in 0..cell {
                    for x in 0..cell {
                        img.data[(y0 + cy * cell + y) * width + x0 + cx * cell + x] = if white { 220 } else { 30 };
                    }
                }
            }
        }

        img
    }

    #[test]
    fn otsu_splits_two_levels_between_them() {
        // Setup: pixels at 30 (ink) and 220 (paper), in equal numbers, plus a few in between.
        // Test: otsu_threshold.
        // Verifies: the threshold lands at the dark class's top grey (OpenCV returns the last
        // grey of the lower class), so ink reads black and paper white whatever the exposure.
        let mut px = vec![30u8; 500];
        px.extend(vec![220u8; 500]);
        px.extend([100, 120, 140]);
        let t = otsu_threshold(&px);
        assert!((30.0..220.0).contains(&t), "{t}");
    }

    #[test]
    fn a_drawn_marker_reads_back_its_bits_and_id_in_each_rotation() {
        // Setup: marker 97 drawn with 10 px cells (60 px wide) on paper, and its outer corners
        // listed starting from each of its four corners in turn (clockwise in image space), as a
        // contour may start anywhere.
        // Test: cell_ratios with the desktop's parameters (8 px per cell, 30% margin), then the
        // border error count and identify on the inner cells.
        // Verifies: the border is all black (0 errors); the inner bits identify marker 97, with a
        // rotation that tells how the corner list was turned -- the 0/1 ratios of a clean marker
        // and the warp's corner convention (corner k to the square's corner k).
        let img = draw_marker(100, 100, 97, 20, 20, 10);
        let c = [Pt::new(20.0, 20.0), Pt::new(79.0, 20.0), Pt::new(79.0, 79.0), Pt::new(20.0, 79.0)];
        let params = CellParams { pixel_per_cell: 8, margin_rate: 0.3, min_otsu_std: 5.0 };
        let table = MarkerTable::for_ids(195);
        let mut scratch = Vec::new();
        let mut rotations = Vec::new();

        for start in 0..4 {
            let corners = [c[start], c[(start + 1) % 4], c[(start + 2) % 4], c[(start + 3) % 4]];
            let ratios = cell_ratios(&img, &corners, &params, &mut scratch).unwrap();
            assert_eq!(border_errors(&ratios, 0.49), 0);
            let (id, r) = identify(&inner_cells(&ratios), 0.49, &table).unwrap();
            assert_eq!(id, 97);
            rotations.push(r);
        }

        rotations.sort();
        assert_eq!(rotations, vec![0, 1, 2, 3]);
    }

    #[test]
    fn a_uniform_patch_reads_as_all_black_or_all_white() {
        // Setup: a plain paper image and a plain ink image, and a candidate square on each.
        // Test: cell_ratios.
        // Verifies: below minOtsuStdDev every cell is 1 (bright) or 0 (dark), as OpenCV does,
        // so a blank square fails on its border (36 x white) and a black square on its bits.
        let params = CellParams { pixel_per_cell: 8, margin_rate: 0.3, min_otsu_std: 5.0 };
        let corners = [Pt::new(10.0, 10.0), Pt::new(50.0, 10.0), Pt::new(50.0, 50.0), Pt::new(10.0, 50.0)];
        let mut scratch = Vec::new();
        let paper = cell_ratios(&Gray::filled(64, 64, 220), &corners, &params, &mut scratch).unwrap();
        assert!(paper.iter().all(|&r| r == 1.0));
        assert_eq!(border_errors(&paper, 0.49), 20);
        let ink = cell_ratios(&Gray::filled(64, 64, 30), &corners, &params, &mut scratch).unwrap();
        assert!(ink.iter().all(|&r| r == 0.0));
    }
}
