<script>
  // One labelled slider with an editable readout: the panel's
  // `<div class="row"><span class="name">..</span><span class="value" id=".."></span></div>`
  // over a shadcn-svelte Slider (Bits UI), written once. Deliberately dumb: what the value
  // means (a Rust parameter, a page-only setting) is the parent's business.
  //
  //   id, label, tip   the slider's id (the readout is `<id>-value`), its name and its tooltip
  //   spec             { min, max, step } from SLIDER_SPECS
  //   value, text      what the slider and its readout show now
  //   oninput(v)       the slider moved (`v` is a number); onchange: it was released
  //   readout*         the readout's typing: read/write in the unit the parent works in, and the
  //                    conversion to the unit shown (see EditableReadout)
  //   rowId, rowStyle  the row's own id and inline style, where a setting has them
  //
  // The slider is not an <input type=range> (Bits UI draws a track and a role=slider thumb), so
  // its id is on the slider's root element and the thumb inside it takes the focus and the
  // arrow keys. `onValueChange` is what the range input's `input` event was (every step of a
  // drag or a key press) and `onValueCommit` its `change` (the release). `onValueChange` also
  // fires for a rounding Bits UI makes itself, which `moved` below filters out; a change the
  // parent makes to `value` (a material preset, an undo) is not a commit, which is what keeps it
  // from being recorded as a drag.
  import EditableReadout from './EditableReadout.svelte';
  import { Slider } from '$lib/components/ui/slider/index.js';

  let {
    id, label, tip, spec, value, text, oninput, onchange = undefined,
    readoutRead, readoutWrite, toDisplay = undefined, fromDisplay = undefined,
    rowId = undefined, rowStyle = undefined,
  } = $props();

  // Bits UI reports EVERY change of its value, including one it makes itself: it rounds the value
  // it is given onto a step (Rust holds the refractive index as an f32, 2.1600000190734863, which
  // is not on the 0.001 grid) and calls onValueChange with the rounded number. Taken as a move
  // that would write the rounded value back to Rust (snapping a spin of -173.6 to -174 while the
  // stone is dragged), and, since the write changes `value` again, loop until Svelte gives up.
  // A user's move is at least most of a step away from where the slider was, a rounding never is.
  function moved(v) {
    if (Math.abs(v - value) >= spec.step / 2 - 1e-9) {
      oninput(v);
    }
  }
</script>

<div class="setting" id={rowId} style={rowStyle} data-tip={tip}>
  <div class="row"><span class="name">{label}</span><EditableReadout id="{id}-value" {text}
    read={readoutRead} write={readoutWrite} {toDisplay} {fromDisplay} /></div>
  <Slider type="single" {id} min={spec.min} max={spec.max} step={spec.step} {value}
    thumbLabel={label} class="py-1"
    onValueChange={moved} onValueCommit={() => onchange?.()} />
</div>
