/*
 * vision_outline_test.js -- the rock outline's CPU pieces (T-0325): the board texture drawn from a
 * spec (board_texture.js), the camera geometry (outline_geometry.js) and the mask and outline
 * steps that run on the small crop (outline_mask.js).
 *
 * The GPU half (outline.js, outline_shaders.js) needs WebGL2 and is measured end to end in the
 * browser harness instead (tests/harness/test_vision_outline.py: synthetic frames with exact
 * silhouettes, the scanner's real frames against its desktop masks, and the board texture against
 * the printed PNGs pixel by pixel).
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 */

import { TEST_BOARD_SPECS } from './vision_test_boards.js';
import {
  markerBits,
  markerSquares,
  renderBoardTexture,
  sampleBoardTexture,
  srgbToLinear,
} from '../src/lib/vision/board_texture.js';
import {
  convexEdges,
  convexHull,
  cropAround,
  cylinderPoints,
  distort,
  pixelToBoard,
  projectHull,
  projectPoint,
  rasterConvex,
  undistort,
} from '../src/lib/vision/outline_geometry.js';
import {
  decodeResiduals,
  evidenceMap,
  expand,
  fillHoles,
  keepCore,
  largestComponent,
  majority3,
  maskFromEvidence,
  noiseModel,
  polygonArea,
  quantileSorted,
  refineOutline,
  traceOutline,
} from '../src/lib/vision/outline_mask.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

function assertClose(actual, expected, tolerance, message) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${message || 'not close'}: got ${actual}, expected ${expected} +- ${tolerance}`,
  );
}

// Two test-only sheets (vision_test_boards.js): the texture code still draws any spec's removed
// markers, rings and dots, though the one board the phone ships (the strip) has none of them.
const centre3x3 = TEST_BOARD_SPECS.charuco_23x17_10mm_centre3x3;
const centre1 = TEST_BOARD_SPECS.charuco_23x17_10mm_centre1;

// --------------------------------------------------------------------------- board texture

Deno.test('marker 0 of DICT_4X4_250 has the bits OpenCV draws', () => {
  // Setup: the dictionary JSON extracted from OpenCV (aruco_4x4_250.json).
  // Test: decode marker 0's 4 x 4 inner bits.
  // Verifies: the hex encoding is read row by row, most significant bit first, 1 = white. The
  // expected rows were read off cv2.aruco.generateImageMarker(DICT_4X4_250, 0, 6) when the JSON
  // was extracted: [1 0 1 1], [0 1 0 1], [0 0 1 1], [0 0 1 0].
  const bits = markerBits(0);
  assert(JSON.stringify(bits) === JSON.stringify([[1, 0, 1, 1], [0, 1, 0, 1], [0, 0, 1, 1], [0, 0, 1, 0]]),
    `marker 0 bits ${JSON.stringify(bits)}`);
});

Deno.test('markers are numbered row-major over the white squares, starting next to square (0, 0)', () => {
  // Setup: the 23 x 17 board in OpenCV's current pattern: square (0, 0) black, so white squares
  // have row + col odd.
  // Test: list the marker squares.
  // Verifies: 195 markers (23 x 17 = 391 squares, 196 black); marker 0 sits in row 0, column 1,
  // marker 11 is the first of row 1 (in column 0), and the centre1 target's removed marker (97,
  // per the spec written by the scanner's board maker) is the one in the blanked cell (8, 11).
  const squares = markerSquares(centre1);
  assert(squares.length === 195, `markers: ${squares.length}`);
  assert(squares[0].row === 0 && squares[0].col === 1, 'marker 0 position');
  assert(squares[11].row === 1 && squares[11].col === 0, 'marker 11 position');
  const removed = squares.find((s) => s.id === centre1.removed_marker_ids[0]);
  assert(removed.row === centre1.target.cells_row_col[0][0] && removed.col === centre1.target.cells_row_col[0][1],
    `removed marker sits at ${removed.row}, ${removed.col}`);
});

Deno.test('the texture has paper, ink, a marker border, a blanked target cell and a grey ring where the spec puts them', () => {
  // Setup: the centre3x3 board drawn at 10 texels per mm (the finder's default), in print grey
  // levels and in linear reflectance.
  // Test: sample board points (mm, board frame: X down the page, Y right) chosen by hand.
  // Verifies:
  // - (5, 5) mm is the middle of square (0, 0): black ink (0);
  // - (5, 15) is square (0, 1), marker 0's middle: its top-left inner bit is 1 (white), and the
  //   marker spans 1.5 .. 8.5 mm with cells of 7/6 mm, so the inner bit (0, 0) covers
  //   X, Y in [row 0 + 1.5 + 7/6, + 7/6] = [2.67, 3.83] and Y in [11.5 + 1.17, ...];
  // - (2, 12) lies in that marker's black border (between 1.5 and 2.67 mm from the square's edge);
  // - (0.75, 10.75) is the white margin around the marker (inside the square, outside the marker);
  // - (72, 112) is in the blanked target cell (7, 11), which would otherwise be black (and clear
  //   of the rings at 5 and 10 mm from the centre and of the side ticks);
  // - a point on the 20 mm ring (10 mm from the centre) reads the ring's grey 150 / 255 in print
  //   levels, and linear(150 / 255) = 0.305 in the linear texture;
  // - outside the 5 mm paper pad the texture ends: its width is (230 + 10) mm x 10.
  const tex = renderBoardTexture(centre3x3, { ppm: 10 });
  const lin = renderBoardTexture(centre3x3, { ppm: 10, linear: true });
  assert(tex.width === 2400 && tex.height === 1800, `size ${tex.width} x ${tex.height}`);
  assertClose(sampleBoardTexture(tex, 5, 5), 0, 0.01, 'square (0, 0) is black');
  assertClose(sampleBoardTexture(tex, 2.67 + 0.58, 12.67 + 0.58), 1, 0.01, 'marker 0 bit (0, 0) is white');
  assertClose(sampleBoardTexture(tex, 2, 12), 0, 0.01, 'marker border is black');
  assertClose(sampleBoardTexture(tex, 0.75, 10.75), 1, 0.01, 'margin around the marker is paper');
  assertClose(sampleBoardTexture(tex, 72, 112), 1, 0.01, 'blanked target cell is paper');
  const [cx, cy] = centre3x3.target.centre_mm;
  assertClose(sampleBoardTexture(tex, cx + 10, cy), 150 / 255, 0.06, 'ring in print levels');
  assertClose(sampleBoardTexture(lin, cx + 10, cy), srgbToLinear(150 / 255), 0.06, 'ring in linear reflectance');
});

Deno.test('edge texels hold their exact area coverage', () => {
  // Setup: the centre1 board at 4 texels per mm with no pad, so texel u covers Y = u / 4 ..
  // (u + 1) / 4 mm. Marker 0 (square row 0, column 1) starts 1.5 mm into its square, at Y = 11.5.
  // Test: the texels either side of that edge: texel 46 covers Y 11.5 .. 11.75, all inside the
  // black border; texel 45 covers 11.25 .. 11.5, all paper. Then draw at 3 texels per mm, where
  // Y = 11.5 mm falls in the middle of texel 34 (11.33 .. 11.67).
  // Verifies: the box-filtered rendering, with no supersampling error: texel 34 at 3 texels per
  // mm is half ink, half paper (127 or 128 of 255).
  const t4 = renderBoardTexture(centre1, { ppm: 4, padMm: 0 });
  const row = 16; // X = 4.0 .. 4.25 mm: inside marker 0 (X 1.5 .. 8.5), where its left border column runs
  assert(t4.data[row * t4.width + 46] === 0, `texel 46: ${t4.data[row * t4.width + 46]}`);
  assert(t4.data[row * t4.width + 45] === 255, `texel 45: ${t4.data[row * t4.width + 45]}`);
  const t3 = renderBoardTexture(centre1, { ppm: 3, padMm: 0 });
  const v = t3.data[12 * t3.width + 34];
  assert(v === 127 || v === 128, `texel 34 at 3 texels per mm: ${v}`);
});

// --------------------------------------------------------------------------- geometry

/** A camera 200 mm above and in front of the target, looking at it, as the tests' pose. */
function testPose() {
  const target = [85, 115, 0];
  const C = [85 - 120, 115 + 30, 150];
  const norm = (v) => v.map((x) => x / Math.hypot(...v));
  const cross = (u, w) => [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const z = norm([target[0] - C[0], target[1] - C[1], target[2] - C[2]]);
  const x = norm(cross(z, [0, 0, 1]));
  const y = cross(z, x);
  const R = [...x, ...y, ...z];
  const t = [0, 1, 2].map((i) => -(R[3 * i] * C[0] + R[3 * i + 1] * C[1] + R[3 * i + 2] * C[2]));
  return {
    R,
    t,
    intrinsics: { width: 1920, height: 1080, f: 1500, cx: 960, cy: 540, k1: 0.06 },
  };
}

Deno.test('undistort inverts distort for phone-sized k1', () => {
  // Setup: normalised points out to the image corner of a 1920 x 1080, f = 1500 camera
  // (r ~ 0.73) and k1 = +-0.11 (the largest the scanner's captures fitted).
  // Test: distort, then undistort.
  // Verifies: the fixed-point inverse lands within 1e-6 of the start (a hundredth of a pixel
  // is 7e-6 here), for barrel and pincushion alike.
  for (const k1 of [0.11, -0.11, 0.05]) {
    for (const [x, y] of [[0.64, 0.36], [-0.3, 0.2], [0, 0], [0.5, -0.36]]) {
      const [xd, yd] = distort(x, y, k1);
      const [xu, yu] = undistort(xd, yd, k1);
      assertClose(xu, x, 1e-6, `x at k1 ${k1}`);
      assertClose(yu, y, 1e-6, `y at k1 ${k1}`);
    }
  }
});

Deno.test('a board point projected and cast back onto the board returns to itself', () => {
  // Setup: the test pose (oblique, k1 = 0.06) and board points around the target.
  // Test: projectPoint to pixels, then pixelToBoard back to the plane z = 0.
  // Verifies: projection and ray casting are inverse to 1e-6 mm, and the depth returned is the
  // point's camera z: the same geometry the GPU's prediction uses (PREDICT_FS mirrors
  // pixelToBoard).
  const pose = testPose();

  for (const P of [[85, 115, 0], [60, 90, 0], [110, 140, 0], [85, 160, 0]]) {
    const q = projectPoint(pose, P);
    const b = pixelToBoard(pose, q.x, q.y);
    assertClose(b.X, P[0], 1e-6, 'X');
    assertClose(b.Y, P[1], 1e-6, 'Y');
    assertClose(b.depth, q.z, 1e-6, 'depth');
  }
});

Deno.test('the target centre projects to the principal point when the camera looks straight at it', () => {
  // Setup: the test pose looks at (85, 115, 0) along its optical axis.
  // Test: project the target centre.
  // Verifies: it lands on (cx, cy) exactly (distortion is zero on the axis), so the pixel
  // convention (origin at the top-left pixel's corner, types.js) goes through untouched.
  const q = projectPoint(testPose(), [85, 115, 0]);
  assertClose(q.x, 960, 1e-9, 'x');
  assertClose(q.y, 540, 1e-9, 'y');
});

Deno.test('the bound cylinder projects to a convex hull that contains every rim point, and the crop is square around it', () => {
  // Setup: the default bound (radius 16 mm, 24 mm high) on the target, through the test pose.
  // Test: its projected hull, the line equations the GPU uses, and the crop with a 30 px margin.
  // Verifies: every projected rim point is inside or on the hull by all of its edge equations;
  // the crop is square, contains the hull with at least the margin on every side.
  const pose = testPose();
  const points = cylinderPoints([85, 115], 16, 24);
  const hull = projectHull(pose, points);
  const edges = convexEdges(hull);

  for (const P of points) {
    const q = projectPoint(pose, P);

    for (const [a, b, c] of edges) {
      assert(a * q.x + b * q.y + c >= -1e-6, 'rim point outside its own hull');
    }
  }

  const crop = cropAround(hull, 30);

  for (const [x, y] of hull) {
    assert(x >= crop.x + 30 - 1e-9 && x <= crop.x + crop.side - 30 + 1e-9, 'hull x inside the crop margin');
    assert(y >= crop.y + 30 - 1e-9 && y <= crop.y + crop.side - 30 + 1e-9, 'hull y inside the crop margin');
  }
});

Deno.test('a convex polygon rasterises to its area, at pixel centres', () => {
  // Setup: an axis-aligned square [10, 30] x [20, 40] and a triangle, in mask pixels.
  // Test: rasterConvex into a 64 x 64 mask; the hull of the triangle's corners first (so the
  // winding comes from convexHull).
  // Verifies: the square covers exactly 20 x 20 pixel centres (the half-open convention: centres
  // 10.5 .. 29.5); the triangle's pixel count is within its perimeter of its area (50 x 40 / 2).
  const square = rasterConvex([[10, 20], [30, 20], [30, 40], [10, 40]], 64);
  assert(square.reduce((a, b) => a + b, 0) === 400, 'square area');
  assert(square[20 * 64 + 10] === 1 && square[19 * 64 + 10] === 0 && square[20 * 64 + 30] === 0, 'square edges');
  const tri = rasterConvex(convexHull([[5, 5], [55, 5], [5, 45]]), 64);
  const count = tri.reduce((a, b) => a + b, 0);
  assert(Math.abs(count - 1000) < 70, `triangle area ${count}`);
});

// --------------------------------------------------------------------------- mask and outline

Deno.test('residual bytes expand back through the companding', () => {
  // Setup: the GPU packs a residual r as q = round(16 sqrt(r)).
  // Test: decode a 2 x 2 readback: three modelled pixels and one with alpha 255 (not modelled).
  // Verifies: r = (q / 16)^2 (q = 32 -> 4 grey levels, q = 255 -> 254); the level is alpha / 254;
  // the unmodelled pixel decodes to zeros and valid = 0.
  const bytes = new Uint8Array([
    32, 16, 0, 254, 255, 48, 16, 127, 0, 0, 0, 0, 9, 9, 9, 255,
  ]);
  const res = decodeResiduals(bytes, 2);
  assertClose(res.lum[0], 4, 1e-9, 'lum 32');
  assertClose(res.chroma[0], 1, 1e-9, 'chroma 16');
  assertClose(res.lum[1], expand(255), 1e-9, 'lum 255');
  assertClose(res.level[1], 127 / 254, 1e-9, 'level');
  assert(res.valid[0] === 1 && res.valid[2] === 1 && res.valid[3] === 0, 'valid flags');
  assert(res.lum[3] === 0, 'unmodelled pixel stays zero');
});

Deno.test('the noise model recovers a known floor and edge term', () => {
  // Setup: 4000 band pixels whose residual is exactly sqrt(c0 + c1 g^2) with c0 = 9 on paper
  // (level 0.9), c0 = 25 on ink (level 0.1) and c1 = 0.04. Half the pixels are flat (g = 0), the
  // rest spread over g = 10 .. 50, so the "flat" pixels the floors are measured on (g at or under
  // the median) are exactly the g = 0 ones, as in segment.noise_model.
  // Test: noiseModel (segment.noise_model's port).
  // Verifies: the floors come out per level class, exactly (their 90% quantile is the value
  // itself and the edge term is not subtracted at g = 0); the edge term is positive and near
  // 0.04 (fitted over gradient bins that mix ink and paper, so only loosely).
  const n = 4000;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const level = new Float32Array(n);
  const band = new Uint8Array(n).fill(1);

  for (let k = 0; k < n; k += 1) {
    g[k] = k < n / 2 ? 0 : 10 + (40 * ((k * 7919) % n)) / n;
    const ink = k % 2 === 0;
    level[k] = ink ? 0.1 : 0.9;
    r[k] = Math.sqrt((ink ? 25 : 9) + 0.04 * g[k] * g[k]);
  }

  const m = noiseModel(r, g, level, band, 2);
  assertClose(m.c0Dark, 25, 1e-3, 'dark floor');
  assertClose(m.c0Bright, 9, 1e-3, 'bright floor');
  assert(m.c1 > 0.02 && m.c1 < 0.06, `edge term ${m.c1}`);
});

Deno.test('too small a band falls back on the floor', () => {
  // Setup: 100 band pixels (the desktop needs 500 to calibrate).
  // Test: noiseModel with floor 2.
  // Verifies: both floors are 2^2 and there is no edge term, as on the desktop.
  const m = noiseModel(new Float32Array(100).fill(30), new Float32Array(100), new Float32Array(100), new Uint8Array(100).fill(1), 2);
  assert(m.c0Dark === 4 && m.c0Bright === 4 && m.c1 === 0, JSON.stringify(m));
});

Deno.test('evidence is the larger z-score over its threshold', () => {
  // Setup: noise models with floors of 2 grey levels (lum) and 1 (chroma), no edge term; one
  // pixel with a lum residual of 2 x 5 / 1.645 (exactly at T_LUM), one with a chroma residual of
  // 4 / 1.645 x 2 (twice T_CHROMA), one unmodelled.
  // Test: evidenceMap.
  // Verifies: E = 1 at the lum threshold, 2 at twice the chroma threshold, 0 where unmodelled.
  const res = {
    lum: new Float32Array([(2 * 5) / 1.645, 0, 50]),
    chroma: new Float32Array([0, (2 * 4) / 1.645, 50]),
    grad: new Float32Array(3),
    level: new Float32Array([0.5, 0.5, 0.5]),
    valid: new Uint8Array([1, 1, 0]),
  };
  const model = { c0Dark: 4, c0Bright: 4, c1: 0 };
  const E = evidenceMap(res, model, { c0Dark: 1, c0Bright: 1, c1: 0 });
  assertClose(E[0], 1, 1e-6, 'lum at threshold');
  assertClose(E[1], 2, 1e-6, 'chroma at twice the threshold');
  assert(E[2] === 0, 'unmodelled');
});

/** A size x size mask from a predicate on (x, y). */
function maskOf(size, inside) {
  const m = new Uint8Array(size * size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      m[y * size + x] = inside(x, y) ? 1 : 0;
    }
  }

  return m;
}

Deno.test('the 3 x 3 median removes specks and keeps a solid shape', () => {
  // Setup: a 10 x 10 square plus three isolated pixels on a 32 x 32 map.
  // Test: majority3 (the median of a binary map).
  // Verifies: the specks go; the square keeps its interior, losing only its 4 corners (a corner
  // pixel sees 4 of 9 set).
  const m = maskOf(32, (x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20) || (x === 3 && y === 3) || (x === 28 && y === 5) || (x === 5 && y === 28));
  const out = majority3(m, 32);
  assert(out[3 * 32 + 3] === 0 && out[5 * 32 + 28] === 0, 'specks removed');
  assert(out.reduce((a, b) => a + b, 0) === 96, `square keeps 100 - 4 corners: ${out.reduce((a, b) => a + b, 0)}`);
});

Deno.test('holes fill, components away from the core go, and the largest component is chosen', () => {
  // Setup: on 40 x 40, a ring (an annulus with a hole) around the centre, a separate blob in a
  // corner, and a core of 3 x 3 pixels in the ring's band.
  // Test: fillHoles, keepCore, largestComponent.
  // Verifies: the ring's hole is filled (a rock's silhouette has none); the corner blob does not
  // touch the core and is dropped; the largest component is the filled ring.
  const ring = maskOf(40, (x, y) => {
    const r = Math.hypot(x - 20, y - 20);
    return (r >= 6 && r <= 12) || (x < 4 && y < 4);
  });
  const filled = fillHoles(ring, 40);
  assert(filled[20 * 40 + 20] === 1, 'hole filled');
  const core = maskOf(40, (x, y) => x >= 20 && x < 23 && y >= 9 && y < 12);
  const kept = keepCore(filled, 40, core);
  assert(kept[1 * 40 + 1] === 0, 'corner blob dropped');
  assert(kept[20 * 40 + 20] === 1, 'ring kept');
  const big = largestComponent(filled, 40);
  assert(big.mask[1 * 40 + 1] === 0 && big.mask[20 * 40 + 20] === 1, 'largest is the ring');
});

Deno.test('maskFromEvidence: thresholds, keeps what touches the core, closes and fills', () => {
  // Setup: an evidence map with a solid disc of radius 8 over threshold (E = 2) with a 3-pixel
  // crack through it (E = 0; a 1-pixel crack would already go in the 3 x 3 median), a speck far
  // away, and a third piece: a blob beside the disc that does not touch the core. The core is a
  // band across the crack, so both halves of the disc reach it.
  // Test: maskFromEvidence with a closing radius of 2.
  // Verifies: the raw map (median, before closing) still shows the crack; the closing bridges it
  // so the disc comes back whole; the speck and the blob are dropped, because components are
  // kept by the core BEFORE closing (segment.mask_from_evidence's order: a piece only the
  // closing would join is not rock).
  const size = 48;
  const E = new Float32Array(size * size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (Math.hypot(x - 24, y - 24) <= 8 && (x < 23 || x > 25)) E[y * size + x] = 2;
      if (x >= 35 && x < 40 && y >= 20 && y < 26) E[y * size + x] = 2;
    }
  }

  E[3 * size + 3] = 5;
  const core = maskOf(size, (x, y) => x >= 19 && x < 30 && y >= 23 && y < 26);
  const { raw, mask } = maskFromEvidence(E, size, core, { closePx: 2 });
  assert(raw[24 * size + 24] === 0, 'raw keeps the crack');
  assert(mask[24 * size + 24] === 1, 'closing fills the crack');
  assert(mask[24 * size + 29] === 1, 'the right half is kept');
  assert(mask[22 * size + 37] === 0, 'the blob that misses the core is dropped');
  assert(mask[3 * size + 3] === 0, 'speck dropped');
});

Deno.test('the outline of a square is its four corners cut by half a pixel, clockwise, enclosing its area', () => {
  // Setup: a 10 x 6 rectangle of pixels at x 5..14, y 7..12 in a 32 x 32 mask.
  // Test: traceOutline.
  // Verifies: the polygon runs through the midpoints of the boundary pixel edges, so its corners
  // are cut diagonally: 8 vertices; its area is the 60 pixels less four half-pixel triangles
  // (60 - 4 x 0.125 = 59.5); positive shoelace area in image coordinates means clockwise on
  // screen (types.js's RockOutline.contour); every vertex lies on the rectangle's border.
  const m = maskOf(32, (x, y) => x >= 5 && x < 15 && y >= 7 && y < 13);
  const poly = traceOutline(m, 32);
  assert(poly.length === 8, `vertices: ${poly.length}`);
  assertClose(polygonArea(poly), 59.5, 1e-9, 'area');

  for (const [x, y] of poly) {
    assert(x >= 5 && x <= 15 && y >= 7 && y <= 13, `vertex ${x}, ${y} off the border`);
    assert(x === 5 || x === 15 || y === 7 || y === 13, `vertex ${x}, ${y} not on the border`);
  }
});

Deno.test('diagonally touching pixels stay one outline (8-connected rock)', () => {
  // Setup: two 3 x 3 blocks touching only at a corner: (2..4, 2..4) and (5..7, 5..7).
  // Test: traceOutline from the first block's top-left.
  // Verifies: the walk turns left at the shared corner and goes round both blocks: the polygon's
  // area is both blocks' (18 pixels, less the cut corners: 6 outer corners of 1/8 and the two
  // pinched ones), well over one block's 9, so the shape is not cut in two.
  const m = maskOf(16, (x, y) => (x >= 2 && x < 5 && y >= 2 && y < 5) || (x >= 5 && x < 8 && y >= 5 && y < 8));
  const poly = traceOutline(m, 16);
  const area = polygonArea(poly);
  assert(area > 16 && area <= 18, `area ${area}`);
});

Deno.test('outline refinement moves an outward-biased mask onto the half-rock line', () => {
  // Setup: a synthetic crop: board colour 200 everywhere, a "rock" of colour 60 covering
  // x < 30 (a vertical edge) whose edge pixel x = 30 is half rock (130). The prediction M is the
  // board, 200. The coarse mask, as a threshold on smoothed residuals would make it, reaches 3
  // pixels too far: x < 33.
  // Test: refineOutline with a band of 4 pixels.
  // Verifies: the mask's edge moves back to x < 30 or x < 31 (the half-rock pixel itself sits
  // at alpha 0.5, so either side is right); pixels well inside stay rock; pixels outside the
  // band are untouched.
  const size = 64;
  const frame = new Uint8Array(size * size * 4);
  const model = new Uint8Array(size * size * 4);
  const valid = new Uint8Array(size * size).fill(1);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const k = y * size + x;
      const v = x < 30 ? 60 : x === 30 ? 130 : 200;
      frame.set([v, v, v, 255], 4 * k);
      model.set([200, 200, 200, 255], 4 * k);
    }
  }

  const coarse = maskOf(size, (x) => x < 33);
  const { mask } = refineOutline(coarse, frame, model, valid, size, { bandPx: 4 });
  const row = 32 * size;
  assert(mask[row + 29] === 1 && mask[row + 10] === 1, 'inside stays rock');
  assert(mask[row + 31] === 0 && mask[row + 32] === 0, 'the 3 px of board come off');
  assert(mask[row + 50] === 0, 'outside stays board');
});

Deno.test('quantiles interpolate like numpy', () => {
  // Setup: the sorted values 0, 10, 20, 30.
  // Test: the 0, 0.5, 0.9 and 1 quantiles.
  // Verifies: numpy's default (linear between order statistics): 0, 15, 27, 30.
  const s = Float64Array.from([0, 10, 20, 30]);
  assert(quantileSorted(s, 0) === 0 && quantileSorted(s, 0.5) === 15, 'median');
  assertClose(quantileSorted(s, 0.9), 27, 1e-9, 'q90');
  assert(quantileSorted(s, 1) === 30, 'max');
});
