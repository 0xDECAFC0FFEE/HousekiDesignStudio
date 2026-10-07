// ArUco's adaptive thresholding (aruco_detector.cpp _threshold), for every window size at once.
//
// OpenCV runs adaptiveThreshold(grey, 255, ADAPTIVE_THRESH_MEAN_C, THRESH_BINARY_INV, win, 7)
// once per window (the desktop's tuned parameters ask for seven: 3..93 step 15), and each call
// computes a box-filtered mean of the whole image from scratch. Here one integral image of the
// frame, padded by replication (OpenCV's BORDER_REPLICATE) by the largest window's radius, serves
// every window: a window's sum is four look-ups whatever its size. That is the specialisation the
// phone gets for always running the same seven windows.
//
// The means are rounded exactly as OpenCV's box filter rounds them (modules/imgproc/src/
// box_filter.simd.hpp): windows of up to 256 pixels (only 3 x 3 here) sum in 16 bits and divide
// in 23-bit fixed point (ColumnSum<ushort, uchar>); larger ones multiply in float and round to
// even (ColumnSum<int, uchar>'s SIMD path), except the last width % 8 columns, which OpenCV's
// scalar tail does in double. The threshold itself is adaptiveThreshold's table
// (modules/imgproc/src/thresh.cpp): 255 where src - mean <= -floor(C), else 0. So the binary
// images are opencv.js's, bit for bit.
//
// Output: per window, a binary image padded by one zero pixel on every side, (w + 2) x (h + 2),
// ready for the contour tracer (contours.rs), which needs that border.
//
// Copyright (C) 2000-2022, Intel Corporation, all rights reserved.
// Copyright (C) 2015-2023, OpenCV Foundation, all rights reserved.
// (and the other OpenCV copyright holders listed in NOTICE)
// Copyright 2026 Lucas Tong (the Rust port, and the shared integral image)
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or agreed to in
// writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
// specific language governing permissions and limitations under the License.

use crate::gray::Gray;

/// The integral image of a frame padded by replication, reused across frames.
#[derive(Default)]
pub struct Integral {
    /// (pw + 1) x (ph + 1) wrapping sums; entry (y, x) is the sum of padded rows < y, cols < x.
    sums: Vec<u32>,
    stride: usize,
    radius: usize,
    width: usize,
    height: usize,
    row: Vec<u8>,
}

impl Integral {
    /// Builds the integral of `grey` padded by `radius` replicated pixels on every side. Sums
    /// wrap in 32 bits: a window's sum (at most 93 x 93 x 255) is still exact as a wrapping
    /// difference.
    pub fn build(&mut self, grey: &Gray, radius: usize) {
        let (w, h) = (grey.width, grey.height);
        let pw = w + 2 * radius;
        let ph = h + 2 * radius;
        let stride = pw + 1;
        self.sums.clear();
        self.sums.resize(stride * (ph + 1), 0);
        self.row.resize(pw, 0);

        for py in 0..ph {
            let sy = py.saturating_sub(radius).min(h - 1);
            let src = grey.row(sy);
            self.row[..radius].fill(src[0]);
            self.row[radius..radius + w].copy_from_slice(src);
            self.row[radius + w..].fill(src[w - 1]);

            let (above, below) = self.sums.split_at_mut((py + 1) * stride);
            let above = &above[py * stride..];
            let below = &mut below[..stride];
            let mut run = 0u32;

            for px in 0..pw {
                run = run.wrapping_add(self.row[px] as u32);
                below[px + 1] = above[px + 1].wrapping_add(run);
            }
        }

        self.stride = stride;
        self.radius = radius;
        self.width = w;
        self.height = h;
    }
}

/// OpenCV's 16-bit box-filter division by d (ColumnSum<ushort, uchar>): (sum + delta) * scale >> 23.
fn fixed_point_divisor(d: u32) -> (u32, u32) {
    let scalef = (1u32 << 23) as f64 / d as f64;
    let mut div_scale = scalef.floor() as u32;
    let frac = scalef - div_scale as f64;
    let mut div_delta = d / 2;

    if frac < 0.5 {
        div_delta += 1;
    } else {
        div_scale += 1;
    }

    (div_scale, div_delta)
}

/// The odd window sizes ArUco uses for (min, max, step): min, min + step, ... up to max, each
/// made odd by adding one (aruco _threshold).
pub fn window_sizes(min: i32, max: i32, step: i32) -> Vec<usize> {
    let scales = (max - min) / step + 1;
    (0..scales).map(|i| {
        let k = min + i * step;
        (if k % 2 == 0 { k + 1 } else { k }) as usize
    }).collect()
}

/// Writes, for each window in `windows`, the padded binary image of
/// adaptiveThreshold(MEAN_C, THRESH_BINARY_INV, window, `constant`) into `outs` (resized to fit).
pub fn adaptive_thresholds(grey: &Gray, windows: &[usize], constant: f64, integral: &mut Integral, outs: &mut Vec<Vec<u8>>) {
    let (w, h) = (grey.width, grey.height);
    let radius = windows.iter().max().copied().unwrap_or(3) / 2;
    integral.build(grey, radius);
    let idelta = constant.floor() as i32;
    let pw = w + 2;
    let tail_start = w - w % 8;
    outs.resize_with(windows.len(), Vec::new);

    for (out, &win) in outs.iter_mut().zip(windows) {
        out.clear();
        out.resize(pw * (h + 2), 0);
        let r = win / 2;
        let area = (win * win) as u32;
        let fixed = area <= 256;
        let (div_scale, div_delta) = fixed_point_divisor(area);
        let scale64 = 1.0 / area as f64;
        let scale32 = scale64 as f32;
        let s = integral.stride;
        let c0 = radius - r;
        let c1 = radius + r + 1;

        for y in 0..h {
            let top = &integral.sums[(y + radius - r) * s..][..s];
            let bottom = &integral.sums[(y + radius + r + 1) * s..][..s];
            let src = grey.row(y);
            let dst = &mut out[(y + 1) * pw + 1..][..w];
            let (tl, tr) = (&top[c0..c0 + w], &top[c1..c1 + w]);
            let (bl, br) = (&bottom[c0..c0 + w], &bottom[c1..c1 + w]);

            // Three branch-free loops (the window's rounding mode is fixed per window, the double
            // tail per column range), so the compiler vectorises each: on wasm with simd128,
            // i32x4 sums, f32x4.nearest and i32x4 compares. The means never exceed 255, so
            // OpenCV's saturation to 8 bits changes nothing here.
            let pixel = |x: usize, mean: i32| if src[x] as i32 + idelta <= mean { 255 } else { 0 };

            if fixed {
                for x in 0..w {
                    let sum = br[x].wrapping_sub(tr[x]).wrapping_sub(bl[x]).wrapping_add(tl[x]);
                    dst[x] = pixel(x, ((sum + div_delta).wrapping_mul(div_scale) >> 23) as i32);
                }
            } else {
                for x in 0..tail_start {
                    let sum = br[x].wrapping_sub(tr[x]).wrapping_sub(bl[x]).wrapping_add(tl[x]);
                    dst[x] = pixel(x, (sum as f32 * scale32).round_ties_even() as i32);
                }

                for x in tail_start..w {
                    let sum = br[x].wrapping_sub(tr[x]).wrapping_sub(bl[x]).wrapping_add(tl[x]);
                    dst[x] = pixel(x, (sum as f64 * scale64).round_ties_even() as i32);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The box mean of a replicate-padded image, computed directly: what OpenCV's boxFilter gives
    // before its rounding.
    fn direct_sum(grey: &Gray, x: usize, y: usize, win: usize) -> u32 {
        let r = win as i64 / 2;
        let mut sum = 0u32;

        for dy in -r..=r {
            for dx in -r..=r {
                let sx = (x as i64 + dx).clamp(0, grey.width as i64 - 1) as usize;
                let sy = (y as i64 + dy).clamp(0, grey.height as i64 - 1) as usize;
                sum += grey.at(sx, sy) as u32;
            }
        }

        sum
    }

    fn noise_image(width: usize, height: usize) -> Gray {
        let mut state = 12345u32;
        let data = (0..width * height).map(|_| {
            state = state.wrapping_mul(1103515245).wrapping_add(12345);
            (state >> 16) as u8
        }).collect();
        Gray::from_grey(data, width, height)
    }

    #[test]
    fn the_window_sizes_are_the_desktops_made_odd() {
        // Setup: the desktop's tuned windows (3..93 step 15) and the m = 0.5 variant (3..46 step 8).
        // Test: window_sizes.
        // Verifies: aruco _threshold's sizes: 3, 18 -> 19, 33, 48 -> 49, 63, 78 -> 79, 93 (seven
        // passes), and even sizes made odd for the scaled set too.
        assert_eq!(window_sizes(3, 93, 15), vec![3, 19, 33, 49, 63, 79, 93]);
        assert_eq!(window_sizes(3, 46, 8), vec![3, 11, 19, 27, 35, 43]);
    }

    #[test]
    fn the_shared_integral_gives_every_window_the_replicate_padded_box_sum() {
        // Setup: a 37 x 23 image of pseudo-random grey values (odd sizes, so windows reach past
        // every edge), padded for the largest window, 93.
        // Test: compare the integral's four-look-up sum with a direct sum over the replicated
        // neighbourhood, for windows 3, 19 and 93 at every pixel.
        // Verifies: one integral image serves all window sizes, with OpenCV's BORDER_REPLICATE at
        // all four edges -- the basis of the fused threshold.
        let grey = noise_image(37, 23);
        let mut integral = Integral::default();
        integral.build(&grey, 46);
        let s = integral.stride;

        for &win in &[3usize, 19, 93] {
            let r = win / 2;

            for y in 0..23 {
                for x in 0..37 {
                    let (c0, c1) = (46 - r + x, 46 + r + 1 + x);
                    let (r0, r1) = (46 - r + y, 46 + r + 1 + y);
                    let sum = integral.sums[r1 * s + c1]
                        .wrapping_sub(integral.sums[r0 * s + c1])
                        .wrapping_sub(integral.sums[r1 * s + c0])
                        .wrapping_add(integral.sums[r0 * s + c0]);
                    assert_eq!(sum, direct_sum(&grey, x, y, win), "window {win} at ({x}, {y})");
                }
            }
        }
    }

    #[test]
    fn three_by_three_means_use_opencvs_fixed_point_division() {
        // Setup: OpenCV's ColumnSum<ushort, uchar> constants for a 3 x 3 window (d = 9).
        // Test: the divisor, and the mean it gives for sums around the rounding points.
        // Verifies: divScale 932068 and divDelta 4 (2^23 / 9 = 932067.56: the fraction is >= 0.5,
        // so the scale is rounded up), and that this rounds a sum of 13 (1.44) to 1, 14 (1.56) to
        // 2 and 2295 (255) to 255 -- the box filter's own rounding.
        let (scale, delta) = fixed_point_divisor(9);
        assert_eq!((scale, delta), (932068, 4));
        let mean = |s: u32| ((s + delta) * scale) >> 23;
        assert_eq!([mean(13), mean(14), mean(2295)], [1, 2, 255]);
    }

    #[test]
    fn dark_pixels_below_their_neighbourhood_mean_become_foreground() {
        // Setup: a 20 x 12 mid-grey (120) image with a dark (40) 4 x 4 square, a pixel only 5
        // darker than its surround (115), and the opencv-style threshold constant 7.
        // Test: threshold with windows 3 and 19.
        // Verifies: the outputs are (w + 2) x (h + 2) with a zero border; the dark square's
        // corner pixel is foreground (255) in both (its 3 x 3 mean, 84, is far above it); its
        // middle is foreground only in the 19 px window -- the 3 x 3 window sees flat ink there,
        // which is why ArUco needs several windows; a flat region is background (src - mean = 0
        // > -7); and a pixel only 5 below its mean stays background -- THRESH_BINARY_INV, C = 7.
        let mut grey = Gray::filled(20, 12, 120);

        for y in 4..8 {
            for x in 4..8 {
                grey.data[y * 20 + x] = 40;
            }
        }

        grey.data[2 * 20 + 15] = 115;
        let mut integral = Integral::default();
        let mut outs = Vec::new();
        adaptive_thresholds(&grey, &[3, 19], 7.0, &mut integral, &mut outs);
        assert_eq!(outs.len(), 2);

        for (k, out) in outs.iter().enumerate() {
            assert_eq!(out.len(), 22 * 14);
            let at = |x: usize, y: usize| out[(y + 1) * 22 + x + 1];
            assert_eq!(at(4, 4), 255);
            assert_eq!(at(5, 5), if k == 0 { 0 } else { 255 });
            assert_eq!(at(17, 10), 0);
            assert_eq!(at(15, 2), 0);
            assert!((0..22).all(|x| out[x] == 0 && out[13 * 22 + x] == 0));
        }
    }
}
