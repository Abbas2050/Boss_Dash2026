// @vitest-environment node
//
// Reading DoubleTick's MESSAGE_STATUS_UPDATE payload. Pure, so every case here
// is a value in and a value out.
//
// The two things this file is really about are the two the documentation does
// NOT settle: the exact string WhatsApp's read receipt arrives as, and the
// format of `statusTimestamp`. Both are handled by keeping what arrived rather
// than by guessing, and both have a test below that fails if a guess is
// hardcoded.
import { describe, it, expect } from "vitest";
import {
  classifyDeliveryStatus,
  toDeliveryInstant,
  readDeliveryUpdate,
  DELIVERY_KINDS,
} from "./whatsappStatus.js";

const AT = new Date("2026-10-16T09:00:00.000Z");

describe("classifyDeliveryStatus", () => {
  it("recognises the three statuses DoubleTick's samples show", () => {
    expect(classifyDeliveryStatus("SENT").kind).toBe("sent");
    expect(classifyDeliveryStatus("DELIVERED").kind).toBe("delivered");
    expect(classifyDeliveryStatus("FAILED").kind).toBe("failed");
  });

  it("recognises READ if it arrives, case-insensitively, without that being the only read value", () => {
    // The read status is described in prose and its exact string is not
    // documented. So READ is recognised when it turns up -- and the test below
    // is the other half: a different string must still be visible.
    for (const value of ["READ", "read", "Read", " read "]) {
      expect(classifyDeliveryStatus(value).kind, value).toBe("read");
    }
  });

  it("treats DELIVERED case-insensitively too", () => {
    for (const value of ["delivered", "Delivered", "DELIVERED"]) {
      expect(classifyDeliveryStatus(value).kind, value).toBe("delivered");
    }
  });

  it("keeps an unrecognised status readable instead of dropping it", () => {
    // This is the undocumented read value arriving as something else, and any
    // status DoubleTick adds later. The value has to survive: an allowlist that
    // dropped it would be the SENT/ENQUEUED trap one step along, where every
    // message read as unsent while arriving perfectly well.
    const r = classifyDeliveryStatus("SEEN_BY_RECIPIENT");
    expect(r.kind).toBe("unknown");
    expect(r.recognised).toBe(false);
    expect(r.value).toBe("SEEN_BY_RECIPIENT");
  });

  it("keeps the status's own casing, so the stored value is what arrived", () => {
    // Matching is case-insensitive; storing is not. A value rewritten to upper
    // case is no longer evidence of what the provider sent.
    expect(classifyDeliveryStatus("Delivered").value).toBe("Delivered");
    expect(classifyDeliveryStatus("deliveredToHandset").value).toBe("deliveredToHandset");
  });

  it("refuses anything that is not a string, rather than coercing it", () => {
    // ["DELIVERED"] stringifies to "DELIVERED", which would read as a delivery.
    for (const value of [["DELIVERED"], { status: "DELIVERED" }, 1, true, null, undefined]) {
      const r = classifyDeliveryStatus(value);
      expect(r.kind, JSON.stringify(value) ?? String(value)).toBe("unknown");
      expect(r.value, JSON.stringify(value) ?? String(value)).toBe("");
    }
  });

  it("returns only kinds the module declares", () => {
    for (const value of ["SENT", "DELIVERED", "READ", "FAILED", "WHAT", ""]) {
      expect(DELIVERY_KINDS, value).toContain(classifyDeliveryStatus(value).kind);
    }
  });
});

describe("toDeliveryInstant", () => {
  it("reads epoch milliseconds", () => {
    expect(toDeliveryInstant(1760000000000, AT).toISOString()).toBe(new Date(1760000000000).toISOString());
  });

  it("reads epoch seconds as seconds, not as 1970", () => {
    // The format is not documented. A seconds value read as milliseconds is the
    // OpenAI timestamp_ms trap: every row stamped in 1970, nothing erroring, and
    // a column that looks like data.
    const at = toDeliveryInstant(1760000000, AT);
    expect(at.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it("reads a numeric string, which is how a provider often quotes a big integer", () => {
    expect(toDeliveryInstant("1760000000000", AT).toISOString()).toBe(new Date(1760000000000).toISOString());
  });

  it("reads an ISO string", () => {
    expect(toDeliveryInstant("2026-10-16T08:30:00.000Z", AT).toISOString()).toBe("2026-10-16T08:30:00.000Z");
  });

  it("falls back to the arrival instant rather than storing a value it cannot read", () => {
    // Late by seconds and true beats 1970 and false.
    for (const value of [undefined, null, "", "   ", "not a date", {}, [], 0, -1, NaN]) {
      expect(toDeliveryInstant(value, AT).toISOString(), JSON.stringify(value) ?? String(value)).toBe(
        AT.toISOString()
      );
    }
  });
});

describe("readDeliveryUpdate", () => {
  const body = (over = {}) => ({
    messageId: "6d0c7f2e-0d3a-4a6f-9b3e-1f2c3d4e5f60",
    status: "DELIVERED",
    statusTimestamp: 1760000000000,
    ...over,
  });

  it("reads the four documented fields", () => {
    const r = readDeliveryUpdate(body({ status: "FAILED", failMessage: "handset unreachable" }), AT);
    expect(r).toMatchObject({
      messageId: "6d0c7f2e-0d3a-4a6f-9b3e-1f2c3d4e5f60",
      status: "FAILED",
      kind: "failed",
      recognised: true,
      failMessage: "handset unreachable",
    });
    expect(r.at.toISOString()).toBe(new Date(1760000000000).toISOString());
  });

  it("returns an update for a status nobody recognises, because that is the point", () => {
    // Refusing the unrecognised ones here would lose the real read value on the
    // one delivery that would have revealed it.
    const r = readDeliveryUpdate(body({ status: "SEEN" }), AT);
    expect(r.status).toBe("SEEN");
    expect(r.kind).toBe("unknown");
    expect(r.recognised).toBe(false);
  });

  it("returns null when there is no messageId, because there is no row to reach", () => {
    // `{}` is the one worth naming: String({}) is "[object Object]", a non-empty
    // id that matches no row -- so a body we mis-read would be logged as the
    // provider sending us an id we never issued.
    for (const messageId of [undefined, null, "", "   ", {}, [], true]) {
      expect(readDeliveryUpdate(body({ messageId }), AT), JSON.stringify(messageId) ?? String(messageId)).toBeNull();
    }
  });

  it("takes a numeric id, since theirs may not be a UUID", () => {
    // Ours is a v4 UUID. Whether the id on this event is ours at all is the
    // unverified half of the design, so a numeric id has to be readable rather
    // than rejected -- otherwise the evidence that settles it never arrives.
    expect(readDeliveryUpdate(body({ messageId: 12345 }), AT).messageId).toBe("12345");
  });

  it("returns null when there is no readable status, so nothing is written for a payload we did not understand", () => {
    for (const status of [undefined, null, "", "  ", ["DELIVERED"], { s: 1 }]) {
      expect(readDeliveryUpdate(body({ status }), AT), JSON.stringify(status) ?? String(status)).toBeNull();
    }
  });

  it("returns null for a body that is not an object", () => {
    for (const value of [undefined, null, "", "DELIVERED", 1, [], [{ messageId: "x", status: "SENT" }]]) {
      expect(readDeliveryUpdate(value, AT), JSON.stringify(value) ?? String(value)).toBeNull();
    }
  });

  it("reads only the documented top-level fields, and invents no wrapper", () => {
    // No `data.` envelope and no `messages[0]` is looked for: neither is in
    // DoubleTick's documentation, and a shape invented here would be one nothing
    // sends. A body in an unexpected shape reads as nothing to act on, which the
    // route then logs -- loudly, on the first real message.
    expect(readDeliveryUpdate({ data: { messageId: "x", status: "SENT" } }, AT)).toBeNull();
    expect(readDeliveryUpdate({ messages: [{ messageId: "x", status: "SENT" }] }, AT)).toBeNull();
  });

  it("leaves failMessage empty when the status is not a failure", () => {
    expect(readDeliveryUpdate(body(), AT).failMessage).toBe("");
  });
});
