'use client';

export interface PreviewData {
  columns: Array<{ key: string; fieldKey: string; label: string; type: string; grain?: string }>;
  rows: Array<Record<string, unknown>>;
  totalRows: number;
  truncated: boolean;
  groupColumns: string[];
  groups: Array<{
    path: Array<string | null>;
    start: number;
    end: number;
    count: number;
    subtotals: Array<{ column: string; agg: string; value: number | string | null }>;
  }>;
  totals: Array<{ column: string; agg: string; value: number | string | null }>;
  durationMs?: number;
}

function format(type: string, raw: unknown): string {
  if (raw === null || raw === undefined || raw === '') return '—';
  if (type === 'currency') return `$${Number(raw).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  if (type === 'number' || type === 'count') return Number(raw).toLocaleString();
  if (type === 'date') return String(raw).slice(0, 10);
  if (type === 'boolean') return raw === true ? 'Yes' : 'No';
  return String(raw).replaceAll('_', ' ');
}

/**
 * Live preview of the first rows, with per-group subtotal rows and a totals
 * row underneath — the same shape the Excel export writes as outline levels
 * and SUBTOTAL formulas.
 */
export function PreviewTable({ data, busy }: { data: PreviewData | null; busy: boolean }) {
  if (!data) {
    return (
      <section className="preview">
        <p className="dim">{busy ? 'Running…' : 'Drag a field into Columns to see the report.'}</p>
      </section>
    );
  }

  const subtotalFor = (rowIndex: number) =>
    data.groups.find((g) => g.end === rowIndex);
  const cellFor = (
    cells: Array<{ column: string; agg: string; value: number | string | null }>,
    column: string
  ) => cells.filter((c) => c.column === column);

  return (
    <section className="preview">
      <div className="preview-head">
        <strong>
          Showing {data.rows.length} of {data.totalRows.toLocaleString()}
        </strong>
        {data.truncated && <span className="dim"> · preview is capped</span>}
        {data.durationMs !== undefined && <span className="dim"> · {data.durationMs} ms</span>}
        {busy && <span className="dim"> · refreshing…</span>}
      </div>
      <div className="table-wrap">
        <table className="projects-table report-preview">
          <thead>
            <tr>
              {data.columns.map((c) => (
                <th key={c.key}>
                  {c.label}
                  {c.grain && c.grain !== 'day' ? ` (${c.grain})` : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <>
                <tr key={`r${i}`}>
                  {data.columns.map((c) => (
                    <td key={c.key} className={['number', 'currency', 'count'].includes(c.type) ? 'num' : ''}>
                      {format(c.type, row[c.key])}
                    </td>
                  ))}
                </tr>
                {subtotalFor(i) && (
                  <tr key={`s${i}`} className="subtotal-row">
                    {data.columns.map((c, ci) => {
                      const cells = cellFor(subtotalFor(i)!.subtotals, c.key);
                      if (ci === 0) {
                        return (
                          <td key={c.key}>
                            <strong>
                              {subtotalFor(i)!.path.map((p) => p ?? '—').join(' · ')} ({subtotalFor(i)!.count})
                            </strong>
                          </td>
                        );
                      }
                      return (
                        <td key={c.key} className="num">
                          {cells.map((cell) => (
                            <div key={cell.agg}>
                              <span className="dim">{cell.agg} </span>
                              {format(c.type === 'date' ? 'date' : 'number', cell.value)}
                            </div>
                          ))}
                        </td>
                      );
                    })}
                  </tr>
                )}
              </>
            ))}
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={Math.max(1, data.columns.length)} className="dim">
                  No rows match this scope and these filters.
                </td>
              </tr>
            )}
          </tbody>
          {data.totals.length > 0 && data.rows.length > 0 && (
            <tfoot>
              <tr>
                {data.columns.map((c, ci) => (
                  <td key={c.key} className={ci === 0 ? '' : 'num'}>
                    {ci === 0 ? <strong>TOTAL</strong> : cellFor(data.totals, c.key).map((cell) => (
                      <div key={cell.agg}>
                        <span className="dim">{cell.agg} </span>
                        {format(c.type === 'date' ? 'date' : 'number', cell.value)}
                      </div>
                    ))}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}
