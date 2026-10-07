// How sharp the image is around a chessboard corner: the desktop scanner's corner_sharpness
// (HousekiScanner calibrate.py), the variance of the Laplacian in the 25 x 25 px window around the
// corner on the frame resampled to a 1080 px short side, as board_detect.js computed it with
// opencv.js: the window's neighbourhood resized with INTER_AREA when the frame is not at the
// reference scale (resize.rs), cv.Laplacian (ksize 1: the 4-neighbour kernel, BORDER_REFLECT_101;
// on the frame itself the neighbours outside the window are real pixels, as for an OpenCV ROI),
// then meanStdDev's population variance.
//
// The Laplacian kernel and meanStdDev follow OpenCV 4.14.0 modules/imgproc/src/deriv.cpp and
// modules/core/src/mean.dispatch.cpp; the windowing is board_detect.js's (this project).
//
// Copyright (C) 2000-2022, Intel Corporation, all rights reserved.
// Copyright (C) 2015-2023, OpenCV Foundation, all rights reserved.
// (and the other OpenCV copyright holders listed in NOTICE)
// Copyright 2026 Lucas Tong (the port, and the windowing)
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or agreed to in
// writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
// specific language governing permissions and limitations under the License.

use crate::gray::Gray;
use crate::resize::resize_area_region;

/// Half the measuring window (25 x 25 px at the reference scale).
const HALF: i64 = 12;

/// JavaScript's Math.round: halves round up.
#[inline]
pub fn js_round(v: f64) -> i64 {
    (v + 0.5).floor() as i64
}

/// Python's round: halves to even.
#[inline]
pub fn py_round(v: f64) -> i64 {
    v.round_ties_even() as i64
}

#[inline]
fn reflect101(i: i64, n: i64) -> usize {
    if n == 1 {
        return 0;
    }

    let mut i = i;

    if i < 0 {
        i = -i;
    }

    if i >= n {
        i = 2 * n - 2 - i;
    }

    i as usize
}

/// The 4-neighbour Laplacian at (x, y) of a `w` x `h` image, BORDER_REFLECT_101.
#[inline]
fn laplacian<F: Fn(usize, usize) -> u8>(px: &F, w: i64, h: i64, x: i64, y: i64) -> f32 {
    let c = px(x as usize, y as usize) as f32;
    let l = px(reflect101(x - 1, w), y as usize) as f32;
    let r = px(reflect101(x + 1, w), y as usize) as f32;
    let u = px(x as usize, reflect101(y - 1, h)) as f32;
    let d = px(x as usize, reflect101(y + 1, h)) as f32;
    l + r + u + d - 4.0 * c
}

/// meanStdDev's variance, squared back from its standard deviation as board_detect.js did.
fn variance(values: &[f32]) -> f64 {
    let n = values.len() as f64;
    let (mut s, mut sq) = (0f64, 0f64);

    for &v in values {
        s += v as f64;
        sq += v as f64 * v as f64;
    }

    let mean = s / n;
    let std = (sq / n - mean * mean).max(0.0).sqrt();
    std * std
}

/// The sharpness of the corner at (x, y) (OpenCV pixel-centre coordinates in `work`), where
/// `s` is work's pixel scale (short side / 1080). 0 when the window is empty.
pub fn corner_sharpness(work: &Gray, x: f64, y: f64, s: f64) -> f64 {
    let (cols, rows) = (work.width as i64, work.height as i64);
    let pad = ((HALF + 2) as f64 * s).ceil() as i64 + 1;
    let cx = js_round(x);
    let cy = js_round(y);
    let x0 = (cx - pad).max(0);
    let y0 = (cy - pad).max(0);
    let x1 = (cx + pad + 1).min(cols);
    let y1 = (cy + pad + 1).min(rows);

    if x1 <= x0 || y1 <= y0 {
        return 0.0;
    }

    let mut values: Vec<f32> = Vec::with_capacity(625);

    if s != 1.0 {
        let w = py_round((x1 - x0) as f64 / s).max(1);
        let h = py_round((y1 - y0) as f64 / s).max(1);
        let resampled = resize_area_region(&work.data, (y0 * cols + x0) as usize, work.width, (x1 - x0) as usize, (y1 - y0) as usize, w as usize, h as usize);
        let px = |x: usize, y: usize| resampled[y * w as usize + x];
        let rx = js_round(x / s) - js_round(x0 as f64 / s);
        let ry = js_round(y / s) - js_round(y0 as f64 / s);

        for yy in (ry - HALF).max(0)..(ry + HALF + 1).min(h) {
            for xx in (rx - HALF).max(0)..(rx + HALF + 1).min(w) {
                values.push(laplacian(&px, w, h, xx, yy));
            }
        }
    } else {
        // The window on the frame itself: a Laplacian of an OpenCV ROI reads the real pixels
        // around it, and reflects only at the frame's own edge.
        let px = |x: usize, y: usize| work.data[y * work.width + x];
        let (rx, ry) = (cx - x0, cy - y0);

        for yy in (ry - HALF).max(0)..(ry + HALF + 1).min(y1 - y0) {
            for xx in (rx - HALF).max(0)..(rx + HALF + 1).min(x1 - x0) {
                values.push(laplacian(&px, cols, rows, xx + x0, yy + y0));
            }
        }
    }

    if values.is_empty() {
        return 0.0;
    }

    variance(&values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checker(width: usize, height: usize, period: usize) -> Gray {
        let data = (0..width * height).map(|i| {
            let (x, y) = (i % width, i / width);
            if (x / period + y / period) % 2 == 0 { 40 } else { 210 }
        }).collect();
        Gray::from_grey(data, width, height)
    }

    #[test]
    fn rounding_helpers_match_javascript_and_python() {
        // Setup: halves and near-halves, positive and negative.
        // Test: js_round and py_round.
        // Verifies: Math.round sends halves up (2.5 -> 3, -2.5 -> -2); Python's round sends them
        // to even (2.5 -> 2, 3.5 -> 4) -- the two roundings board_detect.js mixes.
        assert_eq!([js_round(2.5), js_round(-2.5), js_round(2.4)], [3, -2, 2]);
        assert_eq!([py_round(2.5), py_round(3.5), py_round(2.6)], [2, 4, 3]);
    }

    #[test]
    fn a_flat_patch_has_no_sharpness_and_a_sharp_edge_a_lot() {
        // Setup: a flat grey frame, and a frame with a sharp checkerboard of 10 px squares.
        // Test: corner_sharpness at a checker corner at scale 1, and at scale 0.5 (the window
        // resampled by 2).
        // Verifies: flat is 0; a sharp corner is far above MIN_CORNER_SHARPNESS (50); and the
        // resampled measure still reports a sharp corner (it is measured at the reference scale).
        let flat = Gray::filled(100, 100, 128);
        assert_eq!(corner_sharpness(&flat, 50.0, 50.0, 1.0), 0.0);
        let sharp = checker(100, 100, 10);
        assert!(corner_sharpness(&sharp, 49.5, 49.5, 1.0) > 1000.0);
        assert!(corner_sharpness(&sharp, 49.5, 49.5, 0.5) > 50.0);
    }

    #[test]
    fn the_frame_edge_reflects_and_an_off_frame_window_is_empty() {
        // Setup: a 30 x 30 checkerboard.
        // Test: a corner 2 px from the top-left edge, and a point far outside the frame.
        // Verifies: near the edge the window is clipped (no panic, a finite positive variance,
        // the Laplacian reflected at the frame's edge); outside, the window is empty and the
        // sharpness is 0, as board_detect.js left it.
        let img = checker(30, 30, 5);
        let v = corner_sharpness(&img, 2.0, 2.0, 1.0);
        assert!(v.is_finite() && v > 0.0);
        assert_eq!(corner_sharpness(&img, 500.0, 500.0, 1.0), 0.0);
    }
}
