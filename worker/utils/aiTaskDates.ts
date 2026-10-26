/** Deterministic English relative-date resolver for AI task assignment. */
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const DAY_PATTERN = "sunday|monday|tuesday|wednesday|thursday|friday|saturday";

/** Calendar date in the company's timezone, NOT UTC. */
export function companyToday(now: Date = new Date(), timeZone = "Asia/Kolkata"): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

function dayIndex(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Resolves one clearly specified English relative due date.
 * - "Friday" / "this Friday": closest upcoming occurrence (including today)
 * - "next Friday": Friday of NEXT calendar week (Mon–Sun)
 * - today / tomorrow / day after tomorrow
 * Returns null if there is no supported or unambiguous expression.
 * Explicit ISO or numeric dates are left for existing AI/schema handling.
 */
export function resolveRelativeDueDate(
  prompt: string,
  now: Date = new Date(),
  timeZone = "Asia/Kolkata",
): string | null {
  const today = companyToday(now, timeZone);
  const text = prompt.toLowerCase();

  // Never override an explicitly supplied calendar date.
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(text) || /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(text)) return null;

  // Only look for date expressions in deadline contexts to avoid treating e.g.
  // "Friday campaign" as a deadline. Match common assignment phrasing.
  const deadline = new RegExp(
    `\\b(?:by|due(?:\\s+(?:on|by))?|deadline(?:\\s+(?:is|on))?|before|on)\\s+((?:next|this|coming)\\s+)?(${DAY_PATTERN}|today|tomorrow|day\\s+after\\s+tomorrow)\\b`,
    "i",
  );
  const match = text.match(deadline);
  if (!match) return null;
  const qualifier = (match[1] || "").trim();
  const target = match[2].replace(/\s+/g, " ");

  if (target === "today") return today;
  if (target === "tomorrow") return addDays(today, 1);
  if (target === "day after tomorrow") return addDays(today, 2);

  const targetDay = DAYS.indexOf(target as (typeof DAYS)[number]);
  const currentDay = dayIndex(today);
  const daysUntil = (targetDay - currentDay + 7) % 7;
  if (qualifier === "next") {
    // ISO week starts Monday. "Next Friday" means Friday in next Mon–Sun week.
    const untilNextMonday = ((8 - currentDay) % 7) || 7;
    const weekdayOffset = (targetDay + 6) % 7;
    return addDays(today, untilNextMonday + weekdayOffset);
  }
  return addDays(today, daysUntil);
}
