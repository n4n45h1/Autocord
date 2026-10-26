const weekdayIndex: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const weekday = weekdayIndex[parts.find((part) => part.type === "weekday")?.value ?? ""];
  if (weekday === undefined) throw new Error(`Unsupported time zone weekday: ${timeZone}`);
  return { year: value("year"), month: value("month"), day: value("day"), weekday, hour: value("hour"), minute: value("minute") };
}

function localTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = desired;
  for (let attempt = 0; attempt < 4; attempt++) {
    const local = zonedParts(new Date(timestamp), timeZone);
    const rendered = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    timestamp += desired - rendered;
  }
  const result = new Date(timestamp);
  const verified = zonedParts(result, timeZone);
  if (verified.year !== year || verified.month !== month || verified.day !== day || verified.hour !== hour || verified.minute !== minute) throw new Error(`The requested local time does not exist in ${timeZone}.`);
  return result;
}

export function nextWeeklyOccurrence(now: Date, dayOfWeek: number, hour: number, minute: number, timeZone: string): Date {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6 || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("Invalid weekly schedule fields.");
  const current = zonedParts(now, timeZone);
  let days = (dayOfWeek - current.weekday + 7) % 7;
  if (days === 0 && (current.hour > hour || current.hour === hour && current.minute >= minute)) days = 7;
  for (let week = 0; week < 3; week++) {
    const date = new Date(Date.UTC(current.year, current.month - 1, current.day + days + week * 7));
    try { return localTimeToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timeZone); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("local time does not exist")) throw error;
    }
  }
  throw new Error(`Could not resolve a weekly occurrence in ${timeZone}.`);
}
