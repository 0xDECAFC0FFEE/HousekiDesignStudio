// Polygon helpers ArUco's candidate search uses: approxPolyDP (closed, integer points),
// isContourConvex and pointPolygonTest (the inside/outside test, without distance).
//
// Ported from OpenCV 4.14.0 modules/imgproc/src/approx.cpp (approxPolyDP_, the Ramer-Douglas-
// Peucker simplification with OpenCV's choice of starting points and its final clean-up pass),
// modules/imgproc/src/convhull.cpp (isContourConvex_) and modules/imgproc/src/geometry.cpp
// (pointPolygonTest for float contours, measureDist = false). The arithmetic is OpenCV's, so a
// contour simplifies to the same four corners as in opencv.js.
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

use crate::linalg::Pt;

type P = (i32, i32);

/// approxPolyDP(contour, epsilon, closed = true) for integer points.
pub fn approx_poly_dp_closed(src: &[P], eps: f64) -> Vec<P> {
    let count0 = src.len();

    if count0 == 0 {
        return Vec::new();
    }

    let count = count0;
    let eps2 = eps * eps;
    let mut dst: Vec<P> = Vec::with_capacity(count);
    let mut stack: Vec<(usize, usize)> = Vec::new();
    let mut le_eps = false;

    // 1. Two roughly farthest points, from the first point, three times over.
    let mut right_start = 0usize;
    let mut pos = 0usize;
    let mut start_pt: P = (0, 0);
    // READ_PT's `if (++pos >= count) pos = 0`: a compare, not a division (a `%` per point made
    // this function a quarter of the detector's time).
    let next = |pos: usize| if pos + 1 >= count { 0 } else { pos + 1 };

    for _ in 0..3 {
        let mut max_dist = 0.0f64;
        pos = (pos + right_start) % count;
        start_pt = src[pos];
        pos = next(pos);

        for j in 1..count {
            let pt = src[pos];
            pos = next(pos);
            let dx = (pt.0 - start_pt.0) as f64;
            let dy = (pt.1 - start_pt.1) as f64;
            let dist = dx * dx + dy * dy;

            if dist > max_dist {
                max_dist = dist;
                right_start = j;
            }
        }

        le_eps = max_dist <= eps2;
    }

    // 2. Seed the stack with the two halves.
    if !le_eps {
        let slice_start = pos % count;
        let right_end = slice_start;
        let slice_end = (right_start + slice_start) % count;
        stack.push((slice_end, right_end));
        stack.push((slice_start, slice_end));
    } else {
        dst.push(start_pt);
    }

    // 3. Split each slice at its farthest point until every point is within eps.
    while let Some((s_start, s_end)) = stack.pop() {
        let end_pt = src[s_end];
        let mut pos = s_start;
        let start_pt = src[pos];
        pos = next(pos);
        let mut split = 0usize;

        let le = if pos != s_end {
            let dx = (end_pt.0 - start_pt.0) as f64;
            let dy = (end_pt.1 - start_pt.1) as f64;
            let segment_len_2 = dx * dx + dy * dy;
            let mut max_d = 0.0f64;

            while pos != s_end {
                let pt = src[pos];
                pos = next(pos);
                let px = (pt.0 - start_pt.0) as f64;
                let py = (pt.1 - start_pt.1) as f64;
                let projection = px * dx + py * dy;

                let d = if projection < 0.0 {
                    ((pt.0 - start_pt.0) * (pt.0 - start_pt.0) + (pt.1 - start_pt.1) * (pt.1 - start_pt.1)) as f64 * segment_len_2
                } else if projection > segment_len_2 {
                    ((pt.0 - end_pt.0) * (pt.0 - end_pt.0) + (pt.1 - end_pt.1) * (pt.1 - end_pt.1)) as f64 * segment_len_2
                } else {
                    let dist = py * dx - px * dy;
                    dist * dist
                };

                if d > max_d {
                    max_d = d;
                    split = if pos == 0 { count - 1 } else { pos - 1 };
                }
            }

            max_d <= eps2 * segment_len_2
        } else {
            true
        };

        if le {
            dst.push(start_pt);
        } else {
            stack.push((split, s_end));
            stack.push((s_start, split));
        }
    }

    // 4. Clean-up: drop points on (nearly) straight runs.
    let count = dst.len();
    let mut new_count = count;

    if count == 0 {
        return dst;
    }

    let mut pos = count - 1;
    let read = |pos: &mut usize, dst: &Vec<P>| {
        let p = dst[*pos];
        *pos += 1;

        if *pos >= count {
            *pos = 0;
        }

        p
    };
    let mut start_pt = read(&mut pos, &dst);
    let mut wpos = pos;
    let mut pt = read(&mut pos, &dst);
    let mut i = 0usize;

    while i < count && new_count > 2 {
        let end_pt = read(&mut pos, &dst);
        let dx = (end_pt.0 - start_pt.0) as f64;
        let dy = (end_pt.1 - start_pt.1) as f64;
        let dist = ((pt.0 - start_pt.0) as f64 * dy - (pt.1 - start_pt.1) as f64 * dx).abs();
        let successive_inner_product = ((pt.0 - start_pt.0) * (end_pt.0 - pt.0) + (pt.1 - start_pt.1) * (end_pt.1 - pt.1)) as f64;

        if dist * dist <= 0.5 * eps2 * (dx * dx + dy * dy) && dx != 0.0 && dy != 0.0 && successive_inner_product >= 0.0 {
            new_count -= 1;
            start_pt = end_pt;
            dst[wpos] = start_pt;
            wpos += 1;

            if wpos >= count {
                wpos = 0;
            }

            pt = read(&mut pos, &dst);
            i += 2;
            continue;
        }

        start_pt = pt;
        dst[wpos] = start_pt;
        wpos += 1;

        if wpos >= count {
            wpos = 0;
        }

        pt = end_pt;
        i += 1;
    }

    dst.truncate(new_count);
    dst
}

/// isContourConvex for integer points: every turn the same way. A straight turn (collinear
/// points) counts as both ways, so it is not convex -- OpenCV's rule.
pub fn is_contour_convex(p: &[P]) -> bool {
    let n = p.len();

    if n == 0 {
        return false;
    }

    let mut prev = p[(2 * n - 2) % n];
    let mut cur = p[n - 1];
    let mut dx0 = cur.0 - prev.0;
    let mut dy0 = cur.1 - prev.1;
    let mut orientation = 0;

    for &next in p {
        prev = cur;
        cur = next;
        let dx = cur.0 - prev.0;
        let dy = cur.1 - prev.1;
        let dxdy0 = dx as i64 * dy0 as i64;
        let dydx0 = dy as i64 * dx0 as i64;
        orientation |= if dydx0 > dxdy0 { 1 } else if dydx0 < dxdy0 { 2 } else { 3 };

        if orientation == 3 {
            return false;
        }

        dx0 = dx;
        dy0 = dy;
    }

    true
}

/// pointPolygonTest(contour, pt, false) for a float polygon: 1 inside, -1 outside, 0 on an edge.
pub fn point_polygon_test(poly: &[Pt], pt: Pt) -> i32 {
    let total = poly.len();

    if total == 0 {
        return -1;
    }

    let mut counter = 0;
    let mut v = poly[total - 1];

    for &next in poly {
        let v0 = v;
        v = next;

        if (v0.y <= pt.y && v.y <= pt.y) || (v0.y > pt.y && v.y > pt.y) || (v0.x < pt.x && v.x < pt.x) {
            if pt.y == v.y && (pt.x == v.x || (pt.y == v0.y && ((v0.x <= pt.x && pt.x <= v.x) || (v.x <= pt.x && pt.x <= v0.x)))) {
                return 0;
            }

            continue;
        }

        let mut dist = (pt.y - v0.y) as f64 * (v.x - v0.x) as f64 - (pt.x - v0.x) as f64 * (v.y - v0.y) as f64;

        if dist == 0.0 {
            return 0;
        }

        if v.y < v0.y {
            dist = -dist;
        }

        if dist > 0.0 {
            counter += 1;
        }
    }

    if counter % 2 == 0 { -1 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The border pixels of an axis-aligned rectangle, traced from its top-left corner down the
    // left side (the orientation contours.rs gives an outer border).
    fn rectangle_border(x0: i32, y0: i32, w: i32, h: i32) -> Vec<P> {
        let mut pts = Vec::new();

        for y in y0..y0 + h - 1 {
            pts.push((x0, y));
        }

        for x in x0..x0 + w - 1 {
            pts.push((x, y0 + h - 1));
        }

        for y in (y0 + 1..y0 + h).rev() {
            pts.push((x0 + w - 1, y));
        }

        for x in (x0 + 1..x0 + w).rev() {
            pts.push((x, y0));
        }

        pts
    }

    #[test]
    fn a_traced_rectangle_simplifies_to_its_four_corners() {
        // Setup: the 76 border pixels of a 20 x 20 rectangle, and ArUco's tolerance for it,
        // 0.03 x the contour's length.
        // Test: approxPolyDP, closed.
        // Verifies: exactly the four corner pixels survive (in contour order), and the polygon is
        // convex -- the shape a marker candidate must have.
        let border = rectangle_border(10, 5, 20, 20);
        let poly = approx_poly_dp_closed(&border, border.len() as f64 * 0.03);
        let mut sorted = poly.clone();
        sorted.sort();
        assert_eq!(sorted, vec![(10, 5), (10, 24), (29, 5), (29, 24)]);
        assert!(is_contour_convex(&poly));
    }

    #[test]
    fn a_bumpy_edge_within_tolerance_is_flattened_but_a_notch_is_kept() {
        // Setup: a 30 x 30 square border with one pixel pushed out by 1 px on the top side (well
        // within 0.03 x 116 = 3.5 px), and the same square with a 10 px deep notch.
        // Test: approxPolyDP on each.
        // Verifies: the 1 px bump disappears (still 4 corners); the notch survives (more than 4
        // points), so such a contour cannot become a marker candidate.
        let mut bumpy = rectangle_border(0, 0, 30, 30);
        let k = bumpy.iter().position(|&p| p == (15, 0)).unwrap();
        bumpy[k] = (15, -1);
        assert_eq!(approx_poly_dp_closed(&bumpy, bumpy.len() as f64 * 0.03).len(), 4);
        let mut notched = rectangle_border(0, 0, 30, 30);

        for p in notched.iter_mut() {
            if p.1 == 0 && (12..18).contains(&p.0) {
                p.1 = 10;
            }
        }

        assert!(approx_poly_dp_closed(&notched, notched.len() as f64 * 0.03).len() > 4);
    }

    #[test]
    fn convexity_follows_opencvs_rules() {
        // Setup: a convex quadrilateral in both orientations, a concave "dart", and a square
        // with a collinear middle point on one side.
        // Test: is_contour_convex.
        // Verifies: convex either way round; the dart is not; and a straight angle (collinear
        // points) counts as not convex, as OpenCV's orientation bit trick makes it.
        assert!(is_contour_convex(&[(0, 0), (0, 10), (10, 10), (10, 0)]));
        assert!(is_contour_convex(&[(0, 0), (10, 0), (10, 10), (0, 10)]));
        assert!(!is_contour_convex(&[(0, 0), (5, 3), (10, 0), (5, 10)]));
        assert!(!is_contour_convex(&[(0, 0), (0, 5), (0, 10), (10, 10), (10, 0)]));
    }

    #[test]
    fn point_in_polygon_says_inside_outside_and_on_the_edge() {
        // Setup: a tilted float quadrilateral (a marker's corners).
        // Test: its centre, a far point, a corner and a point on an edge.
        // Verifies: 1 inside, -1 outside, 0 on a vertex and on an edge -- checkMarker1InMarker2
        // counts edge points as inside (>= 0).
        let quad = [Pt::new(10.0, 0.0), Pt::new(20.0, 10.0), Pt::new(10.0, 20.0), Pt::new(0.0, 10.0)];
        assert_eq!(point_polygon_test(&quad, Pt::new(10.0, 10.0)), 1);
        assert_eq!(point_polygon_test(&quad, Pt::new(30.0, 30.0)), -1);
        assert_eq!(point_polygon_test(&quad, Pt::new(20.0, 10.0)), 0);
        assert_eq!(point_polygon_test(&quad, Pt::new(15.0, 5.0)), 0);
    }
}
