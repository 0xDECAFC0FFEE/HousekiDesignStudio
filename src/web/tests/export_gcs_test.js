/*
 * export_gcs_test.js -- tests for web/src/lib/export_gcs.js, the Gem Cut Studio .gcs WRITER.
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The property that matters is a ROUND TRIP, as for export_asc_test.js: read a real .gcs the way
 * the page does (GemCutStudio.importText -> GemCadDesign.fromGemCad), write that design with
 * designToGcs, read the text the writer produced the same way, and check that the designs agree
 * and that the CORNERS written are the corners the original file carried. The corners are the
 * new part relative to the .asc writer: a .gcs stores geometry, and the writer rebuilds it from
 * the design's planes (DesignMesh.buildFaces), so a wrong normal, a wrong winding or a mistake
 * in the index-angle conversion would each show up here.
 *
 * The libraries are classic browser scripts, published as globals, so they are loaded as
 * export_asc_test.js and gcs_test.js load theirs: read the text and eval it, in the order the
 * page's bundle runs them (make_page.py's GEMCAD_SCRIPTS).
 */

import { designToGcs, escapeXmlAttribute, gcsFilename } from "../src/lib/export_gcs.js";

for (const script of ["gemcad.js", "gemcad_obj.js", "design.js", "design_mesh.js", "gcs.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${script}`, import.meta.url)));
}

const { GemCadDesign, GemCutStudio } = globalThis;

/** Fails with `message` unless `actual` and `expected` are equal (compared as JSON). */
function assertEquals(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message || "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** Fails unless `text` contains `fragment`. */
function assertStringIncludes(text, fragment) {
  if (!text.includes(fragment)) {
    throw new Error(`expected the text to include ${JSON.stringify(fragment)}`);
  }
}

/** The startup stone, committed under src/resources, so this is present on a fresh clone. */
const STARTUP_URL = new URL("../../resources/hex_cut_v2.gcs", import.meta.url);

/** Gem Cut Studio's own designs. reference/ is gitignored, so this may not exist. */
const CORPUS_DIR = new URL("../../../reference/gemology-project-designs/", import.meta.url);

/**
 * A written corner may differ from the original file's by this much. The file's corners come
 * from Gem Cut Studio's own solver and the writer's from intersecting the design's planes; they
 * agree to about 1e-5 of a tooth on designs with meet-point tiers (kb/design-mesh-builder.md),
 * far under this.
 */
const CORNER_TOLERANCE = 1e-4;

/**
 * The most a corner may move when the writer and the original file disagree about how many
 * corners a facet has. On a design with meet-point tiers the planes are only concurrent to about
 * 1e-4, so a corner is really a cluster of corners that far apart, and Gem Cut Studio's file and
 * the writer each keep some of the tiny edges between them and merge others (measured on the
 * corpus: clusters up to 1.6e-3 across, e.g. Random_Number_Generator_M2's tier 12). Both are the
 * same polygon to the precision the design can state; a count that differs by a micro-edge is
 * not an error, a corner that moved by more than the cluster is.
 */
const MICRO_EDGE = 2e-3;

function corpusFiles() {
  try {
    return [...Deno.readDirSync(CORPUS_DIR)]
      .filter(entry => entry.name.endsWith(".gcs"))
      .map(entry => new URL(entry.name, CORPUS_DIR))
      .sort((a, b) => a.href.localeCompare(b.href));
  } catch {
    return [];
  }
}

/** Reads a .gcs into `{ parsed, design }` exactly as the page's own load path does. */
function readGcs(text, name) {
  const { parsed } = GemCutStudio.importText(text);

  return { parsed, design: GemCadDesign.fromGemCad(parsed, { name }) };
}

/**
 * How far apart two corner lists are as the same polygon: the worst distance from a corner of
 * either to the nearest corner of the other, ignoring where the loop starts and which way it
 * runs. With `sameCount`, lists of different lengths are infinitely far apart; without, they are
 * compared corner to nearest corner, which is what a meet-point tier needs (see MICRO_EDGE).
 */
function worstCornerDistance(a, b, sameCount) {
  if (sameCount && a.length !== b.length) {
    return Infinity;
  }

  let worst = 0;

  for (const [from, to] of [[a, b], [b, a]]) {
    for (const p of from) {
      const nearest = Math.min(...to.map(q => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)));

      worst = Math.max(worst, nearest);
    }
  }

  return worst;
}

/**
 * Round-trips one file. Returns the worst corner distance between the original file's facets and
 * the written ones, and what the writer left out, after checking the designs agree.
 */
function roundTrip(text, name, sameCount) {
  const original = readGcs(text, name);
  const { text: written, omittedFacets, omittedTiers } = designToGcs(original.design);
  const again = readGcs(written, name);

  // Designs: same wheel and same cut, tier by tier. (Nothing was left out, or the tier lists
  // would differ in length; callers assert that separately.)
  assertEquals(again.design.gear.teeth, original.design.gear.teeth, `${name}: gear`);
  assertEquals(again.design.gear.reversed, original.design.gear.reversed, `${name}: reversed`);
  assertEquals(again.design.tiers.length, original.design.tiers.length, `${name}: tier count`);

  let worstCorner = 0;

  original.design.tiers.forEach((tier, t) => {
    const other = again.design.tiers[t];

    assertEquals(other.angle, tier.angle, `${name}: tier ${t} angle`);
    assertEquals(other.distance, tier.distance, `${name}: tier ${t} depth`);
    assertEquals(other.cuttingInstructions, tier.cuttingInstructions, `${name}: tier ${t} notes`);
    assertEquals(other.facets.length, tier.facets.length, `${name}: tier ${t} facet count`);

    tier.facets.forEach((facet, f) => {
      // Circular: tooth 95.9999999 and tooth 0 are the same position on a 96-tooth wheel.
      const drift = Math.abs(other.facets[f].index - facet.index);

      assertEquals(
        Math.min(drift, original.design.gear.teeth - drift) < 1e-6,
        true,
        `${name}: tier ${t} facet ${f} index ${facet.index} came back as ${other.facets[f].index}`,
      );

      worstCorner = Math.max(
        worstCorner,
        worstCornerDistance(
          original.parsed.tiers[t].indices[f].points,
          again.parsed.tiers[t].indices[f].points,
          sameCount,
        ),
      );
    });
  });

  return { worstCorner, omittedFacets, omittedTiers };
}

Deno.test("designToGcs round-trips the startup stone: same design, same corners", async () => {
  // Setup: src/resources/hex_cut_v2.gcs, the page's own startup stone: ten tiers, 67 facets,
  // gear 96, with a meet-point tier and a girdle just over 90 degrees polar.
  //
  // Test: read it, write the design back out, read that, and compare (roundTrip above): the
  // gear, tier count, each tier's angle, depth and notes, each facet's index (modulo the wheel),
  // and every facet's corners against the original file's.
  //
  // Verifies: the angle conversion (polar <-> mast), the index-angle inverse (crown and
  // pavilion mirrored), the normals and the winding are all the inverse of what the reader does,
  // since any one of them wrong would move an index or a corner. Nothing is left out.
  const result = roundTrip(await Deno.readTextFile(STARTUP_URL), "hex_cut_v2", true);

  assertEquals(result.omittedFacets, 0);
  assertEquals(result.omittedTiers, 0);
  assertEquals(result.worstCorner < CORNER_TOLERANCE, true, `worst corner ${result.worstCorner}`);
});

Deno.test("designToGcs round-trips every Gem Cut Studio design it can be given", {
  ignore: corpusFiles().length === 0,
}, async () => {
  // Setup: every .gcs under reference/gemology-project-designs (29 files: round, cushion,
  // trilliant, radiant and stranger cuts). Ignored where reference/ is absent, as a fresh clone
  // has none.
  //
  // Test: roundTrip each, comparing corners to the nearest corner (MICRO_EDGE, above). A file whose design cannot be built (fromGemCad's own gate refuses
  // it) has nothing to export and is counted, not failed. One where the writer left facets out
  // is counted too, and its comparison skipped, since the tier lists then legitimately differ.
  //
  // Verifies: the writer holds across real designs, not just the one stone the conversions were
  // worked out on. At least most files must complete, so a writer that quietly skipped
  // everything could not pass.
  let compared = 0;
  let unbuildable = 0;
  let leftOut = 0;
  let worst = 0;

  for (const url of corpusFiles()) {
    const name = url.pathname.split("/").pop();
    const text = await Deno.readTextFile(url);

    try {
      readGcs(text, name);
    } catch {
      unbuildable++;
      continue;
    }

    const design = readGcs(text, name).design;

    if (designToGcs(design).omittedFacets > 0) {
      leftOut++;
      continue;
    }

    worst = Math.max(worst, roundTrip(text, name, false).worstCorner);
    compared++;
  }

  console.log(
    `  gcs export: ${compared} compared, ${unbuildable} unbuildable, ${leftOut} with facets left ` +
    `out; worst corner ${worst.toExponential(2)}`,
  );
  assertEquals(compared >= corpusFiles().length - 3, true, `only ${compared} files compared`);
  assertEquals(worst < MICRO_EDGE, true, `worst corner ${worst}`);
});

Deno.test("designToGcs on a reversed wheel writes the same stone", async () => {
  // Setup: the startup stone's design re-expressed on the same 96-tooth wheel run backwards
  // (GemCadDesign.reExpressOnGear with reversed: true). A reversed design is what a GemCad file
  // with a negative gear becomes. The geometry is unchanged; only the tooth numbers are.
  //
  // Test: write it, read it back.
  //
  // Verifies: the writer re-expresses a reversed design on a forward wheel before computing
  // index angles (the reader's arithmetic uses the unsigned step), so the file reads back at
  // the same corners instead of throwing on the reader's own index cross-check.
  const { design, parsed } = readGcs(await Deno.readTextFile(STARTUP_URL), "hex_cut_v2");
  const reversed = GemCadDesign.reExpressOnGear(design, { teeth: design.gear.teeth, reversed: true });

  assertEquals(reversed.gear.reversed, true);

  const { text } = designToGcs(reversed);
  const again = readGcs(text, "hex_cut_v2");

  assertEquals(again.design.tiers.length, design.tiers.length);
  design.tiers.forEach((tier, t) => {
    tier.facets.forEach((_, f) => {
      const drift = worstCornerDistance(
        parsed.tiers[t].indices[f].points,
        again.parsed.tiers[t].indices[f].points,
        true,
      );

      assertEquals(drift < CORNER_TOLERANCE, true, `tier ${t} facet ${f} moved ${drift}`);
    });
  });
});

Deno.test("designToGcs keeps a hidden tier, marks it not visible, and writes the header", async () => {
  // Setup: the startup stone's design with its first tier hidden, and a title, author and date
  // that need escaping in an attribute.
  //
  // Test: write it and look at the text and the tree the reader makes of it.
  //
  // Verifies: the hidden tier is still written with all its facets (a hidden tier is only
  // hidden from the render) and `visible="false"`; `<info>` carries the header fields with
  // markup characters escaped, and the reader decodes them back; the file uses CRLF.
  const { design } = readGcs(await Deno.readTextFile(STARTUP_URL), "hex_cut_v2");

  design.tiers[0].hidden = true;

  const { text } = designToGcs(design, { title: 'A "B" & <C>', author: "x", date: "2026" });
  const root = GemCutStudio.parseXml(text).children[0];
  const tiers = GemCutStudio.childrenNamed(root, "tier");

  assertEquals(tiers.length, design.tiers.length);
  assertEquals(tiers[0].attributes.visible, "false");
  assertEquals(tiers[1].attributes.visible, "true");
  assertEquals(GemCutStudio.childrenNamed(tiers[0], "facet").length, design.tiers[0].facets.length);
  assertEquals(GemCutStudio.importText(text).info.title, 'A "B" & <C>');
  assertStringIncludes(text, "&quot;B&quot; &amp; &lt;C&gt;");
  assertEquals(text.split("\r\n").length > 100 && !/[^\r]\n/.test(text), true, "CRLF throughout");
});

Deno.test("escapeXmlAttribute and gcsFilename", () => {
  // Setup: strings with the characters that break an attribute or a filename.
  // Test: escape and sanitise them.
  // Verifies: markup, tab and line breaks are escaped so the reader decodes the original back;
  // the filename drops filesystem-hostile characters and falls back when nothing is left.
  assertEquals(escapeXmlAttribute('a&b<c>"d"\n\t'), "a&amp;b&lt;c&gt;&quot;d&quot;&#10;&#9;");
  assertEquals(gcsFilename("Round: 1/2"), "Round 12.gcs");
  assertEquals(gcsFilename("  "), "stone.gcs");
});
