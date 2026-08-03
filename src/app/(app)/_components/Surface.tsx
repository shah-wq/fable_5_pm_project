/** Placeholder body for surfaces later modules build out. */
export function Surface({
  title,
  intro,
  module,
}: {
  title: string;
  intro: string;
  module: string;
}) {
  return (
    <main className="surface">
      <h1>{title}</h1>
      <p>{intro}</p>
      <div className="placeholder">
        You&apos;re signed in and in the right place — {module} builds this surface. The door,
        the role routing, and the row-level security behind it are already live.
      </div>
    </main>
  );
}
