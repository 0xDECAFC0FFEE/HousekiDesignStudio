// Turning an opened file (or the built-in stone) into OBJ text plus the design behind it
// (ported from the page's script).

/**
 * OBJ text for a file the user opened, or the built-in stone at startup (T-0149) -- either
 * way, whatever of the four formats it is in, plus the index gear behind it (T-0141): a
 * GemCad design's own tooth count, still carrying GemCad's sign (negative means the wheel
 * runs the other way -- see setGearTeeth), or `null` for a plain OBJ mesh, which has no
 * faceting design and so no gear at all.
 *
 * Also the design's own title, author and date (T-0145, T-0148), where the file carries
 * them: a GemCad `.asc`/`.gem`'s first `H` header line (`GemCadFileMetadata.headers` in
 * gemcad.js) supplies `title` only -- `author` and `date` stay `undefined`, so
 * `applyDesignMetadata` clears those fields, because neither format has anything to put
 * there and an opened file's fields must reflect that file, not whatever the previous one
 * showed (2026-09-18). A `.gcs`'s own `<info>` element supplies all three directly (T-0148).
 * `title` is `null`, not `undefined` and not `''`, when the file has no title of its own -- a plain
 * .obj never has one, and a GemCad file need not carry an `H` line either -- so
 * cutNameFromLoad below can tell "no title in the file" apart from "the file's title
 * happens to be blank".
 *
 * And the design itself (T-0147), as `GemCadDesign.fromGemCad` (design.js) builds it from
 * the SAME parse the OBJ conversion below uses, so a design and its rendered mesh always
 * agree, or `null` for a plain .obj, which has no faceting design at all. `fromGemCad`
 * recovers each facet's index from its own stored geometry rather than trusting the raw
 * reader's index numbers, which are wrong whenever the gear is negative (see its own
 * comment in design.js) -- letting it throw here, into the caller's own catch (loadModelFile
 * for an opened file, boot() for the built-in stone), is deliberate: a design whose geometry
 * does not round-trip through polar coordinates is a genuine load failure for the CUTTING
 * INSTRUCTIONS, not for the stone -- so both callers wrap only the `fromGemCad` call itself
 * in a further try/catch and fall back to a `null` design, the same rule T-0153 established: a
 * reader or design failure must never stop the stone loading.
 *
 * Such a failure is COLLECTED, not logged and forgotten: every returned object carries a
 * `warnings` array (empty when all went well) holding one message per thing that was lost --
 * cutting instructions that could not be derived, a mesh that had to fall back to the file's own
 * corners. The CALLER shows them (2026-09-19, the user: "if the file can't be read ... can you
 * show a warning with the failed to parse error"), because only the caller knows when: the load
 * path calls `hideError()` on success, which would wipe a message this module had already put on
 * screen. `console.warn` still happens, in `showLoadAlert`, so the console record is unchanged.
 *
 * `.asc` and `.gcs` are text and `.gem` is binary, so the file (or, at startup, the inlined
 * `GEM_MODEL_GCS` string re-encoded to bytes) is always read as bytes and only decoded where
 * decoding is right. GemCad and Gem Cut Studio designs alike go through their own reader, and
 * `GemCadObj.toObjText` writes back out the file's own stored corners as OBJ off the same
 * parse -- still the mesh for a plain `.obj`, or the FALLBACK for any other format (see
 * `meshTextFromDesign` just below). Whenever `design` (above) is not null, T-0168 makes
 * `DesignMesh.toObjText` -- which intersects the DESIGN's own facet planes rather than
 * reading a file's stored corners -- the PRIMARY source instead: it is what keeps the
 * cutting-instructions pane and the rendered stone in agreement by construction, since both
 * now come from the same `design` object. Either way a faceting design and a mesh reach
 * `GemApp::load_obj` by the same road: one parser, one conditioning pass, one BVH build.
 */
export function objTextFromBytes(name, bytes) {
  if (/\.gcs$/i.test(name)) {
    // GemCutStudio.importText (gcs.js) does its own structural validation (malformed XML,
    // no <index>, a facet with fewer than three corners, an index_angle that disagrees with
    // its own facet normal) and throws all the way out for any of that -- nothing downstream
    // could render such a file either, so this is a genuine load failure, exactly like a
    // GemCad reader failure below.
    const { parsed, info } = GemCutStudio.importText(new TextDecoder().decode(bytes));

    // See the doc comment above for why this is wrapped separately from the structural
    // parse: a design that fails to round-trip through polar coordinates must not stop the
    // stone -- which comes from `toObjText` below, off the same parse -- from loading.
    let design = null;
    const warnings = [];

    try {
      design = GemCadDesign.fromGemCad(parsed, { name });
    } catch (cause) {
      warnings.push(`Loaded ${name}, but could not derive its cutting instructions: ${cause}`);
    }

    const fileCornerText = GemCadObj.toObjText(parsed, { name });

    return {
      text: meshTextFromDesign(name, design, fileCornerText, warnings),
      gear: parsed.metadata.gear,
      title: info.title || null,
      author: info.author,
      date: info.date,
      design,
      warnings,
    };
  }

  if (/\.(asc|gem)$/i.test(name)) {
    // importBytes sniffs the format itself, so a mislabelled file still loads.
    const parsed = GemCad.importBytes(bytes);
    const title = parsed.metadata.headers.length > 0 ? parsed.metadata.headers[0] : null;

    // The polar description is for the CUTTING INSTRUCTIONS, and the stone does not need
    // it: the mesh comes from `toObjText` below, off the same parse. So a design this
    // renderer cannot describe in index coordinates must still be a stone you can look
    // at -- the pane loses its tables, nothing else. Before this was caught, one real
    // design (Fiorello_80.gem) could not be opened AT ALL because `fromGemCad`'s
    // normal-agreement gate threw and took the whole load with it, and the stone it
    // refused renders perfectly. A null design is already the plain-.obj case, so every
    // consumer downstream handles it. Collected as a warning for the caller to show (see the
    // header): it used to be console.warn only, which meant a file whose instructions could not
    // be read looked, on screen, exactly like a file that has none.
    let design = null;
    const warnings = [];

    try {
      design = GemCadDesign.fromGemCad(parsed, { name });
    } catch (cause) {
      warnings.push(`Loaded ${name}, but could not derive its cutting instructions: ${cause}`);
    }

    const fileCornerText = GemCadObj.toObjText(parsed, { name });

    return {
      text: meshTextFromDesign(name, design, fileCornerText, warnings),
      gear: parsed.metadata.gear,
      title,
      design,
      warnings,
    };
  }

  // A plain .obj: no design exists at all, so there is nothing for DesignMesh to build from.
  window.gemMeshSource = 'file-corner';

  return {
    text: new TextDecoder().decode(bytes), gear: null, title: null, design: null, warnings: [],
  };
}

/**
 * The OBJ text to hand `GemApp`, given a successfully derived `design` (T-0168) and the
 * file-corner text `GemCadObj.toObjText` already produced off the same parse.
 *
 * `DesignMesh.toObjText` -- which intersects the design's own facet planes
 * ([[building-the-stone-mesh-from-a-design-s-own-face]]) rather than reading a file's stored
 * corners -- is tried first. `fileCornerText` is the fallback, used only when the builder
 * itself throws (an unclosed or otherwise pathological design; not expected of any file in
 * this project's own corpus -- see that article's full-corpus measurement -- but the load
 * must never be blocked on it, the same rule T-0153 established for `fromGemCad` itself).
 *
 * `design` may be `null` (a plain `.obj`, or a `.asc`/`.gem`/`.gcs` whose OWN `fromGemCad` gate
 * failed) -- in which case `fileCornerText` is used directly, with no attempt to build a mesh
 * from a design that does not exist.
 *
 * A builder failure pushes its message onto `warnings` for the caller to show; it is never the
 * error box, since the stone is on screen either way.
 *
 * Also records `window.gemMeshSource` ('design' or 'file-corner'), purely diagnostic, in the
 * same spirit as `window.gemFacetTierDiagnostics` (T-0160): the two meshes can measure very
 * close to identical (see the KB article above), so a script verifying that the design path
 * actually ran needs something more direct than "the stone rendered" or "the facet count
 * looks right" -- it needs to know which branch of this function actually returned. Set on
 * every call (never left stale from a previous load), including when `design` is `null`.
 */
export function meshTextFromDesign(name, design, fileCornerText, warnings = []) {
  if (!design) {
    window.gemMeshSource = 'file-corner';

    return fileCornerText;
  }

  try {
    const text = DesignMesh.toObjText(design, { name });

    window.gemMeshSource = 'design';

    return text;
  } catch (cause) {
    warnings.push(
      `Loaded ${name}'s design, but could not build its mesh from the design's own facet ` +
      `planes; using the file's own corners instead: ${cause}`
    );
    window.gemMeshSource = 'file-corner';

    return fileCornerText;
  }
}

/**
 * The cut name a successful load should show (T-0145): the design's own title when the
 * file carries one, since the user asked for that over the filename ("opening a design
 * sets the cut name to the title in the gcs file") -- SRB.asc's `H` line is "Standard Round
 * Brilliant", a far better name than "SRB". Falls back to the opened file's name minus its
 * extension only when the file has no title of its own (a plain .obj never does).
 */
export function cutNameFromLoad(file, converted) {
  return converted.title !== null && converted.title !== ''
    ? converted.title
    : file.name.replace(/\.[^.]+$/, '');
}
