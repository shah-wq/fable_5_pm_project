import webpush from 'web-push';
import type { PoolClient } from 'pg';
import { optionalRows } from '../db-optional';
import { sendEmail } from '../email';
import { pushConfigured } from '../push/send';
import { siteUrl } from '../site';
import { emailFor, render, type NotifyContext, type Rendered } from './catalogue';

/**
 * Delivering what the database raised (migration 004700), and raising the
 * time-based notifications the database cannot see coming.
 *
 * Both run from the scheduled endpoint (/api/push/reminders). Both are safe to
 * run twice: delivery claims rows before sending, and every timed rule raises
 * with a dedupe key.
 */

interface Claimed {
  id: string;
  kind: string;
  audience: NotifyContext['audience'];
  in_app: boolean;
  email: boolean;
  push: boolean;
  user_id: string | null;
  recipient_email: string | null;
  recipient_name: string | null;
  email_opt_out: boolean;
  project_id: string | null;
  deal_id: string | null;
  client_id: string | null;
  payload: Record<string, unknown>;
}

interface ProjectCtx {
  id: string;
  code: string;
  name: string;
  address: string | null;
  stage: string;
  customer_name: string | null;
  pm_name: string | null;
}

async function projectContexts(client: PoolClient, ids: string[]): Promise<Map<string, ProjectCtx>> {
  if (ids.length === 0) return new Map();
  const { rows } = await client.query<ProjectCtx>(
    `select p.id, p.code, p.name, p.address, p.stage::text as stage,
            nullif(btrim(concat_ws(' ', cl.first_name, cl.last_name)), '') as customer_name,
            coalesce(pm.full_name, pm.email) as pm_name
       from public.projects p
       left join public.clients cl on cl.id = p.client_id
       left join public.profiles pm on pm.id = p.assigned_pm
      where p.id = any($1)`,
    [ids]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

export function contextFor(row: Claimed, project: ProjectCtx | undefined, companyName: string | null): NotifyContext {
  return {
    audience: row.audience,
    projectId: project?.id ?? row.project_id,
    projectCode: project?.code ?? null,
    projectName: project?.name ?? null,
    customerName: project?.customer_name ?? null,
    address: project?.address ?? null,
    stage: project?.stage ?? null,
    pmName: project?.pm_name ?? null,
    companyName,
  };
}

async function pushTo(client: PoolClient, userId: string, r: Rendered, kind: string): Promise<boolean> {
  if (!pushConfigured()) return false;
  const { rows } = await client.query<{ endpoint: string; p256dh: string; auth: string }>(
    'select endpoint, p256dh, auth from public.push_targets_for_user($1)',
    [userId]
  );
  let sent = false;
  for (const d of rows) {
    try {
      await webpush.sendNotification(
        { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
        JSON.stringify({ title: r.title, body: r.body, url: r.url, category: kind, tag: `${kind}:${r.url}` }),
        { TTL: 60 * 60 * 24 }
      );
      sent = true;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await client.query('select public.retire_push_endpoint($1)', [d.endpoint]).catch(() => undefined);
      }
    }
  }
  return sent;
}

/**
 * Send everything that is due. Email goes to the recipient's address unless a
 * homeowner has opted out; push goes to their registered devices when the rule
 * says so. Each row is marked delivered whatever happened, with the error kept
 * on it, so a bad address is visible and never retried forever.
 */
export async function deliverNotifications(client: PoolClient): Promise<{ delivered: number; emailed: number; pushed: number }> {
  const rows = await optionalRows<Claimed>(client, 'the notification queue', 'select * from public.claim_notifications(200)');
  if (rows.length === 0) return { delivered: 0, emailed: 0, pushed: 0 };

  const projects = await projectContexts(client, [...new Set(rows.map((r) => r.project_id).filter((v): v is string => Boolean(v)))]);
  const settings = await optionalRows<{ company_name: string | null }>(client, 'the company name', 'select company_name from public.app_settings where id');
  const companyName = settings[0]?.company_name ?? null;
  const origin = siteUrl();

  let emailed = 0;
  let pushed = 0;
  for (const row of rows) {
    const ctx = contextFor(row, row.project_id ? projects.get(row.project_id) : undefined, companyName);
    const rendered = render(row.kind, row.payload, ctx);
    let didEmail = false;
    let didPush = false;
    let error: string | null = null;
    try {
      if (row.email && row.recipient_email && !(row.audience === 'customer' && row.email_opt_out)) {
        const mail = emailFor(rendered, ctx, row.recipient_name, origin);
        await sendEmail({ to: row.recipient_email, ...mail });
        didEmail = true;
        emailed += 1;
      }
    } catch (e) {
      error = `email: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
    }
    try {
      if (row.push && row.user_id) {
        didPush = await pushTo(client, row.user_id, rendered, row.kind);
        if (didPush) pushed += 1;
      }
    } catch (e) {
      error = [error, `push: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)].filter(Boolean).join('; ');
    }
    await client
      .query('select public.notification_delivered($1, $2, $3, $4)', [row.id, didEmail, didPush, error])
      .catch(() => undefined);
  }
  return { delivered: rows.length, emailed, pushed };
}

// ---------------------------------------------------------------------------
// Time-based rules
// ---------------------------------------------------------------------------

async function raise(
  client: PoolClient,
  kind: string,
  userId: string,
  projectId: string | null,
  payload: Record<string, unknown>,
  dedupe: string
): Promise<boolean> {
  const rows = await optionalRows<{ id: string | null }>(
    client,
    'raising a notification',
    'select public.raise_notification($1, $2, $3, $4::jsonb, $5) as id',
    [kind, userId, projectId, JSON.stringify(payload), dedupe]
  );
  return Boolean(rows[0]?.id);
}

/** The PM of a project, else every admin: who a project's own notification goes to. */
async function projectStaff(client: PoolClient, projectId: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `select coalesce(p.assigned_pm, pr.id) as id
       from public.projects p
       left join public.profiles pr on p.assigned_pm is null and pr.role = 'admin' and pr.is_active and pr.deleted_at is null
      where p.id = $1`,
    [projectId]
  );
  return [...new Set(rows.map((r) => r.id).filter(Boolean))];
}

/**
 * Raise the notifications that depend on time passing: a stage past its
 * threshold, a permit about to expire, tomorrow's install not ready, a contact
 * or deal gone quiet. Deduped by the day or week, so each is said once.
 */
export async function runTimedRules(client: PoolClient): Promise<Record<string, number>> {
  const counts: Record<string, number> = { ageing: 0, permits: 0, readiness: 0, contacts: 0, deals: 0 };
  const settings = await optionalRows<{
    contact_stale_days: number;
    deal_stale_days: number;
    permit_expiry_warning_days: number;
  }>(client, 'the reminder settings', 'select contact_stale_days, deal_stale_days, permit_expiry_warning_days from public.app_settings where id');
  const s = settings[0] ?? { contact_stale_days: 7, deal_stale_days: 14, permit_expiry_warning_days: 14 };
  const week = new Date().toISOString().slice(0, 10).replace(/-\d\d$/, '') + ':w' + Math.floor(new Date().getDate() / 7);

  // 1. Ageing: active, in its stage past the stage's threshold. Once per project per stage.
  const ageing = await optionalRows<{ id: string; stage: string; days: number; threshold: number }>(
    client,
    'ageing projects',
    `select p.id, p.stage::text as stage,
            (current_date - coalesce((select max(e.changed_at) from public.project_stage_events e where e.project_id = p.id), p.created_at)::date) as days,
            t.attention_days as threshold
       from public.projects p
       join public.stage_thresholds t on t.stage = p.stage
      where p.status = 'active'
        and (current_date - coalesce((select max(e.changed_at) from public.project_stage_events e where e.project_id = p.id), p.created_at)::date) > t.attention_days`
  );
  for (const row of ageing) {
    for (const uid of await projectStaff(client, row.id)) {
      if (await raise(client, 'stage_ageing', uid, row.id, { stage: row.stage, days: row.days, threshold: row.threshold }, `ageing:${row.id}:${row.stage}`)) counts.ageing++;
    }
  }

  // 2. Permits expiring within the warning window, on projects not yet installed.
  const permits = await optionalRows<{ id: string; expires: string; permit_number: string | null; days: number }>(
    client,
    'expiring permits',
    `select p.id, s.permit_expiry_date::text as expires, s.permit_number, (s.permit_expiry_date - current_date) as days
       from public.stage3_permit s join public.projects p on p.id = s.project_id
      where p.status = 'active' and p.stage in ('permits', 'procurement', 'install')
        and s.permit_expiry_date between current_date and current_date + $1::int`,
    [s.permit_expiry_warning_days]
  );
  for (const row of permits) {
    for (const uid of await projectStaff(client, row.id)) {
      if (await raise(client, 'permit_expiring', uid, row.id, { expires: row.expires, permit_number: row.permit_number, days: row.days }, `permit_expiring:${row.id}:${row.expires}`)) counts.permits++;
    }
  }

  // 3. Tomorrow's installs: permit approved? materials delivered? change order signed?
  const installs = await optionalRows<{ id: string; date: string; permit_status: string | null; material_status: string | null; open_co: number }>(
    client,
    "tomorrow's installs",
    `select p.id, s.install_scheduled_date::text as date, s3.permit_status, s4.material_status,
            (select count(*) from public.change_orders co where co.project_id = p.id and co.status = 'pending_approval')::int as open_co
       from public.stage5_install s join public.projects p on p.id = s.project_id
       left join public.stage3_permit s3 on s3.project_id = p.id
       left join public.stage4_procurement s4 on s4.project_id = p.id
      where p.status = 'active' and s.install_scheduled_date = current_date + 1
        and coalesce(s.install_status, '') not in ('completed', 'on_hold')`
  );
  for (const row of installs) {
    const problems = [
      row.permit_status !== 'approved' ? 'permit not approved' : null,
      row.material_status !== 'delivered' ? 'materials not delivered' : null,
      row.open_co > 0 ? 'a change order is unsigned' : null,
    ].filter(Boolean);
    if (problems.length === 0) continue;
    for (const uid of await projectStaff(client, row.id)) {
      if (await raise(client, 'install_readiness', uid, row.id, { date: row.date, problems: problems.join(', ') + '.' }, `readiness:${row.id}:${row.date}`)) counts.readiness++;
    }
  }

  // 4. Contacts going quiet: booked or quoted, not contacted for N days. Once a week each.
  const contacts = await optionalRows<{ id: string; owner_id: string; name: string; stage: string; days: number }>(
    client,
    'quiet contacts',
    `select c.id, c.owner_id, concat_ws(' ', c.first_name, c.last_name) as name, c.contact_stage as stage,
            (current_date - coalesce(c.last_contacted_at, c.contact_stage_at, c.created_at)::date) as days
       from public.clients c
      where c.owner_id is not null and not coalesce(c.is_archived, false)
        and c.contact_stage in ('created', 'appointment_scheduled', 'appointment_rescheduled', 'no_show', 'quoted', 'financing_approved')
        and coalesce(c.last_contacted_at, c.contact_stage_at, c.created_at) < now() - make_interval(days => $1::int)`,
    [s.contact_stale_days]
  );
  for (const row of contacts) {
    if (await raise(client, 'contact_stale', row.owner_id, null, { name: row.name, stage: row.stage, days: row.days, client_id: row.id }, `contact_stale:${row.id}:${week}`)) counts.contacts++;
  }

  // 5. Deals going quiet: open, unchanged for N days. Once a week each.
  const deals = await optionalRows<{ id: string; owner_id: string; customer: string; stage: string; days: number }>(
    client,
    'quiet deals',
    `select d.id, d.owner_id, concat_ws(' ', d.customer_first, d.customer_last) as customer, d.stage,
            (current_date - d.updated_at::date) as days
       from public.deals d
      where d.owner_id is not null and d.stage not in ('won', 'lost')
        and d.updated_at < now() - make_interval(days => $1::int)`,
    [s.deal_stale_days]
  );
  for (const row of deals) {
    if (await raise(client, 'deal_stale', row.owner_id, null, { customer: row.customer, stage: row.stage, days: row.days, deal_id: row.id }, `deal_stale:${row.id}:${week}`)) counts.deals++;
  }

  return counts;
}
