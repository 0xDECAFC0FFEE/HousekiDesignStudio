// The phone scanner's vision in WebAssembly (T-0330): the ChArUco board detector and the QR code
// reader the phone page (src/web/scanner) runs on camera frames, replacing opencv.js for both.
//
// What is ported from OpenCV 4.14.0 (Apache-2.0; each file names its sources and carries the
// licence header) and what is this project's:
//
//   gray.rs       RGBA -> grey (OpenCV's COLOR_RGBA2GRAY)
//   resize.rs     INTER_AREA resizing
//   threshold.rs  ArUco's adaptive thresholds, all windows over one integral image
//   contours.rs   findContours (RETR_LIST, CHAIN_APPROX_NONE: 4.14's TRUCO tracer)
//   polygon.rs    approxPolyDP, isContourConvex, pointPolygonTest
//   linalg.rs     LU solve, getPerspectiveTransform, invert, perspectiveTransform, homography fits
//   marker.rs     a candidate's bits (warp, Otsu, cell ratios, border errors)
//   dictionary.rs DICT_4X4_250, with the board's markers in a look-up table
//   aruco.rs      marker detection and refineDetectedMarkers
//   subpix.rs     cornerSubPix and getRectSubPix
//   charuco.rs    the ChArUco board, corner interpolation and refinement
//   sharpness.rs  corner sharpness (the desktop's Laplacian variance)
//   board.rs      one frame's work, as board_detect.js (and HousekiScanner) did it
//   flow.rs       pyramidal Lucas-Kanade tracking of corners between frames (T-0332; this
//                 project's own, from Bouguet's description)
//   qr.rs         QR codes, with rqrr (MIT OR Apache-2.0)
//
// The JavaScript side (src/web/src/lib/vision/board_detect.js, qr_detect.js and vision_wasm.js)
// wraps this API in the BoardDetection and QR shapes the rest of the phone's vision uses.

pub mod aruco;
pub mod board;
pub mod charuco;
pub mod contours;
// Stage-by-stage entry points for comparing with opencv.js while debugging; not in the shipped
// module (build with `--features debug-exports` to get them).
#[cfg(feature = "debug-exports")]
pub mod debug;
pub mod dictionary;
pub mod flow;
pub mod gray;
pub mod linalg;
pub mod marker;
pub mod polygon;
pub mod qr;
pub mod resize;
pub mod sharpness;
pub mod subpix;
pub mod threshold;

use wasm_bindgen::prelude::*;

use board::{BoardDetector, FrameOptions};
use gray::Gray;

/// The ChArUco detector for one board (current pattern, DICT_4X4_250), kept across frames.
#[wasm_bindgen]
pub struct CharucoDetector {
    inner: BoardDetector,
    /// The region the next detect() looks in (set_roi), then cleared.
    roi: Option<(usize, usize, usize, usize)>,
}

#[wasm_bindgen]
impl CharucoDetector {
    /// A detector for a `squares_x` x `squares_y` board whose markers are `marker_ratio` of a
    /// square. The board's markers must all be in DICT_4X4_250 (at most 250); larger boards are
    /// refused.
    #[wasm_bindgen(constructor)]
    pub fn new(squares_x: u32, squares_y: u32, marker_ratio: f32) -> Result<CharucoDetector, JsError> {
        let (sx, sy) = (squares_x as usize, squares_y as usize);

        if sx < 2 || sy < 2 || !(marker_ratio > 0.0 && marker_ratio < 1.0) {
            return Err(JsError::new("a ChArUco board needs at least 2 x 2 squares and a marker ratio between 0 and 1"));
        }

        if (sx * sy) / 2 > dictionary::DICT_4X4_250.len() {
            return Err(JsError::new("this board has more markers than DICT_4X4_250"));
        }

        Ok(CharucoDetector { inner: BoardDetector::new(sx, sy, marker_ratio), roi: None })
    }

    /// The phone's fast path (T-0332), or OpenCV's exact behaviour (false, the default): when on,
    /// the board-guided search for missed markers looks only within 0.4 of each projected
    /// marker's size (aruco.rs local_refine). Results then differ from opencv.js's (measured: as
    /// many corners or more, as accurate; board_detect.js FAST_PATH).
    pub fn set_fast(&mut self, enabled: bool) {
        self.set_fast_parts(true, enabled);
    }

    /// The fast path's parts one by one (for measuring them): `retry_close` (OpenCV: true; false
    /// does not read a failed candidate's near-duplicates from the other threshold windows) and
    /// `local_refine` (OpenCV: false).
    pub fn set_fast_parts(&mut self, retry_close: bool, local_refine: bool) {
        self.inner.aruco.params.retry_close = retry_close;
        self.inner.aruco.params.local_refine = local_refine;
    }

    /// Look only in this region of the work image (x, y, width, height, work pixels) in the NEXT
    /// detect(); a zero width or height clears it. The results stay in the whole image's pixels.
    pub fn set_roi(&mut self, x: u32, y: u32, width: u32, height: u32) {
        self.roi = if width > 0 && height > 0 { Some((x as usize, y as usize, width as usize, height as usize)) } else { None };
    }

    /// What the last detect() did: [raw candidates, after filterTooClose, cell readings to
    /// identify, readings in the refinement].
    pub fn last_stats(&self) -> Vec<u32> {
        let s = self.inner.aruco.stats;
        vec![s.raw as u32, s.selected as u32, s.identify_reads as u32, s.refine_reads as u32]
    }

    /// The parameters for the desktop's marker-size factor m (board_detect.js
    /// detectorParamValues and refineParamValues): adaptive-threshold windows 3..win_max step
    /// win_step, minimum marker perimeter rate, and the refinement distance.
    pub fn configure(&mut self, win_max: i32, win_step: i32, min_perimeter_rate: f64, min_rep_distance: f32) {
        let p = &mut self.inner.aruco.params;
        p.win_min = 3;
        p.win_max = win_max.max(3);
        p.win_step = win_step.max(1);
        p.min_perimeter_rate = min_perimeter_rate;
        self.inner.aruco.refine.min_rep_distance = min_rep_distance;
    }

    /// Whether to look for missed markers where the found ones predict them (OpenCV's
    /// tryRefineMarkers; on by default, as the desktop runs it).
    pub fn set_try_refine(&mut self, enabled: bool) {
        self.inner.try_refine = enabled;
    }

    /// Markers the sheet does not print: detections of them are dropped.
    pub fn set_removed(&mut self, ids: &[u32]) {
        let ids: Vec<usize> = ids.iter().map(|&i| i as usize).collect();
        self.inner.set_removed(&ids);
    }

    /// Detects the board in a frame of `width` x `height` pixels, given as grey (1 byte per
    /// pixel) or RGBA (4). Returns the result packed into numbers, in the work image's pixels
    /// with OpenCV's convention (pixel centres on integers):
    ///
    ///   [workWidth, workHeight, anyMarker (0/1), markerPx (NaN: none),
    ///    markerCount, then per marker: id, x0, y0, x1, y1, x2, y2, x3, y3,
    ///    cornerCount, then per corner: id, x, y, markers (1 or 2), sharpness (NaN: not measured)]
    #[allow(clippy::too_many_arguments)]
    pub fn detect(
        &mut self,
        pixels: &[u8],
        width: u32,
        height: u32,
        processing_scale: f64,
        single_marker_corners: bool,
        refine_blurred: bool,
        desktop_half_pixel_shift: bool,
        max_half: i32,
    ) -> Result<Vec<f64>, JsError> {
        let grey = Gray::from_pixels(pixels, width as usize, height as usize)
            .ok_or_else(|| JsError::new("a frame must be grey (1 byte per pixel) or RGBA (4)"))?;
        let options = FrameOptions {
            processing_scale: if processing_scale > 0.0 && processing_scale <= 1.0 { processing_scale } else { 1.0 },
            single_marker_corners,
            refine_blurred,
            desktop_half_pixel_shift,
            max_half: max_half.max(3) as i64,
            roi: self.roi.take(),
        };
        Ok(pack(&self.inner.detect(&grey, &options)))
    }
}

/// Sparse optical flow between consecutive processed frames (T-0332, flow.rs): the phone's Worker
/// pushes every frame it processes (detected or tracked) and tracks the last pose's corners from
/// the previous one into it.
#[wasm_bindgen]
pub struct FrameTracker {
    inner: flow::PointTracker,
}

#[wasm_bindgen]
impl FrameTracker {
    #[wasm_bindgen(constructor)]
    pub fn new() -> FrameTracker {
        FrameTracker { inner: flow::PointTracker::default() }
    }

    /// The next frame, grey (1 byte per pixel) or RGBA (4): its pyramid is built now, and the frame
    /// pushed before it becomes the one points are tracked from.
    pub fn push(&mut self, pixels: &[u8], width: u32, height: u32) -> Result<(), JsError> {
        let grey = Gray::from_pixels(pixels, width as usize, height as usize)
            .ok_or_else(|| JsError::new("a frame must be grey (1 byte per pixel) or RGBA (4)"))?;
        self.inner.push(&grey);
        Ok(())
    }

    /// Forgets the frames pushed.
    pub fn clear(&mut self) {
        self.inner.clear();
    }

    /// Whether two frames of the same size are there to track between.
    pub fn ready(&self) -> bool {
        self.inner.ready()
    }

    /// Tracks points (x, y pairs, pixel centres on integers, in the frames' pixels) from the
    /// previous frame into the last, each from a guessed displacement (dx, dy pairs; empty: none),
    /// and back. Returns 4 numbers per point: x, y, found (0 / 1), forward-backward error (px).
    pub fn track(&self, points: &[f32], guesses: &[f32]) -> Vec<f32> {
        let pts: Vec<(f32, f32)> = points.chunks_exact(2).map(|p| (p[0], p[1])).collect();
        let gs: Vec<(f32, f32)> = if guesses.len() == points.len() {
            guesses.chunks_exact(2).map(|g| (g[0], g[1])).collect()
        } else {
            vec![(0.0, 0.0); pts.len()]
        };
        let mut out = Vec::with_capacity(4 * pts.len());

        for t in self.inner.track_guided(&pts, &gs) {
            out.extend([t.x, t.y, t.found as u8 as f32, t.fb_error]);
        }

        out
    }
}

impl Default for FrameTracker {
    fn default() -> Self {
        FrameTracker::new()
    }
}

/// CharucoDetector::detect's packed layout.
pub fn pack(r: &board::FrameResult) -> Vec<f64> {
    let mut out = Vec::with_capacity(6 + 9 * r.markers.len() + 5 * r.corners.len());
    out.extend([r.work_width as f64, r.work_height as f64, r.any_marker as u8 as f64, r.marker_px]);
    out.push(r.markers.len() as f64);

    for m in &r.markers {
        out.push(m.id as f64);

        for c in &m.corners {
            out.push(c.x as f64);
            out.push(c.y as f64);
        }
    }

    out.push(r.corners.len() as f64);

    for c in &r.corners {
        out.extend([c.id as f64, c.x, c.y, c.markers as f64, c.sharpness]);
    }

    out
}

/// The QR codes in a frame (grey or RGBA), read on a copy downscaled by `processing_scale`
/// (INTER_AREA) when it is below 1.
#[wasm_bindgen]
pub struct QrReader {
    texts: Vec<String>,
    corners: Vec<f64>,
}

#[wasm_bindgen]
impl QrReader {
    #[wasm_bindgen(constructor)]
    pub fn new() -> QrReader {
        QrReader { texts: Vec::new(), corners: Vec::new() }
    }

    /// Reads a frame; returns the number of codes found (then `text(i)` and `corners()`).
    pub fn read(&mut self, pixels: &[u8], width: u32, height: u32, processing_scale: f64) -> Result<u32, JsError> {
        let grey = Gray::from_pixels(pixels, width as usize, height as usize)
            .ok_or_else(|| JsError::new("a frame must be grey (1 byte per pixel) or RGBA (4)"))?;
        self.read_grey(&grey, processing_scale);
        Ok(self.texts.len() as u32)
    }

    /// The text of code `i` of the last read.
    pub fn text(&self, i: u32) -> String {
        self.texts.get(i as usize).cloned().unwrap_or_default()
    }

    /// The corners of every code of the last read, 8 numbers per code (x, y of top-left,
    /// top-right, bottom-right, bottom-left), full-frame pixels, corner-origin convention
    /// (types.js: OpenCV's coordinates + 0.5).
    pub fn corners(&self) -> Vec<f64> {
        self.corners.clone()
    }
}

impl QrReader {
    fn read_grey(&mut self, grey: &Gray, processing_scale: f64) {
        let small;
        let (work, sx, sy) = if processing_scale > 0.0 && processing_scale < 1.0 {
            let w = sharpness::js_round(grey.width as f64 * processing_scale).max(1) as usize;
            let h = sharpness::js_round(grey.height as f64 * processing_scale).max(1) as usize;
            small = resize::resize_area(grey, w, h);
            (&small, grey.width as f64 / w as f64, grey.height as f64 / h as f64)
        } else {
            (grey, 1.0, 1.0)
        };
        self.texts.clear();
        self.corners.clear();

        for code in qr::read_qr_codes(work) {
            self.texts.push(code.text);

            for c in &code.corners {
                self.corners.push((c.x as f64 + 0.5) * sx);
                self.corners.push((c.y as f64 + 0.5) * sy);
            }
        }
    }
}

impl Default for QrReader {
    fn default() -> Self {
        QrReader::new()
    }
}
