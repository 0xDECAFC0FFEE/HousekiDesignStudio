/*
 * vision_latency_test.js -- how far the phone's overlay trails its camera picture, and the stages'
 * costs (T-0332): src/web/src/lib/vision/latency.js.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * Plain functions on numbers, driven with made-up clocks: which time a camera frame is given, the
 * statistics over the last few seconds, the diagnostics line's words and the message's `speed`.
 * The real phone page's numbers are tests/harness/test_scan_lag.py's.
 */

import {
  CAPTURE_SANE_MS, createLatencyStats, diagnosticsText, frameTime, quantile, speedForMessage, WINDOW_MS,
} from '../src/lib/vision/latency.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

Deno.test('frameTime: the frame capture time when believable, else the callback time', () => {
  // Setup: a video-frame callback at 10,000 ms, with metadata as browsers give it: a captureTime
  // 60 ms earlier (Chrome, camera track), none (Safari may give none), one in the future, one far in
  // the past, and NaN.
  // Test: frameTime for each.
  // Verifies: a plausible capture time is used as the frame's time ('capture'); anything else falls
  // back to the callback's own time ('callback'), so an age is never computed from a clock that
  // is not performance.now()'s.
  assertEqual(frameTime(10000, { captureTime: 9940 }), { timeMs: 9940, from: 'capture' }, 'capture time');
  assertEqual(frameTime(10000, {}), { timeMs: 10000, from: 'callback' }, 'none given');
  assertEqual(frameTime(10000, null), { timeMs: 10000, from: 'callback' }, 'no metadata');
  assertEqual(frameTime(10000, { captureTime: 10050 }).from, 'callback', 'in the future');
  assertEqual(frameTime(10000, { captureTime: 10000 - CAPTURE_SANE_MS - 1 }).from, 'callback', 'too old');
  assertEqual(frameTime(10000, { captureTime: NaN }).from, 'callback', 'NaN');
});

Deno.test('quantile: nearest rank on a sorted copy, null when empty', () => {
  // Setup: the numbers 1..11 shuffled, and an empty list.
  // Test: the median, 90th percentile, minimum and maximum.
  // Verifies: 6, 10, 1 and 11 (nearest rank), the input left unsorted, and null for no values.
  const values = [7, 3, 11, 1, 9, 5, 2, 10, 4, 8, 6];
  assertEqual([quantile(values, 0.5), quantile(values, 0.9), quantile(values, 0), quantile(values, 1)], [6, 10, 1, 11], 'quantiles');
  assertEqual(values[0], 7, 'not sorted in place');
  assertEqual(quantile([], 0.5), null, 'empty');
});

Deno.test('createLatencyStats: rates, ages and stage medians over the last few seconds', () => {
  // Setup: a phone that gets a result every 100 ms for 5 s, every other one tracked (a 3 ms
  // track) and the rest detected (25 ms), every tenth without a pose; the overlay drawn every
  // 33 ms from poses 80..119 ms old (cycling).
  // Test: the summary at the end.
  // Verifies: only the last WINDOW_MS count (the rates are ~10 results, ~9 poses and ~4.5 tracked
  // poses a second); the age's median and 90th percentile come from the draws in the window; each
  // stage's median is over the results that report it (detectMs 25 from detections only, trackMs 3
  // from tracks only); a stage nobody reports is null; the draws count is the window's; reset()
  // empties everything.
  const stats = createLatencyStats();
  let n = 0;

  for (let t = 0; t <= 5000; t += 100, n += 1) {
    const kind = n % 2 ? 'track' : 'detect';
    stats.addResult(t, { kind, posed: n % 10 !== 9, timings: kind === 'detect' ? { detectMs: 25, frameMs: 40 } : { trackMs: 3, frameMs: 6 } });
  }

  for (let t = 0, k = 0; t <= 5000; t += 33, k += 1) {
    stats.addDraw(t, 80 + (k % 40));
  }

  const s = stats.summary(5000);
  assert(Math.abs(s.resultsPerS - 10) < 0.5, `results/s ${s.resultsPerS}`);
  assert(Math.abs(s.posesPerS - 9) < 0.6, `poses/s ${s.posesPerS}`);
  assert(Math.abs(s.trackedPerS - 4.5) < 0.6, `tracked/s ${s.trackedPerS}`);
  assert(s.ageMs >= 95 && s.ageMs <= 104, `age median ${s.ageMs}`);
  assert(s.ageP90Ms >= 112 && s.ageP90Ms <= 119, `age p90 ${s.ageP90Ms}`);
  assertEqual([s.stages.detectMs, s.stages.trackMs, s.stages.outlineMs], [25, 3, null], 'stage medians');
  assert(s.draws > 80 && s.draws <= Math.ceil(WINDOW_MS / 33) + 1, `draws in the window ${s.draws}`);
  stats.reset();
  assertEqual(stats.summary(5000).resultsPerS, null, 'reset');
});

Deno.test('diagnosticsText and speedForMessage: the line a person reads, the numbers the studio gets', () => {
  // Setup: a summary as createLatencyStats gives it, with tracking and without.
  // Test: the diagnostics line, and the message's speed.
  // Verifies: the line says the poses a second (with the tracked share only when there is one), how
  // old the drawn position is when drawn (median and 90%), each stage's ms (to 0.1 ms under 10 ms; track only
  // when tracked), the work size and where the finder runs, in words ('background' for the Worker,
  // 'in the page' otherwise); the speed rounds rates to 0.1 and ages to whole ms,
  // and leaves out what is unknown (null), so the message carries no nulls.
  const summary = {
    resultsPerS: 12.34, posesPerS: 11.96, trackedPerS: 5.02, ageMs: 61.4, ageP90Ms: 98.6, draws: 90,
    stages: { detectMs: 24.6, trackMs: 3.2, poseMs: 0.6, outlineMs: 16.1, guideMs: 5.5, frameMs: 41.9 },
  };
  assertEqual(diagnosticsText(summary, { work: '960×540', thread: 'worker' }),
    '12.0 poses/s (5.0 tracked) · position 61 ms old (90%: 99) · detect 25 · track 3.2 · pose 0.6 · outline 16 · guide 5.5 · frame 42 ms · 960×540 px · background',
    'the line');
  const untracked = { ...summary, trackedPerS: 0, stages: { ...summary.stages, trackMs: null } };
  assert(!diagnosticsText(untracked).includes('track'), 'no tracking, no tracking numbers');
  assert(diagnosticsText(summary, { thread: 'main-thread' }).endsWith(' · in the page'), 'the fallback in words');
  assertEqual(speedForMessage(summary), {
    posesPerS: 12, trackedPerS: 5, resultsPerS: 12.3, ageMs: 61, ageP90Ms: 99, detectMs: 24.6, trackMs: 3.2, frameMs: 41.9,
  }, 'the speed');
  assertEqual(speedForMessage({ resultsPerS: null, posesPerS: 2, ageMs: null, stages: {} }), { posesPerS: 2 }, 'nulls left out');
});
