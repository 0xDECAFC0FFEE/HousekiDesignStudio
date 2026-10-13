"""/scanner.js on another website, end to end (T-0337).

The user, 2026-10-12: "i want to serve the scanner as a website that can integrate against other
people's websites ... the scanner pop up will pop up, connect to your phone, do some scanning then
'return' the scanned data back to the initial parent website", then "lets split our site, can you
put the scanner at www.houseki.app/scanner.js and embed it into the main site". The studio's own
use of it is tests/harness/test_scan_mode.py's; these tests are the OTHER website's view.

HOW THEY RUN. Two servers, standing in for two websites:

  * the Houseki site: build/www over HTTP, http://localhost:<port> (test_scan_link.py's Server),
    which serves /scanner.js, the scan page /scanner/embed.html and the phone page /scanner/;
  * the other website: a temporary directory holding one page, partner.html, served at
    http://127.0.0.1:<port>. 127.0.0.1 and localhost are different SITES to the browser, so the
    scanner's iframe is a third-party frame there, exactly as on a real partner's site: Chrome runs
    it in a process of its own, the partner page's script cannot reach into it, and its storage is
    partitioned to the partner. The tests drive the iframe through CDP instead, attaching to its
    target (`Target.attachToTarget`, flattened, cdp.py's `session_id`).

partner.html includes the script as a partner would, `<script src=".../scanner.js">`, and its
button calls `HousekiScan.open`, recording every callback in `window.events`.

The phone is a second tab with the real phone page and Chrome's fake camera, on a local Nostr relay
(nostr_relay.js under Deno), as in test_scan_mode.py. The scanner reads the test relay from its own
storage (`gems.scanRelayUrls`); inside the partner that storage is the partitioned one, so the test
writes it from inside a first scanner and opens the scanner again (open_scanner_on_test_relay).

    ./build.sh   # or: python3 src/scripts/make_page.py --skip-build
    ~/.pyenv/versions/anaconda3-2019.07/bin/python3 -m unittest tests/harness/test_scanner_embed.py -v

Headless Chrome does not start inside this machine's command sandbox; run it outside it. Skipped,
with the reason, when the site is not built or Chrome, Deno or `websocket-client` is missing.
"""

import json
import os
import shutil
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))
SITE = os.path.join(PROJECT_ROOT, "build", "www")
SDK_SCRIPT = os.path.join(SITE, "scanner.js")
EMBED_PAGE = os.path.join(SITE, "scanner", "embed.html")
SCANNER_PAGE = os.path.join(SITE, "scanner", "index.html")

sys.path.insert(0, HERE)

try:
    import cdp
    from test_scan_link import CHROME_ARGS, CONNECT_TIMEOUT, Relay, Server
except ImportError as error:  # websocket-client is not installed
    cdp = None
    IMPORT_ERROR = str(error)

GL_BACKEND = os.environ.get("GEM_TEST_GL") or None

# scan_session.js's SCAN_RELAYS_SETTING.
RELAYS_SETTING = "gems.scanRelayUrls"

# The other website's page: a button that opens the scanner, and every callback recorded.
PARTNER_PAGE = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>A rough dealer</title></head>
<body style="margin: 40px; font: 16px system-ui">
<h1>A rough dealer</h1>
<button id="scan" type="button">Scan your rough</button>
<script src="%(sdk)s"></script>
<script>
window.events = [];
document.getElementById('scan').addEventListener('click', () => {
  window.handle = HousekiScan.open({
    onResult: result => events.push({ type: 'result', result }),
    onCancel: () => events.push({ type: 'cancel' }),
    onStatus: status => events.push({ type: 'status', status }),
  });
});
</script>
</body>
</html>
"""


def js(value):
    """A Python value as a JavaScript literal."""
    return json.dumps(value)


@unittest.skipIf(cdp is None, "needs websocket-client: %s" % (IMPORT_ERROR if cdp is None else ""))
@unittest.skipUnless(os.path.isfile(SDK_SCRIPT), "/scanner.js is not built (%s); run ./build.sh" % SDK_SCRIPT)
@unittest.skipUnless(os.path.isfile(EMBED_PAGE), "the scan page is not built (%s); run ./build.sh" % EMBED_PAGE)
@unittest.skipUnless(os.path.isfile(SCANNER_PAGE), "the phone page is not built (%s); run ./build.sh" % SCANNER_PAGE)
@unittest.skipUnless(shutil.which("deno"), "needs Deno, to run the local Nostr relay")
class ScannerEmbedTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.houseki = Server()
        cls.partner_dir = tempfile.mkdtemp(prefix="gem-partner-")
        with open(os.path.join(cls.partner_dir, "partner.html"), "w") as page:
            page.write(PARTNER_PAGE % {"sdk": cls.houseki.origin + "/scanner.js"})
        cls.partner = Server(directory=cls.partner_dir)
        # The same server, named by IP: another site than the Houseki site's localhost.
        cls.partner_origin = cls.partner.origin.replace("localhost", "127.0.0.1")
        cls.relay = Relay()

        try:
            cls.chrome = cdp.Chrome(gl_backend=GL_BACKEND, extra_args=CHROME_ARGS)
        except Exception as error:  # no Chrome on this machine, or inside the sandbox
            cls.relay.close()
            cls.partner.close()
            cls.houseki.close()
            raise unittest.SkipTest("could not start Chrome: %s" % error)

        cls.site = cls.chrome
        cls.phone = cls.chrome.new_tab()
        cls.site.send("Emulation.setDeviceMetricsOverride", {
            "width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False,
        })

    @classmethod
    def tearDownClass(cls):
        cls.chrome.close()
        cls.relay.close()
        cls.partner.close()
        cls.houseki.close()
        shutil.rmtree(cls.partner_dir, ignore_errors=True)

    def setUp(self):
        # Every test starts on the partner's page, freshly loaded, with no scanner open.
        self.site.send("Page.bringToFront")
        self.site.navigate("about:blank")
        self.site.navigate(self.partner_origin + "/partner.html")
        self.site.wait_for_expression("typeof window.HousekiScan === 'object'", timeout=30)
        self.frame_session = None

    def tearDown(self):
        self.phone.navigate("about:blank")

    # --- the partner's page -------------------------------------------------------------------

    def events(self, kind=None):
        events = self.site.evaluate("window.events")
        return [event for event in events if kind is None or event["type"] == kind]

    def overlay_open(self):
        return self.site.evaluate("!!document.getElementById('houseki-scanner')")

    def click_at(self, x, y):
        self.site.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
        for kind in ("mousePressed", "mouseReleased"):
            self.site.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})

    def open_scanner(self):
        """Clicks the partner's own button with the mouse, as its visitor would, and waits for the
        scan page in the modal to show its code."""
        box = self.site.evaluate("(() => { const r = document.getElementById('scan').getBoundingClientRect();"
                                 " return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()")
        self.click_at(box["x"], box["y"])
        self.site.wait_for_expression("!!document.querySelector('#houseki-scanner iframe')", timeout=10)
        self.wait_in_frame("!!document.getElementById('scan-qr')", timeout=60)

    # --- the scanner's iframe, through its own CDP target ---------------------------------------

    def attach_frame(self):
        """Attaches to the scan page's iframe target (a process of its own: another site's frame)
        and returns the session id, or None while there is no such frame yet."""
        targets = self.site.send("Target.getTargets")["targetInfos"]
        frames = [t for t in targets if t["type"] == "iframe" and t["url"].startswith(self.houseki.origin + "/scanner/embed.html")]

        if not frames:
            return None

        return self.site.send("Target.attachToTarget", {"targetId": frames[-1]["targetId"], "flatten": True})["sessionId"]

    def in_frame(self, expression, timeout=10):
        """`expression` evaluated by the scan page itself. Attaches on first use after each open.

        A command sent to the frame while it is still between documents (the iframe's first,
        empty one and the scan page) was once never answered; so it is given `timeout` seconds,
        after which the frame is attached afresh on the next call and this one raises."""
        if self.frame_session is None:
            self.frame_session = self.attach_frame()
            if self.frame_session is None:
                return None

        try:
            result = self.site.send("Runtime.evaluate", {"expression": expression, "returnByValue": True},
                                    timeout=timeout, session_id=self.frame_session)
        except Exception as error:  # no answer in time (websocket-client's own timeout error)
            self.frame_session = None
            raise RuntimeError("the scan page did not answer: %s" % error)

        if result.get("exceptionDetails"):
            raise RuntimeError("JS exception in the scan page: %r" % result["exceptionDetails"])
        return result.get("result", {}).get("value")

    def wait_in_frame(self, expression, timeout=30):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                last = self.in_frame(expression, timeout=max(1, min(10, deadline - time.time())))
            except RuntimeError as error:  # the frame's document is still loading
                last = error
            if last is True:
                return
            time.sleep(0.1)
        raise TimeoutError("timed out waiting in the scan page for %r (last: %r)" % (expression, last))

    def click_in_frame(self, selector):
        """A real mouse click at the middle of the scan page's element: the iframe's place on the
        partner's page plus the element's place in the iframe."""
        frame = self.site.evaluate("(() => { const r = document.querySelector('#houseki-scanner iframe').getBoundingClientRect();"
                                   " return {x: r.x, y: r.y}; })()")
        self.in_frame("document.getAnimations().filter(a => a.effect?.getComputedTiming().endTime !== Infinity).forEach(a => a.finish()), true")
        box = self.in_frame("(() => { const r = document.querySelector(%s).getBoundingClientRect();"
                            " return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()" % js(selector))
        self.click_at(frame["x"] + box["x"], frame["y"] + box["y"])

    def open_scanner_on_test_relay(self):
        """Opens the scanner pointed at the local relay, and returns its link. Its storage inside
        the partner is partitioned to the partner, so the setting is written there, from inside a
        first scanner; the partner then closes that one (its handle's close()) and opens the
        scanner again, which starts with the setting.

        Not New code in the first scanner: measured, a session made by New code on a different
        set of relays than the session it replaced never connected a phone (the phone page sat at
        'connecting'), while the same relays from the start connected in two seconds. In use the
        relays never change, so only this test-only path meets it (T-0339)."""
        self.open_scanner()
        self.in_frame("localStorage.setItem(%s, %s), true" % (js(RELAYS_SETTING), js(json.dumps([self.relay.url]))))
        self.site.evaluate("window.handle.close(), true")
        self.frame_session = None
        self.site.evaluate("window.events.length = 0, true")
        self.open_scanner()
        link = self.in_frame("document.getElementById('scan-url').textContent.trim()")
        self.assertIn("&s=", link)
        return link

    # --- tests --------------------------------------------------------------------------------

    def test_scanner_js_opens_the_scan_page_beside_it_naming_the_site(self):
        """HousekiScan.open lays the scan page over another website, and the page names it.

        Setup: the partner's page on another site, /scanner.js included from the Houseki site.
        Test: click the partner's button with the mouse. Verifies a modal covers the partner's
        page with an iframe of the scan page BESIDE THE SCRIPT (the Houseki site's
        /scanner/embed.html, not anything on the partner's site); the scan page names the
        partner's host as the browser reported it ("Scanning for 127.0.0.1:<port>"), which the
        partner cannot fake; the partner's own script cannot read into the scanner (a third-party
        frame: no contentDocument); and the partner hears 'waiting' through onStatus.
        """
        self.open_scanner()

        self.assertTrue(self.overlay_open())
        self.assertEqual(self.site.evaluate("document.querySelector('#houseki-scanner iframe').src"),
                         self.houseki.origin + "/scanner/embed.html")
        self.assertEqual(self.in_frame("document.getElementById('embed-site').textContent.trim()"),
                         "· Scanning for " + self.partner_origin.split("//", 1)[1])
        self.assertIsNone(self.site.evaluate("document.querySelector('#houseki-scanner iframe').contentDocument"))
        self.site.wait_for_expression("window.events.some(e => e.type === 'status' && e.status === 'waiting')", timeout=10)

    def test_done_hands_the_result_back_to_the_site(self):
        """A phone scans, Done, and the partner's onResult gets the result; the session ends.

        Setup: the scanner open on the partner's page, pointed at the test relay. Test: open the
        code's link in the phone tab; once the partner hears 'streaming', click Done in the scan
        page with the mouse. Verifies the partner heard the scan's progress ('waiting', then
        'streaming'); onResult was called exactly once, with a version 1 result saying a phone
        connected (a plain object, as structured cloning delivers it); onCancel was not; the
        modal is gone from the partner's page; and the phone sees the computer leave (its page
        says 'disconnected'), so the session ended with the modal.
        """
        link = self.open_scanner_on_test_relay()

        self.phone.navigate(link)
        self.phone.wait_for_expression(
            "document.getElementById('scanner-status')?.dataset.status === 'connected'", timeout=CONNECT_TIMEOUT)
        self.site.send("Page.bringToFront")
        self.site.wait_for_expression("window.events.some(e => e.type === 'status' && e.status === 'streaming')",
                                      timeout=CONNECT_TIMEOUT)

        self.click_in_frame("#scan-done")
        self.site.wait_for_expression("!document.getElementById('houseki-scanner')", timeout=10)

        results = self.events("result")
        print("\n[scanner_embed] result %r" % results, file=sys.stderr)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["result"]["version"], 1)
        self.assertTrue(results[0]["result"]["phoneConnected"])
        self.assertEqual(self.events("cancel"), [])
        statuses = [event["status"] for event in self.events("status")]
        self.assertIn("waiting", statuses)
        self.assertIn("streaming", statuses)
        self.phone.wait_for_expression(
            "document.getElementById('scanner-status').dataset.status === 'disconnected'", timeout=CONNECT_TIMEOUT)

    def test_escape_and_close_cancel_and_the_site_can_close_it(self):
        """Escape and the scanner's Close call onCancel; the site's own close() calls nothing.

        Setup: the partner's page. Test: open the scanner and press Escape (the scan page has the
        focus); open it again and click its Close (X); open it again and call the handle's
        close() from the partner's script; and, while one is open, try to open a second. Verifies
        Escape and Close each remove the modal and call onCancel once (and never onResult); the
        partner's own close() removes the modal and calls neither, since the partner asked for it;
        a second open while one is open throws rather than stacking two scanners; and the
        partner's page scrolls again once the modal is gone (its overflow given back).
        """
        self.open_scanner()
        self.assertTrue(self.site.evaluate("document.activeElement === document.querySelector('#houseki-scanner iframe')"))
        for kind in ("keyDown", "keyUp"):
            self.site.send("Input.dispatchKeyEvent", {"type": kind, "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
        self.site.wait_for_expression("!document.getElementById('houseki-scanner')", timeout=10)
        self.assertEqual(len(self.events("cancel")), 1)

        self.frame_session = None
        self.open_scanner()
        self.click_in_frame("#embed-close")
        self.site.wait_for_expression("!document.getElementById('houseki-scanner')", timeout=10)
        self.assertEqual(len(self.events("cancel")), 2)

        self.frame_session = None
        self.open_scanner()
        self.assertEqual(self.site.evaluate("document.documentElement.style.overflow"), "hidden")
        second = self.site.evaluate("(() => { try { HousekiScan.open({ onResult() {} }); return 'opened'; }"
                                    " catch (e) { return e.message; } })()")
        self.assertIn("already open", second)
        self.site.evaluate("window.handle.close(), true")
        self.assertFalse(self.overlay_open())
        time.sleep(0.5)
        self.assertEqual(len(self.events("cancel")), 2, "close() called onCancel")
        self.assertEqual(self.events("result"), [])
        self.assertEqual(self.site.evaluate("document.documentElement.style.overflow"), "")

    def test_the_scan_page_on_its_own_says_what_it_is_and_starts_nothing(self):
        """The scan page opened in its own tab explains itself and opens no session.

        Setup: the phone tab (any tab will do). Test: open /scanner/embed.html directly, outside
        any website. Verifies the page says what it is for and points to the studio, and no
        scanning session was started -- so no relay connection is made from a page nobody framed.
        """
        self.phone.navigate(self.houseki.origin + "/scanner/embed.html")
        self.phone.wait_for_expression("document.getElementById('embed-app')?.dataset.phase === 'standalone'", timeout=30)
        self.assertIn("websites open", self.phone.evaluate("document.body.innerText"))
        self.assertTrue(self.phone.evaluate("!!document.querySelector('a[href=\"../studio.html\"]')"))
        self.assertFalse(self.phone.evaluate("window.housekiScanSession.scanOpen()"))


if __name__ == "__main__":
    unittest.main()
