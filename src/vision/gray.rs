// A grey 8-bit image, and the conversion of camera frames to it.
//
// The RGBA -> grey conversion is OpenCV's COLOR_RGBA2GRAY for 8-bit images, ported from OpenCV
// 4.14.0 modules/imgproc/src/color_rgb.simd.hpp (RGB2Gray<uchar>) and color.simd_helpers.hpp
// (the 15-bit coefficients), so the phone's frames turn into the same grey pixels opencv.js made.
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

/// A grey image, one byte per pixel, rows packed without padding.
#[derive(Clone, Debug, PartialEq)]
pub struct Gray {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// OpenCV's fixed-point grey coefficients (R2YF, G2YF, B2YF x 2^15, rounded), and their shift.
const RY15: u32 = 9798;
const GY15: u32 = 19235;
const BY15: u32 = 3735;
const GRAY_SHIFT: u32 = 15;

impl Gray {
    /// A `width` x `height` image filled with `value`.
    pub fn filled(width: usize, height: usize, value: u8) -> Gray {
        Gray { width, height, data: vec![value; width * height] }
    }

    /// Wraps grey pixels (row-major, `width` x `height`).
    pub fn from_grey(data: Vec<u8>, width: usize, height: usize) -> Gray {
        assert_eq!(data.len(), width * height, "grey data does not match its size");
        Gray { width, height, data }
    }

    /// Grey from RGBA pixels (a canvas ImageData), as OpenCV's COLOR_RGBA2GRAY:
    /// (R 9798 + G 19235 + B 3735 + 2^14) >> 15. The alpha byte is ignored.
    pub fn from_rgba(rgba: &[u8], width: usize, height: usize) -> Gray {
        assert_eq!(rgba.len(), 4 * width * height, "RGBA data does not match its size");
        let mut data = vec![0u8; width * height];

        for (out, px) in data.iter_mut().zip(rgba.chunks_exact(4)) {
            let y = px[0] as u32 * RY15 + px[1] as u32 * GY15 + px[2] as u32 * BY15 + (1 << (GRAY_SHIFT - 1));
            *out = (y >> GRAY_SHIFT) as u8;
        }

        Gray { width, height, data }
    }

    /// Grey from a frame of 1 (grey) or 4 (RGBA) bytes per pixel; None for any other layout.
    pub fn from_pixels(pixels: &[u8], width: usize, height: usize) -> Option<Gray> {
        if width == 0 || height == 0 {
            return None;
        }

        if pixels.len() == width * height {
            Some(Gray::from_grey(pixels.to_vec(), width, height))
        } else if pixels.len() == 4 * width * height {
            Some(Gray::from_rgba(pixels, width, height))
        } else {
            None
        }
    }

    /// The `w` x `h` region at (x, y), clamped to the image (at least 1 x 1).
    pub fn crop(&self, x: usize, y: usize, w: usize, h: usize) -> Gray {
        let x = x.min(self.width - 1);
        let y = y.min(self.height - 1);
        let w = w.clamp(1, self.width - x);
        let h = h.clamp(1, self.height - y);
        let mut data = Vec::with_capacity(w * h);

        for row in y..y + h {
            data.extend_from_slice(&self.data[row * self.width + x..row * self.width + x + w]);
        }

        Gray { width: w, height: h, data }
    }

    #[inline]
    pub fn at(&self, x: usize, y: usize) -> u8 {
        self.data[y * self.width + x]
    }

    #[inline]
    pub fn row(&self, y: usize) -> &[u8] {
        &self.data[y * self.width..(y + 1) * self.width]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba_to_grey_uses_opencvs_fixed_point_weights() {
        // Setup: five RGBA pixels -- pure red, green, blue, white, and a mid grey with an alpha
        // that must be ignored.
        // Test: convert them.
        // Verifies: each grey value is OpenCV's (R 9798 + G 19235 + B 3735 + 16384) >> 15, so
        // pure red is 76 (0.299 x 255 rounded), green 150, blue 29, white stays 255 (the weights
        // sum to exactly 2^15) and a grey stays the same grey whatever its alpha.
        let rgba = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 128, 128, 128, 7];
        let grey = Gray::from_rgba(&rgba, 5, 1);
        assert_eq!(grey.data, vec![76, 150, 29, 255, 128]);
    }

    #[test]
    fn a_crop_is_the_region_and_is_clamped_to_the_image() {
        // Setup: a 4 x 3 image whose pixel (x, y) is 10 y + x.
        // Test: crop (1, 1, 2, 2); crop past the right and bottom edges; crop wholly outside.
        // Verifies: the region's pixels in order; a region over an edge is cut at it; a region
        // starting outside is moved to the last pixel, never empty (1 x 1).
        let g = Gray::from_grey((0..3).flat_map(|y| (0..4).map(move |x| (10 * y + x) as u8)).collect(), 4, 3);
        assert_eq!(g.crop(1, 1, 2, 2).data, vec![11, 12, 21, 22]);
        let edge = g.crop(2, 1, 5, 5);
        assert_eq!((edge.width, edge.height, edge.data.clone()), (2, 2, vec![12, 13, 22, 23]));
        let outside = g.crop(9, 9, 3, 3);
        assert_eq!((outside.width, outside.height, outside.data), (1, 1, vec![23]));
    }

    #[test]
    fn frames_of_one_or_four_bytes_per_pixel_are_accepted_and_others_refused() {
        // Setup: a 2 x 2 frame as grey bytes, as RGBA bytes, and as 3 bytes per pixel (RGB).
        // Test: from_pixels on each, and on an empty size.
        // Verifies: grey passes through unchanged, RGBA is converted, and RGB or a zero size is
        // refused (None) rather than misread -- the JS wrapper turns None into an error message.
        assert_eq!(Gray::from_pixels(&[1, 2, 3, 4], 2, 2).unwrap().data, vec![1, 2, 3, 4]);
        let rgba = [9u8; 16];
        assert_eq!(Gray::from_pixels(&rgba, 2, 2).unwrap().data, vec![9, 9, 9, 9]);
        assert!(Gray::from_pixels(&[0u8; 12], 2, 2).is_none());
        assert!(Gray::from_pixels(&[], 0, 0).is_none());
    }
}
