import "dotenv/config";
import { getDocusignAccessToken } from "../docusign/client.js";

const token = await getDocusignAccessToken();
const base = String(process.env.DOCUSIGN_BASE_URI || "").replace(/\/+$/, "");
const accountId = process.env.DOCUSIGN_ACCOUNT_ID || process.env.DOCUSIGN_API_ACCOUNT_ID;
const templateId = process.env.DOCUSIGN_TEMPLATE_ID;

if (!base || !accountId || !templateId) {
  console.log("Missing one of DOCUSIGN_BASE_URI, DOCUSIGN_ACCOUNT_ID/DOCUSIGN_API_ACCOUNT_ID, DOCUSIGN_TEMPLATE_ID");
  process.exit(1);
}

const templateResp = await fetch(`${base}/restapi/v2.1/accounts/${accountId}/templates/${templateId}`, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  },
});

console.log("TEMPLATE_LOOKUP_STATUS=" + templateResp.status);
console.log(await templateResp.text());

const listResp = await fetch(`${base}/restapi/v2.1/accounts/${accountId}/templates?count=10`, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  },
});

console.log("TEMPLATE_LIST_STATUS=" + listResp.status);
console.log(await listResp.text());
