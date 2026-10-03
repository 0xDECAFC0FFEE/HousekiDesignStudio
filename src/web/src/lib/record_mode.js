// Tools > Record rendering (T-0290). The user, 2026-09-29:
//
//   "the right bar should stay the render settings but the left bar should be the recording
//   settings. we need two tracing boxes, one for the preview and one for the final recorded
//   rendering. on the left is the recording settings. it should allow users to set the fps and
//   resolution. it should also show a loading bar once the user sets the path of the rock and a
//   red record button.
//
//   once the user clicks record and the user then clicks on the rock, the app should start
//   recording the x, y and z rotations, rendering the rock with the preview tracing. Once the user
//   releases, the app should start replaying those rotations but each frame is rendered with the
//   tracer set. Once all rendering is complete, the app should show the user a save dialog to save
//   the video as an mp4"
//
// A window onto the design, like tilt performance (kb/application-modes-current-and-planned.md):
// the LEFT pane swaps the cutting instructions for RecordPanel.svelte (Workspace.svelte stacks the
// two), the render settings stay on the right and stay live, the design is held (`setDesignLock`)
// and Undo and Redo are inert. Done, or Escape, closes it and puts back the renderer the user had.
//
// How a recording goes (`phase`):
//
//   idle       the settings can be changed; the red Record button arms the recorder
//   armed      the next press on the stone starts recording (a press anywhere else does nothing)
//   recording  the stone is held: every pose it takes is written down with the time it took it,
//              the view drawn with the Preview renderer as usual. Releasing it ends the take.
//   rendering  every 1/fps seconds of the take becomes a frame (recording.js's samplePoses), and
//              each is drawn off screen at the chosen size with the Final renderer (the renderer's
//              record_* calls, src/renderer/recording.rs), then handed to the encoder. The view is
//              held still meanwhile (it would only compete for the GPU), and two progress bars
//              fill: the frame being drawn, and the whole video (T-0309). Cancel stops it.
//   encoding   the encoder finishes and the MP4 is closed
//   done       the Save As dialog is offered for the video (see `saveVideo`); Record again starts
//              a new take with the same settings
//
// The pose is spin (the X rotation), tilt (Y) and the sideways tilt (Z; T-0288), read from the
// renderer after each pointer move (session.js's readPose) -- the stone only ever moves when the
// pointer does -- so a take is exactly what was on screen, pauses included, whichever drag moved it:
// a plain drag (Y and Z), a Shift + drag (X and Y), or Shift pressed or let go part way (T-0296).
// Closing puts the view back at the pose it had when the mode opened.

import { writable, get } from 'svelte/store';
import { editing } from './edit_mode.js';
import {
  getDesign, tierView, setDesignLock, designLocked, syncToolbar, setStonePickBlock,
} from './tier_controller.js';
import { setLocalHistory, selectRenderer, readPose, applyPose } from './session.js';
import { engine, accumulationTarget, cutMeta, renderer, bumpParams } from './stores.js';
import { setRenderHold, releaseRenderHold } from './viewport.js';
import { budgetedTask } from './work_budget.js';
import { readSettingNumber, writeSetting } from './settings.js';
import { downloadFile } from './export_file.js';
import { createMp4Encoder } from './record_encoder.js';
import {
  RENDERER_DETERMINISTIC, DEFAULT_FPS, DEFAULT_SIZE, FPS_MIN, FPS_MAX, SIZE_MIN, SIZE_MAX,
  RENDER_BUDGET, samplePoses, clampFps, fitSize, passesPerFrame, samplesEachPass, renderProgress,
  chooseEncoderConfig, saveRecording, videoFilename, videoSeconds,
} from './recording.js';

/** What `GemApp::record_advance` says (src/renderer/recording.rs). */
const RECORD_DONE = 2;

/** localStorage keys: the recording settings are remembered, as the render settings are. */
export const RECORD_PREVIEW_SETTING = 'gems.recordPreview';
export const RECORD_FINAL_SETTING = 'gems.recordFinal';
export const RECORD_FPS_SETTING = 'gems.recordFps';
export const RECORD_WIDTH_SETTING = 'gems.recordWidth';
export const RECORD_HEIGHT_SETTING = 'gems.recordHeight';

/** Added to every tier toolbar button's tooltip while the mode holds the design. */
export const CLOSE_RECORDING_TIP = ' Close record rendering first: Done, or Escape.';

/** The most frames the encoder may have waiting before the render waits for it. */
const ENCODER_QUEUE_MAX = 4;

/** How often, at most, the panel's picture of the last finished frame is redrawn, in ms: a
 * 1080p frame is 8 MB of pixels to paint, and the bar already says how far the render is. */
const FRAME_PREVIEW_MS = 250;

/** How often, at most, the take's length is shown while it is being recorded, in ms. */
const CAPTURE_READOUT_MS = 100;

// The browser's pieces, replaceable by the tests (`setRecordBackend`): WebCodecs' encoder check,
// the MP4 encoder, the Save As dialog, the download fallback and the clock.
const DEFAULT_BACKEND = {
  isConfigSupported: config => globalThis.VideoEncoder.isConfigSupported(config),
  hasEncoder: () => typeof globalThis.VideoEncoder === 'function',
  createEncoder: options => createMp4Encoder(options),
  picker: () => (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
    ? options => window.showSaveFilePicker(options)
    : null),
  download: downloadFile,
  now: () => performance.now(),
};

let backend = DEFAULT_BACKEND;

/** For the tests: replaces some of the browser's pieces (the rest stay the real ones). */
export function setRecordBackend(overrides = {}) {
  backend = { ...DEFAULT_BACKEND, ...overrides };
}

/**
 * What the panel draws: `{ open, phase, settings, support, captured, result, save, message }`.
 *
 * - `settings`: `{ preview, final, fps, width, height }`, the two renderers as
 *   `params::Renderer::as_u32` numbers them;
 * - `support`: `{ state: 'checking' | 'ok' | 'unsupported', reason }`, whether this browser can
 *   encode an MP4 of this size (the Record button is off, and `reason` says why, when it cannot);
 * - `captured`: `{ frames, seconds }`, how long the take is (while recording) or was;
 * - `result`: `{ frames, seconds, width, height, fps, bytes, filename }` once the video is made;
 * - `save`: 'saving' while a save is under way, then recording.js's `saveRecording` outcome for
 *   the last save, or null; `saveName` the file's name and `saveError` why a save failed;
 * - `message`: one line for the panel (a take too short, a cancel, a failure), or ''.
 */
export const recording = writable(closedState());

/** The final render's progress, recording.js's `renderProgress`: `{ done, total, fraction,
 * frame }`, the Video render card's two bars -- the frame being drawn (`frame`) and the whole video
 * (`fraction`; T-0309). Kept apart from `recording` so a pass finishing moves the bars without
 * redrawing the rest of the panel. */
export const recordProgress = writable(renderProgress());

/** The last finished frame, `{ pixels, width, height, index }`, for the panel's small picture of
 * the video as it is made; null before the first. */
export const recordFrame = writable(null);

function closedState() {
  return {
    open: false,
    phase: 'idle',
    settings: {
      preview: RENDERER_DETERMINISTIC, final: RENDERER_DETERMINISTIC, fps: DEFAULT_FPS,
      ...DEFAULT_SIZE,
    },
    support: { state: 'checking', reason: '' },
    captured: { frames: 0, seconds: 0 },
    result: null,
    save: null,
    saveName: '',
    saveError: '',
    message: '',
  };
}

// The open session, or null:
//   design        the design the mode opened on (another loaded under it ends it)
//   userRenderer  the renderer the user had, put back on closing
//   detach        what takes the mode's listeners off the canvas
//   config        the encoder configuration the support check found for the settings, or null
//   track         the take: [{ t, pose }], t in ms from the press
//   pointer       the pointer the take follows
//   startedAt     when the press was, on the backend's clock
//   poses         the frames to render (samplePoses), and `index`, the next one
//   frameBegun    whether the renderer has been given frame `index` yet
//   drawsPerFrame the draws every frame takes (record_passes_total, fixed by record_start), and
//   samplesPerDraw  the samples per pixel each adds: the frame bar's measure (T-0309)
//   encoder, task the MP4 being written and the budgeted loop drawing its frames
//   blob          the finished video
let session = null;

/** True while the mode is open. */
export function recordingOpen() {
  return session !== null;
}

// The whole design is held while the mode is open, and the toolbar says why; a press on the stone
// is the recorder's, not a pick; and the view is not drawn while the final render has the GPU.
setDesignLock(() => session !== null, CLOSE_RECORDING_TIP);
setStonePickBlock(() => session !== null);
setRenderHold(() => session !== null && get(recording).phase === 'rendering');

/** Undo and Redo while open: nothing to step -- the mode changes nothing in the design. */
const INERT_HISTORY = {
  canUndo: () => false,
  canRedo: () => false,
  undo: () => {},
  redo: () => {},
};

function setState(changes) {
  recording.update(state => ({ ...state, ...changes }));
}

function phase() {
  return get(recording).phase;
}

/** The recording settings as last saved, or their defaults (the Final renderer defaults to the
 * one the user is rendering with). */
function savedSettings(app) {
  const size = fitSize(
    readSettingNumber(RECORD_WIDTH_SETTING, SIZE_MIN, SIZE_MAX, DEFAULT_SIZE.width),
    readSettingNumber(RECORD_HEIGHT_SETTING, SIZE_MIN, SIZE_MAX, DEFAULT_SIZE.height),
  );

  return {
    preview: readSettingNumber(RECORD_PREVIEW_SETTING, 0, 2, RENDERER_DETERMINISTIC),
    final: readSettingNumber(RECORD_FINAL_SETTING, 0, 2, app.renderer()),
    fps: clampFps(readSettingNumber(RECORD_FPS_SETTING, FPS_MIN, FPS_MAX, DEFAULT_FPS)),
    ...size,
  };
}

/**
 * Opens the mode. Works for any stone, a plain .obj as well as a design. Does nothing, and returns
 * false, with no renderer, while another mode is open, or while this one already is. `canvas` is
 * the stone's canvas (the page's #canvas by default; the tests pass a stand-in).
 */
export function enterRecording({ canvas } = {}) {
  const app = engine.app;

  if (session !== null || get(editing) !== null || designLocked() || !app) {
    return false;
  }

  const settings = savedSettings(app);
  const element = canvas ?? (typeof document !== 'undefined' ? document.getElementById('canvas') : null);

  session = {
    design: getDesign(),
    userRenderer: app.renderer(),
    // The view's pose -- spin, tilt and the sideways tilt -- put back on closing: a take turns
    // the stone wherever the user drags it, and the mode leaves the view as it found it.
    pose: readPose(app),
    detach: null,
    config: null,
    track: [],
    pointer: null,
    startedAt: 0,
    capturedShownAt: -Infinity,
    poses: [],
    index: 0,
    frameBegun: false,
    drawsPerFrame: 1,
    samplesPerDraw: 1,
    frameShownAt: -Infinity,
    encoder: null,
    task: null,
    blob: null,
    supportCheck: 0,
  };
  session.detach = watchCanvas(element);

  setLocalHistory(INERT_HISTORY);
  recording.set({ ...closedState(), open: true, settings });
  recordProgress.set(renderProgress());
  recordFrame.set(null);
  syncToolbar();

  // The view is drawn with the Preview renderer for as long as the mode is open.
  if (app.renderer() !== settings.preview) {
    selectRenderer(settings.preview, { remember: false });
  }

  checkSupport();
  return true;
}

/** Done, and Escape with nothing running: stops whatever is running and closes the mode. */
export function exitRecording() {
  if (session === null) {
    return;
  }

  stopFinalRender();
  session.detach?.();

  const { userRenderer, pose } = session;

  session = null;
  setLocalHistory(null);
  recording.set(closedState());
  recordProgress.set(renderProgress());
  recordFrame.set(null);
  syncToolbar();
  releaseRenderHold();

  // The user's own renderer back, whatever the Preview renderer was, and the view's pose as it
  // was before the first take.
  if (engine.app) {
    if (engine.app.renderer() !== userRenderer) {
      selectRenderer(userRenderer, { remember: false });
    }

    applyPose(pose);
    bumpParams();
  }

  window.gemRequestRender?.();
}

/**
 * Escape: one step back at a time. A final render is cancelled (the mode stays open), a take in
 * progress is dropped and the recorder armed again, an armed recorder disarmed; with nothing
 * running, the mode closes, as Done does.
 */
export function escapeRecording() {
  const current = phase();

  if (current === 'rendering' || current === 'encoding') {
    cancelRender();
  } else if (current === 'recording') {
    session.track = [];
    session.pointer = null;
    setState({ phase: 'armed', captured: { frames: 0, seconds: 0 } });
  } else if (current === 'armed') {
    setState({ phase: 'idle' });
  } else {
    exitRecording();
  }
}

/**
 * Changes one recording setting (`preview`, `final`, `fps`, `width` or `height`), and remembers
 * it. Not while a take is being recorded or rendered: the frames already drawn were drawn with
 * the settings as they were. A new Preview renderer draws the view at once.
 */
export function setRecordSetting(name, value) {
  if (session === null || ['recording', 'rendering', 'encoding'].includes(phase())) {
    return;
  }

  const settings = { ...get(recording).settings };

  if (name === 'preview' || name === 'final') {
    settings[name] = Math.min(2, Math.max(0, Math.round(Number(value)) || 0));
  } else if (name === 'fps') {
    settings.fps = clampFps(value);
  } else if (name === 'width' || name === 'height') {
    Object.assign(settings, fitSize(name === 'width' ? value : settings.width,
      name === 'height' ? value : settings.height));
  } else {
    return;
  }

  setState({ settings });
  writeSetting(RECORD_PREVIEW_SETTING, String(settings.preview));
  writeSetting(RECORD_FINAL_SETTING, String(settings.final));
  writeSetting(RECORD_FPS_SETTING, String(settings.fps));
  writeSetting(RECORD_WIDTH_SETTING, String(settings.width));
  writeSetting(RECORD_HEIGHT_SETTING, String(settings.height));

  if (name === 'preview' && engine.app.renderer() !== settings.preview) {
    selectRenderer(settings.preview, { remember: false });
  }

  if (name === 'fps' || name === 'width' || name === 'height') {
    checkSupport();
  }
}

/** Sets the size to a preset's, `{ width, height }`. */
export function setRecordSize({ width, height }) {
  setRecordSetting('width', width);
  setRecordSetting('height', height);
}

/**
 * Asks the browser whether it can encode an MP4 of the size and frame rate set, and keeps the
 * configuration it can. The Record button waits for the answer, and says why when it is no.
 */
function checkSupport() {
  const token = ++session.supportCheck;
  const { width, height, fps } = get(recording).settings;

  setState({ support: { state: 'checking', reason: '' } });

  if (!backend.hasEncoder()) {
    session.config = null;
    setState({
      support: {
        state: 'unsupported',
        reason: 'This browser cannot make MP4 video: it has no video encoder for web pages ' +
          '(WebCodecs). Chrome and Edge can, and Safari 16.4 or later.',
      },
    });
    return Promise.resolve();
  }

  return chooseEncoderConfig(width, height, fps, backend.isConfigSupported).then(config => {
    if (session === null || token !== session.supportCheck) {
      return;
    }

    session.config = config;
    setState({
      support: config
        ? { state: 'ok', reason: '' }
        : {
          state: 'unsupported',
          reason: `This browser cannot encode a ${width} × ${height} MP4 at ${fps} frames a ` +
            'second (it has no H.264 encoder for that size). Try a smaller size.',
        },
    });
  });
}

/** The red Record button: arms the recorder, or disarms it when it is already armed. */
export function toggleRecord() {
  if (session === null) {
    return;
  }

  const current = phase();

  if (current === 'armed') {
    setState({ phase: 'idle', message: '' });
  } else if ((current === 'idle' || current === 'done') && get(recording).support.state === 'ok') {
    setState({
      phase: 'armed', message: '', result: null, save: null, saveName: '', saveError: '',
      captured: { frames: 0, seconds: 0 },
    });
    recordProgress.set(renderProgress());
    recordFrame.set(null);
    session.blob = null;
  }
}

// ---- the take

/**
 * Listens to presses on the stone for as long as the mode is open. Registered after the page's
 * own canvas listeners (viewport.js, at boot), so by the time these run a pointer move has already
 * turned the stone, and the pose read is the one it moved to. Returns what removes them.
 */
function watchCanvas(canvas) {
  if (!canvas?.addEventListener) {
    return () => {};
  }

  const handlers = {
    pointerdown: event => pressed(event),
    pointermove: event => moved(event),
    pointerup: event => released(event),
    pointercancel: event => released(event),
  };

  for (const [type, handler] of Object.entries(handlers)) {
    canvas.addEventListener(type, handler);
  }

  return () => {
    for (const [type, handler] of Object.entries(handlers)) {
      canvas.removeEventListener?.(type, handler);
    }
  };
}

/** A press on the stone: an armed recorder starts the take, with the pose the stone has now. */
export function pressed(event) {
  if (session === null || phase() !== 'armed' || (event.button ?? 0) !== 0) {
    return;
  }

  session.pointer = event.pointerId;
  session.startedAt = backend.now();
  session.track = [{ t: 0, pose: readPose(engine.app) }];
  session.capturedShownAt = -Infinity;
  setState({ phase: 'recording', message: '', captured: { frames: 1, seconds: 0 } });
}

/** The stone moved under the pointer: writes the pose down with the time. */
export function moved(event) {
  if (session === null || phase() !== 'recording' || event.pointerId !== session.pointer) {
    return;
  }

  note();
}

/** The stone let go: the take ends, and its frames are rendered. */
export function released(event) {
  if (session === null || phase() !== 'recording' || event.pointerId !== session.pointer) {
    return;
  }

  note(true);
  session.pointer = null;

  const { settings } = get(recording);
  const moved = session.track.some(({ pose }) =>
    pose.spin !== session.track[0].pose.spin || pose.tilt !== session.track[0].pose.tilt ||
    pose.sideTilt !== session.track[0].pose.sideTilt);

  // A click, or a press that never moved the stone, is not a take: a video of a still stone is not
  // what the button is for. The recorder stays armed for the real one.
  if (!moved) {
    session.track = [];
    setState({
      phase: 'armed', captured: { frames: 0, seconds: 0 },
      message: 'Nothing was recorded: hold the stone and drag it.',
    });
    return;
  }

  startFinalRender(samplePoses(session.track, settings.fps));
}

/** Writes the stone's pose now into the take, and shows how long the take is so far. */
function note(force = false) {
  const t = backend.now() - session.startedAt;

  session.track.push({ t, pose: readPose(engine.app) });

  if (force || t - session.capturedShownAt >= CAPTURE_READOUT_MS) {
    const { fps } = get(recording).settings;
    const frames = samplePoses(session.track, fps).length;

    session.capturedShownAt = t;
    setState({ captured: { frames, seconds: videoSeconds(frames, fps) } });
  }
}

// ---- the final render

/**
 * Draws every frame of the take with the Final renderer, off screen at the size set, and encodes
 * each as it is finished. One pass on the GPU at a time, and RENDER_BUDGET of the clock at most,
 * so the page and the desktop stay responsive however slow the renderer is (T-0197).
 */
function startFinalRender(poses) {
  const app = engine.app;
  const { settings, support } = get(recording);

  if (support.state !== 'ok' || !session.config) {
    setState({ phase: 'idle', message: support.reason || 'This browser cannot make MP4 video.' });
    return;
  }

  const samplesPerPass = app.get_param('luxSamples');
  const passes = passesPerFrame(settings.final, get(accumulationTarget), samplesPerPass);

  try {
    app.record_start(settings.width, settings.height, settings.final, passes);
    session.encoder = backend.createEncoder({
      width: settings.width, height: settings.height, fps: settings.fps, config: session.config,
    });
  } catch (cause) {
    fail(cause);
    return;
  }

  session.poses = poses;
  session.index = 0;
  session.frameBegun = false;
  // How a frame is drawn is fixed now, so it is asked once rather than at every pass: as many
  // draws as passes for Monte Carlo, one for the others -- and one for Monte Carlo too where the
  // renderer could not accumulate (record_start's fallback), which only it knows.
  session.drawsPerFrame = app.record_passes_total();
  session.samplesPerDraw = samplesEachPass(samplesPerPass);
  session.frameShownAt = -Infinity;
  session.task = budgetedTask({
    run: renderStep,
    budget: RENDER_BUDGET,
    minGap: 1,
    settled: () => !engine.app || engine.app.record_settled(),
  });

  setState({
    phase: 'rendering', message: '',
    captured: { frames: poses.length, seconds: videoSeconds(poses.length, settings.fps) },
  });
  publishProgress();
  session.task.request();
}

/** One turn of the final render: begins the next frame, or moves the one being drawn along. */
function renderStep() {
  if (session === null || phase() !== 'rendering') {
    return;
  }

  const app = engine.app;

  // The encoder is behind: let it catch up before drawing more.
  if (session.encoder.queueSize() > ENCODER_QUEUE_MAX) {
    session.task.request();
    return;
  }

  try {
    if (!session.frameBegun) {
      const { pose } = session.poses[session.index];

      app.record_frame(pose.spin, pose.tilt, pose.sideTilt ?? 0);
      session.frameBegun = true;
    }

    const state = app.record_advance();

    if (state === RECORD_DONE) {
      const pixels = app.record_pixels();
      const { width, height } = get(recording).settings;

      session.encoder.add(pixels, session.index);
      showFrame(pixels, width, height, session.index);
      session.index += 1;
      session.frameBegun = false;
    }

    publishProgress();

    if (session.index >= session.poses.length) {
      finishRender();
      return;
    }
  } catch (cause) {
    fail(cause);
    return;
  }

  session.task.request();
}

/**
 * The two progress bars (T-0309): the frame being drawn, and the whole video -- whole frames
 * done plus the part of the frame being drawn. Asks the renderer only how many draws of the frame
 * it has been given (a number it keeps, no GPU query), once a turn of the loop: the bars cost the
 * render nothing it did not already do.
 */
function publishProgress() {
  recordProgress.set(renderProgress({
    framesDone: session.index,
    framesTotal: session.poses.length,
    drawsDone: session.frameBegun ? engine.app.record_passes_done() : 0,
    drawsPerFrame: session.drawsPerFrame,
    samplesPerDraw: session.samplesPerDraw,
  }));
}

/** Shows the frame just finished in the panel, now and then (FRAME_PREVIEW_MS), and the last. */
function showFrame(pixels, width, height, index) {
  const now = backend.now();

  if (now - session.frameShownAt >= FRAME_PREVIEW_MS || index === session.poses.length - 1) {
    session.frameShownAt = now;
    recordFrame.set({ pixels, width, height, index });
  }
}

/** Every frame is drawn: closes the MP4 and offers it to be saved. */
async function finishRender() {
  const { settings } = get(recording);
  const frames = session.poses.length;
  const encoder = session.encoder;
  const mine = session;

  session.task.cancel();
  engine.app.record_stop();
  setState({ phase: 'encoding' });
  // The GPU is the view's again.
  releaseRenderHold();

  let blob;

  try {
    blob = await encoder.finish();
  } catch (cause) {
    // A Cancel meanwhile closes the encoder, which fails its flush: that is not a failure.
    if (session === mine && phase() === 'encoding') {
      fail(cause);
    }

    return;
  }

  // Cancelled, or closed, while the encoder finished.
  if (session !== mine || phase() !== 'encoding') {
    return;
  }

  session.encoder = null;
  session.blob = blob;
  setState({
    phase: 'done',
    result: {
      frames, seconds: videoSeconds(frames, settings.fps), width: settings.width,
      height: settings.height, fps: settings.fps, bytes: blob.size,
      filename: videoFilename(get(cutMeta).name),
    },
  });

  await saveVideo();
}

/**
 * Offers the finished video to be saved (and the panel's Save button, again): the browser's Save
 * As dialog where it has one, a download where it does not (recording.js's `saveRecording`). A
 * browser that only opens the dialog in answer to a click -- Chrome, once a long render has
 * outlived the click that started it -- leaves `save` 'needs-click', and the panel asks for one.
 *
 * `save` is 'saving' while the dialog is open and the file written (the Save button is off, so a
 * second click cannot open a second dialog), then the outcome, with `saveName` (the file's name)
 * and `saveError` (why it failed), which the panel turns into a line (recording.js's
 * `saveMessage`). Nothing thrown on the way is lost: it becomes 'failed', with its message.
 */
export async function saveVideo() {
  if (session === null || !session.blob || get(recording).save === 'saving') {
    return;
  }

  const mine = session;
  const { result } = get(recording);

  setState({ save: 'saving', saveName: result.filename, saveError: '' });

  let saved;

  try {
    saved = await saveRecording(session.blob, result.filename, {
      picker: backend.picker(),
      download: backend.download,
    });
  } catch (cause) {
    saved = { outcome: 'failed', name: result.filename, error: String(cause?.message ?? cause) };
  }

  // The mode closed, or a new take started, while the dialog was open: that panel is gone.
  if (session === mine && get(recording).save === 'saving') {
    setState({ save: saved.outcome, saveName: saved.name, saveError: saved.error });
  }
}

/** Cancel: stops the final render, keeps nothing, and leaves the mode open for another take. */
export function cancelRender() {
  if (session === null || !['rendering', 'encoding'].includes(phase())) {
    return;
  }

  stopFinalRender();
  setState({ phase: 'idle', message: 'Cancelled: nothing was saved.' });
  recordProgress.set(renderProgress());
}

/** Stops the loop, the renderer's frame and the encoder, whichever are running. */
function stopFinalRender() {
  session.task?.cancel();
  session.task = null;

  if (['rendering', 'encoding'].includes(phase())) {
    engine.app?.record_stop();
  }

  session.encoder?.close();
  session.encoder = null;
  releaseRenderHold();
}

/** Something failed: stops, and says what in the panel. */
function fail(cause) {
  if (session === null) {
    return;
  }

  stopFinalRender();
  setState({ phase: 'idle', message: `The video could not be made: ${cause?.message ?? cause}` });
  recordProgress.set(renderProgress());
  // The view may have been held.
  window.gemRequestRender?.();
}

// The render settings' own renderer picker stays on screen beside the mode, and while the mode is
// open it IS the Preview renderer -- both say what the view is drawn with -- so a renderer picked
// there becomes the Preview setting. (Not while a take is recorded or rendered, when the Preview
// setting cannot change; nor as the mode puts the user's renderer back on closing.)
renderer.subscribe(value => {
  if (session === null || ['recording', 'rendering', 'encoding'].includes(phase())) {
    return;
  }

  if (get(recording).settings.preview !== value) {
    setRecordSetting('preview', value);
  }
});

// Another design loaded under the mode (File > Open, a shared link) ends it: the take was of the
// stone that was there.
tierView.subscribe(() => {
  if (session !== null && getDesign() !== session.design) {
    exitRecording();
  }
});
