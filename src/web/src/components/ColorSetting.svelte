<script>
  // A color setting: a row with the setting's name (and a checkbox, if it has one) and a swatch;
  // clicking the swatch opens the setting's hue, saturation and value sliders in a Popover
  // (shadcn-svelte, Bits UI) anchored to it, which closes the moment the user clicks anywhere
  // else, or presses Escape (focus then returns to the swatch). The page's one color control
  // (the old `makeHsvPicker`). HSV rather than HSL, because it is what
  // Gem Cut Studio's color sliders actually do, though it labels them HSL
  // (kb/window-and-head-shadow-colours.md), so a GCS color's three numbers can be typed straight
  // in. Not the browser's own `<input type=color>`: it cannot be made HSV, and (the user's
  // request, 2026-09-18) its click opens a whole separate OS color-*picker* dialog for choosing
  // an arbitrary RGB, which is not what an eyedropper is for -- the eyedropper button instead
  // calls the EyeDropper API, which lets the user sample one exact pixel from anywhere on their
  // screen, including other windows.
  //
  //   id, label, tip   the swatch's id (the editor is `<id>-editor`), the setting's name and its
  //                    tooltip (on the wrapper, and on every row of the editor, which is not
  //                    inside the wrapper: Bits UI portals it to <body>)
  //   swatchLabel      what the swatch and the eyedropper are called for a screen reader
  //   rowId            the wrapper's own id, where a setting has one (the renderer hides some)
  //   read()           the color now in use, `[r, g, b]` in 0..1, from Rust
  //   write(rgb)       applies a color the user picked
  //   opacity          if set, a fourth slider, O, under the hue, saturation and value:
  //                    `{ read(), write(o), tip }`, the value in 0..1. Only for a color the
  //                    renderer has an opacity-like parameter for (the stone color, whose O is
  //                    the absorption scale; see PanelSection). The swatch then shows the color
  //                    as it renders, `read()` raised to O (a transmittance), and `write` may
  //                    change O itself (a stone with no opacity has no color to see), so O is read
  //                    back after every color write
  //   openSaturation   if set, the saturation a color with none (a grey or white) is given
  //                    when the sliders open, so moving the hue shows at once
  //   onOpen()         called as the sliders open, before openSaturation changes anything
  //   onClose()        called once they close, however that happens
  //   checkboxId, checked, oncheck(checked)
  //                    for a setting with an on/off box of its own (in its own <label>, so
  //                    clicking the swatch does not toggle it)
  //
  // onOpen/onClose are for the stone color, whose change is recorded in the edit history once,
  // when its sliders close (the user's request, 2026-09-18), rather than on every slider step.
  // Every color's editor closes on a click away, since it became a Popover (before, only the
  // stone color's did, `closeOnClickAway`).
  //
  // The sliders hold the HSV state themselves rather than re-deriving it from `read()` on every
  // move, because a grey has no hue and black no saturation: dragging value to 0 and back must
  // not lose the hue. Each readout can be clicked to type a value, like every other slider's.
  // The eyedropper observes the same rule (see setFromRgb): a sampled grey or black pixel must
  // not discard the hue either, since sRGB has no notion of "no hue" to preserve on its own.
  //
  // Two things must not close the popover though Bits UI would treat them as outside the popover:
  // the end of a slider drag that was released outside it (`pressedInside`), and anything the
  // browser's EyeDropper does while it is picking (`picking`): its overlay is not part of the
  // page, so a click on it or a change of focus looks like one away from the popover.
  //
  // Exports `{ refresh, close }`: refresh for when the color changed some other way (a material
  // preset, Neutralise material, an undo), close to shut the sliders from outside. Both are also
  // registered with the picker registry (pickers.js), by `id`.
  import { onMount } from 'svelte';
  import { showError } from '../lib/stores.js';
  import { HSV_CHANNELS, rgbToHsv, hsvToRgb, cssColor, hexToRgb } from '../lib/color.js';
  import { registerPicker, closeAllPickers } from '../lib/pickers.js';
  import EditableReadout from './EditableReadout.svelte';
  import SettingSwitch from './SettingSwitch.svelte';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import { Slider } from '$lib/components/ui/slider/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';

  let {
    id, label, swatchLabel, tip, rowId = undefined, read, write, openSaturation = null,
    opacity = null, onOpen = null, onClose = null,
    checkboxId = undefined, checked = false, oncheck = undefined,
  } = $props();

  // How long after an eyedropper pick ends the popover still ignores outside interactions.
  const PICK_GRACE_MS = 400;

  let hsv = $state({ h: 0, s: 0, v: 0 });
  // O, in 0..1, while `opacity` is set.
  let opac = $state(1);
  let open = $state(false);
  // The sliders' panel (the Popover's content, in the document only while it is open).
  let editor = $state(null);
  // True from a press inside the editor until just after its release, wherever that is.
  let pressedInside = false;
  // True while the browser's EyeDropper is picking, and for a moment after.
  let picking = false;
  // Set by an Escape that closes the editor, the one way of closing it that returns the focus
  // to the swatch (a click away leaves it where the click put it).
  let escaped = false;

  // The API is Chromium-only as of this writing (no Firefox or Safari support). Hidden
  // entirely rather than shown broken, so there is nothing to click where it cannot work.
  const hasEyeDropper = typeof window.EyeDropper === 'function';

  // Shared by refresh() (from Rust) and the eyedropper's handler (from a sampled screen
  // pixel), so a grey or black picked either way keeps the hue and saturation already shown.
  function setFromRgb(rgb) {
    const next = rgbToHsv(rgb);

    if (next.v > 0) {
      if (next.s > 0) {
        hsv.h = next.h;
      }

      hsv.s = next.s;
    }

    hsv.v = next.v;
  }

  // The swatch, and each slider's track: it runs through the colors that slider would give, the
  // other two held.
  // With an O slider, the color as the stone renders it: the transmittance raised to O.
  let swatchColor = $derived(cssColor(hsvToRgb(hsv).map(channel => opacity ? channel ** opac : channel)));
  let tracks = $derived({
    h: `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360]
      .map(h => cssColor(hsvToRgb({ ...hsv, h }))).join(', ')})`,
    s: `linear-gradient(to right, ${cssColor(hsvToRgb({ ...hsv, s: 0 }))}, ${cssColor(hsvToRgb({ ...hsv, s: 1 }))})`,
    v: `linear-gradient(to right, ${cssColor(hsvToRgb({ ...hsv, v: 0 }))}, ${cssColor(hsvToRgb({ ...hsv, v: 1 }))})`,
    // From no color at all (white, a colorless stone) to the color the sliders above hold.
    o: `linear-gradient(to right, ${cssColor([1, 1, 1])}, ${cssColor(hsvToRgb(hsv))})`,
  });

  function apply() {
    write(hsvToRgb(hsv));

    // A color written to a stone with no opacity gives it some (see `opacity`).
    if (opacity) {
      opac = opacity.read();
    }
  }

  export function refresh() {
    setFromRgb(read());

    if (opacity) {
      opac = opacity.read();
    }
  }

  refresh();

  // The EyeDropper() constructor check above already hid the button when it does not exist,
  // so a click here always means it does.
  async function pickFromScreen() {
    let result;

    // The eyedropper's own overlay takes the pointer and the focus from the page, which Bits UI
    // reads as an interaction outside the popover and would close it under the pick. The flag
    // stays up a moment after the pick: the click that ends it can reach the page afterwards.
    picking = true;

    try {
      result = await new EyeDropper().open();
    } catch (error) {
      // The user cancelled (Escape, or clicked away): EyeDropper rejects with AbortError. That
      // is a normal outcome, not a failure worth an error box -- only a genuine one is. The
      // popover stays open, as it was, for another try or another way of choosing.
      if (error && error.name !== 'AbortError') {
        showError(`Could not read a color from the screen:\n${error}`);
      }
      return;
    } finally {
      setTimeout(() => { picking = false; }, PICK_GRACE_MS);
    }

    setFromRgb(hexToRgb(result.sRGBHex));
    apply();
  }

  export function close() {
    if (!open) {
      return;
    }

    // A readout being typed into applies its value on blur. Blurred first, so that value lands
    // before onClose sees the color, rather than after it.
    if (editor?.contains(document.activeElement)) {
      document.activeElement.blur();
    }

    open = false;

    if (onClose) {
      onClose();
    }
  }

  function openEditor() {
    closeAllPickers();

    if (onOpen) {
      onOpen();
    }

    open = true;

    // Applied, not just shown: the color changes to what the sliders now say.
    if (openSaturation !== null && hsv.s === 0) {
      hsv.s = openSaturation;
      apply();
    }
  }

  // The popover asks to open or close (a click on the swatch, a click away, Escape); the
  // registry closes the others first, and onOpen/onClose run, as `openEditor` and `close` do.
  function setOpen(next) {
    if (next) {
      openEditor();
    } else {
      close();
    }
  }

  // A click away closes the popover, but not the end of a drag that started inside it, and not
  // while the eyedropper is picking.
  function onInteractOutside(event) {
    if (pressedInside || picking) {
      event.preventDefault();
    }
  }

  // Escape closes the popover and returns the focus to the swatch, except while the eyedropper
  // is picking (that Escape cancels the pick). An Escape that cancels the typing in a readout
  // never gets here: EditableReadout stops it.
  function onEscapeKeydown(event) {
    if (picking) {
      event.preventDefault();
    } else {
      escaped = true;
    }
  }

  // Bits UI would put the focus back on the swatch whenever the popover closes, including when
  // the app closes it (another slider is being dragged, an undo). Only Escape wants that.
  function onCloseAutoFocus(event) {
    if (!escaped) {
      event.preventDefault();
    }

    escaped = false;
  }

  onMount(() => {
    const unregister = registerPicker(id, { refresh, close });

    // Presses are noted in the capture phase, before anything can stop them, and released a
    // task after the pointer is up, which is after the click a drag ending elsewhere becomes.
    const onPress = event => {
      pressedInside = !!editor?.contains(event.target);
    };
    const onRelease = () => setTimeout(() => { pressedInside = false; }, 0);

    document.addEventListener('pointerdown', onPress, true);
    document.addEventListener('pointerup', onRelease, true);
    document.addEventListener('pointercancel', onRelease, true);

    return () => {
      unregister();
      document.removeEventListener('pointerdown', onPress, true);
      document.removeEventListener('pointerup', onRelease, true);
      document.removeEventListener('pointercancel', onRelease, true);
    };
  });
</script>


<!-- A Popover (Bits UI): the swatch is its trigger and the hue, saturation and value sliders (and
     the eyedropper, and O for a color that has it) its content. Controlled, because opening does
     more than show the sliders (the other pickers close, onOpen and openSaturation run:
     `setOpen`). -->
<div id={rowId} data-tip={tip}>
  <Popover.Root bind:open={() => open, setOpen}>
    <div class="color-row">
      {#if checkboxId}
        <Label class="flex-1 gap-2 text-xs font-normal">
          <SettingSwitch id={checkboxId} {checked} onchange={oncheck} />
          <span class="name">{label}</span>
        </Label>
      {:else}
        <span class="name">{label}</span>
      {/if}
      <Popover.Trigger class="swatch" id={id} aria-label={swatchLabel}
        style="background: {swatchColor}" />
    </div>
    <Popover.Content id="{id}-editor" bind:ref={editor} align="end" class="w-64 p-3"
      {onInteractOutside} {onEscapeKeydown} {onCloseAutoFocus}>
      <div class="hsv-editor">
        <div class="eyedropper-row" data-tip={tip}>
          <Button variant="outline" size="sm" class="eyedropper w-full text-xs font-normal" id="{id}-eyedropper"
            aria-label="Pick the {swatchLabel.toLowerCase()} from anywhere on screen"
            style={hasEyeDropper ? undefined : 'display:none'} onclick={pickFromScreen}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="3" cy="3" r="2" fill="currentColor"/>
              <rect x="6.5" y="3" width="2" height="9" rx="1" transform="rotate(45 7.5 7.5)" fill="currentColor"/>
              <circle cx="13" cy="13" r="1.4" fill="currentColor"/>
            </svg>
            <span>Pick from screen</span>
          </Button>
        </div>
        {#each HSV_CHANNELS as channel (channel.key)}
          <div class="setting" data-tip={tip}>
            <div class="row"><span class="name">{channel.name}</span><EditableReadout
              text={channel.format(hsv[channel.key])} read={() => hsv[channel.key]}
              write={value => {
                // A typed hue wraps round the circle; saturation and value clamp to their range.
                hsv[channel.key] = channel.key === 'h'
                  ? ((value % 360) + 360) % 360
                  : Math.min(Math.max(value, 0), 1);
                apply();
              }} /></div>
            <!-- The track is the gradient of the colors this slider would give (`tracks`), so the
                 filled part of a normal slider is left out. -->
            <Slider type="single" class="hsv-slider py-1" min={0} max={channel.max} step={channel.step}
              value={hsv[channel.key]} thumbLabel={channel.name} hideRange
              thumbClass="h-4 w-2 rounded-[3px] border-2 border-background bg-foreground"
              trackStyle="background: {tracks[channel.key]}; height: 10px; border: 1px solid var(--panel-edge)"
              onValueChange={v => {
                // Only a move of the thumb: Bits UI also reports a value it rounded onto a step
                // (see Slider.svelte), which here would apply the color, and so write it to
                // Rust and to storage, the moment the panel appears.
                if (Math.abs(v - hsv[channel.key]) >= channel.step / 2 - 1e-9) {
                  hsv[channel.key] = v;
                  apply();
                }
              }} />
          </div>
        {/each}
        {#if opacity}
          <!-- Its own tooltip: what the slider controls, exactly. -->
          <div class="setting" id="{id}-opacity-row" data-tip={opacity.tip}>
            <div class="row"><span class="name">Opacity</span><EditableReadout id="{id}-opacity-value"
              text={opac.toFixed(3)} read={() => opac}
              write={value => {
                opac = Math.min(Math.max(value, 0), 1);
                opacity.write(opac);
              }} /></div>
            <Slider type="single" id="{id}-opacity" class="hsv-slider py-1" min={0} max={1} step={0.001}
              value={opac} thumbLabel="Opacity" hideRange
              thumbClass="h-4 w-2 rounded-[3px] border-2 border-background bg-foreground"
              trackStyle="background: {tracks.o}; height: 10px; border: 1px solid var(--panel-edge)"
              onValueChange={v => {
                // As above: only a move of at least half a step is the user's.
                if (Math.abs(v - opac) >= 0.0005 - 1e-9) {
                  opac = v;
                  opacity.write(v);
                }
              }} />
          </div>
        {/if}
      </div>
    </Popover.Content>
  </Popover.Root>
</div>
