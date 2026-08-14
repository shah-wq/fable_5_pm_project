/**
 * Registry of admin-managed reference tables: one place defines each
 * section's table, columns, and form fields — the panel pages and the
 * /api/admin/records/[entity] endpoint both read it, so a new section is a
 * dozen declarative lines. Deactivate-not-delete: every entity has is_active
 * instead of a delete action; inactive records vanish from the PM's
 * dropdowns but stay attached to historical projects.
 */

export type FieldType = 'text' | 'email' | 'number' | 'textarea' | 'tags' | 'rating' | 'ref';

export interface EntityField {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** type 'ref' only: the table the dropdown lists (id + refLabel column). */
  refTable?: string;
  refLabel?: string;
}

export interface EntityDef {
  table: string;
  title: string;
  blurb: string;
  /** Column shown as the record's display name. */
  nameColumn: string;
  fields: EntityField[];
  /** Columns shown in the table (subset of fields + name). */
  listColumns: string[];
}

export const ADMIN_ENTITIES: Record<string, EntityDef> = {
  surveyors: {
    table: 'surveyors',
    title: 'Surveyors',
    blurb: 'The people the PM calls to book site surveys. Used by the Stage 1 form.',
    nameColumn: 'name',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'service_area', label: 'Service area', type: 'text' },
      { name: 'rating', label: 'Rating', type: 'rating' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    listColumns: ['phone', 'email', 'service_area', 'rating'],
  },
  designers: {
    table: 'designers',
    title: 'Designers',
    blurb: 'In-house or contract designers. Skills and turnaround feed the Stage 2 form.',
    nameColumn: 'display_name',
    fields: [
      { name: 'display_name', label: 'Name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'skills', label: 'Skills (comma-separated)', type: 'tags' },
      { name: 'default_turnaround_hours', label: 'Default turnaround (hours)', type: 'number' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    listColumns: ['email', 'phone', 'skills', 'default_turnaround_hours'],
  },
  crews: {
    table: 'crews',
    title: 'Install crews',
    blurb: 'Subcontractor companies that perform installations. Used by the Stage 5 form.',
    nameColumn: 'name',
    fields: [
      { name: 'name', label: 'Company name', type: 'text', required: true },
      { name: 'contact_person', label: 'Contact person', type: 'text' },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'crew_size', label: 'Crew size', type: 'number' },
      { name: 'service_area', label: 'Service area', type: 'text' },
      { name: 'rating', label: 'Rating', type: 'rating' },
      { name: 'notes', label: 'Notes (licensing, insurance…)', type: 'textarea' },
    ],
    listColumns: ['contact_person', 'phone', 'crew_size', 'service_area', 'rating'],
  },
  vendors: {
    table: 'vendors',
    title: 'Vendors',
    blurb: 'Equipment distributors the PM orders from. Used by the Stage 4 BOM lines.',
    nameColumn: 'name',
    fields: [
      { name: 'name', label: 'Vendor name', type: 'text', required: true },
      { name: 'contact_person', label: 'Contact / sales rep', type: 'text' },
      { name: 'email', label: 'Order email', type: 'email' },
      { name: 'phone', label: 'Order phone', type: 'text' },
      { name: 'lead_time_days', label: 'Typical lead time (days)', type: 'number' },
      { name: 'account_number', label: 'Account number', type: 'text' },
      { name: 'notes', label: 'Notes (pricing, freight terms…)', type: 'textarea' },
    ],
    listColumns: ['contact_person', 'email', 'phone', 'lead_time_days'],
  },
  dealers: {
    table: 'dealers',
    title: 'Dealers',
    blurb: 'Dealer companies whose book of projects flows through the pipeline.',
    nameColumn: 'name',
    fields: [
      { name: 'name', label: 'Company name', type: 'text', required: true },
      { name: 'code', label: 'Code', type: 'text' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone', type: 'text' },
    ],
    listColumns: ['code', 'email', 'phone'],
  },
  finance_partners: {
    table: 'finance_partners',
    title: 'Finance partners',
    blurb: 'Drives the milestone field labels on the stage forms (Finance M1/M2).',
    nameColumn: 'name',
    fields: [{ name: 'name', label: 'Name', type: 'text', required: true }],
    listColumns: [],
  },

  // Equipment & financing lists — the New Project form's dropdowns, seeded
  // from Solar_SCOOP_Data.xlsx. Not hardcoded: correcting a name here fixes
  // it on every project that references the row.
  sales_reps: {
    table: 'sales_reps',
    title: 'Sales reps',
    blurb: 'Reps as a list, not free text — per-rep reporting stays consistent.',
    nameColumn: 'name',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'dealer_id', label: 'Dealer', type: 'ref', refTable: 'dealers', refLabel: 'name' },
    ],
    listColumns: ['email', 'phone'],
  },
  system_types: {
    table: 'system_types',
    title: 'System types',
    blurb: 'Battery only, Battery & solar, Grid-tie… the first system-spec dropdown.',
    nameColumn: 'name',
    fields: [{ name: 'name', label: 'Name', type: 'text', required: true }],
    listColumns: [],
  },
  module_types: {
    table: 'module_types',
    title: 'Module types',
    blurb: 'Panel models for the Module Type dropdown. Manufacturer and wattage let the PM filter by brand and sanity-check system size.',
    nameColumn: 'name',
    fields: [
      { name: 'name', label: 'Model', type: 'text', required: true },
      { name: 'manufacturer', label: 'Manufacturer', type: 'text' },
      { name: 'wattage', label: 'Wattage (W)', type: 'number' },
    ],
    listColumns: ['manufacturer', 'wattage'],
  },
  inverter_types: {
    table: 'inverter_types',
    title: 'Inverter types',
    blurb: 'Inverter models for the Inverter Type dropdown.',
    nameColumn: 'name',
    fields: [
      { name: 'name', label: 'Model', type: 'text', required: true },
      { name: 'manufacturer', label: 'Manufacturer', type: 'text' },
    ],
    listColumns: ['manufacturer'],
  },
  battery_types: {
    table: 'battery_types',
    title: 'Battery types',
    blurb: 'Battery models — shown on the project form only when the System Type includes a battery.',
    nameColumn: 'name',
    fields: [
      { name: 'name', label: 'Model', type: 'text', required: true },
      { name: 'manufacturer', label: 'Manufacturer', type: 'text' },
      { name: 'capacity_kwh', label: 'Capacity (kWh)', type: 'number' },
    ],
    listColumns: ['manufacturer', 'capacity_kwh'],
  },
  financing_companies: {
    table: 'financing_companies',
    title: 'Financing companies',
    blurb: 'Who lent the money. Deal-specific text belongs in the project’s Financing Notes, not here.',
    nameColumn: 'name',
    fields: [{ name: 'name', label: 'Name', type: 'text', required: true }],
    listColumns: [],
  },
  cash_financing_options: {
    table: 'cash_financing_options',
    title: 'Cash or Financing',
    blurb: 'The deal-structure dropdown (Cash, Financing, HDM with Cash…).',
    nameColumn: 'name',
    fields: [{ name: 'name', label: 'Name', type: 'text', required: true }],
    listColumns: [],
  },
  dealer_visible_fields: {
    table: 'dealer_visible_fields',
    title: 'Dealer visibility',
    blurb:
      'Which stage fields dealers see on their portal — Active = visible. New fields default to hidden; costs, margins and PM notes are never shown regardless.',
    nameColumn: 'label',
    fields: [
      { name: 'label', label: 'Field', type: 'text', required: true },
      { name: 'stage', label: 'Stage key', type: 'text', required: true },
      { name: 'name', label: 'Column name', type: 'text', required: true },
    ],
    listColumns: ['stage', 'name'],
  },
};

export type EntityKey = keyof typeof ADMIN_ENTITIES;
