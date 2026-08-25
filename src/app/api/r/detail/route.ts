import { NextResponse } from 'next/server';
import { withAnon } from '@/lib/db';
import { optionalRows } from '@/lib/db-optional';
import { dbErrorResponse } from '@/lib/db-error';

/**
 * The reasons and comment from the emailed landing page — no session (§9).
 *
 * Deliberately outside /api/feedback, which is customer-only: this path is
 * reached by somebody holding a rating token and nothing else, and putting it
 * under a route prefix with an access rule would either break it or weaken the
 * rule. The token is the whole authorisation, it is 24 random bytes, and the
 * function behind it can only attach detail to the one rating it belongs to.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    token?: string;
    tags?: string[];
    comment?: string | null;
  } | null;

  const token = typeof body?.token === 'string' ? body.token : '';
  if (!token) return NextResponse.json({ error: 'a token is required' }, { status: 400 });

  const tags = Array.isArray(body?.tags)
    ? body.tags.filter((t): t is string => typeof t === 'string').slice(0, 10)
    : [];
  const comment = typeof body?.comment === 'string' ? body.comment.slice(0, 4000) : null;

  try {
    const rows = await withAnon((client) =>
      optionalRows<{ id: string | null }>(
        client,
        'attaching detail to an emailed rating',
        `select public.detail_feedback_by_token($1, $2::text[], $3) as id`,
        [token, tags, comment]
      )
    );
    // A spent or unknown token answers the same way as a good one: there is
    // nothing here worth telling a stranger apart with.
    return NextResponse.json({ ok: Boolean(rows[0]?.id) });
  } catch (error) {
    return dbErrorResponse(error, 'Saving your comment');
  }
}
