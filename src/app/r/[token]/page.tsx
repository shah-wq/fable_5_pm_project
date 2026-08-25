import { withAnon } from '@/lib/db';
import { optionalRows } from '@/lib/db-optional';
import { STAGE_LABELS, isStageKey } from '@/lib/stages/definitions';
import { InlineLogo } from '@/app/(auth)/_components/AuthUi';
import { TokenComment } from './TokenComment';

export const dynamic = 'force-dynamic';

/**
 * Where a face in the rating email lands (Stage feedback §2, §9).
 *
 * The score is recorded here, server-side, before anything renders — one tap
 * from the inbox and the number is saved. No session, no password: "requiring a
 * login first will cost you most of your responses", and the token grants
 * exactly one capability, on one rating.
 *
 * What renders is the thank-you, and — for a low score — the same reason chips
 * and comment box the in-app sheet shows. Somebody who has taken the trouble to
 * click is the person most likely to tell you why.
 *
 * One known cost of one-click, accepted deliberately: this writes on a GET, so a
 * mail scanner that follows links could record a score nobody chose. §2 asks for
 * one tap and §9 says a login would cost most of the responses, so the trade is
 * the right way round — and the token stays usable while the request is open, so
 * a real click after a scanner's replaces it rather than being refused.
 */
export default async function RatingLandingPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ s?: string }>;
}) {
  const { token } = await params;
  const { s } = await searchParams;
  const score = Number(s);

  const result =
    Number.isInteger(score) && score >= 1 && score <= 5
      ? await withAnon(async (client) => {
          const rows = await optionalRows<{ project_id: string; stage: string; score: number }>(
            client,
            'recording a rating from an emailed link',
            `select project_id, stage::text as stage, score
               from public.record_feedback_by_token($1, $2)`,
            [token, score]
          );
          const row = rows[0];
          if (!row) return null;
          const chips = await optionalRows<{ key: string; label: string }>(
            client,
            'the feedback reason chips',
            `select key, label from public.feedback_reasons
              where is_active
                and (cardinality(stages) = 0 or $1::public.project_stage = any(stages))
              order by sort_order, label`,
            [row.stage]
          );
          return { row, chips };
        }).catch(() => null)
      : null;

  if (!result) {
    return (
      <main className="rate-page">
        <InlineLogo />
        <h1>This rating link has expired</h1>
        <p className="dim">
          Links from a rating email work for 60 days, and only while we are still asking. You can
          always tell your project manager directly — everything you send in the app goes straight
          to them.
        </p>
      </main>
    );
  }

  const stage = isStageKey(result.row.stage) ? result.row.stage : 'survey';
  const low = Number(result.row.score) <= 2;

  return (
    <main className="rate-page">
      <InlineLogo />
      {/* §9: a specific thank-you. 'Thanks for your feedback' is what every dead
          survey says. */}
      <h1>{low ? 'Thanks for telling us' : 'Thanks — that helps us'}</h1>
      <p className="dim">
        {`You rated ${STAGE_LABELS[stage].toLowerCase()} ${result.row.score} out of 5. `}
        {low
          ? 'Your project manager has already been told and will be in touch.'
          : 'It goes straight to the team working on your project.'}
      </p>

      {/*
        Offered whatever the score, not only for a low one (§3: "optionally offer
        a comment box, but never require one"). Somebody who clicked a 5 from
        their inbox is already engaged, and what they write about a good stage is
        as useful as a complaint. The chips only make sense on a low score —
        there is nothing to diagnose about a 5 — so they travel with it.
      */}
      <TokenComment token={token} chips={low ? result.chips : []} low={low} />

      <p className="rate-foot">
        <a href="/portal">Open your project</a>
      </p>
    </main>
  );
}
