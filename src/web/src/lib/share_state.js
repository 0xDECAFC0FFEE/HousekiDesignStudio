// The browser side of T-0198 (the user, 2026-09-19): "if a thing can be undone it should also
// be saved ... record this data in the url hash so when i copy the url and send it to someone
// else, they can see the file immediately and if i go forwards/backward in the website the
// changes stay". `share_url.js` is the pure codec (version, gzip, base64url -- no
// window/document/location/GemCadDesign, so it is tested under Deno with no browser). THIS
// module owns everything that codec cannot touch: `location`, `history`, `hashchange`, and
// the `GemCadDesign`/`DesignMesh` globals that turn a plain JSON payload back into a real
// design and a mesh.

import { get } from 'svelte/store';
import { encodeHash, decodeHash } from './share_url.js';
import {
  materialState, applyMaterialFields, installLoadedDesign, historyInFrame, sessionReady,
} from './session.js';
import {
  engine, showLoadAlert, historyChanged, cutMeta,
} from './stores.js';
import { getDesign } from './tier_controller.js';

/**
 * How long to wait, after the edit history last changed, before writing the hash: T-0198's
 * "nothing is written mid-drag". A burst of changes (several keystrokes on a description, a
 * fast run of undo/redo from the keyboard) collapses into one write, the same shape
 * `work_budget.js`'s render loop uses to keep a drag from crowding out the page -- though
 * this is a plain debounce, not a budgeted task, since a hash write is cheap and rare enough
 * that there is no "the rest of the page needs its share of the clock back" concern here.
 */
const DEBOUNCE_MS = 300;

let debounceTimer = null;

/**
 * True for the duration of `installLoadedDesign`'s own call inside `restoreFromHash`, below.
 * `installLoadedDesign` clears the edit history (`editHistory?.clear()`), which fires
 * `syncEditMenu`'s `historyChanged` bump exactly like a real edit would -- but a RESTORE is
 * not an edit to save, it is the page catching up to a hash that already exists (whether a
 * pasted link or Back/Forward). Without this guard, every restore would schedule a write of
 * its own 300ms later, which is wrong in two ways: it would push a SPURIOUS new history entry
 * right after Back or Forward (defeating the very navigation the user just did), and the
 * re-encoded hash need not even be byte-identical to the one just restored, since the
 * material's numbers pass through Rust's f32 params and back (`materialState()`) on the way,
 * which can print a very slightly different decimal than what went in. Found while verifying
 * T-0198 over CDP: Forward landed on a hash that did not match what had been saved, because a
 * restore's own clear-triggered bump had already silently overwritten it.
 */
let restoring = false;

/**
 * The hash this module itself last wrote (by either path `writeHashNow` can take), so this
 * session's OWN `hashchange` event -- a plain `location.hash = ...` assignment fires one even
 * though nothing navigated anywhere else -- is never mistaken for a pasted link or a real
 * Back/Forward move. `null` until the first write. "Only a hash you did not write is a
 * restore" is the brief's own rule for this field.
 */
let lastWrittenHash = null;

/**
 * Which path the FIRST write of this session actually used: `'replaceState'` or
 * `'hash-assignment'` (the fallback), or `null` before the first write has happened. The
 * brief flagged `history.replaceState` on `file://` as an unverified risk -- Chrome is
 * documented to refuse `pushState`/`replaceState` on a null-origin document, which `file://`
 * is -- so this is published (`window.gemShareFirstWriteMethod`, set up in `initShareUrl`)
 * for a verification script to report which branch actually ran, rather than trusting the
 * code path was exercised.
 */
let firstWriteMethod = null;

export function firstWriteMethodUsed() {
  return firstWriteMethod;
}

/**
 * Writes `hash` to the address bar. The FIRST write of the session tries
 * `history.replaceState` first, in a `try`/`catch`, so establishing the initial baseline (see
 * `initShareUrl`'s own comment on why there is one) does not also add a spurious Back-button
 * entry ahead of anything the user actually did; every write after that -- and the fallback
 * here, if `replaceState` throws -- is a PLAIN `location.hash` assignment.
 *
 * Two separate reasons a plain assignment, not `pushState`/`replaceState`, is what every
 * write after the first must use, both binding constraints of this project (kb/architecture.md,
 * CLAUDE.md): (1) the page must work from `file://` with no network, and Chrome refuses
 * `pushState`/`replaceState` on a `file://` document's null origin, which `replaceState`'s
 * own `try`/`catch` below exists to survive; (2) it is what makes Back and Forward walk the
 * saved states AT ALL -- `pushState` is how another page adds a history entry without
 * navigating anywhere, but `location.hash = ...` genuinely IS a (same-document) navigation,
 * and the browser gives every one of those its own history entry on its own, for free.
 */
function writeHashNow(hash) {
  lastWrittenHash = hash;

  if (firstWriteMethod === null) {
    try {
      history.replaceState(history.state, '', hash);
      firstWriteMethod = 'replaceState';
      return;
    } catch (cause) {
      console.warn(
        `history.replaceState is not usable here (expected on file://, whose document has a ` +
        `null origin); writing the plain hash instead: ${cause}`
      );
      firstWriteMethod = 'hash-assignment';
    }
  }

  location.hash = hash;
}

/**
 * Re-encodes whatever is currently loaded (the design on the tier tables, the material, and
 * the cut header's title/author/date) and writes it. A no-op, not a failure, when there is no
 * app yet or the loaded mesh carries no faceting design at all (a plain `.obj`): T-0198's own
 * scope is "the faceting instructions, including the frosting and the material type", and
 * there is no design to describe those on a bare mesh.
 */
async function writeCurrentState() {
  const app = engine.app;
  const design = getDesign();

  if (!app || !design) {
    return;
  }

  const meta = get(cutMeta);
  let hash;

  try {
    hash = await encodeHash({
      design: GemCadDesign.toJSON(design),
      material: materialState(),
      meta: { title: meta.name, author: meta.author, date: meta.date },
    });
  } catch (cause) {
    // This module's own code failing on data it produced itself -- background bookkeeping,
    // not a user-facing failure of anything the user asked for, so the console (this
    // project's rule for diagnostics), not the error box (which is for a LOAD or RESTORE
    // failing, below).
    console.warn(`Could not update the URL hash: ${cause}`);
    return;
  }

  writeHashNow(hash);
}

/**
 * Debounces a write, and skips it entirely while an edit-mode frame is open
 * (`historyInFrame()`): a slider or the ruler dragged in edit mode records many entries while
 * it moves, and `commitFrame` fires the SAME `historyChanged` bump again once the frame
 * closes with everything folded into one entry -- so skipping every bump made mid-frame still
 * saves the committed result, just once, instead of once per pixel of drag.
 */
function scheduleWrite() {
  if (restoring || historyInFrame()) {
    return;
  }

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    writeCurrentState();
  }, DEBOUNCE_MS);
}

/**
 * Restores a saved design, material and cut-header metadata from a hash string (with or
 * without its leading `#` -- `decodeHash` accepts either). Returns `true` on success.
 *
 * On ANY failure -- a hash that will not decode, a design whose schema `fromJSON` refuses, or
 * a design whose facet planes cannot be built into a mesh (`DesignMesh.toObjText`, no
 * file-corner fallback exists for a hash the way one does for an opened file, since there is
 * no file here at all) -- this shows the reason and returns `false` WITHOUT calling
 * `installLoadedDesign`, leaving whatever stone is already on screen exactly alone. This
 * mirrors `GemApp::load_obj`'s own only-swap-on-success rule, and the brief's explicit
 * instruction for this path: "a failure there is a genuine error".
 *
 * Shown as a WARNING rather than an error (2026-09-19, the user: "if the file can't be read or the
 * checksum doesn't pass, can you show a warning with the failed to parse error"). The distinction
 * the `error` store draws is whether the page can go on, and here it always can: the startup stone
 * is up and every failure message names its own cause, checksum mismatches included -- so the
 * reader is told what happened to the link they were given, not warned that the page is broken.
 */
export async function restoreFromHash(app, hash) {
  let payload;

  try {
    payload = await decodeHash(hash);
  } catch (cause) {
    showLoadAlert('Could not open this link', String(cause.message || cause));
    return false;
  }

  let design;

  try {
    design = GemCadDesign.fromJSON(payload.design);
  } catch (cause) {
    showLoadAlert('Could not open this link\u2019s design', String(cause.message || cause));
    return false;
  }

  let text;

  try {
    // `design.name`, NOT the cut header's title (`payload.meta.title`): design_load.js
    // always builds a design and its mesh from the SAME literal name (the opened file's
    // own name, or 'hex_cut_v2.gcs' for the built-in stone), and `GemCadDesign.toJSON`
    // carries that same `name` field, unrelated to the human-facing cut header title
    // (T-0145's `cutMeta`/`applyDesignMetadata`, a separate concept: a `.gcs`'s own
    // `<info>` title, say "Hex Cut V2", versus the design's internal `name`, "hex_cut_v2.gcs").
    // Passing the title here instead would still build a perfectly correct mesh, but
    // Rust's `model_name` (read off the OBJ's own "o " line, see `diagnostics_text`'s
    // "model: " line) would then read differently for a hash-restored stone than for the
    // SAME design freshly opened or booted -- a cosmetic-only difference, but a
    // needless one, and it is exactly what a round-trip check comparing
    // `diagnostics_text()` before and after a restore would (and, first time through,
    // did) catch.
    text = DesignMesh.toObjText(design, { name: design.name || 'design' });
  } catch (cause) {
    showLoadAlert('Could not build the stone from this link\u2019s design', String(cause.message || cause));
    return false;
  }

  try {
    app.load_obj(text);
  } catch (cause) {
    showLoadAlert('Could not load the stone from this link', String(cause.message || cause));
    return false;
  }

  // Nothing above changed anything on screen -- load_obj only swaps on success, and every
  // check before it was read-only. From here on the restore cannot fail.
  //
  // `design.gear.teeth` (not a raw signed value): GemCadDesign.fromJSON keeps the tooth
  // count itself always positive, with the wheel's direction carried separately in
  // `design.gear.reversed` -- `installLoadedDesign`'s `Math.abs` on it is therefore a no-op
  // here, exactly as it would be for any other already-positive count.
  //
  // Restoring CLEARS THE UNDO STACK, exactly as opening a file does (installLoadedDesign's
  // own `editHistory?.clear()`), and for the identical reason `kb/undo-and-redo-the-edit-
  // history-of-diffs.md` already documents for that case: the recorded tier ops name the
  // PREVIOUS design's tier objects and cannot apply to this new one. Concretely: Back after
  // an edit does not leave a Redo available afterwards -- Back is a RESTORE, not an undo, and
  // there is no way to recover the discarded stack once the tier objects it names are gone.
  // This is the honest, minimal behaviour the brief asks for; nothing here tries to preserve
  // the stack across a restore.
  restoring = true;

  try {
    installLoadedDesign(app, {
      text,
      design,
      gear: design.gear.teeth,
      title: (payload.meta && payload.meta.title) || undefined,
      author: payload.meta && payload.meta.author,
      date: payload.meta && payload.meta.date,
    });

    if (payload.material) {
      applyMaterialFields(payload.material);
    }
  } finally {
    restoring = false;
  }

  return true;
}

/**
 * A `hashchange` event: either a shared link pasted over the address bar, or Back/Forward
 * moving between states this session (or an earlier one) wrote. Ignored when the new hash is
 * the one THIS session just wrote itself (see `lastWrittenHash`'s own comment), or when it is
 * empty -- there is no "empty" saved state to restore to, so the current stone simply stays.
 */
async function onHashChange(app) {
  const hash = location.hash;

  if (hash === lastWrittenHash) {
    return;
  }

  if (!hash || hash === '#') {
    return;
  }

  await restoreFromHash(app, hash);
  // Recorded whether the restore succeeded or failed, so an identical hashchange firing
  // again for the same value (nothing here should ever do that, but harmlessly if it did)
  // does not re-run the same restore, or re-show the same error, a second time.
  lastWrittenHash = hash;
}

/**
 * Wires the URL hash to the session: called once, from `main.js`, after `boot()` has the app
 * up and `startSession` has already run (so `historyInFrame`/`historyChanged` mean something,
 * and there is a design to read). Does three things, in order:
 *
 *   1. Subscribes to `historyChanged` (bumped by every one of EditHistory's onChange moments,
 *      see that store's own doc comment) to write the hash on every edit, per the ticket's
 *      "if a thing can be undone it should also be saved".
 *   2. If `location.hash` already holds a state -- a shared link the page was opened on --
 *      restores it INSTEAD OF leaving the built-in stone showing, and installs the
 *      `hashchange` listener that does the same for Back/Forward and for a link pasted over
 *      an already-open page.
 *   3. Writes the very first hash of the session for whatever ended up on screen (the
 *      restored link, or the startup stone if there was none, or if restoring failed) --
 *      this is the "very first write" `writeHashNow` tries `history.replaceState` for, so it
 *      does not add a spurious Back-button entry ahead of anything the user actually did, and
 *      it is what makes a freshly opened page's own URL already shareable before any edit.
 */
export async function initShareUrl() {
  const app = engine.app;

  if (!app || !sessionReady()) {
    // boot() failed before creating an app, or before starting the session -- nothing exists
    // yet to hook up, and nothing will ever ask to save.
    return;
  }

  // For check_save_hash.py (T-0198's own verification): which write path actually ran.
  window.gemShareFirstWriteMethod = firstWriteMethodUsed;

  // A Svelte store calls a new subscriber once, immediately, with its CURRENT value -- that
  // first call is the subscription starting, not an edit, and firing a save from it would
  // race the restore just below (and, before restoring, would write the startup stone's own
  // state under the hash a shared link is about to replace). Skip exactly that one call.
  let skippedInitialSubscriberCall = false;

  historyChanged.subscribe(() => {
    if (!skippedInitialSubscriberCall) {
      skippedInitialSubscriberCall = true;
      return;
    }

    scheduleWrite();
  });

  window.addEventListener('hashchange', () => onHashChange(app));

  const hash = location.hash;

  if (hash && hash !== '#') {
    await restoreFromHash(app, hash);
  }

  await writeCurrentState();
}
