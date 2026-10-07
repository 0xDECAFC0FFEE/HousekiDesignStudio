// The phone-vision timing page's script (T-0324), loaded by vision_timing.html in headless Chrome
// by test_vision_timing.py. It times, in a real browser engine, what the phone will run per frame
// and in the background:
//
//   - pose.solve on the real fixture frames (moissanite: 2x zoom, 10-60 corners; spinel: ~1x,
//     40-150 corners) and on synthetic full-board views (200-330 corners);
//   - the live intrinsics estimator on a 600-frame synthetic capture, with its refinement steps
//     run from setTimeout(0) between frames as on the phone: per-step times and total busy time;
//   - one calibrate.js run over 30 and over 60 views.
//
// Results go to window.__visionTiming (or window.__visionTimingError). Every timing is
// performance.now() around the call, after a warm-up pass so the JIT has compiled the code.

import { cornerPoint, BOARD_SPECS } from '../../src/web/src/lib/vision/board_frame.js';
import { calibrate } from '../../src/web/src/lib/vision/calibrate.js';
import { createIntrinsicsEstimator } from '../../src/web/src/lib/vision/intrinsics.js';
import { createPoseSolver } from '../../src/web/src/lib/vision/pose.js';
import {
  fixtureDetection, fixtureIntrinsics, lookAtPose, seededRandom, syntheticDetection,
} from '../../src/web/tests/vision_test_support.js';

const spec = BOARD_SPECS.charuco_23x17_10mm_centre1;
const K = { width: 1080, height: 1920, f: 1500, cx: 540, cy: 960, k1: -0.05, source: 'refined' };

// summary statistics, plus where in the sequence the five slowest calls were (to tell one-off
// compilation at the start from periodic pauses)
function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const slowest = times.map((t, i) => [i, Math.round(t)]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    n: sorted.length, median: at(0.5), p95: at(0.95), max: sorted.at(-1), mean: times.reduce((a, b) => a + b, 0) / times.length, slowest,
  };
}

function capture(count, seed) {
  const random = seededRandom(seed);
  const frames = [];

  for (let i = 0; i < count; i += 1) {
    const phase = i / count;
    const truth = lookAtPose(
      [spec.target.centre_mm[0] + 50 * (random() - 0.5), spec.target.centre_mm[1] + 50 * (random() - 0.5), 0],
      720 * phase, 47.5 + 27.5 * Math.sin(6 * Math.PI * phase), 290 + 90 * Math.sin(10 * Math.PI * phase + 1), 30 * (random() - 0.5),
    );
    frames.push(syntheticDetection(spec, truth, K, { noisePx: 0.5, random, dropFraction: 0.05, wrongIds: i % 7 === 3 ? 2 : 0, timeMs: 100 * i }));
  }

  return frames;
}

async function run(cv) {
  const out = { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency };
  // ?settle=ms: idle that long after opencv.js is ready before timing, to separate the browser's
  // background compilation of opencv's ~10 MB of wasm from the steady state
  const settle = Number(new URLSearchParams(location.search).get('settle') ?? 0);
  out.settleMs = settle;
  await new Promise((resolve) => setTimeout(resolve, settle));

  // pose on the real fixture frames, the phone's default solver (RANSAC retry on); moissanite again
  // at the very end, to tell a start-up transient from a property of those frames
  await timeFixturePoses(cv, out, ['moissanite', 'spinel']);
  await runRest(cv, out);
  await timeFixturePoses(cv, out, ['moissanite'], '_again_at_end');
  return out;
}

async function timeFixturePoses(cv, out, names, suffix = '') {
  for (const name of names) {
    const fixture = await (await fetch(`../../src/web/tests/fixtures/vision_pose/${name}.json`)).json();
    const solver = createPoseSolver(cv, fixture.spec);
    const intr = fixtureIntrinsics(fixture);
    const dets = fixture.frames.map((f) => fixtureDetection(fixture, f, 'all'));
    dets.forEach((d) => solver.solve(d, intr));   // warm-up
    const times = [];
    const corners = [];

    for (let round = 0; round < 5; round += 1) {
      for (const d of dets) {
        const t0 = performance.now();
        solver.solve(d, intr);
        times.push(performance.now() - t0);
        corners.push(d.corners.length);
      }
    }

    out[`pose_${name}${suffix}`] = { ...stats(times), corners: stats(corners) };
    solver.dispose();
  }
}

async function runRest(cv, out) {
  // pose on synthetic full-board views
  {
    const solver = createPoseSolver(cv, spec);
    const dets = capture(120, 3);
    dets.forEach((d) => solver.solve(d, K));
    const times = [];
    const corners = [];

    for (const d of dets) {
      const t0 = performance.now();
      solver.solve(d, K);
      times.push(performance.now() - t0);
      corners.push(d.corners.length);
    }

    out.pose_synthetic = { ...stats(times), corners: stats(corners) };
    solver.dispose();
  }

  // calibrate.js over 30 and 60 views (one full three-pass run each, after a warm-up)
  {
    const views = capture(600, 5).filter((_, i) => i % 7 !== 3).map((d) => ({
      points: d.corners.map((c) => cornerPoint(spec, c.id)),
      pixels: d.corners.map((c) => [c.x, c.y]),
    }));
    calibrate(cv, views.slice(0, 10), K, { f: 1450, k1: 0 });

    for (const n of [30, 60]) {
      const step = Math.floor(views.length / n);
      const subset = views.filter((_, i) => i % step === 0).slice(0, n);
      const t0 = performance.now();
      const c = calibrate(cv, subset, K, { f: 1450, k1: 0 });
      out[`calibrate_${n}`] = { ms: performance.now() - t0, corners: subset.reduce((s, v) => s + v.points.length, 0), f: c.f, k1: c.k1 };
    }
  }

  // the live estimator, refinement steps on setTimeout(0) between frames
  {
    const ticks = [];
    const schedule = (fn) => setTimeout(() => {
      const t0 = performance.now();
      fn();
      ticks.push(performance.now() - t0);
    }, 0);
    const estimator = createIntrinsicsEstimator(cv, spec, K, { schedule });
    const addTimes = [];
    const frames = capture(600, 7);
    const t0 = performance.now();

    for (const det of frames) {
      const a = performance.now();
      estimator.addDetection(det);
      addTimes.push(performance.now() - a);
      await new Promise((resolve) => setTimeout(resolve, 0));   // a frame boundary

      if (estimator.status().frozen) {
        break;
      }
    }

    // let a refinement still in flight finish
    while (estimator.status().refining) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const s = estimator.status();
    out.estimator = {
      frames: addTimes.length,
      wallMs: performance.now() - t0,
      addDetection: stats(addTimes),
      refineTicks: stats(ticks),
      lastRefine: s.lastRefine,
      final: estimator.current(),
    };
    estimator.dispose();
  }

  return out;
}

// opencv.js's Module has a `then` that resolves to itself: resolving a promise with it never
// settles, so the module is handed over in a wrapper
function whenReady() {
  return new Promise((resolve) => {
    const poll = () => (globalThis.cv?.Mat ? resolve({ cv: globalThis.cv }) : setTimeout(poll, 20));
    poll();
  });
}

const t0 = performance.now();
whenReady()
  .then(({ cv }) => {
    const loadMs = performance.now() - t0;
    return run(cv).then((result) => ({ ...result, opencvReadyAfterModuleMs: loadMs }));
  })
  .then((result) => {
    window.__visionTiming = result;
  })
  .catch((error) => {
    window.__visionTimingError = String(error?.stack ?? error);
  });
