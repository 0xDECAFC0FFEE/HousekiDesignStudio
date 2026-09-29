<script>
  // An on/off setting: a shadcn-svelte Switch (Bits UI) that still answers to the tools that
  // drive the page's old `<input type=checkbox>`es (see nativeChecked in native.js). The old
  // markup was a checkbox in a <label> with the setting's name; a Switch is the same control
  // for a setting, and a <label> around it still toggles it when the name is clicked.
  //
  //   id        the switch's own id (`#wireframe`, `#useBackground`, `#useWindowColor`)
  //   checked   its state (the parent reads it from Rust); the switch owns it until the parent's
  //             value changes
  //   onchange  called with the new state, when the user flips it or a tool sends `change`
  import { Switch } from '$lib/components/ui/switch/index.js';
  import { nativeChecked } from '../lib/native.js';

  let { id, checked = false, onchange, ...rest } = $props();

  let on = $state(checked);
  let element = $state(null);

  // Follows `checked` when the parent's value for it changes (T-0273: the lighting controls are
  // drawn twice, and each copy re-reads Rust after the other was used). A parent whose value
  // never changes sees no difference: the switch still owns its state between changes.
  $effect(() => {
    on = checked;
  });

  // `checked` and a native `change` event on the button, for scripts (native.js).
  $effect(() => {
    if (element) {
      return nativeChecked({ get: () => on, set: value => { on = Boolean(value); }, onchange })(element);
    }
  });
</script>

<Switch {id} size="sm" bind:ref={element} bind:checked={on} onCheckedChange={value => onchange(value)}
  {...rest} />
