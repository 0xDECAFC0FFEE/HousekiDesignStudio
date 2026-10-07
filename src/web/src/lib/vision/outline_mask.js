// The CPU half of the rock outline (T-0325): from the GPU's per-pixel residuals over the small crop
// to the rock's mask and outline. Everything here works on the crop (256 x 256 by default), so it
// is plain loops over typed arrays.
//
// The steps are the HousekiScanner desktop pipeline's (src/houseki/pipeline/segment.py), ported:
//
// 1. noise calibration (`noiseModel`, segment.noise_model): the residuals' spread on the board,
//    measured on a band just outside the rock's bound, as a floor for ink, a floor for paper and a
//    term in the prediction's gradient (90% quantiles);
// 2. evidence (`evidenceMap`, segment.frame_cues + evidence): z-scores of the luminance and chroma
//    residuals against that noise, E = max(z_lum / 5, z_chroma / 4); E > 1 is rock;
// 3. the mask (`maskFromEvidence`, segment.mask_from_evidence): a 3 x 3 median on the threshold,
//    components reaching the core kept, gaps closed, holes filled, components reaching the core
//    kept again;
// 4. the outline (`traceOutline`): the outer boundary of the largest component, clockwise on
//    screen, through the midpoints of the pixel edges between rock and board.
//
// Where the desktop's choices did not carry over, the comment at that step says why.

/** z-score thresholds of the two cues (segment.T_LUM, T_CHROMA; tuned there on the moissanite). */
export const T_LUM = 5.0;
export const T_CHROMA = 4.0;

/** Noise floors (segment.frame_cues: grey levels for luminance, CIELAB units for chroma). */
export const FLOOR_LUM = 2.0;
export const FLOOR_CHROMA = 1.0;

/** The companding the GPU packs residuals with: byte q stands for (q / 16)^2. */
export function expand(q) {
  const s = q / 16;
  return s * s;
}

const EXPAND = new Float32Array(256).map((_, q) => expand(q));

/**
 * The GPU's readback (RGBA8, size x size): residuals and the prediction's level per crop pixel.
 * Returns { lum, chroma, grad, level, valid } (Float32Array / Uint8Array of size * size): lum
 * (grey levels outside the shadow-and-slack allowance, smoothed), chroma (CIELAB a-b distance),
 * grad (the prediction's gradient, grey levels per crop pixel), level (the predicted albedo, 0 ink
 * .. 1 paper) and valid (1 where the board is modelled and the frame covers the pixel).
 */
export function decodeResiduals(bytes, size) {
  const n = size * size;
  const lum = new Float32Array(n);
  const chroma = new Float32Array(n);
  const grad = new Float32Array(n);
  const level = new Float32Array(n);
  const valid = new Uint8Array(n);

  for (let k = 0; k < n; k += 1) {
    const a = bytes[4 * k + 3];

    if (a === 255) {
      continue;
    }

    lum[k] = EXPAND[bytes[4 * k]];
    chroma[k] = EXPAND[bytes[4 * k + 1]];
    grad[k] = EXPAND[bytes[4 * k + 2]];
    level[k] = a / 254;
    valid[k] = 1;
  }

  return { lum, chroma, grad, level, valid };
}

/** The q-quantile of a sorted array, linear between order statistics (numpy's default). */
export function quantileSorted(sorted, q) {
  const n = sorted.length;

  if (n === 0) {
    return NaN;
  }

  const pos = (n - 1) * q;
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < n ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}

/**
 * A residual's spread on the board, measured over the band pixels (segment.noise_model): the
 * q-quantile of r modelled as q(r)^2 = c0(level) + c1 grad^2, the edge term c1 fitted over ten
 * gradient bins, the floor c0 measured separately on flat dark (level < 0.35) and flat bright
 * (level > 0.65) pixels (the ink of the sheets can have a grainy sheen the paper does not). Floors
 * are at least floor^2. Returns { c0Dark, c0Bright, c1 } in q-quantile units squared.
 *
 * @param {Float32Array} r  the residual per pixel
 * @param {Float32Array} grad
 * @param {Float32Array} level
 * @param {Uint8Array} band  1 on the pixels to measure
 * @param {number} maxSamples  band pixels used at most (evenly strided)
 */
export function noiseModel(r, grad, level, band, floor, q = 0.9, maxSamples = 4000) {
  let total = 0;

  for (let k = 0; k < band.length; k += 1) {
    total += band[k] ? 1 : 0;
  }

  const out = { c0Dark: floor * floor, c0Bright: floor * floor, c1: 0, samples: total };

  if (total < 500) {
    return out;
  }

  // At most maxSamples evenly spread band pixels (quantiles need no more; the desktop caps its
  // defocus samples the same way).
  const stride = Math.ceil(total / maxSamples);
  const n = Math.ceil(total / stride);
  const g = new Float64Array(n);
  const v = new Float64Array(n);
  const lv = new Float64Array(n);

  for (let k = 0, seen = 0, i = 0; k < band.length && i < n; k += 1) {
    if (band[k]) {
      if (seen % stride === 0) {
        g[i] = grad[k];
        v[i] = r[k];
        lv[i] = level[k];
        i += 1;
      }

      seen += 1;
    }
  }

  const gSorted = g.slice().sort();
  const edges = [];

  for (let i = 0; i <= 10; i += 1) {
    const e = quantileSorted(gSorted, i / 10);

    if (!edges.length || e !== edges[edges.length - 1]) {
      edges.push(e);
    }
  }

  // Each pixel's gradient bin(s): numpy's (g >= lo) & (g <= hi) puts a value on a shared edge in
  // both neighbouring bins, and so does this.
  const nb = edges.length - 1;
  const binG = Array.from({ length: nb }, () => new Float64Array(n));
  const binV = Array.from({ length: nb }, () => new Float64Array(n));
  const counts = new Int32Array(nb);

  for (let i = 0; i < n; i += 1) {
    for (let b = 0; b < nb; b += 1) {
      if (g[i] >= edges[b] && g[i] <= edges[b + 1]) {
        binG[b][counts[b]] = g[i];
        binV[b][counts[b]] = v[i];
        counts[b] += 1;
      } else if (g[i] < edges[b]) {
        break;
      }
    }
  }

  const xs = [];
  const ys = [];

  for (let b = 0; b < nb; b += 1) {
    if (counts[b] >= 50) {
      xs.push(quantileSorted(binG[b].subarray(0, counts[b]).sort(), 0.5) ** 2);
      ys.push(quantileSorted(binV[b].subarray(0, counts[b]).sort(), q) ** 2);
    }
  }

  let c0 = 0;
  let c1 = 0;

  if (xs.length >= 2) {
    // Least squares fit of ys = c0 + c1 xs.
    const m = xs.length;
    const mx = xs.reduce((a, c) => a + c, 0) / m;
    const my = ys.reduce((a, c) => a + c, 0) / m;
    let sxx = 0;
    let sxy = 0;

    for (let i = 0; i < m; i += 1) {
      sxx += (xs[i] - mx) ** 2;
      sxy += (xs[i] - mx) * (ys[i] - my);
    }

    c1 = sxx > 0 ? sxy / sxx : 0;
    c0 = my - c1 * mx;
  } else if (ys.length) {
    c0 = ys.reduce((a, c) => a + c, 0) / ys.length;
  }

  c1 = Math.max(c1, 0);
  const flatLimit = quantileSorted(gSorted, 0.5);
  const sv = new Float64Array(n);
  const sg2 = new Float64Array(n);

  for (const [key, dark] of [['c0Dark', true], ['c0Bright', false]]) {
    let m = 0;

    for (let i = 0; i < n; i += 1) {
      if (g[i] <= flatLimit && (dark ? lv[i] < 0.35 : lv[i] > 0.65)) {
        sv[m] = v[i];
        sg2[m] = g[i] * g[i];
        m += 1;
      }
    }

    if (m >= 200) {
      const qv = quantileSorted(sv.subarray(0, m).sort(), q);
      out[key] = Math.max(qv * qv - c1 * quantileSorted(sg2.subarray(0, m).sort(), 0.5), floor * floor);
    } else {
      out[key] = Math.max(c0, floor * floor);
    }
  }

  out.c1 = c1;
  return out;
}

/** Per-pixel noise variance of a model from noiseModel (segment.noise_var). */
function noiseVar(model, grad, level) {
  const f = Math.min(1, Math.max(0, (level - 0.2) / 0.6));
  return model.c0Dark * (1 - f) + model.c0Bright * f + model.c1 * grad * grad;
}

/**
 * The rock evidence per crop pixel: E = max(z_lum / T_LUM, z_chroma / T_CHROMA), z = 1.645
 * r / sqrt(var) (the noise models give 90% quantiles; a half-normal's is 1.645 sigma); 0 where the
 * board is not modelled.
 *
 * Unlike the desktop, chroma's edge term is fitted against the prediction's plain gradient, not
 * against the gradient over the local contrast (segment.frame_cues' `gn`): within one small crop
 * the contrast barely changes, and the GPU packs one gradient per pixel.
 */
export function evidenceMap(res, lumModel, chromaModel) {
  const n = res.lum.length;
  const E = new Float32Array(n);

  for (let k = 0; k < n; k += 1) {
    if (!res.valid[k]) {
      continue;
    }

    const zl = (1.645 * res.lum[k]) / Math.sqrt(noiseVar(lumModel, res.grad[k], res.level[k]));
    const zc = (1.645 * res.chroma[k]) / Math.sqrt(noiseVar(chromaModel, res.grad[k], res.level[k]));
    E[k] = Math.max(zl / T_LUM, zc / T_CHROMA);
  }

  return E;
}

/**
 * Squared Euclidean distance from every pixel of a width x height mask to the nearest pixel whose
 * value is `value` (Infinity when there is none), by Felzenszwalb and Huttenlocher's linear-time
 * transform: the 1D lower envelope of parabolas down every column, then along every row. Pixels
 * outside the image are not candidates. Exact, and linear in the area whatever the radius it is
 * thresholded at.
 */
export function squaredDistance(mask, width, height, value) {
  const INF = 1e20;
  const n = Math.max(width, height);
  const d = new Float64Array(width * height);
  const f = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  // 1D squared distance transform of f[0 .. len - 1] into out: the lower envelope of the
  // parabolas (q - p)^2 + f[p], v holding the parabolas' vertices and z the envelope's breakpoints.
  const pass = (len) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;

    for (let q = 1; q < len; q += 1) {
      let sv;

      for (;;) {
        const p = v[k];
        sv = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);

        if (sv <= z[k] && k > 0) {
          k -= 1;
        } else {
          break;
        }
      }

      k += 1;
      v[k] = q;
      z[k] = sv;
      z[k + 1] = INF;
    }

    k = 0;

    for (let q = 0; q < len; q += 1) {
      while (z[k + 1] < q) {
        k += 1;
      }

      const p = v[k];
      out[q] = (q - p) * (q - p) + f[p];
    }
  };

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      f[y] = mask[y * width + x] === value ? 0 : INF;
    }

    pass(height);

    for (let y = 0; y < height; y += 1) {
      d[y * width + x] = out[y];
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      f[x] = d[y * width + x];
    }

    pass(width);

    for (let x = 0; x < width; x += 1) {
      d[y * width + x] = out[x] >= INF / 2 ? Infinity : out[x];
    }
  }

  return d;
}

/** Binary dilation by the disk dx^2 + dy^2 <= r^2; outside the image counts as background. */
export function dilate(mask, size, r) {
  return morph(mask, size, r, true);
}

/**
 * Binary erosion by the same disk; outside the image counts as foreground (OpenCV's default
 * border), so only background pixels inside the image erode.
 */
export function erode(mask, size, r) {
  return morph(mask, size, r, false);
}

/**
 * Dilation or erosion, computed only over the mask's bounding box grown by r + 1 (outside it the
 * result is background either way): the rock covers a fraction of the crop, so this is several
 * times cheaper than transforming the whole crop. Within the window, pixels outside the image are
 * never candidates, so the image border behaves as described above.
 */
function morph(mask, size, r, grow) {
  const out = new Uint8Array(mask.length);

  if (r < 1) {
    out.set(mask);
    return out;
  }

  let x0 = size;
  let y0 = size;
  let x1 = -1;
  let y1 = -1;

  for (let y = 0; y < size; y += 1) {
    const row = y * size;

    for (let x = 0; x < size; x += 1) {
      if (mask[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }

  if (x1 < 0) {
    return out;
  }

  const m = Math.ceil(r) + 1;
  const wx0 = Math.max(0, x0 - m);
  const wy0 = Math.max(0, y0 - m);
  const wx1 = Math.min(size - 1, x1 + m);
  const wy1 = Math.min(size - 1, y1 + m);
  const w = wx1 - wx0 + 1;
  const h = wy1 - wy0 + 1;
  const sub = new Uint8Array(w * h);

  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      sub[j * w + i] = mask[(wy0 + j) * size + wx0 + i];
    }
  }

  const d = squaredDistance(sub, w, h, grow ? 1 : 0);
  const r2 = r * r;

  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      const k = j * w + i;
      out[(wy0 + j) * size + wx0 + i] = grow ? (d[k] <= r2 ? 1 : 0) : (sub[k] && d[k] > r2 ? 1 : 0);
    }
  }

  return out;
}

/** Closing (dilation, then erosion) by a disk of radius r. */
export function close(mask, size, r) {
  return erode(dilate(mask, size, r), size, r);
}

/** Opening (erosion, then dilation) by a disk of radius r. */
export function open(mask, size, r) {
  return dilate(erode(mask, size, r), size, r);
}

/**
 * The 3 x 3 median of a binary map: a pixel is set when at least 5 of the 9 pixels around it are
 * (pixels outside the image do not count). The median of E thresholded at 1 is the threshold of
 * E's median, which the desktop takes (segment.median_z, MEDIAN_PX = 5 px at 1080p: about one
 * crop pixel here), so the median runs on the binary map, as running sums.
 */
export function majority3(mask, size) {
  const cols = new Uint8Array(mask.length);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const k = y * size + x;
      cols[k] = mask[k] + (y > 0 ? mask[k - size] : 0) + (y + 1 < size ? mask[k + size] : 0);
    }
  }

  const out = new Uint8Array(mask.length);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const k = y * size + x;
      const count = cols[k] + (x > 0 ? cols[k - 1] : 0) + (x + 1 < size ? cols[k + 1] : 0);
      out[k] = count >= 5 ? 1 : 0;
    }
  }

  return out;
}

/**
 * 8-connected components of a binary mask: { labels (Int32Array, 0 = background, 1..n), areas
 * (areas[label]), count }.
 */
export function components(mask, size) {
  const labels = new Int32Array(mask.length);
  const areas = [0];
  const stack = new Int32Array(mask.length);
  let next = 0;

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) {
      continue;
    }

    next += 1;
    let top = 0;
    let area = 0;
    stack[top++] = start;
    labels[start] = next;

    while (top > 0) {
      const k = stack[--top];
      area += 1;
      const x = k % size;
      const y = (k - x) / size;

      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;

        if (yy < 0 || yy >= size) {
          continue;
        }

        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;

          if (xx < 0 || xx >= size) {
            continue;
          }

          const kk = yy * size + xx;

          if (mask[kk] && !labels[kk]) {
            labels[kk] = next;
            stack[top++] = kk;
          }
        }
      }
    }

    areas.push(area);
  }

  return { labels, areas, count: next };
}

/** The components of `mask` (8-connected) that overlap `core` (segment.keep_core). */
export function keepCore(mask, size, core) {
  // A flood fill from the core's rock pixels: only the kept components are ever visited.
  const out = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let top = 0;

  for (let k = 0; k < mask.length; k += 1) {
    if (core[k] && mask[k] && !out[k]) {
      out[k] = 1;
      stack[top++] = k;
    }
  }

  while (top > 0) {
    const k = stack[--top];
    const x = k % size;
    const y = (k - x) / size;
    const xa = x > 0 ? -1 : 0;
    const xb = x + 1 < size ? 1 : 0;
    const ya = y > 0 ? -1 : 0;
    const yb = y + 1 < size ? 1 : 0;

    for (let dy = ya; dy <= yb; dy += 1) {
      for (let dx = xa; dx <= xb; dx += 1) {
        const kk = k + dy * size + dx;

        if (mask[kk] && !out[kk]) {
          out[kk] = 1;
          stack[top++] = kk;
        }
      }
    }
  }

  return out;
}

/**
 * Every background region that does not reach the image's border, filled (segment.fill_holes): a
 * rock's silhouette has no holes, while a clear rock shows correctly predicted board through its
 * middle. Background is 4-connected, the complement of the 8-connected foreground.
 */
export function fillHoles(mask, size) {
  const outside = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let top = 0;

  const push = (k) => {
    if (!mask[k] && !outside[k]) {
      outside[k] = 1;
      stack[top++] = k;
    }
  };

  for (let i = 0; i < size; i += 1) {
    push(i);
    push((size - 1) * size + i);
    push(i * size);
    push(i * size + size - 1);
  }

  while (top > 0) {
    const k = stack[--top];
    const x = k % size;
    const y = (k - x) / size;

    if (x > 0) push(k - 1);
    if (x + 1 < size) push(k + 1);
    if (y > 0) push(k - size);
    if (y + 1 < size) push(k + size);
  }

  const out = new Uint8Array(mask.length);

  for (let k = 0; k < mask.length; k += 1) {
    out[k] = outside[k] ? 0 : 1;
  }

  return out;
}

/**
 * The rock mask from the evidence (segment.mask_from_evidence, scaled to the crop):
 * over threshold, 3 x 3 median, specks opened away (when `openPx` >= 1), components reaching the
 * core kept, gaps narrower than 2 closePx closed, holes filled, and components reaching the core
 * kept again. Returns { raw (the thresholded, medianed evidence), mask }.
 */
export function maskFromEvidence(E, size, core, { closePx = 1, openPx = 0 } = {}) {
  let raw = new Uint8Array(E.length);

  for (let k = 0; k < E.length; k += 1) {
    raw[k] = E[k] > 1 ? 1 : 0;
  }

  raw = majority3(raw, size);
  let m = openPx >= 1 ? open(raw, size, openPx) : raw;
  m = keepCore(m, size, core);
  m = closePx >= 1 ? close(m, size, closePx) : m;
  m = fillHoles(m, size);
  return { raw, mask: keepCore(m, size, core) };
}

/**
 * Moves the outline to where pixels are half rock, half board (segment.refine_outline).
 *
 * A threshold on the residuals puts the outline at the outer foot of the rock's blurred edge (the
 * desktop measured masks ~3 px too big all round on synthetic frames; here about two crop pixels
 * before this step). In a band of +-bandPx around the mask's outline, each pixel's colour I is
 * modelled as a mix alpha S + (1 - alpha) B of the rock's local colour S (the mean of the pixels
 * well inside the mask) and the board's B (the prediction M times the local frame / prediction
 * ratio of the pixels well outside, which carries shadows), alpha by least squares over the three
 * channels; the outline goes to alpha = 0.5. Where the two colours differ by less than
 * minContrast grey levels, or the rock's side is patterned (a clear rock showing the board), the
 * outline stays. The desktop's Gaussian windows (sigma 1.5 bandPx) are boxes of the same variance
 * here (half-width 2.6 bandPx), summed-area tables over the outline's neighbourhood only making
 * them cheap on the CPU.
 *
 * @param {Uint8Array} mask  the rock mask (size x size, 0/1)
 * @param {Uint8Array} frame  the crop's frame colours, RGBA bytes
 * @param {Uint8Array} model  the predicted board colours M, RGBA bytes
 * @param {Uint8Array} valid  1 where the board is modelled
 * @returns {{ mask: Uint8Array, changed: number }}
 */
export function refineOutline(mask, frame, model, valid, size, { bandPx = 3, minContrast = 12, smoothPx = 0 } = {}) {
  const r = Math.max(2, Math.round(bandPx));
  const h = Math.max(1, Math.round(2.6 * r));
  const inner = erode(mask, size, r);
  const grown = dilate(mask, size, r);
  const out = mask.slice();

  // The window everything below needs: the band (grown mask) plus the box half-width.
  let bx0 = size;
  let by0 = size;
  let bx1 = -1;
  let by1 = -1;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (grown[y * size + x]) {
        bx0 = Math.min(bx0, x);
        bx1 = Math.max(bx1, x);
        by0 = Math.min(by0, y);
        by1 = Math.max(by1, y);
      }
    }
  }

  if (bx1 < 0) {
    return { mask: out, changed: 0 };
  }

  const x0 = Math.max(0, bx0 - h);
  const y0 = Math.max(0, by0 - h);
  const x1 = Math.min(size - 1, bx1 + h);
  const y1 = Math.min(size - 1, by1 + h);
  const w = x1 - x0 + 1;
  const ht = y1 - y0 + 1;
  const W1 = w + 1;

  // Summed-area tables over the window: inner count, outer count, inner colour sums (3), outer
  // ratio sums (3), then the inside spread.
  const T = Array.from({ length: 8 }, () => new Float64Array(W1 * (ht + 1)));
  const vals = new Float64Array(8);

  for (let j = 0; j < ht; j += 1) {
    const row = new Float64Array(8);

    for (let i = 0; i < w; i += 1) {
      const k = (y0 + j) * size + (x0 + i);
      vals.fill(0);

      if (inner[k]) {
        vals[0] = 1;
        vals[2] = frame[4 * k];
        vals[3] = frame[4 * k + 1];
        vals[4] = frame[4 * k + 2];
      } else if (!grown[k] && valid[k]) {
        vals[1] = 1;
        vals[5] = frame[4 * k] / Math.max(model[4 * k], 8);
        vals[6] = frame[4 * k + 1] / Math.max(model[4 * k + 1], 8);
        vals[7] = frame[4 * k + 2] / Math.max(model[4 * k + 2], 8);
      }

      const at = (j + 1) * W1 + i + 1;
      const above = j * W1 + i + 1;

      for (let c = 0; c < 8; c += 1) {
        row[c] += vals[c];
        T[c][at] = T[c][above] + row[c];
      }
    }
  }

  const box = (t, i, j) => {
    const a0 = Math.max(0, i - h);
    const b0 = Math.max(0, j - h);
    const a1 = Math.min(w, i + h + 1);
    const b1 = Math.min(ht, j + h + 1);
    return t[b1 * W1 + a1] - t[b0 * W1 + a1] - t[b1 * W1 + a0] + t[b0 * W1 + a0];
  };

  // S (the rock's local colour) at every inner pixel, for the spread of the inside around it.
  const spread = new Float64Array(W1 * (ht + 1));

  for (let j = 0; j < ht; j += 1) {
    let row = 0;

    for (let i = 0; i < w; i += 1) {
      const k = (y0 + j) * size + (x0 + i);

      if (inner[k]) {
        const ni = box(T[0], i, j);
        let e = 0;

        for (let c = 0; c < 3; c += 1) {
          e += (frame[4 * k + c] - box(T[2 + c], i, j) / ni) ** 2;
        }

        row += e;
      }

      spread[(j + 1) * W1 + i + 1] = spread[j * W1 + i + 1] + row;
    }
  }

  // alpha on the band.
  const alpha = new Float32Array(w * ht);
  const ok = new Uint8Array(w * ht);

  for (let j = 0; j < ht; j += 1) {
    for (let i = 0; i < w; i += 1) {
      const k = (y0 + j) * size + (x0 + i);

      if (!grown[k] || inner[k]) {
        continue;
      }

      const a0 = Math.max(0, i - h);
      const b0 = Math.max(0, j - h);
      const area = (Math.min(w, i + h + 1) - a0) * (Math.min(ht, j + h + 1) - b0);
      const ni = box(T[0], i, j);
      const no = box(T[1], i, j);

      if (ni / area <= 0.05 || no / area <= 0.05) {
        continue;
      }

      let dd = 0;
      let num = 0;

      for (let c = 0; c < 3; c += 1) {
        const S = box(T[2 + c], i, j) / ni;
        const B = model[4 * k + c] * (box(T[5 + c], i, j) / no);
        const D = S - B;
        dd += D * D;
        num += (frame[4 * k + c] - B) * D;
      }

      const varIn = box(spread, i, j) / ni;

      if (dd >= minContrast * minContrast && varIn < 0.25 * dd) {
        ok[j * w + i] = 1;
        alpha[j * w + i] = num / Math.max(dd, 1e-6);
      }
    }
  }

  let changed = 0;

  for (let j = 0; j < ht; j += 1) {
    for (let i = 0; i < w; i += 1) {
      if (!ok[j * w + i]) {
        continue;
      }

      let a = alpha[j * w + i];

      if (smoothPx >= 0.5) {
        // alpha is noisy where the contrast is low: averaged over the usable 3 x 3 neighbours.
        let sum = 0;
        let count = 0;

        for (let dj = -1; dj <= 1; dj += 1) {
          for (let di = -1; di <= 1; di += 1) {
            const ii = i + di;
            const jj = j + dj;

            if (ii >= 0 && jj >= 0 && ii < w && jj < ht && ok[jj * w + ii]) {
              sum += alpha[jj * w + ii];
              count += 1;
            }
          }
        }

        a = sum / count;
      }

      const k = (y0 + j) * size + (x0 + i);
      const v = a > 0.5 ? 1 : 0;

      if (v !== out[k]) {
        changed += 1;
      }

      out[k] = v;
    }
  }

  return { mask: out, changed };
}

/** The largest 8-connected component of a mask, as its own mask, with its area; null if none. */
export function largestComponent(mask, size) {
  const { labels, areas, count } = components(mask, size);

  if (!count) {
    return null;
  }

  let best = 1;

  for (let l = 2; l <= count; l += 1) {
    if (areas[l] > areas[best]) {
      best = l;
    }
  }

  const out = new Uint8Array(mask.length);

  for (let k = 0; k < mask.length; k += 1) {
    out[k] = labels[k] === best ? 1 : 0;
  }

  return { mask: out, area: areas[best] };
}

// Directions of the boundary walk: 0 right (+x), 1 down (+y), 2 left, 3 up; y is down.
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * The outer outline of a mask's component, as a closed polygon in crop pixels (pixel (i, j) covers
 * [i, i + 1] x [j, j + 1]), clockwise on screen.
 *
 * It walks the pixel edges between rock and board with the rock on the right; at a corner where two
 * rock pixels touch only diagonally it turns left, so they stay one shape (8-connected rock, as
 * the components are). The vertices are the midpoints of those edges where the walk turns: the
 * contour marching squares draws through a binary image at level 0.5, with the straight runs'
 * intermediate points dropped. A single pixel gives a diamond; a straight edge stays straight.
 */
export function traceOutline(mask, size) {
  const fg = (x, y) => x >= 0 && y >= 0 && x < size && y < size && mask[y * size + x] === 1;

  // Is the edge leaving vertex (x, y) in direction d a boundary edge with rock on its right?
  const boundary = (x, y, d) => {
    switch (d) {
      case 0:
        return fg(x, y) && !fg(x, y - 1);
      case 1:
        return fg(x - 1, y) && !fg(x, y);
      case 2:
        return fg(x - 1, y - 1) && !fg(x - 1, y);
      default:
        return fg(x, y - 1) && !fg(x - 1, y - 1);
    }
  };

  let start = -1;

  for (let k = 0; k < mask.length; k += 1) {
    if (mask[k]) {
      start = k;
      break;
    }
  }

  if (start < 0) {
    return [];
  }

  // The first rock pixel in raster order has board (or the image's edge) above it, so its top
  // edge, walked to the right, is on the outer boundary.
  const sx = start % size;
  const sy = (start - sx) / size;
  let x = sx;
  let y = sy;
  let d = 0;
  const dirs = [];
  const limit = 4 * (size + 1) * (size + 1);

  do {
    dirs.push([x, y, d]);
    x += DX[d];
    y += DY[d];
    let next = -1;

    for (const turn of [3, 0, 1]) {
      const c = (d + turn) % 4;

      if (boundary(x, y, c)) {
        next = c;
        break;
      }
    }

    if (next < 0) {
      throw new Error('traceOutline: the boundary walk lost the boundary');
    }

    d = next;
  } while ((x !== sx || y !== sy || d !== 0) && dirs.length < limit);

  // Edge midpoints, keeping only those where the walk turns (the rest are collinear).
  const n = dirs.length;
  const out = [];

  for (let i = 0; i < n; i += 1) {
    const [ex, ey, ed] = dirs[i];
    const prev = dirs[(i + n - 1) % n][2];
    const next = dirs[(i + 1) % n][2];

    if (ed !== prev || ed !== next) {
      out.push([ex + 0.5 * DX[ed], ey + 0.5 * DY[ed]]);
    }
  }

  return out;
}

/** A polygon's signed area (shoelace; positive when clockwise on screen, y down). */
export function polygonArea(polygon) {
  let a = 0;

  for (let i = 0; i < polygon.length; i += 1) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[(i + 1) % polygon.length];
    a += ax * by - bx * ay;
  }

  return a / 2;
}

/**
 * The share of a mask's boundary pixels that have over-threshold evidence within one pixel: how
 * much of the outline the evidence itself draws, rather than closing and filling.
 */
export function outlineSupport(mask, raw, size) {
  let total = 0;
  let supported = 0;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const k = y * size + x;

      if (!mask[k]) {
        continue;
      }

      const edge =
        x === 0 || y === 0 || x === size - 1 || y === size - 1 ||
        !mask[k - 1] || !mask[k + 1] || !mask[k - size] || !mask[k + size];

      if (!edge) {
        continue;
      }

      total += 1;
      let hit = false;

      for (let dy = -1; dy <= 1 && !hit; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          const yy = y + dy;

          if (xx >= 0 && yy >= 0 && xx < size && yy < size && raw[yy * size + xx]) {
            hit = true;
            break;
          }
        }
      }

      if (hit) {
        supported += 1;
      }
    }
  }

  return total ? supported / total : 0;
}
