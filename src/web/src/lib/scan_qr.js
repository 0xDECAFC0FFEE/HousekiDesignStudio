// The QR code Tools > Rough scan shows for the phone to scan (T-0314): the session's link, drawn
// as an SVG path the page can scale to any size without blurring.
//
// The encoding is uqr's (MIT; a port of Project Nayuki's QR Code generator), not hand-written. What
// this file adds is what a phone needs to read the code reliably off a screen:
//
//   - a QUIET ZONE of four modules round the code, the width the QR standard asks for. The scanner
//     finds the code by its three corner squares, and a busy page right up against them (a dark
//     pane, the renderer's edge) can hide them;
//   - error correction at level M, which survives about 15% of the code being misread (glare on
//     the screen, a moiré between the screen's pixels and the phone's camera) while keeping the
//     modules large: a link of a hundred characters stays a version 5 or 6 code, 37 to 41
//     modules across;
//   - dark modules on white, always, whatever the page's theme (ScanView.svelte draws the white).
//     Phones expect dark on light, and some never read a light-on-dark code.

import { encode } from 'uqr';

/** The quiet zone round the code, in modules: the width the QR standard asks for. */
export const QR_QUIET_ZONE = 4;

/** The error correction level: M recovers about 15% of the code. */
export const QR_ECC = 'M';

/**
 * Encodes `text` as a QR code. Returns `{ size, path, modules }`:
 *
 *   size     the code's width and height in modules, the quiet zone included (the SVG's viewBox
 *            is `0 0 size size`);
 *   path     an SVG path covering the dark modules, one rectangle per run of dark modules in a
 *            row (a module is 1 x 1 in the viewBox);
 *   modules  the code itself, `modules[y][x]` true where the module is dark, quiet zone included.
 */
export function qrCode(text) {
  const { size, data } = encode(String(text), { ecc: QR_ECC, border: QR_QUIET_ZONE });
  const runs = [];

  for (let y = 0; y < size; y++) {
    let x = 0;

    while (x < size) {
      if (!data[y][x]) {
        x += 1;
        continue;
      }

      const start = x;

      while (x < size && data[y][x]) {
        x += 1;
      }

      runs.push(`M${start} ${y}h${x - start}v1h${start - x}z`);
    }
  }

  return { size, path: runs.join(''), modules: data };
}
