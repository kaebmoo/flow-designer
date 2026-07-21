import { describe, expect, it } from "vitest";

import { sessionWarningSeconds } from "@/components/atlas/session-warning";

describe("sessionWarningSeconds", () => {
  const now = Date.parse("2026-07-21T00:00:00Z");

  it("returns the ceiling at the five-minute boundary", () => {
    expect(sessionWarningSeconds("2026-07-21T00:05:00Z", now)).toBe(300);
    expect(sessionWarningSeconds("2026-07-21T00:05:00.001Z", now)).toBe(301);
  });

  it("continues to report elapsed time without authorising a sign-out", () => {
    expect(sessionWarningSeconds("2026-07-20T23:59:59Z", now)).toBe(-1);
  });

  it("fails closed for missing or malformed metadata", () => {
    expect(sessionWarningSeconds(undefined, now)).toBeNull();
    expect(sessionWarningSeconds("not-a-date", now)).toBeNull();
  });
});
