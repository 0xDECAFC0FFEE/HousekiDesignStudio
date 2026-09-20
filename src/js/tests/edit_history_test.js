/*
 * edit_history_test.js -- tests for www/js/edit_history.js, the undo/redo stack
 * of diffs the page records the user's edits to the cutting instructions and
 * the material in.
 *
 * HOW TO RUN
 *   deno test --allow-read www/js/tests/
 *
 * WHAT THIS SUITE IS FOR
 *   The page applies the diffs; this file owns what a diff IS and how it is
 *   inverted and replayed. So these tests check, on small hand-written lists
 *   and snapshots whose right answer can be written down directly:
 *
 *   1. a drag's reorder becomes exactly one delete and one insert, and those
 *      two ops really reproduce the new order;
 *   2. undoing an entry gives ops that restore the old state exactly, and
 *      redoing gives back the new one;
 *   3. the stack behaves like an editor's: new edits clear redo, the limit
 *      drops the oldest entry, clear() forgets everything;
 *   4. a material update records only the fields that changed.
 */

function assert(condition, message) {
    if (!condition) {
        throw new Error("assertion failed: " + (message || ""));
    }
}

function assertEquals(actual, expected, message) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        throw new Error(
            "assertion failed: " + (message || "") + "\n  actual:   " + a + "\n  expected: " + e);
    }
}

function assertThrows(fn, message) {
    try {
        fn();
    } catch (_) {
        return;
    }
    throw new Error("assertion failed: expected a throw: " + (message || ""));
}

// Loaded exactly the way the page loads it: a classic script, evaluated in the
// global scope, which publishes globalThis.EditHistory.
(0, eval)(await Deno.readTextFile(new URL("../edit_history.js", import.meta.url)));
const EditHistory = globalThis.EditHistory;

/** Applies a list of delete/insert ops to a list, the way the page replays them. */
function replay(list, ops) {
    return ops.reduce(EditHistory.applyListOp, list);
}

Deno.test("moveOps: moving the last item to the top is one delete and one insert", () => {
    // Setup: four tiers in cutting order; the user drags D from the bottom to
    // the top, so every other tier shifts down one place.
    const before = ["A", "B", "C", "D"];
    const after = ["D", "A", "B", "C"];

    // Test: derive the diff for that reorder.
    const ops = EditHistory.moveOps(before, after, { section: "pavilion" });

    // Verifies: the user's rule -- a reorder is a delete then an insert -- with
    // D leaving position 3 and going in at position 0; the page's own addressing
    // (`section`) rides along on both; and the two ops really do produce `after`.
    assertEquals(ops, [
        { section: "pavilion", kind: "delete", index: 3, value: "D" },
        { section: "pavilion", kind: "insert", index: 0, value: "D" },
    ]);
    assertEquals(replay(before, ops), after);
});

Deno.test("moveOps: moving the first item down, and swapping two neighbours", () => {
    // Setup and test: the opposite direction (A to the bottom) and the smallest
    // move there is (two neighbours swapped), where both ends of the changed
    // stretch could be "the one that moved".
    const before = ["A", "B", "C", "D"];
    const down = EditHistory.moveOps(before, ["B", "C", "D", "A"], {});
    const swap = EditHistory.moveOps(before, ["B", "A", "C", "D"], {});

    // Verifies: A is deleted at 0 and inserted at 3; and a swap is still exactly
    // two ops that reproduce the swapped order.
    assertEquals(down.map(op => [op.kind, op.index, op.value]), [["delete", 0, "A"], ["insert", 3, "A"]]);
    assertEquals(swap.length, 2);
    assertEquals(replay(before, swap), ["B", "A", "C", "D"]);
});

Deno.test("moveOps: the same order is no diff, and a non-move is refused", () => {
    // Setup: a drag dropped back where it started, and an order that no single
    // move produces (two separate pairs swapped).
    const before = ["A", "B", "C", "D"];

    // Test and verify: no ops at all for the unchanged order (so nothing is
    // recorded), and a throw rather than a wrong diff for the impossible one.
    assertEquals(EditHistory.moveOps(before, before.slice(), {}), []);
    assertThrows(() => EditHistory.moveOps(before, ["B", "A", "D", "C"], {}), "two swaps");
});

Deno.test("undo of a move restores the old order, and redo the new one", () => {
    // Setup: a history holding one reorder entry, recorded the way the page does.
    const before = ["P1", "P2", "P3"];
    const after = ["P3", "P1", "P2"];
    const history = EditHistory.create();

    history.record({ label: "Move tier", ops: EditHistory.moveOps(before, after, {}) });

    // Test: undo, replayed on the new order; then redo, replayed on the result.
    const undone = replay(after, history.undo());
    const redone = replay(undone, history.redo());

    // Verifies: the inverted ops (delete where it was inserted, insert where it
    // was deleted, in reverse order) give back exactly the old order, and redo
    // exactly the new one.
    assertEquals(undone, before);
    assertEquals(redone, after);
});

Deno.test("undo of an update swaps before and after; extra fields are kept", () => {
    // Setup: a description edit on one tier, addressed by the page's own fields.
    const history = EditHistory.create();

    history.record({
        label: "Edit description",
        ops: [{ kind: "update", target: "tierNotes", tier: 4, before: "", after: "polish last" }],
    });

    // Test: undo it.
    const [op] = history.undo();

    // Verifies: the undo op sets the text back ("polish last" -> ""), and still
    // says which tier it is about.
    assertEquals(op, { kind: "update", target: "tierNotes", tier: 4, before: "polish last", after: "" });
});

Deno.test("a new edit after an undo clears redo; undo and redo on empty stacks give null", () => {
    // Setup: two edits, the second undone, then a third, different edit.
    const history = EditHistory.create();
    const edit = n => ({ label: "edit " + n, ops: [{ kind: "update", before: n - 1, after: n }] });

    history.record(edit(1));
    history.record(edit(2));
    history.undo();
    assert(history.canRedo(), "edit 2 can be redone before anything new happens");

    // Test: record something new.
    history.record(edit(3));

    // Verifies: edit 2 is no longer on the stack to redo ("if they're still on
    // the stack"), undo now reaches edit 3 then edit 1, and an exhausted stack
    // answers null rather than throwing.
    assert(!history.canRedo(), "a new edit clears redo");
    assertEquals(history.redo(), null);
    assertEquals(history.undoLabel(), "edit 3");
    history.undo();
    assertEquals(history.undoLabel(), "edit 1");
    history.undo();
    assertEquals(history.undo(), null);
    assert(!history.canUndo());
});

Deno.test("the limit drops the oldest entry; clear forgets both stacks; onChange fires", () => {
    // Setup: a history that keeps two entries, counting onChange calls.
    let changes = 0;
    const history = EditHistory.create({ limit: 2, onChange: () => { changes += 1; } });
    const edit = n => ({ label: "edit " + n, ops: [{ kind: "update", before: 0, after: n }] });

    // Test: three edits, one undo, then clear.
    history.record(edit(1));
    history.record(edit(2));
    history.record(edit(3));
    history.undo();
    assertEquals(history.undoLabel(), "edit 2", "edit 3 undone, edit 2 next");
    history.undo();

    // Verifies: edit 1 fell off the bottom, so after undoing 3 and 2 nothing is
    // left; clear() empties redo too; every change was reported (3 records, 2
    // undos, 1 clear); and an entry with no ops records nothing, reports nothing.
    assert(!history.canUndo(), "edit 1 was dropped by the limit");
    history.clear();
    assert(!history.canRedo(), "clear empties redo");
    assertEquals(changes, 6);
    history.record({ label: "nothing", ops: [] });
    assert(!history.canUndo(), "an empty entry is ignored");
    assertEquals(changes, 6);
});

Deno.test("changedFields keeps only what changed, comparing colours by value", () => {
    // Setup: two material snapshots where only the refractive index changed; the
    // colour arrays are different objects with the same numbers, as two reads of
    // app.stone_color() would be.
    const fields = ["preset", "refractiveIndex", "dispersion", "stoneColor"];
    const before = { preset: "Diamond", refractiveIndex: 2.417, dispersion: 0.044, stoneColor: [1, 1, 1] };
    const after = { preset: "Diamond", refractiveIndex: 2.5, dispersion: 0.044, stoneColor: [1, 1, 1] };

    // Test: diff them, and diff a snapshot against itself.
    const diff = EditHistory.changedFields(before, after, fields);

    // Verifies: the update holds the refractive index alone (so undoing it can
    // never rewind a colour edit made since), and no change means no update.
    assertEquals(diff, { before: { refractiveIndex: 2.417 }, after: { refractiveIndex: 2.5 } });
    assertEquals(EditHistory.changedFields(before, { ...before, stoneColor: [1, 1, 1] }, fields), null);
});

Deno.test("a deleted tier is undone by an insert of the very same object, and redone by a delete", () => {
    // Setup: a section's order as tier OBJECTS (the page's ops hold objects, not
    // ids), and the entry the toolbar's Delete button records for its middle tier:
    // one delete, carrying the page's own addressing (`target`, `section`, and
    // `arrayIndex`, where the tier sat in design.tiers).
    const p1 = { id: "P1", cuttingInstructions: "cut first" };
    const p2 = { id: "P2", cuttingInstructions: "level girdle" };
    const p3 = { id: "P3", cuttingInstructions: "" };
    const before = [p1, p2, p3];
    const op = { kind: "delete", target: "tiers", section: "pavilion", index: 1, arrayIndex: 2, value: p2 };
    const history = EditHistory.create();

    history.record({ label: "Delete tier", ops: [op] });
    const after = replay(before, [op]);

    // Test: undo, replayed on the shortened order; then redo, replayed on the result.
    const undoOps = history.undo();
    const undone = replay(after, undoOps);
    const redone = replay(undone, history.redo());

    // Verifies: undo is an insert of that object at the same place, with the page's
    // addressing intact; it gives back the old order with the SAME object (identity,
    // not an equal copy, so its description and every other field come back with it,
    // and the page's maps keyed by tier object keep working); redo deletes it again.
    assertEquals(undoOps.length, 1);
    assertEquals(undoOps[0].kind, "insert");
    assertEquals([undoOps[0].section, undoOps[0].index, undoOps[0].arrayIndex], ["pavilion", 1, 2]);
    assert(undoOps[0].value === p2, "the undo names the very tier object that was deleted");
    assert(undone[1] === p2 && undone[1].cuttingInstructions === "level girdle", "the same object is back");
    assertEquals(undone.map(t => t.id), ["P1", "P2", "P3"]);
    assertEquals(redone.map(t => t.id), ["P1", "P3"]);
});

Deno.test("applyListOp refuses a delete that does not match the list", () => {
    // Setup: a delete recorded for "B" at index 1, replayed on a list where
    // index 1 holds something else (the list has changed since).
    const op = { kind: "delete", index: 1, value: "B" };

    // Test and verify: a throw, not a silent removal of the wrong item; and an
    // insert past the end is refused the same way.
    assertThrows(() => EditHistory.applyListOp(["A", "C"], op), "wrong item at index");
    assertThrows(() => EditHistory.applyListOp(["A"], { kind: "insert", index: 5, value: "B" }));
    assertEquals(EditHistory.applyListOp(["A", "B"], op), ["A"]);
});
