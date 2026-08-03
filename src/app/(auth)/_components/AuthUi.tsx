/** Presentational pieces shared by the three login doors. Server-safe. */

/** The pipeline every surface shows after login — the first screen teaches
 *  the product's shape. */
const STAGES = ['Intake', 'Survey', 'Design', 'Permitting', 'Install', 'PTO'];

export function Logo() {
  return (
    <>
      <span className="logo-mark" aria-hidden>
        ☀
      </span>
      <span>SolarFlow AI</span>
    </>
  );
}

export function InlineLogo() {
  return (
    <div className="auth-inline-logo">
      <Logo />
    </div>
  );
}

export function BrandPanel() {
  return (
    <aside className="auth-brand">
      <div>
        <div className="auth-brand-logo">
          <Logo />
        </div>
        <p className="auth-brand-tagline">
          Every residential solar project, from signed contract to permission to operate — one
          pipeline, six stages.
        </p>
      </div>
      <ol className="stage-rail" aria-label="Project pipeline stages">
        {STAGES.map((stage, i) => (
          <li key={stage}>
            <span className="stage-num">{i + 1}</span>
            <span className="dot" aria-hidden />
            <span>{stage}</span>
          </li>
        ))}
      </ol>
      <div className="auth-brand-foot">SolarFlow AI</div>
    </aside>
  );
}

export function Notice({ kind, children }: { kind: 'error' | 'ok'; children: React.ReactNode }) {
  return (
    <p className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}
