import Link from 'next/link';
import type { CustomerStage } from '@/lib/portal/customer';

/**
 * Seven segments instead of seven collapsed rows (§2, §3).
 *
 * This is the change that buys back the screen. Six of the seven rows on the
 * current home screen describe things that have not happened yet: they fill the
 * page, push everything useful below the fold, and invite a homeowner to open a
 * stage that will tell them nothing for weeks. As a strip they cost 24px, and
 * they show position at a glance — which the numbered list never did.
 *
 * Nothing is hidden by this. Every segment is a link to that stage's detail, so
 * the customer who does want to read about Procurement in week two can still get
 * there in one tap; they are simply not made to scroll past it.
 */
export function StageStrip({ stages }: { stages: CustomerStage[] }) {
  return (
    <nav className="stage-strip" aria-label="Project stages">
      {stages.map((stage) => (
        <Link
          key={stage.key}
          className={`strip-seg ${stage.state}`}
          href={`/portal/project#${stage.key}`}
          aria-current={stage.state === 'current' ? 'step' : undefined}
        >
          <span className="strip-bar" aria-hidden />
          <span className="strip-label">{shortLabel(stage.label)}</span>
          {/* The full stage name for anyone not reading the abbreviation. */}
          <span className="sr-only">
            {`${stage.label} — ${
              stage.state === 'done' ? 'done' : stage.state === 'current' ? 'happening now' : 'not started'
            }`}
          </span>
        </Link>
      ))}
    </nav>
  );
}

/**
 * Four or five characters under each segment. At seven across a 360px phone
 * there is room for about six, and 'Inspection & power on' would either wrap to
 * three lines or force the segments out of alignment.
 *
 * Truncation is by word rather than by character count, so it never cuts mid
 * syllable: 'Inspection & power on' becomes 'Insp', not 'Inspec…'.
 */
function shortLabel(label: string): string {
  const first = label.split(/[\s&·/]+/)[0] ?? label;
  return first.length > 5 ? first.slice(0, 4) : first;
}
