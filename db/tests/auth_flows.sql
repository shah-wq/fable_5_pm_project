-- =============================================================================
-- AUTH ENGINE VERIFICATION — passwords, sessions, OTP, invites, recovery,
-- lockout, and the file read/write functions (001000–001100).
-- =============================================================================
-- Runs after rls_verification.sql on the same throwaway database. All calls
-- execute as the `authenticated` role, exactly like the app does.

\set ON_ERROR_STOP on

create table public.t2 (key text primary key, val text not null);
grant select, insert on public.t2 to authenticated, anon;

-- Clear any request claims left over from earlier suites.
select set_config('request.jwt.claims', '', false);

-- -----------------------------------------------------------------------------
-- 1. Invite → accept → password login (staff)
-- -----------------------------------------------------------------------------

set role authenticated;
do $t$
declare inv record; acc record; log record; n int;
begin
  select * into inv from auth.create_invited_user('newops@example.test', 'ops', 'New Ops');
  if inv.invite_token is null then raise exception 'FAIL: staff invite has no token'; end if;
  insert into public.t2 values ('ops_uid', inv.user_id::text);

  if (select role from public.profiles where id = inv.user_id) <> 'ops' then
    raise exception 'FAIL: invited profile did not get the ops role';
  end if;

  -- Password too short is rejected outright.
  begin
    perform * from auth.set_password_with_token(inv.invite_token, 'short');
    raise exception 'FAIL: short password accepted';
  exception when others then
    if sqlerrm not like '%at least 10 characters%' then raise; end if;
  end;

  select * into acc from auth.set_password_with_token(inv.invite_token, 'op5-secure-pass!');
  if acc.session_token is null or acc.user_role <> 'ops' then
    raise exception 'FAIL: invite acceptance did not sign in';
  end if;

  -- Token is single-use.
  select count(*) into n from auth.set_password_with_token(inv.invite_token, 'another-pass-123');
  if n <> 0 then raise exception 'FAIL: invite token worked twice'; end if;

  select * into log from auth.login_with_password('newops@example.test', 'op5-secure-pass!');
  if log.session_token is null then raise exception 'FAIL: password login failed after invite'; end if;
  insert into public.t2 values ('ops_session', log.session_token);

  select count(*) into n from auth.login_with_password('newops@example.test', 'wrong-password');
  if n <> 0 then raise exception 'FAIL: wrong password logged in'; end if;

  raise notice 'PASS: invite -> set password -> login lifecycle';
end
$t$;

-- -----------------------------------------------------------------------------
-- 2. Session validation carries fresh role/active state
-- -----------------------------------------------------------------------------

do $t$
declare v record; n int;
begin
  select * into v from auth.validate_session((select val from public.t2 where key = 'ops_session'));
  if v.user_id::text <> (select val from public.t2 where key = 'ops_uid')
     or v.user_role <> 'ops' or not v.is_active then
    raise exception 'FAIL: session did not validate to the ops user';
  end if;

  select count(*) into n from auth.validate_session('completely-made-up-token');
  if n <> 0 then raise exception 'FAIL: bogus session token validated'; end if;

  perform auth.logout((select val from public.t2 where key = 'ops_session'));
  select count(*) into n from auth.validate_session((select val from public.t2 where key = 'ops_session'));
  if n <> 0 then raise exception 'FAIL: revoked session still validates'; end if;

  raise notice 'PASS: sessions validate, reject garbage, and die on logout';
end
$t$;

-- Deactivation kills validation immediately.
reset role;
do $t$
declare v record; s text;
begin
  s := (select session_token from auth.login_with_password('newops@example.test', 'op5-secure-pass!'));
  update public.profiles set is_active = false
  where id = (select val from public.t2 where key = 'ops_uid')::uuid;

  select * into v from auth.validate_session(s);
  if v.is_active then raise exception 'FAIL: deactivated profile still reads active'; end if;

  update public.profiles set is_active = true
  where id = (select val from public.t2 where key = 'ops_uid')::uuid;
  raise notice 'PASS: deactivation is visible on the very next request';
end
$t$;

-- -----------------------------------------------------------------------------
-- 3. Lockout after repeated failures
-- -----------------------------------------------------------------------------

set role authenticated;
do $t$
declare n int; i int;
begin
  for i in 1..10 loop
    perform * from auth.login_with_password('newops@example.test', 'bad-guess-' || i);
  end loop;
  -- Correct password now fails: locked.
  select count(*) into n from auth.login_with_password('newops@example.test', 'op5-secure-pass!');
  if n <> 0 then raise exception 'FAIL: lockout did not engage after 10 failures'; end if;
  raise notice 'PASS: 10 bad passwords -> 10-minute lockout';
end
$t$;
reset role;
update auth.users set failed_attempts = 0, locked_until = null
where lower(email) = 'newops@example.test';

-- -----------------------------------------------------------------------------
-- 4. Customer OTP (no passwords, wrong-code attempts capped)
-- -----------------------------------------------------------------------------

set role authenticated;
do $t$
declare inv record; c text; v record; n int; i int;
begin
  select * into inv from auth.create_invited_user('newcust@example.test', 'customer', 'New Customer');
  if inv.invite_token is not null then
    raise exception 'FAIL: customers must not get set-password invites';
  end if;
  insert into public.t2 values ('cust_uid', inv.user_id::text);

  c := (select code from auth.request_otp('newcust@example.test'));
  if c is null or c !~ '^[0-9]{6}$' then raise exception 'FAIL: no 6-digit OTP issued'; end if;

  select count(*) into n from auth.verify_otp('newcust@example.test', '000000');
  if n <> 0 and c <> '000000' then raise exception 'FAIL: wrong OTP verified'; end if;

  select * into v from auth.verify_otp('newcust@example.test', c);
  if v.session_token is null or v.user_role <> 'customer' then
    raise exception 'FAIL: correct OTP did not sign the customer in';
  end if;

  -- Consumed: same code again is dead.
  select count(*) into n from auth.verify_otp('newcust@example.test', c);
  if n <> 0 then raise exception 'FAIL: OTP reusable'; end if;

  -- Staff cannot use the OTP door.
  select count(*) into n from auth.request_otp('newops@example.test');
  if n <> 0 then raise exception 'FAIL: staff got an OTP'; end if;

  -- Five wrong attempts burn the code.
  c := (select code from auth.request_otp('newcust@example.test'));
  for i in 1..5 loop
    perform * from auth.verify_otp('newcust@example.test', '999999');
  end loop;
  select count(*) into n from auth.verify_otp('newcust@example.test', c);
  if n <> 0 then raise exception 'FAIL: OTP survived 5 wrong attempts'; end if;

  raise notice 'PASS: customer OTP flow (issue, verify, consume, attempt cap, staff excluded)';
end
$t$;

-- -----------------------------------------------------------------------------
-- 5. Recovery resets the password and revokes other sessions
-- -----------------------------------------------------------------------------

do $t$
declare s1 text; r text; res record; n int;
begin
  s1 := (select session_token from auth.login_with_password('newops@example.test', 'op5-secure-pass!'));
  r := (select recovery_token from auth.request_recovery('newops@example.test'));
  if r is null then raise exception 'FAIL: no recovery token for staff'; end if;

  select count(*) into n from auth.request_recovery('newcust@example.test');
  if n <> 0 then raise exception 'FAIL: customer got a recovery token'; end if;

  select * into res from auth.set_password_with_token(r, 'brand-new-pass-42');
  if res.session_token is null then raise exception 'FAIL: recovery did not sign in'; end if;

  select count(*) into n from auth.validate_session(s1);
  if n <> 0 then raise exception 'FAIL: old session survived a password reset'; end if;

  select count(*) into n from auth.login_with_password('newops@example.test', 'op5-secure-pass!');
  if n <> 0 then raise exception 'FAIL: old password still works'; end if;
  select count(*) into n from auth.login_with_password('newops@example.test', 'brand-new-pass-42');
  if n <> 1 then raise exception 'FAIL: new password does not work'; end if;

  raise notice 'PASS: recovery flow resets password and revokes sessions';
end
$t$;

-- -----------------------------------------------------------------------------
-- 6. Invite privilege guard: a non-admin user context cannot invite
-- -----------------------------------------------------------------------------

do $t$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', (select val from public.t2 where key = 'ops_uid'),
                      'role', 'authenticated', 'user_role', 'ops')::text, true);
  begin
    perform * from auth.create_invited_user('sneaky@example.test', 'admin', null);
    raise exception 'FAIL: ops invited an admin';
  exception when insufficient_privilege then
    raise notice 'PASS: only admins (or trusted bootstrap) may invite';
  end;
end
$t$;
reset role;

-- -----------------------------------------------------------------------------
-- 7. File storage functions: grant upload + governed download
-- -----------------------------------------------------------------------------

-- Fixtures: a project with the ops user as staff (ops is staff everywhere),
-- plus a customer on it and an unrelated customer.
insert into public.dealers (id, name) values ('a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7', 'AuthFlow Dealer');
insert into public.clients (id, dealer_id, user_id, first_name, last_name)
values ('b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7', 'a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7',
        (select id from auth.users where email = 'newcust@example.test'), 'Auth', 'Flow');
insert into public.projects (id, name, dealer_id, client_id)
values ('c7c7c7c7-c7c7-4c7c-8c7c-c7c7c7c7c7c7', 'AuthFlow PV',
        'a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7', 'b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7');

set role authenticated;
do $t$
declare g record; doc uuid; r record; n int;
begin
  -- Ops mints a delivery-photo grant (staff on all projects).
  perform set_config('request.jwt.claims',
    json_build_object('sub', (select val from public.t2 where key = 'ops_uid'),
                      'role', 'authenticated', 'user_role', 'ops')::text, true);
  select * into g from public.create_upload_grant(
    'c7c7c7c7-c7c7-4c7c-8c7c-c7c7c7c7c7c7', 'customer_delivery');

  -- The uploader has no session at all.
  perform set_config('request.jwt.claims', '', true);
  doc := public.record_grant_upload(g.token, 'porch photo.jpg', 'image/jpeg',
                                    decode('ffd8ffe000104a464946', 'hex'));
  if doc is null then raise exception 'FAIL: grant upload rejected'; end if;

  doc := public.record_grant_upload('bogus-token', 'x.jpg', 'image/jpeg', decode('ff', 'hex'));
  if doc is not null then raise exception 'FAIL: bogus token uploaded'; end if;

  begin
    doc := public.record_grant_upload(g.token, 'evil.exe', 'application/octet-stream', decode('ff', 'hex'));
    raise exception 'FAIL: non-photo mime accepted';
  exception when others then
    if sqlerrm not like '%only photos%' then raise; end if;
  end;

  -- Download rules: the project's customer sees the delivery photo (it is
  -- customer_visible); an unrelated user gets nothing.
  perform set_config('request.jwt.claims',
    json_build_object('sub', (select val from public.t2 where key = 'cust_uid'),
                      'role', 'authenticated', 'user_role', 'customer')::text, true);
  select count(*) into n
  from public.documents d, lateral public.read_document(d.id) rd
  where d.project_id = 'c7c7c7c7-c7c7-4c7c-8c7c-c7c7c7c7c7c7';
  if n <> 1 then raise exception 'FAIL: project customer cannot read their delivery photo (%)', n; end if;

  select d.id into doc from public.documents d
  where d.project_id = 'c7c7c7c7-c7c7-4c7c-8c7c-c7c7c7c7c7c7' limit 1;

  perform set_config('request.jwt.claims',
    json_build_object('sub', (select val from public.t2 where key = 'ops_uid'),
                      'role', 'authenticated', 'user_role', 'ops')::text, true);
  select octet_length(rd.data) into n from public.read_document(doc) rd;
  if n <> 10 then raise exception 'FAIL: ops read wrong blob size %', n; end if;

  perform set_config('request.jwt.claims', '', true);
  select count(*) into n from public.read_document(doc);
  if n <> 0 then raise exception 'FAIL: sessionless read of a document blob'; end if;

  raise notice 'PASS: grant uploads store blobs; downloads follow the access rules';
end
$t$;
reset role;

drop table public.t2;

select 'ALL AUTH ENGINE CHECKS PASSED' as result;
