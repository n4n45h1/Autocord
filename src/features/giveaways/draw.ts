import { randomInt } from "node:crypto";

export function drawWinners(entries: readonly string[], winnerCount: number, chooseIndex: (max: number) => number = randomInt): string[] {
  const candidates = [...new Set(entries)];
  const winners: string[] = [];
  const count = Math.max(0, Math.min(Math.floor(winnerCount), candidates.length));
  while (winners.length < count) winners.push(candidates.splice(chooseIndex(candidates.length), 1)[0]!);
  return winners;
}

export function giveawayNotificationRetryDelayMs(attempts: number): number {
  return Math.min(3_600, 5 * 2 ** Math.min(Math.max(0, attempts - 1), 10)) * 1000;
}

export function giveawayResultMessage(prize: string, winners: readonly string[], reroll = false): string {
  const label = reroll ? "再抽選の当選者" : "当選者";
  return winners.length
    ? `🎉 **${prize}** ${label}: ${winners.map((id) => `<@${id}>`).join(", ")}`
    : `「${prize}」は応募者なしで終了しました。`;
}
