// Symbol picking in Market Watch.
//
// The broker list is not small: measured against the live endpoint on
// 2026-10-01 it is 14,440 symbols, of which "USD" matches 3,374 and the single
// letter "E" matches 4,493. Two things follow, and both are pinned here.
//
//   1. The dropdown renders at most thirty rows. "Select all" must therefore
//      count the FULL match set, not the rendered slice -- a control that says
//      "Select all 3,374" and adds thirty is worse than no control at all.
//   2. Every pick is a live hub subscription and a row re-rendering on each
//      tick, so the bulk add is capped and refuses above it with a reason. An
//      uncapped select-all on "USD" is not a large watchlist, it is a dead tab.
//
// Picking is also multi-select: the list stays open and the query stays put, so
// five related symbols are five clicks rather than five searches.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { MarketWatchTab } from "./MarketWatchTab";

const SESSION_KEY = "slc.session.v2";

// A stand-in for the real list: enough XAU variants to select in bulk, and more
// USD symbols than the cap allows.
const XAU = Array.from({ length: 12 }, (_, i) => `XAUUSD.v${i + 1}`);
const USD = Array.from({ length: 140 }, (_, i) => `PAIR${i + 1}USD`);
const SYMBOLS = [...XAU, ...USD, "EURGBP", "GOLD_ft2"];

function installFetch() {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : (input as Request).url ?? input);
    if (url.includes("/MarketWatch/symbols")) {
      return new Response(JSON.stringify(SYMBOLS), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/MarketWatch/settings")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

// The hub is irrelevant to picking symbols, and a real connection attempt would
// make these tests depend on a socket. Stubbed to a connection that never
// connects; the tab is built to stay usable in exactly that state.
vi.mock("@microsoft/signalr", () => {
  class HubConnectionBuilder {
    withUrl() { return this; }
    withAutomaticReconnect() { return this; }
    configureLogging() { return this; }
    build() {
      return {
        on: () => undefined,
        off: () => undefined,
        onclose: () => undefined,
        onreconnecting: () => undefined,
        onreconnected: () => undefined,
        start: () => Promise.reject(new Error("no hub in tests")),
        stop: () => Promise.resolve(),
        invoke: () => Promise.resolve(),
      };
    }
  }
  return { HubConnectionBuilder, LogLevel: { None: 0 } };
});

beforeEach(() => {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token: "test.session.jwt",
      user: { id: "u1", name: "T", email: "t@t", role: "Super Admin", access: [], status: "active" },
      at: Date.now(),
    }),
  );
  installFetch();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const openSearch = async () => {
  render(<MarketWatchTab refreshKey={0} />);
  const box = await screen.findByPlaceholderText(/Search broker symbols/i);
  // The list only builds once the symbol fetch has resolved.
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
  return box;
};

// queryAllByRole, not getAllByRole: "no chips" is a real expected state here
// (the cap test asserts nothing was added), and getAllBy throws on zero.
const chipText = () =>
  screen
    .queryAllByRole("button", { name: "×" })
    .map((b) => b.parentElement?.textContent?.replace("×", "").trim() ?? "");

describe("Market Watch symbol picking", () => {
  it("counts every match, not just the thirty it renders", async () => {
    const box = await openSearch();
    fireEvent.change(box, { target: { value: "USD" } });

    // 140 PAIRnUSD + 12 XAUUSD.vN all contain "USD".
    await screen.findByText(/152 matches/);
    expect(screen.getByText(/showing 30/)).toBeTruthy();
  });

  it("offers select-all when the match set is within the cap, and adds all of it", async () => {
    const box = await openSearch();
    fireEvent.change(box, { target: { value: "XAUUSD" } });

    const button = await screen.findByRole("button", { name: /Select all 12/ });
    fireEvent.mouseDown(button);

    await waitFor(() => expect(chipText()).toHaveLength(12));
    expect(chipText()).toEqual(expect.arrayContaining(["XAUUSD.v1", "XAUUSD.v12"]));
  });

  it("refuses above the cap and says how to proceed", async () => {
    const box = await openSearch();
    fireEvent.change(box, { target: { value: "USD" } });

    await screen.findByText(/152 matches/);
    // No button to press, and the reason is on screen rather than implied by a
    // greyed-out control.
    expect(screen.queryByRole("button", { name: /Select all/ })).toBeNull();
    expect(screen.getByText(/too many to add at once/)).toBeTruthy();
    expect(chipText()).toHaveLength(0);
  });

  it("keeps the list open and the query intact so several can be picked in a row", async () => {
    const box = await openSearch();
    fireEvent.change(box, { target: { value: "XAUUSD" } });

    const first = await screen.findByText("XAUUSD.v1");
    fireEvent.mouseDown(first);
    await waitFor(() => expect(chipText()).toEqual(["XAUUSD.v1"]));

    // The box still holds the query, and the next symbol is right there.
    expect((box as HTMLInputElement).value).toBe("XAUUSD");
    const second = await screen.findByText("XAUUSD.v2");
    fireEvent.mouseDown(second);
    await waitFor(() => expect(chipText()).toEqual(["XAUUSD.v1", "XAUUSD.v2"]));
  });

  it("drops a picked symbol out of the match set rather than offering it twice", async () => {
    const box = await openSearch();
    fireEvent.change(box, { target: { value: "XAUUSD" } });

    fireEvent.mouseDown(await screen.findByText("XAUUSD.v1"));
    await waitFor(() => expect(chipText()).toEqual(["XAUUSD.v1"]));

    // 12 matched, one taken, so the count falls to 11 and the select-all button
    // follows it.
    await screen.findByText(/11 matches/);
    expect(screen.getByRole("button", { name: /Select all 11/ })).toBeTruthy();
  });

  it("shows no select-all control before anything is typed", async () => {
    await openSearch();
    // An empty query matches nothing by design: "select all" over 14,440 live
    // subscriptions is never the thing anyone meant.
    expect(screen.queryByText(/matches/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Select all/ })).toBeNull();
  });
});
