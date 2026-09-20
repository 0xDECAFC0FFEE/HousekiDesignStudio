<script>
  // Shows a setting's explanation, its `data-tip` attribute, after the pointer has rested
  // anywhere on the setting for TOOLTIP_DELAY_MS, next to the pointer and following it. In place
  // of the paragraphs of hint text the panel used to show (the page's old `setUpTooltips`).
  //
  // Delegated from the document, so a tip set or changed later (the renderer picker's follows
  // the selected renderer) needs no wiring of its own. The attribute is read when the tip
  // appears, not when the timer starts, so it is always current. Moving between the parts of
  // one setting neither restarts the delay nor hides the tip. Not the browser's `title`, whose
  // delay the page cannot set, which differs between browsers and which cannot follow the
  // pointer.
  //
  // What is drawn is shadcn-svelte's Tooltip (Bits UI's floating layer: portalled, positioned
  // and kept inside the window by Floating UI), but not the way it is normally used. Its
  // Trigger wraps ONE element and shows that element's own tip beside it; this page has one tip
  // per `data-tip` in markup it does not own (the menu, the sliders, Bits UI's own controls) and
  // wants it beside the POINTER, so no Trigger is used: the tooltip is opened and closed from
  // here (a controlled `open`), and anchored to a virtual element at the pointer (`customAnchor`),
  // which is replaced at every pointer move so the tip follows it.
  import { onMount } from 'svelte';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';

  /** How long the pointer must rest on a setting before its explanation appears. */
  const TOOLTIP_DELAY_MS = 500;

  /** Offset of the tooltip's corner from the pointer, so the cursor does not cover the text. */
  const TOOLTIP_CURSOR_OFFSET_PX = 14;

  let open = $state(false);
  let text = $state('');
  // A zero-size box at the pointer, in the shape Floating UI takes as a virtual anchor.
  let anchor = $state.raw(pointAt(0, 0));

  let target = null;
  let timer = null;
  let pointerX = 0;
  let pointerY = 0;

  function pointAt(x, y) {
    return { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) };
  }

  /**
   * The setting whose explanation applies at `element`: the OUTERMOST ancestor carrying a
   * `data-tip`.
   *
   * Outermost, so every part of a setting -- its title, its slider, its readout, its color
   * swatch -- shows the setting's own explanation, not a fragment's.
   */
  function tooltipSettingAt(element) {
    let setting = null;

    for (let node = element; node && node !== document; node = node.parentElement) {
      if (node.dataset && node.dataset.tip) {
        setting = node;
      }
    }

    return setting;
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    target = null;
    open = false;
  }

  function show() {
    const tip = target && target.dataset.tip;

    if (!tip) {
      return;
    }

    text = tip;
    anchor = pointAt(pointerX, pointerY);
    open = true;
  }

  function onmousemove(event) {
    pointerX = event.clientX;
    pointerY = event.clientY;

    // No tip while a button is held: dragging a slider would otherwise bring one back under
    // the pointer half a second into the drag.
    if (event.buttons !== 0) {
      hide();
      return;
    }

    const next = tooltipSettingAt(event.target);

    if (next !== target) {
      hide();

      if (next) {
        target = next;
        timer = setTimeout(show, TOOLTIP_DELAY_MS);
      }

      return;
    }

    if (open) {
      anchor = pointAt(pointerX, pointerY);
    }
  }

  onMount(() => {
    // Leaving the window altogether sends no mousemove over another element.
    document.documentElement.addEventListener('mouseleave', hide);

    // Scrolling the panel out from under the tip dismisses it. `scroll` does not bubble, so it
    // is the panel's own element that is listened to.
    const panel = document.getElementById('panel');

    panel.addEventListener('scroll', hide);

    return () => {
      document.documentElement.removeEventListener('mouseleave', hide);
      panel.removeEventListener('scroll', hide);
    };
  });
</script>

<!-- Using a control dismisses the tip too. -->
<svelte:document {onmousemove} onpointerdown={hide} onkeydown={hide} />

<Tooltip.Provider>
  <!-- Controlled, and never closed from inside: this file decides when a tip is shown. -->
  <Tooltip.Root bind:open={() => open, () => {}} disableHoverableContent>
    <Tooltip.Content id="tooltip" customAnchor={anchor} side="bottom" align="start"
      sideOffset={TOOLTIP_CURSOR_OFFSET_PX} alignOffset={TOOLTIP_CURSOR_OFFSET_PX} collisionPadding={8}
      arrowClasses="hidden"
      class="pointer-events-none block max-w-[280px] rounded-md border border-border bg-popover px-2.5 py-2 text-[11px] leading-[1.45] text-popover-foreground shadow-lg">
      {text}
    </Tooltip.Content>
  </Tooltip.Root>
</Tooltip.Provider>
