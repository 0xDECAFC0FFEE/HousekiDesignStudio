// How far behind the camera picture the phone's overlay is, and what each stage of the vision costs
// (T-0332). The user, 2026-10-06: "its still too slow" ... "the overlay is lagging".
//
// The overlay is drawn on every camera frame the phone shows, from the latest vision result. That
// result's pose belongs to an EARLIER frame: the one the Worker was handed, a whole processing time
// (plus the wait for the next slot) ago. So for every drawn frame, the pose's AGE is
//
//   age = time of the frame on screen - time of the frame the pose was measured on
//
// both read the same way (frameTime below), so what the camera pipeline adds before either frame
// reaches the page cancels out: the age is exactly how far the overlay trails the picture it is
// drawn on. The page keeps the last few seconds of ages and of the Worker's per-stage timings here,
// shows them on its hidden diagnostics line (long-press the status at the bottom of the phone's
// screen) and sends a summary to the studio (scan_vision.js's optional `speed`).
//
// Plain JS, no DOM and no clock of its own: every time is passed in, so the Deno tests drive it.

/** How much history the summary covers, ms. */
export const WINDOW_MS = 3000;

/** A frame's captureTime further than this from the callback's clock is not believed (ms). */
export const CAPTURE_SANE_MS = 1000;

/**
 * The time of a camera frame, from requestVideoFrameCallback's (now, metadata): the frame's
 * `captureTime` (when the camera took it; Chrome gives it for camera tracks) when it is present and
 * plausible (finite, within CAPTURE_SANE_MS before the callback and not after it), else the
 * callback's own time. Every frame of one stream should come out of the same branch, so ages
 * (differences) are consistent either way. Returns { timeMs, from: 'capture' | 'callback' }.
 *
 * @param {number} nowMs  the callback's performance.now()
 * @param {object|null} [metadata]  VideoFrameCallbackMetadata
 */
export function frameTime(nowMs, metadata = null) {
  const capture = metadata?.captureTime;

  if (typeof capture === 'number' && Number.isFinite(capture) && capture <= nowMs + 1 && nowMs - capture <= CAPTURE_SANE_MS) {
    return { timeMs: capture, from: 'capture' };
  }

  return { timeMs: nowMs, from: 'callback' };
}

/** The q-quantile (0..1) of an array of numbers (nearest rank, on a sorted copy); null if empty. */
export function quantile(values, q) {
  if (!values.length) {
    return null;
  }

  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/** The per-stage timings the summary reports (medians), in this order. */
export const STAGES = Object.freeze(['detectMs', 'trackMs', 'poseMs', 'outlineMs', 'guideMs', 'frameMs']);

/**
 * The phone's latency statistics over the last `windowMs`.
 *
 *   addResult(atMs, { kind: 'detect' | 'track', posed, timings })   a result arrived from the Worker
 *   addDraw(atMs, ageMs)          an overlay was drawn from a pose `ageMs` old (null: none drawn)
 *   summary(nowMs) -> { resultsPerS, posesPerS, trackedPerS, ageMs, ageP90Ms, draws,
 *                       stages: { detectMs, trackMs, ... } (medians, null when none) }
 */
export function createLatencyStats({ windowMs = WINDOW_MS } = {}) {
  let results = [];
  let draws = [];

  const prune = (list, nowMs) => {
    let k = 0;

    while (k < list.length && list[k].at < nowMs - windowMs) {
      k += 1;
    }

    return k ? list.slice(k) : list;
  };

  return {
    addResult(atMs, { kind = 'detect', posed = false, timings = {} } = {}) {
      results.push({ at: atMs, kind, posed, timings });
      results = prune(results, atMs);
    },
    addDraw(atMs, ageMs) {
      if (ageMs !== null && Number.isFinite(ageMs)) {
        draws.push({ at: atMs, age: ageMs });
        draws = prune(draws, atMs);
      }
    },
    summary(nowMs) {
      results = prune(results, nowMs);
      draws = prune(draws, nowMs);
      // The rate over the window actually covered (from the first result kept), so the first
      // seconds do not read low.
      const span = (list) => (list.length > 1 ? Math.max(1, nowMs - list[0].at) / 1000 : null);
      const perS = (list, keep) => {
        const s = span(list);
        return s === null ? null : list.filter(keep).length / s;
      };
      const ages = draws.map((d) => d.age);
      const stages = {};

      for (const name of STAGES) {
        stages[name] = quantile(results.map((r) => r.timings[name]).filter((v) => typeof v === 'number' && Number.isFinite(v)), 0.5);
      }

      return {
        resultsPerS: perS(results, () => true),
        posesPerS: perS(results, (r) => r.posed),
        trackedPerS: perS(results, (r) => r.kind === 'track' && r.posed),
        ageMs: quantile(ages, 0.5),
        ageP90Ms: quantile(ages, 0.9),
        draws: draws.length,
        stages,
      };
    },
    reset() {
      results = [];
      draws = [];
    },
  };
}

const ms = (v) => (v === null || v === undefined ? '–' : `${Math.round(v)}`);
// A stage's ms: one decimal under 10 (a 0.5 ms pose would read "0" otherwise).
const stageMs = (v) => (v === null || v === undefined ? '–' : v < 10 ? v.toFixed(1) : `${Math.round(v)}`);
const rate = (v) => (v === null || v === undefined ? '–' : v.toFixed(1));

/**
 * The phone's diagnostics line for a summary: what a person reading their own phone's numbers
 * needs, in one line. `extra` adds { work: 'W x H', thread: 'worker' | 'main-thread' }.
 *
 *   "9.6 poses/s (4.1 tracked) · position 120 ms old (90%: 180) · detect 27 · track 3.2 · pose 0.6 ·
 *    outline 14 · guide 5.5 · frame 41 ms · 960×540 px · background"   (stages under 10 ms to 0.1 ms)
 */
export function diagnosticsText(summary, extra = {}) {
  const s = summary.stages ?? {};
  const parts = [
    `${rate(summary.posesPerS)} poses/s${summary.trackedPerS ? ` (${rate(summary.trackedPerS)} tracked)` : ''}`,
    `position ${ms(summary.ageMs)} ms old (90%: ${ms(summary.ageP90Ms)})`,
    `detect ${stageMs(s.detectMs)}${s.trackMs !== null && s.trackMs !== undefined ? ` · track ${stageMs(s.trackMs)}` : ''} · pose ${stageMs(s.poseMs)}`
      + ` · outline ${stageMs(s.outlineMs)} · guide ${stageMs(s.guideMs)} · frame ${stageMs(s.frameMs)} ms`,
  ];

  if (extra.work || extra.thread) {
    // Where the finder runs, in words: beside the page (a Worker) or in it (the fallback).
    const where = extra.thread ? (extra.thread === 'worker' ? 'background' : 'in the page') : null;
    parts.push([extra.work ? `${extra.work} px` : null, where].filter(Boolean).join(' · '));
  }

  return parts.join(' · ');
}

/**
 * A summary as the vision message's optional `speed` (scan_vision.js): rounded numbers, nulls left
 * out. { posesPerS, trackedPerS, resultsPerS, ageMs, ageP90Ms, detectMs, trackMs, frameMs }.
 */
export function speedForMessage(summary) {
  const out = {};
  const put = (key, value, digits = 0) => {
    if (value !== null && value !== undefined && Number.isFinite(value)) {
      const k = 10 ** digits;
      out[key] = Math.round(value * k) / k;
    }
  };

  put('posesPerS', summary.posesPerS, 1);
  put('trackedPerS', summary.trackedPerS, 1);
  put('resultsPerS', summary.resultsPerS, 1);
  put('ageMs', summary.ageMs);
  put('ageP90Ms', summary.ageP90Ms);
  put('detectMs', summary.stages?.detectMs, 1);
  put('trackMs', summary.stages?.trackMs, 1);
  put('frameMs', summary.stages?.frameMs, 1);
  return out;
}
