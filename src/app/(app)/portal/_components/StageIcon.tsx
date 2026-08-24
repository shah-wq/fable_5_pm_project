import { STAGE_ICON } from '@/lib/portal/home';
import type { StageKey } from '@/lib/stages/definitions';

/**
 * A stage-specific icon in a tinted tile (§3, §5).
 *
 * The point is recognition rather than decoration: a homeowner who opens this
 * app once a week starts to know the pencil means design and the stamp means
 * permits, and the tile becomes a landmark on the screen before any of the text
 * is read.
 *
 * Hand-drawn rather than an icon dependency — seven glyphs is not worth a
 * package, and these are the seven that will ever be needed.
 */
export function StageIcon({ stage, paused = false }: { stage: StageKey; paused?: boolean }) {
  const kind = paused ? 'pause' : STAGE_ICON[stage];
  return (
    <span className={`stage-tile${paused ? ' paused' : ''}`} aria-hidden>
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        {kind === 'ruler' && (
          <>
            <path d="M3.8 14.4 14.4 3.8a1 1 0 0 1 1.4 0l4.4 4.4a1 1 0 0 1 0 1.4L9.6 20.2a1 1 0 0 1-1.4 0l-4.4-4.4a1 1 0 0 1 0-1.4Z" />
            <path d="M8 10l2 2M11 7l2 2M14.5 13.5l2 2M11.5 16.5l2 2" />
          </>
        )}
        {kind === 'pencil' && (
          <>
            <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
            <path d="M14.5 5.5l3 3" />
            <path d="M4 20h16" />
          </>
        )}
        {kind === 'stamp' && (
          <>
            <path d="M9 3.5h6a2 2 0 0 1 2 2.2l-.5 4a1 1 0 0 0 1 1.1h.5a2 2 0 0 1 2 2v2.7H4v-2.7a2 2 0 0 1 2-2h.5a1 1 0 0 0 1-1.1l-.5-4A2 2 0 0 1 9 3.5Z" />
            <path d="M4.5 19.5h15" />
          </>
        )}
        {kind === 'truck' && (
          <>
            <path d="M2.5 7.5h10v8h-10z" />
            <path d="M12.5 10.5H17l3 3v2h-7.5z" />
            <circle cx="6.5" cy="17.5" r="1.8" />
            <circle cx="16.5" cy="17.5" r="1.8" />
          </>
        )}
        {kind === 'tools' && (
          <>
            <path d="M14.2 6.2a3.4 3.4 0 0 1 4.7 4.7l-9 9-4.7-4.7 9-9Z" />
            <path d="M13 7.5 16.5 11" />
            <path d="M4.5 5l3 3-1.5 1.5-3-3a2.1 2.1 0 0 1 1.5-1.5Z" />
          </>
        )}
        {kind === 'plug' && (
          <>
            <path d="M9 3.5v5M15 3.5v5" />
            <path d="M6.5 8.5h11v2.2a5.5 5.5 0 0 1-11 0V8.5Z" />
            <path d="M12 16.2v4.3" />
          </>
        )}
        {kind === 'sun' && (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
          </>
        )}
        {kind === 'pause' && (
          <>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M10 9v6M14 9v6" />
          </>
        )}
      </svg>
    </span>
  );
}
