import type { StageKey } from '../stages/definitions';

/**
 * Module 17 · the deal pipeline (Part 5).
 *
 * "Stages six, plus two terminal outcomes, same mechanics as the project
 * board." The shape here deliberately mirrors lib/stages/definitions.ts, because
 * the board components and the move service read both and should not be able to
 * tell which one they are holding.
 */

export const DEAL_STAGES = [
  'new',
  'contacted',
  'qualified',
  'proposal',
  'negotiation',
  'contract_out',
] as const;

export type DealStage = (typeof DEAL_STAGES)[number];
export type DealColumn = DealStage | 'won' | 'lost';

/** Every column on the board, with Won and Lost separated at the end. */
export const DEAL_COLUMNS: DealColumn[] = [...DEAL_STAGES, 'won', 'lost'];

export const DEAL_STAGE_LABELS: Record<DealColumn, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  contract_out: 'Contract out',
  won: 'Won',
  lost: 'Lost',
};

/** What each stage means, shown as the column's subtitle (Part 5). */
export const DEAL_STAGE_MEANS: Record<DealColumn, string> = {
  new: 'Arrived, untouched',
  contacted: 'Two-way contact made',
  qualified: 'Worth spending money on',
  proposal: 'A number is out',
  negotiation: 'Engaging with the number',
  contract_out: 'Signature pending',
  won: 'Signed',
  lost: 'Closed, reversible',
};

/**
 * The default probability per stage (Part 11).
 *
 * "Probability defaults from the stage, and manual overrides are shown as
 * overrides in the forecast." Deliberately not a model: "Residential volumes do
 * not support a model worth trusting, and a number presented as a prediction
 * gets treated as one."
 */
export const STAGE_PROBABILITY: Record<DealColumn, number> = {
  new: 5,
  contacted: 10,
  qualified: 25,
  proposal: 40,
  negotiation: 60,
  contract_out: 80,
  won: 100,
  lost: 0,
};

export function isDealStage(value: string): value is DealStage {
  return (DEAL_STAGES as readonly string[]).includes(value);
}

export function isDealColumn(value: string): value is DealColumn {
  return (DEAL_COLUMNS as readonly string[]).includes(value);
}

export function dealStageIndex(stage: string): number {
  return (DEAL_COLUMNS as string[]).indexOf(stage);
}

/** The stage a forward move lands on, or null at the end of the open stages. */
export function nextDealStage(stage: DealStage): DealStage | 'won' | null {
  const i = DEAL_STAGES.indexOf(stage);
  if (i < 0) return null;
  return i === DEAL_STAGES.length - 1 ? 'won' : DEAL_STAGES[i + 1];
}

/** The project stage a won deal creates. Every project starts at the start. */
export const PROJECT_START_STAGE: StageKey = 'survey';
