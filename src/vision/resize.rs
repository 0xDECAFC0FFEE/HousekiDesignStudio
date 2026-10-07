// Image resizing with OpenCV's INTER_AREA, for 8-bit grey images, as the board detector uses it:
// to detect on a downscaled copy of a frame (board_detect.js `processingScale`), and to resample
// the small window around each corner to the reference pixel scale before measuring its sharpness
// (HousekiScanner calibrate.corner_sharpness).
//
// Ported from OpenCV 4.14.0 modules/imgproc/src/resize.cpp: hal::resize's INTER_AREA dispatch,
// resizeAreaFast_ (whole-number shrink factors), resizeArea_ with computeResizeAreaTab (other
// shrink factors), and, for enlarging, which OpenCV does with INTER_LINEAR's fixed-point code and
// "area" coefficients, HResizeLinear and the 8-bit VResizeLinear specialisation. The arithmetic
// (float accumulators, the 11-bit fixed point, the rounding) is OpenCV's, so the results match
// opencv.js pixel for pixel.
//
// Copyright (C) 2000-2022, Intel Corporation, all rights reserved.
// Copyright (C) 2009-2011, Willow Garage Inc., all rights reserved.
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

/// OpenCV's cvRound for a float: to the nearest integer, ties to even.
#[inline]
pub fn round_even_f32(v: f32) -> i32 {
    v.round_ties_even() as i32
}

/// OpenCV's cvRound for a double: to the nearest integer, ties to even.
#[inline]
pub fn round_even_f64(v: f64) -> i32 {
    v.round_ties_even() as i32
}

#[inline]
fn saturate_u8(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

/// The `src_w` x `src_h` region of `src` starting at `offset` (rows `stride` bytes apart),
/// resized to `dst_w` x `dst_h` with OpenCV's INTER_AREA.
pub fn resize_area_region(
    src: &[u8],
    offset: usize,
    stride: usize,
    src_w: usize,
    src_h: usize,
    dst_w: usize,
    dst_h: usize,
) -> Vec<u8> {
    assert!(src_w > 0 && src_h > 0 && dst_w > 0 && dst_h > 0);
    let at = |x: usize, y: usize| src[offset + y * stride + x];

    if dst_w == src_w && dst_h == src_h {
        let mut out = Vec::with_capacity(dst_w * dst_h);

        for y in 0..src_h {
            out.extend_from_slice(&src[offset + y * stride..offset + y * stride + src_w]);
        }

        return out;
    }

    let inv_scale_x = dst_w as f64 / src_w as f64;
    let inv_scale_y = dst_h as f64 / src_h as f64;
    let scale_x = 1.0 / inv_scale_x;
    let scale_y = 1.0 / inv_scale_y;
    let iscale_x = round_even_f64(scale_x);
    let iscale_y = round_even_f64(scale_y);
    let is_area_fast = (scale_x - iscale_x as f64).abs() < f64::EPSILON
        && (scale_y - iscale_y as f64).abs() < f64::EPSILON;

    if scale_x >= 1.0 && scale_y >= 1.0 {
        if is_area_fast {
            return area_fast(&at, src_w, src_h, dst_w, dst_h, iscale_x as usize, iscale_y as usize);
        }

        return area_general(&at, src_w, src_h, dst_w, dst_h, scale_x, scale_y);
    }

    linear_area_mode(&at, src_w, src_h, dst_w, dst_h, scale_x, scale_y, inv_scale_x, inv_scale_y)
}

/// A whole image resized with INTER_AREA.
pub fn resize_area(src: &Gray, dst_w: usize, dst_h: usize) -> Gray {
    let data = resize_area_region(&src.data, 0, src.width, src.width, src.height, dst_w, dst_h);
    Gray::from_grey(data, dst_w, dst_h)
}

// resizeAreaFast_: each output pixel the mean of a whole-number block; 2 x 2 blocks with the
// integer (sum + 2) >> 2 of ResizeAreaFastVec, others with float sum x (1 / area), rounded.
// Columns or rows past the last whole block average what is there.
fn area_fast<F: Fn(usize, usize) -> u8>(
    at: &F,
    src_w: usize,
    src_h: usize,
    dst_w: usize,
    dst_h: usize,
    sx_k: usize,
    sy_k: usize,
) -> Vec<u8> {
    let mut out = vec![0u8; dst_w * dst_h];
    let area = sx_k * sy_k;
    let scale = 1.0f32 / area as f32;
    let dwidth1 = src_w / sx_k;
    let fast2 = sx_k == 2 && sy_k == 2;

    for dy in 0..dst_h {
        let sy0 = dy * sy_k;
        let row = &mut out[dy * dst_w..(dy + 1) * dst_w];

        if sy0 >= src_h {
            continue; // already zero, as OpenCV writes
        }

        let w = if sy0 + sy_k <= src_h { dwidth1.min(dst_w) } else { 0 };

        for (dx, value) in row.iter_mut().enumerate().take(w) {
            let sx0 = dx * sx_k;

            if fast2 {
                let s = at(sx0, sy0) as u32 + at(sx0 + 1, sy0) as u32 + at(sx0, sy0 + 1) as u32 + at(sx0 + 1, sy0 + 1) as u32;
                *value = ((s + 2) >> 2) as u8;
            } else {
                let mut sum = 0i32;

                for sy in 0..sy_k {
                    for sx in 0..sx_k {
                        sum += at(sx0 + sx, sy0 + sy) as i32;
                    }
                }

                *value = saturate_u8(round_even_f32(sum as f32 * scale));
            }
        }

        for (dx, value) in row.iter_mut().enumerate().skip(w) {
            let sx0 = dx * sx_k;

            if sx0 >= src_w {
                *value = 0;
                continue;
            }

            let mut sum = 0i32;
            let mut count = 0i32;

            for sy in 0..sy_k {
                if sy0 + sy >= src_h {
                    break;
                }

                for sx in 0..sx_k {
                    if sx0 + sx >= src_w {
                        break;
                    }

                    sum += at(sx0 + sx, sy0 + sy) as i32;
                    count += 1;
                }
            }

            *value = saturate_u8(round_even_f32(sum as f32 / count as f32));
        }
    }

    out
}

#[derive(Clone, Copy, Debug)]
struct Decimate {
    di: usize,
    si: usize,
    alpha: f32,
}

// computeResizeAreaTab: for each output column (or row), the input columns it covers and the
// share of each.
fn area_table(ssize: usize, dsize: usize, scale: f64) -> Vec<Decimate> {
    let mut tab = Vec::with_capacity(2 * ssize);

    for dx in 0..dsize {
        let fsx1 = dx as f64 * scale;
        let fsx2 = fsx1 + scale;
        let cell_width = scale.min(ssize as f64 - fsx1);
        let mut sx1 = fsx1.ceil() as i64;
        let mut sx2 = fsx2.floor() as i64;
        sx2 = sx2.min(ssize as i64 - 1);
        sx1 = sx1.min(sx2);

        if sx1 as f64 - fsx1 > 1e-3 {
            tab.push(Decimate { di: dx, si: (sx1 - 1) as usize, alpha: ((sx1 as f64 - fsx1) / cell_width) as f32 });
        }

        for sx in sx1..sx2 {
            tab.push(Decimate { di: dx, si: sx as usize, alpha: (1.0 / cell_width) as f32 });
        }

        if fsx2 - sx2 as f64 > 1e-3 {
            let share = (fsx2 - sx2 as f64).min(1.0).min(cell_width) / cell_width;
            tab.push(Decimate { di: dx, si: sx2 as usize, alpha: share as f32 });
        }
    }

    tab
}

// resizeArea_<uchar, float>: rows weighted into a float sum, columns into a float buffer.
fn area_general<F: Fn(usize, usize) -> u8>(
    at: &F,
    src_w: usize,
    src_h: usize,
    dst_w: usize,
    dst_h: usize,
    scale_x: f64,
    scale_y: f64,
) -> Vec<u8> {
    let xtab = area_table(src_w, dst_w, scale_x);
    let ytab = area_table(src_h, dst_h, scale_y);
    let mut out = vec![0u8; dst_w * dst_h];
    let mut buf = vec![0f32; dst_w];
    let mut sum = vec![0f32; dst_w];
    let mut prev_dy = ytab.first().map_or(0, |t| t.di);

    let store = |sum: &[f32], out: &mut [u8], dy: usize| {
        for (dx, value) in sum.iter().enumerate() {
            out[dy * dst_w + dx] = saturate_u8(round_even_f32(*value));
        }
    };

    for t in &ytab {
        buf.iter_mut().for_each(|v| *v = 0.0);

        for x in &xtab {
            buf[x.di] += at(x.si, t.si) as f32 * x.alpha;
        }

        if t.di != prev_dy {
            store(&sum, &mut out, prev_dy);

            for (s, b) in sum.iter_mut().zip(&buf) {
                *s = t.alpha * *b;
            }

            prev_dy = t.di;
        } else {
            for (s, b) in sum.iter_mut().zip(&buf) {
                *s += t.alpha * *b;
            }
        }
    }

    store(&sum, &mut out, prev_dy);
    out
}

/// INTER_RESIZE_COEF_BITS: OpenCV's 8-bit linear resize weights are in 1/2048ths.
const COEF_SCALE: f32 = 2048.0;

// Enlarging with INTER_AREA is INTER_LINEAR's fixed-point code with "area" weights: an output
// pixel takes its whole input pixel unless it straddles two (fx is then the share of the second).
#[allow(clippy::too_many_arguments)]
fn linear_area_mode<F: Fn(usize, usize) -> u8>(
    at: &F,
    src_w: usize,
    src_h: usize,
    dst_w: usize,
    dst_h: usize,
    scale_x: f64,
    scale_y: f64,
    inv_scale_x: f64,
    inv_scale_y: f64,
) -> Vec<u8> {
    // Per output column: the left input column and the two 11-bit weights.
    let mut xofs = vec![0usize; dst_w];
    let mut alpha = vec![[0i32; 2]; dst_w];
    let mut xmax = dst_w;

    for dx in 0..dst_w {
        let mut sx = (dx as f64 * scale_x).floor() as i64;
        let mut fx = ((dx + 1) as f64 - (sx + 1) as f64 * inv_scale_x) as f32;
        fx = if fx <= 0.0 { 0.0 } else { fx - fx.floor() };

        if sx + 1 >= src_w as i64 {
            xmax = xmax.min(dx);

            if sx >= src_w as i64 - 1 {
                fx = 0.0;
                sx = src_w as i64 - 1;
            }
        }

        xofs[dx] = sx.max(0) as usize;
        alpha[dx] = [round_even_f32((1.0 - fx) * COEF_SCALE).clamp(-32768, 32767), round_even_f32(fx * COEF_SCALE).clamp(-32768, 32767)];
    }

    let mut yofs = vec![0i64; dst_h];
    let mut beta = vec![[0i32; 2]; dst_h];

    for dy in 0..dst_h {
        let sy = (dy as f64 * scale_y).floor() as i64;
        let mut fy = ((dy + 1) as f64 - (sy + 1) as f64 * inv_scale_y) as f32;
        fy = if fy <= 0.0 { 0.0 } else { fy - fy.floor() };
        yofs[dy] = sy;
        beta[dy] = [round_even_f32((1.0 - fy) * COEF_SCALE).clamp(-32768, 32767), round_even_f32(fy * COEF_SCALE).clamp(-32768, 32767)];
    }

    // When every weight is (1, 0) -- enlarging by a whole factor, as the sharpness window at the
    // live 960 x 540 processing size does (x2) -- the fixed-point arithmetic below gives exactly the
    // source pixel ((2048 x (S x 2048 >> 4) >> 16) + 2) >> 2 = S), so copy instead.
    let one = COEF_SCALE as i32;

    if alpha.iter().take(xmax).all(|a| a[0] == one && a[1] == 0) && beta.iter().all(|b| b[0] == one && b[1] == 0) {
        let mut out = vec![0u8; dst_w * dst_h];

        for dy in 0..dst_h {
            let sy = yofs[dy].clamp(0, src_h as i64 - 1) as usize;

            for dx in 0..dst_w {
                out[dy * dst_w + dx] = at(xofs[dx], sy);
            }
        }

        return out;
    }

    // HResizeLinear: one input row to the output width, in 11-bit fixed point.
    let hresize = |sy: usize, row: &mut [i32]| {
        for dx in 0..dst_w {
            let sx = xofs[dx];

            row[dx] = if dx < xmax {
                at(sx, sy) as i32 * alpha[dx][0] + at(sx + 1, sy) as i32 * alpha[dx][1]
            } else {
                at(sx, sy) as i32 * COEF_SCALE as i32
            };
        }
    };

    let mut out = vec![0u8; dst_w * dst_h];
    let mut row0 = vec![0i32; dst_w];
    let mut row1 = vec![0i32; dst_w];
    let clip = |v: i64| v.clamp(0, src_h as i64 - 1) as usize;

    for dy in 0..dst_h {
        hresize(clip(yofs[dy]), &mut row0);
        hresize(clip(yofs[dy] + 1), &mut row1);
        let [b0, b1] = beta[dy];

        for dx in 0..dst_w {
            // VResizeLinear<uchar, int, short, FixedPtCast<..., 22>>: OpenCV's own rounding.
            let v = ((b0 * (row0[dx] >> 4)) >> 16) + ((b1 * (row1[dx] >> 4)) >> 16) + 2;
            out[dy * dst_w + dx] = saturate_u8(v >> 2);
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(width: usize, height: usize, f: impl Fn(usize, usize) -> u8) -> Gray {
        let mut data = Vec::with_capacity(width * height);

        for y in 0..height {
            for x in 0..width {
                data.push(f(x, y));
            }
        }

        Gray::from_grey(data, width, height)
    }

    #[test]
    fn halving_averages_two_by_two_blocks_with_opencvs_rounding() {
        // Setup: a 4 x 2 image whose 2 x 2 blocks sum to 6 (mean 1.5) and to 10 (mean 2.5).
        // Test: resize it to 2 x 1 (scale 0.5, OpenCV's fast whole-number path).
        // Verifies: each output is the block's (sum + 2) >> 2 -- 1.5 rounds up to 2 and 2.5 up to
        // 3 (integer rounding, not ties-to-even), as ResizeAreaFastVec writes it.
        let src = Gray::from_grey(vec![1, 2, 2, 3, 1, 2, 2, 3], 4, 2);
        assert_eq!(resize_area(&src, 2, 1).data, vec![2, 3]);
    }

    #[test]
    fn a_fractional_shrink_weights_the_pixels_it_straddles() {
        // Setup: one row of three pixels 0, 90, 180.
        // Test: shrink it to two pixels (scale 1.5): output 0 covers input 0 and half of input 1;
        // output 1 covers the other half of input 1 and input 2.
        // Verifies: the area weights of computeResizeAreaTab -- (0 + 0.5 x 90) / 1.5 = 30 and
        // (0.5 x 90 + 180) / 1.5 = 150 -- and that a constant image stays constant.
        let src = Gray::from_grey(vec![0, 90, 180], 3, 1);
        assert_eq!(resize_area(&src, 2, 1).data, vec![30, 150]);
        let flat = image(7, 5, |_, _| 77);
        assert!(resize_area(&flat, 3, 2).data.iter().all(|&v| v == 77));
    }

    #[test]
    fn doubling_repeats_pixels_and_one_and_a_half_blends_alternate_ones() {
        // Setup: a 3 x 1 row 10, 20, 30.
        // Test: enlarge it to 6 x 1 (x2) and to 4 x 1 (x 4/3) with INTER_AREA.
        // Verifies: OpenCV's enlarging "area" weights: at x2 every weight is 0 or 1, so pixels are
        // simply repeated (10 10 20 20 30 30), which is what the sharpness window at a 960 x 540
        // processing size relies on; at x 4/3 an output pixel straddling two inputs blends them by
        // the share it covers (output 1 covers input 0.75-1.5: 1/3 of 10 and 2/3 of 20 = 16.7 ->
        // 17; output 2: 2/3 of 20 and 1/3 of 30 = 23.3 -> 23), in OpenCV's 11-bit fixed point,
        // and the last output, past the input's end, copies the last pixel.
        let src = Gray::from_grey(vec![10, 20, 30], 3, 1);
        assert_eq!(resize_area(&src, 6, 1).data, vec![10, 10, 20, 20, 30, 30]);
        assert_eq!(resize_area(&src, 4, 1).data, vec![10, 17, 23, 30]);
    }

    #[test]
    fn a_region_of_a_larger_image_is_resized_on_its_own() {
        // Setup: an 8 x 6 gradient, and its 4 x 4 region at (2, 1).
        // Test: resize the region in place (resize_area_region with an offset and stride) and a
        // copy of the region on its own, both to 2 x 2.
        // Verifies: the region path reads only the region, row by row through the stride -- the
        // sharpness measure resizes a small window of the frame without copying it first.
        let big = image(8, 6, |x, y| (x * 20 + y * 7) as u8);
        let region = resize_area_region(&big.data, 8 + 2, 8, 4, 4, 2, 2);
        let copy = image(4, 4, |x, y| big.at(x + 2, y + 1));
        assert_eq!(region, resize_area(&copy, 2, 2).data);
    }
}
