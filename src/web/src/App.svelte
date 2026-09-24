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
  import ScaleHeightPanel from './components/ScaleHeightPanel.svelte';
  import CuttingAssistantPanel from './components/CuttingAssistantPanel.svelte';
  import { editing, cancelEditMode } from './lib/edit_mode.js';
  import { scaleHeightOpen, cancelScaleHeightMode } from './lib/scale_height_mode.js';
  import { cutting, exitCuttingAssistant, step } from './lib/cutting_assistant_mode.js';
  import ResizeGirdlePanel from './components/ResizeGirdlePanel.svelte';
  import { resizeGirdleOpen, cancelResizeGirdleMode } from './lib/resize_girdle_mode.js';
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
    if (event.defaultPrevented || eventTargetTakesText(event) ||
      document.querySelector('[role="dialog"], [role="menu"]')) {
      return;
    }

    // The cutting assistant's arrows (T-0234): Left and Right a cut, with Shift a tier -- the
    // four buttons, from the keyboard. Not while the slider has the focus, whose own arrow keys
    // already move a cut (and did, before this saw the key).
    if ($cutting.open && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      !event.altKey && !event.ctrlKey && !event.metaKey &&
      event.target?.getAttribute?.('role') !== 'slider') {
      event.preventDefault();

      if (event.key === 'ArrowRight') {
        (event.shiftKey ? step.nextTier : step.nextCut)();
      } else {
        (event.shiftKey ? step.prevTier : step.prevCut)();
      }

      return;
    }

    if (event.key !== 'Escape') {
      return;
    }

    // Scale height mode (T-0231) the same way: its Cancel's twin. And the cutting assistant
    // (T-0234), whose Done is its only way out, since it changes nothing to cancel. The modes are
    // never open together (each refuses while another is), so the order between them is moot.
    if ($editing) {
      cancelEditMode();
    } else if ($scaleHeightOpen) {
      cancelScaleHeightMode();
    } else if ($cutting.open) {
      exitCuttingAssistant();
    } else if ($resizeGirdleOpen) {
      // Resize girdle (T-0237), likewise: never open together with either of the others.
      cancelResizeGirdleMode();
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
    <!-- Scale height mode's panel (T-0231) is a third layer of the same stack, shown while that
         mode is open, the way edit mode's is, and the cutting assistant's bar (T-0234) a fourth. -->
    {#snippet right()}
      <div id="panel-stack">
        <div class="panel-layer" class:panel-layer-off={$editing || $scaleHeightOpen || $cutting.open || $resizeGirdleOpen}><SettingsPanel /></div>
        <div class="panel-layer" class:panel-layer-off={!$editing}><EditPanel /></div>
        <div class="panel-layer" class:panel-layer-off={!$scaleHeightOpen}><ScaleHeightPanel /></div>
        <div class="panel-layer" class:panel-layer-off={!$cutting.open}><CuttingAssistantPanel /></div>
        <!-- Resize girdle mode's panel (T-0237), a fifth layer. -->
        <div class="panel-layer" class:panel-layer-off={!$resizeGirdleOpen}><ResizeGirdlePanel /></div>
      </div>
    {/snippet}
  </Workspace>
</div>

<Tooltip />
