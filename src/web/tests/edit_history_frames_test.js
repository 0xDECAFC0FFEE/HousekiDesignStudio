/*
 * edit_history_frames_test.js -- tests for EditHistory's stack frames (www/js/edit_history.js),
 * which edit mode uses so that everything done in it is one group: undo cannot reach past the
 * frame, committing folds the frame into one entry, and cancelling puts everything back.
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/
 */

(0, eval)(await Deno.readTextFile(new URL("../../js/edit_history.js", import.meta.url)));

const { EditHistory } = globalThis;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

const update = (tag, before, after) => ({ label: tag, ops: [{ kind: "update", tag, before, after }] });
const tags = ops => ops.map(op => op.tag).join();

Deno.test("undo and redo cannot reach past the start of a frame", () => {
  // Setup: one entry recorded on the main stack, then a frame begun.
  // Test: undo and redo straight after beginFrame, then record inside the frame and undo it.
  // Verifies: with nothing recorded in the frame there is nothing to undo or redo (the entry
  // below is out of reach); an entry recorded in the frame is undoable, and only it.
  const history = EditHistory.create();

  history.record(update("outside", 0, 1));
  history.beginFrame();

  assert(!history.canUndo() && history.undo() === null, "nothing to undo at the start of a frame");
  assert(!history.canRedo() && history.redo() === null, "nothing to redo at the start of a frame");

  history.record(update("inside", 1, 2));

  assert(tags(history.undo()) === "inside", "the frame's own entry undoes");
  assert(history.undo() === null, "and then it stops, short of the entry below");
});

Deno.test("committing folds the frame into one entry that undoes and redoes as a group", () => {
  // Setup: a frame with three entries, the middle one undone again inside it.
  // Test: commitFrame, then undo and redo on the stack below.
  // Verifies:
  //   - the frame's entries that are still applied become ONE entry (the undone one is gone);
  //   - its undo is every op inverted, newest first; its redo is every op in order;
  //   - the entry from before the frame is still there beneath it.
  const history = EditHistory.create();

  history.record(update("outside", 0, 1));
  history.beginFrame();
  history.record(update("a", 1, 2));
  history.record(update("b", 2, 3));
  history.undo();
  history.record({ label: "c", ops: [
    { kind: "update", tag: "c1", before: 2, after: 4 },
    { kind: "update", tag: "c2", before: 7, after: 8 },
  ] });
  history.commitFrame("Edit tier");

  assert(!history.inFrame(), "the frame is closed");
  assert(history.undoLabel() === "Edit tier", "one grouped entry on top");

  assert(tags(history.undo()) === "c2,c1,a", "undo reverses the whole group, newest first");
  assert(history.undoLabel() === "outside", "the earlier entry is next");
  assert(tags(history.redo()) === "a,c1,c2", "redo replays the whole group in order");
});

Deno.test("cancelling puts everything back and leaves the stack below untouched", () => {
  // Setup: an entry outside, an undone entry outside (so a redo is pending), then a frame with
  // two entries.
  // Test: cancelFrame.
  // Verifies: the ops returned undo both entries, newest first; the outer undo stack and its
  // redo stack are exactly as they were; a frame that recorded nothing cancels to null.
  const history = EditHistory.create();

  history.record(update("kept", 0, 1));
  history.record(update("undone", 1, 2));
  history.undo();
  history.beginFrame();
  history.record(update("a", 1, 5));
  history.record(update("b", 5, 6));

  assert(tags(history.cancelFrame()) === "b,a", "both entries are undone, newest first");
  assert(history.undoLabel() === "kept" && history.redoLabel() === "undone", "the stack below is as it was");

  history.beginFrame();
  assert(history.cancelFrame() === null, "an empty frame has nothing to undo");
  assert(history.cancelFrame() === null, "and cancelling with no frame open does nothing");
});
