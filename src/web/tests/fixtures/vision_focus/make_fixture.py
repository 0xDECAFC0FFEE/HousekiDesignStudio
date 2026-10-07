"""Build the phone's focus-measure fixture (T-0331) from the desktop scanner's captures.

Run with the HousekiScanner project's interpreter, from anywhere (it only READS that project):

    /Users/LucasTong/Documents/HousekiScanner/.venv/bin/python \
        src/web/tests/fixtures/vision_focus/make_fixture.py [--scanner PATH]

For a few frames of real captures -- sharp ones and the softest ones the desktop still accepted -- it
cuts the desktop's own stone window out of the frame (its Step 2 bound projected through the
frame's pose, as step2.frame_metrics does), halves it (cv2.INTER_AREA: a phone measures a 720p or
1080p frame, often with the window downsampled; and it keeps the fixture small), and writes:

- <capture>_<index>.pgm.gz: the halved window in grey (cv2's BGR -> grey), as a binary PGM, gzipped;
- focus.json: per window its size, the pixel scale s the desktop's constants are scaled by (the
  frame's short side / 1080, halved), the window's px per mm at the stone (halved), the desktop's
  blur_mm for the whole frame (selection.json), and selection.blur_sigma_px of the halved window
  (the four directions) -- what vision/focus.js must reproduce -- plus the same after an extra
  Gaussian blur of 1, 2 and 3 px (cv2.GaussianBlur on the float window), and the window's glare
  share (selection.glare_fraction on the colour window).
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

# (capture, frame index): sharp frames and the softest the desktop accepted (blur_mm near 0.2).
FRAMES = [
    ("cz_office", 1035), ("cz_office", 1293),
    ("moissanite_office", 1284), ("moissanite_office", 2204),
    ("quartz", 193), ("spinel", 1339),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scanner", default="/Users/LucasTong/Documents/HousekiScanner")
    a = ap.parse_args()
    sys.path.insert(0, os.path.join(a.scanner, "src"))
    import cv2
    from houseki.pipeline import bound, camera, selection as sel

    out = []

    for name, index in FRAMES:
        cdir = os.path.join(a.scanner, "work", "captures", name)
        poses = json.load(open(os.path.join(cdir, "poses.json")))
        chosen = json.load(open(os.path.join(cdir, "selection.json")))
        frame = next(f for f in poses["frames"] if f["index"] == index)
        K = np.asarray(poses["camera"]["K"], np.float64)
        dist = np.asarray(poses["camera"]["dist"], np.float64)
        size = tuple(poses["image_size"])
        w, h = size
        b = chosen["stone_bound"]
        R, t = np.asarray(frame["R"], np.float64), np.asarray(frame["t"], np.float64)
        ext = bound.project_extent(np.asarray(b["support_points_mm"], np.float64), R, t, K, dist, size)
        x0, y0, x1, y1 = ext["box"]
        X0, Y0 = max(0, int(np.floor(x0))), max(0, int(np.floor(y0)))
        X1, Y1 = min(w, int(np.ceil(x1)) + 1), min(h, int(np.ceil(y1)) + 1)
        img = cv2.imread(os.path.join(cdir, frame["file"]))
        roi = img[Y0:Y1, X0:X1]
        half = cv2.resize(roi, ((X1 - X0) // 2, (Y1 - Y0) // 2), interpolation=cv2.INTER_AREA)
        grey = cv2.cvtColor(half, cv2.COLOR_BGR2GRAY)
        s = camera.pixel_scale(size) / 2
        centre = np.asarray(b["centre_mm"], np.float64)
        zc = float((R @ centre + t)[2])
        record = next(f for f in chosen["frames"] if f["index"] == index)
        stem = f"{name}_{index}"
        header = f"P5\n{grey.shape[1]} {grey.shape[0]}\n255\n".encode()

        # mtime 0: the same window gives the same bytes on every run
        with open(os.path.join(HERE, stem + ".pgm.gz"), "wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as fh:
                fh.write(header + grey.tobytes())

        blurred = {}

        for extra in (1.0, 2.0, 3.0):
            g = cv2.GaussianBlur(grey.astype(np.float32), (0, 0), extra)
            blurred[str(extra)] = [round(float(v), 6) for v in sel.blur_sigma_px(g, s)]

        out.append({
            "file": stem + ".pgm.gz",
            "capture": name,
            "index": index,
            "width": int(grey.shape[1]),
            "height": int(grey.shape[0]),
            "s": s,
            "px_per_mm": float(K[0, 0] / zc) / 2,
            "desktop_blur_mm": record["blur_mm"],
            "blur_sigma_px": [round(float(v), 6) for v in sel.blur_sigma_px(grey, s)],
            "blur_sigma_px_after": blurred,
            "glare": sel.glare_fraction(half),
        })

    json.dump({"source": "HousekiScanner work/captures, selection.blur_sigma_px", "windows": out},
              open(os.path.join(HERE, "focus.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
