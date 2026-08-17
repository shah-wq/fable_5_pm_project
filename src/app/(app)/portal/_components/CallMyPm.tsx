/**
 * The most-used control on the Home screen (spec §3.1), so it sits above the
 * tab bar and does not scroll away. Tap-to-call and tap-to-email — a homeowner
 * with a question wants a person, not a form.
 */
export function CallMyPm({
  name,
  phone,
  email,
}: {
  name: string | null;
  phone: string | null;
  email: string | null;
}) {
  if (!phone && !email) {
    return (
      <div className="call-bar">
        <span className="dim">Your project manager is being assigned.</span>
      </div>
    );
  }

  return (
    <div className="call-bar">
      <span className="call-who">{name ?? 'Your project manager'}</span>
      <span className="call-actions">
        {phone && (
          <a className="btn" href={`tel:${phone.replace(/[^\d+]/g, '')}`}>
            Call
          </a>
        )}
        {email && (
          <a className="btn secondary" href={`mailto:${email}`}>
            Email
          </a>
        )}
      </span>
    </div>
  );
}
