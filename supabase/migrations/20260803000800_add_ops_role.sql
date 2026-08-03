-- =============================================================================
-- 000800 — Add the Ops/PM role (§2 addendum, auth module)
-- =============================================================================
-- Ops runs the whole pipeline: project visibility like admin, but no admin
-- panel and no audit-log access. Kept in its own migration because a new enum
-- value cannot be referenced in the transaction that adds it — 000900 updates
-- the helpers and policies.

alter type public.user_role add value if not exists 'ops' after 'admin';
