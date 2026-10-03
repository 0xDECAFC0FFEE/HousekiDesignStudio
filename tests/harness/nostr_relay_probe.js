// Checks which public Nostr relays carry the phone scanner's signaling (T-0316).
//
// Trystero's Nostr strategy (0.25.4) sends every announcement, offer, answer and ICE candidate as a
// signed Nostr event of an EPHEMERAL kind, 20000 + (a hash of the topic mod 10000), tagged
// ["x", <topic>], and subscribes with a REQ filter of {kinds, since, "#x"}. A relay is only useful
// to it if it does all three of: accept the websocket, accept that event (answer OK true), and
// forward it live to a subscriber on ANOTHER connection. Many public relays fail one of them: some
// are down, some refuse ephemeral kinds ("blocked: ephemeral kinds are not accepted"), some want a
// paid or authenticated pubkey, and some accept an event without forwarding it.
//
// This script does what Trystero does, against each relay given (or a built-in list), with two
// connections per relay: B subscribes, A publishes a burst of BURST events from one key, and every
// one must be accepted and reach B.
//
//   deno run --allow-net --allow-read tests/harness/nostr_relay_probe.js [--json] [wss://relay ...]
//
// With no relays named it probes SCAN_RELAY_URLS from src/web/src/lib/scan_relays.js, Trystero's
// own 28 defaults, and a few large general-purpose relays. It prints one line per relay
// ("ok 412ms", or what failed) and, with --json, a JSON list at the end. It needs the internet, so
// no test runs it by default; kb/phone-scanner-pairing-trystero-over-nostr-the-pa.md says when to.

import { schnorr } from '../../src/web/node_modules/.deno/@noble+secp256k1@3.2.0/node_modules/@noble/secp256k1/index.js';
import { SCAN_RELAY_URLS } from '../../src/web/src/lib/scan_relays.js';

// Trystero 0.25.4's defaultRelayUrls (@trystero-p2p/nostr dist/index.mjs), copied so this script
// runs without bundling Trystero.
const TRYSTERO_DEFAULTS = [
  'basspistol.org', 'bucket.coracle.social', 'chorus.pjv.me', 'koru.bitcointxoko.org', 'nos.lol',
  'nostr-01.uid.ovh', 'nostr-01.yakihonne.com', 'nostr-relay.corb.net', 'nostr.data.haus',
  'nostr.islandarea.net', 'nostr.sathoarder.com', 'nostr.tegila.com.br', 'nostr.vulpem.com',
  'purplerelay.com', 'relay-can.zombi.cloudrodion.com', 'relay-rpi.edufeed.org',
  'relay.agorist.space', 'relay.artio.inf.unibe.ch', 'relay.mostr.pub', 'relay.mostro.network',
  'relay.sigit.io', 'relay02.lnfi.network', 'schnorr.me', 'social.amanah.eblessing.co',
  'staging.yabu.me', 'strfry.shock.network', 'top.testrelay.top', 'yabu.me/v2',
].map(host => `wss://${host}`);

// Large general-purpose relays, candidates for the pinned list.
const OTHERS = [
  'relay.damus.io', 'relay.primal.net', 'nostr.mom', 'relay.nostr.band', 'offchain.pub',
  'relay.snort.social', 'nostr.oxtr.dev', 'relay.nostr.net', 'nostr.bitcoiner.social',
  'relay.nostr.bg', 'nostr-pub.wellorder.net', 'relay.mutinywallet.com', 'nostr.einundzwanzig.space',
  'relay.nos.social', 'nostr.land', 'ftp.halifax.rwth-aachen.de/nostr', 'nostr.lu.ke',
].map(host => `wss://${host}`);

const STEP_MS = 6000;

/** Events published per probe, from one key: about what one pairing sends each relay. */
const BURST = 15;

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** A websocket that resolves once open, and collects the relay's messages for `waitFor`. */
function connect(url) {
  return new Promise((resolve, reject) => {
    let socket;

    try {
      socket = new WebSocket(url);
    } catch (cause) {
      reject(cause);
      return;
    }

    const messages = [];
    const waiters = new Set();
    const timer = setTimeout(() => {
      reject(new Error('connect timeout'));
      try { socket.close(); } catch { /* already gone */ }
    }, STEP_MS);

    socket.onmessage = event => {
      let message;

      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      messages.push(message);
      waiters.forEach(waiter => waiter());
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('connect error'));
    };
    socket.onopen = () => {
      clearTimeout(timer);
      resolve({
        socket,
        send: value => socket.send(JSON.stringify(value)),
        // The first message `match` accepts, or null after `ms`.
        waitFor(match, ms = STEP_MS) {
          return new Promise(done => {
            const check = () => {
              const found = messages.find(match);

              if (found) {
                waiters.delete(check);
                clearTimeout(timeout);
                done(found);
              }
            };
            const timeout = setTimeout(() => {
              waiters.delete(check);
              done(null);
            }, ms);

            waiters.add(check);
            check();
          });
        },
        close: () => { try { socket.close(); } catch { /* already gone */ } },
      });
    };
  });
}

/** Probes one relay; resolves to { url, ok, ms, stage, reason }. */
export async function probeRelay(url) {
  const started = performance.now();
  const topic = hex(crypto.getRandomValues(new Uint8Array(20)));
  const kind = 20000 + (Array.from(topic).reduce((sum, c) => sum + c.charCodeAt(0), 0) % 10000);
  const result = { url, ok: false, ms: 0, stage: 'connect', reason: '' };
  let a = null;
  let b = null;

  try {
    [a, b] = await Promise.all([connect(url), connect(url)]);

    // B subscribes the way Trystero does, and waits for EOSE (or a CLOSED refusal).
    result.stage = 'subscribe';
    const subId = hex(crypto.getRandomValues(new Uint8Array(8)));
    b.send(['REQ', subId, { kinds: [kind], since: Math.floor(Date.now() / 1000), '#x': [topic] }]);
    const subscribed = await b.waitFor(m => (m[0] === 'EOSE' || m[0] === 'CLOSED') && m[1] === subId, STEP_MS);

    if (subscribed && subscribed[0] === 'CLOSED') {
      throw new Error(`subscription closed: ${subscribed[2]}`);
    }

    // A publishes a BURST of signed ephemeral events on the topic from one key, as a session does:
    // an announcement, an offer or answer, and a run of ICE candidates in quick succession, about
    // a dozen per relay per pairing (counted, T-0316). One event is not enough: some relays
    // accept the first event from an unknown key and refuse the rest ("pubkey is not in our web
    // of trust"), and Trystero retires a relay at its first refusal.
    result.stage = 'publish';
    const { secretKey, publicKey } = schnorr.keygen();
    const events = [];

    for (let n = 0; n < BURST; n += 1) {
      const payload = {
        kind,
        tags: [['x', topic]],
        created_at: Math.floor(Date.now() / 1000),
        content: JSON.stringify({ probe: 'houseki-scanner relay check', n }),
        pubkey: hex(publicKey),
      };
      const id = await sha256(JSON.stringify([0, payload.pubkey, payload.created_at, payload.kind, payload.tags, payload.content]));
      events.push({ ...payload, id: hex(id), sig: hex(await schnorr.signAsync(id, secretKey)) });
    }

    events.forEach(event => a.send(['EVENT', event]));

    // Trystero retires a relay that answers OK false (other than rate-limited or duplicate).
    for (const event of events) {
      const accepted = await a.waitFor(m => m[0] === 'OK' && m[1] === event.id, STEP_MS);

      if (accepted && accepted[2] === false) {
        throw new Error(`event ${event.content} refused: ${accepted[3]}`);
      }
    }

    // And B must receive every one.
    result.stage = 'deliver';

    for (const event of events) {
      const delivered = await b.waitFor(m => m[0] === 'EVENT' && m[1] === subId && m[2]?.id === event.id, STEP_MS);

      if (!delivered) {
        throw new Error(`event ${event.content} never delivered`);
      }
    }

    result.ok = true;
    result.stage = 'done';
  } catch (cause) {
    result.reason = String(cause?.message ?? cause);
  } finally {
    a?.close();
    b?.close();
    result.ms = Math.round(performance.now() - started);
  }

  return result;
}

if (import.meta.main) {
  const args = Deno.args.filter(arg => arg !== '--json');
  const urls = args.length ? args : [...new Set([...SCAN_RELAY_URLS, ...TRYSTERO_DEFAULTS, ...OTHERS])];
  const results = await Promise.all(urls.map(probeRelay));

  for (const r of results) {
    const pinned = SCAN_RELAY_URLS.includes(r.url) ? ' [pinned]' : '';
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.url}${pinned} ${r.ms}ms${r.ok ? '' : ` at ${r.stage}: ${r.reason}`}`);
  }

  console.log(`${results.filter(r => r.ok).length} of ${results.length} relays carried a Trystero-style event`);

  if (Deno.args.includes('--json')) {
    console.log(JSON.stringify(results));
  }

  // Exit at once: a relay that never answers would otherwise keep a socket alive.
  Deno.exit(0);
}
