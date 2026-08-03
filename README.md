# fable_5_pm_project — SolarFlow AI

Solar project-management platform. Built so far:

- **Module 0 — Foundation**: complete Supabase schema (§3), RLS for every §2
  role, private storage buckets with signed URLs, append-only audit log.
- **Module 1 — Authentication**: three login doors (staff password, dealer
  password, customer OTP), role-gated Next.js middleware, invite flows
  (ADM-02), password reset / invite-accept, and REQ-SEC-01 no-login upload
  links with a 7-day cap. See `docs/auth.md`.

## Layout

```
apps/web/                       # Next.js app (App Router, @supabase/ssr)
  src/middleware.ts             # session refresh + role gating per request
  src/lib/
    auth/roles.ts               # ROLE_HOME + ROUTE_ACCESS — the single routing truth
    supabase/{client,server}.ts # browser / server / anon / service clients
    database.types.ts           # generated — do not edit by hand
    audit.ts                    # logAuditEvent(): the shared audit utility
    storage.ts                  # bucket names, path convention, signed URLs
  src/app/
    (auth)/                     # /login (+/reset), /dealers/login, /portal/login
    auth/                       # callback, signout, update-password
    (app)/                      # /admin, /admin/finance, /pipeline, /designer,
                                #   /portal, /dealers (placeholder surfaces)
    u/[token]/                  # REQ-SEC-01 no-login upload page
    api/invites/                # ADM-02 admin invites (also used for auto-invites)
    api/u/[token]/              # grant-validated photo upload endpoint
supabase/
  config.toml                   # local stack config; JWT role-claim hook enabled
  migrations/                   # 000100–000700 foundation · 000800–000900 auth module
  seed.sql                      # dev reference data
  tests/                        # platform shim + executable RLS/grant checks
scripts/
  verify-local.sh               # ephemeral-postgres run of migrations + SQL suite
  gen-types.mjs                 # Docker-free type generation from a live DB
docs/
  rls-matrix.md                 # role × table access matrix + design notes
  auth.md                       # auth module: doors, invites, upload grants
```

## Verify everything

```sh
npm run db:verify                  # 38 SQL assertions: RLS matrix, storage,
                                   #   audit, upload grants (needs postgres v15+)
npm run typecheck                  # strict TS across the app
npm run test:unit -w apps/web      # routing-truth unit tests (roles.ts)
npm run build                      # next build
```

The SQL suite is the §2 "done when" made executable: per-role JWTs prove
admin sees all, ops the pipeline, designer their queue, dealer their book,
customer their project, finance only the whitelisted view — plus that upload
grants open exactly one project and die at 7 days / on revocation.

## Local development

```sh
npx supabase start        # requires Docker
npx supabase db reset     # applies migrations + seed.sql
cd apps/web && cp .env.example .env.local   # fill in keys from `supabase status`
npm run dev -w apps/web
```

Dashboard settings for hosted projects are listed in `docs/auth.md`
(custom access token hook, redirect URLs, OTP length, no public signups).

## Regenerating types

```sh
npx supabase gen types typescript --local > apps/web/src/lib/database.types.ts
# or, without Docker, against any live DB:
DB_URL=postgresql://postgres@127.0.0.1:54322/postgres npm run db:gen-types > apps/web/src/lib/database.types.ts
```

## Conventions later modules must follow

- **Routing/authorization**: new route groups get an entry in `ROUTE_ACCESS`
  (`apps/web/src/lib/auth/roles.ts`); destinations come from `ROLE_HOME`.
  Middleware is UX — RLS is the wall.
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
