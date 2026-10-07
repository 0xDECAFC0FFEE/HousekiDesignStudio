// cornerSubPix: moves a chessboard corner to where the image gradients around it point, the
// sub-pixel refinement both the ChArUco detector (in a window that stops short of the nearest
// marker corner) and detect.py's re-refinement of blurred corners use.
//
// Ported from OpenCV 4.14.0 modules/imgproc/src/cornersubpix.cpp (the Gaussian-weighted gradient
// normal equations, the zero zone, the stopping rules) and modules/imgproc/src/samplers.cpp
// (getRectSubPix for 8-bit to float: the bilinear patch with OpenCV's running-sum arithmetic
// inside the image, and its replicated border outside), in OpenCV's float and double precision,
// so refined corners agree with opencv.js's.
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
use crate::linalg::Pt;

/// getRectSubPix(src, (pw, ph), center) into a float patch.
pub fn rect_subpix(src: &Gray, pw: usize, ph: usize, center: Pt, dst: &mut [f32]) {
    let (sw, sh) = (src.width as i32, src.height as i32);
    let cx = center.x - (pw as f32 - 1.0) * 0.5;
    let cy = center.y - (ph as f32 - 1.0) * 0.5;
    let ipx = cx.floor() as i32;
    let ipy = cy.floor() as i32;

    if ipx >= 0 && ipx + (pw as i32) < sw && ipy >= 0 && ipy + (ph as i32) < sh {
        // getRectSubPix_8u32f: inside the image.
        let mut a = cx - ipx as f32;
        let b = cy - ipy as f32;
        a = a.max(0.0001);
        let a12 = a * (1.0 - b);
        let a22 = a * b;
        let b1 = 1.0 - b;
        let b2 = b;
        let s = (1.0 - a as f64) / a as f64;
        let stride = src.width;

        for row in 0..ph {
            let base = (ipy as usize + row) * stride + ipx as usize;
            let s0 = &src.data[base..];
            let s1 = &src.data[base + stride..];
            let mut prev = (1.0 - a) * (b1 * s0[0] as f32 + b2 * s1[0] as f32);

            for j in 0..pw {
                let t = a12 * s0[j + 1] as f32 + a22 * s1[j + 1] as f32;
                dst[row * pw + j] = prev + t;
                prev = (t as f64 * s) as f32;
            }
        }

        return;
    }

    // getRectSubPix_Cn_<uchar, float, float>: the patch crosses the image edge, which is
    // replicated (adjustRect).
    let a = cx - ipx as f32;
    let b = cy - ipy as f32;
    let a11 = (1.0 - a) * (1.0 - b);
    let a12 = a * (1.0 - b);
    let a21 = (1.0 - a) * b;
    let a22 = a * b;
    let b1 = 1.0 - b;
    let b2 = b;
    let (win_w, win_h) = (pw as i32, ph as i32);

    // adjustRect
    let mut src_x0: i32;
    let rect_x: i32;
    let mut rect_w: i32;

    if ipx >= 0 {
        src_x0 = ipx;
        rect_x = 0;
    } else {
        src_x0 = 0;
        rect_x = (-ipx).min(win_w);
    }

    if ipx < sw - win_w {
        rect_w = win_w;
    } else {
        rect_w = sw - ipx - 1;

        if rect_w < 0 {
            src_x0 += rect_w;
            rect_w = 0;
        }
    }

    let mut src_y: i32;
    let rect_y: i32;
    let mut rect_h: i32;

    if ipy >= 0 {
        src_y = ipy;
        rect_y = 0;
    } else {
        src_y = 0;
        rect_y = -ipy;
    }

    if ipy < sh - win_h {
        rect_h = win_h;
    } else {
        rect_h = sh - ipy - 1;

        if rect_h < 0 {
            src_y += rect_h;
            rect_h = 0;
        }
    }

    // `src` points at column src_x0 - rect_x of row src_y (it may be before the row's start,
    // but only columns rect_x .. are read through it).
    let base_col = src_x0 - rect_x;
    let pix = |row: i32, col: i32| -> f32 { src.data[(row * sw + base_col + col) as usize] as f32 };
    let mut row_s = src_y;

    for i in 0..win_h {
        let mut row_s2 = row_s + 1;

        if i < rect_y || i >= rect_h {
            row_s2 -= 1;
        }

        let out = &mut dst[(i * win_w) as usize..((i + 1) * win_w) as usize];
        let left = pix(row_s, rect_x) * b1 + pix(row_s2, rect_x) * b2;

        for v in out.iter_mut().take(rect_x as usize) {
            *v = left;
        }

        let right = pix(row_s, rect_w) * b1 + pix(row_s2, rect_w) * b2;

        for v in out.iter_mut().skip(rect_w as usize) {
            *v = right;
        }

        for j in rect_x..rect_w {
            out[j as usize] = pix(row_s, j) * a11 + pix(row_s, j + 1) * a12 + pix(row_s2, j) * a21 + pix(row_s2, j + 1) * a22;
        }

        if i < rect_h {
            row_s = row_s2;
        }
    }
}

/// cornerSubPix's stopping rule: TermCriteria(MAX_ITER | EPS, max_iters, eps).
#[derive(Clone, Copy, Debug)]
pub struct Criteria {
    pub max_iters: usize,
    pub eps: f64,
}

/// A cornerSubPix window: half-sizes (win), the zero zone (None for OpenCV's (-1, -1)), and the
/// Gaussian weights, built once per size.
pub struct SubPix {
    win: usize,
    mask: Vec<f32>,
    patch: Vec<f32>,
}

impl SubPix {
    /// A square window of half-size `win`; `zero_zone` Some(z) blanks the central (2z+1)^2 weights
    /// (the ChArUco detector passes Size(), i.e. z = 0: the centre pixel only).
    pub fn new(win: usize, zero_zone: Option<usize>) -> SubPix {
        let w = 2 * win + 1;
        let mut mask = vec![0f32; w * w];

        for i in 0..w {
            let y = (i as f32 - win as f32) / win as f32;
            let vy = (-y * y).exp();

            for j in 0..w {
                let x = (j as f32 - win as f32) / win as f32;
                mask[i * w + j] = vy * (-x * x).exp();
            }
        }

        if let Some(z) = zero_zone {
            if 2 * z + 1 < w {
                for i in win - z..=win + z {
                    for j in win - z..=win + z {
                        mask[i * w + j] = 0.0;
                    }
                }
            }
        }

        SubPix { win, mask, patch: vec![0f32; (w + 2) * (w + 2)] }
    }

    /// Refines one corner (OpenCV pixel-centre coordinates). The corner must be inside the image.
    pub fn refine(&mut self, src: &Gray, corner: Pt, criteria: Criteria) -> Pt {
        let win = self.win;
        let w = 2 * win + 1;
        let pw = w + 2;
        let max_iters = criteria.max_iters.clamp(1, 100);
        let eps = criteria.eps.max(0.0);
        let eps = eps * eps;
        let inside = |p: Pt| p.x >= 0.0 && p.x < src.width as f32 && p.y >= 0.0 && p.y < src.height as f32;
        let ct = corner;
        let mut ci = ct;
        let mut iter = 0;

        loop {
            rect_subpix(src, pw, pw, ci, &mut self.patch);
            let (mut a, mut b, mut c, mut bb1, mut bb2) = (0f64, 0f64, 0f64, 0f64, 0f64);
            let mut k = 0;

            for i in 0..w {
                let py = i as f64 - win as f64;
                let row = (i + 1) * pw + 1;

                for j in 0..w {
                    let m = self.mask[k] as f64;
                    let p = row + j;
                    let tgx = (self.patch[p + 1] - self.patch[p - 1]) as f64;
                    let tgy = (self.patch[p + pw] - self.patch[p - pw]) as f64;
                    let gxx = tgx * tgx * m;
                    let gxy = tgx * tgy * m;
                    let gyy = tgy * tgy * m;
                    let px = j as f64 - win as f64;
                    a += gxx;
                    b += gxy;
                    c += gyy;
                    bb1 += gxx * px + gxy * py;
                    bb2 += gxy * px + gyy * py;
                    k += 1;
                }
            }

            let det = a * c - b * b;

            if det.abs() <= f64::EPSILON * f64::EPSILON {
                break;
            }

            let scale = 1.0 / det;
            let next = Pt::new(
                (ci.x as f64 + c * scale * bb1 - b * scale * bb2) as f32,
                (ci.y as f64 - b * scale * bb1 + a * scale * bb2) as f32,
            );
            // In float, as OpenCV computes it from the two Point2f.
            let (ex, ey) = (next.x - ci.x, next.y - ci.y);
            let err = (ex * ex + ey * ey) as f64;

            if !inside(next) {
                break;
            }

            ci = next;
            iter += 1;

            if !(iter < max_iters && err > eps) {
                break;
            }
        }

        if (ci.x - ct.x).abs() > win as f32 || (ci.y - ct.y).abs() > win as f32 {
            ci = ct;
        }

        ci
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A blurred chessboard corner: four quadrants of ink and paper meeting at (cx, cy) (pixel-
    // centre coordinates), each pixel the exact area average of a 1/8 px supersampling.
    fn corner_image(size: usize, cx: f32, cy: f32) -> Gray {
        let mut img = Gray::filled(size, size, 0);

        for y in 0..size {
            for x in 0..size {
                let mut acc = 0f32;

                for sy in 0..8 {
                    for sx in 0..8 {
                        let px = x as f32 - 0.5 + (sx as f32 + 0.5) / 8.0;
                        let py = y as f32 - 0.5 + (sy as f32 + 0.5) / 8.0;
                        let dark = (px < cx) == (py < cy);
                        acc += if dark { 30.0 } else { 220.0 };
                    }
                }

                img.data[y * size + x] = (acc / 64.0).round() as u8;
            }
        }

        img
    }

    #[test]
    fn rect_subpix_interpolates_inside_and_replicates_outside_the_image() {
        // Setup: a 4 x 4 image whose value is 10 x column + row.
        // Test: a 2 x 2 patch centred at (1.75, 1.25), wholly inside the image, and a 3 x 3 patch
        // centred on the top-left pixel (so it reaches one pixel outside).
        // Verifies: inside, the bilinear value through OpenCV's running-sum arithmetic (the first
        // entry samples (1.25, 0.75): 12.5 + 0.75 = 13.25); outside, the border is replicated, so
        // the patch's top-left entry and its centre both equal the image's top-left pixel, and
        // the entry right of centre is the next column.
        let img = Gray::from_grey((0..16).map(|i| ((i % 4) * 10 + i / 4) as u8).collect(), 4, 4);
        let mut patch = [0f32; 4];
        rect_subpix(&img, 2, 2, Pt::new(1.75, 1.25), &mut patch);
        assert!((patch[0] - 13.25).abs() < 1e-4, "{patch:?}");
        let mut big = [0f32; 9];
        rect_subpix(&img, 3, 3, Pt::new(0.0, 0.0), &mut big);
        assert!((big[0] - 0.0).abs() < 1e-4 && (big[4] - 0.0).abs() < 1e-4, "{big:?}");
        assert!((big[5] - 10.0).abs() < 1e-4, "{big:?}");
    }

    #[test]
    fn a_corner_is_refined_to_its_true_sub_pixel_position() {
        // Setup: a chessboard corner at (20.3, 19.6) in a 40 x 40 image, and a start 1.4 px off.
        // Test: refine with a 5 px half-window, zero zone 0 (the ChArUco detector's call) and
        // with no zero zone and a tight criterion (the blurred-corner re-refinement's).
        // Verifies: both land within 0.05 px of the truth -- the gradient normal equations and
        // the bilinear patch are right -- and a start too far for the window falls back to the
        // start, as OpenCV's "poor convergence" rule does.
        let img = corner_image(40, 20.3, 19.6);
        let start = Pt::new(21.2, 18.5);
        let mut charuco = SubPix::new(5, Some(0));
        let p = charuco.refine(&img, start, Criteria { max_iters: 30, eps: 0.1 });
        assert!(((p.x - 20.3).powi(2) + (p.y - 19.6).powi(2)).sqrt() < 0.1, "{p:?}");
        let mut blurred = SubPix::new(5, None);
        let q = blurred.refine(&img, start, Criteria { max_iters: 100, eps: 0.001 });
        assert!(((q.x - 20.3).powi(2) + (q.y - 19.6).powi(2)).sqrt() < 0.05, "{q:?}");
        let flat = Gray::filled(40, 40, 128);
        assert_eq!(blurred.refine(&flat, start, Criteria { max_iters: 100, eps: 0.001 }), start);
    }
}
