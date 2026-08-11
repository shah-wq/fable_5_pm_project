-- Development seed data (reference tables only — no users/projects).
-- Applied automatically by `supabase db reset` on local stacks.

insert into public.jurisdictions (name, state, county, typical_turnaround_days, requirements) values
  ('City of Phoenix',       'AZ', 'Maricopa',    12, '{"plan_sets": 2, "wet_stamp": false, "online_portal": true}'),
  ('Maricopa County',       'AZ', 'Maricopa',    15, '{"plan_sets": 3, "wet_stamp": true,  "online_portal": false}'),
  ('City of San Diego',     'CA', 'San Diego',   20, '{"plan_sets": 2, "wet_stamp": false, "online_portal": true}'),
  ('City of Austin',        'TX', 'Travis',      10, '{"plan_sets": 2, "wet_stamp": false, "online_portal": true}')
on conflict do nothing;

insert into public.utilities (name, state, interconnection_requirements) values
  ('Arizona Public Service', 'AZ', '{"max_system_kw": 15, "meter_spot_required": true}'),
  ('Austin Energy',          'TX', '{"max_system_kw": 20, "meter_spot_required": false}')
on conflict do nothing;

insert into public.price_book (sku, name, category, manufacturer, unit, unit_cost, unit_price) values
  ('PNL-Q400',   'Q.PEAK DUO 400W Panel',      'module',    'Qcells',    'each',   165.00, 245.00),
  ('INV-IQ8P',   'IQ8+ Microinverter',         'inverter',  'Enphase',   'each',   142.00, 210.00),
  ('RK-XR100',   'XR-100 Rail 168in',          'racking',   'IronRidge', 'each',    38.00,  62.00),
  ('BAT-5P',     '5P Battery 5kWh',            'storage',   'Tesla',     'each',  3900.00, 5400.00),
  ('SVC-MPU200', 'Main Panel Upgrade 200A',    'electrical','—',         'each',  1450.00, 2600.00),
  ('SVC-TRENCH', 'Trenching per foot',         'civil',     '—',         'foot',      9.00,   18.00)
on conflict (sku) do nothing;

insert into public.adder_rules (name, description, condition, amount, amount_type, priority) values
  ('Metal roof',          'Specialized racking and labor on metal roofs',
   '{"field": "roof_type", "op": "eq", "value": "metal"}',        0.15, 'per_watt', 100),
  ('Main panel upgrade',  'Service panel under 200A needs an upgrade',
   '{"field": "main_panel_amps", "op": "lt", "value": 200}',   2600.00, 'flat',     90),
  ('Steep pitch',         'Roof pitch over 35 degrees',
   '{"field": "roof_pitch_deg", "op": "gt", "value": 35}',      750.00, 'flat',    110),
  ('Long trench run',     'Trenching beyond 50 feet, priced per project',
   '{"field": "trench_feet", "op": "gt", "value": 50}',           18.00, 'per_watt', 120)
on conflict do nothing;

insert into public.vendors (name, categories, contact) values
  ('CED Greentech',   array['module', 'inverter', 'racking'], '{"email": "quotes@example.com"}'),
  ('BayWa r.e.',      array['module', 'storage'],             '{"email": "sales@example.com"}')
on conflict do nothing;

insert into public.surveyors (name, phone) values
  ('Miguel Torres', '480-555-0141'),
  ('Dana Kim', '480-555-0177')
on conflict do nothing;

insert into public.crews (name, contact) values
  ('Helios Install Co', '{"phone": "480-555-0190"}'),
  ('SunRaise Crews LLC', '{"phone": "512-555-0122"}')
on conflict do nothing;

insert into public.hoas (name, contact) values
  ('Desert Vista HOA', '{"email": "arch@desertvista.example"}')
on conflict do nothing;

-- finance_partners has no unique name constraint, so 'on conflict' can't
-- dedupe — insert only what's missing (001700 seeds the spec's partner list).
insert into public.finance_partners (name, contact)
select v.name, v.contact::jsonb
from (values
  ('GoodLeap', '{"email": "partners@example.com"}'),
  ('Mosaic', '{"email": "partners@example.com"}'),
  ('Credit Human', '{}'), ('TOPCO', '{}'), ('ICCU', '{}'), ('LightReach', '{}')
) as v(name, contact)
where not exists (
  select 1 from public.finance_partners fp where lower(fp.name) = lower(v.name)
);
