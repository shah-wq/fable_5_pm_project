import type { PoolClient } from 'pg';
import { logAuditEvent } from '../audit';
import { withUser, type SessionIdentity } from '../db';
import { STAGE_LABELS, isStageKey, type StageKey } from '../stages/definitions';
import { STAGE_FORMS, STAGE_TABLES, STATUS_LABELS, type StageField } from '../stages/fields';
import { coerce, groupStageValues, writeStageValues } from '../stages/save';
import { complete, fileBlock, parseJsonObject } from './model';
import type { AiSettings } from './settings';

/**
 * The document reader.
 *
 * A PDF or photo attached to a stage form is read by the model, which is told
 * which stage it belongs to and which fields that stage has, and asked for the
 * values it can see — each with a confidence and the words that support it.
 * The values become ai_suggestions rows. Above the admin's threshold, and only
 * if the admin has switched auto-apply on, they are written straight into the
 * form through the same allowlist the form itself uses; otherwise they wait
 * for the PM to accept or reject them, and one exception per document asks.
 *
 * What the model never does here: write a field on its own, invent a value it
 * cannot point to in the document, or touch a field the form does not have.
 */

/** Which stage an upload category belongs to, from the field registry. */
export function stageOfCategory(category: string): StageKey | null {
  for (const [stage, cards] of Object.entries(STAGE_FORMS) as [
    StageKey,
    typeof STAGE_FORMS.survey,
  ][]) {
    if (cards.some((c) => c.fields.some((f) => f.type === 'upload' && f.name === category)))
      return stage;
  }
  return null;
}

/** The label of an upload category — "Building permit approval". */
export function categoryLabel(category: string): string {
  for (const cards of Object.values(STAGE_FORMS)) {
    const f = cards
      .flatMap((c) => c.fields)
      .find((x) => x.type === 'upload' && x.name === category);
    if (f) return f.label;
  }
  return category.replace(/_/g, ' ');
}

/** The fields the reader may propose values for: facts, not people or files. */
export function extractableFields(stage: StageKey): StageField[] {
  return STAGE_FORMS[stage]
    .flatMap((c) => c.fields)
    .filter((f) => !['upload', 'refselect', 'permits', 'toggle'].includes(f.type));
}

function describeField(f: StageField): Record<string, unknown> {
  return {
    field: f.name,
    label: f.label,
    type: f.type === 'textarea' ? 'text' : f.type,
    ...(f.unit ? { unit: f.unit } : {}),
    ...(f.options ? { options: f.options.map((o) => `${o} (${STATUS_LABELS[o] ?? o})`) } : {}),
  };
}

const SYSTEM = [
  "You read documents for SolarFlow PM, the project-management system of a residential solar installer. A project manager attached a document to a stage of a project. Your job is to find, in the document, the values of that stage's form fields, so the PM does not have to type them.",
  '',
  'Rules:',
  '- Propose a value only when the document actually shows it. Quote the exact words or numbers you relied on as "evidence". Never guess, infer from typical practice, or fill a field the document does not support.',
  "- Match the field's type exactly: dates as YYYY-MM-DD, numbers as plain numbers (no units, no commas), select fields as one of the listed option keys (the part before the parenthesis), text as a short string.",
  '- For a status field, propose the value only if the document is the thing that proves it (an approval letter proves "approved"; an application receipt proves "applied").',
  '- confidence is your honest probability, 0 to 1, that the value is right for this field. Use below 0.7 when the document is blurry, partial, ambiguous or the field mapping is uncertain.',
  '- If the document is not what the category says it is (a photo of a dog attached as a permit approval), say so: matches_category false, and explain in issues.',
  '- Note anything a PM would want flagged in "issues": an expiry date already passed, conditions of approval, a different address or name than the project\'s, a rejection, missing signatures.',
  '',
  'Answer with one JSON object and nothing else:',
  '{"document_type": "what this document is, in a few words", "matches_category": true, "summary": "one or two sentences a PM would want to read", "fields": [{"field": "name", "value": ..., "confidence": 0.0, "evidence": "quoted words"}], "issues": ["..."]}',
].join('\n');

export interface ReadResult {
  documentType: string | null;
  matchesCategory: boolean;
  summary: string | null;
  proposed: number;
  applied: number;
  pending: number;
  issues: string[];
  skipped?: string;
}

interface ModelField {
  field?: unknown;
  value?: unknown;
  confidence?: unknown;
  evidence?: unknown;
}
interface ModelAnswer {
  document_type?: unknown;
  matches_category?: unknown;
  summary?: unknown;
  fields?: ModelField[];
  issues?: unknown;
}

const MAX_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4_500_000;

/**
 * Read one stage document and record what the model found. Runs as the
 * automation identity; the writes it makes are the ones a PM could make.
 */
export async function readDocument(
  client: PoolClient,
  identity: SessionIdentity,
  documentId: string,
  settings: AiSettings
): Promise<ReadResult> {
  const { rows } = await client.query<{
    id: string;
    project_id: string;
    category: string | null;
    title: string | null;
    mime_type: string | null;
    code: string;
    name: string;
    address: string | null;
    customer: string | null;
    stage: string;
    assigned_pm: string | null;
  }>(
    `select d.id, d.project_id, d.category, d.title, d.mime_type,
            p.code, p.name, p.address, p.stage::text as stage, p.assigned_pm,
            nullif(btrim(concat_ws(' ', cl.first_name, cl.last_name)), '') as customer
       from public.documents d
       join public.projects p on p.id = d.project_id
       left join public.clients cl on cl.id = p.client_id
      where d.id = $1`,
    [documentId]
  );
  const doc = rows[0];
  if (!doc) return skip('the document no longer exists');
  if (!doc.category) return skip('not a stage attachment');
  const stage = stageOfCategory(doc.category);
  if (!stage) return skip(`no stage owns the category ${doc.category}`);
  const fields = extractableFields(stage);
  if (fields.length === 0) return skip('the stage has no fields to fill');

  const file = await client.query<{
    mime_type: string | null;
    size_bytes: string | null;
    data: Buffer;
  }>('select mime_type, size_bytes, data from public.read_document($1)', [documentId]);
  const f = file.rows[0];
  if (!f?.data) return skip('the file could not be read');
  const mime = f.mime_type ?? doc.mime_type ?? '';
  if (f.data.length > MAX_BYTES) return skip('the file is too large to read');
  if (mime.startsWith('image/') && f.data.length > MAX_IMAGE_BYTES)
    return skip('the photo is too large to read');
  const block = fileBlock(mime, f.data);
  if (!block) return skip(`${mime || 'this format'} cannot be read`);

  // What the form holds today, so the reader can say when a document disagrees.
  const current = await client.query(
    `select * from public."${STAGE_TABLES[stage]}" where project_id = $1`,
    [doc.project_id]
  );
  const currentRow = (current.rows[0] ?? {}) as Record<string, unknown>;
  const currentValues: Record<string, unknown> = {};
  for (const fld of fields) {
    const v = currentRow[fld.name];
    if (v !== null && v !== undefined && v !== '')
      currentValues[fld.name] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
  }

  const ask = [
    `Project ${doc.code} — ${doc.name}${doc.address ? `, ${doc.address}` : ''}${doc.customer ? `, homeowner ${doc.customer}` : ''}.`,
    `The document was attached to the ${STAGE_LABELS[stage]} stage as "${categoryLabel(doc.category)}"${doc.title ? ` (file: ${doc.title})` : ''}.`,
    '',
    `Fields of the ${STAGE_LABELS[stage]} form:`,
    JSON.stringify(fields.map(describeField)),
    '',
    Object.keys(currentValues).length
      ? `Values already on the form (propose a different value only if the document clearly shows a different one, and mention it in issues):\n${JSON.stringify(currentValues)}`
      : 'The form is empty so far.',
  ].join('\n');

  const { text, usage } = await complete(SYSTEM, [block, { type: 'text', text: ask }]);
  const answer = parseJsonObject<ModelAnswer>(text);
  if (!answer) throw new Error('the model did not answer with JSON');

  const matches = answer.matches_category !== false;
  const issues = Array.isArray(answer.issues)
    ? answer.issues.map((i) => String(i).slice(0, 300)).slice(0, 10)
    : [];
  const byName = new Map(fields.map((x) => [x.name, x]));
  const proposals: Array<{
    field: StageField;
    value: unknown;
    confidence: number;
    evidence: string | null;
  }> = [];
  for (const raw of Array.isArray(answer.fields) ? answer.fields : []) {
    const field = typeof raw?.field === 'string' ? byName.get(raw.field) : undefined;
    if (!field) continue;
    const coerced = coerce(field, raw.value);
    if (!coerced.ok || coerced.value === null) {
      issues.push(
        `${field.label}: the reader proposed "${String(raw.value).slice(0, 60)}", which is not a valid value`
      );
      continue;
    }
    const confidence = Math.min(1, Math.max(0, Number(raw.confidence) || 0));
    const same = String(currentValues[field.name] ?? '') === String(coerced.value);
    if (same) continue;
    proposals.push({
      field,
      value: coerced.value,
      confidence,
      evidence: raw.evidence ? String(raw.evidence).slice(0, 500) : null,
    });
  }

  // Apply the confident ones when allowed; everything else waits for a person.
  const toApply =
    matches && settings.autoApply
      ? proposals.filter((p) => p.confidence >= settings.confidenceThreshold)
      : [];
  if (toApply.length) {
    const grouped = groupStageValues(
      stage,
      Object.fromEntries(toApply.map((p) => [p.field.name, p.value]))
    );
    if (grouped.ok) await writeStageValues(client, doc.project_id, stage, grouped.byTable);
  }
  const appliedNames = new Set(toApply.map((p) => p.field.name));

  for (const p of proposals) {
    await client.query(
      `insert into public.ai_suggestions (project_id, document_id, stage, field, value, confidence, evidence, status, decided_at)
       values ($1, $2, $3::public.project_stage, $4, $5::jsonb, $6, $7, $8, case when $8 = 'applied' then now() end)
       on conflict (document_id, field) where document_id is not null do update
         set value = excluded.value, confidence = excluded.confidence, evidence = excluded.evidence,
             status = case when public.ai_suggestions.status = 'pending' then excluded.status else public.ai_suggestions.status end,
             created_at = now()`,
      [
        doc.project_id,
        doc.id,
        stage,
        p.field.name,
        JSON.stringify(p.value),
        p.confidence,
        p.evidence,
        appliedNames.has(p.field.name) ? 'applied' : 'pending',
      ]
    );
  }

  const pending = proposals.length - appliedNames.size;
  const summary = typeof answer.summary === 'string' ? answer.summary.slice(0, 600) : null;
  const documentType =
    typeof answer.document_type === 'string' ? answer.document_type.slice(0, 120) : null;

  // One exception per document, when there is something for a person to decide.
  if (pending > 0 || !matches || issues.length > 0) {
    const what = !matches
      ? `${categoryLabel(doc.category)}: the file does not look like one (${documentType ?? 'unknown document'})`
      : pending > 0
        ? `${categoryLabel(doc.category)} read: ${pending} value${pending === 1 ? '' : 's'} to confirm${issues.length ? `, ${issues.length} note${issues.length === 1 ? '' : 's'}` : ''}`
        : `${categoryLabel(doc.category)} read: ${issues.length} note${issues.length === 1 ? '' : 's'}`;
    const details = {
      document_id: doc.id,
      title: doc.title,
      category: doc.category,
      stage,
      document_type: documentType,
      summary,
      issues,
      applied: [...appliedNames],
      pending,
    };
    await client.query(
      `insert into public.exceptions (project_id, entity_type, entity_id, severity, summary, details, raised_by, assigned_to)
       select $1, 'documents', $2, $3::public.exception_severity, $4, $5::jsonb, 'ai', $6
        where not exists (select 1 from public.exceptions e
                           where e.entity_type = 'documents' and e.entity_id = $2 and e.raised_by = 'ai'
                             and e.status in ('open', 'acknowledged', 'in_progress'))`,
      [
        doc.project_id,
        doc.id,
        matches ? 'medium' : 'high',
        what.slice(0, 300),
        JSON.stringify(details),
        doc.assigned_pm,
      ]
    );
  }

  await logAuditEvent(identity, {
    action: 'ai.document_read',
    entityType: 'documents',
    entityId: doc.id,
    projectId: doc.project_id,
    context: {
      category: doc.category,
      stage,
      document_type: documentType,
      proposed: proposals.length,
      applied: appliedNames.size,
      pending,
      matches,
      issues: issues.length,
      tokens: usage,
    },
    kind: 'system',
  }).catch(() => undefined);

  return {
    documentType,
    matchesCategory: matches,
    summary,
    proposed: proposals.length,
    applied: appliedNames.size,
    pending,
    issues,
  };

  function skip(reason: string): ReadResult {
    return {
      documentType: null,
      matchesCategory: true,
      summary: null,
      proposed: 0,
      applied: 0,
      pending: 0,
      issues: [],
      skipped: reason,
    };
  }
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

export interface Suggestion {
  id: string;
  projectId: string;
  documentId: string | null;
  documentTitle: string | null;
  category: string | null;
  stage: StageKey;
  field: string;
  label: string;
  value: unknown;
  display: string;
  confidence: number;
  evidence: string | null;
  status: string;
  createdAt: string;
}

function labelFor(stage: StageKey, field: string): StageField | undefined {
  return STAGE_FORMS[stage].flatMap((c) => c.fields).find((f) => f.name === field);
}

function display(field: StageField | undefined, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (field?.type === 'select') return STATUS_LABELS[String(value)] ?? String(value);
  if (field?.type === 'number') return `${value}${field.unit ? ` ${field.unit}` : ''}`;
  return String(value);
}

/** Suggestions this person may see, pending by default. */
export async function loadSuggestions(
  client: PoolClient,
  opts: {
    projectId?: string;
    stage?: StageKey;
    documentId?: string;
    status?: 'pending' | 'all';
  } = {}
): Promise<Suggestion[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (opts.projectId) add('s.project_id = ?', opts.projectId);
  if (opts.stage) add('s.stage = ?::public.project_stage', opts.stage);
  if (opts.documentId) add('s.document_id = ?', opts.documentId);
  if ((opts.status ?? 'pending') === 'pending') where.push(`s.status = 'pending'`);
  const { rows } = await client.query(
    `select s.id::text as id, s.project_id, s.document_id, d.title, d.category, s.stage::text as stage, s.field,
            s.value, s.confidence, s.evidence, s.status, s.created_at
       from public.ai_suggestions s
       left join public.documents d on d.id = s.document_id
      ${where.length ? 'where ' + where.join(' and ') : ''}
      order by s.created_at desc, s.field
      limit 500`,
    params
  );
  return rows
    .filter((r) => isStageKey(r.stage))
    .map((r) => {
      const stage = r.stage as StageKey;
      const field = labelFor(stage, r.field);
      return {
        id: r.id,
        projectId: r.project_id,
        documentId: r.document_id,
        documentTitle: r.title,
        category: r.category,
        stage,
        field: r.field,
        label: field?.label ?? r.field,
        value: r.value,
        display: display(field, r.value),
        confidence: Number(r.confidence),
        evidence: r.evidence,
        status: r.status,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      };
    });
}

/**
 * Accept (write the value into the form) or reject one suggestion, as the
 * person deciding. Row-level security limits it to their projects; the write
 * goes through the form's own allowlist.
 */
export async function decideSuggestion(
  session: SessionIdentity,
  id: string,
  accept: boolean
): Promise<{ ok: true; applied: boolean } | { ok: false; status: number; error: string }> {
  return withUser(session, async (client) => {
    const { rows } = await client.query(
      `select id, project_id, stage::text as stage, field, value, status from public.ai_suggestions where id = $1`,
      [id]
    );
    const s = rows[0];
    if (!s) return { ok: false as const, status: 404, error: 'No such suggestion.' };
    if (s.status !== 'pending')
      return { ok: false as const, status: 409, error: `Already ${s.status}.` };
    if (!isStageKey(s.stage)) return { ok: false as const, status: 400, error: 'Unknown stage.' };

    if (accept) {
      const grouped = groupStageValues(s.stage, { [s.field]: s.value });
      if (!grouped.ok || grouped.count === 0) {
        return {
          ok: false as const,
          status: 400,
          error: grouped.ok ? 'That field cannot be written.' : grouped.error,
        };
      }
      await writeStageValues(client, s.project_id, s.stage, grouped.byTable);
    }
    await client.query(
      `update public.ai_suggestions set status = $2, decided_by = $3, decided_at = now() where id = $1`,
      [id, accept ? 'applied' : 'rejected', session.userId]
    );
    await logAuditEvent(session, {
      action: accept ? 'ai.suggestion_applied' : 'ai.suggestion_rejected',
      entityType: 'ai_suggestions',
      entityId: String(id),
      projectId: s.project_id,
      context: { stage: s.stage, field: s.field, value: s.value },
      kind: 'field_change',
    }).catch(() => undefined);
    return { ok: true as const, applied: accept };
  });
}
