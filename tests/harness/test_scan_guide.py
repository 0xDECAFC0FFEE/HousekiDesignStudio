"""The phone's scan guidance, end to end on a moving synthetic video (T-0331).

The user, 2026-10-06: "i want the phone screen to show the charuco boards checkerboard lines overlay
along with xyz arrows off of the center of the board. as we're scanning, i want to track the angle of
the camera relative to the rock. I also want to add a few warnings - ex if the board is moving too
fast relative to the camera or the rock isn't in focus it should show a warning in the middle of the
screen."

These tests run the BUILT pages as test_scan_vision.py does (studio and phone page in two headless
Chromes, a local Nostr relay; the phone's vision starts once it has connected), with the phone's fake
camera playing the scan guidance's video (make_scan_video.GUIDE_CONFIG, on the strip sheet): a held
view, a slow orbit through half a circle, a fast motion-blurred swing, a calm hold, a hold with the
rock out of focus, and one in focus. Every distinct frame's camera is known. The phone page's own
debug hook (window.housekiScanVision) is polled in the page every 40 ms and each processed frame's
guide, warning and drawn overlay geometry is logged. Each logged frame is matched to the video's
frame with the nearest camera (its segment says what should be seen). They check:

  * the overlay draws the chessboard grid (at least 20 inner lines and the board's edge) and the
    axes at the board's CENTRE (85, 115) -- the drawn origin, mapped back to frame pixels, is the
    projection of (85, 115, 0) within AXES_PX on held views;
  * the rock's position is found from the outlined views within ROCK_MM of the true rock's middle;
  * the tracked angle (azimuth, elevation from the rock) matches the video's true camera within
    ANGLE_DEG on held and slowly moving views;
  * coverage fills as the camera orbits (the 20-40 degree ring gains sectors through the orbit);
  * "Moving too fast" shows during the fast swing (or the 0.6 s after it) and never in the slow orbit;
  * "Rock not in focus" shows on the defocused hold and not on the in-focus one (after its first
    WARNING_OFF_S, the time a warning takes to go);
  * the studio receives the guide and reads it out ("Filmed", "Next") with the coverage map.

    ./build.sh   # or: python3 src/scripts/make_page.py --skip-build
    ~/.pyenv/versions/anaconda3-2019.07/bin/python3 -m unittest tests/harness/test_scan_guide.py -v

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
PROJECT_ROOT = os.path.dirname(HERE)
PROJECT_ROOT = os.path.dirname(PROJECT_ROOT)
STUDIO_PAGE = os.path.join(PROJECT_ROOT, "build", "www", "studio.html")
SCANNER_PAGE = os.path.join(PROJECT_ROOT, "build", "www", "scanner", "index.html")

sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "vision"))

try:
    import cdp
    from test_scan_link import CHROME_ARGS, CONNECT_TIMEOUT, Relay, Server
    # The module, not the class: a TestCase imported by name would run its tests here too.
    import test_scan_vision
    from test_scan_vision import RELAYS_SETTING, angle_difference, dist, js
    from test_vision_detect import native_chrome
    from make_scan_video import ensure_guide_video
except ImportError as error:  # websocket-client, numpy or PIL missing
    cdp = None
    IMPORT_ERROR = str(error)

# The board the video shows: the strip sheet, the one board the phone supports (T-0335).
SHEET = "charuco_23x17_10mm_strip"

# How long the phone's frames are logged: two loops of the 27.5 s video, so the second loop runs
# with the rock found and the lens estimated.
COLLECT_S = 58

# Tolerances, each with its reason.
AXES_PX = 3.0       # the drawn axes use the FILTERED pose carried to the frame shown; on held views the frame's pose
ROCK_MM = 3.0       # the outline's centroid is the silhouette's, not the ellipsoid's centre
ANGLE_DEG = 2.0     # the pose is within 0.1 degree; the rest is the rock point's error at 170-180 mm
WARNING_OFF_S = 0.6  # a warning goes 0.5 s after its condition clears, plus a frame


def project(point, R, t, f, cx, cy, k1):
    """The phone's camera model (camera_model.projectPoints) for one board point."""
    X = [sum(R[3 * i + j] * point[j] for j in range(3)) + t[i] for i in range(3)]
    u, v = X[0] / X[2], X[1] / X[2]
    d = 1 + k1 * (u * u + v * v)
    return f * u * d + cx, f * v * d + cy


@unittest.skipIf(cdp is None, "needs websocket-client, numpy and PIL: %s" % (IMPORT_ERROR if cdp is None else ""))
@unittest.skipUnless(os.path.isfile(STUDIO_PAGE), "the studio is not built (%s); run ./build.sh" % STUDIO_PAGE)
@unittest.skipUnless(os.path.isfile(SCANNER_PAGE), "the phone page is not built (%s); run ./build.sh" % SCANNER_PAGE)
@unittest.skipUnless(shutil.which("deno"), "needs Deno, to run the local Nostr relay")
class ScanGuideTest(unittest.TestCase):
    # The studio's helpers, as test_scan_vision.py drives it.
    if cdp is not None:
        finish_animations = test_scan_vision.ScanVisionTest.finish_animations
        click = test_scan_vision.ScanVisionTest.click
        press_escape = test_scan_vision.ScanVisionTest.press_escape
        open_mode = test_scan_vision.ScanVisionTest.open_mode

    @classmethod
    def setUpClass(cls):
        cls.video = ensure_guide_video()
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

    def nearest_frame(self, center):
        """The video's distinct frame whose camera is nearest, and how far (mm)."""
        return min(((f, dist(center, f["center"])) for f in self.truth["frames"]), key=lambda pair: pair[1])

    def test_guidance_on_a_moving_video(self):
        """Grid, axes at the centre, the rock's position, the angle, coverage and the two warnings.

        Setup: the studio with Rough scan open; a phone browser whose camera plays the guidance video
        on the strip sheet, connected. Test: log every frame the phone processes for COLLECT_S seconds (in the page,
        every 40 ms), then match each to the video. Verifies: see the module's docstring.
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
            phone.evaluate("""(() => {
              const log = window.__guideLog = [];
              let processed = -1;
              window.__guideTimer = setInterval(() => {
                const v = window.housekiScanVision; const s = v.state;
                if (s.processed === processed || !s.last) return;
                processed = s.processed;
                const r = s.last; const g = r.guide; const d = s.drawn;
                let axes = null;
                if (d?.axes) {
                  const { scale, dx, dy } = d.transform;
                  axes = [(d.axes.origin[0] - dx) / scale, (d.axes.origin[1] - dy) / scale];
                }
                log.push({ at: performance.now(), valid: !!r.pose?.valid, R: r.pose?.R, t: r.pose?.t, center: r.pose?.center,
                  lens: r.pose?.intrinsics ? { f: r.pose.intrinsics.f, cx: r.pose.intrinsics.cx,
                  cy: r.pose.intrinsics.cy, k1: r.pose.intrinsics.k1, source: r.pose.intrinsics.source } : null,
                  sheet: r.sheet.name, wrongBoard: !!r.board?.wrong, view: g?.view, rockMm: g?.rockMm, rockFrom: g?.rockFrom, rockViews: g?.rockViews,
                  cover: g?.cover, conditions: g?.conditions, speed: g?.speedMmS, blurMm: g?.blurMm, blurWindowPx: g?.blurWindowPx,
                  usable: g?.usable, reasons: g?.reasons, warning: s.warning, advice: s.shown?.advice ?? null,
                  gridLines: d?.gridLines ?? 0, edgeLines: d?.edgeLines ?? 0, axes,
                  foundCorners: d?.foundCorners ?? 0, foundLines: d?.foundLines ?? 0,
                  warningShown: !document.getElementById('scanner-warning').hidden,
                  warningText: document.getElementById('scanner-warning-title').textContent });
              }, 40);
            })(), true""")
            time.sleep(COLLECT_S)
            log = phone.evaluate("(() => { clearInterval(window.__guideTimer); return window.__guideLog; })()")
            timings = phone.evaluate("housekiScanVision.timings()")
            angle_text = phone.evaluate("document.getElementById('scanner-angle').textContent")
            self.studio.send("Page.bringToFront")
            self.studio.wait_for_expression("!!window.gemScanVision()?.message?.guide", timeout=20)
            studio_guide = self.studio.evaluate("window.gemScanVision().message.guide")
            readout = self.studio.evaluate("document.getElementById('scan-vision-readout')?.textContent ?? ''")
            studio_map = self.studio.evaluate("document.querySelectorAll('#scan-vision-map path').length")
        finally:
            phone.close()

        self.check(log, timings, angle_text, studio_guide, readout, studio_map)

    def check(self, log, timings, angle_text, studio_guide, readout, studio_map):
        say = lambda *a: print("[scan_guide]", *a, file=sys.stderr)  # noqa: E731
        say("%d frames logged; guideMs %s; frameMs %s; detectMs %s" % (
            len(log), timings.get("guideMs"), timings.get("frameMs"), timings.get("detectMs")))
        self.assertGreater(len(log), 150, "too few frames processed")
        self.assertTrue(all(entry["sheet"] == SHEET for entry in log), "the strip board is used")
        self.assertFalse(any(entry["wrongBoard"] for entry in log), "the strip board taken for another (T-0335)")

        # Each frame's segment: by the nearest camera for posed frames; a frame without a pose takes
        # the segment of the last posed one.
        segment = None

        for entry in log:
            if entry["valid"]:
                frame, gap = self.nearest_frame(entry["center"])
                entry["truth"] = frame
                entry["gap"] = gap
                segment = frame["segment"]

            entry["segment"] = segment

        # How long each frame's segment has been running (the video loops: each pass is a new run).
        run_start = None

        for i, entry in enumerate(log):
            if i == 0 or entry["segment"] != log[i - 1]["segment"]:
                run_start = entry["at"]

            entry["intoS"] = (entry["at"] - run_start) / 1000

        by = lambda name: [e for e in log if e["segment"] == name]  # noqa: E731
        counts = {s["name"]: len(by(s["name"])) for s in self.truth["segments"]}
        say("frames per segment", counts)

        # 1. The grid and the axes at the board's centre.
        held = [e for e in log if e["valid"] and e["segment"] in ("settle", "calm", "focus") and e["axes"] and e["lens"]]
        self.assertTrue(held, "no held, posed frame with axes")
        errors = []

        for e in held:
            u, v = project([85, 115, 0], e["R"], e["t"], e["lens"]["f"], e["lens"]["cx"], e["lens"]["cy"], e["lens"]["k1"])
            errors.append(math.hypot(e["axes"][0] - u, e["axes"][1] - v))

        errors.sort()
        say("axes origin vs projection of (85, 115): median %.2f px, worst %.2f px over %d held frames" % (
            errors[len(errors) // 2], errors[-1], len(errors)))
        self.assertLess(errors[len(errors) // 2], AXES_PX, "the axes are not at the board's centre")
        # Since T-0333 the phone draws red points on the corners its pose was solved from and blue
        # lines between neighbours, instead of the faint full-board grid.
        self.assertEqual(max(e["gridLines"] for e in log), 0, "the faint grid is still drawn on the phone")
        points = max(e["foundCorners"] for e in log)
        lines = max(e["foundLines"] for e in log)
        say("found corners drawn: up to %d points and %d lines" % (points, lines))
        self.assertGreaterEqual(points, 20, "the found corners are not drawn")
        self.assertGreaterEqual(lines, 20, "the lines between found corners are not drawn")
        self.assertTrue(any(e["edgeLines"] >= 2 for e in log), "the board's edge is not drawn")

        # 2. The rock's position, once found.
        found = [e for e in log if e["rockFrom"] == "views"]
        self.assertTrue(found, "the rock was never found from views")
        last = found[-1]
        rock = self.truth["rockMm"]
        rock_error = math.hypot(last["rockMm"][0] - rock[0], last["rockMm"][1] - rock[1])
        say("rock %s from %d views (truth %s): %.2f mm on the board; first found %.1f s into the log" % (
            last["rockMm"], last["rockViews"], rock, rock_error, (found[0]["at"] - log[0]["at"]) / 1000))
        self.assertLess(rock_error, ROCK_MM, "the rock's position")
        self.assertTrue(0 <= last["rockMm"][2] <= 10, "the rock's height %s" % last["rockMm"][2])

        # 3. The tracked angle, on held and slow frames once the rock is found.
        angles = [e for e in found if e["valid"] and e["view"] and e["segment"] in ("settle", "slow", "calm", "focus", "defocus")]
        az = [angle_difference(e["view"]["azimuthDeg"], e["truth"]["fromRock"]["azimuthDeg"]) for e in angles]
        el = [abs(e["view"]["elevationDeg"] - e["truth"]["fromRock"]["elevationDeg"]) for e in angles]
        gaps = sorted(e["gap"] for e in angles)
        say("angle vs truth on %d frames: azimuth median %.2f, worst %.2f; elevation median %.2f, worst %.2f deg; "
            "camera to nearest video frame median %.1f mm; shown %r" % (
                len(angles), sorted(az)[len(az) // 2], max(az), sorted(el)[len(el) // 2], max(el), gaps[len(gaps) // 2], angle_text))
        self.assertGreater(len(angles), 30)
        self.assertLess(max(az), ANGLE_DEG)
        self.assertLess(max(el), ANGLE_DEG)

        # 4. Coverage fills through the slow orbit (the 20-40 degree ring).
        slow = [e for e in by("slow") if e["cover"]]
        rings = [bin(e["cover"][1]).count("1") for e in slow]
        say("20-40 degree ring through the slow orbit: %s ... %s sectors; final cover %s; usable %d of %d slow frames (reasons %s)" % (
            rings[:3], rings[-3:], log[-1]["cover"], sum(e["usable"] for e in slow), len(slow),
            sorted({r for e in slow for r in (e["reasons"] or [])})))
        self.assertGreaterEqual(max(rings), 5, "the orbit's sectors did not fill")
        self.assertGreater(max(rings), min(rings), "coverage did not grow during the orbit")

        # 5. Too fast: during the swing (or just after), never during the slow orbit.
        fast_seen = [e for e in log if e["warning"] == "fast"]
        say("'fast' shown on %d frames, segments %s; speeds in the swing %s; max slow speed %.1f mm/s" % (
            len(fast_seen), sorted({e["segment"] for e in fast_seen}),
            [round(e["speed"] or 0) for e in by("fast")], max((e["speed"] or 0) for e in slow)))
        self.assertTrue(any(e["segment"] in ("fast", "calm") for e in fast_seen), "no 'too fast' warning on the swing")
        self.assertFalse(any(e["segment"] == "slow" for e in fast_seen), "'too fast' on the slow orbit")
        self.assertTrue(all(e["warningShown"] for e in fast_seen), "the warning is in the middle of the screen")

        # 6. Not in focus: on the defocused hold, not on the in-focus one (after the warning's off time).
        defocus = by("defocus")
        in_focus = [e for e in by("focus") if e["intoS"] > WARNING_OFF_S]
        say("blur at the rock: defocused %s mm, in focus %s mm; 'focus' shown on %d defocused and %d in-focus frames" % (
            [round(e["blurMm"], 3) for e in defocus if e["blurMm"]][:8], [round(e["blurMm"], 3) for e in in_focus if e["blurMm"]][:8],
            sum(e["warning"] == "focus" for e in defocus), sum(e["warning"] == "focus" for e in in_focus)))
        self.assertTrue(any(e["warning"] == "focus" for e in defocus), "no focus warning on the defocused rock")
        self.assertFalse(any(e["warning"] == "focus" for e in in_focus), "a focus warning on the sharp rock")

        # 7. The studio got the guide and reads it out.
        say("studio guide %s; readout %r; map cells %d" % (json.dumps(studio_guide), readout[:300], studio_map))
        self.assertIn("Filmed", readout)
        self.assertIn("Next", readout)
        self.assertEqual(studio_map, 48)


if __name__ == "__main__":
    unittest.main()
