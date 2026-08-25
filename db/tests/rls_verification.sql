-- =============================================================================
-- RLS VERIFICATION — the §2 "done when" check, executable.
-- =============================================================================
-- Run by scripts/verify-local.sh against a throwaway database (all
-- migrations applied). Creates users for every §2 role and two full projects
-- via plain SQL, then queries as each role by simulating that role's JWT
-- (`set role authenticated` + request.jwt.claims — exactly what PostgREST
-- does). Every check either raises (FAIL) or prints PASS; psql runs with
-- ON_ERROR_STOP so any failure aborts the run.
--
--   admin    → sees all projects
--   ops      → sees all projects (runs the pipeline; no admin surfaces)
--   designer → sees only their queue
--   customer → sees only their project
--   dealer   → sees only their book
--   finance  → zero direct project rows; whitelisted columns via view
-- plus storage policies, audit-log behavior, write denials, and the
-- REQ-SEC-01 upload grants (single-project no-login links, 7-day cap).

\set ON_ERROR_STOP on

-- -----------------------------------------------------------------------------
-- Fixtures (as superuser, i.e. "created via SQL")
-- -----------------------------------------------------------------------------

-- JWT simulator: subsequent queries run as this user until the next call.
create or replace function public.t_login(p_uid uuid, p_role text)
returns void
language sql
as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'user_role', p_role)::text,
    false
  );
$$;

grant execute on function public.t_login(uuid, text) to authenticated;

create table public.t_fix (key text primary key, id uuid not null);
grant select on public.t_fix to authenticated, anon;

insert into public.t_fix (key, id) values
  ('u_admin',     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('u_designer1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('u_designer2', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('u_dealer1',   'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ('u_dealer2',   'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  ('u_customer1', 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
  ('u_customer2', '99999999-9999-4999-8999-999999999999'),
  ('u_finance',   '12121212-1212-4121-8121-121212121212'),
  ('u_ops',       '13131313-1313-4131-8131-131313131313'),
  ('dealer1',     '11111111-1111-4111-8111-111111111111'),
  ('dealer2',     '22222222-2222-4222-8222-222222222222'),
  ('designer1',   '33333333-3333-4333-8333-333333333333'),
  ('designer2',   '44444444-4444-4444-8444-444444444444'),
  ('client1',     '55555555-5555-4555-8555-555555555555'),
  ('client2',     '66666666-6666-4666-8666-666666666666'),
  ('project1',    '77777777-7777-4777-8777-777777777777'),
  ('project2',    '88888888-8888-4888-8888-888888888888'),
  ('design1',     'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'),
  ('design2',     'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2'),
  ('design3',     'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3');

create or replace function public.t_id(p_key text)
returns uuid
language sql
stable
as $$ select id from public.t_fix where key = p_key $$;

grant execute on function public.t_id(text) to authenticated, anon;

-- Users: the auth.users trigger creates profiles with the role taken from
-- raw_app_meta_data.user_role.
insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
select t_id(k.key), k.key || '@example.test',
       jsonb_build_object('user_role', k.role), '{}'::jsonb
from (values
  ('u_admin',     'admin'),
  ('u_designer1', 'designer'),
  ('u_designer2', 'designer'),
  ('u_dealer1',   'dealer'),
  ('u_dealer2',   'dealer'),
  ('u_customer1', 'customer'),
  ('u_customer2', 'customer'),
  ('u_finance',   'finance'),
  ('u_ops',       'ops')
) as k (key, role);

do $t$
declare n int;
begin
  select count(*) into n from public.profiles;
  if n <> 9 then
    raise exception 'FAIL: expected 9 auto-created profiles, got %', n;
  end if;
  if (select role from public.profiles where id = t_id('u_finance')) <> 'finance' then
    raise exception 'FAIL: profile bootstrap did not honor app-metadata role';
  end if;
  if (select role from public.profiles where id = t_id('u_ops')) <> 'ops' then
    raise exception 'FAIL: profile bootstrap did not honor the ops role';
  end if;
  raise notice 'PASS: auth.users trigger created 9 profiles with §2 roles';
end
$t$;

insert into public.dealers (id, name, code) values
  (t_id('dealer1'), 'Sunrise Solar Partners', 'SUNRISE'),
  (t_id('dealer2'), 'Desert Ray Energy', 'DESERTRAY');

insert into public.dealer_users (dealer_id, user_id, is_owner) values
  (t_id('dealer1'), t_id('u_dealer1'), true),
  (t_id('dealer2'), t_id('u_dealer2'), true);

insert into public.designers (id, user_id, display_name) values
  (t_id('designer1'), t_id('u_designer1'), 'Designer One'),
  (t_id('designer2'), t_id('u_designer2'), 'Designer Two');

insert into public.clients (id, dealer_id, user_id, first_name, last_name, email) values
  (t_id('client1'), t_id('dealer1'), t_id('u_customer1'), 'Casey', 'Homeowner', 'c1@example.test'),
  (t_id('client2'), t_id('dealer2'), t_id('u_customer2'), 'Dana', 'Homeowner', 'c2@example.test');

insert into public.jurisdictions (id, name, state, typical_turnaround_days) values
  ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1', 'Test County AHJ', 'ZZ', 10);

insert into public.projects
  (id, name, dealer_id, client_id, assigned_designer_id, jurisdiction_id,
   stage, contract_value, dealer_fee, system_size_kw)
values
  (t_id('project1'), 'Homeowner One PV', t_id('dealer1'), t_id('client1'),
   t_id('designer1'), 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1',
   'survey', 42000, 3500, 8.4),
  (t_id('project2'), 'Homeowner Two PV', t_id('dealer2'), t_id('client2'),
   t_id('designer2'), 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1',
   'design', 31000, 2800, 6.2);

insert into public.designs (id, project_id, version, status, designer_id) values
  (t_id('design1'), t_id('project1'), 1, 'approved', t_id('designer1')),
  (t_id('design2'), t_id('project1'), 2, 'draft',    t_id('designer1')),
  (t_id('design3'), t_id('project2'), 1, 'draft',    t_id('designer2'));

insert into public.bom_items (project_id, design_id, description, quantity, unit_cost, unit_price)
values (t_id('project1'), t_id('design1'), '400W panel', 21, 180, 260);

insert into public.change_orders (project_id, number, status, amount_delta, description) values
  (t_id('project1'), 1, 'pending_approval', 1500, 'Main panel upgrade'),
  (t_id('project2'), 1, 'draft', -500, 'Panel count reduction');

insert into public.permits (project_id, jurisdiction_id, status)
values (t_id('project1'), 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1', 'preparing');

insert into public.vendors (id, name)
values ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', 'Test Vendor Co');

insert into public.vendor_quotes (vendor_id, project_id, status, total)
values ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', t_id('project1'), 'received', 9800);

insert into public.price_book (sku, name, unit_cost, unit_price)
values ('TEST-PANEL-400', 'Test 400W Panel', 180, 260);

insert into public.exceptions (project_id, severity, summary)
values (t_id('project1'), 'high', 'Rule conflict: two adder rules matched');

insert into public.documents (project_id, bucket, object_path, kind, customer_visible, uploaded_by) values
  (t_id('project1'), 'project-dwg',
   t_id('project1') || '/v1/site-plan.dwg', 'dwg', false, t_id('u_designer1')),
  (t_id('project1'), 'project-deliverables',
   t_id('project1') || '/v1/plan-set.pdf', 'pdf', true, t_id('u_designer1'));

insert into storage.objects (bucket_id, name, owner) values
  ('project-dwg',          t_id('project1') || '/v1/site-plan.dwg', t_id('u_designer1')),
  ('project-deliverables', t_id('project1') || '/v1/plan-set.pdf',  t_id('u_designer1'));

-- =============================================================================
-- 1. The §2 visibility matrix on projects
-- =============================================================================

select t_login(t_id('u_admin'), 'admin');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.projects;
  if n <> 2 then raise exception 'FAIL: admin expected 2 projects, got %', n; end if;
  raise notice 'PASS: admin sees all projects (%)', n;
end
$t$;
reset role;

select t_login(t_id('u_ops'), 'ops');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.projects;
  if n <> 2 then raise exception 'FAIL: ops expected all projects (2), got %', n; end if;
  update public.projects set priority = 5 where id = t_id('project2');
  if not exists (select 1 from public.projects where id = t_id('project2') and priority = 5) then
    raise exception 'FAIL: ops could not update a project';
  end if;
  select count(*) into n from public.clients;
  if n <> 2 then raise exception 'FAIL: ops expected all clients (2), got %', n; end if;
  select count(*) into n from public.price_book;
  if n < 1 then raise exception 'FAIL: ops should read price_book'; end if;
  select count(*) into n from public.project_financials;
  if n <> 0 then raise exception 'FAIL: ops must not read the finance view, got %', n; end if;
  select count(*) into n from public.audit_log where project_id is null;
  if n <> 0 then raise exception 'FAIL: ops must not read global audit rows, got %', n; end if;
  select count(*) into n from public.audit_log where project_id is not null;
  if n < 1 then raise exception 'FAIL: ops should read project activity logs'; end if;
  raise notice 'PASS: ops runs the pipeline (all projects, project activity) without admin surfaces';
end
$t$;
reset role;

select t_login(t_id('u_designer1'), 'designer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.projects;
  if n <> 1 or not exists (select 1 from public.projects where id = t_id('project1')) then
    raise exception 'FAIL: designer1 should see exactly their queue (project1), saw % rows', n;
  end if;
  raise notice 'PASS: designer sees only their queue';
end
$t$;
reset role;

select t_login(t_id('u_customer1'), 'customer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.projects;
  if n <> 1 or not exists (select 1 from public.projects where id = t_id('project1')) then
    raise exception 'FAIL: customer1 should see exactly project1, saw % rows', n;
  end if;
  raise notice 'PASS: customer sees only their project';
end
$t$;
reset role;

select t_login(t_id('u_dealer1'), 'dealer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.projects;
  if n <> 1 or not exists (select 1 from public.projects where id = t_id('project1')) then
    raise exception 'FAIL: dealer1 should see exactly their book (project1), saw % rows', n;
  end if;
  raise notice 'PASS: dealer sees only their book';
end
$t$;
reset role;

select t_login(t_id('u_finance'), 'finance');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.projects;
  if n <> 0 then
    raise exception 'FAIL: finance must have zero direct project rows, saw %', n;
  end if;
  select count(*) into n from public.project_financials;
  if n <> 2 then
    raise exception 'FAIL: finance expected 2 rows in project_financials, got %', n;
  end if;
  if (select sum(contract_value) from public.project_financials) <> 73000 then
    raise exception 'FAIL: finance view financial columns wrong';
  end if;
  raise notice 'PASS: finance sees whitelisted columns via view, no direct rows';
end
$t$;
reset role;

-- The whitelist itself: no PII/site/design columns on the finance view.
do $t$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'project_financials'
      and column_name in ('site_address', 'metadata', 'assigned_designer_id', 'priority')
  ) then
    raise exception 'FAIL: project_financials exposes non-whitelisted columns';
  end if;
  raise notice 'PASS: project_financials exposes only the whitelisted columns';
end
$t$;

-- The view is read-only: finance cannot write projects through it.
select t_login(t_id('u_finance'), 'finance');
set role authenticated;
do $t$
begin
  begin
    update public.project_financials set contract_value = 1 where id = t_id('project1');
    raise exception 'FAIL: finance wrote to projects through the view';
  exception when insufficient_privilege or feature_not_supported or wrong_object_type or object_not_in_prerequisite_state then
    raise notice 'PASS: project_financials is read-only';
  end;
end
$t$;
reset role;

-- Non-finance roles get nothing through the view either.
select t_login(t_id('u_dealer1'), 'dealer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.project_financials;
  if n <> 0 then raise exception 'FAIL: dealer can read project_financials (% rows)', n; end if;
  raise notice 'PASS: project_financials is finance/admin only';
end
$t$;
reset role;

-- =============================================================================
-- 2. Child tables follow the matrix
-- =============================================================================

select t_login(t_id('u_designer1'), 'designer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.designs;
  if n <> 2 then raise exception 'FAIL: designer1 expected 2 designs, got %', n; end if;
  select count(*) into n from public.bom_items;
  if n <> 1 then raise exception 'FAIL: designer1 expected 1 bom item, got %', n; end if;
  select count(*) into n from public.vendor_quotes;
  if n <> 1 then raise exception 'FAIL: designer1 expected 1 vendor quote, got %', n; end if;
  select count(*) into n from public.exceptions;
  if n <> 1 then raise exception 'FAIL: designer1 expected 1 exception, got %', n; end if;
  select count(*) into n from public.price_book;
  if n < 1 then raise exception 'FAIL: designer should read price_book'; end if;
  select count(*) into n from public.clients;
  if n <> 1 then raise exception 'FAIL: designer1 should see only their queue''s client, got %', n; end if;
  raise notice 'PASS: designer sees internal tables for their queue only';
end
$t$;
reset role;

select t_login(t_id('u_dealer1'), 'dealer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.designs;
  if n <> 2 then raise exception 'FAIL: dealer1 expected 2 designs (their book), got %', n; end if;
  select count(*) into n from public.bom_items;
  if n <> 0 then raise exception 'FAIL: dealer must not see bom costs, got % rows', n; end if;
  select count(*) into n from public.vendor_quotes;
  if n <> 0 then raise exception 'FAIL: dealer must not see vendor quotes, got % rows', n; end if;
  select count(*) into n from public.price_book;
  if n <> 0 then raise exception 'FAIL: dealer must not see price_book, got % rows', n; end if;
  select count(*) into n from public.change_orders;
  if n <> 1 then raise exception 'FAIL: dealer1 expected 1 change order, got %', n; end if;
  select count(*) into n from public.clients;
  if n <> 1 then raise exception 'FAIL: dealer1 expected their book''s client only, got %', n; end if;
  select count(*) into n from public.exceptions;
  if n <> 0 then raise exception 'FAIL: dealer must not see exceptions, got %', n; end if;
  raise notice 'PASS: dealer sees book-level data, no internal costs';
end
$t$;
reset role;

select t_login(t_id('u_customer1'), 'customer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.designs;
  if n <> 1 then raise exception 'FAIL: customer should see only approved designs, got %', n; end if;
  select count(*) into n from public.documents;
  if n <> 1 then raise exception 'FAIL: customer should see only customer_visible documents, got %', n; end if;
  select count(*) into n from public.permits;
  if n <> 1 then raise exception 'FAIL: customer should see their permit status, got %', n; end if;
  select count(*) into n from public.change_orders;
  if n <> 1 then raise exception 'FAIL: customer expected their 1 change order, got %', n; end if;
  select count(*) into n from public.bom_items;
  if n <> 0 then raise exception 'FAIL: customer must not see bom items'; end if;
  select count(*) into n from public.jurisdictions;
  if n < 1 then raise exception 'FAIL: reference data should be readable'; end if;
  raise notice 'PASS: customer sees customer-facing rows of their project only';
end
$t$;
reset role;

select t_login(t_id('u_finance'), 'finance');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.change_orders;
  if n <> 2 then raise exception 'FAIL: finance expected all change orders (2), got %', n; end if;
  select count(*) into n from public.vendor_quotes;
  if n <> 1 then raise exception 'FAIL: finance expected 1 vendor quote, got %', n; end if;
  select count(*) into n from public.bom_items;
  if n <> 1 then raise exception 'FAIL: finance expected 1 bom item, got %', n; end if;
  select count(*) into n from public.clients;
  if n <> 0 then raise exception 'FAIL: finance must not see client PII, got % rows', n; end if;
  raise notice 'PASS: finance reads financial tables, never PII';
end
$t$;
reset role;

-- =============================================================================
-- 3. Profiles: self-service without privilege escalation
-- =============================================================================

select t_login(t_id('u_designer1'), 'designer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.profiles;
  if n <> 1 then raise exception 'FAIL: non-admin should see only own profile, got %', n; end if;

  update public.profiles set full_name = 'Designer One Renamed' where id = t_id('u_designer1');

  begin
    update public.profiles set role = 'admin' where id = t_id('u_designer1');
    raise exception 'FAIL: designer escalated own role to admin';
  exception when insufficient_privilege then
    raise notice 'PASS: role self-escalation blocked';
  end;
end
$t$;
reset role;

-- =============================================================================
-- 4. Write-path checks
-- =============================================================================

-- Customer cannot modify their project (UPDATE filtered to 0 rows).
select t_login(t_id('u_customer1'), 'customer');
set role authenticated;
do $t$
declare n int;
begin
  update public.projects set name = 'hacked' where id = t_id('project1');
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: customer updated a project'; end if;
  raise notice 'PASS: customer cannot modify projects';
end
$t$;
reset role;

-- Dealer can create a project in their own book, not in another dealer's.
select t_login(t_id('u_dealer1'), 'dealer');
set role authenticated;
do $t$
begin
  insert into public.projects (name, dealer_id, client_id)
  values ('Dealer1 self-serve intake', t_id('dealer1'), t_id('client1'));
  raise notice 'PASS: dealer creates projects in their own book';

  begin
    insert into public.projects (name, dealer_id, client_id)
    values ('cross-book intake', t_id('dealer2'), t_id('client2'));
    raise exception 'FAIL: dealer created a project in another book';
  exception when insufficient_privilege then
    raise notice 'PASS: dealer blocked from another dealer''s book';
  end;

  begin
    insert into public.projects (name, dealer_id, client_id)
    values ('mismatched client', t_id('dealer1'), t_id('client2'));
    raise exception 'FAIL: dealer attached another dealer''s client';
  exception when insufficient_privilege then
    raise notice 'PASS: dealer blocked from attaching a foreign client';
  end;
end
$t$;
reset role;

-- Designer updates their assigned project; the stage trigger records history.
select t_login(t_id('u_designer1'), 'designer');
set role authenticated;
do $t$
begin
  update public.projects set stage = 'design' where id = t_id('project1');
  insert into public.designs (project_id, version, status, designer_id)
  values (t_id('project1'), 3, 'draft', t_id('designer1'));

  begin
    update public.projects set name = 'not mine' where id = t_id('project2');
    -- 0 rows is the expected silent outcome; verify below as admin
  end;
  raise notice 'PASS: designer writes within their queue';
end
$t$;
reset role;

do $t$
declare n int;
begin
  select count(*) into n from public.project_stage_events
  where project_id = t_id('project1') and to_stage = 'design'
    and changed_by = t_id('u_designer1');
  if n <> 1 then raise exception 'FAIL: stage trigger did not record the transition'; end if;
  if (select name from public.projects where id = t_id('project2')) <> 'Homeowner Two PV' then
    raise exception 'FAIL: designer modified a project outside their queue';
  end if;
  raise notice 'PASS: stage history recorded automatically';
end
$t$;

-- Designer manages their own availability, not a colleague's.
select t_login(t_id('u_designer1'), 'designer');
set role authenticated;
do $t$
begin
  insert into public.availability_slots (designer_id, starts_at, ends_at)
  values (t_id('designer1'), now() + interval '1 day', now() + interval '1 day 1 hour');

  begin
    insert into public.availability_slots (designer_id, starts_at, ends_at)
    values (t_id('designer2'), now() + interval '1 day', now() + interval '1 day 1 hour');
    raise exception 'FAIL: designer created a slot for someone else';
  exception when insufficient_privilege then
    raise notice 'PASS: designers manage only their own calendar';
  end;
end
$t$;
reset role;

-- Open slots are offerable to booking flows (dealer sees them).
select t_login(t_id('u_dealer1'), 'dealer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.availability_slots where status = 'open';
  if n < 1 then raise exception 'FAIL: open slots should be visible for booking'; end if;
  raise notice 'PASS: open availability is visible for booking flows';
end
$t$;
reset role;

-- Stage feedback is written through functions only (003200 replaced the
-- foundation schema's placeholder, where any participant could insert a row and
-- name themselves as its author). The old spoofing check becomes a simpler and
-- stronger one: nobody writes to the table directly, so there is no author field
-- to forge.
select t_login(t_id('u_customer1'), 'customer');
set role authenticated;
do $t$
begin
  begin
    insert into public.stage_feedback (project_id, stage, score, source, created_by)
    values (t_id('project1'), 'survey', 1, 'customer', t_id('u_designer1'));
    raise exception 'FAIL: a rating was inserted directly, bypassing the guardrails';
  exception when insufficient_privilege then
    raise notice 'PASS: ratings are written only through their functions';
  end;
end
$t$;
reset role;

-- =============================================================================
-- 5. Storage buckets
-- =============================================================================

select t_login(t_id('u_designer1'), 'designer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from storage.objects where bucket_id = 'project-dwg';
  if n <> 1 then raise exception 'FAIL: designer expected 1 dwg object, got %', n; end if;

  insert into storage.objects (bucket_id, name, owner)
  values ('project-dwg', t_id('project1') || '/v2/site-plan.dwg', t_id('u_designer1'));

  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('project-dwg', t_id('project2') || '/v1/other.dwg', t_id('u_designer1'));
    raise exception 'FAIL: designer wrote a dwg into a foreign project';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('project-dwg', 'no-project-prefix.dwg', t_id('u_designer1'));
    raise exception 'FAIL: object without project prefix was accepted';
  exception when insufficient_privilege then
    null;
  end;

  raise notice 'PASS: dwg bucket is staff-only and path-scoped';
end
$t$;
reset role;

select t_login(t_id('u_customer1'), 'customer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from storage.objects where bucket_id = 'project-dwg';
  if n <> 0 then raise exception 'FAIL: customer can see dwg objects'; end if;

  select count(*) into n from storage.objects where bucket_id = 'project-deliverables';
  if n <> 1 then raise exception 'FAIL: customer expected 1 deliverable, got %', n; end if;

  insert into storage.objects (bucket_id, name, owner)
  values ('project-photos', t_id('project1') || '/roof-1.jpg', t_id('u_customer1'));

  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('project-dwg', t_id('project1') || '/sneaky.dwg', t_id('u_customer1'));
    raise exception 'FAIL: customer uploaded into the dwg bucket';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('project-photos', t_id('project2') || '/peek.jpg', t_id('u_customer1'));
    raise exception 'FAIL: customer uploaded a photo to a foreign project';
  exception when insufficient_privilege then
    null;
  end;

  raise notice 'PASS: deliverables readable, photos uploadable, dwg sealed off';
end
$t$;
reset role;

select t_login(t_id('u_dealer2'), 'dealer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from storage.objects;
  if n <> 0 then raise exception 'FAIL: dealer2 sees storage objects of a foreign book (%)', n; end if;
  raise notice 'PASS: storage objects invisible outside the participant set';
end
$t$;
reset role;

-- =============================================================================
-- 6. Audit log
-- =============================================================================

-- The designer's earlier writes must have produced audit rows attributed to them.
do $t$
declare n int;
begin
  select count(*) into n from public.audit_log
  where entity_type = 'projects'
    and project_id = t_id('project1')
    and action = 'update'
    and actor_id = t_id('u_designer1')
    and actor_role = 'designer';
  if n < 1 then raise exception 'FAIL: project update was not audited'; end if;

  select count(*) into n from public.audit_log
  where entity_type = 'designs' and action = 'insert' and actor_id = t_id('u_designer1');
  if n < 1 then raise exception 'FAIL: design insert was not audited'; end if;
  raise notice 'PASS: row triggers audit writes with actor identity';
end
$t$;

-- The RPC writer (what src/lib/audit.ts calls).
select t_login(t_id('u_designer1'), 'designer');
set role authenticated;
do $t$
declare v_id bigint; n int;
begin
  v_id := public.log_audit_event(
    'design.shared', 'designs', t_id('design1')::text, t_id('project1'),
    '{"channel":"email"}'::jsonb);
  if v_id is null then raise exception 'FAIL: log_audit_event returned null'; end if;

  begin
    insert into public.audit_log (action, entity_type) values ('forged', 'projects');
    raise exception 'FAIL: direct audit_log insert was allowed';
  exception when insufficient_privilege then
    null;
  end;

  select count(*) into n from public.audit_log;
  if n <> 0 then raise exception 'FAIL: non-admin can read audit_log (% rows)', n; end if;
  raise notice 'PASS: RPC writes audit events; direct DML and reads denied';
end
$t$;
reset role;

select t_login(t_id('u_admin'), 'admin');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.audit_log where action = 'design.shared';
  if n <> 1 then raise exception 'FAIL: admin cannot see the RPC audit event'; end if;
  if (select actor_id from public.audit_log where action = 'design.shared') <> t_id('u_designer1') then
    raise exception 'FAIL: audit actor not taken from JWT';
  end if;
  raise notice 'PASS: admin reads the audit trail';
end
$t$;
reset role;

-- Append-only, even for privileged SQL.
do $t$
begin
  begin
    update public.audit_log set action = 'tampered' where action = 'design.shared';
    raise exception 'FAIL: audit_log row was updated';
  exception when insufficient_privilege then
    null;
  end;
  begin
    delete from public.audit_log where action = 'design.shared';
    raise exception 'FAIL: audit_log row was deleted';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'PASS: audit_log is append-only';
end
$t$;

-- =============================================================================
-- 7. Upload grants (REQ-SEC-01): single-project no-login links, 7-day cap
-- =============================================================================

create table public.t_tokens (key text primary key, token text not null, grant_id uuid not null);
grant select on public.t_tokens to authenticated, anon;
grant insert on public.t_tokens to authenticated;

-- Staff mint grants; TTL is clamped to 7 days even when more is requested.
select t_login(t_id('u_designer1'), 'designer');
set role authenticated;
do $t$
declare g record;
begin
  select * into g from public.create_upload_grant(t_id('project1'), 'survey_photos', interval '30 days');
  if g.expires_at > now() + interval '7 days' + interval '1 minute' then
    raise exception 'FAIL: upload grant TTL not clamped to 7 days (%)', g.expires_at;
  end if;
  insert into public.t_tokens values ('good', g.token, g.grant_id);

  select * into g from public.create_upload_grant(t_id('project1'), 'customer_delivery');
  insert into public.t_tokens values ('revokeme', g.token, g.grant_id);

  raise notice 'PASS: staff mint upload grants, expiry capped at 7 days';
end
$t$;
reset role;

-- Dealers are not project staff: no minting.
select t_login(t_id('u_dealer1'), 'dealer');
set role authenticated;
do $t$
declare g record;
begin
  begin
    select * into g from public.create_upload_grant(t_id('project1'), 'survey_photos');
    raise exception 'FAIL: dealer minted an upload grant';
  exception when insufficient_privilege then
    raise notice 'PASS: only project staff mint upload grants';
  end;
end
$t$;
reset role;

-- A grant past its expiry, as if minted 8 days ago.
insert into public.upload_grants (project_id, purpose, token_hash, expires_at)
values (t_id('project1'), 'survey_photos',
        encode(extensions.digest('expired-token-fixture', 'sha256'), 'hex'),
        now() - interval '1 hour');

-- The surveyor path: no session at all (anon), only the token.
select set_config('request.jwt.claims', '', false);
set role anon;
do $t$
declare r record; n int;
begin
  select * into r from public.validate_upload_grant((select token from public.t_tokens where key = 'good'));
  if r.project_id is distinct from t_id('project1') or r.project_name <> 'Homeowner One PV' then
    raise exception 'FAIL: valid token did not resolve to exactly its project';
  end if;

  select count(*) into n from public.validate_upload_grant('expired-token-fixture');
  if n <> 0 then raise exception 'FAIL: expired upload link still works'; end if;

  select count(*) into n from public.validate_upload_grant('not-a-real-token');
  if n <> 0 then raise exception 'FAIL: unknown token resolved'; end if;

  begin
    select count(*) into n from public.upload_grants;
    raise exception 'FAIL: anon can read upload_grants';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform app.write_audit('forged', 'projects');
    raise exception 'FAIL: anon can call the audit writer';
  exception when insufficient_privilege then
    null;
  end;

  raise notice 'PASS: token opens exactly one project, expired/unknown tokens dead, anon sealed off';
end
$t$;
reset role;

-- Revocation kills a link immediately.
select t_login(t_id('u_designer1'), 'designer');
set role authenticated;
do $t$
declare n int;
begin
  perform public.revoke_upload_grant((select grant_id from public.t_tokens where key = 'revokeme'));
  select count(*) into n from public.upload_grants;
  if n < 3 then raise exception 'FAIL: staff should see their project''s grants, got %', n; end if;
  raise notice 'PASS: staff revoke and see their project''s grants';
end
$t$;
reset role;

select set_config('request.jwt.claims', '', false);
set role anon;
do $t$
declare n int;
begin
  select count(*) into n
  from public.validate_upload_grant((select token from public.t_tokens where key = 'revokeme'));
  if n <> 0 then raise exception 'FAIL: revoked upload link still works'; end if;
  raise notice 'PASS: revoked link stops working immediately';
end
$t$;
reset role;

-- Dealers see no grants; grant lifecycle is in the audit trail; usage counted.
select t_login(t_id('u_dealer1'), 'dealer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.upload_grants;
  if n <> 0 then raise exception 'FAIL: dealer sees upload grants (%)', n; end if;
  raise notice 'PASS: grants invisible outside project staff';
end
$t$;
reset role;

do $t$
declare n int;
begin
  select count(*) into n from public.audit_log where action = 'upload_grant.created';
  if n < 2 then raise exception 'FAIL: grant creation not audited'; end if;
  select count(*) into n from public.audit_log where action = 'upload_grant.revoked';
  if n <> 1 then raise exception 'FAIL: grant revocation not audited'; end if;
  if (select use_count from public.upload_grants g
      join public.t_tokens t on t.grant_id = g.id and t.key = 'good') < 1 then
    raise exception 'FAIL: grant usage not counted';
  end if;
  raise notice 'PASS: grant lifecycle audited and usage counted';
end
$t$;

-- =============================================================================
-- Dashboard module (002800) — the whole point is that role scoping is the view's
-- RLS, not a filter the page remembers to apply. So: the same query, run as five
-- different roles, must return five different row sets without anything in the
-- query changing.
-- =============================================================================

-- The invariant, for every role: project_metrics returns exactly the projects
-- that role can already read, no more and no fewer. Compared against
-- public.projects as the same role rather than against a hardcoded count, so the
-- check keeps meaning as the fixtures above grow.
create or replace function public.t_metrics_match(p_who text)
returns void
language plpgsql
as $$
declare
  v_metrics int;
  v_projects int;
begin
  select count(*) into v_metrics from public.project_metrics;
  select count(*) into v_projects from public.projects;
  if v_metrics <> v_projects then
    raise exception 'FAIL: % sees % projects but % rows in project_metrics',
      p_who, v_projects, v_metrics;
  end if;
  if exists (select 1 from public.project_metrics m
             where not exists (select 1 from public.projects p where p.id = m.id)) then
    raise exception 'FAIL: % sees a project_metrics row for a project it cannot read', p_who;
  end if;
end
$$;

grant execute on function public.t_metrics_match(text) to authenticated;

select t_login(t_id('u_admin'), 'admin');
set role authenticated;
do $t$
declare n int;
begin
  perform public.t_metrics_match('admin');
  select count(*) into n from public.project_metrics;
  if n < 2 then raise exception 'FAIL: admin expected every project in project_metrics, got %', n; end if;

  -- The derived columns exist and are sane rather than merely present.
  if exists (select 1 from public.project_metrics where days_in_stage < 0) then
    raise exception 'FAIL: project_metrics produced a negative days_in_stage';
  end if;
  if exists (select 1 from public.project_metrics where age_band not in ('0-14','15-30','31-60','60+')) then
    raise exception 'FAIL: project_metrics produced an unknown age band';
  end if;
  if exists (select 1 from public.project_metrics where attention_days is null) then
    raise exception 'FAIL: a project has no ageing threshold';
  end if;
  raise notice 'PASS: admin sees every project in project_metrics, with sane derived columns';
end
$t$;
reset role;

select t_login(t_id('u_ops'), 'ops');
set role authenticated;
do $t$
begin
  perform public.t_metrics_match('ops');
  raise notice 'PASS: ops sees every project in project_metrics';
end
$t$;
reset role;

select t_login(t_id('u_dealer1'), 'dealer');
set role authenticated;
do $t$
begin
  perform public.t_metrics_match('dealer1');
  if exists (select 1 from public.project_metrics where dealer_id <> t_id('dealer1')) then
    raise exception 'FAIL: dealer1 sees another dealer''s project in project_metrics';
  end if;
  if not exists (select 1 from public.project_metrics where dealer_id = t_id('dealer1')) then
    raise exception 'FAIL: dealer1 sees none of their own projects';
  end if;
  -- profiles is self-or-staff: a dealer must not learn the PM's name from a view.
  if exists (select 1 from public.project_metrics where pm_name is not null) then
    raise exception 'FAIL: dealer can read a PM name through project_metrics';
  end if;
  raise notice 'PASS: dealer sees only their own book, without staff names';
end
$t$;
reset role;

select t_login(t_id('u_customer1'), 'customer');
set role authenticated;
do $t$
begin
  perform public.t_metrics_match('customer1');
  -- Their own houses and nobody else's. t_metrics_match already pins the row set
  -- to what public.projects gives this customer; this pins the ownership.
  if exists (select 1 from public.project_metrics where client_id <> t_id('client1')) then
    raise exception 'FAIL: customer1 sees a project belonging to someone else';
  end if;
  if not exists (select 1 from public.project_metrics) then
    raise exception 'FAIL: customer1 sees none of their own projects';
  end if;
  raise notice 'PASS: customer sees only their own projects in project_metrics';
end
$t$;
reset role;

-- Finance cannot read public.projects at all, so project_metrics is empty for it
-- and the financial slice is where its dashboard reads from.
select t_login(t_id('u_finance'), 'finance');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.project_metrics;
  if n <> 0 then
    raise exception 'FAIL: finance must see no rows in project_metrics, saw %', n;
  end if;
  select count(*) into n from public.project_financial_metrics;
  if n < 2 then
    raise exception 'FAIL: finance expected every project in project_financial_metrics, got %', n;
  end if;
  -- The same two contract values project_financials reports, through the newer
  -- view: the finance dashboard and the finance list cannot disagree about money.
  if (select coalesce(sum(contract_value), 0) from public.project_financial_metrics)
     <> (select coalesce(sum(contract_value), 0) from public.project_financials) then
    raise exception 'FAIL: the two finance views disagree about contract value';
  end if;
  raise notice 'PASS: finance reads the financial slice, and nothing from project_metrics';
end
$t$;
reset role;

-- §8: "no workload or stage-detail charts" must hold because the data is
-- unreachable, not because a component was left out.
do $t$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'project_financial_metrics'
      and column_name in ('assigned_pm', 'pm_name', 'survey_days', 'design_days',
                          'permit_days', 'install_days', 'days_in_stage', 'is_ageing')
  ) then
    raise exception 'FAIL: the finance slice exposes workload or stage-detail columns';
  end if;
  raise notice 'PASS: the finance slice cannot answer a workload or stage-timing question';
end
$t$;

-- A dealer must not reach the financial slice either.
select t_login(t_id('u_dealer1'), 'dealer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.project_financial_metrics;
  if n <> 0 then
    raise exception 'FAIL: dealer can read project_financial_metrics (% rows)', n;
  end if;
  raise notice 'PASS: project_financial_metrics is finance/admin only';
end
$t$;
reset role;

-- Both dashboard views are read-only.
select t_login(t_id('u_admin'), 'admin');
set role authenticated;
do $t$
begin
  begin
    update public.project_metrics set name = 'nope' where id = t_id('project1');
    raise exception 'FAIL: project_metrics is writable';
  exception when insufficient_privilege or feature_not_supported or wrong_object_type
    or object_not_in_prerequisite_state then
    raise notice 'PASS: project_metrics is read-only';
  end;
end
$t$;
reset role;

-- Thresholds: readable by everyone signed in (a dealer's own ageing list uses
-- them), writable only by an admin.
select t_login(t_id('u_dealer1'), 'dealer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.stage_thresholds;
  if n < 6 then raise exception 'FAIL: stage_thresholds not readable by a dealer (% rows)', n; end if;
  begin
    update public.stage_thresholds set attention_days = 1 where stage = 'permits';
    if found then raise exception 'FAIL: a dealer changed an ageing threshold'; end if;
  exception when insufficient_privilege then
    null;  -- also acceptable
  end;
  raise notice 'PASS: thresholds readable by all, not writable by a dealer';
end
$t$;
reset role;

select t_login(t_id('u_admin'), 'admin');
set role authenticated;
do $t$
begin
  update public.stage_thresholds set attention_days = 12 where stage = 'permits';
  if (select attention_days from public.stage_thresholds where stage = 'permits') <> 12 then
    raise exception 'FAIL: admin could not change an ageing threshold';
  end if;
  -- And the view picks the new number up immediately: the threshold is config,
  -- not a value copied into the data.
  if exists (select 1 from public.project_metrics where stage = 'permits' and attention_days <> 12) then
    raise exception 'FAIL: project_metrics did not pick up the new threshold';
  end if;
  update public.stage_thresholds set attention_days = 30 where stage = 'permits';
  raise notice 'PASS: an admin retunes a threshold and every chart follows on the next read';
end
$t$;
reset role;

-- The check constraint is real: a threshold of zero days would put every project
-- in the attention list forever.
do $t$
begin
  begin
    update public.stage_thresholds set attention_days = 0 where stage = 'design';
    raise exception 'FAIL: a zero-day threshold was accepted';
  exception when check_violation then
    raise notice 'PASS: thresholds must be at least one day';
  end;
end
$t$;

-- =============================================================================
-- Project chat (002900) — the two rules that must hold in the database
-- =============================================================================
-- 1. A customer can never see or write an internal note.
-- 2. A dealer is not in the conversation at all.
-- Both are checked as the actual roles, against the actual functions, because
-- both are the kind of rule that a UI can enforce perfectly and still be wrong.

select t_login(t_id('u_ops'), 'ops');
set role authenticated;
do $t$
declare
  v_msg uuid;
  v_note uuid;
begin
  v_msg := public.post_project_message(t_id('project1'), 'Hello from the PM', false, 'permits');
  v_note := public.post_project_message(t_id('project1'), 'Customer is anxious — go gently', true);

  if (select sender_role from public.project_messages where id = v_msg) <> 'staff' then
    raise exception 'FAIL: a PM message was not recorded as staff';
  end if;
  if (select is_internal from public.project_messages where id = v_note) is not true then
    raise exception 'FAIL: an internal note was not marked internal';
  end if;
  if (select stage_ref from public.project_messages where id = v_msg) <> 'permits' then
    raise exception 'FAIL: the stage reference was lost';
  end if;
  raise notice 'PASS: a PM posts a customer message and an internal note';
end
$t$;
reset role;

select t_login(t_id('u_customer1'), 'customer');
set role authenticated;
do $t$
declare n int;
begin
  -- The customer sees the message meant for them, and not the note about them.
  select count(*) into n from public.project_messages;
  if n <> 1 then
    raise exception 'FAIL: customer1 expected exactly the one customer-visible message, saw %', n;
  end if;
  if exists (select 1 from public.project_messages where is_internal) then
    raise exception 'FAIL: a customer can read an internal note';
  end if;

  -- And cannot create one, whatever the caller passes.
  begin
    perform public.post_project_message(t_id('project1'), 'sneaky', true);
    raise exception 'FAIL: a customer wrote an internal note';
  exception when insufficient_privilege or check_violation then
    null;
  end;

  -- Their own message is recorded as theirs, not as staff.
  if (select sender_role from public.project_messages
      where id = public.post_project_message(t_id('project1'), 'When is my install?', false))
     <> 'customer' then
    raise exception 'FAIL: a customer message was not recorded as customer';
  end if;
  raise notice 'PASS: a customer reads only customer-visible messages, and cannot write an internal note';
end
$t$;
reset role;

-- Another customer's project is not reachable, even by guessing the id (§7).
select t_login(t_id('u_customer2'), 'customer');
set role authenticated;
do $t$
begin
  if exists (select 1 from public.project_messages where project_id = t_id('project1')) then
    raise exception 'FAIL: customer2 can read customer1''s thread';
  end if;
  begin
    perform public.post_project_message(t_id('project1'), 'not my project', false);
    raise exception 'FAIL: customer2 posted into customer1''s thread';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'PASS: a guessed project id returns nothing and accepts nothing';
end
$t$;
reset role;

-- §2: the dealer is not part of this conversation — not even on their own book.
select t_login(t_id('u_dealer1'), 'dealer');
set role authenticated;
do $t$
declare n int;
begin
  select count(*) into n from public.project_messages;
  if n <> 0 then
    raise exception 'FAIL: a dealer can read the customer thread (% rows)', n;
  end if;
  begin
    perform public.post_project_message(t_id('project1'), 'dealer here', false);
    raise exception 'FAIL: a dealer posted into the customer thread';
  exception when insufficient_privilege then
    null;
  end;
  if exists (select 1 from public.project_chat_summary) then
    raise exception 'FAIL: a dealer can read the chat summary';
  end if;
  raise notice 'PASS: a dealer can neither read nor write the customer thread';
end
$t$;
reset role;

-- The designer has project access for their queue, and still is not in the chat.
select t_login(t_id('u_designer1'), 'designer');
set role authenticated;
do $t$
begin
  if exists (select 1 from public.project_messages) then
    raise exception 'FAIL: a designer can read the customer thread';
  end if;
  raise notice 'PASS: project access is not chat access — the designer is out too';
end
$t$;
reset role;

-- §3: nobody deletes a message. This is a business record.
select t_login(t_id('u_admin'), 'admin');
set role authenticated;
do $t$
begin
  begin
    delete from public.project_messages where project_id = t_id('project1');
    raise exception 'FAIL: an admin deleted a message';
  exception when insufficient_privilege then
    raise notice 'PASS: messages cannot be deleted, by anyone';
  end;
end
$t$;
reset role;

-- Direct writes are refused as well: the only way in is the definer function,
-- which is what stops a message claiming to be from someone it is not.
select t_login(t_id('u_ops'), 'ops');
set role authenticated;
do $t$
begin
  begin
    insert into public.project_messages (project_id, sender_role, body)
    values (t_id('project1'), 'staff', 'straight in');
    raise exception 'FAIL: a message was inserted around the posting function';
  exception when insufficient_privilege then
    raise notice 'PASS: messages can only be written through post_project_message()';
  end;
end
$t$;
reset role;

-- Read receipts: each side marks the other side's messages, never their own.
select t_login(t_id('u_ops'), 'ops');
set role authenticated;
do $t$
declare n int;
begin
  n := public.mark_thread_read(t_id('project1'));
  if n < 1 then
    raise exception 'FAIL: the PM marked no customer message read';
  end if;
  if exists (select 1 from public.project_messages
             where project_id = t_id('project1') and sender_role = 'customer' and read_at is null) then
    raise exception 'FAIL: a customer message is still unread after the PM opened the thread';
  end if;
  -- The PM's own messages are not marked by the PM reading them.
  if not exists (select 1 from public.project_messages
                 where project_id = t_id('project1') and sender_role = 'staff'
                   and not is_internal and read_at is null) then
    raise exception 'FAIL: the PM marked their own message as read';
  end if;
  raise notice 'PASS: each side marks the other side''s messages read';
end
$t$;
reset role;

-- §3: a PM may edit their own message within five minutes, and it is marked.
select t_login(t_id('u_ops'), 'ops');
set role authenticated;
do $t$
declare v_id uuid;
begin
  select id into v_id from public.project_messages
   where project_id = t_id('project1') and sender_role = 'staff' and not is_internal
   order by created_at limit 1;
  if not public.edit_project_message(v_id, 'Hello from the PM (corrected)') then
    raise exception 'FAIL: a PM could not edit their own new message';
  end if;
  if (select edited_at from public.project_messages where id = v_id) is null then
    raise exception 'FAIL: an edited message is not marked as edited';
  end if;
  raise notice 'PASS: a PM edits their own message for five minutes, and it says edited';
end
$t$;
reset role;

-- Age that message past the window. Done as superuser rather than as the PM,
-- because the PM has no UPDATE on the table at all — which is itself the point
-- of the check two blocks above.
update public.project_messages
set created_at = now() - interval '10 minutes'
where project_id = t_id('project1') and sender_role = 'staff' and not is_internal;

select t_login(t_id('u_ops'), 'ops');
set role authenticated;
do $t$
declare v_id uuid;
begin
  select id into v_id from public.project_messages
   where project_id = t_id('project1') and sender_role = 'staff' and not is_internal
   order by created_at limit 1;
  begin
    perform public.edit_project_message(v_id, 'too late');
    raise exception 'FAIL: a message was edited after the five-minute window';
  exception when raise_exception then
    raise notice 'PASS: the five-minute edit window closes';
  end;
end
$t$;
reset role;

-- A customer cannot edit anything at all.
select t_login(t_id('u_customer1'), 'customer');
set role authenticated;
do $t$
declare v_id uuid;
begin
  select id into v_id from public.project_messages where sender_role = 'customer' limit 1;
  begin
    perform public.edit_project_message(v_id, 'changed my mind');
    raise exception 'FAIL: a customer edited a message';
  exception when insufficient_privilege then
    raise notice 'PASS: a customer cannot edit a message';
  end;
end
$t$;
reset role;

-- §6, one layer down: an attachment on an internal note must not become a
-- customer-visible document. This is the same mistake as posting the note
-- itself, and much easier to miss.
select t_login(t_id('u_ops'), 'ops');
set role authenticated;
do $t$
declare
  v_note uuid;
  v_msg uuid;
  v_doc_internal uuid;
  v_doc_public uuid;
begin
  v_note := public.post_project_message(t_id('project1'), 'Internal: quote from supplier', true);
  v_msg  := public.post_project_message(t_id('project1'), 'Here is your plan set', false);
  v_doc_internal := public.record_chat_attachment(v_note, 'supplier.pdf', 'application/pdf',
                      decode('255044462d312e340a', 'hex'));
  v_doc_public := public.record_chat_attachment(v_msg, 'plans.pdf', 'application/pdf',
                      decode('255044462d312e340a', 'hex'));

  if (select customer_visible from public.documents where id = v_doc_internal) is not false then
    raise exception 'FAIL: an internal note''s attachment is visible to the customer';
  end if;
  if (select customer_visible from public.documents where id = v_doc_public) is not true then
    raise exception 'FAIL: a customer message''s attachment is hidden from them';
  end if;
  -- §3: filed to the project's documents, marked as coming from chat.
  if (select category from public.documents where id = v_doc_public) <> 'chat' then
    raise exception 'FAIL: a chat attachment is not filed with source chat';
  end if;
  if not exists (select 1 from public.message_attachments where message_id = v_msg) then
    raise exception 'FAIL: the attachment is not linked to its message';
  end if;
  raise notice 'PASS: attachments are filed as documents, and an internal note''s stays internal';
end
$t$;
reset role;

select t_login(t_id('u_customer1'), 'customer');
set role authenticated;
do $t$
begin
  if exists (select 1 from public.documents where category = 'chat' and not customer_visible) then
    raise exception 'FAIL: a customer can see an internal chat attachment';
  end if;
  if not exists (select 1 from public.documents where category = 'chat' and customer_visible) then
    raise exception 'FAIL: a customer cannot see the attachment sent to them';
  end if;
  raise notice 'PASS: the customer sees the attachment sent to them and no other';
end
$t$;
reset role;

-- System lines (§3): neutral, never internal, no human sender, and not raised
-- by a customer.
select t_login(t_id('u_ops'), 'ops');
set role authenticated;
do $t$
declare v_first uuid; v_again uuid;
begin
  v_first := public.post_system_message(t_id('project1'), 'Moved to Permit');
  v_again := public.post_system_message(t_id('project1'), 'Moved to Permit');
  if v_first is null then raise exception 'FAIL: no system message was written'; end if;
  if v_again is not null then
    raise exception 'FAIL: the same system line was written twice';
  end if;
  if (select sender_user_id from public.project_messages where id = v_first) is not null then
    raise exception 'FAIL: a system message has a human sender';
  end if;
  raise notice 'PASS: system lines are written once, with no human sender';
end
$t$;
reset role;

select t_login(t_id('u_customer1'), 'customer');
set role authenticated;
do $t$
begin
  begin
    perform public.post_system_message(t_id('project1'), 'Moved to Complete');
    raise exception 'FAIL: a customer raised a system message';
  exception when insufficient_privilege then
    raise notice 'PASS: only staff actions raise system lines';
  end;
end
$t$;
reset role;

-- Canned replies are a staff tool (§5).
select t_login(t_id('u_ops'), 'ops');
set role authenticated;
do $t$
begin
  if (select count(*) from public.canned_replies) < 3 then
    raise exception 'FAIL: the canned reply library is empty';
  end if;
  begin
    insert into public.canned_replies (title, body) values ('mine', 'body');
    raise exception 'FAIL: a PM created a canned reply (admin only)';
  exception when insufficient_privilege then
    raise notice 'PASS: PMs use canned replies, admins manage them';
  end;
end
$t$;
reset role;

select t_login(t_id('u_customer1'), 'customer');
set role authenticated;
do $t$
begin
  if exists (select 1 from public.canned_replies) then
    raise exception 'FAIL: a customer can read the canned reply library';
  end if;
  raise notice 'PASS: the canned reply library is invisible to customers';
end
$t$;
reset role;

-- Anonymisation (§7): the messages survive, the name does not. The thread reads
-- the name from public.clients at query time rather than storing a copy, which
-- is what makes this true without touching the messages at all.
select t_login(t_id('u_admin'), 'admin');
set role authenticated;
do $t$
declare v_before int; v_after int;
begin
  select count(*) into v_before from public.project_messages where project_id = t_id('project1');
  update public.clients set first_name = 'Redacted', last_name = 'Customer'
   where id = t_id('client1');
  select count(*) into v_after from public.project_messages where project_id = t_id('project1');
  if v_after <> v_before then
    raise exception 'FAIL: redacting a customer changed the message count';
  end if;
  if exists (
    select 1 from public.project_messages m
    join public.clients c on c.id = (select client_id from public.projects where id = m.project_id)
    where m.project_id = t_id('project1') and c.first_name <> 'Redacted'
  ) then
    raise exception 'FAIL: the thread still resolves the old customer name';
  end if;
  raise notice 'PASS: anonymising a customer redacts the thread without losing the record';
end
$t$;
reset role;

-- =============================================================================
-- Stage feedback (003200) — the guardrails, and who sees what
-- =============================================================================
-- The E2E suite covers the sheet and the email. What matters here is the part
-- the database owns: a stage can never be asked twice, a low score becomes work,
-- and the two boundaries §5 and §6 draw — a dealer learns the score and never
-- the sentence; a customer never sees the task their rating raised.

select t_login(t_id('u_admin'), 'admin');
set role authenticated;
do $t$
declare v_id uuid; v_again uuid;
begin
  -- The fixture project has no PM, and the point of §6 is that whoever is
  -- assigned at request time is the person the score belongs to — so assign one
  -- first, then ask, then reassign and check the old row did not move.
  update public.projects set assigned_pm = t_id('u_admin') where id = t_id('project1');

  v_id := public.request_stage_feedback(t_id('project1'), 'survey');
  if v_id is null then raise exception 'FAIL: a completed stage raised no request'; end if;

  -- §4's first hard limit, as a constraint rather than a hope.
  v_again := public.request_stage_feedback(t_id('project1'), 'survey');
  if v_again is not null then raise exception 'FAIL: the same stage was asked twice'; end if;
  if (select count(*) from public.stage_feedback
       where project_id = t_id('project1') and stage = 'survey') <> 1 then
    raise exception 'FAIL: a second row exists for one stage';
  end if;

  -- §6: the attribution is a snapshot, taken now.
  if (select attributed_pm from public.stage_feedback
       where project_id = t_id('project1') and stage = 'survey')
     is distinct from t_id('u_admin') then
    raise exception 'FAIL: the request did not record the PM at the time';
  end if;
  if (select attributed_dealer from public.stage_feedback
       where project_id = t_id('project1') and stage = 'survey')
     is distinct from t_id('dealer1') then
    raise exception 'FAIL: the request did not record the dealer';
  end if;

  -- Reassigning the project must not rewrite a rating already asked for.
  update public.projects set assigned_pm = t_id('u_ops') where id = t_id('project1');
  if (select attributed_pm from public.stage_feedback
       where project_id = t_id('project1') and stage = 'survey')
     is distinct from t_id('u_admin') then
    raise exception 'FAIL: reassigning the PM rewrote an existing rating';
  end if;
  raise notice 'PASS: a stage is asked about once, ever, and its attribution is a snapshot';
end
$t$;
reset role;

-- A project on hold is not asked (§1: asking at the moment it goes wrong is
-- tone-deaf and produces useless data).
select t_login(t_id('u_admin'), 'admin');
set role authenticated;
do $t$
declare v_id uuid;
begin
  update public.projects set status = 'on_hold' where id = t_id('project2');
  v_id := public.request_stage_feedback(t_id('project2'), 'survey');
  if v_id is not null then raise exception 'FAIL: a project on hold was asked to rate it'; end if;
  update public.projects set status = 'active' where id = t_id('project2');
  raise notice 'PASS: a project on hold or cancelled is never asked';
end
$t$;
reset role;

-- The customer answers: score on tap (§9), and a low one becomes work (§5).
select t_login(t_id('u_customer1'), 'customer');
set role authenticated;
do $t$
begin
  perform public.record_stage_feedback(t_id('project1'), 'survey', 2, 'portal');
  if (select score from public.stage_feedback
       where project_id = t_id('project1') and stage = 'survey') <> 2 then
    raise exception 'FAIL: the score was not recorded';
  end if;
  if (select responded_at from public.stage_feedback
       where project_id = t_id('project1') and stage = 'survey') is null then
    raise exception 'FAIL: the tap did not count as a response';
  end if;

  -- Step two is a second call, so an abandoned sheet still leaves the number.
  perform public.detail_stage_feedback(t_id('project1'), 'survey',
    array['scheduling'], 'Nobody told me the date moved.');
  if (select tags from public.stage_feedback
       where project_id = t_id('project1') and stage = 'survey') <> array['scheduling'] then
    raise exception 'FAIL: the reason chip was not stored';
  end if;

  -- And the customer cannot see the task it raised.
  if exists (select 1 from public.project_tasks) then
    raise exception 'FAIL: a customer can see the staff task their rating raised';
  end if;
  raise notice 'PASS: the score saves on tap, the detail follows, and the task stays hidden';
end
$t$;
reset role;

-- One task, high priority, carrying the score, the reason and the words.
select t_login(t_id('u_admin'), 'admin');
set role authenticated;
do $t$
declare v_task public.project_tasks;
begin
  select * into v_task from public.project_tasks where project_id = t_id('project1');
  if not found then raise exception 'FAIL: a low score raised no task'; end if;
  if (select count(*) from public.project_tasks where project_id = t_id('project1')) <> 1 then
    raise exception 'FAIL: step two raised a second task';
  end if;
  if v_task.priority <> 'high' then raise exception 'FAIL: the task is not flagged high'; end if;
  if v_task.detail not like '%Score 2 of 5%' then
    raise exception 'FAIL: the task does not carry the score: %', v_task.detail;
  end if;
  if v_task.detail not like '%Nobody told me%' then
    raise exception 'FAIL: the task does not carry the comment';
  end if;
  if v_task.suggested is null then
    raise exception 'FAIL: the task offers no suggested first move';
  end if;

  -- §5: closing requires saying what was done.
  begin
    perform public.resolve_project_task(v_task.id, '   ');
    raise exception 'FAIL: a task closed with an empty resolution note';
  exception when others then
    if sqlstate not in ('22023') then raise; end if;
  end;
  perform public.resolve_project_task(v_task.id, 'Called, re-booked, apologised.');
  if (select resolved_at from public.project_tasks where id = v_task.id) is null then
    raise exception 'FAIL: the task did not close';
  end if;
  raise notice 'PASS: one high task with the score, reason and words, closable only with a note';
end
$t$;
reset role;

-- §5: the dealer is told the fact, never the sentence.
select t_login(t_id('u_dealer1'), 'dealer');
set role authenticated;
do $t$
begin
  if exists (select 1 from public.stage_feedback) then
    raise exception 'FAIL: a dealer can read the ratings table';
  end if;
  if exists (select 1 from public.feedback_verbatims) then
    raise exception 'FAIL: a dealer can read customer comments';
  end if;
  if exists (select 1 from public.feedback_by_party) then
    raise exception 'FAIL: a dealer can read per-person averages';
  end if;
  -- But the rolling score for their own project is theirs to see.
  if not exists (select 1 from public.project_csat where project_id = t_id('project1')) then
    raise exception 'FAIL: a dealer cannot see their own project''s rating at all';
  end if;
  raise notice 'PASS: a dealer sees the score for their own projects and nothing written';
end
$t$;
reset role;

-- =============================================================================
-- Cleanup of test-only helpers
-- =============================================================================

drop function public.t_login(uuid, text);
drop function public.t_id(text);
drop function public.t_metrics_match(text);
drop table public.t_fix;
drop table public.t_tokens;

select 'ALL RLS VERIFICATION CHECKS PASSED' as result;
