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
build/www/index.html, robots.txt and, once src/site/site.json has the site's URL, sitemap.xml.
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
import gzip
import json
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


def build_site(app_output):
    """Writes the landing page (src/site/index.html) to build/www/index.html, with robots.txt and, once
    the site has a URL, sitemap.xml. Returns the paths written.

    The page's absolute URLs (canonical, og:url) need the site's own
    address. Until src/site/site.json has one, every line holding the URL placeholder is dropped,
    rather than published pointing nowhere, and there is no sitemap, which must list absolute
    URLs. The structured data (JSON-LD) is written here rather than in the source, so it is
    always valid JSON whether or not the URL is set."""
    url, docs = read_site_config()
    source = (SITE_DIR / "index.html").read_text()

    if url:
        page = source.replace(SITE_URL_PLACEHOLDER, url)
    else:
        page = "".join(line for line in source.splitlines(keepends=True)
                       if SITE_URL_PLACEHOLDER not in line)

    app_name = app_output.name
    structured = {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": "Houseki Design Studio",
        "description": "A gem cut designer and planner: open a faceting design (.gcs, .gem, .asc or .obj), "
                       "see the stone path-traced, and read its cutting instructions.",
        "applicationCategory": "DesignApplication",
        "operatingSystem": "Any",
        "browserRequirements": "Requires a web browser with WebGL 2",
    }

    if url:
        structured["url"] = url + app_name

    json_ld = ('<script type="application/ld+json">'
               + json.dumps(structured, indent=2).replace("</", "<\\/")
               + "</script>")
    page = page.replace("@@JSON_LD@@", json_ld, 1).replace("@@DOCS_URL@@", docs)
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

    sitemap = SITE_OUTPUT_DIR / "sitemap.xml"

    if url:
        entries = "".join(f"  <url><loc>{url}{path}</loc></url>\n" for path in ("", app_name, "about.html"))
        sitemap.write_text('<?xml version="1.0" encoding="UTF-8"?>\n'
                           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                           f"{entries}</urlset>\n")
        written.append(sitemap)
    elif sitemap.exists():
        # A sitemap from a build that had a URL would now list a stale address.
        sitemap.unlink()

    # The documentation placeholder (a "coming soon" page, marked noindex and left out of the
    # sitemap until it has content, 2026-09-19), with the theme filled in like the landing page.
    docs_page = with_theme((SITE_DIR / "docs.html").read_text())
    (SITE_OUTPUT_DIR / "docs.html").write_text(docs_page)
    written.append(SITE_OUTPUT_DIR / "docs.html")

    # The about page, with the theme filled in the same way.
    about_page = with_theme((SITE_DIR / "about.html").read_text())
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
        if not TEMPLATE.is_file():
            fail(f"--skip-web-build but {TEMPLATE} does not exist")
    else:
        build_web(minified=not arguments.no_minify)

    if arguments.skip_build:
        glue_path = BINDGEN_OUT / "gem_renderer.js"
        wasm_path = BINDGEN_OUT / "gem_renderer_bg.wasm"

        if not (glue_path.exists() and wasm_path.exists()):
            fail(f"--skip-build but {BINDGEN_OUT} has no bindings in it")
    else:
        glue_path, wasm_path = build_no_modules_bindings()

    page, parts = build_page(glue_path, wasm_path, minified=not arguments.no_minify)

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

    # The landing page links to the app by its file name, so it is only built alongside the
    # app at its default path; an app written elsewhere (--output) leaves build/www/ alone.
    if output == DEFAULT_OUTPUT.resolve():
        for path in build_site(output):
            print(f"wrote {path} ({path.stat().st_size / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
