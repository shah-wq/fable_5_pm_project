'use client';

import { useState } from 'react';
import {
  BOOLEAN_OPS, DATE_OPS, NUMBER_OPS, RELATIVE_RANGES, STATUS_OPS, TEXT_OPS,
  type FilterOp, type ReportFilter, type RelativeRange,
} from '@/lib/reports/definition';
import type { LibraryField } from './FieldLibrary';

/**
 * The filter editor a field opens when dropped on Filters: dropdowns get is /
 * is not / is any of, dates get before / after / between / relative, numbers
 * get comparison operators, text gets contains / equals / is empty.
 */

const OP_LABELS: Record<string, string> = {
  contains: 'contains', not_contains: 'does not contain', equals: 'equals',
  is_empty: 'is empty', not_empty: 'is not empty',
  is: 'is', is_not: 'is not', is_any_of: 'is any of',
  eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between',
  before: 'before', after: 'after', relative: 'in the last / this',
  is_true: 'is yes', is_false: 'is no',
};

export function opsForType(type: string): readonly FilterOp[] {
  switch (type) {
    case 'status': return STATUS_OPS;
    case 'date': return DATE_OPS;
    case 'number': case 'currency': case 'count': return NUMBER_OPS;
    case 'boolean': return BOOLEAN_OPS;
    default: return TEXT_OPS;
  }
}

export function describeFilter(filter: ReportFilter, label: string): string {
  const op = OP_LABELS[filter.op] ?? filter.op;
  if (filter.op === 'is_empty' || filter.op === 'not_empty'
      || filter.op === 'is_true' || filter.op === 'is_false') {
    return `${label} ${op}`;
  }
  if (filter.op === 'is_any_of') return `${label} ${op} ${(filter.values ?? []).join(', ')}`;
  if (filter.op === 'between') return `${label} ${op} ${filter.value} – ${filter.value2}`;
  if (filter.op === 'relative') return `${label} ${op} ${(filter.relative ?? '').replaceAll('_', ' ')}`;
  return `${label} ${op} ${filter.value ?? ''}`;
}

export function FilterEditor({
  field,
  initial,
  onSave,
  onCancel,
}: {
  field: LibraryField;
  initial?: ReportFilter;
  onSave: (filter: ReportFilter) => void;
  onCancel: () => void;
}) {
  const ops = opsForType(field.type);
  const [op, setOp] = useState<FilterOp>(initial?.op ?? ops[0]);
  const [value, setValue] = useState(String(initial?.value ?? ''));
  const [value2, setValue2] = useState(String(initial?.value2 ?? ''));
  const [values, setValues] = useState((initial?.values ?? []).join(', '));
  const [relative, setRelative] = useState<RelativeRange>(initial?.relative ?? 'last_30_days');

  const needsValue = !['is_empty', 'not_empty', 'is_true', 'is_false', 'relative', 'is_any_of'].includes(op);
  const inputType = field.type === 'date' ? 'date'
    : ['number', 'currency', 'count'].includes(field.type) ? 'number' : 'text';

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal>
        <h2>Filter · {field.label}</h2>
        <label className="field">
          <span>Condition</span>
          <select value={op} onChange={(e) => setOp(e.target.value as FilterOp)}>
            {ops.map((o) => (
              <option key={o} value={o}>
                {OP_LABELS[o] ?? o}
              </option>
            ))}
          </select>
        </label>

        {op === 'relative' && (
          <label className="field">
            <span>Window</span>
            <select value={relative} onChange={(e) => setRelative(e.target.value as RelativeRange)}>
              {RELATIVE_RANGES.map((r) => (
                <option key={r} value={r}>
                  {r.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
        )}

        {op === 'is_any_of' && (
          <label className="field">
            <span>Any of (comma-separated)</span>
            <input value={values} onChange={(e) => setValues(e.target.value)} placeholder="approved, in_review" />
          </label>
        )}

        {needsValue && (
          <label className="field">
            <span>Value</span>
            <input type={inputType} value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        )}

        {op === 'between' && (
          <label className="field">
            <span>…and</span>
            <input type={inputType} value={value2} onChange={(e) => setValue2(e.target.value)} />
          </label>
        )}

        <div className="dialog-actions">
          <button className="btn secondary" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn"
            type="button"
            onClick={() =>
              onSave({
                field: field.key,
                op,
                value: needsValue ? value : null,
                value2: op === 'between' ? value2 : null,
                values: op === 'is_any_of'
                  ? values.split(',').map((v) => v.trim()).filter(Boolean)
                  : undefined,
                relative: op === 'relative' ? relative : undefined,
              })
            }
          >
            {initial ? 'Update filter' : 'Add filter'}
          </button>
        </div>
      </div>
    </div>
  );
}
