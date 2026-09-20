// Keeping the heavy work off the UI's back (2026-09-19, the user: "is it possible to decouple
// the UI refresh rate with the rendering refresh rate? in both edit mode and the rendering
// settings menu and everywhere else").
//
// THE PROBLEM. The path tracer runs on the page's own thread: `app.render` is one long
// synchronous call, and so is rebuilding the stone from a design. While either runs, nothing
// else happens -- no pointer events, no Svelte update, no paint. The render loop used to chain
// itself through `requestAnimationFrame`, so during accumulation a trace pass started at the top
// of every frame and the interface was whatever was left of it. Dragging a slider or a ruler
// therefore moved in steps as large as one trace pass.
//
// THE RULE HERE. A budgeted task runs its work in a plain macrotask (`setTimeout`), never inside
// an animation frame, and then waits. It measures how long the work took and leaves a gap after
// it, so the work gets at most `budget` of the wall clock and everything else -- input handlers,
// Svelte's own updates, layout and paint -- gets the rest. A request made while the work is
// running is remembered and runs after the gap, so a burst of requests (a pointer move per
// pixel) collapses into a steady cadence instead of a queue.
//
// A macrotask rather than an animation frame is the important half: the browser paints between
// tasks, so the interface shows the drag as it happens and the picture catches up behind it.
//
// WORK THAT IS NOT FINISHED WHEN IT RETURNS (T-0197, 2026-09-19, the user: "when i switch the
// raytracer to montecarlo its extremely slow and freezes my computer"). The rule above measures
// how long `run()` took. For a GL renderer that measures nothing: `app.render` *queues* a pass
// and returns in well under a millisecond while the pass itself takes hundreds. Sized from that,
// the gap was microscopic, so the Monte Carlo loop -- which asks for its next pass from inside
// the last one -- submitted hundreds of full-resolution path traces into a queue the GPU was
// seconds behind on, until the driver blocked the submitting thread and took the tab, and the
// desktop compositor behind it, down with it.
//
// So a task may be given a `settled()` test, asked after the work returns: the run is not over,
// and the gap does not start, until it says the work has really finished. That makes the gap
// honest AND bounds the queue to one outstanding unit of work, which is the half that stops the
// freeze. Work that finishes when it returns leaves `settled` alone and behaves exactly as before.

/** How much of the wall clock the work may take when no budget is given. */
const DEFAULT_BUDGET = 0.7;
/** Longest gap between runs, however slow the work is, so nothing ever feels stalled. */
const DEFAULT_MAX_GAP_MS = 250;
/** What the first gap is computed from, before anything has been measured. */
const DEFAULT_FIRST_COST_MS = 8;
/**
 * How often to ask `settled()` again. Small enough to add no noticeable latency to work that
 * takes tens of ms, and the ask itself is a non-blocking poll, so this is cheap.
 */
const DEFAULT_SETTLE_POLL_MS = 4;
/**
 * How long to keep asking before giving up and calling the work done anyway.
 *
 * This guards against a `settled()` that never becomes true -- a lost GL context, a driver that
 * will not honour a fence -- which would otherwise stop the picture for good. Deliberately far
 * longer than any real pass: a cap short enough to trip on a genuinely slow frame would bring
 * back the pile-up it exists to prevent.
 */
const DEFAULT_MAX_SETTLE_MS = 20000;

/**
 * Builds a budgeted task around `run`.
 *
 * - `budget` is the share of the wall clock the work may use, 0 to 1.
 * - `minGap` is a floor under the gap, in ms; `maxGap` the ceiling.
 * - `paused()` may say "not now" (the tab is hidden): the run is skipped and tried again after
 *   `maxGap`, keeping the request pending.
 * - `settled()` says whether the work `run()` started has actually finished. The default says
 *   yes at once, for work that finishes when it returns. Give it for work that does not (a GL
 *   pass), and no second run is started, and no cost is recorded, until it says yes.
 * - `now` and `schedule` are injected so this is testable without a browser.
 *
 * Returns `{ request, cancel, cost }`: `request()` asks for a run (soon, or at once when the
 * gap has already passed), `cancel()` drops a pending one, and `cost()` is the measured cost of
 * the last run, in ms -- to where `settled()` agreed it was over, not merely where `run()`
 * returned.
 */
export function budgetedTask({
  run,
  budget = DEFAULT_BUDGET,
  minGap = 0,
  maxGap = DEFAULT_MAX_GAP_MS,
  paused = () => false,
  settled = () => true,
  settlePoll = DEFAULT_SETTLE_POLL_MS,
  maxSettle = DEFAULT_MAX_SETTLE_MS,
  now = () => performance.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  unschedule = handle => clearTimeout(handle),
}) {
  // The measured cost of the last run, smoothed a little so one slow pass does not set the
  // cadence for good.
  let cost = DEFAULT_FIRST_COST_MS;
  // True while a run is pending (requested and not yet done).
  let wanted = false;
  let handle = null;
  let ranAt = -Infinity;
  // True while the work itself is running. A request made from inside it (the render loop asking
  // for its next accumulation pass) must NOT schedule a run of its own: the gap is measured from
  // the end of this run, and scheduling here would time it from the end of the last one -- which
  // has already passed -- so the work would run back to back and take the whole thread. This is
  // exactly what happened when this was first written: 22 trace passes in 1.4 s with 4 animation
  // frames between them.
  let running = false;

  /** How long to wait after a run of `cost` ms for the rest of the page to have its share. */
  function gap() {
    const share = budget <= 0 ? maxGap : (cost * (1 - budget)) / budget;

    return Math.min(maxGap, Math.max(minGap, share));
  }

  function fire() {
    handle = null;

    if (!wanted) {
      return;
    }

    if (paused()) {
      // Nothing to draw into (a hidden tab): keep the request and look again later.
      handle = schedule(fire, maxGap);
      return;
    }

    // Cleared BEFORE the work runs, so anything the work itself requests (the next accumulation
    // pass) is seen as a fresh request rather than swallowed by this one.
    wanted = false;
    running = true;

    const started = now();

    try {
      run();
    } finally {
      running = false;
    }

    waitToSettle(started);
  }

  /**
   * Holds the run open until `settled()` agrees the work is over, then closes it out.
   *
   * The wait is a poll on a timer rather than a block, so the page thread is free throughout --
   * which is the point: while a trace pass is on the GPU, pointer events, Svelte's updates and
   * paint all still run. A pending `handle` during the wait is also what keeps a request made
   * in the meantime (the accumulation loop asking for its next pass) from starting a second
   * run on top of this one.
   */
  function waitToSettle(started) {
    if (!settled() && now() - started < maxSettle) {
      handle = schedule(() => {
        handle = null;
        waitToSettle(started);
      }, settlePoll);

      return;
    }

    const took = now() - started;

    // A running mean of the last few runs: steady enough that one slow pass does not stretch
    // every gap after it, quick enough to follow a real change in cost.
    cost = cost * 0.5 + took * 0.5;
    ranAt = now();

    if (wanted && handle === null) {
      handle = schedule(fire, gap());
    }
  }

  return {
    request() {
      wanted = true;

      // Scheduled already, or asked for from inside the work itself: `fire` schedules the next
      // run when this one is done and its cost is known.
      if (handle !== null || running) {
        return;
      }

      // A request after a long quiet spell runs straight away: the gap is only there to keep
      // back-to-back runs from crowding the page out.
      const waited = now() - ranAt;

      handle = schedule(fire, Math.max(0, gap() - waited));
    },

    cancel() {
      wanted = false;

      if (handle !== null) {
        unschedule(handle);
        handle = null;
      }
    },

    cost() {
      return cost;
    },
  };
}
