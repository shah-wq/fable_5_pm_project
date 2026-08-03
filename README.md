# fable_5_pm_project — SolarFlow AI

Solar project-management platform: **Next.js + plain PostgreSQL**. No
external services — auth, sessions, file storage, and authorization all run
in the database and the app server. Built so far:

- **Module 0 — Foundation**: complete schema (§3), row-level security for
  every §2 role, project-scoped file storage, append-only audit log.
- **Module 1 — Authentication**: three login doors (staff password, dealer
  password, customer OTP), DB-backed sessions, role-gated routing, invite
  flows (ADM-02), password recovery, and REQ-SEC-01 no-login upload links
  with a 7-day cap. See `docs/auth.md`.

Requirements to run: **Node.js 20+** and **PostgreSQL 15+** (anywhere — a
VPS, a managed database, or localhost) plus SMTP credentials for outbound
email. The app cannot be exported as a static site (sessions, API routes,
and role gating are server-side).

## Layout

```
src/
  middleware.ts               # edge fast path: no cookie on a protected prefix → login door
  lib/
    db.ts                     # pg pool; every query runs with session claims +
                              #   SET LOCAL ROLE authenticated → RLS enforced in Postgres
    auth/roles.ts             # ROLE_HOME + ROUTE_ACCESS — the single routing truth
    auth/session.ts           # getSession / requireRole / guardPath (authoritative gate)
    email.ts                  # SMTP (nodemailer); dev-logs when unconfigured
    audit.ts                  # logAuditEvent(): the shared audit utility
    storage.ts                # bucket names, path convention, /api/files URLs
  app/
    (auth)/                   # /login (+/reset), /dealers/login, /portal/login
    auth/                     # signout, update-password (invite/recovery landing)
    (app)/                    # /admin, /admin/finance, /pipeline, /designer,
                              #   /portal, /dealers (placeholder surfaces)
    u/[token]/                # REQ-SEC-01 no-login upload page
    api/auth/                 # login, otp request/verify, recovery, set-password
    api/invites/              # ADM-02 admin invites (also used for auto-invites)
    api/u/[token]/            # grant-validated photo upload
    api/files/[id]/           # governed document downloads
    api/health/               # deployment diagnostics
db/
  migrations/                 # 000000 platform · 000100–000900 schema/RLS/audit
                              #   · 001000 auth engine · 001100 file storage
  seed.sql                    # dev reference data
  tests/                      # executable RLS + auth-engine checks
scripts/
  migrate.mjs                 # applies db/migrations against DATABASE_URL
  create-admin.mjs            # bootstraps the first admin account
  verify-local.sh             # ephemeral-postgres run of migrations + both suites
docs/
  rls-matrix.md               # role × table access matrix + design notes
  auth.md                     # auth module: doors, sessions, invites, upload grants
```

## Setup

```sh
npm install
cp .env.example .env.local              # set DATABASE_URL (+ SMTP_* for real email)
npm run db:migrate                      # applies db/migrations (privileged DB user)
npm run db:create-admin -- you@company.com 'a-strong-password' 'Your Name'
npm run dev                             # sign in at /login
```

Production: `npm run build && npm start` behind any Node-capable host, with
the same env vars (`DATABASE_URL`, `SMTP_*`, `NEXT_PUBLIC_SITE_URL` = the
deployed origin). `GET /api/health` reports missing configuration and
whether the schema is applied.

## Verify everything

```sh
npm run db:verify     # 38 RLS assertions + 8 auth-engine suites on an
                      #   ephemeral postgres (needs server binaries v15+)
npm run typecheck     # strict TS
npm run test:unit     # routing-truth unit tests (roles.ts)
npm run build         # next build
```

The SQL suites are the §2 "done when" made executable: per-role claims prove
admin sees all, ops the pipeline, designer their queue, dealer their book,
customer their project, finance only the whitelisted view — plus session,
lockout, OTP, invite, recovery, and upload-grant behavior (7-day cap,
expiry, revocation).

## How authorization works (three layers)

1. `src/middleware.ts` — edge fast path: cookieless requests to protected
   prefixes bounce to the right login door.
2. `guardPath()` in every surface page — validates the session against the
   database (role + is_active re-read per request) and enforces
   `ROUTE_ACCESS`.
3. **RLS in Postgres** — `src/lib/db.ts` runs every query with the session's
   claims under `SET LOCAL ROLE authenticated`, so the §2 policies fire in
   the database no matter what the app layer does.

## Conventions later modules must follow

- **Queries** go through `withUser(session, …)` (or `withAnon` for public
  token paths) from `src/lib/db.ts` — never a bare pool. That's what keeps
  RLS in force.
- **Routing/authorization**: new route groups get an entry in `ROUTE_ACCESS`
  (`src/lib/auth/roles.ts`) and a `guardPath()` call in their page/layout.
- **Files**: keys are `'<project_id>/…'`; bytes go in via governed SQL
  functions and come out via `/api/files/<documentId>` — no public URLs.
- **Audit everything meaningful**: row DML on core tables is automatic;
  app-level events go through `logAuditEvent()`. Actor identity comes from
  session claims in-database; the log is append-only.
- **Invites, not signups**: accounts are created by `POST /api/invites`
  (admin session) — project creation auto-invites its customer through the
  same endpoint.
- **New tables** get RLS in the same migration, built from the `app.*`
  helpers; remember `ops` is staff on all projects.
