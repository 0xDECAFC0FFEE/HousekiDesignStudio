/*
 * vision_qr_test.js -- the phone's QR code reader since T-0330: src/web/src/lib/vision/qr_detect.js
 * over the Rust vision module (rqrr, a Rust port of quirc; built as build/vision/houseki_vision.js,
 * the tests are ignored when it has not been built), checked against the truth and against the
 * opencv.js reader it replaced (qr_detect_opencv.js, OpenCV's QRCodeDetector, which decodes with
 * quirc too).
 *
 * HOW TO RUN (from src/web/, after ./build.sh): deno test --allow-read --allow-env tests/
 *
 * THE CODES are made by the encoder the studio draws its pairing code with (scan_qr.js over uqr:
 * ECC M, a 4-module quiet zone), drawn module by module into a grey frame (ink 20, paper 240, on a
 * mid-grey 120 background), then rotated about their centre with OpenCV's bilinear warpAffine and
 * optionally blurred. The rotation also moves the code's true outer corners, so each reader's
 * corners are measured against the truth, in types.js's convention (corner origin).
 */

import { loadOpenCv } from '../src/lib/vision/opencv.js';
import { createQrDetector } from '../src/lib/vision/qr_detect.js';
import { createQrDetector as createOpenCvQrDetector } from '../src/lib/vision/qr_detect_opencv.js';
import { qrCode } from '../src/lib/scan_qr.js';
import { loadBuiltVision, VISION_BUILT } from './vision_test_support.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

function assertEquals(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${message || 'not equal'}: got ${a}, expected ${e}`);
}

const cv = await loadOpenCv({ source: await Deno.readTextFile(new URL('../vendor/opencv/opencv.js', import.meta.url)) });
const vision = await loadBuiltVision();
const TEST = { sanitizeOps: false, sanitizeResources: false, ignore: !VISION_BUILT };
const LINK = 'https://houseki.app/scanner/#v=1&r=00112233445566778899aabbccddeeff&p=ffeeddccbbaa99887766554433221100';

/**
 * A frame of width x height with the given codes, each { text, x, y, module, angle } (top-left of
 * the quiet zone at x, y; rotated by `angle` degrees about the code's centre), blurred by `blur`.
 * Returns { mat (grey cv.Mat, caller deletes), image ({ data, width, height }), truths } with the
 * truth the 4 outer corners of each code (without the quiet zone), top-left first, clockwise as
 * printed, in edge coordinates.
 */
function qrFrame(codes, width, height, blur = 0) {
  let frame = new cv.Mat(height, width, cv.CV_8UC1, new cv.Scalar(120));
  const truths = [];

  for (const { text, x, y, module, angle = 0 } of codes) {
    const { size, modules } = qrCode(text);
    const side = size * module;
    const tile = new cv.Mat(side, side, cv.CV_8UC1, new cv.Scalar(240));

    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (modules[row][col]) {
          cv.rectangle(tile, new cv.Point(col * module, row * module), new cv.Point((col + 1) * module - 1, (row + 1) * module - 1), new cv.Scalar(20), -1);
        }
      }
    }

    // Rotate the tile about its centre into the frame (bilinear, edge coordinates: the matrix
    // maps pixel centres, so the centre is at side / 2 - 0.5 in OpenCV's convention).
    const cxEdge = x + side / 2;
    const cyEdge = y + side / 2;
    const rad = (angle * Math.PI) / 180;
    const [c, s] = [Math.cos(rad), Math.sin(rad)];
    // tile edge coords (u, v) -> frame edge coords: centre + R (u - side/2, v - side/2)
    const toFrame = (u, v) => [cxEdge + c * (u - side / 2) - s * (v - side / 2), cyEdge + s * (u - side / 2) + c * (v - side / 2)];
    // In pixel-centre coordinates: p_f = R (p_t + 0.5 - side/2) + centre - 0.5.
    const tx = cxEdge - 0.5 + (c * (0.5 - side / 2) - s * (0.5 - side / 2));
    const ty = cyEdge - 0.5 + (s * (0.5 - side / 2) + c * (0.5 - side / 2));
    const M = cv.matFromArray(2, 3, cv.CV_64F, [c, -s, tx, s, c, ty]);
    const mask = new cv.Mat(side, side, cv.CV_8UC1, new cv.Scalar(255));
    const warped = new cv.Mat();
    const warpedMask = new cv.Mat();
    cv.warpAffine(tile, warped, M, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(120));
    cv.warpAffine(mask, warpedMask, M, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));

    for (let i = 0; i < width * height; i += 1) {
      const a = warpedMask.data[i] / 255;

      if (a > 0) {
        frame.data[i] = Math.round(a * warped.data[i] + (1 - a) * frame.data[i]);
      }
    }

    const q = 4 * module;
    truths.push([toFrame(q, q), toFrame(side - q, q), toFrame(side - q, side - q), toFrame(q, side - q)]);

    for (const mat of [tile, M, mask, warped, warpedMask]) {
      mat.delete();
    }
  }

  if (blur > 0) {
    const blurred = new cv.Mat();
    cv.GaussianBlur(frame, blurred, new cv.Size(0, 0), blur);
    frame.delete();
    frame = blurred;
  }

  return { mat: frame, image: { data: new Uint8Array(frame.data), width, height }, truths };
}

/** The largest corner error of a found code against its truth. */
function cornerError(found, truth) {
  return Math.max(...found.corners.map(([x, y], k) => Math.hypot(x - truth[k][0], y - truth[k][1])));
}

Deno.test('a code is read with its text and its corners, as OpenCV read it, over sizes, rotations and blur', TEST, () => {
  // Setup: the studio's pairing link (version 6, 41 modules) drawn at 3, 4, 6 and 10 px per
  // module, turned by 0, 15, 45, 90 and 170 degrees, sharp and blurred (sigma 1 and 1.8 px), one
  // code per 900 x 700 frame.
  // Test: read each frame with the Rust reader and with opencv.js's.
  // Verifies: (1) the Rust reader reads at least as many of the 60 frames as opencv.js (measured
  // 2026-10-06: 45 against 35; it misses one frame opencv.js reads, 4 px modules at 170 degrees,
  // sharp, and reads 11 opencv.js misses -- the table is printed); (2) every text it returns is
  // the link byte for byte; (3) its corners are the code's true outer corners within 3.5 px
  // (measured: median 1.75 px, worst 3.2 px; opencv.js 1.6 / 2.8 px -- neither locates QR corners
  // to sub-pixel accuracy; rqrr's are fitted to its grid of modules).
  const rust = createQrDetector(vision);
  const opencv = createOpenCvQrDetector(cv);
  const rows = [];

  for (const module of [3, 4, 6, 10]) {
    for (const angle of [0, 15, 45, 90, 170]) {
      for (const blur of [0, 1, 1.8]) {
        const side = 49 * module;
        const { mat, image, truths } = qrFrame([{ text: LINK, x: 450 - side / 2, y: 350 - side / 2, module, angle }], 900, 700, blur);
        const r = rust.detect(image);
        const o = opencv.detect(mat);
        rows.push({
          module, angle, blur,
          rust: r.length ? { text: r[0].text, error: cornerError(r[0], truths[0]) } : null,
          opencv: o.length ? { text: o[0].text, error: cornerError(o[0], truths[0]) } : null,
        });
        mat.delete();
      }
    }
  }

  const fmt = (v) => (v ? `${v.error.toFixed(2)} px` : 'not read');
  console.log('\n  module  angle  blur   rust          opencv.js');

  for (const row of rows) {
    console.log(`  ${String(row.module).padStart(6)} ${String(row.angle).padStart(6)} ${row.blur.toFixed(1).padStart(5)}   ${fmt(row.rust).padEnd(13)} ${fmt(row.opencv)}`);
  }

  const read = (key) => rows.filter((row) => row[key]).length;
  const errors = (key) => rows.filter((row) => row[key]).map((row) => row[key].error).sort((a, b) => a - b);
  const median = (list) => list[list.length >> 1];
  console.log(`  read: rust ${read('rust')} / ${rows.length}, opencv.js ${read('opencv')} / ${rows.length}; `
    + `corner error median / max: rust ${median(errors('rust')).toFixed(2)} / ${errors('rust').at(-1).toFixed(2)} px, `
    + `opencv.js ${median(errors('opencv')).toFixed(2)} / ${errors('opencv').at(-1).toFixed(2)} px`);

  assert(read('rust') >= read('opencv'), `the Rust reader read ${read('rust')} frames, opencv.js ${read('opencv')}`);

  for (const row of rows) {
    const what = `module ${row.module}, ${row.angle} deg, blur ${row.blur}`;

    if (row.rust) {
      assertEquals(row.rust.text, LINK, `${what}: text`);
      assert(row.rust.error < 3.5, `${what}: corners off by ${row.rust.error} px`);
    }
  }

  rust.dispose();
  opencv.dispose();
});

Deno.test('several codes in a frame are all read, a frame without one gives none, and the options work', TEST, () => {
  // Setup: two codes with different texts side by side in a 900 x 400 frame; a plain frame; an
  // RGBA copy of the two-code frame.
  // Test: read each with the default (multi) reader; the two-code frame with multi: false; and
  // the same frame at processing scale 0.5.
  // Verifies: both texts (in any order), each with corners on its own code (within 2 px), from
  // grey and from RGBA; nothing (an empty list, no error) from the plain frame; one code with
  // multi: false; and at half scale the corners come back in full-frame pixels (within 3 px).
  const { image, truths } = qrFrame([
    { text: 'first code', x: 60, y: 80, module: 8 },
    { text: 'second code, a little longer', x: 520, y: 60, module: 8 },
  ], 900, 400);
  const rgba = new Uint8ClampedArray(900 * 400 * 4);
  image.data.forEach((v, i) => {
    rgba[4 * i] = v;
    rgba[4 * i + 1] = v;
    rgba[4 * i + 2] = v;
    rgba[4 * i + 3] = 255;
  });
  const reader = createQrDetector(vision);
  const texts = ['first code', 'second code, a little longer'];

  for (const source of [image, { data: rgba, width: 900, height: 400 }]) {
    const found = reader.detect(source);
    assertEquals(found.map((f) => f.text).sort(), texts, 'two codes');

    for (const f of found) {
      const error = cornerError(f, truths[texts.indexOf(f.text)]);
      assert(error < 2, `${f.text}: corners off by ${error} px`);
    }
  }

  assertEquals(reader.detect({ data: new Uint8Array(900 * 400).fill(120), width: 900, height: 400 }), [], 'no code');
  const single = createQrDetector(vision, { multi: false });
  assertEquals(single.detect(image).length, 1, 'multi: false');
  const half = createQrDetector(vision, { processingScale: 0.5 });
  const halfFound = half.detect(image);
  assertEquals(halfFound.map((f) => f.text).sort(), texts, 'half scale');

  for (const f of halfFound) {
    const error = cornerError(f, truths[texts.indexOf(f.text)]);
    assert(error < 3, `half scale ${f.text}: corners off by ${error} px`);
  }

  for (const r of [reader, single, half]) {
    r.dispose();
  }

  assert((() => {
    try {
      reader.detect(image);
      return false;
    } catch (error) {
      return /disposed/.test(error.message);
    }
  })(), 'detect after dispose');
});
