"""The phone's board detection and QR reading in headless Chrome (T-0323, T-0330).

Since T-0330 the phone finds the board and reads QR codes with the Rust vision module (src/vision,
built by make_page.py into build/vision/houseki_vision.js and served next to the phone page as
build/www/scanner/houseki_vision.js); opencv.js, which did both until then, stays in the repository
as the reference these tests compare against. src/web/tests/vision_*_test.js test both under Deno
on synthetic frames; these tests add what needs a real browser:

  * LOADING. The phone page loads the vision module as a classic <script src="houseki_vision.js">
    next to itself (src/web/src/lib/vision/vision_wasm.js), inflates it and hands it to its vision
    Worker. That is tested in the deployed layout, a page with the script beside it, over HTTP and
    from file://, where fetch() and module imports would fail -- in the page and in a Worker started
    from a blob, as the phone's is. The same check is kept for opencv.js, which the pose still uses.
  * REAL PHONE FRAMES. tests/fixtures/charuco_real/ holds crops of four frames of the desktop
    scanner pipeline's reference captures (HousekiScanner, phone video at 2x zoom) and the corners
    that pipeline found on them (OpenCV 5.0.0, Python). Each crop is pasted back into a frame of
    its original size and detected here, by the Rust detector and by opencv.js; the Rust detector
    must reproduce opencv.js exactly, and both are compared with the desktop.
  * SYNTHETIC FRAMES from 480p to 1080p, perspective, blur and noise, with known truth
    (src/web/tests/vision_synth.js), in Chrome's V8 rather than Deno's.
  * NO LEAKS over 200 frames (the Rust module's WebAssembly memory, which only grows, unchanged).
  * QR codes encoded as the studio encodes its pairing link (scan_qr.js), read back.
  * TIMING (opt-in, GEM_VISION_TIMING=1, run it through tools/gpu_queue.py): ms per frame of both
    detectors at 720p and 1080p, processing scale 1 and 0.5, on the live pipeline's 960 x 540
    whole-board view, and of both QR readers; and each module's load time.

The page under test is tests/harness/vision_detect_page.html, served with the whole project root
over HTTP, importing the modules straight from src/ and the vision module from
build/vision/houseki_vision.js (so ./build.sh, or make_page.py, must have run; the tests skip
otherwise). The deployed-layout tests use build/www/scanner/ when it exists.

    ~/.pyenv/versions/anaconda3-2019.07/bin/python3 -m unittest tests/harness/test_vision_detect.py -v
    GEM_VISION_TIMING=1 tools/gpu_queue.py run --as "$AGENT_NAME" --label "timing: phone vision" -- \\
        ~/.pyenv/versions/anaconda3-2019.07/bin/python3 -m unittest tests/harness/test_vision_detect.py -v -k Timing

Chrome is started NATIVELY (arm64) even though the harness Python runs under Rosetta
(native_chrome below): translated, every wasm timing here was 10-100x too slow. Headless Chrome
does not start inside the agent command sandbox: run with the sandbox disabled. Skipped, with
the reason, when Chrome or `websocket-client` is missing.
"""

import functools
import http.server
import json
import math
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
PAGE = "/tests/harness/vision_detect_page.html"
FIXTURE_DIR = os.path.join(PROJECT_ROOT, "tests", "fixtures", "charuco_real")
BUILT_OPENCV = os.path.join(PROJECT_ROOT, "build", "www", "scanner", "opencv.js")
VENDOR_OPENCV = os.path.join(PROJECT_ROOT, "src", "web", "vendor", "opencv", "opencv.js")
LOADER = os.path.join(PROJECT_ROOT, "src", "web", "src", "lib", "vision", "opencv.js")
# The Rust vision module's script: as installed next to the phone page, or as make_page.py built it.
DEPLOYED_VISION = os.path.join(PROJECT_ROOT, "build", "www", "scanner", "houseki_vision.js")
BUILT_VISION = os.path.join(PROJECT_ROOT, "build", "vision", "houseki_vision.js")
VISION_URL = "/build/vision/houseki_vision.js"
VISION_LOADER = os.path.join(PROJECT_ROOT, "src", "web", "src", "lib", "vision", "vision_wasm.js")

sys.path.insert(0, HERE)

try:
    import cdp

    cdp.find_chrome()
    SKIP = None
except Exception as error:  # websocket-client or Chrome missing
    SKIP = str(error)

if SKIP is None and not os.path.isfile(BUILT_VISION):
    SKIP = "%s is missing: run ./build.sh (or src/scripts/make_page.py) first" % BUILT_VISION


class Server:
    """`root` over HTTP on a free localhost port, in a thread, with JavaScript module MIME types
    (an old Python's mimetypes does not know .mjs, and Chrome refuses a module without one)."""

    def __init__(self, root):
        handler = functools.partial(_Handler, directory=root)
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.origin = "http://localhost:%d" % self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class _Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
    }

    def log_message(self, *args):
        pass


def evaluate(chrome, expression, timeout=300):
    """Evaluates an async JS expression, awaiting its promise, and returns its JSON value."""
    result = chrome.send(
        "Runtime.evaluate",
        {"expression": expression, "returnByValue": True, "awaitPromise": True},
        timeout=timeout,
    )
    exception = result.get("exceptionDetails")

    if exception:
        detail = exception.get("exception", {}).get("description") or json.dumps(exception)
        raise RuntimeError("JS exception: %s" % detail)

    return result.get("result", {}).get("value")


def percentile(values, q):
    ordered = sorted(values)

    if not ordered:
        return float("nan")

    return ordered[min(len(ordered) - 1, int(math.floor(q * (len(ordered) - 1) + 0.5)))]


def native_chrome(**kwargs):
    """A cdp.Chrome running natively on Apple silicon.

    The harness Python (anaconda's) is an x86_64 binary, so it runs under Rosetta, and macOS
    hands that preference down to the processes it starts: Chrome is a universal binary and then
    runs as x86_64 too, with V8's JIT code translated by Rosetta as it is generated. Measured
    (2026-10-04, this M1 Pro): opencv.js took 6-9 s from <script> to ready and 1.1-1.6 ms per
    cv.Mat new/delete that way, against 0.08 s and 4 us natively -- a phone-scale distortion of
    every timing. So Chrome is started through `arch -arm64` whenever this Python is translated."""
    try:
        translated = subprocess.run(["sysctl", "-n", "sysctl.proc_translated"],
                                    capture_output=True, text=True).stdout.strip() == "1"
    except OSError:
        translated = False

    if not translated:
        return cdp.Chrome(**kwargs)

    popen = cdp.subprocess.Popen

    def native_popen(args, **popen_kwargs):
        return popen(["arch", "-arm64", *args], **popen_kwargs)

    cdp.subprocess.Popen = native_popen

    try:
        return cdp.Chrome(**kwargs)
    finally:
        cdp.subprocess.Popen = popen


def open_page(test_class):
    """Starts the server and Chrome, opens the harness page and loads opencv.js and the vision
    module in it. Records each one's load time (script added -> ready) on the class."""
    test_class.server = Server(PROJECT_ROOT)
    test_class.chrome = native_chrome()
    test_class.chrome.navigate(test_class.server.origin + PAGE)
    test_class.chrome.wait_for_expression("window.visionReady === true", timeout=60)
    loads = evaluate(test_class.chrome, """(async () => {
        let started = performance.now();
        await vision.loadVision({ url: %s });
        const visionMs = performance.now() - started;
        started = performance.now();
        await vision.loadOpenCv({ url: '/src/web/vendor/opencv/opencv.js' });
        return { visionMs, opencvMs: performance.now() - started };
    })()""" % json.dumps(VISION_URL))
    test_class.vision_load_ms = loads["visionMs"]
    test_class.load_ms = loads["opencvMs"]


def close_page(test_class):
    test_class.chrome.close()
    test_class.server.close()


def deployed_page(script_name, loader_path, body):
    """A one-file page in the deployed layout's style: the loader module's source inlined as an
    inline module (which a file:// page may run), then `body`."""
    loader = open(loader_path).read().replace("\nexport ", "\n")
    return ("<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><script type=\"module\">\n"
            + loader + "\n" + body + "\n</script></body></html>")


@unittest.skipIf(SKIP, "needs headless Chrome, websocket-client and a built vision module: %s" % SKIP)
class VisionDetectTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        open_page(cls)
        print("\nvision module ready in %.0f ms, opencv.js in %.0f ms (over HTTP from localhost)"
              % (cls.vision_load_ms, cls.load_ms))

    @classmethod
    def tearDownClass(cls):
        close_page(cls)

    def test_vision_module_loads_next_to_the_page_and_into_a_worker_over_http_and_from_file(self):
        # Setup: the DEPLOYED layout -- a directory holding a one-file page and houseki_vision.js
        # next to it, as make_page.py writes build/www/scanner/ -- made in a temporary directory.
        # The page inlines the real loader module (src/web/src/lib/vision/vision_wasm.js) and calls
        # visionPayload() and loadVision() with NO url, so it asks for "houseki_vision.js" relative
        # to itself, as the phone page does; then starts a Worker from a blob (as the phone's
        # inline Worker starts), posts it the payload, and has it instantiate the module too.
        # Test: open that page over HTTP, and then from file://, in a fresh tab each.
        # Verifies: both times the page's module works (a CharucoDetector made and freed, a QR read
        # of an empty frame returns 0 codes), the script was added once, a second loadVision()
        # returns the same module, and the Worker instantiated the module from the posted payload
        # and ran a detector -- from file:// too, where a Worker cannot load any file itself.
        work = tempfile.mkdtemp(prefix="gem-vision-")
        source = DEPLOYED_VISION if os.path.isfile(DEPLOYED_VISION) else BUILT_VISION
        shutil.copyfile(source, os.path.join(work, "houseki_vision.js"))
        loader_text = open(VISION_LOADER).read().replace("\nexport ", "\n")
        worker_source = (loader_text
                         + "\nself.onmessage = async ({ data }) => {\n"
                         "  try {\n"
                         "    const v = await loadVision({ payload: data });\n"
                         "    const d = new v.CharucoDetector(23, 17, 0.7);\n"
                         "    const out = d.detect(new Uint8Array(64 * 48).fill(90), 64, 48, 1, true, true, false, 40);\n"
                         "    d.free();\n"
                         "    self.postMessage({ ok: out.length > 0 && out[0] === 64 });\n"
                         "  } catch (error) { self.postMessage({ error: String(error) }); }\n"
                         "};\n")
        body = (
            "const started = performance.now();\n"
            "const workerSource = %s;\n"
            "(async () => {\n"
            "  const payload = await visionPayload();\n"
            "  const v = await loadVision();\n"
            "  const again = await loadVision();\n"
            "  const d = new v.CharucoDetector(23, 17, 0.7); d.free();\n"
            "  const r = new v.QrReader(); const codes = r.read(new Uint8Array(80 * 60).fill(120), 80, 60, 1); r.free();\n"
            "  const pageMs = performance.now() - started;\n"
            "  const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));\n"
            "  const fromWorker = await new Promise((resolve) => {\n"
            "    worker.onmessage = ({ data }) => resolve(data);\n"
            "    worker.onerror = (event) => resolve({ error: String(event.message) });\n"
            "    worker.postMessage(payload);\n"
            "  });\n"
            "  worker.terminate();\n"
            "  window.result = { ok: codes === 0, same: again === v, scripts: document.querySelectorAll('script[data-vision]').length,\n"
            "                    worker: fromWorker, ms: pageMs };\n"
            "})().catch((error) => { window.result = { error: String(error) }; });\n"
        ) % json.dumps(worker_source)
        open(os.path.join(work, "index.html"), "w").write(deployed_page("houseki_vision.js", VISION_LOADER, body))
        server = Server(work)

        try:
            for url in (server.origin + "/index.html", "file://" + os.path.join(work, "index.html")):
                with self.subTest(url=url.split(":")[0]):
                    tab = self.chrome.new_tab()
                    tab.navigate(url)
                    tab.wait_for_expression("window.result !== undefined", timeout=60)
                    result = tab.evaluate("window.result")
                    print("  %s: %s" % (url.split(":")[0], result))
                    self.assertNotIn("error", result)
                    self.assertTrue(result["ok"] and result["same"], result)
                    self.assertEqual(result["scripts"], 1)
                    self.assertEqual(result["worker"], {"ok": True})
        finally:
            server.close()
            shutil.rmtree(work, ignore_errors=True)

    def test_opencv_loads_next_to_the_page_over_http_and_from_file(self):
        # Setup: the DEPLOYED layout -- a directory holding a one-file page and opencv.js next to
        # it, as make_page.py writes build/www/scanner/ (the phone still loads it for the pose) --
        # made in a temporary directory. The page inlines the real loader module and calls
        # loadOpenCv() with NO url, so it asks for "opencv.js" relative to itself.
        # Test: open that page over HTTP, and then from file://, in a fresh tab each.
        # Verifies: both times the loader resolves to a ready cv (a Mat can be made), the script
        # was added once (one <script data-opencv>), and a second loadOpenCv() returns the same cv.
        work = tempfile.mkdtemp(prefix="gem-vision-")
        source = BUILT_OPENCV if os.path.isfile(BUILT_OPENCV) else VENDOR_OPENCV
        shutil.copyfile(source, os.path.join(work, "opencv.js"))
        body = (
            "const started = performance.now();\n"
            "loadOpenCv().then(async (cv) => {\n"
            "  const again = await loadOpenCv();\n"
            "  const mat = new cv.Mat(2, 3, cv.CV_8UC1); const ok = mat.cols === 3; mat.delete();\n"
            "  window.result = { ok, same: again === cv, scripts: document.querySelectorAll('script[data-opencv]').length,\n"
            "                    ms: performance.now() - started };\n"
            "}, (error) => { window.result = { error: String(error) }; });\n"
        )
        open(os.path.join(work, "index.html"), "w").write(deployed_page("opencv.js", LOADER, body))
        server = Server(work)

        try:
            for url in (server.origin + "/index.html", "file://" + os.path.join(work, "index.html")):
                with self.subTest(url=url.split(":")[0]):
                    tab = self.chrome.new_tab()
                    tab.navigate(url)
                    tab.wait_for_expression("window.result !== undefined", timeout=60)
                    result = tab.evaluate("window.result")
                    print("  %s: %s" % (url.split(":")[0], result))
                    self.assertNotIn("error", result)
                    self.assertTrue(result["ok"] and result["same"], result)
                    self.assertEqual(result["scripts"], 1)
        finally:
            server.close()
            shutil.rmtree(work, ignore_errors=True)

    def test_real_phone_frames_match_opencv_js_and_the_desktop_pipeline(self):
        # Setup: the four fixture frames (moissanite, quartz sharp, quartz blurred, spinel; phone
        # video at 2x zoom, 1080 x 1920), each pasted at its place in a mid-grey frame of the
        # original size, as RGBA ImageData; the board spec each capture used (the OLDER 22 x 22
        # board, 0.68-0.689 markers) from fixture.json; and the corners the DESKTOP detector
        # (HousekiScanner's own code, OpenCV 5.0.0 native) found on that same padded frame.
        # Test: detect each frame twice with a fresh default Rust detector (the first frame tunes
        # the marker-size factor) and twice with a fresh opencv.js one; once more each with
        # desktopHalfPixelShift, which reproduces detect.py's half-pixel shift.
        # Verifies: (1) the Rust detector reproduces opencv.js exactly: the same corner ids and
        # marker counts, positions within 0.001 px, the same sharpness; (2) at least 95% of the
        # desktop's corner ids are found (missing and extra ids listed); (3) on the corners the
        # desktop called sharp (sharpness >= 50, not re-refined) the positions agree with the
        # desktop to 0.05 px median -- same algorithm, same parameters, same pixels; (4) on its
        # re-refined (blurred) corners our positions sit about half a pixel up and left of its, and
        # the shifted variant agrees with it to 0.05 px: the desktop's half-pixel shift is the whole
        # difference. Prints every number.
        fixture = json.load(open(os.path.join(FIXTURE_DIR, "fixture.json")))
        sharp_diffs, blurred_diffs, blurred_shifted, gaps = [], [], [], []
        report = []

        for entry in fixture["frames"]:
            result = evaluate(self.chrome, """(async () => {
                const entry = %s;
                const image = await vision.fixtureFrame(entry, '/tests/fixtures/charuco_real/');
                const cv = await vision.loadOpenCv();
                const wasm = await vision.loadVision();
                const run = (make) => {
                    const plain = make({});
                    plain.detect(image);
                    const detection = plain.detect(image);
                    const shifted = make({ markerScale: detection.markerScale, desktopHalfPixelShift: true });
                    const shiftedDetection = shifted.detect(image);
                    plain.dispose();
                    shifted.dispose();
                    return { detection, shifted: shiftedDetection };
                };
                return {
                    rust: run((options) => vision.createBoardDetector(wasm, entry.spec, options)),
                    opencv: run((options) => vision.createOpenCvBoardDetector(cv, entry.spec, options)),
                };
            })()""" % json.dumps(entry))
            rust, opencv = result["rust"]["detection"], result["opencv"]["detection"]
            # Rust against opencv.js: the same corners.
            a = {c["id"]: c for c in rust["corners"]}
            b = {c["id"]: c for c in opencv["corners"]}
            self.assertEqual(sorted(a), sorted(b), "%s: corner ids differ from opencv.js" % entry["file"])

            for i in a:
                gaps.append(math.hypot(a[i]["x"] - b[i]["x"], a[i]["y"] - b[i]["y"]))
                self.assertEqual(a[i]["markers"], b[i]["markers"])
                self.assertAlmostEqual(a[i].get("sharpness", 0), b[i].get("sharpness", 0), places=3)

            # ours: types.js convention (pixel corners); the desktop's: OpenCV's (pixel centres)
            ours = {c["id"]: (c["x"] - 0.5, c["y"] - 0.5) for c in rust["corners"]}
            ours_shifted = {c["id"]: (c["x"] - 0.5, c["y"] - 0.5) for c in result["rust"]["shifted"]["corners"]}
            expected = {c["id"]: c for c in entry["expected"]}
            matched = [i for i in expected if i in ours]
            missing = [i for i in expected if i not in ours]
            x0, y0, w, h = entry["crop"]
            inset = fixture["inset_markers"] * entry["marker_px"]
            extra = [i for i, (x, y) in ours.items() if i not in expected
                     and x0 + inset <= x <= x0 + w - inset and y0 + inset <= y <= y0 + h - inset]

            for i in matched:
                e = expected[i]
                d = math.hypot(ours[i][0] - e["x"], ours[i][1] - e["y"])

                if e["sharpness"] >= 50:
                    sharp_diffs.append(d)
                else:
                    blurred_diffs.append((ours[i][0] - e["x"], ours[i][1] - e["y"]))

                    if i in ours_shifted:
                        blurred_shifted.append(math.hypot(ours_shifted[i][0] - e["x"], ours_shifted[i][1] - e["y"]))

            report.append("  %-22s desktop %3d  matched %3d  missing %s  extra (inside crop) %s  recognised %s  m %.3g  (opencv.js %d corners)"
                          % (entry["file"], len(expected), len(matched), missing, extra,
                             rust["recognised"], rust["markerScale"], len(opencv["corners"])))
            self.assertGreaterEqual(len(matched), 0.95 * len(expected), report[-1])

        blurred_norm = [math.hypot(dx, dy) for dx, dy in blurred_diffs]
        mean_dx = sum(dx for dx, _ in blurred_diffs) / max(1, len(blurred_diffs))
        mean_dy = sum(dy for _, dy in blurred_diffs) / max(1, len(blurred_diffs))
        print("\nreal frames, the Rust detector vs opencv.js: %d corners, gap median %.4f, max %.4f px"
              % (len(gaps), percentile(gaps, 0.5), max(gaps)))
        print("real frames vs the desktop pipeline (px, OpenCV convention):")
        print("\n".join(report))
        print("  sharp corners (desktop sharpness >= 50): n %d, median %.3f, 95th %.3f, max %.3f"
              % (len(sharp_diffs), percentile(sharp_diffs, 0.5), percentile(sharp_diffs, 0.95), max(sharp_diffs)))
        print("  blurred corners, ours: n %d, median %.3f, 95th %.3f; mean offset (ours - desktop) (%.3f, %.3f)"
              % (len(blurred_norm), percentile(blurred_norm, 0.5), percentile(blurred_norm, 0.95), mean_dx, mean_dy))
        print("  blurred corners, with desktopHalfPixelShift: n %d, median %.3f, 95th %.3f"
              % (len(blurred_shifted), percentile(blurred_shifted, 0.5), percentile(blurred_shifted, 0.95)))

        self.assertLess(max(gaps), 0.001)
        self.assertGreater(len(sharp_diffs), 20)
        self.assertLess(percentile(sharp_diffs, 0.5), 0.05)

        if len(blurred_diffs) >= 5:
            self.assertLess(abs(mean_dx + 0.5), 0.2)
            self.assertLess(abs(mean_dy + 0.5), 0.2)
            self.assertLess(percentile(blurred_shifted, 0.5), 0.05)

    def test_synthetic_frames_from_480p_to_1080p(self):
        # Setup: the strip board (the phone's default sheet) and the 3 x 3-target board, rendered
        # as in vision_synth.js, seen in perspective at 854 x 480, 1280 x 720 and 1920 x 1080 (the
        # same view scaled, so the markers are 18-40 px), each sharp and with a 1.5 px blur, with
        # noise; a close-up with 2.5 px blur at 720p.
        # Test: detect each with a fresh default Rust detector and opencv.js one, two frames (the
        # first tunes the marker-size factor), at processing scale 1, and at 0.5 for 720p and 1080p.
        # Verifies: every frame is recognised, with the 2-marker corners within 0.4 px median of
        # the truth and no invalid corner returned; the Rust detector's corners are opencv.js's
        # (same ids, within 0.001 px); prints corners found / visible, median and 95th-percentile
        # error per case.
        cases = evaluate(self.chrome, """(async () => {
            const cv = await vision.loadOpenCv();
            const wasm = await vision.loadVision();
            const out = [];
            for (const name of ['charuco_23x17_10mm_strip', 'charuco_23x17_10mm_centre3x3']) {
                const spec = vision.BOARD_SPECS[name];
                const printed = vision.synth.boardImage(cv, spec, { pps: 64 });
                const base = [[230, 110], [1060, 80], [1180, 650], [150, 610]];
                const closeUp = [[-420, -330], [1580, -380], [1760, 1120], [-560, 1060]];
                const run = (label, width, height, quad, blur, scale) => {
                    const { frame, truth } = vision.synth.makeFrame(cv, spec, printed, { width, height, quad, blur, noise: 2, seed: 11 });
                    const image = vision.greyImage(frame);
                    const detector = vision.createBoardDetector(wasm, spec, { processingScale: scale });
                    const reference = vision.createOpenCvBoardDetector(cv, spec, { processingScale: scale });
                    detector.detect(image);
                    reference.detect(frame);
                    const d = detector.detect(image);
                    const o = reference.detect(frame);
                    const errors = d.corners.filter((c) => c.markers === 2).map(({ id, x, y }) => Math.hypot(x - truth(id)[0], y - truth(id)[1])).sort((a, b) => a - b);
                    const all = d.corners.map(({ id, x, y }) => Math.hypot(x - truth(id)[0], y - truth(id)[1])).sort((a, b) => a - b);
                    const visible = vision.synth.visibleIds(spec, truth, width, height, 0.03 * width).filter((id) => !spec.invalid_corner_ids.includes(id)).length;
                    const invalid = d.corners.filter((c) => spec.invalid_corner_ids.includes(c.id)).length;
                    const ref = new Map(o.corners.map((c) => [c.id, c]));
                    const sameIds = d.corners.length === o.corners.length && d.corners.every((c) => ref.has(c.id));
                    const gap = Math.max(0, ...d.corners.filter((c) => ref.has(c.id)).map((c) => Math.hypot(c.x - ref.get(c.id).x, c.y - ref.get(c.id).y)));
                    out.push({ label: `${name.replace('charuco_23x17_10mm_', '')} ${label}`, scale, found: d.corners.length, visible, recognised: d.recognised, invalid,
                               median2: errors[errors.length >> 1], p95all: all[Math.floor(0.95 * (all.length - 1))], markerPx: d.markerPx, sameIds, gap });
                    detector.dispose();
                    reference.dispose();
                    frame.delete();
                };
                for (const [label, width, height] of [['480p', 854, 480], ['720p', 1280, 720], ['1080p', 1920, 1080]]) {
                    const k = width / 1280;
                    const quad = base.map(([x, y]) => [x * k, y * k]);
                    for (const blur of [0, 1.5]) {
                        run(`${label} blur ${blur}`, width, height, quad, blur, 1);
                        if (label !== '480p') run(`${label} blur ${blur}`, width, height, quad, blur, 0.5);
                    }
                }
                run('720p close-up blur 2.5', 1280, 720, closeUp, 2.5, 1);
                run('720p close-up blur 2.5', 1280, 720, closeUp, 2.5, 0.5);
                printed.image.delete();
            }
            return out;
        })()""", timeout=900)
        print("\nsynthetic frames (px, against the truth; gap = largest distance to opencv.js's corner):")

        for case in cases:
            print("  %-34s scale %.1f  corners %3d / %3d visible  recognised %-5s  2-marker median %.3f  all 95th %.3f  markers %.0f px  gap %.4f"
                  % (case["label"], case["scale"], case["found"], case["visible"], case["recognised"],
                     case["median2"], case["p95all"], case["markerPx"] or 0, case["gap"]))

        for case in cases:
            with self.subTest(case=case["label"], scale=case["scale"]):
                self.assertTrue(case["recognised"])
                self.assertEqual(case["invalid"], 0)
                self.assertLess(case["median2"], 0.4)
                self.assertTrue(case["sameIds"])
                self.assertLess(case["gap"], 0.001)

    def test_the_fast_path_is_no_worse_against_the_truth_and_the_desktop(self):
        # The phone's fast path (T-0332, board_detect.js `fast` / FAST_PATH) gives up exact agreement
        # with opencv.js on purpose, so it is judged against the TRUTH instead, and against the
        # desktop on the real frames. Its candidate parts are measured one by one, and only what
        # costs nothing was taken: the missed-marker search scaled to each marker (`local`, with at
        # least 20 markers found); not the fewer threshold windows (`win3`, `win4`) or the skipped
        # second readings of near-duplicates (`noretry`), which lost corners on blurred views.
        # Setup: the strip board at the phone's processing size, 960 x 540: a whole-board view
        # (markers ~18 px), the same further away (~11 px), a steep view (the far side small), and a
        # close-up (~47 px), each sharp, with a 1.2 px and a 2 px blur, with noise. The real fixture
        # frames as in the test above. Variants: exact (the default), the fast path, each part
        # alone, and exact and fast searching only a region round the board's middle (the phone's
        # region: the corners within 6 squares of the centre, padded by 1.5 squares).
        # Test: detect each frame twice per variant (the first tunes the marker-size factor).
        # Verifies, for the fast path and the fast path in a region: on the synthetic frames at
        # least 97% as many corners as exact (inside the region, for the region), no frame
        # unrecognised that exact recognises (the region: that exact recognises in the same
        # region -- what is not in it cannot be found there, and the page then searches the whole
        # frame), and on the corners both found the median and 95th-percentile errors against the
        # truth no more than 0.02 px and 0.1 px worse; on the real frames at least 95% of the
        # desktop's corners matched and the sharp corners' median distance to the desktop's within
        # 0.02 px of exact's. Prints every number, the parts' too.
        result = evaluate(self.chrome, """(async () => {
            const cv = await vision.loadOpenCv();
            const wasm = await vision.loadVision();
            const spec = vision.BOARD_SPECS.charuco_23x17_10mm_strip;
            const printed = vision.synth.boardImage(cv, spec, { pps: 64 });
            const k = 0.75;
            const base = [[230, 110], [1060, 80], [1180, 650], [150, 610]].map(([x, y]) => [x * k, y * k]);
            const shrink = (quad, f) => {
                const cx = quad.reduce((s, p) => s + p[0], 0) / 4;
                const cy = quad.reduce((s, p) => s + p[1], 0) / 4;
                return quad.map(([x, y]) => [cx + f * (x - cx), cy + f * (y - cy)]);
            };
            const views = {
                whole: base,
                far: shrink(base, 0.62),
                steep: [[330, 120], [640, 115], [930, 520], [40, 525]],
                close: [[-420, -330], [1580, -380], [1760, 1120], [-560, 1060]].map(([x, y]) => [x * k, y * k]),
            };
            // The fast path as chosen (board_detect.js FAST_PATH), with and without a region, and
            // each of its parts alone, to show what each costs and saves.
            const variants = {
                exact: { options: {}, region: false },
                fast: { options: { fast: true }, region: false },
                fastregion: { options: { fast: true }, region: true },
                noretry: { options: { fast: { retryClose: false } }, region: false },
                local: { options: { fast: { localRefine: true } }, region: false },
                win3: { options: { fast: { windows: 3 } }, region: false },
                win4: { options: { fast: { windows: 4 } }, region: false },
                exactregion: { options: {}, region: true },
            };
            const perRow = spec.squares_x - 1;
            const cases = [];
            for (const [view, quad] of Object.entries(views)) {
                for (const blur of [0, 1.2, 2]) {
                    const { frame, truth } = vision.synth.makeFrame(cv, spec, printed, { width: 960, height: 540, quad, blur, noise: 2, seed: 5 });
                    const image = vision.greyImage(frame);
                    frame.delete();
                    // The region: the corners within 6 squares of the board's middle, padded.
                    const middle = [];
                    for (let id = 0; id < perRow * (spec.squares_y - 1); id += 1) {
                        const c = id % perRow + 1, r = Math.floor(id / perRow) + 1;
                        if (Math.abs(c - spec.squares_x / 2) <= 6 && Math.abs(r - spec.squares_y / 2) <= 6) middle.push(truth(id));
                    }
                    const inFrame = middle.filter(([x, y]) => x >= 0 && y >= 0 && x <= 960 && y <= 540);
                    const xs = inFrame.map((p) => p[0]), ys = inFrame.map((p) => p[1]);
                    const square = Math.hypot(truth(1)[0] - truth(0)[0], truth(1)[1] - truth(0)[1]);
                    const pad = 1.5 * square;
                    const roi = inFrame.length ? { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
                        width: Math.max(...xs) - Math.min(...xs) + 2 * pad, height: Math.max(...ys) - Math.min(...ys) + 2 * pad } : null;
                    const inRoi = ([x, y]) => roi && x >= roi.x && y >= roi.y && x <= roi.x + roi.width && y <= roi.y + roi.height;
                    const out = { view, blur };
                    for (const [name, variant] of Object.entries(variants)) {
                        const detector = vision.createBoardDetector(wasm, spec, variant.options);
                        const how = variant.region ? { roi } : {};
                        detector.detect(image, undefined, how);
                        const d = detector.detect(image, undefined, how);
                        detector.dispose();
                        out[name] = {
                            recognised: d.recognised,
                            corners: d.corners.map(({ id, x, y }) => ({ id, err: Math.hypot(x - truth(id)[0], y - truth(id)[1]), inRoi: !!inRoi(truth(id)) })),
                            markerPx: d.markerPx, stats: d.stats,
                        };
                    }
                    cases.push(out);
                }
            }
            printed.image.delete();
            return cases;
        })()""", timeout=1200)
        variants = ("exact", "fast", "fastregion", "noretry", "local", "win3", "win4", "exactregion")
        totals = {}
        print("\nfast path vs exact on synthetic 960 x 540 strip-board frames (corners found / median / 95th error vs truth, px; reads):")

        for case in result:
            line = "  %-6s blur %.1f" % (case["view"], case["blur"])

            for name in variants:
                v = case[name]
                errs = sorted(c["err"] for c in v["corners"])
                line += "  | %s %3d %.3f %.3f r%s" % (name, len(errs), percentile(errs, 0.5), percentile(errs, 0.95), (v.get("stats") or ["-"] * 4)[2])

            print(line + "  (markers %.0f px)" % (case["exact"].get("markerPx") or 0))

        for name in variants:
            region = name.endswith("region")
            pick = (lambda c: c["inRoi"]) if region else (lambda c: True)
            errs = sorted(c["err"] for case in result for c in case[name]["corners"] if pick(c))
            reference = sorted(c["err"] for case in result for c in case["exact"]["corners"] if pick(c))
            # The errors on the corners BOTH found (a variant that finds more, harder corners would
            # otherwise look worse for finding them), and on the extra ones apart.
            shared, shared_ref, extra = [], [], []

            for case in result:
                ref = {c["id"]: c["err"] for c in case["exact"]["corners"] if pick(c)}

                for c in case[name]["corners"]:
                    if not pick(c):
                        continue

                    if c["id"] in ref:
                        shared.append(c["err"])
                        shared_ref.append(ref[c["id"]])
                    else:
                        extra.append(c["err"])

            # A region's frames are judged against the exact path with the same region (what is not
            # in the region cannot be found in it; the page searches the whole frame after a miss).
            base = "exactregion" if region else "exact"
            totals[name] = {"found": len(errs), "reference": len(reference), "median": percentile(shared, 0.5), "p95": percentile(shared, 0.95),
                            "refMedian": percentile(shared_ref, 0.5), "refP95": percentile(shared_ref, 0.95),
                            "lostRecognised": sum(1 for case in result if case[base]["recognised"] and not case[name]["recognised"])}
            print("  %-12s corners %4d (exact %4d%s); on the %d both found: median %.3f (exact %.3f), 95th %.3f (exact %.3f); %d extra: median %.3f; "
                  "frames no longer recognised %d (against %s)"
                  % (name, len(errs), len(reference), ", inside the region" if region else "", len(shared), totals[name]["median"],
                     totals[name]["refMedian"], totals[name]["p95"], totals[name]["refP95"], len(extra), percentile(extra, 0.5),
                     totals[name]["lostRecognised"], base))

        # The real frames: the desktop's corners.
        fixture = json.load(open(os.path.join(FIXTURE_DIR, "fixture.json")))
        real_variants = ("exact", "fast", "noretry", "local", "win3", "win4")
        real = {name: {"matched": 0, "expected": 0, "sharp": []} for name in real_variants}

        for entry in fixture["frames"]:
            got = evaluate(self.chrome, """(async () => {
                const entry = %s;
                const image = await vision.fixtureFrame(entry, '/tests/fixtures/charuco_real/');
                const wasm = await vision.loadVision();
                const out = {};
                for (const [name, options] of Object.entries({ exact: {}, fast: { fast: true }, noretry: { fast: { retryClose: false } },
                        local: { fast: { localRefine: true } }, win3: { fast: { windows: 3 } }, win4: { fast: { windows: 4 } } })) {
                    const detector = vision.createBoardDetector(wasm, entry.spec, options);
                    detector.detect(image);
                    out[name] = detector.detect(image).corners;
                    detector.dispose();
                }
                return out;
            })()""" % json.dumps(entry))
            expected = {c["id"]: c for c in entry["expected"]}

            for name, corners in got.items():
                ours = {c["id"]: (c["x"] - 0.5, c["y"] - 0.5) for c in corners}
                real[name]["expected"] += len(expected)
                real[name]["matched"] += sum(1 for i in expected if i in ours)
                real[name]["sharp"] += [math.hypot(ours[i][0] - e["x"], ours[i][1] - e["y"]) for i, e in expected.items() if i in ours and e["sharpness"] >= 50]

        for name, r in real.items():
            print("  real frames %-6s desktop corners matched %d of %d, sharp corners' median distance to the desktop %.3f px (n %d)"
                  % (name, r["matched"], r["expected"], percentile(r["sharp"], 0.5), len(r["sharp"])))

        for name in ("fast", "fastregion"):
            with self.subTest(variant=name):
                t = totals[name]
                self.assertGreaterEqual(t["found"], 0.97 * t["reference"])
                self.assertEqual(t["lostRecognised"], 0)
                self.assertLessEqual(t["median"], t["refMedian"] + 0.02)
                self.assertLessEqual(t["p95"], t["refP95"] + 0.1)

        for name in ("fast",):
            with self.subTest(real=name):
                self.assertGreaterEqual(real[name]["matched"], 0.95 * real[name]["expected"])
                self.assertLessEqual(percentile(real[name]["sharp"], 0.5), percentile(real["exact"]["sharp"], 0.5) + 0.02)

    def test_no_memory_growth_over_200_frames(self):
        # Setup: one Rust detector; three kinds of frame at 720p: the board (blurred, with noise),
        # an empty table, and the board as RGBA ImageData; and a Rust QR reader.
        # Test: 10 warm-up frames, then read the module's WebAssembly memory size; 200 more frames
        # (board, empty and ImageData in turn, and a QR read of each board frame); read it again;
        # dispose both.
        # Verifies: the memory has not grown over the 200 frames (it only ever grows, so any
        # per-frame leak would show here within 200 frames).
        result = evaluate(self.chrome, """(async () => {
            const cv = await vision.loadOpenCv();
            const wasm = await vision.loadVision();
            const spec = vision.BOARD_SPECS.charuco_23x17_10mm_strip;
            const printed = vision.synth.boardImage(cv, spec, { pps: 48 });
            const view = vision.synth.makeFrame(cv, spec, printed, { width: 1280, height: 720, quad: [[230, 110], [1060, 80], [1180, 650], [150, 610]], blur: 1.2, noise: 2 });
            const grey = vision.greyImage(view.frame);
            const empty = { data: new Uint8Array(1280 * 720).fill(70), width: 1280, height: 720 };
            const rgba = new Uint8ClampedArray(1280 * 720 * 4);
            grey.data.forEach((v, i) => { rgba[4 * i] = v; rgba[4 * i + 1] = v; rgba[4 * i + 2] = v; rgba[4 * i + 3] = 255; });
            const imageData = new ImageData(rgba, 1280, 720);
            const detector = vision.createBoardDetector(wasm, spec);
            const qr = vision.createQrDetector(wasm, { processingScale: 0.5 });
            const frames = [grey, empty, imageData];
            const step = (k) => { detector.detect(frames[k % 3]); if (k % 3 === 0) qr.detect(grey); };
            for (let k = 0; k < 10; k += 1) step(k);
            const before = vision.visionMemoryBytes(wasm);
            const started = performance.now();
            for (let k = 0; k < 200; k += 1) step(k);
            const seconds = (performance.now() - started) / 1000;
            const after = vision.visionMemoryBytes(wasm);
            detector.dispose();
            qr.dispose();
            view.frame.delete();
            printed.image.delete();
            return { before, after, seconds };
        })()""", timeout=900)
        print("\nvision module memory: %d bytes before 200 frames, %d after (%.1f s)" % (result["before"], result["after"], result["seconds"]))
        self.assertEqual(result["after"], result["before"])

    def test_a_qr_code_like_the_studios_is_read_in_chrome(self):
        # Setup: a scan link like the studio's, encoded by scan_qr.js (uqr, ECC M, quiet zone 4),
        # drawn at 7 px per module on a canvas, as RGBA ImageData; and the same scaled down to 4
        # px per module with a little blur, read at processing scale 1.
        # Test: the Rust reader (createQrDetector over the vision module) on each.
        # Verifies: the text comes back byte for byte both times, with 4 corners each.
        text = "https://houseki.app/scanner/#v=1&r=00112233445566778899aabbccddeeff&p=ffeeddccbbaa99887766554433221100"
        results = evaluate(self.chrome, """(async () => {
            const wasm = await vision.loadVision();
            const text = %s;
            const { size, modules } = vision.qrCode(text);
            const out = [];
            for (const [module, blur] of [[7, 0], [4, 0.8]]) {
                const canvas = new OffscreenCanvas(size * module + 200, size * module + 120);
                const g = canvas.getContext('2d');
                g.fillStyle = '#777'; g.fillRect(0, 0, canvas.width, canvas.height);
                g.fillStyle = '#fff'; g.fillRect(100, 60, size * module, size * module);
                g.fillStyle = '#000';
                modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) g.fillRect(100 + x * module, 60 + y * module, module, module); }));
                if (blur) { g.filter = `blur(${blur}px)`; g.drawImage(canvas, 0, 0); }
                const image = g.getImageData(0, 0, canvas.width, canvas.height);
                const reader = vision.createQrDetector(wasm);
                out.push(reader.detect(image));
                reader.dispose();
            }
            return out;
        })()""" % json.dumps(text))

        for found in results:
            self.assertEqual([f["text"] for f in found], [text])
            self.assertEqual(len(found[0]["corners"]), 4)


@unittest.skipIf(SKIP, "needs headless Chrome, websocket-client and a built vision module: %s" % SKIP)
@unittest.skipUnless(os.environ.get("GEM_VISION_TIMING"), "timing is opt-in: GEM_VISION_TIMING=1, through tools/gpu_queue.py")
class VisionTimingTest(unittest.TestCase):
    """ms per frame in headless Chrome on this machine, the Rust detector against opencv.js. Only
    meaningful without contention, so it is opt-in and run through the queue; it asserts nothing
    about speed, only prints."""

    @classmethod
    def setUpClass(cls):
        open_page(cls)

    @classmethod
    def tearDownClass(cls):
        close_page(cls)

    def test_ms_per_frame(self):
        # Setup: both modules loaded (their load times printed); for 720p and 1080p, a synthetic
        # overview of the whole strip board (small markers), a synthetic close-up (large markers,
        # blurred), and the real quartz and spinel fixture frames resized to that resolution; the
        # live pipeline's frame, a 960 x 540 whole-board view; a 720p QR code.
        # Test: per case, detector and processing scale (1, 0.5): 3 warm-up frames, then 15 timed
        # frames with the same detector (grey input for both, so the comparison is the detection
        # alone); the 960 x 540 view also as RGBA, as the phone hands it over.
        # Verifies: nothing; prints the median and the slowest of the 15 per case.
        fixture = json.load(open(os.path.join(FIXTURE_DIR, "fixture.json")))
        real = [entry for entry in fixture["frames"] if (entry["capture"], entry["index"]) in (("quartz", 433), ("spinel", 1555))]
        rows = evaluate(self.chrome, """(async () => {
            const cv = await vision.loadOpenCv();
            const wasm = await vision.loadVision();
            const fixtures = %s;
            const spec = vision.BOARD_SPECS.charuco_23x17_10mm_strip;
            const printed = vision.synth.boardImage(cv, spec, { pps: 64 });
            const rows = [];
            const time = (label, make, frame, scales = [1, 0.5]) => {
                for (const scale of scales) {
                    const detector = make(scale);
                    for (let k = 0; k < 3; k += 1) detector.detect(frame);
                    const ms = [];
                    let found = 0;
                    for (let k = 0; k < 15; k += 1) {
                        const started = performance.now();
                        const d = detector.detect(frame);
                        ms.push(performance.now() - started);
                        found = d.corners ? d.corners.length : d.length;
                    }
                    ms.sort((a, b) => a - b);
                    rows.push({ label, scale, median: ms[7], max: ms[14], found });
                    detector.dispose();
                }
            };
            const both = (label, specOf, mat, scales) => {
                time(`${label}, rust`, (s) => vision.createBoardDetector(wasm, specOf, { processingScale: s }), vision.greyImage(mat), scales);
                time(`${label}, opencv.js`, (s) => vision.createOpenCvBoardDetector(cv, specOf, { processingScale: s }), mat, scales);
            };
            for (const [name, width, height] of [['720p', 1280, 720], ['1080p', 1920, 1080]]) {
                const k = width / 1280;
                const overview = vision.synth.makeFrame(cv, spec, printed, { width, height, quad: [[230, 110], [1060, 80], [1180, 650], [150, 610]].map(([x, y]) => [x * k, y * k]), noise: 2 });
                both(`${name} synthetic overview`, spec, overview.frame);
                overview.frame.delete();
                const close = vision.synth.makeFrame(cv, spec, printed, { width, height, quad: [[-420, -330], [1580, -380], [1760, 1120], [-560, 1060]].map(([x, y]) => [x * k, y * k]), blur: 2 * k, noise: 2 });
                both(`${name} synthetic close-up`, spec, close.frame);
                close.frame.delete();
                for (const entry of fixtures) {
                    const image = await vision.fixtureFrame(entry, '/tests/fixtures/charuco_real/');
                    const full = new cv.Mat(image.height, image.width, cv.CV_8UC4);
                    full.data.set(image.data);
                    const grey = new cv.Mat();
                    cv.cvtColor(full, grey, cv.COLOR_RGBA2GRAY);
                    const portrait = image.height > image.width;
                    const size = portrait ? new cv.Size(height, width) : new cv.Size(width, height);
                    const resized = new cv.Mat();
                    cv.resize(grey, resized, size, 0, 0, cv.INTER_AREA);
                    both(`${name} real ${entry.capture} ${entry.index}`, entry.spec, resized);
                    for (const mat of [full, grey, resized]) mat.delete();
                }
            }
            // The live pipeline's frame: the whole board in a 960 x 540 copy (vision.js reads a
            // 720p camera at 0.75), as grey and as the RGBA ImageData the page hands over.
            const live = vision.synth.makeFrame(cv, spec, printed, { width: 960, height: 540, quad: [[230, 110], [1060, 80], [1180, 650], [150, 610]].map(([x, y]) => [x * 0.75, y * 0.75]), blur: 1, noise: 2 });
            both('960x540 whole board (live)', spec, live.frame, [1]);
            const rgba = new cv.Mat();
            cv.cvtColor(live.frame, rgba, cv.COLOR_GRAY2RGBA);
            const liveImage = new ImageData(new Uint8ClampedArray(rgba.data), 960, 540);
            time('960x540 whole board (live), RGBA, rust', (s) => vision.createBoardDetector(wasm, spec, { processingScale: s }), liveImage, [1]);
            time('960x540 whole board (live), RGBA, opencv.js', (s) => vision.createOpenCvBoardDetector(cv, spec, { processingScale: s }), liveImage, [1]);
            rgba.delete();
            live.frame.delete();
            const { size, modules } = vision.qrCode('https://houseki.app/scanner/#v=1&r=00112233445566778899aabbccddeeff&p=ffeeddccbbaa99887766554433221100');
            const qr = new cv.Mat(720, 1280, cv.CV_8UC1, new cv.Scalar(110));
            modules.forEach((row, y) => row.forEach((dark, x) => cv.rectangle(qr, new cv.Point(400 + 8 * x, 150 + 8 * y), new cv.Point(407 + 8 * x, 157 + 8 * y), new cv.Scalar(dark ? 20 : 240), -1)));
            time('720p QR code (multi), rust', (s) => vision.createQrDetector(wasm, { processingScale: s }), vision.greyImage(qr));
            time('720p QR code (multi), opencv.js', (s) => vision.createOpenCvQrDetector(cv, { processingScale: s }), qr);
            qr.delete();
            printed.image.delete();
            return rows;
        })()""" % json.dumps(real), timeout=1800)
        print("\nload (script added -> ready), over HTTP from localhost: vision module %.0f ms, opencv.js %.0f ms"
              % (self.vision_load_ms, self.load_ms))
        print("ms per frame, headless Chrome, %s:" % time.strftime("%Y-%m-%d %H:%M"))

        for row in rows:
            print("  %-46s scale %.1f  median %6.1f ms  max %6.1f ms  (%d found)"
                  % (row["label"], row["scale"], row["median"], row["max"], row["found"]))


if __name__ == "__main__":
    unittest.main()
