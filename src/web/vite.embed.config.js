// Builds the scan page (src/web/embed, T-0337) into ONE html file, build/embed/index.html, with its
// script (Svelte, the studio's scanner components, Trystero) and styles inline. make_page.py copies
// it to build/www/scanner/embed.html, so the site serves it at /scanner/embed.html, beside the
// phone's page. A website opens it in a modal through /scanner.js (vite.sdk.config.js).
//
// One file, as the phone's page is (vite.scanner.config.js): the harness can open it from file://
// too, and make_page.py refuses a page that loads anything by src=. The Svelte and Tailwind set-up
// is the studio's (vite.config.js), so the scanner's components look the same here as they did in
// the studio; see that file for why each piece is there.

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

// As in vite.config.js: Tailwind's loader hook is not supported under Deno, and is not needed.
Object.defineProperty(process.versions, 'bun', { value: '0', configurable: true });

const { default: tailwindcss } = await import('@tailwindcss/vite');

export default defineConfig({
  root: fileURLToPath(new URL('./embed', import.meta.url)),
  // Relative asset URLs: the page is served at /scanner/embed.html on the site and from file:// in
  // tests.
  base: './',
  resolve: {
    alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) },
  },
  plugins: [
    tailwindcss(),
    svelte({
      // The studio's components, with the studio's muted warnings (vite.config.js says why).
      onwarn(warning, handler) {
        if (warning.code.startsWith('a11y_') || warning.code === 'state_referenced_locally') {
          return;
        }

        handler(warning);
      },
    }),
    viteSingleFile(),
  ],
  build: {
    // Everything generated lives under build/, which is gitignored. make_page.py reads
    // build/embed/index.html (EMBED_BUILD), so the two must agree.
    outDir: fileURLToPath(new URL('../../build/embed', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
  },
  esbuild: { legalComments: 'none' },
});
