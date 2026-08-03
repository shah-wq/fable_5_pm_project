import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';

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
}

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

  const projectId = await withUser(session, async (client) => {
    const client_ = await client.query<{ id: string }>(
      `insert into public.clients (dealer_id, first_name, last_name, email, phone)
       values ($1, $2, $3, $4, $5) returning id`,
      [p.dealerId, first, last, p.customerEmail?.trim() || null, p.customerPhone?.trim() || null]
    );
    const project = await client.query<{ id: string }>(
      `insert into public.projects
         (name, address, dealer_id, client_id, finance_partner_id,
          system_size_kw, contract_value, assigned_pm, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        `${first} ${last}`,
        p.address!.trim(),
        p.dealerId,
        client_.rows[0].id,
        p.financePartnerId || null,
        p.systemSizeKw ?? null,
        p.contractValue ?? null,
        p.assignedPm || session.userId,
        session.userId,
      ]
    );
    return project.rows[0].id;
  });

  await tryLogAuditEvent(session, {
    action: 'project.created',
    entityType: 'projects',
    entityId: projectId,
    projectId,
  });

  return NextResponse.json({ projectId }, { status: 201 });
}
