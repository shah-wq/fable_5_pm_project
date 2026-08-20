import Link from 'next/link';
import { STAGES, STAGE_LABELS, type StageKey } from '@/lib/stages/definitions';
import { AGE_BANDS, type AgeBand } from '@/lib/dashboard/queries';
import { axisTick, niceAxis } from '@/lib/dashboard/axis';
import { ChartPng } from './ChartPng';

/**
 * The dashboard's charts — one technology, used for all of them.
 *
 * Spec §10 names Recharts, with Chart.js as an alternative, and is emphatic
 * about the real point: pick one, because mixing libraries doubles the styling
 * work and the bundle. The one picked here is inline SVG rendered on the server,
 * for reasons that all come from the rest of the specification:
 *
 *  - §9 wants progressive loading — stat cards first, heavier charts filling in
 *    behind them. That is a server component streamed inside <Suspense>, which
 *    means the chart has to render without JavaScript. A client-side chart
 *    library renders an empty div on the server and fills in only after its
 *    bundle arrives, which is the opposite of what §9 asks for.
 *  - §9 wants every chart to survive being screenshotted into an email, so the
 *    period and filter are drawn as part of the picture rather than as page
 *    furniture around it.
 *  - §9 wants readable-in-greyscale and 380px-responsive, both of which are a
 *    viewBox and a lightness-ordered palette, not a library feature.
 *  - It also means the whole module ships no client JavaScript at all, and the
 *    charts appear in the HTML — which is how the end-to-end tests can assert a
 *    number is on the page rather than that a canvas exists.
 *
 * Everything below is deliberately plain: no animation, no gradients on data,
 * no pie charts (§9), and horizontal bars wherever there are more than three
 * categories.
 */

// --- palette ---------------------------------------------------------------
// Explicit hex, not CSS variables: these strings are serialised into a
// standalone SVG for the PNG download, where the page's stylesheet does not
// exist. Ordered by lightness on purpose, so every chart still reads in
// greyscale and colour only adds meaning (§9).

const INK = '#1a2233';
const INK_SOFT = '#5b6474';
const LINE = '#e3e0d8';
const GRID = '#efece5';
const AMBER = '#f59e0b';
const DANGER = '#b3261e';
const OK = '#1a7f4b';

/** One stage, one colour, everywhere on the page (§9). */
export const STAGE_COLOURS: Record<StageKey, string> = {
  survey: '#1f3a63',
  design: '#2f5d8f',
  permits: '#4b86b4',
  procurement: '#8fb0c8',
  install: '#c9a227',
  inspection_pto: '#e08a1e',
  complete: '#1a7f4b',
};

/** Age bands: calm → light → amber → red, and only 60+ is red (§9). */
export const BAND_COLOURS: Record<AgeBand, string> = {
  '0-14': '#6a8fa8',
  '15-30': '#c3d5e0',
  '31-60': AMBER,
  '60+': DANGER,
};

export const BAND_LABELS: Record<AgeBand, string> = {
  '0-14': '0–14 days',
  '15-30': '15–30 days',
  '31-60': '31–60 days',
  '60+': '60+ days',
};

// --- formatting ------------------------------------------------------------

export const fmtInt = (n: number): string => n.toLocaleString('en-US');
export const fmtDays = (n: number | null): string => (n === null ? '—' : `${fmtInt(n)}d`);
export const fmtPct = (n: number): string => `${Math.round(n * 100)}%`;

/** Whole dollars: cents on a pipeline figure are noise. */
export function fmtMoney(n: number | null): string {
  if (n === null) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `$${Math.round(n / 1000)}k`;
  return `$${fmtInt(Math.round(n))}`;
}

// --- the frame every chart sits in ----------------------------------------

/**
 * A chart with its title, its period-and-filter caption, and an honest empty
 * state. §9: "Say 'no completed projects yet' rather than rendering a zero that
 * looks like a failure."
 */
export function Chart({
  title,
  caption,
  note,
  empty,
  isEmpty,
  children,
  wide,
  png = true,
}: {
  title: string;
  caption: string;
  /** Extra small print — what a toggle is currently doing, or a caveat. */
  note?: React.ReactNode;
  empty: string;
  isEmpty: boolean;
  children?: React.ReactNode;
  wide?: boolean;
  /** false for the panels that are tables rather than an SVG. */
  png?: boolean;
}) {
  return (
    <section className={`panel chart${wide ? ' chart-wide' : ''}`}>
      <header className="chart-head">
        <div>
          <h2>{title}</h2>
          <p className="chart-caption">{caption}</p>
        </div>
        {png && !isEmpty && <ChartPng name={title} />}
      </header>
      {isEmpty ? <p className="chart-empty">{empty}</p> : children}
      {note && !isEmpty && <p className="chart-note">{note}</p>}
    </section>
  );
}

/** A colour key. Always present, because a bar chart with segments needs one. */
export function Legend({ items }: { items: Array<{ label: string; colour: string }> }) {
  return (
    <ul className="chart-legend">
      {items.map((i) => (
        <li key={i.label}>
          <span className="swatch" style={{ background: i.colour }} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export const stageLegend = (stages: readonly StageKey[] = STAGES) =>
  stages.map((s) => ({ label: STAGE_LABELS[s], colour: STAGE_COLOURS[s] }));

export const bandLegend = () =>
  AGE_BANDS.map((b) => ({ label: BAND_LABELS[b], colour: BAND_COLOURS[b] }));

// --- geometry --------------------------------------------------------------

const W = 720;
const ROW_H = 26;
const ROW_GAP = 6;
const LABEL_W = 138;
/** Room for a count and a second figure beside it, without them colliding. */
const SUB_W = 48;
const VALUE_W = 96;
const BAR_W = W - LABEL_W - VALUE_W;

/**
 * The SVG shell. A viewBox plus width:100% is the whole responsive story: the
 * chart shrinks to 380px without a media query, and scales up no further than
 * its design width so the type never becomes a poster.
 */
function Svg({
  height,
  label,
  children,
}: {
  height: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <svg
      className="chart-svg"
      viewBox={`0 0 ${W} ${height}`}
      role="img"
      aria-label={label}
      preserveAspectRatio="xMinYMin meet"
    >
      {children}
    </svg>
  );
}

const Text = ({
  x,
  y,
  children,
  anchor = 'start',
  size = 12,
  colour = INK,
  weight,
}: {
  x: number;
  y: number;
  children: React.ReactNode;
  anchor?: 'start' | 'middle' | 'end';
  size?: number;
  colour?: string;
  weight?: number;
}) => (
  <text
    x={x}
    y={y}
    fontSize={size}
    fill={colour}
    textAnchor={anchor}
    fontWeight={weight}
    fontFamily="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
    dominantBaseline="middle"
  >
    {children}
  </text>
);

/** Trim a long label to fit the label gutter without overlapping the bar. */
const clip = (s: string, max = 20): string => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/**
 * Every label below is built as ONE template string rather than adjacent JSX
 * expressions. React separates adjacent children with comment nodes in the
 * rendered output, so `{value}{unit}` becomes `7<!-- -->d` — which breaks
 * copying a figure out of a chart, and breaks anything reading the markup.
 */
const tick = axisTick;

// --- segmented horizontal bars --------------------------------------------

export interface Segment {
  key: string;
  value: number;
  colour: string;
  label: string;
}

export interface BarRow {
  key: string;
  label: string;
  total: number;
  segments: Segment[];
  /** Right-hand figure. Defaults to the total. */
  valueLabel?: string;
  /**
   * A second figure beside the first — a share, or a sample size.
   *
   * It is a separate field rather than more text in valueLabel because putting
   * two numbers in one string produces "3 75%", which reads as one number:
   * three hundred and seventy-five percent. Kept apart they are drawn in
   * different weights and colours, which is what makes them two facts.
   */
  valueSub?: string;
  href?: string;
}

/**
 * Horizontal stacked bars, scaled to the largest row. Used for the stage funnel
 * (segmented by age band), workload by PM and by dealer (segmented by stage),
 * and the histogram (one segment).
 *
 * Every segment carries a <title>, so hovering gives the count and the category
 * without any JavaScript, and a screen reader gets the same text.
 */
export function StackedBars({
  rows,
  label,
  max,
}: {
  rows: BarRow[];
  label: string;
  max?: number;
}) {
  const peak = Math.max(1, max ?? Math.max(...rows.map((r) => r.total), 1));
  const height = rows.length * (ROW_H + ROW_GAP) + 4;

  return (
    <Svg height={height} label={label}>
      {rows.map((row, i) => {
        const y = i * (ROW_H + ROW_GAP) + 2;
        let x = LABEL_W;
        // §4: clicking a stage opens the project list filtered to it. An SVG <a>
        // is a real link — keyboard-reachable, right-clickable, and it survives
        // into the PNG as an inert group.
        const Row = row.href
          ? ({ children }: { children: React.ReactNode }) => <a href={row.href}>{children}</a>
          : ({ children }: { children: React.ReactNode }) => <>{children}</>;
        return (
          <Row key={row.key}>
            <Text x={LABEL_W - 8} y={y + ROW_H / 2} anchor="end" colour={INK_SOFT}>
              {clip(row.label)}
            </Text>
            {/* The track: gives an empty row a visible baseline rather than
                nothing at all, so 'zero' looks deliberate. */}
            <rect x={LABEL_W} y={y + 5} width={BAR_W} height={ROW_H - 10} fill={GRID} rx={3} />
            {row.segments
              .filter((s) => s.value > 0)
              .map((s) => {
                const w = (s.value / peak) * BAR_W;
                const rect = (
                  <g key={s.key}>
                    <rect x={x} y={y + 3} width={Math.max(w, 1.5)} height={ROW_H - 6} fill={s.colour}>
                      <title>{`${row.label} · ${s.label}: ${fmtInt(s.value)}`}</title>
                    </rect>
                  </g>
                );
                x += w;
                return rect;
              })}
            {/* Two right-hand fields on their own baselines: the count bold at a
                fixed column, the secondary figure lighter and smaller against
                the right edge. Both are right-aligned so the numbers line up
                down the chart instead of drifting with their width. */}
            <Text
              x={row.valueSub ? W - SUB_W : W}
              y={y + ROW_H / 2}
              anchor="end"
              weight={600}
            >
              {row.valueLabel ?? fmtInt(row.total)}
            </Text>
            {row.valueSub && (
              <Text x={W} y={y + ROW_H / 2} anchor="end" size={11.5} colour={INK_SOFT}>
                {row.valueSub}
              </Text>
            )}
          </Row>
        );
      })}
    </Svg>
  );
}

/** Plain single-colour bars — the histogram and the simple per-PM counts. */
export function Bars({
  rows,
  label,
  colour = STAGE_COLOURS.design,
}: {
  rows: Array<{
    key: string;
    label: string;
    value: number;
    valueLabel?: string;
    valueSub?: string;
  }>;
  label: string;
  colour?: string;
}) {
  return (
    <StackedBars
      label={label}
      rows={rows.map((r) => ({
        key: r.key,
        label: r.label,
        total: r.value,
        valueLabel: r.valueLabel,
        valueSub: r.valueSub,
        segments: [{ key: r.key, value: r.value, colour, label: r.label }],
      }))}
    />
  );
}

// --- vertical columns ------------------------------------------------------

/**
 * Average (or median) days per stage — the one chart that is genuinely a column
 * chart, because the seven stages are a sequence and reading them left to right
 * is the point (§5: "shows exactly where the time goes").
 */
export function Columns({
  rows,
  label,
  unit = 'd',
}: {
  rows: Array<{ key: string; label: string; value: number | null; colour: string; sub?: string }>;
  label: string;
  unit?: string;
}) {
  const H = 210;
  const base = H - 34;
  const top = 16;
  const { max: peak, step } = niceAxis(Math.max(...rows.map((r) => r.value ?? 0)));
  const colW = W / rows.length;
  const barW = Math.min(64, colW * 0.56);

  return (
    <Svg height={H} label={label}>
      {/* Four gridlines at whole steps: enough to read a height off, few enough
          to stay quiet. */}
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={0} x2={W} y1={base - (base - top) * f} y2={base - (base - top) * f} stroke={GRID} />
          <Text x={2} y={base - (base - top) * f - 7} size={10} colour={INK_SOFT}>
            {`${tick(step * f * 4)}${unit}`}
          </Text>
        </g>
      ))}
      <line x1={0} x2={W} y1={base} y2={base} stroke={LINE} />
      {rows.map((r, i) => {
        const cx = i * colW + colW / 2;
        const h = r.value === null ? 0 : ((base - top) * r.value) / peak;
        return (
          <g key={r.key}>
            {r.value === null ? (
              <Text x={cx} y={base - 12} anchor="middle" size={11} colour={INK_SOFT}>
                no data
              </Text>
            ) : (
              <>
                <rect x={cx - barW / 2} y={base - h} width={barW} height={h} fill={r.colour} rx={2}>
                  <title>{`${r.label}: ${r.value}${unit}${r.sub ? ` (${r.sub})` : ''}`}</title>
                </rect>
                <Text x={cx} y={base - h - 9} anchor="middle" size={11} weight={600}>
                  {`${r.value}${unit}`}
                </Text>
              </>
            )}
            <Text x={cx} y={base + 13} anchor="middle" size={10.5} colour={INK_SOFT}>
              {clip(r.label, 12)}
            </Text>
            {r.sub && (
              <Text x={cx} y={base + 26} anchor="middle" size={9.5} colour={INK_SOFT}>
                {r.sub}
              </Text>
            )}
          </g>
        );
      })}
    </Svg>
  );
}

// --- line chart ------------------------------------------------------------

/**
 * A trend over months. §5 calls the completion-time trend "the single best
 * measure of whether the operation is improving", so it gets a real line with
 * its points marked and both ends labelled — a line whose values you cannot read
 * is decoration.
 */
export function LineChart({
  points,
  label,
  unit = 'd',
  colour = STAGE_COLOURS.design,
}: {
  points: Array<{ label: string; value: number | null; sub?: string }>;
  label: string;
  unit?: string;
  colour?: string;
}) {
  const H = 200;
  const base = H - 30;
  const top = 20;
  const left = 34;
  const { max: peak, step: tickStep } = niceAxis(Math.max(...points.map((p) => p.value ?? 0)));
  const step = points.length > 1 ? (W - left - 14) / (points.length - 1) : 0;
  const x = (i: number) => left + i * step;
  const y = (v: number) => base - ((base - top) * v) / peak;

  const drawn = points.map((p, i) => ({ ...p, i })).filter((p) => p.value !== null);
  const path = drawn.map((p, n) => `${n === 0 ? 'M' : 'L'}${x(p.i)},${y(p.value!)}`).join(' ');

  return (
    <Svg height={H} label={label}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={left} x2={W} y1={base - (base - top) * f} y2={base - (base - top) * f} stroke={GRID} />
          <Text x={0} y={base - (base - top) * f} size={10} colour={INK_SOFT}>
            {`${tick(tickStep * f * 4)}${unit}`}
          </Text>
        </g>
      ))}
      {drawn.length > 1 && <path d={path} fill="none" stroke={colour} strokeWidth={2} />}
      {drawn.map((p) => (
        <g key={p.i}>
          <circle cx={x(p.i)} cy={y(p.value!)} r={3.5} fill={colour}>
            <title>{`${p.label}: ${p.value}${unit}${p.sub ? ` · ${p.sub}` : ''}`}</title>
          </circle>
        </g>
      ))}
      {/* Label the ends only: twelve numbers along a line is a table. */}
      {drawn.length > 0 && (
        <>
          <Text x={x(drawn[0].i)} y={y(drawn[0].value!) - 12} anchor="middle" size={11} weight={600}>
            {`${drawn[0].value}${unit}`}
          </Text>
          {drawn.length > 1 && (
            <Text
              x={x(drawn[drawn.length - 1].i)}
              y={y(drawn[drawn.length - 1].value!) - 12}
              anchor="end"
              size={11}
              weight={600}
            >
              {`${drawn[drawn.length - 1].value}${unit}`}
            </Text>
          )}
        </>
      )}
      {points.map((p, i) => (
        // Every other label on a twelve-month axis, so they never collide.
        (i % 2 === 0 || points.length <= 7) && (
          <Text key={p.label} x={x(i)} y={base + 14} anchor="middle" size={10} colour={INK_SOFT}>
            {p.label}
          </Text>
        )
      ))}
    </Svg>
  );
}

/** Distinct enough to tell six lines apart, and lightness-ordered for greyscale. */
export const SERIES_COLOURS = ['#1f3a63', '#4b86b4', '#c9a227', '#1a7f4b', '#8f4bb4', '#b3261e'];

/**
 * Several lines over the same months — the dealer volume trend of §6, "who is
 * growing and who has gone quiet".
 *
 * Capped at six series plus an "others" line, because a dozen overlapping lines
 * is a plate of spaghetti and the seventh-largest dealer is not the question this
 * chart is asked. The cap is reported by the caller rather than applied silently.
 */
export function MultiLine({
  months,
  series,
  label,
}: {
  months: string[];
  series: Array<{ key: string; label: string; values: number[]; colour: string }>;
  label: string;
}) {
  const H = 220;
  const base = H - 30;
  const top = 16;
  const left = 30;
  const { max: peak, step: tickStep } = niceAxis(Math.max(0, ...series.flatMap((s) => s.values)));
  const step = months.length > 1 ? (W - left - 12) / (months.length - 1) : 0;
  const x = (i: number) => left + i * step;
  const y = (v: number) => base - ((base - top) * v) / peak;

  return (
    <Svg height={H} label={label}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={left} x2={W} y1={base - (base - top) * f} y2={base - (base - top) * f} stroke={GRID} />
          <Text x={0} y={base - (base - top) * f} size={10} colour={INK_SOFT}>
            {tick(tickStep * f * 4)}
          </Text>
        </g>
      ))}
      {series.map((s) => (
        <g key={s.key}>
          {months.length > 1 && (
            <path
              d={s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ')}
              fill="none"
              stroke={s.colour}
              strokeWidth={1.8}
            />
          )}
          {s.values.map((v, i) => (
            <circle key={i} cx={x(i)} cy={y(v)} r={2.6} fill={s.colour}>
              <title>{`${s.label} · ${months[i]}: ${fmtInt(v)}`}</title>
            </circle>
          ))}
        </g>
      ))}
      {months.map((m, i) =>
        i % 2 === 0 || months.length <= 7 ? (
          <Text key={m} x={x(i)} y={base + 14} anchor="middle" size={10} colour={INK_SOFT}>
            {m}
          </Text>
        ) : null
      )}
    </Svg>
  );
}

/** Stacked columns per month — the stage-time breakdown of §5. */
export function StackedColumns({
  points,
  label,
  keys,
}: {
  points: Array<{ label: string; values: Record<string, number> }>;
  label: string;
  keys: Array<{ key: string; label: string; colour: string }>;
}) {
  const H = 210;
  const base = H - 26;
  const top = 14;
  const totals = points.map((p) => keys.reduce((sum, k) => sum + (p.values[k.key] ?? 0), 0));
  const peak = Math.max(1, ...totals);
  const colW = W / Math.max(points.length, 1);
  const barW = Math.min(52, colW * 0.6);

  return (
    <Svg height={H} label={label}>
      <line x1={0} x2={W} y1={base} y2={base} stroke={LINE} />
      {points.map((p, i) => {
        const cx = i * colW + colW / 2;
        let yCursor = base;
        return (
          <g key={p.label}>
            {keys.map((k) => {
              const v = p.values[k.key] ?? 0;
              if (v <= 0) return null;
              const h = ((base - top) * v) / peak;
              yCursor -= h;
              return (
                <rect key={k.key} x={cx - barW / 2} y={yCursor} width={barW} height={h} fill={k.colour}>
                  <title>{`${p.label} · ${k.label}: ${Math.round(v)}d`}</title>
                </rect>
              );
            })}
            <Text x={cx} y={yCursor - 8} anchor="middle" size={10.5} weight={600}>
              {Math.round(totals[i])}d
            </Text>
            <Text x={cx} y={base + 13} anchor="middle" size={10} colour={INK_SOFT}>
              {p.label}
            </Text>
          </g>
        );
      })}
    </Svg>
  );
}

// --- sparkline -------------------------------------------------------------

/** The 12-week active-projects sparkline on the headline card (§3). */
export function Sparkline({ points, label }: { points: number[]; label: string }) {
  if (points.length < 2) return null;
  const w = 108;
  const h = 26;
  const peak = Math.max(...points);
  const floor = Math.min(...points);
  const span = peak - floor || 1;
  const step = w / (points.length - 1);
  const d = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - 2 - ((h - 4) * (v - floor)) / span).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      <path d={d} fill="none" stroke={STAGE_COLOURS.permits} strokeWidth={1.6} />
    </svg>
  );
}

// --- heat map --------------------------------------------------------------

/**
 * The stage matrix (§6) — "the most information-dense chart on the dashboard".
 *
 * A table rather than an SVG, and deliberately: it needs a real header row for
 * screen readers, it needs to scroll horizontally on a phone (§9), and every row
 * is a link to the project. Colour is a five-step ramp on days-in-stage, with the
 * number printed in the cell so it never depends on the colour.
 */
export function HeatMap({
  rows,
  columns,
}: {
  rows: Array<{ id: string; name: string; stage: StageKey; cells: Array<{ key: string; days: number | null }> }>;
  columns: Array<{ key: string; label: string }>;
}) {
  return (
    <div className="heat-wrap">
      <table className="heat">
        <thead>
          <tr>
            <th scope="col">Project</th>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">
                <Link href={`/projects/${r.id}`}>{r.name}</Link>
                <span className="dim"> {STAGE_LABELS[r.stage]}</span>
              </th>
              {r.cells.map((c) => (
                <td
                  key={c.key}
                  style={c.days === null ? undefined : { background: heatColour(c.days), color: c.days > 45 ? '#fff' : INK }}
                >
                  {c.days === null ? <span className="dim">·</span> : c.days}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Five steps, and only the last is red — 60+ days in one stage is a problem. */
function heatColour(days: number): string {
  if (days <= 7) return '#eef3f0';
  if (days <= 14) return '#cfe0e8';
  if (days <= 30) return '#9dc0d3';
  if (days <= 60) return AMBER;
  return DANGER;
}

export const HEAT_LEGEND = [
  { label: '0–7 days', colour: '#eef3f0' },
  { label: '8–14', colour: '#cfe0e8' },
  { label: '15–30', colour: '#9dc0d3' },
  { label: '31–60', colour: AMBER },
  { label: '60+', colour: DANGER },
];

// --- stat cards ------------------------------------------------------------

export type Tone = 'plain' | 'amber' | 'danger' | 'ok';

/**
 * A headline number. Clickable, always: §3 — "A number nobody can drill into is
 * a number nobody trusts."
 */
export function StatCard({
  value,
  label,
  href,
  change,
  changeLabel,
  tone = 'plain',
  spark,
  hint,
  goodDirection = 'up',
}: {
  value: string;
  label: string;
  href: string;
  change?: number | null;
  changeLabel?: string;
  tone?: Tone;
  spark?: number[];
  hint?: string;
  /** Which way is good news, for colouring the arrow honestly. */
  goodDirection?: 'up' | 'down';
}) {
  const arrow = change === null || change === undefined || change === 0 ? null : change > 0 ? '▲' : '▼';
  const good =
    change === null || change === undefined || change === 0
      ? null
      : goodDirection === 'up'
        ? change > 0
        : change < 0;

  return (
    <Link className={`stat-card stat-link tone-${tone}`} href={href}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {spark && spark.length > 1 && <Sparkline points={spark} label={`${label}, last 12 weeks`} />}
      {arrow && (
        <span className={`stat-change ${good ? 'good' : 'bad'}`}>
          {arrow} {Math.abs(change!)} {changeLabel ?? 'vs last period'}
        </span>
      )}
      {!arrow && changeLabel && <span className="stat-change flat">{changeLabel}</span>}
      {hint && <span className="stat-hint">{hint}</span>}
    </Link>
  );
}

export { INK, INK_SOFT, LINE, GRID, AMBER, DANGER, OK };
