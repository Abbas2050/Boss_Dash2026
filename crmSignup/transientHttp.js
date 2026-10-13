/**
 * The one place that decides which HTTP status is worth retrying.
 *
 * 408, 429 and every 5xx, for all three senders. It used to be three copies of
 * the same line, and it had already drifted once on this branch: 408 was
 * retried by WhatsApp, permanent in Brevo and unhandled in Meta, and
 * reconciling them took a pass across the whole module.
 *
 * The classifiers themselves stay separate, deliberately: what counts as a
 * SUCCESS genuinely differs per provider (spec section 8 -- Meta needs
 * `events_received`, DoubleTick's 2xx means only that the request was
 * accepted). What counts as transient does not differ, so it lives here.
 *
 * A status that is not a finite number is not transient: a 0 means we never
 * understood the response at all, and a sender's transport branch has already
 * had its say by then.
 */
export function isTransientHttpStatus(code) {
  const status = Number(code);
  if (!Number.isFinite(status)) return false;
  // A Request Timeout is transient by definition, as are 429 and every 5xx.
  return status === 408 || status === 429 || status >= 500;
}
