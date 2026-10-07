// DICT_4X4_250, the ArUco dictionary the scanner's boards print, and the two questions the
// detector asks of it: which board marker (and rotation) a read bit pattern is, and how many bits
// a pattern differs from one given marker.
//
// The codes are OpenCV's DICT_4X4_250 (modules/objdetect/src/aruco/predefined_dictionaries.hpp,
// first 250 of DICT_4X4_1000), as extracted to src/web/src/lib/vision/aruco_4x4_250.json (T-0325);
// a test checks the two agree. The rotations and the matching rules follow OpenCV 4.14.0
// modules/objdetect/src/aruco/aruco_dictionary.cpp (getByteListFromBits, CellBitMasks,
// identify, getDistanceToId).
//
// The specialisation: OpenCV's identify() compares a candidate with all 250 markers in four
// rotations. With the desktop's parameters (errorCorrectionRate 0.6 of DICT_4X4_250's one
// correctable bit, so no bit errors allowed) a candidate is a marker only when its bits equal the
// marker's exactly, so here the candidate's 16 bits index a 65,536-entry table holding only the
// markers the board prints. One look-up per candidate instead of up to 1,000 comparisons.
//
// Copyright (C) 2000-2022, Intel Corporation, all rights reserved.
// Copyright (C) 2015-2023, OpenCV Foundation, all rights reserved.
// (and the other OpenCV copyright holders listed in NOTICE)
// Copyright 2026 Lucas Tong (the Rust port, and the look-up table)
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or agreed to in
// writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
// specific language governing permissions and limitations under the License.

/// Bits per marker side.
pub const MARKER_SIZE: usize = 4;

/// The largest number of bit errors DICT_4X4_250 can correct ((3 - 1) / 2 in OpenCV).
pub const MAX_CORRECTION_BITS: i32 = 1;

/// The 4 x 4 inner bits of each marker, row by row from the marker's top-left as printed, most
/// significant bit first; 1 = white.
pub const DICT_4X4_250: [u16; 250] = [
    0xb532, 0x0f9a, 0x332d, 0x9946, 0x549e, 0x79cd, 0x9e2e, 0xc4f2, 0xfeda, 0xcf56,
    0xf991, 0x11a7, 0x0eb7, 0x2a0f, 0x24b1, 0x263e, 0x4665, 0x6600, 0x6c5e, 0x76af,
    0x868b, 0xb02b, 0xccd5, 0xdd82, 0xfe47, 0x9471, 0xace4, 0xa554, 0x2123, 0x346f,
    0x4415, 0x57b2, 0x9ecf, 0xf0cb, 0x08ae, 0x0929, 0x1875, 0x04ff, 0x0df6, 0x1c5a,
    0x1718, 0x2a28, 0x328c, 0x38b2, 0x24e8, 0x2eeb, 0x2d3f, 0x4b64, 0x502e, 0x5013,
    0x5194, 0x5568, 0x5d41, 0x5f97, 0x6801, 0x6867, 0x6124, 0x61e9, 0x6b12, 0x6fe5,
    0x67df, 0x7e1b, 0x80a0, 0x8344, 0x8ba2, 0x937a, 0x846c, 0x852a, 0x859c, 0x9c89,
    0x9fa1, 0xbb7c, 0xbc04, 0xb65b, 0xbfc8, 0xb7ab, 0xca1f, 0xc962, 0xd958, 0xd3d5,
    0xcc98, 0xc7a0, 0xc537, 0xe95d, 0xf925, 0xfbbb, 0xee2a, 0xf74d, 0x3575, 0x8aad,
    0x7617, 0x0acf, 0x064b, 0x2dc1, 0x49d8, 0x43f4, 0x4f36, 0x4fd3, 0x69e4, 0x70c7,
    0x7a6e, 0xb4ea, 0xed4f, 0xfce7, 0xfea6, 0x0025, 0x0043, 0x0a88, 0x0a86, 0x026f,
    0x001c, 0x0097, 0x0837, 0x0a31, 0x09c6, 0x0b01, 0x09fb, 0x0b58, 0x1082, 0x182d,
    0x1078, 0x1073, 0x1274, 0x12b1, 0x1af9, 0x1306, 0x0c0e, 0x0cf1, 0x0433, 0x0c9f,
    0x0ef2, 0x0efd, 0x074c, 0x0fa4, 0x072f, 0x05b5, 0x0f91, 0x07db, 0x1ee4, 0x1439,
    0x1d80, 0x15c8, 0x1f8b, 0x15ba, 0x1db1, 0x2080, 0x28e9, 0x22a2, 0x2853, 0x2af0,
    0x22f7, 0x2940, 0x2146, 0x29b9, 0x2b9c, 0x2bb2, 0x38ca, 0x382e, 0x3007, 0x38e7,
    0x3a49, 0x3a65, 0x325d, 0x3b88, 0x391d, 0x3bd3, 0x2647, 0x2780, 0x2faa, 0x2d14,
    0x25de, 0x2553, 0x2f77, 0x3448, 0x3ca8, 0x3c41, 0x340d, 0x34fb, 0x369a, 0x3de0,
    0x356a, 0x3d09, 0x3ded, 0x3fc4, 0x3f6c, 0x37ce, 0x3d5c, 0x3d76, 0x37b0, 0x3f17,
    0x3fff, 0x48e5, 0x4268, 0x4a2d, 0x4160, 0x4951, 0x41dd, 0x4bdf, 0x584f, 0x5a48,
    0x5816, 0x505d, 0x5afa, 0x5ab5, 0x5123, 0x5b8a, 0x5919, 0x5135, 0x4c69, 0x46c1,
    0x4e0b, 0x445f, 0x4e59, 0x4d83, 0x4d7d, 0x47d8, 0x4773, 0x5c85, 0x5e44, 0x562b,
    0x5cbb, 0x55c3, 0x5f6e, 0x5feb, 0x5d12, 0x555e, 0x6270, 0x6215, 0x61c2, 0x6b20,
    0x6345, 0x6b5c, 0x6b5b, 0x780c, 0x7acf, 0x787f, 0x7980, 0x71e5, 0x7174, 0x79b6,
    0x71d3, 0x7b33, 0x646a, 0x66a8, 0x6ea7, 0x6e91, 0x6522, 0x6dcb, 0x678d, 0x6d31,
];

#[inline]
fn bit(code: u16, row: usize, col: usize) -> u16 {
    (code >> (15 - (row * MARKER_SIZE + col))) & 1
}

/// A marker's code in rotation r (0..3), as getByteListFromBits stores rotation r: the bit at
/// (row, col) of rotation 1 is the printed bit (col, 3 - row); of rotation 2, (3 - row, 3 - col);
/// of rotation 3, (3 - col, row).
pub fn rotated(code: u16, r: usize) -> u16 {
    let n = MARKER_SIZE - 1;
    let mut out = 0u16;

    for row in 0..MARKER_SIZE {
        for col in 0..MARKER_SIZE {
            let b = match r {
                0 => bit(code, row, col),
                1 => bit(code, col, n - row),
                2 => bit(code, n - row, n - col),
                _ => bit(code, n - col, row),
            };
            out = (out << 1) | b;
        }
    }

    out
}

/// The codes of the markers a board prints, by code: entry `code` is 0 (no board marker), or
/// (id + 1) x 4 + rotation.
pub struct MarkerTable {
    table: Vec<u16>,
}

impl MarkerTable {
    /// The table for marker ids 0 .. count - 1 (a ChArUco board's markers, numbered from 0).
    /// Filled in OpenCV's search order -- by id, then rotation -- keeping the first entry for a
    /// code, so a code the dictionary repeated would resolve as identify() resolves it.
    pub fn for_ids(count: usize) -> MarkerTable {
        assert!(count <= DICT_4X4_250.len(), "DICT_4X4_250 has 250 markers, the board needs {count}");
        let mut table = vec![0u16; 1 << 16];

        for (id, &code) in DICT_4X4_250.iter().enumerate().take(count) {
            for r in 0..4 {
                let slot = &mut table[rotated(code, r) as usize];

                if *slot == 0 {
                    *slot = ((id as u16 + 1) << 2) | r as u16;
                }
            }
        }

        MarkerTable { table }
    }

    /// The board marker (id, rotation) whose code in that rotation is `code`, if any.
    #[inline]
    pub fn lookup(&self, code: u16) -> Option<(usize, usize)> {
        let v = self.table[code as usize];
        (v != 0).then(|| ((v >> 2) as usize - 1, (v & 3) as usize))
    }
}

/// identify() on the inner cells' white ratios (row-major, 16 values) with no bit errors
/// allowed: None unless every cell is clearly white (> threshold) or black (< 1 - threshold) and
/// the pattern is a board marker; else (id, rotation). A cell between the two thresholds counts
/// as an error against either bit (CellBitMasks), so it rules the candidate out.
pub fn identify(cells: &[f32; 16], threshold: f32, table: &MarkerTable) -> Option<(usize, usize)> {
    let mut code = 0u16;

    for &ratio in cells {
        let white = ratio > threshold;
        let black = ratio < 1.0 - threshold;

        if white == black {
            return None;
        }

        code = (code << 1) | white as u16;
    }

    table.lookup(code)
}

/// getDistanceToId(cells, id, allRotations = false): the bits in which the cells disagree with
/// marker `id` as printed (rotation 0). A cell between the thresholds disagrees with either bit.
pub fn distance_to_id(cells: &[f32; 16], id: usize, threshold: f32) -> i32 {
    let code = DICT_4X4_250[id];
    let mut errors = 0;

    for (k, &ratio) in cells.iter().enumerate() {
        let marker_white = (code >> (15 - k)) & 1 == 1;
        let not_black = ratio > threshold;
        let not_white = ratio < 1.0 - threshold;

        if (!marker_white && not_black) || (marker_white && not_white) {
            errors += 1;
        }
    }

    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cells_of(code: u16) -> [f32; 16] {
        let mut cells = [0f32; 16];

        for (k, cell) in cells.iter_mut().enumerate() {
            *cell = if (code >> (15 - k)) & 1 == 1 { 1.0 } else { 0.0 };
        }

        cells
    }

    #[test]
    fn the_codes_are_the_ones_the_phone_draws_its_boards_with() {
        // Setup: src/web/src/lib/vision/aruco_4x4_250.json, the dictionary extracted from OpenCV
        // that board_texture.js draws the sheets with (read here as text, no JSON crate).
        // Test: pull every 4-hex-digit marker string out of its "markers" list.
        // Verifies: the 250 codes compiled into the detector are exactly the JSON's, in order, so
        // the detector reads what the phone's own board drawing prints.
        let text = include_str!("../web/src/lib/vision/aruco_4x4_250.json");
        let list = &text[text.find("\"markers\"").unwrap()..];
        let codes: Vec<u16> = list.split('"').filter(|s| s.len() == 4 && s.chars().all(|c| c.is_ascii_hexdigit()))
            .map(|s| u16::from_str_radix(s, 16).unwrap()).collect();
        assert_eq!(codes, DICT_4X4_250.to_vec());
    }

    #[test]
    fn rotations_turn_the_pattern_a_quarter_at_a_time() {
        // Setup: a pattern with a single white bit at the top-left (0x8000).
        // Test: its four rotations, and four rotations in a row of a real marker.
        // Verifies: OpenCV's rotation convention -- rotation 1 moves the top-left bit to the
        // bottom-left, 2 to the bottom-right, 3 to the top-right -- and four quarter turns are
        // the identity.
        assert_eq!(rotated(0x8000, 0), 0x8000);
        assert_eq!(rotated(0x8000, 1), 0x0008);
        assert_eq!(rotated(0x8000, 2), 0x0001);
        assert_eq!(rotated(0x8000, 3), 0x1000);
        let code = DICT_4X4_250[97];
        assert_eq!(rotated(rotated(rotated(rotated(code, 1), 1), 1), 1), code);
    }

    #[test]
    fn a_board_marker_is_found_in_any_rotation_and_others_are_not() {
        // Setup: the strip board's table (195 markers: 23 x 17 squares, ids 0..194).
        // Test: look up marker 97 read in each rotation, marker 230 (in the dictionary, not on
        // the board), and every board marker's own code.
        // Verifies: each board marker resolves to its id and the rotation it was read in; a
        // dictionary marker the board does not print is not a match (the specialisation); and
        // the 195 x 4 board codes are all distinct (the table never has to choose).
        let table = MarkerTable::for_ids(195);

        for r in 0..4 {
            assert_eq!(identify(&cells_of(rotated(DICT_4X4_250[97], r)), 0.49, &table), Some((97, r)));
        }

        assert_eq!(identify(&cells_of(DICT_4X4_250[230]), 0.49, &table), None);
        let mut seen = std::collections::HashSet::new();

        for &code in DICT_4X4_250.iter().take(195) {
            for r in 0..4 {
                let c = rotated(code, r);

                if !seen.insert(c) {
                    // A symmetric marker repeats its own code; another marker must not.
                    assert!((0..4).any(|s| s != r && rotated(code, s) == c));
                }
            }
        }
    }

    #[test]
    fn half_white_cells_and_bit_errors_are_counted_as_opencv_does() {
        // Setup: marker 5's cells, then one cell set to exactly half white (8 of 16 pixels), and
        // separately one cell flipped.
        // Test: identify and distance_to_id with OpenCV's default bit threshold 0.49.
        // Verifies: a half-white cell (between 0.49 and 0.51) makes identification fail and costs
        // one bit against the marker; a flipped bit costs one bit too (the refinement accepts up
        // to 2 such errors); the clean pattern is at distance 0.
        let table = MarkerTable::for_ids(195);
        let clean = cells_of(DICT_4X4_250[5]);
        assert_eq!(distance_to_id(&clean, 5, 0.49), 0);
        let mut half = clean;
        half[6] = 0.5;
        assert_eq!(identify(&half, 0.49, &table), None);
        assert_eq!(distance_to_id(&half, 5, 0.49), 1);
        let mut flipped = clean;
        flipped[0] = 1.0 - flipped[0];
        assert_eq!(distance_to_id(&flipped, 5, 0.49), 1);
    }
}
