"""Tools > Rough scan, end to end in the studio (T-0314).

The user asked for "a rough scanning mode [that] first shows a qr code on the screen", and once
the phone has scanned it, the phone's camera streamed "to the phone screen and the website";
later, "a copyable url under the qr code so users can send it instead of using the qr code".
These tests drive the BUILT studio, build/www/studio.html, the way a person does -- real mouse
clicks on the Tools menu, a real Escape -- with the real phone page, build/www/scanner/, in a
second tab of the same browser standing in for the phone. Nothing in the studio is stubbed: the
session is scan_link.js's own.

HOW THEY RUN. As tests/harness/test_scan_link.py (T-0313) does, and with its `Server` and `Relay`:

  * build/www served over HTTP on localhost, so the studio's default phone page is that server's
    /scanner and the camera and WebRTC work (localhost is a secure context);
  * a Nostr relay on localhost (nostr_relay.js, under Deno) instead of the public relays. The
    studio is pointed at it through its one test-only setting, `gems.scanRelayUrls` in the page's
    own storage (scan_mode.js's SCAN_RELAYS_SETTING), written by the test before the mode is
    opened; the session link then carries it to the phone page;
  * headless Chrome with a fake camera (a moving test pattern), granted without a prompt.

The QR code is checked as a phone would check it: a screenshot of the code as drawn on screen is
decoded with jsQR (Apache-2.0, a test-only dependency of src/web), and the link it holds is the
one opened in the phone tab.

    ./build.sh   # or: python3 src/scripts/make_page.py --skip-build
    ~/.pyenv/versions/anaconda3-2019.07/bin/python3 -m unittest tests/harness/test_scan_mode.py -v

Headless Chrome does not start inside this machine's command sandbox; run it outside it. By
default the studio renders with SwiftShader, as every harness test here does; `GEM_TEST_GL=metal`
uses the real GPU. Skipped, with the reason, when the page is not built or Chrome, Deno or
`websocket-client` is missing.
"""

import base64
import json
import os
import shutil
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))
STUDIO_PAGE = os.path.join(PROJECT_ROOT, "build", "www", "studio.html")
SCANNER_PAGE = os.path.join(PROJECT_ROOT, "build", "www", "scanner", "index.html")
JSQR = os.path.join(PROJECT_ROOT, "src", "web", "node_modules", "jsqr", "dist", "jsQR.js")

sys.path.insert(0, HERE)

try:
    import cdp
    from test_scan_link import CHROME_ARGS, CONNECT_TIMEOUT, Relay, Server
except ImportError as error:  # websocket-client is not installed
    cdp = None
    IMPORT_ERROR = str(error)

GL_BACKEND = os.environ.get("GEM_TEST_GL") or None

# scan_mode.js's SCAN_RELAYS_SETTING: the relays the studio's sessions use, for the tests only.
RELAYS_SETTING = "gems.scanRelayUrls"


def js(value):
    """A Python value as a JavaScript literal."""
    return json.dumps(value)


@unittest.skipIf(cdp is None, "needs websocket-client: %s" % (IMPORT_ERROR if cdp is None else ""))
@unittest.skipUnless(os.path.isfile(STUDIO_PAGE), "the studio is not built (%s); run ./build.sh" % STUDIO_PAGE)
@unittest.skipUnless(os.path.isfile(SCANNER_PAGE), "the phone page is not built (%s); run ./build.sh" % SCANNER_PAGE)
@unittest.skipUnless(os.path.isfile(JSQR), "jsQR is not installed (%s); run ./setup.sh" % JSQR)
@unittest.skipUnless(shutil.which("deno"), "needs Deno, to run the local Nostr relay")
class RoughScanModeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.relay = Relay()

        try:
            cls.chrome = cdp.Chrome(gl_backend=GL_BACKEND, extra_args=CHROME_ARGS)
        except Exception as error:  # no Chrome on this machine, or inside the sandbox
            cls.relay.close()
            cls.server.close()
            raise unittest.SkipTest("could not start Chrome: %s" % error)

        # The studio is the browser's first tab; the phone is a second tab of the same browser,
        # which is also how the user tries it on one laptop.
        cls.studio = cls.chrome
        cls.phone = cls.chrome.new_tab()
        cls.studio.send("Emulation.setDeviceMetricsOverride", {
            "width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False,
        })

        # The studio over HTTP, with the test relay saved, then loaded again so it starts with it.
        cls.studio.navigate(cls.server.origin + "/studio.html", timeout=120)
        cls.studio.evaluate("localStorage.setItem(%s, %s), true" % (js(RELAYS_SETTING), js(json.dumps([cls.relay.url]))))
        cls.studio.navigate("about:blank")
        cls.studio.navigate(cls.server.origin + "/studio.html", timeout=120)
        cls.studio.wait_for_expression("!!window.gemApp", timeout=120)

    @classmethod
    def tearDownClass(cls):
        cls.chrome.close()
        cls.relay.close()
        cls.server.close()

    def tearDown(self):
        # Every test starts from the studio with no mode open.
        if self.studio.evaluate("!!document.getElementById('scan-view')"):
            self.studio.send("Page.bringToFront")
            self.press_escape()
        self.phone.navigate("about:blank")

    # --- acting like a person ---------------------------------------------------------------

    def finish_animations(self):
        # kb/browser-harness.md: a CSS transition can stall at 0 under this harness and leave a
        # button `visibility: hidden` to hit testing; a real browser finishes it in 150 ms.
        self.studio.evaluate("document.getAnimations().filter(a => a.effect?.getComputedTiming().endTime !== Infinity).forEach(a => a.finish()), true")

    def box(self, selector):
        box = self.studio.evaluate(
            "(() => { const e = document.querySelector(%s); if (!e) return null;"
            " const r = e.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height}; })()"
            % js(selector))
        self.assertIsNotNone(box, "no element matches %s" % selector)
        return box

    def click(self, selector):
        """A real mouse click at the middle of the element, as a person makes it."""
        self.finish_animations()
        box = self.box(selector)
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

        self.studio.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
        for kind in ("mousePressed", "mouseReleased"):
            self.studio.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})

    def press_escape(self):
        for kind in ("keyDown", "keyUp"):
            self.studio.send("Input.dispatchKeyEvent", {"type": kind, "key": "Escape", "code": "Escape",
                                                        "windowsVirtualKeyCode": 27})
        self.studio.wait_for_expression("!document.getElementById('scan-view')", timeout=10)

    def open_mode(self):
        """Tools > Rough scan, with the mouse; waits for the code. Returns the link shown under it."""
        self.studio.send("Page.bringToFront")
        self.click("#menu-button-tools")
        self.studio.wait_for_expression("!!document.getElementById('menu-item-rough-scan')", timeout=10)
        self.click("#menu-item-rough-scan")
        self.studio.wait_for_expression("!!document.getElementById('scan-qr')", timeout=20)
        return self.studio.evaluate("document.getElementById('scan-url').textContent.trim()")

    # --- reading the screen -------------------------------------------------------------------

    def evaluate_async(self, expression, timeout=30):
        result = self.studio.send("Runtime.evaluate", {
            "expression": expression, "awaitPromise": True, "returnByValue": True,
        }, timeout=timeout)
        if result.get("exceptionDetails"):
            raise RuntimeError("JS exception: %r" % result["exceptionDetails"])
        return result.get("result", {}).get("value")

    def decode_qr_on_screen(self):
        """Takes a screenshot of the QR code as drawn on screen, white tile and all, and decodes it
        with jsQR in the page: what a phone's camera would read off the screen. Returns the text,
        or None if the code cannot be read."""
        self.finish_animations()
        box = self.box(".scan-qr-tile")
        png = self.studio.send("Page.captureScreenshot", {
            "format": "png",
            "clip": {"x": box["x"] - 8, "y": box["y"] - 8, "width": box["width"] + 16,
                     "height": box["height"] + 16, "scale": 1},
        })["data"]

        if not self.studio.evaluate("typeof window.jsQR === 'function'"):
            with open(JSQR) as source:
                self.studio.evaluate(source.read() + "\n;true")

        return self.evaluate_async(
            """(async () => {
              const image = new Image();
              image.src = 'data:image/png;base64,%s';
              await image.decode();
              const canvas = document.createElement('canvas');
              canvas.width = image.naturalWidth;
              canvas.height = image.naturalHeight;
              const context = canvas.getContext('2d');
              context.drawImage(image, 0, 0);
              const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
              return window.jsQR(pixels.data, canvas.width, canvas.height)?.data ?? null;
            })()""" % png)

    def mode_readout(self):
        return self.studio.evaluate("document.getElementById('topbar-mode').textContent.trim()")

    def phone_status(self):
        return self.phone.evaluate("document.getElementById('scanner-status').dataset.status")

    def open_on_phone(self, link):
        """Opens `link` in the phone tab, afresh (via about:blank: a URL differing only in its hash
        would be a same-page navigation that runs nothing again)."""
        self.phone.navigate("about:blank")
        self.phone.navigate(link)

    # --- tests --------------------------------------------------------------------------------

    def test_tools_menu_opens_the_mode_with_a_code_that_decodes_to_the_session_link(self):
        """Tools > Rough scan opens the mode, and its QR code holds the session's link.

        Setup: the studio served over HTTP, no mode open. Test: open the Tools menu and click
        Rough scan with the mouse; screenshot the code as drawn and decode it. Verifies the top
        bar reads "Rough scan" and the cutting instructions give way to the mode's panel; the
        code a phone would read off the screen is exactly the link printed under it; and that
        link is a session link to this server's phone page (/scanner, version 1, with a room and
        a password) carrying the test relay -- the session scan_link.js made, with the studio's
        default phone page and nothing else passed in.
        """
        shown = self.open_mode()
        decoded = self.decode_qr_on_screen()
        print("\n[scan_mode] code decodes to %s" % decoded, file=sys.stderr)

        self.assertEqual(self.mode_readout(), "Rough scan")
        self.assertTrue(self.studio.evaluate("!!document.getElementById('scan-panel') && !document.getElementById('scan-panel').closest('[inert]')"))
        self.assertEqual(decoded, shown)
        self.assertTrue(shown.startswith(self.server.origin + "/scanner#v=1&r="), shown)
        self.assertIn("&p=", shown)
        self.assertIn("&s=", shown)

    def test_copy_puts_exactly_the_session_link_on_the_clipboard(self):
        """Copy, under the code, copies the session's link; the text is there to select too.

        Setup: the mode open; the browser allowed to read the clipboard back. Test: click Copy
        with the mouse, then read the clipboard. Verifies the button says "Copied"; what reached
        the clipboard is exactly the link shown, which is exactly what the QR code holds; and the
        link's text is selectable as one piece (user-select: all), so it can be copied by hand
        where the clipboard is refused.
        """
        shown = self.open_mode()
        self.studio.send("Browser.grantPermissions", {
            "origin": self.server.origin, "permissions": ["clipboardReadWrite", "clipboardSanitizedWrite"],
        })
        self.click("#scan-copy")
        self.studio.wait_for_expression("document.getElementById('scan-copy').textContent.includes('Copied')", timeout=5)

        copied = self.evaluate_async("navigator.clipboard.readText()")
        self.assertEqual(copied, shown)
        self.assertEqual(copied, self.decode_qr_on_screen())
        self.assertEqual(self.studio.evaluate("getComputedStyle(document.getElementById('scan-url')).userSelect"), "all")

    def test_the_phone_streams_its_camera_into_the_studio(self):
        """The link the code holds, opened on the phone, puts its live camera in the studio.

        Setup: the mode open; the phone tab (the real phone page, Chrome's fake camera). Test:
        decode the code off the screen and open that link in the phone tab; bring the studio to
        the front (Chrome does not play video in a background tab, and the person is looking at
        the studio). Verifies the phone says it is connected; the code gives way to a playing
        <video> of the phone's camera -- a live video track, frames advancing -- labelled live;
        and both the panel and the readout under it say "Streaming".
        """
        self.open_mode()
        link = self.decode_qr_on_screen()
        self.open_on_phone(link)
        self.phone.wait_for_expression(
            "document.getElementById('scanner-status')?.dataset.status === 'connected'", timeout=CONNECT_TIMEOUT)

        self.studio.send("Page.bringToFront")
        self.studio.wait_for_expression(
            "document.getElementById('scan-view').dataset.streaming === 'true'", timeout=CONNECT_TIMEOUT)
        self.studio.wait_for_expression("document.getElementById('scan-video').videoWidth > 0", timeout=20)

        video = ("(() => { const v = document.getElementById('scan-video'); const t = v.srcObject.getVideoTracks()[0];"
                 " return { paused: v.paused, width: v.videoWidth, height: v.videoHeight, time: v.currentTime,"
                 " track: t.readyState, shown: v.getBoundingClientRect().width }; })()")
        first = self.studio.evaluate(video)
        time.sleep(1.5)
        later = self.studio.evaluate(video)
        print("\n[scan_mode] studio video %r -> %r" % (first, later), file=sys.stderr)

        self.assertFalse(later["paused"])
        self.assertEqual(later["track"], "live")
        self.assertGreater(later["time"], first["time"], "the phone's video is not advancing")
        self.assertGreater(later["shown"], 300, "the video does not fill the middle")
        self.assertFalse(self.studio.evaluate("!!document.getElementById('scan-qr')"), "the code is still shown")
        self.assertTrue(self.studio.evaluate("!!document.getElementById('scan-live')"))
        self.assertIn("Streaming", self.studio.evaluate("document.getElementById('scan-panel-status').textContent"))

    def wait_for_streaming(self):
        """Brings the studio to the front and waits for the phone's video to play in it."""
        self.studio.send("Page.bringToFront")
        self.studio.wait_for_expression(
            "document.getElementById('scan-view').dataset.streaming === 'true'", timeout=CONNECT_TIMEOUT)
        self.studio.wait_for_expression("document.getElementById('scan-video').videoWidth > 0", timeout=20)

    def test_a_phone_that_leaves_can_come_back_with_the_same_code(self):
        """A phone that closes the page is shown as gone, and the same code brings it back.

        Setup: the mode open with the phone streaming. Test: the phone tab leaves the page (as a
        phone closing it would); then it opens the same link again. Verifies that when the phone
        goes, its picture goes too (no frozen last frame), the studio says "Phone disconnected"
        and shows the code again -- the same code, since the session is still open -- and that
        opening that same link again puts the phone's live camera back, as the docs promise.
        """
        self.open_mode()
        link = self.decode_qr_on_screen()
        self.open_on_phone(link)
        self.wait_for_streaming()

        self.phone.navigate("about:blank")
        self.studio.send("Page.bringToFront")
        self.studio.wait_for_expression(
            "document.getElementById('scan-view').dataset.status === 'disconnected'", timeout=CONNECT_TIMEOUT)

        self.assertEqual(self.studio.evaluate("document.getElementById('scan-view').dataset.streaming"), "false")
        self.assertIn("Phone disconnected", self.studio.evaluate("document.getElementById('scan-status').textContent"))
        self.assertEqual(self.decode_qr_on_screen(), link, "the same code is shown again")

        self.open_on_phone(link)
        self.wait_for_streaming()
        self.assertIn("Streaming", self.studio.evaluate("document.getElementById('scan-panel-status').textContent"))

    def test_leaving_the_mode_ends_the_session_and_reopening_makes_a_new_one(self):
        """Escape and Done leave the mode, end the session, and put the studio back.

        Setup: the mode open with the phone streaming, as above. Test: press Escape; then open
        the mode again and leave it with the Done button. Verifies that on Escape the mode's view
        and panel go, the top bar reads "Overview" and the cutting instructions are back; that
        the phone sees the computer leave (its page says 'disconnected'), so the session really
        ended rather than only being hidden; that the mode opened again shows a different link
        (a new room and password); and that Done closes it the same way.
        """
        self.open_mode()
        first = self.decode_qr_on_screen()
        self.open_on_phone(first)
        self.phone.wait_for_expression(
            "document.getElementById('scanner-status')?.dataset.status === 'connected'", timeout=CONNECT_TIMEOUT)

        self.studio.send("Page.bringToFront")
        self.press_escape()

        self.assertEqual(self.mode_readout(), "Overview")
        self.assertFalse(self.studio.evaluate("!!document.getElementById('scan-video')"))
        self.assertTrue(self.studio.evaluate("!!document.getElementById('scan-panel').closest('[inert]')"),
                        "the mode's panel is still live")
        self.phone.wait_for_expression(
            "document.getElementById('scanner-status').dataset.status === 'disconnected'", timeout=CONNECT_TIMEOUT)

        second = self.open_mode()
        self.assertNotEqual(second.split("#", 1)[1], first.split("#", 1)[1])
        self.click("#scan-done")
        self.studio.wait_for_expression("!document.getElementById('scan-view')", timeout=10)
        self.assertEqual(self.mode_readout(), "Overview")


if __name__ == "__main__":
    unittest.main()
