import { describe, expect, it } from "vitest";

import { addMonths } from "../../src/lib/rates";

const localDateKey = (date: Date): string =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

describe("addMonths", () => {
  it.each([
    [new Date(2025, 0, 31), 1, "2025-02-28"],
    [new Date(2025, 2, 31), 1, "2025-04-30"],
    [new Date(2025, 4, 31), 1, "2025-06-30"],
    [new Date(2024, 0, 31), 1, "2024-02-29"],
    [new Date(2025, 9, 31), 4, "2026-02-28"],
    [new Date(2025, 11, 31), 2, "2026-02-28"],
    [new Date(2025, 7, 15), 1, "2025-09-15"],
  ])("clamps %s + %d months to %s", (base, months, expectedDate) => {
    expect(localDateKey(addMonths(base, months))).toBe(expectedDate);
  });

  it("preserves the source time of day", () => {
    const result = addMonths(new Date(2025, 0, 31, 18, 45, 12, 345), 1);

    expect(result.getHours()).toBe(18);
    expect(result.getMinutes()).toBe(45);
    expect(result.getSeconds()).toBe(12);
    expect(result.getMilliseconds()).toBe(345);
  });
});
