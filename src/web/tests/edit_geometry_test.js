/*
 * edit_geometry_test.js -- tests for web/src/lib/edit_geometry.js, the geometry of edit mode's
 * guide (T-0193): which facet edit mode starts on, which design facet a clicked mesh facet is,
 * and the cutting plane drawn over the stone.
 *
 * The protractor these also used to cover (an arc, ticks, labels, a reading line and a written
 * angle above the plane) was removed on 2026-09-19 at the user's request; the test that measured
 * it went with it, and "the guide is the cutting plane and nothing else" took its place.
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * Drawing the guides over the canvas (projecting them through GemApp::project_file_points) is
 * checked against the built page over CDP instead, since it needs the wasm module.
 */

import {
  startingFacet, designFacetForNormal, editGuides, shownFacets, cutAwayFacets,
} from "../src/lib/edit_geometry.js";

// The GemCad scripts, loaded as the page loads them: classic scripts publishing globals.
const SCRIPTS = new URL("../../js/", import.meta.url);
const SAMPLES = new URL("../../../reference/gemcad-file-reader/Samples/", import.meta.url);

for (const name of ["gemcad.js", "gemcad_obj.js", "design.js", "design_mesh.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(name, SCRIPTS)));
}

const { GemCad, GemCadDesign } = globalThis;

/*
 * reference/ is third-party data -- the vendored GemCad sample designs among it -- several
 * hundred megabytes of it, deliberately gitignored, so a fresh clone of this repository has none
 * of it and the suite still has to be green there. Every test below that reads SRB.asc is marked
 * `{ ignore: !SAMPLES_PRESENT }`, so it reports as ignored on a clean checkout rather than
 * erroring on a missing file; with the data present all of them run exactly as before.
 */
const SAMPLES_PRESENT = (() => {
  try {
    Deno.statSync(SAMPLES);
    return true;
  } catch {
    return false;
  }
})();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

function assertClose(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} +/- ${tolerance}, got ${actual}`);
}

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const minus = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const length = a => Math.hypot(a.x, a.y, a.z);

/** SRB.asc, a standard round brilliant: pavilion, girdle, crown and table tiers. */
async function srb() {
  const bytes = await Deno.readFile(new URL("SRB.asc", SAMPLES));
  return GemCadDesign.fromGemCad(GemCad.importBytes(bytes), { name: "SRB.asc" });
}

/** Every corner of the stone the design builds, in the design's frame. */
function stoneCorners(design) {
  return DesignMesh.buildFaces(design).faces.flatMap(face => face.polygon);
}

Deno.test("edit mode starts on the tier's lowest index", () => {
  // Setup: a tier whose facets were written out of order, and one where two share the lowest.
  // Test: startingFacet.
  // Verifies: the facet with the smallest index is chosen whatever order the facets are in (the
  // same starting facet symmetryFromIndices reads the tier's teeth from), and the first of two
  // equal ones, so the choice is stable.
  const tier = { facets: [{ index: 40 }, { index: 8 }, { index: 72 }] };
  const tie = { facets: [{ index: 3, name: "first" }, { index: 3, name: "second" }] };

  assert(startingFacet(tier) === tier.facets[1], "the lowest index");
  assert(startingFacet(tie) === tie.facets[0], "the first of two equal indexes");
});

Deno.test("a clicked facet's normal names its own tier and facet", { ignore: !SAMPLES_PRESENT }, async () => {
  // Setup: SRB.asc, and for each of its facets the outward normal the design gives it (what
  // GemApp::facet_normals reports for the matching mesh facet).
  // Test: designFacetForNormal on each normal.
  // Verifies: every facet comes back as exactly its own tier and facet objects, so a double
  // click on the stone puts the cutting plane on the facet that was clicked, not merely on its
  // tier.
  const design = await srb();

  for (const tier of design.tiers) {
    for (const facet of tier.facets) {
      const found = designFacetForNormal(design, GemCadDesign.normalOf(design, tier.angle, facet.index));

      assert(found.tier === tier && found.facet === facet,
        `tier ${tier.angle} facet ${facet.index} came back as ${found.tier.angle} / ${found.facet.index}`);
    }
  }
});

Deno.test("the cutting plane lies on the facet and is as wide as the rock", { ignore: !SAMPLES_PRESENT }, async () => {
  // Setup: SRB.asc, and every tier's starting facet.
  // Test: editGuides for each.
  // Verifies:
  //   - all four corners of the plane, and its centre, lie on the facet's own plane
  //     (normal . p = the tier's distance, to 1e-9);
  //   - the centre is inside the facet's polygon on the stone (the centroid of a convex face);
  //   - the plane's two level edges are exactly as long as the rock is wide in that direction:
  //     the user's "the same width as the rock".
  const design = await srb();

  for (const tier of design.tiers) {
    const facet = startingFacet(tier);
    const guides = editGuides(design, tier, facet);
    const normal = GemCadDesign.normalOf(design, tier.angle, facet.index);
    const label = `tier at ${tier.angle}`;

    for (const point of [...guides.plane, guides.centre]) {
      assertClose(dot(normal, point), tier.distance, 1e-9, `${label}: a point off the plane`);
    }

    const across = minus(guides.plane[1], guides.plane[0]);
    const unit = { x: across.x / length(across), y: across.y / length(across), z: across.z / length(across) };
    const spans = stoneCorners(design).map(v => dot(v, unit));

    assertClose(length(across), Math.max(...spans) - Math.min(...spans), 1e-9, `${label}: plane width`);
    assertClose(length(minus(guides.plane[2], guides.plane[3])), length(across), 1e-9, `${label}: both level edges`);
    assertClose(Math.abs(dot(unit, { x: 0, y: 0, z: 1 })), 0, 1e-12, `${label}: level edges are level`);
  }
});

Deno.test("the guide is the cutting plane and nothing else", { ignore: !SAMPLES_PRESENT }, async () => {
  // Setup: SRB.asc, every tier's starting facet (pavilion, girdle, crown and table angles).
  // Test: editGuides for each, then look at what the returned object actually carries.
  // Verifies the 2026-09-19 removal, and pins it so it cannot creep back unnoticed: the user
  // asked for "everything but the cutting plane itself" to go, so none of the protractor's five
  // pieces -- the arc, its ticks, its labels, the reading line and the written angle -- may be
  // returned. Only `plane` (the four corners), `centre` (what the plane is built around, and
  // what the New-copy test below checks), `normal` and `width` remain.
  //
  // Checked by the object's own keys rather than by drawing, because EditOverlay.svelte projects
  // whatever it is handed: a field that came back would be a field somebody could paint, and it
  // would also go back into the per-frame projection this removal shrank to four points.
  const design = await srb();
  const gone = ["arc", "ticks", "labels", "line", "reading"];

  for (const tier of design.tiers) {
    const guides = editGuides(design, tier, startingFacet(tier));
    const label = `tier at ${tier.angle}`;

    assert(guides.plane.length === 4, `${label}: the plane is four corners`);

    for (const field of gone) {
      assert(!(field in guides), `${label}: the protractor's ${field} came back`);
    }

    assert(Object.keys(guides).sort().join(",") === "centre,normal,plane,width",
      `${label}: unexpected fields ${Object.keys(guides).sort().join(",")}`);
  }
});

Deno.test("a tier New has just copied gets its plane on the original's facet", { ignore: !SAMPLES_PRESENT }, async () => {
  // Setup: SRB.asc with a copy of its first crown tier inserted right after it, as New does
  // (same angle, distance and indexes, new objects). The mesh builder keeps one face for the two
  // identical planes, the original's.
  // Test: editGuides for the copy's starting facet and for the original's.
  // Verifies: the copy's cutting plane is centred on the original facet's face (the same centre
  // to 1e-12), not on the fallback point nearest the rock's centre, so editing a fresh copy
  // shows the plane on the stone where that facet is cut.
  const design = await srb();
  const at = design.tiers.findIndex(tier => tier.angle > 0 && tier.angle < 90);
  const original = design.tiers[at];
  const copy = { ...original, facets: original.facets.map(facet => ({ ...facet })) };

  design.tiers.splice(at + 1, 0, copy);

  const mine = editGuides(design, copy, copy.facets.find(f => f.index === startingFacet(original).index));
  const theirs = editGuides(design, original, startingFacet(original));

  assertClose(length(minus(mine.centre, theirs.centre)), 0, 1e-12, "the copy's centre");
});

Deno.test("a cut that swallows a facet removes it, and only that cut's victims", { ignore: !SAMPLES_PRESENT }, async () => {
  // Setup: SRB.asc. Every facet of the stone is shown at first. Then the crown's main tier is
  // cut far deeper (its distance shrunk to 60% of what it was), which slices away most of what
  // lies above it; the pavilion tier is cut a whisker deeper, which cuts away nothing.
  // Test: shownFacets and cutAwayFacets before and after each edit.
  // Verifies:
  //   - before any edit nothing is cut away;
  //   - the deep cut cuts away at least one facet of ANOTHER tier, and never a facet of the tier
  //     being edited, of a preform tier, or of a hidden one;
  //   - a facet that was not on the stone to begin with (the `neverShown` set) is never named;
  //   - a cut that touches nothing names nothing.
  const design = await srb();
  const neverShown = new Set();
  const before = shownFacets(design, DesignMesh.buildFaces(design));

  for (const tier of design.tiers) {
    for (const facet of tier.facets) {
      if (!before.has(facet)) {
        neverShown.add(facet);
      }
    }
  }

  const crown = design.tiers.filter(tier => tier.angle > 0 && tier.angle < 90)
    .sort((a, b) => a.angle - b.angle)[0];

  assert(cutAwayFacets(design, crown, before, neverShown).size === 0, "nothing is cut away at first");

  const original = crown.distance;

  crown.distance = original * 0.6;

  const shown = shownFacets(design, DesignMesh.buildFaces(design));
  const gone = cutAwayFacets(design, crown, shown, neverShown);

  assert(gone.size > 0, "a deep cut removes something");

  for (const facet of gone) {
    assert(!crown.facets.includes(facet), "never the edited tier's own facet");
    assert(!neverShown.has(facet), "never a facet that was not on the stone");
  }

  // The same cut, but with the victims marked as never shown or their tiers as preform: kept.
  const preformed = new Set(design.tiers.filter(tier => tier.facets.some(f => gone.has(f))));

  preformed.forEach(tier => { tier.preform = true; });
  assert(cutAwayFacets(design, crown, shown, neverShown).size === 0, "preform tiers keep their facets");
  preformed.forEach(tier => { tier.preform = false; });

  crown.distance = original;
  assert(cutAwayFacets(design, crown, shownFacets(design, DesignMesh.buildFaces(design)), neverShown).size === 0,
    "put back, nothing is cut away");
});
