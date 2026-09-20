/*
 * theme.js -- the light/dark choice, shared by every page of the site (2026-09-19, the user's
 * request): the app, the landing page and the documentation page. make_page.py inlines it in each
 * page's <head>, as a classic script, so it runs before the body is drawn and a light page never
 * flashes dark first. The light palette and the toggle's look are site/theme.css.
 *
 * WHAT IT DOES
 *   - Reads the saved theme and sets <html data-theme="light|dark">, the `dark` class the app's
 *     shadcn-svelte components key their `dark:` variants on, the page's color-scheme, and its
 *     theme-color and color-scheme <meta>s.
 *   - Handles a click on any [data-theme-toggle] anywhere in the page, whenever it was drawn (the
 *     app's toggle appears only once Svelte has mounted), by delegation on the document.
 *   - Publishes globalThis.HousekiTheme = { current, set, toggle, read, parseCookie }.
 *
 * WHERE THE CHOICE IS KEPT
 *   A cookie, as the user asked: `houseki-theme`, a year long, Path=/, so the landing page, the
 *   docs and the app share one choice on the same site. ALSO localStorage (`houseki.theme`),
 *   because a page opened from file:// cannot keep a cookie at all (web/src/lib/settings.js has
 *   the measurement), and the app is made to open from file://. Reading prefers the cookie.
 */
(function () {
  'use strict';

  const COOKIE = 'houseki-theme';
  const STORAGE = 'houseki.theme';
  const ONE_YEAR = 60 * 60 * 24 * 365;

  // The browser's own bar colour for each theme: the page's --panel.
  const THEME_COLOR = { dark: '#2e3440', light: '#eceff4' };

  function isTheme(value) {
    return value === 'dark' || value === 'light';
  }

  /** The theme a `document.cookie` string names, or null. */
  function parseCookie(cookieText) {
    for (const part of String(cookieText || '').split(';')) {
      const [name, ...rest] = part.trim().split('=');

      if (name === COOKIE) {
        const value = rest.join('=');
        return isTheme(value) ? value : null;
      }
    }

    return null;
  }

  /** The saved theme: the cookie's, else localStorage's, else dark, the site's default. */
  function read(doc, storage) {
    const fromCookie = parseCookie(doc.cookie);

    if (fromCookie) {
      return fromCookie;
    }

    try {
      const stored = storage && storage.getItem(STORAGE);

      if (isTheme(stored)) {
        return stored;
      }
    } catch (cause) {
      // Storage can throw (private modes, blocked site data); the default is fine then.
    }

    return 'dark';
  }

  function save(doc, storage, theme) {
    doc.cookie = `${COOKIE}=${theme}; Max-Age=${ONE_YEAR}; Path=/; SameSite=Lax`;

    try {
      storage && storage.setItem(STORAGE, theme);
    } catch (cause) {
      // As in read: losing the saved choice is not worth breaking the page over.
    }
  }

  function apply(doc, theme) {
    const root = doc.documentElement;

    root.dataset.theme = theme;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;

    const themeColor = doc.querySelector('meta[name="theme-color"]');
    const colorScheme = doc.querySelector('meta[name="color-scheme"]');

    if (themeColor) {
      themeColor.setAttribute('content', THEME_COLOR[theme]);
    }

    if (colorScheme) {
      colorScheme.setAttribute('content', theme);
    }

    // aria-pressed says whether light mode is on; the icons follow data-theme through CSS.
    for (const toggle of doc.querySelectorAll('[data-theme-toggle]')) {
      toggle.setAttribute('aria-pressed', String(theme === 'light'));
    }
  }

  const doc = globalThis.document;
  const storage = (() => {
    try {
      return globalThis.localStorage;
    } catch (cause) {
      return null;
    }
  })();

  let current = read(doc, storage);

  function set(theme) {
    if (!isTheme(theme)) {
      return;
    }

    current = theme;
    save(doc, storage, theme);
    apply(doc, theme);
  }

  function toggle() {
    set(current === 'light' ? 'dark' : 'light');
  }

  apply(doc, current);

  doc.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('[data-theme-toggle]')) {
      toggle();
    }
  });

  // The toggles in the page's own HTML exist only once it is parsed; mark them pressed or not.
  doc.addEventListener('DOMContentLoaded', () => apply(doc, current));

  globalThis.HousekiTheme = {
    current: () => current,
    set,
    toggle,
    read: () => read(doc, storage),
    parseCookie,
  };
})();
