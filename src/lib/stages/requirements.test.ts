import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STAGES } from './definitions.ts';
import { evaluateStage, type StageBundle } from './requirements.ts';

// Run: npm run test:unit — pins the Stage Field Specification's advance gates.

function bundle(partial: Partial<StageBundle> = {}): StageBundle {
  return {
    financePartnerId: null,
    survey: null,
    design: null,
    permits: null,
    procurement: null,
    install: null,
    inspection: null,
    finance: null,
    docCategories: new Set(),
    ...partial,
  };
}

test('every stage blocks an empty project', () => {
  for (const stage of STAGES) {
    assert.ok(evaluateStage(stage, bundle()).length > 0, `${stage} must have gaps`);
  }
});

function goodSurvey(): Record<string, unknown> {
  return {
    down_payment_status: 'received',
    down_payment_received_date: '2026-08-01',
    cash_m1_status: 'na',
    survey_status: 'completed',
    survey_completed_date: '2026-08-02',
    drive_updated: true,
  };
}

test('survey: DP received + M1 resolved + survey completed + drive', () => {
  assert.deepEqual(evaluateStage('survey', bundle({ survey: goodSurvey() })), []);

  const noDpDate = goodSurvey();
  noDpDate.down_payment_received_date = null;
  assert.ok(evaluateStage('survey', bundle({ survey: noDpDate }))
    .some((g) => g.includes('Down Payment received date')));

  const m1Requested = goodSurvey();
  m1Requested.cash_m1_status = 'requested';
  assert.ok(evaluateStage('survey', bundle({ survey: m1Requested }))
    .some((g) => g.includes('Cash M1 not resolved')));

  const m1Received = goodSurvey();
  m1Received.cash_m1_status = 'received';
  m1Received.cash_m1_received_date = '2026-08-03';
  assert.deepEqual(evaluateStage('survey', bundle({ survey: m1Received })), []);

  const noDrive = goodSurvey();
  noDrive.drive_updated = false;
  assert.ok(evaluateStage('survey', bundle({ survey: noDrive }))
    .some((g) => g.includes('Drive Updated')));
});

function goodDesign(): Record<string, unknown> {
  return {
    designer_id: 'd1',
    design_status: 'received',
    design_requested_date: '2026-08-03',
    design_received_date: '2026-08-05',
    stamps_status: 'na',
    drive_updated: true,
  };
}

test('design: designer + received with dates + stamps resolved + drive', () => {
  assert.deepEqual(evaluateStage('design', bundle({ design: goodDesign() })), []);

  const inProgress = goodDesign();
  inProgress.design_status = 'in_progress';
  assert.ok(evaluateStage('design', bundle({ design: inProgress }))
    .some((g) => g.includes('Design Status not Received')));

  const stampsPending = goodDesign();
  stampsPending.stamps_status = 'requested';
  assert.ok(evaluateStage('design', bundle({ design: stampsPending }))
    .some((g) => g.includes('Stamps not received')));

  const stampsDone = goodDesign();
  stampsDone.stamps_status = 'received';
  assert.ok(evaluateStage('design', bundle({ design: stampsDone }))
    .some((g) => g.includes('Stamps received date missing')));
  stampsDone.stamps_received_date = '2026-08-06';
  assert.deepEqual(evaluateStage('design', bundle({ design: stampsDone })), []);
});

function goodPermits(): Record<string, unknown> {
  return {
    permit_status: 'approved',
    permit_applied_date: '2026-08-07',
    permit_received_date: '2026-08-20',
    ica_status: 'approved',
    ica_applied_date: '2026-08-07',
    ica_received_date: '2026-08-18',
    hoa_status: 'na',
    cash_m2_status: 'na',
    hdm_ntp_status: 'na',
    drive_updated: true,
  };
}

test('permits: five tracks — approvals with dates, N/A first-class', () => {
  assert.deepEqual(evaluateStage('permits', bundle({ permits: goodPermits() })), []);

  const inReview = goodPermits();
  inReview.permit_status = 'in_review';
  assert.ok(evaluateStage('permits', bundle({ permits: inReview }))
    .some((g) => g.includes('Building permit not Approved')));

  const hoaApplies = goodPermits();
  hoaApplies.hoa_status = 'applied';
  assert.ok(evaluateStage('permits', bundle({ permits: hoaApplies }))
    .some((g) => g.includes('HOA not Approved (or N/A)')));
  hoaApplies.hoa_status = 'approved';
  const gaps = evaluateStage('permits', bundle({ permits: hoaApplies }));
  assert.ok(gaps.some((g) => g.includes('HOA applied date')));
  hoaApplies.hoa_applied_date = '2026-08-10';
  hoaApplies.hoa_received_date = '2026-08-25';
  assert.deepEqual(evaluateStage('permits', bundle({ permits: hoaApplies })), []);

  const ntpSubmitted = goodPermits();
  ntpSubmitted.hdm_ntp_status = 'submitted';
  assert.ok(evaluateStage('permits', bundle({ permits: ntpSubmitted }))
    .some((g) => g.includes('HDM NTP not approved (or N/A)')));
});

test('procurement: manager + delivered with dates + drive', () => {
  const good = {
    procurement_manager: 'u1',
    material_status: 'delivered',
    material_requested_date: '2026-09-01',
    material_delivered_date: '2026-09-10',
    drive_updated: true,
  };
  assert.deepEqual(evaluateStage('procurement', bundle({ procurement: good })), []);

  const inTransit = { ...good, material_status: 'in_transit' };
  assert.ok(evaluateStage('procurement', bundle({ procurement: inTransit }))
    .some((g) => g.includes('Material Status not Delivered')));

  const noManager = { ...good, procurement_manager: null };
  assert.ok(evaluateStage('procurement', bundle({ procurement: noManager }))
    .some((g) => g.includes('procurement manager')));
});

function goodInstall(): Partial<StageBundle> {
  return {
    install: {
      install_manager: 'u1',
      install_status: 'completed',
      install_requested_date: '2026-09-12',
      install_scheduled_date: '2026-09-20',
      install_completed_date: '2026-09-22',
      cash_m3_status: 'na',
      drive_updated: true,
    },
    finance: { m1_status: 'na', m2_status: 'not_submitted' },
    docCategories: new Set(['install_pictures']),
  };
}

test('install: completed with three dates + pictures + M3 + Finance M1 + drive', () => {
  assert.deepEqual(evaluateStage('install', bundle(goodInstall())), []);

  const noPics = goodInstall();
  noPics.docCategories = new Set();
  assert.ok(evaluateStage('install', bundle(noPics))
    .some((g) => g.includes('Install pictures')));

  const m1Pending = goodInstall();
  m1Pending.finance = { m1_status: 'submitted' };
  assert.ok(evaluateStage('install', bundle(m1Pending))
    .some((g) => g.includes('Finance M1 not approved (or N/A)')));

  const m1Approved = goodInstall();
  m1Approved.finance = { m1_status: 'approved', m1_approved_date: '2026-09-25' };
  assert.deepEqual(evaluateStage('install', bundle(m1Approved)), []);
});

function goodInspection(): Partial<StageBundle> {
  return {
    inspection: {
      inspection_status: 'passed',
      inspection_requested_date: '2026-10-01',
      inspection_completed_date: '2026-10-05',
      pto_status: 'received',
      pto_applied_date: '2026-10-06',
      pto_received_date: '2026-10-15',
      energization_status: 'energized',
      energization_date: '2026-10-16',
      drive_updated: true,
    },
    finance: {
      m1_status: 'approved', m1_approved_date: '2026-09-25',
      m2_status: 'approved', m2_approved_date: '2026-10-17',
    },
  };
}

test('inspection & PTO: pass + PTO received + energized + M1/M2 + drive', () => {
  assert.deepEqual(evaluateStage('inspection_pto', bundle(goodInspection())), []);

  const failed = goodInspection();
  failed.inspection = { ...failed.inspection!, inspection_status: 'failed' };
  assert.ok(evaluateStage('inspection_pto', bundle(failed))
    .some((g) => g.includes('Inspection not Passed')));

  const noEnergize = goodInspection();
  noEnergize.inspection = { ...noEnergize.inspection!, energization_status: 'in_progress' };
  assert.ok(evaluateStage('inspection_pto', bundle(noEnergize))
    .some((g) => g.includes('not Energized')));

  const m2Pending = goodInspection();
  m2Pending.finance = { ...m2Pending.finance!, m2_status: 'submitted' };
  assert.ok(evaluateStage('inspection_pto', bundle(m2Pending))
    .some((g) => g.includes('Finance M2 not approved (or N/A)')));

  const m2Na = goodInspection();
  m2Na.finance = { ...m2Na.finance!, m2_status: 'na', m2_approved_date: null };
  assert.deepEqual(evaluateStage('inspection_pto', bundle(m2Na)), []);
});
