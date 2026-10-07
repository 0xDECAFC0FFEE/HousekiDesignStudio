// QR code detection with OpenCV's QRCodeDetector (opencv.js, loaded by ./opencv.js; T-0323).
// OpenCV decodes with quirc (ISC licence), which build_opencv_js.sh switches on. Since T-0330 the
// phone reads QR codes with ./qr_detect.js (the Rust vision module); this stays as the REFERENCE
// the tests compare it against.
//
// INPUT is a frame as frame_input.js describes (ImageData, or a grey / RGBA / RGB cv.Mat).
// OUTPUT is one entry per code found: { text, corners }, `corners` its 4 corners in OpenCV's order
// (top-left, top-right, bottom-right, bottom-left of the code as printed), in types.js's pixel
// convention (origin at the top-left CORNER of the top-left pixel, so OpenCV's points + 0.5). A
// code that is found but cannot be read is left out.
//
// `processingScale` < 1 reads a downscaled copy (QR codes are usually large in the frame). The
// detector, staging Mats and outputs are reused; dispose() frees them.

import { createGreyInput } from './frame_input.js';

/**
 * @param {any} cv  OpenCV, from loadOpenCv()
 * @param {{ processingScale?: number, multi?: boolean }} [options]  `multi` (default true): look
 *        for several codes in a frame (detectAndDecodeMulti); false reads at most one, faster
 * @returns {{ detect(source: any): { text: string, corners: [number, number][] }[], dispose(): void }}
 */
export function createQrDetector(cv, options = {}) {
  const processingScale = options.processingScale ?? 1;
  const multi = options.multi ?? true;

  if (!(processingScale > 0 && processingScale <= 1)) {
    throw new Error(`processingScale must be in (0, 1], got ${processingScale}`);
  }

  const detector = new cv.QRCodeDetector();
  const input = createGreyInput(cv);
  let small = null;
  let disposed = false;

  function detect(source) {
    if (disposed) {
      throw new Error('this QR detector has been disposed');
    }

    const full = input.grey(source);
    let work = full;

    if (processingScale < 1) {
      small ??= new cv.Mat();
      const w = Math.max(1, Math.round(full.cols * processingScale));
      const h = Math.max(1, Math.round(full.rows * processingScale));
      cv.resize(full, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
      work = small;
    }

    const sx = full.cols / work.cols;
    const sy = full.rows / work.rows;
    const points = new cv.Mat();
    const found = [];

    try {
      let texts;

      if (multi) {
        const decoded = new cv.StringVector();

        try {
          detector.detectAndDecodeMulti(work, decoded, points);
          texts = Array.from({ length: decoded.size() }, (_, i) => decoded.get(i));
        } finally {
          decoded.delete();
        }
      } else {
        const text = detector.detectAndDecode(work, points);
        texts = points.empty() ? [] : [text];
      }

      // `points`: 4 corners per code, as CV_32FC2 (one row per code, or 4 rows for one code).
      const xy = points.empty() ? new Float32Array(0) : points.data32F;

      texts.forEach((text, i) => {
        if (text && xy.length >= 8 * (i + 1)) {
          const corners = [0, 1, 2, 3].map((j) => [(xy[8 * i + 2 * j] + 0.5) * sx, (xy[8 * i + 2 * j + 1] + 0.5) * sy]);
          found.push({ text, corners });
        }
      });
    } finally {
      points.delete();
    }

    return found;
  }

  function dispose() {
    if (disposed) {
      return;
    }

    disposed = true;
    detector.delete();
    small?.delete();
    input.dispose();
  }

  return { detect, dispose };
}
