"""Tests for src/scripts/minify_page.js, the minifier make_page.py runs over the renderer page.

Standard library only, like the other tool tests. Run with:

    python3 -m unittest discover -s src/scripts -v

They run the real minifier through make_page.minify, so they need Deno on PATH (and its npm
cache, or the network once); without Deno they are skipped rather than failed.
"""

import pathlib
import re
import shutil
import sys
import unittest

# make_page.py sits next to this file in src/scripts/.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import make_page  # noqa: E402

# A page in the template's shape: a comment, the bundle placeholder, then a script with
# top-level names of its own, reading two globals it never declares (as the page reads the
# GEM_* data and wasm_bindgen), with comments of both kinds.
PAGE = """<!DOCTYPE html>
<html>
<head>
<!-- a comment that must go -->
<style>
  /* a CSS comment */
  body   {   color :  red ; }
</style>
</head>
<body>
<p>two   words</p>
<!-- @@GEM_INLINE_BUNDLE@@ -->
<script>
// a line comment
const longDescriptiveName = document.getElementById('canvas');

/** a block comment */
function helperWithALongName(parameterName) {
  return parameterName + GEM_MODEL_OBJ.length;
}

wasm_bindgen.initSync(helperWithALongName(longDescriptiveName));
window.gemApp = helperWithALongName;
</script>
</body>
</html>
"""


@unittest.skipIf(shutil.which("deno") is None, "Deno is not installed")
class MinifyPageTests(unittest.TestCase):
    def test_page_loses_its_comments_but_keeps_the_bundle_placeholder(self):
        # Setup: PAGE, with an HTML, a CSS and two JavaScript comments, and the placeholder
        # make_page.py substitutes after minifying. Test: minify it as a page. Verifies no
        # comment text survives, the placeholder survives exactly once (or the bundle could
        # not be inlined), and whitespace is collapsed without joining words.
        page = make_page.minify(PAGE, "html", "test page")

        for comment in ("a comment that must go", "a CSS comment", "a line comment", "a block comment"):
            self.assertNotIn(comment, page)

        self.assertEqual(page.count(make_page.BUNDLE_PLACEHOLDER), 1)
        self.assertIn("two words", page)
        self.assertIn("body{color:red}", page)

    def test_page_script_names_are_mangled_and_kept_out_of_the_global_scope(self):
        # Setup: PAGE's script, whose own names are long and descriptive, and which reads
        # GEM_MODEL_OBJ and wasm_bindgen without declaring them. Test: minify the page and
        # take the script after the placeholder. Verifies:
        # - the script's own names are gone (mangled);
        # - the undeclared globals and the gemApp property are untouched, so the script still
        #   finds the bundle's data and the console still finds the renderer;
        # - the script is wrapped in a function, so its short mangled names are locals rather
        #   than globals another script could collide with;
        # - make_page's own globals check passes on it, as the build runs it.
        page = make_page.minify(PAGE, "html", "test page")
        script = page.split(make_page.BUNDLE_PLACEHOLDER, 1)[1]

        for name in ("longDescriptiveName", "helperWithALongName", "parameterName"):
            self.assertNotIn(name, script)

        for name in ("GEM_MODEL_OBJ", "wasm_bindgen.initSync", "window.gemApp"):
            self.assertIn(name, script)

        self.assertRegex(script, r"<script>\s*\(\(\)\s*=>|<script>\s*\(function|<script>\s*!function")
        self.assertNotRegex(script, r"<script>\s*(const|let|var|function)\b")

    def test_classic_script_keeps_the_globals_it_publishes(self):
        # Setup: a script in the shape of the wasm-bindgen glue, a top-level `let` other
        # scripts read, with long local names inside its function. Test: minify it as a
        # script. Verifies the top-level name is kept, since the page reads it, and the
        # locals inside are mangled.
        source = """
let wasm_bindgen = (function (exportsObject) {
  // a comment
  const somethingLocal = 1;
  exportsObject.initSync = function (moduleArgument) { return moduleArgument + somethingLocal; };
  return exportsObject;
})({});
"""
        script = make_page.minify(source, "script", "test script")

        self.assertTrue(re.match(r"\s*let wasm_bindgen\s*=", script), script)
        self.assertIn("initSync", script)
        self.assertNotIn("somethingLocal", script)
        self.assertNotIn("moduleArgument", script)
        self.assertNotIn("a comment", script)

    def test_comment_check_finds_comments_but_not_slashes_in_strings(self):
        # Setup: scripts that contain `//` and `/*` only inside a string and a regular
        # expression (a URL, a pattern), and the same scripts with one real comment added.
        # Test: run the build's last step, check_no_comments, on each, catching the SystemExit
        # that make_page.fail raises. Verifies the clean ones pass (so a URL in a string can
        # never fail the build) and each real comment fails it, in a script and in a page.
        clean_script = 'const url = "https://example.com/a/*b*/"; const re = /\\/\\//g;\n'

        make_page.check_no_comments(clean_script, "check-script", "clean script")
        make_page.check_no_comments(
            f"<html><body><script>{clean_script}</script></body></html>", "check-page", "clean page"
        )

        for commented in (clean_script + "// left behind\n", "/* left */" + clean_script):
            with self.assertRaises(SystemExit):
                make_page.check_no_comments(commented, "check-script", "commented script")

            with self.assertRaises(SystemExit):
                make_page.check_no_comments(
                    f"<html><body><script>{commented}</script></body></html>", "check-page", "page"
                )

        with self.assertRaises(SystemExit):
            make_page.check_no_comments("<html><!-- left --><body></body></html>", "check-page", "page")

    def test_the_built_page_has_no_comments(self):
        # Setup: build/www/houseki.html as the last build left it. Test: the same check the build ends
        # with. Verifies a built page really is comment-free, including the script of inlined
        # data make_page.py writes after minifying the template, which is where comments were
        # found left behind (2026-09-18). Skipped when the page was built with --no-minify,
        # whose comments are deliberate.
        page = make_page.DEFAULT_OUTPUT.read_text()

        if "GENERATED FILE, do not edit" in page:
            self.skipTest("build/www/houseki.html was built with --no-minify")

        make_page.check_no_comments(page, "check-page", "built page")


if __name__ == "__main__":
    unittest.main()
