import { describe, expect, it } from "vitest";

import { counted, plural } from "@/lib/plural";

describe("interface pluralization", () => {
  it("keeps the singular only at exactly one", () => {
    expect(plural(1, "choice")).toBe("choice");
    expect(plural(0, "choice")).toBe("choices");
    expect(plural(2, "choice")).toBe("choices");
  });

  it("takes an explicit plural for irregular nouns", () => {
    expect(plural(1, "entry", "entries")).toBe("entry");
    expect(plural(3, "entry", "entries")).toBe("entries");
  });

  it("puts the count in front, which is how every call site reads", () => {
    expect(counted(1, "choice")).toBe("1 choice");
    expect(counted(3, "choice")).toBe("3 choices");
  });

  /**
   * The regression this helper exists for.
   *
   * `${n} choice(s)` and `Showing the ${n} newest ${plural}` both rendered "1 …s" for a
   * single-row list — machine shorthand in the human voice, on every list page in the product.
   */
  it("reads correctly for the one-row case that was wrong", () => {
    expect(`Showing the ${counted(1, "newest workflow")} Atlas returned`).toBe(
      "Showing the 1 newest workflow Atlas returned",
    );
    expect(`Showing the ${counted(2, "newest workflow")} Atlas returned`).toBe(
      "Showing the 2 newest workflows Atlas returned",
    );
  });
});
