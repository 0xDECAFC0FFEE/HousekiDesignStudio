"""The Rough scan page's screenshots (src/site/docs/rough-scan.html), with a phone (T-0326).

docs_screenshot.Studio opens the studio from file://, where a phone link points at the public
site; these pictures need a real phone session, so (as kb/rough-scan-mode-* describes for the
disconnect notice) the studio is served over HTTP with the local test relay saved, and the phone is
a second, native Chrome emulating a phone held sideways, its camera playing the synthetic video of
a rock on the board (make_scan_video.py). The Studio helper's clicking and WebP capture are reused
on both.

    ./build.sh   # or: python3 src/scripts/make_page.py --skip-build
    ~/.pyenv/versions/anaconda3-2019.07/bin/python3 tests/harness/vision/docs_scan_shots.py

Writes overview.webp and panel.webp (waiting for a phone), phone.webp (the phone's screen),
live.webp (the studio with the phone's picture and what it found) and readout.webp (the What the
phone sees card) into src/site/docs/images/rough-scan/. Look at each before committing.

Since T-0331 the phone plays the scan guidance's video (make_scan_video.GUIDE_CONFIG: the
white/black spiral board since T-0340; a slow orbit, a fast swing, a defocused hold), so the
pictures show the found corners, the rock and the next step; it also writes phone-fast.webp ("Moving
too fast") and phone-focus.webp ("Rock not in focus"), each taken when the phone itself shows that
state.

Since T-0332 it also writes phone-speed.webp: the phone's speed line, opened as a person opens it
(a long press on the status lines at the bottom), cropped to the lines. Names given on the command
line (e.g. `readout live phone-speed`) retake only those pictures.

Since T-0337 the scanner is a page in an iframe over the studio, and from file:// that page was the
published site's (cross-origin, and the deployed version; since T-0344 it is the build's own, but
still on another origin than the studio and with a link to the public phone page, which a session
in these pictures cannot use). So every picture comes from one session
served locally under the name houseki.app: both Chromes map houseki.app to a local HTTPS server
(--host-resolver-rules; .app names are HSTS-preloaded, so it must be HTTPS, here with a throwaway
self-signed certificate made by openssl that the Chromes are told to accept), so the scanner's
title says houseki.app and the link under the code reads as the site's. The scanner's elements are read through scanner_frame.ScannerFrame (T-0340).

(T-0335's phone-wrong-board.webp is no longer taken: since T-0340 the older boards' markers are
not read at all, and the phone says nothing about another board.)
"""

import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.dirname(HERE)
PROJECT_ROOT = os.path.dirname(os.path.dirname(HARNESS))
IMAGES = os.path.join(PROJECT_ROOT, "src", "site", "docs", "images", "rough-scan")

sys.path.insert(0, HARNESS)
sys.path.insert(0, HERE)

import cdp  # noqa: E402
from docs_screenshot import Studio  # noqa: E402
from make_scan_video import ensure_guide_video  # noqa: E402
from test_scan_link import CHROME_ARGS, Relay, Server  # noqa: E402
from test_vision_detect import native_chrome  # noqa: E402
from scanner_frame import ScannerFrame  # noqa: E402

# The name the local build is served under in both Chromes (see the module's docstring).
HOST = "houseki.app"


def https_server():
    """test_scan_link's Server (build/www), wrapped in TLS with a fresh self-signed certificate
    for HOST (made with openssl in a temporary directory)."""
    import ssl
    import subprocess
    import tempfile

    server = Server()
    folder = tempfile.mkdtemp()
    key, cert = os.path.join(folder, "key.pem"), os.path.join(folder, "cert.pem")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=" + HOST,
                    "-keyout", key, "-out", cert], check=True, capture_output=True)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.httpd.socket = context.wrap_socket(server.httpd.socket, server_side=True)
    return server


def host_args(server):
    """Chrome flags mapping HOST to the local server and accepting its certificate."""
    port = server.origin.rsplit(":", 1)[1]
    return ["--host-resolver-rules=MAP %s 127.0.0.1:%s" % (HOST, port), "--ignore-certificate-errors"]

# A phone held sideways (an iPhone's landscape CSS size), at 2x.
PHONE = {"width": 844, "height": 390, "deviceScaleFactor": 2, "mobile": True}

# The pictures to (re)take: those named on the command line, or all.
ONLY = set(sys.argv[1:])


def take(shooter, name, **kwargs):
    """shooter.shot into IMAGES/<name>.webp, unless the command line names others."""
    if not ONLY or name in ONLY:
        shooter.shot(os.path.join(IMAGES, name + ".webp"), **kwargs)


def long_press(chrome, selector, ms=800):
    """A real press held `ms` on the middle of an element (CDP mouse input: the page's pointer
    events see it as a person's press)."""
    box = chrome.evaluate("(() => { const r = document.querySelector(%s).getBoundingClientRect();"
                          " return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()" % json.dumps(selector))
    chrome.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": box["x"], "y": box["y"], "button": "none"})
    chrome.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": box["x"], "y": box["y"], "button": "left", "clickCount": 1})
    time.sleep(ms / 1000.0)
    chrome.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": box["x"], "y": box["y"], "button": "left", "clickCount": 1})


def attach(chrome, width, height, scale):
    """A docs_screenshot.Studio driving an already-started Chrome (its clicks, settle, shot)."""
    studio = Studio.__new__(Studio)
    studio.chrome = chrome
    chrome.send("Emulation.setDeviceMetricsOverride", {"width": width, "height": height, "deviceScaleFactor": scale, "mobile": False})
    return studio


def phone_shot_for(phone):
    """A docs_screenshot.Studio driving the phone's Chrome (its shot)."""
    shooter = Studio.__new__(Studio)
    shooter.chrome = phone
    return shooter


def scanner_shot(studio, scanner, name, selector, padding=6):
    """take() of one element of the scan page, clipped by its box in the tab."""
    box = scanner.box(selector)
    take(studio, name, clip={"x": max(0, box["x"] - padding), "y": max(0, box["y"] - padding),
                             "width": box["width"] + 2 * padding, "height": box["height"] + 2 * padding})


def main():
    video = ensure_guide_video()
    server = https_server()
    relay = Relay()
    origin = "https://%s" % HOST
    studio_chrome = cdp.Chrome(gl_backend="metal", extra_args=tuple(list(CHROME_ARGS) + host_args(server)), timeout=60)
    phone = None

    try:
        studio = attach(studio_chrome, 1440, 900, 2)
        scanner = ScannerFrame(studio_chrome)

        # Waiting for a phone, before the test relay is set (it would show in the link): the whole
        # window, and the scanner's left-hand side.
        if not ONLY or ONLY & {"overview", "panel"}:
            studio_chrome.navigate(origin + "/studio.html", timeout=120)
            studio_chrome.wait_for_expression("!!window.gemApp", timeout=120)
            studio.settle(frames=20)
            studio.click("#menu-button-tools")
            studio.click("#menu-item-rough-scan")
            scanner.wait_for_expression("!!document.getElementById('scan-qr')", timeout=30)
            studio.settle(frames=10)
            take(studio, "overview")
            scanner_shot(studio, scanner, "panel", "#scan-panel", padding=0)

        studio_chrome.navigate(origin + "/studio.html", timeout=120)
        studio_chrome.evaluate("localStorage.setItem('gems.scanRelayUrls', %s), true" % json.dumps(json.dumps([relay.url])))
        studio_chrome.navigate("about:blank")
        studio_chrome.navigate(origin + "/studio.html", timeout=120)
        studio_chrome.wait_for_expression("!!window.gemApp", timeout=120)
        studio.settle(frames=20)
        studio.click("#menu-button-tools")
        studio.click("#menu-item-rough-scan")
        scanner.wait_for_expression("!!document.getElementById('scan-qr')", timeout=30)
        link = scanner.evaluate("document.getElementById('scan-url').textContent.trim()")

        phone = native_chrome(gl_backend="metal", extra_args=tuple(list(CHROME_ARGS) + host_args(server) + [
            "--use-file-for-fake-video-capture=%s" % video["mjpeg"]]), timeout=60)
        phone.send("Emulation.setDeviceMetricsOverride", PHONE)
        # The connection picture while the phone looks for its computer (T-0342): the link with
        # another room id, which no computer hosts, so the phone stays at "Looking for your
        # computer…" with the servers up.
        if not ONLY or "phone-connecting" in ONLY:
            import random
            import re
            alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
            nobody = re.sub(r"r=[^&]+", "r=" + "".join(random.choice(alphabet) for _ in range(22)), link, count=1)
            phone.navigate(nobody)
            phone.wait_for_expression("document.getElementById('scanner-status')?.dataset.phase === 'waiting'", timeout=60)
            time.sleep(1.2)
            take(phone_shot_for(phone), "phone-connecting")
            phone.navigate("about:blank")

        phone.navigate(link)
        phone.wait_for_expression("document.getElementById('scanner-status')?.dataset.status === 'connected'", timeout=60)
        phone_shot = Studio.__new__(Studio)
        phone_shot.chrome = phone
        state = "window.housekiScanVision?.state"
        # The fast swing, then the defocused hold, each as the phone shows its warning.
        phone.wait_for_expression("%s?.warning === 'fast'" % state, timeout=120)
        take(phone_shot, "phone-fast")
        phone.wait_for_expression("%s?.warning === 'focus'" % state, timeout=90)
        take(phone_shot, "phone-focus")
        # Then the slow orbit of the next loop: a pose, no warning, the rock outlined, the camera
        # 25-50 degrees up.
        phone.wait_for_expression(
            "%s?.phase === 'pose' && !%s.warning"
            " && Math.abs((housekiScanVision.state.last?.guide?.view?.elevationDeg ?? 0) - 37) < 12"
            " && document.getElementById('scanner-vision').textContent.includes('Rock outlined')" % ((state,) * 2), timeout=180)
        take(phone_shot, "phone")
        # The speed line (T-0332): a long press on the status lines shows it; its numbers are
        # rewritten twice a second, so give it a moment to fill.
        long_press(phone, "#scanner-status")
        phone.wait_for_expression("!document.getElementById('scanner-diag').hidden"
                                  " && document.getElementById('scanner-diag').textContent.includes('poses/s')", timeout=10)
        time.sleep(1.5)
        take(phone_shot, "phone-speed", selector="#scanner-panel", padding=4)

        studio_chrome.send("Page.bringToFront")
        scanner.wait_for_expression("document.getElementById('scan-overlay')?.dataset.drawn === 'pose+outline'", timeout=30)
        scanner.wait_for_expression("!!document.getElementById('scan-vision-map') && document.getElementById('scan-vision-readout').textContent.includes('Found')"
                                    " && document.getElementById('scan-vision-readout').textContent.includes('Speed')", timeout=30)
        time.sleep(0.3)
        take(studio, "live")
        # The card's foot (its coverage map) scrolled into view in the left pane.
        scanner.evaluate("document.getElementById('scan-vision-map').scrollIntoView({ block: 'center' }), true")
        time.sleep(0.3)
        scanner_shot(studio, scanner, "readout", "#scan-vision-section")

        print("wrote %s into %s" % (", ".join(sorted(ONLY)) or "every picture", IMAGES))
    finally:
        if phone:
            phone.close()

        studio_chrome.close()
        relay.close()
        server.close()


if __name__ == "__main__":
    main()
