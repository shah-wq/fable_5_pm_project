/**
 * The hero of the redesigned home screen (§3): a ring filled to the project's
 * completion percentage, with the stage position in the middle.
 *
 * The current screen never answers 'how far along am I?'. A numbered list of
 * seven stages does not answer it either — a customer would have to count. One
 * glance at a ring does.
 *
 * Two circles and one animated stroke-dashoffset, drawn server-side. No chart
 * library, no client component, nothing to hydrate: this is the first thing on
 * the page and it should be painted by the time the HTML lands.
 *
 * The offset is passed as a custom property and also set as the static value, so
 * the ring is correct with every animation removed — the stroke-draw in
 * globals.css lives inside a prefers-reduced-motion query and animates *to* this
 * same number (§4).
 */
export function ProgressRing({
  percent,
  index,
  total,
  /** A held project's ring stops where it is and loses its accent (§5). */
  paused = false,
}: {
  percent: number;
  index: number;
  total: number;
  paused?: boolean;
}) {
  const size = 76;
  const stroke = 7;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = circumference * (1 - clamped / 100);

  return (
    <div className={`ring${paused ? ' paused' : ''}`}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${clamped}% complete — stage ${index} of ${total}`}
      >
        {/* Rotated so the fill starts at twelve o'clock rather than three. */}
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            className="ring-track"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
          />
          <circle
            className="ring-fill"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            style={
              {
                strokeDasharray: circumference,
                strokeDashoffset: offset,
                '--dash-full': circumference,
                '--dash-offset': offset,
              } as React.CSSProperties
            }
          />
        </g>
      </svg>
      {/* One template string: React inserts comment nodes between adjacent
          expressions, which would split '14' from '%' for anything reading the
          rendered text. */}
      <span className="ring-value" aria-hidden>
        {`${clamped}%`}
      </span>
    </div>
  );
}
