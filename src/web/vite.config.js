// Builds the page's Svelte app into ONE html file, build/web/index.html, with its script and
// styles inline. make_page.py takes it from there (it adds the wasm, the model and the skybox
// and writes build/www/studio.html), so this config never has to know about them.
//
// Everything is inline because the finished page must open from file://, where Chrome and
// Firefox give a page an opaque origin and refuse to load a separate module or fetch anything
// (kb/failed-approaches.md). An inline <script type="module"> with no imports is fine there.

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

// @tailwindcss/node registers a module-loader hook when it loads, unless it thinks it is running
// under Bun, and Deno (2.6) has the function but throws "Module loader hooks are not yet
// supported". The hook only serves Tailwind's own TypeScript/ESM config loading, which this
// build does not use (the theme is CSS), so it is skipped by saying the runtime is Bun-like
// before the plugin loads. Dynamic import, because a static one would load it first.
Object.defineProperty(process.versions, 'bun', { value: '0', configurable: true });

const { default: tailwindcss } = await import('@tailwindcss/vite');

export default defineConfig({
  // `$lib` is where shadcn-svelte's CLI puts its components (`$lib/components/ui`) and its `cn`
  // helper, the alias SvelteKit gives it; this is plain Vite, so it is declared here and in
  // jsconfig.json (which the CLI reads).
  resolve: {
    alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) },
  },
  plugins: [
    tailwindcss(),
    svelte({
      // The markup is the hand-written page's, unchanged (the port must not redesign the UI):
      // div menu items and tier rows with click handlers, and a `<nav>` that catches clicks
      // bubbling from its items, all with their own roles, keyboard handling and focus where
      // they need them. The compiler's accessibility lint would have every one rewritten as
      // something else, so it is muted; any other warning still prints.
      //
      // Also muted: `state_referenced_locally` (new in Svelte 5.4x), which flags reading a prop
      // at the top of a component. The components that do so mean it: a slider's `name`, a
      // tier row's `tier` or a switch's initial `checked` never change for the life of the
      // component (a row is rebuilt, not updated, when its tier changes), and the value is
      // captured once on purpose.
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
    // Everything generated lives under build/, which is gitignored; this is src/web, so that
    // is two levels up. make_page.py reads the result as build/web/index.html (its TEMPLATE),
    // so the two must agree. emptyOutDir is explicit because the directory is outside the
    // Vite root and Vite refuses to clear such a directory without being told to.
    outDir: '../../build/web',
    emptyOutDir: true,
    target: 'es2022',
    // Nothing is left as a separate file, so nothing may be preloaded from one either.
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
  },
  // esbuild drops every comment (there are no licence comments to keep in this bundle); the
  // page's own check-page step fails the build if one survives anyway.
  esbuild: { legalComments: 'none' },
});
