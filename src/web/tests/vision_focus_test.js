/*
 * vision_focus_test.js -- the phone's focus and glare measure at the rock (T-0331):
 * src/web/src/lib/vision/focus.js, a port of the HousekiScanner desktop's capture check
 * (selection.blur_sigma_px and glare_fraction).
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The fixtures (tests/fixtures/vision_focus/, made by make_fixture.py running the DESKTOP's own code
 * on six real capture windows: four sharp, two at the desktop's blur ceiling) give the numbers the
 * port must reproduce. The synthetic checks use a checkerboard blurred by a known sigma.
 */

import { blurSigmaPx, createFocusMeter, gaussianBlur, glareFraction, glareInPolygon, greyReduced } from '../src/lib/vision/focus.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}

const FIXTURES = new URL('./fixtures/vision_focus/', import.meta.url);
const INDEX = JSON.parse(await Deno.readTextFile(new URL('focus.json', FIXTURES)));

/** A gzipped binary PGM -> { grey: Float32Array, width, height }. */
async function readPgm(name) {
  const compressed = await Deno.readFile(new URL(name, FIXTURES));
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  // header: "P5\n<w> <h>\n255\n"
  let newlines = 0;
  let start = 0;

  while (newlines < 3) {
    if (bytes[start] === 10) {
      newlines += 1;
    }

    start += 1;
  }

  const [, size] = new TextDecoder().decode(bytes.subarray(0, start)).split('\n');
  const [width, height] = size.split(' ').map(Number);
  return { grey: Float32Array.from(bytes.subarray(start, start + width * height)), width, height };
}

Deno.test('blurSigmaPx: reproduces the desktop measure on six real capture windows', async () => {
  // Setup: six windows around the stone cut from real captures (the desktop's own Step 2 bound
  // projected through each frame's pose), halved, in grey; the expected values are the desktop's
  // selection.blur_sigma_px on the same window with the same pixel scale (s = 0.5).
  // Test: the port on each window.
  // Verifies: every one of the four directions agrees with the desktop within 1% (the two compute in
  // different float precisions: the desktop's cv2 arrays are float32 throughout).
  for (const window of INDEX.windows) {
    const { grey, width, height } = await readPgm(window.file);
    assert(width === window.width && height === window.height, `${window.file} size`);
    const ours = blurSigmaPx(grey, width, height, window.s);
    ours.forEach((value, i) => assertClose(value, window.blur_sigma_px[i], 0.01 * window.blur_sigma_px[i] + 1e-3, `${window.file} direction ${i}`));
  }
});

Deno.test('blurSigmaPx: reproduces the desktop after an extra Gaussian blur of 1, 2 and 3 px', async () => {
  // Setup: each window blurred further by a known Gaussian (1, 2, 3 px), by the port's gaussianBlur;
  // the expected values are the desktop's measure after cv2.GaussianBlur of the same float window.
  // Verifies: the port's blur and measure together agree with the desktop's within 1.5%, and the
  // reading grows with the extra blur (each step reads more than the one before).
  for (const window of INDEX.windows) {
    const { grey, width, height } = await readPgm(window.file);
    let previous = Math.max(...blurSigmaPx(grey, width, height, window.s));

    for (const extra of ['1.0', '2.0', '3.0']) {
      const blurred = gaussianBlur(grey, width, height, Number(extra));
      const ours = blurSigmaPx(blurred, width, height, window.s);
      const expected = window.blur_sigma_px_after[extra];
      ours.forEach((value, i) => assertClose(value, expected[i], 0.015 * expected[i] + 1e-3, `${window.file} +${extra} direction ${i}`));
      assert(Math.max(...ours) > previous, `${window.file}: more blur reads more`);
      previous = Math.max(...ours);
    }
  }
});

Deno.test('the real windows: sharp ones read under 0.8 px, the desktop-ceiling ones over 1.8 px', async () => {
  // Setup: the same six windows, with the desktop's own verdict on each frame (selection.json's
  // blur_mm at full resolution: 0.03-0.04 mm for the four sharp ones, 0.19-0.20 mm for the two
  // softest it still accepted, spinel's 0.12 in between).
  // Test: the worst direction of the port's measure, in the window's pixels and in mm at the stone
  // (pixels / px per mm, both at the halved size).
  // Verifies: what the phone's thresholds rest on (guidance.js FOCUS_MAX_MM and FOCUS_MIN_PX): the
  // sharp windows read at most 0.8 px (0.08 mm, the measure's floor at this resolution), the soft
  // ones at least 1.8 px and about 0.2 mm (0.19-0.22), so a ceiling of 0.20 mm and a floor of 1.2 px
  // separate them.
  for (const window of INDEX.windows) {
    const { grey, width, height } = await readPgm(window.file);
    const worst = Math.max(...blurSigmaPx(grey, width, height, window.s));
    const mm = worst / window.px_per_mm;

    if (window.desktop_blur_mm < 0.05) {
      assert(worst < 0.8 && mm < 0.1, `${window.file} sharp reads ${worst.toFixed(2)} px, ${mm.toFixed(3)} mm`);
    } else if (window.desktop_blur_mm > 0.19) {
      assert(worst > 1.8 && mm > 0.19 && mm < 0.23, `${window.file} soft reads ${worst.toFixed(2)} px, ${mm.toFixed(3)} mm`);
    }
  }
});

/**
 * A 1280 x 720 RGBA "frame" of a checkerboard of 40 px squares (grey 40 and 210, about a board's
 * squares at a phone's working distance), blurred by `sigma` px, as the page's copy at 1 / k size
 * (k x k blocks averaged).
 */
function checkerFrame(sigma, k) {
  const w = 1280;
  const h = 720;
  const grey = new Float32Array(w * h);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      grey[y * w + x] = (Math.floor(x / 40) + Math.floor(y / 40)) % 2 ? 210 : 40;
    }
  }

  const blurred = sigma > 0 ? gaussianBlur(grey, w, h, sigma) : grey;
  const W = w / k;
  const H = h / k;
  const rgba = new Uint8ClampedArray(W * H * 4);

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let sum = 0;

      for (let a = 0; a < k; a += 1) {
        for (let b = 0; b < k; b += 1) {
          sum += blurred[(y * k + a) * w + x * k + b];
        }
      }

      const i = 4 * (y * W + x);
      rgba[i] = rgba[i + 1] = rgba[i + 2] = sum / (k * k);
      rgba[i + 3] = 255;
    }
  }

  return { data: rgba, width: W, height: H };
}

Deno.test('createFocusMeter: measures a window of a frame copy, in frame pixels', () => {
  // Setup: checkerboard frames blurred by 1 and by 3 px, given to the meter only as the page's copy
  // (no drawable source, as under Deno) at full and at half size, and a window of 200 x 180 frame px.
  // Test: measure the window in each.
  // Verifies: the reading is scaled back to FRAME pixels whatever the copy's size (full and half
  // copies agree within 15%: halving adds a little blur of its own, measured +11%); 3 px reads 3 px
  // within 30% (the measure's own bias on a checkerboard's
  // close edges; the thresholds are set on real windows, see above) and at least 1 px more than 1 px
  // does; a window outside the frame gives null; glare is 0 on this board.
  const meter = createFocusMeter({ canvas: () => null });
  const box = [500, 300, 700, 480];
  const size = { width: 1280, height: 720 };
  const read = (sigma, k) => meter.measure(null, checkerFrame(sigma, k), 1 / k, box, size);
  const soft = read(3, 1);
  const softHalf = read(3, 2);
  const sharp = read(1, 1);
  assertClose(soft.blurPx, 3, 0.3 * 3, '3 px blur in frame px');
  assertClose(softHalf.blurPx, soft.blurPx, 0.15 * soft.blurPx, 'the half-size copy agrees');
  assert(soft.blurPx - sharp.blurPx > 1, `3 px reads more than 1 px: ${soft.blurPx} vs ${sharp.blurPx}`);
  assert(soft.glare === 0, 'no glare');
  assert(meter.measure(null, checkerFrame(1, 2), 0.5, [1300, 800, 1400, 900], size) === null, 'outside: null');
});

Deno.test('glareFraction and greyReduced: clipped-white share, and grey by whole-factor averaging', () => {
  // Setup: a 4 x 2 RGBA window with 2 pixels white in all channels, 1 white in only two channels.
  // Verifies: glare counts only pixels at >= 250 in all three channels (2 of 8 = 0.25); grey uses
  // cv2's 0.299 / 0.587 / 0.114 weights, and a reduction by 2 averages 2 x 2 blocks.
  const rgba = new Uint8ClampedArray([
    255, 255, 255, 255, 250, 252, 251, 255, 255, 255, 0, 255, 0, 0, 0, 255,
    100, 100, 100, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
  ]);
  assertClose(glareFraction(rgba, 4, 2), 0.25, 1e-12, 'glare share');
  const one = greyReduced(rgba, 4, 2, 1);
  assertClose(one.grey[5], 0.299 * 255, 1e-3, 'red pixel grey');
  const two = greyReduced(rgba, 4, 2, 2);
  assert(two.width === 2 && two.height === 1, 'reduced size');
  assertClose(two.grey[0], (255 + 0.299 * 250 + 0.587 * 252 + 0.114 * 251 + 100 + 0.299 * 255) / 4, 1e-3, 'block average');
});

Deno.test('glareInPolygon: clipped white counted on the rock only, not on the white paper around it', () => {
  // Setup: a 100 x 100 window at frame (200, 300) that is all pure-white "paper", except a grey
  // "rock" disc of radius 20 px in its middle with a 10 x 10 px white highlight on it; the rock's
  // outline is a 64-point circle of radius 20 in FRAME pixels. A meter measures the same window as
  // the page's copy (no drawable source), with and without the outline.
  // Verifies: inside the outline, the highlight's share of the disc (100 / (pi 20^2) = 8%, within
  // 1.5% for the disc's pixel edge) is counted and the paper is not; the whole-window share (the
  // desktop's) is dominated by the paper (over 80%); measure() uses the outline when given; a
  // polygon away from the window counts nothing (null).
  const w = 100;
  const h = 100;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = 4 * (y * w + x);
      const onRock = Math.hypot(x + 0.5 - 50, y + 0.5 - 50) < 20;
      const highlight = x >= 45 && x < 55 && y >= 45 && y < 55;

      if (onRock && !highlight) {
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 120;
      }
    }
  }

  const outline = Array.from({ length: 64 }, (_, k) => [250 + 20 * Math.cos((k / 32) * Math.PI), 350 + 20 * Math.sin((k / 32) * Math.PI)]);
  const onRock = glareInPolygon(rgba, w, h, 200, 300, 1, outline);
  assertClose(onRock, 100 / (Math.PI * 400), 0.015, 'the highlight share of the rock');
  assert(glareFraction(rgba, w, h) > 0.8, 'the whole window is mostly clipped paper');
  assert(glareInPolygon(rgba, w, h, 200, 300, 1, outline.map(([x, y]) => [x + 500, y])) === null, 'outside: null');

  // The same through the meter, given the window as a frame copy (the frame is 640 x 480).
  const frame = { width: 640, height: 480, data: new Uint8ClampedArray(640 * 480 * 4).fill(255) };

  for (let y = 0; y < h; y += 1) {
    frame.data.set(rgba.subarray(4 * y * w, 4 * (y + 1) * w), 4 * ((300 + y) * 640 + 200));
  }

  const meter = createFocusMeter({ canvas: () => null });
  const box = [200, 300, 300, 400];
  assertClose(meter.measure(null, frame, 1, box, { width: 640, height: 480 }, outline).glare, onRock, 1e-12, 'with the outline');
  assert(meter.measure(null, frame, 1, box, { width: 640, height: 480 }).glare > 0.8, 'without: the whole window');
});
