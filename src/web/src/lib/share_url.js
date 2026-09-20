// The URL hash codec (T-0198, the user, 2026-09-19): "instead of actually saving, can you
// record this data in the url hash so when i copy the url and send it to someone else, they
// can see the file immediately and if i go forwards/backward in the website the changes stay".
//
// This module is PURE: it never touches `window`, `document`, `location`, or any `GEM*` or
// `GemCadDesign` global, so `share_url_test.js` can exercise it under `deno test` with no
// browser at all. The caller (`share_state.js`, which does own the browser side -- reading
// `location.hash`, writing it, listening for `hashchange`, and calling `GemCadDesign.toJSON` /
// `.fromJSON`) passes and receives plain data: `encodeHash` takes the already-serialised
// payload fields and returns a hash string; `decodeHash` takes a hash string and returns the
// plain payload object, with `design` still as the plain object `GemCadDesign.toJSON`
// produced -- turning it back into a design (`GemCadDesign.fromJSON`) is the caller's job,
// since that needs the `GemCadDesign` global this module must not touch.

import { base64ToBytes, bytesToBase64, gzipBytes, gunzipBytes } from './inline.js';

/**
 * The website's own save-format version, written into the hash ahead of the payload
 * (`#v=<APP_VERSION>&...`) so it can be READ WITHOUT DECODING ANYTHING -- the user's own
 * words, "to make parsing simple". This is a DIFFERENT number from `GemCadDesign`'s
 * `SCHEMA_VERSION` (design.js): that one versions the design document alone; this one
 * versions the outer payload this module writes -- `{ app, design, material, meta }` -- and
 * the hash format wrapped around it. A shared link therefore carries both, so a reader can
 * tell exactly which of the two might be why it does not understand a link.
 *
 * Bump this only when the PAYLOAD SHAPE changes in a way an older reader cannot read --
 * exactly the rule design.js's own SCHEMA_VERSION comment states for the design document.
 * Adding a field that a missing value defaults sensibly for (as `gear.fractional`, `hidden`
 * and `frosted` did to the design schema with no version bump, see design.js's `toJSON`) is
 * NOT a bump: an older reader ignoring a field it does not know about, or a newer reader
 * defaulting a field an older writer never wrote, is exactly the forward/backward
 * compatibility this scheme exists to provide. A bump is for when an old reader would
 * otherwise load a link into a subtly WRONG stone rather than failing loudly.
 */
export const APP_VERSION = 1;

/**
 * The checksum's own parameter, last in the hash (2026-09-19, the user: "can you add a checksum
 * at the end of the url hash"). It covers EVERYTHING BEFORE IT -- `v=<n>&d=<flag><base64url>`,
 * exactly as those characters appear in the link -- so a damaged version number is caught as
 * readily as a damaged payload.
 *
 * WHAT IT IS FOR. Not tampering: anyone who can rewrite the payload can recompute a CRC, and
 * nothing here pretends otherwise. It is for the way shared links actually break -- a chat client
 * or a mail wrapper truncating a long URL, or mangling a character of it. Before this, such a link
 * failed several steps into the decode with whatever the gzip stream happened to say (measured:
 * "This link's data could not be decompressed: Failed to fetch", which tells the reader nothing
 * useful and sounds like a network error on a page that never touches the network). Now a damaged
 * link is diagnosed as damaged, before anything tries to make sense of it.
 *
 * WHY THIS IS NOT AN `APP_VERSION` BUMP. It is additive in both directions, which is exactly the
 * case APP_VERSION's own rule says is not a bump: a reader that predates the checksum ignores an
 * `&c=` it does not know about (`URLSearchParams` simply never asks for it), and this reader
 * treats a link with no `c=` as one written before the checksum existed and reads it as it always
 * did. Bumping would have cost real compatibility for nothing -- an older build would refuse a
 * v2 link outright, though its payload is byte-identical to the v1 it reads happily.
 *
 * THE ONE GAP, stated rather than hidden: a truncation that happens to cut the link exactly at
 * the `&` before `c=` removes the checksum along with the evidence, and the link then reads as an
 * older, unchecksummed one. Its payload is intact in that case, so it loads correctly anyway --
 * the gap costs a diagnosis nobody needs.
 */
const CHECKSUM_PARAM = 'c';

/**
 * The payload as `#v=<APP_VERSION>&d=<flag><base64url>`.
 *
 * `<flag>` is one character read off the front of `d`'s value, before the base64: `z` for
 * gzip-compressed JSON (`CompressionStream`, matching what the rest of the page inflates with
 * `DecompressionStream`, per the brief's "gzip, not deflate-raw, to stay consistent"), or `j`
 * for plain, uncompressed JSON -- the fallback for a browser old enough to have no
 * `CompressionStream` (mirroring `gunzipBase64`'s own guard for the missing-`DecompressionStream`
 * case). Base64url (`-`/`_`, no `=` padding) rather than plain base64, because `+` and `/`
 * would otherwise sit unencoded in a URL fragment.
 *
 * `state` is `{ design, material, meta }`: `design` is already `GemCadDesign.toJSON(design)`'s
 * plain object (this module never touches the `GemCadDesign` global itself, see the header),
 * `material` is `session.js`'s `materialState()` shape, and `meta` is `{ title, author, date }`
 * off the cut header. Async because compression is a stream.
 */
export async function encodeHash(state) {
  const payload = {
    app: APP_VERSION,
    design: state.design,
    material: state.material,
    meta: state.meta,
  };

  const json = new TextEncoder().encode(JSON.stringify(payload));
  let flag;
  let bytes;

  if (typeof CompressionStream === 'function') {
    flag = 'z';
    bytes = await gzipBytes(json);
  } else {
    flag = 'j';
    bytes = json;
  }

  const body = `v=${APP_VERSION}&d=${flag}${toBase64Url(bytes)}`;

  return `#${body}&${CHECKSUM_PARAM}=${checksumOf(body)}`;
}

/**
 * The reverse of `encodeHash`: a hash string (with or without its leading `#`, so a caller can
 * pass `location.hash` straight through) back to the plain payload object
 * `{ app, design, material, meta }`.
 *
 * The CHECKSUM is verified first, before the version and before anything is decoded, so that a
 * link damaged in transit is reported as damaged rather than as whatever the damage happened to
 * break first (see CHECKSUM_PARAM). A link with no `c=` at all predates the checksum and is read
 * as it always was.
 *
 * Refuses, each with its own message, rather than swallowing anything:
 *   - a hash whose checksum does not match the rest of it;
 *   - a hash with no `v=`, or one that does not parse as an integer;
 *   - a `v` GREATER than this build's `APP_VERSION` -- a link saved by a newer website version,
 *     which may hold a payload shape this build cannot read correctly. A `v` less than or
 *     equal to `APP_VERSION` is accepted: this module's own additive-only bump rule (see
 *     `APP_VERSION`'s comment) guarantees every version up to this one is still readable by
 *     construction. `design`'s OWN version (`design.v`, GemCadDesign's SCHEMA_VERSION) is a
 *     separate check the caller makes when it calls `GemCadDesign.fromJSON`;
 *   - a missing `d=`;
 *   - a `d` whose flag character is neither `z` nor `j`;
 *   - base64url text that does not decode;
 *   - `z`-flagged bytes that do not inflate as gzip;
 *   - text that is not valid JSON;
 *   - a decoded payload that is not a plain object (an array, a string, a number, `null`...).
 */
export async function decodeHash(hash) {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;

  // `&c=` is found by searching from the END: the checksum is always the last parameter, and
  // base64url text cannot contain `&` or `=` (the alphabet is A-Z a-z 0-9 - _, and the padding is
  // stripped), so this can never cut into the payload.
  const marker = `&${CHECKSUM_PARAM}=`;
  const at = withoutHash.lastIndexOf(marker);

  if (at !== -1) {
    const body = withoutHash.slice(0, at);
    const found = withoutHash.slice(at + marker.length);
    const wanted = checksumOf(body);

    if (found !== wanted) {
      throw new Error(
        'This link is damaged or incomplete: its checksum does not match the rest of it ' +
        `(the link says ${found || '(nothing)'}, its contents come to ${wanted}). It was ` +
        'probably cut short or altered on the way here -- try copying the whole link again.'
      );
    }
  }

  const params = new URLSearchParams(withoutHash);

  const vText = params.get('v');

  if (vText === null) {
    throw new Error('This link has no "v=" version, so it is not a saved design.');
  }

  const v = Number(vText);

  if (!Number.isInteger(v)) {
    throw new Error(`This link's version ("${vText}") is not a whole number.`);
  }

  if (v > APP_VERSION) {
    throw new Error(
      `This link was saved by a newer version of the page (v${v}); this build only reads up ` +
      `to v${APP_VERSION}. Open it in a newer build, or re-save it from this one.`
    );
  }

  const d = params.get('d');

  if (d === null || d.length === 0) {
    throw new Error('This link has no "d=" data, so there is nothing to restore.');
  }

  const flag = d[0];
  const body = d.slice(1);

  if (flag !== 'z' && flag !== 'j') {
    throw new Error(`This link's data has an unknown encoding flag ("${flag}").`);
  }

  let bytes;

  try {
    bytes = fromBase64Url(body);
  } catch (cause) {
    throw new Error(`This link's data is not valid base64: ${cause.message || cause}`);
  }

  if (flag === 'z') {
    try {
      bytes = await gunzipBytes(bytes);
    } catch (cause) {
      throw new Error(`This link's data could not be decompressed: ${cause.message || cause}`);
    }
  }

  let json;

  try {
    json = new TextDecoder().decode(bytes);
  } catch (cause) {
    throw new Error(`This link's data is not valid text: ${cause.message || cause}`);
  }

  let payload;

  try {
    payload = JSON.parse(json);
  } catch (cause) {
    throw new Error(`This link's data is not valid JSON: ${cause.message || cause}`);
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('This link does not hold a saved design.');
  }

  return payload;
}

/**
 * The checksum of a hash's body, as eight lowercase hex digits: CRC-32 (the IEEE polynomial,
 * reflected, `0xEDB88320`), over the body's characters as UTF-8.
 *
 * CRC-32 rather than a hash from `crypto.subtle`: this needs to detect truncation and mangling,
 * which a 32-bit CRC does about as well as anything (it catches every burst error up to 32 bits,
 * and all but one in 4 billion of everything else), and it needs to run synchronously in eight
 * lines with no dependency. `crypto.subtle` would drag in a promise, a secure-context requirement
 * this `file://` page should not have to reason about, and a 64-character digest to spend URL
 * budget on -- all to resist tampering that the URL's own visibility makes pointless anyway.
 *
 * Exported because it is the only way for a caller -- the tests, or a future "share this" button
 * that wants to build a link without going through `encodeHash` -- to produce a hash this module
 * will accept.
 */
export function checksumOf(text) {
  const bytes = new TextEncoder().encode(text);
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit++) {
      // `>>> 1` keeps the shift unsigned; the polynomial is applied only when the low bit was set.
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  // `>>> 0` turns the signed 32-bit result back into the unsigned value the standard defines.
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

/** Bytes to URL-safe base64: `+`/`/` become `-`/`_`, and the `=` padding is dropped. */
function toBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `toBase64Url`'s inverse: puts the padding back before handing off to plain base64. */
function fromBase64Url(text) {
  const restored = text.replace(/-/g, '+').replace(/_/g, '/');
  const pad = restored.length % 4 === 0 ? '' : '='.repeat(4 - (restored.length % 4));

  return base64ToBytes(restored + pad);
}
