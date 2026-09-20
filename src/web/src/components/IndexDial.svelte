<script>
  // The index dial drawn round the stone (2026-09-19, the user's request): a ring of ticks, one
  // per tooth of the index gear, numbered on the major ones, shown while the stone is within
  // about 5 degrees of face-up or face-down and fading out over the 5 degrees after that
  // (`dialOpacity`). Its geometry is index_dial.js's, in the
  // design's own frame; this projects it onto the canvas with GemApp::project_file_points, the
  // renderer's own camera, so the dial sits on the stone through an orbit, a zoom or a resize.
  //
  // Like the cutting plane (EditOverlay.svelte), it runs on the INTERFACE's clock -- an
  // animation frame each -- rather than the renderer's, so it keeps up with the pointer while
  // the picture is still catching up behind it. The one thing each frame must do is read the y
  // rotation back from Rust: an orbit drag and the wheel's zoom both move the camera without
  // telling the page in any way a store can be watched for. Everything else (the ring's points,
  // which ticks are major, the numbers) is worked out only when the stone, the gear or the
  // design changes.
  //
  // The whole dial projects in ONE wasm call and draws as two <path>s, a <polygon> and one
  // <text> per number: on a 96-tooth gear that is 208 points a frame but only about 20 DOM
  // attributes, where a <line> per tick would have been nearly 400.
  import { gearTeeth } from '../lib/gear.js';
  import { tierView, getDesign } from '../lib/tier_controller.js';
  import { engine, stoneStatsStore } from '../lib/stores.js';
  import { indexDial, dialOpacity } from '../lib/index_dial.js';

  // The dial in the design's frame: worked out again when the rows are redrawn (an edit, an
  // undo, a new stone), when the gear changes, and when the stone's own measurements do -- not
  // every frame.
  const dial = $derived.by(() => {
    void $tierView.key;
    const design = getDesign();
    const stats = $stoneStatsStore;

    // A plain .obj has no faceting design, so it has no index gear and nothing to mark.
    if (design === null || stats === null) {
      return null;
    }

    return indexDial(design, $gearTeeth, stats.girdleRadius, stats.girdleZ);
  });

  // What is drawn, in CSS pixels over the canvas: the ring as an SVG points string, the minor
  // and major ticks as one path each, and the numbered ticks. Null for nothing.
  let drawn = $state(null);

  /** Projects the dial with the camera of the frame just drawn. */
  function project() {
    const canvas = document.getElementById('canvas');

    if (dial === null || !engine.app || !canvas) {
      drawn = null;
      return;
    }

    // Read back from Rust rather than from a store: the drag and the wheel move the camera
    // directly, and only `spin`/`tilt` know where it ended up. The fade is worked out here, a
    // frame at a time, rather than left to a CSS transition, so it follows the stone exactly:
    // it is a function of where the stone is pointing, not of how long ago it moved.
    const opacity = dialOpacity(engine.app.get_param('tilt'));

    if (opacity === 0) {
      drawn = null;
      return;
    }

    // Every point in one array, in three runs: each tick's base (which is also the ring), each
    // tick's tip, then the numbers' anchors.
    const points = [
      ...dial.ticks.map(tick => tick.base),
      ...dial.ticks.map(tick => tick.tip),
      ...dial.labels.map(label => label.at),
    ];
    const flat = new Float32Array(points.length * 3);

    points.forEach((point, i) => flat.set([point.x, point.y, point.z], i * 3));

    const projected = engine.app.project_file_points(flat);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const screen = [];

    for (let i = 0; i < points.length; i++) {
      // Behind a perspective eye: nothing sensible to draw. Face-on, the whole ring is either
      // in front or the stone is not on screen at all, so this is all or nothing.
      if (!(projected[i * 3 + 2] > 0)) {
        drawn = null;
        return;
      }

      screen.push({
        x: ((projected[i * 3] + 1) / 2) * width,
        y: ((1 - projected[i * 3 + 1]) / 2) * height,
      });
    }

    const count = dial.ticks.length;
    const strokes = big => dial.ticks
      .map((tick, i) => (tick.big === big
        ? `M${screen[i].x},${screen[i].y}L${screen[count + i].x},${screen[count + i].y}` : ''))
      .join('');

    drawn = {
      opacity,
      ring: screen.slice(0, count).map(point => `${point.x},${point.y}`).join(' '),
      minor: strokes(false),
      major: strokes(true),
      labels: dial.labels.map((label, i) => ({ index: label.index, at: screen[2 * count + i] })),
    };
  }

  // One projection an animation frame for as long as there is a dial to draw. The check that
  // the stone is face-on is inside `project` rather than out here, because nothing notifies the
  // page when an orbit crosses the 5-degree line.
  $effect(() => {
    if (dial === null) {
      drawn = null;
      return;
    }

    let frame = requestAnimationFrame(function step() {
      project();
      frame = requestAnimationFrame(step);
    });

    return () => cancelAnimationFrame(frame);
  });
</script>

{#if drawn}
  <svg id="index-dial" aria-hidden="true" opacity={drawn.opacity}>
    <polygon class="dial-ring" points={drawn.ring} />
    <path class="dial-tick" d={drawn.minor} />
    <path class="dial-tick major" d={drawn.major} />
    {#each drawn.labels as label (label.index)}
      <text class="dial-label" x={label.at.x} y={label.at.y}>{label.index}</text>
    {/each}
  </svg>
{/if}

<style>
  #index-dial {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;
  }

  /* The circle the ticks stand on: drawn through the tick bases, so it is a polygon of as many
     sides as the gear has teeth -- at 96 that is indistinguishable from a circle. */
  .dial-ring {
    fill: none;
    stroke: var(--text);
    stroke-opacity: 0.25;
    stroke-width: 1;
  }

  .dial-tick {
    fill: none;
    stroke: var(--text);
    stroke-opacity: 0.35;
    stroke-width: 1;
  }

  .dial-tick.major {
    stroke-opacity: 0.6;
    stroke-width: 1.5;
  }

  .dial-label {
    fill: var(--text);
    fill-opacity: 0.7;
    font-size: 10px;
    text-anchor: middle;
    dominant-baseline: middle;
  }
</style>
