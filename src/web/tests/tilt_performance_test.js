/*
 * tilt_performance_test.js -- tests for src/web/src/lib/tilt_performance.js, the pure half of
 * Tools > Tilt performance (T-0261): the poses swept, how a measurement is read, and where it
 * lands on the graph.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * HOW
 *   Every case is small enough to work out on paper: a sweep of a few degrees, a measurement
 *   written as the ten numbers GemApp::measure_tilt_pose returns, a graph box of round size. What
 *   the numbers themselves come to on a real stone is checked against Gem Cut Studio's own graphs
 *   over CDP against the built page (kb/tilt-performance.md).
 */

import {
  TILT_RANGE, TILT_RANGE_MIN, TILT_RANGE_MAX, Y_SPIN, MIN_TABLE_PIXELS, MEASURED_PARAMS,
  sweepPoses, readMeasurement, graphX, poseAtGraphX, middleX, viewPose, curvePath, sampleNearest,
  angleTicks, clampRange, measurementKey, graphSvg, graphHeight, graphImageSvg, GRAPH_MARGIN,
} from "../src/lib/tilt_performance.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error("assertion failed: " + (message || ""));
  }
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  assert(a === e, `${message || ""}: expected ${e}, got ${a}`);
}

function assertClose(actual, expected, message) {
  assert(Math.abs(actual - expected) < 1e-9, `${message || ""}: expected ${expected}, got ${actual}`);
}

/** A measurement as GemApp returns it: stone iso/cos/window/head, table the same, then counts. */
function measured(stone, table, tablePixels) {
  return readMeasurement([...stone, ...table, 1000, tablePixels]);
}

// Setup: the default sweep, and a short one of 0..2 degrees in steps of 1.
// Test: sweepPoses.
// Verifies: the sweep is Gem Cut Studio's -- Tilt X first, from face-up out, then Tilt Y the
// same way; each half includes face-up and its far end; X is a plain tilt and Y the tilt after a
// quarter-turn spin; the default reaches 33 degrees in whole degrees.
Deno.test("the sweep tilts X from face-up out, then Y, each half including face-up", () => {
  assertEqual(sweepPoses({ x: 2, y: 2 }, 1), [
    { axis: "x", angle: 0, spin: 0, tilt: 0 },
    { axis: "x", angle: 1, spin: 0, tilt: 1 },
    { axis: "x", angle: 2, spin: 0, tilt: 2 },
    { axis: "y", angle: 0, spin: Y_SPIN, tilt: 0 },
    { axis: "y", angle: 1, spin: Y_SPIN, tilt: 1 },
    { axis: "y", angle: 2, spin: Y_SPIN, tilt: 2 },
  ], "short sweep");

  const full = sweepPoses();

  assertEqual(TILT_RANGE, 33, "the user's range");
  assertEqual(full.length, 2 * 34, "33 degrees, one pose a degree, face-up on both halves");
  assertEqual(full[33], { axis: "x", angle: 33, spin: 0, tilt: 33 }, "X ends at 33");
  assertEqual(full[67], { axis: "y", angle: 33, spin: Y_SPIN, tilt: 33 }, "Y ends at 33");
});

// Setup: two measurements, one with the table well in view and one with only a sliver of it.
// Test: readMeasurement.
// Verifies: the ten numbers are named in GemApp's order, and a table below MIN_TABLE_PIXELS is
// no table at all (null), so its dotted curves break there instead of plotting noise.
Deno.test("a measurement names its ten numbers, and a sliver of table counts as none", () => {
  const seen = measured([0.9, 0.7, 0.08, 0.02], [0.98, 0.83, 0.01, 0.0], 12000);

  assertEqual(seen.stone, { iso: 0.9, cos: 0.7, window: 0.08, head: 0.02 }, "stone");
  assertEqual(seen.table, { iso: 0.98, cos: 0.83, window: 0.01, head: 0.0 }, "table");
  assertEqual(seen.stonePixels, 1000, "stone pixels");

  const sliver = measured([0.9, 0.7, 0.08, 0.02], [0.5, 0.5, 0.5, 0.5], MIN_TABLE_PIXELS - 1);

  assert(sliver.table === null, "a sliver of table is not averaged");
});

// Setup: poses at face-up, half the range and the full range on each half.
// Test: graphX, and poseAtGraphX on its results; viewPose on each half.
// Verifies: Tilt X runs from the left edge (full range) to the middle (face-up) and Tilt Y from
// the middle to the right edge; the two functions invert each other; out-of-range positions are
// clamped; and a Y pose is shown as the quarter-turn spin plus the tilt.
Deno.test("the graph puts Tilt X on the left, outward, and Tilt Y on the right", () => {
  assertClose(graphX("x", 0), 0.5, "face-up, X");
  assertClose(graphX("y", 0), 0.5, "face-up, Y");
  assertClose(graphX("x", TILT_RANGE), 0, "X at full range is the left edge");
  assertClose(graphX("y", TILT_RANGE), 1, "Y at full range is the right edge");
  assertClose(graphX("x", TILT_RANGE / 2), 0.25, "X halfway");
  assertClose(graphX("y", 99), 1, "clamped");

  for (const [axis, angle] of [["x", 10], ["y", 20], ["x", 33]]) {
    const back = poseAtGraphX(graphX(axis, angle));

    assertEqual(back.axis, axis, `axis of ${axis} ${angle}`);
    assertClose(back.angle, angle, `angle of ${axis} ${angle}`);
  }

  assertEqual(poseAtGraphX(-1), { axis: "x", angle: TILT_RANGE }, "left of the graph");
  assertEqual(viewPose({ axis: "x", angle: 12 }), { spin: 0, tilt: 12 }, "X view");
  assertEqual(viewPose({ axis: "y", angle: 12 }), { spin: Y_SPIN, tilt: 12 }, "Y view");
});

// Setup: a 330 x 100 box and samples at 0 and 33 degrees on each half; the table is out of view
// at X 33.
// Test: curvePath for the stone's ISO curve and the table's.
// Verifies: the line runs left to right (X 33, X 0, Y 0, Y 33) with 100% at the top; the table's
// line lifts its pen where the table is out of view instead of joining across; and nothing
// measured yet draws nothing.
Deno.test("a curve runs left to right, and the table's breaks where it is out of view", () => {
  const samples = {
    x: [
      { angle: 0, measurement: measured([0.9, 0, 0, 0], [1, 0, 0, 0], 5000) },
      { angle: 33, measurement: measured([0.7, 0, 0, 0], [0, 0, 0, 0], 0) },
    ],
    y: [
      { angle: 0, measurement: measured([0.9, 0, 0, 0], [1, 0, 0, 0], 5000) },
      { angle: 33, measurement: measured([0.8, 0, 0, 0], [0.5, 0, 0, 0], 5000) },
    ],
  };

  assertEqual(
    curvePath(samples, "iso", false, 330, 100),
    "M0.00 30.00L165.00 10.00L165.00 10.00L330.00 20.00",
    "stone ISO",
  );
  assertEqual(
    curvePath(samples, "iso", true, 330, 100),
    "M165.00 0.00L165.00 0.00L330.00 50.00",
    "table ISO starts once the table is in view",
  );
  assertEqual(curvePath({ x: [], y: [] }, "iso", false, 330, 100), "", "nothing measured");
});

// Setup: samples at 0, 5 and 10 degrees on the X half only.
// Test: sampleNearest.
// Verifies: the readout takes the closest angle on the pose's own half, and has nothing for a
// half not yet measured.
Deno.test("the readout shows the nearest sample on the pose's own half", () => {
  const sample = angle => ({ angle, measurement: measured([angle / 100, 0, 0, 0], [0, 0, 0, 0], 0) });
  const samples = { x: [sample(0), sample(5), sample(10)], y: [] };

  assertEqual(sampleNearest(samples, { axis: "x", angle: 6.9 }).angle, 5, "6.9 is nearest 5");
  assertEqual(sampleNearest(samples, { axis: "x", angle: 8 }).angle, 10, "8 is nearest 10");
  assert(sampleNearest(samples, { axis: "y", angle: 3 }) === null, "Y not measured yet");
});

// Setup: a sweep reaching 2 degrees on Tilt X and 3 on Tilt Y.
// Test: sweepPoses with the two halves' reaches different.
// Verifies: each half runs out to its own reach -- the start and end angles of the panel's range
// slider -- rather than both to one shared range.
Deno.test("each half of the sweep runs out to its own reach", () => {
  const poses = sweepPoses({ x: 2, y: 3 }, 1);

  assertEqual(poses.filter(p => p.axis === "x").map(p => p.angle), [0, 1, 2], "X to 2");
  assertEqual(poses.filter(p => p.axis === "y").map(p => p.angle), [0, 1, 2, 3], "Y to 3");
});

// Setup: a graph reaching 10 degrees on Tilt X and 30 on Tilt Y.
// Test: middleX, graphX and poseAtGraphX with the two reaches different.
// Verifies: face-up sits a quarter of the way across, so a degree is the same width on both
// sides; each half's reach is its edge; and the two functions still invert each other on both
// halves.
Deno.test("with different reaches, a degree is as wide on both halves", () => {
  const range = { x: 10, y: 30 };

  assertClose(middleX(range), 0.25, "face-up at a quarter");
  assertClose(graphX("x", 10, range), 0, "X 10 is the left edge");
  assertClose(graphX("x", 5, range), 0.125, "X 5 is halfway to the middle");
  assertClose(graphX("y", 30, range), 1, "Y 30 is the right edge");
  assertClose(graphX("y", 15, range), 0.625, "Y 15 is halfway out");

  // One degree either side of face-up is the same distance from it.
  assertClose(graphX("y", 1, range) - middleX(range), middleX(range) - graphX("x", 1, range), "equal degrees");

  for (const [axis, angle] of [["x", 7], ["y", 22]]) {
    const back = poseAtGraphX(graphX(axis, angle, range), range);

    assertEqual(back.axis, axis, `axis of ${axis} ${angle}`);
    assertClose(back.angle, angle, `angle of ${axis} ${angle}`);
  }
});

// Setup: samples out to 33 degrees on both halves, drawn with the reach cut to 10 on each.
// Test: curvePath and sampleNearest with a narrower reach than was measured.
// Verifies: samples beyond the reach are left off the graph (they stay measured for when the
// reach grows again), so the line ends exactly at each edge; and the readout never picks a
// sample beyond the reach.
Deno.test("samples beyond the reach are kept but not drawn", () => {
  const sample = angle => ({ angle, measurement: measured([0.5, 0, 0, 0], [0, 0, 0, 0], 0) });
  const samples = { x: [sample(0), sample(10), sample(33)], y: [sample(33), sample(0), sample(10)] };
  const range = { x: 10, y: 10 };

  assertEqual(
    curvePath(samples, "iso", false, 200, 100, range),
    "M0.00 50.00L100.00 50.00L100.00 50.00L200.00 50.00",
    "X 10, X 0, Y 0, Y 10 -- in angle order whatever order they were measured in",
  );
  assertEqual(sampleNearest(samples, { axis: "y", angle: 30 }, range).angle, 10, "33 is beyond reach");
});

// Setup: reaches either side of ten degrees, and values beyond the slider's limits.
// Test: angleTicks and clampRange.
// Verifies: the angles are labelled every ten degrees out to the reach (a reach under ten gets
// its own label, so the half is never unlabelled); and a reach is always whole degrees within the
// slider's limits.
Deno.test("angles are labelled every ten degrees, and a reach is clamped to whole degrees", () => {
  assertEqual(angleTicks(33), [10, 20, 30], "33");
  assertEqual(angleTicks(40), [10, 20, 30, 40], "40 includes its own end");
  assertEqual(angleTicks(7), [7], "under ten");

  assertEqual(clampRange(33.4), 33, "rounded");
  assertEqual(clampRange(0), TILT_RANGE_MIN, "at least the minimum");
  assertEqual(clampRange(90), TILT_RANGE_MAX, "at most the maximum");
  assertEqual(clampRange(NaN), TILT_RANGE, "nonsense is the default");
});

// Setup: a table of parameter values read through a getter.
// Test: measurementKey, before and after changing the head shadow, and a setting not measured.
// Verifies: the key changes with the head shadow angle (which must re-measure the graph) and not
// with a setting the measurement overrides anyway (exposure).
Deno.test("the measurement key follows the head shadow, not the exposure", () => {
  const params = { headShadowHalfAngle: 15, refractiveIndex: 2.16, dispersion: 0.06, maxBounces: 12, observerRadius: 1, exposure: 1 };
  const key = () => measurementKey(name => params[name]);
  const before = key();

  assert(MEASURED_PARAMS.includes("headShadowHalfAngle"), "the head shadow is measured");
  params.exposure = 2;
  assertEqual(key(), before, "exposure is not");
  params.headShadowHalfAngle = 20;
  assert(key() !== before, "a new head shadow angle is a new key");
});

// Setup: two samples on each half, every curve shown, a cursor at Y 10, drawn 300 pixels wide
// with a palette of plain names.
// Test: graphSvg's markup.
// Verifies: the height follows the width; each curve is drawn once solid and once dotted, in its
// own colour; the grid is labelled 0% to 100% and every ten degrees, with 0 once in the middle;
// the cursor draws its line and one dot per curve; and hiding a curve, or the table, removes
// exactly its lines.
Deno.test("the graph draws each shown curve solid and dotted, the grid, and the cursor", () => {
  const sample = angle => ({ angle, measurement: measured([0.9, 0.7, 0.1, 0.05], [0.95, 0.8, 0.02, 0.01], 5000) });
  const samples = { x: [sample(0), sample(10)], y: [sample(0), sample(10)] };
  const palette = { iso: "ISO", cos: "COS", window: "WIN", head: "HEAD", grid: "GRID", middle: "MID", axis: "AXIS", cursor: "CUR", surface: "SURF" };
  const options = {
    samples, range: { x: 33, y: 33 }, shown: { iso: true, cos: true, window: true, head: true },
    showTable: true, cursor: { axis: "y", angle: 10 }, width: 300, palette, font: "sans", mono: '"SF Mono", mono',
  };
  const graph = graphSvg(options);
  const count = (text, part) => text.split(part).length - 1;

  assertEqual(graph.height, graphHeight(300), "height from the width");
  assertEqual(graphHeight(300), Math.round((300 - GRAPH_MARGIN.left - GRAPH_MARGIN.right) * 0.68) + GRAPH_MARGIN.top + GRAPH_MARGIN.bottom, "0.68 of the plot's width");

  for (const colour of ["ISO", "COS", "WIN", "HEAD"]) {
    assertEqual(count(graph.markup, `stroke:${colour};stroke-width:1.75`), 1, `${colour} solid`);
    assertEqual(count(graph.markup, `stroke:${colour};stroke-width:1.5`), 1, `${colour} dotted`);
    assertEqual(count(graph.markup, `fill:${colour};`), 1, `${colour} cursor dot`);
  }

  for (const label of ["0%", "20%", "100%", ">10°<", ">20°<", ">30°<", "TILT X", "TILT Y"]) {
    assert(graph.markup.includes(label), `labelled ${label}`);
  }

  assertEqual(count(graph.markup, ">0°<"), 1, "face-up labelled once");
  assertEqual(count(graph.markup, "stroke:CUR"), 1, "one cursor line");
  assert(graph.markup.includes("&quot;SF Mono&quot;"), "a quoted font family is escaped inside the attribute");

  const fewer = graphSvg({ ...options, shown: { iso: true, cos: false, window: true, head: true }, showTable: false, cursor: null });

  assertEqual(count(fewer.markup, "stroke:COS"), 0, "COS hidden");
  assertEqual(count(fewer.markup, "stroke-dasharray"), 0, "no dotted lines");
  assertEqual(count(fewer.markup, "stroke:CUR"), 0, "no cursor");
});

// Setup: the same samples, drawn as a picture 720 pixels wide with a title that needs escaping.
// Test: graphImageSvg.
// Verifies: it is a complete SVG document of the width asked for, on the background given, with
// the title escaped, the subtitle, a legend entry for each curve shown (the head shadow's with
// its angle) and for the table, and no cursor, whatever the options say.
Deno.test("the downloaded picture has a title, the graph and a legend, and no cursor", () => {
  const sample = angle => ({ angle, measurement: measured([0.9, 0.7, 0.1, 0.05], [0.95, 0.8, 0.02, 0.01], 5000) });
  const palette = { iso: "ISO", cos: "COS", window: "WIN", head: "HEAD", grid: "GRID", middle: "MID", axis: "AXIS", cursor: "CUR", surface: "SURF" };
  const svg = graphImageSvg({
    samples: { x: [sample(0), sample(10)], y: [sample(0)] }, range: { x: 33, y: 33 },
    shown: { iso: true, cos: false, window: true, head: true }, showTable: true,
    cursor: { axis: "x", angle: 10 }, width: 720, palette, font: "sans", mono: "mono",
    title: "Hex <v2> & co", subtitle: "Head shadow 15°", background: "BG", text: "TEXT", headShadow: 15,
  });

  assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="720"'), "an SVG document 720 wide");
  assert(svg.includes("fill:BG"), "the background");
  assert(svg.includes("Hex &lt;v2&gt; &amp; co"), "the title, escaped");
  assert(svg.includes("Head shadow 15°<"), "the subtitle");

  for (const entry of ["ISO brightness", "Window", "Head shadow (15°)", "Table alone (dotted)"]) {
    assert(svg.includes(`>${entry}</text>`), `legend: ${entry}`);
  }

  assert(!svg.includes("COS brightness"), "no legend for a hidden curve");
  assert(!svg.includes("stroke:CUR"), "no cursor");
});
