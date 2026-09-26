// Tilt performance (T-0261): the pure half of Tools > Tilt performance -- which poses are
// measured, what a measurement means, where it lands on the graph, and the graph itself, drawn as
// SVG text. No GemApp, no DOM, so the Deno tests cover all of it; tilt_performance_mode.js drives
// the renderer with it, and TiltPerformancePanel.svelte shows (and downloads) what it draws.
//
// The graph is Gem Cut Studio's (its manual, v1.1.0, p. 27, and three of its graphs the user
// supplied as references): the stone is tilted about the screen's horizontal axis ("Tilt X", the
// left half, its far end at the left edge down to face-up at the middle), then back to face-up
// and about the vertical axis ("Tilt Y", the right half). The user, 2026-09-25: "the tilt
// performance goes 33 degrees vertical, then 33 degrees horizontal"; and later the same day, "a
// slider for the start and end angles (currently and by default using 33 degrees)" -- so each
// half's reach is its own, `range.x` and `range.y`.

/** How far each half of the sweep tilts by default, in degrees: Gem Cut Studio's. */
export const TILT_RANGE = 33;

/** The default reach of both halves: `{ x, y }`, in degrees. */
export const DEFAULT_RANGE = Object.freeze({ x: TILT_RANGE, y: TILT_RANGE });

/**
 * The least and most a half can reach, in degrees. At least a few degrees, so a half is still a
 * curve; at most 45, past which the stone is seen more from its side than through its crown and
 * the sweep grows to a couple of minutes.
 */
export const TILT_RANGE_MIN = 5;
export const TILT_RANGE_MAX = 45;

/** One pose per degree, as Gem Cut Studio's graph is drawn. */
export const TILT_STEP = 1;

/**
 * The spin that makes the renderer's tilt a turn about the screen's vertical axis. The renderer
 * tilts about the screen's horizontal axis; with the stone first spun a quarter turn about its
 * own axis, the same tilt is Gem Cut Studio's Y rotation seen with the image turned 90 degrees,
 * which changes no sum over the stone (kb/gcs-reference-matching.md, "GCS Y Rotation is not our
 * spin", has the general pose).
 */
export const Y_SPIN = -90;

/**
 * The curves, in the order `GemApp::measure_tilt_pose` returns them (`tilt::TiltSums::to_vec`):
 * four averages over the whole stone, then the same four over the table alone.
 */
export const CURVES = [
  { key: 'iso', label: 'ISO brightness' },
  { key: 'cos', label: 'COS brightness' },
  { key: 'window', label: 'Window' },
  { key: 'head', label: 'Head shadow' },
];

/**
 * Fewer table pixels than this and the table's averages are not drawn: at a steep tilt a table
 * seen nearly edge-on is a sliver of pixels, whose average is noise. A thousandth of a face-up
 * table's area on the hex cut at the fixed render size: 50 at 1168 x 978, and so 2 at the 200 x 167
 * the tool measures at since 2026-09-25 (`tilt::TILT_RENDER_WIDTH`), a table of about 1,500 pixels.
 */
export const MIN_TABLE_PIXELS = 2;

/**
 * The render settings a measurement depends on (`tilt::TiltPass::params` overrides every other
 * one): when any of them changes while the graph is up, the graph is measured again. The user,
 * 2026-09-25: "updating the headshadow angle on the render settings should regenerate the tilt
 * performance graph"; the others follow from the same reasoning, now that the render settings
 * stay on screen beside the graph.
 */
export const MEASURED_PARAMS = ['headShadowHalfAngle', 'refractiveIndex', 'dispersion', 'maxBounces', 'observerRadius'];

/** What the measured settings are now, as one comparable string; `getParam(name)` reads one. */
export function measurementKey(getParam) {
  return MEASURED_PARAMS.map(name => getParam(name)).join('|');
}

/** A half's reach, in whole degrees within TILT_RANGE_MIN..TILT_RANGE_MAX. */
export function clampRange(degrees) {
  const whole = Math.round(Number.isFinite(degrees) ? degrees : TILT_RANGE);

  return Math.min(Math.max(whole, TILT_RANGE_MIN), TILT_RANGE_MAX);
}

/**
 * Every pose of a sweep, in the order they are measured: Tilt X from face-up out to `range.x`,
 * then Tilt Y the same way out to `range.y`. Face-up is measured on both halves, so each half is
 * a complete curve on its own (it is the same pose, and costs one extra measurement).
 */
export function sweepPoses(range = DEFAULT_RANGE, step = TILT_STEP) {
  const angles = reach => {
    const list = [];

    for (let i = 0; i * step <= reach + 1e-9; i++) {
      list.push(Math.min(i * step, reach));
    }

    return list;
  };

  return [
    ...angles(range.x).map(angle => ({ axis: 'x', angle, spin: 0, tilt: angle })),
    ...angles(range.y).map(angle => ({ axis: 'y', angle, spin: Y_SPIN, tilt: angle })),
  ];
}

/**
 * A measurement (the array `measure_tilt_pose` returns) as named fractions:
 * `{ stone: { iso, cos, window, head }, table: {...} | null, stonePixels, tablePixels }`.
 * `table` is null when too little of the table is in view to average (MIN_TABLE_PIXELS), or
 * the stone has none.
 */
export function readMeasurement(values) {
  const named = offset => Object.fromEntries(CURVES.map(({ key }, i) => [key, values[offset + i]]));
  const tablePixels = values[9];

  return {
    stone: named(0),
    table: tablePixels >= MIN_TABLE_PIXELS ? named(4) : null,
    stonePixels: values[8],
    tablePixels,
  };
}

/**
 * Where face-up sits across the graph, 0 at the left edge to 1 at the right: in proportion to the
 * two halves' reach, so a degree is the same width on both sides.
 */
export function middleX(range = DEFAULT_RANGE) {
  return range.x / (range.x + range.y);
}

/**
 * The graph's horizontal position of a pose, 0 at the left edge to 1 at the right: Tilt X runs
 * from `range.x` at the left edge to face-up at `middleX`, Tilt Y from there to `range.y` at the
 * right edge.
 */
export function graphX(axis, angle, range = DEFAULT_RANGE) {
  const middle = middleX(range);
  const reach = Math.min(Math.max(angle / range[axis], 0), 1);

  return axis === 'x' ? middle * (1 - reach) : middle + (1 - middle) * reach;
}

/** The pose at a horizontal position on the graph (0..1), the inverse of `graphX`. */
export function poseAtGraphX(fraction, range = DEFAULT_RANGE) {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const middle = middleX(range);

  return clamped < middle
    ? { axis: 'x', angle: (1 - clamped / middle) * range.x }
    : { axis: 'y', angle: ((clamped - middle) / (1 - middle)) * range.y };
}

/** The spin and tilt that show a pose of the graph, for the view. */
export function viewPose({ axis, angle }) {
  return axis === 'x' ? { spin: 0, tilt: angle } : { spin: Y_SPIN, tilt: angle };
}

/** One half's samples within its reach, face-up first. */
function inReach(samples, axis, range) {
  return samples[axis]
    .filter(sample => sample.angle <= range[axis] + 1e-9)
    .sort((a, b) => a.angle - b.angle);
}

/**
 * An SVG path through one curve, in a `width` x `height` box (0% at the bottom, 100% at the
 * top), from the samples measured so far (`samples.x` and `samples.y`, each `[{ angle,
 * measurement }]` in any order). Samples beyond a half's reach are left out: they stay measured
 * for when the reach grows again. `table` picks the table's average instead of the stone's; a
 * table sample missing from view breaks the line rather than joining across the gap. Empty when
 * nothing is measured yet.
 */
export function curvePath(samples, key, table, width, height, range = DEFAULT_RANGE) {
  // Left to right: Tilt X from the far end back to face-up, then Tilt Y outwards.
  const ordered = [
    ...inReach(samples, 'x', range).reverse().map(sample => ['x', sample]),
    ...inReach(samples, 'y', range).map(sample => ['y', sample]),
  ];
  let path = '';
  let pen = false;

  for (const [axis, { angle, measurement }] of ordered) {
    const source = table ? measurement.table : measurement.stone;

    if (!source) {
      pen = false;
      continue;
    }

    const x = graphX(axis, angle, range) * width;
    const y = (1 - Math.min(Math.max(source[key], 0), 1)) * height;

    path += `${pen ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
    pen = true;
  }

  return path;
}

/**
 * The measurement nearest a pose, for the readout under the cursor: the sample within reach on
 * the pose's own half whose angle is closest, or null when that half has none yet.
 */
export function sampleNearest(samples, { axis, angle }, range = DEFAULT_RANGE) {
  let best = null;

  for (const sample of inReach(samples, axis, range)) {
    if (best === null || Math.abs(sample.angle - angle) < Math.abs(best.angle - angle)) {
      best = sample;
    }
  }

  return best;
}

/**
 * The angles labelled under the graph on one half: every ten degrees out to the reach, or the
 * reach itself when that is under ten. Face-up is labelled once, in the middle, by the caller.
 */
export function angleTicks(reach) {
  const ticks = [];

  for (let angle = 10; angle <= reach + 1e-9; angle += 10) {
    ticks.push(angle);
  }

  return ticks.length > 0 ? ticks : [reach];
}

// ---- the graph, drawn

/**
 * The graph's margins round the plot, in pixels: the percentages on the left, a little air on
 * the right, the two halves' names above and the angles below.
 */
export const GRAPH_MARGIN = Object.freeze({ left: 36, right: 10, top: 22, bottom: 24 });

/** The whole graph's height for a graph `width` pixels wide: the plot is about 0.68 as tall as wide. */
export function graphHeight(width) {
  const plotWidth = Math.max(width - GRAPH_MARGIN.left - GRAPH_MARGIN.right, 1);
  const plotHeight = Math.min(Math.max(Math.round(plotWidth * 0.68), 120), 360);

  return plotHeight + GRAPH_MARGIN.top + GRAPH_MARGIN.bottom;
}

const PERCENT_LINES = [0, 20, 40, 60, 80, 100];

function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/**
 * The graph as SVG markup (the inside of a `<g>` whose origin is the graph's top-left corner),
 * `width` pixels wide and `graphHeight(width)` tall. Drawn as text, not as Svelte markup, so the
 * panel shows and the Download button saves the very same picture. Returns `{ markup, width,
 * height }`.
 *
 *   samples, range         what is measured, and each half's reach (see curvePath)
 *   shown                  `{ iso, cos, window, head }`: which curves are drawn
 *   showTable              whether each curve's dotted twin (the table alone) is
 *   cursor                 `{ axis, angle }`: the pose the view shows, marked by a line with a dot
 *                          on each solid curve; or null
 *   palette                the colours, as anything CSS takes in a `style` (the panel passes
 *                          `var(--...)`, the download the colours those resolve to): `iso`, `cos`,
 *                          `window`, `head`, `grid`, `middle`, `axis` (the labels), `cursor`, and
 *                          `surface` (the ring round a cursor dot: the colour it sits on)
 *   font, mono             the font families of the halves' names and of the numbers
 *
 * In the design language (kb/the-studio-s-design-language.md): a hairline grid in the cards' edge
 * colour, labels in the muted colour with the numbers in the mono font, the halves' names set as a
 * card's title is (small spaced capitals), and the cursor in the accent colour.
 */
export function graphSvg({ samples, range = DEFAULT_RANGE, shown, showTable, cursor, width, palette, font, mono }) {
  const height = graphHeight(width);
  const { left, right, top, bottom } = GRAPH_MARGIN;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const x = (axis, angle) => (graphX(axis, angle, range) * plotW).toFixed(2);
  const y = fraction => ((1 - fraction) * plotH).toFixed(2);
  const middle = middleX(range) * plotW;
  // Escaped: a font list names families in double quotes ("SF Mono"), inside a quoted attribute.
  const numbers = `font-family:${escapeXml(mono)};font-size:10px;fill:${palette.axis}`;
  const title = `font-family:${escapeXml(font)};font-size:10px;font-weight:600;letter-spacing:0.07em;fill:${palette.axis}`;
  const hairline = (x1, x2, y1, y2, colour) =>
    `<line x1="${x1}" x2="${x2}" y1="${y1}" y2="${y2}" style="stroke:${colour};stroke-width:1"/>`;
  const parts = [`<g transform="translate(${left} ${top})">`];

  // The grid: a hairline every 20%, labelled on the left, and one at each labelled angle; the
  // plot's two sides, and face-up a shade stronger.
  for (const p of PERCENT_LINES) {
    parts.push(hairline(0, plotW, y(p / 100), y(p / 100), palette.grid));
    parts.push(`<text x="-6" y="${(Number(y(p / 100)) + 3.5).toFixed(2)}" text-anchor="end" style="${numbers}">${p}%</text>`);
  }

  for (const axis of ['x', 'y']) {
    for (const angle of angleTicks(range[axis])) {
      parts.push(hairline(x(axis, angle), x(axis, angle), 0, plotH, palette.grid));
      parts.push(`<text x="${x(axis, angle)}" y="${plotH + 15}" text-anchor="middle" style="${numbers}">${angle}°</text>`);
    }
  }

  parts.push(hairline(0, 0, 0, plotH, palette.grid));
  parts.push(hairline(plotW, plotW, 0, plotH, palette.grid));
  parts.push(hairline(middle.toFixed(2), middle.toFixed(2), 0, plotH, palette.middle));
  parts.push(`<text x="${middle.toFixed(2)}" y="${plotH + 15}" text-anchor="middle" style="${numbers}">0°</text>`);
  parts.push(`<text x="${(middle / 2).toFixed(2)}" y="-9" text-anchor="middle" style="${title}">TILT X</text>`);
  parts.push(`<text x="${((middle + plotW) / 2).toFixed(2)}" y="-9" text-anchor="middle" style="${title}">TILT Y</text>`);

  // The curves: the table's dotted twins under the stone's solid lines, so dots never hide a
  // solid line.
  const drawn = CURVES.filter(({ key }) => shown[key]);

  if (showTable) {
    for (const { key } of drawn) {
      const d = curvePath(samples, key, true, plotW, plotH, range);

      if (d) {
        parts.push(`<path d="${d}" style="fill:none;stroke:${palette[key]};stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:0.1 4"/>`);
      }
    }
  }

  for (const { key } of drawn) {
    const d = curvePath(samples, key, false, plotW, plotH, range);

    if (d) {
      parts.push(`<path d="${d}" style="fill:none;stroke:${palette[key]};stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round"/>`);
    }
  }

  // The cursor: where the view is, and a dot where it crosses each solid curve.
  if (cursor) {
    const cx = x(cursor.axis, cursor.angle);
    const sample = sampleNearest(samples, cursor, range);

    parts.push(hairline(cx, cx, 0, plotH, palette.cursor));

    if (sample) {
      const sx = x(cursor.axis, sample.angle);

      for (const { key } of drawn) {
        parts.push(`<circle cx="${sx}" cy="${y(sample.measurement.stone[key])}" r="3" style="fill:${palette[key]};stroke:${palette.surface};stroke-width:1.5"/>`);
      }
    }
  }

  parts.push('</g>');

  return { markup: parts.join(''), width, height };
}

/**
 * The graph as a picture on its own, for the Download button: the design's name, then the
 * settings it was measured with, the graph, and a legend of the curves drawn, on a solid
 * background. Returns a complete SVG document, `width` pixels wide.
 *
 * Takes graphSvg's options (no cursor: the picture is of the stone, not of where the pointer
 * happened to be), plus `title` and `subtitle`, `background` and `text` (the title's and the
 * legend's colour), and `headShadow` (the angle the head shadow curve is labelled with, as on
 * screen).
 */
export function graphImageSvg(options) {
  const { width, title, subtitle, palette, font, mono, background, text, shown, showTable, headShadow } = options;
  const pad = 24;
  const headerHeight = 50;
  const graph = graphSvg({ ...options, cursor: null, width: width - 2 * pad });
  const entries = CURVES.filter(({ key }) => shown[key])
    .map(({ key, label }) => ({ key, label: key === 'head' ? `${label} (${Math.round(headShadow)}°)` : label }));

  if (showTable) {
    entries.push({ key: 'table', label: 'Table alone (dotted)' });
  }

  const columns = 3;
  const rowHeight = 20;
  const legendTop = pad + headerHeight + graph.height + 14;
  const height = legendTop + Math.max(Math.ceil(entries.length / columns), 1) * rowHeight + pad - 8;
  const columnWidth = (width - 2 * pad - GRAPH_MARGIN.left) / columns;
  const legend = entries.map(({ key, label }, i) => {
    const lx = pad + GRAPH_MARGIN.left + (i % columns) * columnWidth;
    const ly = legendTop + Math.floor(i / columns) * rowHeight;
    const stroke = key === 'table'
      ? `stroke:${palette.axis};stroke-width:1.5;stroke-linecap:round;stroke-dasharray:0.1 4`
      : `stroke:${palette[key]};stroke-width:2;stroke-linecap:round`;

    return `<line x1="${lx}" x2="${lx + 16}" y1="${ly}" y2="${ly}" style="${stroke}"/>` +
      `<text x="${lx + 24}" y="${ly + 4}" style="font-family:${escapeXml(font)};font-size:12px;fill:${text}">${escapeXml(label)}</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" style="fill:${background}"/>` +
    `<text x="${pad}" y="${pad + 14}" style="font-family:${escapeXml(font)};font-size:16px;font-weight:600;fill:${text}">${escapeXml(title)}</text>` +
    `<text x="${pad}" y="${pad + 34}" style="font-family:${escapeXml(mono)};font-size:11px;fill:${palette.axis}">${escapeXml(subtitle)}</text>` +
    `<g transform="translate(${pad} ${pad + headerHeight})">${graph.markup}</g>` +
    legend +
    '</svg>';
}
