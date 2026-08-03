# fable_5_pm_project

Solar project-management platform. This repo currently contains the
**foundation layer**: the complete Supabase schema (§3), Row-Level Security
for every §2 role, private storage buckets with signed-URL access, and the
shared audit-log writer — built first so no later module ever needs a schema
retrofit.

## Layout

```
supabase/
  config.toml                 # local stack config; custom_access_token JWT hook enabled
  migrations/                 # version-controlled schema, applied in order
    ...000100_init_schema_and_enums.sql   # app schema, §2 role enum, status enums
    ...000200_tables.sql                  # all 26 tables incl. AI-era tables
    ...000300_access_helpers.sql          # SECURITY DEFINER helpers policies delegate to
    ...000400_hooks_and_views.sql         # profile bootstrap, JWT role claim hook,
                                          # stage-history trigger, finance whitelist view
    ...000500_audit.sql                   # audit writers: SQL fn + row triggers + RPC
    ...000600_rls_policies.sql            # grants + RLS for every table
    ...000700_storage.sql                 # dwg / deliverables / photos buckets + policies
  seed.sql                    # dev reference data (jurisdictions, price book, ...)
  tests/
    local_shim.sql            # Supabase platform shim for vanilla-postgres testing
    rls_verification.sql      # executable §2 "done when" checks (30 assertions)
scripts/
  verify-local.sh             # ephemeral-postgres run of migrations + RLS suite
  gen-types.mjs               # Docker-free type generation from a live DB
src/lib/
  database.types.ts           # generated — do not edit by hand
  supabase/client.ts          # typed client factories (user + service role)
  audit.ts                    # logAuditEvent(): the shared audit utility
  storage.ts                  # bucket names, path convention, signed URLs
docs/
  rls-matrix.md               # role × table access matrix + design notes
```

## The §2 contract (verified, not just documented)

`scripts/verify-local.sh` boots a throwaway PostgreSQL cluster (no Docker
needed), applies every migration, then queries as each role with that role's
JWT claims:

- **admin** sees all projects
- **designer** sees only their queue
- **customer** sees only their project (customer-visible rows only)
- **dealer** sees only their book
- **finance** sees zero project rows directly and exactly the whitelisted
  columns via `project_financials`

plus storage-bucket policies, audit-log append-only behavior, and a battery of
write-denial checks. Run it:

```sh
npm run db:verify      # requires postgres server binaries (v15+) on PATH
```

## Local development with the real stack

```sh
npx supabase start     # requires Docker
npx supabase db reset  # applies migrations + seed.sql
```

The custom access token hook is enabled in `config.toml`; on a hosted project
enable it under **Authentication → Hooks → Customize Access Token** and point
it at `public.custom_access_token_hook`.

## Regenerating types

```sh
npx supabase gen types typescript --local > src/lib/database.types.ts
# or, without Docker, against any live DB:
DB_URL=postgresql://postgres@127.0.0.1:54322/postgres npm run db:gen-types > src/lib/database.types.ts
```

## Conventions later modules must follow

- **Storage keys** are `'<project_id>/…'` — build them with
  `projectObjectPath()`; policies reject anything else. Buckets are private;
  mint signed URLs via `src/lib/storage.ts`.
- **Audit everything meaningful**: row DML on core tables is audited
  automatically; application-level events go through `logAuditEvent()`
  (`public.log_audit_event` RPC). Actor identity comes from the JWT and cannot
  be spoofed; the log is append-only.
- **New tables** get RLS enabled in the same migration that creates them, with
  policies built from the `app.*` helpers.
- **Roles** live on `profiles.role` only; changing one is admin-only and is
  enforced in-database.
