/*
 * round_trip_corpus_test.js -- the corpus-wide round trip (T-0214, the user: "I want a test
 * suite that takes every reference gcs/asc/gem file, parses it into our internal
 * representation and then exports it back to the original version to verify its mostly
 * unchanged").
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/
 *
 * WHAT IT DOES, per file: read it the way the page does (GemCad.importBytes or
 * GemCutStudio.importText, then GemCadDesign.fromGemCad), write it back out in its OWN format
 * (designToAscText / designToGemBytes / designToGcs), read THAT back the same way, and compare
 * the two designs field by field. Every one of the ~595 files in
 * reference/gemology-project-designs goes through, plus the four upstream samples and the
 * startup stone, and the suite reports how many survived rather than stopping at the first
 * failure -- a format change that breaks one design in fifty is the thing this is for.
 *
 * WHY COMPARE DESIGNS AND NOT FILE BYTES. A byte comparison would fail on every file for
 * reasons that are not defects: Gem Cut Studio writes 17 significant digits where JavaScript
 * writes the shortest round-tripping form (0.99999999999999967 vs 0.9999999999999997 -- the
 * same double), a .gem's trailer holds bytes whose meaning nobody here knows, and a .gcs's
 * corner coordinates come from Gem Cut Studio's own solver while ours come from intersecting
 * the design's planes. The design is what the page actually works from, so "mostly unchanged"
 * is a property of the design, and this compares that.
 *
 * THE TOLERANCES, and why each is the size it is (all measured, see the constants below):
 * the polar fields (angle, distance, index) are transcribed verbatim by the writers and come
 * back as the identical double or very near it, so they are held to a tight bound; geometry is
 * not stored in the design at all and is rebuilt from those fields on the way out, so a .gcs's
 * corners are held to a looser one. Strings and flags must match exactly -- they are copied,
 * not computed, and there is no fuzziness available to hide a dropped field in.
 *
 * WHAT IT DOES NOT CHECK: that a real GemCad or Gem Cut Studio accepts what we write. Nothing
 * in this project can check that; see kb/gemcad-gem-binary-writer-t-0207.md.
 */

import { designToAscText } from "../src/lib/export_asc.js";
import { designToGemBytes } from "../src/lib/export_gem.js";
import { designToGcs } from "../src/lib/export_gcs.js";

for (const script of ["gemcad.js", "gemcad_obj.js", "design.js", "design_mesh.js", "gcs.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../js/${script}`, import.meta.url)));
}

const { GemCad, GemCadDesign, GemCutStudio } = globalThis;

// ---------------------------------------------------------------------------
// Tolerances
// ---------------------------------------------------------------------------

/**
 * A tier's mast angle and cut depth, and a facet's index, may move by this much across a round
 * trip. All three are written as JavaScript's shortest round-tripping decimal and parsed back
 * with `Number()`, so a .asc's come back BIT-IDENTICAL; this bound exists for the two formats
 * that re-derive them from geometry instead (a .gem's tier angle is re-derived and rounded to
 * 2 decimals by `calculateTierDefinitions`, exactly as a real .gem is -- see
 * NORMAL_AGREEMENT_TOLERANCE in design.js -- and a .gcs's index is recovered from a rebuilt
 * normal). Measured worst case over the whole corpus: see the counts the suite prints.
 */
const POLAR_TOLERANCE = 1e-2;

/**
 * A facet's index, in teeth. Tighter than the angle bound because an index is recovered by
 * `polarOf`, the exact inverse of the `normalOf` the writers build their geometry with, and
 * then snapped: a facet that lands on a tooth either side of this would be a different facet.
 * This is design.js's own INDEX_SNAP_TOLERANCE, the same bound the readers already hold their
 * own index recovery to.
 */
const INDEX_TOLERANCE = 5e-3;

/**
 * A `.gcs` corner, in stone half-widths. The file's corners are Gem Cut Studio's own solver's;
 * ours are the intersection of the design's planes, and on a design with meet-point tiers those
 * planes are only concurrent to about 1e-4 (kb/design-mesh-builder.md), so a corner is really a
 * small cluster. export_gcs_test.js already holds single facets to 1e-4 against the original
 * file; this suite compares the STONE (every corner of every facet, as a set) across every
 * design in the corpus, where a handful of meet-point clusters are wider still.
 */
const CORNER_TOLERANCE = 2e-3;

// ---------------------------------------------------------------------------
// Loading the corpus
// ---------------------------------------------------------------------------

/* Plain filesystem PATHS, not URLs. One corpus file is named `Wanna_Fanta?.gem`, and a `?` in
 * a URL starts a query string, so `new URL(name, dir)` silently truncates it to a path that
 * does not exist -- the rest of this project's suites build URLs because they name their few
 * fixtures literally, but this one walks a directory nobody here chose the names in. */
const HERE = decodeURIComponent(new URL("./", import.meta.url).pathname);
const CORPUS_DIR = `${HERE}../../../reference/gemology-project-designs/`;
const SAMPLES_DIR = `${HERE}../../../reference/gemcad-file-reader/Samples/`;
const STARTUP_PATH = `${HERE}../../resources/hex_cut_v2.gcs`;

/** Every design file in `directory`, or `[]` when it is absent (reference/ is gitignored). */
function filesIn(directory) {
  try {
    return [...Deno.readDirSync(directory)]
      .filter(entry => /\.(gcs|asc|gem)$/i.test(entry.name))
      .map(entry => ({ name: entry.name, path: `${directory}${entry.name}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

const CORPUS = [...filesIn(CORPUS_DIR), ...filesIn(SAMPLES_DIR)];
const CORPUS_PRESENT = CORPUS.length > 0;

// ---------------------------------------------------------------------------
// Reading and writing one file, in whichever format it is
// ---------------------------------------------------------------------------

/**
 * `bytes` read the way the page's own load path reads them: a `.gcs` through
 * `GemCutStudio.importText`, anything else through `GemCad.importBytes` (which sniffs the
 * leading "GemCad " to tell a `.asc` from a `.gem`). Returns the design, plus the parsed file
 * for the caller that needs a `.gcs`'s stored corners.
 *
 * One corpus file is a `.gcs` under a `.gem` name (DESIGN_NAME.gem) and another is a PDF under
 * a `.gem` name (Ruination.gem) -- see kb/gemology-project-wiki-a-real-world-gem-gcs-corpu.md.
 * Both are detected by content here, exactly as the page does, rather than by extension.
 */
function readDesign(bytes, name) {
  const text = new TextDecoder().decode(bytes);
  const isGcs = text.startsWith("<GemCutStudio") || text.includes("<GemCutStudio ");
  const parsed = isGcs ? GemCutStudio.importText(text).parsed : GemCad.importBytes(bytes);

  return {
    format: isGcs ? "gcs" : text.startsWith("GemCad ") ? "asc" : "gem",
    parsed,
    design: GemCadDesign.fromGemCad(parsed, { name }),
  };
}

/**
 * The design as much of it as its own format's writer can actually write: a `.gcs` and a `.gem`
 * both store GEOMETRY, and a facet whose half-space is redundant -- one that later cuts remove
 * from the stone completely -- has no corners, so neither format has anything to write for it.
 * `designToGcs` reports those as `omittedFacets`/`omittedTiers` and tells the user; the `.gem`
 * writer simply skips them (`if (!faces || faces.length === 0) continue`).
 *
 * This reproduces that rule from the same builder the writers use, so the round trip compares
 * what the format CAN hold against what came back, and a tier that vanishes for any OTHER
 * reason is still a failure. Measured on the corpus: 32 of 568 `.gem` designs have at least one
 * such tier (2014_M2, Chaos, every Chevonchev, ...), and no `.gcs` design does.
 *
 * The two writers differ in one detail, faithfully reproduced here: `designToGcs` cuts the
 * stone with every tier un-hidden (so a hidden tier still has corners to write, and is marked
 * `visible="false"`), while the `.gem` writer builds from the design as-is, so a hidden tier's
 * planes are not cut at all and the tier is dropped. No corpus design has a hidden tier --
 * `visible` is `"true"` in all 316 corpus tiers -- so this only matters for a design edited here.
 */
function writableDesign(design, format) {
  if (format === "asc") {
    return design; // no geometry in the format: every tier and facet is written
  }

  const source = format === "gcs"
    ? { ...design, tiers: design.tiers.map(tier => ({ ...tier, hidden: false })) }
    : design;
  const built = globalThis.DesignMesh.buildFaces(source);
  const kept = new Set(built.faces.map(face => `${face.tier}:${face.facet}`));

  const tiers = design.tiers
    .map((tier, t) => ({
      ...tier,
      facets: tier.facets.filter((_, f) => kept.has(`${t}:${f}`)),
    }))
    .filter(tier => tier.facets.length > 0);

  return { ...design, tiers };
}

/** `design` written back out in `format`, as bytes, ready to be read again. */
function writeDesign(design, format) {
  if (format === "asc") {
    return new TextEncoder().encode(designToAscText(design));
  }

  if (format === "gem") {
    return designToGemBytes(design);
  }

  return new TextEncoder().encode(designToGcs(design).text);
}

// ---------------------------------------------------------------------------
// Comparing two designs
// ---------------------------------------------------------------------------

/** Every corner of every facet in a parsed file, as one flat list of points. */
function cornersOf(parsed) {
  const points = [];

  for (const tier of parsed.tiers) {
    for (const facet of tier.indices) {
      for (const point of facet.points) {
        points.push(point);
      }
    }
  }

  return points;
}

/**
 * The differences between two designs, as a list of human-readable strings -- empty when they
 * agree. Compared: the gear and symmetry, the comments, the `<info>` and `<render>` blocks,
 * and every tier's angle, depth, instructions, flags, name and facet list.
 *
 * `only` names the fields the format in question can carry, so a check is either made or
 * declared absent, never quietly skipped: a `.asc`/`.gem` has no `<info>` or `<render>` at all
 * and no per-facet frosting, so those are compared only for a `.gcs`.
 */
function differences(before, after, only) {
  const out = [];
  const say = (what, a, b) => out.push(`${what}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  const near = (what, a, b, tolerance) => {
    if (!(Math.abs(a - b) <= tolerance)) {
      say(`${what} (tolerance ${tolerance})`, a, b);
    }
  };

  if (before.gear.teeth !== after.gear.teeth || before.gear.reversed !== after.gear.reversed) {
    say("gear", before.gear, after.gear);
  }

  near("gear.originIndex", before.gear.originIndex, after.gear.originIndex, INDEX_TOLERANCE);

  if (before.symmetry.folds !== after.symmetry.folds
    || before.symmetry.mirror !== after.symmetry.mirror) {
    say("symmetry", before.symmetry, after.symmetry);
  }

  if (only.comments) {
    if (JSON.stringify(before.headers) !== JSON.stringify(after.headers)) {
      say("headers", before.headers, after.headers);
    }

    if (JSON.stringify(before.footnotes) !== JSON.stringify(after.footnotes)) {
      say("footnotes", before.footnotes, after.footnotes);
    }
  }

  if (only.info && JSON.stringify(before.info || null) !== JSON.stringify(after.info || null)) {
    say("info", before.info, after.info);
  }

  if (only.render && JSON.stringify(before.render || null) !== JSON.stringify(after.render || null)) {
    say("render", before.render, after.render);
  }

  if (before.tiers.length !== after.tiers.length) {
    say("tier count", before.tiers.length, after.tiers.length);
    return out;
  }

  before.tiers.forEach((tier, t) => {
    const other = after.tiers[t];

    near(`tier ${t} angle`, tier.angle, other.angle, POLAR_TOLERANCE);
    near(`tier ${t} distance`, tier.distance, other.distance, POLAR_TOLERANCE);

    if (only.instructions
      && (tier.cuttingInstructions || "") !== (other.cuttingInstructions || "")) {
      say(`tier ${t} instructions`, tier.cuttingInstructions, other.cuttingInstructions);
    }

    if (only.tierFlags) {
      for (const flag of ["hidden", "frosted", "guide"]) {
        if (Boolean(tier[flag]) !== Boolean(other[flag])) {
          say(`tier ${t} ${flag}`, Boolean(tier[flag]), Boolean(other[flag]));
        }
      }

      if ((tier.name || "") !== (other.name || "")) {
        say(`tier ${t} name`, tier.name, other.name);
      }
    }

    if (tier.facets.length !== other.facets.length) {
      say(`tier ${t} facet count`, tier.facets.length, other.facets.length);
      return;
    }

    tier.facets.forEach((facet, f) => {
      // A facet's index is on a wheel, so 0 and `teeth` are the same tooth.
      const teeth = before.gear.teeth;
      const raw = Math.abs(facet.index - other.facets[f].index);

      near(`tier ${t} facet ${f} index`, 0, Math.min(raw, teeth - raw), INDEX_TOLERANCE);

      if (only.frosting
        && Boolean(facet.frosting) !== Boolean(other.facets[f].frosting)) {
        say(`tier ${t} facet ${f} frosting`, facet.frosting, other.facets[f].frosting);
      }
    });
  });

  return out;
}

/**
 * How far the stone moved, as the largest distance from a corner of `before` to the nearest
 * corner of `after` and back. Only a `.gcs` stores corners; this is what catches a writer that
 * produces a valid-looking design of the wrong SHAPE, which the polar comparison above cannot
 * see on its own (a mirrored stone has the same angles and depths).
 */
function furthestCorner(before, after) {
  const a = cornersOf(before);
  const b = cornersOf(after);

  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const nearest = (point, cloud) => {
    let best = Infinity;

    for (const other of cloud) {
      const distance = Math.hypot(point.x - other.x, point.y - other.y, point.z - other.z);

      if (distance < best) {
        best = distance;
      }
    }

    return best;
  };

  let worst = 0;

  for (const point of a) {
    worst = Math.max(worst, nearest(point, b));
  }

  for (const point of b) {
    worst = Math.max(worst, nearest(point, a));
  }

  return worst;
}

// ---------------------------------------------------------------------------
// The round trip itself
// ---------------------------------------------------------------------------

/**
 * Reads `bytes`, writes the design back in its own format, reads that, and returns
 * `{ skipped }` for a file the reader refuses outright, or `{ differences, cornerShift }`.
 *
 * WHICH FIELDS ARE COMPARED depends on what the format can hold, and that list is the point of
 * this function as much as the comparison is:
 *
 *   - `.gcs` carries everything: comments (as `<info>`'s headerN/footerN), the `<info>` and
 *     `<render>` blocks, per-tier name/guide/hidden and per-facet frosting.
 *   - `.asc` carries the comments (`H`/`F` lines) and the cutting instructions, and nothing
 *     else on that list -- there is no attribute for a tier's name, its flags or a material.
 *   - `.gem` carries the comments and, per kb/gemcad-gem-binary-writer-t-0207.md, this
 *     project's writer deliberately does not reproduce the instruction records' one-record lag,
 *     so instructions are not compared for it.
 */
function roundTrip(bytes, name) {
  let read;

  try {
    read = readDesign(bytes, name);
  } catch (error) {
    return { skipped: String(error.message).slice(0, 80) };
  }

  const only = {
    gcs: { comments: true, info: true, render: true, instructions: true, tierFlags: true, frosting: true },
    asc: { comments: true, instructions: true },
    gem: { comments: true },
  }[read.format];

  let back;

  try {
    back = readDesign(writeDesign(read.design, read.format), name);
  } catch (error) {
    return { failed: `re-reading what we wrote: ${String(error.message).slice(0, 120)}` };
  }

  // Compared against what the format can hold, not against the design as read: see
  // `writableDesign`. The facets the format cannot store are counted so the sweep can report
  // them rather than let them pass unseen.
  const writable = writableDesign(read.design, read.format);
  const facetsOf = design => design.tiers.reduce((n, tier) => n + tier.facets.length, 0);

  return {
    format: read.format,
    differences: differences(writable, back.design, only),
    cornerShift: read.format === "gcs" ? furthestCorner(read.parsed, back.parsed) : 0,
    droppedTiers: read.design.tiers.length - writable.tiers.length,
    droppedFacets: facetsOf(read.design) - facetsOf(writable),
  };
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

/*
 * SETUP: the startup stone, src/resources/hex_cut_v2.gcs, which is committed -- so unlike the
 * corpus sweep below, this one runs on a fresh clone with no reference/ directory.
 *
 * TEST: one full round trip through the .gcs writer.
 *
 * VERIFIES: nothing at all changes in the design, and no corner of the stone moves further
 * than the meet-point cluster width. This is the whole suite's mechanism on one known file, so
 * a failure here is a real regression rather than a corpus oddity.
 */
Deno.test("the startup stone survives a .gcs round trip", async () => {
  const result = roundTrip(await Deno.readFile(STARTUP_PATH), "hex_cut_v2.gcs");

  if (result.differences.length > 0) {
    throw new Error(`hex_cut_v2.gcs changed:\n  ${result.differences.join("\n  ")}`);
  }

  if (!(result.cornerShift <= CORNER_TOLERANCE)) {
    throw new Error(`a corner moved ${result.cornerShift}, past ${CORNER_TOLERANCE}`);
  }
});

/*
 * SETUP: every .gcs, .asc and .gem in reference/ -- the 595-file Gemology Project corpus
 * (kb/gemology-project-wiki-a-real-world-gem-gcs-corpu.md) plus the four upstream samples.
 * Skipped entirely when reference/ is absent, as CLAUDE.md requires.
 *
 * TEST: round-trip each one through its own format's writer and collect every design-level
 * difference, rather than stopping at the first.
 *
 * VERIFIES: every file the readers accept comes back the same design. A file the READER
 * refuses is counted and reported, not failed -- two corpus members are known to be unreadable
 * (a PDF and a mislabeled file, see the KB article) and that is the corpus's problem, not the
 * writers'. A file that reads but does not survive its own writer IS a failure, and the message
 * names the file and the field, since that is what a regression looks like.
 */
Deno.test("every reference design survives a round trip through its own format", { ignore: !CORPUS_PRESENT }, async () => {
  const counts = { gcs: 0, asc: 0, gem: 0 };
  const skipped = [];
  const broken = [];
  const dropped = [];
  let worstCorner = 0;

  for (const file of CORPUS) {
    const result = roundTrip(await Deno.readFile(file.path), file.name);

    if (result.skipped) {
      skipped.push(`${file.name} (${result.skipped})`);
      continue;
    }

    if (result.failed) {
      broken.push(`${file.name}: ${result.failed}`);
      continue;
    }

    counts[result.format] += 1;
    worstCorner = Math.max(worstCorner, result.cornerShift);

    if (result.droppedTiers > 0 || result.droppedFacets > 0) {
      dropped.push(`${file.name} [${result.format}]: ` +
        `${result.droppedTiers} tier(s), ${result.droppedFacets} facet(s) off the stone`);
    }

    if (result.differences.length > 0) {
      broken.push(`${file.name} [${result.format}]:\n    ${result.differences.slice(0, 6).join("\n    ")}`);
    }

    if (!(result.cornerShift <= CORNER_TOLERANCE)) {
      broken.push(`${file.name} [${result.format}]: a corner moved ${result.cornerShift}`);
    }
  }

  console.log(`  round trip: ${counts.gcs} .gcs, ${counts.asc} .asc, ${counts.gem} .gem; ` +
    `${skipped.length} unreadable; worst corner shift ${worstCorner.toExponential(2)}; ` +
    `${dropped.length} design(s) have facets off the stone that no geometry format can hold`);

  if (broken.length > 0) {
    throw new Error(`${broken.length} design(s) did not survive:\n  ${broken.slice(0, 12).join("\n  ")}`);
  }
});
