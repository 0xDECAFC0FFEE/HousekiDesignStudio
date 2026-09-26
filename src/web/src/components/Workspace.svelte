<script>
  // The workspace's three panes -- the cutting instructions, the renderer, and the right-hand
  // column (the render settings, or edit mode's bar, which App passes in as `right`) -- with a
  // handle on each seam that drags the side pane beside it wider or narrower. The left one dates
  // from 2026-09-18; the right one from 2026-09-22 (the user: "can you make both left and right
  // pane widths draggable"), when the right column moved into this group from beside it, where
  // it was a fixed 300px.
  // Each handle is the seam itself since T-0226 (the user, 2026-09-22: "i especially dislike the
  // bar with 3 dots"): no grip, and no double border and gutter either side -- the pane's one
  // hairline border, which turns into a 2px accent line under the pointer and while dragged, with
  // a column-resize cursor. shadcn-svelte's Resizable (PaneForge) does the dragging and the
  // keyboard; this file is what keeps its behaviour the page's own:
  //
  //   - Each side pane's width is in PIXELS, between its MIN and MAX (instructions 200-480,
  //     settings 240-480), and is remembered across reloads (`gems.instructionsWidth`,
  //     `gems.settingsWidth`, written once per drag and per key press, not per pixel of a drag).
  //     PaneForge thinks in percentages of its group, so the widths live here in pixels and are
  //     converted: when the window (and so the group) is resized the side panes keep their widths
  //     and the renderer takes the difference, instead of every pane scaling with the window.
  //   - On a window too narrow for both side panes and RENDERER_MIN_PX of renderer, the two side
  //     panes shrink together, in proportion, rather than crushing the renderer to nothing.
  //   - The handles take no room of their own (`w-0`, with a wider hit area laid over the seam),
  //     so a pane's edge follows the pointer exactly, which percentages of a group with a handle
  //     in it would not. The renderer starts right at both seams.
  //   - ArrowLeft / ArrowRight on a focused handle move it by 16px (the old handle's step);
  //     Home and End go to the limits, and Shift+arrow too, which PaneForge adds.
  //   - A drag does NOT redraw the renderer, and does not stretch it either ("don't stretch the
  //     renderer when the instructions pane is extended/contracted", the user, 2026-09-18): for
  //     as long as a handle is held the canvas keeps the size and picture it had and is centred
  //     in the renderer's region, which clips or reveals it as the pane's edge moves ("scoot",
  //     T-0188; `beginPaneScoot` in viewport.js). Redrawing at every step was a full render each,
  //     and the LuxCore-style renderer restarted its accumulation with each one. On release
  //     (`endPaneScoot`) the canvas is redrawn once at its final size. Both are silent no-ops
  //     before boot has finished and the canvas has been drawn.
  //
  // Independent of GemApp, like the rest of the shell, so the panes are resizable (and restore
  // their saved widths) even if the wasm module fails to load.
  import { onMount } from 'svelte';
  import * as Resizable from '$lib/components/ui/resizable/index.js';
  import InstructionsPane from './InstructionsPane.svelte';
  import TiltPerformancePanel from './TiltPerformancePanel.svelte';
  import Viewport from './Viewport.svelte';
  import SubBar from './SubBar.svelte';
  import { editing } from '../lib/edit_mode.js';
  import { fullscreen } from '../lib/fullscreen.js';
  import { tiltPerformance } from '../lib/tilt_performance_mode.js';
  import { beginPaneScoot, endPaneScoot } from '../lib/viewport.js';
  import {
    readSetting, writeSetting, INSTRUCTIONS_WIDTH_SETTING, INSTRUCTIONS_WIDTH_MIN,
    INSTRUCTIONS_WIDTH_MAX, SETTINGS_WIDTH_SETTING, SETTINGS_WIDTH_MIN, SETTINGS_WIDTH_MAX,
  } from '../lib/settings.js';

  // `onopengear` opens the gear dialog (App owns it); the sub bar above the renderer calls it.
  // `right` is the right-hand column's content (App's #panel-stack).
  let { onopengear, right } = $props();

  const KEY_STEP_PX = 16;
  // The least the renderer is left with when the window is too narrow for both side panes.
  const RENDERER_MIN_PX = 160;

  // The two side panes, each described once so the code below treats them alike.
  const LEFT = {
    setting: INSTRUCTIONS_WIDTH_SETTING, min: INSTRUCTIONS_WIDTH_MIN, max: INSTRUCTIONS_WIDTH_MAX,
    fallback: 280,
  };
  const RIGHT = {
    setting: SETTINGS_WIDTH_SETTING, min: SETTINGS_WIDTH_MIN, max: SETTINGS_WIDTH_MAX,
    fallback: 300,
  };

  function clamp(side, px) {
    return Math.max(side.min, Math.min(side.max, px));
  }

  function savedWidth(side) {
    const saved = Number(readSetting(side.setting));

    return Number.isFinite(saved) && saved > 0 ? clamp(side, saved) : side.fallback;
  }

  // The panes' widths in pixels: the one source of truth. Set from a drag or a key press, and
  // applied to the panes whenever they or the group's width change.
  let leftPx = $state(savedWidth(LEFT));
  let rightPx = $state(savedWidth(RIGHT));
  // The group's width, in pixels (measured; 0 until it is).
  let groupPx = $state(0);
  let leftPane;
  let rightPane;
  let groupElement = $state(null);
  let leftElement = $state(null);
  let rightElement = $state(null);

  // True while this file is the one resizing a pane, so PaneForge's report of that resize is
  // not mistaken for the user dragging.
  let applying = false;

  // True while the user is dragging a handle or holding a key on one. PaneForge also reports a
  // resize when the WINDOW changes size (it re-checks the layout against the panes' limits, which
  // are percentages that change with the group), and that report carries the old percentage: taken
  // as the user's, a pane would come out at the old percentage of the new width instead of
  // keeping its pixels.
  let interacting = false;

  // What PaneForge is given before the group has been measured: a guess from the window's
  // width (the group is the whole row), so the first frame is already near right.
  let guessPx = $derived(groupPx || Math.max(window.innerWidth, 1));

  // The side panes' widths as laid out, in pixels. The instructions pane is 0 while fullscreen
  // hides it (see the markup), so the settings pane keeps its own width then rather than
  // growing with the renderer. Both shrink in proportion when the window cannot fit them.
  let fitted = $derived.by(() => {
    let left = $fullscreen ? 0 : clamp(LEFT, leftPx);
    let right = clamp(RIGHT, rightPx);
    const room = Math.max(guessPx - RENDERER_MIN_PX, 0);

    if (left + right > room) {
      const scale = room / (left + right);

      left *= scale;
      right *= scale;
    }

    return { left, right };
  });

  const percentOf = px => (px / guessPx) * 100;

  // Each pane's limits, as percentages. A limit never excludes the width the pane is fitted to
  // above, or PaneForge would push the pane back out to it.
  let leftMin = $derived(percentOf(Math.min(LEFT.min, fitted.left)));
  let leftMax = $derived(percentOf(Math.max(LEFT.max, fitted.left)));
  let rightMin = $derived(percentOf(Math.min(RIGHT.min, fitted.right)));
  let rightMax = $derived(percentOf(Math.max(RIGHT.max, fitted.right)));
  let rendererMin = $derived(percentOf(Math.min(RENDERER_MIN_PX,
    guessPx - fitted.left - fitted.right)));

  // Keeps the side panes at their widths as the group's width changes under them.
  $effect(() => {
    const left = percentOf(fitted.left);
    const right = percentOf(fitted.right);

    if (!leftPane || !rightPane || groupPx === 0) {
      return;
    }

    applying = true;

    if (Math.abs(leftPane.getSize() - left) > 0.001) {
      leftPane.resize(left);
    }

    if (Math.abs(rightPane.getSize() - right) > 0.001) {
      rightPane.resize(right);
    }

    applying = false;
  });

  onMount(() => {
    const observer = new ResizeObserver(entries => {
      groupPx = entries[0].contentRect.width;
    });

    observer.observe(groupElement);
    groupPx = groupElement.getBoundingClientRect().width;

    return () => observer.disconnect();
  });

  // The user resized a side pane (a drag, or a key on its handle). No redraw here: the canvas is
  // scooting (see the header), and is redrawn on release.
  function onResize(size, setPx) {
    if (applying || !interacting || groupPx === 0) {
      return;
    }

    setPx((size / 100) * groupPx);
  }

  // Written once per drag, on release, rather than on every pointermove -- a storage write for
  // every pixel of a drag is wasted work the user never asked for -- and once per key press.
  //
  // The panes' measured widths are also what the pixel widths are set to here, so however
  // PaneForge got them there (a key press is handled before this file hears of it), the pixels
  // kept are the panes'. Not the instructions pane's while fullscreen hides it: its 0 is not a
  // width the user chose.
  function persist() {
    if (!$fullscreen) {
      leftPx = leftElement.getBoundingClientRect().width;
      writeSetting(LEFT.setting, String(Math.round(leftPx)));
    }

    rightPx = rightElement.getBoundingClientRect().width;
    writeSetting(RIGHT.setting, String(Math.round(rightPx)));
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

  // The keys PaneForge resizes a pane with on the focused handle. Any other key (Tab) leaves
  // the renderer alone.
  const RESIZE_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

  function onkeydown(event) {
    interacting = true;

    if (RESIZE_KEYS.includes(event.key)) {
      beginPaneScoot();
    }
  }

  // The release of a key, or the handle losing focus with one held (its keyup then goes
  // elsewhere): the resize is over, so the widths are kept and the renderer redrawn once.
  function onkeyup() {
    interacting = false;
    persist();
    endPaneScoot();
  }

  // Both handles look the same. The seam is the handle (T-0226): an 8px hit area (`after:`)
  // centred on the pane's hairline border, and a 2px line (`before:`) over that border which
  // turns the accent colour on hover -- after a short delay, so a pointer merely crossing the
  // seam does not flash it -- and straight away while dragged. `z-20` keeps the hit area above
  // the canvas it overlaps by 4px.
  const HANDLE = 'z-20 w-0 cursor-col-resize bg-transparent after:w-2 before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-primary hover:before:delay-150 data-[active]:before:bg-primary data-[active]:before:delay-0';
</script>

<Resizable.PaneGroup direction="horizontal" bind:ref={groupElement}
  keyboardResizeBy={groupPx > 0 ? (KEY_STEP_PX / groupPx) * 100 : null}
  class="min-w-0 flex-1">
  <!-- The instructions pane and its handle are HIDDEN while the settings panel's fullscreen
       toggle is on (2026-09-20), never removed, and the pane is sized to 0 (`fitted`, above) so the
       renderer takes its room while the settings pane keeps its own width. PaneForge keeps the
       pane mounted, and `leftPx` keeps the width it was dragged to for when fullscreen ends. See
       fullscreen.js. On the handle, `hidden` also displaces the `flex` in its own base classes,
       which `cn`'s tailwind-merge resolves for us. -->
  <Resizable.Pane bind:this={leftPane} bind:ref={leftElement} defaultSize={percentOf(fitted.left)}
    minSize={leftMin} maxSize={leftMax} onResize={size => onResize(size, px => { leftPx = px; })}
    class={$fullscreen ? 'hidden' : ''}>
    <!-- Tools > Tilt performance's panel (T-0261) takes this pane while it is open (the user,
         2026-09-25: "the faceting instructions on the left side of the screen should have tilt
         performance mode"), stacked over the cutting instructions the way App's #panel-stack
         stacks the right-hand column's layers: both stay mounted, the one not in use
         `visibility: hidden`, so the instructions keep their scroll and folds. -->
    <div id="left-stack">
      <div class="panel-layer" class:panel-layer-off={$tiltPerformance.open}><InstructionsPane /></div>
      <div class="panel-layer" class:panel-layer-off={!$tiltPerformance.open}><TiltPerformancePanel /></div>
    </div>
  </Resizable.Pane>

  <Resizable.Handle id="instructions-resize" aria-label="Resize the cutting instructions pane"
    aria-orientation="vertical" {onDraggingChange} {onkeydown} {onkeyup} onblur={onkeyup}
    class="{HANDLE} {$fullscreen ? 'hidden' : ''}" />

  <Resizable.Pane minSize={rendererMin}>
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
      <div class="min-h-0 flex-1">
        <Viewport />
      </div>
    </div>
  </Resizable.Pane>

  <!-- The right-hand column's handle (2026-09-22). Not hidden by fullscreen: the render settings
       stay on screen there, so their width can still be changed. -->
  <Resizable.Handle id="settings-resize" aria-label="Resize the settings pane"
    aria-orientation="vertical" {onDraggingChange} {onkeydown} {onkeyup} onblur={onkeyup}
    class={HANDLE} />

  <Resizable.Pane bind:this={rightPane} bind:ref={rightElement} defaultSize={percentOf(fitted.right)}
    minSize={rightMin} maxSize={rightMax} onResize={size => onResize(size, px => { rightPx = px; })}>
    {@render right()}
  </Resizable.Pane>
</Resizable.PaneGroup>
