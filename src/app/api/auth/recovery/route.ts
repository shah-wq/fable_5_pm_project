import { NextResponse } from 'next/server';
import { withAnon } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { siteOrigin } from '@/lib/site';

/**
 * Password recovery, step 1. Always answers 200 — no account oracle. Tokens are
 * issued for any active account, homeowners included (002600); an inactive or
 * unknown address simply produces no token and the same reply.
 */
const DOORS = ['staff', 'dealer', 'customer'];

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    email?: string;
    door?: string;
  } | null;
  const email = body?.email?.trim();
  if (!email) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 });
  }
  // §7: "the reset link returns the user to the sign-in page they started from".
  // Allowlisted, because it ends up in a URL: only these three values pass, so
  // nothing a caller invents can be reflected back into the link.
  const door = body?.door && DOORS.includes(body.door) ? body.door : null;

  const { rows } = await withAnon((c) =>
    c.query<{ recovery_token: string }>('select * from auth.request_recovery($1)', [email])
  );

  if (rows[0]?.recovery_token) {
    const link =
      `${siteOrigin(new URL(request.url).origin)}/auth/update-password` +
      `?token=${rows[0].recovery_token}${door ? `&from=${door}` : ''}`;
    try {
      await sendEmail({
        to: email,
        subject: 'Reset your SolarFlow password',
        text: `Follow this link to set a new password:\n\n${link}\n\nThe link expires in 1 hour and works once. If you didn't request this, you can ignore this email.`,
      });
    } catch (error) {
      console.error('recovery email failed:', error);
      const unconfigured = error instanceof Error && error.message.includes('SMTP is not configured');
      return NextResponse.json(
        {
          error: unconfigured
            ? 'Email is not set up on this server yet. Ask your administrator to change your password from the Admin panel (Users & roles).'
            : 'We could not send the email. Try again shortly.',
        },
        { status: unconfigured ? 503 : 502 }
      );
    }
  }

  return NextResponse.json({ ok: true });
}
