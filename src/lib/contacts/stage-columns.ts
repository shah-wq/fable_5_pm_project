/**
 * The columns of the contact board, and the shape of one card.
 *
 * These are the stages the business works, which are about reaching a person
 * and getting in front of them rather than about money. They are the contact's
 * own — stored on the person, not derived from a deal — because three of them
 * are not forward steps: a no-show goes back to rescheduled, and a lost contact
 * comes back to life when they ring in September.
 *
 * Kept apart from the loader beside it because this file is read by the board
 * itself, which runs in the browser: importing the loader there would drag the
 * database driver into the client bundle, and the build says so in about forty
 * lines of webpack.
 */

export const CONTACT_STAGES = [
  'created',
  'appointment_scheduled',
  'appointment_rescheduled',
  'no_show',
  'quoted',
  'financing_approved',
  'contract_signed',
  'lost',
] as const;

export type ContactStage = (typeof CONTACT_STAGES)[number];

export const STAGE_COLUMNS: ContactStage[] = [...CONTACT_STAGES];

export const STAGE_COLUMN_LABELS: Record<ContactStage, string> = {
  created: 'Contact created',
  appointment_scheduled: 'Appointment scheduled',
  appointment_rescheduled: 'Appointment rescheduled',
  no_show: 'No-show',
  quoted: 'Quoted',
  financing_approved: 'Financing approved',
  contract_signed: 'Contract signed',
  lost: 'Lost',
};

/** What each column means, under its heading — the same idea as the deal board. */
export const STAGE_COLUMN_MEANS: Record<ContactStage, string> = {
  created: 'On file, not booked in',
  appointment_scheduled: 'A date in the diary',
  appointment_rescheduled: 'Moved at least once',
  no_show: 'Nobody there',
  quoted: 'A number is with them',
  financing_approved: 'The money is in place',
  contract_signed: 'Signed',
  lost: 'Closed, and reversible',
};

/** True for a value that came from outside and might be anything. */
export function isContactStage(value: unknown): value is ContactStage {
  return typeof value === 'string' && (CONTACT_STAGES as readonly string[]).includes(value);
}

export interface ContactStageCard {
  clientId: string;
  stage: ContactStage;
  personName: string;
  email: string | null;
  phone: string | null;
  subtitle: string | null;
  ownerName: string | null;
  dealerName: string | null;
  /** Days in the current stage — a contact stuck in Scheduled is the point. */
  daysInStage: number;
  lastContact: string | null;
  /** The deal behind them, when there is one, for the link on the card. */
  dealId: string | null;
  /**
   * The project their signing created, while it exists. It holds the card in
   * Contract signed: the board will not let it be dragged out until the
   * project is deleted.
   */
  projectId: string | null;
  projectCode: string | null;
  /** A contract has been sent for e-signature and not yet signed. */
  awaitingSignature?: boolean;
}
