// Everything the page does with a live GemApp that is not drawing: applying parameters, the
// material and its edit history, restoring saved settings, the skybox, opening a file. What
// the page's old `wireUp(app)` closure held, minus its DOM and the canvas (viewport.js).
//
// Components call these from their handlers and read what they show from the stores in
// stores.js; this module never touches the panel's elements, except the two by-id lookups the
// page always made (`#obj-file` to clear it, and the ids the renderer hides).

import { get } from 'svelte/store';
import {
  engine, showError, showLoadAlert, hideError, clearErrorIf, bumpParams, materialPreset, renderer, lightingModel,
  accumulationTarget, resolutionScale, dragQuality, canUndo, canRedo, applyDesignMetadata,
  historyChanged,
} from './stores.js';
import { PERSISTED_PARAM_SETTINGS, VIEW_SLIDERS, SLIDER_SPECS } from './panel_config.js';
import {
  writeSetting, readSettingNumber, readSettingBool, readSettingColor,
} from './settings.js';
import { environmentImageBlob, decodeImage } from './inline.js';
import { objTextFromBytes, cutNameFromLoad } from './design_load.js';
import { showStoneStats } from './stone_stats.js';
import { buildFacetTierMap, setFacetTierMap } from './facet_map.js';
import {
  highlightDesignTier, clearFacetAndTierHighlight, rebuildStoneFromDesign, syncFrostedFacets,
} from './selection.js';
import { setGearTeeth, DEFAULT_GEAR_TEETH } from './gear.js';
import { resetRuler } from './index_ruler.js';
import { pickers } from './pickers.js';
import * as tiers from './tier_controller.js';
import { requestRender, beginInteraction, cancelFacetTurn, syncLuxProgress } from './viewport.js';

/**
 * The names Rust holds the material's editable fields under (what an update can carry). The
 * stone color is its color at full opacity (`stone_base_color`), and `stoneOpacity` the
 * absorption scale: the two the stone color's editor shows, each restorable on its own.
 */
export const MATERIAL_FIELDS = ['preset', 'refractiveIndex', 'dispersion', 'stoneColor', 'stoneOpacity'];

/** localStorage keys, one per persisted control (T-0156). */
export const RENDERER_SETTING = 'gems.renderer';
export const LUX_TARGET_SETTING = 'gems.luxTarget';
export const LIGHTING_MODEL_SETTING = 'gems.lightingModel';
export const USE_BACKGROUND_SETTING = 'gems.useBackground';
export const BACKGROUND_COLOR_SETTING = 'gems.backgroundColor';
export const USE_WINDOW_COLOR_SETTING = 'gems.useWindowColor';
export const WINDOW_COLOR_SETTING = 'gems.windowColor';
export const HEAD_SHADOW_COLOR_SETTING = 'gems.headShadowColor';
export const WIREFRAME_SETTING = 'gems.wireframe';
export const RESOLUTION_SETTING = 'gems.resolutionScale';
export const DRAG_QUALITY_SETTING = 'gems.dragQuality';

// LightingModel::as_u32 (src/params.rs): 0 Studio, 1 AngleRings, 2 Isometric, 3 Cosine, 4
// Image -- the one value set_environment_image below always switches to, see its own use.
const IMAGE_LIGHTING_MODEL = 4;

// The edit history (2026-09-18): the user's edits to the cutting instructions and the
// material, as diffs Edit > Undo and Redo step through (www/js/edit_history.js). A tier
// drag is a delete and an insert, a description edit an update (tier_controller records
// both); a change to the material, refractive index, dispersion or stone color is an
// update of just the fields it changed, recorded below. The stone color is recorded once,
// when its sliders close, not on every step.
let editHistory = null;

// The preset the dropdown showed before its latest change: by the time 'change' fires, the
// dropdown's own value is already the new one, which is not what "before" should record.
let presetShown = '';

// The material as it was when the stone color's sliders opened, or null while they are shut.
let stoneColorBefore = null;

// The lighting model restored from a previous session, for the skybox decode to put back.
let savedLightingModel = null;

/** True once `startSession` has run, i.e. there is a GemApp and a history to step through. */
export function sessionReady() {
  return editHistory !== null;
}

/**
 * Restores every persisted setting into `app` (and into the page-only stores), before the panel
 * first reads any of them -- so its first paint already shows the saved values, not the
 * Rust/markup defaults for one frame.
 *
 * "Saved" here means localStorage, not a cookie: see `readSetting` for why. Each is restored
 * through the exact same Rust setter (hence the same clamp) a control move uses, per T-0156's own
 * requirement, and a missing, corrupt or out-of-range value falls back to the Rust default.
 */
export function restorePersistedSettings(app) {
  for (const name of PERSISTED_PARAM_SETTINGS) {
    const spec = SLIDER_SPECS[name];
    const saved = readSettingNumber(`gems.${name}`, spec.min, spec.max, null);

    // Not applyParam: this runs before the render loop exists, and applyParam asks it for a
    // frame. set_param directly; the slider reads the result back the same way it does for
    // every other one.
    if (saved !== null) {
      try {
        app.set_param(name, saved);
      } catch (cause) {
        // A stored value this Rust build no longer accepts is not worth failing the
        // page over; the slider then shows whatever Rust already defaulted to.
      }
    }
  }

  syncSpectralSamples();

  // Restore the renderer and the accumulation target before their first sync, so that sync
  // (and the hidden-controls/lux-row visibility it drives) reflects the restored value
  // straight away rather than the Rust/markup default for one frame.
  const savedRenderer = readSettingNumber(RENDERER_SETTING, 0, 2, null);

  if (savedRenderer !== null) {
    app.set_renderer(savedRenderer);
  }

  const luxTarget = SLIDER_SPECS['lux-target'];
  const savedLuxTarget = readSettingNumber(LUX_TARGET_SETTING, luxTarget.min, luxTarget.max, null);

  accumulationTarget.set(savedLuxTarget !== null ? savedLuxTarget : luxTarget.value);

  // Restored before the first read-back, so the dropdown (and the analytical warning) reflects
  // the saved choice immediately rather than the Rust/markup default for one frame. A saved
  // Image (4) is deliberately not applied here -- there is no environment image yet, this
  // early, so it would only throw -- but see the skybox decode, which restores it in the one
  // case where letting it apply naturally is not enough: value !== Image.
  savedLightingModel = readSettingNumber(LIGHTING_MODEL_SETTING, 0, 4, null);

  if (savedLightingModel !== null && savedLightingModel !== IMAGE_LIGHTING_MODEL) {
    try {
      app.set_lighting_model(savedLightingModel);
    } catch (cause) {
      // Fall back to whatever Rust already defaulted to -- a stored value this Rust build
      // no longer accepts is not worth failing the page over.
    }
  }

  // Background, head shadow and window (leak) colors, one `set_background`/`set_window_color`
  // call each: either half missing falls back to whatever Rust already holds for it, so a page
  // that only ever set the checkbox (say) does not silently reset the other's color.
  const savedUseBackground = readSettingBool(USE_BACKGROUND_SETTING, null);
  const savedBackgroundColor = readSettingColor(BACKGROUND_COLOR_SETTING, null);

  if (savedUseBackground !== null || savedBackgroundColor !== null) {
    app.set_background(
      savedUseBackground !== null ? savedUseBackground : app.background_enabled(),
      ...(savedBackgroundColor !== null ? savedBackgroundColor : app.background_color())
    );
  }

  const savedUseWindowColor = readSettingBool(USE_WINDOW_COLOR_SETTING, null);
  const savedWindowColor = readSettingColor(WINDOW_COLOR_SETTING, null);

  if (savedUseWindowColor !== null || savedWindowColor !== null) {
    app.set_window_color(
      savedUseWindowColor !== null ? savedUseWindowColor : app.window_color_enabled(),
      ...(savedWindowColor !== null ? savedWindowColor : app.window_color())
    );
  }

  const savedHeadShadowColor = readSettingColor(HEAD_SHADOW_COLOR_SETTING, null);

  if (savedHeadShadowColor !== null) {
    app.set_head_shadow_color(...savedHeadShadowColor);
  }

  const savedWireframe = readSettingBool(WIREFRAME_SETTING, null);

  if (savedWireframe !== null) {
    app.set_wireframe(savedWireframe);
  }

  // Resolution scale, full quality and while dragging. There is no Rust field behind the
  // still-frame resolution slider at all (`app.render(width, height)` just draws at whatever
  // resolution the page asks for, whichever renderer is selected; see src/params.rs's own
  // comment on why resolution is handled here, not in Rust), so a store is all that setting
  // needs. "Drag quality" DOES have a Rust counterpart (`set_drag_quality`), because
  // it also scales the max bounce count, not just the canvas resolution -- so its restored
  // value is pushed into Rust right after the store is set, below.
  for (const [store, key, name] of [
    [resolutionScale, RESOLUTION_SETTING, 'resolution'],
    [dragQuality, DRAG_QUALITY_SETTING, 'drag-quality'],
  ]) {
    const spec = SLIDER_SPECS[name];
    const saved = readSettingNumber(key, spec.min, spec.max, null);

    store.set(saved !== null ? saved : spec.value);
  }

  app.set_drag_quality(get(dragQuality));

  // What the panel shows first.
  renderer.set(app.renderer());
  lightingModel.set(app.lighting_model());
  // Show the preset the renderer actually starts with, not merely the first listed.
  presetShown = app.default_material_name();
  materialPreset.set(presetShown);
}

/**
 * Starts the session on a GemApp: the edit history, the tier toolbar's way to the stone, and
 * the skybox. Called once by boot, after the settings panel has mounted.
 */
export function startSession(app) {
  editHistory = EditHistory.create({ onChange: syncEditMenu });

  tiers.setEditRecorder(entry => editHistory.record(entry));
  tiers.setHistoryFrames({
    begin: beginHistoryFrame, commit: commitHistoryFrame, cancel: cancelHistoryFrame,
  });

  // The tier toolbar's way to the stone (T-0175). A rebuild that fails (the tiers left on the
  // stone no longer close it, e.g. every crown tier hidden) keeps the last stone that could be
  // built and says so in the error box, rather than only in the console, since the pane and
  // the stone then disagree; the next successful rebuild takes that message down again.
  const REBUILD_ERROR =
    'Could not rebuild the stone from the cutting instructions: the tiers left on it do not ' +
    'close a solid. The stone shown is the last one that could be built.';

  tiers.setStoneHooks({
    rebuild(options) {
      const rebuilt = rebuildStoneFromDesign(app, options);

      if (!rebuilt) {
        showError(REBUILD_ERROR);
      } else {
        clearErrorIf(REBUILD_ERROR);
      }

      return rebuilt;
    },
    select(tier) {
      if (tier) {
        highlightDesignTier(app, tier);
      } else {
        clearFacetAndTierHighlight(app);
        requestRender();
      }
    },
    // Re-sends the frosted facets (T-0183) after a toolbar edit that may have changed which
    // tiers are frosted -- the Frosted toggle, its undo and redo -- without rebuilding the stone.
    frosted() {
      syncFrostedFacets(app);
    },
  });

  syncEditMenu();
  decodeSkybox(app);
}

// A mode's own undo stack, while it has one open (T-0231, scale height: "allow undoing in a local
// undo stack while in scale height mode"), or null. `{ canUndo(), canRedo(), undo(), redo() }`.
//
// While one is set, Edit > Undo and Redo, Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z and Ctrl+Y all step IT
// instead of the edit history, and the menu's greying follows it -- every one of those reaches
// `stepHistory`, `undo` or `redo` below, so routing here is the whole of it. Edit mode has no
// such stack: its drags are real history entries inside a frame (`beginHistoryFrame`), and Undo
// steps through them there. Scale height's changes are not history entries at all until Done --
// the whole session is ONE entry -- so it keeps its own.
let localHistory = null;

/** Hands Undo and Redo to a mode's own stack (`null` gives them back to the edit history). */
export function setLocalHistory(history) {
  localHistory = history;
  syncUndoMenu();
}

/**
 * Brings Edit > Undo and Redo up to date with whichever stack they step: a mode's own, while it
 * has one, else the edit history. Exported for the mode, which calls it as its stack changes.
 */
export function syncUndoMenu() {
  const stack = localHistory ?? editHistory;

  canUndo.set(stack ? stack.canUndo() : false);
  canRedo.set(stack ? stack.canRedo() : false);
}

function syncEditMenu() {
  syncUndoMenu();
  // T-0198: every one of the moments EditHistory calls onChange for (record, undo, redo,
  // frame begin/commit/cancel, clear) is also a moment the URL hash may need rewriting --
  // "if a thing can be undone it should also be saved", the user's own words. See
  // historyChanged's own doc comment (stores.js) for why this is a plain counter bump rather
  // than session.js calling share_state.js directly.
  historyChanged.update(n => n + 1);
}

/**
 * True while an edit-mode frame is open (`editHistory.inFrame()`), for `share_state.js` to
 * skip saving mid-drag: `beginFrame` fires `onChange` (so `historyChanged` bumps) before the
 * frame's own many recorded steps, and `commitFrame` fires it again once the frame closes with
 * everything folded into one entry -- so skipping every bump made WHILE a frame is open still
 * saves the committed result, just once, instead of once per slider step. `false` before
 * `startSession` has run (nothing is open yet).
 */
export function historyInFrame() {
  return editHistory !== null && editHistory.inFrame();
}

// ---- parameters

/**
 * Traces each color separately (3 spectral samples) exactly when the dispersion is above
 * zero. With zero dispersion the three would take identical paths, so one sample gives the
 * same image at a third of the cost.
 */
export function syncSpectralSamples() {
  const app = engine.app;

  app.set_param('spectralSamples', app.get_param('dispersion') > 0 ? 3 : 1);
}

/**
 * Sets a parameter and redraws; false if Rust refused it. The slider reads its own value
 * back afterwards: Rust clamps and wraps, and the readout should show what is actually being
 * rendered.
 */
export function applyParam(name, value) {
  const app = engine.app;

  try {
    app.set_param(name, value);
  } catch (cause) {
    showError(String(cause));
    return false;
  }

  if (name === 'dispersion') {
    syncSpectralSamples();
  }

  if (VIEW_SLIDERS.includes(name)) {
    // The user took the pose over, so a turn towards a clicked facet stops where it is.
    cancelFacetTurn();
  }

  // Every parameter, not only the view ones (2026-09-19, the user: "when the ruler is moved or
  // the angles of the cut are changed or the depth of the cut is changed or the stone is moved or
  // anything can you make sure the resolution is dropped and the internal bounces are dropped").
  // A slider is dragged, so each step should cost as little as possible; full quality returns
  // shortly after the last one.
  beginInteraction();
  requestRender();
  return true;
}

// ---- material, and the edit history of it

/** The material as the fields an update can hold. */
export function materialState() {
  const app = engine.app;

  return {
    preset: presetShown,
    refractiveIndex: app.get_param('refractiveIndex'),
    dispersion: app.get_param('dispersion'),
    stoneColor: Array.from(app.stone_base_color()),
    stoneOpacity: app.get_param('absorptionScale'),
  };
}

/**
 * Sets whichever material fields `fields` holds, and brings the controls up to date. Exported
 * (T-0198) for `share_state.js` to restore a hash's saved material through the SAME setter
 * undo/redo already uses, rather than a second copy of this logic -- the brief's own
 * instruction. Deliberately sets the preset LABEL (`presetShown`/`materialPreset`) without
 * calling `app.set_material(name)`: that Rust call would reset refractiveIndex, dispersion
 * and the stone color to the PRESET's own defaults, clobbering the other four fields this
 * same call is about to set from the saved state. `applyOps` (undo/redo) relies on this exact
 * property already; a restored hash needs it for the same reason.
 */
export function applyMaterialFields(fields) {
  const app = engine.app;

  if ('preset' in fields) {
    presetShown = fields.preset;
    materialPreset.set(fields.preset);
  }

  for (const name of ['refractiveIndex', 'dispersion']) {
    if (name in fields) {
      app.set_param(name, fields[name]);
    }
  }

  if ('stoneColor' in fields) {
    app.set_stone_base_color(...fields.stoneColor);
  }

  if ('stoneOpacity' in fields) {
    app.set_param('absorptionScale', fields.stoneOpacity);
  }

  bumpParams();
  pickers.stoneColor?.refresh();
  syncSpectralSamples();
  // A colour is dragged in its picker like any slider: draft while it moves.
  beginInteraction();
  requestRender();
}

/** Records the change to `fields` since `before`, if there was one. */
export function recordMaterialChange(label, fields, before) {
  const diff = EditHistory.changedFields(before, materialState(), fields);

  if (diff) {
    editHistory.record({ label, ops: [{ kind: 'update', target: 'material', ...diff }] });
  }
}

/**
 * Makes a one-step material change and records it. The stone color's sliders are closed
 * first, which records their own change, so the two never end up in one entry.
 */
export function recordedMaterialEdit(label, fields, change) {
  pickers.stoneColor?.close();

  const before = materialState();

  change();
  recordMaterialChange(label, fields, before);
}

/** The stone colour picker opened: remember the material to diff against when it closes. */
export function stoneColorOpened() {
  stoneColorBefore = materialState();
}

/**
 * One edit-history entry per open, from before openSaturation to the close -- whether by the
 * swatch, another picker, a press anywhere else (closeOnClickAway, also the user's request), or
 * an undo -- and none if the color ended where it started.
 */
export function stoneColorClosed() {
  recordMaterialChange('Change stone color', ['stoneColor', 'stoneOpacity'], stoneColorBefore);
  stoneColorBefore = null;
}

/**
 * The material dropdown changed to `name`. The dropdown is controlled by `materialPreset`, so a
 * preset Rust refuses simply never reaches the store and the dropdown keeps showing the one in
 * use (it used to be reset by hand).
 */
export function changeMaterial(name) {
  const app = engine.app;

  recordedMaterialEdit('Change material', MATERIAL_FIELDS, () => {
    try {
      app.set_material(name);
    } catch (cause) {
      showError(String(cause));
      return;
    }

    presetShown = name;
    materialPreset.set(presetShown);

    // A preset changes index, dispersion and absorption (the stone color) together.
    bumpParams();
    pickers.stoneColor?.refresh();
    syncSpectralSamples();
    requestRender();
  });
}

/** The Neutralise material button: zero the absorption and the dispersion. */
export function neutraliseMaterial() {
  const app = engine.app;

  recordedMaterialEdit('Neutralise material', MATERIAL_FIELDS, () => {
    app.neutralise_material();

    bumpParams();

    // Neutralised, the stone is colorless, so the swatch turns white.
    pickers.stoneColor?.refresh();

    syncSpectralSamples();
    requestRender();
  });
}

/** Steps the history one entry back (undo) or forward, applying what it returns. */
export function stepHistory(undo) {
  // A mode with its own stack steps that instead (see `localHistory`).
  if (localHistory) {
    if (undo) {
      localHistory.undo();
    } else {
      localHistory.redo();
    }

    return;
  }

  // Anything still open is recorded first, so it is what gets undone.
  pickers.stoneColor?.close();

  const ops = undo ? editHistory.undo() : editHistory.redo();

  if (ops) {
    applyOps(ops);
  }
}

/** Applies undone or redone ops: the material's here, the tiers' by the tier controller. */
function applyOps(ops) {
  const tierOps = ops.filter(op => op.target !== 'material');

  for (const op of ops) {
    if (op.target === 'material') {
      applyMaterialFields(op.after);
    }
  }

  if (tierOps.length > 0) {
    tiers.applyEdit(tierOps);
  }
}

/** Starts an undo stack frame (edit mode's): Undo cannot reach past it. */
export function beginHistoryFrame() {
  editHistory?.beginFrame();
}

/** Ends the frame keeping its edits, as one entry on the stack below. */
export function commitHistoryFrame(label) {
  editHistory?.commitFrame(label);
}

/**
 * Ends the frame and puts everything back to how it was when it began, in one go (one stone
 * rebuild rather than one per edit), leaving nothing to redo.
 */
export function cancelHistoryFrame() {
  const ops = editHistory?.cancelFrame();

  if (ops) {
    applyOps(ops);
  }
}

/** Edit > Undo, when there is something to undo. */
export function undo() {
  if ((localHistory ?? editHistory)?.canUndo()) {
    stepHistory(true);
  }
}

/** Edit > Redo, when there is something to redo. */
export function redo() {
  if ((localHistory ?? editHistory)?.canRedo()) {
    stepHistory(false);
  }
}

// ---- renderer and lighting

/**
 * Shows or hides the page controls the selected renderer ignores (T-0126), without a reload.
 *
 * The set of ids comes from Rust (`GemApp::hidden_controls`), not from a list kept here: it is
 * derived from which uniforms the assembled shader actually reads under each renderer
 * (`hidden_controls_for` / `lux_ignored_uniforms` in src/lib.rs), so a control this file forgets
 * to hide, or hides wrongly, is a Rust-side bug with a test, not a page-side one. Every id
 * `hidden_controls` can ever return must exist on the page, or a control the shader stops
 * reading silently stays visible and does nothing -- the same failure shape
 * kb/page-and-controls.md's stale-parameter-name trap describes.
 *
 * Currently this hides only the facet wireframe checkbox, under LuxCore, which does not draw
 * the wireframe. T-0123 and T-0127 closed the two gaps (absorption and the Gem Cut Studio
 * lighting models) that used to make the Lighting fieldset inert under LuxCore.
 *
 * Elements are looked up by id and their `style.display` set directly: the ids are Rust's
 * contract with the page, whichever component happens to own the element.
 */
export function syncHiddenControls() {
  const app = engine.app;

  // Every control id any renderer could ever hide, read from Rust rather than re-typed here.
  const allHideable = app.hideable_controls().split('\n').filter(id => id.length > 0);
  const hiddenIds = app.hidden_controls(app.renderer())
    .split('\n')
    .filter(id => id.length > 0);

  for (const id of hiddenIds) {
    const element = document.getElementById(id);

    if (!element) {
      throw new Error(`hidden_controls named "${id}", which is not on the page`);
    }

    element.style.display = 'none';
  }

  // Everything else this function is responsible for goes back to visible: a control
  // hidden on a previous call must reappear once the renderer that ignored it is no
  // longer selected, and nothing else here decides visibility.
  for (const id of allHideable) {
    if (!hiddenIds.includes(id)) {
      const element = document.getElementById(id);

      if (element) {
        element.style.display = '';
      }
    }
  }
}

/** The renderer dropdown changed to `value`. */
export function selectRenderer(value) {
  engine.app.set_renderer(value);
  writeSetting(RENDERER_SETTING, String(value));
  renderer.set(engine.app.renderer());
  syncHiddenControls();
  syncLuxProgress();
  requestRender();
}

/** The lighting dropdown changed to `select.value`. */
export function selectLightingModel(select) {
  const app = engine.app;
  const value = parseInt(select.value, 10);

  try {
    app.set_lighting_model(value);
  } catch (cause) {
    showError(String(cause));
    // Show the model actually in use, not the one that failed to load.
    select.value = String(app.lighting_model());
    return;
  }

  writeSetting(LIGHTING_MODEL_SETTING, String(value));
  lightingModel.set(app.lighting_model());
  requestRender();
}

/**
 * Light the stone with the skybox once it is decoded. Asynchronous, so the first frame shows
 * the studio rig rather than waiting on the decode; if the image cannot be used, the error is
 * shown and the studio rig simply stays. The studio rig is not offered in the dropdown, so until
 * then (or in that failure) the dropdown shows no selection.
 */
async function decodeSkybox(app) {
  try {
    const { rgba, width, height } = await decodeImage(environmentImageBlob());

    app.set_environment_image(rgba, width, height);
  } catch (cause) {
    showError(`Could not use the environment image:\n${cause}`);
    return;
  }

  // set_environment_image (src/lib.rs) always switches to Image, even overriding a model
  // chosen while the decode was still pending (T-0035, a known, separate bug -- not fixed
  // here). The one case this DOES need to correct: a restored non-Image choice from a
  // previous session, which would otherwise silently flip to Image the instant this decode
  // finishes, undoing the very setting T-0156 just restored.
  if (savedLightingModel !== null && savedLightingModel !== IMAGE_LIGHTING_MODEL) {
    try {
      app.set_lighting_model(savedLightingModel);
    } catch (cause) {
      // The decode's own Image selection is still a perfectly valid state; leave it.
    }
  }

  lightingModel.set(app.lighting_model());
  requestRender();
}

// ---- opening a file (and, T-0198, restoring a saved design from the URL hash)

/**
 * Everything a successful load does AFTER the mesh is already in `app` (`app.load_obj`
 * having returned, or -- at startup -- `new GemApp` having just been constructed on it): the
 * stats, the sub bar's gear reading and ruler, the cut header, the tier tables, closing
 * whatever picker was open, clearing the edit history, and asking for a frame. Three callers
 * need exactly this tail -- `loadModelFile` below, `boot()` (web/src/lib/boot.js), and
 * `share_state.js`'s hash restore (T-0198) -- and `objTextFromBytes`'s and the old
 * `loadModelFile`'s own comments already state the rule this follows: one load path, so the
 * three cannot drift apart the way `loadModelFile` and `boot()` had already started to
 * before this was pulled out.
 *
 * `gear` is the design's own tooth count exactly as GemCad's sign convention writes it
 * (negative meaning the index wheel runs the other way, not a different tooth count -- see
 * `setGearTeeth`'s own doc comment), or `null` for a mesh with no faceting design at all (a
 * plain `.obj`). Unlike the two near-copies this replaces, `setGearTeeth` is always called
 * here, even for `gear === null` (falling back to `DEFAULT_GEAR_TEETH`) -- `loadModelFile`
 * needed that (opening a plain `.obj` after a real design must not leave the sub bar showing
 * the PREVIOUS stone's tooth count); `boot()` never needed it only because the sub bar's
 * store already starts at `DEFAULT_GEAR_TEETH`, so the extra call there is a harmless no-op,
 * not a behaviour change.
 *
 * `title`, `author` and `date` go straight to `applyDesignMetadata` as given -- each caller
 * resolves its OWN fallback rule first (`boot()`'s `startupModel.title || undefined`,
 * `loadModelFile`'s `cutNameFromLoad`, `share_state.js`'s saved `meta.title`), because those
 * rules differ per source format and are not part of what "installing an already-loaded
 * design" means.
 */
export function installLoadedDesign(app, { text, design, gear, title, author, date, warnings = [] }) {
  hideError();
  showStoneStats(app, text);

  setGearTeeth(gear !== null ? Math.abs(gear) : DEFAULT_GEAR_TEETH);
  // The sub bar's ruler starts over on the new stone, at its own symmetry (T-0192).
  resetRuler(design, gear !== null ? Math.abs(gear) : DEFAULT_GEAR_TEETH);

  applyDesignMetadata({ title, author, date });

  // The geometric facet<->tier map (T-0160) and the crown/pavilion tier tables (T-0147):
  // `design` is null for a plain .obj, which shows the same honest empty state the built-in
  // stone starts with and makes buildFacetTierMap return null too, so a canvas click on it
  // falls back to highlighting a single facet (highlightFacetAndItsTier). Rust's own
  // load_obj already cleared the stone highlight, and rebuilding every row from scratch
  // below drops whatever was selected in the pane -- see clearFacetAndTierHighlight's own
  // doc comment -- so nothing extra needs clearing here.
  setFacetTierMap(buildFacetTierMap(app, design));
  // The frosted facets (T-0183) are mesh facet ids too, so they follow the map: a design's
  // frosted tiers (a .gcs's frosting, or a restored hash's flags) are frosted from its first
  // frame, and a plain .obj, whose map is null, clears whatever the previous stone had.
  syncFrostedFacets(app);
  tiers.render(design, tier => highlightDesignTier(app, tier));

  // The recorded tier edits name the previous design's tier objects, so they cannot apply to
  // this one; the history starts again with the new stone, material edits included, as a
  // document's undo history does when another document is opened. `pickers.stoneColor` and
  // `editHistory` do not exist yet the first time this runs (from boot(), before
  // startSession() has created either) -- both are optional-chained for exactly that case,
  // which is a no-op, not a skipped step: there is nothing open and nothing recorded yet at
  // startup either way.
  pickers.stoneColor?.close();
  editHistory?.clear();

  // What was lost on the way in, shown now rather than only logged (2026-09-19, the user: "if
  // the file can't be read or the checksum doesn't pass, can you show a warning with the failed
  // to parse error"). `objTextFromBytes` collects these instead of raising them itself, because
  // the `hideError()` at the top of this function would wipe a message put on screen before it.
  // All of them go up as ONE alert: a file can fail both its design gate and its mesh builder,
  // and the alert shows the last thing given to it, so two calls would hide the first.
  //
  // The stone is up and usable by now -- what failed is a DESCRIPTION of it (its cutting
  // instructions, or which corners the mesh came from), never the stone itself, which is either
  // loaded or the caller returned long before here. That is why the title says the instructions
  // could not be read rather than that the file could not be opened: it did open.
  if (warnings.length > 0) {
    showLoadAlert('Could not read this design’s cutting instructions', warnings.join('\n\n'));
  }

  requestRender();
}

// Counts load requests, so a slow read that finishes after a newer one is dropped.
let latestObjLoad = 0;

/**
 * Replaces the stone with a user-chosen file. The one load path for both the file picker
 * and drag and drop, so the two cannot drift. On failure the error names the file and the
 * previous stone stays, because `GemApp::load_obj` only swaps on success.
 */
export async function loadModelFile(file) {
  const app = engine.app;
  const thisLoad = ++latestObjLoad;

  // Declared here, not with `const` inside the try block below, because cutNameFromLoad
  // needs it again after the try/catch/finally is over -- a `try { const x = ...}` scopes
  // `x` to that block alone, same as any other `{ }`, so reading it afterwards throws
  // `ReferenceError: converted is not defined` (hit and fixed while verifying T-0145: the
  // cut name silently stopped updating on every load, with the failure surfacing only as
  // an unhandled promise rejection, not the error box).
  let converted = null;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());

    // Reading is asynchronous: a large file opened first can finish after a small one
    // opened second, and must not replace it.
    if (thisLoad !== latestObjLoad) {
      return;
    }

    converted = objTextFromBytes(file.name, bytes);
    app.load_obj(converted.text);
  } catch (cause) {
    if (thisLoad === latestObjLoad) {
      // The loudest of the three cases and the one the user is most obviously waiting on: they
      // picked a file and there is no stone of it at all. A dialog rather than the panel's error
      // box, for the reason the user gave for the others (2026-09-19, "a big warning box in
      // red... overlay over the whole page"): a small box at the bottom of a side panel is easy
      // to miss, and this is not a condition to notice eventually, it is an answer to something
      // just asked. The previous stone stays on screen behind it, because `load_obj` only swaps
      // on success.
      showLoadAlert(`Could not load ${file.name}`, String(cause));
    }

    return;
  } finally {
    // Cleared whichever way the file arrived, so picking the same file again (say, after
    // re-exporting it) still fires `change`. The File object stays readable regardless.
    document.getElementById('obj-file').value = '';
  }

  // The cutting-instructions pane's header is where the loaded design's identity lands
  // (T-0145): the file's own title if it has one, else its filename. `converted.author`
  // and `converted.date` are `undefined` for a plain .obj or a GemCad .asc/.gem -- neither
  // format supplies either -- so applyDesignMetadata clears the author field rather than
  // leaving a previous design's name showing (2026-09-18); the date field is left as is,
  // since only the author field was asked to behave this way. A .gcs (T-0148) is the first
  // format that supplies both, straight from its own <info> element.
  installLoadedDesign(app, {
    text: converted.text,
    design: converted.design,
    gear: converted.gear,
    title: cutNameFromLoad(file, converted),
    author: converted.author,
    date: converted.date,
    warnings: converted.warnings,
  });
}
