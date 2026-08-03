import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOC_CATEGORIES, STAGES } from './definitions.ts';
import { evaluateStage, type StageBundle } from './requirements.ts';

// Run: npm run test:unit

function emptyBundle(): StageBundle {
  return {
    project: { jurisdictionId: null, utilityId: null, financePartnerId: null },
    survey: null,
    design: null,
    permits: [],
    bomLines: [],
    procurement: null,
    install: null,
    inspection: null,
    adderCount: 0,
    signedChangeOrderCount: 0,
    docCategories: new Set(),
  };
}

function completeSurveyBundle(): StageBundle {
  const b = emptyBundle();
  b.project.jurisdictionId = 'j1';
  b.project.utilityId = 'u1';
  b.survey = {
    hoaApplies: false,
    hoaId: null,
    surveyDate: '2026-08-01',
    timeWindow: '8–11am',
    surveyorId: 's1',
    surveyStatus: 'completed',
    roofType: 'shingle',
    roofPitch: '4/12–6/12',
    mainPanelAdequate: true,
  };
  b.docCategories = new Set(DOC_CATEGORIES.surveyPhotos);
  return b;
}

test('every stage blocks an empty project', () => {
  for (const stage of STAGES) {
    assert.ok(evaluateStage(stage, emptyBundle()).length > 0, `${stage} must have gaps`);
  }
});

test('survey: full data + six photo slots passes; each rule bites alone', () => {
  const good = completeSurveyBundle();
  assert.deepEqual(evaluateStage('survey', good), []);

  const noPhotos = completeSurveyBundle();
  noPhotos.docCategories = new Set([...DOC_CATEGORIES.surveyPhotos].slice(0, 5));
  assert.equal(evaluateStage('survey', noPhotos).length, 1);

  const notCompleted = completeSurveyBundle();
  notCompleted.survey!.surveyStatus = 'scheduled';
  assert.ok(evaluateStage('survey', notCompleted).some((g) => g.includes('not marked completed')));

  const hoaUnanswered = completeSurveyBundle();
  hoaUnanswered.survey!.hoaApplies = null;
  assert.ok(evaluateStage('survey', hoaUnanswered).some((g) => g.includes('HOA question')));

  const hoaMissing = completeSurveyBundle();
  hoaMissing.survey!.hoaApplies = true;
  assert.ok(evaluateStage('survey', hoaMissing).some((g) => g.includes('no HOA selected')));
});

function completeDesignBundle(): StageBundle {
  const b = completeSurveyBundle();
  b.design = {
    designerId: 'd1',
    assignedDate: '2026-08-02',
    dueDate: '2026-08-04',
    adderApprovalDate: null,
    newContractTotal: null,
    financeNotifiedDate: null,
    financeAckedDate: null,
    productionKwh: 12500,
    clientApprovalDate: '2026-08-05',
    peStampDate: '2026-08-06',
  };
  b.docCategories = new Set([
    ...DOC_CATEGORIES.surveyPhotos,
    DOC_CATEGORIES.planSetDwg,
    DOC_CATEGORIES.planSetPdf,
    DOC_CATEGORIES.stampedSet,
  ]);
  return b;
}

test('design: conditional rules for adders and finance partner', () => {
  assert.deepEqual(evaluateStage('design', completeDesignBundle()), []);

  const withAdders = completeDesignBundle();
  withAdders.adderCount = 2;
  const gaps = evaluateStage('design', withAdders);
  assert.ok(gaps.some((g) => g.includes('adder approval')));
  assert.ok(gaps.some((g) => g.includes('contract total')));
  assert.ok(gaps.some((g) => g.includes('change order')));

  withAdders.design!.adderApprovalDate = '2026-08-05';
  withAdders.design!.newContractTotal = 45000;
  withAdders.signedChangeOrderCount = 1;
  assert.deepEqual(evaluateStage('design', withAdders), []);

  const withFinance = completeDesignBundle();
  withFinance.project.financePartnerId = 'f1';
  assert.ok(evaluateStage('design', withFinance).some((g) => g.includes('Finance partner')));
  withFinance.design!.financeNotifiedDate = '2026-08-05';
  withFinance.design!.financeAckedDate = '2026-08-06';
  assert.deepEqual(evaluateStage('design', withFinance), []);
});

function approvedTrack(track: string) {
  return {
    permitType: track,
    status: 'approved',
    submissionMethod: 'portal',
    submittedAt: '2026-08-07',
    referenceNo: 'REF-1',
    approvedAt: '2026-08-14',
  };
}

test('permits: three tracks, HOA skipped when not applicable', () => {
  const b = completeDesignBundle();
  b.permits = [approvedTrack('city_county'), approvedTrack('utility')];
  b.docCategories = new Set([
    ...b.docCategories,
    DOC_CATEGORIES.permitLetter('city_county'),
    DOC_CATEGORIES.permitLetter('utility'),
    DOC_CATEGORIES.signatureDocs,
  ]);
  assert.deepEqual(evaluateStage('permits', b), []);

  // HOA applies → its track becomes required.
  b.survey!.hoaApplies = true;
  b.survey!.hoaId = 'h1';
  assert.ok(evaluateStage('permits', b).some((g) => g.includes('HOA approval not started')));
  b.permits.push(approvedTrack('hoa'));
  b.docCategories.add(DOC_CATEGORIES.permitLetter('hoa'));
  assert.deepEqual(evaluateStage('permits', b), []);

  // Approved without the letter uploaded still blocks.
  b.docCategories.delete(DOC_CATEGORIES.permitLetter('utility'));
  assert.ok(evaluateStage('permits', b).some((g) => g.includes('approval letter')));
});

test('procurement: all lines delivered + delivery check', () => {
  const b = completeDesignBundle();
  b.bomLines = [
    { lineStatus: 'delivered', vendorId: 'v1', poNumber: 'PO-1', orderDate: '2026-08-15' },
    { lineStatus: 'shipped', vendorId: 'v1', poNumber: 'PO-2', orderDate: '2026-08-15' },
  ];
  b.procurement = { deliveryDate: null, deliveryOk: null };
  const gaps = evaluateStage('procurement', b);
  assert.ok(gaps.some((g) => g.includes('not delivered')));
  assert.ok(gaps.some((g) => g.includes('Delivery date')));
  assert.ok(gaps.some((g) => g.includes('Delivery check')));

  b.bomLines[1].lineStatus = 'delivered';
  b.procurement = { deliveryDate: '2026-08-20', deliveryOk: true };
  b.docCategories.add(DOC_CATEGORIES.deliveryPhotos);
  assert.deepEqual(evaluateStage('procurement', b), []);
});

test('install: punch list requires resolution only when present', () => {
  const b = completeDesignBundle();
  b.install = {
    crewId: 'c1',
    startDate: '2026-09-01',
    endDate: '2026-09-02',
    customerConfirmed: true,
    workOrderDate: '2026-08-25',
    installStatus: 'completed',
    completionDate: '2026-09-02',
    punchList: null,
    punchResolvedDate: null,
  };
  b.docCategories.add(DOC_CATEGORIES.workOrder);
  b.docCategories.add(DOC_CATEGORIES.completionPhotos);
  assert.deepEqual(evaluateStage('install', b), []);

  b.install.punchList = 'Conduit paint touch-up';
  assert.ok(evaluateStage('install', b).some((g) => g.includes('Punch-list')));
  b.install.punchResolvedDate = '2026-09-03';
  assert.deepEqual(evaluateStage('install', b), []);
});

test('inspection & PTO: pass + sign-off + PTO letter + handoff', () => {
  const b = completeDesignBundle();
  b.inspection = {
    inspectionDate: '2026-09-10',
    timeWindow: '9–12',
    crewConfirmed: true,
    result: 'fail',
    ptoSubmittedDate: null,
    ptoIssuedDate: null,
    handoffDone: null,
  };
  const gaps = evaluateStage('inspection_pto', b);
  assert.ok(gaps.some((g) => g.includes('not passed')));
  assert.ok(gaps.some((g) => g.includes('PTO not submitted')));

  b.inspection.result = 'pass';
  b.inspection.ptoSubmittedDate = '2026-09-11';
  b.inspection.ptoIssuedDate = '2026-09-18';
  b.inspection.handoffDone = true;
  b.docCategories.add(DOC_CATEGORIES.inspectionSignoff);
  b.docCategories.add(DOC_CATEGORIES.ptoLetter);
  assert.deepEqual(evaluateStage('inspection_pto', b), []);
});
