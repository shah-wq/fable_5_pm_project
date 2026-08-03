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

-- Customer leaves stage feedback on their own behalf only.
select t_login(t_id('u_customer1'), 'customer');
set role authenticated;
do $t$
begin
  insert into public.stage_feedback (project_id, stage, rating, feedback, source, created_by)
  values (t_id('project1'), 'survey', 5, 'Great crew!', 'customer', t_id('u_customer1'));

  begin
    insert into public.stage_feedback (project_id, stage, rating, source, created_by)
    values (t_id('project1'), 'survey', 1, 'customer', t_id('u_designer1'));
    raise exception 'FAIL: customer forged feedback author';
  exception when insufficient_privilege then
    raise notice 'PASS: feedback author cannot be spoofed';
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
-- Cleanup of test-only helpers
-- =============================================================================

drop function public.t_login(uuid, text);
drop function public.t_id(text);
drop table public.t_fix;
drop table public.t_tokens;

select 'ALL RLS VERIFICATION CHECKS PASSED' as result;
