// The "compiling the gem shader" bar: shown only where that compile is slow enough to need
// one, which today means only Windows.
//
// WHY THIS EXISTS (measured 2026-09-22, Firefox 156 and Chrome 153 on an RTX 2080).
// `GemApp`'s constructor links one ~285 KB fragment shader -- `gem.frag` concatenated with
// every `lux/*.glsl` file, both path tracers in a single program; see `FRAGMENT_SHADER` in
// `src/renderer/lib.rs`. On Windows every browser runs WebGL through ANGLE, which translates
// that GLSL to HLSL and hands it to Direct3D's shader compiler, and that compiler takes
// 7.7-11.9 s over it. macOS and Android hand the shader to Metal or to the native GLES driver
// instead and are done in a fraction of a second, which is why the page opens instantly there
// and looked like it had hung on Windows. Chrome keeps the compiled program in an on-disk
// cache and so pays it only on a profile's first load; Firefox has no such cache and pays it
// on EVERY load. WebGL exposes no program-binary API, so the page cannot cache it either.
//
// HOW IT IS SLOW shapes everything below, and is worth reading before changing any of it:
//
//   * The wait is one synchronous WebGL call inside the wasm constructor. No JavaScript runs
//     while it happens, so there is no progress to report and nothing to update as it goes.
//     Hence an indeterminate bar, and hence `painted` -- it has to be on screen BEFORE the
//     constructor is called, because nothing can put it there afterwards.
//   * A JS-driven animation would freeze along with the rest of the page thread, and so, as it
//     turns out, would a CSS `transform` one. In Firefox what keeps moving through the freeze
//     is an `opacity` animation, and only that; the rule and the measurement behind it are in
//     `styles/panel.css` beside the markup below. Do not reimplement this with
//     `requestAnimationFrame`, and do not "improve" the wave into a sliding bar.
//   * In Chrome and Edge NOTHING animates, because there the D3D compile occupies the GPU
//     process, which is also the compositor -- so the frame the wave was in when the compile
//     began is the frame that stays on screen for the next nine seconds. A stopped animation
//     reads as a hung page, which is worse than no animation at all, so those browsers get a
//     deliberately still indicator instead. See `isChromiumBrowser`.

/**
 * Renderer strings that mean "this WebGL context goes through Direct3D".
 *
 * ANGLE names its backend in the renderer string, and both browsers keep that part even when
 * they mask the GPU model for fingerprinting reasons. Measured spellings:
 *
 *   Firefox, Windows, default:  "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar"
 *   Chrome,  Windows, default:  "ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 (0x00001E82) Direct3D11 vs_5_0 ps_5_0, D3D11)"
 *   Firefox, Windows, ANGLE off: "NVIDIA GeForce GTX 980, or similar"
 *
 * Matching the backend rather than the operating system is deliberate: it is the D3D shader
 * compiler that is slow, not Windows, and a context that reaches the driver directly links the
 * same shader in 1.8 s. A Metal or OpenGL backend never matches.
 */
const DIRECT3D_BACKEND = /Direct3D|\bD3D\d/i;

/** Platform strings that mean Windows, for the fallback below. */
const WINDOWS_PLATFORM = /^win/i;

/**
 * Whether a context with this renderer string, on this platform, is one where linking the gem
 * shader takes long enough to be worth telling someone about.
 *
 * Split out from the DOM so it can be tested: `tests/shader_wait_test.js` pins every string
 * above against it.
 *
 * `renderer` is what the context reports, or an empty string when the browser will not say --
 * `WEBGL_debug_renderer_info` is absent in some privacy configurations. Only then does
 * `platform` decide, and only Windows can turn it on: the bar must never appear on a machine
 * this was not measured slow on, which is what the fallback being this narrow buys. A Windows
 * machine that has turned ANGLE off is then a false positive, at 1.8 s rather than 8 s -- the
 * lesser of the two mistakes available without a renderer string.
 */
export function backendCompilesSlowly(renderer, platform) {
  if (renderer) {
    return DIRECT3D_BACKEND.test(renderer);
  }

  return WINDOWS_PLATFORM.test(platform || '');
}

/**
 * Whether the shader link is about to be slow on this machine, asked of the real canvas.
 *
 * Takes the context from the canvas the renderer itself will use, rather than a throwaway one:
 * `getContext('webgl2')` hands back the same context object every time it is called on a
 * canvas, so the Rust constructor gets exactly this context and nothing extra is allocated.
 * The attributes must stay omitted here for that to hold -- `GemApp::new` passes none either.
 *
 * Answers `false` if there is no WebGL2 at all; the constructor is about to fail with its own
 * message, and a progress bar over a page that is about to show an error helps nobody.
 */
export function shaderCompileIsSlow(canvas) {
  let gl = null;

  try {
    gl = canvas?.getContext('webgl2') ?? null;
  } catch {
    return false;
  }

  if (!gl) {
    return false;
  }

  let renderer = '';

  try {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');

    renderer = String(
      (debugInfo && gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) ||
      gl.getParameter(gl.RENDERER) || '',
    );
  } catch {
    renderer = '';
  }

  return backendCompilesSlowly(renderer, navigator.userAgentData?.platform || navigator.platform);
}

/**
 * Whether this is a Chromium browser -- Chrome, Edge, and the rest of the family.
 *
 * Two things follow from it, both measured on this machine (2026-09-22, Chrome 153 and Edge
 * 153, fresh profiles, the real page, watched from outside the browser):
 *
 *   * **Nothing animates while the shader compiles.** Seven screen grabs across the compile
 *     were pixel-identical in both browsers, down to the same stopped frame. Firefox, whose
 *     compile does not tie up its compositor the same way, gave seven different frames. So the
 *     indicator holds still here on purpose rather than appearing to hang.
 *   * **The compiled program is cached on disk**, so the wait is a first-time cost rather than
 *     a per-load one: Chrome 9,595 ms on a fresh profile and 207 ms on the next load, Edge
 *     8,443 ms and then 2 ms. Firefox has no such cache and paid 9,175 ms every time. That is
 *     the difference the note tells the reader about, because "this takes ten seconds" and
 *     "this takes ten seconds once" are very different things to be told.
 *
 * `userAgentData` exists only on Chromium, which makes it the cleanest signal; the user-agent
 * string is checked too so that a browser which has turned the newer API off is not mistaken
 * for Firefox. Kept pure, and pinned by `tests/shader_wait_test.js`.
 */
export function isChromiumBrowser(userAgent, hasUserAgentData) {
  return Boolean(hasUserAgentData) || /Chrome\/|Chromium\/|Edg\//.test(userAgent || '');
}

/**
 * The second line of the notice: what this wait will cost the reader *next* time.
 *
 * Deliberately says which browsers cache it rather than "your browser", because the one
 * question someone watching a ten-second freeze wants answered is whether it will happen
 * again, and naming Chrome and Edge makes the answer checkable instead of a claim.
 */
export function shaderWaitNote(userAgent, hasUserAgentData) {
  if (isChromiumBrowser(userAgent, hasUserAgentData)) {
    return 'Chrome and Edge cache the compiled shader, so this should only happen the first ' +
      'time you open the page.';
  }

  if (/Firefox\//.test(userAgent || '')) {
    return 'Firefox does not cache the compiled shader, so this happens on every load.';
  }

  return 'This browser may recompile it each time the page is opened.';
}

/**
 * Puts the bar over the renderer's pane and returns a handle to take it away again.
 *
 * `handle.painted` resolves once the browser has actually put it on the screen. Await that
 * before the call that blocks, or the bar is queued behind the block and is removed again
 * before a single frame of it is ever drawn. Two `requestAnimationFrame`s and a macrotask: the
 * second callback runs in the frame after the one that committed this element, and the
 * `setTimeout` yields once more so the compositor has the frame in hand.
 *
 * Built as plain DOM rather than a Svelte component on purpose. It has to be drawn at an exact
 * moment relative to a synchronous call, with no store update, no `tick()` and no reactive
 * scheduling in between -- and it has to be removable from a `finally`, whatever happened.
 */
export function showShaderCompileNotice(viewport) {
  const notice = document.createElement('div');

  const userAgent = navigator.userAgent;
  const still = isChromiumBrowser(userAgent, Boolean(navigator.userAgentData));

  notice.id = 'shader-wait';
  // `role="status"` rather than a live region that interrupts: this is progress, not an alert.
  notice.setAttribute('role', 'status');
  // `shader-wait-still` turns the wave off where it could not run anyway, so what is on screen
  // for those nine seconds is a still indicator by design and not a stopped animation.
  notice.className = still ? 'shader-wait-still' : '';
  notice.innerHTML =
    '<div class="shader-wait-card">' +
    '<p class="shader-wait-title">Compiling the gem shader…</p>' +
    '<div class="shader-wait-track">' +
    '<i class="shader-wait-segment"></i><i class="shader-wait-segment"></i>' +
    '<i class="shader-wait-segment"></i><i class="shader-wait-segment"></i>' +
    '<i class="shader-wait-segment"></i></div>' +
    '<p class="shader-wait-note">Windows compiles this shader through Direct3D, ' +
    'which takes a few seconds. ' +
    shaderWaitNote(userAgent, Boolean(navigator.userAgentData)) +
    '</p></div>';

  viewport.appendChild(notice);

  const painted = new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });

  return {
    painted,
    remove() {
      notice.remove();
    },
  };
}
