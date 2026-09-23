/*
 * edit_mode_test.js -- tests for the lock edit mode puts on the design (T-0202, 2026-09-19, the
 * user: "when im in edit mode, i dont want want to be able to change which facet im editing, just
 * lock me in the current facet", and "edit mode is only applied to one tier of facets and only
 * that tier of facets can be edited while in edit mode").
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * These drive edit_mode.js and tier_controller.js directly, with a hand-built design in place of
 * a loaded file, so the rule is checked where it is enforced rather than through the buttons and
 * double clicks that reach it. That the buttons really are greyed out and that a double click on
 * the stone really does nothing is checked against the built page over CDP instead.
 *
 * `window` is stubbed because edit mode asks the page for a redraw (`window.gemRequestRender?.()`)
 * and Deno has no such global. The statement below is written above the imports to read as a
 * prologue, but ES modules hoist their imports, so it actually runs after those modules are
 * evaluated -- which is soon enough: nothing touches `window` at import time, only inside the
 * functions the tests call.
 */

globalThis.window = globalThis.window ?? {};

import { get } from "svelte/store";
import {
  enterEditMode, exitEditMode, cancelEditMode, editing,
} from "../src/lib/edit_mode.js";
import {
  render, toolbar, tierBeingEdited, applyReorder, moveTier, editNotes,
  sectionOrder, highlightTier, setTierValue, recordTierValue,
} from "../src/lib/tier_controller.js";
import { rulerIndex, rulerSymmetry } from "../src/lib/index_ruler.js";

// The GemCad scripts, loaded as the page loads them: classic scripts publishing globals. Only
// the one test below that needs a real, multi-tier stone (rather than the hand-built
// twoTierDesign) reads them; `edit_history.js` (EditHistory) is here for the same reason it is
// in tier_controller.js -- a global, not an import -- and the tier list ops that test's real
// cut-away/restore exercises actually reach it, unlike every other test in this file.
const SCRIPTS = new URL("../../js/", import.meta.url);
const SAMPLES = new URL("../../../reference/gemcad-file-reader/Samples/", import.meta.url);

for (const name of ["edit_history.js", "gemcad.js", "gemcad_obj.js", "design.js", "design_mesh.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(name, SCRIPTS)));
}

const { GemCad, GemCadDesign } = globalThis;

/*
 * reference/ is third-party data, deliberately gitignored (see edit_geometry_test.js's own copy
 * of this comment): a fresh clone has none of it, so the one test that needs it is marked
 * `{ ignore: !SAMPLES_PRESENT }` rather than erroring on a missing file.
 */
const SAMPLES_PRESENT = (() => {
  try {
    Deno.statSync(SAMPLES);
    return true;
  } catch {
    return false;
  }
})();

async function srb() {
  const bytes = await Deno.readFile(new URL("SRB.asc", SAMPLES));

  return GemCadDesign.fromGemCad(GemCad.importBytes(bytes), { name: "SRB.asc" });
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

/**
 * A design of two pavilion tiers, each cut at two teeth half the 96-tooth gear apart (so the sub
 * bar reads them as symmetry 2, which is what lets a test move the ruler). Both in the SAME
 * section, so a reorder between them is one a drag could really perform.
 *
 * Fresh objects per test: the stores these modules keep are module-level singletons, so a test
 * that left a tier of its own behind would be seen by the next one.
 */
function twoTierDesign() {
  return {
    tiers: [
      { angle: -41, distance: 0.55, facets: [{ index: 0, name: '' }, { index: 48, name: '' }] },
      { angle: -43, distance: 0.62, facets: [{ index: 0, name: '' }, { index: 48, name: '' }] },
    ],
  };
}

/** Loads `design` into the tier controller and leaves nothing selected, as a fresh load does. */
function load(design) {
  render(design, null);
  return design;
}

/** Ends any open session and empties the controller, so the next test starts clean. */
function clear() {
  exitEditMode();
  render(null, null);
}

/** Lets the sub bar's budgeted write run: it queues the tier's new teeth in a macrotask. */
function letTheWriteLand() {
  return new Promise(resolve => setTimeout(resolve, 40));
}

Deno.test("a second tier cannot take edit mode over from the first", () => {
  // Setup: two tiers, edit mode open on the first.
  // Test: ask for edit mode on the second -- what a double click on its row, or on one of its
  // facets on the stone, does -- and then on the first again.
  // Verifies: both are refused and the session is untouched. This is the whole of the rule: all
  // four ways into edit mode (the two double clicks, the Edit button, New) call enterEditMode,
  // which used to finish the open session and start another, carrying the sub bar and the
  // cutting plane onto whatever had just been clicked.
  const design = load(twoTierDesign());
  const [first, second] = design.tiers;

  assertEqual(enterEditMode(first), true, "edit mode opened on the first tier");

  assertEqual(enterEditMode(second), false, "the second tier was refused");
  assertEqual(get(editing).tier === first, true, "the first tier is still the one being edited");

  // Re-entering on the tier already open is refused too, rather than quietly committing the
  // session so far and starting another one on the same tier.
  assertEqual(enterEditMode(first), false, "re-entering on the same tier was refused");

  clear();
});

Deno.test("New and Edit are inactive while a tier is being edited, and say why", () => {
  // Setup: a tier selected, with edit mode off, so both buttons start active.
  // Test: enter edit mode, read the toolbar, then leave with Done.
  // Verifies: New goes inactive while editing (the user, asked what it should do then: "do
  // nothing while editing") and so does Edit, which could only mean the tier already open; both
  // tooltips say what to do about it, since an inactive button keeps its tooltip (it is
  // aria-disabled, not disabled); and both come back the moment the session ends -- Done does not
  // redraw the rows, so the toolbar is brought up to date from the session itself.
  const design = load(twoTierDesign());
  const [first] = design.tiers;

  highlightTier(first);
  assertEqual([get(toolbar).new.active, get(toolbar).edit.active], [true, true],
    "both buttons start active with a tier selected");

  enterEditMode(first);

  assertEqual([get(toolbar).new.active, get(toolbar).edit.active], [false, false],
    "both are inactive while editing");
  assertEqual(get(toolbar).new.tip.includes('Finish editing this tier first'), true,
    `New's tooltip says why: ${get(toolbar).new.tip}`);
  assertEqual(get(toolbar).edit.tip.includes('Finish editing this tier first'), true,
    `Edit's tooltip says why: ${get(toolbar).edit.tip}`);

  // The buttons that act on the tier BEING edited are untouched: it is the one thing that can
  // still be changed.
  assertEqual([get(toolbar).delete.active, get(toolbar).visibility.active], [true, true],
    "Delete and Show/Hide still act on the tier being edited");

  exitEditMode();
  assertEqual([get(toolbar).new.active, get(toolbar).edit.active], [true, true],
    "both are active again once editing is done");

  clear();
});

Deno.test("no tier can be reordered while one is being edited", () => {
  // Setup: two pavilion tiers, the first being edited.
  // Test: reorder the section (a row dragged past the other) and move a row with Alt+Arrow, the
  // keyboard equivalent, including on the tier being edited itself.
  // Verifies: the order does not change. A reorder is a change to tiers the open session is not
  // about -- it decides which is cut first -- and edit mode is applied to one tier alone.
  const design = load(twoTierDesign());
  const [first, second] = design.tiers;

  enterEditMode(first);

  applyReorder('pavilion', [second, first]);
  assertEqual(sectionOrder('pavilion').map(tier => tier.angle), [-41, -43],
    "a drag-reorder was refused");

  moveTier(first, 1);
  assertEqual(sectionOrder('pavilion').map(tier => tier.angle), [-41, -43],
    "Alt+ArrowDown on the tier being edited was refused");

  moveTier(second, -1);
  assertEqual(sectionOrder('pavilion').map(tier => tier.angle), [-41, -43],
    "Alt+ArrowUp on the other tier was refused");

  clear();
});

Deno.test("only the tier being edited can have its description changed", () => {
  // Setup: two tiers, the first being edited.
  // Test: write a description onto each.
  // Verifies: the tier being edited takes it and the other one does not. Nothing on the page
  // reaches the second case today -- a row's editor only opens on the selected row, and the
  // selection is pinned to the tier being edited -- but the rule holds at the controller, which
  // is where every other "only that tier" check lives.
  const design = load(twoTierDesign());
  const [first, second] = design.tiers;

  enterEditMode(first);

  editNotes(first, 'cut to the girdle');
  editNotes(second, 'meetpoints at P1');

  assertEqual(first.cuttingInstructions, 'cut to the girdle', "the edited tier took its description");
  assertEqual(second.cuttingInstructions, undefined, "the other tier was left alone");

  clear();
});

Deno.test("the tier being edited is what the rest of the page is told is being edited", () => {
  // Setup: no session, then one on the first tier, then none again.
  // Test: read `tierBeingEdited`, the controller's own view of the session.
  // Verifies: it follows the session exactly. This is the reading every check above shares --
  // the toolbar's, the reorder's, the description's, and the stone double click's in viewport.js
  // -- so if it were ever stale, all of them would be too. It is registered by edit_mode.js
  // rather than imported, because the controller cannot import edit mode: edit mode imports it.
  const design = load(twoTierDesign());
  const [first] = design.tiers;

  assertEqual(tierBeingEdited(), null, "nothing is being edited to begin with");

  enterEditMode(first);
  assertEqual(tierBeingEdited() === first, true, "the open session's tier is reported");

  exitEditMode();
  assertEqual(tierBeingEdited(), null, "and nothing once it is done");

  clear();
});

Deno.test("the cutting plane stays on the facet the session opened on when the ruler moves", async () => {
  // Setup: edit mode opened on the tier's SECOND facet -- what a double click on that facet of
  // the stone does -- with the ruler sitting on the first (index 0, the tier's lowest tooth).
  // Test: move the ruler to tooth 6, as a drag of the tape does, and let the budgeted write land.
  // Verifies: the tier is recut (0-48 becomes 6-54) but the plane is still on the same facet
  // OBJECT, which is now cut at 54. Before this, the plane moved to whichever tooth the ruler was
  // on, so it slid from facet to facet round the stone as the tape was dragged -- the user: "just
  // lock me in the current facet".
  const design = load(twoTierDesign());
  const [tier] = design.tiers;
  const opened = tier.facets[1];

  enterEditMode(tier, opened);
  assertEqual(get(editing).facet === opened, true, "the plane opened on the clicked facet");

  rulerIndex.set(6);
  await letTheWriteLand();

  assertEqual(tier.facets.map(facet => facet.index), [6, 54], "the tier was recut by the ruler");
  assertEqual(get(editing).facet === opened, true, "the plane is on the same facet as before");
  assertEqual(get(editing).facet.index, 54, "which the ruler carried to its new tooth");

  clear();
  rulerIndex.set(0);
});

Deno.test("cutting the tier at fewer teeth moves the plane but does not end the session", async () => {
  // Setup: edit mode opened on the tier's second facet again, the tier cut at two teeth.
  // Test: drop the symmetry to 1, so the tier is cut at one tooth and the second facet is gone.
  // Verifies: edit mode is STILL ON, on the same tier, with the plane moved to the tier's
  // remaining facet. Edit mode is about its tier: only the tier going away ends it. This closed
  // the session outright before T-0202 -- mid-drag, if the tape was what shrank the tier.
  const design = load(twoTierDesign());
  const [tier] = design.tiers;

  enterEditMode(tier, tier.facets[1]);

  rulerSymmetry.set(1);
  await letTheWriteLand();

  assertEqual(tier.facets.length, 1, "the tier is cut at one tooth now");
  assertEqual(get(editing) !== null, true, "edit mode is still on");
  assertEqual(get(editing).tier === tier, true, "on the same tier");
  assertEqual(get(editing).facet === tier.facets[0], true, "with the plane on the facet left");

  clear();
  rulerSymmetry.set(1);
  rulerIndex.set(0);
});

Deno.test("leaving edit mode still works both ways, and lets another tier be edited", () => {
  // Setup: the first tier being edited.
  // Test: leave with Done and open the second tier; then leave that one with Cancel and open the
  // first again.
  // Verifies: the lock is only ever as long as a session. Done and Cancel both really end one --
  // the point being that a refusal above is never a session that cannot be got out of.
  const design = load(twoTierDesign());
  const [first, second] = design.tiers;

  enterEditMode(first);
  exitEditMode();
  assertEqual(get(editing), null, "Done ended the session");
  assertEqual(enterEditMode(second), true, "the second tier can be edited once the first is done");

  cancelEditMode();
  assertEqual(get(editing), null, "Cancel ended the session");
  assertEqual(enterEditMode(first), true, "and the first can be edited again");

  clear();
});

Deno.test(
  "a facet a plane no longer swallows comes back while still in edit mode",
  { ignore: !SAMPLES_PRESENT },
  async () => {
    // Setup: SRB.asc's real, multi-tier stone (the hand-built twoTierDesign is only two facets
    // each and never actually swallows one another, so this needs a real one, as
    // edit_geometry_test.js's own cut-away test does) -- loaded into the tier controller the way
    // enterEditMode expects a design to arrive. The crown's main tier, cut to 60% of its own
    // distance, is the exact case edit_geometry_test.js already proves cuts away at least one
    // facet of another tier.
    //
    // Test: enter edit mode on that tier, cut it deep with the depth slider -- `setTierValue` then
    // `recordTierValue` on release, exactly what EditPanel.svelte calls on a settled drag -- then
    // put the slider back to the tier's ORIGINAL distance the same way, all inside the one
    // session (no Done, no Cancel in between).
    //
    // Verifies: the deep cut really does remove at least one facet from some other tier (so the
    // second half of the test is not vacuous); and putting the slider back, still inside the
    // session, restores every design's tier to its exact original facets -- the very same facet
    // OBJECTS, in their original order -- rather than leaving the swallowed ones gone until Done
    // or Cancel. Before this test's fix, `cutAwayBy` filtered `tier.facets` down on every settle
    // and never grew it back, so a facet once swallowed stayed gone even after the plane moved
    // clear of it, and only a full session Cancel (not just moving the slider back) ever brought
    // it back (2026-09-22, the user: "I only want these changes temporary until edit mode commits
    // them so if I move f1 away from f2, f2 should come back, even while in edit mode").
    const design = await srb();

    render(design, null);

    const crown = design.tiers.filter(tier => tier.angle > 0 && tier.angle < 90)
      .sort((a, b) => a.angle - b.angle)[0];
    const original = crown.distance;
    const pristine = new Map(design.tiers.map(tier => [tier, tier.facets.slice()]));

    assertEqual(enterEditMode(crown), true, "edit mode opened on the crown's main tier");

    setTierValue(crown, 'distance', original * 0.6);
    recordTierValue(crown, 'distance', original, original * 0.6, 'Edit depth');

    const shrunkSomewhere = [...pristine]
      .some(([tier, facets]) => tier.facets.length < facets.length);

    assertEqual(shrunkSomewhere, true, "the deep cut removed at least one facet from some tier");

    setTierValue(crown, 'distance', original);
    recordTierValue(crown, 'distance', original * 0.6, original, 'Edit depth');

    for (const [tier, facets] of pristine) {
      assertEqual(tier.facets.length, facets.length,
        `${tier === crown ? "the edited tier's" : "a tier's"} facet count is back to what it was`);
      assertEqual(tier.facets.every((facet, at) => facet === facets[at]), true,
        "the very same facet objects, in their original order -- not fresh copies");
    }

    cancelEditMode();
    clear();
  },
);
