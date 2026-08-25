/**
 * One way to turn whatever the database handed back into the 'YYYY-MM-DD' that
 * an <input type="date"> and a day count both need.
 *
 * `date` columns already arrive as text (see the type parser in db.ts), but
 * `timestamptz` columns arrive as Date objects, and the two get mixed in the
 * same value map — a stage form is fed `select *` from its stage table plus the
 * project's created_at. Slicing ten characters off a stringified Date gives
 * 'Tue Aug 25', which then parses as a date in 2001 and made one stage card
 * report a survey as 9,142 days old.
 */
export function isoDate(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  }
  const s = String(value);
  // '2026-08-16' and '2026-08-16T09:30:00.000Z' both start with the date.
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1];
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}
