// The rock outline's harness page (T-0325): drives outline.js on synthetic frames (synth.js) and on
// the real fixture frames, and measures it. Loaded by outline_test.html, served over HTTP from the
// repository root by tests/harness/test_vision_outline.py, which calls window.visionTest.*.

import { createOutlineFinder } from '../../../src/web/src/lib/vision/outline.js';
import { BOARD_SPECS } from '../../../src/web/src/lib/vision/board_frame.js';
import { createSynth, lookAt, rockPlanes } from './synth.js';

/** Rocks of the synthetic cases: colour is linear albedo (opaque) or transmittance per 10 mm. */
const ROCKS = {
  opaque: { kind: 'opaque', colour: [0.32, 0.12, 0.07] },
  clear: { kind: 'clear', colour: [0.45, 0.85, 0.55] },
  grey: { kind: 'opaque', colour: [0.6, 0.6, 0.56] },
};

const synths = new Map();
const finders = new Map();

function synthFor(specName) {
  if (!synths.has(specName)) {
    synths.set(specName, createSynth(BOARD_SPECS[specName]));
  }

  return synths.get(specName);
}

function finderFor(spec, key, options) {
  if (!finders.has(key)) {
    const canvas = document.createElement('canvas');
    finders.set(key, createOutlineFinder(canvas, spec, options));
  }

  return finders.get(key);
}

/** Even-odd raster of a polygon at pixel centres, over a width x height image. */
export function rasterPolygon(polygon, width, height) {
  const out = new Uint8Array(width * height);
  const n = polygon.length;

  if (n < 3) {
    return out;
  }

  let ymin = Infinity;
  let ymax = -Infinity;

  for (const [, y] of polygon) {
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  }

  const xs = [];

  for (let j = Math.max(0, Math.floor(ymin)); j <= Math.min(height - 1, Math.ceil(ymax)); j += 1) {
    const yc = j + 0.5;
    xs.length = 0;

    for (let k = 0; k < n; k += 1) {
      const [ax, ay] = polygon[k];
      const [bx, by] = polygon[(k + 1) % n];

      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
        xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
      }
    }

    xs.sort((a, b) => a - b);

    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const i1 = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));

      for (let i = i0; i <= i1; i += 1) {
        out[j * width + i] = 1;
      }
    }
  }

  return out;
}

/** IoU and error areas of a found mask against a truth mask (same size). */
function compare(found, truth) {
  let inter = 0;
  let fp = 0;
  let fn = 0;
  let t = 0;

  for (let k = 0; k < found.length; k += 1) {
    const a = found[k];
    const b = truth[k];
    t += b;

    if (a && b) inter += 1;
    else if (a) fp += 1;
    else if (b) fn += 1;
  }

  const union = inter + fp + fn;
  return { iou: union ? inter / union : 1, truthPx: t, foundPx: inter + fp, fpPx: fp, fnPx: fn };
}

/** The camera of a synthetic case, as a CameraPose. */
function syntheticPose(c) {
  const spec = BOARD_SPECS[c.spec];
  const [X, Y] = spec.target.centre_mm;
  const cam = lookAt([X, Y, c.lookHeightMm ?? 4], c.distanceMm, c.elevation, c.azimuth, c.roll ?? 0);
  return {
    frame: { width: c.width, height: c.height, timeMs: 0 },
    intrinsics: { width: c.width, height: c.height, f: c.f, cx: c.width / 2, cy: c.height / 2, k1: c.k1 ?? 0, source: 'table' },
    R: cam.R,
    t: cam.t,
    center: cam.center,
    valid: true,
  };
}

/**
 * One synthetic case: render the frame, find the outline, compare it with the truth.
 * c: { spec, rock ('opaque' | 'clear' | 'grey' | null), elevation, azimuth, roll, distanceMm, f,
 *      width, height, k1, aperture, light, ambient, samples, noise, seed, finder: options,
 *      truthPose: overrides of the pose given to the finder (a pose error) }
 */
async function synthCase(c) {
  const spec = BOARD_SPECS[c.spec];
  const pose = syntheticPose(c);
  const [X, Y] = spec.target.centre_mm;
  const rock = c.rock ? { ...ROCKS[c.rock], planes: rockPlanes({ centre: [X + (c.rockOffset?.[0] ?? 0), Y + (c.rockOffset?.[1] ?? 0)], axes: c.axes ?? [8, 6.5, 5.5], zc: c.zc ?? 4, turnDeg: c.turn ?? 25, seed: c.seed ?? 1 }) } : null;
  const focus = (() => {
    const p = [X, Y, 4];
    const R = pose.R;
    return R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + pose.t[2];
  })();
  const frame = synthFor(c.spec).render({
    width: c.width,
    height: c.height,
    f: c.f,
    k1: c.k1 ?? 0,
    pose: { R: pose.R, center: pose.center },
    aperture: c.aperture ?? 3.4,
    focusMm: c.focusMm ?? focus,
    samples: c.samples ?? 36,
    rock,
    light: c.light,
    lightSpread: c.lightSpread,
    ambient: c.ambient,
    noise: c.noise,
    seed: c.seed ?? 1,
  });
  const truth = new Uint8Array(c.width * c.height);

  for (let k = 0; k < truth.length; k += 1) {
    truth[k] = frame.rgba[4 * k + 3] >= 128 ? 1 : 0;
    frame.rgba[4 * k + 3] = 255;
  }

  const options = c.finder ?? {};
  const finder = finderFor(spec, `${c.spec}:${JSON.stringify(options)}`, options);
  const findPose = c.poseError ? perturb(pose, c.poseError) : pose;
  const outline = finder.find({ data: frame.rgba, width: c.width, height: c.height }, findPose);
  const found = rasterPolygon(outline.contour, c.width, c.height);
  const m = compare(found, truth);
  return {
    ...m,
    flags: outline.flags,
    confidence: outline.confidence,
    elapsedMs: outline.elapsedMs,
    contourPoints: outline.contour.length,
    crop: outline.crop,
  };
}

/** The pose turned by `deg` degrees about the camera's own y axis, shifted, and with its focal
 * length scaled (a pose error). */
function perturb(pose, { deg = 0, shiftMm = [0, 0, 0], fScale = 1 }) {
  const a = (deg * Math.PI) / 180;
  const Ry = [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
  const R = pose.R;
  const mul = (A, B) => {
    const out = new Array(9).fill(0);

    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        for (let k = 0; k < 3; k += 1) {
          out[3 * i + j] += A[3 * i + k] * B[3 * k + j];
        }
      }
    }

    return out;
  };
  const t = pose.t;
  const tr = [
    Ry[0] * t[0] + Ry[1] * t[1] + Ry[2] * t[2] + shiftMm[0],
    Ry[3] * t[0] + Ry[4] * t[1] + Ry[5] * t[2] + shiftMm[1],
    Ry[6] * t[0] + Ry[7] * t[1] + Ry[8] * t[2] + shiftMm[2],
  ];
  return { ...pose, R: mul(Ry, R), t: tr, intrinsics: { ...pose.intrinsics, f: pose.intrinsics.f * fScale } };
}

async function loadImage(url) {
  const blob = await (await fetch(url)).blob();
  return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}

/**
 * One real fixture frame: the crop of a capture's frame placed back in a frame of the pose's size,
 * the outline found, and compared with the desktop pipeline's mask over the same crop.
 */
/** Every fixture frame of a manifest (realCase each), with the manifest's labels. */
async function realAll(dir, options = {}) {
  const manifest = await (await fetch(`${dir}/manifest.json`)).json();
  const out = [];

  for (const fx of manifest.frames) {
    const r = await realCase(dir, fx, options);
    out.push({ capture: fx.capture, index: fx.index, elevationDeg: fx.elevationDeg, ...r });
  }

  return out;
}

/** A fixture frame with the outline (green) and the desktop's mask outline (red), as a PNG. */
async function realPicture(dir, index, options = {}) {
  const manifest = await (await fetch(`${dir}/manifest.json`)).json();
  const fx = manifest.frames[index];
  const img = await loadImage(`${dir}/${fx.image}`);
  const { width, height } = fx.pose.intrinsics;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, fx.offset[0], fx.offset[1]);
  const frame = ctx.getImageData(0, 0, width, height);
  const finder = finderFor(fx.spec, `real:${fx.capture}:${JSON.stringify(options)}:debug`, { ...options, debug: true, debugMaps: true });
  const outline = finder.find({ data: frame.data, width, height }, fx.pose, { boundCentreMm: fx.boundCentreMm });
  const maskImg = await loadImage(`${dir}/${fx.mask}`);
  ctx.globalAlpha = 0.35;
  ctx.drawImage(maskImg, fx.offset[0], fx.offset[1]);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#00ff00';
  ctx.beginPath();
  outline.contour.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  return { frame: await dataUrl(canvas), debug: await debugPicture(finder.lastDebug), stats: debugStats(finder.lastDebug) };
}

async function realCase(dir, fx, options = {}) {
  const [img, maskImg] = await Promise.all([loadImage(`${dir}/${fx.image}`), loadImage(`${dir}/${fx.mask}`)]);
  const { width, height } = fx.pose.intrinsics;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, fx.offset[0], fx.offset[1]);
  const frame = ctx.getImageData(0, 0, width, height);
  const mc = new OffscreenCanvas(maskImg.width, maskImg.height);
  const mctx = mc.getContext('2d');
  mctx.drawImage(maskImg, 0, 0);
  const mdata = mctx.getImageData(0, 0, maskImg.width, maskImg.height).data;
  const truth = new Uint8Array(width * height);

  for (let y = 0; y < maskImg.height; y += 1) {
    for (let x = 0; x < maskImg.width; x += 1) {
      const X = x + fx.offset[0];
      const Y = y + fx.offset[1];

      if (X < width && Y < height && mdata[4 * (y * maskImg.width + x)] >= 128) {
        truth[Y * width + X] = 1;
      }
    }
  }

  const finder = finderFor(fx.spec, `real:${fx.capture}:${JSON.stringify(options)}`, options);
  const outline = finder.find({ data: frame.data, width, height }, fx.pose, { boundCentreMm: fx.boundCentreMm });
  const found = rasterPolygon(outline.contour, width, height);
  return { ...compare(found, truth), flags: outline.flags, confidence: outline.confidence, elapsedMs: outline.elapsedMs, crop: outline.crop, debug: null };
}

/**
 * Timing: `frames` find() calls on one synthetic frame at the given crop size, each re-uploading
 * the frame (as a video frame would be). Returns per-frame wall times (ms, readback included) and
 * the CPU share.
 */
async function timing(c, cropSize, frames = 60, options = {}) {
  const spec = BOARD_SPECS[c.spec];
  const pose = syntheticPose(c);
  const frame = synthFor(c.spec).render({
    width: c.width, height: c.height, f: c.f, k1: c.k1 ?? 0, pose: { R: pose.R, center: pose.center },
    aperture: 3.4, focusMm: 170, samples: 16, rock: { ...ROCKS.opaque, planes: rockPlanes({ centre: spec.target.centre_mm, axes: [8, 6.5, 5.5], zc: 4 }) },
  });
  const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(frame.rgba.buffer), c.width, c.height));
  const finder = finderFor(spec, `timing:${cropSize}:${JSON.stringify(options)}`, { cropSize, debug: true, ...options });
  const wall = [];
  const cpu = [];
  const stages = {};

  for (let i = 0; i < frames + 5; i += 1) {
    const t = performance.now();
    finder.find(bitmap, pose);
    const ms = performance.now() - t;

    if (i >= 5) {
      wall.push(ms);
      cpu.push(finder.lastDebug.cpuMs);
      const m = finder.lastDebug.marks;
      let prev = m.start;
      for (const [k, v] of Object.entries(m)) {
        if (k === 'start') continue;
        (stages[k] ??= []).push(v - prev);
        prev = v;
      }
    }
  }

  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  // GPU time per find() (the frame's upload and mipmaps included), by timer queries where the
  // context has them (EXT_disjoint_timer_query_webgl2; Chrome exposes it on this Mac's Metal
  // backend). Read back after all the frames, so the queries do not stall each other.
  const gl = finder.gl;
  const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let gpuMedianMs = null;
  let gpuMinMs = null;

  if (tq) {
    const queries = [];

    for (let i = 0; i < frames; i += 1) {
      const q = gl.createQuery();
      gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
      finder.find(bitmap, pose);
      gl.endQuery(tq.TIME_ELAPSED_EXT);
      queries.push(q);
    }

    const times = [];

    for (const q of queries) {
      for (let tries = 0; tries < 200 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); tries += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }

      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(tq.GPU_DISJOINT_EXT)) {
        times.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      }

      gl.deleteQuery(q);
    }

    if (times.length) {
      gpuMedianMs = median(times);
      gpuMinMs = Math.min(...times);
    }
  }
  const stageMedians = Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, Math.round(median(v) * 10) / 10]));
  return { cropSize, frames, gpuMedianMs, gpuMinMs, stageMedians, wallMedianMs: median(wall), wallMinMs: Math.min(...wall), cpuMedianMs: median(cpu), gpuAndReadbackMedianMs: median(wall) - median(cpu) };
}

function gpuRenderer() {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
}

/** A synthetic frame as a PNG data URL (for looking at a case), with the outline drawn on it. */
async function synthPicture(c) {
  const spec = BOARD_SPECS[c.spec];
  const pose = syntheticPose(c);
  const [X, Y] = spec.target.centre_mm;
  const rock = c.rock ? { ...ROCKS[c.rock], planes: rockPlanes({ centre: [X, Y], axes: c.axes ?? [8, 6.5, 5.5], zc: c.zc ?? 4, turnDeg: c.turn ?? 25, seed: c.seed ?? 1 }) } : null;
  const frame = synthFor(c.spec).render({ width: c.width, height: c.height, f: c.f, k1: c.k1 ?? 0, pose: { R: pose.R, center: pose.center }, aperture: c.aperture ?? 3.4, focusMm: c.focusMm ?? 170, samples: c.samples ?? 36, rock, light: c.light, ambient: c.ambient, seed: c.seed ?? 1 });
  for (let k = 0; k < c.width * c.height; k += 1) frame.rgba[4 * k + 3] = 255;
  const finder = finderFor(spec, `${c.spec}:${JSON.stringify(c.finder ?? {})}:debug`, { ...(c.finder ?? {}), debug: true, debugMaps: true });
  const outline = finder.find({ data: frame.rgba, width: c.width, height: c.height }, pose);
  const canvas = new OffscreenCanvas(c.width, c.height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba.buffer), c.width, c.height), 0, 0);
  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 1;
  ctx.beginPath();
  outline.contour.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  return { frame: await dataUrl(canvas), debug: await debugPicture(finder.lastDebug), stats: debugStats(finder.lastDebug) };
}

async function dataUrl(canvas) {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
}

/**
 * The finder's crop-resolution maps side by side: the luminance and chroma residuals (as z-scores
 * over their thresholds, x 128), the evidence E, and the masks (raw evidence red, final mask green,
 * core blue, band grey).
 */
async function debugPicture(dbg) {
  if (!dbg) {
    return null;
  }

  const N = dbg.mask.length ** 0.5;
  const panels = dbg.maps ? 5 : 3;
  const canvas = new OffscreenCanvas(panels * N, N);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(panels * N, N);
  const put = (x, y, r, g, b) => {
    const k = 4 * (y * panels * N + x);
    img.data[k] = r;
    img.data[k + 1] = g;
    img.data[k + 2] = b;
    img.data[k + 3] = 255;
  };

  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const k = y * N + x;
      const res = dbg.residuals;
      const e = Math.min(255, dbg.E[k] * 128);
      put(x, y, Math.min(255, res.lum[k] * 4), Math.min(255, res.chroma[k] * 8), res.valid[k] ? 0 : 128);
      put(N + x, y, e, e, e);
      const band = dbg.band[k] ? 60 : 0;
      put(2 * N + x, y, dbg.raw[k] ? 255 : band, dbg.mask[k] ? 255 : band, dbg.core[k] ? 255 : band);

      if (dbg.maps) {
        const f = dbg.maps.frame;
        const m = dbg.maps.model;
        put(3 * N + x, y, f[4 * k], f[4 * k + 1], f[4 * k + 2]);
        put(4 * N + x, y, 255 * m[4 * k], 255 * m[4 * k + 1], 255 * m[4 * k + 2]);
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return dataUrl(canvas);
}

/** Debugging: the noise models and residual quantiles on the band and on the rest of the board. */
function debugStats(dbg) {
  const q = (arr, sel) => {
    const v = [];
    for (let k = 0; k < arr.length; k += 1) if (sel(k)) v.push(arr[k]);
    v.sort((a, b) => a - b);
    return [0.5, 0.9, 0.99].map((p) => Math.round(10 * (v[Math.floor(p * (v.length - 1))] ?? NaN)) / 10).concat([v.length]);
  };
  const r = dbg.residuals;
  const outside = (k) => r.valid[k] && !dbg.inb[k];
  return {
    warp: dbg.maps?.warp, lumModel: dbg.lumModel, chromaModel: dbg.chromaModel, d: dbg.d, pxMm: dbg.pxMm, kappa: dbg.kappa,
    lumBand: q(r.lum, (k) => dbg.band[k]), lumOutside: q(r.lum, outside),
    chromaBand: q(r.chroma, (k) => dbg.band[k]), chromaOutside: q(r.chroma, outside),
  };
}

/** Debugging: the finder's crop maps for a fixture frame, rows y0 .. y1 - 1. */
async function probeReal(dir, index, y0, y1, options = {}) {
  await realPicture(dir, index, options);
  const fx = (await (await fetch(`${dir}/manifest.json`)).json()).frames[index];
  const dbg = finders.get(`real:${fx.capture}:${JSON.stringify(options)}:debug`).lastDebug;
  const N = dbg.mask.length ** 0.5;
  const rows = {};

  for (const [name, arr] of Object.entries(dbg.maps)) {
    rows[name] = Array.from(arr.subarray(y0 * N * 4, y1 * N * 4)).map((v) => Math.round(v * 1000) / 1000);
  }

  rows.E = Array.from(dbg.E.subarray(y0 * N, y1 * N)).map((v) => Math.round(v * 100) / 100);
  return { N, rows };
}

/** Debugging: the finder's crop maps for a synthetic case, rows y0 .. y1 - 1 (crop pixels). */
async function probeRows(c, y0, y1) {
  const spec = BOARD_SPECS[c.spec];
  const pose = syntheticPose(c);
  const [X, Y] = spec.target.centre_mm;
  const rock = c.rock ? { ...ROCKS[c.rock], planes: rockPlanes({ centre: [X, Y], axes: c.axes ?? [8, 6.5, 5.5], zc: c.zc ?? 4, turnDeg: c.turn ?? 25, seed: c.seed ?? 1 }) } : null;
  const frame = synthFor(c.spec).render({ width: c.width, height: c.height, f: c.f, k1: c.k1 ?? 0, pose: { R: pose.R, center: pose.center }, aperture: c.aperture ?? 3.4, focusMm: c.focusMm ?? 170, samples: c.samples ?? 36, rock, light: c.light, ambient: c.ambient, seed: c.seed ?? 1 });
  const finder = finderFor(spec, `${c.spec}:${JSON.stringify(c.finder ?? {})}:maps`, { ...(c.finder ?? {}), debug: true, debugMaps: true });
  finder.find({ data: frame.rgba, width: c.width, height: c.height }, pose);
  const dbg = finder.lastDebug;
  const N = dbg.mask.length ** 0.5;
  const rows = {};

  for (const [name, arr] of Object.entries(dbg.maps)) {
    rows[name] = Array.from(arr.subarray(y0 * N * 4, y1 * N * 4)).map((v) => Math.round(v * 1000) / 1000);
  }

  rows.E = Array.from(dbg.E.subarray(y0 * N, y1 * N)).map((v) => Math.round(v * 100) / 100);
  return { N, rows, lumModel: dbg.lumModel, chromaModel: dbg.chromaModel, slack: dbg.slack, shadowK: dbg.shadowK, pxMm: dbg.pxMm };
}

window.visionTest = { synthCase, realCase, realAll, realPicture, probeReal, timing, gpuRenderer, synthPicture, probeRows, rasterPolygon, BOARD_SPECS };
window.visionReady = true;
