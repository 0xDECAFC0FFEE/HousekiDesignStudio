// Tools > Record rendering's video file (T-0290): each finished frame is handed to the browser's
// own H.264 encoder (WebCodecs' VideoEncoder) as it arrives, and the encoded frames are put in an
// MP4 file by mp4-muxer (MIT, Vanilagy; NOTICE). Nothing is uploaded or loaded from anywhere: the
// encoder is the browser's, and the muxer is bundled into the page.
//
// Frames are encoded as they come rather than kept, so a long video never holds every frame's
// pixels at once; only the compressed file grows in memory ('in-memory' fast start puts its index
// at the front, so a player can start it before it has read the whole file).
//
// The browser objects are passed in (`VideoEncoderImpl`, `VideoFrameImpl`, `MuxerImpl`,
// `TargetImpl`) so the tests can stand in for them; the page uses the real ones.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

/** A key frame every this many seconds, so a player can seek in a long video. */
const KEY_FRAME_SECONDS = 2;

/**
 * Starts an MP4 of `width` x `height` pixels at `fps` frames a second, encoded with `config`
 * (recording.js's `chooseEncoderConfig`). Returns:
 *
 * - `add(pixels, index)`: encodes frame `index` (0 first), RGBA with the top row first, as the
 *   renderer's `record_pixels` gives it; its time is index / fps;
 * - `queueSize()`: how many frames the encoder has not finished yet (the mode waits while it is
 *   long, so frames are never piled up faster than they are compressed);
 * - `finish()`: waits for the encoder, closes the file and resolves to it, a `video/mp4` Blob;
 * - `close()`: abandons it (Cancel).
 */
export function createMp4Encoder({
  width, height, fps, config,
  VideoEncoderImpl = globalThis.VideoEncoder,
  VideoFrameImpl = globalThis.VideoFrame,
  MuxerImpl = Muxer,
  TargetImpl = ArrayBufferTarget,
}) {
  const target = new TargetImpl();
  const muxer = new MuxerImpl({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: 'in-memory',
  });
  let failure = null;
  const encoder = new VideoEncoderImpl({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: cause => {
      failure = cause;
    },
  });

  encoder.configure(config);

  const frameMicros = 1e6 / fps;
  const keyEvery = Math.max(1, Math.round(fps * KEY_FRAME_SECONDS));
  let closed = false;

  return {
    add(pixels, index) {
      if (failure) {
        throw failure;
      }

      const frame = new VideoFrameImpl(pixels, {
        format: 'RGBA',
        codedWidth: width,
        codedHeight: height,
        timestamp: Math.round(index * frameMicros),
        duration: Math.round(frameMicros),
      });

      try {
        encoder.encode(frame, { keyFrame: index % keyEvery === 0 });
      } finally {
        frame.close();
      }
    },

    queueSize() {
      return encoder.encodeQueueSize ?? 0;
    },

    async finish() {
      await encoder.flush();

      if (failure) {
        throw failure;
      }

      muxer.finalize();
      closed = true;
      encoder.close();

      return new Blob([target.buffer], { type: 'video/mp4' });
    },

    close() {
      if (!closed) {
        closed = true;

        try {
          encoder.close();
        } catch (cause) {
          // Already closed by an error: nothing left to release.
        }
      }
    },
  };
}
