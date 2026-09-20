// Helpers for the data make_page.py inlines into the page (ported from the page's script).

/** Base64 text to the bytes it encodes. */
export function base64ToBytes(text) {
  return Uint8Array.from(atob(text), character => character.charCodeAt(0));
}

/** Bytes to the base64 text that encodes them -- `base64ToBytes`'s inverse. */
export function bytesToBase64(bytes) {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

/**
 * Inflates gzip bytes. `DecompressionStream` is built into the browser (and into Deno, so
 * `share_url_test.js` can exercise this under `deno test` with no browser at all), so this
 * works from file://; the `Response` only gathers the stream's bytes, nothing is fetched.
 */
export async function gunzipBytes(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error(
      'This browser has no DecompressionStream, which the page needs to unpack its inlined ' +
      'renderer. Use a current Chrome, Edge, Firefox or Safari (16.4 or later).'
    );
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Deflates bytes to gzip -- `gunzipBytes`'s inverse, and `CompressionStream`'s counterpart to
 * the `DecompressionStream` above. Used to write the URL hash (T-0198): gzip, not deflate-raw,
 * to stay consistent with everything else this page inflates.
 */
export async function gzipBytes(bytes) {
  if (typeof CompressionStream !== 'function') {
    throw new Error('This browser has no CompressionStream.');
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Inflates gzip data that make_page.py inlined as base64. `gunzipBytes(base64ToBytes(text))`
 * in one call -- kept as its own export because boot.js's three inlined bundles (the wasm
 * bindings, the wasm binary, the GemCad scripts) are always base64 text, never raw bytes.
 */
export async function gunzipBase64(text) {
  return gunzipBytes(base64ToBytes(text));
}

/**
 * Runs JavaScript source as a classic inline script in the global scope.
 *
 * For the wasm-bindgen glue, whose top-level `let wasm_bindgen` must become a global this
 * script can read. An inline script inserted into the document runs synchronously, on
 * insertion. Indirect eval would not do: it keeps a top-level `let` local to the eval.
 */
export function runInlineScript(source) {
  const script = document.createElement('script');

  script.textContent = source;
  document.head.appendChild(script);
}

/** The inlined skybox as a Blob, ready for `decodeImage`. */
export function environmentImageBlob() {
  return new Blob([base64ToBytes(GEM_ENVIRONMENT_IMAGE_BASE64)], { type: GEM_ENVIRONMENT_IMAGE_TYPE });
}

/**
 * Decodes an image to RGBA bytes exactly as stored.
 *
 * `colorSpaceConversion: 'none'` matters: the Rust side decodes the bytes to radiance
 * itself, and a color-managed conversion would change them depending on the display.
 */
export async function decodeImage(blob) {
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });

  const scratch = document.createElement('canvas');
  scratch.width = bitmap.width;
  scratch.height = bitmap.height;

  const context = scratch.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const { data } = context.getImageData(0, 0, scratch.width, scratch.height);

  return { rgba: new Uint8Array(data.buffer), width: scratch.width, height: scratch.height };
}
