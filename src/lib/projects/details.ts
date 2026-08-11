import type { PoolClient } from 'pg';

/**
 * The New Project form & Project Details registry ("New Project form &
 * Project Details" spec). Four blocks; the same definition drives the create
 * form, the Details tab, and the PATCH allowlist — reference values are
 * stored by ID, display text comes from the admin-managed lists.
 */

export type RefKey =
  | 'dealers'
  | 'salesReps'
  | 'pms'
  | 'systemTypes'
  | 'moduleTypes'
  | 'inverterTypes'
  | 'batteryTypes'
  | 'cashFinancing'
  | 'financingCompanies'
  | 'financePartners';

export interface RefOption {
  id: string;
  name: string;
}

export type DetailFieldType =
  | 'text'
  | 'email'
  | 'phone'
  | 'number'
  | 'currency'
  | 'textarea'
  | 'ref';

export interface DetailField {
  /** Column name on the target table. */
  name: string;
  label: string;
  type: DetailFieldType;
  /** Which row the column lives on. */
  table: 'project' | 'client';
  refKey?: RefKey;
  /** Render the ref as a type-ahead combobox (mandatory above ~20 options). */
  combo?: boolean;
  /** Blocks the Create button; everything else is optional at creation. */
  required?: boolean;
  /** Offer '+ Add new' inline (writes to the admin list). */
  addNew?: boolean;
  /** Conditional visibility per the spec. Hidden fields are never required. */
  visibleIf?: 'hasBattery' | 'notPlainCash';
  note?: string;
}

export interface DetailBlock {
  key: string;
  title: string;
  fields: DetailField[];
}

export const DETAIL_BLOCKS: DetailBlock[] = [
  {
    key: 'customer',
    title: 'Customer',
    fields: [
      { name: 'first_name', label: 'Customer first name', type: 'text', table: 'client', required: true },
      { name: 'last_name', label: 'Customer last name', type: 'text', table: 'client', required: true },
      { name: 'email', label: 'Customer email', type: 'email', table: 'client',
        note: 'Used later if the customer portal is enabled' },
      { name: 'phone', label: 'Customer phone', type: 'phone', table: 'client' },
      { name: 'address', label: 'Site address', type: 'text', table: 'project', required: true,
        note: 'Street, city, state ZIP' },
    ],
  },
  {
    key: 'sales',
    title: 'Sales & commercial',
    fields: [
      { name: 'dealer_id', label: 'Dealer', type: 'ref', refKey: 'dealers', table: 'project', required: true },
      { name: 'sales_rep_id', label: 'Sales rep', type: 'ref', refKey: 'salesReps', table: 'project',
        addNew: true, note: 'Pick from the Sales Reps list — consistent per-rep reporting' },
      { name: 'contract_value', label: 'Contract total ($)', type: 'currency', table: 'project',
        note: 'Base contract value before adders' },
      { name: 'assigned_pm', label: 'Assigned PM', type: 'ref', refKey: 'pms', table: 'project' },
    ],
  },
  {
    key: 'system',
    title: 'System specification',
    fields: [
      { name: 'system_type_id', label: 'System Type', type: 'ref', refKey: 'systemTypes', table: 'project' },
      { name: 'module_type_id', label: 'Module Type', type: 'ref', refKey: 'moduleTypes', table: 'project',
        combo: true },
      { name: 'module_quantity', label: 'Module Quantity', type: 'number', table: 'project' },
      { name: 'inverter_type_id', label: 'Inverter Type', type: 'ref', refKey: 'inverterTypes', table: 'project',
        combo: true },
      { name: 'battery_type_id', label: 'Battery Type', type: 'ref', refKey: 'batteryTypes', table: 'project',
        combo: true, visibleIf: 'hasBattery' },
      { name: 'system_size_kw', label: 'System size (kW)', type: 'number', table: 'project',
        note: 'Decimal, e.g. 9.6' },
    ],
  },
  {
    key: 'financing',
    title: 'Financing',
    fields: [
      { name: 'cash_or_financing_id', label: 'Cash or Financing', type: 'ref', refKey: 'cashFinancing',
        table: 'project' },
      { name: 'financing_company_id', label: 'Financing Company', type: 'ref', refKey: 'financingCompanies',
        table: 'project', visibleIf: 'notPlainCash', note: 'Who lent the money' },
      { name: 'finance_partner_id', label: 'Finance partner (milestones)', type: 'ref',
        refKey: 'financePartners', table: 'project', visibleIf: 'notPlainCash',
        note: 'Drives the milestone field labels on the stage forms' },
      { name: 'financing_notes', label: 'Financing Notes', type: 'textarea', table: 'project',
        note: 'Split-deal detail: amounts, rates, terms, down payments' },
    ],
  },
];

export const DETAIL_FIELDS: DetailField[] = DETAIL_BLOCKS.flatMap((b) => b.fields);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate + normalize one field value; null clears. */
export function coerceDetail(
  field: DetailField,
  raw: unknown
): { ok: true; value: unknown } | { ok: false } {
  if (raw === '' || raw === null || raw === undefined) return { ok: true, value: null };
  switch (field.type) {
    case 'ref':
      return UUID_RE.test(String(raw)) ? { ok: true, value: String(raw) } : { ok: false };
    case 'number':
    case 'currency': {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? { ok: true, value: n } : { ok: false };
    }
    default:
      return { ok: true, value: String(raw).slice(0, 10000) };
  }
}

/**
 * Conditional visibility (spec §4): Battery Type only when the selected
 * System Type includes a battery; Financing Company / Finance partner only
 * when Cash or Financing is anything other than plain Cash.
 */
export function fieldVisible(
  field: DetailField,
  values: Record<string, unknown>,
  refs: Partial<Record<RefKey, RefOption[]>>
): boolean {
  if (!field.visibleIf) return true;
  if (field.visibleIf === 'hasBattery') {
    const st = (refs.systemTypes ?? []).find((o) => o.id === values.system_type_id);
    return !!st && /battery/i.test(st.name);
  }
  const cf = (refs.cashFinancing ?? []).find((o) => o.id === values.cash_or_financing_id);
  return !!cf && cf.name.trim().toLowerCase() !== 'cash';
}

/** All dropdown option lists the form needs, active rows only. */
export async function loadDetailRefs(client: PoolClient): Promise<Record<RefKey, RefOption[]>> {
  // Sequential on purpose — a single pg client runs one query at a time.
  const list = async (sql: string) => (await client.query<RefOption>(sql)).rows;
  return {
    dealers: await list(`select id, name from public.dealers where is_active order by name`),
    salesReps: await list(`select id, name from public.sales_reps where is_active order by name`),
    pms: await list(`select id, coalesce(full_name, email) as name from public.profiles
          where role in ('admin', 'ops') and is_active and deleted_at is null order by 2`),
    systemTypes: await list(`select id, name from public.system_types where is_active order by name`),
    moduleTypes: await list(`select id, name from public.module_types where is_active order by name`),
    inverterTypes: await list(`select id, name from public.inverter_types where is_active order by name`),
    batteryTypes: await list(`select id, name from public.battery_types where is_active order by name`),
    cashFinancing: await list(`select id, name from public.cash_financing_options where is_active order by name`),
    financingCompanies: await list(`select id, name from public.financing_companies where is_active order by name`),
    financePartners: await list(`select id, name from public.finance_partners where is_active order by name`),
  };
}
