#!/usr/bin/env node
/**
 * The permanent demo customer account (mobile spec §7, §10).
 *
 * App review needs a working login every single submission, support needs one
 * to reproduce bugs, and sales will want it for demonstrations. A real
 * customer's project must never be used for any of that.
 *
 * Creates (or refreshes) a dealer, a customer, and one project sitting in
 * Inspection & Power On with a plausible history: every earlier stage completed
 * with dates, an approved adder, payments received, an install photo, a signed
 * agreement and a permit letter, plus one message thread. Re-running it resets
 * the project to that same state, so the demo never drifts.
 *
 *   DATABASE_URL=postgres://... node scripts/create-demo-customer.mjs [password]
 */

import pg from 'pg';

const password = process.argv[2] ?? 'DemoReview2026!';
const EMAIL = 'demo@solarflow.app';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Set DATABASE_URL to a postgres connection string.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

/** A tiny valid JPEG (a solid amber square) so the gallery is not empty. */
const PHOTO = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwc' +
    'JC4nICIsIxwcKDcpLDA1NTU1NTU1NTU1NTU1NTU1NTU1/9sAQwEJCQkMCwwYDQ0YMiEcITIyMjIyMjIy' +
    'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAQABADASIAAhEBAxEB' +
    '/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQR' +
    'BRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpT' +
    'VFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLD' +
    'xMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigD//Z',
  'base64'
);

try {
  await client.query('begin');

  // --- dealer -------------------------------------------------------------
  let dealer = (
    await client.query(`select id from public.dealers where name = 'SolarFlow Demo'`)
  ).rows[0];
  if (!dealer) {
    dealer = (
      await client.query(
        `insert into public.dealers (name, email, is_active)
         values ('SolarFlow Demo', $1, true) returning id`,
        [EMAIL]
      )
    ).rows[0];
  }

  // --- login --------------------------------------------------------------
  let user = (
    await client.query(`select id from auth.users where lower(email) = lower($1)`, [EMAIL])
  ).rows[0];
  if (user) {
    await client.query(
      `update auth.users set
         encrypted_password = extensions.crypt($2, extensions.gen_salt('bf', 12)),
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         force_password_change = false,
         failed_attempts = 0, locked_until = null
       where id = $1`,
      [user.id, password]
    );
  } else {
    user = (
      await client.query(
        `insert into auth.users
           (email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
         values ($1, extensions.crypt($2, extensions.gen_salt('bf', 12)), now(),
                 '{"user_role":"customer"}'::jsonb, '{"full_name":"Alex Demo"}'::jsonb)
         returning id`,
        [EMAIL, password]
      )
    ).rows[0];
  }
  await client.query(
    `insert into public.profiles (id, role, email, full_name, is_active)
     values ($1, 'customer', $2, 'Alex Demo', true)
     on conflict (id) do update set role = 'customer', is_active = true`,
    [user.id, EMAIL]
  );

  // --- customer record ----------------------------------------------------
  let customer = (
    await client.query(`select id from public.clients where user_id = $1`, [user.id])
  ).rows[0];
  if (!customer) {
    customer = (
      await client.query(
        `insert into public.clients (dealer_id, first_name, last_name, email, phone, user_id)
         values ($1, 'Alex', 'Demo', $2, '555-0100', $3)
         returning id`,
        [dealer.id, EMAIL, user.id]
      )
    ).rows[0];
  }

  // --- the project --------------------------------------------------------
  let project = (
    await client.query(
      `select id from public.projects where client_id = $1 order by created_at limit 1`,
      [customer.id]
    )
  ).rows[0];
  if (!project) {
    project = (
      await client.query(
        `insert into public.projects
           (name, address, dealer_id, client_id, stage, status, contract_value, system_size_kw,
            module_quantity, inverter_quantity, battery_quantity, customer_estimate, created_at)
         values ('Alex Demo', '1200 Sample Street, Austin, TX 78701', $1, $2,
                 'inspection_pto', 'active', 38500, 9.2, 23, 1, 1, 'Next month',
                 now() - interval '110 days')
         returning id`,
        [dealer.id, customer.id]
      )
    ).rows[0];
  } else {
    await client.query(
      `update public.projects set
         stage = 'inspection_pto', status = 'active', contract_value = 38500,
         system_size_kw = 9.2, module_quantity = 23, inverter_quantity = 1,
         battery_quantity = 1, customer_estimate = 'Next month'
       where id = $1`,
      [project.id]
    );
  }

  // --- a plausible history through every earlier stage --------------------
  const stages = [
    [
      'stage1_survey',
      `survey_status = 'completed', survey_completed_date = current_date - 96,
       down_payment_status = 'received', down_payment_received_date = current_date - 104`,
    ],
    [
      'stage2_design',
      `design_status = 'received', design_received_date = current_date - 88,
       stamps_status = 'received', stamps_received_date = current_date - 84`,
    ],
    [
      'stage3_permit',
      `permit_status = 'approved', permit_applied_date = current_date - 80,
       permit_received_date = current_date - 52,
       ica_status = 'approved', ica_applied_date = current_date - 78,
       ica_received_date = current_date - 44, hoa_status = 'na'`,
    ],
    [
      'stage4_procurement',
      `material_status = 'delivered', material_requested_date = current_date - 50,
       material_delivered_date = current_date - 30`,
    ],
    [
      'stage5_install',
      `install_status = 'completed', install_scheduled_date = current_date - 20,
       install_completed_date = current_date - 18`,
    ],
    [
      'stage6_inspection',
      `inspection_status = 'passed', inspection_requested_date = current_date - 14,
       inspection_completed_date = current_date - 7, pto_status = 'applied',
       pto_applied_date = current_date - 6`,
    ],
  ];
  for (const [table, sets] of stages) {
    await client.query(
      `insert into public."${table}" (project_id) values ($1)
       on conflict (project_id) do nothing`,
      [project.id]
    );
    await client.query(`update public."${table}" set ${sets} where project_id = $1`, [project.id]);
  }

  // Stage history, so 'Recent updates' has something in it.
  await client.query(`delete from public.project_stage_events where project_id = $1`, [project.id]);
  await client.query(
    `insert into public.project_stage_events (project_id, from_stage, to_stage, changed_at)
     values ($1, 'survey', 'design',            now() - interval '95 days'),
            ($1, 'design', 'permits',           now() - interval '82 days'),
            ($1, 'permits', 'procurement',      now() - interval '43 days'),
            ($1, 'procurement', 'install',      now() - interval '22 days'),
            ($1, 'install', 'inspection_pto',   now() - interval '15 days')`,
    [project.id]
  );

  // An approved change, so the revised total is demonstrable.
  await client.query(`delete from public.project_adders where project_id = $1`, [project.id]);
  await client.query(
    `insert into public.project_adders (project_id, name, amount, approved)
     values ($1, 'Main panel upgrade', 1850, true)`,
    [project.id]
  );

  // --- documents and a photo ---------------------------------------------
  await client.query(
    `delete from storage.objects where name like $1`,
    [`${project.id}/demo/%`]
  );
  await client.query(`delete from public.documents where project_id = $1`, [project.id]);

  const files = [
    ['Signed agreement', 'signed_co', 'application/pdf', 'project-deliverables',
      Buffer.from('%PDF-1.4\n% SolarFlow demo agreement\n')],
    ['City permit', 'permit_letter_city', 'application/pdf', 'project-deliverables',
      Buffer.from('%PDF-1.4\n% SolarFlow demo permit\n')],
    ['Your new array', 'install_photo', 'image/jpeg', 'project-photos', PHOTO],
  ];
  for (const [title, category, mime, bucket, data] of files) {
    const path = `${project.id}/demo/${category}`;
    const object = (
      await client.query(
        `insert into storage.objects (bucket_id, name) values ($1, $2) returning id`,
        [bucket, path]
      )
    ).rows[0];
    await client.query(`insert into storage.object_data (object_id, data) values ($1, $2)`, [
      object.id,
      data,
    ]);
    await client.query(
      `insert into public.documents
         (project_id, bucket, object_path, kind, category, title, mime_type, size_bytes,
          customer_visible)
       values ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
      [
        project.id, bucket, path,
        mime === 'application/pdf' ? 'pdf' : 'photo',
        category, title, mime, data.length,
      ]
    );
  }

  // --- one message thread, already answered ------------------------------
  await client.query(`delete from public.customer_requests where project_id = $1`, [project.id]);
  await client.query(
    `insert into public.customer_requests
       (project_id, client_id, kind, message, pm_reply, status, resolved_at, created_at)
     values ($1, $2, 'question',
             'The panels are up — when will the system actually switch on?',
             'The city inspection passed last week and the utility has our application. As soon as they approve it we will switch you on and let you know.',
             'resolved', now() - interval '4 days', now() - interval '5 days')`,
    [project.id, customer.id]
  );

  // --- and one outstanding ask, so the app has something to demonstrate --
  await client.query(`delete from public.customer_asks where project_id = $1`, [project.id]);
  await client.query(
    `insert into public.customer_asks (project_id, kind, label, detail)
     values ($1, 'photo', 'A photo of your electricity meter',
             'We need the serial number for the utility paperwork.')`,
    [project.id]
  );

  await client.query('commit');
  console.log(`
Demo customer ready — use this for every app review submission:

  Email:    ${EMAIL}
  Password: ${password}
  Door:     Customer

The project sits in Inspection & Power On with six completed stages, an approved
adder, three documents, a photo, an answered message and one outstanding
request, so a reviewer sees a populated app rather than empty states.

Re-run this script any time to reset it to exactly this state.
`);
} catch (error) {
  await client.query('rollback');
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end();
}
