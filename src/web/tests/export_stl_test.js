/*
 * export_stl_test.js -- tests for web/src/lib/export_stl.js, T-0205's OBJ-to-binary-STL
 * triangulator (File > Export > STL (.stl)).
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * export_stl.js's own doc comment explains the two things worth pinning down structurally,
 * since STL is write-only here (nothing in this project reads one back to round-trip through):
 *   1. `designToStlBytes` writes the binary STL layout exactly (80-byte header, a little-endian
 *      uint32 triangle count, then 50 bytes per triangle: 3 float32 normal components, 3x3
 *      float32 vertex components, a little-endian uint16 attribute count of 0) -- checked below
 *      against a small, hand-built OBJ fixture (a tetrahedron) whose triangle count, byte length
 *      and at least one triangle's normal can be worked out by hand and checked, not just
 *      trusted.
 *   2. Fed a REAL sample design (one of reference/gemcad-file-reader/Samples/*.asc, parsed the
 *      way this project's own loader does), the same function produces a sane, non-empty
 *      triangle soup -- a smoke test against real data, not just a hand-built shape.
 *
 * Only `designToStlBytes` (and the small parsing helpers it is built from) are exercised here:
 * `exportCurrentStoneAsStl` and `currentObjText`, the page-only wrapper that reaches `getDesign()`
 * and triggers a browser download, need a live design and a DOM and are out of scope for a
 * Deno-only unit test (matching this project's existing pattern -- see e.g.
 * edit_geometry_test.js's own header comment on what it does and does not cover).
 */

import {
  designToStlBytes, parseObjForStl, fanTriangulate, filenameFromCutName,
} from "../src/lib/export_stl.js";

// ---------------------------------------------------------------------------
// Assertions -- the same minimal, dependency-free helpers every other test file here already
// uses (lib_test.js, edit_geometry_test.js, ...), so this suite needs nothing extra installed.
// ---------------------------------------------------------------------------

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

function assertEquals(actual, expected, message) {
  assert(actual === expected, `${message || "assertEquals"}: expected ${expected}, got ${actual}`);
}

function assertClose(actual, expected, tolerance, message) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${message || "assertClose"}: expected ${expected} +/- ${tolerance}, got ${actual}`,
  );
}

// ---------------------------------------------------------------------------
// The GemCad scripts, loaded the way the page loads them (a classic script publishing globals) --
// the same pattern edit_geometry_test.js and index_dial_test.js already use. gemcad.js and
// design.js read a real sample design; gemcad_obj.js and design_mesh.js are pulled in too since
// design_mesh.js's own `toObjText` (used below) reaches back into gemcad_obj.js's helpers.
// ---------------------------------------------------------------------------

const SCRIPTS = new URL("../../js/", import.meta.url);
const SAMPLES = new URL("../../../reference/gemcad-file-reader/Samples/", import.meta.url);

for (const name of ["gemcad.js", "gemcad_obj.js", "design.js", "design_mesh.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(name, SCRIPTS)));
}

const { GemCad, GemCadDesign, DesignMesh } = globalThis;

/*
 * reference/ is third-party data -- the bundled GemCad sample designs among it -- several hundred
 * megabytes of it, deliberately gitignored, so a fresh clone of this repository has none of it and
 * the suite still has to be green there. Part 2's two smoke tests, the only ones here that read a
 * sample, are marked `{ ignore: !SAMPLES_PRESENT }` and report as ignored on a clean checkout
 * rather than erroring on a missing file; with the data present they run exactly as before. Part
 * 1's hand-built tetrahedron and quad fixtures need no files at all and are never gated.
 */
const SAMPLES_PRESENT = (() => {
  try {
    Deno.statSync(SAMPLES);
    return true;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Binary layout helpers, for reading back what designToStlBytes wrote -- a plain DataView over
// the returned Uint8Array's own buffer, little-endian throughout, matching the format.
// ---------------------------------------------------------------------------

const HEADER_BYTES = 80;
const TRIANGLE_BYTES = 50;

/** The byte offset of triangle `i`'s own record (its normal, then its 3 vertices, then its
 * 2-byte attribute count), counting from 0. */
function triangleOffset(i) {
  return HEADER_BYTES + 4 + TRIANGLE_BYTES * i;
}

/** Reads triangle `i` back out of `bytes` as `{ normal: [x,y,z], vertices: [[x,y,z] x3] }`, for
 * checking what designToStlBytes actually wrote, not merely trusting it. */
function readTriangle(bytes, i) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = triangleOffset(i);

  const normal = [0, 1, 2].map(() => {
    const value = view.getFloat32(offset, true);

    offset += 4;
    return value;
  });

  const vertices = [0, 1, 2].map(() =>
    [0, 1, 2].map(() => {
      const value = view.getFloat32(offset, true);

      offset += 4;
      return value;
    })
  );

  return { normal, vertices };
}

// ===========================================================================
// Part 1: a hand-built fixture -- a single tetrahedron, 4 vertices, 4 triangular faces.
// ===========================================================================

/*
 * Setup: a tetrahedron with one vertex at the origin and the other three one unit out along
 * each axis --
 *
 *   v1 = (0, 0, 0)   v2 = (1, 0, 0)   v3 = (0, 1, 0)   v4 = (0, 0, 1)
 *
 * -- and its 4 triangular faces, one per combination of 3 of the 4 vertices (OBJ's 1-based
 * numbering):
 *
 *   f1: 1 2 3   (v1, v2, v3) -- lies flat in the z=0 plane
 *   f2: 1 2 4   (v1, v2, v4) -- lies flat in the y=0 plane
 *   f3: 1 3 4   (v1, v3, v4) -- lies flat in the x=0 plane
 *   f4: 2 3 4   (v2, v3, v4) -- the slanted face opposite the origin
 *
 * Every face is already a triangle (no fan triangulation needed here; that is exercised
 * separately, below, with a quad), so designToStlBytes's own triangle count must be exactly 4,
 * one per face, in file order.
 *
 * f1's normal is worked out by hand: the two edges out of v1 are (v2 - v1) = (1, 0, 0) and
 * (v3 - v1) = (0, 1, 0), whose cross product is (0*0 - 0*1, 0*0 - 1*0, 1*1 - 0*0) = (0, 0, 1) --
 * already a unit vector pointing straight along +z. That is the direction the test checks f1's
 * stored normal against below (by dot product, not exact equality, since designToStlBytes
 * re-derives it through float32 arithmetic).
 */
const TETRAHEDRON_OBJ = [
  "v 0 0 0",
  "v 1 0 0",
  "v 0 1 0",
  "v 0 0 1",
  "f 1 2 3",
  "f 1 2 4",
  "f 1 3 4",
  "f 2 3 4",
  "",
].join("\n");

Deno.test("designToStlBytes: tetrahedron fixture has the exact expected byte length", () => {
  const bytes = designToStlBytes(TETRAHEDRON_OBJ);

  // Test: 4 triangular faces, no fan triangulation needed, so exactly 4 triangles.
  // Verifies: the binary layout's own size formula, 80-byte header + 4-byte count +
  // 50 bytes/triangle, matches what was actually written -- not just "some bytes came back".
  const expectedLength = 80 + 4 + 50 * 4;

  assertEquals(bytes.length, expectedLength, "tetrahedron STL byte length");
});

Deno.test("designToStlBytes: the header's own triangle count is 4, little-endian", () => {
  const bytes = designToStlBytes(TETRAHEDRON_OBJ);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Test: read bytes 80-83 back out as a little-endian uint32, the exact field the binary STL
  // format defines right after the 80-byte header.
  // Verifies: designToStlBytes wrote the triangle count where and how the format says to, not
  // merely that the file ended up the right total length (a wrong count with padding elsewhere
  // could still pass the length check alone).
  assertEquals(view.getUint32(80, true), 4, "triangle count at bytes 80-83");
});

Deno.test("designToStlBytes: face f1's stored normal is unit length and points +z", () => {
  const bytes = designToStlBytes(TETRAHEDRON_OBJ);
  const triangle = readTriangle(bytes, 0); // f1 is the first face in the file, so triangle 0.

  // Test: the stored normal's own length (Euclidean norm of its 3 components).
  // Verifies: designToStlBytes actually normalizes the computed cross product, per the binary
  // STL format's own requirement that facet normals be unit vectors -- not merely "some
  // direction", which a raw, unnormalized cross product would also produce.
  const length = Math.hypot(...triangle.normal);

  assertClose(length, 1, 1e-5, "f1's normal must be unit length");

  // Test: the dot product of the stored (float32-rounded) normal against the hand-computed
  // direction (0, 0, 1) worked out in the fixture's own comment above.
  // Verifies: the normal points the SAME way that hand calculation gives, not merely that it has
  // unit length (a unit vector in a wrong direction would pass the length check alone). A dot
  // product close to 1, not exact equality, since designToStlBytes re-derives the normal through
  // float32 (not exact-rational) arithmetic.
  const dot = triangle.normal[0] * 0 + triangle.normal[1] * 0 + triangle.normal[2] * 1;

  assertClose(dot, 1, 1e-5, "f1's normal must point along +z");
});

Deno.test("designToStlBytes: f1's stored vertices are its own 3 corners, in file order", () => {
  const bytes = designToStlBytes(TETRAHEDRON_OBJ);
  const triangle = readTriangle(bytes, 0);

  // Test: the 3 vertex positions the STL record carries for f1 (v1, v2, v3 in the fixture).
  // Verifies: designToStlBytes writes a triangle's OWN 3 corners (not, say, some other face's,
  // or a welded/deduplicated set) -- exact equality is fine here, since these coordinates are
  // small round numbers the OBJ parser reads with plain `Number()`, with no arithmetic that
  // could introduce float noise.
  assertEquals(JSON.stringify(triangle.vertices), JSON.stringify([[0, 0, 0], [1, 0, 0], [0, 1, 0]]),
    "f1's 3 stored vertices");
});

Deno.test("fanTriangulate: an n-gon (a quad) fans from its own first vertex", () => {
  // Setup: a flat unit square in the z=0 plane, as one 4-corner OBJ face (a girdle facet is
  // exactly this shape: more than 3 corners, meant to be read as one polygon).
  const quadObj = [
    "v 0 0 0", // corner 0
    "v 1 0 0", // corner 1
    "v 1 1 0", // corner 2
    "v 0 1 0", // corner 3
    "f 1 2 3 4",
    "",
  ].join("\n");

  const { faces } = parseObjForStl(quadObj);
  const triangles = fanTriangulate(faces);

  // Test: fan-triangulating the one 4-corner face.
  // Verifies: a k-corner face becomes k - 2 triangles (here, 4 - 2 = 2), and every one of them
  // shares the face's OWN first vertex (index 0) -- the exact fan-from-vertex-0 convention
  // src/loader.rs's `tobj`-based loader already uses for these same OBJ files (see this file's
  // header comment), which is why this is checked directly rather than only trusted through the
  // tetrahedron's already-triangular faces above.
  assertEquals(triangles.length, 2, "a quad fans into 2 triangles");
  assert(triangles.every(triangle => triangle[0] === 0), "every fan triangle shares corner 0");
  assertEquals(JSON.stringify(triangles), JSON.stringify([[0, 1, 2], [0, 2, 3]]),
    "the quad's exact fan (0,1,2) and (0,2,3)");
});

Deno.test("designToStlBytes: an n-gon face produces STL triangles too", () => {
  const quadObj = [
    "v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0", "f 1 2 3 4", "",
  ].join("\n");

  const bytes = designToStlBytes(quadObj);

  // Test: the same quad, run through the whole binary writer (not just fanTriangulate above).
  // Verifies: designToStlBytes's own byte length and header count agree that ONE 4-corner face
  // became exactly 2 STL triangles -- the writer and the triangulator cannot silently disagree.
  assertEquals(bytes.length, 80 + 4 + 50 * 2, "quad STL byte length: 2 triangles");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  assertEquals(view.getUint32(80, true), 2, "quad STL header triangle count");
});

Deno.test("filenameFromCutName: sanitises whitespace and falls back when empty", () => {
  // Test: a normal cut name, one with only unsafe/whitespace characters, and an empty name.
  // Verifies: whitespace becomes '_', a name that has nothing filename-safe left (or is empty)
  // falls back to a fixed name rather than producing a bare ".stl" -- matching the same rule
  // export_obj.js's own `objFilename` applies for the .obj export, so the two never disagree
  // about what an unusable cut name means.
  assertEquals(filenameFromCutName("Standard Round Brilliant"), "Standard_Round_Brilliant.stl");
  assertEquals(filenameFromCutName("  "), "stone.stl");
  assertEquals(filenameFromCutName(""), "stone.stl");
});

// ===========================================================================
// Part 2: a smoke test against a real, non-hand-built sample design.
// ===========================================================================

/** Loads one of the bundled reference samples as a parsed GemCadDesign, the same two calls
 * (`GemCad.importAscText` then `GemCadDesign.fromGemCad`) the ticket asks this test to use --
 * matching how `web/src/lib/design_load.js`'s `objTextFromBytes` derives a design from a real
 * `.asc` file, minus the byte-sniffing wrapper this test does not need since it already knows
 * the format. */
async function loadSampleDesign(filename) {
  const text = await Deno.readTextFile(new URL(filename, SAMPLES));
  const parsed = GemCad.importAscText(text);

  return GemCadDesign.fromGemCad(parsed, { name: filename });
}

Deno.test("designToStlBytes: a real sample design (SRB.asc) yields a sane, nonzero mesh", { ignore: !SAMPLES_PRESENT }, async () => {
  // Setup: SRB.asc (a Standard Round Brilliant), one of the bundled reference designs used
  // throughout this project's other tests (edit_geometry_test.js, index_dial_test.js, ...) --
  // not hand-built, a real GemCad file.
  const design = await loadSampleDesign("SRB.asc");
  const objText = DesignMesh.toObjText(design, { name: "SRB" });

  const { vertices, faces } = parseObjForStl(objText);
  const triangles = fanTriangulate(faces);
  const bytes = designToStlBytes(objText);

  // Test: the triangle count designToStlBytes's own header reports, against the design's own
  // scale (kb/reading-gemcad-asc-and-gem-cut-files.md measures SRB at 73 facets from the SAME
  // OBJ bridge, so a handful to a few hundred triangles is the right order of magnitude -- an
  // empty or wildly oversized mesh would mean the parser or the triangulator broke).
  // Verifies: real, non-hand-built data produces a nonzero, plausible triangle soup, not just
  // the tetrahedron's exactly-4 case above.
  const headerTriangleCount = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(80, true);

  assert(vertices.length > 0, "SRB.asc's OBJ text must declare at least one vertex");
  assert(triangles.length > 0, "SRB.asc must triangulate to at least one triangle");
  assert(triangles.length < 10000, `triangle count implausibly large: ${triangles.length}`);
  assertEquals(headerTriangleCount, triangles.length,
    "the STL header's own count must match this test's independent triangulation");
  assertEquals(bytes.length, 80 + 4 + 50 * triangles.length, "SRB.asc STL byte length");

  // Test: every corner index this test's OWN parser and triangulator produced, against the
  // vertex list the SAME parse read.
  // Verifies: no face (before or after fan triangulation) references a vertex outside the range
  // the OBJ text actually declared -- the exact cross-check the ticket asks for, run against
  // real sample data rather than a fixture built to already be well-formed.
  for (const triangle of triangles) {
    for (const index of triangle) {
      assert(index >= 0 && index < vertices.length,
        `triangle references vertex ${index}, out of range [0, ${vertices.length})`);
    }
  }
});

Deno.test("designToStlBytes: every stored triangle from a real sample has a unit normal", { ignore: !SAMPLES_PRESENT }, async () => {
  // Setup: the same SRB.asc design as above, reused as a second, independent check: not just
  // that the byte count and header agree, but that every SINGLE triangle's own stored normal is
  // actually a unit vector (the binary STL format's own requirement), computed correctly for
  // real geometry, not only for the tetrahedron's axis-aligned faces.
  const design = await loadSampleDesign("SRB.asc");
  const objText = DesignMesh.toObjText(design, { name: "SRB" });
  const bytes = designToStlBytes(objText);
  const triangleCount = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(80, true);

  for (let i = 0; i < triangleCount; i++) {
    const { normal } = readTriangle(bytes, i);
    const length = Math.hypot(...normal);

    // A zero-area (degenerate) triangle would normalize to [0, 0, 0], length 0 -- allowed by
    // this module's own convention (see its `normalize` helper's doc comment), so the check
    // accepts either a unit vector or exactly zero, not just "close to 1" for every one.
    assert(Math.abs(length - 1) < 1e-4 || length === 0,
      `triangle ${i}'s normal has length ${length}, expected ~1 (or 0 for a degenerate triangle)`);
  }
});
