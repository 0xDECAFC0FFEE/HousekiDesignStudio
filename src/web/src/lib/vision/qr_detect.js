// QR code reading on the phone: every code in a camera frame, with its text and its four corners.
// Since T-0330 the Rust vision module (src/vision, loaded by ./vision_wasm.js) does it, with rqrr,
// a Rust port of quirc (the decoder OpenCV's QRCodeDetector used in opencv.js); the opencv.js
// version is kept as ./qr_detect_opencv.js, the reference the tests compare against.
//
// INPUT is a frame: an ImageData (RGBA), or { data, width, height } with 1 (grey) or 4 (RGBA)
// bytes per pixel.
// OUTPUT is one entry per code found: { text, corners }, `corners` its 4 corners in the order
// top-left, top-right, bottom-right, bottom-left of the code as printed, in types.js's pixel
// convention (origin at the top-left CORNER of the top-left pixel). A code that is found but
// cannot be read is left out.
//
// `processingScale` < 1 reads a downscaled copy (QR codes are usually large in the frame).
// `multi` (default true) returns every code; false returns at most one (the first found). The
// module's reader is reused across frames; dispose() frees it.

/**
 * @param {any} vision  the vision module, from vision_wasm.js loadVision()
 * @param {{ processingScale?: number, multi?: boolean }} [options]
 * @returns {{ detect(source: any): { text: string, corners: [number, number][] }[], dispose(): void }}
 */
export function createQrDetector(vision, options = {}) {
  const processingScale = options.processingScale ?? 1;
  const multi = options.multi ?? true;

  if (!(processingScale > 0 && processingScale <= 1)) {
    throw new Error(`processingScale must be in (0, 1], got ${processingScale}`);
  }

  const reader = new vision.QrReader();
  let disposed = false;

  function detect(source) {
    if (disposed) {
      throw new Error('this QR detector has been disposed');
    }

    const { data, width, height } = source ?? {};

    if (!data || !(width > 0) || !(height > 0)) {
      throw new Error('a frame must be an ImageData-like { data, width, height }');
    }

    const count = reader.read(data, width, height, processingScale);
    const xy = reader.corners();
    const found = [];

    for (let i = 0; i < count; i += 1) {
      const text = reader.text(i);

      if (text) {
        found.push({ text, corners: [0, 1, 2, 3].map((j) => [xy[8 * i + 2 * j], xy[8 * i + 2 * j + 1]]) });
      }
    }

    return multi ? found : found.slice(0, 1);
  }

  function dispose() {
    if (!disposed) {
      disposed = true;
      reader.free();
    }
  }

  return { detect, dispose };
}
