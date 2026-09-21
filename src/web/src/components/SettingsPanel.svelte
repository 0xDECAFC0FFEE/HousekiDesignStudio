<script>
  // The right-hand settings column (`#panel`): Material, Tracing, Lighting and View, and the
  // error box. The controls read their values from GemApp, so they are drawn once it exists
  // (`ready`); until then, or if wasm fails to load, the panel holds only the error box.
  //
  // The ids on the rows below are what GemApp::hidden_controls names: each row hides under a
  // renderer that reads none of what it sets (the flat renderer) -- see syncHiddenControls in
  // session.js. Every control's tooltip is its `data-tip`, shown by the Tooltip component.
  //
  // The controls are shadcn-svelte's (Bits UI): Select for the material and renderer pickers,
  // Slider (via Slider.svelte), Switch for the on/off settings, Button, and Collapsible for the
  // groups. The lighting model is deliberately a NativeSelect, a real <select>: the tools that
  // drive the page set `#lightingModel`'s `value` and send it a `change` event, which needs a
  // <select> (kb/svelte-port-of-the-web-front-end.md). Bits UI's Select is not one.
  import { get } from 'svelte/store';
  import {
    engine, ready, error, renderer, lightingModel, materialPreset, luxProgress, accumulationTarget,
    resolutionScale, draftResolutionScale,
  } from '../lib/stores.js';
  import {
    RENDERER_HINTS, SLIDER_SPECS, HIDDEN_LIGHTING_MODELS, ANALYTICAL_LIGHTING_MODELS, snapToSpec,
  } from '../lib/panel_config.js';
  import { writeSetting } from '../lib/settings.js';
  import {
    changeMaterial, neutraliseMaterial, selectRenderer, selectLightingModel, syncHiddenControls,
    stoneColorOpened, stoneColorClosed, loadModelFile, LUX_TARGET_SETTING, RESOLUTION_SETTING,
    DRAFT_RESOLUTION_SETTING, USE_BACKGROUND_SETTING, BACKGROUND_COLOR_SETTING,
    USE_WINDOW_COLOR_SETTING, WINDOW_COLOR_SETTING, HEAD_SHADOW_COLOR_SETTING, WIREFRAME_SETTING,
  } from '../lib/session.js';
  import { writeSettingColor } from '../lib/settings.js';
  import { requestRender, syncLuxProgress } from '../lib/viewport.js';
  import { fullscreen, toggleFullscreen } from '../lib/fullscreen.js';
  import { listen, listeners } from '../lib/native.js';
  import ParamSlider from './ParamSlider.svelte';
  import Slider from './Slider.svelte';
  import ColorSetting from './ColorSetting.svelte';
  import PanelSection from './PanelSection.svelte';
  import SettingSwitch from './SettingSwitch.svelte';
  import * as Select from '$lib/components/ui/select/index.js';
  import * as NativeSelect from '$lib/components/ui/native-select/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import MaximizeIcon from '@lucide/svelte/icons/maximize';
  import MinimizeIcon from '@lucide/svelte/icons/minimize';

  // The two pickers with a checkbox re-send the color Rust already holds when it is toggled, and
  // then ask their swatch to catch up.
  let backgroundPicker;
  let windowPicker;

  // Once the controls exist: hide whatever the selected renderer ignores (T-0126), and show how
  // far the LuxCore accumulation has got (or clear it).
  $effect(() => {
    if ($ready) {
      syncHiddenControls();
      syncLuxProgress();
    }
  });

  // A select's closed face, which carries the setting's look for the two Bits UI selects.
  const SELECT_TRIGGER = 'h-7 w-full rounded-md px-2 py-0 text-xs';
</script>

<div id="panel">
  <!-- Fullscreen (2026-09-20, the user: "add a fullscreen toggle button in the render settings.
       clicking it hides everything else on the screen except the render settings. clicking on it
       again brings you back"): the stone and this panel alone, with the top bar and the
       cutting-instructions pane hidden. See fullscreen.js for what is hidden and why it is
       hidden rather than unmounted.

       OUTSIDE the `{#if $ready}` below, unlike every other control here: it needs no GemApp, no
       stone and no wasm, so it still works on a page whose module failed to load -- where all
       this panel holds is the error box, and a bigger view of the renderer is no use but the
       button should not be a dead control either. `aria-pressed` rather than a Toggle, because
       the label says which way it will go and the state is the whole page around it. -->
  <Button variant="outline" size="sm" id="panel-fullscreen"
    class="mb-3 h-7 w-full justify-center gap-1.5 text-xs font-normal"
    aria-pressed={$fullscreen} onclick={toggleFullscreen}
    data-tip="Shows the stone and these settings alone, hiding the menu bar, the cutting instructions, the rotation sliders and the stone's proportions. Click it again, or press Escape, to bring them back.">
    {#if $fullscreen}
      <MinimizeIcon class="size-3.5" aria-hidden="true" />Exit fullscreen
    {:else}
      <MaximizeIcon class="size-3.5" aria-hidden="true" />Fullscreen
    {/if}
  </Button>

  {#if $ready}
    {@render controls()}
  {/if}
  <!-- Persistent or minor conditions only (see the `error` store's comment). A one-off failure of
       something the user just asked for -- a file or a link that could not be read -- goes to
       LoadAlertDialog instead, not here. `role="alert"` so a screen reader announces a message
       that appears without the reader having moved focus. -->
  <pre id="error" role="alert"
    style:display={$error.visible === null ? undefined : $error.visible ? 'block' : 'none'}>{$error.text}</pre>
</div>

{#snippet controls()}
  {@const app = engine.app}
  {@const materialNames = app.material_names().split('\n')}
  {@const rendererNames = app.renderer_names().split('\n')}
  {@const lightingNames = app.lighting_model_names().split('\n')}

  <PanelSection title="Material">
    <!-- Controlled by `materialPreset`: a preset Rust refuses never reaches the store, so the
         dropdown keeps showing the one in use. -->
    <Select.Root type="single" bind:value={() => $materialPreset, name => changeMaterial(name)}>
      <Select.Trigger id="material" class={SELECT_TRIGGER}>{$materialPreset}</Select.Trigger>
      <Select.Content class="max-h-72">
        {#each materialNames as name}<Select.Item value={name} label={name} class="py-1 text-xs" />{/each}
      </Select.Content>
    </Select.Root>

    <ParamSlider name="refractiveIndex" rowId="refractiveIndex-row" rowStyle="margin-top:10px"
      label="Refractive index"
      tip="How strongly the stone bends light. Higher values trap more light inside and give more brilliance. Choosing a material sets it." />

    <ParamSlider name="dispersion" rowId="dispersion-row" label="Dispersion (fire)"
      tip="How far the stone spreads light into rainbow colors, called fire. 0 means no fire, which also renders about three times faster. Choosing a material sets it." />

    <!-- The stone color, which is the absorption seen as the color it gives
         (`GemApp::stone_color`). Picking one replaces the preset's absorption. -->
    <ColorSetting id="stoneColor" label="Stone color" swatchLabel="Stone color"
      tip="The stone's body color: how much of each color of light survives passing through it. White is colorless; the further light travels inside, the deeper the color. Choosing a material sets it."
      read={() => app.stone_base_color()}
      write={rgb => {
        app.set_stone_base_color(...rgb);

        // A stone with no opacity (Neutralise leaves none) has no color to show, so a color
        // picked for it gives it its full opacity: the color picked is the color rendered, as
        // it was when picking replaced the whole absorption (`set_stone_color`).
        if (app.get_param('absorptionScale') === 0) {
          app.set_param('absorptionScale', 1);
        }

        requestRender();
      }}
      opacity={{
        read: () => app.get_param('absorptionScale'),
        write: value => { app.set_param('absorptionScale', value); requestRender(); },
        tip: 'How strongly the stone takes on its color. This is the absorption scale: it multiplies how much light the stone absorbs. 1 is the color above, fully; lower is paler, and 0 is a colorless stone whatever the color. It never makes the stone cloudy or see-through to what is behind it: light still refracts and reflects inside as before.',
      }}
      openSaturation={0.5}
      onOpen={stoneColorOpened} onClose={stoneColorClosed} />
  </PanelSection>

  <PanelSection title="Tracing">
    <!-- Its tooltip, from RENDERER_HINTS, follows the selected renderer. -->
    <Select.Root type="single"
      bind:value={() => String($renderer), value => selectRenderer(parseInt(value, 10))}>
      <Select.Trigger id="renderer" class={SELECT_TRIGGER} data-tip={RENDERER_HINTS[$renderer] || ''}>
        {rendererNames[$renderer] ?? ''}
      </Select.Trigger>
      <Select.Content>
        {#each rendererNames as name, index}
          <Select.Item value={String(index)} label={name} class="py-1 text-xs" />
        {/each}
      </Select.Content>
    </Select.Root>

    <div id="lux-row" style:display={$renderer === 1 ? '' : 'none'}>
      <!-- Samples to accumulate is when to stop asking for frames. It lives only in the page (the
           `accumulationTarget` store), because it is a property of the page's render loop and
           not of the renderer -- the wasm side will accumulate for as long as it is asked to. -->
      <Slider id="lux-target" label="Samples to accumulate"
        tip="How much detail the Monte Carlo picture gathers before it stops improving. Higher is smoother but takes longer."
        spec={SLIDER_SPECS['lux-target']} value={$accumulationTarget} text={`${$accumulationTarget} spp`}
        oninput={v => {
          accumulationTarget.set(v);
          writeSetting(LUX_TARGET_SETTING, String(v));
          // Raising the target must restart the loop, which stopped when the old one was met.
          requestRender();
        }}
        readoutRead={() => get(accumulationTarget)}
        readoutWrite={value => {
          accumulationTarget.set(snapToSpec(value, SLIDER_SPECS['lux-target']));
          writeSetting(LUX_TARGET_SETTING, String(get(accumulationTarget)));
          requestRender();
        }} />

      <!-- Samples per frame (luxSamples, a Rust parameter) is how much work ONE frame does. 1 by
           default: the smallest step that still converges is what keeps the view responsive,
           because the image improves across frames rather than inside one draw. -->
      <ParamSlider name="luxSamples" label="Samples per frame"
        tip="How much work each frame does. Higher sharpens the Monte Carlo picture in fewer frames, but each frame takes longer, so the page responds more slowly." />

      <div class="hint" id="lux-progress">{$luxProgress}</div>
    </div>

    <ParamSlider name="maxBounces" rowId="maxBounces-row" label="Max internal bounces"
      tip="How many times light may reflect inside the stone before the renderer stops following it. More is more accurate for deep stones, but slower. Light still inside when it runs out is shown as a darker tint of the stone color." />

    <!-- Resolution scale, full quality and while dragging. Only in the page: there is no Rust
         field behind either slider at all, so the slider is the store. Typed as a percentage, like
         the readout; a typed value is put where the slider can sit (snapToSpec: within its 15-100%
         range, and on its step). -->
    <Slider id="resolution" label="Resolution scale"
      tip="Renders at a fraction of the screen resolution when the view is still. Lower is faster but blurrier."
      spec={SLIDER_SPECS.resolution} value={$resolutionScale} text={`${Math.round($resolutionScale * 100)}%`}
      oninput={v => {
        resolutionScale.set(v);
        writeSetting(RESOLUTION_SETTING, String(v));
        requestRender();
      }}
      readoutRead={() => get(resolutionScale)} toDisplay={v => v * 100} fromDisplay={v => v / 100}
      readoutWrite={value => {
        resolutionScale.set(snapToSpec(value, SLIDER_SPECS.resolution));
        writeSetting(RESOLUTION_SETTING, String(get(resolutionScale)));
        requestRender();
      }} />

    <Slider id="draft-resolution" label="Resolution while dragging"
      tip="The resolution used while you turn or zoom the stone, so it keeps up with the mouse. Full quality returns as soon as you stop. Lower it if dragging is choppy."
      spec={SLIDER_SPECS['draft-resolution']} value={$draftResolutionScale}
      text={`${Math.round($draftResolutionScale * 100)}%`}
      oninput={v => {
        draftResolutionScale.set(v);
        writeSetting(DRAFT_RESOLUTION_SETTING, String(v));
        requestRender();
      }}
      readoutRead={() => get(draftResolutionScale)} toDisplay={v => v * 100} fromDisplay={v => v / 100}
      readoutWrite={value => {
        draftResolutionScale.set(snapToSpec(value, SLIDER_SPECS['draft-resolution']));
        writeSetting(DRAFT_RESOLUTION_SETTING, String(get(draftResolutionScale)));
        requestRender();
      }} />

    <!-- Hidden under the LuxCore renderer, which does not draw it: see hidden_controls. The
         facet wireframe is initialised from the Rust default (on) like the other switches. -->
    <div id="wireframe-row">
      <Label class="setting gap-2 text-xs font-normal"
        data-tip="Outlines each facet you can see. Edges hidden behind the stone are not drawn.">
        <SettingSwitch id="wireframe" checked={app.wireframe_enabled()}
          onchange={checked => {
            app.set_wireframe(checked);
            writeSetting(WIREFRAME_SETTING, String(checked));
            requestRender();
          }} />
        <span class="name">Facet wireframe</span>
      </Label>
    </div>
  </PanelSection>

  <PanelSection id="fieldset-lighting" title="Lighting">
    <!-- A dropdown rather than a slider: switching model regenerates and re-uploads the
         environment texture, which is far too expensive to run on every step of a drag. The
         studio rig is not offered, so while it is the model in use the dropdown shows no
         selection. A NativeSelect (a real <select>), for the reason at the top of this file. -->
    <NativeSelect.Root id="lightingModel" class="w-full" selectClass="h-7 py-0 text-xs" value={String($lightingModel)}
      data-tip="What lights the stone. Skybox image: a photographed room. Angle rings: colors light by how steeply it arrives (red from overhead, then cyan, yellow and magenta towards the horizon), to show which angles a cut uses. Isometric: even white light from everywhere above. Cosine: brightest overhead, fading towards the horizon."
      {@attach listeners({ change: event => selectLightingModel(event.currentTarget) })}>
      {#each lightingNames as name, index}
        {#if !HIDDEN_LIGHTING_MODELS.includes(String(index))}
          <NativeSelect.Option value={String(index)}>{name}</NativeSelect.Option>
        {/if}
      {/each}
    </NativeSelect.Root>
    <!-- The assessment models' colors only mean something on a neutral stone; the studio rig and
         the skybox are ordinary lighting. -->
    <div id="analytical-warning"
      style:display={ANALYTICAL_LIGHTING_MODELS.includes(String($lightingModel)) ? 'block' : 'none'}>
      <Button variant="outline" size="sm" class="mt-1.5 w-full text-xs font-normal" id="neutralise"
        onclick={neutraliseMaterial}
        data-tip="Analytical model. The stone's own color multiplies the lighting, so a reading is only meaningful on a colorless, non-dispersive stone. This zeroes the absorption and dispersion.">Neutralise material</Button>
    </div>

    <!-- Every picker reads its color from Rust, like the sliders, so the two cannot drift. The
         switches re-send the color Rust already holds rather than one kept here, so a script
         that sets a color through `gemApp` and then toggles a switch (tools/gcs_compare's
         gcs_views.py does) keeps its color, and the swatch catches up. -->
    <ColorSetting bind:this={backgroundPicker} id="backgroundColor" label="Flat background"
      swatchLabel="Background color"
      tip="Shows a plain color behind the stone instead of the lighting. It also colors light seen through the back of the stone, unless the separate window color is on."
      checkboxId="useBackground" checked={app.background_enabled()}
      oncheck={checked => {
        app.set_background(checked, ...app.background_color());
        writeSetting(USE_BACKGROUND_SETTING, String(checked));
        backgroundPicker.refresh();
        requestRender();
      }}
      read={() => app.background_color()}
      write={rgb => {
        app.set_background(document.getElementById('useBackground').checked, ...rgb);
        writeSettingColor(BACKGROUND_COLOR_SETTING, rgb);
        requestRender();
      }} />

    <ColorSetting id="headShadowColor" rowId="headShadowColor-row" label="Head shadow color"
      swatchLabel="Head shadow color"
      tip="The color of light blocked by your head, including the small dot at the centre of the table when the stone faces you. Black is realistic; a bright color shows which facets depend on that light."
      read={() => app.head_shadow_color()}
      write={rgb => {
        app.set_head_shadow_color(...rgb);
        writeSettingColor(HEAD_SHADOW_COLOR_SETTING, rgb);
        requestRender();
      }} />

    <ParamSlider name="headShadowHalfAngle" rowId="headShadowHalfAngle-row" rowStyle="margin-top:10px"
      label="Head shadow half-angle"
      tip="Your head blocks some of the light behind you. This sets how wide that shadow is, as half the angle of the cone it covers; 0 turns it off. Facets that rely on light from straight behind you go dark." />

    <ColorSetting bind:this={windowPicker} id="windowColor" rowId="windowColor-row"
      label="Separate window color" swatchLabel="Window color"
      tip="Colors light that comes through the back of the stone, called a window or leak, so leaks are easy to find. Off, that light shows the flat background, or the lighting."
      checkboxId="useWindowColor" checked={app.window_color_enabled()}
      oncheck={checked => {
        app.set_window_color(checked, ...app.window_color());
        writeSetting(USE_WINDOW_COLOR_SETTING, String(checked));
        windowPicker.refresh();
        requestRender();
      }}
      read={() => app.window_color()}
      write={rgb => {
        app.set_window_color(document.getElementById('useWindowColor').checked, ...rgb);
        writeSettingColor(WINDOW_COLOR_SETTING, rgb);
        requestRender();
      }} />
  </PanelSection>

  <!-- The lighting always follows the view (GCS's convention) and the optical axis is always the
       file's +Z; their controls were removed at the user's request, and the Rust defaults apply.
       So were the view-mode (debug) dropdown, which leaves the full render, and Reset view
       (2026-09-18); the debug views stay reachable from the console, `gemApp.set_debug_mode(n)`. The
       View sliders (spin and tilt) moved onto the renderer itself on 2026-09-19 (Viewport.svelte). -->

  <!-- The visible "Open .obj / .asc / .gem…" button moved to File > Open in the top bar
       (T-0140), at the user's request, so the open dialog no longer lives in this panel.
       This hidden input is still what it opens, and drag-and-drop still targets the same load
       path (loadModelFile). .gcs (Gem Cut Studio's own format, T-0148) added alongside the
       GemCad formats it already opened. -->
  <input type="file" id="obj-file" accept=".obj,.asc,.gem,.gcs" hidden
    use:listen={{
      change: event => {
        const file = event.currentTarget.files?.[0];

        if (file) {
          loadModelFile(file);
        }
      },
    }}>
{/snippet}
