#!/usr/bin/env bash
#
# One-time toolchain setup: the wasm target and a matching wasm-bindgen CLI.
#
# Safe to re-run; each step is skipped if it is already satisfied.

set -euo pipefail

# Under Rosetta, rustup would pick a translated host toolchain and cargo's link steps
# would call a translated `cc`, both of which fail against the Apple-silicon-only
# Command Line Tools. Re-run natively. See build.sh for the details.
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

echo "==> wasm-bindgen crate is pinned at $CRATE_VERSION"

# --- rust toolchain -----------------------------------------------------------

if ! command -v cargo >/dev/null 2>&1; then
    echo "error: cargo not found. Install Rust from https://rustup.rs first." >&2
    exit 1
fi

if command -v rustup >/dev/null 2>&1; then
    if rustup target list --installed | grep -qx wasm32-unknown-unknown; then
        echo "==> wasm32-unknown-unknown target already installed"
    else
        echo "==> installing wasm32-unknown-unknown target"
        rustup target add wasm32-unknown-unknown
    fi
else
    # A distribution-packaged rustc has no rustup, and usually ships only the host
    # target, so the wasm build would fail with a confusing "can't find crate for
    # `core`" error rather than anything about a missing target.
    echo "warning: rustup not found." >&2
    echo "         A distro rustc typically cannot target wasm32. If the build fails" >&2
    echo "         with \"can't find crate for 'core'\", install Rust via rustup:" >&2
    echo "         curl https://sh.rustup.rs -sSf | sh -s -- -y --target wasm32-unknown-unknown" >&2
fi

# --- wasm-bindgen CLI ---------------------------------------------------------

INSTALL_CLI=1

if command -v wasm-bindgen >/dev/null 2>&1; then
    CLI_VERSION=$(wasm-bindgen --version | awk '{print $2}')

    if [[ "$CLI_VERSION" == "$CRATE_VERSION" ]]; then
        echo "==> wasm-bindgen CLI $CLI_VERSION already matches"
        INSTALL_CLI=0
    else
        echo "==> wasm-bindgen CLI is $CLI_VERSION, need $CRATE_VERSION; reinstalling"
    fi
fi

if [[ "$INSTALL_CLI" == "1" ]]; then
    # Versions must match exactly: the generated JS glue carries a schema hash that the
    # crate checks, and a mismatch fails the build with an opaque error.
    echo "==> installing wasm-bindgen-cli $CRATE_VERSION (this takes a few minutes)"
    cargo install wasm-bindgen-cli --version "$CRATE_VERSION" --locked --force
fi

# --- Deno, for building and minifying the page -----------------------------------

# The page is a Svelte app in src/web, built with Vite, and make_page.py minifies its inlined
# scripts with src/scripts/minify_page.js; both run under Deno (node is broken on this machine).
# Installing and caching their pinned npm packages here means the build itself needs no network.
if command -v deno >/dev/null 2>&1; then
    echo "==> installing the app's npm packages (src/web/package.json, locked in src/web/deno.lock)"
    # Deno here is an x86_64 build, so it must not inherit this script's arm64 preference.
    # node_modules must sit next to package.json for Vite to resolve them, so it stays in
    # src/web and is gitignored there rather than moved under build/.
    (cd src/web && { arch -x86_64 deno install 2>/dev/null || deno install; })

    echo "==> caching the page minifier's npm packages"
    arch -x86_64 deno cache src/scripts/minify_page.js 2>/dev/null \
        || deno cache src/scripts/minify_page.js

    # Zopfli, which make_page.py gzips the inlined wasm module, its glue and the GemCad
    # scripts with (a smaller gzip than zlib's; the page inflates it the same way).
    echo "==> caching the page compressor's npm package"
    arch -x86_64 deno cache src/scripts/zopfli_gzip.js 2>/dev/null \
        || deno cache src/scripts/zopfli_gzip.js
else
    echo "error: deno not found. ./build.sh builds the page (Vite) and minifies it with Deno;" >&2
    echo "       install it from https://deno.com." >&2
    exit 1
fi

echo
echo "setup complete. Next:"
echo "  ./build.sh                   test, then build build/www/studio.html (the src/web app,"
echo "                               wasm, model and skybox inlined)"
echo "  open build/www/index.html    the landing page; build/www/studio.html is the app, no"
echo "                               server needed"
echo
echo "optional: install glslangValidator to enable GLSL compile checks in cargo test."
echo "          see the Setup section of kb/architecture.md"
