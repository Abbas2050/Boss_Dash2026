import express from "express";
import jwt from "jsonwebtoken";

const router = express.Router();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(name, fallback = "") {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value;
}

function getConfiguredClientId() {
  return optional("AUTH_CLIENT_ID", "");
}

function getConfiguredClientSecret() {
  return optional("AUTH_CLIENT_SECRET", "");
}

function getTokenAudience() {
  return optional("AUTH_TOKEN_AUDIENCE", "fxbo-assistant-webhooks");
}

function getTokenIssuer(req) {
  const configured = optional("AUTH_TOKEN_ISSUER", "");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host")}/oauth/token`;
}

router.post("/token", express.urlencoded({ extended: false }), express.json(), (req, res) => {
  try {
    const grantType = String(req.body?.grant_type || req.body?.grantType || "").trim();
    const clientId = String(req.body?.client_id || req.body?.clientId || "").trim();
    const clientSecret = String(req.body?.client_secret || req.body?.clientSecret || "").trim();
    const audience = String(req.body?.audience || "").trim() || getTokenAudience();
    const scope = String(req.body?.scope || "docusign:send").trim() || "docusign:send";

    if (grantType !== "client_credentials") {
      return res.status(400).json({
        error: "unsupported_grant_type",
        error_description: "Only client_credentials is supported.",
      });
    }

    if (!clientId || clientId !== getConfiguredClientId()) {
      return res.status(401).json({
        error: "invalid_client",
        error_description: "Client authentication failed.",
      });
    }

    if (!clientSecret || clientSecret !== getConfiguredClientSecret()) {
      return res.status(401).json({
        error: "invalid_client",
        error_description: "Client authentication failed.",
      });
    }

    const secret = required("AUTH_JWT_SECRET");
    const expiresInSec = Number(optional("AUTH_TOKEN_EXPIRES_IN_SECONDS", "3600")) || 3600;
    const issuer = getTokenIssuer(req);

    const accessToken = jwt.sign(
      {
        sub: clientId,
        scope,
      },
      secret,
      {
        algorithm: "HS256",
        audience,
        issuer,
        expiresIn: expiresInSec,
      }
    );

    return res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresInSec,
      scope,
    });
  } catch (error) {
    return res.status(500).json({
      error: "server_error",
      error_description: error instanceof Error ? error.message : String(error),
    });
  }
});

export function verifyOAuthBearerToken(rawAuthHeader, req) {
  const header = String(rawAuthHeader || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return { ok: false, reason: "missing_bearer_token" };

  try {
    const secret = required("AUTH_JWT_SECRET");
    const audience = getTokenAudience();
    const issuer = getTokenIssuer(req);
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      audience,
      issuer,
    });
    return { ok: true, payload };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export default router;
