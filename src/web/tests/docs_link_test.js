/*
 * docs_link_test.js -- tests for Help > Documentation (T-0236), the app's link to the site's docs
 * page.
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * WHY THESE TESTS
 *   The ticket's rule is that the app's link and the landing page's "Read the documentation" link
 *   come from ONE place: `docs` in src/site/site.json, which make_page.py substitutes for the
 *   landing page's @@DOCS_URL@@ and TopBar.svelte imports (Vite bundles the JSON). The easy way
 *   to break that is to paste the URL into the component as a literal, which would work today and
 *   drift the day the docs move. The link's behaviour itself (the menu opens, the item is an <a>
 *   with target=_blank and rel=noopener, its href resolves to build/www/docs.html) needs a real
 *   browser, and is checked over CDP against the built page; these tests guard the source.
 *
 * HOW
 *   Both files are read as text: site.json is parsed, TopBar.svelte is searched. No Svelte
 *   compiler, no DOM -- the questions are about what the source says, not how it renders.
 */

function assert(condition, message) {
  if (!condition) {
    throw new Error("assertion failed: " + (message || ""));
  }
}

const SITE_JSON = await Deno.readTextFile(new URL("../../site/site.json", import.meta.url));
const TOP_BAR = await Deno.readTextFile(new URL("../src/components/TopBar.svelte", import.meta.url));

// The Help menu's own markup: from its trigger to the end of its dropdown. Tests that ask about
// the Documentation item look only here, so an unrelated "docs" elsewhere cannot satisfy them.
function helpMenuMarkup() {
  const start = TOP_BAR.indexOf('id="menu-button-help"');
  assert(start >= 0, "TopBar.svelte has no Help menu trigger (#menu-button-help)");

  const end = TOP_BAR.indexOf("</Menubar.Content>", start);
  assert(end > start, "the Help menu's dropdown is never closed");

  return TOP_BAR.slice(start, end);
}

Deno.test("site.json's docs link is relative, so it works from file:// and when deployed", () => {
  // Setup: the real src/site/site.json.
  // Test: read its `docs` value.
  // Verifies: it is a non-empty, relative link (no scheme, no leading slash). The app is written
  // beside the docs page in build/www, so a relative link resolves to build/www/docs.html from a
  // file:// page and to the site's own docs page when served; a root-relative "/docs.html" would
  // resolve to the filesystem root from file://. If the docs ever move to an absolute URL this
  // test should be changed deliberately, with the file:// case checked again.
  const { docs } = JSON.parse(SITE_JSON);

  assert(typeof docs === "string" && docs.length > 0, "site.json has no docs link");
  assert(!/^[a-z][a-z0-9+.-]*:/i.test(docs), `docs is absolute (${docs})`);
  assert(!docs.startsWith("/"), `docs is root-relative (${docs}), which breaks from file://`);
});

Deno.test("TopBar takes the docs link from site.json, not from a literal of its own", () => {
  // Setup: TopBar.svelte's source and the real docs value.
  // Test: look for the import of site.json's `docs`, and for the value itself as a literal.
  // Verifies: the component imports `docs` from the same site.json make_page.py reads for the
  // landing page's @@DOCS_URL@@, and never spells the URL out itself -- so changing site.json
  // moves both links at once.
  const { docs } = JSON.parse(SITE_JSON);

  assert(/import\s*\{\s*docs\s+as\s+docsUrl\s*\}\s*from\s*'\.\.\/\.\.\/\.\.\/site\/site\.json'/.test(TOP_BAR),
    "TopBar.svelte does not import docs from site/site.json");
  assert(!TOP_BAR.includes(`"${docs}"`) && !TOP_BAR.includes(`'${docs}'`),
    `TopBar.svelte hard-codes the docs URL (${docs}) as a literal`);
});

Deno.test("Help holds a live Documentation link that opens in a new tab", () => {
  // Setup: the Help menu's markup, cut out of TopBar.svelte.
  // Test: find the Documentation item and its anchor.
  // Verifies: the item is there under its id; it is rendered as an <a> (Bits UI's child snippet)
  // whose href is the imported docsUrl, opening in a new tab with rel=noopener; it is not greyed
  // (no ariaDisabled); and the old "Nothing here yet" empty state is gone.
  const help = helpMenuMarkup();

  assert(help.includes('id="menu-item-documentation"'), "no #menu-item-documentation in Help");
  assert(/<a\s[^>]*href=\{docsUrl\}/.test(help), "the Documentation item's <a> does not use docsUrl");
  assert(/<a\s[^>]*target="_blank"/.test(help), "the Documentation link does not open a new tab");
  assert(/<a\s[^>]*rel="noopener"/.test(help), "the Documentation link has no rel=noopener");
  assert(!help.includes("ariaDisabled"), "an item in Help is greyed out");
  assert(!help.includes("menu-empty") && !help.includes("Nothing here yet"),
    "Help still shows its empty state");
});
