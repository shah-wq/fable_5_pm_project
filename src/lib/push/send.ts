import webpush from 'web-push';
import type { PoolClient } from 'pg';

/**
 * Sending push notifications to a customer's devices.
 *
 * Three rules from the spec, all enforced here rather than left to callers:
 *
 *  * Restraint (§4). Under ten pushes across an entire project. Every send is
 *    claimed against a dedupe key first, so 'moved to permits' is one
 *    notification even if the PM moves the project back and forth correcting a
 *    mistake, and the log makes the real frequency auditable.
 *  * Deep links (§4, §10). Every notification carries the URL of the exact
 *    screen it is about. A push that opens a generic home tab is worse than no
 *    push at all, so `url` is required, not optional.
 *  * Never break the caller. A stage move must succeed whether or not a push
 *    service is reachable, so everything here resolves rather than throws.
 */

export type PushCategory =
  | 'stage_advanced'
  | 'appointment'
  | 'action_needed'
  | 'on_hold'
  | 'power_on';

export interface PushMessage {
  projectId: string;
  category: PushCategory;
  /** Unique per project per person; null means 'may be sent more than once'. */
  dedupeKey: string | null;
  title: string;
  body: string;
  /** In-app path, e.g. /portal/project#permits. */
  url: string;
}

let configured: boolean | null = null;

/** VAPID identifies the sending server to the push services. */
function ready(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? 'mailto:support@integratesun.com',
    publicKey,
    privateKey
  );
  configured = true;
  return true;
}

export function pushConfigured(): boolean {
  return ready();
}

interface Target {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Send one notification about one project. Must be called inside withUser()
 * with a staff session — the target lookup and the delivery log are staff-only
 * definer functions, because a customer must not be able to enumerate devices
 * or write their own delivery history.
 *
 * Returns what happened, for the caller to log if it cares. It never throws.
 */
export async function notifyProject(
  client: PoolClient,
  message: PushMessage
): Promise<{ sent: number; skipped: 'not_configured' | 'already_sent' | null; failed: number }> {
  if (!ready()) return { sent: 0, skipped: 'not_configured', failed: 0 };

  let targets: Target[] = [];
  try {
    const { rows } = await client.query<Target>(
      `select user_id, endpoint, p256dh, auth
       from public.push_targets_for_project($1, $2)`,
      [message.projectId, message.category]
    );
    targets = rows;
  } catch {
    return { sent: 0, skipped: null, failed: 0 };
  }
  if (targets.length === 0) return { sent: 0, skipped: null, failed: 0 };

  // Group by person: the dedupe key is per person, not per device, so someone
  // with a phone and a tablet gets one notification on each — not two each.
  const byUser = new Map<string, Target[]>();
  for (const t of targets) {
    const list = byUser.get(t.user_id) ?? [];
    list.push(t);
    byUser.set(t.user_id, list);
  }

  let sent = 0;
  let failed = 0;
  let anyClaimed = false;

  for (const [userId, devices] of byUser) {
    let claimed: string | null = null;
    try {
      const { rows } = await client.query<{ claim_push_delivery: string | null }>(
        `select public.claim_push_delivery($1, $2, $3, $4, $5, $6, $7, $8) as claim_push_delivery`,
        [
          userId, message.projectId, message.category, message.dedupeKey,
          message.title, message.body, message.url, devices.length,
        ]
      );
      claimed = rows[0]?.claim_push_delivery ?? null;
    } catch {
      continue;
    }
    // Already sent for this project: leave them alone.
    if (message.dedupeKey && claimed === null) continue;
    anyClaimed = true;

    const payload = JSON.stringify({
      title: message.title,
      body: message.body,
      url: message.url,
      category: message.category,
      tag: `${message.category}:${message.projectId}`,
    });

    for (const device of devices) {
      try {
        await webpush.sendNotification(
          { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
          payload,
          { TTL: 60 * 60 * 24 }
        );
        sent += 1;
      } catch (error) {
        failed += 1;
        // 404/410 mean the subscription is gone for good — retire it rather
        // than retrying it on every future notification.
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await client
            .query(`select public.retire_push_endpoint($1)`, [device.endpoint])
            .catch(() => undefined);
        }
      }
    }
  }

  return {
    sent,
    skipped: !anyClaimed && message.dedupeKey ? 'already_sent' : null,
    failed,
  };
}
