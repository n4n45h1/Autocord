import { randomInt } from "node:crypto";

export function drawWinners(entries: readonly string[], winnerCount: number, chooseIndex: (max: number) => number = randomInt): string[] {
  const candidates = [...new Set(entries)];
  const winners: string[] = [];
  const count = Math.max(0, Math.min(Math.floor(winnerCount), candidates.length));
  while (winners.length < count) winners.push(candidates.splice(chooseIndex(candidates.length), 1)[0]!);
  return winners;
}
