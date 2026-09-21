/*
 * export_gcs.js -- writes a loaded design back out as a Gem Cut Studio .gcs file, the inverse of
 * `src/js/gcs.js` (`GemCutStudio.importText`), which documents the format.
 *
 * Unlike a GemCad .asc (export_asc.js), a .gcs stores GEOMETRY: every facet carries its outward
 * normal and its corner vertices, on top of the polar description (tier angle, depth, index
 * position). The polar description is transcribed field by field, as export_asc.js does; the
 * corners come from `DesignMesh.buildFaces` and `weldFaces` (design_mesh.js), which clip one
 * polygon per facet plane and weld shared corners -- the same builder the rendered stone comes
 * from, so the file describes exactly the stone on screen, and each polygon comes with the tier
 * and facet it belongs to.
 *
 * WHAT IS CONVERTED, and why each is the inverse of what the reader does:
 *
 *   - `tier/@angle` is a POLAR angle; the design stores a signed MAST angle. The reader applies
 *     `GemCadDesign.mastAngleOf`, so this applies `polarAngleOf`.
 *   - `facet/@index_angle` is not the tooth. The reader's `toothFromIndexAngle` maps it to a
 *     tooth with MIRRORED formulas for the crown and for the pavilion and girdle (see that
 *     function's comment for the measurement): `tooth = (180 - ia) / step + origin` for a crown
 *     facet and `(180 + ia) / step + origin` for the rest. `indexAngleOf` below solves both
 *     for `ia`, and lands it in [0, 360) as every real file does.
 *   - the vertices are wound the way real files wind them, which is the opposite of an
 *     outward counter-clockwise loop (measured on all 1620 facets of the 29 files under
 *     reference/gemology-project-designs and the startup stone, none the other way).
 *
 * A REVERSED GEAR (a negative tooth count, from a GemCad file) has no counterpart in the
 * reader's index-angle arithmetic, which uses the unsigned step. The design is re-expressed on
 * the same wheel run forwards first (`GemCadDesign.reExpressOnGear`): the geometry is untouched
 * and only the tooth numbers change, so the file is one the reader reads back consistently.
 *
 * WHAT IS NOT WRITTEN. A tier's PREFORM mark: the format has no attribute for it. Everything
 * else the design carries is written back (T-0214), which is what makes a file survive being
 * opened and exported again: the header and footer comments as `<info>`'s own `headerN`/
 * `footerN` attributes, the rest of `<info>` (shape, size and RI bounds), the `<render>` block
 * the file arrived with, each tier's own `name` and `guide` flag, and a frosted facet's
 * `frosting`. A tier's hidden mark is written as `visible="false"`, which the reader reads back
 * as hidden. A facet no plane of the stone reaches (its half-space is redundant
 * and it has no face) has no corners to write, and the reader refuses a facet with fewer than
 * three and a tier with none, so such facets, and the tiers left empty by that, are left out and
 * counted in the result for the caller to report.
 *
 * A HIDDEN tier's planes are still cut into the stone for its corners: a hidden tier is only
 * hidden from the render, and leaving it out of the geometry would mean it had no corners to
 * write and vanished from the file.
 *
 * `<render>` is written for Gem Cut Studio's benefit only; this project's reader records it on
 * the design but never applies it to the page's own material (see gcs.js). Line endings are CRLF, as in every file Gem Cut Studio writes.
 */
import { getDesign } from './tier_controller.js';
import { cutMeta, engine, showLoadAlert } from './stores.js';
import { saveFileAs } from './export_file.js';
import { tierIdsInFileOrder } from './tiers.js';
import { get } from 'svelte/store';

/** Used when the cut name is empty or not filename-safe on its own. */
const FALLBACK_NAME = 'stone';

/** Same tolerance as `GIRDLE_ANGLE_EPSILON` in gcs.js: within this of 90 is the girdle side. */
const GIRDLE_ANGLE_EPSILON = 1e-6;

/** `.gcs` version attribute, as in every file examined. */
const GCS_VERSION = '1000';

/** Gem Cut Studio's line ending. */
const EOL = '\r\n';

/** The frosting amount every frosted facet in the corpus carries; see the facet loop. */
const DEFAULT_FROSTING = 0.5;

/**
 * `name` turned into a safe `.gcs` filename, by the same rule as `objFilename` in export_obj.js.
 */
export function gcsFilename(name) {
  const cleaned = (name || '').trim().replace(/[\\/:*?"<>|]/g, '');

  return `${cleaned || FALLBACK_NAME}.gcs`;
}

/**
 * `text` as an XML attribute value. Besides the five markup characters, tabs and line breaks
 * become character references, because a raw one inside an attribute is read back as a space.
 * `gcs.js` decodes all of these.
 */
export function escapeXmlAttribute(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

/**
 * A number as text that reads back as the identical double: JavaScript's shortest
 * round-tripping form, as export_asc.js writes them. (`-0` becomes `0`.)
 */
function formatNumber(value) {
  return String(value);
}

/** `<name attr="value" .../>` or, with `children`, `<name attr="value" ...>` for the caller to close. */
function openTag(name, attributes, selfClosing) {
  const text = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${escapeXmlAttribute(value)}"`)
    .join('');

  return `<${name}${text}${selfClosing ? '/' : ''}>`;
}

/**
 * The `index_angle` attribute for a facet cut at `tooth`: the inverse of gcs.js's
 * `toothFromIndexAngle`, in degrees within [0, 360). On the optical axis (the table or a culet)
 * the index is meaningless and the reader does not check it, so it is 0.
 *
 * `azimuth = (tooth - originIndex) * step`; the reader takes `180 - ia` (crown) or `180 + ia`
 * (pavilion and girdle, decided by the RAW polar angle, as the reader does) to be the azimuth.
 */
export function indexAngleOf(design, tier, facet, onAxis) {
  if (onAxis) {
    return 0;
  }

  const step = 360 / design.gear.teeth;
  const azimuth = (facet.index - design.gear.originIndex) * step;
  const polarAngle = globalThis.GemCadDesign.polarAngleOf(tier.angle);
  const pavilionOrGirdle = polarAngle >= 90 - GIRDLE_ANGLE_EPSILON;
  const angle = pavilionOrGirdle ? azimuth - 180 : 180 - azimuth;

  return ((angle % 360) + 360) % 360;
}

/**
 * The `<info>` element's attributes: the cut header's title/author/date (or the design's own,
 * when the caller supplies none), the rest of the design's `info` block, and its header and
 * footer comments as `headerN`/`footerN`.
 *
 * The comments are the only home a `.gcs` has for them -- there are no `H`/`F` lines here --
 * and the reader reads them back from exactly these attributes. Numbering is 1-based and
 * dense, so a design whose file had a gap (`header2` with no `header1`, most of the corpus)
 * comes back renumbered from 1; the text and its order are what survive, not the numbering.
 * An attribute is written only when it has a value, as the corpus's own files do.
 */
function infoAttributes(design, { title, author, date }) {
  const info = design.info || {};
  const attributes = {
    title: title || info.title || '',
    author: author || info.author || '',
    date: date || info.date || '',
  };

  if (info.shape) {
    attributes.shape = info.shape;
  }

  for (const [key, value] of [['size_min', info.sizeMin], ['size_max', info.sizeMax],
    ['ri_min', info.riMin], ['ri_max', info.riMax]]) {
    if (Number.isFinite(value)) {
      attributes[key] = formatNumber(value);
    }
  }

  (design.headers || []).forEach((line, at) => {
    attributes[`header${at + 1}`] = line;
  });

  (design.footnotes || []).forEach((line, at) => {
    attributes[`footer${at + 1}`] = line;
  });

  return attributes;
}

/**
 * `polygon` wound the way Gem Cut Studio winds its facets: its Newell vector points AGAINST the
 * outward `normal`. Decided from the polygon itself, not from which way the mesh builder wound
 * it, so it does not depend on that builder's convention.
 */
function windLikeGcs(polygon, normal) {
  let x = 0;
  let y = 0;
  let z = 0;

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];

    x += (a.y - b.y) * (a.z + b.z);
    y += (a.z - b.z) * (a.x + b.x);
    z += (a.x - b.x) * (a.y + b.y);
  }

  const alongNormal = x * normal.x + y * normal.y + z * normal.z;

  return alongNormal > 0 ? polygon.slice().reverse() : polygon;
}

/**
 * The design as `.gcs` text.
 *
 * `{ title, author, date }` are the cut header's fields (`cutMeta`, stores.js), for `<info>`;
 * `refractiveIndex` and `dispersion` are the material in use, for `<render>`. All are optional.
 *
 * Returns `{ text, omittedFacets, omittedTiers }`: see the header comment for what is left out.
 * Throws, as `DesignMesh.buildFaces` does, for a design that builds no stone.
 */
export function designToGcs(design, { title, author, date, refractiveIndex, dispersion } = {}) {
  const GemCadDesign = globalThis.GemCadDesign;

  // See the header comment: the reader's index arithmetic is for a forward wheel.
  const forward = design.gear.reversed
    ? GemCadDesign.reExpressOnGear(design, { teeth: design.gear.teeth, reversed: false })
    : design;

  // See the header comment: every tier is cut, so a hidden one still has corners.
  const cutEverything = {
    ...forward,
    tiers: forward.tiers.map(tier => ({ ...tier, hidden: false })),
  };
  const { DesignMesh } = globalThis;
  const built = DesignMesh.buildFaces(cutEverything);

  // Welded exactly as the rendered stone's OBJ is (`DesignMesh.toObjText`): two corners of a
  // face that the clips left a hair apart (1.75e-7 at the startup stone's meet-point tier) are
  // one corner, as they are in the file that stone was read from, and a shared corner is the
  // same point in every facet that has it.
  const welded = DesignMesh.weldFaces(built, DesignMesh.defaults.weldTolerance);
  const cornersOf = new Map();

  for (const loop of welded.loops) {
    cornersOf.set(`${loop.tier}:${loop.facet}`, {
      polygon: loop.indices.map(index => welded.positions[index]),
      normal: built.planes[loop.planeIndex].normal,
    });
  }

  const ids = tierIdsInFileOrder(forward.tiers);
  const lines = [];
  let omittedFacets = 0;
  let omittedTiers = 0;

  lines.push(openTag('GemCutStudio', { version: GCS_VERSION }, false));
  lines.push(`    ${openTag('index', {
    gear: forward.gear.teeth,
    base: formatNumber(forward.gear.originIndex),
    symmetry: forward.symmetry.folds,
    mirror: forward.symmetry.mirror ? 1 : 0,
  }, true)}`);

  forward.tiers.forEach((tier, t) => {
    const facetLines = [];

    tier.facets.forEach((facet, f) => {
      const corners = cornersOf.get(`${t}:${f}`);

      if (!corners) {
        omittedFacets += 1;
        return;
      }

      const { polygon, normal } = corners;

      // `frosting` is written only for a frosted facet, as the format does: every frosted
      // facet in the corpus carries 0.5 and no other facet carries the attribute at all. A
      // facet keeps its own amount when it has one (from a file), and takes the tier's mark
      // at the corpus's own 0.5 when the tier was frosted here, on the page.
      const frosting = facet.frosting > 0
        ? facet.frosting
        : tier.frosted ? DEFAULT_FROSTING : 0;

      facetLines.push(`        ${openTag('facet', Object.assign({
        nx: formatNumber(normal.x),
        ny: formatNumber(normal.y),
        nz: formatNumber(normal.z),
        index_angle: formatNumber(
          indexAngleOf(forward, tier, facet, GemCadDesign.polarOf(forward, normal).onAxis)
        ),
      }, frosting > 0 ? { frosting: formatNumber(frosting) } : {}), false)}`);

      for (const point of windLikeGcs(polygon, normal)) {
        facetLines.push(`            ${openTag('vertex', {
          x: formatNumber(point.x),
          y: formatNumber(point.y),
          z: formatNumber(point.z),
        }, true)}`);
      }

      facetLines.push('        </facet>');
    });

    // The reader refuses a tier with no facet, so it cannot be written.
    if (facetLines.length === 0) {
      omittedTiers += 1;
      return;
    }

    // The tier's own name from the file wins over the id this page generates. They are the
    // same for 27 of the corpus's 29 designs, but not always: our rule calls a tier the
    // girdle only within TIER_ANGLE_EPSILON of 90, while Gem Cut Studio's own naming is far
    // looser (TriZag_A's G1 sits at polar 90.0017, Random_Number_Generator_M2's G2 at
    // 90.0020), so regenerating would rename those tiers in their own file.
    lines.push(`    ${openTag('tier', {
      angle: formatNumber(GemCadDesign.polarAngleOf(tier.angle)),
      depth: formatNumber(tier.distance),
      name: tier.name || ids[t],
      instructions: tier.cuttingInstructions || '',
      visible: tier.hidden ? 'false' : 'true',
      guide: tier.guide ? 'true' : 'false',
    }, false)}`);
    lines.push(...facetLines);
    lines.push('    </tier>');
  });

  // The material the page is rendering with wins, then the design's own <render> (kept by the
  // reader but never applied, see gcs.js), then the format's own defaults. Everything the
  // caller does not supply comes from the design's <render> so that a file opened and
  // exported again keeps the block it arrived with instead of being reset to "Random".
  const render = forward.render || {};
  const index = Number.isFinite(refractiveIndex) && refractiveIndex > 0
    ? refractiveIndex
    : forward.refractiveIndex > 0 ? forward.refractiveIndex
      : render.refractiveIndex > 0 ? render.refractiveIndex : 1.54;
  const colour = render.color || { r: 1, g: 1, b: 1 };

  lines.push(`    ${openTag('render', {
    material: render.material || '(from file)',
    refractive_index: formatNumber(index),
    dispersion: formatNumber(
      Number.isFinite(dispersion) ? dispersion
        : Number.isFinite(render.dispersion) ? render.dispersion : 0
    ),
    clarity: formatNumber(Number.isFinite(render.clarity) ? render.clarity : 100),
    density: formatNumber(Number.isFinite(render.density) ? render.density : 1),
    lighting_model: render.lightingModel || 'Random',
  }, false)}`);
  lines.push(`        ${openTag('color', {
    r: formatNumber(colour.r), g: formatNumber(colour.g), b: formatNumber(colour.b),
  }, true)}`);
  lines.push('    </render>');
  lines.push(`    ${openTag('info', infoAttributes(forward, { title, author, date }), true)}`);
  lines.push('</GemCutStudio>');

  return { text: lines.join(EOL) + EOL, omittedFacets, omittedTiers };
}

/**
 * File > Export > Gem Cut Studio (.gcs)'s `onSelect`: builds the file for the loaded design and
 * saves it through `saveFileAs`, or shows why it could not. A no-op without a loaded design (the
 * built-in stone or a plain .obj has none), like the .asc export. The filename is the cut
 * header's name, and the material is the one currently in use.
 */
export async function exportGcs() {
  const design = getDesign();

  if (!design) {
    return;
  }

  const meta = get(cutMeta);
  const app = engine.app;
  let result;

  try {
    result = designToGcs(design, {
      title: meta.name,
      author: meta.author,
      date: meta.date,
      refractiveIndex: app ? app.get_param('refractiveIndex') : undefined,
      dispersion: app ? app.get_param('dispersion') : undefined,
    });
  } catch (cause) {
    showLoadAlert('Could not export this design to GCS', String(cause));
    return;
  }

  await saveFileAs(gcsFilename(meta.name), result.text, {
    description: 'Gem Cut Studio design',
    mimeType: 'application/xml',
    extensions: ['.gcs'],
  });

  if (result.omittedFacets > 0) {
    showLoadAlert(
      'Exported with some facets left out',
      `${result.omittedFacets} facet(s) do not touch the stone, so they have no corners to ` +
      `write and are not in the file (${result.omittedTiers} tier(s) were left empty and ` +
      'left out too).'
    );
  }
}
