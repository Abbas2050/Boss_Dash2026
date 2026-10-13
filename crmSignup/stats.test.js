// @vitest-environment node
//
// Aggregated in JavaScript rather than SQL on purpose: the volume is low and a
// pure function is testable without a database, which GROUP BY is not.
//
// The health figure is the one that matters most. A broken FXBO rule produces
// no errors anywhere -- it simply stops calling, and nothing else in the system
// would ever notice.
import { describe, it, expect } from "vitest";
import { STALE_HOURS, summariseCrmEvents, toTableRow } from "./stats.js";

const NOW = new Date("2026-10-13T12:00:00Z");

function row(overrides = {}) {
  return {
    id: 1,
    crm_client_id: "88214",
    stage: "registered",
    first_name: "Ali",
    last_name: "Khan",
    email: "ali.khan@example.com",
    phone: "+971507192185",
    record_type: "client",
    source: "SVG",
    meta_status: "sent",
    meta_detail: "http 200",
    meta_attempts: 1,
    whatsapp_status: "sent",
    whatsapp_detail: "SENT",
    whatsapp_attempts: 1,
    brevo_status: "sent",
    brevo_detail: "http 201",
    brevo_attempts: 1,
    received_at: "2026-10-13T11:00:00Z",
    ...overrides,
  };
}

describe("health", () => {
  it("reports how long ago the newest event arrived", () => {
    const { health } = summariseCrmEvents([row()], { now: NOW });
    expect(health.ageHours).toBeCloseTo(1, 3);
    expect(health.stale).toBe(false);
    expect(health.lastReceivedAt).toBe("2026-10-13T11:00:00.000Z");
  });

  it("goes stale past the threshold", () => {
    const old = row({ received_at: "2026-10-09T12:00:00Z" }); // 96 hours
    const { health } = summariseCrmEvents([old], { now: NOW });
    expect(health.ageHours).toBeCloseTo(96, 3);
    expect(health.stale).toBe(true);
  });

  it("is stale only past the threshold, not at it", () => {
    // Exactly 72 hours is the threshold; "past" means strictly after it.
    const atThreshold = row({ received_at: "2026-10-10T12:00:00Z" });
    const justPast = row({ received_at: "2026-10-10T11:59:00Z" });
    expect(summariseCrmEvents([atThreshold], { now: NOW }).health.stale).toBe(false);
    expect(summariseCrmEvents([justPast], { now: NOW }).health.stale).toBe(true);
  });

  it("takes health from the latest timestamp it is given, not from the rows", () => {
    // The route reads the newest event in the whole table, so a short window cannot hide it.
    const latest = new Date("2026-10-12T06:00:00Z"); // 30 hours before NOW
    const { health } = summariseCrmEvents([], { now: NOW, latestReceivedAt: latest });
    expect(health.lastReceivedAt).toBe("2026-10-12T06:00:00.000Z");
    expect(health.ageHours).toBeCloseTo(30, 3);
    expect(health.stale).toBe(false);
  });

  it("reports no events at all as stale, never as healthy", () => {
    // Silence is the symptom of a broken rule, so it must not read as calm.
    const { health } = summariseCrmEvents([], { now: NOW });
    expect(health.lastReceivedAt).toBeNull();
    expect(health.stale).toBe(true);
    expect(health.ageHours).toBeNull();
  });

  it("takes the newest row regardless of the order it was given them", () => {
    const rows = [row({ received_at: "2026-10-10T12:00:00Z" }), row({ received_at: "2026-10-13T11:30:00Z" })];
    expect(summariseCrmEvents(rows, { now: NOW }).health.ageHours).toBeCloseTo(0.5, 3);
  });

  it("ignores a row whose timestamp will not parse", () => {
    const rows = [row({ received_at: "not a date" }), row()];
    expect(summariseCrmEvents(rows, { now: NOW }).health.ageHours).toBeCloseTo(1, 3);
  });
});

describe("funnel", () => {
  it("counts every stage, including the ones with nothing in them", () => {
    // A zero is information: it says that stage's rule is not firing.
    const rows = [row({ stage: "registered" }), row({ stage: "registered" }), row({ stage: "verified" })];
    expect(summariseCrmEvents(rows, { now: NOW }).funnel).toEqual({
      lead: 0,
      registered: 2,
      verified: 1,
      live_account: 0,
      first_deposit: 0,
    });
  });

  it("ignores a stage named like an inherited property, rather than corrupting the funnel", () => {
    const rows = [row({ stage: "constructor" }), row({ stage: "toString" }), row({ stage: "registered" })];
    expect(summariseCrmEvents(rows, { now: NOW }).funnel).toEqual({
      lead: 0,
      registered: 1,
      verified: 0,
      live_account: 0,
      first_deposit: 0,
    });
  });

  it("ignores a stage it does not recognise rather than inventing a key", () => {
    const rows = [row({ stage: "registered" }), row({ stage: "nonsense" })];
    expect(summariseCrmEvents(rows, { now: NOW }).funnel.registered).toBe(1);
    expect("nonsense" in summariseCrmEvents(rows, { now: NOW }).funnel).toBe(false);
  });
});

describe("destinations", () => {
  it("counts each status separately for each of the three", () => {
    const rows = [
      row(),
      row({ meta_status: "failed", whatsapp_status: "skipped", brevo_status: "retrying" }),
      row({ meta_status: "failed", whatsapp_status: "rejected", brevo_status: "sent" }),
    ];
    const { destinations } = summariseCrmEvents(rows, { now: NOW });
    expect(destinations.meta.sent).toBe(1);
    expect(destinations.meta.failed).toBe(2);
    expect(destinations.whatsapp.skipped).toBe(1);
    expect(destinations.whatsapp.rejected).toBe(1);
    expect(destinations.brevo.retrying).toBe(1);
    expect(destinations.brevo.sent).toBe(2);
  });

  it("always reports every status key, so a zero renders rather than vanishing", () => {
    const { destinations } = summariseCrmEvents([row()], { now: NOW });
    for (const name of ["meta", "whatsapp", "brevo"]) {
      expect(Object.keys(destinations[name]).sort(), name).toEqual([
        "failed",
        "invalid",
        "pending",
        "rejected",
        "retrying",
        "sent",
        "skipped",
      ]);
    }
  });

  it("does not invent a key for an unknown status", () => {
    const { destinations } = summariseCrmEvents([row({ meta_status: "weird" })], { now: NOW });
    expect(Object.keys(destinations.meta).sort()).toEqual([
      "failed",
      "invalid",
      "pending",
      "rejected",
      "retrying",
      "sent",
      "skipped",
    ]);
  });

  it("ignores a status named like an inherited property", () => {
    const { destinations } = summariseCrmEvents([row({ meta_status: "constructor", brevo_status: "toString" })], { now: NOW });
    for (const name of ["meta", "whatsapp", "brevo"]) {
      expect(Object.keys(destinations[name]).sort(), name).toEqual([
        "failed",
        "invalid",
        "pending",
        "rejected",
        "retrying",
        "sent",
        "skipped",
      ]);
    }
    expect(destinations.meta.sent).toBe(0);
    expect(destinations.brevo.sent).toBe(0);
    expect(destinations.whatsapp.sent).toBe(1);
  });

  it("counts an unknown status under nothing rather than throwing", () => {
    const { destinations } = summariseCrmEvents([row({ meta_status: "weird" })], { now: NOW });
    expect(destinations.meta.sent).toBe(0);
  });
});

describe("toTableRow", () => {
  it("masks the email and the phone", () => {
    const view = toTableRow(row());
    expect(view.email).toBe("a***@example.com");
    expect(view.phone).toBe("+971***85");
    expect(JSON.stringify(view)).not.toContain("ali.khan@example.com");
    expect(JSON.stringify(view)).not.toContain("+971507192185");
  });

  it("keeps the stage, the id and all three statuses with their reasons", () => {
    const view = toTableRow(row({ whatsapp_status: "skipped", whatsapp_detail: "lead, not client" }));
    expect(view.stage).toBe("registered");
    expect(view.crmClientId).toBe("88214");
    expect(view.whatsapp).toEqual({ status: "skipped", detail: "lead, not client", attempts: 1 });
    expect(view.meta.status).toBe("sent");
    expect(view.brevo.status).toBe("sent");
  });
});

describe("STALE_HOURS", () => {
  it("is 72, matching the DocuSign webhook health window", () => {
    expect(STALE_HOURS).toBe(72);
  });
});

describe("grouped counts", () => {
  it("folds a grouped row as n events, so counts are exact past any cap", () => {
    // 3,201 events in three groups. No table cap applies to these counts, and each
    // count must equal the sum of its group sizes, not the number of groups.
    const groups = [
      { stage: "lead", meta_status: "sent", whatsapp_status: "skipped", brevo_status: "sent", n: 1200 },
      { stage: "registered", meta_status: "failed", whatsapp_status: "sent", brevo_status: "pending", n: 2000 },
      { stage: "registered", meta_status: "sent", whatsapp_status: "sent", brevo_status: "sent", n: 1 },
    ];
    const { funnel, destinations } = summariseCrmEvents(groups, { now: NOW, latestReceivedAt: NOW });
    expect(funnel).toEqual({ lead: 1200, registered: 2001, verified: 0, live_account: 0, first_deposit: 0 });
    expect(destinations.meta.sent).toBe(1201);
    expect(destinations.meta.failed).toBe(2000);
    expect(destinations.whatsapp.skipped).toBe(1200);
    expect(destinations.brevo.pending).toBe(2000);
  });
});
