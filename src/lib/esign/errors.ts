import { NextResponse } from 'next/server';
import { dbErrorResponse } from '../db-error';
import { PandaDocError } from './pandadoc';

const sentence = (t: string) => {
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
};

/**
 * The answer for anything the e-signature routes can hit.
 *
 * PandaDoc's refusals are reported as a bad gateway with PandaDoc's own words —
 * an invalid template id or an expired key is fixed in PandaDoc or in
 * Settings, not in this app. The database's own refusals (a contact already
 * held, a document already out, a field missing) are sentences written for the
 * person at the form, so they arrive as 4xx with that sentence.
 */
export function esignErrorResponse(e: unknown, action: string): NextResponse {
  if (e instanceof PandaDocError) {
    const status = e.upstream ? 502 : e.status;
    console.error(`[esign] ${action}:`, e.message);
    return NextResponse.json({ error: sentence(e.message) }, { status });
  }
  const err = (e ?? {}) as { code?: string; message?: string };
  const map: Record<string, number> = { '22023': 400, P0002: 404, '55000': 409, '23505': 409 };
  if (err.code && map[err.code] && err.message) {
    // A duplicate-key on the one-open-envelope index says the same thing as the
    // function's own check, in index language.
    const text = /esign_envelopes_one_open/.test(err.message)
      ? 'This is already out for signature — void it first'
      : err.message;
    return NextResponse.json({ error: sentence(text) }, { status: map[err.code] });
  }
  return dbErrorResponse(e, action);
}
