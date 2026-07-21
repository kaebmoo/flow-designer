import { describe, expect, it } from "vitest";

import { formatLoginRateLimitMessage } from "@/lib/auth-retry";

describe("formatLoginRateLimitMessage", () => {
  it("renders a bounded countdown when Atlas supplied a valid Retry-After value", () => {
    expect(formatLoginRateLimitMessage(1)).toContain("Try again in 1 second.");
    expect(formatLoginRateLimitMessage(12)).toContain("Try again in 12 seconds.");
  });

  it("does not claim a zero-second countdown when Atlas omitted or sent an invalid header", () => {
    for (const value of [0, -1, Number.NaN]) {
      expect(formatLoginRateLimitMessage(value)).toContain("Wait a moment before trying again.");
      expect(formatLoginRateLimitMessage(value)).not.toContain("0 second");
    }
  });
});
