'use client';

import { useEffect, useState } from 'react';
import { enablePush, pushPermission, pushSupported, store } from '@/lib/native';

/**
 * Asking for notification permission, properly (spec §4).
 *
 * Never on first launch. This card appears only after the customer has seen
 * their project status at least once, and it explains what they will receive
 * before the system dialog appears. On iOS the system prompt can only ever be
 * shown once per install, so a cold ask that gets refused is unrecoverable —
 * which is why the explanation comes first and 'Not now' is a real option that
 * simply hides the card for a fortnight.
 */
const SNOOZE_DAYS = 14;

export function NotificationOptIn() {
  const [state, setState] = useState<'hidden' | 'ask' | 'busy' | 'done' | 'refused'>('hidden');
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    if (!pushSupported()) return;
    if (pushPermission() !== 'default') return;      // already answered, either way
    if (store.get('seenStatus') !== '1') return;     // they have not seen status yet
    const snoozed = store.get('pushSnoozedAt');
    if (snoozed && Date.now() - Number(snoozed) < SNOOZE_DAYS * 86_400_000) return;
    setState('ask');
  }, []);

  async function turnOn() {
    setState('busy');
    const result = await enablePush();
    if (result.ok) {
      setState('done');
      return;
    }
    setReason(result.reason ?? null);
    setState('refused');
  }

  function notNow() {
    store.set('pushSnoozedAt', String(Date.now()));
    setState('hidden');
  }

  if (state === 'hidden') return null;

  if (state === 'done') {
    return (
      <p className="notice ok" role="status">
        Notifications are on. You can change which ones you get under More →
        Notifications.
      </p>
    );
  }

  if (state === 'refused') {
    return (
      <p className="notice hold" role="status">
        {reason ?? 'Notifications could not be turned on.'} You can turn them on later in your
        phone&apos;s settings for this app.
      </p>
    );
  }

  return (
    <section className="panel optin">
      <h2>Want to know when something happens?</h2>
      <p>
        We will send you a notification when your project moves to a new stage, when your
        installation date is confirmed, and if we ever need something from you. That is about six
        messages across the whole project — we are not going to bother you.
      </p>
      <div className="row-actions">
        <button className="btn" type="button" onClick={turnOn} disabled={state === 'busy'}>
          {state === 'busy' ? 'Just a moment…' : 'Yes, keep me posted'}
        </button>
        <button className="btn secondary" type="button" onClick={notNow}>
          Not now
        </button>
      </div>
    </section>
  );
}
