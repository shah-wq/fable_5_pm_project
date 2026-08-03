'use client';

import { useRef, useState } from 'react';

const MAX_FILES = 20;
const MAX_BYTES = 25 * 1024 * 1024; // matches the project-photos bucket limit

type Item = { file: File; status: 'ready' | 'uploading' | 'done' | 'error'; note?: string };

export function GrantUploadForm({ token, hint }: { token: string; hint: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  function pick(files: FileList | null) {
    if (!files) return;
    const next = [...files]
      .slice(0, MAX_FILES)
      .map<Item>((file) => ({
        file,
        status: file.size > MAX_BYTES ? 'error' : 'ready',
        note: file.size > MAX_BYTES ? 'over 25 MB' : undefined,
      }));
    setItems(next);
    setFatal(null);
  }

  async function upload() {
    setBusy(true);
    setFatal(null);
    try {
      const pending = items.filter((i) => i.status === 'ready');
      for (const item of pending) {
        setItems((cur) =>
          cur.map((c) => (c === item ? { ...c, status: 'uploading' } : c))
        );
        const body = new FormData();
        body.append('file', item.file);
        const res = await fetch(`/api/u/${encodeURIComponent(token)}`, { method: 'POST', body });
        if (res.status === 410) {
          setFatal('This link expired while you were uploading. Ask for a fresh one.');
          return;
        }
        const ok = res.ok;
        const note = ok ? undefined : (await res.json().catch(() => null))?.error ?? 'failed';
        setItems((cur) =>
          cur.map((c) =>
            c.file === item.file ? { ...c, status: ok ? 'done' : 'error', note } : c
          )
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const readyCount = items.filter((i) => i.status === 'ready').length;
  const doneCount = items.filter((i) => i.status === 'done').length;

  return (
    <div>
      {fatal && (
        <p className="notice error" role="alert">
          {fatal}
        </p>
      )}
      <button
        type="button"
        className="drop"
        style={{ width: '100%', cursor: 'pointer' }}
        onClick={() => inputRef.current?.click()}
      >
        <strong>Choose photos</strong>
        <br />
        {hint}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        multiple
        hidden
        onChange={(e) => pick(e.target.files)}
      />
      {items.length > 0 && (
        <>
          <ul className="file-list">
            {items.map((item) => (
              <li key={item.file.name + item.file.size}>
                <span>{item.file.name}</span>
                <span className="st">
                  {item.status === 'done' ? 'uploaded' : item.note ?? item.status}
                </span>
              </li>
            ))}
          </ul>
          <button className="btn" type="button" onClick={upload} disabled={busy || readyCount === 0}>
            {busy
              ? 'Uploading…'
              : readyCount > 0
                ? `Upload ${readyCount} file${readyCount === 1 ? '' : 's'}`
                : `${doneCount} uploaded`}
          </button>
        </>
      )}
    </div>
  );
}
