import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { loadProjectCards } from '@/lib/stages/service';
import { Board } from './Board';

export const dynamic = 'force-dynamic';

/**
 * The Kanban pipeline: seven stage columns (Complete is terminal), drag-and-
 * drop between adjacent columns with the same validation as the advance
 * button. The Projects tab (/projects) is the table view over the same data.
 */
export default async function PipelinePage() {
  const session = await guardPath('/pipeline');
  const cards = await loadProjectCards(session, { includeCompleted: true });

  return (
    <main className="board-page">
      <div className="board-header">
        <h1>Pipeline</h1>
        <div className="board-actions">
          <Link className="btn-link" href="/projects">
            Projects table
          </Link>
          <Link className="btn-link primary" href="/projects/new">
            + New project
          </Link>
        </div>
      </div>
      <Board cards={cards} isAdmin={session.role === 'admin'} />
    </main>
  );
}
