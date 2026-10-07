// findContours(binary, RETR_LIST, CHAIN_APPROX_NONE), as ArUco's _findMarkerContours calls it.
//
// In OpenCV 4.14.0 that call takes the fast path in modules/imgproc/src/contours_new.cpp, which
// hands RETR_LIST without a hierarchy to findTRUContours (modules/imgproc/src/contours_truco.cpp):
// a raster scan that traces each outer border from its first pixel and each hole border from the
// last pixel of a run, marking traced pixels so they start no second contour, and returns the
// contours in reverse order of discovery (which reproduces the Suzuki-Abe order of the classic
// implementation). opencv.js has no threads, so it runs as one stripe; this is that single-stripe
// tracer, ported line by line: same start points, same neighbour order, same marks, same point
// sequences. Contour order and starting points decide approxPolyDP's corners, so a marker's
// integer corners here are opencv.js's.
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

const FOREGROUND: u8 = 255;
const BACKGROUND: u8 = 0;
const VISITED_OUTER_RIGHT: u8 = 100;
const VISITED: u8 = 200;

// 0 = E, 1 = NE, 2 = N, 3 = NW, 4 = W, 5 = SW, 6 = S, 7 = SE (counter-clockwise).
const DX: [i32; 8] = [1, 1, 0, -1, -1, -1, 0, 1];
const DY: [i32; 8] = [0, -1, -1, -1, 0, 1, 1, 1];

struct Tracer {
    cols: usize,
    offsets: [isize; 16],
}

impl Tracer {
    fn new(cols: usize) -> Tracer {
        let step = cols as isize;
        let base = [1, -step + 1, -step, -step - 1, -1, step - 1, step, step + 1];
        let mut offsets = [0isize; 16];
        offsets[..8].copy_from_slice(&base);
        offsets[8..].copy_from_slice(&base);
        Tracer { cols, offsets }
    }

    // TRUCOntourTracer::traceContour: follows one border from (r, c), appending its points
    // (unpadded coordinates) to `buffer`. Returns false when an inner contour does not start
    // here (its first neighbour is not to the north-east) -- then nothing is emitted.
    fn trace(&self, img: &mut [u8], buffer: &mut Vec<(i32, i32)>, r: usize, c: usize, external: bool) -> bool {
        buffer.clear();
        let mut curr_x = c as i32;
        let mut curr_y = r as i32;
        let mut start_dir: i32 = -1;
        let mut search_idx: usize = if external { 5 } else { 1 };
        let mut curr = r * self.cols + c;
        let start = curr;
        let mut dir: i32 = -1;
        let mut first_move = true;

        if !external {
            let mut n = 0;

            while n < 8 {
                let idx = search_idx + n;

                if img[(curr as isize + self.offsets[idx]) as usize] != BACKGROUND {
                    if curr_x + DX[idx & 7] != c as i32 + 1 || curr_y + DY[idx & 7] != r as i32 - 1 {
                        return false;
                    }

                    break;
                }

                n += 1;
            }

            if n == 8 {
                return false;
            }
        }

        // The image has a zero border (trace_contours checks it), and every pixel the trace stands
        // on is non-zero, so all eight neighbours of `curr` are inside `img`: the neighbour reads
        // below skip the bounds checks, which in this, the detector's hottest loop, cost a third
        // of its time (measured, T-0330).
        let len = img.len();

        loop {
            buffer.push((curr_x - 1, curr_y - 1));

            for n in 0..8 {
                let idx = search_idx + n;
                // SAFETY: idx < 16 (search_idx < 8, n < 8), and curr's neighbours are in bounds
                // (see above); debug builds check both.
                let neighbor = (curr as isize + unsafe { *self.offsets.get_unchecked(idx) }) as usize;
                debug_assert!(idx < 16 && neighbor < len);

                if unsafe { *img.get_unchecked(neighbor) } == BACKGROUND {
                    continue;
                }

                dir = (idx & 7) as i32;
                curr_y += DY[dir as usize];
                curr_x += DX[dir as usize];

                if curr_y < 1 {
                    return false;
                }

                if search_idx <= 1 || dir <= search_idx as i32 - 2 {
                    img[curr] = VISITED_OUTER_RIGHT;
                } else if img[curr] == FOREGROUND {
                    img[curr] = VISITED;
                }

                if curr == start && !first_move && dir == start_dir {
                    return true;
                }

                curr = neighbor;
                search_idx = ((dir + 6) & 7) as usize;
                break;
            }

            if first_move {
                if dir == -1 {
                    // A single pixel: nothing to follow.
                    img[curr] = VISITED_OUTER_RIGHT;
                    break;
                }

                start_dir = dir;
                first_move = false;
            }
        }

        true
    }
}

const ONES: u64 = 0x0101_0101_0101_0101;
const HIGHS: u64 = 0x8080_8080_8080_8080;

/// findStartContourPoint: the first non-zero byte of `row` at or after `c` (or row.len()), eight
/// bytes at a time (OpenCV does the same with SIMD).
#[inline]
fn next_nonzero(row: &[u8], mut c: usize) -> usize {
    while c + 8 <= row.len() {
        let word = u64::from_le_bytes(row[c..c + 8].try_into().unwrap());

        if word != 0 {
            return c + (word.trailing_zeros() / 8) as usize;
        }

        c += 8;
    }

    while c < row.len() && row[c] == 0 {
        c += 1;
    }

    c
}

/// findEndContourPoint: the first zero byte of `row` at or after `c` (or row.len()), eight bytes
/// at a time: the lowest flagged byte of the classic "has a zero byte" test is the first zero.
#[inline]
fn next_zero(row: &[u8], mut c: usize) -> usize {
    while c + 8 <= row.len() {
        let word = u64::from_le_bytes(row[c..c + 8].try_into().unwrap());
        let zeros = word.wrapping_sub(ONES) & !word & HIGHS;

        if zeros != 0 {
            return c + (zeros.trailing_zeros() / 8) as usize;
        }

        c += 8;
    }

    while c < row.len() && row[c] != 0 {
        c += 1;
    }

    c
}

/// Traces every contour of `img`, a binary image (0 / 255) of `cols` x `rows` pixels with a
/// one-pixel zero border (threshold.rs's output), which it marks as it goes. `emit` receives each
/// contour's points in unpadded pixel coordinates, in the order OpenCV's tracer finds them; OpenCV
/// returns them in the REVERSE of that order (the caller reverses what it keeps).
pub fn trace_contours(img: &mut [u8], cols: usize, rows: usize, mut emit: impl FnMut(&[(i32, i32)])) {
    assert_eq!(img.len(), cols * rows);
    // The tracer's unchecked neighbour reads rely on this zero border.
    assert!(cols >= 3 && rows >= 3, "an image needs its one-pixel border");
    assert!(img[..cols].iter().all(|&v| v == 0) && img[(rows - 1) * cols..].iter().all(|&v| v == 0), "the top and bottom rows must be zero");
    assert!((1..rows - 1).all(|y| img[y * cols] == 0 && img[y * cols + cols - 1] == 0), "the left and right columns must be zero");
    let tracer = Tracer::new(cols);
    let mut buffer: Vec<(i32, i32)> = Vec::with_capacity(4096);
    let finish = |buffer: &mut Vec<(i32, i32)>, emit: &mut dyn FnMut(&[(i32, i32)])| {
        if buffer.len() > 1 && buffer.last() == buffer.first() {
            buffer.pop();
        }

        emit(buffer);
    };
    let row_end = rows - 1;

    for r in 1..=row_end {
        let row = r * cols;
        let mut c = 1;

        while c < cols - 1 {
            // findStartContourPoint: the next non-zero pixel.
            c = next_nonzero(&img[row..row + cols], c);

            if c == cols {
                break;
            }

            if img[row + c] == FOREGROUND && r < row_end && tracer.trace(img, &mut buffer, r, c, true) {
                finish(&mut buffer, &mut emit);
            }

            // findEndContourPoint: the end of this run.
            c = next_zero(&img[row..row + cols], c + 1);

            if c >= cols {
                break;
            }

            // The run's last pixel starts a hole border unless an outer border passed it.
            if img[row + c - 1] > VISITED_OUTER_RIGHT && r > 1 && tracer.trace(img, &mut buffer, r, c - 1, false) {
                finish(&mut buffer, &mut emit);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A padded binary image from rows of '#' (foreground) and '.' (background).
    fn padded(rows: &[&str]) -> (Vec<u8>, usize, usize) {
        let w = rows[0].len();
        let h = rows.len();
        let cols = w + 2;
        let mut img = vec![0u8; cols * (h + 2)];

        for (y, row) in rows.iter().enumerate() {
            for (x, ch) in row.bytes().enumerate() {
                if ch == b'#' {
                    img[(y + 1) * cols + x + 1] = 255;
                }
            }
        }

        (img, cols, h + 2)
    }

    fn contours(rows: &[&str]) -> Vec<Vec<(i32, i32)>> {
        let (mut img, cols, height) = padded(rows);
        let mut out = Vec::new();
        trace_contours(&mut img, cols, height, |c| out.push(c.to_vec()));
        out.reverse();
        out
    }

    #[test]
    fn a_filled_square_has_one_outer_contour_starting_top_left_counter_clockwise() {
        // Setup: a 4 x 4 filled square of foreground at (1, 1) in a 6 x 6 image.
        // Test: trace it.
        // Verifies: exactly one contour (no hole), of every border pixel once (12 points, as
        // CHAIN_APPROX_NONE), starting at the square's top-left pixel and going DOWN the left side
        // first -- OpenCV's outer-contour orientation, which decides where approxPolyDP starts.
        let found = contours(&["......", ".####.", ".####.", ".####.", ".####.", "......"]);
        assert_eq!(found.len(), 1);
        let c = &found[0];
        assert_eq!(c.len(), 12);
        assert_eq!(c[0], (1, 1));
        assert_eq!(c[1], (1, 2));
        assert_eq!(c[3], (1, 4));
        assert_eq!(c[6], (4, 4));
    }

    #[test]
    fn a_ring_gives_its_outer_border_and_its_hole_in_opencvs_order() {
        // Setup: a 6 x 5 ring (a marker's black border, one pixel thick) with a 4 x 3 hole.
        // Test: trace it and reverse, as the caller does.
        // Verifies: two contours, the hole first after reversing (OpenCV's RETR_LIST order lists
        // the later-found contour first); the outer one has the ring's 18 border pixels and the
        // hole's contour runs along the ring's inner pixels, starting at the ring pixel just left
        // of the hole's first row (the last pixel of the run before the hole: Suzuki's start for
        // a hole border, which TRUCO keeps).
        let found = contours(&["######", "#....#", "#....#", "#....#", "######"]);
        assert_eq!(found.len(), 2);
        let (hole, outer) = (&found[0], &found[1]);
        assert_eq!(outer.len(), 18);
        assert_eq!(outer[0], (0, 0));
        assert_eq!(hole[0], (0, 1));
        assert!(hole.iter().all(|&(x, y)| x == 0 || x == 5 || y == 0 || y == 4));
    }

    #[test]
    fn single_pixels_and_lines_are_contours_too() {
        // Setup: an isolated pixel and a 4-pixel horizontal line.
        // Test: trace.
        // Verifies: the isolated pixel is a one-point contour; the line is traced out and back
        // (6 points: 4 out, the 2 middle ones again on the way back, the start not repeated), as
        // OpenCV's border following does; nothing crashes at the image edge.
        let found = contours(&["#.....", "......", "..####"]);
        assert_eq!(found.len(), 2);
        let single = found.iter().find(|c| c.len() == 1).unwrap();
        assert_eq!(single[0], (0, 0));
        let line = found.iter().find(|c| c.len() > 1).unwrap();
        assert_eq!(line.len(), 6);
        assert_eq!(line[0], (2, 2));
    }
}
