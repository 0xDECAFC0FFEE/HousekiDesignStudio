// Builds the phone scanner page (src/web/scanner, T-0313) into ONE html file,
// build/scanner/index.html, with its script (Trystero included) and styles inline.
// make_page.py copies it to build/www/scanner/index.html, so the site serves it at /scanner.
//
// A separate build from the app's (vite.config.js): the phone page is a small page of its own,
// not the app, and vite-plugin-singlefile makes one file per build. One file because the
// harness can then also open it from file://, as the app is opened, which is how
// tests/harness/test_scan_link.py shows Trystero works from a file:// page.

import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./scanner', import.meta.url)),
  // Relative asset URLs: the page is served at /scanner/ on the site and from file:// in tests.
  base: './',
  plugins: [viteSingleFile()],
  build: {
    // Everything generated lives under build/, which is gitignored. make_page.py reads
    // build/scanner/index.html (SCANNER_BUILD), so the two must agree.
    outDir: fileURLToPath(new URL('../../build/scanner', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
  },
  esbuild: { legalComments: 'none' },
});
