import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import {
  ask,
  assistantConfigured,
  describeApiError,
  type AssistantEvent,
  type ChatTurn,
} from '@/lib/assistant/run';
import { suggestionsFor } from '@/lib/assistant/suggestions';

export const dynamic = 'force-dynamic';
// A question can take several lookups; give it room on Vercel.
export const maxDuration = 120;

const ROLES = ['admin', 'ops', 'finance', 'sales', 'designer', 'dealer'];

/**
 * Per person, per server instance: 40 questions an hour. Not a billing
 * control — a guard against a stuck client or a pasted loop.
 */
const asked = new Map<string, number[]>();
function allow(userId: string): boolean {
  const now = Date.now();
  const recent = (asked.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 40) {
    asked.set(userId, recent);
    return false;
  }
  recent.push(now);
  asked.set(userId, recent);
  return true;
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!ROLES.includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return NextResponse.json({
    configured: assistantConfigured(),
    suggestions: suggestionsFor(session.role),
  });
}

/**
 * Ask a question. The body is the conversation so far, as plain text turns,
 * ending with the question. The answer streams back as newline-delimited JSON:
 * {"type":"status",…} while tools run, then one {"type":"answer",…} or
 * {"type":"error",…}.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!ROLES.includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!assistantConfigured()) {
    return NextResponse.json(
      { error: 'The assistant is not connected yet — an admin sets ANTHROPIC_API_KEY.' },
      { status: 503 }
    );
  }

  const body = (await request.json().catch(() => null)) as { messages?: unknown } | null;
  const raw = Array.isArray(body?.messages) ? body.messages : [];
  const history: ChatTurn[] = raw
    .filter(
      (m): m is ChatTurn =>
        !!m &&
        typeof m === 'object' &&
        ((m as ChatTurn).role === 'user' || (m as ChatTurn).role === 'assistant') &&
        typeof (m as ChatTurn).content === 'string' &&
        (m as ChatTurn).content.trim() !== ''
    )
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
  // The API wants the conversation to open with the person, and to end with them.
  while (history.length && history[0].role !== 'user') history.shift();
  const question = history.at(-1);
  if (!question || question.role !== 'user') {
    return NextResponse.json({ error: 'Ask a question.' }, { status: 400 });
  }
  if (!allow(session.userId)) {
    return NextResponse.json(
      { error: 'That is a lot of questions in an hour — try again a little later.' },
      { status: 429 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AssistantEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
      const started = Date.now();
      try {
        const result = await ask({ ...session, name: session.fullName }, history, send);
        // Who asked what, for the same reason every other action is logged.
        // The answer is not stored; the question and what was looked up are.
        await withUser(session, (c) =>
          c.query('select public.log_audit_event($1, $2, $3, $4, $5)', [
            'assistant.asked',
            'assistant',
            null,
            null,
            JSON.stringify({
              question: question.content.slice(0, 500),
              tools: result.tools,
              ms: Date.now() - started,
              tokens: result.usage,
            }),
          ])
        ).catch((e) => console.error('[assistant] could not log the question:', e?.message ?? e));
      } catch (e) {
        const d = describeApiError(e);
        console.error('[assistant] failed:', e instanceof Error ? e.message : e);
        send({ type: 'error', error: d.error });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}
