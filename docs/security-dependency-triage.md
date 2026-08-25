# Dependency advisory triage

Snapshot: 2026-08-25. Re-run `npm audit --production` before trusting this.

Counts before `npm audit fix`: low 3, moderate 5, high 20, critical 2 (total 30).
Counts after: low 2, moderate 2, high 4, critical 1 (total 9).

`npm audit fix` (non-force) resolved 21 advisories by updating within existing
semver ranges — `package.json` did not need to change; only
`package-lock.json` changed (added 3 packages, removed 1, changed 54). The
full suite (267 tests / 31 files), `npx tsc -b --noEmit`, and
`node --check server.js` all stayed green after the fix.

Every advisory remaining after the fix is `fix available via npm audit fix
--force` only, and every one of those force-fixes is a semver-major bump
(`sqlite3@6.0.1` or `react-router-dom@7.18.2`). Per the task constraint, none
of those were applied.

## Reachable at runtime

None. All five remaining high/critical advisories are build-time only (see
below).

## Build-time only

These are all pulled in through `sqlite3`'s native-module build toolchain
(`node-gyp`, which uses `make-fetch-happen` → `cacache` → `tar`, plus
`sqlite3`'s own direct `tar` dependency used by `prebuild-install`). None of
this code runs when the server or browser bundle executes a request.

How this was determined:
- `npm ls tar --all`, `npm ls node-gyp`, `npm ls cacache`, `npm ls
  make-fetch-happen` all show these packages nested exclusively under
  `sqlite3` (a direct dependency in `package.json`'s `dependencies` block) —
  specifically under `sqlite3 > node-gyp > make-fetch-happen > cacache >
  tar` and `sqlite3 > tar` directly. They have no other entry point into the
  tree.
- `node_modules/sqlite3/lib/sqlite3.js` (the package's `main`, per its
  `package.json`) requires only `./sqlite3-binding.js` (the compiled native
  addon) and Node's built-in `events` module — it does not `require('tar')`,
  `require('node-gyp')`, etc. Those packages only run as part of
  `node-gyp`'s / `prebuild-install`'s install-time build scripts, not
  `sqlite3`'s runtime API surface.
- `grep -rln sqlite3 --include=*.js --include=*.mjs --include=*.cjs .`
  (excluding `node_modules`) shows only three importers: `db.js`, `db.cjs`,
  and `scripts/cleanup_docusign_test_rows.mjs`. None of these are imported
  by `server.js` or by any module `server.js` imports (`api.js`,
  `agent/router.js`, `auth/router.js`, `docusign/router.js`, etc. — checked
  by grepping `server.js`'s own import list and cross-referencing). `db.js`
  is only referenced by standalone maintenance scripts run manually by hand
  (`fetch_and_store_clients.js`, `fetch_and_store_clients_plain.cjs`,
  `fetch_and_store_mt5_accounts.cjs`, `insert_mapping.js`) — none of which
  the running server process starts. `server.js` uses `mysql2/promise` for
  its own database access, not `sqlite3`.
- Net effect: even `sqlite3` itself, though listed under production
  `dependencies` and therefore caught by `npm audit --production`, is never
  loaded by the actual running server, and its vulnerable transitive
  dependencies (`tar`, `cacache`, `make-fetch-happen`, `node-gyp`) execute
  only during `npm install`'s native-module build step, never at request
  time.

| Package | Severity | Advisory | Reached via | Action |
| --- | --- | --- | --- | --- |
| tar | critical | Multiple: hardlink/symlink path traversal, arbitrary file overwrite, DoS via unlimited input, uncaught exceptions, stack-overflow DoS (12 advisories rolled into one, worst is critical) | `sqlite3` (direct prod dep, but unused by server.js) → `node-gyp` → `tar`, and `sqlite3` → `tar` directly, used only by node-gyp's install-time native build / prebuild-install fallback | accept for now; would need `sqlite3@6.0.1` (major, force-only) |
| cacache | high | Depends on vulnerable `tar` | `sqlite3` → `node-gyp` → `make-fetch-happen` → `cacache`, install-time npm package cache used during native build | accept for now; same `sqlite3@6.0.1` fix |
| make-fetch-happen | high | Depends on vulnerable `cacache` and `http-proxy-agent` | `sqlite3` → `node-gyp` → `make-fetch-happen`, install-time HTTP fetcher used by node-gyp | accept for now; same `sqlite3@6.0.1` fix |
| node-gyp | high | Depends on vulnerable `make-fetch-happen` and `tar` | `sqlite3` → `node-gyp`, invoked by npm only when a prebuilt `sqlite3` binary isn't available and native compilation is needed | accept for now; same `sqlite3@6.0.1` fix |
| sqlite3 | high | Flagged solely because it depends on vulnerable `node-gyp` and `tar` (no CVE against sqlite3's own code) | Direct production dependency, imported only by `db.js`/`db.cjs`, which are used only by standalone one-off scripts (`fetch_and_store_clients.js`, `fetch_and_store_mt5_accounts.cjs`, `insert_mapping.js`) — never imported by `server.js` | accept for now; only fix is `sqlite3@6.0.1` (major, force-only, unverified against these scripts) |

## Could not determine

None — reachability was established for every remaining high/critical
advisory using `npm ls`, direct file reads of the package's runtime entry
point, and grep of the server's import graph.

## Accepted

All 9 remaining advisories are accepted for this task, decided by the
implementer per the task's explicit "never run `npm audit fix --force`"
constraint (`npm audit fix --force` installs semver-major versions and this
repo has no end-to-end coverage to catch what that breaks).

| Package | Severity | Advisory | Reason accepted |
| --- | --- | --- | --- |
| tar | critical | Path traversal / DoS family (see above) | Build-time only (see reachability above); only fix is `sqlite3@6.0.1`, a breaking major, forbidden by task constraints |
| cacache | high | Depends on vulnerable `tar` | Same as above |
| make-fetch-happen | high | Depends on vulnerable `cacache`/`http-proxy-agent` | Same as above |
| node-gyp | high | Depends on vulnerable `make-fetch-happen`/`tar` | Same as above |
| sqlite3 | high | Depends on vulnerable `node-gyp`/`tar` | Same as above; also unreachable from the running server |
| react-router | moderate | Open redirect via backslash in `<Link>`/`useNavigate`; constructor injection in SSR error deserialization | Only fix is `react-router-dom@7.18.2`, a breaking major (v6→v7) with no end-to-end coverage of the SPA routing to verify against |
| react-router-dom | moderate | Depends on vulnerable `react-router` | Same as above |
| @tootallnate/once | low | Incorrect control flow scoping | Part of the same `sqlite3`/`node-gyp` build-time chain; only fix is `sqlite3@6.0.1` |
| http-proxy-agent | low | Depends on vulnerable `@tootallnate/once` | Same as above |

Follow-up worth scheduling separately: a dedicated, tested upgrade of
`sqlite3` to 6.0.1 (verifying the standalone scripts that use it still work)
and of `react-router`/`react-router-dom` to 7.x (with a full manual pass over
the SPA's routing), each as its own reviewed change — not bundled into this
non-breaking-only pass.
