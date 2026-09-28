// Skipping an overlay's redraw when nothing it depends on has moved (2026-09-28).
//
// The index dial (IndexDial.svelte) and edit mode's cutting plane (EditOverlay.svelte) follow the
// stone on the interface's clock: every animation frame they project their points through the
// renderer's camera and redraw their SVG. They used to hand Svelte a new object every frame
// whether or not the camera had moved, which re-ran the SVG's effects and rewrote its attributes
// 60 times a second while the stone sat still, and competed with the render loop for the page
// thread during a drag.
//
// A tracker remembers what the last frame projected to and where the canvas sat, and says whether
// this frame is any different. The projection itself is one wasm call and stays every frame: the
// drag and the wheel move the camera without telling the page, so projecting is the only way to
// find out whether it moved.

/**
 * A function `changed(projected, width, height, left, top)` that is true when the projected
 * points (`GemApp::project_file_points`' Float32Array) or the canvas's size and offset differ
 * from its previous call's, and on its first call. `forget()` on it makes the next call true
 * again, for when the overlay stopped drawing and must draw afresh.
 */
export function projectionTracker() {
  let last = null;

  function changed(projected, width, height, left, top) {
    const key = new Float32Array(projected.length + 4);

    key.set(projected);
    key.set([width, height, left, top], projected.length);

    const same = last !== null
      && last.length === key.length
      && key.every((value, i) => value === last[i]);

    last = key;

    return !same;
  }

  changed.forget = () => {
    last = null;
  };

  return changed;
}
