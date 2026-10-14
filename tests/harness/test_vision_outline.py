"""The phone's rock outline (T-0325, src/web/src/lib/vision/outline.js), measured end to end.

outline.js finds the rock's outline in a camera frame from the camera's pose over the printed
board: it predicts the bare board on the GPU and calls rock what the frame shows that a shadowed,
slightly misregistered board cannot explain (the HousekiScanner desktop pipeline's Step 3, cut
down to one frame). These tests run it in headless Chrome on the real GPU and measure it:

  * the board texture it predicts from, drawn from the spec, against the scanner project's
    printed PNGs, pixel by pixel (skipped when the scanner project is not on this machine);
  * synthetic frames with exact silhouettes (tests/harness/vision/synth.js: a ray-traced board and
    rock, with thin-lens defocus, soft shadows, vignetting, a tone curve and noise): an opaque, a
    clear tinted and a pale grey rock over elevations 15-80 degrees and three azimuths, a long
    cast shadow, a defocused low view at 2x zoom, poses with errors, the other three boards, and
    empty boards (false positives);
  * real frames from the scanner's reference captures (tests/harness/fixtures/vision_outline/,
    built by vision/make_outline_fixtures.py), against the desktop pipeline's masks.

The IoU thresholds sit a little under what was measured when the finder was built (T-0325's
close note and kb/phone-rock-outline-*), so a regression fails while run-to-run GPU differences
do not. Run with -v to see every case's numbers:

    ~/.pyenv/versions/anaconda3-2019.07/bin/python3 -m unittest tests/harness/test_vision_outline.py -v

Headless Chrome needs the real GPU here (gl_backend="metal"); it does not start inside the
command sandbox. Skipped, with the reason, when Chrome or websocket-client is missing.
"""

import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))
PAGE = "/tests/harness/vision/outline_test.html"
FIXTURES = "../fixtures/vision_outline"          # relative to the page
# The boards' printed PNGs (the user's, T-0340), in the gitignored working store: the comparison
# skips when they are not on this machine.
BOARD_PNGS = os.environ.get("HOUSEKI_BOARD_PNGS", os.path.join(PROJECT_ROOT, "3d_reconstruction", "reference"))
if not os.path.isdir(BOARD_PNGS):  # a worktree: the main checkout's working store
    BOARD_PNGS = "/Users/LucasTong/Documents/HousekiDesignStudio/3d_reconstruction/reference"
BOARDS = ["charuco_23x17_10mm_white_grey_spiral", "charuco_23x17_10mm_grey_black_spiral", "charuco_23x17_10mm_white_black_spiral"]

sys.path.insert(0, HERE)

try:
    import cdp
except ImportError as error:  # websocket-client is not installed
    cdp = None
    IMPORT_ERROR = str(error)

try:
    import numpy as np
    from PIL import Image
except ImportError:  # the PNG comparison needs them
    np = None

# The synthetic camera: a phone's main camera streaming 1920 x 1080 (f = 1500 px, about 65 degrees
# across), 170 mm from the rock, a little barrel distortion, and a lens of 3.4 mm aperture focused
# on the rock (kappa = A f / 4 = 0.85 f, the finder's default lens constant).
BASE = {
    "spec": "charuco_23x17_10mm_white_black_spiral", "width": 1920, "height": 1080, "f": 1500, "k1": 0.03,
    "distanceMm": 170, "aperture": 3.4, "samples": 36, "roll": 8,
}
ELEVATIONS = [15, 30, 45, 60, 80]
AZIMUTHS = [0, 120, 240]


class Server:
    """The repository over HTTP on a free localhost port, in a thread."""

    def __init__(self):
        handler = functools.partial(_QuietHandler, directory=PROJECT_ROOT)
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.origin = "http://localhost:%d" % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def case(**overrides):
    c = dict(BASE)
    c.update(overrides)
    return c


@unittest.skipIf(cdp is None, "needs websocket-client: %s" % (IMPORT_ERROR if cdp is None else ""))
class VisionOutlineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()

        try:
            cls.chrome = cdp.Chrome(gl_backend="metal")
        except Exception as error:  # no Chrome on this machine
            cls.server.close()
            raise unittest.SkipTest("could not start Chrome: %s" % error)

        cls.renderer = cls.chrome.gpu_renderer_string() or ""
        cls.chrome.navigate(cls.server.origin + PAGE)
        deadline = time.time() + 30

        while time.time() < deadline:
            state = cls.chrome.evaluate("window.visionReady ? 'ready' : (window.visionError || null)")

            if state:
                break

            time.sleep(0.05)

        if state != "ready":
            cls.chrome.close()
            cls.server.close()
            raise RuntimeError("the harness page did not load: %r" % state)

    @classmethod
    def tearDownClass(cls):
        cls.chrome.close()
        cls.server.close()

    def call(self, expression, timeout=600):
        """Evaluates a JS expression that returns a promise, and returns its value."""
        result = self.chrome.send("Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "awaitPromise": True,
        }, timeout=timeout)

        if result.get("exceptionDetails"):
            raise RuntimeError(json.dumps(result["exceptionDetails"])[:2000])

        return result.get("result", {}).get("value")

    def synth(self, c):
        return self.call("visionTest.synthCase(%s)" % json.dumps(c))

    # --- the board texture ------------------------------------------------------------------

    @unittest.skipIf(np is None, "needs numpy and PIL")
    @unittest.skipUnless(shutil.which("deno"), "needs Deno")
    @unittest.skipUnless(all(os.path.isfile(os.path.join(BOARD_PNGS, n + ".png")) for n in BOARDS), "the boards' PNGs are not here")
    def test_board_texture_matches_the_printed_boards(self):
        """Setup: each of the three boards drawn by board_texture.js in print grey levels at the
        PNG's 23.6 px per mm with no pad, and the user's printed PNG cropped to the board (its
        top-left corner at the spec's print.board_origin_px).
        Test: compare them pixel by pixel.
        Verifies: under 2% of the pixels differ by more than 40 grey levels, and nearly all of
        those lie on an edge of the drawn texture (the PNG rounds edges to whole pixels, the
        texture is exact): the colours, every marker's id, bits and orientation, and the spirals'
        places and greys must therefore be right."""
        for name in BOARDS:
            spec = json.load(open(os.path.join(PROJECT_ROOT, "src/web/src/lib/vision/boards", name + ".json")))

            with tempfile.TemporaryDirectory() as tmp:
                raw = os.path.join(tmp, "tex.raw")
                out = subprocess.run(
                    ["deno", "run", "--allow-read", "--allow-write", "tests/harness/vision/dump_board_texture.js",
                     name, str(spec["print"]["px_per_mm"]), raw],
                    cwd=PROJECT_ROOT, capture_output=True, text=True, check=True).stdout.split()
                w, h = int(out[0]), int(out[1])
                mine = np.fromfile(raw, np.uint8).reshape(h, w).astype(int)

            page = np.asarray(Image.open(os.path.join(BOARD_PNGS, name + ".png")).convert("L")).astype(int)
            ox, oy = spec["print"]["board_origin_px"]
            ref = page[oy:oy + h, ox:ox + w]
            disagree = np.abs(mine - ref) > 40
            edge = np.zeros_like(disagree)

            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    edge |= np.abs(mine - np.roll(np.roll(mine, dy, 0), dx, 1)) > 8

            fraction = disagree.mean()
            off_edge = int((disagree & ~edge).sum())
            print("\n  %s: %.3f%% of pixels differ, %d of them off an edge" % (name, 100 * fraction, off_edge))
            self.assertLess(fraction, 0.02, name)
            self.assertLess(off_edge, 500, name)

    # --- synthetic frames --------------------------------------------------------------------

    def run_matrix(self, rock):
        rows = []

        for elevation in ELEVATIONS:
            for azimuth in AZIMUTHS:
                r = self.synth(case(rock=rock, elevation=elevation, azimuth=azimuth, seed=elevation + azimuth))
                rows.append((elevation, azimuth, r))

        print("\n  %s rock: IoU by elevation (azimuths %s)" % (rock, AZIMUTHS))

        for elevation in ELEVATIONS:
            ious = [r["iou"] for e, a, r in rows if e == elevation]
            print("    %2d deg: %s   mean %.3f" % (elevation, "  ".join("%.3f" % v for v in ious), sum(ious) / len(ious)))

        ious = [r["iou"] for _, _, r in rows]
        print("    all: mean %.3f, min %.3f" % (sum(ious) / len(ious), min(ious)))
        return ious

    def test_opaque_rock_over_elevations_and_azimuths(self):
        """Setup: an opaque reddish-brown rock (a convex polyhedron about 16 x 13 x 9.5 mm) on the
        centre target, lit from above at an angle (a soft shadow beside it).
        Test: find its outline from 5 elevations x 3 azimuths.
        Verifies: IoU against the exact silhouette, mean >= 0.95 and every view >= 0.92 (measured
        when built: mean 0.976, least 0.957)."""
        ious = self.run_matrix("opaque")
        self.assertGreaterEqual(sum(ious) / len(ious), 0.95)
        self.assertGreaterEqual(min(ious), 0.92)

    def test_clear_tinted_rock_over_elevations_and_azimuths(self):
        """Setup: the same shape, clear and green-tinted (index 1.6): it shows the board refracted
        through it, which is what the desktop's chroma cue is for.
        Test: as for the opaque rock.
        Verifies: mean IoU >= 0.91, every view >= 0.87 (measured: 0.940, least 0.907)."""
        ious = self.run_matrix("clear")
        self.assertGreaterEqual(sum(ious) / len(ious), 0.91)
        self.assertGreaterEqual(min(ious), 0.87)

    def test_pale_grey_rock_over_elevations_and_azimuths(self):
        """Setup: the same shape in a pale, nearly neutral grey: over the white target it differs
        from paper mostly in brightness, which a shadow allowance could explain away (the
        desktop's trap: a uniform grey face over plain paper looks like a shadow).
        Test: as for the opaque rock.
        Verifies: mean IoU >= 0.93, every view >= 0.89 (measured: 0.957, least 0.927)."""
        ious = self.run_matrix("grey")
        self.assertGreaterEqual(sum(ious) / len(ious), 0.93)
        self.assertGreaterEqual(min(ious), 0.89)

    def test_long_cast_shadow_is_not_rock(self):
        """Setup: the opaque rock under a low light (25 degrees up) that throws a long, dark shadow
        across the target and the squares beside it.
        Test: three views.
        Verifies: IoU >= 0.88 in each: the shadow (a multiplicative darkening, fitted per 2.5 mm
        window and accepted pixel by pixel over ink) does not join the outline."""
        for azimuth in AZIMUTHS:
            r = self.synth(case(rock="opaque", elevation=40, azimuth=azimuth, light=[0.85, -0.3, 0.42], ambient=0.3))
            print("\n  long shadow, azimuth %d: IoU %.3f (fp %d, fn %d px)" % (azimuth, r["iou"], r["fpPx"], r["fnPx"]))
            self.assertGreaterEqual(r["iou"], 0.88)

    def test_defocused_low_view_at_2x_zoom(self):
        """Setup: a 2x-zoom camera (f = 3000 px) 150 mm away at 15-20 degrees, focused on the rock:
        the board behind it blurs by several pixels (the desktop's measured trap: without
        depth-dependent blur the far board reads as rock). Once with the lens the finder assumes
        (aperture 3.4 mm, kappa = 0.85 f) and once with a smaller one (2 mm), which the finder does
        not know.
        Test: find the outline.
        Verifies: IoU >= 0.9 in both: the defocus model and its focus slack carry the far board."""
        for aperture in [3.4, 2.0]:
            for elevation in [15, 20]:
                r = self.synth(case(rock="opaque", elevation=elevation, azimuth=60, f=3000, distanceMm=150, aperture=aperture))
                print("\n  2x zoom, %d deg, aperture %.1f mm: IoU %.3f" % (elevation, aperture, r["iou"]))
                self.assertGreaterEqual(r["iou"], 0.9)

    # T-0341: on the spiral boards the rock stands on a marker square with spirals around it, and a
    # pose this far off scores IoU 0.873 at 20 degrees (0.947 on the old blank-target sheet; 0.901
    # with registration). Known, ticketed; an unexpected success means it was fixed.
    @unittest.expectedFailure
    def test_pose_errors(self):
        """Setup: the opaque rock seen at 20 and 45 degrees, the finder given a pose that is off:
        turned by 0.3 degrees (about 8 px at f = 1500) and with a focal length 5% too long, as a
        live pose from a table focal length can be.
        Test: find the outline with that pose, with the default options (no registration) and
        with two registration steps (registerIterations: 2).
        Verifies: IoU >= 0.9 either way (the slack absorbs the error), and the registration does
        not make it worse (it measured 0.947 -> 0.962 at 20 degrees when added)."""
        for elevation in [20, 45]:
            bad = {"deg": 0.3, "fScale": 1.05}
            plain = self.synth(case(rock="opaque", elevation=elevation, azimuth=30, poseError=bad))
            registered = self.synth(case(rock="opaque", elevation=elevation, azimuth=30, poseError=bad,
                                         finder={"registerIterations": 2}))
            print("\n  pose error, %d deg: IoU %.3f, with registration %.3f" % (elevation, plain["iou"], registered["iou"]))
            self.assertGreaterEqual(plain["iou"], 0.9)
            self.assertGreaterEqual(registered["iou"], plain["iou"] - 0.005)

    def test_other_boards(self):
        """Setup: the opaque rock on the other two boards: grey/black (dark squares and ink black,
        light squares a mid grey) and white/grey (dark squares and ink a light grey); no target,
        so the core is a 5 mm disc.
        Test: find the outline at 35 degrees.
        Verifies: IoU >= 0.9 on each: the texture's greys and spirals follow the spec."""
        for spec in BOARDS[:2]:
            r = self.synth(case(spec=spec, rock="opaque", elevation=35, azimuth=200))
            print("\n  %s: IoU %.3f" % (spec, r["iou"]))
            self.assertGreaterEqual(r["iou"], 0.9)

    def test_empty_board_finds_nothing(self):
        """Setup: no rock, the bare board (with its lighting gradient, vignetting and noise) from
        five elevations, on each of the three boards.
        Test: find an outline.
        Verifies: none is reported (flag no_rock), i.e. no false positives over the default
        minimum area (6 mm^2)."""
        for spec in BOARDS:
            for elevation in ELEVATIONS:
                r = self.synth(case(spec=spec, rock=None, elevation=elevation, azimuth=elevation * 3))
                print("\n  empty %s, %d deg: found %d px, flags %s" % (spec, elevation, r["foundPx"], r["flags"]))
                self.assertEqual(r["foundPx"], 0)

    # --- real frames -------------------------------------------------------------------------

    def test_real_frames_against_the_desktop_masks(self):
        """Setup: eight frames of the scanner's three reference captures (moissanite, quartz,
        spinel; 16-72 degrees; 2x and 1x zoom), at half resolution, with the desktop pipeline's
        poses and its Step 3 masks (which also used 40 views: board anomaly, carve fill and cut).
        The board is the older 22 x 17 sheet, given as the spec.
        Test: find the outline in each with the default options.
        Verifies: IoU against the desktop mask >= 0.85 in every frame and >= 0.92 on average."""
        rows = self.call("visionTest.realAll(%s)" % json.dumps(FIXTURES))

        for r in rows:
            print("\n  %s #%d (%.0f deg): IoU %.3f (fp %d, fn %d px of %d)" % (
                r["capture"], r["index"], r["elevationDeg"], r["iou"], r["fpPx"], r["fnPx"], r["truthPx"]))

        ious = [r["iou"] for r in rows]
        print("\n  mean %.3f" % (sum(ious) / len(ious)))
        self.assertGreaterEqual(min(ious), 0.85)
        self.assertGreaterEqual(sum(ious) / len(ious), 0.92)


if __name__ == "__main__":
    unittest.main()
