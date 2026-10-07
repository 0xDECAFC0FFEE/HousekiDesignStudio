// The small linear algebra the board detector needs: points, OpenCV's LU solve, the perspective
// transform from four point pairs, a 3 x 3 inverse, applying a homography, and fitting one to many
// point pairs (least squares, refined; and a RANSAC variant).
//
// lu_solve, perspective_from_quads, invert3 and transform are ported from OpenCV 4.14.0
// (modules/core/src/matrix_decomp.cpp LUImpl; modules/imgproc/src/imgwarp.cpp
// getPerspectiveTransform's SVD branch, with this project's patch,
// src/web/vendor/opencv/patches/0001, which rescales it to c22 = 1, and the AᵀA and Jacobi SVD it
// uses from modules/core/src/matmul.simd.hpp MulTransposedR and modules/core/src/lapack.cpp
// JacobiSVDImpl_; modules/core/src/lapack.cpp invert for 3 x 3;
// modules/core/src/matmul.dispatch.cpp perspectiveTransform), keeping OpenCV's float and double
// arithmetic so the marker corners and the ChArUco corners interpolated through these come out as
// opencv.js's did. find_homography is findHomography (method 0) ported the same way
// (modules/calib3d/src/fundam.cpp HomographyEstimatorCallback::runKernel and
// HomographyRefineCallback, modules/calib3d/src/levmarq.cpp LMSolverImpl, and
// modules/core/src/lapack.cpp JacobiImpl_ and SVBkSb for cv::eigen and DECOMP_EIG): the
// refinement of missed markers projects them through it, and OpenCV's LM stops after 10
// iterations, short of the optimum when a misread marker is among the points, so a better
// optimiser would choose differently.
//
// Copyright (C) 2000-2022, Intel Corporation, all rights reserved.
// Copyright (C) 2009-2011, Willow Garage Inc., all rights reserved.
// Copyright (C) 2015-2023, OpenCV Foundation, all rights reserved.
// (and the other OpenCV copyright holders listed in NOTICE)
// Copyright 2026 Lucas Tong (the Rust port, and fit_homography_ransac)
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or agreed to in
// writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
// specific language governing permissions and limitations under the License.

/// A point in single precision, as OpenCV's Point2f.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pt {
    pub x: f32,
    pub y: f32,
}

impl Pt {
    pub const fn new(x: f32, y: f32) -> Pt {
        Pt { x, y }
    }

    /// normL2Sqr<float>: the squared length, in float.
    #[inline]
    pub fn norm_sqr(self) -> f32 {
        self.x * self.x + self.y * self.y
    }
}

impl std::ops::Sub for Pt {
    type Output = Pt;
    #[inline]
    fn sub(self, o: Pt) -> Pt {
        Pt::new(self.x - o.x, self.y - o.y)
    }
}

impl std::ops::Add for Pt {
    type Output = Pt;
    #[inline]
    fn add(self, o: Pt) -> Pt {
        Pt::new(self.x + o.x, self.y + o.y)
    }
}

/// A row-major 3 x 3 matrix.
pub type Mat3 = [f64; 9];

/// LUImpl<double>: Gaussian elimination with partial pivoting, solving A x = b in place. Returns
/// false (and leaves `b` partly reduced) when a pivot is below `eps` (DBL_EPSILON x 100 in
/// OpenCV's LU64f): the matrix is singular to working precision.
pub fn lu_solve<const N: usize>(a: &mut [[f64; N]; N], b: &mut [f64; N]) -> bool {
    let eps = f64::EPSILON * 100.0;

    for i in 0..N {
        let mut k = i;

        for j in i + 1..N {
            if a[j][i].abs() > a[k][i].abs() {
                k = j;
            }
        }

        if a[k][i].abs() < eps {
            return false;
        }

        if k != i {
            for j in i..N {
                let t = a[i][j];
                a[i][j] = a[k][j];
                a[k][j] = t;
            }

            b.swap(i, k);
        }

        let d = -1.0 / a[i][i];

        for j in i + 1..N {
            let alpha = a[j][i] * d;

            for k in i + 1..N {
                a[j][k] += alpha * a[i][k];
            }

            b[j] += alpha * b[i];
        }
    }

    for i in (0..N).rev() {
        let mut s = b[i];

        for k in i + 1..N {
            s -= a[i][k] * b[k];
        }

        b[i] = s / a[i][i];
    }

    true
}

/// getPerspectiveTransform as opencv.js computes it: the homography taking `src[i]` to `dst[i]`
/// (i = 0..3), from OpenCV's 8 x 9 system (products of the float coordinates included).
///
/// OpenCV first solves with c22 = 1 by LU and keeps that only if the residual is below an
/// absolute 1e-8; otherwise it takes the unit-norm solution, the singular vector of AᵀA with the
/// smallest singular value, which the phone's patched build (src/web/vendor/opencv/patches/0001)
/// rescales to c22 = 1. Measured (T-0330): in opencv.js the residual test never passes, even for a
/// unit square that LU solves exactly, so every perspective opencv.js made came from the SVD
/// branch. That branch is what is reproduced here, operation for operation (hconcat(A, -B),
/// mulTransposed's AᵀA, JacobiSVDImpl_, the patch's rescale): its results differ from LU's in the
/// last digits, which is enough to move a nearest-neighbour sample or a refined corner, so the
/// port takes the same branch to give the same markers and corners. None when no finite
/// homography comes out.
pub fn perspective_from_quads(src: &[Pt; 4], dst: &[Pt; 4]) -> Option<Mat3> {
    // [A | -B], 8 x 9.
    let mut a = [[0f64; 9]; 8];

    for i in 0..4 {
        a[i][0] = src[i].x as f64;
        a[i + 4][3] = src[i].x as f64;
        a[i][1] = src[i].y as f64;
        a[i + 4][4] = src[i].y as f64;
        a[i][2] = 1.0;
        a[i + 4][5] = 1.0;
        a[i][6] = (-src[i].x * dst[i].x) as f64;
        a[i][7] = (-src[i].y * dst[i].x) as f64;
        a[i + 4][6] = (-src[i].x * dst[i].y) as f64;
        a[i + 4][7] = (-src[i].y * dst[i].y) as f64;
        a[i][8] = -(dst[i].x as f64);
        a[i + 4][8] = -(dst[i].y as f64);
    }

    // mulTransposed(A, AtA, true): MulTransposedR, each entry summed over the rows in order.
    let mut ata = [[0f64; 9]; 9];

    for i in 0..9 {
        for j in i..9 {
            let mut s = 0f64;

            for row in &a {
                s += row[i] * row[j];
            }

            ata[i][j] = s;
            ata[j][i] = s;
        }
    }

    // SVDecomp(AtA, D, U): U's last column is the last row of JacobiSVD's normalised At (AtA is
    // symmetric, so its transpose is itself).
    let mut m = jacobi_svd_last_vector(ata);

    // The patch: rescale to c22 = 1 unless c22 is negligible.
    let c22 = m[8];

    if c22.abs() > 1e-12 {
        let s = 1.0 / c22;
        m.iter_mut().for_each(|v| *v *= s);
    }

    m.iter().all(|v| v.is_finite()).then_some(m)
}

/// hypot as opencv.js computes it. Emscripten forwards C's hypot to JavaScript's Math.hypot, and in
/// Chrome that is V8's builtin (src/builtins/math.tq MathHypot): the values scaled by the larger,
/// their squares summed with Kahan compensation, the square root scaled back. Its results differ
/// from a C library's hypot in the last bit now and then, which the Jacobi SVD below amplifies
/// into the 10th digit of a perspective matrix (measured, T-0330), so the port uses the same
/// formula. (Safari's JavaScriptCore has its own Math.hypot; opencv.js on an iPhone was not
/// bit-identical to Chrome's either.)
pub fn js_hypot(x: f64, y: f64) -> f64 {
    let (ax, ay) = (x.abs(), y.abs());
    let max = ax.max(ay);

    if max == f64::INFINITY {
        return f64::INFINITY;
    }

    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }

    if max == 0.0 {
        return 0.0;
    }

    let (mut sum, mut compensation) = (0f64, 0f64);

    for v in [ax, ay] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }

    sum.sqrt() * max
}

/// OpenCV's RNG (multiply-with-carry), for JacobiSVDImpl_'s rare zero-singular-value branch.
struct OpenCvRng(u64);

impl OpenCvRng {
    fn next(&mut self) -> u32 {
        self.0 = (self.0 as u32 as u64).wrapping_mul(4_164_903_690).wrapping_add(self.0 >> 32);
        self.0 as u32
    }
}

/// hal::SVD64f / JacobiSVDImpl_ on a 9 x 9 matrix given as its rows At (m = n = n1 = 9,
/// eps = DBL_EPSILON x 10, minval = DBL_MIN): one-sided Jacobi rotations of the rows, sorted by
/// decreasing singular value, each normalised; returns the last row (the left singular vector of
/// the smallest singular value). V is not needed and not kept: it never feeds back into At.
fn jacobi_svd_last_vector(mut at: [[f64; 9]; 9]) -> [f64; 9] {
    const N: usize = 9;
    let eps = f64::EPSILON * 10.0;
    let minval = f64::MIN_POSITIVE;
    let mut w = [0f64; N];

    for i in 0..N {
        let mut sd = 0f64;

        for k in 0..N {
            sd += at[i][k] * at[i][k];
        }

        w[i] = sd;
    }

    for _iter in 0..30 {
        let mut changed = false;

        for i in 0..N - 1 {
            for j in i + 1..N {
                let (a, b) = (w[i], w[j]);
                let mut p = 0f64;

                for k in 0..N {
                    p += at[i][k] * at[j][k];
                }

                if p.abs() <= eps * (a * b).sqrt() {
                    continue;
                }

                p *= 2.0;
                let beta = a - b;
                let gamma = js_hypot(p, beta);
                let (c, s);

                if beta < 0.0 {
                    let delta = (gamma - beta) * 0.5;
                    s = (delta / gamma).sqrt();
                    c = p / (gamma * s * 2.0);
                } else {
                    c = ((gamma + beta) / (gamma * 2.0)).sqrt();
                    s = p / (gamma * c * 2.0);
                }

                let (mut na, mut nb) = (0f64, 0f64);

                for k in 0..N {
                    let t0 = c * at[i][k] + s * at[j][k];
                    let t1 = -s * at[i][k] + c * at[j][k];
                    at[i][k] = t0;
                    at[j][k] = t1;
                    na += t0 * t0;
                    nb += t1 * t1;
                }

                w[i] = na;
                w[j] = nb;
                changed = true;
            }
        }

        if !changed {
            break;
        }
    }

    for i in 0..N {
        let mut sd = 0f64;

        for k in 0..N {
            sd += at[i][k] * at[i][k];
        }

        w[i] = sd.sqrt();
    }

    // Selection sort by decreasing singular value, swapping rows as it goes (Vt is computed in
    // OpenCV's call, so At's rows are swapped too).
    for i in 0..N - 1 {
        let mut j = i;

        for k in i + 1..N {
            if w[j] < w[k] {
                j = k;
            }
        }

        if i != j {
            w.swap(i, j);
            at.swap(i, j);
        }
    }

    let mut rng = OpenCvRng(0x1234_5678);

    for i in 0..N {
        let mut sd = w[i];
        let mut tries = 0;

        // A zero singular value: a random vector orthogonalised against the rows before it.
        while tries < 100 && sd <= minval {
            tries += 1;
            let val0 = 1.0 / N as f64;

            for k in 0..N {
                at[i][k] = if rng.next() & 256 != 0 { val0 } else { -val0 };
            }

            for _ in 0..2 {
                for j in 0..i {
                    let mut d = 0f64;

                    for k in 0..N {
                        d += at[i][k] * at[j][k];
                    }

                    let mut asum = 0f64;

                    for k in 0..N {
                        let t = at[i][k] - d * at[j][k];
                        at[i][k] = t;
                        asum += t.abs();
                    }

                    let asum = if asum > eps * 100.0 { 1.0 / asum } else { 0.0 };

                    for k in 0..N {
                        at[i][k] *= asum;
                    }
                }
            }

            sd = 0.0;

            for k in 0..N {
                sd += at[i][k] * at[i][k];
            }

            sd = sd.sqrt();
        }

        let s = if sd > minval { 1.0 / sd } else { 0.0 };

        for k in 0..N {
            at[i][k] *= s;
        }
    }

    at[N - 1]
}

/// The determinant of a 3 x 3 matrix, as OpenCV's det3.
pub fn det3(m: &Mat3) -> f64 {
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
}

/// invert() of a 3 x 3 double matrix (OpenCV's closed form); None when the determinant is 0.
pub fn invert3(m: &Mat3) -> Option<Mat3> {
    let d = det3(m);

    if d == 0.0 {
        return None;
    }

    let d = 1.0 / d;
    Some([
        (m[4] * m[8] - m[5] * m[7]) * d,
        (m[2] * m[7] - m[1] * m[8]) * d,
        (m[1] * m[5] - m[2] * m[4]) * d,
        (m[5] * m[6] - m[3] * m[8]) * d,
        (m[0] * m[8] - m[2] * m[6]) * d,
        (m[2] * m[3] - m[0] * m[5]) * d,
        (m[3] * m[7] - m[4] * m[6]) * d,
        (m[1] * m[6] - m[0] * m[7]) * d,
        (m[0] * m[4] - m[1] * m[3]) * d,
    ])
}

/// perspectiveTransform of one float point (computed in double, as OpenCV does for CV_32F
/// points); a point whose w is within FLT_EPSILON of 0 maps to (0, 0), as OpenCV's does.
pub fn transform(h: &Mat3, p: Pt) -> Pt {
    let x = p.x as f64;
    let y = p.y as f64;
    let w = h[6] * x + h[7] * y + h[8];

    if w.abs() > f32::EPSILON as f64 {
        let w = 1.0 / w;
        Pt::new(((h[0] * x + h[1] * y + h[2]) * w) as f32, ((h[3] * x + h[4] * y + h[5]) * w) as f32)
    } else {
        Pt::new(0.0, 0.0)
    }
}

/// A homography applied in double precision (no float rounding of the result).
pub fn transform_f64(h: &Mat3, x: f64, y: f64) -> (f64, f64) {
    let w = h[6] * x + h[7] * y + h[8];
    ((h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w)
}

/// JacobiImpl_ (cv::eigen of a symmetric matrix, without Eigen, as opencv.js is built): cyclic
/// pivoting on the largest off-diagonal element, rotations with (JavaScript's) hypot, eigenvalues
/// sorted decreasing. Returns (W, V) with V's rows the eigenvectors.
pub fn jacobi_eigen<const N: usize>(mut a: [[f64; N]; N]) -> ([f64; N], [[f64; N]; N]) {
    let eps = f64::EPSILON;
    let mut v = [[0f64; N]; N];
    let mut w = [0f64; N];
    let mut ind_r = [0usize; N];
    let mut ind_c = [0usize; N];

    for (i, row) in v.iter_mut().enumerate() {
        row[i] = 1.0;
    }

    let row_max = |a: &[[f64; N]; N], k: usize| -> usize {
        let mut m = k + 1;
        let mut mv = a[k][m].abs();

        for i in k + 2..N {
            let val = a[k][i].abs();

            if mv < val {
                mv = val;
                m = i;
            }
        }

        m
    };
    let col_max = |a: &[[f64; N]; N], k: usize| -> usize {
        let mut m = 0;
        let mut mv = a[0][k].abs();

        for i in 1..k {
            let val = a[i][k].abs();

            if mv < val {
                mv = val;
                m = i;
            }
        }

        m
    };

    for k in 0..N {
        w[k] = a[k][k];

        if k < N - 1 {
            ind_r[k] = row_max(&a, k);
        }

        if k > 0 {
            ind_c[k] = col_max(&a, k);
        }
    }

    if N > 1 {
        for _iter in 0..N * N * 30 {
            // The pivot (k, l): the largest off-diagonal element.
            let mut k = 0;
            let mut mv = a[0][ind_r[0]].abs();

            for i in 1..N - 1 {
                let val = a[i][ind_r[i]].abs();

                if mv < val {
                    mv = val;
                    k = i;
                }
            }

            let mut l = ind_r[k];

            for i in 1..N {
                let val = a[ind_c[i]][i].abs();

                if mv < val {
                    mv = val;
                    k = ind_c[i];
                    l = i;
                }
            }

            let p = a[k][l];

            if p.abs() <= eps {
                break;
            }

            let y = (w[l] - w[k]) * 0.5;
            let mut t = y.abs() + js_hypot(p, y);
            let mut s = js_hypot(p, t);
            let c = t / s;
            s = p / s;
            t = (p / t) * p;

            if y < 0.0 {
                s = -s;
                t = -t;
            }

            a[k][l] = 0.0;
            w[k] -= t;
            w[l] += t;

            let rotate = |v0: f64, v1: f64| (v0 * c - v1 * s, v0 * s + v1 * c);

            for i in 0..k {
                let (p0, p1) = rotate(a[i][k], a[i][l]);
                a[i][k] = p0;
                a[i][l] = p1;
            }

            for i in k + 1..l {
                let (p0, p1) = rotate(a[k][i], a[i][l]);
                a[k][i] = p0;
                a[i][l] = p1;
            }

            for i in l + 1..N {
                let (p0, p1) = rotate(a[k][i], a[l][i]);
                a[k][i] = p0;
                a[l][i] = p1;
            }

            for i in 0..N {
                let (p0, p1) = rotate(v[k][i], v[l][i]);
                v[k][i] = p0;
                v[l][i] = p1;
            }

            for idx in [k, l] {
                if idx < N - 1 {
                    ind_r[idx] = row_max(&a, idx);
                }

                if idx > 0 {
                    ind_c[idx] = col_max(&a, idx);
                }
            }
        }
    }

    for k in 0..N.saturating_sub(1) {
        let mut m = k;

        for i in k + 1..N {
            if w[m] < w[i] {
                m = i;
            }
        }

        if k != m {
            w.swap(m, k);
            v.swap(m, k);
        }
    }

    (w, v)
}

/// solve(A, b, DECOMP_EIG) for a symmetric A: the eigen decomposition and SVBkSb's
/// back-substitution, eigenvalues within DBL_EPSILON x 2 x their sum of zero dropped.
fn solve_eig<const N: usize>(a: [[f64; N]; N], b: &[f64; N]) -> [f64; N] {
    let (w, v) = jacobi_eigen(a);
    let threshold = w.iter().sum::<f64>() * (f64::EPSILON * 2.0);
    let mut x = [0f64; N];

    for i in 0..N {
        if w[i].abs() <= threshold {
            continue;
        }

        let mut s = 0f64;

        for j in 0..N {
            s += v[i][j] * b[j];
        }

        s *= 1.0 / w[i];

        for j in 0..N {
            x[j] += s * v[i][j];
        }
    }

    x
}

/// The largest |diagonal| of invert(A, DECOMP_EIG) (the pseudo-inverse), which is all
/// LMSolverImpl reads of it.
fn max_diag_of_eig_inverse<const N: usize>(a: [[f64; N]; N]) -> f64 {
    let (w, v) = jacobi_eigen(a);
    let threshold = w.iter().sum::<f64>() * (f64::EPSILON * 2.0);
    let mut diag = [0f64; N];

    for i in 0..N {
        if w[i].abs() <= threshold {
            continue;
        }

        let wi = 1.0 / w[i];

        for j in 0..N {
            diag[j] += v[i][j] * wi * v[i][j];
        }
    }

    diag.iter().fold(f64::EPSILON, |m, d| m.max(d.abs()))
}

pub fn mul3(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [0f64; 9];

    for r in 0..3 {
        for c in 0..3 {
            out[3 * r + c] = a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c];
        }
    }

    out
}

/// fundam.cpp scaleFor: 1 / x unless x is within FLT_EPSILON of 0.
fn scale_for(x: f64) -> f64 {
    if x.abs() > f32::EPSILON as f64 { 1.0 / x } else { 1.0 }
}

/// HomographyEstimatorCallback::runKernel: the normalised DLT (coordinates centred and scaled to
/// unit mean absolute deviation per axis), the eigenvector of LᵀL's smallest eigenvalue,
/// denormalised and scaled to c22 = 1.
fn homography_kernel(src: &[Pt], dst: &[Pt]) -> Option<Mat3> {
    let count = src.len();
    let (mut cm, mut c_m) = ((0f64, 0f64), (0f64, 0f64));

    for i in 0..count {
        cm.0 += dst[i].x as f64;
        cm.1 += dst[i].y as f64;
        c_m.0 += src[i].x as f64;
        c_m.1 += src[i].y as f64;
    }

    let n = count as f64;
    cm = (cm.0 / n, cm.1 / n);
    c_m = (c_m.0 / n, c_m.1 / n);
    let (mut sm, mut s_m) = ((0f64, 0f64), (0f64, 0f64));

    for i in 0..count {
        sm.0 += (dst[i].x as f64 - cm.0).abs();
        sm.1 += (dst[i].y as f64 - cm.1).abs();
        s_m.0 += (src[i].x as f64 - c_m.0).abs();
        s_m.1 += (src[i].y as f64 - c_m.1).abs();
    }

    if sm.0.abs() < f64::EPSILON || sm.1.abs() < f64::EPSILON || s_m.0.abs() < f64::EPSILON || s_m.1.abs() < f64::EPSILON {
        return None;
    }

    sm = (n / sm.0, n / sm.1);
    s_m = (n / s_m.0, n / s_m.1);
    let inv_hnorm = [1.0 / sm.0, 0.0, cm.0, 0.0, 1.0 / sm.1, cm.1, 0.0, 0.0, 1.0];
    let hnorm2 = [s_m.0, 0.0, -c_m.0 * s_m.0, 0.0, s_m.1, -c_m.1 * s_m.1, 0.0, 0.0, 1.0];
    let mut ltl = [[0f64; 9]; 9];

    for i in 0..count {
        let x = (dst[i].x as f64 - cm.0) * sm.0;
        let y = (dst[i].y as f64 - cm.1) * sm.1;
        let bx = (src[i].x as f64 - c_m.0) * s_m.0;
        let by = (src[i].y as f64 - c_m.1) * s_m.1;
        let lx = [bx, by, 1.0, 0.0, 0.0, 0.0, -x * bx, -x * by, -x];
        let ly = [0.0, 0.0, 0.0, bx, by, 1.0, -y * bx, -y * by, -y];

        for j in 0..9 {
            for k in j..9 {
                ltl[j][k] += lx[j] * lx[k] + ly[j] * ly[k];
            }
        }
    }

    for j in 0..9 {
        for k in 0..j {
            ltl[j][k] = ltl[k][j];
        }
    }

    let (_, v) = jacobi_eigen(ltl);
    let h0: Mat3 = v[8];
    let h = mul3(&mul3(&inv_hnorm, &h0), &hnorm2);
    let s = scale_for(h[8]);
    Some(h.map(|x| x * s))
}

/// HomographyRefineCallback::compute: the reprojection residuals (and their Jacobian).
fn homography_residuals(h: &[f64; 9], src: &[Pt], dst: &[Pt], jacobian: Option<&mut Vec<[f64; 9]>>) -> Vec<f64> {
    let mut err = Vec::with_capacity(2 * src.len());
    let mut jac = jacobian;

    if let Some(j) = jac.as_mut() {
        j.clear();
    }

    for i in 0..src.len() {
        let (mx, my) = (src[i].x as f64, src[i].y as f64);
        let mut ww = h[6] * mx + h[7] * my + h[8];
        ww = if ww.abs() > f64::EPSILON { 1.0 / ww } else { 0.0 };
        let xi = (h[0] * mx + h[1] * my + h[2]) * ww;
        let yi = (h[3] * mx + h[4] * my + h[5]) * ww;
        err.push(xi - dst[i].x as f64);
        err.push(yi - dst[i].y as f64);

        if let Some(j) = jac.as_mut() {
            j.push([mx * ww, my * ww, ww, 0.0, 0.0, 0.0, -mx * ww * xi, -my * ww * xi, -ww * xi]);
            j.push([0.0, 0.0, 0.0, mx * ww, my * ww, ww, -mx * ww * yi, -my * ww * yi, -ww * yi]);
        }
    }

    err
}

/// The dot product opencv.js's gemm computes for a matrix times a vector (GEMMSingleMul<double>'s
/// A * Bᵀ branch), REPRODUCING AN OPENCV 4.14 BUG: in builds with 128-bit SIMD but no 64-bit float
/// SIMD -- WebAssembly is one (intrin_wasm.hpp: CV_SIMD128_64F 0) -- that branch calls the float
/// simdDotProduct on the double arrays, so the first `n` floats of the arrays' bytes (the low and
/// high halves of the first n / 2 doubles, read as floats) are multiplied and summed in four
/// 4-lane float accumulators, in multiples of 4, and only the last n % 4 (or more) elements are
/// taken as the doubles they are. The result is wrong, sometimes NaN; opencv.js's findHomography
/// refinement runs on it (its LM accepts a step only when the error drops, so it still returns a
/// sensible homography, but not the least-squares one). The phone's refinement of missed markers
/// went through it, so the port does too.
fn opencv_wasm_gemm_dot(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len();
    let float_view = |v: &[f64], i: usize| -> f32 {
        let bits = v[i / 2].to_bits();
        f32::from_bits(if i % 2 == 0 { bits as u32 } else { (bits >> 32) as u32 })
    };
    let mut acc = [[0f32; 4]; 4];
    let mut k = 0;

    while k + 16 <= n {
        for (q, lanes) in acc.iter_mut().enumerate() {
            for (l, lane) in lanes.iter_mut().enumerate() {
                let i = k + 4 * q + l;
                *lane = float_view(a, i) * float_view(b, i) + *lane;
            }
        }

        k += 16;
    }

    let mut s0 = [0f32; 4];

    for l in 0..4 {
        s0[l] = (acc[0][l] + acc[1][l]) + (acc[2][l] + acc[3][l]);
    }

    while k + 4 <= n {
        for (l, lane) in s0.iter_mut().enumerate() {
            *lane = float_view(a, k + l) * float_view(b, k + l) + *lane;
        }

        k += 4;
    }

    // v_reduce_sum on WebAssembly: (l0 + l2) + (l1 + l3).
    let mut s = ((s0[0] + s0[2]) + (s0[1] + s0[3])) as f64;

    while k < n {
        s += a[k] * b[k];
        k += 1;
    }

    s
}

/// Mat::dot for doubles (dotProd_): four products summed, then added, then the rest one by one.
fn opencv_dot(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len();
    let mut result = 0f64;
    let mut i = 0;

    while i + 4 <= n {
        result += a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3];
        i += 4;
    }

    while i < n {
        result += a[i] * b[i];
        i += 1;
    }

    result
}

/// LMSolverImpl::run with HomographyRefineCallback, `max_iters` iterations (epsx = epsf =
/// FLT_EPSILON), as findHomography refines its estimate -- in opencv.js (see
/// opencv_wasm_gemm_dot).
fn refine_homography_lm(x0: Mat3, src: &[Pt], dst: &[Pt], max_iters: usize) -> Mat3 {
    // A = JᵀJ (mulTransposed: MulTransposedR, plain sums) and v = Jᵀr (gemm, GEMM_1_T: each
    // column of J copied out, then the buggy dot product).
    let normal = |jac: &Vec<[f64; 9]>, r: &[f64]| -> ([[f64; 9]; 9], [f64; 9]) {
        let mut a = [[0f64; 9]; 9];
        let mut v = [0f64; 9];

        for i in 0..9 {
            for j in i..9 {
                let mut s = 0f64;

                for row in jac {
                    s += row[i] * row[j];
                }

                a[i][j] = s;
                a[j][i] = s;
            }

            let column: Vec<f64> = jac.iter().map(|row| row[i]).collect();
            v[i] = opencv_wasm_gemm_dot(&column, r);
        }

        (a, v)
    };
    let sq = |r: &[f64]| r.iter().fold(0f64, |s, e| s + e * e);
    let inf = |r: &[f64]| r.iter().fold(0f64, |m, e| m.max(e.abs()));

    let mut x = x0;
    let mut jac = Vec::new();
    let mut r = homography_residuals(&x, src, dst, Some(&mut jac));
    let mut s = sq(&r);
    let (mut a, mut v) = normal(&jac, &r);
    let d_diag: [f64; 9] = std::array::from_fn(|i| a[i][i]);
    let (rlo, rhi) = (0.25, 0.75);
    let (mut lambda, mut lc) = (1.0f64, 0.75f64);
    let mut iter = 0;

    loop {
        let mut ap = a;

        for i in 0..9 {
            ap[i][i] += lambda * d_diag[i];
        }

        let d = solve_eig(ap, &v);
        let xd: Mat3 = std::array::from_fn(|i| x[i] - d[i]);
        let rd = homography_residuals(&xd, src, dst, None);
        let sd = sq(&rd);
        // temp_d = gemm(A, d, -1, v, 2): each row of A dotted with d (the same buggy dot
        // product), times -1, plus 2 v; dS = d . temp_d.
        let temp_d: [f64; 9] = std::array::from_fn(|i| opencv_wasm_gemm_dot(&a[i], &d) * -1.0 + v[i] * 2.0);
        let ds = opencv_dot(&d, &temp_d);
        let ratio = (s - sd) / if ds.abs() > f64::EPSILON { ds } else { 1.0 };

        if ratio > rhi {
            lambda *= 0.5;

            if lambda < lc {
                lambda = 0.0;
            }
        } else if ratio < rlo {
            let t = opencv_dot(&d, &v);
            let mut nu = (sd - s) / if t.abs() > f64::EPSILON { t } else { 1.0 } + 2.0;
            nu = nu.clamp(2.0, 10.0);

            if lambda == 0.0 {
                let maxval = max_diag_of_eig_inverse(a);
                lambda = 1.0 / maxval;
                lc = lambda;
                nu *= 0.5;
            }

            lambda *= nu;
        }

        if sd < s {
            s = sd;
            x = xd;
            r = homography_residuals(&x, src, dst, Some(&mut jac));
            (a, v) = normal(&jac, &r);
        }

        iter += 1;

        if !(iter < max_iters && inf(&d) >= f32::EPSILON as f64 && inf(&r) >= f32::EPSILON as f64) {
            break;
        }
    }

    x
}

/// findHomography(src, dst, 0): the least-squares homography as opencv.js computes it -- the
/// normalised DLT, then (for more than 4 pairs) 10 iterations of OpenCV's Levenberg-Marquardt,
/// scaled to c22 = 1. The points pass through float32, as OpenCV converts them. None when the
/// points are degenerate.
pub fn find_homography(src: &[Pt], dst: &[Pt]) -> Option<Mat3> {
    if src.len() < 4 || dst.len() != src.len() {
        return None;
    }

    let mut h = homography_kernel(src, dst)?;

    if src.len() > 4 {
        h = refine_homography_lm(h, src, dst, 10);
        let s = scale_for(h[8]);
        h = h.map(|x| x * s);
    }

    h.iter().all(|v| v.is_finite()).then_some(h)
}

/// find_homography for f64 pairs (rounded to float32 first, as OpenCV does).
pub fn fit_homography(src: &[(f64, f64)], dst: &[(f64, f64)]) -> Option<Mat3> {
    let s: Vec<Pt> = src.iter().map(|&(x, y)| Pt::new(x as f32, y as f32)).collect();
    let d: Vec<Pt> = dst.iter().map(|&(x, y)| Pt::new(x as f32, y as f32)).collect();
    find_homography(&s, &d)
}

/// A homography fitted robustly: pairs within `threshold` px of a 4-pair RANSAC model (a fixed,
/// seeded sequence of samples, so the result is repeatable), then refitted on those inliers.
/// Used only to estimate the local square size around blurred corners (detect.py refine_blurred
/// uses OpenCV's RANSAC findHomography with a 5 px threshold for the same).
pub fn fit_homography_ransac(src: &[(f64, f64)], dst: &[(f64, f64)], threshold: f64) -> Option<Mat3> {
    let n = src.len();

    if n < 4 {
        return None;
    }

    let t2 = threshold * threshold;
    let inliers_of = |h: &Mat3| -> Vec<usize> {
        (0..n).filter(|&i| {
            let (px, py) = transform_f64(h, src[i].0, src[i].1);
            let d = (px - dst[i].0).powi(2) + (py - dst[i].1).powi(2);
            d <= t2
        }).collect()
    };

    // Everything first: with no outliers (the usual case) this is the answer.
    if let Some(h) = fit_homography(src, dst) {
        if inliers_of(&h).len() == n {
            return Some(h);
        }
    }

    let mut best: Vec<usize> = Vec::new();
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = |m: usize| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % m as u64) as usize
    };

    for _ in 0..500 {
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

        let quad = |pts: &[(f64, f64)]| -> [Pt; 4] {
            let mut q = [Pt::default(); 4];

            for (k, &i) in pick.iter().enumerate() {
                q[k] = Pt::new(pts[i].0 as f32, pts[i].1 as f32);
            }

            q
        };

        if let Some(h) = perspective_from_quads(&quad(src), &quad(dst)) {
            let inliers = inliers_of(&h);

            if inliers.len() > best.len() {
                best = inliers;

                if best.len() == n {
                    break;
                }
            }
        }
    }

    if best.len() < 4 {
        return None;
    }

    let s: Vec<(f64, f64)> = best.iter().map(|&i| src[i]).collect();
    let d: Vec<(f64, f64)> = best.iter().map(|&i| dst[i]).collect();
    fit_homography(&s, &d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lu_solves_a_system_that_needs_pivoting() {
        // Setup: a 3 x 3 system whose first pivot is 0, so it cannot be solved without swapping
        // rows: [0 2 1; 1 1 1; 2 1 3] x = [5, 6, 13].
        // Test: lu_solve, substitute the answer back; then a matrix with two equal rows.
        // Verifies: partial pivoting finds a solution satisfying every equation to 1e-12, and a
        // singular matrix is reported (false) instead of dividing by a zero pivot.
        let mut a = [[0.0, 2.0, 1.0], [1.0, 1.0, 1.0], [2.0, 1.0, 3.0]];
        let mut b = [5.0, 6.0, 13.0];
        assert!(lu_solve(&mut a, &mut b));
        let check = [[0.0, 2.0, 1.0], [1.0, 1.0, 1.0], [2.0, 1.0, 3.0]];

        for r in 0..3 {
            let lhs: f64 = (0..3).map(|c| check[r][c] * b[c]).sum();
            let rhs = [5.0, 6.0, 13.0][r];
            assert!((lhs - rhs).abs() < 1e-12, "row {r}: {lhs} vs {rhs}, x = {b:?}");
        }

        let mut singular = [[1.0, 2.0], [1.0, 2.0]];
        let mut rhs = [1.0, 1.0];
        assert!(!lu_solve(&mut singular, &mut rhs));
    }

    #[test]
    fn the_perspective_from_four_points_maps_them_exactly_with_c22_one() {
        // Setup: a unit square and a skewed, perspective quadrilateral (a marker as a phone sees
        // it), and the 48 x 48 px canonical square the marker reader warps to.
        // Test: perspective_from_quads in both directions, then map the corners through it.
        // Verifies: each source corner lands on its destination to 1e-3 px, the matrix has
        // c22 = 1 to rounding (the patched OpenCV's convention, which the ChArUco detector's |det| >
        // 1e-6 validity test depends on), and the inverse through invert3 maps back.
        let square = [Pt::new(0.0, 0.0), Pt::new(1.0, 0.0), Pt::new(1.0, 1.0), Pt::new(0.0, 1.0)];
        let quad = [Pt::new(196.0, 1196.0), Pt::new(84.0, 1103.0), Pt::new(146.0, 917.0), Pt::new(253.0, 1015.0)];
        let h = perspective_from_quads(&square, &quad).unwrap();
        assert!((h[8] - 1.0).abs() < 1e-12, "c22 {}", h[8]);

        for k in 0..4 {
            let p = transform(&h, square[k]);
            assert!((p - quad[k]).norm_sqr() < 1e-6, "{k}: {p:?}");
        }

        let canonical = [Pt::new(0.0, 0.0), Pt::new(47.0, 0.0), Pt::new(47.0, 47.0), Pt::new(0.0, 47.0)];
        let to_canonical = perspective_from_quads(&quad, &canonical).unwrap();
        let back = invert3(&to_canonical).unwrap();

        for k in 0..4 {
            let p = transform(&back, canonical[k]);
            assert!((p - quad[k]).norm_sqr() < 1e-4, "{k}: {p:?}");
        }
    }

    #[test]
    fn the_patched_opencv_marker_numbers_are_reproduced() {
        // Setup: the marker of src/web/tests/vision_opencv_test.js -- marker 72 of the real
        // moissanite frame, its board corners in squares (centre (13.5, 6.5), side 0.689) and its
        // image corners -- the case that made unpatched opencv.js drop every corner of the frame.
        // Test: the perspective from board to image, its determinant, and the chessboard corner
        // (14, 7) mapped through it.
        // Verifies: c22 = 1 and |det| far above the ChArUco detector's 1e-6 threshold, and the
        // corner lands where Python's native OpenCV 5.0 put it, (134.496, 852.806), to 1e-3 px.
        let h = 0.689f32 / 2.0;
        let board = [
            Pt::new(13.5 - h, 6.5 - h),
            Pt::new(13.5 + h, 6.5 - h),
            Pt::new(13.5 + h, 6.5 + h),
            Pt::new(13.5 - h, 6.5 + h),
        ];
        let image = [Pt::new(196.0, 1196.0), Pt::new(84.0, 1103.0), Pt::new(146.0, 917.0), Pt::new(253.0, 1015.0)];
        let m = perspective_from_quads(&board, &image).unwrap();
        assert!((m[8] - 1.0).abs() < 1e-12, "c22 {}", m[8]);
        assert!(det3(&m).abs() > 1000.0, "det {}", det3(&m));
        let p = transform(&m, Pt::new(14.0, 7.0));
        assert!(((p.x - 134.49559).powi(2) + (p.y - 852.80597).powi(2)).sqrt() < 1e-3, "{p:?}");
    }

    #[test]
    fn a_homography_is_recovered_from_noisy_points_and_despite_outliers() {
        // Setup: a known perspective homography, 30 board points on a grid mapped through it with
        // +-0.2 px deterministic jitter, and a copy with 5 points moved 40 px away (misread ids).
        // Test: fit_homography on the clean set; fit_homography_ransac (5 px) on the spoiled one.
        // Verifies: the least-squares fit reprojects every clean point within 0.4 px, and RANSAC
        // ignores the 5 outliers: its fit reprojects the 25 good points within 0.4 px as well.
        let truth: Mat3 = [40.0, 3.0, 200.0, -2.0, 38.0, 120.0, 0.0004, -0.0003, 1.0];
        let mut src = Vec::new();
        let mut dst = Vec::new();

        for i in 0..6 {
            for j in 0..5 {
                let (x, y) = (i as f64 * 2.0 + 1.0, j as f64 * 2.0 + 1.0);
                let (u, v) = transform_f64(&truth, x, y);
                let jitter = (((i * 7 + j * 3) % 5) as f64 - 2.0) * 0.1;
                src.push((x, y));
                dst.push((u + jitter, v - jitter));
            }
        }

        let h = fit_homography(&src, &dst).unwrap();

        for (s, d) in src.iter().zip(&dst) {
            let (u, v) = transform_f64(&h, s.0, s.1);
            assert!(((u - d.0).powi(2) + (v - d.1).powi(2)).sqrt() < 0.4);
        }

        let mut spoiled = dst.clone();

        for k in [0, 7, 13, 21, 29] {
            spoiled[k].0 += 40.0;
        }

        let robust = fit_homography_ransac(&src, &spoiled, 5.0).unwrap();

        for k in 0..30 {
            if [0, 7, 13, 21, 29].contains(&k) {
                continue;
            }

            let (u, v) = transform_f64(&robust, src[k].0, src[k].1);
            assert!(((u - dst[k].0).powi(2) + (v - dst[k].1).powi(2)).sqrt() < 0.4, "point {k}");
        }
    }

    #[test]
    fn javascript_hypot_follows_v8() {
        // Setup: V8's Math.hypot results for a few argument pairs, as Chrome returns them
        // (Math.hypot(3, 4), Math.hypot(1e300, 1e300), Math.hypot(-0.1, 0.2), and the pair from the
        // marker the port was debugged on), and the special cases.
        // Test: js_hypot.
        // Verifies: the same doubles bit for bit (V8 scales by the larger value and sums with
        // Kahan compensation, which a C library's hypot does not), no overflow for huge values, and
        // V8's answers for infinity, NaN and zeros.
        assert_eq!(js_hypot(3.0, 4.0), 5.0);
        assert_eq!(js_hypot(1e300, 1e300), 1.4142135623730952e300);
        assert_eq!(js_hypot(-0.1, 0.2), 0.223606797749979);
        assert_eq!(js_hypot(f64::INFINITY, f64::NAN), f64::INFINITY);
        assert!(js_hypot(1.0, f64::NAN).is_nan());
        assert_eq!(js_hypot(0.0, -0.0), 0.0);
    }

    #[test]
    fn the_wasm_gemm_dot_product_reads_doubles_as_floats_as_opencv_js_does() {
        // Setup: vectors of 3, 4 and 6 doubles.
        // Test: opencv_wasm_gemm_dot against the true dot product, and against the float
        // reading it reproduces, computed by hand.
        // Verifies: below 4 elements nothing goes through the float path, so the result is the
        // true dot product; from 4 elements the first 4 "floats" are the low and high halves of
        // the first 2 doubles (so 1.0, whose low half is 0 and high half 1.875 as a float, reads as
        // 0 and 1.875), multiplied and summed in float, and the rest are the doubles they are --
        // the OpenCV 4.14 quirk opencv.js's findHomography ran on.
        let a = [1.0, 2.0, 3.0];
        assert_eq!(opencv_wasm_gemm_dot(&a, &a), 14.0);
        let f = |v: f64, hi: bool| f32::from_bits(if hi { (v.to_bits() >> 32) as u32 } else { v.to_bits() as u32 }) as f64;
        let b = [1.0, 2.0, 3.0, 4.0];
        // Floats 0..3: halves of 1.0 and 2.0; lanes reduced as (l0 + l2) + (l1 + l3).
        let lanes = [f(1.0, false).powi(2), f(1.0, true).powi(2), f(2.0, false).powi(2), f(2.0, true).powi(2)];
        let expected = ((lanes[0] + lanes[2]) + (lanes[1] + lanes[3])) as f32 as f64;
        assert_eq!(opencv_wasm_gemm_dot(&b, &b), expected);
        assert_ne!(expected, 30.0);
        let c = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        assert_eq!(opencv_wasm_gemm_dot(&c, &c), expected + 25.0 + 36.0);
    }

    #[test]
    fn a_four_point_homography_is_exact_and_a_degenerate_one_refused() {
        // Setup: four board points and their images under a perspective; four collinear points.
        // Test: find_homography (no LM refinement for exactly 4 pairs, as in OpenCV).
        // Verifies: each point maps onto its image to 1e-3 px with c22 = 1; and points on a line
        // (zero spread on one axis) give None instead of a meaningless matrix.
        let src = [Pt::new(0.0, 0.0), Pt::new(1.0, 0.0), Pt::new(1.0, 1.0), Pt::new(0.0, 1.0)];
        let dst = [Pt::new(10.0, 12.0), Pt::new(95.0, 8.0), Pt::new(101.0, 90.0), Pt::new(6.0, 85.0)];
        let h = find_homography(&src, &dst).unwrap();
        assert!((h[8] - 1.0).abs() < 1e-12);

        for k in 0..4 {
            assert!((transform(&h, src[k]) - dst[k]).norm_sqr().sqrt() < 1e-3, "point {k}");
        }

        let line = [Pt::new(0.0, 0.0), Pt::new(1.0, 0.0), Pt::new(2.0, 0.0), Pt::new(3.0, 0.0)];
        assert!(find_homography(&line, &dst).is_none());
    }
}
