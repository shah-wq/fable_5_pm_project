import { DEAL_STAGES, type DealColumn, type DealStage } from './definitions';

/**
 * Module 17 · the advance gates (Part 5's "required to leave it" column).
 *
 * Pure functions over a loaded row, exactly like lib/stages/requirements.ts —
 * one validation path for the button, the drag and the API, so an invalid move
 * is refused identically however it was attempted.
 *
 * Two differences from the project board, both from Part 5:
 *  · "forward skips are allowed where the skipped stages' requirements are
 *    satisfied, because a referral can arrive already qualified";
 *  · Lost is "reachable from any stage at any time with no other field
 *    requirements — the same treatment Hold and Cancelled get on the project
 *    board, and for the same reason".
 */

export interface DealRow {
  id: string;
  stage: string;
  client_id: string | null;
  customer_first: string | null;
  customer_last: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  property_address_id: string | null;
  address: string | null;
  source_id: string | null;
  /** Any logged interaction with an outcome — an audit_log row of a contact kind. */
  contact_logged: boolean;
  next_action: string | null;
  next_action_at: string | null;
  homeowner_confirmed: boolean;
  roof_type_id: string | null;
  avg_monthly_bill: number | null;
  utility_id: string | null;
  credit_band: string | null;
  decision_maker_identified: boolean;
  system_size_kw: number | null;
  module_id: string | null;
  net_price: number | null;
  financing_route: string | null;
  /** A proposal row that has been sent, not merely drafted. */
  proposal_sent: boolean;
  expected_close_date: string | null;
  contract_value: number | null;
  /** A signed contract on file: a document of the right kind against the deal. */
  contract_on_file: boolean;
}

const has = (v: unknown): boolean =>
  v !== null && v !== undefined && v !== '' && v !== false;

/** Gaps that stop a deal *leaving* the named stage. */
export function gapsLeaving(stage: DealStage, deal: DealRow): string[] {
  const gaps: string[] = [];
  switch (stage) {
    case 'new':
      // "Primary person with a reachable channel, property address, source."
      if (!has(deal.client_id) && !has(deal.customer_first)) gaps.push('No person on the deal');
      if (!has(deal.customer_email) && !has(deal.customer_phone) && !has(deal.client_id)) {
        gaps.push('No reachable email or phone');
      }
      if (!has(deal.property_address_id) && !has(deal.address)) gaps.push('No property address');
      if (!has(deal.source_id)) gaps.push('No source recorded');
      // The contact belongs here rather than on Contacted, because Contacted
      // *means* "two-way contact made" and the spec settles the ambiguity in
      // words: "A voicemail is an attempt, logged as an activity; the deal stays
      // in New." A gate on leaving Contacted would let the voicemail through.
      if (!deal.contact_logged) gaps.push('No two-way contact logged');
      break;
    case 'contacted':
      // "…plus a next action with a date." Required on every open deal anyway,
      // so this is the stage that first insists on it.
      if (!has(deal.next_action)) gaps.push('No next action');
      if (!has(deal.next_action_at)) gaps.push('Next action has no date');
      break;
    case 'qualified':
      if (!deal.homeowner_confirmed) gaps.push('Homeowner not confirmed');
      if (!has(deal.roof_type_id)) gaps.push('Roof type not captured');
      if (!has(deal.utility_id)) gaps.push('Utility not captured');
      if (!has(deal.avg_monthly_bill)) gaps.push('Monthly bill not captured');
      if (!has(deal.credit_band)) gaps.push('Financing appetite unknown');
      if (!deal.decision_maker_identified) gaps.push('Decision makers not identified');
      break;
    case 'proposal':
      if (!has(deal.system_size_kw)) gaps.push('System size missing');
      if (!has(deal.module_id)) gaps.push('Equipment not chosen');
      if (!has(deal.net_price)) gaps.push('Price missing');
      if (!has(deal.financing_route)) gaps.push('Financing option missing');
      if (!deal.proposal_sent) gaps.push('Proposal not sent');
      break;
    case 'negotiation':
      // Skippable (Part 5) — the only requirement is a date somebody believes.
      if (!has(deal.expected_close_date)) gaps.push('No expected close date');
      break;
    case 'contract_out':
      // "No Won on a verbal, because the project it creates would start with no
      // contract."
      if (!deal.contract_on_file) gaps.push('No signed contract on file');
      if (!has(deal.contract_value)) gaps.push('Contract value missing');
      break;
  }
  return gaps;
}

/**
 * Everything standing between a deal and the target column.
 *
 * A forward skip has to satisfy every stage it jumps, which is what makes the
 * skip safe to allow: a referral that arrives qualified has, by definition,
 * already met New and Contacted.
 */
export function gapsForMove(deal: DealRow, target: DealColumn): string[] {
  if (target === 'lost') return [];
  const from = DEAL_STAGES.indexOf(deal.stage as DealStage);
  if (from < 0) return [];
  const to = target === 'won' ? DEAL_STAGES.length : DEAL_STAGES.indexOf(target as DealStage);
  const gaps: string[] = [];
  for (let i = from; i < to; i++) {
    for (const gap of gapsLeaving(DEAL_STAGES[i], deal)) {
      if (!gaps.includes(gap)) gaps.push(gap);
    }
  }
  return gaps;
}

/** What the card's missing-items badge counts: the next step, not every step. */
export function missingForNextStep(deal: DealRow): string[] {
  const stage = deal.stage;
  if (stage === 'won' || stage === 'lost') return [];
  return gapsLeaving(stage as DealStage, deal);
}

/**
 * The minimum to create a project (Part 9), checked before a deal may be Won —
 * "first and last name, site address, dealer — plus a signed contract on file
 * and the contract total. Everything else is fillable later, deliberately, so a
 * Friday-evening signature is never blocked by a missing module selection."
 */
export function gapsForConversion(deal: DealRow & { dealer_id?: string | null }): string[] {
  const gaps: string[] = [];
  if (!has(deal.client_id) && !(has(deal.customer_first) && has(deal.customer_last))) {
    gaps.push('No person to create the project for');
  }
  if (!has(deal.property_address_id) && !has(deal.address)) gaps.push('No site address');
  if (!has(deal.contract_on_file)) gaps.push('No signed contract on file');
  if (!has(deal.contract_value)) gaps.push('Contract value missing');
  return gaps;
}
