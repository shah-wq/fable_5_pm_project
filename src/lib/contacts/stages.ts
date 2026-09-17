import type { PoolClient } from 'pg';
import { optionalRows } from '@/lib/db-optional';
import { loadDealCards, type DealCard } from '@/lib/deals/service';

/**
 * Contact stages: the contact list, as a board.
 *
 * The same people as the Contacts table, in a column for where each one has
 * got to. It reads the deal's stage rather than keeping a stage of its own —
 * "Lead status" on the contact record is that same value, and a second stage
 * stored on the person would drift from the board within a week and then
 * nobody would know which one was true.
 *
 * One card per person, not per deal. A contact with two live deals is one human
 * being, and seeing their name in two columns is how a rep loses ten minutes
 * working out whether they are looking at a duplicate.
 */

import {
  NO_DEAL,
  type ContactStageCard,
  type StageColumn,
} from '@/lib/contacts/stage-columns';

export * from '@/lib/contacts/stage-columns';

function fromDeal(d: DealCard): ContactStageCard {
  return {
    clientId: d.clientId,
    dealId: d.id,
    column: d.column,
    personName: d.personName,
    subtitle: d.address ?? d.dealerName ?? d.code,
    daysInStage: d.daysInStage,
    ownerName: d.ownerName,
    dealerName: d.dealerName,
    nextAction: d.nextAction,
    nextActionDue: d.nextActionDue,
    lostReason: d.lostReason,
    missing: d.missing,
    email: null,
    phone: null,
    lastContact: null,
  };
}

/**
 * Which of a person's deals the board shows: the one a rep means.
 *
 * An open deal beats a closed one, and among equals the one that moved most
 * recently wins — the same rule the contact record uses to decide which deal its
 * status field is talking about, so the two screens always agree.
 */
function newestPerPerson(cards: DealCard[]): DealCard[] {
  const best = new Map<string, DealCard>();
  const unlinked: DealCard[] = [];
  for (const card of cards) {
    if (!card.clientId) {
      unlinked.push(card);
      continue;
    }
    const held = best.get(card.clientId);
    if (!held) {
      best.set(card.clientId, card);
      continue;
    }
    const open = (c: DealCard) => (c.column === 'won' || c.column === 'lost' ? 0 : 1);
    if (
      open(card) > open(held) ||
      (open(card) === open(held) && card.updatedAt > held.updatedAt)
    ) {
      best.set(card.clientId, card);
    }
  }
  return [...best.values(), ...unlinked];
}

interface BareContact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  dealer_name: string | null;
  owner_name: string | null;
  last_contacted_at: string | null;
}

export async function loadContactStageBoard(client: PoolClient): Promise<ContactStageCard[]> {
  const deals = newestPerPerson(await loadDealCards(client)).map(fromDeal);

  // Everyone else on file. They are the point of the intake column: a contact
  // nobody has opened a deal for is exactly the one that goes quiet, and a board
  // that only showed deals would never show them at all.
  const bare = await optionalRows<BareContact>(
    client,
    'the contacts with no deal (public.clients)',
    `select c.id, c.first_name, c.last_name, c.email, c.phone,
            dl.name as dealer_name,
            coalesce(p.full_name, p.email) as owner_name,
            c.last_contacted_at::text
       from public.clients c
       left join public.dealers dl on dl.id = c.dealer_id
       left join public.profiles p on p.id = c.owner_id
      where not coalesce(c.is_archived, false)
        and not exists (select 1 from public.deals d where d.client_id = c.id)
      order by c.created_at desc
      limit 500`
  );

  return [
    ...bare.map((c) => ({
      clientId: c.id,
      dealId: null,
      column: NO_DEAL as StageColumn,
      personName: [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unnamed contact',
      subtitle: c.dealer_name,
      daysInStage: null,
      ownerName: c.owner_name,
      dealerName: c.dealer_name,
      nextAction: null,
      nextActionDue: false,
      lostReason: null,
      missing: [],
      email: c.email,
      phone: c.phone,
      lastContact: c.last_contacted_at ? c.last_contacted_at.slice(0, 10) : null,
    })),
    ...deals,
  ];
}
