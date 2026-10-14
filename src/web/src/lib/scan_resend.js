// Resending an offer the other device never got (T-0349, 2026-10-14). The user's logs showed the
// computer, as the offerer (the device with the lower peer id offers), sending its offer once per
// relay right after it heard the phone, and the phone never receiving any of them: it went on
// nudging ("I am here, send me an offer") and announcing while Trystero ignored both: it marks
// the offer as sent through that relay and sends it again only for a message that arrives after
// it has pruned that mark (signal-handler.mjs offerRelays, pruned after 0.9 of announceIntervalMs,
// 0.9 x 5333 ms = 4.8 s; ctx.announceIntervals keeps 5333 because the Nostr strategy's announce
// returns an object, not a number). But a device announces only 0.23, 0.77 and 2.1 s after joining
// each relay (strategy.mjs announceWarmupIntervalsMs), then every 60 s, and nudges only when it
// hears an announcement: everything it says in reply to the lost offer comes inside those 4.8 s
// and is ignored, and the pairing waits for the next 60 s announcement on either side, past the
// phone's 30 s timeout. The likely cause of the loss
// is that Trystero subscribes with `since: now()` by the phone's clock, and the relays drop a live
// event stamped earlier than that: a phone clock a second or two ahead loses whatever the
// computer sends in the first moments after the phone subscribed, which is exactly when the
// offer goes.
//
// So, from outside Trystero, through the relay sockets scan_trace.js already watches: when a
// device whose offer from us is still unanswered nudges us or announces again through a relay,
// this page publishes that offer -- and the address candidates sent after it for the same offer
// id -- again through that relay, as fresh events made by Trystero's own createEvent (the same
// key, a new created_at). The content is unchanged, so the other device's Trystero takes it as
// the offer it missed; one that already has it is answering or connected and ignores it
// (handleOffer returns early).
//
// This helps while the loss lasts no longer than the other device keeps talking (its last warm-up
// announcement, 2.1 s after it joined a relay): a resend made after that is dropped as well.
//
// An offer is resent only while Trystero still holds it (RESEND_WINDOW_MS, inside its 57 s offer
// lifetime, offer-pool.mjs offerTtl): resending one it has dropped would make the other device
// answer a dead offer and then ignore the next real one for ~23 s while it waits on that answer.

/** How long after an offer was first sent it may be resent (ms); Trystero drops it at 57 s. */
export const RESEND_WINDOW_MS = 45000;

/**
 * The shortest gap between two sends of the same offer through one relay (ms). Short enough that
 * the warm-up announcement 0.77 s after the one that brought the offer can bring a resend.
 */
export const RESEND_GAP_MS = 500;

const parse = text => {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
};

const topicOf = event => (Array.isArray(event?.tags) ? event.tags.find(t => t[0] === 'x')?.[1] ?? null : null);

const shortId = id => (id ? String(id).slice(0, 6) : '?');

/**
 * Remembers the offers this page sends and resends one when its device shows it is still waiting.
 * Returns:
 *   sent(url, event)               every EVENT this page publishes (the event object), from the
 *                                  relay socket's send
 *   heard(url, socket, peerId, how)  the device `peerId` announced (`how` 'announcement') or
 *                                  nudged ('nudge') through the relay `url`, whose socket is
 *                                  `socket`; resolves once any resend has been handed to it
 *   answered(peerId)               that device answered, or joined: its offer is never resent
 *   close()                        forgets everything; later calls do nothing
 *
 * @param {object} options
 * @param {string} options.selfId                         this page's Trystero peer id
 * @param {(peerId: string) => Promise<string>} options.peerTopic   a device's own topic
 * @param {(topic: string, content: string) => Promise<string>} options.createEvent
 *                                                        Trystero's: a signed ["EVENT", ...] message
 * @param {Function} [options.log]                        createScanLog's logger
 * @param {Function} [options.now]
 */
export function createOfferResender({ selfId, peerTopic, createEvent, log = () => {}, now = () => Date.now() }) {
  // By the other device's topic: { offerId, firstSentAt, contents: [the offer's content, then its
  // candidates'], lastSentAt: Map(relay url -> ms), answered }.
  const offers = new Map();
  const topics = new Map();
  let closed = false;

  const topicFor = peerId => {
    if (!topics.has(peerId)) {
      topics.set(peerId, peerTopic(peerId));
    }

    return topics.get(peerId);
  };

  return {
    sent(url, event) {
      if (closed) {
        return;
      }

      const topic = topicOf(event);
      const raw = event?.content;
      const content = parse(raw);

      if (!topic || content?.peerId !== selfId || !content.offerId) {
        return;
      }

      let record = offers.get(topic);

      if (content.offer && record?.offerId !== content.offerId) {
        // A new offer to that device replaces the one before it.
        record = { offerId: content.offerId, firstSentAt: now(), contents: [], lastSentAt: new Map(), answered: false };
        offers.set(topic, record);
      }

      if (!record || record.offerId !== content.offerId || !(content.offer || content.candidate)) {
        return;
      }

      if (!record.contents.includes(raw)) {
        record.contents.push(raw);
      }

      if (content.offer) {
        record.lastSentAt.set(url, now());
      }
    },

    async heard(url, socket, peerId, how) {
      if (closed || !peerId || peerId === selfId) {
        return;
      }

      const topic = await topicFor(peerId);
      const record = offers.get(topic);

      if (closed || !record || record.answered) {
        return;
      }

      if (now() - record.firstSentAt > RESEND_WINDOW_MS) {
        offers.delete(topic);
        return;
      }

      const last = record.lastSentAt.get(url);

      if ((last !== undefined && now() - last < RESEND_GAP_MS) || socket?.readyState !== 1) {
        return;
      }

      record.lastSentAt.set(url, now());
      const contents = [...record.contents];
      const events = await Promise.all(contents.map(content => createEvent(topic, content)));

      if (closed || record.answered || socket.readyState !== 1) {
        return;
      }

      const candidates = contents.length - 1;
      log('info', `resending the offer to peer ${shortId(peerId)} through ${url}: it is still waiting for one (its ${how})${candidates ? `, with ${candidates} address candidate${candidates === 1 ? '' : 's'}` : ''}`);
      events.forEach(message => socket.send(message));
    },

    async answered(peerId) {
      if (closed || !peerId) {
        return;
      }

      const record = offers.get(await topicFor(peerId));

      if (record) {
        record.answered = true;
      }
    },

    close() {
      closed = true;
      offers.clear();
      topics.clear();
    },
  };
}
