import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { normaliseEvent, maskEmail } from "./normalise.js";
import { deriveFbc } from "./clickId.js";
import {
  detectUnsubstitutedPlaceholder,
  describePlaceholderRejection,
  PLACEHOLDER_NOT_SUBSTITUTED,
} from "../docusign/fxboPlaceholder.js";

const digest = (value) => createHash("sha256").update(String(value ?? ""), "utf8").digest();

/**
 * Compare digests, not the secrets themselves.
 *
 * timingSafeEqual needs equal-length inputs, and returning early when the
 * lengths differ would tell a caller how long the secret is. Both digests are 32
 * bytes whatever went in, so neither the comparison nor a branch depends on
 * either length. An empty secret never matches, not even an empty header.
 */
function secretMatches(supplied, expected) {
  if (!String(expected ?? "")) return false;
  return timingSafeEqual(digest(supplied), digest(expected));
}

/**
 * The configured webhook secret, or "" when there is none worth having.
 *
 * Trimmed, so a blank value (a quoted blank in .env, a stray carriage return)
 * counts as unset and gets the boot warning, instead of passing for configured
 * and then matching nothing. Only the ends are trimmed.
 */
export function readCrmWebhookSecret(env = process.env) {
  return String(env?.CRM_WEBHOOK_SECRET ?? "").trim();
}

/**
 * POST /api/crm-events.
 *
 * One path for all five stages: the stage is a body parameter whose value is
 * typed into each FXBO rule. A ":stage" path segment would never match the
 * public-route allow-list, which compares actual request paths.
 *
 * Authenticate, reject a test press, validate, store, answer. The answer is 200
 * the moment the row is stored, a duplicate and an invalid payload included,
 * because a non-2xx there would make FXBO redeliver an event we already hold.
 * The one exception is a failed insert: nothing is held, FXBO's retry is the
 * only recovery there is, and the unique (client, stage) key makes a redelivery
 * harmless, so that answers 503.
 */
export function makeCrmEventsHandler({
  secret,
  findFbc,
  insert,
  onStored = () => {},
  normalise = normaliseEvent,
  now = () => new Date(),
  newRequestId = () => randomUUID(),
  logger = console,
}) {
  return async function crmEventsHandler(req, res) {
    // The declared contract is Promise<void>. `res.json()` returns `res`, so
    // `return res.status(..).json(..)` would resolve to the response object.
    const reply = (status, body) => {
      res.status(status).json(body);
    };

    const expected = String(secret ?? "");
    const supplied = String(req?.headers?.authorization ?? "");

    // Fail closed: an unconfigured secret rejects everything.
    if (!expected || !secretMatches(supplied, expected)) {
      // The timestamp is here because iisnode does not supply one.
      logger.warn?.(
        `[crm-events] rejected at=${now().toISOString()} method=${req?.method} path=${req?.path} ip=${req?.ip} hasHeader=${Boolean(supplied)}`
      );
      return reply(401, { error: "unauthorized" });
    }

    let verdict;
    try {
      verdict = normalise(req?.body);
    } catch (error) {
      logger.error?.(`[crm-events] normalise failed: ${error?.message || String(error)}`);
      return reply(200, { ok: true, stored: false, valid: false });
    }

    const { valid, missing, fields } = verdict;

    // An FXBO "Test webhook" press substitutes every parameter with its own
    // LABEL, and those are non-empty strings that would otherwise validate.
    // docusign/fxboPlaceholder.js recognises the shape, and requires a second
    // corroborating field so a real client is never mistaken for a test.
    const detection = detectUnsubstitutedPlaceholder(req?.body, "client_id");
    const isTestPress = detection.placeholder;
    const reason = isTestPress
      ? `${PLACEHOLDER_NOT_SUBSTITUTED}: ${describePlaceholderRejection(detection)}`
      : `missing required fields: ${missing.join(", ")}`;

    // The verdict travels INTO the insert rather than following it as a second
    // UPDATE. Two statements left a window: between them the row sat with three
    // `pending` statuses, so a sweep, a recycle or a throw on the second write
    // would have sent an invalid payload -- including an FXBO test press, which
    // would post a fabricated conversion to Meta and a contact named "Client
    // First Name" into the live marketing list.
    //
    // It also removes any need to reason about duplicates here: the INSERT is a
    // no-op when the row exists, so a malformed redelivery cannot overwrite the
    // statuses an earlier valid delivery set.
    const invalidReason = isTestPress || !valid ? reason.slice(0, 500) : null;

    try {
      // Frozen: assembled once, at whichever stage arrives first, then reused
      // verbatim. Recomputing per stage gives Meta a different click identity
      // for the same person at each step.
      let fbc = "";
      try {
        fbc = (await findFbc(fields.crmClientId)) || deriveFbc(fields.fullLink, now().getTime());
      } catch (error) {
        // Empty, NOT derived. When the lookup fails we cannot know whether a
        // frozen id already exists, and deriving one here would stamp this stage
        // with a fresh timestamp: a different click identity for the same person.
        // A missing matcher is recoverable (Meta falls back to the hashed email
        // and phone, and a later event still picks up the frozen value from an
        // earlier row); an inconsistent one is silently wrong.
        logger.error?.(`[crm-events] click id lookup failed: ${error?.message || String(error)}`);
        fbc = "";
      }

      // Generated once, here, and reused on every send attempt. A send times
      // out after 10 seconds and a timeout does not mean the message was not
      // delivered, so a retry carrying a fresh id would be a second welcome.
      const { inserted } = await insert(
        fields,
        { fbc, whatsappRequestId: newRequestId() },
        req?.body,
        invalidReason
      );

      if (invalidReason) {
        logger.warn?.(
          `[crm-events] ${isTestPress ? "test press" : "invalid payload"} for ${maskEmail(fields.email) || "(no email)"}`
        );
        return reply(200, { ok: true, stored: true, duplicate: !inserted, valid: false });
      }

      if (inserted) {
        // Fire and forget, after the response is decided. The sweeper is the
        // safety net if this kick is lost to a recycle, not the normal path.
        try {
          onStored();
        } catch (error) {
          logger.error?.(`[crm-events] worker kick failed: ${error?.message || String(error)}`);
        }
      }

      return reply(200, { ok: true, stored: true, duplicate: !inserted });
    } catch (error) {
      // Nothing is stored, so this must not answer 2xx: a 200 here drops the
      // event for good, where a 503 lets FXBO redeliver it. The ids are logged
      // so that a lost event can at least be identified afterwards. They are
      // JSON-quoted so a value cannot forge a second log line, and the email is
      // left out on purpose.
      logger.error?.(
        `[crm-events] store failed, event not held: client=${JSON.stringify(fields?.crmClientId)} ` +
          `stage=${JSON.stringify(fields?.stage)} unique_id=${JSON.stringify(fields?.fxboUniqueId)}: ` +
          `${error?.message || String(error)}`
      );
      return reply(503, { ok: false, stored: false, valid: invalidReason === null, error: "store_failed" });
    }
  };
}
