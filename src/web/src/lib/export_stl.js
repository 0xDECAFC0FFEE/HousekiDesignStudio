// File > Export > STL (.stl), T-0205: turns the currently-loaded stone into a binary STL mesh.
//
// STL is a triangle-soup format -- no shared vertices, no shared per-facet normal, just a flat
// list of independent triangles, each carrying its own 3 corners and its own normal -- unlike
// OBJ, which this project's writers (`www/js/gemcad_obj.js`'s `toObjText`,
// `www/js/design_mesh.js`'s `toObjText`) already produce. So this module is a generic
// OBJ-to-STL triangulator: it knows nothing about GemCad, tiers or gear, only 'v' and 'f' lines,
// which is all either writer ever emits (see
// kb/reading-gemcad-asc-and-gem-cut-files.md's "Rendering a design: the OBJ bridge" section).
//
// **Fan triangulation, from each face's first vertex**, is this project's own established
// convention for an n-gon face (a girdle facet, say), not something reinvented here:
// `src/loader.rs` fan-triangulates the SAME OBJ files via `tobj`'s `triangulate: true` option
// before the Rust mesh conditioner ever sees them, so a triangle this module writes always
// matches the one the renderer traces.
//
// **Each triangle's normal is computed fresh, from its own 3 vertices** (cross product,
// normalized) rather than reused from anywhere upstream: OBJ text carries no per-facet normal at
// all in this project's own writers (plain 'f i j k' lines, no 'vn'), and STL would not want a
// shared one anyway -- every triangle is independent.

import { get } from 'svelte/store';
import { cutMeta, showError } from './stores.js';
import { objTextForCurrentDesign } from './export_obj.js';
import { saveFileAs } from './export_file.js';

// ---------------------------------------------------------------------------
// A small, self-contained OBJ parser: 'v' and 'f' lines only. No dependency -- this project
// already vendors nothing for OBJ parsing (the Rust side uses the `tobj` crate; there is no JS
// equivalent in the tree), and the format either writer here emits is simple enough that adding
// one would cost more than it saves.
// ---------------------------------------------------------------------------

/** One 'v x y z' line -> a plain [x, y, z] array of numbers. */
function parseVertexLine(line) {
  const parts = line.trim().split(/\s+/);

  // parts[0] is the 'v' keyword itself; the three coordinates follow it.
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

/**
 * One 'f ...' line -> an array of 0-based vertex indices, one per corner (3 or more: a face may
 * be an n-gon). Each corner token is either a bare index ('12', what this project's own writers
 * emit) or carries texture/normal indices OBJ-style ('12/4/7'); only the part before the first
 * '/' is read, which is what the vertex position always is. OBJ indices are 1-based, and a
 * negative index is relative to the end of the vertex list read SO FAR (the OBJ spec's own
 * relative-indexing rule) -- neither writer in this project emits a negative index, but a
 * hand-authored or third-party .obj file might, and this is meant to be a generic OBJ reader,
 * not one tuned to this project's own output alone.
 */
function parseFaceLine(line, vertexCountSoFar) {
  const tokens = line.trim().split(/\s+/).slice(1);

  return tokens.map(token => {
    const raw = Number(token.split('/')[0]);

    return raw > 0 ? raw - 1 : vertexCountSoFar + raw;
  });
}

/**
 * Parses OBJ text into `{ vertices, faces }`: `vertices` is an array of [x, y, z] arrays, in
 * file order; `faces` is an array of arrays of 0-based vertex indices, one per face, in file
 * order. Every line that is not a 'v' or an 'f' line ('#' comments, 'o'/'g' group names, 'vt',
 * 'vn', blank lines, a stray 'mtllib') is ignored -- exactly what both this project's own OBJ
 * writers ever emit besides 'v' and 'f'.
 */
export function parseObjForStl(objText) {
  const vertices = [];
  const faces = [];

  for (const rawLine of objText.split('\n')) {
    const line = rawLine.trim();

    if (line === 'v' || line.startsWith('v ')) {
      vertices.push(parseVertexLine(line));
    } else if (line === 'f' || line.startsWith('f ')) {
      faces.push(parseFaceLine(line, vertices.length));
    }
  }

  return { vertices, faces };
}

/**
 * Fan-triangulates `faces` (each an array of 3 or more 0-based vertex indices) from each face's
 * OWN first vertex -- matching `src/loader.rs`'s `tobj`-based loader exactly, for the identical
 * files (see this module's header comment). A face that is already a triangle comes back
 * unchanged (one triangle out); an n-gon of k corners becomes k - 2 triangles, all sharing
 * corner 0.
 */
export function fanTriangulate(faces) {
  const triangles = [];

  for (const face of faces) {
    for (let i = 1; i + 1 < face.length; i++) {
      triangles.push([face[0], face[i], face[i + 1]]);
    }
  }

  return triangles;
}

// ---- plain 3-vector helpers: three numbers each, not worth a dependency or a class ----

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** `v` scaled to unit length, or `[0, 0, 0]` for a zero-length input (a degenerate, zero-area
 * triangle has no defined direction; an all-zero normal is the same "not specified" convention
 * most STL writers already use for one, rather than this module inventing its own). */
function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]);

  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
}

/** A triangle's own normal: the cross product of its two edges out of vertex `a`, normalized.
 * Computed fresh per triangle -- see this module's header comment on why STL never reuses one. */
function triangleNormal(a, b, c) {
  return normalize(cross(subtract(b, a), subtract(c, a)));
}

// ---- the binary STL writer ----

/** An STL header carries no information a reader is supposed to interpret; 80 zero bytes (an
 * `ArrayBuffer` already starts zeroed) is as good as any text there, and simpler than writing
 * one this project would have to keep meaningful. */
const HEADER_BYTES = 80;

/** Bytes per triangle record: 3 float32 normal components (12) + 3x3 float32 vertex components
 * (36) + 1 uint16 attribute byte count (2), always written as 0 -- nothing in this project's
 * output carries per-triangle STL "attributes" (color, say; a de facto extension some tools use
 * the 2 spare bytes for, which this writer does not). */
const TRIANGLE_BYTES = 50;

/**
 * Builds a binary STL file's bytes from OBJ text: `parseObjForStl` reads its 'v'/'f' lines,
 * `fanTriangulate` turns every face into triangles, and each triangle is written as its own
 * normal (computed here, not read from anywhere) followed by its own 3 vertices.
 *
 * Pure and synchronous -- no DOM, no Blob, nothing this project could not run under Deno -- so
 * it is directly unit-testable (`web/tests/export_stl_test.js`) without a browser. The caller
 * that wires the actual save (`exportCurrentStoneAsStl`, below, or TopBar.svelte's menu item)
 * hands the returned bytes to `export_file.js`'s `downloadFile`.
 */
export function designToStlBytes(objText) {
  const { vertices, faces } = parseObjForStl(objText);
  const triangles = fanTriangulate(faces);

  const buffer = new ArrayBuffer(HEADER_BYTES + 4 + TRIANGLE_BYTES * triangles.length);
  const view = new DataView(buffer);

  // Little-endian throughout, per the binary STL format; `DataView`'s own default is
  // big-endian, so every call below passes `true` explicitly.
  view.setUint32(HEADER_BYTES, triangles.length, true);

  let offset = HEADER_BYTES + 4;

  for (const [indexA, indexB, indexC] of triangles) {
    const a = vertices[indexA];
    const b = vertices[indexB];
    const c = vertices[indexC];
    const normal = triangleNormal(a, b, c);

    for (const component of normal) {
      view.setFloat32(offset, component, true);
      offset += 4;
    }

    for (const vertex of [a, b, c]) {
      for (const component of vertex) {
        view.setFloat32(offset, component, true);
        offset += 4;
      }
    }

    // The attribute byte count every binary STL triangle record carries, always 0 here (see
    // TRIANGLE_BYTES's own comment).
    view.setUint16(offset, 0, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

// ---------------------------------------------------------------------------
// Getting the OBJ text for "the currently-loaded stone" and wiring the actual save. Not
// exercised by web/tests/export_stl_test.js (which is Deno-only, no wasm, no DOM): the section
// above is what that test covers; this is the thin, page-only wrapper TopBar.svelte calls.
// ---------------------------------------------------------------------------

/**
 * The OBJ text for whatever stone is currently loaded -- reusing T-0204's own answer to "how do
 * you get the current OBJ text" (`web/src/lib/export_obj.js`'s `objTextForCurrentDesign`)
 * rather than duplicating it here, so the .obj and .stl exports can never disagree about what
 * "the current stone" means. That function returns `null` when there is no design to build OBJ
 * text from at all (a plain `.obj` file opened directly, or a `.asc`/`.gem`/`.gcs` whose own
 * `fromGemCad` gate failed) -- see its own doc comment for why neither `design_load.js` nor
 * `session.js` currently keeps that file's raw OBJ text anywhere reachable from here. Rather
 * than export nothing silently, that case throws a clear, catchable message.
 */
export function currentObjText(name) {
  const text = objTextForCurrentDesign(name);

  if (text === null) {
    throw new Error(
      'Nothing to export as STL: the current stone has no cutting-instructions design loaded ' +
      '(a plain .obj file opened directly carries none).'
    );
  }

  return text;
}

/** `name`, cleaned up for use as a filename: OBJ has no quoting for whitespace or path-unsafe
 * characters, and neither does a filesystem, so this mirrors `www/js/gemcad_obj.js`'s own
 * `sanitiseName` (whitespace runs collapse to '_', anything else unsafe is dropped), falling
 * back to a fixed name when nothing usable is left -- an empty, or whitespace-only, cut name.
 * Trimmed FIRST, before the whitespace-to-'_' pass: otherwise a whitespace-only name would
 * collapse to a lone '_' -- a filename-safe character in its own right -- rather than falling
 * back, which is not the "nothing usable" case this is meant to catch. */
export function filenameFromCutName(name) {
  const cleaned = String(name ?? '').trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._+-]/g, '');

  return (cleaned === '' ? 'stone' : cleaned) + '.stl';
}

/**
 * File > Export > STL (.stl)'s actual handler: gets the current stone's OBJ text, converts it
 * to binary STL, and saves it under the current cut name through the OS's own Save dialog when
 * available (`saveFileAs`, export_file.js). Errors (no design loaded) are shown in the panel's
 * error box rather than thrown into the menu's own click handler, exactly like every other
 * page-level failure (`session.js`'s `applyParam`, say).
 */
export async function exportCurrentStoneAsStl() {
  const name = get(cutMeta).name;

  try {
    const objText = currentObjText(name);
    const bytes = designToStlBytes(objText);

    await saveFileAs(filenameFromCutName(name), bytes, {
      description: 'STL mesh',
      mimeType: 'model/stl',
      extensions: ['.stl'],
    });
  } catch (cause) {
    showError(String(cause));
  }
}
