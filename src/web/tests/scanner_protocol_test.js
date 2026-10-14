/*
 * scanner_protocol_test.js -- tests for how a website and the scanner it opens talk (T-0337):
 * src/web/src/lib/scanner_protocol.js, the shared vocabulary, and src/web/src/lib/scanner_host.js,
 * the scan page's side of the handshake. The website's side, scanner_sdk.js, builds a modal in a
 * real page, so it is tested there, by tests/harness/test_scan_mode.py (the studio opening the
 * scanner) and tests/harness/test_scanner_embed.py (another site opening it through /scanner.js).
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The scan page's window is a FAKE (`fakeWindow`): a `parent`, and an event target the test
 * dispatches `message` events on, each with the `source`, `origin` and `ports` the browser would
 * stamp. The channel is Deno's real MessageChannel, so what crosses it is really posted and
 * really received, asynchronously, as in a browser.
 */

const protocol = await import("../src/lib/scanner_protocol.js");
const { waitForSite } = await import("../src/lib/scanner_host.js");

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

/**
 * A scan page's window: framed by `parent` (or, with `framed: false`, its own parent, as a page
 * opened on its own is). `deliver(data, { source, origin, ports })` plays the browser handing it a
 * message. What the page posts to its parent lands in `parent.posted` as [data, targetOrigin].
 */
function fakeWindow({ framed = true } = {}) {
  const listeners = new Set();
  const win = {
    addEventListener: (type, listener) => type === "message" && listeners.add(listener),
    removeEventListener: (type, listener) => type === "message" && listeners.delete(listener),
    deliver(data, { source = win.parent, origin = "https://shop.example", ports = [] } = {}) {
      [...listeners].forEach(listener => listener({ data, source, origin, ports }));
    },
    listening: () => listeners.size,
  };

  const posted = [];

  win.parent = framed ? { name: "the website", posted, postMessage: (data, target) => posted.push([data, target]) } : win;
  win.posted = posted;
  return win;
}

/** The next message to arrive on `port`, or null if none comes within `ms`. */
function nextMessage(port, ms = 500) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);

    port.onmessage = event => {
      clearTimeout(timer);
      resolve(event.data);
    };
  });
}

Deno.test("defaultEmbedUrl picks the scan page beside the page over http(s), the published one otherwise", () => {
  // Setup: locations as the studio sees them -- the published site, a local test server, a page
  // opened from a file, and none at all.
  // Test: ask each for the scan page's address.
  // Verifies: a page served over http(s) gets the scan page on its own site, under /scanner/
  // beside the phone's page, so a local build tests itself and never the published one; a file://
  // page (whose origin is 'null') and a missing location get the published page.
  assertEqual(protocol.defaultEmbedUrl({ protocol: "https:", origin: "https://houseki.app" }),
    "https://houseki.app/scanner/embed.html", "the published site");
  assertEqual(protocol.defaultEmbedUrl({ protocol: "http:", origin: "http://127.0.0.1:8123" }),
    "http://127.0.0.1:8123/scanner/embed.html", "a local server");
  assertEqual(protocol.defaultEmbedUrl({ protocol: "file:", origin: "null" }), protocol.PUBLIC_EMBED_URL, "a file");
  assertEqual(protocol.defaultEmbedUrl(undefined), protocol.PUBLIC_EMBED_URL, "no location");
});

Deno.test("studioEmbedUrl opens the scan page in the same build when the studio is a file", () => {
  // Setup: the studio's locations -- opened from a file in a build, the published site, a local
  // test server, and none at all.
  // Test: ask each for the scan page the studio opens.
  // Verifies: from a file the studio opens scanner/embed.html beside studio.html in that same
  // build (so a local build shows its own scan page, not the published, possibly older one, which
  // is what a website's own file still gets from defaultEmbedUrl); over http(s), and with no
  // location, it is exactly defaultEmbedUrl's choice.
  const file = { protocol: "file:", origin: "null", href: "file:///Users/me/gems/build/www/studio.html#x" };
  assertEqual(protocol.studioEmbedUrl(file), "file:///Users/me/gems/build/www/scanner/embed.html", "a file");
  assertEqual(protocol.defaultEmbedUrl(file), protocol.PUBLIC_EMBED_URL, "a website's file is unchanged");
  assertEqual(protocol.studioEmbedUrl({ protocol: "https:", origin: "https://houseki.app" }),
    "https://houseki.app/scanner/embed.html", "the published site");
  assertEqual(protocol.studioEmbedUrl({ protocol: "http:", origin: "http://127.0.0.1:8123" }),
    "http://127.0.0.1:8123/scanner/embed.html", "a local server");
  assertEqual(protocol.studioEmbedUrl(undefined), protocol.PUBLIC_EMBED_URL, "no location");
});

Deno.test("the handshake is addressed to the scan page's own origin, and only a file falls back to '*'", () => {
  // Setup: scan page addresses on the published site, a local server and a file.
  // Test: ask embedTargetOrigin where the handshake may be delivered.
  // Verifies: the website posts the channel only to the scan page's exact origin, so a page that
  // navigated the frame elsewhere never receives it; '*' is used only for a file:// scan page,
  // whose 'null' origin no targetOrigin can name.
  assertEqual(protocol.embedTargetOrigin("https://houseki.app/scanner/embed.html"), "https://houseki.app", "published");
  assertEqual(protocol.embedTargetOrigin("http://127.0.0.1:8123/scanner/embed.html"), "http://127.0.0.1:8123", "local");
  assertEqual(protocol.embedTargetOrigin("file:///tmp/build/www/scanner/embed.html"), "*", "a file");
});

Deno.test("readScanMessage accepts each side's own message types and nothing else", () => {
  // Setup: messages as each side sends them, the other side's, and other scripts' messages.
  // Test: read each as from the scanner and as from the site.
  // Verifies: a message counts only with the protocol's tag and a type that side sends -- so a
  // website's own postMessage traffic, a bare string, or the site trying to send 'result' to itself
  // are all ignored rather than mistaken for the scanner's.
  const result = protocol.scanMessage("result", { result: { version: 1 } });

  assertEqual(protocol.readScanMessage(result, "scanner"), result, "the scanner's result");
  assertEqual(protocol.readScanMessage(result, "site"), null, "never as the site's");
  assertEqual(protocol.readScanMessage(protocol.scanMessage("init", { version: 1 }), "site").type, "init", "the site's init");
  assertEqual(protocol.readScanMessage(protocol.scanMessage("init"), "scanner"), null, "never as the scanner's");
  assertEqual(protocol.readScanMessage({ type: "result", result: {} }, "scanner"), null, "no protocol tag");
  assertEqual(protocol.readScanMessage("result", "scanner"), null, "not an object");
  assertEqual(protocol.readScanMessage(null, "site"), null, "nothing");
  assertEqual(protocol.scanMessage("status", { status: "waiting", protocol: "spoofed" }).protocol, protocol.SCAN_PROTOCOL,
    "a field cannot overwrite the tag");
});

Deno.test("siteName names the website as the person knows it, and admits when there is none", () => {
  // Setup: origins as the browser stamps them on the handshake.
  // Test: name each.
  // Verifies: the host (with its port) is what the scan page shows, "Scanning for shop.example";
  // a 'null' origin (a file, a sandboxed frame) and anything that is not a web origin get null,
  // which the page words as "a page on this computer" rather than inventing a name.
  assertEqual(protocol.siteName("https://shop.example"), "shop.example", "a website");
  assertEqual(protocol.siteName("http://localhost:8000"), "localhost:8000", "with its port");
  assertEqual(protocol.siteName("null"), null, "a file");
  assertEqual(protocol.siteName("chrome-extension://abc"), null, "not a website");
  assertEqual(protocol.siteName(undefined), null, "nothing");
});

Deno.test("siteStatus tells the website the scan's progress in its five words", () => {
  // Setup: every status the session reports, with and without the phone's camera showing.
  // Test: map each.
  // Verifies: the website hears only SITE_STATUSES; the camera showing is 'streaming' whatever the
  // status; 'connected' without a camera is still 'connecting' (as the scan page says it); an error
  // is an error even if a stale stream is up; an unknown status reads as 'waiting'.
  assertEqual(protocol.siteStatus("waiting", false), "waiting", "waiting");
  assertEqual(protocol.siteStatus("connecting", false), "connecting", "connecting");
  assertEqual(protocol.siteStatus("connected", false), "connecting", "connected, no camera yet");
  assertEqual(protocol.siteStatus("connected", true), "streaming", "the camera");
  assertEqual(protocol.siteStatus("disconnected", false), "disconnected", "the phone left");
  assertEqual(protocol.siteStatus("error", true), "error", "an error");
  assertEqual(protocol.siteStatus("something new", false), "waiting", "unknown");

  for (const status of ["waiting", "connecting", "connected", "disconnected", "error"]) {
    for (const streaming of [false, true]) {
      assert(protocol.SITE_STATUSES.includes(protocol.siteStatus(status, streaming)), `${status} maps into the five`);
    }
  }
});

Deno.test("the scan page accepts the framing website's handshake and talks to it over the channel", async () => {
  // Setup: a framed scan page waiting for a website, and a real MessageChannel the website made.
  // Test: deliver the website's init with one end of the channel; the page posts 'ready'; the
  // website posts 'close'.
  // Verifies: the page learns the website's origin as the browser stamped it; it stops listening
  // for handshakes once it has one; its messages reach the website over the channel, tagged; and
  // the website's messages reach the page's listener.
  const win = fakeWindow();
  const channel = new MessageChannel();
  let site = null;

  const waiting = waitForSite({ window: win, onInit: accepted => { site = accepted; } });

  assert(waiting.framed, "a framed page");
  win.deliver(protocol.scanMessage("init", { version: 1 }), { ports: [channel.port2] });
  assert(site !== null, "the handshake is accepted");
  assertEqual(site.origin, "https://shop.example", "with the website's origin");
  assertEqual(win.listening(), 0, "and no more handshakes are listened for");

  const ready = nextMessage(channel.port1);
  site.post("ready");
  assertEqual(await ready, { protocol: protocol.SCAN_PROTOCOL, type: "ready" }, "'ready' reaches the website");

  const heard = new Promise(resolve => site.onMessage(resolve));
  channel.port1.postMessage(protocol.scanMessage("close"));
  assertEqual((await heard).type, "close", "the website's 'close' reaches the page");

  site.close();
  channel.port1.close();
});

Deno.test("the scan page says hello to the window that framed it as soon as it listens", () => {
  // Setup: a framed scan page whose parent records what it is sent.
  // Test: start waiting for a website, then accept its init.
  // Verifies: the page greets its parent once, with the protocol's 'hello' and nothing else in it,
  // addressed to '*' (it cannot know the website's origin before the handshake, and the hello
  // carries nothing to protect) -- and only after it is listening, so a website that answers the
  // hello at once is heard. This is what lets a website send its handshake without waiting for
  // the frame's `load`, which came seconds late, or never, for a busy studio opened from a file.
  const win = fakeWindow();
  const channel = new MessageChannel();
  let listeningAtHello = null;

  win.parent.postMessage = (data, target) => {
    listeningAtHello = win.listening();
    win.posted.push([data, target]);
  };

  waitForSite({ window: win, onInit: site => site.close() });

  assertEqual(win.posted, [[{ protocol: protocol.SCAN_PROTOCOL, type: "hello" }, "*"]], "one hello, to '*'");
  assertEqual(listeningAtHello, 1, "sent once the page is listening");
  assertEqual(protocol.readScanMessage(win.posted[0][0], "scanner")?.type, "hello", "a message the website reads as the scanner's");

  win.deliver(protocol.scanMessage("init", { version: 1 }), { ports: [channel.port2] });
  assertEqual(win.posted.length, 1, "and no second hello after the handshake");
  channel.port1.close();
});

Deno.test("the scan page ignores handshakes from anyone but the window that framed it", async () => {
  // Setup: a framed scan page waiting for a website.
  // Test: deliver an init from another window (a frame inside the page, a page it opened), one
  // that is not the protocol's, and an init with no channel; then the real one; then a second.
  // Verifies: only the framing window's init with a channel is accepted, once: the others are not
  // taken for it (an init with no channel is refused, as it would leave nobody to talk to), and a
  // second handshake, from the framing window or not, cannot replace the first website.
  const win = fakeWindow();
  const accepted = [];
  const refused = [];
  // Every channel the test makes, closed at the end (Deno fails a test that leaves a port open).
  const channels = [];
  const port = () => {
    channels.push(new MessageChannel());
    return channels.at(-1).port2;
  };

  waitForSite({ window: win, onInit: site => accepted.push(site), onRefused: reason => refused.push(reason) });

  win.deliver(protocol.scanMessage("init", { version: 1 }), { source: { name: "another window" }, ports: [port()] });
  win.deliver({ type: "init", version: 1 }, { ports: [port()] });
  win.deliver(protocol.scanMessage("init", { version: 1 }), { ports: [] });
  assertEqual(accepted.length, 0, "none of those is accepted");
  assertEqual(refused, ["no-channel"], "the init without a channel is refused");

  win.deliver(protocol.scanMessage("init", { version: 1 }), { ports: [port()] });
  win.deliver(protocol.scanMessage("init", { version: 1 }), { origin: "https://evil.example", ports: [port()] });
  assertEqual(accepted.length, 1, "the framing window's is, once");
  assertEqual(accepted[0].origin, "https://shop.example", "and the first website stays");
  accepted[0].close();
  channels.forEach(channel => {
    channel.port1.close();
    channel.port2.close();
  });
});

Deno.test("a newer protocol version is refused, telling the website why", async () => {
  // Setup: a framed scan page, and a website speaking version 2, which this page does not know.
  // Test: deliver its init.
  // Verifies: the page does not start (no onInit), reports 'unsupported-version', and tells the
  // website over its channel with a 'cancel' carrying the reason, so the website's onCancel fires
  // rather than the modal waiting for ever.
  const win = fakeWindow();
  const channel = new MessageChannel();
  const refused = [];
  let started = false;

  waitForSite({ window: win, onInit: () => { started = true; }, onRefused: reason => refused.push(reason) });

  const told = nextMessage(channel.port1);
  win.deliver(protocol.scanMessage("init", { version: protocol.SCAN_PROTOCOL_VERSION + 1 }), { ports: [channel.port2] });

  assert(!started, "the scan does not start");
  assertEqual(refused, ["unsupported-version"], "refused");
  assertEqual(await told, { reason: "unsupported-version", protocol: protocol.SCAN_PROTOCOL, type: "cancel" }, "the website is told");
  channel.port1.close();
});

Deno.test("a page opened on its own is not framed and listens for nothing", () => {
  // Setup: a scan page whose parent is itself, as a page opened in its own tab is.
  // Test: wait for a website, and deliver an init as if from its own window.
  // Verifies: `framed` is false, so the page shows what it is for instead of starting a session;
  // it says hello to nobody; and nothing it receives is taken for a handshake.
  const win = fakeWindow({ framed: false });
  let started = false;

  const waiting = waitForSite({ window: win, onInit: () => { started = true; } });

  const channel = new MessageChannel();

  assert(!waiting.framed, "not framed");
  assertEqual(win.posted, [], "no hello: there is nobody to greet");
  win.deliver(protocol.scanMessage("init", { version: 1 }), { source: win, ports: [channel.port2] });
  assert(!started, "nothing starts");
  assertEqual(win.listening(), 0, "nothing listened for");
  channel.port1.close();
  channel.port2.close();
});
