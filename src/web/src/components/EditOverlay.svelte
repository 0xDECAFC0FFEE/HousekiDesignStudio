<script>
  // Edit mode's guide over the stone (T-0193): the cutting plane on the facet being edited. Its
  // geometry is edit_geometry.js's, in the design's own frame; this projects it onto the canvas
  // with GemApp::project_file_points, the renderer's own camera, once per animation frame, so the
  // plane follows an orbit, a zoom or a resize exactly -- and on the interface's clock, not the
  // tracer's, so it keeps up with the pointer while the picture is still catching up
  // (2026-09-19). An SVG laid over the canvas that takes no pointer events, so the stone is
  // dragged and clicked through it as before.
  //
  // The protractor that stood above the plane -- the arc, its ticks and labels, the reading line
  // and the written angle -- was removed on 2026-09-19 at the user's request ("lets remove the
  // protractor from the rendering", "everything but the cutting plane itself"). See the head of
  // edit_geometry.js. Four corners are now the whole of what is projected each frame.
  //
  // Drawn on top of the picture, not depth-tested against the stone: the parts of the plane
  // behind the rock show through it, lightly, as the plane is mostly transparent.
  import { editing, editDragging } from '../lib/edit_mode.js';
  import { editGuides, rockShape } from '../lib/edit_geometry.js';
  import { tierView, getDesign } from '../lib/tier_controller.js';
  import { engine } from '../lib/stores.js';

  // The stone the rock is measured by, kept between runs: building it is the expensive half of
  // the guide (about half a second), so while a scale is being dragged the one from before the
  // drag is reused and the plane is carried onto the tier's current angle instead
  // (edit_geometry.js). It is built again as soon as the drag ends, or any other edit lands.
  let shape = null;
  let shapeFor = null;

  // The plane in the design's frame: worked out again when edit mode starts on another facet and
  // when the rows are redrawn (an edit, an undo, a gear change), not every frame.
  const guides = $derived.by(() => {
    void $tierView.key;
    const session = $editing;
    const design = getDesign();

    if (session === null || design === null) {
      shape = null;
      shapeFor = null;
      return null;
    }

    try {
      if (shape === null || shapeFor !== design || !$editDragging) {
        shape = rockShape(design);
        shapeFor = design;
      }

      return editGuides(design, session.tier, session.facet, shape);
    } catch (cause) {
      console.warn(`Edit mode: could not place the cutting plane: ${cause}`);
      return null;
    }
  });

  // What is drawn: the plane's four corners projected to CSS pixels over the canvas, as an SVG
  // points string, or null for nothing.
  let drawn = $state(null);

  /** Projects the cutting plane with the camera of the frame just drawn. */
  function project() {
    const canvas = document.getElementById('canvas');

    if (guides === null || !engine.app || !canvas) {
      drawn = null;
      return;
    }

    const points = guides.plane;
    const flat = new Float32Array(points.length * 3);

    points.forEach((point, i) => flat.set([point.x, point.y, point.z], i * 3));

    const projected = engine.app.project_file_points(flat);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    // Where the canvas sits in #viewport, which this SVG covers: 0 normally, offset while a side
    // pane's handle is dragged and the canvas is centred in the changing region (the "scoot",
    // viewport.js). Without it the plane stayed put while the stone moved; IndexDial does the same.
    const left = canvas.offsetLeft;
    const top = canvas.offsetTop;
    const screen = [];

    for (let i = 0; i < points.length; i++) {
      // Behind a perspective eye: nothing sensible to draw.
      if (!(projected[i * 3 + 2] > 0)) {
        drawn = null;
        return;
      }

      screen.push({
        x: left + ((projected[i * 3] + 1) / 2) * width,
        y: top + ((1 - projected[i * 3 + 1]) / 2) * height,
      });
    }

    drawn = { plane: screen.map(p => `${p.x},${p.y}`).join(' ') };
  }

  // The plane follows the camera on the INTERFACE's clock, not the renderer's (2026-09-19): an
  // animation frame each, whether or not a trace pass has finished, so it stays under the
  // pointer during a drag while the picture catches up behind it. Projecting is one wasm call
  // for four points, so this is cheap enough to do every frame; the loop only runs while edit
  // mode is on.
  $effect(() => {
    if (guides === null) {
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
  <svg id="edit-overlay" aria-hidden="true">
    <polygon class="cutting-plane" points={drawn.plane} />
  </svg>
{/if}

<style>
  #edit-overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;
  }

  .cutting-plane {
    fill: var(--accent);
    fill-opacity: 0.16;
    stroke: var(--accent);
    stroke-width: 1.5;
    stroke-linejoin: round;
  }
</style>
