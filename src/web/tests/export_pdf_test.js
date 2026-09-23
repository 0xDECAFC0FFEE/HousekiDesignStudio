/*
 * export_pdf_test.js -- tests for web/src/lib/export_pdf.js (File > Export > PDF, the printed
 * cutting sheet) and web/src/lib/pdf_writer.js (the small PDF writer it draws with).
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * THE ORACLE is the GemCad print the user supplied as the example,
 * reference/application_images/hex_cut_v2/gem_print.pdf. reference/ is gitignored, so the
 * numbers printed on it are copied into this file (HEX_CUT_V2_SHEET) and checked against the
 * sheet built from the startup stone, src/resources/hex_cut_v2.gcs, which is the same design and
 * is committed. Every number there is GemCad's own, not one this code produced and then wrote
 * down, so a wrong axis, a wrong volume or a wrong count shows up here.
 *
 * The writer is checked structurally: a PDF reader finds every object through the
 * cross-reference table's byte offsets, so a table that is off by one byte gives a file some
 * readers refuse. The tests parse the written bytes back and check each offset lands on its
 * object.
 *
 * The page-only wrapper (`exportPdf`, which reaches `getDesign()` and opens the Save dialog)
 * needs a live design and a DOM, and is out of scope here, as for the other exporters' tests.
 *
 * The design libraries are classic browser scripts published as globals, so they are loaded as
 * export_gcs_test.js loads them: read the text and eval it, in the page bundle's order.
 */

import {
  designToPdf, facetCounts, formatSheetIndex, frostedFacesToward, girdleFrame, pdfFilename, sheetData, sheetToPdf,
  tierIndexText, visibleEdges,
} from "../src/lib/export_pdf.js";
import { PdfDocument, textWidth, winAnsiCodes, wrapText } from "../src/lib/pdf_writer.js";

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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

/** The startup stone, committed under src/resources, so this is present on a fresh clone. */
const STARTUP_URL = new URL("../../resources/hex_cut_v2.gcs", import.meta.url);

/** Gem Cut Studio's own designs. reference/ is gitignored, so this may not exist. */
const CORPUS_DIR = new URL("../../../reference/gemology-project-designs/", import.meta.url);

/** Reads a .gcs into a design exactly as the page's own load path does. */
function readGcs(text, name) {
  const { parsed } = GemCutStudio.importText(text);

  return GemCadDesign.fromGemCad(parsed, { name });
}

/** hex_cut_v2 as the page loads it at startup. */
async function hexCutV2() {
  return readGcs(await Deno.readTextFile(STARTUP_URL), "hex_cut_v2");
}

/**
 * What GemCad printed for hex_cut_v2 (gem_print.pdf), copied by hand. The cut header's name,
 * author and date are passed in, as the page passes cutMeta's; the file's own date is August,
 * the print's September, because the user edited it in the page's header before printing.
 */
const HEX_CUT_V2_SHEET = {
  byline: "0xDECAFC0FFEE - September 2026",
  facetRows: [
    ["Pavilion facets", "18", "Pavilion tiers", "2"],
    ["Girdle facets", "6", "Girdle tiers", "1"],
    ["Crown facets", "42+1", "Crown tiers", "6+1"],
    ["Total facets", "67", "Total tiers", "10"],
  ],
  sizeRows: [
    ["L/W", "1.155", "P/W", "0.414"],
    ["T/W", "0.219", "C/W", "0.207"],
    ["U/W", "0.189", "H/W", "0.650"],
    ["V/W^3", "0.248", "P/C", "1.996"],
  ],
  // The print says "6-fold, mirror": it was made from the .gem, whose header says mirror. The
  // .gcs this test reads says mirror="0", and the sheet prints what the design says.
  designRows: [
    ["Angles for R.I.", "2.16"],
    ["Symmetry", "6-fold"],
    ["Index gear", "96"],
  ],
  sections: [
    {
      heading: "Pavilion",
      rows: [
        { id: "P1", angle: "36.6", indices: "04-12-20-28-36-44-52-60-68-76-84-92", notes: "Cut to centerpoint.", frosted: false },
        { id: "G1", angle: "90.0", indices: "96-16-32-48-64-80", notes: "Set stone size.", frosted: false },
        { id: "P2", angle: "41.5", indices: "96-16-32-48-64-80", notes: "Level girdle.", frosted: false },
      ],
    },
    {
      heading: "Crown",
      rows: [
        { id: "C1", angle: "55.1", indices: "96-16-32-48-64-80", notes: "Set girdle width.", frosted: false },
        { id: "C2", angle: "35.2", indices: "03-13-19-29-35-45-51-61-67-77-83-93", notes: "Meet G1, C1", frosted: false },
        { id: "C3", angle: "28.5", indices: "08-24-40-56-72-88", notes: "Meet G1, C1, C2", frosted: false },
        { id: "C4", angle: "24.9", indices: "96-16-32-48-64-80", notes: "Meet C1, C2", frosted: false },
        { id: "C5", angle: "28.2", indices: "08-24-40-56-72-88", notes: "Float to establish hexagons.", frosted: false },
        { id: "C6", angle: "14.9", indices: "08-24-40-56-72-88", notes: "Float to establish hexagons.", frosted: false },
        { id: "T", angle: "0.0", indices: "Table", notes: "Float to establish hexagon.", frosted: false },
      ],
    },
  ],
};

/** The options the page would pass for the print: the header as the user had it, 1 decimal. */
const PRINT_OPTIONS = { title: "hex cut v2", author: "0xDECAFC0FFEE", date: "September 2026", decimals: 1 };

// ---------------------------------------------------------------------------
// The sheet's content against GemCad's own print
// ---------------------------------------------------------------------------

Deno.test("hex_cut_v2's sheet prints the same tables and instructions as GemCad's print", async () => {
  // Setup: the startup stone, read as the page reads it, with the cut header the print had.
  const data = sheetData(await hexCutV2(), PRINT_OPTIONS);

  // The test: every table and every instruction row, field by field. The ratios are the
  // interesting part: each is a measurement of the built stone (the table's extent along one
  // axis, the crown's height, the volume...) and matches GemCad's to its three printed decimals
  // only if the axis, the section split and the arithmetic are all right.
  assertEquals(data.title, "hex cut v2", "title");
  assertEquals(data.byline, HEX_CUT_V2_SHEET.byline, "byline");
  assertEquals(data.facetRows, HEX_CUT_V2_SHEET.facetRows, "Facet Data");
  assertEquals(data.sizeRows, HEX_CUT_V2_SHEET.sizeRows, "Size Data");
  assertEquals(data.designRows, HEX_CUT_V2_SHEET.designRows, "Design Data");
  assertEquals(data.sections, HEX_CUT_V2_SHEET.sections, "instructions");
});

Deno.test("the written PDF carries the sheet's text", async () => {
  // Setup: the whole file for hex_cut_v2, decoded one byte per character.
  const bytes = designToPdf(await hexCutV2(), PRINT_OPTIONS);
  const text = String.fromCharCode(...bytes);

  // The test: a sample of the strings the page should show, each as a PDF text operator. This
  // verifies the drawing code writes what sheetData worked out (a layout bug that dropped a
  // row, say, would leave sheetData's test passing and this one failing), and that the index
  // numbers round the crown view, with tooth 0 as "<96>", are there.
  for (const fragment of [
    "(hex cut v2) Tj", "(0xDECAFC0FFEE - September 2026) Tj", "(Facet Data) Tj", "(42+1) Tj",
    "(0.248) Tj", "(Pavilion) Tj", "(Cut to centerpoint.) Tj", "(Float to establish hexagon.) Tj",
    "(<96>) Tj", "(48) Tj", "(W) Tj", "(G1) Tj",
  ]) {
    assert(text.includes(fragment), `the PDF should contain ${fragment}`);
  }

  // One page: hex_cut_v2's ten tiers fit on the first.
  assertEquals((text.match(/\/Type \/Page\b/g) || []).length, 1, "page count");
});

Deno.test("frosted tiers are shaded in the views and their teeth printed on a gray band", async () => {
  // Setup: hex_cut_v2 with its crown tier C2 frosted, as the tier toolbar's Frosted (or a .gcs
  // facet's `frosting`) marks it, and C3 marked preform. The user's example of a frosted design,
  // reference/application_images/hex_cut_v3/hex_cut_v3.pdf, fills frosted facets and a frosted
  // tier's teeth with 0.85 gray and draws everything else in black on white.
  const design = await hexCutV2();
  const byAngle = angle => design.tiers.find(tier => Math.abs(tier.angle - angle) < 0.05);
  const c2 = byAngle(35.2);
  const c3 = byAngle(28.5);

  assert(c2 && c3, "hex_cut_v2 should have crown tiers at 35.2 (C2) and 28.5 (C3) degrees");
  c2.frosted = true;
  c3.preform = true;

  const data = sheetData(design, PRINT_OPTIONS);
  const crownRows = data.sections[1].rows;
  const rowOf = id => crownRows.find(row => row.id === id);

  // The test, part 1, the instruction rows: only C2 is flagged frosted, and C3's teeth, being a
  // preform tier's, are in braces. The braces are the tier table's own mark (tierIndexText).
  assertEquals(crownRows.filter(row => row.frosted).map(row => row.id), ["C2"], "frosted rows");
  assertEquals(rowOf("C3").indices, "{08-24-40-56-72-88}", "preform teeth in braces");

  // Part 2, the drawings: seen from above, the faces to shade are C2's and every C2 facet the
  // crown view sees is among them (all twelve face up, being crown facets). Seen from below
  // none is, since C2 is on the crown; a shading that ignored which way a face points would
  // shade C2 through the pavilion.
  const shownC2 = data.shown.tiers.indexOf(c2);
  const fromAbove = frostedFacesToward(data.geometry, data.shown.tiers, { x: 0, y: 0, z: 1 });

  assert(fromAbove.length > 0, "the crown view shades C2");
  assert(fromAbove.every(face => face.tier === shownC2), "only C2's facets are shaded");
  assertEquals(new Set(fromAbove.map(face => face.facet)).size, c2.facets.length, "every C2 facet");
  assertEquals(frostedFacesToward(data.geometry, data.shown.tiers, { x: 0, y: 0, z: -1 }).length, 0,
    "nothing on the pavilion view");

  // Part 3, the file: the gray is set for the fills and put back to black before text, and
  // the unfrosted startup sheet never sets it, so an unfrosted design prints as it did before.
  const text = String.fromCharCode(...sheetToPdf(data).toBytes());
  const plain = String.fromCharCode(...designToPdf(await hexCutV2(), PRINT_OPTIONS));

  assert(text.includes("0.85 g"), "the frosted fill is 0.85 gray");
  assert(/0\.85 g[^]*\n0 g\nBT/.test(text), "text after a gray fill is black again");
  assert(!plain.includes("0.85 g"), "an unfrosted design has no gray");
});

Deno.test("the refractive index set in the app wins over the design's own", async () => {
  // Setup: hex_cut_v2, whose .gcs carries 2.16 in its <render> block, exported while the app's
  // material is set to 1.544 (quartz), as exportPdf passes GemApp's refractiveIndex parameter.
  const data = sheetData(await hexCutV2(), { ...PRINT_OPTIONS, refractiveIndex: 1.544 });

  // The test: the sheet prints the app's index (the user: "use the ri set in the app"). The
  // test above, which passes none, shows the design's 2.16 is the fallback.
  assertEquals(data.designRows[0], ["Angles for R.I.", "1.544"], "R.I.");
});

Deno.test("L is the longest girdle-plane dimension and W is square to it, however the stone is turned", async () => {
  // Setup: hex_cut_v2 turned 5 teeth round the gear (18.75 degrees), by moving the gear's
  // origin: every facet's normal turns with it (normalOf uses index - originIndex), so it is the
  // same stone, standing at an angle to the design's X and Y axes. Its longest dimension, corner
  // to corner, now runs at 18.75 degrees (or 78.75, or -41.25: a hexagon has three).
  const turned = await hexCutV2();

  turned.gear.originIndex += 5;

  const data = sheetData(turned, PRINT_OPTIONS);
  const { along } = data.measurements.frame;

  // The test: the ratios are exactly the unturned stone's, i.e. GemCad's own, because L and W
  // (and T and U with them) follow the stone's long axis, not the design's X and Y. The user's
  // rule (2026-09-23): "l is the longest dimension on the girdle plane and w is 90 degrees off
  // of the long axis". Measuring along X and Y instead would give L/W 1.1 or so here.
  assertEquals(data.sizeRows, HEX_CUT_V2_SHEET.sizeRows, "Size Data of the turned stone");

  // Of the three equally long diameters, the one turned least from X is chosen, so the drawing
  // is turned as little as it can be: 18.75 degrees one way or the other (the sign depends on
  // which way the gear counts; only the size of the turn is the rule).
  assert(Math.abs(Math.abs(Math.atan2(along.y, along.x) * 180 / Math.PI) - 18.75) < 1e-6,
    `long axis at ${Math.atan2(along.y, along.x) * 180 / Math.PI} degrees, expected 18.75`);
});

Deno.test("girdleFrame follows the outline's diameter, not the design's X axis", () => {
  // Setup: two outlines as corner lists (z does not matter). An oval-like octagon twice as long
  // in Y as in X, and a regular hexagon with corners on the X axis (hex_cut_v2's outline).
  const octagon = [[0, 2], [0.7, 1.4], [1, 0], [0.7, -1.4], [0, -2], [-0.7, -1.4], [-1, 0], [-0.7, 1.4]]
    .map(([x, y]) => ({ x, y, z: 0 }));
  const hexagon = [0, 60, 120, 180, 240, 300]
    .map(degrees => ({ x: Math.cos(degrees * Math.PI / 180), y: Math.sin(degrees * Math.PI / 180), z: 0 }));

  // The test: the octagon's long axis is Y, and W's direction is 90 degrees from it; the
  // hexagon's three corner-to-corner diameters tie, and the one along X wins, so a stone that
  // already lies across the page is not turned.
  const tall = girdleFrame(octagon);
  const hex = girdleFrame(hexagon);

  assertEquals([tall.along.x, tall.along.y], [0, 1], "octagon long axis");
  assertEquals([tall.across.x + 0, tall.across.y], [-1, 0], "octagon across");
  assertEquals([hex.along.x, Math.abs(hex.along.y) < 1e-12], [1, true], "hexagon long axis");
});

Deno.test("hidden tiers are neither listed nor counted", async () => {
  // Setup: hex_cut_v2 with its C6 hidden, as the tier toolbar's Hide does. A hidden tier is
  // left out of the stone, so the sheet must not tell a cutter to cut it.
  const design = await hexCutV2();
  const c6 = design.tiers.find(tier => Math.abs(tier.angle - 14.920558437144006) < 1e-6);

  assert(c6, "hex_cut_v2 should have a tier at 14.92 degrees (C6)");
  c6.hidden = true;

  const data = sheetData(design, PRINT_OPTIONS);

  // The test: the crown lists six rows (C1-C5 and T), and the counts drop by C6's six facets.
  assertEquals(data.sections[1].rows.map(row => row.id), ["C1", "C2", "C3", "C4", "C5", "T"], "crown rows");
  assertEquals(data.facetRows[2], ["Crown facets", "36+1", "Crown tiers", "5+1"], "crown counts");
  assertEquals(data.facetRows[3], ["Total facets", "61", "Total tiers", "9"], "totals");
});

// ---------------------------------------------------------------------------
// The small helpers
// ---------------------------------------------------------------------------

Deno.test("teeth are written two digits wide, tooth 0 as the gear size, sorted", () => {
  // Setup and test in one: tooth formatting on a 96 gear, including a tooth given past the end
  // of the wheel (wrapped round) and a fractional one (three decimals, as the tier table).
  assertEquals(formatSheetIndex(4, 96), "04", "one digit is padded");
  assertEquals(formatSheetIndex(0, 96), "96", "tooth 0 is the gear size");
  assertEquals(formatSheetIndex(96, 96), "96", "a whole turn is tooth 0");
  assertEquals(formatSheetIndex(53.5, 96), "53.500", "a fractional tooth");

  // A tier whose facets are listed out of order (as hex_cut_v2.gcs lists P1, from 52) is
  // written ascending with tooth 0 first; a preform tier's teeth are in braces.
  const facets = [52, 0, 4].map(index => ({ index }));

  assertEquals(tierIndexText({ angle: -40, facets }, 96), "96-04-52", "sorted");
  assertEquals(tierIndexText({ angle: -40, facets, preform: true }, 96), "{96-04-52}", "preform");
  assertEquals(tierIndexText({ angle: 0, facets: [{ index: 0 }] }, 96), "Table", "table");
  assertEquals(tierIndexText({ angle: 180, facets: [{ index: 0 }] }, 96), "Culet", "culet");
});

Deno.test("a flat culet is counted as the pavilion's +1, as the table is the crown's", () => {
  // Setup: tiers standing in for a design with a culet (mast angle 180), two pavilion tiers,
  // a girdle, a crown tier and a table. Only the angle and the facet count matter here.
  const tier = (angle, count) => ({ angle, facets: Array.from({ length: count }, (_, i) => ({ index: i })) });
  const counts = facetCounts([tier(180, 1), tier(-42, 8), tier(-40, 8), tier(-90, 16), tier(40, 8), tier(0, 1)]);

  // The test: the culet sits beside the pavilion's count the way the table sits beside the
  // crown's, and the totals include both.
  assertEquals([counts.pavilion.facets, counts.pavilion.extraFacets], [16, 1], "pavilion");
  assertEquals([counts.girdle.facets, counts.girdle.tiers], [16, 1], "girdle");
  assertEquals([counts.crown.facets, counts.crown.extraFacets], [8, 1], "crown");
  assertEquals([counts.totalFacets, counts.totalTiers], [42, 6], "totals");
});

Deno.test("each view draws only the edges of the facets facing it", async () => {
  // Setup: hex_cut_v2's built stone.
  const data = sheetData(await hexCutV2(), PRINT_OPTIONS);
  const { geometry } = data;
  const fromAbove = visibleEdges(geometry, { x: 0, y: 0, z: 1 });
  const fromBelow = visibleEdges(geometry, { x: 0, y: 0, z: -1 });

  // The test: from above, every edge drawn belongs to a crown facet (normal z > 0), and none of
  // them runs wholly below the girdle; from below, the pavilion's 18 facets meet at the culet
  // point, which is the lowest corner and must be drawn. A hidden-line bug (drawing every edge)
  // would show pavilion edges from above, and fail the first check.
  const lowest = Math.min(...geometry.positions.map(p => p.z));
  const girdleBottom = Math.min(...geometry.faces
    .filter(face => face.normal.z > 0.01)
    .flatMap(face => face.indices.map(i => geometry.positions[i].z)));

  for (const [a, b] of fromAbove) {
    assert(Math.max(geometry.positions[a].z, geometry.positions[b].z) >= girdleBottom - 1e-9,
      "an edge seen from above lies below the crown");
  }

  assert(fromBelow.some(([a, b]) => geometry.positions[a].z === lowest || geometry.positions[b].z === lowest),
    "the culet point is drawn from below");
  assert(fromAbove.length > 0 && fromBelow.length > 0, "both views draw something");
});

Deno.test("pdfFilename keeps the name and drops what filesystems refuse", () => {
  assertEquals(pdfFilename("hex cut v2"), "hex cut v2.pdf");
  assertEquals(pdfFilename('a/b:c*?"<>|'), "abc.pdf");
  assertEquals(pdfFilename("  "), "stone.pdf");
});

// ---------------------------------------------------------------------------
// The PDF writer
// ---------------------------------------------------------------------------

/**
 * The file's cross-reference table as `{ count, offsets }`, read the way a PDF reader reads it:
 * from the offset after `startxref` at the end of the file.
 */
function readXref(text) {
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
  const lines = text.slice(start).split("\n");

  assertEquals(lines[0], "xref", "startxref points at the xref keyword");

  const count = Number(lines[1].split(" ")[1]);
  const offsets = lines.slice(3, 2 + count).map(line => Number(line.slice(0, 10)));

  return { count, offsets };
}

Deno.test("the cross-reference table points at every object", () => {
  // Setup: a two-page document with text holding every character that needs escaping in a PDF
  // string (a backslash and both parentheses) and a non-ASCII one (an en dash, one byte in
  // WinAnsiEncoding), since a writer that counted characters instead of bytes, or forgot an
  // escape, would put the offsets or the string out.
  const pdf = new PdfDocument({ title: "Test – title", author: "someone" });

  pdf.addPage().text("a (b) \\ c – d", 10, 20);
  pdf.addPage().line(0, 0, 100, 100);

  const text = pdf.toBinaryString();
  const { count, offsets } = readXref(text);

  // The test: 1 catalog, 1 page tree, 3 fonts, 1 info dictionary and 2 objects per page is 10,
  // plus the free entry 0; and each object's offset lands exactly on "N 0 obj".
  assertEquals(count, 11, "entries");
  offsets.forEach((offset, i) => {
    assert(text.startsWith(`${i + 1} 0 obj\n`, offset), `object ${i + 1} is at its offset ${offset}`);
  });

  // The string was escaped and its en dash written as WinAnsiEncoding's 0x96.
  assert(text.includes("(a \\(b\\) \\\\ c \x96 d) Tj"), "escaped text");

  // Every stream's /Length is its content's byte count, which a reader uses to find endstream.
  for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const bodyStart = match.index + match[0].length;

    assert(text.startsWith("endstream", bodyStart + Number(match[1])), "stream length");
  }
});

Deno.test("text is measured with the standard fonts' widths and wrapped between words", () => {
  // Setup and test: "0" is 556/1000 of an em in Helvetica, so ten of them at 10pt are 55.6pt;
  // Helvetica's "i" is 222, Times-Bold's "W" 1000 (Adobe's AFM files).
  assertEquals(textWidth("0000000000", "helvetica", 10), 55.6, "digits");
  assertEquals(textWidth("i", "helvetica", 1000), 222, "narrow i");
  assertEquals(textWidth("W", "times-bold", 10), 10, "wide W");

  // Wrapping: teeth wrap after a dash and keep it; notes wrap at spaces; nothing is lost.
  const teeth = "04-12-20-28-36-44-52-60-68-76-84-92";
  const lines = wrapText(teeth, "helvetica", 9, 100, "-");

  assert(lines.length > 1, "the teeth wrap at 100pt");
  assert(lines.slice(0, -1).every(line => line.endsWith("-")), "each broken line ends with its dash");
  assertEquals(lines.join(""), teeth, "no teeth lost");
  assertEquals(wrapText("one two three", "helvetica", 10, 40), ["one two", "three"], "words");
});

Deno.test("characters outside WinAnsiEncoding become question marks", () => {
  assertEquals(winAnsiCodes("Aé—中"), [65, 0xe9, 0x97, 63]);
});

// ---------------------------------------------------------------------------
// The corpus: every Gem Cut Studio design builds a sheet
// ---------------------------------------------------------------------------

Deno.test("every corpus design builds a sheet with sane ratios", async () => {
  // Setup: every .gcs under reference/gemology-project-designs, when it is there.
  let entries;

  try {
    entries = [...Deno.readDirSync(CORPUS_DIR)].filter(entry => entry.name.endsWith(".gcs"));
  } catch {
    console.log("  (skipped: reference/gemology-project-designs is not present)");
    return;
  }

  // The test: each design produces a PDF, neither its crown nor its pavilion is taller than the
  // stone, and its volume is positive and less than the box round it. (C + P can exceed H: a
  // fantasy cut's girdle can zig-zag, so its lowest crown corner sits below its highest
  // pavilion corner -- Illusional_Eye_Neo's does.) A smoke test that the layout copes with
  // stones of every shape; the exact numbers are checked on hex_cut_v2 above.
  for (const entry of entries) {
    const design = readGcs(await Deno.readTextFile(new URL(entry.name, CORPUS_DIR)), entry.name);
    const data = sheetData(design, { decimals: 2 });
    const m = data.measurements;

    assert(m.crownHeight <= m.height + 1e-9 && m.pavilionHeight <= m.height + 1e-9, `${entry.name}: C, P <= H`);
    assert(m.volume > 0 && m.volume < m.length * m.width * m.height, `${entry.name}: volume`);
    assert(sheetToPdf(data).toBytes().length > 1000, `${entry.name}: a PDF was written`);
  }
});
