import Link from 'next/link';
import { LOGIN_DOORS, type DoorId } from '@/lib/auth/roles';
import { ResetForm } from '../../_components/ResetForm';
import { AltDoorLinks } from '../../_components/RoleDoors';

/**
 * One reset page for all three audiences (§7: "one implementation").
 *
 * `?from=` is the door the user came from, and it is carried all the way
 * through: the emailed link returns them to that page, so a homeowner ends up
 * back on the homeowner door rather than the staff one. That is the whole point
 * of §7's "return page preserved" — a reset that dumps somebody on a page headed
 * 'Staff access' has undone the work the three doors exist to do.
 */
const FROM: Record<string, DoorId> = {
  dealer: 'dealer',
  customer: 'customer',
  homeowner: 'customer',
  staff: 'staff',
};

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  const door: DoorId = (from && FROM[from]) || 'staff';
  const back = LOGIN_DOORS[door];

  return (
    <>
      <h1>Reset your password</h1>
      <p className="sub">
        Enter your account email and we&apos;ll send a link to set a new password.
      </p>
      <ResetForm door={door} />

      {/* §7: most homeowner 'forgot password' attempts are really a first-time
          user who never set one. Saying so here saves the person a wasted email
          and the office a phone call. */}
      {door === 'customer' && (
        <p className="dim reset-hint">
          If this is your first time signing in, you do not need this page — use the link in your
          welcome email to set your password.
        </p>
      )}

      <div className="auth-links">
        <Link href={back.path}>Back to {back.label.toLowerCase()}</Link>
        <span>
          <AltDoorLinks
            show={
              door === 'staff'
                ? ['dealer', 'homeowner']
                : door === 'dealer'
                  ? ['staff', 'homeowner']
                  : ['staff', 'dealer']
            }
          />
        </span>
      </div>
    </>
  );
}
