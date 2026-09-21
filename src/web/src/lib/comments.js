// The design's header and footer comments (the user, 2026-09-19: "can you add a comments button
// to the instructions menu that opens up a dialog for header and footer comments? make sure to
// update these headers and footers when opening files. once the comments are saved, make them
// undoable").
//
// A faceting design has always carried these: a GemCad `.asc`/`.gem` writes its header lines as
// `H` records and its footnotes after them (`www/js/gemcad.js`'s `metadata.headers` /
// `metadata.footnotes`), and `GemCadDesign.fromGemCad` has copied both onto `design.headers` and
// `design.footnotes` since the polar representation was written. Until now nothing on the page
// read either field -- kb/page-and-controls.md says so in as many words, "`design.js`'s `headers`
// field mirrors it but stays unwired" -- so a file's own comments were parsed, kept, serialised
// and never shown. This module is the reading and writing of them; CommentsDialog.svelte is the
// dialog, and tier_controller.js's `setComments` records the edit.
//
// WHY THE DESIGN IS THE ONLY COPY. The comments live on the loaded design object and nowhere
// else: no store mirrors them, and the dialog reads them fresh from `getDesign()` every time it
// opens (exactly as GearDialog reads `design.gear`). That is what makes the user's "make sure to
// update these headers and footers when opening files" true by construction rather than by a
// subscription that could be forgotten -- opening a file replaces the design object, so the next
// open of the dialog can only show the new file's comments. It is also what carries them into a
// shared link for free: `GemCadDesign.toJSON` already writes both arrays (T-0198's URL hash),
// so a comment saved here survives a copied URL with no extra plumbing.
//
// This module is PURE -- text and arrays, plus one Svelte store for the dialog's open state -- so
// `web/tests/comments_test.js` can exercise the line handling under `deno test` with no browser.

import { writable } from 'svelte/store';

/** True while the comments dialog is open. Set by the toolbar button, bound by the dialog. */
export const commentsOpen = writable(false);

/** Opens the dialog. The toolbar button's whole action: the dialog itself reads the design. */
export function openComments() {
  commentsOpen.set(true);
}

/**
 * A design's comments as `{ headers, footnotes }`, always two arrays, never null -- a design
 * built from a format that carries no comments (a plain `.obj`, which has no design in the first
 * place, or a file that simply has none) reads as two empty lists rather than as something the
 * dialog would have to special-case.
 *
 * Both GemCad formats carry these as their `H` and `F` lines. A `.gcs` carries them too, as
 * `<info>`'s own `headerN`/`footerN` attributes (T-0214; the reader used to set both to `[]`),
 * and there a single comment MAY CONTAIN LINE BREAKS -- three corpus files have one, e.g.
 * `Ytripex.gcs`'s `footer1`. This dialog is a line-per-comment textarea, so opening and saving
 * one of those splits it into one comment per line. The design prints identically either way;
 * only the count changes.
 */
export function commentsOf(design) {
  if (!design) {
    return { headers: [], footnotes: [] };
  }

  return {
    headers: (design.headers || []).slice(),
    footnotes: (design.footnotes || []).slice(),
  };
}

/** A comment list as the text of a textarea: one comment per line, in order. */
export function linesToText(lines) {
  return lines.join('\n');
}

/**
 * A textarea's text back to a comment list: one comment per line, with TRAILING blank lines
 * dropped and interior ones kept.
 *
 * The asymmetry is about where a blank line can have come from, which was measured rather than
 * assumed. **No design can arrive here already holding a trailing blank comment.** A `.gcs`
 * carries no comments at all (gcs.js sets both lists to `[]`); GemCad's own `.asc`/`.gem` reader
 * keeps an `H` or `F` record only when it has a word on it (`parts.length > 1` in gemcad.js), so
 * a line of nothing but whitespace -- `SRB.asc`'s third `H` line is a single space -- never
 * reaches `metadata.headers` in the first place; and a URL hash only ever holds what this
 * function wrote. So a blank line at the END of the box can only be someone's own stray Enter
 * after their last comment, and dropping it is what keeps **opening the dialog and pressing Save
 * an exact no-op for every design**, instead of growing the design by one empty comment each
 * time.
 *
 * A blank line BETWEEN two comments is a different thing: a deliberate gap in how the
 * instructions print, which someone can only have put there on purpose. It survives.
 *
 * (An earlier draft of this kept trailing blanks, on the belief that real files end with one and
 * that trimming would delete a file's own padding. That belief was wrong -- the reader had
 * already dropped it -- and the check script caught the mistake in the test's expectation rather
 * than in the code. The measurement above is why this rule is the safe one, not merely the tidy
 * one.)
 *
 * `\r\n` is normalised to `\n` first: the dialog's text can arrive from a paste out of a Windows
 * editor, and a stray `\r` would otherwise ride along inside a comment and reach the file.
 */
export function textToLines(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  return lines;
}

/** Whether two `{ headers, footnotes }` hold the same comments, so an unchanged Save records nothing. */
export function sameComments(a, b) {
  return sameLines(a.headers, b.headers) && sameLines(a.footnotes, b.footnotes);
}

/**
 * The `<info>` fields a `.gcs` carries beyond the title, author and date (T-0214): the design's
 * intended `shape`, the stone-size range it is drawn for, and the refractive-index range it is
 * meant to be cut in. The first three live in the cut header (`cutMeta`, shown above the cutting
 * instructions) and are edited there, so they are deliberately not repeated in this dialog.
 *
 * Always the same five keys, with `''` and `null` for "the file did not say" -- a `.asc`/`.gem`
 * has no `<info>` at all, so every design not read from a `.gcs` reads as empty here. Numbers
 * are kept as numbers or `null`, never as `NaN`: `null` means unstated, and the writer leaves an
 * unstated bound out of the file rather than writing a made-up default.
 */
export function infoOf(design) {
  const info = (design && design.info) || {};
  const number = value => (Number.isFinite(value) ? value : null);

  return {
    shape: info.shape || '',
    sizeMin: number(info.sizeMin),
    sizeMax: number(info.sizeMax),
    riMin: number(info.riMin),
    riMax: number(info.riMax),
  };
}

/** A text field's value as a number for `infoOf`'s shape: `null` when blank or not a number. */
export function numberOrNull(text) {
  const trimmed = String(text ?? '').trim();

  if (trimmed === '') {
    return null;
  }

  const value = Number(trimmed);

  return Number.isFinite(value) ? value : null;
}

/** Whether two `infoOf` blocks agree, so an unchanged Save records nothing. */
export function sameInfo(a, b) {
  return a.shape === b.shape && a.sizeMin === b.sizeMin && a.sizeMax === b.sizeMax
    && a.riMin === b.riMin && a.riMax === b.riMax;
}

function sameLines(a, b) {
  return a.length === b.length && a.every((line, at) => line === b[at]);
}
