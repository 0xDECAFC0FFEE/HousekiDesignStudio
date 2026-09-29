// Tilt performance's measuring loop (T-0261), shared by the two places that measure a stone:
// Tools > Tilt performance (tilt_performance_mode.js) and, under its grid, Edit > Manual optimizer
// (manual_optimizer_mode.js, T-0274). Moved here from tilt_performance_mode.js on 2026-09-28 so
// the optimizer imports the very loop the tool measures with rather than a copy of it.
//
// The renderer does the measuring (`GemApp::tilt_begin` / `tilt_poll`, src/renderer/tilt.rs): it
// draws a batch of poses off screen as tiles of one image and reads them back behind a fence, so
// the page never waits on the GPU. This loop hands it the poses in batches of `tilt_batch_size`,
// as many batches at once as it takes (`tilt_can_begin`, two), asks every few milliseconds
// whether the oldest is done, and files each pose's numbers as they come in
// (tilt_performance.js's `readMeasurement`).
//
// It measures the stone ON SCREEN (the renderer's own model), from Gem Cut Studio's camera at
// each pose, at a fixed size, whatever the page's view, zoom or canvas.

import { readMeasurement } from './tilt_performance.js';

/**
 * How often the batches in flight are asked whether they are done: as often as a timer runs.
 * Asking is cheap (a fence test), and waiting a whole frame between asks left the GPU idle.
 */
export const POLL_MS = 4;

/** The key a pose is filed under: `'x:12'`, its half of the graph and its angle. */
export const poseKey = ({ axis, angle }) => `${axis}:${angle}`;

/**
 * A measuring loop on the renderer `app()` returns (read afresh each time, so a test or a reload
 * can swap it). Returns `{ measure, cancel, busy }`:
 *
 *   measure(poses)   measures `poses` (`[{ axis, angle, spin, tilt }]`, as tilt_performance.js's
 *                    `sweepPoses` gives them): every one not already queued on the renderer is
 *                    queued as soon as the renderer takes it. It REPLACES what was waiting to be
 *                    queued, so a narrower list drops the poses no longer wanted; a batch already
 *                    on the renderer is always finished.
 *   cancel()         abandons every pose waiting or queued (`tilt_cancel`); nothing more is reported.
 *   busy()           whether any pose is waiting or queued.
 *
 * and calls:
 *
 *   onMeasured(pose, measurement)   for each pose as its batch comes in, in the order given;
 *   onProgress()                    after each round of polling that brought something in, and
 *                                   once more when the last pose is in (busy() is false then);
 *   onError(cause)                  when the renderer refuses a batch or fails reading one; the
 *                                   loop has already cancelled everything.
 */
export function createTiltSweep({
  app, onMeasured = () => {}, onProgress = () => {}, onError = () => {},
}) {
  // Poses to queue, in order; and the batches on the renderer, oldest first (they finish in that
  // order).
  let waiting = [];
  let inFlight = [];
  let timer = null;

  function busy() {
    return waiting.length > 0 || inFlight.length > 0;
  }

  function measure(poses) {
    const queued = new Set(inFlight.flat().map(poseKey));

    waiting = poses.filter(pose => !queued.has(poseKey(pose)));
    pump();

    if (!busy()) {
      onProgress();
    }
  }

  function cancel() {
    clearTimeout(timer);
    timer = null;
    waiting = [];

    if (inFlight.length > 0) {
      inFlight = [];
      app()?.tilt_cancel();
    }
  }

  /** Queues as many waiting poses as the renderer takes, and polls again soon if any are out. */
  function pump() {
    const renderer = app();

    if (!renderer) {
      return;
    }

    const size = renderer.tilt_batch_size();

    while (waiting.length > 0 && renderer.tilt_can_begin()) {
      const batch = waiting.splice(0, size);

      try {
        renderer.tilt_begin(new Float32Array(batch.flatMap(({ spin, tilt }) => [spin, tilt])));
      } catch (cause) {
        fail(cause);
        return;
      }

      inFlight.push(batch);
    }

    if (inFlight.length > 0) {
      clearTimeout(timer);
      timer = setTimeout(poll, POLL_MS);
    }
  }

  /** Collects every batch that is done, oldest first, then queues more. */
  function poll() {
    timer = null;

    const renderer = app();

    if (!renderer || inFlight.length === 0) {
      return;
    }

    let collected = false;

    try {
      while (inFlight.length > 0 && renderer.tilt_poll()) {
        const batch = inFlight.shift();
        const values = Array.from(renderer.tilt_result());

        collected = true;
        batch.forEach((pose, i) => onMeasured(pose, readMeasurement(values.slice(i * 10, i * 10 + 10))));
      }
    } catch (cause) {
      fail(cause);
      return;
    }

    pump();

    if (collected) {
      onProgress();
    }
  }

  function fail(cause) {
    cancel();
    onError(cause);
  }

  return { measure, cancel, busy };
}
