// The stone's proportions, shown in the bottom right of the renderer (2026-09-19, the user's
// request): the number of facets, and T/W, C/W and P/W, the ratios a faceting design is usually
// described by. Worked out from the OBJ text the stone was loaded from -- the very mesh Rust
// renders, whichever way it arrived (the startup stone, an opened file, a rebuild after a tier
// edit) -- in the file's own frame, optical axis +Z, table up.
//
// The user's definitions:
//   T/W  the table's width along the stone's LONG axis / the girdle's width across its SHORT axis
//   C/W  crown height / girdle width across the short axis
//   P/W  pavilion height / girdle width across the short axis
//
// How each part is found:
//   - The FACET COUNT is GemApp's own (`facet_count()`), the facets the stone is rendered and
//     clicked by: Rust groups triangles into facets across shared edges within about 0.1 degree.
//     Grouping here by plane alone disagreed with it both ways (measured 2026-09-19): it merged 5
//     pairs of Pink Star's nearly coplanar but separate facets (109 against 114), and split an
//     exported oval's slightly noisy triangles (71 against 67).
//   - For the rest, faces are grouped by plane (a plain .obj may split a facet into triangles);
//     the grouping only decides which facets are crown, pavilion or girdle, which a merge or a
//     split of two nearly coplanar faces cannot change.
//   - Its side comes from its outward normal's z: up is crown (the table included), down is
//     pavilion, level (within GIRDLE_TILT) is a girdle facet.
//   - W is the stone's width across its short axis: the narrowest of its widths seen from above,
//     measured across every direction (the minimum caliper width of its outline). The long axis
//     is square to that direction. For an oval that is the width and the length; for a hexagon,
//     flat to flat and point to point.
//   - The table is the facet facing straight up; its width is its extent along the long axis. A
//     stone with no table (a pointed crown) has no T/W.
//   - Crown height runs from the lowest point of any crown facet (where the crown meets the
//     girdle) to the top of the stone; pavilion height from the bottom of the stone to the
//     highest point of any pavilion facet. So a girdle's own height is in neither, and a stone
//     with a knife-edge girdle is measured the same way.
//
// It also measures the girdle's own circle (`girdleRadius`, `girdleZ`), which nothing here shows:
// it is what the index dial is drawn round (index_dial.js, 2026-09-19). Measured here because
// this is already the one place that reads the stone's own mesh on every load and rebuild, so
// the dial gets a size that follows the stone for free.

import { stoneStatsStore } from './stores.js';

// A facet whose normal is within this of level (sin of about 0.6 degrees) is a girdle facet.
const GIRDLE_TILT = 0.01;

// A facet whose normal is within this of straight up is the table.
const TABLE_TILT = 1e-4;

// Two faces are on the same plane when their normals and their distances from the origin agree
// this closely (the distance relative to the stone's size).
const PLANE_TOLERANCE = 1e-4;

/** The vertices ([x, y, z]) and faces (arrays of vertex indices, from 0) of OBJ text. */
export function parseObj(text) {
  const vertices = [];
  const faces = [];

  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);

    if (parts[0] === 'v') {
      vertices.push(parts.slice(1, 4).map(Number));
    } else if (parts[0] === 'f') {
      // "f 1 2 3", "f 1/1 2/2 3/3" or "f 1//1 ...": the vertex index is before the first slash;
      // a negative one counts back from the vertices read so far.
      faces.push(parts.slice(1).map(part => {
        const index = parseInt(part.split('/')[0], 10);
        return index < 0 ? vertices.length + index : index - 1;
      }));
    }
  }

  return { vertices, faces };
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** A face's unit normal (by Newell's method, so a polygon of any size is fine), or null. */
function faceNormal(vertices, face) {
  const sum = [0, 0, 0];

  for (let i = 0; i < face.length; i++) {
    const a = vertices[face[i]];
    const b = vertices[face[(i + 1) % face.length]];
    sum[0] += (a[1] - b[1]) * (a[2] + b[2]);
    sum[1] += (a[2] - b[2]) * (a[0] + b[0]);
    sum[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }

  const length = Math.hypot(...sum);
  return length > 0 ? sum.map(v => v / length) : null;
}

/**
 * The facets of a mesh: its faces grouped by plane, each `{ normal, vertices }` where vertices
 * are indices. The normals point out of the stone: the face winding is not relied on, only that
 * the stone is convex, so a normal pointing towards the stone's centre is turned round.
 */
export function facetsOf({ vertices, faces }) {
  const centre = vertices.reduce((sum, v) => [sum[0] + v[0], sum[1] + v[1], sum[2] + v[2]], [0, 0, 0])
    .map(v => v / vertices.length);
  const size = Math.max(...vertices.map(v => Math.hypot(...subtract(v, centre))), 1e-12);
  const facets = [];

  for (const face of faces) {
    let normal = faceNormal(vertices, face);

    if (!normal) {
      continue;
    }

    if (dot(normal, subtract(vertices[face[0]], centre)) < 0) {
      normal = normal.map(v => -v);
    }

    const offset = dot(normal, vertices[face[0]]);
    const same = facets.find(facet => dot(facet.normal, normal) > 1 - PLANE_TOLERANCE
      && Math.abs(facet.offset - offset) < PLANE_TOLERANCE * size);

    if (same) {
      face.forEach(index => same.vertices.add(index));
    } else {
      facets.push({ normal, offset, vertices: new Set(face) });
    }
  }

  return facets.map(({ normal, vertices: indices }) => ({ normal, vertices: [...indices] }));
}

/** The convex hull of 2D points, counter-clockwise (Andrew's monotone chain). */
function hull2d(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = list => {
    const out = [];

    for (const p of list) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= 0) {
        out.pop();
      }

      out.push(p);
    }

    out.pop();
    return out;
  };

  return [...half(sorted), ...half([...sorted].reverse())];
}

/**
 * The stone's outline seen from above: its width across the short axis, and the long axis's
 * direction (a unit 2D vector). The narrowest width of a convex outline is always across one of
 * its edges, so only those directions need trying.
 */
export function girdleAxes(points2d) {
  const hull = hull2d(points2d);
  let best = null;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);

    if (length === 0) {
      continue;
    }

    const along = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const across = [-along[1], along[0]];
    const reach = hull.map(p => (p[0] - a[0]) * across[0] + (p[1] - a[1]) * across[1]);
    const width = Math.max(...reach) - Math.min(...reach);

    if (!best || width < best.width - 1e-12) {
      best = { width, longAxis: along };
    }
  }

  return best;
}

function extent(values) {
  return Math.max(...values) - Math.min(...values);
}

/**
 * The girdle's circle seen from above, for whatever is drawn round the stone: `{ radius, z }`,
 * where `radius` is how far the stone reaches from the optical axis -- HALF its longest axis,
 * since a design is cut about the axis -- and `z` the middle of the height at which it reaches
 * that far (the middle of a girdle band, the girdle's own height for a knife edge). Null for a
 * mesh with no width at all. Note this is the LONG axis, where `girdleAxes` above measures the
 * short one: the ratios divide by the narrow width, but a circle drawn round the stone has to
 * clear the wide one.
 */
export function girdleCircle(vertices) {
  const radii = vertices.map(v => Math.hypot(v[0], v[1]));
  const radius = Math.max(...radii);

  if (!(radius > 0)) {
    return null;
  }

  // Everything as far out as the stone reaches, to within rounding: the girdle. Its middle
  // height, so a band's dial sits halfway up it rather than on one of its edges.
  const zs = vertices.filter((_, i) => radii[i] >= radius * (1 - 1e-9)).map(v => v[2]);

  return { radius, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
}

/**
 * The stats for the stone in `objText`: `{ facets, tw, cw, pw, girdleRadius, girdleZ }`, where a
 * ratio the stone does not have (no table, no crown, no pavilion) is null. Null altogether if
 * the text holds no stone. `facetCount` is the renderer's own count, used when given; without it
 * (the tests) the count is of the planes found here.
 */
export function stoneStats(objText, facetCount = null) {
  const mesh = parseObj(objText);

  if (mesh.vertices.length < 4 || mesh.faces.length < 4) {
    return null;
  }

  const facets = facetsOf(mesh);
  const axes = girdleAxes(mesh.vertices.map(v => [v[0], v[1]]));

  if (!axes || axes.width <= 0) {
    return null;
  }

  const width = axes.width;
  const heights = side => {
    const zs = facets.filter(side).flatMap(facet => facet.vertices.map(i => mesh.vertices[i][2]));
    return zs.length ? zs : null;
  };
  const crown = heights(facet => facet.normal[2] > GIRDLE_TILT);
  const pavilion = heights(facet => facet.normal[2] < -GIRDLE_TILT);
  const table = facets.find(facet => facet.normal[2] > 1 - TABLE_TILT);
  const alongLongAxis = i => mesh.vertices[i][0] * axes.longAxis[0] + mesh.vertices[i][1] * axes.longAxis[1];
  const girdle = girdleCircle(mesh.vertices);

  return {
    facets: facetCount ?? facets.length,
    tw: table ? extent(table.vertices.map(alongLongAxis)) / width : null,
    cw: crown ? extent(crown) / width : null,
    pw: pavilion ? extent(pavilion) / width : null,
    girdleRadius: girdle ? girdle.radius : null,
    girdleZ: girdle ? girdle.z : null,
  };
}

/**
 * Works out the stats for the stone `app` has just loaded from `objText` and shows them. Never
 * throws: a mesh the stats cannot make sense of shows none, rather than failing the load it
 * follows.
 */
export function showStoneStats(app, objText) {
  try {
    stoneStatsStore.set(stoneStats(objText, app.facet_count()));
  } catch (cause) {
    console.warn(`Could not work out the stone's stats: ${cause}`);
    stoneStatsStore.set(null);
  }
}
