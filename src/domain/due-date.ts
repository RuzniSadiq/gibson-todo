import { TodoError } from './errors.ts';
import { isCalendarDate } from './task.ts';

/**
 * Due-date input parsing. Pure: "today" is always passed in (a YYYY-MM-DD
 * calendar date taken from the injected Clock), never read from the system.
 */

export const DUE_INPUT_HINT =
  'Use YYYY-MM-DD (e.g. 2026-11-14), today, tomorrow, or a weekday such as friday or fri.';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * Resolves user input to a YYYY-MM-DD calendar date.
 * Accepts YYYY-MM-DD, `today`, `tomorrow`, and full or 3-letter weekday names
 * (any letter case). A weekday names the next such day on or after `today`,
 * so typing today's weekday means today.
 */
export function parseDueInput(input: string, today: string): string {
  assertCalendarDate(today);
  const text = input.trim();
  // Lower-cased before the type guard: isCalendarDate narrows a non-date string to `never`.
  const word = text.toLowerCase();
  if (isCalendarDate(text)) return text;

  if (word === 'today') return today;
  if (word === 'tomorrow') return addDays(today, 1);

  const weekday = WEEKDAYS.findIndex((name) => word === name || word === name.slice(0, 3));
  if (weekday !== -1) {
    const ahead = (weekday - dayOfWeek(today) + 7) % 7;
    return addDays(today, ahead);
  }

  throw new TodoError('VALIDATION', `"${input}" is not a due date I understand.`, { hint: DUE_INPUT_HINT });
}

/** The local calendar date (YYYY-MM-DD) of an instant, in the process time zone. */
export function localCalendarDate(instant: Date): string {
  return formatYmd(instant.getFullYear(), instant.getMonth() + 1, instant.getDate());
}

/** Friendly text form, e.g. `Fri 14 Nov 2026`. */
export function formatDueDate(date: string): string {
  assertCalendarDate(date);
  const { year, month, day } = splitDate(date);
  return `${WEEKDAY_SHORT[dayOfWeek(date)]} ${day} ${MONTH_SHORT[month - 1]} ${year}`;
}

function assertCalendarDate(date: string): void {
  if (!isCalendarDate(date)) throw new TypeError(`Expected a YYYY-MM-DD calendar date, got "${date}".`);
}

function splitDate(date: string): { year: number; month: number; day: number } {
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) };
}

// UTC-only arithmetic on a calendar date: no time zone or DST can shift the day.
// setUTCFullYear (unlike Date.UTC) does not remap years 0–99 to 1900–1999.
function toUtc(date: string): Date {
  const { year, month, day } = splitDate(date);
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d;
}

function dayOfWeek(date: string): number {
  return toUtc(date).getUTCDay();
}

function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  const result = formatYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  // Only reachable past year 9999, where YYYY-MM-DD runs out of digits.
  if (!isCalendarDate(result)) {
    throw new TodoError('VALIDATION', 'That due date is out of range.', { hint: DUE_INPUT_HINT });
  }
  return result;
}

function formatYmd(year: number, month: number, day: number): string {
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}
