# Auth module (Module 1)

Supabase Auth wired into Next.js (`apps/web`), per the SolarFlow AI auth
model: three doors, one routing truth, role-gated middleware, invite flows,
and the REQ-SEC-01 no-login upload links.

| Audience | Page | Method | Lands on |
|---|---|---|---|
| Admin | `/login` | email + password | `/admin` |
| PM (Ops) | `/login` | email + password | `/pipeline` |
| Designer / Finance | `/login` (same page) | email + password | `/designer` · `/admin/finance` |
| Dealers | `/dealers/login` | email + password | `/dealers` |
| Customers | `/portal/login` | email OTP (6-digit) — no passwords | `/portal` |

The destination is decided by `profiles.role` **after** authentication —
never by which door was used or anything the client claims. Signing in with
valid credentials at the wrong door signs the session back out and points at
the right door.

## Where things live

- `apps/web/src/lib/auth/roles.ts` — `ROLE_HOME`, `ROUTE_ACCESS`,
  `LOGIN_DOORS`, `sanitizeNextPath`. The single place that decides who sees
  what. Unit-tested (`npm run test:unit -w apps/web`).
- `apps/web/src/middleware.ts` — session refresh (`@supabase/ssr` cookies) +
  role gating per request: reads `profiles.role` and `is_active`, redirects
  wrong-role visitors to their home, force-signs-out deactivated accounts,
  returns 403 JSON for `/api/*`. `/u/*` and `/api/u/*` are excluded from the
  matcher — token holders never carry a session.
- `apps/web/src/app/(auth)/…` — the three doors + `/login/reset`, sharing the
  navy brand panel with the six-stage rail.
- `apps/web/src/app/auth/callback/route.ts` — every emailed link (invite,
  recovery, magic) lands here; PKCE code → session → relative-only `next`.
- `apps/web/src/app/auth/update-password/…` — invite-accept and recovery both
  finish here (set password → role home).

## Invitations (ADM-02)

`POST /api/invites` (admin only — middleware gate + in-route re-check):

```json
{ "email": "pm@acme.com", "role": "ops", "fullName": "Sam PM" }
{ "email": "d@acme.com",  "role": "dealer",   "dealerId": "…" }
{ "email": "h@ex.com",    "role": "customer", "projectId": "…" }
```

- Supabase sends the invite email (service key, server-only). Staff/dealer
  links land on set-password; customers land on `/portal` and use OTP —
  they never have a password.
- Role assignment, dealer/designer/client linking run with the **admin's own
  session**, so the in-database role-change guard applies and the profiles
  audit trigger records the real actor. An explicit `user.invited` audit
  event is written on top.
- Later modules reuse this endpoint: project creation auto-invites the
  customer; lead conversion (when leads exist) calls it from the welcome
  flow.

Public password sign-up stays disabled (dashboard setting); the customer OTP
form passes `shouldCreateUser: false`, so no login page can mint an account.

## No-login upload links (REQ-SEC-01)

Single-project magic links for surveyor photos, crew work-order uploads, and
customer delivery photos:

- Minted by project staff via `public.create_upload_grant(project_id,
  purpose, ttl)` — TTL is clamped to **7 days** in the database. Only the
  sha-256 of the token is stored; the raw token exists once, in the URL.
- `/u/<token>` validates through `public.validate_upload_grant` (anon RPC:
  the token is the credential) and shows exactly that project's upload page.
  Expired/revoked/unknown tokens all get the same dead-link page.
- Uploads POST to `/api/u/<token>`: the token is re-validated per request
  (410 after expiry/revocation), files go to the private `project-photos`
  bucket, a `documents` row records each (delivery photos are
  `customer_visible`), and `document.uploaded_via_grant` is audited.
- `public.revoke_upload_grant(id)` kills a link immediately. Creation,
  revocation, and usage counting are all covered by the SQL test suite.

## Supabase dashboard settings

- **Auth → Email**: Email provider on; OTP length 6. Disable public password
  sign-ups — accounts come only from `/api/invites`.
- **Auth → URL configuration**: add `https://yourdomain/auth/callback`.
- **Auth → Hooks**: custom access token hook →
  `public.custom_access_token_hook` (already enabled in `config.toml` for
  local dev).

## Deliberately deferred

- Biometric login → Capacitor wrap (MOB spec).
- OTP throttling beyond Supabase's built-in rate limits.
- Crew work-order *viewing* via grant links (upload-only for now; the
  work-order document surface arrives with the install module).
