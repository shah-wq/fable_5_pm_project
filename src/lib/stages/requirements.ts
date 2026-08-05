import type { StageKey } from './definitions.ts';

/**
 * The advance gates from the Stage Field Specification, as pure functions
 * over a loaded StageBundle. This stays the ONE validation path: the green
 * advance button, the Kanban drag-and-drop, and the missing-items badges all
 * call evaluateStage(). Conditional requirements are live: a 'Cond.' field
 * becomes required the moment its governing status is set.
 */

export type StageRow = Record<string, unknown> | null;

export interface StageBundle {
  financePartnerId: string | null;
  survey: StageRow;
  design: StageRow;
  permits: StageRow;
  procurement: StageRow;
  install: StageRow;
  inspection: StageRow;
  finance: StageRow;
  /** Distinct documents.category values present on the project. */
  docCategories: Set<string>;
}

const val = (row: StageRow, field: string): unknown => (row ? row[field] : undefined);
const eq = (row: StageRow, field: string, expected: string): boolean =>
  val(row, field) === expected;
const has = (row: StageRow, field: string): boolean => {
  const v = val(row, field);
  return v !== null && v !== undefined && v !== '' && v !== false;
};

/** Payment milestone (Down Payment, Cash M1–M3): Received with its date, or N/A. */
function paymentGaps(row: StageRow, prefix: string, label: string, allowNa: boolean): string[] {
  const status = val(row, `${prefix}_status`);
  if (allowNa && status === 'na') return [];
  if (status !== 'received') {
    return [`${label} not ${allowNa ? 'resolved (Received or N/A)' : 'received'}`];
  }
  return has(row, `${prefix}_received_date`) ? [] : [`${label} received date missing`];
}

/** Approval milestone (Stamps, HDM NTP, Finance M1/M2): terminal status + date, or N/A. */
function approvalGaps(
  row: StageRow,
  statusField: string,
  dateField: string,
  terminal: string,
  label: string
): string[] {
  const status = val(row, statusField);
  if (status === 'na') return [];
  if (status !== terminal) return [`${label} not ${terminal} (or N/A)`];
  return has(row, dateField) ? [] : [`${label} ${terminal} date missing`];
}

function driveGap(row: StageRow): string[] {
  return val(row, 'drive_updated') === true ? [] : ['Drive Updated not toggled'];
}

function surveyGaps(b: StageBundle): string[] {
  const s = b.survey;
  if (!s) return ['Survey form not started'];
  return [
    ...paymentGaps(s, 'down_payment', 'Down Payment', false),
    ...paymentGaps(s, 'cash_m1', 'Cash M1', true),
    ...(eq(s, 'survey_status', 'completed')
      ? has(s, 'survey_completed_date')
        ? []
        : ['Site Survey completed date missing']
      : ['Site Survey not marked Completed']),
    ...driveGap(s),
  ];
}

function designGaps(b: StageBundle): string[] {
  const d = b.design;
  if (!d) return ['Design form not started'];
  const gaps: string[] = [];
  if (!has(d, 'designer_id')) gaps.push('No designer assigned');
  if (!eq(d, 'design_status', 'received')) gaps.push('Design Status not Received');
  else {
    if (!has(d, 'design_requested_date')) gaps.push('Design requested date missing');
    if (!has(d, 'design_received_date')) gaps.push('Designs received date missing');
  }
  gaps.push(...approvalGaps(d, 'stamps_status', 'stamps_received_date', 'received', 'Stamps'));
  gaps.push(...driveGap(d));
  return gaps;
}

/** Permit/ICA/HOA track: Approved with applied + received dates (HOA may be N/A). */
function permitTrackGaps(row: StageRow, prefix: string, label: string, allowNa: boolean): string[] {
  const status = val(row, `${prefix}_status`);
  if (allowNa && status === 'na') return [];
  if (status !== 'approved') return [`${label} not Approved${allowNa ? ' (or N/A)' : ''}`];
  const gaps: string[] = [];
  if (!has(row, `${prefix}_applied_date`)) gaps.push(`${label} applied date missing`);
  if (!has(row, `${prefix}_received_date`)) gaps.push(`${label} received date missing`);
  return gaps;
}

function permitsGaps(b: StageBundle): string[] {
  const p = b.permits;
  if (!p) return ['Permit form not started'];
  return [
    ...permitTrackGaps(p, 'permit', 'Building permit', false),
    ...permitTrackGaps(p, 'ica', 'ICA', false),
    ...permitTrackGaps(p, 'hoa', 'HOA', true),
    ...paymentGaps(p, 'cash_m2', 'Cash M2', true),
    ...approvalGaps(p, 'hdm_ntp_status', 'hdm_ntp_approved_date', 'approved', 'HDM NTP'),
    ...driveGap(p),
  ];
}

function procurementGaps(b: StageBundle): string[] {
  const p = b.procurement;
  if (!p) return ['Procurement form not started'];
  const gaps: string[] = [];
  if (!has(p, 'procurement_manager')) gaps.push('No procurement manager assigned');
  if (!eq(p, 'material_status', 'delivered')) gaps.push('Material Status not Delivered');
  else {
    if (!has(p, 'material_requested_date')) gaps.push('Material requested date missing');
    if (!has(p, 'material_delivered_date')) gaps.push('Material delivered date missing');
  }
  gaps.push(...driveGap(p));
  return gaps;
}

function installGaps(b: StageBundle): string[] {
  const i = b.install;
  if (!i) return ['Installation form not started'];
  const gaps: string[] = [];
  if (!has(i, 'install_manager')) gaps.push('No install manager assigned');
  if (!eq(i, 'install_status', 'completed')) gaps.push('Installation Status not Completed');
  else {
    if (!has(i, 'install_requested_date')) gaps.push('Install requested date missing');
    if (!has(i, 'install_scheduled_date')) gaps.push('Install scheduled date missing');
    if (!has(i, 'install_completed_date')) gaps.push('Install completed date missing');
  }
  if (!b.docCategories.has('install_pictures')) gaps.push('Install pictures not uploaded');
  gaps.push(...paymentGaps(i, 'cash_m3', 'Cash M3', true));
  gaps.push(
    ...approvalGaps(b.finance, 'm1_status', 'm1_approved_date', 'approved', 'Finance M1')
  );
  gaps.push(...driveGap(i));
  return gaps;
}

function inspectionGaps(b: StageBundle): string[] {
  const q = b.inspection;
  if (!q) return ['Inspection & PTO form not started'];
  const gaps: string[] = [];
  if (!eq(q, 'inspection_status', 'passed')) gaps.push('Inspection not Passed');
  else {
    if (!has(q, 'inspection_requested_date')) gaps.push('Inspection requested date missing');
    if (!has(q, 'inspection_completed_date')) gaps.push('Inspection completed date missing');
  }
  gaps.push(
    ...approvalGaps(b.finance, 'm1_status', 'm1_approved_date', 'approved', 'Finance M1')
  );
  if (!eq(q, 'pto_status', 'received')) gaps.push('PTO Status not Received');
  else {
    if (!has(q, 'pto_applied_date')) gaps.push('PTO applied date missing');
    if (!has(q, 'pto_received_date')) gaps.push('PTO received date missing');
  }
  if (!eq(q, 'energization_status', 'energized')) gaps.push('System not Energized');
  else if (!has(q, 'energization_date')) gaps.push('Energization date missing');
  gaps.push(
    ...approvalGaps(b.finance, 'm2_status', 'm2_approved_date', 'approved', 'Finance M2')
  );
  gaps.push(...driveGap(q));
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
    case 'complete':
      return []; // terminal stage — no advance
  }
}
