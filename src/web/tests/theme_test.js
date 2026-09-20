/*
 * theme_test.js -- tests for site/theme.js, the light/dark choice every page of the site shares
 * (the app, the landing page and the docs page).
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * HOW
 *   theme.js is a classic script that runs against `document` and `localStorage` the moment it is
 *   evaluated, so each test builds a small fake of both (just what the script touches: the cookie
 *   string, <html>'s dataset, class list and style, the two <meta>s and the toggles), installs
 *   them on globalThis, and evaluates the script exactly as a page's <head> would. The real page
 *   behaviour (clicks, the icons, file:// vs http://) is checked over CDP against the built pages.
 */

function assert(condition, message) {
  if (!condition) {
    throw new Error("assertion failed: " + (message || ""));
  }
}

function assertEquals(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error("assertion failed: " + (message || "") + "\n  actual:   " + a + "\n  expected: " + e);
  }
}

const SOURCE = await Deno.readTextFile(new URL("../../site/theme.js", import.meta.url));

/**
 * A fake page: `cookie` is what document.cookie reads back (a page from file:// keeps none, so a
 * test of that passes cookiesWork: false), `stored` the localStorage contents. Returns the fakes,
 * so a test can read what the script did to them, and `click(target)`, which runs the script's
 * document click handler as a click on `target` would.
 */
function fakePage({ cookie = "", stored = {}, cookiesWork = true } = {}) {
  const classes = new Set(["dark"]);
  const metas = {
    'meta[name="theme-color"]': { content: "#2e3440", setAttribute(_, v) { this.content = v; } },
    'meta[name="color-scheme"]': { content: "dark light", setAttribute(_, v) { this.content = v; } },
  };
  const toggle = {
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    closest: selector => (selector === "[data-theme-toggle]" ? toggle : null),
  };
  const handlers = {};
  const writtenCookies = [];

  const document = {
    documentElement: {
      dataset: {},
      style: {},
      classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    },
    querySelector: selector => metas[selector] || null,
    querySelectorAll: selector => (selector === "[data-theme-toggle]" ? [toggle] : []),
    addEventListener: (type, handler) => { handlers[type] = handler; },
    get cookie() { return cookie; },
    set cookie(line) {
      writtenCookies.push(line);

      if (cookiesWork) {
        cookie = line.split(";")[0];
      }
    },
  };
  const localStorage = {
    getItem: key => (key in stored ? stored[key] : null),
    setItem: (key, value) => { stored[key] = String(value); },
  };

  // `instanceof Element` in the click handler: the fake toggle has to be one.
  globalThis.Element = function Element() {};
  Object.setPrototypeOf(toggle, globalThis.Element.prototype);
  globalThis.document = document;
  // Defined rather than assigned: Deno has a localStorage of its own, which assignment leaves in
  // place.
  Object.defineProperty(globalThis, "localStorage", { value: localStorage, configurable: true, writable: true });
  (0, eval)(SOURCE);

  return {
    document, stored, classes, metas, toggle, writtenCookies, theme: globalThis.HousekiTheme,
    click: target => handlers.click({ target }),
    loaded: () => handlers.DOMContentLoaded(),
  };
}

Deno.test("with nothing saved the page is dark, the site's default", () => {
  // Setup and test: a first visit, no cookie and nothing stored.
  const page = fakePage();

  // Verifies: data-theme is dark, <html> keeps the `dark` class the components' dark: variants
  // need, the browser bar colour is nord0, and nothing was saved merely by loading.
  assertEquals(page.document.documentElement.dataset.theme, "dark");
  assert(page.classes.has("dark"), "the dark class stays");
  assertEquals(page.metas['meta[name="theme-color"]'].content, "#2e3440");
  assertEquals(page.writtenCookies, [], "loading saves nothing");
});

Deno.test("a saved light cookie makes the page light before it is drawn", () => {
  // Setup: a cookie from an earlier visit, among others, as document.cookie lists them.
  const page = fakePage({ cookie: "other=1; houseki-theme=light; more=x" });

  // Verifies: applied as the script ran (it runs in <head>): light data-theme, no `dark` class,
  // color-scheme light (so native scrollbars and form controls turn light too), the bar nord6.
  assertEquals(page.document.documentElement.dataset.theme, "light");
  assert(!page.classes.has("dark"), "the dark class is removed");
  assertEquals(page.document.documentElement.style.colorScheme, "light");
  assertEquals(page.metas['meta[name="theme-color"]'].content, "#eceff4");
  assertEquals(page.metas['meta[name="color-scheme"]'].content, "light");
});

Deno.test("the cookie wins over localStorage; localStorage is used when there is no cookie", () => {
  // Setup: two pages. One has both saved, disagreeing (the cookie is what the user asked for, so
  // it decides); the other only localStorage, as a page opened from file:// would, where no
  // cookie can be kept.
  const both = fakePage({ cookie: "houseki-theme=dark", stored: { "houseki.theme": "light" } });
  const bothTheme = both.theme.current();
  const fileUrl = fakePage({ stored: { "houseki.theme": "light" }, cookiesWork: false });

  // Verifies: the cookie's dark on the first, the stored light on the second.
  assertEquals(bothTheme, "dark");
  assertEquals(fileUrl.theme.current(), "light");
});

Deno.test("a click on a toggle switches the theme and saves it in a cookie and in localStorage", () => {
  // Setup: a dark page whose HTML toggle has been marked once the page was parsed.
  const page = fakePage();
  page.loaded();
  assertEquals(page.toggle.attributes["aria-pressed"], "false", "not pressed while dark");

  // Test: click the toggle, then click it again.
  page.click(page.toggle);
  const afterFirst = {
    theme: page.document.documentElement.dataset.theme,
    pressed: page.toggle.attributes["aria-pressed"],
    cookie: page.writtenCookies.at(-1),
    stored: page.stored["houseki.theme"],
  };
  page.click(page.toggle);

  // Verifies: the first click made the page light, pressed the toggle, and wrote a year-long,
  // site-wide cookie (Path=/, so the landing page, the docs and the app share it) and the
  // localStorage copy a file:// page relies on; the second click went back to dark and saved that.
  assertEquals(afterFirst, {
    theme: "light",
    pressed: "true",
    cookie: "houseki-theme=light; Max-Age=31536000; Path=/; SameSite=Lax",
    stored: "light",
  });
  assertEquals(page.document.documentElement.dataset.theme, "dark");
  assert(page.classes.has("dark"), "dark again");
  assertEquals(page.stored["houseki.theme"], "dark");
});

Deno.test("a corrupt saved value is ignored, and a click elsewhere does nothing", () => {
  // Setup: a cookie and a stored value that are neither theme.
  const page = fakePage({ cookie: "houseki-theme=purple", stored: { "houseki.theme": "blue" } });

  // Test: a click on something that is not a toggle, and set() with a bad name.
  page.click({ closest: () => null, __proto__: globalThis.Element.prototype });
  page.theme.set("sepia");

  // Verifies: the default dark, unchanged and unsaved; and parseCookie reads only its own name.
  assertEquals(page.theme.current(), "dark");
  assertEquals(page.writtenCookies, []);
  assertEquals(page.theme.parseCookie("xhouseki-theme=light; houseki-theme=light"), "light");
  assertEquals(page.theme.parseCookie(""), null);
});
