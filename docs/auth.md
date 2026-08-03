# Auth module (Module 1) — plain-Postgres edition

Authentication runs entirely on PostgreSQL + Next.js: bcrypt passwords,
DB-backed sessions, emailed OTP codes, one-time invite/recovery tokens.
Three doors, one routing truth, role-gated server rendering, and the
REQ-SEC-01 no-login upload links.

| Audience | Page | Method | Lands on |
|---|---|---|---|
| Admin | `/login` | email + password | `/admin` |
| PM (Ops) | `/login` | email + password | `/pipeline` |
| Designer / Finance | `/login` (same page) | email + password | `/designer` · `/admin/finance` |
| Dealers | `/dealers/login` | email + password | `/dealers` |
| Customers | `/portal/login` | email OTP (6-digit) — no passwords | `/portal` |

The destination is decided by `profiles.role` **after** authentication —
never by which door was used. Valid credentials at the wrong door come back
as a pointer to the right one, with the session revoked.

## How it works

- **Credentials/sessions live in the database** (`db/migrations/…001000_auth_engine.sql`):
  `auth.users` (bcrypt via pgcrypto), `auth.sessions` (sha-256 of an opaque
  cookie token, 7-day lifetime, revocable), `auth.one_time_tokens` (invite
  7d / recovery 1h / OTP 10min with 5 attempts). The app role can only call
  the SECURITY DEFINER flows (`login_with_password`, `validate_session`,
  `request_otp`/`verify_otp`, `create_invited_user`,
  `set_password_with_token`, …) — never the tables. 10 consecutive bad
  passwords lock the account for 10 minutes; login flows return nothing
  distinguishable for bad email vs bad password vs locked.
- **Every request re-derives role + is_active from profiles**
  (`auth.validate_session`), so role changes and deactivations bite on the
  next request. Deactivated accounts are force-signed-out everywhere.
- **RLS still runs in Postgres.** `src/lib/db.ts` wraps every query in a
  transaction that sets `request.jwt.claims` from the session and
  `SET LOCAL ROLE authenticated` — the entire §2 policy layer from Module 0
  is enforced by the database, even if `DATABASE_URL` is a superuser.
- **Enforcement layers**: `src/middleware.ts` is an edge-safe fast path
  (no cookie on a protected prefix → login door / 401). The authoritative
  gate is server-side: `guardPath()`/`requireRole()`
  (`src/lib/auth/session.ts`) run before any surface renders, driven by
  `ROUTE_ACCESS` in `src/lib/auth/roles.ts` — the single routing truth
  (unit-tested). RLS is the wall beneath both.

## Invitations (ADM-02)

`POST /api/invites` (admin only; also guarded in-database):

```json
{ "email": "pm@acme.com", "role": "ops", "fullName": "Sam PM" }
{ "email": "d@acme.com",  "role": "dealer",   "dealerId": "…" }
{ "email": "h@ex.com",    "role": "customer", "projectId": "…" }
```

- Staff/dealers get a 7-day single-use set-password link
  (`/auth/update-password?token=…`); customers get a welcome email pointing
  at the OTP door — they never have a password.
- User creation and dealer/designer/client linking run with the **admin's
  own claims**: the role guard applies and audit triggers record the real
  actor; `user.invited` is logged explicitly.
- If SMTP delivery fails, the response includes the invite link so the admin
  can hand it over manually.
- Later modules reuse this endpoint: project creation auto-invites the
  customer; lead conversion calls it from the welcome flow.
- First admin (nothing to sign in with yet):
  `DATABASE_URL=… npm run db:create-admin -- you@company.com 'password' 'Your Name'`

Password recovery: `/login/reset` → emailed 1-hour single-use link → sets the
password, revokes every other session, signs in. Customers are excluded
(OTP-only) and the endpoint never discloses whether an account exists.

## No-login upload links (REQ-SEC-01)

- Staff mint via `public.create_upload_grant(project_id, purpose, ttl)` —
  TTL clamped to **7 days** in the database; only the token's sha-256 is
  stored.
- `/u/<token>` resolves through `public.validate_upload_grant` and shows
  exactly that project's upload page. Expired/revoked/unknown all get the
  same dead-link page. The `/u/*` subtree is excluded from the middleware —
  token holders never get a session.
- `POST /api/u/<token>` re-validates per request (410 once dead) and hands
  the file to `public.record_grant_upload`: photo mime + 25 MB checks, bytes
  into `storage.object_data`, a `documents` row (delivery photos are
  customer-visible), and an audit entry — one transaction.
- Downloads go through `GET /api/files/<documentId>` →
  `public.read_document`: project participants only, customers only see
  customer-visible files, DWG bytes stay staff-only.
- `public.revoke_upload_grant(id)` kills a link immediately. The whole
  lifecycle is covered by `db/tests/`.

## Email

`src/lib/email.ts` sends over SMTP (`SMTP_HOST/PORT/USER/PASS`,
`EMAIL_FROM`) — any provider works, including a Hostinger mailbox. Without
SMTP: development logs the message to the server console so flows stay
testable; production fails loudly (a 502 on the requesting endpoint) so
missing configuration can't silently eat invitations.

## Verification

- `npm run db:verify` — 38 RLS assertions + 8 auth-engine suites (invite →
  accept → login, session lifecycle, deactivation, lockout, OTP with attempt
  caps, recovery revoking sessions, invite privilege guard, grant
  upload/download rules) on an ephemeral Postgres.
- `npm run test:unit` — routing-truth tests.
- The full HTTP flow (login, wrong door, role redirects, magic-link
  upload/download, signout) was smoke-tested end-to-end against a live
  Postgres + `next start`.

## Deliberately deferred

- Biometric login → Capacitor wrap (MOB spec).
- Change-password-while-signed-in UI (admin panel module; recovery covers it
  until then).
- CSRF tokens beyond SameSite=Lax cookies + JSON-only endpoints; add
  origin-checking middleware if embedding needs arise.
- Crew work-order *viewing* via grant links (upload-only for now).
