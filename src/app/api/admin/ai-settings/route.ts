import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { optionalQuery, optionalRows } from '@/lib/db-optional';
import { aiConfigured } from '@/lib/ai/model';
import { loadAiSettings } from '@/lib/ai/settings';
import { STAGES, isStageKey } from '@/lib/stages/definitions';

/**
 * Admin → AI automation: the switches, and what the queue has been doing.
 * The model's connection (ANTHROPIC_API_KEY) is an environment variable; this
 * only reports whether it is set.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive)
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const out = await withUser(session, async (c) => {
      const settings = await loadAiSettings(c);
      const stats = await optionalRows<{ kind: string; status: string; n: number }>(
        c,
        'the automation queue',
        `select kind, status, count(*)::int as n from public.ai_jobs
          where created_at > now() - interval '7 days' group by kind, status`
      );
      const recent = await optionalRows<Record<string, unknown>>(
        c,
        'recent automation jobs',
        `select j.id::text as id, j.kind, j.status, j.entity_id, j.attempts, j.error, j.result, j.created_at, j.finished_at,
                p.code as project_code
           from public.ai_jobs j left join public.projects p on p.id = j.project_id
          order by j.created_at desc limit 30`
      );
      const pending = await optionalRows<{ n: number }>(
        c,
        'pending suggestions',
        `select count(*)::int as n from public.ai_suggestions where status = 'pending'`
      );
      return {
        ready: settings.ready,
        configured: aiConfigured(),
        settings,
        stages: STAGES.filter((s) => s !== 'complete'),
        stats,
        recent,
        pendingSuggestions: pending[0]?.n ?? 0,
      };
    });
    return NextResponse.json(out);
  } catch (e) {
    return dbErrorResponse(e, 'Loading the AI settings');
  }
}

export async function PUT(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive)
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };
  for (const [key, col] of [
    ['documentReading', 'ai_document_reading'],
    ['autoApply', 'ai_auto_apply'],
    ['replyDrafts', 'ai_reply_drafts'],
    ['replyAutoSend', 'ai_reply_auto_send'],
    ['briefings', 'ai_briefings'],
  ] as const) {
    if (typeof body[key] === 'boolean') set(col, body[key]);
  }
  if (body.confidenceThreshold !== undefined) {
    const n = Number(body.confidenceThreshold);
    if (!Number.isFinite(n) || n < 0.5 || n > 1) {
      return NextResponse.json(
        { error: 'The confidence threshold must be between 0.5 and 1.' },
        { status: 400 }
      );
    }
    set('ai_confidence_threshold', Math.round(n * 100) / 100);
  }
  if (Array.isArray(body.autoAdvanceStages)) {
    const stages = [
      ...new Set(
        body.autoAdvanceStages.map(String).filter((s) => isStageKey(s) && s !== 'complete')
      ),
    ];
    set('ai_auto_advance_stages', stages);
  }
  if (body.briefingHour !== undefined) {
    const h = Math.round(Number(body.briefingHour));
    if (!Number.isInteger(h) || h < 0 || h > 23)
      return NextResponse.json({ error: 'The briefing hour is 0–23.' }, { status: 400 });
    set('briefing_hour', h);
  }
  if (sets.length === 0) return NextResponse.json({ error: 'nothing to save' }, { status: 400 });

  try {
    const res = await withUser(session, (c) =>
      optionalQuery(
        c,
        'the AI settings',
        `update public.app_settings set ${sets.join(', ')} where id`,
        params
      )
    );
    if (!res.available) {
      return NextResponse.json(
        { error: 'The AI settings need migration 004800 — Admin → Database → Apply.' },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return dbErrorResponse(e, 'Saving the AI settings');
  }
}
