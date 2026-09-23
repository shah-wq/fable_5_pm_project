import type { StageKey } from './definitions';

/**
 * The Stage Field Specification, as data. One definition drives three things:
 * the form renderer (StageForm), the persistence allowlist
 * (/api/projects/[id]/stages/[stage]), and the day counters. The requirements
 * engine (requirements.ts) encodes the advance gates over the same columns.
 *
 * Conventions from the spec:
 *  - status dropdowns auto-stamp their matching date when switched (always
 *    editable afterwards) — `stamp` maps status value → date field;
 *  - 'Days' fields are computed from dates, never stored;
 *  - N/A is a first-class status and satisfies the advance checks;
 *  - each stage closes on its attachments — the documents that prove it
 *    happened — uploaded here, rather than on a "Drive Updated" tick that
 *    only claimed they had been filed somewhere else.
 */

export type StageFieldType =
  | 'select'
  | 'date'
  | 'text'
  | 'textarea'
  | 'toggle'
  | 'number'
  | 'permits'
  | 'refselect'
  | 'upload';

export interface StageField {
  name: string;
  label: string;
  type: StageFieldType;
  /** Which table the column lives in (default: the stage's own table). */
  table?: 'stage' | 'finance' | 'project';
  options?: readonly string[];
  optionsKey?: 'designers' | 'staff' | 'financePartners';
  /** Numbers only: shown after the box (kW, A, ft, $). */
  unit?: string;
  /** true = always required; 'cond' = required per the governing status. */
  required?: boolean | 'cond';
  /** status value → date field to auto-stamp with today when selected. */
  stamp?: Record<string, string>;
  /** Uploads only: photos, PDFs, or either (a permit can be a scan or a PDF). */
  accept?: 'photos' | 'pdf' | 'any';
  multiple?: boolean;
  note?: string;
  /**
   * Uploads only: not required when this stage field holds this value — an
   * HOA approval is not needed on a property whose HOA status is N/A.
   */
  requiredUnless?: { field: string; value: string };
}

export interface StageCard {
  key: string;
  title: string;
  statusField?: string;
  /** Computed day counter: from → to (or project start → to). */
  days?: { from?: string; to: string; label: string };
  fields: StageField[];
}

export const STATUS_LABELS: Record<string, string> = {
  na: 'N/A',
  not_requested: 'Not requested',
  requested: 'Requested',
  initiated: 'Initiated',
  received: 'Received',
  not_scheduled: 'Not scheduled',
  scheduled: 'Scheduled',
  completed: 'Completed',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
  in_progress: 'In progress',
  revision_requested: 'Revision requested',
  not_applied: 'Not applied',
  applied: 'Applied',
  in_review: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
  not_submitted: 'Not submitted',
  submitted: 'Submitted',
  ordered: 'Ordered',
  in_transit: 'In transit',
  delivered: 'Delivered',
  backordered: 'Backordered',
  on_hold: 'On hold',
  passed: 'Passed',
  failed: 'Failed',
  reinspection_scheduled: 'Re-inspection scheduled',
  not_started: 'Not started',
  energized: 'Energized',
  issue: 'Issue',
  // Site and paperwork facts (004600)
  comp_shingle: 'Composition shingle',
  tile: 'Tile',
  metal: 'Metal',
  flat: 'Flat / low slope',
  wood_shake: 'Wood shake',
  other: 'Other',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  replace_first: 'Replace before install',
  yes: 'Yes',
  no: 'No',
  tbd: 'To be decided',
  limited: 'Limited',
  portal: 'Online portal',
  email: 'Email',
  in_person: 'In person',
  solarapp: 'SolarAPP+',
  vendor: 'At the vendor',
  warehouse: 'In our warehouse',
  site: 'On site',
  enphase: 'Enphase',
  solaredge: 'SolarEdge',
  tesla: 'Tesla',
  generac: 'Generac',
};

/** Shorthand for the optional fact fields added in 004600. */
const sel = (name: string, label: string, options: readonly string[], extra: Partial<StageField> = {}): StageField =>
  ({ name, label, type: 'select', options, ...extra });
const num = (name: string, label: string, unit?: string, extra: Partial<StageField> = {}): StageField =>
  ({ name, label, type: 'number', unit, ...extra });
const txt = (name: string, label: string, extra: Partial<StageField> = {}): StageField =>
  ({ name, label, type: 'text', ...extra });
const dt = (name: string, label: string, extra: Partial<StageField> = {}): StageField =>
  ({ name, label, type: 'date', ...extra });

export const PAYMENT_STATUSES = ['not_requested', 'requested', 'initiated', 'received'] as const;
export const PAYMENT_STATUSES_NA = [...PAYMENT_STATUSES, 'na'] as const;
const PERMIT_TRACK_STATUSES = [
  'not_applied', 'applied', 'in_review', 'revision_requested', 'approved', 'rejected',
] as const;
export const FINANCE_STATUSES = ['not_submitted', 'submitted', 'approved', 'rejected', 'na'] as const;

/** Builds a payment-milestone card (Down Payment, Cash M1/M2/M3). */
function paymentCard(key: string, title: string, prefix: string, allowNa: boolean): StageCard {
  return {
    key,
    title,
    statusField: `${prefix}_status`,
    fields: [
      {
        name: `${prefix}_status`,
        label: 'Status',
        type: 'select',
        options: allowNa ? PAYMENT_STATUSES_NA : PAYMENT_STATUSES,
        required: true,
        stamp: {
          requested: `${prefix}_requested_date`,
          initiated: `${prefix}_initiated_date`,
          received: `${prefix}_received_date`,
        },
      },
      { name: `${prefix}_requested_date`, label: 'Requested date', type: 'date' },
      { name: `${prefix}_initiated_date`, label: 'Initiated date', type: 'date' },
      {
        name: `${prefix}_received_date`,
        label: 'Received date',
        type: 'date',
        required: 'cond',
        note: allowNa ? 'Required unless status is N/A' : 'Required before the stage can close',
      },
    ],
  };
}

/**
 * The attachments that close each stage, in place of the old "Drive Updated"
 * tick. A tick said the documents had been filed in a shared drive; an
 * attachment is the document itself, on the project, where the PM, the
 * reports and later automation can all see it. Each upload lands in the
 * project's documents under the field's name as its category, hidden from the
 * homeowner unless someone shares it.
 *
 * `required` ones gate the advance out of the stage; the rest are there so the
 * paperwork has one home.
 */
const attach = (
  name: string,
  label: string,
  accept: StageField['accept'],
  required: boolean,
  extra: Partial<StageField> = {}
): StageField => ({ name, label, type: 'upload', accept, multiple: true, required, ...extra });

export const STAGE_ATTACHMENTS: Record<StageKey, StageField[]> = {
  survey: [
    attach('survey_photos', 'Site survey photos', 'photos', true, {
      note: 'Roof planes, attic, main panel (cover off), meter, service entrance',
    }),
    attach('survey_report', 'Survey report', 'any', false),
  ],
  design: [
    attach('plan_set', 'Plan set', 'pdf', true),
    attach('stamped_plans', 'Stamped plans', 'pdf', false),
  ],
  permits: [
    attach('permit_approval', 'Building permit approval', 'any', true),
    attach('ica_approval', 'Interconnection (ICA) approval', 'any', true),
    attach('hoa_approval', 'HOA approval', 'any', true, {
      requiredUnless: { field: 'hoa_status', value: 'na' },
      note: 'Not needed when HOA is N/A',
    }),
    attach('ntp_approval', 'HDM NTP approval', 'any', false),
  ],
  procurement: [
    attach('delivery_confirmation', 'Delivery confirmation / packing slip', 'any', true),
    attach('purchase_order', 'Purchase order / invoice', 'any', false),
  ],
  install: [attach('install_signoff', 'Installation sign-off / checklist', 'any', false)],
  inspection_pto: [
    attach('inspection_report', 'Inspection report / pass card', 'any', true),
    attach('pto_letter', 'PTO letter', 'any', true),
    attach('monitoring_activation', 'Monitoring activation', 'photos', false),
  ],
  complete: [attach('final_documents', 'Completion certificate / final documents', 'any', false)],
};

const attachmentsCard = (stage: StageKey): StageCard => ({
  key: 'attachments',
  title: 'Attachments',
  fields: STAGE_ATTACHMENTS[stage],
});

const financeM1Card: StageCard = {
  key: 'finance_m1',
  title: 'Finance M1',
  statusField: 'm1_status',
  fields: [
    {
      name: 'finance_partner_id',
      label: 'Finance partner',
      type: 'refselect',
      optionsKey: 'financePartners',
      table: 'project',
      required: true,
      note: 'Sets the label on the milestone fields (N/A = cash deal)',
    },
    {
      name: 'm1_status',
      label: 'M1 status',
      type: 'select',
      table: 'finance',
      options: FINANCE_STATUSES,
      required: true,
      stamp: { submitted: 'm1_submitted_date', approved: 'm1_approved_date' },
    },
    { name: 'm1_submitted_date', label: 'M1 submitted date', type: 'date', table: 'finance' },
    {
      name: 'm1_approved_date',
      label: 'M1 approved date',
      type: 'date',
      table: 'finance',
      required: 'cond',
      note: 'Required if status is not N/A',
    },
  ],
};

const financeM2Card: StageCard = {
  key: 'finance_m2',
  title: 'Finance M2',
  statusField: 'm2_status',
  fields: [
    {
      name: 'm2_status',
      label: 'M2 status',
      type: 'select',
      table: 'finance',
      options: FINANCE_STATUSES,
      required: true,
      stamp: { submitted: 'm2_submitted_date', approved: 'm2_approved_date' },
    },
    { name: 'm2_submitted_date', label: 'M2 submitted date', type: 'date', table: 'finance' },
    {
      name: 'm2_approved_date',
      label: 'M2 approved date',
      type: 'date',
      table: 'finance',
      required: 'cond',
      note: 'Required if status is not N/A',
    },
  ],
};

export const STAGE_FORMS: Record<StageKey, StageCard[]> = {
  survey: [
    paymentCard('down_payment', 'Down payment', 'down_payment', false),
    paymentCard('cash_m1', 'Cash M1 milestone', 'cash_m1', true),
    {
      key: 'survey',
      title: 'Survey',
      statusField: 'survey_status',
      days: { to: 'survey_completed_date', label: 'Site Survey Days' },
      fields: [
        {
          name: 'survey_status',
          label: 'Site Survey Status',
          type: 'select',
          options: ['not_scheduled', 'scheduled', 'completed', 'rescheduled', 'cancelled'],
          required: true,
          stamp: { scheduled: 'survey_scheduled_date', completed: 'survey_completed_date' },
        },
        { name: 'surveyor_id', label: 'Surveyor', type: 'refselect', optionsKey: 'staff' },
        dt('survey_scheduled_date', 'Site Survey Scheduled Date'),
        {
          name: 'survey_completed_date',
          label: 'Site Survey Completed Date',
          type: 'date',
          required: 'cond',
        },
        {
          name: 'adders_details',
          label: 'Adders Details',
          type: 'textarea',
          note: 'Adder description + price lines',
        },
      ],
    },
    {
      key: 'site',
      title: 'Site facts',
      fields: [
        sel('roof_type', 'Roof type', ['comp_shingle', 'tile', 'metal', 'flat', 'wood_shake', 'other']),
        num('roof_age_years', 'Roof age', 'years'),
        sel('roof_condition', 'Roof condition', ['good', 'fair', 'poor', 'replace_first']),
        num('stories', 'Stories'),
        txt('roof_pitch', 'Roof pitch', { note: 'e.g. 5/12' }),
        num('main_panel_rating_amps', 'Main panel rating', 'A'),
        num('bus_bar_rating_amps', 'Bus bar rating', 'A'),
        num('main_breaker_amps', 'Main breaker', 'A'),
        sel('panel_upgrade_needed', 'Main panel upgrade needed?', ['yes', 'no', 'tbd'], {
          note: 'The 120% rule: bus rating × 1.2 − main breaker is the room for solar',
        }),
        txt('meter_number', 'Meter number'),
        txt('utility_account_number', 'Utility account number'),
        sel('attic_access', 'Attic access', ['yes', 'no', 'limited']),
        num('trenching_distance_ft', 'Trenching distance', 'ft'),
        { name: 'shading_notes', label: 'Shading notes', type: 'textarea' },
        { name: 'site_notes', label: 'Site notes', type: 'textarea', note: 'Access, pets, gate codes, hazards' },
      ],
    },
    attachmentsCard('survey'),
  ],

  design: [
    {
      key: 'design',
      title: 'Design',
      statusField: 'design_status',
      days: { from: 'design_requested_date', to: 'design_received_date', label: 'Design Days' },
      fields: [
        {
          name: 'designer_id',
          label: 'Designer',
          type: 'refselect',
          optionsKey: 'designers',
          required: true,
        },
        {
          name: 'design_status',
          label: 'Design Status',
          type: 'select',
          options: ['not_requested', 'requested', 'in_progress', 'received', 'revision_requested'],
          required: true,
          stamp: { requested: 'design_requested_date', received: 'design_received_date' },
        },
        { name: 'design_requested_date', label: 'Design Requested Date', type: 'date', required: true },
        { name: 'design_received_date', label: 'Designs Received Date', type: 'date', required: true },
        {
          name: 'shading_report',
          label: 'LightReach Shading & Monthly Production Loss Report',
          type: 'upload',
          accept: 'pdf',
        },
        { name: 'shading_report_date', label: 'Shading report received date', type: 'date' },
        { name: 'pm_notes', label: 'PM Notes', type: 'textarea' },
      ],
    },
    {
      key: 'design_output',
      title: 'Design output',
      fields: [
        num('final_system_size_kw', 'Final system size', 'kW DC'),
        num('final_module_count', 'Final module count'),
        num('production_estimate_kwh', 'Year-1 production estimate', 'kWh'),
        num('offset_percent', 'Usage offset', '%'),
        num('design_revision', 'Design revision'),
        dt('customer_approval_date', 'Customer approved design on'),
        txt('design_tool_url', 'Design tool link', { note: 'Aurora / OpenSolar project' }),
        txt('engineering_firm', 'Engineering firm'),
        sel('pe_stamp_required', 'PE stamp required?', ['yes', 'no', 'tbd']),
      ],
    },
    {
      key: 'stamps',
      title: 'Stamps',
      statusField: 'stamps_status',
      fields: [
        {
          name: 'stamps_status',
          label: 'Stamps Status',
          type: 'select',
          options: ['not_requested', 'requested', 'received', 'na'],
          required: true,
          stamp: { requested: 'stamps_requested_date', received: 'stamps_received_date' },
        },
        { name: 'stamps_requested_date', label: 'Stamps Requested Date', type: 'date' },
        {
          name: 'stamps_received_date',
          label: 'Stamps Received Date',
          type: 'date',
          required: 'cond',
          note: 'Required if status is not N/A',
        },
      ],
    },
    attachmentsCard('design'),
  ],

  permits: [
    {
      key: 'permit',
      title: 'Building permit',
      statusField: 'permit_status',
      days: { from: 'permit_applied_date', to: 'permit_received_date', label: 'Permit Days' },
      fields: [
        {
          name: 'required_permits',
          label: 'Required Permits',
          type: 'permits',
          required: true,
          note: 'Which permits this jurisdiction requires',
        },
        {
          name: 'permit_status',
          label: 'Permit Status',
          type: 'select',
          options: PERMIT_TRACK_STATUSES,
          required: true,
          stamp: { applied: 'permit_applied_date', approved: 'permit_received_date' },
        },
        { name: 'permit_applied_date', label: 'Permit Applied Date', type: 'date', required: true },
        { name: 'permit_received_date', label: 'Permit Received Date', type: 'date', required: true },
        txt('permit_number', 'Permit number'),
        dt('permit_expiry_date', 'Permit expires on', { note: 'You are warned 14 days before' }),
        num('permit_fee', 'Permit fee', '$'),
        sel('permit_submission_method', 'Submitted via', ['portal', 'email', 'in_person', 'solarapp']),
        { name: 'permit_pm_notes', label: 'Permit PM Notes', type: 'textarea' },
        {
          name: 'permit_revision_notes',
          label: 'Permit Revision Notes',
          type: 'textarea',
          note: 'Correction items received from the AHJ and what was resubmitted',
        },
      ],
    },
    {
      key: 'ica',
      title: 'ICA — interconnection agreement',
      statusField: 'ica_status',
      days: { from: 'ica_applied_date', to: 'ica_received_date', label: 'ICA Days' },
      fields: [
        {
          name: 'ica_status',
          label: 'ICA Status',
          type: 'select',
          options: PERMIT_TRACK_STATUSES,
          required: true,
          stamp: { applied: 'ica_applied_date', approved: 'ica_received_date' },
        },
        { name: 'ica_applied_date', label: 'ICA Applied Date', type: 'date', required: true },
        { name: 'ica_received_date', label: 'ICA Received Date', type: 'date', required: true },
        txt('ica_application_number', 'ICA application number'),
        sel('meter_swap_required', 'Meter swap required?', ['yes', 'no', 'na']),
        { name: 'ica_pm_notes', label: 'ICA PM Notes', type: 'textarea' },
        { name: 'ica_revision_notes', label: 'ICA Revision Notes', type: 'textarea' },
      ],
    },
    {
      key: 'hoa',
      title: 'HOA',
      statusField: 'hoa_status',
      days: { from: 'hoa_applied_date', to: 'hoa_received_date', label: 'HOA Days' },
      fields: [
        {
          name: 'hoa_status',
          label: 'HOA Status',
          type: 'select',
          options: ['na', ...PERMIT_TRACK_STATUSES],
          required: true,
          stamp: { applied: 'hoa_applied_date', approved: 'hoa_received_date' },
        },
        {
          name: 'hoa_applied_date',
          label: 'HOA Applied Date',
          type: 'date',
          required: 'cond',
          note: 'Required unless status = N/A',
        },
        {
          name: 'hoa_received_date',
          label: 'HOA Received Date',
          type: 'date',
          required: 'cond',
          note: 'Required unless status = N/A',
        },
        txt('hoa_name', 'HOA name'),
        txt('hoa_contact', 'HOA contact', { note: 'Name, email or phone' }),
        { name: 'hoa_revision_notes', label: 'HOA Revision Notes', type: 'textarea' },
      ],
    },
    paymentCard('cash_m2', 'Cash M2 milestone', 'cash_m2', true),
    {
      key: 'hdm_ntp',
      title: 'HDM NTP — notice to proceed',
      statusField: 'hdm_ntp_status',
      fields: [
        {
          name: 'hdm_ntp_status',
          label: 'HDM NTP Status',
          type: 'select',
          options: FINANCE_STATUSES,
          required: true,
          stamp: { submitted: 'hdm_ntp_submitted_date', approved: 'hdm_ntp_approved_date' },
        },
        { name: 'hdm_ntp_submitted_date', label: 'HDM NTP Submitted Date', type: 'date' },
        {
          name: 'hdm_ntp_approved_date',
          label: 'HDM NTP Approved Date',
          type: 'date',
          required: 'cond',
          note: 'Required if status is not N/A',
        },
      ],
    },
    attachmentsCard('permits'),
  ],

  procurement: [
    {
      key: 'material',
      title: 'Material',
      statusField: 'material_status',
      days: { from: 'material_requested_date', to: 'material_delivered_date', label: 'Material Days' },
      fields: [
        {
          name: 'procurement_manager',
          label: 'Procurement Manager',
          type: 'refselect',
          optionsKey: 'staff',
          required: true,
        },
        {
          name: 'material_status',
          label: 'Material Status',
          type: 'select',
          options: ['not_requested', 'requested', 'ordered', 'in_transit', 'delivered', 'backordered'],
          required: true,
          stamp: { requested: 'material_requested_date', ordered: 'order_date', delivered: 'material_delivered_date' },
        },
        { name: 'material_requested_date', label: 'Material Requested Date', type: 'date', required: true },
        txt('vendor_name', 'Vendor / distributor'),
        txt('po_number', 'PO number'),
        dt('order_date', 'Order date'),
        dt('expected_delivery_date', 'Expected delivery'),
        txt('tracking_number', 'Tracking number'),
        sel('material_location', 'Material is', ['vendor', 'warehouse', 'site']),
        num('material_cost', 'Material cost', '$'),
        { name: 'material_delivered_date', label: 'Material Delivered Date', type: 'date', required: true },
        {
          name: 'pm_notes',
          label: 'PM Notes',
          type: 'textarea',
          note: 'Vendor, PO reference, backorder or damage notes',
        },
      ],
    },
    attachmentsCard('procurement'),
  ],

  install: [
    {
      key: 'install',
      title: 'Install',
      statusField: 'install_status',
      days: { from: 'install_requested_date', to: 'install_completed_date', label: 'Installation Days' },
      fields: [
        {
          name: 'install_manager',
          label: 'Install Manager',
          type: 'refselect',
          optionsKey: 'staff',
          required: true,
        },
        {
          name: 'install_status',
          label: 'Installation Status',
          type: 'select',
          options: ['not_scheduled', 'requested', 'scheduled', 'in_progress', 'completed', 'on_hold'],
          required: true,
          stamp: {
            requested: 'install_requested_date',
            scheduled: 'install_scheduled_date',
            completed: 'install_completed_date',
          },
        },
        { name: 'install_requested_date', label: 'Install Requested Date', type: 'date', required: true },
        { name: 'install_scheduled_date', label: 'Install Scheduled Date', type: 'date', required: true },
        txt('crew_lead', 'Crew lead'),
        num('crew_size', 'Crew size'),
        num('install_duration_days', 'Install duration', 'days'),
        dt('mpu_completed_date', 'Main panel upgrade completed'),
        { name: 'install_completed_date', label: 'Install Completed Date', type: 'date', required: true },
        dt('homeowner_signoff_date', 'Homeowner sign-off date'),
        { name: 'install_notes', label: 'Install notes', type: 'textarea', note: 'What the crew found, punch list' },
        {
          name: 'install_pictures',
          label: 'Install Pictures',
          type: 'upload',
          accept: 'photos',
          multiple: true,
          required: true,
          note: 'Arrays, conduit, battery, labels',
        },
      ],
    },
    paymentCard('cash_m3', 'Cash M3 milestone', 'cash_m3', true),
    financeM1Card,
    attachmentsCard('install'),
  ],

  inspection_pto: [
    {
      key: 'inspection',
      title: 'Inspection',
      statusField: 'inspection_status',
      days: { from: 'inspection_requested_date', to: 'inspection_completed_date', label: 'Inspection Days' },
      fields: [
        {
          name: 'inspection_status',
          label: 'Inspection Status',
          type: 'select',
          options: ['not_requested', 'requested', 'scheduled', 'passed', 'failed', 'reinspection_scheduled'],
          required: true,
          stamp: {
            requested: 'inspection_requested_date',
            scheduled: 'inspection_scheduled_date',
            passed: 'inspection_completed_date',
            reinspection_scheduled: 'reinspection_date',
          },
        },
        dt('inspection_scheduled_date', 'Inspection Scheduled Date'),
        txt('inspector_name', 'Inspector'),
        dt('reinspection_date', 'Re-inspection date'),
        {
          name: 'inspection_failed_notes',
          label: 'Inspection Failed Notes',
          type: 'textarea',
          required: 'cond',
          note: 'Correction items and the fix; required whenever status has been Failed',
        },
        { name: 'inspection_requested_date', label: 'Inspection Requested Date', type: 'date', required: true },
        { name: 'inspection_completed_date', label: 'Inspection Completed Date', type: 'date', required: true },
        { name: 'pm_notes', label: 'PM Notes', type: 'textarea' },
      ],
    },
    financeM1Card,
    {
      key: 'pto',
      title: 'PTO',
      statusField: 'pto_status',
      days: { from: 'pto_applied_date', to: 'pto_received_date', label: 'PTO Days' },
      fields: [
        {
          name: 'pto_status',
          label: 'PTO Status',
          type: 'select',
          options: ['not_applied', 'applied', 'in_review', 'received', 'rejected'],
          required: true,
          stamp: { applied: 'pto_applied_date', received: 'pto_received_date' },
        },
        { name: 'pto_applied_date', label: 'PTO Applied Date', type: 'date', required: true },
        txt('pto_application_number', 'PTO / interconnection application number'),
        dt('meter_set_date', 'Net meter set on'),
        { name: 'pto_received_date', label: 'PTO Received Date', type: 'date', required: true },
      ],
    },
    {
      key: 'energization',
      title: 'Energization',
      statusField: 'energization_status',
      fields: [
        {
          name: 'energization_status',
          label: 'Monitoring / System Energization Status',
          type: 'select',
          options: ['not_started', 'in_progress', 'energized', 'issue'],
          required: true,
          stamp: { energized: 'energization_date' },
        },
        {
          name: 'energization_date',
          label: 'Monitoring / System Energization Date',
          type: 'date',
          required: 'cond',
        },
        sel('monitoring_platform', 'Monitoring platform', ['enphase', 'solaredge', 'tesla', 'generac', 'other']),
        txt('monitoring_site_id', 'Monitoring site ID'),
      ],
    },
    financeM2Card,
    attachmentsCard('inspection_pto'),
  ],

  complete: [
    {
      key: 'completion',
      title: 'Completion',
      statusField: 'completion_status',
      days: { to: 'completion_date', label: 'Total Project Days' },
      fields: [
        {
          name: 'completion_status',
          label: 'Project Completion Status',
          type: 'select',
          options: ['complete', 'complete_with_open_items'],
          required: true,
        },
        {
          name: 'completion_date',
          label: 'Project Completion Date',
          type: 'date',
          required: true,
          note: 'Defaults to the date the project was completed; editable (change logged)',
        },
        {
          name: 'completion_notes',
          label: 'Completion PM Notes',
          type: 'textarea',
          note: 'Closing summary, open items, anything the next person should know',
        },
      ],
    },
    {
      key: 'closeout',
      title: 'Close-out',
      fields: [
        dt('warranty_registration_date', 'Warranties registered on'),
        dt('final_payment_received_date', 'Final payment received on'),
        dt('closeout_packet_sent_date', 'Close-out packet sent to homeowner on'),
        dt('review_requested_date', 'Review requested on'),
        sel('referral_asked', 'Referral asked?', ['yes', 'no']),
      ],
    },
    attachmentsCard('complete'),
  ],
};

/** The stage's own table in the database. */
export const STAGE_TABLES: Record<StageKey, string> = {
  survey: 'stage1_survey',
  design: 'stage2_design',
  permits: 'stage3_permit',
  procurement: 'stage4_procurement',
  install: 'stage5_install',
  inspection_pto: 'stage6_inspection',
  complete: 'stage7_complete',
};

export const HOLD_REASONS = [
  'Customer request',
  'Finance pending',
  'Weather',
  'Access issue',
  'Awaiting documents',
  'Site issue',
  'Other',
] as const;

export const CANCELLATION_REASONS = [
  'Customer cancelled',
  'Failed credit',
  'Site not viable',
  'Permit denied',
  'Duplicate',
  'Competitor',
  'Other',
] as const;

export const PERMIT_OPTIONS = ['building', 'electrical', 'structural'] as const;

export function statusLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return STATUS_LABELS[String(value)] ?? String(value);
}
