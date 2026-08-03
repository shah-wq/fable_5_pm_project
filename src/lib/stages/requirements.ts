import { DOC_CATEGORIES, type StageKey } from './definitions.ts';

/**
 * The stage-gate rules from the Manual Version spec, as pure functions over a
 * loaded StageBundle. This is the ONE validation path: the advance button,
 * the Kanban drag-and-drop, and the missing-items badges all call
 * evaluateStage() — never their own checks.
 *
 * Data loading lives in service.ts; keeping evaluation pure makes every rule
 * unit-testable (requirements.test.ts).
 */

export interface StageBundle {
  project: {
    jurisdictionId: string | null;
    utilityId: string | null;
    financePartnerId: string | null;
  };
  survey: {
    hoaApplies: boolean | null;
    hoaId: string | null;
    surveyDate: string | null;
    timeWindow: string | null;
    surveyorId: string | null;
    surveyStatus: string | null;
    roofType: string | null;
    roofPitch: string | null;
    mainPanelAdequate: boolean | null;
  } | null;
  design: {
    designerId: string | null;
    assignedDate: string | null;
    dueDate: string | null;
    adderApprovalDate: string | null;
    newContractTotal: number | null;
    financeNotifiedDate: string | null;
    financeAckedDate: string | null;
    productionKwh: number | null;
    clientApprovalDate: string | null;
    peStampDate: string | null;
  } | null;
  permits: Array<{
    permitType: string;
    status: string;
    submissionMethod: string | null;
    submittedAt: string | null;
    referenceNo: string | null;
    approvedAt: string | null;
  }>;
  bomLines: Array<{
    lineStatus: string;
    vendorId: string | null;
    poNumber: string | null;
    orderDate: string | null;
  }>;
  procurement: {
    deliveryDate: string | null;
    deliveryOk: boolean | null;
  } | null;
  install: {
    crewId: string | null;
    startDate: string | null;
    endDate: string | null;
    customerConfirmed: boolean | null;
    workOrderDate: string | null;
    installStatus: string | null;
    completionDate: string | null;
    punchList: string | null;
    punchResolvedDate: string | null;
  } | null;
  inspection: {
    inspectionDate: string | null;
    timeWindow: string | null;
    crewConfirmed: boolean | null;
    result: string | null;
    ptoSubmittedDate: string | null;
    ptoIssuedDate: string | null;
    handoffDone: boolean | null;
  } | null;
  adderCount: number;
  signedChangeOrderCount: number;
  /** Distinct documents.category values present on the project. */
  docCategories: Set<string>;
}

const PHOTO_LABELS: Record<string, string> = {
  photo_roof: 'roof photos',
  photo_attic: 'attic photos',
  photo_main_panel: 'main panel photos',
  photo_meter: 'meter photos',
  photo_wire_path: 'wire path photos',
  photo_obstructions: 'obstruction photos',
};

function surveyGaps(b: StageBundle): string[] {
  const gaps: string[] = [];
  const s = b.survey;
  if (!b.project.jurisdictionId) gaps.push('Jurisdiction (AHJ) not set');
  if (!b.project.utilityId) gaps.push('Utility company not set');
  if (!s) {
    gaps.push('Survey form not started');
    return gaps;
  }
  if (s.hoaApplies === null) gaps.push('HOA question not answered');
  else if (s.hoaApplies && !s.hoaId) gaps.push('HOA applies but no HOA selected');
  if (!s.surveyDate || !s.timeWindow) gaps.push('Survey date & time window not set');
  if (!s.surveyorId) gaps.push('No surveyor assigned');
  if (s.surveyStatus !== 'completed') gaps.push('Survey not marked completed');
  for (const category of DOC_CATEGORIES.surveyPhotos) {
    if (!b.docCategories.has(category)) gaps.push(`Missing ${PHOTO_LABELS[category]}`);
  }
  if (!s.roofType || !s.roofPitch) gaps.push('Roof type & pitch not recorded');
  if (s.mainPanelAdequate === null) gaps.push('Main panel adequacy not answered');
  return gaps;
}

function designGaps(b: StageBundle): string[] {
  const gaps: string[] = [];
  const d = b.design;
  if (!d) {
    gaps.push('Design form not started');
    return gaps;
  }
  if (!d.designerId || !d.assignedDate) gaps.push('No designer assigned');
  if (!d.dueDate) gaps.push('Design due date not set');
  if (!b.docCategories.has(DOC_CATEGORIES.planSetDwg)) gaps.push('Plan set DWG not uploaded');
  if (!b.docCategories.has(DOC_CATEGORIES.planSetPdf)) gaps.push('Plan set PDF not uploaded');
  if (d.productionKwh === null) gaps.push('Annual production estimate missing');
  if (!d.clientApprovalDate) gaps.push('Client design approval not dated');
  if (!d.peStampDate || !b.docCategories.has(DOC_CATEGORIES.stampedSet)) {
    gaps.push('PE-stamped plan set not on file');
  }
  if (b.adderCount > 0) {
    if (!d.adderApprovalDate) gaps.push('Client adder approval not dated');
    if (d.newContractTotal === null) gaps.push('New contract total not recorded');
    if (b.signedChangeOrderCount === 0 && !b.docCategories.has(DOC_CATEGORIES.signedCo)) {
      gaps.push('Signed change order not uploaded');
    }
  }
  if (b.project.financePartnerId && (!d.financeNotifiedDate || !d.financeAckedDate)) {
    gaps.push('Finance partner not notified/acknowledged');
  }
  return gaps;
}

const TRACK_LABELS: Record<string, string> = {
  city_county: 'City/County permit',
  hoa: 'HOA approval',
  utility: 'Utility interconnection',
};

function permitTrackGaps(b: StageBundle, track: string): string[] {
  const gaps: string[] = [];
  const label = TRACK_LABELS[track];
  const row = b.permits.find((p) => p.permitType === track);
  if (!row) {
    gaps.push(`${label} not started`);
    return gaps;
  }
  if (!row.submissionMethod) gaps.push(`${label}: submission method not set`);
  if (!row.submittedAt || !row.referenceNo) {
    gaps.push(`${label}: submitted date / reference no. missing`);
  }
  if (row.status !== 'approved') gaps.push(`${label} not approved`);
  else if (!row.approvedAt || !b.docCategories.has(DOC_CATEGORIES.permitLetter(track))) {
    gaps.push(`${label}: approval letter not uploaded`);
  }
  return gaps;
}

function permitsGaps(b: StageBundle): string[] {
  const gaps: string[] = [];
  gaps.push(...permitTrackGaps(b, 'city_county'));
  // HOA track only when the survey said an HOA applies.
  if (b.survey?.hoaApplies) gaps.push(...permitTrackGaps(b, 'hoa'));
  gaps.push(...permitTrackGaps(b, 'utility'));
  if (!b.docCategories.has(DOC_CATEGORIES.signatureDocs)) {
    gaps.push('Signed permit forms / interconnection agreement not uploaded');
  }
  return gaps;
}

function procurementGaps(b: StageBundle): string[] {
  const gaps: string[] = [];
  if (b.bomLines.length === 0) gaps.push('No BOM lines entered');
  const unordered = b.bomLines.filter((l) => !l.vendorId || !l.poNumber || !l.orderDate).length;
  if (unordered > 0) gaps.push(`${unordered} BOM line(s) missing vendor / PO / order date`);
  const undelivered = b.bomLines.filter((l) => l.lineStatus !== 'delivered').length;
  if (b.bomLines.length > 0 && undelivered > 0) {
    gaps.push(`${undelivered} BOM line(s) not delivered`);
  }
  if (!b.procurement?.deliveryDate) gaps.push('Delivery date not recorded');
  if (!b.docCategories.has(DOC_CATEGORIES.deliveryPhotos)) gaps.push('Delivery photos not uploaded');
  if (b.procurement?.deliveryOk !== true) gaps.push('Delivery check not confirmed');
  return gaps;
}

function installGaps(b: StageBundle): string[] {
  const gaps: string[] = [];
  const i = b.install;
  if (!i) {
    gaps.push('Install form not started');
    return gaps;
  }
  if (!i.crewId) gaps.push('No install crew assigned');
  if (!i.startDate || !i.endDate) gaps.push('Install dates not set');
  if (i.customerConfirmed !== true) gaps.push('Customer has not confirmed the dates');
  if (!i.workOrderDate || !b.docCategories.has(DOC_CATEGORIES.workOrder)) {
    gaps.push('Work order not sent to crew');
  }
  if (i.installStatus !== 'completed') gaps.push('Install not marked completed');
  if (!i.completionDate) gaps.push('Completion date missing');
  if (!b.docCategories.has(DOC_CATEGORIES.completionPhotos)) {
    gaps.push('Completion photos not uploaded');
  }
  if (i.punchList && i.punchList.trim() !== '' && !i.punchResolvedDate) {
    gaps.push('Punch-list items not resolved');
  }
  return gaps;
}

function inspectionGaps(b: StageBundle): string[] {
  const gaps: string[] = [];
  const i = b.inspection;
  if (!i) {
    gaps.push('Inspection form not started');
    return gaps;
  }
  if (!i.inspectionDate || !i.timeWindow) gaps.push('Inspection date & time window not set');
  if (i.crewConfirmed !== true) gaps.push('Crew not confirmed on site');
  if (i.result !== 'pass') gaps.push('Inspection not passed');
  if (!b.docCategories.has(DOC_CATEGORIES.inspectionSignoff)) {
    gaps.push('Inspection sign-off document not uploaded');
  }
  if (!i.ptoSubmittedDate) gaps.push('PTO not submitted to utility');
  if (!i.ptoIssuedDate || !b.docCategories.has(DOC_CATEGORIES.ptoLetter)) {
    gaps.push('PTO letter not on file');
  }
  if (i.handoffDone !== true) gaps.push('Customer handoff not done');
  return gaps;
}

/**
 * Missing items blocking the advance out of `stage`. Empty array = the green
 * button is enabled and a drag to the next column will be accepted.
 */
export function evaluateStage(stage: StageKey, bundle: StageBundle): string[] {
  switch (stage) {
    case 'survey':
      return surveyGaps(bundle);
    case 'design':
      return designGaps(bundle);
    case 'permits':
      return permitsGaps(bundle);
    case 'procurement':
      return procurementGaps(bundle);
    case 'install':
      return installGaps(bundle);
    case 'inspection_pto':
      return inspectionGaps(bundle);
  }
}
