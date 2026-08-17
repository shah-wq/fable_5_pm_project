'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { compressImage } from '@/lib/native';

interface Ask {
  id: string;
  kind: string;
  label: string;
  detail: string | null;
}

type ItemState = 'compressing' | 'uploading' | 'done' | 'failed';

interface QueueItem {
  key: string;
  file: File;
  name: string;
  state: ItemState;
  error: string | null;
  askId: string | null;
}

/**
 * Sending a photo (spec §3.4). Take one with the camera or pick from the
 * library, several at once, against a specific thing the PM asked for.
 *
 * Three things make this survive a real phone on a weak signal:
 *   * every image is resized and compressed first, because a raw 6 MB photo on
 *     mobile data is the difference between working and not;
 *   * uploads run one at a time and continue while the customer stays on the
 *     app, rather than blocking the screen;
 *   * a failure is shown with a Retry button and retried automatically when the
 *     connection comes back — never dropped silently.
 */
export function PhotoUploader({ projectId, asks }: { projectId: string; asks: Ask[] }) {
  const router = useRouter();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [note, setNote] = useState('');
  const [target, setTarget] = useState<string>(asks[0]?.id ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const running = useRef(false);

  function add(files: FileList | null) {
    if (!files?.length) return;
    const items: QueueItem[] = Array.from(files).slice(0, 10).map((file, i) => ({
      key: `${Date.now()}-${i}-${file.name}`,
      file,
      name: file.name,
      state: 'compressing',
      error: null,
      askId: target || null,
    }));
    setQueue((q) => [...q, ...items]);
  }

  // One worker, walking the queue. Sequential on purpose: parallel uploads on a
  // phone connection make every one of them slower and more likely to fail.
  useEffect(() => {
    if (running.current) return;
    const next = queue.find((i) => i.state === 'compressing');
    if (!next) return;

    running.current = true;
    void (async () => {
      try {
        const compressed = await compressImage(next.file);
        setQueue((q) => q.map((i) => (i.key === next.key ? { ...i, state: 'uploading' } : i)));

        const form = new FormData();
        form.append('file', compressed, compressed.name);
        form.append('projectId', projectId);
        if (note.trim()) form.append('note', note.trim().slice(0, 500));
        if (next.askId) form.append('askId', next.askId);

        const res = await fetch('/api/portal/uploads', { method: 'POST', body: form });
        if (!res.ok) {
          const json = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(json?.error ?? `Upload failed (${res.status})`);
        }
        setQueue((q) => q.map((i) => (i.key === next.key ? { ...i, state: 'done' } : i)));
        router.refresh();
      } catch (e) {
        setQueue((q) =>
          q.map((i) =>
            i.key === next.key
              ? { ...i, state: 'failed', error: e instanceof Error ? e.message : 'Upload failed' }
              : i
          )
        );
      } finally {
        running.current = false;
        // Nudge the effect to pick up whatever is next.
        setQueue((q) => [...q]);
      }
    })();
  }, [queue, note, projectId, router]);

  // Back online: retry anything that failed while there was no signal.
  useEffect(() => {
    const retryAll = () =>
      setQueue((q) => q.map((i) => (i.state === 'failed' ? { ...i, state: 'compressing', error: null } : i)));
    window.addEventListener('online', retryAll);
    return () => window.removeEventListener('online', retryAll);
  }, []);

  const pending = queue.filter((i) => i.state !== 'done');

  return (
    <section className="panel">
      {asks.length > 0 ? (
        <>
          <h2>We need something from you</h2>
          <ul className="gap-list">
            {asks.map((a) => (
              <li key={a.id}>
                <strong>{a.label}</strong>
                {a.detail && <span className="dim"> — {a.detail}</span>}
              </li>
            ))}
          </ul>
          {asks.length > 1 && (
            <label className="field">
              <span>This photo is for</span>
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {asks.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      ) : (
        <>
          <h2>Send us a photo</h2>
          <p className="dim">
            Nothing is outstanding — but if there is something you think we should see, send it
            here and your project manager will get it.
          </p>
        </>
      )}

      <label className="field">
        <span>Anything we should know? (optional)</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. the meter is on the side of the garage"
          maxLength={500}
        />
      </label>

      <div className="row-actions">
        <button className="btn" type="button" onClick={() => cameraRef.current?.click()}>
          Take a photo
        </button>
        <button className="btn secondary" type="button" onClick={() => inputRef.current?.click()}>
          Choose from library
        </button>
      </div>

      {/* capture="environment" opens the rear camera directly rather than a
          picker; the second input is the multi-select library route. */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          add(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        hidden
        onChange={(e) => {
          add(e.target.files);
          e.target.value = '';
        }}
      />

      {pending.length > 0 && (
        <ul className="upload-queue">
          {pending.map((item) => (
            <li key={item.key} className={item.state}>
              <span className="upload-name">{item.name}</span>
              <span className="upload-state">
                {item.state === 'compressing' && 'Preparing…'}
                {item.state === 'uploading' && 'Sending…'}
                {item.state === 'failed' && (item.error ?? 'Failed')}
              </span>
              {item.state === 'failed' && (
                <button
                  className="btn secondary small"
                  type="button"
                  onClick={() =>
                    setQueue((q) =>
                      q.map((i) =>
                        i.key === item.key ? { ...i, state: 'compressing', error: null } : i
                      )
                    )
                  }
                >
                  Retry
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {queue.some((i) => i.state === 'done') && (
        <p className="notice ok" role="status">
          Sent — thank you. Your project manager can see it now.
        </p>
      )}
    </section>
  );
}
