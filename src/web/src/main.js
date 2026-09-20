// Entry point: the page's styles, the Svelte app mounted into <body>, and boot (wasm and the
// stone). The styles are one import: tailwind.css pulls in Tailwind, the shadcn-svelte theme and
// the page's own plain global CSS, in the order it was written in, so the cascade among those
// files is exactly what the page had when it was one file.

import { mount } from 'svelte';
import './styles/tailwind.css';
import App from './App.svelte';
import { boot } from './lib/boot.js';
import { showError } from './lib/stores.js';
import { initShareUrl } from './lib/share_state.js';

mount(App, { target: document.body });

// initShareUrl (T-0198) runs after boot() so the app and the edit history already exist: it
// restores a shared link's design if the page was opened on one (instead of leaving the
// built-in stone showing), and from then on keeps the URL hash in step with every edit.
boot()
  .then(() => initShareUrl())
  .catch(cause => showError(String(cause)));
