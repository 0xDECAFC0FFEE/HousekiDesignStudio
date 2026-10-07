"""Tests for make_page.build_site, which writes the landing page (build/www/index.html), the
user documentation (build/www/docs.html and build/www/docs/), robots.txt and sitemap.xml from
src/site/.

Each test points make_page at a temporary site.json and output directory, so the real
build/www/ is never touched, and reads the real src/site/index.html as its source. No browser,
no Deno: these run under the default python3.

Run with:

    python3 -m unittest discover -s src/scripts -v
"""

import base64
import gzip
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

# make_page.py sits next to this file in src/scripts/, so its own directory is what goes on the
# path. `discover` adds the start directory too, but being explicit means a single test file
# can also be run directly.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import make_page  # noqa: E402

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]

# Only ever used as the app's file NAME, for the links and the sitemap entry build_site writes;
# the file itself is never read, so this does not require a build to have run.
APP = PROJECT_ROOT / "build" / "www" / "studio.html"


def json_ld(page):
    """The parsed JSON-LD of `page`, which must have exactly one such script."""
    blocks = page.split('<script type="application/ld+json">')
    assert len(blocks) == 2, f"expected one JSON-LD script, found {len(blocks) - 1}"
    return json.loads(blocks[1].split("</script>", 1)[0])


def docs_pages():
    """Every page pages.json lists, in order."""
    config = json.loads((make_page.DOCS_DIR / "pages.json").read_text())
    return [page for section in config["sections"] for page in section["pages"]]


class BuildSiteTest(unittest.TestCase):
    def build(self, config):
        """Runs build_site with `config` as site.json, into a fresh temporary directory.
        Returns that directory, as a Path, and the paths build_site reported writing.

        last_modified's cache is cleared first, so a test that mocks git out (and the tests
        after it) each see what git says now rather than an earlier test's answer."""
        work = pathlib.Path(tempfile.mkdtemp(prefix="gem-site-"))
        config_path = work / "site.json"
        config_path.write_text(json.dumps(config))
        out = work / "www"
        out.mkdir()
        make_page.last_modified.cache_clear()

        with mock.patch.object(make_page, "SITE_CONFIG", config_path), \
                mock.patch.object(make_page, "SITE_OUTPUT_DIR", out):
            written = make_page.build_site(APP)

        return out, written

    def test_without_a_domain_no_absolute_url_is_published(self):
        # Setup: site.json with an empty url, as the project ships until there is a domain.
        # Test: build the site.
        # Verifies: the page has no leftover placeholder and no canonical or og:url
        # line (each would otherwise point nowhere); the JSON-LD is still valid JSON; robots.txt
        # allows crawling and names no sitemap; and no sitemap.xml is written, since a sitemap
        # must list absolute URLs.
        out, written = self.build({"url": "", "docs": "docs.html"})
        page = (out / "index.html").read_text()

        self.assertNotIn("@@", page)
        self.assertNotIn('rel="canonical"', page)
        self.assertNotIn("og:url", page)
        self.assertNotIn("og:image\"", page)
        self.assertIn('href="docs.html"', page)
        self.assertIn('href="studio.html"', page)

        self.assertEqual(json_ld(page)["name"], "Houseki Design Studio")

        self.assertEqual((out / "robots.txt").read_text(), "User-agent: *\nAllow: /\n")
        self.assertFalse((out / "sitemap.xml").exists())
        self.assertIn(out / "docs.html", written)

    def test_without_a_domain_the_docs_and_about_pages_publish_no_absolute_url(self):
        # Setup: site.json with an empty url.
        # Test: build the site, then read the about page, the docs home page and every docs page.
        # Verifies: none of them has a canonical link, an og:url or an og:image (each would be a
        # relative or empty address, which crawlers and link previews reject), none has a
        # leftover placeholder, and every docs page still carries valid JSON-LD: a TechArticle
        # with its own title, with no breadcrumb trail, since that needs absolute URLs.
        out, _ = self.build({"url": "", "docs": "docs.html"})
        paths = [out / "about.html", out / "docs.html",
                 *[out / "docs" / f"{page['slug']}.html" for page in docs_pages()]]

        for path in paths:
            text = path.read_text()

            with self.subTest(page=path.name):
                self.assertNotIn("@@", text)
                self.assertNotIn('rel="canonical"', text)
                self.assertNotIn("og:url", text)
                self.assertNotIn('property="og:image"', text)

        for page in docs_pages():
            data = json_ld((out / "docs" / f"{page['slug']}.html").read_text())
            self.assertEqual(data["@type"], "TechArticle")
            self.assertEqual(data["headline"], page["title"])
            self.assertNotIn("@graph", data)

    def test_with_a_domain_every_absolute_url_uses_it(self):
        # Setup: site.json with a domain. Test: build the site.
        # Verifies: canonical and og:url both use the one configured URL; the JSON-LD
        # names the app's absolute URL; robots.txt points at the sitemap; and the sitemap lists
        # the landing page, the app, the docs home page and every docs page.
        url = "https://example.com/"
        out, _ = self.build({"url": url, "docs": "docs.html"})
        page = (out / "index.html").read_text()

        self.assertIn(f'<link rel="canonical" href="{url}">', page)
        self.assertIn(f'<meta property="og:url" content="{url}">', page)

        self.assertEqual(json_ld(page)["url"], url + "studio.html")

        self.assertIn(f"Sitemap: {url}sitemap.xml", (out / "robots.txt").read_text())
        sitemap = (out / "sitemap.xml").read_text()
        self.assertIn(f"<loc>{url}</loc>", sitemap)
        self.assertIn(f"<loc>{url}studio.html</loc>", sitemap)
        self.assertIn(f"<loc>{url}docs.html</loc>", sitemap)
        self.assertIn(f"<loc>{url}docs/getting-started.html</loc>", sitemap)

    def test_with_a_domain_the_docs_and_about_pages_name_their_own_address(self):
        # Setup: site.json with a domain.
        # Test: build the site, then read the about page, the docs home page and one docs page.
        # Verifies: each page's canonical link and og:url are its OWN absolute address (not the
        # home page's, which would tell search engines every page is a copy of the home page);
        # the docs page's og:title and og:description are its own, from pages.json; and its
        # JSON-LD is a TechArticle at that address plus a breadcrumb trail home > documentation
        # > the page, every step an absolute URL. The docs home page's trail stops at
        # "Documentation", which is itself.
        url = "https://example.com/"
        out, _ = self.build({"url": url, "docs": "docs.html"})
        first = docs_pages()[0]
        own = f"docs/{first['slug']}.html"

        for path, address in (("about.html", url + "about.html"), ("docs.html", url + "docs.html"),
                              (own, url + own)):
            text = (out / path).read_text()

            with self.subTest(page=path):
                self.assertIn(f'<link rel="canonical" href="{address}">', text)
                self.assertIn(f'<meta property="og:url" content="{address}">', text)

        text = (out / own).read_text()
        self.assertIn(f'<meta property="og:title" content="{first["title"]} | Houseki Design Studio">', text)
        self.assertIn(f'<meta property="og:description" content="{first["summary"]}">'.replace("'", "&#x27;"), text)

        article, trail = json_ld(text)["@graph"]
        self.assertEqual(article["@type"], "TechArticle")
        self.assertEqual(article["url"], url + own)
        self.assertEqual([item["item"] for item in trail["itemListElement"]],
                         [url, url + "docs.html", url + own])
        self.assertEqual([item["position"] for item in trail["itemListElement"]], [1, 2, 3])

        _, home_trail = json_ld((out / "docs.html").read_text())["@graph"]
        self.assertEqual([item["item"] for item in home_trail["itemListElement"]],
                         [url, url + "docs.html"])

    def test_the_social_preview_is_published_and_every_page_names_it(self):
        # Setup: site.json with a domain.
        # Test: build the site.
        # Verifies: src/site/og-image.png is copied, byte for byte, to the site root; and the
        # landing page, the about page and a docs page each name it by its absolute URL as
        # og:image and twitter:image, with the large-image Twitter card that shows it.
        url = "https://example.com/"
        out, written = self.build({"url": url, "docs": "docs.html"})

        self.assertIn(out / "og-image.png", written)
        self.assertEqual((out / "og-image.png").read_bytes(), make_page.OG_IMAGE.read_bytes())

        for path in ("index.html", "about.html", f"docs/{docs_pages()[0]['slug']}.html"):
            text = (out / path).read_text()

            with self.subTest(page=path):
                self.assertIn(f'<meta property="og:image" content="{url}og-image.png">', text)
                self.assertIn(f'<meta name="twitter:image" content="{url}og-image.png">', text)
                self.assertIn('<meta name="twitter:card" content="summary_large_image">', text)

    def test_the_landing_page_lists_every_finished_feature(self):
        # Setup: the real pages.json, in which some pages are marked "wip" and the first section
        # ("Getting started") is not about a feature.
        # Test: build the site and read the landing page.
        # Verifies: the landing page links every finished feature's docs page, and no page that
        # is in progress or in "Getting started"; its JSON-LD featureList names exactly those
        # pages, in pages.json's order, and says the app is free; and the screenshot it shows
        # exists in the built site (it is a docs screenshot, copied with the docs).
        out, _ = self.build({"url": "", "docs": "docs.html"})
        page = (out / "index.html").read_text()
        config = json.loads((make_page.DOCS_DIR / "pages.json").read_text())
        expected = []

        for section in config["sections"]:
            for entry in section["pages"]:
                link = f'<li><a href="docs/{entry["slug"]}.html">'

                if entry.get("wip") or section["title"] == "Getting started":
                    self.assertNotIn(link, page)
                else:
                    self.assertIn(link, page)
                    expected.append(entry["title"])

        self.assertTrue(expected)
        data = json_ld(page)
        self.assertEqual(data["featureList"], expected)
        self.assertEqual(data["offers"]["price"], "0")

        for source in re.findall(r'<img[^>]*\bsrc="([^"]+)"', page):
            self.assertTrue((out / source).is_file(), source)

    def test_the_sitemap_dates_each_page_by_its_last_commit(self):
        # Setup: site.json with a domain, built from this git checkout.
        # Test: build the site and read sitemap.xml.
        # Verifies: every <url> entry has a <lastmod> in the YYYY-MM-DD form sitemaps take, and
        # a docs page's date is the one git gives for its own source fragment and screenshots,
        # so a page is dated by its own last change rather than by the whole site's. Also that
        # the docs page's JSON-LD dateModified agrees with the sitemap.
        url = "https://example.com/"
        out, _ = self.build({"url": url, "docs": "docs.html"})
        sitemap = (out / "sitemap.xml").read_text()
        entries = re.findall(r"<url>(.*?)</url>", sitemap)

        self.assertTrue(entries)

        for entry in entries:
            self.assertRegex(entry, r"<lastmod>\d{4}-\d{2}-\d{2}</lastmod>")

        slug = docs_pages()[0]["slug"]
        expected = subprocess.run(
            ["git", "log", "-1", "--format=%cs", "--",
             f"src/site/docs/{slug}.html", f"src/site/docs/images/{slug}"],
            capture_output=True, text=True, cwd=PROJECT_ROOT).stdout.strip()

        self.assertIn(f"<loc>{url}docs/{slug}.html</loc><lastmod>{expected}</lastmod>", sitemap)
        article, _ = json_ld((out / "docs" / f"{slug}.html").read_text())["@graph"]
        self.assertEqual(article["dateModified"], expected)

    def test_without_git_the_sitemap_is_written_undated(self):
        # Setup: site.json with a domain, and git made unavailable (subprocess.run raising
        # OSError, as it does when the executable is missing), as on a machine or a source
        # tarball without it.
        # Test: build the site.
        # Verifies: the build still succeeds and still writes a sitemap listing the landing
        # page, with no <lastmod> at all rather than a wrong or empty one.
        def no_git(command, *args, **kwargs):
            raise OSError("git: not found")

        with mock.patch.object(make_page.subprocess, "run", no_git):
            out, _ = self.build({"url": "https://example.com/", "docs": "docs.html"})

        make_page.last_modified.cache_clear()
        sitemap = (out / "sitemap.xml").read_text()
        self.assertIn("<loc>https://example.com/</loc>", sitemap)
        self.assertNotIn("<lastmod>", sitemap)

    def test_the_docs_home_and_every_listed_page_are_written(self):
        # Setup: the real src/site/docs/ (pages.json, the layout and every page fragment), built
        # into a temporary output directory.
        # Test: build the site, then read the docs home page and each page pages.json lists.
        # Verifies: the home page is docs.html at the site root (where site.json's `docs` link
        # points) and links every page under docs/; each page exists at docs/<slug>.html, has no
        # leftover placeholder, carries its own title, marks itself as the current page in the
        # sidebar, and links back up to the studio with a path that works from inside docs/.
        out, written = self.build({"url": "", "docs": "docs.html"})
        home = (out / "docs.html").read_text()
        config = json.loads((make_page.DOCS_DIR / "pages.json").read_text())
        pages = [page for section in config["sections"] for page in section["pages"]]

        self.assertNotIn("@@", home)

        for page in pages:
            self.assertIn(f'href="docs/{page["slug"]}.html"', home)

            path = out / "docs" / f"{page['slug']}.html"
            self.assertIn(path, written)
            text = path.read_text()
            self.assertNotIn("@@", text)
            self.assertIn(f"<title>{page['title']} | Houseki Design Studio</title>", text)
            self.assertIn(f'href="{page["slug"]}.html" aria-current="page"', text)
            self.assertIn('href="../studio.html"', text)

    def test_a_page_showing_a_missing_screenshot_is_refused(self):
        # Setup: a copy of src/site/docs/ in which one page shows an image that does not exist,
        # as a page would after a screenshot was renamed or never committed.
        # Test: build the site from that copy.
        # Verifies: the build stops with an error, instead of publishing a broken image.
        work = pathlib.Path(tempfile.mkdtemp(prefix="gem-docs-"))
        docs = work / "docs"
        shutil.copytree(make_page.DOCS_DIR, docs)
        first = json.loads((docs / "pages.json").read_text())["sections"][0]["pages"][0]["slug"]
        (docs / f"{first}.html").write_text('<h1>Broken</h1>\n<img src="images/nowhere.webp" alt="">\n')

        with mock.patch.object(make_page, "DOCS_DIR", docs), self.assertRaises(SystemExit):
            self.build({"url": "", "docs": "docs.html"})

    def test_a_page_file_missing_from_pages_json_is_refused(self):
        # Setup: a copy of src/site/docs/ with an extra page file that pages.json does not list,
        # which would otherwise be a page no link ever reaches.
        # Test: build the site from that copy.
        # Verifies: the build stops with an error naming the mismatch.
        work = pathlib.Path(tempfile.mkdtemp(prefix="gem-docs-"))
        docs = work / "docs"
        shutil.copytree(make_page.DOCS_DIR, docs)
        (docs / "unlisted.html").write_text("<h1>Unlisted</h1>\n")

        with mock.patch.object(make_page, "DOCS_DIR", docs), self.assertRaises(SystemExit):
            self.build({"url": "", "docs": "docs.html"})

    def test_a_bad_url_is_refused(self):
        # Setup: a url with no trailing slash, which would glue "studio.html" onto the host
        # name. Test: build the site. Verifies: the build stops with an error instead.
        with self.assertRaises(SystemExit):
            self.build({"url": "https://example.com", "docs": "docs.html"})


class InstallScannerPageTest(unittest.TestCase):
    """make_page.install_scanner_page (T-0313): the phone scanner page, built by its own Vite
    config into one file, is copied to scanner/index.html so the site serves it at /scanner."""

    def install(self, built_page):
        """Runs install_scanner_page on `built_page` (standing in for Vite's output) into a fresh
        temporary directory. Returns that directory and the path the function reported."""
        work = pathlib.Path(tempfile.mkdtemp(prefix="gem-scanner-"))
        built = work / "built.html"
        built.write_text(built_page)
        out = work / "www"
        out.mkdir()

        with mock.patch.object(make_page, "SCANNER_BUILD", built):
            return out, make_page.install_scanner_page(out)

    def test_a_single_file_page_is_served_at_scanner(self):
        # Setup: a self-contained page, its script and style inline, as vite-plugin-singlefile
        # writes it. Test: install it. Verifies: it lands, unchanged, at scanner/index.html, the
        # file a static host serves for /scanner (and /scanner/), and that is the path returned.
        page = "<!DOCTYPE html><html><head><style>p{}</style><script type=\"module\">go()</script></head></html>"
        out, path = self.install(page)

        self.assertEqual(path, out / "scanner" / "index.html")
        self.assertEqual(path.read_text(), page)

    def test_a_page_that_loads_another_file_is_refused(self):
        # Setup: two pages that each load a second file, a script by src= and a stylesheet by
        # <link>, as a Vite config change (dropping the single-file plugin) would leave them.
        # Test: install each. Verifies: the build stops with an error rather than publishing a
        # page whose script or style is missing from the site (or unloadable from file://).
        for page in ('<script type="module" src="./assets/index.js"></script>',
                     '<link rel="stylesheet" href="./assets/style.css">'):
            with self.subTest(page=page), self.assertRaises(SystemExit):
                self.install(page)


class InstallScannerOpenCvTest(unittest.TestCase):
    """make_page.install_scanner_opencv (T-0323): the phone page's prebuilt OpenCV, committed at
    src/web/vendor/opencv/opencv.js, is copied next to the page as scanner/opencv.js, where the
    page's loader (src/web/src/lib/vision/opencv.js) asks for it."""

    def install(self, source):
        """Runs install_scanner_opencv with `source` standing in for the committed opencv.js, into
        a fresh temporary directory. Returns that directory and the path the function reported."""
        out = pathlib.Path(tempfile.mkdtemp(prefix="gem-opencv-")) / "www"
        out.mkdir()

        with mock.patch.object(make_page, "SCANNER_OPENCV", source):
            return out, make_page.install_scanner_opencv(out)

    def test_the_committed_opencv_is_copied_next_to_the_phone_page(self):
        # Setup: the REAL committed opencv.js (no build needed: it is a source file).
        # Test: install it.
        # Verifies: it lands at scanner/opencv.js, the path the loader resolves "opencv.js" to
        # from /scanner/index.html, byte for byte (Emscripten embeds the wasm as text, so any
        # re-encoding would break it), and that is the path returned. Also that the committed file
        # is there at all, which a fresh clone's build depends on.
        self.assertTrue(make_page.SCANNER_OPENCV.is_file(), "the committed opencv.js is missing")
        out, path = self.install(make_page.SCANNER_OPENCV)

        self.assertEqual(path, out / "scanner" / "opencv.js")
        self.assertEqual(path.read_bytes(), make_page.SCANNER_OPENCV.read_bytes())

    def test_a_missing_or_wrong_file_is_refused(self):
        # Setup: a path that does not exist, and a file that is not opencv.js (a truncated
        # download or a wrong copy would look like this).
        # Test: install each.
        # Verifies: the build stops with an error rather than publishing a phone page whose
        # OpenCV fails to load only on the phone.
        work = pathlib.Path(tempfile.mkdtemp(prefix="gem-opencv-"))
        wrong = work / "opencv.js"
        wrong.write_text("console.log('not opencv');\n")

        for source in (work / "missing.js", wrong):
            with self.subTest(source=source.name), self.assertRaises(SystemExit):
                self.install(source)


class ScannerVisionScriptTest(unittest.TestCase):
    """make_page.build_vision_script and install_scanner_vision (T-0330): the phone's Rust vision
    module (src/vision) is packed with its wasm-bindgen glue into one classic script,
    houseki_vision.js, defining globalThis.HOUSEKI_VISION_WASM = { glue, wasm } (each gzip +
    base64), and copied next to the phone page, where src/web/src/lib/vision/vision_wasm.js asks
    for it."""

    def test_the_glue_and_wasm_are_packed_and_installed_next_to_the_page(self):
        # Setup: a stand-in no-modules glue (it declares `let wasm_bindgen`, as wasm-bindgen's
        # does) and stand-in wasm bytes in a temporary directory; VISION_SCRIPT pointed there.
        # Test: build the script unminified, then install it into a fresh output directory.
        # Verifies: the script is exactly one assignment to globalThis.HOUSEKI_VISION_WASM whose
        # glue and wasm fields inflate back (base64, then gzip) to the inputs byte for byte; the
        # size table names both parts; and the script is copied unchanged to
        # scanner/houseki_vision.js, the path returned.
        work = pathlib.Path(tempfile.mkdtemp(prefix="gem-vision-"))
        glue = work / "glue.js"
        glue.write_text("let wasm_bindgen = (function(exports) { return exports; })({});\n")
        wasm = work / "module.wasm"
        wasm.write_bytes(b"\0asm\1\0\0\0" + bytes(range(256)) * 4)
        script = work / "vision" / "houseki_vision.js"
        out = work / "www"
        out.mkdir()

        with mock.patch.object(make_page, "VISION_SCRIPT", script):
            parts = make_page.build_vision_script(glue, wasm, minified=False)
            path = make_page.install_scanner_vision(out)

        text = script.read_text()
        self.assertTrue(text.startswith("globalThis.HOUSEKI_VISION_WASM={glue:"), text[:60])
        packed = json.loads(text[len("globalThis.HOUSEKI_VISION_WASM="):].rstrip().rstrip(";")
                            .replace("glue:", '"glue":').replace(",wasm:", ',"wasm":'))
        self.assertEqual(gzip.decompress(base64.b64decode(packed["glue"])), glue.read_bytes())
        self.assertEqual(gzip.decompress(base64.b64decode(packed["wasm"])), wasm.read_bytes())
        self.assertEqual([p[0].split(" (")[0] for p in parts], ["phone vision wasm", "phone vision glue"])
        self.assertEqual(path, out / "scanner" / "houseki_vision.js")
        self.assertEqual(path.read_text(), text)

    def test_a_missing_or_wrong_script_is_refused(self):
        # Setup: no built script, then a file that is not the packed script.
        # Test: install each.
        # Verifies: the build stops with an error rather than publishing a phone page whose board
        # finder cannot load.
        work = pathlib.Path(tempfile.mkdtemp(prefix="gem-vision-"))
        out = work / "www"
        out.mkdir()
        wrong = work / "houseki_vision.js"
        wrong.write_text("console.log('not the vision module');\n")

        for script in (work / "missing.js", wrong):
            with self.subTest(script=script.name), mock.patch.object(make_page, "VISION_SCRIPT", script), \
                    self.assertRaises(SystemExit):
                make_page.install_scanner_vision(out)


if __name__ == "__main__":
    unittest.main()
