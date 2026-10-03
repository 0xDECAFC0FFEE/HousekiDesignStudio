"""The phone scanner's pairing link enforces its password (T-0313).

The computer hosts a Trystero room with a fresh random room id and password and shows a QR code
linking to the phone page, /scanner, with both in the hash. The phone page joins and streams its
camera. The user asked that the password be enforced -- "a randomly generated password in the qr
code hash that the computer requires the phone present in order to connect" -- and that
integration tests ensure it. These are those tests.

HOW THEY RUN. Everything is local, so they pass offline and deterministically:

  * a Nostr relay on localhost (`nostr_relay.js`, under Deno) instead of Trystero's public relays.
    The host is told to use it (`relayUrls`), and the link carries it to the phone, which is the
    only test-specific path in the product code;
  * build/www served over HTTP on localhost (a secure context, so the camera and WebRTC work);
  * headless Chrome with a fake camera (`--use-fake-device-for-media-stream`, a moving test
    pattern) that is granted without a prompt (`--use-fake-ui-for-media-stream`).

The host runs in one tab and the phone in another tab of the same browser, which is also how the
user tries the feature on one laptop. Both tabs load the built phone page: the host tab with no
hash (so it only shows "invalid link" and does nothing), driving `window.housekiScanLink`, the
same `scan_link.js` the app uses; the phone tab with the session link, so the phone side is the
real page doing what it does on a phone. One test instead hosts from the page opened from
file://, as the app is opened, with the phone in a separate browser, as a real phone is.

WHY A REJECTION IS THE PASSWORD'S DOING. A joiner with the wrong password, or none, reaches the
same relay topic as the host (Trystero derives it from the app id and room id only), so both
sides see each other and try to connect; it fails because neither can decrypt what the other
encrypted under a different password. The tests show that it is the password, not a timing
accident, in two ways: Trystero reports a password failure on one side or the other (only the side
that receives the other's session description can tell), and the same host, still open, connects
a joiner with the right link straight afterwards.

    ./build.sh   # or: python3 src/scripts/make_page.py --skip-build
    ~/.pyenv/versions/anaconda3-2019.07/bin/python3 -m unittest tests/harness/test_scan_link.py -v

Skipped, with the reason, when the page is not built or Chrome, Deno or `websocket-client` is
missing.
"""

import functools
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))
SITE = os.path.join(PROJECT_ROOT, "build", "www")
SCANNER_PAGE = os.path.join(SITE, "scanner", "index.html")
RELAY_SCRIPT = os.path.join(HERE, "nostr_relay.js")

sys.path.insert(0, HERE)

try:
    import cdp
except ImportError as error:  # websocket-client is not installed
    cdp = None
    IMPORT_ERROR = str(error)

# A fake camera, granted without a prompt. Chrome's fake device is a moving test pattern, so a
# stream that is really live shows its frames advancing.
CHROME_ARGS = ("--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream")

# How long a joiner that should connect is given. Locally it takes about a second or two:
# Trystero announces itself 233, 533 and 1333 ms after joining, then every 5.3 s.
CONNECT_TIMEOUT = 45

# How long a joiner that must NOT connect is watched. Over ten times what a right link takes
# here, and two of Trystero's steady announce intervals, so both peers have certainly found each
# other on the relay and tried to connect.
REJECT_WINDOW = 15


class Server:
    """build/www over HTTP on a free localhost port, in a thread."""

    def __init__(self):
        handler = functools.partial(_QuietHandler, directory=SITE)
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.origin = "http://localhost:%d" % self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class Relay:
    """`nostr_relay.js` under Deno on a free localhost port."""

    def __init__(self):
        self.proc = subprocess.Popen(
            ["deno", "run", "--quiet", "--allow-net", RELAY_SCRIPT, "0"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        line = self.proc.stdout.readline().strip()

        if not line.startswith("listening "):
            self.close()
            raise RuntimeError("the test relay did not start: %r" % line)

        self.url = "ws://127.0.0.1:%s" % line.split()[1]

    def close(self):
        self.proc.terminate()

        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def js(value):
    """A Python value as a JavaScript literal."""
    return json.dumps(value)


@unittest.skipIf(cdp is None, "needs websocket-client: %s" % (IMPORT_ERROR if cdp is None else ""))
@unittest.skipUnless(os.path.isfile(SCANNER_PAGE), "the phone page is not built (%s); run ./build.sh" % SCANNER_PAGE)
@unittest.skipUnless(shutil.which("deno"), "needs Deno, to run the local Nostr relay")
class ScanLinkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.relay = Relay()

        try:
            cls.chrome = cdp.Chrome(extra_args=CHROME_ARGS)
        except Exception as error:  # no Chrome on this machine
            cls.relay.close()
            cls.server.close()
            raise unittest.SkipTest("could not start Chrome: %s" % error)

        # The host is the browser's first tab, the phone a second tab of the same browser.
        cls.host = cls.chrome
        cls.phone = cls.chrome.new_tab()

    @classmethod
    def tearDownClass(cls):
        cls.chrome.close()
        cls.relay.close()
        cls.server.close()

    # --- helpers --------------------------------------------------------------------------

    @property
    def scanner_url(self):
        """The phone page's base URL on the test server, as the host would put it in the QR."""
        return self.server.origin + "/scanner"

    def load(self, tab, url):
        """Loads `url` in `tab` afresh. Via about:blank, because a URL differing only in its hash
        would otherwise be a same-page navigation that runs nothing again; a fresh load also
        gives the page a fresh Trystero peer id, as a new phone would have."""
        tab.navigate("about:blank")
        tab.navigate(url)
        tab.wait_for_expression("!!window.housekiScanLink")

    def start_host(self, tab=None, page=None, scanner_base_url=None):
        """Loads the phone page with no hash in the host tab and hosts a session from it, through
        the same `createScanSession` the app calls, recording everything it reports in
        `window.__host`. Returns the session's link."""
        tab = tab or self.host
        self.load(tab, page or self.scanner_url + "/")
        # With no hash the page itself stops at "invalid link" and joins nothing.
        tab.wait_for_expression("document.getElementById('scanner-status').dataset.status === 'invalid-link'")
        return self.begin_session(tab, scanner_base_url)

    def begin_session(self, tab, scanner_base_url=None):
        """Hosts a new session in the page already loaded in `tab` (see start_host), replacing
        `window.__host`. Returns the session's link."""
        options = {"relayUrls": [self.relay.url]}

        if scanner_base_url is not None:
            options["scannerBaseUrl"] = scanner_base_url

        return tab.evaluate(
            """(() => {
              const session = housekiScanLink.createScanSession(%s);
              const log = window.__host = { session, statuses: [], rejected: [], streams: 0, video: null };
              session.onStatus((status, detail) => log.statuses.push(status));
              session.onRejected(({ error }) => log.rejected.push(error));
              session.onStream(stream => {
                log.streams += 1;
                const video = document.createElement('video');
                video.muted = true;
                video.autoplay = true;
                video.playsInline = true;
                video.srcObject = stream;
                document.body.append(video);
                log.video = video;
              });
              return session.url;
            })()"""
            % js(options)
        )

    def host_log(self, tab=None):
        """What the host has reported so far, and whether its received video is playing."""
        return (tab or self.host).evaluate(
            """(() => {
              const log = window.__host;
              const track = log.video && log.video.srcObject.getVideoTracks()[0];
              return {
                statuses: log.statuses,
                rejected: log.rejected,
                streams: log.streams,
                track: track ? { kind: track.kind, readyState: track.readyState } : null,
                videoWidth: log.video ? log.video.videoWidth : 0,
                currentTime: log.video ? log.video.currentTime : 0,
              };
            })()"""
        )

    def close_host(self, tab=None):
        (tab or self.host).evaluate("window.__host && window.__host.session.close(), true")

    def phone_status(self, tab=None):
        return (tab or self.phone).evaluate("document.getElementById('scanner-status').dataset.status")

    def assert_connects(self, link, host=None, phone=None):
        """Opens `link` in the phone tab (the real phone page) and checks the whole path: the
        phone says it is connected and shows its own camera, the host reports 'connected', and
        the host's copy of the phone's stream is a live video track whose frames advance."""
        host, phone = host or self.host, phone or self.phone
        self.load(phone, link)
        phone.wait_for_expression(
            "document.getElementById('scanner-status').dataset.status === 'connected'", timeout=CONNECT_TIMEOUT
        )
        # The phone shows its own camera full screen.
        phone.wait_for_expression("document.getElementById('scanner-video').videoWidth > 0", timeout=10)
        host.wait_for_expression("window.__host.statuses.includes('connected')", timeout=CONNECT_TIMEOUT)
        # Chrome does not play video in a background tab (measured: currentTime stays 0 there),
        # and opening the phone's link put the host's tab behind the phone's. The person at the
        # computer is looking at the host, so it comes to the front before its video is judged.
        host.send("Page.bringToFront")
        host.wait_for_expression("window.__host.video && window.__host.video.videoWidth > 0", timeout=20)

        first = self.host_log(host)
        time.sleep(1.5)
        later = self.host_log(host)

        self.assertEqual(first["track"], {"kind": "video", "readyState": "live"})
        self.assertGreater(first["streams"], 0)
        self.assertGreater(later["currentTime"], first["currentTime"], "the received video is not advancing")
        return later

    def watch_rejection(self, read_joiner_evidence, host=None):
        """Watches the host for REJECT_WINDOW seconds and fails if it ever gets further than
        'waiting' or receives a stream. Returns the password failures either side reported:
        the host's `onRejected` messages plus whatever `read_joiner_evidence()` returns."""
        host = host or self.host
        deadline = time.time() + REJECT_WINDOW

        while time.time() < deadline:
            log = self.host_log(host)
            self.assertEqual(set(log["statuses"]), {"waiting"}, "the host got past 'waiting': %r" % log)
            self.assertEqual(log["streams"], 0, "a stream reached the host")
            time.sleep(0.25)

        return self.host_log(host)["rejected"] + read_joiner_evidence()

    # --- tests ----------------------------------------------------------------------------

    def test_the_right_link_connects_and_streams_the_camera(self):
        """(a) The right link connects, and the camera streams to the host.

        Setup: a host session in one tab; its link opened in a second tab of the same browser
        (the real phone page, with the fake camera). Test: wait for both ends. Verifies the
        phone page reads the link, gets the camera, shows it and reports 'connected'; the host
        reports 'connected' and hands `onStream` a stream whose video track is live and whose
        frames advance in a <video> on the host's page. The link goes through /scanner, without
        a trailing slash, as the QR code says; the server's redirect to /scanner/ keeps the hash.
        Two tabs of one browser connecting is also the user's own way of trying it on a laptop.
        """
        link = self.start_host(scanner_base_url=self.scanner_url)
        self.assertTrue(link.startswith(self.scanner_url + "#v=1&"), link)

        try:
            log = self.assert_connects(link)
            print("\n[scan_link] right link: host statuses %r, video %dpx wide"
                  % (log["statuses"], log["videoWidth"]), file=sys.stderr)
            self.assertEqual(log["statuses"][0], "waiting")
            self.assertEqual(log["rejected"], [])
        finally:
            self.close_host()

    def test_a_wrong_password_never_connects(self):
        """(b) A link to the right room with the wrong password never connects.

        Setup: a host session; a link to its room with a different random password (same format,
        so the phone page accepts it and really tries), opened in the phone tab. Test: watch both
        ends for REJECT_WINDOW seconds, then open the right link in the same phone tab while the
        same host is still waiting. Verifies the host never gets past 'waiting' and never receives
        a stream, the phone never reports 'connected', and a password failure is reported by one
        side or the other -- and then that the right link connects at once, so the rejection was
        the password's doing, not a host that was not ready or a relay too slow.
        """
        link = self.start_host(scanner_base_url=self.scanner_url)

        try:
            wrong = self.host.evaluate(
                """(() => {
                  const link = housekiScanLink.decodeScanHash(%s);
                  const password = housekiScanLink.newScanSecrets().password;
                  return %s + housekiScanLink.encodeScanHash({ ...link, password });
                })()"""
                % (js(link.split("#", 1)[1]), js(self.scanner_url))
            )
            self.assertNotEqual(wrong, link)
            self.load(self.phone, wrong)

            phone_states = []

            def joiner_evidence():
                # The phone page shows 'wrong-password' when it was the side that could not
                # decrypt the host's offer or answer.
                return ["phone: " + state for state in phone_states if state == "wrong-password"]

            deadline = time.time() + REJECT_WINDOW

            while time.time() < deadline:
                state = self.phone_status()
                phone_states.append(state)
                self.assertNotEqual(state, "connected", "the phone with the wrong password connected")
                log = self.host_log()
                self.assertEqual(set(log["statuses"]), {"waiting"}, "the host got past 'waiting': %r" % log)
                self.assertEqual(log["streams"], 0, "a stream reached the host")
                time.sleep(0.25)

            evidence = self.host_log()["rejected"] + joiner_evidence()
            print("\n[scan_link] wrong password: rejected by %r" % sorted(set(evidence)), file=sys.stderr)
            self.assertTrue(evidence, "neither side reported a password failure, so the attempt was never made")

            # The control: the same host, still open, connects the right link.
            self.assert_connects(link)
        finally:
            self.close_host()

    def test_a_link_without_the_password_never_connects(self):
        """(c) The right room with no password at all never connects.

        Setup: a host session. First, its link with the `p=` field removed, opened in the phone
        page. Then, because the page refuses such a link before trying anything, a joiner that
        bypasses this project's code entirely: Trystero's own joinRoom, in the phone tab, with the
        right app id, room and relay but no password option, adding the fake camera's stream to
        any peer it meets. Test: watch for REJECT_WINDOW seconds, then open the right link.
        Verifies the page calls the password-less link invalid; the bare joiner never meets a
        peer and the host never gets past 'waiting' or receives a stream; a password failure is
        reported on one side; and the right link then connects to the same host.
        """
        link = self.start_host(scanner_base_url=self.scanner_url)

        try:
            room_id = self.host.evaluate("housekiScanLink.decodeScanHash(%s).roomId" % js(link.split("#", 1)[1]))
            no_password = self.scanner_url + "#" + "&".join(
                part for part in link.split("#", 1)[1].split("&") if not part.startswith("p=")
            )
            self.assertNotIn("&p=", no_password)

            # The phone page refuses a link with no password outright.
            self.load(self.phone, no_password)
            self.phone.wait_for_expression(
                "document.getElementById('scanner-status').dataset.status === 'invalid-link'", timeout=10
            )

            # A joiner that does not go through the page or scan_link.js at all.
            self.load(self.phone, self.scanner_url + "/")
            self.phone.evaluate(
                """(async () => {
                  const log = window.__bare = { joined: [], errors: [] };
                  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                  const room = housekiScanLink.joinRoom(
                    { appId: housekiScanLink.SCAN_APP_ID, relayConfig: { urls: [%s] } },
                    %s,
                    { onJoinError: ({ error }) => log.errors.push(error) },
                  );
                  room.onPeerJoin = peerId => { log.joined.push(peerId); room.addStream(stream, { target: peerId }); };
                  log.room = room;
                })(), true"""
                % (js(self.relay.url), js(room_id))
            )

            def joiner_evidence():
                bare = self.phone.evaluate("({ joined: window.__bare.joined, errors: window.__bare.errors })")
                self.assertEqual(bare["joined"], [], "the joiner without a password met the host")
                return ["joiner: " + error for error in bare["errors"]]

            evidence = self.watch_rejection(joiner_evidence)
            print("\n[scan_link] no password: rejected by %r" % sorted(set(evidence)), file=sys.stderr)
            self.assertTrue(any("password" in item for item in evidence),
                            "neither side reported a password failure, so the attempt was never made: %r" % evidence)

            # The control: the same host, still open, connects the right link.
            self.phone.evaluate("window.__bare.room.leave(), true")
            self.assert_connects(link)
        finally:
            self.close_host()

    def test_every_session_has_its_own_room_and_password(self):
        """(d) Two sessions get different room ids and different passwords.

        Setup: the host tab, served over HTTP. Test: create two sessions, giving no base URL,
        and decode their links. Verifies each room id and password is 22 base64url characters
        (16 random bytes), that neither repeats between the sessions nor equals the other field,
        and that with no base URL given a page served over http(s) links to its own origin's
        /scanner (so a local server works with no setting).
        """
        self.start_host(scanner_base_url=self.scanner_url)
        self.close_host()

        result = self.host.evaluate(
            """(() => {
              const sessions = [0, 1].map(() => housekiScanLink.createScanSession({ relayUrls: [%s] }));
              const links = sessions.map(session => session.url);
              sessions.forEach(session => session.close());
              return {
                links,
                decoded: links.map(url => housekiScanLink.decodeScanHash(url.split('#')[1])),
                origin: location.origin,
              };
            })()"""
            % js(self.relay.url)
        )
        first, second = result["decoded"]

        for link, decoded in zip(result["links"], result["decoded"]):
            self.assertTrue(link.startswith(result["origin"] + "/scanner#"), link)
            self.assertRegex(decoded["roomId"], r"^[A-Za-z0-9_-]{22}$")
            self.assertRegex(decoded["password"], r"^[A-Za-z0-9_-]{22}$")
            self.assertNotEqual(decoded["roomId"], decoded["password"])

        self.assertNotEqual(first["roomId"], second["roomId"])
        self.assertNotEqual(first["password"], second["password"])

    def test_closing_ends_the_session_and_the_relay_connections(self):
        """Leaving the scan mode ends the session; reopening it starts a fresh one that works.

        Setup: a host session with the phone connected and streaming, as in (a). Test: close the
        session; watch the relay sockets and the phone; then host a new session in the same page,
        without reloading it, and open its link in the phone tab. Verifies that after close() the
        page's relay websockets are closed and stay closed (Trystero on its own leaves them open
        and reconnecting, so the computer would keep talking to the relays after the mode
        closed); that the phone sees the computer leave; and that the new session, with a
        different room and password, reopens the relays and connects and streams as the first
        did. This is the user's flow: leaving the mode ends the session, reopening gives a fresh
        QR code and password.
        """
        sockets = "Object.values(housekiScanLink.getRelaySockets()).map(socket => socket.readyState)"
        first = self.start_host(scanner_base_url=self.scanner_url)

        try:
            self.assert_connects(first)
            self.assertEqual(self.host.evaluate(sockets), [1], "the session's relay socket is open")

            self.close_host()
            self.host.wait_for_expression(
                "Object.values(housekiScanLink.getRelaySockets()).every(socket => socket.readyState === 3)", timeout=5
            )
            self.phone.wait_for_expression(
                "document.getElementById('scanner-status').dataset.status === 'disconnected'", timeout=CONNECT_TIMEOUT
            )
            # Trystero would reconnect a dropped relay within about 3.3 s; it must not.
            time.sleep(5)
            self.assertEqual(self.host.evaluate(sockets), [3], "the relay socket reopened with no session")

            second = self.begin_session(self.host, self.scanner_url)
            self.assertNotEqual(second.split("#")[1], first.split("#")[1])
            log = self.assert_connects(second)
            self.assertEqual(log["statuses"], ["waiting", "connecting", "connected"])
            self.assertEqual(self.host.evaluate(sockets), [1], "the new session reopened the relay socket")
        finally:
            self.close_host()

    def test_a_new_link_opened_in_the_same_tab_joins_the_new_session(self):
        """A new session's link, opened in the tab still showing the old one, connects (T-0316).

        Setup: a host session with the phone tab connected and streaming, as in (a). The host
        then closes it and starts another (what New code, or leaving and reopening Rough scan,
        does), whose link differs from the first only after the '#'. Test: open the new link in
        the SAME phone tab by a plain navigation, not via about:blank -- what a person does when
        pasting the new link into the address bar of the tab they used before. A navigation that
        changes only the hash does not load the page again, so before T-0316 the page stayed in
        the old room, showing 'disconnected', and the host waited for ever.
        Verifies: the phone page loads itself afresh on the hash change (a marker left on the old
        page is gone) and the new session connects and streams.
        """
        first = self.start_host(scanner_base_url=self.scanner_url)

        try:
            self.assert_connects(first)
            self.phone.evaluate("window.__oldPage = true")
            self.close_host()
            self.phone.wait_for_expression(
                "document.getElementById('scanner-status').dataset.status === 'disconnected'", timeout=CONNECT_TIMEOUT
            )

            second = self.begin_session(self.host, self.scanner_url)
            self.assertEqual(second.split("#")[0], first.split("#")[0], "only the hash differs")
            self.assertNotEqual(second, first)

            # A plain navigation in the same tab, as pasting into the address bar does, to the
            # address the tab shows now with the new hash. Not `second` itself: the server
            # redirected /scanner to /scanner/, so `second` differs in its path too and would
            # load afresh anyway. The user's file:// links differ in the hash alone.
            same_page = self.phone.evaluate("location.href.split('#')[0]") + "#" + second.split("#", 1)[1]
            self.assertEqual(same_page.split("#")[0], self.phone.evaluate("location.href.split('#')[0]"))
            self.phone.send("Page.navigate", {"url": same_page})
            # The marker set on the old page is gone once the page has really loaded again.
            self.phone.wait_for_expression("!!window.housekiScanLink && window.__oldPage === undefined", timeout=15)
            self.phone.wait_for_expression(
                "document.getElementById('scanner-status').dataset.status === 'connected'", timeout=CONNECT_TIMEOUT
            )
            self.host.wait_for_expression("window.__host.statuses.includes('connected')", timeout=CONNECT_TIMEOUT)
            self.host.send("Page.bringToFront")
            self.host.wait_for_expression("window.__host.video && window.__host.video.videoWidth > 0", timeout=20)
        finally:
            self.close_host()

    def test_a_host_on_a_file_page_streams_from_a_separate_browser(self):
        """A host page opened from file://, with the phone in a separate browser.

        Setup: the built phone page opened from file:// in its own browser -- the app opens from
        file://, and this is the same single-file Vite build with Trystero bundled in -- hosting a
        session; a second browser process, standing in for the phone, opening the link over HTTP.
        Test: as (a). Verifies Trystero runs from a file:// page (no module or fetch it would need
        is refused there), that a host there links to the public site by default, and that two
        separate browsers connect as two tabs do.
        """
        computer = cdp.Chrome(extra_args=CHROME_ARGS)
        phone = None

        try:
            page = pathlib.Path(SCANNER_PAGE).as_uri()
            self.start_host(tab=computer, page=page, scanner_base_url=self.scanner_url)
            default = computer.evaluate(
                """(() => {
                  const session = housekiScanLink.createScanSession({ relayUrls: [%s] });
                  session.close();
                  return session.url.split('#')[0];
                })()"""
                % js(self.relay.url)
            )
            self.assertEqual(default, "https://houseki.app/scanner")

            link = computer.evaluate("window.__host.session.url")
            phone = cdp.Chrome(extra_args=CHROME_ARGS)
            log = self.assert_connects(link, host=computer, phone=phone)
            print("\n[scan_link] file:// host: statuses %r" % log["statuses"], file=sys.stderr)
        finally:
            if phone:
                phone.close()
            computer.close()


if __name__ == "__main__":
    unittest.main()
