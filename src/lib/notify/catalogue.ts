import { STAGE_LABELS, isStageKey } from '../stages/definitions';

/**
 * The words for every notification kind in public.notification_rules.
 *
 * The database records that something happened (kind + payload); this file
 * turns it into a title, a line of body and the screen it is about, for the
 * in-app feed, the email and the push alike. One place, so the same event
 * reads the same everywhere and a wording change is one edit.
 *
 * `ctx` is the project as the recipient knows it, looked up at delivery time:
 * a homeowner sees "your project", a PM sees the code and the customer.
 */

export interface NotifyContext {
  audience: 'customer' | 'pm' | 'admin' | 'sales' | 'dealer' | 'user';
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  customerName: string | null;
  address: string | null;
  stage: string | null;
  pmName: string | null;
  companyName: string | null;
}

export interface Rendered {
  title: string;
  body: string;
  /** In-app path for the recipient's own surface. */
  url: string;
}

type Payload = Record<string, unknown>;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const stageName = (v: unknown): string => {
  const s = str(v);
  return isStageKey(s) ? STAGE_LABELS[s] : s.replace(/_/g, ' ');
};
const money = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '';
};
const date = (v: unknown): string => {
  const s = str(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(`${s}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
};
const on = (v: unknown): string => (date(v) ? ` on ${date(v)}` : '');

/** How staff refer to a project: "PRJ-1A2B (Jane Smith)". */
const ref = (c: NotifyContext): string =>
  [c.projectCode, c.customerName ? `(${c.customerName})` : null].filter(Boolean).join(' ') ||
  c.projectName ||
  'a project';

const staffUrl = (c: NotifyContext, suffix = '') =>
  c.projectId ? `/projects/${c.projectId}${suffix}` : '/pipeline';
const dealerUrl = (c: NotifyContext) => (c.projectId ? `/dealers/projects/${c.projectId}` : '/dealers/projects');
const portal = (hash?: string) => (hash ? `/portal/project#${hash}` : '/portal');

const CUSTOMER_STAGE_LINES: Record<string, string> = {
  survey: 'Next we visit your home to survey the roof and electrical panel.',
  design: 'Our engineers are now designing your system.',
  permits: 'We are applying for your building permit and utility approval.',
  procurement: 'Your equipment is being ordered.',
  install: 'Your installation is being scheduled.',
  inspection_pto: 'The city inspection and the utility’s permission to operate come next.',
  complete: 'Your project is complete.',
};

type Renderer = (p: Payload, c: NotifyContext) => Rendered;

export const CATALOGUE: Record<string, Renderer> = {
  // ---------------------------------------------------------------- homeowner
  project_created: (_p, c) => ({
    title: 'Your solar project has started',
    body: `Welcome${c.customerName ? `, ${c.customerName.split(' ')[0]}` : ''}. ${c.pmName ? `${c.pmName} is your project manager. ` : ''}${CUSTOMER_STAGE_LINES.survey}`,
    url: portal(),
  }),
  stage_advanced: (p, c) => ({
    title: `${stageName(p.stage)} has started`,
    body: CUSTOMER_STAGE_LINES[str(p.stage)] ?? `Your project has moved to ${stageName(p.stage)}.`,
    url: portal(str(p.stage) || undefined) || portal(),
  }),
  survey_scheduled: (p) => ({
    title: 'Your site survey is scheduled',
    body: `We will visit${on(p.date)} to look at your roof, attic and electrical panel. Please make sure we can reach them.`,
    url: portal('survey'),
  }),
  survey_completed: () => ({
    title: 'Site survey completed',
    body: 'Thank you for having us. The survey findings now go to design.',
    url: portal('survey'),
  }),
  design_ready: (p) => ({
    title: 'Your system design is ready',
    body: `${p.size_kw ? `A ${Number(p.size_kw)} kW system${p.modules ? ` with ${p.modules} panels` : ''}. ` : ''}Your project manager will walk you through it.`,
    url: portal('design'),
  }),
  permit_submitted: (p) => ({
    title: 'Building permit submitted',
    body: `We applied for your building permit${on(p.date)}. Permits typically take a few weeks; we will tell you the moment it is approved.`,
    url: portal('permits'),
  }),
  permit_approved: (p) => ({
    title: 'Your building permit is approved',
    body: `Approved${on(p.date)}${p.permit_number ? ` (permit ${p.permit_number})` : ''}. Installation can be scheduled once your equipment arrives.`,
    url: portal('permits'),
  }),
  ica_approved: (p) => ({
    title: 'Utility interconnection approved',
    body: `Your utility approved connecting your system to the grid${on(p.date)}.`,
    url: portal('permits'),
  }),
  hoa_approved: (p) => ({
    title: 'HOA approved',
    body: `Your homeowners’ association approved the installation${on(p.date)}.`,
    url: portal('permits'),
  }),
  material_ordered: (p) => ({
    title: 'Your equipment is ordered',
    body: `Panels, inverters and racking are on order${p.expected ? `, expected ${date(p.expected)}` : ''}.`,
    url: portal('procurement'),
  }),
  material_delivered: (p) => ({
    title: 'Your equipment has arrived',
    body: `Everything for your installation is here${on(p.date)}. Scheduling comes next.`,
    url: portal('procurement'),
  }),
  install_scheduled: (p) => ({
    title: 'Your installation is scheduled',
    body: `Our crew is booked${on(p.date)}. We will remind you two days before and the day before.`,
    url: portal('install'),
  }),
  install_completed: (p) => ({
    title: 'Your installation is complete',
    body: `The crew finished${on(p.date)}. The city inspection and the utility’s permission to operate come next; the system stays off until then.`,
    url: portal('install'),
  }),
  inspection_scheduled: (p) => ({
    title: p.again ? 'Your re-inspection is scheduled' : 'Your inspection is scheduled',
    body: `The inspector is booked${on(p.date)}. Someone over 18 needs to be home to let them in.`,
    url: portal('inspection_pto'),
  }),
  inspection_passed: (p) => ({
    title: 'Inspection passed',
    body: `Your installation passed inspection${on(p.date)}. We now ask the utility for permission to operate.`,
    url: portal('inspection_pto'),
  }),
  inspection_failed: () => ({
    title: 'A few corrections after inspection',
    body: 'The inspector asked for some items to be fixed. Our crew will take care of them and book the re-inspection; nothing is needed from you.',
    url: portal('inspection_pto'),
  }),
  pto_applied: (p) => ({
    title: 'Permission to operate requested',
    body: `We asked your utility for permission to operate${on(p.date)}. This is the last step before switch-on.`,
    url: portal('inspection_pto'),
  }),
  pto_received: (p) => ({
    title: 'Permission to operate granted',
    body: `Your utility granted permission to operate${on(p.date)}. Your system can be switched on.`,
    url: portal('inspection_pto'),
  }),
  system_energized: (p) => ({
    title: 'Your system is switched on',
    body: `Your solar system is live and producing${on(p.date)}. Congratulations, and thank you.`,
    url: portal(),
  }),
  project_complete: () => ({
    title: 'Your project is complete',
    body: 'Everything is done. Your documents and warranties are in the app, and we are here if you ever need us.',
    url: portal(),
  }),
  project_on_hold: (p) => ({
    title: 'Your project is temporarily paused',
    body: `${p.reason ? `Reason: ${p.reason}. ` : ''}Your project manager will tell you when it moves again.`,
    url: portal(),
  }),
  project_resumed: (p) => ({
    title: 'Your project is moving again',
    body: `We are back at ${stageName(p.stage)}.`,
    url: portal(),
  }),
  payment_requested: (p) => ({
    title: `Payment due: ${str(p.milestone)}`,
    body: `Your ${str(p.milestone).toLowerCase()} is now due. Your project manager will send the details if you have not received them.`,
    url: portal(),
  }),
  payment_received: (p) => ({
    title: `Payment received: ${str(p.milestone)}`,
    body: `Thank you — we received your ${str(p.milestone).toLowerCase()}.`,
    url: portal(),
  }),
  action_needed: (p) => ({
    title: 'Something is needed from you',
    body: `${str(p.label)}${p.detail ? ` — ${str(p.detail)}` : ''}`,
    url: '/portal/photos',
  }),
  contract_signed: () => ({
    title: 'Your contract is signed',
    body: 'Thank you. Your signed agreement is in your documents, and your project is under way.',
    url: '/portal/documents',
  }),
  change_order_confirmed: (p) => ({
    title: `Change order ${str(p.number)} confirmed`,
    body: `${str(p.reason)}${p.amount ? ` (${Number(p.amount) >= 0 ? '+' : ''}${money(p.amount)})` : ''}. The signed copy is in your documents.`,
    url: '/portal/documents',
  }),
  new_message: (p) => ({
    title: 'A message from your project manager',
    body: str(p.preview),
    url: '/portal/messages',
  }),

  // ---------------------------------------------------------------- PM
  project_assigned: (_p, c) => ({
    title: `Assigned to you: ${ref(c)}`,
    body: `${c.address ?? ''}${c.stage ? ` · ${stageName(c.stage)}` : ''}`.trim() || 'A project has been assigned to you.',
    url: staffUrl(c),
  }),
  customer_message: (p, c) => ({
    title: `${c.customerName ?? 'A customer'} wrote`,
    body: str(p.preview),
    url: staffUrl(c, '/chat'),
  }),
  customer_request: (p, c) => ({
    title: `${c.customerName ?? 'A customer'} sent a ${str(p.kind).replace('_', ' ')} request`,
    body: str(p.message) || `On ${ref(c)}.`,
    url: staffUrl(c),
  }),
  customer_uploaded: (p, c) => ({
    title: `${c.customerName ?? 'A customer'} uploaded a file`,
    body: `${str(p.title) || str(p.category) || 'A file'} on ${ref(c)}.`,
    url: staffUrl(c),
  }),
  stage_ageing: (p, c) => ({
    title: `Ageing: ${ref(c)}`,
    body: `${p.days} days in ${stageName(p.stage)} (threshold ${p.threshold}).${p.missing ? ` Missing: ${str(p.missing)}` : ''}`,
    url: staffUrl(c, `/stages/${str(p.stage)}`),
  }),
  permit_expiring: (p, c) => ({
    title: `Permit expires ${date(p.expires) || 'soon'}: ${ref(c)}`,
    body: `${p.permit_number ? `Permit ${p.permit_number} ` : 'The building permit '}expires in ${p.days} days and the project is at ${stageName(c.stage)}.`,
    url: staffUrl(c, '/stages/permits'),
  }),
  permit_revision: (p, c) => ({
    title: `${str(p.track)} sent back: ${ref(c)}`,
    body: `${str(p.status).replace('_', ' ')}${p.notes ? ` — ${str(p.notes).slice(0, 200)}` : ''}`,
    url: staffUrl(c, '/stages/permits'),
  }),
  inspection_failed_pm: (p, c) => ({
    title: `Inspection failed: ${ref(c)}`,
    body: str(p.notes) || 'Correction items are on the inspection form.',
    url: staffUrl(c, '/stages/inspection_pto'),
  }),
  install_readiness: (p, c) => ({
    title: `Install tomorrow is not ready: ${ref(c)}`,
    body: `Booked for ${date(p.date)}. ${str(p.problems)}`,
    url: staffUrl(c, '/stages/install'),
  }),
  esign_completed: (p, c) => ({
    title: `${p.purpose === 'change_order' ? 'Change order' : 'Contract'} signed by ${str(p.signer)}`,
    body: `${ref(c)}. The signed PDF is filed on the record.`,
    url: c.projectId ? staffUrl(c) : '/admin/people',
  }),
  esign_declined: (p, c) => ({
    title: `${p.purpose === 'change_order' ? 'Change order' : 'Contract'} declined by ${str(p.signer)}`,
    body: `${ref(c)}. Speak to them, then send a revised document.`,
    url: c.projectId ? staffUrl(c) : '/admin/people',
  }),
  esign_needs_attention: (p, c) => ({
    title: `Signed, but not applied: ${ref(c)}`,
    body: `${str(p.error)} Open the record and press Finish.`,
    url: c.projectId ? staffUrl(c) : '/admin/people',
  }),
  change_order_approved: (p, c) => ({
    title: `Change order ${str(p.number)} approved: ${ref(c)}`,
    body: `${str(p.reason)} · ${Number(p.amount) >= 0 ? '+' : ''}${money(p.amount)} on the contract value.`,
    url: staffUrl(c),
  }),
  low_rating: (p, c) => ({
    title: `${c.customerName ?? 'A customer'} rated ${stageName(p.stage)} ${str(p.score)}/5`,
    body: str(p.comment) || 'No comment left. A follow-up task is open.',
    url: '/tasks',
  }),
  ai_exception: (p, c) => ({
    title: `AI needs a decision: ${ref(c)}`,
    body: str(p.summary),
    url: '/exceptions',
  }),
  daily_briefing: (p) => ({
    title: `Your briefing for ${date(p.date) || 'today'}`,
    body: str(p.summary).slice(0, 300),
    url: '/dashboard',
  }),

  // ---------------------------------------------------------------- admin
  admin_project_created: (_p, c) => ({
    title: `New project: ${ref(c)}`,
    body: `${c.address ?? ''}${c.pmName ? ` · PM ${c.pmName}` : ' · no PM assigned yet'}`.trim(),
    url: staffUrl(c),
  }),
  deal_won: (p) => ({
    title: `Deal won: ${str(p.customer)}`,
    body: p.value ? `Contract value ${money(p.value)}.` : 'Marked won.',
    url: '/deals',
  }),
  esign_failed: (p) => ({
    title: `E-signature failed for ${str(p.signer)}`,
    body: str(p.error) || 'PandaDoc refused the document.',
    url: '/admin/settings',
  }),

  // ---------------------------------------------------------------- sales
  lead_assigned: (p) => ({
    title: `New contact for you: ${str(p.name)}`,
    body: `Stage: ${str(p.stage).replace(/_/g, ' ')}. Reach out today — speed to lead wins.`,
    url: '/admin/people/stages',
  }),
  contact_stale: (p) => ({
    title: `${str(p.name)} has gone quiet`,
    body: `${str(p.stage).replace(/_/g, ' ')} and not contacted for ${p.days} days.`,
    url: p.client_id ? `/admin/people/${str(p.client_id)}` : '/admin/people/stages',
  }),
  deal_stale: (p) => ({
    title: `Deal going quiet: ${str(p.customer)}`,
    body: `${str(p.stage).replace(/_/g, ' ')} with no change for ${p.days} days.`,
    url: p.deal_id ? `/deals/${str(p.deal_id)}` : '/deals',
  }),

  // ---------------------------------------------------------------- dealer
  dealer_project_created: (_p, c) => ({
    title: `Project started for ${c.customerName ?? 'your customer'}`,
    body: `${c.projectCode ?? ''} ${c.address ?? ''}`.trim(),
    url: dealerUrl(c),
  }),
  dealer_stage_advanced: (p, c) => ({
    title: `${c.customerName ?? 'Your project'} moved to ${stageName(p.stage)}`,
    body: c.projectCode ?? '',
    url: dealerUrl(c),
  }),
  dealer_project_complete: (_p, c) => ({
    title: `${c.customerName ?? 'Your project'} is complete`,
    body: `${c.projectCode ?? ''} reached permission to operate.`,
    url: dealerUrl(c),
  }),
  dealer_project_on_hold: (p, c) => ({
    title: `${c.customerName ?? 'Your project'} is on hold`,
    body: p.reason ? `Reason: ${str(p.reason)}.` : '',
    url: dealerUrl(c),
  }),
  commission_payable: (p, c) => ({
    title: `Commission payable: ${money(p.amount)}`,
    body: `${ref(c)}${p.payable_date ? ` · payable ${date(p.payable_date)}` : ''}`,
    url: '/dealers/commissions',
  }),
};

export function render(kind: string, payload: Payload, ctx: NotifyContext): Rendered {
  const fn = CATALOGUE[kind];
  if (!fn) return { title: kind.replace(/_/g, ' '), body: '', url: ctx.audience === 'customer' ? '/portal' : '/' };
  return fn(payload ?? {}, ctx);
}

/** The email around a rendered notification. Plain text, one link. */
export function emailFor(
  r: Rendered,
  ctx: NotifyContext,
  recipientName: string | null,
  origin: string
): { subject: string; text: string } {
  const first = recipientName?.split(' ')[0];
  const company = ctx.companyName ?? 'SolarFlow';
  const closing =
    ctx.audience === 'customer'
      ? `Open your project: ${origin}${r.url}\n\nQuestions? Message your project manager from the app.\n\n${company}`
      : `Open it: ${origin}${r.url}\n\n${company} · SolarFlow PM`;
  return {
    subject: r.title,
    text: `${first ? `Hi ${first},` : 'Hello,'}\n\n${r.body}\n\n${closing}\n`,
  };
}
