#!/usr/bin/env python3
"""Builds build/www/studio.html, the design app, as one self-contained file, and
build/www/index.html, the static landing page that links to it.

Everything read is under src/ and everything written is under build/, which is gitignored:

    src/web/      the Svelte app (src/web/src, built by Vite)
    src/js/       the GemCad reader and friends, inlined as classic scripts
    src/site/     the landing page, its theme and the logo
    src/resources/   the startup stone and the skybox
    src/scripts/  this script, the minifier it runs and the dev server
    build/web/    Vite's output; build/target/ Cargo's; build/www/ the deployable site

The app is a Svelte app, the project in src/web. This script first runs that build, which
yields build/web/index.html: the app's script and styles inlined into a small HTML shell
(src/web/index.html), by vite-plugin-singlefile. It then inlines everything that page needs
ahead of the app's script and writes build/www/studio.html, which opens directly from file://
and works equally over HTTP. Last, it writes the landing page from src/site (build_site below):
build/www/index.html, robots.txt, the social preview og-image.png and, once src/site/site.json
has the site's URL, sitemap.xml. It also builds the phone scanner page (src/web/scanner, T-0313, its own Vite config) and copies
it to build/www/scanner/index.html, served at /scanner (install_scanner_page below), with the
phone's prebuilt OpenCV next to it as build/www/scanner/opencv.js (install_scanner_opencv, T-0323).
All of build/www is generated: edit the app under src/web or the landing page under src/site,
then run ./build.sh (or this script).

Why inline everything: Chrome and Firefox give a file:// page an opaque `null` origin and
refuse an ES module import and every fetch(), including the .wasm binary and the .obj model.
Moving files next to the page changes nothing. (An inline <script type="module"> with no
imports is fine; it is loading a separate module file that is refused, and the Vite build
leaves none.) So nothing is left to load:

  * the wasm is bound with `wasm-bindgen --target no-modules`, which emits a classic script
    defining a global `wasm_bindgen` instead of an ES module;
  * that glue script and the .wasm binary are embedded gzip-compressed and base64 encoded
    (GEM_BINDINGS_GZIP_BASE64, GEM_WASM_GZIP_BASE64). The page inflates both with the
    browser's DecompressionStream, runs the glue as an inline script, and hands the binary
    to `wasm_bindgen.initSync`;
  * the startup stone is embedded as a string literal (GEM_MODEL_GCS, T-0149): a Gem Cut
    Studio design, src/resources/hex_cut_v2.gcs, which main() runs through the page's own .gcs
    reader at load time, the same path an opened .gcs file takes. The bare mesh
    src/resources/hex_cut_v2.obj is no longer inlined (2026-09-20);
  * the skybox image is embedded as base64 (GEM_ENVIRONMENT_IMAGE_BASE64), with its MIME
    type (GEM_ENVIRONMENT_IMAGE_TYPE) so the page can decode PNG and JPEG alike;
  * the GemCad reader, its OBJ writer, the polar design representation, the Gem Cut
    Studio .gcs reader, the design-to-mesh builder and the undo/redo stack
    (src/js/gemcad.js, src/js/gemcad_obj.js, src/js/design.js, src/js/gcs.js,
    src/js/design_mesh.js, src/js/edit_history.js) are embedded gzip-compressed and base64
    encoded together (GEM_GEMCAD_GZIP_BASE64). They are classic scripts publishing
    globalThis.GemCad, globalThis.GemCadObj, globalThis.GemCadDesign, globalThis.GemCutStudio,
    globalThis.DesignMesh and globalThis.EditHistory, and the page
    runs them the same way it runs the wasm-bindgen glue. They let the page open a .asc,
    .gem or .gcs faceting design, which it converts to OBJ text (T-0168: from the design's
    own facet planes when that succeeds, else from the file's own stored corners) and hands
    to the ordinary load path.

Size. The wasm binary was about 70% of the page, and base64 adds a third again, so
compressing it is the largest saving available: gzip takes it to about a third of its size.
gzip rather than brotli, because every current browser's DecompressionStream supports gzip.
The gzip is written by Zopfli (src/scripts/zopfli_gzip.js), which finds a shorter encoding of
the same format than zlib does. The skybox is embedded as is, because a PNG or JPEG is already
compressed. The release profile in Cargo.toml shrinks the binary before any of this, and the
shaders compiled into it are stripped of their comments (glsl_without_comments! in
src/renderer/lib.rs).

Minified. Vite minifies the app (esbuild: whitespace collapsed, every comment stripped, CSS
minified, every name mangled). The GemCad scripts and the wasm-bindgen glue are minified
too, before they are compressed (src/scripts/minify_page.js, run with Deno), with their own names
mangled but the globals they publish kept, and so is the script of inlined data this script
writes. A last step parses every script in the finished page, and the compressed ones before
compression, and fails the build if any comment is left. The checks below run on the built
app, so a mangled global is a build error, not a broken page. Pass --no-minify for a readable
page to debug.

The app is written against those globals, so the only substitutions are two placeholders:
the template notice comment and the inline bundle marker. Each must appear exactly once, the
app must use every inlined global, and it must not fetch or import anything. A violation is
a hard error rather than a silently broken page.

Usage:  python3 src/scripts/make_page.py [--output build/www/studio.html] [--skip-build]
                             [--skip-web-build]
                             [--no-minify]
"""

import argparse
import base64
import functools
import gzip
import html
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

# This script lives in src/scripts/, so the project root is two levels up. Everything it reads
# is under src/ (the app, the scripts, the landing page, the models) and everything it writes is
# under build/, which is gitignored.
PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = PROJECT_ROOT / "src"
BUILD = PROJECT_ROOT / "build"

# The Svelte app (src/web), and the single html file `vite build` writes from it: the "template"
# this script inlines the wasm, the model and the skybox into. Vite's outDir is set in
# src/web/vite.config.js and must agree with TEMPLATE below.
WEB_DIR = SRC / "web"
TEMPLATE = BUILD / "web" / "index.html"
# The phone scanner page (T-0313): src/web/scanner, built by its own Vite config
# (src/web/vite.scanner.config.js) into one file, and served at /scanner as
# build/www/scanner/index.html. The computer's scan mode links phones to it with a QR code.
SCANNER_BUILD = BUILD / "scanner" / "index.html"
# The phone page's OpenCV (T-0323): a committed, prebuilt opencv.js (rebuilt only by
# src/web/vendor/opencv/build_opencv_js.sh, never by this build), copied next to the phone page
# as build/www/scanner/opencv.js. It is the one file the phone page loads besides itself: about
# 6 MB, too big to inline into a page that must show the camera at once, so
# src/web/src/lib/vision/opencv.js adds it as a classic <script src> after the camera starts (a
# classic script loads from file:// too, where fetch() and module imports fail).
SCANNER_OPENCV = SRC / "web" / "vendor" / "opencv" / "opencv.js"
# The startup stone (T-0149): a Gem Cut Studio design, run through the page's own .gcs
# reader (gcs.js) at load time -- see GEM_MODEL_GCS below. The bare mesh
# src/resources/hex_cut_v2.obj is not inlined any more (2026-09-20); CLAUDE.md forbids editing
# that file, and the Rust tests and tools/'s CPU oracles read it directly from disk.
MODEL_GCS = SRC / "resources" / "hex_cut_v2.gcs"
# The skybox: a horizontal cross made from the equirectangular panorama
# src/resources/backrooms_skybox.jpeg by src/scripts/equirect_to_cross.py.
ENVIRONMENT = SRC / "resources" / "backrooms_skybox_cross.jpg"

# MIME type per supported environment image extension. The page hands the bytes to
# createImageBitmap as a Blob, which needs the right type to pick a decoder.
ENVIRONMENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}

# The GemCad reader (a port of the MIT-licensed LibGemcadFileReader), the writer that turns a
# parsed design into OBJ text, the polar tier representation the cutting-instructions pane
# reads (T-0147), the Gem Cut Studio .gcs reader (T-0148), and the design-to-mesh builder
# (T-0168) that turns a design's own facet planes into the OBJ text Rust renders, in place of
# a parsed file's stored corners. Concatenated in this order because gemcad_obj.js and
# design.js are both written against the data types gemcad.js produces; gcs.js is written
# against BOTH design.js (GemCadDesign.mastAngleOf, polarOf, tolerances.indexSnap) and the same
# GemCadFileData shape gemcad_obj.js expects, so it has to load after both; and design_mesh.js
# is written against BOTH design.js (GemCadDesign.planesOf) and gemcad_obj.js
# (GemCadObj.VertexWelder, polygonNormal, sanitiseName). edit_history.js, the undo/redo stack
# of the user's edits, depends on none of them and goes at the end. All six are classic
# scripts, so the page can run them exactly as it runs the wasm-bindgen glue.
GEMCAD_SCRIPTS = (
    SRC / "js" / "gemcad.js",
    SRC / "js" / "gemcad_obj.js",
    SRC / "js" / "design.js",
    SRC / "js" / "gcs.js",
    SRC / "js" / "design_mesh.js",
    SRC / "js" / "edit_history.js",
)

# Cargo's output, which .cargo/config.toml puts under build/target along with everything else
# this build generates.
WASM_INPUT = BUILD / "target" / "wasm32-unknown-unknown" / "release" / "gem_renderer.wasm"
BINDGEN_OUT = BUILD / "target" / "nomodules"

# The phone scanner's vision (T-0330): the Rust crate src/vision (a workspace member, never part of
# the studio), compiled to wasm with SIMD and bound like the renderer (no-modules glue), then packed
# into ONE classic script, build/vision/houseki_vision.js, that defines
# globalThis.HOUSEKI_VISION_WASM = { glue, wasm } (each gzip + base64). install_scanner_vision
# copies it next to the phone page as build/www/scanner/houseki_vision.js;
# src/web/src/lib/vision/vision_wasm.js loads it with a <script src> once the phone has connected
# and hands it to the vision Worker. Its own Cargo target directory, because it is compiled with
# different RUSTFLAGS (+simd128) from the renderer: sharing one would rebuild every dependency of
# each whenever the other is built.
VISION_PACKAGE = "houseki-vision"
VISION_TARGET_DIR = BUILD / "target" / "vision"
VISION_WASM_INPUT = VISION_TARGET_DIR / "wasm32-unknown-unknown" / "release" / "houseki_vision.wasm"
VISION_BINDGEN_OUT = BUILD / "vision" / "bindgen"
VISION_SCRIPT = BUILD / "vision" / "houseki_vision.js"
VISION_GLOBAL = "HOUSEKI_VISION_WASM"
VISION_RUSTFLAGS = "-C target-feature=+simd128"

# The app is build/www/studio.html (renamed from houseki.html 2026-09-21; first split from the
# landing page 2026-09-19). build/www/index.html is the landing page built
# from src/site (see build_site), so a domain's root serves a small, crawlable page rather than
# half a megabyte of inlined wasm. build/www is the whole deployable site and nothing else.
DEFAULT_OUTPUT = BUILD / "www" / "studio.html"

# The landing page's source, and its settings: `url`, the site's absolute address with a
# trailing slash (empty until there is a domain), and `docs`, where the documentation link
# goes. Every absolute URL on the page, in the sitemap and in robots.txt comes from `url`,
# so a domain is set in one place. `docs` is also the app's Help > Documentation link (T-0236):
# src/web/src/components/TopBar.svelte imports it from this same file and the Vite build
# bundles it, so this script never has to pass it to the app.
SITE_DIR = SRC / "site"
SITE_CONFIG = SITE_DIR / "site.json"
SITE_OUTPUT_DIR = BUILD / "www"
SITE_URL_PLACEHOLDER = "@@SITE_URL@@"
# A page's own absolute address (canonical, og:url): the site's URL plus the page's path. Like
# @@SITE_URL@@, every line holding it is dropped while the site has no URL. See with_site_url.
PAGE_URL_PLACEHOLDER = "@@PAGE_URL@@"
# The social preview (T-0320): a 1200x630 capture of the app that link previews (Open Graph,
# Twitter cards) show, and every site page names as its og:image. Checked in; regenerate it with
# tools/capture_og_image.py after a visible change to the app. Copied to build/www/og-image.png.
OG_IMAGE = SITE_DIR / "og-image.png"
# The landing page's list of features, a link per documentation page (T-0320): every page
# pages.json lists outside these sections, and not marked "wip".
LANDING_FEATURES_PLACEHOLDER = "@@FEATURES@@"
LANDING_SKIPPED_SECTIONS = ("Getting started",)
# The source files behind each published page, for its sitemap <lastmod> and its docs JSON-LD
# dateModified (T-0320): the date of the last commit touching any of them. Docs pages map to
# their own fragment and screenshots, in last_modified_sources.
APP_SOURCES = (SRC / "web", SRC / "renderer", SRC / "js", SRC / "resources")
# The user documentation (2026-09-24): pages.json, the shared _layout.html, the home page's
# _index.html, one article fragment per page and their screenshots in images/. See build_docs.
DOCS_DIR = SITE_DIR / "docs"

# The minifier, and how Deno runs it. Deno rather than node, which is broken on this machine
# (kb/build-and-test-commands.md). --allow-env and --allow-read because the npm packages it
# uses read their environment and their own files; it reads stdin and writes stdout.
MINIFIER = SRC / "scripts" / "minify_page.js"
DENO_RUN = ["deno", "run", "--quiet", "--allow-env", "--allow-read", str(MINIFIER)]

# The gzip compressor for the inlined parts (Zopfli; see gzip_bytes). Reads stdin, writes stdout,
# and needs no permissions.
ZOPFLI = SRC / "scripts" / "zopfli_gzip.js"

# The comment at the top of the template (src/web/index.html, which Vite passes through) that
# says it is the source. Replaced by a notice saying the output is generated, so neither file
# claims to be the other.
TEMPLATE_NOTICE = re.compile(r"<!-- TEMPLATE NOTICE\b.*?-->", re.DOTALL)

# Replaced by the glue script and the script holding the inlined data. It sits immediately
# before the app's own script, which reads the globals those define.
BUNDLE_PLACEHOLDER = "<!-- @@GEM_INLINE_BUNDLE@@ -->"

# The light/dark theme (2026-09-19), shared by the app and the site's pages: src/site/theme.js
# runs in each page's <head>, before the body is drawn, and src/site/theme.css is the light
# palette and the toggle's look. The app's placeholder is in src/web/index.html (its CSS is
# imported by the Vite build); the site's pages have one for each.
THEME_SCRIPT = SITE_DIR / "theme.js"
THEME_STYLE = SITE_DIR / "theme.css"
APP_THEME_PLACEHOLDER = "<!-- @@GEM_THEME_SCRIPT@@ -->"
SITE_THEME_SCRIPT_PLACEHOLDER = "@@THEME_SCRIPT@@"
SITE_THEME_STYLE_PLACEHOLDER = "@@THEME_STYLE@@"

# The logo (2026-09-19): one file, src/site/logo.svg, the gem with the user's smoke wisps (its
# wisp paths are tools/logo_wisps/warp.py's output). The site's pages take it inline at @@LOGO@@,
# as a decorative <svg class="mark">, and as their favicon at @@LOGO_ICON@@; the app takes the
# favicon at its own placeholder in src/web/index.html, and TopBar.svelte imports the file itself
# (Vite `?raw`) to draw it beside the title. It must hold no comment: it ends up inside the
# app's script and the site's markup.
LOGO = SITE_DIR / "logo.svg"
SITE_LOGO_PLACEHOLDER = "@@LOGO@@"
SITE_LOGO_ICON_PLACEHOLDER = "@@LOGO_ICON@@"
APP_LOGO_ICON_PLACEHOLDER = "<!-- @@GEM_LOGO_ICON@@ -->"


def logo_markup():
    """src/site/logo.svg as an inline, decorative <svg class="mark">."""
    svg = LOGO.read_text().strip()

    if "<!--" in svg or not svg.startswith("<svg "):
        fail(f"{LOGO} must be a bare <svg> element with no comments.")

    return svg.replace("<svg ", '<svg class="mark" aria-hidden="true" focusable="false" ', 1)


def logo_icon_href():
    """src/site/logo.svg as a data: URI for <link rel="icon">, percent-encoding only what a data URI
    in a double-quoted attribute needs, so the SVG stays readable in the page source."""
    svg = " ".join(LOGO.read_text().split())
    encoded = (svg.replace("%", "%25").replace('"', "'").replace("#", "%23")
               .replace("<", "%3C").replace(">", "%3E"))
    return "data:image/svg+xml," + encoded

# Everything the bundle defines. A template that stops using one would silently ship dead
# data, or more likely has been rewritten to load it some other way; either is an error.
REQUIRED_GLOBALS = (
    "wasm_bindgen.initSync",
    "GEM_BINDINGS_GZIP_BASE64",
    "GEM_WASM_GZIP_BASE64",
    "GEM_MODEL_GCS",
    "GEM_ENVIRONMENT_IMAGE_BASE64",
    "GEM_ENVIRONMENT_IMAGE_TYPE",
    "GEM_GEMCAD_GZIP_BASE64",
    # The globals the GemCad scripts publish once the page has run them. Named here so an
    # app that stopped opening .asc/.gem/.gcs files would stop shipping dead code.
    "GemCad.importBytes",
    "GemCadObj.toObjText",
    "GemCutStudio.importText",
    "DesignMesh.toObjText",
)

GENERATED_NOTICE = """<!--
  GENERATED FILE, do not edit. Built by src/scripts/make_page.py from the Svelte app in
  src/web (its Vite build, build/web/index.html), with the wasm module, its bindings, the
  model and the skybox image inlined so that the page opens directly from file:// with no
  server. Edit the app under src/web/src, then run ./build.sh.
-->"""


def fail(message):
    sys.exit(f"error: {message}")


def native_command(command):
    """`command`, made to run natively on Apple silicon when this Python runs under Rosetta.

    A translated process passes its architecture preference to all its children, so cargo
    would start `cc` and `xcrun` translated too, and the Command Line Tools, which are Apple
    silicon only, fail every link with "linking with `cc` failed". build.sh re-runs itself
    natively for the same reason, but it cannot do that for this script: pyenv's Python on
    this Mac is an x86_64-only binary, so it is translated whatever launched it. The failure
    only shows once cargo has to link build scripts again, for instance after a profile change.
    """
    try:
        probe = subprocess.run(
            ["sysctl", "-n", "sysctl.proc_translated"], capture_output=True, text=True
        )
    except OSError:
        return list(command)

    if probe.stdout.strip() == "1":
        return ["arch", "-arm64", *command]

    return list(command)


def run(command, **kwargs):
    print(f"==> {' '.join(str(part) for part in command)}")

    subprocess.run(native_command(command), check=True, cwd=PROJECT_ROOT, **kwargs)


def build_no_modules_bindings():
    """Compiles to wasm and generates the classic-script bindings."""
    if shutil.which("wasm-bindgen") is None:
        fail(
            "wasm-bindgen is not on PATH. Run ./setup.sh, and make sure "
            "~/.cargo/bin precedes the system path."
        )

    run(["cargo", "build", "--target", "wasm32-unknown-unknown", "--release"])

    # `--target no-modules` is the whole point: it emits a plain script that assigns a
    # global, rather than an ES module. A file:// page can run a plain inline script but
    # cannot import a module.
    run(
        [
            "wasm-bindgen",
            "--target",
            "no-modules",
            "--out-dir",
            str(BINDGEN_OUT),
            "--no-typescript",
            str(WASM_INPUT),
        ]
    )

    return BINDGEN_OUT / "gem_renderer.js", BINDGEN_OUT / "gem_renderer_bg.wasm"


def build_vision_bindings():
    """Compiles the phone's vision crate (src/vision) to wasm, with SIMD and no threads, and binds
    it with the no-modules glue. Returns the glue's and the wasm's paths."""
    if shutil.which("wasm-bindgen") is None:
        fail("wasm-bindgen is not on PATH. Run ./setup.sh, and make sure ~/.cargo/bin precedes the system path.")

    # WebAssembly SIMD (128-bit): Chrome 91+, Firefox 89+, Safari 16.4+, the same browsers the
    # phone's vision Worker already needs (OffscreenCanvas), and what opencv.js was built with.
    flags = " ".join(part for part in (os.environ.get("RUSTFLAGS", ""), VISION_RUSTFLAGS) if part)
    run(["cargo", "build", "-p", VISION_PACKAGE, "--lib", "--target", "wasm32-unknown-unknown", "--release",
         "--target-dir", str(VISION_TARGET_DIR)], env={**os.environ, "RUSTFLAGS": flags})
    run(["wasm-bindgen", "--target", "no-modules", "--out-dir", str(VISION_BINDGEN_OUT), "--no-typescript",
         str(VISION_WASM_INPUT)])
    return VISION_BINDGEN_OUT / "houseki_vision.js", VISION_BINDGEN_OUT / "houseki_vision_bg.wasm"


def build_vision_script(glue_path, wasm_path, minified):
    """Writes VISION_SCRIPT, the classic script the phone page loads for its vision: the glue
    (minified, when `minified`) and the wasm, each gzip-compressed (Zopfli) and base64 encoded,
    as globalThis.HOUSEKI_VISION_WASM = { glue, wasm }. Returns (description, raw bytes, bytes in
    the script) per part, for the size table."""
    glue = glue_path.read_text()
    glue_size = len(glue.encode("utf-8"))

    if "let wasm_bindgen" not in glue:
        fail(f"{glue_path} is not wasm-bindgen's no-modules glue (no `let wasm_bindgen`).")

    if minified:
        glue = minify(glue, "script", "vision wasm-bindgen glue")
        check_no_comments(glue, "check-script", "vision wasm-bindgen glue")

    wasm = wasm_path.read_bytes()
    glue_literal = base64_literal(gzip_bytes(glue.encode("utf-8")))
    wasm_literal = base64_literal(gzip_bytes(wasm))
    VISION_SCRIPT.parent.mkdir(parents=True, exist_ok=True)
    VISION_SCRIPT.write_text(f"globalThis.{VISION_GLOBAL}={{glue:{glue_literal},wasm:{wasm_literal}}};\n")
    return [
        ("phone vision wasm (gzip, base64)", len(wasm), len(wasm_literal)),
        ("phone vision glue (min, gzip, base64)" if minified else "phone vision glue (gzip, base64)", glue_size, len(glue_literal)),
    ]


def check_template(template, minified):
    """Fails unless the built app has both placeholders once and loads nothing itself."""
    name = TEMPLATE.relative_to(PROJECT_ROOT)

    notices = len(TEMPLATE_NOTICE.findall(template))

    if notices != 1:
        fail(f"expected exactly one '<!-- TEMPLATE NOTICE' comment in {name}, found {notices}.")

    page_script = check_uses_globals(template, name)

    # Anything that loads at runtime breaks the page from file://.
    if "fetch(" in template:
        fail(f"{name} calls fetch(), which a file:// page cannot do. Inline the data instead.")

    # An inline module script is fine; one that is loaded from somewhere is not, and neither is
    # a static or dynamic import. Vite's single-file build should never leave one, but a config
    # change (a lazy chunk, an asset kept outside the bundle) would, and only show from file://.
    if re.search(r"<script[^>]*\bsrc\s*=", template, re.IGNORECASE):
        fail(f"{name} loads a script by src=, which a file:// page cannot do. Inline it.")

    if re.search(r"<link[^>]*\brel\s*=\s*[\"']?(stylesheet|modulepreload)", template, re.IGNORECASE):
        fail(f"{name} links a stylesheet or module, which a file:// page cannot load.")

    # A static import would open an inline module script; a dynamic one can be anywhere, but is
    # only looked for in a minified app, whose every comment (which may talk about `import()`)
    # is gone.
    if re.search(r"<script[^>]*>\s*import[\s{*\"']", template, re.IGNORECASE):
        fail(f"{name} has an import statement, which a file:// page cannot load.")

    if minified and re.search(r"\bimport\s*\(", page_script):
        fail(f"{name} has a dynamic import(), which a file:// page cannot load.")


def check_uses_globals(template, name):
    """Fails unless the bundle placeholder appears once and the script after it uses every
    inlined global. Returns that script. Run on the built app, where Vite has already stripped
    every comment (so a name that only survived in a comment cannot satisfy this) and where a
    global the minifier had renamed would be missing."""
    placeholders = template.count(BUNDLE_PLACEHOLDER)

    if placeholders != 1:
        fail(f"expected exactly one {BUNDLE_PLACEHOLDER} in {name}, found {placeholders}.")

    page_script = template.split(BUNDLE_PLACEHOLDER, 1)[1]

    for global_name in REQUIRED_GLOBALS:
        if global_name not in page_script:
            fail(
                f"{name} never uses {global_name} after the bundle placeholder. The page "
                "must run from the inlined globals; update the app or this script."
            )

    return page_script


def build_web(minified):
    """Builds the Svelte app in src/web into build/web/index.html, with Vite under Deno.

    Deno rather than node, which is broken on this machine (kb/build-and-test-commands.md);
    `deno task build` runs the `build` script in src/web/package.json. The dependencies are
    pinned exactly there and installed into src/web/node_modules by ./setup.sh."""
    if shutil.which("deno") is None:
        fail("deno is not on PATH, and the app in src/web is built with it (Vite). Install Deno (https://deno.com).")

    if not (WEB_DIR / "node_modules").is_dir():
        fail(f"{WEB_DIR / 'node_modules'} does not exist. Run ./setup.sh (or `deno install` in src/web).")

    command = ["deno", "task", "build"]

    if not minified:
        # A readable app to debug; the flag goes straight to `vite build`.
        command += ["--minify", "false"]

    print(f"==> (in src/web) {' '.join(command)}")

    # Not native_command: Deno here is an x86_64 build, which `arch -arm64` cannot start.
    subprocess.run(command, check=True, cwd=WEB_DIR)

    if not TEMPLATE.is_file():
        fail(f"the web build did not write {TEMPLATE}.")

    # The phone scanner page, a separate small page with its own Vite config. Always minified:
    # it is not inlined into anything, and Vite's output is what is served.
    print("==> (in src/web) deno task build:scanner")
    subprocess.run(["deno", "task", "build:scanner"], check=True, cwd=WEB_DIR)

    if not SCANNER_BUILD.is_file():
        fail(f"the scanner page's build did not write {SCANNER_BUILD}.")


def minify(text, mode, description):
    """`text` minified by src/scripts/minify_page.js, `mode` "html" for a page or "script" for a
    classic script whose top-level names are globals other scripts read."""
    if shutil.which("deno") is None:
        fail(
            "deno is not on PATH, and the page is minified with it. Install Deno "
            "(https://deno.com), or pass --no-minify for an unminified page."
        )

    # Not native_command: Deno here is an x86_64 build, which `arch -arm64` cannot start.
    result = subprocess.run(
        [*DENO_RUN, mode], input=text, capture_output=True, text=True, cwd=PROJECT_ROOT
    )

    if result.returncode != 0 or not result.stdout:
        fail(f"minifying the {description} failed:\n{result.stderr}")

    return result.stdout


def check_no_comments(text, mode, description):
    """Fails unless `text` has no comment left, after minifying: `mode` "check-page" for the
    finished page (its inline scripts, parsed, and any HTML comment) or "check-script" for one
    script. Parsed by src/scripts/minify_page.js, so a `//` inside a string is not a comment."""
    result = subprocess.run(
        [*DENO_RUN, mode], input=text, capture_output=True, text=True, cwd=PROJECT_ROOT
    )

    if result.returncode != 0:
        fail(f"the minified {description} still has comments:\n{result.stderr}")


def inline_script_text(text, description):
    """Returns `text` unchanged, failing if it could end or confuse its <script> element."""
    if re.search(r"</script|<!--", text, re.IGNORECASE):
        fail(f"the {description} contains '</script' or '<!--' and cannot be inlined as is.")

    return text


def gzip_bytes(data):
    """`data` gzip-compressed with Zopfli (src/scripts/zopfli_gzip.js, under Deno), with a zero
    timestamp in the header, so unchanged inputs build a byte-identical page.

    Zopfli rather than zlib's level 9 (T-0238): it writes the same gzip format, which the page
    inflates the same way and as fast, but searches far harder for a short encoding. That made
    the wasm module's gzip 5.8% smaller for a couple of seconds of build time. The result is
    checked by inflating it here, so a broken compressor fails the build instead of the page.
    """
    if shutil.which("deno") is None:
        fail("deno is not on PATH, and the page's inlined parts are compressed with it. Install Deno (https://deno.com).")

    # Not native_command: Deno here is an x86_64 build, which `arch -arm64` cannot start.
    result = subprocess.run(
        ["deno", "run", "--quiet", str(ZOPFLI)], input=data, capture_output=True, cwd=PROJECT_ROOT
    )

    if result.returncode != 0 or not result.stdout:
        fail(f"compressing with {ZOPFLI.relative_to(PROJECT_ROOT)} failed:\n{result.stderr.decode(errors='replace')}")

    if gzip.decompress(result.stdout) != data:
        fail(f"{ZOPFLI.relative_to(PROJECT_ROOT)} wrote gzip that does not inflate to its input.")

    return result.stdout


def base64_literal(data):
    """`data` base64 encoded, as a JavaScript string literal."""
    return json.dumps(base64.b64encode(data).decode("ascii"))


def build_page(glue_path, wasm_path, minified):
    """Returns the page text, and (description, raw bytes, bytes in the page) per inlined part.

    With `minified`, the glue and the GemCad scripts are minified first (the app was minified
    by its own Vite build)."""
    template = TEMPLATE.read_text()
    check_template(template, minified)

    glue_bytes = glue_path.read_bytes()
    # Sizes before minifying, for the size table, so it shows what minifying saves too.
    glue_source_size = len(glue_bytes)

    if minified:
        glue_bytes = minify(glue_bytes.decode("utf-8"), "script", "wasm-bindgen glue").encode("utf-8")
        check_no_comments(glue_bytes.decode("utf-8"), "check-script", "wasm-bindgen glue")

    wasm_bytes = wasm_path.read_bytes()
    environment_bytes = ENVIRONMENT.read_bytes()

    # Base64 cannot contain '</script' or '<!--', so the compressed parts need no escaping check.
    bindings_literal = base64_literal(gzip_bytes(glue_bytes))
    wasm_literal = base64_literal(gzip_bytes(wasm_bytes))
    model_gcs_literal = inline_script_text(
        json.dumps(MODEL_GCS.read_text()), f"model ({MODEL_GCS})"
    )
    environment_literal = base64_literal(environment_bytes)

    # One compressed blob for both GemCad scripts: they are always run together, and gzip
    # does better on the pair than on each alone.
    gemcad_source = "\n".join(path.read_text() for path in GEMCAD_SCRIPTS)
    gemcad_source_size = len(gemcad_source.encode("utf-8"))

    if minified:
        gemcad_source = minify(gemcad_source, "script", "GemCad scripts")
        check_no_comments(gemcad_source, "check-script", "GemCad scripts")
    gemcad_literal = base64_literal(gzip_bytes(gemcad_source.encode("utf-8")))

    parts = [
        ("wasm binary (gzip, base64)", len(wasm_bytes), len(wasm_literal)),
        ("wasm-bindgen glue (min, gzip, base64)" if minified else "wasm-bindgen glue (gzip, base64)", glue_source_size, len(bindings_literal)),
        ("skybox image (base64)", len(environment_bytes), len(environment_literal)),
        ("GemCad reader (min, gzip, base64)" if minified else "GemCad reader (gzip, base64)", gemcad_source_size, len(gemcad_literal)),
        ("model (.gcs, startup)", len(MODEL_GCS.read_bytes()), len(model_gcs_literal)),
        # The Svelte app: its script and styles, inline in the shell, as Vite built them.
        ("app (Svelte, Vite build)", len(template.encode("utf-8")), len(template.encode("utf-8"))),
    ]
    environment_type = ENVIRONMENT_TYPES.get(ENVIRONMENT.suffix.lower())

    if environment_type is None:
        fail(
            f"{ENVIRONMENT} has an unsupported extension; expected one of "
            f"{', '.join(sorted(ENVIRONMENT_TYPES))}."
        )

    # The glue is not inlined as script text. The page inflates it and inserts it as its own
    # inline <script>, so its top-level `let wasm_bindgen` still becomes a global the page's
    # script can read.
    bundle_script = (
        "// The wasm-bindgen glue (no-modules target; defines the global `wasm_bindgen`) and the\n"
        "// .wasm binary, each gzip-compressed and base64 encoded. The page inflates both at\n"
        "// startup. Do not edit here; edit the Rust and run ./build.sh.\n"
        f"const GEM_BINDINGS_GZIP_BASE64 = {bindings_literal};\n"
        f"const GEM_WASM_GZIP_BASE64 = {wasm_literal};\n\n"
        "// The GemCad .asc/.gem reader, its OBJ writer, the polar design representation, the\n"
        "// Gem Cut Studio .gcs reader, the design-to-mesh builder and the undo/redo stack "
        f"({', '.join(str(path.relative_to(PROJECT_ROOT)) for path in GEMCAD_SCRIPTS)}),\n"
        "// concatenated, gzip-compressed and base64 encoded. The page runs them as an inline\n"
        "// script, which publishes globalThis.GemCad, globalThis.GemCadObj,\n"
        "// globalThis.GemCadDesign, globalThis.GemCutStudio, globalThis.DesignMesh and\n"
        "// globalThis.EditHistory.\n"
        f"const GEM_GEMCAD_GZIP_BASE64 = {gemcad_literal};\n\n"
        f"// The startup stone (T-0149), {MODEL_GCS.relative_to(PROJECT_ROOT)}: the app's boot\n"
        "// (src/web/src/lib/boot.js) runs this through the SAME .gcs reader path (objTextFromBytes)\n"
        "// an opened file takes.\n"
        f"const GEM_MODEL_GCS = {model_gcs_literal};\n\n"
        f"// The skybox, {ENVIRONMENT.relative_to(PROJECT_ROOT)}, base64 encoded.\n"
        f"const GEM_ENVIRONMENT_IMAGE_BASE64 = {environment_literal};\n"
        f"const GEM_ENVIRONMENT_IMAGE_TYPE = {json.dumps(environment_type)};\n"
    )

    # Minified like the other classic scripts: its comments go, and its top-level names, the
    # GEM_* globals the page reads, are kept. It is written here, after the app was built, so
    # it needs its own pass.
    if minified:
        bundle_script = minify(bundle_script, "script", "inlined data script")

    bundle = f"<script>\n{bundle_script}\n</script>"

    # Callables rather than replacement strings, so nothing in the inserted text is ever
    # interpreted as a backreference. A minified page gets no generated notice: every comment
    # goes from it (the check below fails the build if one is left), and being minified says
    # it is not the source.
    page = TEMPLATE_NOTICE.sub(
        lambda match: "" if minified else GENERATED_NOTICE, template, count=1
    )
    page = page.replace(BUNDLE_PLACEHOLDER, bundle, 1)

    if page.count(APP_THEME_PLACEHOLDER) != 1:
        fail(f"expected exactly one {APP_THEME_PLACEHOLDER} in {TEMPLATE.relative_to(PROJECT_ROOT)}.")

    theme_script = THEME_SCRIPT.read_text()

    if minified:
        theme_script = minify(theme_script, "script", "theme script")

    page = page.replace(APP_THEME_PLACEHOLDER, f"<script>\n{theme_script}\n</script>", 1)

    if page.count(APP_LOGO_ICON_PLACEHOLDER) != 1:
        fail(f"expected exactly one {APP_LOGO_ICON_PLACEHOLDER} in {TEMPLATE.relative_to(PROJECT_ROOT)}.")

    page = page.replace(APP_LOGO_ICON_PLACEHOLDER, f'<link rel="icon" href="{logo_icon_href()}">', 1)

    if "@@GEM_" in page or "TEMPLATE NOTICE" in page:
        fail("a placeholder survived substitution; the output would be broken.")

    # The last step of a minified build: nothing anywhere in the page may still be a comment.
    if minified:
        check_no_comments(page, "check-page", "page")

    return page, parts


def read_site_config():
    """src/site/site.json, checked: `url` empty or an absolute http(s) URL ending in "/", and
    `docs` a non-empty link."""
    config = json.loads(SITE_CONFIG.read_text())
    url = config.get("url", "")
    docs = config.get("docs", "")

    if url and not re.fullmatch(r"https?://[^\s\"<>]+/", url):
        fail(f"{SITE_CONFIG}: url must be empty or an absolute http(s) URL ending in '/', got {url!r}.")

    if not docs or re.search(r"[\s\"<>]", docs):
        fail(f"{SITE_CONFIG}: docs must be a non-empty link with no spaces or quotes, got {docs!r}.")

    return url, docs


def with_theme(page):
    """`page` (a site page's source) with src/site/theme.css and src/site/theme.js inlined at its
    @@THEME_STYLE@@ and @@THEME_SCRIPT@@, each of which must appear exactly once. Not minified:
    the site's pages are small, readable HTML."""
    for placeholder, source, tag in ((SITE_THEME_STYLE_PLACEHOLDER, THEME_STYLE, "style"),
                                     (SITE_THEME_SCRIPT_PLACEHOLDER, THEME_SCRIPT, "script")):
        if page.count(placeholder) != 1:
            fail(f"expected exactly one {placeholder} in a site page, found {page.count(placeholder)}.")

        page = page.replace(placeholder, f"<{tag}>\n{source.read_text()}</{tag}>", 1)

    # The logo, inline and as the favicon: once each on every site page.
    for placeholder, value in ((SITE_LOGO_PLACEHOLDER, logo_markup()),
                               (SITE_LOGO_ICON_PLACEHOLDER, logo_icon_href())):
        if page.count(placeholder) != 1:
            fail(f"expected exactly one {placeholder} in a site page, found {page.count(placeholder)}.")

        page = page.replace(placeholder, value, 1)

    if "@@" in page:
        fail("a placeholder survived in a site page; the output would be broken.")

    return page


def with_site_url(page, url, path):
    """`page` (a site page's source) with its absolute URLs filled in: @@SITE_URL@@ becomes `url`
    and @@PAGE_URL@@ the page's own address, `url` + `path` (its path from the site root, "" for
    the landing page). With no `url`, every line holding either is dropped instead, rather than
    published pointing nowhere -- which is why each such tag sits on a line of its own."""
    if url:
        return page.replace(PAGE_URL_PLACEHOLDER, url + path).replace(SITE_URL_PLACEHOLDER, url)

    return "".join(line for line in page.splitlines(keepends=True)
                   if SITE_URL_PLACEHOLDER not in line and PAGE_URL_PLACEHOLDER not in line)


def json_ld_script(data):
    """`data` as a <script type="application/ld+json"> element. Written from Python rather than
    in a page's source, so it is always valid JSON, whatever is or is not set."""
    return ('<script type="application/ld+json">'
            + json.dumps(data, indent=2).replace("</", "<\\/")
            + "</script>")


@functools.lru_cache(maxsize=None)
def last_modified(*sources):
    """The date (YYYY-MM-DD) of the last commit touching any of `sources` (paths), or None when
    git cannot say: no git, not a checkout, or none of them ever committed. A build must still
    work without it, so this never fails; the page just goes without a date.

    A shallow clone sees every file as last changed in its one commit, which is why the deploy
    workflow checks out the whole history (fetch-depth: 0)."""
    # Absolute paths, which git takes as long as they are inside the checkout; one outside it (a
    # test's copy of the docs, say) makes git fail, which is answered with None like the rest.
    try:
        result = subprocess.run(["git", "log", "-1", "--format=%cs", "--", *map(str, sources)],
                                capture_output=True, text=True, cwd=PROJECT_ROOT)
    except OSError:
        return None

    date = result.stdout.strip()

    return date if result.returncode == 0 and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) else None


def last_modified_sources(path, app_name):
    """The source files behind the published page at `path` (from the site root), for
    last_modified."""
    if path == "":
        return (SITE_DIR / "index.html",)

    if path == app_name:
        return APP_SOURCES

    if path == "docs.html":
        return (DOCS_DIR / "_index.html", DOCS_DIR / "pages.json")

    if path.startswith("docs/"):
        slug = path[len("docs/"):-len(".html")]
        return (DOCS_DIR / f"{slug}.html", DOCS_DIR / "images" / slug)

    return (SITE_DIR / path,)


def feature_pages(sections):
    """The documentation pages that describe a finished feature: every page outside
    LANDING_SKIPPED_SECTIONS not marked "wip", in pages.json's order. The landing page lists them
    and its JSON-LD names them as the app's featureList, so a new page shows up in both without
    anyone remembering to add it."""
    return [page for section in sections if section["title"] not in LANDING_SKIPPED_SECTIONS
            for page in section["pages"] if not page.get("wip")]


def landing_features(sections):
    """The landing page's feature list: a link to each feature_pages page, with its summary."""
    return "\n".join(f'      <li><a href="docs/{page["slug"]}.html">{html.escape(page["title"])}</a>'
                     f' <span>{html.escape(page["summary"])}</span></li>'
                     for page in feature_pages(sections))


def docs_nav(sections, current, to_docs):
    """The documentation sidebar: one heading per section of pages.json and a link per page,
    `current` (a slug, or None on the home page) marked as the page being read. `to_docs` is the
    relative path from the page being written to build/www/docs/ ("docs/" from the home page,
    "" from a page inside it)."""
    lines = []

    for section in sections:
        lines.append(f"    <h2>{html.escape(section['title'])}</h2>")
        lines.append("    <ul>")

        for page in section["pages"]:
            current_attr = ' aria-current="page"' if page["slug"] == current else ""
            badge = ' <span class="badge">In progress</span>' if page.get("wip") else ""
            lines.append(f'      <li><a href="{to_docs}{page["slug"]}.html"{current_attr}>'
                         f'{html.escape(page["title"])}{badge}</a></li>')

        lines.append("    </ul>")

    return "\n".join(lines)


def docs_cards(sections):
    """The home page's list of every page, a card per page under a heading per section."""
    lines = []

    for section in sections:
        lines.append(f"<h2>{html.escape(section['title'])}</h2>")
        lines.append('<ul class="cards">')

        for page in section["pages"]:
            badge = ' <span class="badge">In progress</span>' if page.get("wip") else ""
            lines.append(f'  <li><a href="docs/{page["slug"]}.html"><strong>{html.escape(page["title"])}{badge}</strong>'
                         f'<span>{html.escape(page["summary"])}</span></a></li>')

        lines.append("</ul>")

    return "\n".join(lines)


def docs_structured_data(title, description, url, path, modified):
    """A documentation page's JSON-LD (T-0320): a TechArticle, and with the site's `url` also a
    BreadcrumbList (home, documentation, this page) for the trail search results show under its
    title. `path` is the page's path from the site root and `modified` its last_modified date,
    or None."""
    article = {
        "@type": "TechArticle",
        "headline": title,
        "description": description,
        "inLanguage": "en",
        "isPartOf": {"@type": "WebSite", "name": "Houseki Design Studio"},
        "publisher": {"@type": "Organization", "name": "Houseki Design Studio"},
    }

    if modified:
        article["dateModified"] = modified

    if not url:
        return {"@context": "https://schema.org", **article}

    article["url"] = url + path
    article["image"] = url + OG_IMAGE.name
    article["isPartOf"]["url"] = url
    article["publisher"]["url"] = url
    trail = [("Houseki Design Studio", url), ("Documentation", url + "docs.html")]

    if path != "docs.html":
        trail.append((title, url + path))

    breadcrumbs = {
        "@type": "BreadcrumbList",
        "itemListElement": [{"@type": "ListItem", "position": position, "name": name, "item": item}
                            for position, (name, item) in enumerate(trail, 1)],
    }

    return {"@context": "https://schema.org", "@graph": [article, breadcrumbs]}


def docs_page(layout, sections, title, description, body, current, to_docs, to_root, docs_index,
              url, path, modified):
    """One documentation page: `layout` with its own placeholders filled, then its absolute URLs
    (`url` + `path`, see with_site_url), then the theme's. `modified` is the page's
    last_modified date, or None."""
    if "@@" in body:
        fail(f"the documentation page {title!r} contains '@@', which the layout uses for its placeholders.")

    structured = docs_structured_data(title, description, url, path, modified)
    page = (layout.replace("@@DOCS_TITLE@@", html.escape(title))
            .replace("@@DOCS_DESCRIPTION@@", html.escape(description, quote=True))
            .replace("@@DOCS_JSON_LD@@", json_ld_script(structured))
            .replace("@@DOCS_NAV@@", docs_nav(sections, current, to_docs))
            .replace("@@DOCS_INDEX@@", docs_index)
            .replace("@@DOCS_ROOT@@", to_root)
            .replace("@@DOCS_BODY@@", body.strip()))

    return with_theme(with_site_url(page, url, path))


def build_docs(url, app_name):
    """Writes the user documentation from src/site/docs/ and returns the paths written. `url` is
    the site's address, or "" (see with_site_url), and `app_name` the app's file name.

    pages.json lists the pages in order, in sections. Each page's article is the fragment
    src/site/docs/<slug>.html, wrapped in the shared _layout.html with the sidebar generated from
    pages.json; _index.html is the home page's, with the list of pages at its @@DOCS_CARDS@@. The
    home page is build/www/docs.html, where site.json's `docs` link points, and the pages are
    build/www/docs/<slug>.html. Screenshots live in src/site/docs/images/ and are copied to
    build/www/docs/images/.

    Every page listed must have a fragment, every fragment must be listed, and every image a
    page shows must exist, so a missing page or a broken screenshot fails the build rather than
    the published site."""
    config = json.loads((DOCS_DIR / "pages.json").read_text())
    sections = config["sections"]
    pages = [page for section in sections for page in section["pages"]]
    slugs = [page["slug"] for page in pages]
    layout = (DOCS_DIR / "_layout.html").read_text()

    if len(set(slugs)) != len(slugs):
        fail(f"{DOCS_DIR / 'pages.json'} lists a page twice.")

    fragments = {path.stem for path in DOCS_DIR.glob("*.html") if not path.name.startswith("_")}

    if fragments != set(slugs):
        fail(f"{DOCS_DIR}: pages.json and the page files disagree; missing files "
             f"{sorted(set(slugs) - fragments)}, unlisted files {sorted(fragments - set(slugs))}.")

    output_dir = SITE_OUTPUT_DIR / "docs"

    # Rebuilt from scratch, so a page or screenshot removed from the source leaves the site too.
    if output_dir.exists():
        shutil.rmtree(output_dir)

    output_dir.mkdir(parents=True)

    if (DOCS_DIR / "images").is_dir():
        shutil.copytree(DOCS_DIR / "images", output_dir / "images")

    written = []
    index_body = (DOCS_DIR / "_index.html").read_text().replace("@@DOCS_CARDS@@", docs_cards(sections))
    index = SITE_OUTPUT_DIR / "docs.html"
    index.write_text(docs_page(layout, sections, "Documentation",
                               "How to use Houseki Design Studio, the in-browser gem cut designer.",
                               index_body, None, "docs/", "", "docs.html", url, "docs.html",
                               last_modified(*last_modified_sources("docs.html", app_name))))
    written.append(index)

    for page in pages:
        body = (DOCS_DIR / f"{page['slug']}.html").read_text()

        for source in re.findall(r'<img[^>]*\bsrc="([^"]+)"', body):
            if not (DOCS_DIR / source).is_file():
                fail(f"{DOCS_DIR / (page['slug'] + '.html')} shows {source}, which does not exist.")

        path = output_dir / f"{page['slug']}.html"
        site_path = f"docs/{page['slug']}.html"
        path.write_text(docs_page(layout, sections, page["title"], page["summary"], body,
                                  page["slug"], "", "../", "../docs.html", url, site_path,
                                  last_modified(*last_modified_sources(site_path, app_name))))
        written.append(path)

    return written


def install_scanner_page(output_dir=None):
    """Copies the phone scanner page's build (SCANNER_BUILD) to <output_dir>/scanner/index.html,
    so the site serves it at /scanner, and returns that path. `output_dir` defaults to
    build/www.

    Fails unless the page is one self-contained file, like the app: it bundles Trystero, and the
    harness also opens it from file:// (tests/harness/test_scan_link.py), where a separate script
    or stylesheet could not load."""
    output_dir = SITE_OUTPUT_DIR if output_dir is None else output_dir
    page = SCANNER_BUILD.read_text()

    if re.search(r"<script[^>]*\bsrc\s*=", page, re.IGNORECASE):
        fail(f"{SCANNER_BUILD} loads a script by src=; the scanner page must be one file.")

    if re.search(r"<link[^>]*\brel\s*=\s*[\"']?(stylesheet|modulepreload)", page, re.IGNORECASE):
        fail(f"{SCANNER_BUILD} links a stylesheet or module; the scanner page must be one file.")

    path = output_dir / "scanner" / "index.html"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(page)
    return path


def install_scanner_opencv(output_dir=None):
    """Copies the phone page's OpenCV (SCANNER_OPENCV) to <output_dir>/scanner/opencv.js, next to
    the page, and returns that path. `output_dir` defaults to build/www.

    The page itself stays one file (install_scanner_page still refuses a <script src> in its
    HTML): OpenCV is added at runtime by src/web/src/lib/vision/opencv.js, which asks for
    "opencv.js" relative to the page. Fails if the committed file is missing or is not the UMD
    script that defines `cv`, so a broken copy is caught here rather than on a phone."""
    output_dir = SITE_OUTPUT_DIR if output_dir is None else output_dir

    if not SCANNER_OPENCV.is_file():
        fail(f"{SCANNER_OPENCV} is missing; it is committed (rebuild it with build_opencv_js.sh).")

    script = SCANNER_OPENCV.read_bytes()

    if b"root.cv = factory()" not in script:
        fail(f"{SCANNER_OPENCV} does not look like opencv.js (no UMD definition of cv).")

    path = output_dir / "scanner" / "opencv.js"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(script)
    return path


def install_scanner_vision(output_dir=None):
    """Copies the phone's vision script (VISION_SCRIPT) to <output_dir>/scanner/houseki_vision.js,
    next to the page, and returns that path. `output_dir` defaults to build/www. Fails if the
    script is missing or does not define its global, so a broken build is caught here rather than
    on a phone."""
    output_dir = SITE_OUTPUT_DIR if output_dir is None else output_dir

    if not VISION_SCRIPT.is_file():
        fail(f"{VISION_SCRIPT} is missing; build it (make_page.py without --skip-build).")

    script = VISION_SCRIPT.read_text()

    if not script.startswith(f"globalThis.{VISION_GLOBAL}="):
        fail(f"{VISION_SCRIPT} does not define globalThis.{VISION_GLOBAL}.")

    path = output_dir / "scanner" / VISION_SCRIPT.name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(script)
    return path


def build_site(app_output):
    """Writes the landing page (src/site/index.html) to build/www/index.html, with robots.txt and, once
    the site has a URL, sitemap.xml. Returns the paths written.

    The pages' absolute URLs (canonical, og:url, og:image) need the site's own address. Until
    src/site/site.json has one, every line holding a URL placeholder is dropped (with_site_url),
    rather than published pointing nowhere, and there is no sitemap, which must list absolute
    URLs. The structured data (JSON-LD) is written here rather than in the source, so it is
    always valid JSON whether or not the URL is set.

    The landing page's feature list and its JSON-LD featureList come from the documentation's
    pages.json (feature_pages), and its picture is a documentation screenshot, so both are
    checked once the docs are written: an <img> on the landing page that the site does not
    contain fails the build."""
    url, docs = read_site_config()
    app_name = app_output.name
    sections = json.loads((DOCS_DIR / "pages.json").read_text())["sections"]
    page = with_site_url((SITE_DIR / "index.html").read_text(), url, "")

    structured = {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": "Houseki Design Studio",
        "description": "A free gem cut designer and planner: open a faceting design (.gcs, .gem, .asc or .obj), "
                       "see the stone path-traced, and read its cutting instructions.",
        "applicationCategory": "DesignApplication",
        "operatingSystem": "Any",
        "browserRequirements": "Requires a web browser with WebGL 2",
        "isAccessibleForFree": True,
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "featureList": [feature["title"] for feature in feature_pages(sections)],
    }

    if url:
        structured["url"] = url + app_name
        structured["screenshot"] = url + OG_IMAGE.name

    page = (page.replace("@@JSON_LD@@", json_ld_script(structured), 1)
            .replace(LANDING_FEATURES_PLACEHOLDER, landing_features(sections), 1)
            .replace("@@DOCS_URL@@", docs))
    page = with_theme(page)

    if "@@" in page:
        fail("a placeholder survived in the landing page; the output would be broken.")

    written = []
    index = SITE_OUTPUT_DIR / "index.html"
    index.write_text(page)
    written.append(index)

    robots = "User-agent: *\nAllow: /\n" + (f"Sitemap: {url}sitemap.xml\n" if url else "")
    (SITE_OUTPUT_DIR / "robots.txt").write_text(robots)
    written.append(SITE_OUTPUT_DIR / "robots.txt")

    # The social preview every page names as its og:image. A checked-in file, so a missing one
    # is a broken checkout, not something to publish without.
    if not OG_IMAGE.is_file():
        fail(f"{OG_IMAGE} does not exist; capture it with tools/capture_og_image.py.")

    shutil.copyfile(OG_IMAGE, SITE_OUTPUT_DIR / OG_IMAGE.name)
    written.append(SITE_OUTPUT_DIR / OG_IMAGE.name)

    # The user documentation (2026-09-24): build/www/docs.html, its home page, and one page per
    # entry in src/site/docs/pages.json under build/www/docs/. Indexed and in the sitemap since
    # 2026-09-24, when it replaced the noindex "coming soon" placeholder with real pages.
    docs_written = build_docs(url, app_name)
    written += docs_written
    docs_paths = [path.relative_to(SITE_OUTPUT_DIR).as_posix() for path in docs_written]

    # The landing page shows a documentation screenshot, which only exists once the docs are
    # written; a renamed screenshot would otherwise leave the home page with a broken picture.
    for source in re.findall(r'<img[^>]*\bsrc="([^"]+)"', page):
        if not (SITE_OUTPUT_DIR / source).is_file():
            fail(f"the landing page shows {source}, which the built site does not contain.")

    sitemap = SITE_OUTPUT_DIR / "sitemap.xml"

    if url:
        entries = []

        for path in ("", app_name, "about.html", *docs_paths):
            modified = last_modified(*last_modified_sources(path, app_name))
            lastmod = f"<lastmod>{modified}</lastmod>" if modified else ""
            entries.append(f"  <url><loc>{url}{path}</loc>{lastmod}</url>\n")

        sitemap.write_text('<?xml version="1.0" encoding="UTF-8"?>\n'
                           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                           f"{''.join(entries)}</urlset>\n")
        written.append(sitemap)
    elif sitemap.exists():
        # A sitemap from a build that had a URL would now list a stale address.
        sitemap.unlink()

    # The about page, with its absolute URLs and the theme filled in the same way.
    about_page = with_theme(with_site_url((SITE_DIR / "about.html").read_text(), url, "about.html"))
    (SITE_OUTPUT_DIR / "about.html").write_text(about_page)
    written.append(SITE_OUTPUT_DIR / "about.html")

    return written


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="reuse the existing target/nomodules bindings instead of rebuilding",
    )
    parser.add_argument(
        "--skip-web-build",
        action="store_true",
        help="reuse the existing build/web/index.html instead of running the Vite build",
    )
    parser.add_argument(
        "--no-minify",
        action="store_true",
        help="leave the page, its script and the inlined scripts readable, for debugging",
    )
    arguments = parser.parse_args()

    if arguments.skip_web_build:
        for built in (TEMPLATE, SCANNER_BUILD):
            if not built.is_file():
                fail(f"--skip-web-build but {built} does not exist")
    else:
        build_web(minified=not arguments.no_minify)

    if arguments.skip_build:
        glue_path = BINDGEN_OUT / "gem_renderer.js"
        wasm_path = BINDGEN_OUT / "gem_renderer_bg.wasm"
        vision_glue = VISION_BINDGEN_OUT / "houseki_vision.js"
        vision_wasm = VISION_BINDGEN_OUT / "houseki_vision_bg.wasm"

        if not (glue_path.exists() and wasm_path.exists()):
            fail(f"--skip-build but {BINDGEN_OUT} has no bindings in it")

        if not (vision_glue.exists() and vision_wasm.exists()):
            fail(f"--skip-build but {VISION_BINDGEN_OUT} has no bindings in it")
    else:
        glue_path, wasm_path = build_no_modules_bindings()
        vision_glue, vision_wasm = build_vision_bindings()

    page, parts = build_page(glue_path, wasm_path, minified=not arguments.no_minify)
    # The phone's vision is not part of the studio page; its parts are listed after the page's.
    vision_parts = build_vision_script(vision_glue, vision_wasm, minified=not arguments.no_minify)

    output = arguments.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(page)

    size_kib = output.stat().st_size / 1024

    # What each inlined part costs, so a size regression can be traced to its source.
    print()
    width = max(len(description) for description, _, _ in parts)

    print(f"  {'inlined parts (KiB)':<{width}} {'source':>8}  {'in page':>8}")

    for description, raw_size, embedded_size in parts:
        print(f"  {description:<{width}} {raw_size / 1024:8.1f}  {embedded_size / 1024:8.1f}")

    print()
    print(f"wrote {output} ({size_kib:.0f} KiB)")
    print("open it directly in a browser; no server required.")
    print()
    print(f"  {'phone vision script (KiB)':<{width}} {'source':>8}  {'in file':>8}")

    for description, raw_size, embedded_size in vision_parts:
        print(f"  {description:<{width}} {raw_size / 1024:8.1f}  {embedded_size / 1024:8.1f}")

    print(f"wrote {VISION_SCRIPT} ({VISION_SCRIPT.stat().st_size / 1024:.1f} KiB)")

    # The landing page links to the app by its file name, so it is only built alongside the
    # app at its default path; an app written elsewhere (--output) leaves build/www/ alone.
    if output == DEFAULT_OUTPUT.resolve():
        for path in [*build_site(output), install_scanner_page(), install_scanner_opencv(), install_scanner_vision()]:
            print(f"wrote {path} ({path.stat().st_size / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
