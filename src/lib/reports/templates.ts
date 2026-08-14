import { EMPTY_DEFINITION, type ReportDefinition } from './definition';

/**
 * The shipped templates (spec §7). They open in the builder fully configured
 * and editable — the fastest route to value and the best teaching tool for the
 * builder itself, because most people will open one, drag a column in, and
 * export rather than start from a blank canvas.
 */

export interface ReportTemplate {
  key: string;
  name: string;
  kind: 'Operational' | 'Performance' | 'Exception' | 'Finance' | 'Commercial' | 'Executive';
  description: string;
  definition: ReportDefinition;
}

const def = (partial: Partial<ReportDefinition>): ReportDefinition => ({
  ...EMPTY_DEFINITION,
  ...partial,
});

const cols = (...keys: string[]) => keys.map((field) => ({ field }));

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    key: 'pipeline-snapshot',
    name: 'Pipeline snapshot',
    kind: 'Operational',
    description: 'Every active project: customer, dealer, stage, stage status, days in stage, assigned PM. Grouped by stage.',
    definition: def({
      columns: cols('customer.full', 'dealer.name', 'project.stage', 'calc.days_in_stage', 'pm.name', 'project.address'),
      groupBy: [{ field: 'project.stage' }],
      summarise: [{ field: 'calc.days_in_stage', agg: 'avg' }, { field: 'system.size_kw', agg: 'sum' }],
      includeCancelled: false,
      sort: { field: 'calc.days_in_stage', dir: 'desc' },
    }),
  },
  {
    key: 'stage-cycle-times',
    name: 'Stage cycle times',
    kind: 'Performance',
    description: 'Average and median Survey / Design / Permit / Material / Install / PTO days, grouped by month. The core throughput report.',
    definition: def({
      columns: cols('customer.full', 's1.survey_days', 's2.design_days', 's3.permit_days',
        's4.material_days', 's5.install_days', 's6.pto_days'),
      groupBy: [{ field: 'project.created', grain: 'month' }],
      summarise: [
        { field: 's1.survey_days', agg: 'avg' }, { field: 's1.survey_days', agg: 'median' },
        { field: 's2.design_days', agg: 'avg' }, { field: 's3.permit_days', agg: 'avg' },
        { field: 's4.material_days', agg: 'avg' }, { field: 's5.install_days', agg: 'avg' },
        { field: 's6.pto_days', agg: 'avg' },
      ],
      stageMode: 'passed_through',
    }),
  },
  {
    key: 'ageing-stuck',
    name: 'Ageing / stuck projects',
    kind: 'Exception',
    description: 'Projects whose days in current stage exceed the threshold, oldest first, with PM and dealer.',
    definition: def({
      columns: cols('customer.full', 'project.stage', 'calc.days_in_stage', 'calc.age_bucket',
        'pm.name', 'dealer.name'),
      filters: [{ field: 'calc.days_in_stage', op: 'gt', value: 21 }],
      groupBy: [{ field: 'calc.age_bucket' }],
      summarise: [{ field: 'calc.days_in_stage', agg: 'max' }],
      sort: { field: 'calc.days_in_stage', dir: 'desc' },
    }),
  },
  {
    key: 'permit-turnaround',
    name: 'Permit turnaround by jurisdiction',
    kind: 'Performance',
    description: 'Permit Applied → Received, averaged and grouped by jurisdiction, with counts. Shows which AHJs are slow.',
    definition: def({
      columns: cols('customer.full', 'jurisdiction.name', 's3.permit_applied', 's3.permit_received', 's3.permit_days'),
      groupBy: [{ field: 'jurisdiction.name' }],
      summarise: [
        { field: 's3.permit_days', agg: 'avg' },
        { field: 's3.permit_days', agg: 'median' },
        { field: 's3.permit_days', agg: 'count' },
      ],
      stageMode: 'passed_through',
      filters: [{ field: 's3.permit_applied', op: 'not_empty' }],
    }),
  },
  {
    key: 'milestone-payments',
    name: 'Milestone payment tracker',
    kind: 'Finance',
    description: 'Down payment and Cash M1/M2/M3 plus the finance milestones: status and dates per project, filtered to anything outstanding.',
    definition: def({
      columns: cols('customer.full', 'dealer.name', 'finance.partner',
        's1.dp_status', 's1.dp_received', 's1.m1_status', 's1.m1_received',
        's3.m2_status', 's3.m2_received', 's5.m3_status', 's5.m3_received',
        'fin.m1_status', 'fin.m1_approved', 'fin.m2_status', 'fin.m2_approved',
        'calc.milestones_outstanding'),
      filters: [{ field: 'calc.milestones_outstanding', op: 'gt', value: 0 }],
      summarise: [{ field: 'calc.milestones_outstanding', agg: 'sum' }],
      sort: { field: 'calc.milestones_outstanding', dir: 'desc' },
    }),
  },
  {
    key: 'dealer-performance',
    name: 'Dealer performance',
    kind: 'Commercial',
    description: 'Projects, completions, average cycle time, cancellations and commission totals, grouped by dealer.',
    definition: def({
      columns: cols('dealer.name', 'customer.full', 'project.status', 's7.total_days',
        'project.contract_value', 'cm.total', 'cm.status'),
      groupBy: [{ field: 'dealer.name' }],
      summarise: [
        { field: 's7.total_days', agg: 'avg' },
        { field: 'project.contract_value', agg: 'sum' },
        { field: 'cm.total', agg: 'sum' },
        { field: 'customer.full', agg: 'count' },
      ],
      includeCancelled: true,
    }),
  },
  {
    key: 'sales-rep-performance',
    name: 'Sales rep performance',
    kind: 'Commercial',
    description: 'The same view grouped by Sales Rep Name.',
    definition: def({
      columns: cols('rep.name', 'dealer.name', 'customer.full', 'project.status',
        's7.total_days', 'project.contract_value'),
      groupBy: [{ field: 'rep.name' }],
      summarise: [
        { field: 'customer.full', agg: 'count' },
        { field: 'project.contract_value', agg: 'sum' },
        { field: 's7.total_days', agg: 'avg' },
      ],
      includeCancelled: true,
    }),
  },
  {
    key: 'cancellations',
    name: 'Cancellations analysis',
    kind: 'Commercial',
    description: 'Cancelled projects with Stage Cancelled From, reason and contract value, grouped by reason.',
    definition: def({
      columns: cols('customer.full', 'dealer.name', 'cancel.date', 'cancel.stage_from',
        'cancel.reason', 'project.contract_value', 'cancel.refund_status'),
      groupBy: [{ field: 'cancel.reason' }],
      summarise: [
        { field: 'customer.full', agg: 'count' },
        { field: 'project.contract_value', agg: 'sum' },
      ],
      filters: [{ field: 'project.status', op: 'is', value: 'cancelled' }],
      includeCancelled: true,
      stages: [],
    }),
  },
  {
    key: 'hold-analysis',
    name: 'Hold analysis',
    kind: 'Operational',
    description: 'Held and previously-held projects with hold reason, hold days and the stage they were held from.',
    definition: def({
      columns: cols('customer.full', 'dealer.name', 'hold.reason', 'hold.stage_from',
        'hold.start', 'hold.expected_resume', 'hold.resume', 'hold.days', 'project.status'),
      groupBy: [{ field: 'hold.reason' }],
      summarise: [{ field: 'hold.days', agg: 'avg' }, { field: 'customer.full', agg: 'count' }],
      filters: [{ field: 'hold.start', op: 'not_empty' }],
      includeHold: true,
    }),
  },
  {
    key: 'completed-projects',
    name: 'Completed projects',
    kind: 'Executive',
    description: 'Everything completed in the period with Total Project Days, contract value and dealer.',
    definition: def({
      columns: cols('customer.full', 'dealer.name', 's7.completion_date', 's7.total_days',
        'system.size_kw', 'project.contract_value', 's7.completion_status'),
      groupBy: [{ field: 's7.completion_date', grain: 'month' }],
      summarise: [
        { field: 'customer.full', agg: 'count' },
        { field: 's7.total_days', agg: 'avg' },
        { field: 'project.contract_value', agg: 'sum' },
        { field: 'system.size_kw', agg: 'sum' },
      ],
      stages: ['complete'],
      dateRange: { field: 's7.completion_date', mode: 'relative', relative: 'this_year' },
    }),
  },
  {
    key: 'designer-throughput',
    name: 'Designer throughput',
    kind: 'Performance',
    description: 'Plan sets per designer with average Design Days.',
    definition: def({
      columns: cols('s2.designer', 'customer.full', 's2.requested', 's2.received', 's2.design_days', 's2.design_status'),
      groupBy: [{ field: 's2.designer' }],
      summarise: [
        { field: 'customer.full', agg: 'count' },
        { field: 's2.design_days', agg: 'avg' },
        { field: 's2.design_days', agg: 'median' },
      ],
      stageMode: 'passed_through',
    }),
  },
];

export const TEMPLATE_BY_KEY = new Map(REPORT_TEMPLATES.map((t) => [t.key, t]));
