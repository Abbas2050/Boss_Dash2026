/**
 * DoubleTick's `MESSAGE_STATUS_UPDATE` webhook, read and classified.
 *
 * Pure. Everything that decides what a payload means lives here; the HTTP
 * handler beside it (whatsappStatusRoute.js) only moves the result into the one
 * statement that may be run.
 *
 * **Why a webhook at all.** `ENQUEUED` is the answer to the send request, and it
 * is DoubleTick's queue, not a handset. Verified against their documentation on
 * 2026-10-16: there is **no endpoint to query a message's status**. A status
 * arrives only by this webhook, or not at all.
 *
 *   https://learn.doubletick.io/webhooks-and-public-api/webhooks/how-to-use-message-status-update-webhook
 *   https://docs.doubletick.io/reference/messaging-webhooks-1
 *
 * The payload carries `messageId`, `status`, `statusTimestamp`, and
 * `failMessage` when the status is a failure. Their samples show `SENT`,
 * `DELIVERED` and `FAILED`.
 *
 * **Two things their documentation does not settle, and neither is guessed at
 * here:**
 *
 *   The **read** status exists -- it is described in prose -- but its exact
 *   string is not written down anywhere. So nothing in this file treats
 *   `"READ"` as the only possible read value: every status is kept verbatim,
 *   and a value that is not one of the three recognised ones is classified
 *   `unknown` *with its text attached*, so it reaches the tab as itself. An
 *   allowlist built on a guessed string would drop the real one silently, which
 *   is exactly the `SENT`/`ENQUEUED` trap in whatsapp.js one step further along.
 *
 *   Whether `messageId` is **the id we supplied** or one DoubleTick generates.
 *   Nothing here can answer that; the store answers it by matching, and the
 *   handler reports a status that matched no row. One real message settles it.
 */

/** The statuses this module recognises, and what each one means for the symbol
 *  the tab shows. Case-insensitive on the way in; the stored value keeps its
 *  own casing.
 *
 *  `DELIVERED` and `READ` are both better news than our own `sent`: they are a
 *  handset, not a queue. `FAILED` is worse news than our own `sent`, and it has
 *  to be able to say so -- a tick on a message DoubleTick reports as failed is
 *  the lie this whole webhook exists to remove. `SENT` adds nothing we do not
 *  already have, and is recognised so that it is not mistaken for an unknown
 *  value needing attention. */
const RECOGNISED = new Map([
  ["DELIVERED", "delivered"],
  ["READ", "read"],
  ["FAILED", "failed"],
  ["SENT", "sent"],
]);

/** What `whatsapp_delivery_status` may hold, so a classification cannot be
 *  invented by a caller. `unknown` is a real member: it means a status arrived
 *  and we do not know what it means, which is not the same as none arriving. */
export const DELIVERY_KINDS = ["delivered", "read", "failed", "sent", "unknown"];

const text = (v) => String(v ?? "").trim();

/**
 * One message id, or "".
 *
 * A string or a finite number, and nothing else. The number is allowed because
 * ours is a UUID but theirs may not be, and if DoubleTick's own id is numeric
 * (this is the unverified half of the design) it still has to be readable. What
 * it must NOT do is take `String(value)` of anything: `{}` becomes
 * "[object Object]", which is a non-empty id that matches no row and leaves a
 * log line blaming the provider for a body we mis-read.
 */
function readId(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * One delivery status, as a kind and the value it came from.
 *
 * The value is returned alongside the kind and never replaced by it. That is
 * the whole protection against the undocumented read string: an unexpected
 * value is visible, in the row and on the page, rather than folded into a
 * bucket whose name hides what DoubleTick actually said.
 *
 * Only a string can be classified. A number, an object or an array is not a
 * status, and coercing one would make `["DELIVERED"]` read as delivered.
 */
export function classifyDeliveryStatus(status) {
  if (typeof status !== "string") {
    return { kind: "unknown", value: "", recognised: false };
  }
  const value = status.trim();
  if (!value) return { kind: "unknown", value: "", recognised: false };
  const kind = RECOGNISED.get(value.toUpperCase());
  return kind
    ? { kind, value, recognised: true }
    : // Kept whole. This is the branch the real read status will arrive in if it
      // is not the word "READ", and the branch any status DoubleTick adds later
      // arrives in. Both have to be readable to be acted on.
      { kind: "unknown", value, recognised: false };
}

/**
 * When the provider says the status happened, or the fallback.
 *
 * **The format of `statusTimestamp` is not documented**, so this parses what it
 * can and refuses to store a value it cannot read. Epoch milliseconds, epoch
 * seconds and an ISO string are all handled; anything else falls back to the
 * caller's instant -- the moment the webhook arrived, which is late by seconds
 * and true.
 *
 * The alternative is what the OpenAI `timestamp_ms` trap did to the other
 * destination: a seconds value read as milliseconds stamps every row in 1970,
 * and nothing errors. A timestamp column full of 1970 is worse than one holding
 * arrival times, because it looks like data.
 */
export function toDeliveryInstant(statusTimestamp, fallback = new Date()) {
  // A numeric string is the same value as the number: JSON from a provider
  // quotes large integers often enough that treating "1760000000000" as
  // unparseable would throw away a real instant. Resolved here, once, rather
  // than by recursing -- `0` reads as the string "0" and back as `0` for ever.
  const asText = text(statusTimestamp);
  const raw = /^\d+$/.test(asText) ? Number(asText) : statusTimestamp;

  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    // 1e11 ms is 1973 and 1e11 s is the year 5138, so the boundary is not close
    // to any instant this service can see. Below it the value is seconds.
    const at = new Date(raw >= 1e11 ? raw : raw * 1000);
    return Number.isFinite(at.getTime()) ? at : fallback;
  }

  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }

  return fallback;
}

/**
 * The payload, read.
 *
 * Returns null when there is nothing to act on -- no body, no `messageId`, or no
 * `status`. The caller acknowledges those exactly as it acknowledges everything
 * else; the point of returning null rather than a half-filled object is that
 * nothing is written for a payload we did not understand.
 *
 * **Only the documented top-level fields are read.** No `data.` wrapper and no
 * `messages[0]` is looked for, because neither is in the documentation and a
 * shape invented here would be a shape nothing ever sends. A body carrying
 * neither field is reported by the handler, which is how a shape surprise
 * surfaces: loudly, on the first real message, rather than as silence.
 */
export function readDeliveryUpdate(body, at = new Date()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const messageId = readId(body.messageId);
  if (!messageId) return null;

  const status = classifyDeliveryStatus(body.status);
  // A status we cannot even read as a string is not an update. An unrecognised
  // one IS: that is the undocumented-read-value case, and dropping it here
  // would be the silent loss this module is written to avoid.
  if (!status.value) return null;

  return {
    messageId,
    status: status.value,
    kind: status.kind,
    recognised: status.recognised,
    at: toDeliveryInstant(body.statusTimestamp, at),
    // DoubleTick sends this only on a failure. It is the provider's own text, so
    // it may quote the number we sent -- the store masks every detail on the way
    // in, which is why this is passed through rather than parsed.
    failMessage: text(body.failMessage),
  };
}
