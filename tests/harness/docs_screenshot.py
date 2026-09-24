"""Screenshots of the studio for the user documentation (src/site/docs/).

Drives the built app, build/www/studio.html, in headless Chrome, clicks and types like a person
would, and saves WebP screenshots of the whole window or of one element. Run ./build.sh first so
the screenshots show the current UI.

    from docs_screenshot import Studio

    with Studio() as studio:                        # a fresh profile: default settings
        studio.shot("src/site/docs/images/getting-started/overview.webp")
        studio.dblclick("#some-tier-row")           # any CSS selector
        studio.key("z", ctrl=True)                  # a keyboard shortcut
        studio.shot("src/site/docs/images/editing-tiers/tier.webp", selector=".tier-table")

Run it with the Python that has `websocket-client` (see cdp.py):
~/.pyenv/versions/anaconda3-2019.07/bin/python3.

Why these choices:

- **The real GPU (Metal) by default.** The software renderer takes seconds a frame, so a picture
  of the Monte Carlo renderer would take minutes to clear. Pass `gpu=False` for SwiftShader.
- **A 2x device scale factor**, so screenshots stay sharp on high-density screens. The window is
  1440x900 CSS pixels, a common laptop size, unless `width`/`height` say otherwise.
- **WebP, via cwebp**, because a PNG of a render is several times larger and the site is kept
  small. Screenshots are resized to at most 1600 pixels wide.
- **`settle()` waits for real frames**, not a fixed delay, so the render has caught up with the
  last click before the capture.
"""

import base64
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cdp  # noqa: E402

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STUDIO_HTML = os.path.join(PROJECT_ROOT, "build", "www", "studio.html")

# The widest a saved screenshot may be, in pixels: wide enough for a 2x capture of the article
# column, small enough to keep the site light.
MAX_WIDTH = 1600

# CDP's modifier bit mask for Input.dispatch*Event.
MODIFIERS = {"alt": 1, "ctrl": 2, "meta": 4, "shift": 8}


class Studio:
    def __init__(self, width=1440, height=900, scale=2, gpu=True, theme="dark", timeout=60):
        self.chrome = cdp.Chrome(timeout=timeout, gl_backend="metal" if gpu else None)
        self.chrome.send("Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": scale, "mobile": False,
        })
        # The theme is read from localStorage before the page paints (src/site/theme.js), so it
        # has to be saved before the page is loaded: load, save, then load again.
        self.open()

        if theme == "light":
            self.chrome.evaluate("localStorage.setItem('houseki.theme', 'light')")
            self.open()

    def open(self, timeout=60):
        """Loads (or reloads) the studio and waits until the app is running."""
        if not os.path.isfile(STUDIO_HTML):
            raise RuntimeError("%s does not exist; run ./build.sh first" % STUDIO_HTML)

        self.chrome.navigate("file://" + STUDIO_HTML, timeout=timeout)
        self.chrome.wait_for_expression("!!window.gemApp", timeout=timeout)
        self.settle()

    # --- looking at the page -------------------------------------------------------------

    def js(self, expression):
        """Evaluates `expression` in the page and returns its value."""
        return self.chrome.evaluate(expression)

    def box(self, selector):
        """The element's bounding box in CSS pixels, {x, y, width, height}; raises if absent."""
        box = self.js(
            "(() => { const e = document.querySelector(%r); if (!e) return null;"
            " e.scrollIntoView({block: 'nearest'}); const r = e.getBoundingClientRect();"
            " return {x: r.x, y: r.y, width: r.width, height: r.height}; })()" % selector)

        if box is None:
            raise RuntimeError("no element matches %r" % selector)

        return box

    def center(self, selector):
        box = self.box(selector)
        return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

    # --- acting like a person --------------------------------------------------------------

    def mouse(self, kind, x, y, button="left", clicks=1, modifiers=0):
        self.chrome.send("Input.dispatchMouseEvent", {
            "type": kind, "x": x, "y": y, "button": button, "clickCount": clicks,
            "modifiers": modifiers,
        })

    def click_at(self, x, y, clicks=1, button="left", settle=True):
        """Clicks at a point in CSS pixels; `clicks=2` is a double click."""
        self.mouse("mouseMoved", x, y, button="none")

        for count in range(1, clicks + 1):
            self.mouse("mousePressed", x, y, button=button, clicks=count)
            self.mouse("mouseReleased", x, y, button=button, clicks=count)

        if settle:
            self.settle()

    def click(self, selector, clicks=1):
        self.click_at(*self.center(selector), clicks=clicks)

    def dblclick(self, selector):
        self.click(selector, clicks=2)

    def hover(self, selector=None, x=None, y=None):
        """Moves the mouse over an element (or a point), e.g. to show its tooltip."""
        if selector is not None:
            x, y = self.center(selector)

        self.mouse("mouseMoved", x, y, button="none")
        self.settle()

    def drag(self, x0, y0, x1, y1, steps=12, button="left", modifiers=0):
        """Presses at (x0, y0), moves to (x1, y1) in `steps`, and releases: an orbit, a slider
        drag, a scale drag."""
        self.mouse("mouseMoved", x0, y0, button="none")
        self.mouse("mousePressed", x0, y0, button=button, modifiers=modifiers)

        for step in range(1, steps + 1):
            t = step / steps
            self.mouse("mouseMoved", x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, button=button,
                       modifiers=modifiers)

        self.mouse("mouseReleased", x1, y1, button=button, modifiers=modifiers)
        self.settle()

    def key(self, key, ctrl=False, shift=False, alt=False, meta=False, code=None):
        """Presses and releases one key, with modifiers: key("z", ctrl=True), key("Escape")."""
        # A sum of ints, never a bool: CDP rejects `False` for its int32 `modifiers` field, which
        # `and`/`|` chains produce when no modifier is set.
        modifiers = sum(bit for flag, bit in ((ctrl, MODIFIERS["ctrl"]), (shift, MODIFIERS["shift"]),
                                              (alt, MODIFIERS["alt"]), (meta, MODIFIERS["meta"]))
                        if flag)
        text = key if len(key) == 1 and not (ctrl or meta or alt) else ""
        base = {"key": key, "modifiers": modifiers,
                "code": code or ("Key" + key.upper() if len(key) == 1 and key.isalpha() else key)}

        self.chrome.send("Input.dispatchKeyEvent", dict(base, type="keyDown", text=text))
        self.chrome.send("Input.dispatchKeyEvent", dict(base, type="keyUp"))
        self.settle()

    def type(self, text):
        """Types text into whatever has focus."""
        self.chrome.send("Input.insertText", {"text": text})
        self.settle()

    def set_file(self, selector, path):
        """Gives an <input type=file> a file from disk, as choosing it in the file dialog would."""
        node = self.chrome.send("DOM.getDocument", {"depth": 0})["root"]["nodeId"]
        target = self.chrome.send("DOM.querySelector", {"nodeId": node, "selector": selector})["nodeId"]
        self.chrome.send("DOM.setFileInputFiles", {"nodeId": target, "files": [os.path.abspath(path)]})
        self.settle()

    def settle(self, frames=6, seconds=0.0):
        """Waits for `frames` animation frames (and then `seconds` more), so the page and the
        render have caught up with the last action."""
        self.chrome.send("Runtime.evaluate", {
            "expression": "new Promise(done => { let n = %d; const tick = () => --n > 0 ?"
                          " requestAnimationFrame(tick) : done(true); requestAnimationFrame(tick); })"
                          % frames,
            "awaitPromise": True,
        }, timeout=120)

        if seconds:
            time.sleep(seconds)

    # --- capturing -------------------------------------------------------------------------

    def shot(self, path, selector=None, padding=8, clip=None, quality=85):
        """Saves a WebP screenshot to `path`: the whole window, one element (`selector`, with
        `padding` CSS pixels around it), or a `clip` {x, y, width, height} in CSS pixels."""
        params = {"format": "png", "captureBeyondViewport": False}

        if selector is not None:
            box = self.box(selector)
            clip = {"x": max(0, box["x"] - padding), "y": max(0, box["y"] - padding),
                    "width": box["width"] + 2 * padding, "height": box["height"] + 2 * padding}

        if clip is not None:
            params["clip"] = dict(clip, scale=1)

        png = base64.b64decode(self.chrome.send("Page.captureScreenshot", params)["data"])
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as handle:
            handle.write(png)
            source = handle.name

        resize = ["-resize", str(MAX_WIDTH), "0"] if self._too_wide(png) else []

        try:
            subprocess.run(["cwebp", "-quiet", "-q", str(quality), *resize, source, "-o", path],
                           check=True)
        finally:
            os.unlink(source)

        return path

    @staticmethod
    def _too_wide(png):
        # A PNG's width is the big-endian int at bytes 16..20 of its IHDR chunk.
        return int.from_bytes(png[16:20], "big") > MAX_WIDTH

    def close(self):
        self.chrome.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()
