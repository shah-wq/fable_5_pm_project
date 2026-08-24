import Link from 'next/link';
import type { DoorId } from '@/lib/auth/roles';
import { Notice } from './AuthUi';
import { PasswordLoginForm } from './PasswordLoginForm';
import { RoleDoors, type DoorKey } from './RoleDoors';

/**
 * One sign-in screen, rendered three times with different props (§9).
 *
 * "The three pages must not be three implementations. They share one login
 * endpoint, one validation path, one rate limiter and one role-routing function
 * — the pages differ only in heading text, sub-copy and which links they show.
 * Three separate implementations is how you end up with a security fix applied
 * to two of them."
 *
 * So everything that could drift lives here: the form, the error handling, the
 * forgot-password link and its return path, the tab order. A page below is a
 * heading, a sentence, and which other doors to offer.
 *
 * Tab order is the DOM order, deliberately (§8): email → password → sign in →
 * forgot → dealer → homeowner. The password field's show/hide button sits inside
 * that control, which is where a keyboard user expects it.
 */
/** The door ids used for routing, mapped to the buttons' own names. */
const DOOR_KEY: Record<DoorId, DoorKey> = {
  staff: 'staff',
  dealer: 'dealer',
  customer: 'homeowner',
};

export function SignInScreen({
  door,
  heading,
  sub,
  next,
  error,
  /** Small print between the form and the other doors — audience-specific. */
  aside,
  /**
   * Show the other two doors as buttons. True on every page in a browser; false
   * only inside the store app, which has one audience and no role choice (§6).
   */
  showDoors = true,
}: {
  door: DoorId;
  heading: string;
  sub: string;
  next?: string;
  error?: React.ReactNode;
  aside?: React.ReactNode;
  showDoors?: boolean;
}) {
  // §7: the reset link returns the user to the page they started from, so a
  // homeowner ends up back on the homeowner page rather than the staff one.
  const resetHref = door === 'staff' ? '/login/reset' : `/login/reset?from=${door}`;

  return (
    <>
      <h1>{heading}</h1>
      <p className="sub">{sub}</p>
      {error && <Notice kind="error">{error}</Notice>}

      <PasswordLoginForm door={door} next={next} />

      <div className="auth-links">
        <Link href={resetHref}>Forgot your password?</Link>
        {aside}
      </div>

      {/* All three doors are the same size on every page, minus the one you are
          standing on. Somebody who opened the wrong page needs the way out to be
          as findable as the way in was — which a line of grey text is not. */}
      {showDoors && (
        <RoleDoors current={DOOR_KEY[door]} show={['staff', 'dealer', 'homeowner']} />
      )}
    </>
  );
}
