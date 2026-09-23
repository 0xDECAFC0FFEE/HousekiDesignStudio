/*
 * frosted_facets_test.js -- tests for the frosted facet mask the page sends the renderer (T-0183).
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * A frosted tier (the tier toolbar's Frosted toggle, T-0180) is drawn by the Monte Carlo renderer
 * as rough glass on its facets. The page's half of that is telling Rust WHICH mesh facets those
 * are, with `app.set_frosted_facets(Uint32Array)`, and keeping that list right whenever it can go
 * stale: a design load, a rebuild of the stone (which renumbers every facet), the Frosted toggle
 * and its undo and redo, and every other toolbar edit.
 *
 * These tests drive the page's real modules (session.js's load tail and edit history,
 * tier_controller.js's toolbar, selection.js's rebuild) against a FAKE GemApp that records every
 * `set_frosted_facets` call. The fake's mesh is real, though: `load_obj` is given the OBJ text
 * DesignMesh builds from the design, exactly as on the page, and works out one outward normal per
 * OBJ face, which is what Rust's `facet_normals` returns (one facet per face, in the file's own
 * frame). So the facet <-> tier map the page builds against it is the map it builds in the
 * browser, and the facet ids the tests expect come from that map rather than being typed in.
 *
 * The design is the startup stone, src/resources/hex_cut_v2.gcs, read by the page's own reader
 * (objTextFromBytes), so this runs on a fresh clone with no reference/ data.
 *
 * Globals the modules expect:
 * - `window`: the page asks for redraws through `window.gemRequestRender?.()`; it is replaced by
 *   a counter, so a test can check a mask change is followed by a redraw request.
 * - `setTimeout`: the render loop (viewport.js) schedules its passes as timers, and there is no
 *   canvas here to draw into. Timers are swallowed, so no pass ever runs and none is left pending
 *   when a test ends. Nothing these tests call needs a timer to fire.
 * - The GemCad scripts, which the page loads as classic scripts publishing globals: read and
 *   evaluated here in the page's own order (make_page.py's GEMCAD_SCRIPTS).
 */

globalThis.window = globalThis.window ?? {};
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

for (const name of ["gemcad.js", "gemcad_obj.js", "design.js", "gcs.js", "design_mesh.js", "edit_history.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${name}`, import.meta.url)));
}

const { GemCadDesign, DesignMesh } = globalThis;

// Imported after the scripts above, dynamically, so the order reads as it runs.
const { get } = await import("svelte/store");
const { objTextFromBytes } = await import("../src/lib/design_load.js");
const { installLoadedDesign, startSession, undo, redo } = await import("../src/lib/session.js");
const { frostedFacetIds, rebuildStoneFromDesign } = await import("../src/lib/selection.js");
const { getFacetTierMap } = await import("../src/lib/facet_map.js");
const tiers = await import("../src/lib/tier_controller.js");

const STARTUP_URL = new URL("../../resources/hex_cut_v2.gcs", import.meta.url);

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

/** One outward unit normal per face of OBJ text, by Newell's method over the face's corners. */
function faceNormals(text) {
  const vertices = [];
  const normals = [];

  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);

    if (parts[0] === "v") {
      vertices.push(parts.slice(1, 4).map(Number));
    } else if (parts[0] === "f") {
      const corners = parts.slice(1).map(part => vertices[parseInt(part.split("/")[0], 10) - 1]);
      let [x, y, z] = [0, 0, 0];

      corners.forEach((a, at) => {
        const b = corners[(at + 1) % corners.length];

        x += (a[1] - b[1]) * (a[2] + b[2]);
        y += (a[2] - b[2]) * (a[0] + b[0]);
        z += (a[0] - b[0]) * (a[1] + b[1]);
      });

      const length = Math.hypot(x, y, z);

      normals.push(x / length, y / length, z / length);
    }
  }

  return new Float32Array(normals);
}

/**
 * A stand-in for GemApp with just what the load, rebuild, highlight and frosted paths call.
 * `frosted` holds every `set_frosted_facets` call, as a plain array of ids, in order.
 */
function fakeApp() {
  const app = {
    normals: new Float32Array(0),
    frosted: [],
    highlighted: [],
    load_obj(text) {
      app.normals = faceNormals(text);
      app.highlighted = [];
    },
    facet_count: () => app.normals.length / 3,
    facet_normals: () => app.normals,
    set_highlighted_facets(ids) {
      app.highlighted = Array.from(ids);
    },
    set_highlighted_facet(id) {
      app.highlighted = id < 0 ? [] : [id];
    },
    set_frosted_facets(ids) {
      if (!(ids instanceof Uint32Array)) {
        throw new Error("set_frosted_facets takes a Uint32Array");
      }

      app.frosted.push(Array.from(ids));
    },
  };

  return app;
}

/** The mask most recently sent, or undefined when none has been. */
function lastMask(app) {
  return app.frosted[app.frosted.length - 1];
}

/** The facet ids the CURRENT facet <-> tier map gives `tier`, sorted; [] for none. */
function facetsOf(tier) {
  return [...(getFacetTierMap()?.tierToFacets.get(tier) ?? [])].sort((a, b) => a - b);
}

/** Reads the startup stone as the page does: `{ text, design, gear, ... }`. */
async function startupStone() {
  return objTextFromBytes("hex_cut_v2.gcs", await Deno.readFile(STARTUP_URL));
}

/**
 * Loads `stone` into `app` the way the page does after a file opens: the mesh into the app, then
 * session.js's shared load tail. A stone with `design: null` is a plain .obj.
 */
function install(app, stone) {
  app.load_obj(stone.text);
  installLoadedDesign(app, { text: stone.text, design: stone.design, gear: stone.gear, title: "test" });
}

/**
 * A fresh session on a fresh fake app with the startup stone loaded: the history and the stone
 * hooks are session.js's own (startSession), so the toolbar reaches the fake app exactly as it
 * reaches GemApp on the page. startSession's skybox decode fails here (there is no inlined image)
 * and says so in the error store, which nothing here reads.
 */
async function session() {
  const app = fakeApp();

  startSession(app);
  install(app, await startupStone());

  return app;
}

/**
 * Selects `tier` in the pane, as a row click does, so the toolbar acts on it.
 *
 * Called before EVERY toolbar action, not once: no Svelte component is mounted here, so no row
 * ever registers itself, and the tier controller's re-render after an edit drops a selection
 * whose row it cannot find (as it should for a deleted tier). On the page the row exists and the
 * selection survives; here the test simply selects again.
 */
function select(tier) {
  tiers.highlightTier(tier);
}

// ---------------------------------------------------------------------------

Deno.test("the mask is the facets of the frosted tiers only, and a stale hidden tier adds none", () => {
  // Setup: a hand-built facet <-> tier map of three tiers: one frosted, one not, and one frosted
  // AND hidden that is still in the map (the map is only ever built after a hide rebuilds the
  // stone, so this is the belt to that pair of braces).
  // Test: frostedFacetIds on it, and on no map at all.
  // Verifies: only the frosted tier's facets are in the mask, in increasing order; a hidden tier
  // contributes nothing even when the map still lists it; and no map (a plain .obj) is an empty
  // mask rather than an error.
  const frosted = { frosted: true };
  const plain = { frosted: false };
  const hiddenFrosted = { frosted: true, hidden: true };
  const map = {
    tierToFacets: new Map([[plain, [0, 1]], [frosted, [7, 2, 5]], [hiddenFrosted, [3, 4]]]),
  };

  assertEqual(frostedFacetIds(map), [2, 5, 7], "the frosted tier's facets, sorted");
  assertEqual(frostedFacetIds(null), [], "no map, no frosted facets");
});

Deno.test("a design load sends the mask for the tiers the design has frosted", async () => {
  // Setup: the startup stone, with its second tier marked frosted before it is loaded -- what a
  // .gcs with frosting, or a link restored from the URL hash, arrives with. The hash path is
  // taken literally: the design goes through GemCadDesign.toJSON and fromJSON, as share_state.js
  // stores and restores it, and is then built into a mesh by DesignMesh, as restoreFromHash does.
  // Test: load it through session.js's load tail.
  // Verifies: the flag survives the hash's JSON, and the load sends exactly that tier's facets
  // (as the map just built gives them) and asks for a redraw -- so a restored design is frosted
  // from its first frame, without anyone touching the toggle.
  const app = fakeApp();
  const stone = await startupStone();

  stone.design.tiers[1].frosted = true;

  const restored = GemCadDesign.fromJSON(JSON.parse(JSON.stringify(GemCadDesign.toJSON(stone.design))));
  const text = DesignMesh.toObjText(restored, { name: restored.name });
  let redraws = 0;

  window.gemRequestRender = () => { redraws += 1; };
  install(app, { text, design: restored, gear: restored.gear.teeth });
  window.gemRequestRender = undefined;

  const tier = restored.tiers[1];

  assertEqual(tier.frosted, true, "the flag survived the hash's JSON");
  assertEqual(facetsOf(tier).length > 0, true, "the frosted tier has facets on the stone");
  assertEqual(lastMask(app), facetsOf(tier), "the load sent that tier's facets");
  assertEqual(redraws > 0, true, "and asked for a redraw");
});

Deno.test("a hidden frosted tier contributes nothing, and a plain .obj clears the mask", async () => {
  // Setup: the startup stone with one tier both frosted and hidden, loaded; then a plain .obj
  // (the same mesh text with no design, which is all a .obj is to the page) loaded over it.
  // Test: read the mask after each load.
  // Verifies: a hidden tier is not on the stone, so it has no facets to frost and the mask is
  // empty; and a load with no design sends an empty mask, clearing whatever the previous stone
  // had, rather than leaving the old ids to land on the new mesh's facets.
  const app = fakeApp();
  const stone = await startupStone();

  stone.design.tiers[1].frosted = true;
  stone.design.tiers[1].hidden = true;
  stone.text = DesignMesh.toObjText(stone.design, { name: stone.design.name });
  install(app, stone);
  assertEqual(lastMask(app), [], "a hidden frosted tier frosts nothing");

  // Now a design that does frost something, so clearing it is visible.
  stone.design.tiers[1].hidden = false;
  stone.text = DesignMesh.toObjText(stone.design, { name: stone.design.name });
  install(app, stone);
  assertEqual(lastMask(app).length > 0, true, "the shown frosted tier is frosted");

  install(app, { text: stone.text, design: null, gear: null });
  assertEqual(getFacetTierMap(), null, "a plain .obj has no facet <-> tier map");
  assertEqual(lastMask(app), [], "and its load cleared the mask");
});

Deno.test("the Frosted toggle sends the mask, and its undo and redo send it again", async () => {
  // Setup: a session on the startup stone, nothing frosted, and its first tier selected.
  // Test: press Frosted through the toolbar's own action, then Edit > Undo, then Edit > Redo,
  // reading the mask after each.
  // Verifies: the toggle alone (which never rebuilds the stone) sends that tier's facets and asks
  // for a redraw; undo sends an empty mask, since nothing is frosted any more; redo sends the
  // tier's facets again. The facet ids are the SAME map's throughout, since none of the three
  // rebuilds the stone.
  const app = await session();
  const tier = tiers.getDesign().tiers[0];
  let redraws = 0;

  assertEqual(lastMask(app), [], "nothing is frosted on load");

  select(tier);
  window.gemRequestRender = () => { redraws += 1; };
  tiers.toolbarActions.frosted();

  assertEqual(tier.frosted, true, "the toggle marked the tier");
  assertEqual(facetsOf(tier).length > 0, true, "the tier has facets on the stone");
  assertEqual(lastMask(app), facetsOf(tier), "the toggle sent the tier's facets");
  assertEqual(redraws > 0, true, "and asked for a redraw");

  undo();
  assertEqual(tier.frosted, false, "undo unmarked it");
  assertEqual(lastMask(app), [], "undo sent an empty mask");

  redo();
  assertEqual(tier.frosted, true, "redo marked it again");
  assertEqual(lastMask(app), facetsOf(tier), "redo sent the tier's facets again");

  window.gemRequestRender = undefined;
});

Deno.test("hiding, showing and deleting a frosted tier keep the mask in step with the stone", async () => {
  // Setup: a session on the startup stone with its first tier frosted (by the toggle) and
  // another, second tier frosted too, so the mask never goes empty by accident.
  // Test: Hide the first tier, Show it again, then Delete it, and undo the Delete; each of these
  // rebuilds the stone, which numbers its facets afresh.
  // Verifies: after each step the mask is exactly the frosted tiers' facets under the map built
  // for the NEW mesh -- a hidden or deleted frosted tier drops out, a shown or restored one
  // comes back -- so no step leaves ids from the previous mesh behind.
  const app = await session();
  const [first, second] = tiers.getDesign().tiers;
  const expected = () => [...facetsOf(first), ...facetsOf(second)].sort((a, b) => a - b);

  select(second);
  tiers.toolbarActions.frosted();
  select(first);
  tiers.toolbarActions.frosted();
  assertEqual(lastMask(app), expected(), "both tiers frosted");

  select(first);
  tiers.toolbarActions.visibility();
  assertEqual(first.hidden, true, "the first tier is hidden");
  assertEqual(facetsOf(first), [], "and has no facets on the stone");
  assertEqual(lastMask(app), facetsOf(second), "only the shown frosted tier is in the mask");

  select(first);
  tiers.toolbarActions.visibility();
  assertEqual(first.hidden, false, "shown again");
  assertEqual(lastMask(app), expected(), "both frosted tiers are in the mask again");

  select(first);
  tiers.toolbarActions.delete();
  assertEqual(tiers.getDesign().tiers.includes(first), false, "the first tier is deleted");
  assertEqual(lastMask(app), facetsOf(second), "the deleted tier left the mask");

  undo();
  assertEqual(tiers.getDesign().tiers.includes(first), true, "undo brought it back");
  assertEqual(lastMask(app), expected(), "and its facets are frosted again");
});

Deno.test("a quick rebuild mid-drag keeps the frosted facets on the new mesh", async () => {
  // Setup: a session on the startup stone with its first tier frosted.
  // Test: move the tier's angle with a QUICK rebuild (a slider mid-drag, which skips rebuilding
  // the facet <-> tier map), then settle it with a full one at the same angle.
  // Verifies: the quick rebuild still sends a mask -- found from the facets' normals, since the
  // map is stale then -- and it is the very mask the full rebuild's fresh map gives, so the
  // frosting follows the stone while it is being dragged, not only when the drag ends.
  const app = await session();
  const tier = tiers.getDesign().tiers[0];

  select(tier);
  tiers.toolbarActions.frosted();

  const sent = app.frosted.length;

  tiers.setTierValue(tier, "angle", tier.angle + 0.5, { quick: true });
  assertEqual(app.frosted.length > sent, true, "the quick rebuild sent a mask");

  const quick = lastMask(app);

  // A full rebuild of the same design: setTierValue does nothing for an unchanged value, so the
  // rebuild is asked for directly, as the end of a drag does.
  rebuildStoneFromDesign(app);
  assertEqual(facetsOf(tier).length > 0, true, "the tier is still on the stone");
  assertEqual(quick, facetsOf(tier), "the quick mask is the full rebuild's mask");
  assertEqual(lastMask(app), facetsOf(tier), "and the full rebuild sent it too");
});

Deno.test("the Frosted tooltip says how the render models a frosted facet", async () => {
  // Setup: a session on the startup stone, with a tier selected so the button is active.
  // Test: read the Frosted button's tooltip from the toolbar store.
  // Verifies: the user's requirement (2026-09-23) that the tip say the facets are modelled as a
  // rough dielectric surface with single scattering, and that it still says what the list shows,
  // which renderer shows it, and how to unmark a tier.
  await session();
  select(tiers.getDesign().tiers[0]);

  const tip = get(tiers.toolbar).frosted.tip;

  for (const phrase of [
    "rough dielectric surface", "single scattering", "Monte Carlo renderer", "darker background",
    "Click again to unmark it.",
  ]) {
    assertEqual(tip.includes(phrase), true, `the tip mentions "${phrase}"`);
  }
});
