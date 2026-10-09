"""How far the phone's overlay trails its camera picture while the phone moves (T-0332).

The user, 2026-10-06: "its still too slow" ... "the overlay is lagging". The overlay (the board's
grid, the X/Y/Z arrows at the board's centre, the rock's outline) is drawn on every camera frame the
phone shows, from the latest vision result, whose pose was measured on an earlier frame.

This runs the BUILT pages as test_scan_guide.py does (studio and phone page in two headless
Chromes, a local Nostr relay, the phone's vision starting once it has connected), with the phone's
fake camera playing the overlay-lag video (make_scan_video.LAG_CONFIG): every frame distinct at 30
frames a second, the camera held still, orbiting the rock at 12 degrees a second, sliding sideways
at 20 mm/s and back, swinging at 40 degrees a second, and held again; every frame stamped with its
index at its bottom-left edge.

In the phone page, a hook (housekiScanVision.onDraw) runs right after each overlay is drawn, in the
same video-frame callback: it reads the stamp of the frame on screen from the <video> and logs where
the axes' origin (the board's centre, 85 / 115 mm) was drawn, in camera-frame pixels, and the age of
the pose drawn. Each logged frame is then compared with the TRUE projection of the board's centre in
the frame that was on screen (the video's known camera, f 1000 px, k1 0.02), giving per segment:

  * misplacement: drawn origin vs true origin, px of the 1280 x 720 camera frame;
  * pose age at display: how far the pose drawn trails the picture (ms);
  * shimmer when still: on the held segments (after their first second), how much the drawn origin
    moves about its mean (RMS px), and the misplacement there (what the lens estimate leaves);
  * results a second and the stages' times (housekiScanVision.latency());
  * and that the phone's speed line is hidden until the status lines are long-pressed, then shows
    its numbers, and hides on a second long press.

The numbers are printed and written to tests/output/scan_lag_video/last_run.json. The assertions
are the ticket's targets with margin (see the constants). It is a MEASUREMENT: run it through the
GPU queue, alone, when timing numbers matter:

    ./build.sh   # or: python3 src/scripts/make_page.py --skip-build
    tools/gpu_queue.py run --as <agent> --label "timing: overlay lag" -- \\
        ~/.pyenv/versions/anaconda3-2019.07/bin/python3 -m unittest tests/harness/test_scan_lag.py -v

Headless Chrome does not start inside the agent command sandbox.
"""

import json
import math
import os
import shutil
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))
STUDIO_PAGE = os.path.join(PROJECT_ROOT, "build", "www", "studio.html")
SCANNER_PAGE = os.path.join(PROJECT_ROOT, "build", "www", "scanner", "index.html")

sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "vision"))

try:
    import cdp
    from test_scan_link import CHROME_ARGS, CONNECT_TIMEOUT, Relay, Server
    # The module, not the class: a TestCase imported by name would run its tests here too.
    import test_scan_vision
    from test_scan_vision import RELAYS_SETTING, js
    from test_vision_detect import native_chrome
    from make_scan_video import OUTPUT_LAG, ensure_lag_video
except ImportError as error:  # websocket-client, numpy or PIL missing
    cdp = None
    IMPORT_ERROR = str(error)

SHEET = "charuco_23x17_10mm_strip"
BOARD_CENTRE_MM = [85.0, 115.0, 0.0]
# Board points every 20 mm over the 170 x 230 mm chessboard, for the whole grid's misplacement.
GRID_MM = [[float(x), float(y), 0.0] for x in range(5, 170, 20) for y in range(5, 230, 20)]

# Two loops of the 23.5 s video after the first pose: the second runs with the lens estimated.
COLLECT_S = 50

# GEM_LAG_TRACKING=0 turns the phone's tracking between detections off (housekiScanVision.state.
# tracking), to measure what it adds.
TRACKING = os.environ.get("GEM_LAG_TRACKING", "1") != "0"

# GEM_LAG_CPU_THROTTLE=N makes the phone page N times slower, as a stand-in for a phone (estimated
# 2-4x slower than the M1 Pro): its main thread by CDP Emulation.setCPUThrottlingRate, its vision
# Worker by housekiScanVision.state.slowdown. Only the measurement changes; the targets are not
# asserted then (the printout is the result).
CPU_THROTTLE = float(os.environ.get("GEM_LAG_CPU_THROTTLE", "1"))

# Segments by kind.
HELD = ("still", "rest")
MOVING = ("orbit", "slide", "back", "swing")

# The targets. Measured 2026-10-06 on the M1 Pro (native headless Chrome, queued): before T-0332
# (the 120 ms exponential smoother, no prediction) the grid's median misplacement while moving was
# 12.4 px (p90 18.8); with the filter carried forward to the frame on screen 0.56 px (p90 0.90), the
# lens estimate's own floor being 0.51 px. Shimmer when still 0.02 px (the synthetic poses are
# nearly noise-free; tests/vision_pose_filter_test.js checks noisy ones).
MAX_MOVING_GRID_PX = 2.0
MAX_MOVING_GRID_P90_PX = 5.0
MAX_STILL_SHIMMER_PX = 0.3

# A held segment's first second is left out of the shimmer (the overlay settles after the jump back
# to the start of the loop, or after the swing).
SETTLE_S = 1.0

# The stamp reader, run in the phone page after each draw: the blocks' centres, 4 x 4 px each,
# white above 128; null unless the first block is white and the last black.
STAMP_READER = """(() => {
  const st = %(stamp)s;
  const n = st.bits + 2;
  const canvas = new OffscreenCanvas(n * st.block, st.block);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  window.__readStamp = (video) => {
    const top = video.videoHeight - st.bottom - st.block;
    ctx.drawImage(video, st.x, top, n * st.block, st.block, 0, 0, n * st.block, st.block);
    const d = ctx.getImageData(0, 0, n * st.block, st.block).data;
    const bit = (k) => {
      let sum = 0;
      for (let y = st.block / 2 - 2; y < st.block / 2 + 2; y += 1)
        for (let x = k * st.block + st.block / 2 - 2; x < k * st.block + st.block / 2 + 2; x += 1)
          sum += d[4 * (y * n * st.block + x) + 1];
      return sum / 16 > 128 ? 1 : 0;
    };
    if (bit(0) !== 1 || bit(n - 1) !== 0) return null;
    let value = 0;
    for (let k = 1; k <= st.bits; k += 1) value = value * 2 + bit(k);
    return value;
  };
})()"""

# Logs every drawn frame (in the same callback as the draw).
DRAW_LOGGER = """(() => {
  const video = document.getElementById('scanner-video');
  const log = window.__lagLog = [];
  const results = window.__lagResults = [];
  housekiScanVision.onDraw = ({ nowMs, frameTimeMs, presentedFrames, drawn }) => {
    let origin = null;
    if (drawn?.axes) {
      const { scale, dx, dy } = drawn.transform;
      origin = [(drawn.axes.origin[0] - dx) / scale, (drawn.axes.origin[1] - dy) / scale];
    }
    const state = housekiScanVision.state;
    const last = state.last;
    // Each new result once, detected or tracked (the raw pose and its frame's time, when it
    // arrived), for replaying the overlay's filter offline and judging tracked poses.
    for (const [key, r] of [['__lagLast', last], ['__lagTracked', state.lastTracked]]) {
      if (r && r !== window[key]) {
        window[key] = r;
        const p = r.pose;
        results.push({ at: nowMs, frameTimeMs: r.frame.timeMs, valid: !!p?.valid, R: p?.R ?? null, t: p?.t ?? null,
          lens: p?.intrinsics ? { f: p.intrinsics.f, cx: p.intrinsics.cx, cy: p.intrinsics.cy, k1: p.intrinsics.k1 ?? 0 } : null,
          kind: r.kind ?? 'detect', reason: r.track?.reason ?? null, kept: r.track?.kept ?? null });
      }
    }
    results.sort((a, b) => a.at - b.at || a.frameTimeMs - b.frameTimeMs);
    log.push({ at: nowMs, frameTimeMs, presentedFrames, stamp: window.__readStamp(video), origin, pose: drawn?.pose ?? null,
      ageMs: drawn?.poseAgeMs ?? null, predictedMs: drawn?.predictedMs ?? null, source: drawn?.source ?? null,
      lens: last?.intrinsics?.source ?? null, frame: last ? [last.frame.width, last.frame.height] : null });
  };
})()"""


def long_press(chrome, selector, ms=800):
    """A real press held `ms` on the middle of an element (CDP mouse input)."""
    box = chrome.evaluate("(() => { const r = document.querySelector(%s).getBoundingClientRect();"
                          " return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()" % json.dumps(selector))
    chrome.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": box["x"], "y": box["y"], "button": "none"})
    chrome.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": box["x"], "y": box["y"], "button": "left", "clickCount": 1})
    time.sleep(ms / 1000.0)
    chrome.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": box["x"], "y": box["y"], "button": "left", "clickCount": 1})


def project(point, R, t, f, cx, cy, k1):
    """The phone's camera model (camera_model.projectPoints) for one board point."""
    X = [sum(R[3 * i + j] * point[j] for j in range(3)) + t[i] for i in range(3)]
    u, v = X[0] / X[2], X[1] / X[2]
    d = 1 + k1 * (u * u + v * v)
    return f * u * d + cx, f * v * d + cy


def quantile(values, q):
    if not values:
        return None

    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int(round(q * (len(ordered) - 1)))))]


def analyse(log, truth):
    """Per segment: misplacement (px), pose age (ms), and, on held segments, shimmer (px). See the
    module's docstring. Returns a JSON-able dict."""
    frames = truth["frames"]
    width, height = truth["width"], truth["height"]
    entries = []

    for e in log:
        stamp = e["stamp"]

        if stamp is None or stamp >= len(frames):
            continue

        f = frames[stamp]
        entry = dict(e, segment=f["segment"])

        if e["origin"] is not None and e["frame"]:
            # Chrome's fake camera crops a file to the page's request around its middle.
            ox, oy = (width - e["frame"][0]) / 2.0, (height - e["frame"][1]) / 2.0
            u, v = project(BOARD_CENTRE_MM, f["R"], f["t"], truth["f"], width / 2.0, height / 2.0, truth["k1"])
            entry["error"] = math.hypot(e["origin"][0] + ox - u, e["origin"][1] + oy - v)

            if e["pose"]:
                # The whole grid: the median misplacement of the board points (every 20 mm) that
                # are on screen, each drawn with the pose and lens the page drew with.
                p = e["pose"]
                gaps = []

                for P in GRID_MM:
                    tu, tv = project(P, f["R"], f["t"], truth["f"], width / 2.0, height / 2.0, truth["k1"])

                    if 0 <= tu < width and 0 <= tv < height:
                        du, dv = project(P, p["R"], p["t"], p["f"], p["cx"], p["cy"], p["k1"])
                        gaps.append(math.hypot(du + ox - tu, dv + oy - tv))

                if gaps:
                    entry["gridError"] = quantile(gaps, 0.5)

        entries.append(entry)

    # Runs of consecutive frames in one segment, for "time into the segment".
    run_start = None

    for i, e in enumerate(entries):
        if i == 0 or e["segment"] != entries[i - 1]["segment"]:
            run_start = e["at"]
            e["run"] = (entries[i - 1]["run"] + 1) if i else 0
        else:
            e["run"] = entries[i - 1]["run"]

        e["intoS"] = (e["at"] - run_start) / 1000.0

    out = {"logged": len(log), "stamped": len(entries), "segments": {}}

    for name in [s["name"] for s in truth["segments"]]:
        seg = [e for e in entries if e["segment"] == name]
        drawn = [e for e in seg if "error" in e]
        errors = [e["error"] for e in drawn]
        grid = [e["gridError"] for e in drawn if "gridError" in e]
        ages = [e["ageMs"] for e in drawn if e["ageMs"] is not None]
        stats = {
            "frames": len(seg),
            "drawnShare": round(len(drawn) / len(seg), 3) if seg else None,
            "errorPx": {"median": quantile(errors, 0.5), "p90": quantile(errors, 0.9), "max": max(errors) if errors else None},
            "gridErrorPx": {"median": quantile(grid, 0.5), "p90": quantile(grid, 0.9), "max": max(grid) if grid else None},
            "ageMs": {"median": quantile(ages, 0.5), "p90": quantile(ages, 0.9)},
        }

        if name in HELD:
            # Shimmer: how much the drawn overlay moves about its own mean while the camera is
            # still (after SETTLE_S), per run: the RMS for the board's centre, and the median over
            # the on-screen grid points of each one's RMS.
            shimmer = []
            grid_shimmer = []

            for run in sorted({e["run"] for e in drawn}):
                settled = [e for e in drawn if e["run"] == run and e["intoS"] >= SETTLE_S]

                if len(settled) < 10:
                    continue

                shimmer.append(rms_spread([e["origin"] for e in settled]))
                truth_frame = frames[settled[0]["stamp"]]
                per_point = []

                for P in GRID_MM:
                    tu, tv = project(P, truth_frame["R"], truth_frame["t"], truth["f"], width / 2.0, height / 2.0, truth["k1"])

                    if 0 <= tu < width and 0 <= tv < height:
                        per_point.append(rms_spread([project(P, e["pose"]["R"], e["pose"]["t"], e["pose"]["f"], e["pose"]["cx"],
                                                             e["pose"]["cy"], e["pose"]["k1"]) for e in settled if e["pose"]]))

                grid_shimmer.append(quantile(per_point, 0.5))

            settled = [e["error"] for e in drawn if e["intoS"] >= SETTLE_S]
            stats["shimmerPx"] = [round(s, 3) for s in shimmer]
            stats["gridShimmerPx"] = [round(s, 3) for s in grid_shimmer if s is not None]
            stats["settledErrorPx"] = quantile(settled, 0.5)

        for key in ("errorPx", "gridErrorPx", "ageMs"):
            stats[key] = {k: (round(v, 2) if isinstance(v, float) else v) for k, v in stats[key].items()}

        out["segments"][name] = stats

    moving = [e["error"] for e in entries if e["segment"] in MOVING and "error" in e]
    moving_grid = [e["gridError"] for e in entries if e["segment"] in MOVING and "gridError" in e]
    ages = [e["ageMs"] for e in entries if e["segment"] in MOVING and e["ageMs"] is not None]
    out["moving"] = {"errorPxMedian": quantile(moving, 0.5), "errorPxP90": quantile(moving, 0.9),
                     "gridErrorPxMedian": quantile(moving_grid, 0.5), "gridErrorPxP90": quantile(moving_grid, 0.9),
                     "ageMsMedian": quantile(ages, 0.5), "ageMsP90": quantile(ages, 0.9)}
    out["stillShimmerPx"] = quantile([s for name in HELD for s in out["segments"][name].get("shimmerPx", [])], 0.5)
    out["stillGridShimmerPx"] = quantile([s for name in HELD for s in out["segments"][name].get("gridShimmerPx", [])], 0.5)
    return out


def rms_spread(points):
    """RMS distance of 2D points from their mean."""
    mx = sum(p[0] for p in points) / len(points)
    my = sum(p[1] for p in points) / len(points)
    return math.sqrt(sum((p[0] - mx) ** 2 + (p[1] - my) ** 2 for p in points) / len(points))


@unittest.skipIf(cdp is None, "needs websocket-client, numpy and PIL: %s" % (IMPORT_ERROR if cdp is None else ""))
@unittest.skipUnless(os.path.isfile(STUDIO_PAGE), "the studio is not built (%s); run ./build.sh" % STUDIO_PAGE)
@unittest.skipUnless(os.path.isfile(SCANNER_PAGE), "the phone page is not built (%s); run ./build.sh" % SCANNER_PAGE)
@unittest.skipUnless(shutil.which("deno"), "needs Deno, to run the local Nostr relay")
class ScanLagTest(unittest.TestCase):
    # The studio's helpers, as test_scan_vision.py drives it.
    if cdp is not None:
        finish_animations = test_scan_vision.ScanVisionTest.finish_animations
        click = test_scan_vision.ScanVisionTest.click
        press_escape = test_scan_vision.ScanVisionTest.press_escape
        open_mode = test_scan_vision.ScanVisionTest.open_mode

    @classmethod
    def setUpClass(cls):
        cls.video = ensure_lag_video()
        cls.truth = cls.video["truth"]
        cls.server = Server()
        cls.relay = Relay()

        try:
            cls.studio = cdp.Chrome(gl_backend="metal", extra_args=CHROME_ARGS, timeout=60)
        except Exception as error:  # no Chrome, or inside the sandbox
            cls.relay.close()
            cls.server.close()
            raise unittest.SkipTest("could not start Chrome: %s" % error)

        cls.studio.send("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
        cls.studio.navigate(cls.server.origin + "/studio.html", timeout=120)
        cls.studio.evaluate("localStorage.setItem(%s, %s), true" % (js(RELAYS_SETTING), js(json.dumps([cls.relay.url]))))
        cls.studio.navigate("about:blank")
        cls.studio.navigate(cls.server.origin + "/studio.html", timeout=120)
        cls.studio.wait_for_expression("!!window.gemApp", timeout=120)

    @classmethod
    def tearDownClass(cls):
        cls.studio.close()
        cls.relay.close()
        cls.server.close()

    def test_overlay_follows_the_moving_picture(self):
        """The overlay's misplacement and age while the phone moves, and its shimmer when still.

        Setup: the studio with Rough scan open; a phone browser whose camera plays the lag video on
        the strip sheet (the one board the phone supports), connected. Test: log every drawn
        overlay for COLLECT_S seconds with the stamp of the frame on screen, then compare it with
        the truth. Verifies: the stamps are read; the overlay is drawn on most frames; the
        misplacement while moving, the pose age and the shimmer when still are within the targets
        below; the studio's readout has the phone's Speed row.
        """
        phone = native_chrome(gl_backend="metal", extra_args=tuple(list(CHROME_ARGS) + [
            "--use-file-for-fake-video-capture=%s" % self.video["mjpeg"]]), timeout=60)

        try:
            link = self.open_mode()
            phone.navigate(link)
            phone.wait_for_expression("document.getElementById('scanner-status')?.dataset.status === 'connected'", timeout=CONNECT_TIMEOUT)
            self.studio.wait_for_expression("document.getElementById('scan-view').dataset.streaming === 'true'", timeout=CONNECT_TIMEOUT)
            phone.wait_for_expression("window.housekiScanVision?.state?.phase === 'pose'", timeout=90)
            phone.send("Page.bringToFront")

            if not TRACKING:
                phone.evaluate("housekiScanVision.state.tracking = false, true")

            if CPU_THROTTLE > 1:
                # The page's thread through Chrome's throttling; the Worker, which Chrome's
                # throttling does not reach (measured: detection stayed at 24 ms), through the page's
                # own harness knob (it spins for (N - 1) x each frame's time).
                phone.send("Emulation.setCPUThrottlingRate", {"rate": CPU_THROTTLE})
                phone.evaluate("housekiScanVision.state.slowdown = %g, true" % CPU_THROTTLE)
                time.sleep(3)  # the pipeline settles to the slower speed (processing size, cadence)

            phone.evaluate(STAMP_READER % {"stamp": json.dumps(self.truth["stamp"])} + ", true")
            phone.evaluate(DRAW_LOGGER + ", true")
            # The speed line: hidden at first; a long press on the status lines shows it, with its
            # numbers; another hides it again (as a person reads their phone's numbers).
            hidden = lambda: phone.evaluate("document.getElementById('scanner-diag').hidden")  # noqa: E731
            diag_hidden_at_first = hidden()
            long_press(phone, "#scanner-status")
            phone.wait_for_expression("!document.getElementById('scanner-diag').hidden"
                                      " && document.getElementById('scanner-diag').textContent.includes('poses/s')", timeout=10)
            diag_text = phone.evaluate("document.getElementById('scanner-diag').textContent")
            long_press(phone, "#scanner-vision")
            diag_hidden_again = hidden()
            time.sleep(COLLECT_S)
            log = phone.evaluate("(() => { housekiScanVision.onDraw = null; return window.__lagLog; })()")
            results = phone.evaluate("window.__lagResults")
            latency = phone.evaluate("housekiScanVision.latency()")
            timings = phone.evaluate("housekiScanVision.timings()")
            state = json.loads(phone.evaluate("JSON.stringify(housekiScanVision.state, (k, v) => ['last', 'drawn', 'lastTracked'].includes(k) ? undefined : v)"))
            self.studio.send("Page.bringToFront")
            time.sleep(1)
            readout = self.studio.evaluate("document.getElementById('scan-vision-readout')?.textContent ?? ''")
        finally:
            phone.close()

        result = analyse(log, self.truth)
        result["latency"] = latency
        result["timings"] = {k: v for k, v in timings.items()}
        result["state"] = {k: state.get(k) for k in ("thread", "scale", "outlineEvery", "processed", "frames", "frameTimeFrom",
                                                      "tracking", "tracks", "trackedPoses", "trackFailures")}
        result["tracking"] = TRACKING
        result["cpuThrottle"] = CPU_THROTTLE
        result["readout"] = readout

        # Named by configuration, so runs with tracking off or a slowed CPU do not overwrite the
        # shipped configuration's (last_run.json / last_run_log.json).
        suffix = "" if TRACKING and CPU_THROTTLE == 1 else "_track%d_cpu%g" % (TRACKING, CPU_THROTTLE)

        with open(os.path.join(OUTPUT_LAG, "last_run%s.json" % suffix), "w") as handle:
            json.dump(result, handle, indent=1)

        # The raw stream, for replaying the overlay's filter offline (tests/harness/vision/replay_lag.js).
        with open(os.path.join(OUTPUT_LAG, "last_run%s_log.json" % suffix), "w") as handle:
            json.dump({"draws": log, "results": results}, handle)

        say = lambda *a: print("[scan_lag]", *a, file=sys.stderr)  # noqa: E731
        say("%d drawn frames logged, %d with a stamp; frame times from %s; state %s" % (
            result["logged"], result["stamped"], result["state"]["frameTimeFrom"], json.dumps(result["state"])))

        for name, stats in result["segments"].items():
            say("%-6s %4d frames, drawn %s; centre misplacement median %s p90 %s max %s px; grid median %s p90 %s px; age median %s p90 %s ms%s" % (
                name, stats["frames"], stats["drawnShare"], stats["errorPx"]["median"], stats["errorPx"]["p90"], stats["errorPx"]["max"],
                stats["gridErrorPx"]["median"], stats["gridErrorPx"]["p90"], stats["ageMs"]["median"], stats["ageMs"]["p90"],
                "; shimmer centre %s grid %s px, settled misplacement %s px" % (stats["shimmerPx"], stats["gridShimmerPx"], stats["settledErrorPx"])
                if "shimmerPx" in stats else ""))

        say("moving: centre misplacement median %s p90 %s px, grid median %s p90 %s px, age median %s p90 %s ms; still shimmer centre %s grid %s px" % (
            result["moving"]["errorPxMedian"], result["moving"]["errorPxP90"], result["moving"]["gridErrorPxMedian"],
            result["moving"]["gridErrorPxP90"], result["moving"]["ageMsMedian"], result["moving"]["ageMsP90"],
            result["stillShimmerPx"], result["stillGridShimmerPx"]))
        say("latency %s" % json.dumps(latency))
        say("timings %s" % json.dumps(result["timings"]))
        say("studio readout %r" % readout[:400])
        say("phone speed line %r" % diag_text)
        self.assertTrue(diag_hidden_at_first and diag_hidden_again, "the speed line is hidden until long-pressed, and again after")
        self.assertIn("position", diag_text)

        self.assertGreater(result["stamped"], 0.9 * result["logged"], "the stamps were not read")
        self.assertGreater(result["logged"], 20 * COLLECT_S, "too few frames drawn")
        self.assertIn("Speed", readout)

        if CPU_THROTTLE > 1 or not TRACKING:
            return  # a measurement for comparison, not the shipped configuration
        # The targets (T-0332), with margin over what was measured on the M1 Pro (see the module's
        # docstring and kb): the overlay stays on the board while the phone moves, and is steady
        # when it is still.
        self.assertLess(result["moving"]["gridErrorPxMedian"], MAX_MOVING_GRID_PX, "the grid trails the moving picture")
        self.assertLess(result["moving"]["gridErrorPxP90"], MAX_MOVING_GRID_P90_PX, "the grid trails the moving picture (p90)")
        self.assertLess(result["stillGridShimmerPx"], MAX_STILL_SHIMMER_PX, "the overlay shimmers when still")
        self.assertTrue(all(s["drawnShare"] > 0.95 for s in result["segments"].values()), "the overlay is missing on some frames")


if __name__ == "__main__":
    unittest.main()
