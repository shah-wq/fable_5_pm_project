#!/usr/bin/env bash
# The CRM foundation, checked as the database sees it.
#
# Part 10 makes each migration step independently verifiable and then says which
# verification: "Verify every client with an email has exactly one primary email
# channel", "Verify the count of customers equals the count of clients with at
# least one project", "Verify counts match exactly and no lead lost its dealer
# attribution". Those are the checks below, plus the ones that keep the rest of
# the system alive: idempotency, the leads view, and RLS as each role.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-crm
PGPORT=54392
DB=crm_sql

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

rm -rf "$W"; mkdir -p "$W"; chmod 777 "$W"
fuser -k $PGPORT/tcp 2>/dev/null || true
sleep 1
runuser -u postgres -- bash -c "
  set -e
  /usr/lib/postgresql/16/bin/initdb -U postgres --no-instructions -E UTF8 '$W/data' >/dev/null 2>&1
  /usr/lib/postgresql/16/bin/pg_ctl -D '$W/data' -o '-p $PGPORT -k $W -c listen_addresses=127.0.0.1' -w start >/dev/null
  createdb -h 127.0.0.1 -p $PGPORT -U postgres $DB
"
trap 'runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$W/data" stop -m immediate >/dev/null 2>&1 || true' EXIT
PSQL=(psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qtA)
q() { "${PSQL[@]}" -c "$1"; }
run() { "${PSQL[@]}" --single-transaction -f "$1" >/dev/null; }

# --- 1. everything before the CRM, then data that predates it ----------
for f in "$ROOT"/db/migrations/*.sql; do
  case "$(basename "$f")" in 20260803003[3-9]00_*|2026080300[4-9]*) continue ;; esac
  run "$f"
done
D=$(q "insert into public.dealers (name) values ('Helios') returning id")
C1=$(q "insert into public.clients (dealer_id, first_name, last_name, email, phone)
  values ('$D','Maria','Martinez','Maria@Example.COM ','(512) 555-0100') returning id")
C2=$(q "insert into public.clients (dealer_id, first_name, last_name, email)
  values ('$D','Ben','Baker','ben@example.com') returning id")
C3=$(q "insert into public.clients (dealer_id, first_name, last_name)
  values ('$D','Nora','Noproject') returning id")
P1=$(q "insert into public.projects (name, address, dealer_id, client_id, stage, status)
  values ('Maria Martinez','12 Sunbeam Road, Austin, TX','$D','$C1','survey','active') returning id")
P2=$(q "insert into public.projects (name, address, dealer_id, client_id, stage, status)
  values ('Ben Baker','9 Solar Way, Round Rock, TX','$D','$C2','complete','complete') returning id")
L1=$(q "insert into public.leads (dealer_id, customer_first, customer_last, customer_email, address, status)
  values ('$D','Lee','Lead','lee@example.com','3 Ray Street','submitted') returning id")
L2=$(q "insert into public.leads (dealer_id, customer_first, customer_last, customer_phone, address, status)
  values ('$D','Ola','Older','512-555-0199','5 Ray Street','under_review') returning id")
LEADS_BEFORE=$(q "select count(*) from public.leads")
AUDIT_BEFORE=$(q "select count(*) from public.audit_log")
echo "==> before: $LEADS_BEFORE leads, 3 clients, 2 projects, $AUDIT_BEFORE audit rows"

# --- 2. the migration, as a pasted script ------------------------------
run "$ROOT/db/migrations/20260803003300_add_sales_role.sql"
run "$ROOT/db/migrations/20260803003400_crm_foundation.sql"
run "$ROOT/db/migrations/20260803003500_deals.sql"
run "$ROOT/db/migrations/20260803003600_contact_intake.sql"
run "$ROOT/db/migrations/20260803003700_contact_create.sql"
run "$ROOT/db/migrations/20260803003800_contact_stages.sql"
run "$ROOT/db/migrations/20260803003900_contract_signed_system.sql"
run "$ROOT/db/migrations/20260803004000_project_holds_contact.sql"
run "$ROOT/db/migrations/20260803004100_signing_creates_project.sql"
run "$ROOT/db/migrations/20260803004200_sales_see_deal_projects.sql"
run "$ROOT/db/migrations/20260803004300_stage_upload_fix.sql"
run "$ROOT/db/migrations/20260803004400_esignature.sql"
run "$ROOT/db/migrations/20260803004500_sales_see_dealer_names.sql"
run "$ROOT/db/migrations/20260803004600_stage_fields_solar.sql"
run "$ROOT/db/migrations/20260803004700_notifications.sql"
pass "the CRM scripts apply to a database that already has live data"

# --- 3. step 2: backfill channels — copy, do not move ------------------
N=$(q "select count(*) from public.clients c
       where c.email is not null and not exists (
         select 1 from public.client_channels ch
          where ch.client_id = c.id and ch.kind = 'email' and ch.is_primary)")
[ "$N" = 0 ] || fail "$N client(s) with an email have no primary email channel"
N=$(q "select count(*) from (select client_id from public.client_channels
       where kind = 'email' and is_primary group by client_id having count(*) > 1) x")
[ "$N" = 0 ] || fail "a client has more than one primary email"
# The original columns stay populated and authoritative.
E=$(q "select email from public.clients where id = '$C1'")
[ -n "$E" ] || fail "the backfill emptied clients.email"
# And normalisation is what duplicate detection will compare on.
NORM=$(q "select value_normalised from public.client_channels
          where client_id = '$C1' and kind = 'email'")
[ "$NORM" = "maria@example.com" ] || fail "the email was not normalised ('$NORM')"
NORM=$(q "select value_normalised from public.client_channels
          where client_id = '$C1' and kind = 'phone'")
[ "$NORM" = "5125550100" ] || fail "the phone was not normalised ('$NORM')"
pass "every client with an email has exactly one primary channel, normalised, and the old columns still hold it"

# --- 4. step 3: lifecycle and addresses --------------------------------
CUSTOMERS=$(q "select count(*) from public.people_overview where lifecycle = 'customer'")
WITH_LIVE=$(q "select count(distinct client_id) from public.projects
               where status not in ('complete','cancelled')")
[ "$CUSTOMERS" = "$WITH_LIVE" ] || fail "customers ($CUSTOMERS) != clients with a live project ($WITH_LIVE)"
[ "$(q "select lifecycle from public.people_overview where id = '$C1'")" = customer ] \
  || fail "a client with a live project is not a customer"
[ "$(q "select lifecycle from public.people_overview where id = '$C2'")" = past_customer ] \
  || fail "a client whose only project is complete is not a past customer"
[ "$(q "select lifecycle from public.people_overview where id = '$C3'")" = prospect ] \
  || fail "a client with no project is not a prospect"
N=$(q "select count(*) from public.client_addresses where client_id = '$C1' and kind = 'property'")
[ "$N" = 1 ] || fail "the project's site address did not become a property address ($N)"
pass "lifecycle is derived from the projects that exist, and site addresses became property addresses"

# --- 5. step 4: leads to deals -----------------------------------------
DEALS=$(q "select count(*) from public.deals")
[ "$DEALS" = "$LEADS_BEFORE" ] || fail "deal count ($DEALS) does not match the leads before ($LEADS_BEFORE)"
N=$(q "select count(*) from public.deals where dealer_id is null")
[ "$N" = 0 ] || fail "$N migrated deal(s) lost their dealer attribution"
[ "$(q "select stage from public.deals where id = '$L1'")" = new ] \
  || fail "a submitted lead did not become stage New"
[ "$(q "select stage from public.deals where id = '$L2'")" = qualified ] \
  || fail "a lead under review did not become stage Qualified"
# The compatibility view: anything still saying 'leads' keeps working.
VIEW=$(q "select count(*) from public.leads")
[ "$VIEW" = "$LEADS_BEFORE" ] || fail "the leads view does not show every deal"
KIND=$(q "select relkind from pg_class where relname = 'leads'")
[ "$KIND" = v ] || fail "leads should now be a view, not a $KIND"
[ -n "$(q "select code from public.deals where id = '$L1'")" ] || fail "a deal has no code"
pass "every lead became a deal with its attribution and a stage, and the leads view still answers"

# --- 6. step 5: the activity log ---------------------------------------
N=$(q "select count(*) from public.audit_log where kind <> 'field_change'")
[ "$N" = 0 ] || fail "existing audit rows did not default to field_change"
AFTER=$(q "select count(*) from public.audit_log")
[ "$AFTER" -ge "$AUDIT_BEFORE" ] || fail "the migration lost audit rows"
q "insert into public.audit_log (action, entity_type, kind, client_id)
   values ('call.logged','clients','call','$C1')" >/dev/null
TOUCHED=$(q "select (last_contacted_at is not null)::text from public.clients where id = '$C1'")
[ "$TOUCHED" = true ] || fail "logging a call did not update last_contacted_at"
pass "the audit log carries a kind, a deal and a client, and a logged call touches the person"

# --- 7. idempotency: the same script twice -----------------------------
run "$ROOT/db/migrations/20260803003300_add_sales_role.sql"
run "$ROOT/db/migrations/20260803003400_crm_foundation.sql"
run "$ROOT/db/migrations/20260803003500_deals.sql"
run "$ROOT/db/migrations/20260803003600_contact_intake.sql"
run "$ROOT/db/migrations/20260803003700_contact_create.sql"
run "$ROOT/db/migrations/20260803003800_contact_stages.sql"
run "$ROOT/db/migrations/20260803003900_contract_signed_system.sql"
run "$ROOT/db/migrations/20260803004000_project_holds_contact.sql"
run "$ROOT/db/migrations/20260803004100_signing_creates_project.sql"
run "$ROOT/db/migrations/20260803004200_sales_see_deal_projects.sql"
run "$ROOT/db/migrations/20260803004300_stage_upload_fix.sql"
run "$ROOT/db/migrations/20260803004400_esignature.sql"
run "$ROOT/db/migrations/20260803004500_sales_see_dealer_names.sql"
run "$ROOT/db/migrations/20260803004600_stage_fields_solar.sql"
run "$ROOT/db/migrations/20260803004700_notifications.sql"
N=$(q "select count(*) from public.client_channels where client_id = '$C1' and kind = 'email'")
[ "$N" = 1 ] || fail "re-running the migration duplicated a channel ($N)"
N=$(q "select count(*) from public.client_addresses where client_id = '$C1'")
[ "$N" = 1 ] || fail "re-running the migration duplicated an address ($N)"
[ "$(q "select count(*) from public.deals")" = "$LEADS_BEFORE" ] || fail "re-running changed the deal count"
[ "$(q "select count(*) from public.client_sources")" = 8 ] || fail "re-running re-seeded the sources"
pass "running both scripts a second time changes nothing"

# --- 8. the primary-channel trigger keeps the legacy columns true ------
q "update public.client_channels set is_primary = false where client_id = '$C2' and kind = 'email'" >/dev/null
q "insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
   values ('$C2','email','ben.baker@work.example','',true)" >/dev/null
E=$(q "select email from public.clients where id = '$C2'")
[ "$E" = "ben.baker@work.example" ] || fail "clients.email did not follow the new primary ('$E')"
pass "the legacy email column follows the primary channel, so old queries stay right"

# --- 9. RLS, as each role rather than as the owner ----------------------
# The table owner bypasses RLS, so every one of these runs as authenticated.
ADMIN=$(q "insert into auth.users (email, raw_app_meta_data)
  values ('admin@crm.test','{\"user_role\":\"admin\"}'::jsonb) returning id")
q "update public.profiles set role='admin', is_active=true where id='$ADMIN'" >/dev/null
SALES=$(q "insert into auth.users (email, raw_app_meta_data)
  values ('sales@crm.test','{\"user_role\":\"sales\"}'::jsonb) returning id")
q "update public.profiles set role='sales', is_active=true where id='$SALES'" >/dev/null
SALES2=$(q "insert into auth.users (email, raw_app_meta_data)
  values ('sales2@crm.test','{\"user_role\":\"sales\"}'::jsonb) returning id")
q "update public.profiles set role='sales', is_active=true where id='$SALES2'" >/dev/null
DEALERU=$(q "insert into auth.users (email, raw_app_meta_data)
  values ('dealer@crm.test','{\"user_role\":\"dealer\"}'::jsonb) returning id")
q "update public.profiles set role='dealer', is_active=true where id='$DEALERU'" >/dev/null
q "insert into public.dealer_users (dealer_id, user_id) values ('$D','$DEALERU')" >/dev/null
D2=$(q "insert into public.dealers (name) values ('Rival') returning id")
OTHERDEAL=$(q "insert into public.deals (dealer_id, customer_first, customer_last, customer_email, address, stage)
  values ('$D2','Rival','Prospect','rival@example.com','1 Other Street','new') returning id")
# A deal whose person carries the channel needs none of its own.
PERSONDEAL=$(q "insert into public.deals (client_id, stage) values ('$C3','new') returning id")
[ -n "$PERSONDEAL" ] || fail "a deal against a person record was refused"
UNREACHABLE=$(q "insert into public.deals (stage) values ('new') returning id" 2>&1 || true)
grep -q deals_reachable <<<"$UNREACHABLE" || fail "a deal with no person and no channel was accepted"
LEADS_BEFORE=$((LEADS_BEFORE + 2))
q "update public.deals set owner_id = '$SALES' where id = '$L1'" >/dev/null

as() {  # as <user-id> <sql>
  "${PSQL[@]}" -c "set local role authenticated;
    select set_config('request.jwt.claims', json_build_object('sub','$1','user_role',
      (select role from public.profiles where id = '$1'))::text, true);
    $2" | tail -1
}
[ "$(as "$SALES" "select count(*) from public.deals where id = '$L1'")" = 1 ] \
  || fail "a sales user cannot see their own deal"
[ "$(as "$SALES2" "select count(*) from public.deals where id = '$L1'")" = 0 ] \
  || fail "a second sales rep sees another rep's deal with visibility 'own'"
# The unassigned pool is visible to every rep (Part 8).
[ "$(as "$SALES2" "select count(*) from public.deals where owner_id is null")" -ge 1 ] \
  || fail "a sales rep cannot see the unassigned pool"
q "update public.profiles set manage_all_deals = true where id = '$SALES2'" >/dev/null
[ "$(as "$SALES2" "select count(*) from public.deals where id = '$L1'")" = 1 ] \
  || fail "manage_all_deals did not open the other rep's deal"
[ "$(as "$DEALERU" "select count(*) from public.deals where id = '$OTHERDEAL'")" = 0 ] \
  || fail "a dealer sees another dealer's deal"
[ "$(as "$DEALERU" "select count(*) from public.deals where dealer_id = '$D'")" -ge 2 ] \
  || fail "a dealer cannot see their own submissions"
[ "$(as "$SALES" "select count(*) from public.subscriptions")" = 0 ] \
  || fail "a sales user without manage_marketing read subscriptions"
[ "$(as "$ADMIN" "select count(*) from public.client_sources")" = 8 ] \
  || fail "an admin cannot read the reference lists"
pass "deal visibility, the unassigned pool, the manager flag and dealer scoping all hold under RLS"

# --- 10. a prospect is a person with no project ------------------------
PROSPECT=$(as "$SALES" "insert into public.clients (first_name, last_name)
  values ('Pat','Prospect') returning id")
[ -n "$PROSPECT" ] || fail "a sales user cannot create a person with no dealer and no project"
pass "a client can exist with zero projects and no dealer — the one real change the extension needs"

echo "CRM FOUNDATION SQL CHECKS PASSED"
