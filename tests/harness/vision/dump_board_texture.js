// Writes a board texture (board_texture.js) as raw grey bytes, for the harness test that compares
// it with the printed PNG (tests/harness/test_vision_outline.py). Test-only.
//
//   deno run --allow-read --allow-write tests/harness/vision/dump_board_texture.js <spec name> <ppm> <out.raw>
//
// Prints "<width> <height>". The texture has no paper pad, so its texel (0, 0) is the
// chessboard's top-left corner.

// The shipped strip board and the tests' own copies of the scanner's other sheets (T-0335).
import { TEST_BOARD_SPECS as BOARD_SPECS } from '../../../src/web/tests/vision_test_boards.js';
import { renderBoardTexture } from '../../../src/web/src/lib/vision/board_texture.js';

const [name, ppm, out] = Deno.args;
const tex = renderBoardTexture(BOARD_SPECS[name], { ppm: Number(ppm), padMm: 0 });
Deno.writeFileSync(out, tex.data);
console.log(`${tex.width} ${tex.height}`);
