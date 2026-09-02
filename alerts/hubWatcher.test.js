// @vitest-environment node
//
// The watcher's connection went dead the day the backend started requiring
// authentication on /ws/dashboard/negotiate, and the way it went dead was
// quiet: one "Data backend unreachable" email at 01:14, then a 15-second retry
// loop that could never succeed and never said so again. Three separate
// defects, all covered here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alertForKind,
  buildHubUrlOptions,
  createBackendConnectionMonitor,
  createHubAccessTokenFactory,
  renotifyIntervalMs,
  DEFAULT_RENOTIFY_MS,
} from "./hubWatcher.js";

// A SignalR HttpError as negotiate produces it: the status lives on
// `statusCode`, and the message quotes it too.
function httpError(status, statusText) {
  const error = new Error(`${statusText}: Status code '${status}'`);
  error.name = "HttpError";
  error.statusCode = status;
  return error;
}

describe("hub access token factory", () => {
  const originalSignalrToken = process.env.SIGNALR_TOKEN;

  beforeEach(() => {
    delete process.env.SIGNALR_TOKEN;
  });

  afterEach(() => {
    if (originalSignalrToken === undefined) delete process.env.SIGNALR_TOKEN;
    else process.env.SIGNALR_TOKEN = originalSignalrToken;
  });

  it("returns the token minted by getBackendToken()", async () => {
    const getToken = vi.fn().mockResolvedValue("minted-token-1");
    const factory = createHubAccessTokenFactory({ getToken });
    await expect(factory()).resolves.toBe("minted-token-1");
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("asks again on every invocation instead of reusing a captured token", async () => {
    // SignalR calls the factory afresh on each negotiate and each automatic
    // reconnect, and this process outlives a one-hour token by days. A factory
    // that closed over its first answer would work until the first reconnect
    // after expiry and then fail forever.
    const getToken = vi.fn().mockResolvedValueOnce("minted-token-1").mockResolvedValueOnce("minted-token-2");
    const factory = createHubAccessTokenFactory({ getToken });
    await expect(factory()).resolves.toBe("minted-token-1");
    await expect(factory()).resolves.toBe("minted-token-2");
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("lets an explicitly set SIGNALR_TOKEN override the exchange", async () => {
    process.env.SIGNALR_TOKEN = "legacy-static-token";
    const getToken = vi.fn().mockResolvedValue("minted-token-1");
    const factory = createHubAccessTokenFactory({ getToken });
    await expect(factory()).resolves.toBe("legacy-static-token");
    expect(getToken, "the override must short-circuit the token exchange").not.toHaveBeenCalled();
  });

  it("falls through to the exchange when SIGNALR_TOKEN is blank, not to no auth", async () => {
    process.env.SIGNALR_TOKEN = "   ";
    const getToken = vi.fn().mockResolvedValue("minted-token-1");
    await expect(createHubAccessTokenFactory({ getToken })()).resolves.toBe("minted-token-1");
  });

  // THE REGRESSION. The old code was:
  //   .withUrl(url, token ? { accessTokenFactory: () => token } : {})
  // with `token` read from an env var set in no environment. The `{}` branch
  // built a connection that negotiates anonymously, which the backend now
  // answers with 401. There is no configuration in which `{}` is correct.
  it("always configures an accessTokenFactory, even with SIGNALR_TOKEN unset", async () => {
    delete process.env.SIGNALR_TOKEN;
    const getToken = vi.fn().mockResolvedValue("minted-token-1");
    const options = buildHubUrlOptions({ getToken });
    expect(
      typeof options.accessTokenFactory,
      "withUrl() was given options with no accessTokenFactory: that connection negotiates " +
        "anonymously and the backend answers 401",
    ).toBe("function");
    await expect(options.accessTokenFactory()).resolves.toBe("minted-token-1");
  });
});

describe("renotifyIntervalMs", () => {
  it("defaults to six hours", () => {
    expect(renotifyIntervalMs({})).toBe(DEFAULT_RENOTIFY_MS);
    expect(DEFAULT_RENOTIFY_MS).toBe(6 * 60 * 60 * 1000);
  });
  it("takes an explicit value, including 0 to disable", () => {
    expect(renotifyIntervalMs({ BACKEND_DOWN_RENOTIFY_MS: "60000" })).toBe(60000);
    expect(renotifyIntervalMs({ BACKEND_DOWN_RENOTIFY_MS: "0" })).toBe(0);
  });
  it("ignores a non-numeric value rather than disabling itself", () => {
    expect(renotifyIntervalMs({ BACKEND_DOWN_RENOTIFY_MS: "soon" })).toBe(DEFAULT_RENOTIFY_MS);
  });
});

// Drives the monitor and records the ACTUAL email each notification produces,
// so these assert on what an operator receives, not on an internal label.
function monitorHarness({ renotifyMs = DEFAULT_RENOTIFY_MS, startAt = 1_000_000 } = {}) {
  const sent = [];
  let clock = startAt;
  const monitor = createBackendConnectionMonitor({
    renotifyMs,
    now: () => clock,
    notify: ({ kind, repeat }) => sent.push(alertForKind(kind, { repeat })),
  });
  return { monitor, sent, advance: (ms) => (clock += ms) };
}

describe("which failure the alert describes", () => {
  it("reports a 401 on negotiate as a credentials failure, not an unreachable backend", () => {
    const { monitor, sent } = monitorHarness();
    monitor.handleEvent("closed", httpError(401, "Unauthorized"));
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/credential/i);
    expect(
      sent[0].subject,
      "a backend that answered 401 is reachable; calling it unreachable sends the operator " +
        "to look at a healthy backend",
    ).not.toMatch(/unreachable/i);
    expect(sent[0].html).toMatch(/BACKEND_API_KEY/);
  });

  it("reports a 403 the same way", () => {
    const { monitor, sent } = monitorHarness();
    monitor.handleEvent("closed", httpError(403, "Forbidden"));
    expect(sent[0].subject).toMatch(/credential/i);
  });

  it("reports a timeout as an unreachable backend", () => {
    const { monitor, sent } = monitorHarness();
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    monitor.handleEvent("closed", timeout);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/unreachable/i);
    expect(sent[0].subject).not.toMatch(/credential/i);
  });

  it("reports a refused connection and a 502 as unreachable", () => {
    const { monitor: m1, sent: s1 } = monitorHarness();
    m1.handleEvent("closed", Object.assign(new Error("connect ECONNREFUSED 10.0.0.4:443"), { name: "Error" }));
    expect(s1[0].subject).toMatch(/unreachable/i);

    const { monitor: m2, sent: s2 } = monitorHarness();
    m2.handleEvent("closed", httpError(502, "Bad Gateway"));
    expect(s2[0].subject).toMatch(/unreachable/i);
  });

  it("gives the two failures different wording", () => {
    expect(alertForKind("auth").subject).not.toBe(alertForKind("unreachable").subject);
    expect(alertForKind("auth").telegram).not.toBe(alertForKind("unreachable").telegram);
  });

  it("never puts a credential value in an alert", () => {
    for (const kind of ["auth", "unreachable", "recovered"]) {
      const { subject, html } = alertForKind(kind);
      expect(`${subject} ${html}`).not.toMatch(/slc_live_/);
    }
  });
});

describe("recovery", () => {
  it("sends exactly one recovery alert when the connection comes back", () => {
    const { monitor, sent } = monitorHarness();
    monitor.handleEvent("closed", httpError(401, "Unauthorized"));
    expect(sent).toHaveLength(1);

    monitor.handleEvent("connected");
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toMatch(/recovered/i);
    expect(monitor.state).toBe("up");
  });

  it("sends nothing on a second connected event", () => {
    const { monitor, sent } = monitorHarness();
    monitor.handleEvent("closed", httpError(401, "Unauthorized"));
    monitor.handleEvent("connected");
    monitor.handleEvent("connected");
    expect(sent, "recovery is edge-triggered: a still-connected hub is not news").toHaveLength(2);
  });

  it("keeps recovery single whichever failure preceded it", () => {
    const { monitor, sent } = monitorHarness();
    monitor.handleEvent("closed", new Error("socket hang up"));
    monitor.handleEvent("connected");
    expect(sent.filter((a) => /recovered/i.test(a.subject))).toHaveLength(1);
  });
});

describe("still-down re-notification", () => {
  const SIX_HOURS = DEFAULT_RENOTIFY_MS;

  it("does not re-notify before the interval has elapsed", () => {
    const { monitor, sent, advance } = monitorHarness({ renotifyMs: SIX_HOURS });
    monitor.handleEvent("closed", httpError(401, "Unauthorized"));
    expect(sent).toHaveLength(1);

    // What the real loop does: a failed attempt every 15 seconds. Six hours of
    // them, one short of the interval.
    for (let elapsed = 0; elapsed < SIX_HOURS - 15000; elapsed += 15000) {
      advance(15000);
      monitor.handleRetryFailure(httpError(401, "Unauthorized"));
    }
    expect(
      sent,
      "the retry loop became an email loop: every failed 15-second attempt sent an alert",
    ).toHaveLength(1);
  });

  it("re-notifies once the interval has elapsed", () => {
    const { monitor, sent, advance } = monitorHarness({ renotifyMs: SIX_HOURS });
    monitor.handleEvent("closed", httpError(401, "Unauthorized"));
    advance(SIX_HOURS);
    monitor.handleRetryFailure(httpError(401, "Unauthorized"));
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toMatch(/still/i);
    expect(sent[1].subject).toMatch(/credential/i);
  });

  it("waits another full interval before the next reminder", () => {
    const { monitor, sent, advance } = monitorHarness({ renotifyMs: SIX_HOURS });
    monitor.handleEvent("closed", httpError(401, "Unauthorized"));
    advance(SIX_HOURS);
    monitor.handleRetryFailure(httpError(401, "Unauthorized"));
    advance(SIX_HOURS - 1000);
    monitor.handleRetryFailure(httpError(401, "Unauthorized"));
    expect(sent).toHaveLength(2);
    advance(1000);
    monitor.handleRetryFailure(httpError(401, "Unauthorized"));
    expect(sent).toHaveLength(3);
  });

  it("re-describes the outage if the failure has changed", () => {
    const { monitor, sent, advance } = monitorHarness({ renotifyMs: SIX_HOURS });
    monitor.handleEvent("closed", new Error("connect ETIMEDOUT"));
    expect(sent[0].subject).toMatch(/unreachable/i);
    advance(SIX_HOURS);
    monitor.handleRetryFailure(httpError(401, "Unauthorized"));
    expect(sent[1].subject).toMatch(/credential/i);
  });

  it("says nothing on a retry failure when we are not down", () => {
    const { monitor, sent, advance } = monitorHarness({ renotifyMs: SIX_HOURS });
    advance(SIX_HOURS * 10);
    expect(monitor.handleRetryFailure(httpError(401, "Unauthorized"))).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("restarts the clock after a recovery, so a later outage does not fire instantly", () => {
    const { monitor, sent, advance } = monitorHarness({ renotifyMs: SIX_HOURS });
    monitor.handleEvent("closed", httpError(401, "Unauthorized"));
    advance(SIX_HOURS * 2);
    monitor.handleEvent("connected"); // clears the down clock
    monitor.handleEvent("closed", httpError(401, "Unauthorized"));
    advance(60000);
    monitor.handleRetryFailure(httpError(401, "Unauthorized"));
    expect(sent.map((a) => a.subject)).toHaveLength(3); // down, recovered, down — no reminder
  });

  it("can be turned off with an interval of 0", () => {
    const { monitor, sent, advance } = monitorHarness({ renotifyMs: 0 });
    monitor.handleEvent("closed", httpError(401, "Unauthorized"));
    advance(SIX_HOURS * 10);
    monitor.handleRetryFailure(httpError(401, "Unauthorized"));
    expect(sent).toHaveLength(1);
  });
});
