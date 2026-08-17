'use client';

import { useEffect, useState } from 'react';
import type { CustomerStage } from '@/lib/portal/customer';

/**
 * The seven-stage tracker in customer-facing language. Completed stages are
 * green with the date they were reached, the current stage is highlighted and
 * expanded by default, and future stages are grey. On a phone it stacks
 * vertically rather than squeezing a desktop row.
 *
 * Each stage is an anchor, so a push notification about the permit opens the
 * permit stage expanded rather than dropping the customer at the top of a list
 * to hunt for it (mobile spec §4).
 */
export function StageTracker({ stages }: { stages: CustomerStage[] }) {
  const currentIndex = Math.max(0, stages.findIndex((s) => s.state === 'current'));
  const [open, setOpen] = useState<number>(currentIndex === -1 ? 0 : currentIndex);

  useEffect(() => {
    const key = window.location.hash.replace('#', '');
    if (!key) return;
    const index = stages.findIndex((s) => s.key === key);
    if (index >= 0) {
      setOpen(index);
      document.getElementById(key)?.scrollIntoView({ block: 'center' });
    }
  }, [stages]);

  return (
    <section className="tracker">
      {stages.map((stage, i) => (
        <div key={stage.key} id={stage.key} className={`tracker-stage ${stage.state}`}>
          <button
            className="tracker-head"
            type="button"
            aria-expanded={open === i}
            onClick={() => setOpen(open === i ? -1 : i)}
          >
            <span className="tracker-num">{stage.state === 'done' ? '✓' : i + 1}</span>
            <span className="tracker-label">
              {stage.label}
              {stage.state === 'done' && stage.reachedOn && (
                <span className="dim"> · started {stage.reachedOn}</span>
              )}
              {stage.state === 'current' && <span className="tracker-now"> · happening now</span>}
            </span>
            <span className="tracker-caret">{open === i ? '▾' : '▸'}</span>
          </button>

          {open === i && (
            <div className="tracker-body">
              {stage.explainer && <p>{stage.explainer}</p>}
              <table className="projects-table">
                <tbody>
                  {stage.tracks.map((t) => (
                    <tr key={t.label}>
                      <td>{t.label}</td>
                      <td>{t.status}</td>
                      <td className="dim">
                        {t.submitted && !t.completed ? `submitted ${t.submitted}` : ''}
                        {t.completed ? t.completed : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
