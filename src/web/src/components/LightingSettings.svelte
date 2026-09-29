<script>
  // The Lighting section's controls: the lighting model, Neutralise material under an analytical
  // model, the flat background, the head shadow's colour and half-angle, and the separate window
  // colour. Drawn by the render settings (SettingsPanel.svelte) and, since T-0273, by the manual
  // optimizer's panel too (the user, 2026-09-28: "we also need to copy in the lighting settings
  // from the rendering panel"), so the two are the same controls rather than two copies to keep
  // in step.
  //
  // Both drive the same settings -- the renderer has one set -- so a change made in either shows
  // in the other. Each control reads its value from GemApp, and re-reads it whenever
  // `paramRevision` is bumped (a mode closing, an undo), which is what brings one copy up to date
  // after the other was used.
  //
  //   idPrefix  put before every element id. The render settings' copy has none: its ids are the
  //             ones the tools that drive the page and GemApp::hidden_controls name
  //             (`#lightingModel`, `#useBackground`, `#headShadowColor-row`, ...). Any other copy
  //             has one, so no id is on the page twice.
  import { engine, lightingModel, paramRevision } from '../lib/stores.js';
  import { HIDDEN_LIGHTING_MODELS, ANALYTICAL_LIGHTING_MODELS } from '../lib/panel_config.js';
  import { writeSetting, writeSettingColor } from '../lib/settings.js';
  import {
    neutraliseMaterial, selectLightingModel, USE_BACKGROUND_SETTING, BACKGROUND_COLOR_SETTING,
    USE_WINDOW_COLOR_SETTING, WINDOW_COLOR_SETTING, HEAD_SHADOW_COLOR_SETTING,
  } from '../lib/session.js';
  import { requestRender } from '../lib/viewport.js';
  import { listeners } from '../lib/native.js';
  import ParamSlider from './ParamSlider.svelte';
  import ColorSetting from './ColorSetting.svelte';
  import * as NativeSelect from '$lib/components/ui/native-select/index.js';
  import { Button } from '$lib/components/ui/button/index.js';

  let { idPrefix = '' } = $props();

  const app = engine.app;
  const lightingNames = app.lighting_model_names().split('\n');
  const id = name => `${idPrefix}${name}`;

  // The two pickers with a switch re-send the colour Rust already holds when it is toggled, and
  // then ask their swatch to catch up.
  let backgroundPicker = $state(null);
  let headShadowPicker = $state(null);
  let windowPicker = $state(null);

  // Whether each switch is on, read from Rust: at first, and again whenever the settings may have
  // been changed from the other copy of these controls.
  const backgroundOn = $derived(($paramRevision, app.background_enabled()));
  const windowOn = $derived(($paramRevision, app.window_color_enabled()));

  // The swatches follow the same way.
  $effect(() => {
    void $paramRevision;

    backgroundPicker?.refresh();
    headShadowPicker?.refresh();
    windowPicker?.refresh();
  });
</script>

<!-- A dropdown rather than a slider: switching model regenerates and re-uploads the environment
     texture, which is far too expensive to run on every step of a drag. The studio rig is not
     offered, so while it is the model in use the dropdown shows no selection. A NativeSelect (a
     real <select>), for the reason at the top of SettingsPanel.svelte. -->
<NativeSelect.Root id={id('lightingModel')} class="w-full"
  selectClass="h-7 py-0 text-xs hover:border-[var(--accent)] dark:hover:border-[var(--accent)]"
  value={String($lightingModel)}
  data-tip="What lights the stone. Skybox image: a photographed room. Angle rings: colors light by how steeply it arrives (red from overhead, then cyan, yellow and magenta towards the horizon), to show which angles a cut uses. Isometric: even white light from everywhere above. Cosine: brightest overhead, fading towards the horizon."
  {@attach listeners({ change: event => selectLightingModel(event.currentTarget) })}>
  {#each lightingNames as name, index}
    {#if !HIDDEN_LIGHTING_MODELS.includes(String(index))}
      <NativeSelect.Option value={String(index)}>{name}</NativeSelect.Option>
    {/if}
  {/each}
</NativeSelect.Root>
<!-- The assessment models' colors only mean something on a neutral stone; the studio rig and the
     skybox are ordinary lighting. -->
<div id={id('analytical-warning')}
  style:display={ANALYTICAL_LIGHTING_MODELS.includes(String($lightingModel)) ? 'block' : 'none'}>
  <Button variant="outline" size="sm" class="mt-1.5 w-full text-xs font-normal" id={id('neutralise')}
    onclick={neutraliseMaterial}
    data-tip="Analytical model. The stone's own color multiplies the lighting, so a reading is only meaningful on a colorless, non-dispersive stone. This zeroes the absorption and dispersion.">Neutralise material</Button>
</div>

<!-- Every picker reads its color from Rust, like the sliders, so the two cannot drift. The
     switches re-send the color Rust already holds rather than one kept here, so a script that
     sets a color through `gemApp` and then toggles a switch (tools/gcs_compare's gcs_views.py
     does) keeps its color, and the swatch catches up. -->
<ColorSetting bind:this={backgroundPicker} id={id('backgroundColor')} label="Flat background"
  swatchLabel="Background color"
  tip="Shows a plain color behind the stone instead of the lighting. It also colors light seen through the back of the stone, unless the separate window color is on."
  checkboxId={id('useBackground')} checked={backgroundOn}
  oncheck={checked => {
    app.set_background(checked, ...app.background_color());
    writeSetting(USE_BACKGROUND_SETTING, String(checked));
    backgroundPicker.refresh();
    requestRender();
  }}
  read={() => app.background_color()}
  write={rgb => {
    app.set_background(app.background_enabled(), ...rgb);
    writeSettingColor(BACKGROUND_COLOR_SETTING, rgb);
    requestRender();
  }} />

<ColorSetting bind:this={headShadowPicker} id={id('headShadowColor')} rowId={id('headShadowColor-row')}
  label="Head shadow color" swatchLabel="Head shadow color"
  tip="The color of light blocked by your head, including the small dot at the centre of the table when the stone faces you. Black is realistic; a bright color shows which facets depend on that light."
  read={() => app.head_shadow_color()}
  write={rgb => {
    app.set_head_shadow_color(...rgb);
    writeSettingColor(HEAD_SHADOW_COLOR_SETTING, rgb);
    requestRender();
  }} />

<ParamSlider name="headShadowHalfAngle" id={id('headShadowHalfAngle')}
  rowId={id('headShadowHalfAngle-row')} rowStyle="margin-top:10px"
  label="Head shadow half-angle"
  tip="Your head blocks some of the light behind you. This sets how wide that shadow is, as half the angle of the cone it covers; 0 turns it off. Facets that rely on light from straight behind you go dark." />

<ColorSetting bind:this={windowPicker} id={id('windowColor')} rowId={id('windowColor-row')}
  label="Separate window color" swatchLabel="Window color"
  tip="Colors light that comes through the back of the stone, called a window or leak, so leaks are easy to find. Off, that light shows the flat background, or the lighting."
  checkboxId={id('useWindowColor')} checked={windowOn}
  oncheck={checked => {
    app.set_window_color(checked, ...app.window_color());
    writeSetting(USE_WINDOW_COLOR_SETTING, String(checked));
    windowPicker.refresh();
    requestRender();
  }}
  read={() => app.window_color()}
  write={rgb => {
    app.set_window_color(app.window_color_enabled(), ...rgb);
    writeSettingColor(WINDOW_COLOR_SETTING, rgb);
    requestRender();
  }} />
