<script>
  // The page: a top bar over a three-pane workspace -- the cutting instructions on
  // the left, the renderer in the middle (with the sub bar right above it), the settings on the right -- plus the gear dialog and
  // the tooltip. `body` is the column flex the top bar and `#layout` stack in (see base.css), so
  // App mounts straight into `body` and adds no wrapper element of its own.
  //
  // What loads the wasm module and drives the stone is boot.js, started by main.js after this
  // mounts; everything here draws from the stores that module family writes to.
  import TopBar from './components/TopBar.svelte';
  import GearDialog from './components/GearDialog.svelte';
  import CommentsDialog from './components/CommentsDialog.svelte';
  import LoadAlertDialog from './components/LoadAlertDialog.svelte';
  import Workspace from './components/Workspace.svelte';
  import SettingsPanel from './components/SettingsPanel.svelte';
  import EditPanel from './components/EditPanel.svelte';
  import Tooltip from './components/Tooltip.svelte';
  import { editing, cancelEditMode } from './lib/edit_mode.js';
  import { exitFullscreen } from './lib/fullscreen.js';
  import { eventTargetTakesText } from './lib/keys.js';

  let gearDialog;

  // Escape cancels edit mode (T-0193; the same as its Cancel button, which undoes the edits), unless it is someone else's Escape: a field being typed
  // in, or an open dialog or menu, each of which closes itself on it.
  //
  // With no edit session to cancel, the same Escape leaves fullscreen (2026-09-20), which is a
  // no-op when the page is not in it. Edit mode first, and only one of the two per press: edit
  // mode swaps the render settings for its own bar, so while both are on, the button that leaves
  // fullscreen is off the screen and the first Escape has to be the one that brings it back.
  function onkeydown(event) {
    if (event.key !== 'Escape' || event.defaultPrevented || eventTargetTakesText(event) ||
      document.querySelector('[role="dialog"], [role="menu"]')) {
      return;
    }

    if ($editing) {
      cancelEditMode();
    } else {
      exitFullscreen();
    }
  }
</script>

<svelte:document {onkeydown} />

<TopBar />

<GearDialog bind:this={gearDialog} />

<!-- The design's header and footer comments (2026-09-19). Mounted here beside the gear dialog,
     but opened from the `commentsOpen` store rather than a handle: the button that opens it is in
     the tier toolbar, deep inside the workspace -- see CommentsDialog's own header. -->
<CommentsDialog />

<!-- A file or a shared link that could not be read (2026-09-19): a big red dialog over the whole
     page, driven by the `loadAlert` store, since what raises it are plain modules -- the reader,
     the startup path, the hash restore -- with no component to hold a handle. -->
<LoadAlertDialog />

<div id="layout">
  <Workspace onopengear={() => gearDialog.open()}>
    <!-- The right-hand column: the render settings, or edit mode's own bar in their place
         (2026-09-19, the user: "instead of hiding the rendering settings bar, can you change it
         into an edit mode bar?"). Both are always mounted, stacked in one grid cell, and the one
         not in use is `visibility: hidden`, so each keeps its own state (an open section, a
         half-finished drag) while the other shows. The column is Workspace's third, resizable
         pane since 2026-09-22 ("can you make both left and right pane widths draggable"), so
         both fill whatever width it is dragged to. -->
    {#snippet right()}
      <div id="panel-stack">
        <div class="panel-layer" class:panel-layer-off={$editing}><SettingsPanel /></div>
        <div class="panel-layer" class:panel-layer-off={!$editing}><EditPanel /></div>
      </div>
    {/snippet}
  </Workspace>
</div>

<Tooltip />
