import type { PoolClient } from 'pg';
import { optionalRows } from '../db-optional';
import type { SessionIdentity } from '../db';
import { STAGES, stageIndex, type StageKey } from '../stages/definitions';

/**
 * The customer portal's data layer. Two rules run through all of it:
 *
 *  1. Plain language — every status is mapped through customer_phrases; a raw
 *     dropdown value never reaches this surface (spec §9).
 *  2. Nothing internal — free-text notes, day counters, costs, margins, vendor
 *     and crew identities are not selected at all, so they cannot leak through
 *     a template change later.
 *
 * Rows are scoped by RLS on the client link, exactly as the dealer portal is.
 */

export type PhraseMap = Map<string, string>;

/** Tidy fallback so an unmapped new dropdown value never renders as blank. */
export function tidy(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  return String(value).replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}

export async function loadPhrases(client: PoolClient): Promise<PhraseMap> {
  const { rows } = await client.query<{ domain: string; value: string; phrase: string }>(
    `select domain, value, phrase from public.customer_phrases where is_active`
  );
  return new Map(rows.map((r) => [`${r.domain}:${r.value}`, r.phrase]));
}

export function phrase(map: PhraseMap, domain: string, value: unknown, fallback = ''): string {
  if (value === null || value === undefined || value === '') return fallback;
  return map.get(`${domain}:${String(value)}`) ?? tidy(value);
}

export interface CustomerTrack {
  label: string;
  status: string;
  /**
   * What the dot beside this row looks like on the redesigned home screen
   * (§3): a check when it is finished, a filled dot for the one being worked on,
   * a hollow dot for the rest. Derived from the raw status before it is turned
   * into customer wording, because the wording is deliberately vague and a shape
   * cannot be.
   */
  state: 'done' | 'active' | 'pending' | 'na';
  /** Submitted / applied / requested date, when the customer should see it. */
  submitted?: string | null;
  /** Approved / received / completed date. */
  completed?: string | null;
}

export interface CustomerStage {
  key: StageKey;
  label: string;
  state: 'done' | 'current' | 'upcoming';
  explainer: string;
  /** The date this stage was reached, for the completed-stage line. */
  reachedOn: string | null;
  tracks: CustomerTrack[];
}

export interface CustomerPayment {
  label: string;
  status: string;
  amount: number | null;
  receivedOn: string | null;
}

export interface CustomerProject {
  id: string;
  code: string;
  customerName: string;
  address: string | null;
  systemSummary: string;
  statusHeadline: string;
  estimate: string | null;
  stageKey: StageKey;
  stageLabel: string;
  whatHappensNext: string;
  onHold: { reason: string; expectedResume: string | null } | null;
  cancelled: { date: string | null } | null;
  isComplete: boolean;
  stages: CustomerStage[];
  /** Days since the project entered its current stage. Powers 'Day 3 of ~10'. */
  daysInStage: number | null;
  /** Days since the project was created, for the one quiet line at the bottom. */
  daysSinceStart: number | null;
  /** Per-stage typical durations and ageing thresholds, from admin settings. */
  pace: Record<string, { typical: { min: number; max: number } | null; attention: number | null }>;
  /** How many documents this customer can see, for the Documents tile. */
  documentCount: number;
  /** 'We reply within one business day' — the promise from the chat settings. */
  replyPromise: string | null;
  updates: Array<{ date: string; text: string }>;
  needed: string[];
  /** Specific things the PM has asked this customer for, still outstanding. */
  asks: Array<{ id: string; kind: string; label: string; detail: string | null }>;
  /** System information, for the Project tab's equipment card. */
  system: {
    sizeKw: number | null;
    systemType: string | null;
    modules: number | null;
    moduleType: string | null;
    inverters: number | null;
    inverterType: string | null;
    batteries: number | null;
    batteryType: string | null;
  };
  team: {
    pmName: string | null;
    pmPhone: string | null;
    pmEmail: string | null;
    repName: string | null;
    repEmail: string | null;
  };
  contractTotal: number | null;
  adders: Array<{ name: string; amount: number }>;
  revisedTotal: number | null;
  payments: CustomerPayment[];
  finance: { company: string | null; milestones: CustomerPayment[] };
  documents: Array<{ id: string; title: string; category: string; date: string; isPhoto: boolean }>;
  openRequests: Array<{ id: string; kind: string; created: string; message: string | null; reply: string | null; status: string }>;
  monitoring: string | null;
}

/**
 * The shape of the dot beside a milestone row (§3).
 *
 * Read off the raw status value, not the customer-facing phrase: the phrases are
 * configurable per company, and a shape derived from words somebody can edit in
 * an admin panel would silently stop matching.
 */
const DONE_STATES = new Set([
  'approved', 'received', 'completed', 'complete', 'passed', 'paid',
  'delivered', 'energized', 'signed', 'issued', 'done',
]);
const ACTIVE_STATES = new Set([
  'applied', 'submitted', 'scheduled', 'ordered', 'requested', 'initiated',
  'in_progress', 'in_review', 'pending', 'booked', 'resubmitted', 'revision',
]);
const NA_STATES = new Set(['na', 'not_required', 'not_applicable', 'waived', 'none']);

export function trackState(raw: unknown, completed?: unknown): CustomerTrack['state'] {
  const value = String(raw ?? '').toLowerCase();
  if (NA_STATES.has(value)) return 'na';
  // A date beats a status: if the thing happened, it happened, whatever the
  // dropdown still says.
  if (completed !== undefined && completed !== null && completed !== '') return 'done';
  if (DONE_STATES.has(value)) return 'done';
  if (ACTIVE_STATES.has(value)) return 'active';
  return 'pending';
}

/** Whole days between two moments, or null when either is missing. */
function daysBetween(from: unknown, to: Date = new Date()): number | null {
  if (from === null || from === undefined || from === '') return null;
  const start = from instanceof Date ? from : new Date(String(from));
  if (Number.isNaN(start.getTime())) return null;
  const ms = to.getTime() - start.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/** ISO yyyy-mm-dd. pg hands back Date objects for date columns, and
 *  String(Date) would render 'Sun Jul 05' — never show that to a customer. */
const asDate = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
};

/** Every project this customer can see (a second property is supported). */
export async function loadCustomerProjects(
  client: PoolClient,
  session: SessionIdentity
): Promise<Array<{ id: string; label: string }>> {
  void session;
  const { rows } = await client.query<{ id: string; address: string | null; code: string }>(
    `select p.id, p.address, p.code from public.projects p order by p.created_at desc`
  );
  return rows.map((r) => ({ id: r.id, label: r.address || r.code }));
}

export async function loadCustomerProject(
  client: PoolClient,
  projectId: string | null
): Promise<CustomerProject | null> {
  const phrases = await loadPhrases(client);

  const projectSql = `
    select p.id, p.code, p.name, p.address, p.stage, p.status, p.contract_value,
           p.created_at,
           p.system_size_kw, p.module_quantity, p.battery_quantity, p.inverter_quantity,
           p.customer_estimate,
           st.name as system_type, mt.name as module_type,
           it.name as inverter_type, bt.name as battery_type,
           fc.name as financing_company,
           sr.name as rep_name, sr.email as rep_email
    from public.projects p
    left join public.system_types st on st.id = p.system_type_id
    left join public.module_types mt on mt.id = p.module_type_id
    left join public.inverter_types it on it.id = p.inverter_type_id
    left join public.battery_types bt on bt.id = p.battery_type_id
    left join public.financing_companies fc on fc.id = p.financing_company_id
    left join public.sales_reps sr on sr.id = p.sales_rep_id
    ${projectId ? 'where p.id = $1' : ''}
    order by p.created_at desc
    limit 1`;
  const { rows } = await client.query(projectSql, projectId ? [projectId] : []);
  const p = rows[0];
  if (!p) return null;

  // The PM's name and number. profiles is self-or-admin under RLS, so this
  // comes through a definer function that returns those three fields for one
  // project the caller can already see — otherwise 'call my project manager',
  // the most-used control on the app's Home screen, has nothing to show.
  const contact = (
    await optionalRows<{ pm_name: string | null; pm_phone: string | null; pm_email: string | null }>(
      client,
      'project contact',
      `select * from public.project_contact($1)`,
      [p.id]
    )
  )[0] ?? { pm_name: null, pm_phone: null, pm_email: null };

  const one = async (table: string, columns: string) =>
    (
      await client.query(`select ${columns} from public."${table}" where project_id = $1`, [p.id])
    ).rows[0] ?? {};

  // Only customer-appropriate columns are selected — no *_notes, no day counts.
  const s1 = await one('stage1_survey',
    'survey_status, survey_completed_date, down_payment_status, down_payment_received_date, cash_m1_status, cash_m1_received_date');
  const s2 = await one('stage2_design',
    'design_status, design_received_date, stamps_status, stamps_received_date');
  const s3 = await one('stage3_permit',
    `permit_status, permit_applied_date, permit_received_date,
     ica_status, ica_applied_date, ica_received_date,
     hoa_status, hoa_applied_date, hoa_received_date,
     cash_m2_status, cash_m2_received_date`);
  const s4 = await one('stage4_procurement',
    'material_status, material_requested_date, material_delivered_date');
  const s5 = await one('stage5_install',
    'install_status, install_scheduled_date, install_completed_date, cash_m3_status, cash_m3_received_date');
  const s6 = await one('stage6_inspection',
    `inspection_status, inspection_completed_date, pto_status, pto_applied_date,
     pto_received_date, energization_status, energization_date`);
  const s7 = await one('stage7_complete', 'completion_status, completion_date');
  const fin = await one('finance_milestones',
    'm1_status, m1_submitted_date, m1_approved_date, m2_status, m2_submitted_date, m2_approved_date');

  const hold = (
    await client.query(
      `select reason, expected_resume_date from public.project_holds
       where project_id = $1 and resume_date is null
       order by hold_start_date desc limit 1`,
      [p.id]
    )
  ).rows[0];
  const cancel = (
    await client.query(
      `select cancellation_date from public.project_cancellation
       where project_id = $1 and reinstated_at is null limit 1`,
      [p.id]
    )
  ).rows[0];

  const adders = (
    await client.query<{ name: string; amount: string }>(
      `select name, amount from public.project_adders
       where project_id = $1 and approved order by created_at`,
      [p.id]
    )
  ).rows.map((a) => ({ name: a.name, amount: Number(a.amount) }));

  // What the PM has actually asked this person for. Fulfilled and withdrawn
  // asks drop out, so the card empties itself instead of nagging someone who
  // has already sent the photo.
  const asks = await optionalRows<{
    id: string; kind: string; label: string; detail: string | null;
  }>(
    client,
    'customer asks',
    `select id, kind, label, detail from public.customer_asks
     where project_id = $1 and fulfilled_at is null and cancelled_at is null
     order by created_at`,
    [p.id]
  );

  const docs = (
    await client.query(
      `select id, title, category, created_at, mime_type from public.documents
       where project_id = $1 and customer_visible
       order by created_at desc`,
      [p.id]
    )
  ).rows;

  const events = (
    await client.query(
      `select to_stage, changed_at from public.project_stage_events
       where project_id = $1 order by changed_at desc limit 30`,
      [p.id]
    )
  ).rows;

  // How long this project has been in the stage it is in. The same rule the
  // dashboard uses (002800's stage_since): the most recent stage event, or the
  // creation date for a project that has never moved.
  const stageSince = events[0]?.changed_at ?? p.created_at;

  // What this business considers normal for each stage, and when it calls a
  // stage overdue. Both arrive with migrations later than this page, so a
  // database that has not caught up simply shows no estimate rather than an
  // error — the customer loses one line, not their project.
  const pace = Object.fromEntries(
    (
      await optionalRows<{
        stage: string;
        attention_days: number | null;
        typical_min_days: number | null;
        typical_max_days: number | null;
      }>(
        client,
        'the stage pace settings (public.stage_thresholds)',
        `select stage::text as stage, attention_days, typical_min_days, typical_max_days
           from public.stage_thresholds`
      )
    ).map((r) => [
      r.stage,
      {
        attention: r.attention_days === null ? null : Number(r.attention_days),
        typical:
          r.typical_min_days === null || r.typical_max_days === null
            ? null
            : { min: Number(r.typical_min_days), max: Number(r.typical_max_days) },
      },
    ])
  );

  // The reply-time promise shown on the Ask tile — the same sentence the message
  // thread shows, so the two screens cannot disagree about it.
  const replyPromise =
    (
      await optionalRows<{ chat_reply_promise: string | null }>(
        client,
        'the chat reply promise (public.app_settings)',
        `select chat_reply_promise from public.app_settings where id`
      )
    )[0]?.chat_reply_promise ?? null;

  const requests = (
    await client.query(
      `select id, kind, created_at, message, pm_reply, status from public.customer_requests
       where project_id = $1 order by created_at desc limit 20`,
      [p.id]
    )
  ).rows;

  const stageKey = (STAGES as readonly string[]).includes(String(p.stage))
    ? (String(p.stage) as StageKey)
    : 'survey';
  const currentIndex = stageIndex(stageKey);
  const isComplete = p.status === 'complete';

  // When each stage was reached, for the 'completed with dates' tracker.
  const reached = new Map<string, string>();
  for (const e of [...events].reverse()) {
    if (!reached.has(String(e.to_stage))) reached.set(String(e.to_stage), asDate(e.changed_at)!);
  }

  const st = (domain: string, value: unknown, fallback = 'Not started yet') =>
    phrase(phrases, domain, value, fallback);

  /**
   * One track row, with the shape its dot takes.
   *
   * Built through a helper rather than written out per stage so that the state
   * is always derived from the same raw value the status text came from. Writing
   * them separately is how a row ends up saying 'Approved' beside a hollow dot.
   */
  const mk = (
    label: string,
    domain: string,
    raw: unknown,
    fallback: string,
    dates: { submitted?: unknown; completed?: unknown } = {}
  ): CustomerTrack => ({
    label,
    status: st(domain, raw, fallback),
    ...(dates.submitted === undefined ? {} : { submitted: asDate(dates.submitted) }),
    ...(dates.completed === undefined ? {} : { completed: asDate(dates.completed) }),
    state: trackState(raw, dates.completed),
  });

  const trackSets: Record<StageKey, CustomerTrack[]> = {
    survey: [
      mk('Survey visit', 'survey_status', s1.survey_status, 'Being scheduled',
         { completed: s1.survey_completed_date }),
      mk('Deposit', 'payment_status', s1.down_payment_status, 'Not yet due',
         { completed: s1.down_payment_received_date }),
    ],
    design: [
      mk('System design', 'design_status', s2.design_status, 'Not started yet',
         { completed: s2.design_received_date }),
      mk('Engineering stamp', 'stamps_status', s2.stamps_status, 'Not needed yet',
         { completed: s2.stamps_received_date }),
    ],
    permits: [
      mk('City permit', 'permit_status', s3.permit_status, 'Not submitted yet',
         { submitted: s3.permit_applied_date, completed: s3.permit_received_date }),
      mk('Utility approval', 'ica_status', s3.ica_status, 'Not submitted yet',
         { submitted: s3.ica_applied_date, completed: s3.ica_received_date }),
      mk('HOA approval', 'hoa_status', s3.hoa_status, 'Not required',
         { submitted: s3.hoa_applied_date, completed: s3.hoa_received_date }),
    ],
    procurement: [
      mk('Your equipment', 'material_status', s4.material_status, 'Not ordered yet',
         { submitted: s4.material_requested_date, completed: s4.material_delivered_date }),
    ],
    install: [
      mk('Installation', 'install_status', s5.install_status, 'Being scheduled',
         { submitted: s5.install_scheduled_date, completed: s5.install_completed_date }),
    ],
    inspection_pto: [
      mk('City inspection', 'inspection_status', s6.inspection_status, 'Not booked yet',
         { completed: s6.inspection_completed_date }),
      mk('Utility permission', 'pto_status', s6.pto_status, 'Not submitted yet',
         { submitted: s6.pto_applied_date, completed: s6.pto_received_date }),
      mk('System live', 'energization_status', s6.energization_status, 'Not yet',
         { completed: s6.energization_date }),
    ],
    complete: [
      mk('Project', 'completion_status', s7.completion_status, 'In progress',
         { completed: s7.completion_date }),
    ],
  };

  const stages: CustomerStage[] = STAGES.map((key, i) => ({
    key,
    label: phrase(phrases, 'stage', key, tidy(key)),
    state: isComplete || i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming',
    explainer: phrase(phrases, 'stage_explainer', key, ''),
    reachedOn: reached.get(key) ?? null,
    tracks: trackSets[key],
  }));

  // Headline: the single most important sentence on the page.
  const stageLabel = phrase(phrases, 'stage', stageKey, tidy(stageKey));
  let headline: string;
  if (p.status === 'cancelled') {
    headline = 'Your project has been cancelled. Please contact your project manager with any questions.';
  } else if (hold) {
    headline = `Your project is temporarily paused: ${String(hold.reason).toLowerCase()}.`;
  } else if (isComplete) {
    headline = 'Your system is on and producing.';
  } else if (stageKey === 'permits') {
    const permitStatus = st('permit_status', s3.permit_status, 'being prepared');
    headline = `Your permit application is ${permitStatus.toLowerCase()}.`;
  } else if (stageKey === 'install' && s5.install_scheduled_date) {
    headline = `Your installation is scheduled for ${asDate(s5.install_scheduled_date)}.`;
  } else if (stageKey === 'survey' && s1.survey_status === 'scheduled') {
    headline = 'Your site survey is booked.';
  } else {
    headline = `Your project is in ${stageLabel}.`;
  }

  // Anything needed from the customer, in their words.
  const needed: string[] = [];
  if (['requested', 'initiated'].includes(String(s1.down_payment_status))) {
    needed.push('Your deposit is requested — see Payments below.');
  }
  if (['requested', 'initiated'].includes(String(s3.cash_m2_status))
      || ['requested', 'initiated'].includes(String(s5.cash_m3_status))
      || ['requested', 'initiated'].includes(String(s1.cash_m1_status))) {
    needed.push('A milestone payment is requested — see Payments below.');
  }
  if (String(s3.hoa_status) === 'not_applied') {
    needed.push('If your home is in an HOA, we may need a copy of their approval form.');
  }
  for (const r of requests) {
    if (r.status === 'open' && r.kind === 'availability') {
      needed.push('We have your preferred dates and will confirm the appointment shortly.');
      break;
    }
  }
  // Anything the PM asked for directly goes at the top of the list: it is the
  // one item on this card that is genuinely blocking somebody.
  needed.unshift(...asks.map((a) => a.label));

  const contractTotal = p.contract_value === null ? null : Number(p.contract_value);
  const adderTotal = adders.reduce((sum, a) => sum + a.amount, 0);

  const equipment = [
    p.module_quantity ? `${p.module_quantity} panels` : null,
    p.battery_quantity ? `${p.battery_quantity} batter${p.battery_quantity === 1 ? 'y' : 'ies'}` : null,
  ].filter(Boolean).join(' + ');
  const systemSummary = [
    p.system_size_kw ? `${Number(p.system_size_kw)} kW` : null,
    equipment || null,
    p.system_type ? String(p.system_type) : null,
  ].filter(Boolean).join(' · ');

  return {
    id: p.id,
    code: p.code,
    customerName: p.name,
    address: p.address,
    systemSummary: systemSummary || 'Your system details are being finalised.',
    statusHeadline: headline,
    estimate: p.customer_estimate ?? null,
    stageKey,
    stageLabel,
    whatHappensNext: phrase(phrases, 'stage_next', stageKey, ''),
    onHold: hold
      ? { reason: String(hold.reason), expectedResume: asDate(hold.expected_resume_date) }
      : null,
    cancelled: cancel ? { date: asDate(cancel.cancellation_date) } : null,
    isComplete,
    stages,
    daysInStage: daysBetween(stageSince),
    daysSinceStart: daysBetween(p.created_at),
    pace,
    documentCount: docs.length,
    replyPromise,
    updates: events
      .map((e) => ({
        date: asDate(e.changed_at)!,
        text: `${phrase(phrases, 'stage', e.to_stage, tidy(e.to_stage))} started`,
      }))
      .slice(0, 12),
    needed,
    asks: asks.map((a) => ({
      id: a.id,
      kind: String(a.kind),
      label: a.label,
      detail: a.detail,
    })),
    system: {
      sizeKw: p.system_size_kw === null ? null : Number(p.system_size_kw),
      systemType: p.system_type ?? null,
      modules: p.module_quantity === null ? null : Number(p.module_quantity),
      moduleType: p.module_type ?? null,
      inverters: p.inverter_quantity === null ? null : Number(p.inverter_quantity),
      inverterType: p.inverter_type ?? null,
      batteries: p.battery_quantity === null ? null : Number(p.battery_quantity),
      batteryType: p.battery_type ?? null,
    },
    team: {
      pmName: contact.pm_name ?? null,
      pmPhone: contact.pm_phone ?? null,
      pmEmail: contact.pm_email ?? null,
      repName: p.rep_name ?? null,
      repEmail: p.rep_email ?? null,
    },
    contractTotal,
    adders,
    revisedTotal: contractTotal === null ? null : contractTotal + adderTotal,
    payments: [
      { label: 'Deposit', status: st('payment_status', s1.down_payment_status, 'Not yet due'),
        amount: null, receivedOn: asDate(s1.down_payment_received_date) },
      { label: 'Milestone 1', status: st('payment_status', s1.cash_m1_status, 'Not yet due'),
        amount: null, receivedOn: asDate(s1.cash_m1_received_date) },
      { label: 'Milestone 2', status: st('payment_status', s3.cash_m2_status, 'Not yet due'),
        amount: null, receivedOn: asDate(s3.cash_m2_received_date) },
      { label: 'Final payment', status: st('payment_status', s5.cash_m3_status, 'Not yet due'),
        amount: null, receivedOn: asDate(s5.cash_m3_received_date) },
    ].filter((m) => m.status !== 'Not applicable'),
    finance: {
      company: p.financing_company ?? null,
      milestones: [
        { label: 'First disbursement', status: st('finance_status', fin.m1_status, 'Not submitted yet'),
          amount: null, receivedOn: asDate(fin.m1_approved_date) },
        { label: 'Final disbursement', status: st('finance_status', fin.m2_status, 'Not submitted yet'),
          amount: null, receivedOn: asDate(fin.m2_approved_date) },
      ],
    },
    documents: docs.map((d) => ({
      id: d.id,
      title: d.title ?? tidy(d.category),
      category: String(d.category ?? ''),
      date: asDate(d.created_at)!,
      isPhoto: String(d.mime_type ?? '').startsWith('image/'),
    })),
    openRequests: requests.map((r) => ({
      id: r.id,
      kind: String(r.kind),
      created: asDate(r.created_at)!,
      message: r.message,
      reply: r.pm_reply,
      status: String(r.status),
    })),
    monitoring: null,
  };
}
