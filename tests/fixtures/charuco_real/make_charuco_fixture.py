"""Writes the real-frame ChArUco fixture for tests/harness/test_vision_detect.py (T-0323).

The phone's board detector (src/web/src/lib/vision/board_detect.js) ports the desktop scanner
pipeline's detector (HousekiScanner, src/houseki/pipeline/board.py and detect.py). To check the
port on real phone video, this takes a few frames of the scanner project's reference captures
(work/captures/<name>/frames, phone video at 2x zoom, 1080 x 1920) and keeps, per frame:

  * a square CROP of it (its side per frame in FRAMES) around the corners the desktop found,
    grey, JPEG quality JPEG_QUALITY, to keep the fixture to a few hundred KB. The test pastes it
    back into a frame of the original size at its original place, the rest mid-grey (128), so the
    detector sees the same pixel size and corner coordinates as on the full frame;
  * the EXPECTED corners: the desktop pipeline's own detector run, here, on exactly that padded
    frame (the JPEG as decoded, pasted into grey) -- board.make_detector's two passes,
    calibrate.corner_sharpness and detect.refine_blurred, as detect.detect_all runs them -- so the
    phone and the desktop are compared on identical pixels. Kept: the corners inside the crop by
    at least INSET_MARKERS marker widths, with id, position, neighbouring-marker count (1 or 2)
    and sharpness;
  * for reference, the ids the desktop found on the ORIGINAL full frame inside the same region
    (work/captures/<name>/detections.json), which differ only where the crop hid a marker.

The reference captures use the OLDER board, 22 columns of 10 mm squares with 0.68-0.69 markers
(the scanner project's kb: the-reference-charuco-board-22x17-dict-4x4-10-mm), so fixture.json
carries each frame's board spec, in the phone code's houseki.board.v1 shape.

Run it with the scanner project's own Python (OpenCV 5.0.0, numpy, Pillow), which it imports:

    /Users/LucasTong/Documents/HousekiScanner/.venv/bin/python tests/fixtures/charuco_real/make_charuco_fixture.py

It reads /Users/LucasTong/Documents/HousekiScanner (outside this repository, read-only; SCANNER
below) and writes this directory's fixture.json and *.jpg. Nothing in the build or tests runs it.
"""

import io
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SCANNER = os.environ.get("HOUSEKI_SCANNER", "/Users/LucasTong/Documents/HousekiScanner")
CAPTURES = os.path.join(SCANNER, "work", "captures")

sys.path.insert(0, os.path.join(SCANNER, "src"))

from houseki.pipeline import board, calibrate, detect  # noqa: E402

# (capture, frame index, crop side px): a sharp moissanite close-up (its markers are ~145 px, so
# a larger crop), a sharp quartz frame with many corners, a blurred quartz frame with few, and a
# landscape spinel frame with the most corners.
FRAMES = [("moissanite", 1171, 1000), ("quartz", 433, 720), ("quartz", 2167, 900), ("spinel", 1555, 720)]
JPEG_QUALITY = 90
INSET_MARKERS = 1.0
BACKGROUND = 128


def spec_for(identified):
    """The capture's board (board.json's identify() result) in houseki.board.v1 form. The
    detector reads squares_x/squares_y, marker_mm/square_mm, dictionary and legacy; the reference
    board has no centre target, so nothing is removed or invalid."""
    return {
        "format": "houseki.board.v1",
        "dictionary": identified["dictionary"],
        "squares_x": identified["squares_x"],
        "squares_y": identified["squares_y"],
        "legacy": identified["legacy"],
        "square_mm": 10.0,
        "marker_mm": round(10.0 * identified["marker_ratio"], 4),
        "marker_ratio": identified["marker_ratio"],
        "removed_marker_ids": [],
        "invalid_corner_ids": [],
    }


def desktop_corners(grey, spec, marker_scale):
    """detect.detect_all's per-frame work (its inner `one`), on one grey frame: the 2-marker pass,
    the 1-marker pass on the same markers, sharpness, and the re-refinement of blurred corners.
    Returns [{id, x, y, markers, sharpness}] in OpenCV's pixel convention."""
    s = min(grey.shape) / 1080.0   # camera.pixel_scale
    points = board.corner_points(spec)
    det2 = board.make_detector(spec, min_markers=2, m=marker_scale)
    det1 = board.make_detector(spec, min_markers=1, m=marker_scale)
    _, ids2, marker_corners, marker_ids = det2.detectBoard(grey)

    if marker_ids is None or len(marker_ids) == 0:
        return []

    corners, ids, _, _ = det1.detectBoard(grey, markerCorners=marker_corners, markerIds=marker_ids)

    if ids is None or len(ids) == 0:
        return []

    ids = np.ravel(ids).astype(int)
    two = set() if ids2 is None else set(np.ravel(ids2).astype(int).tolist())
    corners = np.asarray(corners, np.float64).reshape(-1, 2)
    sharp = calibrate.corner_sharpness(grey, corners, s=s)
    max_half = 40 if marker_scale <= 1.0 else int(round(40 * marker_scale))
    corners = detect.refine_blurred(grey, points[ids, :2], corners, sharp < calibrate.MIN_CORNER_SHARPNESS, max_half)
    return [{"id": int(i), "x": float(x), "y": float(y), "markers": 2 if int(i) in two else 1, "sharpness": float(v)}
            for i, (x, y), v in zip(ids, corners, sharp)]


def main():
    frames = []

    for capture, index, crop in FRAMES:
        detections = json.load(open(os.path.join(CAPTURES, capture, "detections.json")))
        frame = next(f for f in detections["frames"] if f["index"] == index)
        width, height = detections["size"]
        marker_px = detections["detector"]["marker_px"]
        marker_scale = detections["detector"]["marker_scale"]
        spec = spec_for(detections["board"])
        corners = np.asarray(frame["corners"], np.float64)

        # The crop: crop x crop around the corners' median, moved inside the frame.
        cx, cy = np.median(corners, axis=0)
        x0 = int(np.clip(round(cx - crop / 2), 0, width - crop))
        y0 = int(np.clip(round(cy - crop / 2), 0, height - crop))

        image = Image.open(os.path.join(CAPTURES, capture, frame["file"])).convert("L")
        assert image.size == (width, height), (image.size, width, height)
        name = "%s_%06d.jpg" % (capture, index)
        buffer = io.BytesIO()
        image.crop((x0, y0, x0 + crop, y0 + crop)).save(buffer, "JPEG", quality=JPEG_QUALITY)
        path = os.path.join(HERE, name)
        open(path, "wb").write(buffer.getvalue())

        # The padded frame the test builds, from the JPEG as written.
        padded = np.full((height, width), BACKGROUND, np.uint8)
        padded[y0:y0 + crop, x0:x0 + crop] = cv2.imread(path, cv2.IMREAD_GRAYSCALE)

        inset = INSET_MARKERS * marker_px
        inside = lambda x, y: x0 + inset <= x <= x0 + crop - inset and y0 + inset <= y <= y0 + crop - inset  # noqa: E731
        expected = [c for c in desktop_corners(padded, spec, marker_scale) if inside(c["x"], c["y"])]
        full_frame_ids = sorted(i for i, (x, y) in zip(frame["ids"], corners) if inside(x, y))
        frames.append({
            "capture": capture,
            "index": index,
            "file": name,
            "size": [width, height],
            "crop": [x0, y0, crop, crop],
            "background": BACKGROUND,
            "marker_px": marker_px,
            "marker_scale": marker_scale,
            "spec": spec,
            "expected": expected,
            "full_frame_ids": full_frame_ids,
        })
        print("%s: crop %s, %d expected corners (the full frame had %d there), %d KB"
              % (name, frames[-1]["crop"], len(expected), len(full_frame_ids), len(buffer.getvalue()) // 1024))

    with open(os.path.join(HERE, "fixture.json"), "w") as out:
        json.dump({
            "source": "HousekiScanner's desktop detector (board.py, detect.py, calibrate.py; OpenCV %s) "
                      "run on each padded crop by make_charuco_fixture.py" % cv2.__version__,
            "pixel_convention": "OpenCV: pixel centres at integer coordinates",
            "inset_markers": INSET_MARKERS,
            "frames": frames,
        }, out, indent=1)


if __name__ == "__main__":
    main()
