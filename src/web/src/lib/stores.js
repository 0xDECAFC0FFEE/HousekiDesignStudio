// State shared between the Svelte components and the plain-JS modules that drive the stone.
//
// The rule of the port: what a component DRAWS lives in a store here; the render loop, the
// wasm calls and every other piece of imperative code stay in plain modules that write to these
// stores (never the other way round), so nothing about the WebGL side depends on Svelte.

import { writable, get } from 'svelte/store';

/**
 * The GemApp once wasm has loaded, `null` before (and for good if it failed to). One object
 * rather than a store: components read it in event handlers and effects that already run
 * after `ready`, and it never changes once set.
 */
export const engine = { app: null };

/** True once GemApp exists and the settings panel may read from it. */
export const ready = writable(false);

/**
 * The error box's state (`#error`, the bottom of the settings panel). `visible` is separate from
 * `text` because a successful load hides the box WITHOUT clearing its text (the page always did;
 * the harness checks both), and `clearErrorIf` compares the text of a box that is still on screen.
 * `visible` is `null` until the box has been shown or hidden once, when the box carries no inline
 * style at all (its stylesheet keeps it hidden), exactly as the page's own `#error` always
 * started.
 *
 * WHAT BELONGS HERE, since 2026-09-19 there are two places a failure can appear (see `loadAlert`
 * below): this box is for a PERSISTENT OR MINOR condition -- the tiers left on the stone no longer
 * close a solid, the environment image could not be decoded, an eyedropper pick failed, a
 * parameter Rust refused. They come and go with the state that caused them (`clearErrorIf` takes
 * the rebuild message down again by matching its text), and a modal for any of them would be in
 * the way rather than useful.
 */
export const error = writable({ text: '', visible: null });

/** Shows `message` in the error box and the console. */
export function showError(message) {
  error.set({ text: message, visible: true });
  console.error(message);
}

/**
 * The load alert: `{ title, detail }` while one is up, `null` otherwise.
 *
 * A one-off failure of something the user just asked for -- a file that could not be read, a file
 * whose cutting instructions could not be derived, a shared link whose checksum did not pass --
 * shown as a big red dialog over the whole page (`LoadAlertDialog.svelte`), at the user's request
 * (2026-09-19): "instead of a small yellow warning box can you make it a big warning box in red",
 * "overlay over the whole page just like the settings menu and the gear menu".
 *
 * THE LINE BETWEEN THIS AND THE ERROR BOX is what kind of thing failed, not how badly. This is for
 * a discrete event with a moment to acknowledge it: you opened a file, or followed a link, and it
 * did not work. The error box is for a condition that is simply true of the page for a while. An
 * earlier attempt drew both in the same box, told apart only by colour (`--warn`, yellow) -- the
 * user's reply is what replaced it, and the colour distinction went with it: both are red now,
 * because both mean the same thing to the person reading them.
 *
 * `detail` carries the underlying parse error verbatim ("can you show a warning with the failed to
 * parse error"), and `title` says which thing failed. Deliberately not a queue: the last alert
 * wins, as the error box has always worked, so any caller that can raise more than one message
 * about the same load joins them first.
 */
export const loadAlert = writable(null);

/**
 * Shows the load alert, and logs it (`console.warn`, this project's channel for diagnostics -- the
 * console line is the durable record, and stays whether or not the dialog was dismissed).
 */
export function showLoadAlert(title, detail) {
  loadAlert.set({ title, detail });
  console.warn(`${title}: ${detail}`);
}

/** Closes the load alert (its Close button, Escape, or a later load that succeeded). */
export function dismissLoadAlert() {
  loadAlert.set(null);
}

/** Hides the error box, leaving its text as it was. */
export function hideError() {
  error.update(state => ({ ...state, visible: false }));
}

/** Hides and clears the error box, but only if it is currently showing exactly `message`. */
export function clearErrorIf(message) {
  if (get(error).text === message) {
    error.set({ text: '', visible: false });
  }
}

/**
 * A counter bumped whenever a parameter the panel shows may have changed under it (a material
 * preset, an undo, a drag of the stone that moved spin and tilt). Sliders re-read from Rust
 * when it changes; it replaces the page's old `syncSlider(name)` calls.
 */
export const paramRevision = writable(0);

/** Asks every parameter slider to re-read its value from Rust. */
export function bumpParams() {
  paramRevision.update(n => n + 1);
}

/** The material preset the dropdown shows. */
export const materialPreset = writable('');

/** Which renderer is selected (`params::Renderer::as_u32`): 0 hand-written, 1 LuxCore, 2 flat. */
export const renderer = writable(0);

/** The lighting model the dropdown shows (`LightingModel::as_u32`). */
export const lightingModel = writable(0);

/** The LuxCore renderer's progress line (`#lux-progress`), empty when it does not apply. */
export const luxProgress = writable('');

/** Samples per pixel to accumulate before the page stops asking for frames. */
export const accumulationTarget = writable(512);

/** Resolution scale when the view is still, and while dragging (0.15 to 1). */
export const resolutionScale = writable(1);
export const draftResolutionScale = writable(0.4);

/** Whether Edit > Undo and Redo have anything to step through. */
export const canUndo = writable(false);
export const canRedo = writable(false);

/**
 * Bumped by `session.js`'s `syncEditMenu` every time the edit history changes -- a record,
 * an undo, a redo, a frame begin/commit/cancel, or a clear -- exactly the set of moments
 * `kb/undo-and-redo-the-edit-history-of-diffs.md` documents as "anything that changes what
 * undo or redo would do". `share_state.js` (T-0198, the user: "if a thing can be undone it
 * should also be saved") subscribes to this to write the URL hash, rather than session.js
 * importing share_state.js directly -- which would make a write-side module and a
 * history-owning module import each other. A plain counter, not the booleans above: a
 * subscriber needs to know SOMETHING changed, not what, since it always re-reads the whole
 * current state (the design and the material) to save, never a diff.
 */
export const historyChanged = writable(0);

/**
 * Today's date in the cut header's format: month name plus year (T-0151: "September 2026") --
 * resources/hex_cut_v2.gcs writes date="August 2024" in exactly this shape, so a .gcs date drops
 * straight into the field, unconverted. What the field falls back to whenever it has no date.
 */
export function currentDate() {
  return new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/**
 * The cut header's three fields. Lives here rather than in the header component so a design
 * load (`applyDesignMetadata`, from the loading code) and File > Rename can reach it.
 */
export const cutMeta = writable({
  // The built-in stone is a mesh, not a faceting design, so it has no name of its own -- this
  // is the product title's own pre-T-0144 default (a sensible name for
  // resources/hex_cut_v2.obj), which now has somewhere to live.
  name: 'Hex Cut V2',
  // No account to read a name from, so this starts empty (shown as the lower-case word
  // "author", T-0151) rather than guessing one.
  author: '',
  // Set at startup: the date the design was written down, not a live clock. Whenever the field
  // is left without a date (cleared by hand, or a loaded design that has none) it is set to
  // the current date again.
  date: currentDate(),
});

/**
 * Fills in whatever a loaded design knows about itself, leaving the rest alone (T-0145). A
 * GemCad `.asc`/`.gem` file supplies only a title (its first `H` header line, at the user's
 * choice (2026-09-18) over the filename); a `.gcs` file's own `<info>` element (T-0148)
 * supplies title, author and date. The author field always reflects only the design actually
 * open: a load that omits author (the caller passes it as `undefined`) clears the field,
 * rather than falling back to a remembered name from a previous session or a previously opened
 * file (reversed 2026-09-18, the user's request). A design with no date, or an empty one, gets
 * the current date rather than a blank field or the previous file's date.
 */
export function applyDesignMetadata({ title, author, date } = {}) {
  cutMeta.update(meta => ({
    name: title !== undefined ? title : meta.name,
    author: author !== undefined ? author : '',
    date: date || currentDate(),
  }));
}

/** Bumped by File > Rename (and observed by the cut header) to open the name editor. */
export const renameRequest = writable(0);

/**
 * The loaded stone's facet count and T/W, C/W and P/W (lib/stone_stats.js), shown in the bottom
 * right of the renderer; null until a stone has loaded. Set by `showStoneStats` wherever a mesh
 * is handed to GemApp: at startup, on opening a file, and on a rebuild after a tier edit.
 */
export const stoneStatsStore = writable(null);
