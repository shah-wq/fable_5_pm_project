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
 *  - Drive Updated closes every stage.
 */

export type StageFieldType =
  | 'select'
  | 'date'
  | 'text'
  | 'textarea'
  | 'toggle'
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
  /** true = always required; 'cond' = required per the governing status. */
  required?: boolean | 'cond';
  /** status value → date field to auto-stamp with today when selected. */
  stamp?: Record<string, string>;
  accept?: 'photos' | 'pdf';
  multiple?: boolean;
  note?: string;
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
};

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

const driveCard = (note: string): StageCard => ({
  key: 'closeout',
  title: 'Close-out',
  fields: [
    {
      name: 'drive_updated',
      label: 'Drive Updated',
      type: 'toggle',
      required: true,
      note,
    },
  ],
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
          stamp: { completed: 'survey_completed_date' },
        },
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
    driveCard('Survey documents filed to the Drive folder'),
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
    driveCard('Plan sets and stamps filed to the Drive folder'),
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
    driveCard('Permits, ICA and HOA approvals filed to the Drive folder'),
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
          stamp: { requested: 'material_requested_date', delivered: 'material_delivered_date' },
        },
        { name: 'material_requested_date', label: 'Material Requested Date', type: 'date', required: true },
        { name: 'material_delivered_date', label: 'Material Delivered Date', type: 'date', required: true },
        {
          name: 'pm_notes',
          label: 'PM Notes',
          type: 'textarea',
          note: 'Vendor, PO reference, backorder or damage notes',
        },
      ],
    },
    driveCard('POs, invoices and delivery documents filed to the Drive folder'),
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
        { name: 'install_completed_date', label: 'Install Completed Date', type: 'date', required: true },
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
    driveCard('Install photos and sign-offs filed to the Drive folder'),
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
          stamp: { requested: 'inspection_requested_date', passed: 'inspection_completed_date' },
        },
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
      ],
    },
    financeM2Card,
    driveCard('PTO letter, inspection sign-off and final documents filed to the Drive folder'),
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
        {
          name: 'final_drive_updated',
          label: 'Final Drive Updated',
          type: 'toggle',
          required: true,
          note: 'Confirms the complete document trail is filed to the Drive folder',
        },
      ],
    },
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
