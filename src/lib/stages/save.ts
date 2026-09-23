import type { PoolClient } from 'pg';
import type { StageKey } from './definitions';
import { STAGE_FORMS, STAGE_TABLES, type StageField } from './fields';

/**
 * Writing stage-form values, for everything that writes them: the form's own
 * save (/api/projects/[id]/stages/[stage]) and an accepted AI suggestion
 * (src/lib/ai). One allowlist — the field registry — one coercion, one upsert,
 * so a value the form would refuse is refused however it arrives.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Coerced = { ok: true; value: unknown } | { ok: false };

/** Validate one raw value against its field's type and options. */
export function coerce(field: StageField, raw: unknown): Coerced {
  if (raw === '' || raw === null || raw === undefined) return { ok: true, value: null };
  switch (field.type) {
    case 'select':
      return field.options?.includes(String(raw))
        ? { ok: true, value: String(raw) }
        : { ok: false };
    case 'date':
      return DATE_RE.test(String(raw)) ? { ok: true, value: String(raw) } : { ok: false };
    case 'toggle':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false };
    case 'refselect':
      return UUID_RE.test(String(raw)) ? { ok: true, value: String(raw) } : { ok: false };
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case 'permits':
      return Array.isArray(raw)
        ? { ok: true, value: raw.map((v) => String(v).slice(0, 60)).filter(Boolean) }
        : { ok: false };
    case 'text':
    case 'textarea':
      return { ok: true, value: String(raw).slice(0, 10000) };
    default:
      return { ok: false };
  }
}

export type Target = 'stage' | 'finance' | 'project';
export type Update = { col: string; value: unknown };
export type ByTable = Record<Target, Update[]>;

/** The savable (non-upload) fields of a stage, by name. */
export function savableFields(stage: StageKey): Map<string, StageField> {
  return new Map(
    STAGE_FORMS[stage]
      .flatMap((card) => card.fields)
      .filter((f) => f.type !== 'upload')
      .map((f) => [f.name, f])
  );
}

/**
 * Sort raw values into their target tables, refusing the first invalid one by
 * its label. Unknown names and upload fields are dropped silently, as the form
 * has always done.
 */
export function groupStageValues(
  stage: StageKey,
  values: Record<string, unknown>
): { ok: true; byTable: ByTable; count: number } | { ok: false; error: string } {
  const fields = savableFields(stage);
  const byTable: ByTable = { stage: [], finance: [], project: [] };
  let count = 0;
  for (const [name, raw] of Object.entries(values)) {
    const field = fields.get(name);
    if (!field) continue;
    const coerced = coerce(field, raw);
    if (!coerced.ok) return { ok: false, error: `invalid value for ${field.label}` };
    // Status/toggle columns are NOT NULL with defaults; an untouched dropdown
    // arrives as null and must be omitted, not written.
    if (coerced.value === null && (field.type === 'select' || field.type === 'toggle')) continue;
    const value = field.type === 'permits' && coerced.value === null ? [] : coerced.value;
    byTable[field.table ?? 'stage'].push({ col: name, value });
    count += 1;
  }
  return { ok: true, byTable, count };
}

/** Upsert the grouped values under the caller's own claims. */
export async function writeStageValues(
  client: PoolClient,
  projectId: string,
  stage: StageKey,
  byTable: ByTable
): Promise<void> {
  const upsert = async (table: string, updates: Update[]) => {
    if (!updates.length) return;
    const cols = updates.map((u) => `"${u.col}"`);
    const params: unknown[] = [projectId, ...updates.map((u) => u.value)];
    const placeholders = updates.map((_, i) => `$${i + 2}`);
    const sets = updates.map((u, i) => `"${u.col}" = $${i + 2}`);
    await client.query(
      `insert into public."${table}" (project_id, ${cols.join(', ')})
       values ($1, ${placeholders.join(', ')})
       on conflict (project_id) do update set ${sets.join(', ')}`,
      params
    );
  };
  await upsert(STAGE_TABLES[stage], byTable.stage);
  await upsert('finance_milestones', byTable.finance);
  if (byTable.project.length) {
    const sets = byTable.project.map((u, i) => `"${u.col}" = $${i + 2}`);
    await client.query(`update public.projects set ${sets.join(', ')} where id = $1`, [
      projectId,
      ...byTable.project.map((u) => u.value),
    ]);
  }
}
