/*
 * export_asc.js -- writes a loaded design back out as GemCad's ASCII .asc format (T-0206).
 *
 * There is no GemCad .asc WRITER anywhere in this project or its reference material --
 * `www/js/gemcad.js` (`GemCad.importAscText`) and `reference/gemcad-file-reader/` are read-only,
 * see kb/clean-room-and-licensing-constraints.md -- so this is the byte/text-level inverse of
 * `gemcad.js`'s own ASC reader, built from scratch using that reader's parsing logic
 * (`processAscLine`, `www/js/gemcad.js`) as the exact spec for what a valid line looks like.
 * kb/reading-gemcad-asc-and-gem-cut-files.md documents the read side in full; this file is the
 * write side of the same format.
 *
 * The source data is `www/js/design.js`'s polar representation (kb/the-polar-internal-
 * representation.md): a design never stores geometry, only each tier's mast angle, cut depth
 * and the index-wheel positions its facets are cut at, plus the gear and free-text metadata --
 * exactly the fields an .asc file's own lines carry. So writing one is a direct field-by-field
 * transcription, not a geometry computation: no plane intersection, no cube-cutting, nothing
 * `gemcad.js`'s reader does to turn these lines into a rendered shape.
 *
 * The angle/distance/index numbers already living on the design are the SAME doubles
 * `GemCad.importAscText` parsed out of a file (or that a user's edit set to some other exact
 * double) -- nothing here re-derives or rounds them -- so writing them with JavaScript's own
 * shortest-round-trip Number-to-String conversion (`formatNumber` below) reproduces the exact
 * same double when `GemCad.importAscText`'s `tryParseFloat` (`Number(trimmed)`) reads them back.
 * That is what makes the round trip in export_asc_test.js line up far tighter than any of the
 * format's own tolerances (INDEX_SNAP_TOLERANCE, NORMAL_AGREEMENT_TOLERANCE): the only
 * disagreement possible is in `fromGemCad`'s own re-derivation of the index from the rebuilt
 * facet normal, not in anything this writer rounds away.
 */

/**
 * A number, formatted so `GemCad.importAscText`'s `tryParseFloat` (`Number(trimmed)` under a
 * strict decimal/exponential regex) parses it back to the identical IEEE-754 double.
 *
 * JavaScript's default Number -> String conversion (`String(n)` / `n.toString()`) is specified
 * to produce the SHORTEST decimal string that round-trips back to the same double via `Number()`
 * -- exactly the property wanted here, and strictly better than a fixed decimal-place format
 * (which would either lose precision or carry needless trailing digits). `-0` stringifies as
 * `"0"` per the same spec, so no separate guard is needed for it; every angle/distance/index
 * value in this format is a plain finite double, never NaN or +/-Infinity, so no other guard is
 * needed either.
 */
function formatNumber(value) {
  return String(value);
}

/**
 * The design's `H` header lines: its own `headers[]` (the design's free-text comments -- what
 * the Comments dialog, T-0175, edits) with `title` made the FIRST line, unless it is already
 * there. `title` is the app's cut-header name (`cutMeta.name`, T-0145), which can differ from
 * `headers[0]` after a File > Rename -- a rename does not rewrite the design's own comments --
 * so this reconciles the two without duplicating a title that already matches.
 */
function headerLines(design, title) {
  const headers = (design.headers || []).slice();

  if (title !== undefined && title !== null && title !== '' && headers[0] !== title) {
    headers.unshift(title);
  }

  return headers;
}

/**
 * One tier's `a` line: `a <angle> <distance> <index> [n <name>] ...  [<cutting instructions>]`,
 * matching `processAscLine`'s own grammar in `gemcad.js` (the `a` branch) exactly, since that is
 * what will read this line back.
 *
 * A facet name reaching this from a real GemCad file is always a single whitespace-free token
 * (`gemcad.js`'s reader can only ever have captured one: `parts[index + 1]` after an `n` token,
 * from a line already split on spaces) -- but nothing stops a name set some other way (there is
 * no facet-name editor on this page today, but the design object's shape does not forbid one)
 * from containing whitespace, which WOULD corrupt this line if written verbatim: the reader would
 * see the name's second word as the next token, either a stray facet index or the start of the
 * cutting instructions. Defensively collapsed to underscores here so a malformed name can never
 * break the rest of the line; it never fires on any of this project's bundled sample designs.
 */
function tierLine(tier) {
  const parts = ['a', formatNumber(tier.angle), formatNumber(tier.distance)];

  for (const facet of tier.facets) {
    parts.push(formatNumber(facet.index));

    if (facet.name) {
      parts.push('n', String(facet.name).replace(/\s+/g, '_'));
    }
  }

  // The ASC reader's own `a`-line grammar treats free text as everything from the first token
  // that fails `tryParseFloat` to the end of the line -- so cutting instructions, if any, must
  // come last, after every index and name. (`gemcad.js`'s reader parses and logs this text but
  // never stores it on the tier for a `.asc`-parsed design -- see its own comment at the end of
  // `processAscLine` -- so a design loaded from a `.asc` always has `cuttingInstructions === ''`
  // and this branch is a no-op for it; it only fires for a `.gem`/`.gcs`-derived design or one a
  // user has since annotated, where writing the text is still the honest thing to do even though
  // re-reading this exported file will not recover it -- a property of the read side, not a
  // defect introduced here.)
  if (tier.cuttingInstructions) {
    parts.push(tier.cuttingInstructions);
  }

  return parts.join(' ');
}

/**
 * The design as GemCad `.asc` text.
 *
 * `{ title, author, date }` are the app's cut-header fields (`cutMeta`, T-0145 --
 * `web/src/lib/stores.js`), not part of the design object itself, since a design loaded from a
 * `.asc`/`.gem` file only ever supplies a title (its first `H` line) and the header component's
 * author/date fields are otherwise independent (see `design_load.js`'s own comment on
 * `applyDesignMetadata`). All three are optional: called with just a design, this writes the
 * design's own headers/footnotes/metadata verbatim.
 *
 * Geometry is never written -- an `.asc` does not store it; a reader reconstructs the shape by
 * cutting a block with the tier planes (kb/reading-gemcad-asc-and-gem-cut-files.md) -- only the
 * polar (angle, index, distance) description and the format's other metadata lines.
 */
export function designToAscText(design, { title, author, date } = {}) {
  const lines = [];

  // The literal 7-byte magic `GemCad.identifyFormat` sniffs for ("GemCad " at the front) so a
  // file opened through `GemCad.importBytes` (the page's own Open dialog, drag-and-drop) is
  // recognised as ASCII rather than mistaken for a `.gem`'s binary bytes. `importAscText`
  // itself does not care -- `processAscLine` silently ignores any line that starts with
  // "GemCad" and is neither `g`, `y`, `I`, `H`, `F` nor `a` -- but a real GemCad application
  // also expects this line, and it costs nothing to include.
  lines.push('GemCad 5.0');

  // `g <signed teeth> <origin index>`: design.js stores the tooth count as a magnitude plus a
  // `reversed` flag (T-0170/T-0171), the OPPOSITE of the file's own convention, where a negative
  // count itself means the wheel runs the other way (`g -96 48.0`). Translating back is exactly
  // the inverse of the sign bug T-0088 fixed on the read side: negate here, not just pass
  // `gear.teeth` through, or every reversed design would silently re-import as a forward one.
  const signedTeeth = design.gear.reversed ? -design.gear.teeth : design.gear.teeth;

  lines.push(`g ${formatNumber(signedTeeth)} ${formatNumber(design.gear.originIndex)}`);
  lines.push(`y ${formatNumber(design.symmetry.folds)} ${design.symmetry.mirror ? 'y' : 'n'}`);
  lines.push(`I ${formatNumber(design.refractiveIndex)}`);

  for (const header of headerLines(design, title)) {
    if (header !== '') {
      lines.push(`H ${header}`);
    }
  }

  // Author/date have no dedicated line in the format; GemCad users write them into a free `H`
  // line by hand (Compear125.asc: "H by Robert W. Strickland   4/9/96"), so this follows the
  // same convention rather than inventing a new one the reader would not recognise anyway (every
  // `H` line is opaque free text -- see kb/reading-gemcad-asc-and-gem-cut-files.md).
  if (author) {
    lines.push(`H by ${author}${date ? `  ${date}` : ''}`);
  } else if (date) {
    lines.push(`H ${date}`);
  }

  // One `a` line per tier, in `design.tiers`' own order -- `processAscLine` counts tiers strictly
  // in the order their `a` lines appear, so this is what reproduces the same tier count and the
  // same per-tier facet lists on read-back. Tier flags added since (`hidden`, `preform`,
  // `frosted`, T-0175) have no representation in this format at all and are intentionally not
  // written; the round trip this writer exists for is about the polar description, not the
  // planner's own bookkeeping on top of it.
  for (const tier of design.tiers) {
    lines.push(tierLine(tier));
  }

  for (const footnote of design.footnotes || []) {
    if (footnote !== '') {
      lines.push(`F ${footnote}`);
    }
  }

  // A trailing newline, matching a normal text file; `importAscText` copes fine either way (it
  // drops one trailing empty line from a trailing "\n" and does not require one at all).
  return `${lines.join('\n')}\n`;
}
