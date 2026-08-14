/**
 * The report field library — metadata, not code ("Report builder" spec §9).
 * One registry describes every reportable field: key, label, category, data
 * type, the SQL expression behind it, which joins it needs, what you may do
 * with it, and its permission flag. The builder UI, the query generator and
 * the exporters all read from here, so adding a stage field later makes it
 * reportable without touching the report module.
 */

export type FieldType = 'text' | 'status' | 'date' | 'number' | 'currency' | 'boolean' | 'count';

export type CategoryKey =
  | 'project'
  | 'system'
  | 'survey'
  | 'design'
  | 'permit'
  | 'procurement'
  | 'install'
  | 'inspection'
  | 'complete'
  | 'commission'
  | 'computed';

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  project: 'Project & customer',
  system: 'System & financing',
  survey: 'Stage 1 · Site Survey',
  design: 'Stage 2 · Design',
  permit: 'Stage 3 · Permit',
  procurement: 'Stage 4 · Procurement',
  install: 'Stage 5 · Installation',
  inspection: 'Stage 6 · Inspection & PTO',
  complete: 'Stage 7 · Complete / Hold / Cancelled',
  commission: 'Commissions & leads',
  computed: 'Computed fields',
};

/** Join keys; the generator emits only the ones the chosen fields need. */
export type JoinKey =
  | 'clients' | 'dealers' | 'reps' | 'pm' | 'systemTypes' | 'moduleTypes' | 'inverterTypes'
  | 'batteryTypes' | 'financePartners' | 'financingCompanies' | 'cashFinancing'
  | 's1' | 's2' | 's3' | 's4' | 's5' | 's6' | 's7' | 'finance' | 'commission'
  | 'designer' | 'procurementMgr' | 'installMgr' | 'hold' | 'cancel' | 'jurisdictions'
  | 'stageSince';

/** SQL for each join, in the order they must appear. */
export const JOIN_SQL: Array<{ key: JoinKey; sql: string; after?: JoinKey }> = [
  { key: 'clients', sql: 'left join public.clients cl on cl.id = p.client_id' },
  { key: 'dealers', sql: 'left join public.dealers d on d.id = p.dealer_id' },
  { key: 'reps', sql: 'left join public.sales_reps sr on sr.id = p.sales_rep_id' },
  { key: 'pm', sql: 'left join public.profiles pmp on pmp.id = p.assigned_pm' },
  { key: 'jurisdictions', sql: 'left join public.jurisdictions j on j.id = p.jurisdiction_id' },
  { key: 'systemTypes', sql: 'left join public.system_types st on st.id = p.system_type_id' },
  { key: 'moduleTypes', sql: 'left join public.module_types mt on mt.id = p.module_type_id' },
  { key: 'inverterTypes', sql: 'left join public.inverter_types it on it.id = p.inverter_type_id' },
  { key: 'batteryTypes', sql: 'left join public.battery_types bt on bt.id = p.battery_type_id' },
  { key: 'financePartners', sql: 'left join public.finance_partners fp on fp.id = p.finance_partner_id' },
  { key: 'financingCompanies', sql: 'left join public.financing_companies fc on fc.id = p.financing_company_id' },
  { key: 'cashFinancing', sql: 'left join public.cash_financing_options cfo on cfo.id = p.cash_or_financing_id' },
  { key: 's1', sql: 'left join public.stage1_survey s1 on s1.project_id = p.id' },
  { key: 's2', sql: 'left join public.stage2_design s2 on s2.project_id = p.id' },
  { key: 's3', sql: 'left join public.stage3_permit s3 on s3.project_id = p.id' },
  { key: 's4', sql: 'left join public.stage4_procurement s4 on s4.project_id = p.id' },
  { key: 's5', sql: 'left join public.stage5_install s5 on s5.project_id = p.id' },
  { key: 's6', sql: 'left join public.stage6_inspection s6 on s6.project_id = p.id' },
  { key: 's7', sql: 'left join public.stage7_complete s7 on s7.project_id = p.id' },
  { key: 'finance', sql: 'left join public.finance_milestones fin on fin.project_id = p.id' },
  { key: 'commission', sql: 'left join public.commissions cm on cm.project_id = p.id' },
  { key: 'designer', sql: 'left join public.designers dz on dz.id = s2.designer_id', after: 's2' },
  { key: 'procurementMgr', sql: 'left join public.profiles pmgr on pmgr.id = s4.procurement_manager', after: 's4' },
  { key: 'installMgr', sql: 'left join public.profiles imgr on imgr.id = s5.install_manager', after: 's5' },
  { key: 'cancel', sql: 'left join public.project_cancellation pc on pc.project_id = p.id' },
  {
    key: 'hold',
    sql: `left join lateral (
            select h.reason, h.notes, h.hold_start_date, h.expected_resume_date,
                   h.resume_date, h.stage_held_from
            from public.project_holds h
            where h.project_id = p.id
            order by h.hold_start_date desc, h.id desc
            limit 1
          ) ph on true`,
  },
  {
    key: 'stageSince',
    sql: `left join lateral (
            select coalesce(max(e.changed_at), p.created_at) as since
            from public.project_stage_events e
            where e.project_id = p.id
          ) ss on true`,
  },
];

export interface ReportField {
  key: string;
  label: string;
  category: CategoryKey;
  type: FieldType;
  /** SQL expression (aliases refer to JOIN_SQL). */
  sql: string;
  needs?: JoinKey[];
  /** Group-by allowed (text/status/date/boolean). */
  groupable?: boolean;
  /** Summarise allowed (numbers and dates only, per the spec). */
  summarisable?: boolean;
  /** Filterable — everything except a few derived expressions. */
  filterable?: boolean;
  /** Free-text PM/revision/hold notes: needs the internal-notes permission. */
  internal?: boolean;
  /** Money and margin: admin + finance only unless granted. */
  financial?: boolean;
  /** Usable as the date-range anchor in Settings. */
  anchor?: boolean;
}

/** Shorthand builders keep the table below readable. */
const text = (
  key: string, label: string, category: CategoryKey, sql: string,
  extra: Partial<ReportField> = {}
): ReportField => ({ key, label, category, type: 'text', sql, groupable: true, filterable: true, ...extra });

const status = (
  key: string, label: string, category: CategoryKey, sql: string,
  extra: Partial<ReportField> = {}
): ReportField => ({ key, label, category, type: 'status', sql, groupable: true, filterable: true, ...extra });

const date = (
  key: string, label: string, category: CategoryKey, sql: string,
  extra: Partial<ReportField> = {}
): ReportField => ({ key, label, category, type: 'date', sql, groupable: true, filterable: true, summarisable: true, anchor: true, ...extra });

const num = (
  key: string, label: string, category: CategoryKey, sql: string,
  extra: Partial<ReportField> = {}
): ReportField => ({ key, label, category, type: 'number', sql, filterable: true, summarisable: true, ...extra });

const money = (
  key: string, label: string, category: CategoryKey, sql: string,
  extra: Partial<ReportField> = {}
): ReportField => ({ key, label, category, type: 'currency', sql, filterable: true, summarisable: true, ...extra });

const bool = (
  key: string, label: string, category: CategoryKey, sql: string,
  extra: Partial<ReportField> = {}
): ReportField => ({ key, label, category, type: 'boolean', sql, groupable: true, filterable: true, ...extra });

/** Days between two dates, null-safe — computed in the query, per spec §9. */
const daysBetween = (from: string, to: string) => `(${to})::date - (${from})::date`;

export const REPORT_FIELDS: ReportField[] = [
  // --- Project & customer ---------------------------------------------------
  text('project.code', 'Project ID', 'project', 'p.code'),
  text('customer.first', 'Customer first name', 'project', 'cl.first_name', { needs: ['clients'] }),
  text('customer.last', 'Customer last name', 'project', 'cl.last_name', { needs: ['clients'] }),
  text('customer.full', 'Customer full name', 'project', 'p.name'),
  text('customer.email', 'Customer email', 'project', 'cl.email', { needs: ['clients'], groupable: false }),
  text('customer.phone', 'Customer phone', 'project', 'cl.phone', { needs: ['clients'], groupable: false }),
  text('project.address', 'Site address', 'project', 'p.address', { groupable: false }),
  text('dealer.name', 'Dealer', 'project', 'd.name', { needs: ['dealers'] }),
  text('rep.name', 'Sales Rep Name', 'project', 'sr.name', { needs: ['reps'] }),
  text('rep.email', 'Sales Rep Email', 'project', 'sr.email', { needs: ['reps'], groupable: false }),
  text('pm.name', 'Assigned PM', 'project', "coalesce(pmp.full_name, pmp.email)", { needs: ['pm'] }),
  text('jurisdiction.name', 'Jurisdiction', 'project', 'j.name', { needs: ['jurisdictions'] }),
  money('project.contract_value', 'Contract total', 'project', 'p.contract_value', { financial: true }),
  date('project.created', 'Project created date', 'project', 'p.created_at'),
  status('project.stage', 'Current stage', 'project', 'p.stage::text'),
  status('project.status', 'Project status', 'project', 'p.status::text'),

  // --- System & financing ---------------------------------------------------
  text('system.type', 'System Type', 'system', 'st.name', { needs: ['systemTypes'] }),
  text('system.module', 'Module Type', 'system', 'mt.name', { needs: ['moduleTypes'] }),
  num('system.module_qty', 'Module Quantity', 'system', 'p.module_quantity'),
  text('system.inverter', 'Inverter Type', 'system', 'it.name', { needs: ['inverterTypes'] }),
  num('system.inverter_qty', 'Inverter Quantity', 'system', 'p.inverter_quantity'),
  text('system.battery', 'Battery Type', 'system', 'bt.name', { needs: ['batteryTypes'] }),
  num('system.battery_qty', 'Battery Quantity', 'system', 'p.battery_quantity'),
  num('system.size_kw', 'System size (kW)', 'system', 'p.system_size_kw'),
  text('finance.cash_or_financing', 'Cash or Financing', 'system', 'cfo.name', { needs: ['cashFinancing'] }),
  text('finance.company', 'Financing Company', 'system', 'fc.name', { needs: ['financingCompanies'] }),
  text('finance.partner', 'Finance partner', 'system', 'fp.name', { needs: ['financePartners'] }),
  text('finance.notes', 'Financing Notes', 'system', 'p.financing_notes', { groupable: false, internal: true }),

  // --- Stage 1 · Site Survey ------------------------------------------------
  status('s1.dp_status', 'Down Payment Status', 'survey', 's1.down_payment_status', { needs: ['s1'] }),
  date('s1.dp_requested', 'Down Payment Requested Date', 'survey', 's1.down_payment_requested_date', { needs: ['s1'] }),
  date('s1.dp_initiated', 'Down Payment Initiated Date', 'survey', 's1.down_payment_initiated_date', { needs: ['s1'] }),
  date('s1.dp_received', 'Down Payment Received Date', 'survey', 's1.down_payment_received_date', { needs: ['s1'] }),
  status('s1.m1_status', 'Cash M1 Payment Status', 'survey', 's1.cash_m1_status', { needs: ['s1'] }),
  date('s1.m1_requested', 'Cash M1 Requested Date', 'survey', 's1.cash_m1_requested_date', { needs: ['s1'] }),
  date('s1.m1_initiated', 'Cash M1 Initiated Date', 'survey', 's1.cash_m1_initiated_date', { needs: ['s1'] }),
  date('s1.m1_received', 'Cash M1 Received Date', 'survey', 's1.cash_m1_received_date', { needs: ['s1'] }),
  status('s1.survey_status', 'Site Survey Status', 'survey', 's1.survey_status', { needs: ['s1'] }),
  date('s1.survey_completed', 'Site Survey Completed Date', 'survey', 's1.survey_completed_date', { needs: ['s1'] }),
  num('s1.survey_days', 'Site Survey Days', 'survey', daysBetween('p.created_at', 's1.survey_completed_date'), { needs: ['s1'] }),
  text('s1.adders', 'Adders Details', 'survey', 's1.adders_details', { needs: ['s1'], groupable: false, internal: true }),
  bool('s1.drive', 'Drive Updated (S1)', 'survey', 's1.drive_updated', { needs: ['s1'] }),

  // --- Stage 2 · Design -----------------------------------------------------
  text('s2.designer', 'Designer', 'design', 'dz.display_name', { needs: ['s2', 'designer'] }),
  status('s2.design_status', 'Design Status', 'design', 's2.design_status', { needs: ['s2'] }),
  date('s2.requested', 'Design Requested Date', 'design', 's2.design_requested_date', { needs: ['s2'] }),
  date('s2.received', 'Designs Received Date', 'design', 's2.design_received_date', { needs: ['s2'] }),
  num('s2.design_days', 'Design Days', 'design', daysBetween('s2.design_requested_date', 's2.design_received_date'), { needs: ['s2'] }),
  date('s2.shading_report', 'Shading & Production Loss Report date', 'design', 's2.shading_report_date', { needs: ['s2'] }),
  text('s2.pm_notes', 'PM Notes (Design)', 'design', 's2.pm_notes', { needs: ['s2'], groupable: false, internal: true }),
  status('s2.stamps_status', 'Stamps Status', 'design', 's2.stamps_status', { needs: ['s2'] }),
  date('s2.stamps_requested', 'Stamps Requested Date', 'design', 's2.stamps_requested_date', { needs: ['s2'] }),
  date('s2.stamps_received', 'Stamps Received Date', 'design', 's2.stamps_received_date', { needs: ['s2'] }),
  bool('s2.drive', 'Drive Updated (S2)', 'design', 's2.drive_updated', { needs: ['s2'] }),

  // --- Stage 3 · Permit -----------------------------------------------------
  text('s3.required_permits', 'Required Permits', 'permit', "array_to_string(s3.required_permits, ', ')", { needs: ['s3'], groupable: false }),
  status('s3.permit_status', 'Permit Status', 'permit', 's3.permit_status', { needs: ['s3'] }),
  date('s3.permit_applied', 'Permit Applied Date', 'permit', 's3.permit_applied_date', { needs: ['s3'] }),
  date('s3.permit_received', 'Permit Received Date', 'permit', 's3.permit_received_date', { needs: ['s3'] }),
  num('s3.permit_days', 'Permit Days', 'permit', daysBetween('s3.permit_applied_date', 's3.permit_received_date'), { needs: ['s3'] }),
  text('s3.permit_pm_notes', 'Permit PM Notes', 'permit', 's3.permit_pm_notes', { needs: ['s3'], groupable: false, internal: true }),
  text('s3.permit_revision_notes', 'Permit Revision Notes', 'permit', 's3.permit_revision_notes', { needs: ['s3'], groupable: false, internal: true }),
  status('s3.ica_status', 'ICA Status', 'permit', 's3.ica_status', { needs: ['s3'] }),
  date('s3.ica_applied', 'ICA Applied Date', 'permit', 's3.ica_applied_date', { needs: ['s3'] }),
  date('s3.ica_received', 'ICA Received Date', 'permit', 's3.ica_received_date', { needs: ['s3'] }),
  num('s3.ica_days', 'ICA Days', 'permit', daysBetween('s3.ica_applied_date', 's3.ica_received_date'), { needs: ['s3'] }),
  text('s3.ica_pm_notes', 'ICA PM Notes', 'permit', 's3.ica_pm_notes', { needs: ['s3'], groupable: false, internal: true }),
  text('s3.ica_revision_notes', 'ICA Revision Notes', 'permit', 's3.ica_revision_notes', { needs: ['s3'], groupable: false, internal: true }),
  status('s3.hoa_status', 'HOA Status', 'permit', 's3.hoa_status', { needs: ['s3'] }),
  date('s3.hoa_applied', 'HOA Applied Date', 'permit', 's3.hoa_applied_date', { needs: ['s3'] }),
  date('s3.hoa_received', 'HOA Received Date', 'permit', 's3.hoa_received_date', { needs: ['s3'] }),
  num('s3.hoa_days', 'HOA Days', 'permit', daysBetween('s3.hoa_applied_date', 's3.hoa_received_date'), { needs: ['s3'] }),
  text('s3.hoa_revision_notes', 'HOA Revision Notes', 'permit', 's3.hoa_revision_notes', { needs: ['s3'], groupable: false, internal: true }),
  status('s3.m2_status', 'Cash M2 Payment Status', 'permit', 's3.cash_m2_status', { needs: ['s3'] }),
  date('s3.m2_requested', 'Cash M2 Requested Date', 'permit', 's3.cash_m2_requested_date', { needs: ['s3'] }),
  date('s3.m2_initiated', 'Cash M2 Initiated Date', 'permit', 's3.cash_m2_initiated_date', { needs: ['s3'] }),
  date('s3.m2_received', 'Cash M2 Received Date', 'permit', 's3.cash_m2_received_date', { needs: ['s3'] }),
  status('s3.ntp_status', 'HDM NTP Status', 'permit', 's3.hdm_ntp_status', { needs: ['s3'] }),
  date('s3.ntp_submitted', 'HDM NTP Submitted Date', 'permit', 's3.hdm_ntp_submitted_date', { needs: ['s3'] }),
  date('s3.ntp_approved', 'HDM NTP Approved Date', 'permit', 's3.hdm_ntp_approved_date', { needs: ['s3'] }),
  bool('s3.drive', 'Drive Updated (S3)', 'permit', 's3.drive_updated', { needs: ['s3'] }),

  // --- Stage 4 · Procurement ------------------------------------------------
  text('s4.manager', 'Procurement Manager', 'procurement', 'coalesce(pmgr.full_name, pmgr.email)', { needs: ['s4', 'procurementMgr'] }),
  status('s4.material_status', 'Material Status', 'procurement', 's4.material_status', { needs: ['s4'] }),
  date('s4.requested', 'Material Requested Date', 'procurement', 's4.material_requested_date', { needs: ['s4'] }),
  date('s4.delivered', 'Material Delivered Date', 'procurement', 's4.material_delivered_date', { needs: ['s4'] }),
  num('s4.material_days', 'Material Days', 'procurement', daysBetween('s4.material_requested_date', 's4.material_delivered_date'), { needs: ['s4'] }),
  text('s4.pm_notes', 'PM Notes (Procurement)', 'procurement', 's4.pm_notes', { needs: ['s4'], groupable: false, internal: true }),
  bool('s4.drive', 'Drive Updated (S4)', 'procurement', 's4.drive_updated', { needs: ['s4'] }),

  // --- Stage 5 · Installation -----------------------------------------------
  text('s5.manager', 'Install Manager', 'install', 'coalesce(imgr.full_name, imgr.email)', { needs: ['s5', 'installMgr'] }),
  status('s5.install_status', 'Installation Status', 'install', 's5.install_status', { needs: ['s5'] }),
  date('s5.requested', 'Install Requested Date', 'install', 's5.install_requested_date', { needs: ['s5'] }),
  date('s5.scheduled', 'Install Scheduled Date', 'install', 's5.install_scheduled_date', { needs: ['s5'] }),
  date('s5.completed', 'Install Completed Date', 'install', 's5.install_completed_date', { needs: ['s5'] }),
  num('s5.install_days', 'Installation Days', 'install', daysBetween('s5.install_requested_date', 's5.install_completed_date'), { needs: ['s5'] }),
  num('s5.pictures', 'Install Pictures (count)', 'install',
    `(select count(*) from public.documents dd where dd.project_id = p.id and dd.category = 'install_pictures')`,
    { type: 'count' }),
  status('s5.m3_status', 'Cash M3 Payment Status', 'install', 's5.cash_m3_status', { needs: ['s5'] }),
  date('s5.m3_requested', 'Cash M3 Requested Date', 'install', 's5.cash_m3_requested_date', { needs: ['s5'] }),
  date('s5.m3_initiated', 'Cash M3 Initiated Date', 'install', 's5.cash_m3_initiated_date', { needs: ['s5'] }),
  date('s5.m3_received', 'Cash M3 Received Date', 'install', 's5.cash_m3_received_date', { needs: ['s5'] }),
  status('fin.m1_status', 'Finance M1 Status', 'install', 'fin.m1_status', { needs: ['finance'] }),
  date('fin.m1_submitted', 'Finance M1 Submitted Date', 'install', 'fin.m1_submitted_date', { needs: ['finance'] }),
  date('fin.m1_approved', 'Finance M1 Approved Date', 'install', 'fin.m1_approved_date', { needs: ['finance'] }),
  bool('s5.drive', 'Drive Updated (S5)', 'install', 's5.drive_updated', { needs: ['s5'] }),

  // --- Stage 6 · Inspection & PTO -------------------------------------------
  status('s6.inspection_status', 'Inspection Status', 'inspection', 's6.inspection_status', { needs: ['s6'] }),
  text('s6.failed_notes', 'Inspection Failed Notes', 'inspection', 's6.inspection_failed_notes', { needs: ['s6'], groupable: false, internal: true }),
  date('s6.requested', 'Inspection Requested Date', 'inspection', 's6.inspection_requested_date', { needs: ['s6'] }),
  date('s6.completed', 'Inspection Completed Date', 'inspection', 's6.inspection_completed_date', { needs: ['s6'] }),
  num('s6.inspection_days', 'Inspection Days', 'inspection', daysBetween('s6.inspection_requested_date', 's6.inspection_completed_date'), { needs: ['s6'] }),
  text('s6.pm_notes', 'PM Notes (Inspection)', 'inspection', 's6.pm_notes', { needs: ['s6'], groupable: false, internal: true }),
  status('s6.pto_status', 'PTO Status', 'inspection', 's6.pto_status', { needs: ['s6'] }),
  date('s6.pto_applied', 'PTO Applied Date', 'inspection', 's6.pto_applied_date', { needs: ['s6'] }),
  date('s6.pto_received', 'PTO Received Date', 'inspection', 's6.pto_received_date', { needs: ['s6'] }),
  num('s6.pto_days', 'PTO Days', 'inspection', daysBetween('s6.pto_applied_date', 's6.pto_received_date'), { needs: ['s6'] }),
  status('s6.energization_status', 'Energization Status', 'inspection', 's6.energization_status', { needs: ['s6'] }),
  date('s6.energization_date', 'Energization Date', 'inspection', 's6.energization_date', { needs: ['s6'] }),
  status('fin.m2_status', 'Finance M2 Status', 'inspection', 'fin.m2_status', { needs: ['finance'] }),
  date('fin.m2_submitted', 'Finance M2 Submitted Date', 'inspection', 'fin.m2_submitted_date', { needs: ['finance'] }),
  date('fin.m2_approved', 'Finance M2 Approved Date', 'inspection', 'fin.m2_approved_date', { needs: ['finance'] }),
  bool('s6.drive', 'Drive Updated (S6)', 'inspection', 's6.drive_updated', { needs: ['s6'] }),

  // --- Stage 7 · Complete / Hold / Cancelled --------------------------------
  status('s7.completion_status', 'Project Completion Status', 'complete', 's7.completion_status', { needs: ['s7'] }),
  date('s7.completion_date', 'Project Completion Date', 'complete', 's7.completion_date', { needs: ['s7'] }),
  num('s7.total_days', 'Total Project Days', 'complete', daysBetween('p.created_at', 's7.completion_date'), { needs: ['s7'] }),
  text('s7.notes', 'Completion PM Notes', 'complete', 's7.completion_notes', { needs: ['s7'], groupable: false, internal: true }),
  bool('s7.final_drive', 'Final Drive Updated', 'complete', 's7.final_drive_updated', { needs: ['s7'] }),
  status('hold.reason', 'Hold Reason', 'complete', 'ph.reason', { needs: ['hold'] }),
  text('hold.notes', 'Hold Notes', 'complete', 'ph.notes', { needs: ['hold'], groupable: false, internal: true }),
  date('hold.start', 'Hold Start Date', 'complete', 'ph.hold_start_date', { needs: ['hold'] }),
  date('hold.expected_resume', 'Expected Resume Date', 'complete', 'ph.expected_resume_date', { needs: ['hold'] }),
  date('hold.resume', 'Resume Date', 'complete', 'ph.resume_date', { needs: ['hold'] }),
  status('hold.stage_from', 'Stage Held From', 'complete', 'ph.stage_held_from::text', { needs: ['hold'] }),
  num('hold.days', 'Hold Days', 'complete',
    `(select coalesce(sum(coalesce(h.resume_date, current_date) - h.hold_start_date), 0)
      from public.project_holds h where h.project_id = p.id)`),
  status('cancel.reason', 'Cancellation Reason', 'complete', 'pc.reason', { needs: ['cancel'] }),
  text('cancel.notes', 'Cancellation Notes', 'complete', 'pc.notes', { needs: ['cancel'], groupable: false, internal: true }),
  date('cancel.date', 'Cancellation Date', 'complete', 'pc.cancellation_date', { needs: ['cancel'] }),
  status('cancel.stage_from', 'Stage Cancelled From', 'complete', 'pc.stage_cancelled_from::text', { needs: ['cancel'] }),
  bool('cancel.refund_required', 'Refund Required', 'complete', 'pc.refund_required', { needs: ['cancel'] }),
  status('cancel.refund_status', 'Refund Status', 'complete', 'pc.refund_status', { needs: ['cancel'] }),
  money('cancel.refund_amount', 'Refund Amount', 'complete', 'pc.refund_amount', { needs: ['cancel'], financial: true }),
  bool('cancel.equipment_return', 'Equipment Return Required', 'complete', 'pc.equipment_return_required', { needs: ['cancel'] }),

  // --- Commissions & leads --------------------------------------------------
  money('cm.base', 'Base commission', 'commission', 'cm.base_amount', { needs: ['commission'], financial: true }),
  money('cm.adjustment', 'Commission adjustment', 'commission', 'cm.adjustment', { needs: ['commission'], financial: true }),
  money('cm.total', 'Total commission', 'commission', '(cm.base_amount + cm.adjustment)', { needs: ['commission'], financial: true }),
  status('cm.status', 'Commission status', 'commission', 'cm.status', { needs: ['commission'], financial: true }),
  date('cm.payable_date', 'Commission payable date', 'commission', 'cm.payable_date', { needs: ['commission'], financial: true }),
  date('cm.paid_date', 'Commission paid date', 'commission', 'cm.paid_date', { needs: ['commission'], financial: true }),
  status('lead.status', 'Lead status', 'commission',
    `(select l.status from public.leads l where l.converted_project_id = p.id limit 1)`),
  date('lead.submitted', 'Lead submitted date', 'commission',
    `(select l.created_at from public.leads l where l.converted_project_id = p.id limit 1)`),
  date('lead.converted', 'Lead converted date', 'commission',
    `(select l.updated_at from public.leads l where l.converted_project_id = p.id
      and l.status = 'converted' limit 1)`),

  // --- Computed (system-derived) --------------------------------------------
  num('calc.days_in_stage', 'Days in current stage', 'computed',
    `(current_date - ss.since::date)`, { needs: ['stageSince'] }),
  num('calc.total_days', 'Total days to date', 'computed', '(current_date - p.created_at::date)'),
  num('calc.survey_to_pto', 'Days survey → PTO', 'computed',
    daysBetween('s1.survey_completed_date', 's6.pto_received_date'), { needs: ['s1', 's6'] }),
  num('calc.days_excl_hold', 'Days excluding hold', 'computed',
    `((current_date - p.created_at::date)
      - (select coalesce(sum(coalesce(h.resume_date, current_date) - h.hold_start_date), 0)
         from public.project_holds h where h.project_id = p.id))`),
  bool('calc.is_overdue', 'Is overdue (>21 days in stage)', 'computed',
    `((current_date - ss.since::date) > 21 and p.status = 'active')`, { needs: ['stageSince'] }),
  status('calc.age_bucket', 'Age bucket', 'computed',
    `(case
        when (current_date - ss.since::date) <= 30 then '0–30'
        when (current_date - ss.since::date) <= 60 then '31–60'
        when (current_date - ss.since::date) <= 90 then '61–90'
        else '90+' end)`, { needs: ['stageSince'] }),
  num('calc.milestones_outstanding', 'Milestones outstanding (count)', 'computed',
    `((case when coalesce(s1.down_payment_status, 'not_requested') <> 'received' then 1 else 0 end)
      + (case when coalesce(s1.cash_m1_status, 'not_requested') not in ('received', 'na') then 1 else 0 end)
      + (case when coalesce(s3.cash_m2_status, 'not_requested') not in ('received', 'na') then 1 else 0 end)
      + (case when coalesce(s5.cash_m3_status, 'not_requested') not in ('received', 'na') then 1 else 0 end)
      + (case when coalesce(fin.m1_status, 'not_submitted') not in ('approved', 'na') then 1 else 0 end)
      + (case when coalesce(fin.m2_status, 'not_submitted') not in ('approved', 'na') then 1 else 0 end))`,
    { needs: ['s1', 's3', 's5', 'finance'], type: 'count' }),
  num('calc.documents', 'Documents uploaded (count)', 'computed',
    `(select count(*) from public.documents dd where dd.project_id = p.id)`, { type: 'count' }),
  date('calc.stage_entered', 'Current stage entered date', 'computed', 'ss.since', { needs: ['stageSince'] }),
];

export const FIELD_BY_KEY: Map<string, ReportField> = new Map(REPORT_FIELDS.map((f) => [f.key, f]));

/** Per-stage entered/exited dates, generated so a stage form change needs no
 *  report-module change (spec §3 'Stage entered/exited date (per stage)'). */
const STAGE_KEYS = ['survey', 'design', 'permits', 'procurement', 'install', 'inspection_pto', 'complete'] as const;
const STAGE_NAMES: Record<string, string> = {
  survey: 'Survey', design: 'Design', permits: 'Permit', procurement: 'Procurement',
  install: 'Installation', inspection_pto: 'Inspection & PTO', complete: 'Complete',
};
for (const stage of STAGE_KEYS) {
  const entered: ReportField = {
    key: `calc.entered.${stage}`,
    label: `${STAGE_NAMES[stage]} entered date`,
    category: 'computed',
    type: 'date',
    sql: `(select min(e.changed_at)::date from public.project_stage_events e
           where e.project_id = p.id and e.to_stage = '${stage}')`,
    groupable: true, filterable: true, summarisable: true, anchor: true,
  };
  const exited: ReportField = {
    key: `calc.exited.${stage}`,
    label: `${STAGE_NAMES[stage]} exited date`,
    category: 'computed',
    type: 'date',
    sql: `(select min(e.changed_at)::date from public.project_stage_events e
           where e.project_id = p.id and e.from_stage = '${stage}')`,
    groupable: true, filterable: true, summarisable: true, anchor: true,
  };
  REPORT_FIELDS.push(entered, exited);
  FIELD_BY_KEY.set(entered.key, entered);
  FIELD_BY_KEY.set(exited.key, exited);
}

/** Fields this session may use: financial fields need admin/finance, internal
 *  notes need the report's includeInternalNotes flag AND a staff role. */
export function visibleFields(
  role: string,
  includeInternalNotes: boolean
): ReportField[] {
  const canSeeMoney = role === 'admin' || role === 'finance';
  const canSeeNotes = includeInternalNotes && ['admin', 'ops'].includes(role);
  return REPORT_FIELDS.filter(
    (f) => (!f.financial || canSeeMoney) && (!f.internal || canSeeNotes)
  );
}

export const AGGREGATIONS = ['count', 'sum', 'avg', 'min', 'max', 'median'] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

/** Which aggregations make sense for a field's type. */
export function allowedAggregations(field: ReportField): Aggregation[] {
  if (field.type === 'number' || field.type === 'currency' || field.type === 'count') {
    return ['count', 'sum', 'avg', 'min', 'max', 'median'];
  }
  if (field.type === 'date') return ['count', 'min', 'max'];
  return ['count'];
}
