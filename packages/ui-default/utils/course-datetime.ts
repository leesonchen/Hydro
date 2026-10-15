import moment from 'moment-timezone';

export function parseDateTime(value: unknown, timeZone?: string): Date | null {
  const text = String(value || '').trim();
  const parts = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!parts) return null;
  if (timeZone && !moment.tz.zone(timeZone)) return null;
  const [, year, month, day, hour, minute, second = '00'] = parts;
  const pad = (part: string) => part.padStart(2, '0');
  const normalized = `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${minute}:${second}`;
  const format = 'YYYY-MM-DD HH:mm:ss';
  const parsed = timeZone ? moment.tz(normalized, format, true, timeZone) : moment(normalized, format, true);
  return parsed.isValid() ? parsed.toDate() : null;
}

export function formatDateTime(date: Date, timeZone?: string, includeSeconds = false): string {
  const parsed = timeZone ? moment(date).tz(timeZone) : moment(date);
  return parsed.format(includeSeconds ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD HH:mm');
}

export function assessmentDateTimeToIso(value: unknown, originalIso: string, initialDisplay: string): string {
  // An unrelated edit or a blur must not round the stored seconds or milliseconds.
  if (originalIso && String(value || '').trim() === initialDisplay) return originalIso;
  return parseDateTime(value)?.toISOString() || '';
}
