<script>
  // Tools > Rough scan's panel (T-0314), in the LEFT pane while the mode is open, in place of the
  // cutting instructions (Workspace.svelte stacks the two, as it does record rendering's); the
  // render settings stay on the right, and the QR code and then the phone's camera take the
  // renderer's place (ScanView.svelte). What the steps say, the status, New code and Done at the
  // pane's foot -- the buttons' work is scan_mode.js's.
  import { Button } from '$lib/components/ui/button/index.js';
  import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
  import PanelSection from './PanelSection.svelte';
  import {
    scanning, scanStream, scanVision, exitScan, newScanCode, scanStatusText, scanVisionText,
  } from '../lib/scan_mode.js';
  import { coverageMapCells, mapPoint } from '../lib/vision/guidance.js';

  // The coverage map (T-0331), as on the phone: the sheet seen from above, its top edge up; rings
  // from low (outside) to straight down (the middle), filled where the phone has filmed well.
  const MAP_CELLS = coverageMapCells();

  // The modes' ways out look and sit alike (RecordPanel's, verbatim).
  const ACTION = 'h-8 flex-1 border-[var(--panel-edge)] bg-[var(--raised)] px-3 text-[13px] text-[var(--text)] shadow-none hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:border-[var(--accent)] dark:hover:bg-[var(--hover)]';

  const scan = $derived($scanning);
  const status = $derived(scanStatusText(scan, $scanStream !== null));

  // What the phone sees (T-0326), read out from its latest vision message. A clock ticking twice a
  // second while the phone streams lets the readout say when the messages have stopped.
  let clock = $state(0);

  $effect(() => {
    if ($scanStream === null) {
      return;
    }

    const timer = setInterval(() => {
      clock = performance.now();
    }, 500);

    return () => clearInterval(timer);
  });

  const seen = $derived(scanVisionText($scanVision, Math.max(clock, $scanVision?.receivedAt ?? 0)));
</script>

<div id="scan-panel" inert={!scan.open}>
  <PanelSection title="Phone" id="scan-phone-section">
    <ol class="scan-steps">
      <li>Put your phone on the same network as this computer, for example the same Wi-Fi.</li>
      <li>Scan the code in the middle with the phone's camera and open the link, or send the link to the phone.</li>
      <li>Allow the camera when the phone asks. Its picture appears here.</li>
      <li>Lay the printed board flat, put the rock on its target, and point the phone at it. The board's grid and axes and the rock's outline are drawn over the picture, and the phone shows where to film from next.</li>
    </ol>
  </PanelSection>

  <PanelSection title="Connection" id="scan-connection-section">
    <p class="scan-panel-status" id="scan-panel-status" data-status={scan.status}>
      <strong>{status.title}</strong><br />{status.detail}
    </p>
    <Button variant="outline" size="sm" id="scan-new-code" class="{ACTION} w-full gap-1.5"
      data-tip="Ends this session and makes a new code and link. A phone that is connected is cut off, and the old link stops working."
      onclick={newScanCode}><RefreshIcon class="size-3.5" aria-hidden="true" />New code</Button>
  </PanelSection>

  {#if seen}
    <PanelSection title="What the phone sees" id="scan-vision-section">
      <dl class="scan-seen" id="scan-vision-readout">
        {#each seen.rows as row (row.label)}
          <dt>{row.label}</dt>
          <dd data-row={row.label.toLowerCase()}>{row.value}</dd>
        {/each}
      </dl>
      {#if seen.guide}
        {@const here = mapPoint(seen.guide.azimuthDeg, seen.guide.elevationDeg)}
        <svg class="scan-map" id="scan-vision-map" viewBox="-1.08 -1.08 2.16 2.16" role="img"
          aria-label="Where the phone has filmed the rock from, seen from above">
          {#each MAP_CELLS as cell (cell.band * 12 + cell.sector)}
            <path d={cell.d} class:filled={(seen.guide.cover[cell.band] >> cell.sector) & 1}></path>
          {/each}
          <circle cx={here[0]} cy={here[1]} r="0.09" class="scan-map-here"></circle>
        </svg>
      {/if}
      {#if seen.note}
        <p class="scan-seen-note" id="scan-vision-note">{seen.note}</p>
      {/if}
    </PanelSection>
  {/if}

  <div class="scan-actions">
    <Button variant="outline" size="sm" id="scan-done" class={ACTION + ' border-[var(--accent)] text-[var(--accent)] dark:border-[var(--accent)]'}
      data-tip="Closes the rough scan: ends the session, so the phone's link stops working, and brings back the cutting instructions and the stone. Escape does the same."
      onclick={exitScan}>Done</Button>
  </div>
</div>

<style>
  #scan-panel {
    width: 100%;
    height: 100%;
    background: var(--panel);
    /* The same hairline, padding and scrolling column as #instructions-pane, whose place it takes. */
    border-right: 1px solid var(--panel-edge);
    padding: var(--pane-pad) var(--pane-pad) 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .scan-steps {
    margin: 0;
    padding-left: 18px;
    /* Numbered: Tailwind's base styles take a list's markers away. */
    list-style: decimal;
    color: var(--text);
    font-size: 12px;
    line-height: 17px;
  }

  .scan-steps li + li {
    margin-top: 6px;
  }

  .scan-panel-status {
    margin: 0 0 10px;
    color: var(--muted);
    font-size: 12px;
    line-height: 17px;
  }

  .scan-panel-status strong {
    color: var(--text);
    font-weight: 600;
  }

  /* Label and value side by side, one row each. */
  .scan-seen {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 10px;
    margin: 0;
    font-size: 12px;
    line-height: 17px;
  }

  .scan-seen dt {
    color: var(--muted);
  }

  .scan-seen dd {
    margin: 0;
    color: var(--text);
  }

  .scan-map {
    display: block;
    width: 112px;
    height: 112px;
    margin: 10px auto 0;
  }

  .scan-map path {
    fill: color-mix(in srgb, var(--muted) 18%, transparent);
    stroke: var(--panel);
    stroke-width: 0.02;
  }

  .scan-map path.filled {
    fill: var(--accent);
  }

  .scan-map-here {
    fill: #ebcb8b;
    stroke: var(--panel);
    stroke-width: 0.03;
  }

  .scan-seen-note {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 17px;
  }

  .scan-actions {
    display: flex;
    gap: 8px;
    /* Pinned to the pane's foot, as the tier toolbar is in the cutting instructions. */
    position: sticky;
    bottom: 0;
    margin: auto calc(-1 * var(--pane-pad)) 0;
    padding: var(--pane-pad);
    background: var(--panel);
  }
</style>
