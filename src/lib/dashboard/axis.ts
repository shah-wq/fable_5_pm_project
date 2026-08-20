/**
 * A round top for a chart's y-axis, and a step that divides it into quarters.
 *
 * Scaling an axis to the tallest bar puts the peak exactly at the top, which
 * looks tidy but labels the gridlines with quarters of whatever that peak
 * happens to be: a 7-day peak produced 2d / 4d / 5d / 7d, which reads as a chart
 * that cannot do arithmetic. Rounding the top up to a number divisible by four
 * costs a little headroom and makes every gridline a whole step.
 *
 * Kept out of charts.tsx so the arithmetic can be unit-tested without pulling a
 * JSX module into the test runner.
 */

/**
 * Mantissas deliberately all integers at magnitude ≥ 1, so a days axis is
 * labelled in whole days. The cost is a little more headroom at the 10→20 jump;
 * a "7.5d" gridline would be worse.
 */
const MANTISSAS = [1, 2, 2.5, 3, 4, 5, 6, 8, 10];

export function niceAxis(peak: number): { max: number; step: number } {
  if (!(peak > 0)) return { max: 4, step: 1 };
  const quarter = peak / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(quarter)));
  const step =
    MANTISSAS.map((m) => m * magnitude).find((s) => s >= quarter) ?? 10 * magnitude;
  return { max: step * 4, step };
}

/** Drop a trailing '.0', so a fractional step reads 2.5 / 5 / 7.5 / 10. */
export function axisTick(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(1)));
}
