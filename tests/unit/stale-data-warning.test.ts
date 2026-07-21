import { describe, expect, it } from "vitest";

import { hasActiveStaleAtlasData } from "@/lib/stale-data";

function query({
  active = true,
  data,
  error = null,
}: {
  active?: boolean;
  data?: unknown;
  error?: unknown;
}) {
  return { isActive: () => active, state: { data, error } };
}

describe("stale Atlas data warning", () => {
  it("appears when an active outage failure coexists with active cached data", () => {
    expect(
      hasActiveStaleAtlasData([
        query({ data: { workers: 3 } }),
        query({ data: { runs: 2 }, error: { kind: "network", message: "unreachable" } }),
      ]),
    ).toBe(true);
  });

  it.each(["network", "timeout", "server", "protocol"])(
    "treats %s as an outage-shaped failure",
    (kind) => {
      expect(
        hasActiveStaleAtlasData([query({ data: [], error: { kind, message: "failed" } })]),
      ).toBe(true);
    },
  );

  it("does not mislabel permission, validation, conflict, or sign-out failures", () => {
    for (const kind of ["unauthorized", "forbidden", "not_found", "validation", "conflict"]) {
      expect(
        hasActiveStaleAtlasData([query({ data: [], error: { kind, message: "terminal" } })]),
      ).toBe(false);
    }
  });

  it("stays hidden without cached data and ignores failures from inactive routes", () => {
    expect(
      hasActiveStaleAtlasData([query({ error: { kind: "network", message: "unreachable" } })]),
    ).toBe(false);
    expect(
      hasActiveStaleAtlasData([
        query({ data: [], active: true }),
        query({ data: [], active: false, error: { kind: "network", message: "old" } }),
      ]),
    ).toBe(false);
  });
});
