import { describe, expect, it } from "vitest";
import { isWithinMonthlyLimit } from "./usage.js";

describe("monthly Agentcord usage limits", () => {
  it("treats zero or negative as unlimited", () => {
    expect(isWithinMonthlyLimit(1_000_000, 0)).toBe(true);
    expect(isWithinMonthlyLimit(1_000_000, -1)).toBe(true);
  });

  it("enforces positive monthly limits", () => {
    expect(isWithinMonthlyLimit(4, 5)).toBe(true);
    expect(isWithinMonthlyLimit(5, 5)).toBe(false);
  });
});
