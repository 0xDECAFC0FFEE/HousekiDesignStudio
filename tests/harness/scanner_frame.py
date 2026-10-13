"""The scanner inside the studio, for the browser harness (T-0337).

Until T-0337 Tools > Rough scan drew its QR code, the phone's camera and its panel in the studio's
own document, and the scanner tests read them there (`studio.evaluate("document.getElementById(
'scan-view')...")`). Now the studio opens the scan page, build/www/scanner/embed.html, in a modal
iframe (scanner_sdk.js), as any website does through /scanner.js. Served from the same test server
as the studio, the iframe is same-origin with it, so the harness can reach straight into it.

`ScannerFrame(tab)` is that iframe, with the methods the tests used on the studio's tab:

    scanner = ScannerFrame(studio)
    scanner.wait_for_expression("document.getElementById('scan-view').dataset.streaming === 'true'")
    scanner.evaluate("window.gemScanVision()")

Each expression is evaluated by the iframe's own window (`contentWindow.eval`), so `document`,
`window` and the scan page's globals are the scan page's, and the expressions read exactly as they
did against the studio. Before the scan page has loaded (or once the modal is gone) an expression
evaluates to None, which `wait_for_expression` keeps waiting through. `box(selector)` gives an
element's rectangle in the TAB's coordinates (the iframe's offset added), which is what a mouse
event or a screenshot clip needs. `send` is the tab's own, for the CDP commands that act on the
whole tab (input, screenshots, bringing it to the front).
"""

import json

# The modal's iframe, as scanner_sdk.js makes it (OVERLAY_ID 'houseki-scanner').
FRAME = "document.querySelector('#houseki-scanner iframe')"

# Whether the modal is open on the page.
OVERLAY_OPEN = "!!document.getElementById('houseki-scanner')"


def in_frame(expression):
    """A JS expression, for the TAB, that evaluates `expression` in the scan page's own window.
    `undefined` while there is no scan page to evaluate it in: no modal, or the iframe still on
    its first, empty document (the scan page's script publishes `housekiScanSession` as it
    starts, embed/main.js)."""
    return "(() => { const view = %s?.contentWindow;" \
           " return view?.housekiScanSession ? view.eval(%s) : undefined; })()" \
           % (FRAME, json.dumps(expression))


class ScannerFrame:
    def __init__(self, tab):
        self.tab = tab

    def send(self, method, params=None, timeout=60):
        return self.tab.send(method, params, timeout=timeout)

    def evaluate(self, expression, timeout=60):
        return self.tab.evaluate(in_frame(expression), timeout=timeout)

    def wait_for_expression(self, expression, timeout=30, interval=0.05):
        return self.tab.wait_for_expression(in_frame(expression), timeout=timeout, interval=interval)

    def is_open(self):
        """Whether the modal is up in the tab."""
        return bool(self.tab.evaluate(OVERLAY_OPEN))

    def box(self, selector):
        """The rectangle of the scan page's element matching `selector`, in the tab's own
        coordinates, or None when there is none."""
        return self.tab.evaluate(
            "(() => { const frame = %s; const element = frame?.contentDocument?.querySelector(%s);"
            " if (!element) return null; const f = frame.getBoundingClientRect();"
            " const r = element.getBoundingClientRect();"
            " return {x: f.x + r.x, y: f.y + r.y, width: r.width, height: r.height}; })()"
            % (FRAME, json.dumps(selector)))
