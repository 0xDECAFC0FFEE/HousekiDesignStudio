// Startup: what the page's `main()` did. Unpacks the inlined wasm, glue and GemCad scripts,
// builds the GemApp on the built-in stone, fills in the header and tier tables for it, mounts
// the settings panel, and publishes the `window.gem*` hooks the harness and the tools use.
//
// A classic-script data bundle is inlined into the page by make_page.py, ahead of the app's
// own script, and defines these globals (the page must open from file://, where nothing can be
// fetched and no module can be imported, so everything is inlined):
//
//   GEM_BINDINGS_GZIP_BASE64      the wasm-bindgen glue (no-modules target), gzip then base64;
//                                 boot inflates and runs it, which defines `wasm_bindgen`
//   GEM_WASM_GZIP_BASE64          the .wasm binary, gzip then base64
//   GEM_GEMCAD_GZIP_BASE64        www/js/gemcad.js, gemcad_obj.js, design.js, gcs.js,
//                                 design_mesh.js and edit_history.js, gzip then base64; boot
//                                 runs them, which publishes GemCad, GemCadObj, GemCadDesign,
//                                 GemCutStudio, DesignMesh and EditHistory
//   GEM_MODEL_GCS                 the built-in stone, resources/hex_cut_v2.gcs, as text (T-0149):
//                                 boot runs it through objTextFromBytes, the SAME path an
//                                 opened .gcs takes, before constructing GemApp
//   GEM_ENVIRONMENT_IMAGE_BASE64  the skybox image, base64 encoded (see ENVIRONMENT in make_page.py)
//   GEM_ENVIRONMENT_IMAGE_TYPE    its MIME type, such as 'image/png'
//
// The shaders are not among them: they are GLSL files compiled into the wasm module
// (`include_str!` in src/), so there is nothing for the page to load.

import { tick } from 'svelte';
import { gunzipBase64, runInlineScript } from './inline.js';
import { objTextFromBytes } from './design_load.js';
import { selfCheckTierIdsAgainstHexCutV2Gcs } from './tiers.js';
import { getDesign } from './tier_controller.js';
import { rebuildStoneFromDesign } from './selection.js';
import { engine, ready, showError } from './stores.js';
import { restorePersistedSettings, startSession, installLoadedDesign } from './session.js';
import { shaderCompileIsSlow, showShaderCompileNotice } from './shader_wait.js';
import {
  attachCanvasControls, requestRender, lastRenderCost, beginInteraction,
} from './viewport.js';

export async function boot() {
  // The glue, the binary and the GemCad reader are inlined compressed (see make_page.py).
  // Inflate them, run the glue to define `wasm_bindgen`, then initialise synchronously from
  // the bytes.
  const [bindings, wasmBytes, gemcadSource] = await Promise.all([
    gunzipBase64(GEM_BINDINGS_GZIP_BASE64),
    gunzipBase64(GEM_WASM_GZIP_BASE64),
    gunzipBase64(GEM_GEMCAD_GZIP_BASE64),
  ]);

  runInlineScript(new TextDecoder().decode(bindings));
  wasm_bindgen.initSync({ module: wasmBytes });

  // gemcad.js, gemcad_obj.js, design.js, gcs.js, design_mesh.js and edit_history.js, run the
  // same way: classic scripts that publish `GemCad`, `GemCadObj`, `GemCadDesign`,
  // `GemCutStudio`, `DesignMesh` and `EditHistory`, which objTextFromBytes, the built-in stone
  // below and the tier tables all need.
  runInlineScript(new TextDecoder().decode(gemcadSource));
  selfCheckTierIdsAgainstHexCutV2Gcs();

  // The no-modules build attaches its exports to the global `wasm_bindgen` object.
  const { GemApp, ShaderLink } = wasm_bindgen;

  // The built-in stone (T-0149): the SAME reader path an opened .gcs takes, via
  // objTextFromBytes, rather than a separate conversion at build time -- so the
  // startup stone and an opened file can never drift apart. `GEM_MODEL_GCS` is
  // resources/hex_cut_v2.gcs's own text, inlined by make_page.py; re-encoded to bytes because
  // objTextFromBytes's .gcs branch decodes bytes, exactly like a File read would hand it.
  //
  // The bare-mesh fallback (resources/hex_cut_v2.obj as GEM_MODEL_OBJ) was removed on
  // 2026-09-20: it kept a second copy of the stone in the page for a failure never expected of
  // the inlined GEM_MODEL_GCS. A structural failure here is now an error, shown like a failed
  // GemApp construction below. A design that fails only ITS OWN gate (fromGemCad) is still
  // handled inside objTextFromBytes, which yields a null design rather than throwing.
  let startupModel;

  try {
    startupModel = objTextFromBytes('hex_cut_v2.gcs', new TextEncoder().encode(GEM_MODEL_GCS));
  } catch (cause) {
    showError(`Could not read the built-in hex_cut_v2.gcs: ${cause}`);
    return;
  }

  // Linking the shader takes the better part of ten seconds on Windows, where WebGL goes through
  // ANGLE and Direct3D's shader compiler. Put an indeterminate bar up first, and only where it
  // is needed: on macOS and Android the same link is over in a fraction of a second and there
  // would be nothing to look at. `shader_wait.js` explains the measurement.
  //
  // Where the browser offers KHR_parallel_shader_compile (Chrome and Edge), the link is started
  // and then polled once a frame, so the page, the bar and the rest of the browser keep drawing
  // through it. Asking for the result before it was ready is what used to freeze all three;
  // `gpu::PendingProgram` has the measurement. Firefox does not offer the extension, so there
  // `is_complete` is true at once and `from_shader_link` pays the whole compile in one blocking
  // call, which is why the bar must be on screen, and awaited, before the link starts.
  const canvas = document.getElementById('canvas');
  const notice = shaderCompileIsSlow(canvas)
    ? showShaderCompileNotice(document.getElementById('viewport'), canvas)
    : null;

  if (notice) {
    await notice.painted;
  }

  let app;

  // `finally`, so a constructor that throws takes the bar down too and leaves the error box
  // showing on its own rather than behind it.
  try {
    const link = new ShaderLink('canvas');

    // A timer rather than requestAnimationFrame, which a hidden tab never fires: a page opened
    // in the background should finish linking there, not wait to be looked at first.
    while (!link.is_complete()) {
      await new Promise(resolve => setTimeout(resolve, 16));
    }

    app = GemApp.from_shader_link(link, startupModel.text);
  } catch (cause) {
    showError(String(cause));
    return;
  } finally {
    notice?.remove();
  }

  // Fills the sub bar's gear reading and ruler, the cutting-instructions pane's header and
  // tier tables, and the facet<->tier map, on FIRST PAINT, with no file opened -- T-0149's
  // whole point: the built-in stone is a real faceting design now, not a bare mesh, so these
  // no longer start empty. `installLoadedDesign` (session.js) is the SAME tail
  // `loadModelFile` runs after opening a file, and `share_state.js`'s hash restore (T-0198)
  // runs after loading a saved one, pulled into one place so the three cannot drift the way
  // this and `loadModelFile` had already started to.
  //
  // `startupModel.title || undefined` guards against a future hex_cut_v2.gcs whose <info>
  // omits an attribute overwriting the header's sensible defaults with an empty string.
  //
  // `installLoadedDesign` also calls `requestRender()`, which here runs BEFORE
  // `attachCanvasControls` gives the render loop its canvas (below) -- safe only because
  // `requestRender` schedules a macrotask (`setTimeout`, see work_budget.js), and the
  // `await tick()` a few lines down resolves as a MICROTASK, which the JS event loop always
  // drains first: `attachCanvasControls` has already run by the time this request's timer can
  // possibly fire. If that scheduling ever changed (an immediate/synchronous render path,
  // say), this ordering assumption would need revisiting.
  installLoadedDesign(app, {
    text: startupModel.text,
    design: startupModel.design,
    gear: startupModel.gear,
    title: startupModel.title || undefined,
    author: startupModel.author || undefined,
    date: startupModel.date || undefined,
    warnings: startupModel.warnings,
  });

  // The panel reads its values from `app`, so saved settings go in first, then the panel mounts.
  engine.app = app;
  restorePersistedSettings(app);

  ready.set(true);
  // `window.gemApp` is the harness's "the page is up" signal, and it reads the panel's controls
  // straight afterwards (`#lightingModel`, say). Svelte mounts them in a microtask, so wait for
  // it: the hooks below appear only once every control is in the document.
  await tick();

  startSession(app);
  attachCanvasControls(document.getElementById('canvas'));
  publish(app);
  requestRender();
}

/**
 * Exposes the hooks the console, the browser harness and the verification scripts use.
 *
 * `window.gemApp` for poking at from the console (`gemApp.diagnostics_text()` gives the stone's
 * stats), and `window.gemRequestRender` (2026-09-18), which the tier selection and the
 * verification scripts use to ask for a redraw; `?.()` makes a call a silent no-op before this
 * line has run (wasm still loading, or failed), exactly like `window.gemApp` being undefined
 * until now. (The instructions-pane resize handle used to call it on every drag step; since
 * T-0188 it scoots the canvas instead and the canvas is redrawn once on release, see
 * `beginPaneScoot` in viewport.js.)
 *
 * `window.gemRebuildStoneFromDesign` (T-0168): the entry point a future angle/tooth/depth
 * editor, or a round-trip render test, calls to regenerate the mesh from the current design --
 * see rebuildStoneFromDesign's own doc comment. Bound to THIS `app`.
 */
function publish(app) {
  window.gemApp = app;
  window.gemRequestRender = requestRender;
  // What the last trace pass cost, in ms: for the harness's pacing checks and for anyone
  // wondering why a page feels slow. Reading it changes nothing.
  window.gemLastRenderCost = lastRenderCost;
  // Drops the renderer to draft quality for a moment: what every kind of dragging calls, from
  // the canvas to the edit-mode scales (see selection.js's quick rebuild).
  window.gemBeginInteraction = beginInteraction;
  window.gemRebuildStoneFromDesign = () => rebuildStoneFromDesign(app);
  // The loaded design itself, read-only, for the console and the verification scripts -- the
  // same purpose `window.gemFacetTierDiagnostics` and `window.gemMeshSource` serve, and the only
  // way a check script can see a fact the design holds but the page does not draw. The comments
  // (2026-09-19) are exactly that: `design.headers`/`.footnotes` are shown nowhere but in their
  // own dialog, so check_comments.py has nothing else to assert against. Reading it changes
  // nothing; a caller that MUTATES what it returns is editing the live design, which is why
  // nothing on the page reaches the design this way.
  window.gemDesign = () => getDesign();
}
