/**
 * The two calls this module makes to FXBO, and the payload they carry.
 *
 * The credential is read by docusign/crm.js and nowhere else here: those
 * helpers are shared with the Back Office panel, so there is one definition of
 * the CRM's base URL, its bearer header and its version query, and no second
 * place to forget the trailing-CR trimming a .env edited on Windows needs.
 *
 * Deliberately NOT through the /rest proxy in server.js. That proxy exists so
 * the browser can reach the CRM without holding the token; a server process
 * calling its own HTTP front door to reach a third party buys a hop and a
 * failure mode and no safety at all.
 *
 * Every function takes an optional `deps` so a test can run the whole path
 * without a network. The defaults are the real thing.
 *
 * Design: ../docs/superpowers/specs/2026-11-06-meta-leads-to-fxbo-design.md
 */
import {
  authHeaders as realAuthHeaders,
  fetchCrmUserByEmail as realFetchCrmUserByEmail,
  getCrmBaseUrl as realGetCrmBaseUrl,
  versionQuery as realVersionQuery,
} from "../docusign/crm.js";

/** A sheet's tags column, "IB, Meta", as the array FXBO wants. */
export function parseTags(raw) {
  return String(raw ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Eleven fields, and four more only when the sheet asks for them.
 *
 * The line between sent and omitted is whether we have an answer, not whether
 * the answer is interesting. `ib: false` is sent because the sheet states it;
 * `city` is absent because nobody asked the lead for one. Sending an empty
 * string where FXBO has a default is how a default gets overwritten.
 */
export function buildLeadPayload(lead, sheet) {
  const payload = {
    lead: true,
    ib: Boolean(sheet?.ib),
    sendWelcomeEmail: false,
    acceptedDocuments: false,
  };

  if (lead?.firstName) payload.firstName = lead.firstName;
  if (lead?.lastName) payload.lastName = lead.lastName;
  if (lead?.email) payload.email = lead.email;
  if (lead?.phone) payload.phone = lead.phone;
  if (lead?.country) payload.country = lead.country;
  if (lead?.utmParams) payload.utmParams = lead.utmParams;

  if (sheet?.language) payload.language = sheet.language;
  const managerId = Number(sheet?.managerId);
  if (Number.isFinite(managerId) && managerId > 0) payload.managerId = managerId;
  // The SHEET's name, not the row's ad set. FXBO calls this field lead
  // source, and the question anyone asks of a lead there is which sheet it
  // came from -- an ad set name changes with every campaign and cannot answer
  // that. The ad set is still on the lead, as utm_term.
  if (sheet?.sendLeadSource && sheet?.label) payload.referrer = sheet.label;
  if (sheet?.status) payload.status = sheet.status;
  const tags = parseTags(sheet?.tags);
  if (tags.length) payload.tags = tags;

  return payload;
}

/**
 * Has anyone in the CRM got this address already?
 *
 * Deliberately allowed to throw. A lookup that failed is not the same as an
 * address nobody holds, and treating it as one would create a duplicate every
 * time the CRM hiccuped. The caller retries instead.
 */
export async function findLeadByEmail(email, deps = {}) {
  const lookup = deps.fetchCrmUserByEmail || realFetchCrmUserByEmail;
  const match = await lookup(email);
  return match ? { id: Number(match.id) } : null;
}

/** POST /rest/users/new. Never throws on an HTTP status; the caller classifies it. */
export async function createLead(payload, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const baseUrl = (deps.getCrmBaseUrl || realGetCrmBaseUrl)();
  const headers = (deps.authHeaders || realAuthHeaders)();
  const query = (deps.versionQuery || realVersionQuery)();

  const response = await doFetch(`${baseUrl}/users/new?${query}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      userId: null,
      // Capped: this reaches a database column and a browser table, and FXBO
      // answers some refusals with a whole HTML error page.
      detail: `HTTP ${response.status}: ${text.slice(0, 500)}`,
    };
  }

  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const created = Array.isArray(body) ? body[0] : body;
  const userId = Number(created?.id);

  return {
    ok: true,
    status: response.status,
    userId: Number.isFinite(userId) && userId > 0 ? userId : null,
    detail: null,
  };
}
