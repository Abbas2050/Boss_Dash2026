import { readDeliveryUpdate } from "./whatsappStatus.js";

/**
 * POST /api/crm-events/whatsapp-status
 *
 * DoubleTick's `MESSAGE_STATUS_UPDATE` webhook. It is the only way a status ever
 * arrives: verified 2026-10-16, there is no endpoint to ask one for. Registered
 * by hand in their UI (Settings -> Webhooks -> New Webhook); CUTOVER step 7b.
 *
 *   https://learn.doubletick.io/webhooks-and-public-api/webhooks/how-to-use-message-status-update-webhook
 *   https://docs.doubletick.io/reference/messaging-webhooks-1
 *
 * ## It takes no shared secret, and that is a decision
 *
 * **Their webhook carries no documented authentication.** No signature, no
 * secret header, nothing to verify. So there are three options: refuse the
 * feature, invent a secret they cannot send, or find the capability already in
 * the request. The third one exists here.
 *
 * `whatsapp_request_id` is a UUID v4 this service generates when the row is
 * stored and never changes. The store's only write (`recordWhatsappDelivery`)
 * matches on it exactly. So **the id is the capability**: without guessing a v4
 * UUID there is no row to reach, and holding one buys nothing but the three
 * delivery columns of that single row -- marking one message delivered, read, or
 * failed. Nothing sends, nothing requeues, no status the worker reads is
 * touched, and no client data is returned or even loaded.
 *
 * **The secret is not in the URL, and that is the other half of the decision.**
 * The existing `hook.php` mirrors put theirs in the path, where it is readable
 * in the CRM's own webhook log and in every proxy log in between -- a secret
 * that is printed on every delivery is not a secret. A query-string secret here
 * would be worse than none, because it would look like authentication.
 *
 * ## What it answers, and why always the same thing
 *
 * **200 and `{ ok: true }`, whatever happens.** An unknown id, a body with no
 * `messageId`, a status we have never seen, a database that is down: the same
 * three bytes. Two reasons, and they point the same way:
 *
 *   An endpoint that answered differently for a known and an unknown id would be
 *   an oracle for which ids exist, and the id is the capability. One request per
 *   guess, and a different answer when the guess lands, is how a capability
 *   stops being one.
 *
 *   A provider's webhook that gets a non-2xx retries, and there is nothing here
 *   worth retrying. The status is already stale by the time it arrives; a later
 *   one supersedes it.
 *
 * So it never throws and it never returns anything read from the row -- not the
 * stage, not the client id, not whether the update changed anything.
 */

/** The whole answer. One frozen object so no path can add a field to it: a body
 *  built per branch is how an endpoint starts telling a caller which branch it
 *  took. */
const ACK = Object.freeze({ ok: true });

/** How much of the id a log line may carry.
 *
 *  Enough to correlate two lines about one message, and not enough to replay
 *  one: the id IS the capability (above), so a log that printed it whole would
 *  hand it to everyone who can read the iisnode stdout log. Eight hex characters
 *  of a v4 UUID identify a line without being guessable back to the rest. */
const LOGGED_ID_CHARS = 8;

const idForLog = (messageId) => `${String(messageId ?? "").slice(0, LOGGED_ID_CHARS)}…`;

export function makeWhatsappStatusHandler({ record, logger = console, now = () => new Date() }) {
  if (typeof record !== "function") throw new TypeError("makeWhatsappStatusHandler: record is required");

  // **The open question, counted.** DoubleTick's documentation does not say
  // whether `messageId` on this event is the id we supplied or one they
  // generate. A status that matches no row is the evidence that it is theirs --
  // so it must not be silence. The count rides along in the log line, which
  // turns "this happened once" into "this happens to every message", and that is
  // the difference between a shape surprise and the answer to the question.
  //
  // In-process, so it starts again at a recycle. That is acceptable precisely
  // because it is reported in a line rather than read from a gauge: the log
  // keeps the history the counter does not.
  let unmatched = 0;
  // Logged once, and then never again. The first match IS the answer to the same
  // question, in the other direction, and it is worth a line that says so. After
  // that a line per delivered message would be noise on every registration.
  let saidItMatches = false;

  return async function whatsappStatusHandler(req, res) {
    // `res.json()` returns `res`, so `return res.status(..).json(..)` would
    // resolve this handler to the response object rather than to nothing. Same
    // reason router.js has one.
    const ack = () => {
      res.status(200).json(ACK);
    };

    try {
      const update = readDeliveryUpdate(req?.body, now());

      if (!update) {
        // No `messageId`, or no readable `status`. Worth a line because the
        // payload shape is read from documentation rather than from traffic, and
        // this is where a shape that differs from it shows up. The body is not
        // logged: it is a third party's and we have not understood it.
        logger.warn?.("[crm-events] whatsapp status webhook carried no messageId and status it could read");
        return ack();
      }

      const matched = await record(update.messageId, {
        // Verbatim, because the read status string is undocumented: an
        // unrecognised value has to reach the tab as itself.
        status: update.status,
        at: update.at,
        // Only a failure carries one. The store masks it on the way in, like
        // every other detail column, because it is the provider's own text and a
        // provider quotes back what we sent it.
        detail: update.failMessage || null,
      });

      if (matched === 0) {
        unmatched += 1;
        logger.warn?.(
          `[crm-events] whatsapp status for an id we never issued: id=${idForLog(update.messageId)} ` +
            `status=${JSON.stringify(update.status)} unmatched=${unmatched} since this worker started. ` +
            "If every status reads this way, DoubleTick's messageId is theirs and not the one we send, " +
            "and nothing can be matched until this endpoint is keyed on their id instead."
        );
      } else if (!saidItMatches) {
        saidItMatches = true;
        logger.log?.(
          `[crm-events] whatsapp status matched the id we froze (id=${idForLog(update.messageId)}, ` +
            `status=${JSON.stringify(update.status)}): DoubleTick echoes our messageId, which the design ` +
            "left as an open question. Delivery proof works."
        );
      }

      if (!update.recognised) {
        // The read status string is not documented, so this is the line that
        // names the real one the first time it arrives -- and any status
        // DoubleTick adds later. Stored verbatim either way; this makes it
        // findable without opening the tab.
        logger.warn?.(
          `[crm-events] whatsapp delivery status not recognised: ${JSON.stringify(update.status)}. ` +
            "It is stored and shown as it arrived. If this is WhatsApp's read receipt, add it to " +
            "RECOGNISED in crmSignup/whatsappStatus.js so the tab can read it as one."
        );
      }
    } catch (error) {
      // Never a 5xx, and never a throw past this point: an Express error handler
      // would answer 500, which tells a caller their guess was interesting.
      logger.error?.(`[crm-events] whatsapp status webhook failed: ${error?.message || String(error)}`);
    }

    return ack();
  };
}
