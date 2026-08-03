import { BrandPanel, InlineLogo } from './_components/AuthUi';

/**
 * Shared shell for every login door: navy brand panel with the six-stage
 * rail on the left, the form card on the right. On small screens the panel
 * collapses and an inline logo appears above the card.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-shell">
      <BrandPanel />
      <main className="auth-main">
        <div className="auth-card">
          <InlineLogo />
          {children}
        </div>
      </main>
    </div>
  );
}
