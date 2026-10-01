"""Renders one stone with both renderers and measures how far apart they are (T-0036).

The Monte Carlo renderer traces every ray against the stone, including light that has left it,
so on a concave stone it already follows light that crosses a groove or a hole and enters the
stone again. With the settings below the two renderers compute the same thing -- the same
lighting, one refractive index (no dispersion), no out-of-bounces shade, no observer -- so once
the Monte Carlo image has converged, what is left between them is its noise and the few ways the
two are known to differ (the bounce budget counts one interaction differently; the Monte Carlo
renderer reflects at the undispersed index). A deterministic renderer that looks light up the
moment it leaves the stone, as it did before T-0036, differs from it wherever the stone is
concave.

`compare` returns the mean absolute difference over the stone's pixels, in levels of 255, and
the PNGs of both renders. `tests/harness/test_concave.py` holds the renderers to it; run this
file directly to print the numbers for any built page and OBJ:

    python3 tests/harness/concave_compare.py [--page build/www/studio.html] [--metal] \
        [--out DIR] tests/fixtures/concave_grooved_bar.obj ...

Needs only the standard library and `websocket-client` (for `cdp.py`).
"""

import argparse
import base64
import json
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))
DEFAULT_PAGE = os.path.join(PROJECT_ROOT, "build", "www", "studio.html")

sys.path.insert(0, HERE)

import cdp  # noqa: E402

# The settings both renderers are drawn with.
#
# Angle Rings lights the upper hemisphere of the lighting frame (which follows the view) in four
# coloured bands by angle, and nothing below it: where a pixel's light came from shows as its
# colour, and there are no small bright sources to make the Monte Carlo image slow to converge. A
# camera ray that misses the stone leaves away from the viewer, below that horizon, so it is
# black -- which is also what makes the flat render a mask of the stone.
#
# The window colour is on, a mid grey: light from behind the stone (arriving from below the
# horizon, or leaving through a facet facing below it -- arrivingLight's two rules, which the
# Monte Carlo renderer applies too, T-0134) shows as grey rather than black. Without it most of
# a slab-like stone seen face up is black under either renderer, and a comparison of two black
# images proves little.
WINDOW_GREY = 0.5
SETTINGS = {
    "refractiveIndex": 1.54,  # quartz: most of a stone's rough is quartz-like, and TIR still matters
    "dispersion": 0.0,
    "maxBounces": 32,
    "exhaustionShade": 0.0,
    "observerRadius": 0.0,
    "absorptionScale": 0.0,
    "luxEnvironment": 0,  # the Monte Carlo renderer lit by this project's own lighting model
    "luxSamples": 1,
}

ANGLE_RINGS = 1
DETERMINISTIC = 0
# Pixels from the silhouette left out of the comparison, and the side of the blocks the second
# measure averages over; see `compare`.
EDGE_MARGIN = 2
BLOCK = 8
MONTE_CARLO = 1
FLAT = 2

# One render and its pixels in a single task: the canvas is not preserveDrawingBuffer, so the
# readback must follow the draw before the browser can present and clear it. `passes` renders
# accumulate for the Monte Carlo renderer and repeat harmlessly for the others.
RENDER_JS = """
(() => {
  const app = window.gemApp;
  const canvas = document.getElementById('canvas');
  const gl = canvas.getContext('webgl2');
  app.set_renderer(%(renderer)d);
  app.link_current_program();
  app.reset_accumulation();
  for (let pass = 0; pass < %(passes)d; pass += 1) {
    app.render(%(size)d, %(size)d);
  }
  const pixels = new Uint8Array(%(size)d * %(size)d * 4);
  gl.readPixels(0, 0, %(size)d, %(size)d, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let binary = '';
  for (let i = 0; i < pixels.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, pixels.subarray(i, i + 0x8000));
  }
  return [btoa(binary), canvas.toDataURL('image/png'), app.program_error ? String(app.program_error()) : ''];
})()
"""


def png(width, height, rgb_rows):
    """A PNG of 8-bit RGB rows (top first), with only zlib."""
    raw = b"".join(b"\0" + bytes(row) for row in rgb_rows)

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def side_by_side_png(size, deterministic, monte_carlo, gain=4):
    """The deterministic render, the Monte Carlo one, and their difference times `gain`, side by
    side, from `readPixels` bytes (RGBA, bottom row first)."""
    gap = 4
    rows = []

    for row in reversed(range(size)):
        line = bytearray()

        for image in (deterministic, monte_carlo, None):
            for column in range(size):
                at = (row * size + column) * 4

                if image is None:
                    line += bytes(min(255, gain * abs(deterministic[at + c] - monte_carlo[at + c])) for c in range(3))
                else:
                    line += image[at:at + 3]

            line += b"\x40\x40\x40" * gap

        rows.append(line)

    return png(3 * (size + gap), size, rows)


def open_page(chrome, page):
    """Loads the built page and waits for the renderer, keeping the lighting where it is put."""
    chrome.require_webgl2()
    chrome.navigate("file://" + os.path.abspath(page), timeout=60)
    chrome.wait_for_expression("typeof window.gemApp !== 'undefined' && window.gemApp !== null", timeout=60)
    # The page's skybox decode would switch the lighting to the image at a random moment
    # (kb/browser-harness.md); stubbing it keeps Isometric.
    chrome.evaluate("window.gemApp.set_environment_image = () => {}")


def render(chrome, renderer, size, passes):
    """(RGBA bytes, PNG bytes) of one render."""
    raw, data_url, error = chrome.evaluate(
        RENDER_JS % {"renderer": renderer, "size": size, "passes": passes}, timeout=3600
    )

    if error:
        raise RuntimeError("the page reports a program error: %s" % error)

    return base64.b64decode(raw), base64.b64decode(data_url.partition(",")[2])


def compare(chrome, obj_text, spin, tilt, size=320, samples=1024):
    """Renders `obj_text` at (`spin`, `tilt`) degrees with both renderers and the flat one.

    Returns a dict: `mean` and `worst_row`, the mean absolute difference between the
    deterministic and Monte Carlo renders over the stone's pixels, in levels of 255, and the
    largest over any one image row with at least 8 stone pixels (where a concave region shows
    up even if it is a small part of the stone); `stone_pixels`; `diagnostics`; and the PNGs
    under `deterministic_png`, `monte_carlo_png` and `mask_png`.
    """
    app = "window.gemApp"
    chrome.evaluate("%s.load_obj(%s)" % (app, json.dumps(obj_text)))
    chrome.evaluate("%s.set_lighting_model(%d)" % (app, ANGLE_RINGS))
    chrome.evaluate("%s.set_background(false, 0, 0, 0)" % app)
    chrome.evaluate("%s.set_window_color(true, %r, %r, %r)" % ((app,) + (WINDOW_GREY,) * 3))
    chrome.evaluate("%s.set_wireframe(false)" % app)
    chrome.evaluate("%s.set_debug_mode(0)" % app)

    for name, value in dict(SETTINGS, spin=spin, tilt=tilt).items():
        chrome.evaluate("%s.set_param(%s, %r)" % (app, json.dumps(name), float(value)))

    if int(chrome.evaluate("%s.lighting_model()" % app)) != ANGLE_RINGS:
        raise RuntimeError("the page changed the lighting model under the comparison")

    # The stone colour is exp(-absorption) = white with absorption off, and a miss is black
    # (no light below the horizon, and camera rays leave away from the viewer).
    mask, mask_png = render(chrome, FLAT, size, 1)
    deterministic, deterministic_png = render(chrome, DETERMINISTIC, size, 1)
    monte_carlo, monte_carlo_png = render(chrome, MONTE_CARLO, size, samples)

    # Only pixels well inside the stone's outline are compared: the Monte Carlo renderer spreads
    # each pixel's samples over the pixel and the deterministic renderer traces its centre, so
    # along the silhouette the two differ by the whole difference between stone and background.
    # A pixel counts when every pixel within EDGE_MARGIN of it is on the stone.
    def on_stone(row, column):
        return 0 <= row < size and 0 <= column < size and mask[(row * size + column) * 4] >= 128

    def well_inside(row, column):
        return all(
            on_stone(row + dr, column + dc)
            for dr in range(-EDGE_MARGIN, EDGE_MARGIN + 1)
            for dc in range(-EDGE_MARGIN, EDGE_MARGIN + 1)
        )

    total = 0
    count = 0
    worst_row = 0.0

    for row in range(size):
        row_total = 0
        row_count = 0

        for column in range(size):
            at = (row * size + column) * 4

            if not well_inside(row, column):
                continue

            row_total += sum(abs(deterministic[at + c] - monte_carlo[at + c]) for c in range(3))
            row_count += 3

        if row_count >= 24:
            worst_row = max(worst_row, row_total / row_count)

        total += row_total
        count += row_count

    # The same difference between BLOCK x BLOCK averages. Averaging first cancels what is not a
    # difference in the light: the Monte Carlo image's noise, and the aliasing of the lighting's
    # sharp band edges, which the Monte Carlo renderer spreads over each pixel while the
    # deterministic one takes at its centre, and which show as isolated bright pixels in either
    # image. A region where the two renderers send light somewhere different -- light that
    # should have re-entered the stone and was looked up in the lighting instead -- is a whole
    # patch, and survives the average. Only blocks entirely well inside the stone count.
    blocks = []

    for top in range(0, size - BLOCK + 1, BLOCK):
        for left in range(0, size - BLOCK + 1, BLOCK):
            cells = [(r, c) for r in range(top, top + BLOCK) for c in range(left, left + BLOCK)]

            if not all(well_inside(r, c) for r, c in cells):
                continue

            difference = 0.0

            for channel in range(3):
                d = sum(deterministic[(r * size + c) * 4 + channel] for r, c in cells)
                m = sum(monte_carlo[(r * size + c) * 4 + channel] for r, c in cells)
                difference += abs(d - m) / len(cells)

            blocks.append(difference / 3)

    blocks.sort()

    return {
        "mean": total / max(count, 1),
        "worst_row": worst_row,
        "block_mean": sum(blocks) / max(len(blocks), 1),
        "worst_block": blocks[-1] if blocks else 0.0,
        "blocks": len(blocks),
        "stone_pixels": count // 3,
        "diagnostics": chrome.evaluate("%s.diagnostics_text()" % app),
        "deterministic_png": deterministic_png,
        "monte_carlo_png": monte_carlo_png,
        "mask_png": mask_png,
        "side_by_side_png": side_by_side_png(size, deterministic, monte_carlo),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("objs", nargs="+")
    parser.add_argument("--page", default=DEFAULT_PAGE)
    parser.add_argument("--metal", action="store_true", help="the real GPU rather than SwiftShader")
    parser.add_argument("--spin", type=float, default=0.0)
    parser.add_argument("--tilt", type=float, default=25.0)
    parser.add_argument("--size", type=int, default=320)
    parser.add_argument("--samples", type=int, default=1024)
    parser.add_argument("--out", help="directory for the PNGs")
    args = parser.parse_args()

    with cdp.Chrome(gl_backend="metal" if args.metal else None) as chrome:
        open_page(chrome, args.page)
        print("backend:", chrome.gpu_renderer_string())

        for path in args.objs:
            result = compare(chrome, open(path).read(), args.spin, args.tilt, args.size, args.samples)
            name = os.path.splitext(os.path.basename(path))[0]
            print("%-24s |det - mc| mean %5.2f  worst row %5.2f  | %dpx blocks: mean %5.2f  worst %5.2f  (%d px, %d blocks)" % (
                name, result["mean"], result["worst_row"], BLOCK, result["block_mean"],
                result["worst_block"], result["stone_pixels"], result["blocks"]))

            if args.out:
                os.makedirs(args.out, exist_ok=True)

                for kind in ("deterministic", "monte_carlo", "mask", "side_by_side"):
                    with open(os.path.join(args.out, "%s_%s.png" % (name, kind)), "wb") as out:
                        out.write(result[kind + "_png"])


if __name__ == "__main__":
    main()
