#!/usr/bin/env node
// Bootstrap (or repair) the first admin account — the chicken for the
// /api/invites egg. Creates the auth user with a bcrypt password and an
// admin profile; if the email already exists, resets its password and
// promotes it to admin.
//
// Usage: DATABASE_URL=postgres://... node scripts/create-admin.mjs <email> <password> [full name]

import pg from 'pg';

const [email, password, fullName] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node scripts/create-admin.mjs <email> <password> [full name]');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}

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

try {
  await client.query('begin');

  const existing = await client.query(
    'select id from auth.users where lower(email) = lower($1)',
    [email]
  );

  let userId;
  if (existing.rows[0]) {
    userId = existing.rows[0].id;
    await client.query(
      `update auth.users
       set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf', 12)),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           failed_attempts = 0, locked_until = null, updated_at = now()
       where id = $1`,
      [userId, password]
    );
    await client.query(
      `update public.profiles set role = 'admin', is_active = true where id = $1`,
      [userId]
    );
    console.log(`updated existing user ${email} -> admin, password reset`);
  } else {
    const inserted = await client.query(
      `insert into auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
       values (lower($1),
               extensions.crypt($2, extensions.gen_salt('bf', 12)),
               now(),
               '{"user_role": "admin"}'::jsonb,
               case when $3::text is null then '{}'::jsonb
                    else jsonb_build_object('full_name', $3::text) end)
       returning id`,
      [email, password, fullName ?? null]
    );
    userId = inserted.rows[0].id;
    console.log(`created admin ${email} (${userId})`);
  }

  await client.query(
    `select public.log_audit_event('user.bootstrap_admin', 'profiles', $1::text, null,
                                   jsonb_build_object('email', $2::text))`,
    [userId, email]
  );

  await client.query('commit');
  console.log('done — sign in at /login');
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  console.error(error.message);
  process.exit(1);
} finally {
  await client.end();
}
