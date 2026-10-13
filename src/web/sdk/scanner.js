// /scanner.js (T-0337): the one script a website includes to open the Houseki scanner. Built by
// src/web/vite.sdk.config.js into a single classic script, build/sdk/scanner.js, which
// make_page.py installs at the site's root, build/www/scanner.js.
//
//   <script src="https://houseki.app/scanner.js"></script>
//   HousekiScan.open({ onResult(result) { ... }, onCancel() { ... } });
//
// The work is scanner_sdk.js's; this file only publishes it. The scan page it opens is the one
// beside this script on its own site (https://houseki.app/scanner/embed.html for the published
// script, a local test server's for a local build), unless `embedUrl` says otherwise.

import { openScanner } from '../src/lib/scanner_sdk.js';
import { EMBED_PATH, SCAN_PROTOCOL_VERSION } from '../src/lib/scanner_protocol.js';

// Read now: `document.currentScript` is only set while a classic script first runs.
const script = globalThis.document?.currentScript;
const scriptUrl = script?.src ? new URL(script.src) : null;
const besideScript = scriptUrl && (scriptUrl.protocol === 'http:' || scriptUrl.protocol === 'https:')
  ? new URL(EMBED_PATH, scriptUrl).href
  : undefined;

globalThis.HousekiScan = Object.freeze({
  version: SCAN_PROTOCOL_VERSION,
  open: (options = {}) => openScanner({ ...options, embedUrl: options.embedUrl ?? besideScript }),
});
