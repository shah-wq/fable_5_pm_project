import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { findExistingCustomers } from '@/lib/customers/service';

/**
 * 'Is this person already on file?' — called by the New project form as the
 * email or phone is typed. A warning at creation prevents most duplicates from
 * ever existing, which is far cheaper than merging them afterwards.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const email = params.get('email')?.trim().toLowerCase() || null;
  const phone = params.get('phone')?.trim() || null;
  if (!email && !phone) return NextResponse.json({ matches: [] });

  const matches = await withUser(session, (c) => findExistingCustomers(c, email, phone))
    .catch(() => []);
  return NextResponse.json({ matches });
}
