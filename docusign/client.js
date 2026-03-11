import jwt from "jsonwebtoken";

let tokenCache = {
  value: null,
  expiresAtMs: 0,
};

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(name, fallback = "") {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value;
}

function normalizePrivateKey(raw) {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

async function exchangeJwtForAccessToken() {
  const authBase = optional("DOCUSIGN_AUTH_BASE", "account-d.docusign.com");
  const integrationKey = required("DOCUSIGN_INTEGRATION_KEY");
  const userId = required("DOCUSIGN_USER_ID");
  const privateKeyPem = normalizePrivateKey(required("DOCUSIGN_PRIVATE_KEY"));

  const assertion = jwt.sign(
    {
      iss: integrationKey,
      sub: userId,
      aud: authBase,
      scope: "signature impersonation",
    },
    privateKeyPem,
    { algorithm: "RS256", expiresIn: "1h" }
  );

  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", assertion);

  const tokenResp = await fetch(`https://${authBase}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!tokenResp.ok) {
    const text = await tokenResp.text().catch(() => "");
    throw new Error(`DocuSign token exchange failed (${tokenResp.status}): ${text}`);
  }

  const tokenJson = await tokenResp.json();
  const accessToken = String(tokenJson.access_token || "");
  const expiresInSec = Number(tokenJson.expires_in || 3600);

  if (!accessToken) throw new Error("DocuSign access token missing in response");

  tokenCache = {
    value: accessToken,
    expiresAtMs: Date.now() + Math.max(60, expiresInSec - 60) * 1000,
  };

  return accessToken;
}

export async function getDocusignAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAtMs) {
    return tokenCache.value;
  }
  return exchangeJwtForAccessToken();
}

async function resolveApiBase(accessToken) {
  const configuredBase = optional("DOCUSIGN_BASE_URI", "");
  const configuredAccountId =
    optional("DOCUSIGN_ACCOUNT_ID", "") ||
    optional("DOCUSIGN_API_ACCOUNT_ID", "");

  if (configuredBase && configuredAccountId) {
    return {
      baseUri: configuredBase.replace(/\/+$/, ""),
      accountId: configuredAccountId,
    };
  }

  const authBase = optional("DOCUSIGN_AUTH_BASE", "account-d.docusign.com");
  const userInfoResp = await fetch(`https://${authBase}/oauth/userinfo`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!userInfoResp.ok) {
    const text = await userInfoResp.text().catch(() => "");
    throw new Error(`DocuSign userinfo failed (${userInfoResp.status}): ${text}`);
  }

  const userInfo = await userInfoResp.json();
  const accounts = Array.isArray(userInfo?.accounts) ? userInfo.accounts : [];
  const target =
    accounts.find((a) => a?.is_default) ||
    accounts[0];

  if (!target?.account_id || !target?.base_uri) {
    throw new Error("DocuSign account_id/base_uri not found in userinfo response");
  }

  return {
    baseUri: String(target.base_uri).replace(/\/+$/, ""),
    accountId: String(target.account_id),
  };
}

export async function createEnvelopeFromTemplate(input) {
  const {
    signerEmail,
    signerName,
    templateId,
    roleName,
    emailSubject,
    applicationId,
  } = input;

  if (!signerEmail) throw new Error("signerEmail is required");
  if (!signerName) throw new Error("signerName is required");

  const effectiveTemplateId = templateId || required("DOCUSIGN_TEMPLATE_ID");
  const effectiveRoleName = roleName || optional("DOCUSIGN_TEMPLATE_ROLE", "Signer");
  const effectiveSubject = emailSubject || optional("DOCUSIGN_EMAIL_SUBJECT", "Please sign your application document");

  const accessToken = await getDocusignAccessToken();
  const { baseUri, accountId } = await resolveApiBase(accessToken);

  const payload = {
    templateId: effectiveTemplateId,
    emailSubject: effectiveSubject,
    templateRoles: [
      {
        email: signerEmail,
        name: signerName,
        roleName: effectiveRoleName,
      },
    ],
    status: "sent",
    customFields: {
      textCustomFields: [
        {
          name: "applicationId",
          required: "false",
          show: "false",
          value: String(applicationId || ""),
        },
      ],
    },
  };

  const createResp = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!createResp.ok) {
    const text = await createResp.text().catch(() => "");
    throw new Error(`DocuSign envelope create failed (${createResp.status}): ${text}`);
  }

  const json = await createResp.json();
  return {
    envelopeId: String(json.envelopeId || ""),
    status: String(json.status || "sent"),
    accountId,
    baseUri,
    payload,
  };
}
