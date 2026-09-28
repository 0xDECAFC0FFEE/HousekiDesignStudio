// Tests for overlay_projection.js: the check that lets the index dial and the cutting plane skip
// redrawing their SVG on an animation frame where nothing they depend on has moved.
import { projectionTracker } from '../src/lib/overlay_projection.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

// Setup: a fresh tracker and one projection (two points, three floats each) with a canvas size
// and offset. Test: ask whether it changed, twice with identical inputs. Verifies the first frame
// always draws (there is nothing on screen yet) and an identical second frame does not.
Deno.test('the first frame draws and an identical one does not', () => {
  const moved = projectionTracker();
  const projected = new Float32Array([0.1, 0.2, 1, -0.3, 0.4, 1]);

  assert(moved(projected, 800, 600, 0, 0));
  assert(!moved(new Float32Array(projected), 800, 600, 0, 0), 'an identical frame redrew');
});

// Setup: a tracker that has seen one frame. Test: change one thing at a time -- a single
// projected coordinate, then the canvas width, then its left offset (the pane "scoot" moves the
// canvas without moving the camera). Verifies each on its own counts as a change, so the overlay
// follows an orbit, a resize and a scoot alike.
Deno.test('a moved point, a resized canvas or a moved canvas each count as a change', () => {
  const moved = projectionTracker();
  const projected = new Float32Array([0.1, 0.2, 1, -0.3, 0.4, 1]);

  moved(projected, 800, 600, 0, 0);

  const nudged = new Float32Array(projected);

  nudged[3] = -0.30001;
  assert(moved(nudged, 800, 600, 0, 0), 'a projected point moved');
  assert(moved(nudged, 801, 600, 0, 0), 'the canvas was resized');
  assert(moved(nudged, 801, 600, 12, 0), 'the canvas was moved inside the viewport');
});

// Setup: a tracker that has seen a frame. Test: forget, then ask about the very same frame.
// Verifies `forget` makes the next frame draw however it projects -- what an overlay needs after
// it has hidden itself (the dial past 10 degrees of tilt) or been given new geometry whose
// points happen to project the same.
Deno.test('forget makes the next frame draw even if nothing moved', () => {
  const moved = projectionTracker();
  const projected = new Float32Array([0.5, 0.5, 1]);

  moved(projected, 800, 600, 0, 0);
  moved.forget();

  assert(moved(projected, 800, 600, 0, 0));
});

// Setup: a tracker that has seen a four-point projection. Test: give it a five-point one whose
// first four points are the same. Verifies a change in the number of points counts as a change,
// rather than being compared only over the shorter length.
Deno.test('a different number of points counts as a change', () => {
  const moved = projectionTracker();

  moved(new Float32Array(12), 800, 600, 0, 0);

  assert(moved(new Float32Array(15), 800, 600, 0, 0));
});
