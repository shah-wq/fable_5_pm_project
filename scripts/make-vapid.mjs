#!/usr/bin/env node
/**
 * Generates the VAPID key pair web push needs, and prints the two environment
 * variables to set.
 *
 *   node scripts/make-vapid.mjs
 *
 * Run it once. Generating a new pair invalidates every device already
 * subscribed — they silently stop receiving notifications until they
 * re-subscribe — so keep the pair somewhere safe rather than regenerating it.
 *
 * The public key is served to browsers by /api/push/key. The private key stays
 * on the server and must never be committed.
 */

import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`
Set these on Vercel (Project → Settings → Environment Variables), then redeploy:

  VAPID_PUBLIC_KEY=${publicKey}
  VAPID_PRIVATE_KEY=${privateKey}
  VAPID_SUBJECT=mailto:support@integratesun.com

Keep VAPID_PRIVATE_KEY secret and do not commit it. Changing this pair later
silently unsubscribes every device that has already opted in.
`);
