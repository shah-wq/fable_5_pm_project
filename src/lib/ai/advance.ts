import type { PoolClient } from 'pg';
import type { SessionIdentity } from '../db';
import { optionalRows } from '../db-optional';
import { isStageKey, type StageKey } from '../stages/definitions';
import { evaluateStage } from '../stages/requirements';
import { loadBundles, moveProject } from '../stages/service';
import type { AiSettings } from './settings';

/**
 * Evidence-based auto-advance.
 *
 * No model involved. For each stage the admin has allowed, an active project
 * whose form is complete and whose required attachments are in moves to the
 * next stage — through moveProject, so the same gate, the same customer
 * notification, the same chat line and the same audit entry as the green
 * button, attributed to the automation.
 *
 * Held back when the project has AI suggestions nobody has decided yet: a form
 * that is complete only because the reader filled it is not yet evidence.
 */
export async function autoAdvance(
  client: PoolClient,
  identity: SessionIdentity,
  settings: AiSettings
): Promise<{ checked: number; advanced: string[] }> {
  const stages = settings.autoAdvanceStages.filter(
    (s): s is StageKey => isStageKey(s) && s !== 'complete'
  );
  if (stages.length === 0) return { checked: 0, advanced: [] };

  const candidates = await optionalRows<{ id: string; stage: string }>(
    client,
    'projects eligible for auto-advance',
    `select p.id, p.stage::text as stage from public.projects p
      where p.status = 'active' and p.stage::text = any($1)
        and not exists (select 1 from public.ai_suggestions s where s.project_id = p.id and s.status = 'pending')
      order by p.created_at limit 200`,
    [stages]
  );
  if (candidates.length === 0) return { checked: 0, advanced: [] };

  const bundles = await loadBundles(
    client,
    candidates.map((c) => c.id)
  );
  const advanced: string[] = [];
  for (const c of candidates) {
    const stage = c.stage as StageKey;
    const bundle = bundles.get(c.id);
    if (!bundle || evaluateStage(stage, bundle).length > 0) continue;
    // Its own connection and transaction, as every move is.
    const result = await moveProject(identity, c.id, 'forward', { via: 'automation' });
    if (result.ok) advanced.push(c.id);
  }
  return { checked: candidates.length, advanced };
}
