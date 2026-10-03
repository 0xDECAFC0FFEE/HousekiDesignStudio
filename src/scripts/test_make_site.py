"""Tests for make_page.build_site, which writes the landing page (build/www/index.html), the
user documentation (build/www/docs.html and build/www/docs/), robots.txt and sitemap.xml from
src/site/.

Each test points make_page at a temporary site.json and output directory, so the real
build/www/ is never touched, and reads the real src/site/index.html as its source. No browser,
no Deno: these run under the default python3.

Run with:

    python3 -m unittest discover -s src/scripts -v
"""

import json
import pathlib
import shutil
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


class BuildSiteTest(unittest.TestCase):
    def build(self, config):
        """Runs build_site with `config` as site.json, into a fresh temporary directory.
        Returns that directory, as a Path, and the paths build_site reported writing."""
        work = pathlib.Path(tempfile.mkdtemp(prefix="gem-site-"))
        config_path = work / "site.json"
        config_path.write_text(json.dumps(config))
        out = work / "www"
        out.mkdir()

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
        self.assertIn('href="docs.html"', page)
        self.assertIn('href="studio.html"', page)

        ld = page.split('<script type="application/ld+json">', 1)[1].split("</script>", 1)[0]
        self.assertEqual(json.loads(ld)["name"], "Houseki Design Studio")

        self.assertEqual((out / "robots.txt").read_text(), "User-agent: *\nAllow: /\n")
        self.assertFalse((out / "sitemap.xml").exists())
        self.assertIn(out / "docs.html", written)

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

        ld = page.split('<script type="application/ld+json">', 1)[1].split("</script>", 1)[0]
        self.assertEqual(json.loads(ld)["url"], url + "studio.html")

        self.assertIn(f"Sitemap: {url}sitemap.xml", (out / "robots.txt").read_text())
        sitemap = (out / "sitemap.xml").read_text()
        self.assertIn(f"<loc>{url}</loc>", sitemap)
        self.assertIn(f"<loc>{url}studio.html</loc>", sitemap)
        self.assertIn(f"<loc>{url}docs.html</loc>", sitemap)
        self.assertIn(f"<loc>{url}docs/getting-started.html</loc>", sitemap)

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


if __name__ == "__main__":
    unittest.main()
