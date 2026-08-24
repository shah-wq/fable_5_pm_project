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

interface Door {
  href: string;
  label: string;
  sub: string;
  icon: 'building' | 'house';
}

const DOORS: Record<'dealer' | 'homeowner', Door> = {
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

export function RoleDoors({ show }: { show: Array<'dealer' | 'homeowner'> }) {
  if (show.length === 0) return null;
  return (
    <>
      {/* §3: a plain question, so the reader knows the section below is for
          them. It reads as a question a person would ask, not a category. */}
      <div className="door-divider">
        <span>Not staff?</span>
      </div>
      <div className="role-doors">
        {show.map((key) => {
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
function DoorIcon({ kind }: { kind: 'building' | 'house' }) {
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
      {kind === 'building' ? (
        <>
          <path d="M4 21V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v15" />
          <path d="M15 10h4a1 1 0 0 1 1 1v10" />
          <path d="M3 21h18" />
          <path d="M7.5 9h1.5M7.5 13h1.5M7.5 17h1.5M11.5 9h1.5M11.5 13h1.5" />
        </>
      ) : (
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
 * The way back, on the dealer and homeowner pages (§4). Links rather than
 * buttons here: on those pages the other doors are a correction for somebody who
 * took a wrong turn, not an equally-weighted choice.
 */
export function AltDoorLinks({ show }: { show: Array<'staff' | 'dealer' | 'homeowner'> }) {
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
