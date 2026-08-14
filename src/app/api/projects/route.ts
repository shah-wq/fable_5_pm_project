import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { DETAIL_FIELDS, coerceDetail } from '@/lib/projects/details';

interface CreatePayload {
  customerFirst?: string;
  customerLast?: string;
  customerEmail?: string;
  customerPhone?: string;
  address?: string;
  dealerId?: string;
  financePartnerId?: string;
  systemSizeKw?: number;
  contractValue?: number;
  assignedPm?: string;
  /** System-spec / financing / sales-rep columns from the extended form. */
  details?: Record<string, unknown>;
}

/** Columns settable via `details` at creation (the base insert covers the rest). */
const CREATE_DETAIL_COLUMNS = new Set([
  'sales_rep_id', 'system_type_id', 'module_type_id', 'module_quantity',
  'inverter_type_id', 'inverter_quantity', 'battery_type_id', 'battery_quantity',
  'cash_or_financing_id', 'financing_company_id', 'financing_notes',
]);

/**
 * Create a project (PM/admin): the customer record and the project row in one
 * transaction. The project starts in Survey; every later fact is entered
 * through the stage forms.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const p = (await request.json().catch(() => null)) as CreatePayload | null;
  const first = p?.customerFirst?.trim();
  const last = p?.customerLast?.trim();
  if (!first || !last) {
    return NextResponse.json({ error: 'customer first and last name are required' }, { status: 400 });
  }
  if (!p?.address?.trim()) {
    return NextResponse.json({ error: 'address is required' }, { status: 400 });
  }
  if (!p?.dealerId) {
    return NextResponse.json({ error: 'dealer is required' }, { status: 400 });
  }

  // Validate the optional detail columns against the shared registry.
  const detailCols: string[] = [];
  const detailVals: unknown[] = [];
  for (const [name, raw] of Object.entries(p.details ?? {})) {
    if (!CREATE_DETAIL_COLUMNS.has(name)) continue;
    const field = DETAIL_FIELDS.find((f) => f.name === name);
    if (!field) continue;
    const coerced = coerceDetail(field, raw);
    if (!coerced.ok) {
      return NextResponse.json({ error: `invalid value for ${field.label}` }, { status: 400 });
    }
    if (coerced.value === null) continue;
    detailCols.push(name);
    detailVals.push(coerced.value);
  }

  let projectId: string;
  try {
    projectId = await withUser(session, async (client) => {
      const client_ = await client.query<{ id: string }>(
        `insert into public.clients (dealer_id, first_name, last_name, email, phone)
         values ($1, $2, $3, $4, $5) returning id`,
        [p.dealerId, first, last, p.customerEmail?.trim() || null, p.customerPhone?.trim() || null]
      );
      const baseVals = [
        `${first} ${last}`,
        p.address!.trim(),
        p.dealerId,
        client_.rows[0].id,
        p.financePartnerId || null,
        p.systemSizeKw ?? null,
        p.contractValue ?? null,
        p.assignedPm || session.userId,
        session.userId,
      ];
      const extraCols = detailCols.map((c) => `, "${c}"`).join('');
      const extraPh = detailVals.map((_, i) => `, $${baseVals.length + i + 1}`).join('');
      const project = await client.query<{ id: string }>(
        `insert into public.projects
           (name, address, dealer_id, client_id, finance_partner_id,
            system_size_kw, contract_value, assigned_pm, created_by${extraCols})
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9${extraPh})
         returning id`,
        [...baseVals, ...detailVals]
      );
      // RETURNING is filtered by the SELECT policy, so an empty result means
      // the row was written but this user cannot read it back.
      if (!project.rows[0]) {
        throw new Error(
          'the project row was created but is not visible to your account (row-level security) — check projects_select'
        );
      }
      return project.rows[0].id;
    });
  } catch (e) {
    return dbErrorResponse(e, 'Creating the project');
  }

  await tryLogAuditEvent(session, {
    action: 'project.created',
    entityType: 'projects',
    entityId: projectId,
    projectId,
  });

  return NextResponse.json({ projectId }, { status: 201 });
}
