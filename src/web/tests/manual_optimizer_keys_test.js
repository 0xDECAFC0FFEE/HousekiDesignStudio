/*
 * manual_optimizer_keys_test.js -- tests for the manual optimizer's grid from the keyboard
 * (T-0274, 2026-09-28), src/web/src/lib/manual_optimizer_keys.js, and for what its answers do to
 * the mode (manual_optimizer_mode.js). The user:
 *
 *   "also can you support enter (to select a cell), shift (to refine the center and ranges) and
 *   arrow keys when navigating around the table"
 *
 * and later the same day (T-0285):
 *
 *   "lets get rid of enter to update the central render, once users click on the manual optimizer
 *   table, arrow keys should move you around the table and update the central render."
 *
 * Read as: the arrow keys move a cursor between cells, stopping at the edges, and the cell they
 * land on is shown in the middle as a click on it would show it (until T-0285 they only moved the
 * cursor and Enter or Space was the click); Enter and Space now do nothing on the grid; Shift +
 * arrows grow a rectangle from where the cursor was, the middle unchanged until Shift is let go,
 * then applied exactly as a rectangle dragged with the mouse is; Escape drops a rectangle being
 * grown; and every key the grid takes is marked handled, so the page's own shortcuts never see it.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The first half drives the pure `gridKey` with key events written out as a KeyboardEvent carries
 * them. The second half hands its answers to the mode (no renderer: `engine.app` is null, as in
 * manual_optimizer_test.js) and compares the result with what the mouse's own calls give. An arrow
 * step is shown at the next frame (`stepGridCell`); Deno has no frames, so the mode uses a zero
 * timer there and these tests wait for it (`nextFrame`). The real keys on the built page are
 * checked in headless Chrome.
 */

globalThis.window = globalThis.window ?? {};

import { get } from "svelte/store";
import { initialKeys, gridKey, stepCell, clampCell, dropRectangle } from "../src/lib/manual_optimizer_keys.js";
import {
  enterManualOptimizer, cancelManualOptimizer, exitManualOptimizer, setSubdivisions, setRange,
  previewGridCell, stepGridCell, selectGridRectangle, manualOptimizer,
} from "../src/lib/manual_optimizer_mode.js";
import { render, setEditRecorder, setHistoryFrames, applyEdit } from "../src/lib/tier_controller.js";
import { undo, redo } from "../src/lib/session.js";

for (const script of ["edit_history.js", "gemcad.js", "gemcad_obj.js", "design.js", "design_mesh.js", "gcs.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${script}`, import.meta.url)));
}

const { GemCadDesign, GemCutStudio, EditHistory } = globalThis;
const STARTUP_URL = new URL("../../resources/hex_cut_v2.gcs", import.meta.url);

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

/** A key going down, as `gridKey` reads a KeyboardEvent: `down("ArrowUp", { shiftKey: true })`. */
const down = (key, modifiers = {}) => ({
  type: "down", key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...modifiers,
});

/** A key coming up. */
const up = (key, modifiers = {}) => ({ ...down(key, modifiers), type: "up" });

/**
 * Presses `events` in order on a grid of `n`, from `keys`; returns the last state and every
 * answer, so a test can look at each step.
 */
function press(keys, events, n) {
  const answers = [];

  for (const event of events) {
    const answer = gridKey(keys, event, n);

    answers.push(answer);
    keys = answer.keys;
  }

  return { keys, answers };
}

// ---- the arrows

Deno.test("each arrow key moves the cursor one cell its way and shows that cell in the middle", () => {
  // Setup: a 5 x 5 grid, the cursor on the middle cell (2, 2).
  // Test: press each arrow key once from there.
  // Verifies: Up is the row above, Down the row below, Left the column to the left, Right the
  // column to the right -- one cell each; the key is handled (so it goes no further); the mode is
  // asked to show exactly the cell the cursor landed on (a 'step', T-0285: until then an arrow
  // asked for nothing and Enter was the click); and no rectangle is started without Shift.
  const start = initialKeys({ row: 2, column: 2 }, 5);
  const moves = { ArrowUp: [1, 2], ArrowDown: [3, 2], ArrowLeft: [2, 1], ArrowRight: [2, 3] };

  for (const [key, [row, column]] of Object.entries(moves)) {
    const answer = gridKey(start, down(key), 5);

    assertEqual(answer.keys.cursor, { row, column }, `${key} moves one cell`);
    assertEqual([answer.handled, answer.keys.anchor], [true, null], `${key}: handled, no rectangle`);
    assertEqual(answer.action, { kind: "step", row, column }, `${key}: the cell landed on is shown`);
  }
});

Deno.test("the cursor stops at the grid's edges and never wraps round", () => {
  // Setup: grids of every size the mode allows, 3, 5, 7, 9 and 11, and each corner cell of each.
  // Test: from each corner, press the two arrow keys that point out of the grid, several times;
  // then walk right along the top row further than the grid is wide.
  // Verifies: pressing outwards leaves the cursor where it is (still handled, so the key does not
  // scroll the pane or reach the page instead) and asks the mode for nothing, since the cell shown
  // does not change; no press wraps to the opposite edge; and a walk along a row asks for each cell
  // of the row once, in order, ends on its last cell, and asks for nothing more once there.
  // stepCell, the one-step helper, agrees.
  for (const n of [3, 5, 7, 9, 11]) {
    const last = n - 1;
    const corners = [
      [{ row: 0, column: 0 }, ["ArrowUp", "ArrowLeft"]],
      [{ row: 0, column: last }, ["ArrowUp", "ArrowRight"]],
      [{ row: last, column: 0 }, ["ArrowDown", "ArrowLeft"]],
      [{ row: last, column: last }, ["ArrowDown", "ArrowRight"]],
    ];

    for (const [corner, outwards] of corners) {
      for (const key of outwards) {
        const { keys, answers } = press(initialKeys(corner, n), [down(key), down(key), down(key)], n);

        assertEqual(keys.cursor, corner, `${n}: ${key} from ${JSON.stringify(corner)} stays`);
        assertEqual(answers.every(answer => answer.handled), true, `${n}: ${key} at the edge is still handled`);
        assertEqual(answers.every(answer => answer.action === null), true, `${n}: ${key} at the edge shows nothing new`);
        assertEqual(stepCell(corner, key, n), corner, `${n}: stepCell agrees`);
      }
    }

    const walk = press(initialKeys({ row: 0, column: 0 }, n), Array(n + 3).fill(down("ArrowRight")), n);
    const asked = walk.answers.map(answer => answer.action);
    const expected = [
      ...Array.from({ length: last }, (_, i) => ({ kind: "step", row: 0, column: i + 1 })),
      ...Array(4).fill(null),
    ];

    assertEqual(walk.keys.cursor, { row: 0, column: last }, `${n}: a long walk right ends on the last column`);
    assertEqual(asked, expected, `${n}: each cell of the row shown once, then nothing at the edge`);
  }
});

Deno.test("an arrow with Alt, Ctrl or Cmd is not the grid's, nor is any other key", () => {
  // Setup: a 5 x 5 grid, the cursor in the middle.
  // Test: arrows with each of Alt, Ctrl and Cmd; the letter Z with Cmd (the mode's undo); and a
  // plain letter.
  // Verifies: none is handled and the cursor does not move, so Cmd+Z still reaches the page (where
  // it steps the mode's own undo) and other shortcuts are left alone.
  const start = initialKeys({ row: 2, column: 2 }, 5);

  for (const event of [
    down("ArrowUp", { altKey: true }), down("ArrowLeft", { ctrlKey: true }), down("ArrowRight", { metaKey: true }),
    down("z", { metaKey: true }), down("q"),
  ]) {
    const answer = gridKey(start, event, 5);

    assertEqual([answer.handled, answer.keys.cursor], [false, { row: 2, column: 2 }], `${event.key} is left alone`);
  }
});

Deno.test("a cursor outside a smaller grid is held inside it", () => {
  // Setup: a cursor on (6, 6), left there from a 7 x 7 grid, then the grid is 3 x 3.
  // Test: clampCell, and an arrow press on the smaller grid.
  // Verifies: the cursor is brought to the nearest cell of the new grid (2, 2) before it moves,
  // so a key never addresses a cell that is not there.
  assertEqual(clampCell({ row: 6, column: 6 }, 3), { row: 2, column: 2 }, "held to the corner");
  assertEqual(gridKey(initialKeys({ row: 6, column: 6 }, 7), down("ArrowUp"), 3).keys.cursor, { row: 1, column: 2 },
    "then moved from there");
});

// ---- Enter and Space

Deno.test("Enter and Space do nothing on the grid, but are still the grid's", () => {
  // Setup: a 5 x 5 grid, the cursor moved from the middle to (1, 3) with the arrows; and
  // separately a Shift rectangle being grown from (0, 0) to (1, 1).
  // Test: press Enter, Space, and Enter with Shift, in each case.
  // Verifies (T-0285, the user: "lets get rid of enter to update the central render"): none asks
  // the mode for anything -- until then Enter and Space were a click on the cursor's cell -- and
  // none moves the cursor or starts, ends or changes a rectangle. Each is still handled, so the
  // grid's handler prevents the key's default: a focused cell is a button, which Enter or Space
  // would otherwise press, and the page's own Enter (edit the selected tier) stays out too.
  const moved = press(initialKeys({ row: 2, column: 2 }, 5), [down("ArrowUp"), down("ArrowRight")], 5).keys;
  const shift = { shiftKey: true };
  const growing = press(initialKeys({ row: 0, column: 0 }, 5), [down("ArrowDown", shift), down("ArrowRight", shift)], 5).keys;

  assertEqual(moved.cursor, { row: 1, column: 3 }, "the cursor moved");

  for (const keys of [moved, growing]) {
    for (const event of [down("Enter"), down(" "), down("Enter", shift)]) {
      const answer = gridKey(keys, event, 5);

      assertEqual(answer.handled, true, `${JSON.stringify(event.key)} is handled`);
      assertEqual(answer.action, null, `${JSON.stringify(event.key)} asks for nothing`);
      assertEqual(answer.keys, keys, `${JSON.stringify(event.key)} leaves the cursor and any rectangle as they were`);
    }
  }
});

// ---- Shift + arrows

Deno.test("Shift + arrows grow a rectangle from where the cursor was, applied when Shift is let go", () => {
  // Setup: a 5 x 5 grid, the cursor on (1, 1).
  // Test: hold Shift and press Right, Down, Down (the Shift key's own keydown first, as a browser
  // sends it), then let go of Shift.
  // Verifies: while Shift is held the rectangle's corners are the cell the cursor started on
  // (1, 1) and the cursor's cell -- (1, 2), then (2, 2), then (3, 2) -- so the grid can light it,
  // and nothing is asked of the mode yet (in particular no 'step': the arrows show the cell they
  // land on only without Shift, so the middle does not change while the rectangle grows); letting
  // go of Shift answers a rectangle from (1, 1) to
  // (3, 2), exactly the corners a mouse drag between those cells hands over, and ends the
  // rectangle. The Shift key going down on its own is not the grid's.
  const shift = { shiftKey: true };
  const { keys, answers } = press(initialKeys({ row: 1, column: 1 }, 5), [
    down("Shift", shift), down("ArrowRight", shift), down("ArrowDown", shift), down("ArrowDown", shift),
  ], 5);

  assertEqual(answers[0].handled, false, "Shift alone is not the grid's");
  assertEqual(answers.slice(1).map(answer => answer.keys.anchor), [{ row: 1, column: 1 }, { row: 1, column: 1 }, { row: 1, column: 1 }],
    "the first corner stays where the cursor started");
  assertEqual(answers.slice(1).map(answer => answer.keys.cursor), [{ row: 1, column: 2 }, { row: 2, column: 2 }, { row: 3, column: 2 }],
    "the other corner follows the cursor");
  assertEqual(answers.every(answer => answer.action === null), true, "nothing applied while Shift is held");

  const release = gridKey(keys, up("Shift"), 5);

  assertEqual(release.handled, true, "letting go of Shift is the grid's");
  assertEqual(release.action, { kind: "rectangle", from: { row: 1, column: 1 }, to: { row: 3, column: 2 } }, "the rectangle applied");
  assertEqual(release.keys.anchor, null, "and ended");
});

Deno.test("a Shift rectangle grown back onto its first cell applies nothing", () => {
  // Setup: a 5 x 5 grid, the cursor on (2, 2).
  // Test: with Shift held press Right then Left (back where it began), then let go of Shift.
  // Verifies: no action -- a one-cell rectangle is not a re-centring, and the cell is the one the
  // middle already shows -- and the rectangle is over.
  const shift = { shiftKey: true };
  const { keys } = press(initialKeys({ row: 2, column: 2 }, 5), [down("ArrowRight", shift), down("ArrowLeft", shift)], 5);
  const release = gridKey(keys, up("Shift"), 5);

  assertEqual([release.action, release.keys.anchor, release.keys.cursor], [null, null, { row: 2, column: 2 }],
    "nothing applied, nothing left growing");
});

Deno.test("Escape drops a rectangle being grown; with none, it is left to the page", () => {
  // Setup: a 5 x 5 grid; a rectangle grown with Shift + Down + Right from (0, 0).
  // Test: press Escape with Shift still held, then let go of Shift; separately Escape with no
  // rectangle; and the grid losing the keyboard mid-rectangle (dropRectangle, which the grid calls
  // when the focus leaves it).
  // Verifies: the first Escape is the grid's (handled, so it does not also cancel the mode), ends
  // the rectangle and puts the cursor back on the cell it grew from (0, 0), which is the cell the
  // middle still shows (since T-0285 the cursor is kept on it; until then it stayed on the far
  // corner); letting go of Shift afterwards applies nothing; Escape with no rectangle is NOT
  // handled, so the page's own Escape cancels the mode as before; and losing the focus drops the
  // rectangle the same way, while a cursor with no rectangle is left as it is.
  const shift = { shiftKey: true };
  const { keys } = press(initialKeys({ row: 0, column: 0 }, 5), [down("ArrowDown", shift), down("ArrowRight", shift)], 5);

  const escaped = gridKey(keys, down("Escape", shift), 5);

  assertEqual([escaped.handled, escaped.keys.anchor, escaped.keys.cursor], [true, null, { row: 0, column: 0 }],
    "Escape is the grid's, drops the rectangle, and the cursor goes back to its first cell");
  assertEqual(escaped.action, null, "and nothing is shown or applied");
  assertEqual(gridKey(escaped.keys, up("Shift"), 5).action, null, "letting go of Shift then applies nothing");
  assertEqual(gridKey(initialKeys({ row: 2, column: 2 }, 5), down("Escape"), 5).handled, false,
    "with no rectangle, Escape is the page's");
  assertEqual(dropRectangle(keys), { cursor: { row: 0, column: 0 }, anchor: null }, "focus lost: dropped the same way");
  assertEqual(dropRectangle(escaped.keys), escaped.keys, "with no rectangle, nothing changes");
});

// ---- what the answers do to the mode, against the mouse

/** Loads the startup stone into the tier controller with an edit history, as the page does. */
async function loadDesign() {
  const { parsed } = GemCutStudio.importText(await Deno.readTextFile(STARTUP_URL));
  const design = GemCadDesign.fromGemCad(parsed, { name: "hex_cut_v2.gcs" });
  const history = EditHistory.create();

  setEditRecorder(entry => history.record(entry));
  setHistoryFrames({
    begin: () => history.beginFrame(),
    commit: label => history.commitFrame(label),
    cancel: () => {
      const ops = history.cancelFrame();

      if (ops) {
        applyEdit(ops);
      }
    },
  });
  render(design, null);
  return design;
}

const tiers = design => design.tiers.map(tier => [tier.angle, tier.distance]);

/**
 * Opens the mode at `subdivisions` and 60% / 30%, does `act()` (and waits for it), and returns the
 * mode's state and the design's tiers, then cancels.
 */
async function after(subdivisions, act) {
  const design = await loadDesign();

  enterManualOptimizer();
  setSubdivisions(subdivisions);
  setRange("crown", 60);
  setRange("pavilion", 30);
  await act(design);

  const result = { state: get(manualOptimizer).state, selected: get(manualOptimizer).selected, tiers: tiers(design) };

  cancelManualOptimizer();
  render(null, null);
  return result;
}

/**
 * Waits for the mode's next "frame": an arrow step is shown then (`stepGridCell`), and without a
 * browser that is a zero timer, which runs before this one.
 */
const nextFrame = () => new Promise(resolve => setTimeout(resolve, 0));

/** Hands a `gridKey` answer's action to the mode, as ManualOptimizerGrid.svelte does. */
function perform(action) {
  if (action?.kind === "step") {
    stepGridCell(action.row, action.column);
  } else if (action?.kind === "rectangle") {
    selectGridRectangle(action.from, action.to);
  }
}

/** Presses `events` from `keys` on a grid of `n`, handing every answer to the mode; returns the keys. */
function pressAndPerform(keys, events, n) {
  for (const event of events) {
    const answer = gridKey(keys, event, n);

    perform(answer.action);
    keys = answer.keys;
  }

  return keys;
}

Deno.test("an arrow step shows its cell in the middle exactly as a click on it does", async () => {
  // Setup: the startup stone, the mode open at 5 x 5 with 60% crown and 30% pavilion, the middle
  // showing the grid's centre (1x, 1x).
  // Test: (a) from the middle, arrow Up, Up, Left, handing each answer to the mode, then wait a
  // frame; (b) afresh, a mouse click on the cell the arrows end on, (0, 1) -- the grid's click is
  // previewGridCell.
  // Verifies (T-0285): the arrows change the stone in the middle -- its tiers are no longer the
  // design as it was opened -- and the mode's state, the cell marked as shown and every tier's
  // angle and distance are then identical to the click's, bit for bit: an arrow step IS a click on
  // the cell it lands on (until T-0285 that took Enter).
  let opened = null;
  const keyboard = await after(5, async design => {
    opened = tiers(design);
    pressAndPerform(initialKeys({ row: 2, column: 2 }, 5), [down("ArrowUp"), down("ArrowUp"), down("ArrowLeft")], 5);
    await nextFrame();
  });
  const mouse = await after(5, () => previewGridCell(0, 1));

  assert(JSON.stringify(keyboard.tiers) !== JSON.stringify(opened), "the stone in the middle changed");
  assertEqual(keyboard.state, mouse.state, "the same state");
  assertEqual(keyboard.selected, mouse.selected, "the same cell shown");
  assertEqual(keyboard.tiers, mouse.tiers, "the same stone");
});

Deno.test("each arrow step moves the middle's heights one cell, and stops at the grid's edge", async () => {
  // Setup: the startup stone, the mode open at 5 x 5 with 60% crown and 30% pavilion.
  // Test: from the middle cell press Up, waiting a frame after each press, four times -- two
  // steps up to the top row, then two presses against the top edge; then Right once.
  // Verifies: after each of the first two presses the middle shows the next row up (the preview's
  // crown is that row's, the pavilion unchanged, and the cell marked shown is the cursor's); the
  // two presses against the edge leave the state and every tier exactly as they were on the top
  // row; and Right then moves the pavilion only, to the next column.
  await after(5, async design => {
    let keys = initialKeys({ row: 2, column: 2 }, 5);
    const cellAt = (row, column) => get(manualOptimizer).cells[row * 5 + column];
    const preview = () => get(manualOptimizer).state.preview;

    for (const row of [1, 0]) {
      keys = pressAndPerform(keys, [down("ArrowUp")], 5);
      await nextFrame();
      assertEqual(preview(), { crown: cellAt(row, 2).crown, pavilion: cellAt(row, 2).pavilion }, `Up: row ${row}`);
      assertEqual(get(manualOptimizer).selected, row * 5 + 2, `Up: cell (${row}, 2) marked shown`);
    }

    const top = { state: get(manualOptimizer).state, tiers: tiers(design) };

    for (let i = 0; i < 2; i++) {
      keys = pressAndPerform(keys, [down("ArrowUp")], 5);
      await nextFrame();
    }

    assertEqual(keys.cursor, { row: 0, column: 2 }, "the cursor stayed on the top row");
    assertEqual(get(manualOptimizer).state, top.state, "against the edge: the same state");
    assertEqual(tiers(design), top.tiers, "against the edge: the same stone");

    keys = pressAndPerform(keys, [down("ArrowRight")], 5);
    await nextFrame();
    assertEqual(preview(), { crown: cellAt(0, 3).crown, pavilion: cellAt(0, 3).pavilion }, "Right: the next column");
    assertEqual(preview().crown, top.state.preview.crown, "Right: the crown kept");
  });
});

Deno.test("an arrow held down shows only the last cell once per frame, and Done keeps a step not yet shown", async () => {
  // Setup: the startup stone, the mode open at 5 x 5 with 60% crown and 30% pavilion, counting
  // every time the stone in the middle changes (the preview in the mode's store; each change is a
  // rebuild of the stone on screen, the costly part of showing a cell).
  // Test: (a) press Right, Right, Down, Down, Left and Down in one go, as the key repeat of held
  // arrows delivers them faster than the page draws frames, then wait a frame; (b) press Up and,
  // before any frame, click Done.
  // Verifies: (a) before the frame nothing has changed yet, and after it the middle changed ONCE,
  // straight to the last cell asked for, (4, 3) -- the cells passed over are never built, so a held
  // arrow cannot queue a pile of rebuilds; (b) Done keeps the heights of the cell Up asked for,
  // (3, 3), though it was never shown: the user's last choice is not lost.
  let result = null;

  await after(5, async design => {
    const changes = [];
    const stop = manualOptimizer.subscribe(store => {
      const last = changes.at(-1);

      if (store.open && (!last || last.crown !== store.state.preview.crown || last.pavilion !== store.state.preview.pavilion)) {
        changes.push({ ...store.state.preview });
      }
    });
    const before = changes.length;
    let keys = pressAndPerform(initialKeys({ row: 2, column: 2 }, 5),
      ["ArrowRight", "ArrowRight", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowDown"].map(key => down(key)), 5);

    assertEqual(changes.length, before, "(a) nothing shown before the frame");
    await nextFrame();

    const cells = get(manualOptimizer).cells;

    assertEqual(keys.cursor, { row: 4, column: 3 }, "(a) the cursor went all the way");
    assertEqual(changes.slice(before), [{ crown: cells[23].crown, pavilion: cells[23].pavilion }],
      "(a) one change, straight to the last cell");
    stop();

    keys = pressAndPerform(keys, [down("ArrowUp")], 5);
    result = { expected: { crown: cells[18].crown, pavilion: cells[18].pavilion }, design };
    exitManualOptimizer();
    result.kept = tiers(design);
  });

  // The same heights by a click, for the tiers Done should have kept.
  const clicked = await after(5, () => previewGridCell(3, 3));

  assertEqual(result.kept, clicked.tiers, "(b) Done kept the step that was not yet shown");
});

Deno.test("a run of arrow steps is one step of the mode's undo", async () => {
  // Setup: the startup stone, the mode open at 5 x 5 with 60% crown and 30% pavilion; the slider
  // changes that set it up are steps of the mode's undo too, so the test counts from after them.
  // Test: (a) press Right, Right, Down (a frame after each, so each is shown), then Undo;
  // (b) Redo, then click cell (0, 0) with the mouse, then press Down, Down, then Undo twice;
  // (c) from the middle again, press Right then Left (back where the run began), then Undo.
  // Verifies: (a) one Undo takes the whole run back to the middle cell, where the arrows began --
  // the arrows are a way of looking along the grid, like dragging a slider, which is also one step,
  // so Undo is not pressed once per cell; (b) Redo brings the run's end back; a click is its own
  // step and ends the run, so the first Undo goes back from the arrows' cell to the clicked one and
  // the second back to the run before; (c) a run that comes back to where it began is no step at
  // all: Undo then undoes what came before it (here, a click back on the middle cell), rather than
  // a step that would change nothing.
  await after(5, async () => {
    const preview = () => get(manualOptimizer).state.preview;
    const middle = { ...preview() };
    let keys = initialKeys({ row: 2, column: 2 }, 5);

    for (const key of ["ArrowRight", "ArrowRight", "ArrowDown"]) {
      keys = pressAndPerform(keys, [down(key)], 5);
      await nextFrame();
    }

    const runEnd = { ...preview() };

    assert(runEnd.crown !== middle.crown && runEnd.pavilion !== middle.pavilion, "(a) the run moved the middle");
    undo();
    assertEqual(preview(), middle, "(a) one Undo takes the whole run back");

    redo();
    assertEqual(preview(), runEnd, "(b) Redo brings the run's end back");
    previewGridCell(0, 0);

    const clicked = { ...preview() };

    keys = { cursor: { row: 0, column: 0 }, anchor: null };

    for (const key of ["ArrowDown", "ArrowDown"]) {
      keys = pressAndPerform(keys, [down(key)], 5);
      await nextFrame();
    }

    undo();
    assertEqual(preview(), clicked, "(b) the first Undo goes back to the clicked cell");
    undo();
    assertEqual(preview(), runEnd, "(b) the second back to the earlier run's end");

    // (c): back to the middle by a click, a step of its own; then out and back with the arrows.
    previewGridCell(2, 2);

    const pavilionRange = get(manualOptimizer).state.pavilionRange;

    keys = { cursor: { row: 2, column: 2 }, anchor: null };

    for (const key of ["ArrowRight", "ArrowLeft"]) {
      keys = pressAndPerform(keys, [down(key)], 5);
      await nextFrame();
    }

    assertEqual(preview(), middle, "(c) back on the middle cell");
    undo();
    assertEqual(preview(), runEnd, "(c) Undo skips the empty run and undoes the click before it");
    assertEqual(get(manualOptimizer).state.pavilionRange, pavilionRange, "(c) and nothing else");
  });
});

Deno.test("a Shift rectangle re-centres the grid exactly as the same rectangle dragged with the mouse", async () => {
  // Setup: the startup stone, the mode open at 5 x 5 with 60% crown and 30% pavilion, and three
  // rectangles: 3 x 3 from (1, 1) to (3, 3) (odd, centred on a cell); 3 rows by 2 columns from
  // (1, 1) to (3, 2) (even across, centred between two columns); and 2 x 2 grown up and to the
  // left from (4, 4) to (3, 3) (even both ways, dragged backwards).
  // Test: for each, (a) grow it with Shift + arrows from its first corner and let go of Shift,
  // handing the answer to the mode; (b) afresh, drag the mouse from the same first cell to the
  // same last cell (the grid's drag is selectGridRectangle(from, to)).
  // Verifies: while Shift is held (a frame waited, as a user holding it would) the middle does not
  // change -- the mode's state and every tier are as they were before the first Shift + arrow
  // (T-0285: the plain arrows show their cell, the Shift ones do not); then, once Shift is let go,
  // the grid's new centre, ranges and subdivisions, the cell shown and every tier are identical to
  // the mouse's, bit for bit, including for the even-sized rectangles whose middle falls between
  // cells.
  const shift = { shiftKey: true };
  const cases = [
    { from: { row: 1, column: 1 }, to: { row: 3, column: 3 }, keys: ["ArrowDown", "ArrowDown", "ArrowRight", "ArrowRight"] },
    { from: { row: 1, column: 1 }, to: { row: 3, column: 2 }, keys: ["ArrowRight", "ArrowDown", "ArrowDown"] },
    { from: { row: 4, column: 4 }, to: { row: 3, column: 3 }, keys: ["ArrowUp", "ArrowLeft"] },
  ];

  for (const { from, to, keys: arrows } of cases) {
    const keyboard = await after(5, async design => {
      const before = { state: get(manualOptimizer).state, tiers: tiers(design) };
      const grown = press(initialKeys(from, 5), arrows.map(key => down(key, shift)), 5);

      grown.answers.forEach(answer => perform(answer.action));
      await nextFrame();
      assertEqual(get(manualOptimizer).state, before.state, `${JSON.stringify([from, to])}: nothing changes while Shift is held`);
      assertEqual(tiers(design), before.tiers, `${JSON.stringify([from, to])}: the stone in the middle stays`);

      const release = gridKey(grown.keys, up("Shift"), 5);

      assertEqual(release.action, { kind: "rectangle", from, to }, `the keys give ${JSON.stringify([from, to])}`);
      perform(release.action);
    });
    const mouse = await after(5, () => selectGridRectangle(from, to));

    assertEqual(keyboard.state, mouse.state, `${JSON.stringify([from, to])}: the same grid`);
    assertEqual(keyboard.selected, mouse.selected, `${JSON.stringify([from, to])}: the same cell shown`);
    assertEqual(keyboard.tiers, mouse.tiers, `${JSON.stringify([from, to])}: the same stone`);
  }
});
