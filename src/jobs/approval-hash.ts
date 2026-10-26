import { createHash } from "node:crypto";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
}

export function approvalHash(input: { guildId: string; revision: number | null; plan: unknown; executionContext: unknown }): string {
  return createHash("sha256").update(JSON.stringify(stableValue(input))).digest("hex");
}
