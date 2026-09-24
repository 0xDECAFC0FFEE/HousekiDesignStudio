/*
 * shader_wait_test.js -- tests for web/src/lib/shader_wait.js's decision: on which machines
 * does the page put up a "compiling the gem shader" bar?
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The bar exists because linking the gem shader takes 7.7-11.9 s on Windows, where WebGL runs
 * through ANGLE and Direct3D's shader compiler, against a fraction of a second on macOS and
 * Android. The user's requirement is exactly as narrow as that: the bar must appear where the
 * wait is real and NOWHERE else, so the interesting cases here are the negative ones.
 *
 * `backendCompilesSlowly` is the whole decision, lifted out of the DOM so it can be pinned
 * here. The renderer strings below are not invented: each was copied from a real run of a
 * WebGL2 timing page in that browser on that machine (Windows strings measured 2026-09-22 on
 * Firefox 156 / Chrome 153 with an RTX 2080; the macOS and Android spellings are the ANGLE and
 * native-driver forms those platforms report). The point of pinning the exact strings is that
 * the rule is a regex over a driver string: if a browser ever renames its backend, a test
 * failure here is the warning that the page has started guessing wrong.
 */

import {
  backendCompilesSlowly, isChromiumBrowser, waveCanAnimate,
} from "../src/lib/shader_wait.js";

// Real user-agent strings from the browsers these were measured in (2026-09-22, this machine).
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0";
const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.4234.48";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

Deno.test("a Direct3D backend is slow, whichever browser reports it and however it is masked", () => {
  // Firefox masks the GPU model ("GTX 980, or similar" on a machine with an RTX 2080) but
  // keeps ANGLE's backend name, which is the part this decision turns on.
  const firefoxWindows =
    "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar";
  // Chrome reports the real model and names D3D11 twice.
  const chromeWindows =
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 (0x00001E82) Direct3D11 vs_5_0 ps_5_0, D3D11)";

  assert(backendCompilesSlowly(firefoxWindows, "Win32"), "Firefox on Windows should show the bar");
  assert(backendCompilesSlowly(chromeWindows, "Windows"), "Chrome on Windows should show the bar");

  // The platform argument must not be what decides: a D3D context is slow whatever the
  // navigator claims, and an unknown platform beside a D3D string still means the bar.
  assert(backendCompilesSlowly(firefoxWindows, ""), "the renderer string alone should be enough");
});

Deno.test("the platforms the page already opens instantly on never show the bar", () => {
  // macOS: Metal, either through ANGLE or straight to the driver. Android: the GPU's own GLES
  // driver. None of these involve a D3D shader compiler, and all of them link this shader in
  // well under a second -- which is precisely the user's requirement for this feature.
  const cases = [
    ["ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)", "MacIntel"],
    ["Apple M1 Pro, or similar", "MacIntel"],
    ["Apple GPU", "MacIntel"],
    ["Adreno (TM) 730", "Linux armv8l"],
    ["Mali-G78 MP14", "Linux aarch64"],
    ["Mesa Intel(R) UHD Graphics 620 (KBL GT2)", "Linux x86_64"],
  ];

  for (const [renderer, platform] of cases) {
    assert(
      !backendCompilesSlowly(renderer, platform),
      `${renderer} should not show the bar`,
    );
  }
});

Deno.test("a Windows machine with ANGLE turned off is judged by its renderer string, not its platform", () => {
  // Firefox with webgl.disable-angle reaches NVIDIA's own GL driver, which links the same
  // shader in 1.8 s rather than 9.5 s. It reports no D3D, so it gets no bar: the rule is about
  // the backend that is slow, not about the operating system it happens to run on.
  assert(
    !backendCompilesSlowly("NVIDIA GeForce GTX 980, or similar", "Win32"),
    "native OpenGL on Windows should not show the bar",
  );
});

Deno.test("with no renderer string at all, only Windows falls back to showing the bar", () => {
  // Some privacy configurations withhold WEBGL_debug_renderer_info and report nothing useful
  // for RENDERER either. There is then no way to see the backend, so the platform is all that
  // is left -- and the fallback is deliberately one-sided. Showing the bar on a Mac that does
  // not need it is the mistake the user asked us not to make; a Windows machine that has
  // turned ANGLE off seeing a bar over a 1.8 s wait is the tolerable one.
  assert(backendCompilesSlowly("", "Win32"), "unknown backend on Windows should show the bar");
  assert(backendCompilesSlowly("", "Windows"), "userAgentData's spelling should match too");

  assert(!backendCompilesSlowly("", "MacIntel"), "unknown backend on macOS should not");
  assert(!backendCompilesSlowly("", "Linux aarch64"), "unknown backend on Android should not");
  assert(!backendCompilesSlowly("", ""), "knowing nothing at all should not show the bar");
  assert(!backendCompilesSlowly("", undefined), "a missing platform should not throw");
});

/*
 * The second decision the module makes: a Chromium browser that cannot link in parallel gets a
 * still indicator rather than the moving wave (see the waveCanAnimate test below). Taking a
 * Chromium browser for Firefox would give it an animation that physically cannot run there.
 */

Deno.test("Chrome and Edge are recognised as Chromium, with or without userAgentData", () => {
  // The modern signal: navigator.userAgentData exists only on Chromium.
  assert(isChromiumBrowser(CHROME, true), "Chrome with userAgentData");
  assert(isChromiumBrowser(EDGE, true), "Edge with userAgentData");

  // And without it, because a browser can have the newer API disabled; the user-agent string
  // still names the engine. Edge's string contains "Chrome/" as well as "Edg/", so either
  // token is enough -- the point is that neither browser falls through to the Firefox branch.
  assert(isChromiumBrowser(CHROME, false), "Chrome without userAgentData");
  assert(isChromiumBrowser(EDGE, false), "Edge without userAgentData");

  assert(!isChromiumBrowser(FIREFOX, false), "Firefox is not Chromium");
  assert(!isChromiumBrowser(FIREFOX, undefined), "a missing flag must not throw");
  assert(!isChromiumBrowser("", false), "an empty user agent is not Chromium");
  assert(!isChromiumBrowser(undefined, undefined), "nothing at all must not throw");
});

/*
 * The third decision: does the wave move, or is the bar drawn still?
 *
 * Setup: nothing but the two facts the decision turns on -- whether the browser is Chromium, and
 * whether its context offers KHR_parallel_shader_compile.
 *
 * What it verifies: the still bar is reserved for the one case that freezes, a Chromium browser
 * that has to link blocking. Measured 2026-09-23 on this machine with the real gem shader and
 * fresh profiles: a blocking link drew 0 frames in 13.9 s in Chrome 153, while the polled
 * parallel link drew 863 frames over 14.4 s (Edge 153: 948), so Chrome and Edge as they ship now
 * must get the moving wave. Firefox 156 does not offer the extension, and its opacity wave keeps
 * running through its blocking link anyway, so it must keep the moving wave too.
 */
Deno.test("only a Chromium browser that must link blocking gets the still bar", () => {
  assert(waveCanAnimate(true, true), "Chrome/Edge with the parallel link should animate");
  assert(!waveCanAnimate(true, false), "Chromium without it would freeze, so it must be still");
  assert(waveCanAnimate(false, false), "Firefox animates through its blocking link");
  assert(waveCanAnimate(false, true), "a non-Chromium browser with the extension animates");
  assert(!waveCanAnimate(true, undefined), "an unknown answer about the extension is a no");
});
