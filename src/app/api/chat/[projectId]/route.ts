import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  loadThread,
  markRead,
  postMessage,
  type ChatMessage,
} from '@/lib/chat/service';
import { notifyNewChatMessage } from '@/lib/chat/notify';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
];

/**
 * The thread endpoint, for both parties.
 *
 * There is no role branching on who may do what: the database's
 * post_project_message() decides that from the caller's own claims, and refuses
 * a dealer, a designer, or a customer reaching for someone else's project. What
 * this route adds is the file handling and the notification, neither of which
 * belongs in SQL.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { projectId } = await params;
  if (!UUID_RE.test(projectId)) {
    return NextResponse.json({ error: 'bad project id' }, { status: 400 });
  }

  const url = new URL(request.url);
  const staff = ['admin', 'ops'].includes(session.role);
  // Only staff have an internal channel; asking for one as a customer gets the
  // customer channel rather than an error, because it is not their mistake.
  const channel = staff && url.searchParams.get('channel') === 'internal' ? 'internal' : 'customer';
  const since = url.searchParams.get('since');
  const before = url.searchParams.get('before');

  try {
    const result = await withUser(session, (client) =>
      loadThread(client, projectId, {
        viewerId: session.userId,
        staff,
        channel,
        before,
        // Polling asks for everything after a timestamp; the page asks for a page.
        limit: since ? 200 : undefined,
      })
    );

    const messages = since
      ? result.messages.filter((m: ChatMessage) => m.createdAt > since)
      : result.messages;

    return NextResponse.json({ messages, hasMore: since ? false : result.hasMore });
  } catch (e) {
    return dbErrorResponse(e, 'Loading the conversation');
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!session.isActive) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const { projectId } = await params;
  if (!UUID_RE.test(projectId)) {
    return NextResponse.json({ error: 'bad project id' }, { status: 400 });
  }

  const staff = ['admin', 'ops'].includes(session.role);
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'expected a form' }, { status: 400 });

  const body = String(form.get('body') ?? '').trim();
  // A customer can ask for internal all day; they still do not get it. The
  // database refuses it as well — this is the polite half of that answer.
  const internal = staff && form.get('internal') === '1';
  const stageRef = String(form.get('stageRef') ?? '').trim() || null;
  if (!body) return NextResponse.json({ error: 'write a message first' }, { status: 400 });
  if (body.length > 8000) {
    return NextResponse.json({ error: 'that message is too long' }, { status: 400 });
  }

  const files = form
    .getAll('files')
    .filter((f): f is File => f instanceof File && f.size > 0)
    .slice(0, 5);
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT) {
      return NextResponse.json({ error: `${file.name} is larger than 10 MB` }, { status: 400 });
    }
    if (!ALLOWED_MIME.includes(file.type || '')) {
      return NextResponse.json(
        { error: `${file.name} is not a photo or a PDF` },
        { status: 400 }
      );
    }
  }
  const payloads = await Promise.all(
    files.map(async (f) => ({
      name: f.name.slice(0, 200),
      mime: f.type,
      bytes: Buffer.from(await f.arrayBuffer()),
    }))
  );

  try {
    const posted = await withUser(session, async (client) => {
      const id = await postMessage(client, projectId, body, { internal, stageRef });

      for (const file of payloads) {
        await client.query(`select public.record_chat_attachment($1, $2, $3, $4)`, [
          id,
          file.name,
          file.mime,
          file.bytes,
        ]);
      }

      // Read the message back so the client replaces its optimistic copy with
      // the real thing — resolved sender name, real timestamp, attachment ids.
      const thread = await loadThread(client, projectId, {
        viewerId: session.userId,
        staff,
        channel: internal ? 'internal' : 'customer',
        limit: 1,
      });
      return thread.messages.at(-1) ?? null;
    });

    if (!posted) {
      return NextResponse.json({ error: 'the message was not saved' }, { status: 500 });
    }

    // Notifying is a separate transaction on purpose: a push service or an SMTP
    // host being down must never lose a message that is already written.
    await notifyNewChatMessage(session, {
      projectId,
      messageId: posted.id,
      body,
      internal,
      fromStaff: staff,
    }).catch(() => undefined);

    return NextResponse.json({ message: posted }, { status: 201 });
  } catch (e) {
    return dbErrorResponse(e, 'Sending your message');
  }
}

/** Marking the other party's messages read — its own route so it can be a beacon. */
export async function PUT(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { projectId } = await params;
  if (!UUID_RE.test(projectId)) {
    return NextResponse.json({ error: 'bad project id' }, { status: 400 });
  }
  const marked = await withUser(session, (client) => markRead(client, projectId)).catch(() => 0);
  return NextResponse.json({ marked });
}
