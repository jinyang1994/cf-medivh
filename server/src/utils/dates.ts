import dayjs, { type Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(utc);
dayjs.extend(customParseFormat);

type DateInput = string | number | Date;
const DATE_FORMAT = 'YYYY-MM-DD';
export const TEN_MINUTES = 600_000;

/** Parse in UTC while preserving the instant; bare calendar dates must be exact. */
export function utcDay(date?: DateInput): Dayjs {
  return typeof date === 'string' && /^\d{4}-\d{1,2}-\d{1,2}$/.test(date)
    ? dayjs.utc(date, DATE_FORMAT, true)
    : dayjs.utc(date);
}

function requireValid(date: Dayjs): Dayjs {
  if (!date.isValid()) throw new RangeError('Invalid UTC date');
  return date;
}

export const utcDate = (date?: DateInput): string => requireValid(utcDay(date)).format(DATE_FORMAT);

export function validDate(value: string): boolean {
  return typeof value === 'string' && dayjs.utc(value, DATE_FORMAT, true).isValid();
}

export function addDays(date: string, days: number): string {
  if (!validDate(date)) throw new RangeError('Invalid UTC date');
  if (!Number.isInteger(days)) throw new RangeError('Day offset must be an integer');
  return utcDay(date).add(days, 'day').format(DATE_FORMAT);
}

export const utcDayStart = (date: DateInput): number =>
  requireValid(utcDay(date)).startOf('day').valueOf();

export function utcDayRange(date: DateInput): { start: number; end: number } {
  const start = requireValid(utcDay(date)).startOf('day');
  return { start: start.valueOf(), end: start.add(1, 'day').valueOf() };
}

export function datesBetween(start: string, through: string): string[] {
  if (!validDate(start) || !validDate(through)) throw new RangeError('Invalid UTC date range');
  const dates: string[] = [];
  const end = utcDay(through);
  for (let date = utcDay(start); !date.isAfter(end); date = date.add(1, 'day'))
    dates.push(date.format(DATE_FORMAT));
  return dates;
}

export function cycleContains(cycle: { start: string; end: string }, date: string): boolean {
  return (
    validDate(cycle.start) &&
    validDate(cycle.end) &&
    validDate(date) &&
    cycle.start <= date &&
    date < cycle.end
  );
}

export const nextSlot = (now: Date): Date =>
  new Date((Math.floor(now.getTime() / TEN_MINUTES) + 1) * TEN_MINUTES);
export const slotKey = (now: Date): string =>
  new Date(Math.floor(now.getTime() / TEN_MINUTES) * TEN_MINUTES).toISOString();
