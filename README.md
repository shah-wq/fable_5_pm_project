# fable_5_pm_project — SolarFlow AI

Solar project-management platform: **Next.js + plain PostgreSQL**. No
external services — auth, sessions, file storage, and authorization all run
in the database and the app server. Built so far:

- **Module 0 — Foundation**: complete schema (§3), row-level security for
  every §2 role, project-scoped file storage, append-only audit log.
- **Module 2 — Pipeline & Projects**: the six-stage Kanban board (drag with the same validation as the advance button, snap-back + missing-items toast, admin-only backwards moves with logged reasons), the searchable/filterable Projects tab, project creation, the stage stepper, and the full stage data model + rules engine for all six manual stage forms. See `docs/rls-matrix.md` and the spec rules in `src/lib/stages/`.
- **Module 3 — Admin panel**: Users & roles (admin-set passwords with force-change-on-first-login, invitations with resend/cancel, disable, guarded history-preserving delete, self-service password change for every role), reference-record sections (surveyors, designers, crews, vendors, dealers, jurisdictions, utilities, HOAs, finance partners — deactivate, never delete), company settings, and the searchable activity-log viewer.
- **Module 4 — Stage forms**: the seven stages from the Stage Field Specification (Survey → Design → Permit → Procurement → Installation → Inspection & PTO → Complete) plus Hold and Cancelled side stages reachable from anywhere, bypassing validation. Payment milestones, five Permit tracks, partner-labelled Finance M1/M2, collapsible track cards with status chips and live Days counters, status→date auto-stamping, conditional requirements, uploads, and the Drive Updated gate. One registry (`src/lib/stages/fields.ts`) drives the renderer, persistence, and advance gates; one move service drives the button, the board drag, and hold/cancel/resume/reinstate.
- **Module 1 — Authentication**: three login doors (staff password, dealer
  password, customer OTP), DB-backed sessions, role-gated routing, invite
  flows (ADM-02), password recovery, and REQ-SEC-01 no-login upload links
  with a 7-day cap. See `docs/auth.md`.

- **Customer mobile app**: the customer portal delivered as an installable app —
  five tabs (Home · Project · Documents · Photos · More), web push with deferred
  permission and deep links, an offline read cache with a visible "last updated"
  stamp, camera upload with on-device compression and a retrying queue, in-app
  PDF viewing and the native share sheet, biometric app lock, in-app account
  deletion, and a forced-update floor. **One database, one API, one set of RLS
  policies** — the app is this web surface in a native shell, never a second
  backend. The `android/` and `ios/` Capacitor projects are committed and
  configured, and two GitHub Actions workflows build them on hosted runners —
  Actions → **Build Android app** produces an installable APK with no developer
  account at all. See `docs/mobile-store-submission.md`.

Requirements to run: **Node.js 20+** and **PostgreSQL 15+** (anywhere — a
VPS, a managed database, or localhost) plus SMTP credentials for outbound
email. Push notifications additionally need a VAPID key pair
(`npm run make:vapid`). The app cannot be exported as a static site (sessions, API routes,
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
