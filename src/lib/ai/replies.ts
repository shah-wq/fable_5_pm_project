import type { PoolClient } from 'pg';
import { logAuditEvent } from '../audit';
import { notifyNewChatMessage } from '../chat/notify';
import { loadThread, postMessage } from '../chat/service';
import { withUser, type SessionIdentity } from '../db';
import { optionalRows } from '../db-optional';
import { STAGE_LABELS, isStageKey, type StageKey } from '../stages/definitions';
import { evaluateStage } from '../stages/requirements';
import { loadBundles } from '../stages/service';
import { complete, parseJsonObject } from './model';
import type { AiSettings } from './settings';

/**
 * Reply drafts.
 *
 * When a homeowner writes, the model drafts the project manager's answer from
 * the project's own facts — stage, dates on the forms, what is outstanding —
 * and says how sure it is and whether a person is needed. The draft sits above
 * the PM's composer with one button to send it, one to edit, one to dismiss.
 *
 * With the admin's auto-send switch on, a confident draft that needs no person
 * is sent as the PM, signed as automatic, and the PM sees it in the thread. The
 * default is off: a wrong answer to "when is my install?" costs more than a
 * slow right one.
 */

export const AUTO_SIGNATURE =
  '— Sent automatically by the SolarFlow assistant from your project’s records. Your project manager will follow up if anything needs a person.';

const SYSTEM = [
  'You draft replies for the project manager of a residential solar installer, answering a homeowner who wrote in the project chat. You are given the project’s current facts and the recent conversation. Write the reply the project manager would send.',
  '',
  'Rules:',
  '- Answer only from the facts given. If the facts do not answer the question — a date that is not set, a price, a change to the contract, a complaint, anything about money, cancellation or a dispute — do not guess: set needs_human true, and write a short, warm holding reply that says the project manager will come back to them.',
  '- Never promise a date, an outcome or a timeline the facts do not contain. "Not scheduled yet" is a fine answer.',
  '- Plain, friendly, brief: two to five sentences, first person plural ("we"), address the homeowner by first name, no markdown, no subject line, no sign-off name.',
  '- Do not mention internal notes, costs, other customers, or that you are an AI.',
  '- confidence is your honest probability, 0 to 1, that this reply is correct and appropriate to send as written.',
  '',
  'Answer with one JSON object and nothing else:',
  '{"reply": "...", "confidence": 0.0, "needs_human": false, "reason": "why a person is needed, or empty"}',
].join('\n');

interface Answer {
  reply?: unknown;
  confidence?: unknown;
  needs_human?: unknown;
  reason?: unknown;
}

export interface DraftResult {
  drafted: boolean;
  needsHuman: boolean;
  confidence: number;
  sentAuto: boolean;
  skipped?: string;
}

const iso = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null;

/** Draft (and maybe send) the answer to one homeowner message. */
export async function draftReply(
  client: PoolClient,
  identity: SessionIdentity,
  messageId: string,
  settings: AiSettings
): Promise<DraftResult> {
  const { rows } = await client.query(
    `select m.id, m.project_id, m.body, m.sender_role, m.is_internal, m.created_at,
            p.code, p.name, p.address, p.stage::text as stage, p.status::text as status, p.assigned_pm,
            p.target_install_date, p.system_size_kw,
            coalesce((select max(e.changed_at) from public.project_stage_events e where e.project_id = p.id), p.created_at) as stage_since,
            cl.first_name as customer_first, cl.user_id as customer_user,
            coalesce(pm.full_name, pm.email) as pm_name, pm.email as pm_email, pm.role::text as pm_role, pm.is_active as pm_active,
            s1.survey_status, s1.survey_scheduled_date, s1.survey_completed_date,
            s2.design_status, s2.design_received_date, s2.customer_approval_date,
            s3.permit_status, s3.permit_applied_date, s3.permit_received_date, s3.ica_status, s3.hoa_status,
            s4.material_status, s4.expected_delivery_date, s4.material_delivered_date,
            s5.install_status, s5.install_scheduled_date, s5.install_completed_date,
            s6.inspection_status, s6.inspection_scheduled_date, s6.pto_status, s6.pto_received_date, s6.energization_status,
            (select string_agg(a.label, '; ') from public.customer_asks a
              where a.project_id = p.id and a.fulfilled_at is null and a.cancelled_at is null) as open_asks,
            (select h.reason from public.project_holds h where h.project_id = p.id and h.resume_date is null order by h.created_at desc limit 1) as hold_reason
       from public.project_messages m
       join public.projects p on p.id = m.project_id
       left join public.clients cl on cl.id = p.client_id
       left join public.profiles pm on pm.id = p.assigned_pm
       left join public.stage1_survey s1 on s1.project_id = p.id
       left join public.stage2_design s2 on s2.project_id = p.id
       left join public.stage3_permit s3 on s3.project_id = p.id
       left join public.stage4_procurement s4 on s4.project_id = p.id
       left join public.stage5_install s5 on s5.project_id = p.id
       left join public.stage6_inspection s6 on s6.project_id = p.id
      where m.id = $1`,
    [messageId]
  );
  const m = rows[0];
  if (!m) return skip('the message no longer exists');
  if (m.sender_role !== 'customer' || m.is_internal) return skip('not a homeowner message');
  // Already answered by a person? Then there is nothing to draft.
  const later = await client.query<{ n: string }>(
    `select count(*) as n from public.project_messages x
      where x.project_id = $1 and x.sender_role = 'staff' and not x.is_internal and x.created_at > $2`,
    [m.project_id, m.created_at]
  );
  if (Number(later.rows[0]?.n ?? 0) > 0) return skip('a person already replied');

  const stage = isStageKey(m.stage) ? (m.stage as StageKey) : 'survey';
  const bundles = await loadBundles(client, [m.project_id]);
  const bundle = bundles.get(m.project_id);
  const missing = bundle && m.status === 'active' ? evaluateStage(stage, bundle) : [];
  const thread = await loadThread(client, m.project_id, {
    viewerId: identity.userId,
    staff: true,
    channel: 'customer',
    limit: 12,
  });
  const promise = await optionalRows<{ chat_reply_promise: string | null }>(
    client,
    'the chat reply promise',
    'select chat_reply_promise from public.app_settings where id'
  );

  const facts = {
    project: {
      code: m.code,
      address: m.address,
      system_kw: m.system_size_kw ? Number(m.system_size_kw) : null,
    },
    stage: STAGE_LABELS[stage],
    status: m.status,
    days_in_stage: Math.max(
      0,
      Math.floor((Date.now() - new Date(m.stage_since).getTime()) / 86_400_000)
    ),
    on_hold_reason: m.hold_reason ?? null,
    survey: {
      status: m.survey_status,
      scheduled: iso(m.survey_scheduled_date),
      completed: iso(m.survey_completed_date),
    },
    design: {
      status: m.design_status,
      received: iso(m.design_received_date),
      homeowner_approved: iso(m.customer_approval_date),
    },
    permits: {
      building_permit: m.permit_status,
      applied: iso(m.permit_applied_date),
      approved: iso(m.permit_received_date),
      utility_interconnection: m.ica_status,
      hoa: m.hoa_status,
    },
    equipment: {
      status: m.material_status,
      expected_delivery: iso(m.expected_delivery_date),
      delivered: iso(m.material_delivered_date),
    },
    installation: {
      status: m.install_status,
      scheduled: iso(m.install_scheduled_date),
      completed: iso(m.install_completed_date),
      target_date: iso(m.target_install_date),
    },
    inspection_and_pto: {
      inspection: m.inspection_status,
      inspection_scheduled: iso(m.inspection_scheduled_date),
      permission_to_operate: m.pto_status,
      pto_received: iso(m.pto_received_date),
      system: m.energization_status,
    },
    outstanding_from_homeowner: m.open_asks ?? null,
    what_we_still_need_before_next_stage: missing,
    project_manager: m.pm_name ?? null,
    company: settings.companyName ?? 'our team',
    reply_promise: promise[0]?.chat_reply_promise ?? 'We usually reply within one business day.',
    today: new Date().toISOString().slice(0, 10),
  };
  const conversation = thread.messages
    .filter((x) => x.senderRole !== 'system')
    .map(
      (x) =>
        `${x.senderRole === 'customer' ? (m.customer_first ?? 'Homeowner') : 'Project manager'} (${x.createdAt.slice(0, 10)}): ${x.body}`
    )
    .join('\n');

  const ask = [
    `Homeowner's first name: ${m.customer_first ?? 'unknown'}.`,
    `Project facts:\n${JSON.stringify(facts)}`,
    '',
    `Recent conversation, oldest first:\n${conversation || '(none)'}`,
    '',
    `The message to answer is the homeowner's last one: "${String(m.body).slice(0, 2000)}"`,
  ].join('\n');

  const { text, usage } = await complete(SYSTEM, ask, { maxTokens: 1500 });
  const answer = parseJsonObject<Answer>(text);
  const reply = typeof answer?.reply === 'string' ? answer.reply.trim().slice(0, 4000) : '';
  if (!answer || !reply) throw new Error('the model did not answer with a reply');
  const needsHuman = answer.needs_human === true;
  const confidence = Math.min(1, Math.max(0, Number(answer.confidence) || 0));
  const reason = typeof answer.reason === 'string' ? answer.reason.slice(0, 300) : null;

  const inserted = await client.query<{ id: string }>(
    `insert into public.ai_reply_drafts (project_id, message_id, body, confidence, needs_human, reason)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (message_id) do update set body = excluded.body, confidence = excluded.confidence,
       needs_human = excluded.needs_human, reason = excluded.reason
     returning id::text as id`,
    [m.project_id, m.id, reply, confidence, needsHuman, reason]
  );
  const draftId = inserted.rows[0]?.id;

  // Autopilot: only when allowed, only when confident, only when a real PM
  // exists to send as — and the homeowner can read it.
  let sentAuto = false;
  const pmIdentity: SessionIdentity | null =
    m.assigned_pm && m.pm_active && (m.pm_role === 'admin' || m.pm_role === 'ops')
      ? { userId: m.assigned_pm, email: m.pm_email, role: m.pm_role }
      : null;
  if (
    settings.replyAutoSend &&
    !needsHuman &&
    confidence >= settings.confidenceThreshold &&
    pmIdentity &&
    m.customer_user
  ) {
    const body = `${reply}\n\n${AUTO_SIGNATURE}`;
    const sentId = await withUser(pmIdentity, (c) => postMessage(c, m.project_id, body));
    await notifyNewChatMessage(pmIdentity, {
      projectId: m.project_id,
      messageId: sentId,
      body,
      internal: false,
      fromStaff: true,
    }).catch(() => undefined);
    await client.query(
      `update public.ai_reply_drafts set status = 'sent_auto', sent_message_id = $2, decided_at = now() where id = $1`,
      [draftId, sentId]
    );
    sentAuto = true;
  }

  await logAuditEvent(identity, {
    action: sentAuto ? 'ai.reply_sent_auto' : 'ai.reply_drafted',
    entityType: 'project_messages',
    entityId: m.id,
    projectId: m.project_id,
    context: { confidence, needs_human: needsHuman, reason, tokens: usage },
    kind: 'system',
  }).catch(() => undefined);

  return { drafted: true, needsHuman, confidence, sentAuto };

  function skip(reason: string): DraftResult {
    return { drafted: false, needsHuman: false, confidence: 0, sentAuto: false, skipped: reason };
  }
}

// ---------------------------------------------------------------------------
// The PM's side
// ---------------------------------------------------------------------------

export interface ReplyDraft {
  id: string;
  projectId: string;
  messageId: string;
  messageBody: string;
  messageAt: string;
  body: string;
  confidence: number;
  needsHuman: boolean;
  reason: string | null;
  status: string;
  createdAt: string;
}

/** Drafts still waiting on a project (or everywhere this person may see). */
export async function loadDrafts(client: PoolClient, projectId?: string): Promise<ReplyDraft[]> {
  const rows = await optionalRows<{
    id: string;
    project_id: string;
    message_id: string;
    message_body: string;
    message_at: unknown;
    body: string;
    confidence: string;
    needs_human: boolean;
    reason: string | null;
    status: string;
    created_at: unknown;
  }>(
    client,
    'reply drafts (public.ai_reply_drafts)',
    `select d.id::text as id, d.project_id, d.message_id, m.body as message_body, m.created_at as message_at,
            d.body, d.confidence, d.needs_human, d.reason, d.status, d.created_at
       from public.ai_reply_drafts d
       join public.project_messages m on m.id = d.message_id
      where d.status = 'draft' ${projectId ? 'and d.project_id = $1' : ''}
        -- A draft is stale once a person has replied since the message it answers.
        and not exists (select 1 from public.project_messages x
                         where x.project_id = d.project_id and x.sender_role = 'staff' and not x.is_internal
                           and x.created_at > m.created_at)
      order by d.created_at desc limit 50`,
    projectId ? [projectId] : []
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    messageId: r.message_id,
    messageBody: r.message_body,
    messageAt: r.message_at instanceof Date ? r.message_at.toISOString() : String(r.message_at),
    body: r.body,
    confidence: Number(r.confidence),
    needsHuman: r.needs_human,
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

/**
 * Send a draft (as edited) or dismiss it. Sending goes through the same
 * database function as the composer, as the person pressing the button.
 */
export async function decideDraft(
  session: SessionIdentity,
  id: string,
  action: 'send' | 'dismiss',
  body?: string
): Promise<{ ok: true; messageId: string | null } | { ok: false; status: number; error: string }> {
  const result = await withUser(session, async (client) => {
    const { rows } = await client.query(
      `select id, project_id, body, status from public.ai_reply_drafts where id = $1`,
      [id]
    );
    const d = rows[0];
    if (!d) return { ok: false as const, status: 404, error: 'No such draft.' };
    if (d.status !== 'draft')
      return { ok: false as const, status: 409, error: `Already ${d.status}.` };
    if (action === 'dismiss') {
      await client.query(
        `update public.ai_reply_drafts set status = 'dismissed', decided_by = $2, decided_at = now() where id = $1`,
        [id, session.userId]
      );
      return { ok: true as const, messageId: null, projectId: d.project_id as string, text: null };
    }
    const text = (body ?? d.body).trim().slice(0, 8000);
    if (!text) return { ok: false as const, status: 400, error: 'Write something first.' };
    const messageId = await postMessage(client, d.project_id, text);
    await client.query(
      `update public.ai_reply_drafts set status = 'sent', sent_message_id = $2, decided_by = $3, decided_at = now() where id = $1`,
      [id, messageId, session.userId]
    );
    return { ok: true as const, messageId, projectId: d.project_id as string, text };
  });
  if (result.ok && result.messageId && result.text) {
    await notifyNewChatMessage(session, {
      projectId: result.projectId,
      messageId: result.messageId,
      body: result.text,
      internal: false,
      fromStaff: true,
    }).catch(() => undefined);
  }
  return result.ok ? { ok: true, messageId: result.messageId } : result;
}
