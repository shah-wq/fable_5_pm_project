/**
 * The contact intake fields, as data.
 *
 * One definition drives the Contacts record, the deal record and the save
 * allowlists — the same arrangement lib/stages/fields.ts uses for the seven
 * stage forms, and for the same reason: three copies of a field list drift, and
 * the one that drifts is always the one that decides what gets saved.
 *
 * `on` is where the value lives. Identity and mailing belong to the person;
 * everything about the system, the money and the paperwork belongs to the deal,
 * because a person with two properties has two of each and a column on the
 * person could only hold one of them.
 */

export type IntakeType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'phone'
  | 'number'
  | 'currency'
  | 'select'
  /** A boolean asked as a question: Yes, No, or left blank for "not asked". */
  | 'yesno'
  | 'ref'
  | 'toggle'
  | 'upload'
  | 'readonly';

export type IntakeOwner = 'client' | 'deal';

export type IntakeRefKey =
  | 'owners'
  | 'sources'
  | 'dealers'
  | 'modules'
  | 'inverters'
  | 'batteries'
  | 'financingCompanies'
  | 'utilities'
  | 'lossReasons'
  | 'roofTypes';

export interface IntakeField {
  /** Column name on its table, or the document category for an upload. */
  name: string;
  label: string;
  type: IntakeType;
  on: IntakeOwner;
  options?: Array<{ value: string; label: string }>;
  refKey?: IntakeRefKey;
  note?: string;
  /** Marked on the form, and checked by the create route before it inserts. */
  required?: boolean;
  /**
   * Read-only on an existing record, but editable while creating one. The lead
   * status is the case: it is moved on the board afterwards, but a contact typed
   * in after a site visit does not start at New.
   */
  editableOnCreate?: boolean;
}

export interface IntakeGroup {
  key: string;
  title: string;
  blurb?: string;
  fields: IntakeField[];
}

const YES_NO_UNKNOWN = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'unknown', label: 'Not asked yet' },
];

export const CONTACT_GROUPS: IntakeGroup[] = [
  {
    key: 'contact',
    title: 'Contact',
    fields: [
      { name: 'owner_id', label: 'Contact owner', type: 'ref', refKey: 'owners', on: 'client' },
      {
        name: 'salutation',
        label: 'Salutation',
        type: 'select',
        on: 'client',
        options: [
          { value: 'Mr.', label: 'Mr.' },
          { value: 'Ms.', label: 'Ms.' },
          { value: 'Mrs.', label: 'Mrs.' },
          { value: 'Dr.', label: 'Dr.' },
          { value: 'Prof.', label: 'Prof.' },
        ],
      },
      { name: 'first_name', label: 'First name', type: 'text', on: 'client' },
      { name: 'last_name', label: 'Last name', type: 'text', on: 'client', required: true },
      {
        name: 'email',
        label: 'Email',
        type: 'email',
        on: 'client',
        required: true,
        note: 'Email or phone — at least one, so somebody can be reached.',
      },
      { name: 'phone', label: 'Phone', type: 'phone', on: 'client', required: true },
      {
        name: 'alternate_phone',
        label: 'Mobile',
        type: 'phone',
        on: 'client',
        note: 'Also matched on when checking for duplicates.',
      },
      {
        name: 'owner_phone',
        label: "Owner's phone number",
        type: 'phone',
        on: 'client',
        note: 'When the person you deal with is not the property owner.',
      },
      {
        name: 'source_id',
        label: 'Lead source',
        type: 'ref',
        refKey: 'sources',
        on: 'client',
        note: 'Set once at creation and not overwritten afterwards.',
      },
      { name: 'dealer_id', label: 'Dealer name', type: 'ref', refKey: 'dealers', on: 'client' },
      {
        name: 'consultant',
        label: 'Consultant',
        type: 'text',
        on: 'client',
        note: 'The rep working the account, in or out of house.',
      },
      {
        name: 'created_by_name',
        label: 'Created by',
        type: 'readonly',
        on: 'client',
        note: 'Recorded when the record is made.',
      },
      { name: 'description', label: 'Description', type: 'textarea', on: 'client' },
    ],
  },
  {
    key: 'mailing',
    title: 'Mailing address',
    blurb: 'Where post goes, when that is not the property being quoted.',
    fields: [
      { name: 'mailing_street', label: 'Mailing street', type: 'text', on: 'client' },
      { name: 'mailing_city', label: 'Mailing city', type: 'text', on: 'client' },
      { name: 'mailing_state', label: 'Mailing state', type: 'text', on: 'client' },
      { name: 'mailing_postal_code', label: 'Mailing ZIP', type: 'text', on: 'client' },
      { name: 'mailing_country', label: 'Mailing country', type: 'text', on: 'client' },
    ],
  },
  {
    key: 'status',
    title: 'Status',
    fields: [
      {
        name: 'stage',
        label: 'Lead status',
        type: 'readonly',
        on: 'deal',
        editableOnCreate: true,
        note: 'Moved on the Deals board afterwards, so the board and this screen can never disagree.',
        options: [
          { value: 'new', label: 'New' },
          { value: 'contacted', label: 'Contacted' },
          { value: 'qualified', label: 'Qualified' },
          { value: 'proposal', label: 'Proposal' },
          { value: 'negotiation', label: 'Negotiation' },
          { value: 'contract_out', label: 'Contract out' },
        ],
      },
      { name: 'lost_reason_id', label: 'Lost reason', type: 'ref', refKey: 'lossReasons', on: 'deal' },
      { name: 'reschedule_reason', label: 'Reschedule reason', type: 'text', on: 'deal' },
    ],
  },
  {
    key: 'dealer',
    title: 'Dealer and notes',
    fields: [
      { name: 'dealer_code', label: 'Dealer code', type: 'text', on: 'deal' },
      { name: 'wave_sales_notes', label: 'Wave sales notes', type: 'textarea', on: 'deal' },
      { name: 'additional_information', label: 'Additional information', type: 'textarea', on: 'deal' },
    ],
  },
];

/**
 * The other half: what is true of one opportunity rather than of a person.
 *
 * These live on the deal record. They were on the contact for a while and came
 * back off it — a screen for filing a phone number should not ask for a module
 * wattage, and a person with two properties has two answers to every question
 * here anyway.
 */
export const DEAL_DETAIL_GROUPS: IntakeGroup[] = [
  {
    key: 'system',
    title: 'System',
    fields: [
      { name: 'system_size_kw', label: 'System size (kW)', type: 'number', on: 'deal' },
      { name: 'module_id', label: 'Module brand', type: 'ref', refKey: 'modules', on: 'deal' },
      { name: 'module_quantity', label: 'Module quantity', type: 'number', on: 'deal' },
      { name: 'module_wattage', label: 'Module wattage', type: 'number', on: 'deal' },
      { name: 'inverter_id', label: 'Inverter brand', type: 'ref', refKey: 'inverters', on: 'deal' },
      { name: 'inverter_size_kw', label: 'Inverter size (kW)', type: 'number', on: 'deal' },
      { name: 'battery_id', label: 'Battery brand', type: 'ref', refKey: 'batteries', on: 'deal' },
      { name: 'battery_qty', label: 'Number of batteries', type: 'number', on: 'deal' },
      { name: 'battery_size_kwh', label: 'Battery size (kWh)', type: 'number', on: 'deal' },
      {
        name: 'includes_battery',
        label: 'System includes battery?',
        type: 'yesno',
        on: 'deal',
        note: 'Answers itself once a battery quantity is entered.',
      },
      {
        name: 'mount_type',
        label: 'Rooftop / ground mount',
        type: 'select',
        on: 'deal',
        options: [
          { value: 'rooftop', label: 'Rooftop' },
          { value: 'ground', label: 'Ground mount' },
          { value: 'both', label: 'Both' },
        ],
      },
      { name: 'roof_type_id', label: 'Roof type', type: 'ref', refKey: 'roofTypes', on: 'deal' },
      { name: 'hoa', label: 'HOA', type: 'select', options: YES_NO_UNKNOWN, on: 'deal' },
      {
        name: 'comparable_brand_ok',
        label: 'Okay to install comparable module & inverter brand',
        type: 'yesno',
        on: 'deal',
        note: 'Left blank until they have been asked — which is not the same as no.',
      },
    ],
  },
  {
    key: 'usage',
    title: 'Usage and utility',
    fields: [
      { name: 'utility_id', label: 'Electric utility', type: 'ref', refKey: 'utilities', on: 'deal' },
      {
        name: 'avg_monthly_bill',
        label: 'Average pre-solar monthly electric bill',
        type: 'currency',
        on: 'deal',
      },
      { name: 'annual_usage_kwh', label: 'Annual kWh usage', type: 'number', on: 'deal' },
      {
        name: 'production_estimate_kwh',
        label: 'Estimated annual production (kWh)',
        type: 'number',
        on: 'deal',
      },
    ],
  },
  {
    key: 'money',
    title: 'Price and financing',
    fields: [
      { name: 'gross_price', label: 'System price', type: 'currency', on: 'deal' },
      { name: 'contract_value', label: 'Amount', type: 'currency', on: 'deal' },
      { name: 'down_payment', label: 'Down payment', type: 'currency', on: 'deal' },
      { name: 'amount_financed', label: 'Amount financed', type: 'currency', on: 'deal' },
      {
        name: 'financing_route',
        label: 'Financed or cash?',
        type: 'select',
        on: 'deal',
        options: [
          { value: 'cash', label: 'Cash' },
          { value: 'loan', label: 'Loan' },
          { value: 'lease', label: 'Lease' },
          { value: 'ppa', label: 'PPA' },
        ],
      },
      {
        name: 'financing_company_id',
        label: 'Financing company',
        type: 'ref',
        refKey: 'financingCompanies',
        on: 'deal',
      },
    ],
  },
  {
    key: 'documents',
    title: 'Documents',
    blurb:
      'Filed against the deal, and they gain the project relation when it is won — nothing is uploaded twice.',
    fields: [
      { name: 'solar_proposal', label: 'Updated solar proposal', type: 'upload', on: 'deal' },
      {
        name: 'signed_installation_agreement',
        label: 'Updated signed solar installation agreement',
        type: 'upload',
        on: 'deal',
      },
      { name: 'electricity_bill_front', label: 'Updated electricity bill (front)', type: 'upload', on: 'deal' },
      { name: 'electricity_bill_back', label: 'Updated electricity bill (back)', type: 'upload', on: 'deal' },
      { name: 'electric_bill', label: 'Electric bill', type: 'upload', on: 'deal' },
      { name: 'electrical_panel', label: 'Updated electrical panel', type: 'upload', on: 'deal' },
      { name: 'electrical_meter', label: 'Updated electrical meter', type: 'upload', on: 'deal' },
      { name: 'dealer_code_form', label: 'Dealer code form', type: 'upload', on: 'deal' },
    ],
  },
];

/** Both halves, for the allowlists the API writes through. */
export const INTAKE_GROUPS: IntakeGroup[] = [...CONTACT_GROUPS, ...DEAL_DETAIL_GROUPS];

/** Every document category the intake form can hold. */
export const INTAKE_DOCUMENT_CATEGORIES: string[] = INTAKE_GROUPS.flatMap((g) =>
  g.fields.filter((f) => f.type === 'upload').map((f) => f.name)
);

/** The savable columns on each table — the allowlists the API writes through. */
export function intakeColumns(owner: IntakeOwner): IntakeField[] {
  return INTAKE_GROUPS.flatMap((g) =>
    g.fields.filter((f) => f.on === owner && f.type !== 'upload' && f.type !== 'readonly')
  );
}

/**
 * The same list for a record being created, which is slightly longer: a couple
 * of fields are recorded rather than edited afterwards but have to be settable
 * once, at the start.
 */
export function intakeCreateColumns(owner: IntakeOwner): IntakeField[] {
  return INTAKE_GROUPS.flatMap((g) =>
    g.fields.filter(
      (f) =>
        f.on === owner &&
        f.type !== 'upload' &&
        (f.type !== 'readonly' || f.editableOnCreate === true)
    )
  );
}

/** Everything the form marks with a red rule, in the order it is asked. */
export const INTAKE_REQUIRED: IntakeField[] = CONTACT_GROUPS.flatMap((g) =>
  g.fields.filter((f) => f.required)
);
