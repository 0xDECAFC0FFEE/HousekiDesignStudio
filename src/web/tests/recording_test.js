/*
 * recording_test.js -- tests for Tools > Record rendering's pure logic (T-0290),
 * src/web/src/lib/recording.js: which poses of a recorded drag become the video's frames, the
 * sizes and frame rates a video may have, how many Monte Carlo passes a frame takes, which H.264
 * configuration is asked for, and how the finished video is saved when the browser's Save As
 * dialog is there, refuses, is cancelled or is missing, or the file cannot be written (T-0297),
 * and what the panel says about each.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * Nothing here needs a page, a GPU or an encoder; record_mode_test.js drives the mode itself.
 */

import {
  samplePoses, videoSeconds, clampFps, fitSize, passesPerFrame, bitrateFor, codecCandidates,
  chooseEncoderConfig, saveRecording, saveMessage, videoFilename, RENDERER_DETERMINISTIC,
  RENDERER_MONTE_CARLO, RENDERER_FLAT, SIZE_MAX, SIZE_MIN, PIXELS_MAX,
} from "../src/lib/recording.js";

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

/** A pose whose spin names it, so a test can tell which one a frame took. */
const pose = spin => ({ spin, tilt: spin / 2, sideTilt: -spin });

Deno.test("a take becomes one frame every 1/fps seconds, holding the latest pose", () => {
  // Setup: a 120 ms take -- the press (pose 0 at 0 ms), the stone moving at 10 ms (pose 1) and
  // 50 ms (pose 2), and the release at 120 ms (pose 3) -- recorded at 30 frames a second.
  // Test: samplePoses.
  // Verifies the timing: frames at 0, 33.3, 66.7 and 100 ms, and a last one held to the release
  // (120 ms), so the video lasts as long as the drag did; the count: 5, the first frame at or past
  // the release included; and the poses: each frame shows the latest pose at or before its time
  // (the stone only moves when the pointer does) -- pose 1 at 33 ms, pose 2 at 67 and 100 ms --
  // with the first frame the pose at the press and the last the pose at the release.
  const track = [
    { t: 0, pose: pose(0) }, { t: 10, pose: pose(1) }, { t: 50, pose: pose(2) }, { t: 120, pose: pose(3) },
  ];

  const frames = samplePoses(track, 30);

  assertEqual(frames.length, 5, "five frames");
  assertEqual(frames.map(frame => frame.index), [0, 1, 2, 3, 4], "numbered in order");
  assertEqual(frames.map(frame => Math.round(frame.time * 10) / 10), [0, 33.3, 66.7, 100, 120], "every 1/30 s, the last at the release");
  assertEqual(frames.map(frame => frame.pose.spin), [0, 1, 2, 2, 3], "the latest pose at each frame's time");
  assertEqual(frames[0].pose, pose(0), "the first frame is the press");
  assertEqual(frames[frames.length - 1].pose, pose(3), "the last frame is the release");
});

Deno.test("a whole second at 60 fps is 61 frames ending exactly at the release", () => {
  // Setup: a take of exactly one second with a pose every 5 ms (as fast as a mouse reports), each
  // pose's spin its own time in ms.
  // Test: samplePoses at 60 frames a second, and videoSeconds of the result.
  // Verifies: 61 frames (0 to 1000 ms inclusive, every 16.7 ms), each frame's pose the one written
  // at or just before its time -- so the frame times are real-time, not one per pose written --
  // and the video plays for as long as the frames say (61 / 60 s).
  const track = [];

  for (let t = 0; t <= 1000; t += 5) {
    track.push({ t, pose: pose(t) });
  }

  const frames = samplePoses(track, 60);

  assertEqual(frames.length, 61, "61 frames");
  assertEqual(frames[60].time, 1000, "the last at the release");

  for (const frame of frames) {
    assertEqual(frame.pose.spin, Math.floor(frame.time / 5 + 1e-9) * 5, `frame ${frame.index}'s pose`);
  }

  assert(Math.abs(videoSeconds(frames.length, 60) - 61 / 60) < 1e-12, "61 / 60 seconds long");
});

Deno.test("a take shorter than one frame is still the press and the release", () => {
  // Setup: a 10 ms take at 24 frames a second (a frame is 41.7 ms); and an empty take.
  // Test: samplePoses.
  // Verifies: two frames, the press's pose then the release's, so even the quickest flick shows
  // where it started and ended; nothing recorded is no frames.
  const frames = samplePoses([{ t: 0, pose: pose(0) }, { t: 10, pose: pose(9) }], 24);

  assertEqual(frames.map(frame => [frame.time, frame.pose.spin]), [[0, 0], [10, 9]], "press and release");
  assertEqual(samplePoses([], 30), [], "no take, no frames");
});

Deno.test("frame rates and sizes are held to what an MP4 can take", () => {
  // Setup: frame rates and sizes in range, out of range, odd, fractional and nonsense.
  // Test: clampFps and fitSize.
  // Verifies: a frame rate is a whole number from 1 to 60 (30 for nonsense); a size is whole and
  // even on both sides (H.264's colour needs it), within 16 to 3840, and a picture bigger than 4K
  // UHD shrinks to fit keeping its aspect.
  assertEqual([clampFps(30), clampFps(0), clampFps(240), clampFps(29.6), clampFps("x")], [30, 1, 60, 30, 30], "frame rates");
  assertEqual(fitSize(1920, 1080), { width: 1920, height: 1080 }, "1080p as it is");
  assertEqual(fitSize(1921, 1081), { width: 1920, height: 1080 }, "odd rounds down to even");
  assertEqual(fitSize(4, 99999), { width: SIZE_MIN, height: SIZE_MAX }, "held to 16 .. 3840");

  const big = fitSize(3840, 3840);

  assert(big.width * big.height <= PIXELS_MAX, "no more than 4K UHD's pixels");
  assertEqual(big.width, big.height, "still square");
  assert(big.width % 2 === 0, "still even");
});

Deno.test("a Monte Carlo frame takes the view's own samples to accumulate", () => {
  // Setup: the render settings' "Samples to accumulate" and "Samples per frame" at a few values.
  // Test: passesPerFrame for each renderer.
  // Verifies: a Monte Carlo frame takes as many passes as the live view does to converge --
  // target over samples a pass, rounded up, never below one -- and every other renderer one pass.
  assertEqual(passesPerFrame(RENDERER_MONTE_CARLO, 512, 1), 512, "512 passes of 1");
  assertEqual(passesPerFrame(RENDERER_MONTE_CARLO, 512, 3), 171, "rounded up");
  assertEqual(passesPerFrame(RENDERER_MONTE_CARLO, 0, 0), 1, "never below one");
  assertEqual(passesPerFrame(RENDERER_DETERMINISTIC, 512, 1), 1, "deterministic: one");
  assertEqual(passesPerFrame(RENDERER_FLAT, 512, 1), 1, "flat: one");
});

Deno.test("the encoder is asked for the best H.264 profile at the level the size needs", async () => {
  // Setup: 720p30, 1080p30 and 4K30; a stand-in for WebCodecs' isConfigSupported that supports
  // only the Main profile; one that supports nothing; one that throws on an unknown codec.
  // Test: codecCandidates, bitrateFor and chooseEncoderConfig.
  // Verifies: High, Main then Constrained Baseline are tried in that order, at level 3.1 for 720p,
  // 4.0 for 1080p and 5.1 for 4K; the first configuration the browser accepts is the one used,
  // with the size, frame rate, bit rate and the MP4 (length-prefixed) sample format; a browser
  // with no H.264 encoder, or no WebCodecs at all, gets null -- which the panel reports.
  assertEqual(codecCandidates(1280, 720, 30), ["avc1.64001f", "avc1.4d001f", "avc1.42e01f"], "720p: 3.1");
  assertEqual(codecCandidates(1920, 1080, 30)[0], "avc1.640028", "1080p: 4.0");
  assertEqual(codecCandidates(3840, 2160, 30)[0], "avc1.640033", "4K: 5.1");

  const asked = [];
  const mainOnly = config => {
    asked.push(config.codec);
    return Promise.resolve({ supported: config.codec.startsWith("avc1.4d") });
  };
  const config = await chooseEncoderConfig(1920, 1080, 30, mainOnly);

  assertEqual(asked, ["avc1.640028", "avc1.4d0028"], "High first, then Main");
  assertEqual(config, {
    codec: "avc1.4d0028", width: 1920, height: 1080, bitrate: bitrateFor(1920, 1080, 30), framerate: 30,
    avc: { format: "avc" },
  }, "the Main configuration");
  assertEqual(await chooseEncoderConfig(1920, 1080, 30, () => Promise.resolve({ supported: false })), null, "none supported");
  assertEqual(await chooseEncoderConfig(1920, 1080, 30, () => { throw new TypeError("bad codec"); }), null, "all throw");
  assertEqual(await chooseEncoderConfig(1920, 1080, 30, undefined), null, "no WebCodecs");
});

/**
 * A stand-in Save As dialog. It records the options it was opened with into `written`, then
 * either throws `failure` (the dialog refused, or was cancelled), or returns a file handle named
 * `name` whose writable stream keeps what it is given in `written` -- and throws `writeFailure`
 * from the step named by `failAt` ('createWritable', 'write' or 'close'), as a browser does when
 * the file cannot be written where the user chose.
 */
function fakePicker(written, { failure = null, name = "chosen.mp4", writeFailure = null, failAt = null } = {}) {
  return async options => {
    written.options = options;

    if (failure) {
      throw failure;
    }

    return {
      name,
      createWritable: async () => {
        if (failAt === "createWritable") {
          throw writeFailure;
        }

        return {
          write: async blob => {
            if (failAt === "write") {
              throw writeFailure;
            }

            written.blob = blob;
          },
          close: async () => {
            if (failAt === "close") {
              throw writeFailure;
            }

            written.closed = true;
          },
          abort: async () => { written.aborted = true; },
        };
      },
    };
  };
}

/** A DOMException-like error: what the browser throws, told apart by its `name`. */
function named(name, message = name) {
  const error = new Error(message);

  error.name = name;
  return error;
}

Deno.test("saving: the Save As dialog, a cancel, a refusal without a click, and the download fallback", async () => {
  // Setup: one finished video (a Blob), and four browsers -- one whose Save As dialog works (the
  // user names the file "my take.mp4"), one whose dialog the user cancels, one that refuses to
  // open it without a click (Chrome after a long render: SecurityError), and one with no dialog
  // at all (Firefox, Safari) -- with a download stand-in that records what it was given.
  // Test: saveRecording on each.
  // Verifies: the dialog is offered with the file name, the MP4 type, and a starting folder
  // (Downloads) and a remembered-folder id, and the video written and closed; the outcome is
  // 'saved' with the name the user gave the file, so the panel can say what was saved; a cancel
  // saves nothing and downloads nothing ('cancelled'); a refusal saves nothing behind the user's
  // back and asks for the panel's Save button ('needs-click'); with no dialog the video is handed
  // to the browser as a download under the design's name ('downloaded'); and a dialog that cannot
  // open for another reason (the user has chosen nothing yet) still downloads rather than losing
  // the video.
  const video = new Blob([new Uint8Array([0, 0, 0, 24])], { type: "video/mp4" });
  const downloads = [];
  const download = (...args) => downloads.push(args);

  const written = {};

  assertEqual(await saveRecording(video, "stone recording.mp4", { picker: fakePicker(written, { name: "my take.mp4" }), download }),
    { outcome: "saved", name: "my take.mp4", error: "" }, "saved, under the name the user gave it");
  assertEqual(written.options.suggestedName, "stone recording.mp4", "the dialog is given the name");
  assertEqual(written.options.types[0].accept, { "video/mp4": [".mp4"] }, "as an MP4");
  assertEqual([written.options.startIn, written.options.id], ["downloads", "houseki-recording"], "starting in Downloads, remembering the folder");
  assert(written.blob === video && written.closed, "the video is written and the file closed");

  assertEqual((await saveRecording(video, "a.mp4", { picker: fakePicker({}, { failure: named("AbortError") }), download })).outcome, "cancelled", "cancelled");
  assertEqual((await saveRecording(video, "a.mp4", { picker: fakePicker({}, { failure: named("SecurityError") }), download })).outcome, "needs-click", "needs a click");
  assertEqual(downloads.length, 0, "nothing downloaded behind the user's back");

  assertEqual(await saveRecording(video, "b.mp4", { picker: null, download }), { outcome: "downloaded", name: "b.mp4", error: "" }, "no dialog: downloaded");
  assertEqual(downloads[0], ["b.mp4", video, "video/mp4"], "downloaded under its name");

  assertEqual((await saveRecording(video, "c.mp4", { picker: fakePicker({}, { failure: named("TypeError") }), download })).outcome, "downloaded", "a dialog that cannot open downloads");
});

Deno.test("saving: a write that fails after the user chose a place is a failure, never a cancel or a click", async () => {
  // The cause of T-0297's silent saves. The dialog and the write are two steps, and the old code
  // caught both in one `try`, filing the WRITE's errors by the DIALOG's rules: a SecurityError or
  // NotAllowedError from the write came back 'needs-click' (the panel asked the user to click
  // Save video again, as if the dialog had never opened), an AbortError from the write came back
  // 'cancelled' (the panel said nothing), and anything else was quietly downloaded somewhere the
  // user had not chosen -- each time with an empty file left where they had.
  // Setup: a dialog that opens and returns a handle every time, whose file then fails at one of
  // the three write steps (making the writable, writing, closing) with each of those errors; a
  // download stand-in.
  // Test: saveRecording for each step and error.
  // Verifies: every one is 'failed', with the browser's message as the reason and the file's name;
  // nothing is downloaded instead; and a writable that was made is aborted, so the browser drops
  // its half-written copy. (Each assertion fails on the old code, which returned 'needs-click',
  // 'cancelled' or 'downloaded' here.)
  const video = new Blob([new Uint8Array([0, 0, 0, 24])], { type: "video/mp4" });
  const downloads = [];
  const download = (...args) => downloads.push(args);

  for (const failAt of ["createWritable", "write", "close"]) {
    for (const errorName of ["SecurityError", "NotAllowedError", "AbortError", "InvalidStateError"]) {
      const written = {};
      const writeFailure = named(errorName, `${errorName} at ${failAt}`);
      const saved = await saveRecording(video, "x.mp4", {
        picker: fakePicker(written, { name: "x.mp4", writeFailure, failAt }), download,
      });

      assertEqual(saved, { outcome: "failed", name: "x.mp4", error: `${errorName} at ${failAt}` }, `${errorName} at ${failAt}`);
      assert(!written.closed, `${errorName} at ${failAt}: not reported closed`);

      if (failAt !== "createWritable") {
        assert(written.aborted, `${errorName} at ${failAt}: the half-written file is aborted`);
      }
    }
  }

  assertEqual(downloads.length, 0, "no download in place of the place the user chose");
});

Deno.test("saving: a download that cannot start is a failure, not a download", async () => {
  // Setup: a browser with no Save As dialog, whose download throws (a page that cannot make a
  // blob URL, say).
  // Test: saveRecording.
  // Verifies: 'failed' with the reason, rather than 'downloaded' for a download that never began
  // (the old code let the error escape, and the panel kept whatever it said before).
  const video = new Blob([new Uint8Array([1])], { type: "video/mp4" });
  const saved = await saveRecording(video, "d.mp4", {
    picker: null,
    download: () => { throw new Error("no blob URLs here"); },
  });

  assertEqual(saved, { outcome: "failed", name: "d.mp4", error: "no blob URLs here" }, "failed, saying why");
});

Deno.test("every save outcome has a line for the panel, and none of the others reads as saved", () => {
  // Setup: each outcome saveRecording gives, plus 'saving' (the dialog open) and none yet.
  // Test: saveMessage.
  // Verifies: a save names the file and where it went (the folder chosen in the dialog, or the
  // browser's downloads); a cancel says it was not saved and how to try again; a failure says it
  // was not saved, why, and how to try again; the needs-click line asks for the Save button;
  // before any save there is no line; and no line but a save's or a download's says "Saved" or
  // "Downloaded" -- a cancelled or failed save can never look like it worked. (The old panel
  // showed nothing at all after a cancel, and "Saved." with no name after a save.)
  assertEqual(saveMessage("saved", "hex recording.mp4", ""), "Saved as “hex recording.mp4” in the folder you chose.", "saved");
  assert(/hex recording\.mp4/.test(saveMessage("downloaded", "hex recording.mp4", "")) && /downloads/.test(saveMessage("downloaded", "hex recording.mp4", "")), "downloaded: the name and where");
  assert(/^Not saved/.test(saveMessage("cancelled", "x.mp4", "")) && /Save video/.test(saveMessage("cancelled", "x.mp4", "")), "cancelled: not saved, and how to try again");
  assertEqual(saveMessage("failed", "x.mp4", "the disk is full"), "The video was not saved: the disk is full. Click Save video to try again.", "failed: why");
  assertEqual(saveMessage("failed", "x.mp4", "Not allowed in this context."), "The video was not saved: Not allowed in this context. Click Save video to try again.",
    "a browser's own full stop is not doubled");
  assert(/Click Save video/.test(saveMessage("needs-click", "x.mp4", "")), "needs a click: the button");
  assert(/Save dialog/.test(saveMessage("saving", "x.mp4", "")), "saving: the dialog");
  assertEqual(saveMessage(null, "", ""), "", "nothing before a save");

  for (const outcome of ["cancelled", "failed", "needs-click", "saving"]) {
    assert(!/^(Saved|Downloaded)/.test(saveMessage(outcome, "x.mp4", "e")), `${outcome} does not read as saved`);
  }
});

Deno.test("the file is named after the design", () => {
  // Setup: design names with characters no filesystem takes, and an empty one.
  // Test: videoFilename.
  // Verifies: the video is saved as "<name> recording.mp4" with unsafe characters replaced, and
  // as "stone recording.mp4" when the design has no name.
  assertEqual(videoFilename("Hex Cut V2"), "Hex Cut V2 recording.mp4", "the design's name");
  assertEqual(videoFilename('a/b:c*"d'), "a-b-c-d recording.mp4", "unsafe characters replaced");
  assertEqual(videoFilename("  "), "stone recording.mp4", "no name");
});
