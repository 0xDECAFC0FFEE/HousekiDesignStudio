// Is the rock sharp? The phone's focus and glare measure at the rock (T-0331), for the scan
// guidance (guidance.js): the HousekiScanner desktop's capture check, ported.
//
// THE MEASURE (HousekiScanner src/houseki/pipeline/selection.py blur_sigma_px, ported exactly; the
// fixtures in tests/fixtures/vision_focus/ were made by running the desktop's own code on real
// capture windows, and the Deno test pins this port to it): the width of the edges in a window
// around the rock, as a Gaussian sigma in pixels, from how much gradient energy survives an extra
// blur ("re-blur"). For a step edge blurred by sigma the energy of its derivative goes as
// 1 / sqrt(sigma^2 + extra^2), so the ratio rho = E1 / E0 of the energies after a small noise
// pre-blur p and after sqrt(p^2 + s0^2) gives sigma^2 = s0^2 rho^2 / (1 - rho^2) - p^2. Only pixels
// near the window's strongest 10% of edges at the coarse scale count, so paper grain and a phone's
// sharpening cannot read as sharp, and the worst of four directions is kept, so a smear in one
// direction (motion) shows. The desktop chose it over the variance of the Laplacian because that
// mostly measures HOW MUCH texture is in the window: a clear stone filling the window read "blurred"
// when it was crisp. The result in pixels becomes millimetres at the rock with the pose
// (pixels per mm = f / depth), so one ceiling (the desktop's 0.20 mm) holds at any distance and zoom.
//
// THE WINDOW is read from the FULL-RESOLUTION frame (the source the outline reads too), not from the
// page's downscaled copy for detection: measured on the fixtures, halving a window raises the
// sharp windows' reading from 0.03-0.04 mm to 0.07-0.09 mm while the soft ones stay at ~0.2 mm, so at
// a phone's 720p and 0.75x the sharp floor would sit too near the ceiling. A window larger than
// MAX_SIDE is reduced by a whole factor (area averaging) and its sigma scaled back.
//
// GLARE (selection.glare_fraction): the share of pixels clipped white in all three channels (>= 250);
// the desktop's ceiling is 5%. The desktop counts its whole window; here, given the rock's outline,
// only the pixels inside it (see measure), so clipped white paper is not taken for glare on the rock.

/** The desktop's constants (selection.py), in pixels at a 1080-pixel short side (x s). */
export const BLUR_S0 = 3.0;
export const BLUR_PRE = 1.0;
export const BLUR_TOP = 0.10;
export const BLUR_GAIN = 1.0 / 0.72;

/** Windows larger than this (px, either side) are reduced by a whole factor first. */
export const MAX_SIDE = 256;

/** The smallest window the measure accepts, in pixels at s = 1 (32 x s). */
export const MIN_WINDOW = 32;

/** The desktop's px(value, s): a resolution-relative length (camera.px). */
const px = (value, s) => (s === 1 ? value : value * s);
/** camera.px_int */
const pxInt = (value, s, minimum = 1) => Math.max(minimum, Math.round(value * s));
/** camera.px_odd */
const pxOdd = (value, s, minimum = 3) => {
  if (s === 1) {
    return value;
  }

  const k = Math.max(minimum, Math.round(value * s));
  return k % 2 ? k : k + 1;
};

/** OpenCV's BORDER_REFLECT_101 index (no repeat of the edge pixel). */
function reflect101(i, n) {
  if (n === 1) {
    return 0;
  }

  while (i < 0 || i >= n) {
    i = i < 0 ? -i : 2 * n - 2 - i;
  }

  return i;
}

/** cv2.getGaussianKernel(ksize, sigma) for a float image: ksize = round(8 sigma + 1) | 1. */
function gaussianKernel(sigma) {
  const size = Math.round(sigma * 4 * 2 + 1) | 1;
  const kernel = new Float64Array(size);
  const centre = (size - 1) / 2;
  let sum = 0;

  for (let i = 0; i < size; i += 1) {
    kernel[i] = Math.exp(-((i - centre) ** 2) / (2 * sigma * sigma));
    sum += kernel[i];
  }

  for (let i = 0; i < size; i += 1) {
    kernel[i] /= sum;
  }

  return kernel;
}

/**
 * Separable convolution with reflect-101 borders (cv2.sepFilter2D / GaussianBlur). Each row is
 * copied once into a padded buffer (the border reflected there, not per tap), and the vertical pass
 * runs along rows (whole rows of the horizontal result scaled and added), so both inner loops are
 * plain contiguous reads. With quantile by selection, this halved the measure's time (Deno: 18.4 ->
 * 8.9 ms on a 180 x 200 window) against indexing each tap through reflect101 and sorting.
 */
function separable(src, w, h, kx, ky) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const rx = (kx.length - 1) >> 1;
  const ry = (ky.length - 1) >> 1;
  const padded = new Float32Array(w + 2 * rx);
  const nx = kx.length;

  for (let y = 0; y < h; y += 1) {
    const row = y * w;

    for (let i = 0; i < w + 2 * rx; i += 1) {
      padded[i] = src[row + reflect101(i - rx, w)];
    }

    for (let x = 0; x < w; x += 1) {
      let sum = 0;

      for (let k = 0; k < nx; k += 1) {
        sum += kx[k] * padded[x + k];
      }

      tmp[row + x] = sum;
    }
  }

  const acc = new Float64Array(w);

  for (let y = 0; y < h; y += 1) {
    acc.fill(0);

    for (let k = 0; k < ky.length; k += 1) {
      const weight = ky[k];

      if (weight === 0) {
        continue;
      }

      const from = reflect101(y + k - ry, h) * w;

      for (let x = 0; x < w; x += 1) {
        acc[x] += weight * tmp[from + x];
      }
    }

    out.set(acc, y * w);
  }

  return out;
}

/** cv2.GaussianBlur(src, (0, 0), sigma) on a float image. */
export function gaussianBlur(src, w, h, sigma) {
  const kernel = gaussianKernel(sigma);
  return separable(src, w, h, kernel, kernel);
}

const SOBEL_D = Float64Array.of(-1, 0, 1);
const SOBEL_S = Float64Array.of(1, 2, 1);

/** cv2.Sobel(img, CV_32F, 1, 0, ksize=3) and (0, 1): { gx, gy }. */
function sobel(src, w, h) {
  return { gx: separable(src, w, h, SOBEL_D, SOBEL_S), gy: separable(src, w, h, SOBEL_S, SOBEL_D) };
}

/** The k-th smallest of `a` (reordered in place): Hoare's quickselect, middle pivot. */
function select(a, k) {
  let lo = 0;
  let hi = a.length - 1;

  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;

    while (i <= j) {
      while (a[i] < pivot) {
        i += 1;
      }

      while (a[j] > pivot) {
        j -= 1;
      }

      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i += 1;
        j -= 1;
      }
    }

    if (k <= j) {
      hi = j;
    } else if (k >= i) {
      lo = i;
    } else {
      return a[k];
    }
  }

  return a[k];
}

/** numpy.quantile(values, q) with linear interpolation (by selection, not a full sort). */
function quantile(values, q) {
  const a = Float64Array.from(values);
  const position = q * (a.length - 1);
  const lo = Math.floor(position);
  const low = select(a, lo);
  // after selecting lo, everything above index lo is >= it: the next value is their minimum
  let high = low;

  if (lo + 1 < a.length) {
    high = Infinity;

    for (let i = lo + 1; i < a.length; i += 1) {
      high = Math.min(high, a[i]);
    }
  }

  return low + (position - lo) * (high - low);
}

/** Mean squared derivative along x, y and the two diagonals over the mask (selection._grad_energy). */
function gradientEnergy(img, w, h, mask) {
  const { gx, gy } = sobel(img, w, h);
  const c = Math.SQRT1_2;
  const sums = [0, 0, 0, 0];
  let count = 0;

  for (let i = 0; i < w * h; i += 1) {
    if (mask[i]) {
      const a = gx[i];
      const b = gy[i];
      // float32 as in the desktop's cv2 arrays
      const d1 = Math.fround((a + b) * Math.fround(c));
      const d2 = Math.fround((a - b) * Math.fround(c));
      sums[0] += a * a;
      sums[1] += b * b;
      sums[2] += d1 * d1;
      sums[3] += d2 * d2;
      count += 1;
    }
  }

  return sums.map((v) => v / count);
}

/**
 * Edge blur (Gaussian sigma, px) in 4 directions (x, y, both diagonals) of a grey window: the
 * desktop's selection.blur_sigma_px. `grey` is a Float32Array (or any array) of w x h values 0..255;
 * s the pixel scale (the window's frame short side / 1080, divided by any reduction). Returns four
 * NaN for windows smaller than 32 x s px or without edges.
 */
export function blurSigmaPx(grey, w, h, s = 1) {
  const nan = [NaN, NaN, NaN, NaN];

  if (h < MIN_WINDOW * s || w < MIN_WINDOW * s) {
    return nan;
  }

  const g = Float32Array.from(grey);
  const pre = px(BLUR_PRE, s);
  const s0 = px(BLUR_S0, s);
  const a = gaussianBlur(g, w, h, pre);
  const b = gaussianBlur(g, w, h, Math.hypot(pre, s0));
  const { gx: bx, gy: by } = sobel(b, w, h);
  const mag = new Float32Array(w * h);

  for (let i = 0; i < w * h; i += 1) {
    mag[i] = bx[i] * bx[i] + by[i] * by[i];
  }

  // ignore the border, where the blurs see padding
  const e = pxInt(6, s);
  const inner = new Uint8Array(w * h);
  const innerValues = [];

  for (let y = e; y < h - e; y += 1) {
    for (let x = e; x < w - e; x += 1) {
      inner[y * w + x] = 1;
      innerValues.push(mag[y * w + x]);
    }
  }

  if (!innerValues.length) {
    return nan;
  }

  const threshold = quantile(innerValues, 1 - BLUR_TOP);

  if (!(threshold > 0)) {
    return nan;
  }

  // the strongest edges, dilated by a k x k square, inside the border
  const k = pxOdd(5, s);
  const r = k >> 1;
  const strong = new Uint8Array(w * h);

  for (let i = 0; i < w * h; i += 1) {
    strong[i] = inner[i] && mag[i] >= threshold ? 1 : 0;
  }

  const rows = new Uint8Array(w * h);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let on = 0;

      for (let d = -r; d <= r && !on; d += 1) {
        const xx = x + d;
        on = xx >= 0 && xx < w ? strong[y * w + xx] : 0;
      }

      rows[y * w + x] = on;
    }
  }

  const mask = new Uint8Array(w * h);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let on = 0;

      for (let d = -r; d <= r && !on; d += 1) {
        const yy = y + d;
        on = yy >= 0 && yy < h ? rows[yy * w + x] : 0;
      }

      mask[y * w + x] = on && inner[y * w + x] ? 1 : 0;
    }
  }

  const E0 = gradientEnergy(a, w, h, mask);
  const E1 = gradientEnergy(b, w, h, mask);
  return E0.map((e0, i) => {
    const rho = Math.min(E1[i] / Math.max(e0, 1e-12), 0.999);
    const s2 = (s0 * s0 * rho * rho) / (1 - rho * rho) - pre * pre;
    return BLUR_GAIN * Math.sqrt(Math.max(s2, 0));
  });
}

/** Share of an RGBA window's pixels clipped white in all three channels (>= 250). */
export function glareFraction(rgba, w, h) {
  if (!(w > 0 && h > 0)) {
    return 0;
  }

  let clipped = 0;

  for (let i = 0; i < w * h; i += 1) {
    if (rgba[4 * i] >= 250 && rgba[4 * i + 1] >= 250 && rgba[4 * i + 2] >= 250) {
      clipped += 1;
    }
  }

  return clipped / (w * h);
}

/**
 * Share of the window's pixels INSIDE a polygon (frame px; the window's top-left at frame (x0, y0),
 * `ratio` window px per frame px) that are clipped white in all three channels; null when the polygon
 * covers no pixel of the window. Pixel centres are tested by even-odd scanlines.
 */
export function glareInPolygon(rgba, w, h, x0, y0, ratio, polygon) {
  let inside = 0;
  let clipped = 0;
  const n = polygon.length;

  for (let y = 0; y < h; y += 1) {
    const fy = y0 + (y + 0.5) / ratio;
    const xs = [];

    for (let i = 0; i < n; i += 1) {
      const [ax, ay] = polygon[i];
      const [bx, by] = polygon[(i + 1) % n];

      if ((ay <= fy) !== (by <= fy)) {
        xs.push(ax + ((fy - ay) / (by - ay)) * (bx - ax));
      }
    }

    xs.sort((a, b) => a - b);

    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil((xs[k] - x0) * ratio - 0.5));
      const to = Math.min(w - 1, Math.floor((xs[k + 1] - x0) * ratio - 0.5));

      for (let x = from; x <= to; x += 1) {
        const i = 4 * (y * w + x);
        inside += 1;
        clipped += rgba[i] >= 250 && rgba[i + 1] >= 250 && rgba[i + 2] >= 250 ? 1 : 0;
      }
    }
  }

  return inside ? clipped / inside : null;
}

/**
 * Grey (cv2's BGR -> grey weights, 0.299 R + 0.587 G + 0.114 B) of an RGBA window, reduced by a whole
 * `factor` by averaging factor x factor blocks (cv2.INTER_AREA for whole factors).
 */
export function greyReduced(rgba, w, h, factor = 1) {
  const W = Math.floor(w / factor);
  const H = Math.floor(h / factor);
  const out = new Float32Array(W * H);
  const n = factor * factor;

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let sum = 0;

      for (let dy = 0; dy < factor; dy += 1) {
        const row = (y * factor + dy) * w;

        for (let dx = 0; dx < factor; dx += 1) {
          const i = 4 * (row + x * factor + dx);
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
        }
      }

      out[y * W + x] = sum / n;
    }
  }

  return { grey: out, width: W, height: H };
}

/**
 * Reads windows of camera frames and measures them. The window is read from `source` at full
 * resolution when it can be drawn (an ImageBitmap, a <video>, a canvas: drawn into a small canvas of
 * this meter's own), or else cut from `image` (RGBA at `scale` x the frame, the page's copy).
 *
 * measure(source, image, scale, box, frameSize, polygon?) -> { blurPx (frame pixels, the worst direction),
 *   blurWindowPx (the same in the measured window's own pixels), blurDirs, glare, reduce (the whole
 *   factor the window was reduced by, x 1 / scale when cut from `image`), width, height (the
 *   window, frame px), readMs, measureMs } or null when the window is too small or out of frame.
 *
 * @param {object} [options]
 * @param {() => any} [options.canvas]  makes the 2D canvas windows are drawn into (default an
 *        OffscreenCanvas, or a document canvas)
 */
export function createFocusMeter(options = {}) {
  let canvas = null;
  let context = null;
  let failed = false;

  const ensureCanvas = () => {
    if (context || failed) {
      return context;
    }

    try {
      canvas = options.canvas ? options.canvas()
        : typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1)
          : globalThis.document?.createElement('canvas') ?? null;
      context = canvas?.getContext('2d', { willReadFrequently: true }) ?? null;
    } catch {
      context = null;
    }

    failed = !context;
    return context;
  };

  /** RGBA of the frame window [x0, y0, x1, y1) (frame px) from a drawable source, or null. */
  function readDrawable(source, x0, y0, w, h) {
    const ctx = ensureCanvas();

    if (!ctx || !source || source.data) {
      return null;
    }

    try {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      ctx.drawImage(source, x0, y0, w, h, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    } catch {
      return null;
    }
  }

  /** RGBA of the window cut from the page's scaled copy: [data, width, height] at `scale`. */
  function readImage(image, scale, x0, y0, w, h) {
    const X0 = Math.max(0, Math.floor(x0 * scale));
    const Y0 = Math.max(0, Math.floor(y0 * scale));
    const W = Math.min(image.width - X0, Math.round(w * scale));
    const H = Math.min(image.height - Y0, Math.round(h * scale));

    if (!(W > 0 && H > 0)) {
      return null;
    }

    const out = new Uint8ClampedArray(W * H * 4);

    for (let y = 0; y < H; y += 1) {
      const from = 4 * ((Y0 + y) * image.width + X0);
      out.set(image.data.subarray(from, from + 4 * W), 4 * y * W);
    }

    return { data: out, width: W, height: H };
  }

  function measure(source, image, scale, box, frameSize, polygon = null) {
    const x0 = Math.max(0, Math.floor(box[0]));
    const y0 = Math.max(0, Math.floor(box[1]));
    const x1 = Math.min(frameSize.width, Math.ceil(box[2]));
    const y1 = Math.min(frameSize.height, Math.ceil(box[3]));
    const w = x1 - x0;
    const h = y1 - y0;
    const sFrame = Math.min(frameSize.width, frameSize.height) / 1080;

    if (!(w >= MIN_WINDOW * sFrame && h >= MIN_WINDOW * sFrame)) {
      return null;
    }

    const started = performance.now();
    let rgba = readDrawable(source, x0, y0, w, h);
    let width = w;
    let height = h;
    // window px per frame px
    let pixelRatio = 1;

    if (!rgba && image?.data) {
      const cut = readImage(image, scale, x0, y0, w, h);

      if (!cut) {
        return null;
      }

      ({ data: rgba, width, height } = cut);
      pixelRatio = width / w;
    }

    if (!rgba) {
      return null;
    }

    const read = performance.now();
    const factor = Math.max(1, Math.ceil(Math.max(width, height) / MAX_SIDE));
    const { grey, width: gw, height: gh } = greyReduced(rgba, width, height, factor);
    const s = (sFrame * pixelRatio) / factor;
    const dirs = blurSigmaPx(grey, gw, gh, s);
    const worst = Math.max(...dirs);
    // Glare is counted on the rock itself (inside its outline) when the outline is given: the
    // desktop's whole-window share also counts the paper around the stone, which a bright light or
    // a phone's exposure can clip white without any glare on the stone (a synthetic sheet drawn at
    // pure white read 100%). Without an outline, the whole window, as the desktop.
    const glare = polygon?.length >= 3
      ? glareInPolygon(rgba, width, height, x0, y0, pixelRatio, polygon)
      : glareFraction(rgba, width, height);
    return {
      blurPx: worst * factor / pixelRatio,
      blurWindowPx: worst,
      blurDirs: dirs,
      glare,
      reduce: factor / pixelRatio,
      width: w,
      height: h,
      readMs: read - started,
      measureMs: performance.now() - read,
    };
  }

  return { measure };
}
