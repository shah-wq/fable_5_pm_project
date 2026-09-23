'use client';

import { useEffect, useState } from 'react';
import { STAGE_LABELS, type StageKey } from '@/lib/stages/definitions';

interface Settings {
  ready: boolean;
  documentReading: boolean;
  autoApply: boolean;
  confidenceThreshold: number;
  autoAdvanceStages: string[];
  replyDrafts: boolean;
  replyAutoSend: boolean;
  briefings: boolean;
  briefingHour: number;
  timezone: string;
}

interface Data {
  ready: boolean;
  configured: boolean;
  settings: Settings;
  stages: StageKey[];
  stats: Array<{ kind: string; status: string; n: number }>;
  recent: Array<{
    id: string;
    kind: string;
    status: string;
    entity_id: string;
    attempts: number;
    error: string | null;
    result: Record<string, unknown> | null;
    created_at: string;
    finished_at: string | null;
    project_code: string | null;
  }>;
  pendingSuggestions: number;
}

const KIND: Record<string, string> = {
  read_document: 'Read a document',
  draft_reply: 'Draft a reply',
  briefing: 'Morning briefing',
};

export function AiSettings() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function load() {
    const res = await fetch('/api/admin/ai-settings', { cache: 'no-store' });
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      setError(j?.error ?? `Could not load (${res.status}).`);
      return;
    }
    setData(j);
  }
  useEffect(() => {
    void load();
  }, []);

  async function put(body: unknown) {
    setError(null);
    const res = await fetch('/api/admin/ai-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) setError(j?.error ?? `Save failed (${res.status}).`);
    else {
      setSaved('Saved.');
      setTimeout(() => setSaved(null), 1500);
    }
    await load();
  }

  async function runNow() {
    setRunning(true);
    setError(null);
    const res = await fetch('/api/push/reminders', { method: 'POST' });
    const j = await res.json().catch(() => null);
    if (!res.ok) setError(j?.error ?? `The run failed (${res.status}).`);
    else {
      const a = j?.automation;
      setSaved(
        a
          ? `Ran: ${a.jobs.done} done, ${a.jobs.failed} failed, ${a.jobs.skipped} skipped, ${a.autoAdvanced} advanced, ${a.briefingsQueued} briefings queued.`
          : 'Ran.'
      );
      setTimeout(() => setSaved(null), 6000);
    }
    setRunning(false);
    await load();
  }

  if (!data) return <p className="dim">{error ?? 'Loading…'}</p>;
  if (!data.ready)
    return (
      <p className="notice">AI automation needs migration 004800 — Admin → Database → Apply.</p>
    );
  const s = data.settings;

  const Switch = ({ k, label, note }: { k: keyof Settings; label: string; note: string }) => (
    <label className="ai-switch">
      <input
        type="checkbox"
        checked={Boolean(s[k])}
        onChange={(e) => void put({ [k]: e.target.checked })}
      />
      <span>
        <strong>{label}</strong>
        <span className="dim small">{note}</span>
      </span>
    </label>
  );

  const count = (kind: string, status: string) =>
    data.stats.filter((x) => x.kind === kind && x.status === status).reduce((n, x) => n + x.n, 0);

  return (
    <div className="ai-settings">
      {!data.configured && (
        <p className="notice">
          ANTHROPIC_API_KEY is not set on this deployment, so nothing below runs yet. Auto-advance
          needs no model and still works.
        </p>
      )}
      {error && <p className="notice error">{error}</p>}
      {saved && <p className="notice ok">{saved}</p>}

      <section className="panel">
        <h2>Documents</h2>
        <Switch
          k="documentReading"
          label="Read stage attachments"
          note="Every PDF or photo attached to a stage form is read, and the values it contains are proposed for that stage’s fields — with the words that support each one."
        />
        <Switch
          k="autoApply"
          label="Write confident values without asking"
          note="Above the threshold below, a value is written to the form at once; below it, it waits for a person. Off: everything waits."
        />
        <label className="field inline">
          <span>Confidence threshold</span>
          <input
            type="number"
            min={0.5}
            max={1}
            step={0.05}
            defaultValue={s.confidenceThreshold}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (v !== s.confidenceThreshold) void put({ confidenceThreshold: v });
            }}
          />
        </label>
        <p className="dim small">
          {data.pendingSuggestions} value{data.pendingSuggestions === 1 ? '' : 's'} waiting for a
          decision — see <a href="/exceptions">Exceptions</a>.
        </p>
      </section>

      <section className="panel">
        <h2>Moving projects</h2>
        <p className="dim small">
          A project in a ticked stage moves on by itself once its form is complete and its required
          attachments are in — the same gate as the green button, logged as the automation. Held
          back while any of its suggested values is undecided.
        </p>
        <div className="ai-stages">
          {data.stages.map((st) => (
            <label key={st} className="ai-stage">
              <input
                type="checkbox"
                checked={s.autoAdvanceStages.includes(st)}
                onChange={(e) =>
                  void put({
                    autoAdvanceStages: e.target.checked
                      ? [...s.autoAdvanceStages, st]
                      : s.autoAdvanceStages.filter((x) => x !== st),
                  })
                }
              />
              {STAGE_LABELS[st]}
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Homeowner messages</h2>
        <Switch
          k="replyDrafts"
          label="Draft replies"
          note="When a homeowner writes, a reply is drafted from the project’s own facts and shown above the PM’s composer to send, edit or dismiss."
        />
        <Switch
          k="replyAutoSend"
          label="Send confident replies automatically"
          note="A draft above the threshold that needs no person is sent as the project manager, signed as automatic. Anything about money, dates that are not set, complaints or changes always waits."
        />
      </section>

      <section className="panel">
        <h2>Morning briefing</h2>
        <Switch
          k="briefings"
          label="Write each project manager a morning briefing"
          note="Ask SolarFlow’s PM report for their own projects, in their feed and by email (Admin → Notifications decides the channels)."
        />
        <label className="field inline">
          <span>At (hour, {s.timezone})</span>
          <input
            type="number"
            min={0}
            max={23}
            defaultValue={s.briefingHour}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (v !== s.briefingHour) void put({ briefingHour: v });
            }}
          />
        </label>
      </section>

      <section className="panel">
        <div className="page-head">
          <h2>The last seven days</h2>
          <button className="btn secondary" type="button" disabled={running} onClick={runNow}>
            {running ? 'Running…' : 'Run now'}
          </button>
        </div>
        <table className="rules-table">
          <thead>
            <tr>
              <th>Job</th>
              <th className="num">Done</th>
              <th className="num">Skipped</th>
              <th className="num">Failed</th>
              <th className="num">Queued</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(KIND).map(([k, label]) => (
              <tr key={k}>
                <td>{label}</td>
                <td className="num">{count(k, 'done')}</td>
                <td className="num">{count(k, 'skipped')}</td>
                <td className="num">{count(k, 'failed')}</td>
                <td className="num">{count(k, 'queued') + count(k, 'running')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.recent.length > 0 && (
          <details className="stage-detail">
            <summary>Recent jobs</summary>
            <table className="rules-table">
              <tbody>
                {data.recent.map((j) => (
                  <tr key={j.id} className={j.status === 'failed' ? 'off' : ''}>
                    <td>{KIND[j.kind] ?? j.kind}</td>
                    <td>{j.project_code ?? '—'}</td>
                    <td>{j.status}</td>
                    <td className="dim small">
                      {j.error ?? (j.result ? summarise(j.result) : '')}
                    </td>
                    <td className="dim small">{new Date(j.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>
    </div>
  );
}

function summarise(r: Record<string, unknown>): string {
  if (typeof r.skipped === 'string') return r.skipped;
  if ('proposed' in r)
    return `${r.proposed} proposed, ${r.applied} applied, ${r.pending} to confirm`;
  if ('drafted' in r)
    return r.sentAuto
      ? 'sent automatically'
      : r.needsHuman
        ? 'draft — needs a person'
        : 'draft ready';
  if ('words' in r) return `${r.words} words`;
  return '';
}
