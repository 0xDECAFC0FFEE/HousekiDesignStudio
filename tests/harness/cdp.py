"""Minimal Chrome DevTools Protocol client, for driving our renderer headlessly.

This is a from-scratch rebuild of the "lost" harness described in
kb/browser-harness.md (it was missing from this copy of the tree, T-0001). It only
implements what T-0094's comparison harness needs: launch headless Chrome with a
software WebGL2 context, navigate to a local page, and evaluate JS in it.

Needs `websocket-client` (module name `websocket`). The default `python3` on this
machine does not have it; `~/.pyenv/versions/anaconda3-2019.07/bin/python3` does (see
kb/toolchain-and-environment.md). `tools/compare_render.sh` picks that interpreter.

Five load-bearing details, each documented in kb/browser-harness.md because an earlier
agent got each one wrong once:

1. `--remote-allow-origins=*` -- since Chrome 111 the debug endpoint 403s the websocket
   handshake without it.
2. Force WebGL2 onto software rendering: `--use-gl=angle --use-angle=swiftshader
   --enable-unsafe-swiftshader`. From Chrome 130 a headless context request silently
   returns null otherwise, which looks exactly like a renderer bug. `require_webgl2()`
   guards this so a missing context fails loudly instead.
3. Capture in the same JS task as the draw: `preserveDrawingBuffer` is false on this
   project's canvas, so `render()` and `toDataURL()` must be a single `Runtime.evaluate`
   call (done by the caller, not here -- see `tests/harness/gem.py`).
4. Poll for readiness rather than sleeping a fixed time: virtual/wall time and the
   page's own async startup (gunzip + wasm init) do not line up with a guessed delay.
5. A page script that reads an unknown parameter throws in JS. `evaluate()` surfaces
   that as a Python exception (via `exceptionDetails`) instead of swallowing it, so a
   stale parameter name fails loudly instead of silently leaving the page on defaults.
"""

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
]


def find_chrome():
    """Locates a Chrome/Chromium binary, or raises with the paths that were checked."""
    for candidate in CHROME_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    raise RuntimeError(
        "no Chrome binary found; checked: %s" % ", ".join(CHROME_CANDIDATES)
    )


def _free_port():
    """Asks the OS for an unused TCP port, so concurrent harness runs do not collide."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class Chrome:
    """One headless Chrome process, with a single page-level CDP websocket to it."""

    def __init__(self, timeout=30, gl_backend=None):
        """`gl_backend=None` (the default) is unchanged from before this parameter
        existed: forced software WebGL2 via SwiftShader, headless. This is what
        `tools/compare_luxcore.py`'s acceptance numbers were measured against
        (kb/luxcore-as-a-reference-oracle.md), so it must never move.

        `gl_backend="metal"` is an opt-in for callers that want the real GPU instead
        (T-0135's full-resolution re-render: SwiftShader measured ~2.8s/pass at
        1168x978, which made the 13-job batch a multi-hour undertaking a real GPU
        avoids). It swaps only the three software-rendering flags for ANGLE's Metal
        backend and stays headless otherwise. Confirm the swap actually took with
        `gpu_renderer_string()` below -- Chrome can silently fall back to software
        (or to a `swiftshader`-named Metal shim) if the real backend is unavailable,
        which would look identical to this working.
        """
        import websocket  # imported lazily so a clear error names the missing module

        self._websocket_module = websocket
        self.user_data_dir = tempfile.mkdtemp(prefix="gem-cdp-")
        self.port = _free_port()
        args = [
            find_chrome(),
            "--headless=new",
            "--remote-debugging-port=%d" % self.port,
            "--remote-allow-origins=*",  # trap 1: mandatory since Chrome 111
        ]
        if gl_backend is None:
            args += [
                "--use-gl=angle",  # trap 2: force a software WebGL2 context
                "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader",
            ]
        elif gl_backend == "metal":
            args += [
                "--use-gl=angle",
                "--use-angle=metal",
                "--ignore-gpu-blocklist",
                "--enable-gpu-rasterization",
            ]
        else:
            raise ValueError("gl_backend must be None or 'metal', got %r" % gl_backend)
        args += [
            "--no-sandbox",
            "--disable-gpu-sandbox",
            "--user-data-dir=%s" % self.user_data_dir,
            "--window-size=1024,1024",
            "--hide-scrollbars",
            "about:blank",
        ]
        self.proc = subprocess.Popen(
            args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        self._next_id = 1
        try:
            self._wait_for_debugger(timeout)
            self.ws = self._connect_page(timeout)
        except Exception:
            self.close()
            raise

    def _wait_for_debugger(self, timeout):
        deadline = time.time() + timeout
        last_error = None
        url = "http://127.0.0.1:%d/json/version" % self.port
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=1) as response:
                    json.loads(response.read().decode("utf-8"))
                    return
            except Exception as error:  # noqa: BLE001 -- retry until the deadline
                last_error = error
                time.sleep(0.1)
        raise TimeoutError(
            "Chrome debugger did not come up on port %d: %s" % (self.port, last_error)
        )

    def _connect_page(self, timeout):
        # Recent Chrome requires PUT for /json/new (a CSRF hardening change); a plain
        # GET 405s.
        url = "http://127.0.0.1:%d/json/new?about:blank" % self.port
        request = urllib.request.Request(url, method="PUT")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            target = json.loads(response.read().decode("utf-8"))
        return self._websocket_module.create_connection(
            target["webSocketDebuggerUrl"], timeout=timeout
        )

    def send(self, method, params=None, timeout=60):
        """Sends one CDP command and waits for its matching response.

        Ignores any other message (events, or replies to commands sent concurrently by
        something else) that arrives first, since this client only ever has one command
        in flight.
        """
        message_id = self._next_id
        self._next_id += 1
        self.ws.send(
            json.dumps({"id": message_id, "method": method, "params": params or {}})
        )

        deadline = time.time() + timeout
        while time.time() < deadline:
            self.ws.settimeout(max(0.1, deadline - time.time()))
            raw = self.ws.recv()
            message = json.loads(raw)
            if message.get("id") == message_id:
                if "error" in message:
                    raise RuntimeError("%s failed: %s" % (method, message["error"]))
                return message.get("result", {})
        raise TimeoutError("%s timed out after %ss" % (method, timeout))

    def navigate(self, url, timeout=30):
        """Navigates the page and waits for `document.readyState == 'complete'`.

        That only means the HTML document has loaded, not that this project's async
        `main()` has finished (it awaits a gunzip and a wasm init). Callers that need the
        app should poll for it, e.g. `wait_for_expression("window.gemApp")`.
        """
        self.send("Page.navigate", {"url": url}, timeout=timeout)
        self.wait_for_expression("document.readyState === 'complete'", timeout=timeout)

    def evaluate(self, expression, timeout=60):
        """Evaluates a JS expression and returns its value.

        Raises on a thrown JS exception rather than returning `undefined`, so a stale
        parameter name (trap 5 above) surfaces immediately.
        """
        result = self.send(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": False},
            timeout=timeout,
        )
        exception = result.get("exceptionDetails")
        if exception:
            detail = exception.get("exception", {}).get("description") or json.dumps(
                exception
            )
            raise RuntimeError("JS exception evaluating %r: %s" % (expression, detail))
        return result.get("result", {}).get("value")

    def wait_for_expression(self, expression, timeout=30, interval=0.05):
        """Polls a JS boolean expression instead of sleeping a fixed time (trap 4)."""
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            last = self.evaluate(expression)
            if last:
                return
            time.sleep(interval)
        raise TimeoutError(
            "timed out after %ss waiting for %r (last value: %r)"
            % (timeout, expression, last)
        )

    def require_webgl2(self):
        """Confirms the page can get a WebGL2 context, so a blank canvas is diagnosed
        as a missing/forced-off GPU context rather than a shader bug."""
        ok = self.evaluate(
            "(() => { try { const c = document.createElement('canvas');"
            " return !!c.getContext('webgl2'); } catch (e) { return false; } })()"
        )
        if not ok:
            raise RuntimeError(
                "WebGL2 is unavailable in this headless Chrome; check the "
                "--use-gl/--use-angle/--enable-unsafe-swiftshader flags"
            )

    def gpu_renderer_string(self):
        """The `UNMASKED_RENDERER_WEBGL` string for this context's WebGL2 backend.

        Added for T-0135's opt-in `gl_backend="metal"` path: asking for the real GPU
        does not guarantee getting it, so a caller that cares should check this
        contains the GPU's name (e.g. "Apple M1 Pro") rather than "SwiftShader" or
        "Software", instead of assuming the flags worked.
        """
        return self.evaluate(
            "(() => { const c = document.createElement('canvas');"
            " const gl = c.getContext('webgl2'); if (!gl) return null;"
            " const ext = gl.getExtension('WEBGL_debug_renderer_info');"
            " if (!ext) return gl.getParameter(gl.RENDERER);"
            " return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL); })()"
        )

    def close(self):
        try:
            if hasattr(self, "ws"):
                self.ws.close()
        except Exception:  # noqa: BLE001 -- best-effort cleanup
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            try:
                self.proc.kill()
            except Exception:  # noqa: BLE001
                pass
        # `tempfile.mkdtemp` does not clean itself up, and Chrome's own profile
        # directory (cache, cookies, a Crashpad database) is not something the caller
        # should have to remember to delete. Without this, every capture (every fast
        # comparison run, every retry) leaked one ~20-60MB directory; 22 accumulated
        # to 644MB over one afternoon of T-0094 development.
        shutil.rmtree(self.user_data_dir, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()
