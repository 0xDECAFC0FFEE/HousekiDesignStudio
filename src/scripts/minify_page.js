// Minifies the renderer page for make_page.py: reads text on stdin, writes it minified on
// stdout. Run with Deno (this machine's node is broken; see kb/build-and-test-commands.md):
//
//   deno run --quiet --allow-env --allow-read src/scripts/minify_page.js html < in.html > out.html
//   deno run --quiet --allow-env --allow-read src/scripts/minify_page.js script < in.js > out.js
//   deno run --quiet --allow-env --allow-read src/scripts/minify_page.js check-page < page.html
//   deno run --quiet --allow-env --allow-read src/scripts/minify_page.js check-script < script.js
//
// `html` minifies a page: whitespace collapsed, every comment removed except the inline
// bundle placeholder (make_page.py replaces it afterwards), inline CSS minified with
// clean-css, and inline JavaScript minified with terser, every name it declares mangled.
// Each inline script is first wrapped in an arrow function, so what were its top-level names
// become locals: mangled like any other, and never one-letter globals that another classic
// script (or a console line) declaring the same letter would collide with. That is safe for
// the page's script because the only names it shares with other scripts are globals it reads
// but never declares (the GEM_* data, wasm_bindgen, GemCad...), which terser leaves alone,
// and everything outside (the harness, the console) goes through element ids and
// window.gemApp. The template must therefore never rely on its own top-level names being
// global.
//
// `script` minifies a classic script that publishes globals of its own (the wasm-bindgen glue,
// the GemCad reader, make_page.py's script of inlined data), so its top-level names are kept
// and only the names inside it mangled.
//
// `check-page` and `check-script` are the last step of a minified build: they print nothing
// and exit 0 when no comment is left, and otherwise list each one and exit 1. `check-page`
// parses every inline <script> of a finished page and also looks for HTML comments;
// `check-script` parses one script (the inlined, compressed ones, before compression). They
// parse with acorn rather than matching `//` and `/*`, which also occur inside strings and
// regular expressions.
//
// The packages are pinned exactly; Deno fetches them into its cache on the first run, which
// needs the network once. html-minifier-terser (MIT), terser (BSD-2-Clause), acorn (MIT):
// build-time only, nothing of theirs ships in the page.

import { minify as minifyHtml } from "npm:html-minifier-terser@7.2.0";
import { minify as minifyScript } from "npm:terser@5.36.0";
import { parse as parseScript } from "npm:acorn@8.14.0";

// The one comment the page must keep: make_page.py's BUNDLE_PLACEHOLDER.
const KEPT_COMMENTS = [/^\s*@@GEM_INLINE_BUNDLE@@\s*$/];

const TERSER_OPTIONS = {
  compress: { passes: 2 },
  format: { comments: false },
};

async function minifyInlineScript(text) {
  const result = await minifyScript(`(() => {\n${text}\n})();`, { ...TERSER_OPTIONS, mangle: true });

  return result.code;
}

async function minifyClassicScript(text) {
  const result = await minifyScript(text, { ...TERSER_OPTIONS, mangle: true });

  return result.code;
}

async function readStdin() {
  return await new Response(Deno.stdin.readable).text();
}

/** Writes all of `text` to stdout: one `Deno.stdout.write` may write only part of it. */
async function writeStdout(text) {
  const bytes = new TextEncoder().encode(text);
  let written = 0;

  while (written < bytes.length) {
    written += await Deno.stdout.write(bytes.subarray(written));
  }
}

/** Every comment in the script `text`, as a short description, parsed rather than matched. */
function scriptComments(text, where) {
  const found = [];

  parseScript(text, {
    ecmaVersion: "latest",
    sourceType: "script",
    onComment: (block, body, start) => {
      found.push(`${where}, offset ${start}: ${block ? "/*" : "//"}${body.slice(0, 60)}`);
    },
  });

  return found;
}

/** Every comment in the page `text`: in its inline scripts, and HTML comments outside them. */
function pageComments(text) {
  const found = [];
  let index = 0;

  // make_page.py refuses any inlined text containing '</script', so a script's end is the
  // first '</script' after its start.
  const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script/gi;
  let outside = text;

  for (const match of text.matchAll(scriptPattern)) {
    index += 1;
    found.push(...scriptComments(match[1], `inline script ${index}`));
    outside = outside.replace(match[1], "");
  }

  for (const match of outside.matchAll(/<!--([\s\S]*?)-->/g)) {
    found.push(`HTML comment: <!--${match[1].slice(0, 60)}`);
  }

  return found;
}

const mode = Deno.args[0];
const input = await readStdin();
let output;

if (mode === "html") {
  output = await minifyHtml(input, {
    collapseWhitespace: true,
    // Keeps one space where whitespace between inline elements separated words, so
    // "<span>a</span> <span>b</span>" does not run together.
    conservativeCollapse: true,
    removeComments: true,
    ignoreCustomComments: KEPT_COMMENTS,
    minifyCSS: true,
    minifyJS: minifyInlineScript,
  });
} else if (mode === "script") {
  output = await minifyClassicScript(input);
} else if (mode === "check-page" || mode === "check-script") {
  const found = mode === "check-page" ? pageComments(input) : scriptComments(input, "script");

  if (found.length > 0) {
    console.error(`${found.length} comment(s) left:\n${found.join("\n")}`);
    Deno.exit(1);
  }

  Deno.exit(0);
} else {
  console.error(
    `usage: minify_page.js html|script|check-page|check-script < input (got ${JSON.stringify(mode)})`
  );
  Deno.exit(2);
}

await writeStdout(output);
