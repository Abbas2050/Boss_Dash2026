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
    openai_status: "sent",
    openai_detail: "http 200",
    openai_attempts: 1,
    received_at: "2026-10-13T11:00:00Z",
    ...overrides,
  };
}

/** The four destinations the aggregator has to account for, in the order
 *  stats.js lists them. Every loop below reads this rather than its own copy:
 *  a destination added to the module and not to one of these loops is a
 *  destination that sends and then reports as though it did not exist. */
const ALL = ["meta", "whatsapp", "brevo", "openai"];

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
  it("counts each status separately for each of the four", () => {
    // Every destination given a different status on the same row, so a column
    // read from a neighbour cannot pass. OpenAI's `skipped` is the ordinary case
    // rather than an odd one: `registered` belongs to the website pixel, so
    // every registration is a skip there (spec section 4).
    const rows = [
      row(),
      row({ meta_status: "failed", whatsapp_status: "skipped", brevo_status: "retrying", openai_status: "rejected" }),
      row({ meta_status: "failed", whatsapp_status: "rejected", brevo_status: "sent", openai_status: "skipped" }),
    ];
    const { destinations } = summariseCrmEvents(rows, { now: NOW });
    expect(destinations.meta.sent).toBe(1);
    expect(destinations.meta.failed).toBe(2);
    expect(destinations.whatsapp.skipped).toBe(1);
    expect(destinations.whatsapp.rejected).toBe(1);
    expect(destinations.brevo.retrying).toBe(1);
    expect(destinations.brevo.sent).toBe(2);
    expect(destinations.openai.sent).toBe(1);
    expect(destinations.openai.rejected).toBe(1);
    expect(destinations.openai.skipped).toBe(1);
  });

  it("reports all four destinations, so one that sends cannot report as though it did not exist", () => {
    // The failure this pins: openai dropped from the module's DESTINATIONS
    // keeps sending, retrying and scrubbing exactly as before, and the tab
    // simply never mentions it -- no card, no column, and a page that reads as a
    // healthy three-destination system.
    const { destinations } = summariseCrmEvents([row()], { now: NOW });
    expect(Object.keys(destinations).sort()).toEqual(["brevo", "meta", "openai", "whatsapp"]);
    expect(destinations.openai.sent).toBe(1);
  });

  it("always reports every status key, so a zero renders rather than vanishing", () => {
    const { destinations } = summariseCrmEvents([row()], { now: NOW });
    for (const name of ALL) {
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
    for (const name of ALL) {
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
    expect(destinations.openai.sent).toBe(1);
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

  it("carries the fourth destination's status, reason and attempt count like the other three", () => {
    // Without this the ChatGPT Ads column on every row of the tab is empty --
    // `undefined` for the status, which renders as nothing at all -- while the
    // destination sends normally. The skip reason is the one most rows carry,
    // because `registered` belongs to the website pixel.
    const view = toTableRow(
      row({
        openai_status: "skipped",
        openai_detail: "registered is owned by the website pixel",
        openai_attempts: 0,
      })
    );
    expect(view.openai).toEqual({
      status: "skipped",
      detail: "registered is owned by the website pixel",
      attempts: 0,
    });
  });

  it("gives every destination its own status, so no column can be showing a neighbour's", () => {
    const view = toTableRow(
      row({
        meta_status: "sent",
        whatsapp_status: "retrying",
        brevo_status: "rejected",
        openai_status: "failed",
        openai_detail: "http 503",
        openai_attempts: 2,
      })
    );
    expect(ALL.map((name) => view[name].status)).toEqual(["sent", "retrying", "rejected", "failed"]);
    expect(view.openai.attempts).toBe(2);
  });

  // The reason this work exists: "WhatsApp sent -- ENQUEUED" and "Brevo sent --
  // http 201" prove nothing landed. ENQUEUED is DoubleTick's queue and 201 is an
  // HTTP code; these two fields are the only things on the row that a person can
  // point at.
  describe("the delivery proof", () => {
    it("carries DoubleTick's own report beside the status, not instead of it", () => {
      // Both are wanted. `whatsapp_status` says what DoubleTick answered our
      // request; `delivery` says what DoubleTick later said became of the
      // message. Replacing one with the other would lose the distinction the
      // user objected to being unable to see.
      const view = toTableRow(
        row({
          whatsapp_status: "sent",
          whatsapp_detail: "ENQUEUED",
          whatsapp_delivery_status: "DELIVERED",
          whatsapp_delivery_at: "2026-10-13T11:02:00Z",
        })
      );
      expect(view.whatsapp.status).toBe("sent");
      expect(view.whatsapp.detail).toBe("ENQUEUED");
      expect(view.whatsapp.delivery).toEqual({
        status: "DELIVERED",
        at: "2026-10-13T11:02:00Z",
        detail: null,
      });
    });

    it("passes an unrecognised delivery status through verbatim", () => {
      // The read status string is not documented. Nothing here maps a value to a
      // word of ours, so the one that finally arrives is visible rather than
      // dropped -- the SENT/ENQUEUED lesson, one step along.
      expect(toTableRow(row({ whatsapp_delivery_status: "SeenByRecipient" })).whatsapp.delivery.status).toBe(
        "SeenByRecipient"
      );
    });

    it("reports no report as null, not as an empty string", () => {
      // The page branches on it, and it has to tell "nothing has come back yet"
      // apart from "a status arrived and it was blank".
      const view = toTableRow(row());
      expect(view.whatsapp.delivery).toEqual({ status: null, at: null, detail: null });
      expect(view.brevo.contactId).toBeNull();
    });

    it("carries the failure message DoubleTick sends with a FAILED status", () => {
      const view = toTableRow(
        row({ whatsapp_delivery_status: "FAILED", whatsapp_delivery_detail: "not a WhatsApp number" })
      );
      expect(view.whatsapp.delivery.detail).toBe("not a WhatsApp number");
    });

    it("carries the Brevo contact id, as the string it is stored as", () => {
      // Shown, never used for arithmetic: an id past 2^53 would lose precision
      // as a number, and nothing adds up contact ids.
      expect(toTableRow(row({ brevo_contact_id: 4821 })).brevo.contactId).toBe("4821");
      expect(toTableRow(row({ brevo_contact_id: "4821" })).brevo.contactId).toBe("4821");
    });

    it("gives the proof to the destination it belongs to and to no other", () => {
      // A contact id under WhatsApp, or a delivery report under Brevo, would be
      // a column claiming evidence that destination never had.
      const view = toTableRow(
        row({ brevo_contact_id: "4821", whatsapp_delivery_status: "DELIVERED" })
      );
      expect(view.whatsapp.contactId).toBeUndefined();
      expect(view.brevo.delivery).toBeUndefined();
      expect(view.meta.delivery).toBeUndefined();
      expect(view.openai.contactId).toBeUndefined();
    });
  });

  it("keeps the stage, the id and all three statuses with their reasons", () => {
    // Two different skip reasons on one row, because one column showing the
    // other's detail would pass with a single reason. "lead, not client" is
    // Brevo's since 2026-10-14; WhatsApp no longer has it, and the phone format
    // is the fact about the person it does still refuse on.
    const view = toTableRow(
      row({
        whatsapp_status: "skipped",
        whatsapp_detail: "invalid phone number",
        brevo_status: "skipped",
        brevo_detail: "lead, not client",
      })
    );
    expect(view.stage).toBe("registered");
    expect(view.crmClientId).toBe("88214");
    expect(view.whatsapp).toEqual({
      status: "skipped",
      detail: "invalid phone number",
      attempts: 1,
      // Delivery proof rides alongside the status, never in place of it. A row
      // nothing was sent for has no report, and null says so.
      delivery: { status: null, at: null, detail: null },
    });
    expect(view.brevo).toEqual({
      status: "skipped",
      detail: "lead, not client",
      attempts: 1,
      contactId: null,
    });
    expect(view.meta.status).toBe("sent");
  });

  it("carries scrubbed_at, so the page can tell a scrubbed row from one that never had the value", () => {
    // Masking and scrubbing look identical from the page: both arrive as "".
    // Almost every row the tab shows is scrubbed -- rows settle within a minute --
    // so without this the page shows three blank columns and an operator reads
    // that as a broken feed.
    expect(toTableRow(row({ scrubbed_at: "2026-10-13T11:01:00Z" })).scrubbedAt).toBe("2026-10-13T11:01:00Z");
  });

  it("reports a row that was never scrubbed as null, not undefined", () => {
    // The page branches on it, and JSON drops an undefined key altogether.
    const view = toTableRow(row());
    expect(view.scrubbedAt).toBeNull();
    expect(JSON.parse(JSON.stringify(view))).toHaveProperty("scrubbedAt", null);
  });

  it("shows a scrubbed row's emptied fields as empty, not as the word null", () => {
    // What the row actually looks like after the scrub: the client columns are
    // NULL and only the statistics are left.
    const view = toTableRow(
      row({ first_name: null, last_name: null, email: null, phone: null, scrubbed_at: "2026-10-13T11:01:00Z" })
    );
    expect(view.name).toBe("");
    expect(view.email).toBe("");
    expect(view.phone).toBe("");
    expect(view.crmClientId).toBe("88214");
    expect(view.stage).toBe("registered");
    expect(view.source).toBe("SVG");
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
      { stage: "lead", meta_status: "sent", whatsapp_status: "skipped", brevo_status: "sent", openai_status: "sent", n: 1200 },
      { stage: "registered", meta_status: "failed", whatsapp_status: "sent", brevo_status: "pending", openai_status: "skipped", n: 2000 },
      { stage: "registered", meta_status: "sent", whatsapp_status: "sent", brevo_status: "sent", openai_status: "skipped", n: 1 },
    ];
    const { funnel, destinations } = summariseCrmEvents(groups, { now: NOW, latestReceivedAt: NOW });
    expect(funnel).toEqual({ lead: 1200, registered: 2001, verified: 0, live_account: 0, first_deposit: 0 });
    expect(destinations.meta.sent).toBe(1201);
    expect(destinations.meta.failed).toBe(2000);
    expect(destinations.whatsapp.skipped).toBe(1200);
    expect(destinations.brevo.pending).toBe(2000);
    // The group is the unit, for the fourth status as for the other three: 2,001
    // registrations skipped as the pixel's, in two groups.
    expect(destinations.openai.sent).toBe(1200);
    expect(destinations.openai.skipped).toBe(2001);
  });
});

describe("per-stage health", () => {
  const registeredAt = new Date("2026-10-13T11:00:00Z");

  it("reports a stage that fired and then stopped as stale, while the overall figure stays green", () => {
    // Registrations are still arriving, so the overall figure is fine. The verified
    // rule last fired 96 hours ago, which the overall figure cannot see.
    const { health } = summariseCrmEvents([row({ stage: "registered" })], {
      now: NOW,
      latestReceivedAt: registeredAt,
      latestByStage: [
        { stage: "registered", latest: registeredAt },
        { stage: "verified", latest: new Date("2026-10-09T12:00:00Z") },
      ],
    });
    expect(health.stale).toBe(false);
    expect(health.stages.verified.everSeen).toBe(true);
    expect(health.stages.verified.stale).toBe(true);
    expect(health.stages.verified.ageHours).toBeCloseTo(96, 3);
    expect(health.stages.verified.lastReceivedAt).toBe("2026-10-09T12:00:00.000Z");
    expect(health.stages.registered.stale).toBe(false);
  });

  it("does not call a stage stale for never having fired", () => {
    // lead has no FXBO rule yet. Silence there is expected, not a broken rule.
    const { health } = summariseCrmEvents([row({ stage: "registered" })], {
      now: NOW,
      latestReceivedAt: registeredAt,
      latestByStage: [{ stage: "registered", latest: registeredAt }],
    });
    expect(health.stages.lead).toEqual({ lastReceivedAt: null, ageHours: null, stale: false, everSeen: false });
    expect(health.stages.first_deposit).toEqual({ lastReceivedAt: null, ageHours: null, stale: false, everSeen: false });
  });

  it("reports every stage as never seen on an empty table, while the overall figure is stale", () => {
    const { health } = summariseCrmEvents([], { now: NOW, latestReceivedAt: null, latestByStage: [] });
    expect(health.stale).toBe(true);
    for (const stage of ["lead", "registered", "verified", "live_account", "first_deposit"]) {
      expect(health.stages[stage], stage).toEqual({ lastReceivedAt: null, ageHours: null, stale: false, everSeen: false });
    }
  });
});

describe("per-stage threshold", () => {
  it("judges each stage against the same threshold, and only strictly past it", () => {
    const registeredAt = new Date("2026-10-13T11:00:00Z");
    const { health } = summariseCrmEvents([row({ stage: "registered" })], {
      now: NOW,
      latestReceivedAt: registeredAt,
      latestByStage: [
        { stage: "verified", latest: new Date("2026-10-10T12:00:00Z") }, // exactly 72 hours
        { stage: "live_account", latest: new Date("2026-10-10T11:59:00Z") }, // 72 hours and a minute
      ],
    });
    expect(health.stages.verified.stale).toBe(false);
    expect(health.stages.live_account.stale).toBe(true);
  });
});
