"""Times the rock outline (T-0325) on this machine's GPU in headless Chrome.

    ~/.pyenv/versions/anaconda3-2019.07/bin/python3 tests/harness/vision/time_outline.py

For crops of 256 and 512 pixels: 60 find() calls on one synthetic 1920 x 1080 frame (each
re-uploading it, as each video frame is), after 5 warm-up calls. Prints the median wall time per
call (upload, GPU passes and the readbacks, which wait for the GPU) and the CPU part (mask,
refinement and outline), as JSON. Run timing through tools/gpu_queue.py, one at a time.
"""

import functools
import http.server
import json
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, os.path.dirname(HERE))

import cdp  # noqa: E402


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    chrome = cdp.Chrome(gl_backend="metal")

    try:
        chrome.navigate("http://localhost:%d/tests/harness/vision/outline_test.html" % httpd.server_address[1])

        for _ in range(600):
            if chrome.evaluate("window.visionReady || null"):
                break
            time.sleep(0.05)

        out = {"renderer": chrome.gpu_renderer_string(), "runs": []}
        case = {"spec": "charuco_23x17_10mm_centre3x3", "width": 1920, "height": 1080, "f": 1500, "k1": 0.03,
                "distanceMm": 170, "elevation": 40, "azimuth": 30}

        for crop in (256, 512):
            r = chrome.send("Runtime.evaluate", {"expression": "visionTest.timing(%s, %d, 60)" % (json.dumps(case), crop),
                                                 "returnByValue": True, "awaitPromise": True}, timeout=600)
            out["runs"].append(r["result"]["value"])

        print(json.dumps(out, indent=1))
    finally:
        chrome.close()
        httpd.shutdown()


if __name__ == "__main__":
    main()
