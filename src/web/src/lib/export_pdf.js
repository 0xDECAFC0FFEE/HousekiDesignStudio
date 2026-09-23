/*
 * export_pdf.js -- File > Export > PDF: the loaded design as a printed cutting sheet, laid out
 * after the GemCad print the user supplied as the example
 * (reference/application_images/hex_cut_v2/gem_print.pdf, 2026-09-23):
 *
 *   - top left, the design's name (underlined), its author and date, and three small tables:
 *     Facet Data (facet and tier counts by section), Size Data (the proportions, as ratios to
 *     the width W) and Design Data (refractive index, symmetry, gear);
 *   - top right, four line drawings of the stone: the crown seen from above with the gear's
 *     index numbers round it, the stone from the side, from the front, and the pavilion from
 *     below, with the measurements the ratios are made of drawn on the side and front views and
 *     each tier's name written on one of its facets;
 *   - below, the cutting instructions: the pavilion's tiers, then the crown's, each with its
 *     angle, its index teeth and its note; then the design's footnotes. Further pages follow if
 *     the instructions do not fit on the first.
 *
 * THE DRAWINGS are orthographic and show only the edges the viewer can see. The stone is convex
 * (it is cut by planes alone), so an edge is visible exactly when it bounds a facet that faces
 * the viewer; the facets come from `DesignMesh.buildFaces`, the builder the rendered stone
 * comes from, so the drawing is the stone on screen. Hidden tiers are not cut, so they are
 * neither drawn nor listed.
 *
 * WHICH WAY ROUND. In the example the crown view has index 0 at the bottom and index 24 (of 96)
 * on the right, the same side as the design's +X. `GemCadDesign.normalOf` points index 0 along
 * the design's +Y, so the crown view draws +X to the right and +Y DOWN the page -- once turned
 * so the stone's long axis runs across the page (see THE RATIOS). The other views are placed as
 * in the example, which is third-angle projection round the crown view: the front view below it
 * is the stone seen from the bottom of that drawing, the side view to its right the stone seen
 * from its right, with the crown on the left, and the pavilion view is the stone turned over
 * about the page's vertical, so the tooth at the bottom stays at the bottom.
 *
 * THE RATIOS. L is the longest dimension in the girdle plane and W the stone's width 90 degrees
 * off that long axis (the user, 2026-09-23: "l is the longest dimension on the girdle plane and
 * w is 90 degrees off of the long axis"). The long axis is the direction of the outline's
 * diameter, its two farthest-apart points seen from above (`girdleFrame`). The drawings are
 * turned so that axis runs across the page, which keeps L's dimension line along it and W's
 * square to it. T is the table's extent along W's direction and U along L's; C, P and H are the
 * crown, pavilion and total heights; V the volume. For hex_cut_v2 (long axis corner to corner,
 * already across the page) this gives the example's own numbers (export_pdf_test.js).
 *
 * This is not the renderer's corner readout (stone_stats.js), which takes W as the narrowest
 * width. The two agree for a hexagon or an oval, but not for a rectangle, whose longest
 * dimension is its diagonal.
 */
import { get } from 'svelte/store';
import { getDesign } from './tier_controller.js';
import { cutMeta, engine, showLoadAlert } from './stores.js';
import { angleDecimals } from './preferences.js';
import { saveFileAs } from './export_file.js';
import { bigTickStep } from './index_ruler.js';
import { hull2d } from './stone_stats.js';
import {
  formatTierAngle, formatTierIndex, isCuletTier, isGirdleTier, isPavilionTier, isTableTier,
  splitTiersIntoSections, tierIdsInFileOrder,
} from './tiers.js';
import { PdfDocument, textWidth, wrapText } from './pdf_writer.js';

/** Used when the cut name is empty or not filename-safe on its own. */
const FALLBACK_NAME = 'stone';

/** A facet whose normal's z is within this of level is a girdle facet (as stone_stats.js). */
const GIRDLE_TILT = 0.01;

/** A facet whose normal is within this of straight up is the table (as stone_stats.js). */
const TABLE_TILT = 1e-4;

/** A facet faces a view when its normal points at the viewer by more than this. */
const FACING = 1e-6;

/**
 * Two diameters of the outline within this fraction of each other count as equally long (see
 * `girdleFrame`). A symmetrical design's copies of one corner agree to about 1e-9 of the stone's
 * size after the mesh builder's clips; this is far looser, and far tighter than any real
 * difference between a stone's length and its width.
 */
const DIAMETER_TIE = 1e-6;

/** `name` turned into a safe `.pdf` filename, by the same rule as the other exports. */
export function pdfFilename(name) {
  const cleaned = (name || '').trim().replace(/[\\/:*?"<>|]/g, '');

  return `${cleaned || FALLBACK_NAME}.pdf`;
}

/* ------------------------------------------------------------------------------------------ *
 * What the sheet says
 * ------------------------------------------------------------------------------------------ */

/**
 * One tooth as the sheet writes it: two digits at least ("04"), and tooth 0 as the gear's own
 * size ("96"), as a cutter's index plate reads. A fractional tooth is written as the tier table
 * writes it (`formatTierIndex`).
 */
export function formatSheetIndex(index, teeth) {
  const wound = teeth > 0 ? ((index % teeth) + teeth) % teeth : index;
  const shown = wound === 0 && teeth > 0 ? teeth : wound;

  return Number.isInteger(shown) ? String(shown).padStart(2, '0') : formatTierIndex(shown);
}

/**
 * A tier's index column: its teeth in ascending order, tooth 0 (written as the gear's size)
 * first, joined by dashes, as in the example ("96-16-32-48-64-80"), and in the braces a preform
 * tier's teeth wear in the tier table; "Table" or "Culet" for a facet on the axis, which has no
 * index. The design keeps its facets in the order its file listed them, which need not be
 * ascending (hex_cut_v2.gcs starts P1 at tooth 52).
 */
export function tierIndexText(tier, teeth) {
  if (isTableTier(tier)) {
    return 'Table';
  }

  if (isCuletTier(tier)) {
    return 'Culet';
  }

  const wind = index => (teeth > 0 ? ((index % teeth) + teeth) % teeth : index);
  const teethText = tier.facets
    .map(facet => wind(facet.index))
    .sort((a, b) => a - b)
    .map(index => formatSheetIndex(index, teeth))
    .join('-');

  return tier.preform ? `{${teethText}}` : teethText;
}

/** `value` to three significant decimals at most, without trailing zeros: 2.1600001 is "2.16". */
function shortNumber(value) {
  return String(parseFloat(value.toFixed(3)));
}

/**
 * The facet and tier counts, by section. Counted from the design's tiers, as a cutter counts
 * them, not from the mesh: a facet a later tier cuts away is still cut. The table and a flat
 * culet are each shown as "+1" beside their section's count, as in the example ("42+1").
 */
export function facetCounts(tiers) {
  const counts = {
    pavilion: { facets: 0, tiers: 0, extraFacets: 0, extraTiers: 0 },
    girdle: { facets: 0, tiers: 0, extraFacets: 0, extraTiers: 0 },
    crown: { facets: 0, tiers: 0, extraFacets: 0, extraTiers: 0 },
  };

  for (const tier of tiers) {
    const section = isGirdleTier(tier) ? counts.girdle
      : isPavilionTier(tier) ? counts.pavilion : counts.crown;

    if (isTableTier(tier) || isCuletTier(tier)) {
      section.extraFacets += tier.facets.length;
      section.extraTiers += 1;
    } else {
      section.facets += tier.facets.length;
      section.tiers += 1;
    }
  }

  const total = key => Object.values(counts)
    .reduce((sum, section) => sum + section[key] + section[key === 'facets' ? 'extraFacets' : 'extraTiers'], 0);

  return { ...counts, totalFacets: total('facets'), totalTiers: total('tiers') };
}

/** "42+1", or "42" with nothing extra. */
function countText(count, extra) {
  return extra > 0 ? `${count}+${extra}` : String(count);
}

/* ------------------------------------------------------------------------------------------ *
 * The stone's geometry
 * ------------------------------------------------------------------------------------------ */

/**
 * The stone the design cuts, as `{ positions, faces }`: welded corner points, and each face's
 * corner indices, outward unit normal, and tier and facet. Throws, as `DesignMesh.buildFaces`
 * does, for a design that builds no stone.
 */
export function stoneGeometry(design) {
  const { DesignMesh } = globalThis;
  const built = DesignMesh.buildFaces(design);
  const welded = DesignMesh.weldFaces(built, DesignMesh.defaults.weldTolerance);

  return {
    positions: welded.positions,
    faces: welded.loops.map(loop => ({
      indices: loop.indices,
      normal: built.planes[loop.planeIndex].normal,
      tier: loop.tier,
      facet: loop.facet,
    })),
  };
}

function extentOf(values) {
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
}

/**
 * The stone's long axis seen from above, as `{ along, across }`: unit 2D vectors (`{ x, y }`),
 * `along` the direction of the longest dimension in the girdle plane (the outline's diameter:
 * its two farthest-apart corners) and `across` 90 degrees from it, counter-clockwise, so the
 * pair is `(x, y)` itself turned by the same angle.
 *
 * A symmetrical stone has several equally long diameters (a hexagon three, a round one per
 * girdle corner). Of those within DIAMETER_TIE of the longest, the one nearest the design's own
 * X axis is taken, so a stone whose long axis already runs across the page is drawn as it
 * stands -- hex_cut_v2 exactly as in the example -- and any other is turned as little as
 * possible. `along` points to +X's side (`x > 0`, or straight up +Y).
 */
export function girdleFrame(positions) {
  const hull = hull2d(positions.map(p => [p.x, p.y]));
  const pairs = [];
  let longest = 0;

  for (let i = 0; i < hull.length; i++) {
    for (let j = i + 1; j < hull.length; j++) {
      const dx = hull[j][0] - hull[i][0];
      const dy = hull[j][1] - hull[i][1];
      const length = Math.hypot(dx, dy);

      pairs.push({ dx, dy, length });
      longest = Math.max(longest, length);
    }
  }

  let along = { x: 1, y: 0 };
  let bestTurn = Infinity;

  for (const { dx, dy, length } of pairs) {
    if (!(longest > 0) || length < longest * (1 - DIAMETER_TIE)) {
      continue;
    }

    // Point it to +X's side, then measure how far it is turned from +X.
    const flip = dx < 0 || (dx === 0 && dy < 0) ? -1 : 1;
    const x = flip * dx / length;
    const y = flip * dy / length;
    const turn = Math.abs(Math.atan2(y, x));

    if (turn < bestTurn - 1e-12) {
      bestTurn = turn;
      along = { x, y };
    }
  }

  return { along, across: { x: -along.y, y: along.x } };
}

/**
 * The measurements the Size Data table is made of, in the design's units: see the header
 * comment for what each is. `table` is null for a stone with no table.
 */
export function stoneMeasurements({ positions, faces }) {
  const frame = girdleFrame(positions);
  // Every corner's position along the long axis (L's direction) and across it (W's).
  const alongOf = p => p.x * frame.along.x + p.y * frame.along.y;
  const acrossOf = p => p.x * frame.across.x + p.y * frame.across.y;
  const as = positions.map(alongOf);
  const bs = positions.map(acrossOf);
  const zs = positions.map(p => p.z);
  const cornersOf = side => faces.filter(side).flatMap(face => face.indices.map(i => positions[i]));
  const crown = cornersOf(face => face.normal.z > GIRDLE_TILT);
  const pavilion = cornersOf(face => face.normal.z < -GIRDLE_TILT);
  const tableFace = faces.find(face => face.normal.z > 1 - TABLE_TILT);
  const table = tableFace ? tableFace.indices.map(i => positions[i]) : null;
  const top = Math.max(...zs);
  const bottom = Math.min(...zs);

  // The volume by the divergence theorem: each face contributes a cone from the origin, a third
  // of its area times its plane's distance from the origin.
  let volume = 0;

  for (const face of faces) {
    const loop = face.indices.map(i => positions[i]);
    let nx = 0;
    let ny = 0;
    let nz = 0;

    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];

      nx += (a.y - b.y) * (a.z + b.z);
      ny += (a.z - b.z) * (a.x + b.x);
      nz += (a.x - b.x) * (a.y + b.y);
    }

    const area = Math.hypot(nx, ny, nz) / 2;
    const offset = face.normal.x * loop[0].x + face.normal.y * loop[0].y + face.normal.z * loop[0].z;

    volume += area * offset / 3;
  }

  return {
    frame,
    length: extentOf(as),
    width: extentOf(bs),
    height: top - bottom,
    top,
    bottom,
    minAlong: Math.min(...as),
    maxAlong: Math.max(...as),
    minAcross: Math.min(...bs),
    maxAcross: Math.max(...bs),
    crownBottom: crown.length ? Math.min(...crown.map(p => p.z)) : null,
    pavilionTop: pavilion.length ? Math.max(...pavilion.map(p => p.z)) : null,
    crownHeight: crown.length ? top - Math.min(...crown.map(p => p.z)) : 0,
    pavilionHeight: pavilion.length ? Math.max(...pavilion.map(p => p.z)) - bottom : 0,
    table: table ? {
      minAlong: Math.min(...table.map(alongOf)),
      maxAlong: Math.max(...table.map(alongOf)),
      minAcross: Math.min(...table.map(acrossOf)),
      maxAcross: Math.max(...table.map(acrossOf)),
      z: Math.max(...table.map(p => p.z)),
    } : null,
    volume,
  };
}

/**
 * The Size Data ratios, each to three decimals, or "-" where the stone has no such part (no
 * table, no crown). In the example's order, row by row: L/W P/W, T/W C/W, U/W H/W, V/W^3 P/C.
 */
export function sizeRatios(m) {
  const w = m.width;
  const ratio = value => (Number.isFinite(value) && w > 0 ? value.toFixed(3) : '-');

  return [
    ['L/W', ratio(m.length / w), 'P/W', ratio(m.pavilionHeight / w)],
    ['T/W', m.table ? ratio((m.table.maxAcross - m.table.minAcross) / w) : '-', 'C/W', ratio(m.crownHeight / w)],
    ['U/W', m.table ? ratio((m.table.maxAlong - m.table.minAlong) / w) : '-', 'H/W', ratio(m.height / w)],
    ['V/W^3', ratio(m.volume / (w * w * w)), 'P/C',
      m.crownHeight > 0 ? (m.pavilionHeight / m.crownHeight).toFixed(3) : '-'],
  ];
}

/* ------------------------------------------------------------------------------------------ *
 * The four views
 * ------------------------------------------------------------------------------------------ */

/**
 * Each view: which way its viewer looks from (`toward`, a unit vector from the stone to the
 * eye), and where a point lands on the page, as (across, down) offsets from the view's centre
 * in design units, before scaling. See the header comment for why each is the way round it is.
 * `frame` is the stone's long axis (`girdleFrame`), which runs across the page; `mid` is the
 * stone's mid-height, so the side and front views are centred on it.
 */
function viewsFor(frame, mid) {
  const a = p => p.x * frame.along.x + p.y * frame.along.y;
  const b = p => p.x * frame.across.x + p.y * frame.across.y;

  return {
    crown: { toward: { x: 0, y: 0, z: 1 }, place: p => [a(p), b(p)] },
    pavilion: { toward: { x: 0, y: 0, z: -1 }, place: p => [-a(p), b(p)] },
    front: { toward: { ...frame.across, z: 0 }, place: p => [a(p), mid - p.z] },
    side: { toward: { ...frame.along, z: 0 }, place: p => [mid - p.z, b(p)] },
  };
}

/** Whether `face` faces a viewer looking from `toward`. */
function facesToward(face, toward) {
  return face.normal.x * toward.x + face.normal.y * toward.y + face.normal.z * toward.z > FACING;
}

/**
 * The edges a view shows, each `[a, b]` corner indices, once each: every edge of every face
 * that faces the viewer, which on a convex stone is every edge the viewer can see.
 */
export function visibleEdges(geometry, toward) {
  const seen = new Set();
  const edges = [];

  for (const face of geometry.faces) {
    if (!facesToward(face, toward)) {
      continue;
    }

    face.indices.forEach((a, i) => {
      const b = face.indices[(i + 1) % face.indices.length];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;

      if (!seen.has(key)) {
        seen.add(key);
        edges.push([a, b]);
      }
    });
  }

  return edges;
}

/**
 * Where each tier's name goes in a view: `{ tier, at }`, `at` being the view-space centre of
 * one of the tier's facets that faces the viewer. Of a tier's facets, the one nearest the
 * direction `prefer` (a view-space unit vector) is chosen, so the names run out from the middle
 * in one line, as in the example, rather than landing wherever each tier's first facet is.
 */
function tierLabelSpots(geometry, view, tierFilter, prefer) {
  const best = new Map();

  for (const face of geometry.faces) {
    if (!tierFilter(face.tier) || !facesToward(face, view.toward)) {
      continue;
    }

    const points = face.indices.map(i => view.place(geometry.positions[i]));
    const at = [
      points.reduce((sum, p) => sum + p[0], 0) / points.length,
      points.reduce((sum, p) => sum + p[1], 0) / points.length,
    ];
    const reach = Math.hypot(at[0], at[1]);
    // Straight along `prefer` scores 1, opposite -1; a facet on the axis (the table) has no
    // direction and scores 1, being the only facet of its tier.
    const score = reach > 1e-9 ? (at[0] * prefer[0] + at[1] * prefer[1]) / reach : 1;
    const current = best.get(face.tier);

    if (!current || score > current.score + 1e-9) {
      best.set(face.tier, { tier: face.tier, at, score });
    }
  }

  return [...best.values()];
}

/* ------------------------------------------------------------------------------------------ *
 * The whole sheet, as data
 * ------------------------------------------------------------------------------------------ */

/**
 * Everything the sheet shows, worked out from `design` without drawing anything, so it can be
 * tested: the header, the three tables, the geometry and the instruction rows.
 *
 * `{ title, author, date }` are the cut header's fields (`cutMeta`); `decimals` the angle
 * decimal places the tier table shows (File > Settings); `refractiveIndex` the one set in the
 * app, printed as "Angles for R.I." in preference to the design's own. All are optional.
 */
export function sheetData(design, { title, author, date, decimals = 2, refractiveIndex } = {}) {
  // Hidden tiers are not cut (see the header comment).
  const shown = { ...design, tiers: design.tiers.filter(tier => !tier.hidden) };

  if (shown.tiers.length === 0) {
    throw new Error('every tier is hidden, so there is no stone to print');
  }

  const geometry = stoneGeometry(shown);
  const measurements = stoneMeasurements(geometry);
  const teeth = design.gear.teeth;
  const counts = facetCounts(shown.tiers);
  const ids = tierIdsInFileOrder(shown.tiers);
  // The refractive index set in the app (the material the page is rendering with) wins (the
  // user, 2026-09-23: "use the ri set in the app"); without one (a caller with no GemApp, such
  // as the tests), the design's own: a GemCad file's, else a .gcs file's <render> block's, which
  // is where Gem Cut Studio keeps it.
  const ri = [refractiveIndex, design.refractiveIndex, design.render?.refractiveIndex]
    .find(value => value > 0) || null;
  const { crown, pavilion } = splitTiersIntoSections(shown.tiers);
  const row = ({ tier, id }) => ({
    id,
    // The tier table's own angle text, less its degree sign, as the example prints it.
    angle: formatTierAngle(tier, decimals).replace('°', ''),
    indices: tierIndexText(tier, teeth),
    notes: tier.cuttingInstructions || '',
  });

  return {
    title: (title || design.info?.title || design.name || '').trim(),
    byline: [author || design.info?.author, date || design.info?.date]
      .map(part => (part || '').trim()).filter(Boolean).join(' - '),
    headers: design.headers || [],
    footnotes: design.footnotes || [],
    facetRows: [
      ['Pavilion facets', countText(counts.pavilion.facets, counts.pavilion.extraFacets),
        'Pavilion tiers', countText(counts.pavilion.tiers, counts.pavilion.extraTiers)],
      ['Girdle facets', countText(counts.girdle.facets, counts.girdle.extraFacets),
        'Girdle tiers', countText(counts.girdle.tiers, counts.girdle.extraTiers)],
      ['Crown facets', countText(counts.crown.facets, counts.crown.extraFacets),
        'Crown tiers', countText(counts.crown.tiers, counts.crown.extraTiers)],
      ['Total facets', String(counts.totalFacets), 'Total tiers', String(counts.totalTiers)],
    ],
    sizeRows: sizeRatios(measurements),
    designRows: [
      ['Angles for R.I.', ri ? shortNumber(ri) : '-'],
      ['Symmetry', `${design.symmetry.folds}-fold${design.symmetry.mirror ? ', mirror' : ''}`],
      ['Index gear', String(teeth)],
    ],
    sections: [
      { heading: 'Pavilion', rows: pavilion.map(row) },
      { heading: 'Crown', rows: crown.map(row) },
    ].filter(section => section.rows.length > 0),
    shown,
    ids,
    geometry,
    measurements,
  };
}

/* ------------------------------------------------------------------------------------------ *
 * Drawing it
 * ------------------------------------------------------------------------------------------ */

// The page layout, in points from the top left of a US Letter page, measured off the example.
const MARGIN = 36;
const COLUMN = { left: 30, right: 214, middle: 122 };
const VIEW_CENTRES = { crown: [340, 132], side: [522, 132], front: [340, 302], pavilion: [522, 302] };
/** The largest a stone is drawn: its girdle radius in the crown view, its height side on. */
const MAX_RADIUS = 64;
const MAX_HEIGHT = 108;
const EDGE_WIDTH = 0.5;
const THIN = 0.4;
const PAGE_BOTTOM = 792 - MARGIN;
const ROW_SIZE = 9;
const ROW_LEADING = 11;
const COLUMNS = { id: 40, angle: 62, indices: 100, notes: 240 };
const INDICES_WIDTH = 128;
const NOTES_WIDTH = 576 - COLUMNS.notes;

/** A small filled arrowhead with its tip at (x, y), pointing along (dx, dy). */
function arrowhead(page, x, y, dx, dy) {
  const length = 3.2;
  const half = 1.1;

  page.fillPolygon([
    [x, y],
    [x - dx * length - dy * half, y - dy * length + dx * half],
    [x - dx * length + dy * half, y - dy * length - dx * half],
  ]);
}

/**
 * A dimension: a line between `from` and `to` (page points, horizontal or vertical) with a bar
 * across each end, arrowheads at the bars and `label` in a gap in the middle. When the span is
 * too short to hold the label and both arrowheads, the arrows go outside the bars, pointing in,
 * and the label beside the line (`outside` says which side: 'left', 'above' or 'below').
 */
function dimension(page, from, to, label, outside) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const length = Math.hypot(x2 - x1, y2 - y1);

  if (!(length > 0)) {
    return;
  }

  const dx = (x2 - x1) / length;
  const dy = (y2 - y1) / length;
  const size = 7;
  const labelLength = dy === 0 ? textWidth(label, 'helvetica', size) + 4 : size + 3;
  const bar = 3;

  page.lines([
    [x1 - dy * bar, y1 + dx * bar, x1 + dy * bar, y1 - dx * bar],
    [x2 - dy * bar, y2 + dx * bar, x2 + dy * bar, y2 - dx * bar],
  ], THIN);

  if (length >= labelLength + 10) {
    const gapStart = (length - labelLength) / 2;
    const gapEnd = gapStart + labelLength;

    page.lines([
      [x1, y1, x1 + dx * gapStart, y1 + dy * gapStart],
      [x1 + dx * gapEnd, y1 + dy * gapEnd, x2, y2],
    ], THIN);
    arrowhead(page, x1, y1, -dx, -dy);
    arrowhead(page, x2, y2, dx, dy);
    page.text(label, (x1 + x2) / 2, (y1 + y2) / 2 + size * 0.35, { size, align: 'center' });
    return;
  }

  // Too short: arrows from outside, pointing in, and the label beside it.
  page.lines([
    [x1 - dx * 7, y1 - dy * 7, x1, y1],
    [x2, y2, x2 + dx * 7, y2 + dy * 7],
  ], THIN);
  arrowhead(page, x1, y1, dx, dy);
  arrowhead(page, x2, y2, -dx, -dy);

  if (outside === 'below') {
    page.text(label, (x1 + x2) / 2, Math.max(y1, y2) + bar + size, { size, align: 'center' });
  } else if (outside === 'above') {
    page.text(label, (x1 + x2) / 2, Math.min(y1, y2) - bar - 1.5, { size, align: 'center' });
  } else {
    page.text(label, Math.min(x1, x2) - bar - 2, (y1 + y2) / 2 + size * 0.35, { size, align: 'right' });
  }
}

/** Draws `data`'s four views, each round its centre in VIEW_CENTRES. Returns the lowest y used. */
function drawViews(page, data) {
  const { geometry, measurements: m, shown, ids } = data;
  const radius = Math.max(...geometry.positions.map(p => Math.hypot(p.x, p.y)));
  const scale = Math.min(MAX_RADIUS / radius, MAX_HEIGHT / (m.height || 1));
  const views = viewsFor(m.frame, (m.top + m.bottom) / 2);
  // A point `along` the long axis and `across` it, at height `z`, for placing the dimensions.
  const { frame } = m;
  const at = (along, across, z) => ({
    x: along * frame.along.x + across * frame.across.x,
    y: along * frame.along.y + across * frame.across.y,
    z,
  });
  const toPage = (name, p) => {
    const [across, down] = views[name].place(p);
    const [cx, cy] = VIEW_CENTRES[name];

    return [cx + across * scale, cy + down * scale];
  };

  for (const name of Object.keys(views)) {
    const edges = visibleEdges(geometry, views[name].toward);

    page.lines(edges.map(([a, b]) => [
      ...toPage(name, geometry.positions[a]),
      ...toPage(name, geometry.positions[b]),
    ]), EDGE_WIDTH);
  }

  // The crown view's index numbers, on the major teeth the ruler and the dial number
  // (bigTickStep), just outside the stone. Tooth 0 is marked with the gear's size in angle
  // brackets instead, a little further out, as in the example.
  const teeth = shown.gear.teeth;
  const step = bigTickStep(teeth);
  const [cx, cy] = VIEW_CENTRES.crown;
  const labelSize = 6.5;

  for (let index = 0; index < teeth; index += step) {
    const facing = globalThis.GemCadDesign.normalOf(shown, 90, index);
    const reach = Math.hypot(facing.x, facing.y);

    if (!(reach > 0)) {
      continue;
    }

    const [across, down] = views.crown.place({ x: facing.x / reach, y: facing.y / reach, z: 0 });
    const distance = radius * scale + (index === 0 ? 20 : 11);

    page.text(index === 0 ? `<${teeth}>` : String(index), cx + across * distance,
      cy + down * distance + labelSize * 0.35, { size: labelSize, align: 'center' });
  }

  // Tier names on the crown and pavilion views, run out from the middle 25 degrees right of
  // straight down, as in the example, and the girdle's under the pavilion view, where its
  // edge-on facets are. Not 30: on a 96 gear that is tooth 8 exactly, halfway between a
  // six-fold tier's teeth 0 and 16, and the example names such a tier on tooth 0.
  const prefer = [Math.sin(Math.PI * 25 / 180), Math.cos(Math.PI * 25 / 180)];
  const label = (name, spot) => {
    const [x, y] = toPage(name, { x: 0, y: 0, z: 0 });
    const size = 6;

    page.text(ids[spot.tier], x + spot.at[0] * scale, y + spot.at[1] * scale + size * 0.35,
      { size, align: 'center' });
  };
  const tiers = shown.tiers;

  for (const spot of tierLabelSpots(geometry, views.crown, t => !isPavilionTier(tiers[t]), prefer)) {
    label('crown', spot);
  }

  for (const spot of tierLabelSpots(geometry, views.pavilion,
    t => isPavilionTier(tiers[t]) && !isGirdleTier(tiers[t]), prefer)) {
    label('pavilion', spot);
  }

  const girdleIds = tiers.map((tier, t) => (isGirdleTier(tier) ? ids[t] : null)).filter(Boolean);
  const [px, py] = VIEW_CENTRES.pavilion;
  const pavilionBottom = py + m.maxAcross * scale;

  if (girdleIds.length > 0) {
    page.line(px, pavilionBottom + 1.5, px, pavilionBottom + 5, THIN);
    page.text(girdleIds.join(' '), px, pavilionBottom + 11, { size: 6, align: 'center' });
  }

  // The measurements. Side view: W (across the long axis) at the right, T (the table, the same
  // way) at the left.
  const side = p => toPage('side', p);
  const sideRight = side(at(0, 0, m.bottom))[0];
  const sideLeft = side(at(0, 0, m.top))[0];

  dimension(page, [sideRight + 10, side(at(0, m.minAcross, 0))[1]],
    [sideRight + 10, side(at(0, m.maxAcross, 0))[1]], 'W', 'left');

  if (m.table) {
    dimension(page, [sideLeft - 10, side(at(0, m.table.minAcross, 0))[1]],
      [sideLeft - 10, side(at(0, m.table.maxAcross, 0))[1]], 'T', 'left');
  }

  // Front view: C and P at the left, U (the table, along the long axis) above, L below. A
  // table too narrow to hold its label inside has it above the line, clear of the crown.
  const front = p => toPage('front', p);
  const frontLeft = front(at(m.minAlong, 0, 0))[0] - 10;
  const frontTop = front(at(0, 0, m.top))[1];
  const frontBottom = front(at(0, 0, m.bottom))[1];

  if (m.crownBottom !== null) {
    dimension(page, [frontLeft, frontTop], [frontLeft, front(at(0, 0, m.crownBottom))[1]],
      'C', 'left');
  }

  if (m.pavilionTop !== null) {
    dimension(page, [frontLeft, front(at(0, 0, m.pavilionTop))[1]], [frontLeft, frontBottom],
      'P', 'left');
  }

  if (m.table) {
    dimension(page, [front(at(m.table.minAlong, 0, 0))[0], frontTop - 10],
      [front(at(m.table.maxAlong, 0, 0))[0], frontTop - 10], 'U', 'above');
  }

  dimension(page, [front(at(m.minAlong, 0, 0))[0], frontBottom + 12],
    [front(at(m.maxAlong, 0, 0))[0], frontBottom + 12], 'L', 'below');

  return Math.max(frontBottom + 22, pavilionBottom + 14);
}

/**
 * One of the left column's tables: a bold heading over a rule, then its rows. `columns` gives,
 * for each cell of a row, the x its text is centred on; `divider` an x for a vertical rule
 * between the halves, if any. Returns the y below the table.
 */
function drawTable(page, y, heading, rows, columns, divider, boldLast) {
  page.text(heading, COLUMN.middle, y, { font: 'helvetica-bold', size: 9.5, align: 'center' });
  page.line(COLUMN.left, y + 3.5, COLUMN.right, y + 3.5, 0.9);

  const top = y + 3.5;
  let rowY = y + 13;

  rows.forEach((cells, r) => {
    const font = boldLast && r === rows.length - 1 ? 'helvetica-bold' : 'helvetica';

    cells.forEach((cell, c) => {
      page.text(cell, columns[c], rowY, { font, size: 7.5, align: 'center' });
    });
    rowY += 9.5;
  });

  if (divider !== null) {
    page.line(divider, top, divider, rowY - 6, 1.6);
  }

  return rowY + 10;
}

/** Draws the title, the byline and the three tables in the left column. Returns the y below. */
function drawHeader(page, data) {
  let y = 58;
  const titleSize = 22;
  const titleWidth = page.text(data.title || 'Untitled', COLUMN.middle, y,
    { font: 'times-bold', size: titleSize, align: 'center' });

  page.line(COLUMN.middle - titleWidth / 2, y + 4, COLUMN.middle + titleWidth / 2, y + 4, 1.5);
  y += 17;

  for (const line of [data.byline, ...data.headers].filter(Boolean)) {
    for (const wrapped of wrapText(line, 'helvetica', 7.5, COLUMN.right - COLUMN.left)) {
      page.text(wrapped, COLUMN.middle, y, { size: 7.5, align: 'center' });
      y += 9;
    }
  }

  y += 16;
  y = drawTable(page, y, 'Facet Data', data.facetRows, [66, 104, 154, 196], 118, true);
  y = drawTable(page, y, 'Size Data', data.sizeRows, [64, 104, 156, 192], 130, false);
  y = drawTable(page, y, 'Design Data', data.designRows, [84, 160], null, false);

  return y;
}

/**
 * Draws the cutting instructions from `y` down, on as many pages as they need, then the
 * footnotes. `nextPage` starts a new page and returns it.
 */
function drawInstructions(firstPage, y, data, nextPage) {
  let page = firstPage;
  const room = needed => {
    if (y + needed > PAGE_BOTTOM) {
      page = nextPage();
      y = MARGIN + 14;
    }
  };

  for (const section of data.sections) {
    room(16 + ROW_LEADING);
    page.text(section.heading, MARGIN - 12, y, { font: 'helvetica-bold', size: 10.5 });
    y += 16;

    for (const row of section.rows) {
      const indices = wrapText(row.indices, 'helvetica', ROW_SIZE, INDICES_WIDTH, '-');
      const notes = row.notes ? wrapText(row.notes, 'helvetica', ROW_SIZE, NOTES_WIDTH) : [];
      const lines = Math.max(indices.length, notes.length, 1);

      room(lines * ROW_LEADING);
      page.text(row.id, COLUMNS.id, y, { size: ROW_SIZE });
      page.text(row.angle, COLUMNS.angle, y, { size: ROW_SIZE });
      indices.forEach((line, i) => page.text(line, COLUMNS.indices, y + i * ROW_LEADING, { size: ROW_SIZE }));
      notes.forEach((line, i) => page.text(line, COLUMNS.notes, y + i * ROW_LEADING, { size: ROW_SIZE }));
      y += lines * ROW_LEADING + 2;
    }

    y += 4;
  }

  if (data.footnotes.length > 0) {
    y += 6;

    for (const note of data.footnotes) {
      for (const line of wrapText(note, 'helvetica', ROW_SIZE, 576 - MARGIN)) {
        room(ROW_LEADING);
        page.text(line, MARGIN - 12, y, { size: ROW_SIZE });
        y += ROW_LEADING;
      }
    }
  }
}

/** The sheet for `data` (`sheetData`) as a PDF document. */
export function sheetToPdf(data) {
  const pdf = new PdfDocument({ title: data.title, author: data.byline });
  const first = pdf.addPage();
  const headerBottom = drawHeader(first, data);
  const viewsBottom = drawViews(first, data);

  drawInstructions(first, Math.max(headerBottom, viewsBottom) + 14, data, () => pdf.addPage());

  return pdf;
}

/**
 * The PDF file for `design`, as bytes. Options are `sheetData`'s. Throws for a design that builds
 * no stone.
 */
export function designToPdf(design, options = {}) {
  return sheetToPdf(sheetData(design, options)).toBytes();
}

/**
 * File > Export > PDF's `onSelect`: builds the sheet for the loaded design and saves it through
 * `saveFileAs`, or shows why it could not. A no-op without a loaded design (the built-in stone or
 * a plain .obj has none), like the other design exports. The filename is the cut header's name.
 */
export async function exportPdf() {
  const design = getDesign();

  if (!design) {
    return;
  }

  const meta = get(cutMeta);
  const app = engine.app;
  let bytes;

  try {
    bytes = designToPdf(design, {
      title: meta.name,
      author: meta.author,
      date: meta.date,
      decimals: get(angleDecimals),
      refractiveIndex: app ? app.get_param('refractiveIndex') : undefined,
    });
  } catch (cause) {
    showLoadAlert('Could not export this design to PDF', String(cause));
    return;
  }

  await saveFileAs(pdfFilename(meta.name), new Blob([bytes], { type: 'application/pdf' }), {
    description: 'PDF document',
    mimeType: 'application/pdf',
    extensions: ['.pdf'],
  });
}
