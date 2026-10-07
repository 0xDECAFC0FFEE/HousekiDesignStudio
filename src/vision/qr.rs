// QR code reading for the phone page: every code in a frame, its text and its four corners.
//
// Detection and decoding are rqrr's (a Rust port of quirc; MIT OR Apache-2.0), the same decoder
// family opencv.js used (OpenCV's QRCodeDetector decodes with quirc too). rqrr reports a code's
// bounds as whole pixels at grid coordinates (0, 0) and (size + 1, size + 1), one module beyond
// the code; the corners here are the code's own outer corners, (0, 0) .. (size, size), mapped
// through the perspective those four bounds define, so they are not rounded to whole pixels and
// do not overshoot. Like OpenCV's, they are in pixel-centre coordinates and in the order
// top-left, top-right, bottom-right, bottom-left of the code as printed.
//
// Copyright 2026 Lucas Tong. Licensed under the Apache License, Version 2.0 (see LICENSE).

use crate::gray::Gray;
use crate::linalg::{perspective_from_quads, transform, Pt};
use rqrr::BitGrid;

/// A decoded code: its text and corners (pixel-centre coordinates).
#[derive(Clone, Debug)]
pub struct QrCode {
    pub text: String,
    pub corners: [Pt; 4],
}

/// Every QR code rqrr finds and decodes in `grey`; codes it locates but cannot decode are left
/// out (as qr_detect.js left out a code with no text).
pub fn read_qr_codes(grey: &Gray) -> Vec<QrCode> {
    let mut img = rqrr::PreparedImage::prepare_from_greyscale(grey.width, grey.height, |x, y| grey.data[y * grey.width + x]);
    let mut out = Vec::new();

    for grid in img.detect_grids() {
        let Ok((_, text)) = grid.decode() else { continue };
        let n = grid.grid.size() as f32;
        let b = grid.bounds;
        let bounds = [
            Pt::new(b[0].x as f32, b[0].y as f32),
            Pt::new(b[1].x as f32, b[1].y as f32),
            Pt::new(b[2].x as f32, b[2].y as f32),
            Pt::new(b[3].x as f32, b[3].y as f32),
        ];
        let m = n + 1.0;
        let grid_square = [Pt::new(0.0, 0.0), Pt::new(m, 0.0), Pt::new(m, m), Pt::new(0.0, m)];

        let corners = match perspective_from_quads(&grid_square, &bounds) {
            Some(h) => [
                transform(&h, Pt::new(0.0, 0.0)),
                transform(&h, Pt::new(n, 0.0)),
                transform(&h, Pt::new(n, n)),
                transform(&h, Pt::new(0.0, n)),
            ],
            None => bounds,
        };

        out.push(QrCode { text, corners });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // A frame of `width` x `height` (mid grey 120) with `text` as a QR code of `module` px per
    // module (ink 20, paper 240, a 4-module quiet zone) whose quiet zone starts at (x0, y0).
    // Returns the frame and the code's outer corners without the quiet zone, in pixel-centre
    // coordinates (an edge at pixel boundary e is at e - 0.5).
    fn frame_with_code(text: &str, width: usize, height: usize, x0: usize, y0: usize, module: usize) -> (Gray, [Pt; 4]) {
        let code = qrcode::QrCode::new(text.as_bytes()).unwrap();
        let n = code.width();
        let colors = code.to_colors();
        let mut img = Gray::filled(width, height, 120);
        let side = (n + 8) * module;

        for y in 0..side {
            for x in 0..side {
                let (mx, my) = (x / module, y / module);
                let dark = mx >= 4 && my >= 4 && mx < n + 4 && my < n + 4 && colors[(my - 4) * n + mx - 4] == qrcode::Color::Dark;
                img.data[(y0 + y) * width + x0 + x] = if dark { 20 } else { 240 };
            }
        }

        let a = (4 * module) as f32 - 0.5;
        let b = ((n + 4) * module) as f32 - 0.5;
        let (ox, oy) = (x0 as f32, y0 as f32);
        (img, [Pt::new(ox + a, oy + a), Pt::new(ox + b, oy + a), Pt::new(ox + b, oy + b), Pt::new(ox + a, oy + b)])
    }

    #[test]
    fn a_code_is_decoded_with_its_corners_in_reading_order() {
        // Setup: a link like the studio's pairing link encoded at 4 px per module in a 400 x 360
        // frame, then the same at 6 px per module.
        // Test: read_qr_codes.
        // Verifies: one code each time, its text byte for byte, and its corners -- top-left,
        // top-right, bottom-right, bottom-left of the code as printed -- within 2 px of the code's
        // true outer corners (not rqrr's bounds, which lie a module further out).
        let text = "https://houseki.app/scanner/#v=1&r=0011223344556677&p=8899aabbccddeeff";

        for module in [4, 6] {
            let (img, truth) = frame_with_code(text, 400, 360, 20, 10, module);
            let found = read_qr_codes(&img);
            assert_eq!(found.len(), 1, "module {module}");
            assert_eq!(found[0].text, text);

            for k in 0..4 {
                let d = (found[0].corners[k] - truth[k]).norm_sqr().sqrt();
                assert!(d < 2.0, "module {module}, corner {k}: {:?} vs {:?}", found[0].corners[k], truth[k]);
            }
        }
    }

    #[test]
    fn a_frame_without_a_code_reads_nothing() {
        // Setup: a plain grey frame and a frame of fine stripes (texture, no finder patterns).
        // Test: read_qr_codes.
        // Verifies: no code is reported (no false decode, no panic).
        assert!(read_qr_codes(&Gray::filled(200, 150, 120)).is_empty());
        let stripes = Gray::from_grey((0..200 * 150).map(|i| if (i % 200) / 3 % 2 == 0 { 30 } else { 220 }).collect(), 200, 150);
        assert!(read_qr_codes(&stripes).is_empty());
    }
}
