-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · 20260803003300_add_sales_role.sql
--
-- Run this one FIRST, on its own, then 20260803003400-crm-foundation.sql. It is separate because a
-- new enum value cannot be referenced in the transaction that adds it, and a
-- pasted script runs as one transaction.
-- ============================================================================

-- >>> 20260803003300_add_sales_role.sql
-- =============================================================================
-- 003300 — Add the Sales role (Modules 16–19, Part 8)
-- =============================================================================
-- "Sales is added as a seventh role. Sales manager and Marketing are capability
-- flags on existing roles, not new roles. Role proliferation is how a permission
-- model stops being auditable."
--
-- Alone in its own migration for the same reason 000800 was: a new enum value
-- cannot be referenced in the transaction that adds it, and the SQL editor runs
-- a pasted script as one transaction. 003400 is the file that uses it.

alter type public.user_role add value if not exists 'sales' after 'ops';

