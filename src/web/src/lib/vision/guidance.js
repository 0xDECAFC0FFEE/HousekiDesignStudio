// Scan guidance on the phone (T-0331): where the rock is, where the camera is around it, which
// sides and heights have been filmed well, what to do next, and what is wrong with the picture now.
//
// The user, 2026-10-06: "as we're scanning, i want to track the angle of the camera relative to the
// rock. I also want to add a few warnings - ex if the board is moving too fast relative to the
// camera or the rock isn't in focus it should show a warning in the middle of the screen."
//
// Everything here is plain JS with no DOM and no pixels (vision/focus.js reads those), so it runs
// in the phone's vision Worker (live.js calls createScanGuide's observe once per frame) and its
// pieces are unit-tested under Deno. The page (scanner/vision.js) turns the per-frame conditions into
// one warning at a time (createWarningFilter) and draws the coverage map (coverageMapCells); the
// studio reads the same coverage out from the vision message (coverageSummary, coverageAdvice).
//
// It follows the HousekiScanner desktop's capture check (src/houseki/pipeline/coverage.py,
// selection.py, advice.py, step2.py), which decides after the fact whether a video was filmed well;
// here the same ideas run live, so the person filming can fix a gap while still holding the phone:
//
// THE ROCK'S POSITION (coverage.axes_convergence, adapted). The desktop takes the point closest, in
// least squares, to every frame's optical axis, because whoever films a stone keeps it near the
// middle of the picture. The phone knows better than the middle of the picture: it outlines the rock.
// So each outlined frame gives the ray from the camera through the outline's centroid, and the rock
// is the point closest to all those rays (rays nearly repeating one already kept are skipped, the
// worst-fitting are dropped once, the height is kept >= 0). Until there are ROCK_MIN_VIEWS such rays
// spread over at least ROCK_MIN_SPREAD_DEG, or if the estimate lands implausibly far from the
// target, the rock is taken to be at the sheet's target centre (where the outline looks for it and
// where the person is told to put it).
//
// THE CAMERA'S ANGLE (selection.view_angles): from the rock, azimuth = atan2(Y, X) on the board
// (0 = +X, down the printed page; counter-clockwise seen from above), elevation above the board
// plane, and distance. Shown to people as the desktop's advice does: a clock position seen from above
// with the top edge of the printed sheet at 12 o'clock, and degrees above the board.
//
// COVERAGE (coverage.analyse's 30-degree azimuth sectors; advice.py's low / 45-degree / top-down
// plan). A view counts when it is one the desktop would use (step2.choose): a valid pose, the rock's
// bound wholly in the picture with MARGIN_PX to spare, the rock sharp (blur <= FOCUS_MAX_MM at the
// rock), no more than MAX_GLARE of the rock clipped white (inside its outline: focus.js says why
// not the desktop's whole window) -- and, live, steady (the board moving
// slower than MAX_SPEED_MM_S). Each such view fills the cell of its 30-degree sector in one of four
// elevation bands: below 20 degrees, 20-40, 40-60, above 60. The cells are kept as the cameras'
// positions, so when the rock's estimate moves they are worked out again from the new point.
//
// THE NEXT STEP (advice.py's order and wording, live): finish the circle the camera is on if it is
// started; else add a low circle (below 20 degrees: the desktop's "add one slow circle with the phone
// low"), then a circle at about 45 degrees (20-60), then a view from above (60+); naming the nearest
// unfilmed stretch as clock positions ("film the 3 to 5 o'clock side").

import { solveLinear } from './camera_model.js';

/** 30-degree azimuth sectors (coverage.AZ_BINS, step2._sectors). */
export const SECTOR_DEG = 30;
export const SECTORS = 12;
/** A ring with every sector filmed. */
export const FULL_RING = (1 << SECTORS) - 1;

/** Elevation bands, degrees: below 20, 20-40, 40-60, above 60. */
export const BAND_EDGES_DEG = Object.freeze([0, 20, 40, 60, 90]);

/** The desktop's blur ceiling at the stone (selection.MAX_BLUR_MM): a Gaussian sigma, mm. */
export const FOCUS_MAX_MM = 0.20;

/**
 * ... and a floor in the measured window's own pixels below which a reading is the measure's own
 * resolution limit, not blur. Measured on real capture windows (tests/fixtures/vision_focus, the
 * desktop's own numbers): sharp windows read 0.57-0.78 px, the softest the desktop accepted 1.8-2.5
 * px. Without it a low-resolution frame (a phone's 720p at 1x: ~6 px per mm) would read its sharp
 * floor as ~0.12 mm, close to the ceiling.
 */
export const FOCUS_MIN_PX = 1.2;

/** The desktop's glare ceiling (selection.MAX_GLARE): share of the window clipped white. */
export const MAX_GLARE = 0.05;

/** The rock's bound must stay this far inside every picture edge (selection.MARGIN_PX, x s). */
export const MARGIN_PX = 16;

/**
 * Faster than this (mm/s on the board, at each point's own depth) the picture blurs. Measured on the
 * desktop's five real captures (poses 0.2 s apart, against the desktop's blur at the stone and the
 * corners' sharpness): in office light the corners' median sharpness (Laplacian variance) fell from
 * 590-690 below 20 mm/s to 95 at 20-40 mm/s, 80% of them under the desktop's sharp-corner floor of
 * 100, and the blur at the stone rose from 0.06 to 0.18 mm, near its 0.20 mm ceiling; a
 * 19 ms exposure fits those numbers (blur length = speed x exposure). The careful captures' 90th
 * percentile was 10-22 mm/s.
 */
export const MAX_SPEED_MM_S = 25;

/** Poses further apart in time than this give no speed (a gap, not a motion). */
export const SPEED_MAX_GAP_MS = 400;

/** With the board lost, the last speed still counts for this long (fast motion loses the board). */
export const SPEED_HOLD_MS = 600;

/** The rock's estimate needs this many outlined views ... */
export const ROCK_MIN_VIEWS = 3;
/** ... whose rays spread over at least this angle (the smallest eigenvalue of the rays' normal
 *  matrix, per ray, is sin^2(spread / 2) for two rays). */
export const ROCK_MIN_SPREAD_DEG = 20;
/** An estimate further than this from the target (mm, on the board) is not believed. */
export const ROCK_MAX_OFFSET_MM = 40;
/** The rock's bound, a cylinder around its point, before an outline sizes it (mm). */
export const ROCK_RADIUS_MM = 12;
export const ROCK_HEIGHT_MM = 15;

/** An outline older than this (ms) is not used to count glare on the rock. */
export const CONTOUR_MAX_AGE_MS = 500;

/** Warnings show once they have held this long, and go once clear this long (ms). */
export const WARNING_ON_MS = 300;
export const WARNING_OFF_MS = 500;

/** The warnings, most important first; one shows at a time. */
export const WARNINGS = Object.freeze([
  { id: 'fast', title: 'Moving too fast', text: 'Move the phone more slowly.' },
  { id: 'edge', title: 'Rock at the edge', text: 'Keep the rock in the middle of the screen.' },
  // Not "tap to focus": a web page cannot set the camera's focus point (iOS Safari never; Android
  // Chrome only on some phones). Continuous autofocus refocuses once the phone is steady, and a
  // phone's main camera cannot focus closer than about 8-10 cm.
  { id: 'focus', title: 'Rock not in focus', text: 'Hold the phone still for a moment so it can focus, or move it a little further back.' },
  { id: 'glare', title: 'Glare on the rock', text: 'Soften the light, or tilt the phone so the bright spots go.' },
]);

const DEG = Math.PI / 180;

// --- angles and words ----------------------------------------------------------------------------

/**
 * The camera seen from the rock (selection.view_angles): { azimuthDeg (0..360, from +X towards +Y),
 * elevationDeg (above the board plane), distanceMm }.
 */
export function viewAngles(center, rock) {
  const u = [center[0] - rock[0], center[1] - rock[1], center[2] - (rock[2] ?? 0)];
  const horizontal = Math.hypot(u[0], u[1]);
  return {
    azimuthDeg: ((Math.atan2(u[1], u[0]) / DEG) % 360 + 360) % 360,
    elevationDeg: Math.atan2(u[2], horizontal) / DEG,
    distanceMm: Math.hypot(u[0], u[1], u[2]),
  };
}

/**
 * advice.clock_hour: the clock position of a camera azimuth seen from above, the top edge of the
 * printed sheet at 12. Azimuth 0 is +X (down the page, 6 o'clock), 90 is +Y (right, 3 o'clock).
 */
export function clockHour(azimuthDeg) {
  const h = (((6 - azimuthDeg / SECTOR_DEG) % 12) + 12) % 12;
  return Math.abs(h) < 1e-9 ? 12 : h;
}

/** A clock hour as a whole number, 1..12. */
export function wholeHour(hour) {
  const h = Math.round(hour) % 12;
  return h === 0 ? 12 : h;
}

/** "35° above the board, from 2 o'clock" (and the distance, when asked). */
export function angleText(view, { distance = false } = {}) {
  if (!view) {
    return '';
  }

  const cm = view.distanceMm / 10;
  const away = distance ? `, ${cm < 10 ? cm.toFixed(1) : Math.round(cm)} cm away` : '';
  return `${Math.round(view.elevationDeg)}° above the board, from ${wholeHour(clockHour(view.azimuthDeg))} o'clock${away}`;
}

/** The elevation band (0: below 20 degrees ... 3: above 60). */
export function bandOf(elevationDeg) {
  for (let band = 0; band < 3; band += 1) {
    if (elevationDeg < BAND_EDGES_DEG[band + 1]) {
      return band;
    }
  }

  return 3;
}

/** The 30-degree sector of an azimuth (0: 0-30 degrees ...). */
export function sectorOf(azimuthDeg) {
  return Math.floor((((azimuthDeg % 360) + 360) % 360) / SECTOR_DEG) % SECTORS;
}

/** How many of a ring mask's 12 sectors are filmed. */
export function sectorCount(mask) {
  let n = 0;

  for (let k = 0; k < SECTORS; k += 1) {
    n += (mask >> k) & 1;
  }

  return n;
}

/**
 * advice.empty_sectors on a ring mask: runs of unfilmed sectors, merged around the circle, as
 * [startDeg, endDeg) with endDeg past 360 for a run through 0; [[0, 360]] for an empty ring.
 */
export function emptyRuns(mask) {
  const empty = (k) => !((mask >> (((k % SECTORS) + SECTORS) % SECTORS)) & 1);

  if (mask === 0) {
    return [[0, 360]];
  }

  if ((mask & FULL_RING) === FULL_RING) {
    return [];
  }

  let start = 0;

  while (empty(start)) {
    start += 1;    // a filmed sector: runs never straddle the start
  }

  const runs = [];

  for (let i = 0; i < SECTORS;) {
    const k = (start + i) % SECTORS;

    if (empty(k)) {
      let j = i;

      while (j < SECTORS && empty(start + j)) {
        j += 1;
      }

      runs.push([k * SECTOR_DEG, k * SECTOR_DEG + (j - i) * SECTOR_DEG]);
      i = j;
    } else {
      i += 1;
    }
  }

  return runs.sort((a, b) => a[0] - b[0]);
}

/** "the 3 to 5 o'clock side" for an azimuth run [a0, a1) (advice.gap_text's clock part). */
export function runText([a0, a1]) {
  if (a1 - a0 >= 360) {
    return 'all the way round';
  }

  return `the ${wholeHour(clockHour(a1))} to ${wholeHour(clockHour(a0))} o'clock side`;
}

/** The run nearest an azimuth (0 inside it), or the first when there is no azimuth. */
function nearestRun(runs, azimuthDeg) {
  if (azimuthDeg === null || azimuthDeg === undefined) {
    return runs[0];
  }

  const gap = ([a0, a1]) => {
    const a = (((azimuthDeg - a0) % 360) + 360) % 360;
    return a < a1 - a0 ? 0 : Math.min(a - (a1 - a0), 360 - a);
  };
  return runs.reduce((best, run) => (gap(run) < gap(best) ? run : best));
}

/** The middle circle: a sector counts when either band of 20-60 degrees has it. */
const middleRing = (cover) => (cover[1] | cover[2]) & FULL_RING;

/**
 * What to do next, from the coverage (four ring masks, one per band) and the camera now (or null):
 * { id, text }. ids: 'start', 'low-ring' / 'low-gap', 'middle-ring' / 'middle-gap', 'top', 'done'.
 */
export function coverageAdvice(cover, view = null) {
  const low = cover[0] & FULL_RING;
  const middle = middleRing(cover);
  const az = view ? view.azimuthDeg : null;
  const band = view ? bandOf(view.elevationDeg) : null;
  const gap = (mask, id, prefix) => {
    const run = nearestRun(emptyRuns(mask), az);

    // An unfilmed stretch of more than half the circle reads oddly as clock hours ("the 9 to 5
    // o'clock side" spans eight hours): say it plainly.
    if (run[1] - run[0] > 180) {
      return { id, text: `${prefix}: keep going all the way round.` };
    }

    return { id, text: `${prefix}: film ${runText(run)}.` };
  };

  if (!low && !middle && !cover[3]) {
    return { id: 'start', text: 'Go slowly round the rock, keeping it in the middle of the screen.' };
  }

  // Finish the circle the camera is on first.
  if (band === 0 && low && low !== FULL_RING) {
    return gap(low, 'low-gap', 'Low circle');
  }

  if ((band === 1 || band === 2) && middle && middle !== FULL_RING) {
    return gap(middle, 'middle-gap', 'Circle at 45°');
  }

  if (low !== FULL_RING) {
    return low
      ? gap(low, 'low-gap', 'Low circle')
      : { id: 'low-ring', text: 'Add a low circle: hold the phone about 15° above the board and go all the way round.' };
  }

  if (middle !== FULL_RING) {
    return middle
      ? gap(middle, 'middle-gap', 'Circle at 45°')
      : { id: 'middle-ring', text: 'Now go round once more at about 45°.' };
  }

  if (!cover[3]) {
    return { id: 'top', text: 'Finish with a view from straight above the rock.' };
  }

  return { id: 'done', text: 'Every side and height is filmed.' };
}

/**
 * The coverage in numbers and words, for the studio's card: { low, middle (sectors of 12), top
 * (bool), text: "Low circle 5 of 12 sides · 45° circle 12 of 12 · from above: yes" }.
 */
export function coverageSummary(cover) {
  const low = sectorCount(cover[0] & FULL_RING);
  const middle = sectorCount(middleRing(cover));
  const top = Boolean(cover[3]);
  return {
    low,
    middle,
    top,
    text: `Low circle ${low} of 12 sides · 45° circle ${middle} of 12 · from above: ${top ? 'yes' : 'not yet'}`,
  };
}

// --- the coverage map ----------------------------------------------------------------------------

/** Radius on the map (0 centre .. 1 rim) of an elevation: straight down at the centre. */
export function mapRadius(elevationDeg) {
  return Math.max(0, Math.min(1, (90 - elevationDeg) / 90));
}

/**
 * A point of the map, the sheet seen from above with its top edge up: azimuth 0 (+X, down the page)
 * at the bottom, 90 (+Y, right) at the right. [x, y] in a box of -1..1, y down (SVG).
 */
export function mapPoint(azimuthDeg, elevationDeg) {
  const r = mapRadius(elevationDeg);
  const theta = (180 - azimuthDeg) * DEG;   // from 12 o'clock, clockwise
  return [r * Math.sin(theta), -r * Math.cos(theta)];
}

/**
 * The map's 48 cells (12 sectors x 4 bands) as SVG paths in the -1..1 box: [{ band, sector, d }].
 * Ring k spans the radii of its band's edges; the top band is a disc of wedges.
 */
export function coverageMapCells() {
  const cells = [];
  const f = (v) => Number(v.toFixed(4));

  for (let band = 0; band < 4; band += 1) {
    const outer = mapRadius(BAND_EDGES_DEG[band]);
    const inner = mapRadius(BAND_EDGES_DEG[band + 1]);

    for (let sector = 0; sector < SECTORS; sector += 1) {
      const a0 = sector * SECTOR_DEG;
      const a1 = a0 + SECTOR_DEG;
      const p = (az, r) => {
        const theta = (180 - az) * DEG;
        return [f(r * Math.sin(theta)), f(-r * Math.cos(theta))];
      };
      const [o0x, o0y] = p(a0, outer);
      const [o1x, o1y] = p(a1, outer);
      // azimuth grows counter-clockwise seen from above: on the map (clockwise angles) from a0 to
      // a1 is counter-clockwise, SVG sweep flag 0
      let d = `M${o0x} ${o0y}A${f(outer)} ${f(outer)} 0 0 0 ${o1x} ${o1y}`;

      if (inner > 1e-6) {
        const [i1x, i1y] = p(a1, inner);
        const [i0x, i0y] = p(a0, inner);
        d += `L${i1x} ${i1y}A${f(inner)} ${f(inner)} 0 0 1 ${i0x} ${i0y}Z`;
      } else {
        d += 'L0 0Z';
      }

      cells.push({ band, sector, d });
    }
  }

  return cells;
}

// --- the rock's position -------------------------------------------------------------------------

/** Undistorted normalised coordinates of a pixel (k1 model, fixed-point iteration). */
export function undistortPixel(intrinsics, [u, v]) {
  const xd = (u - intrinsics.cx) / intrinsics.f;
  const yd = (v - intrinsics.cy) / intrinsics.f;
  const k1 = intrinsics.k1 ?? 0;
  let x = xd;
  let y = yd;

  for (let k = 0; k < 10; k += 1) {
    const d = 1 + k1 * (x * x + y * y);
    x = xd / d;
    y = yd / d;
  }

  return [x, y];
}

/** The ray from the camera through a pixel, in the board frame: { origin (camera centre), dir }. */
export function pixelRay(pose, intrinsics, pixel) {
  const [x, y] = undistortPixel(intrinsics, pixel);
  const n = Math.hypot(x, y, 1);
  const c = [x / n, y / n, 1 / n];
  const R = pose.R;
  // R^T c: camera direction -> board
  const dir = [
    R[0] * c[0] + R[3] * c[1] + R[6] * c[2],
    R[1] * c[0] + R[4] * c[1] + R[7] * c[2],
    R[2] * c[0] + R[5] * c[1] + R[8] * c[2],
  ];
  return { origin: [...pose.center], dir };
}

/** The area centroid of a closed polygon [[x, y], ...] (the vertex mean for a degenerate one). */
export function polygonCentroid(points) {
  let area = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < points.length; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }

  if (Math.abs(area) < 1e-9) {
    return [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];
  }

  return [cx / (3 * area), cy / (3 * area)];
}

/** Eigenvalues of a symmetric 3 x 3 matrix (row-major), ascending (the trigonometric method). */
export function symmetricEigenvalues(A) {
  const p1 = A[1] ** 2 + A[2] ** 2 + A[5] ** 2;
  const q = (A[0] + A[4] + A[8]) / 3;

  if (p1 < 1e-30) {
    return [A[0], A[4], A[8]].sort((a, b) => a - b);
  }

  const p2 = (A[0] - q) ** 2 + (A[4] - q) ** 2 + (A[8] - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const B = A.map((v, i) => (v - (i % 4 === 0 ? q : 0)) / p);
  const det = B[0] * (B[4] * B[8] - B[5] * B[7]) - B[1] * (B[3] * B[8] - B[5] * B[6]) + B[2] * (B[3] * B[7] - B[4] * B[6]);
  const r = Math.max(-1, Math.min(1, det / 2));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  return [e3, 3 * q - e1 - e3, e1];
}

/**
 * The point closest, in least squares, to a set of rays { origin, dir (unit) }
 * (coverage.axes_convergence): sum (I - d d^T) p = sum (I - d d^T) o. Returns { point, minEigen (the
 * normal matrix's smallest eigenvalue per ray: how well the rays pin the point), residuals (each ray's
 * distance to the point, mm) } or null when it cannot be solved.
 */
export function raysConvergence(rays) {
  if (rays.length < 2) {
    return null;
  }

  const A = new Array(9).fill(0);
  const b = [0, 0, 0];

  for (const { origin: o, dir: d } of rays) {
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        const P = (i === j ? 1 : 0) - d[i] * d[j];
        A[3 * i + j] += P;
        b[i] += P * o[j];
      }
    }
  }

  const point = solveLinear(A, b, 3);

  if (!point || !point.every(Number.isFinite)) {
    return null;
  }

  const residuals = rays.map(({ origin: o, dir: d }) => {
    const w = [point[0] - o[0], point[1] - o[1], point[2] - o[2]];
    const along = w[0] * d[0] + w[1] * d[1] + w[2] * d[2];
    return Math.hypot(w[0] - along * d[0], w[1] - along * d[1], w[2] - along * d[2]);
  });
  return { point, minEigen: symmetricEigenvalues(A)[0] / rays.length, residuals };
}

/**
 * The rock's position from outlined views (see the header). add(ray) keeps a ray unless one already
 * kept is within 2 degrees of it from within 10 mm; estimate() -> { point [X, Y, Z] mm, from:
 * 'views' | 'target', views (rays used), spreadDeg (the rays' spread as the equivalent two-ray
 * angle), residualMm (median distance of the rays to the point) }.
 */
export function createRockLocator(targetMm, { maxRays = 300 } = {}) {
  let target = [targetMm[0], targetMm[1], targetMm[2] ?? 0];
  let rays = [];
  let cached = null;

  const fallback = (extra = {}) => ({ point: [...target], from: 'target', views: rays.length, spreadDeg: 0, residualMm: null, ...extra });

  function add(ray) {
    const n = Math.hypot(...ray.dir);
    const dir = ray.dir.map((v) => v / n);

    for (const kept of rays) {
      const cos = kept.dir[0] * dir[0] + kept.dir[1] * dir[1] + kept.dir[2] * dir[2];

      if (cos > Math.cos(2 * DEG) && Math.hypot(...kept.origin.map((v, i) => v - ray.origin[i])) < 10) {
        return false;
      }
    }

    rays.push({ origin: [...ray.origin], dir });

    if (rays.length > maxRays) {
      rays.shift();
    }

    cached = null;
    return true;
  }

  function solve() {
    if (rays.length < ROCK_MIN_VIEWS) {
      return fallback();
    }

    let fit = raysConvergence(rays);

    if (!fit) {
      return fallback();
    }

    // Drop the rays that fit worst (a bad outline) once, and solve again.
    const sorted = [...fit.residuals].sort((a, b) => a - b);
    const limit = Math.max(3, 3 * sorted[sorted.length >> 1]);
    const kept = rays.filter((_, i) => fit.residuals[i] <= limit);

    if (kept.length >= ROCK_MIN_VIEWS && kept.length < rays.length) {
      fit = raysConvergence(kept) ?? fit;
    }

    const used = kept.length >= ROCK_MIN_VIEWS ? kept.length : rays.length;
    const spreadDeg = (2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, fit.minEigen))))) / DEG;
    const point = [fit.point[0], fit.point[1], Math.max(0, fit.point[2])];
    const residuals = [...fit.residuals].sort((a, b) => a - b);
    const residualMm = residuals[residuals.length >> 1];

    if (spreadDeg < ROCK_MIN_SPREAD_DEG) {
      return fallback({ spreadDeg });
    }

    if (Math.hypot(point[0] - target[0], point[1] - target[1]) > ROCK_MAX_OFFSET_MM || point[2] > ROCK_MAX_OFFSET_MM) {
      return fallback({ spreadDeg, residualMm, rejected: point });
    }

    return { point, from: 'views', views: used, spreadDeg, residualMm };
  }

  return {
    add,
    estimate() {
      cached ??= solve();
      return cached;
    },
    reset() {
      rays = [];
      cached = null;
    },
    /** Another sheet's target (the fallback, and the centre of the plausible area). */
    setTarget(next) {
      if (next[0] !== target[0] || next[1] !== target[1]) {
        target = [next[0], next[1], next[2] ?? 0];
        cached = null;
      }
    },
    get count() {
      return rays.length;
    },
  };
}

// --- coverage ------------------------------------------------------------------------------------

/**
 * The filmed cells. add(center) records a usable view's camera position; setRock(point) works the
 * cells out again from a new rock point (when it moved more than 0.5 mm). masks() -> four 12-bit ring
 * masks (bit k: sector k), one per elevation band.
 */
export function createCoverage({ maxViews = 20000 } = {}) {
  let centres = [];
  let rock = null;
  let masks = [0, 0, 0, 0];

  const mark = (center) => {
    const view = viewAngles(center, rock);
    masks[bandOf(view.elevationDeg)] |= 1 << sectorOf(view.azimuthDeg);
  };

  return {
    add(center) {
      if (centres.length < maxViews) {
        centres.push([...center]);
      }

      if (rock) {
        mark(center);
      }
    },
    setRock(point) {
      if (rock && Math.hypot(...point.map((v, i) => v - rock[i])) <= 0.5) {
        return false;
      }

      rock = [...point];
      masks = [0, 0, 0, 0];
      centres.forEach(mark);
      return true;
    },
    masks: () => [...masks],
    get count() {
      return centres.length;
    },
    reset() {
      centres = [];
      masks = [0, 0, 0, 0];
    },
  };
}

// --- motion --------------------------------------------------------------------------------------

/** Board points every 20 mm over the 23 x 17 board (and the rock point added per call). */
function boardSamples(sizeMm, stepMm = 20) {
  const points = [];

  for (let x = stepMm / 2; x < sizeMm[0]; x += stepMm) {
    for (let y = stepMm / 2; y < sizeMm[1]; y += stepMm) {
      points.push([x, y, 0]);
    }
  }

  return points;
}

/** A board point's pixel and depth through a pose (k1 model), or null behind the camera. */
function projectWithDepth(R, t, intrinsics, P) {
  const X = R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t[0];
  const Y = R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t[1];
  const Z = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t[2];

  if (!(Z > 1)) {
    return null;
  }

  const u = X / Z;
  const v = Y / Z;
  const d = 1 + (intrinsics.k1 ?? 0) * (u * u + v * v);
  return [intrinsics.f * u * d + intrinsics.cx, intrinsics.f * v * d + intrinsics.cy, Z];
}

/**
 * How fast the board moves across the picture between two poses `dtMs` apart, in mm per second at
 * each point's own depth (image speed / (f / depth)): the median over the board points in the
 * picture now, or the rock point's when that is faster (an orbit that keeps the rock still moves the
 * board around it; a slide moves both). Both poses are projected with the same intrinsics. Returns
 * { speedMmS, boardMmS, rockMmS, points } or null.
 */
export function boardSpeed(previous, pose, intrinsics, dtMs, rockMm, samples, frame) {
  if (!(dtMs > 0)) {
    return null;
  }

  const perMm = [];
  const inside = (p) => p && p[0] >= 0 && p[1] >= 0 && p[0] <= frame.width && p[1] <= frame.height;
  const speedAt = (P) => {
    const now = projectWithDepth(pose.R, pose.t, intrinsics, P);
    const before = projectWithDepth(previous.R, previous.t, intrinsics, P);

    if (!inside(now) || !before) {
      return null;
    }

    const pxPerS = Math.hypot(now[0] - before[0], now[1] - before[1]) / (dtMs / 1000);
    return pxPerS / (intrinsics.f / now[2]);
  };

  for (const P of samples) {
    const v = speedAt(P);

    if (v !== null) {
      perMm.push(v);
    }
  }

  const rockMmS = speedAt(rockMm);
  perMm.sort((a, b) => a - b);
  const boardMmS = perMm.length >= 5 ? perMm[perMm.length >> 1] : null;

  if (boardMmS === null && rockMmS === null) {
    return null;
  }

  return { speedMmS: Math.max(boardMmS ?? 0, rockMmS ?? 0), boardMmS, rockMmS, points: perMm.length };
}

// --- the per-frame guide (in the Worker) ---------------------------------------------------------

/** The rock's bound: a cylinder of `radius` from the board to `height` around the rock, 12 x 2 points. */
function boundPoints(rock, radius, height) {
  const points = [];

  for (let k = 0; k < 12; k += 1) {
    const a = (k / 12) * 2 * Math.PI;
    const x = rock[0] + radius * Math.cos(a);
    const y = rock[1] + radius * Math.sin(a);
    points.push([x, y, 0], [x, y, height]);
  }

  return points;
}

/** Outlines whose centroid can be trusted as the rock's (types.js RockOutline flags). */
const DOUBTFUL = new Set(['no_rock', 'touches_crop_edge', 'core_not_in_crop', 'bound_not_in_front', 'bound_outside_frame']);

/**
 * The scan guide for one session: call observe() once per processed frame (live.js). Holds the
 * rock's estimate, the coverage, and the last pose for the speed.
 *
 * @param {object} options
 * @param {number[]} options.targetMm  the sheet's target centre [X, Y] (the rock's first guess)
 * @param {number[]} options.sizeMm    the chessboard's extent [X, Y]
 */
export function createScanGuide({ targetMm, sizeMm }) {
  const locator = createRockLocator(targetMm);
  const coverage = createCoverage();
  const samples = boardSamples(sizeMm);
  let previous = null;
  let lastSpeed = null;
  let sheet = null;
  let radius = ROCK_RADIUS_MM;
  let rockKnown = null;
  let lastContour = null;

  /**
   * One frame.
   *
   * @param {object} input
   * @param {{ width, height, timeMs }} input.frame
   * @param {object|null} input.pose      a VALID CameraPose of this frame, or null
   * @param {object|null} input.outline   a RockOutline found on THIS frame (with this pose), or null
   * @param {string} [input.sheet]        the current sheet's name (a change restarts the rock's rays)
   * @param {number[]} [input.targetMm]   the current sheet's target (the rock's fallback)
   * @param {(box: number[]) => object|null} [input.measure]  focus.js measure for a frame-pixel box
   *        [x0, y0, x1, y1] -> { blurPx, blurWindowPx, glare } or null
   * @returns {object} the frame's guide (see the fields below; plain data)
   */
  function observe({ frame, pose, outline = null, sheet: sheetName = null, targetMm: target = null, measure = null }) {
    const timeMs = frame.timeMs;
    const started = performance.now();

    if (sheetName && sheet && sheetName !== sheet) {
      locator.reset();
    }

    sheet = sheetName ?? sheet;

    if (target) {
      locator.setTarget(target);
    }

    if (pose && outline?.contour?.length >= 3 && !(outline.flags ?? []).some((f) => DOUBTFUL.has(f))) {
      locator.add(pixelRay(pose, pose.intrinsics, polygonCentroid(outline.contour)));
      lastContour = { contour: outline.contour, timeMs };
    }

    // The rock's outline for the glare count, while it is recent enough to still be on the rock.
    const contour = lastContour && timeMs - lastContour.timeMs <= CONTOUR_MAX_AGE_MS ? lastContour.contour : null;

    const rock = locator.estimate();
    coverage.setRock(rock.point);
    rockKnown = rock;

    const out = {
      rockMm: rock.point.map((v) => Math.round(v * 100) / 100),
      rockFrom: rock.from,
      rockViews: rock.views,
      view: null,
      speedMmS: null,
      blurMm: null,
      blurPx: null,
      blurWindowPx: null,
      glare: null,
      marginPx: null,
      windowPx: null,
      usable: false,
      reasons: [],
      conditions: { fast: false, edge: false, focus: false, glare: false },
      cover: coverage.masks(),
      views: coverage.count,
      ms: 0,
    };

    if (!pose) {
      // The board lost: fast motion often loses it, so a recent "too fast" still holds a moment.
      out.conditions.fast = Boolean(lastSpeed && timeMs - lastSpeed.timeMs <= SPEED_HOLD_MS && lastSpeed.value > MAX_SPEED_MM_S);
      out.reasons.push('no pose');
      out.ms = performance.now() - started;
      return out;
    }

    const intrinsics = pose.intrinsics;
    out.view = viewAngles(pose.center, rock.point);

    // Speed, from the last valid pose.
    if (previous) {
      const dt = timeMs - previous.timeMs;

      if (dt > 0 && dt <= SPEED_MAX_GAP_MS) {
        const speed = boardSpeed(previous.pose, pose, intrinsics, dt, rock.point, samples, frame);

        if (speed) {
          out.speedMmS = speed.speedMmS;
          lastSpeed = { value: speed.speedMmS, timeMs };
        }
      }
    }

    previous = { pose, timeMs };

    // The rock's bound sized by the outline when there is one (half its larger side plus the
    // desktop's 3 mm margin), smoothed.
    const depth = projectWithDepth(pose.R, pose.t, intrinsics, rock.point);
    const pxPerMm = depth ? intrinsics.f / depth[2] : null;

    if (outline?.box && pxPerMm && outline.contour?.length >= 3) {
      const wanted = Math.max(6, Math.min(20, (0.5 * Math.max(outline.box.width, outline.box.height)) / pxPerMm + 3));
      radius += 0.3 * (wanted - radius);
    }

    const height = rock.from === 'views' ? Math.max(6, Math.min(25, 2 * rock.point[2] + 3)) : ROCK_HEIGHT_MM;
    const projected = boundPoints(rock.point, radius, height).map((P) => projectWithDepth(pose.R, pose.t, intrinsics, P));
    const s = Math.min(frame.width, frame.height) / 1080;

    if (projected.some((p) => !p)) {
      out.marginPx = -Infinity;
    } else {
      const xs = projected.map((p) => p[0]);
      const ys = projected.map((p) => p[1]);
      const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      out.windowPx = box.map((v) => Math.round(v * 10) / 10);
      out.marginPx = Math.min(box[0], box[1], frame.width - box[2], frame.height - box[3]);

      const focus = measure && pxPerMm ? measure(box, contour) : null;

      if (focus && Number.isFinite(focus.blurPx)) {
        out.blurPx = focus.blurPx;
        out.blurWindowPx = focus.blurWindowPx;
        out.blurMm = focus.blurPx / pxPerMm;
      }

      // Glare only as measured on the rock (inside a recent outline): see focus.js.
      out.glare = focus && contour && Number.isFinite(focus.glare) ? focus.glare : null;
    }

    const fast = out.speedMmS !== null && out.speedMmS > MAX_SPEED_MM_S;
    out.conditions.fast = fast;
    out.conditions.edge = !(out.marginPx >= MARGIN_PX * s);
    out.conditions.focus = !fast && out.blurMm !== null && out.blurMm > FOCUS_MAX_MM && out.blurWindowPx > FOCUS_MIN_PX;
    out.conditions.glare = out.glare !== null && out.glare > MAX_GLARE;

    // A usable view (step2.choose's checks, plus steady): fills its coverage cell.
    if (out.speedMmS === null) {
      out.reasons.push('speed unknown');
    }

    if (out.blurMm === null) {
      out.reasons.push('focus not measured');
    }

    for (const [id, on] of Object.entries(out.conditions)) {
      if (on) {
        out.reasons.push(id);
      }
    }

    out.usable = out.reasons.length === 0;

    if (out.usable) {
      coverage.add(pose.center);
      out.cover = coverage.masks();
      out.views = coverage.count;
    }

    out.ms = performance.now() - started;
    return out;
  }

  return {
    observe,
    /** The rock's latest estimate (createRockLocator's). */
    get rock() {
      return rockKnown ?? locator.estimate();
    },
    reset() {
      locator.reset();
      coverage.reset();
      previous = null;
      lastSpeed = null;
    },
  };
}

// --- warnings (on the page) ----------------------------------------------------------------------

/**
 * One warning at a time, steady: a condition turns its warning on once it has held for `onMs`, and
 * off once it has been clear for `offMs`; of the warnings on, the first in WARNINGS shows.
 * update(timeMs, conditions { fast, edge, focus, glare }) -> the warning to show ({ id, title,
 * text }) or null. Times are the frames' own (ms).
 */
export function createWarningFilter({ onMs = WARNING_ON_MS, offMs = WARNING_OFF_MS } = {}) {
  const states = new Map(WARNINGS.map((w) => [w.id, { on: false, value: false, since: -Infinity }]));

  return {
    update(timeMs, conditions = {}) {
      for (const warning of WARNINGS) {
        const state = states.get(warning.id);
        const value = Boolean(conditions[warning.id]);

        if (value !== state.value) {
          state.value = value;
          state.since = timeMs;
        }

        if (!state.on && value && timeMs - state.since >= onMs) {
          state.on = true;
        } else if (state.on && !value && timeMs - state.since >= offMs) {
          state.on = false;
        }
      }

      return WARNINGS.find((w) => states.get(w.id).on) ?? null;
    },
    reset() {
      states.forEach((state) => Object.assign(state, { on: false, value: false, since: -Infinity }));
    },
  };
}
