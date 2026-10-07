// Replays a logged phone run of the overlay-lag video through overlay filters, offline (T-0332).
//
// tests/harness/test_scan_lag.py logs every vision result the phone page got (its raw pose, the
// time of its frame and when it arrived) and every frame the page drew (when, the time of the frame
// on screen and its stamp). This feeds those results, in arrival order, to an overlay filter and
// "draws" each logged frame with what the filter would have given at that moment, then measures the
// drawn board against the video's truth for the frame on screen, as test_scan_lag.py does. So
// filters and their constants can be compared on the same real stream of poses in a second:
//
//   deno run --allow-read tests/harness/vision/replay_lag.js [run_log.json] [truth.json] [--sweep]
//
// (defaults: tests/output/scan_lag_video/last_run_log.json and truth.json). Modes: raw (the latest
// pose as it is), smooth (the exponential smoother used before T-0332), filter (pose_filter.js, not
// carried forward), predict (pose_filter.js carried to the frame on screen: what the page draws).

import { createPoseSmoother } from '../../../src/web/src/lib/vision/pose.js';
import { createPoseFilter, translationFrom } from '../../../src/web/src/lib/vision/pose_filter.js';
import { cameraCenter, matMul3, projectPoints, rodrigues } from '../../../src/web/src/lib/vision/camera_model.js';

const HELD = ['still', 'rest'];
const MOVING = ['orbit', 'slide', 'back', 'swing'];
const SETTLE_S = 1.0;
const CENTRE = [85, 115, 0];
const GRID = [];

for (let x = 5; x < 170; x += 20) {
  for (let y = 5; y < 230; y += 20) {
    GRID.push([x, y, 0]);
  }
}

const quantile = (values, q) => {
  if (!values.length) {
    return null;
  }

  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

const spread = (pts) => {
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return Math.sqrt(pts.reduce((a, p) => a + (p[0] - mx) ** 2 + (p[1] - my) ** 2, 0) / pts.length);
};

/** A drawer per mode: feed(result) for each arriving result, pose(frameTimeMs) for each draw. */
export function makeMode(mode, options = {}) {
  if (mode === 'raw') {
    let last = null;
    return { feed: (p) => { last = p; }, pose: () => last };
  }

  if (mode === 'smooth') {
    const smoother = createPoseSmoother({ target: { centre_mm: [80, 110] } });
    let last = null;
    return { feed: (p) => { last = smoother.update(p); }, pose: () => last };
  }

  const filter = createPoseFilter(options);
  return {
    feed: (p) => filter.update(p),
    pose: (timeMs) => (mode === 'predict' ? filter.predict(timeMs) : filter.current()),
  };
}

/** A seeded normal deviate generator (mulberry32 + Box-Muller). */
function gaussian(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

/**
 * The logged poses with pose noise added, as a real phone's frames would give (the synthetic frames
 * are nearly noise-free): each rotation turned by a random small angle (rotDeg per axis, s.d.) and
 * each camera centre moved by cMm per axis (s.d.).
 */
export function noisy(results, rotDeg, cMm, seed = 1) {
  const n = gaussian(seed);
  const k = (rotDeg * Math.PI) / 180;

  return results.map((r) => {
    if (!r.R) {
      return r;
    }

    const R = matMul3(rodrigues([k * n(), k * n(), k * n()]), r.R);
    const c = cameraCenter(r.R, r.t).map((v) => v + cMm * n());
    return { ...r, R, t: translationFrom(R, c) };
  });
}

/** Replays one mode; returns test_scan_lag.py's summary (per segment and overall). */
export function replay(log, truth, mode, options = {}) {
  const drawer = makeMode(mode, options);
  const results = log.results.filter((r) => r.valid && r.R && r.lens);
  const lensOf = (r) => ({ ...r.lens, width: truth.width, height: truth.height });
  const trueLens = { f: truth.f, cx: truth.width / 2, cy: truth.height / 2, k1: truth.k1 };
  let k = 0;
  const entries = [];

  for (const draw of log.draws) {
    while (k < results.length && results[k].at <= draw.at) {
      const r = results[k];
      drawer.feed({ R: r.R, t: r.t, frame: { timeMs: r.frameTimeMs, width: truth.width, height: truth.height }, intrinsics: lensOf(r), valid: true, center: cameraCenter(r.R, r.t) });
      k += 1;
    }

    if (draw.stamp === null || draw.stamp >= truth.frames.length) {
      continue;
    }

    const f = truth.frames[draw.stamp];
    const pose = drawer.pose(draw.frameTimeMs);
    const entry = { at: draw.at, segment: f.segment, stamp: draw.stamp };

    if (pose) {
      const lens = pose.intrinsics;
      const drawn = projectPoints([CENTRE, ...GRID], pose.R, pose.t, lens);
      const real = projectPoints([CENTRE, ...GRID], f.R, f.t, trueLens);
      entry.origin = [drawn[0], drawn[1]];
      entry.error = Math.hypot(drawn[0] - real[0], drawn[1] - real[1]);
      const gaps = [];
      entry.grid = [];

      for (let i = 1; i <= GRID.length; i += 1) {
        const inside = real[2 * i] >= 0 && real[2 * i] < truth.width && real[2 * i + 1] >= 0 && real[2 * i + 1] < truth.height;
        entry.grid.push(inside ? [drawn[2 * i], drawn[2 * i + 1]] : null);

        if (inside) {
          gaps.push(Math.hypot(drawn[2 * i] - real[2 * i], drawn[2 * i + 1] - real[2 * i + 1]));
        }
      }

      entry.gridError = quantile(gaps, 0.5);
    }

    entries.push(entry);
  }

  let runStart = 0;
  let run = 0;

  entries.forEach((e, i) => {
    if (i === 0 || e.segment !== entries[i - 1].segment) {
      runStart = e.at;
      run += 1;
    }

    e.run = run;
    e.intoS = (e.at - runStart) / 1000;
  });

  const out = { mode, segments: {} };

  for (const name of truth.segments.map((s) => s.name)) {
    const seg = entries.filter((e) => e.segment === name && e.error !== undefined);
    const stats = {
      centre: quantile(seg.map((e) => e.error), 0.5),
      grid: quantile(seg.map((e) => e.gridError).filter((v) => v !== null), 0.5),
      gridP90: quantile(seg.map((e) => e.gridError).filter((v) => v !== null), 0.9),
    };

    if (HELD.includes(name)) {
      const shimmer = [];

      for (const r of new Set(seg.map((e) => e.run))) {
        const settled = seg.filter((e) => e.run === r && e.intoS >= SETTLE_S);

        if (settled.length >= 10) {
          const perPoint = GRID.map((_, i) => settled.map((e) => e.grid[i]).filter(Boolean)).filter((pts) => pts.length === settled.length);
          shimmer.push(quantile(perPoint.map(spread), 0.5));
        }
      }

      stats.shimmer = quantile(shimmer, 0.5);
    }

    out.segments[name] = stats;
  }

  const moving = entries.filter((e) => MOVING.includes(e.segment) && e.gridError !== undefined && e.gridError !== null);
  out.movingGrid = quantile(moving.map((e) => e.gridError), 0.5);
  out.movingGridP90 = quantile(moving.map((e) => e.gridError), 0.9);
  out.movingCentre = quantile(moving.map((e) => e.error), 0.5);
  out.stillShimmer = quantile(HELD.map((n) => out.segments[n].shimmer).filter((v) => v !== null && v !== undefined), 0.5);
  return out;
}

const fmt = (v) => (v === null || v === undefined ? '  -  ' : v.toFixed(2).padStart(6));

function line(r, label = r.mode) {
  const s = r.segments;
  return `${label.padEnd(28)} moving grid ${fmt(r.movingGrid)} p90 ${fmt(r.movingGridP90)} centre ${fmt(r.movingCentre)} | `
    + `orbit ${fmt(s.orbit.grid)} slide ${fmt(s.slide.grid)} back ${fmt(s.back.grid)} swing ${fmt(s.swing.grid)} | `
    + `still ${fmt(s.still.grid)} rest ${fmt(s.rest.grid)} shimmer ${fmt(r.stillShimmer)}`;
}

if (import.meta.main) {
  const args = Deno.args.filter((a) => !a.startsWith('--'));
  const root = new URL('../../output/scan_lag_video/', import.meta.url);
  const clean = JSON.parse(await Deno.readTextFile(args[0] ?? new URL('last_run_log.json', root)));
  const truth = JSON.parse(await Deno.readTextFile(args[1] ?? new URL('truth.json', root)));
  // --noise=ROT_DEG,C_MM adds pose noise (see noisy()); the default leaves the poses as logged.
  const noiseArg = Deno.args.find((a) => a.startsWith('--noise='));
  const [rotDeg, cMm] = noiseArg ? noiseArg.slice(8).split(',').map(Number) : [0, 0];
  const log = rotDeg || cMm ? { ...clean, results: noisy(clean.results, rotDeg, cMm) } : clean;
  console.log(`${log.draws.length} draws, ${log.results.length} results; pose noise ${rotDeg} deg, ${cMm} mm`);

  for (const mode of ['raw', 'smooth', 'filter', 'predict']) {
    console.log(line(replay(log, truth, mode)));
  }

  if (Deno.args.includes('--sweep')) {
    for (const alphaMin of [0.25, 0.35, 0.5]) {
      for (const betaScale of [1, 0.5]) {
        for (const deadband of [true, false]) {
          const options = { alphaMin, betaScale, deadband };
          console.log(line(replay(log, truth, 'predict', options), `a${alphaMin} b${betaScale} d${deadband ? 1 : 0}`));
        }
      }
    }
  }
}
