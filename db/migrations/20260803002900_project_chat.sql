-- =============================================================================
-- 002900 — Project chat (PM ↔ customer)
-- =============================================================================
-- Implements the Project Chat specification: one thread per project, between
-- the PM and that project's customer, living on the project record so the whole
-- history stays with the job.
--
-- Two rules in this file are load-bearing, and both are enforced in the
-- database rather than left to the application:
--
--  1. §6 — internal notes and customer messages are different things. A
--     customer's SELECT cannot return an internal note, whatever query the app
--     sends, and a customer's INSERT cannot create one. The UI puts them on two
--     separate tabs with different colours; this is the layer that makes the
--     mistake impossible rather than merely unlikely.
--
--  2. §2 — dealers have no access. app.can_access_project() admits dealers and
--     designers, so it is deliberately NOT the test used here: the thread is
--     visible to staff (admin/ops) and to the project's own customer, and to
--     nobody else. Getting this wrong would put the dealer inside a
--     conversation the customer believes is private with their PM.
--
-- Also deliberate: sender_role is derived from the caller's own role inside a
-- definer function, never accepted as a parameter. A posting API that takes
-- "who this is from" is one bug away from a customer message that claims to be
-- from the PM.

-- -----------------------------------------------------------------------------
-- 1. The thread
-- -----------------------------------------------------------------------------

create table if not exists public.project_messages (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  /** Null once a staff account is deleted; the message and its role remain. */
  sender_user_id uuid references public.profiles (id) on delete set null,
  sender_role    text not null check (sender_role in ('customer', 'staff', 'system')),
  body           text not null check (length(btrim(body)) > 0 and length(body) <= 8000),
  /** 'about: Permit' — set when the thread is opened from a stage (§3). */
  stage_ref      public.project_stage,
  is_internal    boolean not null default false,
  /**
   * When the *other* party read it. A customer message is read by staff; a
   * staff message is read by the customer. §3: the PM sees the customer's read
   * receipt, the customer never sees the PM's — so this column is only ever
   * shown to staff.
   */
  read_at        timestamptz,
  edited_at      timestamptz,
  created_at     timestamptz not null default now(),
  -- System lines are never internal and never have a human sender.
  constraint project_messages_system_shape
    check (sender_role <> 'system' or (not is_internal and sender_user_id is null)),
  -- A customer's message is a customer message; it cannot be an internal note.
  constraint project_messages_customer_not_internal
    check (sender_role <> 'customer' or not is_internal)
);

-- §8: index on (project_id, created_at). Newest-first, because that is how the
-- thread is read and paged.
create index if not exists project_messages_thread_idx
  on public.project_messages (project_id, created_at desc);
-- The unread badges the PM sees on every surface.
create index if not exists project_messages_unread_idx
  on public.project_messages (project_id)
  where read_at is null and sender_role = 'customer';

-- Attachments are a join to public.documents rather than a column of file
-- names, because §3 requires every attachment to be filed to the project's
-- documents as well — "so nothing sent in conversation goes missing from the
-- record". One row here means one real document row, with a foreign key to
-- prove it, instead of two places that can disagree.
create table if not exists public.message_attachments (
  message_id  uuid not null references public.project_messages (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  primary key (message_id, document_id)
);

create index if not exists message_attachments_document_idx
  on public.message_attachments (document_id);

-- A PM can flag a thread to come back to (§5). One row per project, because
-- the flag belongs to the thread rather than to a person: whoever is covering
-- needs to see it.
create table if not exists public.project_chat_flags (
  project_id uuid primary key references public.projects (id) on delete cascade,
  flagged_at timestamptz not null default now(),
  flagged_by uuid references public.profiles (id) on delete set null,
  note       text
);

-- -----------------------------------------------------------------------------
-- 2. Who may see and post
-- -----------------------------------------------------------------------------

-- The project's own homeowner. Not app.can_access_project(), which also admits
-- the dealer and the assigned designer — see the header.
create or replace function app.is_project_customer(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
    where p.id = pid
      and p.client_id in (select app.current_client_ids())
  );
$$;

grant execute on function app.is_project_customer(uuid) to authenticated;

alter table public.project_messages enable row level security;
alter table public.message_attachments enable row level security;
alter table public.project_chat_flags enable row level security;

grant select on public.project_messages to authenticated;
grant select on public.message_attachments to authenticated;
grant select, insert, update, delete on public.project_chat_flags to authenticated;

-- Reads. Staff see everything including internal notes; the homeowner sees
-- their own project's customer-visible messages and nothing else. There is no
-- branch here that a dealer or a designer can satisfy.
drop policy if exists project_messages_select on public.project_messages;
create policy project_messages_select on public.project_messages
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'ops')
    or (not is_internal and app.is_project_customer(project_id))
  );

-- Writes go through public.post_project_message() only: sender_role and
-- is_internal must be derived from the caller, not supplied by them. No insert,
-- update or delete policy exists, so even a compromised app role cannot write a
-- message that claims to be from someone else — and nobody can delete one,
-- which §3 requires ("this is a business record, not a chat app").
revoke insert, update, delete on public.project_messages from authenticated;
revoke insert, update, delete on public.message_attachments from authenticated;

drop policy if exists message_attachments_select on public.message_attachments;
create policy message_attachments_select on public.message_attachments
  for select to authenticated
  using (
    exists (
      select 1 from public.project_messages m
      where m.id = message_id
        and (
          (select app.current_user_role()) in ('admin', 'ops')
          or (not m.is_internal and app.is_project_customer(m.project_id))
        )
    )
  );

-- The needs-reply flag is a staff tool; the customer must not see it at all.
drop policy if exists project_chat_flags_select on public.project_chat_flags;
create policy project_chat_flags_select on public.project_chat_flags
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'));

drop policy if exists project_chat_flags_write on public.project_chat_flags;
create policy project_chat_flags_write on public.project_chat_flags
  for all to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'))
  with check ((select app.current_user_role()) in ('admin', 'ops'));

-- -----------------------------------------------------------------------------
-- 3. Posting
-- -----------------------------------------------------------------------------
-- One function for both parties. It decides who the sender is from the session,
-- refuses an internal note from a customer, and refuses either of them on a
-- project that is not theirs.

create or replace function public.post_project_message(
  p_project_id uuid,
  p_body       text,
  p_internal   boolean default false,
  p_stage_ref  text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := app.current_user_role();
  v_sender_role text;
  v_id uuid;
  v_stage public.project_stage;
begin
  if p_body is null or length(btrim(p_body)) = 0 then
    raise exception 'a message cannot be empty';
  end if;
  if length(p_body) > 8000 then
    raise exception 'a message must be 8000 characters or fewer';
  end if;

  if v_role in ('admin', 'ops') then
    v_sender_role := 'staff';
  elsif v_role = 'customer' and app.is_project_customer(p_project_id) then
    v_sender_role := 'customer';
    -- Belt and braces: the check constraint says the same thing, but an
    -- explicit refusal here is the one a caller can read in the error.
    if coalesce(p_internal, false) then
      raise exception 'a customer cannot write an internal note' using errcode = '42501';
    end if;
  else
    -- Dealers, designers, finance and anyone else: not part of this conversation.
    raise exception 'you are not part of this conversation' using errcode = '42501';
  end if;

  if v_sender_role = 'staff' and not exists (select 1 from public.projects where id = p_project_id) then
    raise exception 'project not found';
  end if;

  if p_stage_ref is not null and btrim(p_stage_ref) <> '' then
    begin
      v_stage := btrim(p_stage_ref)::public.project_stage;
    exception when invalid_text_representation then
      -- An unrecognised stage reference is dropped rather than losing the
      -- message it was attached to.
      v_stage := null;
    end;
  end if;

  insert into public.project_messages
    (project_id, sender_user_id, sender_role, body, stage_ref, is_internal)
  values
    (p_project_id, auth.uid(), v_sender_role, btrim(p_body), v_stage,
     v_sender_role = 'staff' and coalesce(p_internal, false))
  returning id into v_id;

  -- A customer message re-opens the thread's attention; a staff reply clears it
  -- (§5: the flag "stays in the inbox's attention list until answered").
  if v_sender_role = 'customer' then
    insert into public.project_chat_flags (project_id, flagged_at, note)
    values (p_project_id, now(), 'Awaiting reply')
    on conflict (project_id) do update
      set flagged_at = now(),
          -- Keep a note a PM wrote themselves; only fill in the default.
          note = coalesce(project_chat_flags.note, 'Awaiting reply');
  elsif v_sender_role = 'staff' and not coalesce(p_internal, false) then
    delete from public.project_chat_flags where project_id = p_project_id;
  end if;

  perform app.write_audit(
    case when v_sender_role = 'customer' then 'chat.customer_message'
         when coalesce(p_internal, false) then 'chat.internal_note'
         else 'chat.staff_message' end,
    'project_messages', v_id::text, p_project_id, null, null,
    jsonb_build_object('internal', coalesce(p_internal, false),
                       'stage', v_stage,
                       'length', length(btrim(p_body))));

  return v_id;
end;
$$;

revoke execute on function public.post_project_message(uuid, text, boolean, text) from public, anon;
grant execute on function public.post_project_message(uuid, text, boolean, text) to authenticated;

-- System lines: stage advances, PM handovers, appointment confirmations (§3).
-- Neutral, never notified, never internal, no human sender. Staff-only to call
-- because the app raises them as a side effect of staff actions.
create or replace function public.post_system_message(
  p_project_id uuid,
  p_body       text,
  /** Skip if this exact line is already in the thread. */
  p_dedupe     boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff actions raise system messages' using errcode = '42501';
  end if;
  if p_body is null or length(btrim(p_body)) = 0 then
    return null;
  end if;

  -- Moving a project back and forth to correct a mistake must not litter the
  -- customer's thread with the same line twice.
  if coalesce(p_dedupe, true) and exists (
    select 1 from public.project_messages
    where project_id = p_project_id and sender_role = 'system' and body = btrim(p_body)
  ) then
    return null;
  end if;

  insert into public.project_messages (project_id, sender_role, body)
  values (p_project_id, 'system', btrim(p_body))
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.post_system_message(uuid, text, boolean) from public, anon;
grant execute on function public.post_system_message(uuid, text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Editing — five minutes, staff, own message, marked (§3)
-- -----------------------------------------------------------------------------

create or replace function public.edit_project_message(p_id uuid, p_body text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_msg public.project_messages%rowtype;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may edit a message' using errcode = '42501';
  end if;
  select * into v_msg from public.project_messages where id = p_id;
  if not found then return false; end if;
  if v_msg.sender_user_id is distinct from auth.uid() then
    raise exception 'you can only edit your own message' using errcode = '42501';
  end if;
  if v_msg.sender_role <> 'staff' then
    raise exception 'only a staff message can be edited' using errcode = '42501';
  end if;
  if v_msg.created_at < now() - interval '5 minutes' then
    raise exception 'a message can only be edited within five minutes of sending';
  end if;
  if p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 8000 then
    raise exception 'a message cannot be empty';
  end if;

  update public.project_messages
  set body = btrim(p_body), edited_at = now()
  where id = p_id;

  perform app.write_audit('chat.message_edited', 'project_messages', p_id::text,
    v_msg.project_id, null, null, jsonb_build_object('internal', v_msg.is_internal));
  return true;
end;
$$;

revoke execute on function public.edit_project_message(uuid, text) from public, anon;
grant execute on function public.edit_project_message(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Read receipts
-- -----------------------------------------------------------------------------
-- Each party marks the OTHER party's messages read. A customer opening their
-- thread stamps the staff messages; a PM opening the panel stamps the customer's.
-- Internal notes are never part of this — they have no second party.

create or replace function public.mark_thread_read(p_project_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := app.current_user_role();
  v_marked integer;
begin
  if v_role in ('admin', 'ops') then
    update public.project_messages
    set read_at = now()
    where project_id = p_project_id and sender_role = 'customer' and read_at is null;
  elsif v_role = 'customer' and app.is_project_customer(p_project_id) then
    update public.project_messages
    set read_at = now()
    where project_id = p_project_id and sender_role = 'staff'
      and not is_internal and read_at is null;
  else
    raise exception 'you are not part of this conversation' using errcode = '42501';
  end if;
  get diagnostics v_marked = row_count;
  return v_marked;
end;
$$;

revoke execute on function public.mark_thread_read(uuid) from public, anon;
grant execute on function public.mark_thread_read(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Attachments
-- -----------------------------------------------------------------------------
-- Stores the bytes, files the document against the project, and links it to the
-- message — in one transaction, so an attachment cannot exist without its
-- document row or vice versa.
--
-- The customer_visible flag follows the message: an attachment on an internal
-- note must not appear in the customer's documents list. That is the same
-- mistake §6 is about, one layer down, and it is easy to miss.

create or replace function public.record_chat_attachment(
  p_message_id uuid,
  p_filename   text,
  p_mime       text,
  p_data       bytea
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg public.project_messages%rowtype;
  v_role text := app.current_user_role();
  v_name text;
  v_path text;
  v_bucket text;
  v_object_id uuid;
  v_document_id uuid;
begin
  select * into v_msg from public.project_messages where id = p_message_id;
  if not found then
    raise exception 'message not found';
  end if;

  -- Only the sender may attach to their own message, and only immediately —
  -- this is the composer finishing its upload, not a way to alter history.
  if v_msg.sender_user_id is distinct from auth.uid() then
    raise exception 'you can only attach to your own message' using errcode = '42501';
  end if;
  if v_msg.created_at < now() - interval '15 minutes' then
    raise exception 'attachments must accompany the message';
  end if;
  if v_role not in ('admin', 'ops')
     and not (v_role = 'customer' and app.is_project_customer(v_msg.project_id)) then
    raise exception 'you are not part of this conversation' using errcode = '42501';
  end if;

  -- §3: images and PDFs, default cap 10 MB.
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
                    'application/pdf') then
    raise exception 'only photos and PDFs can be attached';
  end if;
  if p_data is null or octet_length(p_data) = 0 or octet_length(p_data) > 10485760 then
    raise exception 'attachments must be between 1 byte and 10 MB';
  end if;

  v_name := coalesce(nullif(regexp_replace(coalesce(p_filename, ''), '[^\w.\-]+', '_', 'g'), ''), 'file');
  v_name := right(v_name, 100);
  v_bucket := case when p_mime = 'application/pdf' then 'project-deliverables' else 'project-photos' end;
  v_path := v_msg.project_id || '/chat/' || p_message_id || '/'
            || floor(extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || v_name;

  insert into storage.objects (bucket_id, name, owner)
  values (v_bucket, v_path, auth.uid())
  returning id into v_object_id;

  insert into storage.object_data (object_id, data) values (v_object_id, p_data);

  insert into public.documents
    (project_id, bucket, object_path, kind, category, title, mime_type, size_bytes,
     customer_visible, uploaded_by)
  values
    (v_msg.project_id, v_bucket, v_path,
     (case when p_mime = 'application/pdf' then 'pdf' else 'photo' end)::public.document_kind,
     -- §3: "filed to the project's documents with the source marked as chat".
     'chat',
     p_filename, p_mime, octet_length(p_data),
     not v_msg.is_internal,
     auth.uid())
  returning id into v_document_id;

  insert into public.message_attachments (message_id, document_id)
  values (p_message_id, v_document_id);

  perform app.write_audit('chat.attachment_added', 'documents', v_document_id::text,
    v_msg.project_id, null, null,
    jsonb_build_object('internal', v_msg.is_internal, 'bytes', octet_length(p_data)));

  return v_document_id;
end;
$$;

revoke execute on function public.record_chat_attachment(uuid, text, text, bytea) from public, anon;
grant execute on function public.record_chat_attachment(uuid, text, text, bytea) to authenticated;

-- -----------------------------------------------------------------------------
-- 7. The unread badges and the global inbox
-- -----------------------------------------------------------------------------
-- §1: "A PM should never have to open a project to discover a customer wrote
-- three days ago." Both of these are aggregates over the thread, so they belong
-- in SQL rather than in a loop over projects in the application.

create or replace view public.project_chat_summary
with (security_invoker = true)
as
select
  p.id as project_id,
  count(m.id) filter (where m.sender_role = 'customer' and m.read_at is null) as unread,
  count(m.id) filter (where not m.is_internal) as messages,
  max(m.created_at) filter (where not m.is_internal) as last_message_at,
  max(m.created_at) filter (where m.sender_role = 'customer') as last_customer_at,
  max(m.created_at) filter (where m.sender_role = 'staff' and not m.is_internal) as last_staff_at,
  (f.project_id is not null) as flagged,
  f.note as flag_note
from public.projects p
left join public.project_messages m on m.project_id = p.id
left join public.project_chat_flags f on f.project_id = p.id
-- Staff only: 'unread' here means "unread by us", which is precisely the read
-- receipt §3 says the customer must not be shown.
where (select app.current_user_role()) in ('admin', 'ops')
group by p.id, f.project_id, f.note;

grant select on public.project_chat_summary to authenticated;

-- -----------------------------------------------------------------------------
-- 7b. Who is talking — resolved for the customer too
-- -----------------------------------------------------------------------------
-- public.profiles is self-or-staff by policy, so a homeowner joining it gets
-- nothing: their thread would show every reply as coming from nobody. §2 is
-- explicit that this is not acceptable — the PM is "named and pictured at the
-- top of the thread so the customer knows who they are talking to", and any
-- staff member who posts appears "with their own name … the customer should
-- always know who actually wrote".
--
-- So the names come through a definer function, narrowly: only the display names
-- of staff who have actually posted a customer-visible message on this one
-- project, and only to that project's customer or to staff. No email, no phone,
-- no other project's people.
--
-- (This is the same trap that made 'call my project manager' return nothing in
-- the mobile module until public.project_contact() was added. Worth naming twice.)

create or replace function public.chat_participants(p_project_id uuid)
returns table (user_id uuid, display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops')
     and not app.is_project_customer(p_project_id) then
    raise exception 'not your conversation' using errcode = '42501';
  end if;

  return query
    select distinct pr.id, coalesce(pr.full_name, pr.email)
    from public.project_messages m
    join public.profiles pr on pr.id = m.sender_user_id
    where m.project_id = p_project_id
      and m.sender_role = 'staff'
      and not m.is_internal;
end;
$$;

revoke execute on function public.chat_participants(uuid) from public, anon;
grant execute on function public.chat_participants(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Canned replies (§5) — "what makes chat survivable at forty projects"
-- -----------------------------------------------------------------------------

create table if not exists public.canned_replies (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.canned_replies enable row level security;
grant select, insert, update, delete on public.canned_replies to authenticated;

drop policy if exists canned_replies_select on public.canned_replies;
create policy canned_replies_select on public.canned_replies
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'));

drop policy if exists canned_replies_write on public.canned_replies;
create policy canned_replies_write on public.canned_replies
  for all to authenticated
  using ((select app.is_admin())) with check ((select app.is_admin()));

drop trigger if exists set_updated_at on public.canned_replies;
create trigger set_updated_at before update on public.canned_replies
  for each row execute function app.tg_set_updated_at();

-- The three the spec names, so the library is useful on day one rather than
-- being an empty admin screen nobody fills in.
insert into public.canned_replies (title, body, sort_order)
select * from (values
  ('Permit timelines',
   E'Your permit application is with the city now. Most permits in your area come back within two to four weeks, and there is unfortunately no way to speed that up from our side.\n\nAs soon as it is approved I will let you know here, and we will book your installation date straight away.',
   10),
  ('What happens on install day',
   E'Here is what to expect on installation day:\n\n• Our crew arrives in the morning and will be with you most of the day.\n• We need clear access to your roof and to your electrical panel, so please move any vehicles off the driveway.\n• Your power will be off for a short period while we connect the system.\n• You do not need to be home the whole time, but someone should be there at the start and the end.\n\nAnything you are unsure about, just ask here.',
   20),
  ('How to read your monitoring app',
   E'Now that your system is on, you can see what it is producing:\n\n• Download the monitoring app for your inverter and sign in with the details we sent you.\n• The main figure is today''s production in kWh.\n• Production drops on cloudy days and in winter — that is normal, not a fault.\n\nIf a panel or the whole system shows nothing for a full sunny day, tell us here and we will look into it.',
   30)
) as seed(title, body, sort_order)
where not exists (select 1 from public.canned_replies);

-- -----------------------------------------------------------------------------
-- 9. Settings
-- -----------------------------------------------------------------------------

alter table public.app_settings
  /**
   * §4's aside: the biggest risk with in-product chat is that it feels like
   * instant messaging while the PM treats it like email. This line sits at the
   * top of the customer's thread, and it is a setting because it is a promise
   * the business makes and will want to change.
   */
  add column if not exists chat_reply_promise text
    default 'We usually reply within one business day.',
  /** Quiet hours are local to the company; the customer's own zone is unknown. */
  add column if not exists company_timezone text default 'America/Chicago',
  /** §4: unanswered customer messages summarised twice a day by default. */
  add column if not exists chat_digest_hours text default '9,15';

-- §4: "An immediate email per message is optional per PM — some want it, most
-- want the digest."
alter table public.profiles
  add column if not exists chat_email_each_message boolean not null default false;

-- A sixth notification category, so a customer can turn chat pushes off in the
-- app's notification settings like any other kind. The check constraint is
-- rebuilt rather than added to, because a constraint cannot be extended in place.
alter table public.notification_preferences
  drop constraint if exists notification_preferences_category_check;
alter table public.notification_preferences
  add constraint notification_preferences_category_check
  check (category in ('stage_advanced', 'appointment', 'action_needed', 'on_hold',
                      'power_on', 'chat_message'));

-- Customers may silence chat email without losing the thread (the existing
-- email_opt_out already covers all portal email, so nothing new is needed here
-- — noted so the next reader does not add a second, conflicting flag).

-- -----------------------------------------------------------------------------
-- 10. Notifications that must wait for the morning (§4 quiet hours)
-- -----------------------------------------------------------------------------
-- No customer push between 9pm and 8am local; queued to the morning. Queued
-- rather than dropped, because a message sent at 10pm is exactly the one a
-- customer wants to see at 8am — and dropped notifications are how people learn
-- not to trust the app.
--
-- Flushed by the same authenticated cron endpoint that sends appointment
-- reminders, so this needs no new scheduler.

create table if not exists public.chat_notification_queue (
  id         bigint generated always as identity primary key,
  message_id uuid not null references public.project_messages (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  send_after timestamptz not null,
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists chat_notification_queue_due_idx
  on public.chat_notification_queue (send_after)
  where sent_at is null;

alter table public.chat_notification_queue enable row level security;
grant select on public.chat_notification_queue to authenticated;

-- Staff-visible only, and written exclusively by the definer functions below:
-- a customer must not be able to read or forge their own notification schedule.
drop policy if exists chat_notification_queue_select on public.chat_notification_queue;
create policy chat_notification_queue_select on public.chat_notification_queue
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'));

/**
 * Is it currently quiet hours at the company's local time? 21:00–07:59.
 * Returns the moment a notification may be sent, or null for "send now".
 */
create or replace function public.chat_quiet_until()
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_local timestamp;
  v_hour integer;
begin
  select coalesce(nullif(btrim(company_timezone), ''), 'America/Chicago')
    into v_tz from public.app_settings where id;
  v_tz := coalesce(v_tz, 'America/Chicago');

  begin
    v_local := now() at time zone v_tz;
  exception when others then
    -- An invalid timezone name must not stop a notification going out.
    return null;
  end;

  v_hour := extract(hour from v_local);
  if v_hour >= 21 then
    -- Tonight: hold until 8am tomorrow, local.
    return ((date_trunc('day', v_local) + interval '1 day' + interval '8 hours')
            at time zone v_tz);
  elsif v_hour < 8 then
    return ((date_trunc('day', v_local) + interval '8 hours') at time zone v_tz);
  end if;
  return null;
end;
$$;

grant execute on function public.chat_quiet_until() to authenticated;

/** Queue a customer notification for after quiet hours. Staff-only. */
create or replace function public.queue_chat_notification(
  p_message_id uuid,
  p_send_after timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_id bigint;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff queue notifications' using errcode = '42501';
  end if;
  select project_id into v_project from public.project_messages where id = p_message_id;
  if v_project is null then return null; end if;
  insert into public.chat_notification_queue (message_id, project_id, send_after)
  values (p_message_id, v_project, p_send_after)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.queue_chat_notification(uuid, timestamptz) from public, anon;
grant execute on function public.queue_chat_notification(uuid, timestamptz) to authenticated;

/** Claim the due queue entries, so two overlapping cron runs cannot double-send. */
create or replace function public.claim_due_chat_notifications(p_limit integer default 100)
returns table (q_id bigint, q_message uuid, q_project uuid, q_body text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff flush the queue' using errcode = '42501';
  end if;

  return query
    with due as (
      select q.id
      from public.chat_notification_queue q
      where q.sent_at is null and q.send_after <= now()
      order by q.send_after
      limit greatest(1, least(coalesce(p_limit, 100), 500))
      for update skip locked
    )
    update public.chat_notification_queue q
    set sent_at = now()
    from due, public.project_messages m
    where q.id = due.id and m.id = q.message_id
    returning q.id, q.message_id, q.project_id, m.body;
end;
$$;

revoke execute on function public.claim_due_chat_notifications(integer) from public, anon;
grant execute on function public.claim_due_chat_notifications(integer) to authenticated;

-- -----------------------------------------------------------------------------
-- 11. Response time (§5) — informs staffing, does not rank people
-- -----------------------------------------------------------------------------
-- First response to each customer message that had one: the gap between the
-- customer's message and the next staff reply on that project. Exposed as a
-- view so the dashboard can average it per PM without the application walking
-- the thread.

create or replace view public.chat_response_times
with (security_invoker = true)
as
select
  m.project_id,
  p.assigned_pm,
  m.id as message_id,
  m.created_at as asked_at,
  reply.created_at as replied_at,
  extract(epoch from (reply.created_at - m.created_at)) / 3600.0 as hours_to_reply
from public.project_messages m
join public.projects p on p.id = m.project_id
left join lateral (
  select r.created_at
  from public.project_messages r
  where r.project_id = m.project_id
    and r.sender_role = 'staff'
    and not r.is_internal
    and r.created_at > m.created_at
  order by r.created_at
  limit 1
) reply on true
where m.sender_role = 'customer'
  and (select app.current_user_role()) in ('admin', 'ops');

grant select on public.chat_response_times to authenticated;

-- -----------------------------------------------------------------------------
-- 12. Audit
-- -----------------------------------------------------------------------------
-- Sends, edits and attachment uploads are audited inside the functions above
-- (write_audit carries the actor from the JWT, so it cannot be spoofed). The
-- flag table gets the generic row auditor; the message table deliberately does
-- not, because every write already logs a purposeful action and a second row
-- per message would double the audit volume for no new information.

drop trigger if exists audit_row on public.project_chat_flags;
create trigger audit_row after insert or update or delete on public.project_chat_flags
  for each row execute function app.tg_audit_row();
