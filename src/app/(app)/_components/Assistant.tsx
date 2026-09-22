'use client';

import Link from 'next/link';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
}

const STORE = 'solarflow:assistant';

/**
 * Ask SolarFlow — opened from the sidebar on every staff and dealer screen, as
 * a drawer on the right that stays open while you move between pages. The
 * conversation lives in this tab (sessionStorage) and is sent whole with each
 * question; the server keeps nothing but a log line.
 */
export function Assistant() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ configured: boolean; suggestions: string[] } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORE);
      if (saved) setTurns(JSON.parse(saved));
    } catch {
      /* storage blocked: start empty */
    }
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(turns.slice(-40)));
    } catch {
      /* storage blocked */
    }
  }, [turns]);
  useEffect(() => {
    if (!open || meta) return;
    fetch('/api/assistant')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setMeta(j))
      .catch(() => undefined);
  }, [open, meta]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns, status, open]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const history: Turn[] = [...turns.filter((t) => !t.error), { role: 'user', content: question }];
    setTurns((t) => [...t, { role: 'user', content: question }]);
    setDraft('');
    setBusy(true);
    setStatus('Thinking…');
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        setTurns((t) => [
          ...t,
          {
            role: 'assistant',
            content: j?.error ?? `That did not work (${res.status}).`,
            error: true,
          },
        ]);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let answered = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as { type: string; text?: string; error?: string };
          if (ev.type === 'status' && ev.text) setStatus(ev.text);
          if (ev.type === 'answer' && ev.text !== undefined) {
            answered = true;
            setTurns((t) => [...t, { role: 'assistant', content: ev.text as string }]);
          }
          if (ev.type === 'error') {
            answered = true;
            setTurns((t) => [
              ...t,
              { role: 'assistant', content: ev.error ?? 'Something went wrong.', error: true },
            ]);
          }
        }
      }
      if (!answered) {
        setTurns((t) => [
          ...t,
          { role: 'assistant', content: 'The answer did not arrive. Try again.', error: true },
        ]);
      }
    } catch {
      setTurns((t) => [
        ...t,
        { role: 'assistant', content: 'Could not reach the assistant. Try again.', error: true },
      ]);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  const trigger = (
    <button
      className={`assistant-trigger${open ? ' active' : ''}`}
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-expanded={open}
    >
      <span aria-hidden>✦</span> Ask SolarFlow
    </button>
  );
  if (!open) return trigger;

  return (
    <>
      {trigger}
      <aside className="assistant-panel" aria-label="Ask SolarFlow">
        <header>
          <strong>✦ Ask SolarFlow</strong>
          <div>
            {turns.length > 0 && (
              <button
                className="linklike"
                type="button"
                onClick={() => setTurns([])}
                disabled={busy}
              >
                New chat
              </button>
            )}
            <button
              className="assistant-close"
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>
        <div className="assistant-body">
          {turns.length === 0 && (
            <div className="assistant-empty">
              <p className="dim">
                Ask about projects, stages, what is blocking what, PM workload, dealers, deals or
                reports. Answers come from live data you are allowed to see.
              </p>
              {meta && !meta.configured && (
                <p className="notice">
                  The assistant is not connected yet — an admin adds ANTHROPIC_API_KEY.
                </p>
              )}
              <div className="assistant-suggestions">
                {(meta?.suggestions ?? []).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="chip-button"
                    onClick={() => void send(s)}
                    disabled={busy}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`assistant-turn ${t.role}${t.error ? ' error' : ''}`}>
              {t.role === 'assistant' && !t.error ? (
                <Markdown text={t.content} />
              ) : (
                <p>{t.content}</p>
              )}
            </div>
          ))}
          {busy && status && <div className="assistant-status">{status}</div>}
          <div ref={endRef} />
        </div>
        <form
          className="assistant-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <textarea
            ref={inputRef}
            rows={2}
            value={draft}
            placeholder="e.g. Which projects are stuck in Permits?"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            disabled={busy}
          />
          <button className="btn" type="submit" disabled={busy || !draft.trim()}>
            Ask
          </button>
        </form>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// A small markdown renderer: paragraphs, headings, bullet and numbered lists,
// tables, **bold**, `code` and [links](/path). It builds React elements — no
// HTML string ever reaches the page — and a link is only a link when it points
// inside the app; anything else is shown as its text.

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${n++}`;
    if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      const label = lm?.[1] ?? tok;
      const href = lm?.[2] ?? '';
      out.push(
        href.startsWith('/') && !href.startsWith('//') ? (
          <Link key={k} href={href}>
            {label}
          </Link>
        ) : (
          <Fragment key={k}>{label}</Fragment>
        )
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l: string) =>
    l
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${b++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(<h4 key={key}>{inline(h[2], key)}</h4>);
      i++;
      continue;
    }
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])
    ) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key} className="assistant-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, `${key}h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c, `${key}r${ri}c${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={key}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${key}i${j}`)}</li>
          ))}
        </List>
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) &&
      !isTableRow(lines[i])
    ) {
      para.push(lines[i++]);
    }
    blocks.push(<p key={key}>{inline(para.join(' '), key)}</p>);
  }
  return <>{blocks}</>;
}
