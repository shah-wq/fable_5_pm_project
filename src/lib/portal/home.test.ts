import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cityState,
  completionPercent,
  nextStage,
  plausiblePanelCount,
  shortRange,
  stagePosition,
  startedAgo,
  systemLine,
  timeInStage,
  typicalLabel,
} from './home.ts';

test('completion is completed stages over seven, and never weighted by duration', () => {
  assert.equal(completionPercent('survey', false), 0);
  assert.equal(completionPercent('design', false), 14);
  assert.equal(completionPercent('permits', false), 29);
  assert.equal(completionPercent('inspection_pto', false), 71);
  assert.equal(completionPercent('complete', true), 100);
  // A finished project reads 100 whatever stage the row says.
  assert.equal(completionPercent('install', true), 100);
  // Monotonic: the bar can never go backwards as a project advances, which is
  // the whole reason for not weighting it by expected duration.
  let last = -1;
  for (const stage of ['survey', 'design', 'permits', 'procurement', 'install', 'inspection_pto', 'complete'] as const) {
    const value = completionPercent(stage, false);
    assert.ok(value > last, `${stage} did not advance the bar`);
    last = value;
  }
});

test('the stage number reads as a position', () => {
  assert.deepEqual(stagePosition('survey'), { index: 1, total: 7 });
  assert.deepEqual(stagePosition('permits'), { index: 3, total: 7 });
  assert.deepEqual(stagePosition('complete'), { index: 7, total: 7 });
});

test('the location is the city and state, never the country', () => {
  // The reported bug: a homeowner in Tucson shown 'USA'.
  assert.equal(cityState('4820 N Camino Real, Tucson, AZ 85718, USA'), 'Tucson, AZ');
  assert.equal(cityState('12 Sunbeam Road, Austin, TX'), 'Austin, TX');
  assert.equal(cityState('12 Sunbeam Road, Austin, TX 78701-1234'), 'Austin, TX');
  assert.equal(cityState('USA'), null);
  assert.equal(cityState('Tucson, USA'), 'Tucson');
  // No state in the address: fall back to the most specific part rather than
  // guessing, and never to nothing.
  assert.equal(cityState('9 Elsewhere Ave, Springfield'), 'Springfield');
  assert.equal(cityState('Just one line'), 'Just one line');
  assert.equal(cityState(null), null);
  assert.equal(cityState(''), null);
});

test('a panel count that cannot be right is left out, not printed', () => {
  // 18 kW from one panel is a field nobody filled in, not a very large panel.
  assert.ok(!plausiblePanelCount(1, 18));
  assert.ok(plausiblePanelCount(44, 18)); // ~409W each
  assert.ok(plausiblePanelCount(1, 0.4)); // a genuinely tiny system
  assert.ok(!plausiblePanelCount(0, 18));
  assert.ok(!plausiblePanelCount(null, 18));
  // With no system size there is nothing to contradict the count.
  assert.ok(plausiblePanelCount(12, null));
});

test('the system line is pluralised and drops what it cannot vouch for', () => {
  assert.equal(
    systemLine({ address: '4820 N Camino Real, Tucson, AZ 85718, USA', sizeKw: 18, modules: 44, batteries: 1 }),
    'Tucson, AZ · 18 kW · 44 panels · 1 battery'
  );
  // The screenshot that started this: 'USA · 18 kW · 1 panels + 1 battery'.
  assert.equal(
    systemLine({ address: 'USA', sizeKw: 18, modules: 1, batteries: 1 }),
    '18 kW · 1 battery'
  );
  assert.equal(
    systemLine({ address: 'Austin, TX', sizeKw: 7.2, modules: 18, batteries: 2 }),
    'Austin, TX · 7.2 kW · 18 panels · 2 batteries'
  );
  assert.equal(
    systemLine({ address: 'Austin, TX', sizeKw: null, modules: 1, batteries: null }),
    'Austin, TX · 1 panel'
  );
  assert.equal(systemLine({ address: null, sizeKw: null, modules: null, batteries: null }), '');
});

test('typical durations are a range, and absent when nobody set one', () => {
  assert.equal(typicalLabel({ min: 15, max: 30 }), 'Typical 15–30 days');
  assert.equal(typicalLabel({ min: 3, max: 3 }), 'Typical 3 days');
  assert.equal(typicalLabel(null), null);
  assert.equal(shortRange({ min: 7, max: 10 }), '7–10 days');
  assert.equal(shortRange(undefined), null);
});

test('up next is the next stage only, and nothing after the last', () => {
  assert.equal(nextStage('survey'), 'design');
  assert.equal(nextStage('inspection_pto'), 'complete');
  assert.equal(nextStage('complete'), null);
});

test('the time bar fills but never overflows', () => {
  assert.deepEqual(timeInStage(2, 10), { day: 3, of: 10, percent: 30, over: false });
  // Day one of a stage entered today, not day zero.
  assert.deepEqual(timeInStage(0, 10), { day: 1, of: 10, percent: 10, over: false });
  // Past the threshold the bar is full and says so, rather than running past
  // its own track.
  const late = timeInStage(40, 10);
  assert.deepEqual(late, { day: 41, of: 10, percent: 100, over: true });
  // Nothing to draw without both numbers.
  assert.equal(timeInStage(null, 10), null);
  assert.equal(timeInStage(3, null), null);
  assert.equal(timeInStage(3, 0), null);
});

test('the start line reads like a person wrote it', () => {
  assert.equal(startedAgo(0), 'Your project started today');
  assert.equal(startedAgo(1), 'Your project started yesterday');
  assert.equal(startedAgo(3), 'Your project started 3 days ago');
  // Days up to a month, then months: '95 days ago' is arithmetic, not language.
  assert.equal(startedAgo(30), 'Your project started 30 days ago');
  assert.equal(startedAgo(31), 'Your project started a month ago');
  assert.equal(startedAgo(95), 'Your project started 3 months ago');
  assert.equal(startedAgo(null), null);
});
