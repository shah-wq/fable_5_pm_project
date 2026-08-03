# fable_5_pm_project — SolarFlow AI

Solar project-management platform: a Next.js app (repo root) on Supabase.
Built so far:

- **Module 0 — Foundation**: complete Supabase schema (§3), RLS for every §2
  role, private storage buckets with signed URLs, append-only audit log.
- **Module 1 — Authentication**: three login doors (staff password, dealer
  password, customer OTP), role-gated middleware, invite flows (ADM-02),
  password reset / invite-accept, and REQ-SEC-01 no-login upload links with a
  7-day cap. See `docs/auth.md`.

The app requires a **Node.js runtime** (middleware, auth cookies, API
routes) — deploy to a Next.js-capable platform; it cannot be exported as a
static site.

## Layout

```
src/
  middleware.ts               # session refresh + role gating per request
  lib/
    auth/roles.ts             # ROLE_HOME + ROUTE_ACCESS — the single routing truth
    supabase/                 # browser / server / anon / service clients + env
    database.types.ts         # generated — do not edit by hand
    audit.ts                  # logAuditEvent(): the shared audit utility
    storage.ts                # bucket names, path convention, signed URLs
  app/
    (auth)/                   # /login (+/reset), /dealers/login, /portal/login
    auth/                     # callback, signout, update-password
    (app)/                    # /admin, /admin/finance, /pipeline, /designer,
                              #   /portal, /dealers (placeholder surfaces)
    u/[token]/                # REQ-SEC-01 no-login upload page
    api/invites/              # ADM-02 admin invites (also used for auto-invites)
    api/u/[token]/            # grant-validated photo upload endpoint
supabase/
  config.toml                 # local stack config; JWT role-claim hook enabled
  migrations/                 # 000100–000700 foundation · 000800–000900 auth module
  seed.sql                    # dev reference data
  tests/                      # platform shim + executable RLS/grant checks
scripts/
  verify-local.sh             # ephemeral-postgres run of migrations + SQL suite
  gen-types.mjs               # Docker-free type generation from a live DB
docs/
  rls-matrix.md               # role × table access matrix + design notes
  auth.md                     # auth module: doors, invites, upload grants
```

## Verify everything

```sh
npm run db:verify     # 38 SQL assertions: RLS matrix, storage, audit,
                      #   upload grants (needs postgres v15+)
npm run typecheck     # strict TS
npm run test:unit     # routing-truth unit tests (roles.ts)
npm run build         # next build
```

The SQL suite is the §2 "done when" made executable: per-role JWTs prove
admin sees all, ops the pipeline, designer their queue, dealer their book,
customer their project, finance only the whitelisted view — plus that upload
grants open exactly one project and die at 7 days / on revocation.

## Setup against a Supabase project

```sh
npx supabase link --project-ref <your-project-ref>
npx supabase db push                      # applies supabase/migrations
cp .env.example .env.local                # fill in URL + keys
npm install && npm run dev
```

Dashboard settings (hosted): enable the custom access token hook
(`public.custom_access_token_hook`), add `<origin>/auth/callback` to auth
redirect URLs, disable public password sign-ups, OTP length 6 — details in
`docs/auth.md`. Bootstrap the first admin by creating a user in the
dashboard, then `update public.profiles set role = 'admin' where email = …`.

Deploy env vars: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or `…_ANON_KEY`),
`SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`, server-only), and
`NEXT_PUBLIC_SITE_URL` (deployed origin).

## Regenerating types

```sh
npx supabase gen types typescript --local > src/lib/database.types.ts
# or, without Docker, against any live DB:
DB_URL=postgresql://postgres@127.0.0.1:54322/postgres npm run db:gen-types > src/lib/database.types.ts
```

## Conventions later modules must follow

- **Routing/authorization**: new route groups get an entry in `ROUTE_ACCESS`
  (`src/lib/auth/roles.ts`); destinations come from `ROLE_HOME`. Middleware
  is UX — RLS is the wall.
- **Storage keys** are `'<project_id>/…'` — build with `projectObjectPath()`;
  buckets are private, downloads via signed URLs (`src/lib/storage.ts`).
- **Audit everything meaningful**: row DML on core tables is automatic;
  app-level events go through `logAuditEvent()`. Actor identity comes from
  the JWT and cannot be spoofed; the log is append-only.
- **Invites, not signups**: accounts are created by `POST /api/invites`
  (admin session) — project creation auto-invites its customer through the
  same endpoint.
- **New tables** get RLS in the same migration, built from the `app.*`
  helpers; remember `ops` is staff on all projects.
