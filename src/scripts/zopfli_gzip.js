// Gzip-compresses stdin to stdout with Zopfli, for make_page.py's inlined parts (the wasm
// module, its glue and the GemCad scripts). Run with Deno (this machine's node is broken; see
// kb/build-and-test-commands.md):
//
//   deno run --quiet src/scripts/zopfli_gzip.js < in.wasm > in.wasm.gz
//
// Zopfli writes ordinary gzip, which the page's DecompressionStream('gzip') inflates exactly
// as it inflates zlib's, at the same speed; it only searches much harder for a short encoding.
// That costs build time and nothing else, and took the wasm module's gzip 5.8% below zlib's
// level 9 (T-0238; kb/wasm-size-and-speed.md). The output has no file name and a zero
// timestamp, so unchanged input gives a byte-identical page.
//
// The package is pinned exactly; Deno fetches it into its cache on the first run (./setup.sh
// does that), which needs the network once. @gfx/zopfli (Apache-2.0), Google's Zopfli compiled
// to WebAssembly: build-time only, nothing of it ships in the page.

import { gzipAsync } from "npm:@gfx/zopfli@1.0.15";

// Zopfli's own default. More iterations measured 26 bytes smaller on the 330 KB wasm module,
// for three and a half times the build time.
const ITERATIONS = 15;

async function readStdin() {
  const chunks = [];

  for await (const chunk of Deno.stdin.readable) {
    chunks.push(chunk);
  }

  const data = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;

  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }

  return data;
}

async function writeAll(data) {
  // `write` may take only part of the buffer; loop until all of it is written.
  let written = 0;

  while (written < data.length) {
    written += await Deno.stdout.write(data.subarray(written));
  }
}

const compressed = await gzipAsync(await readStdin(), { numiterations: ITERATIONS });

await writeAll(compressed);
