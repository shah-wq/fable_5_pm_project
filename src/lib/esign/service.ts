import type { PoolClient } from 'pg';
import { withAnon, withUser, type SessionIdentity } from '../db';
import {
  createFromTemplate,
  createSession,
  downloadDocument,
  getDocument,
  mapStatus,
  pandadocConfigured,
  PandaDocError,
  sendDocument,
  voidDocument,
  waitForDraft,
  type WebhookEvent,
} from './pandadoc';

/**
 * Sending, following and finishing an e-signature, around the functions in
 * migration 004400.
 *
 * The database decides; this file carries messages. Every write goes through
 * one of esign_open / esign_mark / esign_complete under the caller's claims,
 * so a sales rep can send a contract and not a change order, a PM the other
 * way round, exactly as they could sign either by hand.
 *
 * Nothing here holds a database transaction open across a call to PandaDoc.
 * Each step is its own short withUser, so a slow PandaDoc never pins a
 * connection, and a failure part-way leaves a row that says how far it got.
 */

export interface EsignSettings {
  contractTemplate: string | null;
  changeOrderTemplate: string | null;
  signerRole: string;
  companyName: string | null;
  coPrefix: string;
}

export interface EnvelopeView {
  id: string;
  purpose: 'contract' | 'change_order';
  status: string;
  delivery: 'email' | 'embedded';
  signerName: string | null;
  signerEmail: string;
  providerDocumentId: string | null;
  createdAt: string;
  sentAt: string | null;
  viewedAt: string | null;
  completedAt: string | null;
  appliedAt: string | null;
  lastError: string | null;
  projectId: string | null;
  projectCode: string | null;
  documentId: string | null;
  changeOrderId: string | null;
  clientId: string | null;
}

interface EnvelopeRow {
  id: string;
  purpose: 'contract' | 'change_order';
  status: string;
  delivery: 'email' | 'embedded';
  signer_name: string | null;
  signer_email: string;
  provider_document_id: string | null;
  created_at: Date;
  sent_at: Date | null;
  viewed_at: Date | null;
  completed_at: Date | null;
  applied_at: Date | null;
  last_error: string | null;
  project_id: string | null;
  document_id: string | null;
  change_order_id: string | null;
  client_id: string | null;
  deal_id: string | null;
  payload: Record<string, unknown>;
  signed_object_id: string | null;
  outcome: Record<string, unknown> | null;
  project_code?: string | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export function toView(r: EnvelopeRow): EnvelopeView {
  return {
    id: r.id,
    purpose: r.purpose,
    status: r.status,
    delivery: r.delivery,
    signerName: r.signer_name,
    signerEmail: r.signer_email,
    providerDocumentId: r.provider_document_id,
    createdAt: iso(r.created_at) as string,
    sentAt: iso(r.sent_at),
    viewedAt: iso(r.viewed_at),
    completedAt: iso(r.completed_at),
    appliedAt: iso(r.applied_at),
    lastError: r.last_error,
    projectId: r.project_id,
    projectCode: (r.outcome?.project_code as string | undefined) ?? r.project_code ?? null,
    documentId: r.document_id,
    changeOrderId: r.change_order_id,
    clientId: r.client_id,
  };
}

const ENVELOPE_SQL = `select e.*, p.code as project_code
                        from public.esign_envelopes e
                        left join public.projects p on p.id = e.project_id`;

export async function loadEnvelope(c: PoolClient, id: string): Promise<EnvelopeRow | null> {
  const { rows } = await c.query<EnvelopeRow>(`${ENVELOPE_SQL} where e.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listEnvelopes(
  c: PoolClient,
  where: { clientId?: string; changeOrderIds?: string[] }
): Promise<EnvelopeView[]> {
  const { rows } = where.clientId
    ? await c.query<EnvelopeRow>(
        `${ENVELOPE_SQL} where e.client_id = $1 and e.purpose = 'contract' order by e.created_at desc limit 20`,
        [where.clientId]
      )
    : await c.query<EnvelopeRow>(
        `${ENVELOPE_SQL} where e.change_order_id = any($1::uuid[]) order by e.created_at desc`,
        [where.changeOrderIds ?? []]
      );
  return rows.map(toView);
}

export async function loadSettings(c: PoolClient): Promise<EsignSettings> {
  const { rows } = await c.query<{
    contract_template: string | null;
    change_order_template: string | null;
    signer_role: string;
    company_name: string | null;
    co_prefix: string | null;
  }>('select * from public.esign_settings()');
  const r = rows[0];
  return {
    contractTemplate: r?.contract_template?.trim() || null,
    changeOrderTemplate: r?.change_order_template?.trim() || null,
    signerRole: r?.signer_role || 'Client',
    companyName: r?.company_name ?? null,
    coPrefix: r?.co_prefix ?? 'CO-',
  };
}

/** Whether a Send for e-signature button should be offered at all, and why not. */
export function readiness(
  settings: EsignSettings,
  purpose: 'contract' | 'change_order'
): { ready: boolean; reason: string | null } {
  if (!pandadocConfigured()) {
    return { ready: false, reason: 'PandaDoc is not connected (PANDADOC_API_KEY is not set).' };
  }
  const template =
    purpose === 'contract' ? settings.contractTemplate : settings.changeOrderTemplate;
  if (!template) {
    return {
      ready: false,
      reason: `No PandaDoc ${purpose === 'contract' ? 'contract' : 'change order'} template is chosen — Admin → Settings → E-signature.`,
    };
  }
  return { ready: true, reason: null };
}

function splitName(
  name: string | null,
  fallbackFirst?: string | null,
  fallbackLast?: string | null
) {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: fallbackFirst ?? '', last: fallbackLast ?? '' };
  return { first: parts[0], last: parts.slice(1).join(' ') || (fallbackLast ?? '') };
}

const money = (v: unknown) =>
  v === null || v === undefined || v === '' || !Number.isFinite(Number(v))
    ? null
    : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * The fields a template can use, as PandaDoc tokens ([Client.FirstName] in the
 * template). Listed in Admin → Settings so whoever builds the template knows
 * the names.
 */
export const CONTRACT_TOKENS = [
  'Client.FirstName',
  'Client.LastName',
  'Client.Email',
  'Client.Phone',
  'Project.Address',
  'Dealer.Name',
  'Company.Name',
  'System.SizeKw',
  'System.ModuleQuantity',
  'System.BatteryQuantity',
  'Contract.Value',
  'Contract.GrossPrice',
  'Contract.DownPayment',
  'Contract.AmountFinanced',
];
export const CHANGE_ORDER_TOKENS = [
  'Client.FirstName',
  'Client.LastName',
  'Client.Email',
  'Project.Code',
  'Project.Address',
  'Company.Name',
  'ChangeOrder.Number',
  'ChangeOrder.Reason',
  'ChangeOrder.Description',
  'ChangeOrder.Amount',
  'Contract.CurrentValue',
  'Contract.NewValue',
];

async function documentInput(identity: SessionIdentity, env: EnvelopeRow, settings: EsignSettings) {
  return withUser(identity, async (c) => {
    if (env.purpose === 'contract') {
      const { rows } = await c.query<{
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone: string | null;
        dealer_name: string | null;
      }>(
        `select cl.first_name, cl.last_name, cl.email, cl.phone,
                (select d.name from public.dealer_directory() d where d.id::text = $2) as dealer_name
           from public.clients cl where cl.id = $1`,
        [env.client_id, String(env.payload.dealer_id ?? '')]
      );
      const cl = rows[0];
      const who = splitName(env.signer_name, cl?.first_name, cl?.last_name);
      const p = env.payload;
      return {
        name: `Solar installation agreement — ${[cl?.first_name, cl?.last_name].filter(Boolean).join(' ')}`,
        templateId: settings.contractTemplate as string,
        recipient: {
          email: env.signer_email,
          first_name: who.first,
          last_name: who.last,
          role: settings.signerRole,
        },
        tokens: {
          'Client.FirstName': cl?.first_name,
          'Client.LastName': cl?.last_name,
          'Client.Email': cl?.email,
          'Client.Phone': cl?.phone,
          'Project.Address': p.address as string,
          'Dealer.Name': cl?.dealer_name,
          'Company.Name': settings.companyName,
          'System.SizeKw': p.system_size_kw as number,
          'System.ModuleQuantity': p.module_quantity as number,
          'System.BatteryQuantity': p.battery_qty as number,
          'Contract.Value': money(p.contract_value),
          'Contract.GrossPrice': money(p.gross_price),
          'Contract.DownPayment': money(p.down_payment),
          'Contract.AmountFinanced': money(p.amount_financed),
        },
        subject: 'Your solar installation agreement',
        message: 'Please review and sign your solar installation agreement.',
      };
    }
    const { rows } = await c.query<{
      number: number;
      reason: string | null;
      description: string | null;
      amount_delta: string;
      code: string;
      address: string | null;
      contract_value: string | null;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>(
      `select co.number, co.reason, co.description, co.amount_delta, p.code, p.address,
              p.contract_value, cl.first_name, cl.last_name, cl.email
         from public.change_orders co
         join public.projects p on p.id = co.project_id
         left join public.clients cl on cl.id = p.client_id
        where co.id = $1`,
      [env.change_order_id]
    );
    const co = rows[0];
    const who = splitName(env.signer_name, co?.first_name, co?.last_name);
    const current = co?.contract_value === null ? null : Number(co?.contract_value);
    return {
      name: `Change order ${settings.coPrefix}${co?.number} — ${co?.code}`,
      templateId: settings.changeOrderTemplate as string,
      recipient: {
        email: env.signer_email,
        first_name: who.first,
        last_name: who.last,
        role: settings.signerRole,
      },
      tokens: {
        'Client.FirstName': co?.first_name,
        'Client.LastName': co?.last_name,
        'Client.Email': co?.email,
        'Project.Code': co?.code,
        'Project.Address': co?.address,
        'Company.Name': settings.companyName,
        'ChangeOrder.Number': `${settings.coPrefix}${co?.number}`,
        'ChangeOrder.Reason': co?.reason,
        'ChangeOrder.Description': co?.description,
        'ChangeOrder.Amount': money(co?.amount_delta),
        'Contract.CurrentValue': money(current),
        'Contract.NewValue': money((current ?? 0) + Number(co?.amount_delta ?? 0)),
      },
      subject: `Change order ${settings.coPrefix}${co?.number} for your solar project`,
      message: 'Please review and sign this change order to your solar installation agreement.',
    };
  });
}

async function mark(
  identity: SessionIdentity,
  id: string,
  providerId: string | null,
  status: string | null,
  error: string | null = null
) {
  await withUser(identity, (c) =>
    c.query('select public.esign_mark($1, $2, $3, $4)', [id, providerId, status, error])
  );
}

export interface SendResult {
  envelope: EnvelopeView;
  sessionUrl: string | null;
}

/**
 * Create the document in PandaDoc and send it. An envelope still being built
 * when the wait runs out is left 'preparing'; Check status finishes the send.
 */
export async function sendEnvelope(identity: SessionIdentity, id: string): Promise<SendResult> {
  const { env, settings } = await withUser(identity, async (c) => ({
    env: await loadEnvelope(c, id),
    settings: await loadSettings(c),
  }));
  if (!env) throw new PandaDocError('That envelope no longer exists.', 404);

  let providerId = env.provider_document_id;
  try {
    if (!providerId) {
      const input = await documentInput(identity, env, settings);
      const doc = await createFromTemplate({
        name: input.name,
        templateId: input.templateId,
        recipients: [input.recipient],
        tokens: input.tokens,
        metadata: { solarflow_envelope: env.id, solarflow_purpose: env.purpose },
      });
      providerId = doc.id;
      await mark(identity, id, providerId, null);
    }
    let sessionUrl: string | null = null;
    const state = await waitForDraft(providerId);
    if (state === 'document.draft') {
      const input = await documentInput(identity, env, settings);
      await sendDocument(providerId, {
        subject: input.subject,
        message: input.message,
        silent: env.delivery === 'embedded',
      });
      await mark(identity, id, null, 'sent');
      if (env.delivery === 'embedded') {
        sessionUrl = (await createSession(providerId, env.signer_email)).url;
      }
    } else if (mapStatus(state) && mapStatus(state) !== 'preparing') {
      await mark(identity, id, null, mapStatus(state));
    }
    const view = await withUser(identity, (c) => loadEnvelope(c, id));
    return { envelope: toView(view as EnvelopeRow), sessionUrl };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A document PandaDoc never made is dead; one it did make can still be
    // followed, so it keeps its status and gets the reason alongside.
    await mark(identity, id, null, providerId ? null : 'failed', message).catch(() => undefined);
    throw e;
  }
}

/** The signed PDF, filed and applied. Safe to call any number of times. */
export async function completeEnvelope(identity: SessionIdentity, env: EnvelopeRow) {
  let data: Buffer | null = null;
  if (!env.signed_object_id) {
    if (!env.provider_document_id) throw new PandaDocError('This envelope was never sent.', 409);
    data = await downloadDocument(env.provider_document_id);
  }
  const name =
    env.purpose === 'contract' ? 'Signed installation agreement.pdf' : 'Signed change order.pdf';
  const { rows } = await withUser(identity, (c) =>
    c.query<{ outcome: Record<string, unknown> }>(
      'select public.esign_complete($1, $2, $3) as outcome',
      [env.id, name, data]
    )
  );
  return rows[0].outcome;
}

/**
 * Ask PandaDoc where the document is and act on it — the fallback for an
 * installation whose webhook is not set up, and the Finish button for one
 * whose outcome could not be applied the first time.
 */
export async function syncEnvelope(identity: SessionIdentity, id: string): Promise<SendResult> {
  const env = await withUser(identity, (c) => loadEnvelope(c, id));
  if (!env) throw new PandaDocError('That envelope no longer exists.', 404);
  if (env.applied_at) return { envelope: toView(env), sessionUrl: null };
  if (env.status === 'completed' && env.signed_object_id) {
    await completeEnvelope(identity, env);
  } else if (!env.provider_document_id || env.status === 'preparing') {
    if (['declined', 'voided'].includes(env.status))
      return { envelope: toView(env), sessionUrl: null };
    return sendEnvelope(identity, id);
  } else {
    const doc = await getDocument(env.provider_document_id);
    const status = mapStatus(doc.status);
    if (status === 'completed') {
      await mark(identity, id, null, 'completed');
      await completeEnvelope(identity, env);
    } else if (status) {
      await mark(identity, id, null, status);
    }
  }
  const view = await withUser(identity, (c) => loadEnvelope(c, id));
  return { envelope: toView(view as EnvelopeRow), sessionUrl: null };
}

/** A fresh link for signing on this screen, for a document already sent. */
export async function signingSession(identity: SessionIdentity, id: string): Promise<string> {
  const env = await withUser(identity, (c) => loadEnvelope(c, id));
  if (!env?.provider_document_id)
    throw new PandaDocError('This envelope has not been sent yet.', 409);
  if (!['sent', 'viewed'].includes(env.status)) {
    throw new PandaDocError(`A ${env.status} document cannot be signed.`, 409);
  }
  return (await createSession(env.provider_document_id, env.signer_email)).url;
}

export async function voidEnvelope(identity: SessionIdentity, id: string): Promise<EnvelopeView> {
  const env = await withUser(identity, (c) => loadEnvelope(c, id));
  if (!env) throw new PandaDocError('That envelope no longer exists.', 404);
  if (!['preparing', 'sent', 'viewed', 'failed'].includes(env.status)) {
    throw new PandaDocError(`A ${env.status} document cannot be voided.`, 409);
  }
  if (env.provider_document_id && env.status !== 'failed') {
    // A document PandaDoc cannot void (still building, or already gone) is
    // voided here anyway: the point is that it can no longer be acted on.
    await voidDocument(env.provider_document_id, 'Withdrawn in SolarFlow').catch((e) => {
      if (!(e instanceof PandaDocError) || !e.upstream || e.status >= 500) throw e;
    });
  }
  await mark(identity, id, null, 'voided');
  const view = await withUser(identity, (c) => loadEnvelope(c, id));
  return toView(view as EnvelopeRow);
}

/**
 * One webhook event, acted on as the person who sent the document. Returns
 * what happened, for the log line and the test suite.
 */
export async function handleWebhookEvent(ev: WebhookEvent): Promise<string> {
  const { rows } = await withAnon((c) =>
    c.query<{
      envelope_id: string;
      sender_id: string | null;
      sender_role: string | null;
      sender_active: boolean;
      sender_email: string | null;
      status: string;
      applied: boolean;
    }>('select * from public.esign_webhook_target($1)', [ev.documentId])
  );
  const target = rows[0];
  if (!target) return 'unknown document';
  if (target.applied) return 'already applied';
  if (!target.sender_id || !target.sender_active || !target.sender_role) {
    return 'sender inactive — left for Check status';
  }
  const identity: SessionIdentity = {
    userId: target.sender_id,
    email: target.sender_email,
    role: target.sender_role as SessionIdentity['role'],
  };
  const status = mapStatus(ev.status);
  if (!status) return 'ignored';
  if (status === 'completed') {
    await mark(identity, target.envelope_id, null, 'completed');
    const env = await withUser(identity, (c) => loadEnvelope(c, target.envelope_id));
    if (!env) return 'unknown document';
    const outcome = await completeEnvelope(identity, env);
    return outcome?.error ? `completed, needs attention: ${String(outcome.error)}` : 'completed';
  }
  if (status === 'preparing') {
    // The document finished building after the send gave up waiting for it:
    // PandaDoc saying so is the moment to send it.
    if (ev.status === 'document.draft' && target.status === 'preparing') {
      await sendEnvelope(identity, target.envelope_id);
      return 'sent';
    }
    return 'ignored';
  }
  await mark(identity, target.envelope_id, null, status);
  return status;
}
