import { DEAL_COLUMNS, type DealColumn } from '@/lib/deals/definitions';

/**
 * The columns of the contact board, and the shape of one card.
 *
 * Kept apart from the loader beside it because this file is read by the board
 * itself, which runs in the browser: importing the loader there would drag the
 * database driver into the client bundle, and the build says so in about forty
 * lines of webpack.
 */

/** The intake column: people on file who are not being worked yet. */
export const NO_DEAL = 'none' as const;

export type StageColumn = DealColumn | typeof NO_DEAL;

export const STAGE_COLUMNS: StageColumn[] = [NO_DEAL, ...DEAL_COLUMNS];

export const STAGE_COLUMN_LABELS: Record<StageColumn, string> = {
  none: 'Not being worked',
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  contract_out: 'Contract out',
  won: 'Won',
  lost: 'Lost',
};

export const STAGE_COLUMN_MEANS: Record<StageColumn, string> = {
  none: 'On file, no deal open',
  new: 'Arrived, untouched',
  contacted: 'Two-way contact made',
  qualified: 'Worth spending money on',
  proposal: 'A number is out',
  negotiation: 'Engaging with the number',
  contract_out: 'Signature pending',
  won: 'Signed',
  lost: 'Closed, reversible',
};

export interface ContactStageCard {
  /** The person. Null only for an unlinked dealer submission. */
  clientId: string | null;
  /** The deal the card sits on, absent in the intake column. */
  dealId: string | null;
  column: StageColumn;
  personName: string;
  subtitle: string | null;
  daysInStage: number | null;
  ownerName: string | null;
  dealerName: string | null;
  nextAction: string | null;
  nextActionDue: boolean;
  lostReason: string | null;
  missing: string[];
  /** Contact details, so a rep can act without opening the record. */
  email: string | null;
  phone: string | null;
  lastContact: string | null;
}

