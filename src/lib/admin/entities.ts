/**
 * Registry of admin-managed reference tables: one place defines each
 * section's table, columns, and form fields — the panel pages and the
 * /api/admin/records/[entity] endpoint both read it, so a new section is a
 * dozen declarative lines. Deactivate-not-delete: every entity has is_active
 * instead of a delete action; inactive records vanish from the PM's
 * dropdowns but stay attached to historical projects.
 */

export type FieldType = 'text' | 'email' | 'number' | 'textarea' | 'tags' | 'rating';

export interface EntityField {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
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
    blurb: 'Lenders referenced on projects and the Stage 2 finance checks.',
    nameColumn: 'name',
    fields: [{ name: 'name', label: 'Name', type: 'text', required: true }],
    listColumns: [],
  },
};

export type EntityKey = keyof typeof ADMIN_ENTITIES;
