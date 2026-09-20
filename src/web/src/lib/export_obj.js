/**
 * File > Export > Wavefront (.obj) (T-0204): saves the currently loaded stone as a plain .obj
 * mesh, the simplest of the four export formats -- OBJ generation already exists, this just
 * has to reach it and trigger a download.
 *
 * The mesh always comes from the loaded DESIGN when one exists: `getDesign()`
 * (tier_controller.js) returns the `GemCadDesign` a `.asc`/`.gem`/`.gcs` load parsed, and
 * `DesignMesh.toObjText(design, { name })` (www/js/design_mesh.js, an inlined classic global --
 * see kb/building-the-stone-mesh-from-a-design-s-own-face.md) intersects its own facet planes
 * into OBJ text, exactly the mesh `GemApp` is rendering whenever a design is loaded
 * (design_load.js's `meshTextFromDesign` tries the very same call first, for the same reason).
 *
 * `getDesign()` returns `null` for a plain `.obj` (no design at all) or a `.asc`/`.gem`/`.gcs`
 * whose own `fromGemCad` gate failed (see design_load.js's doc comment on that gate) --
 * `window.gemMeshSource` is `'file-corner'` in both cases. Neither `design_load.js` nor
 * `session.js` currently keeps that file's raw OBJ text anywhere reachable once
 * `installLoadedDesign` has run and returned (it is a local variable of `loadModelFile` and
 * `boot()`), and this ticket's own file-ownership rule (T-0204, see its ticket log) keeps this
 * module from adding a store there itself, since those files belong to sibling export tickets'
 * agents editing concurrently. So this case is reported clearly instead of silently exporting
 * stale or wrong text; a follow-up ticket owning session.js/design_load.js can wire a small
 * store (mirroring the existing `window.gemMeshSource`/`window.gemDesign` hooks) to close this
 * gap later.
 */
import { getDesign } from './tier_controller.js';
import { cutMeta, showLoadAlert } from './stores.js';
import { saveFileAs } from './export_file.js';
import { get } from 'svelte/store';

/** Used when the cut name is empty or not filename-safe on its own. */
const FALLBACK_NAME = 'stone';

/**
 * `name` turned into a safe `.obj` filename: trimmed, stripped of characters no filesystem
 * accepts in a name (`/ \ : * ? " < > |`, covering both POSIX and Windows), and replaced by
 * `FALLBACK_NAME` if nothing usable is left -- an empty cut name is possible (the header field
 * can be cleared), and must still produce a file, not a bare ".obj".
 */
export function objFilename(name) {
  const cleaned = (name || '').trim().replace(/[\\/:*?"<>|]/g, '');

  return `${cleaned || FALLBACK_NAME}.obj`;
}

/**
 * The OBJ text for `design`, or `null` for `null` (no design to build one from -- see the
 * header comment above for that case). May throw the same way `DesignMesh.toObjText` can (an
 * unclosed or otherwise pathological design, per its own doc comment) -- callers decide how to
 * report that; `exportObj` below shows it as an alert rather than failing silently.
 *
 * Takes `design` as a plain argument, rather than reading `getDesign()` itself, so it is a pure
 * function of its inputs: export_obj_test.js exercises it directly against designs loaded from
 * the bundled reference samples, without needing tier_controller.js's live module state (which
 * only a running page ever populates) to stand in for "a design is loaded".
 */
export function objTextForDesign(design, name) {
  return design ? DesignMesh.toObjText(design, { name }) : null;
}

/** The OBJ text for whatever is currently loaded -- `objTextForDesign` against `getDesign()`. */
export function objTextForCurrentDesign(name) {
  return objTextForDesign(getDesign(), name);
}

/**
 * File > Export > Wavefront (.obj)'s `onSelect`: builds the OBJ text for the loaded stone and
 * saves it through the OS's own Save dialog when available (`saveFileAs`, export_file.js), or
 * shows why it could not. The filename is the cut header's current name (`cutMeta`, stores.js --
 * the same name `cutNameFromLoad` set on load and File > Rename can change), matching every
 * other export format's own filename rule.
 */
export async function exportObj() {
  const name = get(cutMeta).name;
  let text;

  try {
    text = objTextForCurrentDesign(name);
  } catch (cause) {
    showLoadAlert('Could not export this design to OBJ', String(cause));
    return;
  }

  if (text === null) {
    showLoadAlert(
      'Could not export to OBJ',
      'This stone has no cutting-instructions design loaded (a plain .obj was opened, or its ' +
      'design could not be read), so there is no facet data to export a mesh from.'
    );
    return;
  }

  await saveFileAs(objFilename(name), text, {
    description: 'Wavefront OBJ',
    mimeType: 'model/obj',
    extensions: ['.obj'],
  });
}
