// The render loop and the camera: everything that touches the canvas. Plain JS on purpose (the
// port's rule): the WebGL side never depends on Svelte's reactivity. It reads the page-only
// settings from stores (resolution, accumulation target) and writes what the panel shows back
// to them (the LuxCore progress line, and the spin/tilt sliders via `bumpParams`).

import { get } from 'svelte/store';
import {
  engine, luxProgress, accumulationTarget, resolutionScale, dragQuality, bumpParams,
  programLinking, showError,
} from './stores.js';
import {
  clearFacetAndTierHighlight, highlightFacetAndItsTier,
} from './selection.js';
import { getDesign, tierBeingEdited, stonePickBlocked } from './tier_controller.js';
import { designFacetForNormal } from './edit_geometry.js';
import { enterEditMode } from './edit_mode.js';
import { budgetedTask } from './work_budget.js';
import { shaderCompileIsSlow, showShaderCompileNotice } from './shader_wait.js';

/** How long after the last movement full quality comes back. */
const INTERACTION_MS = 160;

let canvas = null;
let interactionTimer = null;
let interacting = false;
// The running turn towards a double-clicked facet, or null.
let facetTurn = null;

// ---- render loop, driven on demand rather than continuously
//
// **The picture is drawn on its own clock, not the interface's** (2026-09-19, the user: "is it
// possible to decouple the UI refresh rate with the rendering refresh rate? in both edit mode and
// the rendering settings menu and everywhere else"). `app.render` is one long synchronous call on
// the page's own thread -- a trace pass, tens of milliseconds -- so whatever frame it runs in
// belongs to it alone. It used to run inside `requestAnimationFrame`, and chain itself from one
// frame to the next while accumulating, which is exactly the interface's own frame: a drag then
// moved a pass at a time.
//
// Now every pass runs in a plain macrotask under a budget (`work_budget.js`): the renderer takes
// at most RENDER_BUDGET of the wall clock and leaves the rest to pointer events, Svelte's updates
// and paint, and the browser paints between passes. Nothing else about the loop changed -- one
// `render()` is still one pass, and the loop still stops on its own when the target is met.
//
// **One pass in flight at a time** (T-0197, 2026-09-19, the user: "when i switch the raytracer to
// montecarlo its extremely slow and freezes my computer"). `app.render` only submits the pass; it
// returns in a fraction of a millisecond while the GPU spends hundreds on it. So the budget above
// was sizing its gap from a number 15-20x too small, and the Monte Carlo loop -- the only one that
// chains passes -- queued hundreds of full-resolution traces the GPU could not keep up with, until
// the driver blocked the page inside `render` and took the whole compositor with it. `frame_settled`
// polls a GL fence dropped after the pass, so the next one is not submitted until the last has
// actually been drawn.
//
// Note what the budget now rations. A settled pass barely touches the page thread -- it is GPU
// time -- so the gap is no longer protecting the interface from the tracer (the fence already
// does that, by never letting more than one pass be outstanding). It is leaving the GPU idle
// between passes, which is what keeps the rest of the desktop responsive while the stone
// converges.
const RENDER_BUDGET = 0.7;

const renderTask = budgetedTask({
  run: renderNow,
  budget: RENDER_BUDGET,
  // Nothing is shown while the tab is hidden, and the browser throttles its timers anyway.
  // (Guarded, because the tests exercise this module without a document.)
  paused: () => typeof document !== 'undefined' && document.hidden,
  // Guarded on the method's existence so an older wasm module still loads: without a fence the
  // loop behaves as it did before, which is wrong but not broken.
  settled: () => !engine.app?.frame_settled || engine.app.frame_settled(),
});

// Whether the view is not to be drawn for now (T-0261): tilt performance, while it measures. Its
// measurement shares the GPU with the view, and a frame of the view -- worse, a change of the
// canvas's size between draft and full quality, which waits for everything the GPU has queued --
// held the sweep up for seconds (measured 2026-09-26: 0.5-1 s on its own, 6 s with the view
// drawing in between). A redraw asked for meanwhile is kept, and made by `releaseRenderHold`.
let renderHold = () => false;
let renderDeferred = false;

/** Holds every redraw back for as long as `reader()` says so; see `releaseRenderHold`. */
export function setRenderHold(reader) {
  renderHold = reader;
}

/** Makes the redraw asked for while the view was held, if there was one. */
export function releaseRenderHold() {
  if (renderDeferred) {
    renderDeferred = false;
    requestRender();
  }
}

/** Asks for a redraw, soon. Every change goes through here, and none of them waits for it. */
export function requestRender() {
  if (renderHold()) {
    renderDeferred = true;
    return;
  }

  renderTask.request();
}

/** One pass: what the animation frame used to do. */
function renderNow() {
  const app = engine.app;

  // A redraw asked for before the hold began, and run after: kept for later all the same.
  if (renderHold()) {
    renderDeferred = true;
    return;
  }

  // Drop resolution while the user is moving. This is the single largest lever
  // available: cost is proportional to pixel count, so rendering at half scale
  // is a 4x saving, on top of the bounce-count reduction draft mode applies in Rust
  // (`RenderParams::draft`, driven by this same `dragQuality` fraction -- see
  // `beginInteraction`). Multiplying the configured resolution rather than replacing it
  // outright is what makes 100% "drag quality" indistinguishable from a still frame,
  // matching what 100% does to the bounce count on the Rust side.
  const scale = interacting ? get(resolutionScale) * get(dragQuality) : get(resolutionScale);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr * scale));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr * scale));

  // What the picture on the canvas now covers, in CSS pixels: what a pane scoot pins the
  // canvas to (below).
  renderedCssWidth = canvas.clientWidth;
  renderedCssHeight = canvas.clientHeight;

  // Where links cannot be polled (Firefox), the first frame to need a renderer's program would
  // compile it inside `render()`, freezing the page for seconds with nothing to say why. Put
  // the compile notice up first and link then; the frame is drawn once that is done.
  if (app.links_block?.() && !app.current_program_ready()) {
    linkBehindNotice();
    return;
  }

  app.render(width, height);
  syncLuxProgress();

  // Guarded on the method's existence, like `settled` above, for the tests' stand-in apps.
  if (app.program_linking?.()) {
    watchProgramLinks();
  }

  // Keep going while the ported path still owes the target more samples (T-0122).
  //
  // This is what makes accumulation visible to the user: `render()` adds one pass, so
  // without a loop the image would stop at one sample and look exactly like the noisy
  // single-draw renderer it replaced. It goes through requestRender rather than a
  // separate timer, so there is one place that decides when a frame happens, and it
  // stops on its own once the target is met.
  if (stillAccumulating()) {
    requestRender();
  }
}

// ---- renderers whose shader program is still compiling (2026-09-23)
//
// Each renderer is its own shader program, linked the first time a frame needs it rather than
// all at page load (`ProgramKind` in src/renderer/lib.rs: Direct3D takes seconds over each).
// Until it is ready `render()` draws the deterministic renderer in its place and does not
// accumulate, so nothing else would ask for another frame. This asks the driver every 16 ms --
// a query that never waits -- and draws again the moment the link is done. A timer rather than
// requestAnimationFrame, which a hidden tab never fires, so a link started just before the
// user switched tabs is finished when they come back.
// Browsers without KHR_parallel_shader_compile take `linkBehindNotice` instead, so this never
// starts there.
let watchingLinks = false;
let linkingBehindNotice = false;

/**
 * Links the current renderer's program blocking, with the compile notice on screen for the
 * wait -- the same one boot shows, and for the same reason (shader_wait.js): the page thread is
 * frozen for the whole link, so the notice has to be painted before it starts. Only where the
 * link is slow enough to be worth a notice; elsewhere it links straight away.
 */
function linkBehindNotice() {
  if (linkingBehindNotice) {
    return;
  }

  linkingBehindNotice = true;

  const notice = shaderCompileIsSlow(canvas)
    ? showShaderCompileNotice(document.getElementById('viewport'), canvas)
    : null;

  Promise.resolve(notice?.painted).then(() => {
    const app = engine.app;

    try {
      app.link_current_program();

      const error = app.program_error();

      if (error) {
        showError(error);
      }
    } finally {
      notice?.remove();
      linkingBehindNotice = false;
    }

    requestRender();
  });
}

function watchProgramLinks() {
  if (watchingLinks) {
    return;
  }

  watchingLinks = true;
  programLinking.set(true);

  const poll = () => {
    const app = engine.app;

    if (app.poll_program_links()) {
      const error = app.program_error();

      if (error) {
        showError(error);
      }

      requestRender();
    }

    if (app.program_linking()) {
      setTimeout(poll, 16);
      return;
    }

    watchingLinks = false;
    programLinking.set(false);
  };

  setTimeout(poll, 16);
}

/**
 * How long the last trace pass took, in ms -- to where the GPU finished it, not to where
 * `render()` returned, which is a number 15-20x smaller and means nothing (T-0197). For the
 * harness and for diagnosing a slow page.
 */
export function lastRenderCost() {
  return renderTask.cost();
}

// ---- scooting the canvas while the instructions pane is dragged (T-0188)
//
// Dragging the pane's handle changes the renderer's region every pointer move. Following it
// with a redraw at the new size costs a full render per step (the canvas's backing store is
// part of the accumulation key, so the LuxCore-style renderer also throws its sum away every
// step). Instead, for as long as the drag lasts the canvas is pinned to the size it was last
// rendered at and centred in the region, which clips it (a region smaller than the picture) or
// leaves the page background around it (a larger one); its pixels never change, so nothing is
// redrawn. `endPaneScoot` lets it go and draws once at the final size.
//
// Centred rather than pinned to the pane's edge: the stone sits in the middle of the canvas, so
// the middle is where the settled render will put it, and the picture does not jump on release.
// Sized in CSS px from `renderedCss*` rather than measured, because a key press on the handle
// has already moved the layout by the time the page hears of it.
let renderedCssWidth = 0;
let renderedCssHeight = 0;
let scooting = false;

/**
 * The renderer's region changed size on its own, with the window the size it was: the fullscreen
 * toggle (fullscreen.js) hiding the top bar and the instructions pane. The canvas fills the
 * region by CSS, but its backing store is only resized by a render, and hiding an element fires
 * no window `resize` -- the event the canvas otherwise redraws on -- so one is asked for here.
 *
 * A no-op before the canvas is wired (`attachCanvasControls`, at the end of boot), which is what
 * makes it safe to call from a control that exists before the wasm module has loaded, or when it
 * never does: `renderNow` would read `canvas.clientWidth` off null.
 */
export function renderRegionChanged() {
  if (canvas === null) {
    return;
  }

  requestRender();
}

/**
 * Pins the canvas to its rendered size and centres it in the renderer's region, so the region
 * can change without the picture being redrawn. Harmless before the first render, and a second
 * call while scooting does nothing.
 */
export function beginPaneScoot() {
  if (canvas === null || scooting || renderedCssWidth === 0 || renderedCssHeight === 0) {
    return;
  }

  scooting = true;
  canvas.style.setProperty('--scoot-w', `${renderedCssWidth}px`);
  canvas.style.setProperty('--scoot-h', `${renderedCssHeight}px`);
  canvas.classList.add('scooting');
}

/**
 * Ends a scoot: the canvas fills the region again and is redrawn once at its size, unless the
 * region is the size it already was (a drag back to where it began, or a key press at a limit),
 * in which case the picture is already right. A render is queued for the next animation frame,
 * which runs before the frame is painted, so the picture is never shown stretched.
 */
export function endPaneScoot() {
  if (!scooting) {
    return;
  }

  scooting = false;
  canvas.classList.remove('scooting');
  canvas.style.removeProperty('--scoot-w');
  canvas.style.removeProperty('--scoot-h');

  if (canvas.clientWidth !== renderedCssWidth || canvas.clientHeight !== renderedCssHeight) {
    requestRender();
  }
}

// True while a pointer button is held anywhere on the page: the canvas, a slider, one of edit
// mode's scales, the index ruler. Quality is never restored while one is, however long the page
// blocks between moves -- a rebuild can take longer than the wait below, and the picture was
// coming back to full resolution in the middle of a drag, at the cost of a whole full-quality
// pass that the next move immediately threw away (measured: the backing store flapping between
// 276 and 690 px across one drag). Listened for in the CAPTURE phase, so nothing can stop it.
let pointerHeld = false;

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => { pointerHeld = true; }, true);

  for (const ending of ['pointerup', 'pointercancel']) {
    document.addEventListener(ending, () => { pointerHeld = false; }, true);
  }

  // A pointer lost with the window (a drag that ends outside it) must not leave the page drafting
  // for ever.
  window.addEventListener('blur', () => { pointerHeld = false; });
}

/**
 * Drops quality while the user is actively moving anything, restoring it shortly after they
 * stop (2026-09-19, the user: "when the ruler is moved or the angles of the cut are changed or
 * the depth of the cut is changed or the stone is moved or anything can you make sure the
 * resolution is dropped and the internal bounces are dropped"). Draft mode scales the bounce
 * count by `dragQuality` and quarters the samples (`RenderParams::draft`, driven by whatever
 * `app.set_drag_quality` last set); the page also renders at `resolutionScale * dragQuality`
 * while `interacting`, above -- the same fraction multiplying both, linearly, so "quality
 * while dragging" is one setting rather than two that could disagree.
 */
export function beginInteraction() {
  const app = engine.app;

  interacting = true;
  app.set_draft_mode(true);

  if (interactionTimer !== null) {
    clearTimeout(interactionTimer);
  }

  const settle = () => {
    if (pointerHeld) {
      // Still being dragged: look again rather than paying for a full-quality pass now.
      interactionTimer = setTimeout(settle, INTERACTION_MS);
      return;
    }

    interacting = false;
    app.set_draft_mode(false);
    interactionTimer = null;
    requestRender();
  };

  interactionTimer = setTimeout(settle, INTERACTION_MS);
}

// ---- progressive accumulation (T-0122)
//
// Two separate numbers, because they are not the same decision:
//
//   Samples per frame  (luxSamples, a Rust parameter) is how much work ONE frame does.
//                      1 by default: the smallest step that still converges is what
//                      keeps the view responsive, because the image improves across
//                      frames rather than inside one draw.
//   Samples to         is when to stop asking for frames. It lives only here (the
//   accumulate         `accumulationTarget` store), because it is a property of this
//                      page's render loop and not of the renderer -- the wasm side will
//                      accumulate for as long as it is asked to.

/**
 * Samples per pixel accumulated so far. Factored out because this exact expression is
 * also the numerator of the progress percentage below -- computing it twice is how the
 * bar and the stop condition would end up disagreeing about what "done" means.
 */
function accumulatedSamples() {
  const app = engine.app;

  return app.accumulated_passes() * Math.max(1, Math.round(app.get_param('luxSamples')));
}

/** True while the ported path still owes the target more samples. */
export function stillAccumulating() {
  const app = engine.app;

  return app.accumulating()
    && !app.accumulation_complete()
    && accumulatedSamples() < get(accumulationTarget);
}

// ---- elapsed time for the current accumulation
//
// `app.accumulation_generation()` changes exactly when the current accumulation restarts
// (a wasm-bindgen method added for this: it mirrors `params::AccumulationState`'s own
// restart counter, which fires on exactly the condition `params::AccumulationKey`
// already uses -- any change to the effective params, the camera, the backing-store
// size, or the model/environment generation) and holds steady the rest of the time. That
// makes it the honest hook for "when did this run start": watching it means never
// re-deriving the reset rule here, which is exactly how a page-side copy of it would
// drift out of step with the Rust one.
let lastAccumulationGeneration = null;
let accumulationStartedAt = null;
let accumulationFinishedAt = null;

/**
 * Updates the elapsed-time bookkeeping for the current call. Must run before reading
 * `accumulationStartedAt` / `accumulationFinishedAt`.
 */
function noteAccumulationProgress() {
  const generation = engine.app.accumulation_generation();

  if (generation !== lastAccumulationGeneration) {
    lastAccumulationGeneration = generation;
    accumulationStartedAt = performance.now();
    accumulationFinishedAt = null;
  }

  if (stillAccumulating()) {
    // Still running (including a raised target waking a run that had previously
    // finished): the clock must not be frozen.
    accumulationFinishedAt = null;
  } else if (accumulationFinishedAt === null) {
    // The first tick after the target (or the pass cap) is met: freeze the clock here
    // rather than let it keep advancing with the wall clock while no more frames are
    // requested.
    accumulationFinishedAt = performance.now();
  }
}

/** Seconds since the current accumulation began, frozen once it has finished. */
function accumulationElapsedSeconds() {
  const end = accumulationFinishedAt === null ? performance.now() : accumulationFinishedAt;

  return (end - accumulationStartedAt) / 1000;
}

function formatElapsedSeconds(seconds) {
  if (seconds < 10) {
    return `${seconds.toFixed(1)} seconds`;
  }

  const whole = Math.round(seconds);
  return `${whole} second${whole === 1 ? '' : 's'}`;
}

/**
 * Reports how far the accumulation has got, or why there is none.
 *
 * Worth the line of UI: an image that is noisy because it is one sample in and an image
 * that is noisy because this browser cannot render to a float texture look exactly the
 * same, and only one of them is going to get better.
 */
export function syncLuxProgress() {
  const app = engine.app;

  // Only the LuxCore renderer (1) accumulates; the others finish in one draw.
  if (app.renderer() !== 1) {
    luxProgress.set('');
    return;
  }

  const status = app.accumulation_status();

  if (!status.startsWith('on')) {
    luxProgress.set(`Progressive accumulation is ${status}`);
    return;
  }

  noteAccumulationProgress();

  // The same ratio `stillAccumulating` uses to decide when to stop asking for frames,
  // clamped for display only: the underlying comparison against the target stays exact, so
  // the bar reaches 100% on precisely the frame requests stop.
  const percent = Math.min(
    100,
    Math.round((accumulatedSamples() / Math.max(1, get(accumulationTarget))) * 100)
  );
  const seconds = accumulationElapsedSeconds();
  const finished = !stillAccumulating();
  const finishedSuffix = finished ? ' (converged)' : '';

  // The LuxCore renderer's tooltip already explains that any change restarts it.
  luxProgress.set(`${percent}% complete, over ${formatElapsedSeconds(seconds)}${finishedSuffix}.`);
}

// ---- camera interaction

// A press that moves less than this many CSS pixels before it is released is a click,
// rather than a drag. The stone does not move until the pointer has gone this far, so a
// click does not nudge it first; once it has, the drag takes the whole distance from the
// press, so nothing is lost. Also the position tolerance for whether a second click lands
// close enough to the first to count as one double click (see DOUBLE_CLICK_MS below).
const CLICK_SLOP_PX = 4;
// How long the turn towards a double-clicked facet takes. 450 ms at first; shortened at the
// user's request (2026-09-18, "rotate faster").
const FACET_TURN_MS = 200;

// How long, in ms, after one click a second one still counts as a double click (T-0161's
// scope change: single click highlights only, double click also turns). Not the native
// `dblclick` event -- see the pointerup handler's own comment on why -- so this is the
// threshold this page applies itself, against `performance.now()` timestamps taken at each
// click. 400 ms sits comfortably inside every desktop OS's own default dblclick interval
// (Windows and GNOME both default near 500 ms, macOS is user-configurable but defaults
// slower still), so a deliberate double click is never missed for being too slow.
const DOUBLE_CLICK_MS = 400;

// Whether a sideways drag spins the stone the other way (2026-09-24). The cutting assistant's
// pavilion phase looks at the stone from below with it upside down on the dop (tilt -120), and
// there the usual direction reads backwards: the user, "dragging left moves the rock
// counterclockwise. this is because the rock is flipped upside down. can you reverse the
// direction of pulling on the x axis?". Only the spin is reversed; dragging up and down is
// unchanged. The mode registers the reader (cutting_assistant_mode.js), as it does the stone-pick
// block with tier_controller.js: session.js imports this file and the mode imports session.js, so
// this file does not import the mode.
let reverseDragSpin = () => false;

export function setReverseDragSpin(reader) {
  reverseDragSpin = reader;
}

/** Stops a turn towards a clicked facet where it is, for when the user moves the view. */
export function cancelFacetTurn() {
  if (facetTurn !== null) {
    cancelAnimationFrame(facetTurn.frame);
    facetTurn = null;
  }
}

/** Wraps an angle in degrees into [-180, 180), so a turn always goes the short way round. */
function wrapDegrees(angle) {
  return ((angle + 180) % 360 + 360) % 360 - 180;
}

/**
 * The facet under a point of the canvas, in client pixels, and the pose that looks squarely
 * at it: `[spin, tilt, facet]` in `GemApp::facet_pose_at`'s own shape, or `null` when the
 * point misses the stone (or the canvas has no layout yet, which the same shape covers:
 * `facet_pose_at` would only ever return an empty array for that too).
 */
function pickFacetAt(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();

  if (rect.width === 0 || rect.height === 0) {
    return null;
  }

  // Normalised device coordinates, as the shader's vNdc: y points up.
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;

  const pose = engine.app.facet_pose_at(ndcX, ndcY);

  return pose.length === 3 ? pose : null;
}

/**
 * Animates spin/tilt to an absolute pose, each the short way round -- the turn a
 * double-clicked facet performs. Factored out of the single click/turn combination
 * `turnTowardsFacetAt` used to be, when the user's T-0161 follow-up moved the turn off
 * every click and onto only the second click of a double click.
 */
function animateTurnTo(spinDeg, tiltDeg) {
  const app = engine.app;

  cancelFacetTurn();

  const fromSpin = app.get_param('spin');
  const fromTilt = app.get_param('tilt');
  const spinBy = wrapDegrees(spinDeg - fromSpin);
  const tiltBy = wrapDegrees(tiltDeg - fromTilt);
  const start = performance.now();

  const step = now => {
    const progress = Math.min((now - start) / FACET_TURN_MS, 1);
    // Ease-out cubic: moves at once and settles gently, which feels quicker than an
    // ease-in-out of the same length.
    const eased = 1 - (1 - progress) ** 3;

    app.set_param('spin', fromSpin + spinBy * eased);
    app.set_param('tilt', fromTilt + tiltBy * eased);

    // The X and Y rotation sliders follow the turn.
    bumpParams();

    // Draft quality while it moves, like a drag; full quality returns once it stops.
    beginInteraction();
    requestRender();

    facetTurn = progress < 1 ? { frame: requestAnimationFrame(step) } : null;
  };

  facetTurn = { frame: requestAnimationFrame(step) };
}

/**
 * What a click on the canvas does (T-0160, scope changed the same day by T-0161): highlight
 * the clicked facet's whole design tier, on the stone and in the cutting instructions, with
 * NO turn. `alsoTurn` -- true only when the pointerup handler below has decided this click
 * is the second of a double click -- additionally animates the view to face the clicked
 * facet, exactly what every click did before T-0161.
 *
 * Every click runs this in full, immediately, whether or not it turns out to be part of a
 * double click: the first click of a double click already performs the complete single-click
 * action (the user's own words -- "don't delay single clicks" -- are why there is no click
 * timer here deciding whether to act), and the double click's only extra effect is the turn
 * added on its second click.
 *
 * A background click (`pickFacetAt` returns `null`) always clears both highlights and never
 * turns, whether or not it is the second click of what looked like a double click.
 */
function handleStoneClick(clientX, clientY, alsoTurn) {
  const app = engine.app;

  // The cutting assistant's rough is not the design's stone (T-0234): nothing on it to select,
  // and no turn to one of its facets either. Dragging to orbit still works.
  if (stonePickBlocked()) {
    return;
  }

  const pose = pickFacetAt(clientX, clientY);

  if (pose === null) {
    clearFacetAndTierHighlight(app);
    requestRender();
    return;
  }

  // Highlighted before any turn starts, so the user sees what they hit as it swings round
  // to face them.
  highlightFacetAndItsTier(app, pose[2]);

  // A double click on a facet of a design edits it (T-0193, edit mode's fourth trigger), with
  // the cutting plane on the very facet clicked, and does NOT turn the stone (the user: "don't
  // rotate the rock, just leave it as is"). A plain .obj has no tiers to edit, so there the
  // double click still turns to face the facet, as before.
  //
  // While a tier is already being edited the double click does nothing at all (T-0202, the user:
  // "just lock me in the current facet"): `enterEditMode` refuses to swap the tier, and the turn
  // is skipped too rather than letting a refused edit fall through to moving the view out from
  // under the edit in progress. The single click's highlight has already run, and is pinned to
  // the tier being edited (selection.js).
  const design = getDesign();

  if (alsoTurn && tierBeingEdited() !== null) {
    requestRender();
    return;
  }

  if (alsoTurn && design) {
    const normals = app.facet_normals();
    const at = pose[2] * 3;
    const found = designFacetForNormal(design, { x: normals[at], y: normals[at + 1], z: normals[at + 2] });

    if (found && enterEditMode(found.tier, found.facet)) {
      requestRender();
      return;
    }
  }

  if (alsoTurn) {
    animateTurnTo(pose[0], pose[1]);
  }

  requestRender();
}

/**
 * Wires the canvas: drag to orbit, click to highlight a facet's tier, double click to turn
 * to it, wheel to zoom, and a redraw on window resize. Native listeners (not Svelte's
 * delegated ones): pointer capture and a non-passive wheel handler are exactly what those
 * are not meant for.
 */
export function attachCanvasControls(canvasElement) {
  canvas = canvasElement;

  let dragging = false;
  // The one pointer driving the drag. A second finger on a touch screen is a separate
  // pointer; following both would jump the rotation between their positions.
  let dragPointerId = null;
  let lastX = 0;
  let lastY = 0;
  let pressX = 0;
  let pressY = 0;
  // True once the press has moved beyond CLICK_SLOP_PX, making it a drag rather than a click.
  let pressMoved = false;

  // The timestamp and position of the last real click (a press that did not move past
  // CLICK_SLOP_PX), so the NEXT click can tell whether it is the second half of a double
  // click. 0 means "no pending click": performance.now() is always positive, so a difference
  // against 0 is always well past DOUBLE_CLICK_MS.
  let lastClickAt = 0;
  let lastClickX = 0;
  let lastClickY = 0;

  canvas.addEventListener('pointerdown', event => {
    // Ignore further fingers while one is already dragging.
    if (dragging) {
      return;
    }

    // Grabbing the stone mid-turn takes it over from the turn.
    cancelFacetTurn();

    dragging = true;
    dragPointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    pressX = event.clientX;
    pressY = event.clientY;
    pressMoved = false;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', event => {
    if (!dragging || event.pointerId !== dragPointerId) {
      return;
    }

    if (!pressMoved) {
      if (Math.hypot(event.clientX - pressX, event.clientY - pressY) < CLICK_SLOP_PX) {
        return;
      }

      pressMoved = true;

      // A drag "uses up" any pending click, so a click that happens to follow one shortly
      // after is never mistaken for the second half of a double click that started before the
      // drag -- the user's own requirement: "a drag followed by a click must never trigger a
      // turn".
      lastClickAt = 0;
    }

    const deltaX = event.clientX - lastX;
    const deltaY = event.clientY - lastY;

    lastX = event.clientX;
    lastY = event.clientY;

    // Scale by viewport height so a drag across the window is the same rotation
    // regardless of window size. Dragging up tilts positively, which is the direction
    // the old pitch-based drag took from face-up.
    const scale = 2.5 / canvas.clientHeight;
    const spinSign = reverseDragSpin() ? 1 : -1;

    engine.app.orbit(spinSign * deltaX * scale, -deltaY * scale);

    // Keep the X and Y rotation sliders showing the pose the drag produced.
    bumpParams();

    beginInteraction();
    requestRender();
  });

  function endDrag(event) {
    // Only the dragging pointer ends the drag; lifting a second finger does not.
    if (!dragging || event.pointerId !== dragPointerId) {
      return;
    }

    dragging = false;
    dragPointerId = null;
    canvas.classList.remove('dragging');

    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  canvas.addEventListener('pointerup', event => {
    // A release that never moved past the slop is a click. Checked before endDrag, which
    // forgets the pointer.
    const clicked = dragging && event.pointerId === dragPointerId && !pressMoved
      && event.button === 0;

    endDrag(event);

    if (!clicked) {
      return;
    }

    // Double-click detection by POINTER TIMING, not the native `dblclick` event: `dblclick`
    // only fires after the browser's own click machinery has already run, which would mean
    // either waiting for it (delaying the highlight the user wants on every single click, not
    // just the first of an eventual pair) or reconciling two independent notions of "did this
    // move too far to count" (dblclick has no CLICK_SLOP_PX equivalent). Comparing this
    // click's own timestamp and position against the last one is simpler and gives the exact
    // same slop-aware click definition for both single- and double-click purposes.
    //
    // touch-action: none on #canvas (see its own CSS comment) means a tap here is an ordinary
    // pointerdown/pointerup pair with no browser tap-delay or double-tap-to-zoom gesture in
    // the way, so this should double-tap the same way it double-clicks -- but that is
    // untested on real touch hardware; only CDP mouse events were available to verify this.
    const now = performance.now();
    const isDoubleClick = (now - lastClickAt) <= DOUBLE_CLICK_MS
      && Math.hypot(event.clientX - lastClickX, event.clientY - lastClickY) < CLICK_SLOP_PX;

    // Act immediately, always -- never delay a single click waiting to see if a second one
    // follows. The double click's only extra effect (the turn) is added here, on its second
    // click, not by holding the first one back.
    handleStoneClick(event.clientX, event.clientY, isDoubleClick);

    if (isDoubleClick) {
      // Consumed: a third click starts a fresh pair rather than chaining into a triple.
      lastClickAt = 0;
    } else {
      lastClickAt = now;
      lastClickX = event.clientX;
      lastClickY = event.clientY;
    }
  });
  // A cancelled press (the browser took the gesture over) is never a click.
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', event => {
    event.preventDefault();

    // Exponential so a notch feels the same at any distance.
    engine.app.zoom(Math.exp(event.deltaY * 0.0012));
    beginInteraction();
    requestRender();
  }, { passive: false });

  window.addEventListener('resize', requestRender);
}
