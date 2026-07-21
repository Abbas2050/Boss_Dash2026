/**
 * An envelope is "outstanding" while the signer still has an unsigned request
 * in their inbox. Only these statuses block sending another envelope to the
 * same person; completed/expired/voided/declined/superseded all allow a re-send.
 */
export const OUTSTANDING_STATUSES = new Set(["created", "sent", "delivered"]);

export function isOutstandingStatus(status) {
  return OUTSTANDING_STATUSES.has(String(status || "").trim().toLowerCase());
}
