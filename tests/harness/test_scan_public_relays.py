"""Rough scan over the REAL public Nostr relays, end to end (T-0316). Opt-in: needs the internet.

Every other scanner test runs offline against a relay on localhost (test_scan_link.py,
test_scan_mode.py), so the path users actually take -- the studio and the phone page signaling
through the public relays pinned in src/web/src/lib/scan_relays.js -- was never tested until a
user found that it did not connect. These tests take that path, with nothing local but the pages:

  * the studio, opened with Tools > Rough scan by real mouse clicks, with no test relay saved, so
    the session is exactly what a user gets (its link has no `s=`);
  * the phone page in a second tab of the same browser, with Chrome's fake camera, the way the user
    tries it on one laptop;
  * once with both served from build/www over http://localhost, and once with both opened from
    file://, the user's own setup (the studio's link points at the public site from file://, so the
    test, like the user, rewrites it to the local phone page).

Each test records, in both tabs, every relay websocket (instrumented before the page's scripts run):
when it opened, what it refused, and how many events it delivered. It prints how long pairing took
and which relays carried it -- a relay carried it if both tabs received events through it -- and
fails if the phone's camera does not play in the studio within PAIR_TIMEOUT.

A separate test runs tests/harness/nostr_relay_probe.js over the pinned list and prints which
relays accept and deliver Trystero's events right now; it fails if fewer than MIN_WORKING do.

    GEM_TEST_PUBLIC_RELAYS=1 ~/.pyenv/versions/anaconda3-2019.07/bin/python3 -m unittest \\
        tests/harness/test_scan_public_relays.py -v

Skipped unless GEM_TEST_PUBLIC_RELAYS=1. Headless Chrome needs the agent command sandbox off.
"""

import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))
SITE = os.path.join(PROJECT_ROOT, "build", "www")
STUDIO_PAGE = os.path.join(SITE, "studio.html")
SCANNER_PAGE = os.path.join(SITE, "scanner", "index.html")
RELAYS_MODULE = os.path.join(PROJECT_ROOT, "src", "web", "src", "lib", "scan_relays.js")
PROBE_SCRIPT = os.path.join(HERE, "nostr_relay_probe.js")

ENABLED = os.environ.get("GEM_TEST_PUBLIC_RELAYS") == "1"

sys.path.insert(0, HERE)

try:
    import cdp
    from test_scan_link import CHROME_ARGS, Server
except ImportError as error:  # websocket-client is not installed
    cdp = None
    IMPORT_ERROR = str(error)

# How long the phone's camera is given to reach the studio over the public relays. Measured at
# about 3-9 s; public relays are slower than a local one and sometimes much slower.
PAIR_TIMEOUT = 60

# The fewest pinned relays that must pass the probe. Any one working on both ends is enough to
# pair, but if fewer than this work today the list needs attention (see scan_relays.js).
MIN_WORKING = 4

# Installed in each tab before its page's own scripts run: records every websocket the page opens
# (the relays), what each refused, and how many events each delivered, in window.__relays.
INSTRUMENT = r"""
(() => {
  const Native = WebSocket;
  const started = performance.now();
  const at = () => Math.round(performance.now() - started);
  const relays = window.__relays = [];
  const consoleLog = window.__console = [];
  for (const level of ['warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      consoleLog.push(at() + 'ms ' + level + ': ' + args.map(a => (a && a.message) || String(a)).join(' '));
      original(...args);
    };
  }
  window.WebSocket = function (url, protocols) {
    const socket = protocols === undefined ? new Native(url) : new Native(url, protocols);
    const record = { url: String(url), opened: null, closed: null, events: 0, refused: [] };
    relays.push(record);
    socket.addEventListener('open', () => { record.opened = at(); });
    socket.addEventListener('close', () => { record.closed = at(); });
    socket.addEventListener('message', message => {
      let data;
      try { data = JSON.parse(message.data); } catch { return; }
      if (data[0] === 'EVENT') record.events += 1;
      if ((data[0] === 'OK' && data[2] === false) || data[0] === 'CLOSED') record.refused.push(String(data[3] ?? data[2]));
    });
    return socket;
  };
  window.WebSocket.prototype = Native.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
})();
"""


def pinned_relays():
    """SCAN_RELAY_URLS, read from scan_relays.js's source (the only wss:// strings in its list)."""
    with open(RELAYS_MODULE) as source:
        text = source.read()

    body = text[text.index("SCAN_RELAY_URLS = Object.freeze(["):]
    return re.findall(r"'(wss://[^']+)'", body[: body.index("]")])


def js(value):
    return json.dumps(value)


@unittest.skipUnless(ENABLED, "opt-in: set GEM_TEST_PUBLIC_RELAYS=1 to test against the real public relays")
@unittest.skipIf(cdp is None, "needs websocket-client: %s" % (IMPORT_ERROR if cdp is None else ""))
@unittest.skipUnless(os.path.isfile(STUDIO_PAGE) and os.path.isfile(SCANNER_PAGE), "the site is not built; run ./build.sh")
class PublicRelayPairingTest(unittest.TestCase):
    def setUp(self):
        self.server = Server()

        try:
            self.chrome = cdp.Chrome(extra_args=CHROME_ARGS)
        except Exception as error:  # no Chrome, or inside the command sandbox
            self.server.close()
            raise unittest.SkipTest("could not start Chrome: %s" % error)

        self.studio = self.chrome
        self.phone = self.chrome.new_tab()

        for tab in (self.studio, self.phone):
            tab.send("Page.enable")
            tab.send("Page.addScriptToEvaluateOnNewDocument", {"source": INSTRUMENT})

        self.studio.send("Emulation.setDeviceMetricsOverride", {
            "width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False,
        })

    def tearDown(self):
        self.chrome.close()
        self.server.close()

    # --- acting like a person ----------------------------------------------------------------

    def click(self, selector):
        """A real mouse click in the studio, after finishing any finite CSS animation (see
        test_scan_mode.py's finish_animations for why)."""
        self.studio.evaluate("document.getAnimations().filter(a => a.effect?.getComputedTiming().endTime !== Infinity)"
                             ".forEach(a => a.finish()), true")
        x, y = self.studio.evaluate(
            "(() => { const r = document.querySelector(%s).getBoundingClientRect();"
            " return [r.x + r.width / 2, r.y + r.height / 2]; })()" % js(selector))
        self.studio.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})

        for kind in ("mousePressed", "mouseReleased"):
            self.studio.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})

    def open_rough_scan(self, studio_url):
        """Loads the studio and opens Tools > Rough scan; returns the link shown under the code."""
        self.studio.navigate(studio_url, timeout=120)
        self.studio.wait_for_expression("!!window.gemApp", timeout=120)
        # Nothing test-only: the studio must make the session a user gets.
        self.assertIsNone(self.studio.evaluate("localStorage.getItem('gems.scanRelayUrls')"))
        self.studio.send("Page.bringToFront")
        self.click("#menu-button-tools")
        self.studio.wait_for_expression("!!document.getElementById('menu-item-rough-scan')", timeout=10)
        self.click("#menu-item-rough-scan")
        self.studio.wait_for_expression("!!document.getElementById('scan-qr')", timeout=20)
        return self.studio.evaluate("document.getElementById('scan-url').textContent.trim()")

    def pair(self, phone_link):
        """Opens `phone_link` in the phone tab (in front, as the person looking at it has it) and
        waits for the phone's camera to play in the studio. Returns the seconds it took."""
        self.phone.send("Page.bringToFront")
        started = time.time()
        self.phone.navigate(phone_link)
        deadline = started + PAIR_TIMEOUT

        while time.time() < deadline:
            if self.studio.evaluate("document.getElementById('scan-view')?.dataset.streaming === 'true'"):
                return time.time() - started

            time.sleep(0.2)

        self.fail("no pairing within %ds: studio %r, phone %r (%r)\n%s\nstudio console: %r\nphone console: %r" % (
            PAIR_TIMEOUT,
            self.studio.evaluate("document.getElementById('scan-view')?.dataset.status"),
            self.phone.evaluate("document.getElementById('scanner-status')?.dataset.status"),
            self.phone.evaluate("document.getElementById('scanner-status')?.dataset.detail"),
            self.relay_report(),
            self.studio.evaluate("window.__console"),
            self.phone.evaluate("window.__console")))

    def relay_report(self):
        """One line per relay: what each tab saw on it."""
        studio = {r["url"]: r for r in self.studio.evaluate("window.__relays") or []}
        phone = {r["url"]: r for r in self.phone.evaluate("window.__relays") or []}
        lines = []

        for url in sorted(set(studio) | set(phone)):
            def side(record):
                if not record:
                    return "not used"
                state = "opened %sms" % record["opened"] if record["opened"] is not None else "never opened"
                refused = "; refused %r" % record["refused"][0] if record["refused"] else ""
                return "%s, %d events%s" % (state, record["events"], refused)

            carried = (studio.get(url) or {}).get("events", 0) > 0 and (phone.get(url) or {}).get("events", 0) > 0
            lines.append("  %-34s %s | studio: %s | phone: %s" % (url, "CARRIED" if carried else "-------",
                                                                 side(studio.get(url)), side(phone.get(url))))

        return "\n".join(lines)

    def carriers(self):
        studio = {r["url"]: r["events"] for r in self.studio.evaluate("window.__relays") or []}
        phone = {r["url"]: r["events"] for r in self.phone.evaluate("window.__relays") or []}
        return sorted(url for url in studio if studio[url] > 0 and phone.get(url, 0) > 0)

    def check_streaming_and_relays(self, label, seconds):
        """After pairing: the studio's video really plays, both tabs used exactly the pinned
        relays, and at least one relay carried events both ways. Prints the report."""
        self.studio.send("Page.bringToFront")
        self.studio.wait_for_expression("document.getElementById('scan-video')?.videoWidth > 0", timeout=20)
        first = self.studio.evaluate("document.getElementById('scan-video').currentTime")
        time.sleep(1.5)
        later = self.studio.evaluate("document.getElementById('scan-video').currentTime")
        self.assertGreater(later, first, "the phone's video is not advancing in the studio")
        self.assertEqual(self.phone.evaluate("document.getElementById('scanner-status').dataset.status"), "connected")

        pinned = pinned_relays()
        for name, tab in (("studio", self.studio), ("phone", self.phone)):
            used = sorted({r["url"] for r in tab.evaluate("window.__relays")})
            self.assertEqual(used, sorted(pinned), "the %s did not use exactly the pinned relays" % name)

        carriers = self.carriers()
        print("\n[public relays] %s: paired in %.1fs; carried by %d of %d: %s\n%s" % (
            label, seconds, len(carriers), len(pinned), ", ".join(carriers), self.relay_report()), file=sys.stderr)
        self.assertTrue(carriers, "no relay carried events both ways")

    # --- tests -------------------------------------------------------------------------------

    def test_pairs_over_public_relays_from_localhost(self):
        """The studio and the phone page served from http://localhost pair over the public relays.

        Setup: build/www over HTTP on localhost; the studio with no test relay saved; the phone tab.
        Test: Tools > Rough scan; open the link shown, unchanged, in the phone tab (brought to the
        front, so the studio is hidden while it connects, as for a person). Verifies the link names
        no relay (so both ends use the pinned list), the phone's camera plays in the studio within
        PAIR_TIMEOUT, both tabs used exactly the pinned relays, and at least one carried events
        both ways. Prints the pairing time and the relays that carried it.
        """
        link = self.open_rough_scan(self.server.origin + "/studio.html")
        self.assertTrue(link.startswith(self.server.origin + "/scanner#v=1&"), link)
        self.assertNotIn("&s=", link)
        self.check_streaming_and_relays("http://localhost", self.pair(link))

    def test_pairs_over_public_relays_from_file_pages(self):
        """The user's own setup: studio and phone page both opened from file://.

        Setup: the studio opened from build/www/studio.html as a file. Its link points at the
        public site (a file has no address a phone could reach), so, as the user did, the test
        swaps that for the local phone page, file:///.../scanner/index.html, keeping the hash.
        Test and verifies: as above, from file://, where Chrome counts both pages as secure
        contexts (camera, WebRTC and WebCrypto all work).
        """
        link = self.open_rough_scan(pathlib.Path(STUDIO_PAGE).as_uri())
        self.assertTrue(link.startswith("https://houseki.app/scanner#v=1&"), link)
        self.assertNotIn("&s=", link)
        local = pathlib.Path(SCANNER_PAGE).as_uri() + "#" + link.split("#", 1)[1]
        self.check_streaming_and_relays("file://", self.pair(local))


@unittest.skipUnless(ENABLED, "opt-in: set GEM_TEST_PUBLIC_RELAYS=1 to test against the real public relays")
@unittest.skipUnless(shutil.which("deno"), "needs Deno, to run nostr_relay_probe.js")
class PinnedRelayProbeTest(unittest.TestCase):
    def test_the_pinned_relays_accept_and_deliver_trysteros_events(self):
        """Each pinned relay, probed the way Trystero uses it.

        Setup: the pinned list from scan_relays.js. Test: nostr_relay_probe.js publishes a signed
        ephemeral event (the kind range Trystero uses, with its "x" tag) on one connection to each
        relay and waits for it on a second, subscribed one. Verifies at least MIN_WORKING relays
        accept and deliver it; prints every relay's result, so a failing one can be replaced.
        """
        pinned = pinned_relays()
        result = subprocess.run(["deno", "run", "--allow-net", "--allow-read", PROBE_SCRIPT, "--json", *pinned],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        results = json.loads(result.stdout.strip().splitlines()[-1])
        working = [r["url"] for r in results if r["ok"]]
        print("\n[public relays] probe: %d of %d pinned relays work\n%s" % (
            len(working), len(pinned), "\n".join(line for line in result.stdout.splitlines()[:-1])), file=sys.stderr)
        self.assertGreaterEqual(len(working), MIN_WORKING)


if __name__ == "__main__":
    unittest.main()
