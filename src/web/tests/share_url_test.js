/*
 * share_url_test.js -- tests for web/src/lib/share_url.js, the URL hash codec T-0198 built at
 * the user's request (2026-09-19): "record this data in the url hash so when i copy the url
 * and send it to someone else, they can see the file immediately".
 *
 * share_url.js is deliberately pure (no window/document/location/GemCadDesign), so it is
 * tested here exactly as written -- no page, no wasm, no browser. `share_state.js`, which
 * wires this codec to the real page (writing on every edit-history change, reading
 * location.hash, calling GemCadDesign.toJSON/fromJSON), is exercised separately over CDP
 * against the built page (see check_save_hash.py), because that half genuinely needs a
 * browser.
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 */

import { encodeHash, decodeHash, checksumOf, APP_VERSION } from "../src/lib/share_url.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

/**
 * A design shaped like a real one, with a tier of each interesting flag combination
 * (frosted, hidden, preform) so the round trip exercises everything toJSON/fromJSON carry
 * per tier, not just a trivial one-tier design. Shaped exactly like
 * `GemCadDesign.toJSON`'s own output (design.js), which is what share_url.js is handed in
 * practice -- this module never calls GemCadDesign itself, so the test builds that shape by
 * hand instead of importing the GemCad scripts.
 */
function sampleDesignJson() {
  return {
    v: 1,
    name: "Test Round Trip",
    gear: { teeth: 96, reversed: false, originIndex: 0, fractional: false },
    symmetry: { folds: 6, mirror: true },
    refractiveIndex: 2.16,
    tiers: [
      {
        angle: 45, distance: 1, preform: false, hidden: false, frosted: true,
        cuttingInstructions: "Crown main facets",
        facets: [{ index: 0, name: "C1" }, { index: 16, name: "C2" }],
      },
      {
        angle: -45, distance: 1.2, preform: true, hidden: true, frosted: false,
        cuttingInstructions: "Pavilion preform, hidden",
        facets: [{ index: 8, name: "P1" }],
      },
    ],
    headers: ["H Test Round Trip"],
    footnotes: [],
  };
}

function sampleMaterial() {
  return {
    preset: "Cubic Zirconia",
    refractiveIndex: 2.16,
    dispersion: 0.058,
    stoneColor: [0.9, 0.1, 0.2],
    stoneOpacity: 0.5,
  };
}

function sampleMeta() {
  return { title: "Test Round Trip", author: "0xdecafc0ffee", date: "September 2026" };
}

Deno.test("a real-shaped design, material and meta round-trip through the hash exactly", async () => {
  // Setup: a design with a frosted tier and a hidden+preform tier (the two flag combinations
  // the brief calls out), plus a material and cut-header metadata.
  // Test: encode to a hash string, then decode it straight back.
  // Verifies: every field survives byte-for-byte -- JSON.stringify of the decoded payload
  // equals JSON.stringify of what was encoded, which is stricter than spot-checking fields
  // and so also catches a dropped or reordered key.
  const state = { design: sampleDesignJson(), material: sampleMaterial(), meta: sampleMeta() };
  const hash = await encodeHash(state);

  assert(hash.startsWith(`#v=${APP_VERSION}&d=`), `hash starts with the readable version: ${hash}`);

  const decoded = await decodeHash(hash);

  assert(decoded.app === APP_VERSION, "the payload's own app field matches APP_VERSION");
  assert(
    JSON.stringify(decoded.design) === JSON.stringify(state.design),
    "the design round-trips exactly"
  );
  assert(
    JSON.stringify(decoded.material) === JSON.stringify(state.material),
    "the material round-trips exactly"
  );
  assert(
    JSON.stringify(decoded.meta) === JSON.stringify(state.meta),
    "the meta round-trips exactly"
  );
});

Deno.test("the plain-JSON 'j' flag round-trips too, not only the gzip 'z' path", async () => {
  // Setup: the same state as above, but encoded by hand with the 'j' (uncompressed) flag,
  // exactly as encodeHash itself would if CompressionStream were unavailable -- this test
  // does not touch that global at all, so it stays independent of whether the CI runtime
  // happens to provide CompressionStream.
  // Test: decode the hand-built 'j' hash.
  // Verifies: decodeHash's plain-JSON branch (no inflate step) reads back the same payload
  // the compressed branch does, so a browser old enough to lack CompressionStream still gets
  // a working, if larger, save.
  const state = { design: sampleDesignJson(), material: sampleMaterial(), meta: sampleMeta() };
  const payload = { app: APP_VERSION, design: state.design, material: state.material, meta: state.meta };
  const json = JSON.stringify(payload);
  const base64url = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const hash = `#v=${APP_VERSION}&d=j${base64url}`;

  const decoded = await decodeHash(hash);

  assert(JSON.stringify(decoded) === JSON.stringify(payload), "the 'j' flag round-trips exactly");
});

Deno.test("a hash from a future website version is refused, not guessed at", async () => {
  // Setup: encode a real state, then hand-bump the "v=" the way a future website version's
  // own encodeHash would have written it -- one more than this build's APP_VERSION.
  // Test: decode it.
  // Verifies: decodeHash throws, and the message says which versions are involved, rather
  // than silently reading a payload shape this build was never checked against (the brief's
  // very reason for including a version at all: "a shared URL from a future version would
  // otherwise load as a subtly wrong stone").
  //
  // The checksum is RECOMPUTED after bumping the version, because that is what a real future
  // writer would have produced: a link whose checksum is perfectly valid and whose version this
  // build still cannot read. Leaving the old checksum in place would have tested the checksum
  // instead -- and would have passed for the wrong reason, since the checksum is verified first.
  const state = { design: sampleDesignJson(), material: sampleMaterial(), meta: sampleMeta() };
  const hash = await encodeHash(state);
  const body = hash.slice(1, hash.lastIndexOf("&c="))
    .replace(`v=${APP_VERSION}`, `v=${APP_VERSION + 1}`);
  const bumped = `#${body}&c=${checksumOf(body)}`;

  let threw = null;

  try {
    await decodeHash(bumped);
  } catch (cause) {
    threw = cause;
  }

  assert(threw !== null, "a future version is refused");
  assert(/newer/i.test(threw.message), `the message explains why: ${threw && threw.message}`);
});

Deno.test("a corrupted payload is refused with a clear message, not swallowed", async () => {
  // Setup: a valid hash with its base64 body mangled (one character flipped into another that
  // is still a legal base64url character, so the corruption survives the base64 decode step
  // and only shows up when the gzip stream tries to inflate it).
  // Test: decode it.
  // Verifies: decodeHash throws rather than returning a garbage object or a JS-level
  // exception with no context -- the brief's "each with its own clear message, thrown, not
  // swallowed".
  const state = { design: sampleDesignJson(), material: sampleMaterial(), meta: sampleMeta() };
  const hash = await encodeHash(state);

  // The body is everything after "d=z"; flip a character in the middle of it so the gzip
  // header/checksum machinery notices, wherever the flip lands.
  const marker = "d=z";
  const at = hash.indexOf(marker) + marker.length;
  const bodyMidpoint = at + Math.floor((hash.length - at) / 2);
  const flipped = hash[bodyMidpoint] === "A" ? "B" : "A";
  const corrupted = hash.slice(0, bodyMidpoint) + flipped + hash.slice(bodyMidpoint + 1);

  let threw = null;

  try {
    await decodeHash(corrupted);
  } catch (cause) {
    threw = cause;
  }

  assert(threw !== null, "a corrupted payload is refused");
  assert(/damaged or incomplete/i.test(threw.message),
    `the checksum catches it first, and says so plainly: ${threw && threw.message}`);
});

Deno.test("the checksum is the last thing in the hash, and covers everything before it", async () => {
  // Setup: a real encoded hash.
  // Test: read its shape, and recompute the checksum over the body by hand.
  // Verifies the user's own request ("a checksum at the end of the url hash") literally: it is
  // last, it is eight hex digits, and it is the checksum of `v=...&d=...` exactly as those
  // characters appear -- so a damaged version number is caught as readily as a damaged payload.
  const state = { design: sampleDesignJson(), material: sampleMaterial(), meta: sampleMeta() };
  const hash = await encodeHash(state);
  const at = hash.lastIndexOf("&c=");

  assert(at !== -1, `the hash carries a checksum: ${hash}`);

  const body = hash.slice(1, at);
  const found = hash.slice(at + 3);

  assert(/^[0-9a-f]{8}$/.test(found), `eight lowercase hex digits, got ${found}`);
  assert(found === checksumOf(body), "it is the checksum of everything before it");
  assert(body.startsWith(`v=${APP_VERSION}&d=`), `the body is the version and the data: ${body}`);

  // And it still decodes, i.e. the checksum this build writes is one it accepts.
  const decoded = await decodeHash(hash);

  assert(decoded.app === APP_VERSION, "a freshly written hash passes its own checksum");
});

Deno.test("a truncated link is refused as damaged, which is how shared links actually break", async () => {
  // Setup: a valid hash cut short the way a chat client or a mail wrapper cuts a long URL --
  // three lengths, so this does not depend on where the cut happens to land.
  // Test: decode each.
  // Verifies the checksum's whole purpose. Note what this replaces: before the checksum, a
  // truncated link failed inside the gzip stream with "could not be decompressed: Failed to
  // fetch" -- a message that names neither the cause nor anything the reader can act on, and
  // that sounds like a network failure on a page which never uses the network.
  const state = { design: sampleDesignJson(), material: sampleMaterial(), meta: sampleMeta() };
  const hash = await encodeHash(state);

  for (const keep of [0.25, 0.5, 0.9]) {
    const truncated = hash.slice(0, Math.floor(hash.length * keep));
    let threw = null;

    try {
      await decodeHash(truncated);
    } catch (cause) {
      threw = cause;
    }

    assert(threw !== null, `a link cut to ${keep * 100}% is refused`);
  }

  // A cut that lands inside the checksum itself, leaving the payload whole: still refused, since
  // what arrived does not match what the contents come to.
  const clipped = hash.slice(0, hash.length - 2);
  let threw = null;

  try {
    await decodeHash(clipped);
  } catch (cause) {
    threw = cause;
  }

  assert(threw !== null, "a link missing the end of its checksum is refused");
  assert(/damaged or incomplete/i.test(threw.message), `with the damaged-link message: ${threw && threw.message}`);
});

Deno.test("a link written before the checksum existed is still read", async () => {
  // Setup: a valid hash with its `&c=...` removed entirely -- byte for byte what this module
  // wrote before today, and what an older build still writes.
  // Test: decode it.
  // Verifies the compatibility claim APP_VERSION's comment rests on, and the reason adding the
  // checksum was NOT a version bump: a hash with no checksum is read exactly as it always was,
  // rather than being refused for lacking something it could not have had.
  const state = { design: sampleDesignJson(), material: sampleMaterial(), meta: sampleMeta() };
  const hash = await encodeHash(state);
  const withoutChecksum = hash.slice(0, hash.lastIndexOf("&c="));

  const decoded = await decodeHash(withoutChecksum);

  assert(
    JSON.stringify(decoded.design) === JSON.stringify(state.design),
    "an unchecksummed link still decodes to the same design"
  );
});

Deno.test("checksumOf matches the published CRC-32 test vectors", () => {
  // Setup: the standard IEEE CRC-32 check values, which every implementation of this algorithm
  // agrees on.
  // Test: checksumOf on each.
  // Verifies that this is really CRC-32 and not merely some self-consistent hash of its own --
  // the round-trip tests above would pass just as happily with a wrong polynomial, a missing
  // final inversion, or a signedness bug, because they only ever compare this code against
  // itself. These vectors are the only thing here that could catch such a mistake, and they are
  // what makes the checksum reproducible by anything outside this file.
  const vectors = [
    ["", "00000000"],
    ["a", "e8b7be43"],
    ["abc", "352441c2"],
    ["123456789", "cbf43926"],
    ["The quick brown fox jumps over the lazy dog", "414fa339"],
  ];

  for (const [text, expected] of vectors) {
    const actual = checksumOf(text);

    assert(actual === expected, `crc32(${JSON.stringify(text)}): expected ${expected}, got ${actual}`);
  }
});

Deno.test("a hash with no 'd=' is refused", async () => {
  // Setup: a hash carrying only the version, no data at all -- e.g. a link truncated in
  // transit, or typed by hand.
  // Test: decode it.
  // Verifies: a clear, specific refusal ("no d= data"), not a confusing failure several
  // steps further into the decode (a base64 or JSON error that would not point at the real
  // cause).
  let threw = null;

  try {
    await decodeHash(`#v=${APP_VERSION}`);
  } catch (cause) {
    threw = cause;
  }

  assert(threw !== null, "a missing d= is refused");
  assert(/d=/.test(threw.message), `the message names the missing part: ${threw && threw.message}`);
});

Deno.test("decodeHash accepts the hash with or without its leading '#'", async () => {
  // Setup: a valid hash.
  // Test: decode it both as `location.hash` would hand it over (leading '#') and without one
  // (in case a caller strips it, e.g. reading it back out of a stored string).
  // Verifies: both decode to the identical payload -- the leading '#' is optional syntax, not
  // load-bearing data.
  const state = { design: sampleDesignJson(), material: sampleMaterial(), meta: sampleMeta() };
  const hash = await encodeHash(state);

  const withHash = await decodeHash(hash);
  const withoutHash = await decodeHash(hash.slice(1));

  assert(JSON.stringify(withHash) === JSON.stringify(withoutHash), "the '#' makes no difference");
});
