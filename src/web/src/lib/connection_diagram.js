// The connection picture (T-0342), on the computer's scanner and on the phone: a laptop on the
// left, the servers in the middle (a cloud and a small server), a phone on the right,
// and arrows moving between them as scan_trace.js reports each step. The user, 2026-10-13:
//
//   "on the computer, initially the phone is greyed out and while its setting up subscriptions, it
//   should have a grey arrow thats repeatedly moving from the computer to the server. once all the
//   subscriptions are set up ... the arrows go from grey to white and bold with a grey outline. once
//   it sees the announcement from the phone and starts the handshake, it should ungrey out the phone
//   and start passing the arrows through the server and to the phone and back. when it starts
//   setting up the webrtc connection, the server in the middle goes away ... don't completely reset
//   everything when the state changes ... vice versa with phone -> computer"
//
// So the picture is built ONCE: six lanes of moving chevrons (laptop to server and back, server to
// phone and back, laptop to phone and back, the last two straight across), each always animating,
// and a step only changes which lanes show and how the arrows look, through classes the stylesheet
// transitions. Nothing restarts when the step changes: the arrows keep their place and change colour
// or fade. The side this page is on (`self`) sends; the other device is greyed until it is heard.
//
// diagramView is the pure part (step -> what shows), tested on its own; createConnectionDiagram
// draws it with the DOM.

/** The lanes: which way each runs, between which points. */
const X = { left: 64, serverLeft: 136, serverRight: 184, right: 256 };
const Y = { top: 33, bottom: 47 };

/**
 * The lanes for a page: the arrows leaving this page's device run along the top row, the ones
 * coming back along the bottom (the user, 2026-10-13: "if on the computer, can you make the top row
 * from the computer moving right and if on the phone, ... the top row from the phone moving left").
 */
export function lanesFor(role) {
  const rightward = role === 'computer' ? Y.top : Y.bottom;
  const leftward = role === 'computer' ? Y.bottom : Y.top;
  return {
    leftToServer: [X.left, rightward, X.serverLeft, rightward],
    serverToRight: [X.serverRight, rightward, X.right, rightward],
    rightToServer: [X.right, leftward, X.serverRight, leftward],
    serverToLeft: [X.serverLeft, leftward, X.left, leftward],
    leftToRight: [X.left, rightward, X.right, rightward],
    rightToLeft: [X.right, leftward, X.left, leftward],
  };
}

export const LANES = Object.freeze(lanesFor('computer'));

/**
 * What the picture shows at `step` (scan_trace.js STEPS) for this page's `role`:
 * { lanes: Set of LANES keys, arrows: 'grey'|'bold', otherGreyed, serverGreyed, serverShown, failed }.
 * The laptop is always on the left and the phone on the right; the page's own device sends first.
 * The servers are greyed until over half of them are ready (the 'waiting' step), and the arrows
 * stay white once bold, connected included (the user: "instead of highlighting the arrows green,
 * can you start the center server greyed out, then change it to white once over half of the
 * sessions are set up").
 */
export function diagramView(step, role, { failure = null, error = false } = {}) {
  const selfLeft = role === 'computer';
  const toServer = selfLeft ? 'leftToServer' : 'rightToServer';
  const lanes = new Set();
  let arrows = 'bold';
  let otherGreyed = true;
  let serverShown = true;
  let serverGreyed = false;

  switch (step) {
    case 'servers':
      lanes.add(toServer);
      arrows = 'grey';
      serverGreyed = true;
      break;
    case 'waiting':
      lanes.add(toServer);
      break;
    case 'introducing':
      ['leftToServer', 'serverToRight', 'rightToServer', 'serverToLeft'].forEach(l => lanes.add(l));
      otherGreyed = false;
      break;
    case 'direct':
    case 'verifying':
      lanes.add('leftToRight');
      lanes.add('rightToLeft');
      otherGreyed = false;
      serverShown = false;
      break;
    default:
      lanes.add('leftToRight');
      lanes.add('rightToLeft');
      otherGreyed = false;
      serverShown = false;
  }

  if (error) {
    lanes.clear();
  }

  return { lanes, arrows, otherGreyed, serverGreyed, serverShown, failed: Boolean(error || failure) };
}

const NS = 'http://www.w3.org/2000/svg';
/** Arrow speed and spacing, the same on every lane, so a long lane is not sparser or faster. */
const ARROW_SPEED = 48;
const ARROW_GAP = 24;

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);

  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }

  parent?.append(node);
  return node;
}

/** The laptop, at its centre x (line art, 1.6 px strokes). */
function laptop(parent, cx) {
  const g = el('g', { class: 'cd-device cd-laptop' }, parent);
  el('rect', { x: cx - 20, y: 22, width: 40, height: 26, rx: 2.5 }, g);
  el('path', { d: `M${cx - 27} 54 L${cx + 27} 54 L${cx + 23} 49 L${cx - 23} 49 Z` }, g);
  return g;
}

/** The phone, at its centre x. */
function phone(parent, cx) {
  const g = el('g', { class: 'cd-device cd-phone' }, parent);
  el('rect', { x: cx - 10, y: 17, width: 20, height: 40, rx: 3.5 }, g);
  el('line', { x1: cx - 3, y1: 52, x2: cx + 3, y2: 52 }, g);
  return g;
}

/** The servers: a cloud (three bumps on a flat base), with a small three-row server overlapping
 *  its lower right (filled, so the cloud's outline passes behind it). The user, 2026-10-14:
 *  "instead of the globe behind the server, can you have a cloud and can you add a third server
 *  row in the server icon". */
function servers(parent, cx) {
  const g = el('g', { class: 'cd-server' }, parent);
  const at = (x, y) => `${cx + x} ${y}`;
  el('path', {
    class: 'cd-cloud',
    d: `M${at(-14, 47)} A7 7 0 0 1 ${at(-16.5, 34)} A11 11 0 0 1 ${at(3, 26.5)} A7 7 0 0 1 ${at(13, 33)} A7.5 7.5 0 0 1 ${at(15, 47)} Z`,
  }, g);
  const box = el('g', { class: 'cd-rack' }, g);

  for (const y of [43.5, 48.7, 53.9]) {
    el('rect', { x: cx + 2, y, width: 16, height: 4.6, rx: 1.1 }, box);
    el('circle', { cx: cx + 14.8, cy: y + 2.3, r: 0.8, class: 'cd-led' }, box);
  }

  return g;
}

/**
 * Draws the picture into `container` (any element; the SVG fills its width). Returns
 * { update(snapshot) (a scan_trace.js snapshot, or { step, failure, error }), element, destroy() }.
 *
 * @param {HTMLElement} container
 * @param {{ role: 'computer'|'phone', label?: string }} options
 */
export function createConnectionDiagram(container, { role, label = 'How the connection is going' }) {
  const svg = el('svg', { viewBox: '0 0 320 72', class: `cd cd-${role}`, role: 'img', 'aria-label': label });
  const lanesGroup = el('g', { class: 'cd-lanes' }, svg);
  const lanes = {};

  for (const [name, [x1, y1, x2, y2]] of Object.entries(lanesFor(role))) {
    const lane = el('g', { class: 'cd-lane', 'data-lane': name }, lanesGroup);
    const d = `M${x1} ${y1} L${x2} ${y2}`;
    const length = Math.hypot(x2 - x1, y2 - y1);
    const seconds = length / ARROW_SPEED;
    const count = Math.max(2, Math.round(length / ARROW_GAP));

    for (let k = 0; k < count; k += 1) {
      const arrow = el('g', { class: 'cd-arrow' }, lane);
      el('path', { d: 'M-3.5 -4 L2.5 0 L-3.5 4', class: 'cd-arrow-edge' }, arrow);
      el('path', { d: 'M-3.5 -4 L2.5 0 L-3.5 4', class: 'cd-arrow-core' }, arrow);
      // Each arrow travels the lane for ever, evenly spaced: whatever the step, they are already
      // moving. It fades in as it leaves and out as it reaches the other end (the user: "can you
      // make the arrows fade out as it gets to the computer/phone"), on the same clock: both
      // quickly, in the last tenth or so of the lane (then: "can you make the fade out sharper").
      const timing = { dur: `${seconds.toFixed(2)}s`, repeatCount: 'indefinite', begin: `${((-k * seconds) / count).toFixed(2)}s` };
      el('animateMotion', { path: d, rotate: 'auto', ...timing }, arrow);
      el('animate', { attributeName: 'opacity', values: '0;1;1;0', keyTimes: '0;0.08;0.88;1', ...timing }, arrow);
    }

    lanes[name] = lane;
  }

  const server = servers(svg, 160);
  const left = laptop(svg, 36);
  const right = phone(svg, 284);
  const self = role === 'computer' ? left : right;
  const other = role === 'computer' ? right : left;
  self.classList.add('cd-self');
  other.classList.add('cd-other');
  // A failed connection: a red cross on this device's way to the servers.
  const crossX = role === 'computer' ? (X.left + X.serverLeft) / 2 : (X.serverRight + X.right) / 2;
  const crossY = (Y.top + Y.bottom) / 2;
  const cross = el('g', { class: 'cd-cross' }, svg);
  el('line', { x1: crossX - 5, y1: crossY - 5, x2: crossX + 5, y2: crossY + 5 }, cross);
  el('line', { x1: crossX + 5, y1: crossY - 5, x2: crossX - 5, y2: crossY + 5 }, cross);
  container.append(svg);

  // Moving arrows only for people who have not asked for less motion.
  try {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      svg.pauseAnimations?.();
    }
  } catch {
    // No media queries: the arrows move.
  }

  function update(snapshot) {
    const view = diagramView(snapshot?.step ?? 'servers', role, snapshot ?? {});

    for (const [name, lane] of Object.entries(lanes)) {
      lane.classList.toggle('cd-on', view.lanes.has(name));
    }

    svg.dataset.step = snapshot?.step ?? 'servers';
    svg.dataset.arrows = view.arrows;
    svg.classList.toggle('cd-failed', view.failed);
    other.classList.toggle('cd-greyed', view.otherGreyed);
    server.classList.toggle('cd-greyed', view.serverGreyed);
    server.classList.toggle('cd-gone', !view.serverShown);
    return view;
  }

  update({ step: 'servers' });

  return {
    update,
    element: svg,
    destroy() {
      svg.remove();
    },
  };
}

/**
 * The picture's stylesheet, the same on both pages (each page adds it once). Colours follow the
 * page's own --text, --muted and --accent where they exist.
 */
export const CONNECTION_DIAGRAM_CSS = `
.cd { display: block; width: 100%; max-width: 360px; height: auto; margin: 0 auto; overflow: visible; }
.cd .cd-device rect, .cd .cd-device path, .cd .cd-device line,
.cd .cd-server .cd-cloud, .cd .cd-rack rect {
  fill: none; stroke: var(--cd-ink, var(--text, #eceff4)); stroke-width: 1.6;
  stroke-linejoin: round; stroke-linecap: round; transition: stroke 0.5s, opacity 0.5s;
}
.cd .cd-rack rect { fill: var(--cd-bg, var(--panel, #2e3440)); stroke-width: 1.2; }
.cd .cd-led { fill: var(--cd-ink, var(--text, #eceff4)); stroke: none; }

.cd .cd-device, .cd .cd-server { transition: opacity 0.6s, filter 0.6s; }
.cd .cd-greyed { opacity: 0.28; }
.cd .cd-server.cd-gone { opacity: 0; }
.cd .cd-lane { opacity: 0; transition: opacity 0.45s; }
.cd .cd-lane.cd-on { opacity: 1; }
.cd .cd-arrow path { fill: none; stroke-linecap: round; stroke-linejoin: round; transition: stroke 0.5s, stroke-width 0.5s, opacity 0.5s; }
.cd .cd-arrow-edge { stroke: #7b8394; stroke-width: 4.4; opacity: 0; }
.cd .cd-arrow-core { stroke: #8a92a3; stroke-width: 1.6; }
.cd[data-arrows='bold'] .cd-arrow-edge { opacity: 1; }
.cd[data-arrows='bold'] .cd-arrow-core { stroke: #ffffff; stroke-width: 2.4; }
.cd.cd-failed .cd-arrow-core { stroke: #bf616a; }
.cd .cd-cross line { stroke: #bf616a; stroke-width: 2.6; stroke-linecap: round; }
.cd .cd-cross { opacity: 0; transition: opacity 0.4s; }
.cd.cd-failed .cd-cross { opacity: 1; }
`;
