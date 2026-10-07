/*
 * vision_board_pick_test.js -- which printed sheet the phone is looking at (T-0326):
 * src/web/src/lib/vision/board_pick.js.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The four sheets differ only around the middle (board_pick.js's header). These tests need no
 * OpenCV: the rules are pure (pickSheet), filterDetection works on plain detections, and the
 * appearance tests run on frames drawn by tests/vision_render.js -- each sheet seen through a known
 * camera pose, optionally with a "rock" disc on the target -- so the true answer is always known.
 * Marker evidence (which marker ids were read) is given directly, as a detection with those ids.
 */

import { BOARD_SPECS, cornerPoint } from '../src/lib/vision/board_frame.js';
import {
  appearanceVotes,
  createBoardPicker,
  DEFAULT_SHEET,
  detectionSpec,
  filterDetection,
  frameSampler,
  pickSheet,
} from '../src/lib/vision/board_pick.js';
import { cameraPose, renderSheet, rockContour } from './vision_render.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

const NAMES = {
  dots: 'charuco_23x17_10mm_centre3x3_dots',
  rings: 'charuco_23x17_10mm_centre3x3',
  small: 'charuco_23x17_10mm_centre1',
  strip: 'charuco_23x17_10mm_strip',
};

// A phone 260 mm from the target, 50 degrees up, a 640 x 480 crop of a 1x lens's frame (f 1100 px,
// as a 1280-wide frame has): the squares around the centre and the dots resolve (about 4 px per
// mm), and the rock disc hides the middle.
const VIEW = { width: 640, height: 480, f: 1100, distanceMm: 260 };
const ROCK = { centreMm: [85, 115], radiusMm: 7 };

/** A frame of `name`'s sheet, its pose, and the rock's outline in it. */
function frameOf(name, { azimuthDeg = 30, elevationDeg = 50, rock = ROCK, distanceMm = VIEW.distanceMm } = {}) {
  const spec = BOARD_SPECS[name];
  const pose = cameraPose([85, 115, 0], { ...VIEW, azimuthDeg, elevationDeg, distanceMm });
  const image = renderSheet(spec, pose, { rock });
  return { image, pose: { ...pose, valid: true }, contour: rock ? rockContour(pose, rock) : null };
}

// --- the rules ------------------------------------------------------------------------------------

Deno.test('pickSheet: each kind of evidence decides its sheet, and nothing decides nothing', () => {
  // Setup: vote tallies as the picker keeps them (frames that showed each kind of evidence).
  // Verifies the decision table of board_pick.js's header: marker 97 or colour patches -> strip;
  // black squares beside the centre (or the diagonal markers) -> small target; paper there ->
  // a large target, with or without dots by the dot votes (until the dots decide, the dotted one,
  // still marked 'default'); too few votes -> the default sheet, the strip (T-0330), marked
  // 'default'; and a close tally (2:1 needed) does not decide.
  assertEqual(DEFAULT_SHEET, NAMES.strip, 'the strip sheet is the default');
  assertEqual(pickSheet({}), { name: DEFAULT_SHEET, from: 'default', why: 'not enough seen yet' }, 'no votes');
  assertEqual(pickSheet({ marker97: 2 }).name, NAMES.strip, 'marker 97');
  assertEqual(pickSheet({ patches: 3 }).name, NAMES.strip, 'patches');
  assertEqual(pickSheet({ patches: 3, noPatches: 2 }).from, 'default', 'patches not 2:1 ahead');
  assertEqual(pickSheet({ sideBlack: 3 }).name, NAMES.small, 'black squares');
  assertEqual(pickSheet({ markerDiagonal: 2 }).name, NAMES.small, 'diagonal markers');
  assertEqual(pickSheet({ sidePaper: 3, dots: 3 }), { name: NAMES.dots, from: 'auto', why: 'blank target with dots' }, 'dots');
  assertEqual(pickSheet({ sidePaper: 3, noDots: 3 }).name, NAMES.rings, 'no dots');
  assertEqual(pickSheet({ sidePaper: 3 }), { name: NAMES.dots, from: 'default', why: 'blank target; dots not decided yet' }, 'dots undecided');
  assertEqual(pickSheet({ sidePaper: 3, sideBlack: 2 }).from, 'default', 'close tally');
  assertEqual(pickSheet({ marker97: 2, sidePaper: 10 }).name, NAMES.strip, 'marker 97 beats appearance');
});

Deno.test('filterDetection: keeps only what the chosen sheet prints', () => {
  // Setup: a detection with every marker and corner of the board (as detectionSpec finds them).
  // Test: cut it down for each sheet.
  // Verifies: the large-target sheets lose markers 85, 86, 97, 108, 109 and their 12 invalid
  // corners; the small target loses only marker 97; the strip sheet loses nothing; and
  // `recognised` is recomputed (too few corners left -> false).
  const generic = detectionSpec(BOARD_SPECS[NAMES.dots]);
  const corners = [];

  for (let id = 0; id < 22 * 16; id += 1) {
    if (cornerPoint(generic, id)) {
      corners.push({ id, x: id, y: id });
    }
  }

  const markers = Array.from({ length: 196 }, (_, id) => ({ id, corners: [] }));
  const all = { frame: { width: 1, height: 1, timeMs: 0 }, corners, markers, recognised: true };

  const dots = filterDetection(all, BOARD_SPECS[NAMES.dots]);
  assertEqual(markers.length - dots.markers.length, 5, 'large target: 5 markers removed');
  assertEqual(corners.length - dots.corners.length, 12, 'large target: 12 corners removed');
  assert(dots.markers.every((m) => ![85, 86, 97, 108, 109].includes(m.id)), 'the right markers');

  const small = filterDetection(all, BOARD_SPECS[NAMES.small]);
  assertEqual(small.markers.map((m) => m.id).includes(97), false, 'small target: 97 removed');
  assertEqual(small.markers.length, 195, 'small target: only 97');
  assertEqual(small.corners.length, corners.length, 'small target: all corners');

  const strip = filterDetection(all, BOARD_SPECS[NAMES.strip]);
  assertEqual([strip.markers.length, strip.corners.length], [196, corners.length], 'strip: nothing removed');

  const few = filterDetection({ ...all, corners: corners.slice(0, 5) }, BOARD_SPECS[NAMES.strip]);
  assertEqual(few.recognised, false, 'five corners are not a board');
});

// --- the appearance, on drawn frames --------------------------------------------------------------

Deno.test('appearanceVotes: each sheet seen with a rock on its target votes for itself', () => {
  // Setup: each of the four sheets drawn through the same camera (50 degrees up, 260 mm), with a
  // 7 mm rock disc on the target, and the rock's outline given (as the outline finder would).
  // Test: one frame's appearance votes for each.
  // Verifies: the large targets read paper beside the centre, the small target and strip sheets
  // black; the dotted sheet reads dots and the ringed one no dots; the squares and dots under the
  // rock are left out (the rock is darker than paper, and would otherwise read as ink).
  const votes = {};

  for (const [key, name] of Object.entries(NAMES)) {
    const { image, pose, contour } = frameOf(name);
    votes[key] = appearanceVotes(frameSampler(image, 1, pose, contour), { rockKnown: true });
  }

  assert(votes.dots.sidePaper && votes.dots.dots, `dots sheet: ${JSON.stringify(votes.dots)}`);
  assert(votes.rings.sidePaper && votes.rings.noDots, `rings sheet: ${JSON.stringify(votes.rings)}`);
  assert(votes.small.sideBlack && !votes.small.sidePaper, `small target: ${JSON.stringify(votes.small)}`);
  assert(votes.strip.sideBlack && !votes.strip.sidePaper, `strip sheet: ${JSON.stringify(votes.strip)}`);
});

Deno.test('appearanceVotes: the strip sheet\'s colour patches, seen from further back', () => {
  // Setup: the strip sheet and the small-target sheet (the only two with black squares beside the
  // centre) seen from 520 mm, so the margins left and right of the chessboard are in the frame.
  // Verifies: the strip sheet's red, green and blue patches vote 'patches'; the plain margins of
  // the small-target sheet vote 'noPatches' -- what tells the two apart when the rock hides
  // marker 97.
  const strip = frameOf(NAMES.strip, { distanceMm: 520, elevationDeg: 70, azimuthDeg: 0 });
  const small = frameOf(NAMES.small, { distanceMm: 520, elevationDeg: 70, azimuthDeg: 0 });
  const stripVotes = appearanceVotes(frameSampler(strip.image, 1, strip.pose, strip.contour), { rockKnown: true });
  const smallVotes = appearanceVotes(frameSampler(small.image, 1, small.pose, small.contour), { rockKnown: true });

  assert(stripVotes.patches === 1, `strip: ${JSON.stringify(stripVotes)}`);
  assert(smallVotes.noPatches === 1, `small target: ${JSON.stringify(smallVotes)}`);
});

Deno.test('appearanceVotes: without a rock outline the target is not read', () => {
  // Setup: the ringed sheet with a rock, but the outline not looked for yet (rockKnown false).
  // Verifies: no vote about the squares beside the centre or the dots is cast, since the rock may
  // be covering them: the picker waits for the outline rather than guess.
  const { image, pose } = frameOf(NAMES.rings);
  const votes = appearanceVotes(frameSampler(image, 1, pose, null), { rockKnown: false });

  assertEqual([votes.sidePaper, votes.sideBlack, votes.dots, votes.noDots], [undefined, undefined, undefined, undefined], 'no target votes');
});

// --- the picker over a sequence -------------------------------------------------------------------

Deno.test('createBoardPicker: recognises each sheet within a few frames, and a choice overrides it', () => {
  // Setup: for each sheet, frames from four directions (azimuth 0, 90, 180, 270), each with a
  // detection carrying the marker ids that sheet shows outside the rock: for the strip sheet none
  // of the discriminating ones (the rock hides 97), so its evidence must come from appearance.
  // Test: feed the frames to a fresh picker; then choose a sheet by hand.
  // Verifies: until evidence arrives the picker says DEFAULT_SHEET ('default'); after the frames
  // it names the true sheet ('auto') for the three sheets the target alone tells apart, and for
  // the strip sheet it names the small target (the one sheet indistinguishable from it when the
  // margins are out of view and 97 is hidden) until a wider frame shows the patches; and choose()
  // overrides any evidence and choose(null) returns to it.
  for (const [key, name] of Object.entries(NAMES)) {
    const picker = createBoardPicker();
    assertEqual(picker.current().from, 'default', `${key}: default before any frame`);

    for (const azimuthDeg of [0, 90, 180, 270]) {
      const { image, pose, contour } = frameOf(name, { azimuthDeg });
      const markers = key === 'small' ? [{ id: 85 }, { id: 109 }] : [];
      picker.observe({ detection: { markers }, pose, image, scale: 1, rock: contour, rockKnown: true });
    }

    const picked = picker.current();

    if (key === 'strip') {
      assertEqual(picked.name, NAMES.small, 'strip with the patches out of view: the small target');
      const wide = frameOf(name, { distanceMm: 520, elevationDeg: 70, azimuthDeg: 0 });

      for (let k = 0; k < 3; k += 1) {
        picker.observe({ detection: { markers: [] }, pose: wide.pose, image: wide.image, scale: 1, rock: wide.contour, rockKnown: true });
      }

      assertEqual([picker.current().name, picker.current().from], [NAMES.strip, 'auto'], 'strip once the patches show');
    } else {
      assertEqual([picked.name, picked.from], [name, 'auto'], `${key} recognised`);
    }

    assertEqual(picker.choose(NAMES.rings).from, 'chosen', `${key}: a choice`);
    assertEqual(picker.current().name, NAMES.rings, `${key}: the choice holds`);
    assertEqual(picker.choose(null).from, 'auto', `${key}: back to the evidence`);
  }
});

Deno.test('createBoardPicker: marker 97 read twice settles the strip sheet at once', () => {
  // Setup: a picker; two frames whose detection read marker 97 (no pose, no image).
  // Verifies: marker evidence alone decides, with no appearance at all.
  const picker = createBoardPicker();
  picker.observe({ detection: { markers: [{ id: 97 }] } });
  assertEqual(picker.current().from, 'default', 'once is not enough');
  picker.observe({ detection: { markers: [{ id: 97 }, { id: 5 }] } });
  assertEqual(picker.current().name, NAMES.strip, 'twice is');
});
