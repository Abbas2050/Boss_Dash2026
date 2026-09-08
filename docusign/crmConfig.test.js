import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, getCrmBaseUrl, isCrmConfigured, versionQuery } from "./crm.js";
import { buildPendingApplicationsSection } from "./router.js";

const CRM_ENV = ["REST_PROXY_TARGET", "VITE_API_URL", "API_TOKEN", "VITE_API_TOKEN", "API_VERSION", "VITE_API_VERSION"];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(CRM_ENV.map((k) => [k, process.env[k]]));
  for (const k of CRM_ENV) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("getCrmBaseUrl", () => {
  // Regression guard: every shape the legacy variable ever carried must resolve
  // to exactly the base it resolved to before.
  it("derives /rest from a .../rest/transactions URL", () => {
    process.env.VITE_API_URL = "https://portal.skylinkscapital.com/rest/transactions";
    expect(getCrmBaseUrl()).toBe("https://portal.skylinkscapital.com/rest");
  });

  it("strips a bare /transactions suffix", () => {
    process.env.VITE_API_URL = "https://portal.skylinkscapital.com/api/transactions";
    expect(getCrmBaseUrl()).toBe("https://portal.skylinkscapital.com/api");
  });

  it("passes a URL that already ends in /rest through unchanged", () => {
    process.env.VITE_API_URL = "https://portal.skylinkscapital.com/rest";
    expect(getCrmBaseUrl()).toBe("https://portal.skylinkscapital.com/rest");
  });

  it("ignores trailing slashes", () => {
    process.env.VITE_API_URL = "https://portal.skylinkscapital.com/rest/transactions///";
    expect(getCrmBaseUrl()).toBe("https://portal.skylinkscapital.com/rest");
  });

  it("appends /rest to a bare origin, which is the shape REST_PROXY_TARGET has", () => {
    process.env.REST_PROXY_TARGET = "https://portal.skylinkscapital.com";
    expect(getCrmBaseUrl()).toBe("https://portal.skylinkscapital.com/rest");
  });

  it("prefers the canonical REST_PROXY_TARGET over the legacy VITE_API_URL", () => {
    process.env.REST_PROXY_TARGET = "https://crm-staging.example.com";
    process.env.VITE_API_URL = "https://portal.skylinkscapital.com/rest";
    expect(getCrmBaseUrl()).toBe("https://crm-staging.example.com/rest");
  });

  it("falls back to the portal origin rather than throwing when neither is set", () => {
    expect(getCrmBaseUrl()).toBe("https://portal.skylinkscapital.com/rest");
  });
});

describe("CRM credential variable names", () => {
  it("reads the canonical API_TOKEN", () => {
    process.env.API_TOKEN = "canonical-token";
    expect(isCrmConfigured()).toBe(true);
    expect(authHeaders().Authorization).toBe("Bearer canonical-token");
  });

  // The legacy fallback: a server whose .env was never migrated must keep working.
  it("still accepts the legacy VITE_API_TOKEN on its own", () => {
    process.env.VITE_API_TOKEN = "legacy-token";
    expect(isCrmConfigured()).toBe(true);
    expect(authHeaders().Authorization).toBe("Bearer legacy-token");
  });

  it("prefers API_TOKEN when both are set", () => {
    process.env.API_TOKEN = "canonical-token";
    process.env.VITE_API_TOKEN = "legacy-token";
    expect(authHeaders().Authorization).toBe("Bearer canonical-token");
  });

  it("trims a trailing CR left by a Windows-edited .env", () => {
    process.env.API_TOKEN = "canonical-token\r\n";
    expect(authHeaders().Authorization).toBe("Bearer canonical-token");
  });

  it("reports not-configured, and names the variable without echoing any value, when no token is set", () => {
    expect(isCrmConfigured()).toBe(false);
    expect(() => authHeaders()).toThrowError(/API_TOKEN/);
    try {
      authHeaders();
    } catch (error) {
      expect(error.code).toBe("crm_not_configured");
      expect(error.message).not.toContain("Bearer");
    }
  });

  it("reads the version from API_VERSION, falling back to VITE_API_VERSION then 1.0.0", () => {
    expect(versionQuery()).toBe("version=1.0.0");
    process.env.VITE_API_VERSION = "2.0.0";
    expect(versionQuery()).toBe("version=2.0.0");
    process.env.API_VERSION = "3.0.0";
    expect(versionQuery()).toBe("version=3.0.0");
  });
});

describe("buildPendingApplicationsSection", () => {
  it("reports missing configuration as not-configured, never as a count of zero", () => {
    const s = buildPendingApplicationsSection({ configured: false });
    expect(s.pendingApplicationsConfigured).toBe(false);
    expect(s.pendingApplicationsCount).toBeNull();
    expect(s.pendingApplicationsCount).not.toBe(0);
    expect(s.pendingApplicationsError).toBe("crm_not_configured");
  });

  it("reports a genuinely empty CRM result as 0", () => {
    const s = buildPendingApplicationsSection({ configured: true, applications: [] });
    expect(s.pendingApplicationsCount).toBe(0);
    expect(s.pendingApplicationsConfigured).toBe(true);
    expect(s.pendingApplicationsError).toBeNull();
  });

  it("counts the applications it was given", () => {
    const s = buildPendingApplicationsSection({ configured: true, applications: [{ applicationId: "4168" }] });
    expect(s.pendingApplicationsCount).toBe(1);
    expect(s.pendingApplications).toHaveLength(1);
  });

  it("reports a fetch failure as unknown rather than as zero", () => {
    const s = buildPendingApplicationsSection({ configured: true, error: new Error("CRM applications lookup failed (503)") });
    expect(s.pendingApplicationsCount).toBeNull();
    expect(s.pendingApplicationsError).toContain("503");
  });

  it("redacts a credential echoed back inside a CRM error body", () => {
    const s = buildPendingApplicationsSection({
      configured: true,
      error: new Error('CRM applications lookup failed (401): {"api_key":"abcd1234efgh5678"}'),
    });
    expect(s.pendingApplicationsError).not.toContain("abcd1234efgh5678");
    expect(s.pendingApplicationsError).toContain("[REDACTED]");
  });
});
