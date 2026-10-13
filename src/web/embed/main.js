// The scan page (T-0337), served at /scanner/embed.html: what a website's HousekiScan.open() shows
// in its modal (src/web/sdk/scanner.js). src/web/vite.embed.config.js builds this, index.html and
// EmbedApp.svelte into one file, build/embed/index.html, which make_page.py copies to
// build/www/scanner/embed.html. The HTML holds no comment, because the built page keeps them and
// the page is public.
//
// The theme is the site's (theme.js: the saved light or dark choice, read before the first frame),
// and the styles are the studio's, so the scanner looks the same inside the studio and on another
// website. Inside another website the browser keeps this page's storage apart from houseki.app's
// own, so the theme there is the default, dark, unless chosen on that site before.

import '../../site/theme.js';
import { mount } from 'svelte';
import './embed.css';
import EmbedApp from './EmbedApp.svelte';

// The harness drives the scan page as it drives the studio (window.gemApp): the session's stores.
// Nothing in the page's UI uses it.
import * as scanSession from '../src/lib/scan_session.js';

globalThis.housekiScanSession = scanSession;

mount(EmbedApp, { target: document.body });
