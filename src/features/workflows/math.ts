export type BinaryMathAction = "math.add" | "math.subtract" | "math.multiply" | "math.divide";

export function calculateBinaryMath(action: BinaryMathAction, left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error("Math operands must be finite numbers.");
  if (action === "math.divide" && right === 0) throw new Error("Division by zero.");
  const value = action === "math.add" ? left + right : action === "math.subtract" ? left - right : action === "math.multiply" ? left * right : left / right;
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) throw new Error("Math result exceeds numeric bounds.");
  return value;
}

export function calculateAggregateMath(action: "math.min" | "math.max", values: readonly number[]): number {
  if (!values.length || values.some((value) => !Number.isFinite(value))) throw new Error("Math aggregate requires finite values.");
  return action === "math.min" ? Math.min(...values) : Math.max(...values);
}

export function calculateClamp(value: number, min: number, max: number): number {
  if (![value, min, max].every(Number.isFinite) || max < min) throw new Error("Invalid clamp bounds or value.");
  return Math.min(max, Math.max(min, value));
}

export function selectWeighted<T>(options: readonly { value: T; weight: number }[], ticket: number): T {
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  if (!Number.isSafeInteger(ticket) || ticket < 0 || ticket >= total) throw new Error("Weighted random ticket is outside the option range.");
  for (const option of options) {
    if (ticket < option.weight) return option.value;
    ticket -= option.weight;
  }
  throw new Error("Weighted random selection failed.");
}
