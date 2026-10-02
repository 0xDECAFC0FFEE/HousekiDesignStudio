// Tools > Record rendering (T-0290): the parts of the mode that need no page, no GPU and no
// encoder -- which poses become frames, how big the video may be, how many Monte Carlo passes a
// frame takes, which H.264 profile to ask the browser for, and how the finished video is saved.
// record_mode.js drives them; tests/recording_test.js checks each on its own.
//
// The user, 2026-09-29: "on the left is the recording settings. it should allow users to set the
// fps and resolution. it should also show a loading bar once the user sets the path of the rock
// and a red record button. once the user clicks record and the user then clicks on the rock, the
// app should start recording the x, y and z rotations, rendering the rock with the preview
// tracing. Once the user releases, the app should start replaying those rotations but each frame
// is rendered with the tracer set. Once all rendering is complete, the app should show the user a
// save dialog to save the video as an mp4".

/** The renderers, as `params::Renderer::as_u32` numbers them. */
export const RENDERER_DETERMINISTIC = 0;
export const RENDERER_MONTE_CARLO = 1;
export const RENDERER_FLAT = 2;

/** Frames a second: any whole number from 1 to 60; 30 by default. */
export const FPS_MIN = 1;
export const FPS_MAX = 60;
export const DEFAULT_FPS = 30;

/**
 * The video's size, in pixels. 16 to 3840 a side: H.264 wants whole 16-pixel macroblocks at the
 * least, and 3840 x 2160 (4K UHD) is the largest picture the H.264 levels this asks for cover.
 * The renderer itself would draw up to 4096 a side (recording.rs's RECORD_MAX_SIDE).
 */
export const SIZE_MIN = 16;
export const SIZE_MAX = 3840;
/** The most pixels a frame may have: 4K UHD's. */
export const PIXELS_MAX = 3840 * 2160;
export const DEFAULT_SIZE = { width: 1280, height: 720 };

/** The sizes the panel offers with one click. */
export const SIZE_PRESETS = [
  { label: '720p', width: 1280, height: 720 },
  { label: '1080p', width: 1920, height: 1080 },
  { label: 'Square', width: 1080, height: 1080 },
  { label: '4K', width: 3840, height: 2160 },
];

/** How much of a frame's time the final render may keep the GPU busy: the rest is left idle for
 * the page and the desktop (T-0197: the Monte Carlo renderer must never take the machine down). */
export const RENDER_BUDGET = 0.85;

/**
 * The frames of a recorded drag, one every 1/fps seconds of the time the drag took.
 *
 * `track` is what the mode wrote down while the stone was held: `[{ t, pose }]`, `t` in
 * milliseconds from the press, in the order it happened, starting with the pose at the press
 * (t = 0) and ending with the pose at the release. Between two entries the stone stood still at
 * the earlier one's pose -- it only ever moves when the pointer does -- so a frame shows the
 * latest pose at or before its time ("sample and hold"), exactly what was on screen then, and a
 * pause in the drag is a pause in the video.
 *
 * Frame k is at k / fps seconds, for k = 0 up to the first frame at or past the release, whose
 * time is held to the release: so the first frame is the pose at the press, the last is the pose
 * at the release, and the video lasts as long as the drag did, to within one frame. A drag
 * shorter than one frame gives two frames (the press and the release).
 *
 * Returns `[{ index, time, pose }]`, `time` in milliseconds.
 */
export function samplePoses(track, fps) {
  if (track.length === 0) {
    return [];
  }

  const rate = clampFps(fps);
  const end = track[track.length - 1].t;
  const count = Math.max(2, Math.ceil((end * rate) / 1000 - 1e-9) + 1);
  const frames = [];
  let at = 0;

  for (let index = 0; index < count; index += 1) {
    const time = Math.min((index * 1000) / rate, end);

    while (at + 1 < track.length && track[at + 1].t <= time) {
      at += 1;
    }

    frames.push({ index, time, pose: { ...track[at].pose } });
  }

  return frames;
}

/** How long a video of `frames` frames at `fps` plays, in seconds. */
export function videoSeconds(frames, fps) {
  return frames / clampFps(fps);
}

/** A frames-a-second setting as the mode uses it: a whole number from FPS_MIN to FPS_MAX. */
export function clampFps(fps) {
  const value = Math.round(Number(fps));

  return Number.isFinite(value) ? Math.min(FPS_MAX, Math.max(FPS_MIN, value)) : DEFAULT_FPS;
}

/**
 * A width and height as the video can take them: each a whole, even number (H.264's 4:2:0
 * colour needs both even) from SIZE_MIN to SIZE_MAX, and the two together no more than
 * PIXELS_MAX, keeping the aspect the user asked for when a picture too big has to shrink.
 */
export function fitSize(width, height) {
  let w = Number.isFinite(Number(width)) ? Number(width) : DEFAULT_SIZE.width;
  let h = Number.isFinite(Number(height)) ? Number(height) : DEFAULT_SIZE.height;

  w = Math.min(SIZE_MAX, Math.max(SIZE_MIN, w));
  h = Math.min(SIZE_MAX, Math.max(SIZE_MIN, h));

  if (w * h > PIXELS_MAX) {
    const shrink = Math.sqrt(PIXELS_MAX / (w * h));

    w *= shrink;
    h *= shrink;
  }

  const even = value => Math.max(SIZE_MIN, 2 * Math.floor(value / 2));

  return { width: even(w), height: even(h) };
}

/**
 * How many passes a Monte Carlo frame takes: the render settings' "Samples to accumulate" (the
 * live view's own stopping rule), over their "Samples per frame", rounded up -- so a frame of
 * the video has as many samples per pixel as the view has once it has converged. Other
 * renderers draw a frame in one pass.
 */
export function passesPerFrame(renderer, samplesToAccumulate, samplesPerPass) {
  if (renderer !== RENDERER_MONTE_CARLO) {
    return 1;
  }

  const target = Math.max(1, Math.round(samplesToAccumulate) || 1);
  const each = Math.max(1, Math.round(samplesPerPass) || 1);

  return Math.ceil(target / each);
}

/**
 * The bit rate to ask the encoder for: 0.15 bits a pixel a frame, which keeps a stone's fine
 * facet edges and fire clean in H.264, held between 2 and 60 megabits a second: 4.1 Mbit/s at
 * 720p30, 9.3 at 1080p30, 37 at 4K30. A still stone costs the encoder nothing, so a generous rate
 * costs little in file size.
 */
export function bitrateFor(width, height, fps) {
  const bits = width * height * clampFps(fps) * 0.15;

  return Math.round(Math.min(60e6, Math.max(2e6, bits)));
}

/**
 * The H.264 codec strings to try, best first: High, Main, then Constrained Baseline, each at the
 * lowest level that holds a picture this size (level 3.1 to 720p, 4.0 to 1080p, 5.1 to 4K, 5.2
 * above that at 60 frames a second).
 */
export function codecCandidates(width, height, fps) {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = macroblocks * clampFps(fps);
  // [level_idc hex, max frame macroblocks, max macroblocks a second] from the H.264 levels table.
  const levels = [
    ['1f', 3600, 108000],
    ['28', 8192, 245760],
    ['2a', 8704, 522240],
    ['32', 22080, 589824],
    ['33', 36864, 983040],
    ['34', 36864, 2073600],
  ];
  const level = (levels.find(([, frame, second]) => macroblocks <= frame && rate <= second) ?? levels[levels.length - 1])[0];

  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.42e0${level}`];
}

/**
 * The first encoder configuration the browser says it can use for this video, or null when it
 * has no H.264 encoder at all (or no WebCodecs). `isConfigSupported` is WebCodecs'
 * `VideoEncoder.isConfigSupported`, passed in so a test can stand in for the browser.
 */
export async function chooseEncoderConfig(width, height, fps, isConfigSupported) {
  if (typeof isConfigSupported !== 'function') {
    return null;
  }

  for (const codec of codecCandidates(width, height, fps)) {
    const config = {
      codec,
      width,
      height,
      bitrate: bitrateFor(width, height, fps),
      framerate: clampFps(fps),
      // Length-prefixed samples with the parameter sets in the decoder description: what an MP4
      // holds (mp4-muxer reads the description from the encoder's metadata).
      avc: { format: 'avc' },
    };

    try {
      const answer = await isConfigSupported(config);

      if (answer?.supported) {
        return config;
      }
    } catch (cause) {
      // A codec string the browser cannot parse is only "not this one".
    }
  }

  return null;
}

/**
 * What the Save As dialog is asked for: the file name, the MP4 type, and where it opens. `startIn`
 * 'downloads' opens it in the Downloads folder, where people look for what a browser saved,
 * rather than in whatever folder the system last used (T-0297: the user's first save went to a
 * folder they did not expect). `id` lets the browser remember the folder chosen last time for
 * recordings, where it keeps such things (it does for a web site; for a page opened from a file it
 * may start in Downloads each time).
 */
export function savePickerOptions(filename) {
  return {
    suggestedName: filename,
    startIn: 'downloads',
    id: 'houseki-recording',
    types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
  };
}

/**
 * Saves the finished video, and says how it went, as `{ outcome, name, error }`:
 *
 * - 'saved': the browser's Save As dialog (the File System Access API's `showSaveFilePicker`)
 *   was shown and the whole video written, and the file closed, where the user chose; `name` is
 *   the file name they gave it;
 * - 'cancelled': the user closed that dialog without saving;
 * - 'needs-click': the dialog exists but the browser refused to open it -- it only opens in
 *   answer to a click or a key, and a long render has long outlived the click that started it --
 *   so the panel's Save button must be pressed to open it (nothing is saved behind the user's
 *   back);
 * - 'downloaded': the browser has no such dialog (Firefox, Safari), or the dialog itself failed
 *   to open for another reason, so the video was handed to the browser as a download under `name`;
 * - 'failed': the video could not be written -- the user chose a place in the dialog but the
 *   browser could not write the file there, or the download could not be started. `error` says
 *   why. Nothing falls back silently after the dialog: the user chose where the file goes, and a
 *   download somewhere else would leave them looking in the wrong place.
 *
 * The dialog and the write are two steps, and their errors mean different things (T-0297): a
 * SecurityError or NotAllowedError from the DIALOG means "no click to answer", but from the WRITE
 * it means the write was refused, and an AbortError from the dialog is a Cancel but from the
 * write is a failure (the browser aborted it). Filing a write's error as the dialog's told the
 * user to click Save again, or that they had cancelled, while an empty file sat where they chose.
 *
 * `picker` and `download` are injected for the tests; the page passes `window.showSaveFilePicker`
 * and export_file.js's `downloadFile`.
 */
export async function saveRecording(blob, filename, { picker, download }) {
  if (typeof picker === 'function') {
    let handle;

    try {
      handle = await picker(savePickerOptions(filename));
    } catch (cause) {
      if (cause?.name === 'AbortError') {
        return { outcome: 'cancelled', name: filename, error: '' };
      }

      // No click to answer: Chrome refuses the picker with a SecurityError (older builds a
      // NotAllowedError). The Save button opens it.
      if (cause?.name === 'SecurityError' || cause?.name === 'NotAllowedError') {
        return { outcome: 'needs-click', name: filename, error: '' };
      }

      // The dialog could not be shown at all (an option this browser does not take, say): the
      // user has chosen nothing yet, so a download is the way to still get the video to them.
      handle = null;
    }

    if (handle) {
      const name = handle.name || filename;
      let writable = null;

      try {
        writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (cause) {
        // Leave nothing half written behind: abort drops the browser's temporary copy.
        try {
          await writable?.abort?.();
        } catch (ignored) {
          // Already closed or aborted.
        }

        return { outcome: 'failed', name, error: describeError(cause) };
      }

      return { outcome: 'saved', name, error: '' };
    }
  }

  try {
    download(filename, blob, 'video/mp4');
  } catch (cause) {
    return { outcome: 'failed', name: filename, error: describeError(cause) };
  }

  return { outcome: 'downloaded', name: filename, error: '' };
}

/** An error as one line for the panel: its message, else its name, else what it is. */
function describeError(cause) {
  return String(cause?.message || cause?.name || cause || 'unknown error');
}

/**
 * The panel's line about the last save (`save`, `name` and `error` as saveRecording gave them,
 * plus 'saving' while the dialog is open or the file is being written), or '' before any. Every
 * outcome says something, so a cancel or a failure never looks like a save.
 */
export function saveMessage(save, name, error) {
  switch (save) {
    case 'saving':
      return 'Saving… choose where the video goes in the Save dialog.';
    case 'saved':
      return `Saved as “${name}” in the folder you chose.`;
    case 'downloaded':
      return `Downloaded as “${name}”: it is in your browser's downloads.`;
    case 'cancelled':
      return 'Not saved: the Save dialog was closed without saving. Click Save video to try again.';
    case 'needs-click':
      return 'The video is ready. Click Save video to choose where it goes.';
    case 'failed':
      // A browser's message usually ends in its own full stop.
      return `The video was not saved: ${String(error).replace(/[.\s]+$/, '')}. Click Save video to try again.`;
    default:
      return '';
  }
}

/** The file name a video is saved under: the design's name, with the characters no common
 * filesystem accepts replaced, then " recording.mp4". */
export function videoFilename(name) {
  const base = (name || '').trim().replace(/[\\/:*?"<>|]+/g, '-') || 'stone';

  return `${base} recording.mp4`;
}

/** Seconds as the panel shows them: one decimal. */
export function formatSeconds(seconds) {
  return `${seconds.toFixed(1)} s`;
}
