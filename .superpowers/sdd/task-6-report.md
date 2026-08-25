# Task 6 report: Triage the dependency advisories

Commit: `c522689` on branch `api-deny-by-default`.

## Before / after advisory counts (`npm audit --production`)

Before: `{"info":0,"low":3,"moderate":5,"high":20,"critical":2,"total":30}`
After: `{"info":0,"low":2,"moderate":2,"high":4,"critical":1,"total":9}`

21 advisories resolved. 9 remain, all requiring a semver-major upgrade
(`--force`), which is out of scope for this task.

## What `npm audit fix` changed

Ran `npm audit fix` (no `--force`). Output: "added 3 packages, removed 1
package, changed 54 packages, and audited 809 packages". This resolved
everything fixable within the existing semver ranges declared in
`package.json`. As a result **`package.json` itself did not change** — only
`package-lock.json` did (473 insertions, 279 deletions; `git diff --stat`).
This is a legitimate outcome: the brief's file list says `package.json` is
modified "via npm", but npm only rewrites `package.json` when a fix requires
widening a declared range, which none of the non-force fixes needed here.

Remaining advisories after the fix, from `npm audit --production` JSON
(`vulnerabilities` map):

| Package | Severity | Direct dep? |
| --- | --- | --- |
| tar | critical | no |
| cacache | high | no |
| make-fetch-happen | high | no |
| node-gyp | high | no |
| sqlite3 | high | yes (`package.json` `dependencies`) |
| react-router | moderate | no |
| react-router-dom | moderate | yes (`package.json` `dependencies`) |
| @tootallnate/once | low | no |
| http-proxy-agent | low | no |

Every one of these is flagged by npm as `fix available via npm audit fix
--force` only, installing either `sqlite3@6.0.1` or `react-router-dom@7.18.2`
— both semver-major, both marked `isSemVerMajor: true` in the audit JSON.
Confirmed via `npm view sqlite3 versions` / `dist-tags` that 5.1.7 is the
newest 5.x release and 6.0.1 is the only version with the tar/node-gyp fix —
there is no non-breaking patch available.

## Verification output

- `npx vitest run`: **31 files passed (31), 267 tests passed (267)** — same
  as the pre-fix baseline, run both before and after the fix.
- `npx tsc -b --noEmit`: exit 0, no output (zero type errors).
- `node --check server.js`: exit 0, no output (valid syntax).

No regressions. The suite was green before, stayed green after.

## How reachability was determined for each remaining high/critical advisory

All five high/critical packages (`tar`, `cacache`, `make-fetch-happen`,
`node-gyp`, `sqlite3`) form one chain, pulled in by `sqlite3`'s native-module
build toolchain. Determined **build-time only**, reachable by no runtime
request path, using:

1. `npm ls tar --all`, `npm ls node-gyp`, `npm ls cacache`, `npm ls
   make-fetch-happen` — each shows the package nested exclusively under
   `sqlite3 > node-gyp > make-fetch-happen > cacache > tar` (plus `sqlite3 >
   tar` directly). No other path into the dependency tree exists for any of
   them.
2. Read `node_modules/sqlite3/lib/sqlite3.js` (sqlite3's `main` entry per its
   own `package.json`): it `require`s only `./sqlite3-binding.js` (the
   compiled native addon) and Node's built-in `events`. It never requires
   `tar`, `node-gyp`, `make-fetch-happen`, or `cacache` — those only run
   inside `node-gyp`'s/`prebuild-install`'s install-time build scripts.
3. `grep -rln sqlite3 --include=*.js --include=*.mjs --include=*.cjs .`
   (excluding `node_modules`) found exactly three importers: `db.js`,
   `db.cjs`, `scripts/cleanup_docusign_test_rows.mjs`.
4. Grepped `server.js`'s own import list (lines 2-36) and every module it
   imports (`api.js`, `agent/router.js`, `auth/router.js`,
   `docusign/router.js`, `oauth/router.js`, `wallet/*`, `alerts/*`,
   `reports/*`) — none reference `db.js`/`db.cjs`. `server.js` uses
   `mysql2/promise` for its own DB access.
5. `grep -rln "db.js\|db.cjs"` shows `db.js`/`db.cjs` are only referenced by
   standalone maintenance scripts run manually by hand
   (`fetch_and_store_clients.js`, `fetch_and_store_clients_plain.cjs`,
   `fetch_and_store_mt5_accounts.cjs`, `insert_mapping.js`) — none started by
   the running server process.

Conclusion: even `sqlite3` itself (a direct production dependency, so caught
by `npm audit --production`) is never loaded by the running server, and the
vulnerable code in `tar`/`cacache`/`make-fetch-happen`/`node-gyp` only
executes during `npm install`'s native-module build step. Nothing in this
group is reachable at runtime. No package fell into a "could not determine"
bucket — reachability was established for all five via `npm ls` plus direct
file reads plus grep of the import graph, not guessed.

`react-router`/`react-router-dom` (moderate, so outside the letter of the
high/critical requirement) and `@tootallnate/once`/`http-proxy-agent` (low)
are recorded in the triage doc's "Accepted" table for completeness, since
Step 4 asks for one row per accepted advisory overall, not just the
high/critical ones.

## Triage doc

Written to `docs/security-dependency-triage.md`. Every example row from the
brief (axios, @remix-run/router, tar, glob) was deleted and replaced with the
9 real remaining advisories, grouped as: Reachable at runtime (empty),
Build-time only (5 rows: tar, cacache, make-fetch-happen, node-gyp, sqlite3),
Could not determine (empty, explicitly stated why), and Accepted (all 9,
with per-row reasoning tied to the no-`--force` constraint).

## Files changed

- `D:\Boss_Dash2026\package-lock.json` — updated by `npm audit fix` (no `package.json` change was needed)
- `D:\Boss_Dash2026\docs\security-dependency-triage.md` — new triage doc
- `D:\Boss_Dash2026\.superpowers\sdd\task-6-report.md` — this report

## Fix round 1

**Commit:** `0ece1ae` on branch `api-deny-by-default`.

**Issue:** The "Reachable at runtime" section stated "None. All five remaining high/critical advisories are build-time only" which could mislead an operator into concluding that no advisories reach runtime. In fact, `react-router-dom` (moderate severity) is shipped in the browser bundle and carries an open-redirect risk, but was listed under "Accepted" without clear cross-reference from the runtime section.

**Fix:** Rewrote the "Reachable at runtime" section header and body to:
- Clarify scope explicitly: "None (high/critical scope)"
- State the fact about react-router-dom: shipped in browser bundle with open-redirect risk
- Cross-reference to "Accepted" section

**Before:**
```
## Reachable at runtime

None. All five remaining high/critical advisories are build-time only (see
below).
```

**After:**
```
## Reachable at runtime

None (high/critical scope). The five high/critical advisories are all build-time only (see below). However, a moderate advisory does reach runtime: `react-router-dom` ^6.30.1 is shipped in the browser bundle and carries an open-redirect risk (listed under Accepted).
```

**Audit verification:** `npm audit --production` confirms counts remain unchanged — low 2, moderate 2, high 4, critical 1 (total 9), matching the doc's stated counts on line 6.
