// Times the board detector's stages on grey frames given as binary PGM files (P5), natively:
//
//   cargo run --release -p houseki-vision --example profile_frames -- [--board 22x22:0.685] frame.pgm ...
//
// For finding where the time goes before optimising (T-0330); the shares carry over to the wasm
// build, the absolute times do not (time the browser with tests/harness/test_vision_detect.py's
// opt-in timing test for those). The board defaults to the strip sheet's, 23 x 17 squares with
// 0.7 markers.

use houseki_vision::aruco::ArucoDetector;
use houseki_vision::board::{BoardDetector, FrameOptions};
use houseki_vision::gray::Gray;
use houseki_vision::threshold::{adaptive_thresholds, window_sizes, Integral};
use houseki_vision::linalg::{perspective_from_quads, Pt};
use houseki_vision::marker::{cell_ratios, CellParams};
use std::time::Instant;

fn read_pgm(path: &str) -> Gray {
    let bytes = std::fs::read(path).expect("cannot read the frame");
    // "P5\n<w> <h>\n255\n" then the pixels.
    let mut fields = Vec::new();
    let mut i = 0;

    while fields.len() < 4 {
        while bytes[i].is_ascii_whitespace() {
            i += 1;
        }

        let start = i;

        while !bytes[i].is_ascii_whitespace() {
            i += 1;
        }

        fields.push(String::from_utf8_lossy(&bytes[start..i]).to_string());
    }

    let (w, h): (usize, usize) = (fields[1].parse().unwrap(), fields[2].parse().unwrap());
    Gray::from_grey(bytes[i + 1..i + 1 + w * h].to_vec(), w, h)
}

fn ms(t: Instant, reps: usize) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0 / reps as f64
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let (mut sx, mut sy, mut ratio) = (23usize, 17usize, 0.7f32);

    if args.first().map(String::as_str) == Some("--board") {
        let spec = args[1].clone();
        args.drain(..2);
        let (size, r) = spec.split_once(':').unwrap();
        let (a, b) = size.split_once('x').unwrap();
        sx = a.parse().unwrap();
        sy = b.parse().unwrap();
        ratio = r.parse().unwrap();
    }

    // T-0332's fast-path parts: --noretry (no second reading of near-duplicate candidates),
    // --local (the refinement radius from each marker's size), --windows N (N threshold windows over
    // 3..93 instead of the desktop's 7), --roi F (detect only in the middle F x F share of the frame).
    let mut retry = true;
    let mut local = false;
    let mut window_count = 7usize;
    let mut roi_share = 1.0f64;

    loop {
        match args.first().map(String::as_str) {
            Some("--noretry") => {
                retry = false;
                args.remove(0);
            }
            Some("--local") => {
                local = true;
                args.remove(0);
            }
            Some("--windows") => {
                window_count = args[1].parse().unwrap();
                args.drain(..2);
            }
            Some("--roi") => {
                roi_share = args[1].parse().unwrap();
                args.drain(..2);
            }
            _ => break,
        }
    }

    let win_step = if window_count > 1 { ((93 - 3) as f64 / (window_count - 1) as f64).ceil() as i32 } else { 91 };
    println!("retry {retry}, local {local}, roi {roi_share}, windows {:?}", window_sizes(3, 93, win_step));

    let reps = 10;
    println!("{:<28} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8}  markers corners", "frame", "thresh", "contour", "filter", "identify", "refine+", "total");

    for path in &args {
        let grey = read_pgm(path);
        let windows = window_sizes(3, 93, win_step);
        let mut integral = Integral::default();
        let mut outs = Vec::new();
        let t = Instant::now();

        for _ in 0..reps {
            adaptive_thresholds(&grey, &windows, 7.0, &mut integral, &mut outs);
        }

        let thresh = ms(t, reps);
        // Tracing alone (no polygon fitting), on fresh copies of the thresholded images.
        let (mut count, mut points) = (0usize, 0usize);
        let mut copies: Vec<Vec<u8>> = outs.clone();
        let t = Instant::now();

        for _ in 0..reps {
            copies.clone_from(&outs);

            for img in copies.iter_mut() {
                houseki_vision::contours::trace_contours(img, grey.width + 2, grey.height + 2, |c| {
                    count += 1;
                    points += c.len();
                });
            }
        }

        // approxPolyDP alone, on the contours the perimeter filter keeps.
        let longest = grey.width.max(grey.height) as f64;
        let (lo, hi) = ((0.03 * longest) as usize, (4.0 * longest) as usize);
        let mut kept: Vec<Vec<(i32, i32)>> = Vec::new();
        copies.clone_from(&outs);

        for img in copies.iter_mut() {
            houseki_vision::contours::trace_contours(img, grey.width + 2, grey.height + 2, |c| {
                if c.len() >= lo && c.len() <= hi {
                    kept.push(c.to_vec());
                }
            });
        }

        let t = Instant::now();
        let mut quads = 0;

        for _ in 0..reps {
            quads = 0;

            for c in &kept {
                if houseki_vision::polygon::approx_poly_dp_closed(c, c.len() as f64 * 0.03).len() == 4 {
                    quads += 1;
                }
            }
        }

        let biggest = kept.iter().map(|c| c.len()).max().unwrap_or(0);
        println!("    approxPolyDP alone {:.2} ms on {} contours ({} points, the largest {}), {} quadrilaterals",
            ms(t, reps), kept.len(), kept.iter().map(|c| c.len()).sum::<usize>(), biggest, quads);
        println!("    tracing alone {:.2} ms ({} contours, {} points per frame; copying the images included)",
            ms(t, reps), count / reps, points / reps);
        let mut aruco = ArucoDetector::new((sx * sy) / 2);
        aruco.params.win_step = win_step;
        aruco.params.retry_close = retry;
        aruco.params.local_refine = local;
        let t = Instant::now();
        let mut raw = Vec::new();

        for _ in 0..reps {
            raw = aruco.initial_candidates(&grey);
        }

        let candidates = ms(t, reps);
        let t = Instant::now();

        for _ in 0..reps {
            aruco.filter_too_close_count(grey.width, grey.height, raw.clone());
        }

        let filter = ms(t, reps);
        let t = Instant::now();

        for _ in 0..reps {
            aruco.detect_markers(&grey);
        }

        let markers_total = ms(t, reps);
        let mut board = BoardDetector::new(sx, sy, ratio);
        board.aruco.params.win_step = win_step;
        board.aruco.params.retry_close = retry;
        board.aruco.params.local_refine = local;
        let roi = if roi_share < 1.0 {
            let (w, h) = ((grey.width as f64 * roi_share) as usize, (grey.height as f64 * roi_share) as usize);
            Some(((grey.width - w) / 2, (grey.height - h) / 2, w, h))
        } else {
            None
        };
        let frame_options = FrameOptions { roi, ..FrameOptions::default() };
        let t = Instant::now();
        let mut result = board.detect(&grey, &frame_options);

        for _ in 1..reps {
            result = board.detect(&grey, &frame_options);
        }

        let total = ms(t, reps);
        let st = board.aruco.stats;
        println!("    candidates: {} raw, {} after filterTooClose, {} cell readings to identify, {} in the refinement",
            st.raw, st.selected, st.identify_reads, st.refine_reads);
        // The corner stage's parts: without the sharpness/blurred re-refinement, and without the
        // board-guided marker refinement too.
        let no_blur = FrameOptions { refine_blurred: false, ..FrameOptions::default() };
        let t = Instant::now();

        for _ in 0..reps {
            board.detect(&grey, &no_blur);
        }

        let without_blur = ms(t, reps);
        board.try_refine = false;
        let t = Instant::now();

        for _ in 0..reps {
            board.detect(&grey, &no_blur);
        }

        let without_refine = ms(t, reps);
        board.try_refine = true;
        println!("    sharpness + blurred corners {:.2} ms, marker refinement {:.2} ms, interpolation + cornerSubPix {:.2} ms",
            total - without_blur, without_blur - without_refine, without_refine - markers_total);
        // Identification's parts, over every raw candidate: the perspective (OpenCV's SVD branch)
        // and the whole cell reading (perspective, warp, Otsu, cells).
        let square = [Pt::new(0.0, 0.0), Pt::new(47.0, 0.0), Pt::new(47.0, 47.0), Pt::new(0.0, 47.0)];
        let t = Instant::now();

        for _ in 0..reps {
            for c in &raw {
                std::hint::black_box(perspective_from_quads(c, &square));
            }
        }

        let persp = ms(t, reps);
        let params = CellParams { pixel_per_cell: 8, margin_rate: 0.3, min_otsu_std: 5.0 };
        let mut scratch = Vec::new();
        let t = Instant::now();

        for _ in 0..reps {
            for c in &raw {
                std::hint::black_box(cell_ratios(&grey, c, &params, &mut scratch));
            }
        }

        let cells = ms(t, reps);
        println!("    all {} raw candidates: perspective {:.2} ms, whole cell reading {:.2} ms", raw.len(), persp, cells);
        let name = std::path::Path::new(path).file_name().unwrap().to_string_lossy().to_string();
        println!("{:<28} {:>8.2} {:>8.2} {:>8.2} {:>8.2} {:>8.2} {:>8.2}  {} {} ({} candidates)",
            name, thresh, candidates - thresh, filter, markers_total - candidates - filter, total - markers_total, total,
            result.markers.len(), result.corners.len(), raw.len());
    }
}
