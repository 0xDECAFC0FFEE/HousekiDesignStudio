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
  backendCompilesSlowly, isChromiumBrowser, shaderWaitNote,
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
 * The second decision the module makes: Chrome and Edge get a still indicator and a note saying
 * the result is cached, Firefox gets the animated one and a note saying it is not. Both halves
 * come from the same measurement, so they are tested together.
 *
 * Why it matters that this is right rather than merely plausible: if a Chromium browser were
 * taken for Firefox it would be given an animation that physically cannot run there -- the D3D
 * compile occupies the process that composites -- and the page would spend nine seconds showing
 * a stopped animation, which is exactly the "looks hung" failure the still version exists to
 * avoid. And it would tell the reader the wait repeats on every load when in fact it does not.
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

Deno.test("the note tells the reader whether the wait will happen again", () => {
  // Chrome 9,595 ms cold then 207 ms; Edge 8,443 ms then 2 ms. It is a first-time cost, and
  // the note names both browsers so the claim can be checked rather than taken on trust.
  for (const [name, userAgent] of [["Chrome", CHROME], ["Edge", EDGE]]) {
    const note = shaderWaitNote(userAgent, true);
    assert(note.includes("Chrome and Edge"), `${name}: the note should name both browsers`);
    assert(note.includes("cache"), `${name}: the note should say the result is cached`);
    assert(note.includes("first time"), `${name}: the note should say it is a one-off`);
  }

  // Firefox paid the full 9,175 ms on every load, warm profile included, so it must not be
  // told the opposite.
  const firefox = shaderWaitNote(FIREFOX, false);
  assert(firefox.includes("every load"), "Firefox should be told the wait repeats");
  assert(!firefox.includes("first time"), "Firefox must not be told it is a one-off");

  // Anything else: nothing was measured, so the note claims nothing it cannot support.
  const unknown = shaderWaitNote("Mozilla/5.0 (Windows NT 10.0) SomeOtherEngine/1.0", false);
  assert(!unknown.includes("Chrome and Edge"), "an unknown browser should not be told about Chromium's cache");
  assert(!unknown.includes("Firefox"), "an unknown browser should not be called Firefox");
});
