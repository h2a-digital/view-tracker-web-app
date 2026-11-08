import { z } from 'zod';
export const accountingTimezone = 'America/New_York';
export const instantSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
export function instant(value: string) {
  return instantSchema.parse(value);
}
export function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: accountingTimezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}
export function previousAccountingMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: accountingTimezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')!.value),
    m = Number(parts.find((p) => p.type === 'month')!.value);
  return new Date(Date.UTC(y, m - 2, 15)).toISOString().slice(0, 7);
}
