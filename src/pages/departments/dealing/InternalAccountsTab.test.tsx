// InternalAccountsTab renders a checkbox in edit mode straight off
// `row.excludeFromEquity` / `excludeFromPositions` / `excludeFromSwaps`, with
// no `!!` coercion. `excludeFromSwaps` does not exist on GET /api/LpAccount
// today, so every row comes back with that field `undefined`. That makes
// `checked={undefined}` -- an uncontrolled checkbox -- and the moment the
// user's own click hands the input a real boolean via onChange, React logs
// "changing an uncontrolled input to be controlled". The sibling flags never
// hit this today because their fields exist on the live API, but nothing
// stops the next absent field from repeating the bug, so all three are
// coerced with `!!` in load().
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { InternalAccountsTab } from "./InternalAccountsTab";

const ROW_MISSING_FLAGS = {
  id: 1,
  mt5Login: 1001,
  label: "Ops",
  system: "Live",
  description: null,
  // excludeFromEquity, excludeFromPositions, excludeFromSwaps intentionally
  // absent -- this is what the live API sends today for excludeFromSwaps,
  // reproduced here for all three so the fix is proven for all three.
  isActive: true,
};

function stubFetchOnce(rows: unknown[]) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => rows,
    text: async () => "",
  }) as unknown as typeof fetch;
}

describe("InternalAccountsTab edit-mode checkboxes", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not log the uncontrolled-input warning when a flag field is absent from the API row", async () => {
    stubFetchOnce([ROW_MISSING_FLAGS]);

    render(<InternalAccountsTab backendBaseUrl="http://backend.test" refreshKey={0} />);

    await waitFor(() => screen.getByText("Ops"));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    // Add-form has 3 checkboxes, the edit row adds 3 more (equity, positions, swaps).
    expect(checkboxes.length).toBeGreaterThanOrEqual(6);

    // Toggling is what exposes the bug: it hands the input a real boolean via
    // onChange, which is exactly the undefined -> defined transition React
    // warns about for a checkbox that started uncontrolled.
    for (const box of checkboxes) {
      fireEvent.click(box);
    }

    const uncontrolledWarnings = errorSpy.mock.calls.filter((call) =>
      String(call[0]).includes("an uncontrolled input to be controlled"),
    );
    expect(uncontrolledWarnings).toEqual([]);
  });
});
