import type { PoolClient } from 'pg';

/**
 * The Customers section's data layer. A customer is a person and a project is a
 * job, so everything here is keyed on the client record and rolls its projects
 * up — the point of the section is answering 'what is our whole history with
 * this person?' in one place.
 */

export interface CustomerRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  alternatePhone: string | null;
  mailingAddress: string | null;
  preferredContact: string | null;
  preferredLanguage: string | null;
  internalNotes: string | null;
  isArchived: boolean;
  anonymisedAt: string | null;
  cityState: string | null;
  projectCount: number;
  completedCount: number;
  currentStage: string | null;
  dealerName: string | null;
  repName: string | null;
  /** Portal access: 'none' | 'invited' | 'active' | 'disabled'. */
  portal: 'none' | 'invited' | 'active' | 'disabled';
  portalUserId: string | null;
  invitePending: boolean;
  lastSignInAt: string | null;
  lastActivity: string | null;
  createdAt: string;
}

const asDate = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Every customer with the roll-ups the list shows. auth.users is read for the
 * invite/last-login state — the login row points at the customer, not the
 * other way round, so 'we have their details' and 'they can log in' stay two
 * independent facts.
 */
export async function loadCustomers(client: PoolClient): Promise<CustomerRow[]> {
  // auth.users is not readable by the app role; customer_login_state() is the
  // admin/PM-only definer view of it.
  const logins = new Map<string, {
    userId: string | null;
    isActive: boolean | null;
    lastSignInAt: unknown;
    invitePending: boolean;
  }>();
  const loginRows = await client.query(
    `select client_id, user_id, is_active, last_sign_in_at, invite_pending
     from public.customer_login_state()`
  );
  for (const r of loginRows.rows) {
    logins.set(r.client_id, {
      userId: r.user_id,
      isActive: r.is_active,
      lastSignInAt: r.last_sign_in_at,
      invitePending: r.invite_pending === true,
    });
  }

  const { rows } = await client.query(
    `select c.id, c.first_name, c.last_name, c.email, c.phone, c.alternate_phone,
            c.mailing_address, c.preferred_contact, c.preferred_language,
            c.internal_notes, c.is_archived, c.anonymised_at, c.created_at, c.user_id,
            d.name as dealer_name,
            (select count(*) from public.projects p where p.client_id = c.id) as project_count,
            (select count(*) from public.projects p
              where p.client_id = c.id and p.status = 'complete') as completed_count,
            (select p.stage::text from public.projects p
              where p.client_id = c.id and p.status not in ('complete', 'cancelled')
              order by p.created_at desc limit 1) as current_stage,
            (select p.address from public.projects p
              where p.client_id = c.id order by p.created_at desc limit 1) as latest_address,
            (select sr.name from public.projects p
              left join public.sales_reps sr on sr.id = p.sales_rep_id
              where p.client_id = c.id and sr.name is not null
              order by p.created_at desc limit 1) as rep_name,
            (select greatest(
                      coalesce(max(p.updated_at), c.updated_at),
                      c.updated_at)
             from public.projects p where p.client_id = c.id) as last_activity
     from public.clients c
     left join public.dealers d on d.id = c.dealer_id
     order by last_activity desc nulls last, c.created_at desc
     limit 1000`
  );

  return rows.map((r) => {
    const address = String(r.latest_address ?? '');
    // 'city, state' out of a free-text address: the last two comma parts.
    const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
    const cityState = parts.length >= 2 ? parts.slice(1, 3).join(', ') : null;

    const login = logins.get(r.id);
    const portal: CustomerRow['portal'] = !r.user_id
      ? 'none'
      : login?.isActive === false
        ? 'disabled'
        : login?.invitePending && !login?.lastSignInAt
          ? 'invited'
          : 'active';

    return {
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      email: r.email,
      phone: r.phone,
      alternatePhone: r.alternate_phone,
      mailingAddress: r.mailing_address,
      preferredContact: r.preferred_contact,
      preferredLanguage: r.preferred_language,
      internalNotes: r.internal_notes,
      isArchived: r.is_archived === true,
      anonymisedAt: asDate(r.anonymised_at),
      cityState,
      projectCount: Number(r.project_count),
      completedCount: Number(r.completed_count),
      currentStage: r.current_stage,
      dealerName: r.dealer_name,
      repName: r.rep_name,
      portal,
      portalUserId: r.user_id,
      invitePending: login?.invitePending === true,
      lastSignInAt: asDate(login?.lastSignInAt),
      lastActivity: asDate(r.last_activity),
      createdAt: asDate(r.created_at)!,
    };
  });
}

export interface CustomerProjectRow {
  id: string;
  code: string;
  address: string | null;
  systemSizeKw: number | null;
  stage: string;
  status: string;
  contractValue: number | null;
  createdAt: string;
  completionDate: string | null;
}

/** The Projects tab: every project this person has with you. */
export async function loadCustomerProjects(
  client: PoolClient,
  customerId: string
): Promise<CustomerProjectRow[]> {
  const { rows } = await client.query(
    `select p.id, p.code, p.address, p.system_size_kw, p.stage::text as stage,
            p.status::text as status, p.contract_value, p.created_at,
            s7.completion_date
     from public.projects p
     left join public.stage7_complete s7 on s7.project_id = p.id
     where p.client_id = $1
     order by p.created_at desc`,
    [customerId]
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    address: r.address,
    systemSizeKw: r.system_size_kw === null ? null : Number(r.system_size_kw),
    stage: r.stage,
    status: r.status,
    contractValue: r.contract_value === null ? null : Number(r.contract_value),
    createdAt: asDate(r.created_at)!,
    completionDate: r.completion_date ? asDate(r.completion_date) : null,
  }));
}

/** The Activity tab: the audit trail that settles 'we never told them that'. */
export async function loadCustomerActivity(
  client: PoolClient,
  customerId: string,
  userId: string | null
): Promise<Array<{ at: string; action: string; actor: string | null }>> {
  const { rows } = await client.query(
    // audit_log.entity_id is text — the log covers rows keyed in several ways.
    `select a.occurred_at, a.action, coalesce(pr.full_name, pr.email) as actor
     from public.audit_log a
     left join public.profiles pr on pr.id = a.actor_id
     where (a.entity_type = 'clients' and a.entity_id = $1::uuid::text)
        or (a.project_id in (select id from public.projects where client_id = $1::uuid)
            and a.action like 'customer%')
        or ($2::text is not null and a.entity_id = $2::text)
     order by a.occurred_at desc
     limit 100`,
    [customerId, userId]
  );
  return rows.map((r) => ({
    at: asDate(r.occurred_at)!,
    action: String(r.action),
    actor: r.actor,
  }));
}

/** Likely duplicates for the pair-wise banner in the list. */
export async function loadDuplicateCandidates(
  client: PoolClient
): Promise<Array<{ a: string; b: string; reason: string }>> {
  const { rows } = await client.query(
    `select customer_a, customer_b, reason from public.customer_duplicate_candidates limit 50`
  );
  return rows.map((r) => ({ a: r.customer_a, b: r.customer_b, reason: r.reason }));
}

/**
 * Duplicate check for the New project form: is this email or phone already on
 * file? Catching it at creation is far cheaper than merging later.
 */
export async function findExistingCustomers(
  client: PoolClient,
  email: string | null,
  phone: string | null
): Promise<Array<{ id: string; name: string; email: string | null; phone: string | null; projects: number }>> {
  if (!email && !phone) return [];
  const { rows } = await client.query(
    `select c.id, c.first_name || ' ' || c.last_name as name, c.email, c.phone,
            (select count(*) from public.projects p where p.client_id = c.id) as projects
     from public.clients c
     where not c.is_archived
       and ((($1::text is not null) and lower(btrim(c.email)) = lower(btrim($1)))
         or (($2::text is not null) and c.phone = $2))
     limit 5`,
    [email, phone]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    projects: Number(r.projects),
  }));
}
