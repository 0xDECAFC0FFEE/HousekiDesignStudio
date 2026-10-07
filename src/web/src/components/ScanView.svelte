<script>
  // Tools > Rough scan's picture (T-0314), laid over the renderer while the mode is open
  // (Workspace.svelte): the QR code for the phone to scan, with the link under it to copy instead,
  // then -- once the phone streams -- its live camera in the same place. The user, 2026-10-02:
  // "the rough scanning mode first shows a qr code on the screen ... once the qr code is scanned by
  // the phone, we start streaming the phone's camera output to the phone screen and the website",
  // and "in addition to the qr code can you also have a copyable url under the qr code so users can
  // send it instead of using the qr code".
  //
  // The code is drawn dark on white in both themes, inside its quiet zone (scan_qr.js), as large as
  // the region allows up to 420px: a phone reads a big, high-contrast code from further away and at
  // a worse angle. The link is plain selectable text (one click selects all of it), so it can be
  // copied by hand where the clipboard refuses, as it can from a page opened as a file.
  //
  // Over the phone's video, what the phone sees (T-0326): the rock's outline, the board's edge and
  // its axes at the target, drawn from the phone's latest vision message (scan_mode.js
  // `scanVision`) on a canvas the size of the video element, mapped as the video's object-fit:
  // contain maps the phone's frame. The messages are about 10 a second and can lead or lag the
  // picture by a few frames; the latest is always drawn, faded once it is older than
  // VISION_STALE_MS and gone after VISION_GONE_MS. Nothing is drawn while the video's shape does
  // not match the message's frame (the phone was just turned).
  import CopyIcon from '@lucide/svelte/icons/copy';
  import CheckIcon from '@lucide/svelte/icons/check';
  import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
  import { Button } from '$lib/components/ui/button/index.js';
  import {
    scanning, scanStream, scanVision, copyScanLink, newScanCode, scanStatusText, visionAge,
    VISION_STALE_MS, VISION_GONE_MS,
  } from '../lib/scan_mode.js';
  import { isMacPlatform } from '../lib/keys.js';
  import { drawVisionOverlay, fitTransform, prepareCanvas } from '../lib/vision/overlay.js';

  // The modes' buttons, as RecordPanel and EditPanel draw them.
  const ACTION = 'h-8 border-[var(--panel-edge)] bg-[var(--raised)] px-3 text-[13px] text-[var(--text)] shadow-none hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:border-[var(--accent)] dark:hover:bg-[var(--hover)]';

  const COPY_TIP = 'Copies the link, so you can send it to your phone instead of scanning the code. The link works like a key to this session: send it only to your own phone.';
  const NEW_CODE_TIP = 'Ends this session and makes a new code and link. A phone that is connected is cut off, and the old link stops working.';

  const scan = $derived($scanning);
  const stream = $derived($scanStream);
  const status = $derived(scanStatusText(scan, stream !== null));
  // The code is shown until the phone streams, while a session is there to be joined -- after a
  // phone left too, since the same code connects it again.
  const showCode = $derived(stream === null && scan.qr !== null && scan.status !== 'error');
  const copyKeys = isMacPlatform() ? '⌘C' : 'Ctrl+C';

  let video = $state(null);
  let overlay = $state(null);
  let urlText = $state(null);

  // The overlay, redrawn every animation frame while the phone streams (its age changes even when
  // no message comes, and the element's size with the window).
  $effect(() => {
    if (!overlay || !stream) {
      return;
    }

    let frame = requestAnimationFrame(function draw() {
      frame = requestAnimationFrame(draw);
      drawVision();
    });

    return () => {
      cancelAnimationFrame(frame);
      prepareCanvas(overlay);
    };
  });

  /** One frame of the overlay; `data-drawn` on the canvas says what it showed (for the harness). */
  function drawVision() {
    const { ctx, width, height } = prepareCanvas(overlay);
    const vision = $scanVision;
    const age = visionAge(vision, performance.now());
    let drawn = 'none';

    if (vision && age <= VISION_GONE_MS && video?.videoWidth > 0) {
      const { message } = vision;
      const sameShape = Math.abs((video.videoWidth / video.videoHeight) / (message.frame.w / message.frame.h) - 1) < 0.02;

      if (sameShape) {
        const posed = Boolean(message.pose?.valid && message.intrinsics);
        drawVisionOverlay(ctx, {
          pose: posed ? message.pose : null,
          intrinsics: posed ? message.intrinsics : null,
          targetMm: message.board.targetMm,
          sizeMm: message.board.sizeMm,
          contour: posed ? message.outline?.contour ?? null : null,
          corners: null,
        }, fitTransform(message.frame.w, message.frame.h, width, height, 'contain'),
        { alpha: age > VISION_STALE_MS ? 0.35 : 1, frame: [message.frame.w, message.frame.h] });
        drawn = age > VISION_STALE_MS ? 'stale' : posed ? (message.outline ? 'pose+outline' : 'pose') : 'board';
      } else {
        drawn = 'shape-mismatch';
      }
    }

    if (overlay.dataset.drawn !== drawn) {
      overlay.dataset.drawn = drawn;
    }
  }

  // The phone's camera into the <video>. Muted (it has no sound to give) and inline, which is what
  // lets a browser play it without a click.
  $effect(() => {
    if (!video) {
      return;
    }

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }

    if (stream) {
      video.play?.()?.catch?.(() => {});
    }
  });

  /** Selects the link's text, for copying by hand. */
  function selectLink() {
    if (!urlText) {
      return;
    }

    const range = document.createRange();

    range.selectNodeContents(urlText);

    const selection = window.getSelection();

    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function copy() {
    const outcome = await copyScanLink();

    if (outcome === 'manual') {
      selectLink();
    }
  }
</script>

<div id="scan-view" data-status={scan.status} data-streaming={stream !== null}>
  <!-- Always in the document while the mode is open, hidden until the phone streams, so the
       element a stream is put into is never torn down and rebuilt as the status changes. -->
  <video id="scan-video" class="scan-video" class:scan-hidden={stream === null} bind:this={video}
    autoplay playsinline muted aria-label="Your phone's camera"></video>
  <canvas id="scan-overlay" class="scan-overlay" class:scan-hidden={stream === null} bind:this={overlay}
    aria-hidden="true"></canvas>

  {#if stream !== null}
    <div class="scan-badge" id="scan-live" role="status"><span class="scan-dot scan-dot-live"></span>Live from your phone</div>
  {:else}
    <div class="scan-card">
      <h2 class="scan-title">Scan with your phone</h2>

      {#if showCode}
        <p class="scan-line">Point your phone's camera at the code and open the link it shows. The phone and this computer need to be on the same network.</p>

        <!-- The code, dark on white with its quiet zone, in both themes. role="img", named by the
             link it holds, so a screen reader says what it is. -->
        <div class="scan-qr-tile">
          <svg id="scan-qr" class="scan-qr" viewBox="0 0 {scan.qr.size} {scan.qr.size}" role="img"
            aria-label="QR code for the scanner link" shape-rendering="crispEdges" data-url={scan.url}>
            <rect width={scan.qr.size} height={scan.qr.size} fill="#ffffff" />
            <path d={scan.qr.path} fill="#000000" />
          </svg>
        </div>

        <div class="scan-link-row">
          <span class="scan-link-label" id="scan-url-label">Or send the link to your phone:</span>
          <div class="scan-link">
            <code id="scan-url" class="scan-url" bind:this={urlText} aria-labelledby="scan-url-label">{scan.url}</code>
            <Button variant="outline" size="sm" id="scan-copy" class="{ACTION} shrink-0 gap-1.5" data-tip={COPY_TIP}
              onclick={copy}>
              {#if scan.copy === 'copied'}
                <CheckIcon class="size-3.5" aria-hidden="true" />Copied
              {:else}
                <CopyIcon class="size-3.5" aria-hidden="true" />Copy
              {/if}
            </Button>
          </div>
          <p class="scan-copy-note" id="scan-copy-note" role="status">
            {#if scan.copy === 'manual'}
              This browser would not copy it for you: the link is selected, so press {copyKeys} to copy it.
            {/if}
          </p>
        </div>
      {/if}

      <div class="scan-status" id="scan-status" role="status" aria-live="polite">
        <span class="scan-dot" class:scan-dot-busy={scan.status === 'connecting' || scan.status === 'connected'}
          class:scan-dot-error={scan.status === 'error' || scan.status === 'disconnected'}></span>
        <span><strong>{status.title}</strong> · {status.detail}</span>
      </div>

      {#if scan.status === 'error'}
        <Button variant="outline" size="sm" id="scan-view-new-code" class="{ACTION} gap-1.5" data-tip={NEW_CODE_TIP}
          onclick={newScanCode}><RefreshIcon class="size-3.5" aria-hidden="true" />New code</Button>
      {/if}
    </div>
  {/if}
</div>

<style>
  #scan-view {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--panel);
  }

  .scan-video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000000;
  }

  /* What the phone sees, over its video and the same size: fitTransform letterboxes as it does. */
  .scan-overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .scan-hidden {
    display: none;
  }

  .scan-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    width: min(100%, 460px);
    margin: auto;
    padding: 20px 16px;
    text-align: center;
    color: var(--text);
  }

  .scan-title {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
  }

  .scan-line {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 18px;
  }

  /* White behind the code in both themes, with a little room of its own outside the quiet zone so
     the tile's rounded corner never clips a module. */
  .scan-qr-tile {
    width: min(100%, 420px, 52vh);
    padding: 6px;
    border-radius: var(--radius-card);
    background: #ffffff;
    box-shadow: var(--floating-shadow);
  }

  .scan-qr {
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: 1;
  }

  .scan-link-row {
    width: 100%;
  }

  .scan-link-label {
    display: block;
    margin-bottom: 4px;
    color: var(--muted);
    font-size: 12px;
  }

  .scan-link {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* Plain text the user can select; one click selects the whole link. */
  .scan-url {
    flex: 1;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--panel-edge);
    border-radius: var(--radius-control);
    background: var(--raised);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 15px;
    text-align: left;
    overflow-wrap: anywhere;
    user-select: all;
    -webkit-user-select: all;
    cursor: text;
  }

  .scan-copy-note {
    min-height: 0;
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 15px;
  }

  .scan-copy-note:empty {
    display: none;
  }

  .scan-status {
    display: flex;
    align-items: baseline;
    gap: 8px;
    color: var(--muted);
    font-size: 12px;
    line-height: 17px;
    text-align: left;
  }

  .scan-status strong {
    color: var(--text);
    font-weight: 600;
  }

  .scan-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
    transform: translateY(-1px);
  }

  .scan-dot-busy {
    background: var(--accent);
    animation: scan-pulse 1.2s ease-in-out infinite;
  }

  .scan-dot-error {
    background: var(--error);
  }

  .scan-dot-live {
    background: var(--error);
    animation: scan-pulse 1.2s ease-in-out infinite;
  }

  @keyframes scan-pulse {
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .scan-dot-busy,
    .scan-dot-live {
      animation: none;
    }
  }

  /* Over the video, top left, so it is plain the picture is the phone's and live. */
  .scan-badge {
    position: absolute;
    top: 12px;
    left: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    border-radius: var(--radius-control);
    background: var(--floating);
    box-shadow: var(--floating-shadow);
    backdrop-filter: blur(10px);
    color: var(--text);
    font-size: 12px;
  }
</style>
