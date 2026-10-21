import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { normaliseEvent, maskEmail } from "./normalise.js";
import { deriveFbc, extractOppref, extractGclid } from "./clickId.js";
import { UNSTORABLE_KEY_CODE } from "./store.js";
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

/** An identifier longer than this is cut, so one request cannot flood the log. */
const MAX_LOGGED_ID = 120;

/**
 * Who a log line is about. Only a string, number or boolean can be an identifier;
 * anything else (absent, an object, an array) is logged as null. Each is cut at
 * MAX_LOGGED_ID characters and marked with "...", because a 1 MB body can carry a
 * million-character client_id and the line would be as long. Every value is
 * JSON-quoted, so one cannot forge a second log line, and the email is never part
 * of it. Takes the identifiers rather than a payload, because the caller may be
 * holding a normalised event or a raw body that normalisation could not read.
 */
function describeEvent({ client, stage, uniqueId }) {
  const scalar = (value) => {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
    const text = String(value);
    return text.length > MAX_LOGGED_ID ? `${text.slice(0, MAX_LOGGED_ID)}...` : text;
  };
  return (
    `client=${JSON.stringify(scalar(client))} stage=${JSON.stringify(scalar(stage))} ` +
    `unique_id=${JSON.stringify(scalar(uniqueId))}`
  );
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
 * harmless, so that answers 503. Except when the store says the key itself can
 * never be stored (UNSTORABLE_KEY_CODE): a redelivery would fail identically, so
 * that is answered 200 and logged as dropped.
 */
export function makeCrmEventsHandler({
  secret,
  findClickIds,
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
      // By definition normalisation failed, so read the identifiers straight off
      // the raw body and trust none of it. Without them a lost event carries no
      // client id at all. Still 200: a payload our own normaliser cannot parse
      // will not parse on a retry either.
      const raw = req?.body && typeof req.body === "object" ? req.body : {};
      const event = describeEvent({ client: raw.client_id, stage: raw.stage, uniqueId: raw.unique_id });
      logger.error?.(`[crm-events] normalise failed, event not held: ${event}: ${error?.message || String(error)}`);
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
      // All three click ids are frozen the same way: captured once, at the first
      // stage whose full_link carried one, then reused verbatim. An earlier
      // stage without one stores nothing, so the freeze starts at the first
      // stage that has a click. Recomputing per stage gives the platform a
      // different click identity for the same person at each step -- and by the
      // first deposit, weeks later, there is nothing to recompute from: that row
      // has its own full_link, normally empty, and this one's was scrubbed a
      // minute after it arrived.
      //
      // `oppref` is OpenAI's and `gclid` is Google's, and both are taken raw: no
      // `fb.1.<ms>.` wrapper and no timestamp, so the value itself is the whole
      // of what is frozen. Google's arrives by auto-tagging, which appends it to
      // the landing URL, so it is already inside the same `full_link`.
      let fbc = "";
      let oppref = "";
      let gclid = "";
      try {
        const frozen = await findClickIds(fields.crmClientId);
        fbc = String(frozen?.fbc ?? "") || deriveFbc(fields.fullLink, now().getTime());
        oppref = String(frozen?.oppref ?? "") || extractOppref(fields.fullLink);
        gclid = String(frozen?.gclid ?? "") || extractGclid(fields.fullLink);
      } catch (error) {
        // All three empty, NONE derived. When the lookup fails we cannot know
        // whether a frozen id already exists, and deriving one here would claim a
        // click identity this row cannot check: for `fbc` a fresh timestamp, and
        // for `oppref` and `gclid` this visit's click where the client's first one
        // is what is frozen. A missing identifier is recoverable (Meta and OpenAI
        // fall back to the hashed email and phone, Google skips the conversion
        // visibly, and a later event still picks the frozen value up from an
        // earlier row); an inconsistent one is silently wrong.
        logger.error?.(`[crm-events] click id lookup failed: ${error?.message || String(error)}`);
        fbc = "";
        oppref = "";
        gclid = "";
      }

      // Generated once, here, and reused on every send attempt. A send times
      // out after 10 seconds and a timeout does not mean the message was not
      // delivered, so a retry carrying a fresh id would be a second welcome.
      const { inserted } = await insert(
        fields,
        { fbc, oppref, gclid, whatsappRequestId: newRequestId() },
        req?.body,
        invalidReason
      );

      if (invalidReason) {
        // The identifiers, as the normalise-throw and store-failure paths log
        // them. Without them a body with no renderable email carried no stage,
        // no client id and no unique_id -- and because a missing client_id is
        // stored as "", every such event after the first collides on ("", stage)
        // and is swallowed as a duplicate. These are the payloads an operator
        // most needs to find: spec section 11 and CUTOVER step 5 settle what
        // %client_is_lead% contains by reading raw_payload off one of them.
        const event = describeEvent({
          client: fields.crmClientId,
          stage: fields.stage,
          uniqueId: fields.fxboUniqueId,
        });
        logger.warn?.(
          `[crm-events] ${isTestPress ? "test press" : "invalid payload"} for ` +
            `${maskEmail(fields.email) || "(no email)"}: ${event} missing=${JSON.stringify(missing.join(",") || null)}`
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
      // Nothing is stored. The ids are logged so that a lost event can at least
      // be identified afterwards.
      const event = describeEvent({
        client: fields?.crmClientId,
        stage: fields?.stage,
        uniqueId: fields?.fxboUniqueId,
      });
      const message = error?.message || String(error);

      // A key that can never be stored is the one failure a retry cannot cure.
      // 503 means "try again", and FXBO would try again up to twelve times, each
      // failing identically. The event is lost either way; answering 200 only
      // spares FXBO the discovery, and the log is the honest record of it.
      if (error?.code === UNSTORABLE_KEY_CODE) {
        logger.error?.(
          `[crm-events] event DROPPED, its dedupe key cannot be stored and a redelivery would fail the same way: ${event}: ${message}`
        );
        return reply(200, { ok: false, stored: false, valid: invalidReason === null, error: "key_unstorable" });
      }

      // Anything else is a failure of the moment, so this must not answer 2xx: a
      // 200 here drops the event for good, where a 503 lets FXBO redeliver it.
      logger.error?.(`[crm-events] store failed, event not held: ${event}: ${message}`);
      return reply(503, { ok: false, stored: false, valid: invalidReason === null, error: "store_failed" });
    }
  };
}
