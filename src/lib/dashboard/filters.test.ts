import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildWhere,
  captionFor,
  filterQuery,
  parseFilters,
  projectsLink,
  resolvePeriod,
  shortDate,
  statExpr,
  totalDaysColumn,
  type DashboardFilters,
} from './filters.ts';

/**
 * The dashboard's arithmetic and its allowlists. Both are worth testing because
 * both fail silently: a wrong previous-period boundary invents a change
 * percentage out of nothing, and a filter that reaches SQL unvalidated is a
 * different kind of problem entirely.
 */

const base = (over: Partial<DashboardFilters> = {}): DashboardFilters => ({
  period: 'month',
  customFrom: null,
  customTo: null,
  pm: null,
  dealer: null,
  stage: null,
  status: null,
  mine: false,
  stat: 'median',
  exHold: false,
  ...over,
});

const UUID = '11111111-2222-3333-4444-555555555555';

test('parseFilters defaults to this month and median', () => {
  const f = parseFilters({});
  assert.equal(f.period, 'month');
  assert.equal(f.stat, 'median', 'median is the default — one 90-day permit drags an average');
  assert.equal(f.exHold, false);
  assert.equal(f.mine, false);
});

test('parseFilters drops anything not on the allowlist', () => {
  const f = parseFilters({
    period: 'fortnight',
    stage: 'sabotage',
    status: "active'; drop table projects; --",
    pm: 'not-a-uuid',
    dealer: '../../etc/passwd',
    from: '2026-13-45x',
    stat: 'mean',
  });
  assert.equal(f.period, 'month');
  assert.equal(f.stage, null);
  assert.equal(f.status, null);
  assert.equal(f.pm, null);
  assert.equal(f.dealer, null);
  assert.equal(f.customFrom, null);
  assert.equal(f.stat, 'median');
});

test('parseFilters accepts the real values', () => {
  const f = parseFilters({
    period: 'custom',
    from: '2026-01-01',
    to: '2026-03-31',
    pm: UUID,
    stage: 'permits',
    status: 'on_hold',
    mine: '1',
    stat: 'average',
    exhold: '1',
  });
  assert.equal(f.period, 'custom');
  assert.equal(f.customFrom, '2026-01-01');
  assert.equal(f.pm, UUID);
  assert.equal(f.stage, 'permits');
  assert.equal(f.status, 'on_hold');
  assert.equal(f.mine, true);
  assert.equal(f.stat, 'average');
  assert.equal(f.exHold, true);
});

test('a custom period with no dates is all time, not an empty range', () => {
  const f = parseFilters({ period: 'custom' });
  assert.equal(f.period, 'all');
  assert.equal(resolvePeriod(f, '2026-08-19').current.from, null);
});

test('resolvePeriod: this month', () => {
  const p = resolvePeriod(base(), '2026-08-19');
  assert.deepEqual(p.current, { from: '2026-08-01', to: '2026-08-19' });
  assert.equal(p.label, 'August 2026');
});

test('resolvePeriod: quarter and year', () => {
  assert.equal(resolvePeriod(base({ period: 'quarter' }), '2026-08-19').current.from, '2026-07-01');
  assert.equal(resolvePeriod(base({ period: 'quarter' }), '2026-08-19').label, 'Q3 2026');
  assert.equal(resolvePeriod(base({ period: 'quarter' }), '2026-01-05').current.from, '2026-01-01');
  assert.equal(resolvePeriod(base({ period: 'year' }), '2026-08-19').current.from, '2026-01-01');
});

test('the previous period is the same number of days, not the previous calendar month', () => {
  // 1–19 August is 19 days, so the comparison is the 19 days before it: 13–31
  // July. Comparing a 19-day slice against a 31-day month would report a fall
  // in completions that never happened.
  const p = resolvePeriod(base(), '2026-08-19');
  assert.deepEqual(p.previous, { from: '2026-07-13', to: '2026-07-31' });
});

test('all time has no previous period to compare against', () => {
  assert.equal(resolvePeriod(base({ period: 'all' }), '2026-08-19').previous, null);
});

test('a custom range given backwards is corrected, not left empty', () => {
  const p = resolvePeriod(
    base({ period: 'custom', customFrom: '2026-06-30', customTo: '2026-06-01' }),
    '2026-08-19'
  );
  assert.deepEqual(p.current, { from: '2026-06-01', to: '2026-06-30' });
});

test('resolvePeriod is timezone-proof at the month boundary', () => {
  // Parsed as UTC throughout: on the 1st, 'this month' must start on the 1st,
  // not on the last day of the previous month in some local offset.
  const p = resolvePeriod(base(), '2026-03-01');
  assert.deepEqual(p.current, { from: '2026-03-01', to: '2026-03-01' });
  assert.deepEqual(p.previous, { from: '2026-02-28', to: '2026-02-28' });
});

test('shortDate is unambiguous', () => {
  assert.equal(shortDate('2026-08-03'), '3 Aug 2026');
});

test('buildWhere binds every value as a parameter', () => {
  const w = buildWhere(
    base({ pm: UUID, stage: 'permits', status: 'active' }),
    'created_at',
    { from: '2026-08-01', to: '2026-08-19' },
    'viewer-id'
  );
  assert.match(w.clause, /m\.assigned_pm = \$1/);
  assert.match(w.clause, /m\.stage = \$2::public\.project_stage/);
  assert.match(w.clause, /m\.status = \$3::public\.project_status/);
  assert.match(w.clause, /m\.created_at >= \$4::date/);
  assert.match(w.clause, /m\.created_at <= \$5::date/);
  assert.deepEqual(w.params, [UUID, 'permits', 'active', '2026-08-01', '2026-08-19']);
  // Not one literal from the filter values ends up in the SQL text.
  assert.ok(!w.clause.includes(UUID));
  assert.ok(!w.clause.includes('permits'));
});

test("buildWhere honours 'my projects' only when no PM is chosen", () => {
  const mine = buildWhere(base({ mine: true }), 'none', { from: null, to: 'x' }, 'viewer-id');
  assert.deepEqual(mine.params, ['viewer-id']);

  // An explicit PM wins: the toggle must not silently narrow to two people.
  const both = buildWhere(base({ mine: true, pm: UUID }), 'none', { from: null, to: 'x' }, 'viewer-id');
  assert.deepEqual(both.params, [UUID]);
});

test('basis "none" adds no date condition — the funnel is a picture of now', () => {
  const w = buildWhere(base(), 'none', { from: '2026-08-01', to: '2026-08-19' }, 'v');
  assert.equal(w.clause, '');
  assert.deepEqual(w.params, []);
});

test('an open-ended period still bounds the upper end', () => {
  const w = buildWhere(base({ period: 'all' }), 'completion_date', { from: null, to: '2026-08-19' }, 'v');
  assert.ok(!w.clause.includes('>='));
  assert.match(w.clause, /m\.completion_date <= \$1::date/);
  assert.match(w.clause, /m\.completion_date is not null/);
});

test('buildWhere can start numbering after earlier parameters', () => {
  const w = buildWhere(base({ dealer: UUID }), 'none', { from: null, to: 'x' }, 'v', 2);
  assert.match(w.clause, /m\.dealer_id = \$3/);
});

test('the exclude-hold toggle picks the other duration column', () => {
  assert.equal(totalDaysColumn(base()), 'm.total_days');
  assert.equal(totalDaysColumn(base({ exHold: true })), 'm.total_days_ex_hold');
});

test('median and average are both real SQL, and median is the default', () => {
  assert.match(statExpr(base(), 'm.total_days'), /percentile_cont\(0\.5\) within group/);
  assert.equal(statExpr(base({ stat: 'average' }), 'm.total_days'), 'avg(m.total_days)');
});

test('filterQuery round-trips through parseFilters', () => {
  const f = base({
    period: 'custom',
    customFrom: '2026-01-01',
    customTo: '2026-03-31',
    pm: UUID,
    stage: 'design',
    status: 'complete',
    mine: true,
    stat: 'average',
    exHold: true,
  });
  const parsed = parseFilters(Object.fromEntries(new URLSearchParams(filterQuery(f))));
  assert.deepEqual(parsed, f);
});

test('filterQuery omits the defaults so a plain link stays plain', () => {
  assert.equal(filterQuery(base()), '');
});

test('filterQuery overrides replace and can delete', () => {
  const f = base({ stage: 'design' });
  assert.equal(filterQuery(f, { stage: 'permits' }), 'stage=permits');
  assert.equal(filterQuery(f, { stage: null }), '');
});

test('projectsLink carries the drill-down into the Projects tab', () => {
  const f = base({ dealer: UUID, stage: 'design' });
  assert.equal(projectsLink(f), `/projects?stage=design&dealer=${UUID}`);
  assert.equal(projectsLink(f, { stage: 'permits' }), `/projects?stage=permits&dealer=${UUID}`);
  assert.equal(projectsLink(base(), { status: 'on_hold' }), '/projects?status=on_hold');
  assert.equal(projectsLink(base()), '/projects');
});

test('every chart can state its period and its filter', () => {
  const period = resolvePeriod(base({ period: 'quarter' }), '2026-08-19');
  const caption = captionFor(period, base({ period: 'quarter', exHold: true, stage: 'permits' }), {
    dealer: 'Bright Solar',
  });
  assert.match(caption, /Q3 2026/);
  assert.match(caption, /Bright Solar/);
  assert.match(caption, /permits/);
  assert.match(caption, /hold time excluded/);
});
