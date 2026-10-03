// The public Nostr relays the phone scanner signals through (T-0316, 2026-10-02).
//
// Both ends of a session (the studio and the phone page) use this same list, so they always meet
// on the same relays; a link with `s=` (the tests' local relay) replaces it.
//
// Why a pinned list rather than Trystero's own. Trystero 0.25.4 picks 5 of its 28 default relays,
// shuffled with a seed from the app id, so every Houseki session in the world used the same five:
// nostr.data.haus, yabu.me/v2, strfry.shock.network, relay.mostro.network and
// relay-rpi.edufeed.org. Measured on 2026-10-02 (tests/harness/nostr_relay_probe.js), two of the
// five refuse Trystero's events outright (relay-rpi.edufeed.org: "blocked: ephemeral kinds are not
// accepted on this relay"; strfry.shock.network: OK false with no reason), and Trystero retires
// both. Of all 28 defaults, 10 were unusable that day: down, refusing ephemeral events, out of
// disk, or accepting events without ever delivering them. A session therefore rested on whichever
// of a fixed five happened to be healthy, with nothing the studio could do about it.
//
// How these were chosen. Each passed nostr_relay_probe.js in every round on 2026-10-02: it
// accepted a burst of 15 signed events of the ephemeral kind Trystero uses (20000-29999), with its
// "x" tag, from one new key, and delivered every one live to a subscriber on another connection.
// The burst matters: nostr.bitcoiner.social and offchain.pub passed a one-event probe, then in a
// real session refused later events ("Policy violated and pubkey is not in our web of trust"),
// and Trystero retires a relay at its first refusal, so they were dropped. The eight are run by
// different operators, so one outage costs one relay of eight. Trystero sends every signal to
// every relay, so any one of them working on both ends is enough.
//
// To re-check (do so if pairing gets slow or fails, or before a release):
//   deno run --allow-net --allow-read tests/harness/nostr_relay_probe.js
// probes this list beside Trystero's defaults and a few other large relays; replace any relay that
// fails with one that passes repeatedly. kb/phone-scanner-pairing-trystero-over-nostr-the-pa.md
// has the details.

/** The relays both ends use when the link names none. */
export const SCAN_RELAY_URLS = Object.freeze([
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://nostr.mom',
  'wss://nostr.oxtr.dev',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.net',
  'wss://yabu.me/v2',
  'wss://relay.mostro.network',
]);
