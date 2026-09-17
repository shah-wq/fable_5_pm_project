import { guardPath } from '@/lib/auth/session';
import { withOwner } from '@/lib/db';
import { migrationState } from '@/lib/db-migrations';
import { AdminTabs } from '../_components/AdminTabs';
import { DatabasePanel } from './DatabasePanel';

export const dynamic = 'force-dynamic';

/**
 * Admin § Database.
 *
 * Which migrations this database has, and a button that applies the rest
 * through the application's own connection. The clipboard-and-console route
 * this replaces is described in lib/db-apply.ts, along with why it had to go.
 */
export default async function AdminDatabasePage() {
  await guardPath('/admin/database');

  let state: { applied: Record<string, boolean>; behind: string[] } | null = null;
  let failure: string | null = null;
  try {
    state = await withOwner((c) => migrationState(c));
  } catch (e) {
    failure = (e as Error).message;
  }

  const endpoint = (() => {
    try {
      const id = new URL(process.env.DATABASE_URL ?? '').hostname.split('.')[0].replace(/-pooler$/, '');
      return id.length > 12 ? `${id.slice(0, 3)}****${id.slice(-8)}` : id || null;
    } catch {
      return null;
    }
  })();

  return (
    <main className="table-page">
      <h1>Admin</h1>
      <AdminTabs />
      <h2 className="section-title">Database</h2>
      <p className="dim">
        The application and its database move separately: code reaches the host on push, and the
        schema has to catch up. This is where it does. Every change ships as a migration file inside
        the deployment; this screen shows which of them the database has, and applies the rest
        through the same connection every page uses.
        {endpoint && (
          <>
            {' '}Connected to endpoint <code>{endpoint}</code>.
          </>
        )}
      </p>

      {failure ? (
        <p className="notice error" role="alert">
          {`Could not read the database: ${failure}`}
        </p>
      ) : state ? (
        <DatabasePanel behind={state.behind} applied={state.applied} />
      ) : null}
    </main>
  );
}
