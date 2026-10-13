<script>
  // The scan page (T-0337), served at /scanner/embed.html and opened by a website in a modal
  // through /scanner.js (scanner_sdk.js), the studio's Tools > Rough scan among them. A title bar
  // naming the site that asked for the scan, with Close; then the scanner's panel on the left
  // (ScanPanel.svelte: the steps, the status, what the phone sees, Done) and its picture on the
  // right (ScanView.svelte: the QR code, then the phone's camera). On a narrow window the two stack.
  //
  // What it does with the website is scanner_host.js's handshake; scanner_protocol.js's header has
  // the whole protocol. The session starts only once a website has made the handshake, so a page
  // opened on its own (not in a frame) never opens the relays, and says what it is for instead.
  //
  //   phase  'waiting'     framed, no handshake yet (a moment, normally)
  //          'scanning'    the session is open
  //          'finished'    Done or Close; the website removes the frame
  //          'standalone'  opened on its own, outside any website
  //          'refused'     the website spoke a protocol this page does not know
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import XIcon from '@lucide/svelte/icons/x';
  import ScanPanel from '../src/components/ScanPanel.svelte';
  import ScanView from '../src/components/ScanView.svelte';
  import Tooltip from '../src/components/Tooltip.svelte';
  import { scanning, scanStream, scanResult, startScan, stopScan } from '../src/lib/scan_session.js';
  import { waitForSite } from '../src/lib/scanner_host.js';
  import { siteName, siteStatus } from '../src/lib/scanner_protocol.js';

  let phase = $state('waiting');
  let site = $state(null);
  let link = null;

  const name = $derived(site === null ? null : siteName(site));

  /** Ends the scan and tells the website how: 'result' (Done) or 'cancel' (Close, Escape). */
  function finish(type) {
    if (phase !== 'scanning') {
      return;
    }

    const result = type === 'result' ? scanResult() : null;

    stopScan();
    phase = 'finished';
    link?.post(type, type === 'result' ? { result } : {});
    link?.close();
    link = null;
  }

  function onkeydown(event) {
    if (event.key === 'Escape' && phase === 'scanning') {
      event.preventDefault();
      finish('cancel');
    }
  }

  onMount(() => {
    const waiting = waitForSite({
      onInit(accepted) {
        link = accepted;
        site = accepted.origin;
        // 'ready' first: it tells the website the scan page is up, which it waits for (to say so
        // if it never comes, scanner_sdk.js READY_TIMEOUT_MS). Starting the session and drawing
        // its code comes after, and on a slow computer takes a second or more of its own.
        accepted.post('ready');
        phase = 'scanning';
        startScan();

        // The website closed the scanner itself (HousekiScan's close()).
        accepted.onMessage(message => {
          if (message.type === 'close' && phase === 'scanning') {
            stopScan();
            phase = 'finished';
            link?.close();
            link = null;
          }
        });
      },
      onRefused() {
        phase = 'refused';
      },
    });

    if (!waiting.framed) {
      phase = 'standalone';
    }

    // The website hears the status as it changes, once each.
    let sent = null;
    const report = () => {
      const status = siteStatus(get(scanning).status, get(scanStream) !== null);

      if (link && phase === 'scanning' && status !== sent) {
        sent = status;
        link.post('status', { status });
      }
    };
    const unsubscribe = [scanning.subscribe(report), scanStream.subscribe(report)];

    // The frame removed, or the page left: the phone's link stops working with it.
    const onPageHide = () => stopScan();
    addEventListener('pagehide', onPageHide);

    return () => {
      waiting.stop();
      unsubscribe.forEach(stop => stop());
      removeEventListener('pagehide', onPageHide);
      stopScan();
    };
  });
</script>

<svelte:document {onkeydown} />

<Tooltip />

<div id="embed-app" data-phase={phase}>
  <header class="embed-bar">
    <span class="embed-title">
      <strong>Houseki scanner</strong>
      {#if phase === 'scanning' || phase === 'finished'}
        <span class="embed-site" id="embed-site" data-origin={site}>
          {name ? `· Scanning for ${name}` : '· Scanning for a page on this computer'}
        </span>
      {/if}
    </span>
    {#if phase === 'scanning'}
      <button type="button" class="embed-close" id="embed-close" aria-label="Close the scanner"
        data-tip="Closes the scanner without sending anything back, and ends the session, so the phone's link stops working. Escape does the same."
        onclick={() => finish('cancel')}><XIcon class="size-4" aria-hidden="true" /></button>
    {/if}
  </header>

  {#if phase === 'scanning'}
    <div class="embed-body">
      <div class="embed-panel"><ScanPanel ondone={() => finish('result')} /></div>
      <div class="embed-view"><ScanView /></div>
    </div>
  {:else}
    <div class="embed-message" role="status">
      {#if phase === 'standalone'}
        <h1>Houseki scanner</h1>
        <p>This is the scanner that websites open when you choose to scan a rough with your phone. Open it from the website's scan button, or from the studio's Tools menu: Rough scan.</p>
        <p><a href="../studio.html">Open the studio</a></p>
      {:else if phase === 'refused'}
        <p>This page asked for a newer version of the scanner than this one. Reload the page and try again.</p>
      {:else if phase === 'finished'}
        <p>The scan has ended.</p>
      {:else}
        <p>Starting the scanner…</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  #embed-app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--panel);
    color: var(--text);
  }

  .embed-bar {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    height: 40px;
    padding: 0 8px 0 var(--pane-pad);
    border-bottom: 1px solid var(--panel-edge);
    background: var(--topbar);
    font-size: 13px;
  }

  .embed-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .embed-title strong {
    font-weight: 600;
  }

  .embed-site {
    color: var(--muted);
  }

  .embed-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: none;
    color: var(--text);
    cursor: pointer;
  }

  .embed-close:hover,
  .embed-close:focus-visible {
    border-color: var(--accent);
    background: var(--hover);
  }

  .embed-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .embed-panel {
    flex: none;
    width: 300px;
    min-height: 0;
  }

  .embed-view {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  /* A narrow window: the picture on top, the panel under it. */
  @media (max-width: 720px) {
    .embed-body {
      flex-direction: column-reverse;
      overflow-y: auto;
    }

    .embed-panel {
      width: 100%;
    }

    .embed-view {
      flex: none;
      height: 70vh;
    }
  }

  .embed-message {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    max-width: 520px;
    margin: 0 auto;
    padding: 24px 16px;
    text-align: center;
    color: var(--muted);
    font-size: 14px;
    line-height: 20px;
  }

  .embed-message h1 {
    margin: 0;
    color: var(--text);
    font-size: 18px;
    font-weight: 600;
  }

  .embed-message p {
    margin: 0;
  }

  .embed-message a {
    color: var(--accent);
  }
</style>
