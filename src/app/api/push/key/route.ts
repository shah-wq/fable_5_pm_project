import { NextResponse } from 'next/server';

/**
 * The VAPID public key the browser needs to subscribe. Public by design — it
 * identifies this server to the push services and is useless without the
 * private half, which never leaves the server.
 */
export async function GET() {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? null;
  return NextResponse.json(
    { publicKey },
    { headers: { 'cache-control': 'private, max-age=3600' } }
  );
}
