# RLS access matrix (§2)

Source of truth: `supabase/migrations/20260803000600_rls_policies.sql` (tables)
and `20260803000700_storage.sql` (storage). Executable proof:
`supabase/tests/rls_verification.sql`, run via `scripts/verify-local.sh`.

## How a request is authorized

1. Every user has exactly one §2 role on `public.profiles.role`
   (`admin | designer | customer | dealer | finance`).
2. `public.custom_access_token_hook` stamps that role into the JWT as the
   `user_role` claim at token mint time; `app.current_user_role()` reads the
   claim (falling back to a profiles lookup for pre-hook sessions).
3. Policies delegate to `SECURITY DEFINER` helpers in the `app` schema —
   `can_access_project()`, `is_project_staff()`, `current_dealer_ids()`,
   `current_client_ids()`, `current_designer_id()` — so the §2 rules live in
   one place and policy evaluation never recurses into RLS.
4. `service_role` bypasses RLS entirely (trusted server-side jobs only);
   `anon` has no grants on any table.

Identity chains: a **designer** is `designers.user_id = auth.uid()`, their
queue is `projects.assigned_designer_id = designers.id`. A **dealer** user is
`dealer_users.user_id = auth.uid()`, their book is
`projects.dealer_id ∈ their dealers`. A **customer** is
`clients.user_id = auth.uid()`, their project is
`projects.client_id ∈ their client records`.

## Finance: whitelisted columns

Finance has **no SELECT policy on `projects`** (zero rows) and reads through
`public.project_financials`, a `security_barrier` view whose WHERE clause
admits only finance/admin. Whitelist: `id, code, name, stage, status,
dealer_id, client_id, system_size_kw, contract_value, dealer_fee,
amount_invoiced, amount_paid, target_install_date, created_at, updated_at`.
Excluded on purpose: `site_address`, `metadata`, `assigned_designer_id`,
`priority`, and all client PII (finance also has zero rows on `clients`).
The view is read-only (writes revoked + not auto-updatable).

## Table matrix

Legend: ✅ full · rows/cols noted otherwise · — no access.
Admin has full access to every table and is omitted from the notes.

| Table | designer | dealer | customer | finance |
|---|---|---|---|---|
| `profiles` | own row (R/W; role change admin-only) | own row | own row | own row |
| `dealers` | — | own orgs (R) | — | all (R, names for reporting) |
| `dealer_users` | — | own orgs (R) | own memberships (R) | — |
| `designers` | own row (R/W) | — | — | — |
| `clients` | clients on their queue (R) | own book (R/I/U) | own record (R) | — |
| `jurisdictions` | R | R | R | R |
| `utilities` | R | R | R | R |
| `price_book` | R | — | — | R |
| `adder_rules` | R | R | — | R |
| `vendors` | R | — | — | R |
| `projects` | queue (R/U) | book (R/I/U; can't leave book) | own project (R) | — (view only) |
| `project_stage_events` | queue (R; insert as staff) | book (R) | own project (R) | — |
| `availability_slots` | own calendar (R/I/U/D) | open slots (R) + booked on book | open slots (R) + booked on own | open slots (R) |
| `documents` | queue (R/I/U) | book (R/I) | own project, `customer_visible` only (R); photo uploads (I) | — |
| `designs` | queue (R/I/U) | book (R) | own project, approved only (R) | — |
| `design_assets` | queue (R/I/U/D) | book (R) | own project, approved designs (R) | — |
| `site_surveys` | queue (R/I/U) | book (R/I/U) | own project (R) | — |
| `project_adders` | queue (R/I/U/D) | book (R) | — | all (R) |
| `change_orders` | queue (R/I/U) | book (R/I/U) | own project (R) | all (R) |
| `vendor_quotes` | queue (R/I/U) | — | — | all (R) |
| `bom_items` | queue (R/I/U/D) | — | — | all (R) |
| `permits` | queue (R/I/U) | book (R) | own project (R) | — |
| `permit_events` | queue (R; insert as staff) | book (R) | own project (R) | — |
| `stage_feedback` | queue (R); insert as self | own rows (R); insert as self | own rows (R); insert as self | — |
| `exceptions` | queue + assigned-to-me (R/I/U) | — | — | — |
| `audit_log` | — | — | — | — (admin read-only; see below) |

Write escalations everywhere else are admin-only (deletes of business records,
reference-data management, role changes).

## Storage buckets

All buckets are **private**; object keys must be `'<project_id>/…'` —
`app.storage_object_project()` extracts the prefix and policies reject
anything else. Downloads use signed URLs (`src/lib/storage.ts`).

| Bucket | read | write |
|---|---|---|
| `project-dwg` (CAD, 100 MB) | staff of that project | staff |
| `project-deliverables` (PDF only, 50 MB) | all project participants incl. customer | staff |
| `project-photos` (images, 25 MB) | all project participants | all participants; delete: staff or uploader |

"Staff" = admin or the project's assigned designer (`app.is_project_staff`).

## Audit log

- **Writers** (the shared utility later modules call):
  - `app.write_audit(...)` — from any SQL function/trigger.
  - `audit_row` triggers — automatic OLD/NEW capture on projects, clients,
    designs, change_orders, permits, project_adders, bom_items, vendor_quotes,
    exceptions, documents, price_book, adder_rules, profiles.
  - `public.log_audit_event(...)` RPC ⇄ `logAuditEvent()` in `src/lib/audit.ts`
    for app-level events.
- Actor identity (`actor_id`, `actor_role`) is resolved from the JWT inside
  the SECURITY DEFINER writer — callers cannot spoof it.
- Reads: **admin only**. Direct INSERT/UPDATE/DELETE: revoked for clients, and
  a trigger raises on UPDATE/DELETE so the log is append-only even for
  privileged SQL.

## Known scope notes (phase-one deliberate)

- Field-level write guards inside a permitted row (e.g. a dealer editing
  `contract_value` on their own project) are an application-layer concern for
  the pricing module; RLS scopes *which rows*, not *which columns*, may
  change. The finance read whitelist, role changes, and audit immutability —
  where column/row integrity is security-critical — are enforced in-database.
- Booking an open `availability_slot` by a dealer/customer will ship as a
  SECURITY DEFINER RPC in the scheduling module; direct slot writes stay
  designer/admin-only.
