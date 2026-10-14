<script>
  // The connection picture (T-0342) in the scanner's Connection card: connection_diagram.js drawn
  // from the session's latest step (scan_session.js scanTrace). The picture is made once and only
  // updated, so a step change moves the arrows on rather than restarting them.
  import { onMount } from 'svelte';
  import { CONNECTION_DIAGRAM_CSS, createConnectionDiagram } from '../lib/connection_diagram.js';

  let { trace = null, error = false } = $props();
  let box;
  let diagram = $state(null);

  onMount(() => {
    if (!document.getElementById('connection-diagram-css')) {
      const style = document.createElement('style');
      style.id = 'connection-diagram-css';
      style.textContent = CONNECTION_DIAGRAM_CSS;
      document.head.append(style);
    }

    diagram = createConnectionDiagram(box, { role: 'computer', label: 'How the connection to your phone is going' });
    return () => diagram?.destroy();
  });

  $effect(() => {
    diagram?.update({ ...(trace ?? { step: 'servers' }), error });
  });
</script>

<div class="connection-diagram" id="scan-connection-diagram" bind:this={box} data-step={trace?.step ?? 'servers'}></div>

<style>
  .connection-diagram {
    margin: 2px 0 8px;
  }
</style>
