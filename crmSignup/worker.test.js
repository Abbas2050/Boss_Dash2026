// @vitest-environment node
//
// Two rules this file exists to hold: the retry clock lives in a column, and
// the four actions never interfere -- a Brevo retry must not move anyone
// else's clock, and a failure in one must not stop the others being reached.
//
// Since 2026-10-14 no single event sends to every destination: `registered`
// sends WhatsApp and Brevo while the website pixel owns its conversion on Meta
// and on ChatGPT Ads, and every other stage sends Meta and OpenAI alone. So a
// test that needs a real send runs at the stage that makes it, and several run
// at both.
import { describe, it, expect, vi } from "vitest";
import { planRetry, rowToFields, processSignupEvent, OPENAI_VALIDATE_ONLY_DETAIL } from "./worker.js";
// The fourth destination's own module, imported for the two constants the wiring
// has to agree with and the window the resend is judged against.
// OpenAI's own hashes are imported under their own names, and deliberately not
// Meta's: the email rule is the same rule today and the phone rule is NOT, so a
// case that hashed with Meta's helper would pass today and go quietly wrong the
// day PHONE_RE is loosened.
import {
  OPENAI_EVENTS_URL,
  OPENAI_MAX_EVENT_AGE_MS,
  hashEmail as openaiHashEmail,
  hashPhone as openaiHashPhone,
} from "./openai.js";
// The two vocabularies the worker reads, so the fake store below applies the
// same precondition the real statement does rather than a copy of it. SETTLED is
// "do not attempt this action again"; SCRUBBABLE is "this row is safe to
// forget", and the scrub is built from the second.
// REQUEUEABLE is the third of them -- "an operator may ask for this one again"
// -- read by the resend case at the end of this file for the same reason: so the
// fake table applies the statuses the statement names rather than a copy of them.
import {
  SETTLED as SETTLED_SET,
  SCRUBBABLE as SCRUBBABLE_SET,
  REQUEUEABLE as REQUEUEABLE_SET,
} from "./settled.js";

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
    // OpenAI's click id, frozen in its own column at this client's first event:
    // full_link above is empty, exactly as it is on a real row a minute after
    // signup, so this column is the only place the ad click still exists.
    oppref: "oppref-9f2b",
    whatsapp_request_id: "req-7",
    received_at: new Date("2026-10-12T12:00:00Z"),
    meta_status: "pending",
    meta_attempts: 0,
    whatsapp_status: "pending",
    whatsapp_attempts: 0,
    brevo_status: "pending",
    brevo_attempts: 0,
    openai_status: "pending",
    openai_attempts: 0,
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
      openaiApiKey: "openai-key",
      openaiPixelId: "pixel-1",
      openaiEventsUrl: OPENAI_EVENTS_URL,
      // Off, as it is in production: a validated request records nothing on
      // OpenAI's side, so the cases that assert a conversion was sent must not
      // be running against one. The two cases that are about the flag turn it on.
      openaiValidateOnly: false,
      openaiMaxAttempts: 3,
      skipSources: new Set(),
      // FXBO, for the first-deposit amount, and not the trading backend: a
      // different host with a different credential.
      crmRestBase: "https://portal.skylinkscapital.com",
      crmApiVersion: "1.0.0",
      crmApiToken: "crm-token",
    },
    sendMeta: vi.fn(async () => ({ status: "sent", retryable: false, detail: "http 200" })),
    sendWhatsapp: vi.fn(async () => ({ status: "sent", retryable: false, detail: "SENT", messageId: "m-1" })),
    upsertBrevo: vi.fn(async () => ({ status: "sent", retryable: false, detail: "http 201" })),
    sendOpenai: vi.fn(async () => ({ status: "sent", retryable: false, detail: "http 200" })),
    // The deposit amount, from FXBO. $129.99 on purpose: Meta wants the decimal
    // 129.99 and ChatGPT Ads wants the integer 12999, so a fixture with a round
    // amount would pass with the two units crossed.
    lookupDepositValue: vi.fn(async () => ({
      value: { currency: "USD", valueDecimal: 129.99, amountMinor: 12999 },
    })),
    saveMeta: vi.fn(async () => {}),
    saveWhatsapp: vi.fn(async () => {}),
    saveBrevo: vi.fn(async () => {}),
    saveOpenai: vi.fn(async () => {}),
    // The scrub, which runs once every destination is sent or skipped. Injected like the
    // writers rather than defaulted in the worker, so a case that must prove the
    // row was NOT scrubbed can see the absence.
    scrub: vi.fn(async () => 1),
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
    // at all. No event sends to every destination any more, so at a Meta stage "reached"
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
    // Keyed on the client and the stage, never on the Meta event name. The two
    // names changed on 2026-10-19 and may change again while that experiment
    // runs; an id built from the name would make the same funnel event look
    // like a new one on the day it is renamed, which is the one thing the id
    // exists to prevent.
    expect(first).not.toContain(META_EVENT_NAMES.verified);

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

  it("sends a deposit with the value and currency Meta refuses the event without", async () => {
    // Superseding the 13 October decision to send neither (2026-10-19). Meta
    // answers 200 with events_received: 1 and then DISCARDS a Purchase that
    // carries no value, so the row said `sent` for a conversion that never
    // existed -- three deposits sent on 16 October, none in the dataset.
    const d = deps();
    await processSignupEvent(row({ stage: "first_deposit" }), d);
    expect(d.sendMeta).toHaveBeenCalledTimes(1);
    const { payload } = d.sendMeta.mock.calls[0][0];
    expect(payload.data[0].event_name).toBe("Purchase");
    expect(payload.data[0].custom_data.value).toBe(129.99);
    expect(payload.data[0].custom_data.currency).toBe("USD");
  });

  it("gives Meta the decimal and ChatGPT Ads the minor-unit integer, from one lookup", async () => {
    // The same deposit in two units, a hundred apart, and both platforms would
    // accept either number without a word. One lookup, two named fields.
    const d = deps();
    await processSignupEvent(row({ stage: "first_deposit" }), d);
    const { custom_data } = d.sendMeta.mock.calls[0][0].payload.data[0];
    const [event] = d.sendOpenai.mock.calls[0][0].payload.events;
    expect(custom_data.value).toBe(129.99);
    expect(event.data.amount).toBe(12999);
    expect(custom_data.value).not.toBe(event.data.amount);
    expect(custom_data.currency).toBe("USD");
    expect(event.data.currency).toBe("USD");
  });

  it("asks FXBO once per row, although two destinations need the answer", async () => {
    // The only outbound call here that is not to a destination. Two calls for
    // one deposit would double a cost that only exists on this path.
    const d = deps();
    await processSignupEvent(row({ stage: "first_deposit" }), d);
    expect(d.sendMeta).toHaveBeenCalledTimes(1);
    expect(d.sendOpenai).toHaveBeenCalledTimes(1);
    expect(d.lookupDepositValue).toHaveBeenCalledTimes(1);
    expect(d.lookupDepositValue).toHaveBeenCalledWith({
      config: d.config,
      crmClientId: "88214",
    });
  });

  it("never asks FXBO at any other stage", async () => {
    // The whole of the cost control: a handful of first deposits a day, and no
    // call at all on the stages that arrive in volume.
    for (const stage of ["lead", "registered", "verified", "live_account"]) {
      const d = deps();
      await processSignupEvent(row({ stage }), d);
      expect(d.lookupDepositValue, stage).not.toHaveBeenCalled();
    }
  });

  it("never asks FXBO when neither destination that needs the answer is sending", async () => {
    // Lazy, not eager: the lookup is asked for after each step has decided its
    // own skip, so an unconfigured pair costs nothing.
    const d = deps({ config: { ...deps().config, metaAccessToken: "", openaiApiKey: "" } });
    await processSignupEvent(row({ stage: "first_deposit" }), d);
    expect(d.lookupDepositValue).not.toHaveBeenCalled();
    expect(d.saveMeta).toHaveBeenCalledWith(7, expect.objectContaining({ status: "skipped" }));
  });

  it("never asks FXBO for a deposit whose destinations are already settled", async () => {
    const d = deps();
    await processSignupEvent(
      row({ stage: "first_deposit", meta_status: "sent", openai_status: "sent" }),
      d
    );
    expect(d.lookupDepositValue).not.toHaveBeenCalled();
  });

  // The reason this lookup exists is that Meta discards a Purchase with no
  // value, so a lookup that found nothing must never leave a row reading `sent`.
  describe("when the deposit amount cannot be looked up", () => {
    const FIRST_DEPOSIT = { stage: "first_deposit" };

    it("retries rather than sending a Purchase Meta would throw away", async () => {
      // The timing case: FXBO's "First time deposit by client" rule can reach us
      // before the transaction it describes is queryable.
      const d = deps({
        lookupDepositValue: vi.fn(async () => ({
          failure: { detail: "no approved deposit for this client yet", retryable: true },
        })),
      });
      await processSignupEvent(row(FIRST_DEPOSIT), d);
      expect(d.sendMeta).not.toHaveBeenCalled();
      expect(d.sendOpenai).not.toHaveBeenCalled();
      for (const save of [d.saveMeta, d.saveOpenai]) {
        expect(save).toHaveBeenCalledWith(
          7,
          expect.objectContaining({
            status: "retrying",
            attempts: 1,
            detail: "deposit lookup: no approved deposit for this client yet",
            nextAttemptAt: new Date("2026-10-12T12:05:00Z"),
          })
        );
      }
    });

    it("never records `sent` for a row whose lookup failed", async () => {
      // The whole point. A row reading `sent` for an event Meta threw away is the
      // defect, so no path out of a failed lookup may produce that word.
      for (const retryable of [true, false]) {
        const d = deps({
          lookupDepositValue: vi.fn(async () => ({ failure: { detail: "nope", retryable } })),
        });
        await processSignupEvent(row(FIRST_DEPOSIT), d);
        for (const save of [d.saveMeta, d.saveOpenai]) {
          for (const [, outcome] of save.mock.calls) {
            expect(outcome.status, `${retryable}: ${outcome.detail}`).not.toBe("sent");
          }
        }
      }
    });

    it("fails at once, without spending the budget, when the cause will not clear", async () => {
      // A missing API_TOKEN, a currency nobody can read: none of these is
      // different in five minutes, so waiting only delays the `failed` an
      // operator has to act on anyway.
      const d = deps({
        lookupDepositValue: vi.fn(async () => ({
          failure: { detail: "API_TOKEN is not set, so the CRM cannot be asked", retryable: false },
        })),
      });
      await processSignupEvent(row(FIRST_DEPOSIT), d);
      for (const save of [d.saveMeta, d.saveOpenai]) {
        expect(save).toHaveBeenCalledWith(
          7,
          expect.objectContaining({
            status: "failed",
            detail: "deposit lookup: API_TOKEN is not set, so the CRM cannot be asked",
            nextAttemptAt: null,
          })
        );
      }
    });

    it("settles `failed` once the attempt budget is spent, which an operator can resend", async () => {
      const d = deps({
        lookupDepositValue: vi.fn(async () => ({ failure: { detail: "http 503", retryable: true } })),
      });
      await processSignupEvent(row({ ...FIRST_DEPOSIT, meta_attempts: 2, openai_attempts: 2 }), d);
      for (const save of [d.saveMeta, d.saveOpenai]) {
        expect(save).toHaveBeenCalledWith(
          7,
          expect.objectContaining({ status: "failed", attempts: 3, nextAttemptAt: null })
        );
      }
      // `failed` is not scrubbable, so the row keeps the client data a resend
      // needs -- and the resend is the whole reason this is not a skip.
      expect(d.scrub).not.toHaveBeenCalled();
    });

    it("reads a lookup that answered in no shape at all as a failure, not a pass", async () => {
      for (const answer of [undefined, null, {}, { value: null }, "oops"]) {
        const d = deps({ lookupDepositValue: vi.fn(async () => answer) });
        await processSignupEvent(row(FIRST_DEPOSIT), d);
        expect(d.sendMeta, JSON.stringify(answer)).not.toHaveBeenCalled();
        expect(d.saveMeta, JSON.stringify(answer)).toHaveBeenCalledWith(
          7,
          expect.objectContaining({ status: "retrying", detail: expect.stringContaining("deposit lookup:") })
        );
      }
    });

    it("survives a lookup that throws, and still reaches the other destinations", async () => {
      // The lookup is awaited by two steps, so a rejected promise left uncaught
      // would take both of them and the row with it.
      const d = deps({
        lookupDepositValue: vi.fn(async () => {
          throw new Error("boom");
        }),
      });
      await processSignupEvent(row(FIRST_DEPOSIT), d);
      expect(d.saveMeta).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ status: "retrying", detail: "deposit lookup: threw: boom" })
      );
      expect(d.saveOpenai).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ status: "retrying", detail: "deposit lookup: threw: boom" })
      );
      // The two that do not need a deposit amount still settle.
      for (const save of [d.saveWhatsapp, d.saveBrevo]) {
        expect(save).toHaveBeenCalledWith(7, expect.objectContaining({ status: "skipped" }));
      }
    });

    it("spends one lookup for the row even when it fails", async () => {
      const d = deps({
        lookupDepositValue: vi.fn(async () => ({ failure: { detail: "http 503", retryable: true } })),
      });
      await processSignupEvent(row(FIRST_DEPOSIT), d);
      expect(d.lookupDepositValue).toHaveBeenCalledTimes(1);
    });

    it("names the lookup in the detail, so the row does not read as a provider refusal", async () => {
      const d = deps({
        lookupDepositValue: vi.fn(async () => ({ failure: { detail: "http 403", retryable: false } })),
      });
      await processSignupEvent(row(FIRST_DEPOSIT), d);
      const [, outcome] = d.saveMeta.mock.calls.at(-1);
      expect(outcome.detail).toBe("deposit lookup: http 403");
      expect(d.logger.warn).toHaveBeenCalledWith(
        "[crm-events] meta failed for row 7: deposit lookup: http 403"
      );
    });

    it("holds the Purchase back without touching WhatsApp or Brevo", async () => {
      // One destination's missing precondition must not move anyone else's clock.
      const d = deps({
        lookupDepositValue: vi.fn(async () => ({ failure: { detail: "http 503", retryable: true } })),
      });
      await processSignupEvent(row(FIRST_DEPOSIT), d);
      for (const save of [d.saveWhatsapp, d.saveBrevo]) {
        expect(save).toHaveBeenCalledWith(
          7,
          expect.objectContaining({ status: "skipped", detail: "stage not applicable", nextAttemptAt: null })
        );
      }
    });
  });

  // This case used to pin the exact opposite -- WhatsApp skipped with "lead, not
  // client" while Brevo took everyone. Both decisions were reversed on
  // 2026-10-14 (user's call), so the subject is now which destination the lead
  // gate sits on: WhatsApp has none, Brevo has one.
  it("sends a lead the same WhatsApp welcome, and keeps them out of Brevo", async () => {
    const d = deps();
    // record_type and is_lead_raw agree here, which is the ordinary case. The
    // one that matters is where they do not -- the case below.
    await processSignupEvent(row({ record_type: "lead", is_lead_raw: "1" }), d);
    expect(d.sendWhatsapp).toHaveBeenCalledTimes(1);
    expect(d.saveWhatsapp).toHaveBeenCalledWith(7, expect.objectContaining({ status: "sent" }));
    expect(d.upsertBrevo).not.toHaveBeenCalled();
    expect(d.saveBrevo).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "skipped", detail: "lead, not client" })
    );
  });

  it("adds the contact whenever is_lead_raw is absent or unrecognised, whatever record_type says", async () => {
    // Brevo's gate reads the raw literal positively, so a value FXBO starts
    // sending that nobody predicted adds contacts rather than silently emptying
    // the list. Every row here has record_type "lead" -- which is exactly what
    // `recordType !== "client"` would have skipped on, and why it is not what
    // the gate reads.
    for (const is_lead_raw of [undefined, null, "", "   ", "maybe", "2", "lead"]) {
      const d = deps();
      await processSignupEvent(row({ record_type: "lead", is_lead_raw }), d);
      expect(d.upsertBrevo, String(is_lead_raw)).toHaveBeenCalledTimes(1);
      expect(d.saveBrevo, String(is_lead_raw)).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ status: "sent" })
      );
      // And the welcome goes out either way: nothing about the record type gates
      // WhatsApp any more.
      expect(d.sendWhatsapp, String(is_lead_raw)).toHaveBeenCalledTimes(1);
    }
  });

  it("still skips a lead's WhatsApp for an unusable phone", async () => {
    // The lead gate went; the phone format did not go with it.
    const d = deps();
    await processSignupEvent(row({ record_type: "lead", is_lead_raw: "1", phone: "00971507192185" }), d);
    expect(d.sendWhatsapp).not.toHaveBeenCalled();
    expect(d.saveWhatsapp).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "skipped", detail: "invalid phone number" })
    );
  });

  it("touches nothing already settled", async () => {
    const d = deps();
    await processSignupEvent(
      row({ meta_status: "sent", whatsapp_status: "sent", brevo_status: "sent" }),
      d
    );
    expect(d.sendMeta).not.toHaveBeenCalled();
    expect(d.sendWhatsapp).not.toHaveBeenCalled();
    expect(d.sendOpenai).not.toHaveBeenCalled();
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
// META_EVENT_NAMES is read far above, by the event-id case: that id is keyed on
// the stage, and the assertion says so against the real name rather than a copy.
import { hashEmail, hashPhone, META_EVENT_NAMES } from "./meta.js";
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
  updateOpenaiStatus: vi.fn(async () => {}),
  scrubSignupEvent: vi.fn(async () => 1),
  deleteInvalidSignupEvents: vi.fn(async () => 0),
  scrubStaleSignupEvents: vi.fn(async () => 0),
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
  // OpenAI sends at `verified` like Meta, and for the same reason: the website
  // pixel owns the registration conversion on both platforms, so `registered`
  // is the one stage at which neither sends.
  { name: "openai", stage: "verified", status: "openai_status", attempts: "openai_attempts", clock: "openai_next_attempt_at", send: "sendOpenai", save: "saveOpenai" },
];

// Every subset of the actions, so that a step reading another step's column is
// caught whichever way round the columns are crossed. Counted from the list, not
// written as a literal: a destination added without widening this would leave
// half the crossings untested.
const SUBSETS = Array.from({ length: 2 ** ACTIONS.length }, (_, mask) =>
  ACTIONS.filter((_a, i) => mask & (1 << i))
);
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

// No stage sends to every destination, so a case that compares what each action did with
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
    // At each stage, because no stage sends to every destination. An action that is due but
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
      await processSignupEvent(
        row({ meta_status: status, whatsapp_status: status, brevo_status: status, openai_status: status }),
        d
      );
      for (const a of ACTIONS) {
        expect(d[a.send], a.name).not.toHaveBeenCalled();
        expect(d[a.save], a.name).not.toHaveBeenCalled();
      }
    });
  }

  it("reads the wide set here, so the three statuses the scrub keeps are still never re-sent", async () => {
    // The two sets differ by exactly these three, and each usage site has to read
    // the one that answers its own question. This one is "is this action still
    // mine to attempt". Read SCRUBBABLE here and every refused or failed action
    // would be claimed again, and the client would get a second WhatsApp welcome
    // -- the one message with nothing deduplicating it. (The opposite mistake, at
    // the scrub, destroys the data the resend needs.)
    for (const status of ["rejected", "failed", "invalid"]) {
      expect(SETTLED_SET.has(status), status).toBe(true);
      expect(SCRUBBABLE_SET.has(status), status).toBe(false);
      for (const stage of SENDING_STAGES) {
        const d = deps();
        const r = row({ stage });
        for (const a of ACTIONS) r[a.status] = status;
        await processSignupEvent(r, d);
        for (const a of ACTIONS) {
          expect(d[a.send], `${status}/${a.name} at ${stage}`).not.toHaveBeenCalled();
          expect(d[a.save], `${status}/${a.name} at ${stage}`).not.toHaveBeenCalled();
        }
      }
    }
  });

  it("runs exactly the unsettled actions, reading each from its own status column", async () => {
    const settledAs = { meta: "sent", whatsapp: "rejected", brevo: "invalid", openai: "skipped" };
    const openAs = { meta: "pending", whatsapp: "retrying", brevo: "pending", openai: "retrying" };
    // At each stage, because no stage sends to every destination: an open action that does
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

// This table stores statistics, not client records. The client's name, email and
// phone are here only so they survive from receipt until every destination
// settles -- the endpoint answers FXBO immediately and sends afterwards, and a
// retry is five minutes away. The moment all of them are settled, nothing needs
// them again.
describe("the row is scrubbed once every destination has succeeded or been skipped", () => {
  // The two sets, written out rather than imported, so an edit to settled.js that
  // moved a status from one to the other has to come past these cases.
  const SCRUBBABLE = ["sent", "skipped"];
  const KEPT = ["rejected", "failed", "invalid"];

  it("scrubs the row, with the sweeper's own clock, after the last action settles", async () => {
    for (const stage of SENDING_STAGES) {
      const d = deps();
      await processSignupEvent(row({ stage }), d);
      expect(d.scrub, stage).toHaveBeenCalledTimes(1);
      expect(d.scrub, stage).toHaveBeenCalledWith(7, new Date("2026-10-12T12:00:00Z"));
    }
  });

  it("scrubs after every write, never before one of them", async () => {
    // Order is the whole safety of this. A scrub between the claim and the send
    // would null the phone number the send is about to read.
    const order = [];
    const note = (name) => vi.fn(async () => void order.push(name));
    const d = deps({
      saveMeta: note("saveMeta"),
      saveWhatsapp: note("saveWhatsapp"),
      saveBrevo: note("saveBrevo"),
      saveOpenai: note("saveOpenai"),
      scrub: note("scrub"),
    });
    await processSignupEvent(row(), d);
    expect(order.at(-1)).toBe("scrub");
    expect(order.filter((n) => n === "scrub")).toHaveLength(1);
  });

  it("scrubs a row that was already settled before this sweep ever saw it", async () => {
    // Nothing is sent and nothing is written, but the row still holds client data
    // it no longer needs -- the case a worker that only scrubbed what it had just
    // sent would leave behind for a month.
    for (const status of SCRUBBABLE) {
      const d = deps();
      await processSignupEvent(
        row({ meta_status: status, whatsapp_status: status, brevo_status: status, openai_status: status }),
        d
      );
      expect(d.scrub, status).toHaveBeenCalledTimes(1);
      for (const a of ACTIONS) expect(d[a.save], `${status}/${a.name}`).not.toHaveBeenCalled();
    }
  });

  it("does not scrub a row whose destination was refused, failed or was never valid", async () => {
    // Settled is not the same question as safe to forget (2026-10-14, user's
    // call). These three are finished with -- nothing attempts them again -- but
    // the client data is exactly what the resend needs once the cause is fixed,
    // and a misconfigured destination fails every row this way. Scrubbing them
    // made those clients permanently unrecoverable, with a `failed` nobody could
    // act on as the only trace. The thirty-day backstop is what bounds the data
    // this keeps.
    for (const status of KEPT) {
      for (const a of ACTIONS) {
        const d = deps();
        const r = row();
        for (const other of ACTIONS) r[other.status] = other === a ? status : "sent";
        await processSignupEvent(r, d);
        expect(d.scrub, `${a.name} ${status}`).not.toHaveBeenCalled();
      }
    }
  });

  it("keeps a row whose Brevo send failed, and scrubs the same row once Brevo succeeds", async () => {
    // The concrete case the decision was taken for, end to end. BREVO_LIST_ID is
    // unusable, so Brevo fails terminally while Meta skips the stage the website
    // pixel owns on both platforms and WhatsApp sends: every destination settled, one of them
    // failed, and the row keeps its name, email and phone -- the scrub, which is
    // the only thing that nulls them, is not even attempted.
    const failing = deps({ config: { ...deps().config, brevoListId: "" } });
    await processSignupEvent(row(), failing);
    expect(lastSaved(failing.saveMeta)).toMatchObject({ status: "skipped" });
    expect(lastSaved(failing.saveWhatsapp)).toMatchObject({ status: "sent" });
    expect(lastSaved(failing.saveBrevo)).toMatchObject({ status: "failed", nextAttemptAt: null });
    expect(failing.scrub).not.toHaveBeenCalled();

    // And once the variable is fixed and the row comes back claimable, the same
    // row sends and now it scrubs. What resets a kept row to `pending` is its own
    // task and is deliberately not built here, so the row is handed in that way.
    const fixed = deps();
    await processSignupEvent(
      row({ meta_status: "skipped", whatsapp_status: "sent", brevo_status: "pending", openai_status: "sent" }),
      fixed
    );
    expect(fixed.upsertBrevo).toHaveBeenCalledTimes(1);
    expect(lastSaved(fixed.saveBrevo)).toMatchObject({ status: "sent" });
    expect(fixed.scrub).toHaveBeenCalledTimes(1);
    expect(fixed.scrub).toHaveBeenCalledWith(7, new Date("2026-10-12T12:00:00Z"));
  });

  it("scrubs a row settled across a mix of this sweep's outcomes and earlier ones", async () => {
    // Each action's status comes from its own place: the outcome if it ran, the
    // column if it did not. Reading only one of the two would leave half the
    // settled rows unscrubbed.
    for (const stage of SENDING_STAGES) {
      for (const settled of SUBSETS) {
        const d = deps();
        const r = row({ stage });
        for (const a of ACTIONS) r[a.status] = settled.includes(a) ? "sent" : "pending";
        await processSignupEvent(r, d);
        expect(d.scrub, `${stage}, settled=${names(settled)}`).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("does not scrub while any action is still pending or retrying", async () => {
    // A retry is five minutes away and will read the phone number off this row.
    // Scrubbing now sends a nameless template to a missing number.
    for (const a of ACTIONS) {
      for (const open of ["pending", "retrying"]) {
        const d = deps({
          [a.send]: vi.fn(async () => ({ status: "failed", retryable: true, detail: "http 503" })),
        });
        const r = row({ stage: a.stage });
        for (const other of ACTIONS) r[other.status] = other === a ? open : "sent";
        await processSignupEvent(r, d);
        expect(d.scrub, `${a.name} ${open}`).not.toHaveBeenCalled();
      }
    }
  });

  it("does not scrub an action left waiting on its own clock", async () => {
    // claimDueEvents returns the row because a SIBLING came due. The waiting
    // action is untouched and still has a send ahead of it.
    for (const a of ACTIONS) {
      const d = deps();
      const r = row({ stage: a.stage, [a.clock]: new Date("2026-10-12T12:04:00Z") });
      await processSignupEvent(r, d);
      expect(d.scrub, a.name).not.toHaveBeenCalled();
    }
  });

  it("still attempts the scrub when another sweeper holds a claim, and lets the statement refuse it", async () => {
    // An overlapped IIS recycle runs two workers, and the loser of a claim
    // records nothing. Our column for the action somebody else is sending is
    // stale by definition, so it is not what decides this: the statement's own
    // precondition is (store.sql.test.js pins that predicate). Deciding it from
    // the stale column instead is what left a split row unscrubbed in BOTH
    // workers, waiting the full thirty days for the backstop.
    for (const a of ACTIONS) {
      const d = deps({ [a.save]: vi.fn(async (_id, _outcome, claimAt) => (claimAt ? 0 : 1)) });
      await processSignupEvent(row({ stage: a.stage }), d);
      expect(d.scrub, a.name).toHaveBeenCalledTimes(1);
      expect(d.scrub, a.name).toHaveBeenCalledWith(7, new Date("2026-10-12T12:00:00Z"));
    }
  });

  it("scrubs a row whose three claims split between two overlapped workers, exactly once", async () => {
    // The case the predicate exists for. Two workers share the recycle window on
    // one row: each took a copy before the other had written anything, worker A
    // wins the WhatsApp claim and worker B the Brevo one. Neither copy ever shows
    // all of them settled, so while the scrub was decided from the copy alone
    // NEITHER scrubbed and the row kept its name, email and phone for thirty
    // days -- in exactly the case the policy asks to reduce to a minute.
    //
    // The table below applies what the statement applies: a claiming write lands
    // only on an action still unsent, and the scrub only on a row whose three
    // statuses the TABLE says are settled and that has not been scrubbed yet.
    const table = { meta_status: "pending", whatsapp_status: "pending", brevo_status: "pending", scrubbed_at: null };
    const stamps = [];
    // SCRUBBABLE, because that is the set the statement's predicate is built
    // from: a `failed` destination is settled and still keeps the row's data.
    const scrubbableInTable = () =>
      ["meta_status", "whatsapp_status", "brevo_status"].every((c) => SCRUBBABLE_SET.has(table[c]));
    const scrub = vi.fn(async (_id, at) => {
      stamps.push(at);
      if (!scrubbableInTable() || table.scrubbed_at) return 0;
      table.scrubbed_at = at;
      return 1;
    });
    // `owns` is which claim this worker won; the other worker's is refused the
    // way the store refuses it, with a 0.
    const worker = (owns, at) => {
      const writer = (column, mine) => async (_id, outcome, claimAt) => {
        if (claimAt && !mine) return 0;
        table[column] = outcome.status;
        return 1;
      };
      return deps({
        saveMeta: writer("meta_status", true),
        saveWhatsapp: writer("whatsapp_status", owns === "whatsapp"),
        saveBrevo: writer("brevo_status", owns === "brevo"),
        scrub,
        now: () => at,
      });
    };

    // Both read the row as it was before either of them ran.
    const copyA = row({ stage: "registered" });
    const copyB = row({ stage: "registered" });
    const first = new Date("2026-10-12T12:00:00Z");
    const second = new Date("2026-10-12T12:00:30Z");
    await processSignupEvent(copyA, worker("whatsapp", first));
    await processSignupEvent(copyB, worker("brevo", second));

    // Both tried; the earlier attempt found the other's action still unsettled in
    // the table and matched nothing, and the one that finished last scrubbed.
    expect(scrub).toHaveBeenCalledTimes(2);
    expect(stamps).toEqual([first, second]);
    expect(table.scrubbed_at).toEqual(second);
    expect(table).toEqual({
      meta_status: "skipped",
      whatsapp_status: "sent",
      brevo_status: "sent",
      scrubbed_at: second,
    });
  });

  it("lets a scrub that cannot be written surface, rather than hiding it for a month", async () => {
    // sweepOnce logs the row. Swallowing it here would leave the row for the
    // thirty-day backstop with nothing said about why.
    const d = deps({ scrub: vi.fn(async () => { throw new Error("ECONNRESET"); }) });
    await expect(processSignupEvent(row(), d)).rejects.toThrow("ECONNRESET");
  });
});

describe("the resend a kept row was kept for", () => {
  // The other half of the retention decision, end to end: keeping a failed row's
  // client data made the resend possible, and this is the resend. BREVO_LIST_ID
  // is the concrete case -- it fails every row the moment it is wrong, the
  // operator fixes the variable, presses the control on the settings tab, and the
  // same rows send and then scrub.
  //
  // Four steps, each applied here the way the real one applies it:
  // requeueFailedSends, the claim, the send, the scrub. store.sql.test.js is what
  // pins each statement's text and its preconditions; what this case is for is
  // that the four fit together. The status filters are built from the imported
  // sets rather than written out, the way the split-claim case above builds its
  // scrub predicate from SCRUBBABLE.
  const NOW = new Date("2026-10-12T12:00:00Z");
  const CLAIMABLE = ["pending", "retrying"];

  /** The row as the table holds it after an unusable BREVO_LIST_ID: Meta and
   *  OpenAI skipped the stage the website pixel owns on both platforms, WhatsApp
   *  sent, Brevo failed terminally without spending an attempt -- and the row
   *  still has its name, email and phone, because `failed` is not scrubbable. */
  const stored = (over = {}) => ({
    meta_status: "skipped",
    whatsapp_status: "sent",
    openai_status: "skipped",
    brevo_status: "failed",
    brevo_detail: "brevo not sent: BREVO_LIST_ID is unset, blank or not a positive number",
    brevo_attempts: 0,
    brevo_next_attempt_at: null,
    scrubbed_at: null,
    ...over,
  });

  /** requeueFailedSends: the two statuses it may touch, the scrubbed row it may
   *  not, and the three columns it writes. Returns the rows it matched. */
  const requeue = (table, action) => {
    if (table.scrubbed_at !== null) return 0;
    if (!REQUEUEABLE_SET.has(String(table[`${action}_status`]))) return 0;
    table[`${action}_status`] = "pending";
    table[`${action}_attempts`] = 0;
    table[`${action}_next_attempt_at`] = null;
    return 1;
  };

  /** One action's writer. A claiming write lands only while the action is still
   *  unsent, which is what stops a second sweeper sending beside this one. */
  const save = (table, action) =>
    vi.fn(async (_id, outcome, claimAt) => {
      if (claimAt && !CLAIMABLE.includes(String(table[`${action}_status`]))) return 0;
      table[`${action}_status`] = outcome.status;
      table[`${action}_detail`] = outcome.detail;
      table[`${action}_attempts`] = outcome.attempts;
      table[`${action}_next_attempt_at`] = outcome.nextAttemptAt ?? null;
      return 1;
    });

  /** The worker, writing into that table. The scrub carries its own predicate,
   *  as scrubSignupEvent does: every destination scrubbable in the TABLE, and not
   *  scrubbed yet. */
  const against = (table, overrides = {}) =>
    deps({
      saveMeta: save(table, "meta"),
      saveWhatsapp: save(table, "whatsapp"),
      saveBrevo: save(table, "brevo"),
      saveOpenai: save(table, "openai"),
      scrub: vi.fn(async (_id, at) => {
        const scrubbable = ACTIONS.every((a) => SCRUBBABLE_SET.has(String(table[a.status])));
        if (!scrubbable || table.scrubbed_at !== null) return 0;
        table.scrubbed_at = at;
        return 1;
      }),
      ...overrides,
    });

  it("requeues a Brevo failure, sends it on the next sweep, and scrubs the row afterwards", async () => {
    const table = stored();

    expect(requeue(table, "brevo")).toBe(1);
    expect(table).toMatchObject({ brevo_status: "pending", brevo_attempts: 0, brevo_next_attempt_at: null });
    // The detail is deliberately left saying why this row is here, until the
    // claim replaces it with the in-flight note.
    expect(table.brevo_detail).toMatch(/BREVO_LIST_ID/);

    const d = against(table);
    await processSignupEvent(row({ ...table }), d);

    expect(d.upsertBrevo).toHaveBeenCalledTimes(1);
    // One destination requeued is one destination sent. Meta was skipped at this
    // stage and WhatsApp had already gone; both are settled, so neither is
    // touched -- which is the whole reason the control is per destination.
    expect(d.sendMeta).not.toHaveBeenCalled();
    expect(d.sendWhatsapp).not.toHaveBeenCalled();
    expect(lastSaved(d.saveBrevo)).toMatchObject({ status: "sent", attempts: 1 });
    expect(table.brevo_status).toBe("sent");

    // And now every destination has succeeded or been skipped, so the row is
    // finally safe to forget -- which it was not while Brevo said `failed`.
    expect(d.scrub).toHaveBeenCalledTimes(1);
    expect(table.scrubbed_at).toEqual(NOW);
  });

  it("refuses a row the backstop already scrubbed, which nothing could ever settle", async () => {
    // Thirty days on, the backstop took the client data and wrote `failed` with
    // "not attempted" beside it. Requeued, that row would be claimed on every
    // sweep, refused by the send guard, and sit at `pending` for the rest of the
    // table's life -- and `pending` piling up is the one signal that means the
    // dispatch worker is dead.
    const table = stored({ scrubbed_at: new Date("2026-11-11T12:00:00Z") });

    expect(requeue(table, "brevo")).toBe(0);
    expect(table.brevo_status).toBe("failed");

    // The other half of the guard, for whatever else ever hands the worker one:
    // nothing is sent and nothing is written.
    const d = against(table);
    await processSignupEvent(row({ ...table, brevo_status: "pending" }), d);
    expect(d.upsertBrevo).not.toHaveBeenCalled();
    expect(d.saveBrevo).not.toHaveBeenCalled();
    expect(d.scrub).not.toHaveBeenCalled();
  });

  it("hands the resend its retries back, which a row left at 3 of 3 does not have", async () => {
    // Why the attempt count is reset. planRetry reads the stored count and the
    // pre-send write that claims the row is computed from it, so at 3 of 3 that
    // write stores `failed` with no clock BEFORE the request leaves: the tab
    // shows a terminal failure while the request is in the air, and one transient
    // 503 ends the resend there instead of retrying it five minutes later.
    const flaky = {
      upsertBrevo: vi.fn(async () => ({ status: "failed", retryable: true, detail: "http 503" })),
    };

    const reset = stored({ brevo_attempts: 3 });
    requeue(reset, "brevo");
    await processSignupEvent(row({ ...reset }), against(reset, flaky));
    expect(reset).toMatchObject({ brevo_status: "retrying", brevo_attempts: 1 });
    expect(reset.brevo_next_attempt_at).toEqual(new Date("2026-10-12T12:05:00Z"));

    // The same row made claimable without the reset: one shot, terminal at once.
    const unreset = stored({ brevo_status: "pending", brevo_attempts: 3 });
    await processSignupEvent(row({ ...unreset }), against(unreset, flaky));
    expect(unreset).toMatchObject({ brevo_status: "failed", brevo_attempts: 4 });
    expect(unreset.brevo_next_attempt_at).toBeNull();
  });

  it("re-sends the frozen whatsapp_request_id rather than minting a fresh one", async () => {
    // The id is frozen per row FOR the resend, not in spite of it. If DoubleTick
    // honours a repeated messageId, reusing it means a welcome that genuinely
    // never arrived still goes out -- DoubleTick never saw that id -- while one
    // that did arrive is deduplicated. Both are what we want. A fresh id would
    // guarantee the duplicate, which is the whole reason this control is separate
    // and warned about.
    const table = stored({
      whatsapp_status: "rejected",
      whatsapp_detail: "2xx with status QUEUED_UNKNOWN",
      whatsapp_attempts: 1,
      brevo_status: "sent",
    });
    expect(requeue(table, "whatsapp")).toBe(1);

    const d = against(table, { newMessageId: () => "a-fresh-uuid" });
    await processSignupEvent(row({ ...table, whatsapp_request_id: "req-7" }), d);

    expect(d.sendWhatsapp).toHaveBeenCalledTimes(1);
    expect(d.sendWhatsapp.mock.calls[0][0].payload.messages[0].messageId).toBe("req-7");
  });
});

describe("a scrubbed row sends nothing", () => {
  // claimDueEvents selects only pending/retrying, and the scrub only runs once
  // every destination has settled, so nothing should reach the worker scrubbed. This is
  // the guard for whatever later changes that -- a hand-run requeue, a new
  // selection clause -- because the failure is silent: Brevo accepts a contact
  // with no address and DoubleTick accepts a template with no name.
  it("sends nothing and writes nothing for a row that carries a scrubbed_at", async () => {
    for (const stage of SENDING_STAGES) {
      const d = deps();
      const result = await processSignupEvent(
        row({ stage, scrubbed_at: new Date("2026-10-12T11:00:00Z"), first_name: "", email: "", phone: "" }),
        d
      );
      for (const a of ACTIONS) {
        expect(d[a.send], `${stage}/${a.name}`).not.toHaveBeenCalled();
        expect(d[a.save], `${stage}/${a.name}`).not.toHaveBeenCalled();
      }
      expect(d.scrub, stage).not.toHaveBeenCalled();
      expect(result, stage).toEqual({ meta: null, whatsapp: null, brevo: null, openai: null });
    }
  });

  it("refuses even when the statuses say the actions are still due", async () => {
    // The statuses are not the test. A row holding a scrubbed_at has nothing left
    // to build a payload from, whatever its status columns claim.
    const d = deps();
    await processSignupEvent(
      row({ scrubbed_at: "2026-10-12T11:00:00.000Z", meta_status: "retrying", whatsapp_status: "pending" }),
      d
    );
    for (const a of ACTIONS) expect(d[a.send], a.name).not.toHaveBeenCalled();
  });

  it("says which row it refused, without the client's details", async () => {
    const d = deps();
    await processSignupEvent(row({ scrubbed_at: new Date("2026-10-12T11:00:00Z") }), d);
    const said = d.logger.warn.mock.calls.flat().join(" ");
    expect(said).toContain("7");
    expect(said).toMatch(/scrubbed/);
    expect(said).not.toContain("ali@example.com");
    expect(said).not.toContain("+971507192185");
  });

  it("still sends from a row that has never been scrubbed", async () => {
    // The guard must read the column, not merely exist. A null and a missing
    // scrubbed_at are both "never scrubbed".
    for (const scrubbedAt of [null, undefined]) {
      const d = deps();
      await processSignupEvent(row({ scrubbed_at: scrubbedAt }), d);
      expect(d.sendWhatsapp, String(scrubbedAt)).toHaveBeenCalledTimes(1);
    }
  });
});

describe("the four actions keep separate counters, budgets and failures", () => {
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
    // Registration and a Meta stage, since no one event sends to every destination.
    const registration = await processSignupEvent(row(), deps());
    expect(Object.keys(registration)).toEqual(["meta", "whatsapp", "brevo", "openai"]);
    expect(registration.meta).toMatchObject({ status: "skipped", detail: "registered is owned by the website pixel" });
    expect(registration.brevo).toMatchObject({ status: "sent", detail: "http 201" });
    // The same stage, and the same reason, on the other platform that merges a
    // browser event with ours only when the ids match.
    expect(registration.openai).toMatchObject({
      status: "skipped",
      detail: "registered is owned by the website pixel",
    });
    const verified = await processSignupEvent(row({ stage: "verified" }), deps());
    expect(verified.meta).toMatchObject({ status: "sent", detail: "http 200" });
    expect(verified.openai).toMatchObject({ status: "sent", detail: "http 200" });
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
      // Nothing was created, so there is no id to keep. Null rather than
      // absent on every path out of the step: the writer COALESCEs, so a null
      // never erases an id an earlier send recorded.
      contactId: null,
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
    expect(lastSaved(d.saveBrevo)).toEqual({
      status: "sent",
      attempts: 2,
      nextAttemptAt: null,
      detail: "http 201",
      contactId: null,
    });
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
    // The key and the pixel id are named apart because they live on different
    // lines of .env, and "not configured" alone would not say which to look at.
    { action: ACTIONS[3], why: "openai not configured", config: { openaiApiKey: "   " }, row: { stage: "verified" } },
    {
      action: ACTIONS[3],
      why: "openai pixel id not configured",
      config: { openaiPixelId: "" },
      row: { stage: "verified" },
    },
    // The registration stage, whose conversion the website pixel owns on this
    // platform too -- and the one reason a resend can produce on a row that was
    // otherwise perfectly sendable.
    { action: ACTIONS[3], why: "registered is owned by the website pixel", row: { stage: "registered" } },
    {
      action: ACTIONS[3],
      why: "received_at is outside OpenAI's window: older than 7 days",
      row: { stage: "verified", received_at: new Date("2026-10-01T12:00:00Z") },
    },
    {
      action: ACTIONS[3],
      why: "received_at is not a usable timestamp",
      row: { stage: "verified", received_at: "not a date" },
    },
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
      // Two destinations carry one extra field out of every path, and it is
      // null here because a skip sends nothing: WhatsApp's provider message id,
      // and Brevo's contact id. Explicit rather than absent, so the writer
      // cannot read `undefined` off one branch and a value off another.
      const extra = { whatsapp: { messageId: null }, brevo: { contactId: null } }[action.name] ?? {};
      expect(lastSaved(d[action.save])).toEqual({ ...expected, ...extra });
    });
  }
});

describe("the payload that cannot be built is never posted", () => {
  // buildOpenaiPayload returns null rather than a payload that is invalid by
  // construction. `JSON.stringify(null)` is the string "null", which is a
  // perfectly well-formed request body carrying no event at all, and OpenAI's
  // answer to one is not documented anywhere -- so a step that posted it would
  // be spending a retry budget to find out.
  //
  // Unreachable today: a client id is required at intake, and every other reason
  // a payload cannot be built is already a skip with its own reason. It is a
  // backstop, and what it must not do is send.
  it("records invalid and sends nothing when there is no payload to send", async () => {
    const d = deps();
    await processSignupEvent(row({ stage: "verified", crm_client_id: "" }), d);
    expect(d.sendOpenai).not.toHaveBeenCalled();
    // `invalid` is the same word the insert itself writes for a payload that
    // could never be sent, and the one status no resend picks up -- nothing an
    // operator fixes would make this payload constructible. No pre-send write
    // either, so no attempt is spent and no clock is left behind.
    expect(d.saveOpenai.mock.calls).toEqual([
      [7, { status: "invalid", detail: "no sendable payload could be built", attempts: 0, nextAttemptAt: null }],
    ]);
    // And it says so, naming the row rather than the client.
    expect(d.logger.warn).toHaveBeenCalledWith(expect.stringContaining("row 7"));
  });

  it("is the empty id that is refused, not merely a falsy payload", async () => {
    // The id would otherwise be ":verified" -- the SAME id for every client with
    // no id, which does not lose the deduplication but merges different people's
    // conversions into one. Omitting the event is the smaller harm by far.
    const d = deps();
    await processSignupEvent(row({ stage: "verified" }), d);
    expect(d.sendOpenai).toHaveBeenCalledTimes(1);
    expect(d.sendOpenai.mock.calls[0][0].payload.events[0].id).toBe("88214:verified");
  });
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
    expect(event.event_name).toBe("ApprovedApplication");
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

  it("gives OpenAI the key, the pixel id and the endpoint each in its own place, and the row's own event", async () => {
    const d = deps({
      config: {
        ...deps().config,
        openaiApiKey: "openai-secret",
        openaiPixelId: "pixel-77",
        openaiEventsUrl: "https://bzr.example.test/v1/events",
      },
    });
    await processSignupEvent(
      row({ stage: "verified", email: "Ali@Example.com", phone: "+971501112233", oppref: "oppref-frozen" }),
      d
    );

    const arg = d.sendOpenai.mock.calls[0][0];
    // Three separate values on three separate lines of .env, and the sender puts
    // each in a different part of the request: the key in a header, the pixel id
    // on the query string, the URL as the URL. Crossing any two of them would
    // compile.
    expect(arg.apiKey).toBe("openai-secret");
    expect(arg.pixelId).toBe("pixel-77");
    expect(arg.eventsUrl).toBe("https://bzr.example.test/v1/events");

    const [event] = arg.payload.events;
    // The event name goes in `type`; `data.type` is the data FAMILY, which is a
    // different field that happens to share a name. `verified` has no event in
    // the taxonomy at all, so it travels as a custom event with its own name.
    expect(event.type).toBe("custom");
    expect(event.custom_event_name).toBe("client_verified");
    expect(event.data).toEqual({ type: "custom" });
    // `offline`, not `web`: these stages happen inside the CRM, with no browser
    // and no page, which is also why no source_url is invented for them.
    expect(event.action_source).toBe("offline");
    expect(event.source_url).toBeUndefined();
    // Identical on every retry, so a lost response cannot book a second
    // conversion.
    expect(event.id).toBe("88214:verified");
    // Milliseconds, from this row's own column.
    expect(event.timestamp_ms).toBe(new Date("2026-10-12T12:00:00Z").getTime());
    expect(event.oppref).toBe("oppref-frozen");
    expect(event.user).toEqual({
      emails_sha256: [openaiHashEmail("ali@example.com")],
      phone_numbers_sha256: [openaiHashPhone("+971501112233")],
    });
    // Nothing identifying in readable form, and nothing beyond the two
    // identifiers Meta already receives.
    expect(JSON.stringify(arg.payload)).not.toContain("Ali@Example.com");
    expect(JSON.stringify(arg.payload)).not.toContain("971501112233");
    expect(Object.keys(event.user)).toEqual(["emails_sha256", "phone_numbers_sha256"]);
    // Off unless the flag says otherwise, and omitted rather than sent as false.
    expect(arg.payload.validate_only).toBeUndefined();
  });

  it("asks OpenAI for the deposit as an order, priced in the currency's minor unit", async () => {
    // 2026-10-19: both platforms now learn what the deposit was worth, from the
    // one FXBO lookup. The amount is an INTEGER in the minor unit -- $129.99 is
    // 12999 -- where Meta's `value` for the same deposit is the decimal 129.99.
    const d = deps();
    await processSignupEvent(row({ stage: "first_deposit" }), d);
    const [event] = d.sendOpenai.mock.calls[0][0].payload.events;
    expect(event.type).toBe("order_created");
    expect(event.data).toEqual({ type: "contents", amount: 12999, currency: "USD" });
    expect(event.custom_event_name).toBeUndefined();
  });

  it("never prices a stage that has no deposit", async () => {
    for (const stage of ["lead", "verified", "live_account"]) {
      const d = deps();
      await processSignupEvent(row({ stage }), d);
      const [event] = d.sendOpenai.mock.calls[0][0].payload.events;
      expect(JSON.stringify(event), stage).not.toMatch(/amount|currency/i);
    }
  });
});

describe("rowToFields, field by field", () => {
  // The brief's case maps six of nineteen columns.
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
        // Added 2026-10-14: Brevo's gate reads this literal rather than
        // record_type, so the worker has to carry it out of the row.
        is_lead_raw: " 0 ",
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
      isLeadRaw: "0",
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
    // But the raw literal is empty rather than defaulted, and empty is not
    // "positively a lead": a row with no literal at all is still a Brevo send.
    expect(rowToFields({}).isLeadRaw).toBe("");
    expect(rowToFields({ is_lead_raw: null }).isLeadRaw).toBe("");
  });
});

describe("what is logged", () => {
  const failing = (status, detail, extra = {}) => vi.fn(async () => ({ status, retryable: false, detail, ...extra }));

  it("names each action that did not succeed with the masked contact and the provider's reason", async () => {
    // maskEmail / maskPhone must actually hide something for the check below to mean anything.
    expect(maskEmail("ali@example.com")).not.toBe("ali@example.com");
    expect(maskPhone("+971507192185")).not.toBe("+971507192185");
    // At each stage, since no one event runs every action: Meta's and OpenAI's
    // lines at a Meta stage, WhatsApp's and Brevo's at registration.
    for (const [stage, expected] of [
      [
        "verified",
        [
          `[crm-events] meta failed for ${maskEmail("ali@example.com")}: meta-reason`,
          `[crm-events] openai rejected for ${maskEmail("ali@example.com")}: openai-reason`,
        ],
      ],
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
        sendOpenai: failing("rejected", "openai-reason"),
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
    "OPENAI_CONVERSIONS_API_KEY",
    "OPENAI_PIXEL_ID",
    "OPENAI_EVENTS_URL",
    "OPENAI_VALIDATE_ONLY",
    "OPENAI_MAX_ATTEMPTS",
    // Not a setting of this module at all, and cleared here precisely so: it
    // belongs to the LLM agent in agent/llmAgent.js, a developer running these
    // tests may well have it set, and a worker that read it would post a
    // different company's secret to OpenAI's conversions endpoint on every
    // event. The case below leaves it set on purpose.
    "OPENAI_API_KEY",
    "SKIP_SOURCES",
    "CRM_EVENTS_WORKER_ENABLED",
    "CRM_EVENTS_WORKER_INTERVAL_SECONDS",
    "CRM_SEND_TIMEOUT_MS",
    // FXBO, for the first-deposit amount. Cleared here like every other
    // credential: a developer running these tests almost certainly has
    // API_TOKEN set, and a case that passed only because of their .env would
    // prove nothing about the wiring. The VITE_ names are the legacy fallback
    // server.js still accepts, so they have to go too or one of them answers.
    "API_TOKEN",
    "VITE_API_TOKEN",
    "API_VERSION",
    "VITE_API_VERSION",
    "REST_PROXY_TARGET",
  ];
  const SECRETS = { META_CAPI_ACCESS_TOKEN: "meta-secret", WA_API_KEY: "wa-secret", BREVO_API_KEY: "brevo-secret" };
  // BREVO_LIST_ID is the fourth value with no working default. Since 2026-10-14 an
  // unusable one is a terminal failure instead of a contact that joins no list, so
  // a case that wants a real Brevo send has to set it; the case that proves the
  // failure is the one that leaves it out.
  const CONFIGURED = { ...SECRETS, BREVO_LIST_ID: "19" };
  // The CRM credential the first-deposit lookup needs, and the default host it
  // is spent against. Its own group rather than part of CONFIGURED: it is a
  // fifth value with no working default, and only one stage needs it.
  const FXBO = { API_TOKEN: "crm-secret" };
  const CRM_TRANSACTIONS_URL = "https://portal.skylinkscapital.com/rest/transactions";
  // $129.99 -- the decimal and the minor-unit integer differ, so a wiring that
  // crossed the two units cannot pass.
  const CRM_DEPOSIT = {
    id: 5001,
    type: "deposit",
    createdAt: "2026-10-16 09:00:00",
    processedAmount: 129.99,
    processedCurrency: "USD",
    status: "approved",
  };

  let savedEnv;
  let fetchMock;
  let spies;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];

    for (const fn of Object.values(store)) fn.mockReset();
    store.claimDueEvents.mockResolvedValue([]);
    for (const fn of [
      store.updateMetaStatus,
      store.updateWhatsappStatus,
      store.updateBrevoStatus,
      store.updateOpenaiStatus,
    ]) {
      fn.mockResolvedValue(undefined);
    }

    fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.startsWith("https://graph.facebook.com/")) return { status: 200, json: async () => ({ events_received: 1 }) };
      if (u === DOUBLETICK_TEMPLATE_URL) {
        return { status: 200, json: async () => ({ messages: [{ status: "SENT", messageId: "wamid-live" }] }) };
      }
      // The id is the only thing in Brevo's answer that is PROOF -- `http 201`
      // says the request was accepted, not that a contact exists. A distinctive
      // number, so a column wired to the wrong value cannot pass by matching 1.
      if (u === BREVO_CONTACTS_URL) return { status: 201, json: async () => ({ id: 4821 }) };
      // OpenAI documents no response shape at all, so a 200 with an empty object
      // is the most honest fake there is.
      if (u.startsWith(OPENAI_EVENTS_URL)) return { status: 200, json: async () => ({}) };
      // FXBO's transaction list, which the first-deposit stage reads the amount
      // and currency from. A list, as the CRM returns.
      if (u.startsWith(CRM_TRANSACTIONS_URL)) return { status: 200, json: async () => [CRM_DEPOSIT] };
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

  describe("with only the three secrets and the Brevo list set", () => {
    it("at registration, sends WhatsApp and Brevo to the real providers with the documented defaults, never calls Meta, and records each in its own column", async () => {
      setEnv(CONFIGURED);
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
      // The configured list, and the contact joins it. It used to be acceptable
      // for this to be absent -- see the case below for what that costs.
      expect(bodyOf(brevoCall).listIds).toEqual([19]);

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
      // The whole of Part 1, end to end: Brevo's own response body, through the
      // classifier, into the column the tab reads. Without this the tab says
      // "Brevo sent -- http 201", which is the reading that prompted the work.
      expect(store.updateBrevoStatus.mock.calls[1][1].contactId).toBe("4821");

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

    it("skips every destination, and sends nothing, when nothing is configured", async () => {
      store.claimDueEvents.mockResolvedValue([liveRow()]);
      await sweepOnce();
      expect(fetchMock).not.toHaveBeenCalled();
      const settled = (writer) => writer.mock.calls.at(-1)[1];
      expect(settled(store.updateMetaStatus)).toMatchObject({ status: "skipped", detail: "meta not configured" });
      expect(settled(store.updateWhatsappStatus)).toMatchObject({ status: "skipped", detail: "whatsapp not configured" });
      expect(settled(store.updateBrevoStatus)).toMatchObject({ status: "skipped", detail: "brevo not configured" });
      // A missing key reads as "not configured" and not as the pixel's stage or
      // an expired row, because that is the one an operator can act on.
      expect(settled(store.updateOpenaiStatus)).toMatchObject({
        status: "skipped",
        detail: "openai not configured",
      });
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

  // The failure this whole decision exists for (2026-10-14, user's call). Until
  // today an unusable BREVO_LIST_ID failed OPEN: the contact was created, joined
  // no list, and the row said `sent`. Nobody would have found out until they
  // opened list 19 to run a campaign and found it short.
  describe("with the three secrets but no usable BREVO_LIST_ID", () => {
    for (const [label, value] of [
      ["unset", undefined],
      ["blank", "   "],
      ["not a number", "nineteen"],
      ["zero", "0"],
    ]) {
      it(`does not call Brevo at all when the list id is ${label}, and records a terminal failure`, async () => {
        setEnv(SECRETS);
        if (value !== undefined) setEnv({ BREVO_LIST_ID: value });
        store.claimDueEvents.mockResolvedValue([liveRow()]);
        await sweepOnce();

        // Not one request. A contact created outside the list is worse than none:
        // it looks like a success everywhere a person would check.
        expect(fetched(BREVO_CONTACTS_URL)).toHaveLength(0);
        // One write, the failure, with no pre-send claim ahead of it -- nothing was
        // attempted, so no attempt is spent -- and no clock, because a wrong
        // environment variable will not be right in five minutes.
        expect(store.updateBrevoStatus.mock.calls).toEqual([
          [
            7,
            {
              status: "failed",
              detail: "not sent: BREVO_LIST_ID is unset, blank or not a positive number",
              // No request was made, so there is no contact and no id to show.
              contactId: null,
              attempts: 0,
              nextAttemptAt: null,
            },
          ],
        ]);
        // WhatsApp still sends: the destinations are independent.
        expect(fetched(DOUBLETICK_TEMPLATE_URL)).toHaveLength(1);
        // And the row keeps its client data, which is what makes the resend
        // possible once the variable is fixed.
        expect(store.scrubSignupEvent).not.toHaveBeenCalled();
      });
    }

    it("says in the log what is wrong, without naming the value or any client", async () => {
      setEnv(SECRETS);
      store.claimDueEvents.mockResolvedValue([liveRow()]);
      await sweepOnce();
      const said = spies.warn.mock.calls.map(([line]) => line).join("\n");
      expect(said).toContain("BREVO_LIST_ID");
      // The commonest way this column goes wrong is a paste from the line above
      // it in .env, which is the API key.
      expect(said).not.toContain("brevo-secret");
      expect(said).not.toContain("ali@example.com");
      expect(said).not.toContain("+971501112233");
    });
  });

  // The fourth destination's own wiring, through the real sender with a stubbed
  // fetch. Three of the things that can go wrong here are invisible from the row
  // -- the timestamp's unit, the frozen click id, and whether the request
  // recorded anything at all -- so each is read off the request itself.
  describe("with the ChatGPT Ads key and pixel id set", () => {
    const OPENAI = { OPENAI_CONVERSIONS_API_KEY: "openai-secret", OPENAI_PIXEL_ID: "pixel-77" };
    // OpenAI sends at the stages the pixel does not own, which is every stage
    // except `registered`.
    const openaiRow = (over = {}) => liveRow({ stage: "verified", ...over });
    const openaiCall = () => fetched(OPENAI_EVENTS_URL)[0];
    const sentEvent = () => bodyOf(openaiCall()).events[0];

    it("posts one event to the pixel, with the key in a header and nowhere in the URL", async () => {
      setEnv(OPENAI);
      store.claimDueEvents.mockResolvedValue([openaiRow()]);
      await sweepOnce();

      const [url, init] = openaiCall();
      expect(url).toBe(`${OPENAI_EVENTS_URL}?pid=pixel-77`);
      // The pixel id is not a secret -- it is in the website's own pixel -- and
      // it is the only thing on the query string. A key in a request line ends
      // up in every proxy and access log there is.
      expect(url).not.toContain("openai-secret");
      expect(init.headers.Authorization).toBe("Bearer openai-secret");
      // One event per request, although 1,000 are allowed: "if one event in the
      // batch fails, the full batch fails", with no per-event error reporting.
      expect(bodyOf(openaiCall()).events).toHaveLength(1);
      expect(store.updateOpenaiStatus.mock.calls.at(-1)[1]).toMatchObject({
        status: "sent",
        attempts: 1,
        detail: "http 200",
      });
    });

    it("stamps timestamp_ms in milliseconds from the row's received_at, 13 digits of it", async () => {
      // **The defect this test exists for leaves no trace.** `eventTimeSeconds`
      // divides by 1000 for Meta, whose event_time is in seconds; passed here it
      // would stamp every event in 1970, and the only symptom would be OpenAI
      // refusing each one for falling outside their 7-day window -- no error, no
      // log line, nothing in the row. Thirteen digits is what a millisecond
      // timestamp of this era has and a second one does not.
      setEnv(OPENAI);
      const received = new Date("2026-10-12T12:00:00Z");
      store.claimDueEvents.mockResolvedValue([openaiRow({ received_at: received })]);
      await sweepOnce();

      const { timestamp_ms: stamped } = sentEvent();
      expect(String(stamped)).toMatch(/^\d{13}$/);
      expect(stamped).toBe(received.getTime());
      expect(Number.isInteger(stamped)).toBe(true);
    });

    it("carries the frozen oppref verbatim, from the column and not from full_link", async () => {
      // full_link is empty on this row, exactly as it is on a real one a minute
      // after signup, and on the first-deposit row weeks later it never carried
      // anything at all. The column is the only copy of the ad click.
      // FXBO's credential too: the first-deposit row below cannot be sent at all
      // without the deposit amount, so without it there would be one event here.
      setEnv({ ...OPENAI, ...FXBO });
      store.claimDueEvents.mockResolvedValue([
        openaiRow({ full_link: "", oppref: "oppref-frozen" }),
        openaiRow({ id: 8, stage: "first_deposit", full_link: "", oppref: null }),
      ]);
      await sweepOnce();

      const [first, deposit] = fetched(OPENAI_EVENTS_URL).map((call) => bodyOf(call).events[0]);
      expect(first.oppref).toBe("oppref-frozen");
      // Absent is normal and is not an error: the event is still sent, simply
      // unattributed. What must never appear is the word "null" in its place.
      expect(deposit.oppref).toBeUndefined();
      expect(JSON.stringify(deposit)).not.toContain("oppref");
    });

    it("reads OPENAI_CONVERSIONS_API_KEY, and never OPENAI_API_KEY", async () => {
      // Two OpenAI keys live in this project and only one of them belongs to
      // ChatGPT Ads. Reading the LLM agent's would send its secret to the
      // conversions endpoint on every event -- and, with no conversions key set,
      // would make a dead integration look configured.
      setEnv({ OPENAI_API_KEY: "llm-agent-secret", OPENAI_PIXEL_ID: "pixel-77" });
      store.claimDueEvents.mockResolvedValue([openaiRow()]);
      await sweepOnce();

      expect(fetched(OPENAI_EVENTS_URL)).toHaveLength(0);
      expect(store.updateOpenaiStatus.mock.calls.at(-1)[1]).toMatchObject({
        status: "skipped",
        detail: "openai not configured",
      });
      expect(JSON.stringify(spies.warn.mock.calls)).not.toContain("llm-agent-secret");
    });

    it("says in the detail that a validated request recorded nothing", async () => {
      // `validate_only` returns a 2xx and records NOTHING: such a request does
      // not appear in event monitoring at all. Without this the row reads `sent`
      // for a conversion that provably does not exist, and the overview counts
      // it as real.
      setEnv({ ...OPENAI, OPENAI_VALIDATE_ONLY: "true" });
      store.claimDueEvents.mockResolvedValue([openaiRow()]);
      await sweepOnce();

      expect(bodyOf(openaiCall()).validate_only).toBe(true);
      const saved = store.updateOpenaiStatus.mock.calls.at(-1)[1];
      expect(saved.status).toBe("sent");
      expect(saved.detail).toContain(OPENAI_VALIDATE_ONLY_DETAIL);
      // The provider's own word is still there to read beside it.
      expect(saved.detail).toContain("http 200");
    });

    it("marks a refused validation too, because that was not a conversion either", async () => {
      setEnv({ ...OPENAI, OPENAI_VALIDATE_ONLY: "true" });
      fetchMock.mockImplementation(async () => ({ status: 400, json: async () => ({ error: "bad family" }) }));
      store.claimDueEvents.mockResolvedValue([openaiRow()]);
      await sweepOnce();

      const saved = store.updateOpenaiStatus.mock.calls.at(-1)[1];
      expect(saved.status).toBe("rejected");
      expect(saved.detail).toContain(OPENAI_VALIDATE_ONLY_DETAIL);
      expect(saved.detail).toContain("bad family");
    });

    it("sends for real unless the flag is the literal true, so a stray value cannot silence it", async () => {
      // The inverse of CRM_EVENTS_WORKER_ENABLED's rule, and for the matching
      // reason: this flag stops every conversion being recorded while the rows
      // all read `sent`, so `1`, `yes` and `on` must not be what does that.
      for (const value of ["1", "yes", "on", "TRUE", "false", ""]) {
        store.updateOpenaiStatus.mockClear();
        fetchMock.mockClear();
        setEnv({ ...OPENAI, OPENAI_VALIDATE_ONLY: value });
        store.claimDueEvents.mockResolvedValue([openaiRow()]);
        await sweepOnce();

        const validating = String(value).toLowerCase() === "true";
        expect(bodyOf(openaiCall()).validate_only, value).toBe(validating ? true : undefined);
        const saved = store.updateOpenaiStatus.mock.calls.at(-1)[1];
        expect(String(saved.detail).includes(OPENAI_VALIDATE_ONLY_DETAIL), value).toBe(validating);
      }
    });

    it("reads OPENAI_EVENTS_URL, so the endpoint can be moved without a deploy", async () => {
      const moved = "https://bzr.example.test/v1/events";
      setEnv({ ...OPENAI, OPENAI_EVENTS_URL: moved });
      fetchMock.mockImplementation(async () => ({ status: 200, json: async () => ({}) }));
      store.claimDueEvents.mockResolvedValue([openaiRow()]);
      await sweepOnce();
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(`${moved}?pid=pixel-77`);
    });

    it("reads OPENAI_MAX_ATTEMPTS, falling back to three for anything unusable", async () => {
      // Configurable, so it travels in config beside every other value an
      // operator sets rather than as a constant beside Meta's and Brevo's.
      fetchMock.mockImplementation(async (url) =>
        String(url).startsWith(OPENAI_EVENTS_URL)
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
        ["abc", 2, "failed"],
      ]) {
        store.updateOpenaiStatus.mockClear();
        if (setting === undefined) delete process.env.OPENAI_MAX_ATTEMPTS;
        else process.env.OPENAI_MAX_ATTEMPTS = setting;
        setEnv(OPENAI);
        store.claimDueEvents.mockResolvedValue([openaiRow({ openai_attempts: made })]);
        await sweepOnce();
        expect(
          store.updateOpenaiStatus.mock.calls.at(-1)[1].status,
          `OPENAI_MAX_ATTEMPTS=${setting}, ${made} made`
        ).toBe(expected);
      }
    });

    it("never logs the key, the address or the phone number, on a failure", async () => {
      setEnv(OPENAI);
      fetchMock.mockImplementation(async () => {
        // The shape that leaks: a transport error quoting the request's own
        // headers back at us, which is both logged and stored.
        throw new Error("connect failed sending Authorization: Bearer openai-secret");
      });
      store.claimDueEvents.mockResolvedValue([openaiRow()]);
      await sweepOnce();

      const said = JSON.stringify(spies.warn.mock.calls) + JSON.stringify(store.updateOpenaiStatus.mock.calls);
      expect(said).not.toContain("openai-secret");
      expect(said).not.toContain("ali@example.com");
      expect(said).not.toContain("+971501112233");
      expect(said).toContain("[redacted]");
    });

    it("skips a row OpenAI would refuse for its age, naming the window, and sends nothing", async () => {
      // `timestamp_ms` comes from `received_at`, and re-stamping it with today's
      // time is not available: the row's whole purpose is to say when the
      // conversion happened. So a request would be certain to be rejected, and a
      // skip with a reason an operator can read is worth more than a spent retry
      // budget.
      setEnv(OPENAI);
      const tooOld = new Date(Date.now() - OPENAI_MAX_EVENT_AGE_MS - 60_000);
      store.claimDueEvents.mockResolvedValue([openaiRow({ received_at: tooOld })]);
      await sweepOnce();

      expect(fetched(OPENAI_EVENTS_URL)).toHaveLength(0);
      const saved = store.updateOpenaiStatus.mock.calls.at(-1)[1];
      expect(saved).toMatchObject({ status: "skipped", attempts: 0, nextAttemptAt: null });
      expect(saved.detail).toMatch(/outside OpenAI's window/);
      expect(saved.detail).toMatch(/7 days/);
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
    setEnv({ ...CONFIGURED, SKIP_SOURCES: "Other-Form, svg" });
    // Two events from the excluded source, since no one stage reaches every
    // destination: registration is where WhatsApp and Brevo send, and a Meta
    // stage is where Meta and OpenAI do.
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
      setEnv(CONFIGURED);
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

  // Retention. Both windows are the user's numbers, written as constants rather
  // than read from the environment: a window nobody chose is a window nobody can
  // be held to.
  //
  // The hourly gate lives in the sweep's own reckoning, not in a second timer --
  // timers die with the IIS worker, and a retention pass that silently stopped
  // running is the failure the thirty-day backstop exists to catch, so it cannot
  // depend on the same thing. That is also why each case below starts from a
  // system time later than the one before it: the only handle on the gate is the
  // clock the sweep reads.
  describe("the retention passes", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const startAt = (iso) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(iso));
      return new Date(iso);
    };

    it("asks for seven days for the invalid rows and thirty for the unscrubbed ones", async () => {
      // Seven days: an all-invalid row never sent anything and never will, and it
      // is the row CUTOVER step 5 reads, so it keeps everything until it goes.
      // Thirty days: the backstop for a row that never settles, so its client
      // data cannot outlive the month.
      const now = startAt("2027-01-01T00:00:00Z");
      expect(await sweepOnce()).toEqual({ processed: 0 });
      expect(store.deleteInvalidSignupEvents).toHaveBeenCalledTimes(1);
      expect(store.deleteInvalidSignupEvents).toHaveBeenCalledWith(new Date(now.getTime() - 7 * DAY));
      expect(store.scrubStaleSignupEvents).toHaveBeenCalledTimes(1);
      expect(store.scrubStaleSignupEvents).toHaveBeenCalledWith(new Date(now.getTime() - 30 * DAY), now);
    });

    it("deletes before it scrubs, so a seven-day invalid row still has its raw_payload when it goes", async () => {
      // The other order would let the thirty-day backstop scrub an invalid row
      // that the delete had not reached yet, leaving it in the table with the one
      // thing it was kept for already gone.
      startAt("2027-02-01T00:00:00Z");
      const order = [];
      store.deleteInvalidSignupEvents.mockImplementation(async () => {
        order.push("delete");
        return 0;
      });
      store.scrubStaleSignupEvents.mockImplementation(async () => {
        order.push("scrub");
        return 0;
      });
      await sweepOnce();
      expect(order).toEqual(["delete", "scrub"]);
    });

    it("runs at most once an hour, however often the sweep runs", async () => {
      // The sweep runs every 60 seconds. Two full-table passes a minute is not
      // what either window asks for.
      startAt("2027-03-01T00:00:00Z");
      await sweepOnce();
      await sweepOnce();
      await sweepOnce();
      expect(store.deleteInvalidSignupEvents).toHaveBeenCalledTimes(1);
      expect(store.scrubStaleSignupEvents).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2027-03-01T00:59:59Z"));
      await sweepOnce();
      expect(store.deleteInvalidSignupEvents).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2027-03-01T01:00:00Z"));
      await sweepOnce();
      expect(store.deleteInvalidSignupEvents).toHaveBeenCalledTimes(2);
      expect(store.scrubStaleSignupEvents).toHaveBeenCalledTimes(2);
    });

    it("runs even when no row was due, because retention is not about the due rows", async () => {
      startAt("2027-04-01T00:00:00Z");
      store.claimDueEvents.mockResolvedValue([]);
      await sweepOnce();
      expect(store.deleteInvalidSignupEvents).toHaveBeenCalledTimes(1);
    });

    it("does not run while the worker is switched off, and catches up when it is switched back on", async () => {
      // Which is the point of the thirty-day backstop: rows accumulate
      // unscrubbed while sending is paused, and the first sweep after it is
      // turned back on is where they are caught up.
      startAt("2027-05-01T00:00:00Z");
      setEnv({ CRM_EVENTS_WORKER_ENABLED: "false" });
      expect(await sweepOnce()).toEqual({ disabled: true });
      expect(store.deleteInvalidSignupEvents).not.toHaveBeenCalled();
      expect(store.scrubStaleSignupEvents).not.toHaveBeenCalled();

      setEnv({ CRM_EVENTS_WORKER_ENABLED: "true" });
      await sweepOnce();
      expect(store.deleteInvalidSignupEvents).toHaveBeenCalledTimes(1);
    });

    it("logs a failed pass, still reports the sweep's rows, and does not retry it every minute", async () => {
      // Retention is housekeeping. A sweep that delivered three welcomes must not
      // report itself as failed because a DELETE timed out -- and a pass that
      // throws every time must not throw at every sweep for an hour.
      startAt("2027-06-01T00:00:00Z");
      store.claimDueEvents.mockResolvedValue([]);
      store.deleteInvalidSignupEvents.mockRejectedValue(new Error("ER_LOCK_WAIT_TIMEOUT"));
      expect(await sweepOnce()).toEqual({ processed: 0 });
      expect(spies.error).toHaveBeenCalledWith("[crm-events] retention pass failed: ER_LOCK_WAIT_TIMEOUT");
      expect(store.scrubStaleSignupEvents).not.toHaveBeenCalled();

      vi.setSystemTime(new Date("2027-06-01T00:01:00Z"));
      await sweepOnce();
      expect(store.deleteInvalidSignupEvents).toHaveBeenCalledTimes(1);
    });

    it("says what it removed, with the window it applied, and says nothing when there was nothing", async () => {
      startAt("2027-07-01T00:00:00Z");
      store.deleteInvalidSignupEvents.mockResolvedValue(2);
      store.scrubStaleSignupEvents.mockResolvedValue(3);
      await sweepOnce();
      expect(spies.log).toHaveBeenCalledWith(
        "[crm-events] retention: 2 invalid rows deleted after 7 days, 3 unscrubbed rows scrubbed after 30"
      );

      vi.setSystemTime(new Date("2027-07-01T01:00:00Z"));
      store.deleteInvalidSignupEvents.mockResolvedValue(0);
      store.scrubStaleSignupEvents.mockResolvedValue(0);
      spies.log.mockClear();
      await sweepOnce();
      expect(store.deleteInvalidSignupEvents).toHaveBeenCalledTimes(2);
      expect(spies.log).not.toHaveBeenCalled();
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

  describe("the first-deposit amount, from FXBO", () => {
    const depositRow = (overrides = {}) => liveRow({ stage: "first_deposit", ...overrides });
    const crmCall = () => fetched(CRM_TRANSACTIONS_URL)[0];

    it("asks FXBO once and prices both conversions from the one answer", async () => {
      // The whole change, end to end: one CRM call, Meta's decimal and ChatGPT
      // Ads' minor-unit integer, from the real senders and the real lookup.
      setEnv({ ...CONFIGURED, ...FXBO, OPENAI_CONVERSIONS_API_KEY: "openai-secret", OPENAI_PIXEL_ID: "pixel-77" });
      store.claimDueEvents.mockResolvedValue([depositRow()]);
      await sweepOnce();

      expect(fetched(CRM_TRANSACTIONS_URL)).toHaveLength(1);
      const { custom_data } = bodyOf(fetched("https://graph.facebook.com/")[0]).data[0];
      const [event] = bodyOf(fetched(OPENAI_EVENTS_URL)[0]).events;
      expect(custom_data).toMatchObject({ value: 129.99, currency: "USD" });
      expect(event.data).toEqual({ type: "contents", amount: 12999, currency: "USD" });
    });

    it("reads API_TOKEN and REST_PROXY_TARGET, the same two server.js's /rest proxy reads", async () => {
      // Not api.skylinkscapital.com and not BACKEND_API_KEY: that is the trading
      // backend, and either token sent to the other host authenticates to
      // neither. The token travels in a header, never in the URL, because a URL
      // is echoed in every proxy log in between.
      setEnv({ ...SECRETS, ...FXBO, REST_PROXY_TARGET: "https://crm.example.test", API_VERSION: "2.1.0" });
      store.claimDueEvents.mockResolvedValue([depositRow()]);
      fetchMock.mockImplementation(async (url) => {
        const u = String(url);
        if (u.startsWith("https://crm.example.test/")) return { status: 200, json: async () => [CRM_DEPOSIT] };
        return { status: 200, json: async () => ({ events_received: 1 }) };
      });
      await sweepOnce();

      const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).includes("/rest/transactions"));
      expect(url).toBe("https://crm.example.test/rest/transactions?version=2.1.0");
      expect(url).not.toContain("crm-secret");
      expect(init.headers.Authorization).toBe("Bearer crm-secret");
      expect(JSON.parse(init.body)).toMatchObject({ fromUserId: 88214, statuses: ["approved"] });
    });

    it("defaults to the CRM host and version the rest of the repository uses", async () => {
      setEnv({ ...SECRETS, ...FXBO });
      store.claimDueEvents.mockResolvedValue([depositRow()]);
      await sweepOnce();
      expect(String(crmCall()[0])).toBe("https://portal.skylinkscapital.com/rest/transactions?version=1.0.0");
    });

    it("holds the Purchase back, rather than sending one Meta would discard, when FXBO has no record yet", async () => {
      setEnv({ ...SECRETS, ...FXBO });
      fetchMock.mockImplementation(async (url) =>
        String(url).includes("/rest/transactions")
          ? { status: 200, json: async () => [] }
          : { status: 200, json: async () => ({ events_received: 1 }) }
      );
      store.claimDueEvents.mockResolvedValue([depositRow()]);
      await sweepOnce();

      expect(fetched("https://graph.facebook.com/")).toHaveLength(0);
      expect(store.updateMetaStatus.mock.calls.at(-1)[1]).toMatchObject({
        status: "retrying",
        detail: "deposit lookup: no approved deposit for this client yet",
      });
    });

    it("fails the Purchase by name when API_TOKEN is unset, rather than skipping it", async () => {
      // `failed` and not `skipped`: a skip is a deliberate decision not to send
      // and nothing decided this, and a skipped row is final while a failed one
      // keeps its client data and can be resent once the variable is right.
      setEnv(SECRETS);
      store.claimDueEvents.mockResolvedValue([depositRow()]);
      await sweepOnce();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.updateMetaStatus.mock.calls.at(-1)[1]).toMatchObject({
        status: "failed",
        detail: "deposit lookup: API_TOKEN is not set, so the CRM cannot be asked",
      });
    });

    it("asks FXBO nothing at the stages that arrive in volume", async () => {
      // The cost control, proved against the real lookup: a handful of first
      // deposits a day, and no CRM call on any other stage.
      for (const stage of ["registered", "verified", "live_account"]) {
        fetchMock.mockClear();
        setEnv({ ...CONFIGURED, ...FXBO });
        store.claimDueEvents.mockResolvedValue([liveRow({ stage })]);
        await sweepOnce();
        expect(fetched(CRM_TRANSACTIONS_URL), stage).toHaveLength(0);
      }
    });

    it("never logs the CRM token or the client's address on a lookup failure", async () => {
      setEnv({ ...SECRETS, ...FXBO });
      fetchMock.mockImplementation(async (url) => {
        if (String(url).includes("/rest/transactions")) {
          // The shape that leaks: a transport error quoting the request's own
          // header back at us, which is both logged and stored.
          throw new Error("connect failed sending Authorization: Bearer crm-secret");
        }
        return { status: 200, json: async () => ({ events_received: 1 }) };
      });
      store.claimDueEvents.mockResolvedValue([depositRow({ email: "Ali@Example.com" })]);
      await sweepOnce();

      const logged = JSON.stringify(spies.warn.mock.calls) + JSON.stringify(spies.error.mock.calls);
      expect(logged).not.toContain("Ali@Example.com");
      const stored = JSON.stringify(store.updateMetaStatus.mock.calls);
      expect(stored).not.toContain("Ali@Example.com");
      // The token reaches the detail only because the fake put it in the error
      // message; a real transport error cannot, because the lookup never puts
      // the token in the URL. Pinned so the assertion is read as what it is.
      expect(String(crmCall()[0])).not.toContain("crm-secret");
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
