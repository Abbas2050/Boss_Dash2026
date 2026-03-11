import "dotenv/config";
import { getDocusignAccessToken } from "../docusign/client.js";

const token = await getDocusignAccessToken();
const authBase = process.env.DOCUSIGN_AUTH_BASE || "account-d.docusign.com";

const resp = await fetch(`https://${authBase}/oauth/userinfo`, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  },
});

console.log("USERINFO_STATUS=" + resp.status);
const json = await resp.json();
const accounts = Array.isArray(json?.accounts) ? json.accounts : [];

console.log("ACCOUNTS_COUNT=" + accounts.length);
for (const a of accounts) {
  console.log(JSON.stringify({
    account_id: a.account_id,
    account_name: a.account_name,
    is_default: a.is_default,
    base_uri: a.base_uri,
  }));
}
