'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Sending the days that suit you for a survey or an installation.
 *
 * It is a request, not a booking — self-service scheduling against real crew
 * availability is deliberately out of scope until the availability-slots system
 * exists (spec §9), and promising a date the company has not confirmed would be
 * worse than making the customer wait for a call.
 */
export function AvailabilityRequest({
  projectId,
  pmName,
  hasOpenRequest,
}: {
  projectId: string;
  pmName: string | null;
  hasOpenRequest: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [dates, setDates] = useState('');
  const [window_, setWindow] = useState('morning');
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setState('busy');
    setError(null);
    const res = await fetch('/api/portal/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        kind: 'availability',
        preferredDates: dates.trim(),
        timeWindow: window_,
      }),
    });
    if (res.ok) {
      setState('sent');
      setOpen(false);
      router.refresh();
      return;
    }
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    setError(json?.error ?? 'Could not send that — please try again.');
    setState('idle');
  }

  if (hasOpenRequest && state !== 'sent') {
    return (
      <p className="notice hold">
        We have your preferred dates. {pmName ?? 'Your project manager'} will confirm the actual
        appointment with you.
      </p>
    );
  }

  if (state === 'sent') {
    return (
      <p className="notice ok" role="status">
        Thank you — {pmName ?? 'your project manager'} will confirm the actual date with you.
      </p>
    );
  }

  return (
    <section className="panel">
      <h2>When would suit you?</h2>
      <p className="dim">
        Tell us the days that work and we will fit you in. This is a request, not a booking — we
        will confirm the date with you before anyone turns up.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {open ? (
        <>
          <label className="field">
            <span>Days that work for you</span>
            <input
              value={dates}
              onChange={(e) => setDates(e.target.value)}
              placeholder="e.g. Tue 12th or Wed 13th"
            />
          </label>
          <label className="field">
            <span>Time of day</span>
            <select value={window_} onChange={(e) => setWindow(e.target.value)}>
              <option value="morning">Morning</option>
              <option value="afternoon">Afternoon</option>
              <option value="any">Any time</option>
            </select>
          </label>
          <div className="row-actions">
            <button
              className="btn"
              type="button"
              onClick={send}
              disabled={state === 'busy' || dates.trim().length < 3}
            >
              {state === 'busy' ? 'Sending…' : 'Send my availability'}
            </button>
            <button className="btn secondary" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button className="btn" type="button" onClick={() => setOpen(true)}>
          Send my availability
        </button>
      )}
    </section>
  );
}
