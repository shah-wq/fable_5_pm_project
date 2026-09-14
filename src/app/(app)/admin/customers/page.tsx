import { redirect } from 'next/navigation';

/**
 * The Customers screen moved to /admin/people (Modules 16–19, Part 1) — "Same
 * screen, same four tabs, now showing prospects as well as customers".
 *
 * The old path stays as a redirect rather than disappearing: it is in people's
 * bookmarks, in the admin tab bar of any page still open, and in at least one
 * email. A renamed screen is not a reason to break a link.
 */
export default function AdminCustomersPage() {
  redirect('/admin/people');
}
