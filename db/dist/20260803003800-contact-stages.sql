-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 6 of 13 · 20260803003800_contact_stages.sql
--
-- For a database that is already up to date apart from this module. Paste the
-- whole file into a SQL console (e.g. the Neon SQL Editor) and run it once.
-- Safe to run again: every statement skips work already done, so 'already
-- exists' errors cannot happen. NOTICE lines saying 'does not exist, skipping'
-- are normal.
--
-- Run these in order, each as its own execution:
--   1. 20260803003300-add-sales-role.sql
--   2. 20260803003400-crm-foundation.sql
--   3. 20260803003500-deals.sql
--   4. 20260803003600-contact-intake.sql
--   5. 20260803003700-contact-create.sql
--   6. 20260803003800-contact-stages.sql
--   7. 20260803003900-contract-signed-system.sql
--   8. 20260803004000-project-holds-contact.sql
--   9. 20260803004100-signing-creates-project.sql
--   10. 20260803004200-sales-see-deal-projects.sql
--   11. 20260803004300-stage-upload-fix.sql
--   12. 20260803004400-esignature.sql
--   13. 20260803004500-sales-see-dealer-names.sql
-- Each break is where one script adds something the next one uses, which
-- PostgreSQL will not allow inside a single pasted transaction.
--
-- Behind by more than this module? Run every db/dist/catch-up-*.sql in order
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803003800_contact_stages.sql
-- =============================================================================
-- Contact stages — the contact's own pipeline
-- =============================================================================
-- The board had been reading the deal's stage, which was the right answer while
-- the two vocabularies matched. They do not. The stages the business actually
-- works are about reaching a person and getting in front of them:
--
--   Contact created · Appointment scheduled · Appointment rescheduled ·
--   No-show · Quoted · Financing approved · Contract signed · Lost
--
-- Three of those — rescheduled, no-show, and the return from either — are not
-- forward steps. A contact who does not answer the door goes back to being
-- rescheduled, and a deal pipeline that only moves forward cannot say so. And a
-- contact with no deal at all still has a stage: they were created, and nobody
-- has booked them in yet.
--
-- So the stage belongs to the person. The deal keeps its own (new → contacted →
-- qualified → proposal → negotiation → contract out, won, lost), which is about
-- the money rather than the diary, and the two no longer have to be the same
-- word in two places.
-- =============================================================================

alter table public.clients
  add column if not exists contact_stage text not null default 'created'
    check (contact_stage in ('created', 'appointment_scheduled', 'appointment_rescheduled',
                             'no_show', 'quoted', 'financing_approved', 'contract_signed',
                             'lost')),
  /** When they entered it — the board shows the days, because a contact sitting
      in Appointment scheduled for three weeks is the whole point of a board. */
  add column if not exists contact_stage_at timestamptz not null default now();

create index if not exists clients_contact_stage_idx
  on public.clients (contact_stage, contact_stage_at desc);

/**
 * The clock restarts when the stage changes, and only then. Editing somebody's
 * phone number does not make them newly scheduled.
 */
create or replace function app.tg_client_stage_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.contact_stage is distinct from old.contact_stage then
    new.contact_stage_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists client_stage_stamp on public.clients;
create trigger client_stage_stamp before update on public.clients
  for each row execute function app.tg_client_stage_stamp();

-- -----------------------------------------------------------------------------
-- What the contacts already on file were doing
-- -----------------------------------------------------------------------------
-- Everyone starts at Contact created, which is true of everyone. Where a deal
-- says more than that, it is used — a signed contract and a lost deal are the
-- same fact in both vocabularies, and a proposal out is a quote given. Nothing
-- is invented for the middle: no appointment was ever recorded, so claiming one
-- was scheduled would be a guess written into the database.
do $$
begin
  if to_regclass('public.deals') is null then
    return;
  end if;

  update public.clients c
     set contact_stage = v.stage,
         contact_stage_at = coalesce(v.moved_at, c.created_at, now())
    from (
      select distinct on (d.client_id)
             d.client_id,
             case d.stage
               when 'won'  then 'contract_signed'
               when 'lost' then 'lost'
               when 'proposal' then 'quoted'
               when 'negotiation' then 'quoted'
               when 'contract_out' then 'quoted'
               else 'created'
             end as stage,
             d.stage_entered_at as moved_at
        from public.deals d
       where d.client_id is not null
       order by d.client_id, (d.stage not in ('won', 'lost')) desc, d.updated_at desc
    ) v
   where v.client_id = c.id
     and c.contact_stage = 'created'
     and v.stage <> 'created';
end
$$;

-- -----------------------------------------------------------------------------
-- Moving one
-- -----------------------------------------------------------------------------
/**
 * Any stage to any stage, which is the honest rule here: a no-show goes back to
 * rescheduled, a lost contact comes back to life, and there is no ordering
 * between them worth enforcing in a database. What it does insist on is that
 * the stage is a real one and that the move is written to the activity log,
 * because "who moved this and when" is the question a board always raises.
 */
create or replace function public.set_contact_stage(
  p_client uuid,
  p_stage  text,
  p_note   text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before text;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may move a contact' using errcode = '42501';
  end if;
  if p_stage not in ('created', 'appointment_scheduled', 'appointment_rescheduled',
                     'no_show', 'quoted', 'financing_approved', 'contract_signed', 'lost') then
    raise exception 'that is not a contact stage' using errcode = '22023';
  end if;

  select contact_stage into v_before from public.clients where id = p_client;
  if v_before is null then
    raise exception 'that contact no longer exists' using errcode = 'P0002';
  end if;
  if v_before = p_stage then
    return v_before;
  end if;

  update public.clients set contact_stage = p_stage where id = p_client;

  perform public.log_audit_event(
    'contact.stage_moved', 'clients', p_client::text, null,
    jsonb_build_object('from', v_before, 'to', p_stage, 'note', p_note),
    'stage_move', null, p_client);

  return v_before;
end;
$$;

revoke execute on function public.set_contact_stage(uuid, text, text) from public, anon;
grant execute on function public.set_contact_stage(uuid, text, text) to authenticated;

