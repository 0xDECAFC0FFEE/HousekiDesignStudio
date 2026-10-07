// Entry points for the tests that compare each stage of the detector with opencv.js
// while debugging a difference: the thresholded images, contours, a candidate's cells, the
// perspective and findHomography, and the markers before the board-guided refinement. Compiled
// only with the `debug-exports` feature (cargo build --features debug-exports ...), never into the
// phone's module. This is how the three opencv.js behaviours the port reproduces were found
// (kb: the phone vision wasm article).
//
// Copyright 2026 Lucas Tong. Licensed under the Apache License, Version 2.0 (see LICENSE).

use wasm_bindgen::prelude::*;

use crate::aruco::ArucoDetector;
use crate::contours::trace_contours;
use crate::gray::Gray;
use crate::threshold::{adaptive_thresholds, window_sizes, Integral};

fn grey_of(pixels: &[u8], width: u32, height: u32) -> Result<Gray, JsError> {
    Gray::from_pixels(pixels, width as usize, height as usize).ok_or_else(|| JsError::new("a frame must be grey or RGBA"))
}

/// The adaptive thresholds for windows 3..win_max step win_step, each width x height (unpadded),
/// concatenated.
#[wasm_bindgen]
pub fn debug_thresholds(pixels: &[u8], width: u32, height: u32, win_max: i32, win_step: i32) -> Result<Vec<u8>, JsError> {
    let grey = grey_of(pixels, width, height)?;
    let windows = window_sizes(3, win_max, win_step);
    let mut outs = Vec::new();
    adaptive_thresholds(&grey, &windows, 7.0, &mut Integral::default(), &mut outs);
    let (w, h) = (grey.width, grey.height);
    let mut all = Vec::with_capacity(windows.len() * w * h);

    for out in &outs {
        for y in 0..h {
            all.extend_from_slice(&out[(y + 1) * (w + 2) + 1..][..w]);
        }
    }

    Ok(all)
}

/// findContours(RETR_LIST, CHAIN_APPROX_NONE) of a binary image (0 / non-zero), in OpenCV's
/// order: [count, then per contour: n, x0, y0, x1, y1, ...].
#[wasm_bindgen]
pub fn debug_contours(binary: &[u8], width: u32, height: u32) -> Vec<i32> {
    let (w, h) = (width as usize, height as usize);
    let mut padded = vec![0u8; (w + 2) * (h + 2)];

    for y in 0..h {
        for x in 0..w {
            padded[(y + 1) * (w + 2) + x + 1] = if binary[y * w + x] != 0 { 255 } else { 0 };
        }
    }

    let mut found: Vec<Vec<(i32, i32)>> = Vec::new();
    trace_contours(&mut padded, w + 2, h + 2, |c| found.push(c.to_vec()));
    found.reverse();
    let mut out = vec![found.len() as i32];

    for c in &found {
        out.push(c.len() as i32);

        for &(x, y) in c {
            out.push(x);
            out.push(y);
        }
    }

    out
}

/// The 6 x 6 cell white ratios of the candidate with corners `c` (x0, y0, ... x3, y3), as
/// _extractCellPixelRatio reads them with the desktop's parameters, row-major; empty when the
/// perspective cannot be computed.
#[wasm_bindgen]
pub fn debug_cells(pixels: &[u8], width: u32, height: u32, c: &[f32]) -> Result<Vec<f32>, JsError> {
    use crate::linalg::Pt;
    let grey = grey_of(pixels, width, height)?;
    let corners = [Pt::new(c[0], c[1]), Pt::new(c[2], c[3]), Pt::new(c[4], c[5]), Pt::new(c[6], c[7])];
    let params = crate::marker::CellParams { pixel_per_cell: 8, margin_rate: 0.3, min_otsu_std: 5.0 };
    let mut scratch = Vec::new();
    Ok(crate::marker::cell_ratios(&grey, &corners, &params, &mut scratch).map(|r| r.to_vec()).unwrap_or_default())
}

/// getPerspectiveTransform(src -> dst) (4 points each, x0, y0, ...), row-major; empty if singular.
#[wasm_bindgen]
pub fn debug_perspective(src: &[f32], dst: &[f32]) -> Vec<f64> {
    use crate::linalg::{perspective_from_quads, Pt};
    let q = |v: &[f32]| [Pt::new(v[0], v[1]), Pt::new(v[2], v[3]), Pt::new(v[4], v[5]), Pt::new(v[6], v[7])];
    perspective_from_quads(&q(src), &q(dst)).map(|m| m.to_vec()).unwrap_or_default()
}

/// findHomography(src, dst, 0) (n points each, x0, y0, ...), row-major; empty when degenerate.
#[wasm_bindgen]
pub fn debug_find_homography(src: &[f32], dst: &[f32]) -> Vec<f64> {
    use crate::linalg::{find_homography, Pt};
    let pts = |v: &[f32]| v.chunks_exact(2).map(|p| Pt::new(p[0], p[1])).collect::<Vec<_>>();
    find_homography(&pts(src), &pts(dst)).map(|m| m.to_vec()).unwrap_or_default()
}

/// detectMarkers (no board refinement) for a board with `marker_count` markers: [accepted count,
/// per marker: id, 8 coords, rejected count, per candidate: 8 coords].
#[wasm_bindgen]
pub fn debug_markers(pixels: &[u8], width: u32, height: u32, marker_count: u32, win_max: i32, win_step: i32, min_perimeter_rate: f64) -> Result<Vec<f64>, JsError> {
    let grey = grey_of(pixels, width, height)?;
    let mut det = ArucoDetector::new(marker_count as usize);
    det.params.win_max = win_max;
    det.params.win_step = win_step;
    det.params.min_perimeter_rate = min_perimeter_rate;
    let (markers, rejected) = det.detect_markers(&grey);
    let mut out = vec![markers.len() as f64];

    for m in &markers {
        out.push(m.id as f64);
        m.corners.iter().for_each(|c| out.extend([c.x as f64, c.y as f64]));
    }

    out.push(rejected.len() as f64);

    for r in &rejected {
        r.iter().for_each(|c| out.extend([c.x as f64, c.y as f64]));
    }

    Ok(out)
}
