#!/usr/bin/env bash
#
# Builds the renderer:
#
#   1. host tests (cargo test), so a broken build never reaches the browser;
#   2. build/www/houseki.html, the app, via src/scripts/make_page.py: the Svelte app in src/web
#      is built with Vite (under Deno, into the single file build/web/index.html), then the wasm
#      module and its no-modules bindings, the model and the skybox are inlined into it. One file
#      that opens directly from file://, and works just as well over HTTP. make_page.py then
#      writes the static landing page from src/site: build/www/index.html, robots.txt and, once
#      src/site/site.json has the site's URL, sitemap.xml.
#
# Layout: everything hand-written is under src/ (src/renderer the Rust, src/web the Svelte app,
# src/js the GemCad reader, src/site the landing page, src/resources the stone and skybox,
# src/scripts this build's Python and JS). Everything generated is under build/ (build/target
# from Cargo, build/web from Vite, build/www the deployable site), which is gitignored, as are
# kb/, tickets/ and reference/ -- none of which this build reads.
#
# Page size is kept down in two places. The release profile in Cargo.toml (one codegen
# unit, symbols stripped) shrinks the wasm module itself. make_page.py then inlines the
# module and its glue gzip-compressed, and the page inflates them with the browser's
# DecompressionStream; it prints what each inlined part costs. Vite minifies the app, and
# make_page.py minifies the inlined scripts (src/scripts/minify_page.js, under Deno): comments
# stripped, names mangled. `python3 src/scripts/make_page.py --no-minify` builds a readable page
# for debugging.
#
# Reconstructed from the old handoff's description (now kb/project-history.md) after the
# original went missing from this copy of the project (ticket T-0001). The separate ES-module
# build (www/pkg, www/models, www/environments) was removed in T-0016; since T-0210 the whole
# of the generated site is build/www, so there is nothing stale left at the root to clean up.

set -euo pipefail

# A shell running under Rosetta passes its architecture preference down to every child,
# so the universal `cc` and `xcrun` that cargo calls start translated. The Command Line
# Tools ship Apple silicon only, so every link step then fails with "unable to load
# libxcrun ... missing compatible architecture". Re-run natively instead.
if [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" == "1" ]]; then
    exec arch -arm64 /bin/bash "$0" "$@"
fi

cd "$(dirname "$0")"

# sed rather than `grep -oP`: -P is a GNU extension and macOS ships BSD grep, where it
# fails with "invalid option -- P".
CRATE_VERSION=$(sed -n 's/^wasm-bindgen = "=\([0-9.]*\)".*/\1/p' Cargo.toml)

if [[ -z "$CRATE_VERSION" ]]; then
    echo "error: could not read the pinned wasm-bindgen version from Cargo.toml." >&2
    exit 1
fi

if ! command -v wasm-bindgen >/dev/null 2>&1; then
    echo "error: wasm-bindgen is not on PATH. Run ./setup.sh, and make sure" >&2
    echo "       ~/.cargo/bin comes before the system path." >&2
    exit 1
fi

CLI_VERSION=$(wasm-bindgen --version | awk '{print $2}')

# Checked up front because a mismatch otherwise fails deep inside wasm-bindgen with an
# opaque schema hash error that says nothing about versions.
if [[ "$CLI_VERSION" != "$CRATE_VERSION" ]]; then
    echo "error: wasm-bindgen CLI is $CLI_VERSION but the crate is pinned at $CRATE_VERSION." >&2
    echo "       Run ./setup.sh to install the matching CLI." >&2
    exit 1
fi

echo "==> cargo test"
cargo test

# make_page.py builds the src/web app (Vite), compiles the wasm and runs wasm-bindgen itself.
# The app's npm packages come from ./setup.sh (`deno install` in src/web).
echo "==> building build/www/houseki.html and the landing page"
python3 src/scripts/make_page.py

echo
echo "build complete. Open build/www/houseki.html (the app) or build/www/index.html (the"
echo "landing page) directly; no server is needed."
