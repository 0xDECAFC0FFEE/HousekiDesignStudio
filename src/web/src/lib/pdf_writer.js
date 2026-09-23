/*
 * pdf_writer.js -- a small PDF writer for File > Export > PDF (export_pdf.js): pages of straight
 * lines, filled polygons and text, and nothing else, which is all a printed cutting sheet has.
 *
 * LIBRARY VS HAND-ROLLED (CLAUDE.md prefers a permissive library). Checked first:
 *
 *   - jsPDF (MIT) loads its optional html2canvas, DOMPurify and canvg with dynamic `import()`,
 *     and make_page.py refuses any dynamic import in the page (a file:// page cannot fetch the
 *     chunk it would name), so it cannot be bundled as it ships.
 *   - pdf-lib (MIT) has no dynamic import, but brings pako, its own font-metric tables and a PNG
 *     codec, several hundred kB more for a page of about 1 MB that loads all of it at startup,
 *     for one menu item that draws lines and writes text.
 *
 * What the sheet needs is small and fully specified: the PDF 1.4 file structure (objects, a
 * cross-reference table, a trailer), the path operators `m l h S f`, and text in three of the
 * fourteen standard fonts every PDF reader has built in (Helvetica, Helvetica-Bold and
 * Times-Bold), so no font is embedded. Laying text out (centring a heading, right-aligning a
 * number, wrapping a note) needs each character's width; the standard fonts' widths are public
 * Adobe metrics (the AFM files), copied below for the printable ASCII range.
 *
 * Coordinates given to a page are in points (1/72 inch) from the page's TOP-LEFT corner, y
 * downwards, as a sheet is laid out; they are turned into PDF's bottom-left, y-up frame on
 * the way out. Text is written in WinAnsiEncoding: Latin-1 plus a few typographic characters
 * (dashes, curly quotes, the bullet); anything else is written as "?".
 */

/** US Letter, in points. */
export const LETTER = { width: 612, height: 792 };

/** The fonts a page can use, by the name its methods take, and their PDF base font names. */
const FONTS = {
  helvetica: { resource: 'F1', baseFont: 'Helvetica' },
  'helvetica-bold': { resource: 'F2', baseFont: 'Helvetica-Bold' },
  'times-bold': { resource: 'F3', baseFont: 'Times-Bold' },
};

/*
 * Glyph widths in thousandths of the font size, for character codes 32 (space) to 126 (~), from
 * Adobe's AFM files for the standard fonts. Code 39 is `quotesingle` and 96 is `grave`, as
 * WinAnsiEncoding maps them.
 */
const WIDTHS = {
  helvetica: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  'helvetica-bold': [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
  'times-bold': [
    250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
    930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
    611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
    333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
    556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
  ],
};

/**
 * The WinAnsiEncoding code of each character outside Latin-1's shared range that the sheet may
 * meet in a note or a name: typographic quotes and dashes, mostly, which a pasted instruction
 * brings with it. Latin-1's own 0xA0 to 0xFF are the same code in WinAnsiEncoding.
 */
const WIN_ANSI_EXTRA = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85,
  '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a,
  '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92,
  '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c,
  'ž': 0x9e, 'Ÿ': 0x9f,
};

/** `text` as WinAnsiEncoding codes, one per character; a character it cannot encode is "?". */
export function winAnsiCodes(text) {
  const codes = [];

  for (const char of String(text)) {
    const code = char.codePointAt(0);

    if (code >= 32 && code <= 126) {
      codes.push(code);
    } else if (code >= 0xa0 && code <= 0xff) {
      codes.push(code);
    } else if (WIN_ANSI_EXTRA[char] !== undefined) {
      codes.push(WIN_ANSI_EXTRA[char]);
    } else if (char === '\t') {
      codes.push(32);
    } else {
      codes.push(63);
    }
  }

  return codes;
}

/**
 * How wide `text` is in `font` at `size` points. A code above the ASCII range is taken as wide
 * as a digit: accented letters are within a few percent of that, and the sheet only uses the
 * width to place and wrap text, where that is close enough.
 */
export function textWidth(text, font, size) {
  const widths = WIDTHS[font];

  if (!widths) {
    throw new Error(`unknown font ${font}`);
  }

  let total = 0;

  for (const code of winAnsiCodes(text)) {
    total += code <= 126 ? widths[code - 32] : widths['0'.charCodeAt(0) - 32];
  }

  return total * size / 1000;
}

/**
 * `text` broken into lines no wider than `maxWidth`. Breaks go after a space or after any
 * character in `breakAfter` (a dash, say, so "04-12-20-28" wraps between teeth and keeps its
 * dash at the end of the line); a single word wider than the line is left whole on its own
 * line rather than cut. Explicit line breaks in `text` are kept.
 */
export function wrapText(text, font, size, maxWidth, breakAfter = '') {
  const lines = [];

  for (const paragraph of String(text).split(/\r?\n/)) {
    // Split into pieces that each end at a permitted break, keeping the break character.
    const pieces = [];
    let piece = '';

    for (const char of paragraph) {
      piece += char;

      if (char === ' ' || breakAfter.includes(char)) {
        pieces.push(piece);
        piece = '';
      }
    }

    if (piece) {
      pieces.push(piece);
    }

    let line = '';

    for (const next of pieces) {
      if (line && textWidth((line + next).trimEnd(), font, size) > maxWidth) {
        lines.push(line.trimEnd());
        line = next.trimStart();
      } else {
        line += next;
      }
    }

    lines.push(line.trimEnd());
  }

  return lines;
}

/** A number for a content stream: at most three decimals, no exponent, no "-0". */
function num(value) {
  const text = (Math.round(value * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');

  return text === '-0' ? '0' : text;
}

/** `text` as a PDF literal string, `(...)`, of WinAnsiEncoding bytes. */
function pdfString(text) {
  let out = '(';

  for (const code of winAnsiCodes(text)) {
    if (code === 0x28 || code === 0x29 || code === 0x5c) {
      out += '\\' + String.fromCharCode(code);
    } else {
      out += String.fromCharCode(code);
    }
  }

  return out + ')';
}

/** `text` as a PDF text string for the document information dictionary: UTF-16BE, in hex. */
function pdfTextString(text) {
  let hex = 'FEFF';

  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  }

  return `<${hex}>`;
}

/**
 * One page's content: drawing calls append PDF operators to it. Every method takes top-left
 * coordinates in points; `height` is the page's, used to flip y.
 */
export class PdfPage {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.ops = [];
    this.lineWidthNow = null;
  }

  /** PDF's y for a top-down `y`. */
  y(value) {
    return this.height - value;
  }

  setLineWidth(width) {
    if (width !== this.lineWidthNow) {
      this.ops.push(`${num(width)} w`);
      this.lineWidthNow = width;
    }
  }

  /** A straight line from (x1, y1) to (x2, y2), `width` points thick. */
  line(x1, y1, x2, y2, width = 0.5) {
    this.setLineWidth(width);
    this.ops.push(`${num(x1)} ${num(this.y(y1))} m ${num(x2)} ${num(this.y(y2))} l S`);
  }

  /** Many lines with one width, each `[x1, y1, x2, y2]`, as one path. */
  lines(segments, width = 0.5) {
    if (segments.length === 0) {
      return;
    }

    this.setLineWidth(width);
    this.ops.push(segments
      .map(([x1, y1, x2, y2]) => `${num(x1)} ${num(this.y(y1))} m ${num(x2)} ${num(this.y(y2))} l`)
      .join('\n') + ' S');
  }

  /** A filled polygon through `points` (`[x, y]` pairs), in black. */
  fillPolygon(points) {
    if (points.length < 3) {
      return;
    }

    const [first, ...rest] = points;

    this.ops.push(`${num(first[0])} ${num(this.y(first[1]))} m ` +
      rest.map(([x, y]) => `${num(x)} ${num(this.y(y))} l`).join(' ') + ' h f');
  }

  /**
   * `text` with its baseline at `y`. `align` places `x` at the text's left edge, its centre or
   * its right edge. Returns the text's width.
   */
  text(text, x, y, { font = 'helvetica', size = 9, align = 'left' } = {}) {
    const width = textWidth(text, font, size);
    const left = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;

    if (String(text).length > 0) {
      this.ops.push(`BT /${FONTS[font].resource} ${num(size)} Tf ${num(left)} ${num(this.y(y))} Td ` +
        `${pdfString(text)} Tj ET`);
    }

    return width;
  }

  /** The content stream. */
  content() {
    return this.ops.join('\n') + '\n';
  }
}

/**
 * A PDF document: `addPage()` for each page, then `toBytes()`. `title` and `author` go into the
 * document's information dictionary, which a reader shows as its properties.
 */
export class PdfDocument {
  constructor({ width = LETTER.width, height = LETTER.height, title = '', author = '' } = {}) {
    this.width = width;
    this.height = height;
    this.title = title;
    this.author = author;
    this.pages = [];
  }

  addPage() {
    const page = new PdfPage(this.width, this.height);

    this.pages.push(page);
    return page;
  }

  /**
   * The file as a byte string, one character per byte: every character this writes is below
   * 256 (`pdfString` writes WinAnsiEncoding bytes; everything else is ASCII), so the string's
   * length is the byte offset the cross-reference table needs.
   */
  toBinaryString() {
    // Object numbers: 1 catalog, 2 page tree, 3 to 5 the fonts, 6 the information dictionary,
    // then a page object and its content stream for each page.
    const objects = [];
    const pageRefs = this.pages.map((_, i) => `${7 + i * 2} 0 R`);
    const fontEntries = Object.values(FONTS).map((font, i) => `/${font.resource} ${3 + i} 0 R`).join(' ');

    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${this.pages.length} >>`;
    Object.values(FONTS).forEach((font, i) => {
      objects[3 + i] = `<< /Type /Font /Subtype /Type1 /BaseFont /${font.baseFont} ` +
        '/Encoding /WinAnsiEncoding >>';
    });
    objects[6] = `<< /Title ${pdfTextString(this.title)} /Author ${pdfTextString(this.author)} ` +
      `/Producer ${pdfTextString('Houseki Design Studio')} >>`;

    this.pages.forEach((page, i) => {
      const content = page.content();

      objects[7 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ` +
        `${num(this.height)}] /Resources << /Font << ${fontEntries} >> >> ` +
        `/Contents ${8 + i * 2} 0 R >>`;
      objects[8 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}endstream`;
    });

    // The binary comment line after the header marks the file as binary for transfer tools.
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets = [];

    for (let n = 1; n < objects.length; n++) {
      offsets[n] = out.length;
      out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
    }

    const xref = out.length;

    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;

    for (let n = 1; n < objects.length; n++) {
      out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    }

    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

    return out;
  }

  /** The file's bytes. */
  toBytes() {
    const text = this.toBinaryString();
    const bytes = new Uint8Array(text.length);

    for (let i = 0; i < text.length; i++) {
      bytes[i] = text.charCodeAt(i);
    }

    return bytes;
  }
}
