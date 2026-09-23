import type { PoolClient } from 'pg';
import { optionalRows } from '../db-optional';
import type { StageKey } from '../stages/definitions';

/**
 * The automation switches (migration 004800), as one object with the defaults
 * filled in. Read on every run rather than cached: an admin who switches
 * auto-apply off expects the next document to wait for them.
 */
export interface AiSettings {
  ready: boolean;
  documentReading: boolean;
  autoApply: boolean;
  confidenceThreshold: number;
  autoAdvanceStages: StageKey[];
  replyDrafts: boolean;
  replyAutoSend: boolean;
  briefings: boolean;
  briefingHour: number;
  timezone: string;
  companyName: string | null;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  ready: false,
  documentReading: true,
  autoApply: false,
  confidenceThreshold: 0.85,
  autoAdvanceStages: [],
  replyDrafts: true,
  replyAutoSend: false,
  briefings: true,
  briefingHour: 7,
  timezone: 'America/Chicago',
  companyName: null,
};

interface Row {
  ai_document_reading: boolean;
  ai_auto_apply: boolean;
  ai_confidence_threshold: string | number;
  ai_auto_advance_stages: string[] | null;
  ai_reply_drafts: boolean;
  ai_reply_auto_send: boolean;
  ai_briefings: boolean;
  briefing_hour: number;
  company_timezone: string | null;
  company_name: string | null;
}

export async function loadAiSettings(client: PoolClient): Promise<AiSettings> {
  const rows = await optionalRows<Row>(
    client,
    'the AI automation settings (migration 004800)',
    `select ai_document_reading, ai_auto_apply, ai_confidence_threshold, ai_auto_advance_stages,
            ai_reply_drafts, ai_reply_auto_send, ai_briefings, briefing_hour,
            company_timezone, company_name
       from public.app_settings where id`
  );
  const r = rows[0];
  if (!r) return DEFAULT_AI_SETTINGS;
  return {
    ready: true,
    documentReading: r.ai_document_reading,
    autoApply: r.ai_auto_apply,
    confidenceThreshold: Number(r.ai_confidence_threshold) || 0.85,
    autoAdvanceStages: (r.ai_auto_advance_stages ?? []) as StageKey[],
    replyDrafts: r.ai_reply_drafts,
    replyAutoSend: r.ai_reply_auto_send,
    briefings: r.ai_briefings,
    briefingHour: r.briefing_hour ?? 7,
    timezone: r.company_timezone?.trim() || 'America/Chicago',
    companyName: r.company_name,
  };
}
