import { randomUUID, timingSafeEqual } from "crypto";
import { normaliseEvent, maskEmail } from "./normalise.js";
import { deriveFbc } from "./clickId.js";
import {
  detectUnsubstitutedPlaceholder,
  describePlaceholderRejection,
  PLACEHOLDER_NOT_SUBSTITUTED,
} from "../docusign/fxboPlaceholder.js";

/** Compare without leaking length or position through timing. */
function secretMatches(supplied, expected) {
  const a = Buffer.from(String(supplied ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * POST /api/crm-events.
 *
 * One path for all five stages: the stage is a body parameter whose value is
 * typed into each FXBO rule. A ":stage" path segment would never match the
 * public-route allow-list, which compares actual request paths.
 *
 * Authenticate, reject a test press, validate, store, answer 200. The handler
 * answers 200 even when the database throws, because a 5xx would make FXBO
 * redeliver on its own schedule.
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
      logger.warn?.(
        `[crm-events] rejected: method=${req?.method} path=${req?.path} ip=${req?.ip} hasHeader=${Boolean(supplied)}`
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

    try {
      // Frozen: assembled once, at whichever stage arrives first, then reused
      // verbatim. Recomputing per stage gives Meta a different click identity
      // for the same person at each step.
      let fbc = "";
      try {
        fbc = (await findFbc(fields.crmClientId)) || deriveFbc(fields.fullLink, now().getTime());
      } catch (error) {
        logger.error?.(`[crm-events] click id lookup failed: ${error?.message || String(error)}`);
        fbc = deriveFbc(fields.fullLink, now().getTime());
      }

      // Generated once, here, and reused on every send attempt. A send times
      // out after 10 seconds and a timeout does not mean the message was not
      // delivered, so a retry carrying a fresh id would be a second welcome.
      // The verdict travels INTO the insert rather than following it as a
      // second UPDATE. Two statements left a window: between them the row sat
      // with three `pending` statuses, so a sweep, a recycle or a throw on the
      // second write would have sent an invalid payload -- including an FXBO
      // test press, which would post a fabricated conversion to Meta and a
      // contact named "Client First Name" into the live marketing list.
      //
      // It also removes any need to reason about duplicates here: the INSERT is
      // a no-op when the row exists, so a malformed redelivery cannot overwrite
      // the statuses an earlier valid delivery set.
      const invalidReason = isTestPress || !valid ? reason.slice(0, 500) : null;

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
      logger.error?.(`[crm-events] store failed: ${error?.message || String(error)}`);
      return reply(200, { ok: true, stored: false, valid });
    }
  };
}
