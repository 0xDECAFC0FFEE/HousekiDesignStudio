<script>
  // Tools > Rough scan's panel (T-0314), in the LEFT pane while the mode is open, in place of the
  // cutting instructions (Workspace.svelte stacks the two, as it does record rendering's); the
  // render settings stay on the right, and the QR code and then the phone's camera take the
  // renderer's place (ScanView.svelte). What the steps say, the status, New code and Done at the
  // pane's foot -- the buttons' work is scan_mode.js's.
  import { Button } from '$lib/components/ui/button/index.js';
  import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
  import PanelSection from './PanelSection.svelte';
  import { scanning, scanStream, exitScan, newScanCode, scanStatusText } from '../lib/scan_mode.js';

  // The modes' ways out look and sit alike (RecordPanel's, verbatim).
  const ACTION = 'h-8 flex-1 border-[var(--panel-edge)] bg-[var(--raised)] px-3 text-[13px] text-[var(--text)] shadow-none hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--text)] dark:border-[var(--panel-edge)] dark:bg-[var(--raised)] dark:hover:border-[var(--accent)] dark:hover:bg-[var(--hover)]';

  const scan = $derived($scanning);
  const status = $derived(scanStatusText(scan, $scanStream !== null));
</script>

<div id="scan-panel" inert={!scan.open}>
  <PanelSection title="Phone" id="scan-phone-section">
    <ol class="scan-steps">
      <li>Put your phone on the same network as this computer, for example the same Wi-Fi.</li>
      <li>Scan the code in the middle with the phone's camera and open the link, or send the link to the phone.</li>
      <li>Allow the camera when the phone asks. Its picture appears here.</li>
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
