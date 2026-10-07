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

Since T-0331 the phone plays the scan guidance's video (make_scan_video.GUIDE_CONFIG: the strip
sheet, chosen on the phone; a slow orbit, a fast swing, a defocused hold), so the pictures show the
grid, the arrows, the coverage map filling and the angle; it also writes phone-guide.webp (the map
and advice, cropped), phone-fast.webp ("Moving too fast") and phone-focus.webp ("Rock not in
focus"), each taken when the phone itself shows that state.

Since T-0332 it also writes phone-speed.webp: the phone's speed line, opened as a person opens it
(a long press on the status lines at the bottom), cropped to the lines. Names given on the command
line (e.g. `readout live phone-speed`) retake only those pictures.
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


def waiting_shots():
    """overview.webp and panel.webp: the studio opened from file:// as people open it, so the link
    under the code is the public one (no test server or relay in it)."""
    with Studio() as studio:
        studio.click("#menu-button-tools")
        studio.click("#menu-item-rough-scan")
        studio.chrome.wait_for_expression("!!document.getElementById('scan-qr')", timeout=20)
        studio.settle(frames=10)
        take(studio, "overview")
        take(studio, "panel", selector="#scan-panel", padding=0)


def main():
    if not ONLY or ONLY & {"overview", "panel"}:
        waiting_shots()
    video = ensure_guide_video()
    server = Server()
    relay = Relay()
    studio_chrome = cdp.Chrome(gl_backend="metal", extra_args=CHROME_ARGS, timeout=60)
    phone = None

    try:
        studio = attach(studio_chrome, 1440, 900, 2)
        studio_chrome.navigate(server.origin + "/studio.html", timeout=120)
        studio_chrome.evaluate("localStorage.setItem('gems.scanRelayUrls', %s), true" % json.dumps(json.dumps([relay.url])))
        studio_chrome.navigate("about:blank")
        studio_chrome.navigate(server.origin + "/studio.html", timeout=120)
        studio_chrome.wait_for_expression("!!window.gemApp", timeout=120)
        studio.settle(frames=20)

        studio.click("#menu-button-tools")
        studio.click("#menu-item-rough-scan")
        studio_chrome.wait_for_expression("!!document.getElementById('scan-qr')", timeout=20)
        link = studio_chrome.evaluate("document.getElementById('scan-url').textContent.trim()")

        phone = native_chrome(gl_backend="metal", extra_args=tuple(list(CHROME_ARGS) + [
            "--use-file-for-fake-video-capture=%s" % video["mjpeg"]]), timeout=60)
        phone.send("Emulation.setDeviceMetricsOverride", PHONE)
        # The strip sheet, chosen on the phone (its saved choice), as a person using it would.
        phone.navigate(server.origin + "/scanner/")
        phone.evaluate("localStorage.setItem('houseki.scannerSheet', 'charuco_23x17_10mm_strip'), true")
        phone.navigate(link)
        phone.wait_for_expression("document.getElementById('scanner-status')?.dataset.status === 'connected'", timeout=60)
        phone_shot = Studio.__new__(Studio)
        phone_shot.chrome = phone
        state = "window.housekiScanVision?.state"
        # The fast swing, then the defocused hold, each as the phone shows its warning.
        phone.wait_for_expression("%s?.warning === 'fast'" % state, timeout=120)
        take(phone_shot, "phone-fast")
        phone.evaluate("""(() => { window.__seen = []; setInterval(() => { const g = housekiScanVision.state.last?.guide;
          if (g) window.__seen.push([housekiScanVision.state.warning, g.blurMm, g.blurWindowPx, g.speedMmS, g.view?.azimuthDeg, g.view?.elevationDeg, g.conditions]); }, 200); })(), true""")

        try:
            phone.wait_for_expression("%s?.warning === 'focus'" % state, timeout=90)
        except TimeoutError:
            print(json.dumps(phone.evaluate("window.__seen.slice(-150)")))
            raise
        take(phone_shot, "phone-focus")
        # Then the slow orbit of the next loop, some way round: the rock found from the views, the
        # map filling, no warning, the rock outlined.
        phone.wait_for_expression(
            "%s?.phase === 'pose' && !%s.warning && %s.last?.guide?.rockFrom === 'views'"
            " && Math.abs((housekiScanVision.state.last.guide.view?.elevationDeg ?? 0) - 30) < 3"
            " && %s.last.guide.cover[1].toString(2).split('1').length - 1 >= 3"
            " && %s.last.guide.cover[1].toString(2).split('1').length - 1 <= 6"
            " && document.getElementById('scanner-vision').textContent.includes('Rock outlined')" % ((state,) * 5), timeout=120)
        take(phone_shot, "phone")
        take(phone_shot, "phone-guide", selector="#scanner-guide", padding=4)
        # The speed line (T-0332): a long press on the status lines shows it; its numbers are
        # rewritten twice a second, so give it a moment to fill.
        long_press(phone, "#scanner-status")
        phone.wait_for_expression("!document.getElementById('scanner-diag').hidden"
                                  " && document.getElementById('scanner-diag').textContent.includes('poses/s')", timeout=10)
        time.sleep(1.5)
        take(phone_shot, "phone-speed", selector="#scanner-panel", padding=4)

        studio_chrome.send("Page.bringToFront")
        studio_chrome.wait_for_expression("document.getElementById('scan-overlay')?.dataset.drawn === 'pose+outline'", timeout=30)
        studio_chrome.wait_for_expression("!!document.getElementById('scan-vision-map') && document.getElementById('scan-vision-readout').textContent.includes('Colour strips')"
                                          " && document.getElementById('scan-vision-readout').textContent.includes('Speed')", timeout=30)
        time.sleep(0.3)
        take(studio, "live")
        # The card's foot (its coverage map) scrolled into view in the left pane.
        studio_chrome.evaluate("document.getElementById('scan-vision-map').scrollIntoView({ block: 'center' }), true")
        time.sleep(0.3)
        take(studio, "readout", selector="#scan-vision-section", padding=6)
        print("wrote %s into %s" % (", ".join(sorted(ONLY)) or "every picture", IMAGES))
    finally:
        if phone:
            phone.close()

        studio_chrome.close()
        relay.close()
        server.close()


if __name__ == "__main__":
    main()
