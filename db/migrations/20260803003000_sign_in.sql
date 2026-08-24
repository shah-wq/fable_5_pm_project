-- =============================================================================
-- 003000 — Sign-in & role entry
-- =============================================================================
-- Implements the Sign-in Screens specification. Most of that document is about
-- pixels; this file is the part that cannot live in a page.
--
-- §5: "one login endpoint, one validation path, one rate limiter and one
-- role-routing function — three separate implementations is how you end up with
-- a security fix applied to two of them." The three pages therefore call one
-- database function, auth.sign_in(), which is the only place credentials are
-- checked from now on.
--
-- What is new here beyond a wrapper:
--
--  1. Rate limiting per account AND per IP (§5). The auth engine already locked
--     an account after ten failures; that alone does nothing about one host
--     spraying one password across a thousand addresses, which is what
--     credential stuffing actually looks like. The IP counter is the half that
--     was missing.
--
--  2. A progressive delay before the lockout. Ten free guesses then a wall is
--     worse for both sides than a delay that grows: an attacker's throughput
--     collapses after three attempts, while a person who mistyped their own
--     password twice notices nothing at all.
--
--  3. An outcome code rather than an empty result. The old function returned no
--     rows for "no such user", "wrong password", "locked" and "deleted profile"
--     alike, so the route could not tell a rate-limited caller they were rate
--     limited. The pages still show one generic message for wrong credentials —
--     never revealing whether an address exists, and never which role it
--     belongs to — but "too many attempts, try again in 12 minutes" is a
--     different fact and the person typing needs it.
--
-- The counters are keyed by email address, not by user id, so an unknown
-- address is throttled exactly like a known one. Counting only real accounts
-- would turn the rate limiter itself into the account oracle the login page is
-- careful not to be.

-- -----------------------------------------------------------------------------
-- 1. The counters
-- -----------------------------------------------------------------------------

create table if not exists auth.login_throttle (
  /** 'email' — one address being guessed at. 'ip' — one host guessing. */
  scope            text not null check (scope in ('email', 'ip')),
  key              text not null,
  failures         integer not null default 0,
  first_failure_at timestamptz not null default now(),
  last_failure_at  timestamptz not null default now(),
  locked_until     timestamptz,
  primary key (scope, key)
);

-- Housekeeping: rows are worthless once their window has passed, and this table
-- would otherwise grow one row per address anybody ever mistyped.
create index if not exists login_throttle_last_failure_idx
  on auth.login_throttle (last_failure_at);

-- Nothing outside the definer functions below touches this table. It is in the
-- auth schema, which the application role has no blanket grant on, but say it
-- explicitly: a table that records "this address is being guessed at" is not one
-- to leave readable.
revoke all on auth.login_throttle from public;

-- -----------------------------------------------------------------------------
-- 2. The policy, in one place
-- -----------------------------------------------------------------------------
-- Named constants as a function rather than magic numbers spread through the
-- logic, so the shape of the policy can be read in one screen:
--
--   * failures inside a 15-minute window count together; a quiet 15 minutes
--     forgets everything, so a person who gets it right tomorrow starts clean;
--   * from the third failure a delay applies, doubling to a cap of 8 seconds;
--   * ten failures on one address, or forty from one host, close the door for
--     15 minutes.
--
-- Forty rather than ten for the IP: a family, an office or a mobile carrier's
-- NAT shares one address, and locking a whole office out because one person
-- forgot their password is a self-inflicted outage.

create or replace function auth.throttle_window() returns interval
  language sql immutable as $$ select interval '15 minutes' $$;

create or replace function auth.throttle_lockout() returns interval
  language sql immutable as $$ select interval '15 minutes' $$;

create or replace function auth.throttle_limit(p_scope text) returns integer
  language sql immutable as $$ select case when p_scope = 'ip' then 40 else 10 end $$;

/** The pause to apply before answering a failed attempt, in milliseconds. */
create or replace function auth.throttle_delay_ms(p_failures integer)
returns integer
language sql
immutable
as $$
  select case
    when coalesce(p_failures, 0) < 3 then 0
    else least(8000, (250 * power(2, p_failures - 2))::integer)
  end
$$;

-- -----------------------------------------------------------------------------
-- 3. Recording a failure and asking whether the door is shut
-- -----------------------------------------------------------------------------

/**
 * Note one failed attempt against one counter and return the state it leaves.
 *
 * The upsert resets the count when the previous failure is older than the
 * window: a sliding window without a background job to expire rows.
 */
create or replace function auth.throttle_fail(p_scope text, p_key text)
returns table (f_failures integer, f_locked_until timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null or btrim(p_key) = '' then
    return query select 0, null::timestamptz;
    return;
  end if;

  insert into auth.login_throttle as t (scope, key, failures)
  values (p_scope, lower(btrim(p_key)), 1)
  on conflict (scope, key) do update
  set failures = case
        when t.last_failure_at < now() - auth.throttle_window() then 1
        else t.failures + 1
      end,
      first_failure_at = case
        when t.last_failure_at < now() - auth.throttle_window() then now()
        else t.first_failure_at
      end,
      last_failure_at = now(),
      locked_until = case
        when (case
                when t.last_failure_at < now() - auth.throttle_window() then 1
                else t.failures + 1
              end) >= auth.throttle_limit(p_scope)
        then now() + auth.throttle_lockout()
      end
  -- The OUT parameters are named f_* because a RETURNING clause resolves
  -- unqualified names to the table's columns first: OUT parameters called
  -- `failures` and `locked_until` would be ambiguous with the very columns being
  -- returned, and the function would not compile.
  returning t.failures, t.locked_until
  into f_failures, f_locked_until;

  return query select f_failures, f_locked_until;
end;
$$;

/** Seconds until this counter reopens, or 0 when it is not locked. */
create or replace function auth.throttle_retry_after(p_scope text, p_key text)
returns integer
language sql
security definer
set search_path = ''
as $$
  select coalesce(
    (select greatest(0, ceil(extract(epoch from (t.locked_until - now())))::integer)
     from auth.login_throttle t
     where t.scope = p_scope and t.key = lower(btrim(coalesce(p_key, '')))
       and t.locked_until is not null and t.locked_until > now()),
    0)
$$;

/**
 * Forget the counters for an address (and optionally the host that got it
 * right). Called on a successful sign-in, and after a password reset — a person
 * who has just proved control of their inbox should not then be told to wait
 * out a lockout they no longer deserve.
 */
create or replace function auth.throttle_clear(p_email text, p_ip text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.login_throttle
  where (scope = 'email' and key = lower(btrim(coalesce(p_email, ''))))
     or (scope = 'ip' and p_ip is not null and key = lower(btrim(p_ip)));
$$;

-- Note what is deliberately NOT here: a "clear the lock for this user id"
-- function the application could call. It looks harmless — it holds no secret
-- and returns nothing — but any caller who could reach it could guess nine
-- times, clear the counter, and guess nine more, for ever. The lockout would
-- become decoration. The only thing that clears a counter is proving you are the
-- account holder, which is what the two paths below do.

-- Old rows serve no purpose once their window has passed. Called from sign_in on
-- a small sample of attempts, so the table stays flat with no scheduler — there
-- is no cron in this deployment and adding one for housekeeping would be a
-- moving part to maintain for the rest of the product's life.
create or replace function auth.throttle_sweep()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.login_throttle
  where last_failure_at < now() - interval '1 day'
    and (locked_until is null or locked_until < now())
$$;

-- -----------------------------------------------------------------------------
-- 4. The one authentication path
-- -----------------------------------------------------------------------------

/**
 * Check credentials once, for all three sign-in pages.
 *
 * Outcomes:
 *   'locked'   — rate limited. retry_after says for how long.
 *   'invalid'  — no such address, or the wrong password. Identical either way;
 *                delay_ms is how long the caller should wait before answering.
 *   'disabled' — the password was right and the account is deactivated. §5 wants
 *                this said plainly: "the user needs to know it is not their
 *                typing". It reveals nothing to a guesser, because reaching it
 *                requires the correct password.
 *   'ok'       — signed in. session_token is set; the caller decides where the
 *                role lands, which is the one thing this function deliberately
 *                does not know.
 *
 * The role is returned but never checked against the page that was used. A
 * homeowner who types their details into the staff form has proved who they are;
 * §5's answer is to take them to their own surface, not to refuse them.
 */
create or replace function auth.sign_in(p_email text, p_password text, p_ip text default null)
returns table (
  outcome               text,
  user_id               uuid,
  session_token         text,
  user_role             public.user_role,
  full_name             text,
  force_password_change boolean,
  delay_ms              integer,
  retry_after           integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_ip      text := nullif(btrim(coalesce(p_ip, '')), '');
  v_wait    integer;
  v_login   record;
  v_fail    record;
begin
  -- One attempt in fifty pays for the housekeeping.
  if random() < 0.02 then
    perform auth.throttle_sweep();
  end if;

  v_wait := greatest(
    auth.throttle_retry_after('email', v_email),
    case when v_ip is null then 0 else auth.throttle_retry_after('ip', v_ip) end
  );
  if v_wait > 0 then
    return query select 'locked'::text, null::uuid, null::text, null::public.user_role,
                        null::text, false, 0, v_wait;
    return;
  end if;

  select * into v_login from auth.login_with_password(v_email, p_password);

  -- No row means unknown address, wrong password, or an account the engine has
  -- locked. All three answer identically; only the delay differs, and it grows
  -- with the number of failures rather than with anything about the account.
  if not found then
    select * into v_fail from auth.throttle_fail('email', v_email);
    if v_ip is not null then
      perform auth.throttle_fail('ip', v_ip);
    end if;
    return query select 'invalid'::text, null::uuid, null::text, null::public.user_role,
                        null::text, false,
                        auth.throttle_delay_ms(v_fail.f_failures),
                        greatest(0, coalesce(
                          ceil(extract(epoch from (v_fail.f_locked_until - now())))::integer, 0));
    return;
  end if;

  -- Right password: the counters have done their job either way.
  perform auth.throttle_clear(v_email, v_ip);

  if not v_login.is_active or v_login.session_token is null then
    return query select 'disabled'::text, v_login.user_id, null::text, v_login.user_role,
                        v_login.full_name, false, 0, 0;
    return;
  end if;

  return query select 'ok'::text, v_login.user_id, v_login.session_token, v_login.user_role,
                      v_login.full_name, v_login.force_password_change, 0, 0;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Setting a password releases the lock
-- -----------------------------------------------------------------------------
-- §7: an expired link "offers to send a new one rather than dead-ending". The
-- same principle applies one step further along: somebody who has just proved
-- control of their inbox and chosen a new password must not then be told to wait
-- out a fifteen-minute lockout earned by forgetting the old one. That is the
-- dead end the whole reset flow exists to avoid.
--
-- The function is restated in full rather than patched from the application,
-- because the alternative — a clear-the-lock call the app makes after a reset —
-- is the escalation ruled out above. Here the release is welded to the one act
-- that proves identity, and cannot be invoked on its own.
--
-- Restated from the 001300 version, NOT the original in 001000: 001300 lowered
-- the minimum length and added the force_password_change clear, and copying the
-- older body would have silently undone both. When replacing a function an
-- earlier migration has already replaced, the last definition is the one to
-- start from.

create or replace function auth.set_password_with_token(p_token text, p_password text)
returns table (
  user_id       uuid,
  session_token text,
  user_role     public.user_role,
  full_name     text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token auth.one_time_tokens%rowtype;
  v_email text;
begin
  if length(coalesce(p_password, '')) < 8 then
    raise exception 'password must be at least 8 characters';
  end if;

  select t.* into v_token
  from auth.one_time_tokens t
  where t.token_hash = auth.hash_token(p_token)
    and t.purpose in ('invite', 'recovery')
    and t.consumed_at is null
    and t.expires_at > now();
  if not found then
    return;
  end if;

  update auth.one_time_tokens t set consumed_at = now() where t.id = v_token.id;

  update auth.users u
  set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
      email_confirmed_at = coalesce(u.email_confirmed_at, now()),
      force_password_change = false,
      failed_attempts = 0, locked_until = null, updated_at = now()
  where u.id = v_token.user_id
  returning u.email into v_email;

  perform auth.revoke_all_sessions(v_token.user_id);

  -- The one new line: forget the rate-limit counters for this address too, so
  -- the new password works immediately rather than in a quarter of an hour.
  perform auth.throttle_clear(v_email, null);

  return query
    select v_token.user_id, auth.new_session(v_token.user_id), p.role, p.full_name
    from public.profiles p
    where p.id = v_token.user_id and p.is_active;
end;
$$;

revoke execute on function auth.set_password_with_token(text, text) from public, anon;
grant execute on function auth.set_password_with_token(text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------
-- The application signs in as `authenticated` with no claims (withAnon), so
-- that is the role that needs execute. Everything else stays shut: the throttle
-- primitives are internal, and letting a caller reach throttle_fail directly
-- would hand them a way to lock any address out of the product.

revoke execute on function
  auth.throttle_window(),
  auth.throttle_lockout(),
  auth.throttle_limit(text),
  auth.throttle_delay_ms(integer),
  auth.throttle_fail(text, text),
  auth.throttle_retry_after(text, text),
  auth.throttle_clear(text, text),
  auth.throttle_sweep(),
  auth.sign_in(text, text, text)
from public, anon;

grant execute on function auth.sign_in(text, text, text) to authenticated;
