/*
 * lib_test.js -- tests for the plain-JS logic modules of the Svelte page (web/src/lib/): the
 * tier ids and row formatting, the colour maths, the persisted settings and the gear dialog's
 * validation. These are the pieces of the old page script that had no test at all while they
 * were inseparable from it (one 3,000-line classic script with no module boundary); the port made
 * them ordinary ES modules, so they are imported here directly.
 *
 * HOW TO RUN (from web/, where the package.json that resolves `svelte/store` lives):
 *   deno test --allow-read --allow-env tests/
 * Also `deno task test`. (`--allow-env` since T-0188: viewport.js imports Svelte, whose `esm-env`
 * reads NODE_ENV.) Deno rather than node: node is broken on this machine
 * (kb/build-and-test-commands.md). No third-party assertion library: the helpers below are a few
 * lines, which keeps the suite runnable offline.
 *
 * WHAT IS NOT COVERED HERE
 *   The Svelte components, the stores' wiring to GemApp and everything that needs a browser or the
 *   wasm module are exercised over CDP against the built page instead (kb/browser-harness.md).
 */

import {
  tierId, isGirdleTier, isTableTier, isCuletTier, isPavilionTier, splitTiersIntoSections,
  formatTierAngle, formatTierIndex, selfCheckTierIdsAgainstHexCutV2Gcs,
} from "../src/lib/tiers.js";
import { rgbToHsv, hsvToRgb, cssColor, hexToRgb, HSV_CHANNELS } from "../src/lib/color.js";
import {
  readSetting, writeSetting, readSettingNumber, readSettingBool, readSettingColor, writeSettingColor,
} from "../src/lib/settings.js";
import { clampAngleDecimals, angleDecimals } from "../src/lib/preferences.js";
import { get } from "svelte/store";
import { checkGearCount } from "../src/lib/gear_check.js";
import { listen, nativeChecked } from "../src/lib/native.js";
import { PARAM_SLIDERS, SLIDER_SPECS, FORMAT, snapToSpec } from "../src/lib/panel_config.js";

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

function assertEquals(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  assert(a === e, (message || "assertEquals") + `: expected ${e}, got ${a}`);
}

function assertClose(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance,
    (message || "assertClose") + `: expected ${expected} +/- ${tolerance}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// The GemCad scripts, loaded the way the page loads them: classic scripts that publish globals,
// so `(0, eval)` (indirect eval, which evaluates in global scope) is the same thing. design.js
// is what tiers.js's self-check and gear_check.js read `GemCadDesign` from; gemcad.js parses the
// sample designs the gear tests use.
// ---------------------------------------------------------------------------

const SCRIPTS = new URL("../../js/", import.meta.url);
const SAMPLES = new URL("../../../reference/gemcad-file-reader/Samples/", import.meta.url);

(0, eval)(await Deno.readTextFile(new URL("gemcad.js", SCRIPTS)));
(0, eval)(await Deno.readTextFile(new URL("design.js", SCRIPTS)));

const { GemCad, GemCadDesign } = globalThis;

/*
 * reference/ is third-party data -- the vendored GemCad sample designs among it -- several hundred
 * megabytes of it, deliberately gitignored, so a fresh clone of this repository has none of it and
 * the suite still has to be green there. The two gear-dialog tests below, the only ones in this
 * file that read a sample, are marked `{ ignore: !SAMPLES_PRESENT }` and report as ignored on a
 * clean checkout rather than erroring on a missing file; with the data present they run exactly as
 * before. Everything else here works on values written in the test itself and is never gated.
 */
const SAMPLES_PRESENT = (() => {
  try {
    Deno.statSync(SAMPLES);
    return true;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Tier ids
// ---------------------------------------------------------------------------

/*
 * Setup: a tier is just `{ angle }` as far as its id goes, so a list of mast angles is a design.
 * Test: the user's rule (T-0152) -- crown tiers C1, C2..., the table T, pavilion tiers P1, P2...,
 * girdles G1, G2... -- numbered by cutting order, each counter independent of the others.
 * Verifies that a girdle cut BETWEEN two pavilion tiers does not disturb the pavilion numbering
 * (P2 stays P2), which is the point of the girdle having its own counter.
 */
Deno.test("tier ids are numbered by cutting order, one counter per kind", () => {
  const angles = [-40, -90, -45, 55, 35, 0];
  const counters = { crown: 0, pavilion: 0, girdle: 0 };
  const ids = angles.map((angle) => tierId({ angle }, counters));

  assertEquals(ids, ["P1", "G1", "P2", "C1", "C2", "T"]);
});

/*
 * Setup: one angle of each kind the id and the section rules must tell apart.
 * Test: the girdle is recognised by |angle| == 90 whichever sign it carries (a .gcs girdle can
 * convert to either side of the boundary), the table by 0, and a flat culet by 180.
 * Verifies that a culet is a PAVILION tier (its 180 is positive, so a bare `angle < 0` test
 * would file it in the crown table -- the bug isPavilionTier exists to prevent).
 */
Deno.test("girdle, table and culet are told apart; a culet is a pavilion tier", () => {
  assert(isGirdleTier({ angle: -90 }) && isGirdleTier({ angle: 90 }), "girdle at either sign");
  assert(isGirdleTier({ angle: -89.9999999 }), "within 1e-6 of 90 still counts (float residue)");
  assert(!isGirdleTier({ angle: -89.9 }), "89.9 is not a girdle");
  assert(isTableTier({ angle: 0 }) && !isTableTier({ angle: 0.5 }), "table is angle 0");
  assert(isCuletTier({ angle: 180 }) && !isCuletTier({ angle: 90 }), "culet is angle 180");

  assert(isPavilionTier({ angle: 180 }), "culet is pavilion");
  assert(isPavilionTier({ angle: -90 }), "girdle is pavilion");
  assert(isPavilionTier({ angle: -30 }), "negative is pavilion");
  assert(!isPavilionTier({ angle: 30 }) && !isPavilionTier({ angle: 0 }), "positive and table are crown");

  assertEquals(tierId({ angle: 180 }, { crown: 0, pavilion: 0, girdle: 0 }), "P1", "culet numbered as P");
});

/*
 * Setup: hex_cut_v2.gcs's ten tiers by their polar angles, converted the way gcs.js converts them
 * (GemCadDesign.mastAngleOf), which is what selfCheckTierIdsAgainstHexCutV2Gcs does.
 * Test: run that self-check, the same one the page runs at startup.
 * Verifies that the ids the page would generate for the built-in stone are the file's own
 * (P1 G1 P2 C1 C2 C3 C4 C5 C6 T); it throws with both lists if not.
 */
Deno.test("the startup self-check against hex_cut_v2.gcs passes", () => {
  selfCheckTierIdsAgainstHexCutV2Gcs();
});

/*
 * Setup: tiers listed in a deliberately interleaved order (pavilion, crown, girdle, crown).
 * Test: split them into the two tables.
 * Verifies that each table keeps the FILE order of its own tiers (nothing is moved to the end,
 * so a row's number still says where it is cut), and that each row carries its generated id.
 */
Deno.test("the crown/pavilion split keeps each section in file order", () => {
  const tiers = [{ angle: -40 }, { angle: 50 }, { angle: -90 }, { angle: 0 }, { angle: 30 }];
  const { crown, pavilion } = splitTiersIntoSections(tiers);

  assertEquals(pavilion.map((row) => row.id), ["P1", "G1"]);
  assertEquals(crown.map((row) => row.id), ["C1", "T", "C2"]);
  assert(pavilion[0].tier === tiers[0] && crown[2].tier === tiers[4], "rows hold the tier objects");
});

/*
 * Test: the row's angle and index text. Pavilion angles show positive (the pavilion is cut with
 * the stone flipped), a flat culet shows 0, a rounded -0 never prints as "-0.00", and an index is
 * a plain integer unless it is fractional, when it gets three decimals.
 */
/*
 * Test: the angle decimal-places setting (File > Settings). Setup: a tier with a long angle.
 * Verifies: the row shows exactly as many decimals as asked, 0 prints a whole number, the
 * setting clamps to 0-6 and falls back to 2 for junk, and the store holds the clamped value.
 */
Deno.test("angle decimals: the row honours the setting, which is clamped", () => {
  const tier = { angle: 55.06774 };

  assertEquals(formatTierAngle(tier, 0), "55°");
  assertEquals(formatTierAngle(tier, 4), "55.0677°");
  assertEquals(formatTierAngle({ angle: -0 }, 0), "0°");

  assertEquals(clampAngleDecimals(9), 6);
  assertEquals(clampAngleDecimals(-3), 0);
  assertEquals(clampAngleDecimals("3"), 3);
  assertEquals(clampAngleDecimals("abc"), 2);

  angleDecimals.set(11);
  assertEquals(get(angleDecimals), 6);
  angleDecimals.set(2);
});

Deno.test("row formatting: angles positive on the pavilion, indices to 3 decimals when fractional", () => {
  assertEquals(formatTierAngle({ angle: -36.58 }), "36.58°");
  assertEquals(formatTierAngle({ angle: -90 }), "90.00°");
  assertEquals(formatTierAngle({ angle: 180 }), "0.00°");
  assertEquals(formatTierAngle({ angle: 55.0677 }), "55.07°");
  assertEquals(formatTierAngle({ angle: -0 }), "0.00°", "a -0 never prints with a sign");

  assertEquals(formatTierIndex(48), "48");
  assertEquals(formatTierIndex(53.5), "53.500");
  assertEquals(formatTierIndex(1 / 3), "0.333");
});

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/*
 * Setup: a grid of colours, including the greys and black that have no hue or saturation.
 * Test: HSV and back. Verifies the conversion is its own inverse for every colour that HAS a hue,
 * and that a grey reports hue 0 and black saturation 0 -- the values ColorSetting deliberately
 * ignores so dragging Value to 0 and back does not lose the hue.
 */
Deno.test("rgb <-> hsv round-trips, and greys and black report no hue and no saturation", () => {
  for (const rgb of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.2, 0.6, 0.9], [1, 0.5, 0], [0.4, 0.4, 0.1]]) {
    const back = hsvToRgb(rgbToHsv(rgb));

    for (let i = 0; i < 3; i++) {
      assertClose(back[i], rgb[i], 1e-12, `channel ${i} of ${rgb}`);
    }
  }

  assertEquals(rgbToHsv([0.5, 0.5, 0.5]), { h: 0, s: 0, v: 0.5 }, "grey");
  assertEquals(rgbToHsv([0, 0, 0]), { h: 0, s: 0, v: 0 }, "black");
  assertClose(rgbToHsv([0, 0, 1]).h, 240, 1e-9, "blue is 240 degrees");
  assertClose(rgbToHsv([1, 0, 1]).h, 300, 1e-9, "magenta is 300 degrees");
});

Deno.test("colour text helpers", () => {
  assertEquals(cssColor([1, 0.5, 0]), "rgb(255, 128, 0)");
  assertEquals(hexToRgb("#ff8000").map((v) => Math.round(v * 255)), [255, 128, 0]);
  assertEquals(HSV_CHANNELS.map((c) => c.format(c.key === "h" ? 359.6 : 0.5)), ["360°", "0.500", "0.500"]);
});

// ---------------------------------------------------------------------------
// Persisted settings
// ---------------------------------------------------------------------------

/*
 * Setup: an in-memory localStorage in place of the browser's (Deno has none), so each test starts
 * from a known store. Test: the read helpers' rule (T-0156) -- a missing, corrupt or OUT-OF-RANGE
 * value falls back, and an out-of-range one is NOT clamped to the nearest bound (a slider must
 * never show a value the stored number did not say).
 */
function withStorage(contents, body) {
  const store = new Map(Object.entries(contents));
  const original = globalThis.localStorage;

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
    },
  });

  try {
    body(store);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
  }
}

Deno.test("numeric settings fall back when missing, corrupt or out of range (never clamped)", () => {
  withStorage({ "gems.ok": "12", "gems.big": "5000", "gems.junk": "abc", "gems.edge": "64" }, () => {
    assertEquals(readSettingNumber("gems.ok", 1, 64, null), 12);
    assertEquals(readSettingNumber("gems.edge", 1, 64, null), 64, "the bounds are inclusive");
    assertEquals(readSettingNumber("gems.big", 1, 64, "fallback"), "fallback", "out of range is not clamped");
    assertEquals(readSettingNumber("gems.junk", 1, 64, null), null);
    assertEquals(readSettingNumber("gems.missing", 1, 64, 7), 7);
  });
});

Deno.test("boolean and colour settings", () => {
  withStorage({
    "gems.on": "true", "gems.off": "false", "gems.odd": "yes",
    "gems.rgb": "0.1,0.5,1", "gems.short": "0.1,0.5", "gems.range": "0.1,0.5,2", "gems.nan": "a,b,c",
  }, () => {
    assertEquals(readSettingBool("gems.on", null), true);
    assertEquals(readSettingBool("gems.off", null), false);
    assertEquals(readSettingBool("gems.odd", null), null, "anything but true/false is the fallback");
    assertEquals(readSettingBool("gems.missing", true), true);

    assertEquals(readSettingColor("gems.rgb", null), [0.1, 0.5, 1]);
    assertEquals(readSettingColor("gems.short", "f"), "f", "wrong part count");
    assertEquals(readSettingColor("gems.range", "f"), "f", "a channel above 1");
    assertEquals(readSettingColor("gems.nan", "f"), "f", "not numbers");
  });
});

Deno.test("a colour written is a colour read back", () => {
  withStorage({}, (store) => {
    writeSettingColor("gems.c", [0.25, 0.5, 0.75]);
    assertEquals(store.get("gems.c"), "0.250000,0.500000,0.750000");
    assertEquals(readSettingColor("gems.c", null), [0.25, 0.5, 0.75]);
    writeSetting("gems.plain", 3);
    assertEquals(readSetting("gems.plain"), "3");
  });
});

/*
 * Setup: a localStorage whose every method throws, as in some private-browsing modes and
 * embedders. Test: read and write anyway. Verifies that losing persistence is not worth losing
 * the page: reads answer null and writes are silently dropped.
 */
Deno.test("a throwing localStorage costs persistence, not the page", () => {
  const original = globalThis.localStorage;

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
    },
  });

  try {
    assertEquals(readSetting("gems.anything"), null);
    writeSetting("gems.anything", "x");
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
  }
});

// ---------------------------------------------------------------------------
// The gear dialog's validation
// ---------------------------------------------------------------------------

/** SRB.asc as the page reads it: parsed, then described in index coordinates. */
async function srb() {
  const bytes = await Deno.readFile(new URL("SRB.asc", SAMPLES));

  return GemCadDesign.fromGemCad(GemCad.importBytes(bytes), { name: "SRB.asc" });
}

/*
 * Setup: the Standard Round Brilliant, which is cut on a 96-tooth gear.
 * Test: check a series of entries against it, the way the dialog does on every keystroke.
 * Verifies each rule of T-0171: unusable text is rejected with the same message whatever the
 * design; the design's own tooth count needs no error; a count that would put facets off the
 * tooth grid is an error unless "fractional teeth" is ticked, when it is allowed and the preview
 * carries the fractional indices; and with no design at all (a plain .obj) there is nothing to
 * object to, so a valid count is always fine.
 */
Deno.test("gear dialog validation", { ignore: !SAMPLES_PRESENT }, async () => {
  const design = await srb();

  for (const raw of ["", "  ", "0", "-4", "12.5", "abc"]) {
    const result = checkGearCount(design, raw, false);

    assertEquals(result.error, "Enter a whole number of teeth, greater than 0.", `"${raw}"`);
    assertEquals(result.preview, null, `"${raw}" has no preview`);
  }

  const same = checkGearCount(design, "96", false);
  assertEquals(same.error, null, "the design's own gear is always valid");
  assertEquals(same.preview.gear.teeth, 96);

  // 7 shares no factor with a round brilliant's index angles, so facets land off the grid.
  const off = checkGearCount(design, "7", false);
  assert(off.error !== null && off.error.startsWith("At 7 teeth, "), "a prime gear is fractional: " + off.error);
  assert(/would be fractional\. Check "Fractional teeth" to allow it/.test(off.error), "the error says how to allow it");
  assert(off.preview !== null, "the preview survives an error (Apply is gated on the error, not on it)");

  const allowed = checkGearCount(design, "7", true);
  assertEquals(allowed.error, null, "ticking fractional teeth allows it");
  assert(
    allowed.preview.tiers.some((tier) => tier.facets.some((facet) => !Number.isInteger(facet.index))),
    "and the preview holds the fractional indices",
  );

  assertEquals(checkGearCount(null, "48", false), { error: null, preview: null }, "no design: nothing to object to");
  assertEquals(checkGearCount(null, "x", false).error, "Enter a whole number of teeth, greater than 0.");
});

/*
 * Test: the validation must not change the design. Verifies that checking a count is a pure
 * question -- the design's own gear and facet indices are exactly what they were -- because the
 * dialog checks on every keystroke and only Apply writes.
 */
Deno.test("checking a gear count never mutates the design", { ignore: !SAMPLES_PRESENT }, async () => {
  const design = await srb();
  const before = JSON.stringify(design.tiers.map((tier) => tier.facets.map((facet) => facet.index)));
  const gear = JSON.stringify(design.gear);

  checkGearCount(design, "7", false);
  checkGearCount(design, "7", true);
  checkGearCount(design, "48", false);

  assertEquals(JSON.stringify(design.tiers.map((tier) => tier.facets.map((facet) => facet.index))), before);
  assertEquals(JSON.stringify(design.gear), gear);
});

// ---------------------------------------------------------------------------
// The panel's tables
// ---------------------------------------------------------------------------

/*
 * Test: every slider that is a Rust parameter has a range and a readout format. Verifies that
 * adding a name to PARAM_SLIDERS without a SLIDER_SPECS/FORMAT entry (or the reverse) fails here
 * rather than as a blank slider in the browser -- the same failure shape as the stale-parameter
 * trap in kb/browser-harness.md.
 */
Deno.test("every parameter slider has a range and a readout format", () => {
  for (const name of PARAM_SLIDERS) {
    const spec = SLIDER_SPECS[name];

    assert(spec !== undefined, `${name} has no SLIDER_SPECS entry`);
    assert(spec.min < spec.max && spec.step > 0, `${name} has a sane range`);
    assert(typeof FORMAT[name] === "function", `${name} has no readout format`);
  }

  assertEquals(FORMAT.headShadowHalfAngle(0), "off");
  assertEquals(FORMAT.headShadowHalfAngle(16), "16° (32° cone)");
  assertEquals(FORMAT.spin(12.34), "12.3°");
  assertEquals(FORMAT.spin(12), "12°");
});

/*
 * Setup: the page-only sliders (the two resolutions and the sample target) used to be native range
 * inputs, and a typed readout value was put where the slider could sit by assigning it to the
 * input, which clamps to the range and rounds to the step. They are Bits UI sliders now, which
 * are not inputs, so snapToSpec does that.
 *
 * Test: values inside, beyond and between steps, for a fractional step (the resolution: 15% to
 * 100% in 5% steps) and an integer one (the sample target).
 *
 * Verifies that a value lands on the range and step exactly as the native input put it -- with no
 * floating-point tail (0.15 + 3 * 0.05 must be 0.3, not 0.30000000000000004) -- since the number
 * is what gets stored and shown.
 */
Deno.test("snapToSpec puts a typed value where a slider can sit", () => {
  const resolution = SLIDER_SPECS.resolution;
  const samples = SLIDER_SPECS["lux-target"];

  // Already on a step: unchanged.
  assertEquals(snapToSpec(0.4, resolution), 0.4);
  // Between steps: the nearest one (0.57 is nearer 0.55 than 0.6).
  assertEquals(snapToSpec(0.57, resolution), 0.55);
  assertEquals(snapToSpec(0.58, resolution), 0.6);
  // Steps are counted from the minimum (0.15), so 0.3 is the third step, printed without a tail.
  assertEquals(snapToSpec(0.30000000000000004, resolution), 0.3);
  // Beyond the ends: pinned there.
  assertEquals(snapToSpec(5, resolution), 1);
  assertEquals(snapToSpec(0, resolution), 0.15);
  // An integer step: rounded to a whole number and pinned to the range.
  assertEquals(snapToSpec(40.4, samples), 40);
  assertEquals(snapToSpec(9999, samples), 4096);
  assertEquals(snapToSpec(-3, samples), 1);
});

/*
 * Setup: a stand-in for a DOM element -- just the two methods a listener needs (addEventListener
 * and removeEventListener) over a plain object -- since Deno has no DOM. `fire` calls the
 * listeners registered for an event type, as dispatching an event on the element would.
 */
function fakeElement() {
  const listeners = {};

  return {
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) { listeners[type] = (listeners[type] || []).filter((h) => h !== handler); },
    fire(type) { for (const handler of listeners[type] || []) handler({ type }); },
    count(type) { return (listeners[type] || []).length; },
  };
}

/*
 * Test: nativeChecked makes a Bits UI switch (a button, which has no `checked`) answer to the tools
 * that drive the page's checkboxes: tools/gcs_compare/gcs_views.py does
 * `box.checked = true; box.dispatchEvent(new Event('change'))` on #useWindowColor.
 *
 * Verifies that reading `checked` gives the control's state, that assigning it sets the state WITHOUT
 * calling the change handler (assigning to a real input fires nothing), that a `change` event then
 * calls the handler with the state, and that the cleanup removes the listener and the property.
 */
Deno.test("nativeChecked lets a script drive a switch like a checkbox", () => {
  const element = fakeElement();
  let state = false;
  const seen = [];
  const cleanup = nativeChecked({
    get: () => state,
    set: (value) => { state = Boolean(value); },
    onchange: (checked) => seen.push(checked),
  })(element);

  assertEquals(element.checked, false);

  element.checked = true;
  assertEquals(state, true);
  assertEquals(seen, [], "assigning does not call the handler");

  element.fire("change");
  assertEquals(seen, [true], "a change event calls it with the state");

  cleanup();
  assertEquals(element.count("change"), 0);
  assertEquals("checked" in element, false);
});

/*
 * Test: `listen` (an action for plain elements) adds every pair and its destroy removes them all.
 * Verifies that a listener is attached to the element itself, which is what lets a NON-bubbling
 * synthetic event reach it (Svelte's delegated handlers would miss it).
 */
Deno.test("listen attaches native listeners and removes them on destroy", () => {
  const element = fakeElement();
  const calls = [];
  const action = listen(element, { change: () => calls.push("change"), input: () => calls.push("input") });

  element.fire("change");
  element.fire("input");
  assertEquals(calls, ["change", "input"]);

  action.destroy();
  assertEquals(element.count("change") + element.count("input"), 0);
});

// ---------------------------------------------------------------------------
// The pane scoot (T-0188): the canvas held still while the instructions pane is dragged
// ---------------------------------------------------------------------------

const { engine } = await import("../src/lib/stores.js");
const { attachCanvasControls, requestRender, beginPaneScoot, endPaneScoot } =
  await import("../src/lib/viewport.js");

/*
 * Setup: a stub canvas that records its class list and inline custom properties and reports a CSS
 * size we control (`clientWidth` / `clientHeight`, which is what the layout would report), a stub
 * `app` that counts `render` calls and remembers the backing size it was asked for, and a fake
 * `setTimeout` that queues callbacks so the test decides when a render "happens" -- since
 * 2026-09-19 a render is a budgeted macrotask, not an animation frame (work_budget.js), so that
 * the interface is never blocked waiting for a trace pass.
 *
 * Test: draw once at 800x600 CSS (the size a scoot pins the canvas to); begin a scoot; change the
 * canvas's reported size the way the pane dragging would (a layout change); check nothing was
 * redrawn and the canvas carries the pinning class and the custom properties with the rendered
 * size; end the scoot and check the size is released and exactly ONE redraw is queued, at the new
 * size. Then a second scoot that ends at the size the canvas already had must queue none.
 *
 * Verifies the two promises of the feature: no render (and so no backing-store change, which is
 * what restarts the accumulation) while scooting, and a single settle render afterwards -- and none
 * at all when the region came back to the size the picture already has.
 */
Deno.test("a pane scoot pins the canvas, draws nothing, and settles with one render", () => {
  const frames = [];
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  // The render loop's own scheduler: a queue the test drains itself, so no test waits on a timer.
  globalThis.setTimeout = (callback) => { frames.push(callback); return frames.length; };
  globalThis.clearTimeout = () => {};
  globalThis.document = { hidden: false };
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };

  const classes = new Set();
  const properties = {};
  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    style: {
      setProperty: (name, value) => { properties[name] = value; },
      removeProperty: (name) => { delete properties[name]; },
    },
    addEventListener() {},
  };
  const renders = [];

  engine.app = {
    render: (width, height) => renders.push([width, height]),
    renderer: () => 0,
    accumulating: () => false,
    accumulation_complete: () => true,
    accumulated_passes: () => 0,
    get_param: () => 1,
  };
  attachCanvasControls(canvas);

  const runFrames = () => { while (frames.length) { frames.shift()(); } };

  // Before anything has been drawn there is no size to pin to: a scoot does nothing.
  beginPaneScoot();
  assertEquals([...classes], [], "no scoot before the first render");

  requestRender();
  runFrames();
  assertEquals(renders.length, 1, "the first render");

  // The drag: pinned at 800x600, then the region changes size under it.
  beginPaneScoot();
  beginPaneScoot(); // held key repeats: idempotent
  canvas.clientWidth = 650;
  assertEquals([...classes], ["scooting"]);
  assertEquals(properties, { "--scoot-w": "800px", "--scoot-h": "600px" });
  runFrames();
  assertEquals(renders.length, 1, "nothing is drawn while scooting");

  // The release: released, and one render queued at the region's new size.
  endPaneScoot();
  assertEquals([...classes], [], "the pinning is released");
  assertEquals(properties, {}, "the custom properties are removed");
  runFrames();
  assertEquals(renders, [[800, 600], [650, 600]], "exactly one settle render, at the new size");

  // A scoot that ends where the picture already fits draws nothing.
  beginPaneScoot();
  canvas.clientWidth = 700;
  canvas.clientWidth = 650;
  endPaneScoot();
  runFrames();
  assertEquals(renders.length, 2, "no render when the size is unchanged");

  // Ending when not scooting is a no-op.
  endPaneScoot();
  runFrames();
  assertEquals(renders.length, 2);

  engine.app = null;
});
