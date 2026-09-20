/*
 * work_budget_test.js -- tests for web/src/lib/work_budget.js, the scheduler that keeps the
 * renderer (and the stone rebuild) from taking the whole page (2026-09-19, the user: "is it
 * possible to decouple the UI refresh rate with the rendering refresh rate?").
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The clock and the timer are injected, so the cadence is checked exactly, with no waiting and
 * no browser. That a drag really does stay smooth while the tracer runs is measured against the
 * built page over CDP instead.
 */

import { budgetedTask } from "../src/lib/work_budget.js";

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

/**
 * A fake clock with a timer queue: `clock.now` is the time, `clock.tick(ms)` moves it forward
 * and fires whatever was due, and `clock.pending` is how many timers are waiting. Each run of
 * the work advances the clock by `costMs`, which is how the task measures it.
 */
function fakeClock() {
  const timers = [];

  return {
    now: 0,
    get pending() {
      return timers.length;
    },
    schedule(fn, ms) {
      const timer = { at: this.now + ms, fn };

      timers.push(timer);
      return timer;
    },
    unschedule(timer) {
      const at = timers.indexOf(timer);

      if (at >= 0) {
        timers.splice(at, 1);
      }
    },
    tick(ms) {
      const until = this.now + ms;

      for (;;) {
        const next = timers.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0];

        if (!next) {
          break;
        }

        timers.splice(timers.indexOf(next), 1);
        this.now = Math.max(this.now, next.at);
        next.fn();
      }

      this.now = until;
    },
  };
}

/**
 * A budgeted task whose work costs `costMs` of the fake clock each time it runs. With
 * `selfRequesting`, the work asks for another run from inside itself, which is the render
 * loop's own shape while accumulating.
 */
function task(clock, costMs, options = {}, selfRequesting = false) {
  const runs = [];
  const handle = budgetedTask({
    run: () => {
      runs.push(clock.now);
      clock.now += costMs;

      if (selfRequesting) {
        handle.request();
      }
    },
    now: () => clock.now,
    schedule: (fn, ms) => clock.schedule(fn, ms),
    unschedule: timer => clock.unschedule(timer),
    ...options,
  });

  return { handle, runs };
}

Deno.test("work runs in a task, not straight away, and a burst collapses into one run", () => {
  // Setup: a task whose work costs 20 ms, on a fake clock.
  // Test: request it five times in a row (a pointer move per pixel), then let the clock run.
  // Verifies: nothing runs inside the requests themselves -- the caller returns at once, so a
  // pointer handler is never blocked by a trace pass -- and the five requests produce ONE run,
  // rather than five queued behind each other.
  const clock = fakeClock();
  const { handle, runs } = task(clock, 20);

  for (let i = 0; i < 5; i++) {
    handle.request();
  }

  assertEqual(runs.length, 0, "nothing ran during the requests");

  clock.tick(50);
  assertEqual(runs.length, 1, "the burst collapsed into one run");
});

Deno.test("the work gets its budget of the clock and the page gets the rest", () => {
  // Setup: work costing 20 ms a run, asked for again from inside itself -- the render loop's own
  // shape while accumulating, where each pass asks for the next -- at three budgets.
  // Test: let 2 seconds of the fake clock pass, then measure what share of it went into the work.
  // Verifies: the work takes about its budget of the wall clock and no more, so the rest is
  // always there for pointer events, Svelte's updates and paint. At 50% the renderer runs half
  // the time; at 90% it runs nearly flat out; at 25% the page keeps three quarters of the clock
  // for itself. Without this the loop ran back to back and took everything.
  for (const budget of [0.25, 0.5, 0.9]) {
    const clock = fakeClock();
    const cost = 20;
    const { handle, runs } = task(clock, cost, { budget });

    handle.request();

    for (let i = 0; i < 400; i++) {
      handle.request();
      clock.tick(5);
    }

    const share = (runs.length * cost) / clock.now;

    if (Math.abs(share - budget) > 0.06) {
      throw new Error(`at a ${budget} budget the work took ${share.toFixed(2)} of the clock`);
    }
  }
});

Deno.test("work that asks for itself again still leaves the page its share", () => {
  // Setup: work costing 20 ms that requests another run from INSIDE itself -- the accumulation
  // loop, where each trace pass asks for the next -- at a 50% budget.
  // Test: let 2 seconds of the fake clock pass with no outside help at all.
  // Verifies: the runs are still spaced by the gap, so the work takes about half the clock. This
  // is the case that failed when this module was first written: a request made during the run was
  // timed from the END OF THE PREVIOUS run, which had long passed, so it ran at once and the loop
  // went back to back -- measured on the built page as 22 trace passes in 1.4 s with only 4
  // animation frames in between, which is the stutter the whole module exists to prevent.
  const clock = fakeClock();
  const cost = 20;
  const { handle, runs } = task(clock, cost, { budget: 0.5 }, true);

  handle.request();
  clock.tick(2000);

  const share = (runs.length * cost) / clock.now;

  if (Math.abs(share - 0.5) > 0.06) {
    throw new Error(`the self-requesting loop took ${share.toFixed(2)} of the clock`);
  }
});

Deno.test("a request after a quiet spell runs at once", () => {
  // Setup: work costing 20 ms at a 50% budget, run once, then nothing for a long time.
  // Test: request again after 500 ms and tick the clock by 0.
  // Verifies: the new request does not sit through another gap -- the gap exists only to stop
  // back-to-back runs crowding the page out, and the wait has already passed -- so a click or a
  // slider nudge after an idle page redraws immediately.
  const clock = fakeClock();
  const { handle, runs } = task(clock, 20, { budget: 0.5 });

  handle.request();
  clock.tick(1);
  assertEqual(runs.length, 1, "the first run");

  clock.tick(500);
  handle.request();
  clock.tick(0);

  assertEqual(runs.length, 2, "the second ran with no extra wait");
});

Deno.test("a hidden tab is not drawn to, and the request survives until it is shown", () => {
  // Setup: a task that is paused (the tab is hidden), asked for once.
  // Test: tick well past several gaps, then unpause and tick again.
  // Verifies: nothing runs while paused, so a hidden tab costs nothing; the request is still
  // pending and runs once the tab is back, so the picture is up to date when it is looked at.
  const clock = fakeClock();
  let hidden = true;
  const { handle, runs } = task(clock, 20, { paused: () => hidden, maxGap: 100 });

  handle.request();
  clock.tick(1000);
  assertEqual(runs.length, 0, "nothing ran while hidden");

  hidden = false;
  clock.tick(200);
  assertEqual(runs.length, 1, "it ran once shown");
});

/**
 * A budgeted task standing in for the renderer: `run` costs almost nothing, because `app.render`
 * only *submits* a pass, and the pass itself finishes `gpuMs` later. `settled()` is the fence
 * poll. Each run asks for another from inside itself, which is the accumulation loop's shape.
 *
 * `outstanding` is the honest measure of the bug this guards: how many passes have been
 * submitted but not yet finished. Before the fence that number climbed without limit.
 */
function gpuTask(clock, gpuMs, options = {}) {
  const runs = [];
  let finishesAt = -Infinity;
  let outstanding = 0;
  let peakOutstanding = 0;

  const handle = budgetedTask({
    run: () => {
      runs.push(clock.now);
      // Submitting is nearly free, and the previous pass (if any) is superseded by this one.
      clock.now += 0.5;
      finishesAt = clock.now + gpuMs;
      outstanding += 1;
      peakOutstanding = Math.max(peakOutstanding, outstanding);
      handle.request();
    },
    settled: () => {
      const done = clock.now >= finishesAt;

      if (done && outstanding > 0) {
        outstanding = 0;
      }

      return done;
    },
    now: () => clock.now,
    schedule: (fn, ms) => clock.schedule(fn, ms),
    unschedule: timer => clock.unschedule(timer),
    ...options,
  });

  return { handle, runs, peak: () => peakOutstanding };
}

Deno.test("work that is not finished when it returns still gets only its budget", () => {
  // Setup: the renderer's real shape (2026-09-19, the user: "when i switch the raytracer to
  // montecarlo its extremely slow and freezes my computer"). `run` returns in 0.5 ms having only
  // SUBMITTED a pass that takes 100 ms on the GPU, and asks for the next from inside itself.
  // Test: let 4 seconds of the fake clock pass at a 50% budget.
  // Verifies: the loop is paced by when the work actually FINISHED, not by when the call
  // returned, so the 100 ms pass gets a ~100 ms gap after it and the GPU is left idle half the
  // time. Sized from the 0.5 ms submission instead, the gap would be a fifth of a millisecond
  // and the loop would submit ~8,000 passes over the same 4 seconds.
  const clock = fakeClock();
  const { handle, runs } = gpuTask(clock, 100, { budget: 0.5, maxGap: 10000 });

  handle.request();
  clock.tick(4000);

  const share = (runs.length * 100) / clock.now;

  if (Math.abs(share - 0.5) > 0.08) {
    throw new Error(`the loop took ${share.toFixed(2)} of the clock over ${runs.length} passes`);
  }
});

Deno.test("no second pass is submitted while the first is still being drawn", () => {
  // Setup: the same self-requesting GPU-bound loop, passes taking 100 ms.
  // Test: run it for 4 seconds and watch how many passes are submitted but not yet finished.
  // Verifies: never more than one. This is the freeze itself: a loop that submits faster than
  // the GPU retires fills the driver's queue, and the driver then blocks the thread doing the
  // submitting -- which is the page's own -- so the tab and the desktop compositor behind it
  // both stop. Bounding the queue to one outstanding pass is what makes that impossible,
  // whatever the budget and however slow the pass.
  const clock = fakeClock();
  const { handle, peak } = gpuTask(clock, 100, { budget: 0.9, maxGap: 10000 });

  handle.request();
  clock.tick(4000);

  assertEqual(peak(), 1, "at most one pass in flight");
});

Deno.test("a settle test that never comes true does not stop the picture for ever", () => {
  // Setup: work whose `settled()` always says no -- a lost GL context, or a driver that will not
  // honour a fence -- with a 500 ms cap on how long to keep asking.
  // Test: request a run, let the clock pass the cap, then request another.
  // Verifies: the first run is eventually closed out anyway and the second one happens, so a
  // fence that never signals costs a pause, not a dead renderer. Without the cap the task would
  // poll for ever and nothing would ever be drawn again.
  const clock = fakeClock();
  const runs = [];
  const handle = budgetedTask({
    run: () => runs.push(clock.now),
    settled: () => false,
    maxSettle: 500,
    maxGap: 100,
    now: () => clock.now,
    schedule: (fn, ms) => clock.schedule(fn, ms),
    unschedule: timer => clock.unschedule(timer),
  });

  handle.request();
  clock.tick(200);
  assertEqual(runs.length, 1, "the first run happened and is still waiting to settle");

  handle.request();
  clock.tick(2000);

  if (runs.length < 2) {
    throw new Error("the renderer never recovered from a fence that never signalled");
  }
});

Deno.test("cancel drops a pending run", () => {
  // Setup: a task asked for once and cancelled before its timer fires (what leaving a page, or
  // tearing a component down, does).
  // Test: cancel, then run the clock out.
  // Verifies: the work never runs and no timer is left behind.
  const clock = fakeClock();
  const { handle, runs } = task(clock, 20);

  handle.request();
  handle.cancel();
  clock.tick(500);

  assertEqual([runs.length, clock.pending], [0, 0], "cancelled");
});
