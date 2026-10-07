"""Builds the rock outline's real-frame fixtures (T-0325) from the HousekiScanner reference captures.

Run once, with the scanner project's Python (it has OpenCV), when the fixtures need rebuilding:

    /path/to/HousekiScanner/.venv/bin/python tests/harness/vision/make_outline_fixtures.py \
        /path/to/HousekiScanner

For a few frames of three captures (moissanite, quartz, spinel; low to high views) it writes into
tests/harness/fixtures/vision_outline/:

- <capture>_<index>.jpg: the frame at half resolution (INTER_AREA), cropped to the region around
  the stone that the outline finder will look at (its bound cylinder grown by a generous margin);
- <capture>_<index>_mask.png: the desktop pipeline's Step 3 mask (work/captures/<capture>/masks/,
  houseki.masks.v1) over the same crop at the same scale (area-averaged, thresholded at half);
- manifest.json: per frame the crop's offset in the half-resolution frame, the camera's pose in
  types.js's CameraPose form for that half-resolution frame (OpenCV's principal point is on pixel
  centres, types.js's on pixel corners, so cx, cy gain half a pixel before halving), the stone's
  bound centre (selection.json's stone_bound, the carved blob's middle), the elevation, and the
  board's spec. The captures used the older 22 x 17 board with no centre target (the scanner's kb
  article the-reference-charuco-board-22x17-*), so the spec is built from each capture's
  board.json (marker ratio as measured) with 17 printed rows.

The frames are the scanner's own extracted video frames and masks; nothing here is generated.
"""

import json
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "fixtures", "vision_outline")

FRAMES = {
    "moissanite": [613, 985, 1453],
    "quartz": [2041, 223, 1681],
    "spinel": [1423, 307],
}
SCALE = 0.5            # half resolution
BOUND_RADIUS_MM = 16   # the outline finder's default bound (outline.js OUTLINE_DEFAULTS)
BOUND_HEIGHT_MM = 24
EXTRA_MM = 10          # crop margin around the bound: the finder's band and margin, and more


def project(points, R, t, K, k1):
    rvec = cv2.Rodrigues(np.asarray(R, np.float64))[0]
    q = cv2.projectPoints(np.asarray(points, np.float64), rvec, np.asarray(t, np.float64), np.asarray(K, np.float64),
                          np.array([k1, 0, 0, 0, 0], np.float64))[0].reshape(-1, 2)
    return q


def main(scanner):
    os.makedirs(OUT, exist_ok=True)
    manifest = {"format": "houseki.outline_fixtures.v1",
                "source": "HousekiScanner work/captures/<capture>/{frames,masks}, selection.json, board.json",
                "scale": SCALE, "frames": []}

    for capture, indices in FRAMES.items():
        d = os.path.join(scanner, "work", "captures", capture)
        sel = json.load(open(os.path.join(d, "selection.json")))
        board = json.load(open(os.path.join(d, "board.json")))
        K = np.asarray(sel["camera"]["K"], np.float64)
        k1 = float(sel["camera"]["dist"][0])
        w_full, h_full = sel["image_size"]
        centre = sel["stone_bound"]["centre_mm"]
        spec = {
            "format": "houseki.board.v1", "dictionary": board["dictionary"], "squares_x": board["squares_x"],
            "squares_y": 17, "legacy": board["legacy"], "square_mm": float(sel["square_mm"]),
            "marker_ratio": board["marker_ratio"], "marker_mm": board["marker_ratio"] * float(sel["square_mm"]),
            "target": {"cells_row_col": [], "x_range_mm": [centre[0], centre[0]],
                       "y_range_mm": [centre[1], centre[1]], "centre_mm": centre[:2], "rings_diameter_mm": [],
                       "ring_grey": None, "dots_mm": [], "dot_diameter_mm": None, "dot_seed": None},
            "removed_marker_ids": [], "invalid_corner_ids": [],
        }
        masks = {f["index"]: f for f in json.load(open(os.path.join(d, "masks.json")))["frames"]}

        for index in indices:
            s = next(x for x in sel["selected"] if x["index"] == index)
            R, t = np.asarray(s["R"]), np.asarray(s["t"])
            img = cv2.imread(os.path.join(d, s["file"]))
            mask = cv2.imread(os.path.join(d, masks[index]["mask"]), cv2.IMREAD_GRAYSCALE)
            W, H = int(round(w_full * SCALE)), int(round(h_full * SCALE))
            small = cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA)
            msmall = cv2.resize((mask > 127).astype(np.float32), (W, H), interpolation=cv2.INTER_AREA) >= 0.5

            # The half-resolution camera in types.js's pixel-corner convention.
            f = K[0, 0] * SCALE
            cx = (K[0, 2] + 0.5) * SCALE
            cy = (K[1, 2] + 0.5) * SCALE
            Kh = np.array([[f, 0, cx - 0.5], [0, f, cy - 0.5], [0, 0, 1.0]])   # back to centres for cv2
            a = np.linspace(0, 2 * np.pi, 64, endpoint=False)
            r = BOUND_RADIUS_MM + EXTRA_MM
            ring = np.c_[centre[0] + r * np.cos(a), centre[1] + r * np.sin(a)]
            pts = np.concatenate([np.c_[ring, np.zeros(64)], np.c_[ring, np.full(64, BOUND_HEIGHT_MM + EXTRA_MM)]])
            q = project(pts, R, t, Kh, k1) + 0.5
            x0, y0 = np.floor(q.min(0)).astype(int)
            x1, y1 = np.ceil(q.max(0)).astype(int)
            x0, y0 = max(0, x0), max(0, y0)
            x1, y1 = min(W, x1), min(H, y1)

            name = f"{capture}_{index:06d}"
            cv2.imwrite(os.path.join(OUT, name + ".jpg"), small[y0:y1, x0:x1], [cv2.IMWRITE_JPEG_QUALITY, 90])
            cv2.imwrite(os.path.join(OUT, name + "_mask.png"), (msmall[y0:y1, x0:x1] * 255).astype(np.uint8))
            C = -R.T @ t
            dvec = C - np.asarray(centre)
            elevation = float(np.degrees(np.arctan2(dvec[2], np.hypot(dvec[0], dvec[1]))))
            manifest["frames"].append({
                "capture": capture, "index": index, "image": name + ".jpg", "mask": name + "_mask.png",
                "offset": [int(x0), int(y0)], "elevationDeg": round(elevation, 1),
                "desktopConsistencyIou": masks[index]["consistency_iou"],
                "boundCentreMm": [round(float(v), 3) for v in centre[:2]],
                "spec": spec,
                "pose": {
                    "frame": {"width": W, "height": H, "timeMs": 0},
                    "intrinsics": {"width": W, "height": H, "f": f, "cx": cx, "cy": cy, "k1": k1, "source": "refined"},
                    "R": [float(v) for v in R.ravel()], "t": [float(v) for v in t],
                    "center": [float(v) for v in C], "valid": True,
                },
            })
            print(name, "crop", (x0, y0, x1, y1), "elevation %.1f" % elevation)

    with open(os.path.join(OUT, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
        fh.write("\n")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/Users/LucasTong/Documents/HousekiScanner")
