"""The phone's vision, end to end: phone page -> Trystero data channel -> studio (T-0326).

The user, 2026-10-04: the phone should "recognize the charuco board, identify the camera position
relative to the board and identify the outline of the rock", draw them over its camera view, and
send the pose and outline to the studio over the existing connection. These tests run the BUILT
pages -- the studio (build/www/studio.html) and the phone page (build/www/scanner/) -- in two
separate headless Chromes, the phone's camera playing a synthetic video of a rock on the printed
board whose every camera pose and rock silhouette is known (tests/harness/vision/make_scan_video.py:
three views, each held 4 s, looped). They check:

  * the phone recognises the board and draws its overlay (pixels on the overlay canvas), and says
    so in its vision line;
  * the studio receives vision messages at about 10 a second, draws them over the phone's video,
    and reads them out in the panel, with the sheet recognised (the video's sheet is NOT the one
    the phone assumes before it has seen any);
  * the received pose matches the video's true pose (rotation, camera position, the azimuth,
    elevation and distance read out), within stated tolerances, once the phone's first lens
    estimate is in;
  * the received rock outline's IoU against the true silhouette;
  * a phone that sends no vision (here: its OpenCV blocked, which leaves it exactly as a phone page
    from before vision) leaves the studio as it was -- the picture streams, no overlay, no readout;
  * a peer sending malformed vision messages is ignored, and a valid one after them is taken.

HOW THEY RUN. As test_scan_link.py / test_scan_mode.py: build/www over HTTP on localhost, a local
Nostr relay, the studio pointed at it through `gems.scanRelayUrls`. The phone is a SEPARATE browser
(a background tab neither plays video nor runs its frame callbacks) started natively on Apple
silicon (test_vision_detect.native_chrome: under Rosetta wasm runs ~100x slower) with the fake
camera playing the video file. Both use the real GPU (the outline is WebGL2).

    ./build.sh   # or: python3 src/scripts/make_page.py --skip-build
    ~/.pyenv/versions/anaconda3-2019.07/bin/python3 -m unittest tests/harness/test_scan_vision.py -v

Headless Chrome does not start inside the agent command sandbox. Skipped, with the reason, when the
pages are not built or Chrome, Deno, numpy/PIL or websocket-client is missing.
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
    from test_vision_detect import native_chrome
    from make_scan_video import ensure_video
    import numpy as np
    from PIL import Image, ImageDraw
except ImportError as error:  # websocket-client, numpy or PIL missing
    cdp = None
    IMPORT_ERROR = str(error)

RELAYS_SETTING = "gems.scanRelayUrls"

# How long the received messages are collected: a little over two loops of the video (12 s each),
# so every view is seen after the phone's first lens estimate (about 3 s of board in view).
COLLECT_S = 28

# Tolerances on the received pose against the truth, with the lens estimated live (no refinement:
# three static views are too few distinct views for one), measured 2026-10-04 well inside them
# (see the test's printout and kb/phone-vision-on-live-frames-*).
MAX_ROTATION_DEG = 1.0
MAX_CENTRE_MM = 6.0
MAX_ANGLE_DEG = 1.0
MAX_DISTANCE_SHARE = 0.03
MIN_MEDIAN_IOU = 0.85


def js(value):
    return json.dumps(value)


class NoOpenCvServer:
    """build/www over HTTP like test_scan_link.Server, except that opencv.js is not found."""

    def __init__(self):
        import functools
        import http.server
        import threading

        class Handler(http.server.SimpleHTTPRequestHandler):
            def do_GET(self):
                if self.path.split("?")[0].endswith("/opencv.js"):
                    self.send_error(404)
                else:
                    super().do_GET()

            def log_message(self, *args):
                pass

        site = os.path.join(PROJECT_ROOT, "build", "www")
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=site))
        self.origin = "http://localhost:%d" % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def rotation_angle_deg(a, b):
    """The angle between two row-major rotations (pose.js rotationAngleDeg's formula)."""
    frob = math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))
    return math.degrees(2 * math.asin(min(1.0, frob / (2 * math.sqrt(2)))))


def dist(a, b):
    """Euclidean distance (math.dist is Python 3.8+; the harness Python is 3.7)."""
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def angle_difference(a, b):
    return abs((a - b + 180) % 360 - 180)


@unittest.skipIf(cdp is None, "needs websocket-client, numpy and PIL: %s" % (IMPORT_ERROR if cdp is None else ""))
@unittest.skipUnless(os.path.isfile(STUDIO_PAGE), "the studio is not built (%s); run ./build.sh" % STUDIO_PAGE)
@unittest.skipUnless(os.path.isfile(SCANNER_PAGE), "the phone page is not built (%s); run ./build.sh" % SCANNER_PAGE)
@unittest.skipUnless(shutil.which("deno"), "needs Deno, to run the local Nostr relay")
class ScanVisionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.video = ensure_video()
        cls.truth = cls.video["truth"]
        cls.server = Server()
        cls.relay = Relay()

        try:
            cls.studio = cdp.Chrome(gl_backend="metal", extra_args=CHROME_ARGS, timeout=60)
        except Exception as error:  # no Chrome, or inside the sandbox
            cls.relay.close()
            cls.server.close()
            raise unittest.SkipTest("could not start Chrome: %s" % error)

        cls.studio.send("Emulation.setDeviceMetricsOverride", {
            "width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False,
        })
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

    def setUp(self):
        self.phone = None

    def tearDown(self):
        if self.studio.evaluate("!!document.getElementById('scan-view')"):
            self.press_escape()

        if self.phone:
            self.phone.close()

    # --- the two browsers -------------------------------------------------------------------

    def start_phone(self, camera_file=True):
        """A separate, native Chrome for the phone, its fake camera playing the video file (or
        Chrome's own test pattern)."""
        args = list(CHROME_ARGS)

        if camera_file:
            args.append("--use-file-for-fake-video-capture=%s" % self.video["mjpeg"])

        self.phone = native_chrome(gl_backend="metal", extra_args=tuple(args), timeout=60)
        return self.phone

    def finish_animations(self):
        self.studio.evaluate("document.getAnimations().filter(a => a.effect?.getComputedTiming().endTime !== Infinity).forEach(a => a.finish()), true")

    def click(self, selector):
        """A real mouse click at the middle of a studio element."""
        self.finish_animations()
        box = self.studio.evaluate(
            "(() => { const r = document.querySelector(%s).getBoundingClientRect();"
            " return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()" % js(selector))
        self.studio.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": box["x"], "y": box["y"], "button": "none"})

        for kind in ("mousePressed", "mouseReleased"):
            self.studio.send("Input.dispatchMouseEvent", {"type": kind, "x": box["x"], "y": box["y"], "button": "left", "clickCount": 1})

    def press_escape(self):
        for kind in ("keyDown", "keyUp"):
            self.studio.send("Input.dispatchKeyEvent", {"type": kind, "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})

        self.studio.wait_for_expression("!document.getElementById('scan-view')", timeout=10)

    def open_mode(self):
        """Tools > Rough scan in the studio, by mouse; returns the session's link."""
        self.click("#menu-button-tools")
        self.studio.wait_for_expression("!!document.getElementById('menu-item-rough-scan')", timeout=10)
        self.click("#menu-item-rough-scan")
        self.studio.wait_for_expression("!!document.getElementById('scan-url')", timeout=20)
        return self.studio.evaluate("document.getElementById('scan-url').textContent.trim()")

    def start_log(self):
        """Records every vision value the studio takes (gemScanVision, polled every 20 ms: the studio
        takes at most one per 40 ms), with the overlay's state, in window.__visionLog."""
        self.studio.evaluate("""(() => {
          const log = window.__visionLog = [];
          let last = null;
          clearInterval(window.__visionTimer);
          window.__visionTimer = setInterval(() => {
            const value = window.gemScanVision();
            if (value && value !== last) {
              last = value;
              log.push({ receivedAt: value.receivedAt, message: value.message, bytes: JSON.stringify(value.message).length });
            }
          }, 20);
        })(), true""")

    def stop_log(self):
        return self.studio.evaluate("(() => { clearInterval(window.__visionTimer); return window.__visionLog; })()")

    def connect(self, phone_url=None):
        """Opens the mode, the link on the phone, waits until the studio shows its video."""
        link = self.open_mode()
        self.phone.navigate(phone_url or link)
        self.phone.wait_for_expression(
            "document.getElementById('scanner-status')?.dataset.status === 'connected'", timeout=CONNECT_TIMEOUT)
        self.studio.wait_for_expression("document.getElementById('scan-view').dataset.streaming === 'true'", timeout=CONNECT_TIMEOUT)
        self.studio.wait_for_expression("document.getElementById('scan-video').videoWidth > 0", timeout=20)
        return link

    def received_fps(self, seconds=3.0):
        """Frames the studio's <video> of the phone presented per second, over `seconds`."""
        return self.studio.send("Runtime.evaluate", {"expression": """new Promise(done => {
          const video = document.getElementById('scan-video');
          let n = 0; const start = performance.now();
          const tick = () => { n += 1; if (performance.now() - start < %d) video.requestVideoFrameCallback(tick); else done(n / ((performance.now() - start) / 1000)); };
          video.requestVideoFrameCallback(tick);
        })""" % int(seconds * 1000), "awaitPromise": True, "returnByValue": True}, timeout=60)["result"]["value"]

    # --- judging what arrived ----------------------------------------------------------------

    def nearest_view(self, pose):
        """The truth view whose camera is nearest the pose's, and how far."""
        best = None

        for index, view in enumerate(self.truth["views"]):
            distance = dist(pose["center"], view["center"])

            if best is None or distance < best[1]:
                best = (index, distance)

        return best

    def iou(self, contour, view_index, frame):
        """IoU of a received outline (frame pixels, types.js corner origin) with a view's truth mask.
        A frame smaller than the video's is taken as its middle (Chrome's fake camera crops to fit
        the page's request), and the mask is cut the same way."""
        mask = np.array(Image.open(self.video["masks"][view_index]).convert("L")) >= 128
        top = (self.truth["height"] - frame["h"]) // 2
        left = (self.truth["width"] - frame["w"]) // 2
        mask = mask[top:top + frame["h"], left:left + frame["w"]]
        found = Image.new("L", (frame["w"], frame["h"]), 0)
        # PIL fills pixels whose centres are inside; its coordinates put pixel centres on integers.
        ImageDraw.Draw(found).polygon([(x - 0.5, y - 0.5) for x, y in contour], fill=255)
        found = np.array(found) >= 128
        union = np.logical_or(found, mask).sum()
        return float(np.logical_and(found, mask).sum()) / union if union else 1.0

    # --- tests --------------------------------------------------------------------------------

    def test_phone_overlay_and_studio_receive_the_true_pose_and_outline(self):
        """The phone finds the board, draws it, and the studio receives the true pose and outline.

        Setup: the studio with Rough scan open; a phone browser whose camera plays the synthetic
        video (three views of a rock on the ringed large-target sheet, 4 s each, looped; true focal
        length 1000 px against the phone's first guess of 1088). Test: open the link on the phone;
        wait for its vision; then record every vision value the studio takes for COLLECT_S
        seconds. Verifies:
          - the phone's vision line says the board is found ('pose') and its overlay canvas has
            drawn pixels;
          - the studio takes 5-11 messages a second, each under 2 kB, draws them over the video
            ('pose+outline'), and its panel reads out the board (with the recognised sheet), the
            camera, the lens and the rock;
          - the sheet is recognised as the ringed large target ('auto'), not the default;
          - every valid pose received after the lens's first estimate matches the true pose of
            the view it shows: rotation within MAX_ROTATION_DEG, camera centre within
            MAX_CENTRE_MM, azimuth and elevation within MAX_ANGLE_DEG, distance within
            MAX_DISTANCE_SHARE; every view is seen;
          - the rock outlines found on the same frame as their pose have a median IoU of at least
            MIN_MEDIAN_IOU against the true silhouette.
        """
        phone = self.start_phone()
        self.connect()
        self.start_log()
        phone.wait_for_expression("document.getElementById('scanner-vision')?.dataset.state === 'pose'", timeout=90)
        # The overlay is drawn from the next camera frame on (since T-0331 nothing is drawn before a
        # pose), so wait for its found corners' points (T-0333; they replaced the phone's faint grid)
        # before reading pixels.
        phone.wait_for_expression("(window.housekiScanVision?.state?.drawn?.foundCorners ?? 0) > 0", timeout=10)
        drawn = phone.evaluate("""(() => {
          const c = document.getElementById('scanner-overlay');
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0; for (let i = 3; i < d.length; i += 4) n += d[i] > 0 ? 1 : 0;
          return n;
        })()""")
        phone_line = phone.evaluate("document.getElementById('scanner-vision').textContent")
        self.studio.send("Page.bringToFront")
        time.sleep(COLLECT_S)
        log = self.stop_log()
        overlay = self.studio.evaluate("document.getElementById('scan-overlay').dataset.drawn")
        readout = self.studio.evaluate("document.getElementById('scan-vision-readout')?.textContent ?? ''")
        fps = self.received_fps()
        phone_state = phone.evaluate("JSON.stringify({ state: housekiScanVision.state, timings: housekiScanVision.timings() }, (k, v) => k === 'last' ? undefined : v)")

        print("\n[scan_vision] phone: %r, %d overlay pixels" % (phone_line, drawn), file=sys.stderr)
        print("[scan_vision] phone state %s" % phone_state[:1500], file=sys.stderr)
        self.assertGreater(drawn, 1000, "the phone's overlay drew nothing")

        span = (log[-1]["receivedAt"] - log[0]["receivedAt"]) / 1000 if len(log) > 1 else 0
        rate = (len(log) - 1) / span if span else 0
        sizes = sorted(entry["bytes"] for entry in log)
        print("[scan_vision] studio: %d messages over %.1f s (%.1f/s), %d-%d bytes (median %d); overlay %r; video %.1f fps; readout %r"
              % (len(log), span, rate, sizes[0], sizes[-1], sizes[len(sizes) // 2], overlay, fps, readout), file=sys.stderr)
        self.assertTrue(5 <= rate <= 11, "message rate %.1f/s" % rate)
        self.assertLess(sizes[-1], 2048, "a message over 2 kB")
        self.assertIn(overlay, ("pose+outline", "pose"))
        self.assertIn("Found (Large target with rings)", readout)
        self.assertIn("above the board", readout)

        last = log[-1]["message"]["board"]
        self.assertEqual((last["sheet"], last["sheetFrom"]), (self.truth["sheet"], "auto"), "the sheet was not recognised")

        # The poses, once the lens has its first estimate.
        errors = []
        seen = set()
        ious = []

        for entry in log:
            message = entry["message"]
            pose = message["pose"]

            if not pose or not pose["valid"] or message["intrinsics"]["source"] == "guess":
                continue

            view, _ = self.nearest_view(pose)
            truth = self.truth["views"][view]
            seen.add(view)
            # Azimuth, elevation and distance are measured from the target of the sheet the phone
            # assumed for that message (board.targetMm): the default strip sheet's (80, 110 mm)
            # until the picker recognises the video's ringed sheet (85, 115 mm). So the truth is
            # measured from the same point (T-0330 made the strip the default; the dotted sheet
            # it replaced shares the ringed sheet's target, so the truth's own angles fitted then).
            target = message["board"]["targetMm"] + [0.0]
            u = [c - t for c, t in zip(truth["center"], target)]
            true_azimuth = math.degrees(math.atan2(u[1], u[0])) % 360
            true_elevation = math.degrees(math.atan2(u[2], math.hypot(u[0], u[1])))
            true_distance = math.sqrt(sum(v * v for v in u))
            errors.append({
                "view": view,
                "rotationDeg": rotation_angle_deg(pose["R"], truth["R"]),
                "centreMm": dist(pose["center"], truth["center"]),
                "azimuthDeg": angle_difference(pose["azimuthDeg"], true_azimuth),
                "elevationDeg": abs(pose["elevationDeg"] - true_elevation),
                "distanceShare": abs(pose["distanceMm"] / true_distance - 1),
                "f": message["intrinsics"]["f"],
            })

            outline = message["outline"]

            if outline and outline["timeMs"] == message["timeMs"]:
                ious.append(self.iou(outline["contour"], view, message["frame"]))

        self.assertTrue(errors, "no valid pose after the lens estimate")
        worst = {key: max(e[key] for e in errors) for key in ("rotationDeg", "centreMm", "azimuthDeg", "elevationDeg", "distanceShare")}
        median = lambda values: sorted(values)[len(values) // 2]  # noqa: E731
        print("[scan_vision] %d posed messages, views %s; worst %s; median rotation %.3f deg, centre %.2f mm; f %s (truth %d)"
              % (len(errors), sorted(seen), json.dumps({k: round(v, 4) for k, v in worst.items()}),
                 median([e["rotationDeg"] for e in errors]), median([e["centreMm"] for e in errors]),
                 sorted({round(e["f"]) for e in errors}), self.truth["f"]), file=sys.stderr)
        self.assertEqual(seen, {0, 1, 2}, "not every view was seen")
        self.assertLess(worst["rotationDeg"], MAX_ROTATION_DEG)
        self.assertLess(worst["centreMm"], MAX_CENTRE_MM)
        self.assertLess(worst["azimuthDeg"], MAX_ANGLE_DEG)
        self.assertLess(worst["elevationDeg"], MAX_ANGLE_DEG)
        self.assertLess(worst["distanceShare"], MAX_DISTANCE_SHARE)

        self.assertTrue(ious, "no outline on a posed frame")
        sample = next(e["message"]["outline"] for e in log if e["message"]["outline"])
        print("[scan_vision] outline IoU on %d frames: min %.3f, median %.3f, max %.3f (a received outline's box %s, flags %s)"
              % (len(ious), min(ious), median(ious), max(ious), sample["box"], sample["flags"]), file=sys.stderr)
        self.assertGreaterEqual(median(ious), MIN_MEDIAN_IOU)

    def test_a_phone_without_vision_leaves_the_studio_as_it_was(self):
        """A phone that sends no vision: the studio streams it exactly as before.

        Setup: the phone page served by a second server that answers 404 for opencv.js (blocking
        it through CDP does not reach the page's Worker, which fetches it itself), so neither the
        Worker nor the page can start the vision and the phone sends no vision message, as a phone
        page from before vision. Test: connect it (the session link with this server's origin),
        watch the studio for 6 s. Verifies: the phone's vision line says the board finder could not
        load while the camera still streams; the studio plays the video, draws no overlay, holds no
        vision value and shows no "What the phone sees" readout.
        """
        phone = self.start_phone()
        no_opencv = NoOpenCvServer()

        try:
            link = self.open_mode()
            phone.navigate(no_opencv.origin + "/scanner/#" + link.split("#", 1)[1])
            phone.wait_for_expression(
                "document.getElementById('scanner-status')?.dataset.status === 'connected'", timeout=CONNECT_TIMEOUT)
            self.studio.wait_for_expression("document.getElementById('scan-view').dataset.streaming === 'true'", timeout=CONNECT_TIMEOUT)
        finally:
            no_opencv.close()

        phone.wait_for_expression("document.getElementById('scanner-vision')?.dataset.state === 'error'", timeout=30)
        self.studio.send("Page.bringToFront")
        time.sleep(6)

        self.assertEqual(self.studio.evaluate("window.gemScanVision()"), None)
        self.assertEqual(self.studio.evaluate("document.getElementById('scan-overlay').dataset.drawn ?? 'none'"), "none")
        self.assertFalse(self.studio.evaluate("!!document.getElementById('scan-vision-section')"))
        self.assertGreater(self.received_fps(), 10, "the phone's video does not play")
        self.assertIn("could not load", phone.evaluate("document.getElementById('scanner-vision').textContent"))

    def test_malformed_vision_messages_are_ignored(self):
        """A peer sending malformed vision messages is ignored; a valid one after them is taken.

        Setup: the studio with the mode open; in the phone browser, instead of the phone page, a
        bare Trystero peer with the session's password (from the link) that streams the fake camera
        and answers the studio's request for vision with: a message of another version, one with
        NaN (JSON null) in its rotation, one with 300 outline points, a string, an array, one whose
        frame is 1e9 px wide; then, 1.5 s later, a valid message. Test: watch the studio. Verifies:
        the studio asks (the peer sees the request); after the malformed messages it holds no
        vision value and draws nothing; after the valid one it holds exactly that message.
        """
        phone = self.start_phone(camera_file=False)
        link = self.open_mode()
        phone.navigate(self.server.origin + "/scanner/")
        phone.wait_for_expression("!!window.housekiScanLink", timeout=20)
        phone.evaluate("""(async () => {
          const link = housekiScanLink.decodeScanHash(%s);
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          const log = window.__peer = { asked: 0 };
          const room = housekiScanLink.joinRoom(
            { appId: housekiScanLink.SCAN_APP_ID, password: link.password, relayConfig: { urls: link.relayUrls } }, link.roomId);
          room.onPeerJoin = peerId => room.addStream(stream, { target: peerId });
          const action = room.makeAction('vision');
          const good = { v: 1, timeMs: 4242, frame: { w: 640, h: 480 },
            board: { recognised: true, corners: 50, markers: 20, sheet: 'charuco_23x17_10mm_centre3x3', sheetFrom: 'auto', targetMm: [85, 115], sizeMm: [170, 230] },
            pose: { R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [-85, 115, 250], center: [85, 115, 250], azimuthDeg: 0, elevationDeg: 89, distanceMm: 250, rmsPx: 0.3, valid: true },
            intrinsics: { f: 544, cx: 320, cy: 240, k1: 0, source: 'guess' },
            outline: { timeMs: 4242, contour: [[300, 220], [340, 220], [320, 260]], box: [300, 220, 40, 40], confidence: 0.9, flags: [] } };
          const bad = [
            { ...good, v: 2 },
            { ...good, pose: { ...good.pose, R: [NaN, 0, 0, 0, -1, 0, 0, 0, -1] } },
            { ...good, outline: { ...good.outline, contour: Array.from({ length: 300 }, (_, k) => [k, k]) } },
            'vision',
            [1, 2, 3],
            { ...good, frame: { w: 1e9, h: 480 } },
          ];
          action.onMessage = async (data, context) => {
            if (data && data.want === 'vision') {
              log.asked += 1;
              for (const message of bad) {
                await action.send(message, { target: context.peerId });
                await new Promise(r => setTimeout(r, 100));
              }
              log.badSent = true;
              await new Promise(r => setTimeout(r, 1500));
              await action.send(good, { target: context.peerId });
              log.goodSent = true;
            }
          };
          log.room = room;
        })(), true""" % js(link.split("#", 1)[1]))

        self.studio.send("Page.bringToFront")
        self.studio.wait_for_expression("document.getElementById('scan-view').dataset.streaming === 'true'", timeout=CONNECT_TIMEOUT)
        phone.wait_for_expression("window.__peer.badSent === true", timeout=30)
        time.sleep(0.5)
        self.assertEqual(self.studio.evaluate("window.gemScanVision()"), None, "a malformed message was taken")
        self.assertEqual(self.studio.evaluate("document.getElementById('scan-overlay').dataset.drawn ?? 'none'"), "none")

        phone.wait_for_expression("window.__peer.goodSent === true", timeout=10)
        self.studio.wait_for_expression("window.gemScanVision() !== null", timeout=5)
        taken = self.studio.evaluate("window.gemScanVision().message")
        self.assertEqual(taken["timeMs"], 4242)
        self.assertEqual(taken["frame"], {"w": 640, "h": 480})
        self.assertEqual(phone.evaluate("window.__peer.asked"), 1, "the studio asks once")
        phone.evaluate("window.__peer.room.leave(), true")


if __name__ == "__main__":
    unittest.main()
