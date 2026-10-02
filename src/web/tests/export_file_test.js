/*
 * export_file_test.js -- tests for src/web/src/lib/export_file.js's `downloadFile`, the download
 * every save falls back to where the browser has no Save As dialog (Firefox, Safari): File >
 * Export's four formats and Tools > Record rendering's video (T-0297).
 *
 * HOW TO RUN (from src/web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * There is no page here: `document`, `setTimeout` and `URL`'s blob-URL calls are stood in for,
 * each recording what it is asked, and put back afterwards.
 */

import { downloadFile, REVOKE_AFTER_MS } from "../src/lib/export_file.js";

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

Deno.test("a download keeps its blob URL alive until well after the click", async () => {
  // Setup: stand-ins for the page -- `document` makes one link and records its click and its
  // removal, `URL.createObjectURL` hands out "blob:1" and remembers the blob, `revokeObjectURL`
  // records every URL let go, and `setTimeout` keeps each timer and its delay rather than running
  // it -- and a video-sized Blob (3 MB).
  // Test: downloadFile the video, look at what happened by the end of the call, then run the
  // timers it queued.
  // Verifies: the link carries the blob's URL and the file name and is clicked, then removed;
  // the URL is NOT revoked by the time the call returns -- a click only starts a download, and a
  // browser that has not read the blob before its URL is revoked can save nothing, which the old
  // code risked by revoking on the next line -- but is revoked by a timer REVOKE_AFTER_MS
  // (a minute) later, so the blob is not kept for ever.
  const saved = {
    setTimeout: globalThis.setTimeout, document: globalThis.document,
    create: URL.createObjectURL, revoke: URL.revokeObjectURL,
  };
  const events = [];
  const timers = [];
  const blobs = [];

  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  URL.createObjectURL = blob => { blobs.push(blob); return "blob:1"; };
  URL.revokeObjectURL = url => events.push(["revoke", url]);
  globalThis.document = {
    body: { appendChild: () => events.push(["append"]) },
    createElement: () => {
      const link = {
        click: () => events.push(["click", link.href, link.download]),
        remove: () => events.push(["remove"]),
      };

      return link;
    },
  };

  try {
    const video = new Blob([new Uint8Array(3_000_000)], { type: "video/mp4" });

    downloadFile("hex recording.mp4", video, "video/mp4");

    assertEqual(blobs.length, 1, "one blob URL made");
    assert(blobs[0] === video, "for the video itself");
    assertEqual(events, [["append"], ["click", "blob:1", "hex recording.mp4"], ["remove"]], "clicked under its name, then removed");
    assert(!events.some(([kind]) => kind === "revoke"), "the URL is still alive when the call returns");
    assertEqual(timers.map(timer => timer.ms), [REVOKE_AFTER_MS], "one timer, to let it go later");
    assert(REVOKE_AFTER_MS >= 30_000, "and later is tens of seconds, not a moment");

    timers.forEach(timer => timer.fn());
    assertEqual(events[events.length - 1], ["revoke", "blob:1"], "then it is let go");
  } finally {
    globalThis.setTimeout = saved.setTimeout;
    globalThis.document = saved.document;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  }
});
