/*
 * record_encoder_test.js -- tests for Tools > Record rendering's MP4 writer (T-0290),
 * src/web/src/lib/record_encoder.js, with stand-ins for the browser's WebCodecs VideoEncoder and
 * VideoFrame and for mp4-muxer's Muxer, each recording what it is asked to do.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * That a real encoder and muxer make an MP4 that plays is checked in headless Chrome, with ffprobe
 * reading the file back (the ticket's close note and kb/record-rendering-mode.md).
 */

import { createMp4Encoder } from "../src/lib/record_encoder.js";

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

/** Stand-ins that log every call into `log`. */
function fakes(log) {
  class FakeTarget {
    buffer = new Uint8Array([1, 2, 3, 4]).buffer;
  }

  class FakeMuxer {
    constructor(options) {
      log.muxer = options;
      log.chunks = [];
    }

    addVideoChunk(chunk, meta) {
      log.chunks.push({ chunk, meta });
    }

    finalize() {
      log.finalized = true;
    }
  }

  class FakeFrame {
    constructor(pixels, init) {
      this.pixels = pixels;
      this.init = init;
      log.frames.push(this);
    }

    close() {
      this.closed = true;
    }
  }

  class FakeEncoder {
    constructor({ output, error }) {
      log.encoder = this;
      this.output = output;
      this.error = error;
      this.encodeQueueSize = 0;
    }

    configure(config) {
      log.config = config;
    }

    encode(frame, options) {
      log.encoded.push({ timestamp: frame.init.timestamp, duration: frame.init.duration, key: options.keyFrame });
      // The browser hands each encoded chunk to `output`, with the decoder config on the first.
      this.output({ timestamp: frame.init.timestamp }, log.encoded.length === 1 ? { decoderConfig: {} } : undefined);
    }

    async flush() {
      log.flushed = true;
    }

    close() {
      log.closed = (log.closed ?? 0) + 1;
    }
  }

  return { VideoEncoderImpl: FakeEncoder, VideoFrameImpl: FakeFrame, MuxerImpl: FakeMuxer, TargetImpl: FakeTarget };
}

Deno.test("frames are encoded at 1/fps apart, a key frame every 2 s, and the MP4 is closed", async () => {
  // Setup: an encoder for a 64 x 36 video at 30 fps with a configuration from chooseEncoderConfig,
  // on stand-ins for the browser's objects.
  // Test: add 65 frames of RGBA pixels, then finish.
  // Verifies: the encoder is configured as asked and the muxer made for an H.264 track of that size
  // and frame rate with its index at the front (so it plays before it is fully read); each frame is
  // RGBA of the video's size, stamped index / fps (in microseconds) and 1/fps long, and closed once
  // handed over; frames 0, 60 are key frames (every 2 s at 30 fps) and no others; every encoded
  // chunk reaches the muxer; finish flushes the encoder, finalizes the MP4, and resolves to it as a
  // video/mp4 Blob of the muxer's bytes.
  const log = { frames: [], encoded: [] };
  const config = { codec: "avc1.640028", width: 64, height: 36, bitrate: 2e6, framerate: 30, avc: { format: "avc" } };
  const encoder = createMp4Encoder({ width: 64, height: 36, fps: 30, config, ...fakes(log) });

  assertEqual(log.config, config, "configured as asked");
  assertEqual(log.muxer.video, { codec: "avc", width: 64, height: 36, frameRate: 30 }, "an H.264 track of that size");
  assertEqual(log.muxer.fastStart, "in-memory", "the index at the front");

  for (let index = 0; index < 65; index++) {
    encoder.add(new Uint8Array(64 * 36 * 4).fill(index), index);
  }

  assertEqual(log.frames[0].init.format, "RGBA", "RGBA frames");
  assertEqual([log.frames[0].init.codedWidth, log.frames[0].init.codedHeight], [64, 36], "of the video's size");
  assert(log.frames.every(frame => frame.closed), "every frame closed once encoded");
  assertEqual(log.encoded.slice(0, 3).map(each => each.timestamp), [0, 33333, 66667], "stamped index / fps");
  assert(log.encoded.every(each => each.duration === 33333), "each 1/30 s long");
  assertEqual(log.encoded.flatMap((each, index) => (each.key ? [index] : [])), [0, 60], "a key frame every 2 s");
  assertEqual(log.chunks.length, 65, "every chunk reaches the muxer");

  const blob = await encoder.finish();

  assert(log.flushed && log.finalized, "flushed and finalized");
  assertEqual(blob.type, "video/mp4", "an MP4");
  assertEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 4], "the muxer's bytes");
});

Deno.test("an encoder error stops the video, and close abandons it once", async () => {
  // Setup: an encoder on stand-ins, which then reports an error (as a browser does when its
  // hardware encoder fails).
  // Test: add a frame after the error; close twice.
  // Verifies: the next frame throws the encoder's error rather than being lost silently, and
  // closing is safe to repeat, closing the browser's encoder once.
  const log = { frames: [], encoded: [] };
  const encoder = createMp4Encoder({ width: 16, height: 16, fps: 24, config: {}, ...fakes(log) });

  log.encoder.error(new Error("the hardware encoder failed"));

  let thrown = null;

  try {
    encoder.add(new Uint8Array(16 * 16 * 4), 0);
  } catch (cause) {
    thrown = cause;
  }

  assertEqual(thrown?.message, "the hardware encoder failed", "the error surfaces");

  encoder.close();
  encoder.close();
  assertEqual(log.closed, 1, "closed once");
});
