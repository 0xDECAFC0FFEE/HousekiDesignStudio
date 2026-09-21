<script>
  // The two left-hand panes of the workspace -- the cutting instructions and the renderer -- with
  // the handle between them that drags the instructions pane wider or narrower (2026-09-18: "I
  // want three dots in the middle of the two vertical lines on the side that allow people to click
  // on and make it wider and shorter"). shadcn-svelte's Resizable (PaneForge) does the dragging
  // and the keyboard; this file is what keeps its behaviour the page's own:
  //
  //   - The width is in PIXELS, between INSTRUCTIONS_WIDTH_MIN and _MAX (200-480), and is
  //     remembered across reloads (`gems.instructionsWidth`, written once per drag and per key
  //     press, not per pixel of a drag). PaneForge thinks in percentages of its group, so the
  //     width lives here in pixels and is converted: when the window (and so the group) is
  //     resized the pane keeps its width and the renderer takes the difference, as the fixed
  //     `flex-basis` always did, instead of the pane scaling with the window.
  //   - The handle takes no room of its own (`w-0`, with a wider hit area laid over the seam), so
  //     a pane's edge follows the pointer exactly, which percentages of a group with a handle in
  //     it would not. The 10px between the pane's double border and the renderer that the old
  //     10px-wide handle left is padding on a wrapper inside the renderer's pane instead.
  //   - ArrowLeft / ArrowRight on the focused handle move it by 16px (the old handle's step);
  //     Home and End go to the limits, and Shift+arrow too, which PaneForge adds.
  //   - A drag does NOT redraw the renderer, and does not stretch it either ("don't stretch the
  //     renderer when the instructions pane is extended/contracted", the user, 2026-09-18): for
  //     as long as the handle is held the canvas keeps the size and picture it had and is centred
  //     in the renderer's region, which clips or reveals it as the pane's edge moves ("scoot",
  //     T-0188; `beginPaneScoot` in viewport.js). Redrawing at every step was a full render each,
  //     and the LuxCore-style renderer restarted its accumulation with each one. On release
  //     (`endPaneScoot`) the canvas is redrawn once at its final size. Both are silent no-ops
  //     before boot has finished and the canvas has been drawn.
  //
  // Independent of GemApp, like the rest of the shell, so the pane is resizable (and restores
  // its saved width) even if the wasm module fails to load.
  import { onMount } from 'svelte';
  import * as Resizable from '$lib/components/ui/resizable/index.js';
  import InstructionsPane from './InstructionsPane.svelte';
  import Viewport from './Viewport.svelte';
  import SubBar from './SubBar.svelte';
  import { editing } from '../lib/edit_mode.js';
  import { fullscreen } from '../lib/fullscreen.js';
  import { beginPaneScoot, endPaneScoot } from '../lib/viewport.js';
  import {
    readSetting, writeSetting, INSTRUCTIONS_WIDTH_SETTING, INSTRUCTIONS_WIDTH_MIN,
    INSTRUCTIONS_WIDTH_MAX,
  } from '../lib/settings.js';

  // `onopengear` opens the gear dialog (App owns it); the sub bar above the renderer calls it.
  let { onopengear } = $props();

  const DEFAULT_WIDTH_PX = 280;
  const KEY_STEP_PX = 16;
  // The settings panel to the right of the group (`#panel`, 300px), for the size guess below.
  const SETTINGS_PANEL_PX = 300;

  function clampWidth(px) {
    return Math.max(INSTRUCTIONS_WIDTH_MIN, Math.min(INSTRUCTIONS_WIDTH_MAX, px));
  }

  function savedWidth() {
    const saved = Number(readSetting(INSTRUCTIONS_WIDTH_SETTING));

    return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : DEFAULT_WIDTH_PX;
  }

  // The pane's width in pixels: the one source of truth. Set from a drag or a key press, and
  // applied to the pane whenever it or the group's width changes.
  let widthPx = $state(savedWidth());
  // The group's width, in pixels (measured; 0 until it is).
  let groupPx = $state(0);
  let pane;
  let groupElement = $state(null);
  let paneElement = $state(null);

  // True while this file is the one resizing the pane, so PaneForge's report of that resize is
  // not mistaken for the user dragging.
  let applying = false;

  // True while the user is dragging the handle or holding a key on it. PaneForge also reports a
  // resize when the WINDOW changes size (it re-checks the layout against the pane's limits, which
  // are percentages that change with the group), and that report carries the old percentage: taken
  // as the user's, the pane would come out at the old percentage of the new width instead of
  // keeping its pixels.
  let interacting = false;

  // What PaneForge is given before the group has been measured: a guess from the window's
  // width, so the first frame is already near right and does not jump.
  let guessPx = $derived(groupPx || Math.max(window.innerWidth - SETTINGS_PANEL_PX, 1));
  let percent = $derived((clampWidth(widthPx) / guessPx) * 100);
  let minPercent = $derived((INSTRUCTIONS_WIDTH_MIN / guessPx) * 100);
  let maxPercent = $derived((INSTRUCTIONS_WIDTH_MAX / guessPx) * 100);

  // Keeps the pane at `widthPx` as the group's width changes under it.
  $effect(() => {
    if (pane && groupPx > 0 && Math.abs(pane.getSize() - percent) > 0.001) {
      applying = true;
      pane.resize(percent);
      applying = false;
    }
  });

  onMount(() => {
    const observer = new ResizeObserver(entries => {
      groupPx = entries[0].contentRect.width;
    });

    observer.observe(groupElement);
    groupPx = groupElement.getBoundingClientRect().width;

    return () => observer.disconnect();
  });

  // The user resized the pane (a drag, or a key on the handle).
  function onResize(size) {
    if (applying || !interacting || groupPx === 0) {
      return;
    }

    // No redraw here: the canvas is scooting (see the header), and is redrawn on release.
    widthPx = (size / 100) * groupPx;
  }

  // Written once per drag, on release, rather than on every pointermove -- a storage write for
  // every pixel of a drag is wasted work the user never asked for -- and once per key press.
  //
  // The pane's measured width is also what `widthPx` is set to here, so however PaneForge got it
  // there (a key press is handled before this file hears of it), the pixels kept are the pane's.
  function persist() {
    const width = paneElement.getBoundingClientRect().width;

    widthPx = width;
    writeSetting(INSTRUCTIONS_WIDTH_SETTING, String(Math.round(width)));
  }

  function onDraggingChange(dragging) {
    interacting = dragging;

    if (dragging) {
      beginPaneScoot();
    } else {
      persist();
      endPaneScoot();
    }
  }

  // The keys PaneForge resizes the pane with on the focused handle. Any other key (Tab) leaves
  // the renderer alone.
  const RESIZE_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

  function onkeydown(event) {
    interacting = true;

    if (RESIZE_KEYS.includes(event.key)) {
      beginPaneScoot();
    }
  }

  // The release of a key, or the handle losing focus with one held (its keyup then goes
  // elsewhere): the resize is over, so the width is kept and the renderer redrawn once.
  function onkeyup() {
    interacting = false;
    persist();
    endPaneScoot();
  }
</script>

<Resizable.PaneGroup direction="horizontal" bind:ref={groupElement}
  keyboardResizeBy={groupPx > 0 ? (KEY_STEP_PX / groupPx) * 100 : null}
  class="min-w-0 flex-1">
  <!-- The pane and its handle are HIDDEN while the settings panel's fullscreen toggle is on
       (2026-09-20), never removed: PaneForge keeps its layout and this pane keeps the width it
       was dragged to, and the renderer's pane -- then the only flex item left in the group --
       takes the whole width on its own. See fullscreen.js. On the handle, `hidden` also displaces
       the `flex` in its own base classes, which `cn`'s tailwind-merge resolves for us. -->
  <Resizable.Pane bind:this={pane} bind:ref={paneElement} defaultSize={percent} minSize={minPercent}
    maxSize={maxPercent} {onResize} class={$fullscreen ? 'hidden' : ''}>
    <InstructionsPane />
  </Resizable.Pane>

  <!-- Drag to resize the instructions pane (2026-09-18). -->
  <Resizable.Handle withHandle id="instructions-resize" aria-label="Resize the cutting instructions pane"
    aria-orientation="vertical" {onDraggingChange} {onkeydown} {onkeyup} onblur={onkeyup}
    class="w-0 translate-x-[-2px] bg-transparent text-muted-foreground hover:text-primary data-[active]:text-primary after:left-1/2 after:w-2.5 after:rounded-sm hover:after:bg-muted data-[active]:after:bg-muted {$fullscreen ? 'hidden' : ''}" />

  <Resizable.Pane>
    <!-- The 10px gap is padding on a wrapper, not on the pane: padding on a flex item that has
         no basis adds to the space it needs and would shift the split by that much. -->
    <!-- The sub bar sits right above the renderer (2026-09-19), so the instructions and settings
         panes run up to the top bar. -->
    <div class="relative flex h-full flex-col">
      <!-- Shown only in edit mode (2026-09-19, the user's request), laid over the top of the
           renderer rather than above it, so showing and hiding it never resizes the renderer
           (which would redraw the stone). -->
      {#if $editing}
        <div class="absolute inset-x-0 top-0 z-10">
          <SubBar onopen={onopengear} />
        </div>
      {/if}
      <div class="min-h-0 flex-1 pl-2.5">
        <Viewport />
      </div>
    </div>
  </Resizable.Pane>
</Resizable.PaneGroup>
