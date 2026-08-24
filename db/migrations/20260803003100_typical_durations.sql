-- =============================================================================
-- 003100 — Typical stage durations (customer portal redesign §5, §7)
-- =============================================================================
-- The redesigned home screen tells a homeowner how long the stage they are in
-- usually takes: 'Typical 15–30 days' on the permit card, 'Up next: Design ·
-- 7–10 days' on the row below it. That single sentence answers the question
-- behind most status phone calls — "is this taking too long?" — before anybody
-- picks up a phone.
--
-- It has to be configuration, not a constant in the code. Permit times are a
-- fact about a jurisdiction, not about this product: a company working in one
-- county wants numbers that match that county, and §7 asks for these to be
-- seeded from the business's own historical averages once the dashboard has
-- enough completed projects to compute them.
--
-- They live on stage_thresholds, next to the attention threshold that the
-- dashboard already uses, because both answer the same question at different
-- volumes: what is normal for this stage, and when has this project stopped
-- being normal. One table, one admin panel, one number to keep in step.
--
-- The range is deliberately a range. A single '10 days' would be read as a
-- promise, and a permit office that takes three weeks would make the product a
-- liar. §7: "Label them as typical, never as a promise."

-- Everything below is wrapped in one guard, because a plain `alter table` on a
-- table that is not there yet is a hard error rather than a skip. That case is
-- real: the deployment applies these files in name order, and an operator who
-- ran the dashboard module's SQL late — or skipped it — would otherwise hit an
-- error on this file and reasonably conclude the whole catch-up had failed. It
-- says what to run instead and changes nothing.
do $$
begin
  if to_regclass('public.stage_thresholds') is null then
    raise notice '003100 skipped: public.stage_thresholds does not exist yet. Run the dashboard migration (002800) first — or db/dist/catch-up-1.sql then catch-up-2.sql, which include both.';
    return;
  end if;

  execute 'alter table public.stage_thresholds
             add column if not exists typical_min_days integer,
             add column if not exists typical_max_days integer';

  -- Added separately from the columns so a re-run over a table that already has
  -- the constraint does not fail: there is no `add constraint if not exists`.
  if not exists (
    select 1 from pg_constraint where conname = 'stage_thresholds_typical_range'
  ) then
    execute $c$
      alter table public.stage_thresholds
        add constraint stage_thresholds_typical_range
        check (
          (typical_min_days is null and typical_max_days is null)
          or (typical_min_days between 1 and 3650
              and typical_max_days between 1 and 3650
              and typical_min_days <= typical_max_days)
        )
    $c$;
  end if;

  -- Seeded from the specification's own figures (§5), which are ordinary
  -- residential-solar durations. An update rather than an insert: the rows
  -- already exist from 002800, and their attention thresholds must not be
  -- touched. Only rows nobody has set a range on are filled, so a company that
  -- has tuned these keeps its own numbers when this file is run again.
  execute $u$
    update public.stage_thresholds set typical_min_days = v.min_days,
                                       typical_max_days = v.max_days
    from (values
      ('survey',          7, 14),
      ('design',          7, 10),
      ('permits',        15, 30),
      ('procurement',     7, 14),
      ('install',         1,  3),
      ('inspection_pto', 10, 21)
    ) as v (stage, min_days, max_days)
    where stage_thresholds.stage = v.stage::public.project_stage
      and stage_thresholds.typical_min_days is null
  $u$;
end
$$;

-- Complete is deliberately left null. There is no 'typical' length for being
-- finished, and a range on that card would be nonsense — the card is replaced by
-- a completion state at that point anyway.

-- Grants are inherited from 002800: every signed-in role may read this table,
-- which now includes the customer reading their own stage's typical range. The
-- numbers reveal nothing about anybody's project.
