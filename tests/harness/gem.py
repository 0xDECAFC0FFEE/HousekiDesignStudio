"""Drives `window.gemApp` in headless Chrome and captures a PNG, for T-0094's
LuxCore comparison harness.

Only what the comparison needs: load a stone (the built-in one, or an OBJ's text),
set the handful of parameters that have to match the LuxCore oracle scene, render at
an exact pixel size, and capture the canvas before the browser can clear it.

Since T-0120 the shader holds two path tracers -- the hand-written one and the ported
LuxCore one -- selected at runtime. `$GEM_RENDERER` picks which one is captured; see
`selected_renderer` below for why it is an environment variable.

Since T-0122 the ported path converges progressively, so `render()` is stateful: one call
adds one pass to a running average. A capture is therefore `reset_accumulation()` followed
by a fixed number of passes, which is reproducible for the same reason a single `render()`
used to be -- see `render_sequence_js` and the retry loop in `capture`.

Since T-0127 the ported path is lit by this project's own environment by default (the
lighting model the page shows), so `capture` asks it for LuxCore's native
`constantinfinite`-plus-suns rig instead whenever it is the renderer being captured -- that
is the scene the oracle renders. `$GEM_LUX_ENV` overrides it; see `selected_lux_environment`.
"""

import base64
import json
import os
import sys
import time

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# The app. build/www/index.html is the landing page since 2026-09-19.
INDEX_HTML = os.path.join(PROJECT_ROOT, "build", "www", "houseki.html")

# Names `set_param`/`get_param` in src/renderer/lib.rs accept, as of 2026-09-17. Kept here so a
# rename shows up as a loud `unknown parameter` JS exception (cdp.Chrome.evaluate
# surfaces it) instead of the silent-defaults failure kb/browser-harness.md warns about.
KNOWN_PARAMS = {
    "refractiveIndex",
    "dispersion",
    "absorptionScale",
    "maxBounces",
    "spectralSamples",
    "exposure",
    "envIntensity",
    "envRotation",
    "exhaustionShade",
    "observerRadius",
    "fov",
    "eyeDistance",
    "spin",
    "tilt",
    "headShadowHalfAngle",
    # Only the ported LuxCore path reads these; see src/renderer/params.rs's `Renderer`.
    "luxSamples",
    "luxSeed",
    "luxEnvironment",
}

# `params::LuxEnvironment::as_u32` in src/renderer/params.rs, and `LUX_ENVIRONMENT_*` in
# src/renderer/shaders/lux/lights.glsl (T-0127).
#
# "project" is this project's own environment -- the assessment models, the skybox image,
# the head-shadow cone -- which the ported renderer has lit the stone with since T-0127 and
# which the page defaults to. "luxcore" is LuxCore's own `constantinfinite` sky plus suns,
# i.e. the rig `tools/luxcore_oracle.py` builds its oracle scenes from.
LUX_ENVIRONMENTS = {"project": 0, "luxcore": 1}

# `params::Renderer::as_u32` in src/renderer/params.rs, and `RENDERER_*` in
# src/renderer/shaders/lux/host.glsl.
RENDERERS = {"handwritten": 0, "luxcore": 1}

# Environment variables that pick which of the two path tracers in the shader is measured
# (T-0120).
#
# Why an environment variable rather than a flag: tools/compare_luxcore.py owns the metrics
# and T-0120's brief forbids editing it, since changing how the measurement works is exactly
# what must not happen while the ported renderer is being scored against the baseline. The
# renderer choice is not part of the measurement -- it is which build is under test -- so it
# is passed in around the outside instead:
#
#     GEM_RENDERER=luxcore GEM_LUX_SAMPLES=64 tools/compare_render.sh --stone both --mode slow
#
# Unset, nothing changes and the hand-written renderer is measured exactly as before.
RENDERER_ENV = "GEM_RENDERER"
LUX_SAMPLES_ENV = "GEM_LUX_SAMPLES"
LUX_SEED_ENV = "GEM_LUX_SEED"

# Which environment the ported path is lit by, when it is the one being captured (T-0127).
#
# Defaults to LuxCore's own `constantinfinite` sky plus suns, because that is the scene the
# oracle renders and this harness exists to compare against the oracle -- exactly the same
# reasoning as the `lighting_model="isometric"` and `background=False` arguments `capture`
# already forces for the same purpose. Since T-0127 the ported path's *page* default is the
# opposite (the lighting model the page shows), so leaving this alone would quietly change
# what `tools/compare_luxcore.py` measures: our renderer would be lit by one environment and
# the oracle PNG by another, and the port's only acceptance test would stop being one.
#
# `GEM_LUX_ENV=project` overrides it, for measuring the other pairing deliberately.
LUX_ENV_ENV = "GEM_LUX_ENV"

# Samples each accumulation pass takes, i.e. how much work one `render()` does (T-0122).
#
# `$GEM_LUX_SAMPLES` keeps its old meaning -- samples per pixel in the captured image --
# so that a comparison run asks for the same amount of Monte Carlo work it always did.
# What changed is how that work is divided: the ported path now accumulates across
# `render()` calls, so the capture takes `GEM_LUX_SAMPLES / GEM_LUX_PASS_SAMPLES` passes
# instead of one enormous draw. One sample per pass is the natural unit and the page's own
# default; raising it only trades interruptibility for slightly less per-pass overhead.
LUX_PASS_SAMPLES_ENV = "GEM_LUX_PASS_SAMPLES"
DEFAULT_LUX_PASS_SAMPLES = 1


def selected_renderer():
    """The renderer `$GEM_RENDERER` asks for, or None to leave the page's default alone.

    Accepts a name or its integer encoding, and refuses anything else loudly: a typo that
    silently measured the wrong renderer would be indistinguishable from the port scoring
    identically to the renderer it replaces, which is the single most misleading result
    this harness could produce.
    """
    requested = os.environ.get(RENDERER_ENV)
    if requested is None or requested == "":
        return None

    key = requested.strip().lower()
    if key in RENDERERS:
        return RENDERERS[key]
    if key in {str(value) for value in RENDERERS.values()}:
        return int(key)

    raise ValueError(
        "%s=%r is not a renderer; choices are %s (or their integer encodings)"
        % (RENDERER_ENV, requested, sorted(RENDERERS))
    )


def selected_lux_environment():
    """The environment the ported path should be lit by, as its integer encoding.

    Refuses an unknown name loudly, for the same reason `selected_renderer` does: silently
    scoring the port against the oracle while the two were lit by different environments
    would look exactly like the port having drifted, and no metric in the report names the
    environment.
    """
    requested = os.environ.get(LUX_ENV_ENV)
    if requested in (None, ""):
        return LUX_ENVIRONMENTS["luxcore"]

    key = requested.strip().lower()
    if key in LUX_ENVIRONMENTS:
        return LUX_ENVIRONMENTS[key]
    if key in {str(value) for value in LUX_ENVIRONMENTS.values()}:
        return int(key)

    raise ValueError(
        "%s=%r is not an environment; choices are %s (or their integer encodings)"
        % (LUX_ENV_ENV, requested, sorted(LUX_ENVIRONMENTS))
    )


def renderer_params_from_env():
    """`{param: value}` for the ported path's own settings, from the environment.

    Both are plain `set_param` names, so they go through the same checked path every other
    parameter does.
    """
    params = {}
    for name, variable in (("luxSamples", LUX_SAMPLES_ENV), ("luxSeed", LUX_SEED_ENV)):
        value = os.environ.get(variable)
        if value not in (None, ""):
            params[name] = float(value)
    return params


# `LightingModel::as_u32` in src/renderer/params.rs.
LIGHTING_MODELS = {"studio": 0, "angleRings": 1, "isometric": 2, "cosine": 3, "image": 4}


def page_url():
    """`file://` URL for the built page, so no server is needed (it is self-contained;
    see kb/build-and-test-commands.md)."""
    if not os.path.isfile(INDEX_HTML):
        raise RuntimeError(
            "%s does not exist; run `bash build.sh` first" % INDEX_HTML
        )
    return "file://" + INDEX_HTML


def load_app(chrome, timeout=30):
    """Navigates to the built page and waits for `window.gemApp` to exist.

    `main()` in the page is async (it gunzips the wasm-bindgen glue and the wasm binary
    before calling `new GemApp(...)`), so `document.readyState === 'complete'` is not
    enough; poll for the object itself instead of sleeping a guessed delay.
    """
    chrome.require_webgl2()
    chrome.navigate(page_url(), timeout=timeout)
    chrome.wait_for_expression(
        "typeof window.gemApp !== 'undefined' && window.gemApp !== null",
        timeout=timeout,
    )
    # Stop the page's own skybox from switching the lighting out from under the capture.
    #
    # `main()` in the page kicks off an un-awaited `decodeImage(...).then(set_environment
    # _image)` and publishes `window.gemApp` without waiting for it. When that lands it
    # switches the lighting model to Image AND the tone map to Gamma, so a capture that
    # already asked for Isometric silently measures a skybox-lit stone through a different
    # display transfer. It lands before this line, between any two of the commands below,
    # or never -- there is no order to rely on.
    #
    # Observed 2026-09-17 in T-0122: one `--stone both --mode fast` run scored oval_cut at
    # stone-only mean 0.266 instead of 0.020, from an image 2.5x too bright, while
    # hex_cut_v2 in the same invocation was correct to four decimal places. Nothing raised.
    # kb/browser-harness.md's "Traps in headless screenshot scripts" records the same race
    # costing an earlier sweep 7 of 9 renders, and prescribes exactly this stub; the
    # comparison harness never had it.
    #
    # Replacing the method on the instance shadows the wasm-bindgen prototype's, so the
    # page's own call becomes a no-op. The environment the capture asks for is then set
    # once, by `capture`, and `assert_lighting_model` below checks it stayed.
    chrome.evaluate("window.gemApp.set_environment_image = () => {}")
    # Surfaces a page-side error box (e.g. wasm init failure) as a Python exception
    # rather than a mysteriously blank capture.
    # Two places a failure can appear since 2026-09-19: the settings panel's `#error` box (a
    # persistent or minor condition) and `#load-alert`, the dialog a file or link that could not be
    # read opens over the whole page. Both are checked, or a capture of a stone that failed to load
    # would go through silently again.
    error_visible = chrome.evaluate(
        "(() => { const box = document.getElementById('error');"
        " if (!!box && box.style.display !== 'none' && box.textContent.length > 0)"
        " { return box.textContent; }"
        " const alert = document.getElementById('load-alert');"
        " return alert && alert.textContent.length > 0 ? alert.textContent : null; })()"
    )
    if error_visible:
        raise RuntimeError("page reported an error after loading: %s" % error_visible)


def set_params(chrome, params):
    """Sets each numeric parameter individually via `set_param`, checking the name
    against `KNOWN_PARAMS` first so a stale name raises here rather than three lines
    down inside a JS template string.
    """
    for name in params:
        if name not in KNOWN_PARAMS:
            raise ValueError(
                "unknown gem renderer parameter %r; check src/renderer/lib.rs get_param/set_param "
                "and update tests/harness/gem.py's KNOWN_PARAMS" % name
            )

    assignments = "\n".join(
        "app.set_param(%s, %s);" % (json.dumps(name), repr(float(value)))
        for name, value in params.items()
    )
    chrome.evaluate("(() => { const app = window.gemApp; %s })()" % assignments)


# How many times `capture` re-renders before giving up when two consecutive frames
# disagree. 3 was enough in testing to ride out transient contention.
RENDER_RETRIES = 3


def accumulation_plan(chrome, total_samples):
    """`(passes, samples_per_pass)` for `total_samples` samples per pixel.

    The ported path accumulates across frames since T-0122, so a capture is "reset, then
    render N times" rather than one draw. When the browser has no float render target the
    renderer says so (`accumulation_status`), and the old single-draw behaviour is the
    only thing available -- so the whole sample count goes back into one pass, which is
    slow and uninterruptible but still correct.
    """
    status = chrome.evaluate("window.gemApp.accumulation_status()")
    # Loud, like the renderer line above it: an unexplained 8x slowdown and a noisier
    # image are what this looks like from the outside.
    print("[ours] progressive accumulation: %s" % status, file=sys.stderr)

    if not status.startswith("on"):
        return 1, total_samples

    per_pass = int(os.environ.get(LUX_PASS_SAMPLES_ENV) or DEFAULT_LUX_PASS_SAMPLES)
    per_pass = max(1, per_pass)
    passes = max(1, -(-total_samples // per_pass))  # ceiling division

    return passes, per_pass


def render_sequence_js(width, height, passes):
    """JS statements that draw one complete image, reproducibly.

    The reset is what makes a fixed pass count a reproducible input rather than a point in
    a stream: `render()` is stateful now, but "reset, then accumulate N passes" is not.
    The shader's seed comes from the pass index (see `src/renderer/shaders/lux/host.glsl`'s
    `uLuxSeed`), so two such sequences draw the same N random streams and must produce the
    same pixels -- which is what keeps `capture`'s two-identical-renders check meaningful.
    """
    return (
        " window.gemApp.reset_accumulation();"
        " for (let pass = 0; pass < %d; pass += 1) {"
        "   window.gemApp.render(%d, %d);"
        " }"
    ) % (passes, width, height)

# Seconds to allow the render-and-capture `Runtime.evaluate` (T-0120).
#
# `cdp.Chrome.evaluate`'s own default is 60s, which was ample while the only renderer took
# one deterministic ray per pixel (about 3s for a 640x640 frame on SwiftShader). The ported
# LuxCore path is a Monte Carlo estimator: 640x640 at 512 samples per pixel is about three
# minutes of tracing however it is divided up, and `capture` deliberately renders the image
# twice, so a single evaluate can legitimately take six minutes. Since T-0122 those samples
# arrive as many short passes rather than one enormous draw, which makes the browser far
# less likely to be killed for it -- but the loop still runs inside one `Runtime.evaluate`,
# so the bound is unchanged. Hitting the 60s default looked exactly like a hung browser --
# a WebSocketTimeoutException from deep inside `websocket._abnf` with nothing about
# rendering in it.
#
# Generous rather than fitted: this bound exists to catch a genuinely wedged page, and a
# render that takes half an hour is a configuration mistake worth surfacing either way.
#
# Raised to an hour on 2026-09-19: at the ~2.45s/pass baseline, 700 passes needs ~28.6
# minutes against the old 1800s ceiling -- under 5% headroom even under normal load, and
# three straight Hanabi LuxCore batches hit the ceiling and died with a
# WebSocketTimeoutException on the very first job while a concurrent session on this same
# machine was pushing load average past 9. 3600s gives real margin without hiding an
# actually-wedged page (a wedge is silent forever, not slow-but-finishing).
RENDER_TIMEOUT_SECONDS = 3600


def capture(
    chrome,
    width,
    height,
    obj_text=None,
    lighting_model="isometric",
    background=False,
    params=None,
):
    """Loads `obj_text` (or keeps the built-in hex_cut_v2 stone), applies `params`,
    renders at exactly `width` x `height` pixels, and returns the PNG bytes.

    The render and `toDataURL()` are one `Runtime.evaluate` call (browser-harness trap
    3): the canvas is not `preserveDrawingBuffer`, so capturing in a later JS task can
    read back a cleared buffer. With the ported LuxCore renderer "the render" is a whole
    accumulation sequence -- `reset_accumulation()` then N passes -- rather than a single
    `render()`; see `accumulation_plan` and `render_sequence_js`.
    """
    load_app(chrome)

    if obj_text is not None:
        chrome.evaluate(
            "window.gemApp.load_obj(%s)" % json.dumps(obj_text)
        )

    if lighting_model not in LIGHTING_MODELS:
        raise ValueError(
            "unknown lighting model %r; choices are %s"
            % (lighting_model, sorted(LIGHTING_MODELS))
        )
    chrome.evaluate(
        "window.gemApp.set_lighting_model(%d)" % LIGHTING_MODELS[lighting_model]
    )
    # A flat grey background is the renderer's default (matching the Gem Cut Studio
    # references); the LuxCore oracle scene has a true black background instead (a
    # black quad occluding the lower hemisphere). Disabling it makes rays that miss
    # the stone show the real (black, under every analytical model here) environment,
    # matching the oracle. See kb/luxcore-vs-ours-comparison-harness.md.
    chrome.evaluate(
        "window.gemApp.set_background(%s, 0, 0, 0)"
        % ("true" if background else "false")
    )
    # The facet wireframe is on by default on the page, but it is an overlay, not light: a
    # capture measured against LuxCore or Gem Cut Studio must not have lines drawn on it.
    chrome.evaluate("window.gemApp.set_wireframe(false)")

    # Which path tracer to measure, and its own settings, before the caller's parameters --
    # so a caller that passes `luxSamples` explicitly still wins over the environment.
    renderer = selected_renderer()
    if renderer is not None:
        chrome.evaluate("window.gemApp.set_renderer(%d)" % renderer)
        # Loud, on every capture: a report that does not say which renderer produced it is
        # worse than no report, and the caller (tools/compare_luxcore.py) has no way to
        # know this happened.
        print(
            "[ours] renderer = %d (%s), via $%s"
            % (
                renderer,
                {value: name for name, value in RENDERERS.items()}[renderer],
                RENDERER_ENV,
            ),
            file=sys.stderr,
        )

        # Part of "configure our renderer to render the oracle's scene", alongside the
        # lighting model and flat background set above. Since T-0127 the ported path can be
        # lit either by this project's own environment (its default) or by LuxCore's
        # `constantinfinite` sky plus suns; the oracle scene is the latter, so that is what
        # is captured here unless $GEM_LUX_ENV says otherwise. Announced on every capture
        # for the same reason the renderer is: a report that does not say what lit the stone
        # is not a report.
        lux_environment = selected_lux_environment()
        chrome.evaluate(
            "window.gemApp.set_param('luxEnvironment', %d)" % lux_environment
        )
        print(
            "[ours] lux environment = %d (%s)"
            % (
                lux_environment,
                {value: name for name, value in LUX_ENVIRONMENTS.items()}[
                    lux_environment
                ],
            ),
            file=sys.stderr,
        )

    from_env = renderer_params_from_env()
    if from_env:
        set_params(chrome, from_env)

    if params:
        set_params(chrome, params)

    # How the sample budget is spent (T-0122). `luxSamples` is read back rather than
    # recomputed, so whatever set it -- $GEM_LUX_SAMPLES, an explicit `params` entry, or
    # the page's own default -- means the same thing it always did: samples per pixel in
    # the captured image. Only the division into passes is new.
    passes = 1
    if renderer == RENDERERS["luxcore"]:
        total_samples = int(round(chrome.evaluate("window.gemApp.get_param('luxSamples')")))
        passes, per_pass = accumulation_plan(chrome, total_samples)
        if passes > 1:
            set_params(chrome, {"luxSamples": per_pass})
        print(
            "[ours] %d sample(s) per pixel = %d pass(es) x %d"
            % (passes * per_pass, passes, per_pass),
            file=sys.stderr,
        )

    # The last thing before drawing: confirm the page is still lit the way it was asked to
    # be. The stub in `load_app` closes the one known way this drifts, and this is what
    # would catch the next one -- a wrong lighting model is invisible in the metrics, it
    # just makes the stone disagree with the oracle for a reason no number names.
    actual_model = int(chrome.evaluate("window.gemApp.lighting_model()"))
    if actual_model != LIGHTING_MODELS[lighting_model]:
        raise RuntimeError(
            "the page is lit with model %d but %r (%d) was requested; something in the "
            "page changed it after it was set (see load_app's comment about the skybox "
            "decode)" % (actual_model, lighting_model, LIGHTING_MODELS[lighting_model])
        )

    render_once = render_sequence_js(width, height, passes)

    for attempt in range(1, RENDER_RETRIES + 1):
        # Renders the whole image twice and demands byte-identical PNGs before trusting
        # either one.
        #
        # What "the whole image" means changed with T-0122 and the guard did NOT weaken.
        # `render()` used to be a pure function of the parameters, so two bare calls had
        # to agree. It is stateful now -- each call adds a pass -- so the reproducible
        # unit is the sequence `reset_accumulation()` then N passes, which
        # `render_sequence_js` emits. The pass index, not a frame counter, seeds the
        # shader, so two such sequences draw the same N random streams and must still be
        # pixel-for-pixel identical. This remains an equality check, not a tolerance.
        #
        # It exists because a headless SwiftShader capture was observed (2026-09-17,
        # T-0094, under a concurrently running CPU-heavy LuxCore render -- load average
        # > 20) to silently return a corrupted frame with a uniform non-zero floor where
        # the background should be exactly black. Nothing raised: `toDataURL` returned a
        # validly-encoded PNG, just the wrong pixels. Comparing two independent renders
        # turns that into a loud retry instead of a quietly wrong number. See
        # kb/luxcore-vs-ours-comparison-harness.md.
        data_urls = chrome.evaluate(
            "(() => {"
            " const canvas = document.getElementById('canvas');"
            " %s"
            " const first = canvas.toDataURL('image/png');"
            " %s"
            " const second = canvas.toDataURL('image/png');"
            " return [first, second];"
            " })()" % (render_once, render_once),
            timeout=RENDER_TIMEOUT_SECONDS,
        )
        first, second = data_urls
        if first == second:
            break
        if attempt == RENDER_RETRIES:
            raise RuntimeError(
                "two independent renders with identical parameters produced different "
                "PNGs after %d attempts; the capture is unreliable (see the retry loop's "
                "comment in tests/harness/gem.py -- likely heavy concurrent CPU load "
                "starving the software GPU)" % RENDER_RETRIES
            )
    header, _, encoded = first.partition(",")
    if "image/png" not in header:
        raise RuntimeError("canvas.toDataURL did not return a PNG: %r" % header[:64])
    return base64.b64decode(encoded)


def diagnostics_text(chrome):
    """`gemApp.diagnostics_text()`, for a sanity check that the right stone loaded."""
    return chrome.evaluate("window.gemApp.diagnostics_text()")
