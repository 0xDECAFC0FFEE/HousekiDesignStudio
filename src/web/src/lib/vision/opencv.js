// Loads the phone scanner's OpenCV (T-0323): src/web/vendor/opencv/opencv.js, OpenCV 4.14.0
// compiled to WebAssembly with only what the phone's vision needs (see
// src/web/vendor/opencv/build_opencv_js.sh and opencv_js.config.py).
//
// ONLY THE PHONE PAGE LOADS IT. The file is about 4 MB of script (the wasm is embedded in it),
// so it is not bundled into anything: make_page.py copies it next to the phone page, as
// build/www/scanner/opencv.js, and this loader adds it to the page as a classic
// <script src="opencv.js"> when asked. A classic script loads over http(s) AND from file://,
// where fetch() and module imports of other files fail; that is why it is not an import. The
// studio app never imports this module, so it does not grow.
//
// LAZY: nothing happens at import. Call loadOpenCv() once the camera stream is running, so the
// phone shows its picture first; the browser downloads and compiles OpenCV meanwhile (compiling
// the wasm is asynchronous, off the main thread). Calls share one load: the promise resolves to
// the same `cv` every time. A failed load (network, a missing file) rejects that promise and the
// next call tries again.
//
// IN A WORKER the same call uses importScripts(url). ELSEWHERE (Deno, for the tests) pass
// `source`, the file's text, or a `url` fetch() can read (Deno reads file: URLs); the script is
// then run with an indirect eval, as a classic script at the top level would be.

/** Where the page finds opencv.js, relative to the page: make_page.py puts it next to index.html. */
export const OPENCV_SCRIPT = 'opencv.js';

let loading = null;

/**
 * Resolves to OpenCV's `cv` once its runtime is ready (cv.Mat usable). Idempotent.
 *
 * @param {{ url?: string|URL, source?: string }} [options]  `url`: where opencv.js is (default
 *   OPENCV_SCRIPT, next to the page); `source`: its text, for runtimes without a document.
 * @returns {Promise<any>} the `cv` namespace
 */
export function loadOpenCv(options = {}) {
  if (!loading) {
    loading = load(options);
    loading.catch(() => {
      loading = null;
    });
  }

  return loading;
}

/**
 * Bytes the wasm heap's allocator has handed out and not had back (dlmalloc's mallinfo().uordblks),
 * or null if this opencv.js was built without _mallinfo. A Mat not .delete()d shows up here, so the
 * tests compare it before and after many frames; a page can log it to watch for leaks.
 *
 * @param {any} cv
 * @returns {number|null}
 */
export function wasmHeapInUse(cv) {
  if (typeof cv._mallinfo !== 'function') {
    return null;
  }

  // mallinfo() returns a struct of ten ints; in wasm32 that is written through a hidden pointer
  // argument. The heap itself is not exported, but any Mat's data is a view into it.
  const struct = cv._malloc(40);
  const probe = new cv.Mat(1, 1, cv.CV_8UC1);

  try {
    cv._mallinfo(struct);
    return new Int32Array(probe.data.buffer, struct, 10)[7];
  } finally {
    probe.delete();
    cv._free(struct);
  }
}

/** True once loadOpenCv() has resolved; for a status line that should not wait. */
export function openCvReady() {
  return Boolean(globalThis.cv && globalThis.cv.Mat);
}

async function load({ url, source } = {}) {
  if (!openCvReady()) {
    if (typeof source === 'string') {
      runClassicScript(source);
    } else if (typeof document !== 'undefined' && document.createElement) {
      await addScriptTag(new URL(url ?? OPENCV_SCRIPT, document.baseURI).href);
    } else if (typeof importScripts === 'function') {
      importScripts(String(url ?? OPENCV_SCRIPT));
    } else if (url) {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`could not read ${url}: ${response.status}`);
      }

      runClassicScript(await response.text());
    } else {
      throw new Error('loadOpenCv: no document here; pass { url } or { source }');
    }
  }

  return ready(globalThis.cv);
}

// opencv.js is a UMD script: with no module system around it sets `globalThis.cv`. Depending on
// the Emscripten version that is the runtime itself, a promise of it, or a runtime still
// compiling its wasm (cv.Mat appears when it is ready, and onRuntimeInitialized is called).
async function ready(cv) {
  if (!cv) {
    throw new Error('opencv.js ran but did not define cv');
  }

  if (cv.Mat) {
    return cv;
  }

  if (typeof cv.then === 'function') {
    // Emscripten's MODULARIZE promise. The resolved runtime is itself not thenable (Emscripten
    // deletes `then` on resolving), so awaiting it cannot loop.
    const runtime = await cv;
    globalThis.cv = runtime;
    return runtime;
  }

  await new Promise((resolve, reject) => {
    const previous = cv.onRuntimeInitialized;
    cv.onRuntimeInitialized = () => {
      previous?.();
      resolve();
    };
    const abort = cv.onAbort;
    cv.onAbort = (what) => {
      abort?.(what);
      reject(new Error(`opencv.js aborted: ${what}`));
    };
  });

  return cv;
}

function addScriptTag(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    // Emscripten embeds the wasm as UTF-8 text in the script, so it must be decoded as UTF-8
    // whatever the server (or file://) says.
    script.charset = 'utf-8';
    script.dataset.opencv = '';
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error(`could not load ${src}`));
    };
    document.head.appendChild(script);
  });
}

function runClassicScript(text) {
  // An indirect eval runs in the global scope, where a classic script's top-level `this` is
  // globalThis: the UMD wrapper then sets globalThis.cv.
  (0, eval)(text);
}
