// Frames of a synthetic "phone video" of a rock on the printed board, for the phone vision's
// end-to-end test and the docs' screenshots (T-0326; tests/harness/vision/make_scan_video.py
// drives it). Test-only.
//
// Each frame is synth.js's ray-traced board and rock (thin-lens defocus, a soft shadow,
// vignetting, a tone curve, noise), seen from a known camera, so the phone page's pose and outline
// can be checked against the truth. Returned per frame: a JPEG (what the fake camera plays), the
// rock's true silhouette as a PNG mask (white where at least half of the pixel is rock) and the
// camera (R, t, centre, board -> camera, mm), all in the frame's own pixels (types.js convention).

import { BOARD_SPECS } from '../../../src/web/src/lib/vision/board_frame.js';
import { createSynth, lookAt, rockPlanes } from './synth.js';

const synths = new Map();

function synthFor(name) {
  if (!synths.has(name)) {
    synths.set(name, createSynth(BOARD_SPECS[name]));
  }

  return synths.get(name);
}

function toDataUrl(rgba, width, height, type, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.toDataURL(type, quality);
}

/**
 * Renders the views of a video.
 *
 * @param {object} c  { sheet, width, height, f, k1, aperture, samples, noise, quality,
 *   rock: { colour: [r, g, b] linear albedo, axes: [a, b, c] mm, zc, turnDeg, seed },
 *   views: [{ azimuth, elevation, distanceMm, roll }] (synth.js lookAt's convention: azimuth 0
 *   looks from -X towards +X) }
 * @returns {Promise<{ views: { jpeg, mask, R, t, center }[] }>}
 */
export async function renderViews(c) {
  const spec = BOARD_SPECS[c.sheet];
  const [X, Y] = spec.target.centre_mm;
  const rock = c.rock
    ? {
      kind: 'opaque',
      colour: c.rock.colour,
      planes: rockPlanes({ centre: [X, Y], axes: c.rock.axes, zc: c.rock.zc, turnDeg: c.rock.turnDeg ?? 25, seed: c.rock.seed ?? 3 }),
    }
    : null;
  const views = [];

  for (const [index, view] of c.views.entries()) {
    const cam = lookAt([X, Y, 4], view.distanceMm, view.elevation, view.azimuth, view.roll ?? 0);
    // The lens focuses on the rock: the depth of its middle.
    const focus = cam.R[6] * X + cam.R[7] * Y + cam.R[8] * 4 + cam.t[2];
    const frame = synthFor(c.sheet).render({
      width: c.width,
      height: c.height,
      f: c.f,
      k1: c.k1 ?? 0,
      pose: { R: cam.R, center: cam.center },
      aperture: c.aperture ?? 2.5,
      focusMm: focus,
      samples: c.samples ?? 24,
      rock,
      noise: c.noise ?? 1.5,
      seed: index + 1,
    });
    const mask = new Uint8ClampedArray(c.width * c.height * 4);

    for (let k = 0; k < c.width * c.height; k += 1) {
      const inside = frame.rgba[4 * k + 3] >= 128 ? 255 : 0;
      mask[4 * k] = inside;
      mask[4 * k + 1] = inside;
      mask[4 * k + 2] = inside;
      mask[4 * k + 3] = 255;
      frame.rgba[4 * k + 3] = 255;
    }

    views.push({
      jpeg: toDataUrl(new Uint8ClampedArray(frame.rgba.buffer), c.width, c.height, 'image/jpeg', c.quality ?? 0.9),
      mask: toDataUrl(mask, c.width, c.height, 'image/png'),
      R: cam.R,
      t: cam.t,
      center: cam.center,
    });
  }

  return { views };
}

/**
 * Renders arbitrary frames for a moving video (T-0331: the scan guidance's video, with a slow orbit,
 * a fast, motion-blurred swing and a defocused hold). Each frame spec is
 * { subs: [{ azimuth, elevation, distanceMm, roll, aimX?, aimY? }] (camera positions spread over the exposure,
 * averaged: motion blur; one for a still frame), samples, aperture, focusOffsetMm (added to the
 * rock's depth: the lens focused behind the rock), mask (also return the silhouette) }.
 * The camera of the middle sub is the frame's truth. Same scene and lens as renderViews.
 *
 * @returns {Promise<{ frames: { jpeg, mask?, R, t, center }[] }>}
 */
export async function renderFrames(c, specs) {
  const spec = BOARD_SPECS[c.sheet];
  const [X, Y] = spec.target.centre_mm;
  const rock = c.rock
    ? {
      kind: 'opaque',
      colour: c.rock.colour,
      planes: rockPlanes({ centre: [X, Y], axes: c.rock.axes, zc: c.rock.zc, turnDeg: c.rock.turnDeg ?? 25, seed: c.rock.seed ?? 3 }),
    }
    : null;
  const frames = [];
  const n = c.width * c.height;

  for (const [index, frameSpec] of specs.entries()) {
    const sum = new Float32Array(n * 4);
    let truthMask = null;
    const middle = frameSpec.subs[frameSpec.subs.length >> 1];
    // aimX / aimY (T-0332, optional): the camera aims this far (mm) from the rock, i.e. the phone
    // slides sideways over the board instead of orbiting the rock.
    const cams = frameSpec.subs.map((s) => lookAt([X + (s.aimX ?? 0), Y + (s.aimY ?? 0), 4], s.distanceMm, s.elevation, s.azimuth, s.roll ?? 0));

    for (const [k, cam] of cams.entries()) {
      const focus = cam.R[6] * X + cam.R[7] * Y + cam.R[8] * 4 + cam.t[2] + (frameSpec.focusOffsetMm ?? 0);
      const frame = synthFor(c.sheet).render({
        width: c.width,
        height: c.height,
        f: c.f,
        k1: c.k1 ?? 0,
        pose: { R: cam.R, center: cam.center },
        aperture: frameSpec.aperture ?? c.aperture ?? 2.5,
        focusMm: focus,
        samples: frameSpec.samples ?? c.samples ?? 24,
        rock,
        noise: (c.noise ?? 1.5) / Math.sqrt(cams.length),
        seed: (frameSpec.seed ?? index + 1) * 31 + k,
      });

      for (let i = 0; i < n * 4; i += 1) {
        sum[i] += frame.rgba[i];
      }

      if (frameSpec.subs[k] === middle) {
        truthMask = frame.rgba;
      }
    }

    const rgba = new Uint8ClampedArray(n * 4);
    const mask = frameSpec.mask ? new Uint8ClampedArray(n * 4) : null;

    for (let i = 0; i < n; i += 1) {
      for (let ch = 0; ch < 3; ch += 1) {
        rgba[4 * i + ch] = Math.round(sum[4 * i + ch] / cams.length);
      }

      rgba[4 * i + 3] = 255;

      if (mask) {
        const inside = truthMask[4 * i + 3] >= 128 ? 255 : 0;
        mask[4 * i] = mask[4 * i + 1] = mask[4 * i + 2] = inside;
        mask[4 * i + 3] = 255;
      }
    }

    const cam = cams[frameSpec.subs.indexOf(middle)];
    frames.push({
      jpeg: toDataUrl(rgba, c.width, c.height, 'image/jpeg', c.quality ?? 0.9),
      ...(mask ? { mask: toDataUrl(mask, c.width, c.height, 'image/png') } : {}),
      R: cam.R,
      t: cam.t,
      center: cam.center,
    });
  }

  return { frames };
}

window.scanVideo = { renderViews, renderFrames };
window.scanVideoReady = true;
