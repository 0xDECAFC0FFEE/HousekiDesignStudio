<script>
  // A slider that maps one-to-one onto a Rust parameter name (`PARAM_SLIDERS` in panel_config.js),
  // initialised from the Rust-side defaults so the two cannot drift, and re-read from Rust
  // whenever `paramRevision` changes (a material preset, an undo, a drag of the stone that moved
  // spin and tilt).
  //
  // The refractive index and dispersion are material, so their changes go in the edit history: a
  // drag as one entry, from its first step to the release ('change'), and a typed value as one
  // entry of its own. `maxBounces`, `headShadowHalfAngle` and `luxSamples` also persist across
  // reloads (T-0156, PERSISTED_PARAM_SETTINGS).
  import { engine, paramRevision } from '../lib/stores.js';
  import { FORMAT, SLIDER_SPECS, PERSISTED_PARAM_SETTINGS } from '../lib/panel_config.js';
  import { writeSetting } from '../lib/settings.js';
  import {
    MATERIAL_FIELDS, applyParam, materialState, recordMaterialChange, recordedMaterialEdit,
  } from '../lib/session.js';
  import { pickers } from '../lib/pickers.js';
  import Slider from './Slider.svelte';

  let { name, label, tip, rowId = undefined, rowStyle = undefined } = $props();

  const app = engine.app;
  const persisted = PERSISTED_PARAM_SETTINGS.includes(name);
  const material = MATERIAL_FIELDS.includes(name);

  let value = $state(app.get_param(name));
  let text = $state(FORMAT[name](app.get_param(name)));
  let dragBefore = null;

  // Read back from Rust whenever something else may have changed it. (The first run is the
  // initial read again, which is harmless.)
  $effect(() => {
    void $paramRevision;

    value = app.get_param(name);
    text = FORMAT[name](value);
  });

  /** Sets the parameter and shows what Rust actually holds; false if Rust refused it. */
  function apply(v) {
    const accepted = applyParam(name, v);

    if (accepted) {
      // Read back rather than echoing the input: Rust clamps and wraps, and the readout
      // should show what is actually being rendered.
      text = FORMAT[name](app.get_param(name));
    }

    return accepted;
  }

  function oninput(v) {
    if (material && dragBefore === null) {
      pickers.stoneColor?.close();
      dragBefore = materialState();
    }

    value = v;
    apply(v);

    if (persisted) {
      writeSetting(`gems.${name}`, String(app.get_param(name)));
    }
  }

  function onchange() {
    if (dragBefore !== null) {
      recordMaterialChange(`Change ${name}`, [name], dragBefore);
      dragBefore = null;
    }
  }

  // A typed value also moves the slider, which pins at its end for values beyond it.
  function write(typedValue) {
    const typed = () => {
      if (apply(typedValue)) {
        value = app.get_param(name);

        if (persisted) {
          writeSetting(`gems.${name}`, String(app.get_param(name)));
        }
      }
    };

    if (material) {
      recordedMaterialEdit(`Change ${name}`, [name], typed);
    } else {
      typed();
    }
  }
</script>

<Slider id={name} {label} {tip} spec={SLIDER_SPECS[name]} {value} {text} {oninput} {onchange}
  readoutRead={() => app.get_param(name)} readoutWrite={write} {rowId} {rowStyle} />
