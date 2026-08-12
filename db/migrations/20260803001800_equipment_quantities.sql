-- =============================================================================
-- 001800 — Inverter & battery quantities
-- =============================================================================
-- The system specification carries how many of each, not just which model:
-- module_quantity arrived with 001700; inverter and battery counts join it.

alter table public.projects
  add column if not exists inverter_quantity integer check (inverter_quantity > 0),
  add column if not exists battery_quantity  integer check (battery_quantity > 0);
