"""Timing of the phone's camera pose and live intrinsics in headless Chrome (T-0324).

The pose solver (src/web/src/lib/vision/pose.js) runs on every camera frame on the phone, and the
intrinsics refinement (intrinsics.js, calibrate.js) runs in the background between frames, so
both have a time budget. The Deno unit tests (src/web/tests/vision_*_test.js) check what they
compute; this measures what they cost in a browser engine, with the stock opencv.js 4.12 loaded as
a classic script as a phone page would load it.

HOW IT RUNS. The project root is served over HTTP on localhost; headless Chrome opens
tests/harness/vision_timing.html, which loads opencv.js from src/web/node_modules (the test-only
dev dependency @techstark/opencv-js) and vision_timing.js, which does the timing and leaves its
results in `window.__visionTiming`. It does so twice: at once after opencv.js is ready, and after
8 s idle (in case the browser was still compiling opencv's ~10 MB of wasm; measured, it made no
difference). The test prints both and checks only loose ceilings on MEDIANS (it is a measurement,
not a benchmark gate): a pose solve under 10 ms, a refinement step under 20 ms. The tails are
printed but not checked: in headless Chrome on this Mac identical calls stall at random by up to
seconds (see the assertion's comment), which no change to the code moves.

Timing runs go through the GPU queue, one at a time across agents (CLAUDE.md):

    tools/gpu_queue.py run --as "$AGENT_NAME" --label "timing: phone vision" -- \\
        ~/.pyenv/versions/anaconda3-2019.07/bin/python3 -m unittest tests/harness/test_vision_timing.py -v

Skipped, with the reason, when opencv.js is not installed (`cd src/web && deno install`), or Chrome
or `websocket-client` is missing.
"""

import functools
import http.server
import json
import os
import sys
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))
OPENCV_JS = os.path.join(PROJECT_ROOT, "src", "web", "node_modules", "@techstark", "opencv-js", "dist", "opencv.js")

sys.path.insert(0, HERE)

try:
    import cdp
except ImportError as error:  # websocket-client is not installed
    cdp = None
    IMPORT_ERROR = str(error)


# A headless renderer counts as a background page to Chrome (and its process as background work to
# macOS), which throttles its timers and may park it: a phone page in use is in the foreground, so
# the timing asks Chrome not to background it.
FOREGROUND_ARGS = (
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
)


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@unittest.skipIf(cdp is None, "needs websocket-client: %s" % (IMPORT_ERROR if cdp is None else ""))
@unittest.skipUnless(os.path.isfile(OPENCV_JS), "opencv.js is not installed (%s); run deno install in src/web" % OPENCV_JS)
class VisionTimingTest(unittest.TestCase):
    def test_pose_and_intrinsics_timing(self):
        # Setup: the project root over HTTP (module scripts and their JSON imports need http, not
        # file://), and a headless Chrome.
        handler = functools.partial(_QuietHandler, directory=PROJECT_ROOT)
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()

        try:
            try:
                try:
                    chrome = cdp.Chrome(extra_args=FOREGROUND_ARGS)
                    flags = "foreground flags"
                except TypeError:  # a cdp.py without extra_args (before T-0319)
                    chrome = cdp.Chrome()
                    flags = "default flags"
            except Exception as error:  # no Chrome on this machine
                raise unittest.SkipTest("could not start Chrome: %s" % error)

            try:
                # Test: open the timing page twice: timing at once after opencv.js is ready (what
                # a phone page's first seconds see, while the browser still compiles opencv's
                # wasm in the background), and after 8 s idle (the steady state).
                results = {}

                for settle in (0, 8000):
                    chrome.navigate("about:blank")
                    chrome.navigate("http://localhost:%d/tests/harness/vision_timing.html?settle=%d" % (httpd.server_address[1], settle))
                    chrome.wait_for_expression("!!(window.__visionTiming || window.__visionTimingError)", timeout=240)
                    error = chrome.evaluate("window.__visionTimingError || null")
                    self.assertIsNone(error, error)
                    results[settle] = chrome.evaluate("window.__visionTiming")
            finally:
                chrome.close()
        finally:
            httpd.shutdown()
            httpd.server_close()

        print("\nChrome started with %s" % flags)
        print(json.dumps(results, indent=1))

        # Verifies: the loose ceilings above, on medians, and that the estimator really refined.
        # Not on the tails: on this Mac a headless renderer's thread stalls at random -- measured,
        # the same 9-iteration LM on the same 32 corners took 0.3 ms to 993 ms, and IPPE 0.1 to
        # 320 ms, while Deno runs both steadily -- so p95 and max here measure the machine.
        for result in results.values():
            for key in ("pose_moissanite", "pose_spinel", "pose_synthetic"):
                self.assertLess(result[key]["median"], 10.0, key)

            self.assertEqual(result["estimator"]["final"]["source"], "refined")
            self.assertLess(result["estimator"]["refineTicks"]["median"], 20.0)


if __name__ == "__main__":
    unittest.main()
