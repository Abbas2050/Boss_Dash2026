export type BreachRow = { login?: string | number };

/** Returns logins present now that were not present before, plus the new login set. */
export function newBreaches(
  prevLogins: Set<string>,
  rows: BreachRow[],
): { newLogins: string[]; nextLogins: Set<string> } {
  const nextLogins = new Set<string>();
  const newLogins: string[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const login = String(r?.login ?? "").trim();
    if (!login) continue;
    nextLogins.add(login);
    if (!prevLogins.has(login)) newLogins.push(login);
  }
  return { newLogins, nextLogins };
}
