// Loads the phone scanner's vision module (T-0330): the Rust crate src/vision compiled to
// WebAssembly, which finds the ChArUco board (board_detect.js) and reads QR codes (qr_detect.js)
// in camera frames. It replaced opencv.js for both.
//
// HOW IT TRAVELS. make_page.py writes one classic script, build/www/scanner/houseki_vision.js,
// next to the phone page. It holds the module's wasm-bindgen glue (the no-modules target) and the
// .wasm binary, each gzip-compressed and base64 encoded, as
//   globalThis.HOUSEKI_VISION_WASM = { glue: '<base64 gzip>', wasm: '<base64 gzip>' }
// A classic <script src> loads over http(s) AND from file://, where fetch() and module imports of
// other files fail; the studio app ships its own wasm the same way (inlined, gzip + base64). The
// studio never imports this module, so it does not grow.
//
// THE WORKER. The phone runs its vision in an inline Worker (scanner/vision_worker.js), which from
// file:// may not load any file at all. So the page loads the script, inflates it once
// (visionPayload) and posts the result -- the glue's text and the wasm's bytes -- to the Worker,
// which instantiates it with loadVision({ payload }). The same works over http.
//
// LAZY: nothing happens at import. Calls share one load; a failed load rejects that promise and
// the next call tries again.
//
// ELSEWHERE (Deno, for the tests) pass `scriptText` (the classic script's text) or a `payload`.

/** Where the page finds the script, relative to the page: make_page.py puts it next to index.html. */
export const VISION_SCRIPT = 'houseki_vision.js';

/** The global the script defines. */
export const VISION_GLOBAL = 'HOUSEKI_VISION_WASM';

let payloadLoading = null;
let moduleLoading = null;

/**
 * The module's glue text and wasm bytes, ready to instantiate here or to post to a Worker
 * (both are structured-cloneable). Loads the classic script first if this realm has not.
 *
 * @param {{ url?: string|URL, scriptText?: string }} [options]  `url`: where the script is
 *   (default VISION_SCRIPT, next to the page); `scriptText`: its text, for runtimes without a
 *   document.
 * @returns {Promise<{ glue: string, wasm: ArrayBuffer }>}
 */
export function visionPayload(options = {}) {
  if (!payloadLoading) {
    payloadLoading = loadPayload(options);
    payloadLoading.catch(() => {
      payloadLoading = null;
    });
  }

  return payloadLoading;
}

/**
 * Resolves to the vision module's exports (CharucoDetector, QrReader) once it is instantiated.
 * Idempotent.
 *
 * @param {{ url?: string|URL, scriptText?: string, payload?: { glue: string, wasm: ArrayBuffer|Uint8Array } }} [options]
 * @returns {Promise<any>}
 */
export function loadVision(options = {}) {
  if (!moduleLoading) {
    moduleLoading = (async () => instantiate(options.payload ?? await visionPayload(options)))();
    moduleLoading.catch(() => {
      moduleLoading = null;
    });
  }

  return moduleLoading;
}

async function loadPayload({ url, scriptText } = {}) {
  if (!globalThis[VISION_GLOBAL]) {
    if (typeof scriptText === 'string') {
      runClassicScript(scriptText);
    } else if (typeof document !== 'undefined' && document.createElement) {
      await addScriptTag(new URL(url ?? VISION_SCRIPT, document.baseURI).href);
    } else if (typeof importScripts === 'function') {
      importScripts(String(url ?? VISION_SCRIPT));
    } else if (url) {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`could not read ${url}: ${response.status}`);
      }

      runClassicScript(await response.text());
    } else {
      throw new Error('loadVision: no document here; pass { url }, { scriptText } or { payload }');
    }
  }

  const packed = globalThis[VISION_GLOBAL];

  if (!packed || typeof packed.glue !== 'string' || typeof packed.wasm !== 'string') {
    throw new Error(`${VISION_SCRIPT} ran but did not define ${VISION_GLOBAL}`);
  }

  const [glue, wasm] = await Promise.all([inflate(packed.glue), inflate(packed.wasm)]);
  return { glue: new TextDecoder().decode(glue), wasm: wasm.buffer };
}

/** base64 of gzip -> the bytes, with the browser's DecompressionStream. */
async function inflate(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function instantiate({ glue, wasm }) {
  // The no-modules glue declares `let wasm_bindgen = ...` at its top level: run it in a function
  // of its own and hand that binding back, so nothing is left in the global scope.
  // eslint-disable-next-line no-new-func
  const bindgen = new Function(`${glue}\nreturn wasm_bindgen;`)();
  // Compiled asynchronously (off the main thread where the browser can), then bound.
  const module = await WebAssembly.compile(wasm);
  const exports = bindgen.initSync({ module });
  Object.defineProperty(bindgen, 'wasmMemory', { value: exports.memory, enumerable: false });
  return bindgen;
}

/**
 * The bytes of WebAssembly memory the vision module has (it grows, never shrinks), for tests that
 * check a stream of frames does not keep growing it.
 *
 * @param {any} vision  from loadVision()
 * @returns {number}
 */
export function visionMemoryBytes(vision) {
  return vision.wasmMemory.buffer.byteLength;
}

function addScriptTag(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.vision = '';
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error(`could not load ${src}`));
    };
    document.head.appendChild(script);
  });
}

function runClassicScript(text) {
  // An indirect eval runs in the global scope, as a classic script at the top level would.
  (0, eval)(text);
}
