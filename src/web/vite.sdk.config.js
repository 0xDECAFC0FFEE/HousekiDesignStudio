// Builds /scanner.js (src/web/sdk/scanner.js, T-0337), the script a website includes to open the
// Houseki scanner, into ONE classic script, build/sdk/scanner.js. make_page.py copies it to the
// site's root as build/www/scanner.js.
//
// A classic script (an IIFE), not a module: a website includes it with a plain
// `<script src="https://houseki.app/scanner.js">`, and it reads `document.currentScript` to find
// the scan page beside it, which a module never has. It bundles only scanner_sdk.js and
// scanner_protocol.js, a few kB; the scanner itself is the scan page, in the iframe.

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  build: {
    // Everything generated lives under build/, which is gitignored. make_page.py reads
    // build/sdk/scanner.js (SDK_BUILD), so the two must agree.
    outDir: fileURLToPath(new URL('../../build/sdk', import.meta.url)),
    emptyOutDir: true,
    target: 'es2020',
    lib: {
      entry: fileURLToPath(new URL('./sdk/scanner.js', import.meta.url)),
      formats: ['iife'],
      // The IIFE's own variable; the script publishes HousekiScan itself, on globalThis.
      name: 'HousekiScanSdk',
      fileName: () => 'scanner.js',
    },
  },
  esbuild: { legalComments: 'none' },
});
