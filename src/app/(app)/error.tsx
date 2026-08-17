'use client';

/**
 * What a staff user sees when a page throws.
 *
 * The default is a bare white screen reading "Application error: a server-side
 * exception has occurred" with an opaque digest — no way to tell whether the
 * database is behind, the deployment is stale, or something is genuinely
 * broken. This replaces it with the three facts that actually resolve it: which
 * build is running, where to look, and a way to retry without losing the tab.
 *
 * Next.js deliberately withholds the error message from the client in
 * production, so this cannot show what went wrong — but it can point at
 * /api/health, which names any migration the database is missing, the commonest
 * cause by far.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const commit = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? null;

  return (
    <main className="surface">
      <section className="panel">
        <h1>This page could not load</h1>
        <p>
          Something failed on the server while building this page. Your data is not affected —
          nothing was saved or changed.
        </p>

        <h2>What to check, in order</h2>
        <ol className="gap-list">
          <li>
            <strong>Try again</strong> — a database connection can drop briefly.
            <button className="btn secondary small" type="button" onClick={reset} style={{ marginLeft: 8 }}>
              Retry
            </button>
          </li>
          <li>
            Open <a href="/api/health">/api/health</a> and look at{' '}
            <code>migrations.behind</code>. If it lists anything, the database is missing part of a
            recent migration and <code>migrations.fix</code> names the file to run.
          </li>
          <li>
            Check the address bar. A Vercel URL with a hash in it (
            <code>…-a1b2c3d4e-…</code>) is a frozen deployment and will never pick up a fix — use
            the production domain.
          </li>
        </ol>

        <dl className="facts">
          <dt>Running build</dt>
          <dd>
            {commit ? (
              <code>{commit.slice(0, 7)}</code>
            ) : (
              <span className="dim">unknown (not a Vercel deployment)</span>
            )}
          </dd>
          {error.digest && (
            <>
              <dt>Error reference</dt>
              <dd>
                <code>{error.digest}</code>
              </dd>
            </>
          )}
        </dl>
        <p className="dim">
          Quote the running build and the error reference when reporting this — the digest alone
          does not identify which version produced it.
        </p>
      </section>
    </main>
  );
}
