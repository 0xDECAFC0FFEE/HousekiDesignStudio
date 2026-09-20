/*
 * export_obj_test.js -- tests for web/src/lib/export_obj.js, File > Export > Wavefront (.obj)
 * (T-0204): turning the currently loaded design into OBJ text and a safe filename.
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * `objTextForDesign` calls straight through to `DesignMesh.toObjText` (www/js/design_mesh.js),
 * which is already covered end to end by www/js/tests/design_mesh_test.js (golden files,
 * round-trip checks against the file's own corners). What is new here, and what this file
 * actually verifies, is export_obj.js's OWN logic: that whatever `DesignMesh.toObjText` hands
 * back is a STRUCTURALLY VALID mesh once it leaves this module -- a sanity check, not a
 * round-trip identity check (unlike the .gem/.asc export tickets, OBJ has no "open your own
 * export" concept in this app) -- the `null`-design case, and `objFilename`'s own filename
 * rules, which have nothing to do with GemCad at all.
 *
 * `objTextForDesign` takes a design directly rather than reading `getDesign()` itself
 * (tier_controller.js's live module state, which only a running page ever populates), precisely
 * so it can be tested this way -- see its own doc comment in export_obj.js. `exportObj`, the
 * function actually wired to the menu item, is a thin wrapper around it plus `downloadFile`
 * (a real browser download) and is exercised over CDP against the built page instead, not here.
 *
 * The GemCad reader, design builder and mesh builder are classic scripts (no import/export), so
 * they are loaded and run once, up front, the same way every other test file in this directory
 * that needs them does (see edit_geometry_test.js): `(0, eval)` on their source text publishes
 * `GemCad`, `GemCadDesign` and `DesignMesh` as globals, which is what `loadSample` below and
 * `objTextForDesign` (which calls the global `DesignMesh` directly, exactly as the real module
 * does at runtime under Vite, where these scripts are inlined ahead of it) both need in scope.
 */

import { objTextForDesign, objFilename } from "../src/lib/export_obj.js";

// The GemCad scripts, loaded as the page loads them (make_page.py inlines the same files ahead
// of the app's own script): classic scripts that publish GemCad, GemCadDesign and DesignMesh as
// globals rather than exporting anything.
const SCRIPTS = new URL("../../js/", import.meta.url);
const SAMPLES = new URL("../../../reference/gemcad-file-reader/Samples/", import.meta.url);

for (const name of ["gemcad.js", "gemcad_obj.js", "design.js", "design_mesh.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(name, SCRIPTS)));
}

const { GemCad, GemCadDesign } = globalThis;

/*
 * reference/ is third-party data -- the bundled GemCad sample designs among it -- several hundred
 * megabytes of it, deliberately gitignored, so a fresh clone of this repository has none of it and
 * the suite still has to be green there. The two tests below that load a sample are marked
 * `{ ignore: !SAMPLES_PRESENT }`, so they report as ignored on a clean checkout rather than
 * erroring on a missing file; with the data present they run exactly as before. The null-design
 * and objFilename tests need no files at all and are never gated.
 */
const SAMPLES_PRESENT = (() => {
  try {
    Deno.statSync(SAMPLES);
    return true;
  } catch {
    return false;
  }
})();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

/** Loads one bundled sample .asc by name into a GemCadDesign, the way an opened file would. */
async function loadSample(filename) {
  const text = await Deno.readTextFile(new URL(filename, SAMPLES));
  const parsed = GemCad.importAscText(text);

  return GemCadDesign.fromGemCad(parsed, { name: filename });
}

/**
 * Parses OBJ text into vertices and 0-based face index lists -- just enough to sanity-check
 * what export_obj.js hands `downloadFile`, independent of design_mesh.js's own internals (this
 * is deliberately a much simpler parser than stone_stats.js's `parseObj`, which this test does
 * not import, so a bug shared between the export path and that parser cannot hide from it).
 */
function parseObj(text) {
  const vertices = [];
  const faces = [];

  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);

    if (fields[0] === "v") {
      vertices.push(fields.slice(1, 4).map(Number));
    } else if (fields[0] === "f") {
      faces.push(fields.slice(1).map((field) => parseInt(field, 10) - 1));
    }
  }

  return { vertices, faces };
}

/** The structural checks both design tests below share: shape, not exact geometry. */
function assertStructurallyValidMesh(text) {
  const { vertices, faces } = parseObj(text);

  assert(vertices.length > 0, "at least one vertex");
  assert(faces.length > 0, "at least one face");

  for (const face of faces) {
    assert(face.length >= 3, `a face has at least 3 corners, got ${face.length}`);

    for (const index of face) {
      assert(index >= 0 && index < vertices.length,
        `face index ${index} is in range [0, ${vertices.length})`);
    }
  }
}

Deno.test("objTextForDesign builds a structurally valid mesh from a loaded design (SRB.asc)", { ignore: !SAMPLES_PRESENT }, async () => {
  // Setup: SRB.asc (Standard Round Brilliant), one of the four bundled reference samples,
  // loaded through the same GemCad.importAscText + GemCadDesign.fromGemCad path an opened .asc
  // file takes (design_load.js's own objTextFromBytes).
  // Test: objTextForDesign, then parse the OBJ text it returns.
  // Verifies: the text is DesignMesh.toObjText's own output (its comment header names it), and
  // that it parses to a valid mesh -- at least one vertex and one face, every face at least a
  // triangle, and every corner's vertex index actually pointing at a vertex the same text
  // declared. Exactly what would make the downloaded .obj openable in another tool, the property
  // this ticket's acceptance criteria calls a "mesh sanity check".
  const design = await loadSample("SRB.asc");
  const text = objTextForDesign(design, "SRB");

  assert(text.startsWith("# Generated from a design's own facet planes"), "comes from DesignMesh.toObjText");
  assertStructurallyValidMesh(text);
});

Deno.test("objTextForDesign builds a structurally valid mesh from a second design (Turkey.asc)", { ignore: !SAMPLES_PRESENT }, async () => {
  // Setup: Turkey.asc, a second bundled sample with a different tier layout than SRB -- the
  // ticket asks for "at least a couple" of the samples, so this is not just SRB's own shape
  // being re-checked under a different name.
  // Test and verifies: the same structural checks as the SRB test above.
  const design = await loadSample("Turkey.asc");
  const text = objTextForDesign(design, "Turkey");

  assertStructurallyValidMesh(text);
});

Deno.test("objTextForDesign returns null for no design, matching getDesign()'s own null case", () => {
  // Setup: none -- a plain .obj (or a design whose own fromGemCad gate failed) is exactly the
  // `null` design objTextForDesign is documented to handle without throwing.
  // Test: call it with `null` directly, standing in for what getDesign() returns in that case.
  // Verifies: "no design" in, "no mesh" out -- the branch exportObj relies on to show a clear
  // alert (export_file_test coverage of the alert path itself is a browser/CDP concern, not a
  // unit one, since it goes through stores.js's loadAlert store and the dialog that reads it).
  assertEqual(objTextForDesign(null, "whatever"), null, "no design means no mesh text");
});

Deno.test("objFilename sanitises the cut name into a safe .obj filename", () => {
  // Setup: names the cut header can actually hold -- an ordinary title, one with characters no
  // filesystem accepts in a name, one that is only those characters, and the empty string (the
  // header field can be cleared, T-0145).
  // Test: objFilename.
  // Verifies: a normal name becomes "<name>.obj" unchanged; forbidden characters
  // (\ / : * ? " < > |, the union of what POSIX and Windows both reject) are stripped rather
  // than kept or replaced; and a name that sanitises down to nothing -- or was empty to start
  // with -- falls back to "stone.obj" instead of producing a bare ".obj".
  assertEqual(objFilename("Standard Round Brilliant"), "Standard Round Brilliant.obj", "an ordinary name");
  assertEqual(objFilename('Weird: "Cut"? <v2>'), "Weird Cut v2.obj", "forbidden characters are stripped");
  assertEqual(objFilename("///???"), "stone.obj", "nothing usable is left");
  assertEqual(objFilename(""), "stone.obj", "an empty cut name");
  assertEqual(objFilename("  Padded Name  "), "Padded Name.obj", "surrounding whitespace is trimmed");
});
