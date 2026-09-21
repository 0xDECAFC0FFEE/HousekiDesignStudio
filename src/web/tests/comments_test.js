/*
 * comments_test.js -- tests for web/src/lib/comments.js, the design's header and footer comments
 * (2026-09-19, the user: "can you add a comments button to the instructions menu that opens up a
 * dialog for header and footer comments? make sure to update these headers and footers when
 * opening files. once the comments are saved, make them undoable").
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * Two things are checked here. First the line handling, which is all of the behaviour a person
 * can see in the dialog: text in, comment list out, and back. Then the shape of the undo op
 * tier_controller records for a save, replayed through the REAL EditHistory (the same classic
 * script the page runs, eval'd the way edit_history_frames_test.js does) so that "once the
 * comments are saved, make them undoable" is tested against the actual stack rather than against
 * a description of it.
 */

import {
  commentsOf, linesToText, textToLines, sameComments, infoOf, sameInfo, numberOrNull,
} from "../src/lib/comments.js";

(0, eval)(await Deno.readTextFile(new URL("../../js/edit_history.js", import.meta.url)));

const { EditHistory } = globalThis;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

Deno.test("a design's comments are read as two lists, and a design without them as two empty ones", () => {
  // Setup: three designs -- one with both blocks, one from a format that carries neither (a .gcs
  // reader sets both to [], and a plain .obj has no design object at all), and `null` itself.
  // Test: commentsOf on each.
  // Verifies: the dialog never has to special-case a design with no comments, and never has to
  // check for null -- it always gets two arrays. This is what lets CommentsDialog prefill from
  // `commentsOf(getDesign())` with no guard of its own.
  const withBoth = { headers: ["Standard Round Brilliant", "by A. Cutter"], footnotes: ["Cut P1 first."] };

  assertEqual(commentsOf(withBoth), withBoth, "a design's own comments");
  assertEqual(commentsOf({ headers: [], footnotes: [] }), { headers: [], footnotes: [] }, "a design whose file carried neither");
  assertEqual(commentsOf(null), { headers: [], footnotes: [] }, "no design at all (a plain .obj)");
});

Deno.test("the lists read off a design are copies, so editing them cannot reach the design", () => {
  // Setup: a design, and the comments read off it.
  // Test: push onto both of the returned arrays.
  // Verifies: commentsOf copies. This matters because the returned object is what the dialog
  // holds while someone types and what `setComments` diffs the new text AGAINST -- if it aliased
  // the design's own arrays, the "before" snapshot would mutate along with the design and an
  // edit would compare equal to itself, recording nothing and leaving nothing to undo.
  const design = { headers: ["one"], footnotes: ["two"] };
  const read = commentsOf(design);

  read.headers.push("added");
  read.footnotes.push("added");

  assertEqual(design.headers, ["one"], "the design's headers are untouched");
  assertEqual(design.footnotes, ["two"], "the design's footnotes are untouched");
});

Deno.test("comments round trip through the textarea's text, one per line", () => {
  // Setup: a comment list with the punctuation and spacing real GemCad headers carry.
  // Test: to text and back.
  // Verifies: the identity that makes the dialog safe to open and close without saving --
  // nothing about a comment is lost or reinterpreted by being shown in a textarea.
  const lines = ["Standard Round Brilliant", "57 facets, 96 index", "Angles for R.I. = 1.54"];

  assertEqual(textToLines(linesToText(lines)), lines, "round trip");
  assertEqual(linesToText(lines), "Standard Round Brilliant\n57 facets, 96 index\nAngles for R.I. = 1.54", "the text shown");
});

Deno.test("a trailing blank line is dropped, a blank line between comments is kept", () => {
  // Setup: the shapes a blank line comes in -- between two comments, at the end, as a line of
  // spaces -- plus the empty box.
  // Test: textToLines on each.
  // Verifies the rule comments.js measured its way to: a trailing blank can only be someone's
  // stray Enter (no reader ever produces one -- gemcad.js keeps an `H` record only when it has a
  // word on it), so dropping it is what makes open-and-Save an exact no-op; an interior gap was
  // put there on purpose and survives.
  assertEqual(textToLines("one\n\ntwo"), ["one", "", "two"], "a gap in the middle");
  assertEqual(textToLines("one\n"), ["one"], "one trailing newline");
  assertEqual(textToLines("one\n\n\n"), ["one"], "several trailing newlines");
  assertEqual(textToLines("one\n   "), ["one"], "a trailing line of only spaces");
  assertEqual(textToLines(""), [], "an empty box is no comments at all");
});

Deno.test("a real file's comments survive being opened and saved unchanged", () => {
  // Setup: SRB.asc's header block AS THE READER ACTUALLY DELIVERS IT -- two lines. Its file has a
  // third `H` line holding a single space, which gemcad.js drops before a design ever sees it
  // (checked against the built page, not assumed: this test's first draft expected three lines
  // and check_comments.py failed on the real parse).
  // Test: the round trip the dialog performs when someone opens it and presses Save.
  // Verifies the no-op property end to end, on real data rather than invented data -- and pins
  // the reader's behaviour, so a future change that starts keeping blank `H` lines fails here
  // with an explanation instead of quietly changing what a save does.
  const srb = ["Standard Round Brilliant", "GemCad for Windows User's Guide"];

  assertEqual(textToLines(linesToText(srb)), srb, "SRB.asc's header block is unchanged by a save");
  assert(sameComments({ headers: srb, footnotes: [] },
    { headers: textToLines(linesToText(srb)), footnotes: textToLines(linesToText([])) }),
    "so an unchanged Save records nothing");
});

Deno.test("pasted Windows line endings do not ride along inside a comment", () => {
  // Setup: text as it arrives from a paste out of a Windows editor.
  // Test: textToLines.
  // Verifies: the \r is normalised away rather than kept on the end of each comment, where it
  // would reach the design, the URL hash and any file written from it.
  assertEqual(textToLines("one\r\ntwo"), ["one", "two"], "CRLF");
  assertEqual(textToLines("one\rtwo"), ["one", "two"], "a bare CR");
  // A trailing CRLF is a trailing blank line like any other, and goes the same way; what must
  // not survive either way is the \r itself, riding along on the end of "two".
  assertEqual(textToLines("one\r\ntwo\r\n"), ["one", "two"], "a trailing CRLF");
});

Deno.test("sameComments tells an unchanged save from a real edit", () => {
  // Setup: a block of comments, an identical copy, and four single changes to it.
  // Test: sameComments against each.
  // Verifies the gate that keeps an opened-and-closed dialog off the undo stack: only a genuine
  // change records an entry, exactly as an unchanged tier description does not.
  const before = { headers: ["a", "b"], footnotes: ["c"] };

  assert(sameComments(before, { headers: ["a", "b"], footnotes: ["c"] }), "an identical copy");
  assert(!sameComments(before, { headers: ["a", "B"], footnotes: ["c"] }), "a header's text changed");
  assert(!sameComments(before, { headers: ["a"], footnotes: ["c"] }), "a header removed");
  assert(!sameComments(before, { headers: ["a", "b", ""], footnotes: ["c"] }), "a blank header added");
  assert(!sameComments(before, { headers: ["a", "b"], footnotes: [] }), "the footnote removed");
});

Deno.test("a saved comment block is undoable and redoable through the real edit history", () => {
  // Setup: a design carrying a file's own comments, a real EditHistory, and the same two-step
  // `writeComments(op.after)` replay tier_controller's applyEdit performs for this op target.
  // Test: record the save the dialog would record, then undo it, then redo it.
  // Verifies "once the comments are saved, make them undoable" end to end on the op SHAPE: one
  // update carrying the whole before and after block, which EditHistory.invertOp reverses by
  // swapping the two -- so undo and redo both reduce to writing `op.after`, and neither needs a
  // per-line diff. Also verifies a second save undoes to the FIRST save's text, not all the way
  // to the file's own comments.
  const design = { headers: ["Standard Round Brilliant"], footnotes: [] };
  const history = EditHistory.create();

  // What applyEdit does for `target: 'comments'`, and the only thing it does.
  const replay = ops => {
    for (const op of ops) {
      if (op.target === "comments") {
        design.headers = op.after.headers.slice();
        design.footnotes = op.after.footnotes.slice();
      }
    }
  };

  // What setComments records for a save, twice over.
  const save = comments => {
    const before = commentsOf(design);

    if (sameComments(before, comments)) {
      return;
    }

    replay([{ target: "comments", after: comments }]);
    history.record({
      label: "Edit comments",
      ops: [{ kind: "update", target: "comments", before, after: comments }],
    });
  };

  save({ headers: ["Standard Round Brilliant", "Cut by hand"], footnotes: ["Meet at G1."] });
  assertEqual(design.headers, ["Standard Round Brilliant", "Cut by hand"], "the first save wrote the headers");
  assertEqual(design.footnotes, ["Meet at G1."], "the first save wrote the footnotes");

  save({ headers: ["Standard Round Brilliant", "Cut by hand"], footnotes: ["Meet at G1.", "Polish at 1200."] });

  // A save that changed nothing must not push an entry of its own, or the first undo would
  // appear to do nothing at all.
  save({ headers: ["Standard Round Brilliant", "Cut by hand"], footnotes: ["Meet at G1.", "Polish at 1200."] });

  replay(history.undo());
  assertEqual(design.footnotes, ["Meet at G1."], "undo went back to the first save, not to the file's own comments");
  assertEqual(design.headers, ["Standard Round Brilliant", "Cut by hand"], "undo left the headers of that save alone");

  replay(history.undo());
  assertEqual(design.headers, ["Standard Round Brilliant"], "a second undo reached the file's own comments");
  assertEqual(design.footnotes, [], "and its empty footnotes");
  assert(!history.canUndo(), "there is nothing left to undo");

  replay(history.redo());
  assertEqual(design.headers, ["Standard Round Brilliant", "Cut by hand"], "redo put the first save back");
  assertEqual(design.footnotes, ["Meet at G1."], "redo put its footnotes back");
});

Deno.test("infoOf reads the <info> fields a .gcs carries, and reads empty for a design without them", () => {
  // Setup: three designs -- one from a .gcs with every <info> field filled, one whose file gave
  // only some of them, and one from a .asc/.gem (no <info> element in that format at all, so
  // `design.info` is absent entirely).
  //
  // Test: infoOf on each.
  //
  // Verifies: the five fields the Comments dialog edits come back as themselves; an unstated
  // NUMBER reads as null (not 0, not NaN -- the writer leaves an unstated bound out of the file,
  // and 0 would be a real claim about the design); an unstated SHAPE reads as ''; and a design
  // with no info at all reads as all-empty rather than throwing, since the dialog calls this on
  // whatever `getDesign()` returns. The title/author/date on `design.info` are deliberately NOT
  // returned: the cut header owns those, and the dialog must not offer a second place to edit them.
  const full = { info: { title: "T", author: "A", date: "D", shape: "Round", sizeMin: 6, sizeMax: 20, riMin: 1.54, riMax: 2.15 } };

  assertEqual(infoOf(full), { shape: "Round", sizeMin: 6, sizeMax: 20, riMin: 1.54, riMax: 2.15 },
    "every field stated");
  assertEqual(infoOf({ info: { shape: "Cushion", sizeMin: null, sizeMax: null, riMin: null, riMax: null } }),
    { shape: "Cushion", sizeMin: null, sizeMax: null, riMin: null, riMax: null }, "only a shape");
  assertEqual(infoOf({ headers: [], footnotes: [] }),
    { shape: "", sizeMin: null, sizeMax: null, riMin: null, riMax: null }, "a design from a .asc/.gem");
  assertEqual(infoOf(null),
    { shape: "", sizeMin: null, sizeMax: null, riMin: null, riMax: null }, "no design at all");
});

Deno.test("numberOrNull and sameInfo: a blank box is 'not stated', not zero", () => {
  // Setup/Test: the dialog holds its number boxes as TEXT while open, so this is the conversion
  // that runs on Save, plus the comparison that decides whether Save records an undo step.
  //
  // Verifies: a blank or whitespace box, and a box holding something that is not a number, both
  // become null -- "the design does not say" -- rather than 0, which would be a claim the person
  // did not make. A real number, including a decimal and a negative, survives. And sameInfo
  // separates an unchanged save (records nothing) from every single-field edit.
  assertEqual(numberOrNull(""), null, "empty");
  assertEqual(numberOrNull("   "), null, "whitespace only");
  assertEqual(numberOrNull("round"), null, "not a number");
  assertEqual(numberOrNull(null), null, "nothing at all");
  assertEqual(numberOrNull("1.54"), 1.54, "a decimal");
  assertEqual(numberOrNull(" 20 "), 20, "padded");

  const before = { shape: "Round", sizeMin: 6, sizeMax: 20, riMin: 1.54, riMax: 2.15 };

  assert(sameInfo(before, { ...before }), "an identical copy");
  assert(!sameInfo(before, { ...before, shape: "Cushion" }), "the shape changed");
  assert(!sameInfo(before, { ...before, sizeMin: 5 }), "a size changed");
  assert(!sameInfo(before, { ...before, riMax: null }), "a bound cleared");
});
