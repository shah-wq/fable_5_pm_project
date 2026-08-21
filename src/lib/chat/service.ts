import type { PoolClient } from 'pg';
import { withUser, type SessionIdentity } from '../db';
import { optionalRows } from '../db-optional';
import { STAGE_LABELS, type StageKey } from '../stages/definitions';

/**
 * The project chat's data layer.
 *
 * One thread per project (spec §1). Everything below runs under the caller's own
 * session claims, so the row-level policies from migration 002900 decide what a
 * PM, a customer or a dealer can see — this file adds no access checks of its
 * own, because a second set would be a second thing to keep in step.
 *
 * Two details that are deliberate and easy to get wrong:
 *
 *  - Sender names are resolved at read time, from profiles for staff and from
 *    clients for the customer. Nothing is copied into the message row. That is
 *    what makes §7's anonymisation work: redact the client and the whole thread
 *    reads 'Redacted' without any message being touched.
 *
 *  - read_at is only ever selected for staff. §3: the PM sees whether the
 *    customer read their message; the customer must not see the reverse, because
 *    "read 4 hours ago" with no reply is worse than no receipt at all. That is a
 *    presentation rule rather than a privacy boundary — the row is theirs and
 *    RLS lets them have it — so it is enforced by which columns this file asks
 *    for, and named here so the next reader does not "fix" it.
 */

export type SenderRole = 'customer' | 'staff' | 'system';

export interface ChatAttachment {
  id: string;
  title: string;
  mime: string | null;
  bytes: number | null;
}

export interface ChatMessage {
  id: string;
  senderRole: SenderRole;
  /** Resolved now, never stored: 'Casey Chen', 'Maria Martinez', or null. */
  senderName: string | null;
  body: string;
  stageRef: StageKey | null;
  stageLabel: string | null;
  isInternal: boolean;
  /** Staff only — null for the customer's own view. */
  readAt: string | null;
  editedAt: string | null;
  createdAt: string;
  attachments: ChatAttachment[];
  /** True when this message was written by the person reading it. */
  mine: boolean;
}

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : String(v ?? '');
const isoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : iso(v);

/** How many recent messages a thread loads before paging back (§8). */
export const PAGE_SIZE = 50;

/**
 * Is the chat schema present?
 *
 * Every read below degrades to an empty list when 002900 has not been pasted
 * yet, which is right for a panel and wrong for a page: an inbox that says "no
 * conversations yet" over a database with no project_messages table is telling
 * the reader something false. So the surfaces ask this once and say what to run
 * instead — and the composer refuses rather than offering to send a message that
 * would fail.
 *
 * Called on its own, before any other query on the same client: optionalRows
 * must not overlap with itself (see db-optional.ts).
 */
export async function chatReady(client: PoolClient): Promise<boolean> {
  // count(*) over a limited subquery, so exactly one row comes back whether or
  // not anybody has written a message — an empty thread table is ready, a
  // missing one is not. Naming the columns this module depends on also catches a
  // half-applied 002900 (42703 rather than 42P01).
  const rows = await optionalRows<{ n: string }>(
    client,
    'the project chat (public.project_messages)',
    `select count(*) as n from (
       select m.id, m.sender_role, m.is_internal, m.stage_ref, m.read_at, m.edited_at
       from public.project_messages m limit 1
     ) probe`
  );
  return rows.length > 0;
}

/** The file to paste when chatReady() says no. Named in one place. */
export const CHAT_MIGRATION_FILE = 'db/dist/20260803002900-project-chat.sql';

interface Row {
  id: string;
  sender_role: SenderRole;
  sender_name: string | null;
  sender_user_id: string | null;
  body: string;
  stage_ref: string | null;
  is_internal: boolean;
  read_at: unknown;
  edited_at: unknown;
  created_at: unknown;
}

/**
 * The thread, newest last (reading order).
 *
 * `internal` picks which channel: the customer tab shows customer-visible
 * messages, the internal tab shows staff notes. They are separate queries
 * because they are separate channels — §6's "two tabs, not one toggle" is a
 * data-layer decision before it is a UI one.
 */
export async function loadThread(
  client: PoolClient,
  projectId: string,
  opts: {
    viewerId: string;
    staff: boolean;
    channel?: 'customer' | 'internal';
    before?: string | null;
    limit?: number;
    search?: string | null;
  }
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? PAGE_SIZE));
  const params: unknown[] = [projectId];
  const where: string[] = ['m.project_id = $1'];

  if (opts.channel === 'internal') {
    if (!opts.staff) return { messages: [], hasMore: false };
    where.push('m.is_internal');
  } else {
    where.push('not m.is_internal');
  }
  if (opts.before) {
    params.push(opts.before);
    where.push(`m.created_at < $${params.length}`);
  }
  if (opts.search) {
    params.push(`%${opts.search}%`);
    where.push(`m.body ilike $${params.length}`);
  }
  params.push(limit + 1);

  const rows = await optionalRows<Row>(
    client,
    'the project chat (public.project_messages)',
    `select m.id, m.sender_role, m.sender_user_id, m.body, m.stage_ref::text as stage_ref,
            m.is_internal, m.edited_at, m.created_at,
            ${opts.staff ? 'm.read_at' : 'null as read_at'},
            case
              when m.sender_role = 'staff' then coalesce(pr.full_name, pr.email)
              when m.sender_role = 'customer'
                then nullif(btrim(coalesce(cl.first_name, '') || ' ' || coalesce(cl.last_name, '')), '')
              else null
            end as sender_name
     from public.project_messages m
     left join public.profiles pr on pr.id = m.sender_user_id
     left join public.projects p on p.id = m.project_id
     left join public.clients cl on cl.id = p.client_id
     where ${where.join(' and ')}
     order by m.created_at desc
     limit $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const attachments = await loadAttachments(client, page.map((r) => r.id));
  // A customer cannot read public.profiles, so the join above gives them a
  // thread of anonymous replies. §2 requires the opposite — they must always
  // know who wrote — so the staff names come through a definer function for
  // this one project. Staff already have them from the join.
  // Only when there is something to name. If row-level security gave this reader
  // no messages — someone else's project — there is nothing to resolve, and
  // asking anyway would turn a correctly empty thread into an error page.
  const names =
    opts.staff || page.length === 0
      ? new Map<string, string>()
      : await loadParticipants(client, projectId);

  // Reversed: the query pages backwards from the newest, the reader wants oldest
  // first within the page.
  return {
    hasMore,
    messages: page
      .slice()
      .reverse()
      .map((r) => ({
        id: r.id,
        senderRole: r.sender_role,
        senderName:
          r.sender_name ??
          (r.sender_role === 'staff' && r.sender_user_id
            ? (names.get(r.sender_user_id) ?? null)
            : null),
        body: r.body,
        stageRef: (r.stage_ref as StageKey | null) ?? null,
        stageLabel: r.stage_ref ? (STAGE_LABELS[r.stage_ref as StageKey] ?? r.stage_ref) : null,
        isInternal: r.is_internal === true,
        readAt: isoOrNull(r.read_at),
        editedAt: isoOrNull(r.edited_at),
        createdAt: iso(r.created_at),
        attachments: attachments.get(r.id) ?? [],
        mine: r.sender_user_id !== null && r.sender_user_id === opts.viewerId,
      })),
  };
}

/** Staff display names for one project's thread — see chat_participants(). */
async function loadParticipants(
  client: PoolClient,
  projectId: string
): Promise<Map<string, string>> {
  const rows = await optionalRows<{ user_id: string; display_name: string | null }>(
    client,
    'chat participant names (public.chat_participants)',
    `select user_id, display_name from public.chat_participants($1)`,
    [projectId]
  );
  return new Map(rows.filter((r) => r.display_name).map((r) => [r.user_id, r.display_name!]));
}

async function loadAttachments(
  client: PoolClient,
  messageIds: string[]
): Promise<Map<string, ChatAttachment[]>> {
  const byMessage = new Map<string, ChatAttachment[]>();
  if (messageIds.length === 0) return byMessage;

  const rows = await optionalRows<{
    message_id: string;
    id: string;
    title: string | null;
    mime_type: string | null;
    size_bytes: string | null;
  }>(
    client,
    'chat attachments (public.message_attachments)',
    `select a.message_id, d.id, d.title, d.mime_type, d.size_bytes
     from public.message_attachments a
     join public.documents d on d.id = a.document_id
     where a.message_id = any($1)
     order by d.created_at`,
    [messageIds]
  );

  for (const r of rows) {
    const list = byMessage.get(r.message_id) ?? [];
    list.push({
      id: r.id,
      title: r.title ?? 'attachment',
      mime: r.mime_type,
      bytes: r.size_bytes === null ? null : Number(r.size_bytes),
    });
    byMessage.set(r.message_id, list);
  }
  return byMessage;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Post a message. The database decides whether the caller is the PM or the
 * homeowner and refuses anyone else, so there is no role argument here — the
 * only thing the app says is what channel it meant.
 */
export async function postMessage(
  client: PoolClient,
  projectId: string,
  body: string,
  opts: { internal?: boolean; stageRef?: string | null } = {}
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `select public.post_project_message($1, $2, $3, $4) as id`,
    [projectId, body, opts.internal ?? false, opts.stageRef ?? null]
  );
  return rows[0].id;
}

export async function editMessage(
  client: PoolClient,
  messageId: string,
  body: string
): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>(
    `select public.edit_project_message($1, $2) as ok`,
    [messageId, body]
  );
  return rows[0]?.ok === true;
}

/** Marks the *other* party's messages read. Safe to call on every thread open. */
export async function markRead(client: PoolClient, projectId: string): Promise<number> {
  const rows = await optionalRows<{ n: number }>(
    client,
    'chat read receipts (public.mark_thread_read)',
    `select public.mark_thread_read($1) as n`,
    [projectId]
  );
  return Number(rows[0]?.n ?? 0);
}

/** A system line — stage moves, PM handovers, appointment confirmations (§3). */
export async function postSystemMessage(
  client: PoolClient,
  projectId: string,
  body: string,
  dedupe = true
): Promise<string | null> {
  const rows = await optionalRows<{ id: string | null }>(
    client,
    'chat system messages (public.post_system_message)',
    `select public.post_system_message($1, $2, $3) as id`,
    [projectId, body, dedupe]
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Badges and the inbox
// ---------------------------------------------------------------------------

export interface ThreadSummary {
  projectId: string;
  unread: number;
  messages: number;
  lastMessageAt: string | null;
  lastCustomerAt: string | null;
  lastStaffAt: string | null;
  flagged: boolean;
  flagNote: string | null;
}

/**
 * Unread counts for many projects at once (§1: "A PM should never have to open a
 * project to discover a customer wrote three days ago"). One query for the whole
 * pipeline board, not one per card.
 */
export async function loadSummaries(
  client: PoolClient,
  projectIds?: string[]
): Promise<Map<string, ThreadSummary>> {
  const scoped = projectIds && projectIds.length > 0;
  const rows = await optionalRows<{
    project_id: string;
    unread: string;
    messages: string;
    last_message_at: unknown;
    last_customer_at: unknown;
    last_staff_at: unknown;
    flagged: boolean;
    flag_note: string | null;
  }>(
    client,
    'chat summaries (public.project_chat_summary)',
    `select * from public.project_chat_summary
     ${scoped ? 'where project_id = any($1)' : 'where messages > 0 or flagged'}`,
    scoped ? [projectIds] : []
  );

  return new Map(
    rows.map((r) => [
      r.project_id,
      {
        projectId: r.project_id,
        unread: Number(r.unread ?? 0),
        messages: Number(r.messages ?? 0),
        lastMessageAt: isoOrNull(r.last_message_at),
        lastCustomerAt: isoOrNull(r.last_customer_at),
        lastStaffAt: isoOrNull(r.last_staff_at),
        flagged: r.flagged === true,
        flagNote: r.flag_note,
      },
    ])
  );
}

export interface InboxRow extends ThreadSummary {
  projectName: string;
  projectCode: string;
  stage: StageKey;
  status: string;
  customerName: string | null;
  pmName: string | null;
  pmId: string | null;
  /** The last customer-visible line, for the preview. */
  preview: string | null;
  previewFrom: SenderRole | null;
  /** Hours since the oldest unanswered customer message, or null. */
  waitingHours: number | null;
}

export type InboxFilter = 'all' | 'unread' | 'flagged' | 'waiting';

/**
 * The global inbox (§1): every conversation across the PM's projects, unread
 * first then newest. "This is how a PM starts their morning."
 */
export async function loadInbox(
  client: PoolClient,
  opts: { filter?: InboxFilter; search?: string | null; mine?: string | null } = {}
): Promise<InboxRow[]> {
  const params: unknown[] = [];
  const where: string[] = ['(s.messages > 0 or s.flagged)'];

  if (opts.filter === 'unread') where.push('s.unread > 0');
  if (opts.filter === 'flagged') where.push('s.flagged');
  // §5: "unanswered over 24 h" — a customer message with no staff reply since.
  if (opts.filter === 'waiting') {
    where.push(`s.last_customer_at is not null
                and (s.last_staff_at is null or s.last_staff_at < s.last_customer_at)
                and s.last_customer_at < now() - interval '24 hours'`);
  }
  if (opts.mine) {
    params.push(opts.mine);
    where.push(`p.assigned_pm = $${params.length}`);
  }
  if (opts.search) {
    params.push(`%${opts.search}%`);
    const i = params.length;
    // Search across all conversations from the global inbox (§3), and across the
    // project and customer names, because that is how a PM actually looks for a
    // thread: by whose it is.
    where.push(`(p.name ilike $${i} or p.code ilike $${i}
                 or cl.first_name ilike $${i} or cl.last_name ilike $${i}
                 or exists (select 1 from public.project_messages mm
                            where mm.project_id = p.id and not mm.is_internal
                              and mm.body ilike $${i}))`);
  }

  return (
    await optionalRows<{
      project_id: string; unread: string; messages: string;
      last_message_at: unknown; last_customer_at: unknown; last_staff_at: unknown;
      flagged: boolean; flag_note: string | null;
      name: string; code: string; stage: string; status: string;
      customer_name: string | null; pm_name: string | null; pm_id: string | null;
      preview: string | null; preview_from: SenderRole | null;
      waiting_hours: string | null;
    }>(
      client,
      'the chat inbox (public.project_chat_summary)',
      `select s.*, p.name, p.code, p.stage::text as stage, p.status::text as status,
              p.assigned_pm as pm_id,
              coalesce(pm.full_name, pm.email) as pm_name,
              nullif(btrim(coalesce(cl.first_name, '') || ' ' || coalesce(cl.last_name, '')), '')
                as customer_name,
              last.body as preview, last.sender_role as preview_from,
              case when s.last_customer_at is not null
                        and (s.last_staff_at is null or s.last_staff_at < s.last_customer_at)
                   then extract(epoch from (now() - s.last_customer_at)) / 3600.0 end as waiting_hours
       from public.project_chat_summary s
       join public.projects p on p.id = s.project_id
       left join public.profiles pm on pm.id = p.assigned_pm
       left join public.clients cl on cl.id = p.client_id
       left join lateral (
         select m.body, m.sender_role from public.project_messages m
         where m.project_id = s.project_id and not m.is_internal
         order by m.created_at desc limit 1
       ) last on true
       where ${where.join(' and ')}
       order by (s.unread > 0) desc, s.flagged desc, s.last_message_at desc nulls last
       limit 300`,
      params
    )
  ).map((r) => ({
    projectId: r.project_id,
    unread: Number(r.unread ?? 0),
    messages: Number(r.messages ?? 0),
    lastMessageAt: isoOrNull(r.last_message_at),
    lastCustomerAt: isoOrNull(r.last_customer_at),
    lastStaffAt: isoOrNull(r.last_staff_at),
    flagged: r.flagged === true,
    flagNote: r.flag_note,
    projectName: r.name,
    projectCode: r.code,
    stage: r.stage as StageKey,
    status: r.status,
    customerName: r.customer_name,
    pmName: r.pm_name,
    pmId: r.pm_id,
    preview: r.preview,
    previewFrom: r.preview_from,
    waitingHours: r.waiting_hours === null ? null : Math.round(Number(r.waiting_hours)),
  }));
}

// ---------------------------------------------------------------------------
// The needs-reply flag and canned replies (§5)
// ---------------------------------------------------------------------------

export async function setFlag(
  client: PoolClient,
  projectId: string,
  flagged: boolean,
  viewerId: string,
  note?: string | null
): Promise<void> {
  if (flagged) {
    await client.query(
      `insert into public.project_chat_flags (project_id, flagged_by, note)
       values ($1, $2, $3)
       on conflict (project_id) do update
         set flagged_at = now(), flagged_by = excluded.flagged_by, note = excluded.note`,
      [projectId, viewerId, note ?? null]
    );
  } else {
    await client.query(`delete from public.project_chat_flags where project_id = $1`, [projectId]);
  }
}

export interface CannedReply {
  id: string;
  title: string;
  body: string;
}

export async function loadCannedReplies(client: PoolClient): Promise<CannedReply[]> {
  return optionalRows<CannedReply>(
    client,
    'canned replies (public.canned_replies)',
    `select id, title, body from public.canned_replies
     where is_active order by sort_order, title`
  );
}

// ---------------------------------------------------------------------------
// The context strip (§5)
// ---------------------------------------------------------------------------

export interface ChatContext {
  projectId: string;
  projectName: string;
  projectCode: string;
  address: string | null;
  stage: StageKey;
  stageLabel: string;
  status: string;
  daysInStage: number;
  customerName: string | null;
  customerEmail: string | null;
  pmName: string | null;
  pmId: string | null;
  /** Outstanding customer actions — what the PM asked for and has not received. */
  openAsks: string[];
  replyPromise: string;
  hasPortalAccess: boolean;
}

/**
 * Everything above the composer: "current stage, days in stage, next milestone
 * and any outstanding customer action, so the PM answers without switching
 * tabs" (§5).
 */
export async function loadContext(
  client: PoolClient,
  projectId: string
): Promise<ChatContext | null> {
  const { rows } = await client.query(
    `select p.id, p.name, p.code, p.address, p.stage::text as stage, p.status::text as status,
            coalesce((select max(e.changed_at) from public.project_stage_events e
                      where e.project_id = p.id), p.created_at) as stage_since,
            nullif(btrim(coalesce(cl.first_name, '') || ' ' || coalesce(cl.last_name, '')), '')
              as customer_name,
            cl.email as customer_email,
            cl.user_id is not null as has_portal,
            p.assigned_pm as pm_id,
            coalesce(pm.full_name, pm.email) as pm_name
     from public.projects p
     left join public.clients cl on cl.id = p.client_id
     left join public.profiles pm on pm.id = p.assigned_pm
     where p.id = $1`,
    [projectId]
  );
  const r = rows[0];
  if (!r) return null;

  const asks = await optionalRows<{ label: string }>(
    client,
    'outstanding customer actions (public.customer_asks)',
    `select label from public.customer_asks
     where project_id = $1 and fulfilled_at is null and cancelled_at is null
     order by created_at`,
    [projectId]
  );
  // Same reason as the message senders: a customer cannot read profiles, so the
  // PM's name at the top of their thread comes from the definer function the
  // mobile module added for 'call my project manager'.
  let pmName: string | null = r.pm_name ?? null;
  if (!pmName) {
    const contact = await optionalRows<{ pm_name: string | null }>(
      client,
      "the project manager's name (public.project_contact)",
      `select pm_name from public.project_contact($1)`,
      [projectId]
    );
    pmName = contact[0]?.pm_name ?? null;
  }

  const settings = await optionalRows<{ chat_reply_promise: string | null }>(
    client,
    'the chat reply promise (app_settings.chat_reply_promise)',
    `select chat_reply_promise from public.app_settings where id`
  );

  const stage = r.stage as StageKey;
  return {
    projectId: r.id,
    projectName: r.name,
    projectCode: r.code,
    address: r.address,
    stage,
    stageLabel: STAGE_LABELS[stage] ?? r.stage,
    status: r.status,
    daysInStage: Math.max(
      0,
      Math.floor((Date.now() - new Date(iso(r.stage_since)).getTime()) / 86_400_000)
    ),
    customerName: r.customer_name,
    customerEmail: r.customer_email,
    pmName,
    pmId: r.pm_id,
    openAsks: asks.map((a) => a.label),
    replyPromise:
      settings[0]?.chat_reply_promise ?? 'We usually reply within one business day.',
    hasPortalAccess: r.has_portal === true,
  };
}

// ---------------------------------------------------------------------------
// Session-level convenience
// ---------------------------------------------------------------------------

/** The customer's own project id — they have exactly one thread per project. */
export async function customerProjectIds(session: SessionIdentity): Promise<string[]> {
  return withUser(session, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `select p.id from public.projects p
       where p.client_id in (select app.current_client_ids())
       order by p.created_at desc`
    );
    return rows.map((r) => r.id);
  });
}
