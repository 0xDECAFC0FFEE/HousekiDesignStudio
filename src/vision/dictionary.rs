// DICT_4X4_1000, the ArUco dictionary the scanner's boards print, and the two questions the
// detector asks of it: which board marker (and rotation) a read bit pattern is, and how many bits
// a pattern differs from one given marker.
//
// The codes are OpenCV's DICT_4X4_1000 (modules/objdetect/src/aruco/predefined_dictionaries.hpp),
// as extracted to src/web/src/lib/vision/aruco_4x4_1000.json (T-0340; its first 250 are
// DICT_4X4_250, T-0325's extraction); a test checks the two agree. The rotations and the matching
// rules follow OpenCV 4.14.0 modules/objdetect/src/aruco/aruco_dictionary.cpp
// (getByteListFromBits, CellBitMasks, identify, getDistanceToId).
//
// THE BOARDS (T-0340). The scanner's three printed boards share one 23 x 17 layout of 195 markers
// and differ in their palette and in their markers: each prints its own run of DICT_4X4_1000 ids
// (white/grey from 250, grey/black from 500, white/black from 750). So the id a marker reads as
// says which board is in view, and one table holds all three.
//
// The specialisation: OpenCV's identify() compares a candidate with every dictionary marker in
// four rotations. With the desktop's parameters (errorCorrectionRate 0.6 of at most one
// correctable bit, so no bit errors allowed) a candidate is a marker only when its bits equal the
// marker's exactly, so here the candidate's 16 bits index a 65,536-entry table holding only the
// markers the boards print. One look-up per candidate instead of up to 4,000 comparisons.
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

/// The bit errors the board-guided refinement scales by its errorCorrectionRate (3): DICT_4X4_250's
/// maxCorrectionBits, (3 - 1) / 2 in OpenCV, kept for the DICT_4X4_1000 boards (T-0340). OpenCV
/// gives DICT_4X4_1000 0, with which the refinement could never accept a candidate (it needs fewer
/// errors than 0 x 3); the refinement only reads where the found markers put a known marker, so
/// allowing the old 2 bit errors there keeps the recovery the boards were tuned with.
pub const MAX_CORRECTION_BITS: i32 = 1;

/// The 4 x 4 inner bits of each marker, row by row from the marker's top-left as printed, most
/// significant bit first; 1 = white.
pub const DICT_4X4_1000: [u16; 1000] = [
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
    0x7e80, 0x7ee2, 0x7e8d, 0x74d2, 0x7c32, 0x7e35, 0x75ab, 0x7705, 0x7f2b, 0x7dda,
    0x7f92, 0x8075, 0x80f3, 0x81a6, 0x89ed, 0x81fc, 0x98a6, 0x9a20, 0x9143, 0x99f9,
    0x9193, 0x9bd4, 0x8409, 0x846b, 0x86c4, 0x8e64, 0x861a, 0x854e, 0x8dcb, 0x8567,
    0x85af, 0x85d7, 0x87b3, 0x9ce1, 0x9cf2, 0x9417, 0x9500, 0x95a2, 0x9d23, 0x9f62,
    0x9d52, 0x95da, 0xa0c5, 0xaacd, 0xa2d8, 0xa257, 0xa93d, 0xa957, 0xab52, 0xa336,
    0xa359, 0xb0f4, 0xb812, 0xb0bf, 0xb29d, 0xbbed, 0xb972, 0xb996, 0xa4c3, 0xacd2,
    0xaeb1, 0xa582, 0xaf65, 0xa57b, 0xaffa, 0xb464, 0xbc62, 0xb481, 0xb6a0, 0xbeee,
    0xbe0d, 0xbcd9, 0xbef8, 0xb528, 0xb709, 0xb7d2, 0xc0ea, 0xc019, 0xc0fd, 0xc8d3,
    0xca5a, 0xc14d, 0xc9b4, 0xc157, 0xc398, 0xc31d, 0xd880, 0xd8ef, 0xda2b, 0xd01e,
    0xd105, 0xd3ad, 0xdba7, 0xc4c9, 0xcc78, 0xcd45, 0xc50b, 0xcfcf, 0xdcac, 0xd402,
    0xdc63, 0xd427, 0xd4f5, 0xd678, 0xdeb8, 0xdde6, 0xd55d, 0xddbd, 0xdf1d, 0xe2ca,
    0xea6b, 0xe0b4, 0xe238, 0xe2d4, 0xe322, 0xe1d8, 0xf003, 0xf2cc, 0xf8f6, 0xf149,
    0xf3ea, 0xf19c, 0xf9f5, 0xf13b, 0xec8d, 0xeec9, 0xe60f, 0xe4f7, 0xe760, 0xefe8,
    0xedb2, 0xe515, 0xefd1, 0xf486, 0xfc01, 0xf6c3, 0xf47c, 0xfc93, 0xf542, 0xfd98,
    0xf53d, 0x02bd, 0x00e1, 0x02e2, 0x02ae, 0x0878, 0x0074, 0x089e, 0x08d1, 0x087d,
    0x0a32, 0x0ade, 0x0251, 0x01a2, 0x0380, 0x0b83, 0x0b4b, 0x0b27, 0x0bef, 0x09b6,
    0x0959, 0x0993, 0x0bf8, 0x03d9, 0x03f1, 0x10c4, 0x18ab, 0x1aa0, 0x1a04, 0x1a6c,
    0x1aae, 0x1289, 0x1017, 0x1af3, 0x1940, 0x1102, 0x112b, 0x11cf, 0x1b22, 0x132e,
    0x1115, 0x13bb, 0x0c20, 0x0cc9, 0x0cdc, 0x0c36, 0x0614, 0x0672, 0x0d61, 0x050d,
    0x0d8f, 0x0fe0, 0x0f49, 0x0785, 0x0590, 0x0d33, 0x0f96, 0x0f76, 0x1460, 0x1c8d,
    0x14da, 0x1c73, 0x1e94, 0x1eba, 0x16d9, 0x1e3d, 0x16fb, 0x1de9, 0x1dfe, 0x1f9f,
    0x288b, 0x20af, 0x220e, 0x22a9, 0x2a8d, 0x2aa3, 0x2aef, 0x2890, 0x283b, 0x2a58,
    0x2233, 0x21a0, 0x2102, 0x21a5, 0x21c7, 0x2b03, 0x2367, 0x2930, 0x29d2, 0x2b19,
    0x2b9b, 0x2b97, 0x3828, 0x38a5, 0x3a86, 0x3201, 0x389f, 0x32d2, 0x3a99, 0x3ad5,
    0x39e8, 0x3bc1, 0x3343, 0x3be7, 0x319a, 0x3390, 0x3b9e, 0x24c4, 0x2c4a, 0x2cad,
    0x2ccf, 0x2c67, 0x26ea, 0x2ee5, 0x2c70, 0x2e12, 0x2ed1, 0x2e39, 0x2564, 0x25e7,
    0x2fcc, 0x2dbc, 0x2d71, 0x25d5, 0x259b, 0x2710, 0x2f7c, 0x27f2, 0x273a, 0x2fb6,
    0x27d3, 0x2fb3, 0x271f, 0x3c4b, 0x36c0, 0x36ee, 0x3ee9, 0x34b8, 0x3c14, 0x3c52,
    0x3472, 0x347e, 0x34bf, 0x3e71, 0x3e53, 0x3d8c, 0x35a2, 0x352e, 0x352d, 0x37ac,
    0x3570, 0x37fa, 0x3ff1, 0x3fdb, 0x48c4, 0x48e9, 0x4ac2, 0x4a41, 0x42eb, 0x4813,
    0x4ad8, 0x42fd, 0x4a17, 0x4963, 0x436e, 0x413a, 0x49b1, 0x413d, 0x4b92, 0x4b9b,
    0x433f, 0x5822, 0x50aa, 0x5827, 0x52c8, 0x5284, 0x520a, 0x5a0f, 0x5898, 0x585c,
    0x50db, 0x50f7, 0x5af4, 0x51ec, 0x5142, 0x510d, 0x5b03, 0x53eb, 0x5176, 0x5971,
    0x5193, 0x53f9, 0x5bb3, 0x5397, 0x4c4c, 0x444b, 0x4c23, 0x468c, 0x4e27, 0x4690,
    0x4ed4, 0x45ce, 0x45e5, 0x4527, 0x4fc1, 0x4705, 0x4534, 0x4572, 0x5cc8, 0x5c0e,
    0x54eb, 0x5689, 0x5643, 0x5ee7, 0x5c70, 0x54b2, 0x5e79, 0x56f3, 0x5da3, 0x5df2,
    0x551d, 0x5d9d, 0x57fc, 0x57d2, 0x5f73, 0x682d, 0x68c3, 0x6887, 0x6a4a, 0x6269,
    0x60b9, 0x68ff, 0x6adc, 0x6ada, 0x6a3e, 0x6a51, 0x6a31, 0x62d7, 0x61cc, 0x6b82,
    0x6be3, 0x693a, 0x619e, 0x6195, 0x6175, 0x695f, 0x6937, 0x63da, 0x7002, 0x7863,
    0x704f, 0x72ca, 0x7aad, 0x707b, 0x7a14, 0x7af9, 0x7ad3, 0x7abb, 0x79e2, 0x7129,
    0x7b67, 0x71d0, 0x7939, 0x7330, 0x73b9, 0x7353, 0x73ff, 0x6c88, 0x6409, 0x6c43,
    0x6606, 0x6683, 0x64b0, 0x64da, 0x6e9f, 0x67c8, 0x6fee, 0x6d3b, 0x6fd2, 0x7480,
    0x7cab, 0x7e68, 0x7e02, 0x7c9c, 0x7436, 0x7c11, 0x7ede, 0x7eb6, 0x76db, 0x7dc4,
    0x7d8a, 0x756d, 0x7788, 0x7720, 0x7741, 0x7538, 0x75be, 0x7d9b, 0x7757, 0x8828,
    0x80ac, 0x880d, 0x8867, 0x824e, 0x8aa1, 0x822b, 0x8018, 0x88f9, 0x809d, 0x8a9c,
    0x8231, 0x8a75, 0x8297, 0x8109, 0x81eb, 0x8107, 0x8b28, 0x8bac, 0x832e, 0x83e5,
    0x8150, 0x8932, 0x8b7a, 0x8b96, 0x837d, 0x9087, 0x9afc, 0x92f5, 0x91aa, 0x9341,
    0x9325, 0x9beb, 0x9934, 0x91f7, 0x9bda, 0x9356, 0x8442, 0x8c81, 0x8c4f, 0x8648,
    0x86a6, 0x8e03, 0x86e3, 0x866f, 0x8eaf, 0x845e, 0x8477, 0x86fa, 0x8e1e, 0x8e37,
    0x870a, 0x8f8a, 0x8f26, 0x8721, 0x870d, 0x8572, 0x873e, 0x9c43, 0x9e61, 0x9458,
    0x94f8, 0x9c32, 0x9476, 0x94b1, 0x94dd, 0x949b, 0x9cdb, 0x9e9c, 0x9ed2, 0x9619,
    0x9eb1, 0x9569, 0x9f6d, 0x972b, 0x95b6, 0x95b9, 0x9d3d, 0x9d57, 0xa8ec, 0xa825,
    0xa2ac, 0xa202, 0xaa66, 0xaa8f, 0xaae7, 0xa830, 0xa87a, 0xa8f6, 0xa893, 0xa214,
    0xaa34, 0xa272, 0xaaf2, 0xa2f1, 0xa140, 0xa90a, 0xa126, 0xa9c5, 0xa9cf, 0xa134,
    0xa912, 0xa1fa, 0xab98, 0xa3f7, 0xb006, 0xb045, 0xb88d, 0xb284, 0xb8f0, 0xb855,
    0xb276, 0xba91, 0xb271, 0xb9c0, 0xb942, 0xb92a, 0xb38c, 0xb3ca, 0xbb66, 0xb30f,
    0xb1da, 0xbb14, 0xbbf6, 0xb313, 0xa468, 0xac2c, 0xaca1, 0xaceb, 0xacc7, 0xa467,
    0xa6c0, 0xaee0, 0xa623, 0xade8, 0xa5cc, 0xa7ec, 0xad7c, 0xa51a, 0xa591, 0xad19,
    0xa597, 0xb46d, 0xbecb, 0xbc3a, 0xbcf5, 0xbebd, 0xbef3, 0xb525, 0xb58f, 0xb768,
    0xbfe4, 0xbdfe, 0xbd9d, 0xb5f5, 0xb5f3, 0xbfb0, 0xb75a, 0xbf3e, 0xb739, 0xbfd5,
    0xb71d, 0xbf35, 0xb77f, 0xc801, 0xc0a5, 0xc282, 0xc8bd, 0xc2fc, 0xca91, 0xc25b,
    0xc944, 0xc12a, 0xc3c0, 0xc97a, 0xc1b9, 0xc975, 0xc1f7, 0xcbb1, 0xd06c, 0xd887,
    0xd0af, 0xdac4, 0xd20c, 0xda09, 0xd030, 0xd894, 0xd03a, 0xd0b6, 0xd075, 0xd276,
    0xda5d, 0xda35, 0xd217, 0xd902, 0xd3e8, 0xd3e5, 0xd19a, 0xd1f6, 0xd151, 0xdb14,
    0xd33e, 0xd3d3, 0xc460, 0xcca7, 0xc642, 0xc647, 0xcee7, 0xc45c, 0xcc1d, 0xcc35,
    0xc6bc, 0xcda8, 0xc50c, 0xc5e4, 0xc5c2, 0xcd2d, 0xcd59, 0xcd95, 0xc593, 0xc75f,
    0xd4c5, 0xde88, 0xd624, 0xdeec, 0xd6e2, 0xdec6, 0xde23, 0xdcdc, 0xdc1a, 0xd411,
    0xde54, 0xd694, 0xde9d, 0xdd81, 0xd5a5, 0xd7ac, 0xd766, 0xdfa9, 0xd5dc, 0xdd1f,
    0xdff0, 0xe248, 0xe2e8, 0xe207, 0xe05d, 0xeaf5, 0xeb26, 0xebed, 0xe152, 0xe17e,
    0xe9db, 0xf806, 0xf0ee, 0xf8a1, 0xfa00, 0xfac2, 0xf09b, 0xfaf4, 0xfa3c, 0xf2fc,
    0xf2bd, 0xf293, 0xf160, 0xf9ec, 0xf146, 0xf9e1, 0xf348, 0xf3ae, 0xf3c1, 0xf38b,
    0xf3a7, 0xf173, 0xf197, 0xf3f4, 0xfb32, 0xe407, 0xe64d, 0xec55, 0xedc0, 0xed85,
    0xefa2, 0xe74e, 0xe5d5, 0xef50, 0xf422, 0xf489, 0xf429, 0xf66a, 0xfe0b, 0xfe6f,
    0xf495, 0xf435, 0xf41f, 0xf6b0, 0xf5e8, 0xf5c5, 0xfd23, 0xffc0, 0xf7cc, 0xf7e9,
    0xf5bc, 0xfdf6, 0xf5d9, 0xfd97, 0xfd3f, 0xff9c, 0xff5a, 0xf7fe, 0xff11, 0xf7bf,
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

/// The codes of the markers some boards print, by code: entry `code` is 0 (no board marker), or
/// (slot + 1) x 4 + rotation, where slot = board x count + the marker's index on its board.
pub struct MarkerTable {
    table: Vec<u16>,
}

impl MarkerTable {
    /// The table for dictionary ids 0 .. count - 1 (one ChArUco board's markers, numbered from 0).
    pub fn for_ids(count: usize) -> MarkerTable {
        MarkerTable::for_boards(&[0], count, &[])
    }

    /// The table for boards of `count` markers each, board b printing dictionary ids
    /// first_ids[b] .. first_ids[b] + count - 1; a code looks up as the slot b x count + index.
    /// Filled in OpenCV's search order -- by dictionary id, then rotation -- keeping the first
    /// entry for a code, so a code the dictionary repeated would resolve as identify() resolves it.
    /// Dictionary ids in `unreadable` are left out: printed, but never read (T-0340: ids 437 and
    /// 441, which the dark squares' spirals read as once blurred).
    pub fn for_boards(first_ids: &[usize], count: usize, unreadable: &[usize]) -> MarkerTable {
        assert!(first_ids.len() * count < (1 << 14), "too many board markers for the table");
        let mut entries: Vec<(usize, usize)> = Vec::new();

        for (b, &first) in first_ids.iter().enumerate() {
            assert!(first + count <= DICT_4X4_1000.len(), "DICT_4X4_1000 has 1000 markers, board {b} needs ids {first}..{}", first + count);
            entries.extend((0..count).map(|k| (first + k, b * count + k)));
        }

        entries.retain(|(id, _)| !unreadable.contains(id));
        entries.sort_unstable();
        let mut table = vec![0u16; 1 << 16];

        for (id, slot) in entries {
            for r in 0..4 {
                let entry = &mut table[rotated(DICT_4X4_1000[id], r) as usize];

                if *entry == 0 {
                    *entry = ((slot as u16 + 1) << 2) | r as u16;
                }
            }
        }

        MarkerTable { table }
    }

    /// The board marker (slot, rotation) whose code in that rotation is `code`, if any.
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
/// dictionary marker `id` as printed (rotation 0). A cell between the thresholds disagrees with
/// either bit.
pub fn distance_to_id(cells: &[f32; 16], id: usize, threshold: f32) -> i32 {
    let code = DICT_4X4_1000[id];
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

    /// The three boards' first dictionary ids (white/grey, grey/black, white/black) and their
    /// marker count (23 x 17 squares).
    const BOARDS: [usize; 3] = [250, 500, 750];
    const COUNT: usize = 195;

    fn cells_of(code: u16) -> [f32; 16] {
        let mut cells = [0f32; 16];

        for (k, cell) in cells.iter_mut().enumerate() {
            *cell = if (code >> (15 - k)) & 1 == 1 { 1.0 } else { 0.0 };
        }

        cells
    }

    #[test]
    fn the_codes_are_the_ones_the_phone_draws_its_boards_with() {
        // Setup: src/web/src/lib/vision/aruco_4x4_1000.json, the dictionary extracted from OpenCV
        // that board_texture.js draws the boards with (read here as text, no JSON crate).
        // Test: pull every 4-hex-digit marker string out of its "markers" list.
        // Verifies: the 1000 codes compiled into the detector are exactly the JSON's, in order, so
        // the detector reads what the phone's own board drawing prints.
        let text = include_str!("../web/src/lib/vision/aruco_4x4_1000.json");
        let list = &text[text.find("\"markers\"").unwrap()..];
        let codes: Vec<u16> = list.split('"').filter(|s| s.len() == 4 && s.chars().all(|c| c.is_ascii_hexdigit()))
            .map(|s| u16::from_str_radix(s, 16).unwrap()).collect();
        assert_eq!(codes, DICT_4X4_1000.to_vec());
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
        let code = DICT_4X4_1000[597];
        assert_eq!(rotated(rotated(rotated(rotated(code, 1), 1), 1), 1), code);
    }

    #[test]
    fn each_boards_markers_are_found_in_any_rotation_as_their_board_and_index() {
        // Setup: the table for the three boards (195 markers each, from ids 250, 500 and 750).
        // Test: look up marker 97 of each board (dictionary ids 347, 597, 847) read in each
        // rotation; then dictionary ids no board prints (0..249, the older boards' markers; 445,
        // between two boards' runs; 999).
        // Verifies: each board marker resolves to its slot (board x 195 + index) and the rotation
        // it was read in, so the board is known from one marker; markers the boards do not print
        // are no match, the older boards' included.
        let table = MarkerTable::for_boards(&BOARDS, COUNT, &[]);

        for (b, &first) in BOARDS.iter().enumerate() {
            for r in 0..4 {
                let read = identify(&cells_of(rotated(DICT_4X4_1000[first + 97], r)), 0.49, &table);
                assert_eq!(read, Some((b * COUNT + 97, r)), "board {b} rotation {r}");
            }
        }

        for id in (0..250).chain([445, 999]) {
            assert_eq!(identify(&cells_of(DICT_4X4_1000[id]), 0.49, &table), None, "id {id}");
        }
    }

    #[test]
    fn no_two_board_markers_share_a_code_in_any_rotation() {
        // Setup: the 3 x 195 markers the boards print, in all four rotations.
        // Test: collect every code; a code seen twice must be one marker's own symmetry.
        // Verifies: the table never has to choose between two board markers, so a read marker's
        // board and index are unambiguous (the reason one table can hold all three boards).
        let mut seen = std::collections::HashMap::new();

        for &first in &BOARDS {
            for id in first..first + COUNT {
                for r in 0..4 {
                    let c = rotated(DICT_4X4_1000[id], r);

                    if let Some(&other) = seen.get(&c) {
                        assert_eq!(other, id, "code {c:04x} is printed by markers {other} and {id}");
                    }

                    seen.insert(c, id);
                }
            }
        }
    }

    #[test]
    fn a_single_board_table_numbers_its_markers_from_zero() {
        // Setup: for_ids(195), the table of a board printing dictionary ids 0..194 (the layout the
        // Rust unit tests draw), and for_boards with one board from 750.
        // Test: look up dictionary id 23 in the first and id 773 in the second.
        // Verifies: both give index 23 of board 0: the slot is the marker's index on its board,
        // whatever its dictionary id.
        let zero = MarkerTable::for_ids(COUNT);
        let late = MarkerTable::for_boards(&[750], COUNT, &[]);
        assert_eq!(identify(&cells_of(DICT_4X4_1000[23]), 0.49, &zero), Some((23, 0)));
        assert_eq!(identify(&cells_of(DICT_4X4_1000[773]), 0.49, &late), Some((23, 0)));
        assert_eq!(identify(&cells_of(DICT_4X4_1000[23]), 0.49, &late), None);
    }

    #[test]
    fn an_unreadable_id_is_never_read_and_the_rest_are() {
        // Setup: the three boards' table with dictionary id 437 (the white/grey board's marker 187,
        // the code every dark square's spiral reads as once blurred) made unreadable.
        // Test: look up 437 in each rotation, and its neighbours 436 and 438.
        // Verifies: 437 is no marker at all, in any rotation, while the rest of its board reads as
        // before (slots 186 and 188).
        let table = MarkerTable::for_boards(&BOARDS, COUNT, &[437]);

        for r in 0..4 {
            assert_eq!(identify(&cells_of(rotated(DICT_4X4_1000[437], r)), 0.49, &table), None);
        }

        assert_eq!(identify(&cells_of(DICT_4X4_1000[436]), 0.49, &table), Some((186, 0)));
        assert_eq!(identify(&cells_of(DICT_4X4_1000[438]), 0.49, &table), Some((188, 0)));
    }

    #[test]
    fn half_white_cells_and_bit_errors_are_counted_as_opencv_does() {
        // Setup: marker 505's cells, then one cell set to exactly half white (8 of 16 pixels), and
        // separately one cell flipped.
        // Test: identify and distance_to_id with OpenCV's default bit threshold 0.49.
        // Verifies: a half-white cell (between 0.49 and 0.51) makes identification fail and costs
        // one bit against the marker; a flipped bit costs one bit too (the refinement accepts up
        // to 2 such errors); the clean pattern is at distance 0.
        let table = MarkerTable::for_boards(&BOARDS, COUNT, &[]);
        let clean = cells_of(DICT_4X4_1000[505]);
        assert_eq!(distance_to_id(&clean, 505, 0.49), 0);
        let mut half = clean;
        half[6] = 0.5;
        assert_eq!(identify(&half, 0.49, &table), None);
        assert_eq!(distance_to_id(&half, 505, 0.49), 1);
        let mut flipped = clean;
        flipped[0] = 1.0 - flipped[0];
        assert_eq!(distance_to_id(&flipped, 505, 0.49), 1);
    }
}
