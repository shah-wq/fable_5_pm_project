import Link from 'next/link';

/**
 * The two other doors, as buttons (Sign-in Screens §2, §3).
 *
 * The old page put these at the bottom as two links both labelled 'Sign in
 * here'. §1 is blunt about why that was wrong: dealers and homeowners outnumber
 * staff in daily sign-ins many times over, and they had the least visible route
 * on the page — a line of small grey text, with the audience named before the
 * link so two identical labels sat side by side. Unreadable at a glance,
 * impossible to describe on a phone call.
 *
 * So: full-width, same width as the staff button, stacked rather than side by
 * side, and labelled with the audience AND the action ('Dealer sign-in') so the
 * label survives being read out of context. Outlined rather than filled, because
 * the staff form is still the primary action on the page and two filled buttons
 * would leave nothing primary.
 *
 * They are links, not buttons: this is navigation, not submission — which also
 * means Enter activates them, they can be opened in a new tab, and they are
 * never disabled (§3: "these buttons are always available").
 */

export type DoorKey = 'staff' | 'dealer' | 'homeowner';

interface Door {
  href: string;
  label: string;
  sub: string;
  icon: 'clipboard' | 'building' | 'house';
}

const DOORS: Record<DoorKey, Door> = {
  staff: {
    href: '/login',
    label: 'Staff sign-in',
    sub: 'Run the project pipeline',
    icon: 'clipboard',
  },
  dealer: {
    href: '/login/dealer',
    label: 'Dealer sign-in',
    sub: 'Track the projects you sold',
    icon: 'building',
  },
  homeowner: {
    href: '/login/homeowner',
    label: 'Homeowner sign-in',
    sub: 'Track your solar project',
    icon: 'house',
  },
};

/**
 * Every sign-in page shows the other two doors as buttons of this same size —
 * never a button back to the page you are already on, which would be a control
 * that does nothing.
 *
 * The divider question changes with the page, because 'Not staff?' only makes
 * sense to somebody looking at the staff form. A dealer who opened the wrong
 * page is asking 'not a dealer?', and the heading above the buttons should be
 * the question they are actually asking.
 */
const DIVIDER: Record<DoorKey, string> = {
  staff: 'Not staff?',
  dealer: 'Not a dealer?',
  homeowner: 'Not a homeowner?',
};

export function RoleDoors({ current, show }: { current: DoorKey; show: DoorKey[] }) {
  const doors = show.filter((key) => key !== current);
  if (doors.length === 0) return null;
  return (
    <>
      {/* §3: a plain question, so the reader knows the section below is for
          them. It reads as a question a person would ask, not a category. */}
      <div className="door-divider">
        <span>{DIVIDER[current]}</span>
      </div>
      <div className="role-doors">
        {doors.map((key) => {
          const door = DOORS[key];
          return (
            <Link key={key} className="door-btn" href={door.href}>
              <DoorIcon kind={door.icon} />
              <span className="door-text">
                <span className="door-label">{door.label}</span>
                <span className="door-sub">{door.sub}</span>
              </span>
              <span className="door-chevron" aria-hidden>
                ›
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );
}

/**
 * §8: decorative and aria-hidden. The text label carries the meaning — an icon
 * of a building means 'dealer' only to someone who already knows.
 */
function DoorIcon({ kind }: { kind: 'clipboard' | 'building' | 'house' }) {
  return (
    <svg
      className="door-icon"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {kind === 'clipboard' && (
        <>
          {/* A worked-through checklist: the staff side is the one that does
              things to a project rather than watching one. */}
          <path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1Z" />
          <path d="M8 6H6.5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H16" />
          <path d="M8.5 11.5l1.6 1.6 3.2-3.2" />
          <path d="M8.5 16.5h7" />
        </>
      )}
      {kind === 'building' && (
        <>
          <path d="M4 21V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v15" />
          <path d="M15 10h4a1 1 0 0 1 1 1v10" />
          <path d="M3 21h18" />
          <path d="M7.5 9h1.5M7.5 13h1.5M7.5 17h1.5M11.5 9h1.5M11.5 13h1.5" />
        </>
      )}
      {kind === 'house' && (
        <>
          <path d="M3.5 11 12 4l8.5 7" />
          <path d="M5.5 9.8V20h13V9.8" />
          <path d="M10 20v-5h4v5" />
        </>
      )}
    </svg>
  );
}

/**
 * The same three doors as plain links, for the password-reset page.
 *
 * The sign-in pages themselves all use the buttons above — a dealer who lands on
 * the homeowner page needs a route out that is as easy to find as the one that
 * got them there. Reset is a different situation: the reader came here on
 * purpose, and once the email is sent there is nothing to choose, so a row of
 * 52px buttons would be three large controls nobody needs.
 */
export function AltDoorLinks({ show }: { show: DoorKey[] }) {
  const LABELS = {
    staff: { href: '/login', text: 'Staff sign-in' },
    dealer: { href: '/login/dealer', text: 'Dealer sign-in' },
    homeowner: { href: '/login/homeowner', text: 'Homeowner sign-in' },
  } as const;
  return (
    <span className="alt-doors">
      {show.map((key, i) => (
        <span key={key}>
          {i > 0 && <span aria-hidden> · </span>}
          <Link href={LABELS[key].href}>{LABELS[key].text}</Link>
        </span>
      ))}
    </span>
  );
}
