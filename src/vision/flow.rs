// Sparse optical flow for the phone's overlay (T-0332): pyramidal Lucas-Kanade tracking of a few
// dozen chessboard corners from one camera frame to the next, so the board's pose can be updated on
// the frames between two full detections (src/web/src/lib/vision/tracker.js does the pose).
//
// The method is the classic pyramidal Lucas-Kanade (J.-Y. Bouguet, "Pyramidal implementation of the
// Lucas Kanade feature tracker", Intel, 2000), written here from that description:
//
//   * each frame becomes a pyramid: level 0 the grey frame, each next level blurred with the 5-tap
//     binomial [1 4 6 4 1] / 16 in each direction and halved;
//   * a point is tracked coarse to fine: at each level, the window of (2 half + 1)^2 pixels around
//     it in the PREVIOUS frame (bilinear samples, gradients by central differences) is matched in
//     the NEXT frame by Gauss-Newton on the displacement (the 2 x 2 structure tensor G, inverted
//     once per level), starting from twice the coarser level's result;
//   * a point is lost when its window's smaller structure-tensor eigenvalue (per pixel) is below
//     MIN_EIGEN (no texture to track: flat paper), when it leaves the frame, or when the iteration
//     does not settle;
//   * the forward-backward check: each tracked point is tracked BACK into the previous frame; the
//     distance from where it started is its error, which the caller thresholds. A track that has
//     drifted onto another corner, or along an edge, does not come back to its start.
//
// No OpenCV code is ported here: chessboard corners are saddle points with strong gradients in two
// directions, and this plain form tracks them to a few hundredths of a pixel (the tests).
//
// Copyright 2026 Lucas Tong. Licensed under the Apache License, Version 2.0 (see LICENSE).

use crate::gray::Gray;

/// Window half-size (px): the window is 15 x 15.
pub const HALF: i32 = 7;
/// Pyramid levels (0 = full size): a 7 px window at level 3 reaches about 60 px of motion.
pub const LEVELS: usize = 4;
/// Gauss-Newton iterations per level, and the step (px) below which it has settled.
pub const MAX_ITERS: usize = 20;
pub const EPSILON: f32 = 0.01;
/// The smaller eigenvalue of the window's structure tensor per pixel (grey levels^2 / px^2) below
/// which a point has no texture to track.
pub const MIN_EIGEN: f32 = 1.0;

/// A grey image as f32, for sampling.
#[derive(Clone, Debug, Default)]
pub struct Plane {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
}

impl Plane {
    fn from_gray(g: &Gray) -> Plane {
        Plane { width: g.width, height: g.height, data: g.data.iter().map(|&v| v as f32).collect() }
    }

    /// Bilinear sample at (x, y), clamped to the image's edge.
    #[inline]
    pub fn sample(&self, x: f32, y: f32) -> f32 {
        let (w, h) = (self.width as i32, self.height as i32);
        let fx = x.floor();
        let fy = y.floor();
        let (ax, ay) = (x - fx, y - fy);
        let x0 = (fx as i32).clamp(0, w - 1) as usize;
        let y0 = (fy as i32).clamp(0, h - 1) as usize;
        let x1 = (fx as i32 + 1).clamp(0, w - 1) as usize;
        let y1 = (fy as i32 + 1).clamp(0, h - 1) as usize;
        let row0 = y0 * self.width;
        let row1 = y1 * self.width;
        let top = self.data[row0 + x0] + ax * (self.data[row0 + x1] - self.data[row0 + x0]);
        let bottom = self.data[row1 + x0] + ax * (self.data[row1 + x1] - self.data[row1 + x0]);
        top + ay * (bottom - top)
    }

    /// The next pyramid level: [1 4 6 4 1] / 16 in each direction (edges replicated), then every
    /// other pixel; (w + 1) / 2 x (h + 1) / 2.
    fn half(&self) -> Plane {
        let (w, h) = (self.width, self.height);
        let (nw, nh) = ((w + 1) / 2, (h + 1) / 2);
        let k = [1.0f32, 4.0, 6.0, 4.0, 1.0];
        // Horizontal pass, only at the kept columns.
        let mut rows = vec![0f32; nw * h];

        for y in 0..h {
            let src = &self.data[y * w..(y + 1) * w];

            for nx in 0..nw {
                let x = (2 * nx) as i64;
                let mut s = 0f32;

                for (j, kj) in k.iter().enumerate() {
                    let xx = (x + j as i64 - 2).clamp(0, w as i64 - 1) as usize;
                    s += kj * src[xx];
                }

                rows[y * nw + nx] = s / 16.0;
            }
        }

        // Vertical pass, only at the kept rows.
        let mut out = vec![0f32; nw * nh];

        for ny in 0..nh {
            let y = (2 * ny) as i64;

            for (j, kj) in k.iter().enumerate() {
                let yy = (y + j as i64 - 2).clamp(0, h as i64 - 1) as usize;
                let src = &rows[yy * nw..(yy + 1) * nw];
                let dst = &mut out[ny * nw..(ny + 1) * nw];

                for x in 0..nw {
                    dst[x] += kj * src[x];
                }
            }

            for v in &mut out[ny * nw..(ny + 1) * nw] {
                *v /= 16.0;
            }
        }

        Plane { width: nw, height: nh, data: out }
    }
}

/// A frame's pyramid.
#[derive(Clone, Debug, Default)]
pub struct Pyramid {
    pub levels: Vec<Plane>,
}

impl Pyramid {
    pub fn new(grey: &Gray, levels: usize) -> Pyramid {
        let mut out = vec![Plane::from_gray(grey)];

        while out.len() < levels.max(1) {
            let next = out.last().unwrap().half();

            if next.width < 2 * HALF as usize + 3 || next.height < 2 * HALF as usize + 3 {
                break;
            }

            out.push(next);
        }

        Pyramid { levels: out }
    }
}

/// One point's track: where it went (level-0 px, the same convention as the input) and whether it
/// was found.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Track {
    pub x: f32,
    pub y: f32,
    pub found: bool,
}

/// Tracks the point (x, y) of `prev` into `next`, starting from the displacement `guess` (level 0
/// px). Coordinates are pixel-centre ones (pixel (i, j)'s centre at (i, j)).
pub fn track_point(prev: &Pyramid, next: &Pyramid, x: f32, y: f32, guess: (f32, f32)) -> Track {
    let levels = prev.levels.len().min(next.levels.len());
    let n = (2 * HALF + 1) as usize;
    let side = n + 2;
    let mut window = vec![0f32; side * side];
    let mut ix = vec![0f32; n * n];
    let mut iy = vec![0f32; n * n];
    let mut tpl = vec![0f32; n * n];
    let top = (levels - 1) as i32;
    let scale = (1u32 << top) as f32;
    // the guess, at the coarsest level
    let (mut gx, mut gy) = (guess.0 / scale, guess.1 / scale);
    let lost = Track { x, y, found: false };

    for level in (0..levels).rev() {
        let k = (1u32 << level) as f32;
        let (px, py) = (x / k, y / k);
        let a = &prev.levels[level];
        let b = &next.levels[level];

        // The previous frame's window, one pixel wider all round for the central differences.
        for wy in 0..side {
            for wx in 0..side {
                window[wy * side + wx] = a.sample(px + (wx as i32 - HALF - 1) as f32, py + (wy as i32 - HALF - 1) as f32);
            }
        }

        let (mut gxx, mut gxy, mut gyy) = (0f32, 0f32, 0f32);

        for wy in 0..n {
            for wx in 0..n {
                let c = (wy + 1) * side + wx + 1;
                let dx = 0.5 * (window[c + 1] - window[c - 1]);
                let dy = 0.5 * (window[c + side] - window[c - side]);
                let i = wy * n + wx;
                ix[i] = dx;
                iy[i] = dy;
                tpl[i] = window[c];
                gxx += dx * dx;
                gxy += dx * dy;
                gyy += dy * dy;
            }
        }

        let area = (n * n) as f32;
        let det = gxx * gyy - gxy * gxy;
        let min_eigen = 0.5 * (gxx + gyy - ((gxx - gyy) * (gxx - gyy) + 4.0 * gxy * gxy).sqrt()) / area;

        if min_eigen < MIN_EIGEN || det.abs() < 1e-9 {
            return lost;
        }

        let (mut vx, mut vy) = (0f32, 0f32);
        let mut settled = false;

        for _ in 0..MAX_ITERS {
            let (cx, cy) = (px + gx + vx, py + gy + vy);
            let (mut bx, mut by) = (0f32, 0f32);

            for wy in 0..n {
                let sy = cy + (wy as i32 - HALF) as f32;

                for wx in 0..n {
                    let i = wy * n + wx;
                    let diff = tpl[i] - b.sample(cx + (wx as i32 - HALF) as f32, sy);
                    bx += diff * ix[i];
                    by += diff * iy[i];
                }
            }

            let ex = (gyy * bx - gxy * by) / det;
            let ey = (gxx * by - gxy * bx) / det;
            vx += ex;
            vy += ey;

            if ex * ex + ey * ey < EPSILON * EPSILON {
                settled = true;
                break;
            }
        }

        if !settled && level == 0 {
            return lost;
        }

        if level > 0 {
            gx = 2.0 * (gx + vx);
            gy = 2.0 * (gy + vy);
        } else {
            gx += vx;
            gy += vy;
        }
    }

    let (nx, ny) = (x + gx, y + gy);
    let (w, h) = (next.levels[0].width as f32, next.levels[0].height as f32);

    if !(nx >= 0.0 && ny >= 0.0 && nx <= w - 1.0 && ny <= h - 1.0) {
        return lost;
    }

    Track { x: nx, y: ny, found: true }
}

/// The tracker the phone's Worker keeps: the last frame's pyramid, and the one before it.
#[derive(Default)]
pub struct PointTracker {
    prev: Option<Pyramid>,
    next: Option<Pyramid>,
}

/// One point tracked forward and back: the new position, whether it was found both ways, and the
/// forward-backward error (px, the distance between the start and the back-tracked point).
#[derive(Clone, Copy, Debug)]
pub struct Tracked {
    pub x: f32,
    pub y: f32,
    pub found: bool,
    pub fb_error: f32,
}

impl PointTracker {
    /// Takes the next frame (its pyramid is built now); the one before becomes the previous.
    pub fn push(&mut self, grey: &Gray) {
        self.prev = self.next.take();
        self.next = Some(Pyramid::new(grey, LEVELS));
    }

    /// Forgets both frames (after a change of frame size, say).
    pub fn clear(&mut self) {
        self.prev = None;
        self.next = None;
    }

    /// Whether there are two frames to track between, of the same size.
    pub fn ready(&self) -> bool {
        match (&self.prev, &self.next) {
            (Some(a), Some(b)) => a.levels[0].width == b.levels[0].width && a.levels[0].height == b.levels[0].height,
            _ => false,
        }
    }

    /// Tracks points of the previous frame into the latest one, and back, with no guess.
    pub fn track(&self, points: &[(f32, f32)]) -> Vec<Tracked> {
        self.track_guided(points, &vec![(0.0, 0.0); points.len()])
    }

    /// Tracks points of the previous frame into the latest one, each starting from a guessed
    /// displacement (px; the overlay's predicted motion: without one, a motion of more than about
    /// half a printed square ends on a neighbouring corner), and back from where it landed.
    pub fn track_guided(&self, points: &[(f32, f32)], guesses: &[(f32, f32)]) -> Vec<Tracked> {
        let (Some(prev), Some(next)) = (&self.prev, &self.next) else {
            return points.iter().map(|&(x, y)| Tracked { x, y, found: false, fb_error: f32::INFINITY }).collect();
        };

        if !self.ready() {
            return points.iter().map(|&(x, y)| Tracked { x, y, found: false, fb_error: f32::INFINITY }).collect();
        }

        points.iter().zip(guesses).map(|(&(x, y), &guess)| {
            let forward = track_point(prev, next, x, y, guess);

            if !forward.found {
                return Tracked { x, y, found: false, fb_error: f32::INFINITY };
            }

            let back = track_point(next, prev, forward.x, forward.y, (x - forward.x, y - forward.y));
            let fb_error = if back.found { (back.x - x).hypot(back.y - y) } else { f32::INFINITY };
            Tracked { x: forward.x, y: forward.y, found: back.found, fb_error }
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A smooth chessboard (squares of `square` px, edges softened over ~1.5 px), shifted by
    /// (dx, dy) px: a stand-in for the printed board's corners.
    fn chessboard(width: usize, height: usize, square: f32, dx: f32, dy: f32) -> Gray {
        let mut data = vec![0u8; width * height];

        for y in 0..height {
            for x in 0..width {
                let u = (x as f32 - dx) / square;
                let v = (y as f32 - dy) / square;
                // a smooth square wave in each direction, their product: +1 / -1 squares
                let su = (std::f32::consts::PI * u).sin();
                let sv = (std::f32::consts::PI * v).sin();
                let s = (3.0 * square / 4.0 * su * sv).tanh();
                data[y * width + x] = (128.0 + 100.0 * s) as u8;
            }
        }

        Gray::from_grey(data, width, height)
    }

    #[test]
    fn the_pyramid_halves_each_level_and_keeps_the_mean() {
        // Setup: a 101 x 61 grey image of constant 90 and a 160 x 120 chessboard.
        // Test: build 4-level pyramids.
        // Verifies: sizes (w + 1) / 2 each level, stopping before a level too small for the 15 px
        // window and its border (101 x 61 -> 51 x 31; 26 x 16 would be under 17 px); a constant image stays
        // exactly constant (the binomial kernel sums to 1, edges replicated); the chessboard's mean
        // grey is kept within 1 level at every level (no brightening or darkening by the blur).
        let flat = Pyramid::new(&Gray::filled(101, 61, 90), LEVELS);
        let sizes: Vec<(usize, usize)> = flat.levels.iter().map(|p| (p.width, p.height)).collect();
        assert_eq!(sizes, vec![(101, 61), (51, 31)]);
        assert!(flat.levels.iter().all(|p| p.data.iter().all(|&v| (v - 90.0).abs() < 1e-4)));

        let board = Pyramid::new(&chessboard(160, 120, 20.0, 3.0, 5.0), LEVELS);
        let mean = |p: &Plane| p.data.iter().sum::<f32>() / p.data.len() as f32;
        let m0 = mean(&board.levels[0]);

        for p in &board.levels[1..] {
            assert!((mean(p) - m0).abs() < 1.0, "{} vs {}", mean(p), m0);
        }
    }

    #[test]
    fn corners_are_tracked_to_a_few_hundredths_of_a_pixel_and_back() {
        // Setup: a chessboard of 24 px squares in a 320 x 240 frame, and the same board moved by
        // (+6.4, -3.7) px (a frame later, the phone moving). The corners (saddle points) of the first.
        // Test: push both frames, track every inner corner forward and back.
        // Verifies: every corner is found, lands within 0.05 px of where it moved to, and comes back
        // within 0.05 px of its start (the forward-backward error the caller thresholds).
        let (dx, dy) = (6.4f32, -3.7f32);
        let mut tracker = PointTracker::default();
        tracker.push(&chessboard(320, 240, 24.0, 10.0, 12.0));
        tracker.push(&chessboard(320, 240, 24.0, 10.0 + dx, 12.0 + dy));
        let mut points = Vec::new();

        for j in 2..9 {
            for i in 2..12 {
                points.push((10.0 + 24.0 * i as f32, 12.0 + 24.0 * j as f32));
            }
        }

        let tracked = tracker.track(&points);

        for (p, t) in points.iter().zip(&tracked) {
            assert!(t.found, "lost {p:?}");
            assert!((t.x - p.0 - dx).abs() < 0.05 && (t.y - p.1 - dy).abs() < 0.05, "{p:?} -> {t:?}");
            assert!(t.fb_error < 0.05, "fb {}", t.fb_error);
        }
    }

    #[test]
    fn a_motion_beyond_the_window_is_found_through_the_pyramid_and_a_guess_reaches_further() {
        // Setup: a board of 40 px squares moved by (-11, +8) px between frames (more than the 7 px
        // window's half), and again by (-38, +27) px (~47 px: further than half a square).
        // Test: track a corner near the middle without a guess, then the large motion without and
        // with a guess near the truth (the overlay's predicted motion, (-35, +25)).
        // Verifies: the coarse levels take the bulk of a motion the window alone could not (found
        // within 0.1 px). A chessboard repeats every square: a motion of more than about half a
        // square, unguided, ends on ANOTHER corner, and the forward-backward check cannot tell (the
        // wrong corner tracks back just as well) -- so the caller must pass the predicted motion as
        // the guess, which brings the large motion within 0.1 px too.
        let mut tracker = PointTracker::default();
        tracker.push(&chessboard(400, 300, 40.0, 10.0, 12.0));
        tracker.push(&chessboard(400, 300, 40.0, 10.0 - 11.0, 12.0 + 8.0));
        let corner = (10.0 + 40.0 * 5.0, 12.0 + 40.0 * 3.0);
        let t = tracker.track(&[corner])[0];
        assert!(t.found && (t.x - (corner.0 - 11.0)).abs() < 0.1 && (t.y - (corner.1 + 8.0)).abs() < 0.1, "{t:?}");

        let mut tracker = PointTracker::default();
        tracker.push(&chessboard(400, 300, 40.0, 10.0, 12.0));
        tracker.push(&chessboard(400, 300, 40.0, 10.0 - 38.0, 12.0 + 27.0));
        let unguided = tracker.track(&[corner])[0];
        assert!(!unguided.found || (unguided.x - (corner.0 - 38.0)).abs() > 5.0, "aliasing was expected: {unguided:?}");
        let guided = tracker.track_guided(&[corner], &[(-35.0, 25.0)])[0];
        assert!(guided.found && (guided.x - (corner.0 - 38.0)).abs() < 0.1 && (guided.y - (corner.1 + 27.0)).abs() < 0.1, "{guided:?}");
    }

    #[test]
    fn flat_paper_and_points_leaving_the_frame_are_lost() {
        // Setup: a plain grey frame (no texture), then a board moved so that a corner near the
        // right edge leaves the frame.
        // Test: track a point on the flat frame; track the edge corner.
        // Verifies: the flat point is not "found" (its structure tensor is empty: anything would
        // fit); the corner that left the frame is lost, not clamped to the edge; with only one frame
        // pushed nothing is tracked.
        let mut tracker = PointTracker::default();
        tracker.push(&Gray::filled(200, 150, 128));
        assert!(!tracker.ready() && !tracker.track(&[(50.0, 50.0)])[0].found, "one frame only");
        tracker.push(&Gray::filled(200, 150, 128));
        assert!(!tracker.track(&[(100.0, 75.0)])[0].found, "flat paper");

        let mut tracker = PointTracker::default();
        tracker.push(&chessboard(200, 150, 20.0, 0.0, 0.0));
        tracker.push(&chessboard(200, 150, 20.0, 6.0, 0.0));
        let t = tracker.track_guided(&[(196.0, 80.0)], &[(6.0, 0.0)])[0];
        assert!(!t.found, "{t:?}");
    }
}
