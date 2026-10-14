// @vitest-environment node
//
// Two rules this file exists to hold: the retry clock lives in a column, and
// the three actions never interfere -- a Brevo retry must not move anyone
// else's clock, and a failure in one must not stop the others being reached.
//
// Since 2026-10-14 no single event sends to all three: `registered` sends
// WhatsApp and Brevo while the website pixel owns its Meta conversion, and
// every other stage sends Meta alone. So a test that needs a real send runs at
// the stage that makes it, and several run at both.
import { describe, it, expect, vi } from "vitest";
import { planRetry, rowToFields, processSignupEvent } from "./worker.js";

describe("planRetry", () => {
  const now = new Date("2026-10-12T12:00:00Z");

  it("schedules the next attempt five minutes out while attempts remain", () => {
    const plan = planRetry({ attempts: 0, maxAttempts: 3, retryable: true, now, delayMinutes: 5 });
    expect(plan.status).toBe("retrying");
    expect(plan.attempts).toBe(1);
    expect(plan.nextAttemptAt.toISOString()).toBe("2026-10-12T12:05:00.000Z");
  });

  it("gives up once the attempt budget is spent", () => {
    const plan = planRetry({ attempts: 2, maxAttempts: 3, retryable: true, now, delayMinutes: 5 });
    expect(plan.attempts).toBe(3);
    expect(plan.status).toBe("failed");
    expect(plan.nextAttemptAt).toBeNull();
  });

  it("never schedules a retry for a permanent outcome", () => {
    const plan = planRetry({ attempts: 0, maxAttempts: 3, retryable: false, finalStatus: "rejected", now });
    expect(plan.status).toBe("rejected");
    expect(plan.nextAttemptAt).toBeNull();
  });
});

describe("rowToFields", () => {
  it("turns MySQL 1/0 back into booleans", () => {
    const fields = rowToFields({
      stage: "registered",
      crm_client_id: "88214",
      first_name: "Ali",
      marketing_consent: 1,
      is_ib: 0,
      utm_medium: null,
    });
    expect(fields.marketingConsent).toBe(true);
    expect(fields.isIb).toBe(false);
    expect(fields.utmMedium).toBe("");
  });
});

// The default stage is `registered`, which is WhatsApp's and Brevo's: the website
// pixel owns that stage's Meta conversion, so Meta is sent at the other four and a
// case about Meta's send gives its row `stage: "verified"`. No stage sends to all
// three, so a case that needs every action to send runs once at each of these.
const SENDING_STAGES = ["registered", "verified"];

function row(overrides = {}) {
  return {
    id: 7,
    stage: "registered",
    crm_client_id: "88214",
    first_name: "Ali",
    middle_name: "",
    last_name: "Khan",
    email: "ali@example.com",
    phone: "+971507192185",
    record_type: "client",
    marketing_consent: 1,
    is_ib: 0,
    entity: "SVG",
    source: "SVG",
    language: "en",
    utm_source: "meta",
    utm_medium: "",
    utm_campaign: "",
    referer: "",
    full_link: "",
    fbc: "fb.1.1673035686000.ABC",
    whatsapp_request_id: "req-7",
    received_at: new Date("2026-10-12T12:00:00Z"),
    meta_status: "pending",
    meta_attempts: 0,
    whatsapp_status: "pending",
    whatsapp_attempts: 0,
    brevo_status: "pending",
    brevo_attempts: 0,
    ...overrides,
  };
}

function deps(overrides = {}) {
  return {
    config: {
      metaDatasetId: "692517170017822",
      metaApiVersion: "v26.0",
      metaAccessToken: "tok",
      metaTestEventCode: "",
      waApiKey: "wa-key",
      waTemplateName: "registration_client_v3",
      waTemplateLanguage: "en",
      waTemplateBodyParam: "https://skylinkscapital.com/en/login/",
      waTemplateButtonUrl: "https://skylinkscapital.com/en/login/",
      waFromNumber: "+971507192185",
      waMaxAttempts: 3,
      brevoApiKey: "brevo-key",
      brevoListId: "19",
      skipSources: new Set(),
    },
    sendMeta: vi.fn(async () => ({ status: "sent", retryable: false, detail: "http 200" })),
    sendWhatsapp: vi.fn(async () => ({ status: "sent", retryable: false, detail: "SENT", messageId: "m-1" })),
    upsertBrevo: vi.fn(async () => ({ status: "sent", retryable: false, detail: "http 201" })),
    saveMeta: vi.fn(async () => {}),
    saveWhatsapp: vi.fn(async () => {}),
    saveBrevo: vi.fn(async () => {}),
    newMessageId: () => "uuid-fixed",
    now: () => new Date("2026-10-12T12:00:00Z"),
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

describe("processSignupEvent", () => {
  it("sends WhatsApp and Brevo at registration, and leaves Meta to the website pixel", async () => {
    // The WordPress plugin fires CompleteRegistration in the browser, so sending
    // it from here as well would book one registration as two conversions.
    const d = deps();
    await processSignupEvent(row(), d);
    expect(d.sendWhatsapp).toHaveBeenCalledTimes(1);
    expect(d.upsertBrevo).toHaveBeenCalledTimes(1);
    expect(d.sendMeta).not.toHaveBeenCalled();
    for (const save of [d.saveWhatsapp, d.saveBrevo]) {
      expect(save).toHaveBeenCalledWith(7, expect.objectContaining({ status: "sent" }));
    }
    // Recorded, so the admin view says why rather than showing a blank.
    expect(d.saveMeta).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "skipped", detail: "registered is owned by the website pixel" })
    );
  });

  it("sends Meta at a Meta stage, and records WhatsApp and Brevo as not applicable", async () => {
    const d = deps();
    await processSignupEvent(row({ stage: "verified" }), d);
    expect(d.sendMeta).toHaveBeenCalledTimes(1);
    expect(d.sendWhatsapp).not.toHaveBeenCalled();
    expect(d.upsertBrevo).not.toHaveBeenCalled();
    expect(d.saveMeta).toHaveBeenCalledWith(7, expect.objectContaining({ status: "sent" }));
    for (const save of [d.saveWhatsapp, d.saveBrevo]) {
      expect(save).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ status: "skipped", detail: "stage not applicable" })
      );
    }
  });

  it("sends only Meta at every other stage", async () => {
    for (const stage of ["lead", "verified", "live_account", "first_deposit"]) {
      const d = deps();
      await processSignupEvent(row({ stage }), d);
      expect(d.sendMeta, stage).toHaveBeenCalledTimes(1);
      expect(d.sendWhatsapp, stage).not.toHaveBeenCalled();
      expect(d.upsertBrevo, stage).not.toHaveBeenCalled();
      // Both still land in a stored status, so the admin view shows a complete
      // row rather than a blank one.
      expect(d.saveWhatsapp, stage).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ status: "skipped", detail: "stage not applicable" })
      );
    }
  });

  it("still reaches WhatsApp and Brevo when Meta, the first step, throws outright", async () => {
    // A throw that got out of Meta's step would stop the other two being reached
    // at all. No event sends all three any more, so at a Meta stage "reached"
    // means each records its skip; a throw with a live send behind it is the
    // per-action loop under "separate counters, budgets and failures".
    const d = deps({
      sendMeta: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await processSignupEvent(row({ stage: "verified" }), d);
    expect(d.saveMeta).toHaveBeenCalledWith(7, expect.objectContaining({ status: "retrying" }));
    for (const save of [d.saveWhatsapp, d.saveBrevo]) {
      expect(save).toHaveBeenCalledWith(7, expect.objectContaining({ status: "skipped" }));
    }
  });

  it("gives Meta a stable event id, so a retry cannot double-count", async () => {
    const d = deps();
    await processSignupEvent(row({ stage: "verified" }), d);
    const first = d.sendMeta.mock.calls[0][0].payload.data[0].event_id;
    expect(first).toBe("88214:verified");

    // The same funnel event, retried, must carry the identical id.
    await processSignupEvent(row({ stage: "verified", meta_status: "retrying", meta_attempts: 1 }), d);
    expect(d.sendMeta.mock.calls[1][0].payload.data[0].event_id).toBe(first);
  });

  it("passes the stored fbc to Meta untouched", async () => {
    const d = deps();
    await processSignupEvent(row({ stage: "verified" }), d);
    const { payload } = d.sendMeta.mock.calls[0][0];
    expect(payload.data[0].user_data.fbc).toBe("fb.1.1673035686000.ABC");
  });

  it("uses the row's received_at as the event time, in seconds", async () => {
    const d = deps();
    await processSignupEvent(row({ stage: "verified" }), d);
    const { payload } = d.sendMeta.mock.calls[0][0];
    expect(payload.data[0].event_time).toBe(1791806400);
  });

  it("sends a deposit with no value attached", async () => {
    const d = deps();
    await processSignupEvent(row({ stage: "first_deposit" }), d);
    expect(d.sendMeta).toHaveBeenCalledTimes(1);
    const { payload } = d.sendMeta.mock.calls[0][0];
    expect(payload.data[0].event_name).toBe("Purchase");
    expect("value" in payload.data[0].custom_data).toBe(false);
  });

  it("skips a lead's WhatsApp with the documented reason, but still adds the contact", async () => {
    const d = deps();
    await processSignupEvent(row({ record_type: "lead" }), d);
    expect(d.sendWhatsapp).not.toHaveBeenCalled();
    expect(d.saveWhatsapp).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "skipped", detail: "lead, not client" })
    );
    expect(d.upsertBrevo).toHaveBeenCalledTimes(1);
  });

  it("touches nothing already settled", async () => {
    const d = deps();
    await processSignupEvent(
      row({ meta_status: "sent", whatsapp_status: "sent", brevo_status: "sent" }),
      d
    );
    expect(d.sendMeta).not.toHaveBeenCalled();
    expect(d.sendWhatsapp).not.toHaveBeenCalled();
    expect(d.upsertBrevo).not.toHaveBeenCalled();
    expect(d.saveMeta).not.toHaveBeenCalled();
  });

  it("reuses the row's WhatsApp request id on a retry rather than minting a new one", async () => {
    // The opposite of what the original brief asked for. A send times out after
    // ten seconds, and a timeout does not mean the message was not delivered,
    // so a retry carrying a fresh id would message the client twice.
    //
    // Reusing the id is NECESSARY but not demonstrably sufficient: DoubleTick
    // documents messageId as optional and says nothing about how it treats a
    // repeated one. The cutover settles that with one deliberate retry.
    const ids = [];
    const d = deps({
      newMessageId: () => `uuid-${ids.length}`,
      sendWhatsapp: vi.fn(async ({ payload }) => {
        ids.push(payload.messages[0].messageId);
        return { status: "failed", retryable: true, detail: "http 503", messageId: null };
      }),
    });
    await processSignupEvent(row(), d);
    await processSignupEvent(row({ whatsapp_status: "retrying", whatsapp_attempts: 1 }), d);
    expect(ids).toEqual(["req-7", "req-7"]);
  });

  it("falls back to a generated id when the row carries none", async () => {
    const d = deps({ newMessageId: () => "generated" });
    await processSignupEvent(row({ whatsapp_request_id: null }), d);
    expect(d.sendWhatsapp.mock.calls[0][0].payload.messages[0].messageId).toBe("generated");
  });

  it("stops retrying once the budget is spent", async () => {
    const d = deps({
      sendMeta: vi.fn(async () => ({ status: "failed", retryable: true, detail: "http 500" })),
    });
    await processSignupEvent(row({ stage: "verified", meta_status: "retrying", meta_attempts: 2 }), d);
    expect(d.saveMeta).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "failed", attempts: 3, nextAttemptAt: null })
    );
  });

  it("never logs a full phone number, email address or token", async () => {
    // At both stages: WhatsApp's refusal is where the phone could leak and Meta's
    // failure is where the token could, and no one stage runs both steps.
    for (const stage of SENDING_STAGES) {
      const d = deps({
        sendWhatsapp: vi.fn(async () => ({ status: "rejected", retryable: false, detail: "INVALID", messageId: null })),
        sendMeta: vi.fn(async () => ({ status: "failed", retryable: false, detail: "http 400" })),
      });
      await processSignupEvent(row({ stage }), d);
      // Something was logged, so the absences below are not vacuous.
      expect(d.logger.warn, stage).toHaveBeenCalled();
      const logged = JSON.stringify([
        ...d.logger.warn.mock.calls,
        ...d.logger.error.mock.calls,
        ...d.logger.info.mock.calls,
      ]);
      expect(logged, stage).not.toContain("+971507192185");
      expect(logged, stage).not.toContain("ali@example.com");
      expect(logged, stage).not.toContain("tok");
    }
  });
});

// ---------------------------------------------------------------------------
// Everything below was added after mutation testing. The cases above leave each
// of these open: the comment on each names the mutant that survived without it.
//
// Two sections also pin behaviour the brief's code did not have:
//   * "the attempt is written before the request goes out" -- the brief's
//     planRetry docstring promised it, and design spec section 7 requires it,
//     but the code wrote attempts only after the send returned.
//   * "each action keeps its own clock" -- the sweeper selects a row when ANY
//     action is due, so an action still waiting was being run early.
// ---------------------------------------------------------------------------
import { beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { hashEmail, hashPhone } from "./meta.js";
import { maskEmail, maskPhone } from "./normalise.js";
import { buildBrevoContact, BREVO_CONTACTS_URL } from "./brevo.js";
import { DOUBLETICK_TEMPLATE_URL } from "./whatsapp.js";
import * as store from "./store.js";
import { sweepOnce, kickCrmEventsWorker, startCrmEventsWorker } from "./worker.js";

// The sweeper's own wiring is exercised below with the real senders and a stubbed
// fetch, so the store is the only thing replaced. Hoisted by vitest; every case
// above injects its own dependencies and never reaches it.
vi.mock("./store.js", () => ({
  claimDueEvents: vi.fn(async () => []),
  updateMetaStatus: vi.fn(async () => {}),
  updateWhatsappStatus: vi.fn(async () => {}),
  updateBrevoStatus: vi.fn(async () => {}),
}));

const NOW = new Date("2026-10-12T12:00:00Z");
const IN_FIVE_MINUTES = new Date("2026-10-12T12:05:00Z");
const IN_FLIGHT = "send started; outcome not recorded";

// `stage` is one at which the action really sends. A case about an action's send
// gives its row that stage rather than row()'s default, which is only right for
// WhatsApp and Brevo.
const ACTIONS = [
  { name: "meta", stage: "verified", status: "meta_status", attempts: "meta_attempts", clock: "meta_next_attempt_at", send: "sendMeta", save: "saveMeta" },
  { name: "whatsapp", stage: "registered", status: "whatsapp_status", attempts: "whatsapp_attempts", clock: "whatsapp_next_attempt_at", send: "sendWhatsapp", save: "saveWhatsapp" },
  { name: "brevo", stage: "registered", status: "brevo_status", attempts: "brevo_attempts", clock: "brevo_next_attempt_at", send: "upsertBrevo", save: "saveBrevo" },
];

// All eight subsets of the three actions, so that a step reading another step's
// column is caught whichever way round the columns are crossed.
const SUBSETS = Array.from({ length: 8 }, (_, mask) => ACTIONS.filter((_a, i) => mask & (1 << i)));
const names = (list) => `[${list.map((a) => a.name).join(", ")}]`;

const lastSaved = (save) => save.mock.calls.at(-1)[1];
// deps() fixes WhatsApp's budget at 3, which is also the literal Meta's and
// Brevo's are fixed at. Tests that must tell the two apart give WhatsApp 5.
const withWhatsappBudget = (n) => ({ ...deps().config, waMaxAttempts: n });
const sentOutcome = { status: "sent", retryable: false, detail: "ok", messageId: "m-1" };
const sendingAt = (stage) => ACTIONS.filter((a) => a.stage === stage);

// A failure in `a` must leave the rest of the row alone. Whatever else sends at
// a's stage still sends; the others are still reached, which at that stage means
// each records why it did not.
function expectOthersReached(d, a, label = a.name) {
  for (const other of ACTIONS.filter((x) => x !== a)) {
    const sends = other.stage === a.stage;
    expect(d[other.send], `${label}, ${other.name}`).toHaveBeenCalledTimes(sends ? 1 : 0);
    expect(lastSaved(d[other.save]), `${label}, ${other.name}`).toMatchObject({ status: sends ? "sent" : "skipped" });
  }
}

// No stage sends to all three, so a case that compares what each action did with
// one row runs that row at each of the two stages that between them send every
// action, and takes each action's saves from the run in which it really sent.
// Returns the part of deps() those cases read.
async function processAtEachStage(rowOverrides = {}, depsOverrides = {}) {
  const saved = {};
  for (const stage of SENDING_STAGES) {
    const d = deps(depsOverrides);
    await processSignupEvent(row({ ...rowOverrides, stage }), d);
    for (const a of sendingAt(stage)) saved[a.save] = d[a.save];
  }
  return saved;
}

describe("the attempt is written before the request goes out", () => {
  // The brief's code wrote attempts only after the send returned, so a process
  // that died inside the request left the row exactly as it was found: pending,
  // attempts 0, due again at the next sweep, for ever if it dies the same way.

  it("saves attempts + 1 and a clock five minutes out before each request, and settles after it", async () => {
    // Read at each of the two stages that between them send every action. The
    // skips are in the sequence on purpose: an action that sends nothing writes
    // once, and never around a request.
    const eventsAt = async (stage) => {
      const events = [];
      const saver = (name) =>
        vi.fn(async (_id, patch) => {
          events.push(`save-${name} ${patch.status} #${patch.attempts}`);
        });
      const sender = (name) =>
        vi.fn(async () => {
          events.push(`send-${name}`);
          return sentOutcome;
        });
      const d = deps({
        config: withWhatsappBudget(5),
        saveMeta: saver("meta"),
        saveWhatsapp: saver("whatsapp"),
        saveBrevo: saver("brevo"),
        sendMeta: sender("meta"),
        sendWhatsapp: sender("whatsapp"),
        upsertBrevo: sender("brevo"),
      });
      await processSignupEvent(
        row({ stage, meta_status: "retrying", meta_attempts: 1, whatsapp_status: "retrying", whatsapp_attempts: 1 }),
        d
      );
      return events;
    };
    // Each attempt is counted once: the settling write carries the same number
    // the pre-send write did, not one more.
    expect(await eventsAt("verified")).toEqual([
      "save-meta retrying #2",
      "send-meta",
      "save-meta sent #2",
      "save-whatsapp skipped #1",
      "save-brevo skipped #0",
    ]);
    expect(await eventsAt("registered")).toEqual([
      "save-meta skipped #1",
      "save-whatsapp retrying #2",
      "send-whatsapp",
      "save-whatsapp sent #2",
      "save-brevo retrying #1",
      "send-brevo",
      "save-brevo sent #1",
    ]);
  });

  // [action, attempts already made]. WhatsApp's third attempt is mid-budget (5) but
  // would be the last under a budget of 3, which is what tells the two apart.
  for (const [a, made] of [
    [ACTIONS[0], 1],
    [ACTIONS[1], 2],
    [ACTIONS[2], 1],
  ]) {
    it(`leaves ${a.name} with one attempt spent and its clock set if the process dies in the request`, async () => {
      const d = deps({ config: withWhatsappBudget(5) });
      let heldAtSend;
      d[a.send] = vi.fn(async () => {
        // What the row holds at the instant the request leaves: the state a
        // crash would freeze.
        heldAtSend = d[a.save].mock.calls.map(([, patch]) => patch);
        return sentOutcome;
      });
      await processSignupEvent(row({ stage: a.stage, [a.status]: "retrying", [a.attempts]: made }), d);
      expect(heldAtSend).toEqual([
        { status: "retrying", attempts: made + 1, nextAttemptAt: IN_FIVE_MINUTES, detail: IN_FLIGHT },
      ]);
    });
  }

  for (const [a, lastAttempt, budget] of [
    [ACTIONS[0], 2, 3],
    [ACTIONS[1], 4, 5],
    [ACTIONS[2], 2, 3],
  ]) {
    it(`marks ${a.name}'s final attempt failed before sending, so a crash there cannot loop`, async () => {
      const d = deps({ config: withWhatsappBudget(5) });
      let heldAtSend;
      d[a.send] = vi.fn(async () => {
        heldAtSend = d[a.save].mock.calls.map(([, patch]) => patch);
        return sentOutcome;
      });
      await processSignupEvent(row({ stage: a.stage, [a.status]: "retrying", [a.attempts]: lastAttempt }), d);
      expect(heldAtSend).toEqual([{ status: "failed", attempts: budget, nextAttemptAt: null, detail: IN_FLIGHT }]);
      // ...and the real outcome still replaces it.
      expect(lastSaved(d[a.save])).toMatchObject({ status: "sent", attempts: budget });
    });
  }

  for (const a of ACTIONS) {
    it(`does not send ${a.name} when its attempt could not be recorded, and still runs the others`, async () => {
      const failOnce = vi.fn().mockRejectedValueOnce(new Error("ER_LOCK_WAIT_TIMEOUT")).mockResolvedValue(undefined);
      const d = deps({ [a.save]: failOnce });
      await processSignupEvent(row({ stage: a.stage }), d);
      expect(d[a.send]).not.toHaveBeenCalled();
      expectOthersReached(d, a);
      // The attempt is spent and the retry is scheduled; the next sweep tries again.
      expect(lastSaved(failOnce)).toMatchObject({ status: "retrying", attempts: 1, detail: "step threw" });
    });
  }

  for (const a of ACTIONS) {
    it(`waits for ${a.name}'s attempt to be written before sending, not merely starts the write`, async () => {
      let finishWrite;
      const slow = vi.fn().mockImplementationOnce(() => new Promise((resolve) => (finishWrite = resolve)));
      slow.mockResolvedValue(undefined);
      const d = deps({ [a.save]: slow });
      const running = processSignupEvent(row({ stage: a.stage }), d);
      await new Promise((resolve) => setImmediate(resolve));
      expect(d[a.send], "sent before the write finished").not.toHaveBeenCalled();
      finishWrite();
      await running;
      expect(d[a.send]).toHaveBeenCalledTimes(1);
    });
  }

  it("sends nothing at all when the store cannot be written to", async () => {
    const down = () =>
      vi.fn(async () => {
        throw new Error("pool closed");
      });
    const d = deps({ saveMeta: down(), saveWhatsapp: down(), saveBrevo: down() });
    await expect(processSignupEvent(row(), d)).rejects.toThrow("pool closed");
    for (const a of ACTIONS) expect(d[a.send], a.name).not.toHaveBeenCalled();
  });
});

describe("the pre-send write is the claim", () => {
  // claimDueEvents takes no lock, and an overlapped IIS recycle runs two Node
  // workers whose in-process `sweeping` flags know nothing of each other: the
  // new worker sweeps on its first webhook while the draining one's interval is
  // still firing. The store applies a claiming write only while the action is
  // unsent and its clock is due, so the loser learns it from the row count.
  // Meta is protected by event_id and Brevo's upsert is idempotent; the WhatsApp
  // welcome has no defence of its own at all.

  for (const a of ACTIONS) {
    it(`sends no ${a.name}, and records nothing, when the claiming write matched no row`, async () => {
      const lost = vi.fn(async () => 0);
      const d = deps({ [a.save]: lost });
      const result = await processSignupEvent(row({ stage: a.stage }), d);
      expect(d[a.send]).not.toHaveBeenCalled();
      // One call, the claim itself. An aborted step is not a failure: a status
      // written here would overwrite the owner's, and there is nothing to retry.
      expect(lost).toHaveBeenCalledTimes(1);
      expect(result[a.name]).toBeNull();
      expect(d.logger.error).not.toHaveBeenCalled();
      // The row's other actions are not this sweeper's to abandon.
      expectOthersReached(d, a);
    });
  }

  it("carries the moment it claims for, and claims nothing when it records the outcome", async () => {
    // The outcome write must land on whatever the claim left in the status
    // column -- including the `failed` a final attempt writes before sending.
    const d = await processAtEachStage();
    for (const a of ACTIONS) {
      const [claim, outcome] = d[a.save].mock.calls;
      expect(claim, a.name).toEqual([7, expect.objectContaining({ detail: IN_FLIGHT }), NOW]);
      expect(outcome, a.name).toEqual([7, expect.objectContaining({ status: "sent" })]);
    }
  });

  it("holds a claim the store could not report a count for", async () => {
    // Only a reported 0 is a lost claim. Reading a missing count as lost would
    // stop every send in the module.
    for (const count of [undefined, null]) {
      const d = deps({ saveMeta: vi.fn(async () => count) });
      await processSignupEvent(row({ stage: "verified" }), d);
      expect(d.sendMeta, String(count)).toHaveBeenCalledTimes(1);
    }
  });
});

describe("an outcome write that fails after the send succeeded", () => {
  // The message is gone and the row still says `retrying` with its clock due, so
  // the next sweep sends a second welcome. One dropped connection is enough for
  // this; it needs no second process.
  for (const a of ACTIONS) {
    it(`re-records ${a.name}'s completed send once before letting the error through`, async () => {
      const save = vi.fn();
      save.mockResolvedValueOnce(undefined); // the claim
      save.mockRejectedValueOnce(new Error("ECONNRESET")); // the outcome
      save.mockResolvedValue(undefined); // the second try at the outcome
      const d = deps({ [a.save]: save });
      await processSignupEvent(row({ stage: a.stage }), d);
      expect(save).toHaveBeenCalledTimes(3);
      expect(save.mock.calls[2]).toEqual([7, expect.objectContaining({ status: "sent" })]);
    });

    it(`gives ${a.name} no second write when there was no send to lose`, async () => {
      // A permanent refusal that cannot be written is left to throw on the first
      // failure: repeating it only delays a row nothing was sent for.
      const save = vi.fn();
      save.mockResolvedValueOnce(undefined);
      save.mockRejectedValue(new Error("ECONNRESET"));
      const d = deps({
        [a.save]: save,
        [a.send]: vi.fn(async () => ({ status: "rejected", retryable: false, detail: "http 400", messageId: null })),
      });
      await expect(processSignupEvent(row({ stage: a.stage }), d)).rejects.toThrow("ECONNRESET");
      expect(save).toHaveBeenCalledTimes(2);
    });
  }
});

describe("each action keeps its own clock", () => {
  // claimDueEvents selects a row when ANY of its actions is due. Without this
  // check, one action coming due ran its waiting siblings early, and, with the
  // attempt written before the request, ran an action that was still in flight.
  const clockedRow = (waiting, overrides = {}) => {
    const r = row();
    for (const a of ACTIONS) {
      r[a.status] = "retrying";
      r[a.attempts] = 1;
      // Due at exactly now (the sweeper's own test is `<= now`); waiting is one
      // millisecond later.
      r[a.clock] = new Date(NOW.getTime() + (waiting.includes(a) ? 1 : 0));
    }
    return Object.assign(r, overrides);
  };

  it("runs exactly the actions that are due, whichever of the others are waiting", async () => {
    // At each stage, because no stage sends all three. An action that is due but
    // does not apply still runs, which shows as its one recorded skip.
    for (const stage of SENDING_STAGES) {
      for (const waiting of SUBSETS) {
        const d = deps();
        await processSignupEvent(clockedRow(waiting, { stage }), d);
        for (const a of ACTIONS) {
          const label = `${a.name} at ${stage}, waiting=${names(waiting)}`;
          if (waiting.includes(a)) {
            expect(d[a.send], label).not.toHaveBeenCalled();
            expect(d[a.save], label).not.toHaveBeenCalled();
          } else if (a.stage === stage) {
            expect(d[a.send], label).toHaveBeenCalledTimes(1);
          } else {
            expect(d[a.send], label).not.toHaveBeenCalled();
            expect(d[a.save], label).toHaveBeenCalledTimes(1);
          }
        }
      }
    }
  });

  it("reads a clock given as text as well as one given as a Date", async () => {
    // mysql2 returns a Date unless the pool is configured with dateStrings.
    const d = deps();
    await processSignupEvent(
      clockedRow([], { stage: "verified", meta_next_attempt_at: new Date(NOW.getTime() + 1).toISOString() }),
      d
    );
    expect(d.sendMeta).not.toHaveBeenCalled();
    const due = deps();
    await processSignupEvent(clockedRow([], { stage: "verified", meta_next_attempt_at: NOW.toISOString() }), due);
    expect(due.sendMeta).toHaveBeenCalledTimes(1);
  });

  it("counts a missing clock, and one it cannot read, as due", async () => {
    for (const clock of [null, undefined, "not a date"]) {
      const d = deps();
      await processSignupEvent(clockedRow([], { stage: "verified", meta_next_attempt_at: clock }), d);
      expect(d.sendMeta, String(clock)).toHaveBeenCalledTimes(1);
    }
  });
});

describe("nothing settled is touched again", () => {
  for (const status of ["sent", "skipped", "rejected", "failed", "invalid"]) {
    it(`never re-sends or re-saves an action that is ${status}`, async () => {
      // The brief tests "sent" alone, and checks only saveMeta.
      const d = deps();
      await processSignupEvent(row({ meta_status: status, whatsapp_status: status, brevo_status: status }), d);
      for (const a of ACTIONS) {
        expect(d[a.send], a.name).not.toHaveBeenCalled();
        expect(d[a.save], a.name).not.toHaveBeenCalled();
      }
    });
  }

  it("runs exactly the unsettled actions, reading each from its own status column", async () => {
    const settledAs = { meta: "sent", whatsapp: "rejected", brevo: "invalid" };
    const openAs = { meta: "pending", whatsapp: "retrying", brevo: "pending" };
    // At each stage, because no stage sends all three: an open action that does
    // not apply there is run too, and records a skip instead of sending.
    for (const stage of SENDING_STAGES) {
      for (const settled of SUBSETS) {
        const d = deps();
        const r = row({ stage });
        for (const a of ACTIONS) r[a.status] = settled.includes(a) ? settledAs[a.name] : openAs[a.name];
        await processSignupEvent(r, d);
        for (const a of ACTIONS) {
          const sends = !settled.includes(a) && a.stage === stage;
          expect(d[a.send], `${a.name} at ${stage}, settled=${names(settled)}`).toHaveBeenCalledTimes(sends ? 1 : 0);
        }
      }
    }
  });
});

describe("the three actions keep separate counters, budgets and failures", () => {
  it("counts each action's attempts from its own column, against its own budget", async () => {
    // Three different counts and three different outcomes. WhatsApp's budget is
    // 5 where the other two are fixed at 3, which is the only way to tell a step
    // that reads config.waMaxAttempts from one that has 3 written into it.
    const failing = { status: "failed", retryable: true, detail: "http 503" };
    const d = await processAtEachStage(
      { meta_attempts: 1, whatsapp_attempts: 3, brevo_attempts: 2 },
      {
        config: withWhatsappBudget(5),
        sendMeta: vi.fn(async () => failing),
        sendWhatsapp: vi.fn(async () => ({ ...failing, messageId: null })),
        upsertBrevo: vi.fn(async () => failing),
      }
    );
    expect(lastSaved(d.saveMeta)).toMatchObject({ status: "retrying", attempts: 2, nextAttemptAt: IN_FIVE_MINUTES });
    expect(lastSaved(d.saveWhatsapp)).toMatchObject({ status: "retrying", attempts: 4, nextAttemptAt: IN_FIVE_MINUTES });
    expect(lastSaved(d.saveBrevo)).toMatchObject({ status: "failed", attempts: 3, nextAttemptAt: null });
  });

  // The settling write at each budget's edge. lastSaved, not toHaveBeenCalledWith:
  // the write before the request already says "failed" on the final attempt, so
  // asserting on any call would pass even if the settling write were wrong.
  for (const [a, budget] of [
    [ACTIONS[0], 3],
    [ACTIONS[1], 5],
    [ACTIONS[2], 3],
  ]) {
    it(`settles a retryable failure of ${a.name} as failed on attempt ${budget} and as retrying on the one before`, async () => {
      const failing = { status: "failed", retryable: true, detail: "http 500", messageId: null };
      for (const [made, expected] of [
        [budget - 1, { status: "failed", attempts: budget, nextAttemptAt: null }],
        [budget - 2, { status: "retrying", attempts: budget - 1, nextAttemptAt: IN_FIVE_MINUTES }],
      ]) {
        const d = deps({ config: withWhatsappBudget(5), [a.send]: vi.fn(async () => failing) });
        await processSignupEvent(row({ stage: a.stage, [a.attempts]: made }), d);
        expect(lastSaved(d[a.save]), `${a.name} after ${made}`).toMatchObject(expected);
      }
    });
  }

  it("returns each action's saved result, and null for one that was not run", async () => {
    const d = deps();
    const result = await processSignupEvent(row({ meta_status: "sent", brevo_next_attempt_at: new Date(NOW.getTime() + 1), brevo_status: "retrying" }), d);
    expect(result.meta).toBeNull();
    expect(result.brevo).toBeNull();
    expect(result.whatsapp).toBe(d.saveWhatsapp.mock.calls.at(-1)[1]);
    expect(result.whatsapp).toMatchObject({ status: "sent", messageId: "m-1" });
    // Registration and a Meta stage, since no one event sends all three.
    const registration = await processSignupEvent(row(), deps());
    expect(Object.keys(registration)).toEqual(["meta", "whatsapp", "brevo"]);
    expect(registration.meta).toMatchObject({ status: "skipped", detail: "registered is owned by the website pixel" });
    expect(registration.brevo).toMatchObject({ status: "sent", detail: "http 201" });
    const verified = await processSignupEvent(row({ stage: "verified" }), deps());
    expect(verified.meta).toMatchObject({ status: "sent", detail: "http 200" });
  });

  it("saves each action's own status, reason and attempt count, and WhatsApp's message id", async () => {
    const d = await processAtEachStage(
      { meta_attempts: 1, whatsapp_attempts: 2, brevo_attempts: 0 },
      {
        sendMeta: vi.fn(async () => ({ status: "failed", retryable: false, detail: "meta-reason" })),
        sendWhatsapp: vi.fn(async () => ({ status: "rejected", retryable: false, detail: "wa-reason", messageId: "wamid-9" })),
        upsertBrevo: vi.fn(async () => ({ status: "failed", retryable: true, detail: "brevo-reason" })),
      }
    );
    expect(lastSaved(d.saveMeta)).toEqual({ status: "failed", attempts: 2, nextAttemptAt: null, detail: "meta-reason" });
    expect(lastSaved(d.saveWhatsapp)).toEqual({
      status: "rejected",
      attempts: 3,
      nextAttemptAt: null,
      detail: "wa-reason",
      messageId: "wamid-9",
    });
    expect(lastSaved(d.saveBrevo)).toEqual({
      status: "retrying",
      attempts: 1,
      nextAttemptAt: IN_FIVE_MINUTES,
      detail: "brevo-reason",
    });
  });

  it("settles a success with no clock and the attempt it took", async () => {
    const d = await processAtEachStage({ meta_attempts: 1, whatsapp_attempts: 1, brevo_attempts: 1 });
    expect(lastSaved(d.saveMeta)).toEqual({ status: "sent", attempts: 2, nextAttemptAt: null, detail: "http 200" });
    expect(lastSaved(d.saveWhatsapp)).toEqual({
      status: "sent",
      attempts: 2,
      nextAttemptAt: null,
      detail: "SENT",
      messageId: "m-1",
    });
    expect(lastSaved(d.saveBrevo)).toEqual({ status: "sent", attempts: 2, nextAttemptAt: null, detail: "http 201" });
  });

  for (const [thrower, budget] of [
    [ACTIONS[0], 3],
    [ACTIONS[1], 5],
    [ACTIONS[2], 3],
  ]) {
    it(`turns a throw in ${thrower.name} into a retry, or a failure once its own budget is spent, and runs the others`, async () => {
      for (const [attempts, expected] of [
        [0, { status: "retrying", attempts: 1, nextAttemptAt: IN_FIVE_MINUTES }],
        [budget - 1, { status: "failed", attempts: budget, nextAttemptAt: null }],
      ]) {
        const d = deps({ config: withWhatsappBudget(5) });
        d[thrower.send] = vi.fn(async () => {
          throw new Error("boom");
        });
        await processSignupEvent(row({ stage: thrower.stage, [thrower.attempts]: attempts }), d);

        const label = `${thrower.name} at ${attempts}`;
        expect(lastSaved(d[thrower.save]), label).toEqual({ ...expected, detail: "step threw", messageId: null });
        expect(d.logger.error, label).toHaveBeenCalledWith(expect.stringContaining(`${thrower.name} step threw: boom`));
        expectOthersReached(d, thrower, label);
      }
    });
  }
});

describe("an action that does not apply records why, spends no attempt and sends nothing", () => {
  const cases = [
    { action: ACTIONS[0], why: "meta not configured", config: { metaAccessToken: "   " } },
    { action: ACTIONS[1], why: "whatsapp not configured", config: { waApiKey: "" } },
    { action: ACTIONS[1], why: "invalid phone number", row: { phone: "0507192185" } },
    {
      action: ACTIONS[1],
      why: "source excluded",
      config: { skipSources: new Set(["facebook-form"]) },
      // The entity differs from the source, so reading the wrong one is visible.
      row: { source: "Facebook-Form", entity: "SVG" },
    },
    { action: ACTIONS[2], why: "brevo not configured", config: { brevoApiKey: "" } },
    { action: ACTIONS[2], why: "stage not applicable", row: { stage: "verified" } },
  ];

  for (const { action, why, config = {}, row: rowOverrides = {} } of cases) {
    it(`${action.name}: ${why}`, async () => {
      const d = deps({ config: { ...deps().config, ...config } });
      await processSignupEvent(row({ ...rowOverrides, [action.attempts]: 1 }), d);
      expect(d[action.send]).not.toHaveBeenCalled();
      // One write, not a pre-send write and a settling one: nothing went out, so
      // nothing was attempted. The count is the row's, untouched.
      expect(d[action.save]).toHaveBeenCalledTimes(1);
      const expected = { status: "skipped", detail: why, attempts: 1, nextAttemptAt: null };
      expect(lastSaved(d[action.save])).toEqual(action.name === "whatsapp" ? { ...expected, messageId: null } : expected);
    });
  }
});

describe("the website pixel owns registration, so Meta is skipped there", () => {
  // decideMetaSkip has its own tests. What only the worker can show is what the
  // skip costs: whether it is counted against the retry budget, and whether it
  // leaves a clock behind for the sweeper to come back to.
  for (const [status, made] of [
    ["pending", 0],
    // A registration that had already failed twice at Meta when this rule went
    // in. The skip ends its retries; it does not count as a third attempt.
    ["retrying", 2],
  ]) {
    it(`spends no Meta attempt and sets no Meta clock on a ${status} registration`, async () => {
      const d = deps();
      await processSignupEvent(row({ meta_status: status, meta_attempts: made }), d);
      expect(d.sendMeta).not.toHaveBeenCalled();
      // One write and nothing else: no pre-send write, so no claim and no attempt
      // spent, and the count the row came in with is the count it keeps.
      expect(d.saveMeta.mock.calls).toEqual([
        [7, { status: "skipped", detail: "registered is owned by the website pixel", attempts: made, nextAttemptAt: null }],
      ]);
    });
  }

  it("reports a missing token as a missing token on a registration, not as the pixel's choice", async () => {
    // Both reasons are true here, and "meta not configured" is the one an
    // operator can act on. Reading it as a design choice is how a dead
    // integration looks deliberate in the settings tab.
    const d = deps({ config: { ...deps().config, metaAccessToken: "" } });
    await processSignupEvent(row(), d);
    expect(d.sendMeta).not.toHaveBeenCalled();
    expect(d.saveMeta.mock.calls).toEqual([
      [7, { status: "skipped", detail: "meta not configured", attempts: 0, nextAttemptAt: null }],
    ]);
  });
});

describe("what each provider is handed", () => {
  // Distinct values throughout. In the brief's fixture the WhatsApp sender number
  // equals the row's phone, the body parameter equals the button URL, and the
  // entity equals the source, so each pair could be crossed without a test failing.
  it("gives Meta the dataset, version, token and test code, with email and phone hashed under the right names", async () => {
    const d = deps({ config: { ...deps().config, metaTestEventCode: "TEST4242" } });
    await processSignupEvent(
      row({
        stage: "verified",
        email: "Ali.Khan@Example.com",
        phone: "+971501112233",
        // Not on a whole second: event_time floors, so the event is never dated
        // after the moment it was received.
        received_at: new Date("2026-10-12T12:00:00.999Z"),
      }),
      d
    );
    const arg = d.sendMeta.mock.calls[0][0];
    expect(arg).toEqual({
      datasetId: "692517170017822",
      apiVersion: "v26.0",
      accessToken: "tok",
      payload: expect.any(Object),
    });
    const [event] = arg.payload.data;
    expect(arg.payload.test_event_code).toBe("TEST4242");
    expect(event.user_data.em).toEqual([hashEmail("ali.khan@example.com")]);
    expect(event.user_data.ph).toEqual([hashPhone("+971501112233")]);
    expect(event.event_name).toBe("Client_Verified");
    expect(event.event_time).toBe(1791806400);
  });

  it("gives WhatsApp the key, the template, the sender, the recipient and the frozen id, each in its own place", async () => {
    const d = deps({
      config: {
        ...deps().config,
        waApiKey: "wa-secret",
        waTemplateName: "tmpl_welcome",
        waTemplateLanguage: "en_US",
        waTemplateBodyParam: "https://body.example/",
        waTemplateButtonUrl: "https://button.example/",
        waFromNumber: "+971500000001",
      },
    });
    await processSignupEvent(row({ phone: "+971501112233", language: "ar", first_name: "Ali" }), d);
    const arg = d.sendWhatsapp.mock.calls[0][0];
    expect(arg.apiKey).toBe("wa-secret");
    const [message] = arg.payload.messages;
    expect(message.content.templateName).toBe("tmpl_welcome");
    expect(message.content.language).toBe("en_US");
    expect(message.content.templateData.header.placeholder).toBe("Ali");
    expect(message.content.templateData.body.placeholders).toEqual(["https://body.example/"]);
    expect(message.content.templateData.buttons).toEqual([{ type: "URL", parameter: "https://button.example/" }]);
    expect(message.from).toBe("+971500000001");
    expect(message.to).toBe("+971501112233");
    expect(message.messageId).toBe("req-7");
  });

  it("gives Brevo the key and the contact built from this row, on the configured list, for either consent value", async () => {
    for (const [consent, isIb] of [
      [1, 0],
      [0, 1],
    ]) {
      const d = deps();
      const r = row({
        email: "Ali@Example.com",
        first_name: "Ali",
        middle_name: "Raza",
        last_name: "Khan",
        entity: "ENT-X",
        source: "FORM-Y",
        language: "ar",
        utm_source: "meta",
        utm_medium: "cpc",
        utm_campaign: "oct",
        referer: "https://ref.example/",
        marketing_consent: consent,
        is_ib: isIb,
      });
      await processSignupEvent(r, d);
      const arg = d.upsertBrevo.mock.calls[0][0];
      expect(arg.apiKey).toBe("brevo-key");
      expect(arg.contact).toEqual(buildBrevoContact(rowToFields(r), { listId: "19" }));
      expect(arg.contact.listIds).toEqual([19]);
      expect(arg.contact.email).toBe("ali@example.com");
      expect(arg.contact.attributes).toMatchObject({
        OPT_IN: consent === 1,
        IS_IB: isIb === 1,
        ENTITY: "ENT-X",
        FORM_NAME: "FORM-Y",
        EXT_ID: "88214",
      });
    }
  });
});

describe("rowToFields, field by field", () => {
  // The brief's case maps six of eighteen columns.
  it("maps every column to its own field, trimmed", () => {
    expect(
      rowToFields({
        stage: " verified ",
        crm_client_id: " c-1 ",
        first_name: " f ",
        middle_name: " m ",
        last_name: " l ",
        email: " e@x.com ",
        phone: " +9715 ",
        record_type: " client ",
        marketing_consent: 1,
        is_ib: 1,
        entity: " ent ",
        source: " src ",
        language: " lang ",
        utm_source: " us ",
        utm_medium: " um ",
        utm_campaign: " uc ",
        referer: " ref ",
        full_link: " link ",
      })
    ).toEqual({
      stage: "verified",
      crmClientId: "c-1",
      firstName: "f",
      middleName: "m",
      lastName: "l",
      email: "e@x.com",
      phone: "+9715",
      recordType: "client",
      marketingConsent: true,
      isIb: true,
      entity: "ent",
      source: "src",
      language: "lang",
      utmSource: "us",
      utmMedium: "um",
      utmCampaign: "uc",
      referer: "ref",
      fullLink: "link",
    });
  });

  it("reads a flag that arrives as text by its value, not by being non-empty", () => {
    // A string "0" is truthy. Consent read as true when it is stored false would
    // put a client who declined onto a marketing list as opted in.
    expect(rowToFields({ marketing_consent: "0", is_ib: "0" })).toMatchObject({ marketingConsent: false, isIb: false });
    expect(rowToFields({ marketing_consent: "1", is_ib: "1" })).toMatchObject({ marketingConsent: true, isIb: true });
  });

  it("reads an empty row as an empty lead with both flags off", () => {
    expect(rowToFields({})).toMatchObject({ recordType: "lead", marketingConsent: false, isIb: false, email: "", stage: "" });
    expect(rowToFields(undefined).recordType).toBe("lead");
    expect(rowToFields({ record_type: null }).recordType).toBe("lead");
  });
});

describe("what is logged", () => {
  const failing = (status, detail, extra = {}) => vi.fn(async () => ({ status, retryable: false, detail, ...extra }));

  it("names each action that did not succeed with the masked contact and the provider's reason", async () => {
    // maskEmail / maskPhone must actually hide something for the check below to mean anything.
    expect(maskEmail("ali@example.com")).not.toBe("ali@example.com");
    expect(maskPhone("+971507192185")).not.toBe("+971507192185");
    // At each stage, since no one event runs all three: Meta's line at a Meta
    // stage, WhatsApp's and Brevo's at registration.
    for (const [stage, expected] of [
      ["verified", [`[crm-events] meta failed for ${maskEmail("ali@example.com")}: meta-reason`]],
      [
        "registered",
        [
          `[crm-events] whatsapp rejected for ${maskPhone("+971507192185")}: wa-reason`,
          `[crm-events] brevo failed for ${maskEmail("ali@example.com")}: brevo-reason`,
        ],
      ],
    ]) {
      const d = deps({
        sendMeta: failing("failed", "meta-reason"),
        sendWhatsapp: failing("rejected", "wa-reason", { messageId: null }),
        upsertBrevo: failing("failed", "brevo-reason"),
      });
      await processSignupEvent(row({ stage }), d);
      expect(d.logger.warn.mock.calls.map(([line]) => line), stage).toEqual(expected);
      const everything = JSON.stringify([...d.logger.warn.mock.calls, ...d.logger.error.mock.calls, ...d.logger.info.mock.calls]);
      expect(everything, stage).not.toContain("ali@example.com");
      expect(everything, stage).not.toContain("+971507192185");
    }
  });

  it("logs nothing when every action that sends succeeds", async () => {
    // At both stages, so Meta's success is held to the same silence as the others'.
    for (const stage of SENDING_STAGES) {
      const d = deps();
      await processSignupEvent(row({ stage }), d);
      expect(d.logger.warn, stage).not.toHaveBeenCalled();
      expect(d.logger.error, stage).not.toHaveBeenCalled();
    }
  });

  it("logs a retry as a retry", async () => {
    const retry = vi.fn(async () => ({ status: "failed", retryable: true, detail: "http 503" }));
    // Meta's retry at a Meta stage and Brevo's at registration, since no one event
    // reaches both. WhatsApp's success beside Brevo's retry is not logged.
    for (const [stage, who] of [
      ["verified", "meta"],
      ["registered", "brevo"],
    ]) {
      const d = deps({ sendMeta: retry, sendWhatsapp: vi.fn(async () => sentOutcome), upsertBrevo: retry });
      await processSignupEvent(row({ stage }), d);
      const lines = d.logger.warn.mock.calls.map(([line]) => line);
      expect(lines, stage).toHaveLength(1);
      expect(lines[0], stage).toContain(`${who} retrying`);
    }
  });
});

// ---------------------------------------------------------------------------
// The code production runs. Every case above injects its own dependencies, and
// the sweeper, the kick, the timer and the environment read are what nothing
// above executes.
// ---------------------------------------------------------------------------
describe("the production wiring", () => {
  const ENV = [
    "META_DATASET_ID",
    "META_API_VERSION",
    "META_CAPI_ACCESS_TOKEN",
    "META_TEST_EVENT_CODE",
    "WA_API_KEY",
    "WA_TEMPLATE_NAME",
    "WA_TEMPLATE_LANGUAGE",
    "WA_TEMPLATE_BODY_PARAM",
    "WA_TEMPLATE_BUTTON_URL",
    "WA_FROM_NUMBER",
    "WA_MAX_ATTEMPTS",
    "BREVO_API_KEY",
    "BREVO_LIST_ID",
    "SKIP_SOURCES",
    "CRM_EVENTS_WORKER_ENABLED",
    "CRM_EVENTS_WORKER_INTERVAL_SECONDS",
    "CRM_SEND_TIMEOUT_MS",
  ];
  const SECRETS = { META_CAPI_ACCESS_TOKEN: "meta-secret", WA_API_KEY: "wa-secret", BREVO_API_KEY: "brevo-secret" };

  let savedEnv;
  let fetchMock;
  let spies;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];

    for (const fn of Object.values(store)) fn.mockReset();
    store.claimDueEvents.mockResolvedValue([]);
    for (const fn of [store.updateMetaStatus, store.updateWhatsappStatus, store.updateBrevoStatus]) {
      fn.mockResolvedValue(undefined);
    }

    fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.startsWith("https://graph.facebook.com/")) return { status: 200, json: async () => ({ events_received: 1 }) };
      if (u === DOUBLETICK_TEMPLATE_URL) {
        return { status: 200, json: async () => ({ messages: [{ status: "SENT", messageId: "wamid-live" }] }) };
      }
      if (u === BREVO_CONTACTS_URL) return { status: 201, json: async () => ({ id: 1 }) };
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    spies = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    for (const k of ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const spy of Object.values(spies)) spy.mockRestore();
  });

  const setEnv = (values) => Object.assign(process.env, values);
  const fetched = (prefix) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(prefix));
  const bodyOf = ([, init]) => JSON.parse(init.body);
  const liveRow = (overrides = {}) => row({ phone: "+971501112233", ...overrides });

  describe("with only the three secrets set", () => {
    it("at registration, sends WhatsApp and Brevo to the real providers with the documented defaults, never calls Meta, and records each in its own column", async () => {
      setEnv(SECRETS);
      store.claimDueEvents.mockResolvedValue([liveRow()]);
      await sweepOnce();

      // The token is set, so the only reason Graph is not called is that the
      // website pixel owns this stage. Nothing else was fetched either.
      expect(fetched("https://graph.facebook.com/")).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [waCall] = fetched(DOUBLETICK_TEMPLATE_URL);
      expect(waCall[1].headers.Authorization).toBe("wa-secret");
      const [message] = bodyOf(waCall).messages;
      expect(message.content.templateName).toBe("registration_client_v3");
      expect(message.content.language).toBe("en");
      expect(message.content.templateData.body.placeholders).toEqual(["https://skylinkscapital.com/en/login/"]);
      expect(message.content.templateData.buttons[0].parameter).toBe("https://skylinkscapital.com/en/login/");
      expect(message.from).toBe("+971507192185");
      expect(message.to).toBe("+971501112233");
      expect(message.messageId).toBe("req-7");

      const [brevoCall] = fetched(BREVO_CONTACTS_URL);
      expect(brevoCall[1].headers["api-key"]).toBe("brevo-secret");
      expect(bodyOf(brevoCall).listIds).toBeUndefined();

      // Each save reaches its own column's writer: the pre-send write, then the outcome.
      for (const [writer, detail] of [
        [store.updateWhatsappStatus, "SENT"],
        [store.updateBrevoStatus, "http 201"],
      ]) {
        expect(writer).toHaveBeenCalledTimes(2);
        // The claim carries the sweeper's own clock; the outcome write does not.
        expect(writer.mock.calls[0]).toEqual([
          7,
          expect.objectContaining({ status: "retrying", attempts: 1 }),
          expect.any(Date),
        ]);
        expect(writer.mock.calls[1]).toEqual([7, expect.objectContaining({ status: "sent", attempts: 1, detail })]);
      }
      expect(store.updateWhatsappStatus.mock.calls[1][1].messageId).toBe("wamid-live");

      // Meta's column is not left blank: one write, the skip, with no pre-send
      // write ahead of it and no clock on it.
      expect(store.updateMetaStatus.mock.calls).toEqual([
        [7, { status: "skipped", detail: "registered is owned by the website pixel", attempts: 0, nextAttemptAt: null }],
      ]);
    });

    it("at a Meta stage, sends Meta to the real provider with the documented defaults, calls neither WhatsApp nor Brevo, and records each in its own column", async () => {
      setEnv(SECRETS);
      store.claimDueEvents.mockResolvedValue([liveRow({ stage: "verified" })]);
      await sweepOnce();

      const [metaCall] = fetched("https://graph.facebook.com/");
      expect(metaCall[0]).toBe("https://graph.facebook.com/v26.0/692517170017822/events?access_token=meta-secret");
      expect(bodyOf(metaCall).test_event_code).toBeUndefined();
      // WhatsApp and Brevo are configured too, so it is the stage alone that keeps
      // them quiet.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The pre-send write, then the outcome, the same shape the others have.
      expect(store.updateMetaStatus).toHaveBeenCalledTimes(2);
      expect(store.updateMetaStatus.mock.calls[0]).toEqual([
        7,
        expect.objectContaining({ status: "retrying", attempts: 1 }),
        expect.any(Date),
      ]);
      expect(store.updateMetaStatus.mock.calls[1]).toEqual([
        7,
        expect.objectContaining({ status: "sent", attempts: 1, detail: "http 200" }),
      ]);

      for (const writer of [store.updateWhatsappStatus, store.updateBrevoStatus]) {
        expect(writer).toHaveBeenCalledTimes(1);
        expect(writer.mock.calls[0]).toEqual([
          7,
          expect.objectContaining({ status: "skipped", detail: "stage not applicable", attempts: 0, nextAttemptAt: null }),
        ]);
      }
    });

    it("skips all three, and sends nothing, when nothing is configured", async () => {
      store.claimDueEvents.mockResolvedValue([liveRow()]);
      await sweepOnce();
      expect(fetchMock).not.toHaveBeenCalled();
      const settled = (writer) => writer.mock.calls.at(-1)[1];
      expect(settled(store.updateMetaStatus)).toMatchObject({ status: "skipped", detail: "meta not configured" });
      expect(settled(store.updateWhatsappStatus)).toMatchObject({ status: "skipped", detail: "whatsapp not configured" });
      expect(settled(store.updateBrevoStatus)).toMatchObject({ status: "skipped", detail: "brevo not configured" });
    });

    it("runs on the real clock and logs through the console, masked", async () => {
      setEnv(SECRETS);
      fetchMock.mockImplementation(async (url) =>
        String(url).startsWith("https://graph.facebook.com/")
          ? { status: 503, json: async () => ({}) }
          : { status: 201, json: async () => ({}) }
      );
      store.claimDueEvents.mockResolvedValue([liveRow({ stage: "verified" })]);
      const before = Date.now();
      await sweepOnce();
      const after = Date.now();

      const retry = store.updateMetaStatus.mock.calls.at(-1)[1];
      expect(retry.status).toBe("retrying");
      expect(retry.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000);
      expect(retry.nextAttemptAt.getTime()).toBeLessThanOrEqual(after + 5 * 60_000);
      expect(spies.warn).toHaveBeenCalledWith(`[crm-events] meta retrying for ${maskEmail("ali@example.com")}: http 503`);
    });

    it("mints a fresh message id only for a row that carries none", async () => {
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      setEnv({ WA_API_KEY: "wa-secret" });
      store.claimDueEvents.mockResolvedValue([
        liveRow({ id: 21, whatsapp_request_id: null }),
        liveRow({ id: 22, whatsapp_request_id: null }),
        liveRow({ id: 23, whatsapp_request_id: "req-23" }),
      ]);
      await sweepOnce();
      const ids = fetched(DOUBLETICK_TEMPLATE_URL).map((call) => bodyOf(call).messages[0].messageId);
      expect(ids[0]).toMatch(UUID);
      expect(ids[1]).toMatch(UUID);
      expect(ids[0]).not.toBe(ids[1]);
      expect(ids[2]).toBe("req-23");
    });
  });

  it("reads every setting from its own environment variable", async () => {
    setEnv({
      ...SECRETS,
      META_DATASET_ID: "111222333",
      META_API_VERSION: "v99.0",
      META_TEST_EVENT_CODE: "TEST777",
      WA_TEMPLATE_NAME: "tmpl_x",
      WA_TEMPLATE_LANGUAGE: "ar",
      WA_TEMPLATE_BODY_PARAM: "https://body.example/",
      WA_TEMPLATE_BUTTON_URL: "https://button.example/",
      WA_FROM_NUMBER: "+971500000001",
      BREVO_LIST_ID: "42",
    });
    // Two events, since no one stage reaches every provider: registration is where
    // WhatsApp and Brevo send, and a Meta stage is where Meta does.
    store.claimDueEvents.mockResolvedValue([liveRow(), liveRow({ id: 8, stage: "verified" })]);
    await sweepOnce();

    const [metaCall] = fetched("https://graph.facebook.com/");
    expect(metaCall[0]).toBe("https://graph.facebook.com/v99.0/111222333/events?access_token=meta-secret");
    expect(bodyOf(metaCall).test_event_code).toBe("TEST777");

    const [message] = bodyOf(fetched(DOUBLETICK_TEMPLATE_URL)[0]).messages;
    expect(message.content.templateName).toBe("tmpl_x");
    expect(message.content.language).toBe("ar");
    expect(message.content.templateData.body.placeholders).toEqual(["https://body.example/"]);
    expect(message.content.templateData.buttons[0].parameter).toBe("https://button.example/");
    expect(message.from).toBe("+971500000001");

    expect(bodyOf(fetched(BREVO_CONTACTS_URL)[0]).listIds).toEqual([42]);
  });

  it("reads SKIP_SOURCES, so an excluded source gets no WhatsApp but still gets the rest", async () => {
    setEnv({ ...SECRETS, SKIP_SOURCES: "Other-Form, svg" });
    // Two events from the excluded source, since no one stage reaches all three
    // destinations: registration is where WhatsApp and Brevo send, and a Meta
    // stage is where Meta does.
    const excluded = { source: "SVG", entity: "Other" };
    store.claimDueEvents.mockResolvedValue([liveRow(excluded), liveRow({ ...excluded, id: 8, stage: "verified" })]);
    await sweepOnce();
    expect(fetched(DOUBLETICK_TEMPLATE_URL)).toHaveLength(0);
    expect(store.updateWhatsappStatus.mock.calls.find(([id]) => id === 7)[1]).toMatchObject({
      status: "skipped",
      detail: "source excluded",
    });
    expect(fetched("https://graph.facebook.com/")).toHaveLength(1);
    expect(fetched(BREVO_CONTACTS_URL)).toHaveLength(1);
  });

  it("reads WA_MAX_ATTEMPTS, falling back to three for anything unusable", async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url) === DOUBLETICK_TEMPLATE_URL
        ? { status: 503, json: async () => ({}) }
        : { status: 200, json: async () => ({ events_received: 1 }) }
    );
    // [setting, attempts already made, status expected after this one].
    for (const [setting, made, expected] of [
      [undefined, 1, "retrying"],
      [undefined, 2, "failed"],
      ["5", 3, "retrying"],
      ["5", 4, "failed"],
      ["2", 1, "failed"],
      ["0", 1, "retrying"],
      ["0", 2, "failed"],
      ["abc", 1, "retrying"],
      ["abc", 2, "failed"],
    ]) {
      store.updateWhatsappStatus.mockClear();
      if (setting === undefined) delete process.env.WA_MAX_ATTEMPTS;
      else process.env.WA_MAX_ATTEMPTS = setting;
      setEnv({ WA_API_KEY: "wa-secret" });
      store.claimDueEvents.mockResolvedValue([liveRow({ whatsapp_attempts: made })]);
      await sweepOnce();
      expect(store.updateWhatsappStatus.mock.calls.at(-1)[1].status, `WA_MAX_ATTEMPTS=${setting}, ${made} made`).toBe(expected);
    }
  });

  describe("sweepOnce", () => {
    it("asks for at most 25 rows due now, and reports how many it handled", async () => {
      store.claimDueEvents.mockResolvedValue([liveRow({ id: 1 }), liveRow({ id: 2 })]);
      const before = Date.now();
      const outcome = await sweepOnce();
      const after = Date.now();
      expect(outcome).toEqual({ processed: 2 });
      const [limit, at] = store.claimDueEvents.mock.calls[0];
      expect(limit).toBe(25);
      expect(at).toBeInstanceOf(Date);
      expect(at.getTime()).toBeGreaterThanOrEqual(before);
      expect(at.getTime()).toBeLessThanOrEqual(after);
    });

    it("takes no second sweep while one is running, and takes the next one after", async () => {
      // The guard claimDueEvents' docstring leans on: with no lock in the SQL,
      // this flag is all that stops two sweeps sending the same welcome.
      let release;
      store.claimDueEvents.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([]))));
      const first = sweepOnce();
      expect(await sweepOnce()).toEqual({ skipped: true });
      expect(store.claimDueEvents).toHaveBeenCalledTimes(1);
      release();
      expect(await first).toEqual({ processed: 0 });
      expect(await sweepOnce()).toEqual({ processed: 0 });
      expect(store.claimDueEvents).toHaveBeenCalledTimes(2);
    });

    it("releases the guard when the query fails, instead of locking sweeps out until the next restart", async () => {
      store.claimDueEvents.mockRejectedValueOnce(new Error("ECONNRESET"));
      await expect(sweepOnce()).rejects.toThrow("ECONNRESET");
      expect(await sweepOnce()).toEqual({ processed: 0 });
    });

    it("carries on with the next row when one row's write fails, and says which row", async () => {
      setEnv(SECRETS);
      // Fails every write for row 11 and none for the rest. (A single failure would be
      // absorbed: the pre-send write is inside the step, and its retry write succeeds.)
      store.updateMetaStatus.mockImplementation(async (id) => {
        if (id === 11) throw new Error("ER_LOCK_WAIT_TIMEOUT");
      });
      // Meta's write is the one that fails, so row 11 is a Meta stage. Behind it, a
      // row of each kind: no one stage has Meta's send and Brevo's both to show.
      store.claimDueEvents.mockResolvedValue([
        liveRow({ id: 11, stage: "verified" }),
        liveRow({ id: 12, stage: "verified" }),
        liveRow({ id: 13 }),
      ]);
      expect(await sweepOnce()).toEqual({ processed: 3 });
      expect(spies.error).toHaveBeenCalledWith("[crm-events] row 11 failed: ER_LOCK_WAIT_TIMEOUT");
      expect(store.updateMetaStatus.mock.calls.filter(([id]) => id === 12).at(-1)).toEqual([
        12,
        expect.objectContaining({ status: "sent" }),
      ]);
      expect(store.updateBrevoStatus.mock.calls.at(-1)).toEqual([13, expect.objectContaining({ status: "sent" })]);
      // Nothing was sent for row 11: its first write failed before any request.
      expect(fetched("https://graph.facebook.com/")).toHaveLength(1);
    });
  });

  describe("CRM_EVENTS_WORKER_ENABLED", () => {
    // The flag used to be read only where the timer starts. kickCrmEventsWorker
    // comes straight to sweepOnce on every webhook, so setting it to false left
    // every new event -- and every due retry the sweep picked up with it --
    // going out, and there was no safe way to pause sending during an incident.

    it("stops the sweep itself, so nothing is sent and nothing is written", async () => {
      setEnv({ ...SECRETS, CRM_EVENTS_WORKER_ENABLED: "false" });
      store.claimDueEvents.mockResolvedValue([liveRow()]);
      expect(await sweepOnce()).toEqual({ disabled: true });
      expect(store.claimDueEvents).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      for (const writer of [store.updateMetaStatus, store.updateWhatsappStatus, store.updateBrevoStatus]) {
        expect(writer).not.toHaveBeenCalled();
      }
    });

    it("stops the kick a webhook makes, which is the path that used to send anyway", async () => {
      setEnv({ ...SECRETS, CRM_EVENTS_WORKER_ENABLED: "false" });
      store.claimDueEvents.mockResolvedValue([liveRow()]);
      kickCrmEventsWorker();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.claimDueEvents).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("is read on every sweep, so turning it back on catches the rows up", async () => {
      // The clocks are columns, not timers: nothing is lost while it is off.
      setEnv({ ...SECRETS, CRM_EVENTS_WORKER_ENABLED: "false" });
      store.claimDueEvents.mockResolvedValue([liveRow()]);
      await sweepOnce();
      process.env.CRM_EVENTS_WORKER_ENABLED = "true";
      expect(await sweepOnce()).toEqual({ processed: 1 });
      expect(fetched(DOUBLETICK_TEMPLATE_URL)).toHaveLength(1);
    });

    it("recognises only the literal false, exactly as the timer does", async () => {
      store.claimDueEvents.mockResolvedValue([]);
      for (const setting of ["false", "FALSE", "False"]) {
        process.env.CRM_EVENTS_WORKER_ENABLED = setting;
        expect(await sweepOnce(), setting).toEqual({ disabled: true });
      }
      for (const setting of ["true", "0", "off", "", "yes"]) {
        process.env.CRM_EVENTS_WORKER_ENABLED = setting;
        expect(await sweepOnce(), setting).toEqual({ processed: 0 });
      }
      delete process.env.CRM_EVENTS_WORKER_ENABLED;
      expect(await sweepOnce()).toEqual({ processed: 0 });
    });
  });

  describe("kickCrmEventsWorker", () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve));

    it("returns at once and sweeps on the next tick", async () => {
      expect(kickCrmEventsWorker()).toBeUndefined();
      expect(store.claimDueEvents).not.toHaveBeenCalled();
      await tick();
      expect(store.claimDueEvents).toHaveBeenCalledTimes(1);
    });

    it("logs a failed sweep instead of letting it become an unhandled rejection", async () => {
      store.claimDueEvents.mockRejectedValueOnce(new Error("ECONNRESET"));
      kickCrmEventsWorker();
      await tick();
      await tick();
      expect(spies.error).toHaveBeenCalledWith("[crm-events] kick failed:", "ECONNRESET");
    });
  });

  describe("startCrmEventsWorker", () => {
    it("sweeps every 60 seconds by default and says so in the log", async () => {
      vi.useFakeTimers();
      const worker = startCrmEventsWorker();
      expect(worker.intervalSeconds).toBe(60);
      expect(spies.log).toHaveBeenCalledWith("[crm-events] worker started (interval=60s)");
      await vi.advanceTimersByTimeAsync(59_999);
      expect(store.claimDueEvents).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(store.claimDueEvents).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.claimDueEvents).toHaveBeenCalledTimes(2);
      worker.stop();
    });

    it("stops sweeping when stopped", async () => {
      vi.useFakeTimers();
      const worker = startCrmEventsWorker();
      worker.stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(store.claimDueEvents).not.toHaveBeenCalled();
    });

    it("reads the interval from the environment, never below 30 seconds, falling back to 60 for nonsense", () => {
      vi.useFakeTimers();
      for (const [setting, expected] of [
        ["45", 45],
        ["30", 30],
        ["29", 30],
        ["5", 30],
        ["0", 60],
        ["abc", 60],
        ["", 60],
      ]) {
        process.env.CRM_EVENTS_WORKER_INTERVAL_SECONDS = setting;
        const worker = startCrmEventsWorker();
        expect(worker.intervalSeconds, `setting ${JSON.stringify(setting)}`).toBe(expected);
        worker.stop();
      }
    });

    it("does not start, and says so, when switched off", () => {
      vi.useFakeTimers();
      for (const setting of ["false", "FALSE", "False"]) {
        process.env.CRM_EVENTS_WORKER_ENABLED = setting;
        expect(startCrmEventsWorker(), setting).toBeNull();
      }
      expect(vi.getTimerCount()).toBe(0);
      expect(spies.log).toHaveBeenCalledWith("[crm-events] worker disabled by CRM_EVENTS_WORKER_ENABLED=false");
    });

    it("starts for any other value, and when unset", () => {
      vi.useFakeTimers();
      for (const setting of [undefined, "true", "1", "yes", ""]) {
        if (setting === undefined) delete process.env.CRM_EVENTS_WORKER_ENABLED;
        else process.env.CRM_EVENTS_WORKER_ENABLED = setting;
        const worker = startCrmEventsWorker();
        expect(worker, String(setting)).not.toBeNull();
        worker.stop();
      }
    });

    it("logs a failed scheduled sweep and keeps its schedule", async () => {
      vi.useFakeTimers();
      store.claimDueEvents.mockRejectedValueOnce(new Error("ECONNRESET"));
      const worker = startCrmEventsWorker();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spies.error).toHaveBeenCalledWith("[crm-events] sweep failed:", "ECONNRESET");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.claimDueEvents).toHaveBeenCalledTimes(2);
      worker.stop();
    });
  });
});

describe("wiring in server.js, for the worker", () => {
  // The route's own test hands the handler an onStored of its own, and nothing
  // else reads server.js for the worker. Without the wiring the worker never
  // starts, nothing fails, and rows sit as `pending` while the endpoint answers 200.
  const SERVER = readFileSync(path.resolve("server.js"), "utf8");

  it("imports both entry points from the worker", () => {
    expect(SERVER).toMatch(/import \{ startCrmEventsWorker, kickCrmEventsWorker \} from "\.\/crmSignup\/worker\.js";/);
  });

  it("kicks the worker the moment an event is stored", () => {
    const registration = SERVER.match(/app\.post\('\/api\/crm-events',\s*makeCrmEventsHandler\(\{([\s\S]*?)\}\)\);/);
    expect(registration, "the registration block was not found").not.toBeNull();
    expect(registration[1]).toMatch(/\bonStored:\s*kickCrmEventsWorker\s*,/);
  });

  it("starts the sweeper only once the store is ready, and a failure there cannot take the process down", () => {
    const listen = SERVER.slice(SERVER.indexOf("server.listen(PORT"));
    expect(listen).toMatch(/initCrmSignupStore\(\)\s*\.then\(\(\) => startCrmEventsWorker\(\)\)\s*\.catch\(/);
  });
});
