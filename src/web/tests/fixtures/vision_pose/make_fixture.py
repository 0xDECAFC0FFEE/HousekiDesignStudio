"""Build the phone-vision pose/intrinsics fixture (T-0324) from the desktop scanner's captures.

Run with the HousekiScanner project's interpreter, from anywhere (it only READS that project):

    /Users/LucasTong/Documents/HousekiScanner/.venv/bin/python \
        src/web/tests/fixtures/vision_pose/make_fixture.py [--scanner PATH] [--frames 64]

For each capture (moissanite: Pixel 7a at 2x zoom, f ~3470 px; spinel: about 1x, f ~1790 px) it
writes <capture>.json next to this script with, for a few dozen frames spread over the video:

- the ChArUco corners the desktop detected (all of them, each marked with the desktop corner set it
  belongs to, so a test can pick the same "best" / "extended" set step1 used);
- the desktop's own pose of that frame (poses.json: solved against its per-corner REFINED board);
- the pose the desktop's solver (calibrate.solve_pose, run here) gives on the NOMINAL board with
  the same K and corners: what the phone, which has no refined board, should reproduce exactly;
- the desktop's homography_focal and calibrate (k1 model, fixed centre) on the fixture's views,
  for a number-for-number check of the JS port;
- the capture's K, k1, its board as a houseki.board.v1-style spec (the older 22 x 22-row sheet,
  10 mm squares), its refined corners, and its stone point (the azimuth origin).

Pixel coordinates are converted to types.js's convention (origin at the top-left CORNER of the
top-left pixel): OpenCV's coordinates + 0.5, and the principal point likewise (539.5 -> 540).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scanner", default="/Users/LucasTong/Documents/HousekiScanner")
    ap.add_argument("--frames", type=int, nargs="+", default=[40, 20], help="frames per capture")
    ap.add_argument("--captures", nargs="+", default=["moissanite", "spinel"])
    a = ap.parse_args()
    sys.path.insert(0, os.path.join(a.scanner, "src"))
    from houseki.pipeline import board, calibrate as cal, step1  # noqa: E402

    for name, n_frames in zip(a.captures, a.frames):
        cdir = os.path.join(a.scanner, "work", "captures", name)
        det = json.load(open(os.path.join(cdir, "detections.json")))
        poses = json.load(open(os.path.join(cdir, "poses.json")))
        calib = json.load(open(os.path.join(cdir, "calibration.json")))
        cov = json.load(open(os.path.join(cdir, "coverage.json")))
        bspec = det["board"]
        square = float(calib["square_mm"])
        w, h = det["size"]
        K = np.asarray(calib["K"], np.float64)
        dist = np.asarray(calib["dist"], np.float64)
        P0 = board.corner_points(bspec)                    # squares, nominal
        sc = 1.0                                           # both captures are 1080 on the short side

        # the frames: every frame with >= 8 corners in the desktop's chosen set, spread over time
        # the fixture stores corners to 0.01 px: compute every expected value from those rounded
        # corners (in OpenCV's convention, i.e. minus the 0.5 again), not from the originals
        for f in det["frames"]:
            f["corners"] = [[round(float(c[0]) + 0.5, 2) - 0.5, round(float(c[1]) + 0.5, 2) - 0.5] for c in f["corners"]]
        best = cal.frame_views(det, min_markers=2)
        ext = cal.frame_views(det, step1.FALLBACK_SHARPNESS, min_markers=1)
        cands = [i for i, (v, e) in enumerate(zip(best, ext))
                 if len(v["ids"]) >= cal.MIN_POSE_CORNERS or len(e["ids"]) >= cal.MIN_POSE_CORNERS]
        pick = [cands[i] for i in sorted(set(np.linspace(0, len(cands) - 1, min(n_frames, len(cands))).astype(int)))]

        frames = []
        for i in pick:
            f = det["frames"][i]
            p = poses["frames"][i]
            assert p["index"] == f["index"]
            v = best[i] if p["corner_set"] == "best" else ext[i]
            plain = cal.solve_pose(P0[v["ids"]], v["img"], K, dist, sc)
            rec = {
                "index": f["index"], "time": f["time"],
                # all detected corners: ids, flat x/y (types.js pixel convention, 0.01 px), and which
                # of the desktop's corner sets each is in (from its unrounded sharpness and marker
                # count): 2 = "best" (sharpness >= 50, two markers), 1 = "extended" only (>= 25, one
                # marker), 0 = neither
                "ids": [int(k) for k in f["ids"]],
                "xy": [round(float(c[k]) + 0.5, 2) for c in f["corners"] for k in (0, 1)],   # exact: rounded above
                "set": [2 if (s >= cal.MIN_CORNER_SHARPNESS and m >= 2) else 1 if (s >= step1.FALLBACK_SHARPNESS and m >= 1) else 0
                        for s, m in zip(f["corner_sharpness"], f["corner_markers"])],
                "corner_set": p["corner_set"],
                "desktop": {"valid": p["valid"], "reason": p["reason"], "R": p["R"], "t": p["t"],
                            "center": p["center"], "rms_px": p["rms_px"], "corners_used": p["corners_used"]},
                "plain": None,
            }
            if plain is not None:
                import cv2
                R, _ = cv2.Rodrigues(plain[0])
                C = -R.T @ plain[1]
                rec["plain"] = {"R": np.round(R, 10).ravel().tolist(), "t": np.round(plain[1] * square, 6).tolist(),
                                "center": np.round(C * square, 6).tolist(), "rms_px": round(plain[3], 6),
                                "inliers": int(plain[2].sum())}
            frames.append(rec)

        # the desktop's closed-form focal and k1 calibration on the fixture's views: the sharp
        # (>= 50) two-marker corners of frames with >= 12 of them that span the plane; principal
        # point at the centre, as on the phone. (All corners, blurred ones included, can make the
        # desktop's calibration collapse: spinel f 1410 px, RMS 42 px.)
        views = []
        for i in pick:
            v = best[i]
            if len(v["ids"]) >= cal.MIN_CALIB_CORNERS and cal._spans_plane(P0[v["ids"]]):
                views.append((P0[v["ids"]] * square, v["img"]))
        f_closed = cal.homography_focal([v[0] for v in views], [v[1] for v in views], (w, h))
        K0 = np.array([[f_closed, 0, (w - 1) / 2.0], [0, f_closed, (h - 1) / 2.0], [0, 0, 1]])
        c = cal.calibrate([v[0] for v in views], [v[1] for v in views], (w, h), K=K0, dist_terms="k1", s=sc)
        fixed_k1 = next((x for x in calib.get("lens_model", {}).get("candidates", []) if x["name"] == "k1"), None)

        out = {
            "capture": name,
            "note": ("Generated by make_fixture.py from HousekiScanner work/captures/%s. Pixel coordinates "
                     "are OpenCV's + 0.5 (types.js convention)." % name),
            "image_size": [w, h],
            "spec": {
                "format": "houseki.board.v1", "dictionary": bspec["dictionary"],
                "squares_x": bspec["squares_x"], "squares_y": bspec["squares_y"], "legacy": bspec["legacy"],
                "square_mm": square, "marker_ratio": bspec["marker_ratio"],
                "frame": "origin at the top-left chessboard corner; X down the page (rows), Y right (columns), Z up out of the paper; millimetres",
                "target": {"centre_mm": cov["stone_point"]},
                "removed_marker_ids": [], "invalid_corner_ids": [],
            },
            "desktop_calibration": {
                "model": calib["model"], "f": K[0, 0], "cx": K[0, 2] + 0.5, "cy": K[1, 2] + 0.5, "k1": dist[0],
                "rms_px": calib["rms_px"], "f_std_px": calib["f_std_px"], "views": calib["views"],
                "nominal_board": calib["nominal_board"],
                "fixed_centre_k1_candidate": None if fixed_k1 is None else {"f": fixed_k1["f"], "k1": fixed_k1["dist"][0]},
            },
            "refined_corners_mm": calib["board_corners_refined_mm"],
            "port_check": {
                "views": len(views),
                "homography_focal": f_closed,
                "calibrate_k1": {"f": float(c["K"][0, 0]), "k1": float(c["dist"][0]), "rms_px": c["rms"],
                                 "f_std": c["f_std"], "points": c["points"]},
            },
            "frames": frames,
        }
        path = os.path.join(HERE, f"{name}.json")
        with open(path, "w") as fh:
            json.dump(out, fh, separators=(",", ":"))
        print(f"{name}: {len(frames)} frames, {len(views)} calibration views, closed-form f {f_closed:.1f}, "
              f"k1 calibration f {c['K'][0, 0]:.1f} k1 {c['dist'][0]:.4f} rms {c['rms']:.3f} -> "
              f"{os.path.getsize(path) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
