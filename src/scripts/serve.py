#!/usr/bin/env python3
"""Static file server for the renderer page.

Not needed to view the renderer: ``build/www/houseki.html`` is a single self-contained file,
built by ``./build.sh``, that opens directly from ``file://``. This is for tooling that wants
the page over HTTP (the lost browser harness in kb/browser-harness.md started it on port 8123),
and it adds no-cache headers so a rebuilt page is picked up on reload.

Serves ``build/www`` -- the whole deployable site and nothing else -- at ``/``, so the paths
here are the paths a real host would serve: the landing page at ``/``, the app at
``/houseki.html``, and ``/robots.txt`` and ``/sitemap.xml`` where crawlers look for them.
"""

import argparse
import functools
import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    """Adds no-cache headers so a rebuilt page is picked up on reload."""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, format, *args):
        # Quieter than the default, which logs every request on every reload.
        if not args or "200" not in str(args):
            super().log_message(format, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    arguments = parser.parse_args()

    # This file is src/scripts/serve.py, so the project root is two levels up.
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    root = os.path.join(project_root, "build", "www")

    if not os.path.isfile(os.path.join(root, "houseki.html")):
        print("warning: build/www/houseki.html does not exist yet, run ./build.sh first",
              file=sys.stderr)
        os.makedirs(root, exist_ok=True)

    handler = functools.partial(Handler, directory=root)

    with http.server.ThreadingHTTPServer((arguments.host, arguments.port), handler) as server:
        print(f"serving {root}")
        print(f"open http://{arguments.host}:{arguments.port}/houseki.html")
        print("press ctrl-c to stop")

        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
