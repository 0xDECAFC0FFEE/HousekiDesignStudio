/*
 * edit_history.js -- the undo/redo stack for the user's own edits to a design's
 * cutting instructions and to the stone's material (the user's request,
 * 2026-09-18: "start recording all changes that the user makes to the faceting
 * instructions or the material ... a stack that saves diffs that can be applied
 * and unapplied").
 *
 * WHAT IS STORED: DIFFS, NOT SNAPSHOTS.
 *
 * Each user action is one ENTRY, `{ label, ops }`, and `ops` is a list of
 * diffs, each one of three kinds:
 *
 *   { kind: 'delete', index, value, ... }   remove `value` from position `index`
 *   { kind: 'insert', index, value, ... }   put `value` at position `index`
 *   { kind: 'update', before, after, ... }  a value changed from `before` to `after`
 *
 * Anything else on an op (which list, which tier, which fields) is the page's
 * own addressing and is carried through untouched: this file knows how to
 * invert and replay a diff, not what it is a diff of. The page's mapping, in
 * the user's own terms:
 *
 *   - dragging a tier to a new place in the cutting order is a delete and an
 *     insert (one entry, two ops), `moveOps` below;
 *   - editing a tier's description is an update;
 *   - changing the material, the refractive index, the dispersion or the stone
 *     colour is an update, of only the material fields that changed
 *     (`changedFields` below), so undoing one never rewinds another.
 *
 * UNDO AND REDO. `undo()` returns the ops that UNapply the newest entry -- each
 * op inverted (delete <-> insert, update's before <-> after), in REVERSE order,
 * so a delete-then-insert unwinds as delete-then-insert of the other place --
 * and moves the entry to the redo stack. `redo()` returns the entry's own ops
 * again. Recording a new entry clears the redo stack: once the user does
 * something new, the undone entries are no longer "still on the stack".
 *
 * A classic script publishing `globalThis.EditHistory`, like its siblings, so the
 * page can run it from file:// and Deno can test it the same way.
 */
(function () {
    "use strict";

    /** How many entries undo can reach back through before the oldest is dropped. */
    var DEFAULT_LIMIT = 500;

    /** The op that undoes `op`. Extra fields (the page's addressing) are copied as they are. */
    function invertOp(op) {
        var inverse = Object.assign({}, op);

        if (op.kind === "delete") {
            inverse.kind = "insert";
        } else if (op.kind === "insert") {
            inverse.kind = "delete";
        } else if (op.kind === "update") {
            inverse.before = op.after;
            inverse.after = op.before;
        } else {
            throw new Error("edit history: unknown op kind " + JSON.stringify(op.kind));
        }

        return inverse;
    }

    /** The ops that undo `ops`: each inverted, last first. */
    function invertOps(ops) {
        return ops.slice().reverse().map(invertOp);
    }

    /**
     * A copy of `list` with one delete or insert applied. A delete checks that
     * `value` really is at `index` (by identity), so replaying a diff against a
     * list it was not recorded from fails loudly instead of removing the wrong
     * item.
     */
    function applyListOp(list, op) {
        var next = list.slice();

        if (op.kind === "delete") {
            if (next[op.index] !== op.value) {
                throw new Error("edit history: delete at " + op.index + " does not match the list");
            }

            next.splice(op.index, 1);
        } else if (op.kind === "insert") {
            if (op.index < 0 || op.index > next.length) {
                throw new Error("edit history: insert at " + op.index + " is outside the list");
            }

            next.splice(op.index, 0, op.value);
        } else {
            throw new Error("edit history: " + JSON.stringify(op.kind) + " is not a list op");
        }

        return next;
    }

    /**
     * The delete and insert that turn `before` into `after`, when `after` is
     * `before` with exactly one item moved (what one drag of a tier row does),
     * or `[]` when the two are the same order. `extra` is merged into both ops.
     * Throws if `after` is not a single move of `before`.
     *
     * The insert's index is the item's position in `after`, which is also where
     * it goes in the list once the delete has taken it out.
     */
    function moveOps(before, after, extra) {
        if (before.length !== after.length) {
            throw new Error("edit history: a move cannot change the list's length");
        }

        var first = 0;
        var last = before.length - 1;

        while (first < before.length && before[first] === after[first]) {
            first += 1;
        }

        if (first === before.length) {
            return [];
        }

        while (before[last] === after[last]) {
            last -= 1;
        }

        // Either the item at the end of the changed stretch moved up to its start,
        // or the one at its start moved down to its end.
        var from = after[first] === before[last] ? last : first;
        var to = from === last ? first : last;
        var ops = [
            Object.assign({}, extra, { kind: "delete", index: from, value: before[from] }),
            Object.assign({}, extra, { kind: "insert", index: to, value: before[from] }),
        ];

        var replayed = ops.reduce(applyListOp, before);

        if (replayed.some(function (item, i) { return item !== after[i]; })) {
            throw new Error("edit history: the new order is not a single move of the old one");
        }

        return ops;
    }

    /** Equality for the values an update holds: numbers, strings and arrays of them. */
    function sameValue(a, b) {
        if (Array.isArray(a) && Array.isArray(b)) {
            return a.length === b.length && a.every(function (item, i) { return sameValue(item, b[i]); });
        }

        return a === b;
    }

    /**
     * The fields of `fields` whose values differ between two snapshots, as an
     * update's `{ before, after }` holding only those fields, or `null` when none
     * changed (so nothing is recorded).
     */
    function changedFields(before, after, fields) {
        var diff = { before: {}, after: {} };
        var changed = false;

        fields.forEach(function (field) {
            if (!sameValue(before[field], after[field])) {
                diff.before[field] = before[field];
                diff.after[field] = after[field];
                changed = true;
            }
        });

        return changed ? diff : null;
    }

    /**
     * A new, empty history. `onChange()`, if given, is called after anything
     * that changes what undo or redo would do, so the page can enable or
     * disable its menu items.
     */
    function create(options) {
        var limit = (options && options.limit) || DEFAULT_LIMIT;
        var onChange = (options && options.onChange) || function () {};
        var undoStack = [];
        var redoStack = [];
        // Stack frames (2026-09-19, the user, for edit mode): `undoStack` and `redoStack` are always
        // the innermost frame's. `beginFrame` sets the current pair aside here and starts an empty
        // one, so undo and redo cannot reach past the frame's start; `commitFrame` and
        // `cancelFrame` end the frame and bring the outer pair back.
        var outer = [];

        return {
            /** Pushes an entry, `{ label, ops }`. An entry with no ops is ignored. */
            record: function (entry) {
                if (!entry.ops || entry.ops.length === 0) {
                    return;
                }

                undoStack.push(entry);

                if (undoStack.length > limit) {
                    undoStack.shift();
                }

                redoStack = [];
                onChange();
            },

            /** The ops that unapply the newest entry, or null if there is none. */
            undo: function () {
                var entry = undoStack.pop();

                if (!entry) {
                    return null;
                }

                redoStack.push(entry);
                onChange();

                return invertOps(entry.ops);
            },

            /** The ops that reapply the newest undone entry, or null if there is none. */
            redo: function () {
                var entry = redoStack.pop();

                if (!entry) {
                    return null;
                }

                undoStack.push(entry);
                onChange();

                return entry.ops.slice();
            },

            canUndo: function () { return undoStack.length > 0; },
            canRedo: function () { return redoStack.length > 0; },
            undoLabel: function () { return undoStack.length ? undoStack[undoStack.length - 1].label : null; },
            redoLabel: function () { return redoStack.length ? redoStack[redoStack.length - 1].label : null; },

            /**
             * Starts a stack frame: from here undo and redo see only what is recorded after this
             * call, so undoing straight away does nothing. Frames nest.
             */
            beginFrame: function () {
                outer.push({ undo: undoStack, redo: redoStack });
                undoStack = [];
                redoStack = [];
                onChange();
            },

            /** True while a frame is open. */
            inFrame: function () { return outer.length > 0; },

            /**
             * Ends the innermost frame and keeps its work: everything still applied in it (what was
             * undone inside it is gone) becomes ONE entry, labelled `label`, on the stack below,
             * whose ops are the frame's entries' ops in order -- so one undo reverses all of it,
             * newest first, and one redo replays all of it. Nothing is recorded when the frame
             * holds no edits. Does nothing when no frame is open.
             */
            commitFrame: function (label) {
                if (outer.length === 0) {
                    return;
                }

                var entries = undoStack;
                var below = outer.pop();

                undoStack = below.undo;
                redoStack = below.redo;

                var ops = [];

                entries.forEach(function (entry) { ops = ops.concat(entry.ops); });
                this.record({ label: label, ops: ops });
                onChange();
            },

            /**
             * Ends the innermost frame and discards its work: the ops that put everything back to
             * how it was when the frame began (every entry still applied, inverted, newest first),
             * or null when there is nothing to put back. The stack below is exactly as it was.
             */
            cancelFrame: function () {
                if (outer.length === 0) {
                    return null;
                }

                var ops = [];

                while (undoStack.length > 0) {
                    ops = ops.concat(invertOps(undoStack.pop().ops));
                }

                var below = outer.pop();

                undoStack = below.undo;
                redoStack = below.redo;
                onChange();

                return ops.length > 0 ? ops : null;
            },

            /** Forgets everything, frames included, for when another stone is opened. */
            clear: function () {
                undoStack = [];
                redoStack = [];
                outer = [];
                onChange();
            },
        };
    }

    globalThis.EditHistory = {
        create: create,
        invertOp: invertOp,
        invertOps: invertOps,
        applyListOp: applyListOp,
        moveOps: moveOps,
        changedFields: changedFields,
        defaults: { limit: DEFAULT_LIMIT },
    };
}());
