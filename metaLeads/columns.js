/**
 * Where each field sits in a Meta Lead Ads export, and how to get a usable
 * value out of it.
 *
 * Read BY POSITION, never by header name. All three sheets carry the same
 * eighteen columns in the same order, but the Turkey sheet names columns 13-17
 * in Turkish -- `e-posta`, `telefon_numarası`, `adı`, `soyadı`, `ülke`. A
 * reader keyed on header names works on two sheets and reads blanks on the
 * third, and a blank name and a blank email reach FXBO as a lead nobody can
 * contact. Positions are the thing the three sheets genuinely agree on.
 *
 * Design: ../docs/superpowers/specs/2026-11-06-meta-leads-to-fxbo-design.md
 */
export const COLUMN_INDEX = Object.freeze({
  metaLeadId: 0,
  createdTime: 1,
  adId: 2,
  adName: 3,
  adsetId: 4,
  adsetName: 5,
  campaignId: 6,
  campaignName: 7,
  formId: 8,
  formName: 9,
  isOrganic: 10,
  platform: 11,
  email: 12,
  phone: 13,
  firstName: 14,
  lastName: 15,
  country: 16,
  leadStatus: 17,
});

export const COLUMN_COUNT = Object.keys(COLUMN_INDEX).length;

/**
 * Meta's type guards: `l:` on a lead id, `ag:` `as:` `c:` `f:` on the ad, ad
 * set, campaign and form ids, and `p:` on the phone. Without them Sheets turns
 * a sixteen-digit id into 1.59329614207e+15.
 *
 * Anchored and alternated over the known tokens rather than a general
 * `^[a-z]+:` -- the loose form eats the scheme off anything URL-shaped and the
 * local part off an address like `p:x@y.com`, and a half-eaten email is a lead
 * that silently cannot be reached.
 */
const META_PREFIX = /^(?:l|ag|as|c|f|p):/;

export function stripMetaPrefix(value) {
  const text = String(value ?? "").trim();
  if (!META_PREFIX.test(text)) return text;
  return text.slice(text.indexOf(":") + 1).trim();
}

/**
 * What each position is allowed to be called, for the five columns whose names
 * are localised plus the id. Checked on every poll: if Meta ever reorders the
 * export, the sheet stops instead of filing names into the email column.
 */
export const KNOWN_HEADERS = Object.freeze({
  [COLUMN_INDEX.metaLeadId]: ["id"],
  [COLUMN_INDEX.email]: ["email", "e-posta"],
  [COLUMN_INDEX.phone]: ["phone_number", "telefon_numarası"],
  [COLUMN_INDEX.firstName]: ["first_name", "adı"],
  [COLUMN_INDEX.lastName]: ["last_name", "soyadı"],
  [COLUMN_INDEX.country]: ["country", "ülke"],
});

/** null when the header is one we understand, otherwise why it is not. */
export function headerProblem(headerCells) {
  const cells = Array.isArray(headerCells) ? headerCells : [];
  if (cells.length < COLUMN_COUNT) {
    return `expected ${COLUMN_COUNT} columns, found ${cells.length}`;
  }
  for (const [position, allowed] of Object.entries(KNOWN_HEADERS)) {
    const index = Number(position);
    const actual = String(cells[index] ?? "").trim().toLowerCase();
    if (!allowed.includes(actual)) {
      return `column ${index + 1} reads "${actual}", expected one of: ${allowed.join(", ")}`;
    }
  }
  return null;
}

/**
 * One array of cells to one named object, every value a trimmed string.
 *
 * Never null and never undefined: a caller that has to ask which kind of empty
 * it received is a caller that will get it wrong once.
 */
export function readRow(cells) {
  const source = Array.isArray(cells) ? cells : [];
  const row = {};
  for (const [name, index] of Object.entries(COLUMN_INDEX)) {
    row[name] = stripMetaPrefix(source[index]);
  }
  return row;
}
