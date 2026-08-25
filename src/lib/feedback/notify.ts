import type { PoolClient } from 'pg';
import { optionalRows } from '../db-optional';
import { sendEmail } from '../email';
import { siteUrl } from '../site';
import { STAGE_LABELS, isStageKey, type StageKey } from '../stages/definitions';

/**
 * The email fallback (Stage feedback §2).
 *
 * "If nothing has been answered in the portal or app after 24 hours, one email
 * with the five faces as clickable links — clicking a face records the score
 * immediately and opens the portal for the optional comment. This is where most
 * responses will actually come from."
 *
 * That last sentence is the reason this exists at all, and the reason the link
 * carries a token instead of asking for a password: §9 — "requiring a login
 * first will cost you most of your responses."
 *
 * One email, ever. The claim function in the database hands out each request
 * exactly once and closes the ones that have had both attempts, so two overlapping
 * cron runs cannot email the same person twice and nobody is asked a third time.
 */

// The email is plain text, so only the labels and numbers travel — the faces are
// here so the scale is defined in one shape across the sheet and the email.
const FACES: Array<{ score: number; label: string }> = [
  { score: 1, label: 'Not good' },
  { score: 2, label: 'Poor' },
  { score: 3, label: 'Fine' },
  { score: 4, label: 'Good' },
  { score: 5, label: 'Great' },
];

interface Claimed {
  f_id: string;
  f_project: string;
  f_stage: string;
  f_token: string;
}

export async function sendFeedbackEmails(client: PoolClient): Promise<{ sent: number }> {
  const due = await optionalRows<Claimed>(
    client,
    'the feedback email queue (public.claim_feedback_emails)',
    `select f_id, f_project, f_stage, f_token from public.claim_feedback_emails(50)`
  );
  if (due.length === 0) return { sent: 0 };

  let sent = 0;
  for (const row of due) {
    const stage: StageKey = isStageKey(row.f_stage) ? row.f_stage : 'survey';
    // The recipient and who to name, one query per request: this runs a few
    // times a day, and a join would still need the same policy checks.
    const who = await optionalRows<{
      email: string | null;
      first_name: string | null;
      pm_name: string | null;
      project_name: string;
    }>(
      client,
      'the recipient of a feedback email',
      `select cl.email, cl.first_name,
              coalesce(pr.full_name, pr.email) as pm_name,
              p.name as project_name
         from public.projects p
         join public.clients cl on cl.id = p.client_id
         left join public.profiles pr on pr.id = p.assigned_pm
        where p.id = $1
          and cl.email is not null
          and not coalesce(cl.email_opt_out, false)`,
      [row.f_project]
    );
    const to = who[0]?.email;
    if (!to) continue;

    const label = STAGE_LABELS[stage].toLowerCase();
    const link = (score: number) =>
      `${siteUrl()}/r/${row.f_token}?s=${score}`;

    // Plain text, because that is what this platform sends and because a
    // five-link row survives every mail client. Each link is one tap and the
    // score is recorded before the page even renders.
    const faces = FACES.map((f) => `${f.score} — ${f.label}: ${link(f.score)}`).join('\n');

    await sendEmail({
      to,
      subject: `How was your ${label}?`,
      text:
        `${who[0]?.first_name ? `Hi ${who[0].first_name},` : 'Hello,'}\n\n` +
        `Your ${label} is done. How did it go? One tap is all we need — ` +
        `pick the number that fits:\n\n` +
        `${faces}\n\n` +
        `${
          who[0]?.pm_name
            ? `${who[0].pm_name} reads every one of these.`
            : 'Your project manager reads every one of these.'
        }\n` +
        `If you would rather not be asked again, you can turn these off in the ` +
        `app under More → Notifications.\n`,
    })
      .then(() => {
        sent += 1;
      })
      .catch(() => undefined);
  }
  return { sent };
}

/**
 * Tell the PM a low score arrived, immediately (§5).
 *
 * Called from the answer path rather than the cron, because "immediately" is the
 * point: a customer who says it went badly and hears nothing for a day has been
 * told that the rating was decoration.
 */
export async function notifyLowScore(
  client: PoolClient,
  projectId: string,
  stage: StageKey,
  score: number,
  comment: string | null
): Promise<void> {
  // Through project_contact(), not a join to profiles. This runs in the
  // customer's own transaction — they are the one who just tapped a face — and
  // public.profiles is self-or-staff under RLS, so a join returns nobody and the
  // email silently never sends. The same trap the chat module hit when it needed
  // the PM's name on the customer's screen.
  const rows = await optionalRows<{
    pm_name: string | null;
    pm_email: string | null;
    project_name: string;
    project_code: string;
  }>(
    client,
    'the PM to tell about a low score',
    `select c.pm_name, c.pm_email, p.name as project_name, p.code as project_code
       from public.projects p
       cross join lateral public.project_contact(p.id) c
      where p.id = $1`,
    [projectId]
  );
  const pm = rows[0]
    ? {
        email: rows[0].pm_email,
        full_name: rows[0].pm_name,
        project_name: rows[0].project_name,
        project_code: rows[0].project_code,
      }
    : null;
  if (!pm?.email) return;

  await sendEmail({
    to: pm.email,
    subject: `${score} of 5 on ${STAGE_LABELS[stage]} — ${pm.project_name}`,
    text:
      `${pm.full_name ? `${pm.full_name},` : 'Hello,'}\n\n` +
      `${pm.project_name} (${pm.project_code}) rated ${STAGE_LABELS[stage]} ${score} out of 5.\n\n` +
      (comment ? `They wrote:\n\n${comment}\n\n` : '') +
      `A follow-up task is open on the project. It stays flagged until you close ` +
      `it with a note saying what you did.\n\n` +
      `${siteUrl()}/tasks\n`,
  }).catch(() => undefined);
}

/**
 * The daily digest to admins (§5): every low score of the last day, and what is
 * still open. One email a day rather than one per rating — an admin needs the
 * pattern, and the PM has already been told about the individual case.
 */
export async function sendFeedbackDigest(client: PoolClient): Promise<{ sent: number }> {
  const lines = await optionalRows<{
    project_name: string;
    project_code: string;
    stage: string;
    score: number;
    pm_name: string | null;
    comment: string | null;
    resolved: boolean;
  }>(
    client,
    'the low-score digest',
    `select p.name as project_name, p.code as project_code, f.stage::text as stage,
            f.score, coalesce(pr.full_name, pr.email) as pm_name, f.comment,
            t.resolved_at is not null as resolved
       from public.stage_feedback f
       join public.projects p on p.id = f.project_id
       left join public.profiles pr on pr.id = f.attributed_pm
       left join public.project_tasks t on t.id = f.task_id
      where f.score <= 2 and f.responded_at > now() - interval '1 day'
      order by f.responded_at desc`
  );

  const open = await optionalRows<{ open_tasks: string; oldest_open_days: string | null }>(
    client,
    'the open follow-up count',
    `select open_tasks, oldest_open_days from public.feedback_task_stats`
  );

  if (lines.length === 0 && Number(open[0]?.open_tasks ?? 0) === 0) return { sent: 0 };

  const admins = await optionalRows<{ email: string }>(
    client,
    'the admins to send the digest to',
    `select email from public.profiles
      where role = 'admin' and is_active and deleted_at is null and email is not null`
  );

  const body =
    (lines.length
      ? `Low ratings in the last day:\n\n` +
        lines
          .map(
            (l) =>
              `· ${l.project_name} (${l.project_code}) — ${l.score}/5 on ` +
              `${STAGE_LABELS[isStageKey(l.stage) ? l.stage : 'survey']}` +
              `${l.pm_name ? `, PM ${l.pm_name}` : ''}` +
              `${l.resolved ? ' — followed up' : ' — still open'}` +
              `${l.comment ? `\n  “${l.comment.replace(/\s+/g, ' ').slice(0, 200)}”` : ''}`
          )
          .join('\n')
      : 'No low ratings in the last day.') +
    `\n\n${open[0]?.open_tasks ?? 0} follow-up task(s) still open` +
    (open[0]?.oldest_open_days
      ? `, the oldest ${Math.floor(Number(open[0].oldest_open_days))} days old`
      : '') +
    `.\n\n${siteUrl()}/tasks\n`;

  let sent = 0;
  for (const admin of admins) {
    await sendEmail({
      to: admin.email,
      subject: lines.length
        ? `${lines.length} low rating(s) yesterday`
        : 'Follow-up tasks still open',
      text: body,
    })
      .then(() => {
        sent += 1;
      })
      .catch(() => undefined);
  }
  return { sent };
}
