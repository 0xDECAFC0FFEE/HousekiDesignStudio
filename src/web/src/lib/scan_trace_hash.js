// A topic name as Trystero makes one (its crypto.mjs `sha1`): the SHA-1 of the text, each of the 20
// bytes written in base 36 with no padding, joined. Not hex: scan_trace.js must match it exactly to
// recognise the room's and this device's topics on the relay sockets.

/** Trystero's topic for `text`. */
export async function trysteroTopic(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(36)).join('');
}
