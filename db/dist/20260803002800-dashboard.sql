-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module only · 20260803002800_dashboard.sql
--
-- For a database that is already up to date apart from this module. Paste the
-- whole file into a SQL console (e.g. the Neon SQL Editor) and run it once.
-- Safe to run again: every statement skips work already done, so 'already
-- exists' errors cannot happen. NOTICE lines saying 'does not exist, skipping'
-- are normal. The bookkeeping row at the end is included.
--
-- Behind by more than this module? Run catch-up-1.sql then catch-up-2.sql
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803002800_dashboard.sql
-- =============================================================================
-- 002800 — Analytics dashboard
-- =============================================================================
-- Implements the Dashboard Module specification. The whole module rests on one
-- idea from spec §1: nothing is a hand-maintained list. Every figure is a live
-- aggregate over whatever exists in the database right now, grouped by
-- assigned_pm / dealer_id / stage — never by a chart configured with today's
-- five PMs. A new hire's projects therefore appear in the totals the first time
-- one is assigned to them, with no dashboard edit.
--
-- What this migration adds:
--   1. public.stage_thresholds — the per-stage ageing thresholds, in the
--      database rather than in code, because §7 and §10 both say they will be
--      re-tuned repeatedly in the first months.
--   2. public.project_metrics — ONE row per project carrying every figure the
--      dashboard derives: days in stage, hold days, the seven per-stage day
--      counters, total days with and without hold time, the age band, and
--      whether the project is past its stage's threshold. Every chart is a
--      `group by` over this view, which is what keeps §10's "aggregate in SQL,
--      not in the browser" honest.
--   3. Indexes on the columns those group-bys actually use.
--   4. Two app_settings fields: the on-hold amber threshold and whether the
--      ops role sees the financial cards (§8).
--
-- Not added, deliberately: a materialised view. §10 offers one "when needed"
-- for cycle-time aggregates, and it is not needed yet — but more to the point,
-- this deployment has no scheduler (everything is operated from a browser), so
-- a materialised view would go stale with nothing to refresh it and quietly
-- report last week's numbers. An ordinary view that is always right beats a
-- fast one that is sometimes wrong. Revisit when there is a cron and a few
-- thousand projects.

-- -----------------------------------------------------------------------------
-- 1. Per-stage ageing thresholds (admin config, spec §7)
-- -----------------------------------------------------------------------------
-- "A week in Procurement is fine, a week in Installation is not" — so this is
-- one row per stage, not one global number.

create table if not exists public.stage_thresholds (
  stage          public.project_stage primary key,
  attention_days integer not null check (attention_days between 1 and 3650),
  updated_at     timestamptz not null default now()
);

insert into public.stage_thresholds (stage, attention_days) values
  ('survey',         10),
  ('design',         14),
  ('permits',        30),
  ('procurement',    21),
  ('install',         7),
  ('inspection_pto', 30),
  -- Complete is terminal; it never ages. A real number rather than a null
  -- keeps every join inner and every comparison total.
  ('complete',     3650)
on conflict (stage) do nothing;

alter table public.stage_thresholds enable row level security;
grant select on public.stage_thresholds to authenticated;
grant insert, update on public.stage_thresholds to authenticated;

-- Readable by everyone signed in: the same threshold decides what appears in a
-- dealer's own ageing list, and the number itself reveals nothing.
drop policy if exists stage_thresholds_select on public.stage_thresholds;
create policy stage_thresholds_select on public.stage_thresholds
  for select to authenticated using (true);

drop policy if exists stage_thresholds_write on public.stage_thresholds;
create policy stage_thresholds_write on public.stage_thresholds
  for update to authenticated
  using ((select app.is_admin())) with check ((select app.is_admin()));

drop policy if exists stage_thresholds_insert on public.stage_thresholds;
create policy stage_thresholds_insert on public.stage_thresholds
  for insert to authenticated with check ((select app.is_admin()));

drop trigger if exists set_updated_at on public.stage_thresholds;
create trigger set_updated_at before update on public.stage_thresholds
  for each row execute function app.tg_set_updated_at();

drop trigger if exists audit_row on public.stage_thresholds;
create trigger audit_row after update on public.stage_thresholds
  for each row execute function app.tg_audit_row();

-- -----------------------------------------------------------------------------
-- 2. app_settings: the two dashboard-wide numbers
-- -----------------------------------------------------------------------------

alter table public.app_settings
  /** Projects-on-hold card turns amber above this (spec §3). */
  add column if not exists on_hold_alert_threshold integer not null default 5,
  /** §8: the PM/Ops view hides the financial cards unless this is granted.
      Note this is a presentation choice, not a new security boundary: ops can
      already read projects.contract_value directly through the projects table.
      It is honoured server-side (the query is not run at all) rather than by
      hiding a rendered chart, which §10 rules out. */
  add column if not exists ops_see_financials boolean not null default false;

-- -----------------------------------------------------------------------------
-- 3. public.project_metrics — the one row per project every chart groups over
-- -----------------------------------------------------------------------------
-- security_invoker = true is the important word in this file. It makes the view
-- run under the *caller's* privileges, so public.projects' own RLS policy
-- decides which rows they get: an admin sees the company, a dealer sees their
-- book, a customer sees their house. That is spec §8's "scoped by row-level
-- security, never a filter" — the dealer dashboard and the admin dashboard are
-- the same query, and there is no filter to forget to apply.
--
-- (Two joins are deliberately left to RLS as well. profiles is self-or-staff,
-- so pm_name comes back null for a dealer or a finance user — neither of whom
-- gets a by-PM chart. The absence is the policy working, not a bug.)
--
-- Dropped rather than replaced: create-or-replace cannot change a view's column
-- list, and this one will grow.

drop view if exists public.project_metrics;

create view public.project_metrics
with (security_invoker = true)
as
with stage_since as (
  select p.id as project_id,
         coalesce(
           (select max(e.changed_at) from public.project_stage_events e
             where e.project_id = p.id),
           p.created_at
         ) as since
  from public.projects p
),
holds as (
  -- Total days spent held, open holds counted to today. This is what "excluding
  -- hold time" (§5) subtracts: without it, one project parked for a month for a
  -- customer's holiday drags every timing figure on the page.
  select h.project_id,
         sum(coalesce(h.resume_date, current_date) - h.hold_start_date) as hold_days,
         count(*) as hold_count,
         max(h.expected_resume_date) filter (where h.resume_date is null) as expected_resume_date,
         max(h.hold_start_date) filter (where h.resume_date is null) as open_hold_started
  from public.project_holds h
  group by h.project_id
)
select
  p.id,
  p.code,
  p.name,
  p.address,
  p.dealer_id,
  dl.name                              as dealer_name,
  -- Carried so the dealer portal can honour a company's reps_see_own_only
  -- setting: without it, the dealer's own reduced dashboard would show a rep
  -- their colleagues' projects, which the rest of that portal does not.
  p.sales_rep_id,
  p.client_id,
  nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') as client_name,
  p.assigned_pm,
  coalesce(pm.full_name, pm.email)     as pm_name,
  p.jurisdiction_id,
  j.name                               as jurisdiction_name,
  p.stage,
  p.status,
  p.system_size_kw,
  p.contract_value,
  p.created_at,
  date_trunc('month', p.created_at)::date as created_month,

  -- Where it is now, and for how long.
  ss.since                             as stage_since,
  greatest(0, (current_date - ss.since::date)) as days_in_stage,

  -- Age band for the funnel colouring (§4). A stage that is merely busy has to
  -- look different from one that is jammed, which needs the bands here rather
  -- than a count.
  case
    when (current_date - ss.since::date) <= 14 then '0-14'
    when (current_date - ss.since::date) <= 30 then '15-30'
    when (current_date - ss.since::date) <= 60 then '31-60'
    else '60+'
  end                                  as age_band,

  -- coalesce, and a LEFT join below, so that adding a stage to the enum without
  -- remembering to add its threshold row degrades to a default rather than
  -- silently dropping every project in that stage out of every chart.
  coalesce(th.attention_days, 21)      as attention_days,
  (p.status = 'active'
   and p.stage <> 'complete'
   and (current_date - ss.since::date) > coalesce(th.attention_days, 21)) as is_ageing,

  coalesce(h.hold_days, 0)             as hold_days,
  coalesce(h.hold_count, 0)            as hold_count,
  h.expected_resume_date,
  h.open_hold_started,
  -- Held with no expected resume date at all is the worse case of the two, and
  -- §7 wants both in the same list.
  (p.status = 'on_hold'
   and (h.expected_resume_date is null or h.expected_resume_date < current_date)) as hold_overdue,

  -- Completion.
  s7.completion_date,
  date_trunc('month', s7.completion_date)::date as completed_month,
  case when s7.completion_date is not null
       then greatest(0, s7.completion_date - p.created_at::date) end as total_days,
  case when s7.completion_date is not null
       then greatest(0, (s7.completion_date - p.created_at::date) - coalesce(h.hold_days, 0)) end
                                       as total_days_ex_hold,

  -- Cancellation: stage_cancelled_from is the single most useful figure for
  -- where projects are lost (§7's "recently cancelled" list).
  cx.cancellation_date,
  cx.stage_cancelled_from              as cancelled_from,
  cx.reason                            as cancel_reason,

  -- The date each stage finished. §5 averages "across projects completing that
  -- stage in the period", so the period filter needs the finishing date, not
  -- only the duration.
  s1.survey_completed_date             as survey_done_on,
  s2.design_received_date              as design_done_on,
  s3.permit_received_date              as permit_done_on,
  s4.material_delivered_date           as material_done_on,
  s5.install_completed_date            as install_done_on,
  s6.inspection_completed_date         as inspection_done_on,
  s6.pto_received_date                 as pto_done_on,

  -- The seven per-stage day counters of §5, read from the same date pairs the
  -- stage-field registry defines (src/lib/stages/fields.ts). Site Survey has no
  -- 'from' date in the registry, so it counts from project creation — which is
  -- also the honest measure of how long a homeowner waited for their survey.
  case when s1.survey_completed_date is not null
       then greatest(0, s1.survey_completed_date - p.created_at::date) end as survey_days,
  case when s2.design_received_date is not null and s2.design_requested_date is not null
       then greatest(0, s2.design_received_date - s2.design_requested_date) end as design_days,
  case when s3.permit_received_date is not null and s3.permit_applied_date is not null
       then greatest(0, s3.permit_received_date - s3.permit_applied_date) end as permit_days,
  case when s4.material_delivered_date is not null and s4.material_requested_date is not null
       then greatest(0, s4.material_delivered_date - s4.material_requested_date) end as material_days,
  case when s5.install_completed_date is not null and s5.install_requested_date is not null
       then greatest(0, s5.install_completed_date - s5.install_requested_date) end as install_days,
  case when s6.inspection_completed_date is not null and s6.inspection_requested_date is not null
       then greatest(0, s6.inspection_completed_date - s6.inspection_requested_date) end as inspection_days,
  case when s6.pto_received_date is not null and s6.pto_applied_date is not null
       then greatest(0, s6.pto_received_date - s6.pto_applied_date) end as pto_days
from public.projects p
join stage_since ss on ss.project_id = p.id
left join public.stage_thresholds th on th.stage = p.stage
left join holds h on h.project_id = p.id
left join public.dealers dl on dl.id = p.dealer_id
left join public.clients c on c.id = p.client_id
left join public.profiles pm on pm.id = p.assigned_pm
left join public.jurisdictions j on j.id = p.jurisdiction_id
left join public.stage1_survey s1 on s1.project_id = p.id
left join public.stage2_design s2 on s2.project_id = p.id
left join public.stage3_permit s3 on s3.project_id = p.id
left join public.stage4_procurement s4 on s4.project_id = p.id
left join public.stage5_install s5 on s5.project_id = p.id
left join public.stage6_inspection s6 on s6.project_id = p.id
left join public.stage7_complete s7 on s7.project_id = p.id
left join public.project_cancellation cx on cx.project_id = p.id and cx.reinstated_at is null;

grant select on public.project_metrics to authenticated;
revoke insert, update, delete on public.project_metrics from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. public.project_financial_metrics — the finance role's slice
-- -----------------------------------------------------------------------------
-- The finance role cannot read public.projects at all: its RLS policy admits
-- admin, ops, the assigned designer, the dealer and the customer, and finance is
-- deliberately none of those. Everything finance sees arrives through a
-- definer view whitelisting the financial columns — public.project_financials,
-- since 001200. project_metrics inherits that exclusion (security_invoker), so
-- it returns zero rows for finance, which is correct but useless.
--
-- So the finance dashboard reads this second view instead: the same shape of
-- gate as project_financials (owner's privileges, role checked in the WHERE),
-- carrying only what §8 grants finance — "pipeline value, completion volumes and
-- milestone-payment status; no workload or stage-detail charts". There is
-- deliberately no assigned_pm and no per-stage day counter here: the view
-- physically cannot answer a workload or cycle-time-by-stage question, so that
-- rule holds even if someone later writes the wrong query against it.
--
-- The payment-milestone statuses are the one addition beyond project_financials.
-- They are financial state — who has paid which milestone — which is the finance
-- role's own subject, and they carry no notes, costs or margins.

drop view if exists public.project_financial_metrics;

create view public.project_financial_metrics
with (security_barrier = true, security_invoker = false)
as
select
  p.id,
  p.code,
  p.name,
  p.dealer_id,
  dl.name                     as dealer_name,
  p.stage,
  p.status,
  p.system_size_kw,
  p.contract_value,
  p.dealer_fee,
  p.amount_invoiced,
  p.amount_paid,
  p.created_at,
  date_trunc('month', p.created_at)::date as created_month,
  s7.completion_date,
  date_trunc('month', s7.completion_date)::date as completed_month,
  case when s7.completion_date is not null
       then greatest(0, s7.completion_date - p.created_at::date) end as total_days,
  cx.cancellation_date,
  -- Milestone-payment status (§8).
  s1.down_payment_status,
  s1.cash_m1_status,
  s3.cash_m2_status,
  s5.cash_m3_status,
  fm.m1_status,
  fm.m2_status
from public.projects p
left join public.dealers dl on dl.id = p.dealer_id
left join public.stage1_survey s1 on s1.project_id = p.id
left join public.stage3_permit s3 on s3.project_id = p.id
left join public.stage5_install s5 on s5.project_id = p.id
left join public.stage7_complete s7 on s7.project_id = p.id
left join public.finance_milestones fm on fm.project_id = p.id
left join public.project_cancellation cx on cx.project_id = p.id and cx.reinstated_at is null
where (select app.current_user_role()) in ('finance', 'admin');

grant select on public.project_financial_metrics to authenticated;
revoke insert, update, delete on public.project_financial_metrics from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Indexes — §10 says early, and it is right
-- -----------------------------------------------------------------------------
-- Almost every chart groups by stage, assigned_pm, dealer_id or status, or
-- filters on one of the three date fields. stage / assigned_pm / dealer_id /
-- client_id / jurisdiction_id are already indexed (000200, 001200); these are
-- the ones the dashboard adds.

create index if not exists projects_status_idx on public.projects (status);
create index if not exists projects_created_at_idx on public.projects (created_at);
-- The commonest dashboard shape: one dealer's or one PM's active book.
create index if not exists projects_dealer_status_idx on public.projects (dealer_id, status);
create index if not exists projects_pm_status_idx on public.projects (assigned_pm, status);
-- "Completed this period" and the completion-time trend both range-scan this.
create index if not exists stage7_complete_completion_date_idx
  on public.stage7_complete (completion_date);
create index if not exists project_cancellation_date_idx
  on public.project_cancellation (cancellation_date);
-- Hold days are summed per project on every dashboard render.
create index if not exists project_holds_project_idx
  on public.project_holds (project_id, hold_start_date);


-- >>> migration bookkeeping
create table if not exists public.schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
insert into public.schema_migrations (name) values ('20260803002800_dashboard.sql')
on conflict (name) do nothing;
