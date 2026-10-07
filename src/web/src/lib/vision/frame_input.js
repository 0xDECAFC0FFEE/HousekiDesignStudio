// Turns a camera frame into the grey cv.Mat OpenCV's detectors read (T-0323), shared by
// board_detect.js and qr_detect.js.
//
// A frame is one of
//   - an ImageData (canvas getImageData, RGBA), or anything shaped like one: { data, width,
//     height } with 4 bytes per pixel (RGBA) or 1 (grey);
//   - a cv.Mat of type CV_8UC1 (grey, used as it is, never copied), CV_8UC4 (RGBA) or CV_8UC3
//     (RGB). The caller keeps ownership of a Mat it passes in.
//
// The staging Mats are made once and remade only when the frame size changes, so a stream of
// frames allocates nothing per frame; dispose() frees them.

/**
 * @param {any} cv  OpenCV, from loadOpenCv()
 * @returns {{ grey(source: any): any, dispose(): void }}  grey() returns a CV_8UC1 Mat owned by
 *          this object (or the caller's own grey Mat); it is overwritten by the next call
 */
export function createGreyInput(cv) {
  let staging = null;
  let grey = null;

  function convert(source, code) {
    grey ??= new cv.Mat();
    cv.cvtColor(source, grey, code);
    return grey;
  }

  return {
    grey(source) {
      if (source instanceof cv.Mat) {
        const type = source.type();

        if (type === cv.CV_8UC1) {
          return source;
        }

        if (type === cv.CV_8UC4) {
          return convert(source, cv.COLOR_RGBA2GRAY);
        }

        if (type === cv.CV_8UC3) {
          return convert(source, cv.COLOR_RGB2GRAY);
        }

        throw new Error(`unsupported Mat type ${type}; pass CV_8UC1, CV_8UC3 or CV_8UC4`);
      }

      const { data, width, height } = source ?? {};

      if (!data || !(width > 0) || !(height > 0)) {
        throw new Error('a frame must be an ImageData-like { data, width, height } or a cv.Mat');
      }

      const channels = data.length / (width * height);

      if (channels !== 1 && channels !== 4) {
        throw new Error(`image data must be RGBA or grey, got ${channels} bytes per pixel`);
      }

      const type = channels === 4 ? cv.CV_8UC4 : cv.CV_8UC1;

      if (!staging || staging.cols !== width || staging.rows !== height || staging.type() !== type) {
        staging?.delete();
        staging = new cv.Mat(height, width, type);
      }

      staging.data.set(data);
      return channels === 1 ? staging : convert(staging, cv.COLOR_RGBA2GRAY);
    },

    dispose() {
      staging?.delete();
      grey?.delete();
      staging = null;
      grey = null;
    },
  };
}
