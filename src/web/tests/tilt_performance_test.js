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
  graphPoints, nearestGraphPoint, pointLabel, labelBox, formatPercent, LABEL_CHAR_WIDTH,
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

// ---- the point under the pointer (T-0286)
//
// The user, 2026-09-28: "when mousing over the tilt performance graph can you show the nearest
// point's y value". TiltGraph.svelte asks nearestGraphPoint for the drawn point nearest the
// pointer's pixel, and labels it with pointLabel inside labelBox. These tests pin which point is
// chosen, where it is, and what the label says.
//
// Every test below uses ONE graph, worked out on paper so the expected pixels are plain numbers:
//
//   width 300  ->  plot 254 wide (300 - 36 left - 10 right) and round(254 x 0.68) = 173 tall,
//                  so the whole graph is 173 + 22 top + 24 bottom = 219 tall.
//   reach 10 degrees each way  ->  face-up (X 0 and Y 0, the same pose) in the middle at
//                  x = 36 + 127 = 163; X 10 at the plot's left edge, x = 36; Y 10 at its right
//                  edge, x = 36 + 254 = 290.
//   a value v  ->  y = 22 + (1 - v) x 173, so 100% at y = 22 and 0% at y = 195.
//
// Samples at 0 and 10 degrees on both halves. The four curves are set a tenth apart (17.3 px) so
// no two points of one pose are near each other, and each table (dotted) value is a tenth under
// its stone (solid) value:
//
//   stone: ISO 0.9, COS 0.6, Window 0.1, Head shadow 0.3
//   table: ISO 0.8, COS 0.5, Window 0.0, Head shadow 0.2
//
// with the 10-degree poses 0.05 lower than face-up, so the halves' ends are told apart too.

const HOVER_WIDTH = 300;
const HOVER_RANGE = { x: 10, y: 10 };
const PLOT_LEFT = 36;
const PLOT_TOP = 22;
const PLOT_W = 254;
const PLOT_H = 173;
const STONE = { iso: 0.9, cos: 0.6, window: 0.1, head: 0.3 };
const TABLE = { iso: 0.8, cos: 0.5, window: 0.0, head: 0.2 };

/** A pose's measurement: the values above, `drop` lower on every curve, the table well in view. */
function hoverSample(angle, drop) {
  const stone = ["iso", "cos", "window", "head"].map(key => STONE[key] - drop);
  const table = ["iso", "cos", "window", "head"].map(key => Math.max(TABLE[key] - drop, 0));

  return { angle, measurement: measured(stone, table, 5000) };
}

const HOVER_SAMPLES = {
  x: [hoverSample(0, 0), hoverSample(10, 0.05)],
  y: [hoverSample(0, 0), hoverSample(10, 0.05)],
};

/** The options TiltGraph hands nearestGraphPoint: every curve shown, dotted twins too. */
function hoverOptions(overrides = {}) {
  return {
    samples: HOVER_SAMPLES, range: HOVER_RANGE, width: HOVER_WIDTH, showTable: true,
    shown: { iso: true, cos: true, window: true, head: true }, ...overrides,
  };
}

/** Where a pose's value sits on the graph, by the arithmetic in the comment above. */
function pixelOf(axis, angle, value) {
  const across = axis === "x" ? (10 - angle) / 10 * 0.5 : 0.5 + angle / 10 * 0.5;

  return { x: PLOT_LEFT + across * PLOT_W, y: PLOT_TOP + (1 - value) * PLOT_H };
}

// Setup: the graph above, every curve and every dotted twin shown.
// Test: for each of the eight curves (four solid, four dotted) and each of its four measured
// points, put the pointer 3 px right and 2 px below the point -- close, but not exactly on it, as
// a hand is -- and ask nearestGraphPoint.
// Verifies: the chosen point is that very one (its curve, solid or dotted, its half and angle);
// that its pixel is exactly where graphSvg draws the curve's vertex (so the marker sits on the
// line, not beside it); and, as a check on the setup, that the graph's height is the 219 worked
// out above.
Deno.test("the pointer near any point of any curve picks that point", () => {
  assertEqual(graphHeight(HOVER_WIDTH), PLOT_H + PLOT_TOP + GRAPH_MARGIN.bottom, "the graph is 219 tall");

  const svg = graphSvg({ ...hoverOptions(), cursor: null, palette: {}, font: "f", mono: "m" }).markup;

  for (const table of [false, true]) {
    for (const key of ["iso", "cos", "window", "head"]) {
      for (const [axis, angle, drop] of [["x", 10, 0.05], ["x", 0, 0], ["y", 0, 0], ["y", 10, 0.05]]) {
        const value = (table ? TABLE : STONE)[key] - drop;
        const at = pixelOf(axis, angle, Math.max(value, 0));
        const point = nearestGraphPoint(hoverOptions(), at.x + 3, at.y + 2);
        const name = `${table ? "table" : "stone"} ${key} at ${axis} ${angle}`;

        assertEqual(point.key, key, `${name}: the curve`);
        assertEqual(point.table, table, `${name}: solid or dotted`);
        assertClose(point.x, at.x, `${name}: x`);
        assertClose(point.y, at.y, `${name}: y`);
        // Face-up is the same pixel on both halves; which half is named there is the tie rule's
        // business (tested below). Elsewhere the half and angle must be the point's own.
        if (angle !== 0) {
          assertEqual([point.axis, point.angle], [axis, angle], `${name}: the pose`);
        }
        // graphSvg draws the curves inside a group moved by the margins, so the vertex it writes
        // is the point less the margins, to two decimals.
        assert(svg.includes(`${(point.x - PLOT_LEFT).toFixed(2)} ${(point.y - PLOT_TOP).toFixed(2)}`),
          `${name}: graphSvg has a vertex exactly there`);
      }
    }
  }
});

// Setup: the graph above, with the pointer exactly on the solid COS curve's face-up point
// (0.6, y = 91.2), then the same pointer with COS switched off, then with the dotted twins off.
// Test: nearestGraphPoint under each set of switches, and graphPoints' list.
// Verifies: a curve switched off is never picked, solid or dotted -- with COS off the pointer,
// which sits right on COS's point, gets the next nearest drawn point instead: the dotted ISO at
// 0.8 (0.2 away, 34.6 px) rather than the solid head shadow at 0.3 (0.3 away). With the dotted
// curves off too, and the pointer 2 px higher, it gets the solid ISO at 0.9 above rather than the
// solid head shadow at 0.3 below (each 0.3 from COS -- as near as makes no difference in floating
// point, so the pointer is moved off the middle; ties have their own test). And no hidden curve or
// twin appears in the list of drawn points at all.
Deno.test("a curve switched off is never the nearest point", () => {
  const at = pixelOf("x", 0, STONE.cos);

  assertEqual(nearestGraphPoint(hoverOptions(), at.x, at.y).key, "cos", "COS shown: it is picked");

  const noCos = { iso: true, cos: false, window: true, head: true };
  const hidden = nearestGraphPoint(hoverOptions({ shown: noCos }), at.x, at.y);

  assertEqual([hidden.key, hidden.table], ["iso", true], "COS hidden: the dotted ISO, the next nearest");

  const solidOnly = nearestGraphPoint(hoverOptions({ shown: noCos, showTable: false }), at.x, at.y - 2);

  assertEqual([solidOnly.key, solidOnly.table], ["iso", false], "dotted curves hidden too: the solid ISO");

  const points = graphPoints(hoverOptions({ shown: noCos, showTable: false }));

  assert(points.every(point => point.key !== "cos"), "no COS point is drawn");
  assert(points.every(point => !point.table), "no dotted point is drawn");
  assertEqual(points.length, 3 * 4, "three curves, four points each");
  assertEqual(nearestGraphPoint(hoverOptions({ shown: { iso: false, cos: false, window: false, head: false } }), 100, 100),
    null, "nothing shown: no point, so no label");
});

// Setup: three ties. (1) Two curves with the same values, so their points are the same pixel.
// (2) A curve and its dotted twin with the same values. (3) The pointer exactly half way across
// between two points of one flat curve.
// Test: nearestGraphPoint in each case, asked twice, and with the tied curves' switches listed in
// the other order.
// Verifies: a tie is broken the same way every time, by the documented order and not by chance or
// by the order the caller happened to list its switches in: the key's order (ISO before COS), solid
// before dotted (the solid line is drawn over its twin), and the smaller angle first.
Deno.test("a tie is broken the same way every time", () => {
  // (1) and (2): every curve at 0.5 on every pose, stone and table alike.
  const flat = angle => ({ angle, measurement: measured([0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 5000) });
  const samples = { x: [flat(0), flat(10)], y: [flat(0), flat(10)] };
  const at = pixelOf("y", 10, 0.5);
  const first = nearestGraphPoint(hoverOptions({ samples }), at.x, at.y);

  assertEqual([first.key, first.table], ["iso", false], "ISO before the others, solid before dotted");
  assertEqual(nearestGraphPoint(hoverOptions({ samples }), at.x, at.y), first, "the same answer again");

  // The same switches, written in the opposite order: the answer must not follow the object's order.
  const reversed = { head: true, window: true, cos: true, iso: true };

  assertEqual(nearestGraphPoint(hoverOptions({ samples, shown: reversed }), at.x, at.y).key, "iso",
    "the key's order, not the switches' order");

  // (2) alone: only the window curve shown; its solid and dotted points coincide.
  const windowOnly = { iso: false, cos: false, window: true, head: false };

  assertEqual(nearestGraphPoint(hoverOptions({ samples, shown: windowOnly }), at.x, at.y).table, false,
    "solid before its dotted twin");

  // (3) Half way between X 10 (x = 36) and face-up (x = 163) on the flat line: 99.5, equally far
  // from both. The smaller angle comes first, so face-up; and face-up, being on both halves, is
  // named as Tilt X's, the half listed first.
  const between = nearestGraphPoint(hoverOptions({ samples, shown: windowOnly, showTable: false }), (36 + 163) / 2, at.y);

  assertEqual([between.axis, between.angle], ["x", 0], "the smaller angle, Tilt X's face-up");
});

// Setup: the graph above, with the pointer over each of its margins: the percentages on the left,
// the air on the right, the halves' names above, the angles below, and a corner.
// Test: nearestGraphPoint at those pixels.
// Verifies: the pointer over a margin (still over the graph, so the callers still read a pose) is
// still labelled, with the drawn point nearest it on screen: from the left margin, level with a
// point at the far end of Tilt X, that point; from the right margin, Tilt Y's far end; from above
// the plot, the highest point below the pointer; from below it, the lowest; from the top-left
// corner, the highest point at the left edge.
Deno.test("the pointer over a margin labels the point nearest it", () => {
  // Left margin, level with the solid COS point at X 10 (0.55).
  const cosLeft = pixelOf("x", 10, STONE.cos - 0.05);
  const left = nearestGraphPoint(hoverOptions(), 5, cosLeft.y);

  assertEqual([left.key, left.table, left.axis, left.angle], ["cos", false, "x", 10], "left margin");

  // Right margin, level with the solid window point at Y 10 (0.05).
  const windowRight = pixelOf("y", 10, STONE.window - 0.05);
  const right = nearestGraphPoint(hoverOptions(), HOVER_WIDTH - 2, windowRight.y);

  assertEqual([right.key, right.table, right.axis, right.angle], ["window", false, "y", 10], "right margin");

  // Above the plot, over face-up: the highest point there is the solid ISO at 0.9.
  const top = nearestGraphPoint(hoverOptions(), 163, 3);

  assertEqual([top.key, top.table, top.angle], ["iso", false, 0], "top margin");

  // Below the plot, over Y 10: the lowest point there is the dotted window, 0 (held at 0).
  const bottom = nearestGraphPoint(hoverOptions(), 290, 215);

  assertEqual([bottom.key, bottom.table, bottom.axis, bottom.angle], ["window", true, "y", 10], "bottom margin");

  // The top-left corner: the highest point at the left edge, the solid ISO at X 10 (0.85).
  const corner = nearestGraphPoint(hoverOptions(), 0, 0);

  assertEqual([corner.key, corner.table, corner.axis, corner.angle], ["iso", false, "x", 10], "corner");
});

// Setup: the graph above, with the pointer on the solid head shadow at Y 10 and on the dotted
// COS at face-up; and a lone point whose value, 0.8349, rounds.
// Test: nearestGraphPoint's value, and pointLabel's text.
// Verifies: the value the label shows is the measurement's own number for that curve, pose and
// solid-or-dotted -- the very one the readouts beside the graph show -- printed with the readouts'
// precision (formatPercent, one decimal): a solid point's as it is, a dotted point's in brackets,
// as the readouts write the table's.
Deno.test("the label shows the point's own measured value, as the readouts print it", () => {
  const headAt = pixelOf("y", 10, STONE.head - 0.05);
  const head = nearestGraphPoint(hoverOptions(), headAt.x, headAt.y);

  assertEqual(head.value, HOVER_SAMPLES.y[1].measurement.stone.head, "the stone's head shadow at Y 10");
  assertEqual(pointLabel(head), "25.0%", "printed as the readout prints it");
  assertEqual(pointLabel(head), formatPercent(HOVER_SAMPLES.y[1].measurement.stone.head), "formatPercent's text");

  const cosAt = pixelOf("x", 0, TABLE.cos);
  const cos = nearestGraphPoint(hoverOptions(), cosAt.x, cosAt.y);

  assertEqual(cos.value, HOVER_SAMPLES.x[0].measurement.table.cos, "the table's COS at face-up");
  assertEqual(pointLabel(cos), "(50.0%)", "a dotted point's value in brackets");

  const lone = { x: [{ angle: 0, measurement: measured([0.8349, 0, 0, 0], [0, 0, 0, 0], 0) }], y: [] };
  const only = nearestGraphPoint(hoverOptions({ samples: lone, shown: { iso: true } }), 0, 0);

  assertEqual(pointLabel(only), "83.5%", "rounded to one decimal, as the readouts do");
});

// Setup: a label of "(50.0%)" (7 characters, so 7 x LABEL_CHAR_WIDTH + 10 wide and 17 tall) for
// points in the middle of the graph, at its right edge, at its top, and in its top-right corner.
// Test: labelBox.
// Verifies: the label goes above and to the right of its point, 7 px clear, so the pointer (at the
// point) does not cover it; it flips to the left at the right edge and below at the top; and it is
// always wholly inside the graph, so it is never cut off.
Deno.test("the label sits beside its point and stays inside the graph", () => {
  const text = "(50.0%)";
  const boxW = 7 * LABEL_CHAR_WIDTH + 10;
  const inside = box => box.x >= 0 && box.y >= 0 && box.x + box.width <= HOVER_WIDTH && box.y + box.height <= 219;

  const middle = labelBox({ x: 150, y: 100 }, text, HOVER_WIDTH, 219);

  assertClose(middle.width, boxW, "the text's width plus padding");
  assertEqual([middle.x, middle.y], [157, 100 - 7 - 17], "above and to the right");

  const rightEdge = labelBox({ x: 290, y: 100 }, text, HOVER_WIDTH, 219);

  assertClose(rightEdge.x, 290 - 7 - boxW, "flipped to the left of the point");

  const topEdge = labelBox({ x: 150, y: 22 }, text, HOVER_WIDTH, 219);

  assertEqual(topEdge.y, 22 + 7, "flipped below the point");

  for (const [x, y] of [[150, 100], [290, 100], [150, 22], [290, 22], [36, 195], [0, 219], [300, 0]]) {
    assert(inside(labelBox({ x, y }, text, HOVER_WIDTH, 219)), `inside the graph for a point at ${x}, ${y}`);
  }
});
