import { z } from 'zod';

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, 'Must be a real calendar date in YYYY-MM-DD format');

export function dateRange(startDate: string, endDate: string): string[] {
  const start = new Date(`${dateSchema.parse(startDate)}T00:00:00.000Z`);
  const end = new Date(`${dateSchema.parse(endDate)}T00:00:00.000Z`);
  const dates: string[] = [];
  for (let day = start; day <= end; day = new Date(day.valueOf() + 86_400_000)) dates.push(day.toISOString().slice(0, 10));
  return dates;
}

export const nightsBetween = (startDate: string, endDate: string): number => dateRange(startDate, endDate).length - 1;
