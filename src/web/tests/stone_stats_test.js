/*
 * stone_stats_test.js -- tests for web/src/lib/stone_stats.js, the facet count and the T/W, C/W
 * and P/W shown in the bottom right of the renderer.
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * HOW
 *   Each test writes a small stone as OBJ text by hand -- a square or rectangular "step cut":
 *   a flat table, four sloping crown facets, a vertical girdle band, and a four-sided pavilion
 *   down to a point -- so every ratio can be worked out on paper and written into the test. The
 *   real stones are checked against GemApp's own facet count over CDP against the built page.
 */

import { parseObj, facetsOf, girdleAxes, girdleCircle, stoneStats } from "../src/lib/stone_stats.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error("assertion failed: " + (message || ""));
  }
}

function assertClose(actual, expected, message) {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`assertion failed: ${message || ""}\n  actual:   ${actual}\n  expected: ${expected}`);
  }
}

/**
 * A step-cut stone as OBJ text, centred on the axis, optical axis +Z:
 *   - the girdle is a rectangle `girdleX` by `girdleY`, from z = 0 up to z = `girdleTop`;
 *   - the table is a rectangle `tableX` by `tableY` at z = `crownTop`;
 *   - the pavilion runs from z = 0 down to a point at z = -`pavilionDepth`.
 * With `triangles`, every face is split into triangles, as an exported .obj often is.
 */
function stepCut({ girdleX, girdleY, tableX, tableY, girdleTop, crownTop, pavilionDepth, triangles = false }) {
  const rect = (x, y, z) => [[-x / 2, -y / 2, z], [x / 2, -y / 2, z], [x / 2, y / 2, z], [-x / 2, y / 2, z]];
  const vertices = [
    ...rect(tableX, tableY, crownTop),   // 1-4   the table's corners
    ...rect(girdleX, girdleY, girdleTop), // 5-8   the top of the girdle
    ...rect(girdleX, girdleY, 0),        // 9-12  the bottom of the girdle
    [0, 0, -pavilionDepth],              // 13    the culet
  ];
  const faces = [[1, 2, 3, 4]];         // the table

  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    faces.push([5 + i, 5 + j, 1 + j, 1 + i]);  // a crown facet
    faces.push([9 + i, 9 + j, 5 + j, 5 + i]);  // a girdle facet
    faces.push([13, 9 + j, 9 + i]);            // a pavilion facet
  }

  const split = triangles
    ? faces.flatMap(face => face.slice(1, -1).map((_, k) => [face[0], face[k + 1], face[k + 2]]))
    : faces;

  return [
    ...vertices.map(v => `v ${v.join(" ")}`),
    ...split.map(face => `f ${face.join(" ")}`),
  ].join("\n");
}

Deno.test("a square step cut: 13 facets, and every ratio as worked out by hand", () => {
  // Setup: a 2 x 2 girdle, 0.2 tall; a 1 x 1 table 1 above the girdle's top (z = 1.2); a
  // pavilion 1 deep. So W = 2, the table's width along either axis is 1, the crown is 1 tall
  // (girdle top 0.2 to table 1.2) and the pavilion 1 deep (culet -1 to girdle bottom 0).
  const text = stepCut({ girdleX: 2, girdleY: 2, tableX: 1, tableY: 1, girdleTop: 0.2, crownTop: 1.2, pavilionDepth: 1 });

  // Test: work out the stats.
  const stats = stoneStats(text);

  // Verifies: table 1 + crown 4 + girdle 4 + pavilion 4 = 13 facets; T/W = 1/2, C/W = 1/2 and
  // P/W = 1/2 -- in particular the girdle's own 0.2 of height is in neither the crown nor the
  // pavilion.
  assert(stats.facets === 13, `facets ${stats.facets}`);
  assertClose(stats.tw, 0.5, "T/W");
  assertClose(stats.cw, 0.5, "C/W");
  assertClose(stats.pw, 0.5, "P/W");
});

Deno.test("a rectangle: W is the SHORT side, and the table is measured along the LONG one", () => {
  // Setup: a 4 x 2 girdle (long along x), with a 3 x 1 table, crown 0.8 tall above a 0.1
  // girdle and a pavilion 1.4 deep.
  const text = stepCut({ girdleX: 4, girdleY: 2, tableX: 3, tableY: 1, girdleTop: 0.1, crownTop: 0.9, pavilionDepth: 1.4 });

  // Test: the stats, and the axes on their own.
  const stats = stoneStats(text);
  const axes = girdleAxes(parseObj(text).vertices.map(v => [v[0], v[1]]));

  // Verifies: W is 2 (the short side, not 4), the long axis runs along x, and T/W is the
  // table's 3 along that axis over 2 -- not its 1 across it; C/W = 0.8/2, P/W = 1.4/2.
  assertClose(axes.width, 2, "W");
  assertClose(Math.abs(axes.longAxis[0]), 1, "long axis along x");
  assertClose(stats.tw, 1.5, "T/W");
  assertClose(stats.cw, 0.4, "C/W");
  assertClose(stats.pw, 0.7, "P/W");
});

Deno.test("a stone exported as triangles has the same facets and ratios", () => {
  // Setup: the square stone of the first test, with every face split into triangles (29 of
  // them), as a plain .obj export usually is.
  const params = { girdleX: 2, girdleY: 2, tableX: 1, tableY: 1, girdleTop: 0.2, crownTop: 1.2, pavilionDepth: 1 };
  const triangles = stepCut({ ...params, triangles: true });

  // Test: the faces the parser reads, and the stats.
  const faces = parseObj(triangles).faces.length;
  const stats = stoneStats(triangles);

  // Verifies: 2 (table) + 8 (crown) + 8 (girdle) + 4 (pavilion) = 22 triangles are read, and
  // grouped back by plane into the same 13 facets; the ratios are unchanged.
  assert(faces === 22, `triangles ${faces}`);
  assert(stats.facets === 13, `facets ${stats.facets}`);
  assertClose(stats.tw, 0.5, "T/W");
});

Deno.test("no table gives no T/W; a face wound backwards is still outward", () => {
  // Setup: an octahedron -- a crown and a pavilion of four facets each meeting at points, with
  // no table and no girdle band -- written with its crown faces wound one way and its pavilion
  // faces the other, so the winding says nothing about which side is out.
  const text = [
    "v 1 0 0", "v 0 1 0", "v -1 0 0", "v 0 -1 0", "v 0 0 1", "v 0 0 -1",
    "f 1 2 5", "f 2 3 5", "f 3 4 5", "f 4 1 5",
    "f 1 2 6", "f 2 3 6", "f 3 4 6", "f 4 1 6",
  ].join("\n");

  // Test: the facets and the stats.
  const facets = facetsOf(parseObj(text));
  const stats = stoneStats(text);

  // Verifies: 8 facets, four facing up and four down (the normals were turned outward); no
  // table, so T/W is null rather than 0; W is the square outline's flat-to-flat width, sqrt 2,
  // so C/W = P/W = 1/sqrt 2.
  assert(facets.filter(f => f.normal[2] > 0).length === 4, "four up");
  assert(facets.filter(f => f.normal[2] < 0).length === 4, "four down");
  assert(stats.facets === 8 && stats.tw === null, JSON.stringify(stats));
  assertClose(stats.cw, 1 / Math.SQRT2, "C/W");
  assertClose(stats.pw, 1 / Math.SQRT2, "P/W");
});

Deno.test("the girdle's circle: how far the stone reaches, and at what height", () => {
  // Setup: a 4 x 2 girdle running from z = 0 up to z = 0.3, with a table well inside it. The
  // stone reaches furthest at the girdle's four corners, (+/-2, +/-1), at both of those heights.
  // This is what the index dial is drawn round (index_dial.js), not one of the printed ratios.
  const text = stepCut({ girdleX: 4, girdleY: 2, tableX: 1, tableY: 1, girdleTop: 0.3, crownTop: 1, pavilionDepth: 1 });
  const mesh = parseObj(text);

  // Test: the circle on its own, and the fields the stats carry it in.
  const circle = girdleCircle(mesh.vertices);
  const stats = stoneStats(text);

  // Verifies: the radius is the distance to a girdle corner, sqrt(2^2 + 1^2) -- HALF the
  // longest axis, and deliberately not the short-axis width of 2 that W uses; and the height is
  // the middle of the girdle band (0 to 0.3), so a dial drawn there sits round the stone's waist
  // rather than at one of its edges. The stats report both.
  assertClose(circle.radius, Math.sqrt(5), "the girdle's radius");
  assertClose(circle.z, 0.15, "the middle of the girdle band");
  assertClose(stats.girdleRadius, Math.sqrt(5), "the stats carry the radius");
  assertClose(stats.girdleZ, 0.15, "the stats carry the height");

  // And a mesh with no width at all -- every point on the axis -- has no circle to draw.
  assert(girdleCircle([[0, 0, 1], [0, 0, -1]]) === null, "a stone with no width");
});

Deno.test("text with no stone in it gives no stats", () => {
  // Setup and test: empty text, and a lone triangle.
  // Verifies: null for both, which the overlay shows as nothing.
  assert(stoneStats("") === null, "empty");
  assert(stoneStats("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3") === null, "a triangle");
});
