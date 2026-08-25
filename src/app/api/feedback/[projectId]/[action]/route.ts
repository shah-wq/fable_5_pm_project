import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { dismiss, recordDetail, recordNps, recordScore } from '@/lib/feedback/service';
import { isStageKey } from '@/lib/stages/definitions';
import { isAppShell } from '@/lib/native/shell';
import { notifyLowScore } from '@/lib/feedback/notify';

/**
 * The four things the sheet can do (Stage feedback §3, §9): a score, the detail
 * behind a low one, the recommendation question, and 'not now'.
 *
 * Four actions on one route rather than four files, because they are one form
 * and share every check. The rules about whether an answer is allowed at all
 * live in the database functions — this layer decides nothing except which
 * function to call and what to call the channel.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string; action: string }> }
) {
  const { projectId, action } = await params;
  const session = await getSession();
  if (!session || session.role !== 'customer' || !session.isActive) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    stage?: string;
    score?: number;
    nps?: number;
    tags?: string[];
    comment?: string | null;
  } | null;

  const stage = body?.stage;
  if (!stage || !isStageKey(stage)) {
    return NextResponse.json({ error: 'a valid stage is required' }, { status: 400 });
  }

  // §8: which channel answered is a reported number, so it has to be recorded
  // honestly rather than defaulted. The app and the portal are the same code in
  // different shells; the user agent is the only thing that distinguishes them,
  // and it decides a label here and nothing else.
  const channel = (await isAppShell()) ? 'app' : 'portal';

  try {
    return await withUser(session, async (client) => {
      switch (action) {
        case 'score': {
          const score = Number(body?.score);
          if (!Number.isInteger(score) || score < 1 || score > 5) {
            return NextResponse.json({ error: 'score must be 1 to 5' }, { status: 400 });
          }
          const ok = await recordScore(client, projectId, stage, score, channel);
          // §5: the PM hears about a low score immediately. Awaited, but never
          // allowed to fail the save — the rating is the thing that must land.
          if (ok && score <= 2) {
            await notifyLowScore(client, projectId, stage, score, null).catch(() => undefined);
          }
          return NextResponse.json({ ok }, { status: ok ? 200 : 409 });
        }
        case 'detail': {
          const tags = Array.isArray(body?.tags)
            ? body.tags.filter((t): t is string => typeof t === 'string').slice(0, 10)
            : [];
          const comment =
            typeof body?.comment === 'string' ? body.comment.slice(0, 4000) : null;
          const ok = await recordDetail(client, projectId, stage, tags, comment);
          // No second email here. The PM was told the moment the face was
          // tapped, and the comment lands on the open task within seconds — a
          // follow-up email a few seconds after the first would train people to
          // skim both.
          return NextResponse.json({ ok }, { status: ok ? 200 : 409 });
        }
        case 'nps': {
          const nps = Number(body?.nps);
          if (!Number.isInteger(nps) || nps < 0 || nps > 10) {
            return NextResponse.json({ error: 'a recommendation score is 0 to 10' }, { status: 400 });
          }
          const ok = await recordNps(client, projectId, stage, nps);
          return NextResponse.json({ ok }, { status: ok ? 200 : 409 });
        }
        case 'dismiss': {
          await dismiss(client, projectId, stage);
          return NextResponse.json({ ok: true });
        }
        default:
          return NextResponse.json({ error: 'unknown action' }, { status: 404 });
      }
    });
  } catch (error) {
    return dbErrorResponse(error, 'Saving your rating');
  }
}
