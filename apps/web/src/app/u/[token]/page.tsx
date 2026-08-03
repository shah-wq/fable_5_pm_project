import { Logo } from '@/app/(auth)/_components/AuthUi';
import { createAnonClient } from '@/lib/supabase/server';
import { GrantUploadForm } from './GrantUploadForm';

/**
 * The no-login upload surface (REQ-SEC-01). The URL token — validated by
 * public.validate_upload_grant, sha-256 at rest, 7-day max expiry — unlocks
 * exactly one project's upload page. No Supabase session is ever created:
 * this whole subtree is excluded from the auth middleware.
 */

const PURPOSE_COPY: Record<string, { title: string; hint: string }> = {
  survey_photos: {
    title: 'Site survey photos',
    hint: 'Roof, attic, main panel, meter, and anything unusual — more photos beat fewer.',
  },
  crew_workorder: {
    title: 'Crew work order uploads',
    hint: 'Completion photos for the work order — panels, wiring, labels, and the finished array.',
  },
  customer_delivery: {
    title: 'Delivery confirmation',
    hint: 'Photos of the delivered equipment. These are visible on your project portal.',
  },
};

export default async function GrantPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const supabase = createAnonClient();
  const { data } = await supabase.rpc('validate_upload_grant', { p_token: token });
  const grant = data?.[0];

  if (!grant) {
    return (
      <div className="grant-shell">
        <div className="grant-card">
          <div className="auth-inline-logo" style={{ display: 'flex' }}>
            <Logo />
          </div>
          <h1>This link is no longer active</h1>
          <p className="meta">
            Upload links work for 7 days and can be revoked by the project team. Ask your contact
            to send a fresh one.
          </p>
        </div>
      </div>
    );
  }

  const copy = PURPOSE_COPY[grant.purpose] ?? {
    title: 'Project uploads',
    hint: 'Add your files below.',
  };

  return (
    <div className="grant-shell">
      <div className="grant-card">
        <div className="auth-inline-logo" style={{ display: 'flex' }}>
          <Logo />
        </div>
        <h1>{copy.title}</h1>
        <p className="meta">
          {grant.project_name} · link expires{' '}
          {new Date(grant.expires_at).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          })}
        </p>
        <GrantUploadForm token={token} hint={copy.hint} />
      </div>
    </div>
  );
}
