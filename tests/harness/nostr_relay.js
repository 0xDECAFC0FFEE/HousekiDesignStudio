// A minimal Nostr relay (NIP-01) for tests/harness/test_scan_link.py (T-0313), so the phone
// scanner's integration tests signal through localhost and never touch the public relays: they
// pass offline and deterministically, and production keeps Trystero's default Nostr strategy with
// nothing test-only in it except the relay list, which the session link carries.
//
// It implements what Trystero's Nostr strategy uses and nothing more:
//   ["EVENT", event]            store it, answer ["OK", id, true, ""], and send it to every open
//                               subscription whose filters match
//   ["REQ", subId, filter...]   open a subscription: send the stored events that match, then
//                               ["EOSE", subId]
//   ["CLOSE", subId]            close it
// A filter matches on `kinds`, `since`, `until`, `ids`, `authors` and `#<tag>` lists. Signatures
// are not checked: every client is the test's own browser.
//
// Run with Deno (node is broken on this machine):
//   deno run --allow-net tests/harness/nostr_relay.js [port]
// Port 0 (the default) picks a free one. The first line it prints is `listening <port>`.

const port = Number(Deno.args[0] ?? 0);
const events = [];
const sockets = new Set();

function matches(filter, event) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (typeof filter.since === 'number' && event.created_at < filter.since) return false;
  if (typeof filter.until === 'number' && event.created_at > filter.until) return false;

  for (const [key, wanted] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(wanted)) {
      const name = key.slice(1);
      const values = (event.tags ?? []).filter(tag => tag[0] === name).map(tag => tag[1]);

      if (!values.some(value => wanted.includes(value))) return false;
    }
  }

  return true;
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function handle(socket, message) {
  const [type, ...rest] = message;

  if (type === 'EVENT') {
    const event = rest[0];

    if (!event || typeof event.id !== 'string') {
      send(socket, ['NOTICE', 'invalid: event']);
      return;
    }

    events.push(event);
    send(socket, ['OK', event.id, true, '']);

    for (const other of sockets) {
      for (const [subId, filters] of other.subscriptions) {
        if (filters.some(filter => matches(filter, event))) {
          send(other, ['EVENT', subId, event]);
        }
      }
    }
  } else if (type === 'REQ') {
    const [subId, ...filters] = rest;
    socket.subscriptions.set(subId, filters);

    for (const event of events) {
      if (filters.some(filter => matches(filter, event))) {
        send(socket, ['EVENT', subId, event]);
      }
    }

    send(socket, ['EOSE', subId]);
  } else if (type === 'CLOSE') {
    socket.subscriptions.delete(rest[0]);
  }
}

Deno.serve(
  {
    hostname: '127.0.0.1',
    port,
    onListen: ({ port: actual }) => console.log(`listening ${actual}`),
  },
  request => {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('nostr relay for tests', { status: 200 });
    }

    const { socket, response } = Deno.upgradeWebSocket(request);
    socket.subscriptions = new Map();
    socket.onopen = () => sockets.add(socket);
    socket.onclose = () => sockets.delete(socket);
    socket.onerror = () => sockets.delete(socket);
    socket.onmessage = ({ data }) => {
      try {
        handle(socket, JSON.parse(String(data)));
      } catch (cause) {
        send(socket, ['NOTICE', `error: ${cause}`]);
      }
    };

    return response;
  },
);
