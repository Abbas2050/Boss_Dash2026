// The CRM events tab. jsdom is the project default, so no environment comment.
//
// The health strip is the reason this page exists: a broken FXBO rule produces
// no error anywhere, it just stops calling, and nothing else would notice.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CrmEventsPage } from "./CrmEventsPage";

const SESSION_KEY = "slc.session.v2";

const OVERVIEW = {
  windowDays: 30,
  health: {
    lastReceivedAt: "2026-10-13T11:00:00.000Z",
    ageHours: 1,
    stale: false,
    stages: {
      lead: { lastReceivedAt: null, ageHours: null, stale: false, everSeen: false },
      registered: { lastReceivedAt: "2026-10-13T11:00:00.000Z", ageHours: 1, stale: false, everSeen: true },
      verified: { lastReceivedAt: "2026-10-09T11:00:00.000Z", ageHours: 96, stale: true, everSeen: true },
      live_account: { lastReceivedAt: null, ageHours: null, stale: false, everSeen: false },
      first_deposit: { lastReceivedAt: null, ageHours: null, stale: false, everSeen: false },
    },
  },
  funnel: { lead: 0, registered: 12, verified: 5, live_account: 3, first_deposit: 2 },
  destinations: {
    meta: { pending: 0, sent: 20, skipped: 0, retrying: 1, failed: 1, rejected: 0, invalid: 0 },
    whatsapp: { pending: 0, sent: 10, skipped: 12, retrying: 0, failed: 0, rejected: 0, invalid: 0 },
    brevo: { pending: 0, sent: 12, skipped: 10, retrying: 0, failed: 0, rejected: 0, invalid: 0 },
    // `skipped` is the big number here and that is the ordinary case: every
    // registration is the website pixel's, so ChatGPT Ads deliberately sends
    // nothing for that stage.
    openai: { pending: 0, sent: 10, skipped: 12, retrying: 0, failed: 0, rejected: 0, invalid: 0 },
  },
  events: [
    {
      id: 1,
      receivedAt: "2026-10-13T11:00:00.000Z",
      stage: "registered",
      crmClientId: "88214",
      name: "Ali Khan",
      email: "a***@example.com",
      phone: "+971***85",
      recordType: "client",
      source: "SVG",
      meta: { status: "sent", detail: "http 200", attempts: 1 },
      whatsapp: { status: "sent", detail: "SENT", attempts: 1 },
      brevo: { status: "sent", detail: "http 201", attempts: 1 },
      openai: { status: "skipped", detail: "registered is owned by the website pixel", attempts: 0 },
    },
    {
      id: 2,
      receivedAt: "2026-10-13T10:00:00.000Z",
      stage: "verified",
      crmClientId: "88215",
      name: "Sara Noor",
      email: "s***@example.com",
      phone: "+971***12",
      recordType: "client",
      source: "UAE",
      meta: { status: "failed", detail: "http 400 Invalid parameter", attempts: 3 },
      whatsapp: { status: "skipped", detail: "stage not applicable", attempts: 0 },
      brevo: { status: "skipped", detail: "stage not applicable", attempts: 0 },
      openai: { status: "sent", detail: "http 200", attempts: 1 },
    },
  ],
};

function installFetch(payload: unknown = OVERVIEW, status = 200) {
  const fn = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token: "test.session.jwt",
      user: { id: "u1", name: "T", email: "t@t", role: "Super Admin", access: [], status: "active" },
      at: Date.now(),
    }),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("health strip", () => {
  it("shows when the last event arrived", async () => {
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByText(/last event/i);
    expect(screen.getByText(/1 hour/i)).toBeTruthy();
  });

  it("warns loudly when nothing has arrived recently", async () => {
    // The whole point of the strip: silence is the symptom of a broken rule.
    installFetch({ ...OVERVIEW, health: { lastReceivedAt: null, ageHours: null, stale: true } });
    render(<CrmEventsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/no (crm )?events/i);
  });

  it("warns when events have stopped, even though some exist", async () => {
    installFetch({
      ...OVERVIEW,
      health: { lastReceivedAt: "2026-10-01T11:00:00.000Z", ageHours: 300, stale: true },
    });
    render(<CrmEventsPage />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("per-stage health", () => {
  it("warns about a stage that fired and then stopped, even while the overall reading is green", async () => {
    // The funnel runs five separate FXBO rules. One global timestamp stays
    // green as long as ANY rule is firing, so a dead `verified` rule is
    // invisible there -- and the 30-day funnel count still shows its
    // pre-failure number for most of a month.
    installFetch();
    render(<CrmEventsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/verified/i);
    expect(alert).toHaveTextContent(/4 days/i);
  });

  it("does not warn about a stage that has never fired", async () => {
    // `lead` has no FXBO rule yet, because the trigger does not exist. A tab
    // permanently red for a reason nobody can fix is one people stop reading.
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByTestId("funnel-lead");
    const alerts = screen.queryAllByRole("alert").map((a) => a.textContent ?? "");
    expect(alerts.join(" ")).not.toMatch(/\blead\b/i);
    expect(screen.getByTestId("stage-health-lead")).toHaveTextContent(/never/i);
  });
});

describe("counts", () => {
  it("shows a tile for every funnel stage, zeroes included", async () => {
    // A zero says that stage's rule is not firing, which is information.
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByTestId("funnel-registered");
    for (const label of [/lead/i, /registered/i, /verified/i, /live account/i, /first deposit/i]) {
      expect(screen.getAllByText(label).length, String(label)).toBeGreaterThan(0);
    }
    expect(screen.getByTestId("funnel-registered")).toHaveTextContent("12");
    expect(screen.getByTestId("funnel-lead")).toHaveTextContent("0");
  });

  it("shows sent and failed per destination", async () => {
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByTestId("dest-meta");
    expect(screen.getByTestId("dest-meta")).toHaveTextContent("20");
    expect(screen.getByTestId("dest-meta")).toHaveTextContent("1");
    expect(screen.getByTestId("dest-whatsapp")).toHaveTextContent("10");
  });
});

describe("the events table", () => {
  it("lists events with all three statuses", async () => {
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByText("88214");
    expect(screen.getByText("88215")).toBeTruthy();
    expect(screen.getByText(/http 400 Invalid parameter/)).toBeTruthy();
  });

  it("filters by stage", async () => {
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByText("88214");

    fireEvent.change(screen.getByLabelText(/stage/i), { target: { value: "verified" } });

    await waitFor(() => expect(screen.queryByText("88214")).toBeNull());
    expect(screen.getByText("88215")).toBeTruthy();
  });

  it("filters to problems only", async () => {
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByText("88214");

    fireEvent.click(screen.getByLabelText(/problems only/i));

    // 88215 has a failed Meta send; 88214 is clean.
    await waitFor(() => expect(screen.queryByText("88214")).toBeNull());
    expect(screen.getByText("88215")).toBeTruthy();
  });

  it("says so plainly when the window holds nothing", async () => {
    installFetch({ ...OVERVIEW, events: [] });
    render(<CrmEventsPage />);
    expect(await screen.findByText(/no events in this period/i)).toBeTruthy();
  });
});

describe("loading and failure", () => {
  it("reports a failed request instead of rendering empty tiles", async () => {
    installFetch({ error: "overview_failed" }, 500);
    render(<CrmEventsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);
  });

  it("sends the session token", async () => {
    const fn = installFetch();
    render(<CrmEventsPage />);
    await screen.findByText("88214");
    const [, init] = fn.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: expect.stringContaining("test.session.jwt") });
  });

  it("refetches when the window changes", async () => {
    const fn = installFetch();
    render(<CrmEventsPage />);
    await screen.findByText("88214");

    fireEvent.change(screen.getByLabelText(/period/i), { target: { value: "7" } });

    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(String(fn.mock.calls[1][0])).toContain("days=7");
  });
});

// ---------------------------------------------------------------------------
// Beyond the plan's tests. Everything above asserts that the right words appear
// somewhere on the page; everything below pins WHICH value lands in WHICH cell,
// because a mutation sweep of the page above found wirings that produced the
// same output: two counts that are equal, a status that is the same in all
// three destinations, a URL no test reads, an error branch nothing reaches.
// ---------------------------------------------------------------------------

const OVERVIEW_URL = "/api/crm-events/overview";

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Every number is different, so a count wired to the wrong cell cannot hide
 *  behind an equal neighbour. Stages are in all four states: never, receiving,
 *  and two that have gone quiet for different lengths of time. */
const DISTINCT = {
  windowDays: 30,
  health: {
    lastReceivedAt: "2026-10-13T09:00:00.000Z",
    ageHours: 2,
    stale: false,
    stages: {
      lead: { lastReceivedAt: null, ageHours: null, stale: false, everSeen: false },
      registered: { lastReceivedAt: "2026-10-13T09:00:00.000Z", ageHours: 2, stale: false, everSeen: true },
      verified: { lastReceivedAt: "2026-10-09T11:00:00.000Z", ageHours: 96, stale: true, everSeen: true },
      live_account: { lastReceivedAt: "2026-10-08T20:30:00.000Z", ageHours: 120, stale: true, everSeen: true },
      first_deposit: { lastReceivedAt: "2026-10-12T10:00:00.000Z", ageHours: 23.4, stale: false, everSeen: true },
    },
  },
  funnel: { lead: 21, registered: 22, verified: 23, live_account: 24, first_deposit: 25 },
  destinations: {
    meta: { sent: 31, failed: 32, rejected: 33, retrying: 34, skipped: 35, pending: 36, invalid: 37 },
    whatsapp: { sent: 41, failed: 42, rejected: 43, retrying: 44, skipped: 45, pending: 46, invalid: 47 },
    brevo: { sent: 51, failed: 52, rejected: 53, retrying: 54, skipped: 55, pending: 56, invalid: 57 },
    openai: { sent: 61, failed: 62, rejected: 63, retrying: 64, skipped: 65, pending: 66, invalid: 67 },
  },
  events: [] as unknown[],
};

const withHealth = (health: Record<string, unknown>) => ({ ...DISTINCT, health });

const FRESH = { lastReceivedAt: "2026-10-13T11:00:00.000Z", ageHours: 1, stale: false };

function event(id: number, crmClientId: string, stage: string, statuses: [string, string, string, string]) {
  const [meta, whatsapp, brevo, openai] = statuses;
  return {
    id,
    receivedAt: "2026-10-13T11:00:00.000Z",
    stage,
    crmClientId,
    name: `Name ${id}`,
    email: "x***@example.com",
    phone: "+971***00",
    recordType: "client",
    source: "SVG",
    meta: { status: meta, detail: null, attempts: 0 },
    whatsapp: { status: whatsapp, detail: null, attempts: 0 },
    brevo: { status: brevo, detail: null, attempts: 0 },
    openai: { status: openai, detail: null, attempts: 0 },
  };
}

/** The CRM ids of the rows the table is showing, in order. */
function shownIds() {
  return screen
    .queryAllByRole("row")
    .slice(1)
    .map((tr) => within(tr).getAllByRole("cell")[2].textContent);
}

/** A fetch the test answers by hand, request by request. */
function deferredFetch() {
  const waiting = new Map<string, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
  const fn = vi.fn(
    (input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        waiting.set(String(input), { resolve, reject });
      }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  const at = (days: number) => {
    const w = waiting.get(`${OVERVIEW_URL}?days=${days}`);
    if (!w) throw new Error(`no request for days=${days}`);
    return w;
  };
  return {
    fn,
    answer: (days: number, r: Response) => at(days).resolve(r),
    fail: (days: number) => at(days).reject(new Error("network down")),
  };
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 25)); });

describe("the request", () => {
  it("asks our own server for the overview, over the default 30 days, with the session bearer", async () => {
    // A bare /api path on a single-page app that is NOT served by this server
    // would answer 200 with index.html and render empty, so the URL is pinned
    // whole rather than by substring.
    const fn = installFetch();
    render(<CrmEventsPage />);
    await screen.findByText("88214");
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe("/api/crm-events/overview?days=30");
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer test.session.jwt" });
  });

  it.each(["7", "90"])("asks for %s days when that period is chosen", async (value) => {
    const fn = installFetch();
    render(<CrmEventsPage />);
    await screen.findByText("88214");

    fireEvent.change(screen.getByLabelText(/period/i), { target: { value } });

    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(fn.mock.calls[1][0]).toBe(`/api/crm-events/overview?days=${value}`);
  });

  it("asks for 30 days again when the period is put back", async () => {
    const fn = installFetch();
    render(<CrmEventsPage />);
    await screen.findByText("88214");
    fireEvent.change(screen.getByLabelText(/period/i), { target: { value: "90" } });
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByLabelText(/period/i), { target: { value: "30" } });

    await waitFor(() => expect(fn).toHaveBeenCalledTimes(3));
    expect(fn.mock.calls[2][0]).toBe("/api/crm-events/overview?days=30");
  });
});

describe("overall health in words", () => {
  it.each([
    [0.001, "1 minute ago"],
    [0.0425, "3 minutes ago"],
    [0.5, "30 minutes ago"],
    [1, "1 hour ago"],
    [1.4, "1 hour ago"],
    [5.6, "6 hours ago"],
    [47.6, "48 hours ago"],
    [48, "2 days ago"],
    [71, "3 days ago"],
  ])("reads %s hours as %s", async (ageHours, words) => {
    installFetch(withHealth({ ...FRESH, ageHours }));
    render(<CrmEventsPage />);
    expect(await screen.findByText(`Last event ${words}.`)).toBeTruthy();
  });

  it("does not claim the last event was a minute ago when the age is simply missing", async () => {
    // A null age would otherwise fall through the "under an hour" branch and
    // read as the calmest thing the page can say.
    installFetch(withHealth({ ...FRESH, ageHours: null }));
    render(<CrmEventsPage />);
    expect(await screen.findByText("Last event an unknown time ago.")).toBeTruthy();
  });

  it("says how long it has been, in the alert, once the whole feed has stopped", async () => {
    installFetch(withHealth({ lastReceivedAt: "2026-10-01T11:00:00.000Z", ageHours: 288, stale: true }));
    render(<CrmEventsPage />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No CRM events for 12 days. A rule in FXBO may have stopped firing.",
    );
    // The alert already says it; a second "last event" line would only repeat it.
    expect(screen.queryByText(/last event/i)).toBeNull();
  });

  it("says nothing was ever received, and does not also report a last event, for an empty table", async () => {
    installFetch(withHealth({ lastReceivedAt: null, ageHours: null, stale: true }));
    render(<CrmEventsPage />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No CRM events received at all. Check that the FXBO rules exist and point at this endpoint.",
    );
    expect(screen.queryByText(/last event/i)).toBeNull();
  });
});

describe("stage health in detail", () => {
  it("gives every stage its own reading, with its own last-seen time in Dubai", async () => {
    installFetch(DISTINCT);
    render(<CrmEventsPage />);
    await screen.findByTestId("stage-health-lead");
    const chip = (key: string) => screen.getByTestId(`stage-health-${key}`).textContent;
    expect(chip("lead")).toBe("LeadNever received");
    expect(chip("registered")).toBe("RegisteredReceivingLast seen Oct 13, 13:00:00 Dubai");
    expect(chip("verified")).toBe("VerifiedQuiet for 4 daysLast seen Oct 09, 15:00:00 Dubai");
    // 20:30 UTC on the 8th is 00:30 on the 9th in Dubai: the date moves too.
    expect(chip("live_account")).toBe("Live accountQuiet for 5 daysLast seen Oct 09, 00:30:00 Dubai");
    expect(chip("first_deposit")).toBe("First depositReceivingLast seen Oct 12, 14:00:00 Dubai");
  });

  it("lists every stage that has gone quiet, each with its own age, and no other", async () => {
    installFetch(DISTINCT);
    render(<CrmEventsPage />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Verified: no event for 4 days.",
      "Live account: no event for 5 days.",
    ]);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("raises the whole-feed alert and the stage alert separately when both apply", async () => {
    installFetch(
      withHealth({
        ...DISTINCT.health,
        lastReceivedAt: "2026-10-01T11:00:00.000Z",
        ageHours: 288,
        stale: true,
      }),
    );
    render(<CrmEventsPage />);
    await screen.findByTestId("stage-health-lead");
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });

  it("raises no alert when every stage that has ever fired is current", async () => {
    installFetch(
      withHealth({
        ...FRESH,
        stages: {
          ...DISTINCT.health.stages,
          verified: { lastReceivedAt: "2026-10-13T08:00:00.000Z", ageHours: 3, stale: false, everSeen: true },
          live_account: { lastReceivedAt: "2026-10-13T07:00:00.000Z", ageHours: 4, stale: false, everSeen: true },
        },
      }),
    );
    render(<CrmEventsPage />);
    await screen.findByTestId("stage-health-lead");
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("does not warn about a stage that has never fired, even if the payload also calls it stale", async () => {
    installFetch(
      withHealth({
        ...FRESH,
        stages: {
          ...DISTINCT.health.stages,
          verified: { lastReceivedAt: "2026-10-13T08:00:00.000Z", ageHours: 3, stale: false, everSeen: true },
          live_account: { lastReceivedAt: "2026-10-13T07:00:00.000Z", ageHours: 4, stale: false, everSeen: true },
          lead: { lastReceivedAt: null, ageHours: null, stale: true, everSeen: false },
        },
      }),
    );
    render(<CrmEventsPage />);
    await screen.findByTestId("stage-health-lead");
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(screen.getByTestId("stage-health-lead").textContent).toBe("LeadNever received");
  });

  it("colours a quiet stage as a warning, a live one as healthy and a never-fired one as neither", async () => {
    installFetch(DISTINCT);
    render(<CrmEventsPage />);
    await screen.findByTestId("stage-health-lead");
    const stateClass = (key: string, words: string) =>
      within(screen.getByTestId(`stage-health-${key}`)).getByText(words).className;
    expect(stateClass("verified", "Quiet for 4 days")).toMatch(/amber/);
    expect(stateClass("registered", "Receiving")).toMatch(/emerald/);
    expect(stateClass("lead", "Never received")).toMatch(/muted/);
  });

  it("still renders, and says so, when a response carries no per-stage readings", async () => {
    // Not a healthy reading: the page cannot tell, and says that.
    installFetch(withHealth(FRESH));
    render(<CrmEventsPage />);
    await screen.findByTestId("stage-health-lead");
    for (const key of ["lead", "registered", "verified", "live_account", "first_deposit"]) {
      expect(screen.getByTestId(`stage-health-${key}`).textContent).toMatch(/Not reported$/);
    }
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("marks only the missing stage as not reported when one is left out", async () => {
    const { live_account: _left, ...rest } = DISTINCT.health.stages;
    installFetch(withHealth({ ...DISTINCT.health, stages: rest }));
    render(<CrmEventsPage />);
    await screen.findByTestId("stage-health-lead");
    expect(screen.getByTestId("stage-health-live_account").textContent).toBe("Live accountNot reported");
    expect(screen.getByTestId("stage-health-verified").textContent).toMatch(/Quiet for 4 days/);
  });
});

describe("counts land in the right cell", () => {
  it("shows each funnel stage's own number under its own name", async () => {
    installFetch(DISTINCT);
    render(<CrmEventsPage />);
    await screen.findByTestId("funnel-lead");
    expect(screen.getByTestId("funnel-lead").textContent).toBe("21Lead");
    expect(screen.getByTestId("funnel-registered").textContent).toBe("22Registered");
    expect(screen.getByTestId("funnel-verified").textContent).toBe("23Verified");
    expect(screen.getByTestId("funnel-live_account").textContent).toBe("24Live account");
    expect(screen.getByTestId("funnel-first_deposit").textContent).toBe("25First deposit");
  });

  it("shows a zero for a stage the response leaves out of the funnel", async () => {
    installFetch({ ...DISTINCT, funnel: { registered: 22 } });
    render(<CrmEventsPage />);
    await screen.findByTestId("funnel-lead");
    expect(screen.getByTestId("funnel-registered").textContent).toBe("22Registered");
    expect(screen.getByTestId("funnel-lead").textContent).toBe("0Lead");
    expect(screen.getByTestId("funnel-first_deposit").textContent).toBe("0First deposit");
  });

  it("shows each destination's own seven counts, in the backend's order, under its own name", async () => {
    // The backend's seven, in crmSignup/stats.js order. `pending` is how a dead
    // dispatch worker shows up and `invalid` is a problem the table flags, so a
    // card without them looks clean while the pipeline is not.
    installFetch(DISTINCT);
    render(<CrmEventsPage />);
    await screen.findByTestId("dest-meta");
    expect(screen.getByTestId("dest-meta").textContent).toBe(
      "Metapending36sent31skipped35retrying34failed32rejected33invalid37",
    );
    expect(screen.getByTestId("dest-whatsapp").textContent).toBe(
      "WhatsApppending46sent41skipped45retrying44failed42rejected43invalid47",
    );
    expect(screen.getByTestId("dest-brevo").textContent).toBe(
      "Brevopending56sent51skipped55retrying54failed52rejected53invalid57",
    );
    // The fourth card, under the name the ChatGPT Ads conversion setup screen
    // uses rather than the column prefix. Without it a destination that sends,
    // retries and scrubs perfectly has no card at all, and this page reports a
    // healthy three-destination system.
    expect(screen.getByTestId("dest-openai").textContent).toBe(
      "ChatGPT Adspending66sent61skipped65retrying64failed62rejected63invalid67",
    );
  });

  it("shows zeroes for a destination or a status the response leaves out", async () => {
    installFetch({ ...DISTINCT, destinations: { meta: { sent: 31 } } });
    render(<CrmEventsPage />);
    await screen.findByTestId("dest-meta");
    expect(screen.getByTestId("dest-meta").textContent).toBe(
      "Metapending0sent31skipped0retrying0failed0rejected0invalid0",
    );
    expect(screen.getByTestId("dest-brevo").textContent).toBe(
      "Brevopending0sent0skipped0retrying0failed0rejected0invalid0",
    );
    expect(screen.getByTestId("dest-openai").textContent).toBe(
      "ChatGPT Adspending0sent0skipped0retrying0failed0rejected0invalid0",
    );
  });

  it("colours sent as healthy, failed as a problem and skipped as neither", async () => {
    installFetch(DISTINCT);
    render(<CrmEventsPage />);
    await screen.findByTestId("dest-meta");
    const label = (status: string) => within(screen.getByTestId("dest-meta")).getByText(status).className;
    expect(label("sent")).toMatch(/emerald/);
    expect(label("failed")).toMatch(/red/);
    expect(label("retrying")).toMatch(/red/);
    expect(label("skipped")).toMatch(/muted/);
    expect(label("invalid")).toMatch(/red/);
    expect(label("pending")).toMatch(/muted/);
  });
});

describe("the events table in detail", () => {
  const FULL = {
    id: 7,
    receivedAt: "2026-10-13T20:30:00.000Z",
    stage: "live_account",
    crmClientId: "90001",
    name: "Omar Haddad",
    email: "o***@mail.test",
    phone: "+966***44",
    recordType: "client",
    source: "KSA",
    meta: { status: "sent", detail: "http 200", attempts: 1 },
    whatsapp: { status: "retrying", detail: "http 503 upstream", attempts: 2 },
    brevo: { status: "invalid", detail: "no email address", attempts: 1 },
    openai: { status: "rejected", detail: "http 400 unknown field", attempts: 1 },
  };

  it("puts every field in its own column, with the three destinations in a fixed order", async () => {
    installFetch({ ...DISTINCT, events: [FULL] });
    render(<CrmEventsPage />);
    await screen.findByText("90001");
    const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells.map((td) => td.textContent)).toEqual([
      // 20:30 UTC is half past midnight the NEXT day in Dubai.
      "Oct 14, 00:30:00",
      "Live account",
      "90001",
      "Omar Haddad",
      "o***@mail.test",
      "+966***44",
      "KSA",
      "senthttp 200",
      "retryinghttp 503 upstream",
      "invalidno email address",
      "rejectedhttp 400 unknown field",
    ]);
  });

  it("labels the columns, saying which clock the time is on", async () => {
    installFetch({ ...DISTINCT, events: [FULL] });
    render(<CrmEventsPage />);
    await screen.findByText("90001");
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Received (Dubai)",
      "Stage",
      "CRM id",
      "Name",
      "Email",
      "Phone",
      "Form",
      "Meta",
      "WhatsApp",
      "Brevo",
      "ChatGPT Ads",
    ]);
  });

  it("shows a stage it does not know by its raw name, and a missing reason as nothing", async () => {
    const odd = {
      ...FULL,
      id: 8,
      crmClientId: "90002",
      stage: "mystery",
      meta: { status: "skipped", detail: null, attempts: 0 },
    };
    installFetch({ ...DISTINCT, events: [odd] });
    render(<CrmEventsPage />);
    await screen.findByText("90002");
    const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells[1].textContent).toBe("mystery");
    expect(cells[7].textContent).toBe("skipped");
  });

  it("colours a status by what it means", async () => {
    installFetch({ ...DISTINCT, events: [FULL, { ...FULL, id: 9, crmClientId: "90003", meta: { status: "skipped", detail: null, attempts: 0 } }] });
    render(<CrmEventsPage />);
    await screen.findByText("90001");
    const [first, second] = screen.getAllByRole("row").slice(1);
    expect(within(within(first).getAllByRole("cell")[7]).getByText("sent").className).toMatch(/emerald/);
    expect(within(within(first).getAllByRole("cell")[8]).getByText("retrying").className).toMatch(/red/);
    expect(within(within(second).getAllByRole("cell")[7]).getByText("skipped").className).toMatch(/muted/);
  });

  // The destination objects are typed as always present, but a row from a
  // half-migrated or hand-edited table might lack one. That must cost one cell,
  // not the page: there is no error boundary, so a throw here is a blank app.
  it("still renders a row whose destination object is missing, and shows a dash in its place", async () => {
    const { whatsapp: _gone, ...noWhatsapp } = FULL;
    installFetch({ ...DISTINCT, events: [noWhatsapp, { ...FULL, id: 9, crmClientId: "90003" }] });
    render(<CrmEventsPage />);
    await screen.findByText("90001");
    const [first, second] = screen.getAllByRole("row").slice(1);
    const cells = within(first).getAllByRole("cell");
    expect(cells[2].textContent).toBe("90001");
    expect(cells[7].textContent).toBe("senthttp 200");
    expect(cells[8].textContent).toBe("—");
    expect(cells[9].textContent).toBe("invalidno email address");
    expect(within(second).getAllByRole("cell")[8].textContent).toBe("retryinghttp 503 upstream");
  });

  it("still filters to problems when a row is missing a destination object", async () => {
    // Filtering runs in a useMemo, outside the fetch's try, so it has to cope
    // on its own. The first destination is the one that is missing.
    const { meta: _gone, ...noMeta } = FULL;
    const clean = { ...FULL, id: 10, crmClientId: "90004", whatsapp: FULL.meta, brevo: FULL.meta, openai: FULL.meta };
    const { meta: _gone2, ...cleanNoMeta } = clean;
    installFetch({ ...DISTINCT, events: [noMeta, cleanNoMeta] });
    render(<CrmEventsPage />);
    await screen.findByText("90001");
    fireEvent.click(screen.getByLabelText(/problems only/i));
    // 90001 still has a retrying WhatsApp and an invalid Brevo; 90004 has nothing wrong.
    await waitFor(() => expect(shownIds()).toEqual(["90001"]));
  });
});

// Almost every row this tab shows is scrubbed: the backend nulls the client's
// name, email and phone once Meta, WhatsApp and Brevo have all succeeded or been
// deliberately skipped, which is about a minute after signup. Three blank columns
// on nearly every row is what an operator reads as a broken page, so the page has
// to say what it is. A row whose destination failed or was rejected keeps its
// client data instead, so that the send can be fixed and retried, which is the
// other half the note has to carry.
describe("a scrubbed row", () => {
  const SCRUBBED = {
    id: 11,
    receivedAt: "2026-10-13T20:30:00.000Z",
    scrubbedAt: "2026-10-13T20:31:00.000Z",
    stage: "registered",
    crmClientId: "90010",
    name: "",
    email: "",
    phone: "",
    recordType: "client",
    source: "SVG",
    meta: { status: "skipped", detail: "the website pixel owns this stage", attempts: 0 },
    whatsapp: { status: "sent", detail: "SENT", attempts: 1 },
    brevo: { status: "sent", detail: "http 201", attempts: 1 },
  };

  it("says the client's fields were scrubbed, rather than leaving three cells blank", async () => {
    installFetch({ ...DISTINCT, events: [SCRUBBED] });
    render(<CrmEventsPage />);
    await screen.findByText("90010");
    const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells[3].textContent).toBe("scrubbed");
    expect(cells[4].textContent).toBe("scrubbed");
    expect(cells[5].textContent).toBe("scrubbed");
  });

  it("still shows every statistic the row was kept for", async () => {
    // The whole point of the retention policy: the row goes on answering "did
    // client 90010 get their welcome", and from which form, at which stage.
    installFetch({ ...DISTINCT, events: [SCRUBBED] });
    render(<CrmEventsPage />);
    await screen.findByText("90010");
    const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells[1].textContent).toBe("Registered");
    expect(cells[2].textContent).toBe("90010");
    expect(cells[6].textContent).toBe("SVG");
    expect(cells[8].textContent).toBe("sentSENT");
  });

  it("says a dash, not scrubbed, for a row that simply never carried the value", async () => {
    // A lead with no phone number is a WhatsApp skip, not a scrub. Reporting it
    // as scrubbed would say data had been removed that was never there.
    installFetch({ ...DISTINCT, events: [{ ...SCRUBBED, scrubbedAt: null, name: "Omar Haddad", phone: "" }] });
    render(<CrmEventsPage />);
    await screen.findByText("90010");
    const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells[3].textContent).toBe("Omar Haddad");
    expect(cells[5].textContent).toBe("—");
  });

  it("shows a value it still has, scrubbed_at or not", async () => {
    // The column is read only to explain an EMPTY cell. A row carrying a name
    // shows the name.
    installFetch({ ...DISTINCT, events: [{ ...SCRUBBED, name: "Omar Haddad", email: "o***@mail.test" }] });
    render(<CrmEventsPage />);
    await screen.findByText("90010");
    const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells[3].textContent).toBe("Omar Haddad");
    expect(cells[4].textContent).toBe("o***@mail.test");
    expect(cells[5].textContent).toBe("scrubbed");
  });

  it("explains the retention on the page, so a scrubbed table does not read as a fault", async () => {
    installFetch({ ...DISTINCT, events: [SCRUBBED] });
    render(<CrmEventsPage />);
    await screen.findByText("90010");
    expect(screen.getByText(/Name, email and phone are removed once/i)).toBeInTheDocument();
    expect(screen.getByText(/all succeeded or been skipped/i)).toBeInTheDocument();
    // And the other half of the policy, since 2026-10-14: a row whose destination
    // failed or was rejected still holds its client data, so that the send can be
    // fixed and retried. An operator who reads a failed row's name as a leak has
    // to find the reason it is there on the same line.
    expect(screen.getByText(/failed or rejected destination keeps/i)).toBeInTheDocument();
    // The thirty-day backstop's rows are the other shape of scrubbed row, and the
    // note has to cover them too: they arrive here reading `failed` on
    // destinations nothing ever tried.
    expect(screen.getByText(/never attempted/i)).toBeInTheDocument();
  });

  it("reads as one thing when the thirty-day backstop both scrubbed and settled the row", async () => {
    // What the backend leaves behind for a row that never settled: the client
    // fields gone, and every destination it could no longer send `failed` with a
    // detail saying why. The two have to read as one event rather than as two
    // separate faults -- the status says it is over, the detail says it was never
    // attempted, and the personal columns say where the data went.
    const backstopped = {
      ...SCRUBBED,
      scrubbedAt: "2026-11-12T20:31:00.000Z",
      meta: { status: "failed", detail: "not attempted: the client data this send needed was scrubbed", attempts: 0 },
      whatsapp: {
        status: "failed",
        detail: "not attempted: the client data this send needed was scrubbed",
        attempts: 0,
      },
      brevo: { status: "sent", detail: "http 201", attempts: 1 },
    };
    installFetch({ ...DISTINCT, events: [backstopped] });
    render(<CrmEventsPage />);
    await screen.findByText("90010");
    const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells[3].textContent).toBe("scrubbed");
    expect(cells[4].textContent).toBe("scrubbed");
    expect(cells[5].textContent).toBe("scrubbed");
    // Status and reason together, in the destination's own cell.
    expect(cells[7].textContent).toBe("failednot attempted: the client data this send needed was scrubbed");
    expect(cells[8].textContent).toBe("failednot attempted: the client data this send needed was scrubbed");
    // A destination that did settle keeps its own word for it.
    expect(cells[9].textContent).toBe("senthttp 201");
  });
});

describe("filtering the table", () => {
  const MIXED = [
    event(1, "wa-rejected", "registered", ["sent", "rejected", "sent", "skipped"]),
    event(2, "brevo-invalid", "verified", ["sent", "skipped", "invalid", "sent"]),
    event(3, "meta-retrying", "verified", ["retrying", "skipped", "skipped", "sent"]),
    event(4, "clean", "verified", ["sent", "skipped", "skipped", "sent"]),
    event(5, "meta-failed", "registered", ["failed", "skipped", "skipped", "skipped"]),
    event(6, "pending-only", "verified", ["pending", "pending", "pending", "pending"]),
    event(7, "lead-clean", "lead", ["skipped", "skipped", "skipped", "skipped"]),
    event(8, "live-clean", "live_account", ["sent", "sent", "sent", "sent"]),
    event(9, "deposit-clean", "first_deposit", ["sent", "sent", "sent", "sent"]),
  ];

  it("shows every row to begin with", async () => {
    installFetch({ ...DISTINCT, events: MIXED });
    render(<CrmEventsPage />);
    await screen.findByText("clean");
    expect(shownIds()).toEqual(MIXED.map((e) => e.crmClientId));
  });

  it("counts failed, rejected, invalid and retrying, in any of the four destinations, as problems", async () => {
    installFetch({ ...DISTINCT, events: MIXED });
    render(<CrmEventsPage />);
    await screen.findByText("clean");
    fireEvent.click(screen.getByLabelText(/problems only/i));
    // Not "skipped" (nothing to do), not "pending" (not yet attempted), not "sent".
    await waitFor(() =>
      expect(shownIds()).toEqual(["wa-rejected", "brevo-invalid", "meta-retrying", "meta-failed"]),
    );
  });

  it("brings every row back when problems-only is switched off again", async () => {
    installFetch({ ...DISTINCT, events: MIXED });
    render(<CrmEventsPage />);
    await screen.findByText("clean");
    fireEvent.click(screen.getByLabelText(/problems only/i));
    await waitFor(() => expect(shownIds()).toHaveLength(4));
    fireEvent.click(screen.getByLabelText(/problems only/i));
    await waitFor(() => expect(shownIds()).toHaveLength(MIXED.length));
  });

  it.each([
    ["lead", ["lead-clean"]],
    ["registered", ["wa-rejected", "meta-failed"]],
    ["verified", ["brevo-invalid", "meta-retrying", "clean", "pending-only"]],
    ["live_account", ["live-clean"]],
    ["first_deposit", ["deposit-clean"]],
  ])("shows only the %s rows when that stage is chosen", async (value, expected) => {
    installFetch({ ...DISTINCT, events: MIXED });
    render(<CrmEventsPage />);
    await screen.findByText("clean");
    fireEvent.change(screen.getByLabelText(/stage/i), { target: { value } });
    await waitFor(() => expect(shownIds()).toEqual(expected));
  });

  it("applies the stage and the problems filter together", async () => {
    installFetch({ ...DISTINCT, events: MIXED });
    render(<CrmEventsPage />);
    await screen.findByText("clean");
    fireEvent.change(screen.getByLabelText(/stage/i), { target: { value: "verified" } });
    fireEvent.click(screen.getByLabelText(/problems only/i));
    await waitFor(() => expect(shownIds()).toEqual(["brevo-invalid", "meta-retrying"]));
  });

  it("offers every stage by name and an all-stages choice", async () => {
    installFetch({ ...DISTINCT, events: MIXED });
    render(<CrmEventsPage />);
    await screen.findByText("clean");
    const options = within(screen.getByLabelText(/stage/i)).getAllByRole("option");
    expect(options.map((o) => [o.getAttribute("value"), o.textContent])).toEqual([
      ["all", "All stages"],
      ["lead", "Lead"],
      ["registered", "Registered"],
      ["verified", "Verified"],
      ["live_account", "Live account"],
      ["first_deposit", "First deposit"],
    ]);
  });

  it("says the filters excluded everything, not that the period was empty, when events exist", async () => {
    installFetch({ ...DISTINCT, events: [event(1, "only-one", "registered", ["sent", "sent", "sent", "skipped"])] });
    render(<CrmEventsPage />);
    await screen.findByText("only-one");
    fireEvent.click(screen.getByLabelText(/problems only/i));
    expect(await screen.findByText("No events match these filters.")).toBeTruthy();
    expect(screen.queryByText(/no events in this period/i)).toBeNull();
  });

  it("says the period was empty only when it was", async () => {
    installFetch({ ...DISTINCT, events: [] });
    render(<CrmEventsPage />);
    expect(await screen.findByText("No events in this period.")).toBeTruthy();
    expect(screen.queryByText(/match these filters/i)).toBeNull();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });
});

describe("loading, failing and recovering", () => {
  it("says it is loading until the first answer, and not after it", async () => {
    const { answer } = deferredFetch();
    render(<CrmEventsPage />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByTestId("funnel-lead")).toBeNull();

    answer(30, json(DISTINCT));
    await screen.findByTestId("funnel-lead");
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("says it is loading again when a request is retried after a failure", async () => {
    // The first answer is an error, so there is nothing on the page but the
    // alert; the second is still in flight and the page must not look finished.
    const second = deferredFetch();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("days=30") ? json({ error: "x" }, 500) : second.fn(input, init),
    ) as unknown as typeof fetch;
    render(<CrmEventsPage />);
    await screen.findByText("Could not load CRM events.");
    expect(screen.queryByText("Loading…")).toBeNull();

    fireEvent.change(screen.getByLabelText(/period/i), { target: { value: "7" } });

    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("Could not load CRM events.")).toBeNull();
  });

  it("keeps the numbers it has on screen while the next period loads, rather than blanking the page", async () => {
    const d = deferredFetch();
    render(<CrmEventsPage />);
    await waitFor(() => expect(d.fn).toHaveBeenCalledTimes(1));
    d.answer(30, json(DISTINCT));
    await screen.findByTestId("funnel-lead");

    fireEvent.change(screen.getByLabelText(/period/i), { target: { value: "7" } });
    await waitFor(() => expect(d.fn).toHaveBeenCalledTimes(2));

    expect(screen.getByTestId("funnel-registered").textContent).toBe("22Registered");
    // "Loading…" is for a page with nothing on it yet, not for a refresh.
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("does not say it is loading once the request has failed", async () => {
    installFetch({ error: "overview_failed" }, 500);
    render(<CrmEventsPage />);
    await screen.findByRole("alert");
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("treats any non-2xx answer as a failure, whatever the body looks like", async () => {
    installFetch(DISTINCT, 503);
    render(<CrmEventsPage />);
    expect((await screen.findByRole("alert")).textContent).toBe("Could not load CRM events.");
    expect(screen.queryByTestId("funnel-lead")).toBeNull();
  });

  it("treats a request that never reaches the server as a failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    render(<CrmEventsPage />);
    expect((await screen.findByRole("alert")).textContent).toBe("Could not load CRM events.");
  });

  it("does not repeat the server's own message, which can name internal schema", async () => {
    installFetch({ error: "overview_failed", message: "Unknown column 'meta_status' in 'field list'" }, 500);
    render(<CrmEventsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not load CRM events.");
    expect(document.body.textContent).not.toMatch(/meta_status|overview_failed/);
  });

  it("clears the error when the next request succeeds", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => (++calls === 1 ? json({ error: "x" }, 500) : json(DISTINCT))) as unknown as typeof fetch;
    render(<CrmEventsPage />);
    await screen.findByRole("alert");

    fireEvent.change(screen.getByLabelText(/period/i), { target: { value: "7" } });

    await screen.findByTestId("funnel-lead");
    expect(screen.queryByText("Could not load CRM events.")).toBeNull();
  });

  it("drops the numbers it was showing when the next request fails, rather than leaving them under the wrong period", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => (++calls === 1 ? json(DISTINCT) : json({ error: "x" }, 500))) as unknown as typeof fetch;
    render(<CrmEventsPage />);
    await screen.findByTestId("funnel-lead");

    fireEvent.change(screen.getByLabelText(/period/i), { target: { value: "7" } });

    expect(await screen.findByText("Could not load CRM events.")).toBeTruthy();
    expect(screen.queryByTestId("funnel-lead")).toBeNull();
  });
});

describe("a response that is not an overview", () => {
  const html = () =>
    new Response("<!doctype html><html><body>app shell</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });

  it.each([
    ["an empty object", () => json({})],
    ["null", () => json(null)],
    ["a list", () => json([])],
    ["no health", () => json({ ...DISTINCT, health: undefined })],
    ["a health that is a string", () => json({ ...DISTINCT, health: "fine" })],
    ["a health that is a list", () => json({ ...DISTINCT, health: [] })],
    ["no funnel", () => json({ ...DISTINCT, funnel: undefined })],
    ["no destinations", () => json({ ...DISTINCT, destinations: undefined })],
    ["no events", () => json({ ...DISTINCT, events: undefined })],
    ["events that are not a list", () => json({ ...DISTINCT, events: {} })],
    ["an HTML page answered with 200, as a single-page app does for an unknown route", html],
  ])("reports %s as a failed load, not as a calm page", async (_name, answer) => {
    globalThis.fetch = vi.fn(async () => answer()) as unknown as typeof fetch;
    render(<CrmEventsPage />);
    expect((await screen.findByRole("alert")).textContent).toBe("Could not load CRM events.");
    expect(screen.queryByTestId("funnel-lead")).toBeNull();
    expect(screen.queryByTestId("stage-health-lead")).toBeNull();
  });
});

describe("two requests in flight", () => {
  const FOR_7 = { ...DISTINCT, funnel: { lead: 71, registered: 72, verified: 73, live_account: 74, first_deposit: 75 } };

  async function changeToSevenDays(d: ReturnType<typeof deferredFetch>) {
    render(<CrmEventsPage />);
    await waitFor(() => expect(d.fn).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText(/period/i), { target: { value: "7" } });
    await waitFor(() => expect(d.fn).toHaveBeenCalledTimes(2));
  }

  it("keeps the newer period's numbers when the older request lands last", async () => {
    const d = deferredFetch();
    await changeToSevenDays(d);

    d.answer(7, json(FOR_7));
    await screen.findByTestId("funnel-lead");
    expect(screen.getByTestId("funnel-registered").textContent).toBe("72Registered");

    d.answer(30, json(DISTINCT));
    await settle();
    expect(screen.getByTestId("funnel-registered").textContent).toBe("72Registered");
  });

  it("does not let the older request's failure replace the newer one's numbers with an error", async () => {
    const d = deferredFetch();
    await changeToSevenDays(d);

    d.answer(7, json(FOR_7));
    await screen.findByTestId("funnel-lead");

    d.fail(30);
    await settle();
    expect(screen.queryByText("Could not load CRM events.")).toBeNull();
    expect(screen.getByTestId("funnel-registered").textContent).toBe("72Registered");
  });

  it("keeps saying it is loading while only the older request has answered", async () => {
    const d = deferredFetch();
    await changeToSevenDays(d);

    d.answer(30, json(DISTINCT));
    await settle();
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByTestId("funnel-lead")).toBeNull();

    d.answer(7, json(FOR_7));
    await screen.findByTestId("funnel-lead");
    expect(screen.getByTestId("funnel-registered").textContent).toBe("72Registered");
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The resend controls. The page's one write, and the only thing on it that ends
// in messages going out to clients -- so most of what is pinned here is what it
// does NOT do: no request from the WhatsApp control's first press, no request
// from a disabled control, and no resend of a destination the operator did not
// name.
// ---------------------------------------------------------------------------

const REQUEUE_URL = "/api/crm-events/requeue";

/** An overview with something resendable. Every number different, so a count
 *  read from the wrong destination cannot hide behind an equal neighbour. */
const RESENDABLE = {
  ...DISTINCT,
  requeue: {
    meta: { resendable: 2, scrubbed: 9, expired: 0 },
    whatsapp: { resendable: 4, scrubbed: 11, expired: 0 },
    brevo: { resendable: 10, scrubbed: 28, expired: 0 },
    // 3 + 7 + 19 = 29 ChatGPT Ads failures, of which only 3 can be sent again:
    // 7 were scrubbed by the thirty-day backstop and 19 are outside OpenAI's
    // 7-day window. `expired` is the only one of the three numbers that is not
    // zero for every other destination.
    openai: { resendable: 3, scrubbed: 7, expired: 19 },
  },
  events: [event(1, "row-a", "registered", ["failed", "rejected", "failed", "failed"])],
};

/** A fetch that answers the overview with `overview` and every requeue POST
 *  with the next answer in `answers`, round-robin on the last one. */
function installResendFetch(overview: unknown = RESENDABLE, answers: unknown[] = [{ requeued: 10, alreadyScrubbed: 28, expired: 0 }]) {
  let i = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === REQUEUE_URL) {
      const answer = answers[Math.min(i, answers.length - 1)];
      i += 1;
      if (answer instanceof Error) throw answer;
      if (typeof answer === "number") return json({ error: "requeue_failed" }, answer);
      return json({ destination: JSON.parse(String(init?.body ?? "{}")).destination, ...(answer as object) });
    }
    return json(overview);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** The destinations the page asked to requeue, in order. */
const requeued = (fn: ReturnType<typeof installResendFetch>) =>
  fn.mock.calls
    .filter(([url]) => String(url) === REQUEUE_URL)
    .map(([, init]) => JSON.parse(String((init as RequestInit)?.body ?? "{}")).destination);

describe("the resend controls", () => {
  it("offers Meta, Brevo and ChatGPT Ads together, with the count it is about to resend", async () => {
    // One control for the three, because all three are safe to repeat: Meta
    // deduplicates on the event id, the Brevo call is an upsert, and OpenAI
    // deduplicates on the event id we reuse on every retry. 2 + 10 + 3.
    installResendFetch();
    render(<CrmEventsPage />);
    const button = await screen.findByTestId("resend-safe");
    expect(button).toHaveTextContent("Resend 15 failed Meta, Brevo and ChatGPT Ads sends");
    expect(button).toBeEnabled();
  });

  it("requeues Meta, Brevo and ChatGPT Ads, one request each, and nothing else", async () => {
    // One request per destination, because the statement behind the endpoint
    // writes one destination's columns -- which is the point: fixing
    // BREVO_LIST_ID must not re-send anybody's WhatsApp welcome.
    const fn = installResendFetch();
    render(<CrmEventsPage />);
    fireEvent.click(await screen.findByTestId("resend-safe"));
    await waitFor(() => expect(requeued(fn)).toEqual(["meta", "brevo", "openai"]));
    expect(requeued(fn)).not.toContain("whatsapp");
    const [, init] = fn.mock.calls.find(([url]) => String(url) === REQUEUE_URL)!;
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test.session.jwt",
      "Content-Type": "application/json",
    });
  });

  it("says what happened, including the rows that can never be resent", async () => {
    // The operator can see 28 + 10 failures on the Brevo card -- those counters
    // count scrubbed rows -- and gets 10 resends. Saying so is what stops the
    // shortfall being a guess.
    installResendFetch(RESENDABLE, [
      { requeued: 2, alreadyScrubbed: 9, expired: 0 },
      { requeued: 10, alreadyScrubbed: 28, expired: 0 },
      { requeued: 3, alreadyScrubbed: 7, expired: 19 },
    ]);
    render(<CrmEventsPage />);
    fireEvent.click(await screen.findByTestId("resend-safe"));
    const note = await screen.findByTestId("resend-note");
    expect(note).toHaveTextContent("15 sends queued");
    expect(note).toHaveTextContent(/44 earlier failures had already been scrubbed/);
    // The other reason the three answers add up to fewer rows than the cards
    // showed, and the one nothing else on the page can say after the reload has
    // replaced the counts the button was pressed against.
    expect(note).toHaveTextContent("19 ChatGPT Ads failures are older than OpenAI's 7-day window");
  });

  it("says so rather than going quiet when there is nothing to resend", async () => {
    // A control that promises nothing must say so. Mysteriously inert is the one
    // thing it may not be.
    installResendFetch({
      ...DISTINCT,
      requeue: {
        meta: { resendable: 0, scrubbed: 4, expired: 0 },
        whatsapp: { resendable: 0, scrubbed: 0, expired: 0 },
        brevo: { resendable: 0, scrubbed: 0, expired: 0 },
        openai: { resendable: 0, scrubbed: 0, expired: 0 },
      },
    });
    render(<CrmEventsPage />);
    const safe = await screen.findByTestId("resend-safe");
    expect(safe).toHaveTextContent("Nothing to resend");
    expect(safe).toBeDisabled();
    expect(screen.getByTestId("resend-whatsapp")).toHaveTextContent("Nothing to resend");
    expect(screen.getByTestId("resend-whatsapp")).toBeDisabled();
  });

  it("reads zero from a response that carries no resendable counts at all", async () => {
    // A server that predates the resend still has to render a page.
    installResendFetch(DISTINCT);
    render(<CrmEventsPage />);
    expect(await screen.findByTestId("resend-safe")).toBeDisabled();
    expect(screen.getByTestId("resend-whatsapp")).toBeDisabled();
  });

  it("disables a disabled control's request, not merely its appearance", async () => {
    const fn = installResendFetch(DISTINCT);
    render(<CrmEventsPage />);
    fireEvent.click(await screen.findByTestId("resend-safe"));
    fireEvent.click(screen.getByTestId("resend-whatsapp"));
    await settle();
    expect(requeued(fn)).toEqual([]);
  });

  it("disables both while either is in flight, and reports before enabling them again", async () => {
    let release: (r: Response) => void = () => {};
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === REQUEUE_URL) return new Promise<Response>((r) => { release = r; });
      return json(RESENDABLE);
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    render(<CrmEventsPage />);
    fireEvent.click(await screen.findByTestId("resend-safe"));

    await waitFor(() => expect(screen.getByTestId("resend-safe")).toHaveTextContent("Resending…"));
    expect(screen.getByTestId("resend-safe")).toBeDisabled();
    expect(screen.getByTestId("resend-whatsapp")).toBeDisabled();

    release(json({ requeued: 12, alreadyScrubbed: 0, expired: 0 }));
    await settle();
    release(json({ requeued: 0, alreadyScrubbed: 0, expired: 0 }));
    await settle();
    release(json({ requeued: 0, alreadyScrubbed: 0, expired: 0 }));
    await settle();
    expect(screen.getByTestId("resend-note")).toHaveTextContent("12 sends queued");
  });

  it("reloads the page's data afterwards, so the counts are the ones after the action", async () => {
    const fn = installResendFetch();
    render(<CrmEventsPage />);
    await screen.findByTestId("resend-safe");
    expect(fn.mock.calls.filter(([url]) => String(url) !== REQUEUE_URL)).toHaveLength(1);

    fireEvent.click(screen.getByTestId("resend-safe"));

    await waitFor(() =>
      expect(fn.mock.calls.filter(([url]) => String(url) !== REQUEUE_URL)).toHaveLength(2),
    );
  });

  it("reports a failed resend without repeating the server's message", async () => {
    installResendFetch(RESENDABLE, [500]);
    render(<CrmEventsPage />);
    fireEvent.click(await screen.findByTestId("resend-safe"));
    const note = await screen.findByTestId("resend-note");
    expect(note).toHaveTextContent(/could not resend/i);
    expect(note).not.toHaveTextContent(/requeue_failed/);
  });

  it("does not claim nothing was queued when the first of the two succeeded", async () => {
    // Meta's rows ARE pending now. "Nothing was queued" would have the operator
    // press it again, and the sends are already on their way.
    installResendFetch(RESENDABLE, [{ requeued: 2, alreadyScrubbed: 0, expired: 0 }, 500]);
    render(<CrmEventsPage />);
    fireEvent.click(await screen.findByTestId("resend-safe"));
    const note = await screen.findByTestId("resend-note");
    expect(note).toHaveTextContent(/could not finish/i);
    expect(note).toHaveTextContent("2 sends had been queued");
  });
});

describe("the WhatsApp control is a separate, warned, confirmed action", () => {
  it("warns about the duplicate welcome in visible text, not in a tooltip", async () => {
    // The whole reason WhatsApp is not on the control beside it. A `failed` row
    // may already have reached the handset -- CUTOVER step 7's case, where
    // DoubleTick answers 2xx with a status outside our allowlist -- and nothing
    // deduplicates this message.
    installResendFetch();
    render(<CrmEventsPage />);
    await screen.findByTestId("resend-whatsapp");
    const warning = screen.getByText(/may send a second welcome message/i);
    expect(warning).toBeVisible();
    expect(warning.getAttribute("title")).toBeNull();
    expect(warning).toHaveTextContent(/already have reached the handset/i);
  });

  it("is its own control, with its own count", async () => {
    installResendFetch();
    render(<CrmEventsPage />);
    expect(await screen.findByTestId("resend-whatsapp")).toHaveTextContent("Resend 4 failed WhatsApp welcomes");
  });

  it("sends nothing on the first press: it asks first", async () => {
    // The confirmation is the point of this control. One press is not consent to
    // message four people a second time.
    const fn = installResendFetch();
    render(<CrmEventsPage />);
    fireEvent.click(await screen.findByTestId("resend-whatsapp"));
    await settle();
    expect(requeued(fn)).toEqual([]);
    expect(screen.getByTestId("resend-whatsapp-confirm")).toHaveTextContent(
      "Yes, resend 4 welcome messages — some may arrive twice",
    );
  });

  it("requeues WhatsApp, and only WhatsApp, once it is confirmed", async () => {
    const fn = installResendFetch(RESENDABLE, [{ requeued: 4, alreadyScrubbed: 11, expired: 0 }]);
    render(<CrmEventsPage />);
    fireEvent.click(await screen.findByTestId("resend-whatsapp"));
    fireEvent.click(screen.getByTestId("resend-whatsapp-confirm"));
    await waitFor(() => expect(requeued(fn)).toEqual(["whatsapp"]));
    expect(await screen.findByTestId("resend-note")).toHaveTextContent("4 sends queued");
  });

  it("sends nothing when the confirmation is cancelled, and offers itself again", async () => {
    const fn = installResendFetch();
    render(<CrmEventsPage />);
    fireEvent.click(await screen.findByTestId("resend-whatsapp"));
    fireEvent.click(screen.getByTestId("resend-whatsapp-cancel"));
    await settle();
    expect(requeued(fn)).toEqual([]);
    expect(screen.getByTestId("resend-whatsapp")).toHaveTextContent("Resend 4 failed WhatsApp welcomes");
  });

  it("asks again the next time, rather than staying confirmed", async () => {
    // A confirmation that sticks is not a confirmation.
    const fn = installResendFetch(RESENDABLE, [{ requeued: 4, alreadyScrubbed: 0, expired: 0 }]);
    render(<CrmEventsPage />);
    fireEvent.click(await screen.findByTestId("resend-whatsapp"));
    fireEvent.click(screen.getByTestId("resend-whatsapp-confirm"));
    await waitFor(() => expect(requeued(fn)).toEqual(["whatsapp"]));

    await waitFor(() => expect(screen.queryByTestId("resend-whatsapp-confirm")).toBeNull());
    expect(screen.getByTestId("resend-whatsapp")).toBeTruthy();
  });

  it("is never resent by the control beside it", async () => {
    // The two destinations that are safe to repeat, and not the one that is not.
    const fn = installResendFetch();
    render(<CrmEventsPage />);
    fireEvent.click(await screen.findByTestId("resend-safe"));
    await waitFor(() => expect(requeued(fn)).toHaveLength(3));
    expect(requeued(fn)).toEqual(["meta", "brevo", "openai"]);
  });
});

// ---------------------------------------------------------------------------
// The fourth destination. Everything it shares with the other three is pinned
// above, beside theirs; what is here is only what is true of ChatGPT Ads alone:
// it is safe to repeat although it is the newest, its shortfall has a second
// cause nothing else on this page has, and it is the first destination whose
// skip depends on the clock.
// ---------------------------------------------------------------------------

describe("ChatGPT Ads", () => {
  it("is resent by the safe control, not from behind the WhatsApp warning", async () => {
    // OpenAI deduplicates on the event `id`, and this service derives that id
    // from `<crm_client_id>:<stage>` and so reuses it unchanged on every retry
    // and every resend -- the same property Meta has. A repeat reaches nobody
    // twice, so there is nothing to warn about and nothing to confirm.
    const fn = installResendFetch();
    render(<CrmEventsPage />);
    fireEvent.click(await screen.findByTestId("resend-safe"));
    await waitFor(() => expect(requeued(fn)).toContain("openai"));
    expect(requeued(fn)).toEqual(["meta", "brevo", "openai"]);
    // And not the other way round: it must not be reachable from the control
    // whose press means "some of these may arrive twice".
    expect(screen.queryByTestId("resend-whatsapp-confirm")).toBeNull();
  });

  it("is not resent by the WhatsApp control, even once that one is confirmed", async () => {
    const fn = installResendFetch(RESENDABLE, [{ requeued: 4, alreadyScrubbed: 11, expired: 0 }]);
    render(<CrmEventsPage />);
    fireEvent.click(await screen.findByTestId("resend-whatsapp"));
    fireEvent.click(screen.getByTestId("resend-whatsapp-confirm"));
    await waitFor(() => expect(requeued(fn)).toEqual(["whatsapp"]));
    expect(requeued(fn)).not.toContain("openai");
  });

  it("accounts for the rows OpenAI itself will not take, so the card reconciles", async () => {
    // 3 + 7 + 19 = 29 failures, 3 resendable. Without this line the operator
    // sees 29 on the card, gets 3, and the 19 are unexplained -- which reads as
    // something broken here rather than as OpenAI's own rule.
    installResendFetch();
    render(<CrmEventsPage />);
    const note = await screen.findByTestId("resend-expired");
    expect(note).toHaveTextContent("19 ChatGPT Ads failures are older than 7 days");
    expect(note).toHaveTextContent(/OpenAI accepts no conversion more than 7 days old/);
    expect(note).toHaveTextContent(/no resend can reach them/);
  });

  it("reads the expired rows as a fact rather than as a fault", async () => {
    // The whole point of where this line sits and what colour it is. "19
    // expired" has to finish the sentence "because OpenAI will not take them",
    // so it names whose rule it is and it is NOT in the amber the WhatsApp
    // warning uses -- the two must not look like the same kind of thing.
    installResendFetch();
    render(<CrmEventsPage />);
    const note = await screen.findByTestId("resend-expired");
    expect(note).toHaveTextContent(/That is OpenAI’s rule, not a fault here\./);
    expect(note.className).toMatch(/muted/);
    expect(note.className).not.toMatch(/amber|red|rose/);
  });

  it("says nothing about expired rows when there are none", async () => {
    // Which is the ordinary state: an event is sent about a minute after
    // signup, so a row only expires after an outage lasting a week. A permanent
    // "0 expired" line is a line people stop reading.
    installResendFetch({
      ...RESENDABLE,
      requeue: { ...RESENDABLE.requeue, openai: { resendable: 3, scrubbed: 7, expired: 0 } },
    });
    render(<CrmEventsPage />);
    await screen.findByTestId("resend-safe");
    expect(screen.queryByTestId("resend-expired")).toBeNull();
  });

  it("reads no expired rows from a response that carries none, rather than printing undefined", async () => {
    installResendFetch(DISTINCT);
    render(<CrmEventsPage />);
    await screen.findByTestId("resend-safe");
    expect(screen.queryByTestId("resend-expired")).toBeNull();
  });

  it("explains that a skip here can mean the clock, not only the stage", async () => {
    // The first destination whose skip depends on when the row arrived. After
    // an outage `skipped` rises for rows OpenAI would now refuse on their age,
    // and it is the same counter that holds every registration the website
    // pixel owns. One counter, because the backend has one vocabulary of seven
    // statuses -- so the page says what the two meanings are and where to tell
    // them apart.
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByTestId("dest-openai");
    const note = screen.getByText(/only destination whose/i);
    expect(note).toHaveTextContent(/pixel owns that conversion/);
    expect(note).toHaveTextContent(/no conversion more than 7 days old/);
    expect(note).toHaveTextContent(/skipped for its age/);
    expect(note).toHaveTextContent(/detail in the table below/);
  });

  it("counts a problem in the fourth destination as a problem, like the other three", async () => {
    // The filter is a separate list from the cards and the columns, and a row
    // whose ONLY failure is here is exactly the row an operator filters for.
    installFetch({
      ...DISTINCT,
      events: [
        event(1, "openai-only", "verified", ["sent", "skipped", "skipped", "rejected"]),
        event(2, "all-clean", "verified", ["sent", "skipped", "skipped", "sent"]),
      ],
    });
    render(<CrmEventsPage />);
    await screen.findByText("all-clean");
    fireEvent.click(screen.getByLabelText(/problems only/i));
    await waitFor(() => expect(shownIds()).toEqual(["openai-only"]));
  });
});

describe("the controls", () => {
  it("show what they are set to, rather than snapping back after a change", async () => {
    installFetch({ ...DISTINCT, events: [event(1, "row-a", "registered", ["sent", "sent", "sent", "sent"])] });
    render(<CrmEventsPage />);
    await screen.findByText("row-a");
    const period = screen.getByLabelText(/period/i) as HTMLSelectElement;
    const stage = screen.getByLabelText(/stage/i) as HTMLSelectElement;
    const problems = screen.getByLabelText(/problems only/i) as HTMLInputElement;
    expect([period.value, stage.value, problems.checked]).toEqual(["30", "all", false]);

    fireEvent.change(period, { target: { value: "90" } });
    fireEvent.change(stage, { target: { value: "verified" } });
    fireEvent.click(problems);

    await waitFor(() => expect([period.value, stage.value, problems.checked]).toEqual(["90", "verified", true]));
  });
});
