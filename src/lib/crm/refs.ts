import type { PoolClient } from 'pg';
import { optionalQuery, optionalRows } from '@/lib/db-optional';
import type { IntakeRefKey } from '@/lib/crm/intake';

/**
 * The dropdowns behind the intake fields.
 *
 * One definition, read by the contact record, the Create Contact page and the
 * API that saves both — because a list that exists twice is a list where one
 * copy quietly stops including the newest financing company.
 *
 * Every one of them degrades to an empty list on a database that has not caught
 * up, which is why they go through optionalRows: a missing reference table makes
 * a dropdown empty, not a screen that will not open.
 */
export const REF_SQL: Record<IntakeRefKey, string> = {
  owners: `select id, coalesce(full_name, email) as name from public.profiles
            where role::text in ('admin','ops','sales') and is_active and deleted_at is null order by 2`,
  sources: `select id, name from public.client_sources where is_active order by sort_order, name`,
  dealers: `select id, name from public.dealers where is_active order by name`,
  modules: `select id, name from public.module_types where is_active order by name`,
  inverters: `select id, name from public.inverter_types where is_active order by name`,
  batteries: `select id, name from public.battery_types where is_active order by name`,
  financingCompanies: `select id, name from public.financing_companies where is_active order by name`,
  utilities: `select id, name from public.utilities order by name`,
  lossReasons: `select id, name from public.deal_loss_reasons where is_active order by sort_order, name`,
  roofTypes: `select id, name from public.roof_types where is_active order by sort_order, name`,
};

export type IntakeRefLists = Record<IntakeRefKey, Array<{ id: string; name: string }>>;

/** Sequentially, on one connection: optionalRows uses savepoints. */
export async function loadIntakeRefs(client: PoolClient): Promise<IntakeRefLists> {
  const refs = {} as IntakeRefLists;
  for (const [key, sql] of Object.entries(REF_SQL) as Array<[IntakeRefKey, string]>) {
    if (key === 'dealers') {
      // Through the directory (004500), which a sales rep can read; the table
      // itself only admin, ops and finance can. Before 004500 the table is
      // asked directly, so an admin's list is never emptier than it was.
      const dir = await optionalQuery<{ id: string; name: string }>(
        client,
        'the dealer directory (public.dealer_directory)',
        'select id, name from public.dealer_directory() where is_active'
      );
      if (dir.available) {
        refs[key] = dir.rows;
        continue;
      }
    }
    refs[key] = await optionalRows<{ id: string; name: string }>(client, `the ${key} list`, sql);
  }
  return refs;
}

/** The file that makes Create Contact work, named where the screen can say it. */
export const CREATE_CONTACT_MIGRATION_FILE = 'db/dist/20260803003700-contact-create.sql';

/**
 * Whether this database can save a new contact yet.
 *
 * Asked before the form is drawn rather than after it is filled in: fifty fields
 * typed out and then refused is the worst possible moment to learn that a file
 * has not been pasted into the SQL editor.
 */
export async function createContactReady(client: PoolClient): Promise<boolean> {
  const rows = await optionalRows<{ ok: boolean }>(
    client,
    'the contact creation function (public.create_contact)',
    `select true as ok where to_regprocedure('public.create_contact(jsonb, jsonb)') is not null`
  );
  return rows.length > 0;
}
