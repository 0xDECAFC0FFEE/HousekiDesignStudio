/*
 * export_gem.js -- writes a loaded design back out as GemCad's own BINARY .gem format (T-0207).
 *
 * There is no GemCad .gem WRITER anywhere in this project or its reference material --
 * `www/js/gemcad.js` (`GemCad.importGemBytes`, its `BinaryReader`/`parseBinaryData`/
 * `calculateTierDefinitions`) and `reference/gemcad-file-reader/` are read-only (confirmed by
 * grep: no `BinaryWriter`/`StreamWriter` anywhere in either), see
 * kb/clean-room-and-licensing-constraints.md -- so this is the byte-level inverse of gemcad.js's
 * own binary reader, built from scratch using that reader as the exact spec for the layout. See
 * kb/reading-gemcad-asc-and-gem-cut-files.md (the format overview and its two traps) and
 * kb/gemcad-gem-binary-writer-t-0207.md (this writer's own notes: which parts of the layout are
 * genuinely pinned down by the reader and which are free choices this writer had to make, and
 * why they are safe).
 *
 * THE KEY DIFFERENCE FROM .asc: a .gem stores actual geometry (each facet's own outward normal
 * and corner point list), not just the polar (angle, index, distance) numbers -- see
 * kb/reading-gemcad-asc-and-gem-cut-files.md's "What the two formats give you" table. So unlike
 * export_asc.js (a field-by-field transcription of the design's own polar numbers), this writer
 * has to compute geometry: each facet's plane, intersected with every other facet's plane, the
 * SAME half-space intersection design_mesh.js already does to build the rendered stone
 * (`DesignMesh.buildFaces`, www/js/design_mesh.js, T-0168 -- see
 * kb/building-the-stone-mesh-from-a-design-s-own-face.md). Reused here rather than
 * reimplemented, per the ticket's own instruction and CLAUDE.md's "prefer... not hand-rolled
 * code" -- `www/js/gemcad_obj.js`'s own block-cutting (the .asc reconstruction path) is a
 * different, independent algorithm this file does not need.
 *
 * WHY THE READER RECOVERS THE ORIGINAL DESIGN, NOT JUST *A* VALID ONE.
 *
 * `GemCadDesign.fromGemCad` (design.js) recovers a facet's (angle, index) from its OWN stored
 * normal via `GemCadDesign.polarOf`, the exact mathematical inverse of `GemCadDesign.normalOf`.
 * This writer builds each facet's stored normal with `normalOf(design, tier.angle,
 * facet.index)` -- the SAME function, called with the SAME design's own (angle, index) -- so on
 * read-back `polarOf` recovers the identical (angle, index) up to float noise, by construction,
 * with no lossy format round trip in between at all. `gemcad.js`'s OWN back-computation
 * (`calculateTierDefinitions`, which the T-0088 index-mirroring bug lived in) is not what
 * `fromGemCad` actually uses when a facet's stored normal is present and nonzero -- see its own
 * comment on `entry.facetNormal` -- so that historical bug is not a hazard for what THIS writer
 * produces. `calculateTierDefinitions` still supplies each TIER's own `angle` (used verbatim by
 * `fromGemCad` for an off-axis tier), rounded to 2 decimal places exactly as any real .gem is --
 * see NORMAL_AGREEMENT_TOLERANCE's own comment in design.js for why that rounding is expected
 * and bounded, not a defect.
 *
 * THE FACET NORMAL'S MAGNITUDE (not just its direction) matches real GemCad's own convention:
 * kb/reading-gemcad-asc-and-gem-cut-files.md records that `GenerateCutPlanes` builds a stored
 * facet normal as "the plane point plus three units along the outward normal", which for a
 * plane at distance `d` from the origin is exactly `(3 + d)` times the outward unit normal --
 * `planePoint = d * unitNormal` (the foot of the perpendicular from the origin already lies on
 * the plane) plus `3 * unitNormal` is `(3 + d) * unitNormal`. Reproduced here for closer
 * fidelity to a real .gem's bytes, though (see the algebra in the KB article this ticket added)
 * the magnitude does not actually affect what `calculateTierDefinitions` recovers: its angle and
 * index computations are already direction-only (ratios of dot products), and its distance
 * computation's scale factor cancels out algebraically regardless of which positive scalar
 * multiple of the unit normal is written.
 *
 * WHAT THIS WRITER DELIBERATELY DOES NOT TRY TO REPRODUCE, AND WHY (see the KB article for the
 * full reasoning on each):
 *
 *   - Cutting instructions (a tier's free-text note) are not written. The real format embeds them
 *     as extra tab-separated tokens on a tier's FIRST facet record, attached with a one-record
 *     lag to whichever tier was previous at that point (an upstream quirk `gemcad.js`'s own
 *     comment calls out) -- reproducing that exactly was not needed for the round-trip property
 *     the ticket actually asks for (gear, tier count, angle/distance/index), so it is left out
 *     rather than guessed at.
 *   - A `PREFORM` section is never written. `design.tiers[].preform` is not round-tripped; a
 *     preform tier's facets are written as ordinary tier records. `design_mesh.js` already cuts
 *     preform tiers normally (T-0179), so their GEOMETRY still round-trips; only the cosmetic
 *     brace-the-teeth flag does not survive.
 *   - A `hidden` tier's facets have no representation in a `.gem` at all (the format has no such
 *     concept), and `DesignMesh.buildFaces` -- reused as-is, per the ticket, not modified --
 *     already leaves a hidden tier's planes out of the candidate set entirely (see
 *     `GemCadDesign.isRenderedTier`), so that tier's facets have no geometry to write and are
 *     skipped. A design with a hidden tier therefore round-trips with fewer tiers than it started
 *     with; not exercised by the bundled samples (none hide a tier), and recorded as a known
 *     limitation rather than hidden.
 *
 * KNOWN RISK, NAMED RATHER THAN HIDDEN (the ticket's own instruction): the trailer's exact
 * probe/seek byte layout is reverse-engineered from `gemcad.js`'s reader, not from a real
 * GemCad-written file byte-compared against this writer's output (no .NET or GemCad application
 * is available on this machine -- the same constraint gemcad.js's own header notes). Every choice
 * here is verified to round-trip through THIS PROJECT'S OWN reader (see export_gem_test.js), but
 * a `.gem` this writer produces is not verified to open in the real GemCad application. See the
 * KB article for the specific bytes this writer chose freely (the two "unknown" filler fields,
 * whether headers/footnotes are non-empty, etc.) versus the ones the reader's own logic pins down
 * exactly (little-endian doubles/int32s, the ASCII string encoding, the trailer sniff's four
 * conditions).
 */

import { getDesign } from './tier_controller.js';
import { cutMeta, showLoadAlert } from './stores.js';
import { saveFileAs } from './export_file.js';
import { get } from 'svelte/store';

/** Used when the cut name is empty or not filename-safe on its own -- same rule as the other
 * three export formats (export_obj.js's own `FALLBACK_NAME`), kept as a separate copy since this
 * file does not import from a sibling export module (each format's writer is independently
 * owned, per the Export submenu's own comment in TopBar.svelte). */
const FALLBACK_NAME = 'stone';

/**
 * `name` turned into a safe `.gem` filename -- the same sanitisation rule `export_obj.js`'s
 * `objFilename` uses (strip characters no filesystem accepts in a name, fall back rather than
 * produce a bare extension).
 */
export function gemFilename(name) {
  const cleaned = (name || '').trim().replace(/[\\/:*?"<>|]/g, '');

  return `${cleaned || FALLBACK_NAME}.gem`;
}

/*
 * ---------------------------------------------------------------------------------------------
 * A minimal little-endian binary writer, mirroring gemcad.js's own BinaryReader (PORT TRAP 5:
 * "little-endian throughout"). Grows by appending fixed-size chunks rather than one byte at a
 * time, and is only ever read back out once, in full, at the end (`toUint8Array`) -- there is no
 * seeking-back on the write side the way the reader has to (its own trailer-detection rewind),
 * because this writer decides up front what it is about to write and never has to guess and
 * backtrack.
 * ---------------------------------------------------------------------------------------------
 */
class GemByteWriter {
  constructor() {
    this._chunks = [];
    this._length = 0;
  }

  _push(bytes) {
    this._chunks.push(bytes);
    this._length += bytes.length;
  }

  writeUint8(value) {
    this._push(Uint8Array.of(value & 0xff));
  }

  writeInt32(value) {
    const buffer = new ArrayBuffer(4);

    new DataView(buffer).setInt32(0, value, true);
    this._push(new Uint8Array(buffer));
  }

  writeDouble(value) {
    const buffer = new ArrayBuffer(8);

    new DataView(buffer).setFloat64(0, value, true);
    this._push(new Uint8Array(buffer));
  }

  writeBytes(bytes) {
    this._push(bytes);
  }

  toUint8Array() {
    const out = new Uint8Array(this._length);
    let offset = 0;

    for (const chunk of this._chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }

    return out;
  }
}

/**
 * The inverse of `asciiGetString` (gemcad.js, PORT TRAP 6): every character above the ASCII
 * range (code point > 0x7F) becomes `?` (0x3F), matching .NET's `Encoding.ASCII.GetBytes`
 * convention the reader's own `Encoding.ASCII.GetString` is a faithful port of. A length above
 * 255 is truncated, since the format's own length prefix is a single byte (`reader.readByte()`)
 * -- not expected to fire on any header/footnote/facet-name text this project writes, but kept
 * as a hard cap rather than an unbounded write that would silently desync every byte after it.
 */
function asciiBytesForString(text) {
  const source = String(text == null ? '' : text).slice(0, 255);
  const bytes = new Uint8Array(source.length);

  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);

    bytes[i] = code <= 0x7f ? code : 0x3f;
  }

  return bytes;
}

/**
 * A length-prefixed ANSI string with NO trailing marker: `readAnsiString(reader, false)`'s
 * encoding for a NON-BLANK line (gemcad.js). Used for the trailer's header/footnote text lines,
 * which are always non-blank by the time they reach here -- `designToGemBytes` only calls this
 * with a line `guardedTrailerLine` has already confirmed is non-blank, since a blank line has a
 * DIFFERENT encoding (see `writeBlankSeparator`) that this function does not produce.
 */
function writeAnsiStringNoMarker(writer, text) {
  const bytes = asciiBytesForString(text);

  writer.writeUint8(bytes.length);
  writer.writeBytes(bytes);
}

/**
 * A length-prefixed ANSI string WITH a trailing 4-byte marker: `readAnsiString(reader,
 * true)`'s encoding, used for a tier index record's name field (`text = readAnsiString(reader,
 * true).split("\t")` in `parseBinaryData`). The marker is read and unconditionally discarded by
 * the reader (`readEodMarker(reader)`, never inspected), so its value is free; 0 is written for
 * determinism.
 */
function writeAnsiStringWithMarker(writer, text) {
  writeAnsiStringNoMarker(writer, text);
  writer.writeInt32(0);
}

/**
 * The blank-line encoding `readAnsiString(reader, false)` expects when the string IS blank: a
 * zero-length string (a single 0x00 length byte) followed by one more byte that the reader peeks
 * at and, since it is not `> 0`, consumes rather than pushing back (`reader.position -= 1` only
 * fires for a nonzero peeked byte). Writing a second 0x00 here is what keeps this a clean,
 * self-contained 2-byte record that the NEXT text line starts fresh after -- the one and only
 * blank line this writer ever emits, marking the boundary between the header lines and the
 * footnote lines (`parseBinaryData`: the first blank line switches `textLines` from
 * `metadata.headers` to `metadata.footnotes`).
 */
function writeBlankSeparator(writer) {
  writer.writeUint8(0);
  writer.writeUint8(0);
}

/**
 * A trailer text line, filtered and guarded: `null` for a blank/whitespace-only line (skipped
 * entirely -- writing one mid-list would prematurely trigger the reader's header/footnote
 * switch, see `writeBlankSeparator`'s own comment), or the line itself with a trailing space
 * appended in the one-in-a-million case it is literally "preform" (case-insensitively) with no
 * other content -- which would otherwise collide with `parseBinaryData`'s own PREFORM-section
 * sentinel (`textLine.toLowerCase() === "preform"`) and make the reader stop consuming header/
 * footnote text early, silently dropping everything after it.
 */
function guardedTrailerLine(line) {
  if (line == null) {
    return null;
  }

  const text = String(line);

  if (text.trim() === '') {
    return null;
  }

  if (text.trim().toLowerCase() === 'preform') {
    return `${text} `;
  }

  return text;
}

/**
 * `design`'s header lines, with `title` made the first line unless it is already there --
 * mirroring export_asc.js's own `headerLines` rule (kept as a separate small copy rather than an
 * import, since this file does not depend on a sibling export ticket's module).
 */
function headerLinesFor(design, title) {
  const headers = (design.headers || []).slice();

  if (title !== undefined && title !== null && title !== '' && headers[0] !== title) {
    headers.unshift(title);
  }

  return headers;
}

/**
 * Groups `built.faces` (see `DesignMesh.buildFaces`) by the design tier index each one belongs
 * to (`face.tier`, an index into `design.tiers`), preserving each group's own facets in
 * `design.tiers[t].facets`' own order. A tier absent from the returned map has no geometry to
 * write at all -- either every one of its facets' planes was left out of the candidate set
 * (`design_mesh.js`'s own `meshPlanes`/`isRenderedTier`: a `hidden` tier), or every one of its
 * planes turned out to be redundant/degenerate/coincident with an earlier plane (see
 * `dropCoincidentPlanes`, `buildFaces`'s own degenerate-face check) -- see this file's own
 * header comment and kb/gemcad-gem-binary-writer-t-0207.md for why that is an accepted, named
 * limitation rather than something this writer tries to work around.
 */
function facesByTier(built) {
  const map = new Map();

  for (const face of built.faces) {
    if (!map.has(face.tier)) {
      map.set(face.tier, []);
    }

    map.get(face.tier).push(face);
  }

  for (const faces of map.values()) {
    faces.sort((a, b) => a.facet - b.facet);
  }

  return map;
}

/**
 * The facet normal to WRITE for `tier`'s facet at `index`, scaled `(3 + tier.distance)` times
 * (see the header comment on real GemCad's own stored-normal convention) -- with one deliberate
 * correction at exactly a +/-90 degree mast angle (a girdle facet), found and measured while
 * building this ticket, not assumed:
 *
 * `GemCadDesign.normalOf` maps BOTH +90 and -90 to the identical polar angle 90 before taking
 * `cos` (`polarAngleOf`'s own branches: `mastAngle >= 0 ? mastAngle : 180 + mastAngle` sends
 * both to 90), so its z component is the SAME tiny floating-point residual --
 * `Math.cos(Math.PI / 2)`, `6.123233995736766e-17`, always POSITIVE -- regardless of the
 * design's own authored sign. `calculateTierDefinitions` (gemcad.js) recovers a girdle tier's
 * sign from exactly that residual's OWN sign (`if (facetNormal.z < 0) angle *= -1`), so writing
 * `normalOf`'s output verbatim always reads back as +90, even for a tier authored as -90 --
 * confirmed directly against Compear125.gem's own tier 2 (a real, unremarkable girdle tier at
 * -90): before this correction, its round-tripped angle came back +90, a 180-degree disagreement
 * geometrically invisible on the rendered stone (+90 and -90 are the same vertical plane -- see
 * `normalOf`'s own doc comment in design.js) but a real difference in the RECOVERED design's
 * `tier.angle`, which this ticket's round-trip test checks.
 *
 * Real GemCad's own writer does not have this problem -- Compear125.gem's actual bytes for that
 * tier store z = -8.430558058783213e-17, reliably negative -- because it does not go through
 * `normalOf`'s polar-angle reduction at all; whatever its own construction is, it evidently keeps
 * the authored sign as this tiny residual rather than losing it. `normalOf` cannot be changed to
 * match (it is a pure, symmetric function of the design's own conventions, used everywhere else
 * a facet's REAL geometry is needed, and +90/-90 truly are the same plane for every other
 * purpose), so this writer restores the sign explicitly, only for this one degenerate angle,
 * only in the bytes it writes.
 */
function facetNormalForWrite(design, tier, index) {
  const unitNormal = GemCadDesign.normalOf(design, tier.angle, index);
  const scale = 3 + tier.distance;
  let z = scale * unitNormal.z;

  if (Math.abs(tier.angle) === 90) {
    const magnitude = Math.abs(z) || Number.MIN_VALUE;

    z = tier.angle < 0 ? -magnitude : magnitude;
  }

  return { x: scale * unitNormal.x, y: scale * unitNormal.y, z };
}

/**
 * The design as GemCad `.gem` binary bytes: the byte-level inverse of `gemcad.js`'s
 * `BinaryReader`/`parseBinaryData`/`calculateTierDefinitions` -- see this file's own header
 * comment for the format, what is faithfully reproduced, and what is a deliberate, documented
 * simplification.
 *
 * `{ title }` becomes the trailer's first header line (see `headerLinesFor`), the same role
 * `export_asc.js`'s own `title` option plays for an `H` line -- optional, since a design loaded
 * from a file already carries its own `headers[]`.
 *
 * Throws whatever `DesignMesh.buildFaces` throws (an unclosed or otherwise pathological design,
 * per its own doc comment in design_mesh.js) -- this file does not catch it, so a caller (like
 * `exportGem` below) decides how to report that, matching `export_obj.js`'s own `DesignMesh`
 * error-propagation convention.
 */
export function designToGemBytes(design, { title } = {}) {
  if (!design) {
    throw new Error('designToGemBytes: no design to export');
  }

  // DesignMesh (www/js/design_mesh.js) and GemCadDesign (www/js/design.js) are classic-script
  // globals, published by boot.js exactly like GemCad itself -- see export_obj.js's own use of
  // DesignMesh for the same bare-global convention.
  const built = DesignMesh.buildFaces(design);
  const grouped = facesByTier(built);

  const writer = new GemByteWriter();
  let fileTierNumber = 0;

  for (let t = 0; t < design.tiers.length; t++) {
    const faces = grouped.get(t);

    if (!faces || faces.length === 0) {
      continue;
    }

    // File tier numbers are assigned sequentially from 1, in `design.tiers`' own order --
    // deliberately NOT `t` itself. `parseBinaryData`'s `currentTier` starts pre-seeded with
    // `number = 1` before any record is read, so a first tier record numbered anything other
    // than 1 makes the very first rollover check push an EMPTY placeholder tier ahead of the
    // real one (the exact artefact kb/building-the-stone-mesh-from-a-design-s-own-face.md
    // records for Darts.gem's real tier 0). Numbering from 1 sidesteps that outright rather than
    // relying on tolerance elsewhere to absorb an extra tier.
    fileTierNumber += 1;

    const tier = design.tiers[t];

    for (const face of faces) {
      const facet = tier.facets[face.facet];

      // The facet's own outward normal, scaled to match real GemCad's own stored-normal
      // convention, from the SAME design (angle, index) this facet was cut at -- see
      // `facetNormalForWrite`'s own doc comment for why this is not simply
      // `GemCadDesign.normalOf`'s raw output.
      const facetNormal = facetNormalForWrite(design, tier, facet.index);

      writer.writeDouble(facetNormal.x);
      writer.writeDouble(facetNormal.y);
      writer.writeDouble(facetNormal.z);
      // This int32, immediately after the facet normal, is read as `rec.tier` (`read3DPoint`'s
      // `out.eodMarker`, reused by `parseBinaryData` as the record's tier number) -- NOT a
      // "more points follow" flag; that role only applies to the per-POINT markers below.
      writer.writeInt32(fileTierNumber);

      writeAnsiStringWithMarker(writer, facet.name || '');

      // Cutting instructions are deliberately not embedded here -- see this file's header
      // comment on why, and export_asc.js's own note that a `.gem`-derived design's
      // `cuttingInstructions` never came from a `.gem` in the first place (`fromGemCad` reads it
      // from `GemCadFileTierData.cuttingInstructions`, which this writer does not populate).

      const points = face.polygon;

      for (let p = 0; p < points.length; p++) {
        writer.writeDouble(points[p].x);
        writer.writeDouble(points[p].y);
        writer.writeDouble(points[p].z);
        // >0 means "more points follow" (the do-while loop in parseBinaryData: `do {...} while
        // (out.eodMarker > 0)`); the LAST point's marker must be <= 0 to end the list. Any
        // positive sentinel works for every point but the last; 1 is used here.
        writer.writeInt32(p < points.length - 1 ? 1 : 0);
      }
    }
  }

  // The trailer. `parseBinaryData`'s own sniff (the "pretty jank" upstream comment, mirrored
  // faithfully) needs exactly: a leading int32 0, a 4-byte field that is NOT all zero, a
  // positive symmetryFolds, and a symmetryMirror of exactly 0 or 1 -- all four are guaranteed by
  // construction below, so this is always correctly detected as the trailer and never
  // mis-parsed as one more tier index record.
  writer.writeInt32(0); // "0x0 marker" -- the sniff's own first condition.
  // "Unknown2 - but never all zeroes" (parseBinaryData's own comment on the field it reads at
  // this position); its value is otherwise never inspected by the reader, so any fixed nonzero
  // pattern satisfies the sniff. See kb/gemcad-gem-binary-writer-t-0207.md for why this and
  // "unknown3" below are free choices, not pinned down by the reader's own logic.
  writer.writeBytes(Uint8Array.of(1, 1, 1, 1));
  writer.writeInt32(design.symmetry && design.symmetry.folds > 0 ? design.symmetry.folds : 1);
  writer.writeInt32(design.symmetry && design.symmetry.mirror ? 1 : 0);
  // The signed gear count: design.js stores a magnitude plus a `reversed` flag (T-0170/T-0171),
  // the OPPOSITE of the file's own convention where a negative count means the wheel runs the
  // other way -- the exact translation export_asc.js's own `signedTeeth` performs for `.asc`'s
  // `g` line, mirrored here for `.gem`'s binary `gear` field. Getting this backwards would
  // silently turn every reversed design into a forward one on export.
  writer.writeInt32(design.gear.reversed ? -design.gear.teeth : design.gear.teeth);
  writer.writeDouble(design.refractiveIndex || 0);
  writer.writeBytes(Uint8Array.of(0, 0, 0, 0)); // "unknown3 - same in all files"; discarded on read.
  writer.writeDouble(design.gear.originIndex || 0);

  for (const line of headerLinesFor(design, title)) {
    const guarded = guardedTrailerLine(line);

    if (guarded !== null) {
      writeAnsiStringNoMarker(writer, guarded);
    }
  }

  // The header/footnote boundary. Written unconditionally, even when `footnotes` is empty: it
  // costs 2 bytes and is a no-op in that case (the reader just has nothing left to read into the
  // now-active footnotes list), and always emitting it is simpler than special-casing "no
  // footnotes" -- see kb/gemcad-gem-binary-writer-t-0207.md.
  writeBlankSeparator(writer);

  for (const line of design.footnotes || []) {
    const guarded = guardedTrailerLine(line);

    if (guarded !== null) {
      writeAnsiStringNoMarker(writer, guarded);
    }
  }

  return writer.toUint8Array();
}

/**
 * File > Export > GemCad (.gem)'s `onSelect`: builds the binary bytes for the loaded stone's
 * design and saves them through the OS's own Save dialog when available (`saveFileAs`,
 * export_file.js), or shows why it could not -- matching export_obj.js's own `exportObj` shape
 * exactly (the "no design loaded" case, the try/catch around the writer, the filename source).
 */
export async function exportGem() {
  const design = getDesign();

  if (!design) {
    showLoadAlert(
      'Could not export to GemCad (.gem)',
      'This stone has no cutting-instructions design loaded (a plain .obj was opened, or its ' +
      'design could not be read), so there is no facet data to export.'
    );
    return;
  }

  const name = get(cutMeta).name;
  let bytes;

  try {
    bytes = designToGemBytes(design, { title: name });
  } catch (cause) {
    showLoadAlert('Could not export this design to GemCad (.gem)', String(cause));
    return;
  }

  await saveFileAs(gemFilename(name), bytes, {
    description: 'GemCad design',
    mimeType: 'application/octet-stream',
    extensions: ['.gem'],
  });
}
