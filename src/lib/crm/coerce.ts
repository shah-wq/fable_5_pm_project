import type { IntakeField } from './intake';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One submitted value, in the shape its column expects — or null.
 *
 * Every route that writes intake fields goes through this, so a number typed as
 * "8.4 " arrives as 8.4 on every screen, and a reference that is not a uuid is
 * dropped the same way everywhere. It had been copied into each route, which is
 * how two screens come to disagree about what saving a field means.
 *
 * Null is an answer, not a failure: it is what an emptied box means, and the
 * caller decides whether that clears the column or is left out.
 */
export function coerceIntakeValue(field: IntakeField, raw: unknown): unknown {
  if (raw === '' || raw === null || raw === undefined) return null;
  switch (field.type) {
    case 'number':
    case 'currency': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'toggle':
      return raw === true;
    // Yes, No, or nothing — and nothing is a real answer here ("we have not
    // asked yet"), which is why it is not folded into false.
    case 'yesno':
      if (raw === true || raw === 'yes') return true;
      if (raw === false || raw === 'no') return false;
      return null;
    case 'ref':
      return UUID_RE.test(String(raw)) ? String(raw) : null;
    case 'select':
    case 'readonly':
      return field.options?.some((o) => o.value === String(raw)) ? String(raw) : null;
    default:
      return String(raw).slice(0, 4000);
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
