"""Timings of the phone's vision on live frames (T-0326), for the KB and the hand-back.

Runs the built phone page in a native headless Chrome (Apple silicon, real GPU) with its camera
playing the synthetic board video (make_scan_video.py), connected to the studio in a second
Chrome over the local relay, and reports for SECONDS of steady state:

  * the phone page's per-stage times (housekiScanVision.timings(): bitmap copy, grab, detect,
    board check (fitMs, T-0335), pose, intrinsics, outline, whole frame), where it ran (Worker or page), its
    processing scale and outline cadence, OpenCV's load and the warm-up;
  * the CPU the phone browser used (ps %CPU summed over its processes, sampled every 2 s);
  * the vision messages the studio took: rate and size;
  * the studio's received video frame rate, with the vision running and with it off (the phone
    page served without opencv.js, as test_scan_vision.py's NoOpenCvServer does).

Timing runs go through the GPU queue, one at a time (AGENTS.md):

    tools/gpu_queue.py run --as <agent> --label "timing: phone vision" -- \\
        ~/.pyenv/versions/anaconda3-2019.07/bin/python3 tests/harness/vision/time_scan_vision.py
"""

import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.dirname(HERE)
sys.path.insert(0, HARNESS)
sys.path.insert(0, HERE)

import cdp  # noqa: E402
from make_scan_video import ensure_video  # noqa: E402
from test_scan_link import CHROME_ARGS, Relay, Server  # noqa: E402
from test_scan_vision import NoOpenCvServer  # noqa: E402
from test_vision_detect import native_chrome  # noqa: E402

SECONDS = 20


def cpu_of(chrome):
    """%CPU (ps) summed over the processes of one cdp.Chrome (its user-data-dir is on every
    process's command line)."""
    out = subprocess.run(["ps", "-A", "-o", "%cpu=,command="], capture_output=True, text=True).stdout
    return sum(float(line.split(None, 1)[0]) for line in out.splitlines() if chrome.user_data_dir in line)


def received_fps(studio, seconds=4):
    return studio.send("Runtime.evaluate", {"expression": """new Promise(done => {
      const video = document.getElementById('scan-video');
      let n = 0; const start = performance.now();
      const tick = () => { n += 1; if (performance.now() - start < %d) video.requestVideoFrameCallback(tick); else done(n / ((performance.now() - start) / 1000)); };
      video.requestVideoFrameCallback(tick);
    })""" % (seconds * 1000), "awaitPromise": True, "returnByValue": True}, timeout=60)["result"]["value"]


def click(studio, selector):
    """A real mouse click (the menus open on pointer events, not on element.click())."""
    box = studio.evaluate("(() => { const r = document.querySelector(%s).getBoundingClientRect();"
                          " return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()" % json.dumps(selector))
    studio.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": box["x"], "y": box["y"], "button": "none"})

    for kind in ("mousePressed", "mouseReleased"):
        studio.send("Input.dispatchMouseEvent", {"type": kind, "x": box["x"], "y": box["y"], "button": "left", "clickCount": 1})


def session(studio, phone, origin):
    """Opens Rough scan in the studio and the link on the phone at `origin`; waits for the
    studio's video."""
    click(studio, "#menu-button-tools")
    studio.wait_for_expression("!!document.getElementById('menu-item-rough-scan')", timeout=10)
    click(studio, "#menu-item-rough-scan")
    studio.wait_for_expression("!!document.getElementById('scan-url')", timeout=20)
    link = studio.evaluate("document.getElementById('scan-url').textContent.trim()")
    phone.navigate(origin + "/scanner/#" + link.split("#", 1)[1])
    studio.wait_for_expression("document.getElementById('scan-video')?.videoWidth > 0", timeout=60)


def close_mode(studio):
    for kind in ("keyDown", "keyUp"):
        studio.send("Input.dispatchKeyEvent", {"type": kind, "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})

    studio.wait_for_expression("!document.getElementById('scan-view')", timeout=10)


def main():
    video = ensure_video()
    server = Server()
    relay = Relay()
    studio = cdp.Chrome(gl_backend="metal", extra_args=CHROME_ARGS, timeout=60)
    report = {}

    try:
        studio.navigate(server.origin + "/studio.html", timeout=120)
        studio.evaluate("localStorage.setItem('gems.scanRelayUrls', %s), true" % json.dumps(json.dumps([relay.url])))
        studio.navigate("about:blank")
        studio.navigate(server.origin + "/studio.html", timeout=120)
        studio.wait_for_expression("!!window.gemApp", timeout=120)
        args = tuple(list(CHROME_ARGS) + ["--use-file-for-fake-video-capture=%s" % video["mjpeg"]])

        # With the vision.
        phone = native_chrome(gl_backend="metal", extra_args=args, timeout=60)

        try:
            session(studio, phone, server.origin)
            phone.wait_for_expression("document.getElementById('scanner-vision')?.dataset.state === 'pose'", timeout=120)
            time.sleep(5)  # past the first JIT stalls
            phone.evaluate("housekiScanVision.state.processed0 = housekiScanVision.state.processed, true")
            studio.evaluate("""(() => { window.__n = 0; window.__bytes = 0; let last = null;
              window.__timer = setInterval(() => { const v = window.gemScanVision();
                if (v && v !== last) { last = v; window.__n += 1; window.__bytes += JSON.stringify(v.message).length; } }, 10); })(), true""")
            cpu = []
            started = time.time()

            while time.time() - started < SECONDS:
                time.sleep(2)
                cpu.append(cpu_of(phone))

            elapsed = time.time() - started
            counts = studio.evaluate("({ n: window.__n, bytes: window.__bytes })")
            state = json.loads(phone.evaluate("JSON.stringify(housekiScanVision.state, (k, v) => k === 'last' ? undefined : v)"))
            report["vision"] = {
                "thread": state["thread"], "scale": state["scale"], "outlineEvery": state["outlineEvery"],
                "loadMs": state["loadMs"], "warmMs": state["warmMs"], "frameSource": state["frameSource"],
                "processedPerS": round((state["processed"] - state["processed0"]) / elapsed, 2),
                "timings": phone.evaluate("housekiScanVision.timings()"),
                "phoneCpuPercent": {"samples": cpu, "mean": round(sum(cpu) / len(cpu), 1)},
                "messagesPerS": round(counts["n"] / elapsed, 2),
                "messageBytesMean": round(counts["bytes"] / max(1, counts["n"])),
                "studioVideoFps": round(received_fps(studio), 1),
            }
            close_mode(studio)
        finally:
            phone.close()

        # Without it (the same page, opencv.js not found: nothing but the camera and the overlay).
        no_opencv = NoOpenCvServer()
        phone = native_chrome(gl_backend="metal", extra_args=args, timeout=60)

        try:
            session(studio, phone, no_opencv.origin)
            phone.wait_for_expression("document.getElementById('scanner-vision')?.dataset.state === 'error'", timeout=60)
            time.sleep(5)
            cpu = []

            for _ in range(5):
                time.sleep(2)
                cpu.append(cpu_of(phone))

            report["noVision"] = {"phoneCpuPercent": {"samples": cpu, "mean": round(sum(cpu) / len(cpu), 1)},
                                  "studioVideoFps": round(received_fps(studio), 1)}
            close_mode(studio)
        finally:
            phone.close()
            no_opencv.close()
    finally:
        studio.close()
        relay.close()
        server.close()

    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
