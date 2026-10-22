import "dotenv/config";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Mints the Google Ads API refresh token, once, and writes it into .env.
 *
 * Run it on a machine with a browser:
 *
 *   node scripts/google-ads-refresh-token.mjs
 *   node scripts/google-ads-refresh-token.mjs path/to/client_secret_*.json
 *
 * It prints a URL, you approve it as the Google user who can see the Sky Links
 * Capital ads account, and the token lands in .env. The token is NOT printed --
 * a refresh token is a long-lived credential and terminal scrollback is the
 * worst place for one. Only its first characters are echoed, as proof.
 *
 * **Approve as a user who can see customer 474-306-7250.** The developer token
 * identifies the application; what the API may actually touch is whatever this
 * Google user can reach. Approving as the wrong account yields a token that
 * authenticates perfectly and then sees no accounts.
 */

/**
 * Both scopes, in one consent, because the integration needs both and asking
 * twice would mean asking a person twice.
 *
 * `adwords` resolves a conversion action's numeric id from its NAME, which is
 * what keeps the three action ids out of configuration. `datamanager` is what
 * actually ingests the conversion: Google closed uploadClickConversions to new
 * integrations on 2026-06-15 and its rejection says so in as many words --
 * "New integrations for uploading click conversions should use the Data Manager
 * API" -- and Google's field-mapping page is explicit that "the Data Manager
 * API requires credentials with a different scope than the Google Ads API".
 *
 * A token minted before 2026-10-22 carries only `adwords` and cannot ingest.
 * Scopes are not additive on an existing token, so that token has to be
 * replaced, not extended.
 */
const SCOPE = ["https://www.googleapis.com/auth/adwords", "https://www.googleapis.com/auth/datamanager"].join(" ");
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ENV_KEY = "GOOGLE_ADS_REFRESH_TOKEN";

const text = (v) => String(v ?? "").trim();

/**
 * The credentials, from .env or from the JSON the Cloud console hands you when
 * the client is created. The JSON is accepted because that download is the only
 * copy of the secret that exists -- the console will not show it again -- so
 * pointing at the file beats retyping it and getting one character wrong.
 */
async function readCredentials(jsonPath) {
  if (jsonPath) {
    const raw = JSON.parse(await readFile(jsonPath, "utf8"));
    // The console writes Desktop clients under `installed`, web ones under `web`.
    const node = raw.installed || raw.web || {};
    return { clientId: text(node.client_id), clientSecret: text(node.client_secret) };
  }
  return {
    clientId: text(process.env.GOOGLE_ADS_CLIENT_ID),
    clientSecret: text(process.env.GOOGLE_ADS_CLIENT_SECRET),
  };
}

/**
 * Updates the key in place, or appends it. Rewriting the whole file from parsed
 * values would drop comments and ordering, and .env here is heavily commented.
 */
async function writeEnvValue(envPath, key, value) {
  let body = "";
  try {
    body = await readFile(envPath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(body)
    ? body.replace(pattern, line)
    : `${body}${body.endsWith("\n") || body === "" ? "" : "\n"}${line}\n`;
  await writeFile(envPath, next, "utf8");
  return pattern.test(body) ? "replaced" : "appended";
}

/**
 * Trades the one-time code for the refresh token and stores it. Shared by both
 * modes so the loopback and manual paths cannot disagree about what a success
 * looks like. `redirectUri` must be byte-identical to the one authorised.
 */
async function exchangeAndStore(code, redirectUri) {
  const tokenResp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenBody = await tokenResp.json().catch(() => ({}));

  if (!tokenResp.ok) {
    // The body carries Google's reason; the secret is not in it.
    console.error(`Token exchange failed: HTTP ${tokenResp.status}`);
    console.error(JSON.stringify(tokenBody, null, 2));
    process.exit(1);
  }

  const refreshToken = text(tokenBody.refresh_token);
  if (!refreshToken) {
    console.error(
      "Google returned no refresh_token. That happens when the account has approved\n" +
        "this client before and the request did not force a new consent. This script\n" +
        "sends prompt=consent, so if you see this, revoke the app at\n" +
        "https://myaccount.google.com/permissions and run it again.",
    );
    process.exit(1);
  }

  const envPath = path.resolve(process.cwd(), ".env");
  const how = await writeEnvValue(envPath, ENV_KEY, refreshToken);

  console.log(`\n${ENV_KEY} ${how} in ${envPath}`);
  console.log(`Starts with: ${refreshToken.slice(0, 8)}...  (${refreshToken.length} chars)`);
  console.log("\nRestart the app so the new value is read, then the Google Ads uploads can run.\n");
}

/**
 * Two modes, because the default one cannot be driven from a phone.
 *
 * The default listens on loopback and catches Google's redirect itself, which
 * requires the browser and this process to be the same machine -- approve on a
 * phone and `localhost` is the phone, so the code never arrives.
 *
 * `--manual` splits that in half. It prints a URL against a FIXED port and
 * stops. You approve anywhere, the browser lands on a dead `localhost` page
 * (a connection error, which is the expected and correct outcome), and its
 * address bar now holds the code. Feed that whole URL back with `--redirect`.
 * The port is fixed because the redirect_uri at exchange must be byte-identical
 * to the one at authorisation, and the two halves are different processes.
 */
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? "");
};
const manualMode = argv.includes("--manual");
const redirectedUrl = flagValue("--redirect");
const jsonPath = argv.find((a) => !a.startsWith("--") && a !== redirectedUrl) || undefined;

// Any free high port; it only has to agree between the two halves, and nothing
// ever listens on it in manual mode.
const MANUAL_PORT = 8765;
// Carries the state between the two invocations. A single process could hold it
// in memory; two cannot, and dropping the check instead would mean exchanging
// whatever code someone handed us.
const statePath = path.join(tmpdir(), "google-ads-oauth-state.json");

const { clientId, clientSecret } = await readCredentials(jsonPath);

if (!clientId || !clientSecret) {
  console.error(
    "Missing credentials. Either set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET\n" +
      "in .env, or pass the client_secret JSON downloaded from the Cloud console:\n" +
      "  node scripts/google-ads-refresh-token.mjs ~/Downloads/client_secret_xxx.json",
  );
  process.exit(1);
}

/** Builds the consent URL. Shared, so the two modes cannot drift apart. */
const buildAuthUrl = (redirectUri, state) =>
  `${AUTH_ENDPOINT}?client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&access_type=offline&prompt=consent` +
  `&state=${state}`;

if (manualMode) {
  const state = randomBytes(16).toString("hex");
  const redirectUri = `http://localhost:${MANUAL_PORT}`;
  await writeFile(statePath, JSON.stringify({ state, redirectUri }), "utf8");
  console.log("\nApprove this on any device -- phone is fine:\n");
  console.log(buildAuthUrl(redirectUri, state));
  console.log(
    "\nGoogle will warn the app is unverified: Advanced, then continue.\n\n" +
      "Afterwards the browser lands on a page that CANNOT LOAD. That is correct --\n" +
      "nothing is listening there. Copy the whole URL out of the address bar and run:\n\n" +
      `  node scripts/google-ads-refresh-token.mjs ${jsonPath ? `"${jsonPath}" ` : ""}--redirect "<paste the url>"\n`,
  );
  process.exit(0);
}

if (redirectedUrl) {
  let saved;
  try {
    saved = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    console.error("No pending authorisation. Run with --manual first.");
    process.exit(1);
  }
  let parsed;
  try {
    parsed = new URL(redirectedUrl.trim());
  } catch {
    console.error("That is not a URL. Paste the whole address bar, including http://localhost.");
    process.exit(1);
  }
  const err = parsed.searchParams.get("error");
  if (err) {
    console.error(`Authorisation failed: ${err}`);
    process.exit(1);
  }
  if (parsed.searchParams.get("state") !== saved.state) {
    console.error("State mismatch -- that URL is from a different run. Start again with --manual.");
    process.exit(1);
  }
  const code = parsed.searchParams.get("code");
  if (!code) {
    console.error("No code in that URL. Copy it after approving, not before.");
    process.exit(1);
  }
  await exchangeAndStore(code, saved.redirectUri);
  process.exit(0);
}

// CSRF protection on the redirect: Google echoes this back and we refuse a
// response that does not carry the value we sent.
const state = randomBytes(16).toString("hex");

const server = createServer();
// Port 0 lets the OS pick a free one. A Desktop OAuth client may use any
// loopback port, so nothing has to be pre-registered in the console.
server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const { port } = server.address();
const redirectUri = `http://localhost:${port}`;

const authUrl =
  `${AUTH_ENDPOINT}?client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  // offline is what asks for a refresh token at all; prompt=consent is what
  // makes Google issue a NEW one. Without it, a second run for an account that
  // has already approved returns an access token and no refresh token, which
  // looks like the script silently failing.
  `&access_type=offline&prompt=consent` +
  `&state=${state}`;

console.log("\nOpen this URL and approve it:\n");
console.log(authUrl);
console.log(
  "\nGoogle will warn that the app is unverified -- expected, because the adwords\n" +
    "scope is not approved for this project. Choose Advanced, then continue.\n",
);

const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("timed out after 5 minutes waiting for the redirect")),
    5 * 60 * 1000,
  );
  server.on("request", (req, res) => {
    const url = new URL(req.url, redirectUri);
    const err = url.searchParams.get("error");
    const got = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    if (err) {
      res.end(`Authorisation failed: ${err}. You can close this tab.`);
      clearTimeout(timer);
      reject(new Error(`authorisation failed: ${err}`));
      return;
    }
    if (returnedState !== state) {
      res.end("State mismatch. You can close this tab.");
      clearTimeout(timer);
      reject(new Error("state mismatch -- the redirect did not come from this run"));
      return;
    }
    res.end("Done. You can close this tab and return to the terminal.");
    clearTimeout(timer);
    resolve(got);
  });
});

server.close();

await exchangeAndStore(code, redirectUri);
