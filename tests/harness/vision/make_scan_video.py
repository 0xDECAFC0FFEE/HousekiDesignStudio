"""A synthetic phone video of a rock on the printed board, with its truth (T-0326).

Chrome's fake camera can play a file instead of its test pattern
(`--use-file-for-fake-video-capture=<file>.mjpeg`: a plain run of JPEG frames, played at 30 frames a
second and looped; measured 2026-10-04). This writes such a file: a few camera views of a rock on
the board, ray-traced by tests/harness/vision/synth.js (via scan_video.js in headless Chrome on the
real GPU), each held for a few seconds, as a phone held still over the board in turn from a few
directions. With it, the phone page sees a realistic camera whose every pose is known, so the
end-to-end test (tests/harness/test_scan_vision.py) can check the pose and outline the studio
receives, and the docs' screenshots show the overlay on a real-looking picture.

    from make_scan_video import ensure_video
    video = ensure_video()    # cached in tests/output/scan_video/ while CONFIG is unchanged
    video["mjpeg"], video["truth"]["views"][0]["azimuthDeg"], video["masks"][0]

The truth's angles and distance follow pose.js (azimuth from +X towards +Y, of the camera seen
from the target; elevation above the board; distance to the target centre), so they compare
directly with what the phone sends.

Run directly to (re)make it:  ~/.pyenv/versions/anaconda3-2019.07/bin/python3 tests/harness/vision/make_scan_video.py

The scan guidance's video (T-0331, GUIDE_CONFIG below: a moving camera, a fast motion-blurred swing
and a defocused hold, on the strip sheet) is ensure_guide_video(), cached in
tests/output/scan_guide_video/; `make_scan_video.py --guide` makes it.
"""

import base64
import functools
import hashlib
import http.server
import json
import math
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.dirname(HERE)
PROJECT_ROOT = os.path.dirname(os.path.dirname(HARNESS))
OUTPUT = os.path.join(PROJECT_ROOT, "tests", "output", "scan_video")
OUTPUT_GUIDE = os.path.join(PROJECT_ROOT, "tests", "output", "scan_guide_video")
PAGE = "/tests/harness/vision/scan_video.html"

sys.path.insert(0, HARNESS)

# The video. A phone held sideways (1280 x 720, its main camera's focal length 1000 px: a 1x lens,
# 8% narrower than the phone page's first guess, so the live calibration has something to do),
# 165-185 mm from a rock on the target of the large target sheet WITHOUT dots: not the sheet the
# phone assumes before it has seen any (that is the dotted one), so the test also sees it
# recognise the sheet. Three views, each held HOLD_S seconds.
#
# Landscape because the phone page asks for 1280 x 720: a phone reads that in its sensor's own
# (landscape) orientation and turns the frames upright itself, but Chrome's fake camera does not,
# and CROPS a portrait file to fit (measured: a 720 x 1280 file arrived as its middle 720 x 720).
CONFIG = {
    "sheet": "charuco_23x17_10mm_centre3x3",
    "width": 1280,
    "height": 720,
    "f": 1000,
    "k1": 0.02,
    "aperture": 2.5,
    "samples": 24,
    "noise": 1.5,
    "quality": 0.9,
    "rock": {"colour": [0.36, 0.16, 0.09], "axes": [9, 7, 6], "zc": 4.5, "turnDeg": 25, "seed": 3},
    "views": [
        {"azimuth": 200, "elevation": 55, "distanceMm": 170, "roll": 0},
        {"azimuth": 320, "elevation": 42, "distanceMm": 185, "roll": 6},
        {"azimuth": 80, "elevation": 66, "distanceMm": 165, "roll": -5},
    ],
    "holdS": 4,
    "fps": 30,
}

# The scan guidance's video (T-0331): the camera MOVING, on the strip sheet (the one in use), with a
# known pose for every distinct frame. Segments (azimuths in synth.js lookAt's convention: the camera
# looks from azimuth + 180 in pose.js's, so 20 here is 200 there):
#   settle   3 s held, 30 degrees up where the orbit starts (a jump would read as motion): the phone
#            finds the board and its first lens estimate;
#   slow     15 s orbit at 30 degrees through 180 degrees of azimuth (12 degrees a second, the desktop's
#            "30 seconds a circle"): coverage fills, the rock's position is found, nothing warns;
#   fast     1.5 s swing at 60 degrees a second, each frame averaged over a 12 ms exposure (5 camera
#            positions): motion blur, and the board moving ~60 mm/s, over the 25 mm/s limit;
#   calm     2.5 s held where the swing ended: the "too fast" warning clears;
#   defocus  3 s held with a wider lens (4.2 mm) focused 90 mm BEHIND the rock: the far board sharp
#            enough to be found, the rock blurred over the 0.20 mm ceiling. Measured: 70 mm behind
#            with a 4 mm lens read only 0.22 mm, too close to the ceiling for a test; 110 mm with
#            4.5 mm read 0.32 mm but the phone sometimes lost the board altogether (no pose, so no
#            measure), when its processing size had stepped down;
#   focus    2.5 s held, the same lens focused on the rock: no focus warning.
# Moving segments are rendered at `renderFps` distinct frames a second (the phone processes ~8),
# each repeated to the video's 30.
GUIDE_CONFIG = {
    "sheet": "charuco_23x17_10mm_strip",
    "width": 1280,
    "height": 720,
    "f": 1000,
    "k1": 0.02,
    "aperture": 2.5,
    "noise": 1.5,
    "quality": 0.9,
    "rock": {"colour": [0.36, 0.16, 0.09], "axes": [9, 7, 6], "zc": 4.5, "turnDeg": 25, "seed": 3},
    "fps": 30,
    "segments": [
        {"name": "settle", "kind": "hold", "at": [20, 30, 180], "seconds": 3, "samples": 24},
        {"name": "slow", "kind": "move", "from": [20, 30, 180], "to": [200, 30, 180], "seconds": 15, "renderFps": 10, "samples": 12},
        {"name": "fast", "kind": "move", "from": [200, 30, 180], "to": [290, 30, 180], "seconds": 1.5, "renderFps": 15,
         "exposureMs": 12, "subframes": 5, "samples": 6},
        {"name": "calm", "kind": "hold", "at": [290, 30, 180], "seconds": 2.5, "samples": 24},
        {"name": "defocus", "kind": "hold", "at": [320, 45, 170], "seconds": 3, "samples": 40, "aperture": 4.2, "focusOffsetMm": 90},
        {"name": "focus", "kind": "hold", "at": [340, 45, 170], "seconds": 2.5, "samples": 24, "aperture": 4},
    ],
}

# A segment's camera: [azimuth, elevation, distanceMm] and, optionally, [aimX, aimY] (mm: where the
# camera aims, from the rock; a phone sliding over the board rather than orbiting the rock).
CAMERA_KEYS = ("azimuth", "elevation", "distanceMm", "aimX", "aimY")

# The overlay-lag video (T-0332): the camera moving at realistic scanning speeds with EVERY frame
# distinct (renderFps = fps, so what is on screen is known for each frame the phone shows), and each
# frame stamped with its index (stamp_frame: a row of black/white blocks at the bottom left that the
# harness reads back from the phone's <video>). Segments, on the strip sheet, 35 degrees up, 180 mm:
#   still   4 s held: the overlay's shimmer when the phone is still;
#   orbit   10 s round the rock at 12 degrees a second (the guidance's slow orbit; the board moves
#           10-20 mm/s on screen);
#   slide   2 s sliding sideways 40 mm (20 mm/s: the whole picture moves), and 2 s back;
#   swing   1.5 s round the rock at 40 degrees a second (a quick swing, 10 ms of motion blur);
#   rest    4 s held: shimmer again, after a swing.
LAG_CONFIG = {
    "sheet": "charuco_23x17_10mm_strip",
    "width": 1280,
    "height": 720,
    "f": 1000,
    "k1": 0.02,
    "aperture": 2.5,
    "noise": 1.5,
    "quality": 0.9,
    "rock": {"colour": [0.36, 0.16, 0.09], "axes": [9, 7, 6], "zc": 4.5, "turnDeg": 25, "seed": 3},
    "fps": 30,
    "stamp": {"x": 4, "block": 10, "bits": 12, "bottom": 4},
    "segments": [
        # Held segments are "moves" that stay put: every frame rendered anew, so each has its own
        # noise, as a real camera's frames do (one repeated JPEG gives the same pose every frame and
        # no shimmer to measure).
        {"name": "still", "kind": "move", "from": [20, 35, 180], "to": [20, 35, 180], "seconds": 4, "renderFps": 30, "samples": 8},
        {"name": "orbit", "kind": "move", "from": [20, 35, 180], "to": [140, 35, 180], "seconds": 10, "renderFps": 30, "samples": 8},
        {"name": "slide", "kind": "move", "from": [140, 35, 180, 0, 0], "to": [140, 35, 180, 0, 40], "seconds": 2, "renderFps": 30, "samples": 8},
        {"name": "back", "kind": "move", "from": [140, 35, 180, 0, 40], "to": [140, 35, 180, 0, 0], "seconds": 2, "renderFps": 30, "samples": 8},
        {"name": "swing", "kind": "move", "from": [140, 35, 180], "to": [200, 35, 180], "seconds": 1.5, "renderFps": 30,
         "exposureMs": 10, "subframes": 3, "samples": 6},
        {"name": "rest", "kind": "move", "from": [200, 35, 180], "to": [200, 35, 180], "seconds": 4, "renderFps": 30, "samples": 8},
    ],
}
OUTPUT_LAG = os.path.join(PROJECT_ROOT, "tests", "output", "scan_lag_video")


def stamp_frame(jpeg, index, stamp, quality):
    """The JPEG with `index` written into it as stamp["bits"] blocks (most significant first) between
    a white block and a black one, each stamp["block"] px square, along the bottom-left edge. The
    harness reads the block centres back (tests/harness/test_scan_lag.py STAMP_READER)."""
    import io

    from PIL import Image, ImageDraw

    image = Image.open(io.BytesIO(jpeg)).convert("RGB")
    draw = ImageDraw.Draw(image)
    size = stamp["block"]
    top = image.height - stamp["bottom"] - size
    values = [1] + [(index >> (stamp["bits"] - 1 - k)) & 1 for k in range(stamp["bits"])] + [0]

    for k, value in enumerate(values):
        x = stamp["x"] + k * size
        draw.rectangle([x, top, x + size - 1, top + size - 1], fill=(255, 255, 255) if value else (0, 0, 0))

    out = io.BytesIO()
    image.save(out, "JPEG", quality=int(quality * 100))
    return out.getvalue()


def ensure_lag_video(config=LAG_CONFIG, out_dir=OUTPUT_LAG):
    """The overlay-lag video, made if not already in `out_dir`. Returns { mjpeg, truth }: truth as
    ensure_guide_video's (every distinct frame's segment, time and camera, in stamp order: frame k
    of truth["frames"] carries stamp k)."""
    os.makedirs(out_dir, exist_ok=True)
    truth_path = os.path.join(out_dir, "truth.json")
    key = config_hash(config)

    if os.path.isfile(truth_path):
        with open(truth_path) as handle:
            truth = json.load(handle)

        if truth.get("configHash") == key and os.path.isfile(truth["mjpeg"]):
            return {"mjpeg": truth["mjpeg"], "truth": truth}

    started = time.time()
    plan = _guide_specs(config)
    # Each frame its own noise: scan_video.js seeds by the index within a batch unless told.
    rendered = _render_frames(config, [dict(spec, seed=k + 1) for k, (*_, spec) in enumerate(plan)])
    mjpeg = os.path.join(out_dir, "lag.mjpeg")
    frames = []

    with open(mjpeg, "wb") as video:
        for index, ((segment, start, end, repeat, spec), frame) in enumerate(zip(plan, rendered)):
            jpeg = stamp_frame(_decode(frame["jpeg"]), index, config["stamp"], config["quality"])

            for _ in range(repeat):
                video.write(jpeg)

            frames.append({"index": index, "segment": segment, "startS": round(start, 4), "endS": round(end, 4),
                           "R": frame["R"], "t": frame["t"], "center": frame["center"]})

    truth = {
        "configHash": key, "config": config, "mjpeg": mjpeg, "width": config["width"], "height": config["height"],
        "f": config["f"], "k1": config["k1"], "sheet": config["sheet"], "stamp": config["stamp"],
        "loopS": round(sum(seg["seconds"] for seg in config["segments"]), 4),
        "segments": [{"name": seg["name"], "startS": round(sum(s["seconds"] for s in config["segments"][:i]), 4),
                      "endS": round(sum(s["seconds"] for s in config["segments"][:i + 1]), 4)}
                     for i, seg in enumerate(config["segments"])],
        "frames": frames,
        "renderS": round(time.time() - started, 1),
    }

    with open(truth_path, "w") as handle:
        json.dump(truth, handle, indent=1)

    return {"mjpeg": mjpeg, "truth": truth}


# The rock's middle, where the guidance measures angles from: the centre of the ellipsoid the
# synthetic rock is cut from (the target, zc above the board).
def rock_centre(config):
    tx, ty = TARGET_MM[config["sheet"]]
    return [tx, ty, config["rock"]["zc"]]


# The sheet's target centre (board_frame / the spec's target.centre_mm), where the angles are
# measured from.
TARGET_MM = {"charuco_23x17_10mm_centre3x3": [85.0, 115.0], "charuco_23x17_10mm_centre3x3_dots": [85.0, 115.0],
             "charuco_23x17_10mm_centre1": [85.0, 115.0], "charuco_23x17_10mm_strip": [80.0, 110.0]}


def config_hash(config):
    return hashlib.sha1(json.dumps(config, sort_keys=True).encode()).hexdigest()[:12]


def view_truth(view, sheet):
    """pose.js's azimuth, elevation and distance of a rendered view's camera, from the target."""
    tx, ty = TARGET_MM[sheet]
    cx, cy, cz = view["center"]
    u = (cx - tx, cy - ty, cz)
    horizontal = math.hypot(u[0], u[1])
    return {
        "azimuthDeg": (math.degrees(math.atan2(u[1], u[0])) + 360) % 360,
        "elevationDeg": math.degrees(math.atan2(u[2], horizontal)),
        "distanceMm": math.sqrt(u[0] ** 2 + u[1] ** 2 + u[2] ** 2),
    }


def _render(config):
    """Renders the views in headless Chrome on the real GPU; returns scan_video.js's result."""
    import cdp  # noqa: E402 -- needs websocket-client
    from test_vision_detect import native_chrome  # noqa: E402

    handler = functools.partial(_QuietHandler, directory=PROJECT_ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    chrome = native_chrome(gl_backend="metal")

    try:
        chrome.navigate("http://localhost:%d%s" % (server.server_address[1], PAGE))
        chrome.wait_for_expression("window.scanVideoReady === true || !!window.scanVideoError", timeout=60)
        error = chrome.evaluate("window.scanVideoError || null")

        if error:
            raise RuntimeError("the generator page failed: %s" % error)

        result = chrome.send("Runtime.evaluate", {
            "expression": "scanVideo.renderViews(%s)" % json.dumps(config),
            "awaitPromise": True, "returnByValue": True,
        }, timeout=600)

        if result.get("exceptionDetails"):
            raise RuntimeError(json.dumps(result["exceptionDetails"])[:2000])

        return result["result"]["value"]
    finally:
        chrome.close()
        server.shutdown()
        server.server_close()


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def _decode(data_url):
    return base64.b64decode(data_url.split(",", 1)[1])


def ensure_video(config=CONFIG, out_dir=OUTPUT):
    """The video for `config`, made if it is not already in `out_dir`. Returns { mjpeg, truth,
    frames: [jpeg path per view], masks: [png path per view] }."""
    os.makedirs(out_dir, exist_ok=True)
    truth_path = os.path.join(out_dir, "truth.json")
    key = config_hash(config)

    if os.path.isfile(truth_path):
        with open(truth_path) as handle:
            truth = json.load(handle)

        if truth.get("configHash") == key and os.path.isfile(truth["mjpeg"]):
            return _paths(truth, out_dir)

    started = time.time()
    rendered = _render(config)
    views = []
    mjpeg = os.path.join(out_dir, "board.mjpeg")

    with open(mjpeg, "wb") as video:
        for index, view in enumerate(rendered["views"]):
            jpeg = _decode(view["jpeg"])

            with open(os.path.join(out_dir, "view_%d.jpg" % index), "wb") as handle:
                handle.write(jpeg)

            with open(os.path.join(out_dir, "view_%d_mask.png" % index), "wb") as handle:
                handle.write(_decode(view["mask"]))

            for _ in range(config["holdS"] * config["fps"]):
                video.write(jpeg)

            views.append(dict(view_truth(view, config["sheet"]), R=view["R"], t=view["t"], center=view["center"],
                              startS=index * config["holdS"], endS=(index + 1) * config["holdS"]))

    truth = {
        "configHash": key,
        "config": config,
        "mjpeg": mjpeg,
        "width": config["width"],
        "height": config["height"],
        "f": config["f"],
        "k1": config["k1"],
        "sheet": config["sheet"],
        "views": views,
        "loopS": len(views) * config["holdS"],
        "renderS": round(time.time() - started, 1),
    }

    with open(truth_path, "w") as handle:
        json.dump(truth, handle, indent=1)

    return _paths(truth, out_dir)


def angles_from(center, point):
    """pose.js / guidance.js angles of a camera centre seen from a point (azimuth from +X towards +Y)."""
    u = [center[i] - point[i] for i in range(3)]
    horizontal = math.hypot(u[0], u[1])
    return {
        "azimuthDeg": (math.degrees(math.atan2(u[1], u[0])) + 360) % 360,
        "elevationDeg": math.degrees(math.atan2(u[2], horizontal)),
        "distanceMm": math.sqrt(sum(v * v for v in u)),
    }


def _guide_specs(config):
    """The distinct frames of GUIDE_CONFIG: [(segment, startS, endS, repeat, spec)]."""
    fps = config["fps"]
    frames = []
    t = 0.0

    for seg in config["segments"]:
        common = {"samples": seg.get("samples", 24), "aperture": seg.get("aperture", config["aperture"]),
                  "focusOffsetMm": seg.get("focusOffsetMm", 0)}

        if seg["kind"] == "hold":
            count = int(round(seg["seconds"] * fps))
            spec = dict(common, subs=[dict(zip(CAMERA_KEYS, seg["at"]))], mask=True)
            frames.append((seg["name"], t, t + seg["seconds"], count, spec))
            t += seg["seconds"]
            continue

        distinct = int(round(seg["seconds"] * seg["renderFps"]))
        repeat = int(round(fps / seg["renderFps"]))
        step = 1.0 / seg["renderFps"]

        for k in range(distinct):
            subs = []
            n = seg.get("subframes", 1)

            for j in range(n):
                # the exposure, centred on the frame's time
                dt = (j / (n - 1) - 0.5) * seg.get("exposureMs", 0) / 1000.0 if n > 1 else 0.0
                s = min(1.0, max(0.0, (k * step + dt) / seg["seconds"]))
                subs.append({key: seg["from"][i] + s * (seg["to"][i] - seg["from"][i])
                             for i, key in enumerate(CAMERA_KEYS[:len(seg["from"])])})

            frames.append((seg["name"], t + k * step, t + (k + 1) * step, repeat, dict(common, subs=subs, mask=False)))

        t += seg["seconds"]

    return frames


def ensure_guide_video(config=GUIDE_CONFIG, out_dir=OUTPUT_GUIDE):
    """The scan guidance's moving video for `config`, made if not already in `out_dir`. Returns
    { mjpeg, truth } with truth["frames"]: every distinct frame's segment, [startS, endS) in the
    video, camera (R, t, center), angles from the target and from the rock's centre."""
    os.makedirs(out_dir, exist_ok=True)
    truth_path = os.path.join(out_dir, "truth.json")
    key = config_hash(config)

    if os.path.isfile(truth_path):
        with open(truth_path) as handle:
            truth = json.load(handle)

        if truth.get("configHash") == key and os.path.isfile(truth["mjpeg"]):
            return {"mjpeg": truth["mjpeg"], "truth": truth}

    started = time.time()
    plan = _guide_specs(config)
    rendered = _render_frames(config, [spec for *_, spec in plan])
    mjpeg = os.path.join(out_dir, "guide.mjpeg")
    rock = rock_centre(config)
    target = TARGET_MM[config["sheet"]] + [0.0]
    frames = []

    with open(mjpeg, "wb") as video:
        for index, ((segment, start, end, repeat, spec), frame) in enumerate(zip(plan, rendered)):
            jpeg = _decode(frame["jpeg"])

            for _ in range(repeat):
                video.write(jpeg)

            if spec["mask"]:
                with open(os.path.join(out_dir, "%s.jpg" % segment), "wb") as handle:
                    handle.write(jpeg)

                with open(os.path.join(out_dir, "%s_mask.png" % segment), "wb") as handle:
                    handle.write(_decode(frame["mask"]))

            frames.append({"index": index, "segment": segment, "startS": round(start, 4), "endS": round(end, 4),
                           "R": frame["R"], "t": frame["t"], "center": frame["center"],
                           "fromTarget": angles_from(frame["center"], target), "fromRock": angles_from(frame["center"], rock)})

    truth = {
        "configHash": key, "config": config, "mjpeg": mjpeg, "width": config["width"], "height": config["height"],
        "f": config["f"], "k1": config["k1"], "sheet": config["sheet"], "rockMm": rock, "targetMm": target,
        "loopS": round(sum(seg["seconds"] for seg in config["segments"]), 4),
        "segments": [{"name": seg["name"], "startS": round(sum(s["seconds"] for s in config["segments"][:i]), 4),
                      "endS": round(sum(s["seconds"] for s in config["segments"][:i + 1]), 4)}
                     for i, seg in enumerate(config["segments"])],
        "frames": frames,
        "renderS": round(time.time() - started, 1),
    }

    with open(truth_path, "w") as handle:
        json.dump(truth, handle, indent=1)

    return {"mjpeg": mjpeg, "truth": truth}


def _render_frames(config, specs, batch=6):
    """scan_video.js renderFrames for every spec, in batches (each result carries JPEGs as data URLs:
    a few MB a batch over CDP)."""
    import cdp  # noqa: E402 -- needs websocket-client
    from test_vision_detect import native_chrome  # noqa: E402

    handler = functools.partial(_QuietHandler, directory=PROJECT_ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    chrome = native_chrome(gl_backend="metal")
    out = []

    try:
        chrome.navigate("http://localhost:%d%s" % (server.server_address[1], PAGE))
        chrome.wait_for_expression("window.scanVideoReady === true || !!window.scanVideoError", timeout=60)
        error = chrome.evaluate("window.scanVideoError || null")

        if error:
            raise RuntimeError("the generator page failed: %s" % error)

        for first in range(0, len(specs), batch):
            result = chrome.send("Runtime.evaluate", {
                "expression": "scanVideo.renderFrames(%s, %s)" % (json.dumps(config), json.dumps(specs[first:first + batch])),
                "awaitPromise": True, "returnByValue": True,
            }, timeout=600)

            if result.get("exceptionDetails"):
                raise RuntimeError(json.dumps(result["exceptionDetails"])[:2000])

            out.extend(result["result"]["value"]["frames"])
            print("rendered %d of %d frames" % (len(out), len(specs)), file=sys.stderr)

        return out
    finally:
        chrome.close()
        server.shutdown()
        server.server_close()


def _paths(truth, out_dir):
    count = len(truth["views"])
    return {
        "mjpeg": truth["mjpeg"],
        "truth": truth,
        "frames": [os.path.join(out_dir, "view_%d.jpg" % k) for k in range(count)],
        "masks": [os.path.join(out_dir, "view_%d_mask.png" % k) for k in range(count)],
    }


if __name__ == "__main__":
    if "--lag" in sys.argv:
        made = ensure_lag_video()
        print(json.dumps({k: v for k, v in made["truth"].items() if k not in ("config", "frames")}, indent=1))
    elif "--guide" in sys.argv:
        made = ensure_guide_video()
        print(json.dumps({k: v for k, v in made["truth"].items() if k not in ("config", "frames")}, indent=1))
    else:
        made = ensure_video()
        print(json.dumps({k: v for k, v in made["truth"].items() if k != "config"}, indent=1)[:3000])
