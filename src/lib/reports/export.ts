import ExcelJS from 'exceljs';
import type { ReportDefinition } from './definition';
import type { ReportResult } from './summarise';

/**
 * Exporters. Typed Excel output is the whole point (spec §5): dates are real
 * dates, currency is currency, groups are collapsible outline levels, and
 * subtotal/total rows are SUBTOTAL formulas rather than pasted values — if the
 * user has to redo the formatting by hand, the module has failed.
 */

const CURRENCY_FMT = '"$"#,##0.00';
const NUMBER_FMT = '#,##0.##';
const DATE_FMT = 'yyyy-mm-dd';

function cellValue(type: string, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null;
  if (type === 'date') {
    const d = new Date(String(raw));
    return Number.isNaN(d.getTime()) ? String(raw) : d;
  }
  if (type === 'number' || type === 'currency' || type === 'count') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'boolean') return raw === true || raw === 'true' ? 'Yes' : 'No';
  return String(raw).replaceAll('_', ' ');
}

function numberFormat(type: string): string | undefined {
  if (type === 'currency') return CURRENCY_FMT;
  if (type === 'number' || type === 'count') return NUMBER_FMT;
  if (type === 'date') return DATE_FMT;
  return undefined;
}

/** Excel's SUBTOTAL function numbers for the aggregations we offer. */
const SUBTOTAL_FN: Record<string, number | null> = {
  count: 103, sum: 109, avg: 101, min: 105, max: 104, median: null,
};

export interface ExportMeta {
  reportName: string;
  description?: string | null;
  ranBy: string;
  ranAt: Date;
  filterSummary: string[];
  stageSummary: string;
}

export async function toXlsx(
  result: ReportResult,
  definition: ReportDefinition,
  meta: ExportMeta
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SolarFlow PM';
  wb.created = meta.ranAt;

  // --- Cover sheet: what this file is, so a stray copy stays meaningful ----
  const cover = wb.addWorksheet('Report info');
  cover.columns = [{ width: 26 }, { width: 90 }];
  const info: Array<[string, string]> = [
    ['Report', meta.reportName],
    ...(meta.description ? ([['Description', meta.description]] as Array<[string, string]>) : []),
    ['Rows', result.truncated
      ? `${result.rows.length} exported of ${result.totalRows} matching (capped)`
      : String(result.totalRows)],
    ['Stage scope', meta.stageSummary],
    ['Filters', meta.filterSummary.length ? meta.filterSummary.join('; ') : 'none'],
    ['Run by', meta.ranBy],
    ['Run at', meta.ranAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'],
  ];
  for (const [label, value] of info) {
    const row = cover.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true };
  }

  // --- Data sheet ----------------------------------------------------------
  const ws = wb.addWorksheet('Report', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { outlineLevelRow: result.groupColumns.length > 0 ? 1 : 0 },
  });

  ws.columns = result.columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: Math.min(42, Math.max(12, c.label.length + 4)),
    style: { numFmt: numberFormat(c.type) },
  }));

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } };
  header.alignment = { vertical: 'middle' };

  const colLetter = (index: number) => ws.getColumn(index + 1).letter;
  const summaryColumnIndex = new Map(result.columns.map((c, i) => [c.key, i]));

  const writeRow = (row: Record<string, unknown>) =>
    ws.addRow(
      Object.fromEntries(
        result.columns.map((c) => [c.key, cellValue(c.type, row[c.key])])
      )
    );

  const subtotalRow = (label: string, from: number, to: number, bold: boolean) => {
    const values: Record<string, unknown> = {};
    const first = result.columns[0];
    values[first.key] = label;
    const row = ws.addRow(values);
    for (const s of definition.summarise) {
      const column = result.columns.find((c) => c.fieldKey === s.field);
      if (!column) continue;
      const key = column.key;
      const idx = summaryColumnIndex.get(key);
      if (idx === undefined) continue;
      const fn = SUBTOTAL_FN[s.agg];
      const cell = row.getCell(idx + 1);
      if (fn === null) {
        // No SUBTOTAL equivalent for median: write the computed value.
        const computed = (from === 0 && to === result.rows.length - 1)
          ? result.totals.find((t) => t.column === key && t.agg === s.agg)?.value
          : result.groups.find((g) => g.start === from && g.end === to)
              ?.subtotals.find((t) => t.column === key && t.agg === s.agg)?.value;
        cell.value = typeof computed === 'number' ? computed : (computed ?? null);
      } else {
        const letter = colLetter(idx);
        cell.value = { formula: `SUBTOTAL(${fn},${letter}${from + 2}:${letter}${to + 2})` };
      }
      cell.numFmt = numberFormat(result.columns[idx].type) ?? NUMBER_FMT;
      cell.font = { bold: true };
    }
    row.getCell(1).font = { bold: bold };
    return row;
  };

  if (result.groupColumns.length > 0 && result.groups.length > 0) {
    let cursor = 0;
    for (const group of result.groups) {
      for (let i = group.start; i <= group.end; i++) {
        const row = writeRow(result.rows[i]);
        row.outlineLevel = 1; // collapsible under its subtotal
      }
      const label = `${group.path.map((p) => p ?? '—').join(' · ')} (${group.count})`;
      subtotalRow(label, group.start, group.end, true);
      cursor = group.end + 1;
    }
    void cursor;
  } else {
    for (const row of result.rows) writeRow(row);
  }

  if (definition.summarise.length > 0 && result.rows.length > 0) {
    ws.addRow({});
    subtotalRow('TOTAL', 0, result.rows.length - 1, true);
  }

  // Real autofilter over the header row.
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: result.columns.length },
  };

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export function toCsv(result: ReportResult): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [result.columns.map((c) => esc(c.label)).join(',')];
  for (const row of result.rows) {
    lines.push(
      result.columns
        .map((c) => {
          const raw = row[c.key];
          if (c.type === 'boolean') return esc(raw === true ? 'Yes' : raw === false ? 'No' : '');
          if (c.type === 'date' && raw) return esc(String(raw).slice(0, 10));
          return esc(raw);
        })
        .join(',')
    );
  }
  // UTF-8 BOM so Excel opens accented names correctly (spec §5).
  return '﻿' + lines.join('\r\n');
}
