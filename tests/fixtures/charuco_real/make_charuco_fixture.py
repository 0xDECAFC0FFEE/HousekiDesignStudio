"""Writes the real-frame ChArUco fixture for tests/harness/test_vision_detect.py (T-0323; remade
for the three spiral boards in T-0340).

The phone's board detector (src/web/src/lib/vision/board_detect.js over the Rust module) ports the
desktop scanner pipeline's detector (HousekiScanner, src/houseki/pipeline/board.py and detect.py).
To check it on real phone video, this takes two frames of each board from the user's reference
videos of the three boards (3d_reconstruction/reference/PXL_20261013_*.TS.mp4, phone video at
1920 x 1080) and keeps, per frame:

  * a CROP of it (CROP px) around the board's corners, grey, JPEG quality JPEG_QUALITY, to
    keep the fixture to a few hundred KB. The test pastes it back into a frame of the original size
    at its original place, the rest mid-grey (128), so the detector sees the same pixel size and
    corner coordinates as on the full frame;
  * the EXPECTED corners: the desktop pipeline's detector, run here with native OpenCV on exactly
    that padded frame (the JPEG as decoded, pasted into grey): board.py's tuned parameters
    (detector_params, the 40 px refinement, checkMarkers off) and detect.py's two passes,
    calibrate.corner_sharpness and detect.refine_blurred -- with the board's own dictionary, the 195
    codes it prints (maxCorrectionBits 1, the unreadable markers given an unprinted code), as the
    phone's detector and its opencv.js reference read them (board_detect_opencv.js). Kept: the
    corners inside the crop by at least INSET_MARKERS marker widths, with id, position,
    neighbouring-marker count (1 or 2) and sharpness.

fixture.json carries each frame's board spec (the shipped spec file). Run it with the scanner
project's own Python (OpenCV 5.0.0, numpy, Pillow), which it imports:

    /Users/LucasTong/Documents/HousekiScanner/.venv/bin/python tests/fixtures/charuco_real/make_charuco_fixture.py

It reads the videos from the gitignored 3d_reconstruction/reference/ and the scanner project's code
(read-only), and writes this directory's fixture.json and *.jpg. Nothing in the build or the tests
runs it; the committed fixture is what the tests read.
"""

import io
import json
import os
import subprocess
import sys

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
VIDEOS = os.path.join(ROOT, "3d_reconstruction", "reference")
if not os.path.isdir(VIDEOS):
    VIDEOS = os.environ.get("HOUSEKI_REFERENCE_VIDEOS", "/Users/LucasTong/Documents/HousekiDesignStudio/3d_reconstruction/reference")
BOARDS = os.path.join(ROOT, "src", "web", "src", "lib", "vision", "boards")
SCANNER = os.environ.get("HOUSEKI_SCANNER", "/Users/LucasTong/Documents/HousekiScanner")

sys.path.insert(0, os.path.join(SCANNER, "src"))

from houseki.pipeline import board, calibrate, detect  # noqa: E402

A = cv2.aruco

# (video, second, board): two frames of each board.
# Each the second of its video (sampled every 5 s) where the desktop's detector found the most corners.
FRAMES = [
    ("PXL_20261013_025238515", 40, "charuco_23x17_10mm_white_black_spiral"),
    ("PXL_20261013_060912163", 5, "charuco_23x17_10mm_white_black_spiral"),
    ("PXL_20261013_025610567", 40, "charuco_23x17_10mm_white_grey_spiral"),
    ("PXL_20261013_111244219", 35, "charuco_23x17_10mm_white_grey_spiral"),
    ("PXL_20261013_025748223", 35, "charuco_23x17_10mm_grey_black_spiral"),
    ("PXL_20261013_060606316", 40, "charuco_23x17_10mm_grey_black_spiral"),
]
# The crop, width x height px: two thirds of the frame each way, around the corners.
CROP = (1280, 720)
JPEG_QUALITY = 75
INSET_MARKERS = 1.0
BACKGROUND = 128


def board_dictionary(spec):
    """The 195 codes the board prints (first_marker_id onwards), its unreadable markers given the
    code of dictionary id 0 (which none of the boards prints), maxCorrectionBits 1."""
    predefined = A.getPredefinedDictionary(getattr(A, spec["dictionary"]))
    count = spec["squares_x"] * spec["squares_y"] // 2
    first = spec.get("first_marker_id", 0)
    codes = predefined.bytesList[first:first + count].copy()

    for k in spec.get("unreadable_marker_ids", []):
        codes[k] = predefined.bytesList[0]

    return A.Dictionary(codes, predefined.markerSize, 1)


def make_board(spec):
    b = A.CharucoBoard((spec["squares_x"], spec["squares_y"]), 1.0, spec["marker_ratio"], board_dictionary(spec))
    b.setLegacyPattern(spec["legacy"])
    return b


def make_detector(spec, min_markers, m):
    """board.make_detector, with the board's own dictionary."""
    cp = A.CharucoParameters()
    cp.tryRefineMarkers = True
    cp.checkMarkers = False
    cp.minMarkers = min_markers
    refine = A.RefineParameters(40.0 if m == 1.0 else 40.0 * m, 3.0, True)
    return A.CharucoDetector(make_board(spec), cp, board.detector_params(m), refine)


def desktop_corners(grey, spec):
    """detect.detect_all's per-frame work, on one grey frame, with the marker-size factor measured
    from the frame's own markers (board.marker_scale). Returns ([{id, x, y, markers, sharpness}] in
    OpenCV's pixel convention, marker_px, m)."""
    s = min(grey.shape) / 1080.0
    _, _, probe, _ = make_detector(spec, 2, 1.0).detectBoard(grey)
    marker_px = float(np.median(board.marker_sides(probe))) if probe is not None and len(probe) else float("nan")
    m = board.marker_scale(marker_px)
    points = np.asarray(make_board(spec).getChessboardCorners(), np.float64).reshape(-1, 3) @ board.CV_TO_BOARD.T
    _, ids2, marker_corners, marker_ids = make_detector(spec, 2, m).detectBoard(grey)

    if marker_ids is None or len(marker_ids) == 0:
        return [], marker_px, m

    corners, ids, _, _ = make_detector(spec, 1, m).detectBoard(grey, markerCorners=marker_corners, markerIds=marker_ids)

    if ids is None or len(ids) == 0:
        return [], marker_px, m

    ids = np.ravel(ids).astype(int)
    two = set() if ids2 is None else set(np.ravel(ids2).astype(int).tolist())
    corners = np.asarray(corners, np.float64).reshape(-1, 2)
    sharp = calibrate.corner_sharpness(grey, corners, s=s)
    max_half = 40 if m <= 1.0 else int(round(40 * m))
    corners = detect.refine_blurred(grey, points[ids, :2], corners, sharp < calibrate.MIN_CORNER_SHARPNESS, max_half)
    return ([{"id": int(i), "x": float(x), "y": float(y), "markers": 2 if int(i) in two else 1, "sharpness": float(v)}
             for i, (x, y), v in zip(ids, corners, sharp)], marker_px, m)


def video_frame(video, second):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(second), "-i", os.path.join(VIDEOS, video + ".TS.mp4"),
                          "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(1080, 1920)


def main():
    frames = []

    for video, second, name in FRAMES:
        spec = json.load(open(os.path.join(BOARDS, name + ".json")))
        grey = video_frame(video, second)
        height, width = grey.shape
        found, _, _ = desktop_corners(grey, spec)
        pts = np.array([[c["x"], c["y"]] for c in found])
        cx, cy = np.median(pts, axis=0) if len(pts) else (width / 2, height / 2)
        cw, ch = CROP
        x0 = int(np.clip(round(cx - cw / 2), 0, width - cw))
        y0 = int(np.clip(round(cy - ch / 2), 0, height - ch))
        file = "%s_%03ds.jpg" % (video[-9:], second)
        buffer = io.BytesIO()
        Image.fromarray(grey[y0:y0 + ch, x0:x0 + cw]).save(buffer, "JPEG", quality=JPEG_QUALITY)
        path = os.path.join(HERE, file)
        open(path, "wb").write(buffer.getvalue())

        # The padded frame the test builds, from the JPEG as written.
        padded = np.full((height, width), BACKGROUND, np.uint8)
        padded[y0:y0 + ch, x0:x0 + cw] = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        corners, marker_px, m = desktop_corners(padded, spec)
        inset = INSET_MARKERS * marker_px
        inside = lambda x, y: x0 + inset <= x <= x0 + cw - inset and y0 + inset <= y <= y0 + ch - inset  # noqa: E731
        expected = [c for c in corners if inside(c["x"], c["y"])]
        frames.append({
            "capture": video, "second": second, "board": name, "file": file, "size": [width, height],
            "crop": [x0, y0, cw, ch], "background": BACKGROUND, "marker_px": round(marker_px, 2), "marker_scale": m,
            "spec": spec, "expected": expected,
        })
        print("%s (%s): crop %s, %d expected corners, marker %.1f px (m %.3g), %d KB"
              % (file, name, frames[-1]["crop"], len(expected), marker_px, m, len(buffer.getvalue()) // 1024))

    with open(os.path.join(HERE, "fixture.json"), "w") as out:
        json.dump({
            "source": "the desktop detector's parameters and passes (HousekiScanner board.py, detect.py, calibrate.py) with "
                      "each board's own dictionary, native OpenCV %s, on each padded crop, by make_charuco_fixture.py" % cv2.__version__,
            "pixel_convention": "OpenCV: pixel centres at integer coordinates",
            "inset_markers": INSET_MARKERS,
            "frames": frames,
        }, out, indent=1)


if __name__ == "__main__":
    main()
